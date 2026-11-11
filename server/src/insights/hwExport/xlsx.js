/**
 * insights/hwExport/xlsx.js — 서버 하드웨어 정보 엑셀(v2.966 — 승인 시안 docs/design/baremetal-hw-xlsx ③④).
 *
 * 입력은 rows.js buildHwModel 의 평범한 값 모델이다(함수 없음 — 워커로 그대로 보낸다). 시트:
 *   서버 요약(법인 표시: band = 법인마다 띠 · sheet = 법인마다 시트 · col = 법인 열만, 자동 필터) → 상세(고른 묶음마다 1장)
 *   → 안내 → (사양서를 켰으면) 목차 + 서버마다 1장.
 * 규약: 빈 칸은 '읽지 못함/없음' 이다(0 을 쓰지 않는다) · 수식 칸을 만들지 않는다 · 색은 칸마다 고정(조건부 서식 없음 — vmXlsxStyle 머리말).
 * ⚠ 워커(hwExportWorker.js)에서도 로드된다 — store·config·DB 같은 부수효과 있는 import 를 넣지 말 것.
 */
import ExcelJS from 'exceljs';
import '../../util/xlsxSheetPrOrder.js';
import { sheetLink } from '../../util/xlsxInternalLink.js';
import { PAL, BORDER, fill, styleHeadRow } from '../../vcenter/vmXlsxStyle.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SUMMARY_SHEET = '서버 요약';
export const INFO_SHEET = '안내';
export const TOC_SHEET = '목차';
const PRINT = Object.freeze({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } });
const PRINT_PORTRAIT = Object.freeze({ ...PRINT, orientation: 'portrait' });
const BAND = 'FFD6E2F0';
const BAND_LINE = 'FFB9C9DC';
const MONO = 'Consolas';
const yieldLoop = () => new Promise((r) => { setImmediate(r); });

/**
 * 시트 이름(엑셀 규칙): `: \ / ? * [ ]` → `_` · 앞뒤 작은따옴표 제거 · 31자 · 대소문자 무시 겹침은 `~2`·`~3`(31자 안에서).
 * taken 은 이미 쓴 이름(소문자) 집합 — 이 함수가 새 이름을 넣는다.
 */
export function sheetNameOf(raw, taken) {
  let base = String(raw ?? '').replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim() || '서버';
  base = base.slice(0, 31);
  let name = base; let i = 2;
  while (taken.has(name.toLowerCase())) { const suf = `~${i++}`; name = base.slice(0, 31 - suf.length) + suf; }
  taken.add(name.toLowerCase());
  return name;
}

const NUM_FMT = (v) => (Number.isInteger(v) ? '#,##0' : '#,##0.###');
function putCell(cell, v, kind, zebra) {
  cell.value = v == null ? null : v;
  cell.border = BORDER;
  if (zebra) cell.fill = fill(PAL.zebra);
  if (typeof v === 'number') { cell.numFmt = NUM_FMT(v); cell.alignment = { horizontal: 'right', vertical: 'middle' }; }
  else cell.alignment = { vertical: 'middle' };
  if (kind === 'mono') cell.font = { name: MONO };
}
function widthOf(label, kind) {
  if (kind === 'num') return Math.max(10, Math.min(16, String(label).length * 2 + 2));
  if (kind === 'mono') return 18;
  return Math.max(14, Math.min(40, String(label).length * 2 + 6));
}
const NOTE_WIDTH = 46;

