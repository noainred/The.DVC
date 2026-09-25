// v2.610 — iDRAC 스캔 모듈에 HPE iLO 계정을 더해 한 번의 대역 스캔이 Dell 과 HPE 를 함께 찾는다(사용자 요청).
// 핵심 불변조건: ① 서비스 루트(무인증)로 벤더를 먼저 가르고 **그 벤더의 계정으로만** 로그인한다(HPE 에 Dell 계정이
// 가지 않는다 — 실패 로그인 누적 = 계정 잠금) ② HPE 는 iLO 계정으로 등록된다 ③ iLO 계정이 없어도 HPE 대수는 센다.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ilo2610-'));
process.env.CONFIG_DIR = tmp;

let redfish, registry, sr, jobs;
const servers = [];
before(async () => {
  redfish = await import('../src/idrac/redfish.js');
  registry = await import('../src/idrac/registry.js');
  sr = await import('../src/idrac/scanRanges.js');
  jobs = await import('../src/central/idracScanJobs.js');
});
after(() => { for (const s of servers) s.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

/** 가짜 Redfish 서버 — 서비스 루트(무인증) + Systems(Basic 인증). 로그인 시도한 계정을 기록한다. */
function fakeBmc({ vendor, username: user, password: pass }) {
  const logins = [];
  const root = vendor === 'hpe'
    ? { RedfishVersion: '1.13.0', Oem: { Hpe: { Manager: [{ ManagerType: 'iLO 5' }] } }, Product: 'ProLiant DL380 Gen10' }
    : { RedfishVersion: '1.11.0', Vendor: 'Dell', Oem: { Dell: {} }, Product: 'Integrated Dell Remote Access Controller' };
  const srv = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '');
    if (req.url === '/redfish/v1' || req.url === '/redfish/v1/') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(root)); }
    if (auth.startsWith('Basic ')) logins.push(Buffer.from(auth.slice(6), 'base64').toString());
    const ok = auth === `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    if (!ok) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":{"message":"bad"}}'); }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/redfish/v1/Systems') return res.end(JSON.stringify({ Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] }));
    if (req.url === '/redfish/v1/Systems/1') return res.end(JSON.stringify(vendor === 'hpe'
      ? { Manufacturer: 'HPE', Model: 'ProLiant DL380 Gen10', SerialNumber: 'SYNTHHPE01', HostName: 'hpe-01' }
      : { Manufacturer: 'Dell Inc.', Model: 'PowerEdge R750', SKU: 'SYNTHDL1', HostName: 'dell-01' }));
    res.statusCode = 404; res.end('{}');
  });
  servers.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${srv.address().port}`, logins })));
}

const DELL = { username: 'root', password: 'dellpw' };
const ILO = { username: 'Administrator', password: 'ilopw' };
const credsFor = (kind) => (kind === 'hpe' ? ILO : DELL);

test('HPE 는 iLO 계정으로만 로그인한다 — Dell 계정이 iLO 로 가지 않는다', async () => {
  const hpe = await fakeBmc({ vendor: 'hpe', ...ILO });
  const r = await redfish.probeIdrac(hpe.url, DELL.username, DELL.password, 3000, { credsFor });
  assert.equal(r.ok, true);
  assert.equal(r.vendor, 'hpe');
  assert.equal(r.credSet, 'ilo');
  assert.equal(r.authFailed, false);
  assert.equal(r.serviceTag, 'SYNTHHPE01');
  assert.ok(hpe.logins.length > 0);
  assert.ok(hpe.logins.every((l) => l === 'Administrator:ilopw'), `iLO 에 보낸 계정: ${hpe.logins.join(',')}`);
});

test('Dell 은 iDRAC 계정으로만 로그인한다', async () => {
  const dell = await fakeBmc({ vendor: 'dell', ...DELL });
  const r = await redfish.probeIdrac(dell.url, DELL.username, DELL.password, 3000, { credsFor });
  assert.equal(r.isIdrac, true);
  assert.equal(r.credSet, 'idrac');
  assert.ok(dell.logins.every((l) => l === 'root:dellpw'));
});

