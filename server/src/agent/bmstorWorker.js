/**
 * 베어메탈 스토리지 위임 워커(v2.341) — CENTRAL_URL 설정된 엣지에서 동작. 중앙에서 자기 이름의
 * df 수집 잡을 인출해 현지 SSH 로 수집하고 결과를 회신한다(captureWorker 와 동일 골격 —
 * busy 가드로 중복 인출 방지, 결과 회신 = claim→ack 의 ack).
 * 잡 spec 의 SSH 자격증명은 이 실행에만 쓰고 저장·로깅하지 않는다.
 */

import { config, clampIntervalMs } from '../config.js';
import { createChangeLogger } from '../util/logThrottle.js';
import { resilientFetch } from '../util/resilientFetch.js';
import { collectMany } from '../bmstor/collect.js';

let busy = false;
// v2.599 T2599-02: 주기 env 도 [하한, MAX_TIMER_MS] 로 가둔다 — 2^31 초과·음수는 setInterval 에서 1ms 루프가 된다.
const POLL_MS = clampIntervalMs(Number(process.env.AGENT_BMSTOR_POLL_MS) || 10_000, 10_000, 1_000);

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
  if (_logChange(stage, msg)) console.warn(`[bmstor-agent] ${msg}`);
  return null;
}
/** 결과 회신 — 응답 상태를 본다(예전엔 .catch(()=>{}) 로 413·403·5xx 가 '완료' 로 보였다). 실패 사유를 돌려준다(없으면 null). */
async function postResult(url, body, timeoutMs) {
  let r;
  try { r = await resilientFetch(url, { method: 'POST', headers: headers(), body, timeoutMs, retries: 2 }); }
  catch (e) { const msg = `결과 회신 실패 — ${String(e?.message || e).slice(0, 200)}`; if (_logChange('회신', msg)) console.warn(`[bmstor-agent] ${msg}`); return msg; }
  if (r.ok) return null;
  let reason = '';
  try { const b = await r.json(); reason = String(b?.reason || b?.error || '').slice(0, 200); } catch { /* 본문 없음 */ }
  const msg = `결과 회신 HTTP ${r.status}${reason ? ` — ${reason}` : ''}`;
  if (_logChange('회신', msg)) console.warn(`[bmstor-agent] ${msg}`);
  return msg;
}

export async function runBmstorWorkerOnce() {
  if (!config.agent.centralUrl || busy) return null;
  busy = true; // fetch 전에 설정 — 폴 두 틱이 같은 잡을 중복 인출하지 않게(captureWorker 동일)
  try {
    const url = `${config.agent.centralUrl}/api/central/bmstor-jobs?agent=${encodeURIComponent(config.agent.name)}`;
    const r = await resilientFetch(url, { headers: headers(), timeoutMs: 15_000, retries: 2 });
    if (!r.ok) return await httpFail('인출', r);
    const { jobs } = await r.json();
    if (!jobs || !jobs.length) { _last = { at: Date.now(), ok: true, jobs: 0 }; return null; } // v2.600 EDGE2600-07: 성공 인출(0건)도 상태 갱신 — 끈적한 오류 방지
    let postErr = null;
    for (const job of jobs) {
      let results;
      try { results = await collectMany(Array.isArray(job.servers) ? job.servers : []); }
      catch (e) { results = (job.servers || []).map((s) => ({ id: s.id, ok: false, mounts: [], error: e.message })); }
      // 결과에서 자격증명이 나가지 않게 용량 필드만 회신(collectMany 결과가 이미 그 형태지만 명시 필터).
      const safe = results.map((x) => ({ id: x.id, ok: x.ok, mounts: x.mounts, missing: x.missing, error: x.error }));
      // 회신 실패 시 중앙 reap 이 재인출시킨다(claim→ack 설계 그대로) — 그래도 실패 사실은 상태·콘솔에 남긴다(v2.591 PR-5).
      const jobErr = await postResult(`${config.agent.centralUrl}/api/central/bmstor-result`, JSON.stringify({ reqId: job.reqId, results: safe }), 30_000);
      postErr = jobErr || postErr;
      // v2.604(감사 EDGE2604-03): 회신이 실패한 잡을 '완료' 한 줄로만 남기지 않는다 — 같은 실패 경고는 10분에 1줄로 묶이므로
      //   이후 주기에는 이 줄만 보였다. 수집은 끝났지만 중앙에 닿지 않았다는 사실을 같은 줄에 적는다.
      console.log(`[bmstor-agent] 수집 완료 reqId=${job.reqId} 서버 ${safe.length}대${jobErr ? ' · 결과 회신 실패(중앙이 다시 인출할 때까지 반영되지 않음)' : ''}`);
    }
    _last = postErr ? { at: Date.now(), ok: false, error: postErr } : { at: Date.now(), ok: true };
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
