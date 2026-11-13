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

// ───────── 반증 3a · 3b 반영 ─────────
const fleetTags = (tags) => fs.writeFileSync(path.join(tmp, 'fleet-tags.json'), JSON.stringify({ tags }));
// 같은 이름 'esx1' ESXi 호스트가 두 법인에 있고 분류 예외(이름 → baremetal)로 둘 다 베어메탈 — A 는 태그 없음(지금 키 = 이름 해시), B 는 태그 있음(별칭 = 같은 이름 해시)
const HOSTS2 = [{ id: 'h1', vcenterId: 'vc-a', name: 'esx1', serviceTag: '', connectionState: 'connected' },
  { id: 'h2', vcenterId: 'vc-b', name: 'esx1', serviceTag: 'TAGB', connectionState: 'connected' }];
const OPB = { username: 'opb', role: 'operator', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } };

test('반증3a A1: 별칭이 다른 서버의 지금 키면 별칭이 아니다 — 다른 법인 서버 B 는 거짓 불일치가 아니고 B 를 고치는 조작이 A 의 등록을 지우지 않는다', async () => {
  reset({ servers: [] }); fleetTags({ esx1: 'baremetal' });
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    const ka = g.body.servers.find((x) => x.corp === 'vc-a' && x.name === 'esx1').key; const kb = g.body.servers.find((x) => x.corp === 'vc-b' && x.name === 'esx1').key;
    assert.match(ka, /^fl:/); assert.equal(kb, 'st:tagb');
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: [ka] } });
    const g2 = await call('GET /tools/bm-folders');
    assert.deepEqual(g2.body.servers.filter((x) => x.name === 'esx1').map((x) => [x.corp, x.path, x.place, !!x.moved]).sort(), [['vc-a', 'DB', 'manual', false], ['vc-b', '', null, false]]);
    assert.deepEqual(g2.body.mismatch, []);
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'unassign', keys: [kb] } })).body.result.removed, 0, 'B 해제는 A 등록을 건드리지 않는다');
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'APP', keys: [kb] } })).body.result.added, 1);
    assert.deepEqual(Object.keys(bs.peekAssign()).sort(), [ka, 'st:tagb'].sort(), 'B 등록이 A 등록을 drop 하지 않는다');
    const r = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'WEB', keys: [ka, kb], moveExisting: true } });
    assert.equal(r.body.result.added, 2); assert.deepEqual(Object.values(bs.peekAssign()).map((x) => x.path), ['WEB', 'WEB'], '응답과 저장이 같다');
    // B 법인만 쓰는 운영자도 B 를 자기 폴더에 넣을 수 있다
    await call('POST /tools/bm-folders/op', { body: { op: 'unassign', keys: [kb] } });
    const rowB = (await call('GET /tools/bm-folders', { user: OPB })).body.servers.find((x) => x.name === 'esx1');
    assert.equal(!!rowB.moved, false);
    assert.equal((await call('POST /tools/bm-folders/op', { user: OPB, body: { op: 'assign', path: 'APP', keys: [rowB.key] } })).body.result.added, 1);
  }, HOSTS2);
});

test('반증3a A2 · A3: 쓰지 않은 별칭 등록(지금 키 등록이 따로 있음 · 다른 법인)은 목록에 없는 등록으로 보이고 지울 수 있다 · 다시 등록하면 같은 법인 별칭 등록을 모두 정리 · 폴더 등록 수(regs)는 서버 셈과 같다', async () => {
  reset({ servers: [SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')] });
  const { bmAliasKeys } = svcinv;
  const alias = bmAliasKeys({ serverId: 's1' }, 'serviceTag')[0];
  // 지금 키 등록 + 같은 법인 옛 키 등록(v2.988 이하에서 다시 등록한 경우)
  bs.mutateAssign((d) => { d.assign['st:tag1'] = { corp: 'vc-a', path: 'DB', name: 'kr-db-01' }; d.assign[alias] = { corp: 'vc-a', path: 'OLD', name: 'kr-db-01' }; return { result: {} }; });
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    assert.deepEqual(missingOf(g.body).map((x) => [x.key, x.path, x.state]), [[alias, 'OLD', 'ghost']], 'A2: 옛 키 등록이 보인다');
    const old = g.body.corps.find((c) => c.vcenterId === 'vc-a').folders.find((f) => f.path === 'OLD');
    assert.equal(old.regs, 1, '폴더 등록 수는 목록에 없는 등록도 센다');
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'folder.remove', corp: 'vc-a', path: 'OLD', expect: old.regs } })).statusCode, 200, '화면이 regs 로 보내면 409 가 아니다');
    bs.mutateAssign((d) => { d.assign[alias] = { corp: 'vc-a', path: 'OLD', name: 'kr-db-01' }; return { result: {} }; });
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'WEB', keys: ['st:tag1'], moveExisting: true } });
    assert.deepEqual(Object.keys(bs.peekAssign()), ['st:tag1'], 'A2: 다시 등록하면 같은 법인 옛 키 등록도 지운다');
  });
  // A3: 다른 법인 별칭 등록 — 이 서버의 것이라 단정하지 않는다(불일치가 아니라 그 법인의 목록에 없는 등록 — 그 법인 계정이 지운다)
  bs.mutateAssign((d) => { d.assign = { [alias]: { corp: 'vc-b', path: 'X', name: 'kr-db-01' } }; return { result: {} }; });
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    assert.deepEqual(g.body.mismatch, []); assert.equal(g.body.servers.find((x) => x.name === 'kr-db-01').place, null);
    const gb = await call('GET /tools/bm-folders', { user: OPB });
    const mb = missingOf(gb.body); assert.equal(mb.length, 1);
    const un = await call('POST /tools/bm-folders/op', { user: OPB, body: { op: 'unassign', keys: [mb[0].key] } });
    assert.equal(un.body.result.removed, 1, JSON.stringify(un.body)); assert.deepEqual(bs.peekAssign(), {});
  });
});

