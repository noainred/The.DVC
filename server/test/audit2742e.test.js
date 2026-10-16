/**
 * v2.742(점검 1회차 그룹 GE1) — vCenter 주문형 로그인 가드 · 같은 이름 클러스터 · 라이선스/확장 조회 실패.
 *
 * VC-03(재현): 데이터스토어 탐색·고아 VMDK 스캔·VM 내보내기 라이브 보강·게스트 계정 추가가 비활성·점검중·엣지 위임(site)·인증 정지
 *   vCenter 에도 로그인했고, 로그인 거부를 주 폴러의 정지 기록에 올리지 않았다. ⚠ 문자열이 아니라 **실제 로그인 시도 횟수**를 센다
 *   (가짜 vCenter — SOAP InvalidLogin). 판정은 collectTarget.js · authStopGate.js 하나다.
 * VC-05(재현): 같은 vCenter 의 다른 데이터센터에 같은 이름 클러스터가 있으면 (vCenter, 이름) 키로 한 행이 되어 HA 꺼짐이 숨고
 *   없는 'EVC 꺼짐·CPU 모델 혼재' 가 떴다. 클러스터 N+1 도 두 묶음 호스트를 합쳐 판정했다.
 * VC-06(재현): 라이선스·확장 조회 실패를 빈 배열로 실어 '라이선스 0개' 와 구분되지 않았다.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2742e-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

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

/** 가짜 vCenter — Login 은 password 'good' 만 통과(계정별로 센다). 속성 조회는 빈 결과. */
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
function upsertVcenters(list) {
  const f = path.join(DIR, 'vcenters.json');
  let cur = [];
  try { cur = JSON.parse(fs.readFileSync(f, 'utf8')).vcenters || []; } catch { /* 없음 */ }
  const ids = new Set(list.map((v) => v.id));
  writeJson('vcenters.json', { vcenters: [...cur.filter((v) => !ids.has(v.id)), ...list] });
}
async function seedSnapshot(patch) {
  const { store } = await import('../src/store.js');
  const cur = store.get() || {};
  store.snapshot = { ...cur, source: 'live', generatedAt: new Date().toISOString(), ...patch };
}
const dsRow = (vcId) => ({ id: `${vcId}:datastore-1`, vcenterId: vcId, name: `${vcId}-ds`, capacityGB: 100, freeGB: 50 });
const vmRow = (vcId) => ({ id: `${vcId}:vm-1`, vcenterId: vcId, name: `${vcId}-vm`, powerState: 'POWERED_ON', guestOS: 'Red Hat Enterprise Linux 9', host: 'h1' });

/** api 라우터 하나를 띄운다(req.user 를 고정). */
async function serve(register, user) {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = user; next(); });
  const api = express.Router();
  register(api);
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  return async (p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json().catch(() => null) }; };
}
const ADMIN = { username: 'admin', role: 'admin', scope: null };
const OPERATOR = { username: 'op', role: 'operator', scope: null };

