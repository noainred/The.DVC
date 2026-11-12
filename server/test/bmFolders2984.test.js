// 물리서버 폴더(v2.984 · 도구 키 bm-folders) — docs/design/bm-folders/README.md · 사용자 '기본값대로 구현'.
//   저장소(손상 503 · 정리) · 판정(손 등록 > 자동 규칙 · 법인 불일치 · 보류/없어짐 · 이름 앞부분) · 찾기(포함/제외 · 가린 이름 · 태그 금지) ·
//   라우트(범위 · 가림 · 토큰 키 · 쓰기 범위 404→403 · 전 법인 규칙 게이트 · 일괄 등록 법인별 폴더 생성 · 이름 바꾸기 · 삭제 expect · 엣지 서버).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bmfolders-'));
process.env.CONFIG_DIR = tmp;

const bs = await import('../src/bmfolders/store.js');
const { buildFolders, placeMember, sortRules, namePrefix, searchMembers, parseTokens } = await import('../src/bmfolders/build.js');
const registry = await import('../src/idrac/registry.js');
const { store } = await import('../src/store.js');
const { registerBmFolders } = await import('../src/routes/api/bmFolders.js');
const central = await import('../src/central/fleet.js');
const { config } = await import('../src/config.js');
const { TOOL_PATH_KEYS } = await import('../src/auth/toolAccess.js');
const { isChangeWatchExcluded } = await import('../src/backup/service.js');

const routes = new Map();
registerBmFolders({ get: (p, ...h) => routes.set(`GET ${p}`, h.at(-1)), post: (p, ...h) => routes.set(`POST ${p}`, h.at(-1)) });
const ADMIN = { username: 'admin', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: [] } };
const SCOPED = { username: 'op-a', role: 'operator', scope: { vcenters: ['vc-a'], regions: [], writeVcenters: [] } };
const WSCOPED = { username: 'op-w', role: 'operator', scope: { vcenters: ['vc-a', 'vc-b'], regions: [], writeVcenters: ['vc-a'] } };
const ADMIN_W = { username: 'admin-w', role: 'admin', scope: { vcenters: [], regions: [], writeVcenters: ['vc-a'] } };
async function call(key, { user = ADMIN, query = {}, body = {} } = {}) {
  const res = { statusCode: 200, headers: {}, body: undefined, headersSent: false,
    status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; },
    setHeader(k, v) { this.headers[k] = v; }, set(k, v) { this.headers[k] = v; return this; }, end() { this.headersSent = true; return this; }, send(x) { this.body = x; this.headersSent = true; return this; } };
  await routes.get(key)({ user, query, body, ip: '127.0.0.1', headers: {}, originalUrl: `${key.replace(/^\w+ /, '/api')}?${new URLSearchParams(query)}` }, res);
  return res;
}
let gen = 0;
const snapOf = (hosts = []) => ({ ...store.snapshot, initial: false, generatedAt: Date.now() + 1000 + (gen += 7),
  vcenters: [{ id: 'vc-a', name: 'vcenter-a', status: 'ok' }, { id: 'vc-b', name: 'vcenter-b', status: 'ok' }], hosts, vms: [] });
const SRV = (id, name, tag, vc) => ({ id, name, host: `https://192.0.2.${10 + Number(id.replace(/\D/g, '') || 0)}`, username: 'root', password: 'x', serviceTag: tag, ...(vc ? { vcenterId: vc } : {}) });
function reset() {
  bs._resetForTest();
  for (const f of ['bm-folders.json', 'bm-folders-assign.json']) { try { fs.rmSync(path.join(tmp, f)); } catch { /* 없음 */ } }
  for (const f of fs.readdirSync(tmp)) if (f.includes('.corrupt.')) fs.rmSync(path.join(tmp, f));
  registry.importServers([
    SRV('s1', 'kr-db-01', 'TAG1', 'vc-a'), SRV('s2', 'kr-db-02', 'TAG2', 'vc-a'), SRV('s3', 'kr-web-01', 'TAG3', 'vc-a'),
    SRV('s4', 'pl-db-01', 'TAG4', 'vc-b'), SRV('s5', 'x-db-09', 'TAG5', ''),
  ], 'replace');
}
const withSnap = async (fn, hosts = []) => { const prev = store.snapshot; try { store.snapshot = snapOf(hosts); return await fn(); } finally { store.snapshot = prev; } };

