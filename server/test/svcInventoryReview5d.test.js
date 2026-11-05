// 서비스 인벤토리 5차 검토 4차 반영 — docs/design/service-map/README.md §5차 검토(사용자 '4차 진행해줘' · 표준 + 반증 1인).
//   R7(결정 ⑤) 범위 계정 판본은 베어메탈 서비스태그를 싣지 않는다 — 키는 프로세스 HMAC 토큰, 쓰기는 토큰 → 원래 키(원문 베어메탈 키는 받지 않는다).
//   R15 키 등급 전환(moref → instanceUuid · fleetId → 서비스태그) 때 옛 키 고정을 승계하고, 반대 방향(태그를 잠시 못 읽음)은 유령이 아니라 판정 보류.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svcinv-r5d-'));
process.env.CONFIG_DIR = tmp;

const { resolveMember, buildIndex } = await import('../src/servicemap/resolve.js');
const { buildInventory } = await import('../src/servicemap/build.js');
const sm = await import('../src/servicemap/store.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerSvcInventory, keyResolverFor, pubKey, stripTag } = await import('../src/routes/api/svcInventory.js');

const S = (id, name) => ({ id, name, path: '', tier: 2, owner: '', note: '', globalId: '' });
const corpOf = (c = {}) => ({ folders: [], services: [], folderRules: [], aliases: [], nameRules: [], tagEnabled: false, ...c });
const routes = new Map();
registerSvcInventory({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const SCOPED_ADMIN = { username: 'adm-a', role: 'admin', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: key.replace(/^\w+ /, '/api') }, res);
  return res;
}
const TAG = 'TAG111'; const TAG2 = 'ZZ9GONE';
const hasTag = (x) => /tag111|zz9gone/i.test(typeof x === 'string' ? x : JSON.stringify(x));

function setup(pins = {}) {
  registry.importServers([{ id: 'bm-1', name: TAG, host: 'https://192.0.2.60', username: 'root', password: 'x', serviceTag: TAG, vcenterId: 'vc-a' }], 'replace');
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: { 'vc-a': corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's1' }] }) } }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins }));
}
// v2.906: 세대(generatedAt)는 늘 커지게 — 예전 'Date.now() + n' 은 앞 테스트(n 이 더 큰)와 시각 차가 정확히 n 차이면 같은 세대가 되어
//   수집 기억(열쇠 = generatedAt)이 앞 테스트의 구성원을 돌려줬다(전량 실행에서만 간헐 실패 — R15 '0 !== 3'). 운영 세대는 수집마다 새 시각이다.
let _gen = Date.now();
const snapOf = (n, vms = []) => ({ ...store.snapshot, generatedAt: (_gen += 10_000) + n, vcenters: [{ id: 'vc-a', name: 'vcenter-a' }], hosts: [], vms });

test('R7: 범위 계정 판본의 구성원·큐·후보·CSV·유령 정리 미리보기에 서비스태그가 없다(키는 토큰) — 전체 범위 관리자는 그대로', async () => {
  setup({ [`st:${TAG2.toLowerCase()}`]: { serviceId: 's1', corp: 'vc-a', by: 'a', at: 1 } });   // 유령(서버 없음)
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf(101);
    const full = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', unassigned: '1' } });
    assert.equal(full.statusCode, 200, JSON.stringify(full.body));
    assert.equal(full.body.members[0].key, `st:${TAG.toLowerCase()}`); assert.equal(full.body.members[0].serviceTag, TAG, '전체 범위는 그대로');
    for (const user of [SCOPED, SCOPED_ADMIN]) {
      const m = await call('GET /tools/svc-inventory/members', { user, query: { corp: 'vc-a', unassigned: '1' } });
      assert.equal(m.statusCode, 200, JSON.stringify(m.body));
      assert.equal(m.body.members.length, 1); assert.match(m.body.members[0].key, /^masked-/);
      assert.equal(hasTag(m.body), false, `${user.username} 구성원 응답에 태그 없음(이름이 태그인 서버는 이름도 가림)`);
      const q = await call('GET /tools/svc-inventory/queues', { user, query: { corp: 'vc-a' } });
      assert.equal(q.statusCode, 200); assert.equal(hasTag(q.body), false, '큐(미지정 묶음 키·이름 · 유령 키)에 태그 없음');
      assert.equal(q.body.ghosts.length, 1); assert.match(q.body.ghosts[0].key, /^masked-/);
      const c = await call('GET /tools/svc-inventory/candidates', { user, query: { kind: 'bm', corp: 'vc-a', q: 'tag1' } });
      assert.equal(c.statusCode, 200); assert.equal(c.body.items.length, 0, '서비스태그로 찾아 맞혀 볼 수 없다');
      const c2 = await call('GET /tools/svc-inventory/candidates', { user, query: { kind: 'bm', corp: 'vc-a' } });
      assert.equal(c2.body.items.length, 1); assert.equal(hasTag(c2.body), false);
      const csv = await call('GET /tools/svc-inventory.csv', { user });
      assert.equal(csv.statusCode, 200, JSON.stringify(csv.body)); assert.equal(hasTag(csv.body), false, 'CSV 에도 없음');
    }
    const fc = await call('GET /tools/svc-inventory/candidates', { query: { kind: 'bm', corp: 'vc-a', q: 'tag1' } });
    assert.equal(fc.body.items.length, 1, '전체 범위는 태그로 찾는다');
    const dry = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'ghosts.prune', corp: 'vc-a', dry: true } });
    assert.equal(dry.statusCode, 200, JSON.stringify(dry.body)); assert.equal(hasTag(dry.body), false); assert.match(dry.body.result.keys[0], /^masked-/);
    const pr = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'ghosts.prune', corp: 'vc-a', keys: dry.body.result.keys } });
    assert.deepEqual(pr.body.result, { removed: 1, skipped: 0 }, '토큰으로 받은 키를 되돌려 지운다');
  } finally { store.snapshot = prev; }
});

