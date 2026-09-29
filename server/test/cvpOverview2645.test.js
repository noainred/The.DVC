/**
 * test/cvpOverview2645.test.js — v2.645 CVP Overview·법인 구분·장비 이력.
 *  ① 순수 판정(deviceHealth): 오래됨·스트리밍 끊김·아무것도 못 읽음은 unknown(정상도 이상도 아님) · 부분 읽음은 partial
 *  ② buildCvpOverview: 법인 = CVP 서버 DataCenter · 미지정은 맨 뒤 · 트래픽 합은 측정 포트만(미측정 개수를 밝힌다)
 *     · 모델·버전 묶음 · 이벤트는 error/warning/critical 만 센다
 *  ③ 라우트(실제 api 라우터, AUTH_ENABLED=true): overview·devices·events 가 법인을 싣고 ?corp 로 좁힌다 ·
 *     비-admin 응답에 IPv4 없음 · 범위 계정 403 · 장비 상세 history(열린 장애·전이·이벤트)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cvpov2645-'));
process.env.CONFIG_DIR = tmp;
process.env.DATA_SOURCE = 'mock';
process.env.AUTH_ENABLED = 'true';

const ov = await import('../src/cvp/overview.js');

test('① deviceHealth — 못 본 것은 unknown, 일부만 읽으면 partial', () => {
  const now = 1_000_000_000_000;
  const H = (d) => ov.deviceHealth(d, { now, staleMs: 30 * 60_000, highPct: 80 });
  assert.deepEqual(H({}).reasons, ['never']);
  assert.equal(H({}).state, 'unknown');
  assert.deepEqual(H({ collectedAt: now - 31 * 60_000, ports: { down: 0 } }).reasons, ['stale']);
  assert.deepEqual(H({ collectedAt: now, streaming: false, ports: { down: 0 } }).reasons, ['not-streaming']);
  assert.deepEqual(H({ collectedAt: now }).reasons, ['unread']);
  const ok = H({ collectedAt: now, ports: { down: 0 }, partsList: [{ kind: 'fan', name: 'F', state: 'ok' }] });
  assert.equal(ok.state, 'ok'); assert.equal(ok.partial, false);
  const partial = H({ collectedAt: now, ports: { down: 0 } });
  assert.equal(partial.state, 'ok'); assert.equal(partial.partial, true, '부품을 못 읽은 장비는 partial');
  assert.equal(H({ collectedAt: now, ports: { down: 2 } }).state, 'warn');
  assert.equal(H({ collectedAt: now, ports: { down: 0 }, cpuPct: 91 }).state, 'warn');
  assert.equal(H({ collectedAt: now, bgpPeers: [{ peer: 'x', state: 'Idle' }] }).state, 'bad');
  assert.equal(H({ collectedAt: now, partsList: [{ kind: 'psu', name: 'P', state: 'fault' }] }).state, 'bad');
});

test('② buildCvpOverview — 법인·트래픽·모델·이벤트', () => {
  const now = 1_000_000_000_000;
  const servers = [{ id: 'c1', name: 'CVP-A', datacenterId: 'kr' }, { id: 'c2', name: 'CVP-B', datacenterId: 'pl' }, { id: 'c3', name: 'CVP-C', datacenterId: '' }];
  const dcs = [{ id: 'kr', name: 'Korea' }, { id: 'pl', name: 'Poland' }];
  const devices = [
    { agent: '', cvpId: 'c1', key: 'A1', hostname: 'a1', model: 'DCS-7050', eosVersion: '4.30', collectedAt: now, streaming: true, ports: { down: 0 }, partsList: [{ kind: 'fan', name: 'F', state: 'ok' }] },
    { agent: '', cvpId: 'c1', key: 'A2', hostname: 'a2', model: 'DCS-7050', eosVersion: '4.28', collectedAt: now - 2 * 3600_000, streaming: true, ports: { down: 0 } },
    { agent: '', cvpId: 'c2', key: 'B1', hostname: 'b1', model: 'DCS-7280', eosVersion: '4.30', collectedAt: now, streaming: true, ports: { down: 1 } },
    { agent: '', cvpId: 'c3', key: 'C1', hostname: 'c1', model: 'DCS-7280', eosVersion: '4.30', collectedAt: now, streaming: true, ports: { down: 0 } },
  ];
  const traffic = [
    { agent: '', cvpId: 'c1', key: 'A1', inBps: 1000, outBps: 2000, measured: 4, unmeasured: 1 },
    { agent: '', cvpId: 'c1', key: 'A2', inBps: 0, outBps: 0, measured: 0, unmeasured: 3 },
    { agent: '', cvpId: 'c2', key: 'B1', inBps: 500, outBps: 500, measured: 2, unmeasured: 0 },
  ];
  const events = [{ cvpId: 'c1', severity: 'error' }, { cvpId: 'c2', severity: 'warning' }, { cvpId: 'c2', severity: 'info' }];
  const r = ov.buildCvpOverview({ devices, servers, datacenters: dcs, traffic, events, openFaults: [{ cvpId: 'c2', state: 'fault' }, { cvpId: 'c2', state: 'warn' }], intervalMs: 300_000, now });
  assert.equal(r.totals.devices, 4);
  assert.deepEqual(r.totals.health, { ok: 2, warn: 1, bad: 0, unknown: 1 });
  assert.equal(r.totals.unknownBy.stale, 1);
  assert.deepEqual(r.corps.map((c) => c.corpId), ['kr', 'pl', ''], '이름순 + 미지정은 맨 뒤');
  const kr = r.corps[0];
  assert.equal(kr.corpName, 'Korea');
  assert.equal(kr.traffic.inBps, 1000); assert.equal(kr.traffic.outBps, 2000);
  assert.equal(kr.traffic.portsMeasured, 4); assert.equal(kr.traffic.portsUnmeasured, 4, '측정 못 한 포트 수를 밝힌다');
  assert.equal(kr.traffic.devicesUnmeasured, 1);
  assert.equal(kr.traffic.top[0].hostname, 'a1');
  assert.equal(r.traffic.inBps, 1500);
  assert.equal(r.events.error, 1); assert.equal(r.events.warning, 1, 'info 는 세지 않는다');
  assert.equal(r.corps[1].events.warning, 1);
  assert.equal(r.corps[1].openFaults, 2); assert.equal(r.totals.openFaultsFault, 1);
  assert.equal(r.models[0].count, 2);
  assert.equal(r.modelsSplit, 1, 'DCS-7050 은 버전이 둘로 갈린다');
  assert.equal(r.versions[0].version, '4.30'); assert.equal(r.versions[0].count, 3);
  // 삭제된 DataCenter 를 가리키면 missing
  const miss = ov.corpResolver([{ id: 'x', datacenterId: 'gone' }], dcs)('x');
  assert.equal(miss.missing, true); assert.equal(miss.corpName, 'gone');
});

let srv, base, cdb, reg;
const USERS = {
  admin: { username: 'adm', role: 'admin', scope: null },
  op: { username: 'op', role: 'operator', scope: null },
  sadm: { username: 'sadm', role: 'admin', scope: { vcenters: ['vc-us-east'] } },
};
before(async () => {
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  cdb = await import('../src/cvp/db.js');
  reg = await import('../src/cvp/registry.js');
  const dc = await import('../src/datacenter/store.js');
  dc.addDatacenter({ id: 'kr', name: 'Korea' });
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((req, _res, next) => { req.user = USERS[req.headers['x-u']] || null; next(); });
  app.use('/api', api);
  srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${srv.address().port}/api`;
  const a = reg.saveServer({ name: 'CVP-KR', host: 'https://10.99.0.1', authMode: 'token', token: 'tok', agent: '', datacenterId: 'kr' });
  const b = reg.saveServer({ name: 'CVP-X', host: 'https://10.99.0.2', authMode: 'token', token: 'tok', agent: '' });
  const now = Date.now();
  const dev = (key, model, ip) => ({
    key, ts: now, hostname: `h-${key}`, model, serial: key, mgmtIp: ip, eosVersion: '4.30', streaming: true, telemetry: 'ok',
    parts: [{ kind: 'fan', name: 'Fan1', state: 'ok', detail: '' }], partsAt: now,
    ports: [{ name: 'Ethernet1', speedBps: 1e10, oper: 'up', admin: 'up', inBps: 100, outBps: 200 }],
  });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: a.id, devices: [dev('SN1', 'DCS-7050', '10.99.1.1')], samples: false });
  await cdb.saveDevices({ agent: cdb.LOCAL_AGENT, cvpId: b.id, devices: [dev('SN2', 'DCS-7280', '10.99.1.2')], samples: false });
  await cdb.saveEvents(cdb.LOCAL_AGENT, a.id, [
    { key: 'e1', ts: now - 60_000, severity: 'error', title: 'link down 10.99.1.1', devices: ['SN1'] },
    { key: 'e2', ts: now - 30_000, severity: 'warning', title: 'temp', devices: ['OTHER'] },
  ]);
  await cdb.saveEvents(cdb.LOCAL_AGENT, b.id, [{ key: 'e3', ts: now - 60_000, severity: 'warning', title: 'x', devices: ['SN2'] }]);
  await cdb.applyFaultTransition({ opened: [{ agent: cdb.LOCAL_AGENT, cvpId: a.id, deviceKey: 'SN1', deviceName: 'h-SN1', faultKey: 'bgp:10.99.2.2', kind: 'bgp', label: '10.99.2.2', state: 'fault', detail: 'Idle 10.99.2.2' }] });
  globalThis.__ids = { a: a.id, b: b.id };
});
after(() => { try { srv?.close(); } catch { /* */ } try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

