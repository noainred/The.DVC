// 서비스 인벤토리 5차 검토 2차 반영 — docs/design/service-map/README.md §5차 검토(사용자 '2차 진행해줘').
//   M2 입력 다시 읽기(쓰기 계정 · 프로세스당 상한) · R6 수집 서버 경로 스캔 엔트리(export → 중앙 정제 → 조인) ·
//   R18 스캔 엔트리 없는 이유 분리 · M10/R5 판정 결과 memo · 저장소 동결 참조.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r5b-'));
process.env.CONFIG_DIR = tmp;
process.env.COLLECTOR_TOKEN = 'edge-tok-r5b';

const { autoResolve, buildIndex } = await import('../src/servicemap/resolve.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const agent = await import('../src/collector/agent.js');
const remote = await import('../src/collector/remoteInventory.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory, scanInfoOf, _invMemoStats, _resetFreshForTest } = await import('../src/routes/api/svcInventory.js');

const S = (id, name, extra = {}) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '', ...extra });
function mapOf(corps = {}) {
  const out = { rev: 0, corps: {}, globals: [], settings: { tagCategory: '' } };
  for (const [vc, c] of Object.entries(corps)) out.corps[vc] = { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c };
  return out;
}
const bm = (key, corp, extra = {}) => ({ key, kind: 'bm', corp, name: key, scan: null, powered: true, cores: 32, memGB: 256, usage: { state: 'ok', cpuPct: 20, memPct: 40, src: 'idrac' }, faults: 0, ...extra });

const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const VIEWER = { username: 'v1', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: key.replace(/^\w+ /, '/api') }, res);
  return res;
}

test('R6: 수집 서버 export 는 scanRangeId 를 늘 싣고(없으면 빈 값) 중앙 정제가 지킨다(128자) · 구버전(필드 없음)은 필드 없음 그대로', async () => {
  registry.importServers([
    { id: 'bm-a', name: 'bm-a', host: 'https://192.0.2.50', username: 'root', password: 'x', serviceTag: 'TAGA', scanRangeId: 'rng-1' },
    { id: 'bm-b', name: 'bm-b', host: 'https://192.0.2.51', username: 'root', password: 'x', serviceTag: 'TAGB' },
  ], 'replace');
  const exp = await agent.buildExport();
  const byId = Object.fromEntries((exp.servers || []).map((s) => [s.id, s]));
  assert.equal(byId['bm-b'].scanRangeId, '', '엔트리 없음은 빈 값 — 필드는 있다(구버전 수집 서버와 구분)');
  assert.ok(['rng-1', ''].includes(byId['bm-a'].scanRangeId), '등록부가 지키는 값이면 그대로');
  const clean = remote.sanitizeEdgeExport({ ...exp, servers: [...exp.servers, { id: 'bm-old', name: 'old', host: 'h' }, { id: 'bm-long', name: 'l', scanRangeId: 'x'.repeat(500) }] });
  const c = Object.fromEntries(clean.servers.map((s) => [s.id, s]));
  assert.equal('scanRangeId' in c['bm-old'], false, '구버전(필드 없음)은 필드를 만들지 않는다');
  assert.equal(c['bm-long'].scanRangeId.length, 128, '128자 상한');
  assert.equal(c['bm-b'].scanRangeId, '');
});

test('R6·R18: 스캔 엔트리 판정(scanInfoOf) — 등록부·엣지·수집 서버 경로 · 모르는 엔트리 · 구버전 · 수동 등록을 나눈다', () => {
  const scanEntries = new Map([['e1', { service: 'DB' }]]);
  const regById = new Map([['r1', { scanRangeId: 'e1' }], ['r2', {}]]);
  const edgeScan = new Map([['edge:1', 'e1'], ['edge:2', 'zz'], ['edge:3', null], ['edge:4', '']]);
  const remoteScan = new Map([['remote:c1:9', 'e1'], ['remote:c1:8', null], ['remote:c1:7', 'gone']]);
  const ctx = { edgeScan, remoteScan, regById, scanEntries };
  assert.deepEqual(scanInfoOf({ source: 'idrac', serverId: 'r1' }, ctx), { scan: { entryId: 'e1', label: 'DB' }, scanWhy: undefined });
  assert.deepEqual(scanInfoOf({ source: 'idrac', serverId: 'r2' }, ctx), { scan: null, scanWhy: undefined }, '수동 등록');
  assert.deepEqual(scanInfoOf({ source: 'edge', serverId: 'edge:1' }, ctx).scan, { entryId: 'e1', label: 'DB' });
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:2' }, ctx).scanWhy, 'unknown-entry');
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:3' }, ctx).scanWhy, 'old-source', '엣지 push 에 필드가 없다(2.887 전)');
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:4' }, ctx).scanWhy, undefined, '빈 값 = 엔트리 없음(수동)');
  assert.deepEqual(scanInfoOf({ source: 'remote', serverId: 'remote:c1:9' }, ctx).scan, { entryId: 'e1', label: 'DB' }, '수집 서버 경로도 조인된다(예전에는 늘 출처 없음)');
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c1:8' }, ctx).scanWhy, 'old-source');
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c1:7' }, ctx).scanWhy, 'unknown-entry');
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c9:1' }, ctx).scanWhy, undefined, '원격 인벤토리에 없는 서버는 모른다 — 구버전으로 단정하지 않는다');
});

