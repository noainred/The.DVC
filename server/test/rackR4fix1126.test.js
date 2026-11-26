// 랙 실장도 4회차 점검(2026-11-26 · 보안 1~5 · 정확성 1~4 · 3회차 반증 C2) 회귀 테스트.
//   1 자리표시 태그는 연결 키가 아니다(같은 공통 태그의 서버가 한 대를 놓는 순간 미배치에서 사라지지 않는다 · 남의 서버에 이어지지 않는다) — 진짜 태그의 중복(같은 장비)은 그대로
//   2 비 ASCII 글자가 든 시리얼은 자리표시가 아니다(usableTag)   3 이름 정리는 유니코드 속성으로(변형 선택자 · 태그 문자 · U+034F) · 가림 판정 앞에서도 지운다
//   4 낱말 경계 = 글자 갈래가 바뀌는 자리 · 짧은 키의 원문 구분자 모양(순수 함수)   5 IP 낱말의 문장 부호는 남는다 · 대괄호 뒤 주소는 낱말 통째
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr4-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
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
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.setVcenterDatacenter('vc-a', 'kr');
const srv = (id, name, host, serviceTag) => ({ id, name, host, username: 'root', password: 'x', serviceTag, vcenterId: 'vc-a' });
registry.importServers([
  srv('wb1', 'whitebox-1', 'https://192.0.2.11', 'To Be Filled By O.E.M.'), srv('wb2', 'whitebox-2', 'https://192.0.2.12', 'To Be Filled By O.E.M.'), srv('wb3', 'whitebox-3', 'https://192.0.2.13', 'To Be Filled By O.E.M.'),
  srv('none1', 'none-1', 'https://192.0.2.14', 'None'), srv('real1', 'real-1', 'https://192.0.2.15', 'REAL001'), srv('real1b', 'real-1-again', 'https://192.0.2.16', 'REAL001'),
  srv('kor1', 'kor-1', 'https://192.0.2.17', '자산1234'), srv('notag', 'no-tag', 'https://192.0.2.18', ''),
]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
let roomId; let rackId; let rev;
const room = async (user) => (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
const place = async (p) => { const r = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uSize: 1, kind: 'server', label: '', ...p } }); assert.equal(r.statusCode, 200, JSON.stringify(r.body)); rev = r.body.rev; return r.body.id; };

test('1: 자리표시 태그는 연결 키가 아니다 — 미배치 목록에 없고 태그 없는 서버와 함께 센다 · 진짜 태그 · 한글 시리얼은 미배치에', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } }); rackId = k.body.id; rev = k.body.rev;
  const v = await room(ADMIN);
  assert.deepEqual(v.unplaced.map((u) => u.serverId).sort(), ['kor1', 'real1', 'real1b'], '자리표시 태그(화이트박스 3대 · None) · 태그 없는 서버는 미배치가 아니다');
  assert.equal(v.unplacedTotal, 3);
  assert.equal(v.serversNoTag, 5, '화이트박스 3 + None 1 + 태그 없음 1');
});

test('1: 자리표시 시리얼로 놓은 장비는 아무 서버에도 이어지지 않는다 · 한 대를 놓아도 나머지 집계가 그대로 · 진짜 태그의 중복은 먼저 온 서버에', async () => {
  const pw = await place({ uStart: 1, label: 'wb', serial: 'To Be Filled By O.E.M.' });
  const pr = await place({ uStart: 2, label: 'real', serial: 'REAL001' });
  const pk = await place({ uStart: 3, label: 'kor', serial: '자산1234' });
  const v = await room(ADMIN);
  const by = (id) => v.places.find((x) => x.id === id);
  assert.equal(by(pw).link, null); assert.equal(by(pw).linkState, 'not-found', '공통 태그로는 잇지 않는다(예전엔 먼저 온 화이트박스에 이어졌다)');
  assert.equal(by(pr).link.serverId, 'real1', '같은 진짜 태그가 둘(중앙 + 엣지의 같은 장비)이면 먼저 온 서버');
  assert.equal(by(pk).link.serverId, 'kor1', '한글이 든 시리얼도 연결 키');
  assert.equal(v.serversNoTag, 5, '한 대를 놓아도 나머지가 사라지지 않는다');
  assert.equal(v.unplacedTotal, 0);
});

