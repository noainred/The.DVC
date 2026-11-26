/**
 * bmcheck/assetCsv.js — 자산 원장(보증 · 계약) CSV 가져오기 · 내보내기 · 샘플(v3.45). 순수.
 *
 * 스캔 대역 CSV(idrac/scanRangesCsv.js)와 같은 골격 — 드라이런(문법 검증 · 무엇이 바뀌는지) 뒤 커밋.
 * 식별 키는 **서비스 태그**(대소문자 무시). 한 파일에 같은 태그가 두 번 나오면 뒤 줄은 오류(어느 줄이 맞는지 포탈이 고르지 않는다).
 * 날짜는 warranty.js parseDay 가 받는 꼴만 — 못 읽는 날짜는 빈 값으로 넣지 않고 **그 줄을 오류**로 돌린다(조용히 '모름' 이 되지 않게).
 */
import { parseCsvRows, csvLine, unguardCell, delimiterHint, CSV_BOM } from '../util/csv.js';
import { parseDay, ASSET_TEXT_MAX } from './warranty.js';

export const ASSET_COLUMNS = Object.freeze(['service_tag', 'warranty_end', 'warranty_type', 'purchase_date', 'contract_no', 'eos_date', 'note']);
export const ASSET_ROWS_MAX = 20_000;
export const ASSET_TAG_MAX = 64;
/** 머리글 별칭(소문자 · 공백 제거 뒤 비교) → 열 */
const ALIAS = Object.freeze({
  service_tag: ['service_tag', 'servicetag', 'tag', '서비스태그', '태그'],
  warranty_end: ['warranty_end', 'warrantyend', '보증만료', '보증만료일', '보증종료', '보증종료일'],
  warranty_type: ['warranty_type', 'warrantytype', '보증종류', '보증유형'],
  purchase_date: ['purchase_date', 'purchasedate', '구매일', '도입일'],
  contract_no: ['contract_no', 'contractno', 'contract', '계약번호', '유지보수계약'],
  eos_date: ['eos_date', 'eosdate', 'eos', '지원종료', '지원종료일'],
  note: ['note', 'memo', '비고', '메모'],
});
const headKey = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_·-]/g, '').slice(0, 40);
const ALIAS_OF = (() => { const m = new Map(); for (const [col, list] of Object.entries(ALIAS)) for (const a of list) m.set(headKey(a), col); return m; })();

const cell = (v, max = ASSET_TEXT_MAX) => {
  const s = unguardCell(String(v ?? '')).trim();
  let out = '';
  for (let i = 0; i < Math.min(s.length, max * 2); i += 1) { const c = s.charCodeAt(i); out += c < 32 || c === 127 ? ' ' : s[i]; }
  return out.trim();
};
export const tagKey = (tag) => String(tag ?? '').trim().toLowerCase();
/** 객체 열쇠로 쓰면 안 되는 글자(원장은 { 태그: 줄 } 객체다 — `__proto__` 를 열쇠로 넣으면 그 객체의 원형이 바뀐다). */
export const RESERVED_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
export const isReservedKey = (k) => RESERVED_KEYS.includes(String(k));

/**
 * CSV 글자 → 줄. 문법만 본다(값 검증은 analyzeAssetImport).
 * @returns {{ rows: object[], error?: string }}
 */
export function parseAssetCsv(text) {
  let table;
  // keepBlank: 빈 줄도 한 줄로 센다 — 오류 줄 번호가 파일(엑셀)의 줄 번호와 같게(기본값은 빈 줄을 버려 번호가 당겨진다)
  try { table = parseCsvRows(text, { maxRows: ASSET_ROWS_MAX + 2, maxCell: 2000, keepBlank: true }); }
  catch (e) { return { rows: [], error: `CSV 를 읽지 못했습니다 — ${String(e?.message || e).slice(0, 200)}` }; }
  if (!table.length || !table.some((r) => r && r.some((c) => String(c ?? '').trim()))) return { rows: [], error: '빈 파일입니다.' };
  const head = table[0].map(headKey);
  const cols = head.map((h) => ALIAS_OF.get(h) || '');
  if (!cols.includes('service_tag')) {
    const hint = delimiterHint(table[0]);
    return { rows: [], error: `머리글에 service_tag(서비스 태그) 열이 없습니다.${hint || ''}` };
  }
  if (table.length - 1 > ASSET_ROWS_MAX) return { rows: [], error: `줄이 너무 많습니다(최대 ${ASSET_ROWS_MAX}줄).` };
  const rows = [];
  for (let i = 1; i < table.length; i += 1) {
    const r = table[i];
    if (!r || !r.some((c) => String(c ?? '').trim())) continue;
    const o = { _line: i + 1 };
    cols.forEach((c, k) => { if (c && o[c] === undefined) o[c] = cell(r[k], c === 'service_tag' ? ASSET_TAG_MAX : ASSET_TEXT_MAX); });
    rows.push(o);
  }
  return { rows };
}