test('그 벤더 계정이 없으면 로그인하지 않고 noCreds 로 돌려준다(인증 실패가 아니다)', async () => {
  const hpe = await fakeBmc({ vendor: 'hpe', ...ILO });
  const r = await redfish.probeIdrac(hpe.url, DELL.username, DELL.password, 3000, { credsFor: (k) => (k === 'hpe' ? null : DELL) });
  assert.equal(r.noCreds, true);
  assert.equal(r.authFailed, false);
  assert.equal(r.vendor, 'hpe');
  assert.equal(hpe.logins.length, 0, '계정이 없으면 한 번도 로그인하지 않는다');
});

test('iLO 비밀번호가 틀리면 authFailed + 문구가 iLO 를 말한다', async () => {
  const hpe = await fakeBmc({ vendor: 'hpe', ...ILO });
  const r = await redfish.probeIdrac(hpe.url, DELL.username, DELL.password, 3000, { credsFor: (k) => (k === 'hpe' ? { username: 'Administrator', password: 'wrong' } : DELL) });
  assert.equal(r.authFailed, true);
  assert.equal(r.credSet, 'ilo');
  assert.match(r.authHint, /iLO/);
});

test('credsFor 없이 부르면 예전 동작 그대로(credSet 빈 값)', async () => {
  const dell = await fakeBmc({ vendor: 'dell', ...DELL });
  const r = await redfish.probeIdrac(dell.url, DELL.username, DELL.password, 3000);
  assert.equal(r.isIdrac, true);
  assert.equal(r.credSet, '');
});

test('registerScanned: HPE 는 iLO 계정·vendor=hpe 로, Dell 은 iDRAC 계정으로 등록된다', () => {
  const found = [
    { ip: '10.9.0.11', vendor: 'dell', serviceTag: 'SYNTHDL1', hostName: 'dell-01' },
    { ip: '10.9.0.12', vendor: 'hpe', credSet: 'ilo', serviceTag: 'SYNTHHPE01', hostName: 'hpe-01' },
  ];
  const r = registry.registerScanned(found, 'root', 'dellpw', 'merge', '', 'DC1', { ilo: ILO });
  assert.equal(r.ok, true);
  const list = registry.loadRegistry();
  const d = list.find((s) => s.id === '10.9.0.11');
  const h = list.find((s) => s.id === '10.9.0.12');
  assert.equal(d.username, 'root'); assert.equal(d.password, 'dellpw'); assert.equal(d.vendor, undefined);
  assert.equal(h.username, 'Administrator'); assert.equal(h.password, 'ilopw'); assert.equal(h.vendor, 'hpe');
  assert.equal(registry.isHpeEntry(h), true);
  assert.equal(registry.isHpeEntry(d), false);
});

test('registerScanned: iLO 계정이 없는데 HPE 항목이 오면 등록하지 않고 개수를 밝힌다', () => {
  const r = registry.registerScanned([{ ip: '10.9.0.21', vendor: 'hpe' }, { ip: '10.9.0.22', vendor: 'dell' }], 'root', 'pw', 'merge', '', 'DC1');
  assert.equal(r.ok, true);
  assert.equal(r.skippedNoCreds, 1);
  assert.ok(!registry.loadRegistry().some((s) => s.id === '10.9.0.21'));
});

