// v2.690: vCenter별 스캔 대역 편집기의 '/24 대역 가져오기'(iDRAC 스캔 대역 · VM 주소) — 순수 계산 + 실제 admin 라우터.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { excludedIpReason, idracSubnets, specTo24, vmSubnets } from '../src/ipam/vcRangeSuggest.js';
import { ipToNum } from '../src/util/ipv4.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

test('① specTo24 — /22 는 /24 4개, 범위는 걸치는 /24 전부, 형식 오류·뒤집힌 범위는 거부', () => {
  const cidr = (b) => `${Math.floor(b / 65536) % 256}.${Math.floor(b / 256) % 256}.${b % 256}.0/24`;
  assert.deepEqual(specTo24('192.168.40.0/22').bases.map(cidr), ['192.168.40.0/24', '192.168.41.0/24', '192.168.42.0/24', '192.168.43.0/24']);
  assert.deepEqual(specTo24('10.1.1.10-10.1.2.20').bases.map(cidr), ['10.1.1.0/24', '10.1.2.0/24']);
  assert.deepEqual(specTo24('10.1.1.10-50').bases.map(cidr), ['10.1.1.0/24']);
  assert.deepEqual(specTo24('10.9.9.9').bases.map(cidr), ['10.9.9.0/24']);
  assert.deepEqual(specTo24('10.0.0.0/25').bases.map(cidr), ['10.0.0.0/24']);
  assert.equal(specTo24('10.0.0.0/').ok, false); // 빈 마스크는 /0 이 아니다(v2.637)
  assert.equal(specTo24('10.0.2.10-10.0.1.5').ok, false); // 스캔 대역은 뒤집힌 범위를 거부한다
  const big = specTo24('10.0.0.0/8', 5);
  assert.equal(big.bases.length, 5); assert.equal(big.total, 65536);
});

test('② idracSubnets — 그 DataCenter 엔트리만 · 중복 /24 는 하나 · 출처 이름 · 꺼진 엔트리 표시 · 읽을 수 없는 줄', () => {
  const entries = [
    { id: 'e1', datacenterId: 'DC-WA', service: '서버팜', ranges: ['192.168.40.0/22', '10.94.42.10-10.94.42.200'], enabled: true },
    { id: 'e2', datacenterId: 'dc-wa', service: '스토리지', ranges: ['192.168.41.0/24', '10.0.0.0/'], enabled: false },
    { id: 'e3', datacenterId: 'DC-OC2', service: '다른 법인', ranges: ['172.16.0.0/24'] },
    null, 'x',
  ];
  const r = idracSubnets({ entries, datacenterId: 'DC-WA' });
  assert.deepEqual(r.subnets.map((s) => s.cidr), ['10.94.42.0/24', '192.168.40.0/24', '192.168.41.0/24', '192.168.42.0/24', '192.168.43.0/24']);
  const s41 = r.subnets.find((s) => s.cidr === '192.168.41.0/24');
  assert.deepEqual(s41.sources, ['서버팜', '스토리지']);
  assert.equal(s41.disabledOnly, false);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.invalid.map((x) => x.service), ['스토리지']);
  assert.equal(idracSubnets({ entries, datacenterId: '' }).subnets.length, 0);
  // 상한: 넘친 개수를 밝힌다
  const capped = idracSubnets({ entries: [{ datacenterId: 'd', ranges: ['10.0.0.0/16'] }], datacenterId: 'd', cap: 10 });
  assert.equal(capped.subnets.length, 10); assert.equal(capped.omitted, 246);
});

test('③ vmSubnets — 그 vCenter VM 만 · VM 수·주소 수 · 루프백/링크로컬/IPv6 제외와 개수 · IP 없는 VM', () => {
  const vms = [
    { id: 'v1', name: 'web01', vcenterId: 'vc-a', ipAddresses: ['10.1.2.3', '10.1.2.4', 'fe80::1', '169.254.1.1'] },
    { id: 'v2', name: 'web02', vcenterId: 'vc-a', ipAddress: '10.1.2.5' },
    { id: 'v3', name: 'db01', vcenterId: 'vc-a', ipAddresses: ['10.1.3.9', '127.0.0.1'] },
    { id: 'v4', name: 'noip', vcenterId: 'vc-a' },
    { id: 'v5', name: 'other', vcenterId: 'vc-b', ipAddress: '10.9.9.9' },
    { id: 'v6', name: 'v6only', vcenterId: 'vc-a', ipAddresses: ['2001:db8::1'] },
  ];
  const r = vmSubnets({ vms, vcenterId: 'vc-a' });
  assert.deepEqual(r.subnets.map((s) => `${s.cidr}:${s.vms}:${s.ips}`), ['10.1.2.0/24:2:3', '10.1.3.0/24:1:1']);
  assert.deepEqual(r.subnets[0].sample, ['web01', 'web02']);
  assert.equal(r.totals.vms, 5); assert.equal(r.totals.vmsWithIp, 3); assert.equal(r.totals.vmsNoIp, 2);
  assert.equal(r.totals.ipv6, 2); assert.equal(r.totals.excluded['link-local'], 1); assert.equal(r.totals.excluded.loopback, 1);
  // 사설 대역(컨테이너 기본망 172.17)은 빼지 않는다 — 사람이 확인 창에서 해제한다
  assert.equal(excludedIpReason(ipToNum('172.17.0.2')), null);
  assert.equal(excludedIpReason(ipToNum('224.0.0.5')), 'multicast');
});

