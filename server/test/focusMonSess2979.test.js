/**
 * test/focusMonSess2979.test.js — v2.979 서버 집중 모니터링 '중복 모니터링 방지 · 진행 중인 수집에 더하기 · 수집 종료'.
 * 사용자 요청(2026-11-12): "모니터링 종료 하는 버튼 만들어줘" · "중복 모니터링 방지 기능 넣어줘" · "기존 모니터링 돌고있는데, 추가하면 잘 안되"
 *  → 선택 '빼고 시작 + 수집에 추가'.
 *  ① 시작: 이미 수집 중인 서버는 빼고 시작 · 모두 겹치면 409 already · 계속 수집은 잠깐 보기의 서버를 넘겨받는다(비면 그 잠깐 보기는 끝)
 *  ② 동시 수집 상한: 넘겨받아 비게 되는 잠깐 보기는 자리를 비운다
 *  ③ 더하기: 같은 규칙 · 수집 하나 상한 · 없는 수집 404
 *  ④ 서버 하나 빼기: 마지막 서버면 수집이 끝난다(why removed)
 *  ⑤ 라우트: 문(조회 · 쓰기 전체 범위 · 데모 차단) · 없는 대상 404 · 응답의 skipped · moved
 *  ⑥ 수집 대상 목록(desiredFor)에 같은 서버가 두 번 나오지 않는다
 */
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'focusmonsess2979-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.FOCUSMON_SSH_KEY = '';
process.env.AUTH_SECRET = 'test-secret-sess-2979-xxxxxxxxxxxxxxxxxxxxxxxxxxx';

const express = (await import('express')).default;
const { api } = await import('../src/routes/api.js');
const svc = await import('../src/focusmon/service.js');
const store = await import('../src/focusmon/store.js');

