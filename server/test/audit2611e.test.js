/**
 * v2.611 감사 수정 그룹 E 회귀(node:test).
 *   TIM2611-03  IPAM 스캔 데드라인·파트 장애 디바운스 env 가 시한 관문(deadlineMs)을 거친다 — 2^31ms 초과·Infinity 가 1ms 가 되지 않는다
 *   TIM2611-04  iDRAC 로컬 임시 스캔(POST /api/admin/idrac/scan)이 주기·'지금 스캔' 과 같은 잠금을 공유한다 — 겹치면 409 busy
 *               + 인증 실패 정책(makeScanAuthPolicy)을 넘긴다
 *   AUTHZ2611-05(잔여) 점검중(maintenance) 분기도 location.region 은 등록부 값이 이긴다 — store.withRegistryRegion 하나
 *   PERF2611-01 원장 재구성(buildIpamRows)이 IP 를 행당 한 번 파싱한다 — 옛 판본(3c1f691)과 rows·summary 가 **완전히 같다**
 *
 * ⚠ 옛 판본 함수는 아래에 **글자 그대로 복사**했다(캐시 두 줄만 뺐다). 성능 수정은 결과 동일성이 증거다(v2.602 규약).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
const CFG = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611e-'));
process.env.CONFIG_DIR = CFG;
process.env.DATA_SOURCE = 'mock';
process.env.IPAM_SCAN_WRITE_DEBOUNCE_MS = process.env.IPAM_SCAN_WRITE_DEBOUNCE_MS || '0';

const strip = stripComments;   // v2.613 TESTDOC2613-08
const src = (p) => strip(fs.readFileSync(path.join(SRC, p), 'utf8'));

function runChild(code, env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { ...process.env, CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611e-c-')), DATA_SOURCE: 'mock', AUTH_ENABLED: 'false', ...env },
    encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, `자식 프로세스 실패: ${(r.stderr || '').slice(-2000)}`);
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, `출력 없음: ${r.stdout.slice(-800)} ${r.stderr.slice(-800)}`);
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  return o;
}

// ---------------------------------------------------------------- TIM2611-03
test('TIM2611-03: IPAM 스캔 데드라인은 [60초, 2시간] — 2^31ms 초과·Infinity·빈 값이 1ms 가 되지 않는다', async () => {
  const { scanDeadlineMs } = await import(path.join(SRC, 'ipam/scanRunner.js'));
  assert.equal(scanDeadlineMs('3000000000'), 7_200_000);
  assert.equal(scanDeadlineMs(3e9), 7_200_000);
  assert.equal(scanDeadlineMs('Infinity'), 20 * 60_000);
  assert.equal(scanDeadlineMs(''), 20 * 60_000);
  assert.equal(scanDeadlineMs(undefined), 20 * 60_000);
  assert.equal(scanDeadlineMs('-5'), 20 * 60_000);
  assert.equal(scanDeadlineMs('1000'), 60_000);          // 하한 60초 유지
  assert.equal(scanDeadlineMs(30 * 60_000), 30 * 60_000);
  const s = src('ipam/scanRunner.js');
  assert.match(s, /const DEADLINE_MS = scanDeadlineMs\(process\.env\.IPAM_SCAN_DEADLINE_MS\)/);
  assert.match(s, /runInWorker\(job, onProgress, scanDeadlineMs\(deadlineMs\)\)/, '호출부가 넘긴 값도 관문을 거친다');
});

test('TIM2611-03: 파트 장애 디바운스 env 3e9 → 2시간(1ms 아님) · 빈 값 → 15초', () => {
  const code = (v) => `
    const out = {};
    try {
      const h = await import(${JSON.stringify(path.join(SRC, 'partfault/hooks.js'))});
      out.debounce = h.hookStatus().debounceMs;
      out.fn = [h.hookDebounceMs('3000000000'), h.hookDebounceMs(''), h.hookDebounceMs('Infinity'), h.hookDebounceMs('500')];
    } catch (e) { out.err = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out)); process.exit(0);`;
  const a = runChild(code(), { PARTFAULT_HOOK_DEBOUNCE_MS: '3000000000' });
  assert.equal(a.debounce, 7_200_000);
  assert.deepEqual(a.fn, [7_200_000, 15_000, 15_000, 1_000]);
  const b = runChild(code(), { PARTFAULT_HOOK_DEBOUNCE_MS: '' });
  assert.equal(b.debounce, 15_000);
});

// ---------------------------------------------------------------- TIM2611-04
test('TIM2611-04: 로컬 임시 스캔은 주기·지금 스캔과 같은 잠금 — 진행 중이면 409 busy + 사유, 끝나면 잠금 해제', () => {
  const o = runChild(`
    const out = {};
    const SRC = ${JSON.stringify(SRC + '/')};
    try {
      const express = (await import('express')).default;
      const sp = await import(SRC + 'idrac/scanPoller.js');
      const { adminRouter } = await import(SRC + 'routes/admin.js');
      const app = express(); app.use(express.json());
      app.use((req, _r, n) => { req.user = { username: 'boss', role: 'admin', scope: null }; n(); });
      app.use('/api/admin', adminRouter);
      const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
      const base = 'http://127.0.0.1:' + srv.address().port;
      const post = async (b) => { const r = await fetch(base + '/api/admin/idrac/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { s: r.status, j: await r.json() }; };
      const body = { ips: '127.0.0.1', username: 'root', password: 'pw' };
      // ① 주기 스캔이 잡고 있으면 409 + 누가 잡았는지
      const lk = sp.tryAcquireScan('periodic');
      out.lock1 = lk.ok;
      out.busyPeriodic = await post(body);
      out.statusKind = sp.idracScanStatus().runningKind;
      out.onceWhileHeld = await sp.runIdracScanOnce({});
      sp.releaseScan();
      // ② 다른 임시 스캔이 잡고 있으면 409(사유가 다르다)
      sp.tryAcquireScan('adhoc');
      out.busyAdhoc = await post(body);
      out.second = sp.tryAcquireScan('adhoc');
      sp.releaseScan();
      // ③ 비어 있으면 실행되고, 끝나면 잠금이 풀린다
      out.free = await post(body);
      out.afterFree = sp.tryAcquireScan('adhoc'); sp.releaseScan();
      out.statusAfter = sp.idracScanStatus().running;
      srv.close();
    } catch (e) { out.err = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out)); process.exit(0);`);
  assert.equal(o.lock1, true);
  assert.equal(o.busyPeriodic.s, 409);
  assert.equal(o.busyPeriodic.j.busy, true);
  assert.equal(o.busyPeriodic.j.by, 'periodic');
  assert.match(o.busyPeriodic.j.reason, /주기 스캔/);
  assert.equal(o.statusKind, 'periodic');
  assert.equal(o.onceWhileHeld.ok, false, '임시 스캔 잠금 중에는 주기 스캔도 시작하지 않는다(같은 running)');
  assert.equal(o.busyAdhoc.s, 409);
  assert.match(o.busyAdhoc.j.reason, /다른 임시 스캔/);
  assert.equal(o.second.ok, false);
  assert.notEqual(o.free.s, 409, JSON.stringify(o.free));
  assert.equal(o.afterFree.ok, true, '응답 뒤 잠금이 풀려야 한다(finally releaseScan)');
  assert.equal(o.statusAfter, false);
});

test('TIM2611-04: 로컬 임시 스캔 경로가 makeScanAuthPolicy({periodic:false}) 를 scanForIdracs 에 넘긴다', () => {
  const s = src('routes/admin/idracScan.js');
  const i = s.indexOf("adminRouter.post('/idrac/scan'");
  assert.ok(i >= 0);
  const block = s.slice(i, s.indexOf('adminRouter.', i + 10));
  assert.match(block, /tryAcquireScan\('adhoc'\)/);
  assert.match(block, /status\(409\)/);
  assert.match(block, /makeScanAuthPolicy\(\{[^}]*periodic:\s*false/);
  assert.match(block, /scanForIdracs\(\{[^}]*authPolicy/);
  assert.match(block, /finally\s*\{\s*releaseScan\(\)/);
});

// ---------------------------------------------------------------- AUTHZ2611-05 잔여
test('AUTHZ2611-05: withRegistryRegion — 등록부 region 이 이기고 표시값은 그대로 · 점검중 분기도 같은 헬퍼', async () => {
  const { withRegistryRegion } = await import(path.join(SRC, 'store.js'));
  const reg = { location: { region: 'EMEA', city: 'Warsaw' } };
  assert.deepEqual(withRegistryRegion({ region: 'APAC', city: 'Krakow', lat: 1 }, reg), { region: 'EMEA', city: 'Krakow', lat: 1 });
  const same = { region: 'EMEA', city: 'X' };
  assert.equal(withRegistryRegion(same, reg), same);
  assert.deepEqual(withRegistryRegion({ region: 'APAC' }, { location: { region: '' } }), { region: 'APAC' });
  assert.equal(withRegistryRegion(null, reg), null);
  const s = src('store.js');
  assert.match(s, /status: 'maintenance', maintenance: true \}\)/);
  assert.match(s, /\.\.\.s\.vcenter, location: withRegistryRegion\(/, '점검중 캐시 분기도 등록부 region');
  assert.match(s, /const siteLoc = withRegistryRegion\(siteLoc0, vc\)/, 'site 분기와 같은 헬퍼');
});

test('AUTHZ2611-05: 점검중 vCenter 의 캐시 스냅샷 region 이 등록부와 다르면 등록부 값으로 병합된다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2611e-m-'));
  fs.writeFileSync(path.join(dir, 'vcenters.json'), JSON.stringify({ vcenters: [
    { id: 'vc-m', name: 'M', host: 'https://10.0.0.9', maintenance: true, location: { city: 'Warsaw', region: 'EMEA', lat: 52, lon: 21 } },
  ] }));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const out = {};
    const SRC = ${JSON.stringify(SRC + '/')};
    try {
      const { store } = await import(SRC + 'store.js');
      const { scopedVcenterIds } = await import(SRC + 'auth/scope.js');
      store.vcCache.set('vc-m', { ok: true, at: Date.now(), data: { vcenter: { id: 'vc-m', name: 'M', status: 'ok', location: { region: 'APAC', city: 'Old' } }, hosts: [], vms: [], datastores: [], networks: [], alarms: [] } });
      await store.refresh({ force: true, collectAll: true });
      const snap = store.get();
      const m = snap.vcenters.find((v) => v.id === 'vc-m');
      out.region = m?.location?.region; out.city = m?.location?.city; out.status = m?.status;
      out.apac = [...(scopedVcenterIds({ scope: { regions: ['APAC'] } }, snap) || [])];
    } catch (e) { out.err = String(e && e.stack || e); }
    console.log('@@' + JSON.stringify(out)); process.exit(0);`], {
    env: { ...process.env, CONFIG_DIR: dir, DATA_SOURCE: 'live', AUTH_ENABLED: 'false' }, encoding: 'utf8', cwd: path.resolve(SRC, '..'), timeout: 120_000,
  });
  assert.equal(r.status, 0, (r.stderr || '').slice(-1500));
  const line = r.stdout.split('\n').find((l) => l.startsWith('@@'));
  assert.ok(line, r.stdout.slice(-800) + r.stderr.slice(-800));
  const o = JSON.parse(line.slice(2));
  assert.equal(o.err, undefined, o.err);
  assert.equal(o.status, 'maintenance');
  assert.equal(o.region, 'EMEA', '캐시의 APAC 가 아니라 등록부 EMEA');
  assert.equal(o.city, 'Old', '표시값(도시)은 캐시 값 그대로');
  assert.ok(!o.apac.includes('vc-m'), 'APAC 지역 범위 계정에 보이지 않는다');
});

// ---------------------------------------------------------------- PERF2611-01
// 옛 판본(3c1f691 server/src/ipam/ledger.js buildIpamRows)이 쓰는 모듈 이름들 — 테스트 안에서 주입한다.
let getIgnoreMatcher, getClassifier, scanResultList, getIpHistoryMap, getOverrides, findPolicy, ipToNum, parseOs;
const RESERVE_SOON_MS = 14 * 86_400_000;
const reconcileOf = (discovery) => (discovery === 'both' ? 'both' : discovery === 'scan' ? 'scan' : discovery === 'vcenter' ? 'vcenter' : 'manual');

// ===== 3c1f691 판본 그대로(캐시 2줄 제외) =====
function oldBuildIpamRows(snap, vcenterId, allowed = null) {
  vcenterId = vcenterId || ''; // undefined/null → '' 정규화(스코프·정책 매칭·캐시키 일관)
  let vms = snap.vms || [];
  let hosts = snap.hosts || [];
  // 사용자 scope(보안 경계)를 요청 vcenterId(뷰 필터)보다 먼저 강제. allowed=null 이면 무제한(기존).
  if (allowed) {
    vms = vms.filter((v) => allowed.has(v.vcenterId));
    hosts = hosts.filter((h) => allowed.has(h.vcenterId));
  }
  if (vcenterId) {
    vms = vms.filter((v) => v.vcenterId === vcenterId);
    hosts = hosts.filter((h) => h.vcenterId === vcenterId);
  }
  // known/충돌 판정의 '유니버스' — 무제한은 전체 스냅샷, 범위 제한은 허용 vCenter 로 축소한다
  // (축소하지 않으면 conflictVcenters 로 범위 밖 vCenter id 가 새고, 스캔 판정도 전체 기준이 된다).
  const uniVms = allowed ? (snap.vms || []).filter((v) => allowed.has(v.vcenterId)) : (snap.vms || []);
  const uniHosts = allowed ? (snap.hosts || []).filter((h) => allowed.has(h.vcenterId)) : (snap.hosts || []);
  const vcName = {};
  for (const vc of snap.vcenters || []) vcName[vc.id] = vc.name;

  const ignored = getIgnoreMatcher();
  const classify = getClassifier();
  // 확인 출처(discovery): 'vcenter'(vCenter 인식) · 'scan'(Ping/TCP 스캔) · 'both'(둘 다).
  // vCenter가 아는 IP가 스캔에도 잡히면 'both'로 표시. (스캔 결과는 1회만 조회해 재사용)
  const scanList = scanResultList();
  const scanIpSet = new Set(scanList.map((s) => s.ip));
  const rows = [];
  const count = new Map();
  for (const vm of vms) {
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) {
      if (ignored(ip, vm.vcenterId)) continue;
      count.set(ip, (count.get(ip) || 0) + 1);
      rows.push({
        ip, ipNum: ipToNum(ip), vcenterId: vm.vcenterId, vcenterName: vcName[vm.vcenterId] || vm.vcenterId,
        ownerType: 'vm', serverType: 'VM', ownerName: vm.name, powerState: vm.powerState, guestOS: vm.guestOS,
        ...parseOs(vm.guestOS),
        hostName: vm.host || '', cluster: vm.cluster || '', multiHomed: ips.length > 1, scope: classify(ip), owner: vm,
        discovery: scanIpSet.has(ip) ? 'both' : 'vcenter',
      });
    }
  }
  for (const h of hosts) {
    if (ipToNum(h.name) == null) continue; // host registered by FQDN → no mgmt IP
    if (ignored(h.name, h.vcenterId)) continue;
    count.set(h.name, (count.get(h.name) || 0) + 1);
    rows.push({
      ip: h.name, ipNum: ipToNum(h.name), vcenterId: h.vcenterId, vcenterName: vcName[h.vcenterId] || h.vcenterId,
      ownerType: 'host', serverType: 'BareMetal', ownerName: h.name, powerState: h.powerState, guestOS: `ESXi ${h.version || ''}`.trim(),
      osName: 'ESXi', osVersion: h.version || '',
      hostName: h.name, cluster: h.cluster || '', multiHomed: false, scope: classify(h.name), owner: h,
      discovery: scanIpSet.has(h.name) ? 'both' : 'vcenter',
    });
  }
  // 능동 스캔으로 발견된 IP(물리/기타 서버 등) 병합 — vCenter가 모르는 IP만 추가.
  // 스캔 결과는 특정 vCenter에 속하지 않으므로 vCenter 스코프와 무관하게 '항상' 표시한다.
  // '이미 vCenter가 아는 IP' 판정은 스코프된 rows가 아니라 '전체' vCenter IP 기준으로 한다
  // (스코프를 걸면 다른 vCenter의 IP가 known에서 빠져 스캔으로 오인되는 문제 방지).
  const histMap = getIpHistoryMap();
  // 스캔 발견물은 vCenter 귀속(vcenterId)이 없어 scope 로 판정할 수 없다 → 범위 제한 계정에는
  // 병합하지 않는다(전 사이트 네트워크 스캔 노출 차단). 무제한 계정만 스캔 행을 합친다.
  if (!allowed) {
    const known = new Set();
    for (const vm of uniVms) {
      const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
      for (const ip of ips) known.add(ip);
    }
    for (const h of uniHosts) if (ipToNum(h.name) != null) known.add(h.name);
    const seen = new Set(rows.map((r) => r.ip));
    for (const sc of scanList) {
      if (ignored(sc.ip, '') || known.has(sc.ip) || seen.has(sc.ip) || ipToNum(sc.ip) == null) continue;
      seen.add(sc.ip);
      const hist = histMap[sc.ip];
      const released = hist?.status === 'down';
      count.set(sc.ip, (count.get(sc.ip) || 0) + 1);
      rows.push({
        ip: sc.ip, ipNum: ipToNum(sc.ip), vcenterId: '', vcenterName: '(네트워크 스캔)',
        ownerType: 'scanned', serverType: 'Scanned', ownerName: sc.hostname || sc.ip,
        powerState: released ? 'POWERED_OFF' : 'POWERED_ON', guestOS: '', osName: '', osVersion: '',
        hostName: sc.hostname || '', cluster: '', multiHomed: false, scope: classify(sc.ip),
        openPorts: sc.openPorts || [], services: sc.services || [], lastSeen: sc.lastSeen || null,
        firstSeen: hist?.firstSeen || null, usageStatus: hist?.status || null, released,
        source: 'scan', discovery: 'scan', owner: null,
      });
    }
  }
  // VM/호스트 IP에도 스캔 이력이 있으면 사용 추이를 붙인다(있을 때만).
  for (const r of rows) {
    const h = histMap[r.ip];
    if (h && r.firstSeen == null) { r.firstSeen = h.firstSeen; r.lastSeen = r.lastSeen || h.lastSeen; r.usageStatus = h.status; }
  }

  // ---- 수동 관리(override) 병합 ----------------------------------------------
  // 운영자가 IP 단위로 부여한 관리 상태(담당자/라벨/디바이스종류/예약 등)를 행에 입힌다.
  // override만 있고 vCenter/스캔 어디에도 없는 IP는 'manual' 행으로 추가해(예약/계획 IP) 함께 관리.
  const overrides = getOverrides();
  const seenAll = new Set(rows.map((r) => r.ip));
  for (const [ip, ov] of Object.entries(overrides)) {
    if (seenAll.has(ip) || ipToNum(ip) == null) continue;
    if (allowed && ov.claimedVcenterId && !allowed.has(ov.claimedVcenterId)) continue; // 범위 밖 vCenter 귀속 예약 제외
    // 범위 제한 계정에는 vCenter 미귀속(claimedVcenterId 없는) 수동 예약 IP 를 노출하지 않는다
    // (어느 사이트 소속인지 판정 불가 — 스캔 행과 같은 정책).
    if (allowed && !ov.claimedVcenterId) continue;
    if (vcenterId && ov.claimedVcenterId && ov.claimedVcenterId !== vcenterId) continue; // 특정 vCenter에 귀속 예약이면 스코프 존중
    count.set(ip, (count.get(ip) || 0) + 1);
    rows.push({
      ip, ipNum: ipToNum(ip), vcenterId: ov.claimedVcenterId || '', vcenterName: vcName[ov.claimedVcenterId] || '(수동 등록)',
      ownerType: 'manual', serverType: 'Manual', ownerName: ov.label || ov.hostnameOverride || ip,
      powerState: '', guestOS: '', osName: '', osVersion: '',
      hostName: ov.hostnameOverride || '', cluster: '', multiHomed: false, scope: classify(ip),
      discovery: 'manual', owner: null,
    });
  }
  // 교차 vCenter 충돌 탐지 — '전체' 스냅샷 기준(스코프와 무관)으로 한 IP를 둘 이상 vCenter가
  // 주장하면 conflict. (스코프 뷰에서도 충돌을 놓치지 않게 full snapshot으로 계산)
  const vcByIp = new Map();
  for (const vm of uniVms) {   // 유니버스: 무제한=전체, 범위제한=허용 vCenter(범위 밖 conflict 유출 차단)
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    for (const ip of ips) { if (!vcByIp.has(ip)) vcByIp.set(ip, new Set()); if (vm.vcenterId) vcByIp.get(ip).add(vm.vcenterId); }
  }
  for (const h of uniHosts) { if (ipToNum(h.name) == null) continue; if (!vcByIp.has(h.name)) vcByIp.set(h.name, new Set()); if (h.vcenterId) vcByIp.get(h.name).add(h.vcenterId); }
  const now = Date.now();

  // 모든 행에 관리 정보를 입힌다 — 필드별 폭포식: IP override(개별 예외) > 대역 정책(대역 기본값) > 자동발견.
  // 예: 정책이 /24를 'dhcp'로 두고, 그 안 한 IP에 owner만 override → 결과 status='dhcp'(정책 보충)+owner=override값.
  const applied = [];
  for (const r of rows) {
    const ov = overrides[r.ip];
    if (ov && ov.status === 'ignored') continue;        // 게이트: override 명시 숨김(최우선)
    const rp = findPolicy(r.ipNum, vcenterId);           // 적용 대역 정책(없으면 null)
    if (!ov && rp && rp.status === 'ignored') continue;  // 게이트: 정책 대역 숨김(override 없을 때만 — override 있으면 행 유지)

    // 'ignored' 정책은 가시 행(=override로 살아남은 IP)에 어떤 필드도 기여하지 않는다(완전 숨김).
    // erp = 표시에 기여하는 '유효 정책'(ignored면 null). 게이트(위)에서 !ov && ignored는 이미 제거됨.
    const erp = (rp && rp.status !== 'ignored') ? rp : null;
    if (ov || erp) {
      r.mgmtStatus = (ov?.status) || (erp?.status) || '';
      r.owner_ = (ov?.owner) || (erp?.owner) || '';
      r.label = (ov?.label) || (erp?.label) || '';
      r.deviceType = (ov?.deviceType) || (erp?.deviceType) || '';
      r.note = (ov?.note) || (erp?.note) || '';
      r.managed = true;
      r.appliedBy = ov ? 'override' : 'range-policy';
      if (erp) { r.rangePolicyId = erp.id; r.rangePolicySpec = erp.spec; }
      // override 전용 필드(정책 미지원): 예약 만료·호스트명 덮어쓰기
      if (ov) {
        r.reservedUntil = ov.reservedUntil || null;
        if (ov.reservedUntil) {
          const due = Date.parse(ov.reservedUntil);
          if (due < now) r.reservedExpired = true;
          else if (due < now + RESERVE_SOON_MS) r.reservedExpiringSoon = true; // 14일 내 만료 임박
        }
        if (ov.hostnameOverride) r.hostName = ov.hostnameOverride;
      }
      const lbl = (ov?.label) || (erp?.label);
      if (lbl) r.displayName = lbl;
    } else {
      r.appliedBy = 'auto';
    }
    if (!r.displayName) r.displayName = r.hostName || r.ownerName || r.ip;
    const vcs = vcByIp.get(r.ip);
    if (vcs && vcs.size > 1) { r.reconcile = 'conflict'; r.conflictVcenters = [...vcs]; }
    else r.reconcile = reconcileOf(r.discovery);
    applied.push(r);
  }
  // v2.603(감사 CEN2603-03): push(...applied) 는 원소 수만큼 인자를 만든다 — 약 13만 행을 넘으면 RangeError(Maximum call stack
  //   size exceeded)로 원장 계산 전체가 던졌다(/api/tools/ipam 500 · ipam.db 동기화 정지). 원소 수와 무관한 반복으로 옮긴다.
  rows.length = 0;
  for (const r of applied) rows.push(r);

  // 중복 여부는 '가시 행'(ignored 게이트로 숨겨진 행 제외) 기준으로 재계산한다 — 원본 count는
  // 숨김 이전 값이라, 한쪽이 정책/override로 숨겨지면 살아남은 유일 행이 duplicate로 오표시됐다.
  const visCount = new Map();
  for (const r of rows) visCount.set(r.ip, (visCount.get(r.ip) || 0) + 1);
  for (const r of rows) r.duplicate = (visCount.get(r.ip) || 0) > 1;
  rows.sort((a, b) => (a.ipNum ?? Infinity) - (b.ipNum ?? Infinity));

  const byVc = {};
  for (const r of rows) byVc[r.vcenterId] = (byVc[r.vcenterId] || 0) + 1;
  // reconcile(출처 대조) 분포 + 관리상태 분포 + 관리 방식(override/정책/자동) 분포 — 대시보드 요약 카드용.
  const reconCounts = { vcenter: 0, scan: 0, both: 0, manual: 0, conflict: 0 };
  const mgmtCounts = {};
  const appliedCounts = { override: 0, 'range-policy': 0, auto: 0 };
  let managedN = 0; let reservedExpiredN = 0; let reservedSoonN = 0;
  for (const r of rows) {
    if (reconCounts[r.reconcile] !== undefined) reconCounts[r.reconcile]++;
    if (r.managed) managedN++;
    if (r.mgmtStatus) mgmtCounts[r.mgmtStatus] = (mgmtCounts[r.mgmtStatus] || 0) + 1;
    if (appliedCounts[r.appliedBy] !== undefined) appliedCounts[r.appliedBy]++;
    if (r.reservedExpired) reservedExpiredN++;
    if (r.reservedExpiringSoon) reservedSoonN++;
  }
  const out = {
    total: rows.length,
    multiHomed: rows.filter((r) => r.multiHomed).length,
    // 요약도 행 플래그와 같은 '가시 행' 기준(visCount) — 숨김 이전 count를 쓰면 표에는 중복 0인데
    // 카드에는 중복 N으로 남아 집계-표 불일치가 생긴다.
    duplicateIps: [...visCount.values()].filter((c) => c > 1).length,
    publicIps: rows.filter((r) => r.scope === 'public').length,
    privateIps: rows.filter((r) => r.scope === 'private').length,
    conflicts: reconCounts.conflict,
    reconcile: reconCounts,
    managed: managedN,
    unmanaged: rows.length - managedN,
    reservedExpired: reservedExpiredN,
    reservedExpiringSoon: reservedSoonN,
    mgmtStatus: mgmtCounts,
    appliedBy: appliedCounts,
    byVcenter: Object.entries(byVc).map(([id, c]) => ({ vcenterId: id, vcenterName: vcName[id] || (id || '네트워크 스캔'), scanned: !id, count: c })).sort((a, b) => b.count - a.count),
    rows,
  };
  return out;
}
// ===== 옛 판본 끝 =====

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function makeSnap(gen, seed = 7) {
  const R = rng(seed);
  const vcenters = Array.from({ length: 24 }, (_, i) => ({ id: `vc-${i}`, name: `VC ${i}` }));
  const oses = ['CentOS 7 (64-bit)', 'Microsoft Windows Server 2019 (64-bit)', 'Ubuntu Linux (64-bit)', 'Red Hat Enterprise Linux 8 (64-bit)', '', null, 'VMware Photon OS (64-bit)', 'Other 3.x or later Linux (64-bit)'];
  const ip = () => {
    const k = R();
    if (k < 0.55) return `10.${Math.floor(R() * 4)}.${Math.floor(R() * 40)}.${1 + Math.floor(R() * 250)}`;
    if (k < 0.7) return `172.${16 + Math.floor(R() * 4)}.${Math.floor(R() * 8)}.${1 + Math.floor(R() * 250)}`;
    if (k < 0.8) return `192.168.${Math.floor(R() * 5)}.${1 + Math.floor(R() * 250)}`;
    if (k < 0.9) return `203.0.${113 + Math.floor(R() * 2)}.${1 + Math.floor(R() * 250)}`;
    if (k < 0.94) return `fe80::${Math.floor(R() * 999)}`;          // IPv6 — 파싱 불가
    if (k < 0.97) return `010.1.2.${Math.floor(R() * 9)}`;          // 비정규 표기
    return 'not-an-ip';
  };
  const vms = [];
  for (let i = 0; i < 3500; i++) {
    const vc = vcenters[Math.floor(R() * vcenters.length)].id;
    const n = R() < 0.2 ? 0 : 1 + Math.floor(R() * 3);
    const ips = Array.from({ length: n }, ip);
    vms.push({ id: `vm-${i}`, name: `vm${i}`, vcenterId: vc, powerState: R() < 0.8 ? 'POWERED_ON' : 'POWERED_OFF', guestOS: oses[Math.floor(R() * oses.length)], host: `esx${i % 50}`, cluster: `cl${i % 7}`, ...(R() < 0.5 ? { ipAddresses: ips } : { ipAddress: ips[0] }) });
  }
  const hosts = [];
  for (let i = 0; i < 400; i++) {
    const vc = vcenters[Math.floor(R() * vcenters.length)].id;
    hosts.push({ id: `h-${i}`, name: R() < 0.7 ? ip() : `esx${i}.corp.local`, vcenterId: vc, version: '8.0.2', powerState: 'POWERED_ON', cluster: `cl${i % 7}` });
  }
  return { generatedAt: gen, vcenters, vms, hosts };
}

test('PERF2611-01: buildIpamRows 결과가 옛 판본과 완전히 같다(무시 규칙·공인/사설 범위·스캔·override·범위 조합) + 소요 기록', async () => {
  const ledger = await import(path.join(SRC, 'ipam/ledger.js'));
  const settings = await import(path.join(SRC, 'ipam/settings.js'));
  const scanStore = await import(path.join(SRC, 'ipam/scanStore.js'));
  const ov = await import(path.join(SRC, 'ipam/overrides.js'));
  const rp = await import(path.join(SRC, 'ipam/rangePolicies.js'));
  ({ getIgnoreMatcher, getClassifier } = settings);
  ({ scanResultList, getIpHistoryMap } = scanStore);
  ({ getOverrides } = ov);
  ({ findPolicy } = rp);
  ({ ipToNum, parseOs } = ledger);

  let gen = 0;
  const compare = (label, vcenterId, allowed, minRows = 1000) => {
    const snap = makeSnap(`g${++gen}`, 11);
    const t0 = performance.now(); const a = oldBuildIpamRows(snap, vcenterId, allowed); const t1 = performance.now();
    const snap2 = makeSnap(`g${++gen}`, 11);
    const t2 = performance.now(); const b = ledger.buildIpamRows(snap2, vcenterId, allowed); const t3 = performance.now();
    // owner 는 스냅샷 객체 참조라 두 스냅샷이 다른 객체 — 내용이 같으면 deepStrictEqual 이 같다고 본다.
    assert.deepStrictEqual(b, a, `${label}: 결과가 옛 판본과 다르다`);
    assert.ok(a.rows.length > minRows, `${label}: 입력이 충분히 커야 한다(${a.rows.length})`);
    return { label, rows: a.rows.length, oldMs: +(t1 - t0).toFixed(1), newMs: +(t3 - t2).toFixed(1) };
  };
  const timings = [];
  // ① 설정 없음 — matcher.empty 빠른 길
  assert.equal(getIgnoreMatcher().empty, true);
  timings.push(compare('빈 설정', '', null));
  // ② 무시 규칙(전역·vCenter별·범위 표기) + 공인/사설 명시 범위
  settings.saveSettings({ global: ['10.0.1.0/24', '192.168.3.10-192.168.3.90', '172.16.0.5'], vcenters: { 'vc-3': ['10.2.0.0/16'], 'vc-9': [] },
    publicRanges: ['10.3.0.0/16'], privateRanges: ['203.0.114.0/24'] });
  assert.equal(getIgnoreMatcher().empty, false);
  assert.equal(typeof getIgnoreMatcher().num, 'function');
  assert.equal(typeof getClassifier().num, 'function');
  timings.push(compare('규칙 있음', '', null));
  // ③ 스캔 결과·override(예약 없음 — 시각 의존 없음)
  scanStore.mergeScanResults([{ ip: '10.0.5.5', hostname: 'sw1', openPorts: [22] }, { ip: '10.0.1.7' }, { ip: '198.51.100.9', hostname: 'ext' }, { ip: 'bogus' }], 1_700_000_000_000);
  ov.setOverride('10.0.5.99', { status: 'static', owner: 'net', label: 'core' }, 'test');
  ov.setOverride('10.1.1.1', { status: 'ignored' }, 'test');
  timings.push(compare('스캔·override', '', null));
  timings.push(compare('vCenter 필터', 'vc-3', null, 100));
  timings.push(compare('범위 계정', '', new Set(['vc-1', 'vc-3', 'vc-9']), 300));
  // 숫자판과 문자열판이 같은 답(개별 확인)
  const m = getIgnoreMatcher(); const c = getClassifier();
  for (const s of ['10.0.1.4', '10.2.3.4', '192.168.3.50', '172.16.0.5', '203.0.114.3', '10.3.1.1', '8.8.8.8', 'x', 'fe80::1']) {
    const n = ipToNum(s);
    assert.equal(m.num(n, 'vc-3'), m(s, 'vc-3'), s);
    assert.equal(c.num(n), c(s), s);
  }
  console.log('[PERF2611-01] 소요(ms, 단언 아님):', JSON.stringify(timings));
});
