// 랙 실장도 — 가림 재료는 줄지 않는다(2026-11-27 · 설계 docs/design/rack-mask-redesign J4).
//   반증 재현: 엣지가 올린 서버 목록은 메모리에만 있어(collector/remoteInventory.js), 비어 있는 동안(중앙 재시작 직후 · 수집 서버를 끈 뒤)
//   그 서버의 관리 호스트 이름 · 태그가 든 이름이 조회 계정에 원문으로 나갔다. 한 번 본 재료는 원장 옆(rack_mask_seen)에 남긴다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackseen-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
after(() => R._closeForTest());
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_ALL = U('op', 'operator'); const OP_A = U('op-a', 'operator', ['vc-a']);
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const edge = (id, host, tag) => ({ id, name: `remote-${id}`, host: `https://${host}`, serviceTag: tag, vcenterId: 'vc-a' });
const labelOf = async (user, roomId, placeId) => (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body.places.find((p) => p.id === placeId).label;

let roomId = ''; let rackId = ''; let rev = 0;
async function place(label, u) {
  const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uStart: u, uSize: 1, kind: 'other', label } });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body)); rev = p.body.rev;
  return p.body.id;
}

test('엣지 서버 목록이 비어도 · 원장을 다시 열어도 그 서버의 주소 · 태그가 든 이름은 가려진다', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } });
  rackId = k.body.id; rev = k.body.rev;
  RI.setCollectorServers('edge1', 'kr', [edge('r1', 'idrac-r1.edge.example', 'RMT0001')]);
  const pid = await place('kvm idrac-r1.edge.example RMT0001', 1);
  RT._resetAbsorbForTest();
  // 목록이 있을 때
  assert.match(await labelOf(OP_ALL, roomId, pid), /^kvm masked-[0-9a-f]+ RMT0001$/);
  assert.match(await labelOf(OP_A, roomId, pid), /^kvm masked-[0-9a-f]+ •••$/);
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 1, tags: 1 });
  // 목록이 비었을 때(수집 서버를 끔 · 재시작 직후와 같은 상태) — 예전엔 두 계정 모두 원문
  RI.clearCollectorServers('edge1');
  assert.match(await labelOf(OP_ALL, roomId, pid), /^kvm masked-[0-9a-f]+ RMT0001$/, '주소');
  assert.match(await labelOf(OP_A, roomId, pid), /^kvm masked-[0-9a-f]+ •••$/, '주소 · 태그');
  // 이력 글도 같은 가림
  const logs = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body.logs.map((l) => l.detail).join('\n');
  assert.ok(!/idrac-r1|RMT0001/i.test(logs), logs);
  // 원장을 다시 연다(프로세스를 다시 띄운 것과 같다 — 메모리의 사본은 없고 파일의 기록만 남는다)
  R._closeForTest(); RT._resetAbsorbForTest();
  assert.match(await labelOf(OP_A, roomId, pid), /^kvm masked-[0-9a-f]+ •••$/, '다시 연 뒤');
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 1, tags: 1 }, '같은 값을 다시 넣지 않는다');
  // 관리자는 원문
  assert.equal(await labelOf(ADMIN, roomId, pid), 'kvm idrac-r1.edge.example RMT0001');
});

test('재료 기록은 누가 보든 채운다 — 관리자만 연 뒤 목록이 비어도 조회 계정에게 가려진다', async () => {
  RI.setCollectorServers('edge2', 'kr', [edge('r2', 'idrac-r2.edge.example', 'RMT0002')]);
  const pid = await place('pdu idrac-r2.edge.example RMT0002', 3);
  RT._resetAbsorbForTest();
  assert.equal(await labelOf(ADMIN, roomId, pid), 'pdu idrac-r2.edge.example RMT0002');   // 관리자 요청 — 가리지 않지만 재료는 기록한다
  RI.clearCollectorServers('edge2');
  assert.match(await labelOf(OP_A, roomId, pid), /^pdu masked-[0-9a-f]+ •••$/);
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 2, tags: 2 });
});

test('관리자 요청의 기록은 간격을 둔다(요청마다 등록부 전체 · 인벤토리를 훑지 않는다) — 조회 계정 요청은 매번 지금 재료를 더한다', async () => {
  RT._resetAbsorbForTest();
  await labelOf(ADMIN, roomId, (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.places[0].id);   // 이번 관리자 요청이 간격을 시작한다
  RI.setCollectorServers('edge3', 'kr', [edge('r3', 'idrac-r3.edge.example', 'RMT0003')]);
  await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } });
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 2, tags: 2 }, '간격 안의 관리자 요청은 기록하지 않는다');
  await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } });
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 3, tags: 3 }, '조회 계정 요청은 지금 재료를 기록에 더한다(시리얼을 보는 판본도 등록부 태그까지)');
  RI.clearCollectorServers('edge3');
});

test('maskMaterial: 기록 ∪ 지금 · 너무 긴 값은 기록하지 않고 그 요청에만 쓴다 · 문자열 아닌 값은 버린다', async () => {
  const long = `h${'x'.repeat(300)}.example`;
  const out = await R.maskMaterial(['new-host.example', long, '', null, 42], ['NEWTAG01', 'T'.repeat(65)]);
  assert.ok(out.hosts.includes('new-host.example') && out.hosts.includes(long) && out.hosts.includes('https://idrac-r1.edge.example'), '기록 ∪ 지금');
  assert.ok(out.tags.includes('NEWTAG01') && out.tags.includes('T'.repeat(65)) && out.tags.includes('RMT0001'));
  assert.ok(!out.hosts.includes('') && !out.hosts.includes(null) && !out.hosts.includes(42));
  assert.deepEqual(await R.maskSeenCounts(), { hosts: 4, tags: 4 }, '긴 값은 기록에 넣지 않는다(이번 요청의 재료로는 썼다)');
  const again = await R.maskMaterial([], []);
  assert.ok(again.hosts.includes('new-host.example') && !again.hosts.includes(long));
  assert.equal(new Set(again.hosts).size, again.hosts.length, '중복 없음');
});

test('목록 응답(법인 여러 개의 이름)도 같은 재료로 가린다 — 데이터센터 · 전산실 이름', async () => {
  dc.addDatacenter({ id: 'pl', name: 'PL' });   // 할당 vCenter 가 없는 법인 — 전체 범위 계정에게만 보인다
  const s2 = (await op({ op: 'site.add', corpId: 'pl', name: 'DC idrac-r1.edge.example' })).body.id;
  await op({ op: 'room.add', siteId: s2, name: 'R RMT0001 10.7.7.7' });
  const all = (await call('GET /tools/rack', { user: OP_ALL })).body;
  const site = all.sites.find((x) => x.corpId === 'pl'); const room = all.rooms.find((x) => x.siteId === site.id);
  assert.match(site.name, /^DC masked-[0-9a-f]+$/); assert.match(room.name, /^R RMT0001 masked-[0-9a-f]+$/, '시리얼을 보는 판본 — 태그는 그대로 · 주소는 가림');
  const scoped = (await call('GET /tools/rack', { user: OP_A })).body;
  assert.ok(!scoped.sites.some((x) => x.corpId === 'pl'), '범위 계정에는 귀속 없는 법인이 보이지 않는다');
  assert.ok(!JSON.stringify(scoped).includes('idrac-r1'));
});
