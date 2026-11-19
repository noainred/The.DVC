/**
 * v3.28.1 — VM 할당(vCPU · 메모리) 합의 '못 읽은 값은 0 이 아니다' 를 남은 13곳에 맞춘다(v3.20.1 · docs/rules/web.md 'ⓔ 남긴 것').
 *
 * 수정 전에는 아래 곳이 못 읽은 cpuCount · memMB(null · '')를 `|| 0` · `Number(x) || 0` 으로 0 으로 더했다.
 *   ① 클러스터 오버커밋 경보(alerts.js) — 할당이 작게 잡혀 경보가 안 나거나 발생 중이던 경보가 거짓 '해소' 로 나갔다
 *   ② 용량 도구 /tools/capacity · ③ 과할당 리포트(/tools/waste overAllocated) · ④ /vms 합계(inventory/vmTotals.js)
 *   ⑤ 법인별 VM /vms/by-vcenter(inventory/vmByVcenter.js) · ⑥ 게스트 OS /tools/guest-os(guestOsAgg.js) · /tools/guest-os/vms 행
 *   ⑦ 인사이트 /tools/insights 라이트사이징 · ⑧ 추이 적재(metrics/sampler.js vmAllocRows) · ⑨ VM 시리즈(scope.js · /tools/vmseries/scope-data)
 * 규칙(서버 판정 코어 vcenter/vmSums.js 와 같다): 합은 읽은 VM 만(= 최소값) + 못 읽은 수 · 그 묶음을 하나도 못 읽었으면 null · 0 은 읽은 값.
 * 경보는 사용자 선택(2026-11-19): 최소값으로 이미 임계 이상이면 발생 · 미달인데 못 읽은 VM 이 있으면 보류(해소로 보내지 않음).
 *
 * 변이 확인: 고친 서버 10파일 + 웹 판정 3파일을 main ec7c2ba3 판본으로 되돌려 실행하면 12건 모두 실패한다(⑩ 은 값이 아니라 새 unknown 필드가 없어서).
 *   — 수정 전 코드가 못 읽은 VM 을 0 으로 더하던 것을 이 테스트가 실제로 잡는다.
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

const DIR = tmpDir('vmalloc3281-');
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'live';
process.env.TEMP_DB_PATH = path.join(DIR, 'host-temp.db');
fs.writeFileSync(path.join(DIR, 'runtime.json'), JSON.stringify({ dataSource: 'live' }));

const closers = [];
after(async () => { for (const c of closers) { try { await c(); } catch { /* */ } } });

const WIN = 'Microsoft Windows Server 2019 (64-bit)'; const UBU = 'Ubuntu Linux (64-bit)';
const host = (vc, name, extra = {}) => ({ id: `${vc}:${name}`, vcenterId: vc, name, cluster: 'C1', connectionState: 'CONNECTED', powerState: 'POWERED_ON',
  version: '8.0.3', cpuCores: 8, cpuThreads: 16, cpuTotalMhz: 20000, memTotalMB: 65536, cpuUsageMhz: 2000, memUsageMB: 8192, ...extra });
const vm = (vc, id, extra = {}) => ({ id: `${vc}:${id}`, vcenterId: vc, name: id, host: 'h1', cluster: 'C1', powerState: 'POWERED_ON', guestOS: WIN,
  storageGB: 10, uncommittedGB: 0, cpuUsagePct: 2, memUsagePct: 10, toolsStatus: 'RUNNING', ...extra });

