/**
 * bmusage/onboard/importParse.js — 서버 등록 CSV/Excel 읽기(7b단계 · 설계 PROFILES §18 '템플릿' · §19 '업로드').
 *
 *  · 입력은 **파일 바이트**(웹이 base64 로 보낸다 — 서버에 보관하지 않는다: 이 함수의 메모리에서만 읽고 버린다).
 *  · 형식: `PK\x03\x04` 로 시작하면 .xlsx(첫 시트 · 값만) · 아니면 CSV/TSV(구분자 자동 — util/csv.js parseCsvRows 재사용).
 *  · 인코딩 감지(CSV): BOM(UTF-8 · UTF-16LE/BE) → 엄격한 UTF-8 → 실패면 EUC-KR(WHATWG 'euc-kr' = CP949 상위 집합). 감지 결과를 돌려준다.
 *  · .xlsx: 압축 폭탄 가드(svcmon/formats.js assertXlsxSizeOk — 실제로 풀며 상한) → exceljs. **수식은 결과값만**(캐시된 결과가 없으면 그 칸은
 *    ‘결과 없음’ 표지 — 빈 값으로 보지 않는다) · 서식 무시 · 리치 텍스트는 글자만 · 하이퍼링크는 표시 글자 · 오류 값(#N/A 등)은 ‘오류’ 표지.
 *    **병합 셀**: 그 병합이 걸친 행은 거부한다(exceljs 는 병합 범위의 모든 칸에 첫 칸 값을 돌려줘 이름 · 주소가 옆 행으로 복제된다 — 어느 행 값인지 모호).
 *    머리글 행에 병합이 걸리면 파일 전체를 거부한다.
 *  · 상한: 파일 4MB · 데이터 5,000행 · 칸 1,024자 · 열 64. 넘으면 파일 오류(앞부분만 받지 않는다 — 일부 등록은 더 위험하다).
 *  · 머리글 별칭(한/영 · 대소문자 · 공백 · 밑줄 · 하이픈 · 별표 무시). 비밀 칸 이름(password · 비밀번호 · private_key …)은 **값을 읽지 않고** 그 칸에 값이 있는 행을 표시한다.
 */
import { parseCsvRows, unguardCell, delimiterHint } from '../../util/csv.js';
import { assertXlsxSizeOk, assertXlsxMergesOk } from '../../svcmon/formats.js';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const MAX_CELL = 1024;
export const MAX_COLS = 64;
const XLSX_MAX_UNCOMPRESSED = 64 * 1024 * 1024;

/** 템플릿 열(설계 §18 목록 — '*' 는 필수). 순서가 템플릿 순서다. */
export const TEMPLATE_COLUMNS = Object.freeze([
  'name', 'corp', 'idrac_host', 'idrac_cred', 'service_tag', 'os_host', 'os_port', 'os_cred', 'os_key',
  'collect_via', 'class', 'purposes', 'role', 'mounts', 'switch_port', 'enabled', 'note',
]);
export const REQUIRED_COLUMNS = Object.freeze(['name', 'corp']);

