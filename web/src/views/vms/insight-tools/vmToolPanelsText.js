/**
 * insight-tools/vmToolPanelsText.js — VM 분석 화면 특수 기능 패널 5종의 값 만들기(v3.21.0 · 순수).
 *   디스크가 차 가는 VM(게스트 파티션 사용률 · §4-1) · 꺼진 VM(Optimization › 전원 꺼짐 · §8) · VM 수 추이 · 생성/삭제(§10 ⑦) ·
 *   CPU 경합 · 디스크 지연(§10 ②) · VM 구성 점검(§10 ④).
 * 판정은 각 도구 그대로(서버 요약 모드가 준 수 · 목록) — 여기서는 고른 법인의 줄을 더하고 상위 5 를 다시 고르기만 한다.
 * 기준값(80% · 95% · 30일 · 7일 · 5% · 10% · 20ms · 50ms …)은 응답의 thresholds · ageEdges 에서 읽는다(화면에 박지 않는다).
 */
import { numOrNull } from '../../../numOrNull.js';
import { ALL_TEXT } from '../../vmcfg/vmHygieneText.js';
import { LIFE_KIND_LABEL, ADD_KINDS } from '../../vmlife/vmLifeText.js';
import {
  pickRows, total, sumArrays, sumObjects, mergeTop, descNull, ascNull, byName, TOP_N_DEFAULT,
} from './toolSumText.js';

/** 따뜻한 색 4단(낮음 → 높음) — 시안 보드와 같은 값. 글자색은 바탕 밝기에 맞춘다. */
export const WARM = Object.freeze([
  { bg: '#a16207', ink: '#ffffff' },
  { bg: '#f59e0b', ink: '#0b0b0b' },
  { bg: '#ec835a', ink: '#0b0b0b' },
  { bg: '#ef4444', ink: '#ffffff' },
]);
export const NEUTRAL = Object.freeze({ bg: '#4b5873', ink: '#ffffff' });
export const UNKNOWN = Object.freeze({ bg: '#243049', ink: '#c3cfe2' });

const topNOf = (resp) => (Number.isInteger(resp?.topN) && resp.topN > 0 ? resp.topN : TOP_N_DEFAULT);

/* ───────────────────── 디스크가 차 가는 VM(게스트 파티션 사용률) ───────────────────── */

/**
 * 사용률 → 구간 번호(0 = 기준 ~ 첫 경계 · 마지막 = 마지막 경계 이상). 경계는 응답 thresholds.overBinEdges.
 * 서버 overBins 와 같은 규칙(경계는 위 칸 — '85 이상' 은 둘째 칸).
 */
export function gpBandOf(pct, edges) {
  const p = numOrNull(pct);
  const e = Array.isArray(edges) ? edges.map(numOrNull).filter((x) => x != null) : [];
  if (p == null) return null;
  let i = 0;
  while (i < e.length && p >= e[i]) i += 1;
  return i;
}

/** 구간 i(0 … nb-1) 의 색 — 마지막 구간이 빨강이 되게 뒤에서부터 맞춘다(구간이 4개보다 적어도 위험 칸은 빨강). */
export function warmAt(i, nb) {
  const k = WARM.length - 1 - (Math.max(1, nb) - 1 - i);
  return WARM[Math.min(WARM.length - 1, Math.max(0, k))];
}

/** 구간 이름 — ['80–85%', '85–90%', '90–95%', '95% 이상']. 첫 칸의 아래 끝은 기준(법인마다 다르면 ‘기준’). */
export function gpBandLabels(thr, edges) {
  const e = Array.isArray(edges) ? edges.map(numOrNull).filter((x) => x != null) : [];
  const t = numOrNull(thr);
  const out = [];
  for (let i = 0; i <= e.length; i++) {
    if (i === e.length) out.push(`${e[i - 1]}% 이상`);
    else if (i === 0) out.push(t == null ? `기준–${e[0]}%` : `${t}–${e[0]}%`);
    else out.push(`${e[i - 1]}–${e[i]}%`);
  }
  return out;
}

/** 파티션 행의 OS 코드(win · lnx · other) → 이름. 모르는 값은 그대로 · 없으면 '—'. */
export function osName(os) {
  const k = String(os ?? '').toLowerCase();
  if (!k) return '—';
  return { win: 'Windows', windows: 'Windows', lnx: 'Linux', linux: 'Linux', other: '그 밖' }[k] || String(os);
}

/** 문제 종류 막대는 이만큼만 그리고 나머지는 ‘그 밖 N종’ 으로 말한다(전체는 도구에). */
export const HYGIENE_CODE_ROWS = 8;

