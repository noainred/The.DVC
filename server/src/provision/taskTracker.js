/**
 * provision/taskTracker.js — LIVE 프로비저닝의 제출과 vCenter 작업 결과 추적(결정(56~75 남긴 것) 74 ②).
 *
 * 제출과 추적을 **분리**한다:
 *   · 제출 — 예전과 같은 동시성 풀(CONCURRENCY)로 CloneVM_Task 를 보내고 곧바로 다음 VM 으로 간다(결과를 기다리지 않는다).
 *     vCenter 가 받은 작업을 자기 줄에 세워 돌린다 — 복제 1건 10분이면 500대 배치가 제출에서 21시간 묶이던 회귀(같은 풀 안 대기)를 되돌린 것.
 *   · 추적 — 제출 풀과 따로 도는 고리 하나가 일정 간격(pollMs)마다 '제출됨' 인 작업 id 를 묶어(chunk) 한 번에 조회한다
 *     (RetrieveProperties 에 objectSet 여럿 — 묶음 동시성 상한 concurrency). 시한(timeoutMs — 제출 시각부터)을 넘기면 '결과 모름' 으로 끝낸다.
 *     작업은 **취소하지 않는다**(vCenter 에서 계속될 수 있다 — 문구가 그렇게 말한다). 시한을 넘긴 뒤에도 한 번은 상태를 본 다음에 끝낸다.
 *   · 묶음 조회가 vCenter 오류(fault)로 실패하면 — 대개 사라진 작업 하나(ManagedObjectNotFound)가 묶음 전체를 실패시킨 것 — 그 묶음만 하나씩 다시 묻는다.
 *     연결 오류(fault 없음)는 하나씩 다시 묻지 않는다(끊긴 망에 작업 수만큼 시한을 쌓지 않게) — 그 회차는 건너뛰고 시한에 '조회 실패' 로 끝난다.
 * 상태: queued → running(제출 중) → submitted(vCenter 작업 중) → done · error · unknown. 순수 — prov 는 { cloneOne, fetchTaskStates } 만 쓴다(시험은 가짜).
 */
import { poolRun } from '../util/pool.js';
import { describeError } from '../util/errors.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const msgOf = (e) => String(e?.message || e || '사유 미상').slice(0, 300);
const isGone = (e) => e?.fault === 'ManagedObjectNotFound' || /ManagedObjectNotFound/.test(String(e?.message || ''));

/** VM 하나 제출 — 결과는 기다리지 않는다. 작업 번호가 없으면 추적할 수 없으므로 unknown. */
export async function submitOne(prov, source, v, { powerOn = false, placement = {}, now = Date.now } = {}) {
  v.status = 'running';
  let r;
  try { r = await prov.cloneOne(source, v, { powerOn, placement }); }
  catch (err) { v.status = 'error'; v.error = describeError(err).message; return v; }
  v.task = r?.task || null;
  if (!v.task) { v.status = 'unknown'; v.error = '복제 작업 번호(Task)를 받지 못해 결과를 추적할 수 없습니다 — vCenter 최근 작업에서 확인하세요.'; return v; }
  v.status = 'submitted'; v.submittedAt = now();
  return v;
}

/**
 * 작업 id 목록 → Map(ref → { state, error } | { gone:true } | { pollError }). 묶음(chunk)마다 한 번 조회 · 묶음 동시성 concurrency.
 * prov.fetchTaskStates(refs) 는 Map(ref → { state, error }) 를 돌려준다(없는 ref 는 빠질 수 있다 — 그 ref 는 이번 회차 '모름').
 */
export async function fetchStatesBatched(prov, refs, { chunk = 100, concurrency = 2 } = {}) {
  const out = new Map();
  const groups = [];
  for (let i = 0; i < refs.length; i += chunk) groups.push(refs.slice(i, i + chunk));
  const one = async (r) => {
    try { for (const [k, s] of await prov.fetchTaskStates([r])) out.set(k, s); }
    catch (e) { out.set(r, isGone(e) ? { gone: true } : { pollError: msgOf(e) }); }
  };
  await poolRun(groups, concurrency, async (g) => {
    try { for (const [k, s] of await prov.fetchTaskStates(g)) out.set(k, s); }
    catch (e) {
      if (g.length > 1 && (e?.fault || isGone(e))) { for (const r of g) await one(r); return; }   // vCenter 가 답한 오류 — 하나씩
      for (const r of g) out.set(r, isGone(e) ? { gone: true } : { pollError: msgOf(e) });
    }
  });
  return out;
}

