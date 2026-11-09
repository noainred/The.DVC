// v2.852 GPU 할당 계층 — 화면 행 펼치기·형제 정렬·찾기·글자(gpuAllocText.js).
import { describe, it, expect } from 'vitest';
import { flattenAlloc, openForLevel, sortSiblings, totalsNote, gpuTexts, numText, ALLOC_LEVELS, DEFAULT_LEVEL, pickVcenters, sumTotals, corpChips, corpChipText, allocExportQuery, EXPORT_DEPTHS, EXPORT_SHEETS, exportPick, exportFileName } from './gpuAllocText.js';

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
    // v2.871 A4-02: 인벤토리 없이 status 만 있는 법인(첫 수집 전 · 접속 불가)은 0 이 아니라 모름(null · '—')
    const u = corpChips(t, [{ id: 'PL', name: 'vc-pl', status: 'unreachable' }, { id: 'US', name: 'vc-us', status: 'pending' }, { id: 'ST', name: 'vc-st', status: 'unreachable', stale: true }]);
    expect(u.filter((c) => ['PL', 'US', 'ST'].includes(c.id)).map((c) => [c.id, c.unknown, c.hosts])).toEqual([['PL', 'unreachable', null], ['ST', '', 0], ['US', 'pending', null]]);
    expect(corpChipText(u.find((c) => c.id === 'PL')).count).toBe('—');
    expect(corpChipText(u.find((c) => c.id === 'ST')).count).toBe('0');
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
    expect(allocExportQuery({ sheets: ['tree', 'flat', 'info', 'corp'] })).toBe('');
    expect(allocExportQuery({ sheets: ['tree', 'flat', 'info'] })).toBe('?sheets=tree%2Cflat%2Cinfo', 'v2.869: 법인별 시트를 끄면 옛 3시트를 명시');
    expect(EXPORT_DEPTHS.map((d) => d.key)).toEqual(['host', 'gpu', 'vm']);
    expect(EXPORT_SHEETS.map((s) => s.key)).toEqual(['tree', 'flat', 'info', 'corp']);
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

describe('v2.869 내보내기 창 — 법인 모두 선택이 기본 · 법인별 시트 파일 이름', () => {
  const chips = [{ id: 'AZ' }, { id: 'GM1' }, { id: 'KR' }];
  it('창은 모든 법인(null)으로 시작 · 칩을 전부 고르면 다시 전체 · 일부면 그 집합 · 빈 집합은 그대로(호출 쪽이 잠금)', () => {
    expect(exportPick(null, chips)).toBe(null);
    expect(exportPick(new Set(['AZ', 'GM1', 'KR']), chips)).toBe(null);
    expect([...exportPick(new Set(['GM1']), chips)]).toEqual(['GM1']);
    expect(exportPick(new Set(), chips).size).toBe(0);
    expect(allocExportQuery({ vcSel: exportPick(null, chips) })).toBe('', '모든 법인이면 vcenterIds 를 싣지 않는다(서버 조회 범위 전부)');
  });
  it('파일 이름은 서버가 준 것 — 법인별 시트가 들어가면 _percorp 판', () => {
    const meta = { fileNames: { vm: 'a.xlsx', host: 'a_host.xlsx' }, fileNamesPercorp: { vm: 'a_percorp.xlsx', host: 'a_host_percorp.xlsx' } };
    expect(exportFileName(meta, 'vm', true)).toBe('a_percorp.xlsx');
    expect(exportFileName(meta, 'host', false)).toBe('a_host.xlsx');
    expect(exportFileName(null, 'vm', true)).toBe('');
  });
});

describe('v2.871 버그 점검', () => {
  it('VM 행 정렬 — 꺼진 VM 은 꺼진 VM GB 로, 할당 정렬에서는 값 없음(뒤로)', () => {
    const offs = [vmr('a', 'a', 8, { powerState: 'POWERED_OFF' }), vmr('b', 'b', 48, { powerState: 'POWERED_OFF' }), vmr('c', 'c', 24, { powerState: 'POWERED_OFF' })];
    expect(sortSiblings(offs, { key: 'off', dir: 'desc' }).map((x) => x.name)).toEqual(['b', 'c', 'a']);
    const mix = [vmr('x', 'off', 48, { powerState: 'POWERED_OFF' }), vmr('y', 'on', 8)];
    expect(sortSiblings(mix, { key: 'alloc', dir: 'desc' }).map((x) => x.name)).toEqual(['on', 'off']);
    expect(sortSiblings(mix, { key: 'off', dir: 'desc' }).map((x) => x.name)).toEqual(['off', 'on']);
  });
});

