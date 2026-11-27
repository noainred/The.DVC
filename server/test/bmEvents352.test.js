// 물리서버 장애 바로 받기(Redfish 이벤트 구독 · v3.52 — 설계 docs/design/bm-feature-proposals ⑬). 사용자 인증 없는 받는 주소가 핵심 위험.
//   받는 주소 꼴 · 설정(기본 꺼짐 · 비밀은 응답에 없음 · 바꾸기 · 손상) · Context HMAC · 비밀 비교 · 본문 정제(상한 · 제어 문자) ·
//   받기(서버 모름 거절 · 고리 상한 · 위험 · 주의만 바로 점검 · 30초 묶음) · 받는 라우터(꺼짐/틀린 비밀은 본문 전 404 · 64KB · 꼴 400) ·
//   기록에서 비밀 지움 · 구독 걸기 · 지우기(이 포탈 꼴만 지움 · 같은 것은 둠 · 지원 안 함 · 401 · 인증 정지) · 실제 redfishSend 왕복 · 관리자 라우트 게이트 · 감사.
//   픽스처 식별자 · 주소는 합성(SYNTH · 192.0.2.x · example.test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmevents352-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true' });
delete process.env.CENTRAL_URL;

const E = await import('../src/idrac/eventSub.js');
const BASE = 'https://portal.example.test:8443';

test('받는 주소 꼴 — https · 호스트[:포트]만 · 경로 · 질의 · http · 긴 것 · 틀린 호스트 거절', () => {
  assert.deepEqual(E.normalizeBase('https://Portal.Example.test:8443/'), { ok: true, value: 'https://portal.example.test:8443' });
  assert.deepEqual(E.normalizeBase(''), { ok: true, value: '' });
  assert.equal(E.normalizeBase('https://192.0.2.10').value, 'https://192.0.2.10');
  for (const bad of ['http://portal.example.test', 'https://portal.example.test/api', 'https://portal.example.test?x=1', 'https://a..b', 'https://-a.example.test', 'https://portal.example.test:70000', `https://${'a'.repeat(200)}.test`, 'https://user@portal.example.test', 'javascript:alert(1)'])
    assert.equal(E.normalizeBase(bad).ok, false, bad);
});

test('설정 — 기본 꺼짐 · 켜려면 받는 주소 · 비밀은 처음 저장 · 바꾸기 때 만들고 응답(공개 꼴)에 없음 · 파일 0600 · 손상은 꺼짐 + 쓰기 409', () => {
  E.eventSubStore._resetForTest();
  assert.deepEqual(E.eventSubStore.get().enabled, false);
  assert.equal(E.eventSubStore.save({ enabled: true, base: '' }).status, 400);
  assert.equal(E.eventSubStore.save({ enabled: 'yes', base: BASE }).status, 400);
  const a = E.eventSubStore.save({ enabled: true, base: BASE }, { by: 'admin' });
  assert.deepEqual([a.ok, a.rotated], [true, false], '처음 만든 비밀은 ‘새로 만듦’ 이 아니다');
  const s1 = E.eventSubStore.get().secret;
  assert.match(s1, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(E.eventSubPublic()).includes(s1), '공개 꼴에 비밀 없음');
  assert.equal(E.eventSubPublic().hasSecret, true);
  assert.equal(E.eventSubStore.save({ enabled: true, base: BASE }).value.secret, s1, '그대로 저장하면 비밀 유지');
  const b = E.eventSubStore.save({ enabled: true, base: BASE, rotate: true });
  assert.deepEqual([b.rotated, b.value.secret !== s1], [true, true]);
  assert.equal(fs.statSync(path.join(tmp, 'bm-events.json')).mode & 0o777, 0o600);
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    E.eventSubStore._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-events.json'), '{oops');
    assert.equal(E.eventSubStore.get().enabled, false);
    assert.equal(E.eventSubStore.save({ enabled: false, base: '' }).status, 409);
  } finally { console.error = w; console.warn = ww; for (const f of fs.readdirSync(tmp).filter((x) => x.startsWith('bm-events.json'))) fs.rmSync(path.join(tmp, f), { force: true }); E.eventSubStore._resetForTest(); }
});

