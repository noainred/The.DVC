/**
 * sanswitch/rates.js — 포트 처리량(속도) 계산(v2.410).
 *
 * FOS 는 포트별 **누적 카운터**만 준다(프레임 수·옥텟 수). '지금 몇 Gbps 인가'는 두 번의
 * 수집 사이 델타를 시간으로 나눠야 나온다. 그래서 직전 수집의 카운터를 인메모리로 들고 있다가
 * 다음 수집 때 차이를 낸다.
 *
 * 규칙(정직 표기):
 *  - **첫 수집은 null** 이다. 0 으로 채우면 '트래픽이 없다'로 오해된다.
 *  - 카운터가 줄어들면(스위치 재부팅·카운터 클리어·포트 재삽입) null 로 둔다 — 음수 델타를
 *    큰 양수로 착각해 말도 안 되는 속도를 보고하는 사고를 막는다.
 *  - 간격이 너무 짧거나(<5초) 너무 길면 신뢰할 수 없어 null. 긴 쪽 상한은 **max(2시간, 수집 주기 × 3 + 직전 실행 소요)**다
 *    (v2.742 DEV-06 — v2.732 B1-01 'bmusage spanLimitMs' 와 같은 규칙). 2시간 고정이면 SANSW_POLL_MS 를 2시간 이상으로 둔
 *    현장에서 처리량이 **영원히 null** 인데 화면은 '두 번째 수집부터 표시' 라고 말했다. 주기는 폴러가 매 주기
 *    `setRateCadence` 로 알려 준다(주기는 env 로 바뀌고, 적응 타이머는 수집이 끝난 뒤 다시 무장하므로 간격 = 주기 + 소요).
 *    ⚠ 32비트 카운터는 긴 간격에서 여러 번 돌 수 있다 — 그래서 상한을 없애지 않고 주기에 맞춰 넓힌다(음수 델타는 여전히 null).
 *  - 계산하지 않은 이유를 `reason`(first | gap-too-short | gap-too-long)으로 돌려준다 — 화면이 사유별로 말한다.
 *  - 메모리에만 둔다. 재시작하면 첫 수집으로 되돌아간다(값이 틀리는 것보다 낫다).
 */

const MIN_GAP_MS = 5_000;
const BASE_MAX_GAP_MS = 2 * 60 * 60_000;
const _prev = new Map(); // deviceId → { at, ports: Map(portKey → {inFrames,outFrames,inBytes,outBytes}) }
const _last = new Map(); // deviceId → 마지막 applyRates 결과 { at(카운터 시각), calledAt(부른 시각), computed, gapSec, reason, maxGapSec }
let _cadence = { intervalMs: 0, runMs: 0 };

/** 폴러가 매 주기 알려 주는 수집 주기·직전 실행 소요(ms). 숫자가 아니거나 음수면 0(= 2시간 하한만). */
export function setRateCadence({ intervalMs = 0, runMs = 0 } = {}) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  _cadence = { intervalMs: n(intervalMs), runMs: n(runMs) };
}

/** 처리량을 계산하는 최대 간격(ms) = max(2시간, 주기 × 3 + 실행 소요). */
export function maxGapMs(cadence = _cadence) {
  const iv = Number(cadence?.intervalMs) || 0;
  const run = Number(cadence?.runMs) || 0;
  return Math.max(BASE_MAX_GAP_MS, iv * 3 + run);
}

/** 그 장비의 마지막 계산 결과(폴러가 스냅샷에 사유를 싣는 데 쓴다). 없으면 null. */
export function lastRateResult(deviceId) { return _last.get(deviceId) || null; }

function rate(prevVal, curVal, seconds) {
  if (prevVal == null || curVal == null) return null;
  const d = curVal - prevVal;
  if (d < 0) return null;                  // 카운터 리셋 — 추정하지 않는다
  return Math.round(d / seconds);
}

