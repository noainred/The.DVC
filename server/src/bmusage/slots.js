/**
 * bmusage/slots.js — 베어메탈 수집의 **전역 동시성 풀**(v2.929 예정 · 5단계 집중 모니터링 · 설계 PROFILES §13 ‘전역 동시성 풀(32) 공유’).
 *
 * 주기 수집(poller — 동시 BMUSAGE_CONCURRENCY)과 집중 수집(focus — 분마다 서버 1대씩)이 **같은 슬롯**을 쓴다. 주기 수집은 자기 풀 상한이 이 용량과 같아
 *   스스로 기다리지 않는다 — 집중 수집이 슬롯을 쥐고 있을 때만 그만큼 늦어진다(그 대가는 피크 창 주기 예산이 본다: peakPlan 에 집중 활성 수를 뺀 동시성을 준다).
 * 집중 수집은 **앞자리 대기**(priority) — 1분 간격이 주기 수집 한 바퀴(1,000대면 수 분)를 기다리면 그 분이 통째로 결측이 된다. 대기 상한(waitMs)을 넘기면 얻지 못한 것으로
 *   돌려주고(호출부가 그 분을 결측 'pool-busy' 로 센다 — 0 으로 채우지 않는다).
 */
// 용량의 단일 원천은 poller.js CONCURRENCY(env BMUSAGE_CONCURRENCY — bmUsageConcurrency2918 이 고정) — 폴러가 로드될 때 configureSlots 로 넘긴다.
//   (여기서 env 를 다시 읽으면 두 벌이 되고, poller 를 import 하면 순환이다.) 폴러 미로드(단위 테스트)면 기본 32.
const CAP_DEFAULT = 32;
let CAP = CAP_DEFAULT;
export function configureSlots({ capacity } = {}) { const c = Math.floor(Number(capacity)); CAP = Number.isFinite(c) && c >= 1 ? c : CAP_DEFAULT; grant(); }
let _used = 0;
// 6단계 수집 건강: 주기 동안 동시에 쓴 최대 슬롯 수(‘동시성 사용 n/설정값’) — 폴러가 주기 시작에 0 으로 두고 끝에 읽는다(재시작하면 0 부터).
let _peak = 0;
const bumpPeak = () => { if (_used > _peak) _peak = _used; };
const _waiters = [];   // { resolve, priority, timer }

export function slotCapacity() { return CAP; }
export function slotStatus() { return { capacity: CAP, used: _used, waiting: _waiters.length, peak: _peak }; }
/** 지금까지의 최대 사용 수를 돌려주고 지금 사용 수로 다시 시작한다(주기 경계). */
export function slotPeakReset() { const p = _peak; _peak = _used; return p; }

function grant() {
  while (_used < CAP && _waiters.length) {
    const w = _waiters.shift();
    if (w.timer) clearTimeout(w.timer);
    _used += 1; bumpPeak();
    w.resolve(true);
  }
}
/** 슬롯 하나를 얻는다 — true(얻음) · false(대기 상한 초과). */
export function acquireSlot({ priority = false, waitMs = Infinity } = {}) {
  if (_used < CAP && !_waiters.length) { _used += 1; bumpPeak(); return Promise.resolve(true); }
  return new Promise((resolve) => {
    const w = { resolve, priority, timer: null };
    if (Number.isFinite(waitMs)) {
      // 대기 상한 타이머는 unref 하지 않는다 — 기다리는 쪽(집중 수집 한 분)이 있는 동안은 살아 있어야 결과(false)가 돌아온다(상한 ≤ 45초).
      w.timer = setTimeout(() => { const i = _waiters.indexOf(w); if (i >= 0) _waiters.splice(i, 1); resolve(false); }, Math.max(0, waitMs));
    }
    if (priority) { const i = _waiters.findIndex((x) => !x.priority); if (i < 0) _waiters.push(w); else _waiters.splice(i, 0, w); }
    else _waiters.push(w);
    grant();
  });
}
export function releaseSlot() { _used = Math.max(0, _used - 1); grant(); }
/** fn 을 슬롯 하나 안에서. 얻지 못하면 onBusy() 결과를 돌려준다. */
export async function withSlot(fn, { priority = false, waitMs = Infinity, onBusy = () => null } = {}) {
  const ok = await acquireSlot({ priority, waitMs });
  if (!ok) return onBusy();
  try { return await fn(); } finally { releaseSlot(); }
}
export function _resetSlotsForTest() { for (const w of _waiters.splice(0)) { if (w.timer) clearTimeout(w.timer); w.resolve(false); } _used = 0; _peak = 0; }
