// v2.852 GPU 할당 계층 — 화면 행 펼치기·형제 정렬·찾기·글자(gpuAllocText.js).
import { describe, it, expect } from 'vitest';
import { flattenAlloc, openForLevel, sortSiblings, totalsNote, gpuTexts, numText, ALLOC_LEVELS, DEFAULT_LEVEL, pickVcenters, sumTotals, corpChips, allocExportQuery, EXPORT_DEPTHS, EXPORT_SHEETS } from './gpuAllocText.js';

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

describe('v2.853 법인 칩', () => {
  const two = () => {
    const t = tree();
    const vc2 = { ...t.vcenters[0], id: 'vc2', name: 'vcenter-de', totals: tot({ capGB: 64, allocGB: 16, spareGB: 48, allocPct: 25, hosts: 1 }) };
    return { ...t, vcenters: [t.vcenters[0], vc2] };
  };
  it('선택한 법인만 행으로 · 빈 선택은 전체', () => {
    const t = two();
    expect(pickVcenters(t, new Set(['vc2'])).map((v) => v.id)).toEqual(['vc2']);
    expect(pickVcenters(t, new Set()).length).toBe(2);
    expect(flattenAlloc(t, { open: new Set(), vcSel: new Set(['vc2']) }).map((r) => r.name)).toEqual(['vcenter-de']);
  });
  it('합계 — 고른 법인만 더하고, 모르는 값이 섞이면 예비·할당률은 null', () => {
    const t = two();
    const s = sumTotals(t, new Set(['vc1', 'vc2']));
    expect(s.capGB).toBe(112); expect(s.allocGB).toBe(40); expect(s.spareGB).toBe(72); expect(s.allocPct).toBe(36);
    t.vcenters[1].totals.allocUnknown = 1;
    expect(sumTotals(t, new Set(['vc1', 'vc2'])).spareGB).toBe(null);
    expect(sumTotals(t, null)).toBe(t.totals);
  });
  it('칩 — /vcenters 의 법인 전부(GPU 없는 법인은 0), id 순 · 찾기 글자가 법인 id 에 맞으면 그 법인 전체', () => {
    const t = two();
    const chips = corpChips(t, [{ id: 'vc2', name: 'vcenter-de' }, { id: 'AZ', name: 'vcenter-az' }, { id: 'vc1', name: 'vcenter-kr' }]);
    expect(chips.map((c) => [c.id, c.hosts])).toEqual([['AZ', 0], ['vc1', 2], ['vc2', 1]]);
    expect(corpChips(t, null).map((c) => c.id)).toEqual(['vc1', 'vc2']);
    const rows = flattenAlloc(t, { query: 'vc2' });
    expect(rows[0].name).toBe('vcenter-de');
    expect(rows.some((r) => r.kind === 'host')).toBe(true);
  });
});

describe('v2.855 내보내기 창 쿼리', () => {
  it('기본(VM 까지 · 시트 셋)은 싣지 않고, 범위·단계·시트만 싣는다', () => {
    expect(allocExportQuery({})).toBe('');
    expect(allocExportQuery({ scope: 'vc1' })).toBe('?vcenterId=vc1');
    expect(allocExportQuery({ vcSel: new Set(['AZ', 'GM1']), depth: 'host' })).toBe('?vcenterIds=AZ%2CGM1&depth=host');
    expect(allocExportQuery({ depth: 'vm', sheets: ['info', 'tree'] })).toBe('?sheets=tree%2Cinfo');
    expect(allocExportQuery({ sheets: ['tree', 'flat', 'info'] })).toBe('');
    expect(EXPORT_DEPTHS.map((d) => d.key)).toEqual(['host', 'gpu', 'vm']);
    expect(EXPORT_SHEETS.map((s) => s.key)).toEqual(['tree', 'flat', 'info']);
  });
});

describe('v2.868 CPU/메모리 칸', () => {
  it('법인~호스트 행은 호스트 합, VM 행은 그 VM, GPU 행은 빈 칸 · 정렬 키', () => {
    const t = tree();
    const hostT = { hostCores: 32, hostCpuPct: 25, hostMemGB: 512, hostMemPct: 50, vmVcpu: 8, vmMemGB: 32 };
    t.vcenters[0].totals = { ...t.vcenters[0].totals, ...hostT, hostCores: 64 };
    const h = t.vcenters[0].datacenters[0].clusters[0].hosts[0];
    h.totals = { ...h.totals, ...hostT };
    h.gpus[0].vms[0].res = { vcpu: 8, memGB: 32, cpuPct: 40, memPct: null };
    const rows = flattenAlloc(t, { open: openForLevel(t, 6) });
    expect(rows[0].cores).toBe(64);
    const hr = rows.find((r) => r.name === 'esx-b');
    expect([hr.cores, hr.cpuPct, hr.memGB, hr.memPct, hr.gvmVcpu, hr.gvmMemGB]).toEqual([32, 25, 512, 50, 8, 32]);
    const vr = rows.find((r) => r.name === 'cad-01');
    expect([vr.cores, vr.cpuPct, vr.memGB, vr.memPct, vr.gvmVcpu]).toEqual([8, 40, 32, null, null]);
    const gr = rows.find((r) => r.kind === 'gpu');
    expect(gr.cores ?? null).toBe(null);
    expect(sortSiblings([{ name: 'x', res: { vcpu: 2 } }, { name: 'y', res: { vcpu: 16 } }, { name: 'z' }], { key: 'cores', dir: 'desc' }).map((x) => x.name)).toEqual(['y', 'x', 'z']);
  });
});
