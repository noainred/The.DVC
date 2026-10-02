// v2.682 그룹 B — iDRAC ↔ ESXi 매칭 · 엣지 인벤토리 계약 · iDRAC 통합 추이 표 캐시.
// R3D-04(태그 불일치는 이름 매칭을 막는다) · R3D-09(BMC IP 는 OS IP 가 아니다) · R3E-01(엣지 export 의 포트 MAC·호스트네임) ·
// R3S-02(엣지 미래 시각 → 수신 시각) · R3P-02(/admin/idrac/trend/table 응답 기억 + 합류).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2682b-'));
process.env.CONFIG_DIR = DIR;
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
process.env.IDRAC_DB_PATH = path.join(DIR, 'idrac-power.db');
process.env.AUTH_ENABLED = 'false';
process.env.DATA_SOURCE = 'mock';
after(() => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } });

const { buildHostMatchIndex, matchHostForServer } = await import('../src/idrac/hostMatch.js');
const { resolveServerForHost, serverKeys, bmcIpOf } = await import('../src/idrac/serverForHost.js');
const { compactInv } = await import('../src/collector/agent.js');
const { sanitizeRemoteServers, sanitizeEdgeExport, sanitizeRemoteInv } = await import('../src/collector/remoteInventory.js');

test('R3D-04 ① hostMatch — 양쪽 태그가 다르면 이름이 같아도 잇지 않는다(tagMismatch) · 한쪽이 비면 이름으로', () => {
  const idx = buildHostMatchIndex([{ id: 'h1', name: 'esx01.corp.local', serviceTag: 'DEF4567' }, { id: 'h2', name: 'esx02', serviceTag: '' }]);
  const m = matchHostForServer(idx, { serviceTag: 'ABC1234', names: ['esx01'] });
  assert.equal(m.host, null); assert.equal(m.matchedBy, null); assert.equal(m.tagMismatch, true);
  assert.equal(matchHostForServer(idx, { serviceTag: '', names: ['esx01'] }).host.id, 'h1', '서버 태그 없음 → 이름');
  assert.equal(matchHostForServer(idx, { serviceTag: 'ABC1234', names: ['esx02'] }).host.id, 'h2', '호스트 태그 없음 → 이름');
  assert.equal(matchHostForServer(idx, { serviceTag: 'def4567', names: ['x'] }).matchedBy, 'serviceTag');
});

test('R3D-04 ② serverForHost — 태그 불일치 서버는 이름·IP·MAC 이 맞아도 연결하지 않고 mismatch/conflict 로 밝힌다', () => {
  const host = { id: 'h1', name: 'esx01.corp.local', vcenterId: 'vc', serviceTag: 'DEF4567', mgmtIp: '10.1.1.11' };
  const r = resolveServerForHost(host, [{ id: 's1', name: 'esx01', serviceTag: 'ABC1234', hostNames: ['10.1.1.11'] }]);
  assert.equal(r.serverId, null);
  assert.equal(r.rules.serviceTag.state, 'mismatch');
  assert.equal(r.reason, 'conflict');
  assert.ok(r.conflicts.includes('serviceTag'));
  assert.equal(r.rules.hostname.state, 'none', '거부된 서버는 이름 근거가 아니다');
  assert.equal(r.tagMismatch[0].id, 's1');
  // 태그 없는 서버는 예전처럼 이름으로 잇는다
  const r2 = resolveServerForHost(host, [{ id: 's2', name: 'esx01' }]);
  assert.equal(r2.serverId, 's2'); assert.equal(r2.rules.serviceTag.state, 'none');
});

