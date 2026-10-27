/**
 * vcenter/vmExportXlsx.js — 'VM 전체 정보 내보내기' 엑셀(v2.799 — 승인 시안 ④ https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC).
 *
 *  ① 데이터 — CSV 와 같은 표(buildVmExportTable 의 head·cells 그대로). 1행 = 묶음 띠(같은 묶음이 이어지는 열을 병합 · 묶음 색),
 *     2행 = 열 머리(자동 필터), 첫 두 행 + 'VM 이름' 열까지 고정. '수집 안 됨' 칸은 연한 주황.
 *  ② 읽는 법 — 조건(vCenter · 대상 · 만든 시각 · 실시간 보강 결과 · 고른 항목) + 열마다 출처와 채워진 VM 수 + 빈칸·'수집 안 됨' 의 뜻.
 * ⚠ 판정·칸 값은 만들지 않는다(카탈로그가 만든 값을 배치만 한다). 문자열 칸으로만 쓴다(수식 칸을 만들지 않는다 — '=' 로 시작하는 VM 이름도 실행되지 않는다).
 * ⚠ 이 파일은 워커(vmExportXlsxWorker.js)에서도 로드된다 — store·config·DB 같은 부수효과 있는 import 를 넣지 말 것.
 */
import ExcelJS from 'exceljs';
import { runXlsxWorker } from '../util/xlsxWorkerRun.js';
import { localStamp } from '../util/dayKey.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const VM_EXPORT_SHEETS = Object.freeze(['데이터', '읽는 법']);
const MISSING = '수집 안 됨';   // vmExportCatalog.MISSING 과 같은 값(테스트 대조) — 워커가 카탈로그를 끌어오지 않게 글자만 둔다

const fill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
const thin = { style: 'thin', color: { argb: 'FFD4D8DE' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
/** 묶음 띠 색(시안 ④) — [배경, 글자]. */
export const GROUP_STYLE = Object.freeze({
  base: ['FFDBE5F1', 'FF1E3A5F'], guest: ['FFE0F2FE', 'FF075985'], ident: ['FFF1F5F9', 'FF334155'], cpu: ['FFEDE9FE', 'FF5B21B6'],
  net: ['FFDCFCE7', 'FF166534'], disk: ['FFFEF3C7', 'FF92400E'], part: ['FFFFEDD5', 'FF9A3412'], snap: ['FFE0E7FF', 'FF3730A3'],
  dev: ['FFFEE2E2', 'FF991B1B'], meta: ['FFFCE7F3', 'FF9D174D'],
});
export const SRC_TEXT = Object.freeze({
  snap: '인벤토리(30초)', cache: '구성 캐시(주기 수집)', both: '실시간 → 없으면 구성 캐시', live: '실시간(내보낼 때)',
  parts: '실시간 → 없으면 게스트 디스크 수집', tags: '태그 캐시(주기 수집)',
});
const HEAD = 'FF1E3A5F';

/** 실시간 보강 결과 한 줄(읽는 법 시트·감사 로그가 같은 글자). */
export function liveResultText(live) {
  const s = live?.state;
  if (s === 'ok') return `성공 — ${live.rows}대 중 ${live.vms}대 응답`;
  if (s === 'off') return '끔 — 캐시 값만';
  if (s === 'unused') return '고른 항목에 실시간 항목 없음';
  if (s === 'blocked' || s === 'failed') return `쓰지 못함 — ${live.reason || '사유 모름'}`;
  return '';
}

/**
 * 표 → 워크북 바이트(순수 — 메인·워커가 같은 함수).
 * @param {{ head:string[], cells:any[][], cols:Array<{key,item,h,group,src,filled}>, meta:object, cond:{ target:string, items:number, groupNames:object, offsetLabel:string, prefName?:string } }} p
 */
export async function buildVmExportWorkbook(p) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  wb.created = new Date(p.meta.at || Date.now());
  const cols = p.cols || [];
  const nameIdx = cols.findIndex((c) => c.key === 'name');
  const ws = wb.addWorksheet(VM_EXPORT_SHEETS[0], {
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
  const head = ws.addRow(p.head);
  head.eachCell((cell) => { cell.fill = fill(HEAD); cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.border = BORDER; cell.alignment = { vertical: 'middle' }; });
  head.height = 20;
  const widths = p.head.map((h) => Math.min(60, Math.max(8, String(h).length * 1.6 + 2)));
  for (const row of p.cells) {
    const r = ws.addRow(row.map((v) => (v == null ? '' : v)));
    for (let i = 0; i < row.length; i++) {
      const v = row[i];
      if (v === MISSING) r.getCell(i + 1).fill = fill('FFFEF3C7');
      const len = typeof v === 'string' ? v.length : String(v ?? '').length;
      if (len * 1.1 + 2 > widths[i]) widths[i] = Math.min(60, len * 1.1 + 2);
    }
  }
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.round(w); });
  if (nameIdx >= 0) ws.getColumn(nameIdx + 1).font = { bold: true };
  if (cols.length) ws.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: cols.length } };

  // ② 읽는 법
  const g = wb.addWorksheet(VM_EXPORT_SHEETS[1], { views: [{ showGridLines: false }] });
  g.getColumn(1).width = 34; g.getColumn(2).width = 34; g.getColumn(3).width = 16; g.getColumn(4).width = 14;
  const t = g.addRow(['읽는 법']); t.getCell(1).font = { bold: true, size: 14, color: { argb: 'FF0F172A' } };
  g.addRow([]);
  const kv = [
    ['vCenter', p.meta.vcenterName || p.meta.vcenterId || ''],
    ['대상', `${p.cond?.target || ''} ${p.meta.rows}대`.trim()],
    ['만든 시각', `${localStamp(p.meta.at, p.meta.offsetMin)} ${p.cond?.offsetLabel || ''}`.trim()],
    ['실시간 보강', liveResultText(p.meta.live)],
    ['고른 항목', `${p.cond?.items ?? cols.length}개 · ${cols.length}열${p.cond?.prefName ? ` · 저장값 ‘${p.cond.prefName}’` : ''}`],
  ];
  for (const [k, v] of kv) { const r = g.addRow([k, v]); r.getCell(1).font = { color: { argb: 'FF475569' } }; }
  g.addRow([]);
  const th = g.addRow(['열', '출처', '묶음', '채워짐']);
  th.eachCell((cell) => { cell.fill = fill(HEAD); cell.font = { bold: true, color: { argb: 'FFFFFFFF' } }; cell.border = BORDER; });
  for (const c of cols) {
    const r = g.addRow([c.h, SRC_TEXT[c.src] || c.src, p.cond?.groupNames?.[c.group] || c.group, `${c.filled ?? 0} / ${p.meta.rows}`]);
    r.eachCell((cell) => { cell.border = BORDER; });
    r.getCell(4).alignment = { horizontal: 'right' };
  }
  g.addRow([]);
  for (const line of [
    '빈칸 = vCenter 가 값을 주지 않았거나 읽지 못한 값입니다(0 으로 쓰지 않습니다).',
    `‘${MISSING}’ = 그 출처가 이 VM 을 아직 모으지 않았습니다(실시간 보강 불가 · 구성 캐시 미도달 · 파티션 수집 꺼짐 · 태그 첫 수집 전).`,
    '시각은 포탈 시각입니다(머리에 시간대 표기). 이름 칸은 문자열로만 씁니다(‘=’ 로 시작해도 수식이 되지 않습니다).',
  ]) { const r = g.addRow([line]); r.getCell(1).font = { color: { argb: 'FF475569' }, size: 10 }; }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, meta: { rows: p.cells.length, cols: cols.length } };
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
