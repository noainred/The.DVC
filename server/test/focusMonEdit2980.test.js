/**
 * test/focusMonEdit2980.test.js — v2.980 서버 집중 모니터링 '등록된 서버 수정'(사용자 요청 2026-11-12 "등록된 서버 수정하는 기능 추가").
 *  ① targetChanges(순수): 바뀐 칸만 · 담당 노드는 대소문자 무시 · 칸 목록이 화면(web EDIT_FIELDS)과 같다
 *  ② updateTarget: 바뀐 것이 없으면 쓰지 않는다 · 이름만 = moved false · 접속처 = moved true · 겹치는 접속처 · 모르는 노드는 거절
 *  ③ 라우트: 이름만 고치면 시험 결과 · 상태가 그대로 · 접속처를 고치면 예전 접속처의 시험 결과 · 상태 · 다시 연결 요청을 지운다
 *     (예전 주소의 '연결됨' 이 새 주소의 결과처럼 보이지 않게) · 감사 기록에 바뀐 값
 *  ④ 인증 정지는 지우지 않는다 — 이름만 고치면 계속 멈춤 · 접속처를 바꾸면 새 자격이라 정지가 맞지 않을 뿐 예전 기록은 남는다
 *  ⑤ 담당 노드를 엣지로 바꾸면 그 엣지를 깨운다 · 예전 엣지도 깨운다(손을 떼게) · 이름만 바꾸면 깨우지 않는다
 *  ⑥ 수집 중인 서버의 접속처를 바꾸면 수집을 이어 간다(새 접속처로 다시 연다 — 빠지지 않는다)
 *  ⑦ 문: 운영자 · 쓰기 범위 계정 · 데모 403 · 없는 대상 404 · 잘못된 IP 400
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonedit2980-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.CENTRAL_TOKEN = 'ctok-edit-2980';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-edit-2980-xxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const { issueAgentToken } = await import('../src/central/agentTokens.js');
const svc = await import('../src/focusmon/service.js');
const registry = await import('../src/focusmon/registry.js');
const store = await import('../src/focusmon/store.js');
const { focusAuthGuard, authDevOf } = await import('../src/focusmon/collector.js');
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
const put = (id, body, who) => call('PUT', `/api/tools/focus-mon/targets/${encodeURIComponent(id)}`, { body, who });
const reset = () => { fs.rmSync(path.join(DIR, 'focusmon-targets.json'), { force: true }); registry._resetForTest(); };
const waitFor = async (fn, ms = 2_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return fn(); };
issueAgentToken('edge-pl');
issueAgentToken('edge-us');
const AG = ['edge-pl', 'edge-us'];

test('① targetChanges — 바뀐 칸만 · 담당 노드 대소문자 무시 · 칸 목록이 화면과 같다', () => {
  const a = { name: 'a', host: '10.1.0.1', port: 22, username: 'root', agent: 'Edge-PL' };
  assert.deepEqual(registry.targetChanges(a, { ...a }), []);
  assert.deepEqual(registry.targetChanges(a, { ...a, agent: 'edge-pl' }), [], '노드 이름 대소문자만 다르면 같다');
  assert.deepEqual(registry.targetChanges(a, { ...a, name: 'b', port: 2222 }), [{ k: 'name', from: 'a', to: 'b' }, { k: 'port', from: 22, to: 2222 }]);
  assert.deepEqual(registry.targetChanges(a, { ...a, agent: '' }), [{ k: 'agent', from: 'Edge-PL', to: '' }]);
  // 화면(web/src/views/tools/focusMonText.js EDIT_FIELDS)과 같은 칸 · 순서 — 한쪽만 늘면 미리보기와 감사 기록이 어긋난다
  const web = fs.readFileSync(new URL('../../web/src/views/tools/focusMonText.js', import.meta.url), 'utf8');
  const m = web.match(/export const EDIT_FIELDS = Object\.freeze\(\[([^\]]+)\]\)/);
  assert.ok(m, '웹 EDIT_FIELDS 를 찾지 못함');
  assert.deepEqual(m[1].split(',').map((x) => x.trim().replace(/'/g, '')).filter(Boolean), [...registry.EDIT_FIELDS]);
});

test('② updateTarget — 바뀐 것이 없으면 쓰지 않는다 · 이름만 / 접속처 · 겹침 · 모르는 노드', async () => {
  reset();
  const t = registry.addTarget({ name: 'srv-1', host: '10.1.0.1', port: 22, username: 'root', agent: '' }, { agents: AG }).target;
  registry.addTarget({ name: 'srv-2', host: '10.1.0.2', port: 22, username: 'root', agent: '' }, { agents: AG });
  const file = path.join(DIR, 'focusmon-targets.json');
  const m0 = fs.statSync(file).mtimeMs;
  await new Promise((r) => setTimeout(r, 30));
  const same = registry.updateTarget(t.id, { name: 'srv-1', host: '10.1.0.1', port: '22', username: 'root', agent: '' }, { agents: AG });
  assert.equal(same.ok, true); assert.deepEqual(same.changes, []); assert.equal(same.moved, false);
  assert.equal(fs.statSync(file).mtimeMs, m0, '바뀐 것이 없으면 파일을 쓰지 않는다');
  const nm = registry.updateTarget(t.id, { name: 'srv-1-new' }, { agents: AG });
  assert.equal(nm.moved, false); assert.deepEqual(nm.changes.map((c) => c.k), ['name']);
  assert.equal(registry.getTarget(t.id).name, 'srv-1-new');
  const mv = registry.updateTarget(t.id, { host: '10.1.0.9', agent: 'EDGE-PL' }, { agents: AG });
  assert.equal(mv.moved, true); assert.deepEqual(mv.changes.map((c) => c.k), ['host', 'agent']);
  assert.equal(registry.getTarget(t.id).agent, 'edge-pl', '노드 이름은 아는 이름으로 맞춘다');
  assert.equal(mv.before.host, '10.1.0.1', '고치기 전 값(감사 · 서비스가 예전 엣지를 안다)');
  const dup = registry.updateTarget(t.id, { host: '10.1.0.2', agent: '' }, { agents: AG });
  assert.equal(dup.ok, false); assert.equal(dup.code, 'duplicate');
  const bad = registry.updateTarget(t.id, { agent: 'no-such' }, { agents: AG });
  assert.equal(bad.ok, false); assert.equal(bad.code, 'bad-agent');
  assert.equal(registry.getTarget(t.id).host, '10.1.0.9', '거절된 수정은 아무것도 바꾸지 않는다');
});

test('③ 라우트 — 이름만: 시험 결과 · 상태 그대로 / 접속처: 예전 접속처의 시험 결과 · 상태 · 다시 연결 요청을 지운다 · 감사', async () => {
  reset();
  const t = registry.addTarget({ name: 'web-01', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: AG }).target;
  store.putTestResult(t.id, { ok: true, kind: 'ok', hello: { rhelMajor: '7.8', isLinux: true }, via: 'central' });
  store.setStatus(t.id, { state: 'ok', error: '' });
  store.requestEdgeRetry(t.id, 'edge-pl');
  const a = await put(t.id, { name: 'web-01a', host: '10.2.0.1', port: 22, username: 'dvcmon', agent: '' });
  assert.equal(a.status, 200, a.text);
  assert.equal(a.body.moved, false); assert.equal(a.body.cleared, false); assert.deepEqual(a.body.changes.map((c) => c.k), ['name']);
  assert.equal(store.testOf(t.id)?.result?.ok, true, '이름만 고치면 시험 결과를 지우지 않는다');
  assert.equal(store.statusOf(t.id)?.state, 'ok');
  const b = await put(t.id, { name: 'web-01a', host: '10.2.0.77', port: 22, username: 'dvcmon', agent: '' });
  assert.equal(b.status, 200, b.text);
  assert.equal(b.body.moved, true); assert.equal(b.body.cleared, true);
  assert.equal(store.testOf(t.id), null, '예전 주소의 연결 시험 결과가 남지 않는다');
  assert.equal(store.statusOf(t.id), null, '예전 주소의 수집 상태가 남지 않는다');
  assert.deepEqual(store.takeEdgeRetries('edge-pl'), [], '예전 접속처의 다시 연결 요청도 지운다');
  assert.ok(!('before' in b.body), '응답은 고친 값 · 바뀐 칸만');
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  const row = main.targets.find((x) => x.id === t.id);
  assert.equal(row.host, '10.2.0.77'); assert.equal(row.test, null); assert.equal(row.status, null);
  const au = auditEntriesWithAction('focus-mon.target.update').map((e) => e.detail || '').join('\n');
  assert.match(au, /이름 web-01 → web-01a/);
  assert.match(au, /IP 10\.2\.0\.1 → 10\.2\.0\.77 \(접속처 바뀜\)/);
  // 바뀐 것이 없으면 감사도 남기지 않는다
  const n0 = auditEntriesWithAction('focus-mon.target.update').length;
  const c = await put(t.id, { name: 'web-01a' });
  assert.equal(c.status, 200); assert.deepEqual(c.body.changes, []);
  assert.equal(auditEntriesWithAction('focus-mon.target.update').length, n0);
});

test('④ 인증 정지는 지우지 않는다 — 이름만 고치면 계속 멈춤 · 접속처를 바꾸면 새 자격(예전 기록은 남는다)', async () => {
  reset();
  const t = registry.addTarget({ name: 'db-01', host: '10.3.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: AG }).target;
  svc.focusKeys.ensureKey();
  const fp = svc.focusKeys.keyInfo({ fresh: true }).fingerprint;
  const oldDev = authDevOf(t, fp);
  focusAuthGuard.markAuthStopped(`fm|${t.id}`, oldDev, '키 로그인 거부');
  assert.equal((await put(t.id, { name: 'db-01-renamed' })).status, 200);
  assert.ok(focusAuthGuard.peekAuthStop(authDevOf(registry.getTarget(t.id), fp)), '이름만 고치면 계속 멈춤');
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  assert.ok(main.targets.find((x) => x.id === t.id).authStop, '화면도 멈춤으로 본다');
  assert.equal((await put(t.id, { username: 'dvcmon2' })).status, 200);
  assert.equal(focusAuthGuard.peekAuthStop(authDevOf(registry.getTarget(t.id), fp)), null, '계정을 바꾸면 새 자격 — 사람이 시험을 눌러 한 번 시도');
  assert.ok(focusAuthGuard.peekAuthStop(oldDev), '예전 자격의 정지 기록은 지우지 않는다(되돌리면 다시 멈춤)');
  assert.equal((await put(t.id, { username: 'dvcmon' })).status, 200);
  assert.ok(focusAuthGuard.peekAuthStop(authDevOf(registry.getTarget(t.id), fp)), '예전 계정으로 되돌리면 다시 멈춤 — 수정으로 정지를 풀 수 없다');
});

test('⑤ 담당 노드를 바꾸면 새 엣지 · 예전 엣지를 깨운다 · 이름만이면 깨우지 않는다', async () => {
  reset();
  const t = registry.addTarget({ name: 'app-01', host: '10.4.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: AG }).target;
  const before = store.edgeWakeOf('edge-us')?.at || 0;
  assert.equal((await put(t.id, { name: 'app-01b' })).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(store.edgeWakeOf('edge-us')?.at || 0, before, '이름만 고치면 깨우지 않는다');
  const r = await put(t.id, { agent: 'edge-us' });
  assert.equal(r.status, 200, r.text);
  const w = await waitFor(() => { const x = store.edgeWakeOf('edge-us'); return x && x.at > before ? x : null; });
  assert.ok(w, '새 담당 엣지를 깨운다(그 엣지가 키를 만들고 · 수집 중이면 바로 시작)');
  assert.equal(w.kind, 'not-registered', '이 시험에는 수집 서버 등록부가 없다 — 깨우기를 시도한 기록만 본다');
  const pl0 = store.edgeWakeOf('edge-pl')?.at || 0;
  assert.equal((await put(t.id, { agent: 'edge-pl' })).status, 200);
  await waitFor(() => (store.edgeWakeOf('edge-pl')?.at || 0) > pl0);
  assert.ok((store.edgeWakeOf('edge-pl')?.at || 0) > pl0, '새 엣지');
  assert.ok((store.edgeWakeOf('edge-us')?.at || 0) > w.at, '예전 엣지도 깨운다(다음 동기화에서 손을 뗀다)');
});

test('⑥ 수집 중인 서버의 접속처를 바꾸면 수집을 이어 간다(새 접속처로 다시 연다)', async () => {
  reset();
  const t = registry.addTarget({ name: 'run-01', host: '10.5.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: AG }).target;
  const st = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: [t.id], interval: 2, mode: 'record' } });
  assert.equal(st.status, 200, st.text);
  assert.ok(svc.localRunner.statuses()[t.id], '수집 중');
  assert.equal(svc.serviceStatus().enabled, false, '이 시험에는 1초 주기 틱이 없다 — 아래 다시 열기는 라우트의 바로 틱이 한 것');
  await new Promise((r) => setTimeout(r, 40));
  const t0 = Date.now();
  const r = await put(t.id, { host: '10.5.0.2' });
  assert.equal(r.status, 200, r.text);
  const now = svc.localRunner.statuses()[t.id];
  assert.ok(now, '접속처를 바꿔도 수집에서 빠지지 않는다');
  assert.notEqual(now.state, 'stopped', '옛 수집기가 남긴 멈춤 상태가 아니다');
  assert.ok(now.since >= t0, `새 접속처로 새 수집기를 열었다(수정 뒤에 만든 수집기 — since ${now.since} ≥ ${t0})`);
  assert.deepEqual(store.desiredFor('', (id) => registry.getTarget(id), Date.now()).map((d) => d.host), ['10.5.0.2']);
  for (const s of store.listSessions()) svc.stopCollection(s.id);
});

test('⑦ 문 — 운영자 · 쓰기 범위 계정 · 데모 403 · 없는 대상 404 · 잘못된 IP 400 · 등록부 밖 노드 400', async () => {
  reset();
  const t = registry.addTarget({ name: 'gate-01', host: '10.6.0.1', port: 22, username: 'dvcmon', agent: '' }, { agents: AG }).target;
  for (const who of ['operator', 'wscoped', 'demo']) assert.equal((await put(t.id, { name: 'x' }, who)).status, 403, who);
  assert.equal((await put('fm-nosuch0000', { name: 'x' })).status, 404);
  const bad = await put(t.id, { host: '010.6.0.1' });
  assert.equal(bad.status, 400); assert.equal(bad.body.code, 'bad-host');
  const lo = await put(t.id, { host: '127.0.0.1' });
  assert.equal(lo.status, 400); assert.equal(lo.body.code, 'blocked-host');
  assert.equal((await put(t.id, { agent: 'no-such-edge' })).status, 400);
  assert.equal(registry.getTarget(t.id).name, 'gate-01', '거절된 요청은 바꾸지 않는다');
});
