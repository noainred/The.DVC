/**
 * 위임 tcpdump 캡처 워커 — CENTRAL_URL 설정 시 동작. 중앙에서 자기 이름의 캡처 작업을 인출해
 * 로컬에서 SSH+tcpdump로 실행하고 결과를 보고한다(사설망 서버는 이 엣지가 닿을 수 있음).
 * 캡처는 최대 120초 소요되므로 중복 실행 방지 가드를 둔다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { runTrafficCapture, runDualCapture } from '../net/tcpdump.js';

let timer = null;
let busy = false;
const POLL_MS = Number(process.env.AGENT_CAPTURE_POLL_MS) || 4_000;

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
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runCaptureWorkerOnce() {
  if (!config.agent.centralUrl || busy) return null;
  busy = true; // fetch '전에' 즉시 설정 — 4s 두 틱이 fetch 창에서 모두 통과해 잡을 중복 인출하는 것 방지
  try {
    const url = `${config.agent.centralUrl}/api/central/capture-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) return null;
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
          }
        } catch (e) { result = { ok: false, reason: e.message }; }
        await resilientFetch(`${config.agent.centralUrl}/api/central/capture-result`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ reqId: job.reqId, result }), timeoutMs: 20_000, retries: 2,
        }).catch(() => {});
        console.log(`[capture-agent] 캡처 완료 reqId=${job.reqId}${result?.dual ? ' (dual)' : ''}`);
      }
    }
    _last = { at: Date.now(), ok: true };
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
