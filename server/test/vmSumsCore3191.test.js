/**
 * v3.19.1 — VM 할당 합(vCPU · 메모리)의 판정 코어는 vcenter/vmSums.js 하나다.
 *
 * v3.19.0 까지 같은 판정이 세 벌이었다:
 *   · /hosts 요약(routes/api/inventory.js) — vmSumsOf + '전부 못 읽음 → null' 을 라우트 안에서
 *   · 법인별 보기(vcenter/hostCorp.js) — vmSumsOf 는 불렀지만 VM 을 **전부** 못 읽어도 vCPU 0 · 비율 0 으로 냈다
 *     (요약은 '—', 법인별은 '0.0 : 1' — 같은 범위가 화면마다 달랐다). 메모리 쪽 못 읽은 수는 싣지도 않았다.
 *   · 호스트 엑셀(vcenter/hostExport.js) — 같은 규칙의 사본 vmSums
 *
 *  ① 코어 — 템플릿 제외 · null · '' · 공백 · 수 아님은 unknown · 전부 못 읽으면 null · VM 이 없으면 0
 *  ② 같은 입력(템플릿 · cpuCount/memMB null · '')에서 요약 · 법인별 · 내보내기가 같은 합과 같은 unknown 수를 낸다
 *  ③ 전부 못 읽은 법인 — 세 곳 다 null(법인별은 비율도 null · 메모리 unknown 수를 싣는다)
 *  ④ VM 이 없는 법인 — 세 곳 다 0(모름이 아니다)
 *  ⑤ 소스 — 세 파일이 vmSums.js 를 import 하고, 사본 · 라우트 안 '전부 못 읽음' 판정이 되살아나지 않는다
 */
import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIRS = [];
const tmpDir = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); TMP_DIRS.push(d); return d; };
const rmTmpDirs = () => { for (const d of TMP_DIRS) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* 정리 실패는 시험 결과가 아니다 */ } } };
after(() => { rmTmpDirs(); process.once('exit', () => { try { rmTmpDirs(); } catch { /* 종료 중 */ } }); });

const DIR = tmpDir('vmsums3191-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } });

const host = (vc, name, extra = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.3', cpuCores: 8, cpuThreads: 16, cpuTotalMhz: 20000, memTotalMB: 65536, cpuUsagePct: 10, memUsagePct: 20, ...extra });
const vm = (vc, h, id, extra = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, host: h, cluster: 'C1', powerState: 'POWERED_ON', ...extra });

// vc-a: 섞인 입력(호스트 1대 — 엑셀 호스트 행과 요약 · 법인 행을 1:1 로 대조한다)
const VMS_A = [
  vm('vc-a', 'h1', 'a1', { cpuCount: 4, memMB: 8192 }),
  vm('vc-a', 'h1', 'a2', { cpuCount: 2, memMB: 4096 }),
  vm('vc-a', 'h1', 'tpl', { cpuCount: 16, memMB: 65536, template: true, powerState: 'POWERED_OFF' }),   // 템플릿 — 세지 않는다
  vm('vc-a', 'h1', 'nullCpu', { cpuCount: null, memMB: 2048 }),                                          // vCPU 못 읽음
  vm('vc-a', 'h1', 'emptyBoth', { cpuCount: '', memMB: '' }),                                            // 둘 다 못 읽음('' 는 0 이 아니다)
  vm('vc-a', 'h1', 'memNull', { cpuCount: 1, memMB: null }),                                             // 메모리 못 읽음
];
// vc-c: VM 이 있는데 전부 못 읽음(+ 템플릿은 읽혔어도 세지 않는다)
const VMS_C = [
  vm('vc-c', 'hc', 'c1', { cpuCount: null, memMB: null }),
  vm('vc-c', 'hc', 'c2', { cpuCount: '', memMB: '' }),
  vm('vc-c', 'hc', 'ctpl', { cpuCount: 4, memMB: 4096, template: true }),
];
const SNAP = {
  source: 'live', generatedAt: new Date().toISOString(),
  vcenters: ['vc-a', 'vc-c', 'vc-d'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
  hosts: [host('vc-a', 'h1'), host('vc-c', 'hc'), host('vc-d', 'hd')],
  vms: [...VMS_A, ...VMS_C],
  datastores: [], networks: [], alarms: [],
};

let base; let CORE; let CHECKS; let HX;
before(async () => {
  const { store } = await import('../src/store.js');
  store.snapshot = { ...(store.get() || {}), ...SNAP };
  CORE = await import('../src/vcenter/vmSums.js');
  CHECKS = await import('../src/vcenter/hostChecks.js');
  HX = await import('../src/vcenter/hostExport.js');
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
const summaryOf = async (vc) => (await getJson(`/api/hosts?vcenterId=${vc}`)).summary;
const corpOf = async (vc) => { const j = await getJson(`/api/hosts/corp?vcenterId=${vc}`); assert.equal(j.corps.length, 1); return j.corps[0]; };
const exportHostOf = (vc) => {
  const out = HX.buildHostExport({ vc: SNAP.vcenters.find((v) => v.id === vc), hosts: SNAP.hosts, vms: SNAP.vms, datastores: [] }, { parts: new Set() });
  assert.equal(out.hosts.length, 1);
  return out.hosts[0];
};
const r1 = (v) => Math.round(v * 10) / 10;

test('① 코어 — 템플릿 제외 · null · 빈 글자 · 공백 · 수 아님은 unknown 으로 따로 · 전부 못 읽으면 null · VM 이 없으면 0', () => {
  const s = CORE.vmSumsOf(VMS_A);
  assert.deepEqual(s, { n: 5, on: 5, templates: 1, vcpu: 7, memMB: 14336, vcpuUnknown: 2, memUnknown: 2 });
  assert.deepEqual(CORE.vmAllocOf(s), { vcpu: 7, memMB: 14336 }, '일부만 못 읽었으면 읽은 값의 합(부분 합)');
  // 공백만인 글자 · 수가 아닌 값 · 배열 · 불리언은 0 · 1 로 더하지 않는다(Number(' ') === 0 · Number(true) === 1 함정)
  const odd = CORE.vmSumsOf([{ cpuCount: ' ', memMB: 'abc' }, { cpuCount: [], memMB: true }, { cpuCount: '4', memMB: '1024' }, null]);
  assert.deepEqual({ n: odd.n, vcpu: odd.vcpu, memMB: odd.memMB, vcpuUnknown: odd.vcpuUnknown, memUnknown: odd.memUnknown }, { n: 3, vcpu: 4, memMB: 1024, vcpuUnknown: 2, memUnknown: 2 });
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf(VMS_C)), { vcpu: null, memMB: null }, '전부 못 읽음 → null(0 아님)');
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([])), { vcpu: 0, memMB: 0 }, 'VM 없음 → 0(모름 아님)');
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([{ template: true, cpuCount: 8, memMB: 1 }])), { vcpu: 0, memMB: 0 }, '템플릿뿐 → 0');
  // vCPU 만 전부 못 읽고 메모리는 읽은 경우 — 축마다 따로 판정한다
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([{ cpuCount: null, memMB: 2048 }])), { vcpu: null, memMB: 2048 });
  assert.deepEqual(CORE.vmAllocOf(null), { vcpu: 0, memMB: 0 });
  // 0 은 읽은 값이다(못 읽음이 아니다)
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([{ cpuCount: 0, memMB: 0 }])), { vcpu: 0, memMB: 0 });
  assert.equal(CHECKS.vmSumsOf, CORE.vmSumsOf, 'hostChecks.js 는 같은 함수를 다시 내보낼 뿐이다');
  assert.equal(CHECKS.vmAllocOf, CORE.vmAllocOf);
});

