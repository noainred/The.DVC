/**
 * v3.19.2 — 호스트 표 · 상세 · 드로어의 'VM' 묶음(/hosts/checks 의 byId[id].vm)도 vmAllocOf 를 거친다.
 *
 * v3.19.1 에서 /hosts 요약 · 법인별 · 호스트 엑셀은 판정 코어(vcenter/vmSums.js) 하나를 쓰게 됐지만, 호스트 한 대의 'VM' 묶음만 원래 합(vmSumsOf)을 그대로 실었다.
 * 그래서 VM 을 **전부** 못 읽은 호스트가 호스트 표에서 '0+?', 상세에서 '0' · '0.0 : 1', 드로어에서 'vCPU 0 할당 이상' 으로 보였다(같은 범위의 요약 · 법인별은 '—').
 *
 *  ① 순수 — 전부 못 읽음: vcpu · memMB null(unknown 수 · n 은 그대로) / 일부 못 읽음: 읽은 값의 합 + unknown 수 / VM 없음: 0(모름이 아니다) · 템플릿만 있어도 0
 *  ② vCPU 만 · 메모리만 전부 못 읽은 호스트 — 못 읽은 쪽만 null
 *  ③ 실제 라우트 GET /hosts/checks — 같은 세 경우 · 같은 호스트의 /hosts 요약 · 법인별과 null 여부가 같다
 *  ④ 소스 — hostChecksOf 가 원래 합을 그대로 싣지 않는다 · 판정(unknown === n)은 vmSums.js 에만 있다
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hostvm3192-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => {
  for (const c of closers) { try { await c(); } catch { /* */ } }
  try { fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ }
});

const host = (vc, name, extra = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.3', cpuCores: 8, cpuThreads: 16, cpuTotalMhz: 20000, memTotalMB: 65536, cpuUsagePct: 10, memUsagePct: 20, ...extra });
const vm = (vc, h, id, extra = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, host: h, cluster: 'C1', powerState: 'POWERED_ON', ...extra });

// vCenter 하나에 호스트 하나씩 — /hosts 요약 · 법인별(vCenter 단위)과 호스트 한 대를 1:1 로 대조한다.
const VMS = [
  // vc-all/h-all: VM 이 있는데 전부 못 읽음(null · '' · 공백 · 수 아님) + 템플릿은 읽혔어도 세지 않는다
  vm('vc-all', 'h-all', 'a1', { cpuCount: null, memMB: null }),
  vm('vc-all', 'h-all', 'a2', { cpuCount: '', memMB: '   ', powerState: 'POWERED_OFF' }),
  vm('vc-all', 'h-all', 'a3', { cpuCount: 'x', memMB: undefined }),
  vm('vc-all', 'h-all', 'atpl', { cpuCount: 4, memMB: 4096, template: true }),
  // vc-part/h-part: 일부만 못 읽음
  vm('vc-part', 'h-part', 'p1', { cpuCount: 4, memMB: 8192 }),
  vm('vc-part', 'h-part', 'p2', { cpuCount: null, memMB: 4096 }),
  vm('vc-part', 'h-part', 'p3', { cpuCount: 2, memMB: '' }),
  // vc-cpu/h-cpu: vCPU 만 전부 못 읽음 · vc-mem/h-mem: 메모리만 전부 못 읽음
  vm('vc-cpu', 'h-cpu', 'c1', { cpuCount: null, memMB: 2048 }),
  vm('vc-cpu', 'h-cpu', 'c2', { cpuCount: '', memMB: 2048 }),
  vm('vc-mem', 'h-mem', 'm1', { cpuCount: 2, memMB: null }),
  // vc-tpl/h-tpl: 템플릿만 — 켤 수 있는 VM 이 없다(0 이지 모름이 아니다)
  vm('vc-tpl', 'h-tpl', 'ttpl', { cpuCount: null, memMB: null, template: true }),
  // vc-none/h-none: VM 없음
];
const VCS = ['vc-all', 'vc-part', 'vc-cpu', 'vc-mem', 'vc-tpl', 'vc-none'];
const HOSTS = [host('vc-all', 'h-all'), host('vc-part', 'h-part'), host('vc-cpu', 'h-cpu'), host('vc-mem', 'h-mem'), host('vc-tpl', 'h-tpl'), host('vc-none', 'h-none')];
const SNAP = { source: 'live', generatedAt: new Date().toISOString(), vcenters: VCS.map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
  hosts: HOSTS, vms: VMS, datastores: [], networks: [], alarms: [] };

