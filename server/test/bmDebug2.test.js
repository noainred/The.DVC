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
  // 선형 — 시작이 ‘api 바로 앞 빗금 하나’ 이고(앞 \/+ 없음) 입력은 4KB 로 자른다(시간 단언 대신 꼴로 — TESTDOC2613-02)
  assert.ok(E.scrubEventPath(`/${'/'.repeat(16_000)}x`).length <= 4096, '4KB 로 자른다');
  const es0 = src('../src/idrac/eventSub.js');
  assert.ok(es0.includes(".slice(0, 4096).replace(") && es0.includes("replace(/(\\/api\\/+bm-events\\/+in\\/+)"), '4KB 자르기 · api 바로 앞 빗금에서 시작');
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
  assert.match(src('../src/routes/bmEvents.js'), /if \(id && name === undefined\) \{ noteUnreadable\(\); return res\.status\(503\)\.end\(\); \}/);
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

test('성능 — 정규 주기는 이벤트 읽기를 기다렸다 돈다(건너뛰지 않음) · 밀려난 기억은 타이머도 지움 · 같은 모델 대비는 자리 계산 · 서명은 해시 · 원장 백업 상한 · 이벤트 로그 동시 상한', async () => {
  const ps = src('../src/idrac/poller.js');
  // 4회차: 이벤트 읽기와 정규 주기는 서로 기다리지 않고 서버 단위로만 겹침을 피한다
  assert.match(ps, /if \(_eventIds\.has\(sid\)\) \{ releaseSlot\(\); results\.push\(\{ id: s\.id, name: s\.name, type: s\.type \|\| 'idrac', eventBusy: true \}\); return; \}/);
  // 5회차 성능: 이벤트 읽기는 그 서버만 기다린다 · 정규 주기는 이벤트가 맡은 서버의 인벤토리를 넘긴다 · 동시 상한 하나
  assert.match(ps, /for \(let i = 0; i < 4 && _cycleInflight\.has\(sid\); i \+= 1\) await _cycleInflight\.get\(sid\);/);
  assert.match(ps, /inventoryStale\(s\.id, INVENTORY_MAX_AGE_MS\) && !_eventPending\.has\(String\(s\.id\)\)/);
  assert.equal((ps.match(/await acquireSlot\(\);/g) || []).length, 2, '정규 · 이벤트 둘 다 같은 상한');
  assert.match(ps, /if \(_cycleInflight\.has\(sid\)\) \{ skippedForCycle\.push\(sid\); return; \}/, '이벤트 읽기는 정규 주기가 읽는 서버를 빼고 돌려준다(5회차 엣지 #1)');
  assert.doesNotMatch(ps, /_runningEventP|_cycleWaiting/);
  assert.match(src('../src/routes/api/bmFolders.js'), /const drop = \(k\) => \{ const old = _trendMemo\.get\(k\); if \(old\?\.timer\) clearTimeout\(old\.timer\);/);
  assert.match(src('../src/routes/collector.js'), /const drop = \(k2\) => \{ const old = _hwlogMemo\.get\(k2\); if \(old\?\.timer\) clearTimeout\(old\.timer\);/);
  const L = await import('../src/idrac/partLife.js');
  const disks = Array.from({ length: 1024 }, (_, i) => ({ name: `Disk ${i}`, model: 'SYNTH', media: 'SSD', capacityGB: 960, lifeLeftPct: i === 5 ? 40 : 90 + (i % 5) }));
  const rows = L.ssdLifeRows(disks);
  assert.doesNotMatch(src('../src/idrac/partLife.js'), /g\.filter\(\(x\) => x !== r\)/, '줄마다 나머지를 다시 정렬하지 않는다(O(n² log n))');
  assert.ok(rows.some((r) => r.name === 'Disk 5' && r.gap != null), '혼자 닳은 SSD 는 표지');
  // 자기를 뺀 가운데값이 예전 계산(나머지 정렬)과 같다
  const vals = Array.from({ length: 41 }, (_, i) => (i === 3 ? 55 : i === 17 ? 61 : 80 + ((i * 7) % 15)));
  const few = vals.map((v, i) => ({ name: `d${i}`, model: 'M', media: 'SSD', lifeLeftPct: v }));
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const want = vals.map((v, i) => { const g = Math.round((med(vals.filter((_, j) => j !== i)) - v) * 10) / 10; return g >= L.LIFE_PEER_GAP ? g : null; });
  assert.deepEqual(L.ssdLifeRows(few).map((r) => r.gap), want);
  assert.ok(want.filter((x) => x != null).length >= 2, '시험이 공허하지 않다');
  assert.match(src('../src/bmcheck/advisory.js'), /crypto\.createHash\('sha1'\)/);
  const B = await import('../src/backup/service.js');
  for (const f of ['bm-assets.json', 'bm-fw-baseline.json', 'bm-cases.json']) assert.ok(B.fileCapFor(f) > 16 * 1024 * 1024, f);
  const H = await import('../src/idrac/hwLog.js');
  assert.ok(H.HWLOG_CONCURRENCY >= 1 && H.HWLOG_CONCURRENCY <= 16);
  let open = 0; let peak = 0;
  const slow = async () => { open += 1; peak = Math.max(peak, open); await new Promise((r) => setTimeout(r, 50)); open -= 1; return { ok: true, status: 'ok', rows: [] }; };
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => H.readHwLogLimited({ id: `h${i}`, host: 'x' }, { getJson: async () => { await slow(); return { Members: [] }; } })));
  assert.equal(rs.filter((r) => r.kind === 'busy').length, 10 - H.HWLOG_CONCURRENCY, '상한을 넘은 요청은 장비에 묻지 않는다');
});

