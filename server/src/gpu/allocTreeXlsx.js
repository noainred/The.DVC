/**
 * gpu/allocTreeXlsx.js — 'GPU 할당 계층' 엑셀(v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표 엑셀 내보내기' ·
 *   사용자 요청 "그 결과를 excel 로 내보내는 기능 추가, 예쁘게").
 *
 *  ① 계층 표 — 제목 · 요약 칸(전체 · 할당 · 예비 · 할당률 · 꺼진 VM · GPU·호스트) · 법인 › 데이터센터 › 클러스터 › 호스트 › GPU › VM 을
 *     엑셀 **행 그룹(개요)** 으로 묶는다(왼쪽 위 1~6 단추) · 단계마다 옅어지는 바탕 · 들여쓰기 · 할당률 막대(글자 █░ — 조건부 서식 없이)
 *  ② 평면 표 — GPU × VM 한 줄(계층 열을 모두 채운다) · 자동 필터 · 피벗용
 *  ③ 안내 — 용어 · 기준 · 빈 칸의 뜻
 * 값은 allocTree.js 가 만든 것을 배치만 한다(판정을 새로 하지 않는다). 못 읽은 값은 빈 칸('—' 글자 대신 — 숫자 열이라 합계·필터가 깨지지 않게).
 * 수식 칸·조건부 서식을 쓰지 않는다(vmXlsxStyle.js 머리말과 같은 이유 — 판마다 해석이 달라 '복구' 위험을 늘리지 않는다).
 * ⚠ 개요 + 폭 한 장 인쇄를 함께 쓰므로 util/xlsxSheetPrOrder.js 를 반드시 불러온다(v2.799.1 — Excel '복구' 대화상자).
 */
import ExcelJS from 'exceljs';
import '../util/xlsxSheetPrOrder.js';
import { BORDER, PAL, fill, styleHeadRow, barText } from '../vcenter/vmXlsxStyle.js';
import { FLAT_COLUMNS, MODE_TEXT, UNPLACED_TEXT, locationText, dcText, gpuNoteText, flatRows } from './allocTree.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const ALLOC_XLSX_SHEETS = Object.freeze(['계층 표', '평면 표', '안내']);
/**
 * v2.855: 내보내기 창(승인 시안 '계층 표 엑셀 내보내기')의 선택 — 계층 표에 넣을 단계 · 넣을 시트.
 * depth 는 계층 표 행의 깊이 상한(법인 0 · 데이터센터 1 · 클러스터 2 · 호스트 3 · GPU 4 · VM 5)이고 평면 표·안내에는 영향이 없다.
 */
export const ALLOC_DEPTHS = Object.freeze({ host: 4, gpu: 5, vm: 6 });
export const ALLOC_SHEET_KEYS = Object.freeze(['tree', 'flat', 'info']);
/**
 * 쿼리 → 선택. 모르는 값은 400(조용히 버리지 않는다). 안 주면 기본(VM 까지 · 시트 셋 다).
 * @returns {{ ok: true, depth: string, sheets: string[] } | { ok: false, reason: string }}
 */
