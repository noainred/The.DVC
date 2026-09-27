/**
 * 성능점검 대상 다중 포맷 입출력 — CSV·JSON·XLSX 를 한 규약으로 묶는다.
 *
 * 진실의 원천은 `csvio.js` 다: 컬럼 정의(CSV_COLUMNS)·행 그룹핑·검증은 그쪽 하나만 쓴다.
 * 이 모듈은 XLSX/JSON 을 **CSV 와 같은 행 모델로 변환**해 `parseTargetsCsv` 로 흘려보낸다
 * (포맷마다 파서를 따로 두면 검증 규칙이 갈린다). XLSX 읽기·쓰기는 이미 있는 `exceljs`(ipam/
 * excel.js 도 사용)를 재사용한다 — 에어갭 배포에도 이미 번들된 의존성이다.
 */

import zlib from 'node:zlib';
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
/** XLSX 재조립 시 폭주 방어 — 행 수 상한. maxBulkRows(2000) 의 넉넉한 배수로 두어 정상 파일엔
 *  영향 없고, 압축폭탄(수백만 행)은 CSV 재조립 단계에서 즉시 끊는다. */
const XLSX_MAX_ROWS = 50_000;
const XLSX_MAX_COLS = 200;

/**
 * v2.629 SEC2629-09: exceljs 는 시트 전체를 먼저 풀어 파싱한 뒤에야 위 행 상한을 본다 — 압축 크기 상한(XLSX_MAX_BYTES 8MB)만으로는
 * 수백 배 확장되는 입력이 수 초 루프 정지·수백 MB 힙을 만든다(v2.577 '압축 해제에는 상한' 규약의 누락 지점).
 * 그래서 load 전에 zip 중앙 디렉터리가 **선언한** 압축 해제 크기 합을 본다.
 * v2.630 SEC2630-01: 선언값만 보면 중앙 디렉터리를 거짓으로 쓴 파일(작은 크기를 선언)이 통과해 exceljs(jszip) 가 끝까지
 *   풀었다 — 이제 선언 검사 뒤에 zipInflatedSize 가 실제로 풀어 보며(예산 초과 즉시 중단) 누적 크기를 센다.
 */
export const XLSX_MAX_UNCOMPRESSED = Number(process.env.SVCMON_XLSX_MAX_UNCOMPRESSED_BYTES) || 64 * 1024 * 1024;
export const XLSX_MAX_ENTRIES = 5_000;

/**
 * zip 버퍼의 중앙 디렉터리를 읽어 선언된 압축 해제 크기 합을 돌려준다(순수 — 압축을 풀지 않는다).
 * 반환: { ok:true, entries, total } | { ok:false, reason:'no-eocd'|'zip64'|'bad-cd'|'too-many-entries' }
 */
export function zipDeclaredSize(buf, { maxEntries = XLSX_MAX_ENTRIES } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, reason: 'no-eocd' };
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: 'no-eocd' };
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return { ok: false, reason: 'zip64' };
  if (count > maxEntries) return { ok: false, reason: 'too-many-entries', entries: count };
  if (cdOff + cdSize > eocd) return { ok: false, reason: 'bad-cd' };
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: 'bad-cd' };
    const usize = buf.readUInt32LE(p + 24);
    if (usize === 0xffffffff) return { ok: false, reason: 'zip64' };
    total += usize;
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return { ok: true, entries: count, total };
}

