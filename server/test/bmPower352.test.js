// 물리서버 원격 전원 조작 · 위치 LED 켜기/끄기(v3.52 — 설계 docs/design/bm-feature-proposals ⑦ ⑥). 장비 상태를 바꾸는 기능 — 게이트 · 다시 보내지 않음 · 감사가 핵심.
//   실행 코어(허용 값 · 새/옛 LED 속성 · 401 · 시한 · 간격 · 인증 정지) · 켜기 스위치(기본 꺼짐 · 강제 따로 · 손상) · 중앙 라우트 게이트 순서
//   (권한 → 조회 밖 404 → 쓰기 밖 403 → 꺼짐 403 → 강제 403 → 사유 → 이름 확인 → OTP) · 엣지 대행 왕복(실제 collector ↔ 실제 pull ↔ 가짜 iDRAC) · 감사.
//   픽스처 식별자 · 주소는 합성(SYNTH · 192.0.2.x).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bmpower352-'));
const rmTmp = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } };
after(() => { rmTmp(); process.once('exit', rmTmp); });   // 종료 때 인벤토리 캐시가 다시 쓰는 파일까지(반증 A17)
Object.assign(process.env, { CONFIG_DIR: tmp, DATA_SOURCE: 'live', AUTH_ENABLED: 'false', COLLECTOR_TOKEN: 'tok-power-rt', SSRF_ALLOW_LOOPBACK: 'true', BM_POWER_DEVICE_TIMEOUT_MS: '5000' });
delete process.env.CENTRAL_URL;

const P = await import('../src/idrac/power.js');
const RP = await import('../src/idrac/remotePowerSettings.js');

