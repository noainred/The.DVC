// v2.783(점검 Q1 J-B1): SOAP 수집기가 못 읽은 구동 VM 의 CPU·메모리 사용률을 0 이 아니라 null 로 낸다.
//   끊긴 호스트·VM connectionState 가 connected 아님·quickStats 결측·분모 0(호스트 MHz 모름·memMB 0) → null.
//   연결된 호스트의 '보고된 0' 과 꺼진 VM 의 0 은 그대로. 실제 collectFromVCenterSoap 을 가짜 vCenter 에 붙여 호출한다(audit2719d 와 같은 하네스).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'audit2783a-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.SSRF_ALLOW_LOOPBACK = 'true';   // 가짜 vCenter(127.0.0.1) 접속용 — 이 테스트 전용

const closers = [];
after(async () => { for (const c of closers) await c(); fs.rmSync(DIR, { recursive: true, force: true }); });

const env = (inner) => '<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Body>' + inner + '</soapenv:Body></soapenv:Envelope>';
const SC = env('<RetrieveServiceContentResponse xmlns="urn:vim25"><returnval>'
  + '<rootFolder type="Folder">group-d1</rootFolder><propertyCollector type="PropertyCollector">propertyCollector</propertyCollector>'
  + '<viewManager type="ViewManager">ViewManager</viewManager><sessionManager type="SessionManager">SessionManager</sessionManager>'
  + '<about><version>8.0.2</version><build>1</build><fullName>VMware vCenter Server 8.0.2</fullName><apiVersion>8.0.2.0</apiVersion></about>'
  + '</returnval></RetrieveServiceContentResponse>');
const ps = (name, val) => `<propSet><name>${name}</name><val>${val}</val></propSet>`;
const obj = (type, ref, props) => `<returnval><obj type="${type}">${ref}</obj>${props}</returnval>`;
const hostXml = (ref, name, conn, mhz = '2000') => obj('HostSystem', ref, ps('name', name) + ps('runtime.connectionState', conn)
  + ps('summary.hardware.numCpuCores', '8') + (mhz == null ? '' : ps('summary.hardware.cpuMhz', mhz)) + ps('summary.hardware.memorySize', String(64 * 1024 ** 3)));
/** VM — numCpu 2 · 8192MB. cpu/mem 이 undefined 면 quickStats 속성을 싣지 않는다. */
const vmXml = (ref, name, hostRef, { power = 'poweredOn', conn, cpu, mem, numCpu = '2', memMB = '8192' } = {}) => obj('VirtualMachine', ref,
  ps('name', name) + ps('runtime.host', hostRef) + ps('runtime.powerState', power) + ps('summary.config.template', 'false')
  + ps('summary.config.numCpu', numCpu) + ps('summary.config.memorySizeMB', memMB)
  + (conn ? ps('runtime.connectionState', conn) : '')
  + (cpu === undefined ? '' : ps('summary.quickStats.overallCpuUsage', cpu))
  + (mem === undefined ? '' : ps('summary.quickStats.guestMemoryUsage', mem)));

const INV = env('<RetrievePropertiesResponse xmlns="urn:vim25">'
  + hostXml('host-1', 'esx-ok', 'connected')
  + hostXml('host-2', 'esx-down', 'disconnected')
  + hostXml('host-3', 'esx-nr', 'notResponding')
  + hostXml('host-4', 'esx-nomhz', 'connected', null)
  // 정상: 연결된 호스트 · 2vCPU × 2000MHz = 4000MHz 중 1000 → 25% · 8192MB 중 2048 → 25%
  + vmXml('vm-1', 'ok', 'host-1', { conn: 'connected', cpu: '1000', mem: '2048' })
  // 연결된 호스트의 '보고된 0' 은 값이다
  + vmXml('vm-2', 'idle', 'host-1', { conn: 'connected', cpu: '0', mem: '0' })
  // quickStats 결측(속성 없음 · 빈 값)
  + vmXml('vm-3', 'nostats', 'host-1', { conn: 'connected' })
  + vmXml('vm-4', 'emptystats', 'host-1', { conn: 'connected', cpu: '', mem: '' })
  // 끊긴 호스트 · 응답 없는 호스트 — vCenter 가 0 을 줘도 믿지 않는다
  + vmXml('vm-5', 'onDownHost', 'host-2', { conn: 'disconnected', cpu: '0', mem: '0' })
  + vmXml('vm-6', 'onNrHost', 'host-3', { cpu: '0', mem: '0' })
  // VM 자체가 connected 아님(호스트는 연결)
  + vmXml('vm-7', 'orphan', 'host-1', { conn: 'orphaned', cpu: '0', mem: '0' })
  // 분모 0 — 호스트 MHz 모름(CPU 만 null) · memMB 0(메모리만 null)
  + vmXml('vm-8', 'noMhz', 'host-4', { conn: 'connected', cpu: '500', mem: '1024' })
  + vmXml('vm-9', 'noMem', 'host-1', { conn: 'connected', cpu: '1000', mem: '100', memMB: '0' })
  // 꺼진 VM 의 0 은 그대로(끊긴 호스트여도)
  + vmXml('vm-10', 'off', 'host-1', { power: 'poweredOff', conn: 'connected' })
  + vmXml('vm-11', 'offDown', 'host-2', { power: 'poweredOff', conn: 'disconnected' })
  + obj('ClusterComputeResource', 'domain-c1', ps('name', 'cl'))
  + '</RetrievePropertiesResponse>');