async function call(u, p) {
  const r = await fetch(base + p, { headers: { 'x-u': u } });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* */ }
  return { s: r.status, j, t };
}

test('③-a overview — 법인·트래픽·최근 장애 · 비-admin 주소 없음 · 범위 계정 403', async () => {
  const a = await call('admin', '/tools/cvp/overview');
  assert.equal(a.s, 200);
  assert.equal(a.j.totals.devices, 2);
  const kr = a.j.corps.find((c) => c.corpId === 'kr');
  assert.equal(kr.corpName, 'Korea'); assert.equal(kr.devices, 1);
  assert.equal(kr.traffic.inBps, 100); assert.equal(kr.traffic.outBps, 200);
  assert.equal(a.j.corps.at(-1).corpId, '', '미지정 법인은 맨 뒤');
  assert.equal(a.j.recentFaults.length, 1);
  assert.equal(a.j.recentFaults[0].corpName, 'Korea');
  const o = await call('op', '/tools/cvp/overview');
  assert.equal(o.s, 200);
  assert.equal(o.j.addressHidden, true);
  assert.equal(/10\.99\.\d+\.\d+/.test(o.t), false, '비-admin 응답에 IPv4 가 없다');
  assert.equal((await call('sadm', '/tools/cvp/overview')).s, 403);
});