test('반증3a B1 · B2: 분류 예외(exclude)로 뺀 수집 서버 서버 · 신선한 전력 항목이 있는 서버 · 호스트 이름이 ESXi 와 같은 서버는 보류하지 않는다', () => {
  const now = 10 * 86_400_000;
  const base = { collectors: [{ id: 'c1', enabled: true }], statusOf: () => ({ at: now - 60_000 }), now, holdMs: 86_400_000 };
  const s1 = { collectorId: 'c1', id: 'r1', name: 'app-01', serviceTag: 'RTAG1', host: '10.9.0.21' };
  assert.ok(svcinv.collectorHeldKeys({ ...base, remoteServers: [s1] }).has('st:rtag1'));
  assert.equal(svcinv.collectorHeldKeys({ ...base, remoteServers: [s1], fleetTags: { rtag1: 'exclude' } }).size, 0, 'exclude');
  assert.equal(svcinv.collectorHeldKeys({ ...base, remoteServers: [s1], fleetTags: { 'remote:c1:r1': 'virtualization' } }).size, 0, 'serverId 분류 키');
  assert.equal(svcinv.collectorHeldKeys({ ...base, remoteServers: [s1], powerEntries: [{ collectorId: 'c1', serverId: 'r1', host: '10.9.0.21', watts: 300, ts: now - 60_000 }] }).size, 0, '신선한 전력 = 함대 목록에 있다');
  assert.ok(svcinv.collectorHeldKeys({ ...base, remoteServers: [s1], powerEntries: [{ collectorId: 'c1', serverId: 'r1', watts: 300, ts: now - 3 * 3_600_000 }] }).has('st:rtag1'), '오래된 전력은 보류');
  const esx = { ...s1, name: 'idrac-x', hostName: 'esx-07.corp.local' };
  assert.equal(svcinv.collectorHeldKeys({ ...base, remoteServers: [esx], hosts: [{ name: 'esx-07', serviceTag: '' }] }).size, 0, 'B2: 호스트 이름(짧은 이름)으로 ESXi');
  // 구버전 엣지(serverId 없는 전력 항목) — 함대 id remote:<수집기>:<호스트> 의 해시도 보류 키
  const k = svcinv.collectorHeldKeys({ ...base, remoteServers: [{ collectorId: 'c1', id: 'r9', name: 'n', host: 'Host-9' }] });
  assert.ok(k.has(svcinv.bmKeyOf({ serviceTag: '', fleetId: 'remote:c1:host-9' }).key));
});

test('반증3b 3 · 5: 규칙 이름과 화면 가림은 같은 임계(4자) · 같은 소문자화 — 2~3자 태그는 걷어 내지 않고 Σ 도 화면과 같게', async () => {
  const { ruleNameOf, TAG_MASK_MIN } = await import('../src/util/ruleName.js');
  assert.equal(TAG_MASK_MIN, 4);
  assert.equal(ruleNameOf({ name: 'finance-app', serviceTag: 'NA' }), 'finance-app', '2자 태그는 화면도 가리지 않는다');
  const m = { name: 'idrac-ABCDΣx', serviceTag: 'ABCDΣ' };
  assert.equal(svcinv.stripTag(m.name, m.serviceTag), 'idrac-•••x');
  assert.equal(ruleNameOf(m), 'idrac-\u0000x', '화면이 가린 자리를 규칙도 걷어 낸다');
});