/** 맨 위 4줄(제목 · 기준 · 포함된 법인 · 합계 칸) — 다음에 쓸 행 번호를 돌려준다. */
function writeTop(ws, title, meta, totals, corpsLine, ncol) {
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: PAL.title } };
  ws.getCell('A2').value = meta.basis;
  ws.getCell('A2').font = { color: { argb: PAL.muted } };
  ws.getCell('A3').value = corpsLine;
  ws.getCell('A3').font = { bold: true, color: { argb: PAL.title } };
  ws.getCell('A3').fill = fill('FFEEF4FB');
  if (ncol > 1) ws.mergeCells(3, 1, 3, Math.min(ncol, 12));
  const kpis = [
    ['서버', `${totals.servers} 대`], ['물리서버', `${totals.bm} 대`], ['가상화 서버', `${totals.vh} 대`],
    ['CPU 코어 합계', totals.cores == null ? '—' : totals.cores.toLocaleString('en-US')],
    ['메모리 합계', totals.memGiB == null ? '—' : `${totals.memGiB.toLocaleString('en-US')} GiB`],
    ['인벤토리 없음(합계 제외)', `${totals.noInventory} 대`],
  ];
  const r = ws.getRow(4);
  kpis.forEach(([k, v], i) => {
    const a = r.getCell(i * 2 + 1); const b = r.getCell(i * 2 + 2);
    a.value = k; a.font = { color: { argb: PAL.muted }, size: 9 }; a.fill = fill(PAL.zebra); a.border = BORDER; a.alignment = { vertical: 'middle', wrapText: true };
    b.value = v; b.font = { bold: true }; b.fill = fill(PAL.zebra); b.border = BORDER; b.alignment = { vertical: 'middle' };
  });
  r.height = 30;
  return 6;
}

function headRow(ws, at, cols) {
  const hr = ws.getRow(at);
  cols.forEach((c, i) => { hr.getCell(i + 1).value = c.label; });
  styleHeadRow(hr, { height: 28 });
  cols.forEach((c, i) => { if (c.kind === 'num') hr.getCell(i + 1).alignment = { horizontal: 'right', vertical: 'middle', wrapText: true }; });
}

/** 서버 요약 시트 하나. rows 는 그 시트에 들어갈 행(이미 법인 순). */
async function summarySheet(wb, name, model, meta, rows, { band, corpsLine, totals, title }) {
  const cols = model.summary.cols;
  const ws = wb.addWorksheet(name, { pageSetup: { ...PRINT } });
  ws.columns = cols.map((c) => ({ width: c.key === 'note' ? NOTE_WIDTH : widthOf(c.label, c.kind) }));
  const head = writeTop(ws, title, meta, totals, corpsLine, cols.length);
  headRow(ws, head, cols);
  ws.views = [{ state: 'frozen', ySplit: head, xSplit: 0 }];
  ws.pageSetup.printTitlesRow = `${head}:${head}`;
  let at = head + 1; let zebra = 0; let last = null;
  const corpInfo = new Map(model.corps.map((c) => [c.id, c]));
  for (const r of rows) {
    if (band && r.corpId !== last) {
      last = r.corpId; zebra = 0;
      const ci = corpInfo.get(r.corpId);
      const br = ws.getRow(at++);
      br.getCell(1).value = `법인 ${r.corpName}  ·  서버 ${ci?.count ?? 0}대 (물리 ${ci?.bm ?? 0} · 가상화 ${ci?.vh ?? 0})  ·  코어 ${ci?.cores == null ? '—' : ci.cores.toLocaleString('en-US')}  ·  메모리 ${ci?.memGiB == null ? '—' : `${ci.memGiB.toLocaleString('en-US')} GiB`}`;
      ws.mergeCells(br.number, 1, br.number, cols.length);
      br.getCell(1).font = { bold: true, color: { argb: PAL.title } };
      br.getCell(1).fill = fill(BAND);
      br.getCell(1).border = { top: { style: 'thin', color: { argb: BAND_LINE } }, bottom: { style: 'thin', color: { argb: BAND_LINE } } };
      br.height = 22;
    }
    const row = ws.getRow(at++);
    r.cells.forEach((v, i) => putCell(row.getCell(i + 1), v, cols[i].kind, zebra % 2 === 1));
    const nc = row.getCell(cols.length); if (r.cells[cols.length - 1]) nc.font = { italic: true, color: { argb: 'FF5B6779' } };
    zebra++;
    if (at % 500 === 0) await yieldLoop();
  }
  // 띠가 있으면 자동 필터를 걸지 않는다 — 띠 줄이 데이터 사이에 끼어 필터·정렬이 깨진다(설계 §4). '법인 열만' 판본이 필터용이다.
  if (!band && rows.length) ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head + rows.length, column: cols.length } };
  return ws;
}

