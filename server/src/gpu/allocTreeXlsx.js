/**
 * gpu/allocTreeXlsx.js — 'GPU 할당 계층' 엑셀(v2.852 — 승인 시안 https://claude.ai/artifact/GQKnG775UijSAU7aUSFFeB '계층 표 엑셀 내보내기' ·
 *   사용자 요청 "그 결과를 excel 로 내보내는 기능 추가, 예쁘게").
 *
 *  ① 계층 표 — 제목 · 요약 칸(전체 · 할당 · 예비 · 할당률 · 꺼진 VM · GPU·호스트) · 법인 › 데이터센터 › 클러스터 › 호스트 › GPU › VM 을
 *     엑셀 **행 그룹(개요)** 으로 묶는다(왼쪽 위 1~6 단추) · 단계마다 옅어지는 바탕 · 들여쓰기 · 할당률 막대(글자 █░ — 조건부 서식 없이)
 *  ② 평면 표 — GPU × VM 한 줄(계층 열을 모두 채운다) · 자동 필터 · 피벗용
 *  ③ 안내 — 용어 · 기준 · 빈 칸의 뜻
 *  ④ v2.869 법인별 시트(승인 시안 https://claude.ai/artifact/6LcrjcPjNw5n5jinDCHppa · docs/design/gpu-alloc-corp-sheets/) — '목차' 시트(범위 안 법인 전부 ·
 *     법인 시트로 가는 링크) + GPU 호스트가 있는 법인마다 계층 표 한 장(전체 계층 표를 그리는 같은 함수에 그 법인 하나짜리 계층을 준다 — 값을 새로 내지 않는다).
 * 값은 allocTree.js 가 만든 것을 배치만 한다(판정을 새로 하지 않는다). 못 읽은 값은 빈 칸('—' 글자 대신 — 숫자 열이라 합계·필터가 깨지지 않게).
 * 수식 칸·조건부 서식을 쓰지 않는다(vmXlsxStyle.js 머리말과 같은 이유 — 판마다 해석이 달라 '복구' 위험을 늘리지 않는다).
 * ⚠ 개요 + 폭 한 장 인쇄를 함께 쓰므로 util/xlsxSheetPrOrder.js 를 반드시 불러온다(v2.799.1 — Excel '복구' 대화상자).
 */
import ExcelJS from 'exceljs';
import '../util/xlsxSheetPrOrder.js';
import { BORDER, PAL, fill, styleHeadRow, barText } from '../vcenter/vmXlsxStyle.js';
import { sheetLink } from '../util/xlsxInternalLink.js';   // 목차 ↔ 법인 시트 링크를 규격 모양(location 만)으로 — 워커가 아니어도 같은 모듈이 건다
import { FLAT_COLUMNS, MODE_TEXT, UNPLACED_TEXT, locationText, dcText, gpuNoteText, flatRows } from './allocTree.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const ALLOC_XLSX_SHEETS = Object.freeze(['계층 표', '평면 표', '안내', '목차']);
/**
 * v2.855: 내보내기 창(승인 시안 '계층 표 엑셀 내보내기')의 선택 — 계층 표에 넣을 단계 · 넣을 시트.
 * depth 는 계층 표 행의 깊이 상한(법인 0 · 데이터센터 1 · 클러스터 2 · 호스트 3 · GPU 4 · VM 5)이고 평면 표·안내에는 영향이 없다.
 */
export const ALLOC_DEPTHS = Object.freeze({ host: 4, gpu: 5, vm: 6 });
// v2.869: corp = '목차' + 법인(vCenter)마다 계층 표 한 장(기본 켬 — 사용자 승인 시안). 옛 화면이 tree,flat,info 를 보내면 지금처럼 3시트다.
export const ALLOC_SHEET_KEYS = Object.freeze(['tree', 'flat', 'info', 'corp']);
/** 법인 시트 상한 — 쿼리의 vcenterIds 상한(100)과 같다. 넘는 법인은 목차에만 적는다(시트 수·만드는 시간이 끝없이 늘지 않게). */
export const CORP_SHEETS_MAX = 100;
export const SHEET_NAME_MAX = 31;
/**
 * 쿼리 → 선택. 모르는 값은 400(조용히 버리지 않는다). 안 주면 기본(VM 까지 · 시트 넷 다).
 * @returns {{ ok: true, depth: string, sheets: string[] } | { ok: false, reason: string }}
 */
