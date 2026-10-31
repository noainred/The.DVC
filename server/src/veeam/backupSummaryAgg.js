/**
 * veeam/backupSummaryAgg.js — Backup › Summary 의 법인 집계(v2.836 — 백업 메뉴 개편 1-b · 사용자 요청 '서머리에는 veeam/bareos/ssh 를 합쳐 BackedUp ·
 *   백업 안함 · 확인 필요 세 합계' + 시안 ① Summary). 순수 함수 — 입력은 Detail 과 같은 VM 행(vmBackupView + withBareos + backupPolicy.policyFields).
 *   쓰는 곳: routes/api/veeam.js summaryData(법인 줄 집계 pa · 합계) · GET /tools/backup-summary/stale(전체 법인 '백업 안 된 VM 찾기').
 *
 * 판정은 새로 만들지 않는다 — 정책·실제·불일치·마지막 성공·실패는 backupPolicy 의 결과 필드(p a mm lok e)를 세기만 하고,
 *   RPO 는 backupPolicy.staleOf(웹 rpoCell 과 같은 규칙: 백업 안함은 대상 아님 · 창 안 성공 = 충족 · 한쪽을 모르면 모름)를 쓴다.
 * 못 읽은 값은 0 이 아니라 따로 센다 — 정책을 모르면(표시 파일 손상 · p null) pol 은 null 이고 polUnk 에 센다.
 */
import { POLICY_KEYS, staleOf, STALE_SOURCES } from './backupPolicy.js';

const DAY = 86_400_000;
const isFin = (v) => typeof v === 'number' && Number.isFinite(v);

/** RPO 기준 일수 — 웹 backupViewText.RPO_DAYS 와 같다(화면의 '오래된 백업 기준' · 테스트 대조). */
export const SUMMARY_RPO_DAYS = Object.freeze([1, 3, 7]);
/** BackedUp = 실제로 백업하겠다고 정한 정책(사용자 정의 — Veeam · Bareos · SSH 합). */
export const BACKED_UP_KEYS = Object.freeze(['veeam', 'bareos', 'ssh']);

/** 빈 법인 집계. */
export function newSiteAgg() {
  return {
    n: 0, on: 0, gb: 0, gbUnk: 0,
    pol: Object.fromEntries(POLICY_KEYS.map((k) => [k, 0])), polUnk: 0,
    act: { v: 0, b: 0, none: 0, unk: 0 },
    mm: 0, mmUnk: 0, mmBy: { veeam: 0, bareos: 0, other: 0 },
    rpo: Object.fromEntries(SUMMARY_RPO_DAYS.map((d) => [`d${d}`, { ok: 0, miss: 0, unk: 0 }])),
    err: { vms: 0, fail: 0, warn: 0 }, run: 0, lok: null, nx: null,
  };
}

/**
 * RPO 한 VM — 'ok'(창 안에 성공) · 'miss'(한 번도 없음·기준 넘음) · 'unk'(정책 또는 한쪽 결과를 모름) · null(백업 안함 — 대상 아님).
 * 웹 rpoCell(tone ok·bad·unknown·none)과 같은 갈래(테스트 대조).
 */
export function rpoOf(row, days, now) {
  if (!row?.p) return 'unk';
  if (row.p === 'none') return null;
  const k = staleOf(row, { windowMs: days * DAY, now, excludeNone: false, onlyOn: false, includeNever: true });
  if (!k) return 'ok';
  return k.kind === 'unknown' ? 'unk' : 'miss';
}

/** 집계에 VM 한 대를 더한다(행 모양은 Detail 응답의 vms 한 줄). */
export function addSiteVm(agg, row, now = Date.now()) {
  agg.n++;
  if (row?.power === 'POWERED_ON') agg.on++;
  if (isFin(row?.gb) && row.gb >= 0) agg.gb += row.gb; else agg.gbUnk++;
  if (row?.p && POLICY_KEYS.includes(row.p)) agg.pol[row.p]++; else agg.polUnk++;
  const a = row?.a || {};
  if (a.v === true) agg.act.v++;
  if (a.b === true) agg.act.b++;
  if (a.v === false && a.b === false) agg.act.none++;
  if (a.v == null || a.b == null) agg.act.unk++;
  if (row?.mm === true) {
    agg.mm++;
    if (row.p === 'veeam') agg.mmBy.veeam++; else if (row.p === 'bareos') agg.mmBy.bareos++; else agg.mmBy.other++;
  } else if (row?.mm == null) agg.mmUnk++;
  for (const d of SUMMARY_RPO_DAYS) {
    const r = rpoOf(row, d, now);
    if (r) agg.rpo[`d${d}`][r]++;
  }
  if (Array.isArray(row?.e) && row.e.length) {
    agg.err.vms++;
    for (const x of row.e) { if (x?.r === 'fail') agg.err.fail++; else if (x?.r === 'warn') agg.err.warn++; }
  }
  if (row?.v?.state === 'run') agg.run++;
  if (isFin(row?.lok?.at) && (agg.lok == null || row.lok.at > agg.lok)) agg.lok = row.lok.at;
  if (isFin(row?.nx?.at) && (agg.nx == null || row.nx.at < agg.nx)) agg.nx = row.nx.at;
  return agg;
}

/**
 * 법인 집계를 마무리한다 — 정책을 하나도 모르면 pol 은 null(표시 파일 손상 — 0 이 아니다) · 용량은 소수 1자리.
 *   polUnk 가 일부면 pol 은 아는 VM 만의 수(화면이 '*' 로 부분 합을 알린다).
 */
export function finishSiteAgg(agg) {
  const out = { ...agg, gb: Math.round(agg.gb * 10) / 10 };
  if (agg.n > 0 && agg.polUnk === agg.n) out.pol = null;
  return out;
}