test('② 섞인 입력 — 요약 · 법인별 · 내보내기가 같은 합과 같은 unknown 수를 낸다', async () => {
  const ref = CORE.vmSumsOf(VMS_A);
  const [s, c] = [await summaryOf('vc-a'), await corpOf('vc-a')];
  const x = exportHostOf('vc-a');
  // vCPU 합
  assert.equal(s.vcoreAllocated, 7); assert.equal(c.vcpu, 7); assert.equal(x.vcpu, 7);
  // vCPU 를 못 읽은 VM 수
  assert.deepEqual([s.vcpuUnknown, c.vcpuUnknown, x.vcpuUnknown], [ref.vcpuUnknown, ref.vcpuUnknown, ref.vcpuUnknown]);
  assert.equal(ref.vcpuUnknown, 2);
  // 메모리 합(요약 · 법인별은 GB 정수, 엑셀은 소수 1자리 — 같은 MB 합에서)
  assert.equal(s.vmemAllocatedGB, Math.round(ref.memMB / 1024));
  assert.equal(c.vmMemGB, Math.round(ref.memMB / 1024));
  assert.equal(x.vmMemGB, r1(ref.memMB / 1024));
  // 메모리를 못 읽은 VM 수 — 법인별도 싣는다(v3.19.0 까지 없었다)
  assert.deepEqual([s.vmemUnknown, c.vmMemUnknown, x.vmMemUnknown], [2, 2, 2]);
  // VM 수(템플릿 제외) · 템플릿
  assert.equal(c.vms, ref.n); assert.equal(x.vms, ref.n); assert.equal(x.templates, ref.templates);
  // 일부만 못 읽은 경우의 비율 — 요약 · 법인별은 읽은 합(최소값)으로 낸다(화면이 ≥ 를 붙인다). 엑셀은 비율 칸을 비운다(화면이 ≥ 로 다시 계산)
  assert.equal(s.vcorePerCore, Math.round((7 / 8) * 100) / 100);
  assert.equal(c.vcpuPerCore, Math.round((7 / 8) * 10) / 10);
  assert.equal(c.ramPct, Math.round((ref.memMB / 1024 / 64) * 100));
  assert.equal(x.cpuRatio, null); assert.equal(x.memRatio, null);
});