/** 머리글 별칭 — 정규화한 머리글(소문자 · 공백/밑줄/하이픈/별표/슬래시 제거) → 열 이름. */
const ALIASES = {
  name: ['name', '서버명', '서버이름', '이름', 'hostname', '호스트명', 'servername'],
  corp: ['corp', '법인', '법인코드', 'vcenter', 'vcenterid', 'datacenter', '데이터센터'],
  idrac_host: ['idrachost', 'idrac', 'idrac주소', 'idracip', 'bmc', 'bmc주소'],
  idrac_cred: ['idraccred', 'idrac계정', 'idracaccount', 'idrac공통계정'],
  service_tag: ['servicetag', '서비스태그', 'tag', 'serial', '시리얼'],
  os_host: ['oshost', 'os주소', 'ssh주소', 'osip', 'sshhost', 'host', 'ip', '호스트'],
  os_port: ['osport', 'ssh포트', 'port', '포트', 'sshport'],
  os_cred: ['oscred', 'os계정', 'ssh계정', 'osaccount', 'os공통계정'],
  os_key: ['oskey', 'ssh키', 'sshkey', '키', 'key', '인증'],
  collect_via: ['collectvia', '수집경로', 'via', '경로', 'collectpath'],
  class: ['class', '분류', '구분'],
  purposes: ['purposes', 'purpose', '용도', 'apps', '기능'],
  role: ['role', '역할'],
  mounts: ['mounts', '마운트', 'mount'],
  switch_port: ['switchport', '스위치포트', 'switch', '스위치', 'cvp', 'cvp매핑'],
  enabled: ['enabled', '사용', '켬', '활성', 'enable'],
  note: ['note', '메모', '비고', 'memo', 'comment'],
};
/** 비밀 칸 이름 — 값은 읽지 않는다(그 행을 거부할 표지만). */
const SECRET_HEADERS = new Set(['password', 'passwd', 'pw', 'pwd', '비밀번호', '암호', 'secret', 'privatekey', '개인키', 'passphrase', 'token', 'idracpassword', 'ospassword', 'sshpassword', 'key내용', 'keydata']);

export const normHeader = (h) => unguardCell(String(h ?? '')).replace(/^﻿/, '').trim().toLowerCase().replace(/[\s_\-*/.()]+/g, '');
const ALIAS_INDEX = (() => { const m = new Map(); for (const [col, list] of Object.entries(ALIASES)) for (const a of list) m.set(a, col); return m; })();

/** 바이트 → 텍스트 + 감지한 인코딩. */
export function decodeText(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: b.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'utf-16le' };
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'utf-16be' };
  try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(b), encoding: 'utf-8' }; } catch { /* UTF-8 이 아니다 */ }
  try { return { text: new TextDecoder('euc-kr', { fatal: true }).decode(b), encoding: 'euc-kr' }; } catch { /* EUC-KR 도 아니다 */ }
  return { text: null, encoding: 'unknown' };
}

/** 셀 표지 — 값 대신 들어가는 특별한 꼴(분석이 행을 거부한다). */
export const CELL_NO_RESULT = '\u0000no-result';
export const CELL_ERROR = '\u0000error';

function xlsxCellText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : '';
  if (typeof v === 'object') {
    if (Object.hasOwn(v, 'formula') || Object.hasOwn(v, 'sharedFormula')) {
      const r = v.result;
      if (r === undefined || r === null) return CELL_NO_RESULT;
      if (typeof r === 'object' && r && r.error) return CELL_ERROR;
      return xlsxCellText(r);
    }
    if (Object.hasOwn(v, 'error')) return CELL_ERROR;
    if (Array.isArray(v.richText)) return v.richText.map((x) => String(x?.text ?? '')).join('');
    if (Object.hasOwn(v, 'text')) return typeof v.text === 'string' ? v.text : xlsxCellText(v.text);
    if (Object.hasOwn(v, 'hyperlink')) return String(v.hyperlink ?? '');
  }
  return '';
}

/** 'B3:C4' → { r1, r2 } 행 범위. */
function mergeRows(ref) {
  const m = /^\$?[A-Z]{1,3}\$?(\d{1,7}):\$?[A-Z]{1,3}\$?(\d{1,7})$/.exec(String(ref || '').trim());
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[2]);
  return { r1: Math.min(a, b), r2: Math.max(a, b) };
}

