/**
 * test/cvpPreview2640.test.js — CVP 실장비 대응 진단 도구(v2.640 ②축) 서버 회귀.
 *   · previewParse 9종 — 합성 응답으로 count·keys · 오류 본문은 ok:false 인데 keys 는 남는다 · 잘못된 JSON → badChunks ·
 *     1MB 초과 절단(truncatedInput) · 모르는 kind · 절대 던지지 않는다
 *   · collectCvp 를 목 CVP 로 실제 호출 — samples 에 inventory·interfaces 의 head, 404 종류는 실패 표본(status 404 + 오류 JSON head),
 *     실패 본문이 2KB 를 넘어도 앞부분은 남는다 · testCvp 의 sample·cvpVersion(성공·실패 둘 다)
 *   · cleanStatus 가 samples 를 좁힌다 — head 5000 → 4096 · 모르는 키 제거 · 17종 → 16 · 없으면 필드 생략(구버전 엣지)
 * ⚠ 목 CVP 응답은 합성이다(실장비 CVP 를 본 적이 없다 — docs/CVP.md). 실측 근거가 생기면 픽스처를 실제 형식으로 바꿀 것.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpPreview2640-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';

const PV = await import('../src/cvp/preview.js');
const C = await import('../src/cvp/client.js');
const E = await import('../src/central/cvpEdge.js');

const noti = (p, updates) => JSON.stringify({ notifications: [{ timestamp: 1, path: p, updates }] });
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/* ── previewParse ─────────────────────────────────────────────────────── */

