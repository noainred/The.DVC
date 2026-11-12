// 물리서버 폴더 v2.987 — 개선 · 잔여 작업(사용자 '개선 및 잔여작업 수행' · 전체 검증).
//   ① 잔여 위험 완화: 자동 규칙은 '가린 뒤 이름'(태그 걷어 냄 · 주소 이름 제외)으로만 판정 — 규칙 값으로 가린 태그 · 주소를 맞혀 보는 길 차단
//   ② 서비스 인벤토리 연결: 물리서버 폴더 규칙(경로 → 서비스) — 판정 2b 순위(고정 다음 · 스캔 라벨 · 이름 규칙 앞) · 겹침 검토 큐 · 미리보기 · 이름 바꾸기 동기화
//   ③ 화면 지원: 24시간 추이 라우트(범위 · 숫자만) · 입력 다시 읽기(쓰기 계정 · 상한) · 관리 주소(관리자 판본만 · 주소 찾기도 관리자만) · 서비스 연결 표시
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmfolders86-'));
process.env.CONFIG_DIR = tmp;

const bs = await import('../src/bmfolders/store.js');
const { ruleFor, ruleNameOf, sortRules, placeMember } = await import('../src/bmfolders/build.js');
const sm = await import('../src/servicemap/store.js');
const { CORP_OPS } = await import('../src/servicemap/ops.js');
const { buildIndex, autoResolve, bmFolderMatches } = await import('../src/servicemap/resolve.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerBmFolders, downsample, _svcRuleRenameForTest } = await import('../src/routes/api/bmFolders.js');
const svcinv = await import('../src/routes/api/svcInventory.js');

const routes = new Map();
const reg = { get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) };
registerBmFolders(reg); svcinv.registerSvcInventory(reg);
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const OPER = { username: 'op', role: 'operator', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const VIEWER = { username: 'v', role: 'viewer', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {}, shared = false } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}${shared ? '' : `&u=${user.username}`}` }, res);   // shared: 운영처럼 같은 URL(응답 캐시 열쇠만으로 갈려야 한다)
  return res;
}
let gen = 0;
const snapOf = (hosts = []) => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts, vms: [] });
const SRV = (id, name, tag, vc, host) => ({ id, name, host: host || `https://192.0.2.${10 + Number(id.replace(/\D/g, '') || 0)}`, username: 'root', password: 'x', serviceTag: tag, ...(vc ? { vcenterId: vc } : {}) });
const S = (id, name) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '' });
function reset({ svc = {} } = {}) {
  bs._resetForTest(); sm._resetForTest();
  for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true });
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: svc }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a'), SRV('s2', 'kr-db-02', 'TAG2', 'vc-a'), SRV('s3', 'pl-db-01', 'TAG3', 'vc-b')], 'replace');
}
const withSnap = async (fn, hosts = []) => { const prev = store.snapshot; try { store.snapshot = snapOf(hosts); return await fn(); } finally { store.snapshot = prev; } };
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], bmFolderRules: [], tagEnabled: false, ...c });

// ───────── ① 잔여 위험 완화 ─────────
test('① 자동 규칙은 가린 뒤 이름으로만 — 태그 조각 · 주소 이름은 규칙에 걸리지 않는다(맞혀 보는 길 차단) · 보이는 부분은 그대로 걸린다', () => {
  const m = { key: 'st:abc123', kind: 'bm', corp: 'A', name: 'idrac-ABC123-db', serviceTag: 'ABC123' };
  assert.equal(ruleNameOf(m), 'idrac-\u0000-db');
  const rules = sortRules([{ id: 't1', corp: 'A', value: 'abc', path: 'X' }, { id: 't2', corp: 'A', value: 'c-d', path: 'Y' }, { id: 't3', corp: 'A', value: '23-d', path: 'Z' }]);
  assert.equal(ruleFor(m, rules), null, '태그 조각 · 태그를 걸친 값은 걸리지 않는다');
  assert.equal(ruleFor(m, sortRules([{ id: 'ok', corp: 'A', value: '-db', path: 'DB' }]))?.id, 'ok', '보이는 부분은 걸린다');
  assert.equal(ruleFor({ ...m, name: '10.20.31.11', nameIsAddr: true }, sortRules([{ id: 'ip', corp: 'A', value: '10.20', path: 'P' }])), null, '주소 이름은 규칙 대상이 아니다');
  assert.equal(placeMember({ ...m, name: 'kr-web-01' }, {}, sortRules([{ id: 'w', corp: '*', value: 'web', path: 'WEB' }]), true).path, 'WEB');
});

