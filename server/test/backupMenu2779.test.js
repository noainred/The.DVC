/**
 * v2.779 — '백업' 메뉴(사용자 요청: 백업 서머리 = 전체 vCenter · 백업 세부내용 = vCenter 하나의 폴더 › VM · Veeam 과 스냅샷 둘 다).
 *  · 판정(순수, veeam/backupStatus.js): VM 단위로 두 기준을 합친다 — 스냅샷 수는 카드(snapCount)와 같다 · 못 읽은 쪽은 0 이 아니라 모름 ·
 *    한쪽을 모르면 '둘 다/한쪽만/확인 안 됨' 도 모름 · 연동 없는 vCenter 의 Veeam 은 모름이 아니라 '없음' · 하루 넘은 임시 스냅샷은 따로 센다.
 *  · 라우트: 범위 밖 vCenter 는 서머리에서 빠지고 세부내용은 404 · 실행 중 작업 이름은 관리자만 · 비밀·원문 없음 · 도구 키 집행 표에 등록.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'backup2779-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음
const OUT = 'us:vc04';    // 범위 밖
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
  { id: SN, name: 'vc02', host: 'vc02.corp.local', username: 'u', password: 'p' },
  { id: OUT, name: 'vc04', host: 'vc04.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/backupStatus.js');
const B = await import('../src/veeam/backupCounts.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

const vms = [
  { id: 'v:1', name: 'a' }, { id: 'v:2', name: 'b' }, { id: 'v:3', name: 'c', veeamSnaps: 1, veeamSnapTs: NOW - HOUR },
  { id: 'v:4', name: 'd', veeamSnaps: 1, veeamSnapTs: NOW - 30 * HOUR }, { id: 'v:5', name: 'e' },
];
// 라우트의 snapEventsFor 는 지금 인벤토리에 있는 VM 만 싣는다(onlyKnown) — 같은 전제
const okEv = { status: 'ok', source: 'local', days: 7, byVm: { 'v:2': [NOW - 2 * HOUR, 3] }, at: NOW, collectedAt: NOW };

test('A-1 VM 단위로 합친다 — 둘 다·Veeam 만·스냅샷만·확인 안 됨 · 잔존 스냅샷은 따로 · 스냅샷 수는 카드(snapCount)와 같다', () => {
  const sc = B.snapCount({ ev: okEv, vms, now: NOW });
  const match = { byVm: { 'v:1': { run: 0, lb: NOW - 5 * HOUR }, 'v:2': { run: 1, pg: 40, lb: NOW - 3 * HOUR } } };
  const vcnt = { src: 'veeam', n: 2, partial: false };
  const r = S.backupRow({ vms, linked: true, vcnt, match, sc, ev: okEv, now: NOW });
  assert.equal(r.snap, sc.n, '카드의 스냅샷 수와 같다');
  assert.equal(S.backupRow({ vms, linked: true, vcnt, match, sc, ev: { ...okEv, byVm: { ...okEv.byVm, 'v:9': [NOW, 1] } }, now: NOW }).snap, 2, '인벤토리에 없는 VM 은 세지 않는다');
  assert.deepEqual([r.vm, r.veeam, r.snap, r.snapStale], [5, 2, 2, 1]);
  assert.deepEqual(r.split, { both: 1, vOnly: 1, sOnly: 1, none: 2 }, 'v:2 둘 다 · v:1 Veeam 만 · v:3 지금 스냅샷 · v:4(잔존)·v:5 확인 안 됨');
  assert.deepEqual([r.running, r.pending, r.lastBackup], [1, 0, NOW - 3 * HOUR]);
});

test('A-2 못 읽은 쪽은 모름 — Veeam 실패면 veeam·나눔 null · 스냅샷 모름도 같다 · 연동 없음은 Veeam 없음(나눔은 스냅샷으로)', () => {
  const sc = B.snapCount({ ev: okEv, vms, now: NOW });
  let r = S.backupRow({ vms, linked: true, vcnt: { src: 'veeam', n: null, reason: 'veeam-failed' }, match: null, sc, ev: okEv, now: NOW });
  assert.deepEqual([r.veeam, r.veeamState, r.split, r.running], [null, 'veeam-failed', null, null]);
  assert.equal(r.snap, 2, 'Veeam 을 못 읽어도 스냅샷 수는 낸다(실서버 AZ)');
  r = S.backupRow({ vms, linked: false, sc, ev: okEv, now: NOW });
  assert.deepEqual([r.veeam, r.veeamState], [null, 'unlinked']);
  assert.deepEqual(r.split, { both: 0, vOnly: 0, sOnly: 2, none: 3 });
  const unk = B.snapCount({ ev: { status: 'not-collected' }, vms, now: NOW });
  r = S.backupRow({ vms, linked: false, sc: unk, ev: null, now: NOW });
  assert.deepEqual([r.snap, r.split, r.snapStale], [null, null, 1], '스냅샷을 모르면 0 이 아니다 · 잔존은 인벤토리로 센다');
});

test('A-3 합계 — 모르는 vCenter 는 0 으로 더하지 않고 센다', () => {
  const t = S.backupTotals([
    { vm: 10, veeam: 6, veeamState: 'ok', snap: 5, split: { both: 4, vOnly: 2, sOnly: 1, none: 3 }, running: 1, pending: 2, snapStale: 1 },
    { vm: 7, veeam: null, veeamState: 'veeam-failed', snap: 3, split: null, running: null },
    { vm: 4, veeam: null, veeamState: 'unlinked', snap: null, split: null },
  ]);
  assert.deepEqual([t.vcenters, t.vm, t.veeam, t.snap, t.both, t.none, t.running, t.pending, t.snapStale], [3, 21, 6, 8, 4, 3, 1, 2, 1]);
  assert.deepEqual([t.veeamUnknown, t.veeamUnlinked, t.snapUnknown, t.splitUnknown], [1, 1, 1, 2]);
});

test('A-4 VM 한 대 — Veeam 근거·스냅샷 근거만 · 모르면 키가 없다(없음과 다르다)', () => {
  const v = S.vmBackupView({ id: 'v:3', name: 'c', folder: 'DC/vm/A/B', powerState: 'POWERED_ON', veeamSnaps: 1, veeamSnapTs: NOW - HOUR },
    { run: 1, pg: 33, by: 'task', jobs: ['J1'], rp: 4, lb: NOW - 9 * HOUR, lbSrc: 'task', lastResult: 'Success' }, [NOW - HOUR, 2], { now: NOW });
  assert.deepEqual(v.v, { state: 'run', pg: 33, by: 'task', jobs: ['J1'], rp: 4, lb: NOW - 9 * HOUR, lbSrc: 'task', lastResult: 'Success', ag: false });
  assert.deepEqual(v.s, { ev: { ts: NOW - HOUR, n: 2 }, now: { n: 1, ts: NOW - HOUR, stale: false } });
  assert.equal(v.folder, 'DC/vm/A/B');
  const none = S.vmBackupView({ id: 'x', name: 'x' }, undefined, undefined, { now: NOW });
  assert.equal(none.v, null, 'Veeam 을 읽었는데 없음 = null');
  const unk = S.vmBackupView({ id: 'x', name: 'x' }, undefined, undefined, { veeamKnown: false, snapKnown: false, now: NOW });
  assert.equal('v' in JSON.parse(JSON.stringify(unk)), false, 'Veeam 모름 = 키 없음');
  assert.equal('ev' in JSON.parse(JSON.stringify(unk)).s, false);
});

test('B 라우트 — 범위 안만 · 세부내용 범위 밖 404 · 폴더·VM · 비관리자는 실행 중 작업 없음 · 비밀·원문 없음 · 도구 키 등록', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  VS.putResult(d.id, { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J-web', type: 'Backup', running: true, pg: 49 }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3 },
    { n: 'db01', m: 'vm-2', h: 'vc01.corp.local', j: [0], rp: 1, run: 1, pg: 20, by: 'task' },
  ] });
  const express = (await import('express')).default;
  const { store } = await import('../src/store.js');
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: NOW, vcenters: [VC, SN, OUT].map((id) => ({ id, name: id })),
    vms: [
      { id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC1/vm/A.MGMT/Web', powerState: 'POWERED_ON' },
      { id: `${VC}:vm-2`, vcenterId: VC, name: 'db01', folder: 'DC1/vm/A.MGMT/DB', powerState: 'POWERED_ON' },
      { id: `${VC}:vm-3`, vcenterId: VC, name: 'x', folder: 'DC1/vm', veeamSnaps: 1, veeamSnapTs: Date.now() },
      { id: `${SN}:vm-1`, vcenterId: SN, name: 'app01' },
      { id: `${OUT}:vm-1`, vcenterId: OUT, name: 'o1' },
    ], hosts: [] };
  let user = { username: 'o', role: 'operator', scope: { vcenters: [VC, SN] } };   // viewer 는 기본 tools 권한이 없다(특수 기능 도구와 같다)
  const app = express();
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  try {
    const r0 = await fetch(`${base}/tools/backup-summary`);
    const sum = await r0.json();
    assert.equal(r0.status, 200, JSON.stringify(sum));
    assert.deepEqual(sum.rows.map((r) => r.id).sort(), [SN, VC].sort(), '범위 밖 vCenter 는 싣지 않는다');
    const v = sum.rows.find((r) => r.id === VC);
    assert.deepEqual([v.vm, v.veeam, v.veeamState, v.running], [3, 2, 'ok', 1]);
    assert.equal(sum.rows.find((r) => r.id === SN).veeamState, 'unlinked');
    assert.equal('runningJobs' in sum, false, '실행 중 작업 이름은 관리자 판본만');
    assert.equal(sum.totals.vcenters, 2);
    assert.equal((await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(OUT)}`)).status, 404, '범위 밖 404(존재 은닉)');
    const det = await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
    assert.equal(det.vms.length, 3);
    const db = det.vms.find((x) => x.name === 'db01');
    assert.deepEqual([db.folder, db.v.state, db.v.pg, db.v.jobs], ['DC1/vm/A.MGMT/DB', 'run', 20, ['J-web']]);
    assert.equal(det.vms.find((x) => x.name === 'x').v, null, 'Veeam 을 읽었고 그 VM 은 없음');
    const raw = JSON.stringify([sum, det]);
    for (const leak of ['svc-bk', 'PW-secret-1', 'vbr-a.corp.local']) assert.equal(raw.includes(leak), false, leak);
    // 관리자 판본 — 실행 중 작업(작업 전체 진행률)
    user = { username: 'a', role: 'admin' };
    store.snapshot = { ...store.snapshot, generatedAt: NOW + 1 };
    const sumA = await (await fetch(`${base}/tools/backup-summary`)).json();
    assert.deepEqual(sumA.runningJobs, [{ vcenter: VC, server: 'VBR-A', name: 'J-web', pg: 49 }]);
    assert.equal(sumA.rows.length, 3, '전체 범위 관리자는 전부');
    // 응답 캐시 키에 범위·역할이 든다 — 같은 스냅샷에서 범위 계정이 관리자 판본(전부·작업 이름)을 받지 않는다
    user = { username: 'o', role: 'operator', scope: { vcenters: [VC, SN] } };
    const sumO = await (await fetch(`${base}/tools/backup-summary`)).json();
    assert.deepEqual([sumO.rows.length, 'runningJobs' in sumO], [2, false]);
  } finally { store.snapshot = prev; }
  const { TOOL_ROUTE_MAP } = await import('../src/auth/toolAccess.js').then((m) => ({ TOOL_ROUTE_MAP: m.TOOL_ROUTE_MAP || m.default || m }));
  const src = fs.readFileSync(new URL('../src/auth/toolAccess.js', import.meta.url), 'utf8');
  assert.match(src, /'backup-summary': 'backup-summary'/); assert.match(src, /'backup-detail': 'backup-detail'/);
  void TOOL_ROUTE_MAP;
});
