// 서비스 인벤토리 5차 검토 1차 반영 — docs/design/service-map/README.md §5차 검토(사용자 '권장안대로 전부 가고, 1차부터').
//   R1 고정 파일은 설정 변경 감시 밖 · R8 '고정 유지' 는 그때의 자동 판정과 같은 드리프트만 가린다 · R2 등록 해제된 vCenter 법인 항목 ·
//   R3 개명 시 옛 이름 별칭 · R4 별칭 ↔ 서비스명 충돌 · M1 백업은 법인 Director 기준 · M6 후보·CSV 503 · M3/R9 불필요한 고정 법인 필터.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r5-'));
process.env.CONFIG_DIR = tmp;

const { buildIndex, resolveMember, autoResolve } = await import('../src/servicemap/resolve.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const { CORP_OPS } = await import('../src/servicemap/ops.js');
const backup = await import('../src/backup/service.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory } = await import('../src/routes/api/svcInventory.js');

const S = (id, name, extra = {}) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '', ...extra });
function mapOf(corps = {}) {
  const out = { rev: 0, corps: {}, globals: [], settings: { tagCategory: '' } };
  for (const [vc, c] of Object.entries(corps)) out.corps[vc] = { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c };
  return out;
}
const vm = (key, corp, folderPath, extra = {}) => ({ key, kind: 'vm', corp, name: key, folderPath, powered: true, cores: 4, memGB: 16, storageGB: 100, usage: { state: 'ok', cpuPct: 50, memPct: 50, src: 'vcenter' }, ...extra });
const bm = (key, corp, scan, extra = {}) => ({ key, kind: 'bm', corp, name: key, scan, powered: true, cores: 32, memGB: 256, usage: { state: 'ok', cpuPct: 20, memPct: 40, src: 'idrac' }, faults: 0, ...extra });

// 라우트를 미들웨어 없이 마지막 핸들러로 직접 부른다(권한 미들웨어는 다른 테스트가 본다).
const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {} }, res);
  return res;
}
function writeStore(map, pins = {}) {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify(map));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins }));
}

test('R1: 고정 파일만 바뀌면 설정 지문이 같다(자동 백업 없음) · 서비스·규칙 파일은 감시 대상 · 고정 파일도 백업 번들에는 들어간다', () => {
  const base = { 'vcenters.json': '[{"id":"a"}]', 'service-map.json': '{"rev":1}', 'service-map-pins.json': '{"rev":1,"pins":{}}' };
  const fp1 = backup.settingsFingerprint(base);
  assert.equal(fp1, backup.settingsFingerprint({ ...base, 'service-map-pins.json': '{"rev":2,"pins":{"vm:1":{"serviceId":"s1","corp":"A"}}}' }), '고정 한 건으로 change 백업이 생기지 않는다');
  assert.notEqual(fp1, backup.settingsFingerprint({ ...base, 'service-map.json': '{"rev":2}' }), '서비스·규칙 변경은 여전히 설정 변경');
  assert.equal(backup.isChangeWatchExcluded('service-map-pins.json'), true);
  assert.equal(backup.isChangeWatchExcluded('service-map.json'), false);
  assert.equal(backup.isRuntimeStateFile('service-map-pins.json'), false, '상태 파일이 아니다 — 번들·복원 대상에서 빼지 않는다');
});

