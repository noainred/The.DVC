/**
 * storage/growth.js — 스토리지 증가량 계산(순수 · v2.531).
 *
 * 사용자 요청(2026-09-16): "전체 스토리지를 보여주고 기간별로 스토리지 용량이 얼마나 증가하고
 * 있는지 매트릭스 형태로" · "장비별로 스토리지 사용량 증가를 기록해서 1일, 1주, 1달, 3개월 등
 * 지정한 기간으로 증가량을 볼 수 있게" · "증가 단위는 1기가 단위/1TB 단위로 구분".
 *
 * ── 이 모듈이 지키는 정직성 규칙(전부 테스트로 고정한다) ──────────────────────────
 *  ① **기준선이 없으면 `null` 이다.** 30일 증가량을 묻는데 관측이 10일치뿐이면 '10일치 증가량'
 *     을 30일 증가량인 척 내놓지 않는다. 대신 `reason:'no-baseline'` 과 **가진 첫 관측일**을
 *     함께 준다 — 화면이 "관측 10일 — 30일 비교는 N일 뒤부터" 라고 말할 수 있게.
 *  ② **요청한 기간과 실제 비교 구간이 다를 수 있다.** 그 날 수집이 없었으면 그보다 앞선 가장
 *     가까운 날을 쓴다. 그때 `exact:false` 와 **실제 구간(`spanDays`)** 을 반드시 함께 낸다.
 *     이것을 숨기면 '31일 증가량' 이 '30일 증가량' 으로 보고된다.
 *  ③ **합계는 기준선이 있는 장비만 더하고, 뺀 장비 수를 밝힌다**(`missing`). 일부만 더한 값을
 *     '전체' 라고 말하는 것이 이 기능이 만들 수 있는 최악의 거짓이다.
 *  ④ **감소(−)를 0 으로 깎지 않는다.** 데이터 삭제·풀 축소는 실제로 일어나고, 그것을 숨기면
 *     증가 추세가 실제보다 커 보인다.
 *  ⑤ **소진 예상일은 '증가 중이고 전체 용량을 아는' 장비에만** 낸다. 그 밖에는 `null` 이다
 *     (추세가 평평하거나 줄고 있으면 '언젠가 참' 이지 예측이 아니다).
 *
 * 입력은 `db.js dailySeries()` 의 행 그대로다 — `{device_id, day, total_bytes, used_bytes, samples, ...}`.
 */
import { numOrNull } from '../util/numOrNull.js';

/** 화면 기본 기간(사용자 예시 "1일, 1주, 1달, 3개월 등"). `days` 가 계약이고 key 는 화면용. */
export const DEFAULT_PERIODS = Object.freeze([
  { key: '1d', days: 1, label: '1일' },
  { key: '7d', days: 7, label: '1주' },
  { key: '30d', days: 30, label: '1개월' },
  { key: '90d', days: 90, label: '3개월' },
  { key: '180d', days: 180, label: '6개월' },
  { key: '365d', days: 365, label: '1년' },
]);

const MAX_PERIODS = 12;          // 표 열 수 상한 — 넘치면 화면이 가로로 깨진다
const MAX_PERIOD_DAYS = 3650;    // 10년. 보존 상한(5년)보다 크게 두어 사용자가 물어볼 수는 있게 한다

/**
 * 기간 목록 정규화(순수). 사용자가 임의 일수를 넣을 수 있으므로 여기서 한 번에 거른다.
 * 알아볼 수 없는 값은 **조용히 버리지 않고** 제외 개수를 함께 돌려준다.
 */
export function normalizePeriods(input) {
  if (!input) return { periods: DEFAULT_PERIODS.slice(), dropped: 0 };
  const raw = Array.isArray(input) ? input : String(input).split(',');
  const out = [];
  let dropped = 0;
  for (const item of raw) {
    const days = Math.floor(Number(typeof item === 'object' ? item?.days : String(item).replace(/d$/i, '')));
    if (!Number.isFinite(days) || days < 1 || days > MAX_PERIOD_DAYS) { dropped += 1; continue; }
    if (out.some((p) => p.days === days)) continue;      // 중복은 조용히 합쳐도 정보 손실이 없다
    out.push({ key: `${days}d`, days, label: labelForDays(days) });
    if (out.length >= MAX_PERIODS) break;
  }
  if (!out.length) return { periods: DEFAULT_PERIODS.slice(), dropped };
  out.sort((a, b) => a.days - b.days);
  return { periods: out, dropped };
}