// ════════════════════════════ VC-03 ════════════════════════════
let VC;   // 가짜 vCenter 한 대를 여러 등록 항목이 함께 쓴다(계정 이름으로 시도를 센다)
async function setupVcs() {
  if (VC) return VC;
  VC = await fakeVcenter();
  const base = { host: VC.host, timeoutMs: 5000 };
  upsertVcenters([
    { id: 'vc-ok', name: 'OK', username: 'u-ok', password: 'good', ...base },
    { id: 'vc-bad', name: 'BAD', username: 'u-bad', password: 'bad', ...base },
    { id: 'vc-bad2', name: 'BAD2', username: 'u-bad2', password: 'bad', ...base },
    { id: 'vc-dis', name: 'DIS', username: 'u-dis', password: 'good', enabled: false, ...base },
    { id: 'vc-maint', name: 'MAINT', username: 'u-maint', password: 'good', maintenance: true, ...base },
    { id: 'vc-site', name: 'SITE', username: 'u-site', password: 'good', collectMode: 'site', remoteAgent: 'edge-a', ...base },
    { id: 'vc-stop', name: 'STOP', username: 'u-stop', password: 'bad', ...base },
  ]);
  const ids = ['vc-ok', 'vc-bad', 'vc-bad2', 'vc-dis', 'vc-maint', 'vc-site', 'vc-stop'];
  await seedSnapshot({
    vcenters: ids.map((id) => ({ id, name: id, status: 'connected' })),
    datastores: ids.map(dsRow), vms: ids.map(vmRow), hosts: [],
  });
  // vc-stop 은 주 폴러가 이미 자격증명 거부로 멈춘 상태(같은 정지 기록)
  const { noteVcAuthFailure } = await import('../src/vcenter/authStopGate.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const stopCfg = loadVcenterConfig().vcenters.find((v) => v.id === 'vc-stop');
  const e = new Error('Cannot complete login due to an incorrect user name or password.'); e.authFailed = true;
  assert.ok(noteVcAuthFailure(stopCfg, e), '사전 조건: 정지 기록이 생겨야 한다');
  return VC;
}

test('VC-03 ① 데이터스토어 탐색: 비활성·점검중·site·인증 정지 vCenter 는 로그인 0회 + 409 사유 · 거부는 정지 기록 → 다음 탐색 0회', async () => {
  const vc = await setupVcs();
  const { browseDatastore } = await import('../src/vcenter/dsBrowse.js');
  for (const [id, why] of [['vc-dis', 'disabled'], ['vc-maint', 'maintenance'], ['vc-site', 'site']]) {
    await assert.rejects(browseDatastore(`${id}:datastore-1`), (e) => e.status === 409 && e.skipReason === why, `${id} 는 409 ${why}`);
    assert.equal(vc.logins(`u-${id.slice(3)}`), 0, `${id} 에 로그인하면 안 된다`);
  }
  await assert.rejects(browseDatastore('vc-stop:datastore-1'), (e) => e.status === 409 && !!e.authStopped && e.authStopped.attempts >= 1);
  assert.equal(vc.logins('u-stop'), 0, '인증 정지 vCenter 에 로그인하면 안 된다(주문형 조회 — v2.733 C3-01 과 같은 규칙)');

  // 거부된 로그인은 주 폴러와 같은 정지 기록에 올라가고, 다음 탐색은 로그인하지 않는다.
  await assert.rejects(browseDatastore('vc-bad:datastore-1'), (e) => e.status === 409 && !!e.authStopped);
  assert.equal(vc.logins('u-bad'), 1);
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  assert.ok(vcAuthGuard.peekAuthStop(loadVcenterConfig().vcenters.find((v) => v.id === 'vc-bad')), '거부가 정지 기록에 올라가야 한다');
  await assert.rejects(browseDatastore('vc-bad:datastore-1'), (e) => e.status === 409 && !!e.authStopped);
  assert.equal(vc.logins('u-bad'), 1, '정지 뒤에는 로그인하지 않는다');

  // 직접 수집 vCenter 는 예전처럼 동작한다.
  const r = await browseDatastore('vc-ok:datastore-1');
  assert.equal(r.mock, false);
  assert.equal(vc.logins('u-ok'), 1);
});

test('VC-03 ② 고아 VMDK 스캔: 파일 목록이 60초 캐시에서 왔어도 VM 소유 파일 로그인 앞에서 다시 본다(정지 중 로그인 0)', async () => {
  const vc = await setupVcs();
  const { browseDatastore } = await import('../src/vcenter/dsBrowse.js');
  const { scanOrphanDisks } = await import('../src/vcenter/orphanScan.js');
  // ①에서 채운 60초 캐시. 가짜 vCenter 는 데이터스토어 브라우저를 주지 않아 filesError 가 남는다 — 파일 목록을 '읽은' 상태로 바꿔
  //   (캐시가 들고 있는 같은 객체) 스캔이 VM 소유 파일 단계까지 가게 한다. 그 단계의 로그인 가드를 보려는 것이다.
  const cached = await browseDatastore('vc-ok:datastore-1');
  cached.filesError = ''; cached.files = [];
  const before = vc.logins('u-ok');
  // 그 사이 vc-ok 가 인증 정지가 됐다고 하자(주 폴러가 거부를 기록).
  const { noteVcAuthFailure } = await import('../src/vcenter/authStopGate.js');
  const { loadVcenterConfig } = await import('../src/config.js');
  const okCfg = loadVcenterConfig().vcenters.find((v) => v.id === 'vc-ok');
  const e = new Error('Cannot complete login due to an incorrect user name or password.'); e.authFailed = true;
  noteVcAuthFailure(okCfg, e);
  await assert.rejects(scanOrphanDisks('vc-ok:datastore-1', { recentHours: 7 }), (err) => err.status === 409 && !!err.authStopped);
  assert.equal(vc.logins('u-ok'), before, '캐시에서 온 파일 목록 뒤의 VM 소유 파일 조회도 로그인하지 않는다');
  // 비활성 vCenter 는 파일 목록 단계에서 이미 막힌다.
  await assert.rejects(scanOrphanDisks('vc-dis:datastore-1', { recentHours: 7 }), (err) => err.status === 409 && err.skipReason === 'disabled');
  assert.equal(vc.logins('u-dis'), 0);
});

test('VC-03 ③ VM 내보내기: 막힌 vCenter 는 라이브 보강을 하지 않고 사유를 싣는다 · 거부는 정지 기록 · 막힌 결과는 기억하지 않는다', async () => {
  const vc = await setupVcs();
  const { buildVmExport } = await import('../src/vcenter/vmExport.js');
  const dis = await buildVmExport('vc-site');
  assert.equal(dis.enriched, false);
  assert.deepEqual(dis.enrichBlocked, { skipReason: 'site' });
  assert.equal(dis.total, 1, '내보내기 자체는 스냅샷 필드로 계속한다');
  assert.equal(vc.logins('u-site'), 0);
  const stop = await buildVmExport('vc-stop');
  assert.ok(stop.enrichBlocked?.authStopped, '정지 vCenter 는 authStopped');
  assert.equal(vc.logins('u-stop'), 0);
  const bad = await buildVmExport('vc-bad2');
  assert.ok(bad.enrichBlocked?.authStopped, '거부된 로그인은 정지 기록에 올라가 authStopped 로 밝힌다');
  assert.equal(vc.logins('u-bad2'), 1);
  const again = await buildVmExport('vc-bad2');   // 막힌 결과는 캐시하지 않는다 → 다시 판정 → 정지라 로그인 0
  assert.ok(again.enrichBlocked?.authStopped);
  assert.equal(vc.logins('u-bad2'), 1);
});

test('VC-03 ④ 게스트 계정 추가: 비활성·site 는 로그인 전 409 · 인증 정지는 수동 작업이라 1회 시도하고 그 사실을 말한다', async () => {
  const vc = await setupVcs();
  const { addUsersToVms } = await import('../src/guest/accountService.js');
  const args = (vcenterId) => ({ vcenterId, vmIds: [`${vcenterId}:vm-1`], username: 'newu', password: 'Passw0rd!' });
  await assert.rejects(addUsersToVms(args('vc-dis')), (e) => e.status === 409 && e.skipReason === 'disabled');
  await assert.rejects(addUsersToVms(args('vc-maint')), (e) => e.status === 409 && e.skipReason === 'maintenance');
  assert.equal(vc.logins('u-dis'), 0);
  assert.equal(vc.logins('u-maint'), 0);
  await assert.rejects(addUsersToVms(args('vc-stop')), (e) => e.status === 409 && /이미 멈춰 있던/.test(e.message) && !!e.authStopped);
  assert.equal(vc.logins('u-stop'), 1, '관리자가 누른 수동 작업은 정지 중에도 1회 시도한다(authGuard 규칙 3)');
});

test('VC-03 ⑤ 데이터스토어 탐색 라우트: 막힌 vCenter 는 502 가 아니라 409 + 사유 필드', async () => {
  const vc = await setupVcs();
  const { registerInventory } = await import('../src/routes/api/inventory.js');
  const get = await serve(registerInventory, ADMIN);
  const before = vc.logins('u-maint') + vc.logins('u-stop');
  const r = await get('/datastores/' + encodeURIComponent('vc-maint:datastore-1') + '/browse');
  assert.equal(r.status, 409);
  assert.equal(r.body.skipReason, 'maintenance');
  assert.ok(r.body.error);
  const s = await get('/datastores/' + encodeURIComponent('vc-stop:datastore-1') + '/browse');
  assert.equal(s.status, 409);
  assert.ok(s.body.authStopped?.attempts >= 1);
  assert.equal(vc.logins('u-maint') + vc.logins('u-stop'), before, '라우트도 로그인하지 않는다');
});

// ════════════════════════════ VC-05 ════════════════════════════
const host = (id, cluster, ref, dc, cpuModel, extra = {}) => ({
  id, vcenterId: 'vc', name: id, cluster, clusterRef: ref, vcDatacenter: dc, cpuModel, connectionState: 'CONNECTED',
  cpuTotalMhz: 10000, cpuUsageMhz: 2000, memTotalMB: 100000, memUsageMB: 20000, ...extra,
});
const cfgOf = (ref, haOn) => ({ name: 'Prod', ref, at: 1, ha: { enabled: haOn, admission: true, hostMon: 'enabled' }, drs: { enabled: true, behavior: 'fullyAutomated' }, evc: '', numHosts: 2, numEffectiveHosts: 2, rules: [], rulesTotal: 0 });

test('VC-05 ① 클러스터 점검: 다른 데이터센터의 같은 이름 클러스터는 ref 로 따로 판정한다(HA 꺼짐이 숨지 않고 없는 CPU 혼재가 뜨지 않는다)', async () => {
  const { analyzeClusters } = await import('../src/clustercfg/analyze.js');
  const hosts = [
    host('a1', 'Prod', 'domain-c1', 'DC-Seoul', 'Intel Gold 6338'), host('a2', 'Prod', 'domain-c1', 'DC-Seoul', 'Intel Gold 6338'),
    host('b1', 'Prod', 'domain-c2', 'DC-Busan', 'AMD EPYC 7763'), host('b2', 'Prod', 'domain-c2', 'DC-Busan', 'AMD EPYC 7763'),
  ];
  const r = analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgOf('domain-c1', true), cfgOf('domain-c2', false)] }], hosts);
  assert.equal(r.rows.length, 2, '같은 이름 두 클러스터는 두 행');
  const byRef = Object.fromEntries(r.rows.map((x) => [x.ref, x]));
  assert.equal(byRef['domain-c1'].vcDatacenter, 'DC-Seoul');
  assert.equal(byRef['domain-c2'].vcDatacenter, 'DC-Busan');
  assert.equal(byRef['domain-c1'].hosts, 2);
  assert.equal(byRef['domain-c2'].hosts, 2);
  assert.ok(byRef['domain-c2'].findings.some((f) => f.code === 'ha-off'), 'HA 꺼진 클러스터가 보여야 한다');
  assert.ok(!byRef['domain-c1'].findings.some((f) => f.code === 'ha-off'));
  for (const row of r.rows) assert.ok(!row.findings.some((f) => f.code === 'evc-off-mixed'), '두 묶음을 합친 없는 CPU 혼재 금지');
  assert.equal(byRef['domain-c1'].sameName, 2, '같은 이름 행 수 — 화면이 데이터센터를 함께 보인다');
});

