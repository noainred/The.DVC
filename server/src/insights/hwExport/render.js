/**
 * insights/hwExport/render.js — 모델 → 내려받을 파일(xlsx · csv · zip) (v2.966).
 *
 *  · 엑셀은 워커 스레드에서 만든다(util/xlsxWorkerRun.js — exceljs writeBuffer 는 쪼갤 수 없는 동기 직렬화).
 *    끄는 길 env HW_EXPORT_XLSX_WORKER=0 · 시한 HW_EXPORT_XLSX_TIMEOUT_MS(기본 5분).
 *  · 사양서(서버 한 대 = 시트 한 장)는 파일 하나에 HW_EXPORT_SPEC_MAX(기본 300)장까지 — 넘으면 법인마다(법인 안에서도 넘으면 나눠서)
 *    파일을 만들어 ZIP 으로 묶는다. 잘라 버리지 않는다(빠진 서버가 생기지 않게). 각 파일은 그 서버들의 요약 · 상세 · 안내를 함께 갖는다.
 *  · CSV 는 표 한 장 = 파일 하나(서버 요약 + 고른 상세). 두 개 이상이면 ZIP. 띠 · 사양서는 없다(엑셀 전용).
 */
import { runXlsxWorker } from '../../util/xlsxWorkerRun.js';
import { zipManyAsync } from '../../util/zip.js';
import { csvLine, CSV_BOM } from '../../util/csv.js';
import { buildHwWorkbook, XLSX_MIME } from './xlsx.js';

export { XLSX_MIME };
export const SPEC_MAX = Math.max(10, Math.min(2000, Number(process.env.HW_EXPORT_SPEC_MAX) || 300));

