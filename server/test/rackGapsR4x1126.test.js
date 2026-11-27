// 랙 실장도 4회차 점검(2026-11-26 · 테스트 공백 축) — 3회차 뒤 다시 쓴 코드(가림의 경계 규칙 · 글 속 IP 판정 · 시리얼 기록 채우기)의 변이 중
//   기존 테스트(rack*.test.js 17파일)를 전부 통과한 것을 막는 탐침. 테스트 이름의 번호가 그 변이(scratchpad r4mut/*.spec).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr4x-'));
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
store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }], hosts: [], vms: [] };
dc.addDatacenter({ id: 'kr', name: 'KR' }); dc.addDatacenter({ id: 'us', name: 'US' }); dc.setVcenterDatacenter('vc-a', 'kr');
registry.importServers([
  { id: 's-a', name: 'srv-a', host: 'https://idrac-a1.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVA0001', vcenterId: 'vc-a' },
  { id: 's-dot', name: 'srv-dot', host: 'idrac-b1.mgmt.example.', username: 'root', password: 'x', serviceTag: 'SVB0001', vcenterId: 'vc-b' },   // 끝 점이 붙은 FQDN
  { id: 's-bm9', name: 'srv-bm9', host: 'bm9x', username: 'root', password: 'x', serviceTag: 'SVD0001', vcenterId: 'vc-b' },
  { id: 'node.id.example', name: 'srv-id', host: 'realhost.mgmt.example', username: 'root', password: 'x', serviceTag: 'SVE0001', vcenterId: 'vc-b' },   // host 가 있는 서버의 점 든 id
  { id: 's-two', name: 'srv-two', host: 'two.mgmt.example', username: 'root', password: 'x', serviceTag: 'REG1111', vcenterId: 'vc-b' },   // 범위 밖 서버(등록부 태그)
]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const nx = (xs) => TM.needleIndexOf(xs, { min: 3 });

test('T03 · T04 · T07 · T20 · T21 · T22 순수: 등록 주소의 자유 일치 경계는 점 · 콜론이 든 6자부터 — 5자는 낱말 통째 · 호스트 낱말 글자에 밑줄 포함', () => {
  // T03(NEEDLE_FREE_MIN 6 → 5): 점이 든 5자 항목은 다른 글자에 붙으면 맞지 않는다
  assert.equal(TM.replaceNeedles('xa.b.cy', nx(['a.b.c']), '(X)'), 'xa.b.cy');
  assert.equal(TM.replaceNeedles('see a.b.c now', nx(['a.b.c']), '(X)'), 'see (X) now');
  // T04 · T22(6 → 7 · >= → >): 점이 든 딱 6자 항목은 글 속 어디든 맞는다
  assert.equal(TM.replaceNeedles('xab.cdey', nx(['ab.cde']), '(X)'), 'x(X)y');
  assert.equal(TM.replaceNeedles('xab:cdey', nx(['ab:cde']), '(X)'), 'x(X)y', '콜론이 든 6자도');
  assert.equal(TM.NEEDLE_FREE_MIN, 6); assert.equal(TM.TAG_FREE_MIN, 6);
  // T07(HOST_CH 에서 '_' 빼기): 밑줄로 이어진 이름은 한 낱말이다 — 점 없는 등록 주소가 그 일부면 그대로
  assert.equal(TM.replaceNeedles('KR1_A02 spare', nx(['kr1']), '(X)'), 'KR1_A02 spare');
  assert.equal(TM.replaceNeedles('sub_kr1 tape', nx(['kr1']), '(X)'), 'sub_kr1 tape');
  assert.equal(TM.replaceNeedles('ssh kr1 now', nx(['kr1']), '(X)'), 'ssh (X) now');
});

test('T12 순수: 6자 이상 키도 구분자를 건넌 일치는 양 끝이 낱말 경계일 때만(앞 · 뒤에 글자가 붙으면 그대로)', () => {
  const ix = TM.tagIndexOf(['TAG9876']);
  assert.equal(TM.stripTags('xTAG-9876 spare', ix), 'xTAG-9876 spare', '앞에 글자가 붙고 구분자로 띄운 것');
  assert.equal(TM.stripTags('spare TAG-9876x', ix), 'spare TAG-9876x', '뒤에 글자가 붙고 구분자로 띄운 것');
  assert.equal(TM.stripTags('spare TAG 9876 rear', ix), 'spare ••• rear');
  assert.equal(TM.stripTags('xTAG9876y', ix), 'x•••y', '붙여 쓴 6자 이상 키는 글 속 어디든');
});

// ── 라우트: 글 속 IP 판정(hasIpv4 · hasIpv6) · 등록 주소 낱말 · 자리표시 태그 ──
// [변이, 표시 이름, 응답 어디에도 없어야 하는 글자(소문자) …] — 주소로 가려야 하는 표기
const MASK_ROWS = [
  ['M05', 'gw 1.2.3.4 x', '1.2.3.4'],                                           // 가장 짧은 IPv4(7자)
  ['M13', 'gw :fe80::a31 x', 'fe80::a31'],                                      // 앞에 문장 부호 콜론 하나가 붙은 IPv6
  ['M14', 'note fe80:a34::: end', 'fe80:a34'],                                  // '::' 로 끝나는 IPv6 뒤에 문장 부호 콜론(이력 글 '이름: 랙' 꼴)
  ['M20', 'v6 2001:0db8:0000:0000:0000:0000:0000:0a35 x', '0db8', '0a35'],      // 줄이지 않은 가장 긴 표기(39자)
  ['M21', 'lo ::1 x', '::1'],                                                   // 가장 짧은 IPv6(3자)
];
// [변이, 표시 이름, (있으면) 보이는 꼴] — 주소가 아니므로 그대로 보여야 하는 표기. 셋째 칸 = 전각 ASCII 는 저장 전에 반각으로 접힌다(2026-11-27 `layout.js foldWidth` — 관리자에게도 접힌 글).
const KEEP_ROWS = [
  ['M01', 'bios 12.34.56 rear'],              // 숫자 묶음 3개(7자 이상)는 IPv4 가 아니다
  ['M03 · M07', 'lot 10.20.3000.40.50 x'],    // 4자리 묶음이 끼면 이어진 묶음 4개가 아니다(자릿수 1~3 · 틀린 묶음에서 셈을 되돌린다)
  ['M04', 'rev 10.20.30. end'],               // 끝 점 뒤의 빈 묶음은 세지 않는다
  ['M10', 'std::beef note'],                  // 16진 · 콜론 구간 앞에 글자가 붙어 있으면 주소가 아니다
  ['M11', 'cafe::string x'],                  // 뒤에 글자가 붙어 있어도
  ['M18', 'ns 12345::b7 keep'],               // '::' 가 있어도 net.isIPv6 가 거짓이면(마디가 5자리) 주소가 아니다
  ['M22', 'sep ::: here'],                    // 16진 숫자가 없는 콜론 묶음
  // 2026-11-27: 전각 숫자는 이제 저장 전에 반각으로 접혀 ‘ver2::beef’ 가 된다(구간 ‘2::beef’ 앞은 글자 r — 여전히 주소가 아니다). 접힌 꼴로 보이는지를 본다.
  ['M36', 'ver２::beef note', 'ver2::beef note'],
  // M36 의 본뜻(구간 앞의 16진 구간에 들지 않는 숫자도 '글자 · 숫자' 다)은 접히지 않는 숫자로 본다 — 아라비아-인도 숫자 2(U+0662 · Nd)
  ['M36', 'ver٢::beef note'],
];
// [변이, 낱말 하나인 표시 이름] — 통째로 등록 주소(문장 부호 · 대소문자만 다름)면 '<토큰> (이름 가림)'
const NAME_ROWS = [['M24', '(bm9x)'], ['M25', 'idrac-b1.mgmt.example.'], ['M26', 'IDRAC-A1.MGMT.EXAMPLE']];

let roomId; let rev; const racks = []; const idOf = new Map();
const add = async (place) => {
  const n = idOf.size;
  const p = await op({ op: 'place.add', rackId: racks[Math.floor(n / 40)], rev, place: { face: 'full', uStart: (n % 40) + 1, uSize: 1, kind: 'other', ...place } });
  assert.equal(p.statusCode, 200, `${place.label}: ${JSON.stringify(p.body)}`); rev = p.body.rev; idOf.set(place.label, p.body.id);
  return p.body.id;
};
const views = async (user) => {
  const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
  const list = (await call('GET /tools/rack/versions', { user, query: { corp: 'kr' } })).body;
  const details = [];
  for (const v of list.versions) details.push((await call('GET /tools/rack/versions/:vid', { user, params: { vid: String(v.id) }, query: { corp: 'kr' } })).body);
  return { room, list, details };
};
const paths = (v) => ({
  '전산실 places': JSON.stringify(v.room.places.map((p) => p.label)), '전산실 이력': JSON.stringify(v.room.logs.map((l) => l.detail)), '판 목록': JSON.stringify(v.list.versions.map((x) => x.detail)),
  '판 글': JSON.stringify(v.details.map((d) => d.version.detail)), '판 차이': JSON.stringify(v.details.flatMap((d) => [...(d.changes?.items || []), ...(d.restore?.items || [])].map((i) => i.name))),
});
const labelOf = (v, label) => v.room.places.find((p) => p.id === idOf.get(label))?.label;

test('준비: 표기마다 장비 하나씩(관리자)', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  for (const name of ['A1', 'A2']) { const k = await op({ op: 'rack.add', roomId, rev: rev || 0, rack: { name, heightU: 42 } }); assert.equal(k.statusCode, 200, JSON.stringify(k.body)); rev = k.body.rev; racks.push(k.body.id); }
  for (const [, label] of [...MASK_ROWS, ...KEEP_ROWS, ...NAME_ROWS]) await add({ label });
});

