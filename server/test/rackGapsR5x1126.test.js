// 랙 실장도 5회차 점검(2026-11-26 · 테스트 공백 축) — 4회차 뒤 다시 쓴 코드(글자 갈래 경계 · 짧은 키의 구분자 모양 · 글 속 IPv6 마디 묶음 · 자리표시 태그 · 보이지 않는 글자 · 재시도 간격)의
//   변이 중 기존 테스트(rack*.test.js 19파일)를 전부 통과한 것을 막는 탐침. 테스트 이름의 번호가 그 변이(scratchpad r5mut/{tm,rt,lk}.spec).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const S = '../src';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rackr5x-'));
after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });
process.env.CONFIG_DIR = tmp; process.env.RACK_DB = path.join(tmp, 'rack.db'); process.env.RACK_SELF_CHECK = '1';
const dc = await import(`${S}/datacenter/store.js`);
const { store } = await import(`${S}/store.js`);
const registry = await import(`${S}/idrac/registry.js`);
const invCache = await import(`${S}/idrac/invCache.js`);
const RT = await import(`${S}/routes/api/rack.js`);
const R = await import(`${S}/rack/db.js`);
const L = await import(`${S}/rack/layout.js`);
const TM = await import(`${S}/rack/textMask.js`);
const { isKeySep } = await import(`${S}/insights/serialKey.js`);
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
const LONG_NAME = `${'n'.repeat(310)}.10.9.8.78`;
registry.importServers([
  srv('s-a', 'srv-a', 'https://idrac-a1.mgmt.example', 'SVA0001'), srv('s-bm', 'srv-bm', 'bm9x', 'SVD0001'),
  srv('s-pad', '  10.9.8.77  ', 'https://192.0.2.50', 'PHX0001'),   // 앞뒤 공백이 붙은 '주소가 이름' 인 서버
  srv('s-long', LONG_NAME, 'https://192.0.2.52', 'LNG0001'),        // 300자를 넘는 한 낱말 이름(주소가 들었다)
  { ...srv('s-out', 'srv-out', 'https://192.0.2.53', 'REGX001'), vcenterId: 'vc-b' },   // 범위 밖 서버 — 등록부 태그와 인벤토리 태그가 다르다
  srv('s-in', 'srv-in', 'https://192.0.2.54', 'REGA001'),                               // 범위 안 서버 — 등록부 태그와 인벤토리 태그가 다르다
]);
invCache.setInventory('s-out', { collectedAt: Date.now(), system: { serviceTag: 'INVY002' } });
invCache.setInventory('s-in', { collectedAt: Date.now(), system: { serviceTag: 'INVA003' } });
const op = (body) => call('POST /tools/rack/op', { user: ADMIN, body });
const ix = (...t) => TM.tagIndexOf(t);

// ───────────────────────── 순수: 글자 갈래 · 낱말 경계(textMask.js) ─────────────────────────

test('T03 순수: 글자 갈래 — Nd 가 아닌 숫자(② · ½)는 그 밖의 글자 갈래(한글 키에 붙으면 이어진 낱말) · 전각 숫자 · 라틴 확장은 라틴 갈래', () => {
  assert.deepEqual(['a', 'Z', 'é', 'ß', '1', '１', '가', '漢', 'あ', '②', '½', '-', '#', ' ', '', undefined].map((c) => TM.charKind(c)), [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0]);
  const kx = ix('서버자산');
  assert.equal(TM.stripTags('서버자산② 랙', kx), '서버자산② 랙', '같은 갈래(그 밖의 글자)의 숫자가 붙으면 낱말이 이어진다 — 짧은 키는 가리지 않는다');
  assert.equal(TM.stripTags('②서버자산 랙', kx), '②서버자산 랙');
  assert.equal(TM.stripTags('rack 서버자산 x', kx), 'rack ••• x');
  assert.equal(TM.stripTags('rack1서버자산x', kx), 'rack1•••x', '라틴 글자 · 숫자와 맞닿은 자리는 경계');
});

