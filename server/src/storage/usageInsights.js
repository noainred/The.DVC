/**
 * storage/usageInsights.js — 스토리지 사용량 **관리자용 판단 자료**(순수, v2.791). 파일·DB·타이머 없음.
 *
 * 사용자 요청(2026-10-26): "메일 발송할때 클로드 디자인 사용해서 관리자가 실제로 사용할 수 있는 데이터를 첨부하고" —
 *   승인된 시안(메일 본문 · 엑셀 요약 시트)의 표를 만든다: 조치가 필요한 항목 · 지난주 증가량 상위 · PowerScale 풀별 · 법인별·종류별 ·
 *   이번 주 값을 못 읽은 장비 · 핵심 지표. 메일 본문(`usageMailRules.js`)과 엑셀(`usageXlsx.js`)이 **이 함수 하나**를 쓴다 —
 *   두 벌이면 메일의 숫자와 첨부의 숫자가 갈라진다.
 *
 * 입력은 주간 보고표(`usageData.loadUsageReport({gran:'weekly'})` 의 ok 결과)다. 한 기간 = 한 주.
 *
 * ── 정직성 ────────────────────────────────────────────────────────────────
 *  · 변화(직전 주 대비)는 두 주의 값이 다 있을 때만. 합계는 두 주가 다 **완전한 합계**일 때만(부분 합끼리 빼면 장비 수 차이가 변화로 보인다).
 *  · '4주 평균 증가' 는 최근 4걸음 중 양쪽 값이 다 있는 걸음만의 평균이고, 그런 걸음이 2개 미만이면 내지 않는다.
 *  · 도달 예상은 그 평균으로 그은 **직선 추정**이다 — 증가가 0 이하이거나 평균이 없으면 '추정 안 함'/'증가 없음' 이다(날짜를 지어내지 않는다).
 *  · 값을 못 읽은 장비는 0 으로 세지 않고 따로 적는다(마지막 관측일 · 최근 수집 실패 여부).
 */
import { numOrNull } from '../util/numOrNull.js';
import { aggregateCells, deltaOf, expectedIn, isoWeekLabel, labelOfDay, POOL_TYPES } from './usageReport.js';
import { RESOURCE_KINDS } from './resources.js';

/** 조치 기준(시안 승인값 — 2026-10-26). 화면·메일·엑셀 문구는 이 값으로 만든다(숫자를 문구에 박지 않는다). */
export const ACTION_RULE = Object.freeze({ warnPct: 80, critPct: 90, horizonWeeks: 8, avgWeeks: 4, minSteps: 2 });
/** 도달 예상이 이보다 멀면 주차를 적지 않는다(직선 추정을 몇 년 뒤까지 늘이면 거짓 정밀이다). */
export const ETA_MAX_WEEKS = 104;

const TB = 1024 ** 4;

/** 계열(기간별 칸)의 마지막 값 · 직전 대비 · 최근 N걸음 평균 증가(양쪽 값이 있는 걸음만). */
export function trendOf(cells, { avgWeeks = ACTION_RULE.avgWeeks, minSteps = ACTION_RULE.minSteps } = {}) {
  const c = Array.isArray(cells) ? cells : [];
  const n = c.length;
  const cur = n ? c[n - 1] || null : null;
  const prev = n > 1 ? c[n - 2] || null : null;
  let sum = 0; let steps = 0;
  for (let i = Math.max(1, n - avgWeeks); i < n; i++) {
    const d = deltaOf(c[i - 1], c[i]);
    if (d != null) { sum += d; steps += 1; }
  }
  return { cur, prev, delta: deltaOf(prev, cur), avg: steps >= minSteps ? sum / steps : null, steps };
}

/** 합계 계열(aggregateCells) — 변화는 두 점이 다 완전한 합계일 때만. 평균도 완전한 걸음만. */
export function aggTrendOf(cells, { avgWeeks = ACTION_RULE.avgWeeks, minSteps = ACTION_RULE.minSteps } = {}) {
  const ok = (x) => !!(x && x.counted > 0 && !x.partial);
  const c = Array.isArray(cells) ? cells : [];
  const n = c.length;
  const cur = n ? c[n - 1] : null; const prev = n > 1 ? c[n - 2] : null;
  let sum = 0; let steps = 0;
  for (let i = Math.max(1, n - avgWeeks); i < n; i++) {
    if (ok(c[i - 1]) && ok(c[i])) { sum += c[i].usedBytes - c[i - 1].usedBytes; steps += 1; }
  }
  return {
    cur, prev, delta: ok(prev) && ok(cur) ? cur.usedBytes - prev.usedBytes : null,
    deltaWhy: prev && cur && (prev.partial || cur.partial) ? 'partial' : '',
    avg: steps >= minSteps ? sum / steps : null, steps,
  };
}

/**
 * 사용률이 pct% 에 닿을 때까지 몇 걸음(주)인가 — 이미 넘었으면 0, 추정할 수 없으면 null.
 * 크기는 지금 값으로 고정한 직선(사용량만 늘어난다고 본다).
 */
