/**
 * vcenter/vmExportXlsx.js — 'VM 전체 정보 내보내기' 엑셀(v2.799 시안 ④ https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC ·
 *   v2.801 시안 ①②③ https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h — 사용자 요청 "엑셀로 예쁘게, 가독성 좋게" ·
 *   "디렉터리를 계층별로 볼 수 있게 — 폴더별로 나눠서" · 선택 '폴더 트리 시트').
 *
 *  ① 요약(v2.801) — 고른 항목과 상관없이 대상 VM 의 인벤토리·구성 캐시로 센 숫자(vmExportSummary.js): KPI · 클러스터별 · Guest OS · 확인할 것.
 *  ② 폴더 트리(v2.801) — 화면 트리와 같은 계층('vCenter / vm' → 폴더 → VM). 행 그룹(개요)으로 접기·펼치기(1~7단계 단추 · 폴더 행 왼쪽 −/+),
 *     폴더 행은 굵은 이름 + 회색 'N VM' · 하위 VM 합계(vCPU·메모리·디스크 등 합할 수 있는 열) · 전원·여부 열은 셈. 열은 고른 항목(이름·vCenter·폴더 열 제외).
 *  ③ 데이터 — CSV 와 같은 표(buildVmExportTable 의 head·cells 그대로). 1행 = 묶음 띠(같은 묶음이 이어지는 열을 병합 · 묶음 색),
 *     2행 = 열 머리(자동 필터), 첫 두 행 + 'VM 이름' 열까지 고정. v2.801: 줄무늬 · 숫자 서식 · 전원·Tools·여부·사용률 색 · '수집 안 됨' 흐린 기울임(vmXlsxStyle.js).
 *  ④ 읽는 법 — 조건(vCenter · 대상 · 만든 시각 · 실시간 보강 결과 · 고른 항목) + 열마다 출처와 채워진 VM 수 + 빈칸·'수집 안 됨' 의 뜻.
 * ⚠ 판정·칸 값은 만들지 않는다(카탈로그가 만든 값을 배치만 한다 — 폴더 행 합계·셈은 그 값을 더할 뿐). 문자열 칸으로만 쓴다
 *   (수식 칸을 만들지 않는다 — '=' 로 시작하는 VM 이름도 실행되지 않는다). 폴더 합계에 못 읽은 VM 이 있으면 '≥합' 글자(부분 합을 확정 수로 쓰지 않는다).
 * ⚠ 이 파일은 워커(vmExportXlsxWorker.js)에서도 로드된다 — store·config·DB 같은 부수효과 있는 import 를 넣지 말 것.
 */
import ExcelJS from 'exceljs';
import { runXlsxWorker } from '../util/xlsxWorkerRun.js';
import { localStamp } from '../util/dayKey.js';
import { BORDER, PAL, fill, kindOf, cellLook, applyLook, styleDataRow, styleHeadRow, depthTint, folderLabel, barText, numFmtOf } from './vmXlsxStyle.js';
import { sumText, pctOf } from './vmExportSummary.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const VM_EXPORT_SHEETS = Object.freeze(['요약', '폴더 트리', '데이터', '읽는 법']);
const MISSING = '수집 안 됨';   // vmExportCatalog.MISSING 과 같은 값(테스트 대조) — 워커가 카탈로그를 끌어오지 않게 글자만 둔다
export const OUTLINE_MAX = 7;
/** 폴더 트리 시트에 싣는 열 상한 — 고른 항목 앞에서부터(전체는 '데이터' 시트). 계층을 읽는 시트라 넓으면 읽기 어렵고, 열이 많으면 파일 만드는 시간이
 *  두 배가 된다(6,000대 × 60열 실측: 트리도 60열이면 13.7초 — v2.801 프로파일, 비용은 대부분 exceljs 직렬화). */
export const TREE_COLS_MAX = 20;   // 엑셀 행 그룹 단계 상한 — 더 깊은 폴더는 7단계에 모인다(이름 들여쓰기는 계속 깊어진다)

