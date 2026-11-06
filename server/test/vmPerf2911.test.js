/**
 * test/vmPerf2911.test.js — v2.911 성능 화면(시안 docs/design/vm-perf ②) 서버 회귀.
 *   ① `types=cpu,mem,disk,net` 은 **로그인 1회 · QueryPerf 1회**(가짜 vCenter 의 실제 로그인 수로 판정 — audit2744f 와 같은 하니스). 단건 `type=` 은 그대로.
 *   ② 범위 밖 404 · 직접 수집 대상 아님 409 skipReason(로그인 0) 은 복수 지표에서도 같다(v2.591 F6 · v2.744 FA 규칙 유지).
 *   ③ 순수: types 파싱(화이트리스트 · 중복 · 상한) · 롤업 선택(창의 나이 · 요청보다 가늘게 가지 않는다 · 실시간은 창 없음) · historicalInterval 파싱(켜진 주기만 · 빈 답 null) ·
 *      목 응답 모양(라이브와 같은 키 · overloadPct 는 vmSignals 와 같은 값).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vmperf2911-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

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

/** 가짜 vCenter — 로그인은 통과(센다) · 그 뒤 호출(RetrieveProperties · QueryPerf)은 NotSupported. QueryPerf 요청 수도 센다. */
async function fakeVcenter() {
  const st = { logins: 0, queryPerf: 0, retrieve: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) { st.logins += 1; return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      if (body.includes('<QueryPerf ')) st.queryPerf += 1;
      if (body.includes('<RetrieveProperties ')) st.retrieve += 1;
      return send(500, FAULT('NotSupported', 'not supported in this fake'));
    }
    if (req.url === '/api/session') { st.logins += 1; res.writeHead(201, { 'content-type': 'application/json' }); return res.end('"tok"'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

const vmRow = (vcId) => ({ id: `${vcId}:vm-1`, vcenterId: vcId, name: `${vcId}-g1`, powerState: 'POWERED_ON', cpuUsagePct: 10, memUsagePct: 20, host: `${vcId}-h1`, cpuCount: 2, memMB: 4096, cluster: 'C1' });
const hostRow = (vcId) => ({ id: `${vcId}:host-1`, vcenterId: vcId, name: `${vcId}-h1`, cluster: 'C1', connectionState: 'CONNECTED', cpuCores: 8, cpuTotalMhz: 20000, memTotalMB: 65536 });

let base; let VC;
before(async () => {
  VC = { a: await fakeVcenter(), s: await fakeVcenter() };
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-a', name: 'VC-A', host: VC.a.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
    { id: 'vc-s', name: 'VC-S', host: VC.s.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, collectMode: 'site', remoteAgent: 'edge1', timeoutMs: 5000 },
  ] }));
  const { store } = await import('../src/store.js');
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: '2026-11-05T22:00:00.000Z',
    vcenters: [{ id: 'vc-a', name: 'VC-A', status: 'connected' }, { id: 'vc-s', name: 'VC-S', status: 'connected' }],
    vms: [vmRow('vc-a'), vmRow('vc-s')], hosts: [hostRow('vc-a'), hostRow('vc-s')], datastores: [], networks: [], alarms: [],
  };
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    let scope = null; try { scope = req.get('x-scope') ? JSON.parse(req.get('x-scope')) : null; } catch { scope = null; }
    req.user = { username: 'adm', role: 'admin', scope }; next();
  });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = async (p, headers = {}) => {
  const r = await fetch(`${base}${p}`, { headers });
  let j = null; try { j = await r.json(); } catch { j = null; }
  return { status: r.status, j };
};