let workerUrl = new URL('./hwExportWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는 가짜 워커로 인라인 경로를 확인한다. */
export function _setHwExportWorkerUrlForTest(url) { workerUrl = url || new URL('./hwExportWorker.js', import.meta.url); }
let lastMode = null;
export const hwExportLastRenderMode = () => lastMode;

/** 워커 입구 — payload = { model, meta }. */
export async function buildHwWorkbookPayload(payload) {
  const p = payload || {};
  return buildHwWorkbook(p.model, p.meta || {});
}

async function renderXlsx(model, meta, signal) {
  const r = await runXlsxWorker({
    workerUrl, payload: { model, meta }, inline: buildHwWorkbookPayload, signal, tag: 'hw-export-xlsx',
    timeoutMs: process.env.HW_EXPORT_XLSX_TIMEOUT_MS ?? 300_000,
    disabled: String(process.env.HW_EXPORT_XLSX_WORKER ?? '1').trim() === '0',
  });
  lastMode = r.mode;
  return r.buffer;
}

/** 모델을 서버 부분집합으로 자른다(법인 · 사양서 나눔용). keep(i) = summary 행 번호. */
export function subsetModel(model, idxs) {
  const set = new Set(idxs);
  const rows = model.summary.rows.filter((_, i) => set.has(i));
  const corpIds = new Set(rows.map((r) => r.corpId));
  // 상세 행은 만든 서버의 번호(si — summary 행 번호와 같다)를 들고 있다.
  const details = model.details.map((d) => ({ ...d, rows: d.rows.filter((r) => set.has(r.si)) }));
  const corps = model.corps.filter((c) => corpIds.has(c.id)).map((c) => {
    const rs = rows.filter((r) => r.corpId === c.id);
    return { ...c, count: rs.length, bm: rs.filter((r) => r.kind === 'bm').length, vh: rs.filter((r) => r.kind === 'vh').length };
  });
  const sumOf = (k) => corps.reduce((a, e) => (e[k] == null ? a : (a || 0) + e[k]), null);
  const specs = Array.isArray(model.specs) ? model.specs.filter((_, i) => set.has(i)) : null;
  const totals = { ...model.totals, servers: rows.length, bm: rows.filter((r) => r.kind === 'bm').length, vh: rows.filter((r) => r.kind === 'vh').length,
    noInventory: rows.filter((r) => /^인벤토리 없음/.test(String(r.cells[r.cells.length - 1] || ''))).length, cores: sumOf('cores'), memGiB: sumOf('memGiB') };
  return { ...model, summary: { ...model.summary, rows }, details, corps, totals, specs };
}

/** 사양서 파일 나눔 계획 — [{ label, idxs }]. 나눌 필요가 없으면 null. */
export function specSplitPlan(model, max = SPEC_MAX) {
  const n = model.summary.rows.length;
  if (!Array.isArray(model.specs) || n <= max) return null;
  const byCorp = new Map();
  model.summary.rows.forEach((r, i) => { const k = r.corpId || ''; if (!byCorp.has(k)) byCorp.set(k, { name: r.corpName, idxs: [] }); byCorp.get(k).idxs.push(i); });
  const plan = [];
  for (const { name, idxs } of byCorp.values()) {
    if (idxs.length <= max) { plan.push({ label: name, idxs }); continue; }
    for (let p = 0; p * max < idxs.length; p++) plan.push({ label: `${name}-${p + 1}`, idxs: idxs.slice(p * max, (p + 1) * max) });
  }
  return plan;
}

const safeFile = (s) => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'part';

/** CSV 표 목록 — [{ name, text }]. band==='sheet' 이면 서버 요약을 법인마다 나눈다. */
export function csvTables(model, band) {
  const lines = (cols, rows) => CSV_BOM + [csvLine(cols.map((c) => c.label)), ...rows.map((r) => csvLine(r.cells.map((v) => (v == null ? '' : v))))].join('\r\n') + '\r\n';
  const sumCols = model.summary.cols;
  const out = [];
  if (band === 'sheet') {
    for (const c of model.corps) out.push({ name: `servers_${safeFile(c.name)}.csv`, text: lines(sumCols, model.summary.rows.filter((r) => r.corpId === c.id)) });
  } else out.push({ name: 'servers.csv', text: lines(sumCols, model.summary.rows) });
  for (const d of model.details) out.push({ name: `${d.file}.csv`, text: lines(d.cols, d.rows) });
  return out;
}

/**
 * @param {object} model @param {{format:'xlsx'|'csv', baseName:string, meta:object, signal?:AbortSignal}} o
 * @returns {Promise<{buffer:Buffer, ext:'xlsx'|'csv'|'zip', mime:string, files:number}>}
 */
export async function renderHwExport(model, { format, baseName, meta, signal = null }) {
  if (format === 'csv') {
    const tables = csvTables(model, meta.band);
    if (tables.length === 1) return { buffer: Buffer.from(tables[0].text, 'utf8'), ext: 'csv', mime: 'text/csv; charset=utf-8', files: 1 };
    const zip = await zipManyAsync(tables.map((t) => ({ name: t.name, data: t.text })));
    return { buffer: zip, ext: 'zip', mime: 'application/zip', files: tables.length };
  }
  const plan = specSplitPlan(model);
  if (!plan) return { buffer: await renderXlsx(model, meta, signal), ext: 'xlsx', mime: XLSX_MIME, files: 1 };
  const note = `사양서가 ${model.summary.rows.length}장이라 파일 하나의 상한(${SPEC_MAX}장)을 넘어 법인마다 파일을 나눴습니다(${plan.length}개). 이 파일은 그 가운데 하나입니다.`;
  const entries = [];
  for (const part of plan) {
    if (signal?.aborted) throw Object.assign(new Error('요청이 끊겨 엑셀 생성을 멈췄습니다.'), { code: 'aborted' });
    const buf = await renderXlsx(subsetModel(model, part.idxs), { ...meta, splitNote: note }, signal);
    entries.push({ name: `${baseName}_${safeFile(part.label)}.xlsx`, data: buf });
  }
  return { buffer: await zipManyAsync(entries), ext: 'zip', mime: 'application/zip', files: entries.length };
}