/** 묶음 띠 색(시안 ④) — [배경, 글자]. */
export const GROUP_STYLE = Object.freeze({
  base: ['FFDBE5F1', 'FF1E3A5F'], guest: ['FFE0F2FE', 'FF075985'], ident: ['FFF1F5F9', 'FF334155'], cpu: ['FFEDE9FE', 'FF5B21B6'],
  net: ['FFDCFCE7', 'FF166534'], disk: ['FFFEF3C7', 'FF92400E'], part: ['FFFFEDD5', 'FF9A3412'], snap: ['FFE0E7FF', 'FF3730A3'],
  dev: ['FFFEE2E2', 'FF991B1B'], meta: ['FFFCE7F3', 'FF9D174D'], veeam: ['FFDCFCE7', 'FF14532D'],
});
export const SRC_TEXT = Object.freeze({
  snap: '인벤토리(30초)', cache: '구성 캐시(주기 수집)', both: '실시간 → 없으면 구성 캐시', live: '실시간(내보낼 때)',
  parts: '실시간 → 없으면 게스트 디스크 수집', tags: '태그 캐시(주기 수집)', veeam: 'Veeam 연동 · 스냅샷 이벤트(주기 수집)',
});
/** 폴더 행에 하위 VM 합계를 쓰는 열(합해서 뜻이 있는 수 — 사용률·예약·제한은 넣지 않는다). */
export const SUM_KEYS = Object.freeze(new Set([
  'cpuCount', 'memGB', 'nicCount', 'diskCount', 'diskProvisionedGB', 'thinDiskCount', 'rdmCount', 'storageUsedGB', 'storageUncommittedGB', 'storageProvisionedGB',
  'guestPartCount', 'guestCapacityGB', 'guestUsedGB', 'guestFreeGB', 'snapshotCount', 'snapshotSizeGB',
]));
/** 폴더 트리에 싣지 않는 열 — 첫 칸(폴더 / VM)이 대신한다. */
const TREE_SKIP = (key) => key === 'name' || key === 'vcenter' || key === 'vcenterId' || key === 'folder' || String(key).startsWith('folderLevel');
const codeCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const yieldLoop = () => new Promise((r) => setImmediate(r));
/** '스냅샷 흔적만(Veeam 대상 아님)' → '스냅샷 흔적만'(괄호 앞까지 — 정규식 없이). */
const shortVerdict = (t) => { const s = String(t); const k = s.indexOf('('); return k > 0 ? s.slice(0, k) : s; };
/** 숫자 칸 글자 길이(천 단위 쉼표 포함) — toLocaleString 은 칸마다 부르면 느리다(6,000대 × 60열 실측 5.6초 — v2.801 프로파일). */
const numLen = (v) => { const s = String(v); const d = String(Math.trunc(Math.abs(v))).length; return s.length + Math.floor((d - 1) / 3); };
const fmtN = (v) => Number(v).toLocaleString('en-US', { maximumFractionDigits: 1 });

/** 실시간 보강 결과 한 줄(읽는 법 시트·감사 로그가 같은 글자). */
export function liveResultText(live) {
  const s = live?.state;
  if (s === 'ok') return `성공 — ${live.rows}대 중 ${live.vms}대 응답`;
  if (s === 'off') return '끔 — 캐시 값만';
  if (s === 'unused') return '고른 항목에 실시간 항목 없음';
  if (s === 'blocked' || s === 'failed') return `쓰지 못함 — ${live.reason || '사유 모름'}`;
  return '';
}

/** 열 너비 — 머리 글자와 값 길이(상한 60). */
function widthsOf(head, cells) {
  const w = head.map((h) => Math.min(60, Math.max(8, String(h).length * 1.6 + 2)));
  for (const row of cells) {
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      const len = typeof v === 'number' ? numLen(v) : String(v ?? '').length;
      if (len * 1.1 + 2 > w[i]) w[i] = Math.min(60, len * 1.1 + 2);
    }
  }
  return w.map((x) => Math.round(x));
}

/* ── 폴더 트리(순수) ─────────────────────────────────────────── */
/**
 * 행 → 트리. rowFolder[i] = 'Prod/Web'(숨은 'vm' 을 뺀 경로) · 같은 단계에서 폴더 먼저(코드 단위 순서 — 화면 트리와 같다), 그다음 VM(행 순서 = 이름 순).
 * @returns {{ root:object, folders:number }}
 */