export function allocExportOpts(q = {}) {
  const depth = q.depth == null || q.depth === '' ? 'vm' : String(q.depth);
  if (!Object.hasOwn(ALLOC_DEPTHS, depth)) return { ok: false, reason: '넣을 단계가 잘못됐습니다(host · gpu · vm).' };
  let sheets = [...ALLOC_SHEET_KEYS];
  if (q.sheets != null && q.sheets !== '') {
    const raw = String(q.sheets).slice(0, 100).split(',').map((x) => x.trim()).filter(Boolean);
    if (!raw.length || raw.some((x) => !ALLOC_SHEET_KEYS.includes(x))) return { ok: false, reason: '시트 선택이 잘못됐습니다(tree · flat · info · corp).' };
    sheets = ALLOC_SHEET_KEYS.filter((k) => raw.includes(k));
  }
  return { ok: true, depth, sheets };
}
/** 파일 이름 — 화면 창의 미리보기와 실제 내려받기가 같은 함수를 쓴다(VM 까지가 아니면 단계를, 법인별 시트가 들어가면 _percorp 를 붙인다). */
export const allocFileName = (fileScope, stamp, ext, depth = 'vm', percorp = false) =>
  `gpu-allocation_${fileScope}_${stamp}${depth !== 'vm' ? `_${depth}` : ''}${percorp ? '_percorp' : ''}.${ext}`;

/**
 * v2.869: 법인 시트 이름 — 엑셀 규칙(31자 · \ / ? * [ ] : 금지 · 작은따옴표로 시작·끝 금지 · 대소문자 무시 중복 금지).
 * vCenter 이름을 정리하고 31자로 자른 뒤 끝의 - . 공백을 떼고, 고정 시트(계층 표 · 평면 표 · 안내 · 목차)나 앞 법인과 겹치면 '~2' 처럼 번호를 붙인다
 * (vcenter/hostExport.js hostSheetNames 와 같은 규칙). 원래 이름은 목차와 시트 1행에 있으므로 줄어도 찾을 수 있다.
 * @param {{ id: string, name: string }[]} corps 시트를 만들 법인(이 순서대로 이름을 정한다)
 * @returns {Map<string, { sheet: string, renamed: boolean }>} id → 시트 이름 · 원래 이름과 다른가
 */