/** 합계 — 법인 집계들을 더한다(pol 이 null 인 법인은 pol 합에서 빼고 polUnkSites 로 센다 — 부분 합). */
export function sumSiteAggs(list) {
  const t = newSiteAgg(); t.polUnkSites = 0;
  for (const a of Array.isArray(list) ? list : []) {
    if (!a) continue;
    t.n += a.n; t.on += a.on; t.gb += a.gb; t.gbUnk += a.gbUnk; t.polUnk += a.polUnk;
    if (a.pol) for (const k of POLICY_KEYS) t.pol[k] += a.pol[k] || 0; else t.polUnkSites++;
    for (const k of ['v', 'b', 'none', 'unk']) t.act[k] += a.act?.[k] || 0;
    t.mm += a.mm; t.mmUnk += a.mmUnk; for (const k of ['veeam', 'bareos', 'other']) t.mmBy[k] += a.mmBy?.[k] || 0;
    for (const d of SUMMARY_RPO_DAYS) for (const k of ['ok', 'miss', 'unk']) t.rpo[`d${d}`][k] += a.rpo?.[`d${d}`]?.[k] || 0;
    for (const k of ['vms', 'fail', 'warn']) t.err[k] += a.err?.[k] || 0;
    t.run += a.run;
    if (isFin(a.lok) && (t.lok == null || a.lok > t.lok)) t.lok = a.lok;
    if (isFin(a.nx) && (t.nx == null || a.nx < t.nx)) t.nx = a.nx;
  }
  t.gb = Math.round(t.gb * 10) / 10;
  return t;
}

/* ── 전체 법인 '백업 안 된 VM 찾기'(시안 ① · 사용자 요청 '지정한 시간만큼 백업되지 않은 VM') ─────────────────────── */

/** 기간 단위 — 웹 backupViewText.STALE_UNITS 와 같다(테스트 대조). */
export const STALE_UNIT_MS = Object.freeze({ h: 3_600_000, d: DAY, w: 7 * DAY });
/** 응답에 싣는 행 상한(나머지는 수만 — truncated). */
export const STALE_ROWS_MAX = 500;

/** 찾기 조건(쿼리) → 정규화. n 은 1~999 정수만(그 밖은 windowMs null — 찾지 않는다). 모르는 값은 기본. */
export function staleQueryOf(q = {}) {
  const n = Number(q.n);
  const unit = Object.hasOwn(STALE_UNIT_MS, String(q.unit)) ? String(q.unit) : 'd';
  const ok = Number.isInteger(n) && n >= 1 && n <= 999;
  const src = STALE_SOURCES.includes(String(q.src)) ? String(q.src) : 'all';
  const flag = (v) => String(v ?? '1') !== '0';
  return { n: ok ? n : null, unit, src, excludeNone: flag(q.excludeNone), onlyOn: flag(q.onlyOn), includeNever: flag(q.includeNever), windowMs: ok ? n * STALE_UNIT_MS[unit] : null };
}

/**
 * 한 법인의 VM 행에서 찾기 결과를 센다 — 웹 findStale 과 같은 규칙(백업 안함·꺼진 VM 제외는 따로 센다 · 모름은 n 에 넣지 않는다).
 * @param {object} acc { n, never, old, unknown, excluded:{none,off}, rows:[] }
 * @param {object[]} rows Detail 모양 VM 행
 * @param {object} site { id, name } — 결과 행에 싣는다
 */
export function addStaleRows(acc, rows, site, o, now = Date.now()) {
  if (o.windowMs == null) return acc;
  for (const vm of Array.isArray(rows) ? rows : []) {
    if (o.excludeNone !== false && vm?.p === 'none') { acc.excluded.none++; continue; }
    if (o.onlyOn !== false && vm?.power !== 'POWERED_ON') { acc.excluded.off++; continue; }
    const k = staleOf(vm, { windowMs: o.windowMs, now, src: o.src, excludeNone: false, onlyOn: false, includeNever: o.includeNever !== false });
    if (!k) continue;
    acc[k.kind]++;
    if (k.kind !== 'unknown') acc.n++;
    acc.rows.push({ vc: site.id, vcName: site.name, kind: k.kind, last: k.last, vm: staleVmView(vm) });
  }
  return acc;
}
export const newStaleAcc = () => ({ n: 0, never: 0, old: 0, unknown: 0, excluded: { none: 0, off: 0 }, rows: [] });

/** 결과 행의 VM — 화면이 이유·마지막 성공을 그리는 데 필요한 필드만(웹 staleReason · lastOkText). */
function staleVmView(vm) {
  return { id: vm.id, name: vm.name, folder: vm.folder, power: vm.power, os: vm.os ?? null, p: vm.p ?? null, a: vm.a, mm: vm.mm ?? null, lok: vm.lok, ...(Array.isArray(vm.e) ? { e: vm.e } : {}) };
}

const nat = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
/**
 * 정렬 + 상한 — 한 번도 없음 → 기준 넘음 → 모름, 같은 갈래는 오래 비어 있던 순 · 이름 순(웹 findStale 과 같은 순서).
 * @returns {{ rows:object[], total:number, truncated?:true }}
 */
export function finishStaleRows(acc, max = STALE_ROWS_MAX) {
  const rank = { never: 0, old: 1, unknown: 2 };
  const all = acc.rows.slice().sort((a, b) => rank[a.kind] - rank[b.kind] || (a.last ?? 0) - (b.last ?? 0)
    || nat.compare(String(a.vm?.name || ''), String(b.vm?.name || '')) || nat.compare(String(a.vcName || ''), String(b.vcName || '')));
  return { rows: all.slice(0, max), total: all.length, ...(all.length > max ? { truncated: true } : {}) };
}
