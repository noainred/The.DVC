/**
 * 전체 점검 159회차 — 3축 반증(154회차 XLSX 사전 점검) + 이어 읽기 회귀 고정.
 *
 *  반증 ①(회귀 없음 확인) 154 가 zip 판정을 엄격하게 바꿨다(중앙 디렉터리 끝 = EOCD · 읽은 수 = 선언 수 · 해석 못 한 표기 거부). 실제 제품이 쓰는 꼴
 *        (zip 주석 · data descriptor · 저장(STORE) 항목 · extra field · 폴더 항목 · 끝의 잉여 줄바꿈 / 시트 XML 의 CRLF · 속성 순서 · 여러 범위 sqref · 열 · 행 전체 sqref · x14 유효성)을
 *        두 가져오기가 그대로 읽는다. (openpyxl 3.1.5 · LibreOffice 로 쓴 실제 파일은 점검 때 따로 확인했다 — 시험에는 꼴만 조립해 고정한다.)
 *  X4(높음) svcmon/formats.js xlsxMergeStats — 시트 거르기가 **중앙 디렉터리의 이름**만 봤다. JSZip 은 이름을 로컬 머리말에서 읽는다 → 중앙 디렉터리 이름만
 *        다른 글자로 바꾼 6KB 파일이 병합 사전 점검을 건너뛰고(merges:0) 병합 폭탄이 로드됐다(힙 256MB 자식 2.2초 뒤 중단).
 *  X5(높음) 같은 함수 — 중앙 디렉터리 extra 의 Unicode Path(0x7075)로 이름을 바꾼 시트도 같았다(JSZip 은 그 이름을 쓴다).
 *  X1(높음) exceljs 가 정의된 이름(`xl/workbook.xml` definedName) 범위를 칸마다 전개한다(CellMatrix) — 6KB 파일 · 1초 안에 힙 고갈. → 로드에서 뺀다.
 *  X2(높음) exceljs 가 `<col min max>` 를 max 까지 Column 객체로 만든다 — 6KB 파일 · 1.5초 안에 힙 고갈. → ignoreNodes.
 *  X3(높음) `<row r="4294967295">` — 로드는 빠르지만 eachRow 가 42억 길이 성긴 배열을 돈다(40초 넘게 정지). → 돌기 전에 rowCount 로 거부.
 *  세 경로는 값만 읽는 로더 하나(`loadXlsxValues`)가 막는다 — 두 가져오기(svcmon · 7b 서버 등록)가 그 함수만 쓴다(소스 스윕).
 *  멈춤 · 힙 고갈은 **자식 프로세스 + 시한 + 힙 256MB** 로 고정한다(수정 전 판본이면 신호로 죽거나 시한 초과 — 시험 러너가 멈추지 않게).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');
const FORMATS = path.join(SRC, 'svcmon', 'formats.js');
const ONBOARD = path.join(SRC, 'bmusage', 'onboard', 'importParse.js');
const reqHere = createRequire(import.meta.url);
const JSZip = createRequire(reqHere.resolve('exceljs'))('jszip');   // exceljs 가 실제로 쓰는 그 JSZip

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'full159-'));
test.after(() => { try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } });

/* ── 재료: exceljs 가 쓴 작은 통합 문서를 항목 목록으로(시트 · workbook.xml 을 고칠 수 있게) ── */
async function parts({ sheet = (s) => s, book = (s) => s } = {}) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  // 머리글 하나로 두 가져오기를 다 읽는다: 수동 IP 매핑은 name · address 를, 서버 등록은 name · corp · os_host 를 본다(address 는 서버 등록에서 모르는 열 — 무시).
  ws.addRow(['name', 'address', 'corp', 'os_host']);
  ws.addRow(['srv-01', '10.0.0.1', 'vc-kr', '10.0.0.1']);
  const zip = await JSZip.loadAsync(Buffer.from(await wb.xlsx.writeBuffer()));
  const out = [];
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue;
    let data = await zip.files[name].async('nodebuffer');
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) data = Buffer.from(sheet(data.toString('utf8')), 'utf8');
    if (name === 'xl/workbook.xml') data = Buffer.from(book(data.toString('utf8')), 'utf8');
    out.push({ name, data });
  }
  return out;
}
const afterData = (x) => (s) => s.replace('</sheetData>', `</sheetData>${x}`);
const beforeData = (x) => (s) => s.replace('<sheetData>', `${x}<sheetData>`);
const addRow = (x) => (s) => s.replace('</sheetData>', `${x}</sheetData>`);
const withNames = (x) => (s) => s.replace('</sheets>', `</sheets><definedNames>${x}</definedNames>`);
const isSheet = (n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n);