test('2: usableTag — 자리표시는 거르고, 비 ASCII 글자가 든 값은 거르지 않는다', () => {
  for (const t of ['None', 'To Be Filled By O.E.M.', 'Default string', '0000000', '1234567', 'AB1', '', null, undefined, 7]) assert.equal(RT.usableTag(t), false, String(t));
  for (const t of ['SVA0001', 'AB12', '자산1234', '본사-0000', '서울A1', '자산가나다라', 'ÿÿÿÿÿÿÿÿ', 'Ω-0000', '默认字符串']) assert.equal(RT.usableTag(t), true, t);
  // 4회차 반증 B-2 · C-2: 비 ASCII 예외는 호환 정규화 뒤에도 남는 글자 · 숫자에만 — 전각 · NBSP · 폭 없는 글자 · 기호가 낀 자리표시 값은 여전히 자리표시
  for (const t of ['ＮＯＮＥ', '０００００００', 'Default\u00a0string', 'To\u2009Be Filled By O.E.M.', 'None\u200b', '0000–0000', 'N/A·', '１２３４５６７']) assert.equal(RT.usableTag(t), false, JSON.stringify(t));
  // 긴 값(기억하지 않는 갈래 — 5회차 점검 성능 2)도 판정은 같다 · 같은 값을 다시 물어도 같다
  for (let i = 0; i < 2; i += 1) {
    assert.equal(RT.usableTag('0'.repeat(100)), false); assert.equal(RT.usableTag(`${'A'.repeat(40)}${'7'.repeat(40)}`), true);
    assert.equal(RT.usableTag(`To Be Filled By O.E.M.${' '.repeat(60)}`.trim()), false); assert.equal(RT.usableTag('S'.repeat(64) + '1'), true); assert.equal(RT.usableTag('SVA0001'), true);
  }
});

test('2 라우트(4회차 반증 C-2): NBSP 가 낀 자리표시 태그는 가림 재료가 아니다 — 평범한 글자를 지우지 않는다', async () => {
  registry.importServers([srv('ph1', 'ph-one', 'https://192.0.2.31', 'Default\u00a0string'), srv('ph2', 'ph-two', 'https://192.0.2.32', 'ＮＯＮＥ')], 'merge');
  await place({ uStart: 30, kind: 'other', label: 'spare default string unit' }); await place({ uStart: 31, kind: 'other', label: 'phone-02 none' });
  const labels = (await room(OP_A)).places.map((p) => p.label);
  assert.ok(labels.includes('spare default string unit') && labels.includes('phone-02 none'), JSON.stringify(labels));
  const v = await room(ADMIN);
  assert.ok(!v.unplaced.some((u) => u.serverId === 'ph1' || u.serverId === 'ph2'), '그런 태그의 서버는 연결 키가 없다(미배치가 아니라 serversNoTag)');
});

test('2 라우트: 한글 시리얼이 든 다른 장비 이름 — 시리얼을 가리는 판본에서 가려진다(자리표시로 빠지지 않는다)', async () => {
  await place({ uStart: 5, kind: 'other', label: 'spare 자산1234 box' });
  const scoped = await room(OP_A);
  assert.ok(scoped.places.some((p) => p.label === 'spare ••• box'), JSON.stringify(scoped.places.map((p) => p.label)));
  assert.ok(!JSON.stringify([scoped.places.map((p) => p.label), scoped.logs]).includes('자산1234'));
  assert.ok((await room(OP_ALL)).places.some((p) => p.label === 'spare 자산1234 box'), '시리얼을 보는 계정은 그대로');
});

