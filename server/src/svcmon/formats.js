/**
 * 성능점검 대상 다중 포맷 입출력 — CSV·JSON·XLSX 를 한 규약으로 묶는다.
 *
 * 진실의 원천은 `csvio.js` 다: 컬럼 정의(CSV_COLUMNS)·행 그룹핑·검증은 그쪽 하나만 쓴다.
 * 이 모듈은 XLSX/JSON 을 **CSV 와 같은 행 모델로 변환**해 `parseTargetsCsv` 로 흘려보낸다
 * (포맷마다 파서를 따로 두면 검증 규칙이 갈린다). XLSX 읽기·쓰기는 이미 있는 `exceljs`(ipam/
 * excel.js 도 사용)를 재사용한다 — 에어갭 배포에도 이미 번들된 의존성이다.
 */

import { envPositive } from '../util/envNumber.js';   // 99회차: env 수치는 공용 해석기로(Infinity · 음수 · 숫자 아님 → 기본값)
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
export const XLSX_MAX_UNCOMPRESSED = envPositive(process.env.SVCMON_XLSX_MAX_UNCOMPRESSED_BYTES, 64 * 1024 * 1024);
export const XLSX_MAX_ENTRIES = 5_000;

/*
 * 154회차 Z1(재현 — EOCD 의 항목 수 두 바이트를 18 → 1 로 바꾸니 아래 세 사전 점검이 첫 항목만 보고 통과했고, JSZip(exceljs)은 18개를 전부 읽어 80MB 항목을 풀었다):
 *   사전 점검은 **JSZip 이 읽는 것과 같은 항목 집합**을 봐야 한다 — 다르게 읽는 순간 '점검한 파일' 과 '로드되는 파일' 이 갈린다(parser differential).
 *   JSZip 3.10(lib/zipEntries.js)은 ① 중앙 디렉터리를 **서명이 이어지는 동안** 읽고 선언 개수와 달라도 던지지 않으며(하나도 못 찾았을 때만 던진다)
 *   ② `EOCD 위치 − (중앙 디렉터리 시작 + 크기)` 가 양수면 **모든 offset 을 그만큼 밀어** 읽는다(앞에 덧붙은 데이터 — 절대 offset 자리에 가짜 중앙 디렉터리를 둘 수 있다).
 *   그래서 읽기를 하나로 모으고(예전에는 세 함수가 각자 선언 개수만큼 돌았다) 엄격하게 본다: 서명이 이어지는 동안 읽되 **중앙 디렉터리가 EOCD 바로 앞에서 정확히 끝나고
 *   읽은 수 = 선언 수**일 때만 받는다(밀린 offset · 개수 불일치 · 사이의 잉여 바이트는 손상으로 거부 — 엑셀 · LibreOffice · exceljs 가 쓰는 파일은 전부 이 꼴이다).
 *   회귀 server/test/full154.test.js(실제 JSZip 과 항목 수 대조).
 * 반환: { ok:true, count, entries:[{ method, csize, usize, lho, nameAt, nameLen }] } | { ok:false, reason:'no-eocd'|'zip64'|'bad-cd'|'too-many-entries', entries? }
 */
function zipCentral(buf, { maxEntries = XLSX_MAX_ENTRIES } = {}) {
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
  // zip64 표지는 JSZip 과 같은 칸 전부(디스크 번호 둘 · 이 디스크의 항목 수 포함) — 하나라도 서면 JSZip 은 zip64 기록을 따로 찾아 읽는다.
  if (count === 0xffff || buf.readUInt16LE(eocd + 4) === 0xffff || buf.readUInt16LE(eocd + 6) === 0xffff || buf.readUInt16LE(eocd + 8) === 0xffff
    || cdSize === 0xffffffff || cdOff === 0xffffffff) return { ok: false, reason: 'zip64' };
  if (count > maxEntries) return { ok: false, reason: 'too-many-entries', entries: count };
  if (cdOff + cdSize !== eocd) return { ok: false, reason: 'bad-cd' };   // 크면 JSZip 도 던진다 · 작으면 JSZip 은 offset 을 민다 — 따라가지 않고 거부
  const entries = [];
  let p = cdOff;
  while (p + 4 <= eocd && buf.readUInt32LE(p) === 0x02014b50) {
    if (p + 46 > eocd) return { ok: false, reason: 'bad-cd' };
    if (entries.length >= maxEntries) return { ok: false, reason: 'too-many-entries', entries: entries.length + 1 };
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (next > eocd) return { ok: false, reason: 'bad-cd' };
    entries.push({ method: buf.readUInt16LE(p + 10), csize: buf.readUInt32LE(p + 20), usize: buf.readUInt32LE(p + 24), lho: buf.readUInt32LE(p + 42), nameAt: p + 46, nameLen, extraAt: p + 46 + nameLen, extraLen: buf.readUInt16LE(p + 30) });
    p = next;
  }
  if (p !== eocd || entries.length !== count) return { ok: false, reason: 'bad-cd' };   // 선언 개수 ≠ 실제 · 끝이 EOCD 가 아님
  return { ok: true, count, entries };
}

