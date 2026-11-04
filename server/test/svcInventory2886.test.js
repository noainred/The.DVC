// v2.886 서비스 인벤토리 — 판정 코어·집계·큐·저장소·쓰기 연산·권한(docs/design/service-map/README.md 4차 검토 반영본).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-'));
process.env.CONFIG_DIR = tmp;

const { buildIndex, autoResolve, resolveMember, folderMatches } = await import('../src/servicemap/resolve.js');
const { buildInventory, buildQueues } = await import('../src/servicemap/build.js');
const store = await import('../src/servicemap/store.js');
const { CORP_OPS, FLEET_OPS } = await import('../src/servicemap/ops.js');
const { emptyAgg, addAgg, finishAgg } = await import('../src/corpusage/build.js');
const { vmKeyOf, bmKeyOf, backupOf, corpWriteAccess } = await import('../src/routes/api/svcInventory.js');

const S = (id, name, extra = {}) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '', ...extra });
function mapOf(corps = {}, extra = {}) {
  const out = { rev: 0, corps: {}, globals: [], settings: { tagCategory: '' }, ...extra };
  for (const [vc, c] of Object.entries(corps)) out.corps[vc] = { folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c };
  return out;
}
const vm = (key, corp, folderPath, extra = {}) => ({ key, kind: 'vm', corp, name: key, folderPath, powered: true, cores: 4, memGB: 16, storageGB: 100, usage: { state: 'ok', cpuPct: 50, memPct: 50, src: 'vcenter' }, ...extra });
const bm = (key, corp, scan, extra = {}) => ({ key, kind: 'bm', corp, name: key, scan, powered: true, cores: 32, memGB: 256, usage: { state: 'ok', cpuPct: 20, memPct: 40, src: 'idrac' }, faults: 0, ...extra });

test('폴더 규칙: vmPlacement 모양(/ 경계) · 가장 긴 접두 · 루트 규칙은 루트만 · 화면용 folder 모양은 걸리지 않는다', () => {
  assert.equal(folderMatches('/ERP', '/ERP/prod'), true);
  assert.equal(folderMatches('/ERP', '/ERPX'), false);            // 경계 — 접두 문자열만 같은 다른 폴더
  assert.equal(folderMatches('/', '/ERP'), false);                 // 루트 규칙이 전부를 삼키지 않는다
  assert.equal(folderMatches('/', '/'), true);
  assert.equal(folderMatches('/ERP', null), false);                // vApp 등 위치 모름
  const map = mapOf({ A: { services: [S('s1', 'ERP'), S('s2', 'ERP-DB')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }, { prefix: '/ERP/db', serviceId: 's2' }] } });
  const idx = buildIndex(map);
  assert.equal(autoResolve(vm('v1', 'A', '/ERP/db/x'), idx).serviceId, 's2');
  assert.equal(autoResolve(vm('v2', 'A', '/ERP/web'), idx).serviceId, 's1');
  const r = autoResolve(vm('v3', 'A', 'ERP/web'), idx);          // 화면용 folder 모양(선행 / 없음) — 4차 반증 1
  assert.equal(r.serviceId, null);
  assert.equal(r.unmapped.kind, 'folder');
  assert.equal(autoResolve(vm('v4', 'A', null), idx).reason, 'placement-unknown');
});

test('스캔 라벨: 서비스명·별칭(대소문자 무시) · 라벨 없음은 entry 묶음 · 서비스 없는 라벨은 매핑 안 된 값', () => {
  const map = mapOf({ A: { services: [S('s1', 'DB-Oracle')], aliases: [{ kind: 'scan', value: 'DB', serviceId: 's1' }] } });
  const idx = buildIndex(map);
  assert.equal(autoResolve(bm('b1', 'A', { entryId: 'e1', label: 'db-oracle' }), idx).serviceId, 's1');
  assert.equal(autoResolve(bm('b2', 'A', { entryId: 'e1', label: 'db' }), idx).src, 'scan');
  assert.deepEqual(autoResolve(bm('b3', 'A', { entryId: 'e2', label: '' }), idx).unmapped, { kind: 'entry', value: 'e2' });
  assert.deepEqual(autoResolve(bm('b4', 'A', { entryId: 'e3', label: 'Files' }), idx).unmapped, { kind: 'scan', value: 'Files' });
  assert.equal(autoResolve(bm('b5', 'A', null), idx).reason, 'no-scan-entry');
  assert.equal(autoResolve(bm('b6', '', null), idx).reason, 'no-corp');
});

