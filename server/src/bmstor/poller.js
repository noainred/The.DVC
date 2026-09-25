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
import { enqueueBmstorJob, setBmstorExpireHandler } from './jobs.js';
import { findCollectorForAgent } from '../central/idracScanPush.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { readJsonCapped, EDGE_RESPONSE_MAX_BYTES } from '../util/readCapped.js'; // v2.604: 엣지 응답 크기 상한
import { strOf } from '../util/coercionTrap.js';
import { withOutboundTag } from '../util/outboundStats.js'; // v2.601 WEB2601-02: 같은 주소 엣지를 기록에서 나눈다
import { createAuthGuard } from '../util/authGuard.js';
import { isSshAuthError } from '../proxy/sshExec.js';
import { numOrNull } from '../util/numOrNull.js';

/**
 * 베어메탈 스토리지 주기 수집의 **인증 실패 정지**(v2.590 — 감사 F2, server/CLAUDE.md v2.541 '아직 가드가 없는
 * 주기 SSH 수집기' 의 `bmstor/collect.js`). 예전에는 틀린 OS 계정으로 주기(기본 10분)마다 SSH 로그인했다.
 * 정지는 **중앙이 판단한다** — 엣지 위임 서버도 중앙이 잡을 걸거나 PUSH 하므로, 중앙이 대상에서 빼면 엣지도
 * 로그인하지 않는다(엣지 쪽 코드를 바꾸지 않고 막힌다). 수동 '지금 수집' 은 막지 않는다(authGuard 규칙 3).
 */
const authGuard = createAuthGuard({ file: 'bmstor-auth-stops.json' });
const stopView = (rec) => (rec ? { since: rec.since, at: rec.at, attempts: rec.attempts, reason: rec.reason } : null);
/** 결과가 SSH 자격증명 거부인가 — 직접 수집은 플래그, 엣지 회신은 ssh2 정식 문구(플래그가 빠져 온다). */
const isAuthResult = (r) => !!(r && r.ok === false && (r.authFailed === true || isSshAuthError({ message: r.error || '' })));

/** 결과 1건을 반영하며 정지 기록을 갱신한다(성공이면 해제, 자격증명 거부면 정지). */
function noteAuth(srv, r) {
  if (!srv) return r;
  if (r?.ok) { authGuard.clearAuthStop(srv.id); return r; }
  if (isAuthResult(r)) {
    const rec = authGuard.markAuthStopped(srv.id, srv, r.error || 'SSH 인증 실패');
    console.warn(`[bmstor] ${srv.name || srv.host}: 인증 실패로 주기 수집 정지(${rec.attempts}회) — 비밀번호를 고치면 자동 재개합니다`);
    return { ...r, authStopped: stopView(rec) };
  }
  return r;
}

const TICK_MS = 30_000;
const PUSH_TIMEOUT_MS = Number(process.env.BMSTOR_PUSH_TIMEOUT_MS) || 180_000;

const latest = new Map(); // serverId → { ok, mounts, missing?, error?, at, agent }
let running = false;      // 재진입 가드(주기 틱 + 수동 실행 공유)
let lastRunAt = 0;
let lastRunSummary = null;

export function getBmLatest() { return latest; }
export function bmPollerStatus() { return { running, lastRunAt, lastRunSummary, intervalMinutes: getBmSettings().intervalMinutes }; }

/**
 * 폴링 위임 결과 반영(v2.341) — 엣지가 POST /api/central/bmstor-result 로 회신한 결과를
 * latest 에 쓴다(라우트가 reqId 소유권 검증 후 호출). 비밀번호는 결과에 없음(용량 수치만).
 */
/*
 * ⚠ v2.600 CEN2600-08 — 엣지 회신의 mounts·missing 은 **아는 필드만·상한 안에서** 담는다(v2.598 CENTRAL 규약).
 * 예전에는 배열인지만 보고 통째로 latest 에 넣어 `usedPct:{x:1}` 같은 객체가 화면으로 가거나 3,000개 마운트가
 * 그대로 상주했다. 모양은 `collect.js parseDfOutput` 의 행({mount,totalBytes,usedBytes,availBytes,usedPct})이다.
 */