const users = {
  admin: { username: 'a', role: 'admin', scope: null },
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
const stopAll = () => { for (const s of store.listSessions()) store.stopSession(s.id); };
beforeEach(stopAll);

test('① 시작 — 이미 수집 중인 서버는 빼고 · 모두 겹치면 already · 계속 수집은 잠깐 보기의 서버를 넘겨받는다', () => {
  const a = store.startSession({ targets: ['fm-aaaaaa1', 'fm-bbbbbb1'], interval: 2, mode: 'watch' });
  assert.equal(a.ok, true); assert.deepEqual(a.skipped, []);
  const b = store.startSession({ targets: ['fm-bbbbbb1', 'fm-cccccc1'], interval: 2, mode: 'watch' });
  assert.equal(b.ok, true);
  assert.deepEqual(b.session.targets, ['fm-cccccc1'], '겹친 서버는 빼고 시작');
  assert.deepEqual(b.skipped.map((x) => x.id), ['fm-bbbbbb1']);
  assert.equal(b.skipped[0].session, a.session.id);
  const c = store.startSession({ targets: ['fm-aaaaaa1', 'fm-cccccc1'], interval: 2, mode: 'watch' });
  assert.equal(c.ok, false); assert.equal(c.code, 'already'); assert.equal(c.skipped.length, 2);
  // 계속 수집으로 시작하면 잠깐 보기에 있던 서버를 넘겨받는다
  const d = store.startSession({ targets: ['fm-bbbbbb1', 'fm-dddddd1'], interval: 10, mode: 'record' });
  assert.equal(d.ok, true);
  assert.deepEqual(d.session.targets, ['fm-bbbbbb1', 'fm-dddddd1']); assert.deepEqual(d.moved, ['fm-bbbbbb1']);
  assert.deepEqual(store.getSession(a.session.id).targets, ['fm-aaaaaa1'], '잠깐 보기에서 빠졌다');
  // 잠깐 보기의 마지막 서버를 넘겨받으면 그 잠깐 보기는 끝난다
  const e = store.addToSession(d.session.id, ['fm-cccccc1']);
  assert.equal(e.ok, true); assert.deepEqual(e.moved, ['fm-cccccc1']);
  assert.equal(store.getSession(b.session.id), null, '빈 잠깐 보기는 끝');
  assert.equal(store.endedSessions()[0].why, 'moved');
  // 어느 때든 서버는 수집 하나에만 있다
  const all = store.listSessions().flatMap((s) => s.targets);
  assert.equal(new Set(all).size, all.length);
  // 계속 수집에 있는 서버는 잠깐 보기로 다시 시작해도 넘겨주지 않는다(빼고 시작)
  const f = store.startSession({ targets: ['fm-dddddd1'], interval: 2, mode: 'watch' });
  assert.equal(f.ok, false); assert.equal(f.code, 'already');
});

test('② 동시 수집 상한 — 넘겨받아 비게 되는 잠깐 보기는 자리를 비운다', () => {
  for (let i = 0; i < store.MAX_SESSIONS - 1; i++) assert.equal(store.startSession({ targets: [`fm-s0000${i}x`], mode: 'watch' }).ok, true);
  assert.equal(store.startSession({ targets: ['fm-lastww1'], mode: 'watch' }).ok, true);
  const full = store.startSession({ targets: ['fm-newnew1'], mode: 'watch' });
  assert.equal(full.code, 'too-many-sessions');
  assert.match(full.reason, /진행 중인 수집에 추가/);
  const took = store.startSession({ targets: ['fm-lastww1', 'fm-newnew1'], mode: 'record' });
  assert.equal(took.ok, true, '넘겨받아 빈 잠깐 보기의 자리에 시작');
  assert.equal(store.listSessions().length, store.MAX_SESSIONS);
});

test('③ 더하기 — 같은 수집 · 다른 수집의 서버 · 수집 하나 상한 · 없는 수집', () => {
  const a = store.startSession({ targets: ['fm-aaaaaa2'], mode: 'watch' });
  const b = store.startSession({ targets: ['fm-bbbbbb2'], mode: 'watch' });
  const r = store.addToSession(a.session.id, ['fm-aaaaaa2', 'fm-bbbbbb2', 'fm-cccccc2']);
  assert.equal(r.ok, true); assert.deepEqual(r.added, ['fm-cccccc2']);
  assert.deepEqual(r.skipped.map((x) => [x.id, !!x.same]), [['fm-aaaaaa2', true], ['fm-bbbbbb2', false]]);
  assert.equal(store.addToSession(a.session.id, ['fm-bbbbbb2']).code, 'already');
  assert.equal(store.addToSession('fs-0000000000', ['fm-dddddd2']).code, 'not-found');
  const many = Array.from({ length: store.MAX_PER_SESSION }, (_, i) => `fm-m${String(i).padStart(5, '0')}`);
  const over = store.addToSession(b.session.id, many);
  assert.equal(over.code, 'too-many'); assert.match(over.reason, new RegExp(`${store.MAX_PER_SESSION - 1}대를 더`));
});

test('④ 서버 하나 빼기 — 마지막 서버면 수집이 끝난다', () => {
  const a = store.startSession({ targets: ['fm-aaaaaa3', 'fm-bbbbbb3'], mode: 'record', interval: 10 });
  const r1 = store.removeFromSession(a.session.id, 'fm-aaaaaa3');
  assert.equal(r1.ok, true); assert.equal(r1.ended, false); assert.deepEqual(r1.session.targets, ['fm-bbbbbb3']);
  assert.equal(store.removeFromSession(a.session.id, 'fm-zzzzzz3').code, 'not-in-session');
  const r2 = store.removeFromSession(a.session.id, 'fm-bbbbbb3');
  assert.equal(r2.ok, true); assert.equal(r2.ended, true);
  assert.equal(store.getSession(a.session.id), null);
  assert.equal(store.endedSessions()[0].why, 'removed');
  // 계속 수집 정의 파일에서도 빠졌다(재시작하면 되살아나지 않는다)
  const j = JSON.parse(fs.readFileSync(path.join(DIR, 'focusmon-sessions.json'), 'utf8'));
  assert.equal((j.sessions || []).some((s) => s.id === a.session.id), false);
});

test('⑤ 라우트 — 시작 응답의 skipped · 더하기 · 빼기 · 문(쓰기 범위 · 데모) · 없는 대상', async () => {
  const main = (await call('GET', '/api/tools/focus-mon')).body;
  const demo = main.targets.filter((t) => t.demo).map((t) => t.id);
  const s1 = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: demo.slice(0, 2), interval: 2, mode: 'watch' } });
  assert.equal(s1.status, 200, s1.text);
  const s2 = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: demo.slice(1, 3), interval: 2, mode: 'watch' } });
  assert.equal(s2.status, 200, s2.text);
  assert.deepEqual(s2.body.session.targets, [demo[2]]); assert.deepEqual(s2.body.skipped.map((x) => x.id), [demo[1]]);
  const dup = await call('POST', '/api/tools/focus-mon/sessions', { body: { targets: demo.slice(0, 2), interval: 2, mode: 'watch' } });
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'already');
  const id = s1.body.session.id;
  for (const who of ['wscoped', 'demo']) {
    assert.equal((await call('POST', `/api/tools/focus-mon/sessions/${id}/targets`, { who, body: { targets: [demo[3]] } })).status, 403, who);
    assert.equal((await call('DELETE', `/api/tools/focus-mon/sessions/${id}/targets/${demo[0]}`, { who })).status, 403, who);
  }
  assert.equal((await call('POST', `/api/tools/focus-mon/sessions/${id}/targets`, { body: { targets: ['fm-0000000000'] } })).status, 404);
  assert.equal((await call('POST', '/api/tools/focus-mon/sessions/fs-0000000000/targets', { body: { targets: [demo[3]] } })).status, 404);
  const add = await call('POST', `/api/tools/focus-mon/sessions/${id}/targets`, { body: { targets: [demo[3], demo[2]] } });
  assert.equal(add.status, 200, add.text); assert.deepEqual(add.body.added, [demo[3]]); assert.equal(add.body.skipped.length, 1);
  const rm = await call('DELETE', `/api/tools/focus-mon/sessions/${id}/targets/${demo[3]}`);
  assert.equal(rm.status, 200); assert.equal(rm.body.ended, false);
  assert.equal((await call('DELETE', `/api/tools/focus-mon/sessions/${id}/targets/${demo[3]}`)).status, 409, '이미 빠진 서버');
  const g = (await call('GET', '/api/tools/focus-mon')).body;
  const all = g.sessions.flatMap((s) => s.targets);
  assert.equal(new Set(all).size, all.length, '화면이 받는 수집 목록에도 중복 없음');
});

test('⑥ 수집 대상 목록 — 같은 서버가 두 번 나오지 않는다(중앙 몫)', () => {
  store.startSession({ targets: ['fm-dupdup1', 'fm-dupdup2'], mode: 'watch', interval: 2 });
  store.startSession({ targets: ['fm-dupdup2', 'fm-dupdup3'], mode: 'record', interval: 10 });
  const resolve = (id) => ({ id, host: '10.0.0.1', port: 22, username: 'u', agent: '', enabled: true });
  const want = store.desiredFor('', resolve);
  const ids = want.map((d) => d.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(ids.sort(), ['fm-dupdup1', 'fm-dupdup2', 'fm-dupdup3']);
});
