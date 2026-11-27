// [7회차 변이 축] 라우트(흡수 · 기록 관리 · 집계 · 연결 정보) · layout/project/textMask 순수 판정에서 살아남은 변이를 잡는 시험.
//   각 시험 제목 앞의 [변이 id] = 이 시험이 잡는 변이(r7-mut/mutants.mjs · mutants2.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackRouteMut-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const RI = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const M = await import(`${S}/rack/material.js`);
const L = await import(`${S}/rack/layout.js`);
const P = await import(`${S}/rack/project.js`);
const T = await import(`${S}/rack/textMask.js`);
const A = await import(`${S}/audit.js`);
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
const op = (body, user = ADMIN) => call('POST /tools/rack/op', { user, body });
const okOp = async (body) => { const r = await op(body); assert.equal(r.statusCode, 200, `${body.op}: ${JSON.stringify(r.body)}`); return r.body; };
const quiet = () => { const warns = []; const ow = console.warn; const oe = console.error; console.warn = (...a) => { warns.push(a.map(String).join(' ')); }; console.error = () => {}; return { warns, restore: () => { console.warn = ow; console.error = oe; } }; };
const W = {};
async function place(label, u, extra = {}) {
  const p = await okOp({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: u, uSize: 1, kind: 'other', label, ...extra } });
  W.rev = p.rev; return p.id;
}
const roomOf = async (user) => (await call('GET /tools/rack/room/:id', { user, params: { id: W.room } })).body;
const labelOf = async (user, id) => (await roomOf(user)).places.find((p) => p.id === id).label;
const census = async () => { const r = await call('GET /tools/rack/mask-census', { user: ADMIN }); assert.equal(r.statusCode, 200, JSON.stringify(r.body).slice(0, 300)); return r.body; };

test('준비', async () => {
  W.site = (await okOp({ op: 'site.add', corpId: 'kr', name: 'S' })).id;
  W.room = (await okOp({ op: 'room.add', siteId: W.site, name: 'R' })).id;
  const k = await okOp({ op: 'rack.add', roomId: W.room, rev: 0, rack: { name: 'A1', heightU: 42 } });
  W.rack = k.id; W.rev = k.rev;
});

// ── 재료 모으기 ──
test('[m05] 엣지가 올린 관리 주소도 정리(폭 접기 · 보이지 않는 글자)한 값으로 재료에 넣는다 — 전각으로 올라온 주소가 든 이름', async () => {
  RI.setCollectorServers('edgeW', 'kr', [{ id: 'rw1', name: 'rw1', host: 'https://ｂｍｃ－ｗｉｄｅ.edge.example', serviceTag: 'RMTW0001', vcenterId: 'vc-a' }]);
  try {
    const pid = await place('kvm bmc-wide.edge.example', 1);
    assert.equal(await labelOf(OP_ALL, pid), 'kvm (주소 가림)');
  } finally { RI.clearCollectorServers('edgeW'); }
});

test('[m06] host 없이 올라온 엣지 서버의 id 가 콜론만 든 주소(이름:포트)여도 주소 재료로 넣는다', async () => {
  RI.setCollectorServers('edgeC', 'kr', [{ id: 'bmcnode77:8443', name: 'r77', serviceTag: 'RMTC0077', vcenterId: 'vc-a' }]);
  try {
    const pid = await place('kvm bmcnode77:8443 rear', 3);
    assert.match(await labelOf(OP_ALL, pid), /^kvm masked-[0-9a-f]+ rear$/);
  } finally { RI.clearCollectorServers('edgeC'); }
});

test('[r37] 등록 주소와 같은 낱말은 대소문자가 달라도 \'등록 주소 그대로\' 로 보아 토큰으로 가린다(글 속 치환 \'(주소 가림)\' 으로 떨어지지 않는다 — 꼴만 다르고 노출은 아니다)', async () => {
  registry.importServers([{ id: 'mc1', name: 'mc1', host: 'https://bmc-up7.mgmt.example', username: 'root', password: 'x', serviceTag: 'MCASE001', vcenterId: 'vc-a' }], 'merge');
  const a = await place('kvm bmc-up7.mgmt.example', 5);
  const b = await place('kvm BMC-UP7.Mgmt.Example', 7);
  const la = await labelOf(OP_ALL, a); const lb = await labelOf(OP_ALL, b);
  assert.match(la, /^kvm masked-[0-9a-f]+$/);
  assert.match(lb, /^kvm masked-[0-9a-f]+$/, lb);
});

