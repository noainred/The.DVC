/**
 * 54 · 51회차가 남긴 것 3건(54회차 F4 · F5 추정 · 51회차 #2) 회귀.
 *
 *  F4  VM 사양 변경 — parseHardware 가 못 읽은 vCPU · 메모리(· 디스크 용량)를 0 으로 실어 '증설만' 검사가 0 기준이었다(어떤 값이든 '증설').
 *      → 못 읽으면 null · 현재 값을 모르면 그 항목 변경은 4xx(fail-closed) · ReconfigVM_Task 를 보내지 않는다(가짜 vCenter 로 실제 라우트를 돈다).
 *  F5  SOAP 수집 — 못 읽은 호스트 용량(코어 · MHz · 메모리)을 0 으로 실어 store.hostCapacityKnown 을 통과했다
 *      → null(0 이하도) · 사용률도 분모를 모르면 null · 서버(store)와 웹(web/src/hostCapacity.js · virtSum) 판정을 같은 입력으로 대조.
 *      ⚠ 실 vCenter 응답은 이 환경에서 볼 수 없다 — 가짜 vCenter 가 '속성 없음 · 0' 을 줄 때의 동작만 고정한다.
 *  #2  집중 모니터링 결과 저장 — 엣지 동기화 한 번이 받은 결과(최대 8건)를 ingestResult 마다 원자 쓰기(동기화당 9번)
 *      → 한 번 · 단건 경로는 곧바로 · 쓰기 실패 시 메모리 반영 · 응답은 예전과 같다 · 비동기(점검 DB) 결과는 묶음 밖에서 곧바로.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// v3.18.8: 이 파일이 만든 임시 폴더는 시험이 끝나면 지운다(지우지 않아 전량 실행마다 /tmp 에 쌓였다 — tmpCleanup3188 이 고정).
//   exit 에서 한 번 더 지운다 — 모듈의 종료 flush(util/exitFlush.js)가 뒤늦게 다시 만든 폴더(수 MB 실측)까지.
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다(늦게 flush 되는 기록기와의 경합 — exit 에서 한 번 더) */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('leftoverC56-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter(127.0.0.1) — 이 테스트 전용
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

// 기준 시각: 실제 시각에서 정시 경계로 떨어뜨려 고정(docs/rules/common.md — 정시 -30분)
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR - 30 * 60_000;

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ }
});

/* ───────────────────────── 가짜 vCenter ───────────────────────── */
const ENV = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>'
  + inner + '</soapenv:Body></soapenv:Envelope>';
