/**
 * 베어메탈 스토리지 위임 워커(v2.341) — CENTRAL_URL 설정된 엣지에서 동작. 중앙에서 자기 이름의
 * df 수집 잡을 인출해 현지 SSH 로 수집하고 결과를 회신한다(captureWorker 와 동일 골격 —
 * busy 가드로 중복 인출 방지, 결과 회신 = claim→ack 의 ack).
 * 잡 spec 의 SSH 자격증명은 이 실행에만 쓰고 저장·로깅하지 않는다.
 */

import { config } from '../config.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { collectMany } from '../bmstor/collect.js';

let busy = false;
const POLL_MS = Number(process.env.AGENT_BMSTOR_POLL_MS) || 10_000;

/*
 * ⚠⚠ v2.574 IMP-07 — **무음 실패를 만들지 않는다.** v2.573 까지 이 워커는 `catch { return null; }`
 * 하나로 끝나 상태 객체도 로그도 없었다. 4~10초 마다 조용히 실패해도 **엣지 로그 화면에서조차
 * 진단할 길이 없었다** — CLAUDE.md 가 v2.549·v2.554·v2.561 에 **세 번** 같은 경고를 적어 두고도
 * 이 셋만 남아 있던 것이다(v2.561 이 이름까지 적어 뒀다).
 * 이제 `_last` 를 남기고(`bmstorWorkerStatus`) 실패는 콘솔에도 적으며 `edgelog/spec.js` 표에 등재한다.
 * ⚠ 타이머 콜백의 `.catch(() => {})` 는 정당하다 — 안쪽이 이미 상태를 남기고, setInterval 의
 *   unhandled rejection 을 막는 관례다(v2.561 규약).
 */
let _last = null;
/** 마지막 실행 결과 — `edgelog/spec.js` 가 화면에 싣는다. 비밀은 담지 않는다. */
export function bmstorWorkerStatus() { return { pollMs: POLL_MS, ..._last }; }

function headers() {
  return { 'Content-Type': 'application/json', ...(config.agent.centralToken ? { 'X-Central-Token': config.agent.centralToken } : {}) };
}

export async function runBmstorWorkerOnce() {
  if (!config.agent.centralUrl || busy) return null;
  busy = true; // fetch 전에 설정 — 폴 두 틱이 같은 잡을 중복 인출하지 않게(captureWorker 동일)
  try {
    const url = `${config.agent.centralUrl}/api/central/bmstor-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return null;
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) return null;
    for (const job of jobs) {
      let results;
      try { results = await collectMany(Array.isArray(job.servers) ? job.servers : []); }
      catch (e) { results = (job.servers || []).map((s) => ({ id: s.id, ok: false, mounts: [], error: e.message })); }
      // 결과에서 자격증명이 나가지 않게 용량 필드만 회신(collectMany 결과가 이미 그 형태지만 명시 필터).
      const safe = results.map((x) => ({ id: x.id, ok: x.ok, mounts: x.mounts, missing: x.missing, error: x.error }));
      await resilientFetch(`${config.agent.centralUrl}/api/central/bmstor-result`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ reqId: job.reqId, results: safe }), timeoutMs: 30_000, retries: 2,
      }).catch(() => {}); // 회신 실패 시 중앙 reap 이 재인출시킨다(claim→ack 설계 그대로)
      console.log(`[bmstor-agent] 수집 완료 reqId=${job.reqId} 서버 ${safe.length}대`);
    }
    _last = { at: Date.now(), ok: true };
    return _last;
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 300);
    _last = { at: Date.now(), ok: false, error: msg };
    console.warn('[bmstor-agent] 실패: ' + msg);
    return null;
  }
  finally { busy = false; }
}

export function startBmstorWorker() {
  if (!config.agent.centralUrl) return;
  setInterval(() => runBmstorWorkerOnce().catch(() => {}), POLL_MS).unref?.();
  console.log(`[bmstor-agent] started (central=${config.agent.centralUrl})`);
}
