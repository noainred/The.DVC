// v2.691: '대역·스캔'(vCenter 별) → 'IP 스캔 설정'(에이전트별) 통합 — 1회 이전 계획(순수) + 실제 admin 라우터(이전·가져오기·소유자).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planVcRangeMigration, unionRanges } from '../src/ipam/vcRangeMigrate.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('① 계획 — 직접 수집은 이 포탈, 엣지 위임은 담당 엣지(대소문자는 기존 이름으로), 모르면 옮기지 않는다', () => {
  const plan = planVcRangeMigration({
    vcRanges: [
      { vcenterId: 'vc-d', ranges: ['10.0.0.0/24', '10.0.0.0/'], enabled: true },
      { vcenterId: 'vc-s', ranges: ['10.1.0.0/24'], enabled: true },
      { vcenterId: 'vc-s2', ranges: ['10.2.0.0/24'], enabled: true },
      { vcenterId: 'vc-noagent', ranges: ['10.3.0.0/24'], enabled: true },
      { vcenterId: 'vc-off', ranges: ['10.4.0.0/24'], enabled: true },
      { vcenterId: 'vc-gone', ranges: ['10.5.0.0/24'], enabled: true },
      { vcenterId: 'vc-roff', ranges: ['10.6.0.0/24'], enabled: false },
      { vcenterId: 'vc-empty', ranges: [], enabled: true },
    ],
    vcenters: [
      { id: 'vc-d', name: 'D', collectMode: 'direct' },
      { id: 'vc-s', name: 'S', collectMode: 'site', remoteAgent: 'edge-wa' },
      { id: 'vc-s2', name: 'S2', collectMode: 'site' },
      { id: 'vc-noagent', collectMode: 'site' },
      { id: 'vc-off', collectMode: 'direct', enabled: false },
      { id: 'vc-roff', collectMode: 'direct' },
      { id: 'vc-empty', collectMode: 'direct' },
    ],
    snapVcenters: [{ id: 'vc-s2', collectedBy: 'Edge-OC2' }],
    agentNames: ['Edge-WA'],
  });
  const by = Object.fromEntries(plan.map((p) => [p.vcenterId, p]));
  assert.equal(by['vc-d'].reason, 'moved'); assert.equal(by['vc-d'].target, '__local__');
  assert.deepEqual(by['vc-d'].ranges, ['10.0.0.0/24']); assert.equal(by['vc-d'].invalid.length, 1, '형식 오류 줄은 옮기지 않고 기록');
  assert.equal(by['vc-s'].target, 'Edge-WA', '이미 있는 스캔 에이전트 이름(대소문자)으로 맞춘다');
  assert.equal(by['vc-s2'].target, 'Edge-OC2', 'remoteAgent 가 없으면 스냅샷 collectedBy');
  assert.equal(by['vc-noagent'].reason, 'no-agent'); assert.equal(by['vc-noagent'].target, null);
  assert.equal(by['vc-off'].reason, 'vc-disabled');
  assert.equal(by['vc-gone'].reason, 'deleted');
  assert.equal(by['vc-roff'].reason, 'range-off', '꺼진 대역은 옮기지 않는다(켜면 동작이 바뀐다)');
  assert.equal(by['vc-empty'].reason, 'empty');
});

test('② 합집합 — 앞 순서 유지 · 같은 줄은 한 번 · 겹친 개수', () => {
  assert.deepEqual(unionRanges(['a', 'b'], ['b', 'c', 'c']), { ranges: ['a', 'b', 'c'], dup: 2 });
});

