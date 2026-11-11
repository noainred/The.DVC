// 서비스 인벤토리 7차 검토(사용자 '다음 스텝 진행해' → 7차 검토 + 반영 · 표준) — 반증 1인 지적 1~6 회귀.
//   1 태그 없는 호스트의 지금 키 = 같은 이름 태그 있는 호스트의 옛 키 → 거짓 불일치 행 · 그 '고정 지우기' 가 쓰이는 고정을 지웠다(onlyIfUnused 로 서버도 막는다)
//   2 instanceUuid 를 일부 VM 만 못 읽는 법인의 iu: 고정은 판정 보류(uuid-partial) · 3 고정 유지·불필요한 고정 지우기가 충돌 옛 키 고정을 묻지 않고 지웠다
//   4 법인을 모르는 구성원의 직접 키 불일치 행 · 5 없는 서비스를 가리키는 고정(dangling)이 안 보였다 · 6 수정 연산 감사에 되돌릴 근거
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r7-'));
process.env.CONFIG_DIR = tmp;

const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const { CORP_OPS, FLEET_OPS } = await import('../src/servicemap/ops.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory } = await import('../src/routes/api/svcInventory.js');

const S = (id, name, path = '') => ({ id, name, path, tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c });
const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: key.replace(/^\w+ /, '/api') }, res);
  return res;
}
const P = (serviceId, corp = 'vc-a') => ({ serviceId, corp, by: 'kim', at: 1 });
function setup(pins = {}, corps = { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES'), S('s3', 'HR')] }) }) {
  registry.importServers([], 'replace');
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins }));
}
let gen = 0;
const snapOf = (vms) => ({ ...store.snapshot, generatedAt: Date.now() + 5000 + (gen += 11), vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms });
const VM = (id, extra = {}) => ({ id, vcenterId: 'vc-a', name: id, instanceUuid: `u-${id}`, powerState: 'POWERED_ON', folderPath: '/x', ...extra });
const map2 = { corps: { A: corpOf({ services: [S('s1', 'ERP')] }), B: corpOf({ services: [S('s1', 'ERP')] }) } };

// ───────── 1 ─────────
test('7차 1: 태그 없는 호스트의 지금 키가 다른 법인 호스트의 옛 키와 같아도 거짓 불일치 행이 없다(두 변형)', () => {
  // 변형 1: A(태그 없음 — 지금 키 fl:x)가 직접 고정을 쓴다 · B(태그 있음 — 옛 키 fl:x) 쪽에 옛 키 불일치 행이 뜨던 경우
  const a = { key: 'fl:x', aliasKeys: [], kind: 'bm', corp: 'A', name: 'esx1' };
  const b = { key: 'st:tagb', aliasKeys: ['fl:x'], kind: 'bm', corp: 'B', name: 'esx1' };
  const v1 = buildInventory({ members: [a, b], map: map2, pins: { 'fl:x': P('s1', 'A') } });
  assert.equal(v1.resolved.get('fl:x').src, 'pin'); assert.deepEqual(v1.queues.mismatch, []);
  // 변형 2: B 가 옛 키 고정(법인 B)을 승계해 쓴다 · A 쪽에 직접 키 불일치 행이 뜨던 경우
  const v2 = buildInventory({ members: [a, b], map: map2, pins: { 'fl:x': P('s1', 'B') } });
  assert.equal(v2.resolved.get('st:tagb').src, 'pin'); assert.deepEqual(v2.queues.mismatch, []);
  // 진짜 불일치(고정 법인에 그 키를 가진 구성원이 없음)는 그대로 보인다
  const v3 = buildInventory({ members: [a], map: map2, pins: { 'fl:x': P('s1', 'B') } });
  assert.deepEqual(v3.queues.mismatch.map((x) => [x.key, x.pinCorp]), [['fl:x', 'B']]);
});

