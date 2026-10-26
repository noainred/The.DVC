/**
 * v2.792 — vCenter › VM 및 폴더 'VM 목록 엑셀'(폴더 트리 · 시안 https://claude.ai/artifact/MENTpVFxe9D4Y4XgAazpBg 승인).
 *  ① 순수 워크북: 시트 4개 · 폴더 트리(폴더 먼저 · 하위 포함 합계 · 개요 단계 = 깊이, 7 상한 · 요약 행이 위) · 판단 색 · 잔존 빨강 ·
 *     데이터 시트 = CSV 와 같은 열·값 · 이름은 문자열 칸(수식 아님) · 연동 없음이면 Veeam 백업률 '—' · 먼저 볼 VM
 *  ② 워커와 인라인이 같은 내용 · 워커를 못 띄우면 인라인으로
 *  ③ 실제 라우트(POST /veeam/vm-list.xlsx): 200 · 형식·파일 이름 · 409 · operator 403 · 감사
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmxlsx2792-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: VC, name: VC, host: 'vc01.corp.local', username: 'u', password: 'p' }] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

// 동적 import 는 전부 여기서(테스트 정의 사이 top-level await 금지)
const X = await import('../src/veeam/vmListXlsx.js');
const L = await import('../src/veeam/vmListCsv.js');
const { parseCsvRows } = await import('../src/util/csv.js');
const R = await import('../src/veeam/registry.js');
const VS = await import('../src/veeam/store.js');
const { listAudit } = await import('../src/audit.js');
const EB = await import('../src/util/exportBusy.js');
const ExcelJS = (await import('exceljs')).default;
const express = (await import('express')).default;
const { store } = await import('../src/store.js');
const { registerVeeamBadges } = await import('../src/routes/api/veeam.js');

const H = 3_600_000;
const AT = Math.floor(Date.now() / H) * H;
const load = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
const argb = (cell) => cell.fill?.fgColor?.argb || '';
const text = (cell) => (cell.value && typeof cell.value === 'object' && cell.value.richText ? cell.value.richText.map((x) => x.text).join('') : cell.value);

function sampleRows() {
  const veeam = { state: 'ok', jobs: ['Daily'], rp: 14, lb: AT - 5 * H, lastResult: 'Success' };
  const mk = (name, folder, extra = {}) => ({
    inv: { name, host: 'esx01', ipAddress: '10.0.0.1', snapshotCount: 0, ...(extra.inv || {}) },
    view: { id: name, name, folder, power: extra.power || 'POWERED_ON', ...('v' in extra ? (extra.v === undefined ? {} : { v: extra.v }) : { v: veeam }), s: { ev: 'ev' in extra ? extra.ev : null, now: extra.now || null } },
  });
  const deep = 'L1/L2/L3/L4/L5/L6/L7/L8/L9';
  return [
    mk('web-02', 'Production/Web'),
    mk('web-01', 'Production/Web', { v: null }),                                         // 확인 안 됨
    mk('db-ora', 'Production/DB', { v: null, now: { n: 1, ts: AT - 50 * H, stale: true } }), // 잔존(흔적 아님) → 확인 안 됨 + 잔존
    mk('batch', 'Production'),
    mk('dev-1', 'Dev', { v: null, ev: { ts: AT - 2 * H, n: 3 } }),                       // 스냅샷만
    mk('dev-2', 'Dev', { v: undefined }),                                                // Veeam 모름 → 모름
    mk('=HYPERLINK("x")', 'vm'),                                                         // 최상위 · 수식 모양 이름
    mk('deep-vm', deep),
    mk('tmpl', 'Templates', { v: null, inv: { template: true }, power: 'POWERED_OFF' }),
  ];
}

test('① 순수 워크북 — 폴더 트리·개요·색·데이터 시트 = CSV', async () => {
  const rows = sampleRows();
  const out = await X.buildVmListWorkbook({ vcName: 'apac-vc01', rows, linked: true, snapDays: 7, offsetMin: 540, cond: '전체 VM 9대', at: AT });
  assert.equal(out.rows, 9);
  assert.equal(out.outlineLevels, 7, '개요는 7단계 상한');
  const wb = await load(out.buffer);
  assert.deepEqual(wb.worksheets.map((s) => s.name), [...X.VM_XLSX_SHEETS]);

  // ② 폴더 트리
  const ts = wb.getWorksheet('VM 목록(폴더 트리)');
  assert.deepEqual(ts.properties.outlineProperties, { summaryBelow: false, summaryRight: false }, '폴더(요약) 행이 하위 행 위 — −/+ 가 폴더 행에 붙는다');
  const lines = [];
  for (let r = 4; r <= ts.rowCount; r++) { const row = ts.getRow(r); lines.push([row.outlineLevel || 0, String(text(row.getCell(1)))]); }
  const names = lines.map((x) => x[1]);
  assert.ok(names.indexOf('📁 Production  (4)') < names.indexOf('📁 DB  (1)') && names.indexOf('📁 DB  (1)') < names.indexOf('📁 Web  (2)'), '폴더 이름 순');
  assert.ok(names.indexOf('📁 Web  (2)') < names.indexOf('batch'), '같은 단계에서 하위 폴더 먼저, 그다음 VM');
  assert.ok(names.indexOf('web-01') < names.indexOf('web-02'), 'VM 이름 순');
  assert.equal(names.at(-1), '=HYPERLINK("x")', '최상위 VM 은 폴더 뒤');
  const lv = Object.fromEntries(lines.map(([l, n]) => [n, l]));
  assert.deepEqual([lv['📁 Production  (4)'], lv['📁 Web  (2)'], lv['web-01'], lv.batch, lv['=HYPERLINK("x")']], [0, 1, 2, 1, 0]);
  assert.equal(lv['📁 L9  (1)'], 7, '깊이 8 폴더도 7단계에 모인다');
  assert.equal(lv['deep-vm'], 7);
  const prodRow = ts.getRow(4 + names.indexOf('📁 Production  (4)'));
  assert.equal(text(prodRow.getCell(2)), 'VM 4 · Veeam 2 · 확인 안 됨 2', '하위 포함 합계 · 0 인 판단은 뺀다');
  assert.equal(text(prodRow.getCell(5)), `Veeam 50% ${X.barText(0.5)}`);
  assert.equal(text(prodRow.getCell(7)), '잔존 1');
  const vmRow = (n) => ts.getRow(4 + names.indexOf(n));
  assert.equal(argb(vmRow('web-02').getCell(3)), X.VERDICT_STYLE.veeam.bg);
  assert.equal(argb(vmRow('web-01').getCell(3)), X.VERDICT_STYLE.none.bg);
  assert.equal(argb(vmRow('dev-1').getCell(3)), X.VERDICT_STYLE.snap.bg);
  assert.equal(argb(vmRow('dev-2').getCell(3)), X.VERDICT_STYLE.unknown.bg);
  assert.equal(text(vmRow('db-ora').getCell(3)), '확인 안 됨', '하루 넘은 잔존은 백업 흔적이 아니다');
  assert.equal(text(vmRow('db-ora').getCell(7)), '1개 · 잔존 2일째');
  assert.equal(argb(vmRow('db-ora').getCell(7)), X.VERDICT_STYLE.stale.bg);
  assert.equal(vmRow('=HYPERLINK("x")').getCell(1).type, ExcelJS.ValueType.String, '수식 모양 이름도 문자열 칸');

  // ③ 데이터 시트 = CSV 와 같은 열·값
  const ds = wb.getWorksheet('데이터(행 단위)');
  const csv = parseCsvRows(L.vmListCsv({ vcName: 'apac-vc01', rows, linked: true, snapDays: 7, offsetMin: 540 }).replace(/^﻿/, ''));
  assert.deepEqual(ds.getRow(1).values.slice(1), csv[0], '머리 = CSV 머리(폴더 1~9단계 · 폴더 경로 포함)');
  assert.ok(csv[0].includes('폴더 9단계'));
  assert.ok(ds.autoFilter, '자동 필터');
  const iVm = csv[0].indexOf('VM');
  const dsByName = new Map(); for (let r = 2; r <= ds.rowCount; r++) { const v = ds.getRow(r).values.slice(1); dsByName.set(v[iVm], v); }
  for (const c of csv.slice(1)) {
    const name = c[iVm].replace(/^'/, '');   // CSV 는 수식 가드(') — 엑셀은 문자열 칸이라 붙이지 않는다
    const x = dsByName.get(name);
    assert.ok(x, name);
    assert.deepEqual(c.map((v, i) => (i === iVm ? name : v)), csv[0].map((_, i) => (x[i] == null ? '' : String(x[i]))), `행 값이 같다: ${name}`);
  }

  // ① 요약 · 먼저 볼 VM
  const ss = wb.getWorksheet('요약');
  const all = []; ss.eachRow((row) => all.push(row.values.slice(1).map((v) => (v && typeof v === 'object' && v.richText ? v.richText.map((y) => y.text).join('') : v))));
  const kpi = all.find((r) => r[0] === '핵심 수'); const kv = all[all.indexOf(kpi) + 1];
  assert.deepEqual(kpi.slice(1, 7), ['VM', 'Veeam 백업', '스냅샷 흔적만', '확인 안 됨', '모름', '임시 스냅샷 잔존']);
  assert.deepEqual(kv.slice(1, 7), [9, 4, 1, 3, 1, 1]);
  const watch = all.filter((r) => ['확인 안 됨', '잔존 스냅샷', '모름'].includes(r[1])).map((r) => `${r[1]}:${r[0]}`);
  assert.deepEqual(watch, ['확인 안 됨:web-01', '잔존 스냅샷:db-ora', '모름:dev-2'], '템플릿(tmpl)은 빼고 · 확인 안 됨 → 잔존 → 모름 순');

  // 연동 없음 — Veeam 백업률은 0% 가 아니라 '—'
  const un = await load((await X.buildVmListWorkbook({ vcName: 'vc', rows: rows.map((r) => ({ ...r, view: { ...r.view, v: null } })), linked: false, at: AT })).buffer);
  const uts = un.getWorksheet('VM 목록(폴더 트리)');
  const folderRow = []; uts.eachRow((row) => { if (String(text(row.getCell(1))).startsWith('📁 Production')) folderRow.push(text(row.getCell(5))); });
  assert.deepEqual(folderRow, ['Veeam 연동 없음']);
  assert.equal(X.veeamRate({ veeam: 0, vKnown: 0 }, true), null, '아는 VM 0대면 모름');
});

test('② 워커와 인라인이 같은 내용 · 워커를 못 띄우면 인라인', async () => {
  const input = { vcName: 'apac-vc01', rows: sampleRows(), linked: true, snapDays: 7, offsetMin: 540, cond: '전체 VM', at: AT };
  const w = await X.renderVmListWorkbook(input);
  assert.equal(w.mode, 'worker');
  const prev = process.env.VM_LIST_XLSX_WORKER;
  process.env.VM_LIST_XLSX_WORKER = '0';
  let i;
  try { i = await X.renderVmListWorkbook(input); } finally { if (prev === undefined) delete process.env.VM_LIST_XLSX_WORKER; else process.env.VM_LIST_XLSX_WORKER = prev; }
  assert.equal(i.mode, 'inline');
  const [a, b] = [await load(w.buffer), await load(i.buffer)];
  for (const name of X.VM_XLSX_SHEETS) {
    const va = []; a.getWorksheet(name).eachRow((r) => va.push(JSON.stringify(r.values)));
    const vb = []; b.getWorksheet(name).eachRow((r) => vb.push(JSON.stringify(r.values)));
    assert.deepEqual(va, vb, name);
  }
  X._setVmListXlsxWorkerUrlForTest(new URL('data:text/javascript,throw new Error("boom")'));
  try {
    const f = await X.renderVmListWorkbook(input);
    assert.deepEqual([f.mode, f.reason], ['inline', 'spawn-failed']);
  } finally { X._setVmListXlsxWorkerUrlForTest(null); }
  // 워커로 보내는 행은 열이 쓰는 필드만(메모 같은 큰 필드를 복제하지 않는다)
  const slim = X.slimVmRows([{ inv: { name: 'a', notes: 'x'.repeat(1000), nics: [1, 2] }, view: { id: 'a' } }]);
  assert.deepEqual(slim[0].inv, { name: 'a' });
});

test('③ 실제 라우트 — 엑셀 200 · 파일 이름 · 409 · operator 403 · 감사', async () => {
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'Daily', type: 'Backup', lastResult: 'Success' }], vms: [{ n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 }] });
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: AT, vcenters: [{ id: VC, name: VC }], hosts: [], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'Production/Web', powerState: 'POWERED_ON', snapshotCount: 0 },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'Production/DB', powerState: 'POWERED_ON', snapshotCount: 1, veeamSnaps: 1, veeamSnapTs: AT - H },
    { id: `${VC}:vm-3`, vcenterId: VC, name: 'old01', folder: 'vm', powerState: 'POWERED_OFF' },
  ] };
  let user = { username: 'adm', role: 'admin', scope: {} };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerVeeamBadges(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const post = (body) => fetch(`${base}/veeam/vm-list.xlsx?vcenterId=${encodeURIComponent(VC)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    let r = await post({ ids: [`${VC}:vm-1`, `${VC}:vm-2`], view: 'search' });
    assert.equal(r.status, 200, await r.clone().text());
    assert.equal(r.headers.get('content-type'), X.XLSX_MIME);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="vm-list-apac_vc01-search-\d{8}-\d{4}\.xlsx"/);
    const wb = await load(Buffer.from(await r.arrayBuffer()));
    assert.deepEqual(wb.worksheets.map((s) => s.name), [...X.VM_XLSX_SHEETS]);
    const sub = String(wb.getWorksheet('요약').getRow(2).getCell(1).value);
    assert.match(sub, /화면 조건: 검색 결과 2대/);
    assert.match(sub, /Veeam: 연결됨\(서버 1대\)/);
    const names = []; wb.getWorksheet('VM 목록(폴더 트리)').eachRow((row, n) => { if (n > 3) names.push(String(text(row.getCell(1)))); });
    assert.deepEqual(names, ['📁 Production  (2)', '📁 DB  (1)', 'db01', '📁 Web  (1)', 'web01']);

    r = await post({ power: 'noOff' });
    assert.match(r.headers.get('content-disposition'), /-poweredon-\d{8}-\d{4}\.xlsx"/);
    await r.arrayBuffer();

    const lock = EB.acquireExport('vm-list.xlsx', { user: { username: 'other' } });
    try { assert.equal((await post({})).status, 409); } finally { lock.release(); }
    const au = listAudit({ limit: 50 });
    const rows = (Array.isArray(au) ? au : au.rows || au.items || []).filter((x) => x.action === 'vm-list.xlsx');
    assert.ok(rows.some((x) => x.target === VC && /^2 rows · search · 화면 목록$/.test(x.detail)), JSON.stringify(rows.slice(0, 3)));
    user = { username: 'op', role: 'operator', scope: {} };
    assert.equal((await post({})).status, 403);
  } finally { store.snapshot = prev; }
});
