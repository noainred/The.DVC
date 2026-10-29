/**
 * veeam/vmListXlsx.js — vCenter › 'VM 및 폴더' 의 **VM 목록 엑셀**(폴더 트리, v2.792).
 *
 * 사용자 요청(2026-10-26): "클로드 디자인 사용 · 멋지게 · 폴더구조 잘 나오게 표현되게" · 선택: 엑셀 추가 + CSV 유지 · 시안 먼저 승인.
 *   시트 구성은 승인된 캔버스 시안(https://claude.ai/artifact/MENTpVFxe9D4Y4XgAazpBg)을 따른다:
 *   ① 요약 — 핵심 수 · 판단 분포 · 폴더별 백업 현황(하위 폴더 포함 합계 · 들여쓰기 = 깊이) · 먼저 볼 VM
 *   ② VM 목록(폴더 트리) — vSphere 'VM 및 템플릿' 처럼 폴더 행 아래 VM. 엑셀 개요(행 그룹)로 접고 편다(1/2/3 단추 · 폴더 행의 −/+).
 *      폴더 행에 VM 수 · 판단별 수 · Veeam 백업률 막대 · 잔존 수
 *   ③ 데이터(행 단위) — CSV 와 같은 열(vmListCsv.vmListColumns — 폴더 1~N단계 + 폴더 경로) · 자동 필터
 *   ④ 읽는 법 — 판단 범례와 기준
 *
 * ⚠ 판정은 새로 만들지 않는다 — 한 칸 판단은 backupStatus.backupVerdict(= viewClass), VM 단위 값은 라우트가 vmBackupView 로 만든 것.
 *   이 모듈은 칸 배치·색·합계(그 판단을 센 것)만 한다.
 * ⚠ 모르는 값은 빈칸 또는 '모름'(0 이 아니다). Veeam 백업률은 Veeam 상태를 아는 VM 만 분모로 하고, 연동 없는 vCenter·아는 VM 0대면 '—'.
 * ⚠ 이름은 문자열 칸으로만 쓴다(수식 칸을 만들지 않는다 — '=' 로 시작하는 VM 이름도 실행되지 않는다).
 * ⚠ 엑셀 개요는 최대 7단계다 — 그보다 깊은 폴더는 7단계에 모이고, 들여쓰기·'폴더 경로' 열은 깊이 그대로다.
 * ⚠ 큰 목록(상한 2만 대)에서도 이벤트 루프를 길게 잡지 않게 워커에서 만든다(vmListXlsxWorker.js — storage/usageXlsx.js 와 같은 규칙).
 */
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import '../util/xlsxSheetPrOrder.js';   // v2.799.1: 폴더 트리 시트(fitToPage + outlineProperties)의 <sheetPr> 순서 — Excel '복구' 대화상자(워커도 이 파일을 불러 같이 걸린다)
import { deadlineMs } from '../util/deadline.js';
import { localStamp, DAY_OFFSET_MIN } from '../util/dayKey.js';
import { backupVerdict, isSystemVm, METHOD_TEXT, cloneResultText } from './backupStatus.js';
import { vmListColumns, folderParts, folderLevels, offsetLabel, veeamStateText, folderNameCmp, vmTreeCmp } from './vmListCsv.js';
import { kindOf, styleDataRow, depthTint, folderLabel, PAL, METHOD_LOOK } from '../vcenter/vmXlsxStyle.js';   // v2.801 공용 서식(줄무늬 · 숫자 서식 · 전원·여부 색 · 폴더 단계 색)

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const VM_XLSX_SHEETS = Object.freeze(['요약', 'VM 목록(폴더 트리)', '데이터(행 단위)', '읽는 법']);
/** 엑셀 행 그룹(개요) 최대 단계. */
export const OUTLINE_MAX = 7;
/** 요약 시트 '먼저 볼 VM' 상한 — 나머지는 데이터 시트 필터로 본다(요약이 길어지지 않게). */
export const WATCH_MAX = 200;

const DAY = 86_400_000;
const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFD4D8DE' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const C = Object.freeze({
  head: 'FF1E3A5F', headFg: 'FFFFFFFF', title: 'FF0F172A', muted: 'FF475569', bar: 'FF22A05A', barBg: 'FFCBD5E1',
  depth: ['FFDBE5F1', 'FFEEF3F9', 'FFF6F9FC'],
});
/** 판단 묶음(요약·폴더 합계) — 스냅샷 흔적 세 가지는 한 묶음('스냅샷만')으로 센다. */
const GROUP_OF = Object.freeze({ veeam: 'veeam', snap: 'snap', 'snap-unlinked': 'snap', 'snap-vunknown': 'snap', none: 'none', unknown: 'unknown' });
export const VERDICT_STYLE = Object.freeze({
  veeam: { bg: 'FFDCFCE7', fg: 'FF166534' },
  snap: { bg: 'FFE0F2FE', fg: 'FF075985' },
  none: { bg: 'FFFEF3C7', fg: 'FF92400E' },
  unknown: { bg: 'FFF1F5F9', fg: 'FF475569' },
  stale: { bg: 'FFFEE2E2', fg: 'FF991B1B' },
});
const KPI_COLOR = Object.freeze({ vm: 'FF1E3A5F', veeam: 'FF22A05A', snap: 'FF3B9FD6', none: 'FFE0A019', unknown: 'FF94A3B8', stale: 'FFC2410C' });
const POWER_TEXT = Object.freeze({ POWERED_ON: '켜짐', POWERED_OFF: '꺼짐', SUSPENDED: '일시 중지' });
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const yieldLoop = () => new Promise((r) => setImmediate(r));

