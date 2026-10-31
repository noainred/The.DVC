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
    // v2.837(시안 ① 숫자 줄 · 두 카드)
    unprot: 0, unver: 0,   // 보호 안 됨 = 정책 BackedUp 인데 성공 백업이 한 번도 없다고 확인 · 확인 안 됨 = 백업 안함이 아닌데 결과를 모름(정책 모름 포함)
    brun: 0, bwait: 0,     // Bareos 지금 실행 중 · 대기
    r24: { ok: 0, warn: 0, fail: 0 }, win: { start: null, end: null },   // 최근 24시간에 끝난 VM 마지막 결과(Veeam · Bareos 각각) · 그 결과들의 시작~끝
    vbytes: 0, vbytesN: 0, bbytes: 0, bbytesN: 0,   // Veeam 복원 지점 크기 합 · 아는 VM 수 · Bareos 마지막 실행 크기 합 · 아는 VM 수(바이트)
    vnx: null, vnxN: 0,    // Veeam 잡 다음 실행(지금 뒤 가장 이른 것) · 그 시각부터 1시간 안에 도는 VM 수
    bmis: 0,               // Bareos 잡이 있는데 정책이 Bareos 가 아닌 VM(방식 불일치 — 정책을 모르면 세지 않는다)
    v7: { ok: 0, bad: 0 }, b7: { ok: 0, bad: 0 },   // 7일 성공률 — 최근 7일에 끝난 VM 마지막 결과(성공·경고 / 실패·취소 — 두 솔루션 같은 규칙)
  };
}
const H24 = DAY;
const R24 = { Success: 'ok', Warning: 'warn', Failed: 'fail' };
const BR24 = { ok: 'ok', warning: 'warn', error: 'fail', canceled: 'fail' };
/** 24시간 결과 한 건 — 끝난 시각이 창 안이면 세고, 시작 시각을 알면 백업 기간에 넣는다. */
function addRun(agg, kind, end, start, now) {
  if (!kind || !isFin(end) || end > now || now - end > H24) return;
  agg.r24[kind]++;
  if (isFin(start) && start <= end) { if (agg.win.start == null || start < agg.win.start) agg.win.start = start; }
  if (agg.win.end == null || end > agg.win.end) agg.win.end = end;
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
  const nx = nextAtOf(row, now);
  if (nx != null && (agg.nx == null || nx < agg.nx)) agg.nx = nx;
  // v2.837 보호 안 됨 · 확인 안 됨(시안 ③ — 보호 안 됨 = BackedUp 인데 백업 결과 없음 + 확인 필요는 화면이 더한다)
  if (row?.p !== 'none') {
    if (BACKED_UP_KEYS.includes(row?.p) && row?.lok?.never === true) agg.unprot++;
    else if (!row?.p || (!isFin(row?.lok?.at) && row?.lok?.never !== true)) agg.unver++;
  }
  if (row?.b?.run === 'running') agg.brun++; else if (row?.b?.run) agg.bwait++;
  const v = row?.v;
  if (v) addRun(agg, R24[v.lr], v.lrt, v.lrs, now);
  const b = row?.b;
  if (b?.job === true) addRun(agg, BR24[b.st], b.at, b.sa, now);
  if (v && R24[v.lr] && isFin(v.lrt) && v.lrt <= now && now - v.lrt <= 7 * DAY) agg.v7[R24[v.lr] === 'fail' ? 'bad' : 'ok']++;
  if (b?.job === true && BR24[b.st] && isFin(b.at) && b.at <= now && now - b.at <= 7 * DAY) agg.b7[BR24[b.st] === 'fail' ? 'bad' : 'ok']++;
  if (v && isFin(v.sz) && v.sz >= 0) { agg.vbytes += v.sz; agg.vbytesN++; }
  if (b?.job === true && isFin(b.by) && b.by >= 0) { agg.bbytes += b.by; agg.bbytesN++; }
  if (v && isFin(v.nr) && v.nr > now) {
    if (agg.vnx == null || v.nr < agg.vnx) { agg.vnx = v.nr; }
  }
  if (b?.job === true && row?.p && row.p !== 'bareos') agg.bmis++;
  return agg;
}

/**
 * 다음 예정 — Bareos 그룹 회차(nx.at) · Veeam 잡 다음 실행(v.nr) 중 지금 뒤 가장 이른 것(v2.837 — 1차 D6 은 그룹만이었다). 모르면 null.
 *   웹 backupViewText.nextOf 와 한 쌍(테스트 대조).
 */
export function nextAtOf(row, now = Date.now()) {
  const c = [];
  if (isFin(row?.nx?.at) && row.nx.at > now) c.push(row.nx.at);
  if (isFin(row?.v?.nr) && row.v.nr > now) c.push(row.v.nr);
  return c.length ? Math.min(...c) : null;
}