/** 게스트 파티션 요약 응답 → 패널 값. 응답이 없으면 null. */
export function guestPartView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const th = resp.thresholds || {};
  const edges = Array.isArray(th.overBinEdges) ? th.overBinEdges : [];
  const thrGlobal = numOrNull(th.thr) ?? numOrNull(th.defaultThr);
  // 법인마다 기준을 따로 정했으면(rows[].thr) 한 숫자로 말하지 않는다.
  const thrs = new Set(rows.map((r) => numOrNull(r.thr) ?? thrGlobal));
  const thrMixed = thrs.size > 1;
  const thr = thrMixed ? null : (thrs.size ? [...thrs][0] : thrGlobal);
  const bins = sumArrays(rows, (r) => r.overBins, edges.length + 1) || Array.from({ length: edges.length + 1 }, () => 0);
  const labels = gpBandLabels(thr, edges);
  const N = topNOf(resp);
  const nb = edges.length + 1;
  return {
    empty: rows.length === 0,
    missing,
    thr, thrMixed, critPct: numOrNull(th.critPct), soonDays: numOrNull(th.soonDays), growthDays: numOrNull(th.growthDays),
    overVms: total(rows, (r) => r.overVms), overParts: total(rows, (r) => r.overParts),
    crit: total(rows, (r) => r.crit), soon: total(rows, (r) => r.soon),
    guests: total(rows, (r) => r.guests), reported: total(rows, (r) => r.reported), notReported: total(rows, (r) => r.notReported),
    offNotReported: total(rows, (r) => r.offNotReported), unknownParts: total(rows, (r) => r.unknownParts),
    staleCorps: rows.filter((r) => r.stale === true).length,
    os: sumObjects(rows, (r) => r.osOver),
    bands: bins.map((n, i) => ({ key: `b${i}`, n, label: labels[i] || '', ...warmAt(i, nb) })),
    fullest: mergeTop(rows, (r) => r.top?.fullest, (a, b) => descNull(a.pct, b.pct) || ascNull(a.freeGB, b.freeGB) || byName(a, b), N),
    // 예상을 모르는 행은 서버가 넣지 않는다(곧 가득 찰 순 — 빠른 순).
    soonest: mergeTop(rows, (r) => r.top?.soonest, (a, b) => ascNull(a.etaDays, b.etaDays) || descNull(a.pct, b.pct) || byName(a, b), N),
    bandColor: (pct) => { const i = gpBandOf(pct, edges); return i == null ? UNKNOWN : warmAt(i, nb); },
    collect: resp.collect && typeof resp.collect === 'object' ? resp.collect : null,
  };
}

/* ───────────────────── 꺼진 VM(Optimization › 전원 꺼짐) ───────────────────── */

/** 꺼진 지 구간 이름 — 응답 ageEdges([7, 30]) 로 만든다. 서버 buckets 키(lt7 · d7 · ge30 · unknown)와 같은 순서. */
export function offAgeBands(edges) {
  const e = Array.isArray(edges) ? edges.map(numOrNull).filter((x) => x != null) : [];
  const [a, b] = e;
  return [
    { key: 'lt7', label: a == null ? '짧음' : `${a}일 미만`, ...NEUTRAL },
    { key: 'd7', label: a == null || b == null ? '중간' : `${a}–${b}일`, ...WARM[1] },
    { key: 'ge30', label: b == null ? '오래됨' : `${b}일 이상`, ...WARM[3] },
    { key: 'unknown', label: '모름', ...UNKNOWN },
  ];
}

/**
 * 꺼진 VM 패널 값 — waste 요약(수 · 디스크 · 할당 · 상위 디스크 순) + off-since 요약(꺼진 지 구간 · 오래 꺼진 순).
 * off-since 를 아직 못 받았으면 bands · oldest 는 null(구간을 지어내지 않는다 — 꺼진 지를 모르는 VM 은 '모름' 으로 서버가 센다).
 */