test('3회차 보안 — 절대 꼴 요청 대상도 데모 차단 · 돌려주는 요청은 감사 줄 없이 · 비밀을 새로 만들어도 Context 열쇠는 그대로', async () => {
  const G = await import('../src/auth/demoGuest.js');
  for (const u of ['http://h.example.test/api/admin/users', 'HTTPS://h.example.test:8443/api/admin//bm-power?x=1', 'http://h/api/admin/audit']) assert.ok(G.demoGuestDenial('GET', u), u);
  assert.equal(G.normApiPath('http://h.example.test/api/tools/x'), '/api/tools/x');
  const col = src('../src/routes/collector.js');
  const ia = col.indexOf("if (gap) { release(); return res.json({ ok: false, status: 'busy'");
  assert.ok(ia > 0 && ia < col.indexOf("action: kind === 'power' ? '물리서버 원격 전원 조작 요청(중앙)'"), '간격 거르기가 감사 줄보다 앞');
  const E = await import('../src/idrac/eventSub.js');
  E.eventSubStore.save({ enabled: true, base: 'https://portal-a.example.test', rotate: false }, { by: 't' });
  const k1 = E.eventSubStore.get().ctxKey; const s1 = E.eventSubStore.get().secret;
  E.eventSubStore.save({ enabled: true, base: 'https://portal-b.example.test', rotate: true }, { by: 't' });
  assert.notEqual(E.eventSubStore.get().secret, s1, '받는 주소 비밀은 새로');
  // 4회차: Context 열쇠도 새로 만들고(함께 샌다) 직전 열쇠는 ‘이 포탈 것’ 판정에만
  assert.notEqual(E.eventSubStore.get().ctxKey, k1, 'Context 열쇠도 새로');
  assert.equal(E.eventSubStore.get().prevCtxKey, k1, '직전 열쇠를 남긴다');
  const s2 = E.eventSubStore.get();
  assert.equal(E.idOfContext(s2, E.contextOf({ ctxKey: k1 }, 'srv-9')), '', '옛 Context 로 받지 않는다');
  const subs = { 1: { Destination: `https://portal-a.example.test/api/bm-events/in/${s1}`, Context: E.contextOf({ ctxKey: k1 }, 'srv-9') } };
  const calls = [];
  const out = await E.syncOne({ id: 'srv-9' }, s2, { unsubscribe: true, authStopped: () => false,
    getJson: async (_e, p) => (p === '/redfish/v1/EventService/Subscriptions' ? { Members: [{ '@odata.id': '/redfish/v1/EventService/Subscriptions/1' }] } : subs[p.split('/').pop()]),
    send: async (_e, m, p) => { calls.push(p); return { status: 204, ok: true, text: '' }; } });
  assert.deepEqual([out.removed, calls.length], [1, 1], '받는 주소 · 비밀을 한 번에 바꾼 뒤에도 옛 구독을 지운다');
});

