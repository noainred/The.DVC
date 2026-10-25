/**
 * v2.781(점검 G3 — 백업 서머리) 회귀:
 *  · C-B1 vcBackup 에 'VM 목록 없음' 가드 — 재시작 직후 골격 스냅샷(initial)·VM 0대 vCenter 를 'Veeam 정상 · VM 0' 으로 내지 않는다
 *    (veeamState 'no-inventory' · veeam null · vm null). 판정은 vCenter **전체** 인벤토리로 — 전원 범위로 거른 목록이 비었다고 'no-inventory' 가 아니다.
 *  · B-B1 마지막 읽기가 실패·오래된 서버의 '백업 중' 은 확정 0 이 아니다 — 행에 runningStale, 합계는 runningUnknown(0 이 아닌 수는 하한으로 둔다).
 *  · B-B2 ≡ C-B2 합계에 '아는 vCenter 수·아는 VM 합'(veeamKnownVcs·snapKnownVcs·vmVeeamKnown·vmSnapKnown)과 부분 수(veeamPartial)를 같이 낸다.
 *  · B-I2 백업 CSV 2종은 동시 1건(util/exportBusy) — 진행 중이면 409.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2781c-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
const VC = 'apac:vc01';   // Veeam 연결
const SN = 'apac:vc02';   // 연동 없음
fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: VC, name: 'vc01', host: 'vc01.corp.local', username: 'u', password: 'p' },
  { id: SN, name: 'vc02', host: 'vc02.corp.local', username: 'u', password: 'p' },
] }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const S = await import('../src/veeam/backupStatus.js');
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;

test('B-B1 행 — runningStale 이면 표지를 단다(0 이 아닌 수는 하한으로 남긴다) · 신선하면 표지 없음', () => {
  const vms = [{ id: 'a' }, { id: 'b' }];
  const match = { byVm: { a: { run: 1, lb: NOW - HOUR }, b: { run: 0, lb: NOW - HOUR } } };
  const vcnt = { src: 'veeam', n: 2, partial: true };
  const r = S.backupRow({ vms, linked: true, vcnt, match, runningStale: true, now: NOW });
  assert.deepEqual([r.running, r.pending, r.runningStale], [1, 0, true]);
  const f = S.backupRow({ vms, linked: true, vcnt: { ...vcnt, partial: false }, match, now: NOW });
  assert.equal('runningStale' in f, false);
  // Veeam 을 모르면 running 자체가 null — 표지는 달지 않는다(그 행은 veeamUnknown 으로 센다)
  const u = S.backupRow({ vms, linked: true, vcnt: { src: 'veeam', n: null, reason: 'veeam-failed' }, match: null, runningStale: true, now: NOW });
  assert.deepEqual([u.running, 'runningStale' in u], [null, false]);
});

test('C-B1 행 — noInventory 면 vm 은 null(0 이 아니다)', () => {
  const r = S.backupRow({ vms: [], linked: true, vcnt: { src: 'veeam', n: null, reason: 'no-inventory' }, match: null, noInventory: true, now: NOW });
  assert.deepEqual([r.vm, r.veeam, r.veeamState, r.running, r.rpo, r.split], [null, null, 'no-inventory', null, null, null]);
  assert.equal(S.backupRow({ vms: [], linked: false, now: NOW }).vm, 0, '플래그가 없으면 그대로(빈 범위 목록 = 0대)');
});

test('B-B2 합계 — 아는 vCenter 수·아는 VM 합·부분 수 · 아는 곳 0 · null running 을 0 으로 삼키지 않는다', () => {
  // b1.mjs 재현과 같은 꼴: vc1(VM 4 · Veeam 3 · 일부 서버만) + vc2(VM 1000 · Veeam 실패 · 스냅샷 모름) + vc3(연동 없음 · VM 6 · 스냅샷 2)
  const t = S.backupTotals([
    { vm: 4, veeam: 3, veeamState: 'partial', snap: 1, snapState: 'ok', split: { both: 1, vOnly: 2, sOnly: 0, none: 1 }, running: 2, pending: 0, runningStale: true, rpo: { d1: 1, d3: 0, d7: 0, unknown: 0 }, results: { failed: 1, warning: 0 } },
    { vm: 1000, veeam: null, veeamState: 'veeam-failed', snap: null, snapState: 'stale-events', split: null, running: null, pending: null },
    { vm: 6, veeam: null, veeamState: 'unlinked', snap: 2, snapState: 'partial', split: { both: 0, vOnly: 0, sOnly: 2, none: 4 }, running: null, pending: null },
  ]);
  assert.deepEqual([t.vm, t.veeam, t.snap, t.running, t.pending], [1010, 3, 3, 2, 0], '기존 필드 의미는 그대로');
  assert.deepEqual([t.veeamKnownVcs, t.vmVeeamKnown, t.snapKnownVcs, t.vmSnapKnown], [1, 10, 2, 10], 'Veeam 분모 = 읽은 vCenter + 연동 없음(없음 확정) · 스냅샷 분모 = 스냅샷을 아는 vCenter');
  assert.deepEqual([t.veeamPartial, t.snapPartial, t.runningUnknown, t.vmUnknown], [1, 1, 1, 0]);
  const z = S.backupTotals([
    { vm: 5, veeam: null, veeamState: 'veeam-failed', snap: null, split: null, running: null },
    { vm: null, veeam: null, veeamState: 'no-inventory', snap: null, split: null, running: null },
  ]);
  assert.deepEqual([z.veeamKnownVcs, z.snapKnownVcs, z.vmVeeamKnown, z.vmSnapKnown, z.vmUnknown, z.vm], [0, 0, 0, 0, 1, 5]);
  // 연동 없음인데 VM 목록 수집 전이면 분모에 넣을 VM 이 없다
  const u = S.backupTotals([{ vm: null, veeam: null, veeamState: 'unlinked', snap: null, split: null }]);
  assert.deepEqual([u.veeamKnownVcs, u.vmVeeamKnown, u.veeamUnlinked], [0, 0, 1]);
});

async function startApp() {
  const express = (await import('express')).default;
  const { registerBackupStatus } = await import('../src/routes/api/veeam.js');
  const holder = { user: { username: 'adm', role: 'admin' } };
  const app = express();
  app.use((req, _res, next) => { req.user = holder.user; next(); });
  const api = express.Router(); registerBackupStatus(api); app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  return { base: `http://127.0.0.1:${srv.address().port}/api`, holder };
}

test('라우트 — C-B1 골격·VM 0대 · 전원 범위 · B-B1 실패 서버 · B-I2 CSV 동시 1건', async () => {
  const R = await import('../src/veeam/registry.js');
  const VS = await import('../src/veeam/store.js');
  const { store } = await import('../src/store.js');
  const EB = await import('../src/util/exportBusy.js');
  const d = R.saveServer({ name: 'VBR-A', host: 'vbr-a.corp.local', username: 'svc-bk', password: 'PW-secret-1', vcenterIds: [VC] });
  const okRes = { ok: true, ts: Date.now(), counts: {}, jobs: [{ id: 'j1', name: 'J-web', type: 'Backup', running: true, pg: 49 }], vms: [
    { n: 'web01', m: 'vm-1', h: 'vc01.corp.local', j: [0], rp: 3, run: 1, pg: 20, by: 'task' },
  ] };
  VS.putResult(d.id, okRes);
  const { base } = await startApp();
  const prev = store.snapshot;
  let gen = NOW;
  const setSnap = (o) => { store.snapshot = { source: 'live', generatedAt: ++gen, vcenters: [VC, SN].map((id) => ({ id, name: id })), hosts: [], ...o }; };
  const sum = async (q = '') => { const r = await fetch(`${base}/tools/backup-summary${q}`); const j = await r.json(); assert.equal(r.status, 200, JSON.stringify(j)); return j; };
  try {
    // ① 재시작 직후 골격 — vcenters 만 있고 vms 없음(store.publishSkeleton). Veeam 결과는 디스크에 남아 있다.
    setSnap({ initial: true, vms: [] });
    let s = await sum();
    let v = s.rows.find((r) => r.id === VC);
    assert.deepEqual([v.veeamState, v.veeam, v.vm, v.running, v.rpo], ['no-inventory', null, null, null, null], '골격이면 Veeam 정상 · VM 0 이 아니다');
    assert.equal(s.rows.find((r) => r.id === SN).vm, null, '연동 없는 vCenter 도 VM 수는 모름');
    assert.deepEqual([s.totals.veeamKnownVcs, s.totals.snapKnownVcs, s.totals.vmUnknown, s.totals.veeamUnknown], [0, 0, 2, 1]);
    // ② 수집 뒤 — 이 vCenter 만 VM 이 0대(연결 끊김·캐시 없음)
    setSnap({ vms: [{ id: `${SN}:vm-1`, vcenterId: SN, name: 'app01', powerState: 'POWERED_ON' }] });
    s = await sum();
    v = s.rows.find((r) => r.id === VC);
    assert.deepEqual([v.veeamState, v.veeam, v.vm], ['no-inventory', null, null]);
    // ③ 전원 범위로 거른 목록이 비어도(켜진 VM 뿐인데 '꺼짐') no-inventory 가 아니다 — 전체 인벤토리 기준
    const vms = [{ id: `${VC}:vm-1`, vcenterId: VC, name: 'web01', folder: 'DC1/vm', powerState: 'POWERED_ON' }];
    setSnap({ vms });
    s = await sum('?power=off');
    v = s.rows.find((r) => r.id === VC);
    assert.deepEqual([v.veeamState, v.veeam, v.vm], ['ok', 0, 0], '꺼진 VM 0대는 사실이다');
    s = await sum();
    v = s.rows.find((r) => r.id === VC);
    assert.deepEqual([v.veeamState, v.veeam, v.vm, v.running, 'runningStale' in v], ['ok', 1, 1, 1, false]);
    // ④ B-B1: 이번 읽기 실패(마지막 성공분 사용) — 그 서버의 '백업 중' 은 지금 사실이 아니다 → 모름 표지
    VS.putResult(d.id, { ok: false, ts: Date.now(), error: 'timeout' });
    setSnap({ vms });
    s = await sum();
    v = s.rows.find((r) => r.id === VC);
    assert.equal(v.veeam, 1, '백업 대상은 마지막 성공분으로 낸다');
    assert.deepEqual([v.running, v.runningStale], [0, true], '0 은 확정이 아니다');
    assert.equal(s.totals.runningUnknown, 1);
    const det = await (await fetch(`${base}/tools/backup-detail?vcenterId=${encodeURIComponent(VC)}`)).json();
    assert.equal(det.row.runningStale, true, '세부내용도 같은 행');
    // CSV — 백업 중 칸은 모름(빈칸) · VM 칸도 숫자 그대로
    const csv = await (await fetch(`${base}/tools/backup-summary.csv`)).text();
    const line = csv.split('\r\n').find((l) => l.startsWith(`${VC},`));
    assert.ok(line, csv);
    const cells = line.split(',');
    assert.deepEqual([cells[2], cells[3], cells[9]], ['1', '1', ''], `백업 중 칸 ${line}`);
    // ⑤ B-I2: 다른 내보내기가 진행 중이면 409 · 끝나면 다시 된다(release 는 finally)
    for (const [name, url] of [['backup-summary.csv', `${base}/tools/backup-summary.csv`], ['backup-detail.csv', `${base}/tools/backup-detail.csv?vcenterId=${encodeURIComponent(VC)}`]]) {
      const lock = EB.acquireExport(name, { user: { username: 'other' } });
      assert.equal(lock.ok, true);
      const busy = await fetch(url);
      assert.equal(busy.status, 409, name);
      assert.equal((await busy.json()).error, 'export_busy');
      lock.release();
      assert.equal((await fetch(url)).status, 200, `${name} 해제 뒤`);
      assert.equal(EB.exportBusyOf(name), null, `${name} 요청이 끝나면 잠금이 풀린다`);
    }
    assert.equal((await fetch(`${base}/tools/backup-detail.csv?vcenterId=nope`)).status, 404, '범위·존재 판정은 잠금보다 먼저');
    assert.equal(EB.exportBusyOf('backup-detail.csv'), null);
  } finally { store.snapshot = prev; }
});