// ───────── ② 서비스 인벤토리 연결(순수) ─────────
test('② 판정: 물리서버 폴더 규칙은 고정 다음 · 스캔 라벨 · 이름 규칙 앞 · 가장 긴 경로 · \\ 경계 · 다른 서비스로 가는 아래 순위는 겹침 · 규칙이 없으면 예전 판정 그대로', () => {
  const map = { corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB'), S('s3', 'ORA')], nameRules: [{ match: 'prefix', value: 'kr-', serviceId: 's1' }],
    bmFolderRules: [{ prefix: 'DB', serviceId: 's2' }, { prefix: 'DB\\Oracle', serviceId: 's3' }] }) } };
  const idx = buildIndex(map);
  const m = { key: 'st:x', kind: 'bm', corp: 'A', name: 'kr-db-01', scan: { entryId: 'e1', label: 'ERP' } };
  const at = (p) => autoResolve(m, idx, { bmFolderOf: new Map([['st:x', p]]) });
  assert.deepEqual([at('DB\\Oracle\\RAC').serviceId, at('DB\\Oracle\\RAC').src, at('DB\\Oracle\\RAC').via], ['s3', 'bmfolder', 'DB\\Oracle'], '가장 긴 경로');
  assert.equal(at('DB').serviceId, 's2');
  assert.deepEqual(at('DB').ruleOverlap, ['scan:ERP'], '스캔 라벨이 다른 서비스 → 겹침');
  assert.equal(at('DB2').serviceId, 's1', "'DB' 는 'DB2' 의 접두가 아니다 — 아래 순위(스캔 라벨 ERP)");
  assert.equal(at('').src, 'scan', '미분류는 규칙 밖');
  assert.equal(autoResolve(m, idx, {}).src, 'scan', '배치를 모르면(null) 규칙을 건너뛴다');
  // 규칙이 하나도 없으면 예전 판정과 같다(업그레이드 뒤 소속이 옮겨 가지 않는다)
  const old = buildIndex({ corps: { A: corpOf({ services: [S('s1', 'ERP')], nameRules: [{ match: 'prefix', value: 'kr-', serviceId: 's1' }] }) } });
  for (const p of ['DB', '', undefined]) assert.deepEqual(autoResolve(m, old, { bmFolderOf: new Map([['st:x', p]]) }), autoResolve(m, old, {}));
  // 아래 순위 자체도 그대로다 — 스캔 라벨이 없으면 이름 규칙(변이 M11: 이름 규칙 결과를 버리면 잡힌다)
  assert.deepEqual([autoResolve({ ...m, scan: null }, old, {}).src, autoResolve({ ...m, scan: null }, old, {}).serviceId], ['rule', 's1']);
  assert.equal(autoResolve({ ...m, scan: null }, idx, { bmFolderOf: new Map([['st:x', '']]) }).src, 'rule');
  assert.equal(bmFolderMatches('DB', 'DB\\X'), true); assert.equal(bmFolderMatches('DB', 'DBX'), false); assert.equal(bmFolderMatches('db', 'DB'), false, '대소문자 구분');
  // 집계 · 검토 큐
  const inv = buildInventory({ members: [m], map, pins: {}, bmFolderOf: new Map([['st:x', 'DB']]) });
  assert.equal(inv.queues.ruleOverlap.length, 1); assert.equal(inv.queues.ruleOverlap[0].src, 'bmfolder');
  // 고정이 먼저
  const pinned = buildInventory({ members: [m], map, pins: { 'st:x': { serviceId: 's1', corp: 'A', by: 'k', at: 1 } }, bmFolderOf: new Map([['st:x', 'DB']]) });
  assert.equal(pinned.resolved.get('st:x').src, 'pin'); assert.equal(pinned.resolved.get('st:x').drift, true);
});

