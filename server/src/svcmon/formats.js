/**
 * 성능점검 대상 다중 포맷 입출력 — CSV·JSON·XLSX 를 한 규약으로 묶는다.
 *
 * 진실의 원천은 `csvio.js` 다: 컬럼 정의(CSV_COLUMNS)·행 그룹핑·검증은 그쪽 하나만 쓴다.
 * 이 모듈은 XLSX/JSON 을 **CSV 와 같은 행 모델로 변환**해 `parseTargetsCsv` 로 흘려보낸다
 * (포맷마다 파서를 따로 두면 검증 규칙이 갈린다). XLSX 읽기·쓰기는 이미 있는 `exceljs`(ipam/
 * excel.js 도 사용)를 재사용한다 — 에어갭 배포에도 이미 번들된 의존성이다.
 */

import { CSV_COLUMNS } from './testSchema.js';
import { csvLine } from '../util/csv.js';
import { targetRows, targetsToCsv, parseTargetsCsv } from './csvio.js';

/** 지원 포맷 — 확장자/형식 파라미터로 이 목록만 받는다. */
export const FORMATS = ['csv', 'json', 'xlsx'];

/** 파일명·MIME. */
export const FORMAT_META = {
  csv: { ext: 'csv', mime: 'text/csv; charset=utf-8' },
  json: { ext: 'json', mime: 'application/json; charset=utf-8' },
  xlsx: { ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
};

/**
 * 대상 목록 → JSON(내보내기). 화면에서 그대로 다시 가져올 수 있게 **정제된 대상 객체**를
 * 담는다(id 제외 — 가져오기가 새로 발급, csvio 규약과 동일). meta 로 컬럼 순서를 함께 실어
 * 사람이 편집할 때 참고하게 한다.
 */
export function targetsToJson(targets, { includeTests = true } = {}) {
  const items = targets.map((t) => {
    const o = { kind: t.kind, path: t.path, name: t.name, host: t.host, enabled: t.enabled !== false };
    if (includeTests) {
      o.tests = (t.tests || []).map((x) => {
        const { id, tpl, tplKey, ...rest } = x;   // id·태그는 왕복에서 새로 발급/부여
        return rest;
      });
    }
    return o;
  });
  return JSON.stringify({ v: 1, columns: CSV_COLUMNS, exportedAt: null, count: items.length, targets: items }, null, 2);
}

/** 대상 목록 → XLSX 워크북 버퍼(내보내기). CSV 와 같은 컬럼·행. */
export async function targetsToXlsx(targets, { includeTests = true, sheetName = '성능점검 대상' } = {}) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  let first = true;
  for (const cells of targetRows(targets, { includeTests })) {
    const row = ws.addRow(cells);
    if (first) { row.font = { bold: true }; first = false; }
  }
  ws.columns.forEach((c) => { c.width = 16; });
  return wb.xlsx.writeBuffer();
}

/**
 * JSON 텍스트 → CSV 텍스트. `{targets:[...]}` 또는 대상 배열을 받아 csvio 가 파싱할 CSV 로
 * 변환한다(검증·그룹핑을 csvio 하나로 통일). 점검 있는 대상은 점검 1건=1행으로 펼친다.
 */
function jsonToCsv(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error(`JSON 파싱 실패: ${e.message}`); }
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.targets) ? parsed.targets : null);
  if (!arr) throw new Error("JSON 형식이 올바르지 않습니다(대상 배열 또는 {targets:[...]}).");
  // 대상 객체를 targetRows 가 받는 모양으로 정규화(tests 배열 유지)해 그대로 셀 행으로 편다.
  const lines = [];
  let i = 0;
  for (const cells of targetRows(arr, { includeTests: true })) {
    if (i === 0) { i += 1; continue; }   // 첫 yield 는 헤더 — 아래에서 BOM 과 함께 다시 넣는다
    lines.push(csvLine(cells));
    i += 1;
  }
  return `﻿${csvLine(CSV_COLUMNS)}\r\n${lines.join('\r\n')}\r\n`;
}

/** XLSX 버퍼 → CSV 텍스트(첫 워크시트). exceljs 로 읽어 셀을 문자열화한 뒤 CSV 로 재조립. */
async function xlsxToCsv(buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { throw new Error(`XLSX 파싱 실패: ${e.message}`); }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('XLSX 에 시트가 없습니다.');
  const lines = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    // exceljs 는 1-based·values[0] 은 비어 있다. 셀 값을 문자열로(수식/객체는 text 우선).
    const cells = [];
    const last = row.cellCount;
    for (let c = 1; c <= last; c += 1) {
      const v = row.getCell(c).value;
      let s;
      if (v === null || v === undefined) s = '';
      else if (typeof v === 'object') s = String(v.text ?? v.result ?? v.hyperlink ?? '');
      else s = String(v);
      cells.push(s);
    }
    lines.push(csvLine(cells));
  });
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * 어떤 포맷이든 대상 파싱 결과로 — csvio.parseTargetsCsv 와 동일한 반환 모양
 * `{targets, errors, unknownColumns, rowCount}`. JSON·XLSX 는 CSV 로 변환 후 같은 파서를 탄다.
 *
 * @param {string|Buffer} input  csv/json=문자열, xlsx=Buffer
 * @param {'csv'|'json'|'xlsx'} format
 * @param {{maxRows?:number}} opts
 */