test('T08 순수: 문장 부호로 시작 · 끝나는 값 — 그 끝에 글자가 붙으면 이어진 낱말(가리지 않는다) · 글자가 아니면 경계', () => {
  const px = ix('#1234');   // 키 '#1234'(5자 — 짧은 키 · '#' 은 구분자가 아니다)
  assert.equal(TM.stripTags('id #1234 rear', px), 'id ••• rear');
  assert.equal(TM.stripTags('x#1234 rear', px), 'x#1234 rear', "끝 글자가 문장 부호('#')면 이웃이 글자이기만 하면 이어진 것으로 본다");
  assert.equal(TM.stripTags('가#1234 rear', px), '가#1234 rear');
  assert.equal(TM.stripTags('(#1234) rear', px), '(•••) rear');
  const hx = TM.needleIndexOf(['~bm9'], { min: 3 });
  assert.equal(TM.replaceNeedles('x~bm9 y', hx, '(R)'), 'x~bm9 y'); assert.equal(TM.replaceNeedles('at ~bm9 y', hx, '(R)'), 'at (R) y');
});

test('T15 순수: 소문자화로 길이가 달라지는 글자(İ)가 앞에 있어도 사영과 원문 위치가 어긋나지 않는다', () => {
  assert.equal(TM.stripTags('İ SN123456 rear', ix('SN123456')), 'İ ••• rear');
  assert.equal(TM.stripTags('İİ node AB12 x', ix('AB12')), 'İİ node ••• x');
  assert.equal(TM.stripTags('rack İSTANBUL1 x', ix('İSTANBUL1')), 'rack ••• x', '그 글자가 든 시리얼도 글과 같은 사영으로 맞는다');
});

test('T24 · T27 · T28 순수: 짧은 키의 구분자 모양 — 마지막 글자 앞의 구분자도 모양 · 자리가 다르면 다른 모양 · 어느 색인의 모양이든 인정', () => {
  assert.equal(TM.stripTags('pdu A101-5 x', ix('A101-5')), 'pdu ••• x', 'T24: 구분자가 마지막 글자 바로 앞');
  assert.equal(TM.stripTags('pdu A1015 x', ix('A101-5')), 'pdu ••• x');
  assert.equal(TM.stripTags('pdu A-1015 x', ix('A101-5')), 'pdu A-1015 x', '원문과 다른 자리의 구분자');
  assert.equal(TM.stripTags('pdu A1-01 x', ix('A-101')), 'pdu A1-01 x', 'T28: 그 키에 모양이 있어도 자리가 다르면 맞지 않는다');
  assert.equal(TM.stripTags('pdu A-1-01 x', ix('A-101')), 'pdu A-1-01 x', '구분자 수가 다르면 맞지 않는다');
  assert.equal(TM.stripTags('node AB-12', null, ix('AB-12')), 'node •••', 'T27: 첫 색인이 없고 둘째(법인) 색인에 모양이 있다');
  assert.equal(TM.stripTags('node AB-12', ix('ZZ99'), ix('AB-12')), 'node •••', 'T27: 첫 색인(그 장비의 시리얼)에는 그 키가 없다');
  assert.equal(TM.stripTags('node AB-12', ix('AB-12'), ix('ZZ99')), 'node •••');
});

test('T37 · T38 · T39 순수: 경계 판정은 **그쪽 끝 글자**의 갈래로 — 앞 이웃은 첫 글자와, 뒤 이웃은 끝 글자와 견준다', () => {
  // 키의 첫 글자와 끝 글자의 갈래가 다른 값(한글로 시작해 숫자로 끝남 · 그 반대)
  assert.equal(TM.stripTags('x자산12 y', ix('자산12')), 'x••• y', 'T37: 앞 이웃(라틴)과 첫 글자(한글)는 갈래가 다르다 — 경계');
  assert.equal(TM.stripTags('가자산12 y', ix('자산12')), '가자산12 y', '앞 이웃(한글)과 첫 글자(한글)는 같은 갈래 — 이어진 낱말');
  assert.equal(TM.stripTags('자산12에 연결', ix('자산12')), '•••에 연결', 'T38: 뒤 이웃(한글)과 끝 글자(숫자)는 갈래가 다르다 — 경계');
  assert.equal(TM.stripTags('자산12x 연결', ix('자산12')), '자산12x 연결');
  assert.equal(TM.stripTags('12자산x y', ix('12자산')), '•••x y'); assert.equal(TM.stripTags('x12자산 y', ix('12자산')), 'x12자산 y');
  const hx = TM.needleIndexOf(['서버kr1', 'kr2서버'], { min: 3 });
  assert.equal(TM.replaceNeedles('x서버kr1 y', hx, '(R)'), 'x(R) y', 'T39: 등록 주소도 같다');
  assert.equal(TM.replaceNeedles('가서버kr1 y', hx, '(R)'), '가서버kr1 y');
  assert.equal(TM.replaceNeedles('kr2서버x y', hx, '(R)'), '(R)x y'); assert.equal(TM.replaceNeedles('kr2서버가 y', hx, '(R)'), 'kr2서버가 y');
});

