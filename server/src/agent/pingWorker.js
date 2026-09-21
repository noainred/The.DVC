/**
 * 위임 Ping 워커 — CENTRAL_URL이 설정된 현장 에이전트에서 동작.
 *  1) 중앙에서 자기 담당 vCenter들의 대기 ping IP를 인출하고
 *  2) 로컬에서 ICMP ping(현장 망에 닿음)
 *  3) 결과를 중앙으로 보고 → UI가 VM 상세에서 녹/적 표시.
 * 응답성을 위해 짧은 주기(기본 4s)로 폴링하되, 대기 작업이 없으면 ping을 돌리지 않는다.
 */

import { config, loadVcenterConfig } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { pingMany } from '../util/ping.js';

let timer = null;
let running = false; // 재진입 방지(긴 ping이 다음 4s 틱과 겹쳐 중복 인출/실행되는 것 차단)
const POLL_MS = Number(process.env.AGENT_PING_POLL_MS) || 4_000;

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
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runPingWorkerOnce() {
  if (!config.agent.centralUrl) return null;
  if (running) return null;
  running = true;
  try { return await runPingWorkerInner(); } finally { running = false; }
}

async function runPingWorkerInner() {
  const vcIds = (loadVcenterConfig().vcenters || []).map((v) => v.id).filter(Boolean);
  if (!vcIds.length) return null;
  try {
    const url = `${config.agent.centralUrl}/api/central/ping-jobs?vcenters=${encodeURIComponent(vcIds.join(','))}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !Object.keys(jobs).length) return null;
    for (const [vcenterId, ips] of Object.entries(jobs)) {
      if (!Array.isArray(ips) || !ips.length) continue;
      const results = await pingMany(ips, { timeoutMs: 1500, concurrency: 8 });
      await resilientFetch(`${config.agent.centralUrl}/api/central/ping-result`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ vcenterId, results }), timeoutMs: 15_000, retries: 2,
      }).catch(() => {});
      console.log(`[ping-agent] ${vcenterId}: ${results.filter((x) => x.alive).length}/${results.length} 응답`);
    }
    _last = { at: Date.now(), ok: true };
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