/**
 * 이번 수집의 포트 카운터로 속도를 채운다(포트 객체를 제자리에서 갱신).
 * @param deviceId 장비 id
 * @param ports    PortRow[] — inFrames/outFrames/inBytes/outBytes 중 있는 것만 쓴다
 * @param now      수집 시각(ms)
 * @returns { computed:boolean, gapSec:number|null, reason?:'first'|'gap-too-short'|'gap-too-long', maxGapSec:number }
 *   — UI 가 '첫 수집이라 미표시' 와 '간격이 상한을 넘어 미계산' 을 구분할 수 있게
 */
// v2.597(감사 C2597-07): 디렉터(슬롯이 있는 포트)는 'slot/port' 로 키를 잡는다 — REST 폴백 index('1/10'·'11/0' → 둘 다 110)가
//   겹치면 두 포트의 카운터가 섞여 처리량이 틀린다. 슬롯 없는 스위치는 예전대로 index(동작 불변).
// v2.630(A2-04): 기준선·월간 점검 증분도 같은 키를 쓴다(errBaseline·healthCheck) — export.
export const rateKey = (p) => (p.slot != null && p.slotPort ? `s:${p.slotPort}` : String(p.index));
export function applyRates(deviceId, ports = [], now = Date.now()) {
  const prev = _prev.get(deviceId);
  const cur = { at: now, ports: new Map() };
  for (const p of ports) {
    cur.ports.set(rateKey(p), {
      inFrames: p.inFrames ?? null, outFrames: p.outFrames ?? null,
      inBytes: p.inBytes ?? null, outBytes: p.outBytes ?? null,
      framesApprox: !!p.framesApprox,
    });
  }
  _prev.set(deviceId, cur);

  const gapMs = prev ? now - prev.at : 0;
  const lim = maxGapMs();
  const maxGapSec = Math.round(lim / 1000);
  if (!prev || gapMs < MIN_GAP_MS || gapMs > lim) {
    for (const p of ports) { p.inBps = null; p.outBps = null; p.inFps = null; p.outFps = null; }
    const reason = !prev ? 'first' : gapMs < MIN_GAP_MS ? 'gap-too-short' : 'gap-too-long';
    const out = { computed: false, gapSec: prev ? Math.round(gapMs / 1000) : null, reason, maxGapSec };
    _last.set(deviceId, { at: now, calledAt: Date.now(), ...out });
    return out;
  }
  const sec = gapMs / 1000;
  // ⚠ null 을 산술에 넣지 말 것. 첫 구현이 `rate(...) * 8 || 0` 이었는데, rate 가 null 을
  //   돌려주는 경우(카운터 리셋)에 `null * 8 = 0` → `0 || 0 = 0` 이 되어 **리셋을 '트래픽
  //   0'으로 보고**했다(회귀 테스트가 잡음). null 은 끝까지 null 로 흘려야 한다.
  const toBps = (a, b) => { const r = rate(a, b, sec); return r == null ? null : r * 8; };
  for (const p of ports) {
    const old = prev.ports.get(rateKey(p));
    if (!old) { p.inBps = null; p.outBps = null; p.inFps = null; p.outFps = null; continue; }
    // 옥텟(바이트)이 있으면 bps 로, 없으면(SSH porterrshow) 프레임/초로 — 둘 다 정직하게 구분 표기.
    p.inBps = toBps(old.inBytes, p.inBytes);
    p.outBps = toBps(old.outBytes, p.outBytes);
    // v2.590 F3: 프레임 카운터가 k/m/g 로 축약(반올림)돼 있으면 두 값의 차이는 트래픽이 아니다 —
    //   `4.1g → 4.1g` 는 0 f/s, `4.1g → 4.2g` 는 33만 f/s 계단이 된다. 모르는 것으로 둔다.
    if (p.framesApprox || old.framesApprox) { p.inFps = null; p.outFps = null; p.fpsHeld = 'approx'; continue; }
    p.inFps = rate(old.inFrames, p.inFrames, sec);
    p.outFps = rate(old.outFrames, p.outFrames, sec);
  }
  const out = { computed: true, gapSec: Math.round(sec), maxGapSec };
  _last.set(deviceId, { at: now, calledAt: Date.now(), ...out });
  return out;
}

export function _resetForTest() { _prev.clear(); _last.clear(); _cadence = { intervalMs: 0, runMs: 0 }; }
