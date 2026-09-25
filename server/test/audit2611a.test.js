// v2.611 감사 그룹 A — iDRAC/iLO 스캔 체인(v2.610 회귀) 확정분의 회귀 고정.
//   SEC2611-01 iLO 계정은 HPE 에만 · RECENT2611-01 noCreds·인증실패는 replace 를 merge 로 강등 · RECENT2611-02 폐기 안내 ·
//   RECENT2611-04 noCreds 표시 · CEN2611-01 위임 회신 정제 · EDGE2611-01·02·03 엣지 버전 게이트·구버전 회신 ·
//   SEC2611-02 단건 비정규 IP · RECENT2611-06 CSV vendor · COL2611-01 HPE 서비스태그 · COL2611-02·03 팬 %·Absent 온도.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611a-'));
process.env.CONFIG_DIR = tmp;
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

let scan, redfish, registry, sr, jobs, push, iprange, scanLog, poller;
const servers = [];
before(async () => {
  scan = await import('../src/idrac/scan.js');
  redfish = await import('../src/idrac/redfish.js');
  registry = await import('../src/idrac/registry.js');
  sr = await import('../src/idrac/scanRanges.js');
  jobs = await import('../src/central/idracScanJobs.js');
  push = await import('../src/central/idracScanPush.js');
  iprange = await import('../src/idrac/iprange.js');
  scanLog = await import('../src/idrac/scanLog.js');
  poller = await import('../src/idrac/scanPoller.js');
});
after(() => { for (const s of servers) s.close(); try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ } });

function serve(handler) {
  const srv = http.createServer(handler);
  servers.push(srv);
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
}
const json = (res, o, code = 200) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };

const DELL = { username: 'root', password: 'dellpw' };
const ILO = { username: 'Administrator', password: 'ilopw' };

// ── SEC2611-01 ────────────────────────────────────────────────────────────
test('SEC2611-01: iLO 계정은 HPE 에만 — unknown·Lenovo 에는 Dell 계정(없으면 null)', () => {
  const onlyIlo = scan.makeScanCredsFor(null, ILO);
  assert.deepEqual(onlyIlo('hpe'), ILO);
  assert.equal(onlyIlo('unknown'), null, 'iLO 전용 대역: 벤더 미상에 iLO 계정을 보내지 않는다');
  assert.equal(onlyIlo('lenovo'), null);
  assert.equal(onlyIlo('dell'), null);
  const both = scan.makeScanCredsFor(DELL, ILO);
  assert.deepEqual(both('unknown'), DELL, 'Dell+iLO 대역: 벤더 미상은 예전처럼 Dell 계정');
  assert.deepEqual(both('hpe'), ILO);
  assert.equal(scan.makeScanCredsFor(DELL, null), null, 'iLO 없으면 credsFor 없음(예전 동작)');
});

test('SEC2611-01: iLO 전용 대역의 Lenovo BMC 에는 한 번도 로그인하지 않는다(소켓 확인)', async () => {
  const auths = [];
  const url = await serve((req, res) => {
    if (req.headers.authorization) auths.push(req.headers.authorization);
    if (req.url === '/redfish/v1' || req.url === '/redfish/v1/') return json(res, { RedfishVersion: '1.8', Oem: { Lenovo: {} }, Product: 'XClarity Controller' });
    if (req.method === 'POST') auths.push('session-post');
    return json(res, {}, 401);
  });
  const r = await redfish.probeIdrac(url, '', '', 3000, { credsFor: scan.makeScanCredsFor(null, ILO) });
  assert.equal(r.noCreds, true);
  assert.equal(auths.length, 0, `로그인 시도: ${auths.join(',')}`);
});

