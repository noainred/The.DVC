/** Render the per-/24 IP ledger to a coloured .xlsx workbook (one sheet/subnet). */

import ExcelJS from 'exceljs';

const FILL = {
  used: 'FFD9F2D9',       // light green
  multihomed: 'FFD6E4FF', // light blue
  duplicate: 'FFF8D7DA',  // light red
  network: 'FFE2E2E2',    // grey
  empty: null,
};

export async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();

  for (const s of sheets) {
    const name = s.subnet.replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
    ws.columns = [
      { header: `${s.base}.X`, key: 'ip', width: 18 },
      { header: 'Purpose', key: 'purpose', width: 34 },
      { header: 'Hostname', key: 'hostname', width: 40 },
      { header: '메모(Notes)', key: 'notes', width: 28 },
      { header: '전원', key: 'power', width: 7 },
      { header: '분류', key: 'scope', width: 8 },
      { header: '상태', key: 'status', width: 10 },
    ];
    // Title row
    ws.spliceRows(1, 0, [`VLAN — ${s.subnet}`, `사용 ${s.used}/255`]);
    ws.mergeCells('A1:G1');
    const title = ws.getCell('A1');
    title.font = { bold: true, size: 12 };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3D9C9' } }; });

    const label = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', empty: '' };
    for (const r of s.rows) {
      const row = ws.addRow({ ip: r.ip, purpose: r.purpose, hostname: r.hostname, notes: r.notes, power: r.power, scope: r.scope, status: label[r.status] });
      const argb = FILL[r.status];
      if (argb) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; });
    }
  }
  if (sheets.length === 0) wb.addWorksheet('empty');
  return wb;
}