export function weeksTo(cur, avg, pct) {
  const t = numOrNull(cur?.totalBytes); const u = numOrNull(cur?.usedBytes);
  if (t == null || u == null || t <= 0) return null;
  const target = (t * pct) / 100;
  if (u >= target) return 0;
  const a = numOrNull(avg);
  if (a == null || !(a > 0)) return null;
  return Math.ceil((target - u) / a);
}

/** 도달 예상 문구 — '2026년 47주차 (3주 뒤)' · '이미 넘음' · '증가 없음' · '추정 안 함(이력 부족)' · '2년 넘게'. */
export function etaText(weeks, avg, lastDay) {
  if (weeks === 0) return '이미 넘음';
  if (weeks == null) return numOrNull(avg) == null ? '추정 안 함(이력 부족)' : '증가 없음';
  if (weeks > ETA_MAX_WEEKS) return '2년 넘게';
  return `${isoWeekLabel(lastDay + weeks * 7)} (${weeks}주 뒤)`;
}

/**
 * 보고표 → 판단 단위(장비 · 풀 · LUN · 파일시스템) 목록. 이력이 한 번도 없는 장비는 뺀다.
 * unit: 장비·풀은 TB, 하위 항목은 GB(화면·CSV 와 같다).
 */
export function entitiesOf(rep, { includeResources = true } = {}) {
  const typeLabel = new Map((rep.types || []).map((t) => [t.type, t.label]));
  const dcName = new Map((rep.datacenters || []).map((d) => [d.id, d.name || d.id]));
  const out = [];
  for (const d of rep.devices || []) {
    if (!(d.cells || []).some(Boolean)) continue;
    const base = {
      deviceId: d.deviceId, device: d.name, corp: d.datacenterId ? (dcName.get(d.datacenterId) || d.datacenterId) : '미지정',
      type: d.type || '', typeLabel: typeLabel.get(d.type) || d.type || '',
    };
    out.push({ ...base, key: d.deviceId, kind: 'device', group: '장비', item: d.name, name: d.name, unit: 'TB', cells: d.cells,
      firstDay: numOrNull(d.firstDay), lastDay: numOrNull(d.lastDay), enabled: d.enabled !== false, poolNote: d.poolNote || '',
      ...(typeof d.lastSnapOk === 'boolean' ? { lastSnapOk: d.lastSnapOk } : {}) });
    for (const p of d.pools || []) {
      out.push({ ...base, key: `${d.deviceId}|pool:${p.key}`, kind: 'pool', poolKey: p.key, group: '풀', item: p.label, name: `${d.name} › ${p.label}`, unit: 'TB', cells: p.cells });
    }
    if (includeResources) {
      for (const r of d.resources || []) {
        const g = RESOURCE_KINDS[r.kind]?.group || r.kind;
        out.push({ ...base, key: `${d.deviceId}|${r.rkey}`, kind: r.kind, group: g, item: r.name, name: `${d.name} › ${r.name} (${g})`, unit: 'GB', cells: r.cells });
      }
    }
  }
  return out;
}

/** 엔터티의 첫 값이 든 기간 인덱스(없으면 -1) — 그 앞 기간은 '수집 전'(엑셀 회색). 장비는 이력 시작일로 판정한다. */
export function firstIndexOf(e, periods) {
  if (e.kind === 'device' && e.firstDay != null) return periods.findIndex((p) => p.toDay >= e.firstDay);
  return (e.cells || []).findIndex(Boolean);
}

/**
 * 판단 자료 전체.
 * @param {object} rep 주간 보고표(ok)
 * @param {{includeResources?:boolean, rule?:object}} [o]
 */