test('T34 순수: 가장 짧은 항목이 앞머리 길이(3)보다 짧으면 앞머리도 그만큼 짧다 — 1 · 2자 항목도 찾는다', () => {
  assert.equal(TM.replaceNeedles('go ab now', TM.needleIndexOf(['ab']), 'X'), 'go X now');
  assert.equal(TM.replaceNeedles('go ab now abcd.ef x', TM.needleIndexOf(['ab', 'abcd.ef']), 'X'), 'go X now X x');
  assert.equal(TM.replaceNeedles('z q z', TM.needleIndexOf(['q', 'longer.name']), 'X'), 'z X z');
});

test('순수 대조: 머리말의 경계 규칙을 따로 적은 느린 기준(인정되는 일치 전부의 합집합)과 무작위 대조 — 한글 · 라틴 · 문장 부호가 섞인 글 · 구분자가 든 시리얼', () => {
  // 난수는 32비트 정수 연산(Math.imul)으로 — 배정밀도 곱은 아래 비트가 사라져 `% n` 이 쏠린다(4회차 점검 T-1)
  let seed = 51126;
  const rnd = (n) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };
  const ALPHA = ['a', 'B', '1', '2', '가', '나', '#']; const SEPS = [' ', '-', '_', '.', ':']; const GLUE = [' ', '-', '', '', '(', '에 ', ' x', '/'];
  const word = (n) => Array.from({ length: n }, () => ALPHA[rnd(ALPHA.length)]).join('');
  const SEP_RE = /[\s:_.-]/;
  // 이 글자표 안에서의 갈래 — 구현(유니코드 속성)과 따로 적는다: 1 라틴 글자 · 숫자 / 2 한글 / 0 그 밖
  const kind = (ch) => (ch === undefined ? 0 : /[A-Za-z0-9]/.test(ch) ? 1 : /[가-힣]/.test(ch) ? 2 : 0);
  const joined = (edge, nb) => { const k = kind(nb); if (!k) return false; const e = kind(edge); return !e || e === k; };
  const slow = (text, tags) => {
    const chars = []; for (let i = 0; i < text.length; i += 1) if (!SEP_RE.test(text[i])) chars.push([text[i].toLowerCase(), i]);
    const proj = chars.map((c) => c[0]).join('');
    const keys = new Map();   // 키 → 원문의 구분자 자리(키 안에서 그 앞에 구분자가 있던 글자의 번호)들
    for (const t of tags) {
      const kc = []; const gaps = []; let gap = false;
      for (const ch of t) { if (SEP_RE.test(ch)) { if (kc.length) gap = true; continue; } if (gap) gaps.push(kc.length); gap = false; kc.push(ch.toLowerCase()); }
      const k = kc.join(''); if (k.length < 4 || k.length > 64) continue;
      if (!keys.has(k)) keys.set(k, new Set()); keys.get(k).add(gaps.join('|'));
    }
    const hit = new Array(proj.length).fill(false);
    for (const [k, shapes] of keys) {
      for (let a = proj.indexOf(k); a >= 0; a = proj.indexOf(k, a + 1)) {
        const first = chars[a][1]; const last = chars[a + k.length - 1][1];
        const gaps = []; for (let x = 1; x < k.length; x += 1) if (chars[a + x][1] !== chars[a + x - 1][1] + 1) gaps.push(x);
        const glued = gaps.length === 0;
        const edge = !joined(text[first], text[first - 1]) && !joined(text[last], text[last + 1]);
        // 6자 이상: 붙여 썼으면 어디든 · 구분자를 건넜으면 양 끝이 경계 / 6자 미만: 양 끝이 경계이고(붙여 썼거나 · 원문과 같은 자리의 구분자)
        if (k.length >= 6 ? (glued || edge) : (edge && (glued || shapes.has(gaps.join('|'))))) for (let x = a; x < a + k.length; x += 1) hit[x] = true;
      }
    }
    let out = ''; let from = 0; let a = 0;
    while (a < proj.length) { if (!hit[a]) { a += 1; continue; } let b = a; while (b < proj.length && hit[b]) b += 1; out += `${text.slice(from, chars[a][1])}•••`; from = chars[b - 1][1] + 1; a = b; }
    return out + text.slice(from);
  };
  const spread = (w) => w.split('').join('\u0000').replace(/\u0000/g, () => (rnd(4) ? '' : SEPS[rnd(SEPS.length)]));
  let masked = 0; let crossed = 0;
  for (let n = 0; n < 12000; n += 1) {
    const tags = Array.from({ length: 1 + rnd(4) }, () => { const w = word(4 + rnd(5)); return rnd(3) ? w : spread(w); });
    let text = '';
    for (let w = 0; w < 1 + rnd(6); w += 1) { const t = tags[rnd(tags.length)]; text += (rnd(3) === 0 ? word(1 + rnd(5)) : rnd(2) ? t : spread(t.replace(/[\s:_.-]/g, ''))) + GLUE[rnd(GLUE.length)]; }
    const half = Math.ceil(tags.length / 2);
    const want = slow(text, tags);
    assert.equal(TM.stripTags(text, TM.tagIndexOf(tags.slice(0, half)), TM.tagIndexOf(tags.slice(half))), want, `글 ${JSON.stringify(text)} · 태그 ${JSON.stringify(tags)}`);
    if (want.includes('•••')) masked += 1; if (tags.some((t) => SEP_RE.test(t))) crossed += 1;
  }
  assert.ok(masked > 6000 && crossed > 3000, `글자표가 쏠리지 않았다(가려진 글 ${masked} · 구분자 든 시리얼이 낀 회차 ${crossed})`);
});

