/**
 * v2.799.1 — 엑셀 '내용에 문제가 있습니다 · 복구하시겠습니까?'(사용자 보고: vm-list-OC2-all-20261027-1044.xlsx).
 *  원인(재현): exceljs 4.4.0 이 `<sheetPr>` 안에 pageSetUpPr 를 outlinePr 앞에 쓴다(스키마 CT_SheetPr = tabColor → outlinePr → pageSetUpPr).
 *  VM 목록 엑셀의 '폴더 트리' 시트가 fitToPage + outlineProperties 를 함께 써서 **모든 파일**이 그랬다(LibreOffice·openpyxl·exceljs 는 순서를 보지 않는다).
 *  고침: util/xlsxSheetPrOrder.js — 이 테스트는 생성된 파일의 XML 을 직접 본다(인라인 · 워커 두 경로).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxsheetpr2799-'));

// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지)
const F = await import('../src/util/xlsxSheetPrOrder.js');
const X = await import('../src/veeam/vmListXlsx.js');
const VX = await import('../src/vcenter/vmExportXlsx.js');
const ExcelJS = (await import('exceljs')).default;
const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');

const SHEET_PR = ['tabColor', 'outlinePr', 'pageSetUpPr'];
// CT_Worksheet 순서(이 저장소 엑셀이 쓰는 것 + 앞뒤 요소) — 순서가 틀리면 Excel 이 복구를 묻는다.
const WS = ['sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr', 'sheetProtection', 'protectedRanges', 'scenarios',
  'autoFilter', 'sortState', 'dataConsolidate', 'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations', 'hyperlinks',
  'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags',
  'drawing', 'legacyDrawing', 'legacyDrawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst'];

/** 최상위 자식 이름(정규식 없이 — 시트 XML 은 크다). 깊이 1 의 여는 태그만 센다. */
function childTags(xml, from, to) {
  const out = [];
  let depth = 0; let i = from;
  while (i < to) {
    const lt = xml.indexOf('<', i);
    if (lt < 0 || lt >= to) break;
    const gt = xml.indexOf('>', lt);
    const tag = xml.slice(lt + 1, gt);
    if (tag.startsWith('/')) depth--;
    else if (!tag.startsWith('?') && !tag.startsWith('!')) {
      if (depth === 0) out.push(tag.split(/[\s/]/)[0]);
      if (!tag.endsWith('/')) depth++;
    }
    i = gt + 1;
  }
  return out;
}
const inOrder = (tags, order) => tags.every((t, k) => order.includes(t) && (k === 0 || order.indexOf(tags[k - 1]) < order.indexOf(t)));

/** 워크북 버퍼 → 시트마다 { name, sheetPr:[…], top:[…], xml } */
async function sheetsOf(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()) {
    const xml = await zip.file(name).async('string');
    const ws = xml.indexOf('<worksheet'); const body = xml.indexOf('>', ws) + 1; const end = xml.lastIndexOf('</worksheet>');
    const top = childTags(xml, body, end);
    const a = xml.indexOf('<sheetPr>'); const b = xml.indexOf('</sheetPr>');
    out.push({ name, top, sheetPr: a >= 0 && b > a ? childTags(xml, a + '<sheetPr>'.length, b) : [], xml });
  }
  return out;
}
function assertSchema(sheets, label) {
  for (const s of sheets) {
    assert.ok(inOrder(s.sheetPr, SHEET_PR), `${label} ${s.name}: <sheetPr> 순서 ${JSON.stringify(s.sheetPr)} — 스키마는 tabColor → outlinePr → pageSetUpPr`);
    assert.ok(inOrder(s.top, WS), `${label} ${s.name}: <worksheet> 요소 순서 ${JSON.stringify(s.top)}`);
  }
}

const H = 3_600_000;
const AT = Math.floor(Date.now() / H) * H;
function rows() {
  const mk = (name, folder) => ({ inv: { name, host: 'esx01', snapshotCount: 0 }, view: { id: name, name, folder, power: 'POWERED_ON', v: { state: 'ok', jobs: ['Daily'], rp: 3, lb: AT - H }, s: { ev: null, now: null } } });
  return [mk('web-01', 'Prod/Web'), mk('db-01', 'Prod/DB'), mk('dev-01', 'Dev'), mk('top', 'vm')];
}

