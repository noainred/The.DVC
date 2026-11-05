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
const { registerSvcInventory, scanInfoOf, edgeScanByTagOf, _invMemoStats, _resetFreshForTest, _gatherStatsForTest } = await import('../src/routes/api/svcInventory.js');
const { buildVcIndex } = await import('../src/idrac/corpAttribution.js');

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
  // 2차 반증 1: 원격 인벤토리에 없는 서버(OME 장치 · 서버 목록을 보내지 않는 수집 서버 · 아직 못 받음)는 모른다 — 구버전으로도 수동 등록으로도 단정하지 않는다
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c9:1' }, ctx).scanWhy, 'not-reported');
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:9' }, ctx).scanWhy, 'not-reported');
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

test('2차 반증 5: 수집 서버 경로가 엔트리 id 를 주지 않으면 같은 서비스 태그의 엣지 push 값을 쓴다(태그가 갈리면 쓰지 않는다)', () => {
  const byTag = edgeScanByTagOf([
    { serverId: 'edge:a:1', serviceTag: 'TAG1', scanRangeId: 'e1' },
    { serverId: 'edge:b:1', serviceTag: 'tag1', scanRangeId: 'e1' },     // 같은 값 — 대소문자 무시
    { serverId: 'edge:a:2', serviceTag: 'TAG2', scanRangeId: 'e1' },
    { serverId: 'edge:b:2', serviceTag: 'TAG2', scanRangeId: 'e2' },     // 다른 값 — 뺀다
    { serverId: 'edge:a:3', serviceTag: 'TAG3', scanRangeId: null },     // 구버전 엣지 — 넣지 않는다
    { serverId: 'edge:a:4', serviceTag: 'TAG4', scanRangeId: '' },       // 엔트리 없음(새 엣지) — 넣는다
  ]);
  assert.deepEqual([...byTag.entries()], [['tag1', 'e1'], ['tag4', '']]);
  const scanEntries = new Map([['e1', { service: 'DB', datacenterId: 'dc-kr' }]]);
  const remoteScan = new Map([['remote:c1:1', null], ['remote:c1:2', null], ['remote:c1:4', null], ['remote:c1:5', 'e1']]);
  const ctx = { remoteScan, scanEntries, edgeScanByTag: byTag, dcOfServer: () => 'dc-kr' };   // v2.899 E5 — 폴백은 같은 DataCenter 엔트리만
  assert.deepEqual(scanInfoOf({ source: 'remote', serverId: 'remote:c1:1', serviceTag: 'Tag1' }, ctx).scan, { entryId: 'e1', label: 'DB' }, '구버전 수집 서버(null) → 엣지 push 값');
  assert.deepEqual(scanInfoOf({ source: 'remote', serverId: 'remote:c9:9', serviceTag: 'TAG1' }, ctx).scan, { entryId: 'e1', label: 'DB' }, '못 받음(undefined) → 엣지 push 값');
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c1:2', serviceTag: 'TAG2' }, ctx).scanWhy, 'old-source', '태그가 갈리면 폴백하지 않는다');
  assert.equal(scanInfoOf({ source: 'remote', serverId: 'remote:c1:4', serviceTag: 'TAG4' }, ctx).scanWhy, undefined, '새 엣지가 엔트리 없음이라고 보냈으면 수동 등록');
  assert.deepEqual(scanInfoOf({ source: 'remote', serverId: 'remote:c1:5', serviceTag: 'TAG2' }, ctx).scan, { entryId: 'e1', label: 'DB' }, '수집 서버가 준 값이 있으면 그것이 먼저');
  assert.equal(scanInfoOf({ source: 'idrac', serverId: 'x', serviceTag: 'TAG1' }, ctx).scanWhy, undefined, '등록부 서버는 폴백하지 않는다');
});

test('2차 반증 1·R18 둘째 절: 못 받음 · 법인 귀속 없는 이유가 사유와 묶음으로 갈린다', () => {
  const map = mapOf({ A: { services: [S('s1', 'DB')] } });
  const idx = buildIndex(map);
  assert.equal(autoResolve(bm('k5', 'A', { scanWhy: 'not-reported' }), idx).reason, 'source-unreported');
  assert.equal(autoResolve(bm('n1', '', { corpWhy: 'attr-error' }), idx).reason, 'no-corp-error');
  assert.equal(autoResolve(bm('n2', '', { corpWhy: 'tag-conflict' }), idx).reason, 'no-corp-conflict');
  assert.equal(autoResolve(bm('n3', ''), idx).reason, 'no-corp');
  const inv = buildInventory({ members: [bm('k5', 'A', { scanWhy: 'not-reported' }), bm('k3', 'A'), bm('n1', '', { corpWhy: 'attr-error' }), bm('n2', '', { corpWhy: 'tag-conflict' }), bm('n4', '', { corpWhy: 'tag-conflict' }), bm('n3', '')], map });
  const g = Object.fromEntries(inv.queues.unassigned.map((x) => [x.key, [x.kind, x.value, x.n]]));
  assert.deepEqual(g, { 'manual|A|not-reported': ['manual', 'not-reported', 1], 'manual|A|': ['manual', '', 1],
    'nocorp|attr-error': ['nocorp', 'attr-error', 1], 'nocorp|tag-conflict': ['nocorp', 'tag-conflict', 2], nocorp: ['nocorp', '', 1] });
  // 귀속 색인이 충돌 태그를 밝힌다(라우트가 corpWhy 를 정하는 재료)
  const ix = buildVcIndex([{ id: 'a', serviceTag: 'T1', vcenterId: 'vc-a' }, { id: 'b', serviceTag: 't1', vcenterId: 'vc-b' }, { id: 'c', serviceTag: 'T2', vcenterId: 'vc-a' }], [], {});
  assert.equal(ix.conflicts, 1); assert.equal(ix.conflictTags.has('t1'), true); assert.equal(ix.conflictTags.has('t2'), false);
});

