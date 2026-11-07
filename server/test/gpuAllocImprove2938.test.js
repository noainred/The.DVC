/**
 * v2.938 GPU 할당율 개선(사용자 요청 '개선 포인트 모두 적용' — 11가지 중 서버 몫).
 *   ① GPU 인벤토리도 NIC · HBA 패스스루를 GPU 로 세지 않는다(gpuDevicesOnHost 한 벌)
 *   ② 수집 점검(allocDiag) ③ 같은 GPU 의 vGPU 여러 장 ⑤ 꺼진 VM 을 켜면 넘침 ⑥ 할당률 알림(기본 끔)
 *   ⑦ 일 단위 이력 · 소진 예상 ⑧ 일일 헬스체크 절
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_stripComments.js';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpualloc2938-'));
process.env.CONFIG_DIR = DIR;
process.env.DATA_SOURCE = 'mock';
process.env.GPU_ALLOC_DB_PATH = path.join(DIR, 'gpu-alloc.db');
after(() => { fs.rmSync(DIR, { recursive: true, force: true }); });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ON = 'POWERED_ON'; const OFF = 'POWERED_OFF';
const vm = (id, name, gpu, powerState = ON, host = 'esx1', vcenterId = 'vc1') => ({ id: `${vcenterId}:${id}`, name, host, vcenterId, powerState, gpu, cpuCount: 8, memMB: 32768 });
const vg = (profile, n = 1) => ({ type: 'vgpu', count: n, vgpu: n, passthrough: 0, profile });
const pt = (pciIds, n = pciIds ? pciIds.length : 1) => ({ type: 'passthrough', count: n, vgpu: 0, passthrough: n, profile: '', ...(pciIds ? { pciIds } : {}) });
const host = (o = {}) => ({ id: 'vc1:h1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL', vcDatacenter: 'DC', connectionState: 'CONNECTED', ...o });

test('① 판정 한 벌 — gpuDevicesOnHost: 주소를 다 알 때만 NIC 를 가르고, 모르면 예전 그대로', async () => {
  const { gpuDevicesOnHost, isGpuVmOnHost, gpuViewOnHost } = await import('../src/gpu/vgpuProfile.js');
  const ptHost = [{ model: 'NVIDIA A100 80GB', mode: 'passthrough', pciId: '0000:3B:00.0' }];
  assert.deepEqual(gpuDevicesOnHost(pt(['0000:3b:00.0', '0000:af:00.0']), ptHost), { vgpu: 0, passthrough: 1, other: 1 }, '대소문자 무시');
  assert.deepEqual(gpuDevicesOnHost(pt(['0000:af:00.0']), [{ model: 'L4', mode: 'vgpu', vms: [] }]), { vgpu: 0, passthrough: 0, other: 1 });
  assert.equal(isGpuVmOnHost({ vgpu: 0, passthrough: 0, other: 1 }), false);
  assert.deepEqual(gpuDevicesOnHost(pt(null, 1), ptHost), { vgpu: 0, passthrough: 1, other: 0 }, '주소 모름 → 전부 GPU');
  assert.deepEqual(gpuDevicesOnHost(pt(['0000:af:00.0']), [{ model: 'X', mode: 'passthrough' }]), { vgpu: 0, passthrough: 1, other: 0 }, '호스트 GPU 주소 모름 → 전부 GPU');
  const view = gpuViewOnHost({ type: 'mixed', count: 2, vgpu: 1, passthrough: 1, profile: 'nvidia_l4-12q' }, { vgpu: 1, passthrough: 0, other: 1 });
  assert.equal(view.type, 'vgpu'); assert.equal(view.passthrough, 0); assert.equal(view.nonGpuPassthrough, 1);
});

test('① GPU 인벤토리 — NIC 만 패스스루로 받은 VM 은 GPU VM 이 아니다(호스트 할당 VM · 패스스루 장수)', async () => {
  const { buildGpuInventory } = await import('../src/routes/api/hardwareGpu.js');
  const { summarizeHostGpu } = await import('../src/gpu/hostGpu.js');
  const h = host({ gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1'] }] });
  const snap = { vcenters: [{ id: 'vc1', name: 'kr' }], hosts: [h], vms: [vm('vm-1', 'cad', vg('nvidia_l4-12q')), vm('vm-2', 'rdma', pt(['0000:af:00.0']))] };
  const inv = buildGpuInventory(snap, null, null);
  const row = inv.items.find((x) => x.host === 'esx1');
  assert.equal(row.assignedVms, 1, '예전에는 2(NIC VM 포함)');
  assert.equal(inv.gpuVmCount, 1, '상단 요약의 GPU VM 수도');
  const sum = summarizeHostGpu(h, snap.vms, new Map());
  assert.equal(sum.passthroughOn, 0, '예전에는 1');
  assert.equal(sum.vms.length, 1);
});

test('② 수집 점검 — 배치 정보 · 꺼진 VM 목록 · 패스스루 주소 · 프로파일 이름 · NIC 를 스냅샷으로 판정', async () => {
  const { allocDiag } = await import('../src/gpu/allocTree.js');
  const snap = {
    vcenters: [{ id: 'vc1', name: 'kr' }, { id: 'vc2', name: 'de' }],
    hosts: [
      host({ gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1', 'vm-3'] }, { model: 'NVIDIA L4', memGB: 24, mode: 'vgpu' }] }),
      host({ id: 'vc2:h1', vcenterId: 'vc2', name: 'esx9', gpus: [{ model: 'NVIDIA A100 80GB', mode: 'passthrough', pciId: '0000:3b:00.0' }, { model: 'Weird GPU', mode: 'passthrough' }] }),
    ],
    vms: [
      vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-3', 'b', vg('nvidia_l4-12q'), OFF), vm('vm-4', 'c', vg('custom-prof')),
      vm('vm-5', 'nic', pt(['0000:af:00.0']), ON, 'esx9', 'vc2'), vm('vm-6', 'train', pt(['0000:3b:00.0']), ON, 'esx9', 'vc2'), vm('vm-7', 'old', pt(null, 1), ON, 'esx9', 'vc2'),
    ],
  };
  const d = allocDiag(snap);
  const kr = d.vcenters.find((v) => v.id === 'vc1');
  assert.equal(kr.vgpuNoPlacement, 1);
  assert.equal(kr.offVgpuVms, 1); assert.equal(kr.offListed, 1);
  assert.equal(kr.unparsedVms, 1);
  assert.deepEqual(d.unparsedProfiles, [{ profile: 'custom-prof', vms: 1 }]);
  const de = d.vcenters.find((v) => v.id === 'vc2');
  assert.equal(de.ptNoPci, 1, '주소 없는 패스스루 GPU');
  assert.equal(de.nonGpuPtVms, 0, '호스트 GPU 주소를 하나라도 모르면 NIC 를 가르지 못한다(지어내지 않는다)');
  assert.equal(de.ptOnVms, 3); assert.equal(de.ptOnPciRead, 2);
  assert.equal(d.verdicts.offListed, 'yes'); assert.equal(d.verdicts.ptPciRead, 'partial'); assert.equal(d.verdicts.profiles, 'partial'); assert.equal(d.verdicts.placement, 'partial');
  assert.deepEqual(allocDiag(snap, { allowed: new Set(['vc2']) }).vcenters.map((v) => v.id), ['vc2'], '조회 범위가 먼저');
  assert.equal(allocDiag({ vcenters: [], hosts: [], vms: [] }).verdicts.offListed, 'unknown', '관측할 대상이 없으면 판단 불가');
});

test('③ 같은 GPU 에 vGPU 여러 장 — 목록 하나에만 있으면 장치 수만큼 · 여러 목록이면 한 장씩', async () => {
  const { buildHostAlloc } = await import('../src/gpu/allocTree.js');
  const one = buildHostAlloc(host({ gpus: [{ model: 'NVIDIA A40', memGB: 48, mode: 'vgpu', vms: ['vm-1'] }] }), [vm('vm-1', 'big', vg('grid_a40-12q', 2))]);
  assert.equal(one.gpus[0].allocGB, 24, '예전에는 12(한 장치분)');
  assert.equal(one.gpus[0].spareGB, 24);
  assert.deepEqual([one.gpus[0].slots.used, one.gpus[0].slots.free], [2, 2], '슬롯도 장치 수');
  assert.equal(one.totals.allocGB, 24, '호스트 합계는 예전부터 정확');
  const two = buildHostAlloc(host({ gpus: [{ model: 'NVIDIA A40', memGB: 48, mode: 'vgpu', vms: ['vm-1'] }, { model: 'NVIDIA A40', memGB: 48, mode: 'vgpu', vms: ['vm-1'] }] }), [vm('vm-1', 'big', vg('grid_a40-12q', 2))]);
  assert.deepEqual(two.gpus.map((g) => g.allocGB), [12, 12]);
});

test('⑤ 꺼진 VM 을 모두 켜면 넘침 — 호스트 행에만 · 모르는 값이 섞이면 판정 안 함', async () => {
  const { buildHostAlloc, buildGpuAllocTree } = await import('../src/gpu/allocTree.js');
  const { treeLines } = await import('../src/gpu/allocTreeXlsx.js');
  const h = host({ gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1'] }] });
  const r = buildHostAlloc(h, [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('nvidia_l4-12q'), OFF), vm('vm-3', 'c', vg('nvidia_l4-12q'), OFF)]);
  assert.equal(r.totals.spareGB, 12); assert.equal(r.totals.offGB, 24); assert.equal(r.totals.offOverGB, 12);
  const ok = buildHostAlloc(h, [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('nvidia_l4-12q'), OFF)]);
  assert.equal(ok.totals.offOverGB, null);
  const unk = buildHostAlloc(h, [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('weird'), OFF), vm('vm-3', 'c', vg('nvidia_l4-24q'), OFF)]);
  assert.equal(unk.totals.offOverGB, null, '꺼진 VM GB 를 모르면 판정하지 않는다');
  const t = buildGpuAllocTree({ vcenters: [{ id: 'vc1', name: 'kr' }], hosts: [h], vms: [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('nvidia_l4-12q'), OFF), vm('vm-3', 'c', vg('nvidia_l4-12q'), OFF)] });
  assert.equal(t.vcenters[0].totals.offOverGB, undefined, '법인 · 클러스터 합계에는 싣지 않는다(배치는 호스트 단위)');
  const lines = treeLines(t);
  assert.match(lines.find((l) => l.depth === 3).cells[16], /꺼진 VM 을 모두 켜면 예비보다 12 GB 더 필요/);
  assert.doesNotMatch(lines[0].cells[16], /꺼진 VM 을 모두 켜면/);
});

test('⑥ 할당률 알림 — 기본 끔 · 켜면 임계 이상 경고 · 예비 음수 위험 · 모름 · 낡은 보고는 보류', async () => {
  const { evaluate } = await import('../src/alerts.js');
  const base = { channels: {}, rules: { gpuAllocPct: { enabled: false, threshold: 90 } } };
  const h = (vc, vms) => host({ id: `${vc}:h1`, vcenterId: vc, gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms }] });
  const snap = {
    vcenters: [{ id: 'vc1', name: 'kr', status: 'connected' }, { id: 'vc2', name: 'de', status: 'connected' }, { id: 'vc3', name: 'us', status: 'unreachable' }],
    hosts: [h('vc1', ['vm-1', 'vm-2']), h('vc2', ['vm-1']), h('vc3', ['vm-1', 'vm-2'])],
    vms: [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('nvidia_l4-12q')), vm('vm-1', 'x', vg('weird'), ON, 'esx1', 'vc2'),
      vm('vm-1', 'p', vg('nvidia_l4-12q'), ON, 'esx1', 'vc3'), vm('vm-2', 'q', vg('nvidia_l4-12q'), ON, 'esx1', 'vc3')],
  };
  assert.equal(evaluate(snap, base).filter((a) => a.key.startsWith('gpualloc:')).length, 0, '기본 끔');
  const on = { ...base, rules: { gpuAllocPct: { enabled: true, threshold: 90 } } };
  const out = evaluate(snap, on);
  const fired = out.filter((a) => a.key.startsWith('gpualloc:'));
  assert.deepEqual(fired.map((a) => a.key), ['gpualloc:vc1']);
  assert.equal(fired[0].severity, 'warning'); assert.match(fired[0].title, /GPU 할당률 100%: kr/);
  assert.ok(out.held.has('gpualloc:vc2'), '할당을 모르면 보류(해소로 기록하지 않음)');
  assert.ok(out.held.has('gpualloc:vc3'), '연결 불가 법인은 보류');
  const over = { ...snap, vms: [...snap.vms, vm('vm-9', 'z', vg('nvidia_l4-12q'))], hosts: [h('vc1', ['vm-1', 'vm-2', 'vm-9']), ...snap.hosts.slice(1)] };
  assert.equal(evaluate(over, on).find((a) => a.key === 'gpualloc:vc1').severity, 'critical', '할당 > 용량');
  const { DEFAULTS_FOR_TEST } = await import('../src/alerts.js').then((m) => ({ DEFAULTS_FOR_TEST: m.loadAlertConfig() }));
  assert.deepEqual(DEFAULTS_FOR_TEST.rules.gpuAllocPct, { enabled: false, threshold: 90 }, '사용자 결정: 기본 끔 · 90%');
});

test('⑦ 이력 — 모르는 값 · 수집 못 한 법인은 쌓지 않음 · 같은 날은 덮음 · 합계는 모든 법인이 있는 날만 · 소진 예상', async () => {
  const H = await import('../src/gpu/allocHistory.js');
  const { dayIndex } = await import('../src/util/dayKey.js');
  const h = (vc, vms) => host({ id: `${vc}:h1`, vcenterId: vc, gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms }] });
  const snap = {
    vcenters: [{ id: 'vc1', name: 'kr' }, { id: 'vc2', name: 'de' }, { id: 'vc3', name: 'us', status: 'unreachable' }],
    hosts: [h('vc1', ['vm-1']), h('vc2', ['vm-1']), h('vc3', [])],
    vms: [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-1', 'x', vg('weird'), ON, 'esx1', 'vc2')],
  };
  assert.deepEqual(H.allocDailyRows(snap), [{ vc: 'vc1', cap: 24, alloc: 12, gpus: 1, hosts: 1 }], 'vc2(할당 모름) · vc3(연결 불가) 제외');
  const now = Date.now();
  // 30일치 — vc1 은 하루 0.5 GB 씩 늘고 vc2 는 10일만
  for (let i = 29; i >= 0; i--) {
    const ts = now - i * 86_400_000;
    const rows = [{ vc: 'vc1', cap: 48, alloc: 10 + (29 - i) * 0.5, gpus: 2, hosts: 1 }];
    if (i < 10) rows.push({ vc: 'vc2', cap: 24, alloc: 12, gpus: 1, hosts: 1 });
    assert.equal(await H.recordAllocDaily(rows, ts), rows.length);
  }
  await H.recordAllocDaily([{ vc: 'vc1', cap: 48, alloc: 25, gpus: 2, hosts: 1 }], now - 1000);   // 같은 날 더 이른 시각 → 덮지 않음
  const rows = await H.allocHistoryRows(90, now);
  assert.equal(rows.get('vc1').length, 30);
  assert.equal(rows.get('vc1').at(-1)[2], 24.5, '같은 날 더 이른 값으로 덮지 않는다(ts 비교)');
  const view = H.allocHistoryView(rows, { names: new Map([['vc1', 'kr']]), now });
  assert.equal(view.total.filter((x) => x[1] != null).length, 10, '합계는 두 법인 모두 있는 10일만');
  assert.equal(view.total[0][1], null);
  const kr = view.corps.find((c) => c.id === 'vc1');
  assert.equal(kr.name, 'kr'); assert.equal(kr.trend.gbPerDay, 0.5);
  assert.equal(kr.trend.daysLeft, Math.floor((48 - 24.5) / 0.5));
  assert.equal(kr.trend.change30, 14.5);
  assert.equal(H.allocTrend([[1, 48, 10], [2, 48, 11]]).daysLeft, null, '점 7개 미만 — 모름');
  assert.equal(H.allocTrend(Array.from({ length: 10 }, (_, i) => [i, 48, 20 - i])).daysLeft, null, '줄어들면 모름(소진 안 함으로 단정하지 않음)');
  assert.equal(dayIndex(now), view.today);
  assert.deepEqual(H.allocHistoryView(null), { available: false, corps: [], total: [], totalTrend: null });
});

test('⑦ · ② 라우트 — 조회 범위를 요청 필터보다 먼저 · 이력은 탭을 열 때(폴링 아님)', () => {
  const src = stripComments(fs.readFileSync(path.join(HERE, '../src/routes/api/hardwareGpu.js'), 'utf8'));
  const diag = src.slice(src.indexOf("api.get('/tools/gpu-alloc/diag'"), src.indexOf("api.get('/tools/gpu-alloc/history'"));
  assert.match(diag, /allocDiag\(snap, \{ allowed: scopedVcenterIds\(req\.user, snap\) \}\)/);
  const hist = src.slice(src.indexOf("api.get('/tools/gpu-alloc/history'"), src.indexOf("api.get('/tools/gpu-alloc/history'") + 1500);
  assert.match(hist, /const allowed = scopedVcenterIds\(req\.user, snap\)/);
  assert.match(hist, /\(!allowed \|\| allowed\.has\(id\)\) && \(!picked/);
  const idx = stripComments(fs.readFileSync(path.join(HERE, '../src/index.js'), 'utf8'));
  assert.match(idx, /startGpuAllocHistory\(\(\) => store\.get\(\)\)/, '기동 목록에 이력 수집기');
});

test('⑧ 일일 헬스체크 — 법인 GPU 할당률 절(90% 이상 경고 · 넘침 위험 · 모름은 확인 불가) · GPU 없는 포탈은 절 없음', async () => {
  const { computeHealthReport, buildDailyReportText } = await import('../src/reports/healthReport.js');
  const h = (vc, vms) => host({ id: `${vc}:h1`, vcenterId: vc, gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms }] });
  const snap = { vcenters: [{ id: 'vc1', name: 'kr' }, { id: 'vc2', name: 'de' }], hosts: [h('vc1', ['vm-1', 'vm-2']), h('vc2', ['vm-1'])],
    vms: [vm('vm-1', 'a', vg('nvidia_l4-12q')), vm('vm-2', 'b', vg('nvidia_l4-12q')), vm('vm-1', 'x', vg('weird'), ON, 'esx1', 'vc2')], datastores: [], alarms: [] };
  const r = computeHealthReport(snap, { now: Date.now() });
  const s = r.sections.find((x) => x.key === 'gpuAlloc');
  assert.equal(s.status, 'warn'); assert.equal(s.count, 1); assert.equal(s.items[0].usagePct, 100); assert.equal(s.unknown, 1);
  assert.match(s.detail, /할당을 모르는 VM 이 섞인 법인 1곳/);
  assert.match(buildDailyReportText(r), /법인 GPU 할당률 90% 이상: 1건/);
  assert.equal(computeHealthReport({ vcenters: [], hosts: [], vms: [], datastores: [], alarms: [] }, { now: Date.now() }).sections.some((x) => x.key === 'gpuAlloc'), false);
});

test('④ 배치 추천의 프로파일 GB(웹 gpuAllocText.profileGB)는 서버 vgpuProfileGB 와 같은 값 — 같은 입력으로 대조', async () => {
  const { vgpuProfileGB } = await import('../src/gpu/vgpuProfile.js');
  const { profileGB } = await import('../../web/src/views/tools/gpuAllocText.js');
  for (const p of ['grid_a100-10c', 'nvidia_l40s-48q', 'grid_t4-16q', 'grid_a100-3-40c', 'grid_m60-0b', 'nvidia_l4-12q', 'weird', '', null, 'x'.repeat(200), 'GRID_A40-24Q']) {
    assert.equal(profileGB(p), vgpuProfileGB(p), String(p));
  }
});
