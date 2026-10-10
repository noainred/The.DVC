/**
 * test/audit2733i_authStopGate.test.js — 주문형 vCenter 성능 조회 5경로가 인증 정지(vcAuthGuard)를 따르는가(v2.733 점검 3회차 C3-01).
 *
 * 결함(재현): v2.591 은 `/vms/:id/metrics` 에만 '멈춘 vCenter 에는 로그인하지 않고 409, 거부는 같은 기록에' 를 넣었다. 형제 5경로 —
 *   `POST /tools/waste/spark`(VM 1대마다 로그인) · `POST /vms/usage` · `GET /vcenters/:id/usage-history?scope=host|cluster` ·
 *   `GET /tools/rightsize`(502 = 웹 재시도 3배) · `POST /tools/vm-finder withAvg`(VM마다 day·week) — 는 정지를 보지 않아
 *   비밀번호가 바뀐 뒤 화면을 여는 것만으로 실패 로그인이 합계 112회 나갔고 정지 기록의 시도 수는 1 그대로였다.
 *
 * ⚠ 문자열이 아니라 **가짜 vCenter 의 실제 로그인 시도 수**와 상태코드로 판정한다(authStop2591 와 같은 하니스 — 실제 api 라우터).
 *   방향 셋: ① 정지된 vCenter 는 다섯 경로 모두 로그인 0 + 사유 ② 정지 전 첫 거부는 1회만 나가고 같은 기록에 올라간다
 *   ③ 자격증명 거부가 아닌 실패(로그인 성공 뒤 성능 조회 실패)는 멈추지 않는다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733i-as-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';          // requirePerm 이 req.user 의 역할을 보게(기본값이지만 명시)
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
// viewer 에서 inv.hosts 를 뺀 매트릭스 — usage-history 호스트·클러스터 범위 게이트 확인용(기본 매트릭스는 viewer 가 inv.hosts 를 가진다).
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

/** 가짜 vCenter — goodPw 만 로그인 통과. 로그인 뒤 호출은 전부 NotSupported(자격증명 거부가 아닌 실패). */
async function fakeVcenter({ goodPw = 'good' } = {}) {
  const st = { logins: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) {
        st.logins += 1;
        if (body.includes(`<password>${goodPw}</password>`)) return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>'));
        return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
      }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      return send(500, FAULT('NotSupported', 'not supported in this fake'));
    }
    if (req.url === '/api/session') { res.writeHead(401); return res.end('{}'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

const N = 10;
const vmRows = (vcId) => Array.from({ length: N }, (_, i) => ({
  id: `${vcId}:vm-${i + 1}`, vcenterId: vcId, name: `${vcId}-g${i + 1}`, powerState: 'POWERED_ON',
  cpuUsagePct: 10, memUsagePct: 20, host: `${vcId}-h1`, numCpu: 2, cpuCount: 2, memMB: 4096, memoryMB: 4096,
}));
const hostRows = (vcId) => [1, 2].map((i) => ({ id: `${vcId}:host-${i}`, vcenterId: vcId, name: `${vcId}-h${i}`, cluster: 'C1', connectionState: 'CONNECTED', cpuCores: 8, cpuTotalMhz: 20000 }));

let base; let VC; let guard; let cfgOf;
before(async () => {
  VC = { s: await fakeVcenter(), b: await fakeVcenter(), g: await fakeVcenter() };
  const reg = [
    { id: 'vc-s', name: 'VC-S', host: VC.s.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 },
    { id: 'vc-b', name: 'VC-B', host: VC.b.host, username: 'administrator@vsphere.local', password: 'bad', enabled: true, timeoutMs: 5000 },
    { id: 'vc-g', name: 'VC-G', host: VC.g.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
  ];
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: reg }));
  const { store } = await import('../src/store.js');
  const ids = ['vc-s', 'vc-b', 'vc-g'];
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: ids.map((id) => ({ id, name: id.toUpperCase(), status: 'unreachable' })),
    vms: ids.flatMap(vmRows), hosts: ids.flatMap(hostRows), datastores: [], networks: [], alarms: [],
  };
  ({ vcAuthGuard: guard } = await import('../src/vcenter/restClient.js'));
  const { loadVcenterConfig } = await import('../src/config.js');
  cfgOf = (id) => loadVcenterConfig().vcenters.find((v) => v.id === id);
  guard.markAuthStopped('vc-s', cfgOf('vc-s'), '주 폴러 거부(테스트)');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: req.get('x-u') || 'adm', role: req.get('x-r') || 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const call = async (vcKey, m, p, body, h = {}) => {
  const before0 = VC[vcKey].st.logins;
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, logins: VC[vcKey].st.logins - before0, j };
};
const vmIds = (vcId) => vmRows(vcId).map((v) => v.id);
const attempts = (id) => guard.peekAuthStop(cfgOf(id))?.attempts ?? null;

