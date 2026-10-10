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
export const MIN_SPAN_MS = 1_000;
export const MAX_SPAN_MS = 60 * 60_000;   // 1시간 넘게 벌어진 두 표본은 비율로 쓰지 않는다

const fin = numOrNull; // v2.561: 공용 판정

/**
 * 두 표본 시각의 간격이 비율 계산에 쓸 만한가(MIN_SPAN ~ MAX_SPAN). 시각을 못 읽었으면 false.
 * 이 모듈의 누적 카운터 환산(perSecond·busyPct·cpuPctFromJiffies)이 **같은 경계**를 쓴다 — 한 행 안에서 CPU 만 긴 공백의 평균을
 * 내고 디스크·네트워크는 비우는 어긋남(v2.731 A2-04)을 막는다.
 */
export function spanOk(prevAt, curAt) {
  const pa = fin(prevAt); const ca = fin(curAt);
  if (pa == null || ca == null) return false;
  const span = ca - pa;
  return span >= MIN_SPAN_MS && span <= MAX_SPAN_MS;
}

/**
 * 누적값 두 개의 초당 증가량.
 * @returns {number|null} `null` = 판정 보류(첫 표본 · 리셋 · 간격 비정상)
 */
export function perSecond(prevVal, curVal, prevAt, curAt) {
  const p = fin(prevVal); const c = fin(curVal);
  if (p == null || c == null || !spanOk(prevAt, curAt)) return null;
  const span = fin(curAt) - fin(prevAt);
  const d = c - p;
  if (d < 0) return null;                    // 리셋 — 0 으로 채우지 않는다
  return (d / span) * 1000;
}

/**
 * 두 누적 시간 묶음에서 CPU 사용률(%).
 * `/proc/stat` 의 `cpu` 줄은 **jiffies 누적**이라 (전체증가 − idle증가) / 전체증가 다.
 *
 * ⚠ v2.731 A2-04: 표본 시각을 가진 호출부는 **prevAt·curAt 를 반드시 넘긴다** — 간격이 MIN~MAX_SPAN 밖이면 `null`
 *   (perSecond·busyPct 와 같은 경계). jiffies 비율은 간격으로 나누지 않아 값 자체는 '공백 구간 평균' 이지만, 몇 시간~하루 공백 뒤
 *   첫 표본이 그 평균을 **이번 주기 값처럼** 원시·일 롤업·임계 판정에 넣었다(같은 행의 디스크·네트워크는 null 인데 CPU 만 값).
 *   시각 인자를 아예 넘기지 않는 호출(둘 다 undefined — 단위 테스트·시각 없는 옛 호출)만 간격 판정을 하지 않는다.
 * @param {{total:number, idle:number}} prev
 * @param {{total:number, idle:number}} cur
 * @param {number|null} [prevAt]
 * @param {number|null} [curAt]
 */
export function cpuPctFromJiffies(prev, cur, prevAt, curAt) {
  if ((prevAt !== undefined || curAt !== undefined) && !spanOk(prevAt, curAt)) return null;
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
  // v2.612(COL2612-01): 100% 초과는 클램프하지 않고 null(링크 속도·카운터가 어긋난 값 — '포화' 로 보정하지 않는다. v2.578 D3).
  const p = Math.round(((b * 8) / l) * 1000) / 10;
  return p > 100 ? null : p;
}

/**
 * 디스크 사용 시간 기반 사용률(%). `/proc/diskstats` 10번째 필드(`io_ticks`, ms)는 **I/O 중이던 시간**
 * 누적이라 (증가 ms / 경과 ms) × 100 이 곧 busy% 다(iostat 의 `%util` 과 같은 계산).
 */
export function busyPct(prevTicksMs, curTicksMs, prevAt, curAt) {
  const p = fin(prevTicksMs); const c = fin(curTicksMs);
  if (p == null || c == null || !spanOk(prevAt, curAt)) return null;
  const span = fin(curAt) - fin(prevAt);
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

/**
 * v2.590 F9: 전이중 회선(이더넷·FC)의 사용률은 **방향별**이다 — 방향마다 링크 속도만큼 쓸 수 있으므로 rx+tx 합을
 * 한 방향 속도로 나누면 최대 2배로 부푼다(각 방향 48% 가 96%, 양방향 60% 가 '포화 100%' 로 클램프됐다).
 * sar·nicstat 의 전이중 계산처럼 max(rx, tx) 를 쓴다. 한쪽이라도 모르면 null(합과 같은 엄격 규칙).
 */
export function maxStrict(list = []) {
  if (!list.length || list.some((v) => v == null || !Number.isFinite(Number(v)))) return null;
  return Math.max(...list.map(Number));
}