test('R3D-09 — BMC 주소(등록 host·인벤토리 BMC NIC)와 같은 이름 IP 는 OS IP 후보가 아니다', () => {
  assert.equal(bmcIpOf('https://10.1.1.5:443/redfish'), '10.1.1.5');
  assert.equal(bmcIpOf('10.1.1.5'), '10.1.1.5');
  assert.equal(bmcIpOf('idrac-x.local'), '');
  const k = serverKeys({ name: '10.1.1.5', host: 'https://10.1.1.5', hostNames: ['10.2.2.2'] });
  assert.deepEqual([...k.ips], ['10.2.2.2']);
  const k2 = serverKeys({ name: 'srv', hostNames: ['10.3.3.3', '10.2.2.2'] }, { network: [{ ipv4: '10.3.3.3, 10.9.9.9' }] });
  assert.deepEqual([...k2.ips], ['10.2.2.2'], '인벤토리 BMC NIC 주소도 뺀다');
  const host = { id: 'h', name: 'esxi-z', mgmtIp: '10.1.1.5', vcenterId: 'vc' };
  const r = resolveServerForHost(host, [{ id: 's', name: '10.1.1.5', host: 'https://10.1.1.5' }]);
  assert.equal(r.serverId, null); assert.equal(r.rules.ip.state, 'none');
});

test('R3E-01 ① compactInv 가 포트 MAC 을 싣고 중앙 INV_SHAPE 가 받는다(한쪽만이면 버려진다)', () => {
  const inv = { nics: [{ name: 'NIC1', model: 'X', ports: [{ id: 'p1', link: 'Up', speedMbps: 10000, mac: '00:11:22:33:44:55', serial: 'no' }] }] };
  const c = compactInv(inv);
  assert.equal(c.nics[0].ports[0].mac, '00:11:22:33:44:55');
  assert.equal(sanitizeRemoteInv(c).nics[0].ports[0].mac, '00:11:22:33:44:55');
  assert.equal(sanitizeRemoteInv({ nics: [{ ports: [{ mac: { toString: 1 } }] }] }).nics[0].ports[0].mac, null, '글자가 아니면 null');
});

test('R3E-01 ② 중앙이 hostNames 를 받는다 — 글자만 · 16개 · 255자 · 버린 원소는 센다', () => {
  const many = Array.from({ length: 20 }, (_, i) => `alias${i}`);
  const { servers, coerced } = sanitizeRemoteServers([
    { id: 'a', hostName: 'srv-a.dom', hostNames: many },
    { id: 'b', hostNames: ['ok', 7, { x: 1 }, 'x'.repeat(400)] },
    { id: 'c', hostNames: 'not-array' },
  ]);
  assert.equal(servers[0].hostNames.length, 16); assert.equal(servers[0].hostName, 'srv-a.dom');
  assert.deepEqual(servers[1].hostNames.map((h) => h.length), [2, 255]);
  assert.equal(servers[2].hostNames, undefined);
  assert.equal(coerced, 3);
});

test('R3E-01 ③ 엣지 export 경유 서버도 IP·MAC 규칙으로 연결된다(BMC 이름은 근거 아님)', async () => {
  const registry = await import('../src/idrac/registry.js');
  registry.importServers([{ id: 'e1', name: '10.7.7.7', host: 'https://10.7.7.7', username: 'root', password: 'x', hostNames: ['10.1.1.11'] }], 'replace');
  const { buildExport } = await import('../src/collector/agent.js');
  const exp = await buildExport();
  const row = exp.servers.find((s) => s.id === 'e1');
  assert.ok(row, 'export 에 서버');
  assert.deepEqual(row.hostNames, ['10.1.1.11'], 'export 가 hostNames 를 싣는다');
  const central = sanitizeEdgeExport(JSON.parse(JSON.stringify(exp))).servers.find((s) => s.id === 'e1');
  // 인벤토리는 엣지 compactInv(포트 MAC 포함)를 거친 것
  central.inv = sanitizeRemoteInv(compactInv({ nics: [{ ports: [{ id: 'p', mac: '00-11-22-33-44-55' }] }] }));
  const host = { id: 'h', name: 'esx-unrelated', vcenterId: 'vc', mgmtIp: '10.1.1.11', nics: [{ mac: '00:11:22:33:44:55' }] };
  const r = resolveServerForHost(host, [central], { invOf: (s) => s.inv });
  assert.equal(r.serverId, 'e1');
  assert.deepEqual(r.matchedBy, ['ip', 'mac']);
  const h2 = { ...host, mgmtIp: '10.7.7.7', nics: [] };
  assert.equal(resolveServerForHost(h2, [central], { invOf: (s) => s.inv }).serverId, null, 'BMC 이름 IP 로는 잇지 않는다');
});