const DATE_COLS = Object.freeze([['warranty_end', 'end', '보증 만료일'], ['purchase_date', 'purchase', '구매일'], ['eos_date', 'eos', '지원 종료일']]);
const TEXT_COLS = Object.freeze([['warranty_type', 'type', '보증 종류'], ['contract_no', 'contract', '계약 번호'], ['note', 'note', '비고']]);
/** 줄 → 원장 값 또는 오류 사유. */
export function entryOfRow(row) {
  const tag = String(row?.service_tag || '').trim();
  if (!tag) return { error: '서비스 태그가 비어 있습니다.' };
  if (tag.length > ASSET_TAG_MAX) return { error: `너무 깁니다 — 서비스 태그(최대 ${ASSET_TAG_MAX}자).` };
  if (isReservedKey(tagKey(tag))) return { error: '서비스 태그로 쓸 수 없는 글자입니다.' };
  const e = { tag };
  for (const [col, key, label] of DATE_COLS) {
    const raw = String(row[col] || '').trim();
    if (!raw) { e[key] = ''; continue; }
    const d = parseDay(raw);
    if (!d) return { error: `날짜로 읽지 못한 값 — ${label} ‘${raw.slice(0, 24)}’ (예: 2027-03-14).` };
    e[key] = d;
  }
  for (const [col, key, label] of TEXT_COLS) {
    const raw = String(row[col] || '').trim();
    if (raw.length > ASSET_TEXT_MAX) return { error: `너무 깁니다 — ${label}(최대 ${ASSET_TEXT_MAX}자).` };
    e[key] = raw;
  }
  if (!e.end && !e.type && !e.purchase && !e.contract && !e.eos && !e.note) return { error: '서비스 태그 말고는 값이 없습니다.' };
  return { entry: e };
}
const sameEntry = (a, b) => ['end', 'type', 'purchase', 'contract', 'eos', 'note'].every((k) => String(a?.[k] || '') === String(b?.[k] || ''));

/**
 * 가져오기 판정(드라이런과 커밋이 같은 함수).
 * @param {object[]} rows parseAssetCsv 의 rows
 * @param {Record<string, object>} existing 지금 원장({ 태그 소문자: 줄 })
 * @param {{ replace?: boolean }} opt replace = 파일에 없는 줄을 원장에서 지운다
 * @returns {{ report: object[], summary: { add:number, update:number, same:number, error:number, remove:number }, next: Record<string, object>|null }}
 *   next = 커밋할 원장(오류 줄은 빠진다). replace 인데 오류 줄이 하나라도 있으면 next 는 null — 오류 줄의 서버가 원장에서 사라지지 않게 전부 멈춘다.
 */
export function analyzeAssetImport(rows, existing = {}, { replace = false } = {}) {
  const report = []; const summary = { add: 0, update: 0, same: 0, error: 0, remove: 0 };
  const seen = new Map(); const next = replace ? {} : { ...existing };
  for (const row of Array.isArray(rows) ? rows : []) {
    const line = row?._line ?? null;
    const r = entryOfRow(row);
    if (r.error) { summary.error += 1; report.push({ line, tag: String(row?.service_tag || '').slice(0, ASSET_TAG_MAX), action: 'error', reason: r.error }); continue; }
    const k = tagKey(r.entry.tag);
    if (seen.has(k)) { summary.error += 1; report.push({ line, tag: r.entry.tag, action: 'error', reason: `같은 서비스 태그가 ${seen.get(k)}번째 줄에도 있습니다.` }); continue; }
    seen.set(k, line);
    const old = Object.hasOwn(existing, k) ? existing[k] : undefined;
    const action = !old ? 'add' : sameEntry(old, r.entry) ? 'same' : 'update';
    summary[action] += 1;
    report.push({ line, tag: r.entry.tag, action });
    next[k] = r.entry;
  }
  if (replace) summary.remove = Object.keys(existing).filter((k) => !seen.has(k)).length;
  return { report, summary, next: replace && summary.error ? null : next };
}

/** 원장 → CSV(머리글 + 태그 순). 셀은 csvLine 이 수식 주입을 막는다. */
export function assetsToCsv(entries = {}) {
  const list = Object.values(entries).filter((e) => e && typeof e === 'object').sort((a, b) => String(a.tag).localeCompare(String(b.tag)));
  const lines = [csvLine(ASSET_COLUMNS)];
  for (const e of list) lines.push(csvLine([e.tag, e.end || '', e.type || '', e.purchase || '', e.contract || '', e.eos || '', e.note || '']));
  return `${CSV_BOM}${lines.join('\r\n')}\r\n`;
}
/** 샘플 — 값은 가상이다(실제 태그 · 계약 번호가 아니다). */
export function sampleAssetCsv() {
  return `${CSV_BOM}${[csvLine(ASSET_COLUMNS), csvLine(['ABC1234', '2027-03-14', 'ProSupport 익일 방문', '2022-03-15', 'MA-2022-0001', '2029-03-31', '']), csvLine(['XYZ5678', '2026-12-31', 'Basic', '2021-12-31', '', '', '교체 검토'])].join('\r\n')}\r\n`;
}
