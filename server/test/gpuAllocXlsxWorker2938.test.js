/**
 * gpuAllocXlsxWorker2938.test.js — GPU 할당 엑셀은 공용 엑셀 워커에서 만든다(v2.938 · 감사 A5-05 '메인 스레드 블록' 해결).
 *  ① 기본 경로가 워커이고 결과 시트가 인라인과 같다 ② 워커를 띄우지 못하면 메인에서 만든다(예전 동작) ③ 끄는 길 env ④ 라우트가 이 함수를 쓴다
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import * as X from '../src/gpu/allocTreeXlsx.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tree = { vcenters: [{ id: 'vc1', name: '서울', city: 'Seoul', country: 'KR', datacenters: [], hosts: [], totals: {} }], hosts: [], totals: {}, truncated: 0 };
const meta = { stamp: '2026-11-07 18:40', tz: 'KST', scopeText: '전체 법인' };
const sheetsOf = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb.worksheets.map((w) => w.name); };

test('① 기본은 워커 — 결과 시트가 인라인과 같다', async () => {
  const opt = { sheets: ['tree', 'flat', 'info'] };
  const viaWorker = await X.renderGpuAllocWorkbook(tree, meta, opt);
  assert.equal(X.gpuAllocLastRenderMode(), 'worker');
  const inline = await X.buildGpuAllocWorkbookInline(tree, meta, opt);
  assert.deepEqual(await sheetsOf(viaWorker), await sheetsOf(inline));
});

test('② 워커를 띄우지 못하면 메인에서 만든다 · ③ GPU_ALLOC_XLSX_WORKER=0 은 인라인', async () => {
  X._setGpuAllocXlsxWorkerUrlForTest(new URL('file:///nonexistent/worker-2938.js'));
  try {
    const buf = await X.renderGpuAllocWorkbook(tree, meta, { sheets: ['tree', 'info'] });
    assert.equal(X.gpuAllocLastRenderMode(), 'inline');
    assert.deepEqual(await sheetsOf(buf), [X.ALLOC_XLSX_SHEETS[0], X.ALLOC_XLSX_SHEETS[2]]);
  } finally { X._setGpuAllocXlsxWorkerUrlForTest(null); }
  process.env.GPU_ALLOC_XLSX_WORKER = '0';
  try { await X.renderGpuAllocWorkbook(tree, meta, { sheets: ['info'] }); assert.equal(X.gpuAllocLastRenderMode(), 'inline'); }
  finally { delete process.env.GPU_ALLOC_XLSX_WORKER; }
});

test('④ 라우트는 renderGpuAllocWorkbook(워커) 을 쓴다 · 워커 파일은 같은 조립 함수를 쓴다', () => {
  const route = fs.readFileSync(path.resolve(HERE, '../src/routes/api/hardwareGpu.js'), 'utf8');
  assert.match(route, /await renderGpuAllocWorkbook\(/);
  assert.doesNotMatch(route, /buildGpuAllocWorkbookInline/);
  const w = fs.readFileSync(path.resolve(HERE, '../src/gpu/allocTreeXlsxWorker.js'), 'utf8');
  assert.match(w, /serveXlsxWorker\(parentPort, buildGpuAllocWorkbookPayload\)/);
});
