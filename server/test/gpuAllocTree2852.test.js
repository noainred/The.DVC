// v2.852 GPU 할당 계층 — 법인 › 데이터센터 › 클러스터 › 호스트 › GPU › VM(gpu/allocTree.js) · 수집기 GPU 배치 필드 · 엣지 수신 정제 · 엑셀.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { buildGpuAllocTree, buildHostAlloc, gpuCapacityOf, flatRows, FLAT_COLUMNS } from '../src/gpu/allocTree.js';
import { renderGpuAllocWorkbook, allocCsvLines, ALLOC_XLSX_SHEETS, treeLines, allocExportOpts, allocFileName } from '../src/gpu/allocTreeXlsx.js';
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
  const buf = await renderGpuAllocWorkbook(t, { stamp: '2026-11-02 16:00', tz: 'KST', scopeText: '전체 법인' });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), [...ALLOC_XLSX_SHEETS]);
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
  assert.deepEqual(allocExportOpts({}), { ok: true, depth: 'vm', sheets: ['tree', 'flat', 'info'] });
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
