/**
 * test/audit2771e.test.js — 6회차 점검 G5(vCenter 수집 코어) 회귀 (v2.771, F3-1..F3-5).
 *
 *  F3-1 SOAP 의 vim fault(HTTP 500 SystemError·NotAuthenticated·RequestCanceled)는 '능력 부재' 가 아니다 — REST 로 폴백하지 않고 던진다
 *       (store 가 lastGood 이월). MethodNotFound 류 fault·fault 없는 404 는 예전처럼 폴백한다. 가짜 vCenter 로 실제 요청을 센다.
 *  F3-2 /summary allocation — 용량 미상 호스트가 있으면 vcpuPerCore·ramOvercommitPct 는 null + hostsCapacityUnknown.
 *  F3-3 VM GPU 장치 조회 실패 → vcenter.vmGpuUnknown + store.carryVmGpu 가 직전 vm.gpu 를 이월.
 *  F3-4 점검중 분기가 lastGood 이월 중인 vCenter 의 인벤토리를 유지(stale·staleSince·보존 창).
 *  F3-5 위임 병합이 엣지 stale 을 false 로 덮지 않고, 공개 API 수집 시각이 min(receivedAt, staleSince).
 *
 * ⚠ 서버를 127.0.0.1 에 띄운다(가짜 vCenter·/summary). 기준 시각: 순수 판정은 실제 시각을 정시로 떨어뜨린 T0,
 *   store 통합은 store 가 내부에서 Date.now() 로 보존 창을 재므로 '지금' 에서의 상대값(분·시간 단위 — 경계에 걸리지 않게 넉넉히)을 쓴다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2771e-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';
process.env.AUTH_ENABLED = 'false';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});
const listen = (srv) => new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv.address().port)));
const T0 = Math.floor(Date.now() / 3_600_000) * 3_600_000;

// ── 가짜 vCenter(SOAP + REST) ────────────────────────────────────────────────
const env = (x) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>${x}</soapenv:Body></soapenv:Envelope>`;
const fault = (str, type) => env(`<soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>${str}</faultstring><detail><${type}Fault xmlns="urn:vim25" xsi:type="${type}"></${type}Fault></detail></soapenv:Fault>`);
const SC = env('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval><rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager><about><version>8.0.2</version></about></returnval></RetrieveServiceContentResponse>');

/** soap(body) → [status, xml] 또는 null(기본 처리). REST 는 언제나 정상. */
async function fakeVc(soap) {
  const st = { rest: 0, soap: 0 };
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.url === '/sdk') {
        st.soap += 1;
        const own = soap(b);
        if (own) { res.writeHead(own[0], { 'content-type': 'text/xml' }); return res.end(own[1]); }
        if (b.includes('<RetrieveServiceContent')) { res.writeHead(200); return res.end(SC); }
        if (b.includes('<Login ')) { res.writeHead(200, { 'set-cookie': 'vmware_soap_session=abc' }); return res.end(env('<LoginResponse xmlns="urn:vim25"><returnval/></LoginResponse>')); }
        if (b.includes('<Logout')) { res.writeHead(200); return res.end(env('<LogoutResponse xmlns="urn:vim25"/>')); }
        if (b.includes('<CreateContainerView')) { res.writeHead(200); return res.end(env('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view</returnval></CreateContainerViewResponse>')); }
        res.writeHead(500); return res.end(fault('A general system error occurred', 'SystemError'));
      }
      st.rest += 1;
      const J = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/session' && req.method === 'POST') return J('tok');
      if (req.url === '/api/session') { res.writeHead(204); return res.end(); }
      if (req.url === '/api/vcenter/host') return J([{ host: 'host-1', name: 'esx1', connection_state: 'CONNECTED', power_state: 'POWERED_ON' }]);
      if (req.url === '/api/vcenter/vm') return J([{ vm: 'vm-1', name: 'web01', power_state: 'POWERED_ON', cpu_count: 4, memory_size_MiB: 8192 }]);
      if (req.url === '/api/vcenter/datastore') return J([{ datastore: 'ds-1', name: 'ds1', type: 'VMFS', capacity: 1e12, free_space: 5e11 }]);
      return J([]);
    });
  });
  const port = await listen(srv);
  closers.push(() => new Promise((r) => srv.close(r)));
  return { st, host: `http://127.0.0.1:${port}` };
}
const vcOf = (host, id = 'vc1') => ({ id, name: id, host, username: 'u', password: 'p', timeoutMs: 5000 });