export function buildExportTree(rootName, rowFolder, n) {
  const mk = (name, depth) => ({ name, depth, folders: new Map(), rows: [], all: [] });
  const root = mk(rootName, 0);
  let folders = 0;
  for (let i = 0; i < n; i++) {
    const parts = String(rowFolder?.[i] || '').split('/').filter(Boolean);
    let node = root;
    root.all.push(i);
    for (const p of parts) {
      let next = node.folders.get(p);
      if (!next) { next = mk(p, node.depth + 1); node.folders.set(p, next); folders++; }
      node = next;
      node.all.push(i);
    }
    node.rows.push(i);
  }
  return { root, folders };
}
/** 트리를 위에서부터 — [{ kind:'folder', node } | { kind:'vm', i, depth }]. */
export function flattenExportTree(node, out = []) {
  out.push({ kind: 'folder', node });
  for (const k of [...node.folders.keys()].sort(codeCmp)) flattenExportTree(node.folders.get(k), out);
  for (const i of node.rows) out.push({ kind: 'vm', i, depth: node.depth + 1 });
  return out;
}

/**
 * 폴더 행의 칸 하나(순수) — 하위 VM 들의 그 열 값으로. 합(SUM_KEYS) · 전원 셈 · 여부 셈 · 백업 판단 셈, 그 밖은 ''.
 * 합은 못 읽은 VM 이 있으면 '≥합'(글자), 하나도 모르면 ''.
 */