test('태그(선택): 전역 카테고리 + 법인 켬일 때만 · 못 읽음은 unchecked(미지정과 다르다) · 폴더 규칙이 먼저', () => {
  const map = mapOf({ A: { tagEnabled: true, services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/MES', serviceId: 's2' }] } });
  const idx = buildIndex(map);
  const ctx = { tagCategory: 'Service' };
  assert.equal(autoResolve(vm('v1', 'A', '/x', { tags: ['erp'] }), idx, ctx).src, 'tag');
  assert.equal(autoResolve(vm('v2', 'A', '/MES/a', { tags: ['ERP'] }), idx, ctx).serviceId, 's2');   // 폴더 우선
  const u = autoResolve(vm('v3', 'A', '/x', { tags: null }), idx, ctx);
  assert.equal(u.unchecked, true);
  assert.equal(u.reason, 'tags-unchecked');
  assert.equal(autoResolve(vm('v4', 'A', '/x', { tags: ['Payroll'] }), idx, ctx).unmapped.kind, 'tag');
  assert.equal(autoResolve(vm('v5', 'A', '/x', { tags: ['ERP'] }), idx, {}).src, 'none');            // 카테고리 미정 → 태그 규칙 없음
});

test('이름 규칙: 접두/접미/포함만(정규식 아님) · 입력 길이 상한', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')], nameRules: [{ match: 'prefix', value: 'erp-', serviceId: 's1' }] } });
  const idx = buildIndex(map);
  assert.equal(autoResolve(vm('v1', 'A', '/x', { name: 'ERP-app01' }), idx).src, 'rule');
  assert.equal(autoResolve(vm('v2', 'A', '/x', { name: 'x-erp-app' }), idx).src, 'none');
  // 아주 긴 이름도 정규식 없이 선형으로 — 절대 시간 상한 대신 결과만 본다(CPU 에 따라 깨지는 단언 금지 · TESTDOC2613-02).
  const long = `erp-${'a'.repeat(100_000)}`;
  assert.equal(autoResolve(vm('v3', 'A', '/x', { name: long }), idx).src, 'rule');
});

test('고정: 자동보다 우선 · 다르면 drift(검토하면 해제) · 같으면 redundant · 법인이 다르면 무시(pinMismatch) · 지워진 서비스는 무시', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } });
  const idx = buildIndex(map);
  const m = vm('k1', 'A', '/ERP');
  const r1 = resolveMember(m, idx, {}, { k1: { serviceId: 's2', corp: 'A' } });
  assert.equal(r1.serviceId, 's2'); assert.equal(r1.src, 'pin'); assert.equal(r1.drift, true);
  assert.equal(resolveMember(m, idx, {}, { k1: { serviceId: 's2', corp: 'A', reviewed: true } }).drift, false);
  assert.equal(resolveMember(m, idx, {}, { k1: { serviceId: 's1', corp: 'A' } }).redundant, true);
  const r4 = resolveMember(m, idx, {}, { k1: { serviceId: 's2', corp: 'B' } });
  assert.equal(r4.serviceId, 's1'); assert.ok(r4.pinMismatch);
  assert.equal(resolveMember(m, idx, {}, { k1: { serviceId: 'gone', corp: 'A' } }).pinDangling, true);
});

test('집계는 corpusage addAgg 와 같은 함수 — 같은 입력이면 같은 가중 사용률 · 꺼진 VM 제외 · 못 읽음은 따로', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } });
  const ms = [
    vm('a', 'A', '/ERP', { cores: 2, memGB: 8, usage: { state: 'ok', cpuPct: 90, memPct: 10, src: 'vcenter' } }),
    vm('b', 'A', '/ERP', { cores: 8, memGB: 32, usage: { state: 'ok', cpuPct: 10, memPct: 50, src: 'vcenter' } }),
    vm('c', 'A', '/ERP', { powered: false, cores: 64, memGB: 512, usage: { state: 'unread' } }),
    vm('d', 'A', '/ERP', { usage: { state: 'unread', cpuPct: null, memPct: null, src: null } }),
  ];
  const inv = buildInventory({ members: ms, map });
  const s = inv.services.find((x) => x.id === 's1').stat;
  const ref = emptyAgg();
  for (const m of ms.filter((x) => x.powered !== false)) addAgg(ref, { cores: m.cores, memGB: m.memGB, ...m.usage });
  const f = finishAgg(ref);
  assert.equal(s.usage.cpu, f.cpu.pct); assert.equal(s.usage.mem, f.mem.pct);
  assert.equal(s.usage.cpu, 26);                     // (0.9*2 + 0.1*8) / 10 = 26%
  assert.equal(s.usage.unread, 1); assert.equal(s.power.off, 1);
  assert.equal(s.alloc.vcpu, 2 + 8 + 64 + 4);         // 할당 합계에는 꺼진·못 읽은 VM 도 들어간다
});