const MAX_MOUNTS = 64;
const mStr = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
export function sanitizeBmMounts(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const m of list) {
    if (out.length >= MAX_MOUNTS) break;
    if (!m || typeof m !== 'object') continue;
    const mount = mStr(m.mount, 512);
    if (!mount) continue;
    out.push({ mount, totalBytes: numOrNull(m.totalBytes), usedBytes: numOrNull(m.usedBytes), availBytes: numOrNull(m.availBytes), usedPct: numOrNull(m.usedPct) });
  }
  return out;
}
const sanitizeMissing = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x).slice(0, MAX_MOUNTS).map((x) => x.slice(0, 512)) : []);

export function applyBmstorResults(agent, results) {
  const at = Date.now();
  let applied = 0;
  let byId = null;
  for (const r of Array.isArray(results) ? results : []) {
    if (!r || !r.id) continue;
    const row = {
      ok: !!r.ok,
      mounts: sanitizeBmMounts(r.mounts),
      missing: sanitizeMissing(r.missing),
      error: typeof r.error === 'string' && r.error ? r.error.slice(0, 500) : r.error ? '(형식 오류)' : null,
      at, agent: String(agent || ''),
    };
    // v2.590: 엣지 회신의 자격증명 거부도 정지 기록에 반영한다(중앙이 다음 주기의 잡 대상에서 뺀다).
    if (!byId) { try { byId = new Map(listBmServersRaw().map((s) => [String(s.id), s])); } catch { byId = new Map(); } }
    latest.set(String(r.id), noteAuth(byId.get(String(r.id)), row));
    applied++;
  }
  return applied;
}

// 폴링 잡이 재시도 소진으로 만료되면 그 서버들에 실패 사유를 남긴다(무한 '수집 대기' 방지).
setBmstorExpireHandler((agent, serverIds, reason) => {
  const at = Date.now();
  for (const id of serverIds || []) latest.set(id, { ok: false, mounts: [], error: reason, at, agent });
});

