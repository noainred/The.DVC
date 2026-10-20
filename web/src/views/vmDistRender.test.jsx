// v2.746 — 가상머신 상세 C안 렌더 스모크: 분포 4패널 · 칩 · 표 열 · 좁은 화면 목록 · 구버전 응답(dist 없음).
//   renderToStaticMarkup 이라 클릭·레이아웃·effect 는 보지 못한다(Chromium 확인 몫 — 리드).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VmDistPanels, VmDistChips, VmMobileList, VmUsageBar } from './VmDistPanels.jsx';
import { EMPTY_FACETS, NO_DIST_TEXT, chipList } from './vmDistText.js';

const state = { calls: [], data: null, error: null, loading: false };
vi.mock('../api.js', async (orig) => {
  const real = await orig();
  return { ...real, usePolling: (path, params) => { state.calls.push({ path, params }); return { data: state.data, error: state.error, loading: state.loading }; } };
});
vi.mock('../components/IpmsMatches.jsx', () => ({ default: () => null }));
const { default: Vms } = await import('./Vms.jsx');

const h = React.createElement;
const bins = (over) => { const b = Array.from({ length: 20 }, () => 0); for (const [i, n] of Object.entries(over)) b[i] = n; return b; };
const DIST = {
  binPct: 5, bins: 20, total: 40,
  cpu: { bins: bins({ 0: 20, 3: 10, 16: 4, 18: 4, 19: 2 }), na: 3, off: 7, over100: 1 },
  mem: { bins: bins({ 5: 30, 15: 10 }), na: 0, off: 7, over100: 0 },
  power: { on: 43, off: 6, suspended: 1, other: 0 },
  gpu: { total: 3, vgpu: 2, passthrough: 1, mixed: 0, none: 47 },
  os: { top: [{ name: 'Ubuntu 22.04', n: 25, selected: false }, { name: '~', n: 5, selected: false }], other: 20, distinct: 6, unknownKey: '~' },
  selected: {},
};
const vm = (i, over = {}) => ({ id: `vc1:vm-${i}`, name: `vm-${i}`, vcenterId: 'vc1', powerState: 'POWERED_ON', guestOS: 'Linux', cpuCount: 2, memMB: 2048, cpuUsagePct: 10 + i, memUsagePct: 20, storageGB: 10, host: 'esx-1', ...over });
const totals = { count: 50, poweredOn: 43, poweredOff: 7, vcpu: 1, ramGB: 1, diskGB: 1, diskTB: 1, avgCpuUsagePct: 10, avgMemUsagePct: 20, usageUnknown: { cpu: 3, mem: 0 }, storageUnknown: 0, avgDiskUsagePct: 50, gpu: { total: 3, vgpu: 2, passthrough: 1, mixed: 0 } };
const page = { mode: 'paged', start: 0, next: 3, size: 1000, orderTotal: 3, remaining: 0, vanished: 0, added: 0, orderAsOf: 'T1' };

beforeEach(() => { state.calls = []; state.error = null; state.loading = false; });
afterEach(() => { delete globalThis.window; });