let base; let CORE; let CHECKS;
before(async () => {
  const { store } = await import('../src/store.js');
  const prev = store.snapshot;
  store.snapshot = { ...(store.get() || {}), ...SNAP };
  closers.push(async () => { store.snapshot = prev; });
  CORE = await import('../src/vcenter/vmSums.js');
  CHECKS = await import('../src/vcenter/hostChecks.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const getJson = async (p) => { const r = await fetch(`${base}${p}`); assert.equal(r.status, 200, p); return r.json(); };
const pureVm = (vc, name) => CHECKS.hostChecksOf(HOSTS.filter((h) => h.vcenterId === vc), { vmsByHost: CHECKS.vmsByHostOf(VMS) }).byId[`${vc}:${name}`].vm;

test('① 순수 — 전부 못 읽음 null · 일부 못 읽음 읽은 값의 합 · VM 없음 0(템플릿만 있어도 0)', () => {
  assert.deepEqual(pureVm('vc-all', 'h-all'), { n: 3, on: 2, templates: 1, vcpu: null, memMB: null, vcpuUnknown: 3, memUnknown: 3 },
    '전부 못 읽음 — 합은 0 이 아니라 null · 수와 unknown 수는 그대로(화면이 "VM 3대 모두 못 읽음" 을 적는다)');
  assert.deepEqual(pureVm('vc-part', 'h-part'), { n: 3, on: 3, templates: 0, vcpu: 6, memMB: 12288, vcpuUnknown: 1, memUnknown: 1 },
    '일부 못 읽음 — 읽은 값의 합(최소값) + unknown 수');
  const zero = { n: 0, on: 0, templates: 0, vcpu: 0, memMB: 0, vcpuUnknown: 0, memUnknown: 0 };
  assert.deepEqual(pureVm('vc-none', 'h-none'), zero, 'VM 없음 — 0(모름이 아니다)');
  assert.deepEqual(pureVm('vc-tpl', 'h-tpl'), { ...zero, templates: 1 }, '템플릿만 — 켤 수 있는 VM 이 없으니 0(템플릿의 못 읽은 값은 세지 않는다)');
  // vmsByHost 를 안 넘긴 호출(예전 호출부)도 0 — null 이 아니다
  assert.deepEqual(CHECKS.hostChecksOf([HOSTS[0]], {}).byId['vc-all:h-all'].vm, zero);
  // 묶음은 코어 둘의 합성일 뿐이다 — 같은 입력에서 vmSumsOf + vmAllocOf 와 같다
  const vms = VMS.filter((v) => v.host === 'h-part');
  const sum = CORE.vmSumsOf(vms);
  assert.deepEqual(CHECKS.hostVmOf(vms), { ...sum, ...CORE.vmAllocOf(sum) });
  assert.deepEqual(Object.keys(CHECKS.hostVmOf([])).sort(), Object.keys(sum).sort(), '키는 v3.19.1 과 같다(값만 null 일 수 있다)');
});

test('② vCPU 만 · 메모리만 전부 못 읽은 호스트 — 못 읽은 쪽만 null', () => {
  const cpu = pureVm('vc-cpu', 'h-cpu');
  assert.equal(cpu.vcpu, null); assert.equal(cpu.memMB, 4096); assert.equal(cpu.vcpuUnknown, 2); assert.equal(cpu.memUnknown, 0);
  const mem = pureVm('vc-mem', 'h-mem');
  assert.equal(mem.vcpu, 2); assert.equal(mem.memMB, null); assert.equal(mem.memUnknown, 1);
});

test('③ 실제 라우트 /hosts/checks — 세 경우 · 같은 범위의 /hosts 요약 · 법인별과 null 여부가 같다', async () => {
  const all = await getJson('/api/hosts/checks');
  assert.equal(all.hosts, HOSTS.length);
  for (const [vc, name] of [['vc-all', 'h-all'], ['vc-part', 'h-part'], ['vc-cpu', 'h-cpu'], ['vc-mem', 'h-mem'], ['vc-tpl', 'h-tpl'], ['vc-none', 'h-none']]) {
    const c = all.byId[`${vc}:${name}`].vm;
    assert.deepEqual(c, pureVm(vc, name), `${name}: 라우트 응답 = 순수 함수`);
    const s = (await getJson(`/api/hosts?vcenterId=${vc}`)).summary;
    const corp = (await getJson(`/api/hosts/corp?vcenterId=${vc}`)).corps[0];
    assert.equal(c.vcpu, s.vcoreAllocated, `${name}: vCPU 합 — 호스트 표 묶음 = /hosts 요약`);
    assert.equal(c.vcpu, corp.vcpu, `${name}: vCPU 합 — 호스트 표 묶음 = 법인별`);
    assert.equal(c.vcpuUnknown, s.vcpuUnknown, `${name}: vCPU unknown 수`);
    assert.equal(c.memMB == null, s.vmemAllocatedGB == null, `${name}: 메모리 null 여부 — /hosts 요약`);
    assert.equal(c.memMB == null, corp.vmMemGB == null, `${name}: 메모리 null 여부 — 법인별`);
    assert.equal(c.memUnknown, s.vmemUnknown, `${name}: 메모리 unknown 수`);
  }
  // JSON 으로 나간 값이 실제 null 이다(키가 빠지거나 0 이 되지 않는다)
  const raw = await (await fetch(`${base}/api/hosts/checks?vcenterId=vc-all`)).text();
  assert.match(raw, /"vcpu":null/); assert.match(raw, /"memMB":null/);
  assert.equal(all.byId['vc-none:h-none'].vm.vcpu, 0); assert.equal(all.byId['vc-none:h-none'].vm.memMB, 0);
});

test('④ 소스 — hostChecksOf 가 원래 합을 그대로 싣지 않고, "전부 못 읽음" 판정은 vmSums.js 에만 있다', () => {
  const read = (rel) => stripComments(fs.readFileSync(path.join(HERE, '..', 'src', rel), 'utf8'));
  const checks = read('vcenter/hostChecks.js');
  assert.ok(!/c\.vm\s*=\s*vmSumsOf\(/.test(checks), 'c.vm 에 vmSumsOf 결과를 그대로 싣지 않는다');
  assert.match(checks, /c\.vm\s*=\s*hostVmOf\(/);
  assert.match(checks, /vmAllocOf\(sum\)/, 'hostVmOf 는 vmAllocOf 를 부른다');
  // 판정식(unknown 수 === n)은 코어에만 — hostChecks.js · 라우트에 사본이 없다
  const judge = /Unknown\s*={2,3}\s*[\w.]*\bn\b|\bn\s*={2,3}\s*[\w.]*Unknown/;
  assert.match(read('vcenter/vmSums.js'), judge, '판정식은 코어에 있다');
  for (const f of ['vcenter/hostChecks.js', 'routes/api/hostChecks.js']) assert.ok(!judge.test(read(f)), `${f} 에 판정 사본이 없다`);
});