test('R8: 고정 유지는 그때의 자동 판정과 같은 드리프트만 가린다 · 자동 판정이 바뀌면 다시 묻는다 · 옛 표지(reviewedAuto 없음)는 한 번 다시 묻는다', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP'), S('s2', 'MES'), S('s3', 'DB')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }, { prefix: '/DB', serviceId: 's3' }] } });
  const idx = buildIndex(map);
  const pin = (extra) => ({ k1: { serviceId: 's2', corp: 'A', ...extra } });
  assert.equal(resolveMember(vm('k1', 'A', '/ERP'), idx, {}, pin({ reviewed: true, reviewedAuto: 's1' })).drift, false, '같은 드리프트는 다시 묻지 않는다');
  const moved = resolveMember(vm('k1', 'A', '/DB'), idx, {}, pin({ reviewed: true, reviewedAuto: 's1' }));
  assert.equal(moved.drift, true, '자동 판정이 s1 → s3 로 바뀌면 다시 드리프트(예전에는 영원히 숨었다)');
  assert.deepEqual(moved.driftChanged, { reviewedAuto: 's1' });
  assert.equal(resolveMember(vm('k1', 'A', '/ERP'), idx, {}, pin({ reviewed: true })).drift, true, 'reviewedAuto 가 없는 옛 표지는 모르는 것 — 같다고 보지 않는다');
  assert.equal(resolveMember(vm('k1', 'A', '/ERP'), idx, {}, pin({ reviewed: true, reviewedAuto: null })).drift, true, '검토 때 자동 판정이 없었으면 새로 생긴 자동 판정은 새 드리프트');
  assert.equal(resolveMember(vm('k1', 'A', '/none'), idx, {}, pin({ reviewed: true, reviewedAuto: 's1' })).drift, false, '자동 판정이 없으면 드리프트가 아니다(예전과 같다)');
  // 저장소 정규화가 reviewedAuto 를 지킨다 — 검토하지 않은 고정에는 싣지 않는다
  const n = sm.normalizePins({ pins: { a: { serviceId: 's2', corp: 'A', reviewed: true, reviewedAuto: 's1' }, b: { serviceId: 's2', corp: 'A', reviewed: true, reviewedAuto: null }, c: { serviceId: 's2', corp: 'A', reviewedAuto: 's1' }, d: { serviceId: 's2', corp: 'A', reviewed: true, reviewedAuto: 7 } } });
  assert.equal(n.pins.a.reviewedAuto, 's1'); assert.equal(n.pins.b.reviewedAuto, null);
  assert.equal('reviewedAuto' in n.pins.c, false); assert.equal('reviewedAuto' in n.pins.d, false, '문자열·null 이 아니면 버린다');
});

test('R2: 스냅샷에 없는 vCenter 의 법인 행은 orphan · 그 법인 고정은 유령이 아니라 orphaned · 스냅샷 vCenter 0개면 판단하지 않는다', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')] }, GONE: { services: [S('g1', 'Old')] } });
  const pins = { 'vm:x': { serviceId: 'g1', corp: 'GONE', by: 'u', at: 1 }, 'vm:y': { serviceId: 's1', corp: 'A', by: 'u', at: 1 } };
  const inv = buildInventory({ members: [vm('vm:1', 'A', '/ERP')], map, pins, knownCorps: new Set(['A']) });
  assert.deepEqual(inv.corps.map((c) => [c.vcenterId, c.orphan]), [['A', false], ['GONE', true]]);
  assert.deepEqual(inv.queues.orphaned.map((x) => x.key), ['vm:x']);
  assert.deepEqual(inv.queues.ghosts.map((x) => x.key), ['vm:y'], '살아 있는 법인의 사라진 키는 그대로 유령');
  const noSnap = buildInventory({ members: [], map, pins, knownCorps: null });
  assert.equal(noSnap.corps.some((c) => c.orphan), false, '수집 전(스냅샷 vCenter 0개)에는 모두를 등록 해제로 보지 않는다');
  assert.equal(noSnap.queues.orphaned.length, 0);
});

test('R3: 개명 시 고른 종류만 옛 이름을 별칭으로 남긴다 — 남기면 스캔 라벨·태그 소속이 유지되고, 안 남기면 끊긴다 · 영향 대수(byName)', () => {
  const d = mapOf({ A: { services: [S('s1', 'DB')], tagEnabled: true } });
  d.settings.tagCategory = 'Service';
  const members = [bm('st:1', 'A', { entryId: 'e1', label: 'DB' }), bm('st:2', 'A', { entryId: 'e1', label: 'DB' }), vm('vm:1', 'A', '/x', { tags: ['DB'] })];
  const before = buildInventory({ members, map: d });
  assert.deepEqual(before.services[0].stat.byName, { scan: 2, tag: 1 }, '서비스 이름으로 걸린 대수 — 개명하면 끊긴다');
  const keep = structuredClone(d);
  const r = CORP_OPS['service.update'](keep, { corp: 'A', id: 's1', name: 'Database', keepAlias: ['scan', 'tag', 'bogus'] });
  assert.deepEqual(r.result.keepAlias, { added: ['scan', 'tag'], skipped: [] });
  const idxK = buildIndex(keep);
  assert.equal(autoResolve(members[0], idxK).serviceId, 's1', '라벨 DB 는 별칭으로 계속 s1');
  assert.equal(autoResolve(members[2], idxK, { tagCategory: 'Service' }).serviceId, 's1');
  const drop = structuredClone(d);
  CORP_OPS['service.update'](drop, { corp: 'A', id: 's1', name: 'Database' });
  assert.equal(autoResolve(members[0], buildIndex(drop)).reason, 'scan-label-unmapped', '별칭 없이 바꾸면 끊긴다(사람이 고른 결과)');
  // 대소문자만 바꾸면 별칭을 만들지 않는다(같은 이름) · 이미 다른 서비스 별칭이면 건너뛴다
  const caseOnly = structuredClone(d);
  assert.equal(CORP_OPS['service.update'](caseOnly, { corp: 'A', id: 's1', name: 'db', keepAlias: ['scan'] }).result.keepAlias, undefined);
  assert.equal(caseOnly.corps.A.aliases.length, 0);
});

