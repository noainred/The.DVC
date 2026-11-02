// v2.852 GPU 할당 계층 — 화면 행 펼치기·형제 정렬·찾기·글자(gpuAllocText.js).
import { describe, it, expect } from 'vitest';
import { flattenAlloc, openForLevel, sortSiblings, totalsNote, gpuTexts, numText, ALLOC_LEVELS, DEFAULT_LEVEL } from './gpuAllocText.js';

const tot = (o = {}) => ({ hosts: 1, gpus: 1, vsga: 0, capGB: 48, capUnknown: 0, allocGB: 24, allocUnknown: 0, offGB: 0, offUnknown: 0, vmsOn: 1, vmsOff: 0, unplaced: 0, freeGpus: 0, noPlacement: 0, spareGB: 24, allocPct: 50, ...o });
const vmr = (id, name, gb = 24, extra = {}) => ({ id, name, powerState: 'POWERED_ON', mode: 'vgpu', profile: 'grid_a40-24q', vgpuDevices: 1, passthroughDevices: 0, gb, ...extra });
const host = (id, name, vms, o = {}) => ({
  id, name, cluster: 'CL', vcDatacenter: 'DC1', models: ['NVIDIA A40'],
  gpus: [{ idx: 0, model: 'NVIDIA A40', mode: 'vgpu', capGB: 48, capBasis: 'nominal', placement: true, vms, allocGB: vms.length * 24, spareGB: 48 - vms.length * 24, slots: { total: 2, used: vms.length, free: 2 - vms.length, profile: vms.length ? 'grid_a40-24q' : null } }],
  unplaced: [], off: [], totals: tot({ allocGB: vms.length * 24, spareGB: 48 - vms.length * 24, allocPct: vms.length * 50, vmsOn: vms.length }), ...o,
});
function tree() {
  const h1 = host('vc1:h1', 'esx-b', [vmr('vc1:vm-1', 'cad-01')]);
  const h2 = host('vc1:h2', 'esx-a', [vmr('vc1:vm-2', 'cad-02'), vmr('vc1:vm-3', 'cad-03')], { off: [vmr('vc1:vm-4', 'cad-04', 24, { powerState: 'POWERED_OFF' })] });
  return {
    totals: tot(),
    vcenters: [{ id: 'vc1', name: 'vcenter-kr', city: 'Seoul', country: 'South Korea', totals: tot({ hosts: 2 }),
      datacenters: [{ name: 'DC1', totals: tot(), clusters: [{ key: 'domain-c1', name: 'CL', totals: tot(), hosts: [h1, h2] }] }] }],
  };
}

describe('gpuAllocText', () => {
  it('기본 펼침 단계는 호스트 — 법인·DC·클러스터·호스트 행까지', () => {
    expect(DEFAULT_LEVEL).toBe(4);
    expect(ALLOC_LEVELS.map((l) => l.label)).toEqual(['법인', '데이터센터', '클러스터', '호스트', 'GPU', 'VM 까지 전부']);
    const rows = flattenAlloc(tree(), { open: openForLevel(tree(), DEFAULT_LEVEL) });
    expect(rows.map((r) => r.kind)).toEqual(['vc', 'dc', 'cl', 'host', 'host']);
    expect(rows[0].sub).toBe('Seoul · South Korea');
  });

  it('VM 까지 전부 — GPU 아래 VM, 꺼진 VM 묶음은 할당이 아니라 꺼진 VM GB 칸', () => {
    const t = tree();
    const rows = flattenAlloc(t, { open: openForLevel(t, 6) });
    const names = rows.map((r) => r.name);
    expect(names).toContain('cad-01');
    const off = rows.find((r) => r.name === 'cad-04');
    expect(off.alloc).toBe(null); expect(off.off).toBe(24); expect(off.vms).toBe('꺼짐');
    expect(rows.find((r) => r.kind === 'off').note).toMatch(/할당에서 제외/);
  });

  it('형제 정렬 — 같은 부모 안에서만, 값 없는 형제는 뒤', () => {
    const t = tree();
    const rows = flattenAlloc(t, { open: openForLevel(t, 4), sort: { key: 'alloc', dir: 'desc' } });
    expect(rows.filter((r) => r.kind === 'host').map((r) => r.name)).toEqual(['esx-a', 'esx-b']);
    expect(sortSiblings([{ name: 'a', gb: null }, { name: 'b', gb: 5 }], { key: 'alloc', dir: 'asc' }).map((x) => x.name)).toEqual(['b', 'a']);
  });

  it('찾기 — VM 이름이 맞는 호스트만 남기고 경로를 모두 펼친다', () => {
    const rows = flattenAlloc(tree(), { open: new Set(), query: 'cad-01' });
    expect(rows.filter((r) => r.kind === 'host').map((r) => r.name)).toEqual(['esx-b']);
    expect(rows.some((r) => r.name === 'cad-01')).toBe(true);
    expect(flattenAlloc(tree(), { query: 'zzz' })).toEqual([]);
  });

  it('비고 — 넘침은 포화와 다르게 · 모르는 값 · 빈 GPU', () => {
    expect(totalsNote(tot({ spareGB: -4, allocPct: 108 })).note).toMatch(/넘음/);
    expect(totalsNote(tot({ allocPct: 95, spareGB: 2 })).note).toBe('포화');
    expect(totalsNote(tot({ allocUnknown: 2, spareGB: null, allocPct: null })).tone).toBe('warn');
    expect(gpuTexts({ mode: 'vgpu', placement: true, vms: [], allocGB: 0 }).note).toBe('모든 프로파일 가능');
    expect(gpuTexts({ mode: 'vgpu', placement: false, vms: [] }).prof).toBe('배치 정보 없음');
    expect(gpuTexts({ mode: 'passthrough', placement: true, vms: [] }).note).toMatch(/1장 예비/);
    expect(numText(null)).toBe('—'); expect(numText(12.25)).toBe('12.3');
  });
});
