// 검토 I-02(그룹 B) — Vms.jsx 렌더 스모크: 서버 페이지 요청 모양 · 페이지 버튼 · 위치 문구.
//   renderToStaticMarkup 이라 클릭·레이아웃은 보지 못한다(Chromium 확인 몫).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const state = { calls: [], data: null, error: null };
vi.mock('../api.js', async (orig) => {
  const real = await orig();
  return { ...real, usePolling: (path, params) => { state.calls.push({ path, params }); return { data: state.data, error: state.error, loading: false }; } };
});
vi.mock('../components/IpmsMatches.jsx', () => ({ default: () => null }));
const { default: Vms } = await import('./Vms.jsx');

const vm = (i) => ({ id: `vc1:vm-${i}`, name: `vm-${i}`, vcenterId: 'vc1', powerState: 'POWERED_ON', guestOS: 'Linux', cpuCount: 2, memMB: 2048, cpuUsagePct: 10, memUsagePct: 20, storageGB: 10, host: 'esx-1' });
const totals = { count: 6001, poweredOn: 6001, poweredOff: 0, vcpu: 1, ramGB: 1, diskGB: 1, diskTB: 1, avgCpuUsagePct: 10, avgMemUsagePct: 20, usageUnknown: { cpu: 0, mem: 0 }, storageUnknown: 0, avgDiskUsagePct: 50, gpu: { total: 0, vgpu: 0, passthrough: 0, mixed: 0 } };

beforeEach(() => { state.calls = []; state.error = null; });

describe('Vms — 서버 페이지', () => {
  it('첫 페이지는 paged=1 · 페이지 크기 1,000 · CPU 내림차순으로 요청하고 다음 버튼·위치를 보인다', () => {
    state.data = { total: 6001, items: Array.from({ length: 40 }, (_, i) => vm(i)), totals, returned: 40, hasMore: true, nextCursor: 'CUR', snapshotAt: 'T1', page: { mode: 'paged', start: 0, next: 1000, size: 1000, orderTotal: 6001, remaining: 5001, vanished: 0, added: 0, orderAsOf: 'T1' } };
    const html = renderToStaticMarkup(React.createElement(Vms, { filters: {} }));
    const p = state.calls.at(-1).params;
    expect(state.calls.at(-1).path).toBe('/vms');
    expect(p).toMatchObject({ paged: '1', limit: 1000, sortBy: 'cpuUsagePct', order: 'desc' });
    expect(p.cursor).toBeUndefined();
    expect(html).toContain('다음 페이지 불러오기');
    expect(html).toContain('순서상 1–1,000번째');
    expect(html).toContain('전체 6,001개');
    expect(html).toContain('1,000개씩 나눠 받습니다. 표의 다른 열로 정렬하면 이 페이지 안에서만 정렬됩니다.');
    expect(html).not.toMatch(/상위 [\d,]+개 표시/); // 2페이지 이후에도 '상위' 라 말하지 않게 ResultCount 의 shown 을 쓰지 않는다
    expect(html).not.toMatch(/>(null|undefined|NaN)</);
  });

  it('더 없으면 페이저를 그리지 않는다(첫 페이지 · 전부 받음)', () => {
    state.data = { total: 3, items: [vm(1), vm(2), vm(3)], totals: { ...totals, count: 3 }, returned: 3, hasMore: false, nextCursor: null, snapshotAt: 'T1', page: { mode: 'paged', start: 0, next: 3, size: 1000, orderTotal: 3, remaining: 0, vanished: 0, added: 0, orderAsOf: 'T1' } };
    const html = renderToStaticMarkup(React.createElement(Vms, { filters: {} }));
    expect(html).not.toContain('다음 페이지 불러오기');
    expect(html).toContain('3개 표시');
  });
});
