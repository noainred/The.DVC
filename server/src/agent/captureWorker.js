/**
 * 위임 tcpdump 캡처 워커 — CENTRAL_URL 설정 시 동작. 중앙에서 자기 이름의 캡처 작업을 인출해
 * 로컬에서 SSH+tcpdump로 실행하고 결과를 보고한다(사설망 서버는 이 엣지가 닿을 수 있음).
 * 캡처는 최대 120초 소요되므로 중복 실행 방지 가드를 둔다.
 */

import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { runTrafficCapture, runDualCapture } from '../net/tcpdump.js';

let timer = null;
let busy = false;
// v2.599 T2599-02: 주기 env 도 [하한, MAX_TIMER_MS] 로 가둔다 — 2^31 초과·음수는 setInterval 에서 1ms 루프가 된다.
const POLL_MS = clampIntervalMs(Number(process.env.AGENT_CAPTURE_POLL_MS) || 4_000, 4_000, 1_000);

/*
 * ⚠⚠ v2.574 IMP-07 — **무음 실패를 만들지 않는다.** v2.573 까지 이 워커는 `catch { return null; }`
 * 하나로 끝나 상태 객체도 로그도 없었다. 4~10초 마다 조용히 실패해도 **엣지 로그 화면에서조차
 * 진단할 길이 없었다** — CLAUDE.md 가 v2.549·v2.554·v2.561 에 **세 번** 같은 경고를 적어 두고도
 * 이 셋만 남아 있던 것이다(v2.561 이 이름까지 적어 뒀다).
 * 이제 `_last` 를 남기고(`captureWorkerStatus`) 실패는 콘솔에도 적으며 `edgelog/spec.js` 표에 등재한다.
 * ⚠ 타이머 콜백의 `.catch(() => {})` 는 정당하다 — 안쪽이 이미 상태를 남기고, setInterval 의
 *   unhandled rejection 을 막는 관례다(v2.561 규약).
 */
let _last = null;
/** 마지막 실행 결과 — `edgelog/spec.js` 가 화면에 싣는다. 비밀은 담지 않는다. */
export function captureWorkerStatus() { return { pollMs: POLL_MS, ..._last }; }

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
  if (_logChange(stage, msg)) console.warn(`[capture-agent] ${msg}`);
  return null;
}
/** 결과 회신 — 응답 상태를 본다(예전엔 .catch(()=>{}) 로 413·403·5xx 가 '완료' 로 보였다). 실패 사유를 돌려준다(없으면 null). */
async function postResult(url, body, timeoutMs) {
  let r;
  try { r = await resilientFetch(url, { method: 'POST', headers: headers(), body, timeoutMs, retries: 2 }); }
  catch (e) { const msg = `결과 회신 실패 — ${String(e?.message || e).slice(0, 200)}`; if (_logChange('회신', msg)) console.warn(`[capture-agent] ${msg}`); return msg; }
  if (r.ok) return null;
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || b?.error || '').slice(0, 200); } catch { /* 본문 없음 */ }
  const msg = `결과 회신 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
  if (_logChange('회신', msg)) console.warn(`[capture-agent] ${msg}`);
  return msg;
}

export async function runCaptureWorkerOnce() {
  if (!config.agent.centralUrl || busy) return null;
  busy = true; // fetch '전에' 즉시 설정 — 4s 두 틱이 fetch 창에서 모두 통과해 잡을 중복 인출하는 것 방지
  try {
    const url = `${config.agent.centralUrl}/api/central/capture-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return await httpFail('인출', r);
    const { jobs } = await r.json();
    // v2.600 EDGE2600-07: 인출이 성공했으면 잡이 0건이어도 상태를 갱신한다 — 예전에는 `return null` 로 끝나
    //   한 번 받은 403 상태가 이후 정상 인출이 계속돼도 화면에 남았다(끈적한 오류).
    if (!jobs || !jobs.length) { _last = { at: Date.now(), ok: true, jobs: 0 }; return null; }
    let postErr = null;
    {
      for (const job of jobs) {
        let result;
        try {
          const s = job.spec || {};
          if (s.dual) {
            result = await runDualCapture({ hostA: s.hostA, hostB: s.hostB, iface: s.iface || 'any', seconds: s.seconds, maxPackets: s.maxPackets, useSudo: s.useSudo !== false });
          } else {
            result = await runTrafficCapture({
              hostA: { host: s.host, port: s.port || 22, username: s.username, password: s.password, privateKey: s.privateKey || undefined },
              peer: s.peer, iface: s.iface || 'any', seconds: s.seconds, maxPackets: s.maxPackets, useSudo: s.useSudo !== false,
            });
            // v2.600 CEN2600-09: 단일 캡처 결과에는 A 호스트가 없다 — 중앙 이력의 hostA 가 항상 빈 값이었다. 실은다.
            if (result && typeof result === 'object' && typeof s.host === 'string') result = { ...result, hostA: s.host };
          }
        } catch (e) { result = { ok: false, reason: e.message }; }
        const jobErr = await postResult(`${config.agent.centralUrl}/api/central/capture-result`, JSON.stringify({ reqId: job.reqId, result }), 20_000);
        postErr = jobErr || postErr;
        // v2.604(감사 EDGE2604-03): 회신 실패를 같은 줄에 적는다(경고는 10분에 1줄로 묶여 이후엔 '완료' 만 보였다).
        console.log(`[capture-agent] 캡처 완료 reqId=${job.reqId}${result?.dual ? ' (dual)' : ''}${jobErr ? ' · 결과 회신 실패(중앙이 다시 인출할 때까지 반영되지 않음)' : ''}`);
      }
    }
    _last = postErr ? { at: Date.now(), ok: false, error: postErr } : { at: Date.now(), ok: true };
    return _last;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    _last = { at: Date.now(), ok: false, error: msg };
    console.warn('[capture-agent] 실패: ' + msg);
    return null;
  }
  finally { busy = false; }
}

export function startCaptureWorker() {
  if (!config.agent.centralUrl) return;
  timer = setInterval(() => runCaptureWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[capture-agent] started (central=${config.agent.centralUrl})`);
}