test('부품 장애: 구성원과 영향 호스트를 나눠 센다 · DB 를 못 읽은 서버(null)는 0 이 아니라 unknown', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }], aliases: [{ kind: 'scan', value: 'ERP', serviceId: 's1' }] } });
  const ms = [vm('v1', 'A', '/ERP', { host: 'h1' }), bm('b1', 'A', { entryId: 'e', label: 'ERP' }, { faults: 2 }), bm('b2', 'A', { entryId: 'e', label: 'ERP' }, { faults: null })];
  const hostByKey = new Map([['A|h1', { name: 'h1', corp: 'A', faults: 1 }]]);
  const s = buildInventory({ members: ms, map, hostByKey }).services[0].stat;
  assert.deepEqual(s.faults, { member: 2, memberUnknown: 1, host: 1, hostUnknown: 0 });
  assert.equal(s.hosts, 1);
});

test('범위: 범위 밖 법인·법인 미지정 구성원은 집계·큐·전역에서 빠진다', () => {
  const map = mapOf({ A: { services: [S('s1', 'DB', { globalId: 'g1' })], folderRules: [{ prefix: '/DB', serviceId: 's1' }] }, B: { services: [S('s2', 'DB', { globalId: 'g1' })], folderRules: [{ prefix: '/DB', serviceId: 's2' }] } },
    { globals: [{ id: 'g1', name: 'DB', tier: 1, owner: '', note: '' }] });
  const ms = [vm('a1', 'A', '/DB'), vm('b1', 'B', '/DB'), vm('b2', 'B', '/X'), bm('n1', '', null)];
  const inv = buildInventory({ members: ms, map, allowed: new Set(['A']) });
  assert.deepEqual(inv.corps.map((c) => c.vcenterId), ['A']);
  assert.deepEqual(inv.services.map((s) => s.id), ['s1']);
  assert.equal(inv.noCorp, null);
  assert.deepEqual(inv.global.globals[0].corps, ['A']);
  assert.deepEqual(Object.keys(inv.global.cells.g1), ['A']);
  assert.equal(inv.queues.unassigned.length, 0);
  const full = buildInventory({ members: ms, map });
  assert.deepEqual(Object.keys(full.global.cells.g1).sort(), ['A', 'B']);
  assert.equal(full.noCorp.n.total, 1);
});

test('큐: 미지정 출처별 묶음 · 매핑 안 된 값 · 유령은 읽지 못한 법인/베어메탈 출처면 판정 보류(4차 반증 5)', () => {
  const map = mapOf({ A: { services: [S('s1', 'ERP')] } });
  const ms = [vm('v1', 'A', '/Legacy'), vm('v2', 'A', '/Legacy'), bm('b1', 'A', { entryId: 'e1', label: '' }), bm('b2', 'A', { entryId: 'e2', label: 'DB' }), vm('v3', 'A', null)];
  const pins = { 'iu:A:gone': { serviceId: 's1', corp: 'A' }, 'st:gonebm': { serviceId: 's1', corp: 'A' } };
  const q = buildInventory({ members: ms, map, pins }).queues;
  const kinds = Object.fromEntries(q.unassigned.map((g) => [g.kind, g.n]));
  assert.deepEqual(kinds, { folder: 2, entry: 1, scan: 1, placement: 1 });
  assert.deepEqual(q.unmapped.map((u) => [u.kind, u.value]), [['scan', 'DB']]);
  assert.equal(q.ghosts.length, 2); assert.equal(q.ghostsHeld.length, 0);
  const held = buildInventory({ members: ms, map, pins, unreadCorps: new Set(['A']) }).queues;
  assert.equal(held.ghosts.length, 0); assert.equal(held.ghostsHeld.length, 2);
  const bmHeld = buildInventory({ members: ms, map, pins, bmBlocked: true }).queues;
  assert.deepEqual(bmHeld.ghosts.map((g) => g.key), ['iu:A:gone']);
  assert.deepEqual(bmHeld.ghostsHeld.map((g) => g.held), ['bm-source-unread']);
});

test('큐: 비관리자 판본에는 스캔 엔트리 대역(CIDR)을 싣지 않는다(4차 반증 13)', () => {
  const map = mapOf({ A: { services: [] } });
  const scanEntries = new Map([['e1', { service: '', range: '10.0.9.0/24' }]]);
  const ms = [bm('b1', 'A', { entryId: 'e1', label: '' })];
  const admin = buildQueues({ members: ms, resolved: new Map([['b1', autoResolve(ms[0], buildIndex(map))]]), idx: buildIndex(map), scanEntries, adminView: true });
  const user = buildQueues({ members: ms, resolved: new Map([['b1', autoResolve(ms[0], buildIndex(map))]]), idx: buildIndex(map), scanEntries, adminView: false });
  assert.equal(admin.unassigned[0].entry.range, '10.0.9.0/24');
  assert.equal('range' in user.unassigned[0].entry, false);
});