test('② 저장 · 연산: 경로 규약 · 같은 경로 하나 · 대상 바꾸기 · 서비스 삭제가 규칙도 지운다 · 루트 경로 거부', () => {
  const n = sm.normalizeMap({ corps: { A: { services: [S('s1', 'ERP')], bmFolderRules: [{ prefix: 'DB', serviceId: 's1' }, { prefix: 'DB', serviceId: 's1' }, { prefix: '', serviceId: 's1' }, { prefix: 'X', serviceId: 'nope' }, { prefix: 7, serviceId: 's1' }] } } });
  assert.deepEqual(n.corps.A.bmFolderRules, [{ prefix: 'DB', serviceId: 's1' }]);
  const d = JSON.parse(JSON.stringify({ corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB')] }) } }));
  assert.equal(CORP_OPS['bmrule.add'](d, { corp: 'A', prefix: '', serviceId: 's1' }).error ? true : false, true);
  assert.equal(CORP_OPS['bmrule.add'](d, { corp: 'A', prefix: 'DB\\Oracle', serviceId: 's1' }).result.prefix, 'DB\\Oracle');
  assert.equal(CORP_OPS['bmrule.add'](d, { corp: 'A', prefix: 'DB\\Oracle', serviceId: 's2' }).status, 409);
  assert.equal(CORP_OPS['bmrule.update'](d, { corp: 'A', prefix: 'DB\\Oracle', serviceId: 's2' }).result.from, 's1');
  assert.equal(CORP_OPS['service.remove'](d, { corp: 'A', id: 's2' }).result.rulesRemoved, 1);
  assert.equal(d.corps.A.bmFolderRules.length, 0);
});

// ───────── ② 라우트 ─────────
test('② 라우트: 물리서버 폴더에 넣으면 서비스 인벤토리 소속이 따라온다(세대 열쇠) · 미리보기 · 이름 바꾸기가 규칙 경로를 옮긴다 · 폴더 화면에 연결 표시', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB')] }) } });
  await withSnap(async () => {
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: ['st:tag1'] } });
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'bmrule.add', corp: 'vc-a', prefix: 'DB', dry: true } });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body)); assert.equal(dry.body.result.members, 1);
    assert.deepEqual(dry.body.result.from, [{ serviceId: null, n: 1 }]);
    const add = await call('POST /tools/svc-inventory/op', { body: { op: 'bmrule.add', corp: 'vc-a', prefix: 'DB', serviceId: 's2' } });
    assert.equal(add.statusCode, 200, JSON.stringify(add.body));
    let mem = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', service: 's2' } });
    assert.deepEqual(mem.body.members.map((x) => [x.name, x.src, x.via]), [['kr-db-01', 'bmfolder', 'DB']]);
    // 물리서버 폴더 쪽 등록만 바뀌어도(서비스 인벤토리 저장소는 그대로) 소속이 따라온다 — 판정 memo · 응답 캐시 열쇠에 물리서버 폴더 세대
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: ['st:tag2'] } });
    mem = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', service: 's2' } });
    assert.deepEqual(mem.body.members.map((x) => x.name).sort(), ['kr-db-01', 'kr-db-02']);
    const main = await call('GET /tools/svc-inventory');
    const ca = main.body.corps.find((c) => c.vcenterId === 'vc-a');
    assert.deepEqual(ca.bmFolderRules, [{ prefix: 'DB', serviceId: 's2' }]);
    assert.deepEqual(ca.bmFolders, ['DB', 'DB\\Oracle']);
    const g = await call('GET /tools/bm-folders');
    assert.deepEqual(g.body.svcLinks['vc-a'], [{ prefix: 'DB', serviceId: 's2', service: 'DB' }]);
    // 이름 바꾸기 → 서비스 인벤토리 규칙 경로도 함께
    const rn = await call('POST /tools/bm-folders/op', { body: { op: 'folder.rename', corp: 'vc-a', path: 'DB', name: '데이터베이스' } });
    assert.equal(rn.body.result.svcRules, 1);
    assert.deepEqual(sm.peekMap().corps['vc-a'].bmFolderRules, [{ prefix: '데이터베이스', serviceId: 's2' }]);
    mem = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', service: 's2' } });
    assert.equal(mem.body.members.length, 2, '이름을 바꿔도 소속이 풀리지 않는다');
    // 삭제는 서비스 쪽 규칙을 지우지 않고 개수를 밝힌다
    const rm = await call('POST /tools/bm-folders/op', { body: { op: 'folder.remove', corp: 'vc-a', path: '데이터베이스', expect: 2 } });
    assert.equal(rm.body.result.svcRules, 1); assert.equal(sm.peekMap().corps['vc-a'].bmFolderRules.length, 1);
  });
});