export function folderCell(key, values, powers) {
  const kind = kindOf(key);
  if (SUM_KEYS.has(key)) {
    let sum = 0; let unknown = 0; let known = 0;
    for (const v of values) { if (typeof v === 'number' && Number.isFinite(v)) { sum += v; known++; } else unknown++; }
    if (!known) return '';
    const r = Math.round(sum * 10) / 10;
    return unknown ? `≥${fmtN(r)}` : r;
  }
  if (kind === 'power') {
    const on = powers.filter((p) => p === 'POWERED_ON').length; const off = powers.filter((p) => p === 'POWERED_OFF').length;
    const other = powers.length - on - off;
    return [on ? `켜짐 ${on}` : '', off ? `꺼짐 ${off}` : '', other ? `그 밖 ${other}` : ''].filter(Boolean).join(' · ');
  }
  if (kind === 'yn') {
    const yes = values.filter((v) => v === '예').length; const no = values.filter((v) => v === '아니오').length;
    const known = yes + no;
    if (!known) return '모름';
    const u = values.length - known;
    return `예 ${yes} / ${known}${u ? ` · 모름 ${u}` : ''}`;
  }
  if (kind === 'verdict') {
    const m = new Map();
    for (const v of values) if (v) m.set(v, (m.get(v) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => `${shortVerdict(t)} ${c}`).join(' · ');
  }
  return '';
}

/* ── ① 요약 ─────────────────────────────────────────────────── */
const CHECK_COLS = Object.freeze({ snapOld: 'snapshotAgeDays', tools: 'toolsStatus', cons: 'consolidation', cdrom: 'cdrom', veeam: 'vbkYn', question: 'question' });
function summarySheet(wb, p) {
  const ws = wb.addWorksheet(VM_EXPORT_SHEETS[0], {
    views: [{ showGridLines: false }],
    pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } },
  });
  ws.columns = [{ width: 30 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 22 }, { width: 28 }, { width: 30 }];
  const S = p.summary;
  const meta = p.meta || {};
  const t = ws.addRow([`${meta.vcenterName || meta.vcenterId || ''} — VM 전체 정보 요약`]);
  t.getCell(1).font = { bold: true, size: 16, color: { argb: PAL.title } };
  t.height = 24;
  const live = liveResultText(meta.live);
  ws.addRow([`기준 ${localStamp(meta.at, meta.offsetMin)} ${p.cond?.offsetLabel || ''} · 대상 ${p.cond?.target || ''} ${meta.rows ?? ''}대 · 고른 항목 ${p.cond?.items ?? (p.cols || []).length}개${live ? ` · 실시간 보강 ${live}` : ''} · 이 시트는 고른 항목과 상관없이 인벤토리로 셉니다`])
    .getCell(1).font = { color: { argb: PAL.muted } };
  ws.addRow([]);
  if (!S) { ws.addRow(['요약 숫자를 만들지 못했습니다 — ‘데이터’ 시트를 보세요.']).getCell(1).font = { color: { argb: PAL.muted } }; return ws; }
  const keys = new Set((p.cols || []).map((c) => c.key));
  // KPI 7칸(4~6행) — 칸 위 굵은 색 띠 · 값 · 보조 글자
  const v = S.veeam;
  const vRate = v ? pctOf(v.yes, v.yes + v.no) : null;
  const kpis = [
    ['VM', S.vms.toLocaleString('en-US'), `켜짐 ${S.on} · 꺼짐 ${S.off}${S.other ? ` · 그 밖 ${S.other}` : ''}`, 'FF1E3A5F'],
    ['vCPU 합', sumText(S.cpu, { total: S.vms }), S.cpu.unknown ? `모름 ${S.cpu.unknown}대 제외` : '', 'FF5B21B6'],
    ['메모리 합(GB)', sumText(S.memGB, { total: S.vms }), S.memGB.unknown < S.vms ? `${(S.memGB.sum / 1024).toFixed(1)} TB${S.memGB.unknown ? ` · 모름 ${S.memGB.unknown}대` : ''}` : '', 'FF5B21B6'],
    ['프로비저닝(GB)', sumText(S.provGB, { total: S.vms }), `사용 ${sumText(S.usedGB, { total: S.vms })} GB`, 'FF92400E'],
    ['스냅샷 있는 VM', String(S.snap.vms), `${S.snap.oldDays}일 넘은 것 ${S.snap.old}대${S.snap.unknown ? ` · 모름 ${S.snap.unknown}대` : ''}`, 'FF3730A3'],
    ['Tools 문제(켜진 VM)', String(S.tools.bad), S.tools.unknown ? `미수집 ${S.tools.unknown}대` : 'Tools 가 돌지 않는 켜진 VM', S.tools.bad ? 'FF9A3412' : 'FF166534'],
    [`최근 ${v?.days ?? meta.ynDays ?? 1}일 Veeam 백업`, vRate == null ? '—' : `${vRate}%`, v ? `없음 ${v.no}대 · 모름 ${v.unknown}대` : 'Veeam 판정을 읽지 못함', 'FF166534'],
  ];
  const r1 = ws.addRow(kpis.map((k) => k[0])); const r2 = ws.addRow(kpis.map((k) => k[1])); const r3 = ws.addRow(kpis.map((k) => k[2]));
  kpis.forEach((k, i) => {
    const thick = { style: 'thick', color: { argb: k[3] } }; const side = { style: 'thin', color: { argb: 'FFD4D8DE' } };
    r1.getCell(i + 1).font = { color: { argb: PAL.muted }, size: 10 }; r1.getCell(i + 1).border = { top: thick, left: side, right: side };
    r2.getCell(i + 1).font = { bold: true, size: 18, color: { argb: k[3] } }; r2.getCell(i + 1).border = { left: side, right: side }; r2.getCell(i + 1).alignment = { horizontal: 'left' };
    r3.getCell(i + 1).font = { color: { argb: 'FF64748B' }, size: 9 }; r3.getCell(i + 1).border = { left: side, right: side, bottom: side };
  });
  r2.height = 28;
  ws.addRow([]);
  // 클러스터별
  const sec = (title, note) => { const r = ws.addRow([title, note || '']); r.getCell(1).font = { bold: true, size: 12, color: { argb: PAL.title } }; r.getCell(2).font = { color: { argb: 'FF64748B' }, size: 9 }; };
  const head = (vals) => styleHeadRow(ws.addRow(vals), { height: 20 });
  sec('클러스터별', '막대 = 그 클러스터 VM 수 / 전체');
  head(['클러스터', 'VM', '켜짐', 'vCPU', '메모리(GB)', '프로비저닝(GB)', 'VM 비율']);
  S.clusters.forEach((c, i) => {
    const vals = [c.name || '(클러스터 없음)', c.vms, c.on, c.cpu.unknown ? sumText(c.cpu) : c.cpu.sum, c.memGB.unknown ? sumText(c.memGB, { digits: 1 }) : c.memGB.sum,
      c.provGB.unknown ? sumText(c.provGB, { digits: 1, total: c.vms }) : c.provGB.sum, `${barText(S.vms ? c.vms / S.vms : null, 20)} ${pctOf(c.vms, S.vms) ?? ''}%`];
    const r = ws.addRow(vals);
    styleDataRow(r, vals, null, i % 2 === 1);
    r.getCell(1).font = { bold: true }; r.getCell(7).font = { color: { argb: PAL.bar }, name: 'Consolas', size: 9 };
    for (let c2 = 1; c2 <= 7; c2++) r.getCell(c2).border = BORDER;
  });
  if (S.clusterRest) ws.addRow([`그 밖 클러스터 ${S.clusterRest.count}개`, S.clusterRest.vms]).getCell(1).font = { color: { argb: PAL.muted } };
  ws.addRow([]);
  // Guest OS
  sec(`Guest OS 상위 ${S.os.length}`, '인벤토리의 Guest OS(구성 값)');
  head(['Guest OS', 'VM', '비율']);
  S.os.forEach((o, i) => {
    const vals = [o.name || '(값 없음)', o.vms, `${barText(S.vms ? o.vms / S.vms : null, 20)} ${pctOf(o.vms, S.vms) ?? ''}%`];
    const r = ws.addRow(vals);
    styleDataRow(r, vals, null, i % 2 === 1);
    r.getCell(3).font = { color: { argb: PAL.head }, name: 'Consolas', size: 9 };
    for (let c2 = 1; c2 <= 3; c2++) r.getCell(c2).border = BORDER;
  });
  if (S.osRest) ws.addRow([`그 밖 ${S.osRest.count}종`, S.osRest.vms]).getCell(1).font = { color: { argb: PAL.muted } };
  ws.addRow([]);
  // 확인할 것
  sec('확인할 것', '‘데이터’ 시트에서 그 열로 필터하면 해당 VM 만 보입니다(열을 고르지 않았으면 항목에서 추가)');
  const ch = ws.addRow(['항목', 'VM 수', '기준', '', '', '', '데이터 시트 열']);
  styleHeadRow(ch, { height: 20 });
  ws.mergeCells(ch.number, 3, ch.number, 6);
  const colName = { snapOld: '가장 오래된 스냅샷 경과 일수', tools: 'Tools 상태', cons: '디스크 통합 필요', cdrom: 'CD-ROM 연결(ISO 경로)', veeam: `최근 ${v?.days ?? meta.ynDays ?? 1}일 Veeam 백업`, question: '응답 대기 질문' };
  const checks = [
    ['snapOld', `${S.snap.oldDays}일 넘은 스냅샷`, S.snap.old, `스냅샷 있는 VM ${S.snap.vms}대 중${S.snap.oldUnknown ? ` · 생성 시각 모름 ${S.snap.oldUnknown}대` : ''}`],
    ['tools', 'Tools 미실행(켜진 VM)', S.tools.bad, `켜진 VM(템플릿 제외)${S.tools.unknown ? ` · 미수집 ${S.tools.unknown}대 제외` : ''}`],
    ['cons', '디스크 통합 필요', S.consolidation, S.cache.cfg ? `구성 캐시 ${S.cache.cfg}대 기준` : '구성 캐시 없음'],
    ['cdrom', 'CD-ROM 연결', S.cdrom, S.cache.dev ? `장치 캐시 ${S.cache.dev}대 기준` : '장치 캐시 없음'],
    ['veeam', `최근 ${v?.days ?? meta.ynDays ?? 1}일 Veeam 백업 없음`, v ? v.no : null, v ? `모름 ${v.unknown}대는 넣지 않음` : 'Veeam 판정을 읽지 못함'],
    ['question', '응답 대기 질문', S.question, S.cache.cfg ? `구성 캐시 ${S.cache.cfg}대 기준` : '구성 캐시 없음'],
  ];
  for (const [id, label, n, base] of checks) {
    const vals = [label, n == null ? '—' : n, base, '', '', '', `${colName[id]}${keys.has(CHECK_COLS[id]) ? '' : ' (고르지 않음)'}`];
    const r = ws.addRow(vals);
    for (let c2 = 1; c2 <= 7; c2++) r.getCell(c2).border = BORDER;
    ws.mergeCells(r.number, 3, r.number, 6);
    r.getCell(1).font = { bold: true };
    const hot = typeof n === 'number' && n > 0;
    r.getCell(2).font = { bold: true, color: { argb: hot ? PAL.amberFg : n == null ? PAL.faint : PAL.green } };
    if (hot) { r.getCell(1).fill = fill(PAL.amberBg); r.getCell(2).fill = fill(PAL.amberBg); }
    r.getCell(2).alignment = { horizontal: 'right' };
    r.getCell(3).font = { color: { argb: PAL.muted } }; r.getCell(7).font = { color: { argb: PAL.muted } };
  }
  return ws;
}

