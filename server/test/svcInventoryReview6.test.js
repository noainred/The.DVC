// 서비스 인벤토리 6차 검토 반영 — docs/design/service-map/README.md §6차 검토(사용자 '전부(쓰기 성능 포함)' · 예약 버그 수정 '이번에 함께').
//   1(높음) 수집 전(pending)·꺼진(disabled)·골격 스냅샷(initial)·VM 0대 법인의 VM 고정은 유령이 아니라 판정 보류 — 정리 버튼으로 지워지지 않는다.
//   2 엣지 '태그 없을 때 id' → 중앙 정제 → 함대 → 별칭 키(태그가 나중에 읽혀도 옛 fl: 고정 승계).
//   3·9 새 키 고정과 옛 키 고정이 함께 있으면 중복·충돌로 드러난다 · 4 다른 법인의 별칭 고정은 live 가 아니다(유령).
//   5 범위 밖 pinCorp·서비스 id 가림 · 6 법인 미지정만 질의 · 8 mutatePins 바뀐 키만 · 유령 목록 상한.
//   예약 1-b·1-d: folder.rename · folder.remove moveUp · rule/alias/namerule.update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r6-'));
process.env.CONFIG_DIR = tmp;

const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const { CORP_OPS } = await import('../src/servicemap/ops.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory, bmAliasKeys, bmKeyOf } = await import('../src/routes/api/svcInventory.js');
const central = await import('../src/central/fleet.js');
const { fleetUntaggedId } = await import('../src/agent/fleetPush.js');
const { classifyFleet } = await import('../src/insights/fleetInventory.js');

const S = (id, name, path = '') => ({ id, name, path, tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c });
const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: key.replace(/^\w+ /, '/api') }, res);
  return res;
}
function setup(pins = {}, corps = { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')] }) }) {
  registry.importServers([], 'replace');
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins }));
}
const P = (serviceId, corp = 'vc-a') => ({ serviceId, corp, by: 'kim', at: 1 });
let gen = 0;
const snapOf = (vcenters, vms = []) => ({ ...store.snapshot, generatedAt: Date.now() + 1000 + (gen += 7), vcenters, hosts: [], vms });
const VM = (id, vc = 'vc-a', extra = {}) => ({ id, vcenterId: vc, name: id, instanceUuid: `u-${id}`, powerState: 'POWERED_ON', folderPath: '/x', ...extra });

// ───────── 1(높음): 판정 보류 ─────────
test('6차 1: 수집 대기(pending)·꺼진(disabled) vCenter 의 VM 고정은 판정 보류 — 정리(dry·실행)가 지우지 않는다', async () => {
  for (const status of ['pending', 'disabled']) {
    setup({ 'iu:vc-a:gone-1': P('s1'), 'iu:vc-a:gone-2': P('s1') });
    const prev = store.snapshot;
    try {
      // 살아 있는 VM 1대를 둔다 — 'VM 0대' 보류와 섞이지 않게 pending·disabled 자체를 본다
      store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a', status }], [VM('live')]);
      const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
      assert.equal(q.statusCode, 200, JSON.stringify(q.body));
      assert.equal(q.body.ghostsN, 0, `${status}: 유령 0`);
      assert.deepEqual(q.body.ghostsHeld.map((x) => x.held), [`corp-${status}`, `corp-${status}`]);
      const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
      assert.equal(dry.body.result.keys.length, 0); assert.equal(dry.body.result.held, 2);
      const pr = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: ['iu:vc-a:gone-1', 'iu:vc-a:gone-2'] } });
      assert.equal(pr.body.result.removed, 0, '보류 키를 직접 보내도 지우지 않는다');
      assert.equal(Object.keys(sm.getPins().pins).length, 2);
    } finally { store.snapshot = prev; }
  }
});