test('previewParse — 9종 각각 합성 응답을 읽고 count·keys 를 돌려준다', () => {
  const inv = [
    { result: { value: { key: { deviceId: 'SN-A' }, hostname: 'leaf1', modelName: 'DCS-7050', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
    { result: { value: { key: { deviceId: 'SN-B' }, hostname: 'leaf2', modelName: 'DCS-7050', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_INACTIVE' } } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const r1 = PV.previewParse('inventory', inv);
  assert.equal(r1.ok, true); assert.equal(r1.count, 2); assert.equal(r1.format, 'stream');
  assert.ok(r1.keys.includes('hostname') && r1.keys.includes('deviceId'), JSON.stringify(r1.keys));
  assert.equal(r1.items.length, 2); assert.equal(r1.items[0].key, 'SN-A');
  assert.equal(r1.truncatedInput, false); assert.equal(r1.badChunks, 0);

  const r2 = PV.previewParse('cvpVersion', JSON.stringify({ version: '2024.2.0', build: 'x' }));
  assert.equal(r2.ok, true); assert.equal(r2.count, 1); assert.deepEqual(r2.items, [{ version: '2024.2.0' }]);
  assert.ok(r2.keys.includes('build'));

  const r3 = PV.previewParse('interfaces', noti('/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all', {
    Ethernet1: { key: 'Ethernet1', value: { operStatus: { Name: 'intfOperUp' }, adminEnabled: true, speed: { value: 1e10 }, description: 'up' } },
    Ethernet2: { key: 'Ethernet2', value: { operStatus: { Name: 'intfOperDown' }, adminEnabled: true } },
  }));
  assert.equal(r3.ok, true); assert.equal(r3.count, 2); assert.equal(r3.format, 'notifications'); assert.equal(r3.entities, 2);
  assert.equal(r3.unrecognized, 0); assert.ok(r3.keys.includes('operStatus'));
  assert.equal(r3.items.find((p) => p.name === 'Ethernet1').oper, 'up');

  const r4 = PV.previewParse('counters', noti('/Smash/counters/ethIntf/FastCounters/current/Ethernet1', { inOctets: { key: 'inOctets', value: 100 }, outOctets: { key: 'outOctets', value: 50 } }));
  assert.equal(r4.ok, true); assert.equal(r4.count, 1);
  assert.deepEqual(r4.items[0], { name: 'Ethernet1', inOctets: 100, outOctets: 50, inErrors: null, outErrors: null }, 'Map 을 배열로 · 없는 카운터는 null');

  const r5 = PV.previewParse('bgp', noti('/bgp/all', { '10.0.0.1': { value: { bgpPeerState: 'Established', bgpPeerAs: 65001, bgpPeerPrefixesReceived: 42 } }, '10.0.0.2': { value: { bgpPeerState: 'Idle', bgpPeerAs: 65002 } } }));
  assert.equal(r5.ok, true); assert.equal(r5.count, 2);
  assert.equal(r5.summary.established, 1); assert.equal(r5.summary.down, 1); assert.equal(r5.summary.prefixesUnknown, 1);

  const parts = {
    power: [noti('/power/all', { PowerSupply1: { value: { state: 'ok' } }, PowerSupply2: { value: { state: 'powerSupplyFailed' } } }), 'psu', { ok: 1, fault: 1 }],
    cooling: [noti('/cooling/all', { Fan1: { value: { fanState: 'ok' } } }), 'fan', { ok: 1 }],
    temperature: [noti('/temp/all', { Sensor1: { value: { status: 'ok', currentTemperature: 41.5 } } }), 'temp', { ok: 1 }],
    xcvr: [noti('/xcvr/all', { Ethernet1: { value: { xcvrPresence: 'xcvrPresent', state: 'ok' } }, Ethernet2: { value: { xcvrPresence: 'xcvrNotPresent' } } }), 'xcvr', { ok: 1, absent: 1 }],
  };
  for (const [kind, [text, pk, want]] of Object.entries(parts)) {
    const r = PV.previewParse(kind, text);
    assert.equal(r.ok, true, `${kind}: ${r.note}`);
    assert.equal(r.partKind, pk);
    for (const [st, n] of Object.entries(want)) assert.equal(r.summary[st], n, `${kind} ${st}`);
    assert.equal(r.count, Object.values(want).reduce((a, b) => a + b, 0));
  }
  const t = PV.previewParse('temperature', parts.temperature[0]);
  assert.match(t.items[0].detail, /41\.5℃/);
});

test('previewParse — 오류 본문은 ok:false 이지만 keys(있던 필드)는 남는다 · 빈 본문 · 잘못된 JSON 은 badChunks', () => {
  const err = JSON.stringify({ errorCode: '112498', errorMessage: 'Unauthorized User' });
  for (const kind of ['interfaces', 'counters', 'bgp', 'power', 'inventory']) {
    const r = PV.previewParse(kind, err);
    assert.equal(r.ok, false, kind); assert.equal(r.count, null, `${kind}: 형식을 못 읽은 것은 0 이 아니라 null`);
    assert.match(r.note, /인식한 필드가 없습니다/);
    if (kind !== 'inventory') assert.ok(r.keys.includes('errorMessage'), `${kind}: 있던 필드가 곧 진단 — ${JSON.stringify(r.keys)}`);
  }
  const v = PV.previewParse('cvpVersion', err);
  assert.equal(v.ok, false); assert.match(v.note, /errorMessage/);
  assert.equal(PV.previewParse('interfaces', '').ok, false);
  assert.match(PV.previewParse('interfaces', '   ').note, /비어/);
  const bad = PV.previewParse('interfaces', '{"notifications":[{"path":"/a/all","updates":{"Ethernet1":{"value":{"operStatus":"up"}}}}]}{broken json');
  assert.equal(bad.badChunks, 1, JSON.stringify(bad));
  assert.match(bad.note, /조각 1개/);
  assert.equal(bad.ok, true, '읽을 수 있는 조각은 읽는다');
  const junk = PV.previewParse('bgp', 'not json at all }{');
  assert.equal(junk.ok, false); assert.ok(junk.badChunks >= 1);
  // 비문자열·모르는 kind·괴상한 입력 — 던지지 않는다
  assert.equal(PV.previewParse('interfaces', null).ok, false);
  assert.equal(PV.previewParse('interfaces', { a: 1 }).ok, false);
  const u = PV.previewParse('routes', '{}');
  assert.equal(u.ok, false); assert.equal(u.reason, 'unknown-kind');
  assert.equal(PV.previewParse(null, '{}').reason, 'unknown-kind');
  assert.equal(PV.previewParse('__proto__', '{}').reason, 'unknown-kind');
});

test('previewParse — 입력이 PREVIEW_TEXT_MAX 를 넘으면 자르고 truncatedInput 으로 밝힌다', () => {
  const big = JSON.stringify({ notifications: [{ path: '/x/all', updates: { Ethernet1: { value: { operStatus: 'up', description: 'y'.repeat(PV.PREVIEW_TEXT_MAX) } } } }] });
  assert.ok(big.length > PV.PREVIEW_TEXT_MAX);
  const r = PV.previewParse('interfaces', big);
  assert.equal(r.truncatedInput, true);
  assert.equal(r.kind, 'interfaces');
  assert.ok(r.badChunks >= 1, '잘린 JSON 은 조각으로 센다(던지지 않는다)');
  const small = PV.previewParse('interfaces', noti('/x/all', { Ethernet1: { value: { operStatus: 'up' } } }));
  assert.equal(small.truncatedInput, false);
});

/* ── collectCvp / testCvp 표본 ────────────────────────────────────────── */

function mockCvp({ token = 'TOK', bigErr = false } = {}) {
  const srv = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { errorMessage: 'unauthorized' });
    if (p === '/api/resources/inventory/v1/Device/all') {
      return send(200, [
        { result: { value: { key: { deviceId: 'SN-LEAF1' }, hostname: 'leaf1', modelName: 'DCS-7050', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
        { result: { value: { key: { deviceId: 'SN-LEAF2' }, hostname: 'leaf2', modelName: 'DCS-7050', softwareVersion: '4.30.1F', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
      ].map((x) => JSON.stringify(x)).join('\n'));
    }
    if (p === '/cvpservice/cvpInfo/getCvpInfo.do') return send(200, { version: '2024.2.0' });
    const m = /^\/api\/v1\/rest\/([^/]+)\/(.*)$/.exec(p);
    if (m) {
      const [, serial, rest] = m;
      if (rest === 'Sysdb/interface/status/eth/phy/slice/1/intfStatus/all') {
        return send(200, noti(`/Sysdb/interface/status/eth/phy/slice/1/intfStatus/all`, { Ethernet1: { key: 'Ethernet1', value: { operStatus: { Name: 'intfOperUp' }, adminEnabled: true, description: serial } } }));
      }
      if (rest === 'Smash/counters/ethIntf/FastCounters/current') return send(200, noti('/Smash/counters/ethIntf/FastCounters/current/Ethernet1', { inOctets: { key: 'inOctets', value: 100 } }));
      if (rest === 'Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable') return send(404, { errorCode: '404', errorMessage: bigErr ? `no such path ${'x'.repeat(5000)}` : 'no such path' });
      if (rest === 'Sysdb/environment/power/status') return send(200, noti('/power/all', { PowerSupply1: { value: { state: 'ok' } } }));
      if (rest === 'Sysdb/environment/cooling/status') return send(403, { errorMessage: 'RBAC denied' });
      return send(404, {});
    }
    return send(404, { error: 'not found' });
  });
  return srv;
}

test('collectCvp — samples: 성공 종류는 head(원문 앞부분) · 404 종류는 실패 표본(status + 오류 JSON head) · 장비별 종류는 1건', async () => {
  const srv = mockCvp({ token: 'T1' });
  const port = await listen(srv);
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T1' }, { budgetMs: 60_000, partsDue: true });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.samples && typeof r.samples === 'object');
    const inv = r.samples.inventory;
    assert.equal(inv.ok, true); assert.equal(inv.status, 200); assert.equal(inv.path, '/api/resources/inventory/v1/Device/all');
    assert.match(inv.head, /SN-LEAF1/); assert.ok(inv.bytes > inv.head.length - 1 && inv.head.length <= C.SAMPLE_HEAD_CHARS);
    assert.equal(typeof inv.at, 'number');
    assert.equal(r.samples.cvpVersion.ok, true); assert.match(r.samples.cvpVersion.head, /2024\.2\.0/);
    const intf = r.samples.interfaces;
    assert.equal(intf.ok, true); assert.match(intf.head, /Ethernet1/);
    assert.ok(['SN-LEAF1', 'SN-LEAF2'].includes(intf.device), '어느 장비의 응답인지 밝힌다');
    assert.match(intf.head, new RegExp(intf.device), '표본의 head 는 그 장비의 응답이다');
    assert.equal(Object.keys(r.samples).filter((k) => k === 'interfaces').length, 1, '장비별 종류는 1건(전 장비를 담지 않는다)');
    const bgp = r.samples.bgp;
    assert.equal(bgp.ok, false); assert.equal(bgp.status, 404);
    assert.match(bgp.head, /no such path/, '실패 본문의 앞부분이 남는다(예전에는 cancel 만 했다)');
    assert.match(bgp.reason, /HTTP 404/);
    assert.equal(bgp.path, C.CANDIDATES.bgp[0]);
    const cool = r.samples.cooling;
    assert.equal(cool.status, 403); assert.match(cool.head, /RBAC denied/);
    assert.equal(r.samples.power.ok, true);
    assert.equal(r.samples.temperature.status, 404);
    // 기존 필드는 그대로
    assert.equal(r.usedPaths.inventory, '/api/resources/inventory/v1/Device/all');
    assert.match(r.missing.bgp || '', /404/);
    assert.equal(r.devices.length, 2);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

test('collectCvp — 실패 본문이 2KB 를 넘어도 앞부분은 남고 head 는 상한 안이다 · 인벤토리 실패 시에도 samples 가 있다', async () => {
  const srv = mockCvp({ token: 'T2', bigErr: true });
  const port = await listen(srv);
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T2' }, { budgetMs: 60_000, partsDue: false });
    assert.equal(r.ok, true, r.error);
    const bgp = r.samples.bgp;
    assert.equal(bgp.ok, false);
    assert.match(bgp.head, /no such path/);
    assert.ok(bgp.head.length <= C.SAMPLE_FAIL_BYTES, `실패 head 는 ${C.SAMPLE_FAIL_BYTES} 이하(${bgp.head.length})`);
    assert.ok(bgp.bytes <= C.SAMPLE_FAIL_BYTES);
  } finally { srv.closeAllConnections?.(); srv.close(); }
  // 인벤토리 후보 전부 404 — ok:false 이지만 samples.inventory 에 마지막 실패가 남는다
  const dead = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ errorMessage: 'gone' })); });
  const dp = await listen(dead);
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${dp}`, authMode: 'password', username: 'u', password: 'p' }, { budgetMs: 60_000 }).catch((e) => ({ ok: false, error: e.message }));
    // 로그인 자체가 404 라 openSession 이 던진다 — 그건 상위 규약(로그인 HTTP 404). 토큰 방식으로 다시.
    assert.equal(r.ok, false);
    const r2 = await C.collectCvp({ host: `http://127.0.0.1:${dp}`, authMode: 'token', token: 'T' }, { budgetMs: 60_000 });
    assert.equal(r2.ok, false);
    assert.equal(r2.samples.inventory.ok, false); assert.equal(r2.samples.inventory.status, 404);
    assert.match(r2.samples.inventory.head, /gone/);
    assert.equal(r2.samples.inventory.path, C.CANDIDATES.inventory[C.CANDIDATES.inventory.length - 1], '마지막 실패가 남는다');
  } finally { dead.closeAllConnections?.(); dead.close(); }
});

test('testCvp — 성공이면 sample(인벤토리 원문 앞부분) + cvpVersion, 실패면 마지막 응답 sample', async () => {
  const srv = mockCvp({ token: 'T3' });
  const port = await listen(srv);
  try {
    const ok = await C.testCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T3' });
    assert.equal(ok.ok, true); assert.equal(ok.deviceCount, 2);
    assert.equal(ok.cvpVersion, '2024.2.0');
    assert.equal(ok.sample.ok, true); assert.equal(ok.sample.path, ok.usedPath); assert.match(ok.sample.head, /leaf1/);
    assert.ok(ok.sample.bytes >= ok.sample.head.length);
    const bad = await C.testCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'WRONG' });
    assert.equal(bad.ok, false); assert.equal(bad.authFailed, true);
    assert.equal(bad.sample.status, 401); assert.match(bad.sample.head, /unauthorized/, '401 본문도 진단 근거로 남는다');
  } finally { srv.closeAllConnections?.(); srv.close(); }
  const dead = http.createServer((req, res) => { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ errorMessage: 'gone' })); });
  const dp = await listen(dead);
  try {
    const r = await C.testCvp({ host: `http://127.0.0.1:${dp}`, authMode: 'token', token: 'T' });
    assert.equal(r.ok, false); assert.match(r.reason, /후보 경로 전부 실패/);
    assert.equal(r.sample.ok, false); assert.equal(r.sample.status, 404); assert.match(r.sample.head, /gone/);
    assert.equal(r.cvpVersion, undefined, '인벤토리를 못 읽으면 버전도 시도하지 않는다');
  } finally { dead.closeAllConnections?.(); dead.close(); }
});