/* ── ② 폴더 트리 ───────────────────────────────────────────────── */
async function treeSheet(wb, p) {
  const cols = p.cols || [];
  const idxAll = cols.map((c, i) => (TREE_SKIP(c.key) ? -1 : i)).filter((i) => i >= 0);
  const idx = idxAll.slice(0, TREE_COLS_MAX);
  const nameIdx = cols.findIndex((c) => c.key === 'name');
  const meta = p.meta || {};
  const wide = idx.length > 12;
  const ws = wb.addWorksheet(VM_EXPORT_SHEETS[1], {
    views: [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: true }],
    properties: { outlineLevelRow: 0 },
    pageSetup: wide ? { orientation: 'landscape', paperSize: 9, printTitlesRow: '3:3' }
      : { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '3:3' },
  });
  // 폴더(요약) 행이 하위 행 위에 오게 — 기본(아래)이면 −/+ 단추가 폴더 행이 아니라 그다음 행 위에 붙는다(vmListXlsx 와 같은 설정).
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  const n = (p.cells || []).length;
  const rootName = `${meta.vcenterName || meta.vcenterId || ''} / vm`;
  const { root } = buildExportTree(rootName, p.rowFolder, n);
  const flat = flattenExportTree(root);
  const head = ['폴더 / VM', ...idx.map((i) => p.head[i])];
  // 폴더 행 글자(셈·합)도 너비에 넣는다(상한 40 — 길면 칸 안에서 잘린다)
  const folderVals = flat.filter((e) => e.kind === 'folder').map((e) => idx.map((i) => folderCell(cols[i].key, e.node.all.map((r) => p.cells[r]?.[i]), e.node.all.map((r) => p.rowPower?.[r] || ''))));
  const w = widthsOf(idx.map((i) => p.head[i]), [...(p.cells || []).map((row) => idx.map((i) => row[i])), ...folderVals.map((r) => r.map((v) => (typeof v === 'string' ? v.slice(0, 36) : v)))]);
  let nameW = 30;
  for (const e of flat) nameW = Math.max(nameW, Math.min(70, (e.kind === 'folder' ? String(e.node.name).length + 12 : String(p.cells[e.i]?.[nameIdx] ?? '').length) + Math.min(15, (e.kind === 'folder' ? e.node.depth : e.depth) * 2) + 4));
  ws.columns = [{ width: nameW }, ...w.map((x) => ({ width: Math.max(10, x) }))];
  const t = ws.addRow([`${meta.vcenterName || meta.vcenterId || ''} — VM 전체 정보 · 폴더 트리`]);
  t.getCell(1).font = { bold: true, size: 13, color: { argb: PAL.title } };
  ws.addRow([`기준 ${localStamp(meta.at, meta.offsetMin)} ${p.cond?.offsetLabel || ''} · ${p.cond?.target || ''} ${meta.rows ?? n}대 · 왼쪽 위 1~${Math.min(OUTLINE_MAX, Math.max(2, ...flat.map((e) => (e.kind === 'vm' ? e.depth : e.node.depth) + 1)))} 단추로 단계별 접기 · 폴더 행 왼쪽 −/+ 로 그 폴더만 접기 · 폴더 행 숫자는 하위 VM 합계${idxAll.length > idx.length ? ` · 열이 많아 앞 ${idx.length}개만(전체 ${idxAll.length}개는 ‘데이터’ 시트)` : ''}`])
    .getCell(1).font = { color: { argb: PAL.muted } };
  styleHeadRow(ws.addRow(head), { height: 32 });
  const kinds = idx.map((i) => kindOf(cols[i].key));
  let maxLevel = 0; let k = 0; let z = 0; let fi = 0;
  for (const e of flat) {
    if (++k % 2000 === 0) await yieldLoop();
    if (e.kind === 'folder') {
      const f = e.node;
      const vals = folderVals[fi++];
      const r = ws.addRow([folderLabel(f.name, f.all.length), ...vals]);
      const tint = fill(depthTint(f.depth));
      for (let c = 1; c <= head.length; c++) {
        const cell = r.getCell(c);
        cell.fill = tint;
        if (c > 1) { cell.font = { bold: true, color: { argb: 'FF1F2937' } }; const v = vals[c - 2]; if (typeof v === 'number') cell.numFmt = numFmtOf(v); if (typeof v === 'string' && v.startsWith('≥')) cell.alignment = { horizontal: 'right' }; }
      }
      r.getCell(1).alignment = { horizontal: 'left', indent: Math.min(15, f.depth * 2) };
      r.outlineLevel = Math.min(OUTLINE_MAX, f.depth);
      maxLevel = Math.max(maxLevel, r.outlineLevel);
      z = 0;
      continue;
    }
    const row = p.cells[e.i] || [];
    const vals = idx.map((i) => (row[i] == null ? '' : row[i]));
    const r = ws.addRow([nameIdx >= 0 ? String(row[nameIdx] ?? '') : '', ...vals]);
    const zebra = (z++ % 2) === 1;
    r.getCell(1).alignment = { horizontal: 'left', indent: Math.min(15, e.depth * 2) };
    if (zebra) r.getCell(1).fill = fill(PAL.zebra);
    for (let j = 0; j < vals.length; j++) applyLook(r.getCell(j + 2), cellLook(vals[j], kinds[j], zebra));
    r.outlineLevel = Math.min(OUTLINE_MAX, e.depth);
    maxLevel = Math.max(maxLevel, r.outlineLevel);
  }
  ws.properties.outlineLevelRow = maxLevel;
  return ws;
}