async function detailSheet(wb, name, d) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }], pageSetup: { ...PRINT, printTitlesRow: '1:1' } });
  ws.columns = d.cols.map((c) => ({ width: widthOf(c.label, c.kind) }));
  headRow(ws, 1, d.cols);
  let at = 2;
  for (const r of d.rows) {
    const row = ws.getRow(at++);
    r.cells.forEach((v, i) => putCell(row.getCell(i + 1), v, d.cols[i].kind, at % 2 === 1));
    row.getCell(2).font = { bold: true };
    if (at % 500 === 0) await yieldLoop();
  }
  if (d.rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: d.rows.length + 1, column: d.cols.length } };
  if (!d.rows.length) { ws.getCell('A2').value = '고른 법인 · 서버에 이 부품을 보고한 인벤토리가 없습니다.'; ws.getCell('A2').font = { italic: true, color: { argb: PAL.muted } }; }
}

function infoSheet(wb, meta, model) {
  const ws = wb.addWorksheet(INFO_SHEET, { pageSetup: { ...PRINT_PORTRAIT } });
  ws.columns = [{ width: 26 }, { width: 110 }];
  ws.getCell('A1').value = '안내 — 열의 뜻 · 출처 · 빈 칸의 뜻';
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: PAL.title } };
  const noInv = model.summary.rows.filter((r) => /^인벤토리 없음/.test(String(r.cells[r.cells.length - 1] || '')));
  const lines = [
    ['범위 · 기준 시각', meta.basis],
    ['대상', meta.kindText],
    ['값의 출처', 'iDRAC(Redfish) 인벤토리 저장값. 엣지(법인 현장) 서버는 그 엣지가 올린 축약 인벤토리 — 제조사 · 어댑터/PSU/PCIe 펌웨어 · BIOS 설정 · iDRAC 관리 · 라이선스는 비어 있습니다. 내려받을 때 장비에 다시 접속하지 않습니다 — ‘인벤토리 시각’ 이 그 값을 읽은 때입니다.'],
    ['구분', '통합 서버 인벤토리의 판정 그대로 — iDRAC/OME 물리 서버가 vCenter ESXi 호스트로 확인되면 가상화, 아니면 물리(베어메탈). 수동 분류 포함, ‘제외’ 분류는 빠집니다.'],
    ['가상화 서버', 'iDRAC 받침이 있는 호스트만 부품 값이 채워집니다. 없으면 vCenter 가 아는 모델 · 코어 · 메모리만 넣고 비고에 적습니다.'],
    ['Hostname(OS)', 'iDRAC 이 보고하는 OS 호스트 이름. 보고하지 않으면 빈 칸 + 비고 ‘Hostname 미보고’. ‘서버’ 열은 포탈에 등록된 이름입니다.'],
    ['코어 · 메모리', '코어는 물리 코어 합계(논리 스레드 아님). 메모리는 시스템 요약(없으면 DIMM 크기 합) — 단위 GiB.'],
    ['디스크', '물리 디스크 기준(장착 수 · 개별 용량의 합, GB = 10^9 바이트). RAID 뒤 가용 용량이나 OS 파일시스템 사용량이 아닙니다.'],
    ['빈 칸', '읽지 못한 값입니다 — 0 이 아닙니다. 합계 · 띠 소계에 들어가지 않습니다.'],
    ['법인 띠', meta.band === 'band' ? '법인이 바뀔 때마다 띠 줄이 들어갑니다 — 띠 때문에 서버 요약에는 자동 필터를 걸지 않았습니다(필터 · 피벗은 ‘법인 열만’ 으로 내려받으세요).' : meta.band === 'sheet' ? '법인마다 서버 요약 시트를 나눴습니다. 상세 시트는 한 장에 법인 열로 있습니다.' : '띠 없이 한 표 — 자동 필터가 걸려 있습니다.'],
    ['상태 열', '수집 시점의 Redfish 상태 글자(OK · Warning · Critical) 그대로입니다. 포탈이 새로 판정하지 않습니다.'],
    ['넣지 않는 것', '시리얼 번호 · iDRAC 사용자 계정 · 이벤트 로그 · 접속 계정.' + (meta.admin ? '' : ' 관리자 계정이 아니라 iDRAC 주소 · MAC · UUID 와 주소로 등록된 서버 이름이 빠지거나 가려졌습니다.')],
    ['인벤토리 없음', noInv.length ? `${noInv.length}대 — 서버 요약의 비고에 사유가 있습니다. 합계 칸에서 빠집니다.` : '없음'],
  ];
  if (meta.splitNote) lines.push(['파일 나눔', meta.splitNote]);
  lines.forEach(([k, v], i) => {
    const r = ws.getRow(i + 3);
    r.getCell(1).value = k; r.getCell(1).font = { bold: true }; r.getCell(1).fill = fill(PAL.zebra); r.getCell(1).border = BORDER;
    r.getCell(2).value = v; r.getCell(2).border = BORDER; r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.getCell(1).alignment = { vertical: 'top' };
  });
}

