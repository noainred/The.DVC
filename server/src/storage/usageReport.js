/**
 * storage/usageReport.js — 스토리지 **사용량 보고표**(일간·주간·월간) 순수 규칙(v2.789). 파일·DB·타이머 없음.
 *
 * 사용자 요청(2026-10-26): "스토리지 사용량을 일간/주간 별로 이렇게 정리해서 보는 기능" + 엑셀 캡처
 *   (행 = 날짜 2026-09-28 · 10-05 · 10-12 … / 열 = 법인 › 장비 › Total Usable · Used · Percent, Unity 아래 LUN·파일시스템).
 *   "표 형식으로 보는 것을 기본 · CSV export · 법인별/같은 종류 스토리지별 비교" + "지정한 시간에 전체 사용량을 이메일로".
 *
 * ── 기간(행)의 뜻 — '그 날 기준 값'(as of) ────────────────────────────────────
 *  · 일간: 그 날의 관측(일 롤업의 마지막 관측)만. 그 날 수집이 없으면 **빈 칸**이다 — 앞날 값을 끌어오지 않는다.
 *  · 주간: 기준 요일(기본 월요일 — 캡처의 날짜가 전부 월요일이다)의 값. 그 날 수집이 없으면 **직전 6일 안의 가장 늦은 관측**을 쓰고
 *    `exact:false` + 실제 관측일을 싣는다(화면이 '≈ 10-17 관측' 으로 밝힌다 — 증가량 화면 v2.531 의 '이전 가장 가까운 날' 규칙과 같다).
 *  · 월간: 그 달 마지막 날(이번 달은 오늘)의 값. 그 달 안의 가장 늦은 관측을 쓰고 같은 방식으로 밝힌다.
 *  · 기준 시각의 날 경계는 일 롤업과 같은 포탈 시각(기본 한국 시각 — `util/dayKey.js`). 일 인덱스 d 의 날짜는 `new Date(d·86400000)` 의 UTC 날짜다.
 *
 * ── 합계(법인별·종류별·전체)의 정직성 — 증가량 화면(growth.js)과 같은 규칙 ─────────────
 *  · **크기와 사용량을 둘 다 읽은 장비만** 더한다(`counted`). 값이 없는 장비·사용량만 못 읽은 장비는 **따로 센다**(missing·usedUnknown).
 *  · 그 시점에 값이 있어야 할 장비(`expected` — 이력이 그 전에 시작됐고 꺼지지 않은 장비) 중 하나라도 빠지면 `partial:true` 다.
 *    화면은 부분 합에 표지를 달고, 추이 선은 그 점을 끊는다(부분 합을 추이로 그리지 않는다 — CLAUDE.md '부분 합은 추이에 적재하지 않는다').
 *  · 사용률(%)은 합계끼리 나눈다(장비 사용률의 평균이 아니다 — 큰 장비와 작은 장비를 같게 세지 않는다).
 *
 * 웹 `views/tools/storageUsageText.js` 가 `aggregateCells`·`deltaOf` 의 사본을 갖는다(번들 경계) — 웹 테스트가 같은 입력으로 대조한다.
 */
import { numOrNull } from '../util/numOrNull.js';

const DAY_MS = 86_400_000;

/**
 * 단위별 기간 수(기본·상한). 상한은 조회 행 수를 묶는다(장비 79대 × 주간 104 ≈ 5.7만 일 롤업 행). 화면은 이 값으로 고른다(숫자를 박지 않는다).
 * `allMax` — '전체 누적'(v2.791, 사용자 요청 "누적된 모든 주간 사용량 … 2026년 1주차, 2주차…")의 상한. 일 롤업 보존 기본값(5년 —
 *   `db.js DAILY_KEEP_DAYS_DEF`)을 덮는 주·달 수다. 일간에는 없다(5년 × 장비 수의 칸을 한 화면에 깔지 않는다).
 */
export const GRANS = Object.freeze({
  daily: Object.freeze({ label: '일간', def: 14, max: 92 }),
  weekly: Object.freeze({ label: '주간', def: 8, max: 104, allMax: 262 }),
  monthly: Object.freeze({ label: '월간', def: 12, max: 36, allMax: 61 }),
});
export const WEEKDAY_DEF = 1;   // 월요일(0 = 일요일) — 캡처의 날짜 기준
export const WEEKDAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);