test('C3-01 ① 정지된 vCenter: 주문형 성능 조회 5경로가 로그인 0회 · 사유를 싣는다 · 정지 기록 시도 수 불변', async () => {
  assert.equal(attempts('vc-s'), 1);
  let r = await call('s', 'POST', '/api/tools/waste/spark', { vmIds: vmIds('vc-s'), type: 'cpu' });
  assert.equal(r.status, 200);
  assert.equal(r.logins, 0, `스파크라인이 멈춘 vCenter 에 VM 마다 로그인했다: ${r.logins}회`);
  assert.ok(r.j.authStopped?.['vc-s'], `응답이 정지 사유를 싣는다: ${JSON.stringify(r.j).slice(0, 300)}`);
  assert.equal(r.j.authStopped['vc-s'].attempts, 1);
  assert.ok(vmIds('vc-s').every((id) => r.j.series[id] === null), '결과는 0 이 아니라 null(비움)');
  r = await call('s', 'POST', '/api/tools/waste/spark', { vmIds: vmIds('vc-s'), type: 'cpu' });
  assert.equal(r.logins, 0, '다시 열어도 로그인하지 않는다(실패를 캐시하지 않던 결함)');

  r = await call('s', 'POST', '/api/vms/usage', { vmIds: vmIds('vc-s'), days: 30 });
  assert.equal(r.status, 200);
  assert.equal(r.logins, 0);
  assert.ok(r.j.authStopped?.['vc-s']);
  assert.ok(vmIds('vc-s').every((id) => r.j.usage[id] === null));

  r = await call('s', 'GET', `/api/vcenters/vc-s/usage-history?range=24h&scope=${encodeURIComponent('cluster:C1')}`);
  assert.equal(r.status, 200);
  assert.equal(r.logins, 0);
  assert.equal(r.j.authStopped?.attempts, 1, `클러스터 추이가 사유를 싣는다: ${JSON.stringify(r.j).slice(0, 300)}`);
  assert.match(String(r.j.reason), /인증 실패로 멈춰/);
  assert.deepEqual(r.j.points, []);
  r = await call('s', 'GET', `/api/vcenters/vc-s/usage-history?range=24h&scope=${encodeURIComponent('host:vc-s:host-1')}`);
  assert.equal(r.logins, 0);

  r = await call('s', 'GET', `/api/tools/rightsize?vmId=${encodeURIComponent('vc-s:vm-2')}&days=7`);
  assert.equal(r.status, 409, `축소 근거는 409(502 는 웹 재시도 대상 — 로그인 3배): ${r.status}`);
  assert.equal(r.j.authStopped, true);
  assert.equal(r.logins, 0);

  r = await call('s', 'POST', '/api/tools/vm-finder', { withAvg: true, vcenterIds: ['vc-s'] });
  assert.equal(r.status, 200);
  assert.equal(r.logins, 0, `유휴 VM 평균이 VM 마다 day·week 로그인했다: ${r.logins}회`);
  assert.ok(r.j.authStopped?.['vc-s']);
  assert.ok(r.j.items.every((it) => it.avgDayCpu === null && it.avgWeekCpu === null && it.idle === null), '평균을 지어내지 않는다');

  assert.equal(attempts('vc-s'), 1, '정지 기록의 시도 수는 그대로(로그인하지 않았다)');
});