test('R3S-02 — 엣지 미래 시각은 수신 시각으로 자르고 원본을 남긴다(재정리해도 유지)', () => {
  const now = Date.now();
  const fut = now + 365 * 86_400_000;
  const { servers } = sanitizeRemoteServers([{
    id: 'f', sensors: { t: fut, temps: { inlet: 22 } },
    sensorDetail: { at: fut, thermalAt: now - 1000, collAt: fut, list: [{ n: 'Inlet', k: 'temp', v: 22, u: 'C' }] },
  }], { now });
  const s = servers[0];
  assert.equal(s.sensors.t, now); assert.equal(s.sensors.edgeT, fut);
  assert.ok(s.sensorDetail, '센서 상세');
  assert.equal(s.sensorDetail.at, now); assert.equal(s.sensorDetail.collAt, now); assert.equal(s.sensorDetail.thermalAt, now - 1000);
  assert.equal(s.sensorDetail.edgeTimes.at, fut);
  // 저장 경로(setCollectorServers)가 한 번 더 정리해도 원본 시각을 잃지 않는다
  const again = sanitizeRemoteServers(JSON.parse(JSON.stringify(servers)), { now: now + 5 }).servers[0];
  assert.equal(again.sensors.t, now); assert.equal(again.sensors.edgeT, fut); assert.equal(again.sensorDetail.edgeTimes.at, fut);
  // 과거 시각은 그대로
  const past = sanitizeRemoteServers([{ id: 'p', sensors: { t: now - 60_000, temps: { inlet: 20 } } }], { now }).servers[0];
  assert.equal(past.sensors.t, now - 60_000); assert.equal(past.sensors.edgeT, undefined);
});

test('R3P-02 — /admin/idrac/trend/table 같은 조건은 기억된 응답(계산 1회 · 동시 요청 합류) · 조건이 다르면 다른 판본', async () => {
  const src = fs.readFileSync(new URL('../src/routes/admin/idracTrend.js', import.meta.url), 'utf8');
  const seg = src.slice(src.indexOf("'/idrac/trend/table'"), src.indexOf('async function trendTablePayload'));
  assert.match(seg, /snapMemo\('idrac-trend-table'/);
  assert.match(seg, /scopedVcenterIds\(req\.user/);
  assert.match(seg, /req\.user\?\.role/);
  const express = (await import('express')).default;
  const { adminRouter } = await import('../src/routes/admin.js');
  const { store } = await import('../src/store.js');
  await store.refresh();
  const app = express(); app.use('/api/admin', adminRouter);
  const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
  try {
    const base = `http://127.0.0.1:${srv.address().port}/api/admin/idrac/trend/table`;
    const db = await (await import('../src/metrics/db.js')).getMetricsDb();
    let calls = 0;
    const orig = db.latestAll.bind(db);
    db.latestAll = (...a) => { calls += 1; return orig(...a); };
    try {
      const rs = await Promise.all(Array.from({ length: 5 }, () => fetch(`${base}?hours=24`)));
      for (const r of rs) assert.equal(r.status, 200);
      const first = calls;
      // v2.687: 계산 1회 = 지표 10개(iDRAC 7 + ESXi 3)의 latestAll — 5건이 각자 계산했다면 50.
      assert.ok(first > 0 && first <= 10, `동시 5건이 계산 1회에 합류(latestAll 호출 ${first})`);
      const again = await fetch(`${base}?hours=24`); assert.equal(again.status, 200);
      assert.equal(calls, first, '30초 안 같은 조건은 다시 계산하지 않는다');
      await fetch(`${base}?hours=48`);
      assert.ok(calls > first, '조건이 다르면 새로 계산');
      assert.equal((await fetch(`${base}?hours=abc`)).status, 400);
    } finally { db.latestAll = orig; }
  } finally { srv.close(); }
});
