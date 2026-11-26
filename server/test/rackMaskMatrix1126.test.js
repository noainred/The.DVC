// 랙 실장도 — 비관리자 판본 가림의 **표기 행렬 × 응답 4경로**(2026-11-26 3회차 점검 보안 축 · 개선 제안 1).
//   가림 판정을 고칠 때 앞 회차에 닫은 표기가 다시 열리는 것을 막는다(3회차 1번 — 2회차 수정이 '[BMC]10.20.31.11' 을 다시 열었다).
//   각 표기를 표시 이름으로 놓고, 전산실 조회(places · logs) · 판 목록 · 판 글 · 판 차이 전부에서 비밀 글자가 없는지 본다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackmatrix-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const remoteInv = await import(`${S}/collector/remoteInventory.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const TM = await import(`${S}/rack/textMask.js`);
const { normKey, isKeySep } = await import(`${S}/insights/serialKey.js`);
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
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
registry.importServers([
  { id: '10.20.30.4', name: '10.20.30.4', host: '10.20.30.4', username: 'root', password: 'x', serviceTag: 'IPA0004', vcenterId: 'vc-a' },
  { id: '10.20.30.41', name: '10.20.30.41', host: '10.20.30.41', username: 'root', password: 'x', serviceTag: 'IPA0041', vcenterId: 'vc-a' },
  { id: 's-a', name: 'srv-a', host: 'https://idrac-a1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0001', vcenterId: 'vc-a' },
]);
// host 없이 올라온 원격 서버 — id 가 서비스 태그(주소 아님)
remoteInv.setCollectorServers('edge-kr', 'kr', [{ id: 'EDG2222', name: 'edge-two', serviceTag: 'EDG2222', datacenterId: 'kr', vcenterId: 'vc-a' }]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });

// [표시 이름, 응답 어디에도 없어야 하는 글자(소문자) …]
const ADDR_ROWS = [
  ['[BMC]10.20.31.11', '10.20.31.11'], ['[예비]10.20.31.12', '10.20.31.12'], ['sw [MGMT]10.20.31.13 rear', '10.20.31.13'], ['[[x]]10.20.31.38', '10.20.31.38'],
  ['sw 10.20.30.45 rear', '30.45', '가림)5'], ['10.20.30.46', '30.46', '가림)6'], ['sw 110.20.30.41 rear', '20.30.41', '1(주소'],
  ['https://[2001:db8::a14]/ui', '2001:db8'], ['kvm https://[2001:db8::a15]:8443', '2001:db8'], ['net 2001:db8::a16/64', '2001:db8'],
  ['bmc fe80::a17%eth0', 'fe80::a17'], ['bmc ip=2001:db8::a18', '2001:db8'], ['bmc(2001:db8::a19)', '2001:db8'], ['[bmc]fe80::a06', 'fe80::a06'],
  ['node.10.20.30.97', '10.20.30.97'], ['10.20.30.99.', '10.20.30.99'], ['gw 10.20.30.98.nip.io', '10.20.30.98'], ['mgmt 10.20.30.50:443', '10.20.30.50'],
  ['bmc IDRAC-A1.MGMT.EXAMPLE rear', 'idrac-a1', 'mgmt.example'], ['see https://idrac-a1.mgmt.example/ui', 'idrac-a1'],
];
const KEEP_ROWS = ['가상화서버 #2 (12U)', '점검 12:30 예정', 'fw 1.2.3', 'Unity array (예비)', 'face cafe deadbeef'];   // 그대로 보여야 하는 이름
const SER_ROWS = [   // [표시 이름, 시리얼] — 시리얼을 가리는 판본에만 해당
  ['node QX7 13 K9Z', 'QX713K9Z'], ['node RT5 44　ZZ9', 'RT544ZZ9'], ['node AB-CD_EF.GH:12', 'ABCDEFGH12'], ['pair of abcdefgh12', 'ZZ-FILL-01'],
];

