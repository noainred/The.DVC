// [탐침 · 테스트 공백 축 r6] 판 상세 · 연결 정보의 비관리자 판본 — 빠진 시험(가장 오래된 판 · 손상된 판)과 살아남은 변이(R14 — 연결된 서버의 모델 가림).
//   (2026-11-27 저장소에 옮김 — 처음에는 점검 사본에서만 돌렸다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6probe-ver-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
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
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const versions = async (user) => (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body.versions;
const detail = async (user, vid) => call('GET /tools/rack/versions/:vid', { user, params: { vid: String(vid) }, query: { corp: 'kr' } });

const W = {};
test('준비: 판 여러 개', async () => {
  registry.importServers([{ id: 'lm1', name: 'lm1', host: 'https://10.44.0.1', username: 'root', password: 'x', serviceTag: 'LMTAG001', vcenterId: 'vc-a' }]);
  invCache.setInventory('lm1', { system: { serviceTag: 'LMTAG001', model: 'R760 bmc 10.44.0.9', hostName: 'lm-host', health: 'OK', powerState: 'On' }, collectedAt: Date.now() });
  W.site = (await okOp({ op: 'site.add', corpId: 'kr', name: 'S' })).id;
  W.room = (await okOp({ op: 'room.add', siteId: W.site, name: 'R' })).id;
  const k = await okOp({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'K 10.44.0.7', heightU: 42 } });
  const p = await okOp({ op: 'place.add', rackId: k.id, rev: k.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'server', label: 'db', serial: 'LMTAG001', note: 'n1' } });
  const q = await okOp({ op: 'place.add', rackId: k.id, rev: p.rev, place: { face: 'full', uStart: 3, uSize: 1, kind: 'other', label: 'kvm' } });
  W.place = p.id; W.rev = q.rev;
});

test('R14: 연결된 서버의 모델(인벤토리 · 등록부 글)도 가림을 거친다 — 조회 계정 2종', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const l = (await call('GET /tools/rack/room/:id', { user, params: { id: W.room } })).body.places.find((x) => x.id === W.place).link;
    assert.match(l.model, /^R760 bmc masked-[0-9a-f]{12}$/, `${user.username}: ${l.model}`);
  }
  const a = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.room } })).body.places.find((x) => x.id === W.place).link;
  assert.equal(a.model, 'R760 bmc 10.44.0.9', '관리자는 원문');
});

test('빠진 시험: 가장 오래된 판(앞 판 없음) — 비관리자에게 changes 는 null · restore 는 null · prevUnreadable false', async () => {
  const vs = await versions(OP_A);
  const oldest = vs[vs.length - 1];
  const d = await detail(OP_A, oldest.id);
  assert.equal(d.statusCode, 200);
  assert.deepEqual([d.body.readable, d.body.changes, d.body.restore, d.body.prevUnreadable], [true, null, null, false], JSON.stringify(d.body));
  assert.ok(d.body.counts && typeof d.body.counts === 'object');
  const a = await detail(ADMIN, oldest.id);
  assert.ok(a.body.restore && a.body.restore.counts, '관리자에게는 되돌리기 미리 보기');
});

test('헛도는 단언 교체 제안의 모양: 비관리자의 판 차이 — restore 는 언제나 null 이고, changes 에는 실제로 항목이 있다(빈 배열을 본 것이 아니다)', async () => {
  const vs = await versions(OP_A);
  let items = 0;
  for (const v of vs) {
    const d = (await detail(OP_A, v.id)).body;
    assert.equal(d.restore, null, `판 #${v.id}`);
    items += d.changes?.items?.length || 0;
  }
  assert.ok(items >= 3, `차이 항목 ${items}개`);
});

test('빠진 시험: 손상된 판 — 비관리자 판 상세는 readable:false · 키는 ok · version · readable · restore 뿐 · 그 다음 판은 prevUnreadable', async () => {
  const vs = await versions(ADMIN);
  const mid = vs[2]; const next = vs[1];
  const db = await R.openRackDb();
  db.prepare("UPDATE rack_version SET data = X'00' WHERE id = ?").run(mid.id);
  R._closeForTest();   // 판 차이 캐시(최신 판 id 가 키)를 비운다 — 앞 시험이 그 판을 이미 읽었다
  const d = await detail(OP_A, mid.id);
  assert.equal(d.statusCode, 200, JSON.stringify(d.body));
  assert.deepEqual(Object.keys(d.body).sort(), ['ok', 'readable', 'restore', 'version'], JSON.stringify(d.body));
  assert.equal(d.body.readable, false); assert.equal(d.body.restore, null); assert.equal(d.body.version.user, '');
  assert.ok(!/10\.44\.0\.7/.test(JSON.stringify(d.body)), '판 글의 랙 이름 속 IP');
  const n = await detail(OP_A, next.id);
  assert.deepEqual([n.body.readable, n.body.prevUnreadable, n.body.changes, n.body.restore], [true, true, null, null], JSON.stringify(n.body));
  const a = await detail(ADMIN, mid.id);
  assert.equal(a.body.version.user, 'admin', '관리자는 작업자 계정명');
});
