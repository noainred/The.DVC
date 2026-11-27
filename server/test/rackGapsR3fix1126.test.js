// 랙 실장도 3회차 점검(2026-11-26 · 정확성 축) 회귀:
//   1 겹치는 시리얼 키 — 일치 구간을 전부 합쳐 가린다(짧은 키가 긴 키를 깨뜨려 꼬리가 남지 않는다) · 느린 기준 구현과 무작위 대조
//   3 이름 정리 — 자른 뒤 끝 공백 · 서로게이트 반쪽이 남지 않는다(눈으로 같은 이름의 중복 · 다시 저장하면 '바뀐 것' 판정)
//   관찰: 같은 이름 저장은 기준 판도 만들지 않는다 · 시리얼 기록을 열 때 못 채웠으면 가림 재료를 읽을 때 다시 채운다 · 토큰을 등록 주소가 다시 건드리지 않는다
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr3fix-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
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
registry.importServers([   // 16진 글자뿐인 짧은 등록 주소 — 토큰('masked-<16진>') 안을 다시 훑지 않아야 한다
  { id: 'h1', name: 'h1', host: 'abc', username: 'root', password: 'x', serviceTag: 'HEX0001', vcenterId: 'vc-a' },
  { id: 'h2', name: 'h2', host: 'f0e', username: 'root', password: 'x', serviceTag: 'HEX0002', vcenterId: 'vc-a' },
  { id: 'h3', name: 'h3', host: 'idrac1.mgmt', username: 'root', password: 'x', serviceTag: 'HEX0003', vcenterId: 'vc-a' },
  { id: 'h4', name: 'h4', host: 'mgmt.example', username: 'root', password: 'x', serviceTag: 'HEX0004', vcenterId: 'vc-a' },
]);
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });

test('1 순수: 겹치는 키는 구간을 합쳐 통째로 가린다 · 색인 여럿을 한 번에', () => {
  assert.equal(TM.stripTags('ZZSN1212345678', TM.tagIndexOf(['ZZSN12', 'SN1212345678'])), '•••', '앞에서 시작한 짧은 키가 뒤 키의 앞부분을 먹어도 꼬리가 남지 않는다');
  // 2회차 반증 C2: 6자 미만 키는 낱말 통째일 때만 — 긴 키에 붙은 4자 키는 맞지 않고, 긴 키만 가린다
  assert.equal(TM.stripTags('ZZSN12345678', TM.tagIndexOf(['ZZSN', 'SN12345678'])), 'ZZ•••');
  assert.equal(TM.stripTags('next to SN12345678', TM.tagIndexOf(['1234']), TM.tagIndexOf(['SN12345678'])), 'next to •••', '그 장비의 짧은 시리얼 + 법인의 긴 시리얼');
  assert.equal(TM.stripTags('a 1234 b SN12345678 c', TM.tagIndexOf(['1234']), TM.tagIndexOf(['SN12345678'])), 'a ••• b ••• c');
  assert.equal(TM.stripTags('abcd x efgh', TM.tagIndexOf(['abcd']), null, TM.tagIndexOf(['efgh'])), '••• x •••', '빈 색인을 섞어도 된다 · 떨어진 구간은 따로');
  assert.equal(TM.stripTags('abcd efgh', TM.tagIndexOf(['abcd']), TM.tagIndexOf(['efgh'])), '•••', '구분자만 사이에 둔 두 키는 한 구간(사영에서 맞닿는다)');
  assert.equal(TM.stripTags('abcdefghijkl', TM.tagIndexOf(['abcdef', 'ghijkl'])), '•••', '맞닿은 구간은 하나로');
  assert.equal(TM.stripTags('abcdefgh', TM.tagIndexOf(['abcd', 'efgh'])), 'abcdefgh', '6자 미만 키는 붙여 쓴 글자 속에서 맞지 않는다');
  const hx = TM.needleIndexOf(['idrac1.mgmt', 'mgmt.example'], { min: 3 });
  assert.equal(TM.replaceNeedles('see idrac1.mgmt.example now', hx, '(X)'), 'see (X) now', '겹치는 등록 주소도 꼬리 없이');
});