test('M05 · M13 · M14 · M20 · M21: 주소 표기 — 비관리자 판본의 모든 경로에 원문이 없다', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user); const ps = paths(v);
    for (const [id, label, ...secrets] of MASK_ROWS) {
      for (const sec of secrets) for (const [where, text] of Object.entries(ps)) assert.ok(!text.toLowerCase().includes(sec), `${id} · ${user.username} · ${where}: 표기 ‘${label}’ 의 ‘${sec}’ 가 남았다`);
      assert.notEqual(labelOf(v, label), label, `${id} · ${user.username}: ‘${label}’ 이 그대로 나갔다`);
    }
  }
  const adm = await views(ADMIN);
  for (const [, label] of MASK_ROWS) assert.equal(labelOf(adm, label), label, '관리자는 원문');
});

test('M01 · M03 · M04 · M07 · M10 · M11 · M18 · M22 · M36: 주소가 아닌 표기는 가려지지 않는다(과잉 가림 없음 — 전각 ASCII 만 반각으로 접힌 꼴로 보인다)', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user);
    for (const [id, label, shown] of KEEP_ROWS) assert.equal(labelOf(v, label), shown ?? label, `${id} · ${user.username}`);
  }
  // 2026-11-27: 전각 → 반각 접기는 가림이 아니라 저장 정리다 — 관리자 판본도 같은 글을 본다(조회 계정에게만 글자가 바뀌는 것이 아니다)
  const adm = await views(ADMIN);
  for (const [id, label, shown] of KEEP_ROWS) assert.equal(labelOf(adm, label), shown ?? label, `${id} · 관리자`);
});