test('② 물리서버 폴더 저장소가 손상이면 그 규칙을 건너뛴다(모르는 배치로 판정하지 않음) · 미리보기는 503', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s2', 'DB')], bmFolderRules: [{ prefix: 'DB', serviceId: 's2' }] }) } });
  await withSnap(async () => { await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: ['st:tag1'] } }); });
  bs.flushStore(); bs._resetForTest();
  fs.writeFileSync(path.join(tmp, 'bm-folders-assign.json'), '{ broken');
  await withSnap(async () => {
    const mem = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', service: 's2' } });
    assert.equal(mem.body.members.length, 0);
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'bmrule.add', corp: 'vc-a', prefix: 'DB', dry: true } });
    assert.equal(dry.statusCode, 503);
  });
});

// ───────── ③ 화면 지원 ─────────
test('③ 24시간 추이: 범위 밖 · 모르는 키 404 · 범위 계정은 토큰만 · ESXi 는 이유 · 숫자 · 시각만 · 못 읽은 값은 null 로 남는다', async () => {
  reset();
  await withSnap(async () => {
    assert.equal((await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' }, user: SCOPED })).statusCode, 404, '범위 밖');
    assert.equal((await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag1' }, user: SCOPED })).statusCode, 404, '범위 계정은 원문 키를 받지 않는다');
    const g = await call('GET /tools/bm-folders', { user: SCOPED });
    const tok = g.body.servers.find((x) => x.name === 'kr-db-01').key;
    // 범위 밖 서버의 토큰을 손에 넣어도(같은 프로세스 HMAC) 범위 안 후보에서만 되돌린다 — 404(변이 M10: 범위 필터를 빼면 잡힌다)
    const { maskedIdToken } = await import('../src/auth/addressMask.js');
    assert.equal((await call('GET /tools/bm-folders/trend', { query: { key: maskedIdToken('st:tag3') }, user: SCOPED })).statusCode, 404);
    const r = await call('GET /tools/bm-folders/trend', { query: { key: tok }, user: SCOPED });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.ok(Array.isArray(r.body.rows));
    const e = await call('GET /tools/bm-folders/search', { query: { inc: 'esx', kinds: 'esxi' } });
    const er = await call('GET /tools/bm-folders/trend', { query: { key: e.body.rows[0].key } });
    assert.equal(er.body.why, 'esxi');
  }, [{ id: 'h1', name: 'esx-01', vcenterId: 'vc-a', serviceTag: 'HT1' }]);
  const ds = downsample(Array.from({ length: 10 }, (_, i) => ({ ts: i, cpu: i % 2 ? null : i * 10, mem: null })), 5);
  assert.equal(ds.length, 5); assert.ok(ds.every((x) => x.mem === null), '못 읽은 값은 0 이 아니라 null');
  assert.deepEqual(ds.map((x) => x.cpu), [0, 20, 40, 60, 80]);
});

test('③ 입력 다시 읽기: 조회 계정 403 · 쓰기 계정은 상한 안에서 429(대기 초) · 관리 주소는 관리자 판본만 · 주소 찾기도 관리자만', async () => {
  reset();
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a', 'https://10.20.31.11/redfish'), SRV('s2', 'kr-db-02', 'TAG2', 'vc-a')], 'replace');
  svcinv._resetFreshForTest();
  await withSnap(async () => {
    assert.equal((await call('GET /tools/bm-folders', { user: VIEWER, query: { fresh: '1' } })).statusCode, 403);
    assert.equal((await call('GET /tools/bm-folders', { user: OPER, query: { fresh: '1' } })).statusCode, 200);
    const again = await call('GET /tools/bm-folders', { user: OPER, query: { fresh: '1' } });
    assert.equal(again.statusCode, 429); assert.ok(again.body.waitSec > 0);
    const adm = await call('GET /tools/bm-folders');
    assert.equal(adm.body.servers.find((x) => x.name === 'kr-db-01').addr, '10.20.31.11');
    const op = await call('GET /tools/bm-folders', { user: OPER });
    assert.equal(op.body.servers.find((x) => x.name === 'kr-db-01').addr, undefined);
    assert.equal(/10\.20\.31\.11/.test(JSON.stringify(op.body)), false);
    assert.equal((await call('GET /tools/bm-folders/search', { query: { inc: '10.20', fields: 'addr' } })).body.total, 1);
    assert.equal((await call('GET /tools/bm-folders/search', { user: OPER, query: { inc: '10.20', fields: 'addr' } })).body.total, 0, '비관리자는 주소로 찾지 않는다');
  });
});

test('③ 추이 경로: 서버 비교와 같은 해석 — 이 노드 수집은 로컬 계열 · 엣지 수집은 그 엣지에서 서버당 1요청 · 구버전/실패 이유 · 범위 계정은 엣지 사유를 싣지 않음 · 못 읽은 칸은 null', async () => {
  const { _setTrendDepsForTest, sparkRows } = await import('../src/routes/api/bmFolders.js');
  assert.deepEqual(sparkRows({ metrics: { cpu_pct: { spark: [[2, 10, 20], [1, null, null]] }, mem_pct: { spark: [[1, 30, 40], ['x', 1, 1]] } } }),
    [{ ts: 1, cpu: null, mem: 30 }, { ts: 2, cpu: 10, mem: null }]);
  reset();
  const calls = [];
  const deps = (via, edge) => ({
    resolvePerfTarget: async (req, tg, o) => { calls.push(['resolve', o.key, o.vcenterId]); return { via, agent: 'pl-edge', realKey: o.key, target: { vcenterId: o.vcenterId } }; },
    perfTargetFail: () => null, targets: {},
    localSeries: async (o) => { calls.push(['local', o.key, o.q.metrics]); return { ok: true, metrics: { cpu_pct: { spark: [[1000, 12, 20]] }, mem_pct: { spark: [[1000, 40, 41]] } } }; },
    edgeSeries: async (agent, o) => { calls.push(['edge', agent, o.metrics.join(',')]); return edge; },
  });
  try {
    await withSnap(async () => {
      _setTrendDepsForTest(deps('local'));
      const a = await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag1' } });
      assert.deepEqual([a.body.via, a.body.rows], ['local', [{ ts: 1000, cpu: 12, mem: 40 }]]);
      assert.deepEqual(calls.slice(0, 2), [['resolve', 'TAG1', 'vc-a'], ['local', 'TAG1', 'cpu_pct,mem_pct']], '대상 키 = 베어메탈 사용률 키(idOf) · 법인 쌍');
      _setTrendDepsForTest(deps('edge', { ok: false, kind: 'old-version', reason: "엣지 'pl-edge' 가 구버전입니다" }));
      const o = await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } });
      assert.deepEqual([o.body.why, /pl-edge/.test(o.body.reason)], ['old-version', true]);
      const tok = (await call('GET /tools/bm-folders', { user: { ...SCOPED, scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } } })).body.servers[0].key;
      const so = await call('GET /tools/bm-folders/trend', { query: { key: tok }, user: { ...SCOPED, scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } } });
      assert.equal(so.body.reason, undefined, '범위 계정에는 엣지 사유(엣지 이름)를 싣지 않는다');
      _setTrendDepsForTest(deps('edge', { ok: true, body: { metrics: { cpu_pct: { spark: [[5, null, null]] }, mem_pct: { spark: [[5, null, null]] } } } }));
      const e = await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } });
      assert.deepEqual([e.body.via, e.body.why, e.body.rows], ['edge', 'none', [{ ts: 5, cpu: null, mem: null }]], '값이 하나도 없으면 none(0 으로 그리지 않는다)');
      assert.ok(calls.some((c) => c[0] === 'edge' && c[1] === 'pl-edge' && c[2] === 'cpu_pct,mem_pct'));
    });
  } finally { _setTrendDepsForTest(null); }
});

