/**
 * v2.782(점검 K4 B-B3) 회귀: vCenter 하나에 Veeam 서버가 여러 대일 때, 그중 한 대가 **첫 수집 전(waiting)** 이거나
 *   **한 번도 성공하지 못했으면(failedNoLast)** 그 서버가 맡은 VM 은 대조 결과에 없다 — 그 부재는 '없음' 이 아니라 모름이다.
 *  · backupRow: 나눔(둘 다/한쪽만/확인 안 됨)은 모름(split null) · 행에 veeamAbsentUnknown 표지 · 맞은 VM 수(veeam)·결과는 하한으로 그대로
 *  · vmBackupView(absentKnown:false): 맞지 않은 VM 만 v 모름(키 없음) — 맞은 VM 은 값 유지 · 'none' 보기에 들지 않는다
 *  · 오래된(stale) 서버는 마지막 결과가 있으므로 이 규칙에 넣지 않는다 · 서버 1대 정상 경로의 '없음'(v null)은 그대로(backupMenu2779 A-4·B)
 *  · 라우트(backup-summary·backup-detail): 두 번째 서버가 첫 수집 전이면 split null · 맞지 않은 VM 은 v 키 없음
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2782d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/backupStatus.js');
const B = await import('../src/veeam/backupCounts.js');
const { matchToVcenter } = await import('../src/veeam/parse.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const vc = { id: 'vc1', host: 'vc1.corp' };
const vms = Array.from({ length: 4 }, (_, i) => ({ id: `vc1:vm-${i}`, name: `vm${i}`, vcenterId: 'vc1' }));
// 서버 A 만 결과가 있고 vm-0 하나만 맡는다
const resA = [{ server: { id: 's1', name: 'A' }, result: { ok: true, ts: NOW, jobs: [{ name: 'J', type: 'Backup', lastResult: 'Success' }], vms: [{ m: 'vm-0', n: 'vm0', h: 'vc1.corp', j: [0], lb: NOW - HOUR }] } }];
const ev = { status: 'ok', byVm: {}, collectedAt: NOW, accounts: 1, events: 0 };

function build(views) {
  const match = matchToVcenter(vc, vms, resA);
  const vcnt = B.veeamCount({ views, byVm: match.byVm, vmTotal: vms.length });
  const sc = B.snapCount({ ev, vms, now: NOW });
  const row = S.backupRow({ vms, linked: true, vcnt, match, sc, ev, now: NOW });
  const view = vms.map((vm) => S.vmBackupView(vm, match.byVm[vm.id], ev.byVm[vm.id], { veeamKnown: row.veeam != null, snapKnown: row.snap != null, absentKnown: !row.veeamAbsentUnknown, now: NOW }));
  return { match, vcnt, row, view };
}

for (const [label, second] of [['첫 수집 전(waiting)', { ok: null, lastOkTs: null }], ['한 번도 성공 못 함(failedNoLast)', { ok: false, lastOkTs: null }]]) {
  test(`B-B3 서버 2대 중 1대가 ${label} — 맞지 않은 VM 은 '없음' 이 아니라 모름`, () => {
    const { row, view } = build([{ ok: true, lastOkTs: NOW }, second]);
    assert.equal(row.veeam, 1, '맞은 VM 수는 하한으로 그대로');
    assert.equal(row.veeamState, 'partial');
    assert.equal(row.split, null, '나눔(확인 안 됨 수)은 모름');
    assert.equal(row.veeamAbsentUnknown, true);
    const j = JSON.parse(JSON.stringify(view));
    assert.equal(typeof j[0].v, 'object', '맞은 VM 은 값 유지');
    assert.ok(j[0].v && j[0].v.state === 'ok' && j[0].v.jobs.length === 1);
    for (const x of j.slice(1)) assert.equal('v' in x, false, `${x.name} — 맞지 않은 VM 은 v 키 없음(모름)`);
    assert.deepEqual(j.filter((x) => S.vmViewMatches(x, 'none', { now: NOW })).map((x) => x.name), [], "'none' 보기에 들지 않는다");
    assert.equal(S.vmViewMatches(j[0], 'veeam', { now: NOW }), true);
    const t = S.backupTotals([row]);
    assert.deepEqual([t.none, t.splitUnknown, t.veeam], [0, 1, 1]);
  });
}

test('B-B3 오래된(stale) 서버·실패했지만 마지막 성공이 있는 서버는 이 규칙에 넣지 않는다 — 마지막 결과가 있다', () => {
  for (const second of [{ ok: true, lastOkTs: NOW - 10 * HOUR, stale: true }, { ok: false, lastOkTs: NOW - HOUR }]) {
    const { row, view } = build([{ ok: true, lastOkTs: NOW }, second]);
    assert.equal(row.veeamAbsentUnknown, undefined);
    assert.deepEqual(row.split, { both: 0, vOnly: 1, sOnly: 0, none: 3 });
    assert.equal(view[1].v, null, '없음(확정)');
  }
});

test('B-B3 서버 1대 정상 — 지금과 같이 없음(v null) · vmBackupView 기본값은 absentKnown true', () => {
  const { row, view } = build([{ ok: true, lastOkTs: NOW }]);
  assert.equal(row.veeamAbsentUnknown, undefined);
  assert.deepEqual(row.split, { both: 0, vOnly: 1, sOnly: 0, none: 3 });
  assert.equal(view[2].v, null);
  assert.equal(S.vmBackupView({ id: 'x', name: 'x' }, undefined, undefined, { now: NOW }).v, null, '기본값 = 없음 확정');
  assert.equal(S.vmBackupView({ id: 'x', name: 'x' }, undefined, undefined, { absentKnown: false, now: NOW }).v, undefined);
  assert.equal(S.vmBackupView({ id: 'x', name: 'x' }, undefined, undefined, { veeamKnown: false, absentKnown: true, now: NOW }).v, undefined, 'Veeam 모름이면 absentKnown 과 무관하게 모름');
});

test('B-B3 라우트 — 두 번째 서버가 첫 수집 전이면 서머리 split null · 세부내용 맞지 않은 VM 은 v 키 없음', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const a = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc', password: 'p1', vcenterIds: [VC] });
  R.saveServer({ name: 'VBR-B', host: 'vbr-b.corp.local', username: 'svc', password: 'p2', vcenterIds: [VC] });   // 결과 없음 = 첫 수집 전
  VS.putResult(a.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J-web', type: 'Backup' }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 },
  ] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [{ id: VC, name: 'vc01' }], vms: [
    { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC1/vm', powerState: 'POWERED_ON' },
    { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC1/vm', powerState: 'POWERED_ON' },
  ], hosts: [] };
  const app = express();
  app.use((req, _res, next) => { req.user = { username: 'a', role: 'admin' }; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const sum = await (await fetch(`${base}/tools/backup-summary`)).json();
    const row = sum.rows.find((r) => r.id === VC);
    assert.equal(row.veeamServers, 2);
    assert.equal(row.veeam, 1);
    assert.equal(row.split, null, JSON.stringify(row));
    assert.equal(sum.totals.none, 0);
    const det = await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
    const web = det.vms.find((x) => x.name === 'web01'); const db = det.vms.find((x) => x.name === 'db01');
    assert.equal(typeof web.v, 'object'); assert.ok(web.v);
    assert.equal('v' in db, false, '첫 수집 전 서버가 맡았을 수 있다 — 모름');
    const csv = await (await fetch(`${base}/tools/backup-detail.csv?vcenterId=${encodeURIComponent(VC)}&filter=none`)).text();
    assert.equal(csv.split('\r\n').length, 1, "CSV 'none' 보기에도 들지 않는다");
  } finally { store.snapshot = prev; }
});
