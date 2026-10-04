/**
 * v2.689 — uagmon 순수 모듈 회귀.
 *  httpGuard: 루프백 Host · 교차출처(pyportal _cross_site 와 같은 규칙) · Content-Type
 *  poller(I8 a·c): 삭제된 대상 결과 버림 · 진행 중 대상 추가 시 재실행 예약
 *  auth(I8 d): 실패 기록 15분 만료 · 잠금 중인 기록은 정리하지 않음
 *  store: 저장 실패 시 메모리 되돌림
 *  uag.parseStats: 객체가 아닌 서비스 원소에 던지지 않음
 *
 * 실행: node --test uagmon/test/units2689.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loopbackHostOk, crossSite, isJsonContentType, mutationVerdict } from '../lib/httpGuard.js';
import { createPoller } from '../lib/poller.js';
import { Auth, FAIL_TTL_MS } from '../lib/auth.js';
import { Store } from '../lib/store.js';
import { parseStats } from '../lib/uag.js';

const TMP_BASE = process.env.UAGMON_TEST_TMP || os.tmpdir();

test('httpGuard: 루프백 Host 판정', () => {
  for (const h of ['127.0.0.1', '127.0.0.1:8123', 'localhost', 'LOCALHOST:1', '[::1]', '[::1]:65535']) assert.equal(loopbackHostOk(h), true, h);
  for (const h of ['', 'evil.example', '127.0.0.1.evil.example', 'localhost.evil', '127.0.0.2:8123', '[::2]', '127.0.0.1:abc', '0.0.0.0']) assert.equal(loopbackHostOk(h), false, h);
});

test('httpGuard: 교차출처 — pyportal _cross_site 와 같은 규칙', () => {
  assert.equal(crossSite({}), false);
  assert.equal(crossSite({ 'sec-fetch-site': 'same-origin' }), false);
  assert.equal(crossSite({ 'sec-fetch-site': 'none' }), false);
  assert.equal(crossSite({ 'sec-fetch-site': 'same-site' }), false);
  assert.equal(crossSite({ 'sec-fetch-site': 'cross-site' }), true);
  assert.equal(crossSite({ origin: 'http://127.0.0.1:8123', host: '127.0.0.1:8123' }), false);
  assert.equal(crossSite({ origin: 'http://evil.example', host: '127.0.0.1:8123' }), true);
  assert.equal(crossSite({ origin: 'null', host: '127.0.0.1:8123' }), true);
  assert.equal(crossSite({ origin: 'http://127.0.0.1:9999', host: '127.0.0.1:8123' }), true, '포트가 다르면 다른 출처');
});

test('httpGuard: Content-Type 과 상태 변경 판정', () => {
  assert.equal(isJsonContentType('application/json'), true);
  assert.equal(isJsonContentType('Application/JSON; charset=utf-8'), true);
  assert.equal(isJsonContentType('text/plain'), false);
  assert.equal(isJsonContentType(undefined), false);
  assert.equal(mutationVerdict('GET', { 'sec-fetch-site': 'cross-site' }), null, '조회는 판정하지 않는다');
  assert.equal(mutationVerdict('POST', { 'content-type': 'text/plain' }).code, 415);
  assert.equal(mutationVerdict('POST', {}).code, 415);
  assert.equal(mutationVerdict('PUT', { 'content-type': 'application/json' }), null);
  assert.equal(mutationVerdict('DELETE', {}), null, '본문 없는 DELETE 는 통과');
  assert.equal(mutationVerdict('DELETE', { 'content-type': 'text/plain' }).code, 415);
  assert.equal(mutationVerdict('POST', { 'content-type': 'application/json', origin: 'http://evil', host: '127.0.0.1:1' }).code, 403);
  // 서버 모드는 Sec-Fetch-Site 만 본다(리버스 프록시가 Host 를 바꿀 수 있다)
  assert.equal(mutationVerdict('POST', { 'content-type': 'application/json', origin: 'https://a', host: 'b' }, { loopback: false }), null);
  assert.equal(mutationVerdict('POST', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, { loopback: false }).code, 403);
});

function fakeStore(targets) {
  const s = { targets, samples: [] };
  s.pushSample = (id, r) => s.samples.push({ id, r });
  return s;
}
function deferred() { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

test('poller I8(a): 폴링 중 삭제된 대상의 결과는 반영하지 않는다', async () => {
  const a = { id: 'a' }; const b = { id: 'b' };
  const store = fakeStore([a, b]);
  const gate = deferred();
  const poller = createPoller(store, async (t) => { await gate.p; return { ok: true, who: t.id }; });
  const run = poller.pollOnce();
  store.targets = [b]; // a 삭제
  gate.resolve();
  await run;
  assert.deepEqual(store.samples.map((x) => x.id), ['b']);
});

test('poller I8(a): 폴링 중 수정된 대상(같은 id 새 객체)의 옛 결과도 버린다', async () => {
  const a = { id: 'a', host: 'old' };
  const store = fakeStore([a]);
  const gate = deferred();
  const poller = createPoller(store, async (t) => { await gate.p; return { ok: true, host: t.host }; });
  const run = poller.pollOnce();
  store.targets = [{ id: 'a', host: 'new' }];
  gate.resolve();
  await run;
  assert.equal(store.samples.length, 0);
});

test('poller I8(c): 진행 중에 대상이 추가되면(again) 끝난 뒤 한 번 더 돈다 · 주기 틱은 예약하지 않는다', async () => {
  const a = { id: 'a' };
  const store = fakeStore([a]);
  let gate = deferred();
  const calls = [];
  const poller = createPoller(store, async (t) => { calls.push(t.id); await gate.p; return { ok: true }; });
  const first = poller.pollOnce();
  assert.equal(poller.polling, true);
  // 주기 틱(again 없음)은 건너뛰기만
  assert.deepEqual(await poller.pollOnce(), { skipped: true, queued: false });
  const b = { id: 'b' };
  store.targets = [a, b];
  assert.deepEqual(await poller.pollOnce({ again: true }), { skipped: true, queued: true });
  gate.resolve();
  await first;
  await poller.settled();
  assert.deepEqual(calls, ['a', 'a', 'b'], '재실행이 새 대상 b 를 포함해야 한다');
  assert.deepEqual(store.samples.map((x) => x.id).sort(), ['a', 'a', 'b']);
  // 예약 없이 끝나면 추가 실행이 없다
  gate = deferred(); gate.resolve();
  const n = calls.length;
  await poller.pollOnce();
  await poller.settled();
  assert.equal(calls.length, n + 2);
});

test('auth I8(d): 실패 기록은 마지막 실패 15분 뒤 정리 · 잠금 중에는 정리하지 않는다', () => {
  let now = 1_000_000;
  const auth = new Auth({ required: true, passwordHash: 'x'.repeat(64), now: () => now });
  auth.login('10.0.0.1', 'bad');
  assert.equal(auth.fails.size, 1);
  now += FAIL_TTL_MS + 1;
  auth.login('10.0.0.2', 'bad'); // 다른 IP 로그인이 정리를 돌린다
  assert.equal(auth.fails.has('10.0.0.1'), false, '15분 지난 기록은 지워진다');
  assert.equal(auth.fails.has('10.0.0.2'), true);
  // 잠금 — 5회
  for (let i = 0; i < 5; i++) auth.login('10.0.0.3', 'bad');
  assert.ok(auth.fails.get('10.0.0.3').lockedUntil > now);
  const r = auth.login('10.0.0.3', 'bad');
  assert.match(r.error, /잠겼습니다/);
  now += 4 * 60 * 1000; // 잠금 5분 안 — 정리 대상이 아니다
  auth.pruneFails();
  assert.equal(auth.fails.has('10.0.0.3'), true);
  assert.match(auth.login('10.0.0.3', 'bad').error, /잠겼습니다/);
  now += FAIL_TTL_MS + 60 * 1000;
  auth.pruneFails();
  assert.equal(auth.fails.has('10.0.0.3'), false);
});

test('store: 저장 실패면 메모리를 되돌리고 던진다(추가·수정·삭제)', () => {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, 'uagmon2689-store-'));
  try {
    const s = new Store(dir);
    const t = s.addTarget({ host: '10.0.0.5', username: 'u', password: 'p' });
    const realSave = s.save;
    s.save = () => { throw new Error('ENOSPC'); };
    assert.throws(() => s.addTarget({ host: '10.0.0.6', username: 'u', password: 'p' }), /ENOSPC/);
    assert.equal(s.targets.length, 1);
    assert.throws(() => s.updateTarget(t.id, { name: 'renamed' }), /ENOSPC/);
    assert.equal(s.targets[0].name, '10.0.0.5');
    s.pushSample(t.id, { ok: true, totalSessions: 1 });
    assert.throws(() => s.removeTarget(t.id), /ENOSPC/);
    assert.equal(s.targets.length, 1);
    assert.ok(s.latest.has(t.id), '삭제가 실패하면 최신값도 남는다');
    s.save = realSave;
    assert.equal(s.removeTarget(t.id), true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('uag.parseStats: 객체가 아닌 서비스 원소·null 루트에 던지지 않는다', () => {
  assert.doesNotThrow(() => parseStats('{"edgeServiceSessionStats":[null,5,{"identifier":"view","edgeServiceStatus":"up","totalSessionCount":3}]}'));
  const r = parseStats('{"edgeServiceSessionStats":[null,{"identifier":"view","edgeServiceStatus":"up","totalSessionCount":3}]}');
  assert.equal(r.ok, true);
  assert.equal(r.services.length, 1);
  assert.equal(r.totalSessions, 3);
  assert.doesNotThrow(() => parseStats('{"accessPointStatusAndStats":null,"systemStats":7}'));
});
