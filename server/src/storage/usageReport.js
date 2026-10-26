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

/** 단위별 기간 수(기본·상한). 상한은 조회 행 수를 묶는다(장비 79대 × 주간 104 ≈ 5.7만 일 롤업 행). 화면은 이 값으로 고른다(숫자를 박지 않는다). */
export const GRANS = Object.freeze({
  daily: Object.freeze({ label: '일간', def: 14, max: 92 }),
  weekly: Object.freeze({ label: '주간', def: 8, max: 104 }),
  monthly: Object.freeze({ label: '월간', def: 12, max: 36 }),
});
export const WEEKDAY_DEF = 1;   // 월요일(0 = 일요일) — 캡처의 날짜 기준
export const WEEKDAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);

/** 요청 쿼리 → {gran, count, weekday}. 모르는 값은 기본값(읽기 경로 — 화면 선택지 밖 값으로 400 을 주지 않는다). */
export function normalizeReportQuery(q = {}) {
  const gran = Object.hasOwn(GRANS, String(q.gran || '')) ? String(q.gran) : 'weekly';
  const g = GRANS[gran];
  const n = numOrNull(q.count);
  const count = n != null && Number.isInteger(n) && n >= 1 ? Math.min(n, g.max) : g.def;
  const w = numOrNull(q.weekday);
  const weekday = w != null && Number.isInteger(w) && w >= 0 && w <= 6 ? w : WEEKDAY_DEF;
  return { gran, count, weekday };
}

/** 일 인덱스의 요일(0 = 일요일). 일 0 = 1970-01-01(목요일). */
export const weekdayOf = (day) => (((Number(day) + 4) % 7) + 7) % 7;
/** 일 인덱스 → 'YYYY-MM-DD'. */
export const labelOfDay = (day) => new Date(Number(day) * DAY_MS).toISOString().slice(0, 10);
const dayOfYmd = (y, m0, d) => Math.floor(Date.UTC(y, m0, d) / DAY_MS);

/**
 * 기간 목록(오래된 것 → 최근). 각 기간 `{ key, label, day(기준일), fromDay, toDay, current? }`.
 * `current:true` = 아직 끝나지 않은 이번 달(월간) — 화면이 '오늘까지' 로 밝힌다.
 */
export function buildPeriods({ gran = 'weekly', asOfDay, count, weekday = WEEKDAY_DEF } = {}) {
  const q = normalizeReportQuery({ gran, count, weekday });
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
      out.push({ key: labelOfDay(a), label: labelOfDay(a), day: a, fromDay: a - 6, toDay: a });
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
 * 보고표 본체.
 * @param {object} a
 * @param {object[]} a.rows      capacity_daily 행(device_id, day, total_bytes, used_bytes)
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
    byDev.get(id).push({ day: Number(r.day), total: r.total_bytes, used: r.used_bytes });
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
    out.push({
      deviceId: id, name: d.name || id, type: d.type || '', datacenterId: d.datacenterId || '', enabled: d.enabled !== false,
      firstDay: numOrNull(sp.firstDay) ?? (series[0]?.day ?? null),
      lastDay: numOrNull(sp.lastDay) ?? (series.length ? series[series.length - 1].day : null),
      cells: pickCells(series, periods),
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