// vc-a: 섞인 입력(구동 4 · 정지 1 · 템플릿 1) — 읽음 · vCPU 못 읽음(null) · 둘 다 '' · 메모리만 못 읽음
const VMS_A = [
  vm('vc-a', 'a1', { cpuCount: 4, memMB: 8192 }),
  vm('vc-a', 'nullCpu', { cpuCount: null, memMB: 4096 }),
  vm('vc-a', 'emptyBoth', { cpuCount: '', memMB: '', guestOS: UBU }),
  vm('vc-a', 'memNull', { cpuCount: 2, memMB: null }),
  vm('vc-a', 'off1', { cpuCount: 8, memMB: 16384, powerState: 'POWERED_OFF', cpuUsagePct: null, memUsagePct: null }),
  vm('vc-a', 'tpl', { cpuCount: 16, memMB: 32768, template: true, powerState: 'POWERED_OFF', cpuUsagePct: null, memUsagePct: null }),
];
// vc-c: VM 이 있는데 전부 못 읽음 · vc-d: VM 없음
const VMS_C = [
  vm('vc-c', 'c1', { cpuCount: null, memMB: null, guestOS: UBU }),
  vm('vc-c', 'c2', { cpuCount: '', memMB: ' ', guestOS: UBU }),
];
const SNAP = {
  source: 'live', generatedAt: new Date().toISOString(),
  vcenters: ['vc-a', 'vc-c', 'vc-d'].map((id) => ({ id, name: id.toUpperCase(), status: 'connected' })),
  hosts: [host('vc-a', 'h1'), host('vc-c', 'h1'), host('vc-d', 'h1')],
  vms: [...VMS_A, ...VMS_C],
  datastores: [], networks: [], alarms: [],
};