test('R7: 범위 계정 쓰기는 토큰 → 원래 키 · 원문 베어메탈 키는 받지 않는다(태그를 맞혀 보는 길) · 고정은 원래 키로 저장된다', async () => {
  setup();
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf(111);
    const m = await call('GET /tools/svc-inventory/members', { user: SCOPED, query: { corp: 'vc-a', unassigned: '1' } });
    const token = m.body.members[0].key;
    const raw = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'pins.set', corp: 'vc-a', keys: [`st:${TAG.toLowerCase()}`], serviceId: 's2' } });
    assert.equal(raw.statusCode, 200); assert.deepEqual(raw.body.result, { changed: 0, skipped: 1 }, '원문 키는 건너뛴다');
    const ok = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'pins.set', corp: 'vc-a', keys: [token], serviceId: 's2' } });
    assert.deepEqual(ok.body.result, { changed: 1, skipped: 0 });
    assert.equal(sm.getPins().pins[`st:${TAG.toLowerCase()}`]?.serviceId, 's2', '원래 키로 저장');
    const clr = await call('POST /tools/svc-inventory/op', { user: SCOPED, body: { op: 'pins.clear', corp: 'vc-a', keys: [token, 'masked-000000000000'] } });
    assert.deepEqual(clr.body.result, { changed: 1, skipped: 1 }, '모르는 토큰은 건너뛴다');
    assert.equal(Object.keys(sm.getPins().pins).length, 0);
    // 전체 범위는 원문 키 그대로
    const fa = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: [`st:${TAG.toLowerCase()}`], serviceId: 's2' } });
    assert.deepEqual(fa.body.result, { changed: 1, skipped: 0 });
  } finally { store.snapshot = prev; }
});

test('R7: 토큰 되돌리기는 후보 안에서만(다른 법인 키의 토큰은 모른다) · VM 키는 가리지 않는다', () => {
  const r = keyResolverFor(true, ['st:aaa', 'iu:vc-a:u1']);
  assert.equal(r(pubKey('st:aaa', true)), 'st:aaa');
  assert.equal(r(pubKey('st:bbb', true)), '', '후보 밖');
  assert.equal(r('st:aaa'), '', '원문 베어메탈 키 거부');
  assert.equal(r('iu:vc-a:u1'), 'iu:vc-a:u1', 'VM 키는 그대로');
  assert.equal(pubKey('iu:vc-a:u1', true), 'iu:vc-a:u1');
  assert.equal(keyResolverFor(false, [])('st:aaa'), 'st:aaa', '전체 범위는 그대로');
});