/**
 * 추적 고리 — vms 중 'submitted' 를 pollMs 마다 묶어 조회해 done · error · unknown 으로 끝낸다.
 *   isSubmitting() 이 참인 동안은 새로 제출될 VM 을 기다린다(제출과 동시에 돈다). 모두 끝나고 제출도 끝나면 돌아온다.
 *   VM 마다 시한은 제출 시각 + timeoutMs — 고리 전체는 마지막 제출 + timeoutMs + pollMs 안에 끝난다.
 */
export async function trackTasks(prov, vms, { isSubmitting = () => false, idleWait = null, timeoutMs, pollMs = 15_000, chunk = 100, concurrency = 2, now = Date.now, sleep = realSleep, onChange = null } = {}) {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  for (;;) {
    const pending = vms.filter((v) => v.status === 'submitted');
    if (pending.length) {
      const states = await fetchStatesBatched(prov, [...new Set(pending.map((v) => v.task))], { chunk, concurrency });
      const t = now();
      let changed = false;
      for (const v of pending) {
        const s = states.get(v.task);
        if (s?.state === 'success') { v.status = 'done'; v.error = null; changed = true; continue; }
        if (s?.state === 'error') { v.status = 'error'; v.error = `vCenter 복제 작업 실패: ${s.error || '사유 미상'}`; changed = true; continue; }
        if (s?.gone) { v.status = 'unknown'; v.error = 'vCenter 에서 이 작업 정보를 찾을 수 없습니다 — 결과 모름(vCenter 최근 작업 · VM 목록에서 확인하세요).'; changed = true; continue; }
        if (s?.pollError) v.trackError = s.pollError; else if (s) delete v.trackError;
        if (t - (Number(v.submittedAt) || t) >= timeoutMs) {
          v.status = 'unknown';
          v.error = v.trackError
            ? `작업 결과를 조회하지 못했습니다(${v.trackError}) — vCenter 에서 계속될 수 있습니다.`
            : `결과 대기 시간 초과(${minutes}분) — vCenter 에서 계속될 수 있습니다(최근 작업에서 확인하세요).`;
          changed = true;
        }
      }
      if (changed && onChange) { try { onChange(); } catch { /* 저장 실패는 추적과 무관 */ } }
    }
    const waiting = vms.some((v) => v.status === 'submitted');
    if (!isSubmitting() && !waiting) return;
    // 추적할 것이 없고 제출만 도는 중이면 제출이 끝나는 순간 깨어난다(모두 제출 실패한 배치가 간격만큼 늦게 끝나지 않게).
    await (!waiting && idleWait ? idleWait() : sleep(pollMs));
  }
}

/**
 * LIVE 배치 — 제출 풀(concurrency)과 추적 고리를 함께 돌린다. 제출은 추적을 기다리지 않는다.
 * @param {{cloneOne:Function, fetchTaskStates:Function}} prov
 */
export async function runLiveVms(prov, source, vms, {
  powerOn = false, placement = {}, concurrency = 4, timeoutMs, pollMs = 15_000, chunk = 100, trackConcurrency = 2,
  now = Date.now, sleep = realSleep, onChange = null,
} = {}) {
  let submitting = true;
  let wake = null;
  const sub = poolRun(vms, concurrency, async (v) => {
    await submitOne(prov, source, v, { powerOn, placement, now });
    if (onChange) { try { onChange(); } catch { /* */ } }
  }).finally(() => { submitting = false; wake?.(); });
  // 제출 중 · 추적할 것 없음 — 간격만큼 기다리되 제출이 끝나면 곧바로 깬다(타이머는 지운다).
  const idleWait = () => new Promise((r) => {
    if (!submitting) { r(); return; }
    const t = setTimeout(() => { wake = null; r(); }, pollMs);
    wake = () => { clearTimeout(t); wake = null; r(); };
  });
  const trk = trackTasks(prov, vms, { isSubmitting: () => submitting, idleWait, timeoutMs, pollMs, chunk, concurrency: trackConcurrency, now, sleep, onChange });
  await Promise.all([sub, trk]);
}