// ───────── 저장소 ─────────
test('저장소: 조상 폴더 채움 · 잘못된 경로/키 버림 · 자동 규칙 기본 꺼짐 · 등록 변경 감시 제외', () => {
  const m = bs.normalizeMain({ corps: { 'vc-a': { folders: ['DB\\Oracle', '', 'a\\\\b', 7] } }, rules: [{ corp: '*', value: 'ora', path: 'DB' }, { corp: '', value: 'x', path: 'X' }], settings: {} });
  assert.deepEqual(m.corps['vc-a'].folders, ['DB', 'DB\\Oracle']);
  assert.equal(m.rules.length, 1); assert.equal(m.settings.autoRules, false);
  const a = bs.normalizeAssign({ assign: { 'st:tag1': { corp: 'vc-a', path: 'DB' }, 'bad-key': { corp: 'vc-a', path: 'DB' }, 'fl:zz': { corp: 'vc-a', path: 'DB' }, 'st:t2': { corp: 'vc-a', path: '' } } });
  assert.deepEqual(Object.keys(a.assign), ['st:tag1']);
  assert.equal(isChangeWatchExcluded('bm-folders-assign.json'), true, '등록은 자주 바뀐다 — 변경 감시 백업 제외');
  assert.equal(isChangeWatchExcluded('bm-folders.json'), false, '폴더 구조는 설정 — 감시 대상');
  assert.equal(TOOL_PATH_KEYS['bm-folders'], 'bm-folders', '도구 접근 집행 매핑(세그먼트 = 키)');
});

test('저장소 손상: 빈 트리로 시작하지 않고 조회 503 · 쓰기 503 · 초기화는 전체 범위 관리자만 · 손상본 보존', async () => {
  reset();
  fs.writeFileSync(path.join(tmp, 'bm-folders.json'), '{ broken');
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    assert.equal(g.statusCode, 503); assert.equal(g.body.error, 'registryUnreadable'); assert.equal(g.body.canReset, true);
    assert.equal((await call('GET /tools/bm-folders', { user: SCOPED })).body.canReset, false);
    const w = await call('POST /tools/bm-folders/op', { body: { op: 'folder.add', corp: 'vc-a', path: 'DB' } });
    assert.equal(w.statusCode, 503);
    assert.equal(fs.readFileSync(path.join(tmp, 'bm-folders.json'), 'utf8'), '{ broken', '손상 파일을 덮어쓰지 않는다');
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'store.reset' } })).statusCode, 403);
    assert.equal((await call('POST /tools/bm-folders/op', { user: ADMIN_W, body: { op: 'store.reset' } })).statusCode, 403, '쓰기 범위가 지정된 관리자도 전 법인 초기화 불가');
    const r = await call('POST /tools/bm-folders/op', { body: { op: 'store.reset' } });
    assert.equal(r.statusCode, 200); assert.equal(r.body.result.moved.length, 1);
    assert.ok(fs.readdirSync(tmp).some((f) => f.startsWith('bm-folders.json.corrupt.')));
    assert.equal((await call('GET /tools/bm-folders')).statusCode, 200);
  });
});