const SYS = (over = {}) => ({ PowerState: 'On', '@odata.etag': 'W/"7"', IndicatorLED: 'Off',
  Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset', 'ResetType@Redfish.AllowableValues': ['On', 'ForceOff', 'GracefulShutdown', 'GracefulRestart', 'ForceRestart'] } }, ...over });
const fakeDev = (sys = SYS(), sendRes = { status: 204, ok: true, text: '' }) => {
  const sent = [];
  return { sent, getJson: async (_e, p) => (p === '/redfish/v1/Systems' ? { Members: [{ '@odata.id': '/redfish/v1/Systems/System.Embedded.1' }] } : sys),
    send: async (_e, m, p, b, o) => { sent.push([m, p, b, o?.headers || {}]); return typeof sendRes === 'function' ? sendRes() : sendRes; } };
};
const E = (id) => ({ id, host: 'https://192.0.2.11', username: 'u', password: 'p' });

test('실행 코어 — 허용 값 안에서만 · 강제 재시작 대체(PowerCycle) · LED 새/옛 속성 · 401 · 거절 메시지 · 시한(다시 보내지 않음) · 간격 · 인증 정지', async () => {
  P._resetPowerGapForTest();
  assert.equal(P.resetTypeFor('forceRestart', ['On', 'PowerCycle']), 'PowerCycle');
  assert.equal(P.resetTypeFor('shutdown', ['On', 'ForceOff']), '', '허용 목록에 없으면 보내지 않는다');
  assert.equal(P.resetTypeFor('shutdown', null), 'GracefulShutdown', '목록을 주지 않는 장비는 첫 후보');
  assert.equal(P.resetTypeFor('constructor', []), '');
  let d = fakeDev();
  let r = await P.runDeviceAction(E('a1'), { kind: 'power', action: 'shutdown', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.ok, r.status, r.reset, r.before, d.sent.length], [true, 'accepted', 'GracefulShutdown', 'On', 1]);
  assert.deepEqual(d.sent[0].slice(0, 3), ['POST', '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset', { ResetType: 'GracefulShutdown' }]);
  // 같은 서버 · 같은 종류 60초 안 — 보내지 않는다(LED 는 따로 센다)
  r = await P.runDeviceAction(E('a1'), { kind: 'power', action: 'restart', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, d.sent.length], ['busy', 1]);
  r = await P.runDeviceAction(E('a1'), { kind: 'led', action: 'blink', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, r.prop, d.sent[1][2], d.sent[1][3]['If-Match']], ['accepted', 'IndicatorLED', { IndicatorLED: 'Blinking' }, 'W/"7"']);
  // 새 표준 LED 속성 — 참/거짓(깜빡임은 켜짐으로 · 밝힌다)
  d = fakeDev(SYS({ LocationIndicatorActive: false }));
  r = await P.runDeviceAction(E('a2'), { kind: 'led', action: 'blink', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.prop, d.sent[0][2], /깜빡임을 고를 수 없어/.test(r.message)], ['LocationIndicatorActive', { LocationIndicatorActive: true }, true]);
  // 허용하지 않는 동작 · 대상 없음 — 보내지 않는다
  d = fakeDev(SYS({ Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset', 'ResetType@Redfish.AllowableValues': ['On'] } } }));
  r = await P.runDeviceAction(E('a3'), { kind: 'power', action: 'forceOff', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, d.sent.length], ['not-allowed', 0]);
  d = fakeDev(SYS({ Actions: { '#ComputerSystem.Reset': { target: 'https://evil.example/x' } } }));
  r = await P.runDeviceAction(E('a4'), { kind: 'power', action: 'on', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, d.sent.length], ['not-allowed', 0], '장비가 준 대상 경로도 꼴을 본다');
  // 401 — 다시 보내지 않는다 · 거절 메시지
  let n = 0;
  d = fakeDev(SYS(), () => { n += 1; return { status: 401, ok: false, text: '' }; });
  r = await P.runDeviceAction(E('a5'), { kind: 'power', action: 'on', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, n], ['auth', 1]);
  d = fakeDev(SYS(), { status: 400, ok: false, text: JSON.stringify({ error: { '@Message.ExtendedInfo': [{ Message: 'The requested power state is already set.' }] } }) });
  r = await P.runDeviceAction(E('a6'), { kind: 'power', action: 'on', getJson: d.getJson, send: d.send, authStopped: () => false });
  assert.deepEqual([r.status, r.message], ['error', 'The requested power state is already set.']);
  // 시한 — 받았는지 모른다(다시 보내지 않는다)
  n = 0;
  // 장비가 답하지 않는다 — 실제 요청처럼 끊기 신호를 받으면 끝난다(시한 최소 1초 — util/deadline.js)
  const hang = { getJson: d.getJson, send: async (_e, _m, _p, _b, o) => { n += 1; return new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))); } };
  r = await P.runDeviceAction(E('a7'), { kind: 'power', action: 'on', getJson: hang.getJson, send: hang.send, authStopped: () => false, timeoutMs: 1000 });
  assert.deepEqual([r.status, n, /닿았는지 모릅니다/.test(r.message)], ['timeout', 1, true]);
  // 인증 정지 · 모르는 동작
  d = fakeDev();
  assert.equal((await P.runDeviceAction(E('a8'), { kind: 'power', action: 'on', getJson: d.getJson, send: d.send, authStopped: () => true })).status, 'auth-stopped');
  assert.equal((await P.runDeviceAction(E('a9'), { kind: 'power', action: 'nuke' })).status, 'bad-args');
  assert.equal((await P.runDeviceAction(E('a9'), { kind: 'led', action: 'party' })).status, 'bad-args');
  assert.equal(d.sent.length, 0);
  // 엣지 응답 정제 — 아는 상태만 · ok 는 accepted 일 때만
  assert.deepEqual(P.sanitizeDeviceAction({ ok: true, status: 'pwn', http: 999, message: 'x\u0000y', extra: 1 }), { ok: false, status: 'error', message: 'x y' });
  assert.equal(P.sanitizeDeviceAction({ ok: 'yes' }), null);
});

test('켜기 스위치 — 기본 꺼짐 · 강제는 켜져 있을 때만 · 참/거짓만 · 손상 · 모르는 판은 꺼짐 + 쓰기 거절', () => {
  RP.remotePower._resetForTest();
  assert.deepEqual([RP.remotePower.get().enabled, RP.remotePower.get().allowForce], [false, false]);
  assert.equal(RP.remotePower.save({ enabled: 'true' }).status, 400);
  assert.deepEqual(RP.remotePower.save({ enabled: false, allowForce: true }).value.allowForce, false, '꺼져 있으면 강제도 꺼짐');
  assert.deepEqual([RP.remotePower.save({ enabled: true, allowForce: true }).value.allowForce], [true]);
  const w = console.error; const ww = console.warn; console.error = () => {}; console.warn = () => {};
  try {
    for (const body of ['{oops', JSON.stringify({ v: 9, enabled: true })]) {
      RP.remotePower._resetForTest(); fs.writeFileSync(path.join(tmp, 'bm-power.json'), body);
      assert.equal(RP.remotePower.get().enabled, false, body);
      assert.equal(RP.remotePower.save({ enabled: true }).status, 409);
      for (const f of fs.readdirSync(tmp).filter((x) => x.startsWith('bm-power.json'))) fs.rmSync(path.join(tmp, f), { force: true });
    }
  } finally { console.error = w; console.warn = ww; RP.remotePower._resetForTest(); }
});

test('중앙 라우트 — 게이트 순서(권한 → 범위 404 → 쓰기 범위 403 → 꺼짐 → 강제 → 사유 → 이름 → 실행) · 다시 보내지 않음 · 감사(성공 · 실패) · 엣지 서버는 그 엣지에 열쇠로', async () => {
  const fleet = await import('../src/central/fleet.js');
  const bs = await import('../src/bmfolders/store.js');
  const sm = await import('../src/servicemap/store.js');
  const registry = await import('../src/idrac/registry.js');
  const invCache = await import('../src/idrac/invCache.js');
  const { store } = await import('../src/store.js');
  const { config } = await import('../src/config.js');
  const { registerBmFolders, _setTrendDepsForTest } = await import('../src/routes/api/bmFolders.js');
  bs._resetForTest(); sm._resetForTest(); fleet.resetEdgeFleet(); RP.remotePower._resetForTest();
  fs.writeFileSync(path.join(tmp, 'service-map.json'), JSON.stringify({ rev: 0, globals: [], settings: { tagCategory: '' }, corps: {} }));
  fs.writeFileSync(path.join(tmp, 'service-map-pins.json'), JSON.stringify({ rev: 0, pins: {} }));
  registry.importServers([{ id: 's1', name: 'synth-db-s1', host: 'https://192.0.2.11', username: 'root', password: 'x', serviceTag: 'SYNTH01', model: 'PowerEdge R750', vcenterId: 'vc-a' }, { id: 's2', name: 'synth-db-s2', host: 'https://192.0.2.12', username: 'root', password: 'x', serviceTag: 'SYNTH02', model: 'PowerEdge R750' }], 'replace');
  invCache.setInventory('s1', { collectedAt: 1, collections: { system: 'ok' }, system: { serviceTag: 'SYNTH01', model: 'PowerEdge R750' } });
  const prevTok = config.central.token; config.central.token = 'synth-central-token';
  fleet.setEdgeFleet('pl-edge', [{ fleetId: 'synth08', name: 'synth-edge-08', serviceTag: 'SYNTH08', model: 'PowerEdge R750', vcenterId: 'vc-a', source: 'idrac' }], 'g1', { verified: true, vcAllowed: () => true });
  const calls = [];
  _setTrendDepsForTest({ resolvePerfTarget: async () => null, perfTargetFail: () => ({}), targets: {},
    hwLogEntry: async (id) => (id === 's1' ? { id, host: 'https://192.0.2.11' } : null), hwLogDemo: async () => null, powerDemo: async () => null,
    powerLocal: async (entry, o) => { calls.push(['local', entry.id, o]); return { ok: true, status: 'accepted', http: 204, reset: 'GracefulShutdown', before: 'On' }; },
    powerEdge: async (agent, q) => { calls.push(['edge', agent, q]); return { ok: true, body: { ok: false, status: 'error', message: 'refused by 192.0.2.99' } }; } });
  const routes = new Map();
  registerBmFolders({ get: (p, ...h) => routes.set(`GET ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h) });
  const U = (username, role, vcenters = [], writeVcenters = []) => ({ username, role, scope: { vcenters, regions: [], writeVcenters } });
  const ADMIN = U('admin', 'admin'); const OPER = U('oper1', 'operator'); const VIEWER = U('viewer1', 'viewer'); const SC_B = U('sc-b', 'operator', ['vc-b']); const RO_A = U('ro-a', 'operator', ['vc-a', 'vc-b'], ['vc-b']);
  const call = async (key, { user = ADMIN, body = {}, query = {} } = {}) => {
    const res = { statusCode: 200, body: undefined, headersSent: false, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; this.headersSent = true; return this; }, set() { return this; }, setHeader() {} };
    const req = { user, body, query, ip: '127.0.0.1', headers: {}, method: key.split(' ')[0], originalUrl: `/api${key.slice(5)}?u=${user.username}&r=${Math.random()}` };
    for (const h of routes.get(key)) {
      let called = false;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve, reject) => { const nx = (err) => { if (err) reject(err); else { called = true; resolve(); } }; Promise.resolve(h(req, res, nx)).then(() => { if (!called) resolve(); }, reject); });
      if (!called || res.headersSent) break;
    }
    return res;
  };
  const audit = () => { try { return fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } };
  const prev = store.snapshot;
  try {
    store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now() + 9000, vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
    const list = (await call('GET /tools/bm-folders')).body;
    const k1 = list.servers.find((x) => x.name === 'synth-db-s1').key;
    const ke = list.servers.find((x) => x.name === 'synth-edge-08').key;
    const ok = { key: k1, action: 'shutdown', reason: '점검 작업', confirm: 'synth-db-s1' };
    assert.equal((await call('POST /tools/bm-folders/power', { user: VIEWER, body: ok })).statusCode, 403, '조회 계정');
    assert.equal((await call('POST /tools/bm-folders/power', { user: SC_B, body: ok })).statusCode, 404, '조회 밖 — 존재 은닉');
    const tokRo = (await call('GET /tools/bm-folders', { user: RO_A })).body.servers.find((x) => x.name === 'synth-db-s1').key;
    assert.equal((await call('POST /tools/bm-folders/power', { user: RO_A, body: { ...ok, key: tokRo } })).statusCode, 403, '쓰기 범위 밖');
    const op = await call('POST /tools/bm-folders/power', { user: OPER, body: ok });
    assert.deepEqual([op.statusCode, op.body.code], [403, 'power-admin'], '전원은 전체 범위 관리자만(설계 ⑦) — 운영자 403');
    const off = await call('POST /tools/bm-folders/power', { user: ADMIN, body: ok });
    assert.deepEqual([off.statusCode, off.body.code], [403, 'remote-power-off'], '기본 꺼짐');
    assert.equal((await call('POST /tools/bm-folders/led', { user: OPER, body: { key: k1, state: 'on' } })).statusCode, 403, 'LED 도 같은 스위치');
    RP.remotePower.save({ enabled: true, allowForce: false });
    assert.equal((await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, action: 'forceOff' } })).body.code, 'force-off');
    assert.equal((await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, reason: 'ab' } })).statusCode, 400, '사유');
    assert.equal((await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, confirm: 'synth-db' } })).body.code, 'confirm', '이름을 그대로');
    assert.equal((await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, action: '__proto__' } })).statusCode, 400);
    assert.equal((await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, reason: ['x'] } })).statusCode, 400, '글자가 아닌 값');
    assert.equal((await call('POST /tools/bm-folders/power', { user: OPER, body: ok })).body.code, 'power-admin', '켜진 뒤에도 운영자는 전원을 못 보낸다');
    assert.equal(calls.length, 0, '여기까지 장비에 보낸 것 없음');
    const a0 = audit().length;
    const r = await call('POST /tools/bm-folders/power', { user: ADMIN, body: ok });
    assert.deepEqual([r.statusCode, r.body.ok, r.body.status, r.body.via, r.body.reset], [200, true, 'accepted', 'local', 'GracefulShutdown']);
    assert.deepEqual(calls.at(-1), ['local', 's1', { kind: 'power', action: 'shutdown', expectTag: 'SYNTH01' }], '서비스 태그를 넘겨 장비 쪽에서 대조한다(반증 A5)');
    assert.equal((await call('POST /tools/bm-folders/led', { user: RO_A, body: { key: tokRo, state: 'on' } })).statusCode, 403, 'LED — 그 법인 쓰기 범위 밖 403');
    assert.equal((await call('POST /tools/bm-folders/led', { user: SC_B, body: { key: k1, state: 'on' } })).statusCode, 404, 'LED — 조회 밖 404');
    const led = await call('POST /tools/bm-folders/led', { user: OPER, body: { key: k1, state: 'blink' } });
    assert.deepEqual([led.body.ok, calls.at(-1)[2]], [true, { kind: 'led', action: 'blink', expectTag: 'SYNTH01' }]);
    // 엣지 서버 — 그 엣지에 열쇠(k)로 · 장비 메시지는 전체 범위 관리자 판본만 원문(LED 는 운영자 — 주소를 가린다)
    const e = await call('POST /tools/bm-folders/power', { user: ADMIN, body: { key: ke, action: 'restart', reason: '점검 작업', confirm: 'synth-edge-08' } });
    assert.deepEqual([e.body.ok, e.body.via, e.body.status, e.body.message], [false, 'edge', 'error', 'refused by 192.0.2.99']);
    assert.deepEqual(calls.at(-1), ['edge', 'pl-edge', { k: 'synth08', kind: 'power', action: 'restart', by: 'admin', reason: '점검 작업' }]);
    const el = await call('POST /tools/bm-folders/led', { user: OPER, body: { key: ke, state: 'on' } });
    assert.deepEqual([el.body.via, el.body.message], ['edge', 'refused by •••'], '운영자 판본은 주소를 가린다');
    const acts = audit().slice(a0).map((x) => [x.action, /장비가 받음/.test(x.detail)]);
    assert.deepEqual(acts, [['물리서버 원격 전원 조작 요청', false], ['물리서버 원격 전원 조작', true], ['물리서버 위치 LED 요청', false], ['물리서버 위치 LED', true], ['물리서버 원격 전원 조작 요청', false], ['물리서버 원격 전원 조작', false], ['물리서버 위치 LED 요청', false], ['물리서버 위치 LED', false]], '보내기 전 · 결과 모두 감사(반증 A12)');
    // 미분류(법인 없음) 서버 — 운영자는 404 · 전체 범위 관리자는 게이트를 지난다(이 시험 등록에는 보낼 길이 없어 400 — 반증 A13 · 변이 S08)
    const k2 = list.servers.find((x) => x.name === 'synth-db-s2')?.key;
    if (k2) {
      assert.equal((await call('POST /tools/bm-folders/led', { user: OPER, body: { key: k2, state: 'on' } })).statusCode, 404, '미분류 서버 — 운영자 404');
      assert.equal((await call('POST /tools/bm-folders/led', { user: ADMIN, body: { key: k2, state: 'on' } })).statusCode, 400, '미분류 서버 — 관리자는 게이트를 지나 보낼 길 판정까지');
    }
    // 이 노드에서 진행 중 · 간격 안이면 OTP 를 쓰기 전에 409(반증 A11 · 변이 S09)
    P._resetPowerGapForTest();
    const dv = fakeDev();
    await P.runDeviceAction({ id: 's1', host: 'https://192.0.2.11' }, { kind: 'power', action: 'on', getJson: dv.getJson, send: dv.send, authStopped: () => false });
    { const pa = config.auth.enabled; config.auth.enabled = true;
      try { const g = await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, action: 'restart' } }); assert.deepEqual([g.statusCode, g.body.status], [409, 'busy'], 'OTP 앞에서 진행 중 거절'); } finally { config.auth.enabled = pa; } }
    P._resetPowerGapForTest();
    // 인증 켠 포탈 — 모든 칸이 맞아도 본인 OTP 가 없으면 장비에 보내지 않는다(변이 M20) · 조회 계정 LED 403(변이 M14)
    const n0 = calls.length; P._resetPowerGapForTest();
    const prevAuth = config.auth.enabled; config.auth.enabled = true;
    try {
      const o = await call('POST /tools/bm-folders/power', { user: ADMIN, body: { ...ok, action: 'restart' } });
      assert.deepEqual([o.statusCode, !!(o.body.needEnroll || o.body.needOtp), calls.length], [403, true, n0]);
    } finally { config.auth.enabled = prevAuth; }
    assert.equal((await call('POST /tools/bm-folders/led', { user: VIEWER, body: { key: k1, state: 'on' } })).statusCode, 403, '조회 계정 LED');
    // 화면 상태
    const st = (await call('GET /tools/bm-folders/power-state', { user: VIEWER })).body;
    assert.deepEqual([st.enabled, st.allowForce, st.canUse, st.canPower, Object.keys(st.actions)], [true, false, false, false, ['on', 'shutdown', 'restart', 'forceRestart', 'forceOff']]);
    const so = (await call('GET /tools/bm-folders/power-state', { user: OPER })).body;
    assert.deepEqual([so.canUse, so.canPower], [true, false], '운영자 — LED 만');
    assert.equal((await call('GET /tools/bm-folders/power-state', { user: ADMIN })).body.canPower, true);
  } finally { store.snapshot = prev; _setTrendDepsForTest(null); fleet.resetEdgeFleet(); config.central.token = prevTok; RP.remotePower._resetForTest(); }
});

test('엣지 대행 왕복 — 실제 collector ↔ 실제 pull ↔ 가짜 iDRAC · 토큰이 먼저 · 꺼진 등록 not-found · 엣지 끄기 스위치 · 경로 없는 엣지 old-version · 시한은 다시 보내지 않음', async (t) => {
  const express = (await import('express')).default;
  const bmc = { hits: [], mode: 'ok' };
  const app = express();
  app.use('/bmc', express.json(), (req, res) => {
    bmc.hits.push(`${req.method} ${req.url}`);
    if (req.url === '/redfish/v1/Systems') return res.json({ Members: [{ '@odata.id': bmc.mode === 'ilo' ? '/redfish/v1/Systems/1/' : '/redfish/v1/Systems/System.Embedded.1' }] });
    if (req.method === 'GET' && req.url === '/redfish/v1/Systems/1/') return res.json(SYS({ Actions: { '#ComputerSystem.Reset': { target: '/redfish/v1/Systems/1/Actions/ComputerSystem.Reset/', 'ResetType@Redfish.AllowableValues': ['On'] } } }));
    if (req.method === 'GET' && req.url === '/redfish/v1/Systems/System.Embedded.1') return res.json(bmc.mode === 'tag' ? SYS({ SKU: 'OTHER99' }) : SYS());
    if (req.method === 'POST' && /ComputerSystem\.Reset\/?$/.test(req.url)) { if (bmc.mode === 'hang') return undefined; if (bmc.mode === 'drop') { req.socket.destroy(); return undefined; } return res.status(204).end(); }
    if (req.method === 'PATCH') return res.status(200).json({});
    return res.status(404).json({});
  });
  const { collectorRouter } = await import('../src/routes/collector.js');
  app.use('/api/collector', collectorRouter);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${srv.address().port}`;
  const oldApp = express(); oldApp.use((req, res) => res.status(404).send('Not Found'));
  const oldSrv = await new Promise((r) => { const s = oldApp.listen(0, '127.0.0.1', () => r(s)); });
  t.after(() => { srv.closeAllConnections?.(); srv.close(); oldSrv.closeAllConnections?.(); oldSrv.close(); for (const k of ['BM_POWER_EDGE_DISABLE', 'BM_POWER_EDGE_ENABLE', 'BM_POWER_EDGE_FORCE', 'BM_POWER_EDGE_MAX']) delete process.env[k]; });
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'r1', name: 'synth-r1', host: `${base}/bmc`, username: 'root', password: 'pw', serviceTag: 'SYNTH21' }, { id: 'r2', name: 'synth-r2', host: `${base}/bmc`, username: 'root', password: 'pw', serviceTag: 'SYNTH22', enabled: false }, { id: 'r3', name: 'synth-r3', host: `${base}/bmc`, username: 'root', password: 'pw', serviceTag: 'SYNTH23' }], 'replace');
  const reg = await import('../src/collector/registry.js');
  assert.equal(reg.addCollector({ id: 'self-edge', name: 'self-edge', url: base, token: 'tok-power-rt' }).ok, true);
  assert.equal(reg.addCollector({ id: 'old-edge', name: 'old-edge', url: `http://127.0.0.1:${oldSrv.address().port}`, token: 'tok-power-rt' }).ok, true);
  const PL = await import('../src/central/bmPowerPull.js');
  P._resetPowerGapForTest();
  // 엣지가 스스로 켜지 않으면 토큰만으로는 보내지 않는다(반증 A1) — 장비 호출 0
  const off = await PL.pullEdgePower('self-edge', { k: 'synth21', kind: 'power', action: 'shutdown', by: 'oper1', reason: '점검 작업' });
  assert.deepEqual([off.kind, bmc.hits.length], ['edge-disabled', 0]);
  process.env.BM_POWER_EDGE_ENABLE = 'true';
  // 강제 동작은 엣지가 따로 허용해야
  assert.deepEqual([(await PL.pullEdgePower('self-edge', { k: 'synth21', kind: 'power', action: 'forceOff' })).kind, bmc.hits.length], ['edge-force-off', 0]);
  const a = await PL.pullEdgePower('self-edge', { k: 'synth21', kind: 'power', action: 'shutdown', by: 'oper1', reason: '점검 작업' });
  assert.deepEqual([a.ok, a.body.ok, a.body.status, a.body.reset], [true, true, 'accepted', 'GracefulShutdown']);
  assert.ok(bmc.hits.includes('POST /redfish/v1/Systems/System.Embedded.1/Actions/ComputerSystem.Reset'));
  const auditActs = fs.readFileSync(path.join(tmp, 'audit.ndjson'), 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x).action);
  assert.ok(auditActs.includes('물리서버 원격 전원 조작 요청(중앙)') && auditActs.includes('물리서버 원격 전원 조작(중앙 요청)'), '엣지도 보내기 전 · 결과를 감사한다(변이 M27)');
  assert.equal((await PL.pullEdgePower('self-edge', { id: 'r2', kind: 'power', action: 'on' })).kind, 'not-found', '꺼진 등록');
  assert.equal((await PL.pullEdgePower('old-edge', { id: 'r1', kind: 'power', action: 'on' })).kind, 'old-version');
  assert.equal((await fetch(`${base}/api/collector/bm-power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403, '토큰이 먼저');
  process.env.BM_POWER_EDGE_DISABLE = 'true';
  assert.equal((await PL.pullEdgePower('self-edge', { id: 'r3', kind: 'power', action: 'on' })).kind, 'edge-disabled');
  delete process.env.BM_POWER_EDGE_DISABLE;
  // 장비가 알려 준 서비스 태그가 등록과 다르면 보내지 않는다(반증 A5)
  bmc.mode = 'tag'; bmc.hits = [];
  const tg = await PL.pullEdgePower('self-edge', { id: 'r3', kind: 'power', action: 'on' });
  assert.deepEqual([tg.body?.status, bmc.hits.filter((x) => x.startsWith('POST')).length], ['tag-mismatch', 0]);
  // HPE iLO 꼴 끝 슬래시 경로 — 받는다(반증 A4)
  bmc.mode = 'ilo'; bmc.hits = []; P._resetPowerGapForTest();
  const il = await PL.pullEdgePower('self-edge', { id: 'r3', kind: 'power', action: 'on' });
  assert.deepEqual([il.body?.status, bmc.hits.includes('POST /redfish/v1/Systems/1/Actions/ComputerSystem.Reset/')], ['accepted', true]);
  // 받은 뒤 연결이 끊김 — ‘보내지 못함’ 이 아니라 ‘모름’(반증 A3)
  bmc.mode = 'drop'; bmc.hits = []; P._resetPowerGapForTest();
  const dr = await PL.pullEdgePower('self-edge', { id: 'r3', kind: 'power', action: 'on' });
  assert.deepEqual([dr.body?.status, bmc.hits.filter((x) => x.startsWith('POST')).length], ['timeout', 1], JSON.stringify(dr).slice(0, 200));
  bmc.mode = 'ok'; P._resetPowerGapForTest();
  // 장비가 답하지 않음 — 엣지가 시한으로 끊고 ‘모름’ · 다시 보내지 않는다
  bmc.mode = 'hang'; bmc.hits = [];
  const h = await PL.pullEdgePower('self-edge', { id: 'r3', kind: 'power', action: 'restart' });
  assert.equal(bmc.hits.filter((x) => x.startsWith('POST')).length, 1, '한 번만 보냈다');
  assert.ok(['timeout', 'error'].includes(h.ok ? h.body.status : h.kind), JSON.stringify(h).slice(0, 200));
  // 엣지 전체 상한 — 10분 창 안 건수가 상한에 닿으면 429(장비 호출 0)
  bmc.mode = 'ok'; bmc.hits = []; process.env.BM_POWER_EDGE_MAX = '1';
  assert.deepEqual([(await PL.pullEdgePower('self-edge', { id: 'r1', kind: 'led', action: 'on' })).kind, bmc.hits.length], ['edge-rate', 0]);
});

test('경계 — OTP 게이트(인증 켠 포탈) · 설정 라우트 게이트 · 조회 계정 LED · 이상한 System 경로 · 같은 틱 두 호출 · 엣지 당김 재시도 0 · 데모 막이', async () => {
  const { config } = await import('../src/config.js');
  // 이상한 Members 꼴 — 보내지 않는다(변이 M05 — LED PATCH 대상이 이 경로)
  P._resetPowerGapForTest();
  for (const odd of ['https://evil.example/redfish/v1/Systems/1', '/redfish/v1/Systems/../Managers/1', '/redfish/v1/Systems/1/Bios']) {
    const sent = [];
    const r = await P.runDeviceAction(E(`odd${odd.length}`), { kind: 'led', action: 'on', authStopped: () => false, getJson: async (_e, p) => (p === '/redfish/v1/Systems' ? { Members: [{ '@odata.id': odd }] } : SYS()), send: async (...a) => { sent.push(a); return { status: 204, ok: true, text: '' }; } });
    assert.deepEqual([r.status, sent.length], ['error', 0], odd);
  }
  // 같은 틱의 두 호출 — 하나만 보낸다(반증 A10)
  P._resetPowerGapForTest();
  const d = fakeDev();
  const [x1, x2] = await Promise.all([1, 2].map(() => P.runDeviceAction(E('race'), { kind: 'power', action: 'on', getJson: d.getJson, send: d.send, authStopped: async () => false })));
  assert.deepEqual([[x1.status, x2.status].sort(), d.sent.length], [['accepted', 'busy'], 1]);
  // 엣지 당김은 재시도 0 · 경로 없는 엣지의 401 도 구버전으로(변이 M29 · M30) · 엣지 데모 막이(변이 M28)
  const { stripComments } = await import('./_stripComments.js');
  const pull = stripComments(fs.readFileSync(new URL('../src/central/bmPowerPull.js', import.meta.url), 'utf8'));
  assert.match(pull, /retries: 0,/); assert.match(pull, /missing401: true/);
  const col = stripComments(fs.readFileSync(new URL('../src/routes/collector.js', import.meta.url), 'utf8'));
  assert.match(col, /if \(isMockMode\(\)\) \{ release\(\); return res\.json\(\{ ok: true, status: 'accepted'/);   // 데모는 상한 자리를 돌려준다(디버깅 2회차 보안 #2)
  // 설정 라우트(PUT /admin/bm-power) — 관리자 · 전체 범위 · OTP(변이 M51 · M52)
  const { registerBmAssets } = await import('../src/routes/admin/bmAssets.js');
  const routes = new Map();
  registerBmAssets({ get: (p, ...h) => routes.set(`GET ${p}`, h), put: (p, ...h) => routes.set(`PUT ${p}`, h), post: (p, ...h) => routes.set(`POST ${p}`, h), delete: () => {} });
  const U = (username, role, vcenters = []) => ({ username, role, scope: { vcenters, regions: [], writeVcenters: [] } });
  const call = async (key, user, body = {}) => {
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
  const { store } = await import('../src/store.js');
  const prevSnap = store.snapshot; const prevAuth = config.auth.enabled;
  store.snapshot = { ...store.snapshot, initial: false, generatedAt: Date.now(), vcenters: [{ id: 'vc-a', name: 'a', status: 'ok' }, { id: 'vc-b', name: 'b', status: 'ok' }], hosts: [], vms: [] };
  RP.remotePower._resetForTest(); RP.remotePower.save({ enabled: false });   // 앞 시험이 켠 스위치를 끄고 시작
  try {
    config.auth.enabled = true;
    assert.equal((await call('PUT /bm-power', U('oper1', 'operator'), { enabled: true })).statusCode, 403, '운영자');
    assert.equal((await call('PUT /bm-power', U('sadm', 'admin', ['vc-a']), { enabled: true })).statusCode, 403, '범위 관리자');
    const noOtp = await call('PUT /bm-power', U('admin', 'admin'), { enabled: true });
    assert.deepEqual([noOtp.statusCode, !!(noOtp.body.needEnroll || noOtp.body.needOtp), RP.remotePower.get().enabled], [403, true, false], '인증 켠 포탈 — OTP 없으면 켜지지 않는다');
    config.auth.enabled = false;
    const ok = await call('PUT /bm-power', U('admin', 'admin'), { enabled: true, allowForce: false });
    assert.deepEqual([ok.statusCode, RP.remotePower.get().enabled], [200, true]);
  } finally { config.auth.enabled = prevAuth; store.snapshot = prevSnap; RP.remotePower.save({ enabled: false }); RP.remotePower._resetForTest(); }
});
