// v2.852 GPU 할당 계층 — 법인 › 데이터센터 › 클러스터 › 호스트 › GPU › VM(gpu/allocTree.js) · 수집기 GPU 배치 필드 · 엣지 수신 정제 · 엑셀.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildGpuAllocTree, buildHostAlloc, gpuCapacityOf, flatRows, FLAT_COLUMNS, allocCorpRoster, allocScopeOf } from '../src/gpu/allocTree.js';
import { renderGpuAllocWorkbook, allocCsvLines, ALLOC_XLSX_SHEETS, treeLines, allocExportOpts, allocFileName, corpSheetNames, SHEET_NAME_MAX, backLinkCol } from '../src/gpu/allocTreeXlsx.js';
import { internalLinkState } from '../src/util/xlsxInternalLink.js';
import { graphicsVmRefs, parseGpus, parseVmGpu, vmPassthroughPciIds } from '../src/vcenter/soapClient.js';
import { sanitizeHostGpus, sanitizeVmGpuField, sanitizeInventoryList } from '../src/routes/central.js';
import { csvCell } from '../src/util/csv.js';

const ON = 'POWERED_ON'; const OFF = 'POWERED_OFF';
const vm = (id, name, gpu, powerState = ON, host = 'esx1', vcenterId = 'vc1') => ({ id: `${vcenterId}:${id}`, name, host, vcenterId, powerState, gpu });
const vg = (profile, n = 1) => ({ type: 'vgpu', count: n, vgpu: n, passthrough: 0, profile });

/* ── 수집기 ─────────────────────────────────────────────────────────────── */
test('graphicsInfo 의 GPU 별 VM moref 를 읽는다 — 0 대면 빈 목록, 형식 밖은 버린다', () => {
  const g = (inner) => `<HostGraphicsInfo><deviceName>NVIDIA A40</deviceName><graphicsType>sharedDirect</graphicsType><memorySizeInKB>47185920</memorySizeInKB><pciId>0000:3b:00.0</pciId>${inner}</HostGraphicsInfo>`;
  const out = parseGpus(g('<vm type="VirtualMachine">vm-12</vm><vm type="VirtualMachine">vm-13</vm><vm type="VirtualMachine">vm-12</vm>') + g(''));
  assert.deepEqual(out[0].vms, ['vm-12', 'vm-13'], '중복은 한 번');
  assert.deepEqual(out[1].vms, [], '이 판 수집기는 0 대를 빈 목록으로 싣는다');
  assert.deepEqual(graphicsVmRefs('<vm type="VirtualMachine">bad ref!</vm>').vms, []);
});

test('VM 패스스루 장치의 PCI 주소 — 정적(id)·동적(assignedId), vGPU 장치는 건너뛴다', () => {
  const dev = (backing) => `<device xsi:type="VirtualPCIPassthrough"><key>13000</key><deviceInfo><label>PCI device 0</label></deviceInfo>${backing}</device>`;
  const xml = dev('<backing xsi:type="VirtualPCIPassthroughDeviceBackingInfo"><deviceName>GA100</deviceName><id>0000:3b:00.0</id><deviceId>20b5</deviceId></backing>')
    + dev('<backing xsi:type="VirtualPCIPassthroughVmiopBackingInfo"><vgpu>grid_a100-10c</vgpu></backing>')
    + dev('<backing xsi:type="VirtualPCIPassthroughDynamicBackingInfo"><assignedId>0000:af:00.0</assignedId></backing>');
  assert.deepEqual(vmPassthroughPciIds(xml), ['0000:3b:00.0', '0000:af:00.0']);
  const g = parseVmGpu(xml);
  assert.equal(g.type, 'mixed'); assert.equal(g.vgpu, 1); assert.equal(g.passthrough, 2);
  assert.deepEqual(g.pciIds, ['0000:3b:00.0', '0000:af:00.0']);
  assert.equal(parseVmGpu(dev('<backing xsi:type="VirtualPCIPassthroughVmiopBackingInfo"><vgpu>grid_a40-24q</vgpu></backing>')).pciIds, undefined, 'vGPU 만이면 pciIds 키가 없다');
});