test('3: 이름 정리 — 변형 선택자 · 태그 문자 · 결합 자소 연결자 · 서식 문자 · 짝 잃은 서로게이트를 지운다(유니코드 속성) · 보이는 글자는 그대로', () => {
  for (const cp of [0xfe0f, 0xfe00, 0x206a, 0x206f, 0x034f, 0x180b, 0x180f, 0xe0020, 0xe0100, 0x200b, 0xfeff, 0x00ad, 0x202e, 0x2066, 0x3164, 0x115f, 0x0085, 0x2028, 0x061c]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(L.cleanText(`A1${ch}`, 64), 'A1', `U+${cp.toString(16)} 끝`);
    assert.equal(L.cleanText(`${ch}A1`, 64), 'A1', `U+${cp.toString(16)} 앞`);
    assert.ok(!L.cleanText(`A${ch}1`, 64).includes(ch), `U+${cp.toString(16)} 가운데`);
    assert.equal(L.dropInvisible(`10.20${ch}.31.5`), '10.20.31.5', `U+${cp.toString(16)} dropInvisible`);
  }
  for (const keep of ['가상화서버 #2 (12U)', 'café – naïve', '日本語 ラック', 'Ω≈ç√ 100%', 'a b', 'emoji 😀 ok']) assert.equal(L.cleanText(keep, 64), keep);
  assert.equal(L.cleanText('A\ud83dB', 64), 'A B', '짝 잃은 앞 반쪽'); assert.equal(L.cleanText('A\ude00B', 64), 'A B', '짝 잃은 뒤 반쪽');
  assert.equal(L.dropInvisible(null), null); assert.equal(L.dropInvisible(5), 5);
  // 고정점: 한 번 정리한 이름을 다시 정리해도 같다(다시 저장이 '바뀐 것' 으로 판정되지 않는다)
  let seed = 4; const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const PIECES = ['a', 'B', ' ', '😀', '\ud83d', '\ude00', '​', '️', '가', ' ', '-'];
  for (let i = 0; i < 4000; i += 1) {
    const x = Array.from({ length: 1 + rnd(14) }, () => PIECES[rnd(PIECES.length)]).join('');
    const a = L.cleanText(x, 8);
    assert.equal(L.cleanText(a, 8), a, JSON.stringify(x));
  }
});