test('[m20] 세 글자 미만의 주소 변형은 글 속 찾기에 쓰지 않는다(짧은 이름 과잉 가림 방지)', async () => {
  await R.maskAbsorb(['zq'], []);
  const pid = await place('zq rack spare', 9);
  assert.equal(await labelOf(OP_ALL, pid), 'zq rack spare');
});

// ── 시리얼 칸 입력 ──
test('[r08] 시리얼 칸의 글 속에 든 등록 주소도 저장 때 거절한다(통째로 같을 때만이 아니라)', async () => {
  registry.importServers([{ id: 'sf9', name: 'sf9', host: 'https://bmc-fw9.mgmt.example', username: 'root', password: 'x', serviceTag: 'SFSRV009', vcenterId: 'vc-a' }], 'merge');
  const r = await op({ op: 'place.add', rackId: W.rack, rev: W.rev, place: { face: 'full', uStart: 11, uSize: 1, kind: 'other', label: 'x', serial: 'SN:bmc-fw9.mgmt.example' } });
  assert.equal(r.statusCode, 400, JSON.stringify(r.body));
  assert.match(r.body.reason, /등록된 관리 주소/);
});

// ── 기록 관리 ──
test('[r15 · r17] 지우기 입력 검사 — 255자 넘는 값 · 1,000개 넘는 목록은 400', async () => {
  assert.equal((await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'k'.repeat(256) }] })).statusCode, 400);
  const many = Array.from({ length: 1001 }, (_, i) => ({ kind: 't', key: `NOPE${i}` }));
  assert.equal((await op({ op: 'mask.forget', items: many })).statusCode, 400);
  const ok = await op({ op: 'mask.forget', items: many.slice(0, 1000) });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.body));
});

test('[r16] 지우기는 감사 로그에 남는다', async () => {
  await R.maskAbsorb(['audit-me.example'], []);
  const before = A.auditEntriesWithAction('rack.mask.forget').length;
  const f = await op({ op: 'mask.forget', items: [{ kind: 'h', key: 'audit-me.example' }] });
  assert.equal(f.body.removed, 1);
  const after = A.auditEntriesWithAction('rack.mask.forget');
  assert.equal(after.length, before + 1);
  assert.match(after[after.length - 1].detail, /^1건/);
  assert.equal(after[after.length - 1].user, 'admin');
});

test('[r20 · r21] 관리 목록 — 오래된 것부터 · 앞 1,000건만 싣고 전체 수는 따로', async () => {
  const db = await R.openRackDb();
  R._flushMaskForTest();
  db.exec('BEGIN');
  const ins = db.prepare("INSERT OR IGNORE INTO rack_mask_seen (kind, key, first_seen) VALUES ('t', ?, ?)");
  ins.run('ORDZ0002', 200); ins.run('ORDZ0001', 100);
  for (let i = 0; i < 1100; i += 1) ins.run(`BULKST${String(i).padStart(4, '0')}`, 1000 + i);
  db.exec('COMMIT');
  R._dropMaskMemoryForTest();
  const r = await call('GET /tools/rack/mask-seen', { user: ADMIN });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.body.stale.slice(0, 2).map((x) => x.key), ['ORDZ0001', 'ORDZ0002']);
  assert.equal(r.body.stale.length, 1000);
  assert.ok(r.body.staleTotal >= 1102, `${r.body.staleTotal}`);
});

test('[r36] 인벤토리에서만 읽힌 지금 태그는 지울 후보가 아니고, 지우려 해도 건너뛴다', async () => {
  registry.importServers([{ id: 'ic1', name: 'ic1', host: 'https://10.66.0.1', username: 'root', password: 'x', serviceTag: '', vcenterId: 'vc-a' }], 'merge');
  invCache.setInventory('ic1', { system: { serviceTag: 'INVCUR01' }, collectedAt: Date.now() });
  const r = await call('GET /tools/rack/mask-seen', { user: ADMIN });
  assert.equal(r.statusCode, 200);
  assert.ok((await R.maskState()).tags.has('INVCUR01'), '전제: 기록됐다');
  assert.ok(!r.body.stale.some((x) => x.key === 'INVCUR01'), '지금 등록부(인벤토리)에 있는 값이 지울 후보로 나왔다');
  const f = await op({ op: 'mask.forget', items: [{ kind: 't', key: 'INVCUR01' }] });
  assert.deepEqual([f.body.removed, f.body.skippedCurrent], [0, 1]);
});

