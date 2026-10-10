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
 *     v2.733(C2-03): 기준선이 있어도 실제 구간이 요청 기간보다 크게 길면(GROWTH_SPAN_TOLERANCE 밖) 합계에서 빼고
 *     `inexact` 로 센다 — 장비 행의 정직한 `exact:false` 를 합계가 무시하고 더하면 1개월 합계에 1년치가 섞인다.
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

/**
 * v2.681(R2D-03): 마지막 관측이 이보다 오래된 장비는 함대 합계('지금' 사용량·용량·증가량)에서 뺀다.
 *   7일인 이유 — 일 롤업이라 하루·이틀 빈 것(엣지 회선·인증 정지 같은 일시 장애)은 흔하고 용량은 완만히 변하므로
 *   마지막 값을 '최근에 아는 값' 으로 둘 수 있다. 일주일(화면 기간 '1주')을 넘게 한 번도 수집되지 않은 장비의 값은
 *   '지금' 이라 말할 근거가 없다. 장비 행에는 `stale:true` 로 남고 합계는 `staleDevices` 로 밝힌다(조용히 빼지 않는다).
 */
export const GROWTH_STALE_DAYS = 7;

/**
 * v2.733(C2-03): 합계에 넣는 비교 구간의 상한 — **요청 일수 × 1.1(내림)**.
 *
 *   장비 행은 요청한 날짜에 수집이 없으면 그 이전 가장 가까운 날과 비교하고 `exact:false`·실제 `spanDays` 를 밝힌다(규칙 ②).
 *   그 값을 합계에 그대로 더하면 '1개월 증가' 합계에 1년치 증가가 섞인다(재현: 30일 합계 322TB, 정답 약 30TB · partial:false).
 *   그래서 실제 구간이 이 한계를 넘는 장비는 **합계에서 빼고 `inexact` 로 센다**(장비 행에는 값이 그대로 있다 — 조용히 빼지 않는다).
 *
 *   1.1 인 이유 — 증가가 고르다고 보면 구간 S 일의 증가는 요청 N 일 증가의 S/N 배다. '1개월(30일)' 이라는 이름 자체가 달력의 한 달
 *   (28~31일, −7%~+3%)과 그만큼 어긋나므로, 10% 이내의 구간 차이는 보고서 독자가 이미 받아들이는 오차와 같은 크기다. 그보다 길면
 *   그 장비가 합계를 과장하는 몫이 이름의 오차보다 커진다. 그 결과 1일·1주는 **하루 공백도 뺀다**(1일→2일은 2배, 7일→8일은 +14%)
 *   — 그 날 수집이 실제로 없었다는 뜻이므로 '일부만 합산' 으로 말하는 것이 맞다. 1개월은 사흘(33일)까지, 1년은 36일(401일)까지 더한다.
 *   한계 안이지만 요청보다 긴 구간으로 더한 장비는 `widened` 로 센다(합계 칸 설명이 말한다).
 *   ⚠ 웹 `views/tools/storageGrowthText.js` 에 같은 상수·함수가 있다(번들 경계) — 테스트가 두 벌을 대조한다. 한쪽만 바꾸지 말 것.
 */
export const GROWTH_SPAN_TOLERANCE = 1.1;

/** 그 기간 합계에 넣을 수 있는 가장 긴 실제 구간(일). 기간이 1일 미만·숫자가 아니면 null. */
export function maxSpanDaysFor(days) {
  const d = numOrNull(days);
  if (d == null || d < 1) return null;
  // 부동소수 보정(30 × 1.1 = 33.000000000000004) — 경계 값이 실행 환경마다 갈리지 않게 정수로 내린다.
  return Math.floor(d * GROWTH_SPAN_TOLERANCE + 1e-9);
}

/**
 * 장비 한 칸을 그 기간 합계에 더할 수 있는가 — 'in'(요청 구간 그대로) | 'widened'(한계 안의 더 긴 구간) | 'inexact'(한계 밖 — 합계에서 뺀다).
 * 실제 구간(spanDays)을 모르면 판정하지 않는다('in') — 지어내지 않는다(구버전 응답 호환).
 */
function spanClassOf(g, days) {
  const span = numOrNull(g?.spanDays);
  const lim = maxSpanDaysFor(days);
  if (span == null || lim == null) return 'in';
  if (span > lim) return 'inexact';
  return span > days ? 'widened' : 'in';
}

const MAX_PERIODS = 12;         // 표 열 수 상한 — 넘치면 화면이 가로로 깨진다
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
 * @param {Map|object} [opts.meta] deviceId → {name, type, host, datacenterId, capacityApprox?} 표시용
 *   (capacityApprox = 스냅샷 extra.capacityApprox — 반올림 표기 장비의 해상도. v2.604)
 * @returns {{devices:object[], totals:object, periods:object[], asOfDay:number}}
 */