function specSheet(wb, name, sp) {
  const W = [24, 30, 18, 14, 14, 16, 16, 20];
  const ws = wb.addWorksheet(name, { pageSetup: { ...PRINT_PORTRAIT } });
  ws.columns = W.map((w) => ({ width: w }));
  ws.getCell('A1').value = sp.head.name;
  ws.getCell('A1').font = { bold: true, size: 16, color: { argb: PAL.title } };
  ws.getCell('H1').value = { text: '← 목차', hyperlink: sheetLink(TOC_SHEET) };
  ws.getCell('H1').font = { color: { argb: 'FF1D4ED8' }, underline: true };
  const band = [['법인(vCenter)', sp.head.corpName], ['구분', sp.head.kind], ['모델 · 서비스태그', [sp.head.model, sp.head.serviceTag].filter(Boolean).join(' · ')], ['인벤토리 시각', sp.head.at || '—']];
  const r2 = ws.getRow(2); const r3 = ws.getRow(3);
  band.forEach(([k, v], i) => {
    const c = i * 2 + 1;
    r2.getCell(c).value = k; r3.getCell(c).value = v;
    ws.mergeCells(2, c, 2, c + 1); ws.mergeCells(3, c, 3, c + 1);
    r2.getCell(c).font = { color: { argb: 'FFC7D7EA' }, size: 9 }; r3.getCell(c).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r2.getCell(c).fill = fill(PAL.head); r3.getCell(c).fill = fill(PAL.head);
  });
  r3.height = 22;
  let at = 5;
  if (sp.head.note) { ws.getCell(`A${at}`).value = sp.head.note; ws.getCell(`A${at}`).font = { italic: true, color: { argb: 'FF5B6779' } }; at += 2; }
  for (const s of sp.sections) {
    const t = ws.getRow(at++); t.getCell(1).value = s.title; t.getCell(1).font = { bold: true, size: 12, color: { argb: PAL.title } }; t.height = 20;
    for (const [k, v] of s.rows || []) {
      const r = ws.getRow(at++);
      r.getCell(1).value = k; r.getCell(1).font = { bold: true }; r.getCell(1).fill = fill('FFEEF2F7'); r.getCell(1).border = BORDER;
      putCell(r.getCell(2), v, '', false); if (typeof v === 'number') r.getCell(2).alignment = { horizontal: 'left' };
    }
    const tb = s.table;
    if (tb) {
      if (s.rows?.length) at++;
      const hr = ws.getRow(at++);
      tb.cols.forEach((c, i) => { hr.getCell(i + 1).value = c.label; });
      styleHeadRow(hr, { height: 22 });
      if (!tb.rows.length) { const r = ws.getRow(at++); r.getCell(1).value = tb.empty || '없음'; r.getCell(1).font = { italic: true, color: { argb: 'FF5B6779' } }; }
      tb.rows.forEach((vals, j) => { const r = ws.getRow(at++); vals.forEach((v, i) => putCell(r.getCell(i + 1), v, tb.cols[i].kind, j % 2 === 1)); });
    }
    at++;
  }
  if (!sp.hasInv) { ws.getCell(`A${at}`).value = '이 서버는 인벤토리가 없어 식별 구역만 채웠습니다.'; ws.getCell(`A${at}`).font = { italic: true, color: { argb: PAL.muted } }; }
}