/** 막대 글자 — '███████░░░' (0~1). 모르면 ''. */
export function barText(rate, width = 10) {
  if (!fin(rate)) return '';
  const n = Math.max(0, Math.min(width, Math.round(rate * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

// v2.803 method = 백업 방식별 수(사람이 정한 값 — view.m.method · 없으면 unset)
const newAgg = () => ({ vm: 0, veeam: 0, snap: 0, none: 0, unknown: 0, stale: 0, run: 0, wait: 0, vKnown: 0, off: 0, method: { veeam: 0, clone: 0, config: 0, none: 0, check: 0, unset: 0 } });
function addAgg(a, it) {
  a.vm++; a[it.group]++;
  const mt = it.view.m?.method;
  a.method[Object.hasOwn(METHOD_TEXT, mt || '') ? mt : 'unset']++;
  if (it.stale) a.stale++;
  if (it.view.v !== undefined) a.vKnown++;
  if (it.view.v?.state === 'run') a.run++;
  else if (it.view.v?.state === 'wait') a.wait++;
  if (it.view.power === 'POWERED_OFF') a.off++;
}
/** Veeam 백업률 — Veeam 상태를 아는 VM 만 분모. 연동 없음·아는 VM 0대면 null('—'). */
export const veeamRate = (a, linked) => (linked && a.vKnown > 0 ? a.veeam / a.vKnown : null);

/**
 * 폴더 트리(순수) — 하위 폴더 포함 합계. 같은 단계에서는 폴더 먼저, 그다음 VM — 폴더는 화면 트리와 같은 코드 단위 순서('DMZ' < 'Dev'),
 * VM 은 이름 순(vmListCsv.vmTreeCmp — CSV 행 순서와 같다).
 * @param {Array<{view:object, inv:object}>} rows
 * @param {{linked:boolean}} o
 */
export function buildVmTree(rows, { linked = true } = {}) {
  const root = { name: '', depth: -1, path: '', folders: new Map(), vms: [], agg: newAgg() };
  let folders = 0;
  for (const r of rows || []) {
    const verdict = backupVerdict(r.view, { linked });
    const it = { ...r, verdict, group: GROUP_OF[verdict.code] || 'unknown', stale: !!r.view?.s?.now?.stale, parts: folderParts(r.view?.folder) };
    let node = root;
    addAgg(root.agg, it);
    for (const p of it.parts) {
      let next = node.folders.get(p);
      if (!next) { next = { name: p, depth: node.depth + 1, path: node.path ? `${node.path}/${p}` : p, folders: new Map(), vms: [], agg: newAgg() }; node.folders.set(p, next); folders++; }
      node = next;
      addAgg(node.agg, it);
    }
    node.vms.push(it);
  }
  return { root, folders };
}

/** 트리를 화면 순서로 펼친다 — [{kind:'folder', node} | {kind:'vm', it, depth}]. */
export function flattenTree(node, out = []) {
  for (const k of [...node.folders.keys()].sort(folderNameCmp)) {
    const f = node.folders.get(k);
    out.push({ kind: 'folder', node: f });
    flattenTree(f, out);
  }
  for (const it of [...node.vms].sort((a, b) => vmTreeCmp(a.view, b.view))) out.push({ kind: 'vm', it, depth: node.depth + 1 });
  return out;
}

/** 폴더 행의 요약 글자 — 'VM 9 · Veeam 7 · 스냅샷만 1 · 확인 안 됨 1'(0 인 판단은 뺀다 · VM 수는 늘). */
export function folderSummaryText(a) {
  const parts = [`VM ${a.vm}`];
  if (a.veeam) parts.push(`Veeam ${a.veeam}`);
  if (a.snap) parts.push(`스냅샷만 ${a.snap}`);
  if (a.none) parts.push(`확인 안 됨 ${a.none}`);
  if (a.unknown) parts.push(`모름 ${a.unknown}`);
  return parts.join(' · ');
}

/**
 * v2.807 백업 방식별 수(사람이 정한 값) — 서식 글자. 방식 이름·수는 그 방식 색 굵게, 미지정은 회색.
 *   full=true(요약 시트)면 0 인 방식도 쓴다(전체 한 줄) · false(폴더 행)면 0 은 생략. 표시 파일을 못 읽었으면 '모름'.
 */
export function methodCountsRich(a, unknown, { full = false, unknownText = '모름' } = {}) {
  if (unknown) return unknownText;
  const parts = Object.entries(METHOD_TEXT).filter(([k]) => full || a.method[k] > 0)
    .map(([k, t]) => ({ text: `${t} ${a.method[k].toLocaleString('en-US')}`, font: { bold: true, color: { argb: METHOD_LOOK[k].fg } } }));
  if (full || a.method.unset > 0) parts.push({ text: `미지정 ${a.method.unset.toLocaleString('en-US')}`, font: { color: { argb: C.muted } } });
  if (!parts.length) return '';
  return { richText: parts.flatMap((p, i) => (i ? [{ text: ' · ', font: { color: { argb: C.muted } } }, p] : [p])) };
}

/** 지금 있는 Veeam 임시 스냅샷 칸 — '1개 · 10-26 18:02' · 잔존이면 '1개 · 잔존 2일째'. */
function tempSnapText(now, offsetMin, at) {
  if (!now) return '';
  if (now.stale && fin(now.ts)) return `${now.n}개 · 잔존 ${Math.max(1, Math.floor((at - now.ts) / DAY))}일째`;
  return fin(now.ts) ? `${now.n}개 · ${localStamp(now.ts, offsetMin).slice(5)}` : `${now.n}개`;
}

/**
 * '먼저 볼 VM'(순수) — 잔존 스냅샷(전원 무관) · 켜진 VM 의 확인 안 됨 · 켜진 VM 의 모름. 템플릿·vCLS 는 백업 대상이 아니라 뺀다(세부내용 '제외' 와 같은 기준).
 * 순서: 확인 안 됨 → 잔존 스냅샷 → 모름(시안 순서), 같은 묶음 안에서는 트리 순서(vmTreeCmp).
 */
export function watchList(items, { snapDays = 7, at = Date.now(), marksUnknown = false } = {}) {
  const out = [];
  for (const it of items) {
    if (isSystemVm(it.inv) || isSystemVm({ name: it.view.name })) continue;
    const on = it.view.power === 'POWERED_ON';
    let tag = ''; let why = '';
    if (it.stale) {
      const ts = it.view.s.now.ts;
      tag = '잔존 스냅샷';
      why = `Veeam 임시 스냅샷이 ${Math.max(1, Math.floor((at - ts) / DAY))}일째 남아 있음 — 정리 실패 의심(델타 디스크 증가)`;
    } else if (on && it.verdict.code === 'none') {
      tag = '확인 안 됨';
      const n = fin(it.inv?.snapshotCount) ? it.inv.snapshotCount : 0;
      why = `켜짐 · Veeam 작업에 없음 · 최근 ${snapDays}일 Veeam 스냅샷 없음${n > 0 ? ` · 스냅샷 ${n}개는 Veeam 임시 스냅샷이 아님` : ''}`;
    } else if (on && it.verdict.code === 'unknown') {
      tag = '모름';
      why = it.view.v === undefined ? 'Veeam 상태를 읽지 못해 판단하지 못함' : `vCenter 이벤트(최근 ${snapDays}일)를 아직 판단하지 못함`;
    }
    // v2.804(사용자 결정 '백업 방식도 반영'): 사람이 정한 백업 방식 — '백업 안함' 과 Clone 마지막 복제 성공은 '확인 안 됨'·'모름' 에서 뺀다.
    //   그 밖의 방식은 남기고 이유 앞에 밝힌다. 잔존 스냅샷은 방식과 무관(정리 실패 의심). 표시 파일을 못 읽었으면 방식으로 빼지 않는다.
    if (tag && tag !== '잔존 스냅샷' && !marksUnknown) {
      const mt = it.view.m?.method; const c = it.view.c;
      if (mt === 'none') continue;
      if (mt === 'clone' && c?.job && c.ok === true && fin(c.at) && !c.skipped) continue;
      if (mt === 'clone') why = `백업 방식 Clone · ${cloneResultText(c) || '모름'} — ${why}`;
      else if (mt === 'config') why = `백업 방식 Config 백업(포탈이 확인할 수 없음) — ${why}`;
      else if (mt === 'check') why = `백업 방식 확인 필요로 표시함 — ${why}`;
      else if (mt === 'veeam') why = `백업 방식 Veeam 으로 정함 — ${why}`;
    }
    if (tag) out.push({ tag, why, it });
  }
  const rank = { '확인 안 됨': 0, '잔존 스냅샷': 1, 모름: 2 };
  out.sort((a, b) => rank[a.tag] - rank[b.tag] || vmTreeCmp(a.it.view, b.it.view));
  return out;
}

/** 인쇄 — 가로 · 폭 한 장(세로는 이어서). 큰 표를 인쇄해도 열이 여러 장으로 갈라지지 않게. */
const PRINT = Object.freeze({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } });
const styleOfGroup = (it) => VERDICT_STYLE[it.group] || VERDICT_STYLE.unknown;
function paint(cell, st, bold = true) {
  cell.fill = fill(st.bg);
  cell.font = { ...(cell.font || {}), bold, color: { argb: st.fg } };
}
function headRow(ws, values) {
  const r = ws.addRow(values);
  r.eachCell((c) => { c.fill = fill(C.head); c.font = { bold: true, color: { argb: C.headFg } }; c.border = BORDER; c.alignment = { vertical: 'middle', wrapText: true }; });
  r.height = 20;
  return r;
}

/* ── ① 요약 ─────────────────────────────────────────────────────── */
function summarySheet(wb, ctx) {
  const { tree, items, o } = ctx;
  const a = tree.root.agg;
  const ws = wb.addWorksheet(VM_XLSX_SHEETS[0], { views: [{ showGridLines: false }], pageSetup: PRINT });
  ws.columns = [{ width: 38 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 19 }, { width: 14 }, { width: 10 }, { width: 40 }];
  const t = ws.addRow([`${o.vcName} — VM 백업 요약`]);
  t.getCell(1).font = { bold: true, size: 15, color: { argb: C.title } };
  ws.addRow([`기준 ${o.stamp} ${o.tz} · 화면 조건: ${o.cond} · Veeam: ${o.veeamText} · Veeam 스냅샷 이벤트 최근 ${o.snapDays}일`]).getCell(1).font = { color: { argb: C.muted } };
  ws.addRow([]);

  const rate = veeamRate(a, o.linked);
  const onNone = items.filter((it) => it.group === 'none' && it.view.power === 'POWERED_ON').length;
  const kpis = [
    { label: 'VM', v: a.vm, sub: `폴더 ${tree.folders}개 · 꺼짐 ${a.off}`, c: KPI_COLOR.vm },
    { label: 'Veeam 백업', v: a.veeam, sub: o.linked ? `${rate == null ? '—' : `${Math.round(rate * 100)}%`} · 백업 중 ${a.run} · 대기 ${a.wait}` : 'Veeam 연동 없음', c: KPI_COLOR.veeam },
    { label: '스냅샷 흔적만', v: a.snap, sub: o.linked ? 'Veeam 대상 아님' : '스냅샷으로만 본 흔적', c: KPI_COLOR.snap },
    { label: '확인 안 됨', v: a.none, sub: `켜진 VM ${onNone}대`, c: KPI_COLOR.none },
    { label: '모름', v: a.unknown, sub: '판단 근거 부족', c: KPI_COLOR.unknown },
    { label: '임시 스냅샷 잔존', v: a.stale, sub: '하루 넘게 남음', c: KPI_COLOR.stale },
  ];
  const lr = ws.addRow(['핵심 수', ...kpis.map((k) => k.label)]);
  const vr = ws.addRow(['', ...kpis.map((k) => k.v)]);
  const sr = ws.addRow(['', ...kpis.map((k) => k.sub)]);
  lr.getCell(1).font = { bold: true, color: { argb: C.muted } };
  kpis.forEach((k, i) => {
    const col = i + 2;
    lr.getCell(col).border = { top: { style: 'thick', color: { argb: k.c } }, left: thin, right: thin };
    lr.getCell(col).font = { color: { argb: 'FF374151' } };
    vr.getCell(col).border = { left: thin, right: thin };
    vr.getCell(col).font = { bold: true, size: 18, color: { argb: C.title } };
    vr.getCell(col).numFmt = '#,##0"대"';
    vr.getCell(col).alignment = { horizontal: 'left' };
    sr.getCell(col).border = { left: thin, right: thin, bottom: thin };
    sr.getCell(col).font = { size: 9, color: { argb: C.muted } };
  });
  // v2.803 백업 방식(사람이 정한 값) 수 한 줄 — 표시 파일을 못 읽었으면 모름
  //   v2.807: 방식마다 색(트리 시트 '백업 방식' 칸과 같은 색)
  ws.addRow(['백업 방식', methodCountsRich(a, o.marksUnknown, { full: true, unknownText: '모름(백업 표시 파일을 읽지 못함)' })])
    .getCell(1).font = { bold: true, color: { argb: C.muted } };
  vr.height = 28;

  // 판단 분포 — 색 막대(글자 40칸) + 범례
  const dist = [
    { label: 'Veeam 백업', n: a.veeam, c: KPI_COLOR.veeam }, { label: '스냅샷 흔적만', n: a.snap, c: KPI_COLOR.snap },
    { label: '확인 안 됨', n: a.none, c: KPI_COLOR.none }, { label: '모름', n: a.unknown, c: KPI_COLOR.unknown },
  ];
  ws.addRow([]);
  const W = 48;
  const runs = [];
  if (a.vm > 0) {
    let used = 0;
    dist.forEach((d, i) => {
      const w = i === dist.length - 1 ? W - used : Math.round((d.n / a.vm) * W);
      const n = Math.max(0, Math.min(W - used, w));
      used += n;
      if (n) runs.push({ text: '█'.repeat(n), font: { color: { argb: d.c } } });
    });
  }
  const br = ws.addRow(['판단 분포']);
  br.getCell(1).font = { bold: true, color: { argb: C.muted } };
  ws.mergeCells(br.number, 2, br.number, 8);
  br.getCell(2).value = runs.length ? { richText: runs } : '—';
  const lg = ws.addRow(['']);
  ws.mergeCells(lg.number, 2, lg.number, 8);
  lg.getCell(2).value = { richText: dist.flatMap((d) => [{ text: '■ ', font: { color: { argb: d.c } } }, { text: `${d.label} ${d.n}    `, font: { color: { argb: 'FF374151' } } }]) };

  // 폴더별 백업 현황
  ws.addRow([]);
  ws.addRow(['폴더별 백업 현황']).getCell(1).font = { bold: true, size: 12, color: { argb: C.title } };
  ws.addRow(['하위 폴더 포함 합계 · 들여쓰기가 폴더 깊이 · Veeam 백업률 = Veeam 백업 ÷ Veeam 상태를 아는 VM']).getCell(1).font = { color: { argb: C.muted } };
  headRow(ws, ['폴더', 'VM', 'Veeam', '스냅샷만', '확인 안 됨', '모름', 'Veeam 백업률', '', '잔존']);
  for (const e of ctx.flat) {
    if (e.kind !== 'folder') continue;
    const f = e.node; const fa = f.agg; const fr = veeamRate(fa, o.linked);
    const r = ws.addRow([`📁 ${f.name}`, fa.vm, fa.veeam, fa.snap, fa.none, fa.unknown, fr, barText(fr), fa.stale || '']);
    r.getCell(1).alignment = { horizontal: 'left', indent: Math.min(15, f.depth * 2) };
    if (f.depth === 0) r.eachCell({ includeEmpty: true }, (c) => { c.fill = fill(C.depth[1]); c.font = { ...(c.font || {}), bold: true }; });
    r.getCell(3).font = { ...(r.getCell(3).font || {}), color: { argb: VERDICT_STYLE.veeam.fg } };
    r.getCell(4).font = { ...(r.getCell(4).font || {}), color: { argb: VERDICT_STYLE.snap.fg } };
    r.getCell(5).font = { ...(r.getCell(5).font || {}), color: { argb: VERDICT_STYLE.none.fg } };
    r.getCell(6).font = { ...(r.getCell(6).font || {}), color: { argb: VERDICT_STYLE.unknown.fg } };
    r.getCell(7).numFmt = '0%';
    if (fr == null) r.getCell(7).value = '—';
    r.getCell(8).font = { color: { argb: C.bar } };
    if (fa.stale) paint(r.getCell(9), VERDICT_STYLE.stale);
    for (let c = 1; c <= 9; c++) r.getCell(c).border = BORDER;
  }
  const rootVms = tree.root.vms.length;
  if (rootVms) {
    const r = ws.addRow([`(폴더 없음 — 최상위 VM ${rootVms}대)`]);
    r.getCell(1).font = { italic: true, color: { argb: C.muted } };
  }
  if (!tree.folders) ws.addRow(['VM 이 모두 최상위에 있어 폴더 합계가 없습니다.']).getCell(1).font = { color: { argb: C.muted } };

  // 먼저 볼 VM
  ws.addRow([]);
  ws.addRow(['먼저 볼 VM']).getCell(1).font = { bold: true, size: 12, color: { argb: C.title } };
  ws.addRow(['켜진 VM 중 확인 안 됨 · 모름 + 하루 넘게 남은 Veeam 임시 스냅샷(전원 무관) · 템플릿·vCLS 제외']).getCell(1).font = { color: { argb: C.muted } };
  const watch = ctx.watch;
  if (!watch.length) {
    ws.addRow(['해당하는 VM 이 없습니다.']).getCell(1).font = { color: { argb: C.muted } };
  } else {
    const h = headRow(ws, ['VM', '구분', '', '폴더 경로', '', '', '이유']);
    ws.mergeCells(h.number, 2, h.number, 3); ws.mergeCells(h.number, 4, h.number, 6);
    for (const w of watch.slice(0, WATCH_MAX)) {
      const r = ws.addRow([w.it.view.name, w.tag, '', w.it.parts.join('/') || '(최상위)', '', '', w.why]);
      ws.mergeCells(r.number, 2, r.number, 3); ws.mergeCells(r.number, 4, r.number, 6);
      r.getCell(1).font = { bold: true };
      paint(r.getCell(2), w.tag === '잔존 스냅샷' ? VERDICT_STYLE.stale : w.tag === '확인 안 됨' ? VERDICT_STYLE.none : VERDICT_STYLE.unknown);
      r.getCell(2).alignment = { horizontal: 'center' };
      r.getCell(4).font = { color: { argb: C.muted } };
    }
    if (watch.length > WATCH_MAX) ws.addRow([`외 ${watch.length - WATCH_MAX}대 — '데이터(행 단위)' 시트에서 '백업 판단' 필터로 볼 수 있습니다.`]).getCell(1).font = { color: { argb: C.muted } };
  }
  ws.addRow([]);
  const note = ws.addRow(['※ ‘확인 안 됨’ 은 Veeam·스냅샷 둘 다 확인했는데 흔적이 없다는 뜻이고, 백업이 없다는 단정이 아닙니다(폴더·태그 단위 Veeam 작업은 복원 지점이 생기기 전까지 VM 단위로 보이지 않습니다).']);
  note.getCell(1).font = { color: { argb: C.muted } };
  return ws;
}

/* ── ② VM 목록(폴더 트리) ───────────────────────────────────────────── */
async function treeSheet(wb, ctx) {
  const { o } = ctx;
  const ws = wb.addWorksheet(VM_XLSX_SHEETS[1], {
    views: [{ state: 'frozen', ySplit: 3, xSplit: 1, showGridLines: true }],
    properties: { outlineLevelRow: 0 },
    pageSetup: { ...PRINT, printTitlesRow: '3:3' },
  });
  // 폴더(요약) 행이 하위 행 **위** 에 오게 — 기본(아래)이면 −/+ 단추가 폴더 행이 아니라 그다음 폴더 위에 붙는다.
  ws.properties.outlineProperties = { summaryBelow: false, summaryRight: false };
  const heads = [
    // v2.803: '백업 방식'(사람이 정한 값) · 'Clone'(백업 방식 Clone 인 VM 의 포탈 복제 잡 마지막 실행) — 열이 둘 늘어 폴더 행 병합·색칠 위치도 옮겼다
    { h: '폴더 / VM', w: 46 }, { h: '전원', w: 9 }, { h: '백업 판단', w: 40 }, { h: '백업 방식', w: 16 }, { h: 'Veeam', w: 12 }, { h: 'Clone', w: 26 }, { h: `마지막 백업 완료 ${o.tz}`, w: 24 },
    { h: '복원 지점', w: 10 }, { h: 'Veeam 임시 스냅샷(지금)', w: 22 }, { h: `최근 ${o.snapDays}일 Veeam 스냅샷`, w: 18 }, { h: '스냅샷 수(전체)', w: 16 },
    { h: '호스트', w: 28 }, { h: 'IP', w: 16 },
  ];
  ws.columns = heads.map((x) => ({ width: x.w }));
  const t = ws.addRow([`${o.vcName} — VM 목록(폴더 트리)`]);
  t.getCell(1).font = { bold: true, size: 13, color: { argb: C.title } };
  ws.addRow([`기준 ${o.stamp} ${o.tz} · 화면 조건: ${o.cond} · 왼쪽 위 1/2/3 단추로 단계별 접기 · 폴더 행 왼쪽 −/+ 로 그 폴더만 접기`]).getCell(1).font = { color: { argb: C.muted } };
  headRow(ws, heads.map((x) => x.h)).height = 32;   // 시각 열 머리(오프셋 포함)가 잘리지 않게 두 줄
  // v2.801(시안 ④): 맨 위 'vCenter / vm' 행(화면 트리의 뿌리와 같은 표기 — 전체를 한 번에 접는다) · 폴더 이름 굵게 + 회색 'N VM' · 단계마다 옅어지는 바탕 ·
  //   VM 행 줄무늬. 단계(개요)는 뿌리가 0 이라 폴더 깊이 + 1(7 상한).
  const folderRow = (label, depth, fa) => {
    const fr = veeamRate(fa, o.linked);
    // v2.807(사용자 요청 '백업 방식별 합계를 백업 판단처럼 위에'): 2~3 = 백업 판단 합계 · 4~6 = 백업 방식 합계(하위 폴더 포함 · 방식 색) — 예전 6열 'Clone N' 은 이 합계에 들었다
    const r = ws.addRow([label, folderSummaryText(fa), '', methodCountsRich(fa, o.marksUnknown), '', '',
      o.linked ? `Veeam ${fr == null ? '—' : `${Math.round(fr * 100)}%`} ${barText(fr)}` : 'Veeam 연동 없음', '', fa.stale ? `잔존 ${fa.stale}` : '']);
    ws.mergeCells(r.number, 2, r.number, 3); ws.mergeCells(r.number, 4, r.number, 6); ws.mergeCells(r.number, 7, r.number, 8);
    const tint = depthTint(depth);
    for (let c = 2; c <= heads.length; c++) { const cell = r.getCell(c); cell.fill = fill(tint); if (c !== 4) cell.font = { color: { argb: 'FF1F2937' } }; }
    r.getCell(1).fill = fill(tint);
    r.getCell(1).alignment = { horizontal: 'left', indent: Math.min(15, depth * 2) };
    r.getCell(7).font = { bold: true, color: { argb: o.linked ? 'FF166534' : C.muted } };
    if (fa.stale) paint(r.getCell(9), VERDICT_STYLE.stale);
    r.outlineLevel = Math.min(OUTLINE_MAX, depth);
    return r;
  };
  folderRow(folderLabel(`${o.vcName} / vm`, ctx.tree.root.agg.vm), 0, ctx.tree.root.agg);
  let maxLevel = 0; let n = 0; let z = 0;
  for (const e of ctx.flat) {
    if (++n % 2000 === 0) await yieldLoop();
    if (e.kind === 'folder') {
      const f = e.node;
      const r = folderRow(folderLabel(f.name, f.agg.vm), f.depth + 1, f.agg);
      maxLevel = Math.max(maxLevel, r.outlineLevel);
      z = 0;
      continue;
    }
    const it = e.it; const v = it.view.v;
    const ev = it.view.s?.ev;
    const r = ws.addRow([
      it.view.name,
      POWER_TEXT[it.view.power] || it.view.power || '',
      it.verdict.text,
      o.marksUnknown ? '모름' : METHOD_TEXT[it.view.m?.method] || '',
      veeamStateText(v, o.linked),
      cloneCellText(it.view, o),
      v && fin(v.lb) && v.lb > 0 ? localStamp(v.lb, o.offsetMin) : '',
      v && fin(v.rp) && v.rp >= 0 ? v.rp : '',
      tempSnapText(it.view.s?.now, o.offsetMin, o.at),
      ev === undefined ? '모름' : ev ? (fin(ev.n) ? ev.n : '있음') : 0,
      fin(it.inv?.snapshotCount) ? it.inv.snapshotCount : '',
      it.inv?.host || '',
      it.inv?.ipAddress || '',
    ]);
    r.getCell(1).alignment = { horizontal: 'left', indent: Math.min(15, (e.depth + 1) * 2) };
    if ((z++ % 2) === 1) for (let c = 1; c <= heads.length; c++) r.getCell(c).fill = fill(PAL.zebra);
    r.getCell(2).font = it.view.power === 'POWERED_OFF' ? { color: { argb: C.muted } } : it.view.power === 'POWERED_ON' ? { bold: true, color: { argb: PAL.green } } : {};
    paint(r.getCell(3), styleOfGroup(it));
    if (!o.marksUnknown && METHOD_LOOK[it.view.m?.method]) paint(r.getCell(4), METHOD_LOOK[it.view.m.method]);   // v2.807 방식 색
    if (it.view.c) r.getCell(6).font = { bold: true, color: { argb: it.view.c.job && it.view.c.at != null && it.view.c.ok === false ? 'FFB91C1C' : 'FF0E7490' } };
    if (it.stale) paint(r.getCell(9), VERDICT_STYLE.stale);
    if (ev === undefined) r.getCell(10).font = { color: { argb: C.muted } };
    r.outlineLevel = Math.min(OUTLINE_MAX, e.depth + 1);
    maxLevel = Math.max(maxLevel, r.outlineLevel);
  }
  ws.properties.outlineLevelRow = maxLevel;
  return ws;
}

/* ── ③ 데이터(행 단위) — CSV 와 같은 열 ─────────────────────────────── */
async function dataSheet(wb, ctx) {
  const { o, items } = ctx;
  if (o.dataTable) return selectedDataSheet(wb, o.dataTable);
  const cols = vmListColumns({ snapDays: o.snapDays, offsetMin: o.offsetMin, levels: folderLevels(items) });
  // 인쇄는 가로·머리 반복만 — 열이 많아(폴더 단계 + 30여 열) 폭 한 장 맞춤이면 글자가 읽을 수 없게 작아진다. 이 시트는 필터·피벗용이다.
  const ws = wb.addWorksheet(VM_XLSX_SHEETS[2], { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { orientation: 'landscape', paperSize: 9, printTitlesRow: '1:1' } });
  ws.columns = cols.map((c) => ({ width: c.folderLevel ? 16 : c.h === 'VM' || c.h === '폴더 경로' ? 30 : c.h === '스냅샷 이름' || c.h === 'Veeam 작업' ? 40 : c.h.length > 12 ? 22 : 13 }));
  const h = ws.addRow(cols.map((c) => c.h));
  h.eachCell((c, i) => { c.fill = fill(cols[i - 1].folderLevel ? 'FF24507F' : C.head); c.font = { bold: true, color: { argb: C.headFg } }; c.border = BORDER; c.alignment = { vertical: 'middle', wrapText: true }; });
  h.height = 32;
  const iVerdict = cols.findIndex((c) => c.h === '백업 판단') + 1;
  const iStale = cols.findIndex((c) => c.h === 'Veeam 임시 스냅샷 잔존(하루+)') + 1;
  // v2.801: 줄무늬 · 숫자 서식 · 전원 색(공용 vmXlsxStyle) — v2.792 열에는 key 가 없어 머리 글자로 종류를 고른다(전원 · VM 이름만).
  const kinds = cols.map((c) => (c.h === '전원' ? 'power' : c.h === 'VM' ? 'name' : ''));
  let n = 0;
  for (const it of items) {
    if (++n % 2000 === 0) await yieldLoop();
    const vals = cols.map((c) => c.get({ ...it, vc: o.vcName, linked: o.linked }));
    const r = ws.addRow(vals);
    styleDataRow(r, vals, kinds, n % 2 === 0);
    paint(r.getCell(iVerdict), styleOfGroup(it), false);
    if (it.stale) paint(r.getCell(iStale), VERDICT_STYLE.stale);
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
  return ws;
}

/**
 * v2.798 '필요한 항목만 고르기' — 데이터 시트는 라우트가 카탈로그(vmListCatalog)로 미리 만든 표 그대로(CSV 와 같은 머리·칸).
 * 요약·폴더 트리 시트는 고른 항목과 무관하게 그대로다(Veeam 판정 기준 시트).
 * @param {{head:string[], cells:Array<Array>, folderCols?:boolean[]}} t
 */
async function selectedDataSheet(wb, t) {
  const head = Array.isArray(t.head) ? t.head : [];
  const ws = wb.addWorksheet(VM_XLSX_SHEETS[2], { views: [{ state: 'frozen', ySplit: 1 }], pageSetup: { orientation: 'landscape', paperSize: 9, printTitlesRow: '1:1' } });
  ws.columns = head.map((h, i) => ({ width: t.folderCols?.[i] ? 16 : /^VM$|폴더 경로|파티션 상세|태그|속성|메모|이름/.test(h) ? 34 : h.length > 12 ? 22 : 13 }));
  const hr = ws.addRow(head);
  hr.eachCell((c, i) => { c.fill = fill(t.folderCols?.[i - 1] ? 'FF24507F' : C.head); c.font = { bold: true, color: { argb: C.headFg } }; c.border = BORDER; c.alignment = { vertical: 'middle', wrapText: true }; });
  hr.height = 32;
  // v2.801: 줄무늬 · 숫자 서식 · 전원·여부·백업 판단·사용률 색(공용 vmXlsxStyle — 열 key 로 종류)
  const kinds = Array.isArray(t.keys) ? t.keys.map((k) => kindOf(k)) : null;
  let n = 0;
  for (const row of t.cells || []) {
    if (++n % 2000 === 0) await yieldLoop();
    const vals = Array.isArray(row) ? row : [];
    styleDataRow(ws.addRow(vals), vals, kinds, n % 2 === 0);
  }
  if (head.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: head.length } };
  return ws;
}

/* ── ④ 읽는 법 ─────────────────────────────────────────────────── */
function legendSheet(wb, ctx) {
  const { o } = ctx;
  const ws = wb.addWorksheet(VM_XLSX_SHEETS[3], { views: [{ showGridLines: false }], pageSetup: PRINT });
  ws.columns = [{ width: 32 }, { width: 120 }];
  ws.addRow(['읽는 법']).getCell(1).font = { bold: true, size: 14, color: { argb: C.title } };
  ws.addRow([]);
  headRow(ws, ['백업 판단', '뜻']);
  const row = (k, text, st) => {
    const r = ws.addRow([k, text]);
    if (st) paint(r.getCell(1), st);
    r.getCell(1).alignment = { horizontal: 'center', vertical: 'top', wrapText: true };
    r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    r.eachCell((c) => { c.border = BORDER; });
  };
  row('Veeam 백업', 'Veeam 작업에 들었거나 복원 지점이 있는 VM(포탈 Veeam 배지 · 백업 세부내용과 같은 기준). Veeam 칸: 백업 대상 · 백업 중 · 대기.', VERDICT_STYLE.veeam);
  row('스냅샷 흔적만(Veeam 대상 아님)', `Veeam 대상은 아닌데 최근 ${o.snapDays}일 Veeam 스냅샷 이벤트나 지금 Veeam 임시 스냅샷이 있다 — 백업 시작 흔적이며 성공 여부는 모른다. Veeam 서버가 연결돼 있지 않으면 '스냅샷 흔적(Veeam 연동 없음)', Veeam 쪽을 못 읽었으면 '스냅샷 흔적(Veeam 모름)'.`, VERDICT_STYLE.snap);
  row('확인 안 됨', 'Veeam·스냅샷 둘 다 확인했는데 흔적이 없다. 백업이 없다는 단정이 아니다(폴더·태그 단위 Veeam 작업은 복원 지점이 생기기 전까지 VM 단위로 보이지 않는다).', VERDICT_STYLE.none);
  row('모름', 'Veeam 서버를 읽지 못했거나 vCenter 이벤트 수집이 늦어 판단하지 못했다 — 0·없음이 아니다.', VERDICT_STYLE.unknown);
  row('잔존', '하루 넘게 남은 Veeam 임시 스냅샷(VEEAM BACKUP TEMPORARY SNAPSHOT) — 백업 흔적으로 세지 않고 따로 표시한다(정리 실패 의심).', VERDICT_STYLE.stale);
  ws.addRow([]);
  const notes = [
    `시각은 포탈 시각 ${o.tz} 입니다.`,
    "'VM 목록(폴더 트리)' 시트: 폴더 행의 수는 하위 폴더를 포함한 합계입니다. 왼쪽 위 1/2/3… 단추로 단계별로 접고, 폴더 행 왼쪽 −/+ 로 그 폴더만 접습니다. 엑셀 개요는 7단계까지라 더 깊은 폴더는 7단계에 모입니다(들여쓰기와 '폴더 경로' 는 깊이 그대로).",
    'Veeam 백업률 = Veeam 백업 VM ÷ Veeam 상태를 아는 VM 입니다. Veeam 서버가 연결돼 있지 않거나 아는 VM 이 없으면 — 로 둡니다(0% 가 아닙니다).',
    `스냅샷은 셋으로 나눠 싣습니다: ① 지금 있는 Veeam 임시 스냅샷 ② 최근 ${o.snapDays}일 Veeam 계정이 만든 스냅샷 이벤트(횟수 · '모름' 은 이벤트를 아직 판단하지 못한 것) ③ VM 의 전체 스냅샷(사람이 만든 것 포함 — 수 · 크기 · 이름).`,
    o.dataTable ? "'데이터(행 단위)' 시트는 내보내기 창에서 고른 항목과 순서 그대로입니다(CSV 와 같은 열). ‘수집 안 됨’ 은 그 vCenter 에서 아직 모으지 않은 값(태그 수집 전 · 게스트 파티션 미수집 · 구성 캐시 미도달)이고, 빈칸은 못 읽은 값입니다."
      : "'데이터(행 단위)' 시트는 CSV 와 같은 열입니다(폴더 1~N단계 · 폴더 경로 포함). 색·접기는 엑셀에만 있습니다. 폴더 경로가 비어 있으면 데이터센터 바로 아래(최상위) VM 입니다.",
    '대상 VM 은 내려받을 때 포탈 화면에 보이던 목록입니다(보기·검색 반영) 또는 고른 폴더입니다. 판단은 Backup 현황 › Detail 과 같은 기준입니다.',
    "'먼저 볼 VM' 은 백업 방식을 '백업 안함' 으로 정한 VM 과 Clone 마지막 복제가 성공한 VM 을 빼고, 그 밖의 방식은 이유 앞에 밝힙니다.",
    "'백업 방식' 은 Backup 현황 › Detail 에서 사람이 정한 값입니다(Veeam · Clone · Config 백업 · 백업 안함 · 확인 필요 — 정하지 않은 VM 은 빈칸 · 수집값으로 추정하지 않습니다). 'Clone' 칸은 백업 방식이 Clone 인 VM 에만, 포탈 VM 백업(복제) 잡의 마지막 실행 시각과 결과를 씁니다 — '잡 없음' 은 그 VM 의 복제 잡이 없다는 뜻, '모름' 은 실행하는 노드(엣지)의 보고를 아직 받지 못한 것입니다.",
    "폴더 행의 '백업 방식' 칸은 그 폴더(하위 폴더 포함)의 방식별 VM 수입니다(0 인 방식은 생략 · 맨 위 vCenter 행이 전체 합계). 색: Veeam 녹색 · Clone 청록 · Config 백업 보라 · 백업 안함 회색 · 확인 필요 주황 · 미지정은 색 없음.",
    'VM · 폴더 이름은 문자열 칸으로만 씁니다(수식 칸을 만들지 않습니다).',
    `만든 시각 ${o.stamp} ${o.tz} · 포탈 › Backup 현황 › Detail 에서 같은 목록을 볼 수 있습니다.`,
  ];
  for (const t of notes) ws.addRow(['', `※ ${t}`]).getCell(2).alignment = { wrapText: true, vertical: 'top' };
  return ws;
}

/**
 * 워크북 → Buffer(순수 입력 — 워커·인라인 공용).
 * @param {{ vcName:string, rows:Array<{inv:object, view:object}>, linked:boolean, snapDays?:number, offsetMin?:number, cond?:string, veeamText?:string, at?:number }} a
 * @returns {Promise<{buffer:Buffer, rows:number, folders:number, outlineLevels:number}>}
 */
export async function buildVmListWorkbook({ vcName, rows, linked, snapDays = 7, offsetMin = DAY_OFFSET_MIN, cond = '전체 VM', veeamText = '', at = Date.now(), dataTable = null, marksUnknown = false }) {
  const o = { marksUnknown: !!marksUnknown, vcName: String(vcName || ''), linked: !!linked, snapDays, offsetMin, cond, at, tz: offsetLabel(offsetMin), stamp: localStamp(at, offsetMin), dataTable,
    veeamText: veeamText || (linked ? '연결됨' : '연동 없음 — 스냅샷으로만 판단') };
  const tree = buildVmTree(rows, { linked: o.linked });
  const flat = flattenTree(tree.root);
  const items = flat.filter((e) => e.kind === 'vm').map((e) => e.it);
  const ctx = { o, tree, flat, items, watch: watchList(items, { snapDays, at, marksUnknown: o.marksUnknown }) };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date(at);
  summarySheet(wb, ctx);
  await yieldLoop();
  const ts = await treeSheet(wb, ctx);
  await yieldLoop();
  await dataSheet(wb, ctx);
  legendSheet(wb, ctx);
  await yieldLoop();
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, rows: items.length, folders: tree.folders, outlineLevels: ts.properties.outlineLevelRow || 0 };
}

/** 워커로 보낼 행 — 열이 쓰는 인벤토리 필드만(메모·디스크·NIC 같은 큰 필드를 복제하지 않는다). */
const INV_FIELDS = Object.freeze(['name', 'template', 'cluster', 'host', 'guestOS', 'cpuCount', 'memMB', 'storageGB', 'ipAddress', 'snapshotCount', 'snapshotSizeGB', 'snapshotNewestTs', 'snapshotNames']);
export function slimVmRows(rows) {
  return (rows || []).map((r) => {
    const inv = {};
    for (const k of INV_FIELDS) if (r.inv?.[k] !== undefined) inv[k] = k === 'snapshotNames' && Array.isArray(r.inv[k]) ? r.inv[k].slice(0, 20) : r.inv[k];
    return { inv, view: r.view };
  });
}

/** v2.803 트리 시트 'Clone' 칸 — 백업 방식이 Clone 인 VM(view.c 가 있다)만: '2026-10-27 02:00 성공' · '잡 없음' · '모름'. */
function cloneCellText(view, o) {
  if (!view || !('c' in view)) return '';
  const c = view.c;
  return [c && fin(c.at) ? localStamp(c.at, o.offsetMin) : '', cloneResultText(c)].filter(Boolean).join(' ');
}

/* ── 워커 실행(메인 스레드가 멈추지 않게) ─────────────────────────────
 * storage/usageXlsx.js renderUsageWorkbook · ipam/excel.js 와 같은 규칙: 매번 새 워커 → 'ready' 전에 죽으면(모듈 적재 실패) 인라인으로 만든다(콘솔에 남긴다) ·
 * 'ready' 뒤의 실패는 인라인으로 다시 하지 않는다 · 시한이 지나면 끝낸다 · 요청이 끊기면 멈춘다 · 끝나면 terminate.
 * 끄는 길: env `VM_LIST_XLSX_WORKER=0`(인라인). 시한: `VM_LIST_XLSX_TIMEOUT_MS`(기본 3분 — 웹 내려받기 시한과 같다).
 */
const READY_TIMEOUT_MS = 60_000;
let _workerUrl = new URL('./vmListXlsxWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는 가짜 워커로 인라인 경로를 확인한다. */
export function _setVmListXlsxWorkerUrlForTest(url) { _workerUrl = url || new URL('./vmListXlsxWorker.js', import.meta.url); }
const codedError = (code, message) => Object.assign(new Error(message), { code });

/**
 * @param {object} input buildVmListWorkbook 입력(rows 는 slimVmRows 로 줄인다)
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{buffer:Buffer, meta:object, mode:'worker'|'inline', reason?:string}>}
 */
export async function renderVmListWorkbook(input, opts = {}) {
  const payload = { ...input, rows: slimVmRows(input.rows) };
  const signal = opts.signal || null;
  const inline = async (reason) => {
    const out = await buildVmListWorkbook(payload);
    return { buffer: out.buffer, meta: { rows: out.rows, folders: out.folders, outlineLevels: out.outlineLevels }, mode: 'inline', reason };
  };
  if (signal?.aborted) throw codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
  if (String(process.env.VM_LIST_XLSX_WORKER ?? '1').trim() === '0') return inline('disabled');
  const timeoutMs = deadlineMs(opts.timeoutMs ?? process.env.VM_LIST_XLSX_TIMEOUT_MS ?? 180_000, 180_000);
  let worker;
  try { worker = new Worker(_workerUrl); } catch (err) {
    console.warn(`[vm-list] 엑셀 워커를 띄우지 못했습니다(${err.message}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return inline('spawn-failed');
  }
  let ready = false; let settled = false; let timer = null; let readyTimer = null;
  const outcome = await new Promise((resolve) => {
    const onAbort = () => finish({ err: codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.') });
    function finish(v) {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(readyTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit');
      worker.on('error', () => {});
      worker.terminate().catch(() => {});
      resolve(v);
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    readyTimer = setTimeout(() => finish({ startFailed: `기동 ${Math.round(READY_TIMEOUT_MS / 1000)}초 안에 준비되지 않음` }), READY_TIMEOUT_MS);
    timer = setTimeout(() => finish({ err: codedError('timeout', `엑셀 생성이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`) }), timeoutMs);
    worker.on('message', (msg) => {
      if (msg?.type === 'ready') {
        ready = true; clearTimeout(readyTimer);
        try { worker.postMessage({ type: 'build', input: payload }); } catch (err) { finish({ err: codedError('worker-error', `엑셀 워커로 보내지 못했습니다: ${String(err?.message || err).slice(0, 300)}`) }); }
        return;
      }
      if (msg?.type === 'done' && msg.buf instanceof ArrayBuffer) return finish({ buffer: Buffer.from(msg.buf), meta: msg.meta || {} });
      if (msg?.type === 'error') return finish({ err: codedError('worker-error', `엑셀 생성 실패: ${String(msg.message || '알 수 없는 오류').slice(0, 300)}`) });
    });
    worker.on('error', (err) => {
      if (!ready) return finish({ startFailed: err?.message || String(err) });
      const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish({ err: codedError(oom ? 'worker-oom' : 'worker-error', oom ? '엑셀 워커가 메모리 한도를 넘어 끝났습니다(포탈은 영향 없음).' : `엑셀 워커 오류: ${String(err?.message || err).slice(0, 300)}`) });
    });
    worker.on('exit', (code) => {
      if (!ready) return finish({ startFailed: `기동 중 종료(코드 ${code})` });
      finish({ err: codedError('worker-exit', `엑셀 워커가 결과 없이 끝났습니다(코드 ${code}).`) });
    });
  });
  if (outcome.startFailed != null) {
    if (signal?.aborted) throw codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
    console.warn(`[vm-list] 엑셀 워커를 띄우지 못했습니다(${outcome.startFailed}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return inline('spawn-failed');
  }
  if (outcome.err) throw outcome.err;
  return { buffer: outcome.buffer, meta: outcome.meta, mode: 'worker' };
}