/* ── ③ 데이터 ───────────────────────────────────────────────────── */
async function dataSheet(wb, p) {
  const cols = p.cols || [];
  const nameIdx = cols.findIndex((c) => c.key === 'name');
  const ws = wb.addWorksheet(VM_EXPORT_SHEETS[2], {
    views: [{ state: 'frozen', ySplit: 2, xSplit: nameIdx >= 0 ? nameIdx + 1 : 0 }],
    pageSetup: { orientation: 'landscape', paperSize: 9, printTitlesRow: '1:2' },
  });
  // 1행 — 묶음 띠(같은 묶음이 이어지는 열끼리 병합)
  const band = ws.addRow(cols.map((c) => p.cond?.groupNames?.[c.group] || c.group));
  for (let i = 0; i < cols.length;) {
    let j = i;
    while (j + 1 < cols.length && cols[j + 1].group === cols[i].group) j++;
    const [bg, fg] = GROUP_STYLE[cols[i].group] || ['FFF1F5F9', 'FF334155'];
    for (let k = i; k <= j; k++) {
      const cell = band.getCell(k + 1);
      cell.fill = fill(bg); cell.font = { bold: true, size: 9, color: { argb: fg } }; cell.border = BORDER;
    }
    if (j > i) ws.mergeCells(1, i + 1, 1, j + 1);
    i = j + 1;
  }
  // 2행 — 머리
  styleHeadRow(ws.addRow(p.head), { height: 30 });
  const kinds = cols.map((c) => kindOf(c.key));
  let n = 0;
  for (const row of p.cells) {
    if (++n % 2000 === 0) await yieldLoop();
    const vals = row.map((v) => (v == null ? '' : v));
    styleDataRow(ws.addRow(vals), vals, kinds, n % 2 === 0);
  }
  widthsOf(p.head, p.cells).forEach((x, i) => { ws.getColumn(i + 1).width = x; });
  if (cols.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } };
  return ws;
}

