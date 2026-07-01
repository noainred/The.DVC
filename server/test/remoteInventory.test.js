import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 격리된 CONFIG_DIR.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-inv-'));
process.env.CONFIG_DIR = tmp;
process.env.COLLECTOR_TOKEN = 'edge-tok'; // 엣지 export 활성화(buildExport의 서버 직렬화 경로 검증용)

let store, agent, registry, invCache;
before(async () => {
  store = await import('../src/collector/remoteInventory.js');
  agent = await import('../src/collector/agent.js');
  registry = await import('../src/idrac/registry.js');
  invCache = await import('../src/idrac/invCache.js');
});
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
beforeEach(() => { registry.importServers([], 'replace'); store.clearCollectorServers('c1'); store.clearCollectorServers('c2'); });

test('setCollectorServers/allRemoteServers: 수집기별 교체 + remote 태깅', () => {
  store.setCollectorServers('c1', 'Seoul', [{ id: 'a', name: 'A', datacenterId: 'corpA', inv: { system: { model: 'R760' } } }]);
  store.setCollectorServers('c2', 'Warsaw', [{ id: 'b', name: 'B', datacenterId: 'corpB', inv: null }]);
  const all = store.allRemoteServers();
  assert.equal(all.length, 2);
  const a = all.find((s) => s.id === 'a');
  assert.equal(a.remote, true);
  assert.equal(a.collectorId, 'c1');
  assert.equal(a.collectorDatacenter, 'Seoul');
  // 같은 수집기 재보고 → 교체(누적 아님).
  store.setCollectorServers('c1', 'Seoul', [{ id: 'a2', name: 'A2', datacenterId: 'corpA' }]);
  const ids = store.allRemoteServers().map((s) => s.id).sort();
  assert.deepEqual(ids, ['a2', 'b'], 'c1은 교체되어 a는 사라지고 a2만; c2(b)는 유지');
});

test('findRemoteServer: id로 원격 서버 1건 조회', () => {
  store.setCollectorServers('c1', 'Seoul', [{ id: 'x', name: 'X', inv: { cpu: { model: 'Xeon' } } }]);
  const r = store.findRemoteServer('x');
  assert.ok(r);
  assert.equal(r.inv.cpu.model, 'Xeon');
  assert.equal(store.findRemoteServer('nope'), null);
});

test('buildExport: servers에 자격증명 없이 서버+콤팩트 인벤토리를 실어보낸다', async () => {
  registry.importServers([{
    id: 'srv1', name: 'ESX1', host: '10.0.0.1', username: 'root', password: 'secret',
    serviceTag: 'TAG1', vcenterId: 'VC1', datacenterId: 'corpA',
  }], 'replace');
  invCache.setInventory('srv1', {
    system: { model: 'R760', serviceTag: 'TAG1' }, cpu: { model: 'Xeon 6430', count: 2, cores: 32 },
    memory: { totalGiB: 512 }, gpus: [{ model: 'H100' }], idrac: { firmwareVersion: '7.10' },
    bios: { version: '2.1' }, firmware: [{ type: 'NIC', version: '22.5', name: 'X710' }], collectedAt: 1700000000000,
  });
  const exp = await agent.buildExport();
  assert.ok(Array.isArray(exp.servers), 'export에 servers 배열 존재');
  const s = exp.servers.find((x) => x.id === 'srv1');
  assert.ok(s, 'srv1 포함');
  // 자격증명은 절대 실리면 안 된다.
  assert.equal(s.password, undefined);
  assert.equal(s.username, undefined);
  // 콤팩트 인벤토리 필드.
  assert.equal(s.inv.system.model, 'R760');
  assert.equal(s.inv.cpu.count, 2);
  assert.equal(s.inv.memory.totalGiB, 512);
  assert.equal(s.inv.gpus[0].model, 'H100');
  assert.equal(s.inv.idrac.firmwareVersion, '7.10');
  assert.equal(s.inv.firmware[0].type, 'NIC');
  assert.equal(s.datacenterId, 'corpA');
});

test('buildExport: 인벤토리 없는 서버는 inv=null로 직렬화', async () => {
  registry.importServers([{ id: 's2', name: 'ESX2', host: '10.0.0.2', username: 'root', password: 'x' }], 'replace');
  const exp = await agent.buildExport();
  const s = exp.servers.find((x) => x.id === 's2');
  assert.ok(s);
  assert.equal(s.inv, null);
});

test('buildExport: 표시 이름을 hostname으로 통일(태그를 이름으로 쓰지 않음)', async () => {
  registry.importServers([
    // ① hostNames에 실제 hostname 있음 → 그 hostname을 이름으로.
    { id: '10.0.0.11', name: 'ABC1234', host: '10.0.0.11', username: 'root', password: 'x', serviceTag: 'ABC1234', hostNames: ['leshost11', '10.0.0.11'] },
    // ② 저장된 name이 서비스태그와 동일(과거 등록분) + hostname 없음 → IP로 대체(태그 금지).
    { id: '10.0.0.12', name: 'DEF5678', host: '10.0.0.12', username: 'root', password: 'x', serviceTag: 'DEF5678', hostNames: ['10.0.0.12'] },
  ], 'replace');
  const exp = await agent.buildExport();
  const a = exp.servers.find((x) => x.id === '10.0.0.11');
  const b = exp.servers.find((x) => x.id === '10.0.0.12');
  assert.equal(a.name, 'leshost11', 'hostNames의 실제 hostname을 이름으로');
  assert.equal(b.name, '10.0.0.12', 'hostname 없으면 IP로(서비스태그는 이름으로 안 씀)');
  assert.notEqual(b.name, 'DEF5678');
});

test('registerScanned: 이름은 hostName || IP(서비스태그는 이름으로 쓰지 않음)', () => {
  registry.importServers([], 'replace');
  registry.registerScanned([
    { ip: '10.0.1.1', serviceTag: 'TAG1', hostName: 'lesreal01' }, // hostName 있음
    { ip: '10.0.1.2', serviceTag: 'TAG2', hostName: '' },           // hostName 없음 → IP
  ], 'root', 'pw', 'merge', '', 'corpX');
  const list = registry.loadRegistry();
  assert.equal(list.find((s) => s.id === '10.0.1.1').name, 'lesreal01');
  assert.equal(list.find((s) => s.id === '10.0.1.2').name, '10.0.1.2', 'hostName 없으면 IP');
});