/**
 * 요청 쿼리 → {gran, count, weekday, all}. 모르는 값은 기본값(읽기 경로 — 화면 선택지 밖 값으로 400 을 주지 않는다).
 * `count: 'all'` = 전체 누적(그 단위에 `allMax` 가 있을 때만) — 실제 기간 수는 이력 시작일을 아는 호출부가 `countForAll` 로 정한다.
 * 그 전까지 `count` 는 기본값이다(이력을 모르면 기본 기간 수로 보인다 — 0 행 표를 만들지 않는다).
 */
export function normalizeReportQuery(q = {}) {
  const gran = Object.hasOwn(GRANS, String(q.gran || '')) ? String(q.gran) : 'weekly';
  const g = GRANS[gran];
  const all = String(q.count ?? '') === 'all' && !!g.allMax;
  const n = numOrNull(q.count);
  const top = all ? g.allMax : g.max;
  const count = n != null && Number.isInteger(n) && n >= 1 ? Math.min(n, top) : g.def;
  const w = numOrNull(q.weekday);
  const weekday = w != null && Number.isInteger(w) && w >= 0 && w <= 6 ? w : WEEKDAY_DEF;
  return { gran, count, weekday, all };
}

/** 일 인덱스의 요일(0 = 일요일). 일 0 = 1970-01-01(목요일). */
export const weekdayOf = (day) => (((Number(day) + 4) % 7) + 7) % 7;
/** 일 인덱스 → 'YYYY-MM-DD'. */
export const labelOfDay = (day) => new Date(Number(day) * DAY_MS).toISOString().slice(0, 10);
const dayOfYmd = (y, m0, d) => Math.floor(Date.UTC(y, m0, d) / DAY_MS);

/**
 * ISO 8601 주차(v2.791 — 사용자 선택 'ISO 8601'): 월요일 시작, 그 해 첫 목요일이 든 주가 1주차. 엑셀 `ISOWEEKNUM` 과 같은 번호다.
 * 연도는 **그 주 목요일의 연도**다 — 2025-12-29(월)은 2026년 1주차, 2027-01-01(금)은 2026년 53주차.
 * @returns {{year:number, week:number}}
 */
export function isoWeekOf(day) {
  const d = Math.floor(Number(day));
  const wd = weekdayOf(d) || 7;            // 월 = 1 … 일 = 7
  const thu = d - wd + 4;
  const year = new Date(thu * DAY_MS).getUTCFullYear();
  return { year, week: Math.floor((thu - dayOfYmd(year, 0, 1)) / 7) + 1 };
}
/** '2026-W44'(정렬용 키) · '2026년 44주차'(읽기용). */
export const isoWeekKey = (day) => { const { year, week } = isoWeekOf(day); return `${year}-W${String(week).padStart(2, '0')}`; };
export const isoWeekLabel = (day) => { const { year, week } = isoWeekOf(day); return `${year}년 ${week}주차`; };

/**
 * '전체 누적' 의 기간 수 — 가장 이른 이력(`firstDay`)이 든 기간부터 오늘 기간까지. 이력이 없으면 기본값, 상한은 `allMax`.
 * 주간 기간은 `[기준일 − 6, 기준일]` 이므로 firstDay 를 덮는 가장 이른 기준일까지 센다.
 */
export function countForAll({ gran = 'weekly', asOfDay, weekday = WEEKDAY_DEF, firstDay } = {}) {
  const g = GRANS[gran] || GRANS.weekly;
  const f = numOrNull(firstDay); const today = Math.floor(Number(asOfDay));
  if (!g.allMax || f == null || !Number.isFinite(today)) return g.def;
  let n;
  if (gran === 'weekly') {
    const anchor0 = today - ((weekdayOf(today) - weekday + 7) % 7);
    n = f > anchor0 ? 1 : Math.floor((anchor0 - f) / 7) + 1;
  } else {
    const a = new Date(today * DAY_MS); const b = new Date(Math.min(f, today) * DAY_MS);
    n = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth()) + 1;
  }
  return Math.max(1, Math.min(n, g.allMax));
}

