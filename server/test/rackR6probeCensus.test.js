// [탐침 · 테스트 공백 축 r6] 가림 집계(GET /tools/rack/mask-census) — 살아남은 변이(R48 · R49 · R50 · R51 · R52 · R54 · R58 · R59 · R60 · R61)와 빠진 시험(동시 1건 409 · 지워진 법인).
//   (2026-11-27 저장소에 옮김 — 처음에는 점검 사본에서만 돌렸다)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6probe-cen-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const busy = await import(`${S}/util/exportBusy.js`);
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
const ADMIN = U('admin', 'admin');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['a', 'b', 'c'].map((x) => ({ id: `vc-${x}`, name: x, status: 'ok' })), hosts: [], vms: [] };
for (const [c, v] of [['kr', 'vc-a'], ['dd', 'vc-b'], ['ee', 'vc-c']]) { dc.addDatacenter({ id: c, name: c.toUpperCase() }); dc.setVcenterDatacenter(v, c); }
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const census = async (corp) => { const r = await call('GET /tools/rack/mask-census', { user: ADMIN, query: corp ? { corp } : {} }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); return r.body; };

const W = {};
async function corpRoom(corp, { rack = {} } = {}) {
  const site = (await okOp({ op: 'site.add', corpId: corp, name: `S-${corp}` })).id;
  const roomId = (await okOp({ op: 'room.add', siteId: site, name: `R-${corp}` })).id;
  const k = await okOp({ op: 'rack.add', roomId, rev: 0, rack: { name: `K-${corp}`, heightU: 42, ...rack } });
  return { site, roomId, rackId: k.id, rev: k.rev };
}
async function put(w, place) { const p = await okOp({ op: 'place.add', rackId: w.rackId, rev: w.rev, place: { face: 'full', uSize: 1, kind: 'other', ...place } }); w.rev = p.rev; return p.id; }

test('준비: 법인 셋 — dd · ee 는 같은 글을 갖는다', async () => {
  registry.importServers([{ id: 'c1', name: 'c1', host: 'https://bmc.example.org', username: 'root', password: 'x', serviceTag: 'CENTAG01', vcenterId: 'vc-a' }]);
  W.kr = await corpRoom('kr', { rack: { role: 'role LEDGERC8' } });   // 랙 용도에 원장 시리얼(아래 storage 장비)만 — 주소 아님
  await put(W.kr, { uStart: 1, kind: 'storage', label: 'nas', serial: 'LEDGERC8' });
  await put(W.kr, { uStart: 3, label: 'bmc spare' });                  // 등록 주소 'bmc.example.org' 의 첫 마디는 3자 — 집계 재료가 아니다
  await put(W.kr, { uStart: 5, label: 'pdu 10 20 30 4' });             // 공백으로 띄운 IP
  await put(W.kr, { uStart: 7, label: 'pdu 10,20,30,5' });             // 쉼표로 띄운 IP
  for (const corp of ['dd', 'ee']) {
    W[corp] = await corpRoom(corp);
    await put(W[corp], { uStart: 1, label: 'dup 10.5.5.5', model: 'dup 10.5.5.5' });   // 같은 글이 표시 이름 · 모델 두 칸에
    await put(W[corp], { uStart: 3, label: 'dup 10.5.5.5' });                          // 같은 칸의 같은 글
  }
});

test('R49 · R50 · R51: 집계는 (법인, 칸, 글) 이 서로 다른 것을 센다 — 법인마다 · 칸마다 따로, 같은 칸의 같은 글은 한 번', async () => {
  const d = await census('dd');
  assert.deepEqual([d.fields.label.total, d.fields.label.addr], [1, 1], `같은 칸의 같은 글은 한 번(R49): ${JSON.stringify(d.fields.label)}`);
  assert.deepEqual([d.fields.model.total, d.fields.model.addr], [1, 1], `칸이 다르면 따로(R50): ${JSON.stringify(d.fields.model)}`);
  const all = await census();
  let sum = 0;
  for (const c of all.corps) sum += (await census(c.id)).fields.label.total;
  assert.equal(all.fields.label.total, sum, `전체 = 법인별 합(법인이 다르면 따로 — R51): 전체 ${all.fields.label.total} · 합 ${sum}`);
});

test('R52 · R58 · R59: 첫 마디 하한(4자) · 원장 시리얼(다른 장비의 것)이 든 랙 글 · 공백 · 쉼표로 띄운 IP', async () => {
  const k = await census('kr');
  assert.equal(k.material.firstLabels, 0, `3자 첫 마디('bmc')는 재료가 아니다(R52): ${k.material.firstLabels}`);
  assert.equal(k.fields.label.firstLabel, 0);
  assert.deepEqual([k.fields.rackRole.total, k.fields.rackRole.tag], [1, 1], `랙 용도의 원장 시리얼(R58): ${JSON.stringify(k.fields.rackRole)}`);
  assert.equal(k.fields.label.altIp, 2, `공백 · 쉼표로 띄운 IP(R59): ${JSON.stringify(k.samples.filter((s) => s.hits.includes('altIp')).map((s) => s.text))}`);
});

