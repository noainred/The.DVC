/**
 * test/audit2744f.test.js — v2.744 3회차 GF(vCenter 리포트) 회귀.
 *
 * VC-02: 같은 이름 다른 데이터센터 클러스터(vSphere 클러스터 이름은 데이터센터 안에서만 유일)를 이름으로 묶어
 *   vSAN 거짓 분할(crit)·거짓 드리프트·용량/비용/이전 준비도/토폴로지 행 합침이 났다 → (vCenter, 클러스터 moref) 로 묶는다.
 * VC-03: 코어 라이선스·비용 배분·이전 준비도가 읽지 못한 vCenter 를 0 으로 섞은 부분 합을 전체 합계처럼 냈다 → notReadVcenters·partial.
 * VC-04: 주문형 성능 조회가 인증 정지만 보고 직접 수집 대상인지(비활성·점검중·엣지 위임)를 보지 않아 그 vCenter 에 로그인했다.
 *
 * ⚠ VC-04 는 문자열이 아니라 **가짜 vCenter 의 실제 로그인 수**로 판정한다(audit2733i_authStopGate 와 같은 하니스 — 실제 api 라우터).
 *   가짜 vCenter 는 비밀번호가 맞으므로 문이 막지 않으면 로그인이 실제로 일어난다.
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744f-'));
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

/** 가짜 vCenter — 비밀번호 'good' 이면 로그인 통과(문이 막지 않으면 로그인이 실제로 센다). 로그인 뒤 호출은 NotSupported. */
async function fakeVcenter() {
  const st = { logins: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) {
        st.logins += 1;
        return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>'));
      }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      return send(500, FAULT('NotSupported', 'not supported in this fake'));
    }
    if (req.url === '/api/session') { st.logins += 1; res.writeHead(201, { 'content-type': 'application/json' }); return res.end('"tok"'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

const N = 4;
const vmRows = (vcId, extra = {}) => Array.from({ length: N }, (_, i) => ({
  id: `${vcId}:vm-${i + 1}`, vcenterId: vcId, name: `${vcId}-g${i + 1}`, powerState: 'POWERED_ON',
  cpuUsagePct: 10, memUsagePct: 20, host: `${vcId}-h1`, numCpu: 2, cpuCount: 2, memMB: 4096, memoryMB: 4096, cluster: 'C1', ...extra,
}));
const hostRows = (vcId) => [1, 2].map((i) => ({ id: `${vcId}:host-${i}`, vcenterId: vcId, name: `${vcId}-h${i}`, cluster: 'C1', connectionState: 'CONNECTED', cpuCores: 8, cpuTotalMhz: 20000, memTotalMB: 65536 }));

// VC-02 — 한 vCenter(vc-a) 안 두 데이터센터에 같은 이름 'Prod' 4대 vSAN 클러스터.
const DCS = [{ ref: 'domain-c10', dc: 'DC-Seoul', ntp: 'ntp-seoul.example' }, { ref: 'domain-c20', dc: 'DC-Busan', ntp: 'ntp-busan.example' }];
const prodHosts = () => DCS.flatMap((d, di) => [1, 2, 3, 4].map((i) => ({
  id: `vc-a:host-${di}${i}`, vcenterId: 'vc-a', name: `esx-${d.dc}-${i}`, cluster: 'Prod', clusterRef: d.ref, vcDatacenter: d.dc,
  connectionState: 'CONNECTED', cpuCores: 16, cpuSockets: 2, cpuTotalMhz: 40000, cpuUsageMhz: 10000, memTotalMB: 262144, memUsageMB: 65536,
  hcfg: { vsan: { enabled: true, members: 4, diskIssues: 0 }, ntpServers: [d.ntp], dnsServers: ['10.0.0.53'] },
})));
const prodVms = () => DCS.flatMap((d, di) => [1, 2].map((i) => ({
  id: `vc-a:vm-${di}${i}`, vcenterId: 'vc-a', name: `app-${d.dc}-${i}`, powerState: 'POWERED_ON', cluster: 'Prod', clusterRef: d.ref,
  host: `esx-${d.dc}-1`, cpuCount: 4, memMB: 8192, storageGB: 100, cpuUsagePct: 10, memUsagePct: 20,
})));

let base; let VC; let snapBase;
before(async () => {
  VC = { a: await fakeVcenter(), m: await fakeVcenter(), s: await fakeVcenter(), o: await fakeVcenter() };
  const reg = [
    { id: 'vc-a', name: 'VC-A', host: VC.a.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
    { id: 'vc-m', name: 'VC-M', host: VC.m.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, maintenance: true, timeoutMs: 5000 },
    { id: 'vc-s', name: 'VC-S', host: VC.s.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, collectMode: 'site', remoteAgent: 'edge1', timeoutMs: 5000 },
    { id: 'vc-o', name: 'VC-O', host: VC.o.host, username: 'administrator@vsphere.local', password: 'good', enabled: false, timeoutMs: 5000 },
    { id: 'vc-u', name: 'VC-U', host: 'http://127.0.0.1:9', username: 'u', password: 'good', enabled: true, timeoutMs: 5000 },
    { id: 'vc-p', name: 'VC-P', host: 'http://127.0.0.1:9', username: 'u', password: 'good', enabled: true, timeoutMs: 5000 },
  ];
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: reg }));
  const { store } = await import('../src/store.js');
  snapBase = {
    source: 'live', generatedAt: '2026-10-19T03:30:00.000Z',
    vcenters: [
      { id: 'vc-a', name: 'VC-A', status: 'connected' },
      { id: 'vc-m', name: 'VC-M', status: 'connected' }, { id: 'vc-s', name: 'VC-S', status: 'connected' }, { id: 'vc-o', name: 'VC-O', status: 'connected' },
      { id: 'vc-u', name: 'VC-U', status: 'unreachable' }, { id: 'vc-p', name: 'VC-P', status: 'pending' },
    ],
    vms: [...prodVms(), ...['vc-m', 'vc-s', 'vc-o'].flatMap((id) => vmRows(id))],
    hosts: [...prodHosts(), ...['vc-m', 'vc-s', 'vc-o'].flatMap(hostRows)],
    datastores: [], networks: [], alarms: [],
  };
  store.snapshot = { ...(store.get() || {}), ...snapBase };
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

const loginsAll = () => VC.m.st.logins + VC.s.st.logins + VC.o.st.logins;
const call = async (m, p, body, h = {}) => {
  const b0 = loginsAll();
  const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...h }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, logins: loginsAll() - b0, j };
};