export function offView(waste, offSince, vcIds) {
  if (!waste || !Array.isArray(waste.rows)) return null;
  const { rows, missing } = pickRows(waste.rows, vcIds);
  const N = topNOf(waste);
  const offRows = offSince && Array.isArray(offSince.rows) ? pickRows(offSince.rows, vcIds).rows : null;
  let bands = null;
  if (offRows) {
    const b = sumObjects(offRows, (r) => r.buckets);
    bands = offAgeBands(offSince.ageEdges).map((x) => ({ ...x, n: b[x.key] || 0 }));
  }
  return {
    empty: rows.length === 0,
    missing,
    count: total(rows, (r) => r.poweredOff),
    vms: total(rows, (r) => r.vms),
    diskGB: total(rows, (r) => r.poweredOffGB),
    diskUnknown: total(rows, (r) => r.poweredOffStorageUnknown) || 0,
    vcpu: total(rows, (r) => r.offVcpu),
    memGB: total(rows, (r) => r.offMemGB),
    allocUnknown: total(rows, (r) => r.offAllocUnknown) || 0,
    withSnap: total(rows, (r) => r.offWithSnapshots),
    bands,
    ageEdges: Array.isArray(offSince?.ageEdges) ? offSince.ageEdges : null,
    byDisk: mergeTop(rows, (r) => r.top?.poweredOff, (a, b) => descNull(a.storageGB, b.storageGB) || byName(a, b), N),
    // 오래 꺼진 순 — 꺼진 지를 모르는 VM 은 뒤로(0일로 넣지 않는다).
    byDays: offRows ? mergeTop(offRows, (r) => r.top?.oldest, (a, b) => descNull(a.offDays, b.offDays) || descNull(a.storageGB, b.storageGB) || byName(a, b), topNOf(offSince)) : null,
    corps: rows.map((r) => ({ vcenterId: r.vcenterId, name: r.name, n: numOrNull(r.poweredOff), gb: numOrNull(r.poweredOffGB) }))
      .filter((c) => (c.n || 0) > 0)
      .sort((a, b) => descNull(a.gb, b.gb) || descNull(a.n, b.n) || String(a.vcenterId).localeCompare(String(b.vcenterId))),
  };
}

/* ───────────────────── VM 수 추이 · 생성/삭제 ───────────────────── */

/**
 * VM 수 추이(vm-track 요약) — 슬롯마다 고른 법인의 점을 더한다. 어떤 법인의 점이 없는 슬롯은 **부분 합**(partial)으로 표시한다
 * (그 슬롯의 수를 전체 수처럼 그리지 않는다). 이력이 없으면 points 는 [](지어내지 않는다).
 */
export function trackView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const slots = Array.isArray(resp.slots) && resp.slots.length
    ? resp.slots.map(String)
    : [...new Set(rows.flatMap((r) => (Array.isArray(r.points) ? r.points.map((p) => String(p.slot)) : [])))].sort();
  const bySlot = rows.map((r) => new Map((Array.isArray(r.points) ? r.points : []).map((p) => [String(p.slot), p])));
  const points = [];
  for (const slot of slots) {
    let sum = 0; let have = 0; let ts = null;
    for (const m of bySlot) {
      const p = m.get(slot);
      const v = numOrNull(p?.total);
      if (v == null) continue;
      sum += v; have += 1; ts = ts ?? numOrNull(p.ts);
    }
    if (!have) continue;
    points.push({ slot, ts, total: sum, partial: have < rows.length, missingCorps: rows.length - have });
  }
  // 지금 · 기준(창 안의 첫 점) — 한 곳이라도 모르면 증감을 말하지 않는다(부분 합끼리의 차는 거짓이다).
  const cur = rows.map((r) => numOrNull(r.current?.total));
  const base = rows.map((r) => numOrNull(r.base?.total));
  const curOk = rows.length > 0 && cur.every((v) => v != null);
  const baseOk = rows.length > 0 && base.every((v) => v != null);
  const current = curOk ? cur.reduce((a, b) => a + b, 0) : null;
  const baseTotal = baseOk ? base.reduce((a, b) => a + b, 0) : null;
  const baseSlot = rows.map((r) => r.base?.slot).find(Boolean) || null;
  return {
    empty: points.length === 0,
    missing,
    days: numOrNull(resp.days),
    available: resp.available !== false,
    points,
    partialPoints: points.filter((p) => p.partial).length,
    current, base: baseTotal, baseSlot,
    diff: current != null && baseTotal != null ? current - baseTotal : null,
    min: points.length ? Math.min(...points.map((p) => p.total)) : null,
    max: points.length ? Math.max(...points.map((p) => p.total)) : null,
  };
}

/** 'YYYY-MM-DDTHH' 슬롯 → '11-18 12시'. 모르는 꼴이면 그대로. */
export function slotText(slot) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/.exec(String(slot || ''));
  return m ? `${m[2]}-${m[3]} ${Number(m[4])}시` : String(slot || '');
}