// ───────── 판정(순수) ─────────
test('판정: 손 등록 > 자동 규칙(켜졌을 때만 · 베어메탈만) · 법인이 바뀐 등록은 놓지 않는다 · 규칙 순서', () => {
  const rules = sortRules([{ id: 'r1', corp: '*', value: 'db', path: 'ALL' }, { id: 'r2', corp: 'A', value: 'db', path: 'A-DB' }, { id: 'r3', corp: 'A', value: 'ora-db', path: 'ORA' }]);
  assert.deepEqual(rules.map((r) => r.id), ['r3', 'r2', 'r1'], '법인 규칙 먼저 · 긴 값 먼저');
  const m = { key: 'st:x', kind: 'bm', corp: 'A', name: 'KR-ORA-DB-1' };
  assert.deepEqual(placeMember(m, {}, rules, false), { path: '', src: null }, '자동 규칙 꺼짐');
  assert.equal(placeMember(m, {}, rules, true).path, 'ORA');
  assert.equal(placeMember({ ...m, kind: 'esxi' }, {}, rules, true).src, null, 'ESXi 는 규칙 대상이 아니다');
  assert.equal(placeMember(m, { 'st:x': { corp: 'A', path: 'MAN' } }, rules, true).src, 'manual');
  const moved = placeMember(m, { 'st:x': { corp: 'B', path: 'MAN' } }, rules, true);
  assert.equal(moved.src, null); assert.equal(moved.moved, 'B', '다른 법인 폴더에 조용히 남기지 않는다');
});

test('판정: 목록에 없는 등록은 출처를 다 읽었을 때만 없어짐 — 못 읽은 출처 · 수집 전 법인 · 골격 스냅샷은 보류 · 범위 밖은 싣지 않는다', () => {
  const main = bs.emptyMain();
  const assign = { 'st:gone': { corp: 'A', path: 'DB', name: 'gone' }, 'st:other': { corp: 'B', path: 'DB', name: 'o' } };
  assert.deepEqual(buildFolders({ members: [], main, assign }).missing.map((x) => x.state).sort(), ['ghost', 'ghost']);
  assert.deepEqual(buildFolders({ members: [], main, assign, bmBlocked: true }).missing.map((x) => x.why), ['source-unread', 'source-unread']);
  assert.equal(buildFolders({ members: [], main, assign, holdCorps: new Set(['A']) }).missing.find((x) => x.key === 'st:gone').state, 'held');
  assert.ok(buildFolders({ members: [], main, assign, snapInitial: true }).missing.every((x) => x.state === 'held'));
  const sc = buildFolders({ members: [], main, assign, allowed: new Set(['A']) });
  assert.deepEqual(sc.missing.map((x) => x.key), ['st:gone']);
  assert.deepEqual(sc.corps.map((c) => c.vcenterId), ['A']);
  assert.deepEqual(sc.corps[0].folders.map((f) => f.path), ['DB'], '목록에 없는 등록의 폴더도 트리에 남는다(보류를 숨기지 않게)');
});