test('6차 1: VM 이 한 대도 없는 법인의 VM 고정은 보류(corp-no-vms) · VM 이 있으면 유령 · 베어메탈 고정은 이 보류와 무관 · 골격 스냅샷은 전부 보류', () => {
  const map = { corps: { A: corpOf({ services: [S('s1', 'ERP')] }), B: corpOf({ services: [S('s1', 'ERP')] }) } };
  const pins = { 'iu:A:gone': P('s1', 'A'), 'vm:vm-9': P('s1', 'A'), 'iu:B:gone': P('s1', 'B'), 'st:zzz': P('s1', 'A') };
  const members = [{ key: 'iu:B:live', kind: 'vm', corp: 'B', name: 'b1', folderPath: '/x' }];
  const inv = buildInventory({ members, map, pins });
  assert.deepEqual(inv.queues.ghosts.map((x) => x.key).sort(), ['iu:B:gone', 'st:zzz'], 'VM 이 있는 법인 B 는 유령 · 베어메탈은 VM 0대 보류 대상이 아니다');
  assert.deepEqual(inv.queues.ghostsHeld.map((x) => [x.key, x.held]).sort(), [['iu:A:gone', 'corp-no-vms'], ['vm:vm-9', 'corp-no-vms']]);
  const init = buildInventory({ members, map, pins, snapInitial: true });
  assert.equal(init.queues.ghosts.length, 0); assert.equal(init.queues.ghostsHeld.length, 4);
  assert.ok(init.queues.ghostsHeld.every((x) => x.held === 'snapshot-initial'));
  const held = buildInventory({ members, map, pins, corpHold: new Map([['B', 'corp-pending']]) });
  assert.equal(held.queues.ghostsHeld.find((x) => x.key === 'iu:B:gone')?.held, 'corp-pending');
});

// ───────── 3·4·9: 별칭 ─────────
test('6차 3·9: 새 키 고정과 옛 키 고정이 함께 있으면 중복(같은 서비스)·충돌(다른 서비스)로 드러난다 · 4: 다른 법인의 별칭 고정은 법인 불일치 · 반증 F1: 법인을 모르는 구성원의 별칭 고정은 유령이 아니다', () => {
  const map = { corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')] }), B: corpOf({ services: [S('s1', 'ERP')] }) } };
  const m1 = { key: 'iu:A:u1', aliasKeys: ['vm:A:vm-1'], kind: 'vm', corp: 'A', name: 'v1', folderPath: '/x' };
  const m2 = { key: 'iu:A:u2', aliasKeys: ['vm:A:vm-2'], kind: 'vm', corp: 'A', name: 'v2', folderPath: '/x' };
  const m3 = { key: 'st:moved', aliasKeys: ['fl:old3'], kind: 'bm', corp: 'B', name: 'bm3' };
  const m4 = { key: 'st:nocorp', aliasKeys: ['fl:old4'], kind: 'bm', corp: '', corpWhy: 'attr-error', name: 'bm4' };
  const pins = { 'iu:A:u1': P('s1', 'A'), 'vm:A:vm-1': P('s2', 'A'), 'iu:A:u2': P('s1', 'A'), 'vm:A:vm-2': P('s1', 'A'), 'fl:old3': P('s1', 'A'), 'fl:old4': P('s1', 'A') };
  const inv = buildInventory({ members: [m1, m2, m3, m4], map, pins });
  const ap = inv.queues.aliasPins.map((x) => [x.key, x.aliasKey, x.state, x.serviceId, x.aliasServiceId || null]).sort();
  assert.deepEqual(ap, [['iu:A:u1', 'vm:A:vm-1', 'conflict', 's1', 's2'], ['iu:A:u2', 'vm:A:vm-2', 'dup', 's1', 's1']]);
  assert.equal(inv.resolved.get('iu:A:u1').serviceId, 's1', '판정은 새 키(바뀌지 않음)');
  assert.deepEqual(inv.queues.ghosts.map((x) => x.key), [], '옛 키 고정은 유령(일괄 정리 대상)이 되지 않는다');
  assert.deepEqual(inv.queues.mismatch.map((x) => [x.key, x.aliasKey, x.pinCorp]), [['st:moved', 'fl:old3', 'A']], '다른 법인(B)으로 옮겨 간 서버의 옛 법인(A) 별칭 고정은 법인 불일치로 보인다 · 법인을 모르는 구성원(bm4)은 판단하지 않는다');
});

test('6차 4: 다른 법인에 남은 베어메탈 옛 키 고정은 법인 불일치로 보이고 — 범위 계정에는 aliasKey 가 토큰·범위 밖 법인은 비움(R7)', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a' }, { id: 'vc-b', name: 'vcenter-b' }], [VM('live')]);
    const oldKey = `fl:${crypto.createHash('sha1').update('bm-7').digest('hex').slice(0, 16)}`;
    setup({ [oldKey]: P('svc-b', 'vc-b') }, { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }), 'vc-b': corpOf({ services: [S('svc-b', 'HR')] }) });
    registry.importServers([{ id: 'bm-7', name: 'srv7', host: 'https://192.0.2.87', username: 'root', password: 'x', serviceTag: 'TAG7X', vcenterId: 'vc-a' }], 'replace');
    const full = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.deepEqual(full.body.mismatch.map((x) => [x.key, x.aliasKey, x.pinCorp]), [['st:tag7x', oldKey, 'vc-b']]);
    assert.equal(full.body.ghostsN, 0);
    const sc = await call('GET /tools/svc-inventory/queues', { user: SCOPED, query: { corp: 'vc-a' } });
    assert.equal(sc.body.mismatch.length, 1); assert.match(sc.body.mismatch[0].aliasKey, /^masked-/); assert.match(sc.body.mismatch[0].key, /^masked-/);
    assert.equal(sc.body.mismatch[0].pinCorp, ''); assert.equal(/tag7x|vc-b|svc-b|fl:/i.test(JSON.stringify(sc.body.mismatch)), false);
    // 2회차 R1: 같은 구성원의 새 키·옛 키 불일치는 행 2 · 개수 1(구성원 수) · R2: 고정이 있는 법인(vc-b)으로 한 건씩 지운다
    sm.mutatePins((d) => { d.pins['st:tag7x'] = P('svc-b', 'vc-b'); return {}; });
    const q2 = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q2.body.mismatch.length, 2);
    const main = await call('GET /tools/svc-inventory', { query: {} });
    assert.equal(main.body.queues.mismatch, 1); assert.equal(main.body.queuesByCorp['vc-a'].mismatch, 1);
    for (const k of [oldKey, 'st:tag7x']) {
      const c = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-b', keys: [k] } });
      assert.equal(c.statusCode, 200, JSON.stringify(c.body)); assert.equal(c.body.result.changed, 1);
    }
    assert.equal(Object.keys(sm.getPins().pins).length, 0);
  } finally { store.snapshot = prev; }
});