/** .xlsx 첫 시트 → 표(행 = 칸 문자열 배열) + 병합 행 집합(시트 행 번호). */
async function readXlsx(buf) {
  assertXlsxSizeOk(buf, XLSX_MAX_UNCOMPRESSED);
  assertXlsxMergesOk(buf);   // 감사 M-4: exceljs 가 로드하며 병합을 칸 단위로 전개하기 전에 막는다(svcmon 가져오기와 같은 함수)
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { throw new Error(`XLSX 를 읽지 못했습니다(${String(e?.message || e).slice(0, 80)})`); }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('XLSX 에 시트가 없습니다.');
  const merges = [];
  for (const ref of (Array.isArray(ws.model?.merges) ? ws.model.merges : [])) { const r = mergeRows(ref); if (r) merges.push(r); }
  const rows = []; const sheetRow = [];
  let over = false;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (over) return;
    if (rows.length > MAX_ROWS + 1) { over = true; return; }
    const cells = [];
    const last = Math.min(row.cellCount, MAX_COLS + 1);
    for (let c = 1; c <= last; c += 1) cells.push(xlsxCellText(row.getCell(c).value));
    rows.push(cells); sheetRow.push(rowNumber);
  });
  if (over) throw new Error(`데이터 행이 ${MAX_ROWS.toLocaleString()}행을 넘습니다 — 파일을 나눠 올리세요.`);
  return { rows, sheetRow, merges };
}

/**
 * 파일 바이트 → 정규화한 행.
 * @returns {Promise<{ok:true, format:'csv'|'xlsx', encoding:string, columns:string[], unknownColumns:string[], secretColumns:string[], rows:object[], fileWarnings:string[]}
 *                  | {ok:false, code:string, reason:string}>}
 *   행: { line(파일 행 번호 — CSV 는 줄 · XLSX 는 시트 행), cells:{열:값}, flags:{ merged?, noResult?:string[], cellError?:string[], secretCols?:string[] } }
 */