describe('v2.939 GPU 할당율 개선(웹)', async () => {
  const M = await import('./gpuAllocText.js');
  const g = (idx, model, vms, slots, o = {}) => ({ idx, model, mode: 'vgpu', capGB: 48, placement: true, vms, slots, allocGB: 0, ...o });
  const placeTree = () => ({
    vcenters: [{ id: 'vc1', name: 'kr', totals: tot(), datacenters: [{ name: 'DC', totals: tot(), clusters: [{ key: 'c', name: 'CL', totals: tot(), hosts: [
      { id: 'h1', name: 'esx1', connectionState: 'CONNECTED', unplaced: [], off: [], totals: tot(), models: [], gpus: [
        g(0, 'NVIDIA A40', [vmr('a', 'a', 24, { profile: 'grid_a40-24q' })], { profile: 'grid_a40-24q', used: 1, total: 2, free: 1 }),
        g(1, 'NVIDIA A40', [], { total: null, used: 0, free: null, profile: null }),
        g(2, 'NVIDIA A40', [vmr('b', 'b', 8, { profile: 'grid_a40-8q' })], { profile: 'grid_a40-8q', used: 1, total: 6, free: 5 }),
        g(3, 'NVIDIA L40S', [], { total: null, used: 0, free: null, profile: null }),
        g(4, 'NVIDIA A40', [], null, { placement: false }),
      ] },
      { id: 'h2', name: 'esx2', connectionState: 'DISCONNECTED', unplaced: [], off: [], totals: tot(), models: [], gpus: [g(0, 'NVIDIA A40', [], { total: null, used: 0, free: null, profile: null })] },
    ] }] }] }],
  });
  it('배치 추천 — 같은 프로파일 남은 슬롯 먼저 · 모델이 맞는 빈 GPU · 다른 프로파일 · 끊김 · 배치 모름 · 다른 계열은 뺀다', () => {
    const r = M.placementCandidates(placeTree(), 'grid_a40-24q');
    expect(r.per).toBe(24); expect(r.family).toBe('a40');
    expect(r.rows.map((x) => [x.host, x.gpu, x.kind, x.fit])).toEqual([['esx1', 0, 'same', 1], ['esx1', 1, 'empty', 2]]);
    expect([r.same, r.empty]).toEqual([1, 2]);
    expect(r.skipped).toEqual({ down: 1, maint: 0, noPlacement: 1, mixed: 0, otherProfile: 1, capUnknown: 0, small: 0 });
    expect(M.placementCandidates(placeTree(), 'nonsense').rows).toEqual([]);
    expect(M.modelHasFamily('NVIDIA L40S', 'l4')).toBe(false);
    expect(M.modelHasFamily('GA102GL [A40]', 'a40')).toBe(true);
    expect(M.profileFamily('grid_a100-3-40c')).toEqual({ family: 'a100', mig: true });
    expect(M.profileOptions(placeTree()).map((o) => o.profile)).toEqual(['grid_a40-24q', 'grid_a40-8q']);
  });
  it('새로 고침 — 새로 생긴 노드만 지금 단계대로 펼치고, 사용자가 접은 기존 노드는 그대로', () => {
    const old = tree();
    const open = M.openForLevel(old, 4);
    open.delete('v:vc1');   // 사용자가 법인을 접었다
    const nw = tree();
    nw.vcenters.push({ ...nw.vcenters[0], id: 'vc9', name: 'new' });
    const next = M.openAfterRefresh(open, old, nw, 4);
    expect(next.has('v:vc1')).toBe(false);
    expect(next.has('v:vc9')).toBe(true);
    expect(M.openAfterRefresh(null, old, nw, 4)).toBe(null);
  });
  it('수집 점검 글자 — 관측 대상이 없으면 판단 불가 · 일부만 읽히면 경고', () => {
    const t = { vgpuGpus: 4, vgpuNoPlacement: 1, offVgpuVms: 0, offListed: 0, ptOnVms: 3, ptOnPciRead: 2, unparsedVms: 0, nonGpuPtVms: 1, nonGpuOnlyVms: 1, capUnknown: 0, capModel: 2 };
    const v = M.diagVerdicts({ totals: t, verdicts: { placement: 'partial', offListed: 'unknown', ptPciRead: 'partial', profiles: 'yes' } });
    expect(v.find((x) => x.key === 'offListed').text).toMatch(/^판단 불가/);
    expect(v.find((x) => x.key === 'placement').tone).toBe('warn');
    expect(v.find((x) => x.key === 'ptPciRead').text).toMatch(/3대 중 2대만/);
    expect(v.find((x) => x.key === 'nonGpu').text).toMatch(/1대는 GPU 장치가 없어/);
  });
  it('추이 — 쿼리는 화면 범위 · 소진 예상이 없으면 이유를 말한다(소진 안 함으로 단정하지 않음)', () => {
    expect(M.historyQuery({ days: 30 })).toBe('?days=30');
    expect(M.historyQuery({ days: 90, vcSel: new Set(['a', 'b']) })).toBe('?days=90&vcenterIds=a%2Cb');
    expect(M.historyQuery({ days: 90, scope: 'vc1', vcSel: new Set(['x']) })).toBe('?days=90&vcenterIds=vc1');
    const now = Date.UTC(2026, 10, 7);
    expect(M.trendText({ points: 30, gbPerDay: 0.5, change30: 14.5, daysLeft: 47, r2: 0.99 }, now)).toEqual({ change: '+14.5 GB', perDay: '+0.5 GB/일', left: '47일 뒤 (2026-12-24)', why: '최근 30일 할당 증가 기울기로 낸 추정' });
    expect(M.trendText({ points: 3, gbPerDay: null, change30: 1, daysLeft: null }).why).toMatch(/점이 3개/);
    expect(M.trendText({ points: 10, gbPerDay: -1, change30: -5, daysLeft: null }).why).toMatch(/늘지 않았/);
    expect(M.trendText(null).left).toBe('—');
  });
});

