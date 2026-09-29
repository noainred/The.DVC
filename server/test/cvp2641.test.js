/**
 * test/cvp2641.test.js — v2.641 CVP 실장비 대응(사용자 캡처로 확인한 CVP 2023.1.1 의 모양을 목 CVP 로 재현).
 *
 * 실장비에서 확인한 사실: 텔레메트리 경로가 HTTP 200 + `{"notifications":[]}`(21 바이트)를 돌려줬고, v2.640 은 그것을
 * '읽었고 0개' 로 세 화면이 초록 `0/0`·'피어 없음' 이라 말했다. 여기서 고정하는 것:
 *   ① 빈 응답은 '읽은 것' 이 아니다 — 포트·BGP 는 null(못 읽음)이고 telemetry 는 'empty', 사유는 EMPTY_REASON
 *   ② 컬렉션 노드의 `_ptr` 포인터를 따라가 하위 개체를 읽는다('Ethernet3/1' 처럼 이름에 '/' 가 있어도 이름이 보존된다)
 *   ③ 카운터는 링크가 올라온 포트만 따라간다(요청 수 절감)
 *   ④ 원문 표본은 빈 응답보다 '응답은 왔지만 못 읽음' 을 우선 남긴다
 *   ⑤ 개요(레거시 인벤토리·수명주기·버그 노출)·CPU·메모리·이벤트가 엣지 DB → push → 실제 centralRouter → 중앙 DB 까지 간다
 *   ⑥ 포트 사용량은 사용률을 계산할 수 없는 포트를 사유별로 센다(0% 로 세지 않는다)
 *   ⑦ 부팅 시각 1970 은 '값 없음'
 * ⚠ 목 CVP 의 포인터·필드 모양은 추정이다(빈 응답만 실장비로 확인했다 — docs/CVP.md §8).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

process.env.CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cvp2641-'));
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.CENTRAL_TOKEN = 'ctok-2641';
process.env.CVP_PUSH_GZIP = 'true';

const P = await import('../src/cvp/parse.js');
const C = await import('../src/cvp/client.js');

const notif = (p, updates) => ({ notifications: [{ timestamp: 1, path: p, updates }] });
const ptr = (base, k) => ({ key: k, value: { _ptr: `${base}/${k}` } });
const EMPTY = '{"notifications":[]}';
const NOW = Math.floor(Date.now() / 3600_000) * 3600_000 - 30 * 60_000; // v2.517 규약 — 경계에서 떨어진 고정 기준

function mockCvp() {
  const hits = { paths: [] };
  let octets = 1_000_000;
  const IS = '/Sysdb/interface/status/eth/phy/slice/1/intfStatus';
  const CT = '/Smash/counters/ethIntf/FastCounters/current/counter';
  const BG = '/Sysdb/routing/bgp/export/vrfBgpPeerInfoStatusEntryTable';
  const srv = http.createServer((req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    const url = new URL(req.url, 'http://x');
    const raw = url.pathname;
    const p = decodeURIComponent(raw);
    hits.paths.push(raw);
    if (req.headers.authorization !== 'Bearer TOK') return send(401, {});
    if (p === '/api/resources/inventory/v1/Device/all') {
      return send(200, [
        { result: { value: { key: { deviceId: 'SN-L3' }, hostname: 'l3sw', modelName: 'DCS-7280SR3', softwareVersion: '4.33.6M', systemMacAddress: '38:38:a6:00:00:01', bootTime: '1970-01-01T00:00:00Z', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
        { result: { value: { key: { deviceId: 'SN-L2' }, hostname: 'l2sw', modelName: 'DCS-7010TX-48', softwareVersion: '4.28.6M', bootTime: '2026-06-01T00:00:00Z', streamingStatus: 'STREAMING_STATUS_ACTIVE' } } },
      ].map((x) => JSON.stringify(x)).join('\n'));
    }
    if (p === '/cvpservice/cvpInfo/getCvpInfo.do') return send(200, { version: '2023.1.1' });
    if (p === '/cvpservice/inventory/devices') {
      return send(200, [
        { serialNumber: 'SN-L3', ipAddress: '10.93.14.27', status: 'Registered', complianceCode: '0000', complianceIndication: 'NONE', bootupTimestamp: 1_780_000_000.5, mlagEnabled: false },
        { serialNumber: 'SN-L2', ipAddress: '10.93.14.28', status: 'Registered', complianceCode: '0001', complianceIndication: 'WARNING' },
      ]);
    }
    if (p === '/api/resources/lifecycle/v1/DeviceLifecycleSummary/all') {
      return send(200, JSON.stringify({ result: { value: { key: { deviceId: 'SN-L3' }, softwareEol: { version: '4.33.6M', endOfSupport: '2028-01-01T00:00:00Z' }, hardwareLifecycleSummary: { endOfSale: { date: '2027-06-01T00:00:00Z' } } } } }));
    }
    if (p === '/api/resources/bugexposure/v1/BugExposure/all') return send(404, { error: 'not found' }); // 이 버전에 없는 API — 사유로 남아야 한다
    if (p === '/api/resources/event/v1/Event/all') {
      return send(200, [
        { result: { value: { key: { key: 'e1', timestamp: new Date(NOW - 60_000).toISOString() }, severity: 'EVENT_SEVERITY_WARNING', title: 'Queue size above threshold', description: 'on 10.93.14.27',
          eventType: 'QUEUE', components: { components: [{ type: 'COMPONENT_TYPE_INTERFACE', components: { deviceId: 'SN-L3', interfaceId: 'Ethernet1' } }] } } } },
        { result: { value: { key: { key: 'e2', timestamp: new Date(NOW - 120_000).toISOString() }, severity: 'EVENT_SEVERITY_CRITICAL', title: 'Output discards detected on interface' } } },
      ].map((x) => JSON.stringify(x)).join('\n'));
    }
    const m = /^\/api\/v1\/rest\/([^/]+)(\/.*)?$/.exec(raw);
    if (!m) return send(404, {});
    const serial = decodeURIComponent(m[1]);
    const rest = (m[2] || '').split('/').map((x) => decodeURIComponent(x)).join('/');
    if (serial === 'SN-L2') return send(200, EMPTY); // 실장비 L2 장비: 전부 빈 응답
    if (rest === `${IS}/all`) return send(200, EMPTY);
    if (rest === IS) return send(200, notif(IS, { Ethernet1: ptr(IS, 'Ethernet1'), Ethernet2: ptr(IS, 'Ethernet2'), 'Ethernet3/1': ptr(IS, 'Ethernet3/1') }));
    if (rest === `${IS}/Ethernet1`) return send(200, notif(`${IS}/Ethernet1`, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, adminEnabled: { key: 'adminEnabled', value: true }, speed: { key: 'speed', value: { Name: 'speed10Gbps' } }, description: { key: 'description', value: 'uplink' } }));
    if (rest === `${IS}/Ethernet2`) return send(200, notif(`${IS}/Ethernet2`, { operStatus: { key: 'operStatus', value: { Name: 'intfOperDown' } }, adminEnabled: { key: 'adminEnabled', value: true } }));
    if (rest === `${IS}/Ethernet3/1`) {
      if (!raw.includes('Ethernet3%2F1')) return send(404, {}); // 이름의 '/' 는 인코딩돼야 한다
      return send(200, notif(`${IS}/Ethernet3/1`, { operStatus: { key: 'operStatus', value: { Name: 'intfOperUp' } }, adminEnabled: { key: 'adminEnabled', value: true } }));
    }
    if (rest === CT) return send(200, notif(CT, { Ethernet1: ptr(CT, 'Ethernet1'), Ethernet2: ptr(CT, 'Ethernet2'), 'Ethernet3/1': ptr(CT, 'Ethernet3/1') }));
    if (rest === `${CT}/Ethernet1`) { octets += 5_000; return send(200, notif(`${CT}/Ethernet1`, { statistics: { key: 'statistics', value: { inOctets: octets, outOctets: octets * 2, inErrors: 0, outErrors: 0 } } })); }
    if (rest.startsWith(`${CT}/`)) return send(200, notif(rest, { statistics: { key: 'statistics', value: { inOctets: 1, outOctets: 1 } } }));
    if (rest === BG) return send(200, notif(BG, { default: ptr(BG, 'default') }));
    if (rest === `${BG}/default`) return send(200, notif(`${BG}/default`, { '10.0.0.1': ptr(`${BG}/default`, '10.0.0.1'), '10.0.0.2': ptr(`${BG}/default`, '10.0.0.2') }));
    if (rest === `${BG}/default/10.0.0.1`) return send(200, notif(rest, { bgpPeerState: { key: 'bgpPeerState', value: 'Established' }, bgpPeerAs: { key: 'bgpPeerAs', value: 65001 }, bgpPeerPrefixesReceived: { key: 'bgpPeerPrefixesReceived', value: 42 } }));
    if (rest === `${BG}/default/10.0.0.2`) return send(200, notif(rest, { bgpPeerState: { key: 'bgpPeerState', value: 'Idle' }, bgpPeerAs: { key: 'bgpPeerAs', value: 65002 } }));
    if (rest === '/Kernel/proc/cpu/utilization/total') return send(200, notif(rest, { idle: { key: 'idle', value: 88 }, user: { key: 'user', value: 8 }, system: { key: 'system', value: 4 } }));
    if (rest === '/Kernel/proc/meminfo') return send(200, notif(rest, { memTotal: { key: 'memTotal', value: 8_000_000 }, memAvailable: { key: 'memAvailable', value: 4_500_000 } }));
    return send(200, EMPTY);
  });
  return { srv, hits };
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

let central; let centralPort;
before(async () => {
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const app = express();
  app.use(express.json({ limit: '16mb' }));
  app.use('/api/central', centralRouter);
  central = http.createServer(app);
  centralPort = await listen(central);
});
after(() => { central?.close(); });

test('① 빈 응답(notifications:[])은 읽은 것이 아니다 — 파서는 null, 모양은 empty', () => {
  assert.equal(P.parseInterfaces(EMPTY).ports, null);
  assert.equal(P.parseBgp(EMPTY).peers, null);
  assert.equal(P.parseCounters(EMPTY).counters, null);
  assert.equal(P.parseParts(EMPTY, 'psu').parts, null);
  assert.equal(P.telemetryShape(EMPTY).empty, true);
  // 포인터만 있는 응답도 '읽음 0개' 가 아니다(v2.640 까지 BGP 가 '형식을 읽지 못함' 이던 경우)
  const onlyPtr = JSON.stringify(notif('/t', { default: ptr('/t', 'default') }));
  assert.equal(P.parseBgp(onlyPtr).peers, null);
  assert.deepEqual(P.telemetryShape(onlyPtr).ptrs, [{ key: 'default', ptr: '/t/default' }]);
});

test('⑦ 시각 — 1970 은 값 없음 · 초/밀리초/ISO 를 받는다 · 숫자 문자열을 Date.parse 에 넘기지 않는다', () => {
  assert.equal(P.tsOf('1970-01-01T00:00:00Z'), null);
  assert.equal(P.tsOf(0), null);
  assert.equal(P.tsOf(1_780_000_000), 1_780_000_000_000);
  assert.equal(P.tsOf('1780000000000'), 1_780_000_000_000);
  assert.equal(P.tsOf('2026-06-01T00:00:00Z'), Date.parse('2026-06-01T00:00:00Z'));
  assert.equal(P.tsOf(''), null);
});

test('CPU·메모리 파서 — 퍼센트면 바로(idle+iowait 는 쉼), 누적이면 두 표본 차이, 없으면 null', () => {
  const pct = JSON.stringify(notif('/k', { idle: { key: 'idle', value: 80 }, iowait: { key: 'iowait', value: 10 }, user: { key: 'user', value: 10 } }));
  assert.equal(P.parseCpu(pct).pct, 10, 'iowait 를 busy 로 세지 않는다');
  const c1 = P.parseCpu(JSON.stringify(notif('/k', { idle: { key: 'idle', value: 9000 }, user: { key: 'user', value: 1000 } })));
  const c2 = P.parseCpu(JSON.stringify(notif('/k', { idle: { key: 'idle', value: 9900 }, user: { key: 'user', value: 1100 } })));
  assert.equal(c1.pct, null);
  assert.equal(P.cpuPctFromCounters(null, c1.counters), null, '첫 표본은 null');
  assert.equal(P.cpuPctFromCounters(c1.counters, c2.counters), 10);
  assert.equal(P.parseMemory(JSON.stringify(notif('/m', { memTotal: { key: 'memTotal', value: 1000 }, memFree: { key: 'memFree', value: 100 }, buffers: { key: 'buffers', value: 100 }, cached: { key: 'cached', value: 300 } }))).pct, 50);
  assert.equal(P.parseMemory(EMPTY).pct, null);
});

test('이벤트·수명주기·버그 노출·레거시 인벤토리 파서 — 모르는 형식은 null', () => {
  const ev = P.parseEvents(JSON.stringify({ result: { value: { key: { key: 'a', timestamp: '2026-09-01T00:00:00Z' }, severity: 'EVENT_SEVERITY_ERROR', title: 't',
    components: { components: [{ components: { deviceId: 'SN1' } }] } } } }));
  assert.equal(ev.events.length, 1);
  assert.equal(ev.events[0].severity, 'error');
  assert.deepEqual(ev.events[0].devices, ['SN1']);
  assert.equal(ev.bySeverity.error, 1);
  assert.equal(P.parseEvents('{"errorCode":"x"}').events, null);
  const bugs = P.parseBugExposure([
    JSON.stringify({ result: { value: { key: { deviceId: 'D', acknowledgement: 'ACKNOWLEDGEMENT_ACKNOWLEDGED' }, bugCount: 1 } } }),
    JSON.stringify({ result: { value: { key: { deviceId: 'D', acknowledgement: 'ACKNOWLEDGEMENT_UNACKNOWLEDGED' }, bugCount: 5, cveCount: 2, highestCveExposure: 'HIGHEST_EXPOSURE_HIGH' } } }),
  ].join('\n'));
  assert.equal(bugs.map.get('D').bugCount, 5, '확인하지 않은 것을 우선');
  assert.equal(bugs.map.get('D').highestCve, 'high');
  const leg = P.parseLegacyInventory(JSON.stringify([{ serialNumber: 'S', ipAddress: '10.1.1.1', bootupTimestamp: 1_780_000_000 }]));
  assert.equal(leg.map.get('S').mgmtIp, '10.1.1.1');
  assert.equal(leg.map.get('S').bootAt, 1_780_000_000_000);
});

test('childPath — 포인터가 부모 + 키면 키를 인코딩해 붙인다(Ethernet3/1 의 / 보존) · .. 조각은 버린다', () => {
  const parent = '/api/v1/rest/SN/Sysdb/intf';
  assert.equal(C.childPath('SN', parent, 'Ethernet3/1', '/Sysdb/intf/Ethernet3/1'), `${parent}/Ethernet3%2F1`);
  assert.equal(C.childPath('SN', parent, 'x', '/Other/../../etc/y'), '/api/v1/rest/SN/Other/etc/y');
});

test('수집(목 CVP) — 포인터 추종으로 포트·카운터·BGP·CPU·메모리를 읽고, 전부 빈 응답인 장비는 못 읽음(0/0 아님) · 개요·이벤트', async () => {
  const { srv, hits } = mockCvp();
  const port = await listen(srv);
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK', verifyTls: false }, { budgetMs: 60_000, partsDue: true, prefer: new Map() });
    assert.equal(r.ok, true);
    const l3 = r.devices.find((d) => d.key === 'SN-L3');
    const l2 = r.devices.find((d) => d.key === 'SN-L2');
    // 포트 — 이름에 '/' 가 있는 포트도 이름이 보존된다
    assert.deepEqual(l3.ports.map((p) => p.name).sort(), ['Ethernet1', 'Ethernet2', 'Ethernet3/1']);
    assert.equal(l3.ports.find((p) => p.name === 'Ethernet1').speedBps, 10e9);
    assert.equal(r.usedPaths.interfaces, '/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus (포인터 추종)');
    // 카운터 — 링크 down 인 Ethernet2 는 따라가지 않는다
    assert.ok(l3.counters instanceof Map && l3.counters.has('Ethernet1'));
    assert.ok(!hits.paths.some((x) => x.includes('FastCounters/current/counter/Ethernet2')), 'down 포트 카운터는 조회하지 않는다');
    // BGP — 테이블 → VRF → 피어 2단 포인터
    assert.deepEqual(l3.bgp.map((p) => p.state).sort(), ['Established', 'Idle']);
    // CPU·메모리
    assert.equal(l3.cpu.pct, 12);
    assert.equal(l3.mem.pct, 43.8);
    // 전부 빈 응답인 L2 — 못 읽음(null)이고 telemetry 'empty', 빈 응답 표지
    assert.equal(l2.ports, null);
    assert.equal(l2.bgp, null);
    assert.equal(l2.telemetry, 'empty');
    assert.equal(l2.portsEmpty, true);
    assert.equal(l2.bgpEmpty, true);
    assert.match(r.missing.interfaces, /빈 응답/);
    // 개요 — 레거시 인벤토리(관리 IP·컴플라이언스·부팅) · 수명주기 · 버그 노출 404 는 사유로
    assert.equal(l3.mgmtIp, '10.93.14.27');
    assert.equal(l3.bootAt, 1_780_000_000_500, 'Resource API 의 1970 대신 레거시 부팅 시각');
    assert.equal(l3.info.complianceIndication, 'NONE');
    assert.equal(l3.info.lifecycle.swEolVersion, '4.33.6M');
    assert.match(r.missing.bugs, /404/);
    assert.equal(l2.bootAt, Date.parse('2026-06-01T00:00:00Z'));
    // 이벤트
    assert.equal(r.events.total, 2);
    assert.equal(r.events.bySeverity.critical, 1);
    // 원문 표본 — BGP 는 성공 표본, L2 의 빈 응답이 성공 표본을 덮지 않는다
    assert.equal(r.samples.bgp.ok, true);
    // 경로 탐색 표본(partsDue) — 스트리밍 장비 1대, 경로·모양이 실린다
    assert.ok(r.probes.length >= 5);
    assert.ok(r.probes.some((x) => x.path === '/api/v1/rest/{serial}/Sysdb/interface/status/eth/phy/slice/1/intfStatus' && x.ptrs === 3));
  } finally { srv.close(); }
});

test('표본 우선순위 — 빈 응답만 받은 종류는 empty 표지, 못 읽은 본문이 빈 응답을 이긴다', async () => {
  const srv = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (p === '/api/resources/inventory/v1/Device/all') return res.end(['A', 'B', 'C'].map((k) => JSON.stringify({ result: { value: { key: { deviceId: k }, hostname: k, streamingStatus: 'STREAMING_STATUS_ACTIVE' } } })).join('\n'));
    if (p.startsWith('/api/v1/rest/B/Sysdb/routing')) return res.end(JSON.stringify(notif('/x', { weird: { key: 'weird', value: 1 } })));
    return res.end(EMPTY);
  });
  const port = await listen(srv);
  try {
    const r = await C.collectCvp({ host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'T', verifyTls: false }, { budgetMs: 60_000, partsDue: false, prefer: new Map() });
    assert.equal(r.samples.bgp.unread, true, '못 읽은 본문이 표본으로 남는다');
    assert.match(r.samples.bgp.head, /weird/);
    assert.equal(r.samples.interfaces.empty, true);
    assert.equal(r.samples.interfaces.ok, false, '빈 응답은 성공이 아니다');
  } finally { srv.close(); }
});

test('⑤ 엣지 수집 → push → 실제 centralRouter → 중앙 DB 에 개요·CPU·메모리·이벤트 · ⑥ 포트 사용량', async () => {
  const { srv } = mockCvp();
  const port = await listen(srv);
  const reg = await import('../src/cvp/registry.js');
  const settings = await import('../src/cvp/settings.js');
  const poller = await import('../src/cvp/poller.js');
  const db = await import('../src/cvp/db.js');
  const push = await import('../src/cvp/push.js');
  const { config } = await import('../src/config.js');
  try {
    settings.saveSettings({ enabled: true });
    // 엣지로 동작: 등록부의 agent 가 이 노드 이름이다(엣지 판정은 CENTRAL_URL 유무 — 수집 뒤 자동 push 도 이 중앙으로 간다)
    config.agent.name = 'edge-2641';
    config.agent.centralUrl = `http://127.0.0.1:${centralPort}`;
    config.agent.centralToken = 'ctok-2641';
    const saved = reg.saveServer({ name: 'cvp-a', host: `http://127.0.0.1:${port}`, authMode: 'token', token: 'TOK', verifyTls: false, agent: 'edge-2641' });
    const r1 = await poller.pollCvpOnce({ manual: true });
    assert.equal(r1.ok, true);
    const r2 = await poller.pollCvpOnce({ manual: true });
    assert.equal(r2.collected, 1);
    const det = await db.deviceDetail(db.LOCAL_AGENT, saved.id, 'SN-L3');
    assert.equal(det.device.cpuPct, 12);
    assert.equal(det.device.info.complianceIndication, 'NONE');
    const e1 = det.ports.find((p) => p.name === 'Ethernet1');
    assert.ok(e1.inBps > 0, '두 번째 주기에 처리량');
    const l2 = await db.deviceDetail(db.LOCAL_AGENT, saved.id, 'SN-L2');
    assert.equal(l2.ports, null, '빈 응답 장비는 포트 못 읽음(0/0 아님)');
    // ⑥ 포트 사용량 — Ethernet1 은 측정, Ethernet2 는 링크 down, Ethernet3/1 은 처리량이 첫 표본뿐이라 noRate 또는 측정
    const pu = await db.portUsage({ agent: db.LOCAL_AGENT, staleMs: 3600_000 }); // 이 테스트는 엣지·중앙이 DB 파일 하나를 쓴다
    assert.equal(pu.counts.notUp, 1, JSON.stringify(pu));
    assert.ok(pu.ports.some((p) => p.port === 'Ethernet1' && p.util != null));
    assert.equal(pu.counts.total, pu.counts.measured + pu.counts.notUp + pu.counts.noSpeed + pu.counts.noRate + pu.counts.stale, '사유별 개수의 합 = 전체');
    // push → 중앙
    const pr = await push.pushCvpNow();
    assert.equal(pr.ok, true, JSON.stringify(pr));
    const central = await db.deviceDetail('edge-2641', saved.id, 'SN-L3');
    assert.ok(central, '중앙 행');
    assert.equal(central.device.info.lifecycle.swEolVersion, '4.33.6M');
    assert.equal(central.device.cpuPct, 12);
    const ser = await db.devSeries({ agent: 'edge-2641', cvpId: saved.id, key: 'SN-L3', hours: 24 });
    assert.ok(ser.points.length >= 1, '중앙 CPU 추이 표본');
    const ev = await db.listEvents({ agent: 'edge-2641', cvpId: saved.id, sinceMs: 24 * 3600_000 });
    assert.equal(ev.events.length, 2);
    assert.equal(ev.counts.critical, 1);
    // 두 번째 push 는 이벤트를 다시 보내지 않는다(워터마크)
    const pr2 = await push.pushCvpNow();
    assert.equal(pr2.ok, true);
  } finally {
    srv.close();
    config.agent.centralUrl = ''; config.agent.centralToken = '';
  }
});