test('7차 1(서버 방어): 불일치·보류·없는 서비스 행의 \'고정 지우기\'(onlyIfUnused)는 지금 판정에 쓰는 고정을 지우지 않는다 — 409 · 안 쓰는 고정은 지운다', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([VM('vm-1')]);
    setup({ 'vm:vm-1': P('s1'), 'iu:vc-a:gone': P('s1') });   // vm-1 은 옛 키(vm:)로 고정을 쓰는 중
    const used = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['vm:vm-1'], onlyIfUnused: true } });
    assert.equal(used.statusCode, 409, JSON.stringify(used.body)); assert.ok(sm.getPins().pins['vm:vm-1'], '쓰이는 고정은 그대로');
    const ok = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:gone'], onlyIfUnused: true } });
    assert.equal(ok.statusCode, 200); assert.equal(ok.body.result.changed, 1); assert.equal(sm.getPins().pins['iu:vc-a:gone'], undefined);
    // 지금 키에는 고정이 없고 옛 키 고정을 쓰는 중이면, 지금 키로 지우기를 보내도 옛 키로 되짚어 가지 않는다(쓰이는 옛 키 고정을 지우지 않는다)
    const viaKey = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], onlyIfUnused: true } });
    assert.equal(viaKey.body.result?.changed ?? 0, 0, JSON.stringify(viaKey.body)); assert.ok(sm.getPins().pins['vm:vm-1'], '옛 키 고정 그대로');
    // 드리프트 '자동으로 되돌리기'(onlyIfUnused 없음)는 예전처럼 지운다 — 사람이 그 구성원 소속을 자동으로 되돌린 것
    const clr = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'] } });
    assert.equal(clr.statusCode, 200); assert.equal(sm.getPins().pins['vm:vm-1'], undefined);
  } finally { store.snapshot = prev; }
});

// ───────── 2 ─────────
test('7차 2: instanceUuid 를 일부 VM 만 못 읽는 법인의 iu: 고정은 유령이 아니라 판정 보류(uuid-partial) — 정리되지 않는다', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([VM('vm-1'), VM('vm-2', { instanceUuid: '' })]);
    setup({ 'iu:vc-a:u-vm-2-was': P('s1') });
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q.body.ghostsN, 0); assert.deepEqual(q.body.ghostsHeld.map((x) => x.held), ['uuid-partial']);
    const pr = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: ['iu:vc-a:u-vm-2-was'] } });
    assert.equal(pr.body.result.removed, 0); assert.ok(sm.getPins().pins['iu:vc-a:u-vm-2-was']);
    // 모두 읽히면 유령(정리 대상)으로 돌아온다
    store.snapshot = snapOf([VM('vm-1'), VM('vm-2')]);
    const q2 = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q2.body.ghostsN, 1);
  } finally { store.snapshot = prev; }
});

// ───────── 3 ─────────
test('7차 3: 고정 유지는 서비스가 다른(충돌) 옛 키 고정을 지우지 않고 같은 서비스(중복)만 지운다 · 건너뛴 키는 옛 키도 그대로 · 지운 옛 키 수를 결과에', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([VM('vm-1'), VM('vm-2')]);
    setup({ 'iu:vc-a:u-vm-1': P('s1'), 'vm:vm-1': P('s3'), 'iu:vc-a:u-vm-2': P('s1'), 'vm:vm-2': P('s1') });
    const rv = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.review', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1', 'iu:vc-a:u-vm-2'] } });
    assert.equal(rv.statusCode, 200, JSON.stringify(rv.body));
    assert.equal(rv.body.result.aliasRemoved, 1, '중복 1건만');
    assert.ok(sm.getPins().pins['vm:vm-1'], '충돌 옛 키 고정(s3)은 남는다 — 사람이 옛 키 카드에서 고른다');
    assert.equal(sm.getPins().pins['vm:vm-2'], undefined);
    // onlyIfRedundant 로 건너뛴 키는 옛 키도 건드리지 않는다(자동 판정 없음 → 불필요하지 않음)
    const cl = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], onlyIfRedundant: true } });
    assert.equal(cl.statusCode, 409); assert.ok(sm.getPins().pins['vm:vm-1']);
    // 고정 지정은 사람이 소속을 새로 정한 것 — 옛 키 고정을 함께 지우고 개수를 알린다
    const st = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], serviceId: 's2' } });
    assert.equal(st.body.result.aliasRemoved, 1); assert.equal(sm.getPins().pins['vm:vm-1'], undefined);
  } finally { store.snapshot = prev; }
});