test('3회차 판정 — 새 정책은 그 정책 대상이 된 때부터(1선 팀을 건너뛰지 않음) · 옛 기록은 처음 보는 정책이 넘겨받음 · 권고 모델(제품군 낱말뿐 · 기계 유형 꼬리) · 끝남으로 바꾸기는 상한 밖', async () => {
  const X = await import('../src/partfault/escalation.js');
  const POL = (id, states, e1, e2) => ({ id, name: id, agents: [], states, steps: [{ afterMin: 15, emails: [e1], channels: false, oncall: false }, { afterMin: 60, emails: [e2], channels: false, oncall: false }] });
  const S = { enabled: true, enabledAt: 1, policies: [POL('team-a', ['fault'], 'a1@example.test', 'amgr@example.test'), POL('team-b', ['warn'], 'b1@example.test', 'bmgr@example.test')], oncall: {} };
  const part = (state) => ({ agent: '', partKey: 'k3', scope: 'idrac', kind: 'psu', partId: 'p1', deviceId: 'SYNTH03', deviceName: 'synth-db-03', label: 'PSU 1', state });
  const MIN = 60_000; let st = { items: {}, enabledAt: 1 }; const got = [];
  const run = (state, m) => { const pl = X.escalationPlan({ settings: S, state: st, open: [part(state)], now: m * MIN }); for (const s of pl.sends) got.push(`${m}:${s.to.emails[0]}${s.skipped.length ? `(건너뜀 ${s.skipped.length})` : ''}`); st = { items: X.recordSends(pl.items, pl.sends, pl.sends.map(() => ({ text: 'x', delivered: true })), m * MIN), enabledAt: pl.enabledAt }; };
  run('warn', 0); run('warn', 20); run('warn', 70); run('warn', 180);   // 주의 3시간
  run('fault', 181); run('fault', 190); run('fault', 197); run('fault', 242);
  assert.deepEqual(got, ['20:b1@example.test', '70:bmgr@example.test', '197:a1@example.test', '242:amgr@example.test'], '이상 정책은 181분부터 — 1선(a1)이 먼저');
  // 옛 기록(v3.51 — 정책 열 · ps 없음)은 처음 보는 정책이 넘겨받는다
  st = { items: { '|k3': { since: 0, sig: 'x', sent: [[0, 5 * MIN, 'x', 'ok']], ackedAt: null, ackBy: '' } }, enabledAt: 1 };
  const pl = X.escalationPlan({ settings: S, state: st, open: [part('warn')], now: 30 * MIN });
  assert.deepEqual([pl.sends.length, pl.items['|k3'].sent[0][4], pl.items['|k3'].ps['team-b']], [0, 'team-b', 0], '이미 간 2단계를 다시 보내지 않고 since 를 잇는다');
  const A = await import('../src/bmcheck/advisory.js');
  assert.equal(A.modelTokensMatch('PowerEdge R740xd', 'PowerEdge'), true, '제품군 낱말뿐인 줄은 그 제품군 전부');
  assert.equal(A.modelTokensMatch('ProLiant DL380 Gen10', 'HPE ProLiant'), true, '제조사 이름은 Model 글자에 없다 — 제품군 낱말로 본다(4회차 판정 #2)');
  assert.equal(A.modelTokensMatch('PowerEdge R740xd', 'HPE ProLiant'), false);
  assert.equal(A.modelTokensMatch('ThinkSystem SR650 V2 -[7Z73CTO1WW]-', 'SR650 V2'), true, '긴 기계 유형 꼬리는 판이 아니다');
  assert.equal(A.modelTokensMatch('ProLiant DL380 Gen10 Plus', 'DL380 Gen10'), false);
  assert.equal(A.modelTokensMatch('ThinkSystem SR650 V2', 'SR650'), false);
  assert.match(src('../src/bmcheck/store.js'), /caseStore\.save\(\{ v: 1, cases \}, \{ shrinking: !!cur && cur\.status !== 'closed' && next\.status === 'closed' \}\);/);
});