/**
 * zip 버퍼의 중앙 디렉터리를 읽어 선언된 압축 해제 크기 합을 돌려준다(순수 — 압축을 풀지 않는다).
 * 반환: { ok:true, entries, total } | { ok:false, reason:'no-eocd'|'zip64'|'bad-cd'|'too-many-entries' }
 */
export function zipDeclaredSize(buf, { maxEntries = XLSX_MAX_ENTRIES } = {}) {
  const z = zipCentral(buf, { maxEntries });   // 154회차 Z1: 항목은 JSZip 과 같은 집합(선언 개수를 믿지 않는다)
  if (!z.ok) return z;
  let total = 0;
  for (const e of z.entries) {
    if (e.usize === 0xffffffff) return { ok: false, reason: 'zip64' };
    total += e.usize;
  }
  return { ok: true, entries: z.entries.length, total };
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
  const z = zipCentral(buf);   // 154회차 Z1: 선언 개수만큼이 아니라 JSZip 이 읽는 항목 전부
  if (!z.ok) return { ok: false, reason: z.reason === 'too-many-entries' ? 'bad-cd' : z.reason };
  let total = 0;
  for (const { method, csize, lho } of z.entries) {
    if (csize === 0xffffffff || lho === 0xffffffff) return { ok: false, reason: 'zip64' };
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

/**
 * 7b 감사 M-4: exceljs 는 로드할 때 시트의 mergeCell 을 **칸 단위로 전개**한다 — `<mergeCell ref="A1:XFD1048576"/>` 한 줄이 수십억 칸을 만든다(압축 해제 크기 상한으로는 막히지 않는다).
 * 로드 **전에** 시트 XML 을 직접 풀어(예산 상한) mergeCell 개수 · 넓이 합을 센다. 이 파일의 두 파서(svcmon 가져오기 · 7b 서버 등록)가 같은 함수를 쓴다.
 *
 * 154회차 Z2 · Z3(재현):
 *  Z2 예전 정규식(`<mergeCell\s+ref="A1:B2"`)은 **표기 하나**만 알았다 — XML 로는 같은 뜻인 작은따옴표 · 등호 주변 공백 · ref 앞의 다른 속성 · `$A$1` · 문자 참조(`&#90;`)는
 *     세지 못했는데 exceljs(saxes)는 전부 병합으로 읽어 전개했다(5종 실측). 시트 이름 거르기(`^xl/worksheets/…\.xml$`)도 exceljs 의 앵커 없는 판정보다 좁았다
 *     (앞의 `/` · 접두 · 접미). 이제 태그의 속성을 XML 문법대로 읽고(따옴표 둘 · 공백 · 순서 무관) **해석하지 못한 표기는 세지 않고 거부한다**(fail-closed) · 이름은 넓게(`worksheets/` 포함).
 *  Z3 exceljs 4.4 는 `<dataValidation sqref="A1:XFD1048576">` 도 칸마다 전개한다(data-validations-xform.js — 6KB 파일 · 416만 칸에 5.6초 · 힙 +351MB 실측 · 전체 시트면 OOM).
 *     가져오기는 유효성 검사를 읽지 않는다 — svcmon 은 exceljs 에 `ignoreNodes: ['dataValidations']` 를 주어 아예 읽지 않고(동작 변화 없음), 그 옵션 없이 로드하는 호출부를 위해
 *     이 사전 점검이 넓이 합(XLSX_MAX_VALIDATION_AREA — 전체 열 하나는 통과)을 본다.
 * 속성 읽기 · 범위 해석은 문자 단위 한 번 훑기 + 길이 상한이 있는 앵커 정규식이라 선형이다.
 */
export const XLSX_MAX_MERGES = 2_000;
export const XLSX_MAX_MERGE_AREA = 200_000;
/** 유효성 검사(드롭다운 등) 범위 넓이 합 상한 — 전체 열 하나(1,048,576칸 · 로드 약 1.1초 · 힙 약 110MB 실측)까지. `ignoreNodes` 로 읽지 않는 호출부는 보지 않는다. */
export const XLSX_MAX_VALIDATION_AREA = 1_100_000;
const colNum = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n; };
const isXmlWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const ATTR_MAX = 64;          // 태그 하나의 속성 수 상한(넘으면 해석 실패)
const ATTR_NAME_MAX = 64;
/** 태그 이름 바로 뒤(i)부터 속성을 읽는다 — `이름 = "값"` · `이름='값'` · 공백 자유. 문법이 어긋나면 null(해석 실패). */
function readXmlAttrs(text, i) {
  const out = Object.create(null);
  for (let n = 0; n <= ATTR_MAX; n += 1) {
    while (isXmlWs(text[i])) i += 1;
    const c = text[i];
    if (c === undefined) return null;
    if (c === '>' || c === '/') return out;
    let j = i;
    while (j < text.length && j - i <= ATTR_NAME_MAX && !isXmlWs(text[j]) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/' && text[j] !== '"' && text[j] !== "'") j += 1;
    if (j === i || j - i > ATTR_NAME_MAX) return null;
    const name = text.slice(i, j);
    i = j;
    while (isXmlWs(text[i])) i += 1;
    if (text[i] !== '=') return null;
    i += 1;
    while (isXmlWs(text[i])) i += 1;
    const q = text[i];
    if (q !== '"' && q !== "'") return null;
    const end = text.indexOf(q, i + 1);
    if (end < 0) return null;
    out[name] = text.slice(i + 1, end);
    i = end + 1;
  }
  return null;
}
/** `<tag` 뒤가 이름의 끝(공백 · / · >)인 자리마다 속성을 읽어 넘긴다(`<mergeCells` 는 `<mergeCell` 이 아니다). onTag 가 false 를 주면 멈추고 false. */
function eachXmlTag(text, tag, onTag) {
  const open = `<${tag}`;
  let i = 0;
  for (;;) {
    i = text.indexOf(open, i);
    if (i < 0) return true;
    i += open.length;
    const c = text[i];
    if (c !== undefined && !isXmlWs(c) && c !== '/' && c !== '>') continue;
    if (onTag(readXmlAttrs(text, i)) === false) return false;
  }
}
const CELL_REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;
/** 범위 하나(`A1` · `A1:B2` · `$A$1:$B$2`)의 넓이. 그 밖의 표기(문자 참조 · 시트 접두 · 열/행 전체)는 null — 세지 못한 것을 0 으로 두지 않는다. */
function rangeArea(tok) {
  const k = tok.indexOf(':');
  const a = CELL_REF_RE.exec(k < 0 ? tok : tok.slice(0, k));
  const b = k < 0 ? a : CELL_REF_RE.exec(tok.slice(k + 1));
  if (!a || !b) return null;
  return (Math.abs(colNum(b[1].toUpperCase()) - colNum(a[1].toUpperCase())) + 1) * (Math.abs(Number(b[2]) - Number(a[2])) + 1);
}
const RANGE_TOKEN_MAX = 32;   // `$XFD$1048576:$XFD$1048576` 이 25자
/**
 * @returns {{ok:true, merges:number, area:number, over:boolean, unparsed:number, dvArea:number, dvOver:boolean, dvUnparsed:number}|{ok:false, reason:string}}
 *   over = 병합 개수 · 넓이 상한 초과 · unparsed = 해석하지 못한 병합 표기 수 · dv* = 유효성 검사 범위(넓이 합 · 상한 초과 · 해석 못 함).
 *   상한을 넘는 순간 멈춘다(그 뒤는 세지 않는다 — 수치는 하한).
 */
export function xlsxMergeStats(buf, { maxUncompressed = XLSX_MAX_UNCOMPRESSED } = {}) {
  const z = zipCentral(buf);   // 154회차 Z1
  if (!z.ok) return { ok: false, reason: z.reason === 'too-many-entries' ? 'bad-cd' : z.reason };
  const st = { ok: true, merges: 0, area: 0, over: false, unparsed: 0, dvArea: 0, dvOver: false, dvUnparsed: 0 };
  let budget = maxUncompressed;
  for (const { method, csize, lho, nameAt, nameLen, extraAt, extraLen } of z.entries) {
    if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) return { ok: false, reason: 'bad-entry' };
    const localNameLen = buf.readUInt16LE(lho + 26);
    const start = lho + 30 + localNameLen + buf.readUInt16LE(lho + 28);
    if (start + csize > buf.length) return { ok: false, reason: 'bad-entry' };
    // exceljs 는 이름 어디든 `xl/worksheets/sheet<수>.xml` 이 있으면 시트로 읽는다(앵커 없음 · 앞의 `/` 는 뗀다) — 그보다 넓게 본다.
    // 159회차(재현 — 각 6KB 급 파일로 이 점검을 건너뛰고 병합 폭탄이 로드됐다): **JSZip 은 항목 이름을 중앙 디렉터리가 아니라 로컬 머리말에서 읽고**
    //   (zipEntry.js readCentralPart 는 이름을 건너뛴다), 중앙 디렉터리 extra 에 Unicode Path(0x7075)가 있으면 그 이름으로 바꾼다. 중앙 디렉터리 이름만 보면
    //   '점검한 이름' 과 '로드되는 이름' 이 갈린다 → 두 이름 가운데 하나라도 시트 꼴이거나 Unicode Path 표지(바이트 75 70 — TLV 를 다시 해석하지 않고 넓게)가 있으면 본다.
    const isSheetName = buf.toString('latin1', nameAt, nameAt + nameLen).includes('worksheets/')
      || buf.toString('latin1', lho + 30, lho + 30 + localNameLen).includes('worksheets/')
      || buf.subarray(extraAt, extraAt + extraLen).includes('\x75\x70', 0, 'latin1');
    if (!isSheetName) continue;
    let xml;
    try { xml = method === 0 ? buf.subarray(start, start + csize) : method === 8 ? zlib.inflateRawSync(buf.subarray(start, start + csize), { maxOutputLength: budget + 1 }) : null; }
    catch { return { ok: false, reason: 'too-large' }; }
    if (!xml) return { ok: false, reason: 'method' };
    budget -= xml.length;
    if (budget < 0) return { ok: false, reason: 'too-large' };
    const text = xml.toString('latin1');
    const done = eachXmlTag(text, 'mergeCell', (attrs) => {
      st.merges += 1;
      const a = attrs && typeof attrs.ref === 'string' && attrs.ref.length <= RANGE_TOKEN_MAX ? rangeArea(attrs.ref) : null;
      if (a == null) st.unparsed += 1; else st.area += a;
      if (st.merges > XLSX_MAX_MERGES || st.area > XLSX_MAX_MERGE_AREA) { st.over = true; return false; }
      return true;
    });
    if (!done) return st;
    const dvDone = eachXmlTag(text, 'dataValidation', (attrs) => {
      const sq = attrs && typeof attrs.sqref === 'string' ? attrs.sqref : null;
      if (sq == null) { st.dvUnparsed += 1; return true; }
      // sqref 는 공백으로 나눈 범위 목록(예 `E4:L9 N4:U9`) — 토큰을 한 번에 배열로 만들지 않고 차례로 읽는다(수십 MB 속성값 대비)
      let i = 0;
      while (i < sq.length) {
        while (isXmlWs(sq[i])) i += 1;
        let j = i;
        while (j < sq.length && !isXmlWs(sq[j])) j += 1;
        if (j === i) break;
        const a = j - i <= RANGE_TOKEN_MAX ? rangeArea(sq.slice(i, j)) : null;
        if (a == null) st.dvUnparsed += 1; else st.dvArea += a;
        if (st.dvArea > XLSX_MAX_VALIDATION_AREA) { st.dvOver = true; return false; }
        i = j;
      }
      return true;
    });
    if (!dvDone) return st;
  }
  return st;
}
/**
 * 로드 전 판정 — 넘거나 해석하지 못하면 던진다. `dataValidations: 'ignored'` 는 exceljs 에 `ignoreNodes: ['dataValidations']` 를 주는 호출부만 쓴다
 *   (그 노드를 읽지 않으므로 넓은 유효성 범위도 해가 없다 — 전체 열 드롭다운이 든 정상 파일을 거부하지 않게).
 */
export function assertXlsxMergesOk(buf, { dataValidations = 'check' } = {}) {
  const r = xlsxMergeStats(buf);
  // 154회차: 점검 자체를 못 했으면 통과가 아니다(예전에는 그대로 exceljs 로 넘겼다 — 두 호출부 모두 크기 점검이 먼저라 정상 파일은 여기 오지 않는다).
  if (!r.ok) throw new Error('XLSX 파싱 실패: zip 구조를 읽지 못했습니다(엑셀 파일이 맞는지 확인하세요).');
  if (r.over) throw new Error(`XLSX 의 병합 셀이 너무 많거나 넓습니다(병합 ${XLSX_MAX_MERGES.toLocaleString()}개 · 넓이 ${XLSX_MAX_MERGE_AREA.toLocaleString()}칸 상한) — 병합을 풀고 값만 저장하세요.`);
  if (r.unparsed) throw new Error(`XLSX 의 병합 셀 표기를 해석하지 못했습니다(${r.unparsed.toLocaleString()}곳 — 넓이를 확인할 수 없는 병합은 받지 않습니다) — 병합을 풀고 값만 저장하세요.`);
  if (dataValidations !== 'ignored' && (r.dvOver || r.dvUnparsed)) {
    throw new Error(r.dvOver
      ? `XLSX 의 데이터 유효성 검사(드롭다운 등) 범위가 너무 넓습니다(넓이 합 ${XLSX_MAX_VALIDATION_AREA.toLocaleString()}칸 상한) — 유효성 검사를 지우거나 범위를 실제 행까지로 줄여 저장하세요.`
      : `XLSX 의 데이터 유효성 검사 범위 표기를 해석하지 못했습니다(${r.dvUnparsed.toLocaleString()}곳) — 유효성 검사를 지우고 값만 저장하세요.`);
  }
  return r;
}

/** 엑셀 시트의 마지막 행 번호 — 이보다 큰 행 번호는 엑셀이 쓰지 않는다(손상 · 조작). */
export const XLSX_SHEET_MAX_ROW = 1_048_576;
/**
 * 값만 읽는 가져오기(svcmon 대상 · 수동 IP 매핑 · 7b 서버 등록)가 exceljs 로 통합 문서를 로드하는 **한 곳**. 사전 점검(assertXlsxSizeOk · assertXlsxMergesOk) 뒤에 부른다.
 * 159회차(재현 — 154 가 막은 병합 · 유효성 검사 밖에도 exceljs 4.4 가 범위 · 번호를 그대로 전개하는 경로가 셋 더 있었다. 각 6KB 급 파일 · 힙 256MB 자식 프로세스):
 *  ① 정의된 이름(`xl/workbook.xml` 의 `<definedName>s!$A$1:$XFD$1048576</definedName>`) — `workbook.model =` 이 범위를 칸마다 CellMatrix 에 넣는다(1초 안에 힙 고갈 · 열 하나 104만 칸도 +309MB).
 *     무시 옵션이 없어 파싱 결과에서 뺀다(가져오기는 이름 정의를 쓰지 않는다 · 인쇄 영역도 여기서 나온다). exceljs 의 그 함수가 사라지면 **조용히 지나가지 않고 던진다**.
 *  ② 열 정의(`<col min="1" max="2000000000">`) — `Column.fromModel` 이 max 까지 Column 객체를 만든다(1.5초 안에 힙 고갈) → `ignoreNodes`(열 너비 · 숨김은 쓰지 않는다).
 *  ③ 행 번호(`<row r="4294967295">`) — 로드는 빠르지만 `eachRow` 가 길이 42억짜리 성긴 배열을 forEach 로 돈다(40초 넘게 이벤트 루프 정지 · r=1억이면 3.9초) → 돌기 전에 `rowCount` 로 거부.
 *  유효성 검사(154 Z3)도 여기서 읽지 않는다. 호출부가 각자 옵션을 주면 한쪽이 빠진다(154 의 '남은 호출부' — 메인이 따로 고쳤다) — 새 가져오기도 이 함수를 쓴다.
 */
export async function loadXlsxValues(buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const reader = wb.xlsx;
  const parseWorkbook = reader.parseWorkbook;
  if (typeof parseWorkbook !== 'function') throw new Error('exceljs 로더가 바뀌었습니다(parseWorkbook 없음) — 이름 정의를 걸러낼 수 없어 읽지 않습니다.');
  reader.parseWorkbook = async function parseWorkbookWithoutNames(stream) {
    const model = await parseWorkbook.call(this, stream);
    if (model) model.definedNames = [];
    return model;
  };
  await reader.load(buffer, { ignoreNodes: ['dataValidations', 'cols'] });
  for (const ws of wb.worksheets) {
    if (ws.rowCount > XLSX_SHEET_MAX_ROW) throw new Error(`행 번호가 엑셀 범위(${XLSX_SHEET_MAX_ROW.toLocaleString()}행)를 넘습니다 — 손상된 파일입니다.`);
  }
  return wb;
}

async function xlsxToCsv(buffer) {
  assertXlsxSizeOk(buffer);
  assertXlsxMergesOk(buffer, { dataValidations: 'ignored' });   // 7b 감사 M-4 — 로드 전에 병합 전개 상한(유효성 검사는 아래에서 읽지 않는다)
  // 154회차 Z3 · 159회차: 유효성 검사 · 이름 정의 · 열 정의는 읽지 않고 행 번호를 확인한다 — loadXlsxValues 하나(가져오기는 칸 값만 쓴다).
  let wb;
  try { wb = await loadXlsxValues(buffer); } catch (e) { throw new Error(`XLSX 파싱 실패: ${e.message}`); }
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