test('판정: 법인 미지정은 전체 범위에서만 센다 · 폴더 합계는 하위 포함 · 이름 앞부분 묶음(3대 이상 · 주소 · 태그 이름 제외)', () => {
  const B = (key, corp, name, extra = {}) => ({ key, kind: 'bm', corp, name, serviceTag: key.slice(3), ...extra });
  const members = [B('st:a1', 'A', 'use-web-01'), B('st:a2', 'A', 'use-web-02'), B('st:a3', 'A', 'use-web-03.corp.local'), B('st:a4', 'A', '10.0.0.5', { nameIsAddr: true }),
    B('st:a5', 'A', 'A5'), B('st:n1', '', 'nocorp-1'), B('st:d1', 'A', 'kr-db-1')];
  const assign = { 'st:d1': { corp: 'A', path: 'DB\\Oracle' } };
  const b = buildFolders({ members, main: bs.emptyMain(), assign });
  assert.equal(b.noCorp, 1);
  assert.equal(buildFolders({ members, main: bs.emptyMain(), assign, allowed: new Set(['A']) }).noCorp, 0);
  const db = b.corps[0].folders.find((f) => f.path === 'DB');
  assert.deepEqual([db.direct, db.total], [0, 1]);
  assert.deepEqual(b.prefixGroups, [{ prefix: 'use-web', n: 3, corps: ['A'] }]);
  assert.equal(namePrefix('webserver'), '', '번호 없는 이름은 묶음 근거가 아니다');
  // 범위 계정 판본: 묶음은 가린 이름으로만 — 이름 속 태그 조각('idrac-abc1234' → 'idrac-abc')이 묶음 이름으로 새지 않는다
  const tagged = [B('st:abc1234', 'A', 'idrac-ABC1234'), B('st:abc1235', 'A', 'idrac-ABC1235'), B('st:abc1236', 'A', 'idrac-ABC1236')];
  assert.deepEqual(buildFolders({ members: tagged, main: bs.emptyMain(), assign: {} }).prefixGroups.map((g) => g.prefix), ['idrac-abc']);
  assert.deepEqual(buildFolders({ members: tagged, main: bs.emptyMain(), assign: {}, nameFn: (m) => m.name.toLowerCase().replace(m.serviceTag, '•••') }).prefixGroups, []);
  // 목록에서 사라진 등록 — 등록 순간 이름이 주소였다는 표지를 실어 보낸다(라우트가 비관리자 판본에서 가린다)
  assert.equal(buildFolders({ members: [], main: bs.emptyMain(), assign: { 'st:z': { corp: 'A', path: 'P', name: '10.0.0.9', addr: true } } }).missing[0].addr, true);
  assert.equal(bs.normalizeAssignEntry('st:z', { corp: 'A', path: 'P', name: '10.0.0.9', addr: 'yes' }).addr, undefined, 'addr 는 참/거짓만');
  assert.equal(namePrefix('kr-gpu-12.corp.local'), 'kr-gpu');
});

test('찾기: 포함은 하나라도 · 제외는 하나라도 · 포함 글자가 없으면 0 · 태그 찾기는 가림 판본에서 꺼짐 · 가린 이름으로만 맞춘다 · 법인 없는 서버 제외', () => {
  const ms = [{ key: 'st:1', kind: 'bm', corp: 'A', name: 'kr-db-01', serviceTag: 'ABC', model: 'R650' }, { key: 'st:2', kind: 'bm', corp: 'A', name: 'kr-db-bak', serviceTag: 'DEF', model: 'R750' },
    { key: 'st:3', kind: 'esxi', corp: 'A', name: 'esx-db', serviceTag: 'GHI', model: 'R650' }, { key: 'st:4', kind: 'bm', corp: '', name: 'x-db', serviceTag: 'JKL' }];
  const place = new Map();
  assert.equal(searchMembers(ms, place, { include: '' }).total, 0);
  assert.deepEqual(searchMembers(ms, place, { include: 'db', exclude: 'bak' }).rows.map((x) => x.m.key), ['st:1']);
  assert.equal(searchMembers(ms, place, { include: 'db', kinds: { bm: true, esxi: true } }).total, 3);
  assert.equal(searchMembers(ms, place, { include: 'abc', fields: { name: true, tag: true } }).total, 1);
  assert.equal(searchMembers(ms, place, { include: 'abc', fields: { name: true, tag: true }, hideTag: true }).total, 0, '범위 계정은 태그로 찾지 않는다');
  assert.equal(searchMembers(ms, place, { include: 'kr', nameFn: () => '서버 ••••' }).total, 0, '가린 이름에 없는 글자로는 맞지 않는다');
  assert.deepEqual(parseTokens(' DB , ora,db,,' + 'x'.repeat(100)), ['db', 'ora', 'x'.repeat(64)]);
});