// ─────────────────────────────── VC-02 ───────────────────────────────
test('VC-02 ① vSAN: 같은 이름 다른 데이터센터 4대 클러스터 둘 → 분할(crit) 0 · 클러스터 2개(데이터센터 표기)', async () => {
  const { analyzeVsan } = await import('../src/dscfg/analyze.js');
  const r = analyzeVsan(prodHosts(), []);
  assert.equal(r.clusters.length, 2, `클러스터가 이름으로 합쳐졌다: ${r.clusters.length}`);
  const parts = r.clusters.flatMap((c) => c.findings).filter((f) => f.code === 'vsan-partition');
  assert.equal(parts.length, 0, `거짓 vSAN 분할: ${JSON.stringify(parts)}`);
  assert.deepEqual(r.clusters.map((c) => c.vcDatacenter).sort(), ['DC-Busan', 'DC-Seoul']);
  assert.ok(r.clusters.every((c) => c.sameName === 2 && c.hosts === 4));
});

test('VC-02 ② 드리프트: 두 클러스터 값이 섞이지 않는다(각자 NTP 가 같으면 드리프트 0)', async () => {
  const { clusterDrift } = await import('../src/hostcfg/parse.js');
  const r = clusterDrift(prodHosts());
  assert.equal(r.perHost.size, 0, `다른 데이터센터 값이 섞여 거짓 드리프트: ${JSON.stringify([...r.perHost])}`);
  // 한 클러스터 안의 진짜 드리프트는 그대로 잡는다.
  const hs = prodHosts(); hs[0].hcfg.ntpServers = ['other.example'];
  const r2 = clusterDrift(hs);
  assert.equal(r2.perHost.size, 1);
  assert.equal(r2.clusters.length, 1);
  assert.equal(r2.clusters[0].clusterRef, 'domain-c10');
});

