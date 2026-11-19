// 새 코드 점검 145회차(140 반증 · 139 의 ‘화면 코드 변경 불필요’ 반증) — 139회차가 바꾼 /vms/insight 응답 꼴(점검중 vCenter 줄 stale:true + notCurrent)을
//   VM 분석 화면이 맞게 그리는가: 합에서 빼고 ‘오래됨 N곳’ · 지도의 ‘지금 … 이상인 법인은 N곳’ 에 옛 값을 세지 않는다.
//   응답은 서버 vmInsightOf 로 만든다(실제 모양). 색 기준은 ‘평균 CPU’(경계가 있는 기준)로 그린다 — 처음 색(조치 필요 비율)은 경계가 없어 그 줄이 없다.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const { vmInsightOf } = await import('../../../../server/src/inventory/vmInsight.js');
const { signalContext } = await import('../../../../server/src/inventory/vmSignals.js');

const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
const VCS = [
  { id: 'va', name: '법인-va', status: 'connected', location: { region: '유럽', city: 'va-city' } },
  { id: 'vm', name: '법인-vm', status: 'maintenance', location: { region: '유럽', city: 'vm-city' } },   // 점검중 — store 가 옛 캐시를 서빙
];
const RESP = { ok: true, generatedAt: '2026-11-19T00:00:00Z', initial: false, region: null,
  ...(await vmInsightOf({ vcenters: VCS, vms: [vm('va', 'a1'), vm('va', 'a2'), vm('vm', 'm1', { cpuUsagePct: 95 }), vm('vm', 'm2', { cpuUsagePct: 96 }), vm('vm', 'm3', { cpuUsagePct: 97 })],
    ctx: signalContext({ snapAgeDays: 7 }, Date.now()) })) };

vi.mock('react', async (orig) => {
  const real = await orig();
  // 색 기준 상태(처음 'att')만 ‘평균 CPU’ 로 — 그 밖 상태는 그대로.
  return { ...real, useState: (init) => (init === 'att' ? real.useState('cpu') : real.useState(init)) };
});
vi.mock('../../api.js', async (orig) => {
  const real = await orig();
  return { ...real, fetchJson: () => new Promise(() => {}), usePolling: (path) => (path === '/vms/insight' ? { data: RESP, error: null, loading: false } : { data: null, error: null, loading: true }),
    toolAllowed: () => false, hasRole: () => true, can: () => true };
});
vi.mock('../insight/useInsight.js', () => ({
  useFolded: () => [{}, () => {}],
  useLazyJson: () => ({ data: null, error: null, loading: false, reload: () => {} }),
}));
const { default: VmInsight } = await import('./VmInsight.jsx');
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = () => text(renderToStaticMarkup(React.createElement(VmInsight, { filters: {}, onScopeIds: () => {} })));

describe('145회차 — VM 분석: 점검중 법인(139회차 stale:true + notCurrent)', () => {
  it('전제(서버): 점검중 줄은 stale:true + notCurrent(maintenance)', () => {
    const r = RESP.rows.find((x) => x.id === 'vm');
    expect(r.stale).toBe(true);
    expect(r.notCurrent).toBe('maintenance');
  });
  it('합에서 빼고 ‘오래됨 1곳’ 으로 따로', () => {
    expect(render()).toMatch(/오래됨 1곳 — 점검중 1곳\(법인-vm\) — 지금 값이 아니라 합에 넣지 않았습니다/);   // 148회차(144 D1): 점검중은 사유를 가른다
  });
  it('지도 안내의 ‘지금 90% 이상인 법인’ 에 옛 값(95%대)을 세지 않는다 — 따로 밝힌다', () => {
    const t = render();
    expect(t).toMatch(/지금 90% 이상인 법인은 0곳입니다\(경계를 넘은 오래된 값 1곳은 세지 않았습니다\)/);
  });
});