test('판정은 구성원당 1회(4차 반증 9) — 결과 Map 을 표·큐·전역이 공유', async () => {
  const resolveMod = await import('../src/servicemap/resolve.js');
  const map = mapOf({ A: { services: [S('s1', 'ERP', { globalId: 'g' })], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] } }, { globals: [{ id: 'g', name: 'ERP', tier: 1, owner: '', note: '' }] });
  const ms = Array.from({ length: 3000 }, (_, i) => vm(`k${i}`, 'A', i % 2 ? '/ERP/a' : '/X'));
  const t0 = Date.now();
  const inv = buildInventory({ members: ms, map });
  assert.equal(inv.resolved.size, 3000);
  assert.ok(Date.now() - t0 < 2000, '3,000 구성원 집계가 2초 안');
  assert.equal(typeof resolveMod.resolveMember, 'function');
});

test('키: VM 은 vCenter 를 붙인 instanceUuid(없으면 moref) · 베어메탈은 서비스태그(없으면 fleetId 해시 — 주소 원문을 키에 싣지 않는다)', () => {
  assert.equal(vmKeyOf({ vcenterId: 'vc1', id: 'vc1:vm-1', instanceUuid: 'ABC' }).key, 'iu:vc1:abc');
  assert.equal(vmKeyOf({ vcenterId: 'vc1', id: 'vc1:vm-1' }).key, 'vm:vc1:vm-1');
  assert.equal(bmKeyOf({ serviceTag: 'XYZ1' }).key, 'st:xyz1');
  const k = bmKeyOf({ fleetId: '10.1.2.3' }).key;
  assert.match(k, /^fl:[0-9a-f]{16}$/);
  assert.ok(!k.includes('10.1.2.3'));
});

test('백업 칸: 미사용 undefined · 원장 못 읽음 null · 24h 내 성공 ok · 실패/지연 fail · 잡 없음 none', () => {
  const now = 1_800_000_000_000;
  assert.equal(backupOf(null, now), null);
  assert.equal(backupOf({ job: false }, now), 'none');
  assert.equal(backupOf({ job: true, st: 'ok', at: now - 1000, ok: now - 1000 }, now), 'ok');
  assert.equal(backupOf({ job: true, st: 'ok', at: now - 2 * 86_400_000, ok: now - 2 * 86_400_000 }, now), 'fail');
  assert.equal(backupOf({ job: true, st: 'error', at: now }, now), 'fail');
});

test('권한: 알 수 없는 법인·조회 밖은 404, 조회는 되지만 쓰기 밖은 403, 쓰기 범위 미설정은 조회 범위에 쓰기 가능', () => {
  const snap = { vcenters: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] };
  const op = (scope) => ({ role: 'operator', username: 'u', scope });
  assert.equal(corpWriteAccess(op({}), snap, 'Z').status, 404);
  assert.equal(corpWriteAccess(op({ vcenters: ['A', 'B'] }), snap, 'C').status, 404);
  assert.equal(corpWriteAccess(op({ vcenters: ['A', 'B'], writeVcenters: ['A'] }), snap, 'B').status, 403);
  assert.equal(corpWriteAccess(op({ vcenters: ['A', 'B'] }), snap, 'B'), null);       // 4차 반증 6 — 미설정 = 조회 범위
  assert.equal(corpWriteAccess(op({}), snap, 'C'), null);
});