/**
 * 기간 목록(오래된 것 → 최근). 각 기간 `{ key, label, day(기준일), fromDay, toDay, current? }`.
 * `current:true` = 아직 끝나지 않은 이번 달(월간) — 화면이 '오늘까지' 로 밝힌다.
 */
export function buildPeriods({ gran = 'weekly', asOfDay, count, weekday = WEEKDAY_DEF, all = false } = {}) {
  const q = normalizeReportQuery({ gran, count, weekday });
  // 전체 누적(v2.791): 호출부가 countForAll 로 정한 수를 allMax 까지 받는다 — 여기서 다시 max(104)로 자르면 2년 넘는 이력이 잘린다.
  const g = GRANS[q.gran];
  const n = numOrNull(count);
  if (all && g.allMax && n != null && Number.isInteger(n) && n >= 1) q.count = Math.min(n, g.allMax);
  const today = Math.floor(Number(asOfDay));
  if (!Number.isFinite(today)) return [];
  const out = [];
  if (q.gran === 'daily') {
    for (let k = q.count - 1; k >= 0; k--) {
      const d = today - k;
      out.push({ key: labelOfDay(d), label: labelOfDay(d), day: d, fromDay: d, toDay: d });
    }
  } else if (q.gran === 'weekly') {
    const anchor0 = today - ((weekdayOf(today) - q.weekday + 7) % 7);
    for (let k = q.count - 1; k >= 0; k--) {
      const a = anchor0 - 7 * k;
      // v2.791: 행 이름은 ISO 주차('2026년 44주차') — 기준일은 dayLabel 로 함께 싣는다(화면·엑셀이 '(10-26)' 로 붙인다).
      out.push({ key: labelOfDay(a), label: isoWeekLabel(a), isoKey: isoWeekKey(a), dayLabel: labelOfDay(a), day: a, fromDay: a - 6, toDay: a });
    }
  } else {
    const t = new Date(today * DAY_MS);
    const y0 = t.getUTCFullYear(); const m0 = t.getUTCMonth();
    for (let k = q.count - 1; k >= 0; k--) {
      const first = dayOfYmd(y0, m0 - k, 1);
      const last = dayOfYmd(y0, m0 - k + 1, 1) - 1;
      const toDay = Math.min(last, today);
      const lab = labelOfDay(first).slice(0, 7);
      out.push({ key: lab, label: lab, day: toDay, fromDay: first, toDay, ...(toDay < last ? { current: true } : {}) });
    }
  }
  return out;
}

const pctOf = (t, u) => (t != null && t > 0 && u != null ? Math.round((u / t) * 1000) / 10 : null);

/**
 * 한 계열(일 오름차순 `[{day,total,used}]`)에서 기간마다 값을 고른다 — 기간 안의 **가장 늦은 관측**.
 * @returns {(null|{day:number, exact:boolean, totalBytes:number|null, usedBytes:number|null, pct:number|null})[]}
 */
export function pickCells(series, periods) {
  const s = Array.isArray(series) ? series : [];
  return (periods || []).map((p) => {
    let best = null;
    // 계열은 짧다(장비당 기간 범위의 일수) — 기간마다 끝에서부터 찾는다.
    for (let i = s.length - 1; i >= 0; i--) {
      const d = s[i].day;
      if (d > p.toDay) continue;
      if (d < p.fromDay) break;
      best = s[i]; break;
    }
    if (!best) return null;
    const t = numOrNull(best.total); const u = numOrNull(best.used);
    if (t == null || t <= 0) return null;   // 크기를 못 읽은 행은 값이 아니다(일 롤업 가드가 이미 막지만 한 번 더)
    return { day: best.day, exact: best.day === p.toDay, totalBytes: t, usedBytes: u, pct: pctOf(t, u) };
  });
}