test('M24 · M25 · M26: 낱말 하나인 이름이 등록 주소 그대로면(문장 부호 · 끝 점 · 대소문자 차이) 이름 가림 표기로 나간다', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user);
    for (const [id, label] of NAME_ROWS) assert.match(String(labelOf(v, label)), /^masked-[0-9a-f]{12} \(이름 가림\)$/, `${id} · ${user.username}: ${labelOf(v, label)}`);
  }
});

test('T32 · T34 순수: 겹친 일치는 가장 먼 끝까지 — 뒤 색인 · 뒤 자리의 짧은 일치가 구간을 줄이지 않는다', () => {
  assert.equal(TM.stripTags('SN12345678', TM.tagIndexOf(['SN12345678']), TM.tagIndexOf(['SN1234'])), '•••', 'T32: 앞 색인의 긴 일치 뒤에 뒤 색인의 짧은 일치');
  assert.equal(TM.stripTags('ABCDEFGHIJ', TM.tagIndexOf(['ABCDEFGHIJ', 'CDEFGH'])), '•••', 'T34: 구간 안에서 시작해 구간 안에서 끝나는 일치');
});

test('M28: 그 장비의 시리얼이 자리표시 값(unknown)이면 그 장비 이름의 같은 낱말을 지우지 않는다', async () => {
  await add({ label: 'unknown vendor box', serial: 'unknown', kind: 'storage' });
  const v = await views(OP_A);
  assert.equal(labelOf(v, 'unknown vendor box'), 'unknown vendor box');
  assert.ok(paths(v)['전산실 이력'].includes('unknown vendor box'), '이력 글(그 행의 tags 가 own 으로 넘어온다)에서도');
});