// ── RECENT2611-01 ─────────────────────────────────────────────────────────
test('RECENT2611-01: 부분 결과 사유 — noCreds·인증 실패·(iLO 없이) 등록된 HPE 는 replace 를 막는다', () => {
  assert.deepEqual(scan.scanPartialReasons({ noCreds: 0, authFailed: 0 }), []);
  assert.ok(scan.scanPartialReasons({ noCreds: 3 }).some((x) => /계정이 없어/.test(x)));
  assert.ok(scan.scanPartialReasons({ authFailed: 1 }).some((x) => /인증 실패/.test(x)), '인증 실패 서버가 replace 로 지워지지 않게');
  assert.ok(scan.scanPartialReasons({ iloEnabled: false }, { registeredHpe: true }).length > 0);
  assert.deepEqual(scan.scanPartialReasons({ iloEnabled: true }, { registeredHpe: true }), []);
  assert.ok(scan.scanPartialReasons({ authSkipped: 2 }).length > 0, 'v2.591 규칙 유지');
  // 중앙·엣지 두 경로가 같은 판정을 쓴다(한쪽만 고치면 형제 비대칭).
  assert.match(read('idrac/scanPoller.js'), /scanPartialReasons\(r, \{ registeredHpe: hasHpeInDatacenter\(e\.datacenterId\) \}\)/);
  assert.match(read('idrac/localScan.js'), /scanPartialReasons\(scan, \{ registeredHpe: hasHpeInDatacenter\(datacenterId\) \}\)/);
});

test('RECENT2611-01: hasHpeInDatacenter — 그 법인의 HPE 등록만 본다', () => {
  registry.importServers([
    { id: '10.21.0.1', name: 'h1', host: '10.21.0.1', username: 'a', password: 'b', datacenterId: 'DCH', vendor: 'hpe' },
    { id: '10.21.0.2', name: 'd1', host: '10.21.0.2', username: 'a', password: 'b', datacenterId: 'DCD' },
  ], 'merge');
  assert.equal(registry.hasHpeInDatacenter('DCH'), true);
  assert.equal(registry.hasHpeInDatacenter('DCD'), false);
  assert.equal(registry.hasHpeInDatacenter(''), false);
});

