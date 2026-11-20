/**
 * v3.19.2 — /summary 의 VM 할당 합(vCPU · 메모리)도 판정 코어 vcenter/vmSums.js 를 쓴다(v3.19.1 '남긴 것 ②').
 *
 * v3.19.1 까지 /summary 의 세 합(전체 allocation · OS 별 osAllocation · vCenter 별 byVcenter)과 공개 API /inventory/summary 의
 * vmVcpu · vmRamMB 는 못 읽은 cpuCount · memMB(null · '')를 **0 으로 더했다**(`v.cpuCount || 0` · `sum(vms, …)`).
 * 같은 블록의 저장 용량은 v2.727 부터 못 읽은 수를 따로 세는데(storageUnknown) vCPU · 메모리만 표지 없는 부분 합이었고,
 * VM 을 하나도 못 읽은 vCenter · OS 는 '할당 0 · 0 : 1' 로 보였다.
 *
 *  ① 코어 — includeTemplates 는 템플릿도 n · 합에 넣는다(기본 동작은 v3.19.1 그대로) · vmSumAdd 한 대씩
 *  ② /summary 전체 합 — 읽은 VM 만(템플릿 포함) + vcpuUnknown · ramUnknown · 비율은 읽은 값으로
 *  ③ vCenter 별 — 섞인 vCenter 는 부분 합 + 수, 전부 못 읽은 vCenter 는 null(0 이 아니다), VM 없는 vCenter 는 0
 *  ④ OS 별 — 같은 규칙 · kind 필터(템플릿만 · VM 만)가 그대로 듣는다 · null 행은 뒤로
 *  ⑤ 범위를 좁혀 전부 못 읽은 경우 — 전체 합 · 두 비율이 null
 *  ⑥ 공개 API — 값 · 타입은 그대로(수)이고 vmVcpuUnknown · vmRamUnknown 만 는다 · 내부 /summary 와 같은 합 · 같은 수
 *  ⑦ 전부 읽은 입력이면 예전 식(0 으로 더하기)과 값이 같다(기존 소비자 불변)
 *  ⑧ 소스 — /summary · 공개 API 에 '0 으로 더하는 식' 이 없고, 허용 목록 · 문서에 새 필드가 있다
 *
 * 변이 확인(수정 전 판본 = v3.19.1 adfdce73 의 inventory.js · publicApi.js 로 되돌려 실행): ② ~ ⑧ 실패(⑦ 은 unknown 필드가 없어서) · ① 통과.
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

const DIR = tmpDir('sumvm3192-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } });

const host = (vc, name, extra = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.3', cpuCores: 8, cpuThreads: 16, cpuTotalMhz: 20000, memTotalMB: 65536, cpuUsagePct: 10, memUsagePct: 20, ...extra });
const vm = (vc, id, guestOS, extra = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, host: 'h', cluster: 'C1', powerState: 'POWERED_ON', guestOS, storageGB: 10, ...extra });
const WIN = 'Microsoft Windows Server 2019 (64-bit)'; const RHEL = 'Red Hat Enterprise Linux 8 (64-bit)'; const UBU = 'Ubuntu Linux (64-bit)';

// vc-a: 섞인 입력 — 읽은 VM · 템플릿(읽힘) · vCPU 만 못 읽음 · 둘 다 '' · 메모리만 못 읽음
const VMS_A = [
  vm('vc-a', 'a1', WIN, { cpuCount: 4, memMB: 8192 }),
  vm('vc-a', 'a2', RHEL, { cpuCount: 2, memMB: 4096 }),
  vm('vc-a', 'tpl', WIN, { cpuCount: 16, memMB: 65536, template: true, powerState: 'POWERED_OFF' }),   // 템플릿 — /summary 는 넣는다
  vm('vc-a', 'nullCpu', WIN, { cpuCount: null, memMB: 2048 }),
  vm('vc-a', 'emptyBoth', RHEL, { cpuCount: '', memMB: '' }),                                         // '' 는 0 이 아니다
  vm('vc-a', 'memNull', RHEL, { cpuCount: 1, memMB: null }),
];
// vc-c: VM 이 있는데 전부 못 읽음(OS 도 이 vCenter 에만 있는 Ubuntu — OS 행이 통째로 '모름')
const VMS_C = [
  vm('vc-c', 'c1', UBU, { cpuCount: null, memMB: null }),
  vm('vc-c', 'c2', UBU, { cpuCount: '', memMB: '' }),
];
const SNAP = {
  source: 'live', generatedAt: new Date().toISOString(),
  vcenters: ['vc-a', 'vc-c', 'vc-d'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
  hosts: [host('vc-a', 'h'), host('vc-c', 'h'), host('vc-d', 'h')],
  vms: [...VMS_A, ...VMS_C],
  datastores: [], networks: [], alarms: [],
};
// 기대값(손으로 센 것) — 템플릿 포함: vCPU 4+2+16+1 = 23 · 메모리 8192+4096+65536+2048 = 79872MB(78GB)
const TOTAL = { vcpu: 23, memMB: 79872, ramGB: 78, vcpuUnknown: 4, ramUnknown: 4 };

let base; let CORE; let keys; let store;
before(async () => {
  ({ store } = await import('../src/store.js'));
  store.snapshot = { ...(store.get() || {}), ...SNAP };
  CORE = await import('../src/vcenter/vmSums.js');
  keys = await import('../src/publicapi/keys.js');
  const express = (await import('express')).default;
  const { api } = await import('../src/routes/api.js');
  const v1 = (await import('../src/routes/publicApi.js')).default;
  const app = express(); app.use(express.json());
  app.use('/api/v1', v1);
  app.use((req, _res, next) => { req.user = { username: 'adm', role: 'admin', scope: null }; next(); });
  app.use('/api', api);
  const srv = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  closers.push(() => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }));
  base = `http://127.0.0.1:${srv.address().port}`;
});

const getJson = async (p, key) => { const r = await fetch(`${base}${p}`, key ? { headers: { 'X-Api-Key': key } } : undefined); assert.equal(r.status, 200, p); return r.json(); };
const summary = (q = '') => getJson(`/api/summary${q}`);

test('① 코어 — includeTemplates 는 템플릿도 합에 넣는다 · 기본은 v3.19.1 그대로 · vmSumAdd 한 대씩', () => {
  const dflt = CORE.vmSumsOf(VMS_A);
  assert.deepEqual(dflt, { n: 5, on: 5, templates: 1, vcpu: 7, memMB: 14336, vcpuUnknown: 2, memUnknown: 2 }, '기본(템플릿 제외)은 바뀌지 않았다');
  const all = CORE.vmSumsOf(VMS_A, { includeTemplates: true });
  assert.deepEqual(all, { n: 6, on: 5, templates: 1, vcpu: 23, memMB: 79872, vcpuUnknown: 2, memUnknown: 2 }, '템플릿도 n · 합에 든다(templates 수는 그대로 따로)');
  // 템플릿뿐이고 못 읽었으면 — includeTemplates 에서는 '전부 못 읽음' 이다
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([{ template: true, cpuCount: null, memMB: '' }], { includeTemplates: true })), { vcpu: null, memMB: null });
  assert.deepEqual(CORE.vmAllocOf(CORE.vmSumsOf([{ template: true, cpuCount: null, memMB: '' }])), { vcpu: 0, memMB: 0 }, '기본은 템플릿을 세지 않으니 0');
  // 한 대씩 더하기 = 묶어 더하기
  const acc = CORE.newVmSum(); for (const v of VMS_A) CORE.vmSumAdd(acc, v);
  assert.deepEqual({ ...acc, templates: 1 }, all, 'vmSumAdd 는 템플릿 여부를 보지 않는다(부르는 쪽이 정한다)');
  // 공백 · 수 아님 · 배열 · 불리언은 더하지 않는다
  const odd = CORE.newVmSum(); for (const v of [{ cpuCount: ' ', memMB: 'x' }, { cpuCount: [4], memMB: true }, { cpuCount: '4', memMB: '1024' }]) CORE.vmSumAdd(odd, v);
  assert.deepEqual([odd.vcpu, odd.memMB, odd.vcpuUnknown, odd.memUnknown], [4, 1024, 2, 2], "수 글자('4')는 수로 읽는다(글자 이어 붙이기 아님)");
});

test('② /summary 전체 합 — 읽은 VM 만(템플릿 포함) · 못 읽은 수는 vcpuUnknown · ramUnknown', async () => {
  const al = (await summary()).allocation;
  assert.equal(al.vcpuAllocated, TOTAL.vcpu);
  assert.equal(al.ramAllocatedGB, TOTAL.ramGB);
  assert.equal(al.vcpuUnknown, TOTAL.vcpuUnknown, 'nullCpu · emptyBoth · c1 · c2');
  assert.equal(al.ramUnknown, TOTAL.ramUnknown, 'emptyBoth · memNull · c1 · c2');
  // 비율은 읽은 값으로 낸 최소값(화면이 unknown 수로 '≥' 를 붙인다)
  assert.equal(al.vcpuPerCore, Number((23 / 24).toFixed(2)));
  assert.equal(al.ramOvercommitPct, Math.round((79872 / (3 * 65536)) * 100));
  assert.equal(typeof al.vcpuAllocated, 'number', '글자 이어 붙이기가 아니다');
});

test('③ vCenter 별 — 부분 합 + 수 · 전부 못 읽으면 null · VM 이 없으면 0', async () => {
  const by = Object.fromEntries((await summary()).byVcenter.map((r) => [r.id, r]));
  assert.deepEqual([by['vc-a'].vcpuAllocated, by['vc-a'].ramAllocatedGB, by['vc-a'].vcpuUnknown, by['vc-a'].ramUnknown], [23, 78, 2, 2]);
  assert.deepEqual([by['vc-c'].vcpuAllocated, by['vc-c'].ramAllocatedGB, by['vc-c'].vcpuUnknown, by['vc-c'].ramUnknown], [null, null, 2, 2], '전부 못 읽은 vCenter 는 0 이 아니라 null');
  assert.deepEqual([by['vc-d'].vcpuAllocated, by['vc-d'].ramAllocatedGB, by['vc-d'].vcpuUnknown, by['vc-d'].ramUnknown], [0, 0, 0, 0], 'VM 없음은 0(모름 아님)');
  assert.equal(by['vc-c'].vms, 2, 'VM 수는 그대로 센다');
  // 행의 합 = 전체 합(같은 코어)
  const rows = Object.values(by);
  assert.equal(rows.reduce((a, r) => a + (r.vcpuAllocated ?? 0), 0), TOTAL.vcpu);
  assert.equal(rows.reduce((a, r) => a + r.vcpuUnknown, 0), TOTAL.vcpuUnknown);
  assert.equal(rows.reduce((a, r) => a + r.ramUnknown, 0), TOTAL.ramUnknown);
});

test('④ OS 별 — 같은 규칙 · kind 필터 · null 행은 뒤로', async () => {
  const s = await summary();
  const os0 = Object.fromEntries(s.osAllocation.map((r) => [r.name, r]));
  assert.deepEqual([os0.Windows.vms, os0.Windows.vcpu, os0.Windows.ramGB, os0.Windows.vcpuUnknown, os0.Windows.ramUnknown], [3, 20, 74, 1, 0]);
  assert.deepEqual([os0.RHEL.vms, os0.RHEL.vcpu, os0.RHEL.ramGB, os0.RHEL.vcpuUnknown, os0.RHEL.ramUnknown], [3, 3, 4, 1, 2]);
  assert.deepEqual([os0.Ubuntu.vms, os0.Ubuntu.vcpu, os0.Ubuntu.ramGB, os0.Ubuntu.vcpuUnknown, os0.Ubuntu.ramUnknown], [2, null, null, 2, 2], 'VM 을 하나도 못 읽은 OS 는 null');
  assert.deepEqual(s.osAllocation.map((r) => r.name), ['Windows', 'RHEL', 'Ubuntu'], 'vCPU 큰 순 · null 은 맨 뒤');
  assert.equal(s.osAllocation.reduce((a, r) => a + r.vcpuUnknown, 0), TOTAL.vcpuUnknown, 'OS 별 수의 합 = 전체 수');
  // kind=vm — 템플릿(16 vCPU)이 빠진다
  const vmOnly = Object.fromEntries((await summary('?kind=vm')).osAllocation.map((r) => [r.name, r]));
  assert.deepEqual([vmOnly.Windows.vms, vmOnly.Windows.vcpu, vmOnly.Windows.vcpuUnknown], [2, 4, 1]);
  // kind=template — 템플릿만(읽힌 값)
  const tpl = (await summary('?kind=template')).osAllocation;
  assert.deepEqual(tpl.map((r) => [r.name, r.vms, r.vcpu, r.ramGB, r.vcpuUnknown, r.ramUnknown]), [['Windows', 1, 16, 64, 0, 0]]);
  // kind 필터는 OS 표에만 듣는다 — 전체 합은 그대로
  assert.equal((await summary('?kind=vm')).allocation.vcpuAllocated, TOTAL.vcpu);
});

test('⑤ 전부 못 읽은 범위 — 전체 합 · 두 비율이 null(0 · 0% 가 아니다) · VM 없는 범위는 0', async () => {
  const c = (await summary('?vcenterId=vc-c')).allocation;
  assert.deepEqual([c.vcpuAllocated, c.ramAllocatedGB, c.vcpuPerCore, c.ramOvercommitPct, c.vcpuUnknown, c.ramUnknown], [null, null, null, null, 2, 2]);
  const d = (await summary('?vcenterId=vc-d')).allocation;
  assert.deepEqual([d.vcpuAllocated, d.ramAllocatedGB, d.vcpuPerCore, d.ramOvercommitPct, d.vcpuUnknown, d.ramUnknown], [0, 0, 0, 0, 0, 0]);
});

test('⑥ 공개 API — 값 · 타입 그대로(수) + vmVcpuUnknown · vmRamUnknown · 내부 /summary 와 같은 합', async () => {
  const k = keys.issueApiKey({ name: 'sum3192', groups: ['inventory'] }).plaintext;
  const pub = (await getJson('/api/v1/inventory/summary', k)).data;
  assert.deepEqual([pub.vmVcpu, pub.vmRamMB, pub.vmVcpuUnknown, pub.vmRamUnknown], [TOTAL.vcpu, TOTAL.memMB, TOTAL.vcpuUnknown, TOTAL.ramUnknown]);
  const al = (await summary()).allocation;
  assert.equal(pub.vmVcpu, al.vcpuAllocated, '공개 vmVcpu = 내부 allocation.vcpuAllocated');
  assert.equal(Math.round(pub.vmRamMB / 1024), al.ramAllocatedGB);
  assert.equal(pub.vmVcpuUnknown, al.vcpuUnknown); assert.equal(pub.vmRamUnknown, al.ramUnknown);
  assert.equal(pub.vms, 8); assert.equal(pub.templates, 1, '템플릿은 VM 수 · 합에 포함(문서 계약)');
  // 범위 키(전부 못 읽은 vCenter) — 타입 계약(수)을 지켜 0 이고, 소비자는 unknown === vms 로 '모름' 을 가린다(API-PUBLIC.md)
  const kc = keys.issueApiKey({ name: 'sum3192c', groups: ['inventory'], vcenters: ['vc-c'] }).plaintext;
  const pc = (await getJson('/api/v1/inventory/summary', kc)).data;
  assert.deepEqual([pc.vms, pc.vmVcpu, pc.vmRamMB, pc.vmVcpuUnknown, pc.vmRamUnknown], [2, 0, 0, 2, 2]);
  assert.equal(typeof pc.vmVcpu, 'number'); assert.equal(typeof pc.vmRamMB, 'number');
});

test('⑦ 전부 읽은 입력이면 예전 식(0 으로 더하기)과 같은 값 — 기존 소비자 불변', async () => {
  const prev = store.snapshot;
  const read = [
    vm('vc-a', 'r1', WIN, { cpuCount: 4, memMB: 8192 }), vm('vc-a', 'r2', RHEL, { cpuCount: 2, memMB: 4096, powerState: 'POWERED_OFF' }),
    vm('vc-a', 'r3', WIN, { cpuCount: 8, memMB: 16384, template: true }), vm('vc-c', 'r4', UBU, { cpuCount: 0, memMB: 0 }),   // 0 은 읽은 값
  ];
  store.snapshot = { ...prev, vms: read, generatedAt: new Date(Date.parse(prev.generatedAt) + 1000).toISOString() };   // 세대가 바뀌어 memoJson 이 새로 계산한다
  try {
    const s = await summary();
    const old = (f) => read.reduce((a, v) => a + (f(v) || 0), 0);
    assert.equal(s.allocation.vcpuAllocated, old((v) => v.cpuCount));
    assert.equal(s.allocation.ramAllocatedGB, Math.round(old((v) => v.memMB) / 1024));
    assert.deepEqual([s.allocation.vcpuUnknown, s.allocation.ramUnknown], [0, 0]);
    for (const r of s.byVcenter) {
      const mine = read.filter((v) => v.vcenterId === r.id);
      assert.equal(r.vcpuAllocated, mine.reduce((a, v) => a + (v.cpuCount || 0), 0), r.id);
      assert.equal(r.ramAllocatedGB, Math.round(mine.reduce((a, v) => a + (v.memMB || 0), 0) / 1024), r.id);
      assert.deepEqual([r.vcpuUnknown, r.ramUnknown], [0, 0]);
    }
    const ubu = s.osAllocation.find((r) => r.name === 'Ubuntu');
    assert.deepEqual([ubu.vcpu, ubu.ramGB, ubu.vcpuUnknown], [0, 0, 0], '읽은 0 은 null 이 아니다');
    const k = keys.issueApiKey({ name: 'sum3192r', groups: ['inventory'] }).plaintext;
    const pub = (await getJson('/api/v1/inventory/summary', k)).data;
    assert.deepEqual([pub.vmVcpu, pub.vmRamMB, pub.vmVcpuUnknown, pub.vmRamUnknown], [14, 28672, 0, 0]);
  } finally { store.snapshot = prev; }
});

test('⑧ 소스 — /summary · 공개 API 에 0 으로 더하는 식이 없고, 허용 목록 · 문서에 새 필드가 있다', async () => {
  const read = (rel) => stripComments(fs.readFileSync(path.join(HERE, '..', 'src', rel), 'utf8'));
  for (const rel of ['routes/api/inventory.js', 'routes/publicApi.js']) {
    const src = read(rel);
    assert.ok(!/cpuCount\s*\|\|\s*0|memMB\s*\|\|\s*0/.test(src), `${rel}: 못 읽은 값을 0 으로 더하지 않는다`);
    assert.ok(!/sum\(\s*vms\s*,\s*\(v\)\s*=>\s*v\.(cpuCount|memMB)\s*\)/.test(src), `${rel}: sum(vms, v => v.cpuCount) 꼴(null 을 0 으로)이 없다`);
    assert.match(src, /from '[^']*\/vmSums\.js'/, `${rel}: vmSums.js 코어를 쓴다`);
    assert.ok(!/(?:vcpuUnknown|memUnknown)\s*===/.test(src), `${rel}: '전부 못 읽음' 판정을 따로 하지 않는다(vmAllocOf)`);
  }
  // /summary 핸들러 안에서 코어를 부른다
  const inv = read('routes/api/inventory.js');
  const i = inv.indexOf("api.get('/summary'"); assert.ok(i >= 0);
  const j = inv.indexOf('api.get(', i + 10);
  const handler = inv.slice(i, j < 0 ? undefined : j);
  assert.match(handler, /vmSumsOf\(vms, \{ includeTemplates: true \}\)/);
  assert.ok((handler.match(/vmSumAdd\(/g) || []).length >= 2, 'OS 별 · vCenter 별 두 곳이 vmSumAdd');
  assert.ok((handler.match(/vmAllocOf\(/g) || []).length >= 3, '전체 · OS 별 · vCenter 별 세 곳이 vmAllocOf');
  // 공개 API 계약 — 선언 없는 필드는 나가지 않는다
  const { ENDPOINTS } = await import('../src/publicapi/allowlist.js');
  const ep = ENDPOINTS.find((e) => e.path === '/inventory/summary');
  for (const f of ['vmVcpu', 'vmRamMB', 'vmVcpuUnknown', 'vmRamUnknown']) assert.ok(ep.fields.includes(f), f);
  const doc = fs.readFileSync(path.join(HERE, '..', '..', 'docs', 'API-PUBLIC.md'), 'utf8');
  assert.match(doc, /`vmVcpuUnknown` `vmRamUnknown`/);
  assert.match(doc, /"vmVcpuUnknown": 0, "vmRamUnknown": 0/);
});
