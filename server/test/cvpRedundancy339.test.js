/**
 * test/cvpRedundancy339.test.js — v3.41 CVP 빈 칸 점검 · ③ 버전 준수 · ⑧ 이중화(docs/design/cvp-network-features §3 · 사용자 실장비 캡처).
 *  ① 파서 — 속도 보강(단위 붙은 값만) · VLAN(스위치포트) · 채널 소속(포인터 포함) · MLAG · 포트에 얹기
 *  ② 수집기 실제 호출(가짜 CVP) — 부품 주기에 VLAN · 채널 · MLAG 를 읽고 다음(부품 아닌) 주기에도 직전 값을 쓴다
 *  ③ 엣지 정제 — mlagStatus · cfgReadAt 는 아는 칸만 · 문자열 상한 · 시각은 수신 시각으로 자른다
 *  ④ 버전 준수 — 날짜 읽기(ms · s · ISO) · 못 읽음 ≠ 공지 없음 · 지원 종료 지남/곧 · Overview '지원 종료 지남' 이 이제 센다(점검 결함)
 *  ⑤ 이중화 — 채널 상태 · MLAG 판정 · 소속 못 읽음은 따로
 *  ⑥ 실제 라우터 — /tools/cvp/compliance · /redundancy 200 · 범위 계정 403 · DB 를 거친 mlagStatus
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpred339-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const P = await import('../src/cvp/parse.js');
const C = await import('../src/cvp/client.js');
const E = await import('../src/central/cvpEdge.js');
const CP = await import('../src/cvp/compliance.js');
const R = await import('../src/cvp/redundancy.js');
const DAY = 86_400_000;
const NOW = Math.floor(Date.now() / DAY) * DAY - 12 * 3_600_000;   // 어제 정오(UTC) — 날 경계에서 떨어뜨려 고정
const segs = (s) => s.split('/').filter(Boolean);
const note = (p, updates) => ({ timestamp: '1737996752057206753', path_elements: segs(p), updates });
const ptrU = (base, k) => ({ key: k, value: { ptr: [...segs(base), k] } });

test('① 파서', () => {
  assert.equal(P.firstSpeed({ linkModeStatus: 'linkModeForced100GbpsFull' }), 100e9, '이름에 linkmode · 값에 단위');
  assert.equal(P.firstSpeed({ speed: 'speed2p5Gbps' }), 2.5e9);
  assert.equal(P.firstSpeed({ 'x.autonegSpeed': 'speed10Gbps' }), null, '자동 협상 · 광고 칸은 지금 속도가 아니다');
  assert.equal(P.firstSpeed({ speedLanes: 4 }), null, '단위 없는 수는 추정하지 않는다');
  const n = (p, u) => JSON.stringify({ notifications: [note(p, u)] });
  const sw = P.parseSwitchport(n('/Sysdb/bridging/switchIntfConfig/switchIntfConfig/all', {
    Ethernet1: { value: { switchportMode: { Name: 'switchportModeAccess' }, accessVlan: { int: 120 }, enabled: true } },
    Ethernet2: { value: { switchportMode: { Name: 'switchportModeTrunk' }, trunkNativeVlan: 10, enabled: true } },
    Ethernet3: { value: { enabled: false, switchportMode: { Name: 'switchportModeAccess' }, accessVlan: 1 } },
  }));
  assert.deepEqual([...sw.vlans], [['Ethernet1', '120'], ['Ethernet2', 'trunk · native 10'], ['Ethernet3', 'routed']]);
  assert.equal(P.parseSwitchport('{"notifications":[]}').vlans, null, '빈 응답은 못 읽음');
  const lp = P.parseLagMembers(n('/Sysdb/lag/input/config/cli/phyIntf/Ethernet1', { lag: { value: { ptr: ['Sysdb', 'lag', 'input', 'config', 'cli', 'lagIntfConfig', 'Port-Channel10'] } } }));
  assert.deepEqual([...lp.members], [['Ethernet1', 'Port-Channel10']], '포인터로 온 소속');
  const la = P.parseLagMembers(n('/x/phyIntf/all', { Ethernet4: { value: { channelGroup: 'Port-Channel 7' } }, Ethernet5: { value: { lag: '' } } }));
  assert.deepEqual([...la.members], [['Ethernet4', 'Port-Channel7']], '소속 없는 포트(빈 값)는 넣지 않는다');
  assert.equal(P.parseLagMembers(n('/x', { foo: { value: 1 } })).members, null, '채널 필드가 없는 응답은 못 읽음');
  // 반증 E1: 채널 표에 포트 개체가 있으면 소속 칸이 없는 포트 = 채널 없음(읽음 — 빈 맵). null 이면 연속 실패 차단이 소속 읽기를 멈춘다.
  const none = P.parseLagMembers(n('/x/phyIntf/all', { Ethernet1: { value: { mode: 'x' } }, Ethernet2: { value: { mode: 'y' } } }));
  assert.ok(none.members instanceof Map && none.members.size === 0);
  // 반증 E6: 'flags' 칸은 lag 가 아니다
  assert.equal(P.parseLagMembers(n('/x/phyIntf/Ethernet1', { flags: { value: { ptr: ['a', 'Port-Channel9'] } } })).members, null);
  assert.equal(P.firstSpeed({ maxSpeed: 'speed100Gbps' }), null, '반증 E7: 최대 속도는 지금 속도가 아니다');
  const ml = P.parseMlag(n('/Sysdb/mlag/status', { mlagState: { value: { Name: 'mlagStateActive' } }, negotiationStatus: { value: { Name: 'connected' } }, peerLinkStatus: { value: 'linkUp' }, domainId: { value: 'D1' } }));
  assert.deepEqual([ml.status.state, ml.status.negotiation, ml.status.peerLinkState, ml.status.domain], ['active', 'connected', 'up', 'D1']);
  assert.equal(P.parseMlag(n('/Sysdb/mlag/status', { foo: { value: 1 } })).status, null);
  const ports = [{ name: 'Ethernet1', vlan: '', lag: '' }, { name: 'Ethernet9', vlan: '', lag: 'Port-Channel3' }, { name: 'Ethernet8', vlan: 'x', lag: 'junk' }];
  const m = P.mergeL2Cfg(ports, { vlans: new Map([['Ethernet1', '120']]), members: new Map([['Ethernet1', 'Port-Channel10']]) });
  assert.deepEqual(m.map((p) => [p.vlan, p.lag]), [['120', 'Port-Channel10'], ['', 'Port-Channel3'], ['x', '']], '맵에 없는 포트: 채널 이름이면 남기고 아니면 비운다');
  assert.equal(P.mergeL2Cfg(ports, { vlans: null, members: null })[2].lag, 'junk', '둘 다 못 읽었으면 그대로');
  assert.equal(P.mergeL2Cfg(ports, { members: new Map(), partial: { lag: true } })[2].lag, 'junk', '반증 F1: 일부만 읽은 맵이면 맵에 없는 포트를 비우지 않는다');
  // 길어도 선형
  const t0 = process.hrtime.bigint();
  P.parseLagMembers(n('/x/phyIntf/Ethernet1', { lag: { value: 'port-channel'.repeat(50_000) } }));
  assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 300);
});

test('② 수집기 실제 호출 — 부품 주기에 읽고 다음 주기에도 직전 값', async () => {
  const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';
  const SW = '/Sysdb/bridging/switchIntfConfig/switchIntfConfig';
  const LG = '/Sysdb/lag/input/config/cli/phyIntf';
  const serial = 'SN-R';
  const up = (rest) => note(rest, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, adminStatus: { key: 'adminStatus', value: { Name: 'intfAdminUp' } } });
  const routes = (rest) => {
    if (rest === IS) return { notifications: [note(IS, { Ethernet1: ptrU(IS, 'Ethernet1'), Ethernet2: ptrU(IS, 'Ethernet2') })] };
    if (rest === `${IS}/Ethernet1` || rest === `${IS}/Ethernet2`) return { notifications: [up(rest)] };
    if (rest === SW) return { notifications: [note(SW, { Ethernet1: ptrU(SW, 'Ethernet1') })] };
    if (rest === `${SW}/Ethernet1`) return { notifications: [note(rest, { switchportMode: { value: { Name: 'switchportModeAccess' } }, accessVlan: { value: { int: 120 } }, enabled: { value: true } })] };
    if (rest === LG) return { notifications: [note(LG, { Ethernet1: ptrU(LG, 'Ethernet1'), Ethernet2: ptrU(LG, 'Ethernet2') })] };
    if (rest === `${LG}/Ethernet1` || rest === `${LG}/Ethernet2`) return { notifications: [note(rest, { lag: { value: { ptr: ['Sysdb', 'lag', 'input', 'Port-Channel10'] } } })] };
    if (rest === '/Sysdb/mlag/status') return { notifications: [note(rest, { mlagState: { value: { Name: 'mlagStateActive' } }, negotiationStatus: { value: 'connected' }, peerLinkStatus: { value: 'linkUp' } })] };
    return null;
  };
  const srv = http.createServer((req, res) => {
    const send = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(typeof b === 'string' ? b : JSON.stringify(b)); };
    const raw = new URL(req.url, 'http://x').pathname;
    if (raw === '/api/resources/inventory/v1/Device/all') return send({ result: { value: { key: { deviceId: serial }, hostname: 'sw-r', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } });
    const m = new RegExp(`^/api/v1/rest/${serial}(/.*)$`).exec(raw);
    if (!m) return send('{"notifications":[]}');
    const r = routes(m[1].split('/').map((x) => decodeURIComponent(x)).join('/'));
    return send(r == null ? '{"notifications":[]}' : r);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    C._resetL2CfgForTest();
    const server = { id: 'cvp-r', host: `http://127.0.0.1:${srv.address().port}`, authMode: 'token', token: 'T', verifyTls: false };
    const r1 = await C.collectCvp(server, { budgetMs: 30_000, partsDue: true, prefer: new Map() });
    const d1 = r1.devices[0];
    const by = Object.fromEntries(d1.ports.map((p) => [p.name, p]));
    assert.deepEqual([by.Ethernet1.vlan, by.Ethernet1.lag, by.Ethernet2.lag], ['120', 'Port-Channel10', 'Port-Channel10']);
    assert.equal(d1.mlagStatus.state, 'active'); assert.ok(d1.cfgReadAt.lag && d1.cfgReadAt.vlan);
    assert.ok(r1.usedPaths.switchport && r1.usedPaths.lagMember && r1.usedPaths.mlag, '읽은 경로가 상태에 남는다(화면의 빈 칸 이유 · 읽은 경로 탭)');
    const r2 = await C.collectCvp(server, { budgetMs: 30_000, partsDue: false, prefer: new Map() });
    const d2 = r2.devices[0];
    assert.equal(d2.ports.find((p) => p.name === 'Ethernet1').vlan, '120', '부품 아닌 주기에도 직전에 읽은 VLAN');
    assert.equal(d2.mlagStatus.state, 'active');
    assert.ok(d2.cfgReadAt.lag, '부품 아닌 주기에도 읽은 시각을 싣는다');
  } finally { srv.close(); }
});

test('③ 엣지 정제 — mlagStatus · cfgReadAt', () => {
  const now = Date.now();
  const x = E.cleanInfo({ mlagStatus: { state: 'ACTIVE', negotiation: 'connected', peerLinkState: 'up', peerLink: 'Po1000', domain: 'd'.repeat(300), at: now + 10 * DAY, evil: { a: 1 } },
    cfgReadAt: { vlan: now - 1000, lag: 'x', other: 1 }, readKinds: ['bugs', 'hack'] }, now);
  assert.deepEqual(Object.keys(x.mlagStatus).sort(), ['at', 'domain', 'localIntf', 'negotiation', 'peerLink', 'peerLinkState', 'state'], '아는 칸만');
  assert.equal(x.mlagStatus.state, 'active');
  assert.equal(x.mlagStatus.domain.length, 64, '문자열 상한');
  assert.equal(x.mlagStatus.at, now, '엣지 시각은 수신 시각으로 자른다');
  assert.deepEqual(x.cfgReadAt, { vlan: now - 1000, lag: null });
  assert.deepEqual(x.readKinds, ['bugs']);
  assert.equal(E.cleanInfo({ mlagStatus: 'nope' }, now), null, '객체가 아니면 버린다');
  assert.equal(E.cleanInfo({ mlagStatus: {} }, now), null, '반증 F6: 칸이 없는 MLAG 상태는 싣지 않는다(못 읽음)');
  assert.equal(E.cleanInfo({ mlagStatus: { state: 'active', at: -5 } }, now).mlagStatus.at, null, '반증 F6: 음수 시각');
  // 반증 F2: 중앙 정제 상한이 수집 종류 · 탐색 표본 수보다 작으면 새 근거가 버려지고 기존 표본을 밀어낸다.
  assert.ok(E.SAMPLE_KINDS_MAX >= Object.keys(C.CANDIDATES).length, `SAMPLE_KINDS_MAX ${E.SAMPLE_KINDS_MAX} < 종류 ${Object.keys(C.CANDIDATES).length}`);
  assert.ok(C.PROBE_MAX >= C.PROBE_PATHS.length);
  const probes = Array.from({ length: C.PROBE_MAX }, (_, i) => ({ path: `/p${i}`, ok: true }));
  assert.equal(E.cleanProbes(probes, now).length, C.PROBE_MAX, '탐색 표본을 PROBE_MAX 까지 받는다(예전 28 고정)');
});

test('④ 버전 준수 · Overview 지원 종료', async () => {
  assert.equal(CP.lifeMs(1_735_689_600_000), 1_735_689_600_000);
  assert.equal(CP.lifeMs(1_735_689_600), 1_735_689_600_000, '초');
  assert.equal(CP.lifeMs('2025-01-01T00:00:00Z'), Date.UTC(2025, 0, 1));
  assert.equal(CP.lifeMs('garbage'), null); assert.equal(CP.lifeMs(''), null); assert.equal(CP.lifeMs(null), null);
  const rk = ['enrich', 'lifecycle', 'bugs'];
  assert.equal(CP.bugState({ readKinds: rk }).state, 'none', '읽었는데 장비 값이 없으면 공지 없음');
  assert.equal(CP.bugState({ readKinds: ['enrich'] }).state, 'unread', '못 읽음은 0 이 아니다');
  assert.equal(CP.bugState({ readKinds: rk, bugs: { bugCount: 2, cveCount: 1, highestCve: 'high' } }).state, 'high');
  assert.equal(CP.lifeState({ readKinds: rk, lifecycle: { swEndOfSupport: NOW - DAY } }, NOW).state, 'passed');
  assert.equal(CP.lifeState({ readKinds: rk, lifecycle: { swEndOfSupport: NOW + 30 * DAY } }, NOW).state, 'soon');
  assert.equal(CP.lifeState({ readKinds: rk, lifecycle: { swEndOfSupport: NOW + 900 * DAY, hwEndOfTacSupport: NOW + 10 * DAY } }, NOW).state, 'soon', '하드웨어가 더 이르면 그 날');
  assert.equal(CP.lifeState({ readKinds: rk, lifecycle: { swEndOfSupport: null } }, NOW).state, 'none', '날짜를 지어내지 않는다');
  assert.equal(CP.lifeState({}, NOW).state, 'unread');
  assert.equal(CP.configState({ readKinds: rk, complianceCode: '0000', complianceIndication: 'NONE' }).state, 'ok');
  assert.equal(CP.configState({ readKinds: rk, complianceCode: '0001', complianceIndication: 'WARNING' }).state, 'warn');
  assert.equal(CP.configState({ readKinds: [] }).state, 'unread');
  const f = CP.complianceFleet([
    { agent: '', cvpId: 'c', key: 'a', hostname: 'a', eosVersion: '4.29.8M', info: { readKinds: rk, lifecycle: { swEndOfSupport: NOW - DAY }, bugs: { bugCount: 1, cveCount: 1, highestCve: 'high' } } },
    { agent: '', cvpId: 'c', key: 'b', hostname: 'b', eosVersion: '4.31.2F', info: { readKinds: rk } },
    { agent: '', cvpId: 'c', key: 'z', hostname: 'z', eosVersion: '4.31.2F', info: null },
  ], { now: NOW });
  assert.equal(f.rows[0].hostname, 'a', '지원 종료 지남 · 높음이 맨 위');
  assert.deepEqual([f.counts.life.passed, f.counts.bugs.high, f.counts.bugs.none, f.counts.bugs.unread, f.counts.cveDevices], [1, 1, 1, 1, 1]);
  assert.equal(f.versions.find((v) => v.version === '4.31.2F').devices, 2);
  // 점검 결함: 수명주기 날짜는 ms 숫자인데 Overview 가 Date.parse 로 읽어 '지원 종료 지남' 이 늘 0 이었다.
  const { buildCvpOverview } = await import('../src/cvp/overview.js');
  const ov = buildCvpOverview({ devices: [{ agent: '', cvpId: 'c1', key: 'k', hostname: 'h', collectedAt: NOW, info: { lifecycle: { swEndOfSupport: NOW - 5 * DAY } } }],
    servers: [{ id: 'c1', name: 'CVP' }], datacenters: [], intervalMs: 300_000, now: NOW });
  assert.equal(ov.totals.swEolPassed, 1);
});

test('⑤ 이중화', () => {
  const P2 = (port, lag, oper, admin = 'up') => ({ port, lag, oper, admin });
  const ch = R.channelsOf([P2('Et1', 'Port-Channel1', 'up'), P2('Et2', 'Port-Channel1', 'up'), P2('Et3', 'Port-Channel2', 'up'), P2('Et4', 'Port-Channel2', 'down'),
    P2('Et5', 'Port-Channel3', 'nolink'), P2('Et6', 'Port-Channel4', 'up'), P2('Et7', 'Port-Channel4', 'unknown'), P2('Et8', 'Port-Channel5', 'down', 'down'), P2('Et9', '', 'up'), P2('Et10', 'junk', 'up')]);
  assert.deepEqual(Object.fromEntries(ch.map((c) => [c.po, c.state])), { 'Port-Channel1': 'ok', 'Port-Channel2': 'degraded', 'Port-Channel3': 'down', 'Port-Channel4': 'unknown', 'Port-Channel5': 'off' });
  const mix = R.channelsOf([P2('Et1', 'Port-Channel9', 'up'), P2('Et2', 'Port-Channel9', 'down'), P2('Et3', 'Port-Channel9', 'unknown')]);
  assert.equal(mix[0].state, 'degraded', '반증 F4: 내려간 멤버가 확인되면 모르는 멤버가 섞여도 이중화 상실');
  assert.equal(R.mlagJudge({ state: 'active', negotiation: 'connected', peerLinkState: 'up' }).state, 'ok');
  assert.equal(R.mlagJudge({ state: 'active', negotiation: 'connected', peerLinkState: 'down' }).state, 'peerDown');
  assert.equal(R.mlagJudge({ state: 'active', negotiation: 'connecting' }).state, 'notConnected');
  assert.equal(R.mlagJudge({ state: 'active', negotiation: '', peerLinkState: '' }).state, 'unknown', '반증 F3: 협상 · 피어 링크를 못 읽으면 정상이 아니다');
  assert.equal(R.mlagJudge({ state: 'active', negotiation: 'connected', peerLinkState: null }).state, 'unknown');
  assert.equal(R.mlagJudge({ state: 'disabled' }).state, 'off');
  assert.equal(R.mlagJudge(null, true).state, 'unread', '인벤토리상 켜짐인데 상태를 못 읽음');
  assert.equal(R.mlagJudge(null, false).state, 'off');
  const f = R.redundancyFleet({ devices: [
    { agent: '', cvpId: 'c', key: 'a', hostname: 'a', info: { cfgReadAt: { lag: NOW }, mlagStatus: { state: 'active', negotiation: 'connected', peerLinkState: 'down' } } },
    { agent: '', cvpId: 'c', key: 'b', hostname: 'b', info: {} },
  ], portsByDev: new Map([['\u0000c\u0000a', [P2('Et1', 'Port-Channel1', 'up'), P2('Et2', 'Port-Channel1', 'down')]]]) });
  assert.equal(f.rows[0].hostname, 'a');
  assert.equal(f.counts.lagUnread, 1, '소속을 못 읽은 장비는 채널 0 이 아니라 따로');
  assert.equal(f.counts.ch.degraded, 1); assert.equal(f.counts.mlag.peerDown, 1); assert.equal(f.counts.mlag.unread, 1);
});

let srv; let base; let cdb; let cvpId; let who = { username: 'adm', role: 'admin', scope: null };
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  const reg = await import('../src/cvp/registry.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = who; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  cvpId = reg.saveServer({ name: 'CVP-R', host: 'https://10.99.0.3', authMode: 'token', token: 't', agent: '' }).id;
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

test('⑥ 실제 라우터 — 버전 준수 · 이중화 · DB 를 거친 MLAG 상태', async () => {
  if (!(await cdb.available())) return;
  const ts = Date.now() - 5000;
  await cdb.saveDevices({ agent: '', cvpId, devices: [{ key: 'R1', ts, hostname: 'kr-leaf-r1', model: 'DCS-7280SR-48C6', eosVersion: '4.27.4M',
    info: { readKinds: ['enrich', 'lifecycle', 'bugs'], lifecycle: { swEndOfSupport: ts - DAY }, complianceCode: '0000', complianceIndication: 'NONE' },
    mlagStatus: { state: 'active', negotiation: 'connected', peerLinkState: 'down', at: ts }, cfgReadAt: { vlan: ts, lag: ts },
    ports: [{ name: 'Ethernet1', oper: 'up', admin: 'up', lag: 'Port-Channel10', vlan: '120' }, { name: 'Ethernet2', oper: 'down', admin: 'up', lag: 'Port-Channel10', vlan: '120' }] }] });
  const get = async (p) => { const r = await fetch(`${base}${p}`); return { s: r.status, j: await r.json() }; };
  let { s, j } = await get('/tools/cvp/compliance');
  assert.equal(s, 200);
  assert.equal(j.rows.find((x) => x.key === 'R1').life.state, 'passed');
  ({ s, j } = await get('/tools/cvp/redundancy'));
  assert.equal(s, 200);
  const r1 = j.rows.find((x) => x.key === 'R1');
  assert.equal(r1.mlag.state, 'peerDown', 'info_json 을 거쳐 mlagStatus 가 남는다');
  assert.equal(r1.channels[0].state, 'degraded');
  assert.equal((await get('/tools/cvp/redundancy?cvpId=nope')).s, 404);
  who = { username: 'sc', role: 'operator', scope: { vcenters: ['vc-1'] } };
  assert.equal((await get('/tools/cvp/compliance')).s, 403); assert.equal((await get('/tools/cvp/redundancy')).s, 403);
  who = { username: 'adm', role: 'admin', scope: null };
});