let base; let store; let alerts; let sampler; let vmTotalsMod; let byVcMod; let guestAgg; let scopeMod;
before(async () => {
  ({ store } = await import('../src/store.js'));
  store.snapshot = { ...(store.get() || {}), ...SNAP };
  alerts = await import('../src/alerts.js');
  sampler = await import('../src/metrics/sampler.js');
  vmTotalsMod = await import('../src/inventory/vmTotals.js');
  byVcMod = await import('../src/inventory/vmByVcenter.js');
  guestAgg = await import('../src/inventory/guestOsAgg.js');
  scopeMod = await import('../src/vmseries/scope.js');
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
/** 스냅샷을 바꿔 끼우고 세대(generatedAt)를 올린다 — memoJson 이 새로 계산하게. */
const withSnap = async (snap, fn) => {
  const prev = store.snapshot;
  store.snapshot = { ...prev, ...snap, generatedAt: new Date(Date.parse(prev.generatedAt) + 1000 + Math.floor(Math.random() * 1000)).toISOString() };
  try { return await fn(); } finally { store.snapshot = { ...prev, generatedAt: new Date(Date.parse(store.snapshot.generatedAt) + 1000).toISOString() }; }
};

/* ── ① 경보 ─────────────────────────────────────────────────────────────── */
test('① overcommitVerdict — 최소값으로 임계 이상 → 발생 · 미달 + 못 읽은 VM → 보류 · 미달 + 다 읽음 → 정상', () => {
  assert.equal(alerts.overcommitVerdict(130, 120, 3), 'fire');
  assert.equal(alerts.overcommitVerdict(120, 120, 0), 'fire', '임계와 같으면 발생(예전 >= 그대로)');
  assert.equal(alerts.overcommitVerdict(100, 120, 2), 'held');
  assert.equal(alerts.overcommitVerdict(100, 120, 0), 'ok');
  assert.equal(alerts.overcommitVerdict(100, 120, null), 'ok');
});

test('① 경보 evaluate — 부분 합이 임계 미만이면 보류 키 · 넘으면 ≥ 표지로 발생 · 다 읽으면 예전 그대로', () => {
  const cfg = { rules: { ramOvercommitPct: { enabled: true, threshold: 120 }, vcpuPerCore: { enabled: true, threshold: 5 } } };
  const hostQ = { vcenterId: 'vc1', cluster: 'c1', cpuCores: 4, cpuTotalMhz: 10000, memTotalMB: 8192 };
  const vms = (list) => list.map(([cpu, mem], i) => ({ id: `v${i}`, vcenterId: 'vc1', cluster: 'c1', powerState: 'POWERED_ON', cpuCount: cpu, memMB: mem }));
  const keys = (out) => out.map((x) => x.key).filter((k) => /^(ramoc|vcpuoc):/.test(k)).sort();
  // 읽은 합 4 vCPU · 4GB(1:1 · 50%) + 못 읽은 VM 2대 — 미달이라 '모름' → 보류(예전에는 0 으로 더해 '정상' → 발생 중이면 거짓 해소)
  const low = alerts.evaluate({ vcenters: [], hosts: [hostQ], vms: vms([[4, 4096], [null, null], ['', '']]) }, cfg);
  assert.deepEqual(keys(low), []);
  assert.ok(low.held.has('ramoc:vc1:c1') && low.held.has('vcpuoc:vc1:c1'), '미달 + 못 읽은 VM → 보류 키');
  // 읽은 합만으로 이미 임계 이상(40 vCPU / 4코어 = 10:1 · 40GB / 8GB = 500%) — 참인 경보, 제목에 ≥ · 본문에 미상 수
  const hi = alerts.evaluate({ vcenters: [], hosts: [hostQ], vms: vms([[40, 40960], [null, null]]) }, cfg);
  assert.deepEqual(keys(hi), ['ramoc:vc1:c1', 'vcpuoc:vc1:c1']);
  const ram = hi.find((x) => x.key === 'ramoc:vc1:c1'); const cpu = hi.find((x) => x.key === 'vcpuoc:vc1:c1');
  assert.match(ram.title, /RAM 오버커밋 ≥ 500%/); assert.match(ram.detail, /메모리 미상 VM 1대 제외\(최소값\)/);
  assert.match(cpu.title, /vCPU:코어 ≥ 10:1/); assert.match(cpu.detail, /vCPU 미상 VM 1대 제외/);
  // 다 읽은 입력 — 예전 판정 · 예전 글자 그대로(≥ · 미상 없음), 정상이면 보류도 아니다
  const ok = alerts.evaluate({ vcenters: [], hosts: [hostQ], vms: vms([[40, 40960]]) }, cfg);
  assert.equal(ok.find((x) => x.key === 'ramoc:vc1:c1').title, 'RAM 오버커밋 500%: c1');
  assert.equal(ok.find((x) => x.key === 'vcpuoc:vc1:c1').detail, 'vc1 · vCPU 40/코어 4');
  const fine = alerts.evaluate({ vcenters: [], hosts: [hostQ], vms: vms([[2, 2048]]) }, cfg);
  assert.deepEqual(keys(fine), []); assert.ok(!fine.held.has('ramoc:vc1:c1'), '다 읽고 정상이면 보류가 아니다(해소 가능)');
});

/* ── ② 용량 도구 ─────────────────────────────────────────────────────────── */
test('② /tools/capacity — 구동 VM 할당은 읽은 VM 만 + 미상 수 · 전부 못 읽으면 null · 여유는 메모리를 다 읽은 클러스터만', async () => {
  const j = await getJson('/api/tools/capacity');
  const by = Object.fromEntries(j.clusters.map((c) => [c.vcenterId, c]));
  const a = by['vc-a'];
  // 구동(템플릿 · 정지 제외): a1(4,8192) · nullCpu(null,4096) · emptyBoth('','') · memNull(2,null)
  assert.deepEqual([a.vcpuAllocated, a.ramAllocatedGB, a.vcpuUnknown, a.ramUnknown], [6, 12, 2, 2]);
  assert.deepEqual([a.vcpuTotal, a.vcpuTotalUnknown], [14, 2], 'vcpuTotal = 구동 + 정지(템플릿 제외) — 4+2+8');
  assert.equal(a.vcpuPerCore, Number((6 / 8).toFixed(1)), '비율은 읽은 값의 최소값');
  assert.equal(a.ramOvercommitPct, Math.round((12 / 64) * 100));
  assert.equal(a.ramHeadroomGB, null, '메모리를 못 읽은 구동 VM 이 있으면 여유는 모름(부분 합이면 실제보다 크게 나온다)');
  const c = by['vc-c'];
  assert.deepEqual([c.vcpuAllocated, c.ramAllocatedGB, c.vcpuPerCore, c.ramOvercommitPct, c.ramHeadroomGB, c.vcpuUnknown], [null, null, null, null, null, 2]);
  const d = by['vc-d'];
  assert.deepEqual([d.vcpuAllocated, d.ramAllocatedGB, d.vcpuPerCore, d.ramOvercommitPct, d.ramHeadroomGB], [0, 0, 0, 0, 64], 'VM 없음은 0(모름 아님)');
  const t = j.totals;
  assert.deepEqual([t.vcpuAllocated, t.ramAllocatedGB, t.vcpuUnknown, t.ramUnknown], [6, 12, 4, 4]);
  assert.equal(t.vcpuPerCore, Number((6 / 16).toFixed(1)), '합계 비율 = 할당을 읽은 클러스터(vc-a · vc-d)끼리 — vc-c 는 분자 · 분모 둘 다 뺀다');
  assert.equal(t.vcpuPerCoreMin, true, 'vc-a 가 부분 합이라 합계 비율도 최소값');
  assert.deepEqual([t.ramHeadroomGB, t.ramHeadroomExcluded], [64, 2], '여유 합 = 다 읽은 vc-d 만 · vc-a · vc-c 제외');
});

/* ── ③ 과할당 리포트 ─────────────────────────────────────────────────────── */
test('③ /tools/waste overAllocated — 할당(크기)을 못 읽은 구동 VM 은 그 지표에서 빼고 allocUnknown 으로 센다', async () => {
  const w = await getJson('/api/tools/waste');
  const oa = w.overAllocated;
  assert.deepEqual(oa.allocUnknown, { cpu: 4, mem: 4 }, '구동 VM 중 vCPU 못 읽음: nullCpu · emptyBoth · c1 · c2 / 메모리: emptyBoth · memNull · c1 · c2');
  // 메모리 할당 합 = 메모리를 읽고 사용률도 읽은 구동 VM(a1 8192 · nullCpu 4096) — 못 읽은 VM 을 0 GB 로 더하지 않는다
  assert.equal(oa.mem.allocGB, Number(((8192 + 4096) / 1024).toFixed(1)));
});

/* ── ④ /vms 합계 · ⑤ 법인별 ──────────────────────────────────────────────── */
test('④ vmTotals(순수) · /vms totals — 읽은 VM 만(템플릿 포함 · 받은 목록 그대로) + 미상 수 · 전부 못 읽으면 null', async () => {
  const t = vmTotalsMod.vmTotals(VMS_A, {});
  assert.deepEqual([t.vcpu, t.ramGB, t.vcpuUnknown, t.ramUnknown], [4 + 2 + 8 + 16, Math.round((8192 + 4096 + 16384 + 32768) / 1024), 2, 2]);
  const allBad = vmTotalsMod.vmTotals(VMS_C, {});
  assert.deepEqual([allBad.vcpu, allBad.ramGB, allBad.vcpuUnknown, allBad.ramUnknown], [null, null, 2, 2]);
  const empty = vmTotalsMod.vmTotals([], {});
  assert.deepEqual([empty.vcpu, empty.ramGB, empty.vcpuUnknown], [0, 0, 0]);
  const j = await getJson('/api/vms?limit=1');
  assert.deepEqual([j.totals.vcpuUnknown, j.totals.ramUnknown], [4, 4]);
});

test('⑤ vmByVcenter(순수) · /vms/by-vcenter — 법인 줄 · 합계 줄이 같은 규칙', async () => {
  const r = byVcMod.vmByVcenter({ vcenters: SNAP.vcenters, vms: SNAP.vms, ctx: {} });
  const by = Object.fromEntries(r.corps.map((c) => [c.id, c]));
  assert.deepEqual([by['vc-a'].vcpu, by['vc-a'].vcpuUnknown, by['vc-a'].ramUnknown], [30, 2, 2]);
  assert.deepEqual([by['vc-c'].vcpu, by['vc-c'].ramGB, by['vc-c'].vcpuUnknown], [null, null, 2], '전부 못 읽은 법인은 0 이 아니라 null');
  assert.deepEqual([r.totals.vcpu, r.totals.vcpuUnknown, r.totals.ramUnknown], [30, 4, 4]);
  const j = await getJson('/api/vms/by-vcenter');
  const jc = j.corps.find((c) => c.id === 'vc-c');
  assert.deepEqual([jc.vcpu, jc.ramGB], [null, null]);
});

/* ── ⑥ 게스트 OS ─────────────────────────────────────────────────────────── */
test('⑥ guestOsAgg · /tools/guest-os/vms — OS · 계열 · vCenter 합은 읽은 VM 만 + 미상 수, 행은 null', async () => {
  const fam = (os) => (/windows/i.test(os) ? 'Windows' : /ubuntu/i.test(os) ? 'Ubuntu' : 'Other');
  const g = guestAgg.aggregateGuestOs(SNAP.vms, fam);
  const items = Object.fromEntries(g.items.map((x) => [x.os, x]));
  assert.deepEqual([items[WIN].vcpu, items[WIN].vcpuUnknown, items[WIN].memUnknown], [4 + 2 + 8 + 16, 1, 1], 'Windows: nullCpu · memNull');
  assert.deepEqual([items[UBU].vcpu, items[UBU].memGB, items[UBU].vcpuUnknown], [null, null, 3], 'Ubuntu 3대 전부 못 읽음 → null');
  assert.equal(g.totalVcpu, 30); assert.deepEqual([g.vcpuUnknown, g.memUnknown], [4, 4]);
  assert.equal(g.byVcenter.find((b) => b.id === 'vc-c').vcpu, null);
  const rows = (await getJson('/api/tools/guest-os/vms?vcenterId=vc-a')).items;
  const r = Object.fromEntries(rows.map((x) => [x.name, x]));
  assert.deepEqual([r.nullCpu.cpu, r.nullCpu.memGB], [null, 4]);
  assert.deepEqual([r.emptyBoth.cpu, r.emptyBoth.memGB], [null, null], "'' 는 0 이 아니다");
  assert.deepEqual([r.a1.cpu, r.a1.memGB], [4, 8]);
});

/* ── ⑦ 인사이트 ─────────────────────────────────────────────────────────── */
test('⑦ /tools/insights 라이트사이징 — 행의 vCPU · RAM 은 null, 회수 합은 읽은 VM 만 + reclaimUnknown', async () => {
  const rs = (await getJson('/api/tools/insights')).rightsizing;
  const idle = Object.fromEntries(rs.idle.map((v) => [v.name, v]));
  assert.deepEqual([idle.nullCpu.vcpu, idle.nullCpu.ramGB], [null, 4]);
  assert.deepEqual([idle.memNull.vcpu, idle.memNull.ramGB], [2, null]);
  assert.equal(rs.reclaimableVcpu, 4 + 2, '유휴 구동 VM 중 vCPU 를 읽은 a1(4) · memNull(2)');
  assert.deepEqual(rs.reclaimUnknown, { vcpu: 4, ramGB: 4 });
});

/* ── ⑧ 추이 적재 ─────────────────────────────────────────────────────────── */
test('⑧ vmAllocRows — 크기를 못 읽은 켜진 VM 은 메모리 · CPU 계열에서 빼고 vmAllocUnknown 으로 센다(lastRun 요약까지)', () => {
  const snap = { vcenters: [{ id: 'vc1', status: 'connected' }], datastores: [],
    hosts: [{ vcenterId: 'vc1', name: 'h1', cpuCores: 8, cpuTotalMhz: 16000, memTotalMB: 65536, connectionState: 'CONNECTED' }],
    vms: [
      { id: 'a', vcenterId: 'vc1', host: 'h1', powerState: 'POWERED_ON', cpuCount: 2, memMB: 4096, cpuUsagePct: 50, memUsagePct: 50, storageGB: 1, uncommittedGB: 0 },
      { id: 'b', vcenterId: 'vc1', host: 'h1', powerState: 'POWERED_ON', cpuCount: null, memMB: null, cpuUsagePct: 50, memUsagePct: 50, storageGB: 1, uncommittedGB: 0 },
      { id: 'c', vcenterId: 'vc1', host: 'h1', powerState: 'POWERED_ON', cpuCount: '', memMB: '', cpuUsagePct: 50, memUsagePct: 50, storageGB: 1, uncommittedGB: 0 },
    ] };
  const out = sampler.vmAllocRows(snap, { enabled: true, vcenterIds: [], trackTotal: false });
  const rows = Object.fromEntries((out.get('vc1') || []).map((r) => [r.metric, r.v]));
  assert.equal(rows.vm_mem_alloc_mb, 4096, '못 읽은 VM 을 할당 0 으로 더하지 않는다(값은 같지만 집합이 같아야 한다)');
  assert.equal(rows.vm_cpu_alloc_mhz, 2 * 2000);
  assert.deepEqual(out.vmAllocUnknown, { cpu: 2, mem: 2 });
  const w = sampler.samplerWithheldOf({ at: 1, vmAllocUnknown: { cpu: 2, mem: 1 } });
  assert.deepEqual(w.vmAllocUnknown, { cpu: 2, mem: 1 }, '화면 요약에도 실린다');
  assert.equal(sampler.samplerWithheldOf({ at: 1, vmAllocUnknown: { cpu: 0, mem: 0 } }), null, '없으면 요약을 만들지 않는다(예전 모양)');
});

/* ── ⑨ VM 시리즈 ─────────────────────────────────────────────────────────── */
test('⑨ VM 시리즈 — 수집 대상 · 범위 트리의 vCPU · 메모리는 못 읽으면 null(스파이크 판정은 vcpu > 0 일 때만)', async () => {
  const t = scopeMod.resolveTargets(SNAP, { scope: 'all' }, 'vc-a');
  const v = Object.fromEntries(t.vms.map((x) => [x.name, x]));
  assert.deepEqual([v.nullCpu.vcpu, v.emptyBoth.vcpu, v.emptyBoth.memMB, v.a1.vcpu], [null, null, null, 4]);
  const d = await getJson('/api/tools/vmseries/scope-data?vcenterId=vc-a');
  const dv = Object.fromEntries(d.vms.map((x) => [x.name, x]));
  assert.deepEqual([dv.nullCpu.vcpu, dv.memNull.memMB, dv.a1.memMB], [null, null, 8192]);
});

/* ── ⑩ 다 읽은 입력은 예전 값 그대로 ─────────────────────────────────────── */
test('⑩ 다 읽은 스냅샷 — 용량 · 합계 · 게스트 OS 값이 예전 식(0 으로 더하기)과 같다', async () => {
  const ok = [
    vm('vc-a', 'r1', { cpuCount: 4, memMB: 8192 }), vm('vc-a', 'r2', { cpuCount: 2, memMB: 4096, powerState: 'POWERED_OFF', cpuUsagePct: null, memUsagePct: null }),
    vm('vc-a', 'r3', { cpuCount: 0, memMB: 0 }),   // 0 은 읽은 값
  ];
  await withSnap({ vms: ok }, async () => {
    const cap = (await getJson('/api/tools/capacity')).clusters.find((c) => c.vcenterId === 'vc-a');
    assert.deepEqual([cap.vcpuAllocated, cap.vcpuTotal, cap.ramAllocatedGB, cap.vcpuUnknown, cap.ramUnknown, cap.ramHeadroomGB], [4, 6, 8, 0, 0, 64 - 8]);
    const t = (await getJson('/api/vms?limit=1')).totals;
    assert.deepEqual([t.vcpu, t.ramGB, t.vcpuUnknown, t.ramUnknown], [6, 12, 0, 0]);
  });
});

/* ── ⑪ 소스 — 0 으로 더하는 꼴이 되살아나지 않는다 ──────────────────────── */
test('⑪ 소스 스윕 — 고친 곳에 cpuCount · memMB 를 0 으로 접는 식이 없다', () => {
  const FILES = ['alerts.js', 'routes/api/toolsCapacity.js', 'inventory/vmTotals.js', 'inventory/vmByVcenter.js', 'routes/api/toolsInfo.js',
    'routes/api/toolsAnalytics.js', 'inventory/guestOsAgg.js', 'metrics/sampler.js', 'vmseries/scope.js', 'routes/api/vmSeries.js'];
  const BAD = [/cpuCount\s*\|\|\s*0/, /memMB\s*\|\|\s*0/, /Number\(\s*v\.(cpuCount|memMB)\s*\)\s*\|\|\s*0/, /Number\.isFinite\(\s*v\.(cpuCount|memMB)\s*\)\s*\?\s*v\.\w+\s*:\s*0/,
    /sm\(\s*\(v\)\s*=>\s*v\.(cpuCount|memMB)\s*\)/];
  for (const rel of FILES) {
    const src = stripComments(fs.readFileSync(path.join(HERE, '..', 'src', rel), 'utf8'));
    for (const re of BAD) assert.ok(!re.test(src), `${rel}: ${re} — 못 읽은 vCPU · 메모리를 0 으로 더하지 말 것(vcenter/vmSums.js · numOrNull)`);
  }
  // 웹 쪽 판정 사본(vCD 트리 · 검색 · 튜닝)도 같다
  const WEB = ['views/vcdVirt.js', 'views/vcdSearch.js', 'views/vcd/TuningTabs.jsx'];
  for (const rel of WEB) {
    const src = stripComments(fs.readFileSync(path.join(HERE, '..', '..', 'web', 'src', rel), 'utf8'));
    assert.ok(!/Number\(\s*v\.(cpuCount|memMB)\s*\)\s*\|\|\s*0/.test(src), `web/src/${rel}: 0 으로 접지 말 것`);
  }
});