export function corpSheetNames(corps) {
  const used = new Set(ALLOC_XLSX_SHEETS.map((x) => x.toLowerCase()));
  const out = new Map();
  for (const c of corps) {
    const raw = String(c.name || c.id || '');
    const base = raw.replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim().slice(0, SHEET_NAME_MAX).replace(/[-.\s]+$/, '') || '법인';
    let name = base; let n = 2;
    while (used.has(name.toLowerCase())) { const tail = `~${n++}`; name = base.slice(0, SHEET_NAME_MAX - tail.length) + tail; }
    used.add(name.toLowerCase());
    out.set(c.id, { sheet: name, renamed: name !== raw });
  }
  return out;
}
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
  { h: '예비(GB)', w: 10 }, { h: '할당률(%)', w: 10 }, { h: '할당률 막대', w: 14 }, { h: '꺼진 VM(GB)', w: 14 }, { h: 'VM 켜짐/꺼짐', w: 15 },
  // v2.868: 호스트·VM CPU/메모리(호스트 행 = 호스트 값 · VM 행 = VM 값 · 법인~클러스터 = 호스트 합과 MHz·MB 가중 사용률) + 켜진 GPU VM 의 vCPU·메모리 합
  { h: '코어 · vCPU', w: 11 }, { h: 'CPU(%)', w: 9 }, { h: '메모리(GB)', w: 12 }, { h: '메모리(%)', w: 10 }, { h: 'GPU VM vCPU 합', w: 14 }, { h: 'GPU VM 메모리 합(GB)', w: 17 },
  { h: '비고', w: 44 },
]);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function totalsCells(t) {
  const pct = num(t.allocPct);
  const notes = [];
  if (t.capUnknown) notes.push(`용량 모르는 GPU ${t.capUnknown}장`);
  if (t.allocUnknown) notes.push(`할당 모르는 VM ${t.allocUnknown}대`);
  if (t.noPlacement) notes.push(`배치 정보 없는 GPU ${t.noPlacement}장`);
  if (t.hostUseUnknown && t.hosts > 1) notes.push(`CPU·메모리 사용률은 ${t.hostUseUnknown}대 제외(못 읽음·끊김)`);
  if (num(t.spareGB) != null && t.spareGB < 0) notes.push('할당이 용량을 넘음 — 확인 필요');
  else if (pct != null && pct >= 90) notes.push('포화(90% 이상)');
  return { cap: num(t.capGB), alloc: num(t.allocGB), spare: num(t.spareGB), pct, bar: pct == null ? '' : barText(pct / 100, 10), off: t.offGB ? t.offGB : null, vms: `${t.vmsOn} / ${t.vmsOff}`, note: notes.join(' · '),
    res: { cores: num(t.hostCores), cpuPct: num(t.hostCpuPct), memGB: num(t.hostMemGB), memPct: num(t.hostMemPct), vmVcpu: num(t.vmVcpu), vmMemGB: num(t.vmMemGB) } };
}
/** v2.868: VM 행의 CPU/메모리 — 꺼진 VM 의 사용률은 빈 칸(allocTree.vmResOf 가 null 로 둔다). */
const vmResCells = (v) => { const r = v.res || {}; return { cores: num(r.vcpu), cpuPct: num(r.cpuPct), memGB: num(r.memGB), memPct: num(r.memPct), vmVcpu: null, vmMemGB: null }; };

/** 계층 → 행 목록(depth·셀). 화면 표와 같은 순서. */
export function treeLines(tree) {
  const L = [];
  const push = (depth, name, kind, model, c) => {
    const r = c.res || {};
    L.push({ depth, cells: [name, kind, model, c.cap, c.alloc, c.spare, c.pct, c.bar, c.off, c.vms, r.cores ?? null, r.cpuPct ?? null, r.memGB ?? null, r.memPct ?? null, r.vmVcpu ?? null, r.vmMemGB ?? null, c.note] });
  };
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
            for (const v of g.vms) push(5, v.name, 'VM', v.mode === 'passthrough' ? '패스스루 1장' : v.profile, { res: vmResCells(v), cap: null, alloc: num(v.gb), spare: null, pct: null, bar: '', off: null, vms: '켜짐', note: v.gb == null ? '프로파일 해석 불가 — 빈 칸(0 아님)' : v.gbEstimated ? 'GB 는 모델명 추정' : '' });
          }
          if (h.unplaced.length) {
            push(4, '배치 안 된 켜진 VM', '미배치', '', { cap: null, alloc: null, spare: null, pct: null, bar: '', off: null, vms: `${h.unplaced.length} / 0`, note: '할당은 호스트 합계에 들어감 — 어느 GPU 인지 모름' });
            for (const v of h.unplaced) push(5, v.name, 'VM', v.profile || `패스스루 ${v.passthroughDevices}장`, { res: vmResCells(v), cap: null, alloc: num(v.gb), spare: null, pct: null, bar: '', off: null, vms: '켜짐', note: UNPLACED_TEXT[v.reason] || '' });
          }
          if (h.off.length) {
            push(4, '꺼진 VM', '꺼짐', '', { cap: null, alloc: null, spare: null, pct: null, bar: '', off: num(h.totals.offGB), vms: `0 / ${h.off.length}`, note: 'GPU 에 올라가 있지 않음 — 할당에서 제외' });
            for (const v of h.off) push(5, v.name, 'VM', v.profile || `패스스루 ${v.passthroughDevices}장`, { res: vmResCells(v), cap: null, alloc: null, spare: null, pct: null, bar: '', off: num(v.gb), vms: '꺼짐', note: `켜면 ${v.gb == null ? '?' : v.gb} GB 필요` });
          }
        }
      }
    }
  }
  return L;
}