test('C3-01 ② 정지 전 첫 거부: 한 요청에서 vCenter 당 실패 로그인 1회 · 같은 기록에 올린다 · 다음 요청 0회', async () => {
  const reset = () => guard.clearAuthStop('vc-b');
  reset();
  let r = await call('b', 'POST', '/api/tools/waste/spark', { vmIds: vmIds('vc-b'), type: 'cpu' });
  assert.equal(r.status, 200);
  assert.equal(r.logins, 1, `첫 시도 결과를 본 뒤 나머지를 시작해야 한다(동시 6이면 6회): ${r.logins}회`);
  assert.ok(r.j.authStopped?.['vc-b'], '첫 거부도 사유를 싣는다');
  assert.equal(attempts('vc-b'), 1, '주 폴러와 같은 기록에 올린다');
  r = await call('b', 'POST', '/api/tools/waste/spark', { vmIds: vmIds('vc-b'), type: 'cpu' });
  assert.equal(r.logins, 0);

  reset();
  r = await call('b', 'POST', '/api/tools/vm-finder', { withAvg: true, vcenterIds: ['vc-b'] });
  assert.equal(r.logins, 1, `vm-finder withAvg 는 vCenter 단위로 첫 거부에서 끊는다: ${r.logins}회`);
  assert.ok(r.j.authStopped?.['vc-b']);
  assert.equal(attempts('vc-b'), 1);

  reset();
  r = await call('b', 'POST', '/api/vms/usage', { vmIds: vmIds('vc-b'), days: 7 });
  assert.equal(r.logins, 1);
  assert.ok(r.j.authStopped?.['vc-b']);
  assert.equal(attempts('vc-b'), 1);

  reset();
  r = await call('b', 'GET', `/api/vcenters/vc-b/usage-history?range=24h&scope=${encodeURIComponent('cluster:C1')}`);
  assert.equal(r.logins, 1);
  assert.ok(r.j.authStopped?.attempts >= 1);
  assert.equal(attempts('vc-b'), 1);

  reset();
  r = await call('b', 'GET', `/api/tools/rightsize?vmId=${encodeURIComponent('vc-b:vm-3')}&days=7`);
  assert.equal(r.status, 409, `첫 거부도 409 — 502 면 화면이 3회 재시도한다: ${r.status}`);
  assert.equal(r.logins, 1);
  assert.equal(attempts('vc-b'), 1);
});

test('C3-01 ③ 자격증명 거부가 아닌 실패는 멈추지 않는다 · 섞인 요청은 정지 vCenter 만 비운다', async () => {
  let r = await call('g', 'POST', '/api/tools/waste/spark', { vmIds: vmIds('vc-g'), type: 'mem' });
  assert.equal(r.status, 200);
  assert.equal(r.logins, N, `로그인은 통하고 성능 조회만 실패 — VM 마다 시도는 예전대로: ${r.logins}`);
  assert.deepEqual(r.j.authStopped || {}, {}, '정지로 기록하지 않는다');
  assert.equal(attempts('vc-g'), null);

  r = await call('g', 'GET', `/api/tools/rightsize?vmId=${encodeURIComponent('vc-g:vm-1')}&days=7`);
  assert.equal(r.status, 502, '그 밖의 실패는 예전처럼 502');
  assert.equal(attempts('vc-g'), null);

  // vc-s(정지) + vc-g(정상 로그인) 한 요청 — 부분 결과 200, 정지 vCenter 만 표시.
  const before0 = VC.s.st.logins;
  r = await call('g', 'POST', '/api/tools/waste/spark', { vmIds: [...vmIds('vc-s').slice(0, 3), 'vc-g:vm-5'], type: 'cpu' });
  assert.equal(r.status, 200);
  assert.equal(VC.s.st.logins - before0, 0);
  assert.ok(r.j.authStopped?.['vc-s']);
  assert.equal(r.j.authStopped?.['vc-g'], undefined);
});

test('C3-01 ④ usage-history 호스트·클러스터 범위는 inv.hosts 권한(형제 /hosts/:id/metrics 와 같은 게이트) — 권한 없으면 로그인 0', async () => {
  guard.clearAuthStop('vc-b');
  let r = await call('b', 'GET', `/api/vcenters/vc-b/usage-history?range=24h&scope=${encodeURIComponent('host:vc-b:host-1')}`, null, { 'x-r': 'viewer', 'x-u': 'vw' });
  assert.equal(r.status, 403, `inv.hosts 없는 계정이 호스트 성능 조회(로그인)를 일으켰다: ${r.status}`);
  assert.deepEqual(r.j.requiredPerm, ['inv.hosts']);
  assert.equal(r.logins, 0);
  // vCenter 전체 추이(저장 시계열 — 로그인 없음)는 /vcenters·/overview 와 같은 대시보드 수준이라 그대로 열린다.
  r = await call('b', 'GET', '/api/vcenters/vc-b/usage-history?range=24h', null, { 'x-r': 'viewer', 'x-u': 'vw' });
  assert.equal(r.status, 200);
  assert.equal(r.logins, 0);
});
