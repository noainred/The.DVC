/**
 * 위임 tcpdump 캡처 워커 — CENTRAL_URL 설정 시 동작. 중앙에서 자기 이름의 캡처 작업을 인출해
 * 로컬에서 SSH+tcpdump로 실행하고 결과를 보고한다(사설망 서버는 이 엣지가 닿을 수 있음).
 * 캡처는 최대 120초 소요되므로 중복 실행 방지 가드를 둔다.
 */

import { config } from '../config.js';
import { runTrafficCapture, runDualCapture } from '../net/tcpdump.js';

let timer = null;
let busy = false;
const POLL_MS = Number(process.env.AGENT_CAPTURE_POLL_MS) || 4_000;

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runCaptureWorkerOnce() {
  if (!config.agent.centralUrl || busy) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/capture-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) return null;
    busy = true;
    try {
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
        await fetch(`${config.agent.centralUrl}/api/central/capture-result`, {
          method: 'POST', headers: headers(), body: JSON.stringify({ reqId: job.reqId, result }), signal: AbortSignal.timeout(20_000),
        }).catch(() => {});
        console.log(`[capture-agent] 캡처 완료 reqId=${job.reqId}${result?.dual ? ' (dual)' : ''}`);
      }
    } finally { busy = false; }
    return { at: Date.now() };
  } catch { busy = false; return null; }
}

export function startCaptureWorker() {
  if (!config.agent.centralUrl) return;
  timer = setInterval(() => runCaptureWorkerOnce().catch(() => {}), POLL_MS);
  timer.unref?.();
  console.log(`[capture-agent] started (central=${config.agent.centralUrl})`);
}