export function allocExportOpts(q = {}) {
  const depth = q.depth == null || q.depth === '' ? 'vm' : String(q.depth);
  if (!Object.hasOwn(ALLOC_DEPTHS, depth)) return { ok: false, reason: '넣을 단계가 잘못됐습니다(host · gpu · vm).' };
  let sheets = [...ALLOC_SHEET_KEYS];
  if (q.sheets != null && q.sheets !== '') {
    const raw = String(q.sheets).slice(0, 100).split(',').map((x) => x.trim()).filter(Boolean);
    if (!raw.length || raw.some((x) => !ALLOC_SHEET_KEYS.includes(x))) return { ok: false, reason: '시트 선택이 잘못됐습니다(tree · flat · info).' };
    sheets = ALLOC_SHEET_KEYS.filter((k) => raw.includes(k));
  }
  return { ok: true, depth, sheets };
}
/** 파일 이름 — 화면 창의 미리보기와 실제 내려받기가 같은 함수를 쓴다(VM 까지가 아니면 단계를 붙인다). */
export const allocFileName = (fileScope, stamp, ext, depth = 'vm') => `gpu-allocation_${fileScope}_${stamp}${depth !== 'vm' ? `_${depth}` : ''}.${ext}`;
const PRINT = Object.freeze({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } });
const yieldLoop = () => new Promise((r) => setImmediate(r));
const C = Object.freeze({
  title: 'FF0F2A5F', muted: 'FF475569', alloc: 'FF1D4ED8', spare: 'FF047857', off: 'FFB45309', warn: 'FFB45309',
  kpiBg: 'FFF5F8FF', kpiLine: 'FFD6E2FA', spareBg: 'FFF0FDF9', offBg: 'FFFFFBEB', zebra: 'FFF8FAFC',
});
/** 단계 바탕·글자(0 = 법인). 위가 진하다(시안 ④). */
const LEVEL = Object.freeze([
  { bg: 'FF1E3A8A', fg: 'FFFFFFFF', bold: true, kind: '법인' },
  { bg: 'FFD6E2FA', fg: 'FF0F2A5F', bold: true, kind: '데이터센터' },
  { bg: 'FFE3EBFC', fg: 'FF0F2A5F', bold: true, kind: '클러스터' },
  { bg: 'FFF1F5FD', fg: 'FF111827', bold: true, kind: '호스트' },
  { bg: 'FFFFFFFF', fg: 'FF0F766E', bold: true, kind: 'GPU' },
  { bg: 'FFFFFFFF', fg: 'FF1F2937', bold: false, kind: 'VM' },
]);
const HEADS = Object.freeze([
  { h: '이름', w: 44 }, { h: '구분', w: 11 }, { h: 'GPU 모델 · 프로파일', w: 30 }, { h: '전체(GB)', w: 10 }, { h: '할당(GB)', w: 10 },
  { h: '예비(GB)', w: 10 }, { h: '할당률(%)', w: 10 }, { h: '할당률 막대', w: 14 }, { h: '꺼진 VM(GB)', w: 14 }, { h: 'VM 켜짐/꺼짐', w: 15 }, { h: '비고', w: 44 },
]);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function totalsCells(t) {
  const pct = num(t.allocPct);
  const notes = [];
  if (t.capUnknown) notes.push(`용량 모르는 GPU ${t.capUnknown}장`);
  if (t.allocUnknown) notes.push(`할당 모르는 VM ${t.allocUnknown}대`);
  if (t.noPlacement) notes.push(`배치 정보 없는 GPU ${t.noPlacement}장`);
  if (num(t.spareGB) != null && t.spareGB < 0) notes.push('할당이 용량을 넘음 — 확인 필요');
  else if (pct != null && pct >= 90) notes.push('포화(90% 이상)');
  return { cap: num(t.capGB), alloc: num(t.allocGB), spare: num(t.spareGB), pct, bar: pct == null ? '' : barText(pct / 100, 10), off: t.offGB ? t.offGB : null, vms: `${t.vmsOn} / ${t.vmsOff}`, note: notes.join(' · ') };
}