test('3회차 엣지 — 이름 맞춤은 목록을 한 번만 · 이벤트 표지만 urgent(LED 는 아님) · 수동 수집은 기다리지 않음 · 구독 설정을 못 읽으면 503', async () => {
  const H = await import('../src/bmusage/maint/partfaultHold.js');
  let calls = 0;
  const judge = { stateFor: () => ({ scopes: { hold: true }, windows: [{ id: 'w', scopes: ['hold'], start: 0, end: 1 }], until: { hold: 1 } }) };
  const devs = Array.from({ length: 200 }, (_, i) => ({ agent: 'edge-a', deviceId: `d${i}`, deviceKey: `SYNTHT${i}`, scope: 'idrac' }));
  const tgs = Array.from({ length: 300 }, (_, i) => ({ agent: 'edge-a', key: `t${i}`, serviceTag: `SYNTHT${i}` }));
  const r = H.holdSetFor(devs, tgs, judge, Date.now(), { agentKey: (a) => { calls += 1; return a; } });
  assert.equal(r.hold.size, 200);
  assert.equal(calls, 1, '같은 이름은 한 번만 맞춘다');
  assert.match(src('../src/bmusage/maint/partfaultHold.js'), /return \(a\) => agentKeyOf\(a, rows\);/);
  const C = await import('../src/idrac/invCache.js');
  C.markInventoryStale('led-1'); C.markInventoryStale('ev-1', { event: true });
  assert.deepEqual([C.isForcedStale('led-1'), C.isForcedStale('ev-1'), C.inventoryStale('led-1', 1e12)], [false, true, true], 'LED 는 다시 읽되 urgent 표지는 아니다');
  C.removeInventory('led-1'); C.removeInventory('ev-1');
  assert.match(src('../src/idrac/poller.js'), /if \(only\) \{\n\s*if \(_eventRunning\) return BUSY;/, '수동 · 정규는 이벤트 읽기를 기다리지 않는다');
  assert.match(src('../src/routes/bmEvents.js'), /if \(eventSubStore\.loadError\(\)\) \{ noteUnreadable\(\); return res\.status\(503\)\.end\(\); \}/);
});

test('3회차 화면 · 성능 — 등록부 못 읽음 503 은 ‘모름’ 잠금이 아님 · busy · 밀려난 기억은 쥐지 않음 · 권고 기억은 오래된 것부터 · 이벤트 받기는 등록부 사본 한 번', async () => {
  const bf = src('../src/routes/api/bmFolders.js');
  assert.match(bf, /if \(_trendMemo\.get\(key\) !== ent\) return;/);
  assert.match(bf, /if \(ent\.busy\) \{ _trendMemo\.delete\(key\); return; \}/);
  assert.match(bf, /\.\.\.\(full && \(why === 'edge-fail' \|\| why === 'old-version'\) && r\?\.reason \?/, '따로 문구가 있는 why 에 서버 사유를 덧붙이지 않는다(화면 N4)');
  assert.match(src('../src/routes/collector.js'), /if \(_hwlogMemo\.get\(key\) !== ent\) return;\n\s*if \(ent\.busy\) \{ _hwlogMemo\.delete\(key\); return; \}/);
  assert.match(src('../src/bmcheck/advisory.js'), /while \(ix\.memo\.size >= ADVISORY_MEMO_MAX\) ix\.memo\.delete\(ix\.memo\.keys\(\)\.next\(\)\.value\);/);
  const ev = src('../src/routes/bmEvents.js');
  assert.ok(ev.indexOf('R.loadRegistry().find(') < ev.indexOf('R.registryLoadError()'), '찾은 뒤에만 오류 판정');
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  E._setEventDepsForTest({ debounceMs: 60_000, runCheck: async () => ({ busy: false }) });
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    for (let i = 0; i < E.EVT_BATCH_MAX; i += 1) E.acceptEvents(s, { context: E.contextOf(s, `q-${i}`), events: [{ sev: 'critical' }] });
    E.acceptEvents(s, { context: E.contextOf(s, 'q-over'), events: [{ sev: 'critical' }] });
    assert.match(src('../src/idrac/eventSub.js'), /const ids = \[\.\.\._staleIds\]; _staleIds\.clear\(\);   /, '묶음마다 미룬 서버 집합을 비우지 않는다(화면 R3)');
    assert.equal(E.eventStatus().deferred, 1);
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); }
});