test('R15: 키 등급이 오르면 옛 키 고정을 승계한다(유령 아님 · 옮기기 큐) · VM 식별 키를 못 읽는 법인의 iu: 고정은 판정 보류 · 드리프트 행은 실제 고정의 사람·시각', () => {
  const map = { corps: { A: corpOf({ services: [S('s1', 'ERP'), S('s2', 'MES')], folderRules: [{ prefix: '/ERP', serviceId: 's2' }] }) } };
  const vm = { key: 'iu:A:u1', aliasKeys: ['vm:A:vm-1'], kind: 'vm', corp: 'A', name: 'v1', folderPath: '/ERP' };
  const pins = { 'vm:A:vm-1': { serviceId: 's1', corp: 'A', by: 'kim', at: 7 }, 'st:zz9gone': { serviceId: 's1', corp: 'A', by: 'x', at: 1 }, 'iu:A:gone': { serviceId: 's1', corp: 'A', by: 'x', at: 1 }, 'iu:B:gone': { serviceId: 's1', corp: 'B', by: 'x', at: 1 } };
  const r = resolveMember(vm, buildIndex(map), {}, pins);
  assert.equal(r.src, 'pin'); assert.equal(r.serviceId, 's1'); assert.equal(r.pinKey, 'vm:A:vm-1');
  const inv = buildInventory({ members: [vm], map, pins, uuidUnreadCorps: new Set(['A']) });
  assert.deepEqual(inv.queues.aliasPins.map((x) => [x.key, x.aliasKey]), [['iu:A:u1', 'vm:A:vm-1']]);
  assert.deepEqual(inv.queues.drift.map((x) => [x.key, x.pin.by, x.pin.at]), [['iu:A:u1', 'kim', 7]], '별칭 고정의 드리프트 행도 고정한 사람·시각(4차 반증 6)');
  assert.deepEqual(inv.queues.ghosts.map((x) => x.key).sort(), ['st:zz9gone'], "별칭 고정은 유령이 아니다 · st: 고정은 '함대가 안다' 로 붙잡지 않는다(4차 반증 2 — ESXi 가 된 서버)");
  // instanceUuid 를 못 읽는 법인은 보류(4차 반증 5) · VM 이 한 대도 없는 법인 B 의 VM 고정도 보류(6차 1 — 예전에는 유령)
  assert.deepEqual(inv.queues.ghostsHeld.map((x) => [x.key, x.held]).sort(), [['iu:A:gone', 'uuid-unread'], ['iu:B:gone', 'corp-no-vms']]);
  const otherCorp = resolveMember({ ...vm, corp: 'B', key: 'iu:B:u9' }, buildIndex(map), {}, pins);
  assert.equal(otherCorp.src, 'none', '다른 법인의 별칭 고정은 쓰지 않는다');
});

test('R7: 이름에 서비스태그가 부분 문자열로 들어 있으면 그 부분을 가린다(4차 반증 3) — 찾기·CSV 도', async () => {
  assert.equal(stripTag('idrac-ABC1234', 'abc1234'), 'idrac-•••');
  assert.equal(stripTag('ABC1234-abc1234', 'ABC1234'), '•••-•••');
  assert.equal(stripTag('web01', 'abc1234'), 'web01');
  registry.importServers([{ id: 'bm-9', name: 'idrac-ABC1234', host: 'https://192.0.2.61', username: 'root', password: 'x', serviceTag: 'ABC1234', vcenterId: 'vc-a' }], 'replace');
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }) } }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf(131);
    const m = await call('GET /tools/svc-inventory/members', { user: SCOPED, query: { corp: 'vc-a', unassigned: '1' } });
    assert.equal(m.body.members[0].name, 'idrac-•••'); assert.equal(/abc1234/i.test(JSON.stringify(m.body)), false);
    const c = await call('GET /tools/svc-inventory/candidates', { user: SCOPED, query: { kind: 'bm', corp: 'vc-a', q: 'abc12' } });
    assert.equal(c.body.items.length, 0);
    const csv = await call('GET /tools/svc-inventory.csv', { user: SCOPED });
    assert.equal(/abc1234/i.test(String(csv.body)), false);
    const full = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', unassigned: '1' } });
    assert.equal(full.body.members[0].name, 'idrac-ABC1234', '전체 범위는 그대로');
  } finally { store.snapshot = prev; }
});

