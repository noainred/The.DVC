/** Render the per-/24 IP ledger to a coloured .xlsx workbook (one sheet/subnet). */

import { Worker } from 'node:worker_threads';
import ExcelJS from 'exceljs';
import { createYielder } from '../util/timeSlice.js';
import { deadlineMs } from '../util/deadline.js';

const FILL = {
  used: 'FFD9F2D9',       // light green
  multihomed: 'FFD6E4FF', // light blue
  duplicate: 'FFF8D7DA',  // light red
  network: 'FFE2E2E2',    // grey
  empty: null,
};

/**
 * @param {Array} sheets buildSubnetSheets 결과(또는 slimSheet 로 줄인 것 — 아래 9개 행 필드와 subnet·base·used 만 읽는다)
 * @param {object} [opts]
 * @param {number|Date} [opts.created] 문서 생성 시각(created·modified 둘 다). 없으면 예전처럼 지금 시각(modified 는 exceljs 가 쓰는 시각)
 */
export async function buildWorkbook(sheets, opts = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VMware Global Monitoring Portal';
  const fixed = opts.created != null ? new Date(opts.created) : null;
  wb.created = fixed && Number.isFinite(fixed.getTime()) ? fixed : new Date();
  if (fixed && Number.isFinite(fixed.getTime())) wb.modified = fixed;

  // 서브넷 수백 개 × 256행 × 9열(수십만 셀) 동기 생성이 이벤트 루프를 세우던 것 완화 —
  // v2.741(LEFT-01): '4시트마다' 대신 시간 기준(15ms)으로 양보한다(util/timeSlice.js — 개수 기준 양보는 한 건이 느리면 막지 못한다).
  // 결과물은 같다. ⚠ 이 함수의 진짜 정지는 시트 조립이 아니라 `wb.xlsx.write`(XML 직렬화 — 동기)였다 — 라우트는 renderIpamWorkbook(워커)을 쓴다.
  const maybeYield = createYielder(15);
  for (const s of sheets) {
    await maybeYield();
    const name = s.subnet.replace(/[\\/?*[\]:]/g, '_').slice(0, 31);
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 2 }] });
    ws.columns = [
      { header: `${s.base}.X`, key: 'ip', width: 18 },
      { header: 'Purpose', key: 'purpose', width: 34 },
      { header: 'Hostname', key: 'hostname', width: 40 },
      { header: '서버종류', key: 'serverType', width: 10 },
      { header: 'OS', key: 'os', width: 26 },
      { header: '메모(Notes)', key: 'notes', width: 28 },
      { header: '전원', key: 'power', width: 7 },
      { header: '분류', key: 'scope', width: 8 },
      { header: '상태', key: 'status', width: 10 },
    ];
    // Title row
    ws.spliceRows(1, 0, [`VLAN — ${s.subnet}`, `사용 ${s.used}/255`]);
    ws.mergeCells('A1:I1');
    const title = ws.getCell('A1');
    title.font = { bold: true, size: 12 };
    title.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC000' } };
    ws.getRow(2).font = { bold: true };
    ws.getRow(2).eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3D9C9' } }; });

    const label = { used: '사용', multihomed: '멀티홈', duplicate: '중복', network: 'Network ID', empty: '' };
    for (const r of s.rows) {
      const row = ws.addRow({ ip: r.ip, purpose: r.purpose, hostname: r.hostname, serverType: r.serverType, os: r.os, notes: r.notes, power: r.power, scope: r.scope, status: label[r.status] });
      const argb = FILL[r.status];
      if (argb) row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } }; });
    }
  }
  if (sheets.length === 0) wb.addWorksheet('empty');
  return wb;
}