async function fakeVc() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      const ok = (x) => { res.writeHead(200, { 'content-type': 'text/xml' }); res.end(x); };
      if (b.includes('<RetrieveServiceContent')) return ok(SC);
      if (b.includes('<Login ')) return ok(env('<LoginResponse xmlns="urn:vim25"><returnval><key>s</key></returnval></LoginResponse>'));
      if (b.includes('<Logout')) return ok(env('<LogoutResponse xmlns="urn:vim25"/>'));
      if (b.includes('<CreateContainerView')) return ok(env('<CreateContainerViewResponse xmlns="urn:vim25"><returnval type="ContainerView">session[1]view-1</returnval></CreateContainerViewResponse>'));
      if (b.includes('<RetrieveProperties')) return ok(INV);
      res.writeHead(500, { 'content-type': 'text/xml' }); res.end(env('<soapenv:Fault><faultstring>unexpected</faultstring></soapenv:Fault>'));
    });
  });
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  return `http://127.0.0.1:${port}`;
}

let snapP = null;
const collect = async () => {
  if (!snapP) {
    snapP = (async () => {
      const { collectFromVCenterSoap } = await import('../src/vcenter/soapClient.js');
      const host = await fakeVc();
      return collectFromVCenterSoap({ id: 'vc-2783a', name: 'fake', host, username: 'u', password: 'p', timeoutMs: 5000 });
    })();
  }
  return snapP;
};
const vmOf = (s, name) => { const v = s.vms.find((x) => x.name === name); assert.ok(v, `VM ${name} 없음`); return v; };

test('J-B1 연결된 호스트의 정상값·보고된 0 은 값이다', async () => {
  const s = await collect();
  assert.equal(vmOf(s, 'ok').cpuUsagePct, 25);
  assert.equal(vmOf(s, 'ok').memUsagePct, 25);
  assert.equal(vmOf(s, 'idle').cpuUsagePct, 0, '보고된 0 은 null 이 아니다');
  assert.equal(vmOf(s, 'idle').memUsagePct, 0);
});

test('J-B1 quickStats 결측(속성 없음·빈 값)은 null', async () => {
  const s = await collect();
  for (const n of ['nostats', 'emptystats']) {
    assert.equal(vmOf(s, n).cpuUsagePct, null, `${n} cpu`);
    assert.equal(vmOf(s, n).memUsagePct, null, `${n} mem`);
  }
});

test('J-B1 끊긴·응답 없는 호스트, connected 아닌 VM 은 vCenter 가 0 을 줘도 null', async () => {
  const s = await collect();
  for (const n of ['onDownHost', 'onNrHost', 'orphan']) {
    assert.equal(vmOf(s, n).powerState, 'POWERED_ON');
    assert.equal(vmOf(s, n).cpuUsagePct, null, `${n} cpu`);
    assert.equal(vmOf(s, n).memUsagePct, null, `${n} mem`);
  }
  // 호스트 쪽 표지는 그대로(이번 수정은 VM 경로만)
  assert.equal(s.hosts.find((h) => h.name === 'esx-down').connectionState, 'DISCONNECTED');
});

test('J-B1 분모 0 — 호스트 MHz 모름이면 CPU 만, memMB 0 이면 메모리만 null', async () => {
  const s = await collect();
  assert.equal(vmOf(s, 'noMhz').cpuUsagePct, null);
  assert.equal(vmOf(s, 'noMhz').memUsagePct, 13, '메모리 분모는 있으므로 값(1024/8192 = 12.5 → 13)');
  assert.equal(vmOf(s, 'noMem').memUsagePct, null);
  assert.equal(vmOf(s, 'noMem').cpuUsagePct, 25);
});

test('J-B1 꺼진 VM 의 0 은 그대로(끊긴 호스트여도)', async () => {
  const s = await collect();
  for (const n of ['off', 'offDown']) {
    assert.equal(vmOf(s, n).cpuUsagePct, 0, `${n} cpu`);
    assert.equal(vmOf(s, n).memUsagePct, 0, `${n} mem`);
  }
});

test('J-B1 vmUsagePctOrNull 단위 — 보고된 0 유지 · 결측·분모≤0·못 믿음은 null', async () => {
  const { vmUsagePctOrNull } = await import('../src/vcenter/soapClient.js');
  assert.equal(vmUsagePctOrNull('0', 4000), 0);
  assert.equal(vmUsagePctOrNull('1000', 4000), 25);
  assert.equal(vmUsagePctOrNull(undefined, 4000), null);
  assert.equal(vmUsagePctOrNull('', 4000), null);
  assert.equal(vmUsagePctOrNull('abc', 4000), null);
  assert.equal(vmUsagePctOrNull('100', 0), null);
  assert.equal(vmUsagePctOrNull('100', -1), null);
  assert.equal(vmUsagePctOrNull('100', NaN), null);
  assert.equal(vmUsagePctOrNull('100', 400, false), null);
});

test('J-B1 소비처: 분포는 미수집(na)으로 · 유휴 VM 후보·평균에서 빠진다', async () => {
  const s = await collect();
  const on = s.vms.filter((v) => v.powerState === 'POWERED_ON');
  const { vmDistribution } = await import('../src/inventory/vmDist.js');
  const d = vmDistribution(s.vms, {});
  // CPU 를 읽은 구동 VM: ok(25) · idle(0) · noMem(25) — 나머지 6대(nostats·emptystats·onDownHost·onNrHost·orphan·noMhz)는 na
  assert.equal(d.cpu.na, 6, JSON.stringify(d.cpu));
  assert.equal(d.cpu.bins[0], 1, '0~5% 칸에는 보고된 0(idle) 하나만');
  // 유휴 VM 후보(toolsAnalytics 식 — cpu<5 · mem<20, 모르면 ?? 100 으로 빠짐): idle 하나뿐
  const idle = on.filter((v) => (v.cpuUsagePct ?? 100) < 5 && (v.memUsagePct ?? 100) < 20).map((v) => v.name);
  assert.deepEqual(idle, ['idle']);
});