test('R15: 베어메탈 — 서비스태그가 나중에 읽혀도(fl: → st:) 그 전 고정을 실제 라우트에서 승계한다(4차 반증 1: 예전에는 별칭이 맞지 않아 유령) · 같은 키 두 번 정리는 한 번', async () => {
  registry.importServers([{ id: 'bm-7', name: 'rack7-db', host: 'https://192.0.2.62', username: 'root', password: 'x', vcenterId: 'vc-a' }], 'replace');
  sm._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: { 'vc-a': corpOf({ services: [S('s1', 'ERP')] }) } }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf(141);
    const m1 = await call('GET /tools/svc-inventory/members', { query: { corp: 'vc-a', unassigned: '1' } });
    const flKey = m1.body.members[0].key; assert.match(flKey, /^fl:/);
    const set = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: [flKey], serviceId: 's1' } });
    assert.deepEqual(set.body.result, { changed: 1, skipped: 0 });
    // 서비스태그가 읽혔다 — 키가 st: 로 오른다
    registry.importServers([{ id: 'bm-7', name: 'rack7-db', host: 'https://192.0.2.62', username: 'root', password: 'x', serviceTag: 'NEW7TAG', vcenterId: 'vc-a' }], 'replace');
    store.snapshot = snapOf(142);
    const m2 = await call('GET /tools/svc-inventory/members', { query: { service: 's1' } });
    assert.equal(m2.statusCode, 200, JSON.stringify(m2.body));
    assert.deepEqual(m2.body.members.map((x) => [x.key, x.src]), [['st:new7tag', 'pin']], '옛 fl: 고정이 소속을 정한다');
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q.body.ghosts.length, 0, '유령이 아니다'); assert.equal(q.body.aliasPins.n, 1); assert.deepEqual(q.body.aliasPins.corps, ['vc-a']);
    const rk = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a' } });
    assert.deepEqual(rk.body.result, { moved: 1, dropped: 0 }); assert.deepEqual(Object.keys(sm.getPins().pins), ['st:new7tag']);
    // 같은 유령 키를 두 번 보내도 건너뜀으로 세지 않는다(4차 반증 7)
    sm.mutatePins((d) => { d.pins['st:ghost7'] = { serviceId: 's1', corp: 'vc-a', by: 'a', at: 1 }; return { result: {} }; });
    const pr = await call('POST /tools/svc-inventory/op', { body: { op: 'ghosts.prune', corp: 'vc-a', keys: ['st:ghost7', 'st:ghost7'] } });
    assert.deepEqual(pr.body.result, { removed: 1, skipped: 0 });
  } finally { store.snapshot = prev; }
});

test('R15: 새 키로 옮기기(pins.rekey) · 고정 쓰기는 별칭을 새 키로 옮긴다 · 별칭 고정을 지우면 정말 지워진다', async () => {
  const vmOf = (id, uuid) => ({ id, vcenterId: 'vc-a', name: id, folderPath: '/x', instanceUuid: uuid, powerState: 'POWERED_ON', cpuCount: 1, memMB: 1024 });
  setup({ 'vm:vm-1': { serviceId: 's2', corp: 'vc-a', by: 'a', at: 1 }, 'vm:vm-2': { serviceId: 's2', corp: 'vc-a', by: 'a', at: 1 }, 'vm:vm-3': { serviceId: 's2', corp: 'vc-a', by: 'a', at: 1 } });
  const prev = store.snapshot;
  try {
    store.snapshot = snapOf(121, [vmOf('vm-1', 'u-1'), vmOf('vm-2', 'u-2'), vmOf('vm-3', 'u-3')]);
    const mem = await call('GET /tools/svc-inventory/members', { query: { service: 's2' } });
    assert.equal(mem.statusCode, 200, JSON.stringify(mem.body)); assert.equal(mem.body.members.length, 3, '옛 키 고정이 그대로 소속을 정한다(예전에는 전부 유령)');
    const q = await call('GET /tools/svc-inventory/queues', { query: { corp: 'vc-a' } });
    assert.equal(q.body.ghosts.length, 0); assert.equal(q.body.aliasPins.n, 3);
    // 하나는 지우기(별칭이어도 정말 지워진다) · 하나는 다시 고정(새 키로 옮겨진다)
    const clr = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.clear', corp: 'vc-a', keys: ['iu:vc-a:u-1'] } });
    assert.deepEqual(clr.body.result, { changed: 1, skipped: 0 });
    const set = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.set', corp: 'vc-a', keys: ['iu:vc-a:u-2'], serviceId: 's1' } });
    assert.deepEqual(set.body.result, { changed: 1, skipped: 0 });
    let p = sm.getPins().pins;
    assert.equal(p['vm:vm-1'], undefined); assert.equal(p['vm:vm-2'], undefined); assert.equal(p['iu:vc-a:u-2']?.serviceId, 's1');
    const rk = await call('POST /tools/svc-inventory/op', { body: { op: 'pins.rekey', corp: 'vc-a' } });
    assert.equal(rk.statusCode, 200, JSON.stringify(rk.body)); assert.deepEqual(rk.body.result, { moved: 1, dropped: 0 });
    p = sm.getPins().pins;
    assert.deepEqual(Object.keys(p).sort(), ['iu:vc-a:u-2', 'iu:vc-a:u-3']); assert.equal(p['iu:vc-a:u-3'].serviceId, 's2', '소속은 그대로');
    const scopedRk = await call('POST /tools/svc-inventory/op', { user: { username: 'v', role: 'operator', scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } }, body: { op: 'pins.rekey', corp: 'vc-a' } });
    assert.equal(scopedRk.statusCode, 404, '범위 밖 법인은 쓰기 404');
  } finally { store.snapshot = prev; }
});
