/**
 * test/audit2733f_gpuSite.test.js — 점검 3회차(v2.733) 그룹 f · C4-01.
 *
 * GPU 게스트 폴러(gpu/poller.js)가 엣지 위임(site) vCenter 에 **중앙에서 직접 로그인**하던 결함(v2.732 B4-01 의 형제 누락).
 * 실제 pollGpuGuestOnce 를 부르고 가짜 vCenter(SOAP)에 도착한 Login 요청 수를 센다 — 소스 grep 이 아니다.
 *  ① site·점검중·비활성 vCenter 에는 로그인 0회 · 직접 수집 vCenter 에는 로그인한다(엣지가 자기 로컬 vCenter 를 수집하는 경우와 같다)
 *  ② 건너뛴 개수·사유가 lastRun·진단에 남는다(무음 금지) · site 는 push 보류 사유(unreadVcenters)가 아니다
 *  ③ 엣지로 돌 때(CENTRAL_URL 설정)도 판정은 그 노드의 등록부다 — 직접 수집 항목은 그대로 로그인한다
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2733f-gpu-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const SC = '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><RetrieveServiceContentResponse xmlns="urn:vim25"><returnval><rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector><viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager><guestOperationsManager type="GuestOperationsManager">guestOperationsManager</guestOperationsManager><about><version>8.0.2</version></about></returnval></RetrieveServiceContentResponse></soapenv:Body></soapenv:Envelope>';
const OK = (tag) => `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><${tag}Response xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></${tag}Response></soapenv:Body></soapenv:Envelope>`;
const FAULT = '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><soapenv:Fault><faultcode>ServerFaultCode</faultcode><faultstring>not implemented</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>';

/** 가짜 vCenter — Login 수를 센다(그 밖의 게스트 작업은 500 fault). */
async function fakeVc() {
  const counts = { login: 0, logout: 0, other: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (b.includes('<RetrieveServiceContent')) { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(SC); return; }
      if (b.includes('<Login ')) { counts.login++; res.writeHead(200, { 'content-type': 'text/xml', 'set-cookie': 'vmware_soap_session="abc"; Path=/' }); res.end(OK('Login')); return; }
      if (b.includes('<Logout ')) { counts.logout++; res.writeHead(200, { 'content-type': 'text/xml' }); res.end('<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><LogoutResponse xmlns="urn:vim25"/></soapenv:Body></soapenv:Envelope>'); return; }
      counts.other++; res.writeHead(500, { 'content-type': 'text/xml' }); res.end(FAULT);
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, counts, url: `http://127.0.0.1:${srv.address().port}` };
}

const skippedVc = await fakeVc();   // site·점검중·비활성 vCenter 가 가리키는 서버 — 로그인이 0 이어야 한다
const directVc = await fakeVc();    // 직접 수집 vCenter — 로그인해야 한다
after(() => { skippedVc.srv.close(); directVc.srv.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: [
  { id: 'vc-site', name: 'site', host: skippedVc.url, username: 'vc-user', password: 'x', collectMode: 'site', remoteAgent: 'edge-a' },
  { id: 'vc-maint', name: 'maint', host: skippedVc.url, username: 'vc-user', password: 'x', maintenance: true },
  { id: 'vc-off', name: 'off', host: skippedVc.url, username: 'vc-user', password: 'x', enabled: false },
  { id: 'vc-direct', name: 'direct', host: directVc.url, username: 'vc-user', password: 'x' },
] }));
fs.writeFileSync(path.join(DIR, 'gpu-guest.json'), JSON.stringify({
  enabled: true, pollIntervalMs: 60_000, collectMethod: 'guestops', timeoutMs: 3000,
  vcenters: Object.fromEntries(['vc-site', 'vc-maint', 'vc-off', 'vc-direct'].map((id) => [id, { enabled: true, username: 'guest', password: 'gp' }])),
}));

const { store } = await import('../src/store.js');
const { config } = await import('../src/config.js');
const g = await import('../src/gpu/poller.js');