test('Context HMAC(따로 둔 열쇠) · 비밀 비교(같은 길이도) · 기록에서 비밀 지움(절대 꼴 포함) · 결과 글자에서 비밀 지움', () => {
  const s = { enabled: true, base: BASE, secret: 'A'.repeat(43), ctxKey: 'K'.repeat(43) };
  const ctx = E.contextOf(s, 'srv-1');
  assert.equal(E.idOfContext(s, ctx), 'srv-1');
  assert.equal(E.idOfContext(s, ctx.replace('srv-1', 'srv-2')), '', '서버 id 를 바꾸면 HMAC 이 틀린다');
  assert.equal(E.idOfContext({ ...s, ctxKey: 'B'.repeat(43) }, ctx), '', '열쇠가 다르면 틀린다');
  // 장비가 평문으로 갖는 받는 주소 비밀로는 다른 서버 Context 를 만들 수 없다(반증 A9)
  const crypto = require('node:crypto');
  const forged = `dvc:srv-2:${crypto.createHmac('sha256', s.secret).update('srv-2').digest('base64url').slice(0, 16)}`;
  assert.equal(E.idOfContext(s, forged), '');
  assert.equal(E.idOfContext(s, 'dvc:x'), '');
  assert.equal(E.secretOk(s, s.secret), true);
  assert.equal(E.secretOk(s, `${'A'.repeat(42)}B`), false, '같은 길이의 틀린 비밀(변이 M32)');
  assert.equal(E.secretOk(s, `${s.secret}x`), false);
  assert.equal(E.secretOk({ ...s, enabled: false }, s.secret), false, '꺼져 있으면 늘 거짓');
  assert.equal(E.secretOk({ ...s, secret: '' }, ''), false);
  assert.equal(E.destinationOf(s), `${BASE}/api/bm-events/in/${s.secret}`);
  assert.equal(E.scrubEventPath(`/api/bm-events/in/${s.secret}`), '/api/bm-events/in/…');
  assert.equal(E.scrubEventPath(`/API/BM-EVENTS/IN/${s.secret}`), '/API/BM-EVENTS/IN/…', '대소문자 무시(라우팅과 같게)');
  assert.equal(E.scrubEventPath(`http://portal.example.test/api/bm-events/in/${s.secret}`), 'http://portal.example.test/api/bm-events/in/…', '절대 꼴 요청 대상(반증 A7)');
  assert.equal(E.scrubEventPath('/api/tools/x'), '/api/tools/x');
  assert.equal(E.scrubSecret(`Destination ${E.destinationOf(s)} is not reachable`, s), `Destination ${BASE}/api/bm-events/in/… is not reachable`, '장비 오류 글자(반증 A8)');
  assert.equal(E.scrubSecret(`token=${s.secret} ctx=${s.ctxKey}`, s), 'token=… ctx=…', '주소 꼴이 아닌 자리의 비밀도(변이 S13)');
  // index.js — 요청 기록 · 처리 안 된 오류 기록 두 곳이 지운다 · 받는 라우터는 인증 없이 전역 파서 앞에
  const src = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /const url = scrubEventPath\(req\.originalUrl\.split\('\?'\)\[0\]\);/);
  assert.match(src, /unhandled \$\{req\.method\} \$\{scrubEventPath\(/);
  const iEv = src.indexOf("app.use('/api/bm-events', bmEventsRouter);"); const iJson = src.indexOf("app.use(express.json({ limit: '1mb' }));");
  assert.ok(iEv > 0 && iEv < iJson, '전역 JSON 파서보다 먼저');
  assert.doesNotMatch(src, /app\.use\('\/api\/bm-events',[^\n]*authMiddleware/);
});

test('본문 정제 — 꼴 · 한 번에 32건 · 등급 · 제어 문자 · 글자 상한 · 원인 경로', () => {
  assert.equal(E.parseEventBody(null), null);
  assert.equal(E.parseEventBody({ Events: 'x' }), null);
  const p = E.parseEventBody({ Context: 'c', Events: [{ MessageSeverity: 'Critical', MessageId: 'PSU0003', Message: `PSU 1 lost\r\ninput${'x'.repeat(500)}`, EventTimestamp: '2026-11-26T01:00:00Z', OriginOfCondition: { '@odata.id': '/redfish/v1/Chassis/1/Power' } }, { Severity: 'OK' }, 'junk', ...Array.from({ length: 40 }, () => ({ Severity: 'Warning' }))] }, 5);
  assert.equal(p.events.length, 32); assert.equal(p.dropped, 42 - 32, '객체 42건(글자 하나는 버림) 중 32건');
  assert.deepEqual([p.events[0].sev, p.events[0].msgId, p.events[0].at, p.events[0].origin, p.events[0].msg.length, /[\r\n]/.test(p.events[0].msg)], ['critical', 'PSU0003', Date.parse('2026-11-26T01:00:00Z'), '/redfish/v1/Chassis/1/Power', 300, false]);
  assert.deepEqual([p.events[1].sev, p.events[1].at], ['ok', 5], '시각을 못 읽으면 받은 시각');
  assert.equal(E.wantsCheck([{ sev: 'ok' }, { sev: '' }]), false);
  assert.equal(E.wantsCheck([{ sev: 'ok' }, { sev: 'warning' }]), true);
});

test('받기 — 서버 모름은 거절 · 고리 200(내부 길이) · 위험 · 주의만 바로 점검 · 끝난 뒤부터 간격 · 폴링이 바쁘면 다시 · 다시 읽을 서버를 넘긴다', async () => {
  E._resetEventsForTest();
  const runs = []; let busyOnce = false;
  E._setEventDepsForTest({ debounceMs: 60, runCheck: async (r, ids) => { runs.push([r, [...ids].sort()]); if (busyOnce) { busyOnce = false; return { busy: true }; } return { busy: false }; } });
  const s = { enabled: true, base: BASE, secret: 'C'.repeat(43), ctxKey: 'D'.repeat(43) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    assert.deepEqual(E.acceptEvents(s, { context: 'dvc:x:yyyyyyyyyyyyyyyy', events: [{ sev: 'critical' }] }), { ok: false, accepted: 0, check: false });
    assert.equal(E.eventStatus().rejected, 1);
    const ctx = E.contextOf(s, 'srv-1');
    assert.equal(E.acceptEvents(s, { context: ctx, events: [{ sev: 'ok', msg: 'info' }] }).check, false, '정보는 기록만');
    await wait(20);
    assert.equal(runs.length, 0);
    assert.equal(E.acceptEvents(s, { context: ctx, events: [{ sev: 'critical', msg: 'psu' }] }, { name: 'synth-db-01' }).check, true);
    await wait(20);
    assert.deepEqual(runs, [['event', ['srv-1']]], '처음은 바로 · 그 서버를 다시 읽게 넘긴다(반증 A2)');
    // 간격 안의 신호 둘 — 한 번으로 묶여 간격 뒤에(변이 M38)
    E.acceptEvents(s, { context: E.contextOf(s, 'srv-2'), events: [{ sev: 'warning' }] });
    E.acceptEvents(s, { context: ctx, events: [{ sev: 'critical' }] });
    await wait(20);
    assert.equal(runs.length, 1, '묶는 동안은 돌지 않는다');
    await wait(120);
    assert.deepEqual(runs.slice(1), [['event', ['srv-1', 'srv-2']]]);
    // 폴링이 바쁘면 같은 서버로 다시(간격 뒤)
    busyOnce = true;
    E.acceptEvents(s, { context: ctx, events: [{ sev: 'critical' }] });
    await wait(250);
    assert.deepEqual(runs.slice(2).map((x) => x[1]), [['srv-1'], ['srv-1']], '바쁨 → 다시');
    const st = E.eventStatus();
    assert.deepEqual([st.recent[0].sev, st.recent.at(-1).msg, st.recent.find((x) => x.msg === 'psu').name], ['critical', 'info', 'synth-db-01']);
    E.acceptEvents(s, E.parseEventBody({ Context: ctx, Events: Array.from({ length: 40 }, () => ({ Severity: 'OK' })) }));
    assert.equal(E.eventStatus().dropped, 8, '한 번에 32건을 넘어 버린 수를 센다(반증 B13 · 변이 S19)');
    for (let i = 0; i < 250; i += 1) E.acceptEvents(s, { context: ctx, events: [{ sev: 'ok' }] });
    assert.deepEqual([E.eventStatus().recent.length, E.eventStatus().ringSize], [E.EVT_RING, E.EVT_RING], '고리 상한 — 내부 길이(변이 M40)');
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); }
  // 기본 점검 — 인벤토리를 다시 읽게 표시 → iDRAC 폴링 한 번 → 부품 장애(캐시만 다시 판정하지 않는다 — 반증 A2)
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/eventSub.js', import.meta.url), 'utf8'));
  const body = src.slice(src.indexOf('runCheck: async (reason, ids, { onServerDone = null } = {}) => {'), src.indexOf('let _deps = DEFAULT_DEPS;'));
  // 그 서버만 폴링 → 판정 순서(디버깅 1회차 성능 P2). 강제 재읽기 표지는 다시 시도를 다 쓴 서버에만(scheduleCheck — 5회차 엣지 #3)
  assert.ok(body.indexOf('pollNowForEvent(ids, { onRefreshed: J.kick, onServerDone })') > 0 && src.indexOf('runPartFaultsNow') > 0, '그 서버만 폴링 · 다시 읽은 서버마다 판정(6회차 엣지 #2 — 판정 고리)');
  assert.match(src, /if \(giveUp\.length\) \{ try \{ const C = await import\('\.\/invCache\.js'\); for \(const id of giveUp\) C\.markInventoryStale\(id, \{ event: true \}\);/);
  const C = await import('../src/idrac/invCache.js');
  C.setInventory('srv-st', { collectedAt: Date.now() });
  assert.equal(C.inventoryStale('srv-st', 3600_000), false);
  C.markInventoryStale('srv-st');
  assert.equal(C.inventoryStale('srv-st', 3600_000), true, '표시하면 다음 폴링에서 다시 읽는다');
  C.setInventory('srv-st', { collectedAt: Date.now() });
  assert.equal(C.inventoryStale('srv-st', 3600_000), false, '다시 읽으면 표시가 풀린다');
});

test('받는 라우터 — 꺼짐 · 틀린 비밀은 본문을 읽기 전 404 · 꼴 400 · 64KB 넘으면 413 · 서버 모름 · 등록부 밖 404 · 객체 값이 던지지 않음 · 받으면 202 · 다른 경로 404', async (t) => {
  const express = (await import('express')).default;
  const { bmEventsRouter } = await import('../src/routes/bmEvents.js');
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'srv-9', name: 'synth-db-09', host: 'https://192.0.2.29', username: 'u', password: 'p', serviceTag: 'SYNTH09' }], 'replace');
  const app = express();
  app.use('/api/bm-events', bmEventsRouter);
  app.use((err, _req, res, _next) => res.status(err?.status || 500).end());
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const url = (sec) => `http://127.0.0.1:${srv.address().port}/api/bm-events/in/${sec}`;
  const post = (sec, body) => fetch(url(sec), { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(5000) }).then((r) => r.status);
  E.eventSubStore._resetForTest(); E._resetEventsForTest();
  const runs = []; E._setEventDepsForTest({ runCheck: async (r, ids) => { runs.push(ids); return { busy: false }; } });
  try {
    assert.equal(await post('anything', { Events: [] }), 404, '꺼짐');
    E.eventSubStore.save({ enabled: true, base: BASE });
    const s = E.eventSubStore.get();
    const big = JSON.stringify({ Events: [{ Message: 'x'.repeat(100 * 1024) }] });
    assert.equal(await post('wrong', big), 404, '틀린 비밀은 큰 본문도 읽기 전 404(413 이 아니다)');
    assert.equal(await post(s.secret, big), 413, '맞는 비밀 · 64KB 넘음');
    assert.equal(await post(s.secret, '{"Events":"x"}'), 400);
    assert.equal(await post(s.secret, { Context: 'dvc:nope:aaaaaaaaaaaaaaaa', Events: [{ Severity: 'Critical' }] }), 404, '서버 모름');
    assert.equal(await post(s.secret, { Context: E.contextOf(s, 'srv-nobody'), Events: [{ Severity: 'Critical' }] }), 404, '등록부 밖 id(반증 A9)');
    assert.equal(await post(s.secret, { Context: { toString: 1 }, Events: [{ MessageSeverity: { toString: 1 }, Message: ['x'] }] }), 404, '객체 값 — 던지지 않고 답한다(반증 A6)');
    assert.equal(await post(s.secret, { Context: E.contextOf(s, 'srv-9'), Events: [{ MessageSeverity: { toString: 1 } }, { MessageSeverity: 'Critical', Message: 'PSU lost' }] }), 202);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(runs, [['srv-9']]);
    assert.equal(E.eventStatus().recent[0].name, 'synth-db-09');
    assert.equal((await fetch(`http://127.0.0.1:${srv.address().port}/api/bm-events/other`)).status, 404);
    assert.equal((await fetch(url(s.secret))).status, 404, 'GET 은 없다');
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); fs.rmSync(path.join(tmp, 'bm-events.json'), { force: true }); E.eventSubStore._resetForTest(); }
});