test('6차 반증 F1(재현 경로): 법인 귀속이 빈 등록부 베어메탈의 옛 fl: 고정은 실제 라우트에서도 유령이 아니고 정리되지 않는다', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a' }], [VM('live')]);
    const oldKey = `fl:${crypto.createHash('sha1').update('bm-1').digest('hex').slice(0, 16)}`;
    setup({ [oldKey]: P('s1') });
    registry.importServers([{ id: 'bm-1', name: 'bm-1', host: 'https://192.0.2.81', username: 'root', password: 'x', serviceTag: 'TAG1' }], 'replace');
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q.statusCode, 200, JSON.stringify(q.body));
    assert.equal(q.body.ghostsN, 0, JSON.stringify(q.body.ghosts));
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.equal(dry.body.result.keys.length, 0);
    const pr = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: [oldKey] } });
    assert.equal(pr.body.result.removed, 0); assert.ok(sm.getPins().pins[oldKey]);
  } finally { store.snapshot = prev; }
});

test('6차 3: pins.rekey 는 충돌을 건너뛰고(conflicts) 중복은 옛 키만 지운다 · keys+keepNew 로 충돌의 옛 키를 지운다 · 옛 키 서비스로 고정하면 옛 키가 정리된다', async () => {
  const prev = store.snapshot;
  try {
    const vms = [VM('vm-1'), VM('vm-2'), VM('vm-3')];
    store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a' }], vms);
    setup({ 'iu:vc-a:u-vm-1': P('s1'), 'vm:vm-1': P('s2'), 'iu:vc-a:u-vm-2': P('s1'), 'vm:vm-2': P('s1'), 'vm:vm-3': P('s2') });
    const q0 = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.deepEqual(q0.body.aliasPins.items.map((x) => [x.key, x.state]).sort(), [['iu:vc-a:u-vm-1', 'conflict'], ['iu:vc-a:u-vm-2', 'dup'], ['iu:vc-a:u-vm-3', 'alias']]);
    const r1 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a' } });
    assert.equal(r1.statusCode, 200, JSON.stringify(r1.body));
    assert.deepEqual(r1.body.result, { moved: 1, dropped: 1, conflicts: 1 });
    const p1 = sm.getPins().pins;
    assert.ok(p1['vm:vm-1'], '충돌의 옛 키는 남는다'); assert.equal(p1['vm:vm-2'], undefined); assert.equal(p1['iu:vc-a:u-vm-3'].serviceId, 's2');
    const r2 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'] } });
    assert.deepEqual(r2.body.result, { moved: 0, dropped: 0, conflicts: 1 }, 'keepNew 없이 keys 만이면 여전히 건너뛴다');
    // '옛 키 서비스로' — pins.set 이 옛 키를 정리한다
    const r3 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], serviceId: 's2' } });
    assert.equal(r3.statusCode, 200); assert.equal(sm.getPins().pins['vm:vm-1'], undefined); assert.equal(sm.getPins().pins['iu:vc-a:u-vm-1'].serviceId, 's2');
    // '지금 것 유지'
    setup({ 'iu:vc-a:u-vm-1': P('s1'), 'vm:vm-1': P('s2') });
    const r4 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a', keys: ['iu:vc-a:u-vm-1'], keepNew: true } });
    assert.deepEqual(r4.body.result, { moved: 0, dropped: 1 }); assert.equal(sm.getPins().pins['vm:vm-1'], undefined); assert.equal(sm.getPins().pins['iu:vc-a:u-vm-1'].serviceId, 's1');
    const r5 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a', keys: ['iu:vc-a:nope'] } });
    assert.equal(r5.statusCode, 400, '되돌리지 못한 키뿐이면 400(조용히 0건 성공이 아니다)');
    // 반증 F6: 새 키 고정이 다른 법인 것(불일치 — 판정이 쓰지 않는다)이면 이 법인 옛 키 고정을 '이미 있음' 으로 지우지 않는다
    setup({ 'iu:vc-a:u-vm-1': P('s1', 'vc-b'), 'vm:vm-1': P('s2') });
    const r6 = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a' } });
    assert.deepEqual(r6.body.result, { moved: 0, dropped: 0, otherCorp: 1 }); assert.ok(sm.getPins().pins['vm:vm-1']);
  } finally { store.snapshot = prev; }
});