const DEPTH_TEXT = Object.freeze({ host: '호스트까지', gpu: 'GPU 까지', vm: 'VM 까지' });
const TAB = Object.freeze({ toc: 'FF64748B', corp: 'FF3B82F6', hot: 'FFF59E0B' });

/** 제목이 차지하는 폭(15pt 굵게 ≈ 기본 글자 1.5칸, 한글은 2칸으로 어림) 뒤의 첫 칸 — 열 너비(HEADS)를 더해 찾는다. */
export function backLinkCol(title) {
  const need = [...String(title)].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0) * 1.5 + 2;
  let w = 0;
  for (let i = 0; i < HEADS.length; i++) { w += HEADS[i].w; if (w >= need) return i + 2; }
  return HEADS.length;
}

/**
 * 계층 표 시트 하나 — 전체 법인('계층 표')과 법인 시트가 같은 함수를 쓴다(입력 계층만 다르다).
 * @param {{ title: string, sub?: string, back?: string|null, tab?: string|null, truncatedNote?: string }} o
 */
async function addTreeSheet(wb, name, tree, meta, depth, o) {
  const T = tree.totals;
  const maxDepth = ALLOC_DEPTHS[depth] ?? ALLOC_DEPTHS.vm;
  const ws = wb.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 5, xSplit: 1, showGridLines: false }],
    properties: { outlineLevelRow: 0, ...(o.tab ? { tabColor: { argb: o.tab } } : {}) },
    pageSetup: { ...PRINT, printTitlesRow: '5:5' },
  });
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  ws.columns = HEADS.map((x) => ({ width: x.w }));
  const t1 = ws.addRow([o.title]);
  t1.getCell(1).font = { bold: true, size: 15, color: { argb: C.title } }; t1.height = 26;
  // v2.869: 법인 시트 1행 — 목차로 돌아가는 링크. 제목(15pt 굵게)이 오른쪽 칸으로 넘쳐 보이므로 링크를 제목이 끝나는 칸 뒤에 둔다
  //   (칸에 값이 있으면 엑셀이 넘침을 자른다 — 긴 vCenter 이름 + 위치가 잘리지 않게).
  if (o.back) { const c = t1.getCell(backLinkCol(o.title)); c.value = { text: '← 목차', hyperlink: sheetLink(o.back) }; c.font = { color: { argb: C.alloc }, underline: true }; c.alignment = { vertical: 'middle' }; }
  ws.addRow([`기준 ${meta.stamp} ${meta.tz} · ${o.sub ? `${o.sub} · ` : ''}단위 GB · 할당 = 켜진 VM · 예비 = 전체 − 할당 · ${DEPTH_TEXT[depth] || ''} · 왼쪽 위 1~${maxDepth} 단추로 단계별 접기`]).getCell(1).font = { color: { argb: C.muted } };
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
  styleHeadRow(head, { height: 32 });   // v2.868: CPU/메모리 열 머리가 두 줄이 될 수 있다
  head.eachCell((c, i) => { if (i >= 4 && i <= 16 && i !== 8) c.alignment = { vertical: 'middle', horizontal: 'right', wrapText: true }; });
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
      c.alignment = { vertical: 'middle', ...(col === 1 ? { indent: ln.depth * 2 } : {}), ...(col >= 4 && col <= 16 && col !== 8 ? { horizontal: 'right' } : {}) };
    });
    const dark = ln.depth === 0;
    r.getCell(5).font = { ...r.getCell(5).font, bold: true, color: { argb: dark ? 'FFFFFFFF' : C.alloc } };
    r.getCell(6).font = { ...r.getCell(6).font, bold: true, color: { argb: dark ? 'FFA7F3D0' : C.spare } };
    r.getCell(9).font = { ...r.getCell(9).font, color: { argb: dark ? 'FFFDE68A' : C.off } };
    r.getCell(8).font = { name: 'Consolas', size: 9, color: { argb: (num(ln.cells[6]) ?? 0) >= 90 ? (dark ? 'FFFDBA74' : C.warn) : (dark ? 'FF93C5FD' : C.alloc) } };
    r.getCell(17).font = { size: 9, color: { argb: dark ? 'FFDBE6FB' : C.muted } };
    if (++i % 500 === 0) await yieldLoop();
  }
  // 개요 단추(왼쪽 위 1~N) 개수 — 0 이면 Excel 이 단추를 그리지 않는다(vmListXlsx.js 와 같다).
  ws.properties.outlineLevelRow = maxLevel;
  if (o.truncatedNote) ws.addRow([o.truncatedNote]).getCell(1).font = { color: { argb: C.warn } };
  return ws;
}

