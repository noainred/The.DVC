/**
 * v2.742 1회차 — 리드 연결 작업(SERVER 묶음) 회귀.
 *
 * S1 고아 VMDK 스캔 라우트: 주문형 로그인 문(dsBrowse.onDemandVcBlock)이 막은 409 를 502 로 바꿔 보냈다 — 웹 fetchJson 은
 *    502 를 재시도해 같은 막힘을 세 번 보고, 사유 필드(skipReason·authStopped)도 사라졌다. 실제 api 라우터로 상태코드를 본다.
 * S2 게스트 계정 추가 라우트: accountService 의 409(비활성·점검중·site·인증 정지 기록)를 400 + 메시지로 뭉갰다.
 * S3 중앙 /inventory 수신: GE1 이 새로 싣는 호스트 clusterRef·vcDatacenter·VM clusterRef 를 아는 모양으로만 받는다
 *    (객체·배열·숫자·과대 문자열은 null — 클러스터 묶음 키(clustercfg/analyze.js refOf)가 문자열만 쓰므로 null 은 이름 키 폴백).
 * S4 GPU 게스트 원인 판정의 엣지 보고 낡음 경계: 엣지 push 가 진단에 자기 push 주기(intervalMs)를 싣고, 중앙 정제가 남기고,
 *    hardwareGpu.gatherGuestWhyCtx 가 reportIntervalMs 로 넘긴다(구버전 엣지 = 필드 없음 = 기본 30분). 실제 엣지 push →
 *    실제 centralRouter → 실제 문맥 함수로 본다.
 * S5 샘플러 적재 제외 요약(samplerWithheldOf)이 lastRun.tempHostsDisconnected 를 싣는다(0 이면 싣지 않는다).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742m-'));
Object.assign(process.env, {
  CONFIG_DIR: DIR, DATA_SOURCE: 'live', SSRF_ALLOW_LOOPBACK: 'true', CENTRAL_TOKEN: 'ctok-2742m',
  IPAM_WRITE_WORKER: '0', AGENT_NAME: 'edge-m',
});
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<guestOperationsManager type="GuestOperationsManager">guestOperationsManager</guestOperationsManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const FAULT = (type, msg) => ENV(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${msg}</faultstring>`
  + `<detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => resolve(b)); });

/** 가짜 vCenter — Login 은 password 'good' 만 통과(계정별로 센다). */
async function fakeVcenter() {
  const st = { logins: new Map() };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
    if (body.includes('<Login ')) {
      const u = /<userName>([^<]*)<\/userName>/.exec(body)?.[1] || '';
      st.logins.set(u, (st.logins.get(u) || 0) + 1);
      if (body.includes('<password>good</password>')) { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
      return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
    }
    if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
    if (body.includes('<RetrievePropertiesEx')) return send(200, ENV('<RetrievePropertiesExResponse xmlns="urn:vim25"></RetrievePropertiesExResponse>'));
    if (body.includes('<RetrieveProperties')) return send(200, ENV('<RetrievePropertiesResponse xmlns="urn:vim25"></RetrievePropertiesResponse>'));
    return send(500, FAULT('NotSupported', 'unexpected'));
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${port}`, logins: (u) => st.logins.get(u) || 0 };
}

const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));
const dsRow = (vcId) => ({ id: `${vcId}:datastore-1`, vcenterId: vcId, name: `${vcId}-ds`, capacityGB: 100, freeGB: 50 });
const vmRow = (vcId) => ({ id: `${vcId}:vm-1`, vcenterId: vcId, name: `${vcId}-vm`, powerState: 'POWERED_ON', guestOS: 'Red Hat Enterprise Linux 9', host: 'h1' });
const ADMIN = { username: 'admin', role: 'admin', scope: null };

/** 라우터 하나를 띄운다(req.user 고정). */
async function serve(prefix, register, user) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const r = express.Router();
  register(r);
  app.use(prefix, r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const base = `http://127.0.0.1:${srv.address().port}${prefix}`;
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}

let VC;
async function setup() {
  if (VC) return VC;
  VC = await fakeVcenter();
  const base = { host: VC.host, timeoutMs: 5000 };
  writeJson('vcenters.json', { vcenters: [
    { id: 'vc-dis', name: 'DIS', username: 'u-dis', password: 'good', enabled: false, ...base },
    { id: 'vc-maint', name: 'MAINT', username: 'u-maint', password: 'good', maintenance: true, ...base },
    { id: 'vc-site', name: 'SITE', username: 'u-site', password: 'good', collectMode: 'site', remoteAgent: 'edge-m', ...base },
    { id: 'vc-stop', name: 'STOP', username: 'u-stop', password: 'bad', ...base },
    { id: 'vc-inv', name: 'INV', username: 'u-inv', password: 'good', collectMode: 'site', remoteAgent: 'edge-m', ...base },
  ] });
  const ids = ['vc-dis', 'vc-maint', 'vc-site', 'vc-stop'];
  const { store } = await import('../src/store.js');
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: ids.map((id) => ({ id, name: id, status: 'connected', ...(id === 'vc-site' ? { collectedBy: 'edge-m' } : {}) })),
    datastores: ids.map(dsRow), vms: ids.map(vmRow), hosts: [],
  };
  // vc-stop 은 주 폴러가 이미 자격증명 거부로 멈춘 상태(같은 정지 기록)
  const { noteVcAuthFailure } = await import('../src/vcenter/authStopGate.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const stopCfg = loadVcenterConfig().vcenters.find((v) => v.id === 'vc-stop');
  const e = new Error('Cannot complete login due to an incorrect user name or password.'); e.authFailed = true;
  assert.ok(noteVcAuthFailure(stopCfg, e), '사전 조건: 정지 기록이 생겨야 한다');
  return VC;
}

// ════════════════════════════ S1 ════════════════════════════
test('S1 고아 VMDK 스캔 라우트: 주문형 로그인 문이 막은 vCenter 는 502 가 아니라 409 + 사유 필드(로그인 0회)', async () => {
  const vc = await setup();
  const { registerToolsCapacity } = await import('../src/routes/api/toolsCapacity.js');
  const get = await serve('/api', registerToolsCapacity, ADMIN);
  const before = vc.logins('u-maint') + vc.logins('u-dis') + vc.logins('u-stop') + vc.logins('u-site');
  const m = await get('/tools/orphan-vmdk?datastoreId=' + encodeURIComponent('vc-maint:datastore-1'));
  assert.equal(m.status, 409, `점검중 vCenter 는 409(재시도 대상 아님) — 받은 ${m.status} ${JSON.stringify(m.body)}`);
  assert.equal(m.body.ok, false);
  assert.equal(m.body.skipReason, 'maintenance');
  assert.ok(m.body.reason, '사유 문장');
  const d = await get('/tools/orphan-vmdk?datastoreId=' + encodeURIComponent('vc-dis:datastore-1'));
  assert.equal(d.status, 409);
  assert.equal(d.body.skipReason, 'disabled');
  const s = await get('/tools/orphan-vmdk?datastoreId=' + encodeURIComponent('vc-site:datastore-1'));
  assert.equal(s.status, 409);
  assert.equal(s.body.skipReason, 'site');
  const st = await get('/tools/orphan-vmdk?datastoreId=' + encodeURIComponent('vc-stop:datastore-1'));
  assert.equal(st.status, 409);
  assert.ok(st.body.authStopped?.attempts >= 1, `인증 정지 표지: ${JSON.stringify(st.body)}`);
  assert.equal(vc.logins('u-maint') + vc.logins('u-dis') + vc.logins('u-stop') + vc.logins('u-site'), before, '라우트도 로그인하지 않는다');
  // 범위·존재 은닉은 그대로(없는 데이터스토어는 404)
  const n = await get('/tools/orphan-vmdk?datastoreId=nope');
  assert.equal(n.status, 404);
});

// ════════════════════════════ S2 ════════════════════════════
test('S2 게스트 계정 추가 라우트: 막힌 vCenter 는 400 이 아니라 409 + skipReason/authStopped · 입력 오류는 400 그대로', async () => {
  const vc = await setup();
  const { registerBackupNetSec } = await import('../src/routes/admin/backupNetSec.js');
  const call = await serve('/api/admin', registerBackupNetSec, ADMIN);
  const args = (vcenterId) => ({ vcenterId, vmIds: [`${vcenterId}:vm-1`], username: 'newu', password: 'Passw0rd!' });
  const d = await call('/guest/add-user', { method: 'POST', body: args('vc-dis') });
  assert.equal(d.status, 409, `비활성 vCenter 는 409 — 받은 ${d.status} ${JSON.stringify(d.body)}`);
  assert.equal(d.body.ok, false);
  assert.equal(d.body.skipReason, 'disabled');
  assert.ok(d.body.reason);
  const s = await call('/guest/add-user', { method: 'POST', body: args('vc-site') });
  assert.equal(s.status, 409);
  assert.equal(s.body.skipReason, 'site');
  assert.equal(vc.logins('u-dis') + vc.logins('u-site'), 0, '비활성·site 는 로그인 0회');
  // 인증 정지 vCenter — 수동 작업이라 1회 시도하고, 거부는 409 + 정지 표지
  const st = await call('/guest/add-user', { method: 'POST', body: args('vc-stop') });
  assert.equal(st.status, 409, JSON.stringify(st.body));
  assert.ok(st.body.authStopped?.attempts >= 1, JSON.stringify(st.body));
  assert.match(st.body.reason, /이미 멈춰 있던/);
  // 입력 오류는 예전처럼 400
  const bad = await call('/guest/add-user', { method: 'POST', body: { vcenterId: 'vc-dis', vmIds: [] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.skipReason, undefined);
});

// ════════════════════════════ S3 ════════════════════════════
test('S3 중앙 /inventory: clusterRef 는 moref 꼴 글자(≤64)만, vcDatacenter 는 글자(≤128)만 — 객체·배열·숫자는 null', async () => {
  await setup();
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { getInventory } = await import('../src/central/inventory.js');
  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/central', centralRouter);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const long = 'x'.repeat(300);
  const body = {
    agent: 'edge-m', vcenterId: 'vc-inv', vcenter: { id: 'vc-inv', name: 'INV', status: 'connected', licensesError: long, solutionsError: { a: 1 } },
    hosts: [
      { id: 'vc-inv:host-1', name: 'h1', cluster: 'C1', clusterRef: 'domain-c7', vcDatacenter: 'DC-Seoul', connectionState: 'CONNECTED' },
      { id: 'vc-inv:host-2', name: 'h2', cluster: 'C1', clusterRef: { ref: 'domain-c7' }, vcDatacenter: { name: 'x' } },
      { id: 'vc-inv:host-3', name: 'h3', cluster: 'C2', clusterRef: 7, vcDatacenter: 12 },
      { id: 'vc-inv:host-4', name: 'h4', cluster: 'C2', clusterRef: ['domain-c8'], vcDatacenter: ['DC'] },
      { id: 'vc-inv:host-5', name: 'h5', cluster: 'C2', clusterRef: 'domain c8 <script>', vcDatacenter: long },
      { id: 'vc-inv:host-6', name: 'h6', cluster: 'C3', clusterRef: 'd'.repeat(65), vcDatacenter: null },
      { id: 'vc-inv:host-7', name: 'h7', cluster: 'standalone' },
    ],
    vms: [
      { id: 'vc-inv:vm-1', name: 'v1', clusterRef: 'domain-c7', host: 'h1' },
      { id: 'vc-inv:vm-2', name: 'v2', clusterRef: { x: 1 }, host: 'h2' },
      { id: 'vc-inv:vm-3', name: 'v3', clusterRef: 42, host: 'h3' },
    ],
  };
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/api/central/inventory`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'X-Central-Token': 'ctok-2742m', 'X-Agent-Name': 'edge-m' }, body: JSON.stringify(body),
  });
  const j = await r.json();
  assert.equal(r.status, 200, JSON.stringify(j));
  const inv = getInventory('vc-inv')?.data;
  assert.ok(inv, '저장돼야 한다');
  const H = Object.fromEntries((inv.hosts || []).map((h) => [h.id.split(':')[1], h]));
  assert.equal(H['host-1'].clusterRef, 'domain-c7');
  assert.equal(H['host-1'].vcDatacenter, 'DC-Seoul');
  for (const k of ['host-2', 'host-3', 'host-4', 'host-5', 'host-6']) assert.equal(H[k].clusterRef, null, `${k} clusterRef 는 null(받은 ${JSON.stringify(H[k].clusterRef)})`);
  for (const k of ['host-2', 'host-3', 'host-4']) assert.equal(H[k].vcDatacenter, null, `${k} vcDatacenter 는 null(받은 ${JSON.stringify(H[k].vcDatacenter)})`);
  assert.equal(typeof H['host-5'].vcDatacenter, 'string');
  assert.ok(H['host-5'].vcDatacenter.length <= 128, `vcDatacenter 길이 상한 128 — 받은 ${H['host-5'].vcDatacenter.length}`);
  assert.equal(H['host-6'].vcDatacenter, null, 'null 은 그대로(모름)');
  assert.ok(!Object.hasOwn(H['host-7'], 'clusterRef') || H['host-7'].clusterRef == null, '키 없는 원소는 만들지 않는다');
  const V = Object.fromEntries((inv.vms || []).map((v) => [v.id.split(':')[1], v]));
  assert.equal(V['vm-1'].clusterRef, 'domain-c7');
  assert.equal(V['vm-2'].clusterRef, null);
  assert.equal(V['vm-3'].clusterRef, null);
  assert.ok(j.dropped && j.dropped.coerced >= 11, `바꾼 개수를 밝힌다: ${JSON.stringify(j.dropped)}`);
  // GC(VC-07)가 이미 좁힌 vcenter 조회 실패 사유 — 글자는 300자, 그 밖은 지운다(확인만)
  assert.ok(typeof inv.vcenter.licensesError === 'string' && inv.vcenter.licensesError.length <= 300);
  assert.ok(!Object.hasOwn(inv.vcenter, 'solutionsError'));
  // 클러스터 묶음 판정은 그대로 동작한다(문자열이 아닌 ref 는 이름 키 폴백)
  const { clusterRefMode } = await import('../src/clustercfg/analyze.js');
  assert.equal(clusterRefMode(inv.hosts).get('vc-inv'), false, '일부 호스트의 ref 를 버렸으면 그 vCenter 는 이름 키로 떨어진다');
});

// ════════════════════════════ S4 ════════════════════════════
test('S4 GPU 게스트 엣지 진단에 push 주기가 실리고(실제 엣지 push → 실제 centralRouter) gatherGuestWhyCtx 가 reportIntervalMs 로 넘긴다', async () => {
  await setup();
  const express = (await import('express')).default;
  const { centralRouter } = await import('../src/routes/central.js');
  const { config } = await import('../src/config.js');
  const gp = await import('../src/agent/gpuGuestPush.js');
  const poller = await import('../src/gpu/poller.js');
  const { getAllGpuGuestDiag, sanitizeGpuGuestDiag, _resetGpuGuestDiagForTest } = await import('../src/central/gpuGuestDiag.js');
  const { gatherGuestWhyCtx } = await import('../src/routes/api/hardwareGpu.js');
  const { edgeReportStaleMs, EDGE_REPORT_STALE_MS } = await import('../src/gpu/guestWhy.js');
  _resetGpuGuestDiagForTest();

  // 엣지 쪽: 게스트 GPU 폴 한 번(미등록 vCenter 라 장비 접속 없이 진단만 생긴다)
  writeJson('gpu-guest.json', { enabled: true, vcenters: { 'vc-gx': { enabled: true } } });
  const w = console.warn; console.warn = () => {};
  try { await poller.pollGpuGuestOnce(); } finally { console.warn = w; }
  assert.ok(poller.getGpuGuestDiag(), '사전 조건: 진단이 있어야 한다');

  const app = express(); app.use(express.json({ limit: '5mb' })); app.use('/api/central', centralRouter);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const saved = { url: config.agent.centralUrl, tok: config.agent.centralToken, name: config.agent.name, iv: config.agent.inventoryIntervalMs };
  const HOUR = 3_600_000;
  try {
    config.agent.centralUrl = `http://127.0.0.1:${srv.address().port}`;
    config.agent.centralToken = 'ctok-2742m';
    config.agent.name = 'edge-m';
    config.agent.inventoryIntervalMs = HOUR;   // 이 엣지는 1시간마다 보고한다
    gp._setGuestPollerStatusForTest(() => ({ lastRun: { at: Date.now(), unreadVcenters: [] } }));
    const l = console.log; console.log = () => {};
    let r;
    try { r = await gp.pushGpuGuestNow(); } finally { console.log = l; }
    assert.equal(r.ok, true, JSON.stringify(r));
    const rep = getAllGpuGuestDiag().find((x) => x.agent === 'edge-m');
    assert.ok(rep, '중앙이 진단을 보관해야 한다');
    assert.equal(rep.intervalMs, HOUR, `중앙 보관분에 엣지 push 주기: ${JSON.stringify({ intervalMs: rep.intervalMs })}`);
    const { store } = await import('../src/store.js');
    const ctx = gatherGuestWhyCtx(store.get())('vc-site');
    assert.equal(ctx.mode, 'site');
    assert.equal(ctx.reportIntervalMs, HOUR, 'reportIntervalMs 로 넘긴다');
    assert.equal(edgeReportStaleMs(ctx.reportIntervalMs), HOUR * 3 + 30_000, '1시간 주기 엣지의 낡음 경계는 3시간 30초');
  } finally {
    gp._setGuestPollerStatusForTest(null);
    Object.assign(config.agent, { centralUrl: saved.url, centralToken: saved.tok, name: saved.name, inventoryIntervalMs: saved.iv });
  }
  // 정제 규칙: 양수 유한수만 · 상한 7일 · 그 밖(글자 아닌 수 아님·0·음수)은 null(기본 30분)
  assert.equal(sanitizeGpuGuestDiag({ intervalMs: 60_000 }).intervalMs, 60_000);
  assert.equal(sanitizeGpuGuestDiag({ intervalMs: '120000' }).intervalMs, 120_000);
  assert.equal(sanitizeGpuGuestDiag({ intervalMs: 30 * 86_400_000 }).intervalMs, 7 * 86_400_000, '7일 상한');
  for (const v of [0, -5, 'abc', { a: 1 }, [], null, Infinity]) assert.equal(sanitizeGpuGuestDiag({ intervalMs: v }).intervalMs, null, `intervalMs ${JSON.stringify(v)} → null`);
  assert.equal(sanitizeGpuGuestDiag({}).intervalMs, null, '구버전 엣지(필드 없음)');
  // 구버전 엣지(필드 없음)는 기본 30분 그대로
  assert.equal(edgeReportStaleMs(null), EDGE_REPORT_STALE_MS);
  _resetGpuGuestDiagForTest();
});

// ════════════════════════════ S5 ════════════════════════════
test('S5 samplerWithheldOf 가 lastRun.tempHostsDisconnected 를 싣는다(0 이면 싣지 않는다)', async () => {
  const { samplerWithheldOf } = await import('../src/metrics/sampler.js');
  const only = samplerWithheldOf({ at: 1, tempHostsDisconnected: 3 });
  assert.ok(only, '끊긴 호스트 온도를 뺐으면 요약이 null 이 아니다');
  assert.equal(only.tempHostsDisconnected, 3);
  assert.equal(samplerWithheldOf({ at: 1, tempHostsDisconnected: 0 }), null, '0 이면 요약을 만들지 않는다');
  const other = samplerWithheldOf({ at: 1, vmStatsSkipped: 2 });
  assert.ok(other && !Object.hasOwn(other, 'tempHostsDisconnected'), '0 이면 키를 싣지 않는다(기존 모양)');
  assert.equal(samplerWithheldOf({ at: 1, tempHostsDisconnected: '4' })?.tempHostsDisconnected, undefined, '수가 아니면 싣지 않는다');
});