test('쓰기 연산: 서비스명은 법인 안에서 유일(대소문자 무시) · 폴더 아래 서비스가 있으면 폴더 삭제 거부 · 서비스 삭제는 규칙·별칭을 함께 지운다', () => {
  const d = mapOf({});
  assert.ok(CORP_OPS['service.add'](d, { corp: 'A', name: 'ERP', path: '업무\\개발' }).result);
  assert.equal(CORP_OPS['service.add'](d, { corp: 'A', name: 'erp' }).status, 409);
  assert.ok(CORP_OPS['service.add'](d, { corp: 'B', name: 'ERP' }).result);         // 다른 법인은 같은 이름 허용
  const id = d.corps.A.services[0].id;
  assert.ok(CORP_OPS['rule.add'](d, { corp: 'A', prefix: 'ERP/prod/', serviceId: id }).result);
  assert.equal(d.corps.A.folderRules[0].prefix, '/ERP/prod');                       // 선행 / 보정 · 끝 / 제거
  assert.ok(CORP_OPS['alias.add'](d, { corp: 'A', kind: 'scan', value: 'ERP-BM', serviceId: id }).result);
  assert.equal(CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무' }).status, 409);
  const r = CORP_OPS['service.remove'](d, { corp: 'A', id });
  assert.equal(r.result.rulesRemoved, 2);
  assert.equal(d.corps.A.folderRules.length + d.corps.A.aliases.length, 0);
  assert.equal(CORP_OPS['folder.add'](d, { corp: 'A', path: 'a\\\\b' }).status, 400); // 빈 세그먼트
  assert.equal(CORP_OPS['namerule.add'](d, { corp: 'A', match: 'regex', value: '.*', serviceId: 'x' }).status, 400);
});

test('쓰기 연산: 서비스로 만들기는 서비스 + 규칙을 한 번에(규칙이 실패하면 둘 다 없음) · 전역 삭제는 연결만 비운다', () => {
  const r = store.mutateMap((d) => CORP_OPS['service.createLinked'](d, { corp: 'A', kind: 'folder', value: '/Legacy', name: 'Legacy' }));
  assert.equal(r.ok, true);
  const bad = store.mutateMap((d) => CORP_OPS['service.createLinked'](d, { corp: 'A', kind: 'folder', value: '/Legacy', name: 'Legacy2' }));
  assert.equal(bad.ok, false);                                                          // 같은 접두 규칙이 이미 다른 서비스에
  assert.deepEqual(store.getMap().corps.A.services.map((s) => s.name), ['Legacy']);     // 반쪽 서비스가 남지 않는다
  const g = store.mutateMap((d) => FLEET_OPS['global.add'](d, { name: 'Legacy' }));
  const gid = g.result.global.id;
  const sid = store.getMap().corps.A.services[0].id;
  store.mutateMap((d) => CORP_OPS['service.update'](d, { corp: 'A', id: sid, globalId: gid }));
  const rm = store.mutateMap((d) => FLEET_OPS['global.remove'](d, { id: gid }));
  assert.equal(rm.result.unlinked, 1);
  assert.equal(store.getMap().corps.A.services[0].globalId, '');
  assert.equal(store.flushStore(), true);
  assert.ok(fs.existsSync(path.join(tmp, 'service-map.json')));
});

test('저장소: 손상 파일이면 빈 트리로 시작하지 않고 쓰기를 막는다(503) · 초기화는 손상본을 보존한다', () => {
  store._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), '{ not json');
  assert.ok(store.storeLoadError()?.map);
  const w = store.mutateMap((d) => CORP_OPS['folder.add'](d, { corp: 'A', path: 'x' }));
  assert.equal(w.ok, false); assert.equal(w.status, 503);
  assert.equal(fs.readFileSync(path.join(tmp, 'service-map.json'), 'utf8'), '{ not json');   // 덮어쓰지 않았다
  const r = store.resetCorrupt();
  assert.equal(r.ok, true); assert.equal(r.moved.length, 1);
  assert.equal(store.storeLoadError(), null);
  assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('service-map.json.corrupt.')));
});

test('스캔 라벨 전용 설정: 없는 엔트리 404 · 다른 DataCenter 403 · 이미 라벨 있으면 409 · 라벨 외 필드는 그대로', async () => {
  const { saveScanRanges, setScanRangeLabel, getScanRangeRaw } = await import('../src/idrac/scanRanges.js');
  const s = saveScanRanges({ datacenterId: 'DC1', ranges: ['10.0.0.0/30'], username: 'root', password: 'pw', agent: '' });
  assert.equal(s.ok, true);
  const id = s.id || s.entry?.id || Object.keys(JSON.parse(fs.readFileSync(path.join(tmp, 'idrac-scan-ranges.json'), 'utf8')).entries)[0];
  assert.equal(setScanRangeLabel('nope', 'ERP', { datacenterId: 'DC1' }).status, 404);
  assert.equal(setScanRangeLabel(id, 'ERP', { datacenterId: 'DC2' }).status, 403);
  assert.equal(setScanRangeLabel(id, 'ERP', { datacenterId: 'DC1' }).ok, true);
  const raw = getScanRangeRaw(id);
  assert.equal(raw.service, 'ERP'); assert.equal(raw.password, 'pw'); assert.deepEqual(raw.ranges, ['10.0.0.0/30']);
  assert.equal(setScanRangeLabel(id, 'MES', { datacenterId: 'DC1' }).status, 409);
});
