/**
 * v2.929(C-③) 반증 1인 확정분 회귀 — EndpointLocation.
 *  H-1 엣지에서는 법인 필터를 건너뛴다(법인 할당표는 중앙에만 있다 — 예전에는 묻는 MAC 이 0개)
 *  M-2 likelihood · 스위치 사이 포트 — 낮은 likelihood 위치 · 물리 아닌 인터페이스 · LLDP 이웃이 다른 장비인 포트는 업링크가 아니다
 *  M-3 VM 위치 — 위치 모르는 업링크 NIC 이 있으면 · LAG 이면 판정 보류 · 이름 규칙(도메인) · 담당 CVP 메타만
 *  M-4 비-admin 오류 사유의 주소 가림 · M-5 엣지 이름 대소문자 · L-1 인증 꺼짐 역할(toolActorOf) · L-2 쓰기 범위 403 · L-3 법인 미지정 범위 계정
 *  L-4 엣지 대기열(실행 중 요청을 버리지 않는다)
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpeprv2929-'));
Object.assign(process.env, { CONFIG_DIR: DIR, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true' });
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { viewer: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'] } }));
fs.writeFileSync(path.join(DIR, 'datacenters.json'), JSON.stringify({ datacenters: [{ id: 'corp-a', name: 'A' }], assign: { 'vc-a': 'corp-a' } }));
const closers = [];
after(async () => { for (const c of closers.reverse()) { try { await c(); } catch { /* */ } } try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });
const H = 3_600_000;
const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
const SRC = path.resolve(new URL('.', import.meta.url).pathname, '../src');