test('③ VM 을 전부 못 읽은 법인 — 세 곳 다 null(0 · 0 : 1 · 0% 가 아니다) · unknown 수는 같다', async () => {
  const [s, c] = [await summaryOf('vc-c'), await corpOf('vc-c')];
  const x = exportHostOf('vc-c');
  assert.deepEqual([s.vcoreAllocated, c.vcpu, x.vcpu], [null, null, null]);
  assert.deepEqual([s.vmemAllocatedGB, c.vmMemGB, x.vmMemGB], [null, null, null]);
  assert.deepEqual([s.vcorePerCore, c.vcpuPerCore, x.cpuRatio], [null, null, null], '비율도 null');
  assert.deepEqual([s.memOvercommit, c.ramPct, x.memRatio], [null, null, null]);
  assert.deepEqual([s.vcpuUnknown, c.vcpuUnknown, x.vcpuUnknown], [2, 2, 2], '템플릿은 못 읽은 수에도 넣지 않는다');
  assert.deepEqual([s.vmemUnknown, c.vmMemUnknown, x.vmMemUnknown], [2, 2, 2]);
  // 호스트 · VM 수 · 물리 용량은 읽었다 — 그 칸까지 null 로 만들지 않는다
  assert.equal(c.hosts, 1); assert.equal(c.vms, 2); assert.equal(c.cores, 8); assert.equal(c.capUnknown, 0);
  // 클러스터 줄도 같은 판정
  assert.equal(c.clusters.length, 1);
  const cl = c.clusters[0];
  assert.deepEqual([cl.vcpu, cl.vmMemGB, cl.vcpuPerCore, cl.ramPct, cl.vcpuUnknown, cl.vmMemUnknown], [null, null, null, null, 2, 2]);
});

test('④ VM 이 없는 법인 — 세 곳 다 0(모름이 아니다)', async () => {
  const [s, c] = [await summaryOf('vc-d'), await corpOf('vc-d')];
  const x = exportHostOf('vc-d');
  assert.deepEqual([s.vcoreAllocated, c.vcpu, x.vcpu], [0, 0, 0]);
  assert.deepEqual([s.vmemAllocatedGB, c.vmMemGB, x.vmMemGB], [0, 0, 0]);
  assert.deepEqual([s.vcpuUnknown, c.vcpuUnknown, x.vcpuUnknown], [0, 0, 0]);
  assert.deepEqual([s.vmemUnknown, c.vmMemUnknown, x.vmMemUnknown], [0, 0, 0]);
  assert.equal(c.vcpuPerCore, 0); assert.equal(c.ramPct, 0);
});

test('⑤ 소스 — 세 곳이 vmSums.js 하나를 쓰고, 사본 · 인라인 판정이 되살아나지 않는다', () => {
  const read = (rel) => stripComments(fs.readFileSync(path.join(HERE, '..', 'src', rel), 'utf8'));
  for (const rel of ['routes/api/inventory.js', 'vcenter/hostCorp.js', 'vcenter/hostExport.js']) {
    const src = read(rel);
    assert.match(src, /import \{[^}]*\bvmSumsOf\b[^}]*\bvmAllocOf\b[^}]*\} from '[^']*\/vmSums\.js'/, `${rel}: vmSums.js 에서 vmSumsOf · vmAllocOf 를 import`);
    assert.ok(!/function vmSums\s*\(/.test(src), `${rel}: 합 사본(function vmSums)이 없다`);
    // '전부 못 읽음' 판정(unknown 수 === VM 수)은 vmSums.js 에만 있다
    assert.ok(!/(?:vcpuUnknown|memUnknown)\s*===/.test(src), `${rel}: '전부 못 읽음' 판정을 따로 하지 않는다`);
    // 못 읽은 값을 0 으로 더하는 식(cpuCount || 0)이 없다. v3.19.2: inventory.js 는 파일 전체를 본다 — 같은 파일의 /summary(OS 별 · vCenter 별 · 전체 합,
    //   템플릿 포함)도 같은 코어를 쓰게 됐다(v3.19.1 에서는 '남긴 것' 이라 /hosts 핸들러만 봤다 — 회귀 summaryVmSums3192.test.js).
    const scope = src;
    if (rel === 'routes/api/inventory.js') {
      const i = src.indexOf("api.get('/hosts', invHosts");
      assert.ok(i >= 0, '/hosts 핸들러를 찾는다');
      const j = src.indexOf('api.get(', i + 10);
      assert.ok(src.slice(i, j < 0 ? undefined : j).includes('vmAllocOf('), '/hosts 핸들러가 vmAllocOf 를 부른다');
    }
    assert.ok(!/cpuCount\s*\|\|\s*0|memMB\s*\|\|\s*0/.test(scope), `${rel}: 못 읽은 값을 0 으로 더하지 않는다`);
  }
  // 코어는 다른 도메인 모듈을 부르지 않는다(hostChecks.js → hostExport.js 방향과 순환이 되지 않게)
  const core = read('vcenter/vmSums.js');
  const imports = [...core.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['../util/numOrNull.js']);
  assert.ok(!/function vmSumsOf/.test(read('vcenter/hostChecks.js')), 'hostChecks.js 에 합 구현이 남아 있지 않다');
});