test('R4: 별칭 ↔ 서비스명 충돌은 409 — 다른 서비스 이름과 같은 별칭 · 다른 서비스 별칭과 같은 이름(만들기·바꾸기) · 자기 이름과 같은 별칭은 필요 없음', () => {
  const d = mapOf({ A: { services: [S('s1', 'DB-Oracle'), S('s2', 'DB'), S('s3', '파일서버')], aliases: [{ kind: 'scan', value: 'Files', serviceId: 's3' }] } });
  const r1 = CORP_OPS['alias.add'](d, { corp: 'A', kind: 'scan', value: 'db', serviceId: 's1' });
  assert.equal(r1.status, 409); assert.match(r1.error, /서비스 'DB' 의 이름/);
  assert.deepEqual(CORP_OPS['alias.add'](d, { corp: 'A', kind: 'scan', value: 'db', serviceId: 's2' }).result, { kind: 'scan', value: 'db', same: true, byName: true });
  assert.equal(d.corps.A.aliases.length, 1, '자기 이름 별칭은 만들지 않는다');
  const r2 = CORP_OPS['service.add'](d, { corp: 'A', name: 'files' });
  assert.equal(r2.status, 409); assert.match(r2.error, /'파일서버' 의 스캔 라벨 별칭/);
  assert.equal(CORP_OPS['service.update'](d, { corp: 'A', id: 's1', name: 'FILES' }).status, 409);
  assert.equal(CORP_OPS['service.update'](d, { corp: 'A', id: 's3', name: 'Files' }).error, undefined, '자기 별칭과 같은 이름으로는 바꿀 수 있다');
  // 서비스로 만들기(값 = 이름)는 별칭을 따로 만들지 않고 이름으로 건다
  const d2 = mapOf({ A: {} });
  const r3 = CORP_OPS['service.createLinked'](d2, { corp: 'A', kind: 'scan', value: 'Backup', name: 'Backup' });
  assert.ok(r3.result.service); assert.equal(d2.corps.A.aliases.length, 0);
  assert.equal(autoResolve(bm('st:9', 'A', { entryId: 'e', label: 'backup' }), buildIndex(d2)).src, 'scan');
});

test('M1: 백업 칸 — 매핑 없는 법인 VM(undefined)은 해당 없음(na)으로 세고 잡 없음·모름과 섞지 않는다', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } });
  const inv = buildInventory({ members: [vm('v1', 'A', '/ERP', { backup: undefined }), vm('v2', 'A', '/ERP', { backup: 'none' }), vm('v3', 'A', '/ERP', { backup: null }), vm('v4', 'A', '/ERP', { backup: 'ok' })], map });
  assert.deepEqual(inv.services[0].stat.backup, { ok: 1, fail: 0, none: 1, unknown: 1, na: 1 });
});

test('M3/R9: 불필요한 고정은 법인·이름과 함께 목록으로 — 정리 버튼이 키를 쓴다', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] }, B: { services: [S('b1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 'b1' }] } });
  const pins = { a1: { serviceId: 's1', corp: 'A' }, b1: { serviceId: 'b1', corp: 'B' } };
  const inv = buildInventory({ members: [vm('a1', 'A', '/ERP'), vm('b1', 'B', '/ERP')], map, pins });
  assert.deepEqual(inv.queues.redundant.map((x) => [x.key, x.corp, x.serviceId]), [['a1', 'A', 's1'], ['b1', 'B', 'b1']]);
});

test('M6: 손상 저장소면 후보·CSV 도 503(빈 트리 기준으로 답하지 않는다)', async () => {
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), '{ broken');
  for (const k of ['GET /tools/svc-inventory/candidates', 'GET /tools/svc-inventory.csv']) {
    const r = await call(k, { query: { kind: 'vm' } });
    assert.equal(r.statusCode, 503, k); assert.equal(r.body.error, 'registryUnreadable');
  }
  sm.resetCorrupt();
});