const CRC_T = (() => { const t = []; for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC_T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

/**
 * 작은 zip 조립기 — 실제 작성기들이 내는 꼴을 고른다.
 *   store(저장) · dataDescriptor(bit 3 — 로컬 머리말의 크기 · CRC 는 0, 본문 뒤에 기술자) · extra(로컬 · 중앙 양쪽 extra field) · dirs(폴더 항목) · comment(EOCD 주석) · tail(끝의 잉여 바이트)
 *   cdName(name) → 중앙 디렉터리에만 쓰는 이름 · localName(name) → 로컬 머리말에만 쓰는 이름 · cdExtra(name, rawLocalName) → 중앙 디렉터리 extra
 */
function zipOf(entries, { store = false, dataDescriptor = false, extra = Buffer.alloc(0), dirs = false, comment = Buffer.alloc(0), tail = Buffer.alloc(0),
  cdName = (n) => n, localName = (n) => n, cdExtra = () => null } = {}) {
  const list = [];
  if (dirs) {
    const seen = new Set();
    for (const { name } of entries) {
      const segs = name.split('/').slice(0, -1);
      for (let k = 1; k <= segs.length; k += 1) { const d = `${segs.slice(0, k).join('/')}/`; if (!seen.has(d)) { seen.add(d); list.push({ name: d, data: Buffer.alloc(0), dir: true }); } }
    }
  }
  list.push(...entries);
  const body = []; const cds = []; let off = 0;
  for (const e of list) {
    const method = store || e.dir ? 0 : 8;
    const comp = method === 0 ? e.data : zlib.deflateRawSync(e.data);
    const crc = crc32(e.data);
    const flag = dataDescriptor && !e.dir ? 0x0008 : 0;
    const ln = Buffer.from(localName(e.name), 'latin1');
    const cn = Buffer.from(cdName(e.name), 'latin1');
    const cx = cdExtra(e.name, ln) || extra;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6); lh.writeUInt16LE(method, 8);
    if (!flag) { lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.data.length, 22); }
    lh.writeUInt16LE(ln.length, 26); lh.writeUInt16LE(extra.length, 28);
    const dd = Buffer.alloc(flag ? 16 : 0);
    if (flag) { dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(comp.length, 8); dd.writeUInt32LE(e.data.length, 12); }
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flag, 8); cd.writeUInt16LE(method, 10); cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(e.data.length, 24); cd.writeUInt16LE(cn.length, 28); cd.writeUInt16LE(cx.length, 30); cd.writeUInt32LE(off, 42);
    body.push(lh, ln, extra, comp, dd); off += 30 + ln.length + extra.length + comp.length + dd.length;
    cds.push(cd, cn, cx);
  }
  const cdBuf = Buffer.concat(cds);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(list.length, 8); eocd.writeUInt16LE(list.length, 10); eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(off, 16); eocd.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...body, cdBuf, eocd, comment, tail]);
}

