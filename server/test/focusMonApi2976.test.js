/**
 * test/focusMonApi2976.test.js — v2.976 집중 모니터링의 **실제 api · central 라우터**(데모 모드 — 데모 대상 20대가 SSH 없이 같은 모양의 표본을 낸다).
 *  ⑨ 권한: 조회 = admin + 전체 범위(operator 403 · 범위 계정 403) · 쓰기 = + 조회·쓰기 전체 범위(writeVcenters 계정 403) · 데모 계정 쓰기 403 · CSV = data.csv
 *  ⑨ 등록 검사: IPv4 정규형만(010.x · 호스트 이름 거부) · 루프백 · 링크로컬 거부 · 모르는 엣지 거부 · 중복 거부 · 응답에 비밀 칸 없음
 *  ⑨ 보기 4종(개요 · 비교 · 서버 상세 · iostat 비교) · 프로세스 · 기록이 있는 시간 · 없는 대상 404 · 등록부 손상 503
 *  ⑩ central: 공유 토큰 403 · 개별 토큰 200 · 응답 목록에 비밀 0
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonapi2976-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-api-2976';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-api-2976-xxxxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { centralRouter } = await import('../src/routes/central.js');
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const svc = await import('../src/focusmon/service.js');
const registry = await import('../src/focusmon/registry.js');
const store = await import('../src/focusmon/store.js');
const { toolKeyForPath } = await import('../src/auth/toolAccess.js').catch(() => ({}));

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
  operator: { username: 'o', role: 'operator', scope: null },
  scoped: { username: 's', role: 'admin', scope: { vcenters: ['vc-x'] } },
  wscoped: { username: 'w', role: 'admin', scope: { writeVcenters: ['vc-x'] } },
  demo: { username: 'thedvcdemp', role: 'admin', scope: null, demoGuest: true },
};
const app = express();
app.use(express.json({ limit: '16mb' }));
app.use('/api/central', centralRouter);
app.use((req, _res, next) => { req.user = users[req.headers['x-test-user'] || 'admin']; next(); });
app.use('/api', api);
const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
const base = `http://127.0.0.1:${srv.address().port}`;
after(() => { svc.stopFocusMon(); srv.close(); });

async function call(method, p, { who = 'admin', body, headers = {} } = {}) {
  const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'x-test-user': who, ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, body: json, text };
}

test('⑨ 도구 키 집행 — 경로 첫 세그먼트 focus-mon = 도구 키', () => {
  assert.equal(toolKeyForPath('/focus-mon/data'), 'focus-mon', '/api/tools 아래 경로(toolGate 가 /tools 를 뗀 뒤)');
  assert.equal(toolKeyForPath('/focus-mon/export.csv'), 'focus-mon');
});

test('⑨ 조회 권한 — admin 200 · operator 403 · 범위 계정 403', async () => {
  const a = await call('GET', '/api/tools/focus-mon');
  assert.equal(a.status, 200);
  assert.equal(a.body.mock, true);
  assert.equal(a.body.targets.filter((t) => t.demo).length, 20, '데모 대상 20대');
  assert.deepEqual(a.body.limits.windows, [1, 5, 10, 30], '화면은 구간을 응답에서 읽는다');
  assert.equal((await call('GET', '/api/tools/focus-mon', { who: 'operator' })).status, 403);
  assert.equal((await call('GET', '/api/tools/focus-mon', { who: 'scoped' })).status, 403);
  assert.ok(!a.text.includes('PRIVATE KEY'), '응답에 개인키 없음');
  // 데이터 경로도 같은 게이트 — 메인만 막고 /data · /procs · /coverage · CSV 를 열어 두면 범위 계정이 전 법인 서버 값을 읽는다(변이 M4).
  for (const p of ['/api/tools/focus-mon/data?view=overview&targets=fm-d0000000', '/api/tools/focus-mon/procs?targets=fm-d0000000',
    '/api/tools/focus-mon/coverage?targets=fm-d0000000', '/api/tools/focus-mon/export.csv?kind=series&targets=fm-d0000000&metric=cpu&item=pct']) {
    assert.equal((await call('GET', p, { who: 'scoped' })).status, 403, `범위 계정 ${p}`);
    assert.equal((await call('GET', p, { who: 'operator' })).status, 403, `운영자 ${p}`);
  }
});

test('⑨ 등록 검사 — IPv4 정규형 · 루프백 · 모르는 엣지 · 중복 · 쓰기 권한', async () => {
  const add = (body, who) => call('POST', '/api/tools/focus-mon/targets', { who, body });
  assert.equal((await add({ name: 'x', host: '010.1.1.1', username: 'u' })).body.code, 'bad-host');
  assert.equal((await add({ name: 'x', host: 'db01.corp', username: 'u' })).body.code, 'bad-host');
  assert.equal((await add({ name: 'x', host: '127.0.0.1', username: 'u' })).body.code, 'blocked-host');
  assert.equal((await add({ name: 'x', host: '169.254.169.254', username: 'u' })).body.code, 'blocked-host');
  assert.equal((await add({ name: 'x', host: '10.1.1.1', username: '-oProxyCommand=x' })).body.code, 'bad-user');
  assert.equal((await add({ name: 'x', host: '10.1.1.1', username: 'u', agent: 'no-such-edge' })).body.code, 'bad-agent');
  assert.equal((await add({ name: 'x', host: '10.1.1.1', username: 'u' }, 'wscoped')).status, 403, '쓰기 범위가 좁으면 403');
  assert.equal((await add({ name: 'x', host: '10.1.1.1', username: 'u' }, 'demo')).status, 403, '데모 계정 쓰기 403');
  const ok = await add({ name: 'db-01', host: '10.1.1.1', port: 2222, username: 'dvcmon', password: 'secret!' });
  assert.equal(ok.status, 200);
  assert.ok(!('password' in ok.body.target), '비밀 칸은 받지도 저장하지도 않는다');
  assert.ok(!fs.readFileSync(path.join(DIR, 'focusmon-targets.json'), 'utf8').includes('secret!'));
  assert.equal((await add({ name: 'db-01b', host: '10.1.1.1', port: 2222, username: 'dvcmon' })).body.code, 'duplicate');
  const csv = await call('POST', '/api/tools/focus-mon/targets/import', { body: { text: '이름,IP,포트,계정,담당\nweb-1,10.2.2.2,22,dvcmon,중앙\nweb-2,10.2.2.300,22,dvcmon,' } });
  assert.equal(csv.status, 400);
  assert.equal(csv.body.errors[0].line, 2, '틀린 줄이 있으면 하나도 넣지 않는다');
  assert.equal(registry.listTargets().length, 1);
});

test('⑨ 수집 시작 — 상한 · 없는 대상 404 · 보기 4종 · 프로세스 · 기록이 있는 시간 · 끝', async () => {
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  const demo = main.targets.filter((t) => t.demo).map((t) => t.id);
  assert.equal((await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: [...demo, 'fm-0000000000'] } })).status, 404);
  assert.equal((await call('POST', '/api/tools/focus-mon/sessions', { who: 'wscoped', body: { targets: demo.slice(0, 2) } })).status, 403);
  const st = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: demo, interval: 1, mode: 'watch' } });
  assert.equal(st.status, 200, JSON.stringify(st.body));
  const sid = st.body.session.id;
  svc.startFocusMon();
  await new Promise((r) => setTimeout(r, 6_500));
  const q = `targets=${demo.slice(0, 3).join(',')}`;
  const ov = await call('GET', `/api/tools/focus-mon/data?view=overview&win=1&${q}`);
  assert.equal(ov.status, 200);
  assert.equal(ov.body.targets.length, 3);
  assert.ok(ov.body.targets[0].n >= 3, '1초 표본이 쌓였다');
  assert.ok(ov.body.targets[0].series.cpu.some((v) => v != null));
  const cmp = await call('GET', `/api/tools/focus-mon/data?view=compare&metric=disk&item=wAwait&scope=all&win=1&${q}`);
  assert.equal(cmp.body.targets[0].key, 't.wAwait');
  // points 는 칸 수의 상한이다 — 실제 칸 수는 표본 간격의 1.5배 폭으로 줄어든다(query.js bucketize · 빈 칸으로 선이 끊기지 않게).
  const len = cmp.body.targets[0].avg.length;
  assert.ok(len >= 1 && len <= cmp.body.points, `칸 수 ${len} / 상한 ${cmp.body.points}`);
  const sd = await call('GET', `/api/tools/focus-mon/data?view=server&win=1&targets=${demo[8]}`);
  assert.ok(sd.body.table.dsk.length >= 10 && sd.body.table.net.some((x) => x.k === 'bond'), '본딩 · 디스크 · 파티션 · LVM');
  const avg = await call('GET', `/api/tools/focus-mon/data?view=server&win=1&at=avg&targets=${demo[8]}`);
  assert.equal(avg.body.at, 'avg');
  const io = await call('GET', `/api/tools/focus-mon/data?view=iostat&win=1&${q}&pins=${demo[0]}/sdb`);
  assert.equal(io.body.rows.length, 3);
  assert.equal(io.body.rows[0].devices[0].v.length, 13, 'iostat 13칸');
  assert.equal(io.body.series.length, 1);
  const pr = await call('GET', `/api/tools/focus-mon/procs?win=1&${q}`);
  assert.equal(pr.body.top.length, 30);
  assert.equal(pr.body.usersMasked, false);
  const prd = await call('GET', `/api/tools/focus-mon/procs?win=1&${q}`, { who: 'demo' });
  assert.equal(prd.body.usersMasked, true, '데모 계정은 사용자 이름 가림');
  assert.ok(prd.body.top.every((p) => p.u == null || p.u.startsWith('masked-')));
  const cov = await call('GET', `/api/tools/focus-mon/coverage?${q}`);
  assert.equal(cov.status, 200);
  assert.ok(Array.isArray(cov.body.ranges));
  assert.equal((await call('GET', '/api/tools/focus-mon/data?view=overview&targets=fm-0000000000')).status, 404);
  assert.equal((await call('GET', `/api/tools/focus-mon/export.csv?kind=iostat&win=1&${q}`, { who: 'operator' })).status, 403);
  const csv = await call('GET', `/api/tools/focus-mon/export.csv?kind=iostat&win=1&${q}`);
  assert.equal(csv.status, 200);
  assert.match(csv.text, /r_await,w_await,svctm,%util/);
  assert.equal((await call('DELETE', `/api/tools/focus-mon/sessions/${sid}`)).status, 200);
});

test('⑨ 등록부 손상 → 503(빈 목록을 200 으로 내지 않는다) · 쓰기도 거절', async () => {
  fs.writeFileSync(path.join(DIR, 'focusmon-targets.json'), '{ broken');
  registry._resetForTest();
  const r = await call('GET', '/api/tools/focus-mon');
  assert.equal(r.status, 503);
  assert.equal(r.body.reason, 'registryUnreadable');
  assert.equal((await call('POST', '/api/tools/focus-mon/targets', { body: { name: 'x', host: '10.9.9.9', username: 'u' } })).status, 503);
  // 엣지 동기화도 빈 목록(200) 대신 503 — 엣지가 '대상 없음' 으로 수집기를 다 닫지 않게(반증 10번)
  const tok = issueAgentToken('edge-pl').token;
  const sy = await call('POST', '/api/central/focus-mon/sync?agent=edge-pl', { headers: { 'X-Central-Token': tok, 'X-Agent-Name': 'edge-pl' }, body: { sentAt: Date.now(), samples: [] } });
  assert.equal(sy.status, 503, sy.text);
  assert.equal(sy.body.code, 'registryUnreadable');
  fs.rmSync(path.join(DIR, 'focusmon-targets.json'), { force: true });
  for (const f of fs.readdirSync(DIR)) if (f.startsWith('focusmon-targets.json.corrupt')) fs.rmSync(path.join(DIR, f));
  registry._resetForTest();
});

test('⑩ central 동기화 — 공유 토큰 403 · 개별 토큰 200 · 목록에 비밀 0', async () => {
  const tok = issueAgentToken('edge-pl').token;
  const shared = await call('POST', '/api/central/focus-mon/sync', { headers: { 'X-Central-Token': 'ctok-api-2976' }, body: { samples: [] } });
  assert.equal(shared.status, 403);
  const ok = await call('POST', '/api/central/focus-mon/sync?agent=edge-pl', { headers: { 'X-Central-Token': tok, 'X-Agent-Name': 'edge-pl' }, body: { sentAt: Date.now(), samples: [] } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.ok, true);
  assert.deepEqual(ok.body.targets, []);
  assert.ok(!/password|privateKey|token/i.test(JSON.stringify(ok.body)));
  assert.ok(store.edgeStateOf('edge-pl'), '동기화 기록');
});

test('⑪ 노드 키 — 만든 뒤에도 응답에는 공개키 · 지문 칸만(개인키 · PEM 0)', async () => {
  const k = await call('POST', '/api/tools/focus-mon/key', { body: {} });
  assert.equal(k.status, 200, k.text);
  assert.ok(k.body.key?.publicKey, '공개키가 생겼다');
  const ALLOWED = new Set(['present', 'usable', 'source', 'file', 'type', 'fingerprint', 'publicKey', 'encrypted', 'error', 'loosePerm']);
  const a = await call('GET', '/api/tools/focus-mon');
  const central = a.body.nodes.find((x) => x.kind === 'central');
  for (const view of [k.body.key, central.key]) {
    const extra = Object.keys(view).filter((x) => !ALLOWED.has(x));
    assert.deepEqual(extra, [], `공개키 보기에 모르는 칸: ${extra.join(', ')}`);
  }
  for (const text of [k.text, a.text]) assert.ok(!/BEGIN [A-Z ]*PRIVATE KEY|privateKey|"pem"/i.test(text), '개인키 흔적 없음');
});

test('반증 6 · 11 — 연결 시험은 대상마다 10초에 한 번(진행 중이면 거절) · 데모 계정 판본은 엣지 · 키 · 수집 시작자를 싣지 않는다', async () => {
  const main = await call('GET', '/api/tools/focus-mon');
  const id = main.body.targets.find((t) => t.demo).id;
  const a = await call('POST', `/api/tools/focus-mon/targets/${id}/test`, { body: {} });
  assert.equal(a.status, 200, a.text);
  const b = await call('POST', `/api/tools/focus-mon/targets/${id}/test`, { body: {} });
  assert.equal(b.status, 429, '곧바로 다시 시험하면 거절(병렬 · 연타로 로그인 시도를 늘리지 못하게)');
  const st = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: [id], interval: 2, mode: 'watch' } });
  assert.equal(st.status, 200, st.text);
  const d = await call('GET', '/api/tools/focus-mon', { who: 'demo' });
  assert.equal(d.status, 200);
  assert.deepEqual(d.body.nodes.map((x) => x.kind), ['central'], '데모 판본에 엣지 노드 없음');
  assert.equal(d.body.nodes[0].key?.publicKey ?? null, null, '데모 판본에 공개키 없음');
  assert.ok(d.body.sessions.length >= 1 && d.body.sessions.every((x) => x.by === ''), '수집 시작자 가림');
  const adminView = await call('GET', '/api/tools/focus-mon');
  assert.ok(adminView.body.sessions.some((x) => x.by === 'a'), '관리자 판본은 그대로');
  await call('DELETE', `/api/tools/focus-mon/sessions/${st.body.session.id}`);
});