// ─────────────────────────────── ① 로그인 1회 ───────────────────────────────
test('types=cpu,mem,disk,net — 가짜 vCenter 에 로그인 1회 · QueryPerf 는 카운터 카탈로그 뒤라 0(카탈로그 실패 → 502) · 단건 type= 4번은 로그인 4회', async () => {
  const st = VC.a.st;
  const r = await call(`/api/vms/${encodeURIComponent('vc-a:vm-1')}/metrics?types=cpu,mem,disk,net&interval=day`);
  assert.equal(r.status, 502, `카탈로그를 못 읽는 가짜라 502 여야 한다: ${JSON.stringify(r.j)}`);
  assert.equal(st.logins, 1, `복수 지표는 로그인 1회여야 한다: ${st.logins}`);
  assert.ok(st.retrieve >= 1, '카운터 카탈로그(RetrieveProperties)를 물었다');
  for (const t of ['cpu', 'mem', 'disk', 'net']) await call(`/api/vms/${encodeURIComponent('vc-a:vm-1')}/metrics?type=${t}&interval=day`);
  assert.equal(st.logins, 5, `예전 단건 경로는 지표마다 로그인(4회 더): ${st.logins}`);
  const h = await call(`/api/hosts/${encodeURIComponent('vc-a:host-1')}/metrics?types=cpu,net&interval=realtime`);
  assert.equal(h.status, 502); assert.equal(st.logins, 6, '호스트 복수 지표도 로그인 1회');
});

// ─────────────────────────────── ② 범위 · skip ───────────────────────────────
test('범위 밖은 404(존재 은닉) · 직접 수집 대상 아님(엣지 위임)은 409 skipReason · 로그인 0 — 복수 지표에서도 같다', async () => {
  const sc = await call(`/api/vms/${encodeURIComponent('vc-a:vm-1')}/metrics?types=cpu,mem&interval=day`, { 'x-scope': JSON.stringify({ vcenters: ['vc-s'] }) });
  assert.equal(sc.status, 404);
  const before = VC.s.st.logins;
  const r = await call(`/api/vms/${encodeURIComponent('vc-s:vm-1')}/metrics?types=cpu,mem,disk,net&interval=day`);
  assert.equal(r.status, 409); assert.equal(r.j.skipReason, 'site');
  const m = await call(`/api/vms/${encodeURIComponent('vc-s:vm-1')}/metrics?types=cpu,mem,disk,net&interval=day&manual=1`);
  assert.equal(m.status, 409, '사람이 누른 다시 조회도 막는다');
  const hs = await call(`/api/hosts/${encodeURIComponent('vc-s:host-1')}/metrics?types=cpu&interval=day`);
  assert.equal(hs.status, 409); assert.equal(hs.j.skipReason, 'site');
  assert.equal(VC.s.st.logins, before, '엣지 위임 vCenter 에는 로그인하지 않는다');
});

// ─────────────────────────────── ③ 순수 ───────────────────────────────
test('parseMetricTypes — 화이트리스트 · 중복 제거 · 배열 · 모르는 값은 버림 · 없으면 []', async () => {
  const { parseMetricTypes } = await import('../src/routes/api/vmMetrics.js');
  assert.deepEqual(parseMetricTypes('cpu,mem,disk,net'), ['cpu', 'mem', 'disk', 'net']);
  assert.deepEqual(parseMetricTypes(' MEM , cpu ,cpu, bogus '), ['mem', 'cpu']);
  assert.deepEqual(parseMetricTypes(['cpu', 'net']), ['cpu', 'net']);
  assert.deepEqual(parseMetricTypes(''), []);
  assert.deepEqual(parseMetricTypes(undefined), []);
  assert.deepEqual(parseMetricTypes('bogus'), []);
  assert.deepEqual(parseMetricTypes(`${'x,'.repeat(5000)}cpu`), [], '긴 문자열은 앞 200자만 본다(O(n) 분할)');
});