export function growthMatrix(rows, { periods = DEFAULT_PERIODS, asOfDay, meta = null, knownIds = null, staleDays = GROWTH_STALE_DAYS } = {}) {
  const per = periods.length ? periods : DEFAULT_PERIODS;
  const grouped = byDevice(rows);
  const asOf = numOrNull(asOfDay);   // v2.576: 코어는 하나다(빈 문자열·배열이 0 = '1970년 1월 1일' 로 둔갑하지 않게)
  const metaOf = (id) => (meta instanceof Map ? meta.get(id) : meta?.[id]) || {};
  // v2.681(R2D-03): knownIds(현재 등록부 id)가 주어지면 그 밖의 장비는 퇴역(retired) — 옛 이력만 남은 장비다.
  const known = knownIds == null ? null : new Set([...(knownIds instanceof Set ? knownIds : Array.isArray(knownIds) ? knownIds : [])].map(String));
  const sd = numOrNull(staleDays);
  const staleLimit = sd != null && sd >= 0 ? sd : GROWTH_STALE_DAYS;

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
    /*
     * v2.604(감사 COL-2604-01 후속): 용량이 **반올림 표기**(예: Isilon SSH 'isi status' 의 '5.0P')로 적재된 장비는
     *   증가량이 해상도(0.1 PiB 등) 계단으로만 움직인다. 적재는 막지 않고(이력 소실이 더 나쁘다) 해상도를 싣는다 —
     *   해상도 미만의 변화는 **0 이 아니라 '보이지 않는 것'** 이다(belowResolution). 판정은 여기 하나, 문장은 웹.
     *   ⚠ 판정은 '반 칸 미만' 이다 — 반올림 값의 차이는 칸의 배수라 실제로는 0 이지만, 부동소수(1.2P−1.1P = 0.0999…P)가
     *   한 칸 차이를 '해상도 미만' 으로 뒤집지 않게 한다.
     */
    const res = numOrNull(metaOf(id).capacityApprox?.resolutionBytes);
    // v2.605(RECENT2605-03): mixed = 최신은 정확 값이지만 이력에 반올림 주기가 섞였다 — 해상도 표지를 유지한다.
    const approx = res != null && res > 0 ? { resolutionBytes: res, ...(metaOf(id).capacityApprox?.mixed === true ? { mixed: true } : {}) } : null;
    if (approx) {
      // v2.606(RECENT2606-01): mixed(최신은 정확 값, 이력에 반올림 주기가 섞임)는 **가리지 않는다** — 양끝이 정확 값인
      //   칸까지 '±해상도 미만' 으로 숨겨 1일·7일 증가량이 사라졌다. 칸별 반올림 여부는 capacity_daily 에 없으므로
      //   해상도는 싣되(각주·표지) belowResolution 은 전부 반올림 표기인 장비에서만 판정한다.
      const mixed = approx.mixed === true;
      for (const k of Object.keys(growth)) {
        const g = growth[k];
        if (g && g.bytes != null) {
          growth[k] = mixed
            ? { ...g, resolutionBytes: res, mixed: true, belowResolution: false }
            : { ...g, resolutionBytes: res, belowResolution: Math.abs(g.bytes) < res / 2 };
        }
      }
    }

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
      ...(approx ? { capacityApprox: approx } : {}),
      // v2.681(R2D-03): 합계에서 뺀 이유 — 행은 남긴다(이력·증가량은 그 장비 기준으로 여전히 볼 수 있다).
      ...(asOf != null && asOf - latestDay > staleLimit ? { stale: true, staleDays: asOf - latestDay } : {}),
      ...(known && !known.has(String(id)) ? { retired: true } : {}),
    });
  }
  devices.sort((a, b) => (b.usedBytes ?? -1) - (a.usedBytes ?? -1) || String(a.name).localeCompare(String(b.name), 'ko'));

  return { devices, totals: totalsOf(devices, per, { asOfDay: asOf, staleDays: staleLimit }), periods: per, asOfDay: asOf };
}

/**
 * 합계 행(규칙 ③) — 기준선이 있는 장비만 더하고 **뺀 장비 수를 밝힌다**.
 * `measured` 는 그 기간에 실제로 더해진 장비 수, `missing` 은 못 더한 수 전체다(measured + missing = 합계 기준 장비 수).
 * 못 더한 사유 중 `lagging`(최신 관측이 늦음)·`inexact`(v2.733 — 실제 구간이 요청 기간의 GROWTH_SPAN_TOLERANCE 배 초과)는
 * 따로 센다. 나머지는 기준선(또는 사용량) 없음이다. `widened` 는 한계 안이지만 요청보다 긴 구간으로 **더한** 장비 수다.
 * ⚠ 웹 `aggregateGrowth` 가 같은 규칙을 다시 구현한다(필터 뒤 부분집합) — 바꾸면 양쪽을 같이(테스트가 대조한다).
 */