/** v2.869: '목차' — 범위 안 법인 전부 한 줄씩(GPU 호스트가 없는 법인 포함) · 법인 이름은 그 법인 시트로 가는 링크. */
function addTocSheet(wb, roster, names, meta, skipped) {
  const ws = wb.addWorksheet(ALLOC_XLSX_SHEETS[3], {
    views: [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: false }],
    properties: { tabColor: { argb: TAB.toc } },
    pageSetup: { ...PRINT, printTitlesRow: '3:3' },
  });
  ws.columns = [{ width: 34 }, { width: 24 }, { width: 11 }, { width: 8 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 14 }, { width: 40 }];
  const withSheet = roster.filter((c) => names.has(c.id)).length;
  const t1 = ws.addRow(['목차 — 법인별 시트']);
  t1.getCell(1).font = { bold: true, size: 15, color: { argb: C.title } }; t1.height = 26;
  ws.addRow([`기준 ${meta.stamp} ${meta.tz} · 범위 ${meta.scopeText} · 법인 ${roster.length}곳 — 시트 ${withSheet}장 · 단위 GB · 법인 이름을 누르면 그 법인 시트로 갑니다`]).getCell(1).font = { color: { argb: C.muted } };
  const head = ws.addRow(['법인(vCenter)', '위치', 'GPU 호스트', 'GPU', '전체(GB)', '할당(GB)', '예비(GB)', '할당률(%)', '할당률 막대', '시트']);
  styleHeadRow(head, { height: 24 });
  head.eachCell((c, i) => { if (i >= 3 && i <= 8) c.alignment = { vertical: 'middle', horizontal: 'right' }; });
  roster.forEach((c, j) => {
    const t = c.vc?.totals || null;
    const nm = names.get(c.id);
    const pct = t ? num(t.allocPct) : null;
    const sheetText = nm ? (nm.renamed ? `${nm.sheet}  (시트 이름을 줄이거나 바꿈)` : nm.sheet)
      : t ? '— 시트 상한을 넘어 넣지 않음' : '— GPU 호스트 없음(시트 없음)';
    const r = ws.addRow([c.name, locationText(c), t ? t.hosts : 0, t ? t.gpus : 0, t ? num(t.capGB) : null, t ? num(t.allocGB) : null, t ? num(t.spareGB) : null,
      pct, pct == null ? '' : barText(pct / 100, 10), sheetText]);
    r.height = 20;
    r.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.border = BORDER;
      if (j % 2 === 1) cell.fill = fill(C.zebra);
      if (!t) cell.font = { color: { argb: 'FF64748B' } };
      if (col >= 3 && col <= 8) cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
    if (nm) { const a = r.getCell(1); a.value = { text: c.name, hyperlink: sheetLink(nm.sheet) }; a.font = { bold: true, underline: true, color: { argb: C.alloc } }; }
    else r.getCell(1).font = { bold: true, color: { argb: t ? C.muted : 'FF64748B' } };
    if (t) {
      r.getCell(6).font = { bold: true, color: { argb: C.alloc } };
      r.getCell(7).font = { bold: true, color: { argb: C.spare } };
      r.getCell(9).font = { name: 'Consolas', size: 9, color: { argb: (pct ?? 0) >= 90 ? C.warn : C.alloc } };
    }
    r.getCell(10).font = { size: 10, color: { argb: nm?.renamed ? C.warn : C.muted } };
  });
  if (skipped) ws.addRow([`※ 법인 시트는 ${CORP_SHEETS_MAX}장까지입니다 — ${skipped}곳은 목차에만 적었습니다(법인을 골라 다시 내보내세요).`]).getCell(1).font = { color: { argb: C.warn } };
  return ws;
}