test('H-1 엣지에서는 법인 필터를 건너뛴다(자식 프로세스 — CENTRAL_URL 은 로드 때 읽힌다)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpeprv2929e-'));
  fs.writeFileSync(path.join(dir, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
  const code = `const { endpointMacsFor } = await import(${JSON.stringify(path.join(SRC, 'cvp/poller.js'))});
const { normalizeSettings } = await import(${JSON.stringify(path.join(SRC, 'cvp/settings.js'))});
const snap = { hosts: [{ id: 'vc-a:h1', vcenterId: 'vc-a', name: 'esx1', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:01' }] }], vms: [] };
const m = await endpointMacsFor({ id: 'cvp-1', agent: 'edge-a', datacenterId: 'corp-a' }, normalizeSettings({ enabled: true }), { snap });
console.log('MACS=' + JSON.stringify(m)); process.exit(0);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, CONFIG_DIR: dir, AGENT_NAME: 'edge-a', CENTRAL_URL: 'https://central.invalid', CENTRAL_TOKEN: 'x' }, encoding: 'utf8', timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  const line = String(r.stdout).split('\n').find((l) => l.startsWith('MACS='));
  assert.ok(line, `출력 없음: ${r.stderr}`);
  assert.deepEqual(JSON.parse(line.slice(5)), ['b8599f000001'], '엣지에는 datacenters.json 이 없어도 자기 호스트 MAC 을 묻는다');
});

test('M-2 likelihood · 물리 아닌 인터페이스 · 스위치 사이 포트', async () => {
  const { matchEndpoint, likelyRank } = await import('../src/cvp/hostMatch.js');
  const host = { name: 'esx1.corp.local', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:01' }] };
  const row = (port, likelihood, extra = {}) => ({ agent: '', cvpId: 'c1', key: 'LF1', hostname: 'leaf1', mac: 'b8599f000001', port, likelihood, ...extra });
  let m = matchEndpoint({ host, epRows: [row('Ethernet1', 'LIKELIHOOD_VERY_LIKELY'), row('Port-Channel2000', 'LIKELIHOOD_LESS_LIKELY'), row('Vxlan1', 'LIKELIHOOD_VERY_LIKELY')] });
  assert.deepEqual(m.uplinks.map((u) => u.port), ['Ethernet1'], '가장 높은 likelihood 만 · Vxlan 제외');
  m = matchEndpoint({ host, epRows: [row('Ethernet1', null), row('Ethernet49', null)], portLldp: [{ agent: '', cvpId: 'c1', key: 'LF1', port: 'Ethernet49', sysName: 'spine1.corp.local' }] });
  assert.deepEqual(m.uplinks.map((u) => u.port), ['Ethernet1'], 'LLDP 이웃이 다른 장비인 포트(spine)는 버린다');
  m = matchEndpoint({ host, epRows: [row('Ethernet1', 'LIKELIHOOD_LESS_LIKELY')] });
  assert.deepEqual(m.uplinks, [], '가장 높은 것이 LESS_LIKELY 면 쓰지 않는다');
  assert.equal(likelyRank(null), 2); assert.equal(likelyRank('weird'), 0);
});

test('M-5 · L-4 엣지 이름 대소문자 · 엣지 대기열', async () => {
  const Q = await import('../src/cvp/epRequests.js');
  Q._resetEpRequests();
  Q.requestEndpointLookup('Edge-A', 'cvp-9', ['005056aa0001'], NOW);
  Q.requestEndpointLookup('edge-a', 'cvp-9', ['005056aa0002'], NOW);
  const got = Q.takeEndpointRequests('EDGE-A', NOW);
  assert.deepEqual(got, [{ cvpId: 'cvp-9', macs: ['005056aa0001', '005056aa0002'] }], '같은 엣지로 합치고 대소문자와 무관하게 가져간다');
  const src = fs.readFileSync(path.join(SRC, 'agent/cvpConfigPull.js'), 'utf8');
  const fn = src.slice(src.indexOf('export function runEndpointRequests'), src.indexOf('export function _epQueueForTest'));
  assert.ok(fn.indexOf('_epQueue.push') < fn.indexOf('if (_epRun) return _epRun'), '실행 중이어도 먼저 대기열에 붙인다(예전에는 그대로 버렸다)');
  assert.ok(/while \(_epQueue\.length\)/.test(fn), '같은 실행이 대기열을 끝까지 처리한다');
});

test('L-1 인증 꺼짐 — canLocate 는 toolActorOf(익명 역할)를 따른다', () => {
  const src = fs.readFileSync(path.join(SRC, 'routes/api/hostSan.js'), 'utf8');
  const line = src.split('\n').find((l) => l.startsWith('const canLocate'));
  assert.match(line, /toolActorOf\(req\)\.role/);
  assert.equal(/config\.auth\.enabled/.test(line), false, '인증이 꺼졌다고 무조건 참이 아니다');
});

test('M-3 · M-4 · L-2 · L-3 실제 화면 라우트', async () => {
  const db = await import('../src/cvp/db.js');
  if (!(await db.available())) return;
  const reg = await import('../src/cvp/registry.js');
  const local = reg.saveServer({ name: 'CVP-L', host: 'https://127.0.0.1:9', authMode: 'token', token: 't', agent: '', datacenterId: 'corp-a' });
  const unassigned = reg.saveServer({ name: 'CVP-U', host: 'https://127.0.0.1:10', authMode: 'token', token: 't', agent: '' });
  await db.saveDevices({ cvpId: local.id, devices: [{ key: 'LF1', ts: NOW, hostname: 'leaf1', ports: [{ name: 'Ethernet1', oper: 'up', admin: 'up' }, { name: 'Ethernet2', oper: 'up', admin: 'up' }, { name: 'Port-Channel10', oper: 'up', admin: 'up' }, { name: 'Ethernet5', oper: 'up', admin: 'up' }, { name: 'Ethernet7', oper: 'up', admin: 'up' }] }] });
  await db.saveEndpoints('', local.id, [
    { mac: 'b8599f000001', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Ethernet1' }] },          // h1 vmnic0(vmk0)
    { mac: 'b8599f000002', at: NOW - 1000, status: 'none', locations: [] },                                            // h1 vmnic1 — 스위치가 배우지 않음
    { mac: '005056990001', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Ethernet2', vlan: 100 }] }, // vm1(vmnic1 고정)
    { mac: '005056990002', at: NOW - 1000, status: 'ok', locations: [{ device: 'LF1', port: 'Port-Channel10', vlan: 100 }] }, // vm2(LACP)
    { mac: '005056990004', at: NOW - 1000, status: 'error', reason: 'CVP 가 리다이렉트로 응답했습니다(HTTP 302 → https://10.99.88.77:8443)', locations: [] },
  ]);
  await db.saveEndpoints('', unassigned.id, [{ mac: '005056cc0001', at: NOW - 1000, status: 'ok', locations: [{ device: 'SPX', port: 'Ethernet48', vlan: 7 }] }]);
  await db.saveL2('', local.id, [{ key: 'LF1', ts: NOW, lldp: [{ port: 'Ethernet5', idx: '1', sysName: 'esx2.corp.local', portId: 'vmnic0', portDesc: 'vmnic0', chassisId: '' },
    { port: 'Ethernet7', idx: '1', sysName: 'esx1.b.local', portId: 'vmnic0', portDesc: 'vmnic0', chassisId: '' }], fdb: [] }]);
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { source: 'live', generatedAt: new Date(NOW).toISOString(), vcenters: [{ id: 'vc-a', name: 'vc-a' }, { id: 'vc-c', name: 'vc-c' }],
    hosts: [
      { id: 'vc-a:h1', name: 'esx1.corp.local', vcenterId: 'vc-a', nics: [{ device: 'vmnic0', mac: 'b8:59:9f:00:00:01', link: true }, { device: 'vmnic1', mac: 'b8:59:9f:00:00:02', link: true }] },
      { id: 'vc-a:h2', name: 'esx2.corp.local', vcenterId: 'vc-a', nics: [] },
      { id: 'vc-a:h4', name: 'esx1.a.local', vcenterId: 'vc-a', nics: [] },
      { id: 'vc-c:h3', name: 'esx3', vcenterId: 'vc-c', nics: [] }],
    vms: [
      { id: 'vc-a:vm1', name: 'app1', vcenterId: 'vc-a', host: 'esx1.corp.local', dev: { nics: [{ label: 'Network adapter 1', mac: '00:50:56:99:00:01' }, { label: 'Network adapter 4', mac: '00:50:56:99:00:04' }] } },
      { id: 'vc-a:vm2', name: 'app2', vcenterId: 'vc-a', host: 'esx2.corp.local', dev: { nics: [{ label: 'Network adapter 1', mac: '00:50:56:99:00:02' }] } },
      { id: 'vc-a:vm5', name: 'app5', vcenterId: 'vc-a', host: 'esx1.a.local', dev: { nics: [{ label: 'Network adapter 1', mac: '00:50:56:99:00:01' }] } },
      { id: 'vc-c:vm3', name: 'app3', vcenterId: 'vc-c', host: 'esx3', dev: { nics: [{ label: 'Network adapter 1', mac: '00:50:56:cc:00:01' }] } }],
    datastores: [] };
  closers.push(async () => { store.snapshot = prev; });
  const express = (await import('express')).default;
  const R = await import('../src/routes/api/hostSan.js');
  let user = { username: 'adm', role: 'admin' };
  const app = express(); app.use(express.json()); app.use((req, _r, next) => { req.user = user; next(); });
  const api = express.Router(); R.registerHostSan(api); app.use('/api', api);
  const srv = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  closers.push(() => new Promise((r) => srv.close(() => r())));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const vm = async (id) => (await fetch(`${base}/vms/${encodeURIComponent(id)}/endpoint-locations`)).json();

  let j = await vm('vc-a:vm1');
  assert.equal(j.rows[0].verdict, 'unknown', '호스트 vmnic1 위치를 몰라 판정 보류(예전: 거짓 불일치)');
  assert.match(j.rows[0].note, /2개 중 1개만/);
  assert.equal(j.rows[1].verdict, 'error'); assert.match(j.rows[1].reason, /10\.99\.88\.77/, 'admin 은 원문');
  j = await vm('vc-a:vm2');
  assert.equal(j.rows[0].verdict, 'unknown'); assert.match(j.rows[0].note, /LAG/, 'LACP — 멤버를 몰라 보류(예전: 거짓 불일치)');
  j = await vm('vc-a:vm5');
  assert.equal(j.hostPortsKnown, false, 'esx1.b.local 의 LLDP 포트를 esx1.a.local 에 붙이지 않는다(도메인 규칙)');
  assert.notEqual(j.rows[0].verdict, 'match', '거짓 일치 금지');

  user = { username: 'v', role: 'viewer' };
  j = await vm('vc-a:vm1');
  assert.equal(j.rows[1].reason.includes('10.99.88.77'), false, '비-admin 은 주소를 가린다(M-4)');
  assert.match(j.rows[1].reason, /주소 가림/);

  // L-2 쓰기 범위 밖 → 403(조회는 된다)
  user = { username: 'op', role: 'operator', scope: { vcenters: ['vc-a'], writeVcenters: ['vc-c'] } };
  assert.equal((await fetch(`${base}/vms/${encodeURIComponent('vc-a:vm1')}/endpoint-locations`)).status, 200);
  let r = await fetch(`${base}/hosts/${encodeURIComponent('vc-a:h1')}/endpoint-locate`, { method: 'POST' });
  assert.equal(r.status, 403);
  r = await fetch(`${base}/vms/${encodeURIComponent('vc-a:vm1')}/endpoint-locate`, { method: 'POST' });
  assert.equal(r.status, 403);

  // L-3 범위 계정 + 법인 미지정 vCenter → CVP 0대(법인 미지정 CVP 의 위치를 보지 않고 · 조회도 만들지 않는다)
  user = { username: 'op-c', role: 'operator', scope: { vcenters: ['vc-c'] } };
  j = await vm('vc-c:vm3');
  assert.equal(j.servers, 0); assert.deepEqual(j.rows[0].locations, []);
  r = await fetch(`${base}/vms/${encodeURIComponent('vc-c:vm3')}/endpoint-locate`, { method: 'POST' });
  assert.equal(r.status, 200); assert.deepEqual((await r.json()).direct, []);
  j = await (await fetch(`${base}/hosts/${encodeURIComponent('vc-c:h3')}/net-uplinks`)).json();
  assert.equal(j.servers, 0, 'net-uplinks 도 같은 규칙');
});