/** 각 vCenter 에 GPU 호스트 1대·GPU VM 1대. site 는 엣지가 보낸 상태 그대로(connected · 낡음 stale) — 예전 판정이 통과시킨 모양. */
function setSnapshot() {
  const vcs = [
    { id: 'vc-site', name: 'site', status: 'connected', collectSource: 'site', stale: true },
    { id: 'vc-maint', name: 'maint', status: 'maintenance', maintenance: true },
    { id: 'vc-off', name: 'off', status: 'disabled' },
    { id: 'vc-direct', name: 'direct', status: 'connected' },
  ];
  store.snapshot = {
    source: 'vcenter', generatedAt: new Date().toISOString(), vcenters: vcs,
    hosts: vcs.map((v) => ({ id: `${v.id}:host-1`, name: `esx-${v.id}`, vcenterId: v.id, gpus: [{ mode: 'passthrough' }] })),
    vms: vcs.map((v) => ({ id: `${v.id}:vm-1`, name: `gpuvm-${v.id}`, vcenterId: v.id, host: `esx-${v.id}`, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'ubuntu', gpu: { passthrough: 1, type: 'passthrough', count: 1 } })),
    datastores: [], alarms: [],
  };
}

test('C4-01 ① site·점검중·비활성 vCenter 에 로그인 0회 — 직접 수집 vCenter 는 로그인한다', async () => {
  setSnapshot();
  skippedVc.counts.login = 0; directVc.counts.login = 0;
  await g.pollGpuGuestOnce();
  // 수정 전: site 는 엣지가 보낸 status 'connected' 로 inventoryUnreadReason 을 통과해 Login 1회
  assert.equal(skippedVc.counts.login, 0, `위임·점검중·비활성 vCenter 에 로그인했다(${skippedVc.counts.login}회)`);
  assert.ok(directVc.counts.login >= 1, '직접 수집 vCenter 는 그대로 로그인해야 한다');
});

test('C4-01 ② 건너뛴 개수·사유를 상태·진단에 남긴다 — site 는 push 보류 사유가 아니다', async () => {
  setSnapshot();
  await g.pollGpuGuestOnce();
  const last = g.gpuGuestStatus().lastRun;
  assert.deepEqual(last.skippedCounts, { disabled: 1, maintenance: 1, site: 1 });
  const site = last.skippedVcenters.find((x) => x.vcId === 'vc-site');
  assert.equal(site?.why, 'site');
  assert.equal(site?.remoteAgent, 'edge-a', '담당 엣지를 밝힌다');
  const unread = last.unreadVcenters.map((x) => x.vcId).sort();
  assert.ok(unread.includes('vc-maint') && unread.includes('vc-off'), '비활성·점검중은 예전처럼 unread(엣지 push 보류 동작 불변)');
  assert.ok(!unread.includes('vc-site'), "site 는 '못 읽음' 이 아니라 '이 노드의 몫이 아님' — push 보류 사유로 넣지 않는다");
  const d = g.getGpuGuestDiag().vcenters.find((x) => x.vcId === 'vc-site');
  assert.match(d.stage, /엣지 위임/);
  assert.equal(d.skipped, 'site');
  assert.equal(d.results.length, 0);
});

test('C4-01 ③ 엣지로 돌 때도 판정은 그 노드의 등록부 — 직접 수집 항목은 로그인한다', async () => {
  const prev = { u: config.agent.centralUrl, n: config.agent.name };
  config.agent.centralUrl = 'http://127.0.0.1:9'; config.agent.name = 'edge-a';
  try {
    setSnapshot();
    skippedVc.counts.login = 0; directVc.counts.login = 0;
    await g.pollGpuGuestOnce();
    assert.equal(skippedVc.counts.login, 0);
    assert.ok(directVc.counts.login >= 1, '엣지 자신의 로컬(직접 수집) vCenter 는 수집해야 한다');
  } finally { config.agent.centralUrl = prev.u; config.agent.name = prev.n; }
});

test('C4-01 skippedVcenterDiag — 사유별 진단·unread(순수, 로그인 0)', () => {
  const s = g.skippedVcenterDiag({ id: 'a', collectMode: 'site', remoteAgent: 'E' }, 'site', 1);
  assert.equal(s.unread, '');
  assert.equal(s.diag.remoteAgent, 'E');
  assert.equal(s.diag.unread, undefined);
  assert.ok(g.skippedVcenterDiag({ id: 'b', enabled: false }, 'disabled', 1).unread);
  assert.ok(g.skippedVcenterDiag({ id: 'c', maintenance: true }, 'maintenance', 1).diag.unread);
  assert.equal(g.skippedVcenterDiag({ id: 'd', collectMode: 'site' }, 'site', 1).diag.remoteAgent, null, '담당 엣지 미지정은 null');
});