/*
 * v2.741(감사 LEFT-01 — 재현): `/tools/ipam.xlsx` 는 워크북을 메인 스레드에서 조립·직렬화했다. 조립은 4시트마다 양보했지만
 *   `wb.xlsx.write`(시트 XML 직렬화)는 양보 지점이 없어 **시트 수에 비례해 포탈 전체가 멈췄다** — 합성 /24 100개 1.6초, 400개 6초대
 *   (scratchpad 재현 xlsx_stall.mjs). exceljs 의 직렬화는 우리가 쪼갤 수 없는 동기 코드라 '사이에 양보' 로는 해결되지 않는다 —
 *   그래서 **조립과 직렬화를 통째로 워커 스레드(excelWorker.js)로 옮긴다**. 메인 스레드는 ① 시트를 워커가 쓰는 필드만 남겨(slimSheet)
 *   시간 기준 양보를 하며 시트 단위로 보내고 ② 완성된 파일 바이트(ArrayBuffer — 복사 없이 넘겨받는다)를 받는다.
 *   · 결과 파일은 같다 — 워커가 같은 buildWorkbook 을 돈다. 테스트가 압축을 풀어 항목별로 인라인 판과 대조한다.
 *   · 워커를 띄우지 못했으면(모듈 적재 실패 등 — 'ready' 전에 죽음) 인라인으로 만든다(예전 동작 · 정지는 남는다) — 콘솔에 남긴다.
 *     'ready' 뒤의 실패는 인라인으로 다시 하지 않는다(같은 입력이면 같은 오류이고, 메모리 부족이면 메인 프로세스를 죽인다).
 *   · 워커의 힙은 메인과 따로다 — 큰 워크북이 메모리를 넘기면 워커만 끝난다(v2.575 처럼 포탈이 죽지 않는다).
 *   · 내보낼 때마다 새 워커를 띄우고 끝나면 끝낸다(동시 1건 가드 — exportBusy 가 동시 실행을 막는다). 받을 사람이 떠나면(signal) 끝낸다.
 *   · 끄는 길: env `IPAM_XLSX_WORKER=0`(인라인). 시한: `IPAM_XLSX_TIMEOUT_MS`(기본 10분 · deadlineMs 가 [1초, 2시간] 으로 자른다).
 */

/** 워커가 쓰는 필드만 남긴다 — 원장 시트 행은 owner(스냅샷 VM 객체)·태그 등을 실어 그대로 복제하면 메인 스레드가 오래 멈춘다. */
export function slimSheet(s) {
  const rows = Array.isArray(s?.rows) ? s.rows : [];
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    out[i] = { ip: r.ip, purpose: r.purpose, hostname: r.hostname, serverType: r.serverType, os: r.os, notes: r.notes, power: r.power, scope: r.scope, status: r.status };
  }
  return { subnet: s?.subnet, base: s?.base, used: s?.used, rows: out };
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 60_000; // 워커 기동(exceljs 적재) 시한 — 넘으면 띄우지 못한 것으로 보고 인라인
let _xlsxWorkerUrl = new URL('./excelWorker.js', import.meta.url);
/** 테스트 전용 — 띄우지 못하는·답하지 않는 가짜 워커로 실패 경로를 확인한다(운영 경로는 쓰지 않는다). */
export function _setXlsxWorkerUrlForTest(url) { _xlsxWorkerUrl = url || new URL('./excelWorker.js', import.meta.url); }

const xlsxWorkerEnabled = () => String(process.env.IPAM_XLSX_WORKER ?? '1').trim() !== '0';

function codedError(code, message) { const e = new Error(message); e.code = code; return e; }

async function renderInline(sheets, created) {
  const wb = await buildWorkbook(sheets, { created });
  const buf = await wb.xlsx.writeBuffer();
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
}

/**
 * 시트 배열 → .xlsx 파일 바이트. 워커에서 조립·직렬화한다(위 설명).
 * @param {Array} sheets buildSubnetSheets(Async) 결과
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] abort 되면 워커를 끝내고 code 'aborted' 로 던진다
 * @param {number} [opts.created] 문서 생성 시각(ms) — 기본 지금
 * @param {number} [opts.timeoutMs] 기본 env IPAM_XLSX_TIMEOUT_MS 또는 10분
 * @param {number} [opts.sliceMs=15] 시트를 보내는 동안 이만큼 연속으로 돌았으면 양보
 * @returns {Promise<{buffer: Buffer, mode: 'worker'|'inline', reason?: string, sheets: number}>}
 */