test('구독 한 장비 — 이 포탈 꼴만 지움(다른 도구 구독은 둠) · 같은 것은 둠 · 새로 걸기 본문 · 지우기 · 지원 안 함 · 401 · 거절 사유 · 인증 정지', async () => {
  const s = { enabled: true, base: BASE, secret: 'D'.repeat(43) };
  const mk = (subs, postRes = { status: 201, ok: true, text: '' }) => {
    const calls = [];
    return { calls,
      getJson: async (_e, p) => {
        if (p === '/redfish/v1/EventService/Subscriptions') { if (subs === 404) throw Object.assign(new Error('x -> 404'), { status: 404 }); return { Members: Object.keys(subs).map((id) => ({ '@odata.id': `/redfish/v1/EventService/Subscriptions/${id}` })) }; }
        return subs[p.split('/').pop()];
      },
      send: async (_e, m, p, b) => { calls.push([m, p, b]); return m === 'POST' ? postRes : { status: 204, ok: true, text: '' }; } };
  };
  const E1 = { id: 'srv-1', host: 'https://192.0.2.21', username: 'u', password: 'p' };
  let d = mk({ a: { Destination: 'https://other.example.test/hook', Context: 'x' }, b: { Destination: `${BASE}/api/bm-events/in/OLDSECRET`, Context: 'dvc:srv-1:old' } });
  let r = await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, r.removed], ['subscribed', 1]);
  assert.deepEqual(d.calls.map((c) => [c[0], c[1]]), [['DELETE', '/redfish/v1/EventService/Subscriptions/b'], ['POST', '/redfish/v1/EventService/Subscriptions']], '다른 도구 구독(a)은 지우지 않는다');
  assert.deepEqual(d.calls[1][2], { Destination: E.destinationOf(s), Protocol: 'Redfish', Context: E.contextOf(s, 'srv-1'), EventTypes: ['Alert'] });
  d = mk({ c: { Destination: E.destinationOf(s), Context: E.contextOf(s, 'srv-1') } });
  r = await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, d.calls.length], ['subscribed', 0], '이미 같은 것 — 아무것도 보내지 않는다');
  r = await E.syncOne(E1, s, { unsubscribe: true, getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, r.removed, d.calls.map((c) => c[0])], ['removed', 1, ['DELETE']]);
  d = mk(404);
  assert.equal((await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => false })).status, 'not-supported');
  d = mk({}, { status: 400, ok: false, text: JSON.stringify({ error: { '@Message.ExtendedInfo': [{ Message: 'Destination is not reachable.' }] } }) });
  r = await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, r.message], ['error', 'Destination is not reachable.']);
  d = mk({}, { status: 401, ok: false, text: '' });
  assert.equal((await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => false })).status, 'auth');
  d = mk({});
  r = await E.syncOne(E1, s, { getJson: d.getJson, send: d.send, authStopped: () => true });
  assert.deepEqual([r.status, d.calls.length], ['auth-stopped', 0]);
});