test('pickPerfInterval — 창의 나이로 롤업 · 요청보다 가늘게 가지 않는다 · 실시간 · 창 없음은 요청 그대로 · 보관 밖은 1년', async () => {
  const { pickPerfInterval, PERF_RETENTION_DEFAULT } = await import('../src/vcenter/soapClient.js');
  const now = Date.UTC(2026, 10, 5, 22, 0, 0);
  const ago = (sec) => new Date(now - sec * 1000).toISOString();
  const pick = (interval, startSec) => pickPerfInterval({ interval, start: startSec == null ? null : ago(startSec), end: ago(0), now, retention: PERF_RETENTION_DEFAULT });
  assert.deepEqual(pick('day', null), { name: 'day', id: 300 });
  assert.deepEqual(pick('day', 3600 * 12), { name: 'day', id: 300 });
  assert.deepEqual(pick('day', 86400 * 2), { name: 'week', id: 1800 });
  assert.deepEqual(pick('day', 86400 * 10), { name: 'month', id: 7200 });
  assert.deepEqual(pick('day', 86400 * 60), { name: 'year', id: 86400 });
  assert.deepEqual(pick('day', 86400 * 900), { name: 'year', id: 86400 }, '보관 밖도 던지지 않고 1년 롤업(vCenter 가 빈 답을 준다)');
  assert.deepEqual(pick('month', 3600), { name: 'month', id: 7200 }, '요청보다 가늘게 가지 않는다');
  assert.deepEqual(pick('realtime', 86400 * 10), { name: 'realtime', id: 20 });
  assert.deepEqual(pick('nope', null), { name: 'realtime', id: 20 });
  assert.deepEqual(pickPerfInterval({ interval: 'day', start: ago(86400 * 2), end: ago(0), now, retention: { day: 86400 * 5 } }), { name: 'day', id: 300 }, 'vCenter 가 더 길게 보관하면 그대로 가는 롤업');
  assert.deepEqual(pickPerfInterval({ interval: 'day', start: ago(86400 * 2), end: ago(0), now, retention: {} }), { name: 'year', id: 86400 });
});

test('parseHistoricalIntervals — 켜진 주기만 · 모르는 samplingPeriod 는 버림 · 빈 답 null', async () => {
  const { parseHistoricalIntervals } = await import('../src/vcenter/soapClient.js');
  const xml = '<PerfInterval><key>1</key><samplingPeriod>300</samplingPeriod><name>Past day</name><length>172800</length><level>1</level><enabled>true</enabled></PerfInterval>'
    + '<PerfInterval><key>2</key><samplingPeriod>1800</samplingPeriod><name>Past week</name><length>604800</length><level>1</level><enabled>false</enabled></PerfInterval>'
    + '<PerfInterval><key>3</key><samplingPeriod>7200</samplingPeriod><name>Past month</name><length>2592000</length><level>1</level><enabled>true</enabled></PerfInterval>'
    + '<PerfInterval><key>9</key><samplingPeriod>600</samplingPeriod><name>odd</name><length>99</length><enabled>true</enabled></PerfInterval>';
  assert.deepEqual(parseHistoricalIntervals(xml), { day: 172800, month: 2592000 });
  assert.equal(parseHistoricalIntervals(''), null);
  assert.equal(parseHistoricalIntervals('<PerfInterval><samplingPeriod>300</samplingPeriod><length>0</length><enabled>true</enabled></PerfInterval>'), null);
});

test('synthMetrics(목) — 라이브와 같은 키 · 계열별 unit · 과거 창은 거친 롤업 · overloadPct 는 신호 모듈 값', async () => {
  const { synthMetrics } = await import('../src/routes/api/vmMetrics.js');
  const { OVERLOAD_PCT } = await import('../src/inventory/vmSignals.js');
  const now = Date.UTC(2026, 10, 5, 22, 0, 0);
  const vm = { id: 'vc-x:vm-9', cpuUsagePct: 40, memUsagePct: 60 };
  const r = synthMetrics(vm, ['cpu', 'mem', 'disk', 'net'], 'day', {}, now);
  assert.deepEqual(Object.keys(r.series), ['cpu', 'mem', 'disk', 'net']);
  assert.equal(r.interval, 'day'); assert.equal(r.sampleSec, 300); assert.equal(r.past, false); assert.equal(r.mock, true);
  assert.equal(r.series.cpu.unit, '%'); assert.equal(r.series.disk.unit, 'KBps');
  assert.equal(r.series.cpu.points.length, 288);
  assert.ok(r.series.cpu.points.every((p) => p.v >= 0 && p.v <= 100));
  assert.equal(typeof r.retention.day, 'number'); assert.equal(r.retentionSource, 'default'); assert.equal(r.refreshSec, 20);
  const start = new Date(now - 10 * 86400e3).toISOString(); const end = new Date(now - 9 * 86400e3).toISOString();
  const p = synthMetrics(vm, ['cpu'], 'day', { start, end }, now);
  assert.equal(p.interval, 'month'); assert.equal(p.sampleSec, 7200); assert.equal(p.past, true); assert.equal(p.requested, 'day');
  assert.equal(p.series.cpu.points.length, 13, '24시간 창 · 2시간 롤업 = 13점');
  assert.equal(OVERLOAD_PCT, 90);
});