test('1 순수: 느린 기준 구현(키마다 모든 일치 구간의 합집합)과 무작위 대조', () => {
  let seed = 20261126;
  // 난수는 32비트 정수 곱(Math.imul)으로 — `seed * 1103515245` 는 2^53 을 넘어 아래 비트가 사라지고 `% n` 이 한쪽으로 쏠린다
  //   (4회차 점검 테스트 축 T-1 실측: rnd(8) 의 99.6% 가 0 — 점 · 콜론이 든 항목 · 긴 항목이 거의 나오지 않아 경계 규칙을 시험하지 못했다).
  const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const ALPHA = 'ab12XY'; const SEPS = [' ', '-', '_', '.', ':', ' ', ' '];
  const word = (n) => Array.from({ length: n }, () => ALPHA[rnd(ALPHA.length)]).join('');
  const slow = (text, keys) => {
    let proj = ''; const pos = [];
    for (let i = 0; i < text.length; i += 1) { if (isKeySep(text[i])) continue; const l = text[i].toLowerCase(); proj += l.length === 1 ? l : text[i]; pos.push(i); }
    const hit = new Array(proj.length).fill(false);
    // 경계 규칙(2회차 반증 C2)을 구현과 다른 방식(원문 조각 + 정규식)으로 적는다: 6자 미만 = 붙여 쓴 낱말 통째 · 6자 이상 = 붙여 썼거나 양 끝이 낱말 경계
    const ok = (a, k) => {
      const first = pos[a]; const last = pos[a + k.length - 1];
      const glued = text.slice(first, last + 1).length === k.length;
      const edge = !/[\p{L}\p{N}]$/u.test(text.slice(0, first)) && !/^[\p{L}\p{N}]/u.test(text.slice(last + 1));
      return k.length >= 6 ? (glued || edge) : (glued && edge);
    };
    for (const k of keys) for (let a = proj.indexOf(k); a >= 0; a = proj.indexOf(k, a + 1)) if (ok(a, k)) for (let x = a; x < a + k.length; x += 1) hit[x] = true;
    let out = ''; let from = 0; let a = 0;
    while (a < proj.length) {
      if (!hit[a]) { a += 1; continue; }
      let b = a; while (b < proj.length && hit[b]) b += 1;
      out += `${text.slice(from, pos[a])}•••`; from = pos[b - 1] + 1; a = b;
    }
    return out + text.slice(from);
  };
  for (let n = 0; n < 4000; n += 1) {
    const tags = Array.from({ length: 1 + rnd(4) }, () => word(4 + rnd(5)));
    let text = '';
    for (let w = 0; w < 1 + rnd(6); w += 1) text += (rnd(3) ? word(1 + rnd(6)) : tags[rnd(tags.length)].split('').join(rnd(2) ? '' : SEPS[rnd(SEPS.length)])) + SEPS[rnd(SEPS.length)];
    const keys = [...new Set(tags.map(normKey).filter((k) => k.length >= 4))];
    const half = Math.ceil(tags.length / 2);
    assert.equal(TM.stripTags(text, TM.tagIndexOf(tags.slice(0, half)), TM.tagIndexOf(tags.slice(half))), slow(text, keys), `글 ${JSON.stringify(text)} · 태그 ${JSON.stringify(tags)}`);
  }
});

let roomId; let rackId; let rev;
test('1 라우트: 다른 장비의 긴 시리얼이 든 이름 — 그 장비의 짧은 시리얼 때문에 꼬리가 남지 않는다 · 토큰은 깨지지 않는다', async () => {
  const s = (await op({ op: 'site.add', corpId: 'kr', name: 'S' })).body.id;
  roomId = (await op({ op: 'room.add', siteId: s, name: 'R' })).body.id;
  const k = await op({ op: 'rack.add', roomId, rev: 0, rack: { name: 'A1', heightU: 42 } }); rackId = k.body.id; rev = k.body.rev;
  for (const place of [{ uStart: 1, label: 'next to SN12345678', serial: '1234', kind: 'storage' }, { uStart: 2, label: 'big', serial: 'SN12345678', kind: 'storage' },
    ...Array.from({ length: 12 }, (_, i) => ({ uStart: 10 + i, label: `sw 10.77.${i}.9 rear` }))]) {
    const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uSize: 1, kind: 'other', ...place } }); assert.equal(p.statusCode, 200); rev = p.body.rev;
  }
  const scoped = JSON.stringify((await call('GET /tools/rack/room/:id', { user: OP_A, params: { id: roomId } })).body);
  assert.ok(!scoped.includes('5678') && !normKey(scoped).includes('sn1234'), '긴 시리얼의 꼬리 · 머리 모두 없다');
  assert.ok(scoped.includes('next to •••'));
  // IP 낱말은 토큰 하나로 — 'masked-' 뒤 16진 12자가 그대로(짧은 등록 주소 'abc' · 'f0e' 가 토큰 안을 '(주소 가림)' 으로 바꾸지 않는다)
  const all = (await call('GET /tools/rack/room/:id', { user: OP_ALL, params: { id: roomId } })).body;
  const labels = all.places.map((p) => p.label).filter((x) => x.startsWith('sw '));
  assert.equal(labels.length, 12);
  for (const x of labels) assert.match(x, /^sw masked-[0-9a-f]{12} rear$/, x);
});

