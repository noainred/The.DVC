/**
 * 위임 Ping 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 담당 vCenter들의 대기 ping IP를 인출하고
 *  2) 로컬에서 ICMP ping(현장 망에 닿음)
 *  3) 결과를 중앙으로 보고 → UI가 VM 상세에서 녹/적 표시.
 * 응답성을 위해 짧은 주기(기본 4s)로 폴링하되, 대기 작업이 없으면 ping을 돌리지 않는다.
 */

import { config, clampIntervalMs, loadVcenterConfig } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { pingMany } from '../util/ping.js';

let timer = null;
let running = false; // 재진입 방지(긴 ping이 다음 4s 틱과 겹쳐 중복 인출/실행되는 것 차단)
// v2.599 T2599-02: 주기 env 도 [하한, MAX_TIMER_MS] 로 가둔다 — 2^31 초과·음수는 setInterval 에서 1ms 루프가 된다.
const POLL_MS = clampIntervalMs(Number(process.env.AGENT_PING_POLL_MS) || 4_000, 4_000, 1_000);

/*
 * ⚠⚠ v2.574 IMP-07 — **무음 실패를 만들지 않는다.** v2.573 까지 이 워커는 `catch { return null; }`
 * 하나로 끝나 상태 객체도 로그도 없었다. 4~10초 마다 조용히 실패해도 **엣지 로그 화면에서조차
 * 진단할 길이 없었다** — CLAUDE.md 가 v2.549·v2.554·v2.561 에 **세 번** 같은 경고를 적어 두고도
 * 이 셋만 남아 있던 것이다(v2.561 이 이름까지 적어 뒀다).
 * 이제 `_last` 를 남기고(`pingWorkerStatus`) 실패는 콘솔에도 적으며 `edgelog/spec.js` 표에 등재한다.
 * ⚠ 타이머 콜백의 `.catch(() => {})` 는 정당하다 — 안쪽이 이미 상태를 남기고, setInterval 의
 *   unhandled rejection 을 막는 관례다(v2.561 규약).
 */
let _last = null;
/** 마지막 실행 결과 — `edgelog/spec.js` 가 화면에 싣는다. 비밀은 담지 않는다. */
export function pingWorkerStatus() { return { pollMs: POLL_MS, ..._last }; }

function headers() {
  // v2.591(3차 감사 PR-2 ④): X-Agent-Name — 공유 토큰 엣지의 인출·회신이 중앙 데이터 흐름 지도에서 '(unknown)' 한 칸으로 합쳐지지 않게.
  return { 'Content-Type': 'application/json', ...(config.agent.name ? { 'X-Agent-Name': config.agent.name } : {}), ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

// v2.591(3차 감사 PR-5): 인출·회신의 **HTTP 오류**도 상태와 콘솔에 남긴다. v2.574 IMP-07 은 catch 경로만 고쳐서
//   중앙이 403(토큰 불일치)·5xx 를 주면 `if (!r.ok) return null` 로 조용히 끝났다 — 4~10초마다 반복되는 거부가
//   엣지 로그 화면·저널 어디에도 남지 않았다. 같은 사유는 10분에 한 번만 찍는다(저널 폭주 방지).
const _logChange = createChangeLogger({ windowMs: 10 * 60_000 });
async function httpFail(stage, r) {
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || b?.error || '').slice(0, 200); } catch { /* 본문 없음 */ }
  const msg = `${stage} HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
  _last = { at: Date.now(), ok: false, error: msg, status: r.status };
  if (_logChange(stage, msg)) console.warn(`[ping-agent] ${msg}`);
  return null;
}
/** 결과 회신 — 응답 상태를 본다(예전엔 .catch(()=>{}) 로 413·403·5xx 가 '완료' 로 보였다). 실패 사유를 돌려준다(없으면 null). */
async function postResult(url, body, timeoutMs) {
  let r;
  try { r = await resilientFetch(url, { method: 'POST', headers: headers(), body, timeoutMs, retries: 2 }); }
  catch (e) { const msg = `결과 회신 실패 — ${String(e?.message || e).slice(0, 200)}`; if (_logChange('회신', msg)) console.warn(`[ping-agent] ${msg}`); return msg; }
  if (r.ok) return null;
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || b?.error || '').slice(0, 200); } catch { /* 본문 없음 */ }
  const msg = `결과 회신 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
  if (_logChange('회신', msg)) console.warn(`[ping-agent] ${msg}`);
  return msg;
}

export async function runPingWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  if (running) return null;
  running = true;
  try { return await runPingWorkerInner(); } finally { running = false; }
}

async function runPingWorkerInner() {
  const vcIds = (loadVcenterConfig().vcenters || []).map((v) => v.id).filter(Boolean);
  // v2.600 EDGE2600-07: '잴 것 0건' 도 상태로 남긴다(logQueryWorker 와 같은 규약).
  if (!vcIds.length) { _last = { at: Date.now(), ok: true, jobs: 0, note: '이 엣지에 등록된 vCenter 가 없습니다.' }; return null; }
  try {
    const url = `${config.agent.centralUrl}/api/central/ping-jobs?vcenters=${encodeURIComponent(vcIds.join(','))}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return await httpFail('인출', r);
    const { jobs } = await r.json();
    if (!jobs || !Object.keys(jobs).length) { _last = { at: Date.now(), ok: true, jobs: 0 }; return null; } // v2.600 EDGE2600-07: 성공 인출(0건)도 상태 갱신 — 끈적한 오류 방지
    let postErr = null;
    for (const [vcenterId, ips] of Object.entries(jobs)) {
      if (!Array.isArray(ips) || !ips.length) continue;
      const results = await pingMany(ips, { timeoutMs: 1500, concurrency: 8 });
      postErr = (await postResult(`${config.agent.centralUrl}/api/central/ping-result`, JSON.stringify({ vcenterId, results }), 15_000)) || postErr;
      console.log(`[ping-agent] ${vcenterId}: ${results.filter((x) => x.alive).length}/${results.length} 응답`);
    }
    _last = postErr ? { at: Date.now(), ok: false, error: postErr } : { at: Date.now(), ok: true };
    return _last;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    _last = { at: Date.now(), ok: false, error: msg };
    console.warn('[ping-agent] 실패: ' + msg);
    return null;
  }
}

export function startPingWorker() {
  if (!config.agent.centralUrl) return; // 중앙 미설정 → 에이전트 아님(비활성)
  timer = setInterval(() => runPingWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[ping-agent] started (central=${config.agent.centralUrl}, poll=${POLL_MS}ms)`);
}
