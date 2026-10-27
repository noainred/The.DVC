/**
 * storage/usageXlsx.js — 스토리지 사용량 **엑셀 첨부**(v2.791). exceljs 는 ipam/excel.js·tools/wasteExportXlsx.js 와 같은 기존 의존성.
 *
 * 사용자 요청(2026-10-26): "메일 발송을 Excel 형식으로 하고, 누적된 모든 주간 사용량을 표시해줘, 2026년 1주차, 2주차...
 *   포탈에서 보이는것처럼 엑셀로 만들어줘" + "관리자가 실제로 사용할 수 있는 데이터를 첨부". 시트 구성은 승인된 캔버스 시안
 *   (https://claude.ai/artifact/8CD6gZbSab7UBo1RZ6spTW)을 따른다:
 *   ① 요약 — 핵심 지표 · 조치가 필요한 항목(90%·100% 도달 예상) · 증가 상위 · 풀별 · 법인별 · 종류별 · 못 읽은 장비
 *   ② 주간 사용량 — 포탈 '날짜별 표' 와 같은 머리(법인 / 장비 / 구분 / 지표) · 행 = 누적 전 주차(ISO) · 머리·주차 열 고정
 *   ③ 법인별 · 종류별 — 주차별 합계 + '값 있음 N/M대'(부분 합은 주황)
 *   ④ 데이터 (행 단위) — 한 줄 = 주차 × 장비/풀/LUN/파일시스템, 숫자 칸은 숫자 · 자동 필터(피벗용)
 *   ⑤ 읽는 법
 *
 * ⚠ 숫자는 화면·메일과 같은 판단 코어(`usageReport.js` · `usageInsights.js`)에서 온다 — 여기서 새로 계산하지 않는다.
 * ⚠ 값이 없으면 빈 칸(0 이 아니다) · 수집 전 기간은 회색 · 기준일이 아닌 날의 관측은 파란 기울임(관측일은 데이터 시트에).
 * ⚠ 이름은 문자열 칸으로만 쓴다(수식 칸을 만들지 않는다 — '=' 로 시작하는 장비 이름도 실행되지 않는다).
 * ⚠ 큰 표(전체 누적 × 장비 수)에서도 이벤트 루프를 길게 잡지 않게 행 묶음마다 양보한다(wasteExportXlsx 와 같은 이유).
 */
