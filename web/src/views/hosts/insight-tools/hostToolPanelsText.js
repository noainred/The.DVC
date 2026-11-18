/**
 * hosts/insight-tools/hostToolPanelsText.js — Hypervisor 분석 화면의 특수 기능 요약 패널 3종 값 만들기(v3.22.0 · 순수 · 설계 docs/design/vm-insight §10 Hypervisor 줄).
 *   CPU 경합 · 디스크 지연(호스트 · 데이터스토어 — /tools/contention?summary=1) · ESXi 호스트 구성 점검(/tools/host-hygiene?summary=1) ·
 *   데이터스토어 — 곧 가득 · 경로(/tools/capacity-forecast?summary=1 · /tools/storage-paths?summary=1).
 * 판정은 각 도구 그대로(서버 요약 모드가 준 수 · 목록) — 여기서는 고른 법인의 줄을 더하고 상위 N 을 도구의 비교 순서로 다시 고르기만 한다.
 * 합 · 상위 병합 보조는 VM 분석 패널과 같은 toolSumText(한 벌) — 호스트 전용 사본을 만들지 않는다.
 * 기준값(대기 % · 지연 ms · 곧 가득 일수 · 사용률 %)은 응답의 thresholds 에서 읽는다(화면에 박지 않는다).
 */
import { numOrNull } from '../../../numOrNull.js';
import { HOST_CFG_TEXT } from '../../hostcfg/hostCfgText.js';
import { pickRows, notReadPicked, total, sumObjects, mergeTop, descNull, ascNull, byName, TOP_N_DEFAULT } from '../../vms/insight-tools/toolSumText.js';

const topNOf = (resp) => (Number.isInteger(resp?.topN) && resp.topN > 0 ? resp.topN : TOP_N_DEFAULT);
const SEV_RANK = { crit: 0, warn: 1, info: 2 };

/* ───────────── CPU 경합 · 디스크 지연(호스트 쪽) ───────────── */

/** 데이터스토어 지연 정렬 값 — 도구와 같은 max(readAvg, writeAvg). 둘 다 모르면 null. */
export function dsLatOf(d) {
  const r = numOrNull(d?.readAvg); const w = numOrNull(d?.writeAvg);
  if (r == null && w == null) return null;
  return Math.max(r ?? -Infinity, w ?? -Infinity);
}
/** 호스트 정렬 — 도구 analyzeContention 의 hostRows 정렬 그대로(경합 VM 수 → 가장 큰 대기 → 디스크 지연). */
export const CMP_HOST = (a, b) => ((numOrNull(b.contended) ?? 0) - (numOrNull(a.contended) ?? 0))
  || ((numOrNull(b.worstReady) ?? 0) - (numOrNull(a.worstReady) ?? 0))
  || ((numOrNull(b.diskMaxMs) ?? 0) - (numOrNull(a.diskMaxMs) ?? 0));

export function contentionHostView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const N = topNOf(resp);
  const cov = (key) => total(rows, (r) => r.coverage?.[key]);
  const connected = cov('hostsConnected'); const measured = cov('hostsMeasured');
  return {
    empty: rows.length === 0,
    missing,
    th: resp.thresholds && typeof resp.thresholds === 'object' ? resp.thresholds : {},
    initial: resp.initial === true,
    scan: resp.scan && typeof resp.scan === 'object' ? resp.scan : null,
    hostsReadyCrit: total(rows, (r) => r.hostsReadyCrit),
    hostsContended: total(rows, (r) => r.hostsContended),
    hostsDisk: total(rows, (r) => r.kpi?.hostsDisk),
    dsSlow: total(rows, (r) => r.kpi?.dsSlow),
    hostsConnected: connected, hostsMeasured: measured,
    hostsNotMeasured: connected != null && measured != null ? Math.max(0, connected - measured) : null,
    unmatchedDs: total(rows, (r) => r.unmatchedDs),
    hosts: mergeTop(rows, (r) => r.top?.hosts, (a, b) => CMP_HOST(a, b) || byName(a, b), N),
    datastores: mergeTop(rows, (r) => r.top?.datastores, (a, b) => descNull(dsLatOf(a), dsLatOf(b)) || byName(a, b), N),
  };
}

/* ───────────── ESXi 호스트 구성 점검 ───────────── */

/** 문제 종류 막대 — 응답 codes(코드 → 심각도) 중 심각 · 경고만(정보 수준은 도구에서). 고른 법인의 byCode(호스트 수)를 더한다. 0 건은 뺀다. */
export function hostCodeRows(resp, rows) {
  const codes = resp?.codes && typeof resp.codes === 'object' ? resp.codes : {};
  const by = sumObjects(rows, (r) => r.byCode);
  return Object.entries(codes)
    .filter(([, sev]) => sev === 'crit' || sev === 'warn')
    .map(([code, sev]) => ({ code, sev, title: HOST_CFG_TEXT[code]?.title || code, n: by[code] || 0 }))
    .filter((x) => x.n > 0)
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.n - a.n || a.title.localeCompare(b.title));
}