// ───────────────────────── 순수: 보이지 않는 글자(layout.js) · 구분자(serialKey.js) ─────────────────────────

test('L01 · L05 · L06 · L07 순수: 기본 무시가 아닌 서식 문자(Cf) · 줄 분리 · 문단 분리도 지운다 — dropInvisible 은 공백을 넣지 않고 지운다', () => {
  // Cf 이면서 Default_Ignorable 이 아닌 글자: 아랍 수 표식 U+0600 · U+06DD · 시리아 약어 표식 U+070F · 행간 주석 U+FFF9~FFFB
  for (const cp of [0x0600, 0x0605, 0x06dd, 0x070f, 0xfff9, 0xfffa, 0xfffb, 0x2028, 0x2029, 0x0000, 0x001f, 0x007f, 0x009f]) {
    const ch = String.fromCodePoint(cp);
    assert.equal(L.dropInvisible(`10.20${ch}.31.5`), '10.20.31.5', `U+${cp.toString(16)} dropInvisible`);
    assert.equal(L.cleanText(`A1${ch}`, 64), 'A1', `U+${cp.toString(16)} cleanText 끝`);
    assert.ok(!L.cleanText(`A${ch}1`, 64).includes(ch), `U+${cp.toString(16)} cleanText 가운데`);
  }
  assert.equal(L.dropInvisible('fe80​::️a1'), 'fe80::a1'); assert.equal(L.dropInvisible('A\ud83dB'), 'AB', '짝 잃은 서로게이트');
  assert.equal(L.dropInvisible('emoji 😀 ok 가-1'), 'emoji 😀 ok 가-1', '보이는 글자 · 공백은 그대로');
});