// ───────── 라우트 ─────────
test('라우트: 전 법인 찾아 일괄 등록 — 각 서버 자기 법인 폴더(없으면 만든다) · 다른 폴더 서버는 기본으로 건너뜀 · 법인 미지정 제외', async () => {
  reset();
  await withSnap(async () => {
    const s = await call('GET /tools/bm-folders/search', { query: { inc: 'db', exc: '' } });
    assert.equal(s.statusCode, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.rows.map((x) => x.name).sort(), ['kr-db-01', 'kr-db-02', 'pl-db-01'], '법인 미지정(x-db-09)은 폴더에 넣을 수 없어 빠진다');
    assert.deepEqual(s.body.facets.corp, { 'vc-a': 2, 'vc-b': 1 });
    const a = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: s.body.rows.map((x) => x.key) } });
    assert.equal(a.statusCode, 200, JSON.stringify(a.body));
    assert.deepEqual([a.body.result.added, a.body.result.newFolders, a.body.result.corps], [3, 2, 2]);
    const g = await call('GET /tools/bm-folders');
    const vca = g.body.corps.find((c) => c.vcenterId === 'vc-a');
    assert.equal(vca.folders.find((f) => f.path === 'DB').total, 2);
    assert.equal(g.body.corps.find((c) => c.vcenterId === 'vc-b').folders[0].total, 1);
    assert.equal(g.body.noCorp, 1);
    // 다른 폴더(손 등록)에 있는 서버는 moveExisting 없이는 건너뛴다
    const b = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: s.body.rows.map((x) => x.key) } });
    assert.equal(b.body.result.added, 0); assert.equal(b.body.result.skipped.inOther, 3);
    const c = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: [s.body.rows[0].key], moveExisting: true } });
    assert.equal(c.body.result.added, 1);
    const ex = await call('GET /tools/bm-folders.csv');
    assert.match(ex.body, /서비스 태그/); assert.match(ex.body, /DB › Oracle/);
  });
});

test('라우트(범위 계정): 자기 법인만 · 서비스 태그 · 엣지 이름 · 법인 미지정 비노출 · 키는 토큰 · 원문 키 거부 · 태그로 찾지 않음', async () => {
  reset();
  await withSnap(async () => {
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: ['st:tag1', 'st:tag4'] } });
    const g = await call('GET /tools/bm-folders', { user: SCOPED });
    assert.equal(g.statusCode, 200);
    assert.deepEqual(g.body.corps.map((c) => c.vcenterId), ['vc-a']);
    assert.equal(g.body.noCorp, undefined);
    const txt = JSON.stringify(g.body);
    assert.equal(/tag1|tag4|pl-db|x-db|st:/i.test(txt), false, txt.slice(0, 400));
    assert.ok(g.body.servers.every((x) => /^masked-/.test(x.key) && x.serviceTag === undefined && x.agent === undefined));
    const t = await call('GET /tools/bm-folders/search', { user: SCOPED, query: { inc: 'tag', fields: 'name,tag' } });
    assert.equal(t.body.total, 0, '태그로 찾는 길이 없다');
    assert.equal((await call('GET /tools/bm-folders/search', { user: SCOPED, query: { inc: 'db', corp: 'vc-b' } })).statusCode, 404);
    // 원문 st: 키는 받지 않는다(태그를 맞혀 보는 길) — 토큰으로만
    const raw = await call('POST /tools/bm-folders/op', { user: SCOPED, body: { op: 'unassign', keys: ['st:tag1'] } });
    assert.equal(raw.body.result.removed, 0);
    const tok = g.body.servers.find((x) => x.name === 'kr-db-01').key;
    const ok = await call('POST /tools/bm-folders/op', { user: SCOPED, body: { op: 'unassign', keys: [tok] } });
    assert.equal(ok.body.result.removed, 1);
    const sx = await call('GET /tools/bm-folders.csv', { user: SCOPED });
    assert.equal(/서비스 태그|TAG/i.test(sx.body), false);
  });
});