test('[r22] 기록을 못 읽으면 관리 목록도 503(maskUnavailable)', async () => {
  const db = await R.openRackDb();
  R._dropMaskMemoryForTest(); M._dropIndexForTest();
  db.exec('ALTER TABLE rack_mask_seen RENAME TO rack_mask_seen_x');
  const q = quiet();
  let r;
  try { r = await call('GET /tools/rack/mask-seen', { user: ADMIN }); } finally { q.restore(); db.exec('ALTER TABLE rack_mask_seen_x RENAME TO rack_mask_seen'); R._dropMaskMemoryForTest(); }
  assert.equal(r.statusCode, 503, JSON.stringify(r.body));
  assert.equal(r.body.code, 'maskUnavailable');
});

// ── 연결 정보 ──
test('[r26] 전원 상태는 인벤토리 머리의 값으로도 읽는다(system 에 없을 때)', async () => {
  registry.importServers([{ id: 'pw1', name: 'pw1', host: 'https://bmc-pw1.mgmt.example', username: 'root', password: 'x', serviceTag: 'PWSRV001', vcenterId: 'vc-a' }], 'merge');
  invCache.setInventory('pw1', { system: { serviceTag: 'PWSRV001', model: 'R650' }, powerState: 'Off', collectedAt: Date.now() });
  const pid = await place('pw', 13, { kind: 'server', serial: 'PWSRV001' });
  for (const user of [OP_ALL, OP_A]) assert.equal((await roomOf(user)).places.find((p) => p.id === pid).link.powerState, 'Off', user.username);
});

// ── 집계 ──
test('[r27] 집계는 세기 전에 지금 등록부를 흡수한다 — 방금 등록된 서버의 주소가 든 이름도 센다', async () => {
  const pid = await place('kvm late-reg.mgmt.example', 15);   // 놓을 때는 아직 등록 전
  assert.ok(pid);
  registry.importServers([{ id: 'lr1', name: 'lr1', host: 'https://late-reg.mgmt.example', username: 'root', password: 'x', serviceTag: 'LRSRV001', vcenterId: 'vc-a' }], 'merge');
  const c = await census();
  assert.ok(c.samples.some((s) => s.text === 'kvm late-reg.mgmt.example' && s.hits.includes('addr')), JSON.stringify(c.samples.map((s) => s.text)));
});

test('[r28 · r30] 집계의 재료 수 — 메모리에만 둔 주소의 첫 마디도 세고, 메모리에만 둔 수(overflow)를 싣는다', async () => {
  const c0 = await census();
  await R.maskAbsorb([`wlabel${'k'.repeat(250)}.example`], []);
  const c1 = await census();
  assert.ok(c1.material.overflow >= 1, JSON.stringify(c1.material));
  assert.equal(c1.material.firstLabels, c0.material.firstLabels + 1, `${c0.material.firstLabels} → ${c1.material.firstLabels}`);
  assert.equal(typeof c1.material.pending, 'number');
});

test('[d38 · d39 · d41] 집계의 장비 · 랙 수는 원장과 같고, 표본의 위치 글은 데이터센터 › 전산실 › 랙 U', async () => {
  const room = await roomOf(ADMIN);
  const c = await census();
  assert.equal(c.places, room.places.length, 'places');
  assert.equal(c.racks, room.racks.length, 'racks');
  const s = c.samples.find((x) => x.text === 'kvm late-reg.mgmt.example');
  assert.equal(s?.where, 'S › R › A1 U15');
});

// ── 이름 비교(옛 전각 값) ──
test('[d27] db 층 nameTaken 은 새 이름도 접어서 본다(라우트를 거치지 않은 호출)', async () => {
  await assert.rejects(R.addSite({ corpId: 'kr', name: 'Ｓ', user: 'admin' }), (e) => e.status === 409);
});