/** 선언 크기 검사 — 문제가 있으면 Error 를 던진다(호출부 xlsxToCsv 가 exceljs 를 로드하기 전에). */
export function assertXlsxSizeOk(buffer, max = XLSX_MAX_UNCOMPRESSED) {
  const z = zipDeclaredSize(buffer);
  if (!z.ok) {
    // no-eocd·bad-cd 는 zip 이 아니거나 깨진 파일이다 — exceljs 가 같은 결론을 내므로 여기서 먼저 알린다.
    if (z.reason === 'too-many-entries') throw new Error(`XLSX 안의 파일 수가 너무 많습니다(${z.entries}개 > ${XLSX_MAX_ENTRIES}개).`);
    if (z.reason === 'zip64') throw new Error('XLSX 가 ZIP64 형식입니다(압축 해제 크기가 4GB 급) — 받지 않습니다. 파일을 나눠 올리세요.');
    throw new Error('XLSX 파싱 실패: zip 구조를 읽지 못했습니다(엑셀 파일이 맞는지 확인하세요).');
  }
  if (z.total > max) {
    throw new Error(`XLSX 압축 해제 크기가 너무 큽니다(${Math.round(z.total / 1048576)}MB > ${Math.round(max / 1048576)}MB) — 파일을 나눠 올리세요.`);
  }
  // v2.630 SEC2630-01: 선언값은 거짓일 수 있다 — 실제로 풀어 보며 누적 크기를 센다(exceljs 로드 전).
  const real = zipInflatedSize(buffer, max);
  if (!real.ok) {
    if (real.reason === 'too-large') {
      throw new Error(`XLSX 압축 해제 크기가 너무 큽니다(실제 해제 ${Math.round(max / 1048576)}MB 초과 — 선언 크기 ${Math.round(z.total / 1048576)}MB 와 다릅니다) — 파일을 나눠 올리세요.`);
    }
    if (real.reason === 'method') throw new Error(`XLSX 파싱 실패: 지원하지 않는 압축 방식입니다(${real.method}).`);
    throw new Error('XLSX 파싱 실패: zip 항목을 풀지 못했습니다(엑셀 파일이 맞는지 확인하세요).');
  }
  return { ...z, inflated: real.total };
}

/**
 * v2.630 SEC2630-01: zip 의 각 항목을 실제로 풀어(inflateRawSync + maxOutputLength = 남은 예산 + 1) 누적 해제 크기를 센다.
 * 중앙 디렉터리의 선언 크기를 믿지 않는다 — 선언을 작게 속인 폭탄도 예산을 넘는 순간 멈춘다(끝까지 풀지 않는다).
 * 압축 크기·로컬 헤더 위치는 중앙 디렉터리에서 읽는다(JSZip 과 같은 원천).
 * 반환: { ok:true, total } | { ok:false, reason:'too-large'|'method'|'bad-entry'|'no-eocd'|'bad-cd'|'zip64' }
 */
export function zipInflatedSize(buf, max = XLSX_MAX_UNCOMPRESSED) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) return { ok: false, reason: 'no-eocd' };
  const stop = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= stop; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, reason: 'no-eocd' };
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) return { ok: false, reason: 'zip64' };
  if (cdOff + cdSize > eocd) return { ok: false, reason: 'bad-cd' };
  let p = cdOff;
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, reason: 'bad-cd' };
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const lho = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || lho === 0xffffffff) return { ok: false, reason: 'zip64' };
    p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return { ok: false, reason: 'bad-entry' };
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) return { ok: false, reason: 'bad-entry' };
    const remaining = max - total;
    let size;
    if (method === 0) {
      size = csize;
    } else if (method === 8) {
      try {
        size = zlib.inflateRawSync(buf.subarray(start, start + csize), { maxOutputLength: remaining + 1 }).length;
      } catch (e) {
        if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) return { ok: false, reason: 'too-large' };
        return { ok: false, reason: 'bad-entry' };
      }
    } else {
      return { ok: false, reason: 'method', method };
    }
    total += size;
    if (total > max) return { ok: false, reason: 'too-large' };
  }
  return { ok: true, total };
}

async function xlsxToCsv(buffer) {
  assertXlsxSizeOk(buffer);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buffer); } catch (e) { throw new Error(`XLSX 파싱 실패: ${e.message}`); }
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('XLSX 에 시트가 없습니다.');
  const lines = [];
  let rowN = 0;
  let stop = null;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (stop) return;
    if (++rowN > XLSX_MAX_ROWS) { stop = new Error(`XLSX 행이 너무 많습니다(${XLSX_MAX_ROWS} 초과) — 파일을 나눠 올리세요.`); return; }
    // exceljs 는 1-based·values[0] 은 비어 있다. 셀 값을 문자열로(수식/객체는 text 우선).
    const cells = [];
    const last = Math.min(row.cellCount, XLSX_MAX_COLS);
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
  if (stop) throw stop;
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