export async function renderIpamWorkbook(sheets, opts = {}) {
  const list = Array.isArray(sheets) ? sheets : [];
  const created = Number.isFinite(opts.created) ? opts.created : Date.now();
  const signal = opts.signal || null;
  if (signal?.aborted) throw codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
  if (!xlsxWorkerEnabled()) return { buffer: await renderInline(list, created), mode: 'inline', reason: 'disabled', sheets: list.length };
  const timeoutMs = deadlineMs(opts.timeoutMs ?? process.env.IPAM_XLSX_TIMEOUT_MS ?? 600_000, DEFAULT_TIMEOUT_MS);
  let worker;
  try {
    worker = new Worker(_xlsxWorkerUrl);
  } catch (err) {
    console.warn(`[ipam] 엑셀 워커를 띄우지 못했습니다(${err.message}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return { buffer: await renderInline(list, created), mode: 'inline', reason: 'spawn-failed', sheets: list.length };
  }
  let ready = false;
  let settled = false;
  let onReady = null;
  let timer = null;
  let readyTimer = null;
  const outcome = await new Promise((resolve) => {
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(readyTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      worker.removeAllListeners('message'); worker.removeAllListeners('error'); worker.removeAllListeners('exit');
      worker.on('error', () => {}); // 끝낸 뒤 늦게 오는 오류가 처리되지 않은 이벤트로 프로세스를 죽이지 않게
      worker.terminate().catch(() => {});
      resolve(v);
    };
    const onAbort = () => finish({ err: codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.') });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    readyTimer = setTimeout(() => finish({ startFailed: `기동 ${Math.round(READY_TIMEOUT_MS / 1000)}초 안에 준비되지 않음` }), READY_TIMEOUT_MS);
    timer = setTimeout(() => finish({ err: codedError('timeout', `엑셀 생성이 ${Math.round(timeoutMs / 1000)}초 안에 끝나지 않아 멈췄습니다.`) }), timeoutMs);
    worker.on('message', (msg) => {
      if (msg?.type === 'ready') { ready = true; clearTimeout(readyTimer); if (onReady) onReady(); return; }
      if (msg?.type === 'done' && msg.buf instanceof ArrayBuffer) return finish({ buffer: Buffer.from(msg.buf) });
      if (msg?.type === 'error') return finish({ err: codedError('worker-error', `엑셀 생성 실패: ${String(msg.message || '알 수 없는 오류').slice(0, 300)}`) });
    });
    worker.on('error', (err) => {
      if (!ready) return finish({ startFailed: err?.message || String(err) });
      const oom = err?.code === 'ERR_WORKER_OUT_OF_MEMORY';
      finish({ err: codedError(oom ? 'worker-oom' : 'worker-error', oom ? '엑셀 워커가 메모리 한도를 넘어 끝났습니다(포탈은 영향 없음) — vCenter 를 골라 범위를 줄여 다시 시도하세요.' : `엑셀 워커 오류: ${String(err?.message || err).slice(0, 300)}`) });
    });
    worker.on('exit', (code) => {
      if (!ready) return finish({ startFailed: `기동 중 종료(코드 ${code})` });
      finish({ err: codedError('worker-exit', `엑셀 워커가 결과 없이 끝났습니다(코드 ${code}).`) });
    });
    // 준비되면 시트를 보낸다 — 워커가 쓰는 필드만, 시트 단위 메시지, 시간 기준 양보(복제는 postMessage 안에서 동기다).
    onReady = async () => {
      try {
        const maybeYield = createYielder(Number.isFinite(opts.sliceMs) && opts.sliceMs > 0 ? opts.sliceMs : 15);
        for (const s of list) {
          if (settled) return;
          worker.postMessage({ type: 'sheet', sheet: slimSheet(s) });
          await maybeYield();
        }
        if (!settled) worker.postMessage({ type: 'end', created, total: list.length });
      } catch (err) {
        finish({ err: codedError('worker-error', `엑셀 워커로 보내지 못했습니다: ${String(err?.message || err).slice(0, 300)}`) });
      }
    };
  });
  if (outcome.startFailed != null) {
    if (signal?.aborted) throw codedError('aborted', '요청이 끊겨 엑셀 생성을 멈췄습니다.');
    console.warn(`[ipam] 엑셀 워커를 띄우지 못했습니다(${outcome.startFailed}) — 메인 스레드에서 만듭니다(그동안 포탈 응답이 멈출 수 있습니다).`);
    return { buffer: await renderInline(list, created), mode: 'inline', reason: 'spawn-failed', sheets: list.length };
  }
  if (outcome.err) throw outcome.err;
  return { buffer: outcome.buffer, mode: 'worker', sheets: list.length };
}
