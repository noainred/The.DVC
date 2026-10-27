/**
 * v2.750 — VM 상세 창 '게스트 파티션 사용량': 조립(순수)·DB 한 VM 조회·실제 api 라우터(권한·범위 404).
 * DB 를 쓰는 테스트는 실제 시각(정시 경계로 떨어뜨린 NOW)을 쓴다(docs/rules/common.md).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpart2750-'));
process.env.CONFIG_DIR = DIR;
process.env.GUESTDISK_DB_PATH = path.join(DIR, 'guest-disk.db');
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * 60_000;

test('buildVmPartitions: 사용률 높은 순·값 모름은 null(0 아님)·무시 규칙은 사유만·vCenter 별 임계·다른 vCenter 의 옛 행은 쓰지 않는다', async () => {
  const { buildVmPartitions } = await import('../src/guestpart/report.js');
  const rec = {
    vm: { vcenterId: 'vc-a', ts: NOW, partial: true },
    parts: [
      { path: '/', capGB: 50, usedGB: 20, unknown: false, ts: NOW },
      { path: '/boot', capGB: 1, usedGB: 0.9, unknown: false, ts: NOW },
      { path: '/data', capGB: 200, usedGB: 190, unknown: false, ts: NOW },
      { path: '/mnt/x', capGB: null, usedGB: null, unknown: true, ts: NOW },
    ],
  };
  const settings = { threshold: 80, vcThresholds: { 'vc-a': 90 } };
  const r = buildVmPartitions(rec, settings, { vcenterId: 'vc-a', vmName: 'db01' });
  assert.equal(r.collectedAt, NOW);
  assert.equal(r.partial, true);
  assert.equal(r.thr, 90, 'vCenter 별 임계');
  assert.deepEqual(r.parts.map((p) => p.path), ['/data', '/boot', '/', '/mnt/x'], '사용률 높은 순, 모르는 값은 뒤로');
  const data = r.parts[0];
  assert.equal(data.pct, 95); assert.equal(data.freeGB, 10); assert.equal(data.over, true); assert.equal(data.ignored, null);
  assert.match(r.parts[1].ignored, /boot/, '무시 규칙은 사유 문구로');
  const unk = r.parts[3];
  assert.equal(unk.pct, null); assert.equal(unk.usedGB, null); assert.equal(unk.freeGB, null); assert.equal(unk.unknown, true); assert.equal(unk.over, false);
  const moved = buildVmPartitions(rec, settings, { vcenterId: 'vc-b' });
  assert.equal(moved.collectedAt, null, '수집 행의 vCenter 가 스냅샷과 다르면 이 VM 의 값이 아니다');
  assert.deepEqual(moved.parts, []);
  assert.equal(buildVmPartitions(null, settings, { vcenterId: 'vc-a' }).collectedAt, null);
});

test('vmPartLatest: 이번 수집 값 · 최근 수집에 없는 VM 은 vm=null', async () => {
  const db = await import('../src/guestdisk/db.js');
  const vm = { vmId: 'vc-a:vm1', vmName: 'vm1', allocGB: 150, usedGB: 120, partCount: 2, parts: [{ path: 'C:\\', capGB: 100, usedGB: 90 }, { path: 'D:\\', capGB: 50, usedGB: 30 }], partsUnknown: 1, unknownPaths: ['E:\\'] };
  assert.ok((await db.commitCollection('vc-a', 'VC-A', [vm], { ts: NOW })).ok);
  const r = await db.vmPartLatest('vc-a:vm1');
  assert.equal(r.vm.vcenterId, 'vc-a'); assert.equal(r.vm.ts, NOW);
  assert.equal(r.parts.length, 3);
  const e = r.parts.find((p) => p.path === 'E:\\');
  assert.equal(e.unknown, true); assert.equal(e.usedGB, null);
  const none = await db.vmPartLatest('vc-a:nope');
  assert.equal(none.vm, null); assert.deepEqual(none.parts, []);
});

test('실제 api 라우터 /vms/:id/partitions — inv.vms 권한(viewer 도)·범위 밖 VM 은 404·없는 VM 404·수집 시각·주기', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vmpart2750r-'));
  const apiPath = new URL('../src/routes/api.js', import.meta.url).pathname;
  const storePath = new URL('../src/store.js', import.meta.url).pathname;
  const dbPath = new URL('../src/guestdisk/db.js', import.meta.url).pathname;
  const script = `
    const express = (await import('express')).default;
    const { store } = await import(${JSON.stringify(storePath)});
    try { await store.refresh(); } catch {}
    const db = await import(${JSON.stringify(dbPath)});
    const { api } = await import(${JSON.stringify(apiPath)});
    const snap = store.get();
    const vcA = snap.vcenters[0].id;
    const vmA = snap.vms.find((v) => v.vcenterId === vcA);
    const vmB = snap.vms.find((v) => v.vcenterId !== vcA);
    const ts = ${NOW};
    await db.commitCollection(vcA, 'A', [{ vmId: vmA.id, vmName: vmA.name, allocGB: 60, usedGB: 50, partCount: 1, parts: [{ path: '/', capGB: 60, usedGB: 50 }] }], { ts });
    await db.commitCollection(vmB.vcenterId, 'B', [{ vmId: vmB.id, vmName: vmB.name, allocGB: 60, usedGB: 10, partCount: 1, parts: [{ path: '/', capGB: 60, usedGB: 10 }] }], { ts });
    const app = express();
    app.use((req, _res, next) => { req.user = req.get('x-s') ? { username: 'sc', role: 'viewer', scope: { vcenters: [vcA] } } : { username: 'ad', role: 'admin', scope: null }; next(); });
    app.use('/api', api);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const get = async (u, h = {}) => { const r = await fetch(base + u, { headers: h }); return [r.status, await r.json()]; };
    const out = {
      adA: await get('/api/vms/' + encodeURIComponent(vmA.id) + '/partitions'),
      adB: await get('/api/vms/' + encodeURIComponent(vmB.id) + '/partitions'),
      scA: await get('/api/vms/' + encodeURIComponent(vmA.id) + '/partitions', { 'x-s': '1' }),
      scB: await get('/api/vms/' + encodeURIComponent(vmB.id) + '/partitions', { 'x-s': '1' }),
      none: await get('/api/vms/no-such-vm/partitions'),
    };
    srv.close();
    console.log('@@' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, GUESTDISK_DB_PATH: path.join(dir, 'guest-disk.db'), DATA_SOURCE: 'mock', AUTH_ENABLED: 'true' },
    encoding: 'utf8', cwd: path.resolve(new URL('..', import.meta.url).pathname), timeout: 120_000,
  });
  assert.equal(r.status, 0, r.stderr.slice(-800));
  const o = JSON.parse(r.stdout.split('@@')[1]);
  assert.equal(o.adA[0], 200);
  assert.equal(o.adA[1].collectedAt, NOW, '언제 수집한 값인지');
  assert.equal(o.adA[1].parts[0].pct, 83.3);
  assert.equal(typeof o.adA[1].collect.intervalHours, 'number');
  assert.equal(typeof o.adA[1].offsetMin, 'number');
  assert.equal(o.adB[0], 200);
  assert.equal(o.scA[0], 200, 'viewer(inv.vms) 도 자기 범위 VM 은 본다');
  assert.equal(o.scB[0], 404, '범위 밖 VM 은 존재도 알리지 않는다');
  assert.equal(o.scB[1].parts, undefined);
  assert.equal(o.none[0], 404);
  fs.rmSync(dir, { recursive: true, force: true });
});
