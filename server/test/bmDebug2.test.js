// 물리서버 기능 디버깅 회차 2(v3.52 — 1회차 수정 반영본 196145835 · 5축 × 1인) 회귀. 1회차 수정이 만든 회귀(엣지 상한 동시 요청 · 기록 정규식 O(n²) ·
//   받는 주소를 바꾼 뒤 옛 구독 · 정책 왕복)와 남은 경로를 고정한다. 픽스처는 합성(SYNTH · 192.0.2.x · example.test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug2-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', COLLECTOR_TOKEN: 'tok-dbg2' });
delete process.env.CENTRAL_URL;
const { stripComments } = await import('./_stripComments.js');
const src = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

test('보안 — 데모 차단은 겹친 빗금으로 우회되지 않는다 · 기록 지우기는 선형 · 받는 주소를 바꾼 뒤의 옛 구독도 이 포탈 것이면 지운다', async () => {
  const G = await import('../src/auth/demoGuest.js');
  for (const u of ['/api/admin//bm-power', '/api//admin/bm-events', '/api/admin///users?x=1']) assert.ok(G.demoGuestDenial('GET', u), u);
  const E = await import('../src/idrac/eventSub.js');
  assert.equal(E.scrubEventPath('//api//bm-events//in//SECRETSECRET?x=1'), '//api//bm-events//in//…?x=1');
  assert.equal(E.scrubEventPath('/api/bm-events/in/SECRETSECRET'), '/api/bm-events/in/…');
  const long = `/${'/'.repeat(16_000)}x`;
  const t0 = performance.now(); E.scrubEventPath(long); E.scrubEventPath(`/api${'/'.repeat(16_000)}bm-events`);
  assert.ok(performance.now() - t0 < 30, `빗금 16,000개 ${Math.round(performance.now() - t0)}ms`);
  // 받는 주소를 바꾼 뒤 — 옛 주소의 구독(Context 가 이 포탈 열쇠로 맞음)은 지우고, 다른 포탈(다른 열쇠)의 것은 둔다
  const s = { enabled: true, base: 'https://portal-new.example.test', secret: 'A'.repeat(43), ctxKey: 'B'.repeat(43) };
  const other = { ...s, ctxKey: 'C'.repeat(43) };
  const subs = {
    1: { Destination: `https://portal-old.example.test/api/bm-events/in/${'A'.repeat(43)}`, Context: E.contextOf(s, 'srv-1') },
    2: { Destination: 'https://portal-b.example.test/api/bm-events/in/OTHER', Context: E.contextOf(other, 'srv-1') },
    3: { Destination: 'https://hook.example.test/x', Context: 'z' },
  };
  const calls = [];
  const out = await E.syncOne({ id: 'srv-1' }, s, { unsubscribe: true, authStopped: () => false,
    getJson: async (_e, p) => (p === '/redfish/v1/EventService/Subscriptions' ? { Members: Object.keys(subs).map((k) => ({ '@odata.id': `/redfish/v1/EventService/Subscriptions/${k}` })) } : subs[p.split('/').pop()]),
    send: async (_e, m, p) => { calls.push(p); return { status: 204, ok: true, text: '' }; } });
  assert.deepEqual([out.removed, calls], [1, ['/redfish/v1/EventService/Subscriptions/1']]);
});