test('K09 순수: isKeySep 은 normKey 가 지우는 글자와 정확히 같다 — ASCII 전부 · 경계 밖(U+000E · U+001C~001F) 포함', () => {
  const re = /[\s:_.-]/;
  for (let c = 0; c < 0x3100; c += 1) { const ch = String.fromCharCode(c); assert.equal(isKeySep(ch), re.test(ch), `U+${c.toString(16)}`); }
  for (const c of [0xfeff, 0x3000, 0x2028, 0x2029, 0x202f, 0x205f, 0xff0d, 0xff3f, 0xff1a]) { const ch = String.fromCharCode(c); assert.equal(isKeySep(ch), re.test(ch), `U+${c.toString(16)}`); }
});

// ───────────────────────── 라우트: 글 속 IPv6 · 대괄호 · 이름 가림 ─────────────────────────

const RUN81 = `x ${'ab:'.repeat(27)}fe80::a63 y`;   // 16진 · 콜론 구간이 81자를 넘는다(상한 80 — 주소로 보지 않는다 · 지금 동작)
// [변이, 표시 이름, 응답 어디에도 없어야 하는 글자(소문자) …]
const MASK_ROWS = [
  ['M21', 'tag aa:bb:cc:dd:ee:f0:11:22:33:44:2001:db8::a62 x', '2001:db8::a62', 'aa:bb:cc'],   // 41자를 넘는 구간(이름표 · MAC 뒤에 붙은 IPv6) — 상한은 80
  ['M21', 'v6 2001:0db8:0000:0000:0000:0000:0000:0a35:8443 x', '0db8', '0a35'],                 // 줄이지 않은 39자 + 포트
];
// [변이, 표시 이름, 비관리자에게 보이는 꼴(정규식)]
const EXACT_ROWS = [
  ['M11 · M24', 'bmc [2001:db8::a61]:443 x', /^bmc masked-[0-9a-f]{12} x$/],          // 대괄호 + 포트는 낱말 통째(포트 · 대괄호를 남기지 않는다)
  ['M12', '[BMC]10.20.31.61 x', /^masked-[0-9a-f]{12} x$/],                           // 대괄호 뒤에 붙은 주소는 낱말 통째
  ['M27', 'gw (10.9.8.201), ok', /^gw \(masked-[0-9a-f]{12}\), ok$/],                 // 알맹이가 IPv4 — 문장 부호는 남는다
  ['M28', 'see (fe80::a64), ok', /^see \(masked-[0-9a-f]{12}\), ok$/],                // 알맹이가 IPv6
  ['M29', 'at "bm9x"; ok', /^at "masked-[0-9a-f]{12}"; ok$/],                         // 알맹이가 등록 주소 그대로
  ['M23', 'sep :: here', /^sep :: here$/],                                            // 16진 글자가 없는 '::' 는 주소가 아니다
  ['M22', RUN81, new RegExp(`^${RUN81.replace(/[.]/g, '\\.')}$`)],                    // (지금 동작 고정) 80자를 넘는 16진 · 콜론 구간은 살피지 않는다
];
let roomId; let rev = 0; const racks = []; const idOf = new Map();
const add = async (label) => {
  const n = idOf.size;
  const p = await op({ op: 'place.add', rackId: racks[Math.floor(n / 40)], rev, place: { face: 'full', uStart: (n % 40) + 1, uSize: 1, kind: 'other', label } });
  assert.equal(p.statusCode, 200, `${label}: ${JSON.stringify(p.body)}`); rev = p.body.rev; idOf.set(label, p.body.id);
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
  for (const name of ['A1', 'A2']) { const k = await op({ op: 'rack.add', roomId, rev, rack: { name, heightU: 42 } }); assert.equal(k.statusCode, 200, JSON.stringify(k.body)); rev = k.body.rev; racks.push(k.body.id); }
  for (const [, label] of [...MASK_ROWS, ...EXACT_ROWS]) await add(label);
});

