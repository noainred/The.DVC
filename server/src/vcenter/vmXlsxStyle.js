/**
 * vcenter/vmXlsxStyle.js — VM 엑셀 두 종류('VM 전체 정보' · 'VM 목록')가 함께 쓰는 서식(v2.801 — 승인 시안 ③④
 * https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h · 사용자 요청 "이걸 엑셀로 예쁘게, 가독성 좋게").
 *
 *  · 값은 바꾸지 않는다(CSV 와 같은 글자·수) — 색·숫자 서식·줄무늬만 입힌다. 판정을 새로 하지 않는다(칸 글자로 색만 고른다).
 *  · '수집 안 됨'·'내려받을 때 조회' 는 흐린 기울임(예전 주황 칸은 표 전체가 주황으로 보였다).
 *  · 수식 칸을 만들지 않는다. 조건부 서식도 쓰지 않는다(칸 고유 색을 덮고 — 판마다 해석이 달라 '복구' 위험을 늘리지 않게). 색은 칸마다 고정.
 *  ⚠ 워커(vmExportXlsxWorker · vmListXlsxWorker)에서도 로드된다 — store·config·DB 같은 부수효과 있는 import 를 넣지 말 것.
 */
import '../util/xlsxSheetPrOrder.js';   // v2.799.1 — 폴더 트리 시트(개요 + 폭 한 장 인쇄)의 <sheetPr> 순서(워커도 이 파일을 불러 같이 걸린다)
import { VERDICT_TEXT, METHOD_TEXT } from '../veeam/backupStatus.js';

export const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFD4D8DE' } };
export const BORDER = Object.freeze({ top: thin, left: thin, bottom: thin, right: thin });
export const PAL = Object.freeze({
  head: 'FF1E3A5F', headFg: 'FFFFFFFF', headLine: 'FF2C4A70', title: 'FF0F172A', muted: 'FF475569', faint: 'FF94A3B8',
  zebra: 'FFF6F8FB', bar: 'FF166534',
  depth: Object.freeze(['FFD6E2F0', 'FFE3EBF5', 'FFEDF2F8', 'FFF5F8FB']),   // 폴더 단계 바탕(위가 진하다 — 시안 ①④)
  green: 'FF15803D', amber: 'FFB45309', red: 'FFB91C1C', redBg: 'FFFEE2E2', amberBg: 'FFFEF3C7', amberFg: 'FF92400E', redFg: 'FF991B1B',
});
export const MISSING_TEXTS = Object.freeze(['수집 안 됨', '내려받을 때 조회']);

/** 열 key → 서식 종류. 두 카탈로그(vmExportCatalog · vmListCatalog)의 key 를 함께 둔다(key 는 고정 — 바뀌지 않는다). */
export const KIND_BY_KEY = Object.freeze({
  powerState: 'power', power: 'power',
  toolsStatus: 'tools',
  cpuUsagePct: 'pct', memUsagePct: 'pct',
  vbkYn: 'yn', vsnapYn: 'yn',
  vjudge: 'verdict',
  bmethod: 'method',
  name: 'name',
});
export const kindOf = (key) => KIND_BY_KEY[key] || '';

const POWER = Object.freeze({
  POWERED_ON: { color: PAL.green, bold: true }, 켜짐: { color: PAL.green, bold: true },
  POWERED_OFF: { color: 'FF64748B' }, 꺼짐: { color: 'FF64748B' },
  SUSPENDED: { color: PAL.amber, bold: true }, '일시 중지': { color: PAL.amber, bold: true },
});
const TOOLS = Object.freeze({ RUNNING: { color: PAL.green }, NOT_RUNNING: { color: PAL.amber, bold: true }, OUTDATED: { color: PAL.amber, bold: true } });
// '아니오' 는 굵은 빨강 글자만(바탕을 칠하면 백업 안 된 VM 이 많은 법인에서 표 전체가 빨갛다 — 렌더 확인 v2.801)
const YN = Object.freeze({ 예: { color: PAL.green, bold: true }, 아니오: { color: PAL.redFg, bold: true }, 모름: { color: 'FF64748B' } });
/** 백업 판단 글자 → 색(vmListXlsx VERDICT_STYLE 과 같은 색). */
const VERDICT = Object.freeze({
  [VERDICT_TEXT.veeam]: { bg: 'FFDCFCE7', color: 'FF166534', bold: true },
  [VERDICT_TEXT.snap]: { bg: 'FFE0F2FE', color: 'FF075985', bold: true },
  [VERDICT_TEXT['snap-unlinked']]: { bg: 'FFE0F2FE', color: 'FF075985', bold: true },
  [VERDICT_TEXT['snap-vunknown']]: { bg: 'FFE0F2FE', color: 'FF075985', bold: true },
  [VERDICT_TEXT.none]: { bg: PAL.amberBg, color: PAL.amberFg, bold: true },
  [VERDICT_TEXT.unknown]: { bg: 'FFF1F5F9', color: PAL.muted },
});

/**
 * v2.807 백업 방식(사람이 정한 값) 색 — 밝은 바탕용(웹 backupViewText METHODS 와 같은 계열 · 키 집합은 METHOD_TEXT 와 같다 — 테스트 대조).
 * 트리 시트 VM 칸 · 폴더 합계 글자 · 요약 줄 · 데이터 시트 'bmethod' 칸이 함께 쓴다.
 */