// ───────── 5·6: 범위 가림 · 법인 미지정 ─────────
test('6차 5: 범위 계정 mismatch 에 범위 밖 법인 id·서비스 id 를 싣지 않는다(전체 범위는 그대로) · 6: nocorp=1 은 법인 귀속 없는 미지정만', async () => {
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a' }, { id: 'vc-b', name: 'vcenter-b' }], [VM('vm-1'), VM('vm-2')]);
    setup({ 'iu:vc-a:u-vm-1': { serviceId: 'svc-b-secret', corp: 'vc-b', by: 'x', at: 1 } }, { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }), 'vc-b': corpOf({ services: [S('svc-b-secret', 'HR')] }) });
    registry.importServers([{ id: 'bm-n', name: 'nocorp-srv', host: 'https://192.0.2.70', username: 'root', password: 'x', serviceTag: 'NOCORP1' }], 'replace');
    const full = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(full.body.mismatch[0].pinCorp, 'vc-b'); assert.equal(full.body.mismatch[0].serviceId, 'svc-b-secret');
    const sc = await call('GET /tools/svc-inventory/queues', { user: SCOPED, query: { corp: 'vc-a' } });
    assert.equal(sc.statusCode, 200);
    assert.equal(sc.body.mismatch.length, 1); assert.equal(sc.body.mismatch[0].pinCorpHidden, true);
    assert.equal(/vc-b|svc-b-secret/.test(JSON.stringify(sc.body.mismatch)), false);
    const nc = await call('GET /tools/svc-inventory/members', { query: { nocorp: '1' } });
    assert.equal(nc.statusCode, 200, JSON.stringify(nc.body));
    assert.deepEqual(nc.body.members.map((m) => m.name), ['nocorp-srv'], '법인 있는 미지정 VM(vm-2)은 빠진다');
    const ncs = await call('GET /tools/svc-inventory/members', { user: SCOPED, query: { nocorp: '1' } });
    assert.equal(ncs.body.members.length, 0, '범위 계정에는 법인 미지정 구성원을 싣지 않는다');
    // 트리 '(법인 미지정)' 의 기본 탭(미지정 묶음)도 같은 경로 — 큐 nocorp=1 은 법인 없는 묶음만(예전에는 전 법인 묶음)
    const all = await call('GET /tools/svc-inventory/queues', {});
    assert.ok(all.body.unassigned.some((x) => x.corp === 'vc-a') && all.body.unassigned.some((x) => !x.corp));
    const qn = await call('GET /tools/svc-inventory/queues', { query: { nocorp: '1' } });
    assert.ok(qn.body.unassigned.length >= 1); assert.ok(qn.body.unassigned.every((x) => !x.corp), JSON.stringify(qn.body.unassigned.map((x) => x.key)));
    assert.equal(qn.body.mismatch.length, 0);
    const qns = await call('GET /tools/svc-inventory/queues', { user: SCOPED, query: { nocorp: '1' } });
    assert.equal(qns.body.unassigned.length, 0, '범위 계정은 법인 없는 묶음을 받지 않는다');
  } finally { store.snapshot = prev; }
});