test('scanRanges: iLO 계정 저장·마스킹·유지·실행 엔트리·iLO 만 있는 대역 허용', () => {
  const r = sr.saveScanRanges({ datacenterId: 'DC1', ranges: '10.9.1.0/28', username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw' });
  assert.equal(r.ok, true);
  assert.equal(r.iloUsername, 'Administrator');
  assert.equal(r.iloHasPassword, true);
  assert.ok(!JSON.stringify(sr.listScanRanges()).includes('ilopw'), '목록에 iLO 비밀번호 평문 없음');
  // 빈 iLO 비밀번호는 기존 유지
  sr.saveScanRanges({ id: r.id, datacenterId: 'DC1', iloUsername: 'Administrator', iloPassword: '' });
  assert.equal(sr.getScanRangeRaw(r.id).ilo.password, 'ilopw');
  const rt = sr.enabledScanRanges().find((e) => e.id === r.id);
  assert.deepEqual(rt.ilo, { username: 'Administrator', password: 'ilopw' });
  // iLO 계정만 있는 대역도 스캔 대상이다(Dell 계정 없음)
  const only = sr.saveScanRanges({ datacenterId: 'DC2', ranges: '10.9.2.0/28', username: '', iloUsername: 'Administrator', iloPassword: 'ilopw' });
  const rt2 = sr.enabledScanRanges().find((e) => e.id === only.id);
  assert.ok(rt2, 'iLO 만 있어도 enabledScanRanges 에 포함');
  assert.equal(rt2.username, '');
  // 계정을 비우면 iLO 비밀번호도 버린다
  sr.saveScanRanges({ id: r.id, datacenterId: 'DC1', iloUsername: '' });
  assert.deepEqual(sr.getScanRangeRaw(r.id).ilo, { username: '', password: '' });
});

test('scanRanges: 대역이 바뀌면 저장 iLO 비밀번호도 승계하지 않는다(secretCarry 규약)', () => {
  const r = sr.saveScanRanges({ datacenterId: 'DC3', ranges: '10.9.3.0/28', username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw' });
  const r2 = sr.saveScanRanges({ id: r.id, datacenterId: 'DC3', ranges: '10.9.4.0/28' });
  assert.ok(r2.droppedSecrets.includes('iloPassword'));
  assert.equal(sr.getScanRangeRaw(r.id).ilo.password, '');
  assert.ok(r2.skipped.some((s) => s.field === 'iloPassword'));
});

test('scanRanges: 저장 파일에서 iLO 비밀번호는 암호화 모드면 봉인된다(중첩 password 필드)', () => {
  const raw = fs.readFileSync(path.join(tmp, 'idrac-scan-ranges.json'), 'utf8');
  // 평문 모드(기본)에서는 평문이 남는 것이 기존 관례(idrac.json 과 같다) — 여기서는 필드 이름이 password 라
  // secretVault 의 봉인 대상이라는 사실만 고정한다(이름을 바꾸면 암호화 모드에서 평문이 된다).
  const j = JSON.parse(raw);
  const e = Object.values(j.entries).find((x) => x.ilo && x.ilo.username);
  assert.ok(e && Object.prototype.hasOwnProperty.call(e.ilo, 'password'));
});

test('위임 잡: iLO 계정이 잡에 실리고 엣지 인출 응답에 포함된다', () => {
  const id = jobs.enqueueIdracScan('edgeA', { ips: '10.9.5.0/29', username: 'root', password: 'dellpw', ilo: ILO, datacenterId: 'DC5' });
  assert.ok(id);
  const out = jobs.takeIdracScanJobs ? jobs.takeIdracScanJobs('edgeA') : null;
  if (out) {
    const j = out.find((x) => x.reqId === id);
    assert.deepEqual(j.ilo, ILO);
  }
});

test('hpeCountsOf: 새 엣지는 hpeDetected, 구버전 엣지는 미지원 목록 vendor=hpe 로 하한', () => {
  assert.deepEqual(jobs.hpeCountsOf({ hpeDetected: 3, hpeFound: 2, iloEnabled: true }), { hpeFound: 2, iloEnabled: true, hpeDetected: 3, hpeDetectedApprox: false });
  const old = jobs.hpeCountsOf({ unsupported: [{ vendor: 'hpe' }, { vendor: 'lenovo' }, { vendor: 'hpe' }], unsupportedCount: 250 });
  assert.equal(old.hpeDetected, 2);
  assert.equal(old.hpeDetectedApprox, true, '목록이 잘렸으면 하한');
  assert.equal(jobs.hpeCountsOf({ hpeDetected: 'x' }).hpeDetected, 0);
});
