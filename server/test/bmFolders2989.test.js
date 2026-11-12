// 물리서버 폴더 · 서비스 인벤토리 — 사용자 '개선 및 잔여작업 수행'(2회차 · 범위 ① 추이 화면 · ③ 수집 서버 경로 키 대조 · ④ 이름 규칙 잔여 위험 / 전체 검증).
//   ③-가 키 등급이 오르면(태그를 나중에 읽음 fl: → st:) 물리서버 폴더 등록을 별칭 키로 승계 — 예전에는 '없어짐' + (미분류)
//   ③-나 수집 서버(pull) 경로 서버가 전력 미보고로 분류 목록에서 빠져도 그 수집 서버가 지금 보고하는 서버면 '없어짐'이 아니라 보류(시한)
//   ④ 서비스 인벤토리 이름 규칙도 베어메탈은 가린 뒤 이름(태그 걷어 냄 · 주소 이름 제외)으로만 판정
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmfolders89-'));
process.env.CONFIG_DIR = tmp;

const bs = await import('../src/bmfolders/store.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const cstate = await import('../src/collector/state.js');
const rinv = await import('../src/collector/remoteInventory.js');
const { store } = await import('../src/store.js');
const { registerBmFolders } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');

const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}&u=${user.username}&g=${gen}` }, res);
  return res;
}
let gen = 0;
const snapOf = (hosts = []) => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts, vms: [] });
const SRV = (id, name, tag, vc, host) => ({ id, name, host: host || `https://192.0.2.${10 + Number(id.replace(/\D/g, '') || 0)}`, username: 'root', password: 'x', serviceTag: tag, ...(vc ? { vcenterId: vc } : {}) });
const S = (id, name) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], bmFolderRules: [], tagEnabled: false, ...c });
function reset({ svc = {}, servers = [SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')] } = {}) {
  bs._resetForTest(); sm._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: svc }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  registry.importServers(servers, 'replace');
  for (const c of ['c1']) { cstate.clearCollectorHosts(c); rinv.clearCollectorServers(c); }
}
const withSnap = async (fn, hosts = []) => { const prev = store.snapshot; try { store.snapshot = snapOf(hosts); return await fn(); } finally { store.snapshot = prev; } };
const missingOf = (body) => (body.missing || body.corps?.flatMap((c) => c.missing || []) || []);

// ───────── ③-가 키 등급 승계 ─────────
test('③-가 태그를 나중에 읽어 키가 fl: → st: 로 오르면 물리서버 폴더 등록을 별칭으로 승계한다 · 옛 키는 없어짐이 아니다 · 다음 쓰기에 새 키로 옮긴다', async () => {
  reset({ servers: [SRV('s1', 'kr-db-01', '', 'vc-a')] });
  let oldKey;
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    oldKey = g.body.servers.find((x) => x.name === 'kr-db-01').key;
    assert.match(oldKey, /^fl:/);
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: [oldKey] } })).statusCode, 200);
  });
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')], 'replace');   // 이제 서비스 태그를 읽는다
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    const row = g.body.servers.find((x) => x.name === 'kr-db-01');
    assert.equal(row.key, 'st:tag1');
    assert.deepEqual([row.path, row.place], ['DB', 'manual'], '옛 키 등록을 승계');
    assert.deepEqual(missingOf(g.body), [], '옛 키를 없어짐으로 세지 않는다');
    // 같은 서버를 옮기면 새 키로 적고 옛 키는 지운다(두 등록이 남지 않게)
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'WEB', keys: ['st:tag1'], moveExisting: true } })).statusCode, 200);
    assert.deepEqual(Object.keys(bs.peekAssign()), ['st:tag1']);
    assert.equal(bs.peekAssign()['st:tag1'].path, 'WEB');
  });
  // 해제도 별칭 키 등록을 그 서버의 등록으로 본다(옛 키만 남은 상태에서 지금 키로 해제)
  reset({ servers: [SRV('s1', 'kr-db-01', '', 'vc-a')] });
  await withSnap(async () => { assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: [oldKey] } })).statusCode, 200); });
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')], 'replace');
  await withSnap(async () => {
    const un = await call('POST /tools/bm-folders/op', { body: { op: 'unassign', keys: ['st:tag1'] } });
    assert.equal(un.body.result.removed, 1, JSON.stringify(un.body));
    assert.deepEqual(bs.peekAssign(), {});
  });
});