/** 자식 프로세스(힙 256MB · 시한)에서 실제 가져오기 함수 둘을 돌린다 — 멈춤 · 힙 고갈이 시험 러너를 죽이지 않게. */
function importInChild(buf, { timeoutMs = 20_000 } = {}) {
  const file = path.join(DIR, `c-${Math.random().toString(16).slice(2)}.xlsx`);
  fs.writeFileSync(file, buf);
  const script = `
    import fs from 'node:fs';
    const F = await import(${JSON.stringify(pathToFileURL(FORMATS).href)});
    const I = await import(${JSON.stringify(pathToFileURL(ONBOARD).href)});
    const b = fs.readFileSync(${JSON.stringify(file)});
    const out = {};
    try { const r = await F.parseHostMapAny(b, 'xlsx'); out.hostmap = { pairs: r.pairs, errors: r.errors }; } catch (e) { out.hostmap = { threw: String(e.message).slice(0, 200) }; }
    try { const r = await I.parseOnboardFile(b, { fileName: 'a.xlsx' }); out.onboard = { ok: r.ok, code: r.code || '', reason: String(r.reason || '').slice(0, 200), rows: Array.isArray(r.rows) ? r.rows.map((x) => x.cells) : null }; } catch (e) { out.onboard = { threw: String(e.message).slice(0, 200) }; }
    console.log('RES ' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', script], { timeout: timeoutMs, encoding: 'utf8' });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  return { signal: r.signal, status: r.status, res: line ? JSON.parse(line.slice(4)) : null, err: String(r.stderr || '').slice(-300) };
}
const PAIR = [{ name: 'srv-01', ip: '10.0.0.1' }];
function assertBothRead(r, label) {
  assert.equal(r.signal, null, `${label}: 시한 · 중단 없이 끝나야 한다 — ${r.err}`);
  assert.ok(r.res, `${label}: 결과가 있어야 한다 — ${r.err}`);
  assert.deepEqual(r.res.hostmap, { pairs: PAIR, errors: [] }, `${label}: 수동 IP 매핑이 값 그대로 읽혀야 한다`);
  assert.equal(r.res.onboard.ok, true, `${label}: 서버 등록 가져오기가 거부하면 안 된다 — ${JSON.stringify(r.res.onboard)}`);
  assert.deepEqual(r.res.onboard.rows, [{ name: 'srv-01', corp: 'vc-kr', os_host: '10.0.0.1' }], `${label}: 서버 등록 행이 값 그대로`);
}

test('159 반증 — 154 의 엄격한 zip 판정은 실제 작성기가 내는 꼴(주석 · data descriptor · STORE · extra · 폴더 항목 · 끝 잉여)을 거부하지 않는다', async () => {
  const F = await import('../src/svcmon/formats.js');
  const I = await import('../src/bmusage/onboard/importParse.js');
  const base = await parts();
  const ut = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x01, 0x00, 0xf1, 0x53, 0x65]);   // Info-ZIP 확장 시각(0x5455)
  const shapes = {
    기준: zipOf(base),
    'EOCD 주석': zipOf(base, { comment: Buffer.from('Created by some tool 1.0') }),
    '긴 EOCD 주석': zipOf(base, { comment: Buffer.alloc(4000, 0x78) }),
    'data descriptor(bit 3)': zipOf(base, { dataDescriptor: true }),
    '저장(STORE)': zipOf(base, { store: true }),
    'extra field': zipOf(base, { extra: ut }),
    '폴더 항목': zipOf(base, { dirs: true }),
    '끝의 잉여 줄바꿈': zipOf(base, { tail: Buffer.from('\r\n') }),
  };
  for (const [label, buf] of Object.entries(shapes)) {
    assert.equal(Object.keys((await JSZip.loadAsync(buf)).files).filter(isSheet).length, 1, `${label}: 조립한 zip 을 JSZip 도 읽어야 한다(시험 재료 확인)`);
    const h = await F.parseHostMapAny(buf, 'xlsx');
    assert.deepEqual(h, { pairs: PAIR, errors: [], rowCount: 1 }, `${label}: 수동 IP 매핑`);
    const o = await I.parseOnboardFile(buf, { fileName: 'a.xlsx' });
    assert.equal(o.ok, true, `${label}: 서버 등록 — ${o.reason || ''}`);
    assert.equal(o.rows.length, 1);
  }
});

test('159 반증 — 시트 XML 의 정상 변형(CRLF · 속성 순서 · 한 칸 병합 · 여러 범위 · 열/행 전체 sqref · x14 유효성 · 넓은 조건부 서식/필터)을 거부하지 않는다', async () => {
  const F = await import('../src/svcmon/formats.js');
  const I = await import('../src/bmusage/onboard/importParse.js');
  const x14 = '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations count="1" xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">'
    + '<x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>s!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>F1:F1048576</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>';
  const sheets = {
    'CRLF · 속성 사이 줄바꿈': afterData('<mergeCells count="1">\r\n  <mergeCell\r\n     ref="F8:H9"\r\n  />\r\n</mergeCells>'),
    'ref 앞의 다른 속성': afterData('<mergeCells count="1"><mergeCell xr:uid="{00000000-0001-0000-0000-000000000000}" ref="F8:H9"/></mergeCells>'),
    '한 칸 병합': afterData('<mergeCells count="2"><mergeCell ref="F8:H9"/><mergeCell ref="J8"/></mergeCells>'),
    '여러 범위 sqref': afterData('<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" sqref="F1:F10 H1:H10"><formula1>"a,b"</formula1></dataValidation></dataValidations>'),
    '열 · 행 전체 sqref': afterData('<dataValidations count="2"><dataValidation type="list" sqref="F:F"><formula1>"a,b"</formula1></dataValidation><dataValidation type="list" sqref="1:1"><formula1>"a,b"</formula1></dataValidation></dataValidations>'),
    '전체 열 드롭다운 셋': afterData('<dataValidations count="3">' + ['F', 'G', 'H'].map((c) => `<dataValidation type="list" sqref="${c}1:${c}1048576"><formula1>"a,b"</formula1></dataValidation>`).join('') + '</dataValidations>'),
    'x14 유효성(extLst)': (s) => s.replace('</worksheet>', `${x14}</worksheet>`),
    '넓은 조건부 서식': afterData('<conditionalFormatting sqref="A1:XFD1048576"><cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFF0000"/><color rgb="FF00FF00"/></colorScale></cfRule></conditionalFormatting>'),
    '넓은 자동 필터': afterData('<autoFilter ref="A1:XFD1048576"/>'),
    '열 너비(전체 열)': beforeData('<cols><col min="1" max="16384" width="12" customWidth="1"/></cols>'),
  };
  for (const [label, sheet] of Object.entries(sheets)) {
    const buf = zipOf(await parts({ sheet }));
    const h = await F.parseHostMapAny(buf, 'xlsx');
    assert.deepEqual(h.pairs, PAIR, `${label}: 수동 IP 매핑`);
    const o = await I.parseOnboardFile(buf, { fileName: 'a.xlsx' });
    assert.equal(o.ok, true, `${label}: 서버 등록 — ${o.reason || ''}`);
  }
  // 이름 정의가 든 평범한 파일(필터 범위 · 인쇄 영역 · 사용자 이름) — 값은 그대로 읽힌다
  const named = zipOf(await parts({ book: withNames('<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">s!$A$1:$D$2</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">s!$A$1:$D$2</definedName><definedName name="servers">s!$A$2:$A$2</definedName>') }));
  assert.deepEqual((await F.parseHostMapAny(named, 'xlsx')).pairs, PAIR, '이름 정의가 든 파일');
  assert.equal((await I.parseOnboardFile(named, { fileName: 'a.xlsx' })).ok, true);
});

const MERGE_BOMB = '<mergeCells count="1"><mergeCell ref="A1:XFD1048576"/></mergeCells>';

test('159 X4 — 중앙 디렉터리 이름과 로컬 머리말 이름이 다른 시트도 병합 사전 점검이 본다(JSZip 은 로컬 머리말 이름을 쓴다)', async () => {
  const F = await import('../src/svcmon/formats.js');
  const buf = zipOf(await parts({ sheet: afterData(MERGE_BOMB) }), { cdName: (n) => (isSheet(n) ? 'docProps/thumb1.bin' : n) });
  assert.deepEqual(Object.keys((await JSZip.loadAsync(buf)).files).filter(isSheet), ['xl/worksheets/sheet1.xml'], 'JSZip(exceljs)은 이 항목을 시트로 읽는다 — 시험 재료 확인');
  const st = F.xlsxMergeStats(buf);
  assert.equal(st.ok, true);
  assert.equal(st.over, true, `중앙 디렉터리 이름이 시트 꼴이 아니어도 병합을 세야 한다: ${JSON.stringify(st)}`);
  assert.throws(() => F.assertXlsxMergesOk(buf, { dataValidations: 'ignored' }), /병합 셀/);
  const r = importInChild(buf);
  assert.equal(r.signal, null, `힙 고갈 · 시한 없이 거부해야 한다: ${r.err}`);
  assert.match(r.res.hostmap.threw || '', /병합 셀/);
  assert.equal(r.res.onboard.ok, false);
  assert.match(r.res.onboard.reason, /병합 셀/);
  // 거꾸로(중앙 디렉터리 이름만 시트 꼴)도 본다 — 154 의 동작 그대로
  const rev = zipOf(await parts({ sheet: afterData(MERGE_BOMB) }), { localName: (n) => (isSheet(n) ? 'docProps/thumb1.bin' : n) });
  assert.equal(F.xlsxMergeStats(rev).over, true);
});

test('159 X5 — 중앙 디렉터리 extra 의 Unicode Path(0x7075)로 이름을 바꾼 시트도 병합 사전 점검이 본다', async () => {
  const F = await import('../src/svcmon/formats.js');
  const upath = (name, rawLocal) => {
    if (!isSheet(name)) return null;
    const u = Buffer.from(name, 'utf8');
    const x = Buffer.alloc(9 + u.length);
    x.writeUInt16LE(0x7075, 0); x.writeUInt16LE(5 + u.length, 2); x.writeUInt8(1, 4); x.writeUInt32LE(crc32(rawLocal), 5); u.copy(x, 9);
    return x;
  };
  const hide = (n) => (isSheet(n) ? 'xl/zz/part1.bin' : n);
  const buf = zipOf(await parts({ sheet: afterData(MERGE_BOMB) }), { cdName: hide, localName: hide, cdExtra: upath });
  assert.deepEqual(Object.keys((await JSZip.loadAsync(buf)).files).filter(isSheet), ['xl/worksheets/sheet1.xml'], 'JSZip 은 Unicode Path 의 이름을 쓴다 — 시험 재료 확인');
  const st = F.xlsxMergeStats(buf);
  assert.equal(st.over, true, `Unicode Path 가 든 항목은 이름과 무관하게 봐야 한다: ${JSON.stringify(st)}`);
  const r = importInChild(buf);
  assert.equal(r.signal, null, `힙 고갈 · 시한 없이 거부해야 한다: ${r.err}`);
  assert.match(r.res.hostmap.threw || '', /병합 셀/);
  assert.equal(r.res.onboard.ok, false);
});

test('159 X1 — 정의된 이름(definedName) 범위를 칸마다 전개하지 않는다(전체 시트 · 전체 열 — 힙 256MB 자식에서 값 그대로)', async () => {
  for (const ref of ['s!$A$1:$XFD$1048576', 's!$A$1:$A$1048576', "'s'!$A$1:$D$1048576,'s'!$F$1:$XFD$1048576"]) {
    const buf = zipOf(await parts({ book: withNames(`<definedName name="x">${ref}</definedName><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${ref}</definedName>`) }));
    assert.ok(buf.length < 8192, '작은 파일');
    assertBothRead(importInChild(buf), `정의된 이름 ${ref}`);
  }
});

test('159 X2 — 열 정의(col max)를 Column 객체로 전개하지 않는다(max 20억 — 힙 256MB 자식에서 값 그대로)', async () => {
  const buf = zipOf(await parts({ sheet: beforeData('<cols><col min="1" max="2000000000" width="10" customWidth="1"/></cols>') }));
  assertBothRead(importInChild(buf), '열 정의 max 20억');
});

test('159 X3 — 엑셀 범위를 넘는 행 번호는 행을 돌기 전에 거부한다(42억 · 1억 — 시한 20초) · 마지막 행(1,048,576)은 읽는다', async () => {
  const F = await import('../src/svcmon/formats.js');
  assert.equal(F.XLSX_SHEET_MAX_ROW, 1_048_576);
  const rowAt = (r) => addRow(`<row r="${r}"><c r="A${r}" t="inlineStr"><is><t>srv-99</t></is></c><c r="B${r}" t="inlineStr"><is><t>10.0.0.99</t></is></c></row>`);
  for (const r of [4294967295, 100000000, 1048577]) {
    const res = importInChild(zipOf(await parts({ sheet: rowAt(r) })));
    assert.equal(res.signal, null, `r=${r}: 시한 안에 끝나야 한다(수정 전에는 eachRow 가 성긴 배열을 끝까지 돈다): ${res.err}`);
    assert.match(res.res.hostmap.threw || '', /행 번호가 엑셀 범위/, `r=${r}: ${JSON.stringify(res.res.hostmap)}`);
    assert.equal(res.res.onboard.ok, false, `r=${r}`);
    assert.match(res.res.onboard.reason, /행 번호가 엑셀 범위/);
    assert.equal(res.res.onboard.code, 'unreadable', '행 수 초과(too-many-rows)로 분류하지 않는다');
  }
  const last = await F.parseHostMapAny(zipOf(await parts({ sheet: rowAt(1048576) })), 'xlsx');
  assert.deepEqual(last.pairs, [...PAIR, { name: 'srv-99', ip: '10.0.0.99' }], '엑셀의 마지막 행은 정상이다');
});

test('159 — 서버 소스에서 exceljs 로 통합 문서를 로드하는 곳은 loadXlsxValues 하나다(호출부가 각자 옵션을 주지 않는다)', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      const code = stripComments(fs.readFileSync(p, 'utf8'));
      // 로드 계열: xlsx.load · xlsx.read · xlsx.readFile · 스트림 리더(WorkbookReader)
      if (/\.xlsx\s*\.\s*(load|read|readFile)\s*\(|WorkbookReader|\breader\.load\(/.test(code)) hits.push(path.relative(SRC, p).replace(/\\/g, '/'));
    }
  };
  walk(SRC);
  assert.deepEqual(hits, ['svcmon/formats.js'], '새 .xlsx 가져오기는 svcmon/formats.js loadXlsxValues 를 쓴다(사전 점검 assertXlsxSizeOk · assertXlsxMergesOk 뒤에)');
  const formats = stripComments(fs.readFileSync(FORMATS, 'utf8'));
  assert.equal((formats.match(/\breader\.load\(/g) || []).length, 1, 'formats.js 안에서도 로드는 한 곳');
  assert.match(formats, /ignoreNodes:\s*\[\s*'dataValidations'\s*,\s*'cols'\s*\]/);
  const onboard = stripComments(fs.readFileSync(ONBOARD, 'utf8'));
  assert.match(onboard, /loadXlsxValues\(buf\)/);
  assert.doesNotMatch(onboard, /import\(\s*'exceljs'\s*\)/, '서버 등록 가져오기는 exceljs 를 직접 부르지 않는다');
});

test('159 E1 — 조닝 자르기(trimZoningToFit)는 이름이 ‘__proto__’ 인 별칭도 자기 속성으로 남긴다(맵의 원형을 바꾸지 않는다)', async () => {
  const { trimZoningToFit } = await import('../src/central/edgeRecord.js');
  const zones = Array.from({ length: 400 }, (_, i) => ({ name: `zone_${i}`, members: ['10:00:00:00:00:00:00:01', '10:00:00:00:00:00:00:02'] }));
  // 엣지 본문은 JSON 으로 온다 — JSON.parse 는 ‘__proto__’ 를 자기 속성으로 만든다(장비 파서도 ownPut 으로 그렇게 둔다 — 155회차)
  const o = JSON.parse(JSON.stringify({ deviceId: 'sw1', zoning: { zones, aliases: { A: ['10:00:00:00:00:00:00:01'] } } })
    .replace('"aliases":{', '"aliases":{"__proto__":["10:00:00:00:00:00:00:09"],"constructor":["10:00:00:00:00:00:00:08"],'));
  assert.deepEqual(Object.keys(o.zoning.aliases), ['__proto__', 'constructor', 'A'], '시험 재료 확인');
  const t = trimZoningToFit(o, 20_000, { by: 'central' });
  assert.ok(t && t.zonesOmitted > 0, '잘라야 하는 크기여야 한다(시험 재료 확인)');
  const a = o.zoning.aliases;
  assert.equal(Object.getPrototypeOf(a), Object.prototype, '별칭 맵의 원형이 바뀌면 안 된다');
  assert.equal(a.length, undefined, '배열의 length 를 상속하면 안 된다');
  const kept = Object.keys(a);
  assert.equal(kept.length + t.aliasesOmitted, 3, `남긴 수 + 뺀 수 = 전체(세지 않고 사라지는 별칭이 없다): ${JSON.stringify({ kept, t })}`);
  assert.ok(Object.hasOwn(a, '__proto__'), '‘__proto__’ 별칭이 자기 속성으로 남는다');
  assert.deepEqual(Object.getOwnPropertyDescriptor(a, '__proto__').value, ['10:00:00:00:00:00:00:09']);
  assert.match(JSON.stringify(a), /"__proto__":\["10:00:00:00:00:00:00:09"\]/, '다시 직렬화해도 남는다(중앙 보관 파일 · 응답)');
});

test('159 E2 — 엣지 설정 사본(setAgentConfig): 이름이 ‘__proto__’ 인 항목이 파일 맵의 원형을 바꾸지 않는다(상속된 키로 읽히지 않는다)', () => {
  const cfg = fs.mkdtempSync(path.join(DIR, 'ac-'));
  const script = `
    const A = await import(${JSON.stringify(pathToFileURL(path.join(SRC, 'central', 'agentConfig.js')).href)});
    const files = JSON.parse('{"__proto__":{"portal.env":"AUTH_SECRET=leak"},"a.json":"{}"}');
    const r = A.setAgentConfig('edge-a', files);
    const f = A.getAllAgentConfigs()['edge-a'].files;
    console.log('RES ' + JSON.stringify({ ok: r.ok, keys: Object.keys(f), protoOk: Object.getPrototypeOf(f) === Object.prototype, viaProto: f['portal.env'] ?? null, json: JSON.stringify(f) }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000, encoding: 'utf8', env: { ...process.env, CONFIG_DIR: cfg, DB_DIR: cfg, DATA_SOURCE: 'live', CENTRAL_URL: '' } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  assert.ok(line, `자식이 결과를 내야 한다: ${String(r.stderr || '').slice(-400)}`);
  const res = JSON.parse(line.slice(4));
  assert.equal(res.ok, true);
  assert.equal(res.protoOk, true, '파일 맵의 원형이 엣지가 보낸 객체로 바뀌면 안 된다');
  assert.equal(res.viaProto, null, '상속으로 ‘portal.env’ 가 읽히면 안 된다(가림을 거치지 않은 값)');
  assert.deepEqual(res.keys, ['__proto__', 'a.json'], '세지 않고 사라지는 항목이 없다(자기 속성으로 남는다)');
  assert.match(res.json, /"__proto__":\{"portal\.env"/);
});

test('159 B1 — 예약 복원의 마지막 적용 기록: 읽기 오류는 옮기지 않고(다시 읽히면 그대로 보인다) · 형식 오류만 손상본으로 보존한다', async () => {
  const S = await import('../src/backup/stagedRestore.js');
  const cfg = fs.mkdtempSync(path.join(DIR, 'cfg-'));
  const b = path.join(cfg, 'backups');
  fs.mkdirSync(b);
  const last = path.join(b, S.LAST_NAME);
  const errs = []; const origErr = console.error; console.error = (...a) => errs.push(a.join(' '));
  try {
    // ① 읽기 오류 — 그 이름을 디렉터리가 차지(EISDIR · root 로 도는 CI 에서도 나는 읽기 오류). 옮기지 않는다.
    S._resetStagedRestoreState();
    fs.mkdirSync(last);
    assert.equal(S.stagedRestoreStatus({ configDir: cfg }).last, null);
    assert.deepEqual(fs.readdirSync(b), [S.LAST_NAME], '읽지 못한 기록을 손상본(.corrupt.*)으로 옮기면 안 된다');
    assert.equal(errs.filter((l) => /파싱 실패/.test(l)).length, 0, '읽기 오류를 파싱 실패로 적지 않는다');
    // 읽기가 돌아오면 기록이 그대로 보인다
    fs.rmdirSync(last);
    fs.writeFileSync(last, JSON.stringify({ at: 1, ok: false, applied: [], failed: [{ file: 'users.json', reason: 'EACCES' }], rejected: [] }));
    assert.deepEqual(S.stagedRestoreStatus({ configDir: cfg }).last.failed, [{ file: 'users.json', reason: 'EACCES' }]);
    // ② 형식 오류 — 손상본으로 보존(예전 그대로)
    fs.writeFileSync(last, '{broken');
    assert.equal(S.stagedRestoreStatus({ configDir: cfg }).last, null);
    const names = fs.readdirSync(b);
    assert.equal(names.length, 1);
    assert.match(names[0], /^\.restore-last\.json\.corrupt\.\d+/, '형식 오류는 옆으로 보존한다');
    // ③ 없음 — 조용히 null
    assert.equal(S.stagedRestoreStatus({ configDir: cfg }).last, null);
  } finally { console.error = origErr; S._resetStagedRestoreState(); }
});

/** 통신 점검 폴러를 자식 프로세스에서 돌린다(env · 모듈 상태 격리) — 보존 365일로 저장 → 200일 전 표본 적재 → mode 대로 설정 파일을 바꾸고 → 12주기(정리 틱) → 남은 표본 수. */
function linkCheckPruneInChild(mode) {
  const cfg = fs.mkdtempSync(path.join(DIR, 'lc-'));
  const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
  const script = `
    import fs from 'node:fs'; import path from 'node:path';
    const S = await import(${u('linkcheck/settings.js')}); const D = await import(${u('linkcheck/db.js')}); const P = await import(${u('linkcheck/poller.js')});
    const file = path.join(process.env.CONFIG_DIR, 'linkcheck-settings.json');
    fs.writeFileSync(file, JSON.stringify({ enabled: true, settingsCheck: false, sampleRetentionDays: 365, eventRetentionDays: 365, dailyRetentionDays: 3650 }));
    const stored = S.loadLinkCheckSettings().sampleRetentionDays;
    const count = async () => { const r = await D.samplesOf('c2e:test', { hours: 24 * 400 }); return Array.isArray(r) ? r.length : (r.rows || []).length; };
    const ins = async (days) => D.insertResults([{ link: { id: 'c2e:test' }, ts: Date.now() - days * 86_400_000, verdict: { ok: true, phase: 'ok', reached: 'http', failKind: '' }, steps: [], summary: 'ok' }], { byNode: 'central' });
    await ins(200); await ins(380);   // 조회 창(400일) 안의 두 표본 — 보존 365일이면 380일 전 것만 지워진다
    const before = await count();
    const mode = ${JSON.stringify(mode)};
    if (mode === 'read-error') { fs.rmSync(file); fs.mkdirSync(file); }
    if (mode === 'corrupt') fs.writeFileSync(file, '{broken');
    let last; for (let i = 0; i < 12; i += 1) last = await P.pollOnce({ trigger: 'manual' });
    await new Promise((r) => setTimeout(r, 200));
    console.log('RES ' + JSON.stringify({ stored, before, after: await count(), ok: last?.ok, pruneSkipped: P.linkCheckPollerStatus().last?.pruneSkipped ?? null }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 120_000, encoding: 'utf8',
    env: { ...process.env, CONFIG_DIR: cfg, DB_DIR: cfg, DATA_SOURCE: 'live', LINKCHECK_ENABLED: 'true', CENTRAL_URL: '' } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  assert.ok(line, `자식이 결과를 내야 한다: ${String(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice(4));
}

test('159 L1 — 통신 점검: 설정을 못 읽은(읽기 오류 · 손상) 주기의 정리 틱은 기본 보존일로 지우지 않는다 · 읽힌 주기는 저장된 보존일로 지운다', () => {
  // 읽힌 주기: 보존 365일 → 380일 전 표본만 지워진다(정리가 실제로 도는지 — 건너뛰기만 하는 수정이 아님을 고정)
  const ok = linkCheckPruneInChild('readable');
  assert.deepEqual({ stored: ok.stored, before: ok.before, after: ok.after, pruneSkipped: ok.pruneSkipped }, { stored: 365, before: 2, after: 1, pruneSkipped: null }, `읽힌 주기: ${JSON.stringify(ok)}`);
  for (const mode of ['read-error', 'corrupt']) {
    const r = linkCheckPruneInChild(mode);
    assert.equal(r.ok, true, `${mode}: env 로 켜진 폴러는 그 주기에도 돈다`);
    assert.equal(r.before, 2);
    assert.equal(r.after, 2, `${mode}: 보존일을 모르는 주기에 기본값(90일)으로 지우면 안 된다(200일 전 표본은 저장된 보존 365일 안이다): ${JSON.stringify(r)}`);
    assert.equal(r.pruneSkipped, 'settings-unreadable', `${mode}: 건너뛴 사실을 상태에 남긴다(고정 낱말)`);
  }
});

/** 전송 속도 폴러의 보존 정리를 자식 프로세스에서 — 300 · 700 · 760일 전 표본 → 틱 두 번(둘째는 6시간 뒤 = 정리) → 남은 표본 수. */
function xferPruneInChild(mode) {
  const cfg = fs.mkdtempSync(path.join(DIR, 'xf-'));
  const file = path.join(cfg, 'xfer-speed-settings.json');
  if (mode === 'read-error') fs.mkdirSync(file);   // 기동 때부터 못 읽음(직전 값 없음) — 원본이 있어도 내용을 모른다
  else fs.writeFileSync(file, mode === 'corrupt' ? '{broken' : JSON.stringify({ enabled: false, sampleRetentionDays: 730 }));
  const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
  const script = `
    const D = await import(${u('xferspeed/db.js')}); const P = await import(${u('xferspeed/poller.js')});
    const count = async () => { const r = await D.samplesSince(0); return Array.isArray(r) ? r.length : (r.rows || []).length; };
    const now = Date.now();
    for (const d of [300, 700, 760]) await D.insertSamples([{ agent: 'edge-a', dir: 'down', ts: now - d * 86_400_000, ok: true, bytes: 1000, mbps: 10, xferMs: 10, totalMs: 12, ttfbMs: 1, trig: 'timer' }]);
    const before = await count();
    await P.tickXferSchedule({ now });                              // 첫 틱은 기준만 잡는다
    await P.tickXferSchedule({ now: now + P.PRUNE_EVERY_MS + 1 });   // 정리 틱
    await new Promise((r) => setTimeout(r, 300));
    console.log('RES ' + JSON.stringify({ before, after: await count() }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000, encoding: 'utf8',
    env: { ...process.env, CONFIG_DIR: cfg, DB_DIR: cfg, DATA_SOURCE: 'live', CENTRAL_URL: '' } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  assert.ok(line, `자식이 결과를 내야 한다: ${String(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice(4));
}

test('159 L2 — 전송 속도: 설정을 못 읽은(손상 · 읽기 오류) 상태의 보존 정리는 기본 보존일(180일)로 지우지 않는다 · 읽히면 저장된 보존일(730일)로 지운다', () => {
  assert.deepEqual(xferPruneInChild('readable'), { before: 3, after: 2 }, '읽힌 설정(730일): 760일 전 표본만 지워진다 — 정리가 실제로 돈다');
  for (const mode of ['corrupt', 'read-error']) {
    assert.deepEqual(xferPruneInChild(mode), { before: 3, after: 3 }, `${mode}: 보존일을 모르는 상태에서 기본값으로 지우면 안 된다(예전에는 셋 다 지워졌다)`);
  }
});

/** 집중 모니터링 기록기의 정리를 자식 프로세스에서 — 60 · 85 · 95일 전 묶음 → 틱 30번(= 정리 틱) → 남은 묶음 수 · 건너뜀 표지. */
function focusMonPruneInChild(mode) {
  const cfg = fs.mkdtempSync(path.join(DIR, 'fm-'));
  const file = path.join(cfg, 'focusmon-targets.json');
  if (mode === 'read-error') fs.mkdirSync(file);
  else fs.writeFileSync(file, mode === 'corrupt' ? '{broken' : JSON.stringify({ targets: [], settings: { retentionDays: 90, capGb: 500 }, groups: [] }));
  const u = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
  const script = `
    const D = await import(${u('focusmon/db.js')}); const Rec = await import(${u('focusmon/recorder.js')});
    Rec._setFreeSpaceForTest(() => ({ free: 500 * 2 ** 30, total: 1000 * 2 ** 30 }));
    const now = Date.now(); const min = (d) => Math.floor((now - d * 86_400_000) / 60_000);
    await D.writeBlocks([60, 85, 95].map((d) => ({ kind: 'm', target: 't1', minute: min(d), n: 1, data: Buffer.from('x') })));
    const count = async () => (await D.readMetric('t1', 0, min(0) + 10)).length;
    const before = await count();
    for (let i = 0; i < 30; i += 1) await Rec.recordTick(now);
    console.log('RES ' + JSON.stringify({ before, after: await count(), pruneSkipped: Rec.recorderStatus().pruneSkipped || '' }));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { timeout: 60_000, encoding: 'utf8',
    env: { ...process.env, CONFIG_DIR: cfg, DB_DIR: cfg, DATA_SOURCE: 'live', CENTRAL_URL: '' } });
  const line = String(r.stdout || '').split('\n').find((l) => l.startsWith('RES '));
  assert.ok(line, `자식이 결과를 내야 한다: ${String(r.stderr || '').slice(-400)}`);
  return JSON.parse(line.slice(4));
}

test('159 L3 — 서버 집중 모니터링: 등록부(설정 포함)를 못 읽은 상태의 정리는 기본 보관 기간(30일)으로 지우지 않는다 · 읽히면 저장된 기간(90일)으로 지운다', () => {
  assert.deepEqual(focusMonPruneInChild('readable'), { before: 3, after: 2, pruneSkipped: '' }, '읽힌 설정(90일): 95일 전 묶음만 지워진다 — 정리가 실제로 돈다');
  for (const mode of ['corrupt', 'read-error']) {
    assert.deepEqual(focusMonPruneInChild(mode), { before: 3, after: 3, pruneSkipped: 'settings-unreadable' }, `${mode}: 보관 기간을 모르는 상태에서 기본값으로 지우면 안 된다(예전에는 셋 다 지워졌다)`);
  }
});