/* ── 용량 ───────────────────────────────────────────────────────────────── */
test('GPU 용량 — vGPU 는 max(보고값, 명목값) · 패스스루는 모델명 추정 · 둘 다 없으면 null', () => {
  assert.deepEqual(gpuCapacityOf({ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu' }), { gb: 48, basis: 'nominal' });
  assert.deepEqual(gpuCapacityOf({ model: 'Unknown GPU', memGB: 20, mode: 'vgpu' }), { gb: 20, basis: 'reported' });
  assert.deepEqual(gpuCapacityOf({ model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough' }), { gb: 80, basis: 'model' });
  assert.deepEqual(gpuCapacityOf({ model: 'Mystery', memGB: null, mode: 'vgpu' }), { gb: null, basis: null });
});

/* ── 호스트 ─────────────────────────────────────────────────────────────── */
test('vGPU 호스트 — GPU 별 배치 · 슬롯 · 꺼진 VM 은 할당에서 빼고 따로 · 빈 GPU', () => {
  const h = { id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', vcDatacenter: 'DC1',
    gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: ['vm-1', 'vm-2'] }, { model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: ['vm-3', 'vm-4'] }, { model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: [] }] };
  const vms = [vm('vm-1', 'a', vg('grid_a40-24q')), vm('vm-2', 'b', vg('grid_a40-24q')), vm('vm-3', 'c', vg('grid_a40-12q')), vm('vm-4', 'd', vg('grid_a40-12q'), OFF), vm('vm-5', 'e', vg('grid_a40-12q'), OFF)];
  const r = buildHostAlloc(h, vms);
  const [g0, g1, g2] = r.gpus;
  assert.equal(g0.capGB, 48); assert.equal(g0.allocGB, 48); assert.equal(g0.spareGB, 0);
  assert.deepEqual(g0.slots, { total: 2, used: 2, free: 0, profile: 'grid_a40-24q' });
  assert.equal(g1.vms.length, 1, '꺼진 VM(vm-4)은 GPU 목록에 있어도 GPU 할당에 넣지 않는다');
  assert.equal(g1.allocGB, 12); assert.equal(g1.spareGB, 36); assert.equal(g1.slots.free, 3);
  assert.equal(g2.allocGB, 0); assert.equal(g2.spareGB, 48);
  assert.equal(r.totals.capGB, 144); assert.equal(r.totals.allocGB, 60); assert.equal(r.totals.spareGB, 84);
  assert.equal(r.totals.vmsOn, 3); assert.equal(r.totals.vmsOff, 2); assert.equal(r.totals.offGB, 24);
  assert.equal(r.totals.freeGpus, 1);
  assert.deepEqual(r.off.map((x) => x.name), ['d', 'e']);
  assert.equal(r.unplaced.length, 0);
});

test('배치 정보가 없는 GPU(구버전 수집기) — GPU 할당·예비는 null, VM 은 배치 정보 없음 묶음, 호스트 할당은 VM 구성으로', () => {
  const h = { vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', gpus: [{ model: 'NVIDIA A40', memGB: 48, mode: 'vgpu' }] };
  const r = buildHostAlloc(h, [vm('vm-1', 'a', vg('grid_a40-24q'))]);
  assert.equal(r.gpus[0].placement, false);
  assert.equal(r.gpus[0].allocGB, null); assert.equal(r.gpus[0].spareGB, null);
  assert.equal(r.unplaced[0].reason, 'no-placement');
  assert.equal(r.totals.allocGB, 24); assert.equal(r.totals.spareGB, 24, '호스트 예비는 구성으로 계산된다');
  assert.equal(r.totals.noPlacement, 1);
});

test('프로파일을 해석하지 못한 켜진 VM — 0 이 아니라 모름, 예비·할당률은 null(부분 합 금지)', () => {
  const h = { vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', gpus: [{ model: 'NVIDIA T4', memGB: 16, mode: 'vgpu', vms: ['vm-1', 'vm-2'] }] };
  const r = buildHostAlloc(h, [vm('vm-1', 'a', vg('grid_t4-8q')), vm('vm-2', 'b', vg('vgpu-custom'))]);
  assert.equal(r.gpus[0].allocGB, null); assert.equal(r.gpus[0].spareGB, null);
  assert.equal(r.totals.allocUnknown, 1); assert.equal(r.totals.allocGB, 8);
  assert.equal(r.totals.spareGB, null); assert.equal(r.totals.allocPct, null);
});

test('패스스루 — pciId 로 GPU 와 VM 을 맞춘다 · 한 장 통째 · 미할당 GPU 는 1장 예비 · vSGA 는 합계 제외', () => {
  const h = { vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', gpus: [
    { model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough', pciId: '0000:3b:00.0' },
    { model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough', pciId: '0000:3c:00.0' },
    { model: 'NVIDIA T4', memGB: 16, mode: 'vsga' }] };
  const r = buildHostAlloc(h, [vm('vm-1', 'pt', { type: 'passthrough', count: 1, vgpu: 0, passthrough: 1, profile: '', pciIds: ['0000:3c:00.0'] })]);
  assert.equal(r.gpus[0].vms.length, 0); assert.equal(r.gpus[0].spareGB, 80);
  assert.equal(r.gpus[1].vms[0].name, 'pt'); assert.equal(r.gpus[1].allocGB, 80); assert.equal(r.gpus[1].spareGB, 0);
  assert.equal(r.gpus[2].mode, 'vsga');
  assert.equal(r.totals.gpus, 2); assert.equal(r.totals.vsga, 1);
  assert.equal(r.totals.capGB, 160); assert.equal(r.totals.allocGB, 80); assert.equal(r.totals.spareGB, 80);
});

/* ── 계층 · 범위 ────────────────────────────────────────────────────────── */
function snap() {
  return {
    vcenters: [{ id: 'vc1', name: 'vcenter-kr', location: { city: 'Seoul', country: 'South Korea' } }, { id: 'vc2', name: 'vcenter-de' }],
    hosts: [
      { id: 'vc1:h1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL-B', clusterRef: 'domain-c2', vcDatacenter: 'DC1', gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1'] }] },
      { id: 'vc1:h2', vcenterId: 'vc1', name: 'esx2', cluster: 'CL-A', clusterRef: 'domain-c1', vcDatacenter: 'DC1', gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: [] }] },
      { id: 'vc1:h3', vcenterId: 'vc1', name: 'esx3', cluster: 'CL-A', vcDatacenter: null, gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: [] }] },
      { id: 'vc1:h4', vcenterId: 'vc1', name: 'esx4', cluster: 'CL-A', clusterRef: 'domain-c1', vcDatacenter: 'DC1', gpus: [] },
      { id: 'vc2:h1', vcenterId: 'vc2', name: 'esx1', cluster: 'CL', vcDatacenter: 'FRA', gpus: [{ model: 'NVIDIA A16', memGB: 16, mode: 'vgpu', vms: ['vm-9'] }] },
    ],
    vms: [
      vm('vm-1', 'kr-vm', vg('nvidia_l4-12q'), ON, 'esx1', 'vc1'),
      vm('vm-9', 'de-vm', vg('grid_a16-4q'), ON, 'esx1', 'vc2'),
      { ...vm('vm-7', 'tmpl', vg('nvidia_l4-12q'), OFF, 'esx2', 'vc1'), template: true },
    ],
  };
}

test('계층 — 법인 › 데이터센터(모름은 뒤) › 클러스터(이름순) › 호스트 · GPU 없는 호스트·템플릿 제외 · 동명 호스트를 섞지 않는다', () => {
  const t = buildGpuAllocTree(snap());
  assert.deepEqual(t.vcenters.map((v) => v.name), ['vcenter-de', 'vcenter-kr']);
  const kr = t.vcenters[1];
  assert.equal(kr.city, 'Seoul');
  assert.deepEqual(kr.datacenters.map((d) => d.name), ['DC1', '']);
  assert.deepEqual(kr.datacenters[0].clusters.map((c) => c.name), ['CL-A', 'CL-B']);
  assert.deepEqual(kr.datacenters[0].clusters[0].hosts.map((h) => h.name), ['esx2'], 'GPU 없는 esx4 는 빠진다');
  assert.equal(kr.totals.vmsOff, 0, '템플릿은 GPU VM 으로 세지 않는다');
  assert.equal(kr.totals.allocGB, 12);
  assert.equal(t.vcenters[0].totals.allocGB, 4, 'vc2 의 동명 호스트 esx1 은 vc2 의 VM 만');
  assert.equal(t.totals.capGB, 24 * 3 + 16); assert.equal(t.totals.hosts, 4);
});

test('범위 — allowed 가 요청 필터보다 먼저(범위 밖 vcenterId 는 빈 결과)', () => {
  const allowed = new Set(['vc1']);
  assert.deepEqual(buildGpuAllocTree(snap(), { allowed }).vcenters.map((v) => v.id), ['vc1']);
  assert.equal(buildGpuAllocTree(snap(), { allowed, vcenterId: 'vc2' }).vcenters.length, 0);
  assert.deepEqual(buildGpuAllocTree(snap(), { vcenterId: 'vc2' }).vcenters.map((v) => v.id), ['vc2']);
});

test('평면 행 · CSV — 계층 열을 모두 채우고 빈 GPU 도 한 줄', () => {
  const t = buildGpuAllocTree(snap(), { vcenterId: 'vc1' });
  const rows = flatRows(t);
  assert.equal(rows.length, 3);
  const r0 = rows.find((r) => r.vm === 'kr-vm');
  assert.equal(r0.datacenter, 'DC1'); assert.equal(r0.vmGB, 12); assert.equal(r0.gpuSpareGB, 12);
  assert.ok(rows.some((r) => r.datacenter === '(데이터센터 모름)'));
  const lines = allocCsvLines(t, csvCell);
  assert.equal(lines[0], FLAT_COLUMNS.map(([, h]) => h).join(','));
  assert.equal(lines.length, 4);
});

test('엑셀 — 시트 3장 · 계층 표 개요 단계 · 평면 표 자동 필터', async () => {
  const t = buildGpuAllocTree(snap());
  // v2.869: 기본에 법인별 시트(corp)가 들어갔다 — 여기서는 옛 3시트 구성(옛 화면이 보내는 sheets)을 본다.
  const buf = await renderGpuAllocWorkbook(t, { stamp: '2026-11-02 16:00', tz: 'KST', scopeText: '전체 법인' }, { sheets: ['tree', 'flat', 'info'] });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ALLOC_XLSX_SHEETS.slice(0, 3));
  const ws = wb.worksheets[0];
  assert.equal(ws.properties.outlineLevelRow, 5);
  const lines = treeLines(t);
  assert.equal(ws.getRow(6).getCell(1).value.startsWith('vcenter-de'), true);
  assert.equal(ws.getRow(6 + lines.length - 1).outlineLevel, lines[lines.length - 1].depth);
  assert.ok(wb.worksheets[1].autoFilter);
});

/* ── 엣지 수신 정제 ─────────────────────────────────────────────────────── */
test('엣지가 보낸 gpus·gpu — 배열·객체만, 새 필드는 형식 밖이면 지운다(배치 정보 없음)', () => {
  assert.deepEqual(sanitizeHostGpus('x').value, []);
  const g = sanitizeHostGpus([null, { model: 'A40', vms: ['vm-1', 'bad ref', 7], pciId: '0000:3b:00.0' }, { model: 'A40', vms: 'vm-1', pciId: { a: 1 } }]);
  assert.equal(g.value.length, 2);
  assert.deepEqual(g.value[0].vms, ['vm-1']);
  assert.equal(Object.hasOwn(g.value[1], 'vms'), false, '배열이 아니면 키를 지운다 — 0 대로 지어내지 않는다');
  assert.equal(g.value[1].pciId, null);
  assert.ok(g.coerced >= 4);
  assert.equal(sanitizeVmGpuField('vgpu').value, null);
  assert.deepEqual(sanitizeVmGpuField({ type: 'passthrough', pciIds: ['0000:3b:00.0', '../x'] }).value.pciIds, ['0000:3b:00.0']);
  const dropped = { notObject: 0, otherVcenter: 0, badId: 0, coerced: 0 };
  const [h] = sanitizeInventoryList([{ id: 'vc1:h1', name: 'esx1', gpus: 'oops' }], 'vc1', 10, dropped);
  assert.deepEqual(h.gpus, []);
  assert.ok(dropped.coerced >= 1);
});

/* ── v2.853 법인 칩(여러 법인 선택) ─────────────────────────────────────── */
test('v2.853 vcenterIds — 고른 법인만, 조회 범위가 먼저(범위 밖 id 는 빠진다)', () => {
  assert.deepEqual(buildGpuAllocTree(snap(), { vcenterIds: new Set(['vc2']) }).vcenters.map((v) => v.id), ['vc2']);
  assert.deepEqual(buildGpuAllocTree(snap(), { vcenterIds: new Set(['vc1', 'vc2']) }).vcenters.map((v) => v.id), ['vc2', 'vc1']);
  assert.equal(buildGpuAllocTree(snap(), { allowed: new Set(['vc1']), vcenterIds: new Set(['vc2']) }).vcenters.length, 0);
  assert.equal(buildGpuAllocTree(snap(), { vcenterIds: new Set() }).vcenters.length, 2, '빈 선택 = 전체');
});

/* ── v2.855 내보내기 창(넣을 단계 · 시트) ───────────────────────────────── */
test('v2.855 내보내기 선택 — 기본은 VM 까지 · 시트 셋, 모르는 값은 거부(조용히 버리지 않는다)', () => {
  assert.deepEqual(allocExportOpts({}), { ok: true, depth: 'vm', sheets: ['tree', 'flat', 'info', 'corp'] }, 'v2.869: 법인별 시트 기본 켬');
  assert.deepEqual(allocExportOpts({ depth: 'host', sheets: 'info,tree' }), { ok: true, depth: 'host', sheets: ['tree', 'info'] });
  assert.equal(allocExportOpts({ depth: 'cluster' }).ok, false);
  assert.equal(allocExportOpts({ sheets: 'tree,evil' }).ok, false);
  assert.equal(allocExportOpts({ sheets: ',' }).ok, false, '시트를 하나도 안 고르면 거부');
  assert.equal(allocFileName('all', '20261102-1800', 'xlsx'), 'gpu-allocation_all_20261102-1800.xlsx');
  assert.equal(allocFileName('AZ', '20261102-1800', 'xlsx', 'gpu'), 'gpu-allocation_AZ_20261102-1800_gpu.xlsx');
});

test('v2.855 엑셀 — 호스트까지면 계층 표에 GPU·VM 행이 없고, 고른 시트만 만든다', async () => {
  const t = buildGpuAllocTree(snap());
  const meta = { stamp: '2026-11-02 18:00', tz: 'KST', scopeText: '전체 법인' };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await renderGpuAllocWorkbook(t, meta, { depth: 'host', sheets: ['tree', 'info'] }));
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['계층 표', '안내']);
  const ws = wb.worksheets[0];
  const hostLines = treeLines(t).filter((x) => x.depth < 4).length;
  assert.equal(ws.properties.outlineLevelRow, 3);
  assert.equal(ws.rowCount, 5 + hostLines, '머리 5행 + 호스트까지의 행');
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(await renderGpuAllocWorkbook(t, meta, { sheets: ['flat'] }));
  assert.deepEqual(wb2.worksheets.map((w) => w.name), ['평면 표']);
});

/* ── v2.868 호스트·VM CPU/메모리 ─────────────────────────────────────────── */
test('v2.868 CPU/메모리 — 호스트·VM 값 · 법인 합(MHz·MB 가중 사용률) · 꺼진 VM 사용률·모르는 값은 null', () => {
  const host = (id, name, o = {}) => ({ id: `vc1:${id}`, vcenterId: 'vc1', name, cluster: 'CL', vcDatacenter: 'DC1', connectionState: 'CONNECTED',
    cpuCores: 32, cpuTotalMhz: 64000, cpuUsageMhz: 16000, cpuUsagePct: 25, memTotalMB: 524288, memUsageMB: 262144, memUsagePct: 50,
    gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1'] }], ...o });
  const vmx = (id, name, hostName, o = {}) => ({ ...vm(id, name, vg('nvidia_l4-12q'), ON, hostName, 'vc1'), cpuCount: 8, memMB: 32768, cpuUsagePct: 40, memUsagePct: 60, ...o });
  const s = {
    vcenters: [{ id: 'vc1', name: 'vc' }],
    hosts: [host('h1', 'esx1'), host('h2', 'esx2', { cpuCores: 16, cpuTotalMhz: 32000, cpuUsageMhz: 24000, memTotalMB: 262144, memUsageMB: 196608, gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: [] }] })],
    vms: [vmx('vm-1', 'a', 'esx1'), vmx('vm-2', 'off', 'esx1', { powerState: OFF, cpuUsagePct: 0, memUsagePct: 0 })],
  };
  const t = buildGpuAllocTree(s);
  const h1 = t.vcenters[0].datacenters[0].clusters[0].hosts.find((h) => h.name === 'esx1');
  assert.deepEqual(h1.res, { cores: 32, memGB: 512, cpuPct: 25, memPct: 50 });
  assert.deepEqual(h1.gpus[0].vms[0].res, { vcpu: 8, memGB: 32, cpuPct: 40, memPct: 60 });
  assert.deepEqual(h1.off[0].res, { vcpu: 8, memGB: 32, cpuPct: null, memPct: null }, '꺼진 VM 의 사용률은 0 이 아니라 모름');
  const T = t.totals;
  assert.equal(T.hostCores, 48); assert.equal(T.hostMemGB, 768);
  assert.equal(T.hostCpuPct, Math.round((40000 / 96000) * 100), 'MHz 합으로 낸 가중 사용률');
  assert.equal(T.hostMemPct, Math.round((458752 / 786432) * 100));
  assert.equal(T.vmVcpu, 8, '켜진 GPU VM 만 더한다'); assert.equal(T.vmMemGB, 32);
  // 끊긴 호스트 — 그 호스트 사용률은 null · 합 사용률은 읽은 호스트만으로(대수는 hostUseUnknown) · 코어·메모리 합은 그대로
  const s2 = { ...s, hosts: [s.hosts[0], { ...s.hosts[1], connectionState: 'DISCONNECTED' }] };
  const t2 = buildGpuAllocTree(s2);
  assert.equal(t2.totals.hostCpuPct, 25, '끊긴 호스트를 빼고 읽은 호스트 기준'); assert.equal(t2.totals.hostUseUnknown, 1);
  assert.equal(t2.totals.hostCores, 48);
  assert.ok(treeLines(t2)[0].cells[16].includes('1대 제외'), '비고가 뺀 대수를 말한다');
  assert.equal(buildGpuAllocTree({ ...s, hosts: s.hosts.map((h) => ({ ...h, connectionState: 'DISCONNECTED' })) }).totals.hostCpuPct, null, '읽은 호스트가 0 이면 null');
  // 코어를 모르는 호스트 — 코어·메모리 합은 null
  const t3 = buildGpuAllocTree({ ...s, hosts: [s.hosts[0], { ...s.hosts[1], cpuCores: null }] });
  assert.equal(t3.totals.hostCores, null);
  // 평면 행 · 엑셀 계층 줄에 값이 실린다
  const fr = flatRows(t).find((r) => r.vm === 'a');
  assert.equal(fr.hostCores, 32); assert.equal(fr.vmVcpu, 8); assert.equal(fr.vmMemGB, 32); assert.equal(fr.vmCpuPct, 40);
  const lines = treeLines(t);
  assert.equal(lines[0].cells.length, 17);
  assert.deepEqual(lines[0].cells.slice(10, 16), [48, T.hostCpuPct, 768, T.hostMemPct, 8, 32]);
  const vmLine = lines.find((l) => l.cells[0] === 'a');
  assert.deepEqual(vmLine.cells.slice(10, 16), [8, 40, 32, 60, null, null]);
});

/* ── v2.869 법인별 시트(승인 시안 docs/design/gpu-alloc-corp-sheets) ───────────────── */
test('v2.869 시트 이름 — 금지 문자 · 31자 · 끝의 - . 제거 · 고정 시트·대소문자 겹침은 ~2', () => {
  const m = corpSheetNames([
    { id: 'a', name: 'vc:01/[x]' }, { id: 'b', name: 'vcenter-ap-southeast-singapore-01' }, { id: 'c', name: '목차' },
    { id: 'd', name: 'VC:01/[X]' }, { id: 'e', name: "'quoted'" }, { id: 'f', name: '' }, { id: 'g', name: 'abcdefghijklmnopqrstuvwxyz-1234-zz' },
  ]);
  assert.deepEqual(m.get('a'), { sheet: 'vc_01__x_', renamed: true });
  assert.equal(m.get('b').sheet, 'vcenter-ap-southeast-singapore', '31자로 자르고 끝의 - 를 뗀다');
  assert.equal(m.get('b').renamed, true);
  assert.equal(m.get('c').sheet, '목차~2', '고정 시트 이름과 겹치지 않는다');
  assert.equal(m.get('d').sheet, 'VC_01__X_~2', '대소문자만 다른 이름도 겹침');
  assert.equal(m.get('e').sheet, 'quoted', '작은따옴표로 시작·끝 금지');
  assert.equal(m.get('f').sheet, 'f', '이름이 없으면 id');
  for (const v of m.values()) { assert.ok(v.sheet.length <= SHEET_NAME_MAX); assert.doesNotMatch(v.sheet, /[\\/?*[\]:]/); }
  assert.equal(corpSheetNames([{ id: 'x', name: 'vcenter-kr' }]).get('x').renamed, false);
});

test('v2.869 법인 목록 — GPU 호스트 없는 법인도 · 조회 범위가 먼저 · 고른 법인만 · id 순', () => {
  const s = snap(); s.vcenters.push({ id: 'vc0', name: 'vcenter-br', location: { city: 'Sao Paulo' } });
  const t = buildGpuAllocTree(s);
  const r = allocCorpRoster(s, {}, t);
  assert.deepEqual(r.map((c) => c.id), ['vc0', 'vc1', 'vc2']);
  assert.equal(r[0].vc, null, 'GPU 호스트 없는 법인은 노드 없음');
  assert.equal(r[1].vc, t.vcenters.find((v) => v.id === 'vc1'));
  const allowed = new Set(['vc1', 'vc0']);
  assert.deepEqual(allocCorpRoster(s, { allowed, vcenterIds: new Set(['vc0', 'vc2']) }, buildGpuAllocTree(s, { allowed })).map((c) => c.id), ['vc0'], '범위 밖 vc2 는 골라도 빠진다');
  assert.deepEqual(allocCorpRoster(s, { vcenterId: 'vc2' }, null).map((c) => c.id), ['vc2']);
});

test('v2.869 엑셀 — 고정 3장 + 목차 + GPU 법인마다 한 장 · 목차 링크 · ← 목차 · 탭 색 · 파일 이름', async () => {
  const s = snap(); s.vcenters.push({ id: 'vc0', name: 'vcenter-br' });
  const t = buildGpuAllocTree(s);
  const roster = allocCorpRoster(s, {}, t);
  const meta = { stamp: '2026-11-03 20:00', tz: 'KST', scopeText: '전체 법인' };
  const wb = new ExcelJS.Workbook();
  const buf = await renderGpuAllocWorkbook(t, meta, { roster });
  await wb.xlsx.load(buf);
  assert.equal(internalLinkState(), 'patched');
  // 시트 안 링크는 읽어 들일 때 exceljs 가 값으로 되살리지 않는다(관계 없는 location) — 파일 XML 을 직접 본다.
  const zip = await (await import('jszip')).default.loadAsync(buf);
  const tocXml = await zip.file('xl/worksheets/sheet4.xml').async('string');
  assert.match(tocXml, /<hyperlink ref="A5" location="&apos;vcenter-kr&apos;!A1"\/>/, '목차 → 법인 시트');
  assert.match(tocXml, /<hyperlink ref="A6" location="&apos;vcenter-de&apos;!A1"\/>/);
  assert.doesNotMatch(tocXml, /ref="A4"/, 'GPU 없는 법인은 링크 없음');
  const krXml = await zip.file('xl/worksheets/sheet5.xml').async('string');
  assert.match(krXml, /<hyperlink ref="[A-Z]+1" location="&apos;목차&apos;!A1"\/>/, '법인 시트 → 목차');
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['계층 표', '평면 표', '안내', '목차', 'vcenter-kr', 'vcenter-de'], '법인 시트는 id 순 · GPU 없는 vc0 은 시트 없음');
  const toc = wb.getWorksheet('목차');
  const names = [4, 5, 6].map((r) => { const v = toc.getRow(r).getCell(1).value; return typeof v === 'object' ? v.text : v; });
  assert.deepEqual(names, ['vcenter-br', 'vcenter-kr', 'vcenter-de'], '목차는 범위 안 법인 전부');
  assert.match(String(toc.getRow(4).getCell(10).value), /GPU 호스트 없음/);
  assert.equal(toc.getRow(4).getCell(5).value, null, 'GPU 없는 법인의 용량은 빈 칸(0 아님)');
  assert.equal(toc.getRow(5).getCell(1).text, 'vcenter-kr');
  assert.equal(toc.properties.tabColor.argb, 'FF64748B');
  const kr = wb.getWorksheet('vcenter-kr');
  assert.match(String(kr.getRow(1).getCell(1).value), /vcenter-kr\s+\(Seoul · South Korea\)/);
  const bc = backLinkCol(kr.getRow(1).getCell(1).value);
  assert.equal(kr.getRow(1).getCell(bc).text, '← 목차');
  for (let c = 2; c < bc; c++) assert.equal(kr.getRow(1).getCell(c).value, null, '제목이 넘쳐 보일 칸은 비워 둔다');
  assert.ok(backLinkCol('GPU 할당 계층 — vcenter-ap-southeast-singapore-01  (Singapore · Singapore)') > backLinkCol('GPU 할당 계층 — kr'), '긴 제목이면 링크가 더 오른쪽');
  assert.ok(String(kr.getRow(6).getCell(1).value).startsWith('vcenter-kr'), '법인 시트는 그 법인 줄부터');
  const krLines = treeLines({ vcenters: [t.vcenters.find((v) => v.id === 'vc1')] });
  assert.equal(kr.rowCount, 5 + krLines.length, '전체 계층 표에서 그 법인 줄부터 아래 그대로');
  assert.equal(kr.getRow(4).getCell(2).value, 12, 'KPI 는 그 법인 값(할당 12 GB)');
  assert.equal(kr.properties.tabColor.argb, 'FF3B82F6');
  assert.equal(kr.properties.outlineLevelRow, 5);
  const de = wb.getWorksheet('vcenter-de');
  assert.equal(de.properties.tabColor.argb, 'FF3B82F6');
  assert.ok(wb.getWorksheet('안내').getColumn(1).values.includes('법인별 시트'));
  assert.equal(allocFileName('all', '20261103-2000', 'xlsx', 'vm', true), 'gpu-allocation_all_20261103-2000_percorp.xlsx');
  assert.equal(allocFileName('all', '20261103-2000', 'xlsx', 'host', true), 'gpu-allocation_all_20261103-2000_host_percorp.xlsx');
  // 단계는 법인 시트에도 — 호스트까지면 GPU·VM 행이 없다
  const wb2 = new ExcelJS.Workbook();
  await wb2.xlsx.load(await renderGpuAllocWorkbook(t, meta, { roster, depth: 'host', sheets: ['corp'] }));
  assert.deepEqual(wb2.worksheets.map((w) => w.name), ['목차', 'vcenter-kr', 'vcenter-de']);
  const kr2 = wb2.getWorksheet('vcenter-kr');
  for (let r = 6; r <= kr2.rowCount; r++) assert.ok(kr2.getRow(r).outlineLevel <= 3);
});

