/**
 * test/audit2744rf.test.js — v2.744(세 번 반복 3회차) 회귀 검토 RF 그룹.
 *
 * GF-R1: 낭비 리소스 엑셀 내보내기(/tools/waste/export)의 근거 리포트 배치가 직접 수집 대상 판정(vcSkipOf)과
 *   인증 정지 문(createVcAuthGate)을 거치지 않아, 단건 /tools/rightsize 가 409 로 막는 vCenter(점검중·엣지 위임·비활성)와
 *   인증 정지 vCenter 에 내보내기마다 로그인했다(VC-04 형제 경로 누락). 거부도 정지 기록에 오르지 않았다.
 * GG-R1: /tools/threats 의 '신규 rogue IP' 판정이 IP 대장(ipam/ledger.js hostLedgerIp)과 달리 h.name 만 봐서, FQDN 호스트의
 *   관리 IP 를 IP 대장은 ESXi 호스트로·위협 화면은 'vCenter 가 모르는 rogue IP' 로 말했다.
 * GG-R3: /tools/ipam(·시트) 응답이 호스트 행 owner 로 스냅샷 호스트 객체 통째(hcfg·NIC MAC·HBA·serviceTag)를 실어
 *   inv.hosts 없이 tools 만 가진 역할에도 나갔고 응답이 커졌다.
 *
 * ⚠ GF-R1 은 문자열이 아니라 **가짜 vCenter 의 실제 로그인 수**로 판정한다(audit2744f VC-04 와 같은 하니스 — 실제 api 라우터).
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createRequire } from 'node:module';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2744rf-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter 가 127.0.0.1 에 산다 — 이 테스트 전용
process.env.AUTH_ENABLED = 'true';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));
// viewer = tools 만(inv.hosts·inv.vms 없음) — GG-R3 의 권한 경계를 재현한다.
fs.writeFileSync(path.join(DIR, 'permissions.json'), JSON.stringify({
  schemaVersion: 3,
  matrix: { operator: ['dashboard', 'tools', 'inv.hosts', 'inv.vms'], viewer: ['dashboard', 'tools'], toolsDenied: { operator: [], viewer: [] } },
}));

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

/** 가짜 vCenter — bad=false 면 로그인 통과(문이 막지 않으면 로그인이 실제로 센다), bad=true 면 InvalidLogin. 로그인 뒤 호출은 NotSupported. */
async function fakeVcenter({ bad = false } = {}) {
  const st = { logins: 0 };
  const srv = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const send = (code, xml) => { res.writeHead(code, { 'content-type': 'text/xml' }); res.end(xml); };
    if (req.url === '/sdk') {
      if (body.includes('<RetrieveServiceContent')) return send(200, SC_XML);
      if (body.includes('<Login ')) {
        st.logins += 1;
        if (bad) return send(500, FAULT('InvalidLogin', 'Cannot complete login due to an incorrect user name or password.'));
        return send(200, ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s1</key><userName>u</userName></returnval></LoginResponse>'));
      }
      if (body.includes('<Logout ')) return send(200, ENV('<LogoutResponse xmlns="urn:vim25"></LogoutResponse>'));
      return send(500, FAULT('NotSupported', 'not supported in this fake'));
    }
    if (req.url === '/api/session') { st.logins += 1; res.writeHead(bad ? 401 : 201, { 'content-type': 'application/json' }); return res.end(bad ? '{}' : '"tok"'); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return { host: `http://127.0.0.1:${srv.address().port}`, st };
}

// 과할당 VM(32 vCPU · 사용률 1%) — /tools/waste 의 CPU·메모리 과할당 목록에 들어가 근거 리포트 대상이 된다.
const vmsOf = (vc) => Array.from({ length: 4 }, (_, i) => ({ id: `${vc}:vm-${i + 1}`, vcenterId: vc, name: `${vc}-g${i + 1}`, powerState: 'POWERED_ON',
  host: `${vc}-h1`, cluster: 'C1', cpuCount: 32, memMB: 262144, cpuUsagePct: 1, memUsagePct: 1, cpuUsageMhz: 50, guestMemUsageMB: 1000, storageGB: 100, ipAddresses: [] }));
const hostsOf = (vc) => [1, 2].map((i) => ({ id: `${vc}:host-${i}`, vcenterId: vc, name: `${vc}-h${i}`, cluster: 'C1', connectionState: 'CONNECTED',
  cpuCores: 32, cpuTotalMhz: 80000, cpuUsageMhz: 2000, memTotalMB: 524288, memUsageMB: 20000 }));

// GG — FQDN 호스트(관리 IP 10.20.0.11) + 보안 구성·MAC·HBA·서비스태그(목록 응답에 실리면 안 되는 값).
const FQDN_HOST = { id: 'vc-n:host-9', vcenterId: 'vc-n', name: 'esx01.corp.local', mgmtIp: '10.20.0.11', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.2', cluster: 'C9', serviceTag: 'SVCTAG-RF1', hcfg: { sshEnabled: true, ntpServers: ['ntp.rf.example'] },
  nics: [{ device: 'vmnic0', mac: '00:50:56:rf:aa:01' }], hbas: [{ device: 'vmhba1', wwpn: '50:00:00:00:00:00:rf:01' }] };
const IPNAME_HOST = { id: 'vc-n:host-8', vcenterId: 'vc-n', name: '10.20.0.12', connectionState: 'CONNECTED', powerState: 'POWERED_ON', version: '8.0.2', cluster: 'C9',
  serviceTag: 'SVCTAG-RF2', hcfg: { sshEnabled: false } };
const SECRET_PATTERN = /SVCTAG-RF|00:50:56:rf|50:00:00:00:00:00:rf|ntp\.rf\.example|"hcfg"|"hbas"|"serviceTag"/;

let base; let VC; let store;
const ALL_VC = ['vc-m', 'vc-s', 'vc-o', 'vc-a', 'vc-g', 'vc-b'];
before(async () => {
  VC = { m: await fakeVcenter(), s: await fakeVcenter(), o: await fakeVcenter(), a: await fakeVcenter(), g: await fakeVcenter(), b: await fakeVcenter({ bad: true }) };
  const reg = [
    { id: 'vc-m', name: 'VC-M', host: VC.m.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, maintenance: true, timeoutMs: 5000 },
    { id: 'vc-s', name: 'VC-S', host: VC.s.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, collectMode: 'site', remoteAgent: 'edge1', timeoutMs: 5000 },
    { id: 'vc-o', name: 'VC-O', host: VC.o.host, username: 'administrator@vsphere.local', password: 'good', enabled: false, timeoutMs: 5000 },
    { id: 'vc-a', name: 'VC-A', host: VC.a.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
    { id: 'vc-g', name: 'VC-G', host: VC.g.host, username: 'administrator@vsphere.local', password: 'good', enabled: true, timeoutMs: 5000 },
    { id: 'vc-b', name: 'VC-B', host: VC.b.host, username: 'administrator@vsphere.local', password: 'wrong', enabled: true, timeoutMs: 5000 },
  ];
  fs.writeFileSync(path.join(DIR, 'vcenters.json'), JSON.stringify({ vcenters: reg }));
  ({ store } = await import('../src/store.js'));
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date().toISOString(),
    vcenters: [...ALL_VC, 'vc-n'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
    hosts: [...ALL_VC.flatMap(hostsOf), FQDN_HOST, IPNAME_HOST],
    vms: [...ALL_VC.flatMap(vmsOf), { id: 'vc-n:vm-1', vcenterId: 'vc-n', name: 'app1', powerState: 'POWERED_ON', host: 'esx01.corp.local', cluster: 'C9', ipAddresses: ['10.20.0.50'], guestOS: 'Ubuntu' }],
    datastores: [], networks: [], alarms: [],
  };
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  vcAuthGuard.markAuthStopped('vc-a', reg.find((x) => x.id === 'vc-a'), 'InvalidLogin (test)');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const role = req.get('x-role') || 'admin'; req.user = { username: role === 'admin' ? 'adm' : 'tl', role, scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const logins = () => Object.fromEntries(Object.entries(VC).map(([k, v]) => [k, v.st.logins]));
const JSZip = createRequire(createRequire(import.meta.url).resolve('exceljs'))('jszip');
/** 내보내기 ZIP → xlsx 안의 모든 문자열(시트·공유 문자열). */
async function exportText(vcId) {
  const r = await fetch(`${base}/api/tools/waste/export?vcenterId=${vcId}&days=7`);
  assert.equal(r.status, 200, `${vcId} export ${r.status}`);
  const zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  const xName = Object.keys(zip.files).find((n) => n.endsWith('.xlsx'));
  const x = await JSZip.loadAsync(await zip.file(xName).async('nodebuffer'));
  let txt = '';
  for (const n of Object.keys(x.files)) if (/^xl\/(sharedStrings|worksheets\/.*)\.xml$/.test(n)) txt += await x.file(n).async('string');
  return { txt, reports: Object.keys(zip.files).filter((n) => n.startsWith('reports/')).length };
}

// ─────────────────────────────── GF-R1 ───────────────────────────────
test('GF-R1 ① 직접 수집 대상 아님(점검중·엣지 위임·비활성)·인증 정지 vCenter: 엑셀 내보내기의 근거 리포트 배치가 로그인 0 · 시트에 사유(조회 실패 아님)', async () => {
  const cases = [['vc-m', '점검중 vCenter'], ['vc-s', '엣지 위임 vCenter'], ['vc-o', '비활성 vCenter'], ['vc-a', '인증 실패로 멈춰 있어']];
  for (const [id, why] of cases) {
    const before = logins();
    // 단건 리포트는 이미 409(v2.744 VC-04) — 내보내기도 같은 판정이어야 한다.
    const single = await fetch(`${base}/api/tools/rightsize?vmId=${encodeURIComponent(`${id}:vm-1`)}&days=7`);
    assert.equal(single.status, 409, `${id} 단건 리포트 ${single.status}`);
    const { txt, reports } = await exportText(id);
    assert.deepEqual(logins(), before, `${id} 내보내기가 vCenter 에 로그인했다 ${JSON.stringify(before)} → ${JSON.stringify(logins())}`);
    assert.equal(reports, 0, `${id} 조회하지 않았는데 리포트 파일이 생겼다`);
    assert.ok(txt.includes(why), `${id} 시트에 사유(${why})가 없다`);
    assert.ok(!txt.includes('조회 실패:'), `${id} 조회하지 않은 VM 을 '조회 실패' 로 적었다`);
    assert.match(txt, /조회하지 않음 \d+건/, `${id} 요약에 '조회하지 않음' 개수가 없다`);
    // 리드 통합(wasteExport reportCells): 조회하지 않은 VM 의 '근거 리포트' 칸은 상한 생략과 가른다.
    assert.ok(txt.includes('리포트 없음(조회하지 않음)'), `${id} 근거 리포트 칸이 조회하지 않음을 말하지 않는다`);
    assert.ok(!txt.includes('리포트 없음(상한)'), `${id} 조회하지 않은 VM 을 '상한' 생략으로 적었다`);
  }
  assert.equal(VC.m.st.logins + VC.s.st.logins + VC.o.st.logins + VC.a.st.logins, 0);
});

test('GF-R1 ② 직접 수집 대상은 문이 막지 않는다 · 자격증명 거부는 주 폴러와 같은 기록에 올라 다음 내보내기는 로그인 0', async () => {
  const { vcAuthGuard } = await import('../src/vcenter/restClient.js');
  // 맞는 비밀번호 vCenter — 로그인 1회(그 뒤 조회는 가짜가 NotSupported → 조회 실패로 적힌다. 그것은 실제 실패다).
  const g0 = VC.g.st.logins;
  const g = await exportText('vc-g');
  assert.equal(VC.g.st.logins - g0, 1, '직접 수집 대상 vCenter 는 vCenter 당 1회 로그인한다(문이 막으면 안 된다)');
  assert.ok(g.txt.includes('조회 실패:'), '가짜의 NotSupported 는 실제 조회 실패다');
  // 틀린 비밀번호 vCenter — 첫 내보내기에서 InvalidLogin 1회 → 정지 기록. 둘째 내보내기는 로그인하지 않는다.
  assert.equal(vcAuthGuard.peekAuthStop({ id: 'vc-b', host: VC.b.host, username: 'administrator@vsphere.local', password: 'wrong' }), null, '전제: 아직 정지 기록 없음');
  const b0 = VC.b.st.logins;
  const b1 = await exportText('vc-b');
  assert.equal(VC.b.st.logins - b0, 1, '거부는 vCenter 당 첫 시도 1회만');
  assert.ok(b1.txt.includes('vCenter 인증 실패'), '거부 사유가 시트에 남는다');
  const reg = JSON.parse(fs.readFileSync(path.join(DIR, 'vcenters.json'), 'utf8')).vcenters.find((x) => x.id === 'vc-b');
  assert.ok(vcAuthGuard.peekAuthStop(reg), '거부가 주 폴러와 같은 정지 기록에 올랐다(noteVcAuthFailure)');
  const b2 = await exportText('vc-b');
  assert.equal(VC.b.st.logins - b0, 1, '정지된 vCenter 에 다시 로그인했다 — 내보내기를 누를 때마다 실패 로그인이 쌓이는 계정 잠금 경로');
  assert.ok(b2.txt.includes('인증 실패로 멈춰 있어'), '둘째 내보내기는 정지 사유로 적는다');
});

// ─────────────────────────────── GG-R1 ───────────────────────────────
test('GG-R1 FQDN ESXi 의 관리 IP: IP 대장은 호스트 행 · 위협 화면 rogue 목록에는 없다(판정 한 벌 — hostLedgerIp)', async () => {
  const ss = await import('../src/ipam/scanStore.js');
  ss.mergeScanResults([
    { ip: '10.20.0.11', openPorts: [443, 902], services: ['https'], hostname: '' },   // FQDN 호스트의 관리 IP
    { ip: '10.20.0.12', openPorts: [443], services: ['https'], hostname: '' },        // 이름이 IP 인 호스트
    { ip: '10.20.0.99', openPorts: [22], services: ['ssh'], hostname: 'rogue1' },     // vCenter 가 모르는 IP
  ], Date.now() - 60_000, '__local__');
  const led = await (await fetch(`${base}/api/tools/ipam`)).json();
  const row = (led.rows || []).find((r) => r.ip === '10.20.0.11');
  assert.equal(row?.ownerType, 'host', 'IP 대장은 관리 IP 를 그 호스트 행으로 보인다');
  const th = await (await fetch(`${base}/api/tools/threats`)).json();
  const rogueIps = (th.rogue || []).map((r) => r.ip);
  assert.ok(!rogueIps.includes('10.20.0.11'), `IP 대장이 ESXi 호스트라 말하는 IP 를 rogue 로 셌다: ${rogueIps}`);
  assert.ok(!rogueIps.includes('10.20.0.12'), '이름이 IP 인 호스트도 rogue 가 아니다(예전 규칙 그대로)');
  assert.ok(rogueIps.includes('10.20.0.99'), '정말 모르는 IP 는 rogue 로 남는다(판정이 통째로 꺼지지 않았다)');
  // 소스 고정: 형제 판정을 다시 h.name 으로 되돌리지 않게.
  const src = fs.readFileSync(new URL('../src/routes/api/toolsAnalytics.js', import.meta.url), 'utf8');
  assert.match(src, /import \{ hostLedgerIp \} from '\.\.\/\.\.\/ipam\/ledger\.js'/);
  assert.doesNotMatch(src, /known\.add\(h\.name\)/);
});

// ─────────────────────────────── GG-R3 ───────────────────────────────
test('GG-R3 /tools/ipam·시트의 호스트 행은 owner 본문이 없다 — tools 만 가진 역할(/hosts 403)에게 hcfg·MAC·HBA·serviceTag 가 나가지 않는다', async () => {
  const H = { 'x-role': 'viewer' };
  assert.equal((await fetch(`${base}/api/hosts`, { headers: H })).status, 403, '전제: 이 역할은 호스트 목록을 볼 수 없다');
  const r = await fetch(`${base}/api/tools/ipam`, { headers: { ...H, 'accept-encoding': 'identity' } });
  assert.equal(r.status, 200);
  const txt = await r.text();
  assert.doesNotMatch(txt, SECRET_PATTERN, '목록 응답에 호스트 보안 구성·식별자가 실렸다');
  const rows = JSON.parse(txt).rows || [];
  const hostRows = rows.filter((x) => x.ownerType === 'host');
  assert.ok(hostRows.length >= 2, '전제: 호스트 행이 있다');
  for (const h of hostRows) {
    assert.equal('owner' in h, false, `${h.ip} 호스트 행에 owner 가 남았다`);
    assert.equal(h.hasOwner, true);
    assert.ok(h.ownerId && h.ownerName, '지연 조회용 id·이름은 싣는다');
  }
  const fq = hostRows.find((x) => x.ip === '10.20.0.11');
  assert.equal(fq.ownerId, 'vc-n:host-9'); assert.equal(fq.ownerName, 'esx01.corp.local');
  // 크기 회귀: 호스트 행 하나가 스냅샷 객체만큼 커지지 않는다(행 필드만 — 1KB 미만).
  for (const h of hostRows) assert.ok(JSON.stringify(h).length < 1024, `${h.ip} 호스트 행 ${JSON.stringify(h).length}B`);
  // VM 행은 예전 그대로 hasOwner(v2.253).
  const vmRow = rows.find((x) => x.ip === '10.20.0.50');
  assert.equal(vmRow?.ownerType, 'vm'); assert.equal('owner' in vmRow, false); assert.equal(vmRow.hasOwner, true);
  // 서브넷 시트도 같은 경계.
  const s = await fetch(`${base}/api/tools/ipam/sheet?base=10.20.0`, { headers: { ...H, 'accept-encoding': 'identity' } });
  assert.equal(s.status, 200);
  const stxt = await s.text();
  assert.doesNotMatch(stxt, SECRET_PATTERN, '시트 응답에 호스트 보안 구성·식별자가 실렸다');
  const sh = (JSON.parse(stxt).rows || []).filter((x) => x.ownerType === 'host');
  assert.ok(sh.length >= 2 && sh.every((x) => x.owner == null && x.hasOwner === true && x.ownerId), '시트 호스트 칸도 hasOwner·ownerId 만');
  // 상세 지연 조회 경로: inv.hosts 가 있는 역할은 /hosts?vcenterId=&q= 로 그 호스트를 받는다(화면 pickHostOwner 와 같은 모양 — items·id).
  const lk = await (await fetch(`${base}/api/hosts?vcenterId=vc-n&q=${encodeURIComponent('esx01.corp.local')}`, { headers: { 'x-role': 'operator' } })).json();
  assert.ok((lk.items || []).some((h) => h.id === fq.ownerId && h.serviceTag === 'SVCTAG-RF1'), '권한 있는 역할의 상세는 예전처럼 전체 객체');
});