test('4회차 보안 — 데모는 평범한 꼴 주소만(긴 scheme · 4KB authority · 백슬래시 · // 시작) · 기록 지우기는 백슬래시도', async () => {
  const G = await import('../src/auth/demoGuest.js');
  const long = `${'a'.repeat(20)}://h/api/admin/users`;
  for (const u of [long, `http://${'h'.repeat(5000)}/api/admin/users`, '/api\\admin/users#x', 'http://h/api/tools\\network-check', '//h/api/admin/users']) assert.ok(G.demoGuestDenial('GET', u), u.slice(0, 60));
  assert.equal(G.demoGuestDenial('GET', '/api/tools/bm-folders?x=1'), null);
  const E = await import('../src/idrac/eventSub.js');
  assert.equal(E.scrubEventPath('/api\\bm-events\\in\\SECRETSECRET#x'), '/api/bm-events/in/…#x');
  assert.equal(E.scrubEventPath('http://h/api/bm-events\\in\\SECRETSECRET').includes('SECRETSECRET'), false);
});


test('4회차 — 이벤트 읽기와 정규 · 수동 주기는 서로 기다리지 않는다(동작) · 이벤트가 읽는 서버는 그 주기에 eventBusy', async (t) => {
  const express = (await import('express')).default;
  let slowGate = null; const slowStarted = new Promise((r) => { slowGate = r; });
  let release = null; const held = new Promise((r) => { release = r; });
  const app = express();
  app.use('/bmc-slow', async (req, res) => { slowGate(); await held; res.status(404).end(); });   // 이벤트 읽기가 붙잡힌 장비
  app.use('/bmc-fast', (req, res) => res.status(404).end());
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { release(); srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'w-slow', name: 'synth-slow', host: `${base}/bmc-slow`, username: 'u', password: 'p', serviceTag: 'SYNTHW1' },
    { id: 'w-fast', name: 'synth-fast', host: `${base}/bmc-fast`, username: 'u', password: 'p', serviceTag: 'SYNTHW2' }], 'replace');
  const P = await import('../src/idrac/poller.js');
  const ev = P.pollNowForEvent(['w-slow']);
  await slowStarted;   // 이벤트 읽기가 느린 장비에 붙잡혔다
  let evDone = false; ev.then(() => { evDone = true; });
  const m = await P.pollNowManual();   // 수동 주기 — 이벤트 읽기를 기다리지 않고 돈다
  assert.equal(m.ran, true, '이벤트 읽기 중에도 수동 주기가 돈다');
  assert.equal(evDone, false, '이벤트 읽기가 끝나기 전에 주기가 끝났다(기다리지 않음)');
  const rs = m.lastRun?.results || [];
  assert.deepEqual([rs.find((x) => x.id === 'w-slow')?.eventBusy, !!rs.find((x) => x.id === 'w-fast')], [true, true], '이벤트가 읽는 서버는 건너뛰고 나머지는 읽는다');
  release(); await ev;
});