/* ── cleanStatus ───────────────────────────────────────────────────────── */

test('cleanStatus — samples 를 좁힌다: head 5000 → 4096 · 모르는 키 제거 · 17종 → 16 · 수치는 numOrNull · 없으면 필드 생략', () => {
  const now = 1_700_000_000_000;
  const samples = {};
  for (let i = 0; i < 17; i++) samples[`kind${i}`] = { path: `/p/${i}`, head: 'h'.repeat(5000), status: 200, bytes: '1234', ok: true, at: now + 999_999, reason: 'r'.repeat(400), device: 'D', extra: 'x', __proto__: { z: 1 } };
  samples.kind0.status = ''; samples.kind0.bytes = null; samples.kind0.ok = 'true';
  samples.kind1.reason = undefined; samples.kind1.device = undefined;
  const st = E.cleanStatus({ cvpId: 'c1', name: 'n', ok: true, samples: { ...samples, __proto__: null, constructor: { path: '/evil' } }, }, now);
  assert.ok(st.samples);
  assert.equal(Object.keys(st.samples).length, E.SAMPLE_KINDS_MAX, '17종 → 16');
  assert.ok(!('constructor' in st.samples) || typeof st.samples.constructor !== 'object' || !st.samples.constructor.path, '예약 키는 받지 않는다');
  const k0 = st.samples.kind0;
  assert.equal(k0.head.length, E.SAMPLE_HEAD_MAX, 'head 5000 → 4096');
  assert.equal(k0.status, null, "빈 문자열 status 는 0 이 아니라 null");
  assert.equal(k0.bytes, null); assert.equal(k0.ok, false, "'true' 문자열은 true 가 아니다");
  assert.equal(k0.at, now, '미래 시각은 수신 시각으로 clamp');
  assert.equal(k0.reason.length, 300);
  assert.equal(k0.device, 'D');
  assert.equal('extra' in k0, false, '모르는 키 제거');
  assert.deepEqual(Object.keys(k0).sort(), ['at', 'bytes', 'device', 'head', 'ok', 'path', 'reason', 'status'].sort());
  const k1 = st.samples.kind1;
  assert.equal('reason' in k1, false); assert.equal('device' in k1, false);
  assert.equal(k1.bytes, 1234, '숫자 문자열은 수치로');
  assert.equal(k1.ok, true);
  // 없으면 필드 자체가 없다(구버전 엣지) · 객체가 아니면 없다 · 비객체 원소는 건너뛴다
  assert.equal('samples' in E.cleanStatus({ cvpId: 'c1' }, now), false);
  assert.equal('samples' in E.cleanStatus({ cvpId: 'c1', samples: 'x' }, now), false);
  assert.deepEqual(E.cleanStatus({ cvpId: 'c1', samples: { a: null, b: 'str', c: [1] } }, now).samples, {});
  // 기존 필드는 그대로
  assert.equal(st.cvpId, 'c1'); assert.equal(st.ok, true);
  assert.equal(E.SAMPLE_HEAD_MAX, C.SAMPLE_HEAD_CHARS, 'client 의 head 상한과 같은 값');
});

test('sanitizeCvpBody — servers 의 samples 가 cleanStatus 를 거쳐 저장된다(실제 push 본문 모양)', () => {
  const now = 1_700_000_000_000;
  const body = { servers: [{ cvpId: 'own', ok: true, collectedAt: now - 1000, samples: { inventory: { path: '/api/x', head: '{"a":1}', status: 200, bytes: 7, ok: true, at: now - 1000 } } }] };
  const out = E.sanitizeCvpBody(body, new Set(['own']), now);
  assert.equal(out.servers.length, 1);
  assert.deepEqual(out.servers[0].samples, { inventory: { path: '/api/x', head: '{"a":1}', status: 200, bytes: 7, ok: true, at: now - 1000 } });
});