// ───────── 8: 저장소 ─────────
test('6차 8: mutatePins 는 바뀐 키만 정리·동결한다 — 안 바뀐 항목은 같은 객체 · 항목을 고치면 던지고 상태는 그대로 · 모르는 모양은 버린다 · 상한', () => {
  const pins = {}; for (let i = 0; i < 2000; i++) pins[`iu:vc-a:${i}`] = P('s1');
  setup(pins);
  const before = sm.peekPins();
  const keep = before['iu:vc-a:5'];
  const r = sm.mutatePins((d) => {
    d.pins['iu:vc-a:1'] = { ...d.pins['iu:vc-a:1'], reviewed: true, reviewedAuto: null, extra: 'drop-me' };
    d.pins['iu:vc-a:new'] = { serviceId: 's2', corp: 'vc-a', by: 'lee', at: 2 };
    d.pins['bad'] = { serviceId: 1 };
    delete d.pins['iu:vc-a:2'];
    return { result: { ok: 1 } };
  });
  assert.equal(r.ok, true);
  const after = sm.peekPins();
  assert.equal(after['iu:vc-a:5'], keep, '안 바뀐 항목은 복사하지 않는다(같은 객체)');
  assert.ok(Object.isFrozen(after) && Object.isFrozen(after['iu:vc-a:new']) && Object.isFrozen(after['iu:vc-a:1']));
  assert.deepEqual(after['iu:vc-a:1'], { serviceId: 's1', corp: 'vc-a', by: 'kim', at: 1, reviewed: true, reviewedAuto: null }, '바뀐 항목은 정리(모르는 필드 버림)');
  assert.equal(after.bad, undefined); assert.equal(after['iu:vc-a:2'], undefined);
  assert.equal(Object.keys(after).length, 2000);
  const rev = sm.storeRev();
  assert.throws(() => sm.mutatePins((d) => { d.pins['iu:vc-a:7'].serviceId = 's2'; return {}; }), TypeError, '동결 항목을 고치면 던진다');
  assert.equal(sm.peekPins()['iu:vc-a:7'].serviceId, 's1'); assert.equal(sm.storeRev(), rev, '상태·rev 그대로');
  const er = sm.mutatePins((d) => { d.pins['iu:vc-a:x'] = P('s1'); return { error: '멈춤' }; });
  assert.equal(er.ok, false); assert.equal(sm.peekPins()['iu:vc-a:x'], undefined);
  const over = sm.mutatePins((d) => { for (let i = 0; i <= sm.LIMITS.pins; i++) d.pins[`k${i}`] = P('s1'); return {}; });
  assert.equal(over.ok, false); assert.equal(over.status, 400); assert.equal(Object.keys(sm.peekPins()).length, 2000);
});

test('6차 8: 유령은 앞 500행 + 전체·법인별 개수 · 정리 미리보기 키는 5000건 상한(total 로 밝힘)', async () => {
  const pins = {}; for (let i = 0; i < 5100; i++) pins[`iu:vc-a:g${i}`] = P('s1');
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf([{ id: 'vc-a', name: 'vcenter-a' }], [VM('live')]);
    setup(pins);
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q.body.ghosts.length, 500); assert.equal(q.body.ghostsN, 5100); assert.deepEqual(q.body.ghostsByCorp, { 'vc-a': 5100 });
    const dry = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.equal(dry.body.result.keys.length, 5000); assert.equal(dry.body.result.total, 5100);
    const pr = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: dry.body.result.keys } });
    assert.equal(pr.body.result.removed, 5000); assert.equal(Object.keys(sm.getPins().pins).length, 100);
  } finally { store.snapshot = prev; }
});