test('VC-05 ② 구버전 엣지 스냅샷(clusterRef 없음): 이름 키로 떨어지고, 이름이 겹친 구성은 합치지 않는다(호스트는 모름으로)', async () => {
  const { analyzeClusters, clusterRefMode } = await import('../src/clustercfg/analyze.js');
  const old = [host('a1', 'Prod', undefined, undefined, 'X'), host('a2', 'Prod', undefined, undefined, 'X')].map((h) => { delete h.clusterRef; delete h.vcDatacenter; return h; });
  assert.equal(clusterRefMode(old).get('vc'), false);
  const one = analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgOf('domain-c1', true)] }], old);
  assert.equal(one.rows.length, 1, '구성이 하나면 예전처럼 이름으로 붙는다');
  assert.equal(one.rows[0].hosts, 2);
  const two = analyzeClusters([{ id: 'vc', name: 'VC', clusterCfg: [cfgOf('domain-c1', true), cfgOf('domain-c2', false)] }], old);
  assert.equal(two.rows.length, 2, '이름이 같은 구성 둘은 합치지 않는다');
  for (const row of two.rows) { assert.equal(row.hosts, null); assert.equal(row.nameCollision, 2); assert.equal(row.hostsAmbiguous, 2); }
  assert.equal(two.coverage.hostsAmbiguous, 2);
  assert.ok(two.rows.some((x) => x.findings.some((f) => f.code === 'ha-off')), '덮어쓰기로 HA 꺼짐이 사라지지 않는다');
});