// ───────── 2차 반증 반영(v2.987 — 전체 검증) ─────────
const SCOPED_ADMIN = { username: 'adm-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };

test('반증2-1 범위 지정 관리자 판본: 관리 주소 속 태그(idrac-<태그>)를 가린다 · 주소로 찾기는 전체 범위 관리자만 · 응답 어디에도 태그가 없다', async () => {
  reset();
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a', 'https://idrac-TAG1.corp.local/redfish'), SRV('s2', 'kr-db-02', 'TAG2', 'vc-a')], 'replace');
  await withSnap(async () => {
    const full = await call('GET /tools/bm-folders');
    assert.equal(full.body.servers.find((x) => x.name === 'kr-db-01').addr, 'idrac-TAG1.corp.local', '전체 범위 관리자는 원문');
    const sa = await call('GET /tools/bm-folders', { user: SCOPED_ADMIN });
    assert.equal(sa.body.servers.find((x) => x.name === 'kr-db-01').addr, 'idrac-•••.corp.local');
    assert.equal(/tag1/i.test(JSON.stringify(sa.body)), false, '범위 판본 응답 어디에도 태그가 없다');
    assert.equal((await call('GET /tools/bm-folders/search', { query: { inc: 'idrac-tag1', fields: 'addr' } })).body.total, 1);
    const ss = await call('GET /tools/bm-folders/search', { user: SCOPED_ADMIN, query: { inc: 'idrac-tag1', fields: 'addr' } });
    assert.equal(ss.body.total, 0, '범위 판본은 주소로 찾지 않는다(가린 태그를 맞혀 보는 길)');
    assert.equal((await call('GET /tools/bm-folders/search', { user: SCOPED_ADMIN, query: { inc: 'idrac', fields: 'addr' } })).body.total, 0);
  });
});

test('반증2-2 이름 바꾸기: 바뀐 경로에 다른 서비스 인벤토리 규칙이 있으면 409 — 폴더 · 등록 · 규칙 어느 것도 바뀌지 않는다', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB')], bmFolderRules: [{ prefix: 'DB', serviceId: 's2' }, { prefix: 'DB\\Oracle', serviceId: 's2' }, { prefix: 'X\\Oracle', serviceId: 's1' }] }) } });
  await withSnap(async () => {
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: ['st:tag1'] } });
    const before = JSON.stringify([bs.peekMain(), bs.peekAssign(), sm.peekMap().corps['vc-a'].bmFolderRules]);
    const rn = await call('POST /tools/bm-folders/op', { body: { op: 'folder.rename', corp: 'vc-a', path: 'DB', name: 'X' } });
    assert.equal(rn.statusCode, 409, JSON.stringify(rn.body)); assert.match(rn.body.reason, /X\\Oracle/);
    assert.equal(JSON.stringify([bs.peekMain(), bs.peekAssign(), sm.peekMap().corps['vc-a'].bmFolderRules]), before, '아무것도 쓰지 않았다');
    // 겹침이 없으면 규칙이 모두 옮겨 가고 응답이 옮긴 수를 밝힌다(화면 알림은 이 값으로 — 미리 센 값 아님)
    const ok = await call('POST /tools/bm-folders/op', { body: { op: 'folder.rename', corp: 'vc-a', path: 'DB', name: 'Y' } });
    assert.equal(ok.statusCode, 200); assert.equal(ok.body.result.svcRules, 2);
    assert.deepEqual(sm.peekMap().corps['vc-a'].bmFolderRules.map((r) => r.prefix).sort(), ['X\\Oracle', 'Y', 'Y\\Oracle']);
  });
});