/* ── ④ 읽는 법 ─────────────────────────────────────────────────── */
function guideSheet(wb, p) {
  const cols = p.cols || [];
  const g = wb.addWorksheet(VM_EXPORT_SHEETS[3], { views: [{ showGridLines: false }] });
  g.getColumn(1).width = 34; g.getColumn(2).width = 34; g.getColumn(3).width = 16; g.getColumn(4).width = 14;
  const t = g.addRow(['읽는 법']); t.getCell(1).font = { bold: true, size: 14, color: { argb: PAL.title } };
  g.addRow([]);
  const kv = [
    ['vCenter', p.meta.vcenterName || p.meta.vcenterId || ''],
    ['대상', `${p.cond?.target || ''} ${p.meta.rows}대`.trim()],
    ['만든 시각', `${localStamp(p.meta.at, p.meta.offsetMin)} ${p.cond?.offsetLabel || ''}`.trim()],
    ['실시간 보강', liveResultText(p.meta.live)],
    ['고른 항목', `${p.cond?.items ?? cols.length}개 · ${cols.length}열${p.cond?.prefName ? ` · 저장값 ‘${p.cond.prefName}’` : ''}`],
  ];
  for (const [k, v] of kv) { const r = g.addRow([k, v]); r.getCell(1).font = { color: { argb: PAL.muted } }; }
  g.addRow([]);
  styleHeadRow(g.addRow(['열', '출처', '묶음', '채워짐']), { height: 20 });
  for (const c of cols) {
    const r = g.addRow([c.h, SRC_TEXT[c.src] || c.src, p.cond?.groupNames?.[c.group] || c.group, `${c.filled ?? 0} / ${p.meta.rows}`]);
    r.eachCell((cell) => { cell.border = BORDER; });
    r.getCell(4).alignment = { horizontal: 'right' };
  }
  g.addRow([]);
  for (const line of [
    '시트: 요약(고른 항목과 상관없이 인벤토리로 센 숫자) · 폴더 트리(화면 트리와 같은 계층 — 왼쪽 위 숫자 단추로 단계별 접기) · 데이터(CSV 와 같은 표) · 읽는 법.',
    '빈칸 = vCenter 가 값을 주지 않았거나 읽지 못한 값입니다(0 으로 쓰지 않습니다).',
    `‘${MISSING}’(흐린 기울임) = 그 출처가 이 VM 을 아직 모으지 않았습니다(실시간 보강 불가 · 구성 캐시 미도달 · 파티션 수집 꺼짐 · 태그 첫 수집 전 · Veeam 판정을 읽지 못함).`,
    '폴더 행 숫자는 하위 VM 의 합입니다. ‘≥’ 가 붙은 합은 값을 못 읽은 VM 을 빼고 더한 것입니다(실제는 그 이상).',
    '‘여부’ 칸: 예 · 아니오 · 모름 — Veeam 연동이 없거나 아직 못 읽은 VM 은 ‘아니오’ 가 아니라 ‘모름’ 입니다.',
    '색: 전원 켜짐 초록 · 꺼짐 회색 · 일시 중지 주황 / 사용률 80% 이상 노랑 · 90% 이상 빨강 / 값은 CSV 와 같고 색만 입혔습니다.',
    '시각은 포탈 시각입니다(머리에 시간대 표기). 이름 칸은 문자열로만 씁니다(‘=’ 로 시작해도 수식이 되지 않습니다).',
  ]) { const r = g.addRow([line]); r.getCell(1).font = { color: { argb: PAL.muted }, size: 10 }; }
  return g;
}