function runChild(body, { user, setup }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipscan2691-'));
  setup?.(dir);
  const script = `
    const SRC = ${JSON.stringify(SRC + '/')};
    const express = (await import('express')).default;
    const fs = await import('node:fs');
    const { store } = await import(SRC + 'store.js');
    await store.refresh?.();
    const { adminRouter } = await import(SRC + 'routes/admin.js');
    const app = express(); app.use(express.json());
    app.use((req, _r, n) => { req.user = ${JSON.stringify(user)}; n(); });
    app.use('/api/admin', adminRouter);
    const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = 'http://127.0.0.1:' + srv.address().port;
    const call = async (m, p, b) => { const r = await fetch(base + '/api/admin' + p, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { s: r.status, j }; };
    const get = (p) => call('GET', p);
    const post = (p, b) => call('POST', p, b);
    const out = {};
    try { ${body} } catch (e) { out.err = String(e && e.stack || e); } finally { srv.close(); }
    console.log('@@' + JSON.stringify(out));
    process.exit(0);
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'mock', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 180_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-2000));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return { ...o, dir };
}

const FULL = { username: 'full', role: 'admin', scope: null };

test('③ 이전 라우트 — 1회 실행 · 백업 · 이 포탈 대역으로 합침 · 남은 대역은 옮기기/지우기 · 다시 실행하지 않음', () => {
  const o = runChild(`
    const vc = store.get().vcenters[0].id;
    out.vc = vc;
    fs.writeFileSync(process.env.CONFIG_DIR + '/ipam-vcenter-ranges.json', JSON.stringify({ vcenters: {
      [vc]: { ranges: ['10.10.0.0/24', '10.10.1.0/'], enabled: true },
      'vc-deleted': { ranges: ['10.20.0.0/24'], enabled: true },
    } }));
    fs.writeFileSync(process.env.CONFIG_DIR + '/ipam-scan.json', JSON.stringify({ agents: { __local__: { enabled: false, ranges: ['10.99.0.0/24'] } } }));
    out.m1 = await get('/ipam/scan/migration');
    out.local = await get('/ipam/scan/settings');
    out.m2 = await get('/ipam/scan/migration');
    out.rerun = (await import(SRC + 'ipam/vcRangeMigrate.js')).runVcRangeMigration().ran; // 함수 자체도 1회만(라우트 가드와 별개)
    out.move = await post('/ipam/scan/migration/move', { vcenterId: 'vc-deleted', agent: 'Edge-X' });
    out.edge = await get('/ipam/scan/settings?agent=Edge-X');
    out.again = await post('/ipam/scan/migration/move', { vcenterId: 'vc-deleted', agent: 'Edge-X' });
    out.owners = await get('/ipam/scan/owners');
    out.dismiss = await post('/ipam/scan/migration/dismiss', {});
    out.files = fs.readdirSync(process.env.CONFIG_DIR);
  `, { user: FULL });
  assert.equal(o.m1.s, 200);
  const items = o.m1.j.state.items;
  const mine = items.find((x) => x.vcenterId === o.vc);
  assert.equal(mine.result, 'moved'); assert.equal(mine.target, '__local__'); assert.equal(mine.enabledAgent, true, '꺼져 있던 이 포탈 스캔을 켰다');
  assert.equal(mine.invalid.length, 1);
  assert.equal(items.find((x) => x.vcenterId === 'vc-deleted').result, 'kept');
  assert.deepEqual(o.m1.j.remaining.map((x) => x.vcenterId), ['vc-deleted']);
  assert.deepEqual(o.local.j.settings.ranges, ['10.99.0.0/24', '10.10.0.0/24']);
  assert.equal(o.local.j.settings.enabled, true);
  assert.ok(o.m1.j.state.backup && o.files.includes(o.m1.j.state.backup), '이전 전 원본 백업');
  assert.equal(o.m2.j.state.at, o.m1.j.state.at, '두 번째 조회는 다시 이전하지 않는다');
  assert.equal(o.rerun, false, '이미 이전했으면 runVcRangeMigration 은 아무것도 하지 않는다');
  assert.equal(o.move.s, 200); assert.equal(o.move.j.moved, 1); assert.equal(o.move.j.remaining.length, 0);
  assert.deepEqual(o.edge.j.settings.ranges, ['10.20.0.0/24']); assert.equal(o.edge.j.settings.enabled, true);
  assert.equal(o.again.s, 404);
  assert.ok(o.owners.j.owners.some((x) => x.owner === 'Edge-X' && x.ranges.includes('10.20.0.0/24')));
  assert.equal(o.dismiss.s, 200); assert.ok(o.dismiss.j.state.dismissedAt);
});

test('④ 가져오기 — iDRAC 은 서비스별 번호·이름 없음 · VM 은 이 에이전트 vCenter 먼저 · 잘못된 kind 400', () => {
  const o = runChild(`
    const vc = store.get().vcenters[0].id;
    fs.writeFileSync(process.env.CONFIG_DIR + '/datacenters.json', JSON.stringify({ datacenters: [{ id: 'DC-WA', name: 'WA' }, { id: 'DC-X', name: 'X' }], assign: { [vc]: 'DC-WA' } }));
    fs.writeFileSync(process.env.CONFIG_DIR + '/idrac-scan-ranges.json', JSON.stringify({ entries: {
      a: { datacenterId: 'DC-WA', service: '서버팜', ranges: ['192.168.40.0/22'], enabled: true },
      b: { datacenterId: 'DC-WA', service: '', ranges: ['10.94.40.0/24'], enabled: false },
      c: { datacenterId: 'DC-X', service: '엑스', ranges: ['10.50.0.0/24'], enabled: true } } }));
    out.idrac = await get('/ipam/scan/import?kind=idrac&datacenterId=DC-WA');
    out.idracX = await get('/ipam/scan/import?kind=idrac&datacenterId=DC-X');
    out.vm = await get('/ipam/scan/import?kind=vm');
    out.vmMissing = await get('/ipam/scan/import?kind=vm&vcenterId=nope');
    out.bad = await get('/ipam/scan/import?kind=zz');
  `, { user: FULL });
  assert.equal(o.idrac.s, 200);
  const sv = o.idrac.j.services;
  assert.equal(sv.length, 2);
  assert.deepEqual(sv.map((x) => x.no), [1, 2]);
  const named = sv.find((x) => x.service === '서버팜'); const blank = sv.find((x) => x.service === '');
  assert.equal(named.subnets.length, 4); assert.equal(blank.subnets[0].cidr, '10.94.40.0/24'); assert.equal(blank.enabled, false);
  assert.deepEqual(o.idracX.j.services.map((x) => x.service), ['엑스']);
  assert.equal(o.vm.s, 200); assert.ok(o.vm.j.vcenters.length > 0); assert.equal(o.vm.j.vcenters[0].mine, true, '이 포탈이 수집하는 vCenter 를 먼저');
  assert.ok(o.vm.j.subnets.length > 0);
  assert.equal(o.vmMissing.s, 404);
  assert.equal(o.bad.s, 400);
});

test('⑤ 범위 계정 — 이전·가져오기·소유자 라우트는 403(전 법인 데이터)', () => {
  const o = runChild(`
    out.m = await get('/ipam/scan/migration');
    out.i = await get('/ipam/scan/import?kind=vm');
    out.o = await get('/ipam/scan/owners');
    out.mv = await post('/ipam/scan/migration/move', { vcenterId: 'x', agent: 'y' });
  `, { user: { username: 'scoped', role: 'admin', scope: { vcenters: ['vc-x'] } } });
  for (const k of ['m', 'i', 'o', 'mv']) assert.equal(o[k].s, 403, k);
});

test('⑥ 이전 사유 코드 ↔ 화면 문구 1:1(웹 MIGRATION_REASON_TEXT)', async () => {
  const { MIGRATION_REASONS } = await import('../src/ipam/vcRangeMigrate.js');
  const web = await import(path.resolve(SRC, '../../web/src/views/tools/scanRangeImportText.js'));
  assert.deepEqual(Object.keys(web.MIGRATION_REASON_TEXT).sort(), [...MIGRATION_REASONS].sort());
});