describe('Vms — C안 화면', () => {
  it('dist=1 을 요청하고 분포 4패널·머리·칩 줄·표 열을 그린다', () => {
    state.data = { total: 40, items: [vm(1), vm(2, { powerState: 'POWERED_OFF', cpuUsagePct: null })], totals, dist: DIST, hasMore: false, snapshotAt: 'T1', page };
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    const p = state.calls.at(-1).params;
    expect(p).toMatchObject({ dist: '1', paged: '1', limit: 1000, sortBy: 'cpuUsagePct', order: 'desc' });
    for (const k of ['cpuBin', 'memBin', 'power', 'osName']) expect(p[k]).toBeUndefined(); // 빈 선택은 키째 뺀다
    for (const t of ['CPU 사용률 분포', '메모리 사용률 분포', '전원 · GPU 구성', 'Guest OS 상위 5', '가상머신 상세', '40대', 'CPU 사용률 높은 순', '위 필터 바']) expect(html).toContain(t);
    // KPI 8장은 그대로
    expect(html).toContain('글로벌 가상머신 요약');
    expect(html).toContain('사용률 미수집 3대 제외');
    // 머리 개수 — 90%↑ = 칸 18~19 합(6) · 75%↑ = 칸 15~19 합(10)
    expect(html).toMatch(/aria-label="CPU 90% 이상 6대"/);
    expect(html).toMatch(/aria-label="CPU 75% 이상 10대"/);
    // 막대는 버튼 · 0 칸은 버튼이 아니다
    expect(html).toMatch(/aria-label="CPU 0~5% 20대"/);
    expect(html).toMatch(/aria-label="CPU 90~95% 4대"/);
    expect(html).not.toMatch(/aria-label="CPU 5~10% 0대"/);
    expect(html).toMatch(/aria-label="CPU 사용률 미수집 3대"/);
    expect(html).toContain('100% 초과 1대는 마지막 칸');
    // OS '~' 는 사람이 읽을 이름
    expect(html).toContain('(OS 정보 없음)');
    // 표 열 — 전원 점(글자) · vCPU·RAM 한 칸 · 공용 UsageCell 대신 이 화면 막대
    expect(html).toContain('vCPU · RAM');
    expect(html).toContain('2 · 2 GB');
    expect(html).toContain('구동 중');
    expect(html).toContain('vmd-ub');
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
    expect(html).not.toContain(NO_DIST_TEXT);
  });

  it('dist 가 없으면(구버전 서버) 패널 대신 한 줄 안내 + 예전 GPU 버튼 줄', () => {
    state.data = { total: 3, items: [vm(1)], totals, hasMore: false, snapshotAt: 'T1', page };
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    expect(html).toContain(NO_DIST_TEXT);
    expect(html).toContain('GPU 할당 VM만 보기');
    expect(html).not.toContain('CPU 사용률 분포');
  });

  it('좁은 화면이면 표 대신 2줄 목록 — 둘을 동시에 DOM 에 두지 않는다', () => {
    globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    state.data = { total: 2, items: [vm(1), vm(2)], totals, dist: DIST, hasMore: false, snapshotAt: 'T1', page };
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    expect(html).toContain('vmd-mlist');
    expect(html).not.toContain('<table');
    expect(html).toContain('MEM');
  });

  it('좁은 화면에는 표가 없으므로 \'표의 다른 열로 정렬\' 을 말하지 않는다 (W-R5)', () => {
    globalThis.window = { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) };
    state.data = { total: 2242, items: [vm(1), vm(2)], totals, dist: DIST, hasMore: true, nextCursor: 'C1', snapshotAt: 'T1', page: { ...page, orderTotal: 2242, remaining: 1242, next: 1000 } };
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    expect(html).toContain('vmd-mlist');
    expect(html).toContain('1,000개씩 나눠 받습니다. 목록은 이 순서 그대로 보여 줍니다.');
    expect(html).not.toContain('표의 다른 열로 정렬');
  });

  it('matchMedia 가 던지면 넓은 화면(표)으로 본다', () => {
    globalThis.window = { matchMedia: () => { throw new Error('x'); } };
    state.data = { total: 1, items: [vm(1)], totals, dist: DIST, hasMore: false, snapshotAt: 'T1', page };
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    expect(html).toContain('<table');
    expect(html).not.toContain('vmd-mlist');
  });

  it('조회 실패이고 데이터가 없으면 ErrorBox — 고른 구간이 없으면 해제 버튼도 없다', () => {
    state.data = null; state.error = 'bad-facet';
    const html = renderToStaticMarkup(h(Vms, { filters: {} }));
    expect(html).toContain('고른 구간을 서버가 받지 않았습니다');
    expect(html).toContain('고른 구간 모두 해제');
  });
});