// ⚠ '과잉 가림' 쪽 변이(M35)를 막으려고 **지금 동작을 그대로 고정**한다 — 계약으로 삼을지는 결정이 필요하다(넓히기로 하면 이 테스트를 지운다).
//   M30(등록부 태그가 있는 서버의 인벤토리 태그도 재료로)은 탐침을 두지 않는다 — 점검 기준 513bf9f5 뒤의 커밋 2b1f11d4 가 바로 그 동작으로 바꿨다(변이 = 새 코드).
//   새 동작을 고정하려면: 등록부 태그 'REG1111' · 인벤토리 태그 'INV2222' 인 범위 밖 서버 → 범위 계정에게 'spare INV2222 x' 가 'spare ••• x'.
test('M35(지금 동작 고정): host 가 있는 서버의 점 든 id 는 주소 가림 재료가 아니다 · 등록부 태그는 재료다', async () => {
  await add({ label: 'spare REG1111 x' }); await add({ label: 'see node.id.example now' });
  assert.equal(labelOf(await views(OP_A), 'spare REG1111 x'), 'spare ••• x', '등록부 태그는 재료');
  for (const user of [OP_ALL, OP_A]) assert.equal(labelOf(await views(user), 'see node.id.example now'), 'see node.id.example now', `M35 · ${user.username}`);
});

test('D01: 열 때 채우는 시리얼 기록은 법인별이다 — 다른 법인의 키가 섞이지 않는다', async () => {
  const s = (await op({ op: 'site.add', corpId: 'us', name: 'US-S' })).body.id;
  const usRoom = (await op({ op: 'room.add', siteId: s, name: 'US-R' })).body.id;
  const k = await op({ op: 'rack.add', roomId: usRoom, rev: 0, rack: { name: 'U1', heightU: 42 } }); assert.equal(k.statusCode, 200, JSON.stringify(k.body));
  const p = await op({ op: 'place.add', rackId: k.body.id, rev: k.body.rev, place: { face: 'full', uStart: 1, uSize: 1, kind: 'storage', label: 'us box', serial: 'USONLY-7701' } });
  assert.equal(p.statusCode, 200, JSON.stringify(p.body));
  await add({ label: 'kr box', serial: 'KRONLY-5501', kind: 'storage' });
  let db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  R._closeForTest();
  db = await R.openRackDb();
  const of = (c) => db.prepare('SELECT key FROM rack_serial_seen WHERE corp_id = ?').all(c).map((r) => r.key);
  assert.ok(of('kr').includes('kronly5501') && of('us').includes('usonly7701'), '각 법인의 키는 그 법인에');
  assert.ok(!of('kr').includes('usonly7701'), 'us 의 키가 kr 기록에 없다');
  assert.ok(!of('us').includes('kronly5501'), 'kr 의 키가 us 기록에 없다');
});

test('D08: 읽을 때 다시 채우기도 실패하면 대기 시간 동안 다시 시도하지 않는다(조회마다 판 전부를 풀지 않는다)', async () => {
  let db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  db.exec("CREATE TRIGGER seen_fail BEFORE INSERT ON rack_serial_seen BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const warn = console.warn; const warns = []; console.warn = (...a) => { warns.push(a.join(' ')); };
  try {
    db = await R.openRackDb();                               // 열 때 1회(실패)
    for (let i = 0; i < 4; i += 1) await R.corpSerials('kr');   // 읽을 때 1회 더(실패) — 그 뒤 3번은 시도하지 않는다
  } finally { console.warn = warn; db.exec('DROP TRIGGER seen_fail'); }
  assert.equal(warns.filter((w) => w.includes('시리얼 기록')).length, 2, warns.join('\n'));
  R._closeForTest();   // 대기 시각을 지운다 — 다음에 열 때 다시 채운다
  db = await R.openRackDb();
  assert.ok((await R.corpSerials('kr')).includes('kronly5501'));
});

test.after(() => R._closeForTest());