test('4회차 화면 — 정책 열이 없는 옛 기록의 보낸 단계도 첫 회차 전 행 표지에 보인다', async () => {
  const X = await import('../src/partfault/escalation.js');
  const S = { enabled: true, policies: [{ id: 'p', name: 'p', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a@example.test'], channels: false, oncall: false }, { afterMin: 60, emails: ['b@example.test'], channels: false, oncall: false }] }], oncall: {} };
  const p = { agent: '', partKey: 'k7', scope: 'idrac', kind: 'psu', partId: 'p', deviceId: 'SYNTH07', state: 'fault' };
  const items = { '|k7': { since: 0, sig: 'x', sent: [[0, 1, 'x', 'ok', ''], [1, 2, 'x', 'ok', '']], ackedAt: null, ackBy: '', pol: '', ps: {} } };
  assert.equal(X.escalationMarkOf(p, items, S, null).step, 3, '옛 줄(정책 열 없음)도 지금 정책의 진행으로 보인다');
});

test('4회차 판정 — 옛 기록이 정책 밖에서 처음 보이면 넘겨받지 않음(나중 정책은 지금부터) · 제조사 이름뿐인 권고 줄은 올릴 때 거절', async () => {
  const X = await import('../src/partfault/escalation.js');
  const POL = { id: 'pnew', name: 'p', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a1@example.test'], channels: false, oncall: false }, { afterMin: 60, emails: ['mgr@example.test'], channels: false, oncall: false }] };
  const part = { agent: '', partKey: 'k8', scope: 'idrac', kind: 'psu', partId: 'p', deviceId: 'SYNTH08', state: 'fault' };
  const MIN = 60_000;
  let st = { items: { '|k8': { since: 0, sig: 'x', sent: [[0, 1, 'x', 'ok'], [1, 2, 'x', 'ok']], ackedAt: null, ackBy: '' } }, enabledAt: 1 };
  // 첫 회차 — 정책 없음(정책 밖)
  let pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [], oncall: {} }, state: st, open: [part], now: 500 * MIN });
  st = { items: pl.items, enabledAt: pl.enabledAt };
  assert.equal(st.items['|k8'].pol, '-', '넘겨받지 않음으로 굳힌다');
  // 나중에 정책이 생김 — 지금부터 센다(1선이 먼저)
  pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [POL], oncall: {} }, state: st, open: [part], now: 600 * MIN });
  assert.equal(pl.sends.length, 0, '옛 since 로 가장 높은 단계가 바로 가지 않는다');
  st = { items: pl.items, enabledAt: pl.enabledAt };
  pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [POL], oncall: {} }, state: st, open: [part], now: 616 * MIN });
  assert.deepEqual(pl.sends.map((x) => [x.step, x.to.emails[0]]), [[0, 'a1@example.test']]);
  const A = await import('../src/bmcheck/advisory.js');
  const csv = 'advisory_id,component_type,model,fixed_version\nDSA-1,BIOS,Dell,2.1\nDSA-2,BIOS,Dell PowerEdge,2.1\nDSA-3,BIOS,R740xd,2.1\n';
  const r = A.parseAdvisoryCsv(csv);
  assert.deepEqual([r.rows.map((x) => x.id), r.errors.map((e) => e.line)], [['DSA-2', 'DSA-3'], [2]], '제조사 이름뿐인 줄만 오류');
});


test('5회차 — 이벤트 구독 파일은 비밀 금고 목록(추가 필드 셋 · 평문 점검) · 옛 기록은 멈춘 회차에 굳히지 않고 그때 있던 정책은 이어받음 · 권고 맞지 않는 줄 알림', async () => {
  const V = await import('../src/security/secretVault.js');
  assert.ok(V.SECRET_FILES.includes('bm-events.json'));
  assert.deepEqual([...V.FILE_EXTRA_SECRET_FIELDS['bm-events.json']].sort(), ['ctxKey', 'prevCtxKey', 'secret']);
  assert.match(src('../src/security/secretScan.js'), /\}, '', FILE_EXTRA_SECRET_FIELDS\[name\] \|\| null\);/);
  assert.match(fs.readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8'), /^server\/config\/bm-events\.json$/m);
  const X = await import('../src/partfault/escalation.js');
  const POL = (id) => ({ id, name: id, agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a1@example.test'], channels: false, oncall: false }, { afterMin: 60, emails: ['mgr@example.test'], channels: false, oncall: false }] });
  const part = (state) => ({ agent: '', partKey: 'k9', scope: 'idrac', kind: 'psu', partId: 'p', deviceId: 'SYNTH09', state });
  const MIN = 60_000;
  const legacy = () => ({ items: { '|k9': { since: 0, sig: 'x', sent: [[0, 1, 'x', 'ok'], [1, 2, 'x', 'ok']], ackedAt: null, ackBy: '' } }, enabledAt: 1 });
  // 멈춘 회차(enabled false)에서는 굳히지 않는다
  let pl = X.escalationPlan({ settings: { enabled: false, policies: [POL('pa')], oncall: {} }, state: legacy(), open: [part('fault')], now: 100 * MIN });
  assert.ok(!pl.items['|k9'].pol, '멈춘 회차는 옛 기록을 그대로 둔다(굳히지 않음)');
  // 정책 밖에서 처음 봄 → 굳히되 그때 있던 정책(pa)을 기억 → pa 로 돌아오면 이어받는다(이미 간 단계를 다시 보내지 않음)
  pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [POL('pa')], oncall: {} }, state: legacy(), open: [part('warn')], now: 100 * MIN });
  assert.deepEqual([pl.items['|k9'].pol, pl.items['|k9'].lp], ['-', ['pa']]);
  const st = { items: pl.items, enabledAt: pl.enabledAt };
  pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [POL('pa')], oncall: {} }, state: st, open: [part('fault')], now: 120 * MIN });
  assert.deepEqual([pl.sends.length, pl.items['|k9'].ps.pa], [0, 0], '그때 있던 정책은 since · 보낸 단계를 이어받는다');
  // 나중에 생긴 정책(pb)은 지금부터
  pl = X.escalationPlan({ settings: { enabled: true, enabledAt: 1, policies: [POL('pb')], oncall: {} }, state: st, open: [part('fault')], now: 120 * MIN });
  assert.deepEqual([pl.sends.length, pl.items['|k9'].ps.pb], [0, 120 * MIN]);
  const A = await import('../src/bmcheck/advisory.js');
  assert.equal(A.modelTokensMatch('UCSC-C240-M5SX', 'Cisco UCS'), true, '제품군 앞머리(ucs → ucsc)');
  assert.equal(A.modelTokensMatch('ProLiant DL380 Gen10', 'Hewlett Packard Enterprise ProLiant Servers'), true, '제조사 전체 이름 · 복수형은 뺀다');
  assert.match(src('../src/routes/admin/bmAssets.js'), /unmatched = \{ n: um\.length, rows: um\.slice\(0, 200\)/);
});