import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import { numOrNull } from '../util/numOrNull.js';
import { deadlineMs } from '../util/deadline.js';
import { buildInsights, firstIndexOf, unitNum } from './usageInsights.js';
import { labelOfDay } from './usageReport.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const SHEETS = Object.freeze(['요약', '주간 사용량', '법인별 · 종류별', '데이터 (행 단위)', '읽는 법']);

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const C = Object.freeze({
  corp: 'FF1E3A5F', dev: 'FFDBE5F1', all: 'FFEEF3F9', hdd: 'FFE3EEDB', ssd: 'FFE6E0F3', res: 'FFF3EADB', metric: 'FFF8FAFC',
  warnBg: 'FFFFF2CC', warnFg: 'FF7C4A03', critBg: 'FFFDE2E1', critFg: 'FF991B1B', grey: 'FFECEFF3', inexact: 'FF1D4ED8',
  partBg: 'FFFFF7ED', partFg: 'FF9A3412', title: 'FF0F172A', muted: 'FF475569', border: 'FFD4D8DE',
});
const NUM_FMT = '#,##0.0';
const PCT_FMT = '0.0%';
const thin = { style: 'thin', color: { argb: C.border } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const yieldLoop = () => new Promise((r) => setImmediate(r));

/** 첨부 파일 이름 — 'storage-usage-weekly-2026-W44.xlsx'(SMTP 첨부 이름 화이트리스트: 영문·숫자·._- 만). */
export function xlsxFileName(ins) {
  const k = String(ins?.weekKey || ins?.dayLabel || 'report').replace(/[^A-Za-z0-9._-]/g, '');
  return `storage-usage-weekly-${k || 'report'}.xlsx`;
}

function tone(cell, pct, rule) {
  const p = numOrNull(pct);
  if (p == null) return;
  if (p >= rule.critPct) { cell.fill = fill(C.critBg); cell.font = { ...(cell.font || {}), bold: true, color: { argb: C.critFg } }; }
  else if (p >= rule.warnPct) { cell.fill = fill(C.warnBg); cell.font = { ...(cell.font || {}), bold: true, color: { argb: C.warnFg } }; }
}
const pctFrac = (p) => (numOrNull(p) == null ? null : Math.round(numOrNull(p) * 10) / 1000);
function headRow(ws, values, argb, { bold = true, color = null } = {}) {
  const r = ws.addRow(values);
  r.eachCell((c) => { c.fill = fill(argb); c.font = { bold, ...(color ? { color: { argb: color } } : {}) }; c.border = BORDER; c.alignment = { vertical: 'middle' }; });
  return r;
}
function section(ws, text, sub = '') {
  ws.addRow([]);
  const r = ws.addRow([text]);
  r.getCell(1).font = { bold: true, size: 12, color: { argb: C.title } };
  if (sub) { const s = ws.addRow([sub]); s.getCell(1).font = { color: { argb: C.muted } }; }
}
const bytesCell = (c, unit) => unitNum(c?.usedBytes, unit);

/* ── ① 요약 ─────────────────────────────────────────────────────── */
function summarySheet(wb, rep, ins, o) {
  const ws = wb.addWorksheet(SHEETS[0], { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 40 }, { width: 14 }, { width: 14 }, { width: 11 }, { width: 13 }, { width: 13 }, { width: 8 }, { width: 13 }, { width: 13 }, { width: 13 }, { width: 24 }, { width: 24 }];
  const t = ws.addRow([`스토리지 사용량 요약 — ${ins.weekLabel} (기준 ${ins.dayLabel})`]);
  t.getCell(1).font = { bold: true, size: 15, color: { argb: C.title } };
  const k = ins.kpi; const cur = ins.total.cur;
  ws.addRow([`장비 ${k.devices}대 중 ${cur ? cur.counted : 0}대 값 있음 · 직전 주 = ${ins.prevLabel || '—'}${ins.prevDayLabel ? `(${ins.prevDayLabel.slice(5)})` : ''} · `
    + `${ins.rule.avgWeeks}주 평균 = 최근 ${ins.rule.avgWeeks}걸음 중 양쪽 값이 다 있는 걸음의 평균 증가 · 만든 시각 ${o.stamp}`]).getCell(1).font = { color: { argb: C.muted } };
  ws.addRow([]);
  headRow(ws, ['핵심 지표', '값', '비고'], C.dev);
  const kv = (label, value, note = '', fmt = null) => {
    const r = ws.addRow([label, value, note]);
    if (fmt) r.getCell(2).numFmt = fmt;
    r.eachCell((c) => { c.border = BORDER; });
    return r;
  };
  kv('전체 용량 (TB)', unitNum(cur?.totalBytes, 'TB'), cur?.partial ? `부분 합 — 값 있음 ${cur.counted}/${cur.expected}대` : `${cur?.counted ?? 0}대 합계`, NUM_FMT);
  kv('사용 (TB)', unitNum(cur?.usedBytes, 'TB'), '', NUM_FMT);
  kv('사용률', pctFrac(cur?.pct), '', PCT_FMT);
  kv('직전 주 대비 (TB)', unitNum(ins.total.delta, 'TB'), ins.total.delta == null ? (ins.total.deltaWhy === 'partial' ? '두 주 중 하나가 부분 합이라 내지 않음' : '값 없음') : '', NUM_FMT);
  kv(`${ins.rule.avgWeeks}주 평균 증가 (TB/주)`, unitNum(ins.total.avg, 'TB'), ins.total.avg == null ? '완전한 주가 부족해 내지 않음' : '', NUM_FMT);
  kv(`${ins.rule.warnPct}% 이상`, `${k.warnDevices}대 · ${k.warnItems}항목`, `${ins.rule.critPct}% 이상 ${k.critDevices}대 · ${k.critItems}항목(항목 = 장비·풀·LUN·파일시스템)`);
  kv('이번 주 값을 못 읽은 장비', `${k.missing}대`, k.missing ? '합계에서 뺐습니다(0 으로 넣지 않음)' : '');

  section(ws, `조치가 필요한 항목 — ${ins.actions.length}개`, `${ins.rule.warnPct}% 이상이거나, ${ins.rule.avgWeeks}주 평균 증가로 ${ins.rule.horizonWeeks}주 안에 ${ins.rule.critPct}%에 닿는 장비·풀·LUN·파일시스템(급한 순). 도달 예상은 직선 추정입니다.`);
  headRow(ws, ['장비 · 항목', '법인', '종류', '사용률', '사용', '전체', '단위', '남은 용량', '지난주 증가', `${ins.rule.avgWeeks}주 평균`, `${ins.rule.critPct}% 도달 예상`, '100% 도달 예상'], C.corp, { color: 'FFFFFFFF' });
  if (!ins.actions.length) ws.addRow(['없음']);
  for (const e of ins.actions) {
    const c = e.trend.cur;
    const free = c && c.usedBytes != null ? c.totalBytes - c.usedBytes : null;
    const r = ws.addRow([e.name, e.corp, e.typeLabel, pctFrac(c?.pct), unitNum(c?.usedBytes, e.unit), unitNum(c?.totalBytes, e.unit), e.unit,
      unitNum(free, e.unit), unitNum(e.trend.delta, e.unit), unitNum(e.trend.avg, e.unit), e.eta90, e.eta100]);
    r.getCell(4).numFmt = PCT_FMT; for (const i of [5, 6, 8, 9, 10]) r.getCell(i).numFmt = NUM_FMT;
    r.eachCell({ includeEmpty: true }, (cc) => { cc.border = BORDER; });
    r.getCell(1).font = { bold: true };
    tone(r.getCell(4), c?.pct, ins.rule);
  }

  section(ws, '지난주 증가량 상위 5 (장비)');
  headRow(ws, ['장비', '법인', '종류', `${ins.prevLabel} 사용 (TB)`, `${ins.weekLabel} 사용 (TB)`, '증가 (TB)', '', `${ins.rule.avgWeeks}주 평균 (TB)`], C.dev);
  if (!ins.growthTop.length) ws.addRow(['증가한 장비가 없거나 두 주 값이 다 있는 장비가 없습니다']);
  for (const e of ins.growthTop) {
    const r = ws.addRow([e.name, e.corp, e.typeLabel, unitNum(e.trend.prev?.usedBytes, 'TB'), unitNum(e.trend.cur?.usedBytes, 'TB'), unitNum(e.trend.delta, 'TB'), null, unitNum(e.trend.avg, 'TB')]);
    for (const i of [4, 5, 6, 8]) r.getCell(i).numFmt = NUM_FMT;
    r.eachCell((cc) => { cc.border = BORDER; });
  }

  if (ins.poolRows.length) {
    section(ws, 'PowerScale(아이실론) 풀별 사용량', 'HDD 풀과 SSD 풀을 따로 셉니다. 한 매체의 풀만 있는 장비는 다른 풀 칸을 비우고 비고에 적습니다(0 TB 가 아닙니다).');
    headRow(ws, ['장비', '법인', '비고', '전체 %', '전체 사용', '전체 크기', '', 'HDD %', 'HDD 사용', 'HDD 크기', 'SSD %', 'SSD 사용 / 크기'], C.dev);
    for (const pr of ins.poolRows) {
      const a = pr.device.trend.cur; const h = pr.hdd?.trend.cur; const s = pr.ssd?.trend.cur;
      const ssdTxt = pr.ssd ? (s ? `${unitNum(s.usedBytes, 'TB') ?? '—'} / ${unitNum(s.totalBytes, 'TB')} TB` : '—') : '풀 없음';
      const r = ws.addRow([pr.device.name, pr.device.corp, pr.note || 'HDD·SSD 풀', pctFrac(a?.pct), unitNum(a?.usedBytes, 'TB'), unitNum(a?.totalBytes, 'TB'), null,
        pr.hdd ? pctFrac(h?.pct) : null, pr.hdd ? unitNum(h?.usedBytes, 'TB') : null, pr.hdd ? unitNum(h?.totalBytes, 'TB') : null, pr.ssd ? pctFrac(s?.pct) : null, ssdTxt]);
      for (const i of [4, 8, 11]) r.getCell(i).numFmt = PCT_FMT;
      for (const i of [5, 6, 9, 10]) r.getCell(i).numFmt = NUM_FMT;
      tone(r.getCell(4), a?.pct, ins.rule); if (pr.hdd) tone(r.getCell(8), h?.pct, ins.rule); if (pr.ssd) tone(r.getCell(11), s?.pct, ins.rule);
      r.eachCell((cc) => { cc.border = BORDER; });
    }
  }

  const groupTable = (title, list) => {
    section(ws, `${title} (${ins.weekLabel})`);
    headRow(ws, [title.replace('별', ''), '장비', '전체 (TB)', '사용 (TB)', '사용률', '직전 주 대비 (TB)', '', '비고'], C.dev);
    for (const g of list) {
      const c = g.cur;
      const note = c?.partial ? `부분 합 · 값 있음 ${c.counted}/${c.expected}대` : '';
      const r = ws.addRow([g.key, g.devices, unitNum(c?.totalBytes, 'TB'), unitNum(c?.usedBytes, 'TB'), pctFrac(c?.pct), unitNum(g.delta, 'TB'), null, note]);
      for (const i of [3, 4, 6]) r.getCell(i).numFmt = NUM_FMT; r.getCell(5).numFmt = PCT_FMT;
      if (note) r.getCell(8).font = { color: { argb: C.partFg } };
      r.eachCell((cc) => { cc.border = BORDER; });
    }
  };
  groupTable('법인별', ins.byCorp);
  groupTable('종류별', ins.byType);

  section(ws, `이번 주 값을 읽지 못한 장비 — ${ins.missing.length}대`);
  if (!ins.missing.length) ws.addRow(['없음']);
  else {
    headRow(ws, ['장비', '법인', '종류', '사유'], C.dev);
    for (const m of ins.missing) { const r = ws.addRow([m.name, m.corp, m.typeLabel, m.why]); r.eachCell((cc) => { cc.border = BORDER; }); }
  }
  return ws;
}

/* ── ② 주간 사용량(포탈 날짜별 표와 같은 머리) ─────────────────────── */
async function weeklySheet(wb, rep, ins) {
  const ws = wb.addWorksheet(SHEETS[1], { views: [{ state: 'frozen', xSplit: 2, ySplit: 7 }] });
  const periods = ins.periods;
  // 열 묶음: 법인 → 장비(전체) → 풀 → 하위 항목. 화면 WideTable 과 같은 순서(법인 이름 · 장비 이름 숫자 정렬).
  const corpOrder = [...new Set(ins.entities.map((e) => e.corp))].sort((a, b) => a.localeCompare(b, 'ko'));
  const groups = [];
  for (const corp of corpOrder) {
    const devs = ins.entities.filter((e) => e.corp === corp && e.kind === 'device')
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'en', { numeric: true }));
    for (const d of devs) {
      const subs = ins.entities.filter((e) => e.deviceId === d.deviceId && e.kind !== 'device');
      groups.push({ corp, dev: d, cols: [d, ...subs.filter((e) => e.kind === 'pool'), ...subs.filter((e) => e.kind !== 'pool')] });
    }
  }
  const nCols = 2 + groups.reduce((a, g) => a + g.cols.length * 3, 0);
  const r1 = ws.addRow([`스토리지 사용량 — 주간 (ISO 주차 · ${rep.weekdayLabels?.[rep.weekday] || '월'}요일 기준) · ${ins.firstLabel} ~ ${ins.weekLabel} · 단위 TB (LUN·파일시스템은 GB)`]);
  r1.getCell(1).font = { bold: true, size: 14, color: { argb: C.title } };
  ws.addRow([`기준 ${ins.dayLabel} · 빈 칸 = 그 주에 값을 못 읽음(0 아님) · 파란 기울임 = 기준일 관측이 없어 직전 6일 안의 가장 늦은 관측(관측일은 '데이터 (행 단위)' 시트) · 회색 = 아직 수집 전`]).getCell(1).font = { color: { argb: C.muted } };
  ws.addRow([`색: ${ins.rule.warnPct}% 이상 노랑 · ${ins.rule.critPct}% 이상 빨강. 풀은 장비 합계의 부분이고, LUN·파일시스템 이력은 수집을 시작한 주부터 있습니다.`]).getCell(1).font = { color: { argb: C.muted } };
  // 머리 4줄
  const h4 = ['법인', '']; const h5 = ['장비', '']; const h6 = ['구분', '']; const h7 = ['주차', '기준일'];
  const merges = [];
  let col = 3;
  for (const g of groups) {
    const width = g.cols.length * 3;
    const devTitle = [g.dev.name, g.dev.typeLabel, g.dev.poolNote].filter(Boolean).join(' · ');
    merges.push({ row: 5, from: col, to: col + width - 1, text: devTitle, argb: C.dev });
    for (const e of g.cols) {
      const subLabel = e.kind === 'device' ? '전체' : e.kind === 'pool' ? e.item : `${e.group} ${e.item}`;
      const argb = e.kind === 'device' ? C.all : e.kind === 'pool' ? (e.poolKey === 'ssd' ? C.ssd : C.hdd) : C.res;
      merges.push({ row: 6, from: col, to: col + 2, text: subLabel, argb });
      for (let i = 0; i < 3; i++) { h4.push(''); h5.push(''); h6.push(''); }
      h7.push(e.unit === 'GB' ? 'Size (GB)' : 'Total (TB)', `Used (${e.unit})`, '%');
      col += 3;
    }
  }
  // 법인 묶음
  let c0 = 3;
  for (const corp of corpOrder) {
    const w = groups.filter((g) => g.corp === corp).reduce((a, g) => a + g.cols.length * 3, 0);
    if (w) merges.push({ row: 4, from: c0, to: c0 + w - 1, text: corp, argb: C.corp, white: true });
    c0 += w;
  }
  for (const [vals, argb] of [[h4, C.corp], [h5, C.dev], [h6, C.all], [h7, C.metric]]) {
    const r = ws.addRow(vals);
    for (let i = 1; i <= Math.max(nCols, 2); i++) { const c = r.getCell(i); c.fill = fill(argb); c.border = BORDER; c.font = { bold: true, ...(argb === C.corp ? { color: { argb: 'FFFFFFFF' } } : {}) }; }
  }
  for (const m of merges) {
    if (m.to > m.from) ws.mergeCells(m.row, m.from, m.row, m.to);
    const c = ws.getCell(m.row, m.from);
    c.value = m.text; c.fill = fill(m.argb); c.font = { bold: true, ...(m.white ? { color: { argb: 'FFFFFFFF' } } : {}) };
    c.alignment = { horizontal: 'center', vertical: 'middle' };
  }
  for (let i = 3; i <= nCols; i++) ws.getCell(7, i).alignment = { horizontal: 'right' };
  ws.getColumn(1).width = 17; ws.getColumn(2).width = 12;
  for (let i = 3; i <= nCols; i++) ws.getColumn(i).width = 11;
  // 본문 — 최근 주가 아래(포탈 표와 같은 순서)
  const firsts = new Map(groups.flatMap((g) => g.cols).map((e) => [e.key, firstIndexOf(e, periods)]));
  for (let pi = 0; pi < periods.length; pi++) {
    const p = periods[pi];
    const vals = [p.label, p.dayLabel || labelOfDay(p.day)];
    const marks = [];
    for (const g of groups) {
      for (const e of g.cols) {
        const c = e.cells[pi];
        const fi = firsts.get(e.key);
        const before = !c && (fi < 0 || pi < fi);
        vals.push(c ? unitNum(c.totalBytes, e.unit) : null, c ? bytesCell(c, e.unit) : null, c ? pctFrac(c.pct) : null);
        marks.push({ c, before });
      }
    }
    const r = ws.addRow(vals);
    r.getCell(1).font = { bold: pi === periods.length - 1 };
    marks.forEach((m, i) => {
      const base = 3 + i * 3;
      for (let k = 0; k < 3; k++) {
        const cell = r.getCell(base + k);
        cell.numFmt = k === 2 ? PCT_FMT : NUM_FMT;
        if (m.before) cell.fill = fill(C.grey);
        else if (m.c && m.c.exact === false) cell.font = { italic: true, color: { argb: C.inexact } };
      }
      if (m.c) tone(r.getCell(base + 2), m.c.pct, ins.rule);
    });
    if ((pi % 20) === 19) await yieldLoop();
  }
  return { ws, columns: nCols };
}

