/**
 * bmstor/poller.js — 베어메탈 스토리지 주기 수집(v2.340).
 *
 * 사용자가 정한 주기(설정 intervalMinutes)마다: ① 중앙 직접 서버(agent 없음)는 이 프로세스가
 * SSH 수집(동시성 제한 풀) ② 엣지 위임 서버(agent 지정)는 **중앙→엣지 직접(PUSH)** —
 * 등록된 '수집 서버(원격)' URL 로 /api/collector/bmstor-collect 를 호출해 엣지가 현지 SSH 수집
 * 후 결과를 동기 반환한다(iDRAC PUSH 스캔 idracScanPush.js 와 같은 경로/토큰). 폴링형(NAT 뒤
 * CENTRAL_URL 전용) 엣지는 아직 미지원 — 그 엣지 서버는 수집 결과에 사유가 표시된다.
 *
 * CLAUDE.md 규칙 준수: 30초 틱 + 진행 중이면 스킵(재진입 가드 — 수동 실행 API 와 가드 공유),
 * 실제 수집은 주기 경과 시에만. 최근 결과는 인메모리(latest)만 유지 — 매 주기 비밀 파일을
 * 다시 쓰지 않는다(재시작 시 첫 주기까지 '미수집'로 표시, 정직한 상태).
 */

import { listBmServersRaw, getBmSettings } from './registry.js';
import { collectMany } from './collect.js';
import { findCollectorForAgent } from '../central/idracScanPush.js';
import { resilientFetch } from '../util/resilientFetch.js';

const TICK_MS = 30_000;
const PUSH_TIMEOUT_MS = Number(process.env.BMSTOR_PUSH_TIMEOUT_MS) || 180_000;

const latest = new Map(); // serverId → { ok, mounts, missing?, error?, at, agent }
let running = false;      // 재진입 가드(주기 틱 + 수동 실행 공유)
let lastRunAt = 0;
let lastRunSummary = null;

export function getBmLatest() { return latest; }
export function bmPollerStatus() { return { running, lastRunAt, lastRunSummary, intervalMinutes: getBmSettings().intervalMinutes }; }

/** 엣지 1대에 위임 수집 PUSH — 실패 시 그 엣지 소속 서버 전부에 오류 사유를 채운다. */
async function collectViaEdge(agent, servers) {
  const col = findCollectorForAgent(agent);
  const fail = (reason) => servers.map((s) => ({ id: s.id, ok: false, mounts: [], error: reason }));
  if (!col || !col.url) return fail(`에이전트 '${agent}' 의 수집 서버(원격) URL 이 없어 위임 수집 불가 — 설정 › 수집 서버(원격)에 등록하세요.`);
  try {
    const r = await resilientFetch(`${String(col.url).replace(/\/+$/, '')}/api/collector/bmstor-collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Collector-Token': col.token || '' },
      body: JSON.stringify({ servers: servers.map((s) => ({ id: s.id, host: s.host, port: s.port, username: s.username, password: s.password, mounts: s.mounts })) }),
      timeoutMs: PUSH_TIMEOUT_MS, retries: 1,
    });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok || !Array.isArray(j.results)) return fail(`엣지 응답 오류(HTTP ${r.status})${j?.reason ? `: ${j.reason}` : ''}`);
    const byId = new Map(j.results.map((x) => [x.id, x]));
    return servers.map((s) => byId.get(s.id) || { id: s.id, ok: false, mounts: [], error: '엣지 응답에 결과 없음' });
  } catch (e) {
    return fail(`엣지 전송 실패: ${e.message}`);
  }
}

/** 전체 1회 수집. 진행 중이면 { skipped: true } — 폴러/수동 API 가 같은 가드를 쓴다. */
export async function bmCollectNow(trigger = 'manual') {
  if (running) return { ok: false, skipped: true, reason: '이미 수집이 진행 중입니다.' };
  running = true;
  const started = Date.now();
  try {
    const servers = listBmServersRaw().filter((s) => s.enabled !== false);
    const central = servers.filter((s) => !String(s.agent || '').trim());
    const byAgent = new Map();
    for (const s of servers) {
      const a = String(s.agent || '').trim();
      if (!a) continue;
      if (!byAgent.has(a)) byAgent.set(a, []);
      byAgent.get(a).push(s);
    }
    const [centralResults, ...edgeResults] = await Promise.all([
      collectMany(central),
      ...[...byAgent.entries()].map(([agent, list]) => collectViaEdge(agent, list)),
    ]);
    const at = Date.now();
    let ok = 0, errors = 0;
    for (const r of [...centralResults, ...edgeResults.flat()]) {
      const srv = servers.find((s) => s.id === r.id);
      latest.set(r.id, { ...r, at, agent: srv?.agent || '' });
      if (r.ok) ok++; else errors++;
    }
    // 삭제된 서버의 잔존 결과 정리(유령 표시 방지).
    const ids = new Set(servers.map((s) => s.id));
    for (const id of [...latest.keys()]) if (!ids.has(id)) latest.delete(id);
    lastRunAt = at;
    // 필드명 okCount — { ok:true, ...summary } 스프레드에서 성공 여부(boolean)를 덮지 않게.
    lastRunSummary = { at, trigger, servers: servers.length, okCount: ok, errors, ms: at - started };
    return { ok: true, ...lastRunSummary };
  } finally {
    running = false;
  }
}

/** 폴러 시작 — 30초 틱마다 '주기 경과' 확인 후에만 수집(설정 변경이 재기동 없이 반영). */
export function startBmstorPoller() {
  setInterval(() => {
    if (running) return; // 재진입 가드(CLAUDE.md — 이전 주기가 길어지면 이번 틱 스킵)
    const { intervalMinutes } = getBmSettings();
    if (Date.now() - lastRunAt < intervalMinutes * 60_000) return;
    if (!listBmServersRaw().some((s) => s.enabled !== false)) return; // 등록 0대면 조용히 대기
    bmCollectNow('interval').catch((e) => console.error('[bmstor] 수집 실패:', e.message));
  }, TICK_MS).unref?.();
}