/**
 * 매체 풀 분리(v2.791 — 사용자 요청 "파워스케일/아이실론 스토리지는 HDD 풀과 SSD 풀 사용량을 분리해서 보여줘").
 * 일 롤업 `capacity_daily.hdd_* / ssd_*` 는 v2.303 부터 쌓였다(수집기 `snap.media` — 풀이 없으면 null, 0 이 아니다).
 *  · 두 풀 모두 그 범위에 관측이 있으면 `pools` 에 두 줄(HDD 풀·SSD 풀)을 싣는다.
 *  · 한 풀만 관측되면(올플래시 F800 = SSD 만, SSD 를 L3 캐시로만 쓰는 노드 = HDD 만) 풀 열을 만들지 않고 `poolNote` 로 밝힌다 —
 *    장비 전체와 같은 숫자를 한 번 더 깔지 않고, 없는 풀을 0 TB 로 그리지 않는다. SSD 가 L3 캐시인지 아예 없는지는 수집기가 모른다.
 *  · 매체 값이 한 번도 없으면(구버전 수집기·매체를 안 주는 경로) 아무것도 싣지 않는다 — 이유를 단정하지 않는다.
 * 풀 값은 장비 합계의 **부분**이다 — 법인·종류 합계(aggregateCells)에 더하지 않는다.
 */
export const POOL_TYPES = Object.freeze(['isilon']);
export const POOLS = Object.freeze([
  Object.freeze({ key: 'hdd', label: 'HDD 풀' }),
  Object.freeze({ key: 'ssd', label: 'SSD 풀' }),
]);
export const POOL_ONLY_NOTE = Object.freeze({ hdd: 'HDD 풀만', ssd: 'SSD 풀만' });

/** 장비 하나의 풀 계열 → {pools, poolNote}. series = 일 오름차순 [{day, hddT, hddU, ssdT, ssdU}] */
export function poolsOf(type, series, periods) {
  if (!POOL_TYPES.includes(type)) return { pools: [], poolNote: '' };
  const pick = (k) => pickCells(series.map((r) => ({ day: r.day, total: r[`${k}T`], used: r[`${k}U`] })), periods);
  const cells = { hdd: pick('hdd'), ssd: pick('ssd') };
  const seen = POOLS.filter((p) => cells[p.key].some(Boolean)).map((p) => p.key);
  if (seen.length === 2) return { pools: POOLS.map((p) => ({ key: p.key, label: p.label, cells: cells[p.key] })), poolNote: '' };
  if (seen.length === 1) return { pools: [], poolNote: POOL_ONLY_NOTE[seen[0]] };
  return { pools: [], poolNote: '' };
}

/**
 * 보고표 본체.
 * @param {object} a
 * @param {object[]} a.rows      capacity_daily 행(device_id, day, total_bytes, used_bytes, hdd_total, hdd_used, ssd_total, ssd_used)
 * @param {object[]} a.resRows   resource_daily 행(device_id, rkey, day, kind, name, pool, total_bytes, used_bytes)
 * @param {object[]} a.periods   buildPeriods 결과
 * @param {object[]} a.devices   등록 장비 [{id, name, type, datacenterId, enabled}]
 * @param {Record<string,{firstDay:number,lastDay:number}>} [a.spans] 장비별 전체 이력 범위(db.dailySpans)
 * @param {Map<string,object>} [a.extraById] 장비별 최신 스냅샷의 하위 항목 표지 {resourcesProbe, resourcesDropped}
 */