test('3 라우트: 같은 이름에 보이지 않는 글자를 붙인 랙은 중복(409) · 이 정리가 생기기 전에 저장된 이름도 가림 판정은 지운 글로 본다', async () => {
  for (const cp of [0xfe0f, 0x206a, 0x034f, 0x180b, 0xe0020]) {
    const r = await op({ op: 'rack.add', roomId, rev, rack: { name: `A1${String.fromCodePoint(cp)}`, heightU: 42 } });
    assert.equal(r.statusCode, 409, `U+${cp.toString(16)}: ${JSON.stringify(r.body)}`);
  }
  // 옛 판본이 그대로 저장한 이름(원장에 직접 넣는다): 화면에는 '10.20.31.5' · 'REAL001' 로 보인다
  const a = await place({ uStart: 7, kind: 'other', label: 'legacy-a' }); const b = await place({ uStart: 8, kind: 'other', label: 'legacy-b' });
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  raw.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('bmc 10.20️.31.5 rear', a);
  raw.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run('node REA⁪L001 spare', b);
  raw.close();
  await R._resyncForTest();
  for (const user of [OP_ALL, OP_A]) {
    const labels = (await room(user)).places.map((p) => p.label);
    assert.ok(!labels.join('|').includes('31.5'), `${user.username}: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((x) => /^bmc masked-[0-9a-f]{12} rear$/.test(x)), `${user.username}: ${JSON.stringify(labels)}`);
  }
  assert.ok((await room(OP_A)).places.some((p) => p.label === 'node ••• spare'), '보이지 않는 글자로 끊은 시리얼');
});

test('3 라우트(5회차 정확성 1): 보이지 않는 글자가 시리얼과 이름 **양쪽**에 든 옛 값 — 재료도 같은 눈으로 봐서 가린다 · 등록부가 자리표시면 인벤토리의 진짜 태그로 잇는다', async () => {
  const a = await place({ uStart: 20, kind: 'storage', label: 'legacy-c', serial: 'SNX778899' });
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  raw.prepare('UPDATE rack_place SET label = ?, serial = ?, serial_key = ? WHERE id = ?').run('node SN\ufe0f778899 box', 'SN\ufe0f778899', 'sn\ufe0f778899', a);
  raw.close();
  await R._resyncForTest();
  const scoped = await room(OP_A);
  assert.ok(scoped.places.some((p) => p.label === 'node ••• box'), JSON.stringify(scoped.places.map((p) => p.label)));
  assert.ok(!JSON.stringify(scoped.places.map((p) => p.label)).replace(/\ufe0f/g, '').includes('SN778899'));
  assert.ok((await room(OP_ALL)).places.some((p) => p.label === 'node SN778899 box'), '시리얼을 보는 계정은 (보이지 않는 글자만 빠진) 이름 그대로');
  // 등록부 태그 칸이 자리표시('None')이고 인벤토리에 진짜 태그가 있는 서버 — 인벤토리 태그로 미배치에 나오고 그 시리얼로 놓으면 이어진다
  const invCache = await import(`${S}/idrac/invCache.js`);
  registry.importServers([srv('inv9', 'inv-nine', 'https://192.0.2.19', 'None')], 'merge');
  invCache.setInventory('inv9', { collectedAt: Date.now(), system: { serviceTag: 'INVREAL9' } });
  let v = await room(ADMIN);
  assert.ok(v.unplaced.some((u) => u.serverId === 'inv9' && u.serviceTag === 'INVREAL9'), JSON.stringify(v.unplaced));
  const p9 = await place({ uStart: 21, label: 'nine', serial: 'INVREAL9' });
  v = await room(ADMIN);
  assert.equal(v.places.find((x) => x.id === p9).link?.serverId, 'inv9');
  invCache.removeInventory('inv9');
  // 등록부 태그에 보이지 않는 글자가 끼어 있어도(등록부는 trim 만 한다) 지운 값으로 잇고 · 싣고 · 가린다
  registry.importServers([srv('zw1', 'idrac-ZWT\u200b0002', 'https://192.0.2.20', 'ZWT\u200b0002')], 'merge');
  v = await room(ADMIN);
  assert.ok(v.unplaced.some((u) => u.serverId === 'zw1' && u.serviceTag === 'ZWT0002'), JSON.stringify(v.unplaced.filter((u) => u.serverId === 'zw1')));
  const pz = await place({ uStart: 22, label: 'zw', serial: 'ZWT0002' });
  assert.equal((await room(ADMIN)).places.find((x) => x.id === pz).link?.serverId, 'zw1', '지운 값의 키로 이어진다');
  assert.equal((await room(OP_A)).places.find((x) => x.id === pz).link?.name, 'idrac-•••', '범위 계정에게는 등록부 이름의 태그도 가려진다');
});

test('4 순수: 낱말 경계 = 글자 갈래가 바뀌는 자리 — 한글 조사는 경계 · 같은 갈래는 이어진 낱말', () => {
  assert.equal(TM.charKind('a'), 1); assert.equal(TM.charKind('Z'), 1); assert.equal(TM.charKind('7'), 1); assert.equal(TM.charKind('é'), 1);
  assert.equal(TM.charKind('가'), 2); assert.equal(TM.charKind('日'), 2); assert.equal(TM.charKind('ア'), 2);
  assert.equal(TM.charKind('-'), 0); assert.equal(TM.charKind(' '), 0); assert.equal(TM.charKind(undefined), 0); assert.equal(TM.charKind(''), 0);
  const T = (t, ...tags) => TM.stripTags(t, TM.tagIndexOf(tags));
  assert.equal(T('TAG-9874번 서버', 'TAG9874'), '•••번 서버', '구분자를 건넌 6자 이상 키 + 조사');
  assert.equal(T('A1B2J번 장비', 'A1B2J'), '•••번 장비', '짧은 키 + 접미');
  assert.equal(T('서버AB12', 'AB12'), '서버•••', '앞이 한글이어도 경계');
  assert.equal(T('lab12 glued', 'AB12'), 'lab12 glued', '라틴 글자에 붙은 짧은 키는 그대로');
  assert.equal(T('AB12x', 'AB12'), 'AB12x'); assert.equal(T('xTAG-9874', 'TAG9874'), 'xTAG-9874');
  assert.equal(T('자산번호판', '자산번호'), '자산번호판', '한글 키에 한글이 이어지면 낱말 통째가 아니다');
  assert.equal(T('자산번호 판', '자산번호'), '••• 판'); assert.equal(T('자산번호x', '자산번호'), '•••x', '한글 키 뒤의 라틴 글자는 경계');
  assert.equal(T('ΑΒΓΔΕΣ box', 'ΑΒΓΔΕΣ'), '••• box', '낱말 끝 시그마 — 키와 글을 같은 함수로 소문자화');
  const N = (t, ...h) => TM.replaceNeedles(t, TM.needleIndexOf(h, { min: 3 }), '(X)');
  assert.equal(N('esx-07에 연결된 스위치', 'esx-07'), '(X)에 연결된 스위치');
  assert.equal(N('스위치esx-07', 'esx-07'), '스위치(X)');
  assert.equal(N('KR-ESX-07 patch', 'esx-07'), 'KR-ESX-07 patch'); assert.equal(N('esx-070 spare', 'esx-07'), 'esx-070 spare'); assert.equal(N('esx-07_old', 'esx-07'), 'esx-07_old');
  // 끝 글자가 문장 부호인 항목은 이웃이 글자이기만 하면 이어진 것으로 본다(예전 규칙 그대로)
  assert.equal(N('ab-x', 'ab-'), 'ab-x'); assert.equal(N('ab- x', 'ab-'), '(X) x');
});

test('4 순수: 짧은 키(6자 미만)가 구분자를 건넌 일치 — 시리얼 원문이 같은 자리에 구분자를 둔 꼴일 때만(3회차 반증 C2)', () => {
  const T = (t, ...tags) => TM.stripTags(t, TM.tagIndexOf(tags));
  assert.equal(T('node A-101 rear', 'A-101'), 'node ••• rear', '적힌 그대로');
  assert.equal(T('node a_101 rear', 'A-101'), 'node ••• rear', '같은 자리의 다른 구분자');
  assert.equal(T('node A101 rear', 'A-101'), 'node ••• rear', '붙여 쓴 것');
  assert.equal(T('node A1-01 rear', 'A-101'), 'node A1-01 rear', '다른 자리의 구분자');
  assert.equal(T('node A-1-01 rear', 'A-101'), 'node A-1-01 rear', '구분자가 더 많은 것');
  assert.equal(T('xA-101', 'A-101'), 'xA-101', '낱말 통째가 아니다'); assert.equal(T('A-1012', 'A-101'), 'A-1012');
  assert.equal(T('R2-07번 랙', 'R2-07'), '•••번 랙');
  assert.equal(T('2026-11-26', '1126'), '2026-11-26', '원문에 구분자가 없는 키는 띄운 꼴에 맞지 않는다(날짜)');
  assert.equal(T('XY-56', 'XY56'), 'XY-56'); assert.equal(T('row 10 01 pdu', '1001'), 'row 10 01 pdu'); assert.equal(T('node-x → A1 U1', 'A1U1'), 'node-x → A1 U1');
  assert.equal(T('rack AB 12', 'AB 12'), 'rack •••', '공백이 원문에 있으면 공백도');
  assert.equal(T('rack AB-12', 'AB 12', 'ZZ9999'), 'rack •••');
  // 색인 여럿: 모양은 어느 색인에 있든 인정한다 · 모양이 여럿이면 각각
  assert.equal(TM.stripTags('x A-101 y', TM.tagIndexOf(['QQ7777']), TM.tagIndexOf(['A-101'])), 'x ••• y');
  assert.equal(T('a-101 x a1-01 a10-1', 'A-101', 'A1-01'), '••• x ••• a10-1');
  assert.equal(T('a-101 a1-01', 'A-101', 'A1-01'), '•••', '구분자만 사이에 둔 두 일치는 한 구간(사영에서 맞닿는다)');
  const ix = TM.tagIndexOf(['A-101', 'A101', 'LONGKEY-1', 'AB']);
  assert.deepEqual([...ix.shapes.keys()], ['a101'], '모양은 짧은 키에만 · 붙여 쓴 원문은 모양이 없다'); assert.deepEqual([...ix.shapes.get('a101')], ['1,']);
});

test('5 라우트: IP 낱말의 앞뒤 문장 부호는 남고 같은 주소는 같은 토큰 · 대괄호 뒤에 붙은 주소는 낱말 통째(주소마다 다른 토큰)', async () => {
  await place({ uStart: 10, kind: 'other', label: 'pdu-a (10.9.8.201)' }); await place({ uStart: 11, kind: 'other', label: 'pdu-b 10.9.8.201, spare' });
  await place({ uStart: 12, kind: 'other', label: '[BMC]10.20.31.11' }); await place({ uStart: 13, kind: 'other', label: '[BMC]10.20.31.12' });
  const labels = (await room(OP_ALL)).places.map((p) => p.label);
  const a = labels.find((x) => x.startsWith('pdu-a')); const b = labels.find((x) => x.startsWith('pdu-b'));
  assert.match(a, /^pdu-a \(masked-[0-9a-f]{12}\)$/); assert.match(b, /^pdu-b masked-[0-9a-f]{12}, spare$/);
  assert.equal(/masked-[0-9a-f]{12}/.exec(a)[0], /masked-[0-9a-f]{12}/.exec(b)[0], '같은 주소는 같은 토큰');
  const bm = labels.filter((x) => /^masked-[0-9a-f]{12} \(이름 가림\)$/.test(x));
  assert.equal(bm.length, 2); assert.notEqual(bm[0], bm[1], '다른 주소는 다른 토큰');
  assert.ok(!labels.join('|').includes('10.20.31.1') && !labels.join('|').includes('10.9.8.2'));
});

test('6: 시리얼 기록 다시 채우기가 이어서 실패하면 간격이 두 배씩 늘어난다(30초 → 1분 → 2분 … 최대 16분) · 성공하면 풀리고 기록이 채워진다(4회차 점검 성능 1)', async () => {
  let db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  db.exec("CREATE TRIGGER seen_fail BEFORE INSERT ON rack_serial_seen BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const realNow = Date.now; let now = realNow(); Date.now = () => now;
  const warn = console.warn; const warns = []; console.warn = (...a) => { warns.push(a.join(' ')); };
  const tries = async () => { const n = warns.length; await R.corpSerials('kr'); return warns.slice(n).filter((w) => w.includes('시리얼 기록')).length; };
  try {
    db = await R.openRackDb();                                   // 열 때 실패(1회)
    assert.equal(warns.filter((w) => w.includes('시리얼 기록')).length, 1);
    assert.equal(await tries(), 1, '열 때 실패한 뒤 첫 조회는 바로 다시 시도한다');
    let wait = 30_000;
    for (let step = 0; step < 8; step += 1) {
      now += wait - 1000; assert.equal(await tries(), 0, `${step}: 간격 ${wait / 1000}초가 지나기 전에는 다시 시도하지 않는다`);
      now += 2000; assert.equal(await tries(), 1, `${step}: 간격 ${wait / 1000}초가 지나면 한 번 시도한다`);
      wait = Math.min(wait * 2, 30_000 * 32);
    }
    assert.equal(wait, 960_000, '상한 16분');
    assert.ok(warns.some((w) => w.includes('960초 뒤')), '경고 글에 다음 시도까지의 시간을 적는다');
    db.exec('DROP TRIGGER seen_fail');
    now += 959_000; assert.ok(!(await R.corpSerials('kr')).includes('real001'), '아직 대기 중 — 기록은 비어 있다(지금 원장의 원문 시리얼만)');
    now += 2000;
    assert.ok((await R.corpSerials('kr')).includes('real001'), '원인이 사라진 뒤의 시도는 성공해 기록이 채워진다');
    assert.equal(await tries(), 0);
    // 다시 실패가 시작되면 간격은 처음(30초)부터
    db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
    db.exec("CREATE TRIGGER seen_fail BEFORE INSERT ON rack_serial_seen BEGIN SELECT RAISE(ABORT, 'probe'); END;");
    R._closeForTest(); db = await R.openRackDb();
    assert.equal(await tries(), 1); now += 31_000; assert.equal(await tries(), 1, '새 핸들에서는 30초부터');
  } finally { Date.now = realNow; console.warn = warn; try { db.exec('DROP TRIGGER IF EXISTS seen_fail'); } catch { /* */ } }
  R._closeForTest();
});

test.after(() => R._closeForTest());
