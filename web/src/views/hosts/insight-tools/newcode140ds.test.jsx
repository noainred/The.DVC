// 새 코드 점검 140회차 — Hypervisor 분석 ‘데이터스토어 — 곧 가득 · 경로’ 패널(HostToolPanels DsPanel)의 오류 줄.
//   두 도구(용량 고갈 예측 · 경로 점검) 중 예측이 처음부터 못 왔고 경로만 왔을 때, 예전에는 예측의 오류를 패널 전체 오류로 실어
//   PanelState 가 ‘다시 받기에 실패했습니다 — 아래는 … 값입니다’ 라고 말했다(다시 받은 적도 없고, 아래 값은 방금 받은 경로 값이다).
//   예측 실패는 패널 안의 ‘용량 예측 요약을 받지 못했습니다’ 줄이 따로 밝힌다. 값이 있는 도구의 다시 받기 실패 · 둘 다 못 왔을 때의 오류 상자는 그대로.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const st = {};
vi.mock('../../vms/insight-tools/useToolSummary.js', () => ({
  useToolSummary: (path) => ({ data: null, error: null, loading: false, at: null, reload: () => {}, ...(st[path] || {}) }),
}));
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), toolAllowed: () => true, hasRole: () => true }));
const { default: HostToolPanels } = await import('./HostToolPanels.jsx');

const PATHS = { rows: [{ vcenterId: 'va', name: '법인-va', totals: { dead: 2, hostsDead: 1, singlePath: 0, hostsSingle: 0 }, coverage: { hosts: 3, read: 3 }, notCollected: 0, top: { dead: [] } }] };
const AT = Date.UTC(2026, 10, 19, 4, 0, 0);
const render = () => renderToStaticMarkup(React.createElement(HostToolPanels, { vcIds: [], rows: [], group: 'capacity', canTool: () => true }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('140회차 — 데이터스토어 패널: 예측만 못 왔을 때 ‘다시 받기에 실패’ 라고 하지 않는다', () => {
  it('예측 첫 요청 실패(값 없음) · 경로 값 있음 → 다시 받기 실패 줄 없음 · 예측 실패 줄은 있음 · 경로 값은 그린다', () => {
    st['/tools/capacity-forecast'] = { data: null, error: new Error('요청 시간 초과') };
    st['/tools/storage-paths'] = { data: PATHS, error: null, at: AT };
    const t = text(render());
    expect(t).not.toContain('다시 받기에 실패했습니다');
    expect(t).toContain('용량 예측 요약을 받지 못했습니다');
    expect(t).toContain('죽은 경로');
  });
  it('값이 있는 도구(경로)의 다시 받기가 실패하면 그 사실은 그대로 밝힌다', () => {
    st['/tools/capacity-forecast'] = { data: null, error: null, loading: true };
    st['/tools/storage-paths'] = { data: PATHS, error: new Error('요청 시간 초과'), at: AT };
    expect(text(render())).toContain('다시 받기에 실패했습니다');
  });
  it('둘 다 값이 없고 예측이 실패하면 오류 상자(예전 그대로)', () => {
    st['/tools/capacity-forecast'] = { data: null, error: new Error('요청 시간 초과') };
    st['/tools/storage-paths'] = { data: null, error: null, loading: true };
    const t = text(render());
    expect(t).toContain('요청 시간 초과');
    expect(t).not.toContain('데이터스토어 요약을 받는 중입니다');
  });
});