/* ── ③ 법인별 · 종류별 주차 합계 ─────────────────────────────────── */
async function groupSheet(wb, ins) {
  const ws = wb.addWorksheet(SHEETS[2], { views: [{ state: 'frozen', xSplit: 2, ySplit: 4 }] });
  const all = [...ins.byCorp.map((g) => ({ ...g, title: `법인 › ${g.key}` })), ...ins.byType.map((g) => ({ ...g, title: `종류 › ${g.key}` }))];
  ws.addRow([`법인별 · 종류별 주간 합계 — ${ins.firstLabel} ~ ${ins.weekLabel} · 단위 TB`]).getCell(1).font = { bold: true, size: 14, color: { argb: C.title } };
  ws.addRow(['합계는 크기와 사용량을 둘 다 읽은 장비만 더합니다. 그 주에 값이 없는 장비가 있으면 주황(부분 합)이고 \'값 있음\' 칸이 몇 대인지 밝힙니다.']).getCell(1).font = { color: { argb: C.muted } };
  const h3 = ['', '']; const h4 = ['주차', '기준일'];
  for (const g of all) { h3.push(g.title, '', '', ''); h4.push('Total (TB)', 'Used (TB)', '%', '값 있음'); }
  const r3 = ws.addRow(h3); const r4 = ws.addRow(h4);
  const n = 2 + all.length * 4;
  for (let i = 1; i <= n; i++) {
    r3.getCell(i).fill = fill(C.corp); r3.getCell(i).font = { bold: true, color: { argb: 'FFFFFFFF' } }; r3.getCell(i).border = BORDER;
    r4.getCell(i).fill = fill(C.metric); r4.getCell(i).font = { bold: true }; r4.getCell(i).border = BORDER;
  }
  all.forEach((g, gi) => { const c = 3 + gi * 4; ws.mergeCells(3, c, 3, c + 3); ws.getCell(3, c).alignment = { horizontal: 'center' }; });
  ws.getColumn(1).width = 17; ws.getColumn(2).width = 12;
  for (let i = 3; i <= n; i++) ws.getColumn(i).width = 11;
  for (let pi = 0; pi < ins.periods.length; pi++) {
    const p = ins.periods[pi];
    const vals = [p.label, p.dayLabel || labelOfDay(p.day)];
    for (const g of all) {
      const c = g.cells[pi];
      vals.push(c && c.counted ? unitNum(c.totalBytes, 'TB') : null, c && c.counted ? unitNum(c.usedBytes, 'TB') : null, c && c.counted ? pctFrac(c.pct) : null,
        c && c.expected ? `${c.counted}/${c.expected}` : '');
    }
    const r = ws.addRow(vals);
    all.forEach((g, gi) => {
      const c = g.cells[pi]; const base = 3 + gi * 4;
      r.getCell(base).numFmt = NUM_FMT; r.getCell(base + 1).numFmt = NUM_FMT; r.getCell(base + 2).numFmt = PCT_FMT;
      if (c?.partial) for (let k = 0; k < 4; k++) { r.getCell(base + k).fill = fill(C.partBg); r.getCell(base + k).font = { color: { argb: C.partFg } }; }
    });
    if ((pi % 40) === 39) await yieldLoop();
  }
  return ws;
}