test('라우트(쓰기 범위): 조회 밖 404 → 쓰기 밖 403 · 여러 법인 일괄 등록은 쓰기 밖을 건너뛰고 센다 · 전 법인 규칙 · 자동 규칙 켜기는 전체 범위 관리자', async () => {
  reset();
  await withSnap(async () => {
    assert.equal((await call('POST /tools/bm-folders/op', { user: SCOPED, body: { op: 'folder.add', corp: 'vc-b', path: 'X' } })).statusCode, 404);
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'folder.add', corp: 'vc-b', path: 'X' } })).statusCode, 403);
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'folder.add', corp: 'vc-a', path: 'X' } })).statusCode, 200);
    // 범위 계정(조회 범위가 지정됨)은 토큰 키로만 쓴다 — 자기 GET 의 키
    const mine = (await call('GET /tools/bm-folders', { user: WSCOPED })).body.servers;
    const tk = (n) => mine.find((x) => x.name === n).key;
    const a = await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'assign', path: 'DB', keys: [tk('kr-db-01'), tk('pl-db-01')] } });
    assert.equal(a.body.result.added, 1); assert.equal(a.body.result.skipped.readOnly, 1);
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'assign', path: 'DB', keys: [tk('pl-db-01')] } })).statusCode, 403, '전부 쓰기 밖이면 403');
    const vb = mine.find((x) => x.name === 'pl-db-01');
    assert.equal(vb.serviceTag, undefined, '조회 범위가 지정된 계정 판본');
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'rule.add', corp: '*', value: 'db', path: 'DB' } })).statusCode, 403);
    assert.equal((await call('POST /tools/bm-folders/op', { user: ADMIN_W, body: { op: 'settings', autoRules: true } })).statusCode, 403);
    assert.equal((await call('POST /tools/bm-folders/op', { user: WSCOPED, body: { op: 'rule.add', corp: 'vc-a', value: 'web', path: 'WEB' } })).statusCode, 200);
    let g = await call('GET /tools/bm-folders');
    assert.equal(g.body.servers.find((x) => x.name === 'kr-web-01').place, null, '자동 규칙은 꺼진 채 시작');
    assert.equal((await call('POST /tools/bm-folders/op', { body: { op: 'settings', autoRules: true } })).statusCode, 200);
    g = await call('GET /tools/bm-folders');
    const web = g.body.servers.find((x) => x.name === 'kr-web-01');
    assert.deepEqual([web.place, web.path], ['rule', 'WEB']);
  });
});