test('VC-05 ③ 상세 창 clusterOf: 호스트·VM 의 ref 로 고르고, ref 없이 이름이 겹치면 고르지 않는다', async () => {
  const { clusterOf } = await import('../src/clustercfg/analyze.js');
  const vcs = [{ id: 'vc', clusterCfg: [cfgOf('domain-c1', true), cfgOf('domain-c2', false)] }];
  const hosts = [host('a1', 'Prod', 'domain-c1', 'DC-Seoul', 'X'), host('b1', 'Prod', 'domain-c2', 'DC-Busan', 'X')];
  const byHost = clusterOf(vcs, hosts, 'vc', 'Prod', null, { hostId: 'b1' });
  assert.equal(byHost.cluster.ref, 'domain-c2');
  assert.equal(byHost.cluster.hosts, 1);
  assert.ok(byHost.findings.some((f) => f.code === 'ha-off'));
  const byVm = clusterOf(vcs, hosts, 'vc', 'Prod', 'vc:vm-9', { vms: [{ id: 'vc:vm-9', vcenterId: 'vc', clusterRef: 'domain-c1' }] });
  assert.equal(byVm.cluster.ref, 'domain-c1');
  const amb = clusterOf(vcs, hosts, 'vc', 'Prod');
  assert.equal(amb.cluster, null);
  assert.equal(amb.reason, 'ambiguous');
  assert.equal(amb.candidates, 2);
  // 이름이 하나뿐이면 예전처럼 이름으로(ref 를 모르는 옛 호출부)
  const solo = clusterOf([{ id: 'vc', clusterCfg: [cfgOf('domain-c1', true)] }], hosts.slice(0, 1), 'vc', 'prod');
  assert.equal(solo.cluster.ref, 'domain-c1');
});