test('구독 전부(뒤에서) — 켜짐 · 주소가 있어야 · 진행 중 거절 · 끝나면 onDone · 꺼진 등록은 건너뜀', async () => {
  E._resetSyncForTest(); E.eventSubStore._resetForTest();
  assert.equal(E.startSync({}).ok, false, '꺼져 있으면 걸지 않는다');
  E.eventSubStore.save({ enabled: true, base: BASE });
  let release; const gate = new Promise((r) => { release = r; });
  const seen = [];
  const run = async ({ unsubscribe }) => { await gate; return E.syncAll({ unsubscribe, entries: [{ id: 'a', host: 'h' }, { id: 'b', host: 'h', enabled: false }, { id: 'c' }], one: async (e) => { seen.push(e.id); return { id: e.id, status: 'subscribed', removed: 0 }; } }); };
  let done = null;
  try {
    assert.equal(E.startSync({ run, onDone: (x) => { done = x; } }).ok, true);
    assert.equal(E.startSync({ run }).busy, true);
    assert.equal(E.syncStatus().running, true);
    release(); await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual([done.running, done.results.map((x) => x.id), seen], [false, ['a'], ['a']], '꺼진 등록 · 주소 없는 등록은 건너뛴다');
  } finally { E._resetSyncForTest(); fs.rmSync(path.join(tmp, 'bm-events.json'), { force: true }); E.eventSubStore._resetForTest(); }
});