export function hostHygieneView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const picked = pickRows(resp.rows, vcIds);
  const { rows } = picked;
  const nr = notReadPicked(resp, vcIds, picked.missing);   // dbg3221: 못 읽은 법인도 고른 법인으로 거른다 · missing 에서 뺀다
  const missing = nr.missing;
  const N = topNOf(resp);
  return {
    empty: rows.length === 0,
    missing,
    hosts: total(rows, (r) => r.hosts), problem: total(rows, (r) => r.problem),
    crit: total(rows, (r) => r.crit), warn: total(rows, (r) => r.warn),
    ssh: total(rows, (r) => r.ssh), certExpired: total(rows, (r) => r.certExpired), certExpiring: total(rows, (r) => r.certExpiring),
    outOfJudgment: total(rows, (r) => r.outOfJudgment),
    notCollected: total(rows, (r) => r.coverage?.notCollected), disconnected: total(rows, (r) => r.coverage?.disconnected),
    codes: hostCodeRows(resp, rows),
    // 인증서가 만료된 호스트 — 도구 요약과 같은 순서(지난 일수 큰 순 · 이름)
    certList: mergeTop(rows, (r) => r.top?.certExpired, (a, b) => descNull(a.days, b.days) || byName(a, b), N),
    partial: nr.partial,
    notReadVcenters: nr.list.length,
    initial: resp.initial === true,
    scan: resp.scan && typeof resp.scan === 'object' ? resp.scan : null,
  };
}

/* ───────────── 데이터스토어 — 곧 가득 · 경로 ───────────── */

/** 용량 고갈 예측 요약 — 곧 가득 · 사용률 높음 · 예상 없음 · 모름 · 곧 가득 찰 순(예상일 빠른 순). */
export function forecastView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  const th = resp.thresholds && typeof resp.thresholds === 'object' ? resp.thresholds : {};
  return {
    empty: rows.length === 0,
    missing,
    soonDays: numOrNull(th.soonDays), highPct: numOrNull(th.highPct),
    datastores: total(rows, (r) => r.datastores),
    soon: total(rows, (r) => r.soon), high: total(rows, (r) => r.high),
    usageUnknown: total(rows, (r) => r.usageUnknown), noForecast: total(rows, (r) => r.noForecast), synthesized: total(rows, (r) => r.synthesized),
    soonest: mergeTop(rows, (r) => r.top?.soonest, (a, b) => ascNull(a.daysToFull, b.daysToFull) || byName(a, b), topNOf(resp)),
  };
}

/** 데이터스토어 · 경로 점검 요약 — 죽은 경로 · 경로가 한 줄뿐인 호스트 · 판정 밖 · 죽은 경로가 있는 호스트(많은 순). */
export function pathsView(resp, vcIds) {
  if (!resp || !Array.isArray(resp.rows)) return null;
  const { rows, missing } = pickRows(resp.rows, vcIds);
  return {
    empty: rows.length === 0,
    missing,
    dead: total(rows, (r) => r.totals?.dead), hostsDead: total(rows, (r) => r.totals?.hostsDead),
    singlePath: total(rows, (r) => r.totals?.singlePath), hostsSingle: total(rows, (r) => r.totals?.hostsSingle),
    hosts: total(rows, (r) => r.coverage?.hosts), read: total(rows, (r) => r.coverage?.read), notCollected: total(rows, (r) => r.notCollected),
    deadHosts: mergeTop(rows, (r) => r.top?.dead, (a, b) => descNull(a.dead, b.dead) || descNull(a.singlePath, b.singlePath) || byName(a, b), topNOf(resp)),
  };
}

/** 패널 → 필요한 도구 키(하나라도 허용이면 그 패널을 그린다 — 데이터스토어 패널은 두 도구를 나눠 그린다). */
export const HOST_PANEL_GROUPS = Object.freeze({ perf: Object.freeze(['contention']), config: Object.freeze(['hygiene']), capacity: Object.freeze(['ds']) });
export const HOST_PANEL_TOOLS = Object.freeze({
  contention: Object.freeze(['contention']),
  hygiene: Object.freeze(['host-hygiene']),
  ds: Object.freeze(['forecast', 'storage-paths']),
});
/** 그릴 패널 목록(순수 — 권한 없는 패널은 뺀다). */
export function hostPanelsFor(group, canTool) {
  const can = typeof canTool === 'function' ? canTool : () => false;
  return (HOST_PANEL_GROUPS[group] || []).filter((p) => HOST_PANEL_TOOLS[p].some((k) => can(k)));
}