test('5회차 엣지 — 읽는 도중 다시 선 표지는 남는다(순번) · 정규 주기가 읽는 서버는 이벤트가 다시 잡는다', async () => {
  const C = await import('../src/idrac/invCache.js');
  C.markInventoryStale('m-1', { event: true });
  const mark = C.staleMarkOf('m-1');              // 읽기 시작
  C.markInventoryStale('m-1', { event: true });   // 읽는 도중 새 이벤트
  C.setInventory('m-1', { collectedAt: Date.now() }, { mark });
  assert.deepEqual([C.inventoryStale('m-1', 1e12), C.isForcedStale('m-1')], [true, true], '읽기 시작 뒤에 선 표지는 지우지 않는다');
  C.setInventory('m-1', { collectedAt: Date.now() }, { mark: C.staleMarkOf('m-1') });
  assert.deepEqual([C.inventoryStale('m-1', 1e12), C.isForcedStale('m-1')], [false, false]);
  C.removeInventory('m-1');
  const E = await import('../src/idrac/eventSub.js');
  E._resetEventsForTest();
  const runs = [];
  E._setEventDepsForTest({ debounceMs: 20, runCheck: async (_r, ids) => { runs.push([...ids]); return runs.length === 1 ? { busy: false, refreshed: 1, retry: ['m-2'] } : { busy: false, refreshed: 1, retry: [] }; } });
  try {
    const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
    E.acceptEvents(s, { context: E.contextOf(s, 'm-2'), events: [{ sev: 'critical' }] });
    E.acceptEvents(s, { context: E.contextOf(s, 'm-3'), events: [{ sev: 'critical' }] });
    for (let i = 0; i < 50 && runs.length < 2; i += 1) await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(runs.map((x) => x.sort()), [['m-2', 'm-3'], ['m-2']], '정규 주기와 겹쳐 뺀 서버만 다시 잡는다');
  } finally { E._setEventDepsForTest(null); E._resetEventsForTest(); }
});

test('5회차 화면 — 권고 모델 칸 오류 사유를 가른다(모델 글자 없음 · 제조사 이름뿐) · 멈춘 회차는 옛 기록을 굳히지 않는다', async () => {
  const A = await import('../src/bmcheck/advisory.js');
  const r = A.parseAdvisoryCsv('advisory_id,component_type,model,fixed_version\nD1,BIOS,-,2.1\nD2,BIOS,전체,2.1\nD3,BIOS,Dell EMC,2.1\n');
  assert.deepEqual(r.errors.map((e) => /모델 이름이 없습니다/.test(e.reason) ? 'none' : /제조사 이름뿐/.test(e.reason) ? 'maker' : '?'), ['none', 'none', 'maker']);
  assert.match(src('../src/partfault/escalation.js'), /if \(enabled && cur && !cur\.pol && !Object\.keys\(cur\.ps \|\| \{\}\)\.length\) cur = \{ \.\.\.cur, pol: '-'/);
});

