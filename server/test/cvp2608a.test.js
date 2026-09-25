/**
 * test/cvp2608a.test.js — Arista CloudVision(CVP) 수집의 **순수 판정** 회귀(v2.608).
 * 파서(NDJSON·배열·notifications) · 델타(첫 표본·리셋·간격 비정상·방향별 사용률) · 부품 상태 5종 ·
 * 등록부 비밀 승계(접속 대상 변경 시 폐기) · SSRF 차단 · 설정 빈 칸(이전 값 유지) · 수신 정제(남의 cvp_id·비객체 원소).
 * ⚠ 실장비 CVP 응답을 본 적이 없다 — 픽스처는 관용 형태로 **합성**했다(docs/CVP.md 정직 기록).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp2608a-'));
const P = await import('../src/cvp/parse.js');

const MIN = 60_000;
const NOW = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 30 * MIN; // v2.517 — 경계에서 떨어뜨린 고정 기준

test('인벤토리 — Resource API NDJSON(줄마다 result.value)을 읽는다', () => {
  const nd = [
    { result: { value: { key: { deviceId: 'SN-A1' }, hostname: 'leaf1', modelName: 'DCS-7050SX3', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_ACTIVE' }, type: 'INITIAL' } },
    { result: { value: { key: { deviceId: 'SN-B2' }, hostname: 'spine1', modelName: 'DCS-7280', softwareVersion: '4.29.2F', streamingStatus: 'STREAMING_STATUS_INACTIVE' } } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r = P.parseInventory(nd);
  assert.equal(r.devices.length, 2);
  assert.deepEqual(r.devices[0], { key: 'SN-A1', hostname: 'leaf1', model: 'DCS-7050SX3', serial: 'SN-A1', mgmtIp: '', eosVersion: '4.30.1F', streaming: true });
  assert.equal(r.devices[1].streaming, false);
});

test('인벤토리 — 이어 붙인 객체·JSON 배열·옛 API 배열 모두 읽고, 모르는 형식은 null(0개로 말하지 않는다)', () => {
  const cat = '{"result":{"value":{"key":{"deviceId":"X1"},"hostname":"a"}}}{"result":{"value":{"key":{"deviceId":"X2"},"hostname":"b"}}}';
  assert.equal(P.parseInventory(cat).devices.length, 2);
  const legacy = JSON.stringify([{ hostname: 'l1', serialNumber: 'S1', ipAddress: '10.1.1.1', version: '4.28', streamingStatus: 'active' }]);
  const r = P.parseInventory(legacy);
  assert.equal(r.devices[0].mgmtIp, '10.1.1.1');
  assert.equal(r.devices[0].streaming, true);
  assert.equal(P.parseInventory('{"errorCode":"x"}').devices, null, '인벤토리 필드가 없는 본문은 읽지 못함(null)');
  assert.deepEqual(P.parseInventory('').devices, []);
});

test('인벤토리 — 장비 수 상한은 자르고 개수를 밝힌다', () => {
  const arr = Array.from({ length: 5 }, (_, i) => ({ serialNumber: `S${i}`, hostname: `h${i}` }));
  const r = P.parseInventory(JSON.stringify(arr), { max: 3 });
  assert.equal(r.devices.length, 3);
  assert.equal(r.truncated, 2);
});

test('notifications — 와일드카드(all) 응답은 update 키가 개체, 개별 경로는 경로 끝이 개체', () => {
  const wild = { notifications: [{ path: '/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all', updates: {
    Ethernet1: { key: 'Ethernet1', value: { operStatus: { Name: 'intfOperUp' }, speed: { value: 10_000_000_000 }, adminEnabled: true, description: 'to-srv' } },
    Ethernet2: { key: 'Ethernet2', value: { operStatus: { Name: 'intfOperDown' }, adminEnabled: true } },
    Ethernet3: { key: 'Ethernet3', value: { operStatus: { Name: 'intfOperDown' }, adminEnabled: false } },
  } }] };
  const r = P.parseInterfaces(JSON.stringify(wild));
  assert.equal(r.ports.length, 3);
  const e1 = r.ports.find((p) => p.name === 'Ethernet1');
  assert.equal(e1.oper, 'up'); assert.equal(e1.admin, 'up'); assert.equal(e1.speedBps, 1e10); assert.equal(e1.desc, 'to-srv');
  assert.deepEqual(P.portsSummary(r.ports), { total: 3, up: 1, down: 1 }, 'down 은 관리상 켜진 포트만(쓰지 않는 포트를 장애로 세지 않는다)');
  const single = { notifications: [{ path: '/Smash/counters/ethIntf/FastCounters/current/Ethernet1', updates: { inOctets: { key: 'inOctets', value: 100 }, outOctets: { key: 'outOctets', value: 50 } } }] };
  const c = P.parseCounters(JSON.stringify(single));
  assert.deepEqual(c.counters.get('Ethernet1'), { inOctets: 100, outOctets: 50, inErrors: null, outErrors: null }, '없는 오류 카운터는 0 이 아니라 null');
});

test('오류 본문(인식 필드 없음)을 포트·카운터·부품·피어로 지어내지 않는다', () => {
  const body = JSON.stringify({ errorCode: '404', errorMessage: 'no such path' });
  assert.equal(P.parseInterfaces(body).ports, null);
  assert.equal(P.parseCounters(body).counters, null);
  assert.equal(P.parseParts(body, 'psu').parts, null);
  assert.equal(P.parseBgp(body).peers, null);
  assert.equal(P.parseInterfaces('{}').ports, null);
});

test('speedBps — 숫자·enum·약칭, 모르면 null', () => {
  assert.equal(P.speedBps('speed100Gbps'), 1e11);
  assert.equal(P.speedBps('25G'), 25e9);
  assert.equal(P.speedBps(0), null);
  assert.equal(P.speedBps(''), null);
  assert.equal(P.speedBps(null), null);
});

test('델타 — 첫 표본·음수(리셋)·간격 비정상은 null, 사용률은 방향별이고 100% 초과는 null(클램프 금지)', () => {
  const T = NOW; const I = 5 * MIN;
  const prev = { at: T, c: { inOctets: 1000, outOctets: 2000, inErrors: 3, outErrors: 0 } };
  const cur = { at: T + I, c: { inOctets: 1000 + 37_500_000_000, outOctets: 2000 + 3_750_000_000, inErrors: 5, outErrors: 0 } };
  assert.equal(P.portDelta(null, cur, 1e10, I).inBps, null, '첫 표본');
  const d = P.portDelta(prev, cur, 1e10, I);
  assert.equal(d.inBps, 1e9); assert.equal(d.outBps, 1e8);
  assert.equal(d.inUtil, 10); assert.equal(d.outUtil, 1, 'out 은 out 속도로(합을 한 방향으로 나누지 않는다)');
  assert.equal(d.inErr, 2); assert.equal(d.outErr, 0);
  const reset = P.portDelta(prev, { at: T + I, c: { inOctets: 10, outOctets: 5000, inErrors: 0, outErrors: 0 } }, 1e10, I);
  assert.equal(reset.inBps, null); assert.equal(reset.inErr, null); assert.equal(reset.reason, 'reset');
  assert.equal(P.portDelta(prev, { ...cur, at: T + 4 * I }, 1e10, I).inBps, null, '간격 > 주기×3');
  assert.equal(P.portDelta(prev, { ...cur, at: T }, 1e10, I).inBps, null, '간격 0');
  assert.equal(P.portDelta(prev, cur, null, I).inUtil, null, '속도를 모르면 사용률 null');
  assert.equal(P.portDelta(prev, cur, 1e8, I).inUtil, null, '100% 초과는 null(카운터·속도 불일치 — 조용히 자르지 않는다)');
  const nul = P.portDelta(prev, { at: T + I, c: { inOctets: null, outOctets: 2100, inErrors: null, outErrors: null } }, 1e10, I);
  assert.equal(nul.inBps, null); assert.notEqual(nul.outBps, null);
});

test('부품 상태 5종 — absent 가 먼저, 상태 필드 없으면 unknown, 경고 단어는 warn, healthWord 재사용', () => {
  assert.equal(P.partState({ status: 'notInserted' }), 'absent');
  assert.equal(P.partState({ state: 'ok' }), 'ok');
  assert.equal(P.partState({ status: 'powerSupplyFailed' }), 'fault');
  assert.equal(P.partState({ status: 'warning' }), 'warn');
  assert.equal(P.partState({ status: 'Not OK' }), 'fault', '부정어가 붙은 정상어는 이상');
  assert.equal(P.partState({ name: 'x' }), 'unknown');
  assert.equal(P.partState({ alertRaised: true }), 'fault');
  assert.equal(P.partState({ alertRaised: false }), 'ok');
  assert.equal(P.partState({ status: 'unknown' }), 'unknown');
  const parts = P.parseParts(JSON.stringify({ notifications: [{ path: '/x/all', updates: {
    PowerSupply1: { value: { state: 'ok' } }, PowerSupply2: { value: { state: 'notInserted' } }, Fan1: { value: { status: 'failed' } } } }] }), 'psu').parts;
  assert.deepEqual(P.partsSummary(parts), { ok: 1, warn: 0, fault: 1, unknown: 0, absent: 1 });
  assert.equal(P.partsSummary(null), null, '못 읽은 것은 null(0개와 다르다)');
});

test('BGP — 요약, prefix 를 아무도 모르면 합계 null', () => {
  const body = JSON.stringify({ notifications: [{ path: '/bgp/all', updates: {
    '10.0.0.1': { value: { bgpPeerState: 'Established', bgpPeerAs: 65001, bgpPeerPrefixesReceived: 120 } },
    '10.0.0.2': { value: { bgpPeerState: 'Active', bgpPeerAs: 65002 } } } }] });
  const r = P.parseBgp(body);
  assert.deepEqual(r.summary, { peers: 2, established: 1, down: 1, prefixes: 120, prefixesUnknown: 1 }); // v2.612 COL2612-04: 모르는 피어 수
  assert.equal(P.bgpSummary([{ state: 'Established', prefixes: null }]).prefixes, null);
});

test('splitJsonStream — 큰 입력에서도 선형(정규식 백트래킹 없음)', () => {
  const big = '{"a":1}'.repeat(50_000);
  const t0 = Date.now();
  const r = P.splitJsonStream(big);
  assert.equal(r.values.length, 50_000);
  assert.ok(Date.now() - t0 < 2000);
});

test('등록부 — 비밀은 응답에 없고, 접속 대상(host·계정·인증 방식)이 바뀌면 저장 비밀을 승계하지 않는다', async () => {
  process.env.SSRF_ALLOW_LOOPBACK = '';
  const reg = await import('../src/cvp/registry.js');
  reg._resetForTest();
  const a = reg.saveServer({ name: 'CVP-A', host: 'cvp-a.example', authMode: 'token', token: 'TOK-1' });
  assert.equal(a.token, '********'); assert.equal(a.hasToken, true);
  assert.ok(!JSON.stringify(reg.listServers()).includes('TOK-1'));
  const raw = fs.readFileSync(path.join(process.env.CONFIG_DIR, 'cvp-servers.json'), 'utf8');
  assert.ok(raw.includes('"servers"'));
  // 같은 host 에서 이름만 바꾸면 비밀 유지
  const b = reg.saveServer({ id: a.id, name: 'CVP-A2', host: 'cvp-a.example', authMode: 'token', token: '********' });
  assert.equal(b.hasToken, true); assert.equal(b.droppedSecrets, undefined);
  assert.equal(reg.getServerWithSecret(a.id).token, 'TOK-1');
  // host 를 바꾸면서 비밀을 비우면 거부(새 비밀 필요)
  assert.throws(() => reg.saveServer({ id: a.id, name: 'CVP-A2', host: 'attacker.example', authMode: 'token', token: '********' }), /토큰/);
  assert.equal(reg.getServerWithSecret(a.id).token, 'TOK-1', '거부됐으면 저장 비밀은 그대로');
  // 새 비밀과 함께 host 변경은 허용
  const c = reg.saveServer({ id: a.id, name: 'CVP-A2', host: 'cvp-b.example', authMode: 'token', token: 'TOK-2' });
  assert.equal(reg.getServerWithSecret(c.id).token, 'TOK-2');
  // 인증 방식 변경(token → password) 은 새 비밀번호 필수, 옛 토큰은 버린다
  const d = reg.saveServer({ id: a.id, name: 'CVP-A2', host: 'cvp-b.example', authMode: 'password', username: 'svc', password: 'PW' });
  assert.equal(reg.getServerWithSecret(d.id).token, undefined);
  assert.deepEqual(d.droppedSecrets, ['token']);
  // 계정 변경은 비밀번호 승계 금지
  assert.throws(() => reg.saveServer({ id: a.id, name: 'CVP-A2', host: 'cvp-b.example', authMode: 'password', username: 'other', password: '' }), /비밀번호/);
});

test('등록부 — SSRF 차단(링크로컬·루프백·계정/경로가 든 URL), RFC1918 허용', async () => {
  const reg = await import('../src/cvp/registry.js');
  assert.match(reg.baseUrlOf('169.254.169.254').issue, /차단/);
  assert.match(reg.baseUrlOf('https://127.0.0.1').issue, /차단/);
  assert.match(reg.baseUrlOf('https://u:p@10.0.0.1').issue, /계정/);
  assert.match(reg.baseUrlOf('https://10.0.0.1/api?x=1').issue, /경로/);
  assert.match(reg.baseUrlOf('ftp://10.0.0.1').issue, /http/);
  assert.equal(reg.baseUrlOf('10.20.30.40:8443').base, 'https://10.20.30.40:8443');
  assert.equal(reg.baseUrlOf('https://cvp.corp.example').base, 'https://cvp.corp.example');
  assert.throws(() => reg.saveServer({ name: 'bad', host: '169.254.169.254', authMode: 'token', token: 't' }), /차단/);
});

test('설정 — 빈 칸·비숫자는 이전 값 유지, 명시적 숫자만 반영(하한으로 올림), 기본 꺼짐', async () => {
  const s = await import('../src/cvp/settings.js');
  s._resetForTest();
  const d = s.loadSettings();
  assert.equal(d.enabled, false);
  assert.equal(d.rawRetentionDays, 7);
  s.saveSettings({ enabled: true, intervalMs: 600_000, rawRetentionDays: 14 });
  const b = s.saveSettings({ intervalMs: '', rawRetentionDays: null, dailyRetentionDays: 'abc' });
  assert.equal(b.intervalMs, 600_000, '빈 칸은 이전 값');
  assert.equal(b.rawRetentionDays, 14);
  assert.equal(b.dailyRetentionDays, 730);
  assert.equal(b.enabled, true, 'enabled 가 없으면 그대로');
  assert.equal(s.saveSettings({ intervalMs: 0 }).intervalMs, 60_000, '명시적 0 은 값이고 하한으로 올라간다');
  let called = 0; const off = s.onSettingsChange(() => { called++; });
  s.saveSettings({ intervalMs: 120_000 }); off();
  assert.equal(called, 1, '값이 바뀌면 리스너(타이머 재무장)');
  assert.equal(s.applyCentralSettings({ intervalMs: 120_000, enabled: true }), false, '같으면 적용하지 않는다');
});

test('설정 파일 손상은 보존하고 기본값으로 시작한다', async () => {
  const s = await import('../src/cvp/settings.js');
  s._resetForTest();
  fs.writeFileSync(path.join(process.env.CONFIG_DIR, 'cvp-settings.json'), '{broken');
  assert.equal(s.loadSettings().enabled, false);
  assert.ok(fs.readdirSync(process.env.CONFIG_DIR).some((f) => f.startsWith('cvp-settings.json.corrupt.')));
});

test('수신 정제 — 남의 cvp_id·비객체 원소·짧은 표본 행을 버리고 개수를 밝힌다, 미래 시각은 수신 시각으로', async () => {
  const { sanitizeCvpBody } = await import('../src/central/cvpEdge.js');
  const owned = new Set(['cvp-mine']);
  const r = sanitizeCvpBody({
    servers: [{ cvpId: 'cvp-mine', ok: true, collectedAt: NOW + 10 * 86_400_000, usedPaths: { inventory: '/x', bogus: '/y' }, extra: 'no' }, { cvpId: 'cvp-other', ok: true }, null, 'str'],
    devices: [{ cvpId: 'cvp-mine', key: 'SN1', ts: NOW, hostname: { toString: 1 }, ports: [{ name: 'Et1', oper: 'weird', inBps: '12' }, null], parts: [{ kind: 'psu', name: 'P1', state: 'evil' }] },
      { cvpId: 'cvp-other', key: 'SN2', ts: NOW }, 42, { cvpId: 'cvp-mine', key: '__proto__', ts: NOW }],
    rows: [['cvp-mine', 'SN1', 'Et1', NOW, 1, 2, 3, 4, 5, 6], ['cvp-other', 'SN1', 'Et1', NOW, 1, 2, 3, 4, 5, 6], ['short'], 'x'],
    deviceKeys: { 'cvp-mine': ['SN1', 3], 'cvp-other': ['SN9'] },
  }, owned, NOW);
  assert.equal(r.servers.length, 1);
  assert.ok(r.servers[0].collectedAt <= NOW, '미래 시각은 수신 시각으로');
  assert.deepEqual(Object.keys(r.servers[0].usedPaths), ['inventory'], '모르는 종류 키는 버린다');
  assert.equal(r.servers[0].extra, undefined, '아는 필드만');
  const devs = r.devicesByCvp.get('cvp-mine');
  assert.equal(devs.length, 1);
  assert.equal(devs[0].hostname, '', '객체 값은 글자로 좁힌다');
  assert.equal(devs[0].ports.length, 1); assert.equal(devs[0].ports[0].oper, 'unknown'); assert.equal(devs[0].ports[0].inBps, 12);
  assert.equal(devs[0].parts[0].state, 'unknown');
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.deviceKeys, { 'cvp-mine': ['SN1'] });
  assert.ok(r.dropped.notOwned >= 4, `notOwned=${r.dropped.notOwned}`);
  assert.equal(r.dropped.notObject, 3);
  assert.equal(r.dropped.badId, 1);
  assert.equal(r.dropped.badRow, 2);
});