test('반증2-3 서비스 인벤토리 도구가 막힌 계정: 규칙이 걸린 폴더 이름 바꾸기 403(아무것도 안 바뀜) · 규칙 없는 폴더는 된다 · 서비스 연결(svcLinks)을 싣지 않는다', async () => {
  const perm = await import('../src/auth/permissions.js');
  reset({ svc: { 'vc-a': corpOf({ services: [S('s2', 'DB')], bmFolderRules: [{ prefix: 'DB', serviceId: 's2' }] }) } });
  assert.equal(perm.setUserTools('op', { mode: 'deny', tools: ['svc-inventory'] }).ok, true);
  try {
    await withSnap(async () => {
      await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: ['st:tag1'] } });
      await call('POST /tools/bm-folders/op', { body: { op: 'folder.add', corp: 'vc-a', path: 'WEB' } });
      const g = await call('GET /tools/bm-folders', { user: OPER, shared: true });
      assert.deepEqual(g.body.svcLinks, {}, '도구 접근이 없으면 서비스 이름을 싣지 않는다');
      const g2 = await call('GET /tools/bm-folders', { user: { ...OPER, username: 'op2' }, shared: true });
      assert.deepEqual(g2.body.svcLinks['vc-a'].map((x) => x.service), ['DB'], '같은 역할 · 범위라도 도구 접근이 다르면 캐시가 갈린다');
      assert.deepEqual((await call('GET /tools/bm-folders')).body.svcLinks['vc-a'].map((x) => x.service), ['DB'], '관리자는 그대로(캐시 열쇠가 갈린다)');
      const rn = await call('POST /tools/bm-folders/op', { user: OPER, body: { op: 'folder.rename', corp: 'vc-a', path: 'DB', name: 'DB2' } });
      assert.equal(rn.statusCode, 403, JSON.stringify(rn.body));
      assert.deepEqual(sm.peekMap().corps['vc-a'].bmFolderRules.map((r) => r.prefix), ['DB']);
      assert.ok(bs.peekMain().corps['vc-a'].folders.includes('DB'));
      assert.equal((await call('POST /tools/bm-folders/op', { user: OPER, body: { op: 'folder.rename', corp: 'vc-a', path: 'WEB', name: 'WEB2' } })).statusCode, 200, '규칙이 없으면 된다');
    });
  } finally { perm.setUserTools('op', { mode: 'off' }); }
});