/**
 * @param {object} model  rows.js buildHwModel
 * @param {{ basis:string, kindText:string, band:'band'|'sheet'|'col', admin:boolean, splitNote?:string }} meta
 * @returns {Promise<{buffer:Buffer, meta:{sheets:number}}>}
 */
export async function buildHwWorkbook(model, meta) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();
  const taken = new Set([SUMMARY_SHEET, INFO_SHEET, TOC_SHEET].map((s) => s.toLowerCase()));
  const corpsLine = `포함된 법인 ${model.corps.filter((c) => c.id).length}곳${model.corps.some((c) => !c.id) ? ' + 미지정' : ''} — ${model.corps.map((c) => c.name).join(' · ') || '없음'}`;
  const title = '서버 하드웨어 정보 — 서버 요약';
  if (meta.band === 'sheet') {
    for (const c of model.corps) {
      const rows = model.summary.rows.filter((r) => r.corpId === c.id);
      const t = { servers: c.count, bm: c.bm, vh: c.vh, cores: c.cores, memGiB: c.memGiB, noInventory: rows.filter((r) => /^인벤토리 없음/.test(String(r.cells[r.cells.length - 1] || ''))).length };
      await summarySheet(wb, sheetNameOf(`요약 ${c.name}`, taken), model, meta, rows, { band: false, corpsLine: `법인 ${c.name}`, totals: t, title: `서버 하드웨어 정보 — ${c.name}` });
      await yieldLoop();
    }
  } else {
    await summarySheet(wb, SUMMARY_SHEET, model, meta, model.summary.rows, { band: meta.band === 'band', corpsLine, totals: model.totals, title });
  }
  for (const d of model.details) { await detailSheet(wb, sheetNameOf(d.sheet, taken), d); await yieldLoop(); }
  infoSheet(wb, meta, model);
  if (Array.isArray(model.specs) && model.specs.length) {
    const toc = wb.addWorksheet(TOC_SHEET, { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }], pageSetup: { ...PRINT_PORTRAIT, printTitlesRow: '1:1' } });
    const tcols = [{ label: '법인(vCenter)', kind: 'text' }, { label: '구분', kind: 'text' }, { label: '서버(시트로 이동)', kind: 'text' }, { label: '서비스태그', kind: 'mono' }, { label: '모델', kind: 'text' }, { label: '비고', kind: 'text' }];
    toc.columns = [{ width: 28 }, { width: 18 }, { width: 30 }, { width: 16 }, { width: 30 }, { width: 50 }];
    headRow(toc, 1, tcols);
    let at = 2;
    for (const sp of model.specs) {
      const nm = sheetNameOf(sp.head.name, taken);
      specSheet(wb, nm, sp);
      const r = toc.getRow(at++);
      [sp.head.corpName, sp.head.kind, null, sp.head.serviceTag, sp.head.model, sp.head.note].forEach((v, i) => putCell(r.getCell(i + 1), v || null, tcols[i].kind, at % 2 === 1));
      r.getCell(3).value = { text: sp.head.name, hyperlink: sheetLink(nm) };
      r.getCell(3).font = { color: { argb: 'FF1D4ED8' }, underline: true };
      if (at % 50 === 0) await yieldLoop();
    }
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, meta: { sheets: wb.worksheets.length } };
}