/**
 * @param {object} tree buildGpuAllocTree 결과
 * @param {{ stamp: string, tz: string, scopeText: string }} meta
 * @param {{ depth?: string, sheets?: string[], roster?: object[]|null }} opt roster = allocCorpRoster(법인별 시트 · 목차 — 없으면 계층의 법인만)
 * @returns {Promise<Buffer>}
 */
export async function renderGpuAllocWorkbook(tree, meta, { depth = 'vm', sheets = ALLOC_SHEET_KEYS, roster = null } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();
  const maxDepth = ALLOC_DEPTHS[depth] ?? ALLOC_DEPTHS.vm;
  const truncatedNote = tree.truncated ? `※ GPU 호스트가 많아 ${tree.truncated}대를 넣지 않았습니다.` : '';

  /* ① 계층 표 */
  if (sheets.includes('tree')) {
    await addTreeSheet(wb, ALLOC_XLSX_SHEETS[0], tree, meta, depth, { title: `GPU 할당 계층 — ${meta.scopeText}`, truncatedNote });
  }

  /* ② 평면 표 */
  if (sheets.includes('flat')) {
  const wf = wb.addWorksheet(ALLOC_XLSX_SHEETS[1], { views: [{ state: 'frozen', ySplit: 1, xSplit: 0 }], pageSetup: { ...PRINT, printTitlesRow: '1:1' } });
  const FW = { vcenter: 26, location: 20, datacenter: 16, cluster: 18, host: 22, gpuIdx: 6, gpuModel: 22, gpuMode: 10, gpuCapGB: 12, gpuAllocGB: 12, gpuSpareGB: 12, slots: 12, vm: 24, power: 7, profile: 20, vmGB: 12,
    hostCores: 10, hostCpuPct: 12, hostMemGB: 15, hostMemPct: 14, vmVcpu: 9, vmCpuPct: 10, vmMemGB: 13, vmMemPct: 12, note: 36 };
  wf.columns = FLAT_COLUMNS.map(([k]) => ({ key: k, width: FW[k] || 14 }));
  styleHeadRow(wf.addRow(FLAT_COLUMNS.map(([, h]) => h)), { height: 24 });
  const NUMK = new Set(['gpuIdx', 'gpuCapGB', 'gpuAllocGB', 'gpuSpareGB', 'vmGB', 'hostCores', 'hostCpuPct', 'hostMemGB', 'hostMemPct', 'vmVcpu', 'vmCpuPct', 'vmMemGB', 'vmMemPct']);
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
    ['계층', `법인(vCenter) › 데이터센터 › 클러스터 › 호스트 › 물리 GPU › VM. 계층 표 시트는 행 그룹(개요)으로 묶여 있어 왼쪽 위 1~${maxDepth} 단추로 접고 펼칩니다. 넣을 단계(호스트까지 · GPU 까지 · VM 까지)는 계층 표와 법인 시트에 적용되고 평면 표는 늘 GPU·VM 한 줄씩입니다.`],
    ['전체', 'GPU 한 장의 명목 용량 × 장수(vGPU 프로파일 GB 가 명목 단위라 vCenter 보고값보다 크면 명목값). 패스스루 GPU 는 PCI 정보에 메모리가 없어 모델명으로 추정합니다.'],
    ['할당', '켜진 VM 이 받은 프레임버퍼 — vGPU 는 프로파일 이름 끝 숫자(GB) × 장치 수, 패스스루는 GPU 한 장 전체.'],
    ['예비', '전체 − 할당. 용량이나 할당을 모르는 것이 섞이면 비웁니다(부분 합을 예비로 적지 않습니다). 프로파일이 올라간 GPU 의 예비는 같은 프로파일 슬롯 단위로만 쓸 수 있습니다(혼합 크기 모드 제외).'],
    ['꺼진 VM', 'GPU 에 올라가 있지 않아 할당에서 빼고, 켜려면 필요한 GB 를 따로 적습니다.'],
    ['배치 안 된 VM', '켜져 있는데 GPU 별 목록에서 찾지 못한 VM 입니다. 할당은 호스트 합계에 들어갑니다. 수집기가 GPU 별 배치를 아직 보내지 않는 경우(구버전) 그 호스트 GPU 의 할당·예비는 비웁니다.'],
    ['빈 칸', '못 읽은 값입니다. 0 으로 채우지 않습니다.'],
    ['vSGA', '공유 그래픽이라 할당형이 아닙니다. 행으로만 보이고 합계에 넣지 않습니다.'],
    ['CPU · 메모리', '호스트 행은 그 호스트의 코어 · 메모리 · 사용률, VM 행은 그 VM 의 vCPU · 메모리 · 사용률입니다. 법인 · 데이터센터 · 클러스터 행은 호스트 코어 · 메모리 합이고 사용률은 사용률을 읽은 호스트의 MHz · MB 합으로 낸 값입니다(끊긴 호스트는 빼고 비고에 대수를 적습니다). ‘GPU VM vCPU · 메모리 합’ 은 켜진 GPU VM 만 더합니다. 꺼진 VM · 끊긴 호스트의 사용률과 모르는 값이 섞인 합은 빈 칸입니다(0 이 아님).'],
    ['평면 표', 'GPU·VM 한 줄마다 모든 계층 열을 채운 시트 — 자동 필터와 피벗 테이블용입니다.'],
    ['법인별 시트', '목차 시트에 범위 안 법인이 한 줄씩 있고, 법인 이름을 누르면 그 법인 시트로 갑니다(법인 시트 1행의 ‘← 목차’ 로 돌아옵니다). 법인 시트는 전체 계층 표에서 그 법인 줄부터 아래를 그대로 옮긴 것이라 값이 같습니다. GPU 호스트가 없는 법인은 시트를 만들지 않고 목차에만 적습니다. 시트 이름은 vCenter 이름을 엑셀 제한(31자 · 일부 기호 금지)에 맞춰 바꾼 것이고, 실제 이름은 목차와 시트 1행에 있습니다. 탭 색: 목차 회색 · 법인 파랑 · 할당률 90% 이상 법인 주황.'],
  ];
  for (const [k, v] of info.filter(([k0]) => k0 !== '법인별 시트' || sheets.includes('corp'))) {
    const r = wi.addRow([k, v]);
    r.getCell(1).fill = fill('FFEEF4FF'); r.getCell(1).font = { bold: true, color: { argb: C.title } };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.eachCell((c) => { c.border = BORDER; });
  }
  }

  /* ④ v2.869 목차 + 법인별 시트 — 고정 시트 뒤에, 법인 id 순(화면 법인 칩과 같은 순서). */
  if (sheets.includes('corp')) {
    const list = roster || tree.vcenters.map((vc) => ({ id: vc.id, name: vc.name, city: vc.city, country: vc.country, vc }));
    const sorted = [...list].sort((a, b) => a.id.localeCompare(b.id));
    const gpuCorps = sorted.filter((c) => c.vc);
    const names = corpSheetNames(gpuCorps.slice(0, CORP_SHEETS_MAX));
    addTocSheet(wb, sorted, names, meta, Math.max(0, gpuCorps.length - CORP_SHEETS_MAX));
    for (const c of gpuCorps) {
      const nm = names.get(c.id);
      if (!nm) continue;
      const loc = locationText(c);
      const pct = num(c.vc.totals.allocPct);
      await addTreeSheet(wb, nm.sheet, { totals: c.vc.totals, vcenters: [c.vc] }, meta, depth, {
        title: `GPU 할당 계층 — ${c.name}${loc ? `  (${loc})` : ''}`, sub: '이 법인만', back: ALLOC_XLSX_SHEETS[3],
        tab: pct != null && pct >= 90 ? TAB.hot : TAB.corp,
        truncatedNote: tree.truncated ? `※ 전체 GPU 호스트가 많아 ${tree.truncated}대를 넣지 않았습니다 — 이 법인의 호스트도 빠졌을 수 있습니다.` : '',
      });
      await yieldLoop();   // 법인 시트마다 한 번 양보(시트가 수십 장이어도 요청 경로를 오래 잡지 않게)
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
