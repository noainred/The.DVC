/**
 * v3.19.0 — 호스트 화면 위 요약(GET /hosts summary)의 할당 vCore · VM 메모리 합이 점검 표 · 법인별 보기와 같은 판정 코어
 *   (vcenter/hostChecks.js vmSumsOf)를 쓰는가.
 *
 * 예전 /hosts 요약은 `v.cpuCount || 0` 으로 템플릿까지 더하고 못 읽은 cpuCount 를 0 으로 더했다 — 같은 범위의 vCore 비율이
 * 요약 타일과 법인별 보기에서 서로 다르게 나왔다(목 데이터 1.72 대 1.62).
 *
 *  ① 템플릿 · cpuCount null · '' · memMB null 이 섞인 입력: 요약 합 = vmSumsOf 합, 못 읽은 VM 수는 vcpuUnknown · vmemUnknown 으로 따로
 *     · 다른 사이트의 동명 호스트 VM 은 섞이지 않는다((vcenterId, host) 키 — 예전 규칙 유지)
 *  ② VM 이 있는데 하나도 못 읽었으면 합 · 비율은 0 이 아니라 null(모름)
 *  ③ VM 이 없는 범위는 0(모름이 아니다)
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('hostsum3190-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } });

const host = (vc, name, extra = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.3', cpuCores: 8, cpuThreads: 16, cpuTotalMhz: 20000, memTotalMB: 65536, ...extra });
const vm = (vc, h, id, extra = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, host: h, cluster: 'C1', powerState: 'POWERED_ON', ...extra });

const VMS_A = [
  vm('vc-a', 'h1', 'a1', { cpuCount: 4, memMB: 8192 }),
  vm('vc-a', 'h2', 'a2', { cpuCount: 2, memMB: 4096 }),
  vm('vc-a', 'h1', 'tpl', { cpuCount: 16, memMB: 65536, template: true, powerState: 'POWERED_OFF' }),   // 템플릿 — 세지 않는다
  vm('vc-a', 'h1', 'nullCpu', { cpuCount: null, memMB: 2048 }),                                          // vCPU 못 읽음
  vm('vc-a', 'h2', 'emptyCpu', { cpuCount: '', memMB: '' }),                                             // 둘 다 못 읽음('' 는 0 이 아니다)
  vm('vc-a', 'h2', 'memNull', { cpuCount: 1, memMB: null }),                                             // 메모리 못 읽음
];
const SNAP = {
  source: 'live', generatedAt: new Date().toISOString(),
  vcenters: ['vc-a', 'vc-b', 'vc-c', 'vc-d'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
  hosts: [host('vc-a', 'h1'), host('vc-a', 'h2'), host('vc-b', 'h1'), host('vc-c', 'hc'), host('vc-d', 'hd')],
  vms: [
    ...VMS_A,
    vm('vc-b', 'h1', 'b1', { cpuCount: 8, memMB: 8192 }),                                                 // 다른 사이트의 동명 호스트 h1
    vm('vc-c', 'hc', 'c1', { cpuCount: null, memMB: null }),                                               // 전부 못 읽음
    vm('vc-c', 'hc', 'ctpl', { cpuCount: 4, memMB: 4096, template: true }),
  ],
  datastores: [], networks: [], alarms: [],
};

let base; let vmSumsOf;
before(async () => {
  const { store } = await import('../src/store.js');
  store.snapshot = { ...(store.get() || {}), ...SNAP };
  ({ vmSumsOf } = await import('../src/vcenter/hostChecks.js'));
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const summaryOf = async (vc) => {
  const r = await fetch(`${base}/api/hosts?vcenterId=${vc}`);
  assert.equal(r.status, 200);
  return (await r.json()).summary;
};

test('① 템플릿 · 못 읽은 cpuCount(null · \'\') · memMB(null · \'\') — 요약 합은 vmSumsOf 와 같고 못 읽은 수는 따로', async () => {
  const s = await summaryOf('vc-a');
  const ref = vmSumsOf(VMS_A);
  assert.deepEqual({ vcpu: ref.vcpu, memMB: ref.memMB, vcpuUnknown: ref.vcpuUnknown, memUnknown: ref.memUnknown, templates: ref.templates },
    { vcpu: 7, memMB: 14336, vcpuUnknown: 2, memUnknown: 2, templates: 1 }, '전제: 판정 코어의 기대값');
  assert.equal(s.vcoreAllocated, ref.vcpu, '템플릿(16) · 못 읽은 것을 더하지 않는다 — 예전 식은 23 이었다');
  assert.equal(s.vcpuUnknown, ref.vcpuUnknown);
  assert.equal(s.vmemAllocatedGB, Math.round(ref.memMB / 1024));
  assert.equal(s.vmemUnknown, ref.memUnknown);
  assert.equal(s.physicalCores, 16);
  assert.equal(s.vcorePerCore, Math.round((7 / 16) * 100) / 100, 'vCore 비율도 같은 합에서');
  assert.equal(s.memOvercommit, Math.round((14336 / 131072) * 100) / 100);
  assert.equal(s.hostsCapacityUnknown, 0);
});

test('① 다른 사이트의 동명 호스트 VM 은 섞이지 않는다(전체 범위 합 = 사이트별 vmSumsOf 합)', async () => {
  const all = await (await fetch(`${base}/api/hosts`)).json();
  const ref = vmSumsOf(SNAP.vms.filter((v) => v.vcenterId !== 'vc-d'));
  assert.equal(all.summary.vcoreAllocated, ref.vcpu, '7 + 8(vc-b) + 0(vc-c 는 못 읽음)');
  assert.equal(all.summary.vcpuUnknown, ref.vcpuUnknown);
  assert.equal(all.summary.vmemUnknown, ref.memUnknown);
  const b = await summaryOf('vc-b');
  assert.equal(b.vcoreAllocated, 8);
  assert.equal(b.vcpuUnknown, 0);
});

test('② VM 이 있는데 하나도 못 읽었으면 합 · 비율은 null(0 이 아니다)', async () => {
  const s = await summaryOf('vc-c');
  assert.equal(s.vcoreAllocated, null);
  assert.equal(s.vcorePerCore, null);
  assert.equal(s.vmemAllocatedGB, null);
  assert.equal(s.memOvercommit, null);
  assert.equal(s.vcpuUnknown, 1, '템플릿은 못 읽은 수에도 넣지 않는다');
  assert.equal(s.vmemUnknown, 1);
});

test('③ VM 이 없는 범위는 0(모름이 아니다)', async () => {
  const s = await summaryOf('vc-d');
  assert.equal(s.vcoreAllocated, 0);
  assert.equal(s.vcpuUnknown, 0);
  assert.equal(s.vcorePerCore, 0);
  assert.equal(s.vmemAllocatedGB, 0);
});
