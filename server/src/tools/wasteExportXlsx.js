/**
 * tools/wasteExportXlsx.js — wasteExport.js 시트 모델 → exceljs 워크북(v2.497).
 * exceljs 는 ipam/excel.js 와 같은 기존 서버 의존성(4.4.0). 링크 셀은 `{ text, hyperlink, tooltip }` —
 * exceljs 가 `<hyperlink r:id>` + rels `TargetMode="External"` 상대경로로 기록한다(스크래치 실측).
 */
import ExcelJS from 'exceljs';

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
const SECTION_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEF3C7' } };
const isLink = (v) => v && typeof v === 'object' && typeof v.hyperlink === 'string';

function setCell(cell, v) {
  if (isLink(v)) {
    cell.value = { text: v.text, hyperlink: v.hyperlink, tooltip: v.tooltip || undefined };
    cell.font = { color: { argb: 'FF2563EB' }, underline: true };
    return;
  }
  cell.value = v == null ? null : v;
}

/** @param {Array} sheets buildWasteSheets 결과 @returns {ExcelJS.Workbook} */
export async function sheetsToWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();
  let n = 0;
  for (const s of sheets || []) {
    const name = String(s.name || `Sheet${n + 1}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = (s.columns || []).map((c) => ({ header: c.header, key: c.key, width: c.width || 14 }));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).eachCell((c) => { c.fill = HEADER_FILL; });
    ws.autoFilter = s.columns?.length && s.rows?.length ? { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } } : undefined;
    let i = 0;
    for (const r of s.rows || []) {
      const row = ws.addRow((s.columns || []).map((c) => (isLink(r[c.key]) ? null : (r[c.key] ?? null))));
      (s.columns || []).forEach((c, idx) => { if (isLink(r[c.key])) setCell(row.getCell(idx + 1), r[c.key]); });
      // 수천 행(전량 옵션)에서도 이벤트 루프를 세우지 않게 200행마다 양보(ipam/excel.js 4시트 양보와 같은 이유).
      if ((++i % 200) === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    if (s.section && s.section.columns?.length) {
      ws.addRow([]);
      const title = ws.addRow([s.section.title || '']);
      title.font = { bold: true }; title.getCell(1).fill = SECTION_FILL;
      const head = ws.addRow(s.section.columns.map((c) => c.header));
      head.font = { bold: true }; head.eachCell((c) => { c.fill = HEADER_FILL; });
      for (const r of s.section.rows || []) ws.addRow(s.section.columns.map((c) => (r[c.key] ?? null)));
      // 섹션 열이 본문 열보다 넓을 수 있어 폭을 최대치로 맞춘다.
      s.section.columns.forEach((c, idx) => { const col = ws.getColumn(idx + 1); if ((col.width || 0) < (c.width || 14)) col.width = c.width || 14; });
    }
    for (const note of s.notes || []) { ws.addRow([]); const r = ws.addRow([`※ ${note}`]); r.font = { italic: true, color: { argb: 'FF64748B' } }; }
    n++;
  }
  if (!n) wb.addWorksheet('empty');
  return wb;
}