// ── F3-1 ────────────────────────────────────────────────────────────────────
test('F3-1 soapFallbackAllowed: vim fault 는 능력 부재 3종만 폴백, fault 없는 비일시 오류는 폴백', async () => {
  const { soapFallbackAllowed } = await import('../src/vcenter/restClient.js');
  const e = (msg, fault) => Object.assign(new Error(msg), fault ? { fault } : {});
  for (const f of ['SystemError', 'NotAuthenticated', 'RequestCanceled', 'NoPermission', 'InvalidState']) {
    assert.equal(soapFallbackAllowed(e(`SOAP 500: x`, f)), false, f);
  }
  for (const f of ['MethodNotFound', 'NotSupported', 'NotImplemented']) assert.equal(soapFallbackAllowed(e('SOAP 500: x', f)), true, f);
  assert.equal(soapFallbackAllowed(e('SOAP 404: Not Found')), true, 'fault 없는 404');
  assert.equal(soapFallbackAllowed(e('SOAP 405: Method Not Allowed')), true, 'fault 없는 405');
  assert.equal(soapFallbackAllowed(e('RetrieveServiceContent failed')), true, 'RetrieveServiceContent 실패');
  assert.equal(soapFallbackAllowed(e('fetch failed')), false, '일시 오류는 예전처럼 던진다');
});

test('F3-1 가짜 vCenter: SOAP 500 vim fault 3종 → REST 폴백 없이 던진다(REST 요청 0)', async () => {
  const { collectFromVCenter } = await import('../src/vcenter/restClient.js');
  for (const [str, type] of [['A general system error occurred: vpxd internal error', 'SystemError'], ['The session is not authenticated.', 'NotAuthenticated'], ['The request was canceled by the user', 'RequestCanceled']]) {
    const { st, host } = await fakeVc((b) => (b.includes('<RetrievePropertiesEx') ? [500, fault(str, type)] : null));
    await assert.rejects(() => collectFromVCenter(vcOf(host)), (err) => err.fault === type, type);
    assert.equal(st.rest, 0, `${type}: REST 로 폴백하지 않는다`);
  }
});

test('F3-1 가짜 vCenter: MethodNotFound fault·fault 없는 404 는 REST 로 폴백(능력 부재)', async () => {
  const { collectFromVCenter } = await import('../src/vcenter/restClient.js');
  const a = await fakeVc((b) => (b.includes('<CreateContainerView') ? [500, fault('Method not found', 'MethodNotFound')] : null));
  const snapA = await collectFromVCenter(vcOf(a.host));
  assert.equal(snapA.vcenter.collectSource, 'rest');
  assert.ok(a.st.rest > 0);
  const b = await fakeVc(() => [404, 'Not Found']);
  const snapB = await collectFromVCenter(vcOf(b.host));
  assert.equal(snapB.vcenter.collectSource, 'rest');
});

// ── F3-3 (수집) ─────────────────────────────────────────────────────────────
const ps = (n, v) => `<propSet><name>${n}</name><val>${v}</val></propSet>`;
const INV = env('<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval>'
  + `<objects><obj type="HostSystem">host-1</obj>${ps('name', 'esx-gpu1')}${ps('runtime.connectionState', 'connected')}${ps('summary.hardware.numCpuCores', '32')}${ps('summary.hardware.cpuMhz', '2000')}${ps('summary.hardware.memorySize', '274877906944')}`
  + `${ps('config.graphicsInfo', '<HostGraphicsInfo><deviceName>NVIDIA A100</deviceName><vendorName>NVIDIA</vendorName><pciId>0000:3b:00.0</pciId><graphicsType>sharedDirect</graphicsType><memorySizeInKB>83886080</memorySizeInKB></HostGraphicsInfo>')}</objects>`
  + `<objects><obj type="VirtualMachine">vm-1</obj>${ps('name', 'ml-train-01')}${ps('runtime.host', 'host-1')}${ps('runtime.powerState', 'poweredOn')}${ps('summary.config.numCpu', '8')}</objects>`
  + '</returnval></RetrievePropertiesExResponse>');

test('F3-3 VM GPU 장치 조회 실패 → vcenter.vmGpuUnknown 표지', async () => {
  const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
  const { host } = await fakeVc((b) => {
    if (b.includes('<RetrievePropertiesEx') && b.includes('ContainerView')) return [200, INV];
    if (b.includes('config.hardware.device')) return [500, fault('A general system error occurred', 'SystemError')];
    return null;
  });
  const snap = await collectFromVCenterSoap(vcOf(host, 'vcgpu'));
  assert.ok(snap.hosts[0].gpus.length > 0, '전제: GPU 호스트');
  assert.equal(snap.vms[0].gpu, null);
  assert.equal(snap.vcenter.vmGpuUnknown, true);
});