export function totalsOf(allDevices, periods, { asOfDay = null, staleDays = GROWTH_STALE_DAYS } = {}) {
  // v2.681(R2D-03): 퇴역(등록부에 없음)·장기 미관측(stale) 장비의 마지막 값은 '지금' 이 아니다 — 합계에서 빼고 센다.
  const all = Array.isArray(allDevices) ? allDevices : [];
  const devices = all.filter((d) => !d.stale && !d.retired);
  const staleDevices = all.filter((d) => d.stale && !d.retired).length;
  const retiredDevices = all.filter((d) => d.retired).length;
  const asOf = numOrNull(asOfDay);
  const usedBytes = sumOrNull(devices.map((d) => d.usedBytes));
  const totalBytes = sumOrNull(devices.map((d) => d.totalBytes));
  // v2.681(R2D-02): 사용률·남은 용량은 **사용량을 읽은 장비끼리만** 계산한다(v2.594 capacityTotals 규약).
  //   사용량 미상 장비의 전체 용량을 분모에 넣으면 사용률은 과소, 남은 용량은 과대가 된다(재현: 50/100 + ?/100 → 25%·150).
  //   totalBytes(표시 총용량)는 그대로 두고 측정 분모를 totalBytesMeasured 로 따로 싣는다.
  const totalBytesMeasured = sumOrNull(devices.filter((d) => d.usedBytes != null).map((d) => d.totalBytes));
  const growth = {};
  for (const p of periods) {
    let sum = 0; let measured = 0; let missing = 0; let lagging = 0; let inexact = 0; let widened = 0;
    let perDay = 0; let perDayN = 0;
    for (const d of devices) {
      const g = d.growth[p.key];
      // v2.681(R2D-03): 최신 관측이 어제보다 오래된 장비의 증가량은 '이 기간' 이 아니라 그 장비의 옛 날짜 기준이다 —
      //   오늘 기준 함대 증가량에 더하지 않는다(못 더한 수로 센다). 하루 차이는 오늘 행이 아직 없는 정상 상태다.
      if (asOf != null && asOf - d.latestDay > 1) { missing += 1; lagging += 1; continue; }
      if (!g || g.bytes == null) { missing += 1; continue; }
      // v2.733(C2-03): 실제 비교 구간이 요청 기간보다 크게 길면(GROWTH_SPAN_TOLERANCE 밖) 이 기간 합계에 넣지 않는다 —
      //   못 더한 수(missing)로 세고 그 사유를 inexact 로 밝힌다(lagging 과 같은 모양).
      const cls = spanClassOf(g, p.days);
      if (cls === 'inexact') { missing += 1; inexact += 1; continue; }
      if (cls === 'widened') widened += 1;
      sum += g.bytes; measured += 1;
      const pd = numOrNull(g.perDayBytes);
      if (pd != null) { perDay += pd; perDayN += 1; }
    }
    growth[p.key] = {
      bytes: measured ? sum : null,
      measured,
      missing,
      // 일부만 더했으면 '전체' 라고 말하지 못하게 화면이 쓸 플래그.
      partial: measured > 0 && missing > 0,
      // v2.733(C2-03): 하루 증가량은 **장비별 perDayBytes 의 합**이다 — 합계 ÷ 요청 일수는 더 긴 구간으로 비교한 장비(widened)를
      //   부풀린다. 더한 장비 중 하루 증가량을 모르는 장비가 있으면 부분 합을 내지 않고 null 이다.
      perDayBytes: measured && perDayN === measured ? perDay : null,
      // 이 기간 합계에 넣을 수 있는 가장 긴 실제 구간(일) — 화면·공개 API 가 기준을 말할 때 쓴다(숫자를 박지 않게).
      maxSpanDays: maxSpanDaysFor(p.days),
      ...(lagging ? { lagging } : {}),
      ...(inexact ? { inexact } : {}),
      ...(widened ? { widened } : {}),
    };
  }
  return {
    devices: devices.length,
    usedBytes,
    totalBytes,
    totalBytesMeasured,
    freeBytes: totalBytesMeasured != null && usedBytes != null ? Math.max(0, totalBytesMeasured - usedBytes) : null,
    pct: totalBytesMeasured && usedBytes != null ? Math.round((usedBytes / totalBytesMeasured) * 1000) / 10 : null,
    // v2.681: 합계에서 뺀 장비 — 퇴역(등록부에 없음)·마지막 관측이 GROWTH_STALE_DAYS 넘게 지난 장비.
    staleDevices,
    retiredDevices,
    staleDaysLimit: staleDays,
    // 등록부·관측 기준과 무관한 전체 행 수(예전 devices 와 같은 뜻이 필요할 때).
    devicesListed: all.length,
    // 수치를 못 읽은 장비 수 — 합계가 '전 장비' 인지 화면이 판단하는 근거.
    unknownUsed: devices.filter((d) => d.usedBytes == null).length,
    // v2.604: 반올림 표기 용량 장비 수 — 합계에 그 해상도만큼의 불확실성이 섞였음을 화면이 밝히는 근거.
    approxDevices: devices.filter((d) => d.capacityApprox).length,
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