test('반증2-2b 이름 바꾸기 저장 단계(심층 방어): 사전 검사 뒤 겹침이 생겼으면 버리지 않고 409 · 규칙은 그대로', () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'DB')], bmFolderRules: [{ prefix: 'DB', serviceId: 's2' }, { prefix: 'X', serviceId: 's1' }] }) } });
  const r = _svcRuleRenameForTest('vc-a', 'DB', (x) => (x === 'DB' || x.startsWith('DB\\') ? `X${x.slice(2)}` : x));
  assert.equal(r.n, 0); assert.ok(r.error);
  assert.deepEqual(sm.peekMap().corps['vc-a'].bmFolderRules.map((x) => x.prefix), ['DB', 'X'], '옮기던 규칙을 버리지 않았다');
});

test('반증2-4 규칙 미리보기: 더 긴 기존 규칙이 잡은 서버는 옮겨 갈 대수에 넣지 않는다(kept) · 경로는 저장과 같은 정리를 거친다', async () => {
  reset({ svc: { 'vc-a': corpOf({ services: [S('s2', 'DB'), S('s3', 'ORA')], bmFolderRules: [{ prefix: 'DB\\Oracle', serviceId: 's3' }] }) } });
  await withSnap(async () => {
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: ['st:tag1'] } });
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: ['st:tag2'] } });
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'bmrule.add', corp: 'vc-a', prefix: ' DB ', dry: true } });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body));
    assert.deepEqual([dry.body.result.prefix, dry.body.result.members, dry.body.result.kept, dry.body.result.from], ['DB', 2, 1, [{ serviceId: null, n: 1 }]]);
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'bmrule.add', corp: 'vc-a', prefix: 'DB\\\\', dry: true } })).statusCode, 400, '빈 단계는 저장처럼 거부');
  });
});