test('반증3b: 범위 쓰기 계정이 이름 규칙으로 가린 태그를 떠볼 수 없다(라우트) — 태그 조각 규칙을 넣어도 소속이 바뀌지 않는다', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }) }, servers: [SRV('s1', 'idrac-ABC123', 'ABC123', 'vc-a')] });
  const SCW = { username: 'opa', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
  await withSnap(async () => {
    for (const value of ['abc', 'idrac-a', 'c123']) {
      const r = await call('POST /tools/svc-inventory/op', { user: SCW, body: { op: 'namerule.add', corp: 'vc-a', match: value === 'idrac-a' ? 'prefix' : 'contains', value, serviceId: 's1' } });
      assert.equal(r.statusCode, 200, JSON.stringify(r.body));
      const mem = await call('GET /tools/svc-inventory/members', { user: SCW, query: { corp: 'vc-a', service: 's1' } });
      assert.equal(mem.body.members.length, 0, `${value} — 태그 조각으로는 걸리지 않는다`);
      await call('POST /tools/svc-inventory/op', { user: SCW, body: { op: 'namerule.remove', corp: 'vc-a', match: value === 'idrac-a' ? 'prefix' : 'contains', value } });
    }
    await call('POST /tools/svc-inventory/op', { user: SCW, body: { op: 'namerule.add', corp: 'vc-a', match: 'prefix', value: 'idrac-', serviceId: 's1' } });
    assert.equal((await call('GET /tools/svc-inventory/members', { user: SCW, query: { corp: 'vc-a', service: 's1' } })).body.members.length, 1, '보이는 부분은 걸린다');
  });
});

test('반증3a A1(순수): 같은 법인 안의 겹침 — 다른 구성원의 지금 키 · 둘이 주장하는 별칭은 별칭으로 쓰지 않는다(물리서버 폴더 판정 · 서비스 인벤토리 배치 둘 다)', async () => {
  const { buildFolders } = await import('../src/bmfolders/build.js');
  const main = { rules: [], settings: {}, corps: {} };
  const X = { key: 'fl:k', aliasKeys: [], kind: 'bm', corp: 'A', name: 'x' };
  const Y = { key: 'st:y', aliasKeys: ['fl:k'], kind: 'bm', corp: 'A', name: 'y' };
  const b = buildFolders({ members: [X, Y], main, assign: { 'fl:k': { corp: 'A', path: 'DB' } } });
  assert.deepEqual([b.placeOf.get('fl:k').path, b.placeOf.get('st:y').path], ['DB', ''], '다른 구성원의 지금 키는 별칭이 아니다');
  const P = { key: 'st:p', aliasKeys: ['fl:z'], kind: 'bm', corp: 'A', name: 'p' }; const Q = { key: 'st:q', aliasKeys: ['fl:z'], kind: 'bm', corp: 'A', name: 'q' };
  const b2 = buildFolders({ members: [P, Q], main, assign: { 'fl:z': { corp: 'A', path: 'DB' } } });
  assert.deepEqual([b2.placeOf.get('st:p').path, b2.placeOf.get('st:q').path], ['', ''], '둘이 주장하는 별칭은 어느 쪽 것도 아니다');
  assert.deepEqual(b2.missing.map((x) => x.key), ['fl:z'], '그 등록은 목록에 없는 등록으로 보인다');
  // 서비스 인벤토리 배치(bmFolderMapOf)도 같은 가드
  reset({ servers: [] });
  const K = `fl:${'a'.repeat(16)}`;   // 저장소는 형식에 맞는 키만 받는다(isMemberKey)
  bs.mutateAssign((d) => { d.assign[K] = { corp: 'A', path: 'DB' }; return { result: {} }; });
  const placed = svcinv.bmFolderMapOf([{ ...X, key: K }, { ...Y, aliasKeys: [K] }]);
  assert.deepEqual([placed.get(K), placed.get('st:y')], ['DB', '']);
});

test('반증3b 사소: 해제 수는 서버 수 — 지금 키 · 별칭 키 등록을 함께 지워도 1대(entries 2)', async () => {
  reset({ servers: [SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')] });
  const alias = svcinv.bmAliasKeys({ serverId: 's1' }, 'serviceTag')[0];
  bs.mutateAssign((d) => { d.assign['st:tag1'] = { corp: 'vc-a', path: 'DB' }; d.assign[alias] = { corp: 'vc-a', path: 'OLD' }; return { result: {} }; });
  await withSnap(async () => {
    const un = await call('POST /tools/bm-folders/op', { body: { op: 'unassign', keys: ['st:tag1'] } });
    assert.deepEqual([un.body.result.removed, un.body.result.entries], [1, 2]); assert.deepEqual(bs.peekAssign(), {});
  });
});