// ───────── ③-나 수집 서버 경로 ─────────
function collector({ watts = 300, ok = true, at = Date.now() } = {}) {
  fs.writeFileSync(path.join(tmp, 'collectors.json'), JSON.stringify({ collectors: [{ id: 'c1', name: 'pl-site', url: 'https://10.9.0.5:8443', enabled: true, vcenterId: 'vc-b' }] }));
  cstate.setCollectorStatus('c1', { ok, hosts: 1, at });
  rinv.setCollectorServers('c1', 'PL', [{ id: 'r1', name: 'pl-app-01', serviceTag: 'RTAG1', host: '10.9.0.21' }]);
  cstate.clearCollectorHosts('c1');
  if (watts != null) cstate.setRemoteHost('10.9.0.21', { watts, ts: Date.now(), collectorId: 'c1', serverName: 'pl-app-01', serverId: 'r1', serviceTag: 'RTAG1', vcenterId: 'vc-b', source: 'remote', dbKey: 'rmt:10.9.0.21' });
}
test('③-나 수집 서버 경로 서버가 전력 미보고로 분류 목록에서 빠져도 그 수집 서버가 지금 보고하면 보류(없어짐 · 정리 대상이 아니다) · 서비스 인벤토리 고정도 같다', async () => {
  reset({ svc: { 'vc-b': corpOf({ services: [S('p1', 'PL-APP')] }) } });
  collector();
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    const row = g.body.servers.find((x) => x.name === 'pl-app-01');
    assert.ok(row, JSON.stringify(g.body.servers.map((x) => x.name)));
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'APP', keys: [row.key] } })).statusCode, 200);
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-b', keys: [row.key], serviceId: 'p1' } })).statusCode, 200);
  });
  collector({ watts: null });   // 다음 pull: 그 서버 전력을 못 읽음 — 전력 항목에서 빠지지만 수집 서버 인벤토리에는 있다
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    assert.equal(g.body.servers.some((x) => x.name === 'pl-app-01'), false, '분류 목록에서는 빠진다(기존 동작)');
    assert.deepEqual(missingOf(g.body).map((x) => [x.key, x.state, x.why]), [['st:rtag1', 'held', 'collector-listed']]);
    const dry = await call('POST /tools/bm-folders/op', { body: { op: 'ghost.prune', corp: 'vc-b', dry: true } });
    assert.equal(dry.body.result.n, 0, '정리 대상이 아니다');
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-b' } });
    assert.equal(q.body.ghostsN, 0, '서비스 인벤토리 고정도 유령(정리 대상)이 아니다');
    assert.deepEqual(q.body.ghostsHeld.map((x) => [x.key, x.held]), [['st:rtag1', 'bm-collector-listed']]);
  });
  // 수집 서버가 그 서버를 더는 보고하지 않으면(인벤토리에서 빠짐) 없어짐이다
  rinv.setCollectorServers('c1', 'PL', []);
  await withSnap(async () => {
    assert.deepEqual(missingOf((await call('GET /tools/bm-folders')).body).map((x) => x.state), ['ghost']);
  });
  // 수집 서버가 마지막으로 성공한 지 보류 시한(24시간)을 넘으면 보류도 끝난다
  collector({ watts: null, ok: false, at: Date.now() - 25 * 3_600_000 });
  await withSnap(async () => {
    assert.deepEqual(missingOf((await call('GET /tools/bm-folders')).body).map((x) => x.state), ['ghost'], '보류에는 시한');
  });
});