/** 일수 → 사람이 쓰는 이름. 딱 떨어지지 않으면 'N일' 로 둔다(억지로 '약 1개월' 이라 하지 않는다). */
export function labelForDays(days) {
  const exact = { 1: '1일', 7: '1주', 14: '2주', 30: '1개월', 60: '2개월', 90: '3개월',
    180: '6개월', 365: '1년', 730: '2년', 1095: '3년', 1825: '5년' };
  return exact[days] || `${days}일`;
}

/** 행 배열 → 장비별 {day → row} · 정렬된 day 목록. */
function byDevice(rows) {
  const m = new Map();
  for (const r of rows || []) {
    const id = r.device_id;
    if (!id) continue;
    if (!m.has(id)) m.set(id, { days: [], map: new Map() });
    const e = m.get(id);
    if (!e.map.has(r.day)) e.days.push(r.day);
    e.map.set(r.day, r);
  }
  for (const e of m.values()) e.days.sort((a, b) => a - b);
  return m;
}

/** day 이하에서 가장 큰 관측일(이분 탐색). 없으면 null. */
function floorDay(days, day) {
  let lo = 0; let hi = days.length - 1; let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid] <= day) { best = days[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// v2.561: 판정은 util/numOrNull.js 하나 — 이 지역 사본은 빈 문자열을 0 으로 읽었다.

/**
 * 한 장비의 한 기간 증가량.
 * @returns {{bytes:number|null, reason?:string, baselineDay?:number, spanDays?:number,
 *            exact?:boolean, perDayBytes?:number|null}}
 */
export function growthFor(entry, latestDay, days) {
  const latest = entry.map.get(latestDay);
  const latestUsed = numOrNull(latest?.used_bytes);
  if (latestUsed == null) return { bytes: null, reason: 'no-latest-used' };

  const target = latestDay - days;
  const bDay = floorDay(entry.days, target);
  if (bDay == null) {
    // ⚠ 기준선 이전 값을 소급해 만들지 않는다(vmtrack v2.351 '+2만 TB' 오표시와 같은 계열).
    return { bytes: null, reason: 'no-baseline', firstDay: entry.days[0] ?? null };
  }
  const baseUsed = numOrNull(entry.map.get(bDay)?.used_bytes);
  if (baseUsed == null) return { bytes: null, reason: 'no-baseline-used', baselineDay: bDay };

  const spanDays = latestDay - bDay;
  return {
    bytes: latestUsed - baseUsed,
    baselineDay: bDay,
    spanDays,
    exact: bDay === target,
    // 하루 0일 구간(같은 날)은 비율을 만들 수 없다 — 0 으로 나누지 않고 null 이다.
    perDayBytes: spanDays > 0 ? (latestUsed - baseUsed) / spanDays : null,
  };
}

/**
 * 증가량 매트릭스(장비 × 기간).
 *
 * @param {object[]} rows  `dailySeries()` 행(여러 장비 혼합 가능)
 * @param {object}   opts
 * @param {object[]} opts.periods  `normalizePeriods()` 결과
 * @param {number}   opts.asOfDay  '오늘'의 일 인덱스(테스트가 고정할 수 있게 주입받는다)
 * @param {Map|object} [opts.meta] deviceId → {name, type, host, datacenterId} 표시용
 * @returns {{devices:object[], totals:object, periods:object[], asOfDay:number}}
 */
export function growthMatrix(rows, { periods = DEFAULT_PERIODS, asOfDay, meta = null } = {}) {
  const per = periods.length ? periods : DEFAULT_PERIODS;
  const grouped = byDevice(rows);
  const asOf = Number.isFinite(Number(asOfDay)) ? Number(asOfDay) : null;
  const metaOf = (id) => (meta instanceof Map ? meta.get(id) : meta?.[id]) || {};

  const devices = [];
  for (const [id, entry] of grouped) {
    // 그 장비의 '최신' 은 asOfDay 이하의 마지막 관측이다 — 미래 날짜 행을 최신으로 삼지 않는다.
    const latestDay = asOf == null ? entry.days[entry.days.length - 1] : floorDay(entry.days, asOf);
    if (latestDay == null) continue;
    const latest = entry.map.get(latestDay);
    const usedBytes = numOrNull(latest.used_bytes);
    const totalBytes = numOrNull(latest.total_bytes);
    const growth = {};
    for (const p of per) growth[p.key] = growthFor(entry, latestDay, p.days);

    devices.push({
      deviceId: id,
      name: metaOf(id).name || id,
      type: metaOf(id).type || '',
      host: metaOf(id).host || '',
      datacenterId: metaOf(id).datacenterId || '',
      latestDay,
      latestTs: numOrNull(latest.last_ts),
      usedBytes,
      totalBytes,
      freeBytes: totalBytes != null && usedBytes != null ? Math.max(0, totalBytes - usedBytes) : null,
      pct: totalBytes && usedBytes != null ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
      observedDays: entry.days.length,
      firstDay: entry.days[0] ?? null,
      // 관측이 하루라도 비면 그 사실을 밝힌다 — '매일 있었다' 고 가정하지 않는다.
      spanDays: latestDay - (entry.days[0] ?? latestDay),
      growth,
      // 소진 예상(규칙 ⑤) — 증가 중 + 전체 용량을 알 때만.
      daysToFull: daysToFullFor(totalBytes, usedBytes, growth, per),
    });
  }
  devices.sort((a, b) => (b.usedBytes ?? -1) - (a.usedBytes ?? -1) || String(a.name).localeCompare(String(b.name), 'ko'));

  return { devices, totals: totalsOf(devices, per), periods: per, asOfDay: asOf };
}

/**
 * 합계 행(규칙 ③) — 기준선이 있는 장비만 더하고 **뺀 장비 수를 밝힌다**.
 * `measured` 는 그 기간에 실제로 더해진 장비 수, `missing` 은 기준선이 없어 못 더한 수다.
 */
export function totalsOf(devices, periods) {
  const usedBytes = sumOrNull(devices.map((d) => d.usedBytes));
  const totalBytes = sumOrNull(devices.map((d) => d.totalBytes));
  const growth = {};
  for (const p of periods) {
    let sum = 0; let measured = 0; let missing = 0;
    for (const d of devices) {
      const g = d.growth[p.key];
      if (g && g.bytes != null) { sum += g.bytes; measured += 1; } else missing += 1;
    }
    growth[p.key] = {
      bytes: measured ? sum : null,
      measured,
      missing,
      // 일부만 더했으면 '전체' 라고 말하지 못하게 화면이 쓸 플래그.
      partial: measured > 0 && missing > 0,
      perDayBytes: measured && p.days > 0 ? sum / p.days : null,
    };
  }
  return {
    devices: devices.length,
    usedBytes,
    totalBytes,
    freeBytes: totalBytes != null && usedBytes != null ? Math.max(0, totalBytes - usedBytes) : null,
    pct: totalBytes && usedBytes != null ? Math.round((usedBytes / totalBytes) * 1000) / 10 : null,
    // 수치를 못 읽은 장비 수 — 합계가 '전 장비' 인지 화면이 판단하는 근거.
    unknownUsed: devices.filter((d) => d.usedBytes == null).length,
    growth,
  };
}

/** 하나라도 값이 있으면 합, 전부 null 이면 null(0 은 '용량 0' 이라는 거짓이 된다). */
function sumOrNull(list) {
  const nums = list.filter((v) => v != null && Number.isFinite(v));
  return nums.length ? nums.reduce((a, b) => a + b, 0) : null;
}

/**
 * 소진 예상 일수 — **30일 추세**를 우선하고 없으면 더 짧은 기간을 쓴다.
 * 짧은 기간(1일)만으로 5년을 예측하지 않도록 **쓴 기간을 함께 돌려준다**(`basis`).
 */
export function daysToFullFor(totalBytes, usedBytes, growth, periods) {
  if (totalBytes == null || usedBytes == null || totalBytes <= 0) return null;
  const prefer = [30, 90, 7, 180, 365, 1];
  const ordered = [...periods].sort((a, b) => {
    const ia = prefer.indexOf(a.days); const ib = prefer.indexOf(b.days);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const p of ordered) {
    const g = growth[p.key];
    // 증가 중일 때만 예측한다 — 평평하거나 줄고 있으면 '언젠가' 이지 예측이 아니다.
    if (!g || g.perDayBytes == null || g.perDayBytes <= 0) continue;
    const free = totalBytes - usedBytes;
    if (free <= 0) return { days: 0, basis: p.key, basisLabel: p.label };
    return { days: Math.round(free / g.perDayBytes), basis: p.key, basisLabel: p.label };
  }
  return null;
}