// ── RECENT2611-02 ─────────────────────────────────────────────────────────
test('RECENT2611-02: Dell 비밀번호가 폐기돼도 iLO 가 남으면 "HPE(iLO) 스캔은 계속" 이라고 말한다', () => {
  const r = sr.saveScanRanges({ datacenterId: 'DCR2', ranges: '10.22.0.0/30', username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw' });
  const r2 = sr.saveScanRanges({ id: r.id, datacenterId: 'DCR2', ranges: '10.22.1.0/30', iloPassword: 'newilo' });
  assert.deepEqual(r2.droppedSecrets, ['password']);
  const why = r2.skipped.find((x) => x.field === 'password').reason;
  assert.match(why, /HPE\(iLO\) 스캔은 계속/);
  assert.doesNotMatch(why, /이 항목의 스캔은 보류/);
  assert.match(sr.scanHoldText({ username: '', password: '', ilo: { username: '', password: '' } }), /이 항목의 스캔은 보류/);
});

// ── RECENT2611-04 · CEN2611-01 · EDGE2611-02 ──────────────────────────────
test('RECENT2611-04: 스캔 로그가 noCreds 를 싣는다(옛 기록은 null)', () => {
  assert.equal(scanLog.appendIdracScanLog({ noCreds: 4 }).noCreds, 4);
  assert.equal(scanLog.appendIdracScanLog({}).noCreds, null);
});

test('CEN2611-01: 신버전 엣지 회신의 HPE 대수·iloEnabled·noCreds·vendor/credSet 이 정제에서 사라지지 않는다', () => {
  const e = sr.saveScanRanges({ datacenterId: 'DCC1', ranges: '10.23.0.0/29', username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw', agent: 'edgeC' });
  const reqId = jobs.enqueueIdracScan('edgeC', { ips: '10.23.0.0/29', username: 'root', password: 'dellpw', ilo: ILO, datacenterId: 'DCC1' });
  sr.recordScanRangeRun(e.id, { delegated: true, reqId, pending: true });
  jobs.setIdracScanResult(reqId, {
    scanned: 6, foundCount: 2, iloEnabled: true, hpeFound: 1, hpeDetected: 3, hpeAuthFailed: 1, dellFound: 1, noCreds: 2,
    noCredsIps: [{ ip: '10.23.0.5', vendor: 'dell' }, 'bogus-not-object', { ip: { x: 1 } }], noCredsTruncated: false,
    found: [{ ip: '10.23.0.2', vendor: 'hpe', credSet: 'ilo', serviceTag: 'SN1' }, { ip: '10.23.0.3', vendor: 'evil', credSet: 'x' }],
  });
  const lr = sr.getScanRangeRaw(e.id).lastRun;
  assert.equal(lr.hpeDetected, 3);
  assert.equal(lr.hpeFound, 1);
  assert.equal(lr.iloEnabled, true);
  assert.equal(lr.noCreds, 2);
  assert.equal(lr.iloIgnoredByEdge, undefined, '신버전 회신은 구버전 판정을 받지 않는다');
  const res = jobs.getIdracScanResult(reqId);
  assert.equal(res.noCreds, 2);
  assert.equal(res.dellFound, 1);
  assert.equal(res.found[0].vendor, 'hpe');
  assert.equal(res.found[0].credSet, 'ilo');
  assert.equal(res.found[1].vendor, undefined, '모르는 vendor 는 버린다');
  assert.equal(res.found[1].credSet, undefined);
  assert.equal(res.noCredsIps.length, 2);
  assert.ok(res.noCredsIps.every((x) => typeof x.ip === 'string'));
  const san = jobs.sanitizeIdracScanData({ noCredsIps: Array.from({ length: 500 }, (_, i) => ({ ip: `10.0.${i >> 8}.${i & 255}` })) });
  assert.equal(san.noCredsIps.length, 200, '상한 200');
});

test('EDGE2611-02: iLO 를 보냈는데 회신에 iloEnabled 필드가 없으면(구버전 엣지) iloIgnoredByEdge', () => {
  const e = sr.saveScanRanges({ datacenterId: 'DCE2', ranges: '10.24.0.0/29', username: 'root', password: 'dellpw', iloUsername: 'Administrator', iloPassword: 'ilopw', agent: 'edgeOld' });
  const reqId = jobs.enqueueIdracScan('edgeOld', { ips: '10.24.0.0/29', username: 'root', password: 'dellpw', ilo: ILO, datacenterId: 'DCE2' });
  sr.recordScanRangeRun(e.id, { delegated: true, reqId, pending: true });
  jobs.setIdracScanResult(reqId, { scanned: 6, foundCount: 1, found: [{ ip: '10.24.0.2' }], unsupported: [{ ip: '10.24.0.3', vendor: 'hpe' }], unsupportedCount: 1 });
  const lr = sr.getScanRangeRaw(e.id).lastRun;
  assert.equal(lr.iloIgnoredByEdge, true);
  assert.equal(lr.hpeDetected, 1, '구버전 회신은 미지원 목록 폴백(하한)이 돈다 — null 을 0 으로 읽지 않는다');
  assert.equal(jobs.getIdracScanResult(reqId).iloIgnoredByEdge, true);
  // iLO 를 보내지 않은 잡은 대상이 아니다
  const r2 = jobs.enqueueIdracScan('edgeOld', { ips: '10.24.1.0/29', username: 'root', password: 'dellpw', datacenterId: 'DCE2' });
  jobs.setIdracScanResult(r2, { scanned: 6, foundCount: 0, found: [] });
  assert.equal(jobs.getIdracScanResult(r2).iloIgnoredByEdge, undefined);
});

test('hpeCountsOf: 정제본의 null(필드 없음)을 0 으로 읽지 않고 폴백한다', () => {
  const san = jobs.sanitizeIdracScanData({ unsupported: [{ ip: '10.0.0.1', vendor: 'hpe' }, { ip: '10.0.0.2', vendor: 'hpe' }], unsupportedCount: 2 });
  assert.equal(san.hpeDetected, null);
  assert.equal(jobs.hpeCountsOf(san).hpeDetected, 2);
});

// ── EDGE2611-01·03 ────────────────────────────────────────────────────────
test('EDGE2611-01: 엣지 버전 게이트(순수)', () => {
  const g = push.iloEdgeGate;
  assert.deepEqual(g({ hasDell: true, hasIlo: false, version: '' }), { delegate: true });
  assert.equal(g({ hasDell: false, hasIlo: true, version: '' }).delegate, false, 'iLO 전용 + 버전 미상 → 보류');
  assert.equal(g({ hasDell: false, hasIlo: true, version: '2.609.3' }).delegate, false, 'iLO 전용 + 구버전 → 보류');
  assert.equal(g({ hasDell: false, hasIlo: true, version: '2.610.0' }).delegate, true);
  const old = g({ hasDell: true, hasIlo: true, version: '2.609.0' });
  assert.equal(old.delegate, true);
  assert.equal(old.iloIgnored, true);
  assert.match(old.note, /2\.610/);
  assert.equal(g({ hasDell: true, hasIlo: true, version: '' }).iloIgnored, undefined, '미상이면 단정하지 않는다');
  assert.doesNotMatch(g({ hasDell: false, hasIlo: true }).reason, /\*\*|`/, '로그로 흐르는 문구에 마크다운 금지');
});

test('EDGE2611-01: iLO 전용 대역은 버전 미상 엣지에 위임하지 않고 lastRun 에 보류 사유를 남긴다', async () => {
  const e = sr.saveScanRanges({ datacenterId: 'DCG', ranges: '10.25.0.0/30', username: '', iloUsername: 'Administrator', iloPassword: 'ilopw', agent: 'edgeUnknownVer' });
  const r = await poller.runIdracScanOnce({ id: e.id, manual: true });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].held, true);
  assert.equal(r.results[0].delegated, false);
  const lr = sr.getScanRangeRaw(e.id).lastRun;
  assert.equal(lr.held, true);
  assert.match(lr.heldReason, /2\.610/);
  assert.ok(!jobs.listIdracScanJobs().some((j) => j.agent === 'edgeUnknownVer'), '잡을 적재하지 않았다');
  // push 경로도 같은 게이트를 쓴다(수동 PUSH 대비)
  assert.match(read('central/idracScanPush.js'), /const gate = iloEdgeGate\(\{ hasDell, hasIlo, version: edgeVersionOf\(agent\) \}\);\s*\n\s*if \(!gate\.delegate\) return/);
  // 비-2xx 도 본문의 reason 을 읽는다
  assert.match(read('central/idracScanPush.js'), /readJsonCapped\(r, 65_536, '엣지 오류 응답'\)/);
});

// ── SEC2611-02 ────────────────────────────────────────────────────────────
test('SEC2611-02: 단건 비정규 IP(선행 0)는 거부 — 범위·CIDR 출력은 그대로', () => {
  const r = iprange.expandIpList('010.0.0.5\n10.0.0.7');
  assert.deepEqual(r.ips, ['10.0.0.7']);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /010\.0\.0\.5/);
  assert.deepEqual(iprange.expandIpList('010.0.0.4/30').ips, ['10.0.0.5', '10.0.0.6']);
  assert.deepEqual(iprange.expandIpList('10.0.0.1-3').ips, ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
});

// ── RECENT2611-06 ─────────────────────────────────────────────────────────
test('RECENT2611-06: CSV vendor 열 — hpe 만 인정, replace 가져오기가 HPE 표시를 지우지 않는다', () => {
  const rows = registry.parseCsv('name,host,username,password,vendor\nh,10.26.0.1,a,b,HPE\nd,10.26.0.2,a,b,dell\n');
  assert.equal(rows[0].vendor, 'hpe');
  assert.equal(rows[1].vendor, '');
  assert.equal('vendor' in registry.parseCsv('name,host,username,password\nx,10.26.0.3,a,b\n')[0], false, '열이 없으면 필드도 없다(merge 가 기존 값을 유지)');
  registry.importServers(rows, 'replace');
  assert.equal(registry.isHpeEntry(registry.loadRegistry().find((s) => s.id === 'h')), true);
  assert.doesNotMatch(read('idrac/registry.js'), /폴러는 이 값으로 Dell 전용 경로\(라이선스·텔레메트리·racadm\)를 건너뛴다\.$/m, '사실이 아닌 주석을 되살리지 않는다');
});

// ── COL2611-01 ────────────────────────────────────────────────────────────
test('COL2611-01: HPE 는 SerialNumber, Dell 은 SKU(서비스태그)', () => {
  assert.equal(redfish.systemServiceTag({ Manufacturer: 'HPE', SKU: '867959-B21', SerialNumber: 'MXQ1' }), 'MXQ1');
  assert.equal(redfish.systemServiceTag({ Manufacturer: 'HP', SKU: '867959-B21', SerialNumber: 'MXQ2' }), 'MXQ2');
  assert.equal(redfish.systemServiceTag({ Manufacturer: 'Hewlett Packard Enterprise', SKU: 'X', SerialNumber: 'MXQ3' }), 'MXQ3');
  assert.equal(redfish.systemServiceTag({ SKU: 'X', SerialNumber: 'MXQ4' }, 'hpe'), 'MXQ4', '등록부 vendor=hpe');
  assert.equal(redfish.systemServiceTag({ Manufacturer: 'Dell Inc.', SKU: 'ABC1234', SerialNumber: 'CN0XYZ' }), 'ABC1234');
  assert.equal(redfish.systemServiceTag({ Manufacturer: 'HPE', SKU: 'X' }), 'X', '시리얼이 없으면 SKU');
});

test('COL2611-01: probeIdrac 가 HPE 의 시리얼을 서비스태그로 준다', async () => {
  const url = await serve((req, res) => {
    if (req.url === '/redfish/v1' || req.url === '/redfish/v1/') return json(res, { RedfishVersion: '1.13', Oem: { Hpe: {} }, Product: 'ProLiant' });
    if (req.url === '/redfish/v1/Systems') return json(res, { Members: [{ '@odata.id': '/redfish/v1/Systems/1' }] });
    if (req.url === '/redfish/v1/Systems/1') return json(res, { Manufacturer: 'HPE', Model: 'DL380', SKU: '867959-B21', SerialNumber: 'SYNTHSN01' });
    return json(res, {}, 404);
  });
  const r = await redfish.probeIdrac(url, '', '', 3000, { credsFor: scan.makeScanCredsFor(null, ILO) });
  assert.equal(r.serviceTag, 'SYNTHSN01');
});

test('COL2611-01: 등록부 교정 — HPE 이고 태그가 SKU 와 같을 때만, 한 번만', () => {
  registry.importServers([
    { id: '10.27.0.1', name: 'h', host: '10.27.0.1', username: 'a', password: 'b', vendor: 'hpe', serviceTag: '867959-B21' },
    { id: '10.27.0.2', name: 'h2', host: '10.27.0.2', username: 'a', password: 'b', vendor: 'hpe', serviceTag: 'MANUAL' },
  ], 'merge');
  assert.equal(registry.correctHpeServiceTag('10.27.0.1', { sku: '867959-B21', serial: 'SYNTHSN02' }), true);
  assert.equal(registry.loadRegistry().find((s) => s.id === '10.27.0.1').serviceTag, 'SYNTHSN02');
  assert.equal(registry.correctHpeServiceTag('10.27.0.1', { sku: '867959-B21', serial: 'SYNTHSN02' }), false, '두 번째는 no-op');
  assert.equal(registry.correctHpeServiceTag('10.27.0.2', { sku: '867959-B21', serial: 'SYNTHSN03' }), false, '손으로 넣은 값은 건드리지 않는다');
  assert.match(read('idrac/poller.js'), /if \(inv\.system\?\.hpe\) \{ try \{ correctHpeServiceTag\(s\.id, \{ sku: inv\.system\.sku, serial: inv\.system\.serialNumber \}\)/);
});

// ── COL2611-02·03 ─────────────────────────────────────────────────────────
test('COL2611-02·03: 팬 Percent 는 rpm 이 아니라 pct · Absent 온도 센서는 싣지 않는다', async () => {
  const url = await serve((req, res) => {
    if (req.url === '/redfish/v1/Chassis') return json(res, { Members: [{ '@odata.id': '/redfish/v1/Chassis/1' }] });
    if (req.url === '/redfish/v1/Chassis/1/Thermal') {
      return json(res, {
        Temperatures: [
          { Name: 'Inlet', ReadingCelsius: 22, Status: { State: 'Enabled', Health: 'OK' } },
          { Name: 'DIMM 5', ReadingCelsius: 0, Status: { State: 'Absent' } },
        ],
        Fans: [
          { Name: 'Fan 1', Reading: 23, ReadingUnits: 'Percent', Status: { Health: 'OK' } },
          { Name: 'Fan 2', Reading: 7200, ReadingUnits: 'RPM', Status: { Health: 'OK' } },
          { Name: 'Fan 3', Reading: 5600, Status: { Health: 'OK' } },
        ],
      });
    }
    return json(res, {}, 404);
  });
  const s = await redfish.fetchSensors({ host: url, username: 'a', password: 'b' });
  assert.ok(!s.temps.some((t) => t.name === 'DIMM 5'), 'Absent 센서 0℃ 를 싣지 않는다');
  assert.ok(s.temps.some((t) => t.name === 'Inlet' && t.celsius === 22));
  const f1 = s.fans.find((f) => f.name === 'Fan 1');
  assert.equal(f1.rpm, null);
  assert.equal(f1.pct, 23);
  assert.equal(s.fans.find((f) => f.name === 'Fan 2').rpm, 7200);
  assert.equal(s.fans.find((f) => f.name === 'Fan 3').rpm, 5600, '단위가 없으면 예전대로 RPM');
});