describe('VmDistPanels — 단독', () => {
  it('고른 칸은 aria-pressed=true · 선택 밖 ok 칸은 흐린 색', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: { ...EMPTY_FACETS, cpuBin: '18-18' }, onFacet: () => {}, gpuSel: { gpuOnly: false, gpuType: '' }, onGpu: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="CPU 90~95% 4대"/);
    expect(html).toMatch(/aria-label="CPU 0~5% 20대"[^>]*>[\s\S]*?var\(--vmd-dim\)/);
  });
  it('구간 선택(90%↑) 안의 칸 — 눌림이 아니고 \'해제\' 라 말하지 않는다 · 구간 안 0 칸은 누를 수 없다 (W-R3)', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: { ...EMPTY_FACETS, cpuBin: '15-19' }, onFacet: () => {}, gpuSel: { gpuOnly: false, gpuType: '' }, onGpu: () => {} }));
    const bin18 = html.match(/<button[^>]*aria-label="CPU 90~95% 4대[^"]*"[^>]*>/)[0];
    expect(bin18).toContain('aria-pressed="false"');
    expect(bin18).toContain('고른 75~100% 구간에 포함');
    expect(bin18).toContain('눌러서 이 칸만 보기(지금은 75~100% 구간 선택 중)');
    // 막대 칸 버튼 어디에도 '다시 누르면 해제' 가 없다(머리 75%↑ 버튼은 해제가 맞다)
    const binButtons = html.match(/<button[^>]*class="vmd-bin[^"]*"[^>]*>/g) || [];
    expect(binButtons.length).toBeGreaterThan(0);
    for (const bb of binButtons) expect(bb).not.toContain('다시 누르면 해제');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="CPU 75% 이상 10대"[^>]*title="다시 누르면 해제"/);
    // 구간 안이지만 0 대인 칸(75~80%·85~90%·…)은 버튼이 아니다
    expect(html).not.toMatch(/aria-label="CPU 75~80% 0대/);
    expect(html).not.toMatch(/aria-label="CPU 85~90% 0대/);
  });
  it('칸 하나를 고른 뒤 그 칸이 0 대가 돼도 버튼으로 남는다(해제할 수 있게)', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: { ...EMPTY_FACETS, cpuBin: '7-7' }, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="CPU 35~40% 0대"[^>]*title="35~40% · 0대 — 다시 누르면 해제"/);
  });
  it('Guest OS 줄 — 서버 selected 가 아니라 고른 osName 으로 눌림 (C-03)', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: { ...EMPTY_FACETS, osName: 'Ubuntu 22.04' }, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="OS Ubuntu 22.04 25대"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="OS \(OS 정보 없음\) 5대"/);
    const sel = { ...DIST, os: { ...DIST.os, top: DIST.os.top.map((o) => ({ ...o, selected: true })) } };
    const none = renderToStaticMarkup(h(VmDistPanels, { dist: sel, facets: EMPTY_FACETS, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(none).not.toMatch(/class="vmd-os on"/);
  });
  it('전원 범례는 POWERED_OFF 를 \'꺼짐\' 이라 부른다 — KPI \'정지\'(구동 아님 전부)와 다른 집합 (C-04)', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: EMPTY_FACETS, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(html).toMatch(/aria-label="전원 꺼짐 6대"/);
    expect(html).toContain('구동 중이 아닌 7대는 분포 밖');
  });
  it('구동 VM 0 이면 0 막대 20개를 그리지 않고 안내만', () => {
    const none = { ...DIST, cpu: { bins: bins({}), na: 0, off: 9, over100: 0 }, mem: { bins: bins({}), na: 0, off: 9, over100: 0 } };
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: none, facets: EMPTY_FACETS, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(html).toContain('구동 중인 VM 이 없어 분포가 없습니다');
    expect(html).not.toContain('vmd-bin');
  });
  it('사용률을 하나도 못 읽었으면 막대 대신 안내 + 미수집 버튼', () => {
    const unread = { ...DIST, cpu: { bins: bins({}), na: 12, off: 0, over100: 0 } };
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: unread, facets: EMPTY_FACETS, onFacet: () => {}, gpuSel: {}, onGpu: () => {} }));
    expect(html).toContain('사용률을 하나도 읽지 못했습니다');
    expect(html).toMatch(/aria-label="CPU 사용률 미수집 12대"/);
  });
  it('GPU 선택은 범례 버튼의 aria-pressed 로', () => {
    const html = renderToStaticMarkup(h(VmDistPanels, { dist: DIST, facets: EMPTY_FACETS, onFacet: () => {}, gpuSel: { gpuOnly: true, gpuType: 'vgpu' }, onGpu: () => {} }));
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="GPU vGPU 2대"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="GPU 할당 VM 3대"/);
  });
  it('칩 · × 해제 버튼 · 모두 해제', () => {
    const chips = chipList({ ...EMPTY_FACETS, cpuBin: '18-19' }, DIST, {});
    const html = renderToStaticMarkup(h(VmDistChips, { chips, onClear: () => {}, onClearAll: () => {} }));
    expect(html).toContain('CPU 90~100% · 6대');
    expect(html).toMatch(/aria-label="CPU 90~100% 선택 해제"/);
    expect(html).toContain('모두 해제');
    expect(html).toContain('t-crit');
  });
  it('목록·막대 칸 — 값이 없으면 —', () => {
    expect(renderToStaticMarkup(h(VmUsageBar, { pct: null }))).toContain('—');
    expect(renderToStaticMarkup(h(VmUsageBar, { pct: null }))).not.toContain('%');
    expect(renderToStaticMarkup(h(VmMobileList, { rows: [], onOpen: () => {} }))).toContain('조건에 맞는 VM 이 없습니다');
  });
});