/* ── ④ 데이터(행 단위 — 피벗용) ─────────────────────────────────── */
export const DATA_COLUMNS = Object.freeze(['주차 키', '주차', '기준일', '관측일', '법인', '종류', '장비', '구분', '항목', '단위', '전체', '사용', '사용률', '직전 주 대비', '표지']);
async function dataSheet(wb, ins, { dataWeeks = null } = {}) {
  const ws = wb.addWorksheet(SHEETS[3], { views: [{ state: 'frozen', ySplit: 1 }] });
  const widths = [11, 15, 12, 12, 14, 13, 24, 8, 22, 6, 12, 12, 9, 13, 18];
  ws.columns = DATA_COLUMNS.map((h, i) => ({ header: h, width: widths[i] }));
  const hr = ws.getRow(1);
  hr.eachCell((c) => { c.fill = fill(C.corp); c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; });
  const periods = ins.periods;
  const from = dataWeeks ? Math.max(0, periods.length - dataWeeks) : 0;
  let rows = 0;
  // 최근 주가 위(필터 없이 열어도 이번 주가 먼저 보이게)
  for (let pi = periods.length - 1; pi >= from; pi--) {
    const p = periods[pi];
    for (const e of ins.entities) {
      const c = e.cells[pi];
      const fi = firstIndexOf(e, periods);
      if (!c && (fi < 0 || pi < fi)) continue;                    // 수집 전 — 줄을 만들지 않는다
      if (!c && e.kind === 'device' && e.enabled === false && e.lastDay != null && e.lastDay < p.fromDay) continue;   // 꺼진 뒤
      const prev = pi > 0 ? e.cells[pi - 1] : null;
      const d = prev && c && prev.usedBytes != null && c.usedBytes != null ? c.usedBytes - prev.usedBytes : null;
      const mark = !c ? '못 읽음' : (c.usedBytes == null ? '사용량 못 읽음' : (c.exact === false ? `≈ ${labelOfDay(c.day).slice(5)} 관측` : (e.kind === 'device' ? e.poolNote : '')));
      const r = ws.addRow([p.isoKey || p.key, p.label, p.dayLabel || labelOfDay(p.day), c ? labelOfDay(c.day) : '', e.corp, e.typeLabel, e.device,
        e.kind === 'device' ? '전체' : e.group, e.kind === 'device' ? '' : e.item, e.unit,
        c ? unitNum(c.totalBytes, e.unit) : null, c ? unitNum(c.usedBytes, e.unit) : null, c ? pctFrac(c.pct) : null, unitNum(d, e.unit), mark || '']);
      r.getCell(11).numFmt = NUM_FMT; r.getCell(12).numFmt = NUM_FMT; r.getCell(13).numFmt = PCT_FMT; r.getCell(14).numFmt = NUM_FMT;
      rows += 1;
      if ((rows % 500) === 0) await yieldLoop();
    }
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DATA_COLUMNS.length } };
  return { ws, rows, trimmed: from > 0, fromLabel: periods[from]?.label || '' };
}

