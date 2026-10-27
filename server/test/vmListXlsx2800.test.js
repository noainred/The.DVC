/**
 * v2.800 — 엑셀 '폴더 트리' 시트가 Excel 에서 빈 화면으로 열리던 결함(사용자 보고 스크린샷: A1 부터 빈칸 · 열 너비 기본 · 틀 고정 없음).
 *  원인: 그 시트만 fitToPage(pageSetUpPr) + outlineProperties(outlinePr)를 함께 썼고, exceljs 가 <sheetPr> 안에 pageSetUpPr 를 outlinePr **앞에** 쓴다.
 *  OOXML CT_SheetPr 순서는 tabColor → outlinePr → pageSetUpPr — Excel 은 순서가 틀린 시트를 버린다(exceljs·xmllint 는 읽는다 — 그래서 v2.792 테스트가 못 잡았다).
 *  ⚠ Excel 실물로는 재현하지 못했다(이 환경에 없음) — 고정하는 것은 '만든 파일의 모든 시트가 스키마 순서를 지킨다' 이다.
 *  같은 검사를 VM 전체 정보 내보내기(vcenter/vmExportXlsx.js) 결과에도 건다 — 새 시트가 접기·폭 맞춤을 함께 쓰면 여기서 걸린다.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const X = await import('../src/veeam/vmListXlsx.js');
const VX = await import('../src/vcenter/vmExportXlsx.js');
const JSZip = (await import('jszip')).default;
const ExcelJS = (await import('exceljs')).default;

const H = 3_600_000;
const AT = Math.floor(Date.now() / H) * H;
const SHEETPR_ORDER = ['tabColor', 'outlinePr', 'pageSetUpPr'];

/** 시트 XML 마다 <sheetPr> 자식 순서가 스키마와 다른 것 — [{ sheet, kids }]. */
async function sheetPrIssues(buf) {
  const zip = await JSZip.loadAsync(buf);
  const out = [];
  for (const name of Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))) {
    const xml = await zip.file(name).async('string');
    const m = /<sheetPr\b[^>]*>([\s\S]*?)<\/sheetPr>/.exec(xml);
    if (!m) continue;
    const kids = [...m[1].matchAll(/<([A-Za-z]+)\b/g)].map((k) => k[1]);
    const idx = kids.map((k) => SHEETPR_ORDER.indexOf(k));
    if (idx.some((i) => i < 0) || idx.some((v, i) => i > 0 && v < idx[i - 1])) out.push({ sheet: name, kids });
  }
  return out;
}

function rows(n = 6) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const folder = i % 2 ? 'DC/vm/A.MGMT/00.Console/Admin' : 'DC/vm/A.MGMT/01.ADnDNS';
    out.push({ inv: { name: `vm${i}`, host: 'esx01', ipAddress: `10.0.0.${i}`, snapshotCount: 0 },
      view: { id: `vm${i}`, name: `vm${i}`, folder, power: 'POWERED_ON', v: i % 3 ? { state: 'ok', jobs: ['J'], rp: 3, lb: AT - 2 * H } : null, s: { ev: null, now: null } } });
  }
  return out;
}

test('폴더 트리 엑셀 — 모든 시트의 <sheetPr> 순서가 스키마대로 · 트리 시트에 VM 행이 있다(워커·인라인 · 고른 항목 유무)', async () => {
  const dataTable = { head: ['VM', '메모'], cells: rows().map((r) => [r.inv.name, 'x']), folderCols: [false, false] };
  for (const extra of [{}, { dataTable }]) {
    for (const inline of [false, true]) {
      const prev = process.env.VM_LIST_XLSX_WORKER;
      if (inline) process.env.VM_LIST_XLSX_WORKER = '0';
      let out;
      try { out = await X.renderVmListWorkbook({ vcName: 'NJ', rows: rows(), linked: true, snapDays: 7, cond: '백업 현황 화면 6대', at: AT, ...extra }); }
      finally { if (prev === undefined) delete process.env.VM_LIST_XLSX_WORKER; else process.env.VM_LIST_XLSX_WORKER = prev; }
      assert.equal(out.mode, inline ? 'inline' : 'worker');
      assert.deepEqual(await sheetPrIssues(out.buffer), [], `${inline ? '인라인' : '워커'}${extra.dataTable ? ' · 고른 항목' : ''}`);
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(out.buffer);
      const ts = wb.getWorksheet('VM 목록(폴더 트리)');
      const vmRows = []; ts.eachRow((r) => { if (/^vm\d$/.test(String(r.getCell(1).value))) vmRows.push(r.getCell(1).value); });
      assert.equal(vmRows.length, 6);
      assert.equal(ts.properties.outlineProperties?.summaryBelow, false, '−/+ 단추는 폴더 행에(요약 행이 위) — 이것은 지킨다');
      assert.notEqual(ts.pageSetup.fitToPage, true, '폴더 트리 시트는 폭 맞춤을 쓰지 않는다(접기와 함께 쓰면 순서가 틀린다)');
      assert.equal(wb.getWorksheet('요약').pageSetup.fitToPage, true, '접기가 없는 시트는 폭 맞춤 그대로');
    }
  }
});

test('검사 자체가 순서 위반을 잡는다 — 접기 + 폭 맞춤을 함께 쓴 시트', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('t', { pageSetup: { fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.addRow(['a']);
  const issues = await sheetPrIssues(Buffer.from(await wb.xlsx.writeBuffer()));
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].kids, ['pageSetUpPr', 'outlinePr'], 'exceljs 가 이 순서로 쓴다 — exceljs 가 고쳐지면 이 테스트를 다시 볼 것');
});

test('VM 전체 정보 내보내기 엑셀도 같은 순서 검사를 통과한다', async () => {
  const out = await VX.buildVmExportWorkbook({
    head: ['VM', '호스트'], cells: [['vm0', 'esx01']],
    cols: [{ key: 'name', item: 'name', h: 'VM', group: 'base', src: 'snap', filled: 1 }, { key: 'host', item: 'host', h: '호스트', group: 'base', src: 'snap', filled: 1 }],
    meta: { at: AT }, cond: { target: '전체', items: 2, groupNames: { base: '기본' }, offsetLabel: '(UTC+09:00)' },
  });
  assert.deepEqual(await sheetPrIssues(out.buffer || out), []);
});