test('F3-3 carryVmGpu: 표지가 있으면 같은 id·이름 VM 에 직전 gpu 를 이월, 표지가 없거나 이름이 다르면 안 한다', async () => {
  const { carryVmGpu } = await import('../src/store.js');
  const g = { mode: 'vgpu', profile: 'grid_a100-4c' };
  const prev = { vms: [{ id: 'v:1', name: 'a', gpu: g }, { id: 'v:2', name: 'b', gpu: g }, { id: 'v:3', name: 'c', gpu: null }] };
  const cur = () => ({ vcenter: { id: 'v', vmGpuUnknown: true }, vms: [{ id: 'v:1', name: 'a', gpu: null }, { id: 'v:2', name: 'b-renamed', gpu: null }, { id: 'v:3', name: 'c', gpu: null }] });
  const s1 = cur();
  assert.equal(carryVmGpu(s1, prev), 1);
  assert.deepEqual(s1.vms.map((v) => v.gpu), [g, null, null]);
  assert.equal(s1.vcenter.vmGpuCarried, 1);
  assert.equal(s1.vcenter.vmGpuUnknown, true, '표지는 남긴다(이월 값은 지금 읽은 값이 아니다)');
  const s2 = cur(); delete s2.vcenter.vmGpuUnknown;
  assert.equal(carryVmGpu(s2, prev), 0);
  assert.equal(s2.vms[0].gpu, null, '정상 수집의 null 은 GPU 없음 — 이월하지 않는다');
  assert.equal(carryVmGpu(cur(), null), 0, '직전 스냅샷이 없으면 0');
});

// ── F3-2 ────────────────────────────────────────────────────────────────────
test('F3-2 /summary: 용량 미상 호스트가 있으면 오버커밋 비율 null + hostsCapacityUnknown, 전부 읽으면 수치', async () => {
  const { store } = await import('../src/store.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const mk = (withRest) => {
    const hosts = []; const vms = [];
    for (let i = 0; i < 10; i++) hosts.push({ id: `soap:h${i}`, vcenterId: 'soap', name: `esx${i}`, cluster: 'c', connectionState: 'CONNECTED', cpuCores: 32, cpuTotalMhz: 64000, cpuUsageMhz: 1000, memTotalMB: 262144, memUsageMB: 1000 });
    for (let i = 0; i < 80; i++) vms.push({ id: `soap:vm${i}`, vcenterId: 'soap', name: `s${i}`, powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384, storageGB: 10 });
    const vcenters = [{ id: 'soap', name: 'soap', status: 'connected' }];
    if (withRest) {
      vcenters.push({ id: 'rest', name: 'rest', status: 'connected', collectSource: 'rest', restUnknown: ['hostCapacity'] });
      for (let i = 0; i < 10; i++) hosts.push({ id: `rest:h${i}`, vcenterId: 'rest', name: `r${i}`, cluster: null, connectionState: 'CONNECTED', cpuCores: null, cpuTotalMhz: null, memTotalMB: null });
      for (let i = 0; i < 80; i++) vms.push({ id: `rest:vm${i}`, vcenterId: 'rest', name: `r${i}`, powerState: 'POWERED_ON', cpuCount: 8, memMB: 16384 });
    }
    return { generatedAt: new Date(T0 + (withRest ? 1000 : 2000)).toISOString(), source: 'live', vcenters, hosts, vms, datastores: [], networks: [], alarms: [], rollups: {} };
  };
  const origGet = store.get;
  let SNAP = mk(true);
  store.get = () => SNAP;
  try {
    const app = express();
    app.use((req, _r, n) => { req.user = { username: 'a', role: 'admin', scope: null }; n(); });
    app.use('/api', api);
    const srv = app.listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    closers.push(() => new Promise((r) => srv.close(r)));
    const base = `http://127.0.0.1:${srv.address().port}`;
    const j = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(j.allocation.vcpuPerCore, null);
    assert.equal(j.allocation.ramOvercommitPct, null);
    assert.equal(j.allocation.hostsCapacityUnknown, 10);
    assert.equal(j.compute.hostsCapacityUnknown, 10);
    assert.equal(j.compute.cpuCores, 320, '합계(공개 API 대조 계약)는 그대로');
    SNAP = mk(false);
    const k = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(k.allocation.vcpuPerCore, 2);
    assert.equal(k.allocation.ramOvercommitPct, 50);
    assert.equal(k.allocation.hostsCapacityUnknown, 0);
  } finally {
    store.get = origGet;
  }
});