const SC_XML = ENV('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const ps = (name, val) => `<propSet><name>${name}</name><val>${val}</val></propSet>`;
const obj = (type, ref, props) => `<returnval><obj type="${type}">${ref}</obj>${props}</returnval>`;
const RP = (inner) => ENV(`<RetrievePropertiesResponse xmlns="urn:vim25">${inner}</RetrievePropertiesResponse>`);

const GiB = 1024 ** 3;
const hw = (cores, mhz, memBytes) => (cores == null ? '' : ps('summary.hardware.numCpuCores', cores)) + (mhz == null ? '' : ps('summary.hardware.cpuMhz', mhz))
  + (memBytes == null ? '' : ps('summary.hardware.memorySize', memBytes));
const usage = ps('summary.quickStats.overallCpuUsage', '4000') + ps('summary.quickStats.overallMemoryUsage', '16384');
// 호스트 넷: 다 읽음 · 하드웨어 요약 없음(연결됨) · 0 으로 옴 · MHz 만 없음
const INV = RP(
  obj('HostSystem', 'host-1', ps('name', 'esx-ok') + ps('runtime.connectionState', 'connected') + hw('8', '2000', String(64 * GiB)) + ps('summary.hardware.numCpuThreads', '16') + usage)
  + obj('HostSystem', 'host-2', ps('name', 'esx-nohw') + ps('runtime.connectionState', 'connected') + usage)
  + obj('HostSystem', 'host-3', ps('name', 'esx-zero') + ps('runtime.connectionState', 'connected') + hw('0', '0', '0') + usage)
  + obj('HostSystem', 'host-4', ps('name', 'esx-partial') + ps('runtime.connectionState', 'connected') + hw('8', null, String(64 * GiB)) + usage),
);

const DISK = (key, cap) => `<VirtualDevice xsi:type="VirtualDisk"><key>${key}</key><deviceInfo><label>하드 디스크 1</label></deviceInfo>`
  + '<backing xsi:type="VirtualDiskFlatVer2BackingInfo"><fileName>[ds1] vm/vm.vmdk</fileName><diskMode>persistent</diskMode><thinProvisioned>true</thinProvisioned></backing>'
  + `<controllerKey>1000</controllerKey><unitNumber>0</unitNumber>${cap}</VirtualDevice>`;
const SCSI = '<VirtualDevice xsi:type="ParaVirtualSCSIController"><key>1000</key><deviceInfo><label>SCSI controller 0</label></deviceInfo><busNumber>0</busNumber></VirtualDevice>';
const devices = (cap) => `<propSet><name>config.hardware.device</name><val xsi:type="ArrayOfVirtualDevice">${SCSI}${DISK(2000, cap)}</val></propSet>`;
// vm-1 = vCPU · 메모리 · 디스크 용량을 못 읽음(속성 없음) · vm-2 = 다 읽음(4 vCPU · 8GB · 50GB) · 둘 다 전원 OFF(감소도 vCenter 가 받아들이는 상태)
const VM_PROPS = {
  'vm-1': devices('') + ps('runtime.powerState', 'poweredOff'),
  'vm-2': devices(`<capacityInKB>${50 * 1024 * 1024}</capacityInKB>`) + ps('config.hardware.numCPU', '4') + ps('config.hardware.numCoresPerSocket', '2')
    + ps('config.hardware.memoryMB', '8192') + ps('runtime.powerState', 'poweredOff'),
};

let VC = null;
async function fakeVc() {
  if (VC) return VC;
  const st = { reconfig: [], logins: 0 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const ok = (x) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(x); };
      if (b.includes('<RetrieveServiceContent')) return ok(SC_XML);
      if (b.includes('<Login ')) { st.logins += 1; res.setHeader('Set-Cookie', 'vmware_soap_session=x'); return ok(ENV('<LoginResponse xmlns="urn:vim25"><returnval><key>s</key></returnval></LoginResponse>')); }
      if (b.includes('<Logout')) return ok(ENV('<LogoutResponse xmlns="urn:vim25"/>'));
      if (b.includes('<ReconfigVM_Task')) { st.reconfig.push(b); return ok(ENV('<ReconfigVM_TaskResponse xmlns="urn:vim25"><returnval type="Task">task-9</returnval></ReconfigVM_TaskResponse>')); }
      if (b.includes('<CreateContainerView')) return ok(ENV('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view-1</returnval></CreateContainerViewResponse>'));
      if (b.includes('<RetrieveProperties')) {
        if (b.includes('<obj type="Task">')) return ok(RP(obj('Task', 'task-9', ps('info.state', 'success'))));
        const vm = /<obj type="VirtualMachine">([^<]+)<\/obj>/.exec(b)?.[1];
        if (vm) return ok(RP(obj('VirtualMachine', vm, VM_PROPS[vm] || '')));
        return ok(INV);
      }
      res.writeHead(500, { 'content-type': 'text/xml' }); res.end(ENV('<soapenv:Fault><faultstring>unexpected</faultstring></soapenv:Fault>'));
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  VC = { host: `http://127.0.0.1:${port}`, st };
  return VC;
}

/* ═════════════════════════ 54회차 F4 — VM 사양 변경 ═════════════════════════ */
test('F4 ① parseHardware: 못 읽은 vCPU · 코어/소켓 · 메모리 · 디스크 용량은 null(빈 값 · 수 아님 · 0 이하) — 읽은 값은 그대로', async () => {
  const { parseHardware } = await import('../src/provision/reconfig.js');
  for (const bad of [undefined, null, '', '   ', 'abc', '0', 0, '-2', '2.5', [], {}]) {
    const h = parseHardware('', { numCPU: bad, coresPerSocket: bad, memoryMB: bad });
    assert.equal(h.cpu, null, `numCPU=${JSON.stringify(bad)}`);
    assert.equal(h.coresPerSocket, null, `coresPerSocket=${JSON.stringify(bad)}`);
    assert.equal(h.memMB, null, `memoryMB=${JSON.stringify(bad)}`);
  }
  const ok = parseHardware(SCSI + DISK(2000, `<capacityInKB>${50 * 1024 * 1024}</capacityInKB>`), { numCPU: '4', coresPerSocket: '2', memoryMB: '8192' });
  assert.deepEqual([ok.cpu, ok.coresPerSocket, ok.memMB], [4, 2, 8192]);
  assert.equal(ok.disks[0].capacityGB, 50);
  const bytesOnly = parseHardware(DISK(2000, `<capacityInBytes>${20 * GiB}</capacityInBytes>`), {});
  assert.equal(bytesOnly.disks[0].capacityGB, 20, 'capacityInKB 가 없으면 capacityInBytes');
  for (const cap of ['', '<capacityInKB></capacityInKB>', '<capacityInKB>0</capacityInKB>', '<capacityInBytes>0</capacityInBytes>']) {
    const d = parseHardware(DISK(2000, cap), {}).disks[0];
    assert.equal(d.capacityKB, null, cap); assert.equal(d.capacityGB, null, cap);
  }
});

test('F4 ② buildReconfigSpec: 현재 값을 모르면 vCPU · 코어/소켓 · RAM · 디스크 증설을 막는다(fail-closed) · 아는 값은 예전 판정 그대로', async () => {
  const { parseHardware, buildReconfigSpec } = await import('../src/provision/reconfig.js');
  const unk = parseHardware(SCSI + DISK(2000, ''), { powerState: 'poweredOff' });
  const MSG = /읽지 못해 증설 여부를 판정할 수 없습니다/;
  for (const plan of [{ numCPUs: 64 }, { numCPUs: 1 }, { coresPerSocket: 2 }, { memoryMB: 262144 }, { memoryMB: 1024 }, { diskGrows: [{ key: 2000, newGB: 10 }] }]) {
    const r = buildReconfigSpec(unk, plan);
    assert.equal(r.ok, false, JSON.stringify(plan));
    assert.match(r.errors.join(' / '), MSG, JSON.stringify(plan));
    assert.equal(r.specXml, '');
  }
  // 모르는 것은 그 항목만 — 디스크 추가 · NIC 같은 다른 변경은 막지 않는다
  assert.equal(buildReconfigSpec(unk, { diskAdds: [{ sizeGB: 10 }] }).ok, true);
  // 아는 값 — 증설 통과 · 감소 차단(예전 그대로)
  const known = parseHardware(SCSI + DISK(2000, `<capacityInKB>${50 * 1024 * 1024}</capacityInKB>`), { numCPU: '4', memoryMB: '8192', powerState: 'poweredOff' });
  assert.equal(buildReconfigSpec(known, { numCPUs: 8, memoryMB: 16384, diskGrows: [{ key: 2000, newGB: 60 }] }).ok, true);
  assert.match(buildReconfigSpec(known, { numCPUs: 2 }).errors.join(), /감소는 허용되지 않습니다/);
  assert.match(buildReconfigSpec(known, { memoryMB: 4096 }).errors.join(), /감소는 허용되지 않습니다/);
  assert.match(buildReconfigSpec(known, { diskGrows: [{ key: 2000, newGB: 40 }] }).errors.join(), /증설만 가능합니다/);
});

const writeJson = (name, o) => fs.writeFileSync(path.join(DIR, name), JSON.stringify(o, null, 2));
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

test('F4 ③ 실제 라우트(가짜 vCenter): 못 읽은 VM 은 GET hardware 가 null · POST reconfig 는 400 + 문구 · ReconfigVM_Task 를 보내지 않는다 / 읽은 VM 은 예전처럼 보낸다', async () => {
  const vc = await fakeVc();
  writeJson('vcenters.json', { vcenters: [{ id: 'vc-c56', name: 'C56', host: vc.host, username: 'u', password: 'p', timeoutMs: 5000 }] });
  const { store } = await import('../src/store.js');
  store.refresh = async () => store.get();   // 성공 뒤 store.refresh() 가 실제 수집을 돌지 않게
  store.snapshot = {
    ...(store.get() || {}), source: 'live', generatedAt: new Date(NOW).toISOString(),
    vcenters: [{ id: 'vc-c56', name: 'C56', status: 'connected' }],
    vms: ['vm-1', 'vm-2'].map((m) => ({ id: `vc-c56:${m}`, vcenterId: 'vc-c56', name: `c56-${m}`, powerState: 'POWERED_OFF', host: 'esx-ok' })),
    hosts: [], datastores: [], networks: [],
  };
  const { registerCollectorsDc } = await import('../src/routes/admin/collectorsDc.js');
  const call = await serve(registerCollectorsDc, '/api/admin', { username: 'admin', role: 'admin', scope: null });

  const g = await call(`/vm/${encodeURIComponent('vc-c56:vm-1')}/hardware`);
  assert.equal(g.status, 200, JSON.stringify(g.body));
  assert.equal(g.body.hw.cpu, null, '못 읽은 vCPU 는 0 이 아니라 null');
  assert.equal(g.body.hw.memMB, null);
  assert.equal(g.body.hw.disks[0].capacityGB, null);

  for (const body of [{ numCPUs: 64 }, { memoryMB: 524288 }, { numCPUs: 1, memoryMB: 1024 }, { diskGrows: [{ key: 2000, newGB: 4000 }] }]) {
    const before = vc.st.reconfig.length;
    const r = await call(`/vm/${encodeURIComponent('vc-c56:vm-1')}/reconfig`, body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} → ${r.status} ${JSON.stringify(r.body)}`);
    assert.match(r.body.reason, /읽지 못해 증설 여부를 판정할 수 없습니다/);
    assert.equal(vc.st.reconfig.length, before, `현재 값을 모르면 vCenter 에 ReconfigVM_Task 를 보내지 않는다: ${JSON.stringify(body)}`);
  }
  // 대조군 — 읽은 VM 의 증설은 예전처럼 보내고, 감소는 예전처럼 400(보내지 않음)
  const up = await call(`/vm/${encodeURIComponent('vc-c56:vm-2')}/reconfig`, { numCPUs: 8, memoryMB: 16384 });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.equal(vc.st.reconfig.length, 1);
  assert.match(vc.st.reconfig[0], /<numCPUs>8<\/numCPUs>/);
  const down = await call(`/vm/${encodeURIComponent('vc-c56:vm-2')}/reconfig`, { numCPUs: 2 });
  assert.equal(down.status, 400);
  assert.equal(vc.st.reconfig.length, 1);
});

/* ═════════════════════════ 54회차 F5 — SOAP 호스트 용량 ═════════════════════════ */
test('F5 ① hostCapacityOf: 속성 없음 · 빈 값 · 수 아님 · 0 이하는 null · 총 MHz 는 코어 · MHz 둘 다 읽었을 때만', async () => {
  const { hostCapacityOf } = await import('../src/vcenter/soapClient.js');
  const P = (c, m, b) => ({ 'summary.hardware.numCpuCores': c, 'summary.hardware.cpuMhz': m, 'summary.hardware.memorySize': b });
  assert.deepEqual(hostCapacityOf(P('8', '2000', String(64 * GiB))), { cores: 8, mhz: 2000, cpuTotalMhz: 16000, memTotalMB: 65536 });
  for (const bad of [undefined, '', '0', '-4', 'x', '0.0']) {
    const r = hostCapacityOf(P(bad, bad, bad));
    assert.deepEqual(r, { cores: null, mhz: null, cpuTotalMhz: null, memTotalMB: null }, JSON.stringify(bad));
  }
  assert.equal(hostCapacityOf(P('8', undefined, String(GiB))).cpuTotalMhz, null, 'MHz 를 모르면 총 MHz 도 모른다(0 아님)');
  assert.equal(hostCapacityOf(P('8', '2000', '1024')).memTotalMB, null, '1MB 미만으로 반올림되면 0 이 아니라 null');
  assert.deepEqual(hostCapacityOf(), { cores: null, mhz: null, cpuTotalMhz: null, memTotalMB: null });
});

test('F5 ② 가짜 vCenter 수집: 못 읽은 용량은 null → store.hostCapacityKnown 거짓 · 사용률 null · 읽은 호스트는 예전 그대로', async () => {
  const vc = await fakeVc();
  const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
  const { hostCapacityKnown } = await import('../src/store.js');
  const s = await collectFromVCenterSoap({ id: 'vc-c56soap', name: 'soap', host: vc.host, username: 'u', password: 'p', timeoutMs: 5000 });
  const H = (n) => s.hosts.find((h) => h.name === n);
  const ok = H('esx-ok');
  assert.deepEqual([ok.cpuCores, ok.cpuTotalMhz, ok.memTotalMB, ok.cpuThreads], [8, 16000, 65536, 16]);
  assert.equal(ok.cpuUsagePct, 25); assert.equal(ok.memUsagePct, 25);
  assert.equal(hostCapacityKnown(ok), true);
  for (const n of ['esx-nohw', 'esx-zero']) {
    const h = H(n);
    assert.deepEqual([h.cpuCores, h.cpuTotalMhz, h.memTotalMB], [null, null, null], `${n} — 0 이 아니라 null`);
    assert.equal(hostCapacityKnown(h), false, `${n} — 용량 미상으로 센다`);
    assert.equal(h.cpuUsagePct, null, `${n} — 분모를 모르면 사용률 0% 가 아니다`);
    assert.equal(h.memUsagePct, null);
    assert.equal(h.cpuThreads, null, `${n} — 스레드 · 코어 둘 다 모르면 null`);
  }
  const part = H('esx-partial');
  assert.deepEqual([part.cpuCores, part.cpuTotalMhz, part.memTotalMB], [8, null, 65536]);
  assert.equal(hostCapacityKnown(part), false, 'MHz 만 못 읽어도 용량 미상(서버 판정은 세 칸)');
  assert.equal(part.cpuUsagePct, null); assert.equal(part.memUsagePct, 25);
  // 롤업: 미상 호스트는 용량 합에서 빠지고 개수로 밝힌다(store 의 기존 소비처)
  const { scopedRollups } = await import('../src/store.js');
  const snap = { vcenters: [{ id: 'vc-c56soap', status: 'connected', location: { region: 'APAC' } }], hosts: s.hosts, vms: [], datastores: [], alarms: [], networks: [] };
  const roll = scopedRollups(snap, new Set(['vc-c56soap']));
  assert.equal(roll.global.hostsCapacityUnknown, 3);
});

test('F5 ③ 용량 판정 서버(store.hostCapacityKnown) ↔ 웹(web/src/hostCapacity.js) 같은 입력에 같은 답 · 웹 virtSum 도 같은 판정', async () => {
  const { hostCapacityKnown: S } = await import('../src/store.js');
  const { hostCapacityKnown: W } = await import('../../web/src/hostCapacity.js');
  const { virtSum } = await import('../../web/src/views/vcdVirt.js');
  const VALS = [8, 0, -1, 2.5, null, undefined, '', '8', NaN, Infinity, [], {}];
  let n = 0; const hosts = [];
  for (const a of VALS) for (const b of VALS) for (const c of VALS) {
    const h = { name: `h${n++}`, cpuCores: a, cpuTotalMhz: b, memTotalMB: c };
    assert.equal(W(h), S(h), `서버 · 웹 판정이 다르다: ${JSON.stringify(h)}`);
    hosts.push(h);
  }
  for (const h of [null, undefined, {}]) assert.equal(W(h), S(h), JSON.stringify(h));
  // 55회차 기록의 차이(웹은 코어 · 메모리 둘) — MHz 만 모르는 호스트를 트리도 '미상' 으로 센다
  const v = virtSum([{ name: 'a', cpuCores: 8, cpuTotalMhz: 16000, memTotalMB: 65536 }, { name: 'b', cpuCores: 8, cpuTotalMhz: null, memTotalMB: 65536 }], new Map(), new Map());
  assert.equal(v.capUnknown, 1); assert.equal(v.cores, null); assert.equal(v.memPhys, null);
  assert.equal(virtSum(hosts, new Map(), new Map()).capUnknown, hosts.filter((h) => !S(h)).length, 'virtSum 의 미상 수 = 서버 판정의 미상 수');
});

/* ═════════════════════════ 51회차 #2 — 집중 모니터링 결과 저장 묶기 ═════════════════════════ */
const STATE = path.join(DIR, 'focusmon-audit.json');
let writes = 0; let failWrites = false;
const origRename = fs.renameSync;
fs.renameSync = function patchedRename(a, b) {   // atomicWriteFileSync 의 마지막 단계(임시 파일 → 상태 파일) — 상태 파일 쓰기 횟수를 센다
  if (String(b) === STATE) { if (failWrites) { const e = new Error('EIO: 시험용 쓰기 실패'); e.code = 'EIO'; throw e; } writes += 1; }
  return origRename.call(fs, a, b);
};
after(() => { fs.renameSync = origRename; });
const fileState = () => JSON.parse(fs.readFileSync(STATE, 'utf8'));
/** 시험마다 빈 상태에서 — 앞 시험이 남긴 상태 파일을 지우고 모듈 상태를 비운다(load 가 파일을 다시 읽는다). */
const fresh = (A) => { try { fs.rmSync(STATE, { force: true }); } catch { /* */ } A._resetForTest(); };
const tgt = (i, agent = 'edge-c56') => ({ id: `fm-c56aa${String(i).padStart(4, '0')}`, name: `c56-${i}`, host: `10.56.0.${i + 1}`, port: 22, username: 'dvcmon', agent });

test('51회차 #2 ① 엣지 동기화 한 번의 결과 8건(확인 7 + 설치 1)은 상태 파일을 한 번만 쓰고 · 그 한 번에 8건이 다 있다', async () => {
  const A = await import('../src/focusmon/audit/service.js');
  fresh(A);
  const ts = Array.from({ length: 8 }, (_, i) => tgt(i));
  const mine = new Map(ts.map((t) => [t.id, t]));
  // 설치 작업은 설치 계정을 알려 온 엣지에만 접수된다(v3.17.0)
  A.handleEdgeAudit('edge-c56', mine, { caps: ['install'], cred: { [ts[7].id]: { state: 'ok', acct: 'ops' } } }, NOW);
  const runs = ts.slice(0, 7).map((t) => A.requestAudit(t, { mode: 'check', by: 'own', now: NOW + 1000 }));
  const inst = A.requestInstall(ts[7], { by: 'own', now: NOW + 1000 });
  assert.ok(runs.every((r) => r.ok) && inst.ok, JSON.stringify([...runs, inst]));
  const results = [
    ...runs.map((r) => ({ runId: r.runId, result: { mode: 'check', ok: false, kind: 'auth', error: 'denied', ready: [] } })),
    { runId: inst.runId, result: { mode: 'install', ok: false, kind: 'done', dir: '', ready: [], install: { code: 'unreachable' } } },
  ];
  writes = 0;
  const out = A.handleEdgeAudit('edge-c56', mine, { caps: ['install'], results }, NOW + 5000);
  assert.equal(writes, 1, `결과 8건 → 상태 파일 쓰기 1번(예전 9번): ${writes}`);
  assert.equal(out.ack.length, 8);
  const f = fileState();
  for (const t of ts.slice(0, 7)) assert.equal(f.ready[t.id]?.lastError?.kind, 'auth', `${t.id} 결과가 그 한 번의 쓰기에 있다`);
  assert.equal(f.ready[ts[7].id]?.lastInstall?.code, 'unreachable', '설치 결과도 같은 쓰기에');
  assert.equal(f.jobs.length, 0, '반영한 작업은 목록에서 빠진 채로 쓰였다');
  // 묶음은 그 호출 안에서만 — 끝나면 단건 경로는 곧바로 쓴다
  writes = 0;
  assert.equal(A.requestAudit(tgt(20), { mode: 'check', by: 'own', now: NOW + 6000 }).ok, true);
  assert.equal(writes, 1, '묶음이 새지 않는다(다음 접수는 곧바로 쓴다)');
});

test('51회차 #2 ② 단건 경로(중앙 실행기의 결과 반영 · 접수)는 예전처럼 곧바로 쓴다', async () => {
  const A = await import('../src/focusmon/audit/service.js');
  fresh(A);
  // 중앙 직접 대상은 실행기 키가 없으면 접수되지 않는다 — 엣지 대상으로 작업을 만들고 결과를 단건 경로(중앙 실행기 onResult 와 같은 ingestResult 직접 호출)로 넣는다
  const e = tgt(31);
  const r = A.requestAudit(e, { mode: 'check', by: 'own', now: NOW });
  assert.equal(r.ok, true);
  writes = 0;
  const job = { runId: r.runId, tid: e.id, mode: 'check', node: '', startedAt: NOW };
  const p = A.ingestResult(job, { mode: 'check', ok: false, kind: 'timeout', ready: [] }, { node: '', now: NOW + 1000 });
  assert.equal(writes, 1, '확인 결과(동기 구간)는 호출 안에서 곧바로 쓴다');
  await p;
  assert.equal(fileState().ready[e.id].lastError.kind, 'timeout');
});

test('51회차 #2 ③ 쓰기 실패: 메모리 반영 · 응답(ack)은 예전과 같고 경고 한 번 · 묶음은 실패해도 풀린다', async (tc) => {
  const A = await import('../src/focusmon/audit/service.js');
  fresh(A);
  const ts = Array.from({ length: 3 }, (_, i) => tgt(40 + i));
  const mine = new Map(ts.map((t) => [t.id, t]));
  const runs = ts.map((t) => A.requestAudit(t, { mode: 'check', by: 'own', now: NOW }));
  const warns = [];
  tc.mock.method(console, 'warn', (...a) => { warns.push(a.join(' ')); });
  failWrites = true;
  let out;
  try {
    out = A.handleEdgeAudit('edge-c56', mine, { results: runs.map((r) => ({ runId: r.runId, result: { mode: 'check', ok: false, kind: 'hostkey', ready: [] } })) }, NOW + 2000);
  } finally { failWrites = false; }
  assert.equal(out.ack.length, 3, '응답은 그대로(던지지 않는다)');
  for (const t of ts) assert.equal(A.readinessOf(t.id)?.lastError?.kind, 'hostkey', '메모리에는 반영돼 있다(예전과 같은 순서 — 반영 뒤 쓰기)');
  assert.equal(A.activeJobs().length, 0);
  assert.equal(warns.filter((w) => w.includes('[focusmon-audit] 상태 파일을 쓰지 못했습니다')).length, 1, `경고는 한 번: ${JSON.stringify(warns)}`);
  writes = 0;
  assert.equal(A.requestAudit(tgt(49), { mode: 'check', by: 'own', now: NOW + 3000 }).ok, true);
  assert.equal(writes, 1, '실패 뒤에도 묶음이 남아 있지 않다 — 다음 쓰기는 곧바로');
  assert.equal(fileState().ready[ts[0].id].lastError.kind, 'hostkey', '다음 쓰기가 앞의 반영까지 담는다');
});

test('51회차 #2 ④ 점검(run) 결과는 DB await 뒤라 묶음 밖 — 동기화가 끝난 뒤 곧바로 쓴다(묶음이 삼키지 않는다)', async () => {
  const A = await import('../src/focusmon/audit/service.js');
  fresh(A);
  A.setSpaceProbe(() => true);   // DB 에 쓰지 않고 'DB 여유 부족' 으로 남긴다(결과 반영 경로만 본다)
  const t = tgt(50);
  const r = A.requestAudit(t, { mode: 'run', by: 'own', now: NOW });
  assert.equal(r.ok, true, JSON.stringify(r));
  writes = 0;
  A.handleEdgeAudit('edge-c56', new Map([[t.id, t]]), { results: [{ runId: r.runId, result: { mode: 'run', ok: true, kind: 'done', ran: true, ready: [], out: ['x'] } }] }, NOW + 2000);
  assert.equal(writes, 1, '동기화 안에서는 \'반영 중\' 표시를 한 번 쓴다');
  for (let i = 0; i < 50 && A.activeJobs().length; i++) await new Promise((res) => setTimeout(res, 20));
  assert.equal(A.activeJobs().length, 0, '반영이 끝났다');
  assert.equal(writes, 2, `DB await 뒤의 반영은 곧바로 쓴다: ${writes}`);
  assert.equal(fileState().ready[t.id].lastError.kind, 'db');
  A.setSpaceProbe(() => false);
});
