/**
 * bmusage/rates.js — 누적 카운터 → 비율(순수, v2.550).
 *
 * CPU(`/proc/stat`)·디스크 I/O(`/proc/diskstats`)·네트워크(`/proc/net/dev`)·HBA
 * (`/sys/class/fc_host/<hostN>/statistics`)는 전부 **부팅 이후 누적**이다. 한 번 읽어서는 사용률을
 * 알 수 없고 **두 주기의 차이**가 필요하다.
 *
 * ⚠⚠ **첫 수집은 0 이 아니라 `null` 이다**(CLAUDE.md `sanswitch/rates.js` 규약).
 *   0 으로 채우면 화면이 **'부하 없음' 이라는 거짓**을 말한다 — 이 기능에서 가장 위험한 거짓이다.
 * ⚠ **카운터 리셋(음수 델타)도 `null`** 이다. 재부팅하면 카운터가 0 으로 돌아가므로 그 주기의
 *   값은 '모른다' 가 맞다(0 도 아니고 거대한 음수도 아니다).
 * ⚠ **시간 간격이 비정상이면 `null`** — 주기를 건너뛰거나 시계가 뒤로 가면(NTP 보정) 비율이
 *   말이 안 되는 값이 된다. 상한(`MAX_SPAN_MS`)을 넘긴 간격은 버린다.
 */
import { numOrNull } from '../util/numOrNull.js';
const MIN_SPAN_MS = 1_000;
export const MAX_SPAN_MS = 60 * 60_000;   // 1시간 넘게 벌어진 두 표본은 비율로 쓰지 않는다

const fin = numOrNull; // v2.561: 공용 판정

/**
 * 누적값 두 개의 초당 증가량.
 * @returns {number|null} `null` = 판정 보류(첫 표본 · 리셋 · 간격 비정상)
 */
export function perSecond(prevVal, curVal, prevAt, curAt) {
  const p = fin(prevVal); const c = fin(curVal);
  const pa = fin(prevAt); const ca = fin(curAt);
  if (p == null || c == null || pa == null || ca == null) return null;
  const span = ca - pa;
  if (span < MIN_SPAN_MS || span > MAX_SPAN_MS) return null;
  const d = c - p;
  if (d < 0) return null;                    // 리셋 — 0 으로 채우지 않는다
  return (d / span) * 1000;
}

/**
 * 두 누적 시간 묶음에서 CPU 사용률(%).
 * `/proc/stat` 의 `cpu` 줄은 **jiffies 누적**이라 (전체증가 − idle증가) / 전체증가 다.
 * @param {{total:number, idle:number}} prev
 * @param {{total:number, idle:number}} cur
 */
export function cpuPctFromJiffies(prev, cur) {
  const pt = fin(prev?.total); const pi = fin(prev?.idle);
  const ct = fin(cur?.total); const ci = fin(cur?.idle);
  if (pt == null || pi == null || ct == null || ci == null) return null;
  const dt = ct - pt; const di = ci - pi;
  if (dt <= 0 || di < 0) return null;        // 리셋·동일 표본 — 판정 보류
  const busy = dt - di;
  if (busy < 0) return null;
  return Math.min(100, Math.round((busy / dt) * 1000) / 10);
}

/**
 * 링크 속도 대비 사용률(%). ⚠ **속도를 모르면 `null`** — 처리량만 보여주고 퍼센트는 지어내지 않는다.
 * @param {number|null} bytesPerSec
 * @param {number|null} linkBitsPerSec  예: 10Gb NIC = 10e9
 */
export function linkPct(bytesPerSec, linkBitsPerSec) {
  const b = fin(bytesPerSec); const l = fin(linkBitsPerSec);
  if (b == null || l == null || l <= 0) return null;
  return Math.min(100, Math.round(((b * 8) / l) * 1000) / 10);
}

/**
 * 디스크 사용 시간 기반 사용률(%). `/proc/diskstats` 10번째 필드(`io_ticks`, ms)는 **I/O 중이던 시간**
 * 누적이라 (증가 ms / 경과 ms) × 100 이 곧 busy% 다(iostat 의 `%util` 과 같은 계산).
 */
export function busyPct(prevTicksMs, curTicksMs, prevAt, curAt) {
  const p = fin(prevTicksMs); const c = fin(curTicksMs);
  const pa = fin(prevAt); const ca = fin(curAt);
  if (p == null || c == null || pa == null || ca == null) return null;
  const span = ca - pa;
  if (span < MIN_SPAN_MS || span > MAX_SPAN_MS) return null;
  const d = c - p;
  if (d < 0) return null;
  return Math.min(100, Math.round((d / span) * 1000) / 10);
}

/** 여러 값의 최대 — ⚠ `null` 은 건너뛰고, 전부 null 이면 null 이다(0 을 만들지 않는다). */
export function maxOrNull(list = []) {
  let best = null;
  for (const v of list) { const n = fin(v); if (n != null && (best == null || n > best)) best = n; }
  return best;
}

/** 여러 값의 합 — ⚠ 전부 null 이면 null. 일부만 null 이면 **합하지 않고** null 이다(부분 합은 거짓). */
export function sumStrict(list = []) {
  let acc = 0; let seen = 0;
  for (const v of list) { const n = fin(v); if (n == null) return null; acc += n; seen += 1; }
  return seen ? acc : null;
}