test('엣지 — 10분 상한은 동시 요청에도 지켜진다(자리를 먼저 잡음) · 낡은 등록(id = 태그)보다 장비가 지금 말하는 태그 · 자리표시 태그는 대조하지 않음 · 보내기 전 시한은 ‘모름’ 이 아님', async (t) => {
  const express = (await import('express')).default;
  const registry = await import('../src/idrac/registry.js');
  const inv = await import('../src/idrac/invCache.js');
  const P = await import('../src/idrac/power.js');
  let patches = 0;
  const app = express();
  app.use('/bmc', express.json(), async (req, res) => {
    await new Promise((r) => setTimeout(r, 120));   // 요청이 겹치게
    if (req.url === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] });
    if (req.method === 'GET') return res.json({ PowerState: 'On', IndicatorLED: 'Off', Actions: {} });
    patches += 1; return res.status(204).end();
  });
  const { collectorRouter } = await import('../src/routes/collector.js');
  app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); for (const k of ['BM_POWER_EDGE_ENABLE', 'BM_POWER_EDGE_MAX']) delete process.env[k]; });
  const base = `http://127.0.0.1:${srv.address().port}`;
  registry.importServers([
    ...Array.from({ length: 8 }, (_, i) => ({ id: `c${i}`, name: `synth-c${i}`, host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: `SYNTHC${i}` })),
    { id: 'SYNTHA1', name: 'synth-stale', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'SYNTHA1' },
    { id: 'fresh', name: 'synth-fresh', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: '' },
  ], 'replace');
  inv.setInventory('SYNTHA1', { collectedAt: Date.now(), system: { serviceTag: 'SYNTHB2' } });   // 주소가 다른 장비로 재배정된 낡은 등록
  inv.setInventory('fresh', { collectedAt: Date.now(), system: { serviceTag: 'SYNTHA1' } });
  const post = (body) => fetch(`${base}/api/collector/bm-power`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-collector-token': 'tok-dbg2' }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
  process.env.BM_POWER_EDGE_ENABLE = 'true'; process.env.BM_POWER_EDGE_MAX = '3';
  P._resetPowerGapForTest();
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post({ id: `c${i}`, kind: 'led', action: 'on' })));
  assert.equal(rs.filter((r) => r.s === 200 && r.b?.status === 'accepted').length, 3, `동시 8건 중 3건만 — ${rs.map((r) => r.s).join(',')}`);
  assert.equal(patches, 3);
  assert.equal(rs.filter((r) => r.s === 429).length, 5);
  // 낡은 등록 — k 가 등록 id 와 같아도 장비가 지금 말하는 태그가 다르면 후보가 아니다
  delete process.env.BM_POWER_EDGE_MAX; P._resetPowerGapForTest();
  assert.match(src('../src/routes/collector.js'), /const stale = \(e\) => \{ const it = invTag\(e\); return !!it && it !== k && lc\(e\.serviceTag\) === k; \};/);
  const r1 = await post({ k: 'syntha1', kind: 'led', action: 'off' });
  assert.equal(r1.s, 200, '장비가 SYNTHA1 이라 말하는 등록으로 간다');
  // 자리표시 태그 · 보내기 전 시한
  P._resetPowerGapForTest();
  const sys = { PowerState: 'On', SKU: 'TO BE FILLED BY O.E.M.', IndicatorLED: 'Off', Actions: {} };
  const r2 = await P.runDeviceAction({ id: 'w1', host: 'h', serviceTag: 'To Be Filled By O.E.M.' }, { kind: 'led', action: 'on', authStopped: () => false,
    getJson: async (_e, p) => (p === '/redfish/v1/Systems' ? { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] } : sys), send: async () => ({ status: 204, ok: true, text: '' }) });
  assert.equal(r2.tagChecked, false, '자리표시 태그끼리는 대조했다고 말하지 않는다');
  P._resetPowerGapForTest();
  const r3 = await P.runDeviceAction({ id: 'w2', host: 'h', serviceTag: 'SYNTHW2' }, { kind: 'power', action: 'on', authStopped: () => false,
    getJson: async () => { throw new Error('시한 초과(timeout)'); }, send: async () => ({ status: 204, ok: true, text: '' }) });
  assert.deepEqual([r3.status, r3.sent], ['error', false], '조회 단계의 시한은 보내지 않은 것이다');
});

test('판정 — 정책이 오가도 진행을 지우지 않는다(10분마다 오가도 단계가 간다 · 같은 정책 단계는 한 번) · 채널 열쇠에 정책 · 세대 · 권고 모델은 낱말 집합이 같을 때만 · 시각 모름 경고 슬롯', async () => {
  const X = await import('../src/partfault/escalation.js');
  const R = await import('../src/partfault/escalationRun.js');
  const POL = (id, states, em) => ({ id, name: id, agents: [], states, steps: [{ afterMin: 15, emails: [em], channels: false, oncall: false }, { afterMin: 60, emails: [em], channels: false, oncall: false }] });
  const S = { enabled: true, enabledAt: 1, policies: [POL('team-a', ['fault'], 'a@example.test'), POL('team-b', ['warn'], 'b@example.test')], oncall: {} };
  const part = (state) => ({ agent: '', partKey: 'k1', scope: 'idrac', kind: 'psu', partId: 'p1', deviceId: 'SYNTH01', deviceName: 'synth-db-01', label: 'PSU 1', state });
  const MIN = 60_000; let st = { items: {}, enabledAt: 1 }; const sent = [];
  for (let m = 0; m <= 180; m += 10) {
    const p = part((m / 10) % 2 ? 'fault' : 'warn');
    const pl = X.escalationPlan({ settings: S, state: st, open: [p], now: m * MIN });
    for (const s of pl.sends) sent.push(`${s.policy.id}:${s.step}`);
    st = { items: X.recordSends(pl.items, pl.sends, pl.sends.map(() => ({ text: 'x', delivered: true })), m * MIN), enabledAt: pl.enabledAt };
  }
  assert.ok(sent.length > 0, '10분마다 오가도 단계가 간다(1회차 수정 뒤에는 0건이었다)');
  assert.equal(new Set(sent).size, sent.length, `같은 정책 단계를 두 번 보내지 않는다 — ${sent.join(',')}`);
  const key = R.escalationMessage({ part: part('fault'), policy: { id: 'team-a', name: 'a' }, step: 0, attempt: 1, since: 1234, to: { emails: [], channels: false, oncall: null } }, 2000).key;
  assert.equal(key, 'partfault-esc:|k1:team-a:1234:0:1');
  const A = await import('../src/bmcheck/advisory.js');
  assert.equal(A.modelTokensMatch('ProLiant DL380 Gen10 Plus', 'DL380 Gen10'), false);
  assert.equal(A.modelTokensMatch('ThinkSystem SR650 V2', 'SR650'), false);
  assert.equal(A.modelTokensMatch('ProLiant DL380 Gen10', 'DL380 Gen10'), true);
  assert.equal(A.modelTokensMatch('PowerEdge R740xd', 'R740xd'), true);
  const L = await import('../src/idrac/partLife.js');
  const m = L.memCeOf({ status: 'ok', total: 1, read: 1, rows: [{ at: null, msg: 'Correctable memory error rate exceeded for DIMM_A1.' }] }, { now: Date.UTC(2026, 10, 26), dimms: ['DIMM.Socket.A1'] });
  assert.equal(m.untimed, 1); assert.ok(Array.isArray(m.uslots) && m.uslots.length === 1, JSON.stringify(m));
});