/** 계층 → 행 목록(depth·셀). 화면 표와 같은 순서. */
export function treeLines(tree) {
  const L = [];
  const push = (depth, name, kind, model, c) => L.push({ depth, cells: [name, kind, model, c.cap, c.alloc, c.spare, c.pct, c.bar, c.off, c.vms, c.note] });
  for (const vc of tree.vcenters) {
    const loc = locationText(vc);
    push(0, loc ? `${vc.name}  (${loc})` : vc.name, '법인', `GPU ${vc.totals.gpus}장 · 호스트 ${vc.totals.hosts}대`, totalsCells(vc.totals));
    for (const dc of vc.datacenters) {
      push(1, dcText(dc.name), '데이터센터', `GPU ${dc.totals.gpus}장 · 호스트 ${dc.totals.hosts}대`, totalsCells(dc.totals));
      for (const cl of dc.clusters) {
        push(2, cl.name, '클러스터', `GPU ${cl.totals.gpus}장 · 호스트 ${cl.totals.hosts}대`, totalsCells(cl.totals));
        for (const h of cl.hosts) {
          const modes = [...new Set(h.gpus.map((g) => MODE_TEXT[g.mode] || g.mode))].join('·');
          push(3, h.name, '호스트', `${h.models.join(', ')} ×${h.gpus.length} · ${modes}`, totalsCells(h.totals));
          for (const g of h.gpus) {
            const pct = g.allocGB != null && g.capGB ? Math.round((g.allocGB / g.capGB) * 100) : null;
            const prof = g.mode === 'passthrough' ? (g.vms.length ? '패스스루 · 1장 할당' : '패스스루 · 미할당')
              : g.mode === 'vsga' ? 'vSGA' : g.slots?.profile ? `${g.slots.profile} · ${g.slots.used}/${g.slots.total ?? '?'} 슬롯` : g.vms.length ? '여러 프로파일' : '비어 있음';
            push(4, `GPU #${g.idx} · ${g.model}`, MODE_TEXT[g.mode] || 'GPU', prof,
              { cap: num(g.capGB), alloc: num(g.allocGB), spare: num(g.spareGB), pct, bar: pct == null ? '' : barText(pct / 100, 10), off: null, vms: g.mode === 'vsga' ? '' : `${g.vms.length} / 0`, note: gpuNoteText(g) + (g.capBasis === 'model' ? ' · GB 는 모델명 추정' : '') });
            for (const v of g.vms) push(5, v.name, 'VM', v.mode === 'passthrough' ? '패스스루 1장' : v.profile, { cap: null, alloc: num(v.gb), spare: null, pct: null, bar: '', off: null, vms: '켜짐', note: v.gb == null ? '프로파일 해석 불가 — 빈 칸(0 아님)' : v.gbEstimated ? 'GB 는 모델명 추정' : '' });
          }
          if (h.unplaced.length) {
            push(4, '배치 안 된 켜진 VM', '미배치', '', { cap: null, alloc: null, spare: null, pct: null, bar: '', off: null, vms: `${h.unplaced.length} / 0`, note: '할당은 호스트 합계에 들어감 — 어느 GPU 인지 모름' });
            for (const v of h.unplaced) push(5, v.name, 'VM', v.profile || `패스스루 ${v.passthroughDevices}장`, { cap: null, alloc: num(v.gb), spare: null, pct: null, bar: '', off: null, vms: '켜짐', note: UNPLACED_TEXT[v.reason] || '' });
          }
          if (h.off.length) {
            push(4, '꺼진 VM', '꺼짐', '', { cap: null, alloc: null, spare: null, pct: null, bar: '', off: num(h.totals.offGB), vms: `0 / ${h.off.length}`, note: 'GPU 에 올라가 있지 않음 — 할당에서 제외' });
            for (const v of h.off) push(5, v.name, 'VM', v.profile || `패스스루 ${v.passthroughDevices}장`, { cap: null, alloc: null, spare: null, pct: null, bar: '', off: num(v.gb), vms: '꺼짐', note: `켜면 ${v.gb == null ? '?' : v.gb} GB 필요` });
          }
        }
      }
    }
  }
  return L;
}

/**
 * @param {object} tree buildGpuAllocTree 결과
 * @param {{ stamp: string, tz: string, scopeText: string }} meta
 * @returns {Promise<Buffer>}
 */