test('R18: 이유별 미지정 사유와 묶음 — 중앙에 없는 엔트리 · 구버전 · 수동 등록이 다른 묶음', () => {
  const map = mapOf({ A: { services: [S('s1', 'DB')] } });
  const idx = buildIndex(map);
  assert.equal(autoResolve(bm('k1', 'A', { scanWhy: 'unknown-entry' }), idx).reason, 'scan-entry-unknown');
  assert.equal(autoResolve(bm('k2', 'A', { scanWhy: 'old-source' }), idx).reason, 'source-old');
  assert.equal(autoResolve(bm('k3', 'A'), idx).reason, 'no-scan-entry');
  const inv = buildInventory({ members: [bm('k1', 'A', { scanWhy: 'unknown-entry' }), bm('k2', 'A', { scanWhy: 'old-source' }), bm('k4', 'A', { scanWhy: 'old-source' }), bm('k3', 'A')], map });
  const g = Object.fromEntries(inv.queues.unassigned.map((x) => [x.key, x.n]));
  assert.deepEqual(g, { 'manual|A|old-source': 2, 'manual|A|unknown-entry': 1, 'manual|A|': 1 });
});

test('M10/R5: 저장소 읽기는 동결 참조(복사 없음) — 고치려 하면 던지고, 쓰기는 새 동결 객체로 바뀐다', () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ A: { services: [S('s1', 'ERP')] } })));
  const m1 = sm.peekMap();
  assert.equal(Object.isFrozen(m1) && Object.isFrozen(m1.corps.A.services[0]), true);
  assert.throws(() => { m1.corps.A.services[0].name = 'X'; }, TypeError, '읽기 참조를 고치면 상태가 조용히 바뀌는 대신 던진다');
  assert.equal(sm.peekMap(), m1, '같은 상태면 같은 참조(복사하지 않는다)');
  const copy = sm.getMap(); copy.corps.A.services[0].name = 'X';
  assert.equal(sm.peekMap().corps.A.services[0].name, 'ERP', '사본은 고쳐도 상태가 그대로');
  sm.mutateMap((d) => { d.corps.A.services[0].name = 'ERP2'; return { result: {} }; });
  const m2 = sm.peekMap();
  assert.notEqual(m2, m1); assert.equal(m2.corps.A.services[0].name, 'ERP2'); assert.equal(Object.isFrozen(m2.corps.A), true);
  assert.equal(m1.corps.A.services[0].name, 'ERP', '옛 참조는 옛 값 그대로(동결)');
});

test('M10/R5: 판정 결과 memo — 같은 세대·rev·범위면 다시 계산하지 않고, 쓰기·범위가 바뀌면 새로 계산한다', async () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(mapOf({ 'vc-a': { services: [S('s1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } })));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 11, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [],
      vms: [{ id: 'vm-1', vcenterId: 'vc-a', name: 'app1', folderPath: '/ERP', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 }] };
    const s0 = _invMemoStats();
    const r1 = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    assert.equal(r1.statusCode, 200, JSON.stringify(r1.body)); assert.equal(r1.body.members[0].serviceId, 's1');
    const s1 = _invMemoStats();
    await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    await call('GET /tools/svc-inventory/candidates', { query: { kind: 'vm', corp: 'vc-a' } });
    const s2 = _invMemoStats();
    assert.equal(s1.misses - s0.misses, 1, '첫 요청은 계산');
    assert.equal(s2.misses, s1.misses, '같은 키의 큐·후보 요청은 다시 계산하지 않는다');
    assert.equal(s2.hits - s1.hits, 2);
    const w = await call('POST /tools/svc-inventory/op', { body: { op: 'service.add', corp: 'vc-a', name: 'MES' } });
    assert.equal(w.statusCode, 200, JSON.stringify(w.body));
    await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    assert.equal(_invMemoStats().misses, s2.misses + 1, '쓰기(rev)가 바뀌면 새로 계산 — 옛 판정을 보이지 않는다');
    const scoped = { username: 'op1', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
    await call('GET /tools/svc-inventory/members', { user: scoped, query: { corp: 'vc-a' } });
    assert.equal(_invMemoStats().misses, s2.misses + 2, '범위가 다른 계정은 다른 키(서로의 판본을 받지 않는다)');
    assert.ok(_invMemoStats().size <= 4, '상한 4개');
  } finally { store.snapshot = prev; }
});

test('M2: 입력 다시 읽기 — 쓰기 계정만(조회 계정 403) · 프로세스당 상한(429 · 몇 초 뒤인지) · 읽은 뒤에는 입력 세대가 바뀐다', async () => {
  _resetFreshForTest();
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 21, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms: [] };
    assert.equal((await call('GET /tools/svc-inventory', { user: VIEWER, query: { fresh: '1' } })).statusCode, 403);
    await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    const warm = _invMemoStats().misses;   // 이 세대의 판정은 이미 memo 에 있다
    const first = await call('GET /tools/svc-inventory', { query: { fresh: '1' } });
    assert.notEqual(first.statusCode, 429, '첫 번째는 받는다');
    assert.equal(_invMemoStats().misses, warm + 1, '입력을 다시 읽으면(gather·inputRev) memo 를 쓰지 않고 새로 계산한다');
    const again = await call('GET /tools/svc-inventory', { query: { fresh: '1' } });
    assert.equal(again.statusCode, 429); assert.ok(again.body.waitSec > 0 && again.body.waitSec <= 30); assert.match(again.body.reason, /초 뒤/);
  } finally { store.snapshot = prev; _resetFreshForTest(); }
});