// ── F3-5 (공개 API 수집 시각 · 순수) ────────────────────────────────────────
test('F3-5 vcCollectedAtOf: 위임 unreachable+staleSince 면 min(receivedAt, staleSince), 그 밖은 receivedAt', async () => {
  const { vcCollectedAtOf } = await import('../src/routes/publicApi.js');
  const snap = { generatedAt: new Date(T0).toISOString() };
  const rcv = T0 - 60_000;
  const since = T0 - 5 * 3_600_000;
  assert.equal(vcCollectedAtOf({ collectSource: 'site', status: 'unreachable', receivedAt: rcv, staleSince: since }, snap), since);
  assert.equal(vcCollectedAtOf({ collectSource: 'site', status: 'unreachable', receivedAt: rcv, staleSince: T0 + 3_600_000 }, snap), rcv, '엣지 시각은 수신 시각으로 자른다');
  assert.equal(vcCollectedAtOf({ collectSource: 'site', status: 'connected', receivedAt: rcv, staleSince: since }, snap), rcv);
  assert.equal(vcCollectedAtOf({ collectSource: 'site', status: 'unreachable', receivedAt: rcv }, snap), rcv);
  assert.equal(vcCollectedAtOf({ collectSource: 'site', status: 'unreachable', receivedAt: rcv, staleSince: 'garbage' }, snap), rcv);
  assert.equal(vcCollectedAtOf({ status: 'unreachable', stale: true, staleSince: since }, snap), since, '직접 수집 이월은 예전대로');
});

// ── F3-4 · F3-5 (store 병합) ────────────────────────────────────────────────
test('F3-4·F3-5 store 병합: 점검중 lastGood 유지 · 위임 엣지 stale 보존', async () => {
  const vcFile = path.join(DIR, 'vcenters.json');
  const reg = (maint) => fs.writeFileSync(vcFile, JSON.stringify({ vcenters: [
    { id: 'edge-vc', name: 'edge-vc', host: 'https://127.0.0.1:1', username: 'u', password: 'p', collectMode: 'site', location: { region: 'EU' } },
    { id: 'edge-vc2', name: 'edge-vc2', host: 'https://127.0.0.1:1', username: 'u', password: 'p', collectMode: 'site', location: { region: 'EU' } },
    { id: 'dir-vc', name: 'dir-vc', host: 'https://127.0.0.1:1', username: 'u', password: 'p', maintenance: maint, location: { region: 'APAC' } },
    { id: 'old-vc', name: 'old-vc', host: 'https://127.0.0.1:1', username: 'u', password: 'p', maintenance: maint, location: { region: 'APAC' } },
  ] }));
  reg(false);
  const { store } = await import('../src/store.js');
  const { setInventory } = await import('../src/central/inventory.js');
  const now = Date.now();
  const edgeSince = now - 5 * 3_600_000;
  setInventory('edge-vc', {
    vcenter: { id: 'edge-vc', name: 'edge-vc', status: 'unreachable', stale: true, staleSince: edgeSince, error: 'timeout' },
    hosts: [{ id: 'edge-vc:host-1', vcenterId: 'edge-vc', name: 'esx1', connectionState: 'CONNECTED' }],
    vms: [{ id: 'edge-vc:vm-1', vcenterId: 'edge-vc', name: 'vm1', powerState: 'POWERED_ON' }], datastores: [], networks: [], alarms: [],
  }, 'edgeA', new Date(now).toISOString());
  // 엣지 시계가 앞선 staleSince(미래) → 수신 시각으로 자른다
  setInventory('edge-vc2', {
    vcenter: { id: 'edge-vc2', name: 'edge-vc2', status: 'unreachable', stale: true, staleSince: now + 10 * 3_600_000 },
    hosts: [{ id: 'edge-vc2:host-1', vcenterId: 'edge-vc2', name: 'esx2', connectionState: 'CONNECTED' }], vms: [], datastores: [], networks: [], alarms: [],
  }, 'edgeA', new Date(now).toISOString());
  const lastGood = (id) => ({ vcenter: { id, name: id, status: 'connected' }, hosts: [{ id: `${id}:host-9`, vcenterId: id, name: 'esx9', connectionState: 'CONNECTED' }], vms: [{ id: `${id}:vm-9`, vcenterId: id, name: 'vm9' }], datastores: [], networks: [], alarms: [] });
  store.vcLast.set('dir-vc', now); store.vcLast.set('old-vc', now);   // 이번 주기 수집 안 함(주기 미도래)
  const lgAt = now - 10 * 60_000;
  store.vcCache.set('dir-vc', { ok: false, vc: {}, err: { message: 'timeout' }, at: now, lastGoodAt: lgAt, lastGood: lastGood('dir-vc') });
  store.vcCache.set('old-vc', { ok: false, vc: {}, err: { message: 'timeout' }, at: now, lastGoodAt: now - 30 * 3_600_000, lastGood: lastGood('old-vc') });   // 보존 창(기본 6시간) 밖
  store._merged = true;
  await store.refresh();
  let s = store.get();
  const ev = s.vcenters.find((v) => v.id === 'edge-vc');
  assert.equal(ev.stale, true, '엣지 stale 을 push 신선도로 덮지 않는다');
  assert.equal(ev.edgeStale, true);
  assert.equal(ev.staleSince, edgeSince);
  assert.ok(ev.receivedAt >= now - 60_000, '전제: 방금 받음');
  const ev2 = s.vcenters.find((v) => v.id === 'edge-vc2');
  assert.ok(ev2.staleSince <= ev2.receivedAt, '엣지 staleSince 는 수신 시각을 넘지 못한다');
  const { vcCollectedAtOf } = await import('../src/routes/publicApi.js');
  assert.equal(vcCollectedAtOf(ev, s), edgeSince, '공개 API 수집 시각은 엣지 데이터 시각');

  reg(true);   // 관리자가 점검중으로 전환
  await store.refresh();
  s = store.get();
  const dv = s.vcenters.find((v) => v.id === 'dir-vc');
  assert.equal(dv.status, 'maintenance');
  assert.equal(s.hosts.filter((h) => h.vcenterId === 'dir-vc').length, 1, 'lastGood 호스트 유지');
  assert.equal(s.vms.filter((v) => v.vcenterId === 'dir-vc').length, 1, 'lastGood VM 유지');
  assert.equal(dv.stale, true);
  assert.equal(dv.staleSince, lgAt);
  const ov = s.vcenters.find((v) => v.id === 'old-vc');
  assert.equal(ov.status, 'maintenance');
  assert.equal(s.hosts.filter((h) => h.vcenterId === 'old-vc').length, 0, '보존 창 밖 lastGood 은 싣지 않는다');
});

