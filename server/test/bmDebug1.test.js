// 물리서버 기능 디버깅 회차 1(v3.52 — 5축 × 반증 1인) 회귀 — 보안 7 · 판정 13 · 엣지 9 가운데 순수 함수 · 라우트로 고정할 수 있는 것.
//   픽스처 식별자 · 주소는 합성(SYNTH · 192.0.2.x · example.test).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmdebug1-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'true', SSRF_ALLOW_LOOPBACK: 'true', COLLECTOR_TOKEN: 'tok-dbg1' });
delete process.env.CENTRAL_URL; delete process.env.DAY_OFFSET_MIN;
const { stripComments } = await import('./_stripComments.js');
const src = (p) => stripComments(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));

test('보안 — 데모 READ_DENY · OTP 앞 본문 검증 · 태그 다름 문구에 태그 없음 · 겹친 빗금 기록 지움 · 같은 받는 주소 구독만 지움 · 정비 창은 같은 수집 주체', async () => {
  const { READ_DENY } = await import('../src/auth/demoGuest.js');
  for (const p of ['/api/admin/bm-power', '/api/admin/bm-events']) assert.ok(READ_DENY.includes(p), p);
  const adm = src('../src/routes/admin/bmAssets.js');
  assert.match(adm, /put\('\/bm-power', adminOnly, fleetOnly, textFields\('otp'\), powerBodyOk, ownOtpGate\(/);
  assert.match(adm, /post\('\/bm-events\/sync', adminOnly, fleetOnly, textFields\('otp'\), syncBodyOk, ownOtpGate\(/);
  const P = await import('../src/idrac/power.js');
  P._resetPowerGapForTest();
  const sys = { PowerState: 'On', SKU: 'OTHER77', Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset', 'ResetType@Redfish.AllowableValues': ['On'] } } };
  const r = await P.runDeviceAction({ id: 'x1', host: 'h', serviceTag: 'SYNTH01' }, { kind: 'power', action: 'on', authStopped: () => false, getJson: async (_e, p) => (p === '/redfish/v1/Systems' ? { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] } : sys), send: async () => ({ status: 204, ok: true, text: '' }) });
  assert.deepEqual([r.status, r.gotTag, /OTHER77|SYNTH01/.test(r.message), r.sent], ['tag-mismatch', 'OTHER77', false, false]);
  assert.match(src('../src/routes/api/bmFolders.js'), /\.\.\.\(full && typeof r\?\.gotTag === 'string' \? \{ gotTag: r\.gotTag \} : \{\}\)/, '장비 태그는 관리자 판본에만');
  // 보내지 않은 결과는 간격을 세지 않는다(판정 #8) — 바로 다음 요청이 busy 가 아니다
  const r2 = await P.runDeviceAction({ id: 'x1', host: 'h', serviceTag: 'SYNTH01' }, { kind: 'power', action: 'on', authStopped: () => false, getJson: async () => { throw new Error('x'); }, send: async () => ({ status: 204, ok: true, text: '' }) });
  assert.notEqual(r2.status, 'busy');
  const E = await import('../src/idrac/eventSub.js');
  assert.equal(E.scrubEventPath('/api/bm-events//in/SECRETSECRET'), '/api/bm-events//in/…');
  assert.equal(E.scrubEventPath('/api//bm-events/in//SECRETSECRET?x=1'), '/api//bm-events/in//…?x=1');
  // 구독 지우기 — 같은 받는 주소 앞(이 포탈)의 것만(다른 포탈 · 다른 도구는 둔다)
  const s = { enabled: true, base: 'https://portal-a.example.test', secret: 'A'.repeat(43), ctxKey: 'B'.repeat(43) };
  const calls = [];
  const subs = { 1: { Destination: 'https://portal-b.example.test/api/bm-events/in/OTHER', Context: 'x' }, 2: { Destination: `${s.base}/api/bm-events/in/OLD`, Context: 'y' }, 3: { Destination: 'https://hook.example.test/x', Context: 'z' } };
  const out = await E.syncOne({ id: 'srv-1' }, s, { unsubscribe: true, authStopped: () => false,
    getJson: async (_e, p) => (p === '/redfish/v1/EventService/Subscriptions' ? { Members: Object.keys(subs).map((k) => ({ '@odata.id': `/redfish/v1/EventService/Subscriptions/${k}` })) } : subs[p.split('/').pop()]),
    send: async (_e, m, p) => { calls.push([m, p]); return { status: 204, ok: true, text: '' }; } });
  assert.deepEqual([out.removed, calls.map((c) => c[1])], [1, ['/redfish/v1/EventService/Subscriptions/2']]);
  // 정비 창 보류 — 다른 법인 엣지의 같은 태그 대상이 이 장비를 보류하지 않는다(보안 #7)
  const H = await import('../src/bmusage/maint/partfaultHold.js');
  const judge = { stateFor: (tg) => ({ scopes: { hold: tg.key === 'w-b' }, windows: [{ id: 'win-1', scopes: ['hold'], start: 0, end: 1 }], until: { hold: 1 } }) };
  const devs = [{ agent: 'edge-a', deviceId: 'dev-a1', deviceKey: 'SYNTHTAG', scope: 'idrac' }];
  const { hold } = H.holdSetFor(devs, [{ agent: 'edge-b', key: 'w-b', serviceTag: 'SYNTHTAG' }], judge);
  assert.equal(hold.size, 0, '다른 엣지의 대상');
  const corpsOf = (ag) => (ag === 'edge-a' ? ['vc-a'] : []);
  const { hold: h2 } = H.holdSetFor(devs, [{ agent: '', key: 'w-b', serviceTag: 'SYNTHTAG', vcenterId: 'vc-a' }], judge, Date.now(), { corpsOf });
  assert.equal(h2.size, 1, '그 엣지가 맡은 법인의 중앙 로컬 대상은 받는다');
  const { hold: h3 } = H.holdSetFor(devs, [{ agent: '', key: 'w-b', serviceTag: 'SYNTHTAG', vcenterId: 'vc-b' }], judge, Date.now(), { corpsOf });
  assert.equal(h3.size, 0, '다른 법인의 중앙 로컬 대상은 받지 않는다(2회차 보안 #5)');
  assert.equal(H.holdSetFor(devs, [{ agent: '', key: 'w-b', serviceTag: 'SYNTHTAG', vcenterId: 'vc-a' }], judge).hold.size, 0, '엣지 법인을 모르면 넘어가지 않는다');
});

test('판정 — 당직 요일은 포탈 지역 시계 · 다시 시도마다 다른 열쇠 · 정책이 바뀌면 지금부터 · ‘*’ 와 이름 함께 거절 · 당직표 대소문자 겹침 거절 · 상한 O(N)', async () => {
  const E = await import('../src/partfault/escalation.js');
  const R = await import('../src/partfault/escalationRun.js');
  const days = Array.from({ length: 7 }, (_, i) => ({ name: `당직${i}`, email: '' }));
  // 2026-11-22(일) 23:30 UTC = 2026-11-23(월) 08:30 KST — 포탈 오프셋(기본 540분)으로 월요일
  assert.equal(E.oncallFor({ oncall: { '*': { days } } }, '', Date.UTC(2026, 10, 22, 23, 30)).name, '당직0');
  const POL = (id, states, emails) => ({ id, name: id, agents: [], states, steps: [{ afterMin: 15, emails, channels: true, oncall: false }] });
  const part = (state) => ({ agent: '', partKey: 'k1', scope: 'idrac', kind: 'psu', partId: 'p1', deviceId: 'SYNTH01', deviceName: 'synth-db-01', label: 'PSU 1', state });
  const S = { enabled: true, enabledAt: 1, policies: [POL('team-a', ['fault'], ['a@example.test']), POL('team-b', ['warn'], ['b@example.test'])], oncall: {} };
  const MIN = 60_000;
  let st = { items: {}, enabledAt: 1 };
  const step = (p, now, delivered = true) => {
    const pl = E.escalationPlan({ settings: S, state: st, open: [p], now });
    st = { items: E.recordSends(pl.items, pl.sends, pl.sends.map(() => ({ text: 'x', delivered })), now), enabledAt: pl.enabledAt };
    return pl.sends;
  };
  step(part('warn'), 0);
  assert.deepEqual(step(part('warn'), 16 * MIN).map((x) => x.to.emails), [['b@example.test']]);
  // 주의 → 이상(다른 정책): 다른 정책에 간 단계를 이 정책의 ‘보냄’ 으로 세지 않는다(1회차 판정 #3) — 진행은 지우지 않는다(2회차 판정 #1)
  // 새 정책은 그 정책 대상이 된 때부터 센다(3회차 판정 #1 — 오래 열린 장애가 새 정책의 높은 단계로 바로 가지 않게) · 돌아온 정책은 이미 간 단계를 다시 보내지 않는다
  assert.deepEqual(step(part('fault'), 17 * MIN), [], '새 정책은 지금부터');
  assert.deepEqual(step(part('fault'), 33 * MIN).map((x) => x.to.emails), [['a@example.test']], '더 심각해진 장애의 받는 곳에 그 정책의 시각에 간다');
  assert.deepEqual(step(part('warn'), 40 * MIN), [], '앞의 정책으로 돌아와도 이미 간 단계를 다시 보내지 않는다');
  assert.deepEqual(step(part('fault'), 50 * MIN), [], '오가도 같은 단계를 두 번 보내지 않는다');
  // 다시 시도마다 다른 채널 열쇠(억제 창에 막히지 않게 — 판정 #2)
  st = { items: {}, enabledAt: 1 };
  step(part('fault'), 0);
  const s1 = step(part('fault'), 16 * MIN, false);
  const s2 = step(part('fault'), 17 * MIN, false);
  assert.deepEqual([s1[0].attempt, s2[0].attempt], [1, 2]);
  assert.notEqual(R.escalationMessage(s1[0], 16 * MIN).key, R.escalationMessage(s2[0], 17 * MIN).key);
  // 검증
  const bad = E.normalizeEscalation({ policies: [{ ...POL('p', ['fault'], ['a@example.test']), agents: ['*', 'edge-a'] }] });
  assert.equal(bad.ok, false); assert.match(bad.reason, /모두\(\*\)/);
  const dup = E.normalizeEscalation({ policies: [POL('p', ['fault'], ['a@example.test'])], oncall: { 'Edge-A': { days }, 'edge-a': { days } } });
  assert.equal(dup.ok, false); assert.match(dup.reason, /둘 이상/);
  // 상한 — 열린 장애 5,000건도 빨리(O(N)) · 상한 넘음 셈은 그대로
  const many = Array.from({ length: E.ESC_ITEMS_MAX + 50 }, (_, i) => ({ ...part('fault'), partKey: `m${i}`, partId: `m${i}` }));
  const t0 = Date.now();
  const pl = E.escalationPlan({ settings: S, state: { items: {}, enabledAt: 1 }, open: many, now: 0 });
  assert.deepEqual([Object.keys(pl.items).length, pl.overCap], [E.ESC_ITEMS_MAX, 50]);
  assert.ok(Date.now() - t0 < 1500, `${Date.now() - t0}ms`);
  // 당직에 메일이 없으면 원인을 가른다(판정 #10)
  assert.match(src('../src/partfault/escalationRun.js'), /의 메일 주소가 당직표에 없음/);
});

test('판정 — 권고 모델은 낱말 단위 · 교정 오류 시각 못 읽음은 덮지 않음 · 기록 가림(메일 · URL 호스트) · LED 뒤 다시 읽기', async () => {
  const A = await import('../src/bmcheck/advisory.js');
  assert.equal(A.modelTokensMatch('PowerEdge R740xd2', 'R740xd'), false);
  assert.equal(A.modelTokensMatch('PowerEdge R740xd', 'r740xd'), true);
  assert.equal(A.modelTokensMatch('PowerEdge R740xd', 'poweredge r740xd'), true);
  const L = await import('../src/idrac/partLife.js');
  const now = Date.UTC(2026, 10, 26);
  const m = L.memCeOf({ status: 'ok', total: 2, read: 2, stopped: '', gap: 0, rows: [{ at: null, msg: 'Correctable memory error rate exceeded for DIMM_A1.' }, { at: now - 3600_000, msg: 'x' }] }, { now });
  // 덮음은 기간 덮음 그대로 · 시각 모름은 untimed 로 따로(화면이 ‘없음’ 이라 하지 않는다 — 2회차 화면 D5 로 바꿈)
  assert.deepEqual([m.covered, m.untimed, m.total], [true, 1, 0]);
  const H = await import('../src/idrac/hwLog.js');
  const t = H.maskHwLogText('alert sent to ops.team@example.test via https://mail.example.test:8443/api?x=1 from 192.0.2.5');
  assert.ok(!/example\.test|192\.0\.2\.5/.test(t), t);
  assert.match(t, /https:\/\/•••\/api/);
  assert.match(src('../src/routes/api/bmFolders.js'), /if \(kind === 'led' && rl\?\.ok\) \{ try \{ \(await import\('\.\.\/\.\.\/idrac\/invCache\.js'\)\)\.markInventoryStale/);
  assert.match(src('../src/routes/collector.js'), /if \(kind === 'led' && r\?\.ok\) \{ try \{ \(await import\('\.\.\/idrac\/invCache\.js'\)\)\.markInventoryStale/);
});

test('엣지 — 서버 찾기(꺼진 등록 제외 · 인벤토리 태그 먼저 · 겹치면 409 · 등록부 못 읽으면 503) · 상한(보낸 것만 · 0 은 막음) · 응답 정제 · 시한 범위 · 엣지 보고 urgent → 중앙 곧 판정 · 엣지 단계 설정 409', async (t) => {
  const express = (await import('express')).default;
  const registry = await import('../src/idrac/registry.js');
  const inv = await import('../src/idrac/invCache.js');
  const bmc = { posts: 0 };
  const app = express();
  app.use('/bmc', express.json(), (req, res) => {
    if (req.url === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] });
    if (req.method === 'GET') return res.json({ PowerState: 'On', IndicatorLED: 'Off', Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset', 'ResetType@Redfish.AllowableValues': ['On'] } } });
    if (req.method === 'POST' || req.method === 'PATCH') { bmc.posts += 1; return res.status(204).end(); }
    return res.status(404).end();
  });
  const { collectorRouter } = await import('../src/routes/collector.js');
  app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); for (const k of ['BM_POWER_EDGE_ENABLE', 'BM_POWER_EDGE_MAX']) delete process.env[k]; });
  const base = `http://127.0.0.1:${srv.address().port}`;
  registry.importServers([
    { id: 'old', name: 'synth-old', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'SYNTH41', enabled: false },
    { id: 'cur', name: 'synth-cur', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'SYNTH41' },
    { id: 'o1', name: 'synth-o1', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'OEM' },
    { id: 'o2', name: 'synth-o2', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'OEM' },
    { id: 'reg', name: 'synth-reg', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'SYNTH42' },
    { id: 'invt', name: 'synth-invt', host: `${base}/bmc`, username: 'u', password: 'p', serviceTag: 'STALE' },
  ], 'replace');
  inv.setInventory('invt', { collectedAt: Date.now(), system: { serviceTag: 'SYNTH42' } });
  const post = (body) => fetch(`${base}/api/collector/bm-power`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-collector-token': 'tok-dbg1' }, body: JSON.stringify(body) }).then(async (r) => ({ s: r.status, b: await r.json().catch(() => null) }));
  process.env.BM_POWER_EDGE_ENABLE = 'true';
  const P = await import('../src/idrac/power.js'); P._resetPowerGapForTest();
  let r = await post({ k: 'synth41', kind: 'led', action: 'on' });
  assert.deepEqual([r.s, r.b.status], [200, 'accepted'], '꺼진 옛 등록은 후보가 아니다');
  r = await post({ k: 'oem', kind: 'led', action: 'on' });
  assert.deepEqual([r.s, r.b.code], [409, 'ambiguous'], '공통 태그 — 어느 장비인지 몰라 보내지 않는다');
  P._resetPowerGapForTest(); const before = bmc.posts;
  r = await post({ k: 'synth42', kind: 'led', action: 'on' });
  assert.deepEqual([r.s, bmc.posts - before], [200, 1], '인벤토리 태그가 먼저(등록부 태그와 겹쳐도 하나로)');
  // 상한 — 보내지 않은 것(없는 서버)은 세지 않는다 · 0 은 막음
  process.env.BM_POWER_EDGE_MAX = '3';
  for (let i = 0; i < 5; i += 1) assert.equal((await post({ k: 'nobody', kind: 'led', action: 'on' })).s, 404);
  P._resetPowerGapForTest();
  assert.equal((await post({ id: 'cur', kind: 'led', action: 'off' })).s, 200, '없는 서버 요청 5건이 상한을 먹지 않았다');
  process.env.BM_POWER_EDGE_MAX = '0';
  assert.equal((await post({ id: 'cur', kind: 'led', action: 'on' })).b.code, 'rate', '0 은 막음');
  delete process.env.BM_POWER_EDGE_MAX;
  // 정제
  const H = await import('../src/idrac/hwLog.js');
  const sh = H.sanitizeHwLog({ ok: true, status: 'ok', at: 5, rows: [{ at: Date.now(), sev: 'ok', code: { a: 1 }, sensor: ['x', 'y'], msg: 'm' }] });
  assert.deepEqual([sh.at, sh.rows[0].code, sh.rows[0].sensor], [null, '', '']);
  const sd = P.sanitizeDeviceAction({ ok: true, status: 'accepted', reset: 'Evil\u0007', prop: 'Bogus', before: 'On\u0000x' });
  assert.deepEqual([sd.reset, sd.prop, sd.before], [undefined, undefined, 'Onx']);
  assert.match(src('../src/central/bmHwLogPull.js'), /\{ min: 35_000, max: 55_000 \}/);
  assert.match(src('../src/central/bmPowerPull.js'), /\{ min: 35_000, max: 70_000 \}/);
  // 엣지 보고 urgent → 중앙 곧 판정 · 엣지에서 단계 설정 저장 409
  const pu = src('../src/partfault/push.js');
  assert.match(pu, /if \(urgent\) payload\.urgent = true;/);
  assert.match(pu, /if \(reason === 'event'\) _urgentAgain = true;/, '진행 중인 push 에 합류한 이벤트 보고도 urgent(2회차 엣지 #4)');
  assert.match(src('../src/partfault/hooks.js'), /reason: ev \? 'event' : `hook:\$\{source\}`/);
  assert.match(src('../src/routes/central/storageRoutes.js'), /if \(req\.body\?\.urgent === true\) \{ try \{ \(await import\('\.\.\/\.\.\/partfault\/poller\.js'\)\)\.runPartFaultsSoon\('edge-event'\)/);
  assert.match(src('../src/routes/api/partFaults.js'), /api\.put\('\/tools\/part-faults\/escalation'[^\n]*\n\s*if \(config\.agent\.centralUrl\) return res\.status\(409\)/);
});

test('성능 — 권고 대조 색인 · 기억(결과는 예전 판정과 같다) · 1,000대 × 2,000줄이 한 덩어리로 멈추지 않음', async () => {
  const A = await import('../src/bmcheck/advisory.js');
  const { cmpVersion } = await import('../src/util/cmpVersion.js');
  // 예전 판정(색인 없는 이중 반복) — 결과가 같아야 한다
  const naive = (server, list) => {
    const fw = server.rows; const model = String(server.model || '').toLowerCase(); const hits = []; let unknown = 0; let checked = 0;
    for (const a of list) {
      if (a.model && !A.modelTokensMatch(model, a.model)) continue;
      for (const r of fw) {
        if (!r || r.type !== a.type) continue;
        if (a.comp && !String(r.label || '').toLowerCase().includes(a.comp)) continue;
        checked += 1;
        if (r.mixed) { unknown += 1; continue; }
        const c = cmpVersion(r.installed, a.fixed);
        if (c == null) { unknown += 1; continue; }
        if (c < 0) hits.push(`${a.id}|${r.label}`);
      }
    }
    return { n: hits.length, unknown, checked, set: hits.sort().join(',') };
  };
  const TYPES = ['BIOS', 'iDRAC', 'NIC', 'Storage', 'HBA'];
  const table = Array.from({ length: 2000 }, (_, i) => ({ id: `DSA-${i % 700}`, sev: ['critical', 'high', 'medium', 'low'][i % 4], type: TYPES[i % 5], model: i % 3 ? `r${640 + (i % 7) * 10}` : '', comp: i % 4 ? ['broadcom', 'perc', 'intel', 'qlogic'][i % 4] : '', fixed: `${1 + (i % 5)}.${i % 9}.${i % 3}`, title: '', url: '' }));
  const server = (k) => ({ model: `PowerEdge R${640 + (k % 7) * 10}`, rows: Array.from({ length: 40 }, (_, j) => ({ type: TYPES[j % 5], label: `${['Broadcom', 'PERC H755', 'Intel X710', 'QLogic', 'BIOS'][j % 5]} ${j}`, installed: j === 7 ? 'abc' : `${1 + ((k + j) % 5)}.${(k * j) % 9}.${j % 3}`, mixed: j === 9 && k % 2 === 0 })) });
  for (const k of [0, 1, 2, 5, 13]) {
    const got = A.advisoriesFor(server(k), table); const want = naive(server(k), table);
    assert.deepEqual([got.total, got.unknown, got.checked], [want.n, want.unknown, want.checked], `서버 ${k}`);
    assert.ok(Object.isFrozen(got) && Object.isFrozen(got.hits), '함께 쓰는 결과는 얼린다');
    assert.equal(A.advisoriesFor(server(k), table), got, '같은 서명은 기억에서');
  }
  const t0 = Date.now();
  for (let k = 0; k < 1000; k += 1) A.advisoriesFor(server(k + 100), table);   // 서명이 모두 다른 1,000대(기억이 돕지 않는 경우)
  assert.ok(Date.now() - t0 < 4000, `1,000대 × 2,000줄 ${Date.now() - t0}ms`);
  // 목록 라우트는 입력 모으기 · 행 만들기 사이에 양보한다(P10)
  const lr = src('../src/routes/api/bmFolders.js');
  assert.match(lr, /chk = await bmCheckForAsync\(\{[^\n]*\}, y\);/);
  assert.match(lr, /for \(const \[m, p\] of shown\) \{\n\s*await y\(\);/);
});

test('성능 — 이벤트는 그 서버만 읽는다(함대 주기 아님 · 주기 상태 그대로) · 판정 한 번 · 넘친 서버는 세고 정규 주기로', async (t) => {
  const express = (await import('express')).default;
  const hits = { a: 0, b: 0, c: 0 };
  const app = express();
  for (const k of Object.keys(hits)) app.use(`/bmc-${k}`, (req, res) => { hits[k] += 1; res.status(404).end(); });
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const registry = await import('../src/idrac/registry.js');
  registry.importServers(Object.keys(hits).map((k) => ({ id: `ev-${k}`, name: `synth-ev-${k}`, host: `${base}/bmc-${k}`, username: 'u', password: 'p', serviceTag: `SYNTHEV${k}` })), 'replace');
  const P = await import('../src/idrac/poller.js');
  const before = P.getPollerStatus().lastRun;
  const r = await P.pollNowForEvent(['ev-b']);
  assert.equal(r.busy, false);
  assert.ok(hits.b > 0, '보낸 서버는 읽는다');
  assert.deepEqual([hits.a, hits.c], [0, 0], '다른 서버에는 요청이 가지 않는다');
  assert.equal(P.getPollerStatus().lastRun, before, '주기 상태(lastRun)를 바꾸지 않는다');
  assert.deepEqual(await P.pollNowForEvent([]), { busy: false, servers: 0, invRefreshed: 0 });
  // 판정 한 번 — 다시 읽은 인벤토리가 없으면 판정하지 않는다 · 이벤트 읽기는 폴러 훅을 부르지 않는다
  const es = src('../src/idrac/eventSub.js');
  assert.match(es, /const r = await P\.pollNowForEvent\(ids\);/);
  assert.match(es, /if \(!\(Number\(r\?\.invRefreshed\) > 0\)\) return \{ busy: false, refreshed: 0, retry \};/);
  const ps = src('../src/idrac/poller.js');
  const ia = ps.indexOf('if (only) return { servers: servers.length - skippedForCycle.length, invRefreshed, skipped: skippedForCycle };');
  assert.ok(ia > 0 && ia < ps.indexOf("onSnapshotRefreshed('idrac'") && ia < ps.indexOf('lastRun = { at: ts, startedAt: ts'), '이벤트 읽기는 훅 · 주기 상태 앞에서 돌아간다');
  // 넘친 서버 — 세고 정규 주기가 읽게 표시
  const E = await import('../src/idrac/eventSub.js');
  const C = await import('../src/idrac/invCache.js');
  E._resetEventsForTest();
  const runs = [];
  E._setEventDepsForTest({ debounceMs: 60_000, runCheck: async (_r, ids) => { runs.push(ids.length); return { busy: false }; } });
  t.after(() => { E._setEventDepsForTest(null); E._resetEventsForTest(); });
  const s = { enabled: true, base: 'https://portal.example.test', secret: 'E'.repeat(43), ctxKey: 'F'.repeat(43) };
  for (let i = 0; i <= E.EVT_BATCH_MAX; i += 1) E.acceptEvents(s, { context: E.contextOf(s, `of-${i}`), events: [{ sev: 'critical' }] });
  await new Promise((r2) => setTimeout(r2, 50));
  assert.equal(E.eventStatus().deferred, 1);
  assert.equal(C.inventoryStale(`of-${E.EVT_BATCH_MAX}`, 1e12), true, '넘친 서버는 다음 정규 주기가 인벤토리를 다시 읽는다');
  C.removeInventory(`of-${E.EVT_BATCH_MAX}`);
});

test('성능 — 구독 걸기는 풀(한 대가 늦어도 자리가 놀지 않음 · 던져도 그 서버만 오류) · 진행 기록 읽기 오류는 다시 읽는다 · 손상 안내는 하루 · 케이스 파일 상한', async () => {
  const E = await import('../src/idrac/eventSub.js');
  E.eventSubStore.save({ enabled: true, base: 'https://portal.example.test', rotate: true }, { by: 't' });
  // 시간이 아니라 순서로 — 첫 서버가 끝나기 전에 몇 대가 시작했는가(묶음이면 4대 · 풀이면 9대 모두)
  let p0Done = false; let startedBeforeP0 = 0;
  const list = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `synth-p${i}`, host: 'h', enabled: true }));
  const out = await E.syncAll({ entries: list, one: async (e) => {
    if (!p0Done) startedBeforeP0 += 1;
    if (e.id === 'p3') throw new Error('boom');
    await new Promise((r) => setTimeout(r, e.id === 'p0' ? 400 : 10));
    if (e.id === 'p0') p0Done = true;
    return { id: e.id, status: 'subscribed', removed: 0 };
  } });
  assert.equal(startedBeforeP0, 9, '첫 서버(느림)가 끝나기 전에 나머지 자리가 모두 돌았다(묶음이 아니라 풀)');
  assert.equal(out.results.length, 9);
  assert.deepEqual([out.results[3].status, out.results[3].message], ['error', 'boom']);
  // 진행 기록 — 읽기 오류(디렉터리)는 고치면 다시 읽는다
  const X = await import('../src/partfault/escalation.js');
  const f = path.join(tmp, 'partfault-escalation-state.json');
  fs.rmSync(f, { recursive: true, force: true }); fs.mkdirSync(f);
  X._resetEscalationStateForTest();
  const now = Date.now();
  X.loadEscalationState(now);
  assert.match(X.escalationStateError(now), /읽지 못해/);
  fs.rmSync(f, { recursive: true, force: true });
  fs.writeFileSync(f, JSON.stringify({ v: 1, enabledAt: 5, items: { 'a|k': { since: 1, sig: 's', sent: [] } } }));
  assert.equal(Object.keys(X.loadEscalationState(now + 1000).items).length, 0, '재읽기 간격 안');
  const st = X.loadEscalationState(now + X.ESC_STATE_RETRY_MS + 1);
  assert.deepEqual([Object.keys(st.items), X.escalationStateError(now + X.ESC_STATE_RETRY_MS + 1)], [['a|k'], '']);
  // 손상 — 안내는 하루 보이고 그 뒤 사라진다
  X._resetEscalationStateForTest(); fs.writeFileSync(f, '{not json');
  X.loadEscalationState(now);
  assert.match(X.escalationStateError(now + 1000), /손상/);
  assert.equal(X.escalationStateError(now + X.ESC_STATE_NOTE_MS + 1), '');
  X._resetEscalationStateForTest(); fs.rmSync(f, { force: true });
  for (const p of fs.readdirSync(tmp)) if (p.startsWith('partfault-escalation-state.json.')) fs.rmSync(path.join(tmp, p), { force: true, recursive: true });
  // 케이스 파일 — 크기 상한(넘으면 413 · 지우기는 막지 않음) · 백업 상한이 그만큼 담는다
  const S = await import('../src/bmcheck/store.js');
  const w = (n) => '가'.repeat(n);
  const big = {};
  for (let i = 0; i < 1600; i += 1) big[`case-${String(i).padStart(6, '0')}`] = { tag: 'synthtag', corp: 'vc-a', part: w(120), caseNo: w(64), status: 'closed', note: w(500), by: w(80), at: 1, created: 1, hist: Array.from({ length: 20 }, () => ({ at: 1, by: w(80), status: 'open', caseNo: w(64) })) };
  const r = S.caseStore.save({ v: 1, cases: big });
  assert.equal(r.status, 413, '파일 크기 상한');
  assert.equal(S.caseStore.save({ v: 1, cases: big }, { shrinking: true }).ok, true, '지우기 쓰기는 상한으로 막지 않는다');
  S.caseStore.save({ v: 1, cases: {} }, { shrinking: true });
  assert.equal(fs.readFileSync(path.join(tmp, 'bm-cases.json'), 'utf8').includes('\n'), false, '들여쓰기 없이 쓴다');
  const B = await import('../src/backup/service.js');
  assert.ok(B.fileCapFor('bm-cases.json') > S.CASES_FILE_MAX_BYTES * 1.2);
  // 합치기 기억은 기한 뒤 결과를 놓는다(P9)
  assert.match(src('../src/routes/collector.js'), /ent\.timer = setTimeout\(\(\) => \{ if \(_hwlogMemo\.get\(key\) === ent\) _hwlogMemo\.delete\(key\); \}, 60_000\);/);
  assert.match(src('../src/routes/api/bmFolders.js'), /ent\.timer = setTimeout\(\(\) => \{ if \(_trendMemo\.get\(key\) === ent\) _trendMemo\.delete\(key\); \}/);
});

test('화면 — SSD 64개를 넘으면 가장 닳은 것부터 줄에 · 권고 오류 전체 수 · 행 표지는 보내지 않는 상태를 말한다', async () => {
  const L = await import('../src/idrac/partLife.js');
  const disks = Array.from({ length: 90 }, (_, i) => ({ name: `Disk ${i}`, model: 'SYNTH-SSD', media: 'SSD', capacityGB: 960, lifeLeftPct: i === 80 ? 3 : 90 }));
  const rows = L.ssdLifeRows(disks);
  assert.equal(rows.length, 64);
  assert.ok(rows.some((x) => x.name === 'Disk 80' && x.low), '가장 닳은 디스크가 줄에 있다');
  assert.deepEqual(L.lifeSummaryOf(disks), { n: 90, read: 90, min: 3 });
  assert.equal(L.ssdLifeRows(disks.slice(0, 10)).length, 10);
  assert.match(src('../src/routes/admin/bmAssets.js'), /errors: errors\.slice\(0, 200\), errorCount: errors\.length/);
  const X = await import('../src/partfault/escalation.js');
  const S = { enabled: true, policies: [{ id: 'p', name: 'p', agents: [], states: ['fault'], steps: [{ afterMin: 15, emails: ['a@example.test'], channels: false, oncall: false }] }], oncall: {} };
  const p = { agent: '', partKey: 'k9', scope: 'idrac', kind: 'psu', partId: 'p', deviceId: 'SYNTH09', state: 'fault' };
  assert.equal(X.escalationMarkOf(p, {}, S, { why: 'demo', heldKeys: new Set() }).paused, 'demo');
  assert.equal(X.escalationMarkOf(p, {}, S, { why: 'off', heldKeys: new Set() }).paused, undefined, '꺼짐은 행마다 말하지 않는다(대상 밖)');
  assert.equal(X.escalationMarkOf(p, {}, S, { why: '', heldKeys: new Set(['|k9']) }).held, true);
  assert.equal(X.escalationMarkOf(p, {}, S, null).paused, undefined);
});