/** 엣지 1대에 위임 수집 PUSH — 실패 시 그 엣지 소속 서버 전부에 오류 사유를 채운다. */
async function collectViaEdge(agent, servers) {
  const col = findCollectorForAgent(agent);
  const fail = (reason) => servers.map((s) => ({ id: s.id, ok: false, mounts: [], error: reason }));
  if (!col || !col.url) return fail(`에이전트 '${agent}' 의 수집 서버(원격) URL 이 없어 위임 수집 불가 — 설정 › 수집 서버(원격)에 등록하세요.`);
  try {
    const r = await withOutboundTag(col.id || col.name || agent, () => resilientFetch(`${String(col.url).replace(/\/+$/, '')}/api/collector/bmstor-collect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Collector-Token': col.token || '' },
      body: JSON.stringify({ servers: servers.map((s) => ({ id: s.id, host: s.host, port: s.port, username: s.username, password: s.password, mounts: s.mounts })) }),
      // v2.612 EDGE2612-01: 재시도 없음 — 시한(180초) 뒤 다시 보내면 엣지가 앞 수집을 끝내기 전에 같은 서버들에 SSH 세션을
      //   한 벌 더 열었다. 이번 주기는 실패로 남기고 다음 주기에 다시 수집한다.
      timeoutMs: PUSH_TIMEOUT_MS, retries: 0,
    }));
    if (r.status === 409) return fail('이미 수행 중 — 엣지에서 이전 위임 수집이 아직 진행 중이라 이번 요청은 실행하지 않았습니다(다음 주기에 다시 수집합니다).');
    // v2.604(감사 CEN2604-01 형제): 상한까지만 읽는다(해제 후 크기). 결과 원소는 객체만, 사유는 글자만.
    let j = null;
    try { j = await readJsonCapped(r, EDGE_RESPONSE_MAX_BYTES, '엣지 bmstor 응답'); } catch { j = null; }
    if (!r.ok || !j?.ok || !Array.isArray(j.results)) { const why = strOf(j?.reason, 300); return fail(`엣지 응답 오류(HTTP ${r.status})${why ? `: ${why}` : ''}`); }
    const byId = new Map(j.results.filter((x) => x && typeof x === 'object' && !Array.isArray(x)).map((x) => [x.id, x]));
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
    const enabled = listBmServersRaw().filter((s) => s.enabled !== false);
    // v2.590: **주기 수집만** 인증 실패 정지 서버를 뺀다(수동 '지금 수집' 은 막지 않는다). 빠진 서버는 결과에
    // 정지 사실을 남긴다 — 조용히 빼면 화면이 마지막 값을 지금 값처럼 보여준다.
    let authStopped = 0;
    const servers = trigger === 'manual' ? enabled : enabled.filter((s) => {
      const stop = authGuard.authStopFor(s);
      if (!stop) return true;
      authStopped++;
      const prev = latest.get(s.id);
      latest.set(s.id, { ...(prev || { mounts: [] }), ok: false, mounts: [], error: `인증 실패로 주기 수집 정지(${stop.attempts}회) — 비밀번호를 고치면 자동 재개합니다`, authStopped: stopView(stop), at: prev?.at || stop.at, agent: s.agent || '' });
      return false;
    });
    const central = servers.filter((s) => !String(s.agent || '').trim());
    const pushByAgent = new Map(); // 중앙→엣지 직접(PUSH) — 중앙이 엣지 URL 에 닿을 때
    const pollByAgent = new Map(); // 에이전트 폴링 — NAT 뒤 엣지(iDRAC/IP스캔과 동일, v2.341)
    for (const s of servers) {
      const a = String(s.agent || '').trim();
      if (!a) continue;
      const map = s.dispatch === 'push' ? pushByAgent : pollByAgent; // 기본 poll(엣지 표준 경로)
      if (!map.has(a)) map.set(a, []);
      map.get(a).push(s);
    }
    // 폴링 위임은 잡만 걸고 즉시 반환 — 결과는 엣지 회신(applyBmstorResults)이 채운다.
    let queued = 0;
    for (const [agent, list] of pollByAgent) {
      enqueueBmstorJob(agent, list.map((s) => ({ id: s.id, host: s.host, port: s.port, username: s.username, password: s.password, mounts: s.mounts })));
      queued += list.length;
    }
    const [centralResults, ...edgeResults] = await Promise.all([
      collectMany(central),
      ...[...pushByAgent.entries()].map(([agent, list]) => collectViaEdge(agent, list)),
    ]);
    const at = Date.now();
    let ok = 0, errors = 0;
    const srvById = new Map(servers.map((s) => [s.id, s])); // O(N²) 방지 — 1,000대 상한에서 find 는 백만 비교(v2.342)
    for (const r of [...centralResults, ...edgeResults.flat()]) {
      const srv = srvById.get(r.id);
      latest.set(r.id, noteAuth(srv, { ...r, at, agent: srv?.agent || '' }));
      if (r.ok) ok++; else errors++;
    }
    // 삭제된 서버의 잔존 결과 정리(유령 표시 방지).
    // v2.478(감사 B12): 정리 기준은 '등록된 전체'(비활성 포함) — 활성만 기준이면 서버를 비활성으로 바꾼 순간
    // 마지막 수집 결과가 지워져 화면에 용량 0·'미수집'으로 남는다.
    const ids = new Set(listBmServersRaw().map((s) => s.id));
    for (const id of [...latest.keys()]) if (!ids.has(id)) latest.delete(id);
    lastRunAt = at;
    // 필드명 okCount — { ok:true, ...summary } 스프레드에서 성공 여부(boolean)를 덮지 않게.
    lastRunSummary = { at, trigger, servers: servers.length, okCount: ok, errors, queued, authStopped, ms: at - started };
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