test('[d29 · d30 · d31 · d32 · d33] 옛 전각 이름과 같은 반각 이름 — 랙 종류 추가 · 전산실 추가 · 전산실 이름 바꾸기 · 데이터센터 이름 바꾸기 · 랙 고치기도 409', async () => {
  const db = await R.openRackDb();
  const t = await okOp({ op: 'type.add', name: 'TYPE-OLD', heightU: 42 });
  db.prepare('UPDATE rack_type SET name = ? WHERE id = ?').run('ＴＹＰＥ－Ｗ', t.id);
  assert.equal((await op({ op: 'type.add', name: 'TYPE-W', heightU: 42 })).statusCode, 409, 'type.add');
  const r2 = await okOp({ op: 'room.add', siteId: W.site, name: 'R2' });
  db.prepare('UPDATE rack_room SET name = ? WHERE id = ?').run('ＲＯＯＭ－Ｗ', r2.id);
  assert.equal((await op({ op: 'room.add', siteId: W.site, name: 'ROOM-W' })).statusCode, 409, 'room.add');
  assert.equal((await op({ op: 'room.rename', id: W.room, name: 'ROOM-W' })).statusCode, 409, 'room.rename');
  const s2 = await okOp({ op: 'site.add', corpId: 'kr', name: 'S2' });
  db.prepare('UPDATE rack_site SET name = ? WHERE id = ?').run('ＳＩＴＥ－Ｗ', s2.id);
  assert.equal((await op({ op: 'site.rename', id: W.site, name: 'SITE-W' })).statusCode, 409, 'site.rename');
  const k2 = await okOp({ op: 'rack.add', roomId: W.room, rev: W.rev, rack: { name: 'B9', heightU: 42 } });
  W.rev = k2.rev;
  db.prepare('UPDATE rack_rack SET name = ? WHERE id = ?').run('ＲＡＣＫ－Ｗ', k2.id);
  R._resyncForTest && await R._resyncForTest();
  const rev = (await roomOf(ADMIN)).rev;
  assert.equal((await op({ op: 'rack.update', id: W.rack, rev, rack: { name: 'RACK-W' } })).statusCode, 409, 'rack.update');
});

// ── 순수 판정 ──
test('[l01 · l05 · l06 · l08] serialAddressLike 경계 — 512자 넘으면 주소로 · 4자리 묶음은 IPv4 마디가 아니다 · 일곱 글자 IPv4 · 전각도 접어서', () => {
  assert.equal(L.serialAddressLike('A'.repeat(513)), true);
  assert.equal(L.serialAddressLike('A'.repeat(512)), false);
  assert.equal(L.serialAddressLike('SN 1234.12.34.56'), false, '네 자리 묶음 + 세 묶음');
  assert.equal(L.serialAddressLike('1.2.3.4'), true);
  assert.equal(L.serialAddressLike('１０．２０．３０．４'), true);
});

test('[l10 · l11 · l14] 화면처럼 문자열로 보낸 추가 시리얼 — http 가 아닌 URL · 64자 뒤의 URL 도 쪼개기 전에 거절', () => {
  for (const s of ['SW-1 / smb://nas01/share', `${'L'.repeat(70)} smb://nas01/share`]) {
    const r = L.cleanPlaceInput({ extraSerials: s }, { partial: true });
    assert.match(String(r.error), /시리얼 칸에는 주소/, s);
  }
});

test('[p02 · p03] firmwareLike — 판 꼴 뒤에 다른 글이 붙으면 아니다 · 40자 넘으면 아니다', () => {
  assert.equal(P.firmwareLike('7.00.00.171 build 10.20.30.4'), false);
  const long = `1${'.abcdefghij'.repeat(4)}`;   // 판 꼴(41자 이상)
  assert.ok(long.length > 40);
  assert.equal(P.firmwareLike(long), false);
  assert.equal(P.firmwareLike(long.slice(0, 40)), true, '같은 꼴 40자는 판');
});

test('[t01 · t02] 조각 빌드 색인은 한 번에 만든 색인과 같다(길이 경계 · 512개 넘는 목록)', async () => {
  const strs = ['ab', 'abc', 'x'.repeat(256), ...Array.from({ length: 1500 }, (_, i) => `host-${i}.ex`)];
  const a = await T.needleIndexOfAsync(strs, { min: 3 }, async () => {});
  const b = T.needleIndexOf(strs, { min: 3 });
  assert.deepEqual([...a.set].sort(), [...b.set].sort());
  const tags = Array.from({ length: 1500 }, (_, i) => `TAGX${String(i).padStart(5, '0')}`);
  const c = await T.tagIndexOfAsync(tags, async () => {});
  const d = T.tagIndexOf(tags);
  assert.equal(c.set.size, d.set.size);
  assert.deepEqual([...c.set].sort(), [...d.set].sort());
});