// ───────── 2: 엣지 태그 없는 id ─────────
test('6차 2: 엣지 untaggedId → 중앙 정제(글자만·소문자) → serverId 승계 → 별칭 키가 태그 읽히기 전 키와 같다 · 구버전 엣지는 null', () => {
  central.resetEdgeFleet();
  const edgeRow = { serverId: 'BM-3', name: 'srv3', serviceTag: '' };
  const untagged = fleetUntaggedId(edgeRow);
  assert.equal(untagged, 'bm-3');
  assert.equal(fleetUntaggedId({ serverId: 'host:vc:esx1', name: 'ESX1' }), 'esx1', 'ESXi 호스트 행은 이름');
  // 태그를 읽기 전: 엣지 fleetId = untagged → 중앙 serverId edge:agt:bm-3 → 옛 키
  central.setEdgeFleet('agt', [{ fleetId: untagged, name: 'srv3', serviceTag: '', vcenterId: 'vc-a', untaggedId: untagged }], Date.now());
  const before = classifyFleet({ servers: central.getEdgeFleetServers() }).bareMetal[0];
  const oldKey = bmKeyOf(before).key;
  assert.match(oldKey, /^fl:/);
  // 태그를 읽은 뒤: fleetId = 태그 → serverId 가 바뀐다. untaggedId 로 옛 키를 별칭으로 만든다.
  central.setEdgeFleet('agt', [{ fleetId: 'tag33', name: 'srv3', serviceTag: 'TAG33', vcenterId: 'vc-a', untaggedId: 'BM-3' }], Date.now());
  const srv = central.getEdgeFleetServers()[0];
  assert.equal(srv.untaggedServerId, 'edge:agt:bm-3', '정제가 소문자로');
  const after = classifyFleet({ servers: central.getEdgeFleetServers() }).bareMetal[0];
  assert.equal(after.untaggedServerId, 'edge:agt:bm-3', '함대 행에 실린다');
  assert.equal(bmKeyOf(after).key, 'st:tag33');
  assert.deepEqual(bmAliasKeys(after, 'serviceTag'), [oldKey], '태그 읽힌 뒤의 별칭 = 태그 읽기 전 키');
  // 구버전 엣지(필드 없음) · 객체 등 엉뚱한 값은 null
  central.setEdgeFleet('agt', [{ fleetId: 'tag33', name: 'srv3', serviceTag: 'TAG33', vcenterId: 'vc-a' }, { fleetId: 'x', name: 'x', serviceTag: 'X1', untaggedId: { a: 1 } }], Date.now());
  assert.deepEqual(central.getEdgeFleetServers().map((x) => x.untaggedServerId), [null, null]);
  const fallback = bmAliasKeys({ serverId: 'edge:agt:tag33', serviceTag: 'TAG33' }, 'serviceTag');
  assert.notDeepEqual(fallback, [oldKey], '필드가 없으면 승계하지 못한다(예전과 같다)');
  assert.equal(crypto.createHash('sha1').update('edge:agt:bm-3').digest('hex').slice(0, 16), oldKey.slice(3));
  central.resetEdgeFleet();
});