/** 하루 시작 epoch(ms) → 'MM-DD'(보는 사람 시간대). */
export function dayText(ts) {
  const t = numOrNull(ts);
  if (t == null) return '—';
  const d = new Date(t);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 생성 · 삭제 이력(vm-lifecycle 요약) — 합 · 종류별 · 날마다(같은 날끼리 더한다). */
export function lifeView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const byKind = sumObjects(rows, (r) => r.byKind);
  const days = new Map();
  for (const r of rows) {
    for (const s of Array.isArray(r.series) ? r.series : []) {
      const k = numOrNull(s?.day);
      if (k == null) continue;
      const e = days.get(k) || { day: k, added: 0, removed: 0, partial: false };
      e.added += numOrNull(s.added) || 0;
      e.removed += numOrNull(s.removed) || 0;
      if (s.partialFrom != null) e.partial = true;
      days.set(k, e);
    }
  }
  const series = [...days.values()].sort((a, b) => a.day - b.day);
  const notCollected = Array.isArray(resp.notCollected) ? resp.notCollected.length : 0;
  return {
    empty: rows.length === 0,
    missing,
    days: numOrNull(resp.days),
    added: total(rows, (r) => r.added), removed: total(rows, (r) => r.removed), net: total(rows, (r) => r.net),
    shortLived: total(rows, (r) => r.shortLivedCount), noDetail: total(rows, (r) => r.noDetail),
    kinds: Object.keys(LIFE_KIND_LABEL).map((k) => ({ key: k, label: LIFE_KIND_LABEL[k], n: byKind[k] || 0, add: ADD_KINDS.includes(k) })),
    series,
    seriesMax: series.reduce((a, s) => Math.max(a, s.added + s.removed), 0),
    truncated: resp.truncated === true,
    notCollected,
  };
}

/* ───────────────────── CPU 경합 · 디스크 지연 ───────────────────── */

/** 디스크 지연 정렬 값 — 서버 요약과 같은 max(readAvg, writeAvg). 둘 다 모르면 null. */
export function diskLatOf(v) {
  const r = numOrNull(v?.readAvg); const w = numOrNull(v?.writeAvg);
  if (r == null && w == null) return null;
  return Math.max(r ?? -Infinity, w ?? -Infinity);
}

export function contentionView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const N = topNOf(resp);
  const k = (key) => total(rows, (r) => r.kpi?.[key]);
  const c = (key) => total(rows, (r) => r.coverage?.[key]);
  return {
    empty: rows.length === 0,
    missing,
    th: resp.thresholds && typeof resp.thresholds === 'object' ? resp.thresholds : {},
    initial: resp.initial === true,
    scan: resp.scan && typeof resp.scan === 'object' ? resp.scan : null,
    readyCrit: k('readyCrit'), readyWarn: k('readyWarn'), costop: k('costop'), diskCrit: k('diskCrit'), diskWarn: k('diskWarn'),
    hostsDisk: k('hostsDisk'), dsSlow: k('dsSlow'),
    poweredOn: c('poweredOn'), measured: c('measured'), notMeasured: c('notMeasured'), stale: c('stale'),
    ready: mergeTop(rows, (r) => r.top?.ready, (a, b) => descNull(a.readyAvg, b.readyAvg) || descNull(a.readyMax, b.readyMax) || byName(a, b), N),
    disk: mergeTop(rows, (r) => r.top?.disk, (a, b) => descNull(diskLatOf(a), diskLatOf(b)) || descNull(a.diskMax, b.diskMax) || byName(a, b), N),
  };
}

/* ───────────────────── VM 구성 점검 ───────────────────── */

const SEV_RANK = { crit: 0, warn: 1, info: 2 };

/** 문제 종류 막대 — 응답 codes(코드 → 심각도) 중 심각 · 경고만(정보 수준은 도구에서 본다). 고른 법인의 byCode 를 더한다. 0 건은 뺀다. */
export function hygieneCodes(resp, rows) {
  const codes = resp?.codes && typeof resp.codes === 'object' ? resp.codes : {};
  const by = sumObjects(rows, (r) => r.byCode);
  return Object.entries(codes)
    .filter(([, sev]) => sev === 'crit' || sev === 'warn')
    .map(([code, sev]) => ({ code, sev, title: ALL_TEXT[code]?.title || code, n: by[code] || 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.n - a.n || a.title.localeCompare(b.title));
}

export function hygieneView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const N = topNOf(resp);
  const by = sumObjects(rows, (r) => r.byCode);
  return {
    empty: rows.length === 0,
    missing,
    vms: total(rows, (r) => r.vms), withFindings: total(rows, (r) => r.withFindings),
    crit: total(rows, (r) => r.crit), warn: total(rows, (r) => r.warn), notCollected: total(rows, (r) => r.notCollected),
    consolidation: numOrNull(by.consolidation) ?? 0, question: numOrNull(by.question) ?? 0,
    codes: hygieneCodes(resp, rows),
    // 응답 대기 질문 — 도구의 판정(심각). 순서는 이름(심각도가 모두 같다).
    questions: mergeTop(rows, (r) => r.top?.question, (a, b) => byName(a, b), N),
    partial: resp.partial === true,
    settingsUnreadable: resp.settingsUnreadable === true,
    notReadVcenters: Array.isArray(resp.notReadVcenters) ? resp.notReadVcenters.length : 0,
    initial: resp.initial === true,
  };
}