/* ── ⑤ 읽는 법 ──────────────────────────────────────────────────── */
function legendSheet(wb, ins, o) {
  const ws = wb.addWorksheet(SHEETS[4], { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 18 }, { width: 110 }];
  ws.addRow(['읽는 법']).getCell(1).font = { bold: true, size: 14 };
  ws.addRow([]);
  headRow(ws, ['표시', '뜻'], C.dev);
  const row = (key, text, style = {}) => {
    const r = ws.addRow([key, text]);
    const c = r.getCell(1);
    if (style.bg) c.fill = fill(style.bg);
    c.font = { bold: true, ...(style.fg ? { color: { argb: style.fg } } : {}), ...(style.italic ? { italic: true } : {}) };
    r.eachCell((cc) => { cc.border = BORDER; cc.alignment = { wrapText: true, vertical: 'top' }; });
  };
  row('빈 칸', '값을 못 읽었습니다. 0 이 아닙니다 — 합계·증가 계산에서 뺍니다.');
  row('10.0', '파란 기울임 = 기준일(월요일) 관측이 없어 직전 6일 안의 가장 늦은 관측을 썼습니다. 실제 관측일은 \'데이터 (행 단위)\' 시트의 관측일 칸.', { fg: C.inexact, italic: true });
  row('회색', '아직 수집 전입니다(장비 등록 전, 또는 LUN·파일시스템 이력 시작 전).', { bg: C.grey });
  row(`${ins.rule.warnPct}%+`, `사용률 ${ins.rule.warnPct}% 이상.`, { bg: C.warnBg, fg: C.warnFg });
  row(`${ins.rule.critPct}%+`, `사용률 ${ins.rule.critPct}% 이상.`, { bg: C.critBg, fg: C.critFg });
  row('부분 합', '법인·종류 합계에서 그 주에 값이 없는 장비가 있습니다 — \'값 있음 N/M\' 이 몇 대를 더했는지 밝히고, 직전 주 대비를 내지 않습니다.', { bg: C.partBg, fg: C.partFg });
  row('풀 없음', 'PowerScale 에 그 매체의 풀이 없습니다(올플래시는 HDD 풀이 없고, SSD 를 L3 캐시로만 쓰면 SSD 풀이 없습니다). 0 TB 가 아닙니다. 어느 쪽인지는 수집기가 구분하지 못합니다.');
  ws.addRow([]);
  const notes = [
    '주차는 ISO 8601(월요일 시작 · 그 해 첫 목요일이 든 주가 1주차)입니다 — 엑셀 ISOWEEKNUM 과 같은 번호입니다. \'주차 키\'(2026-W44)는 정렬용입니다.',
    '단위: TB = 1024⁴ 바이트, GB = 1024³ 바이트(장비 표기와 같습니다). 숫자 칸은 숫자라 합계·피벗·차트가 그대로 됩니다. 사용률은 % 서식입니다.',
    '합계는 크기와 사용량을 둘 다 읽은 장비만 더하고, 사용률은 합계끼리 나눕니다(장비 사용률의 평균이 아닙니다). 풀 값은 장비 합계의 부분이라 합계에 더하지 않습니다.',
    `도달 예상은 최근 ${ins.rule.avgWeeks}걸음 중 양쪽 값이 다 있는 걸음(${ins.rule.minSteps}개 이상)의 평균 증가로 그은 직선 추정입니다. 크기가 그대로라고 봅니다. 증가가 0 이하이면 '증가 없음', 걸음이 모자라면 '추정 안 함' 입니다.`,
    'LUN 의 사용량은 풀에서 할당된 양(Current allocation)이고, 파일시스템은 파일시스템이 보고한 사용량입니다.',
    '장비·법인 이름은 문자열 칸으로만 씁니다(수식 칸을 만들지 않습니다).',
    ...(o.trimmedNote ? [o.trimmedNote] : []),
    `만든 시각 ${o.stamp} · 포탈 › 특수 기능 › 스토리지 사용량 보고서에서 같은 표를 볼 수 있습니다.`,
  ];
  for (const n of notes) { const r = ws.addRow(['※', n]); r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; }
  return ws;
}

