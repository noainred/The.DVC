/**
 * 리눅스 성능 6단계 — 운영 주석(설계 PROFILES §16 A). 고정하는 규약(security-api.md 6단계):
 *   ① 형식(순수): 내용 정제(제어 · 양방향 · 폭 없는 문자) · 연결 형식(이슈 · 위키 · 집중) · 시각 범위
 *   ② 실제 api 라우터: 쓰기 operator 이상 · 조회 밖 404 → 쓰기 밖 403(조건 없이) · 법인 전체 주석도 같은 규칙 · 읽기는 법인이 전부 범위 안일 때만 ·
 *      고치기 · 지우기는 작성자 · 관리자 · 지우기는 흔적(내용 · 연결 지움) · 감사 · 비관리자 주소 가림
 *   ③ 동시 쓰기 유실 없음(한 동기 구간) · 손상 503 + 보존 + 쓰기 거부 ④ 집중 시작 → 자동 주석(작성자 system · 집중 세션 연결)
 * 기준 시각: 정시 −30분(v2.517 규약).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bms6an-'));
process.env.CONFIG_DIR = DIR;
process.env.AUTH_ENABLED = 'true';
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 2, matrix: { operator: ['dashboard', 'tools'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } } }));
delete process.env.CENTRAL_URL;
test.after(() => fs.rmSync(DIR, { recursive: true, force: true }));
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;
let sqlite = true; try { await import('node:sqlite'); } catch { sqlite = false; }
const A = await import('../src/bmusage/annotations.js');

test('① 형식 — 내용 정제 · 연결 · 시각', () => {
  assert.equal(A.cleanText('  pg_dump\u0000 수동\u202e 실행\u200b\r\n\n\n\n끝  '), 'pg_dump 수동 실행\n\n끝');
  assert.equal(A.cleanText('x'.repeat(900)).length, A.TEXT_MAX);
  assert.deepEqual(A.cleanLinks({ issue: 'ISS-12', wiki: { space: 'pub', id: 'W3' }, focus: 'ab12-cd34' }), { issue: 'ISS-12', wiki: { space: 'pub', id: 'W3' }, focus: 'ab12-cd34' });
  assert.throws(() => A.cleanLinks({ issue: 'https://evil' }), /ISS/);
  assert.throws(() => A.cleanLinks({ wiki: { space: '../x', id: 'W1' } }), /위키/);
  assert.throws(() => A.cleanLinks('x'), /연결/);
  assert.throws(() => A.cleanSpan({ at: NOW - 500 * 86_400_000, now: NOW }), /범위/);
  assert.throws(() => A.cleanSpan({ at: NOW, end: NOW - 1, now: NOW }), /끝/);
  assert.throws(() => A.cleanSpan({ at: NOW, end: NOW + 40 * 86_400_000, now: NOW }), /끝/);
  assert.deepEqual(A.cleanSpan({ at: NOW, end: NOW + HOUR, now: NOW }), { at: NOW, end: NOW + HOUR });
});

async function setup(t) {
  fs.writeFileSync(path.join(DIR, 'idrac.json'), JSON.stringify({ servers: [{ id: 'ip-1', name: '10.9.8.7', host: '10.9.8.7', username: 'root', password: 'p' }] }));
  fs.writeFileSync(path.join(DIR, 'bm-storage.json'), JSON.stringify({ servers: [
    { id: 'o-a1', name: 'bm-a1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
    { id: 'o-b1', name: 'bm-b1', host: '127.0.0.1', port: 9, username: 'mon', password: 'pw', mounts: [] },
  ] }));
  fs.writeFileSync(path.join(DIR, 'bmusage-settings.json'), JSON.stringify({ enabled: true, corps: { vcA: true, vcB: true }, osSsh: true, idracTelemetry: true }));
  const poller = await import('../src/bmusage/poller.js');
  poller._setFleetForTest(async () => ({ bareMetal: [
    { serverId: 's-a1', name: 'bm-a1', serviceTag: 'ATAGA1', vcenterId: 'vcA' },
    { serverId: 's-b1', name: 'bm-b1', serviceTag: 'ATAGB1', vcenterId: 'vcB' },
    { serverId: 'ip-1', name: '10.9.8.7', serviceTag: 'ATAGIP', vcenterId: 'vcA' },
  ], virtualizationHosts: [] }));
  (await import('../src/bmusage/settings.js'))._resetForTest();
  const { store } = await import('../src/store.js');
  const snap0 = store.get();
  store.set?.({ ...snap0, vcenters: [{ id: 'vcA', name: 'A' }, { id: 'vcB', name: 'B' }] });
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const USERS = {
    viewer: { username: 'v', role: 'viewer', scope: null },
    opA: { username: 'opa', role: 'operator', scope: { vcenters: ['vcA'] } },
    opA2: { username: 'opa2', role: 'operator', scope: { vcenters: ['vcA'] } },
    rw: { username: 'rw', role: 'admin', scope: { vcenters: [], writeVcenters: ['vcA'] } },
    adm: { username: 'adm', role: 'admin', scope: null },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.close(); poller._setFleetForTest(null); });
  const base = `http://127.0.0.1:${srv.address().port}/api/tools/bm-usage`;
  const call = async (u, method, p, body) => { const r = await fetch(`${base}${p}`, { method, headers: { 'x-u': u, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: r.status, body: await r.json() }; };
  return { call };
}

test('② 실제 라우터 — 권한 · 범위 · 작성자 · 흔적 · 감사 · 가림', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const mk = (keys, extra = {}) => ({ keys, at: NOW - HOUR, end: NOW, kind: 'work', text: 'pg_dump 수동 실행(OPS-2231)', links: { issue: 'ISS-12' }, ...extra });
  assert.equal((await call('viewer', 'POST', '/annotations', mk(['ATAGA1']))).status, 403, 'viewer 403');
  const c1 = await call('opA', 'POST', '/annotations', mk(['ATAGA1']));
  assert.equal(c1.status, 200, JSON.stringify(c1.body));
  assert.equal((await call('opA', 'POST', '/annotations', mk(['ATAGB1']))).status, 404, '조회 밖 404');
  assert.equal((await call('rw', 'POST', '/annotations', mk(['ATAGB1']))).status, 403, '조회 무제한 + 쓰기 vcA 만 → vcB 403');
  assert.equal((await call('rw', 'POST', '/annotations', mk(['ATAGA1', 'ATAGB1']))).status, 403, '하나라도 쓰기 밖이면 403');
  assert.equal((await call('opA', 'POST', '/annotations', { corp: 'vcB', at: NOW, kind: 'external', text: 'UPS' })).status, 404, '법인 전체 — 조회 밖 404');
  assert.equal((await call('rw', 'POST', '/annotations', { corp: 'vcB', at: NOW, kind: 'external', text: 'UPS' })).status, 403, '법인 전체 — 쓰기 밖 403');
  assert.equal((await call('opA', 'POST', '/annotations', mk(['ATAGA1'], { kind: 'evil' }))).status, 400);
  assert.equal((await call('opA', 'POST', '/annotations', mk(['ATAGA1'], { links: { issue: 'javascript:x' } }))).status, 400);
  const both = await call('adm', 'POST', '/annotations', mk(['ATAGA1', 'ATAGB1'], { text: '두 법인 걸친 작업' }));
  assert.equal(both.status, 200);
  const ipn = await call('adm', 'POST', '/annotations', mk(['ATAGIP'], { text: 'IP 이름 서버' }));
  assert.equal(ipn.status, 200);
  const corp = await call('adm', 'POST', '/annotations', { corp: 'vcA', at: NOW - 2 * HOUR, kind: 'external', text: '전산실 B열 UPS 전압 저하' });
  assert.equal(corp.status, 200);
  // 읽기 — 범위 계정은 법인이 전부 범위 안인 것만(두 법인 걸친 주석은 안 보인다) · 법인 전체 주석은 그 법인 서버에 보인다
  const r1 = await call('opA', 'GET', `/annotations?keys=ATAGA1&from=${NOW - 3 * HOUR}&to=${NOW + HOUR}`);
  assert.equal(r1.status, 200);
  const texts = r1.body.annotations.map((x) => x.text).sort();
  assert.deepEqual(texts, ['pg_dump 수동 실행(OPS-2231)', '전산실 B열 UPS 전압 저하'].sort(), JSON.stringify(texts));
  assert.equal(r1.body.annotations.find((x) => x.target.type === 'server').target.includes[0], 'ATAGA1');
  const rAdm = await call('adm', 'GET', '/annotations?keys=ATAGA1');
  assert.ok(rAdm.body.annotations.some((x) => x.text === '두 법인 걸친 작업'), '전체 범위는 보인다');
  const rIp = await call('opA', 'GET', '/annotations?keys=ATAGIP');
  assert.ok(rIp.body.annotations.every((x) => !x.target.names.includes('10.9.8.7')), '비관리자 — 주소 이름 가림');
  // 고치기 · 지우기 — 작성자 · 관리자만
  const id = c1.body.id;
  assert.equal((await call('opA2', 'PUT', `/annotations/${id}`, { text: '남의 글' })).status, 403, '작성자 아님');
  assert.equal((await call('opA', 'PUT', `/annotations/${both.body.id}`, { text: 'x' })).status, 404, '보이지 않는 주석은 404');
  const e1 = await call('opA', 'PUT', `/annotations/${id}`, { text: '고친 내용', kind: 'change' });
  assert.equal(e1.status, 200);
  const r2 = await call('adm', 'GET', '/annotations?keys=ATAGA1');
  const got = r2.body.annotations.find((x) => x.id === id);
  assert.equal(got.text, '고친 내용'); assert.equal(got.kind, 'change'); assert.deepEqual(got.edits[0].fields.sort(), ['kind', 'text']);
  assert.equal((await call('opA2', 'DELETE', `/annotations/${id}`)).status, 403);
  assert.equal((await call('opA', 'DELETE', `/annotations/${id}`)).status, 200);
  const g2 = (await call('adm', 'GET', '/annotations?keys=ATAGA1')).body.annotations.find((x) => x.id === id);
  assert.equal(g2.text, '', '지우면 내용은 지운다'); assert.equal(g2.deleted.by, 'opa', '흔적은 남는다'); assert.deepEqual(g2.links, {});
  assert.equal((await call('opA', 'PUT', `/annotations/${id}`, { text: '되살리기' })).status, 404, '지운 주석은 고칠 수 없다');
  const audit = await import('../src/audit.js');
  const acts = audit.auditEntriesWithAction('bm-perf.annotation');
  assert.ok(['create', 'edit', 'delete'].every((op) => acts.some((a) => (a.detail || '').includes(`"op":"${op}"`))), '감사 — 만들기 · 고치기 · 지우기');
});

test('③ 동시 쓰기 유실 없음 · 손상 503 + 보존 + 쓰기 거부', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const before = (await call('adm', 'GET', '/annotations')).body.annotations.length;
  const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => call('opA', 'POST', '/annotations', { keys: ['ATAGA1'], at: NOW - i * 60_000, kind: 'memo', text: `동시 ${i}` })));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.body.id)).size, 20, 'id 겹침 없음');
  assert.equal((await call('adm', 'GET', '/annotations')).body.annotations.length, before + 20, '20건 전부 남는다');
  fs.writeFileSync(path.join(DIR, 'bm-perf-annotations.json'), '{"items": [ broken');
  assert.equal((await call('adm', 'GET', '/annotations')).status, 503);
  assert.ok(fs.readdirSync(DIR).some((x) => x.startsWith('bm-perf-annotations.json.corrupt')), '손상본 보존');
  assert.equal((await call('opA', 'POST', '/annotations', { keys: ['ATAGA1'], at: NOW, kind: 'memo', text: '손상 뒤' })).status, 503, '못 읽은 동안 쓰기 거부(빈 목록으로 덮지 않는다)');
  const { confirmSettingsDefault } = await import('../src/util/settingsLoadError.js');
  assert.equal(confirmSettingsDefault('bm-perf-annotations.json', { by: 'adm' }).ok, true, '관리자가 확정하면 풀린다');
});

test('④ 집중 시작 → 자동 주석(system · 세션 연결)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const F = await import('../src/bmusage/focus/run.js');
  F._resetFocusForTest();
  F._setFocusDepsForTest({ loadRules: async () => ({ focus: { intervalS: 60, durationMin: 1, corpMax: 5, nodeMax: 10 }, daily: { manualFocus: 20 } }),
    osAuthStop: async () => null, idracAuthStop: async () => null, collectOs: async () => ({ ok: true }), idracJob: async () => null, prevFor: async () => null,
    recordOsAuth: async () => {}, recordIdracAuth: async () => {}, buildUsage: async () => ({ row: {}, next: {} }), buildEntry: async () => ({ verdict: 'ok' }),
    hwReader: async () => () => null, rawBefore: async () => ({ rows: [] }), setTimer: () => ({}), clearTimer: () => {} });
  t.after(() => F._resetFocusForTest());
  const r = await call('opA', 'POST', '/perf/ATAGA1/focus', { reason: '디스크 포화 판정 뒤' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const list = (await call('opA', 'GET', '/annotations?keys=ATAGA1')).body.annotations;
  const auto = list.find((x) => x.auto === 'focus');
  assert.ok(auto, '자동 주석'); assert.equal(auto.by, 'system'); assert.equal(auto.links.focus, r.body.id); assert.match(auto.text, /디스크 포화/);
  assert.equal(auto.canEdit, false, '시스템 주석은 운영자가 고칠 수 없다');
});

test('⑤ 반증 F10 · F11 · F13 — 고치기는 보낸 칸만(집중 연결 · 원래 시각 보존) · 엣지 호스트명 가림 · 저장소 캐시(mtime · 실패 시 버림)', async (t) => {
  if (!sqlite) return t.skip('node:sqlite 없음');
  const { call } = await setup(t);
  const A = await import('../src/bmusage/annotations.js');
  // F10 — 자동 주석 모양(links.focus · 초가 있는 시각)을 관리자가 내용만 고친다(웹의 실제 본문 생성 함수와 같은 규칙 — 바뀐 칸만)
  const at0 = NOW - HOUR + 37_123;
  const rec = A.addAnnotation({ by: 'system', at: at0, kind: 'work', text: '집중 모니터링 시작', target: { type: 'server', keys: ['ATAGA1'], names: ['bm-a1'], vcenterIds: ['vcA'] }, links: { focus: 'a1b2c3d4-0000-1111' }, auto: 'focus' });
  const e = await call('adm', 'PUT', `/annotations/${rec.id}`, { text: '집중 모니터링 시작(오타 수정)' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  const g = A.getAnnotation(rec.id);
  assert.equal(g.links.focus, 'a1b2c3d4-0000-1111', '집중 세션 연결이 남는다'); assert.equal(g.at, at0, '원래 시각(초 포함) 그대로'); assert.deepEqual(g.edits.at(-1).fields, ['text']);
  // 연결은 칸별 병합 — 이슈만 더하고 · null 로 그 칸만 지운다
  await call('adm', 'PUT', `/annotations/${rec.id}`, { links: { issue: 'ISS-7' } });
  assert.deepEqual(A.getAnnotation(rec.id).links, { focus: 'a1b2c3d4-0000-1111', issue: 'ISS-7' });
  await call('adm', 'PUT', `/annotations/${rec.id}`, { links: { issue: null } });
  assert.deepEqual(A.getAnnotation(rec.id).links, { focus: 'a1b2c3d4-0000-1111' });
  // F11 — 엣지 위임 서버의 호스트명 이름은 비관리자 목록에서 가린다(비교 화면과 같은 판정기)
  const E = await import('../src/central/bmUsageEdgePull.js');
  E.putEdgeBmUsage('edge-ann', { ok: true, snap: { node: { agent: 'edge-ann' }, enabled: true, targets: [{ key: 'EK1', name: 'db01.corp.example', osHostName: 'db01.corp.example', vcenterId: 'vcA' }], rows: [] } });
  t.after(() => E._resetForTest());
  const ek = await call('adm', 'POST', '/annotations', { keys: ['EK1'], at: NOW, kind: 'memo', text: '엣지 서버 주석' });
  assert.equal(ek.status, 200, JSON.stringify(ek.body));
  const asOp = (await call('opA', 'GET', '/annotations?keys=EK1')).body.annotations.find((x) => x.id === ek.body.id);
  assert.ok(asOp, '범위 안 엣지 서버 주석'); assert.ok(!asOp.target.names.some((nm) => nm.includes('db01.corp.example')), JSON.stringify(asOp.target.names));
  assert.ok((await call('adm', 'GET', '/annotations?keys=EK1')).body.annotations.find((x) => x.id === ek.body.id).target.names.includes('db01.corp.example'), '관리자는 원문');
  // F13 — 읽기는 캐시(같은 배열) · 파일이 바뀌면 다시 읽는다 · 검사 실패로 고치다 만 값이 캐시에 남지 않는다
  const l1 = A.listAnnotations(); const l2 = A.listAnnotations();
  assert.equal(l1, l2, 'mtime · 크기가 같으면 파싱하지 않는다(같은 배열)');
  assert.throws(() => A.editAnnotation(rec.id, { kind: 'memo', text: '   ' }), /내용/);
  assert.equal(A.getAnnotation(rec.id).kind, 'work', '400 으로 끝난 고치기의 앞 칸(kind) 변경이 남지 않는다');
  const f = path.join(DIR, 'bm-perf-annotations.json');
  const o = JSON.parse(fs.readFileSync(f, 'utf8')); o.items = o.items.filter((x) => x.id !== rec.id);
  fs.writeFileSync(f, JSON.stringify(o)); const st = fs.statSync(f); fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 5_000));
  assert.equal(A.getAnnotation(rec.id), null, '파일이 바뀌면(손으로 고침) 다시 읽는다');
  // 이력의 이전 내용은 앞 120자만(파일 크기)
  const long = A.addAnnotation({ by: 'adm', at: NOW, kind: 'memo', text: 'ㄱ'.repeat(500), target: { type: 'server', keys: ['ATAGA1'], names: [], vcenterIds: ['vcA'] } });
  A.editAnnotation(long.id, { text: '짧게' }, { by: 'adm' });
  assert.equal(A.getAnnotation(long.id).edits.at(-1).prev.text.length, 120);
});