test('M21: 이름표 · MAC · 포트가 콜론으로 붙어 41자를 넘는 구간의 IPv6 — 비관리자 판본의 모든 경로에 원문이 없다', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user); const ps = paths(v);
    for (const [id, label, ...secrets] of MASK_ROWS) {
      for (const sec of secrets) for (const [where, text] of Object.entries(ps)) assert.ok(!text.toLowerCase().includes(sec), `${id} · ${user.username} · ${where}: 표기 ‘${label}’ 의 ‘${sec}’ 가 남았다`);
      assert.notEqual(labelOf(v, label), label, `${id} · ${user.username}`);
    }
  }
});

test('M11 · M12 · M22 · M23 · M24 · M27 · M28 · M29: 가린 꼴 — 대괄호가 낀 낱말은 통째 · 알맹이가 주소면 문장 부호를 남긴다 · 주소가 아닌 것은 그대로', async () => {
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user);
    for (const [id, label, re] of EXACT_ROWS) assert.match(String(labelOf(v, label)), re, `${id} · ${user.username}: ${labelOf(v, label)}`);
  }
});

// 2026-11-27(사용자 결정 — 칸 목록 투영 `rack/project.js`): 등록부 서버 이름 · 미배치 서버 목록은 조회 계정에 싣지 않는다 — 예전에 미배치 이름으로 보던 M34
//   (‘이름 가림’ 갈래의 앞뒤 공백 · 길이 상한)는 조회 계정에 남은 이름(표시 이름 — 이 정리가 생기기 전에 저장된 값을 원장에 직접 넣는다)으로 옮겨서 본다.
test("M34: 등록부 이름('주소가 이름' · 300자를 넘는 낱말)은 조회 계정에 싣지 않는다 · 표시 이름 — 앞뒤 공백이 붙은 '주소가 이름' 은 이름 가림 표기 · 300자를 넘는 낱말은 살피지 않고 토큰 하나(이름 가림 표기 없음)", async () => {
  for (const user of [OP_ALL, OP_A]) {
    const room = (await call('GET /tools/rack/room/:id', { user, params: { id: roomId } })).body;
    assert.deepEqual(room.unplaced, [], `${user.username}: 미배치 목록은 비어 있다`); assert.equal(room.unplacedListed, false);
    assert.equal(room.unplacedTotal, 5, `${user.username}: 대수는 예전과 같다`);
    const j = JSON.stringify(room);
    assert.ok(!j.includes('10.9.8.7'), `${user.username}: 등록부 이름의 주소(10.9.8.77 · …10.9.8.78)가 응답 어디에도 없다`);
    assert.ok(!j.includes('n'.repeat(40)), `${user.username}: 300자를 넘는 등록부 이름의 조각도 없다`);
  }
  const admNames = (await call('GET /tools/rack/room/:id', { user: ADMIN, params: { id: roomId } })).body.unplaced.map((x) => x.name);
  assert.ok(admNames.includes('10.9.8.77') && admNames.includes(LONG_NAME), `관리자 판본의 미배치 목록은 등록부 이름 원문(이 시험이 그 이름을 실제로 등록했다): ${JSON.stringify(admNames.map((n) => n.slice(0, 20)))}`);
  // 표시 이름으로 옮긴 M34 — 옛 판본이 그대로 저장한 이름(원장에 직접 넣는다 · 새 입력은 cleanText 가 다듬고 96자에서 자른다)
  await add('legacy-m34-pad'); await add('legacy-m34-long');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  const set = (label, v) => raw.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run(v, idOf.get(label));
  set('legacy-m34-pad', '  10.9.8.79  ');                        // 앞뒤 공백이 붙은 '주소가 이름'
  set('legacy-m34-long', `${'n'.repeat(310)}.10.9.8.80`);        // 300자를 넘는 한 낱말(주소가 들었다)
  raw.close();
  await R._resyncForTest();
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user);
    assert.match(String(labelOf(v, 'legacy-m34-pad')), /^masked-[0-9a-f]{12} \(이름 가림\)$/, `이름(앞뒤 공백) · ${user.username}: ${JSON.stringify(labelOf(v, 'legacy-m34-pad'))}`);
    assert.match(String(labelOf(v, 'legacy-m34-long')), /^masked-[0-9a-f]{12}$/, `M34 · ${user.username}: ${JSON.stringify(String(labelOf(v, 'legacy-m34-long')).slice(0, 60))}`);
    assert.ok(!JSON.stringify(v.room).includes('10.9.8.'), `${user.username}: 그 표시 이름의 주소가 전산실 응답 어디에도 없다`);
  }
});