test('① 바로잡기가 걸렸다 — exceljs 의 그 렌더 함수를 찾았다(판이 바뀌면 여기서 먼저 깨진다)', () => {
  assert.equal(F.sheetPrOrderState(), 'patched');
  assert.equal(F.ensureSheetPrOrder(), 'patched', '여러 번 불러도 한 번');
});

test('② VM 목록 엑셀(인라인) — 폴더 트리 시트의 <sheetPr> 는 outlinePr → pageSetUpPr · 다른 시트도 스키마 순서', async () => {
  const out = await X.buildVmListWorkbook({ vcName: 'OC2', rows: rows(), linked: true, at: AT });
  const sheets = await sheetsOf(out.buffer);
  assert.equal(sheets.length, 4);
  const tree = sheets[1];
  assert.deepEqual(tree.sheetPr, ['outlinePr', 'pageSetUpPr'], '폴더 트리 시트는 개요 + 폭 한 장 인쇄를 둘 다 쓴다');
  assert.match(tree.xml, /<outlinePr summaryBelow="0" summaryRight="0"\/>/, '개요 단추 위치(폴더 행 위)는 그대로');
  assert.match(tree.xml, /<pageSetUpPr fitToPage="1"\/>/, '폭 한 장 인쇄도 그대로');
  assertSchema(sheets, '인라인');
  // exceljs 로 다시 읽어도 두 설정이 남는다.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(out.buffer);
  const ws = wb.getWorksheet('VM 목록(폴더 트리)');
  assert.equal(ws.properties.outlineProperties?.summaryBelow, false);
  assert.equal(ws.pageSetup.fitToPage, true);
});

test('③ VM 목록 엑셀(워커) — 워커 스레드에서도 같은 순서(모듈 캐시가 따로라 워커가 불러오는 모듈이 바로잡기를 import 해야 한다)', async () => {
  const prev = process.env.VM_LIST_XLSX_WORKER;
  delete process.env.VM_LIST_XLSX_WORKER;
  try {
    const out = await X.renderVmListWorkbook({ vcName: 'OC2', rows: rows(), linked: true, at: AT });
    assert.equal(out.mode, 'worker');
    const sheets = await sheetsOf(out.buffer);
    assert.deepEqual(sheets[1].sheetPr, ['outlinePr', 'pageSetUpPr']);
    assertSchema(sheets, '워커');
  } finally { if (prev !== undefined) process.env.VM_LIST_XLSX_WORKER = prev; }
});

test('④ 세 가지를 함께 쓰는 시트 — tabColor → outlinePr → pageSetUpPr', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('t', { properties: { tabColor: { argb: 'FF00FF00' } }, pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.addRow(['a']);
  const sheets = await sheetsOf(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.deepEqual(sheets[0].sheetPr, ['tabColor', 'outlinePr', 'pageSetUpPr']);
  // 아무 속성도 없는 시트는 <sheetPr> 를 쓰지 않는다(예전과 같다).
  const wb2 = new ExcelJS.Workbook();
  wb2.addWorksheet('plain').addRow([1]);
  assert.deepEqual((await sheetsOf(Buffer.from(await wb2.xlsx.writeBuffer())))[0].sheetPr, []);
});

test('⑤ VM 전체 정보 엑셀(v2.799)도 스키마 순서', async () => {
  const out = await VX.buildVmExportWorkbook({
    head: ['VM 이름', 'VM UUID'], cells: [['web-01', '수집 안 됨']],
    cols: [{ key: 'name', item: 'name', h: 'VM 이름', group: 'base', src: 'snap', filled: 1 }, { key: 'uuid', item: 'uuid', h: 'VM UUID', group: 'ident', src: 'live', filled: 0 }],
    meta: { vcenterName: 'OC2', rows: 1, live: { state: 'off' }, at: AT, offsetMin: 540 }, cond: { target: '전체 VM', items: 2, groupNames: {}, offsetLabel: 'KST' },
  });
  assertSchema(await sheetsOf(out.buffer), 'VM 전체 정보');
});