export async function parseOnboardFile(buf, { fileName = '' } = {}) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (!b.length) return { ok: false, code: 'empty', reason: '빈 파일입니다.' };
  if (b.length > MAX_UPLOAD_BYTES) return { ok: false, code: 'too-large', reason: `파일이 ${MAX_UPLOAD_BYTES / 1048576}MB 를 넘습니다 — 나눠 올리세요.` };
  const isXlsx = b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
  if (!isXlsx && /\.xls$/i.test(fileName)) return { ok: false, code: 'xls', reason: '옛 엑셀 형식(.xls)은 읽지 않습니다 — .xlsx 또는 CSV 로 저장하세요.' };
  let table; let sheetRow = null; let merges = []; let encoding = 'xlsx'; const fileWarnings = [];
  try {
    if (isXlsx) {
      const x = await readXlsx(b);
      table = x.rows; sheetRow = x.sheetRow; merges = x.merges;
    } else {
      const d = decodeText(b);
      if (d.text == null) return { ok: false, code: 'encoding', reason: '글자 인코딩을 알 수 없습니다 — UTF-8 또는 EUC-KR(CP949) CSV 로 저장하세요.' };
      encoding = d.encoding;
      table = parseCsvRows(d.text, { maxRows: MAX_ROWS + 50, maxCell: MAX_CELL * 8 });   // 머리글 · 설명 행 여유 — 데이터 행 상한은 아래에서 센다
    }
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 200);
    return { ok: false, code: /행이|rows/.test(msg) ? 'too-many-rows' : 'unreadable', reason: msg.replace(/CSV 행이 최대 \d+행을 넘습니다\./, `데이터 행이 ${MAX_ROWS.toLocaleString()}행을 넘습니다 — 파일을 나눠 올리세요.`) };
  }
  // 머리글 행 = 첫 비어 있지 않은 행. 주석 행('#' 로 시작)은 건너뛴다(템플릿 설명 행).
  let hi = 0;
  while (hi < table.length && String(table[hi][0] ?? '').trim().startsWith('#')) hi += 1;
  if (hi >= table.length) return { ok: false, code: 'no-header', reason: '머리글 행이 없습니다 — 템플릿을 내려받아 쓰세요.' };
  const header = table[hi];
  if (header.length > MAX_COLS) return { ok: false, code: 'too-many-cols', reason: `열이 ${MAX_COLS}개를 넘습니다.` };
  const headerSheetRow = sheetRow ? sheetRow[hi] : hi + 1;
  if (merges.some((m) => headerSheetRow >= m.r1 && headerSheetRow <= m.r2)) return { ok: false, code: 'merged-header', reason: '머리글 행에 병합 셀이 있습니다 — 병합을 풀고 한 칸에 한 열 이름만 두세요.' };
  const colOf = []; const unknownColumns = []; const secretColumns = []; const seen = new Map();
  header.forEach((h, i) => {
    const n = normHeader(h);
    if (!n) { colOf[i] = null; return; }
    if (SECRET_HEADERS.has(n)) { colOf[i] = { secret: true, label: String(h).trim().slice(0, 40) }; secretColumns.push(String(h).trim().slice(0, 40)); return; }
    const col = ALIAS_INDEX.get(n) || null;
    if (!col) { colOf[i] = null; unknownColumns.push(String(h).trim().slice(0, 40)); return; }
    if (seen.has(col)) { colOf[i] = { dup: col }; return; }
    seen.set(col, i); colOf[i] = { col };
  });
  const dupCols = colOf.filter((c) => c && c.dup).map((c) => c.dup);
  if (dupCols.length) return { ok: false, code: 'dup-header', reason: `같은 열이 두 번 있습니다(${[...new Set(dupCols)].join(', ')}) — 별칭까지 같은 열로 봅니다.` };
  const missing = REQUIRED_COLUMNS.filter((c) => !seen.has(c));
  if (missing.length) return { ok: false, code: 'missing-header', reason: `필수 열이 없습니다(${missing.join(', ')}).${delimiterHint(header)}` };
  if (!seen.has('idrac_host') && !seen.has('os_host')) return { ok: false, code: 'missing-header', reason: 'idrac_host 와 os_host 중 하나는 있어야 합니다.' };
  if (secretColumns.length) fileWarnings.push(`비밀 칸(${secretColumns.join(', ')})은 읽지 않습니다 — 값이 있는 행은 거부합니다(비밀은 공통 계정 · SSH 키 화면에서 한 번만 입력).`);
  if (unknownColumns.length) fileWarnings.push(`모르는 열은 무시합니다: ${unknownColumns.slice(0, 12).join(', ')}${unknownColumns.length > 12 ? ` 외 ${unknownColumns.length - 12}` : ''}`);
  const rows = [];
  for (let r = hi + 1; r < table.length; r += 1) {
    const raw = table[r];
    if (!raw.some((c) => String(c ?? '').trim() !== '')) continue;
    if (String(raw[0] ?? '').trim().startsWith('#')) continue;   // 설명 · 주석 행
    const line = sheetRow ? sheetRow[r] : r + 1;
    const cells = {}; const flags = {};
    raw.forEach((v, i) => {
      const c = colOf[i];
      if (!c) return;
      const s = String(v ?? '');
      if (c.secret) { if (s.trim() !== '') (flags.secretCols ||= []).push(c.label); return; }
      if (s === CELL_NO_RESULT) { (flags.noResult ||= []).push(c.col); cells[c.col] = ''; return; }
      if (s === CELL_ERROR) { (flags.cellError ||= []).push(c.col); cells[c.col] = ''; return; }
      if (s.length > MAX_CELL) { (flags.tooLong ||= []).push(c.col); cells[c.col] = ''; return; }
      cells[c.col] = unguardCell(s).trim();
    });
    if (sheetRow && merges.some((m) => line >= m.r1 && line <= m.r2)) flags.merged = true;
    rows.push({ line, cells, flags });
  }
  if (rows.length > MAX_ROWS) return { ok: false, code: 'too-many-rows', reason: `데이터 행이 ${MAX_ROWS.toLocaleString()}행을 넘습니다 — 파일을 나눠 올리세요.` };
  if (!rows.length) return { ok: false, code: 'no-rows', reason: '데이터 행이 없습니다.' };
  return { ok: true, format: isXlsx ? 'xlsx' : 'csv', encoding, columns: [...seen.keys()], unknownColumns, secretColumns, rows, fileWarnings };
}
