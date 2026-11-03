/**
 * test/gpuAllocUnknown2869.test.js — v2.869 감사 GPU 할당 '모름' 표시(A4-01 · A4-05 · A1-01).
 *  · A4-01: 꺼진 VM 의 용량을 모르면(offUnknown) 합계 비고에 '꺼진 VM 용량 모름 N대'(웹 totalsNote · 엑셀 totalsCells 같은 말).
 *    예전(재현): offGB 는 아는 것만 더하고 offUnknown 소비처가 0 이라 모름 1대가 어디에도 보이지 않았다.
 *  · A4-05: 배치 정보 없는 GPU 의 VM 칸은 '0 / 0' 이 아니라 '—' · 엑셀 프로파일 칸은 '비어 있음' 이 아니라 '배치 정보 없음'(웹 gpuTexts.prof 와 대조).
 *  · A1-01: 끊긴 호스트 판정은 store.usageReadable 과 같은 규칙(NOT_RESPONDING 포함 — 잠재 결함, SOAP 는 DISCONNECTED 로 접어 보낸다).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHostAlloc, gpuProfText, gpuVmsText, hostResOf, hostDown } from '../src/gpu/allocTree.js';
import { treeLines } from '../src/gpu/allocTreeXlsx.js';

const W = await import('../../web/src/views/tools/gpuAllocText.js');

const ON = 'POWERED_ON'; const OFF = 'POWERED_OFF';
const vm = (id, name, gpu, powerState = ON) => ({ id: `vc1:${id}`, name, host: 'esx1', vcenterId: 'vc1', powerState, gpu });
const vg = (profile) => ({ type: 'vgpu', count: 1, vgpu: 1, passthrough: 0, profile });
const tree = (h) => ({ vcenters: [{ id: 'vc1', name: 'VC1', totals: h.totals, datacenters: [{ name: 'DC1', totals: h.totals, clusters: [{ key: 'CL1', name: 'CL1', totals: h.totals, hosts: [h] }] }] }] });

test('A4-01 꺼진 VM 용량 모름 — 웹 · 엑셀 비고에 같은 말', () => {
  const h = { id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', vcDatacenter: 'DC1', gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: [] }] };
  const r = buildHostAlloc(h, [vm('vm-1', 'a', vg('grid_a40-8q'), OFF), vm('vm-2', 'b', vg('grid_a40-8q'), OFF), vm('vm-3', 'c', vg('???'), OFF)]);
  assert.equal(r.totals.offGB, 16); assert.equal(r.totals.offUnknown, 1);
  assert.match(W.totalsNote(r.totals).note, /꺼진 VM 용량 모름 1대/);
  const hostLine = treeLines(tree(r)).find((l) => l.depth === 3);
  assert.match(hostLine.cells.at(-1), /꺼진 VM 용량 모름 1대/);
  // 모름이 없으면 붙이지 않는다
  const r2 = buildHostAlloc(h, [vm('vm-1', 'a', vg('grid_a40-8q'), OFF)]);
  assert.doesNotMatch(W.totalsNote(r2.totals).note, /꺼진 VM/);
});

test('A4-05 배치 정보 없는 GPU — VM 칸 ‘—’ · 프로파일 ‘배치 정보 없음’(웹 · 엑셀 같은 판정)', () => {
  const h = { id: 'vc1:host-1', vcenterId: 'vc1', name: 'esx1', cluster: 'CL1', vcDatacenter: 'DC1', gpus: [{ model: 'NVIDIA A40', memGB: 48, mode: 'vgpu' }, { model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough' }] };
  const r = buildHostAlloc(h, [vm('vm-1', 'a', vg('grid_a40-24q'))]);
  for (const g of r.gpus) {
    assert.equal(g.placement, false);
    assert.equal(gpuVmsText(g), '—');
    assert.equal(gpuProfText(g), '배치 정보 없음');
    assert.equal(gpuProfText(g), W.gpuTexts(g).prof, '웹 gpuTexts.prof 와 같은 말');
  }
  const gpuLines = treeLines(tree(r)).filter((l) => l.depth === 4 && /^GPU #/.test(l.cells[0]));
  assert.equal(gpuLines.length, 2);
  for (const l of gpuLines) { assert.equal(l.cells[2], '배치 정보 없음'); assert.equal(l.cells[9], '—'); }
  const rows = W.flattenAlloc(tree(r), { open: W.openForLevel(tree(r), 5) }).filter((x) => x.kind === 'gpu' || x.kind === 'pt');
  assert.equal(rows.length, 2);
  for (const x of rows) assert.equal(x.vms, '—');
  // 배치를 아는 GPU 는 예전 그대로 — 웹 · 엑셀 프로파일 대조
  const h2 = { ...h, gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: ['vm-1'] }, { model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: [] }, { model: 'NVIDIA A100 80GB', memGB: 80, mode: 'passthrough', vms: [] }] };
  const r2 = buildHostAlloc(h2, [vm('vm-1', 'a', vg('grid_a40-24q'))]);
  for (const g of r2.gpus) assert.equal(gpuProfText(g), W.gpuTexts(g).prof, JSON.stringify(g.mode));
  assert.equal(gpuVmsText(r2.gpus[0]), '1 / 0');
});

test('A1-01 끊긴 호스트 — DISCONNECTED · NOT_RESPONDING 둘 다 사용률 모름(store.usageReadable 과 같은 규칙)', () => {
  const base = { cpuCores: 32, memTotalMB: 262144, cpuTotalMhz: 80000, cpuUsageMhz: 32000, memUsageMB: 131072, cpuUsagePct: 40, memUsagePct: 50 };
  for (const [cs, down] of [['CONNECTED', false], ['MAINTENANCE', false], ['DISCONNECTED', true], ['NOT_RESPONDING', true]]) {
    assert.equal(hostDown({ connectionState: cs }), down, cs);
    assert.equal(hostResOf({ ...base, connectionState: cs }).cpuPct == null, down, cs);
    const t = buildHostAlloc({ ...base, connectionState: cs, vcenterId: 'vc1', name: 'esx1', gpus: [{ model: 'NVIDIA A40', memGB: 45, mode: 'vgpu', vms: [] }] }, []).totals;
    assert.equal(t.hostUseUnknown, down ? 1 : 0, cs);
  }
});