export function buildUsageReport({ rows = [], resRows = [], periods = [], devices = [], spans = {}, extraById = new Map() } = {}) {
  const byDev = new Map();
  for (const r of rows) {
    const id = String(r.device_id);
    if (!byDev.has(id)) byDev.set(id, []);
    byDev.get(id).push({ day: Number(r.day), total: r.total_bytes, used: r.used_bytes,
      hddT: r.hdd_total ?? null, hddU: r.hdd_used ?? null, ssdT: r.ssd_total ?? null, ssdU: r.ssd_used ?? null });
  }
  const resByDev = new Map();
  for (const r of resRows) {
    const id = String(r.device_id);
    if (!resByDev.has(id)) resByDev.set(id, new Map());
    const m = resByDev.get(id);
    if (!m.has(r.rkey)) m.set(r.rkey, { rkey: r.rkey, kind: r.kind, name: r.name, pool: r.pool ?? null, series: [] });
    const e = m.get(r.rkey);
    e.series.push({ day: Number(r.day), total: r.total_bytes, used: r.used_bytes });
    if (r.name) e.name = r.name;            // 행은 일 오름차순 — 마지막 이름이 최근 이름
    if (r.pool) e.pool = r.pool;
  }
  const sortSeries = (a) => a.sort((x, y) => x.day - y.day);
  const out = [];
  for (const d of devices) {
    const id = String(d.id);
    const series = sortSeries(byDev.get(id) || []);
    const sp = spans[id] || {};
    const res = [...(resByDev.get(id)?.values() || [])].map((e) => ({
      rkey: e.rkey, kind: e.kind, name: e.name, pool: e.pool, cells: pickCells(sortSeries(e.series), periods),
    })).filter((e) => e.cells.some(Boolean))
      .sort((a, b) => (a.kind === b.kind ? String(a.name).localeCompare(String(b.name), 'en', { numeric: true }) : (a.kind === 'lun' ? -1 : 1)));
    const ex = extraById.get(id) || {};
    const { pools, poolNote } = poolsOf(d.type || '', series, periods);
    out.push({
      deviceId: id, name: d.name || id, type: d.type || '', datacenterId: d.datacenterId || '', enabled: d.enabled !== false,
      firstDay: numOrNull(sp.firstDay) ?? (series[0]?.day ?? null),
      lastDay: numOrNull(sp.lastDay) ?? (series.length ? series[series.length - 1].day : null),
      cells: pickCells(series, periods),
      pools,
      ...(poolNote ? { poolNote } : {}),
      resources: res,
      ...(ex.resourcesProbe ? { resourcesProbe: ex.resourcesProbe } : {}),
      ...(numOrNull(ex.resourcesDropped) ? { resourcesDropped: numOrNull(ex.resourcesDropped) } : {}),
      ...(typeof ex.snapOk === 'boolean' ? { lastSnapOk: ex.snapOk } : {}),
    });
  }
  return out;
}

/**
 * 그 기간에 값이 있어야 하는 장비인가 — 이력이 그 기간 끝 이전에 시작됐고, 꺼진 장비면 마지막 관측이 그 기간 시작 이후일 때만.
 * (이력이 늦게 시작한 장비가 옛 기간을 '부분 합' 으로 만들지 않게 · 꺼진 장비가 그 뒤 모든 기간을 부분 합으로 만들지 않게.)
 */
export function expectedIn(dev, p) {
  const f = numOrNull(dev?.firstDay);
  if (f == null || f > p.toDay) return false;
  if (dev.enabled === false) { const l = numOrNull(dev.lastDay); return l != null && l >= p.fromDay; }
  return true;
}

/**
 * 장비 묶음의 기간별 합계(순수). 웹 `storageUsageText.aggregateCells` 가 같은 규칙의 사본이다(테스트 대조).
 * @returns {{totalBytes:number|null, usedBytes:number|null, pct:number|null, counted:number, expected:number, missing:number, usedUnknown:number, partial:boolean, inexact:number}[]}
 */
export function aggregateCells(devs, periods) {
  return (periods || []).map((p, i) => {
    let t = 0; let u = 0; let counted = 0; let expected = 0; let missing = 0; let usedUnknown = 0; let inexact = 0;
    for (const d of devs || []) {
      const c = d?.cells?.[i] || null;
      const exp = expectedIn(d, p);
      if (exp) expected += 1;
      if (!c) { if (exp) missing += 1; continue; }
      if (c.usedBytes == null) { usedUnknown += 1; continue; }
      t += c.totalBytes; u += c.usedBytes; counted += 1;
      if (!c.exact) inexact += 1;
    }
    return {
      totalBytes: counted ? t : null, usedBytes: counted ? u : null, pct: counted ? pctOf(t, u) : null,
      counted, expected, missing, usedUnknown, inexact, partial: missing > 0 || usedUnknown > 0,
    };
  });
}

/** 두 셀(이전 → 지금)의 사용량 변화. 둘 중 하나라도 사용량이 없으면 null(0 이 아니다). */
export function deltaOf(prev, cur) {
  const a = numOrNull(prev?.usedBytes); const b = numOrNull(cur?.usedBytes);
  return a == null || b == null ? null : b - a;
}