function runChild(body, { user, setup }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vcrangeimp2690-'));
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
    const get = async (p) => { const r = await fetch(base + '/api/admin' + p); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t.slice(0, 200); } return { s: r.status, j }; };
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
  return o;
}

const FULL = { username: 'full', role: 'admin', scope: null };

test('④ 라우트 — VM 대역은 스냅샷 VM 으로, iDRAC 대역은 그 vCenter 가 속한 DataCenter 로(고르면 그 DataCenter)', () => {
  const o = runChild(`
    const vc = store.get().vcenters[0].id;
    const vms = store.get().vms.filter((v) => v.vcenterId === vc && (v.ipAddress || (v.ipAddresses || []).length)).length;
    fs.writeFileSync(process.env.CONFIG_DIR + '/datacenters.json', JSON.stringify({ datacenters: [{ id: 'DC-WA', name: 'WA' }, { id: 'DC-X', name: 'X' }], assign: { [vc]: 'DC-WA' } }));
    fs.writeFileSync(process.env.CONFIG_DIR + '/idrac-scan-ranges.json', JSON.stringify({ entries: {
      a: { datacenterId: 'DC-WA', service: '서버', ranges: ['192.168.40.0/22'], enabled: true },
      b: { datacenterId: 'DC-X', service: '엑스', ranges: ['10.50.0.0/24'], enabled: true } } }));
    out.vms = vms;
    out.vm = await get('/ipam/vc-ranges/suggest?kind=vm&vcenterId=' + encodeURIComponent(vc));
    out.idrac = await get('/ipam/vc-ranges/suggest?kind=idrac&vcenterId=' + encodeURIComponent(vc));
    out.idracX = await get('/ipam/vc-ranges/suggest?kind=idrac&datacenterId=DC-X&vcenterId=' + encodeURIComponent(vc));
    out.bad = await get('/ipam/vc-ranges/suggest?kind=zz&vcenterId=' + encodeURIComponent(vc));
    out.missing = await get('/ipam/vc-ranges/suggest?kind=vm&vcenterId=nope');
    out.vc2 = store.get().vcenters[1].id;
    out.unassigned = await get('/ipam/vc-ranges/suggest?kind=idrac&vcenterId=' + encodeURIComponent(out.vc2));
  `, { user: FULL });
  assert.equal(o.vm.s, 200);
  assert.ok(o.vm.j.subnets.length > 0, '목 vCenter 에 IP 가 있는 VM 이 있어야 한다');
  assert.ok(o.vm.j.subnets.every((s) => /\.0\/24$/.test(s.cidr)));
  assert.ok(o.vm.j.totals.vmsWithIp <= o.vms);
  assert.equal(o.idrac.s, 200);
  assert.equal(o.idrac.j.datacenterId, 'DC-WA'); assert.equal(o.idrac.j.datacenterSource, 'assigned'); assert.equal(o.idrac.j.datacenterName, 'WA');
  assert.deepEqual(o.idrac.j.subnets.map((s) => s.cidr), ['192.168.40.0/24', '192.168.41.0/24', '192.168.42.0/24', '192.168.43.0/24']);
  assert.deepEqual(o.idracX.j.subnets.map((s) => s.cidr), ['10.50.0.0/24']); assert.equal(o.idracX.j.datacenterSource, 'chosen');
  assert.equal(o.bad.s, 400);
  assert.equal(o.missing.s, 404);
  assert.equal(o.unassigned.s, 200); assert.equal(o.unassigned.j.datacenterId, ''); assert.equal(o.unassigned.j.subnets.length, 0);
  assert.ok(o.unassigned.j.datacenters.length === 2, 'DataCenter 를 고를 수 있게 목록을 준다');
});

test('⑤ 범위 계정 — 범위 밖 vCenter 는 404(존재 은닉) · iDRAC 스캔 대역은 403(전 법인 설정) · 범위 안 VM 대역은 200', () => {
  // 범위 계정은 첫 vCenter 만 허용 — 목 vCenter id 를 먼저 읽어 온다.
  const o = runChild(`const [a, b] = store.get().vcenters.map((v) => v.id); out.a = a; out.b = b;`, { user: FULL });
  const o2 = runChild(`
    out.inScope = await get('/ipam/vc-ranges/suggest?kind=vm&vcenterId=' + encodeURIComponent(${JSON.stringify(o.a)}));
    out.outScope = await get('/ipam/vc-ranges/suggest?kind=vm&vcenterId=' + encodeURIComponent(${JSON.stringify(o.b)}));
    out.idrac = await get('/ipam/vc-ranges/suggest?kind=idrac&vcenterId=' + encodeURIComponent(${JSON.stringify(o.a)}));
  `, { user: { username: 'scoped', role: 'admin', scope: { vcenters: [o.a] } } });
  assert.equal(o2.inScope.s, 200);
  assert.equal(o2.outScope.s, 404);
  assert.equal(o2.idrac.s, 403); assert.equal(o2.idrac.j.requiredFullScope, true);
});
