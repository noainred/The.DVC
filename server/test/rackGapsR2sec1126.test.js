// 랙 실장도 2회차 점검(2026-11-26 · 보안 축 6건) 회귀 — 비관리자 판본의 글자 가림(routes/api/rack.js textMaskOf 하나가 순서 · 재료를 정한다):
//   1 가림 재료(주소 · 태그)는 범위로 자르기 전 등록부 전체에서 · 2 이름 판정과 글 치환이 같은 기준(대소문자 · IPv4 뒤 마침표 · IPv6) ·
//   3 주소 먼저 → 태그 나중('idrac-<태그>.<도메인>') · 4 link.name · unplaced[].name 도 같은 가림 · 5 구분자를 달리 적은 시리얼.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr2sec-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const TM = await import(`${S}/rack/textMask.js`);
const routes = new Map();
RT.registerRack({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
async function call(key, { user, params = {}, query = {}, body = {} }) {
  const res = { statusCode: 200, headers: {}, body: undefined, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {}, end(b) { this.raw = b; return this; } };
  const req = { user, params, query, body, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.replace(/^\w+ /, '')}` };
  for (const h of routes.get(key)) { let n = false; await h(req, res, () => { n = true; }); if (!n) break; }
  return res;
}
const U = (name, role, vcenters = []) => ({ username: name, role, scope: { vcenters, regions: [], writeVcenters: [] } });
const ADMIN = U('admin', 'admin'); const OP_A = U('op-a', 'operator', ['vc-a']); const OP_ALL = U('op', 'operator');
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: ['vc-a', 'vc-c'].map((id) => ({ id, name: id, status: 'ok' })), hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr'); dc.setVcenterDatacenter('vc-c', 'kr');
registry.importServers([
  { id: 's-a', name: 'srv-a', host: 'https://idrac-a1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0001', vcenterId: 'vc-a' },
  { id: 's-c', name: 'idrac-c1.mgmt.example', host: 'https://idrac-c1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVC0002', vcenterId: 'vc-c' },   // 같은 법인 · 범위 계정(vc-a)의 범위 밖
  { id: 's-bm', name: 'idrac-bm1.mgmt.example', host: 'https://idrac-bm1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVB0003' },                  // vCenter 귀속 없는 베어메탈
  { id: 's-tag', name: 'idrac-TAG9876.mgmt.example', host: 'https://idrac-TAG9876.mgmt.example', username: 'root', password: 'x', serviceTag: 'TAG9876', vcenterId: 'vc-a' },
  { id: 's-port', name: 'idrac40.mgmt.example:443', host: 'https://idrac40.mgmt.example:443', username: 'root', password: 'x', serviceTag: 'SVP0040', vcenterId: 'vc-a' },
  { id: 's-spare', name: 'spare-for-SVC0002', host: 'https://10.9.9.9', username: 'root', password: 'x', serviceTag: 'SVS0041', vcenterId: 'vc-a' },             // 이름에 다른(범위 밖) 서버의 태그
]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const views = async (user, roomId) => {
  const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
  const list = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
  const details = [];
  for (const v of list.versions) details.push((await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body);
  return { room, list, details, all: JSON.stringify({ room, list, details }) };
};

let roomId; let rackId; let rev;
const put = async (place) => { const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uSize: 1, kind: 'other', ...place } }); assert.equal(p.statusCode, 200, JSON.stringify(p.body)); rev = p.body.rev; return p.body.id; };
test('준비: 주소 · 태그가 든 표시 이름으로 장비를 놓는다(관리자)', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } });
  rackId = k.body.id; rev = k.body.rev;
  await put({ uStart: 1, kind: 'server', label: 'idrac-c1.mgmt.example', serial: 'SVC0002' });          // 1: 범위 밖 서버의 관리 FQDN
  await put({ uStart: 2, kind: 'server', label: 'idrac-bm1.mgmt.example', serial: 'SVB0003' });         // 1: 귀속 없는 베어메탈
  await put({ uStart: 3, label: 'IDRAC-A1.MGMT.EXAMPLE' });                                             // 2: 등록 주소와 대소문자만 다름
  await put({ uStart: 4, label: 'bmc IDRAC-A1.MGMT.EXAMPLE rear' });                                    // 2: 글 속
  await put({ uStart: 5, label: '10.20.30.99.' });                                                      // 2: IPv4 뒤 마침표
  await put({ uStart: 6, label: 'gw 10.20.30.98.nip.io' });                                             // 2: 도메인 꼬리
  await put({ uStart: 7, label: '2001:db8::77' });                                                      // 2: IPv6 리터럴
  await put({ uStart: 8, label: 'mgmt [2001:DB8::10]:443 port' });                                      // 2: 대괄호 + 포트(글 속)
  await put({ uStart: 9, kind: 'server', label: 'idrac-TAG9876.mgmt.example', serial: 'TAG9876' });     // 3: 태그가 든 관리 FQDN
  await put({ uStart: 10, kind: 'storage', label: 'node XY_56_ZW78', serial: 'XY-56-ZW78' });           // 5: 구분자를 달리 적은 시리얼
  await put({ uStart: 11, kind: 'storage', label: 'node QR-90-ST12', serial: 'QR90ST12' });             // 5
  await put({ uStart: 12, label: '가상화서버 #1 (예비)' });                                              // 대조군 — 그대로 보여야 한다
});

const ADDR = ['mgmt.example', '10.20.30.99', '10.20.30.98', '2001:db8', 'idrac-c1', 'idrac-bm1', 'idrac-a1'];
test('1 · 2 · 3: 비관리자 판본 전체(전산실 · 이력 · 판 목록 · 판 글 · 판 차이)에 관리 주소가 없다 — 전체 범위 · 범위 계정 모두', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user, roomId);
    const low = v.all.toLowerCase();
    for (const a of ADDR) assert.ok(!low.includes(a), `${user.username}: '${a}' 가 응답에 있다`);
    assert.ok(v.room.places.some((p) => p.label === '가상화서버 #1 (예비)'), '주소 · 태그가 아닌 이름은 그대로');
    assert.ok(v.room.logs.some((l) => l.detail.includes('가상화서버 #1 (예비) → A1 U12')));
  }
  // 관리자는 원문
  const adm = await views(ADMIN, roomId);
  assert.ok(adm.room.places.some((p) => p.label === 'idrac-c1.mgmt.example'));
  assert.ok(adm.room.logs.some((l) => l.detail.includes('2001:db8::77')));
});

test('3 · 5: 시리얼을 가리는 판본(범위 비관리자)에는 태그 · 시리얼이 어떤 표기로도 없다 — 시리얼을 보는 계정은 그대로', async () => {
  const scoped = (await views(OP_A, roomId)).all.toLowerCase();
  for (const t of ['tag9876', 'xy_56_zw78', 'xy-56-zw78', 'xy56zw78', 'qr-90-st12', 'qr90st12', 'svc0002', 'svb0003']) assert.ok(!scoped.includes(t), `범위 계정: '${t}'`);
  const full = await views(OP_ALL, roomId);
  assert.ok(full.room.places.some((p) => p.label === 'node XY_56_ZW78' && p.serial === 'XY-56-ZW78'), '전체 범위 계정은 시리얼 · 이름 원문');
  assert.equal(full.room.serialsHidden, false);
});

test('4: 연결된 서버 이름 · 미배치 서버 이름도 같은 가림(host:포트 · 다른 서버의 태그 · 범위 밖 서버의 주소)', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
    const names = [...room.unplaced.map((x) => x.name), ...room.places.map((p) => p.link?.name).filter(Boolean)];
    assert.ok(!names.some((n) => /mgmt\.example/i.test(n)), `${user.username}: ${names}`);
    assert.ok(names.includes('srv-a') || room.unplaced.some((x) => x.name === 'srv-a'), '보통 이름은 그대로');
  }
  const scopedNames = (await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body.unplaced.map((x) => x.name);
  assert.ok(scopedNames.some((n) => n.startsWith('spare-for-')) && !scopedNames.some((n) => /svc0002/i.test(n)), `이름 속 다른 서버의 태그: ${scopedNames}`);
  const admNames = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.unplaced.map((x) => x.name);
  assert.ok(admNames.includes('idrac40.mgmt.example:443') && admNames.includes('spare-for-SVC0002'), '관리자는 원문');
});

test('textMask 순수 판정: 비교 키(구분자 · 대소문자 무시) · 원문 범위 치환 · 최소 길이 · 대소문자 무시 주소 치환', () => {
  const ix = TM.tagIndexOf(['XY-56-ZW78', 'QR90ST12', 'ab', 'A-B-C']);        // 'ab'(2자) · 'abc'(3자)는 최소 길이 미만
  assert.equal(TM.stripTags('node XY_56_ZW78 rear', ix), 'node ••• rear');
  assert.equal(TM.stripTags('node qr.90:st 12', ix), 'node •••');
  assert.equal(TM.stripTags('XY56ZW78', ix), '•••');
  assert.equal(TM.stripTags('cab abc', ix), 'cab abc');
  assert.equal(TM.stripTags('xy-56-zw7', ix), 'xy-56-zw7', '끝 글자가 모자라면 맞지 않는다');
  assert.equal(TM.stripTags('', ix), ''); assert.equal(TM.stripTags('x', TM.tagIndexOf([])), 'x');
  assert.equal(TM.stripTags('a-XY-56-ZW78-b-QR90ST12', ix), 'a-•••-b-•••');
  const hx = TM.needleIndexOf(['https://Idrac-A1.mgmt.example', 'idrac-a1.mgmt.example', 'ab'], { min: 3 });
  assert.equal(TM.replaceNeedles('bmc IDRAC-A1.MGMT.EXAMPLE rear', hx, '(X)'), 'bmc (X) rear');
  assert.equal(TM.replaceNeedles('see https://idrac-a1.mgmt.example/ui', hx, '(X)'), 'see (X)/ui', '긴 것 먼저');
  assert.equal(TM.replaceNeedles('cab', hx, '(X)'), 'cab', 'min 미만은 색인에 없다');
});

test('이름 정리(cleanText): 보이지 않는 문자 범위마다 하나씩 — 지워져 눈으로 같은 이름이 같은 값이 된다', async () => {
  const L = await import(`${S}/rack/layout.js`);
  for (const ch of ['\u0001', '\u007f', '\u0085', '\u00ad', '\u061c', '\u115f', '\u1160', '\u180e', '\u200b', '\u200f', '\u2028', '\u2029', '\u202a', '\u202e', '\u2060', '\u2064', '\u2066', '\u2069', '\u3164', '\ufeff', '\uffa0']) {
    assert.equal(L.cleanText(`A1${ch}`, 32), 'A1', `U+${ch.codePointAt(0).toString(16)} (끝)`);
    assert.equal(L.cleanText(`${ch}A1`, 32), 'A1', `U+${ch.codePointAt(0).toString(16)} (앞)`);
  }
  assert.equal(L.cleanText('가상화서버 #1 – A/B', 32), '가상화서버 #1 – A/B', '보이는 글자는 그대로');
});

test.after(() => R._closeForTest());