let roomId; let rev;
const views = async (user) => {
  const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
  const list = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
  const details = [];
  for (const v of list.versions) details.push((await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body);
  return { room, list, details };
};
const paths = (v) => ({
  '전산실 places': JSON.stringify(v.room.places.map((p) => [p.label, p.link?.name])), '전산실 미배치': JSON.stringify(v.room.unplaced.map((u) => u.name)),
  '전산실 이력': JSON.stringify(v.room.logs.map((l) => l.detail)), '판 목록': JSON.stringify(v.list.versions.map((x) => x.detail)),
  '판 글': JSON.stringify(v.details.map((d) => d.version.detail)), '판 차이': JSON.stringify(v.details.flatMap((d) => [...(d.changes?.items || []), ...(d.restore?.items || [])].map((i) => i.name))),
});

test('준비: 표기마다 장비 하나씩(관리자) — 랙 둘에 나눠 놓는다', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k1 = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } });
  const k2 = await op({ op: 'rack.add', roomId, rev: k1.body.rev, rack: { name: 'A2', heightU: 42 } });
  rev = k2.body.rev;
  const all = [...ADDR_ROWS.map((r) => ({ label: r[0] })), ...KEEP_ROWS.map((label) => ({ label })), ...SER_ROWS.map(([label, serial]) => ({ label, serial, kind: 'storage' })),
    { label: 'EDG2222', serial: 'EDG2222', kind: 'server' }, { label: 'spare EDG2222', kind: 'other' }];
  for (const [i, x] of all.entries()) {
    const p = await op({ op: 'place.add', rackId: i < 40 ? k1.body.id : k2.body.id, rev, place: { face: 'full', uStart: (i % 40) + 1, uSize: 1, kind: 'other', ...x } });
    assert.equal(p.statusCode, 200, `${x.label}: ${JSON.stringify(p.body)}`); rev = p.body.rev;
  }
});

test('주소 표기 행렬: 비관리자 판본의 모든 경로에 원문 · 반쪽 가림이 없다(전체 범위 · 범위 계정)', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const ps = paths(await views(user));
    for (const [label, ...secrets] of ADDR_ROWS) for (const sec of secrets) for (const [where, text] of Object.entries(ps)) {
      assert.ok(!text.toLowerCase().includes(sec), `${user.username} · ${where}: 표기 ‘${label}’ 의 ‘${sec}’ 가 남았다`);
    }
    for (const keep of KEEP_ROWS) {
      assert.ok(ps['전산실 places'].includes(JSON.stringify(keep).slice(1, -1)), `${user.username}: 주소가 아닌 이름 ‘${keep}’ 은 그대로`);
      assert.ok(ps['전산실 이력'].includes(JSON.stringify(keep).slice(1, -1)), `${user.username}: 이력의 ‘${keep}’ 도 그대로`);
    }
  }
  const adm = paths(await views(ADMIN));
  for (const [label] of ADDR_ROWS) assert.ok(adm['전산실 places'].includes(JSON.stringify(label).slice(1, -1)), `관리자는 원문: ${label}`);
});

test('시리얼 표기 행렬: 시리얼을 가리는 판본에는 구분자 · 공백 종류와 무관하게 없다 — 시리얼을 보는 계정은 그대로', async () => {
  const scoped = paths(await views(OP_A));
  for (const [label, serial] of SER_ROWS) for (const [where, text] of Object.entries(scoped)) {
    const flat = normKey(text);   // 응답에서도 구분자를 걷어 내고 본다
    assert.ok(!flat.includes(normKey(serial)), `범위 계정 · ${where}: ‘${label}’ 의 시리얼 ${serial}`);
  }
  assert.ok(!normKey(scoped['전산실 places']).includes('abcdefgh12'), '다른 장비 이름에 든 시리얼(pair of …)');
  const full = paths(await views(OP_ALL));
  assert.ok(full['전산실 places'].includes('pair of abcdefgh12'), '시리얼을 보는 계정은 이름 그대로');
  // host 없는 원격 서버의 id 가 서비스 태그면 주소 재료가 아니다 — 시리얼을 보는 계정에게 그 태그가 든 이름이 가려지지 않는다(3회차 점검 5)
  assert.ok(full['전산실 places'].includes('"EDG2222"') && full['전산실 places'].includes('spare EDG2222'), full['전산실 places']);
  assert.ok(!normKey(scoped['전산실 places']).includes('edg2222'), '범위 계정에게는 태그로 가려진다');
});

test('구분자 정의는 하나: 비교 키(normKey)가 지우는 글자 = 가림 사영이 건너뛰는 글자(공백류 전부 포함)', () => {
  const ix = TM.tagIndexOf(['QX713K9Z']);
  for (let cp = 0; cp <= 0xffff; cp += 1) {
    const ch = String.fromCharCode(cp);
    const sep = normKey(`a${ch}b`) === 'ab';
    assert.equal(isKeySep(ch), sep, `U+${cp.toString(16)}`);
    if (sep) assert.equal(TM.stripTags(`node QX7${ch}13${ch}K9Z`, ix), 'node •••', `구분자 U+${cp.toString(16)} 로 띄운 시리얼`);
  }
});

test.after(() => R._closeForTest());