test('VC-05 ④ 클러스터 N+1(/tools/insights): 같은 이름 다른 데이터센터 클러스터를 한 그룹으로 합치지 않는다', async () => {
  const hosts = [
    host('a1', 'Prod', 'domain-c1', 'DC-Seoul', 'X'), host('a2', 'Prod', 'domain-c1', 'DC-Seoul', 'X'),
    // 부산 쪽은 거의 꽉 찬 2대 — 합치면 서울 여유에 묻혀 '여유' 로 보인다
    host('b1', 'Prod', 'domain-c2', 'DC-Busan', 'X', { cpuUsageMhz: 9000 }), host('b2', 'Prod', 'domain-c2', 'DC-Busan', 'X', { cpuUsageMhz: 9000 }),
  ];
  await seedSnapshot({ vcenters: [{ id: 'vc', name: 'VC', status: 'connected' }], hosts, vms: [], datastores: [], alarms: [] });
  const { registerToolsAnalytics } = await import('../src/routes/api/toolsAnalytics.js');
  const get = await serve(registerToolsAnalytics, ADMIN);
  const r = await get('/tools/insights?vcenterId=vc');
  assert.equal(r.status, 200);
  const cl = r.body.clusters.filter((c) => c.vcenterId === 'vc');
  assert.equal(cl.length, 2, '두 클러스터');
  const busan = cl.find((c) => c.clusterRef === 'domain-c2');
  assert.equal(busan.vcDatacenter, 'DC-Busan');
  assert.equal(busan.hosts, 2);
  assert.equal(busan.n1Ok, false, '부산 클러스터는 1대 장애를 견디지 못한다');
  assert.equal(cl.find((c) => c.clusterRef === 'domain-c1').n1Ok, true);
  assert.equal(busan.sameName, 2);
});

