/**
 * Agent-side scan worker. When CENTRAL_URL is configured, this instance acts as
 * an agent: it periodically pulls its IP assignment from the central portal (by
 * its AGENT_NAME), scans the assigned range locally for Dell iDRACs, optionally
 * auto-registers the discovered iDRACs into its local registry (so it starts
 * collecting their power), and reports the scan summary back to the central.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { scanForIdracs } from '../idrac/scan.js';
import { registerScanned } from '../idrac/registry.js';
import { pollNow } from '../idrac/poller.js';
import { makeScanAuthPolicy } from '../idrac/scanAuth.js';
import { tryAcquireScan, releaseScan } from '../idrac/scanPoller.js'; // v2.621(감사 LIFE-01)

let timer = null;
let last = null; // { at, agent, scanned, foundCount, registered, error }
let running = false; // 재진입 가드 — 스캔이 인터벌을 넘기면 중첩 실행돼 이중 스캔/보고, CPU 누적

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

async function pullAssignment() {
  const url = `${config.agent.centralUrl}/api/central/assignment?agent=${encodeURIComponent(config.agent.name)}`;
  const res = await resilientFetch(url, { headers: headers(), timeoutMs: 20_000, retries: 2 });
  if (!res.ok) throw new Error(`assignment -> ${res.status}`);
  return res.json();
}

/**
 * 스캔 결과 회신. 실패 사유 문자열 또는 null(성공).
 * v2.593(감사 EDGE-2): 예전엔 결과를 버리고 호출부가 `.catch(() => {})` 로 삼켜, 중앙이 403·413·5xx 로 거부해도
 * 상태(last)는 성공 모양이고 콘솔은 '스캔 완료' 였다(`resilientFetch` 는 비-2xx 를 throw 하지 않는다 — v2.591 PR-9).
 */
async function postResult(payload) {
  const url = `${config.agent.centralUrl}/api/central/result`;
  try {
    const r = await resilientFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(payload), timeoutMs: 30_000, retries: 2 });
    return r.ok ? null : `결과 회신 거부(HTTP ${r.status})`;
  } catch (e) { return `결과 회신 실패: ${e?.message || e}`; }
}

export async function runAgentScan() {
  if (!config.agent.centralUrl) return null;
  if (running) return last; // 이전 주기 진행 중이면 이번 틱 건너뜀
  running = true;
  const started = Date.now();
  try {
    const a = await pullAssignment();
    if (!a?.assigned) { last = { at: Date.now(), agent: config.agent.name, assigned: false }; return last; }

    // v2.591(감사 F3): 이 경로는 타이머만 부른다(수동 진입점 없음 — grep 확인) → 주기 스캔 규칙을 적용한다.
    //   직전 인증 실패 IP·주 폴러가 같은 계정으로 이미 멈춘 등록 서버는 건너뛰고 개수를 `last` 에 남긴다.
    //   중앙 /result 는 authSkipped 를 받지 않으므로(구 계약) 엣지 로그 화면(collect.agentScan)이 그 사실을 말한다.
    const authPolicy = makeScanAuthPolicy({ rangeId: 'assign', username: a.username, password: a.password, periodic: true });
    // v2.621(감사 LIFE-01): 이 엣지의 다른 iDRAC 스캔(주기·'지금 스캔'·임시·중앙 PUSH·위임 잡)과 **같은 잠금**을 잡는다 — v2.612
    //   EDGE2612-01 이 넷을 한 잠금으로 묶을 때 이 할당 스캐너만 자체 running 만 봐서, 다른 스캔이 도는 중에도 같은 계정으로 한 번 더
    //   돌았다(대역이 겹치면 같은 BMC 에 로그인 시도가 두 배 — 비밀번호가 틀린 iDRAC·iLO 의 계정 잠금 위험). 못 잡으면 이번 주기는
    //   건너뛰고 사유를 상태(last.skippedBusy)·콘솔에 남긴다(다음 주기에 다시 시도한다 — 조용한 생략 금지).
    const lock = tryAcquireScan('assign');
    if (!lock.ok) {
      last = { at: Date.now(), agent: config.agent.name, assigned: true, skippedBusy: { by: lock.by || null, reason: lock.reason } };
      console.warn(`[agent] 할당 스캔을 이번 주기에 건너뜁니다 — ${lock.reason}`);
      return last;
    }
    let scan;
    let registered = 0;
    try {
      scan = await scanForIdracs({ ips: a.ips, username: a.username, password: a.password, authPolicy });
      if (config.agent.autoRegister && scan.found.length) {
        const r = registerScanned(scan.found, a.username, a.password, 'merge');
        if (r.ok) { registered = (r.added || 0) + (r.updated || 0); pollNow().catch(() => {}); }
      }
    } finally { releaseScan(); }

    const postErr = await postResult({
      agent: config.agent.name,
      scanned: scan.scanned,
      foundCount: scan.foundCount,
      found: scan.found,
      unreachable: scan.unreachable,
      notIdrac: scan.notIdrac,
      authFailed: scan.authFailed,
      durationMs: Date.now() - started,
    });

    last = { at: Date.now(), agent: config.agent.name, assigned: true, scanned: scan.scanned, foundCount: scan.foundCount, registered, authFailed: scan.authFailed || 0, authSkipped: scan.authSkipped || 0, ...(postErr ? { postError: postErr } : {}) };
    if (postErr) console.warn(`[agent] 스캔은 끝났지만 중앙에 결과를 보내지 못했습니다: ${postErr}`);
    console.log(`[agent] 스캔 완료: ${config.agent.name} — ${scan.foundCount}/${scan.scanned} iDRAC, ${registered} 등록${scan.authSkipped ? ` · 인증 실패 정지로 ${scan.authSkipped}개 IP 건너뜀(계정을 고치면 자동 재개)` : ''}`);
    return last;
  } catch (err) {
    last = { at: Date.now(), agent: config.agent.name, error: err.message };
    console.warn(`[agent] 스캔 실패: ${err.message}`);
    return last;
  } finally {
    running = false;
  }
}

export function getAgentScanStatus() {
  return { name: config.agent.name, centralUrl: config.agent.centralUrl || null, intervalMs: config.agent.scanIntervalMs, last };
}

export function startAgentScanner() {
  if (!config.agent.centralUrl) return;
  setTimeout(() => runAgentScan(), 8_000).unref?.();
  timer = setInterval(() => runAgentScan(), config.agent.scanIntervalMs);
  timer.unref?.();
  console.log(`[agent] scanner started (name=${config.agent.name}, central=${config.agent.centralUrl}, every ${Math.round(config.agent.scanIntervalMs / 60000)}m)`);
}