test('실제 redfishSend 왕복 — 가짜 iDRAC 에 DELETE · POST(본문 · 머리글)', async (t) => {
  const express = (await import('express')).default;
  const hits = [];
  const app = express();
  app.use('/bmc', express.json(), (req, res) => {
    hits.push([req.method, req.url, req.method === 'POST' ? req.body : null, req.headers['content-type'] || '']);
    if (req.method === 'GET' && req.url === '/redfish/v1/EventService/Subscriptions') return res.json({ Members: [{ '@odata.id': '/redfish/v1/EventService/Subscriptions/7' }] });
    if (req.method === 'GET' && req.url === '/redfish/v1/EventService/Subscriptions/7') return res.json({ Destination: `${BASE}/api/bm-events/in/OLD`, Context: 'x' });
    if (req.method === 'DELETE') return res.status(204).end();
    if (req.method === 'POST') return res.status(201).json({});
    return res.status(404).json({});
  });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const s = { enabled: true, base: BASE, secret: 'F'.repeat(43) };
  const r = await E.syncOne({ id: 'srv-r', host: `http://127.0.0.1:${srv.address().port}/bmc`, username: 'root', password: 'pw' }, s, { authStopped: () => false });
  assert.deepEqual([r.status, r.removed], ['subscribed', 1], JSON.stringify(r));
  const del = hits.find((h) => h[0] === 'DELETE'); const post = hits.find((h) => h[0] === 'POST');
  assert.deepEqual([del[1], del[3]], ['/redfish/v1/EventService/Subscriptions/7', ''], 'DELETE 는 본문 · Content-Type 없이');
  assert.deepEqual([post[2].Destination, post[2].Protocol, post[3]], [E.destinationOf(s), 'Redfish', 'application/json']);
});