describe('v2.939 추이 글자 — 화면 판독 정정', () => {
  it('이미 넘은 법인은 남은 일수 대신 이미 넘음 · 날짜는 지금 시각 기준(1970년이 아님)', async () => {
    const M = await import('./gpuAllocText.js');
    expect(M.trendText({ points: 30, gbPerDay: 1, change30: 30, daysLeft: null, over: true }).left).toBe('이미 넘음');
    const t = M.trendText({ points: 30, gbPerDay: 0.5, change30: 14.5, daysLeft: 10, r2: 0.9 });
    expect(Number(t.left.match(/\((\d{4})-/)[1])).toBeGreaterThanOrEqual(2026);
  });
  it('추이 화면은 trendText 에 지금 시각을 넘긴다(일 번호 today 를 넘기면 1970년)', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('./GpuAllocHistory.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/trendText\([^)]*today/);
  });
});

describe('v2.951 점검', () => {
  it('배치 추천 — 유지보수 모드 호스트의 GPU 는 놓을 수 있는 자리가 아니다', async () => {
    const M = await import('./gpuAllocText.js');
    const g = (idx, vms, slots) => ({ idx, model: 'NVIDIA A40', mode: 'vgpu', capGB: 48, placement: true, vms, slots, allocGB: 0 });
    const h = (id, cs, gpus) => ({ id, name: id, connectionState: cs, unplaced: [], off: [], totals: tot(), models: [], gpus });
    const t = { vcenters: [{ id: 'vc1', name: 'kr', totals: tot(), datacenters: [{ name: 'DC', totals: tot(), clusters: [{ key: 'c', name: 'CL', totals: tot(), hosts: [
      h('esx-maint', 'MAINTENANCE', [g(0, [vmr('a', 'a', 24, { profile: 'grid_a40-24q' })], { profile: 'grid_a40-24q', used: 1, total: 2, free: 1 }), g(1, [], { total: null, used: 0, free: null, profile: null })]),
      h('esx-ok', 'CONNECTED', [g(0, [], { total: null, used: 0, free: null, profile: null })]),
    ] }] }] }] };
    const r = M.placementCandidates(t, 'grid_a40-24q');
    expect(r.rows.map((x) => x.host)).toEqual(['esx-ok']);
    expect(r.skipped.maint).toBe(2);
  });
  it('추이 글자 — 보고가 멈춘 법인은 소진 예상 대신 보고 없음 N일', async () => {
    const M = await import('./gpuAllocText.js');
    const t = M.trendText({ points: 20, gbPerDay: null, change30: 0, daysLeft: null, stale: 10 });
    expect(t.left).toBe('— (보고 없음 10일)');
    expect(t.why).toMatch(/10일 전/);
  });
});