// ───────── ④ 서비스 인벤토리 이름 규칙 — 가린 뒤 이름 ─────────
test('④ 이름 규칙(베어메탈)은 가린 뒤 이름으로만 — 태그 조각 · 태그를 걸친 값 · 주소 이름은 걸리지 않는다 · 보이는 부분은 걸린다 · VM 은 그대로', async () => {
  const { buildIndex, autoResolve } = await import('../src/servicemap/resolve.js');
  const { ruleNameOf: fromBm } = await import('../src/bmfolders/build.js');
  const { ruleNameOf } = await import('../src/util/ruleName.js');
  assert.equal(fromBm, ruleNameOf, '판정 코어는 하나(물리서버 폴더 자동 규칙과 같은 함수)');
  const idx = (rules) => buildIndex({ corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB')], nameRules: rules }) } });
  const bm = { key: 'st:abc123', kind: 'bm', corp: 'A', name: 'idrac-ABC123-db', serviceTag: 'ABC123' };
  for (const [match, value] of [['contains', 'abc'], ['contains', 'c123-d'], ['prefix', 'idrac-a'], ['suffix', '123-db']]) {
    assert.equal(autoResolve(bm, idx([{ match, value, serviceId: 's1' }])).src, 'none', `${match}:${value} — 태그 조각 · 걸친 값은 걸리지 않는다`);
  }
  const ok = autoResolve(bm, idx([{ match: 'suffix', value: '-db', serviceId: 's2' }]));
  assert.deepEqual([ok.serviceId, ok.src], ['s2', 'rule'], '보이는 부분은 걸린다');
  const addr = { key: 'fl:x', kind: 'bm', corp: 'A', name: '10.20.31.11', serviceTag: '', nameIsAddr: true };
  assert.equal(autoResolve(addr, idx([{ match: 'prefix', value: '10.20', serviceId: 's1' }])).src, 'none', '주소 이름은 이름 규칙 대상이 아니다');
  const vm = { key: 'iu:A:1', kind: 'vm', corp: 'A', name: 'erp-abc123', folderPath: '/x' };
  assert.equal(autoResolve(vm, idx([{ match: 'contains', value: 'abc', serviceId: 's1' }])).serviceId, 's1', 'VM 은 바뀌지 않는다(가림 대상 아님)');
});

test('③-나 collectorHeldKeys(순수): 시한 · 꺼진 수집 서버 · 지금 ESXi 호스트 제외 · 태그 없는 서버의 fl: 키는 함대 키(bmKeyOf)와 같다', () => {
  const now = 10 * 86_400_000;
  const rs = [{ collectorId: 'c1', id: 'r1', name: 'pl-app-01', serviceTag: 'RTAG1' }, { collectorId: 'c1', id: 'R2', name: 'pl-noTag' }, { collectorId: 'c1', id: 'r3', name: 'esx-07', serviceTag: 'HTAG' },
    { collectorId: 'c2', id: 'r4', name: 'x', serviceTag: 'OFFC' }];
  const base = { remoteServers: rs, collectors: [{ id: 'c1', enabled: true }, { id: 'c2', enabled: false }], hosts: [{ name: 'esx-07', serviceTag: 'HTAG' }], now, holdMs: 86_400_000 };
  const k = svcinv.collectorHeldKeys({ ...base, statusOf: () => ({ at: now - 3_600_000 }) });
  const fl2 = svcinv.bmKeyOf({ serviceTag: '', fleetId: 'remote:c1:r2' }).key;   // 함대 분류의 fleetId = norm(serverId) = 'remote:<수집기>:<서버>'
  assert.ok(k.has('st:rtag1') && k.has(fl2), [...k].join(','));
  assert.equal([...k].some((x) => x === 'st:htag'), false, '지금 ESXi 호스트인 서버는 보류하지 않는다(4차 반증 2)');
  assert.equal(k.has('st:offc'), false, '꺼진 수집 서버는 여기서 보류하지 않는다(fleetKeySources 가 못 읽음으로 전부 보류)');
  assert.equal(svcinv.collectorHeldKeys({ ...base, statusOf: () => ({ at: now - 86_400_001 }) }).size, 0, '마지막 성공이 시한 밖이면 보류 끝');
  assert.equal(svcinv.collectorHeldKeys({ ...base, statusOf: () => ({ ok: false, neverOk: true, at: null }) }).size, 0, '한 번도 성공하지 못했으면(at 없음) 여기서는 보류하지 않는다');
});