export const METHOD_LOOK = Object.freeze({
  veeam: Object.freeze({ fg: 'FF166534', bg: 'FFDCFCE7' }),
  clone: Object.freeze({ fg: 'FF0E7490', bg: 'FFCFFAFE' }),
  bareos: Object.freeze({ fg: 'FFC2410C', bg: 'FFFFEDD5' }),   // v2.828 Bareos(웹 칩 #fdba74 계열 — 밝은 바탕용 진한 주황)
  ssh: Object.freeze({ fg: 'FF1D4ED8', bg: 'FFDBEAFE' }),   // v2.835 SSH(웹 칩 #93c5fd 계열 — 밝은 바탕용 진한 파랑)
  config: Object.freeze({ fg: 'FF6D28D9', bg: 'FFEDE9FE' }),
  none: Object.freeze({ fg: 'FF475569', bg: 'FFF1F5F9' }),
  check: Object.freeze({ fg: 'FFB45309', bg: 'FFFEF3C7' }),   // v2.816 확인 필요
});
const METHOD_BY_TEXT = Object.freeze(Object.fromEntries(Object.entries(METHOD_TEXT).map(([k, t]) => [t, { bg: METHOD_LOOK[k].bg, color: METHOD_LOOK[k].fg, bold: true }])));

/** 숫자 서식 — 정수 '#,##0' · 소수 '#,##0.0'(값은 그대로). */
export const numFmtOf = (v) => (Number.isInteger(v) ? '#,##0' : '#,##0.0');

/**
 * 칸 하나의 모양(값을 보고) — { font?, fill?, numFmt?, align? } 또는 null(손대지 않음). zebra 는 줄무늬 바탕(칸 고유 바탕이 없을 때만).
 * @param {any} v 칸 값 @param {string} kind kindOf(key)
 */
export function cellLook(v, kind, zebra = false) {
  const out = {};
  let bg = zebra ? PAL.zebra : null;
  if (typeof v === 'string' && MISSING_TEXTS.includes(v)) {
    out.font = { italic: true, color: { argb: PAL.faint } };
  } else if (typeof v === 'number' && Number.isFinite(v)) {
    out.numFmt = numFmtOf(v);
    if (kind === 'pct') {
      if (v >= 90) { bg = PAL.redBg; out.font = { bold: true, color: { argb: PAL.redFg } }; } else if (v >= 80) { bg = PAL.amberBg; out.font = { bold: true, color: { argb: PAL.amberFg } }; }
    }
  } else if (typeof v === 'string' && v) {
    const st = kind === 'power' ? POWER[v] : kind === 'tools' ? TOOLS[v] : kind === 'yn' ? YN[v] : kind === 'verdict' ? VERDICT[v] : kind === 'method' ? METHOD_BY_TEXT[v] : null;
    if (st) { out.font = { bold: !!st.bold, color: { argb: st.color } }; if (st.bg) bg = st.bg; }
  }
  if (kind === 'name') out.font = { ...(out.font || {}), bold: true };
  if (bg) out.fill = fill(bg);
  return out.font || out.fill || out.numFmt ? out : null;
}

/** 칸에 모양을 입힌다(cellLook 결과). */
export function applyLook(cell, look) {
  if (!look) return;
  if (look.font) cell.font = look.font;
  if (look.fill) cell.fill = look.fill;
  if (look.numFmt) cell.numFmt = look.numFmt;
}

/**
 * 데이터 행 하나 — 칸마다 종류에 맞는 모양 + 한 줄 건너 줄무늬. keys 가 없으면(예전 v2.792 열) 종류 없이 줄무늬·숫자 서식만.
 * @param {import('exceljs').Row} row @param {any[]} values @param {string[]|null} kinds @param {boolean} zebra
 */
export function styleDataRow(row, values, kinds, zebra) {
  for (let i = 0; i < values.length; i++) applyLook(row.getCell(i + 1), cellLook(values[i], kinds ? kinds[i] : '', zebra));
}

/** 머리 행(남색) — 칸마다 같은 모양. */
export function styleHeadRow(row, { height = 32, colors = null } = {}) {
  row.eachCell((c, i) => {
    c.fill = fill(colors?.[i - 1] || PAL.head);
    c.font = { bold: true, color: { argb: PAL.headFg } };
    c.border = BORDER;
    c.alignment = { vertical: 'middle', wrapText: true };
  });
  row.height = height;
}

/** 폴더 단계 바탕(0 = 맨 위 'vCenter / vm'). */
export const depthTint = (d) => PAL.depth[Math.max(0, Math.min(PAL.depth.length - 1, d))];

/** 폴더 행 첫 칸 — 굵은 폴더 이름 + 회색 'N VM'(화면 트리와 같은 표기 — 시안 ①④). */
export function folderLabel(name, vms) {
  return { richText: [{ text: '📁 ' }, { font: { bold: true, color: { argb: PAL.title } }, text: String(name) }, { font: { color: { argb: 'FF64748B' } }, text: `  ${vms.toLocaleString('en-US')} VM` }] };
}

/** 막대 글자 — '█████████░'(0~1). 모르면 ''. */
export function barText(rate, width = 10) {
  if (rate == null || !Number.isFinite(rate)) return '';
  const n = Math.max(0, Math.min(width, Math.round(rate * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}