test('관리자 라우트 — 읽기 · 설정은 관리자 · 전체 범위 · 응답에 비밀 없음 · 감사 · 구독 걸기는 뒤에서(202) · 진행 중 409', async () => {
  const { registerBmAssets } = await import('../src/routes/admin/bmAssets.js');
  const routes = new Map();
  registerBmAssets({ get: (p, ...h) => routes.set(`GET ${p}`, h), put: (p, ...h) => routes.set(`PUT ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h), delete: () => {} });
  const U = (username, role, vcenters = []) => ({ username, role, scope: { vcenters, regions: [], writeVcenters: [] } });
  const ADMIN = U('admin', 'admin'); const OPER = U('oper1', 'operator'); const SCOPED = U('scoped', 'admin', ['vc-a']);
  const call = async (key, { user = ADMIN, body = {} } = {}) => {
    const res = { statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; }, set() { return this; }, setHeader() {} };
    const req = { user, body, query: {}, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0] };
    for (const h of routes.get(key)) {
      let called = false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => { const nx = (err) => { if (err) reject(err); else { called = true; resolve(); } }; Promise.resolve(h(req, res, nx)).then(() => { if (!called) resolve(); }, reject); });
      if (!called || res.headersSent) break;
    }
    return res;
  };
  const audit = () => { try { return fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x).action); } catch { return []; } };
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
  E.eventSubStore._resetForTest(); E._resetSyncForTest();
  const rr = (await import('../src/idrac/registry.js')).importServers([{ id: 'srv-9', name: 'synth-db-09', host: 'https://192.0.2.29', username: 'u', password: 'p', enabled: false }], 'replace');   // 켜진 장비 없는 등록부 — 구독 걸기가 바로 끝난다(앞 시험의 서버에 닿지 않게)
  assert.equal(rr.ok, true, JSON.stringify(rr).slice(0, 200));
  try {
    assert.equal((await call('GET /bm-events', { user: OPER })).statusCode, 403);
    assert.equal((await call('PUT /bm-events', { user: SCOPED, body: { enabled: true, base: BASE } })).statusCode, 403);
    assert.equal((await call('PUT /bm-events', { body: { enabled: true, base: 'http://x' } })).statusCode, 400);
    const a0 = audit().length;
    const p = await call('PUT /bm-events', { body: { enabled: true, base: BASE } });
    assert.deepEqual([p.statusCode, p.body.settings.enabled, p.body.settings.hasSecret], [200, true, true]);
    assert.match(audit().slice(a0)[0], /이벤트 구독 설정 저장/);
    const secret = E.eventSubStore.get().secret;
    const g = (await call('GET /bm-events')).body;
    assert.ok(!JSON.stringify(g).includes(secret), 'GET 응답에 비밀 없음');
    assert.equal(g.destinationPreview, `${BASE}/api/bm-events/in/…`);
    assert.ok(!JSON.stringify(p.body).includes(secret), 'PUT 응답에 비밀 없음');
    assert.equal((await call('POST /bm-events/sync', { user: OPER })).statusCode, 403);
    // 인증이 켜진 포탈 — 본인 OTP 가 없으면 장비 설정을 바꾸지 못한다
    const noOtp = await call('POST /bm-events/sync');
    assert.deepEqual([noOtp.statusCode, noOtp.body.needEnroll || noOtp.body.needOtp], [403, true]);
    // 장비가 없는 등록부 — 바로 끝나고 감사(OTP 게이트는 인증이 꺼진 포탈에서 통과)
    const { config } = await import('../src/config.js');
    const prevAuth = config.auth.enabled; config.auth.enabled = false;
    let s1; try { s1 = await call('POST /bm-events/sync'); } finally { config.auth.enabled = prevAuth; }
    assert.deepEqual([s1.statusCode, s1.body.started], [202, true]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await call('GET /bm-events')).body.sync.running, false);
    assert.ok(audit().includes('물리서버 이벤트 구독 걸기'));
  } finally { store.snapshot = prev; E._resetSyncForTest(); fs.rmSync(path.join(tmp, 'bm-events.json'), { force: true }); E.eventSubStore._resetForTest(); }
});

test('경계 — 지우기 401 뒤 멈춤 · 동시 실행 거절 · 데모 막이 · 짧은 비밀 · 파일의 비밀은 금고 정책대로(평문이면 0600)', async () => {
  const s = { enabled: true, base: BASE, secret: 'G'.repeat(43), ctxKey: 'H'.repeat(43) };
  const calls = [];
  const getJson = async (_e, p) => (p === '/redfish/v1/EventService/Subscriptions' ? { Members: [{ '@odata.id': '/redfish/v1/EventService/Subscriptions/1/' }, { '@odata.id': '/redfish/v1/EventService/Subscriptions/2' }] } : { Destination: `${BASE}/api/bm-events/in/OLD`, Context: 'x' });
  const send = async (_e, m, p) => { calls.push([m, p]); return { status: 401, ok: false, text: '' }; };
  const r = await E.syncOne({ id: 'srv-1' }, s, { getJson, send, authStopped: () => false });
  assert.deepEqual([r.status, calls.length], ['auth', 1], '지우기 401 뒤 더 보내지 않는다(변이 M44) · 끝 슬래시 구독도 지운다(반증 A4)');
  assert.equal(calls[0][1], '/redfish/v1/EventService/Subscriptions/1/');
  // syncAll 동시 실행 거절(변이 M47)
  E._resetSyncForTest(); E.eventSubStore._resetForTest();
  E.eventSubStore.save({ enabled: true, base: BASE });
  let release; const gate = new Promise((x) => { release = x; });
  const p1 = E.syncAll({ entries: [{ id: 'a', host: 'h' }], one: async (e) => { await gate; return { id: e.id, status: 'subscribed', removed: 0 }; } });
  const p2 = await E.syncAll({ entries: [{ id: 'a', host: 'h' }], one: async (e) => ({ id: e.id, status: 'subscribed', removed: 0 }) });
  assert.equal(p2.busy, true); release(); assert.equal((await p1).ok, true);
  // 데모 막이(변이 M46) — 합성 등록부로 장비에 나가지 않는다
  const { stripComments } = await import('./_stripComments.js');
  const src = stripComments(fs.readFileSync(new URL('../src/idrac/eventSub.js', import.meta.url), 'utf8'));
  assert.match(src, /if \(!entries && \(await import\('\.\.\/mock\/demo\/flags\.js'\)\)\.isMockMode\(\)\) return \{ ok: true, results: list\.map/);
  // 파일 — 비밀은 금고 정책대로(봉인 또는 평문) · 다시 열면 같은 값 · 0600(반증 A16)
  const { openSecret } = await import('../src/security/secretVault.js');
  const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'bm-events.json'), 'utf8'));
  const { sealSecret } = await import('../src/security/secretVault.js');
  const encrypted = sealSecret('probe-value-0123456789') !== 'probe-value-0123456789';   // 이 환경의 금고 정책(암호화면 봉인돼야 한다 · 평문 정책이면 같다 — 변이 S20)
  assert.equal(raw.secret !== E.eventSubStore.get().secret, encrypted);
  assert.equal(openSecret(raw.secret), E.eventSubStore.get().secret);
  assert.equal(openSecret(raw.ctxKey), E.eventSubStore.get().ctxKey);
  assert.notEqual(E.eventSubStore.get().secret, E.eventSubStore.get().ctxKey, '두 열쇠는 다르다');
  assert.equal(fs.statSync(path.join(tmp, 'bm-events.json')).mode & 0o777, 0o600);
  // 짧은 비밀(손상 · 손으로 고친 파일) — 꺼짐(변이 M60)
  E.eventSubStore._resetForTest();
  fs.writeFileSync(path.join(tmp, 'bm-events.json'), JSON.stringify({ v: 1, enabled: true, base: BASE, secret: 'short', ctxKey: 'H'.repeat(43) }));
  assert.equal(E.eventSubStore.get().enabled, false);
  E._resetSyncForTest(); fs.rmSync(path.join(tmp, 'bm-events.json'), { force: true }); E.eventSubStore._resetForTest();
});