test('v2.869 엑셀 — 할당률 90% 이상 법인 탭은 주황 · 시트 링크는 규격 모양(location 만, 외부 관계 없음)', async () => {
  const s = snap();
  s.vms.push(vm('vm-2', 'kr-vm2', vg('nvidia_l4-12q'), ON, 'esx1', 'vc1'));
  const t = buildGpuAllocTree(s, { vcenterId: 'vc1' });
  // esx1 L4 24 GB 에 12q 두 대 = 24/72 → 33%: 주황 아님. vc2 는 16 GB 에 4 GB → 25%.
  const wb = new ExcelJS.Workbook();
  const hot = { ...t, vcenters: t.vcenters.map((v) => ({ ...v, totals: { ...v.totals, allocPct: 95 } })) };
  const buf = await renderGpuAllocWorkbook(hot, { stamp: 'x', tz: 'KST', scopeText: 'vcenter-kr' }, { sheets: ['corp'] });
  await wb.xlsx.load(buf);
  assert.equal(wb.getWorksheet('vcenter-kr').properties.tabColor.argb, 'FFF59E0B');
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const tocXml1 = await zip.file('xl/worksheets/sheet1.xml').async('string');
  assert.match(tocXml1, /<hyperlink ref="A4" location="&apos;vcenter-kr&apos;!A1"\/>/);
  assert.equal(zip.file('xl/worksheets/_rels/sheet1.xml.rels'), null, '시트 안 링크는 외부 관계를 만들지 않는다');
});