export async function parseTargetsAny(input, format, opts = {}) {
  const fmt = FORMATS.includes(format) ? format : 'csv';
  let csv;
  if (fmt === 'csv') csv = typeof input === 'string' ? input : input.toString('utf8');
  else if (fmt === 'json') csv = jsonToCsv(typeof input === 'string' ? input : input.toString('utf8'));
  else csv = await xlsxToCsv(Buffer.isBuffer(input) ? input : Buffer.from(input));
  return parseTargetsCsv(csv, opts);
}

/** 대상 목록을 요청 포맷으로 직렬화 — 라우트가 그대로 응답에 실을 값(문자열 또는 Buffer). */
export async function serializeTargets(targets, format, opts = {}) {
  const fmt = FORMATS.includes(format) ? format : 'csv';
  if (fmt === 'csv') return targetsToCsv(targets, opts);
  if (fmt === 'json') return targetsToJson(targets, opts);
  return targetsToXlsx(targets, opts);
}

/* ── 수동 IP 매핑(이름↔IP) 템플릿·파싱 ── */

export const HOSTMAP_COLUMNS = ['host_name', 'ip'];

/** 수동 매핑 CSV 템플릿(내보내기·다운로드). names 를 주면 그 이름들을 채워 준다(IP 는 빈칸). */
export function hostMapTemplateCsv(names = []) {
  const lines = [csvLine(HOSTMAP_COLUMNS)];
  const rows = names.length ? names : ['lesasbpdp01', 'lesasbpdp02', 'lesasbpdp03'];
  for (const n of rows) lines.push(csvLine([n, '']));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** 이름↔IP 매핑을 CSV 로(현재 표 내보내기). */
export function hostMapToCsv(pairs = []) {
  const lines = [csvLine(HOSTMAP_COLUMNS)];
  for (const p of pairs) lines.push(csvLine([p.name ?? '', p.ip ?? '']));
  return `﻿${lines.join('\r\n')}\r\n`;
}

/**
 * 수동 매핑 파일(csv/json/xlsx) → `{ pairs:[{name,ip}], errors, rowCount }`.
 * 헤더는 host_name/name/이름, ip/주소 를 유연히 인식한다(엑셀에서 손으로 만든 파일 대비).
 */
export async function parseHostMapAny(input, format) {
  const fmt = FORMATS.includes(format) ? format : 'csv';
  if (fmt === 'json') {
    let parsed;
    try { parsed = JSON.parse(typeof input === 'string' ? input : input.toString('utf8')); }
    catch (e) { return { pairs: [], errors: [`JSON 파싱 실패: ${e.message}`], rowCount: 0 }; }
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.pairs) ? parsed.pairs : []);
    const pairs = arr.map((x) => ({ name: String(x.name ?? x.host_name ?? '').trim(), ip: String(x.ip ?? '').trim() }))
      .filter((x) => x.name || x.ip);
    return { pairs, errors: [], rowCount: pairs.length };
  }
  // csv/xlsx → CSV 텍스트 후 경량 파싱
  const { parseCsvRows, unguardCell } = await import('../util/csv.js');
  let csv;
  if (fmt === 'csv') csv = typeof input === 'string' ? input : input.toString('utf8');
  else csv = await xlsxToCsv(Buffer.isBuffer(input) ? input : Buffer.from(input));
  let rows;
  try { rows = parseCsvRows(csv, { maxRows: 5000, maxCell: 300 }); }
  catch (e) { return { pairs: [], errors: [e.message], rowCount: 0 }; }
  if (!rows.length) return { pairs: [], errors: ['내용이 없습니다.'], rowCount: 0 };
  const header = rows[0].map((h) => unguardCell(h).trim().toLowerCase());
  const nameIdx = header.findIndex((h) => ['host_name', 'name', '이름', 'hostname', '호스트'].includes(h));
  const ipIdx = header.findIndex((h) => ['ip', '주소', 'address'].includes(h));
  // 헤더가 없으면 첫 두 열을 name,ip 로 본다(헤더 없이 붙여넣는 경우 대비).
  const ni = nameIdx >= 0 ? nameIdx : 0;
  const ii = ipIdx >= 0 ? ipIdx : 1;
  const body = (nameIdx >= 0 || ipIdx >= 0) ? rows.slice(1) : rows;
  const pairs = body.map((r) => ({
    name: unguardCell(r[ni] ?? '').trim(),
    ip: unguardCell(r[ii] ?? '').trim(),
  })).filter((x) => x.name || x.ip);
  return { pairs, errors: [], rowCount: pairs.length };
}