test('3: 이름 정리 — 자른 뒤 끝 공백 · 서로게이트 반쪽이 남지 않는다 · 그런 이름의 중복은 409 · 다시 저장하면 바뀐 것 없음', async () => {
  assert.equal(L.cleanText(`${'R'.repeat(63)} x`, 64), 'R'.repeat(63));
  assert.equal(L.cleanText(`${'y'.repeat(95)} zzz`, 96), 'y'.repeat(95));
  assert.equal(L.cleanText(`${'e'.repeat(95)}😀tail`, 96), 'e'.repeat(95), '쌍의 앞 반쪽에서 잘리면 그 반쪽도 뺀다');
  assert.equal(L.cleanText(`${'e'.repeat(94)}😀tail`, 96), `${'e'.repeat(94)}😀`, '온전한 쌍은 남긴다');
  assert.equal(L.cleanText('  가 나  ', 10), '가 나');
  const long = `${'R'.repeat(63)} x`;
  const a = await op({ op: 'rack.add', roomId, rev, rack: { name: long, heightU: 42 } }); assert.equal(a.statusCode, 200); rev = a.body.rev;
  const b = await op({ op: 'rack.add', roomId, rev, rack: { name: 'R'.repeat(63), heightU: 42 } });
  assert.equal(b.statusCode, 409, '눈으로 같은 이름의 랙이 둘 생기지 않는다');
  const p = await op({ op: 'place.add', rackId, rev, place: { face: 'full', uStart: 40, uSize: 1, kind: 'other', label: `${'y'.repeat(95)} zzz` } }); rev = p.body.rev;
  const stored = (await R.getRoom(roomId)).places.find((x) => x.id === p.body.id).label;
  assert.equal(stored, 'y'.repeat(95));
  const again = await op({ op: 'place.update', id: p.body.id, rev, place: { label: `${'y'.repeat(95)} zzz` } });
  assert.equal(again.body.unchanged, true, '같은 입력을 다시 보내면 바뀐 것 없음(판을 만들지 않는다)');
});

test('관찰: 같은 이름 저장은 기준 판도 만들지 않는다(판이 하나도 없는 법인)', async () => {
  const db = await R.openRackDb();
  const sid = (await R.listTree(new Set(['kr']))).sites[0].id;
  db.prepare("DELETE FROM rack_version WHERE corp_id = 'kr'").run();
  const r = await R.renameSite({ id: sid, name: 'S', user: 'admin' });
  assert.equal(r.unchanged, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rack_version WHERE corp_id = 'kr'").get().n, 0);
  await R.renameSite({ id: sid, name: 'S2', user: 'admin' });
  assert.deepEqual((await R.listVersions('kr')).map((v) => v.action), ['site.rename', 'version.baseline']);
});

test('관찰: 시리얼 기록을 열 때 못 채웠으면 가림 재료를 읽을 때 다시 채운다', async () => {
  let db = await R.openRackDb();
  db.exec('DELETE FROM rack_serial_seen'); db.exec("DELETE FROM rack_meta WHERE k = 'seenKeys'");
  db.exec("CREATE TRIGGER seen_fail BEFORE INSERT ON rack_serial_seen BEGIN SELECT RAISE(ABORT, 'probe'); END;");
  R._closeForTest();
  const warn = console.warn; console.warn = () => {};
  try { db = await R.openRackDb(); } finally { console.warn = warn; }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rack_serial_seen').get().n, 0, '열 때 채우기는 실패했다');
  db.exec('DROP TRIGGER seen_fail');
  const got = await R.corpSerials('kr');
  assert.ok(got.includes('sn12345678') && got.includes('1234'), '읽을 때 다시 채웠다');
  assert.equal(db.prepare("SELECT v FROM rack_meta WHERE k = 'seenKeys'").get().v, R.RACK_META_VERSIONS.seenKeys);   // 2026-11-27: 비교 키가 폭에 무관해져 판 번호가 올랐다
});

test.after(() => R._closeForTest());