test('M09: 등록부 태그 칸이 차 있어도 장비가 답한 인벤토리 태그가 다르면 둘 다 가림 재료다(범위 밖 · 범위 안 서버 모두)', async () => {
  await add('spare INVY002 box'); await add('spare INVA003 box'); await add('spare REGX001 box');
  const scoped = await views(OP_A); const ps = paths(scoped);
  for (const sec of ['invy002', 'inva003', 'regx001']) for (const [where, text] of Object.entries(ps)) assert.ok(!text.toLowerCase().includes(sec), `범위 계정 · ${where}: ‘${sec}’ 가 남았다`);
  for (const label of ['spare INVY002 box', 'spare INVA003 box', 'spare REGX001 box']) assert.equal(labelOf(scoped, label), 'spare ••• box', label);
  const full = await views(OP_ALL);
  assert.equal(labelOf(full, 'spare INVY002 box'), 'spare INVY002 box', '시리얼을 보는 계정은 그대로');
});

test('M31 · M32 · M40: 이 정리가 생기기 전에 저장된 이름(보이지 않는 글자가 낀 주소) — 낱말 하나면 이름 가림 표기 · 그 이름으로 만든 이력 글에도 주소가 남지 않는다', async () => {
  await add('legacy-one'); await add('legacy-pad'); await add('legacy-move');
  const { DatabaseSync } = await import('node:sqlite');
  const raw = new DatabaseSync(process.env.RACK_DB);
  const set = (label, v) => raw.prepare('UPDATE rack_place SET label = ? WHERE id = ?').run(v, idOf.get(label));
  set('legacy-one', '10.20️.31.81');          // 화면에는 '10.20.31.81' 한 낱말로 보인다
  set('legacy-pad', '10.20.31.82 ️');         // 보이지 않는 글자를 지우면 끝에 공백이 남는다 — 그래도 한 낱말
  set('legacy-move', 'bmc 10.20͏.31.83 rear');
  raw.close();
  await R._resyncForTest();
  // 그 이름으로 이력 글을 만든다(옮기기 — 이력의 글은 저장된 이름 그대로 적힌다)
  const mv = await op({ op: 'place.update', id: idOf.get('legacy-move'), rackId: racks[1], rev, place: { uStart: 42 } });
  assert.equal(mv.statusCode, 200, JSON.stringify(mv.body)); rev = mv.body.rev;
  const seen = (text) => L.dropInvisible(text);   // 화면에 보이는 글자
  for (const user of [OP_ALL, OP_A]) {
    const v = await views(user);
    assert.match(String(labelOf(v, 'legacy-one')), /^masked-[0-9a-f]{12} \(이름 가림\)$/, `M32 · ${user.username}: ${JSON.stringify(labelOf(v, 'legacy-one'))}`);
    assert.match(String(labelOf(v, 'legacy-pad')), /^masked-[0-9a-f]{12} \(이름 가림\)$/, `M40 · ${user.username}: ${JSON.stringify(labelOf(v, 'legacy-pad'))}`);
    for (const [where, text] of Object.entries(paths(v))) for (const sec of ['31.81', '31.82', '31.83']) assert.ok(!seen(text).includes(sec), `M31 · ${user.username} · ${where}: ‘${sec}’ 가 남았다 — ${seen(text).slice(0, 200)}`);
    assert.ok(v.room.logs.some((l) => /^bmc masked-[0-9a-f]{12} rear/.test(seen(l.detail))), `M31 · ${user.username}: 옮긴 이력의 이름도 토큰 — ${JSON.stringify(v.room.logs.slice(0, 3).map((l) => l.detail))}`);
  }
  const adm = await views(ADMIN);
  assert.ok(adm.room.logs.some((l) => seen(l.detail).includes('10.20.31.83')), '관리자 이력에는 원문(이 시험이 이력 글에 그 이름을 실제로 넣었다)');
});