test('라우트: 폴더 이름 바꾸기는 하위 · 등록 · 법인 규칙 경로를 함께 · 삭제는 미리 본 대수와 같을 때만 · 서버는 (미분류)로 돌아간다', async () => {
  reset();
  await withSnap(async () => {
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB\\Oracle', keys: ['st:tag1', 'st:tag2'] } });
    await call('POST /tools/bm-folders/op', { body: { op: 'rule.add', corp: 'vc-a', value: 'ora', path: 'DB\\Oracle' } });
    const r = await call('POST /tools/bm-folders/op', { body: { op: 'folder.rename', corp: 'vc-a', path: 'DB', name: '데이터베이스' } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.result.moved, 2);
    assert.deepEqual(Object.values(bs.peekAssign()).filter((a) => a.corp === 'vc-a').map((a) => a.path), ['데이터베이스\\Oracle', '데이터베이스\\Oracle']);
    assert.equal(bs.peekMain().rules[0].path, '데이터베이스\\Oracle');
    const bad = await call('POST /tools/bm-folders/op', { body: { op: 'folder.remove', corp: 'vc-a', path: '데이터베이스', expect: 1 } });
    assert.equal(bad.statusCode, 409);
    const ok = await call('POST /tools/bm-folders/op', { body: { op: 'folder.remove', corp: 'vc-a', path: '데이터베이스', expect: 2 } });
    assert.equal(ok.statusCode, 200); assert.equal(ok.body.result.removed, 2); assert.equal(ok.body.result.rules, 1);
    const g = await call('GET /tools/bm-folders');
    assert.ok(g.body.servers.filter((x) => x.corp === 'vc-a').every((x) => !x.place));
    assert.equal(g.body.corps.find((c) => c.vcenterId === 'vc-a').folders.length, 0);
  });
});

test('라우트: ESXi 호스트는 찾기에서 고를 때만 · 넣으면 폴더 서버로 보인다 · 등록이 목록에서 사라지면 보류/없어짐 · 정리는 없어짐만', async () => {
  reset();
  const hosts = [{ id: 'h1', name: 'esx-db-01', vcenterId: 'vc-a', serviceTag: 'HTAG1', model: 'R760' }];
  await withSnap(async () => {
    const s0 = await call('GET /tools/bm-folders/search', { query: { inc: 'esx' } });
    assert.equal(s0.body.total, 0, '기본은 베어메탈만');
    const s1 = await call('GET /tools/bm-folders/search', { query: { inc: 'esx', kinds: 'bm,esxi' } });
    assert.equal(s1.body.total, 1); assert.equal(s1.body.rows[0].kind, 'esxi');
    await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'DB', keys: [s1.body.rows[0].key, 'st:tag2'] } });
    const g = await call('GET /tools/bm-folders');
    assert.ok(g.body.servers.some((x) => x.kind === 'esxi' && x.path === 'DB'));
  }, hosts);
  // 등록부에서 kr-db-02 가 빠짐 → 목록에 없는 등록
  registry.importServers([SRV('s1', 'kr-db-01', 'TAG1', 'vc-a')], 'replace');
  await withSnap(async () => {
    const g = await call('GET /tools/bm-folders');
    const miss = g.body.missing.find((x) => x.key === 'st:tag2');
    assert.ok(miss, JSON.stringify(g.body.missing));
    const blocked = g.body.blocked.n > 0;
    assert.equal(miss.state, blocked ? 'held' : 'ghost');
    const dry = await call('POST /tools/bm-folders/op', { body: { op: 'ghost.prune', dry: true } });
    assert.equal(dry.body.result.keys.includes('st:tag2'), !blocked, '보류는 정리 대상이 아니다');
    const pr = await call('POST /tools/bm-folders/op', { body: { op: 'ghost.prune', keys: ['st:tag2', 'st:tag1'] } });
    assert.equal(pr.body.result.removed, blocked ? 0 : 1, '미리 본 키 ∩ 지금 없어짐만 — 살아 있는 서버 키는 지우지 않는다');
  }, hosts);
});

test('라우트: 엣지가 보고한 베어메탈도 중앙에서 찾아 등록 · 받는 길은 엣지 · 엣지 이름은 전체 범위에만', async () => {
  reset();
  const prevCfg = { central: config.central, agent: config.agent };
  try {
    config.central = { ...(config.central || {}), token: 'tok-bmf' }; config.agent = { ...(config.agent || {}), centralUrl: '' };
    central.resetEdgeFleet();
    central.setEdgeFleet('pl-edge', [{ fleetId: 'etag9', name: 'pl-mes-db-09', serviceTag: 'ETAG9', vcenterId: 'vc-b', model: 'R740' }], Date.now());
    await withSnap(async () => {
      const s = await call('GET /tools/bm-folders/search', { query: { inc: 'mes' } });
      assert.equal(s.body.total, 1, JSON.stringify(s.body));
      assert.deepEqual([s.body.rows[0].src, s.body.rows[0].agent, s.body.rows[0].corp], ['edge', 'pl-edge', 'vc-b']);
      const a = await call('POST /tools/bm-folders/op', { body: { op: 'assign', path: 'MES', keys: [s.body.rows[0].key] } });
      assert.equal(a.body.result.added, 1);
      const g = await call('GET /tools/bm-folders');
      const c = g.body.corps.find((x) => x.vcenterId === 'vc-b');
      assert.equal(c.sources.edge, 1);
      assert.equal(c.agents[0].agent, 'pl-edge');
      const sc = await call('GET /tools/bm-folders', { user: { ...SCOPED, scope: { vcenters: ['vc-b'], regions: [], writeVcenters: [] } } });
      assert.equal(/pl-edge/.test(JSON.stringify(sc.body)), false, '범위 계정에는 엣지 이름을 싣지 않는다');
    });
  } finally { config.central = prevCfg.central; config.agent = prevCfg.agent; central.resetEdgeFleet(); }
});