test('VC-02 ③ /tools/capacity(실제 라우터): 클러스터 행 2개 · 행마다 호스트 4대 · VM 은 자기 클러스터에', async () => {
  const r = await call('GET', '/api/tools/capacity?vcenterId=vc-a');
  assert.equal(r.status, 200);
  const prod = r.j.clusters.filter((c) => c.cluster === 'Prod');
  assert.equal(prod.length, 2, `같은 이름 클러스터가 한 행이 됐다: ${JSON.stringify(prod).slice(0, 300)}`);
  assert.ok(prod.every((c) => c.hosts === 4 && c.vms === 2 && c.sameName === 2));
  assert.deepEqual(prod.map((c) => c.clusterRef).sort(), ['domain-c10', 'domain-c20']);
});

test('VC-02 ④ 비용 배분·이전 준비도·토폴로지: 같은 이름 클러스터가 다른 행 · 라벨은 웹 clusterNameLabel 과 같다', async () => {
  const { analyzeCost } = await import('../src/cost/analyze.js');
  const { analyzeMigration } = await import('../src/migration/analyze.js');
  const { buildTopology } = await import('../src/insights/topology.js');
  const { clusterLabelOf } = await import('../src/clustercfg/analyze.js');
  const { clusterNameLabel } = await import('../../web/src/views/clustercfg/clusterCfgText.js');
  const snap = { ...snapBase, vms: prodVms(), hosts: prodHosts(), vcenters: [{ id: 'vc-a', name: 'VC-A', status: 'connected' }] };
  const cost = analyzeCost(snap, { vcpu: 1000, ramGB: null, storageGB: null, storageBasis: 'used', offPolicy: 'storage' }, { by: 'cluster' });
  const cg = cost.groups.filter((g) => /Prod/.test(g.label));
  assert.equal(cg.length, 2, `비용 행이 합쳐졌다: ${JSON.stringify(cost.groups.map((g) => g.label))}`);
  assert.deepEqual(cg.map((g) => g.label).sort(), ['Prod · DC-Busan', 'Prod · DC-Seoul']);
  const mig = analyzeMigration(snap.vms, { by: 'cluster', hosts: snap.hosts });
  const mg = (mig.groups || []).filter((g) => g.name === 'Prod' || g.cluster === 'Prod' || /Prod/.test(String(g.label || g.name || '')));
  assert.equal(mg.length, 2, `이전 준비도 행이 합쳐졌다: ${JSON.stringify(mig.groups).slice(0, 300)}`);
  const topo = buildTopology(snap);
  const tn = topo.tree.flatMap((v) => v.children).filter((n) => n.type === 'cluster' && /Prod/.test(n.label));
  assert.equal(tn.length, 2, `토폴로지 클러스터 노드가 합쳐졌다: ${JSON.stringify(tn)}`);
  assert.equal(new Set(tn.map((n) => n.id)).size, 2);
  for (const r of [
    { name: 'Prod', sameName: 2, vcDatacenter: 'DC-Seoul' }, { name: 'Prod', sameName: 2, ref: 'domain-c9' },
    { cluster: 'Prod', sameName: 2, clusterRef: 'domain-c9' }, { name: 'Prod', sameName: 3 }, { name: 'Prod', sameName: 1, vcDatacenter: 'X' }, { name: 'Prod' },
  ]) assert.equal(clusterLabelOf(r), clusterNameLabel(r), `서버·웹 라벨이 다르다: ${JSON.stringify(r)}`);
});

test('VC-02 ⑤ ref 를 싣지 않은 옛 스냅샷(이름 모드)은 예전처럼 이름으로 묶는다', async () => {
  const { analyzeVsan } = await import('../src/dscfg/analyze.js');
  const hs = prodHosts().map(({ clusterRef, ...h }) => h);
  const r = analyzeVsan(hs, []);
  assert.equal(r.clusters.length, 1, '구분할 근거(ref)가 없으면 합친다(지어내지 않는다)');
});