/**
 * 표 → 워크북 바이트(순수 — 메인·워커가 같은 함수).
 * @param {{ head:string[], cells:any[][], cols:Array<{key,item,h,group,src,filled}>, meta:object, rowFolder?:string[], rowPower?:string[], summary?:object,
 *           cond:{ target:string, items:number, groupNames:object, offsetLabel:string, prefName?:string } }} p
 */
export async function buildVmExportWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date(p.meta.at || Date.now());
  summarySheet(wb, p);
  await treeSheet(wb, p);
  await dataSheet(wb, p);
  guideSheet(wb, p);
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, meta: { rows: p.cells.length, cols: (p.cols || []).length } };
}

let _workerUrl = new URL('./vmExportXlsxWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는 가짜 워커로 인라인 경로를 확인한다. */
export function _setVmExportXlsxWorkerUrlForTest(url) { _workerUrl = url || new URL('./vmExportXlsxWorker.js', import.meta.url); }

/** 표 → .xlsx 바이트(워커 — 끄는 길 env VM_EXPORT_XLSX_WORKER=0 · 시한 VM_EXPORT_XLSX_TIMEOUT_MS 기본 5분). */
export function renderVmExportWorkbook(payload, { signal = null } = {}) {
  return runXlsxWorker({
    workerUrl: _workerUrl, payload, inline: buildVmExportWorkbook, signal, tag: 'vm-export',
    timeoutMs: process.env.VM_EXPORT_XLSX_TIMEOUT_MS ?? 300_000,   // 해석·상하한은 runXlsxWorker 의 deadlineMs(TIM2605-04 — Number(env)||기본값 금지)
    disabled: String(process.env.VM_EXPORT_XLSX_WORKER ?? '1').trim() === '0',
  });
}