test('2차 반증 4: 입력 다시 읽기는 진행 중인 입력 수집이 끝난 뒤 새로 모은다(두 벌이 겹쳐 돌지 않는다) · 429 사유는 새로고침을 안내한다', async () => {
  _resetFreshForTest();
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 31, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms: [] };
    const s0 = _gatherStatsForTest();
    const [a, b] = await Promise.all([
      call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } }),   // 새 세대 — 입력 수집 P1 시작
      call('GET /tools/svc-inventory', { query: { fresh: '1' } }),              // P1 이 도는 중에 다시 읽기 — P2 는 P1 뒤에
    ]);
    assert.equal(a.statusCode, 200, JSON.stringify(a.body)); assert.equal(b.statusCode, 200, JSON.stringify(b.body));
    const s1 = _gatherStatsForTest();
    assert.equal(s1.runs - s0.runs, 2, '다시 읽기는 새로 모은다(진행 중 수집을 그대로 쓰지 않는다)');
    assert.equal(s1.maxInFlight, 1, '두 수집이 겹쳐 돌지 않는다');
    await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a' } });
    assert.equal(_gatherStatsForTest().runs, s1.runs, '같은 세대의 다음 조회는 새로 모으지 않는다');
    const again = await call('GET /tools/svc-inventory', { query: { fresh: '1' } });
    assert.equal(again.statusCode, 429);
    assert.match(again.body.reason, /새로고침하면 그 입력이 보입니다/, '상한은 포탈 전체에 하나 — 다른 사용자가 읽은 입력을 받는 길을 알린다');
    assert.ok(Number.isInteger(again.body.agoSec) && again.body.agoSec >= 0);
  } finally { store.snapshot = prev; _resetFreshForTest(); }
});

test('전 법인 구성원 보기(사용자 요청 2026-11-05): global 만 주면 보이는 범위의 모든 법인 구성원 · 영향 호스트의 함께 떠받치는 서비스에 자기 서비스는 없다', async () => {
  sm._resetForTest();
  const svc = (id, name, globalId = '') => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({
    rev: 0, settings: { tagCategory: '' }, globals: [{ id: 'g1', name: 'NTP', tier: 2, owner: '', note: '' }],
    corps: {
      'vc-a': { folders: [], aliases: [], nameRules: [], tagEnabled: false, services: [svc('a1', 'NTP', 'g1'), svc('a2', 'DB')], folderRules: [{ prefix: '/NTP', serviceId: 'a1' }, { prefix: '/DB', serviceId: 'a2' }] },
      'vc-b': { folders: [], aliases: [], nameRules: [], tagEnabled: false, services: [svc('b1', 'NTP', 'g1')], folderRules: [{ prefix: '/NTP', serviceId: 'b1' }] },
    },
  }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const prev = store.snapshot;
  try {
    const vm = (id, vc, folderPath, host) => ({ id, vcenterId: vc, name: id, folderPath, host, powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 });
    store.snapshot = { ...prev, generatedAt: Date.now() + 41, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }, { id: 'vc-b', name: 'vcenter-b' }], hosts: [],
      vms: [vm('ntp-a1', 'vc-a', '/NTP', 'esx-a1'), vm('ntp-a2', 'vc-a', '/NTP', 'esx-a1'), vm('db-a', 'vc-a', '/DB', 'esx-a1'), vm('ntp-b1', 'vc-b', '/NTP', 'esx-b1')] };
    const all = await call('GET /tools/svc-inventory/members', { query: { global: 'g1' } });
    assert.equal(all.statusCode, 200, JSON.stringify(all.body));
    assert.deepEqual(all.body.members.map((m) => `${m.corp}:${m.name}`).sort(), ['vc-a:ntp-a1', 'vc-a:ntp-a2', 'vc-b:ntp-b1'], '법인을 가리지 않고 한 번에');
    const h = Object.fromEntries(all.body.hosts.map((x) => [`${x.corp}|${x.name}`, x]));
    assert.equal(h['vc-a|esx-a1'].vmHere, 2);
    assert.deepEqual(h['vc-a|esx-a1'].others, ['DB'], '함께 떠받치는 서비스는 다른 서비스만 — 자기(NTP)는 넣지 않는다');
    assert.deepEqual(h['vc-b|esx-b1'].others, [], '전용 호스트');
    const one = await call('GET /tools/svc-inventory/members', { query: { global: 'g1', corp: 'vc-a' } });
    assert.deepEqual(one.body.members.map((m) => m.name).sort(), ['ntp-a1', 'ntp-a2'], '법인별 보기는 그대로');
    assert.deepEqual(one.body.hosts[0].others, ['DB'], '법인별 보기에서도 자기 서비스는 빠진다');
    const scoped = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
    const sc = await call('GET /tools/svc-inventory/members', { user: scoped, query: { global: 'g1' } });
    assert.deepEqual(sc.body.members.map((m) => m.corp), ['vc-a', 'vc-a'], '범위 계정은 자기 법인만(전 법인 보기라도)');
    assert.ok(sc.body.hosts.every((x) => x.corp === 'vc-a'));
  } finally { store.snapshot = prev; }
});