export function buildInsights(rep, { includeResources = true, rule = ACTION_RULE } = {}) {
  const periods = rep.periods || [];
  const n = periods.length;
  const last = periods[n - 1] || null;
  const lastDay = last ? last.toDay : numOrNull(rep.asOfDay) ?? 0;
  const ents = entitiesOf(rep, { includeResources }).map((e) => {
    const tr = trendOf(e.cells, rule);
    const w90 = weeksTo(tr.cur, tr.avg, rule.critPct);
    const w100 = weeksTo(tr.cur, tr.avg, 100);
    return { ...e, trend: tr, w90, w100, eta90: etaText(w90, tr.avg, lastDay), eta100: etaText(w100, tr.avg, lastDay) };
  });
  const devEnts = ents.filter((e) => e.kind === 'device');
  const pctOf = (e) => numOrNull(e.trend.cur?.pct);
  const dcName = new Map((rep.datacenters || []).map((d) => [d.id, d.name || d.id]));
  const typeLabel = new Map((rep.types || []).map((t) => [t.type, t.label]));
  const corpOf = (d) => (d.datacenterId ? (dcName.get(d.datacenterId) || d.datacenterId) : '미지정');

  // ① 조치가 필요한 항목 — 지금 warn% 이상이거나, 추세로 horizon 주 안에 crit% 에 닿는다. 급한 순.
  const actions = ents.filter((e) => {
    const p = pctOf(e);
    if (p == null) return false;
    return p >= rule.warnPct || (e.w90 != null && e.w90 <= rule.horizonWeeks);
  }).sort((a, b) => {
    const pa = pctOf(a); const pb = pctOf(b);
    const ca = pa >= rule.critPct ? 0 : 1; const cb = pb >= rule.critPct ? 0 : 1;
    if (ca !== cb) return ca - cb;
    if (ca === 0) return pb - pa;
    const wa = a.w90 ?? Infinity; const wb = b.w90 ?? Infinity;
    return wa - wb || pb - pa || String(a.name).localeCompare(String(b.name), 'en', { numeric: true });
  });

  // ② 지난주 증가량 상위(장비만 — 하위 항목은 장비 증가에 이미 들어 있다)
  const growthTop = devEnts.filter((e) => e.trend.delta != null && e.trend.delta > 0)
    .sort((a, b) => b.trend.delta - a.trend.delta).slice(0, 5);

  // ③ PowerScale 풀별 — 두 풀이 있는 장비 + 한 풀만 있는 장비(표지)
  const poolRows = devEnts.filter((e) => POOL_TYPES.includes(e.type) && ((rep.devices || []).find((d) => d.deviceId === e.deviceId)?.pools?.length || e.poolNote))
    .map((e) => {
      const pools = ents.filter((x) => x.kind === 'pool' && x.deviceId === e.deviceId);
      const pick = (k) => pools.find((x) => x.poolKey === k) || null;
      return { device: e, hdd: pick('hdd'), ssd: pick('ssd'), note: e.poolNote };
    });

  // ④ 이번 주 값을 못 읽은 장비 — 그 주에 값이 있어야 하는데(expectedIn) 없거나 사용량만 못 읽음
  const missing = last ? (rep.devices || []).filter((d) => expectedIn(d, last)).map((d) => {
    const c = d.cells?.[n - 1] || null;
    if (c && c.usedBytes != null) return null;
    const ld = numOrNull(d.lastDay);
    const why = c ? '크기는 읽었지만 사용량을 못 읽음'
      : `${ld == null ? '관측 기록 없음' : `마지막 관측 ${labelOfDay(ld).slice(5)}(${Math.max(0, lastDay - ld)}일 전)`}${d.lastSnapOk === false ? ' · 최근 수집 실패' : ''}`;
    return { deviceId: d.deviceId, name: d.name, corp: corpOf(d), typeLabel: typeLabel.get(d.type) || d.type || '', why };
  }).filter(Boolean) : [];

  // ⑤ 법인별·종류별 — 화면과 같은 합계(aggregateCells). 지운 장비는 화면처럼 이력이 있는 장비만.
  const withData = (rep.devices || []).filter((d) => (d.cells || []).some(Boolean));
  const groupBy = (keyOf) => {
    const m = new Map();
    for (const d of withData) { const k = keyOf(d); if (!m.has(k)) m.set(k, []); m.get(k).push(d); }
    return [...m.entries()].map(([key, list]) => {
      const cells = aggregateCells(list, periods);
      return { key, devices: list.length, cells, ...aggTrendOf(cells, rule) };
    }).sort((a, b) => (numOrNull(b.cur?.usedBytes) ?? -1) - (numOrNull(a.cur?.usedBytes) ?? -1) || String(a.key).localeCompare(String(b.key)));
  };
  const byCorp = groupBy(corpOf);
  const byType = groupBy((d) => typeLabel.get(d.type) || d.type || '');

  // ⑥ 핵심 지표
  const totalCells = aggregateCells(withData, periods);
  const total = { cells: totalCells, ...aggTrendOf(totalCells, rule) };
  const over = (list, p) => list.filter((e) => (pctOf(e) ?? -1) >= p).length;
  const kpi = {
    devices: withData.length, registered: (rep.devices || []).length, corps: byCorp.length,
    warnDevices: over(devEnts, rule.warnPct), critDevices: over(devEnts, rule.critPct),
    warnItems: over(ents, rule.warnPct), critItems: over(ents, rule.critPct),
    missing: missing.length,
  };
  return {
    rule, periods, lastDay, weekLabel: last?.label || '', weekKey: last?.isoKey || '', dayLabel: last?.dayLabel || rep.asOfLabel || '',
    prevLabel: n > 1 ? periods[n - 2].label : '', prevDayLabel: n > 1 ? (periods[n - 2].dayLabel || '') : '',
    firstLabel: periods[0]?.label || '',
    entities: ents, actions, growthTop, poolRows, missing, byCorp, byType, total, kpi,
  };
}

/** 단위 바이트(엑셀 숫자 칸) — TB/GB 로 나눈 값(소수 3자리). 못 읽으면 null. */
export function unitNum(b, unit) {
  const v = numOrNull(b);
  if (v == null) return null;
  return Math.round((v / (unit === 'GB' ? 1024 ** 3 : TB)) * 1000) / 1000;
}