export async function renderGpuAllocWorkbook(tree, meta, { depth = 'vm', sheets = ALLOC_SHEET_KEYS } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();
  const T = tree.totals;
  const maxDepth = ALLOC_DEPTHS[depth] ?? ALLOC_DEPTHS.vm;
  const DEPTH_TEXT = { host: '호스트까지', gpu: 'GPU 까지', vm: 'VM 까지' };

  /* ① 계층 표 */
  if (sheets.includes('tree')) {
  const ws = wb.addWorksheet(ALLOC_XLSX_SHEETS[0], {
    views: [{ state: 'frozen', ySplit: 5, xSplit: 1, showGridLines: false }],
    properties: { outlineLevelRow: 0 },
    pageSetup: { ...PRINT, printTitlesRow: '5:5' },
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.columns = HEADS.map((x) => ({ width: x.w }));
  const t1 = ws.addRow([`GPU 할당 계층 — ${meta.scopeText}`]);
  t1.getCell(1).font = { bold: true, size: 15, color: { argb: C.title } }; t1.height = 26;
  ws.addRow([`기준 ${meta.stamp} ${meta.tz} · 단위 GB · 할당 = 켜진 VM · 예비 = 전체 − 할당 · ${DEPTH_TEXT[depth] || ''} · 왼쪽 위 1~${maxDepth} 단추로 단계별 접기`]).getCell(1).font = { color: { argb: C.muted } };
  // 요약 칸 — 두 칸씩(이름 / 값)
  const kpis = [
    ['전체 용량(GB)', num(T.capGB), C.title, C.kpiBg], ['할당(GB)', num(T.allocGB), C.alloc, C.kpiBg], ['예비(GB)', num(T.spareGB), C.spare, C.spareBg],
    ['할당률(%)', num(T.allocPct), C.title, C.kpiBg], ['꺼진 VM(GB)', num(T.offGB), C.off, C.offBg], ['GPU · 호스트', `${T.gpus}장 · ${T.hosts}대`, C.title, C.kpiBg],
  ];
  const kName = ws.addRow(kpis.map((k) => k[0]));
  const kVal = ws.addRow(kpis.map((k) => (k[1] == null ? '모름' : k[1])));
  kpis.forEach((k, i) => {
    const a = kName.getCell(i + 1); const b = kVal.getCell(i + 1);
    a.fill = fill(k[3]); b.fill = fill(k[3]);
    a.font = { size: 9, color: { argb: C.muted } }; b.font = { bold: true, size: 14, color: { argb: k[2] } };
    a.border = { top: { style: 'thin', color: { argb: C.kpiLine } }, left: { style: 'thin', color: { argb: C.kpiLine } }, right: { style: 'thin', color: { argb: C.kpiLine } } };
    b.border = { bottom: { style: 'thin', color: { argb: C.kpiLine } }, left: { style: 'thin', color: { argb: C.kpiLine } }, right: { style: 'thin', color: { argb: C.kpiLine } } };
    b.alignment = { horizontal: 'left' };
  });
  kVal.height = 22;
  const head = ws.addRow(HEADS.map((x) => x.h));
  styleHeadRow(head, { height: 24 });
  head.eachCell((c, i) => { if (i >= 4 && i <= 10 && i !== 8) c.alignment = { vertical: 'middle', horizontal: 'right' }; });
  let i = 0; let maxLevel = 0;
  for (const ln of treeLines(tree).filter((x) => x.depth < maxDepth)) {
    const lv = LEVEL[ln.depth];
    const r = ws.addRow(ln.cells);
    r.outlineLevel = ln.depth;
    maxLevel = Math.max(maxLevel, ln.depth);
    r.height = ln.depth >= 4 ? 17 : 20;
    r.eachCell({ includeEmpty: true }, (c, col) => {
      c.fill = fill(lv.bg);
      c.border = BORDER;
      c.font = { bold: lv.bold && col <= 3, color: { argb: lv.fg }, size: ln.depth >= 4 ? 10 : 11 };
      c.alignment = { vertical: 'middle', ...(col === 1 ? { indent: ln.depth * 2 } : {}), ...(col >= 4 && col <= 10 && col !== 8 ? { horizontal: 'right' } : {}) };
    });
    const dark = ln.depth === 0;
    r.getCell(5).font = { ...r.getCell(5).font, bold: true, color: { argb: dark ? 'FFFFFFFF' : C.alloc } };
    r.getCell(6).font = { ...r.getCell(6).font, bold: true, color: { argb: dark ? 'FFA7F3D0' : C.spare } };
    r.getCell(9).font = { ...r.getCell(9).font, color: { argb: dark ? 'FFFDE68A' : C.off } };
    r.getCell(8).font = { name: 'Consolas', size: 9, color: { argb: (num(ln.cells[6]) ?? 0) >= 90 ? (dark ? 'FFFDBA74' : C.warn) : (dark ? 'FF93C5FD' : C.alloc) } };
    r.getCell(11).font = { size: 9, color: { argb: dark ? 'FFDBE6FB' : C.muted } };
    if (++i % 500 === 0) await yieldLoop();
  }
  // 개요 단추(왼쪽 위 1~N) 개수 — 0 이면 Excel 이 단추를 그리지 않는다(vmListXlsx.js 와 같다).
  ws.properties.outlineLevelRow = maxLevel;
  if (tree.truncated) ws.addRow([`※ GPU 호스트가 많아 ${tree.truncated}대를 넣지 않았습니다.`]).getCell(1).font = { color: { argb: C.warn } };

  }

  /* ② 평면 표 */
  if (sheets.includes('flat')) {
  const wf = wb.addWorksheet(ALLOC_XLSX_SHEETS[1], { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }], pageSetup: { ...PRINT, printTitlesRow: '1:1' } });
  const FW = { vcenter: 26, location: 20, datacenter: 16, cluster: 18, host: 22, gpuIdx: 6, gpuModel: 22, gpuMode: 10, gpuCapGB: 12, gpuAllocGB: 12, gpuSpareGB: 12, slots: 12, vm: 24, power: 7, profile: 20, vmGB: 12, note: 36 };
  wf.columns = FLAT_COLUMNS.map(([k]) => ({ key: k, width: FW[k] || 14 }));
  styleHeadRow(wf.addRow(FLAT_COLUMNS.map(([, h]) => h)), { height: 24 });
  const NUMK = new Set(['gpuIdx', 'gpuCapGB', 'gpuAllocGB', 'gpuSpareGB', 'vmGB']);
  let j = 0;
  for (const fr of flatRows(tree)) {
    const r = wf.addRow(FLAT_COLUMNS.map(([k]) => (fr[k] === '' ? null : fr[k])));
    const zebra = j % 2 === 1;
    r.eachCell({ includeEmpty: true }, (c, col) => {
      const k = FLAT_COLUMNS[col - 1][0];
      c.border = BORDER;
      if (zebra) c.fill = fill(C.zebra);
      if (NUMK.has(k)) c.alignment = { horizontal: 'right' };
      if (k === 'gpuSpareGB') c.font = { bold: true, color: { argb: C.spare } };
      if (k === 'vmGB') c.font = { bold: true, color: { argb: C.alloc } };
      if (k === 'note' && fr.note) c.font = { color: { argb: fr.power === '꺼짐' || /모름|불가|없음/.test(fr.note) ? C.warn : C.muted } };
      if (k === 'power') c.font = { color: { argb: fr.power === '켜짐' ? PAL.green : 'FF64748B' }, bold: fr.power === '켜짐' };
    });
    if (++j % 1000 === 0) await yieldLoop();
  }
  wf.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, j + 1), column: FLAT_COLUMNS.length } };

  }

  /* ③ 안내 */
  if (sheets.includes('info')) {
  const wi = wb.addWorksheet(ALLOC_XLSX_SHEETS[2]);
  wi.columns = [{ width: 18 }, { width: 110 }];
  const ti = wi.addRow(['이 파일을 읽는 법']);
  ti.getCell(1).font = { bold: true, size: 14, color: { argb: C.title } };
  wi.addRow([]);
  const info = [
    ['기준', `${meta.stamp} ${meta.tz} · 범위 ${meta.scopeText} · 계층 표 ${DEPTH_TEXT[depth] || ''}`],
    ['계층', `법인(vCenter) › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM. 계층 표 시트는 행 그룹(개요)으로 묶여 있어 왼쪽 위 1~${maxDepth} 단추로 접고 펼칩니다. 넣을 단계(호스트까지 · GPU 까지 · VM 까지)는 계층 표에만 적용되고 평면 표는 늘 GPU·VM 한 줄씩입니다.`],
    ['전체', 'GPU 한 장의 명목 용량 × 장수(vGPU 프로파일 GB 가 명목 단위라 vCenter 보고값보다 크면 명목값). 패스스루 GPU 는 PCI 정보에 메모리가 없어 모델명으로 추정합니다.'],
    ['할당', '켜진 VM 이 받은 프레임버퍼 — vGPU 는 프로파일 이름 끝 숫자(GB) × 장치 수, 패스스루는 GPU 한 장 전체.'],
    ['예비', '전체 − 할당. 용량이나 할당을 모르는 것이 섞이면 비웁니다(부분 합을 예비로 적지 않습니다). 프로파일이 올라간 GPU 의 예비는 같은 프로파일 슬롯 단위로만 쓸 수 있습니다(혼합 크기 모드 제외).'],
    ['꺼진 VM', 'GPU 에 올라가 있지 않아 할당에서 빼고, 켜려면 필요한 GB 를 따로 적습니다.'],
    ['배치 안 된 VM', '켜져 있는데 GPU 별 목록에서 찾지 못한 VM 입니다. 할당은 호스트 합계에 들어갑니다. 수집기가 GPU 별 배치를 아직 보내지 않는 경우(구버전) 그 호스트 GPU 의 할당·예비는 비웁니다.'],
    ['빈 칸', '못 읽은 값입니다. 0 으로 채우지 않습니다.'],
    ['vSGA', '공유 그래픽이라 할당형이 아닙니다. 행으로만 보이고 합계에 넣지 않습니다.'],
    ['평면 표', 'GPU·VM 한 줄마다 모든 계층 열을 채운 시트 — 자동 필터와 피벗 테이블용입니다.'],
  ];
  for (const [k, v] of info) {
    const r = wi.addRow([k, v]);
    r.getCell(1).fill = fill('FFEEF4FF'); r.getCell(1).font = { bold: true, color: { argb: C.title } };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.eachCell((c) => { c.border = BORDER; });
  }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** CSV(평면 표와 같은 열) — BOM 은 라우트가 붙인다. */
export function allocCsvLines(tree, csvCell) {
  const lines = [FLAT_COLUMNS.map(([, h]) => csvCell(h)).join(',')];
  for (const fr of flatRows(tree)) lines.push(FLAT_COLUMNS.map(([k]) => csvCell(fr[k])).join(','));
  return lines;
}