// ───────── 4·5 ─────────
test('7차 4: 법인을 모르는 구성원(corp \'\')의 직접 키 고정은 불일치 행으로 싣지 않는다 · 5: 없는 서비스를 가리키는 고정은 dangling 으로 보인다', () => {
  const m = { key: 'st:t1', aliasKeys: [], kind: 'bm', corp: '', corpWhy: 'attr-error', name: 'bm1' };
  const inv = buildInventory({ members: [m], map: map2, pins: { 'st:t1': P('s1', 'A') } });
  assert.deepEqual(inv.queues.mismatch, []);
  const v = { key: 'iu:A:u1', aliasKeys: [], kind: 'vm', corp: 'A', name: 'v1', folderPath: '/x' };
  const d = buildInventory({ members: [v], map: map2, pins: { 'iu:A:u1': P('gone-svc', 'A') } });
  assert.deepEqual(d.queues.dangling.map((x) => [x.key, x.serviceId]), [['iu:A:u1', 'gone-svc']]);
  assert.equal(d.resolved.get('iu:A:u1').src, 'none', '판정은 자동으로 돌아가 있다');
});

test('7차 5(라우트): dangling 은 큐·개수에 실리고 \'고정 지우기\'(onlyIfUnused)로 지워진다', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([VM('vm-1')]);
    setup({ 'iu:vc-a:u-vm-1': P('svc-deleted') });
    const main = await call('GET /tools/svc-inventory', {});
    assert.equal(main.body.queues.dangling, 1); assert.equal(main.body.queuesByCorp['vc-a'].dangling, 1);
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.deepEqual(q.body.dangling.map((x) => x.key), ['iu:vc-a:u-vm-1']);
    const c = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], onlyIfUnused: true } });
    assert.equal(c.statusCode, 200, JSON.stringify(c.body)); assert.equal(sm.getPins().pins['iu:vc-a:u-vm-1'], undefined);
  } finally { store.snapshot = prev; }
});

// ───────── 6 ─────────
test('7차 6: 수정 연산 결과에 되돌릴 근거 — 규칙·별칭·이름 규칙 대상 바꾸기의 이전 대상(from) · 전역 수정의 이전 값(before)', () => {
  const d = { globals: [{ id: 'g1', name: 'ERP', tier: 1, owner: 'o1', note: '' }], corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }], aliases: [{ kind: 'tag', value: 't1', serviceId: 's1' }], nameRules: [{ match: 'prefix', value: 'erp-', serviceId: 's1' }] }) } };
  assert.equal(CORP_OPS['rule.update'](d, { corp: 'A', prefix: '/ERP', serviceId: 's2' }).result.from, 's1');
  assert.equal(CORP_OPS['alias.update'](d, { corp: 'A', kind: 'tag', value: 't1', serviceId: 's2' }).result.from, 's1');
  assert.equal(CORP_OPS['namerule.update'](d, { corp: 'A', match: 'prefix', value: 'erp-', serviceId: 's2' }).result.from, 's1');
  assert.deepEqual(FLEET_OPS['global.update'](d, { id: 'g1', name: 'ERP2', tier: 2 }).result.before, { name: 'ERP', tier: 1, owner: 'o1' });
});

test('7차 5(경합): 고정 지정이 입력을 모으는 동안 그 서비스가 지워지면 409 — 없는 서비스를 가리키는 고정을 만들지 않는다', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([VM('vm-1')]);
    setup({});
    const pending = call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], serviceId: 's3' } });   // 입력 수집(await)에서 멈춘다
    const rm = await call('POST /tools/svc-inventory/op', { body: { op: 'service.remove', corp: 'vc-a', id: 's3' } });
    assert.equal(rm.statusCode, 200, JSON.stringify(rm.body));
    const r = await pending;
    assert.equal(r.statusCode, 409, JSON.stringify(r.body));
    assert.equal(sm.getPins().pins['iu:vc-a:u-vm-1'], undefined, '지워진 서비스를 가리키는 고정이 생기지 않는다');
  } finally { store.snapshot = prev; }
});