// ─────────────────────────────── VC-03 ───────────────────────────────
test('VC-03 ① 코어 라이선스: 읽지 못한 vCenter 는 0 대가 아니라 미수집 · 합계 partial · 라이선스 미확인 수에서 뺀다', async () => {
  const { analyzeCoreLicense } = await import('../src/corelicense/analyze.js');
  const snap = { ...snapBase, vms: prodVms(), hosts: prodHosts(), vcenters: [
    { id: 'vc-a', name: 'VC-A', status: 'connected', licenses: [] },
    { id: 'vc-u', name: 'VC-U', status: 'unreachable' }, { id: 'vc-p', name: 'VC-P', status: 'pending' }, { id: 'vc-o', name: 'VC-O', status: 'disabled' },
  ] };
  const r = analyzeCoreLicense(snap, {});
  assert.equal(r.totals.partial, true, '읽지 못한 vCenter 가 있는데 합계를 전체라 말했다');
  assert.equal(r.totals.notRead, 2);
  assert.equal(r.totals.notReadDisabled, 1);
  const row = (id) => r.vcenters.find((v) => v.vcenterId === id);
  assert.equal(row('vc-u').notRead, 'unreachable');
  assert.equal(row('vc-p').notRead, 'pending');
  assert.equal(row('vc-u').licensed, null, '미수집 vCenter 의 필요 코어는 0 이 아니라 null');
  assert.equal(row('vc-u').hosts, null);
  assert.equal(row('vc-u').reportedDiff, null);
  assert.equal(row('vc-a').notRead, null);
  assert.equal(row('vc-a').licensed > 0, true);
  assert.deepEqual(r.notReadVcenters.map((x) => x.vcenterId).sort(), ['vc-o', 'vc-p', 'vc-u']);
  assert.ok(!(r.totals.licensesUnread > 0) || r.totals.licensesUnread <= 1, `미수집 vCenter 를 라이선스 미확인으로 셌다: ${r.totals.licensesUnread}`);
});

test('VC-03 ② 비용 배분·이전 준비도·코어 라이선스(실제 라우터): notReadVcenters·partial · 범위 밖 vCenter 는 싣지 않는다', async () => {
  for (const p of ['/api/tools/cost-showback', '/api/tools/migration-readiness', '/api/tools/core-license']) {
    const r = await call('GET', p);
    assert.equal(r.status, 200, `${p} ${r.status}`);
    assert.equal(r.j.partial === true || r.j.totals?.partial === true, true, `${p} partial 없음`);
    const ids = (r.j.notReadVcenters || []).map((x) => x.vcenterId).sort();
    assert.deepEqual(ids, ['vc-p', 'vc-u'], `${p}: ${JSON.stringify(r.j.notReadVcenters)}`);
    const sc = await call('GET', p, null, { 'x-scope': JSON.stringify({ vcenters: ['vc-a', 'vc-u'] }) });
    assert.equal(sc.status, 200);
    assert.deepEqual((sc.j.notReadVcenters || []).map((x) => x.vcenterId), ['vc-u'], `${p} 범위 밖 vCenter 가 실렸다: ${JSON.stringify(sc.j.notReadVcenters)}`);
  }
  for (const p of ['/api/tools/cost-showback.csv', '/api/tools/migration-readiness.csv', '/api/tools/core-license.csv']) {
    const csv = await fetch(`${base}${p}`).then((x) => x.text());
    assert.match(csv, /읽지 못한 vCenter 2곳/, `${p} 파일만 받은 사람이 합계가 하한임을 모른다`);
  }
});