/** Veeam 다음 창의 VM 수 — 가장 이른 다음 실행부터 1시간 안에 도는 VM(두 번째 훑기 · 법인 집계가 끝난 뒤). */
export function countVeeamWindow(agg, rows, now = Date.now()) {
  agg.vnxN = 0;
  if (agg.vnx == null) return agg;
  for (const r of Array.isArray(rows) ? rows : []) if (isFin(r?.v?.nr) && r.v.nr > now && r.v.nr < agg.vnx + 3_600_000) agg.vnxN++;
  return agg;
}

/**
 * 법인 집계를 마무리한다 — 정책을 하나도 모르면 pol 은 null(표시 파일 손상 — 0 이 아니다) · 용량은 소수 1자리.
 *   polUnk 가 일부면 pol 은 아는 VM 만의 수(화면이 '*' 로 부분 합을 알린다).
 */
export function finishSiteAgg(agg) {
  const out = { ...agg, gb: Math.round(agg.gb * 10) / 10, r24: { ...agg.r24 }, win: { ...agg.win }, v7: { ...agg.v7 }, b7: { ...agg.b7 } };
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
    for (const k of ['unprot', 'unver', 'brun', 'bwait', 'vbytes', 'vbytesN', 'bbytes', 'bbytesN', 'bmis']) t[k] += a[k] || 0;
    for (const k of ['ok', 'warn', 'fail']) t.r24[k] += a.r24?.[k] || 0;
    for (const k of ['ok', 'bad']) { t.v7[k] += a.v7?.[k] || 0; t.b7[k] += a.b7?.[k] || 0; }
    if (isFin(a.win?.start) && (t.win.start == null || a.win.start < t.win.start)) t.win.start = a.win.start;
    if (isFin(a.win?.end) && (t.win.end == null || a.win.end > t.win.end)) t.win.end = a.win.end;
    if (isFin(a.vnx)) {
      if (t.vnx == null || a.vnx < t.vnx - 3_600_000) { t.vnx = a.vnx; t.vnxN = a.vnxN || 0; }
      else if (a.vnx < t.vnx + 3_600_000) { if (a.vnx < t.vnx) t.vnx = a.vnx; t.vnxN += a.vnxN || 0; }   // 같은 창(1시간 안)이면 더한다 — 근사(법인마다 창이 1시간을 넘게 어긋나면 이른 쪽만)
    }
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
  const vc = typeof q.vc === 'string' ? q.vc.slice(0, 128) : '';   // v2.837 법인 하나(빈 값 = 범위 안 전체)
  return { n: ok ? n : null, unit, src, excludeNone: flag(q.excludeNone), onlyOn: flag(q.onlyOn), includeNever: flag(q.includeNever), vc, windowMs: ok ? n * STALE_UNIT_MS[unit] : null };
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
    if (k.kind !== 'unknown') { acc.n++; if (Array.isArray(vm.e) && vm.e.some((x) => x?.r === 'fail')) acc.failing++; }   // v2.837 '실패만 반복' — 최근 24시간 실패가 있는데 성공이 기준 밖
    acc.rows.push({ vc: site.id, vcName: site.name, kind: k.kind, last: k.last, vm: staleVmView(vm) });
  }
  return acc;
}
export const newStaleAcc = () => ({ n: 0, never: 0, old: 0, unknown: 0, failing: 0, excluded: { none: 0, off: 0 }, rows: [] });

/** 결과 행의 VM — 화면이 이유·마지막 성공을 그리는 데 필요한 필드만(웹 staleReason · lastOkText). */
function staleVmView(vm) {
  // v2.837 '실제 백업(마지막 결과)' 칸 — 웹 veeamCell · bareosCell 이 읽는 칸만(v 키 없음 = Veeam 모름 · null = 없음 — 같은 규칙)
  const v = vm.v === undefined ? undefined : vm.v ? { state: vm.v.state, pg: vm.v.pg ?? null, lb: vm.v.lb ?? null, jobs: (vm.v.jobs || []).slice(0, 2), ...(vm.v.lr ? { lr: vm.v.lr } : {}) } : null;
  const b = !('b' in vm) ? undefined : vm.b ? { job: vm.b.job === true, ...(vm.b.job ? { on: vm.b.on, st: vm.b.st, at: vm.b.at, run: vm.b.run ?? null } : {}) } : null;
  return { id: vm.id, name: vm.name, folder: vm.folder, power: vm.power, os: vm.os ?? null, p: vm.p ?? null, a: vm.a, mm: vm.mm ?? null, lok: vm.lok,
    ...(Array.isArray(vm.e) ? { e: vm.e } : {}), ...(v !== undefined ? { v } : {}), ...(b !== undefined ? { b } : {}) };
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