test('v2.899 점검 E4: 엣지의 등록부 밖 장치(OME · 수집 서버 경유)의 빈 scanRangeId 는 수동 등록이 아니라 보고되지 않음', async () => {
  const { edgeScanOf, edgeScanReportable } = await import('../src/routes/api/svcInventory.js');
  const servers = [
    { serverId: 'edge:a:1', edgeSource: 'idrac', serviceTag: 'T1', scanRangeId: '' },   // 등록부 서버 — 빈 값 = 수동 등록
    { serverId: 'edge:a:2', edgeSource: 'ome', serviceTag: 'T2', scanRangeId: '' },     // OME 장치 — 등록부 밖
    { serverId: 'edge:a:3', edgeSource: 'remote', serviceTag: 'T3', scanRangeId: '' },  // 엣지의 수집 서버 경유
    { serverId: 'edge:a:4', edgeSource: '', serviceTag: 'T4', scanRangeId: 'e1' },      // 출처를 모르는 옛 기록 — 받은 값 그대로
  ];
  assert.deepEqual(servers.map(edgeScanReportable), [true, false, false, true]);
  const edgeScan = edgeScanOf(servers);
  const ctx = { edgeScan, scanEntries: new Map([['e1', { service: 'DB', datacenterId: 'dc-kr' }]]), edgeScanByTag: edgeScanByTagOf(servers) };
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:a:1' }, ctx).scanWhy, undefined, '등록부 서버의 빈 값 = 수동 등록');
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:a:2' }, ctx).scanWhy, 'not-reported', 'OME 장치를 수동 등록으로 단정하지 않는다');
  assert.equal(scanInfoOf({ source: 'edge', serverId: 'edge:a:3' }, ctx).scanWhy, 'not-reported');
  assert.deepEqual(scanInfoOf({ source: 'edge', serverId: 'edge:a:4' }, ctx).scan, { entryId: 'e1', label: 'DB' });
  assert.deepEqual([...ctx.edgeScanByTag.keys()].sort(), ['t1', 't4'], '태그 폴백 표에도 등록부 밖 장치를 넣지 않는다');
  // 중앙 fleet 이 엣지 쪽 출처를 보존한다(소스 대조 — getEdgeFleetServers 는 source 를 'edge' 로 덮는다)
  const src = fs.readFileSync(new URL('../src/central/fleet.js', import.meta.url), 'utf8');
  assert.match(src, /edgeSource: typeof b\.source === 'string' \? b\.source : ''/);
});

test('v2.899 점검 E5: 서비스 태그 폴백은 서버 법인의 DataCenter 와 같은 엔트리일 때만', () => {
  const byTag = edgeScanByTagOf([{ serverId: 'edge:a:1', serviceTag: 'TAG1', scanRangeId: 'e1' }, { serverId: 'edge:a:2', serviceTag: 'TAG2', scanRangeId: 'e9' }]);
  const scanEntries = new Map([['e1', { service: 'DB', datacenterId: 'dc-kr' }]]);
  const remoteScan = new Map([['remote:c1:1', null]]);
  const base = { remoteScan, scanEntries, edgeScanByTag: byTag };
  const b = { source: 'remote', serverId: 'remote:c1:1', serviceTag: 'TAG1' };
  assert.deepEqual(scanInfoOf(b, { ...base, dcOfServer: () => 'dc-kr' }).scan, { entryId: 'e1', label: 'DB' }, '같은 DataCenter');
  assert.equal(scanInfoOf(b, { ...base, dcOfServer: () => 'dc-us' }).scan, null, '다른 법인 엔트리는 붙이지 않는다');
  assert.equal(scanInfoOf(b, { ...base, dcOfServer: () => 'dc-us' }).scanWhy, 'old-source');
  assert.equal(scanInfoOf(b, { ...base, dcOfServer: () => '' }).scan, null, '서버 법인의 DataCenter 를 모르면 쓰지 않는다');
  assert.equal(scanInfoOf(b, base).scan, null, 'dcOfServer 없음 = 모름');
  assert.equal(scanInfoOf({ ...b, serviceTag: 'TAG2' }, { ...base, dcOfServer: () => 'dc-kr' }).scanWhy, 'old-source', '중앙에 없는 엔트리는 맞춰 볼 수 없다');
});