test('R60: 전각 · 반각이 다른 같은 글은 한 글이고, 주소가 없는 전각 글은 주소로 세지 않는다', async () => {
  const id1 = await put(W.kr, { uStart: 9, label: 'tmp1' }); const id2 = await put(W.kr, { uStart: 11, label: 'tmp2' });
  const db = await R.openRackDb();
  db.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('ＫＶＭ ｓｐａｒｅ', id1);
  db.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('KVM spare', id2);
  await R._resyncForTest();
  const k = await census('kr');
  assert.ok(!k.samples.some((s) => s.text.normalize('NFKC').toLowerCase().includes('kvm spare')), `주소 없는 전각 글은 걸리지 않는다: ${JSON.stringify(k.samples.map((s) => s.text))}`);
  const before = k.fields.label.total;
  db.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('KVM spare 2', id2);
  await R._resyncForTest();
  assert.equal((await census('kr')).fields.label.total, before + 1, '반각 글을 다른 글로 바꾸면 하나 는다(전각 · 반각 같은 글은 한 번으로 셌다)');
});

test('R61: 집계도 재료 기록을 쓴다 — 엣지 서버 목록이 비어도 그 주소가 든 글을 센다', async () => {
  RI.setCollectorServers('edgeC', 'kr', [{ id: 'rc', name: 'rc', host: 'https://idrac-rc7.edge.example', serviceTag: 'RMTC0007', vcenterId: 'vc-a' }]);
  await put(W.kr, { uStart: 13, label: 'kvm idrac-rc7.edge.example' });
  RT._resetAbsorbForTest();
  await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: W.kr.roomId } });   // 관리자 요청이 재료를 기록한다
  RI.clearCollectorServers('edgeC');
  const k = await census('kr');
  assert.ok(k.samples.some((s) => s.text === 'kvm idrac-rc7.edge.example' && s.hits[0] === 'addr'), JSON.stringify(k.samples.map((s) => [s.text, s.hits])));
});

test('R54 · 빠진 시험(409): 집계는 동시 1건 — 진행 중이면 409, 끝나면 잠금이 풀린다', async () => {
  await census('kr');
  await census('kr');   // 앞 집계가 잠금을 풀었다(R54)
  const held = busy.acquireExport('rack-census', { user: { username: 'other' } });
  assert.ok(held.ok);
  try {
    const r = await call('GET /tools/rack/mask-census', { user: ADMIN });
    assert.equal(r.statusCode, 409, JSON.stringify(r.body));
    assert.ok(!JSON.stringify(r.body).includes('other'), '다른 사용자의 계정명은 싣지 않는다');
  } finally { held.release(); }
  assert.equal((await call('GET /tools/rack/mask-census', { user: ADMIN })).statusCode, 200);
});

test('빠진 시험: 법인 목록에서 지운 법인의 원장도 센다 — 이름은 “(법인 목록에 없음)”', async () => {
  dc.removeDatacenter('ee');
  const all = await census();
  assert.ok(all.corps.some((c) => c.id === 'ee' && c.name === 'ee(법인 목록에 없음)'), JSON.stringify(all.corps));
  assert.equal((await census('ee')).fields.label.total, 1);
});

test('R48: 표본은 300개까지 — 넘는 것은 sampleOmitted 로 센다', async () => {
  const k = await okOp({ op: 'rack.add', roomId: W.dd.roomId, rev: W.dd.rev, rack: { name: 'K-cap', heightU: 42 } });
  W.dd.rev = k.rev;
  const db = await R.openRackDb();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT INTO rack_place (id, rack_id, face, u_start, u_size, kind, label, updated_at) VALUES (?, ?, 'full', ?, 1, 'other', ?, 0)");
  for (let i = 0; i < 310; i += 1) ins.run(`r6cap${String(i).padStart(11, '0')}`, k.id, 1 + (i % 40), `cap 10.66.${i >> 8}.${i & 255}`);
  db.exec('COMMIT');
  await R._resyncForTest();
  const all = await census();
  assert.equal(all.samples.length, 300);
  assert.ok(all.sampleOmitted >= 10, `넘는 표본 ${all.sampleOmitted}`);
  const hitTexts = Object.values(all.fields).reduce((n, f) => n + f.addr, 0);
  assert.ok(all.samples.length + all.sampleOmitted >= hitTexts, '표본 + 생략은 걸린 글 수 이상(주소로 센 글은 모두 표본 후보)');
});
