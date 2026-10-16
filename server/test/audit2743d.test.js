/**
 * v2.743(점검 2회차 그룹 GD) — vCenter 수동 경로의 주문형 로그인 문 · 라이선스 사용량 결측.
 *
 * VC-03(재현): v2.742 가 데이터스토어 탐색·고아 VMDK·VM 내보내기·게스트 계정 추가에 붙인 주문형 로그인 문
 *   (vcenter/dsBrowse.js onDemandVcBlock·onDemandLogin·onDemandLoginError)을 지나지 않는 경로가 4종 더 있었다 —
 *   ① POST /vms/upgrade-tools ② GET /admin/vm/:id/hardware 와 POST reconfig ③ VM 프로비저닝 작업 ④ POST /admin/gpu-guest/test.
 *   비활성·점검중·엣지 위임(site) vCenter 에도 로그인했고, 거부는 주 폴러의 정지 기록에 올라가지 않았다.
 *   ⚠ 문자열이 아니라 **실제 로그인 시도 횟수**를 센다(가짜 vCenter — SOAP InvalidLogin). 판정 헬퍼는 dsBrowse.js 하나다.
 *   사람이 누른 쓰기 실행은 인증 정지 중에도 1회 시도하고(accountService 와 같은 판단), 화면을 열 때 부르는 하드웨어 조회는 정지면 로그인 0.
 *   프로비저닝은 배치 전체가 로그인 한 번을 공유한다 — 예전에는 VM 마다 로그인해 틀린 비밀번호가 VM 수만큼 실패 로그인을 만들었다.
 * WEB-05(재현): 라이선스 used/total 결측(null, v2.727 C-02)을 /tools/licenses 롤업이 `|| 0` 으로 더해 '사용 0·총량 0' 이 됐다.
 *   이제 결측은 합계에서 빼고 usedUnknown·totalUnknown 으로 세며, 한 단위도 못 읽은 합은 null 이다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2743d-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
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

/** 가짜 vCenter — Login 은 password 'good' 만 통과(계정별로 센다). 속성 조회는 빈 결과, Tools 업그레이드는 태스크를 준다. */
async function fakeVcenter() {
  const st = { logins: new Map(), upgrades: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
    if (body.includes('<Login ')) {
      const u = /<userName>([^<]*)<\/userName>/.exec(body)?.[1] || '';
      st.logins.set(u, (st.logins.get(u) || 0) + 1);
      // 로그인 응답을 조금 늦춘다 — 동시 실행 VM 이 '로그인이 끝나기 전' 에 겹치는 상황을 만든다(프로비저닝 배치).
      await new Promise((r) => setTimeout(r, 40));
      if (body.includes('<password>good</password>')) { res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>')); }
      return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
    }
    if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
    if (body.includes('<UpgradeTools_Task')) { st.upgrades += 1; return send(200, ENV('<UpgradeTools_TaskResponse xmlns="urn:vim25"><returnval type="Task">task-1</returnval></UpgradeTools_TaskResponse>')); }
    if (body.includes('<RetrievePropertiesEx')) return send(200, ENV('<RetrievePropertiesExResponse xmlns="urn:vim25"></RetrievePropertiesExResponse>'));
    if (body.includes('<RetrieveProperties')) return send(200, ENV('<RetrievePropertiesResponse xmlns="urn:vim25"></RetrievePropertiesResponse>'));
    return send(500, FAULT('NotSupported', 'unexpected'));
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${port}`, logins: (u) => st.logins.get(u) || 0, upgrades: () => st.upgrades };
}

const writeJson = (name, obj) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(obj, null, 2));
const vmRow = (vcId, n = 1) => ({ id: `${vcId}:vm-${n}`, vcenterId: vcId, name: `${vcId}-vm${n}`, powerState: 'POWERED_ON', toolsStatus: 'RUNNING', guestOS: 'Red Hat Enterprise Linux 9', host: 'h1' });

/** 라우터 하나를 띄운다(req.user 를 고정). */
async function serve(register, mount, user) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const r = express.Router();
  register(r);
  app.use(mount, r);
  const srv = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  closers.push(() => new Promise((ok) => { srv.closeAllConnections?.(); srv.close(ok); }));
  const base = `http://127.0.0.1:${srv.address().port}${mount}`;
  return async (p, body) => {
    const res = await fetch(base + p, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
}
const ADMIN = { username: 'admin', role: 'admin', scope: null };

// 등록 vCenter — 계정 이름으로 시도를 센다(한 가짜 vCenter 를 여러 등록 항목이 함께 쓴다).
const IDS = ['ok', 'dis', 'maint', 'site', 'stop', 'bad-up', 'bad-hw', 'bad-rc', 'stop-rc', 'bad-pv', 'site-pv', 'bad-gg', 'site-gg', 'stop-gg', 'ok-gg'];
let VC;
async function setup() {
  if (VC) return VC;
  VC = await fakeVcenter();
  const base = { host: VC.host, timeoutMs: 5000 };
  const extra = {
    dis: { enabled: false }, maint: { maintenance: true }, site: { collectMode: 'site', remoteAgent: 'edge-a' },
    'site-pv': { collectMode: 'site', remoteAgent: 'edge-a' }, 'site-gg': { collectMode: 'site', remoteAgent: 'edge-a' },
  };
  const bad = (id) => /^(bad|stop)/.test(id);
  writeJson('vcenters.json', { vcenters: IDS.map((id) => ({ id: `vc-${id}`, name: id.toUpperCase(), username: `u-${id}`, password: bad(id) ? 'bad' : 'good', ...base, ...(extra[id] || {}) })) });
  const vms = [];
  for (const id of IDS) for (let n = 1; n <= 6; n++) vms.push(vmRow(`vc-${id}`, n));
  const { store } = await import('../src/store.js');
  // 작업 끝의 store.refresh()(프로비저닝·사양 변경 성공)가 등록 vCenter 전부를 실제로 수집하면 로그인 수와 스냅샷이 흔들린다 — 막는다.
  store.refresh = async () => store.get();
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [
      ...IDS.map((id) => ({ id: `vc-${id}`, name: id, status: 'connected' })),
      // WEB-05: 라이선스 결측 — vim25 의 used 는 선택 필드라 retrieveLicenses 가 null 을 싣는다(v2.727 C-02).
      { id: 'vc-lic1', name: 'LIC1', status: 'connected', licenses: [
        { name: 'vSphere 8 Ent', key: 'AAAAA-11111', total: 32, used: null },
        { name: 'vSphere 8 Ent', key: 'DDDDD-44444', total: 16, used: null },
        { name: 'vSAN', key: 'BBBBB-22222', total: null, used: null },
        { name: 'NSX', key: 'CCCCC-33333', total: 10, used: 4 },
      ] },
      { id: 'vc-lic2', name: 'LIC2', status: 'connected', licenses: [
        { name: 'vSphere 8 Ent', key: 'AAAAA-11111', total: 32, used: 20 },   // 같은 키(ELM) — 한 단위, 읽은 쪽 값이 이긴다
      ] },
      { id: 'vc-lic3', name: 'LIC3', status: 'connected', licenses: [
        { name: 'vSAN', key: 'EEEEE-55555', total: null, used: null },
      ] },
    ],
    vms, hosts: [], datastores: [], networks: [],
  };
  // vc-stop·vc-stop-rc·vc-stop-gg 는 주 폴러가 이미 자격증명 거부로 멈춘 상태(같은 정지 기록)
  const { noteVcAuthFailure } = await import('../src/vcenter/authStopGate.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  for (const id of ['vc-stop', 'vc-stop-rc', 'vc-stop-gg']) {
    const cfg = loadVcenterConfig().vcenters.find((v) => v.id === id);
    const e = new Error('Cannot complete login due to an incorrect user name or password.'); e.authFailed = true;
    assert.ok(noteVcAuthFailure(cfg, e), `사전 조건: ${id} 정지 기록이 생겨야 한다`);
  }
  return VC;
}
const cfgOf = async (id) => (await import('../src/config.js')).loadVcenterConfig().vcenters.find((v) => v.id === id);
const peekStop = async (id) => (await import('../src/vcenter/restClient.js')).vcAuthGuard.peekAuthStop(await cfgOf(id));

// ════════════════════════════ VC-03 ① Tools 업그레이드 ════════════════════════════
test('VC-03 ① Tools 업그레이드: 비활성·점검중·site 는 로그인 0 + 사유(blocked) · 인증 정지는 1회 시도 · 거부는 정지 기록', async () => {
  const vc = await setup();
  const { registerToolsInfo } = await import('../src/routes/api/toolsInfo.js');
  const post = await serve(registerToolsInfo, '/api', ADMIN);
  const ids = ['dis', 'maint', 'site'].map((id) => `vc-${id}:vm-1`);
  const r = await post('/vms/upgrade-tools', { ids });
  assert.equal(r.status, 200);
  assert.equal(r.body.succeeded, 0);
  for (const id of ['dis', 'maint', 'site']) assert.equal(vc.logins(`u-${id}`), 0, `vc-${id} 에 로그인하면 안 된다`);
  const why = Object.fromEntries((r.body.blocked || []).map((b) => [b.vcenterId, b.skipReason]));
  assert.deepEqual(why, { 'vc-dis': 'disabled', 'vc-maint': 'maintenance', 'vc-site': 'site' }, '막힌 vCenter 는 사유 코드와 함께 밝힌다');
  for (const row of r.body.results) assert.ok(row.error && row.skipReason, '행마다 사유를 싣는다');

  // 인증 정지 vCenter — 관리자가 누른 실행이라 1회 시도한다(정지를 이유로 막지 않는다).
  const s = await post('/vms/upgrade-tools', { ids: ['vc-stop:vm-1'] });
  assert.equal(vc.logins('u-stop'), 1, '인증 정지 중에도 수동 실행은 1회 시도');
  assert.ok(s.body.blocked?.[0]?.authStopped, '거부는 authStopped 로 밝힌다');

  // 처음 거부 — 주 폴러와 같은 정지 기록에 올라간다.
  const b = await post('/vms/upgrade-tools', { ids: ['vc-bad-up:vm-1', 'vc-bad-up:vm-2'] });
  assert.equal(vc.logins('u-bad-up'), 1);
  assert.ok(await peekStop('vc-bad-up'), '거부가 정지 기록에 올라가야 한다');
  assert.equal(b.body.blocked?.[0]?.vms, 2);

  // 직접 수집 vCenter 는 예전처럼 업그레이드한다.
  const before = vc.upgrades();
  const ok = await post('/vms/upgrade-tools', { ids: ['vc-ok:vm-1', 'vc-ok:vm-2'] });
  assert.equal(ok.body.succeeded, 2);
  assert.equal(ok.body.blocked, undefined, '막힌 것이 없으면 blocked 를 싣지 않는다(예전 응답 모양)');
  assert.equal(vc.upgrades() - before, 2);
});

// ════════════════════════════ VC-03 ② VM 하드웨어 조회·사양 변경 ════════════════════════════
test('VC-03 ② VM 하드웨어 조회: 비활성·점검중·site·인증 정지는 로그인 0 + 409 사유 · 거부는 기록 → 다음 조회 0회', async () => {
  const vc = await setup();
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const call = await serve(registerCollectorsDc, '/api/admin', ADMIN);
  const hw = (id) => call(`/vm/${encodeURIComponent(`vc-${id}:vm-1`)}/hardware`);
  for (const [id, why] of [['dis', 'disabled'], ['maint', 'maintenance'], ['site', 'site']]) {
    const before = vc.logins(`u-${id}`);
    const r = await hw(id);
    assert.equal(r.status, 409, `vc-${id} 는 409(502 는 웹이 재시도한다)`);
    assert.equal(r.body.skipReason, why);
    assert.ok(r.body.reason);
    assert.equal(vc.logins(`u-${id}`), before, `vc-${id} 에 로그인하면 안 된다`);
  }
  const stopBefore = vc.logins('u-stop');
  const s = await hw('stop');
  assert.equal(s.status, 409);
  assert.ok(s.body.authStopped?.attempts >= 1);
  assert.equal(vc.logins('u-stop'), stopBefore, '화면을 열 때 부르는 조회라 인증 정지 vCenter 에 로그인하지 않는다');

  const b1 = await hw('bad-hw');
  assert.equal(b1.status, 409);
  assert.ok(b1.body.authStopped);
  assert.equal(vc.logins('u-bad-hw'), 1);
  assert.ok(await peekStop('vc-bad-hw'));
  const b2 = await hw('bad-hw');
  assert.equal(b2.status, 409);
  assert.equal(vc.logins('u-bad-hw'), 1, '정지 뒤에는 로그인하지 않는다');

  const ok = await hw('ok');
  assert.equal(ok.status, 200, '직접 수집 vCenter 는 예전처럼 조회한다');
});

test('VC-03 ② VM 사양 변경: 비활성·site 는 로그인 0 + 409 · 인증 정지는 1회 시도 · 거부는 409 + 정지 기록', async () => {
  const vc = await setup();
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const call = await serve(registerCollectorsDc, '/api/admin', ADMIN);
  const rc = (id) => call(`/vm/${encodeURIComponent(`vc-${id}:vm-2`)}/reconfig`, { numCPUs: 4 });
  for (const [id, why] of [['dis', 'disabled'], ['site', 'site']]) {
    const before = vc.logins(`u-${id}`);
    const r = await rc(id);
    assert.equal(r.status, 409);
    assert.equal(r.body.skipReason, why);
    assert.equal(vc.logins(`u-${id}`), before, `vc-${id} 에 로그인하면 안 된다`);
  }
  const s = await rc('stop-rc');
  assert.equal(s.status, 409);
  assert.ok(s.body.authStopped);
  assert.equal(vc.logins('u-stop-rc'), 1, '관리자가 누른 쓰기 실행은 정지 중에도 1회 시도');
  const b = await rc('bad-rc');
  assert.equal(b.status, 409);
  assert.ok(b.body.authStopped);
  assert.equal(vc.logins('u-bad-rc'), 1);
  assert.ok(await peekStop('vc-bad-rc'), '거부가 정지 기록에 올라가야 한다');
});

// ════════════════════════════ VC-03 ③ 프로비저닝 ════════════════════════════
async function waitJob(id) {
  const { getJob } = await import('../src/provision/jobs.js');
  for (let i = 0; i < 200; i++) {
    const j = getJob(id);
    if (j && j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('작업이 끝나지 않았다');
}

test('VC-03 ③ 프로비저닝: site vCenter 는 작업을 만들지 않고 사유 · 틀린 비밀번호는 배치 전체에서 로그인 1회 + 정지 기록', async () => {
  const vc = await setup();
  const { createJob } = await import('../src/provision/jobs.js');
  const user = { user: { username: 'admin', role: 'admin' } };
  const site = createJob({ sourceId: 'vc-site-pv:vm-1', namePattern: 'new-{n}', count: 3, guest: { ipMode: 'dhcp' } }, user);
  assert.equal(site.ok, false);
  assert.equal(site.skipReason, 'site');
  assert.ok(site.reason);
  assert.equal(vc.logins('u-site-pv'), 0);

  // 6대 배치(동시성 4) — 틀린 비밀번호면 예전에는 VM 마다 로그인해 실패 로그인이 6회였다.
  const bad = createJob({ sourceId: 'vc-bad-pv:vm-1', namePattern: 'new-{n}', count: 6, guest: { ipMode: 'dhcp' } }, user);
  assert.equal(bad.ok, true);
  const j = await waitJob(bad.job.id);
  assert.equal(vc.logins('u-bad-pv'), 1, '배치는 로그인 한 번을 공유하고, 거부되면 남은 VM 은 다시 시도하지 않는다');
  assert.equal(j.failed, 6);
  for (const v of j.vms) assert.ok(v.error, '모든 VM 이 사유를 남긴다');
  assert.ok(await peekStop('vc-bad-pv'), '거부가 주 폴러와 같은 정지 기록에 올라간다');
});

test('VC-03 ③ 프로비저닝 로그인 공유: 동시 실행 VM 이 로그인 한 번을 기다린다(성공)', async () => {
  const vc = await setup();
  const { createProvisioner } = await import('../src/provision/vsphere.js');
  const prov = createProvisioner(await cfgOf('vc-ok'));
  const before = vc.logins('u-ok');
  // cloneOne 은 로그인 뒤 폴더 조회에서 실패한다(가짜 vCenter 는 빈 결과) — 로그인 횟수만 본다.
  await Promise.allSettled([1, 2, 3, 4].map((n) => prov.cloneOne({ id: `vc-ok:vm-${n}`, vcenterId: 'vc-ok', guestOS: '' }, { name: `x${n}` })));
  await prov.close();
  assert.equal(vc.logins('u-ok') - before, 1);
});

// ════════════════════════════ VC-03 ④ GPU 게스트 테스트 ════════════════════════════
test('VC-03 ④ GPU 게스트 테스트: site 는 로그인 0 + 409 · 인증 정지는 1회 시도 · 거부는 기록 · 행마다 사유', async () => {
  const vc = await setup();
  const { registerGpuGuest } = await import('../src/routes/admin/gpuGuest.js');
  const call = await serve(registerGpuGuest, '/api/admin', ADMIN);
  const items = (id) => [{ vmId: `vc-${id}:vm-1`, username: 'g', password: 'p' }, { vmId: `vc-${id}:vm-2`, username: 'g', password: 'p' }];
  const site = await call('/gpu-guest/test', { vcenterId: 'vc-site-gg', items: items('site-gg') });
  assert.equal(site.status, 409);
  assert.equal(site.body.skipReason, 'site');
  assert.equal(vc.logins('u-site-gg'), 0);
  assert.equal(site.body.results.length, 2, '화면이 행을 results 로 갱신한다 — 비면 행이 테스트 중으로 남는다');
  for (const row of site.body.results) assert.ok(row.error && row.login === false);

  const stop = await call('/gpu-guest/test', { vcenterId: 'vc-stop-gg', items: items('stop-gg') });
  assert.equal(stop.status, 409);
  assert.ok(stop.body.authStopped);
  assert.equal(vc.logins('u-stop-gg'), 1, '수동 테스트는 정지 중에도 1회 시도');

  const bad = await call('/gpu-guest/test', { vcenterId: 'vc-bad-gg', items: items('bad-gg') });
  assert.equal(bad.status, 409);
  assert.equal(vc.logins('u-bad-gg'), 1);
  assert.ok(await peekStop('vc-bad-gg'), '거부가 정지 기록에 올라가야 한다');

  // 직접 수집 vCenter 는 예전처럼 로그인한다(없는 VM 이라 행 단계에서 끝난다).
  const ok = await call('/gpu-guest/test', { vcenterId: 'vc-ok-gg', items: [{ vmId: 'vc-ok-gg:none', username: 'g', password: 'p' }] });
  assert.equal(ok.status, 200);
  assert.equal(vc.logins('u-ok-gg'), 1);
});

// ════════════════════════════ WEB-05 라이선스 롤업 ════════════════════════════
test('WEB-05 /tools/licenses: 결측 used·total 은 합계에 0 으로 더하지 않고 개수로 밝힌다 · 하나도 못 읽은 합은 null', async () => {
  await setup();
  const { registerToolsInfo } = await import('../src/routes/api/toolsInfo.js');
  const get = await serve(registerToolsInfo, '/api', ADMIN);
  const all = await get('/tools/licenses');
  assert.equal(all.status, 200);
  const by = Object.fromEntries(all.body.byLicense.map((b) => [b.name, b]));
  // 같은 키 AAAAA 는 한 단위 — 읽은 쪽(vc-lic2 의 20)을 쓴다. DDDDD 는 used 를 못 읽었다.
  assert.equal(by['vSphere 8 Ent'].total, 48);
  assert.equal(by['vSphere 8 Ent'].used, 20);
  assert.equal(by['vSphere 8 Ent'].usedUnknown, 1);
  assert.equal(by['vSphere 8 Ent'].totalUnknown, 0);
  assert.equal(by['vSphere 8 Ent'].duplicates, 1);
  // 두 단위 모두 못 읽었다 — 0 이 아니라 null.
  assert.equal(by.vSAN.used, null);
  assert.equal(by.vSAN.total, null);
  assert.equal(by.vSAN.usedUnknown, 2);
  assert.equal(by.vSAN.totalUnknown, 2);
  assert.equal(by.NSX.used, 4);
  assert.equal(by.NSX.usedUnknown, 0);
  assert.equal(all.body.totalAssigned, 24, '읽은 사용량의 합');
  assert.equal(all.body.usedUnknown, 3);
  assert.equal(all.body.totalUnknown, 2);
  // 항목(행)은 결측을 null 그대로 싣는다.
  assert.ok(all.body.items.some((l) => l.name === 'vSAN' && l.used === null && l.total === null));

  // 한 vCenter 를 고르면 그 vCenter 의 라이선스가 전부 결측 — 합은 0 이 아니라 null.
  const one = await get('/tools/licenses?vcenterId=vc-lic3');
  assert.equal(one.body.totalAssigned, null);
  assert.equal(one.body.usedUnknown, 1);
  // 라이선스가 0개인 vCenter 는 '할당 0' 이 맞다(null 로 만들지 않는다).
  const none = await get('/tools/licenses?vcenterId=vc-ok');
  assert.equal(none.body.totalAssigned, 0);
  assert.equal(none.body.usedUnknown, 0);
});

// ════════════════════════════ VC-03 소스 스윕(보조) ════════════════════════════
test('VC-03 스윕: 수동 vCenter 경로 4종은 바로 login() 하지 않고 주문형 로그인 문을 지난다', async () => {
  const { stripComments } = await import('./_stripComments.js');
  const { fileURLToPath } = await import('node:url');
  const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));
  for (const rel of ['provision/reconfig.js', 'provision/vsphere.js', 'routes/admin/gpuGuest.js']) {
    const src = read(rel);
    assert.equal((src.match(/\.login\(\)/g) || []).length, 0, `${rel} 에 바로 로그인하는 호출이 남았다`);
    assert.match(src, /onDemandLogin\(/, `${rel} 는 dsBrowse.js onDemandLogin 을 쓴다(판정 복제 금지)`);
  }
  assert.match(read('routes/api/toolsInfo.js'), /upgradeVmTools\([^\n]*login: \(c\) => onDemandLogin\(/, 'Tools 업그레이드는 로그인 문을 넘긴다');
  assert.match(read('provision/jobs.js'), /onDemandVcBlock\(/, '프로비저닝 작업은 시작 전에 막을 사유를 본다');
});