test('③-b devices·events — 법인을 싣고 ?corp 로 좁힌다', async () => {
  const d = await call('admin', '/tools/cvp/devices');
  const byKey = Object.fromEntries(d.j.devices.map((x) => [x.key, x]));
  assert.equal(byKey.SN1.corpId, 'kr'); assert.equal(byKey.SN1.corpName, 'Korea');
  assert.equal(byKey.SN2.corpId, '');
  const all = await call('admin', '/tools/cvp/events?hours=24');
  assert.equal(all.j.events.length, 3);
  const kr = all.j.corpCounts.find((c) => c.corpId === 'kr');
  assert.deepEqual(kr.bySeverity, { error: 1, warning: 1 });
  const un = all.j.corpCounts.find((c) => c.corpId === '');
  assert.equal(un.total, 1);
  const f = await call('admin', '/tools/cvp/events?hours=24&corp=kr');
  assert.deepEqual(f.j.events.map((e) => e.key).sort(), ['e1', 'e2']);
  assert.ok(f.j.events.every((e) => e.corpName === 'Korea'));
  assert.equal(f.j.corpCounts.length, 2, '법인 칩 개수는 법인 필터 전 기준(고른 법인만 남지 않는다)');
  const none = await call('admin', '/tools/cvp/events?hours=24&corp=nope');
  assert.equal(none.j.events.length, 0, '모르는 법인은 전체로 넓히지 않는다');
  const errs = await call('admin', '/tools/cvp/events?hours=24&severity=errors');
  assert.deepEqual(errs.j.events.map((e) => e.key), ['e1'], 'errors = critical+error 묶음');
  const unassigned = await call('admin', '/tools/cvp/events?hours=24&corp=');
  assert.deepEqual(unassigned.j.events.map((e) => e.key), ['e3']);
});

test('③-c 장비 상세 history — 이 장비의 열린 장애·전이·이벤트만, 비-admin 은 주소 가림', async () => {
  const { a } = globalThis.__ids;
  const r = await call('admin', `/tools/cvp/device?cvpId=${a}&key=SN1`);
  assert.equal(r.s, 200);
  assert.equal(r.j.device.corpName, 'Korea');
  assert.equal(r.j.history.openFaults.length, 1);
  assert.equal(r.j.history.faultEvents.length, 1);
  assert.deepEqual(r.j.history.events.map((e) => e.key), ['e1'], '다른 장비의 이벤트는 싣지 않는다');
  const o = await call('op', `/tools/cvp/device?cvpId=${a}&key=SN1`);
  assert.equal(o.j.history.openFaults[0].faultKey, '(가림)');
  assert.equal(/10\.99\.\d+\.\d+/.test(o.t), false);
});