test('VC-05 ④-b 상세 창 라우트(/tools/cluster-check/of): hostId·clusterRef 로 고르고 CSV 에 데이터센터를 싣는다', async () => {
  const hosts = [host('a1', 'Prod', 'domain-c1', 'DC-Seoul', 'X'), host('b1', 'Prod', 'domain-c2', 'DC-Busan', 'X')];
  await seedSnapshot({ vcenters: [{ id: 'vc', name: 'VC', status: 'connected', clusterCfg: [cfgOf('domain-c1', true), cfgOf('domain-c2', false)] }], hosts, vms: [], datastores: [], alarms: [] });
  const { registerClusterCheck } = await import('../src/routes/api/clusterCheck.js');
  const get = await serve(registerClusterCheck, ADMIN);
  const byHost = await get('/tools/cluster-check/of?vcenterId=vc&cluster=Prod&hostId=b1');
  assert.equal(byHost.status, 200);
  assert.equal(byHost.body.cluster.ref, 'domain-c2');
  const byRef = await get('/tools/cluster-check/of?vcenterId=vc&cluster=Prod&clusterRef=domain-c1');
  assert.equal(byRef.body.cluster.ref, 'domain-c1');
  const amb = await get('/tools/cluster-check/of?vcenterId=vc&cluster=Prod');
  assert.equal(amb.body.reason, 'ambiguous');
});

test('VC-05 ⑤ 수집기 소스: 호스트에 clusterRef·vcDatacenter, VM 에 clusterRef 를 싣고 Datacenter 이름을 같은 조회로 받는다', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'vcenter', 'soapClient.js'), 'utf8'));
  assert.match(src, /type: 'ClusterComputeResource', paths: \['name', 'parent'\]/);
  assert.match(src, /type: 'Datacenter', paths: \['name'\]/);
  assert.match(src, /'ResourcePool', 'Datacenter',/);
  assert.match(src, /clusterRef: clusterName\.has\(p\.parent\) \? p\.parent : null/);
  assert.match(src, /clusterRef: host\?\.clusterRef \?\? null/);
});