test('반증2-5 stripTag: 길이가 바뀌는 소문자화(İ)가 앞에 있어도 태그 자리를 정확히 가린다', () => {
  assert.equal(svcinv.stripTag('İİ-ABC123', 'abc123'), 'İİ-•••');
  assert.equal(svcinv.stripTag('İdrac-ABC123.corp', 'ABC123'), 'İdrac-•••.corp');
  assert.equal(svcinv.stripTag('x-abc123-ABC123', 'Abc123'), 'x-•••-•••');
  assert.equal(svcinv.stripTag('no-tag', ''), 'no-tag');
});

test('반증2-추이: 같은 (엣지, 서버, 구간)은 합쳐 한 번만 당긴다(진행 중 공유 · 성공 기억) · 실패 사유는 전체 범위 관리자에게만', async () => {
  const { _setTrendDepsForTest } = await import('../src/routes/api/bmFolders.js');
  reset();
  let n = 0; let release; const gate = new Promise((r) => { release = r; });
  const deps = (edge) => ({ resolvePerfTarget: async (req, tg, o) => ({ via: 'edge', agent: 'pl-edge', realKey: o.key, target: { vcenterId: o.vcenterId } }), perfTargetFail: () => null, targets: {},
    localSeries: async () => ({ ok: false }), edgeSeries: async () => { n += 1; await gate; return edge; } });
  try {
    await withSnap(async () => {
      _setTrendDepsForTest(deps({ ok: true, body: { metrics: { cpu_pct: { spark: [[5, 10, 10]] }, mem_pct: { spark: [[5, 20, 20]] } } } }));
      const p = [call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } }), call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } })];
      await new Promise((r) => setImmediate(r)); release();
      const [a, b] = await Promise.all(p);
      assert.deepEqual([a.body.rows, b.body.rows], [[{ ts: 5, cpu: 10, mem: 20 }], [{ ts: 5, cpu: 10, mem: 20 }]]);
      await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } });
      assert.equal(n, 1, '진행 중 · 60초 안 같은 요청은 WAN 1회');
      await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3', hours: '48' } });
      assert.equal(n, 2, '구간이 다르면 따로');
      _setTrendDepsForTest(deps({ ok: false, kind: 'error', reason: 'fetch failed https://10.9.9.9:8443' }));
      const op = await call('GET /tools/bm-folders/trend', { user: OPER, query: { key: 'st:tag3' } });
      assert.deepEqual([op.body.why, op.body.reason], ['edge-fail', undefined], '운영자(관리자 아님)에게는 엣지 주소가 든 사유를 싣지 않는다');
      const ad = await call('GET /tools/bm-folders/trend', { query: { key: 'st:tag3' } });
      assert.match(ad.body.reason, /10\.9\.9\.9/, '전체 범위 관리자는 진단용으로 받는다(실패도 잠깐 합친다)');
    });
  } finally { _setTrendDepsForTest(null); }
});