// ─────────────────────────────── VC-04 ───────────────────────────────
test('VC-04 ① 직접 수집 대상이 아닌 vCenter(점검중·엣지 위임·비활성): 주문형 성능 조회가 로그인 0 · 사유(skipReason)', async () => {
  const cases = [['vc-m', 'maintenance'], ['vc-s', 'site'], ['vc-o', 'disabled']];
  for (const [id, why] of cases) {
    let r = await call('GET', `/api/vms/${encodeURIComponent(`${id}:vm-1`)}/metrics?type=cpu&interval=day`);
    assert.equal(r.status, 409, `${id} VM 성능 ${r.status}`); assert.equal(r.logins, 0, `${id} VM 성능 로그인 ${r.logins}`);
    assert.equal(r.j.skipReason, why);
    r = await call('GET', `/api/vms/${encodeURIComponent(`${id}:vm-1`)}/metrics?type=cpu&interval=day&manual=1`);
    assert.equal(r.status, 409, '사람이 누른 다시 조회도 막는다'); assert.equal(r.logins, 0);
    r = await call('GET', `/api/hosts/${encodeURIComponent(`${id}:host-1`)}/metrics?type=cpu&interval=day`);
    assert.equal(r.status, 409); assert.equal(r.logins, 0); assert.equal(r.j.skipReason, why);
    r = await call('POST', '/api/tools/waste/spark', { vmIds: vmRows(id).map((v) => v.id), type: 'cpu' });
    assert.equal(r.status, 200); assert.equal(r.logins, 0, `${id} 스파크라인 로그인 ${r.logins}`);
    assert.equal(r.j.skippedVcenters?.[id]?.skipReason, why);
    assert.ok(vmRows(id).every((v) => r.j.series[v.id] === null));
    r = await call('POST', '/api/vms/usage', { vmIds: vmRows(id).map((v) => v.id), days: 30 });
    assert.equal(r.status, 200); assert.equal(r.logins, 0); assert.equal(r.j.skippedVcenters?.[id]?.skipReason, why);
    assert.ok(vmRows(id).every((v) => r.j.usage[v.id] === null));
    r = await call('GET', `/api/vcenters/${id}/usage-history?range=24h&scope=${encodeURIComponent('cluster:C1')}`);
    assert.equal(r.status, 200); assert.equal(r.logins, 0, `${id} 클러스터 추이 로그인 ${r.logins}`);
    assert.equal(r.j.skipReason, why); assert.deepEqual(r.j.points, []);
    r = await call('GET', `/api/tools/rightsize?vmId=${encodeURIComponent(`${id}:vm-2`)}&days=7`);
    assert.equal(r.status, 409); assert.equal(r.logins, 0); assert.equal(r.j.skipReason, why);
    r = await call('POST', '/api/tools/vm-finder', { withAvg: true, vcenterIds: [id] });
    assert.equal(r.status, 200); assert.equal(r.logins, 0, `${id} 유휴 VM 평균 로그인 ${r.logins}`);
    assert.ok(r.j.items.length > 0);
    assert.ok(r.j.items.every((it) => it.skipReason === why && it.idle === null && it.avgDayCpu === null), '판정 불가(null) — 유휴 아님(false) 으로 쓰지 않는다');
    assert.equal(r.j.skippedVcenters?.[id]?.skipReason, why);
  }
  assert.equal(loginsAll(), 0);
});

test('VC-04 ② 사유 문장 표는 dsBrowse 주문형 문과 같다 · 직접 수집 대상이면 문이 막지 않는다', async () => {
  const { DIRECT_SKIP_TEXT, vcSkipOf, createVcAuthGate } = await import('../src/vcenter/authStopGate.js');
  const { ON_DEMAND_SKIP_TEXT } = await import('../src/vcenter/dsBrowse.js');
  assert.deepEqual({ ...DIRECT_SKIP_TEXT }, { ...ON_DEMAND_SKIP_TEXT });
  assert.equal(vcSkipOf({ id: 'x', enabled: true }), null);
  const gate = createVcAuthGate();
  const r = await gate.run({ id: 'x', enabled: true }, async () => 42);
  assert.equal(r.value, 42);
  const s = await gate.run({ id: 'y', enabled: true, maintenance: true }, async () => { throw new Error('호출되면 안 된다'); });
  assert.equal(s.skipped, true); assert.equal(s.skip.skipReason, 'maintenance');
  assert.deepEqual(Object.keys(gate.skippedVcenters()), ['y']);
  const { SKIP_REASON_TEXT } = await import('../../web/src/views/vcAuthStopText.js');
  assert.deepEqual(Object.keys(SKIP_REASON_TEXT).sort(), Object.keys(DIRECT_SKIP_TEXT).sort(), '웹 사유 표와 서버 키 1:1');
});