// ════════════════════════════ VC-06 ════════════════════════════
test('VC-06 ① 판정 한 벌: 배열이면 읽음(빈 배열 = 0개) · 실패 사유가 있으면 failed · 그 밖은 vCenter 상태', async () => {
  const { vcListUnread, vcListItems, LIST_UNREAD_TEXT } = await import('../src/corelicense/analyze.js');
  assert.equal(vcListUnread({ licenses: [] }, 'licenses'), null);
  assert.deepEqual(vcListUnread({ licenses: null, licensesError: 'NoPermission' }, 'licenses'), { why: 'failed', error: 'NoPermission' });
  assert.equal(vcListUnread({ status: 'unreachable' }, 'licenses').why, 'unreachable');
  assert.equal(vcListUnread({ status: 'connected' }, 'solutions').why, 'not-read');
  assert.equal(vcListUnread({ status: 'connected', solutions: 'x' }, 'solutions').why, 'not-read', '배열이 아니면 읽은 것이 아니다');
  assert.deepEqual(vcListItems({ licenses: [null, 'ab', { name: 'L' }, [1]] }, 'licenses'), [{ name: 'L' }]);
  for (const t of Object.values(LIST_UNREAD_TEXT)) assert.doesNotMatch(t, /[`*]/);
});

test('VC-06 ② 라이선스 현황·만료 확인·솔루션 버전·코어 라이선스: 조회 실패 vCenter 는 0개가 아니라 확인 불가로 말한다', async () => {
  await seedSnapshot({
    vcenters: [
      { id: 'vc-l-ok', name: 'LOK', status: 'connected', licenses: [{ name: 'vSphere 8 Enterprise Plus', key: 'K1', total: 32, used: 16, costUnit: 'cpuPackage', expires: '' }], solutions: [{ key: 'com.vmware.vsan', version: '8.0', label: 'vSAN' }] },
      { id: 'vc-l-fail', name: 'LFAIL', status: 'connected', licenses: null, licensesError: 'NoPermission 10.0.0.9', solutions: null, solutionsError: 'NoPermission' },
    ],
    hosts: [], vms: [], datastores: [],
  });
  const { registerToolsInfo } = await import('../src/routes/api/toolsInfo.js');
  const { registerVcTools } = await import('../src/routes/api/vcTools.js');
  const getA = await serve((api) => { registerToolsInfo(api); registerVcTools(api); }, ADMIN);
  const getO = await serve((api) => { registerToolsInfo(api); registerVcTools(api); }, OPERATOR);

  const lic = await getA('/tools/licenses');
  assert.equal(lic.status, 200);
  assert.equal(lic.body.partial, true);
  const u = lic.body.unread.find((x) => x.vcenterId === 'vc-l-fail');
  assert.equal(u.why, 'failed');
  assert.equal(u.error, 'NoPermission 10.0.0.9', '관리자에게는 사유 원문');
  assert.ok(!lic.body.unread.some((x) => x.vcenterId === 'vc-l-ok'), '읽은 vCenter 는 unread 가 아니다');
  const licO = await getO('/tools/licenses');
  assert.equal(licO.body.unread.find((x) => x.vcenterId === 'vc-l-fail').error, undefined, '운영자에게는 사유 원문(주소)을 싣지 않는다');

  const exp = await getA('/tools/license-expiry');
  assert.equal(exp.status, 200);
  assert.ok(exp.body.collectionErrors.some((l) => l.includes('LFAIL') && l.includes('확인 불가')), "만료 '없음' 이 아니라 수집 실패 줄로 밝힌다");
  assert.equal(exp.body.vcenterLicensesUnread.find((x) => x.vcenterId === 'vc-l-fail').why, 'failed');

  const sol = await getA('/tools/solutions');
  assert.equal(sol.status, 200);
  const items = sol.body.items || sol.body.vcenters || [];
  const fail = items.find((x) => x.vcenterId === 'vc-l-fail');
  assert.equal(fail.solutionsUnread.why, 'failed');
  assert.ok(items.find((x) => x.vcenterId === 'vc-l-ok').solutionsUnread === null);
  assert.equal(sol.body.solutionsUnread, 1);

  const { analyzeCoreLicense } = await import('../src/corelicense/analyze.js');
  const { store } = await import('../src/store.js');
  const core = analyzeCoreLicense(store.get());
  const rows = core.rows || core.vcenters || [];
  assert.equal(rows.find((x) => x.vcenterId === 'vc-l-fail').licensesUnread, 'failed');
  assert.equal(rows.find((x) => x.vcenterId === 'vc-l-ok').licensesUnread, null);
  assert.equal(core.totals.licensesUnread, 1);
});

test('VC-06 ③ 수집기 소스: 라이선스·확장 조회 실패를 빈 배열로 싣지 않는다(null + 사유)', () => {
  const src = stripComments(fs.readFileSync(path.join(SRC, 'vcenter', 'soapClient.js'), 'utf8'));
  assert.match(src, /const licenses = licRes\.status === 'fulfilled' \? licRes\.value\.slice\(0, 200\) : null;/);
  assert.match(src, /const solutions = solRes\.status === 'fulfilled' \? solRes\.value\.slice\(0, 300\) : null;/);
  assert.match(src, /licensesError: listErr\(licRes\)/);
  assert.doesNotMatch(src, /licRes\.value\.slice\(0, 200\) : \[\]/);
});
