/**
 * test/focusMonGroup2982.test.js — v2.982 서버 집중 모니터링 '서버 그룹'(사용자 요청 2026-11-12 "등록된 서버를 그룹별로 분류해서 보는 기능 추가"
 *  → 시안 ⑫ · 컨펌 '구현해줘' = 기본값: 서버마다 그룹 하나 · 자동 묶기 제안 · 색 없음 · 다른 화면에도 그룹 단추).
 *  ① 등록부: 그룹 칸 정규화 · 만들기(글자 규칙 · 대소문자 무시 중복 · 상한 50) · 이름 바꾸기(서버도 함께 · 다른 그룹과 같은 이름 거절) ·
 *     지우기(서버는 그룹 없음 · 서버는 남는다) · 옮기기(있는 그룹만 · 없는 id 는 missing) · 추가 · 수정의 새 그룹 이름은 목록에 더한다(대소문자는 있는 표기로)
 *  ② CSV: 그룹 열이 있으면 바꾸고 · 없으면 그대로(예전 CSV 로 갱신해도 지워지지 않는다) · 새 그룹을 미리보기가 알린다 · 상한 · 내보내기 · 양식에 그룹 열
 *  ③ 라우트: 문(운영자 · 쓰기 범위 계정 · 데모 403) · 감사 · 데모 계정 판본에는 등록부 그룹 이름을 싣지 않는다 · 상태 코드
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmongroup2982-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-group-2982-xxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const svc = await import('../src/focusmon/service.js');
const registry = await import('../src/focusmon/registry.js');
const { auditEntriesWithAction } = await import('../src/audit.js');

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
  operator: { username: 'o', role: 'operator', scope: null },
  wscoped: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-x'] } },
  demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { svc.stopFocusMon(); srv.close(); });
async function call(method, p, { who = 'admin', body } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}
const FILE = path.join(DIR, 'focusmon-targets.json');
const reset = () => { fs.rmSync(FILE, { force: true }); registry._resetForTest(); };
const add = (name, host, group = '') => registry.addTarget({ name, host, port: 22, username: 'dvcmon', agent: '', group }, { agents: [] }).target;

test('① 그룹 — 만들기 · 이름 바꾸기 · 지우기 · 옮기기 · 추가의 새 이름 · 대소문자 · 저장 파일', () => {
  reset();
  assert.equal(registry.createGroup('WAS').ok, true);
  assert.equal(registry.createGroup('was').code, 'duplicate', '대소문자만 다른 이름은 같은 그룹');
  assert.equal(registry.createGroup('').code, 'bad-group');
  assert.equal(registry.createGroup('a/b').code, 'bad-group');
  assert.equal(registry.createGroup('x'.repeat(33)).code, 'bad-group', '32자까지');
  assert.equal(registry.createGroup('백업 · 파일').code, 'bad-group', '가운뎃점은 이름 글자가 아니다');
  assert.equal(registry.createGroup('백업 파일').ok, true);
  const a = add('web-01', '10.70.0.1', 'was'); // 있는 그룹은 그 표기로
  assert.equal(a.group, 'WAS');
  const b = add('db-01', '10.70.0.2', 'DB'); // 없는 이름은 목록에 더한다
  assert.equal(b.group, 'DB');
  assert.deepEqual(registry.listGroups(), [{ name: 'WAS', n: 1 }, { name: '백업 파일', n: 0 }, { name: 'DB', n: 1 }], '빈 그룹도 남고 · 순서는 만든 순서');
  const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.deepEqual(saved.groups, ['WAS', '백업 파일', 'DB']);
  assert.equal(registry.addTarget({ name: 'x', host: '10.70.0.3', port: 22, username: 'dvcmon', group: 'bad/name' }, { agents: [] }).code, 'bad-group');
  // 이름 바꾸기 — 서버도 함께 · 다른 그룹과 같은 이름은 거절
  const rn = registry.renameGroup('WAS', 'WEB');
  assert.equal(rn.ok, true); assert.equal(rn.moved, 1);
  assert.equal(registry.getTarget(a.id).group, 'WEB');
  assert.equal(registry.renameGroup('WEB', 'db').code, 'duplicate');
  assert.equal(registry.renameGroup('없는', 'x').code, 'not-found');
  // 옮기기 — 있는 그룹만 · 없는 id 는 missing · 같은 그룹은 same
  const mv = registry.setTargetsGroup([a.id, b.id, 'fm-0000000000'], 'DB');
  assert.deepEqual({ moved: mv.moved, same: mv.same, missing: mv.missing }, { moved: 1, same: 1, missing: 1 });
  assert.equal(registry.setTargetsGroup([a.id], '없는 그룹').code, 'not-found', '새 그룹은 먼저 만든다');
  // 지우기 — 서버는 그룹 없음 · 서버는 남는다
  const del = registry.deleteGroup('DB');
  assert.equal(del.ok, true); assert.equal(del.freed, 2);
  assert.equal(registry.getTarget(a.id).group, ''); assert.equal(registry.listTargets().length, 2);
  assert.deepEqual(registry.listGroups().map((g) => g.name), ['WEB', '백업 파일']);
  // 수정(PUT 과 같은 함수) — 그룹만 바꾸면 접속처는 그대로(moved false) · 바뀐 칸에 group
  const up = registry.updateTarget(a.id, { group: 'WEB' }, { agents: [] });
  assert.equal(up.moved, false); assert.deepEqual(up.changes.map((c) => c.k), ['group']);
});

test('① 상한 — 그룹은 50개까지(만들기 · 추가 · 수정 모두)', () => {
  reset();
  for (let i = 0; i < registry.MAX_GROUPS; i++) assert.equal(registry.createGroup(`g${i}`).ok, true);
  assert.equal(registry.createGroup('one-more').code, 'too-many-groups');
  assert.equal(registry.addTarget({ name: 'x', host: '10.71.0.1', port: 22, username: 'dvcmon', group: 'new-one' }, { agents: [] }).code, 'too-many-groups');
  const t = add('y', '10.71.0.2', 'g3');
  assert.equal(t.group, 'g3', '있는 그룹은 상한과 무관');
  assert.equal(registry.updateTarget(t.id, { group: 'brand-new' }, { agents: [] }).code, 'too-many-groups');
});

test('② CSV — 그룹 열이 있으면 바꾸고 · 없으면 그대로 · 새 그룹 알림 · 내보내기 · 양식', () => {
  reset();
  registry.createGroup('WAS');
  const t = add('was-01', '10.72.0.1', 'WAS');
  // 그룹 열이 없는 예전 CSV 로 갱신해도 그룹이 지워지지 않는다
  const old = registry.planCsv('이름,IP,포트,계정\nwas-01-renamed,10.72.0.1,22,dvcmon\n', { agents: [] });
  assert.equal(old.groupColumn, false);
  assert.equal(old.rows[0].action, 'update'); assert.deepEqual(old.rows[0].changes, ['name']);
  assert.equal(registry.applyCsv('이름,IP,포트,계정\nwas-01-renamed,10.72.0.1,22,dvcmon\n', { agents: [] }).updated, 1);
  assert.equal(registry.getTarget(t.id).group, 'WAS', '그룹 열이 없으면 그대로');
  // 그룹 열 — 바꾸기 · 빈 칸 = 그룹 없음 · 새 그룹 · 대소문자는 있는 표기로
  const csv = '이름,IP,포트,계정,담당 노드,그룹\nwas-01,10.72.0.1,22,dvcmon,중앙,was\nnew-01,10.72.0.2,22,dvcmon,중앙,DB\nnew-02,10.72.0.3,22,dvcmon,중앙,\n';
  const p = registry.planCsv(csv, { agents: [] });
  assert.equal(p.groupColumn, true);
  assert.deepEqual(p.newGroups, ['DB'], 'was 는 있는 WAS · DB 는 새 그룹');
  assert.equal(p.rows[0].value.group, 'WAS');
  const ap = registry.applyCsv(csv, { agents: [] });
  assert.equal(ap.ok, true);
  assert.deepEqual(registry.listGroups().map((g) => [g.name, g.n]), [['WAS', 1], ['DB', 1]]);
  const ex = registry.exportRows();
  assert.deepEqual(ex[0], ['이름', 'IP', '포트', '계정', '담당 노드', '그룹']);
  assert.ok(ex.some((r) => r[0] === 'new-01' && r[5] === 'DB'));
  assert.ok(ex.some((r) => r[0] === 'new-02' && r[5] === ''));
  assert.equal(registry.csvTemplateRows()[0][5], '그룹');
  // 내보낸 것을 다시 가져오면 모두 그대로
  const round = registry.planCsv(ex.map((r) => r.join(',')).join('\n'), { agents: [] });
  assert.equal(round.counts.same, 3); assert.equal(round.counts.update, 0);
  // 머리글 별칭
  assert.equal(registry.csvHeaderMap(['이름', 'IP', '분류']).group, 2);
  // 상한 — 새 그룹으로 넘치면 적용 거절
  reset();
  for (let i = 0; i < registry.MAX_GROUPS; i++) registry.createGroup(`g${i}`);
  const over = registry.applyCsv('이름,IP,계정,그룹\nz,10.72.1.1,dvcmon,zz\n', { agents: [] });
  assert.equal(over.code, 'too-many-groups');
});

test('③ 라우트 — 문 · 상태 코드 · 감사 · 목록 응답 · 데모 계정에는 등록부 그룹 이름 없음', async () => {
  reset();
  const t = add('rt-01', '10.73.0.1');
  for (const who of ['operator', 'wscoped', 'demo']) {
    assert.equal((await call('POST', '/api/tools/focus-mon/groups', { who, body: { name: 'X' } })).status, 403, who);
    assert.equal((await call('POST', '/api/tools/focus-mon/targets/group', { who, body: { ids: [t.id], group: '' } })).status, 403, who);
  }
  const c = await call('POST', '/api/tools/focus-mon/groups', { body: { name: '운영 DB' } });
  assert.equal(c.status, 200, c.text);
  assert.equal((await call('POST', '/api/tools/focus-mon/groups', { body: { name: '운영 db' } })).status, 409);
  assert.equal((await call('POST', '/api/tools/focus-mon/groups', { body: { name: '<x>' } })).status, 400);
  const mv = await call('POST', '/api/tools/focus-mon/targets/group', { body: { ids: [t.id], group: '운영 DB' } });
  assert.equal(mv.status, 200, mv.text); assert.equal(mv.body.moved, 1);
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/group', { body: { ids: [], group: '' } })).status, 400);
  assert.equal((await call('POST', '/api/tools/focus-mon/targets/group', { body: { ids: [t.id], group: '없음' } })).status, 404);
  const rn = await call('PUT', `/api/tools/focus-mon/groups/${encodeURIComponent('운영 DB')}`, { body: { name: 'OPS-DB' } });
  assert.equal(rn.status, 200, rn.text);
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  const dbg = main.groups.list.find((g) => g.name === 'OPS-DB');
  assert.deepEqual({ n: dbg.n, own: dbg.own }, { n: main.targets.filter((x) => x.group === 'OPS-DB').length, own: true }, '목 모드 데모 서버의 등록부 그룹이라 own');
  assert.ok(main.groups.list.some((g) => g.name === 'WAS' && g.own === false), '목 모드 데모 서버의 그룹도 보이되 own false(이름 바꾸기 · 지우기 없음)');
  for (const g of main.groups.list) assert.ok(registry.GROUP_RE.test(g.name), `데모 그룹 이름도 글자 규칙(${g.name})`);
  assert.equal(main.targets.find((x) => x.id === t.id).group, 'OPS-DB');
  const dm = (await call('GET', '/api/tools/focus-mon', { who: 'demo' })).body;
  assert.ok(!dm.groups.list.some((g) => g.name === 'OPS-DB'), '데모 계정에는 등록부 그룹 이름(OPS-DB)을 싣지 않는다');
  assert.ok(dm.groups.list.every((g) => g.own === false));
  const del = await call('DELETE', `/api/tools/focus-mon/groups/${encodeURIComponent('OPS-DB')}`);
  assert.equal(del.status, 200); assert.equal(del.body.freed, 1);
  assert.equal((await call('DELETE', `/api/tools/focus-mon/groups/${encodeURIComponent('OPS-DB')}`)).status, 404);
  const acts = ['focus-mon.group.add', 'focus-mon.group.move', 'focus-mon.group.rename', 'focus-mon.group.remove'].map((a) => auditEntriesWithAction(a).length);
  assert.ok(acts.every((n) => n >= 1), `감사 ${acts.join(',')}`);
  // 수정 라우트로 그룹만 바꾸면 접속처는 그대로 · 감사에 그룹
  registry.createGroup('WEB');
  const up = await call('PUT', `/api/tools/focus-mon/targets/${t.id}`, { body: { group: 'WEB' } });
  assert.equal(up.status, 200, up.text); assert.equal(up.body.moved, false); assert.equal(up.body.cleared, false);
  assert.match(auditEntriesWithAction('focus-mon.target.update').map((e) => e.detail || '').join('\n'), /그룹 그룹 없음 → WEB/);
});

test('④ 문은 그룹 라우트 넷 모두 · 등록부 손상이면 넷 모두 503 registryUnreadable(파일은 그대로) · 저장 파일의 이상한 그룹 이름은 읽을 때 버린다', async () => {
  reset();
  const t = add('gate-01', '10.74.0.1');
  registry.createGroup('G1');
  const routes = [
    ['POST', '/api/tools/focus-mon/groups', { name: 'X' }],
    ['PUT', `/api/tools/focus-mon/groups/${encodeURIComponent('G1')}`, { name: 'G2' }],
    ['DELETE', `/api/tools/focus-mon/groups/${encodeURIComponent('G1')}`, undefined],
    ['POST', '/api/tools/focus-mon/targets/group', { ids: [t.id], group: 'G1' }],
  ];
  for (const who of ['operator', 'wscoped', 'demo']) {
    for (const [m, p, body] of routes) assert.equal((await call(m, p, { who, body })).status, 403, `${who} ${m} ${p}`);
  }
  assert.deepEqual(registry.listGroups(), [{ name: 'G1', n: 0 }], '거절된 요청은 아무것도 바꾸지 않았다');
  // 손상 — 라우트가 먼저 503 registryUnreadable(등록부 함수의 거절에만 기대지 않는다) · 보존본 · 원본을 덮지 않는다
  fs.writeFileSync(FILE, '{ broken');
  registry._resetForTest();
  for (const [m, p, body] of routes) {
    const r = await call(m, p, { body });
    assert.equal(r.status, 503, `${m} ${p} ${r.text}`);
    assert.equal(r.body.reason, 'registryUnreadable', `${m} ${p}`);
  }
  assert.ok(fs.readdirSync(DIR).some((f) => f.startsWith('focusmon-targets.json.corrupt')), '손상 보존본');
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('focusmon-targets.json.corrupt')) fs.rmSync(path.join(DIR, f));
  // 손으로 고친 파일 — 글자 규칙에 맞지 않는 그룹 이름은 '그룹 없음' · 목록에서도 뺀다
  fs.writeFileSync(FILE, JSON.stringify({ targets: [
    { id: 'fm-aaaaaaaa01', name: 'a', host: '10.74.0.2', port: 22, username: 'u', agent: '', group: '<script>' },
    { id: 'fm-bbbbbbbb02', name: 'b', host: '10.74.0.3', port: 22, username: 'u', agent: '', group: ' OK ' },
  ], groups: ['a/b', '-x', 'OK', 'ok', 'y'.repeat(40)] }));
  registry._resetForTest();
  assert.deepEqual(registry.listTargets().map((x) => x.group), ['', 'OK'], '이상한 이름은 그룹 없음 · 앞뒤 공백은 자른다');
  assert.deepEqual(registry.listGroups().map((g) => g.name), ['OK'], '목록도 같은 규칙 · 대소문자만 다른 이름은 하나 · 32자 넘으면 버린다');
  reset();
});