/* ── v2.871 버그 점검 ─────────────────────────────────────────────────── */
test('v2.871 GPU 아닌 패스스루(NIC · HBA) — 주소를 다 읽었으면 GPU 로 세지 않는다 · 예비가 비지 않는다', () => {
  const pt = (pciIds, n = pciIds.length, extra = {}) => ({ type: 'passthrough', count: n, vgpu: 0, passthrough: n, profile: '', pciIds, ...extra });
  // ① vGPU 호스트 + NIC 만 패스스루로 받은 VM → 계층 대상이 아니다(예전: 할당 모름 → 예비·할당률 null)
  const hv = { vcenterId: 'vc1', name: 'esx1', gpus: [{ model: 'NVIDIA L4', memGB: 24, mode: 'vgpu', vms: ['vm-1'] }] };
  const r1 = buildHostAlloc(hv, [vm('vm-1', 'cad', vg('nvidia_l4-12q')), vm('vm-2', 'rdma-only', pt(['0000:af:00.0']))]);
  assert.equal(r1.totals.allocUnknown, 0); assert.equal(r1.totals.spareGB, 12); assert.equal(r1.totals.allocPct, 50);
  assert.equal(r1.totals.vmsOn, 1, 'NIC 만 가진 VM 은 GPU VM 이 아니다');
  assert.equal(r1.unplaced.length, 0);
  // ② vGPU + NIC 패스스루를 함께 가진 VM → vGPU GB 만
  const mixed = { type: 'mixed', count: 2, vgpu: 1, passthrough: 1, profile: 'nvidia_l4-12q', pciIds: ['0000:af:00.0'] };
  const r2 = buildHostAlloc(hv, [vm('vm-1', 'ai', mixed)]);
  assert.equal(r2.totals.allocGB, 12); assert.equal(r2.totals.spareGB, 12);
  assert.equal(r2.gpus[0].vms[0].passthroughDevices, 0, '표시도 GPU 장치 수만');
  // ③ 패스스루 GPU 1장 + NIC 1장(주소 대소문자 달라도 같은 장치)
  const hp = { vcenterId: 'vc1', name: 'esx1', gpus: [{ model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough', pciId: '0000:3b:00.0' }] };
  const r3 = buildHostAlloc(hp, [vm('vm-1', 'train', pt(['0000:3B:00.0', '0000:af:00.0']))]);
  assert.equal(r3.gpus[0].vms.length, 1); assert.equal(r3.totals.allocGB, 80); assert.equal(r3.totals.spareGB, 0);
  assert.equal(r3.gpus[0].vms[0].passthroughDevices, 1);
  // ④ 주소를 다 못 읽으면(구버전 수집기 · 꺼진 VM 의 동적 DirectPath) 예전처럼 전부 GPU 로 본다 — 지어내지 않는다
  const r4 = buildHostAlloc(hv, [vm('vm-2', 'old', pt(undefined, 1))]);
  assert.equal(r4.totals.allocUnknown, 1); assert.equal(r4.totals.spareGB, null);
  const r5 = buildHostAlloc(hp, [vm('vm-3', 'half', pt(['0000:af:00.0'], 2))]);
  assert.equal(r5.totals.allocGB, 160, '두 장 중 하나만 읽었으면 GPU 2장으로(같은 모델 균일 추정) — 예전 그대로');
});

test('v2.871 범위 글자 · 파일 이름 — GPU 없는 법인도 고른 법인으로 센다 · 많으면 외 N곳', () => {
  const tree = { vcenters: [{ id: 'vc1', name: 'kr' }] };
  assert.deepEqual(allocScopeOf({ picked: true, tree, rosterIds: ['vc0', 'vc1', 'vc2'] }), { scopeText: '법인 3곳 — vc0, vc1, vc2', fileScope: '3corps' });
  assert.deepEqual(allocScopeOf({ picked: true, tree: { vcenters: [] }, rosterIds: ['vc0'] }), { scopeText: '법인 1곳 — vc0', fileScope: 'vc0' }, 'GPU 없는 법인만 골라도 범위 밖이 아니다');
  assert.equal(allocScopeOf({ picked: true, tree, rosterIds: [] }).scopeText, '고른 법인(조회 범위 안에 없음)');
  assert.equal(allocScopeOf({ picked: true, tree, rosterIds: ['a', 'b', 'c', 'd', 'e', 'f'] }).scopeText, '법인 6곳 — a, b, c 외 3곳');
  assert.deepEqual(allocScopeOf({ tree }), { scopeText: '전체 법인', fileScope: 'all' });
  assert.deepEqual(allocScopeOf({ vcenterId: 'vc1', tree }), { scopeText: 'kr', fileScope: 'vc1' });
  assert.equal(allocScopeOf({ vcenterId: 'a b/c', tree: { vcenters: [] } }).fileScope, 'a_b_c', '파일 이름에 쓸 수 없는 글자는 _');
});
