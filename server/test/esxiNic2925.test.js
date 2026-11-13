/**
 * test/esxiNic2925.test.js — v2.925(B-③): 호스트 vmnic 드롭·에러(GET /hosts/:id/nic-stats)와 같은 창의 CVP 업링크 합(net-uplinks hour).
 *
 *  ① 실제 api 라우터 + 가짜 vCenter: 로그인 1회 · QueryPerf 1회(instance '*') · 집계 계열('')·이상한 인스턴스 이름은 버림 · vmnic 숫자 정렬 ·
 *     결측(-1)은 0 으로 세지 않고 partial · 카탈로그에 없는 카운터는 missingCounters 와 null · no-store
 *  ② 게이트(형제 /hosts/:id/metrics 와 같다): inv.hosts 없으면 403 · 범위 밖 404 · 인증 정지 vCenter 는 로그인 0 — 셋 다 로그인 0
 *  ③ 같은 호스트 동시 요청은 진행 중인 조회 하나를 함께 쓴다(로그인 1회)
 *  ④ 순수: parsePerfInstancesXml 인스턴스 상한 · summarizeNicPerf 값 없는 계열은 null(0 이 아니다)
 *  ⑤ portWindowSums recentMs — 같은 행에서 최근 창을 recent 로(없으면 기존 모양 그대로)
 *  ⑥ 목 모드 synthNicStats — 인벤토리 NIC 이 없으면 가상 스위치 업링크 이름으로
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'esxinic2925-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({ schemaVersion: 3, matrix: { viewer: ['dashboard', 'inv.vms'] } }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<perfManager type="PerformanceManager">PerfMgr</perfManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const counterInfo = (key, group, name, rollup) => `<PerfCounterInfo><key>${key}</key><nameInfo><label>x</label><summary>x</summary><key>${name}</key></nameInfo>`
  + `<groupInfo><label>x</label><summary>x</summary><key>${group}</key></groupInfo><unitInfo><label>n</label><summary>x</summary><key>number</key></unitInfo>`
  + `<rollupType>${rollup}</rollupType><statsType>delta</statsType><level>2</level></PerfCounterInfo>`;
// packetsTx 는 카탈로그에 없다(missingCounters 확인용).
const CIDS = { droppedRx: 501, droppedTx: 502, errorsRx: 503, errorsTx: 504, packetsRx: 505 };
const CATALOG = ENV('<RetrievePropertiesResponse xmlns="urn:vim25"><returnval><obj type="PerformanceManager">PerfMgr</obj><propSet><name>perfCounter</name>'
  + `<val xsi:type="ArrayOfPerfCounterInfo">${Object.entries(CIDS).map(([k, id]) => counterInfo(id, 'net', k, 'summation')).join('')}${counterInfo(6, 'cpu', 'usage', 'average')}</val></propSet></returnval></RetrievePropertiesResponse>`);
const TS = ['2026-11-07T01:00:00Z', '2026-11-07T01:00:20Z', '2026-11-07T01:00:40Z'];
// 인스턴스별 값 — '' 는 집계(버려야 한다), 'bad name' 은 이상한 이름(버려야 한다). vmnic1 droppedRx 의 둘째 표본은 -1(결측).
const valOf = (inst, cid, i) => {
  if (inst === 'vmnic1' && cid === CIDS.droppedRx && i === 1) return -1;
  if (inst === '') return 9999;
  if (cid === CIDS.droppedRx) return inst === 'vmnic1' ? 5 : 0;
  if (cid === CIDS.packetsRx) return 100;
  return 0;
};
const INSTANCES = ['', 'vmnic10', 'vmnic1', 'bad name', 'vmnic0'];
const entityXml = (cids) => '<returnval xsi:type="PerfEntityMetric"><entity type="HostSystem">host-1</entity>'
  + TS.map((t) => `<sampleInfo><timestamp>${t}</timestamp><interval>20</interval></sampleInfo>`).join('')
  + cids.flatMap((cid) => INSTANCES.map((inst) => `<value xsi:type="PerfMetricIntSeries"><id><counterId>${cid}</counterId><instance>${inst}</instance></id>`
    + TS.map((_, i) => `<value>${valOf(inst, Number(cid), i)}</value>`).join('') + '</value>')).join('')
  + '</returnval>';

async function fakeVcenter({ delayMs = 0 } = {}) {
  const st = { logins: 0, queryPerf: 0, bodies: [] };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url !== '/sdk') { res.writeHead(404); return res.end(); }
    if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
    if (body.includes('<Login ')) { st.logins += 1; return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
    if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
    if (body.includes('<RetrieveProperties') && body.includes('PerformanceManager')) return send(200, CATALOG);
    if (body.includes('<QueryPerf ')) {
      st.queryPerf += 1; st.bodies.push(body);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const cids = [...body.matchAll(/<counterId>(\d+)<\/counterId>/g)].map((x) => x[1]);
      return send(200, ENV(`<QueryPerfResponse xmlns="urn:vim25">${entityXml(cids)}</QueryPerfResponse>`));
    }
    return send(500, FAULT('NotSupported', 'not supported in this fake'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

let base; let VC; let guard; let cfgOf;
before(async () => {
  VC = { n: await fakeVcenter(), c: await fakeVcenter({ delayMs: 150 }), s: await fakeVcenter() };
  const reg = [
    { id: 'vc-n', name: 'VC-N', host: VC.n.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 },
    { id: 'vc-c', name: 'VC-C', host: VC.c.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 },
    { id: 'vc-s', name: 'VC-S', host: VC.s.host, username: 'u', password: 'p', enabled: true, timeoutMs: 5000 },
  ];
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: reg }));
  const { store } = await import('../src/store.js');
  const ids = ['vc-n', 'vc-c', 'vc-s'];
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: ids.map((id) => ({ id, name: id.toUpperCase(), status: 'ok' })),
    vms: [], hosts: ids.map((id) => ({ id: `${id}:host-1`, vcenterId: id, name: `${id}-esx1`, connectionState: 'CONNECTED' })),
    datastores: [], networks: [], alarms: [],
  };
  ({ vcAuthGuard: guard } = await import('../src/vcenter/restClient.js'));
  const { loadVcenterConfig } = await import('../src/config.js');
  cfgOf = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);
  guard.markAuthStopped('vc-s', cfgOf('vc-s'), '주 폴러 거부(테스트)');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    const sc = req.get('x-scope');
    req.user = { username: req.get('x-u') || 'adm', role: req.get('x-r') || 'admin', scope: sc ? { vcenters: sc.split(',') } : null };
    next();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = async (vcKey, p, h = {}) => {
  const before0 = VC[vcKey].st.logins;
  const r = await fetch(base + p, { headers: h });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, logins: VC[vcKey].st.logins - before0, j, cache: r.headers.get('cache-control') };
};

test('① 실제 라우트 — 로그인 1회 · QueryPerf 1회(instance *) · 집계·이상한 이름 버림 · 숫자 정렬 · 결측은 partial · 없는 카운터는 null', async () => {
  const r = await call('n', `/api/hosts/${encodeURIComponent('vc-n:host-1')}/nic-stats`);
  assert.equal(r.status, 200, JSON.stringify(r.j).slice(0, 300));
  assert.equal(r.logins, 1);
  assert.equal(VC.n.st.queryPerf, 1);
  assert.match(VC.n.st.bodies[0], /<instance>\*<\/instance>/, '인스턴스별로 묻는다');
  assert.match(VC.n.st.bodies[0], /<entity type="HostSystem">host-1<\/entity>/, '콜론 포함 id 에서도 moref 만');
  assert.match(VC.n.st.bodies[0], /<intervalId>20<\/intervalId>/, '실시간');
  assert.equal(r.cache, 'no-store');
  assert.deepEqual(r.j.nics.map((x) => x.nic), ['vmnic0', 'vmnic1', 'vmnic10'], '집계 · 공백 든 이름은 버리고 숫자 순');
  const n1 = r.j.nics.find((x) => x.nic === 'vmnic1');
  assert.equal(n1.droppedRx, 10, '결측(-1) 표본은 더하지 않는다(5 + 5)');
  assert.equal(n1.valid.droppedRx, 2);
  assert.equal(n1.partial, true);
  assert.equal(n1.packetsTx, null, '카탈로그에 없는 카운터는 0 이 아니라 null');
  assert.deepEqual(r.j.missingCounters, ['packetsTx']);
  const n0 = r.j.nics.find((x) => x.nic === 'vmnic0');
  assert.equal(n0.droppedRx, 0); assert.equal(n0.partial, false); assert.equal(n0.packetsRx, 300);
  assert.equal(r.j.samples, 3); assert.equal(r.j.windowStart, TS[0]); assert.equal(r.j.windowEnd, TS[2]);
  assert.equal(r.j.host.name, 'vc-n-esx1');
});

test('② 게이트 — inv.hosts 없음 403 · 범위 밖 404 · 인증 정지는 로그인 0', async () => {
  let r = await call('n', `/api/hosts/${encodeURIComponent('vc-n:host-1')}/nic-stats`, { 'x-r': 'viewer', 'x-u': 'vw' });
  assert.equal(r.status, 403); assert.equal(r.logins, 0);
  r = await call('n', `/api/hosts/${encodeURIComponent('vc-n:host-1')}/nic-stats`, { 'x-scope': 'vc-c' });
  assert.equal(r.status, 404, '범위 밖은 존재도 흘리지 않는다'); assert.equal(r.logins, 0);
  r = await call('n', '/api/hosts/nope/nic-stats');
  assert.equal(r.status, 404); assert.equal(r.logins, 0);
  r = await call('s', `/api/hosts/${encodeURIComponent('vc-s:host-1')}/nic-stats`);
  assert.notEqual(r.status, 200);
  assert.equal(r.logins, 0, '인증 정지된 vCenter 에 로그인하지 않는다');
});

test('③ 같은 호스트 동시 요청은 조회 하나를 함께 쓴다 — 로그인 1회', async () => {
  const p = `/api/hosts/${encodeURIComponent('vc-c:host-1')}/nic-stats`;
  const before0 = VC.c.st.logins;
  const rs = await Promise.all([fetch(base + p), fetch(base + p), fetch(base + p)]);
  assert.deepEqual(rs.map((x) => x.status), [200, 200, 200]);
  assert.equal(VC.c.st.logins - before0, 1);
  const again = await call('c', p);
  assert.equal(again.logins, 1, '끝난 조회는 다시 쓰지 않는다(캐시가 아니다)');
});

test('④ 순수 — 인스턴스 상한 · 값 없는 계열은 null', async () => {
  const { parsePerfInstancesXml, summarizeNicPerf } = await import('../src/vcenter/nicPerf.js');
  const xml = ENV(`<QueryPerfResponse xmlns="urn:vim25">${entityXml([String(CIDS.droppedRx)])}</QueryPerfResponse>`);
  const p = parsePerfInstancesXml(xml, [String(CIDS.droppedRx)], { maxInstances: 2 });
  assert.equal(p.truncated, true);
  assert.equal(p.series.get(String(CIDS.droppedRx)).size, 2);
  const allMissing = { times: ['a', 'b'], series: new Map([['9', new Map([['vmnic0', [-1, -1]]])]]) };
  const s = summarizeNicPerf(allMissing, { droppedRx: '9' });
  assert.equal(s.nics[0].droppedRx, null, '표본이 전부 결측이면 0 이 아니라 null');
  assert.equal(s.nics[0].partial, true);
  assert.deepEqual(summarizeNicPerf(parsePerfInstancesXml('', []), {}).nics, []);
});

test('⑤ portWindowSums recentMs — 최근 창을 recent 로 함께(주지 않으면 기존 모양)', async () => {
  const cdb = await import('../src/cvp/db.js');
  if (!(await cdb.available())) return;
  const H = 3_600_000;
  const NOW = Math.floor(Date.now() / H) * H;   // 정시로 떨어뜨린 실제 시각(docs/rules/common.md)
  const port = (inDrop, outDrop) => ({ name: 'Ethernet7', desc: 'x', oper: 'up', admin: 'up', speedBps: 1e9, inBps: 1, outBps: 2, inUtil: 1, outUtil: 1, inErr: 0, outErr: 0, inDrop, outDrop });
  for (const [t, a, b] of [[NOW - 5 * H, 4, 4], [NOW - 30 * 60_000, 1, 2], [NOW - 10 * 60_000, null, null]]) {
    await cdb.saveDevices({ cvpId: 'cvp-R', devices: [{ key: 'SN7', ts: t, hostname: 'leaf7', ports: [port(a, b)] }], samples: true });
  }
  const k = '\u0000cvp-R\u0000SN7\u0000Ethernet7';
  const q = [{ agent: '', cvpId: 'cvp-R', key: 'SN7', port: 'Ethernet7' }];
  const s = (await cdb.portWindowSums(q, { now: NOW, recentMs: H })).get(k);
  assert.equal(s.inDrop, 5); assert.equal(s.samples, 3);
  assert.deepEqual(s.recent, { inErr: 0, outErr: 0, inDrop: 1, outDrop: 2, samples: 2, dropN: 1, errN: 2 }, '최근 1시간 — 드롭 없는 표본은 dropN 에 세지 않는다');
  assert.equal('recent' in (await cdb.portWindowSums(q, { now: NOW })).get(k), false);
});

test('⑥ 목 모드 synthNicStats — 인벤토리 NIC 이 없으면 가상 스위치 업링크 이름 · 결정적', async () => {
  const { synthNicStats } = await import('../src/routes/api/vmMetrics.js');
  const h = { id: 'vc-x:host-7', nics: [], hcfg: { net: { switches: [{ uplinks: ['vmnic3', 'vmnic2'] }, { uplinks: ['vmnic10', 'lag1'] }] } } };
  const a = synthNicStats(h, Date.UTC(2026, 10, 7, 1));
  assert.deepEqual(a.nics.map((n) => n.nic), ['vmnic2', 'vmnic3', 'vmnic10']);
  assert.deepEqual(synthNicStats(h, Date.UTC(2026, 10, 7, 1)), a);
  assert.equal(a.samples, 180);
  assert.deepEqual(synthNicStats({ id: 'h' }).nics, []);
});