// ───────── 예약 1-b·1-d: 폴더·규칙 수정 ─────────
test('예약 1-b: folder.rename 은 하위 폴더·서비스 경로까지 · 같은 이름이 있으면 409 · folder.remove moveUp 은 한 단계 위로 · expect 가 다르면 409', () => {
  const base = () => ({ globals: [], corps: { A: corpOf({ folders: ['업무\\개발', '업무\\운영'], services: [S('s1', 'ERP', '업무\\개발'), S('s2', 'MES', '업무'), S('s3', 'AD', '')] }) } });
  let d = base();
  assert.deepEqual(CORP_OPS['folder.rename'](d, { corp: 'A', path: '업무', name: '시스템' }).result, { path: '업무', to: '시스템', services: 2 });
  assert.deepEqual(d.corps.A.folders.sort(), ['시스템\\개발', '시스템\\운영']);
  assert.deepEqual(d.corps.A.services.map((s) => s.path), ['시스템\\개발', '시스템', '']);
  d = base();
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: '업무\\개발', name: '운영' }).status, 409, '이미 있는 폴더와 합치지 않는다');
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: '업무\\개발', name: 'a\\b' }).status, 400, '이름에 구분자 금지');
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: '없음', name: 'x' }).status, 404);
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: '업무\\개발', name: '개발' }).result.same, true);
  // 반증 F3: 대소문자만 다른 형제와 합치지 않는다 · 대소문자만 바꾸는 개명은 된다
  d = { globals: [], corps: { A: corpOf({ folders: ['Ops', 'ops'], services: [S('s1', 'ERP', 'Ops')] }) } };
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: 'Ops', name: 'ops' }).status, 409);
  d = { globals: [], corps: { A: corpOf({ folders: ['Ops'], services: [S('s1', 'ERP', 'Ops')] }) } };
  assert.equal(CORP_OPS['folder.rename'](d, { corp: 'A', path: 'Ops', name: 'OPS' }).result.to, 'OPS');
  assert.deepEqual(d.corps.A.folders, ['OPS']); assert.equal(d.corps.A.services[0].path, 'OPS');
  // 반증 F4: 걷어 내면 하위 폴더가 부모 아래 같은 이름과 합쳐지는 경우 409
  d = { globals: [], corps: { A: corpOf({ folders: ['업무', '업무\\개발', '개발'], services: [S('s1', 'ERP', '업무\\개발'), S('s2', 'MES', '개발')] }) } };
  assert.equal(CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무', moveUp: true, expect: 1 }).status, 409);
  assert.deepEqual(d.corps.A.services.map((x) => x.path), ['업무\\개발', '개발'], '409 면 아무것도 바뀌지 않는다(mutateMap 이 draft 를 버리기 전에도)');
  d = base();
  assert.equal(CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무' }).status, 409, '서비스가 있으면 moveUp 없이 지우지 않는다');
  assert.equal(CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무', moveUp: true, expect: 1 }).status, 409, '화면이 본 수와 다르면 409');
  assert.deepEqual(CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무', moveUp: true, expect: 2 }).result, { path: '업무', moved: 2 });
  assert.deepEqual(d.corps.A.services.map((s) => s.path), ['개발', '', '']);
  assert.deepEqual(d.corps.A.folders.sort(), ['개발', '운영']);
  d = base();
  CORP_OPS['folder.remove'](d, { corp: 'A', path: '업무\\운영' });
  assert.deepEqual(d.corps.A.folders, ['업무\\개발'], '빈 폴더는 그냥 지운다');
});

test('예약 1-d: rule/alias/namerule.update 는 대상 서비스만 바꾼다 · 없는 규칙 404 · 없는 서비스 404 · 같은 대상은 same · 서비스 이름과 같은 별칭은 409', () => {
  const d = { globals: [], corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }], aliases: [{ kind: 'tag', value: 'erp-t', serviceId: 's1' }, { kind: 'scan', value: 'MES', serviceId: 's1' }], nameRules: [{ match: 'prefix', value: 'erp-', serviceId: 's1' }] }) } };
  assert.equal(CORP_OPS['rule.update'](d, { corp: 'A', prefix: '/ERP/', serviceId: 's2' }).result.prefix, '/ERP', '접두 정리(끝 / 제거) 뒤 같은 규칙');
  assert.equal(d.corps.A.folderRules[0].serviceId, 's2');
  assert.equal(CORP_OPS['rule.update'](d, { corp: 'A', prefix: '/ERP', serviceId: 's2' }).result.same, true);
  assert.equal(CORP_OPS['rule.update'](d, { corp: 'A', prefix: '/none', serviceId: 's2' }).status, 404);
  assert.equal(CORP_OPS['rule.update'](d, { corp: 'A', prefix: '/ERP', serviceId: 'nope' }).status, 404);
  assert.equal(CORP_OPS['alias.update'](d, { corp: 'A', kind: 'tag', value: 'ERP-T', serviceId: 's2' }).result.value, 'erp-t', '대소문자 무시');
  assert.equal(d.corps.A.aliases[0].serviceId, 's2');
  assert.equal(CORP_OPS['alias.update'](d, { corp: 'A', kind: 'scan', value: 'MES', serviceId: 's2' }).status, 409, '서비스 이름과 같은 별칭은 쓰이지 않는다');
  assert.equal(CORP_OPS['alias.update'](d, { corp: 'A', kind: 'scan', value: 'erp-t', serviceId: 's2' }).status, 404, '종류가 다르면 다른 별칭');
  assert.deepEqual(CORP_OPS['namerule.update'](d, { corp: 'A', match: 'prefix', value: 'ERP-', serviceId: 's2' }), { result: {} });
  assert.equal(d.corps.A.nameRules[0].serviceId, 's2');
  assert.equal(CORP_OPS['namerule.update'](d, { corp: 'A', match: 'suffix', value: 'erp-', serviceId: 's2' }).status, 404);
});
