// 새 코드 점검 140회차 — VM 분석 ‘VM 수 추이 · 생성/삭제’ 패널(VmToolPanels TrendPanel)의 다시 받기 실패 안내.
//   useToolSummary 규약: 다시 받기가 실패해도 이전 값은 지우지 않고, error 와 data 가 함께 있으면 화면은 값 + 실패 안내를 보인다.
//   예전 TrendPanel 은 두 도구 중 하나라도 값이 있으면 오류를 null 로 지워 — 다시 받기가 실패해도 옛 값과 옛 ‘받은 시각’ 만 조용히 남았다.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const st = {};
vi.mock('./useToolSummary.js', () => ({
  useToolSummary: (path) => ({ data: null, error: null, loading: false, at: null, reload: () => {}, ...(st[path] || {}) }),
}));
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), toolAllowed: () => true, hasRole: () => true }));
const { default: VmToolPanels } = await import('./VmToolPanels.jsx');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const SLOT = '2026-11-18T00';
const TRACK = { days: 30, slots: [SLOT], rows: [{ vcenterId: 'va', name: '법인-va', points: [{ slot: SLOT, ts: NOW, total: 12 }], current: { slot: SLOT, total: 12 }, base: { slot: SLOT, total: 12 } }] };
const LIFE = { days: 7, rows: [{ vcenterId: 'va', name: '법인-va', added: 1, removed: 0, net: 1, byKind: {}, series: [] }], notCollected: [] };
const render = () => renderToStaticMarkup(React.createElement(VmToolPanels, { vcIds: [], rows: [], group: 'capacity', only: ['trend'], canTool: () => true }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('140회차 — 추이 패널: 값이 있는 도구의 다시 받기 실패를 숨기지 않는다', () => {
  it('VM 수 추이를 다시 받다 실패(값은 남음) → ‘다시 받기에 실패했습니다’ + 옛 값', () => {
    st['/tools/vm-track'] = { data: TRACK, error: new Error('요청 시간 초과'), at: NOW };
    st['/tools/vm-lifecycle'] = { data: LIFE, error: null, at: NOW };
    const t = text(render());
    expect(t).toContain('다시 받기에 실패했습니다');
    expect(t).toContain('VM 수');
  });
  it('생성 · 삭제가 처음부터 못 왔을 뿐이면(값 없음) 패널 전체를 ‘다시 받기 실패’ 로 말하지 않는다(그 줄만)', () => {
    st['/tools/vm-track'] = { data: TRACK, error: null, at: NOW };
    st['/tools/vm-lifecycle'] = { data: null, error: new Error('요청 시간 초과') };
    const t = text(render());
    expect(t).not.toContain('다시 받기에 실패했습니다');
    expect(t).toContain('생성 · 삭제 이력을 받지 못했습니다');
  });
  it('둘 다 실패하면 오류 상자(예전 그대로)', () => {
    st['/tools/vm-track'] = { data: null, error: new Error('요청 시간 초과') };
    st['/tools/vm-lifecycle'] = { data: null, error: null };
    expect(text(render())).toContain('요청 시간 초과');
  });
});

// 같은 꼴 — ‘꺼진 VM’ 패널(OffPanel)은 waste 요약 + off-since(꺼진 지) 두 요청인데 PanelState 는 waste 의 오류만 보았다.
const WASTE = { rows: [{ vcenterId: 'va', name: '법인-va', poweredOff: 3, vms: 10, poweredOffGB: 300, top: { poweredOff: [] } }] };
const OFFS = { ageEdges: [7, 30], rows: [{ vcenterId: 'va', buckets: { lt7: 1, d7: 1, ge30: 1, unknown: 0 }, top: { oldest: [] } }] };
const renderOff = () => renderToStaticMarkup(React.createElement(VmToolPanels, { vcIds: [], rows: [], group: 'capacity', only: ['off'], canTool: () => true }));
describe('140회차 — 꺼진 VM 패널: 꺼진 지(off-since) 다시 받기 실패도 밝힌다', () => {
  it('waste 는 새로 받고 off-since 다시 받기만 실패(옛 구간 남음) → ‘다시 받기에 실패했습니다’', () => {
    st['/tools/waste'] = { data: WASTE, error: null, at: NOW };
    st['/tools/waste/off-since'] = { data: OFFS, error: new Error('요청 시간 초과'), at: NOW };
    const t = text(renderOff());
    expect(t).toContain('다시 받기에 실패했습니다');
    expect(t).toContain('30일 이상');   // 옛 구간은 그대로 그린다
  });
  it('off-since 가 처음부터 못 왔으면(값 없음) 그 줄만 — 패널 전체를 ‘다시 받기 실패’ 로 말하지 않는다', () => {
    st['/tools/waste'] = { data: WASTE, error: null, at: NOW };
    st['/tools/waste/off-since'] = { data: null, error: new Error('요청 시간 초과') };
    const t = text(renderOff());
    expect(t).not.toContain('다시 받기에 실패했습니다');
    expect(t).toContain('꺼진 지(며칠)를 받지 못했습니다');
  });
});