/**
 * 워크북 → Buffer.
 * @param {object} rep 주간 보고표(loadUsageReport ok — 전체 누적)
 * @param {object} ins buildInsights(rep)
 * @param {{dataWeeks?:number|null, stamp?:string}} [o] dataWeeks — 데이터 시트를 최근 N주로 줄인다(메일 첨부 상한용). 다른 시트는 줄이지 않는다.
 * @returns {Promise<{buffer:Buffer, filename:string, dataRows:number, dataTrimmed:boolean, weeks:number}>}
 */
export async function buildUsageWorkbook(rep, ins, { dataWeeks = null, stamp = '' } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date();
  summarySheet(wb, rep, ins, { stamp });
  await yieldLoop();
  await weeklySheet(wb, rep, ins);
  await yieldLoop();
  await groupSheet(wb, ins);
  const data = await dataSheet(wb, ins, { dataWeeks });
  const trimmedNote = data.trimmed
    ? `메일 첨부 크기 상한 때문에 '데이터 (행 단위)' 시트는 ${data.fromLabel} 부터입니다(다른 시트는 전 주차). 전 주차 데이터는 포탈의 '엑셀 내려받기' 로 받으세요.`
    : '';
  legendSheet(wb, ins, { stamp, trimmedNote });
  await yieldLoop();
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, filename: xlsxFileName(ins), dataRows: data.rows, dataTrimmed: data.trimmed, weeks: ins.periods.length, trimmedNote };
}