test('저장 · 엣지 — 상한을 넘은 케이스 파일도 줄이는 편집은 된다 · 미룬 서버는 한 대로 · 등록부 못 읽음은 없음이 아니다 · 엣지 로그 당김의 겹침 · 등록부 사유 · 어긋난 수명 요약', async () => {
  const S = await import('../src/bmcheck/store.js');
  const w = (n) => '가'.repeat(n);
  const big = {};
  for (let i = 0; i < 1600; i += 1) big[`case-${String(i).padStart(6, '0')}`] = { tag: 'synthtag', corp: 'vc-a', part: w(120), caseNo: w(64), status: 'open', note: w(500), by: w(80), at: 1, created: 1, hist: Array.from({ length: 20 }, () => ({ at: 1, by: w(80), status: 'open', caseNo: w(64) })) };
  assert.equal(S.caseStore.save({ v: 1, cases: big }, { shrinking: true }).ok, true);
  const first = Object.keys(big)[0];
  const closed = { ...big, [first]: { ...big[first], status: 'closed', note: '끝' } };
  assert.equal(S.caseStore.save({ v: 1, cases: closed }).ok, true, '상한을 넘은 파일에서도 줄이는 편집(끝남으로)');
  const grown = { ...closed, 'case-zzzzzz': { ...big[first] } };
  assert.equal(S.caseStore.save({ v: 1, cases: grown }).status, 413, '커지는 쓰기는 막는다');
  S.caseStore.save({ v: 1, cases: {} }, { shrinking: true });
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 60_000, runCheck: async () => ({ busy: false }) });
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    for (let i = 0; i < E.EVT_BATCH_MAX; i += 1) E.acceptEvents(s, { context: E.contextOf(s, `d-${i}`), events: [{ sev: 'critical' }] });
    for (let j = 0; j < 3; j += 1) E.acceptEvents(s, { context: E.contextOf(s, 'd-over'), events: [{ sev: 'critical' }] });
    assert.equal(E.eventStatus().deferred, 1, '같은 서버가 세 번 보내도 한 대');
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); }
  assert.match(src('../src/routes/bmEvents.js'), /if \(id && name === undefined\) return res\.status\(503\)\.end\(\);/);
  assert.match(src('../src/idrac/eventSub.js'), /if \(R\.registryLoadError\(\)\) return \{ ok: false, reason: 'iDRAC 등록부를 읽지 못했습니다/);
  assert.match(src('../src/routes/api/bmFolders.js'), /if \(regErr\) return res\.json\(\{ ok: true, why: 'registry-unreadable' \}\);/);
  const hp = src('../src/central/bmHwLogPull.js');
  assert.match(hp, /r\.body\.code === 'ambiguous'\) return \{ ok: false, kind: 'edge-ambiguous'/);
  assert.match(hp, /r\.body\.code === 'registry-unreadable'\) return \{ ok: false, kind: 'edge-registry'/);
  assert.match(src('../src/idrac/hwSummary.js'), /if \(read > 0 && min == null\) return \{\};/);
});

test('화면 — 행 표지 사유는 지금 상태로(재시작 뒤 첫 회차 전에도 데모 · 점검 꺼짐 · 진행 기록 못 읽음이면 ‘보내지 않음’)', async () => {
  const R = await import('../src/partfault/escalationRun.js');
  const base = { partFaultSwitch: async () => ({ enabled: true, source: 'demo' }) };
  R._setEscalationDepsForTest(base);
  try {
    assert.equal((await R.escalationMarksNow()).why, 'demo', '회차가 한 번도 돌지 않았어도');
    R._setEscalationDepsForTest({ partFaultSwitch: async () => ({ enabled: false, source: 'env' }) });
    assert.equal((await R.escalationMarksNow()).why, 'partfault-off');
    R._setEscalationDepsForTest({ partFaultSwitch: async () => ({ enabled: true, source: 'env' }) });
    assert.equal((await R.escalationMarksNow()).why, '');
  } finally { R._setEscalationDepsForTest(null); }
  assert.match(src('../src/routes/api/partFaults.js'), /const escRun = await escalationMarksNow\(\)\.catch\(\(\) => null\);/);
});