// ── F3-3 (store 경로 — 실제 수집 두 번) ─────────────────────────────────────
test('F3-3 store: 장치 조회 성공 다음 주기에 실패하면 직전 vm.gpu 를 이월하고 표지를 싣는다', async () => {
  const DEV = env('<RetrievePropertiesExResponse xmlns="urn:vim25"><returnval>'
    + `<objects><obj type="VirtualMachine">vm-1</obj><propSet><name>config.hardware.device</name><val><VirtualDevice xsi:type="VirtualPCIPassthrough"><key>13000</key><backing xsi:type="VirtualPCIPassthroughVmiopBackingInfo"><vgpu>grid_a100-4c</vgpu></backing></VirtualDevice></val></propSet></objects>`
    + '</returnval></RetrievePropertiesExResponse>');
  let failDev = false;
  const { host } = await fakeVc((b) => {
    if (b.includes('<RetrievePropertiesEx') && b.includes('ContainerView')) return [200, INV];
    if (b.includes('config.hardware.device')) return failDev ? [500, fault('A general system error occurred', 'SystemError')] : [200, DEV];
    return null;
  });
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [{ id: 'gpu-vc', name: 'gpu-vc', host, username: 'u', password: 'p', location: { region: 'APAC' } }] }));
  const { store } = await import('../src/store.js');
  await store.refresh({ collectAll: true });
  let vm = store.get().vms.find((v) => v.id === 'gpu-vc:vm-1');
  assert.ok(vm?.gpu && vm.gpu.vgpu === 1, `전제: 첫 수집은 vGPU 를 읽는다 (${JSON.stringify(vm?.gpu)})`);
  const g1 = vm.gpu;
  assert.equal(store.get().vcenters.find((v) => v.id === 'gpu-vc').vmGpuUnknown, undefined);
  failDev = true;
  await store.refresh({ collectAll: true });
  const s = store.get();
  const vc = s.vcenters.find((v) => v.id === 'gpu-vc');
  assert.equal(vc.status, 'connected');
  assert.equal(vc.vmGpuUnknown, true);
  assert.equal(vc.vmGpuCarried, 1);
  vm = s.vms.find((v) => v.id === 'gpu-vc:vm-1');
  assert.deepEqual(vm.gpu, g1, '직전 값 이월(GPU 없음으로 떨어지지 않는다)');
});