/* ── 워커 실행(메인 스레드가 멈추지 않게) ─────────────────────────────
 * IP 대장 `ipam/excel.js renderIpamWorkbook` 과 같은 규칙: 매번 새 워커 → 'ready' 전에 죽으면(모듈 적재 실패) 인라인으로 만든다(콘솔에 남긴다) ·
 * 'ready' 뒤의 실패는 인라인으로 다시 하지 않는다(같은 입력이면 같은 오류, 메모리 부족이면 메인을 죽인다) · 시한이 지나면 끝낸다 · 끝나면 terminate.
 * 끄는 길: env `STORAGE_XLSX_WORKER=0`(인라인). 시한: `STORAGE_XLSX_TIMEOUT_MS`(기본 5분).
 */
const READY_TIMEOUT_MS = 60_000;
let _workerUrl = new URL('./usageXlsxWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는 가짜 워커로 인라인 경로를 확인한다. */
export function _setUsageXlsxWorkerUrlForTest(url) { _workerUrl = url || new URL('./usageXlsxWorker.js', import.meta.url); }
const codedError = (code, message) => Object.assign(new Error(message), { code });

/** 워커로 보낼 보고표 — 엑셀이 쓰는 필드만(복제 비용을 줄인다). */
export function slimReport(rep) {
  return {
    periods: rep.periods || [], weekday: rep.weekday, weekdayLabels: rep.weekdayLabels, asOfLabel: rep.asOfLabel, asOfDay: rep.asOfDay,
    types: rep.types || [], datacenters: (rep.datacenters || []).map((d) => ({ id: d.id, name: d.name })),
    devices: (rep.devices || []).map((d) => ({
      deviceId: d.deviceId, name: d.name, type: d.type, datacenterId: d.datacenterId, enabled: d.enabled, firstDay: d.firstDay, lastDay: d.lastDay,
      cells: d.cells, pools: d.pools || [], ...(d.poolNote ? { poolNote: d.poolNote } : {}), resources: d.resources || [],
      ...(typeof d.lastSnapOk === 'boolean' ? { lastSnapOk: d.lastSnapOk } : {}),
    })),
  };
}

async function renderInline(rep, opts) {
  const ins = buildInsights(rep, { includeResources: opts.includeResources !== false });
  const out = await buildUsageWorkbook(rep, ins, opts);
  return { buffer: out.buffer, meta: { filename: out.filename, dataRows: out.dataRows, dataTrimmed: out.dataTrimmed, weeks: out.weeks, trimmedNote: out.trimmedNote } };
}

/**
 * 보고표 → .xlsx 바이트(워커).
 * @param {object} rep 주간 보고표(전체 누적)
 * @param {{includeResources?:boolean, dataWeeks?:number|null, stamp?:string, timeoutMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{buffer:Buffer, meta:object, mode:'worker'|'inline', reason?:string}>}
 */
export async function renderUsageWorkbook(rep, opts = {}) {
  const slim = slimReport(rep);
  const o = { includeResources: opts.includeResources !== false, dataWeeks: opts.dataWeeks ?? null, stamp: opts.stamp || '' };
  const signal = opts.signal || null;
  if (signal?.aborted) throw codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
  if (String(process.env.STORAGE_XLSX_WORKER ?? '1').trim() === '0') return { ...(await renderInline(slim, o)), mode: 'inline', reason: 'disabled' };
  const timeoutMs = deadlineMs(opts.timeoutMs ?? process.env.STORAGE_XLSX_TIMEOUT_MS ?? 300_000, 300_000);
  let worker;
  try { worker = new Worker(_workerUrl); } catch (err) {
    console.warn(`[storage-usage] 엑셀 워커를 띄우지 못했습니다(${err.message}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return { ...(await renderInline(slim, o)), mode: 'inline', reason: 'spawn-failed' };
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
        try { worker.postMessage({ type: 'build', rep: slim, opts: o }); } catch (err) { finish({ err: codedError('worker-error', `엑셀 워커로 보내지 못했습니다: ${String(err?.message || err).slice(0, 300)}`) }); }
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
    console.warn(`[storage-usage] 엑셀 워커를 띄우지 못했습니다(${outcome.startFailed}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return { ...(await renderInline(slim, o)), mode: 'inline', reason: 'spawn-failed' };
  }
  if (outcome.err) throw outcome.err;
  return { buffer: outcome.buffer, meta: outcome.meta, mode: 'worker' };
}