test('R2: 법인 항목 정리(corp.purge) — 전체 범위 관리자 · 등록 해제된 vCenter 만 · dry 는 개수만 · 스냅샷이 비면 판단 거부', async () => {
  writeStore(mapOf({ 'vc-a': { services: [S('s1', 'ERP')] }, 'vc-gone': { services: [S('g1', 'Old'), S('g2', 'Old2')], folders: ['x'], folderRules: [{ prefix: '/Old', serviceId: 'g1' }] } }),
    { 'vm:1': { serviceId: 'g1', corp: 'vc-gone', by: 'u', at: 1 }, 'vm:2': { serviceId: 's1', corp: 'vc-a', by: 'u', at: 1 } });
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, vcenters: [], vms: [], hosts: [] };
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'corp.purge', corp: 'vc-gone' } })).statusCode, 409, '스냅샷이 비면 등록 해제를 판단하지 않는다');
    store.snapshot = { ...prev, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], vms: [], hosts: [] };
    const scoped = { username: 'op1', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
    assert.equal((await call('POST /tools/svc-inventory/op', { user: scoped, body: { op: 'corp.purge', corp: 'vc-gone' } })).statusCode, 403, '범위 관리자는 못 한다');
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'corp.purge', corp: 'vc-a' } })).statusCode, 409, '아직 등록된 vCenter 는 거부');
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'corp.purge', corp: 'vc-none' } })).statusCode, 404);
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'corp.purge', corp: 'vc-gone', dry: true } });
    assert.deepEqual(dry.body.result.counts, { services: 2, folders: 1, folderRules: 1, aliases: 0, nameRules: 0, pins: 1 });
    assert.ok(sm.getMap().corps['vc-gone'], 'dry 는 지우지 않는다');
    const real = await call('POST /tools/svc-inventory/op', { body: { op: 'corp.purge', corp: 'vc-gone' } });
    assert.equal(real.statusCode, 200);
    assert.equal(sm.getMap().corps['vc-gone'], undefined);
    assert.deepEqual(Object.keys(sm.getPins().pins), ['vm:2'], '다른 법인 고정은 그대로');
    // 등록 해제 법인은 법인 쓰기가 404 — 그래서 화면이 버튼을 잠근다(writable:false)
    assert.equal((await call('POST /tools/svc-inventory/op', { body: { op: 'service.add', corp: 'vc-gone', name: 'X' } })).statusCode, 404);
  } finally { store.snapshot = prev; }
});

test('R8: 검토(pins.review) 라우트는 그 순간의 자동 판정을 reviewedAuto 로 저장하고, 고정(pins.set)은 검토 표지를 지운다', async () => {
  writeStore(mapOf({ 'vc-a': { services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } }));
  const prev = store.snapshot;
  try {
    store.snapshot = { ...prev, generatedAt: Date.now() + 1, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [],
      vms: [{ id: 'vm-1', vcenterId: 'vc-a', name: 'app1', folderPath: '/ERP', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096 }] };
    const set = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['vm:vm-1'], serviceId: 's2' } });
    assert.equal(set.statusCode, 200, JSON.stringify(set.body)); assert.equal(set.body.result.changed, 1);
    assert.equal(sm.getPins().pins['vm:vm-1'].reviewed, false);
    const rv = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.review', corp: 'vc-a', keys: ['vm:vm-1'] } });
    assert.equal(rv.statusCode, 200, JSON.stringify(rv.body));
    assert.equal(sm.getPins().pins['vm:vm-1'].reviewed, true);
    assert.equal(sm.getPins().pins['vm:vm-1'].reviewedAuto, 's1', '검토 당시 자동 판정(폴더 규칙 /ERP → s1)');
    await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['vm:vm-1'], serviceId: 's2' } });
    assert.equal('reviewedAuto' in sm.getPins().pins['vm:vm-1'], false, '다시 고정하면 검토 표지가 없다');
  } finally { store.snapshot = prev; }
});
