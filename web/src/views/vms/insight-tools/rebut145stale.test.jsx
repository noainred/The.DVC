// 새 코드 점검 145회차(140회차 반증) — 두 도구를 한 패널에 그리는 곳의 ‘다시 받기에 실패했습니다 — 아래는 받은 시각 X 값입니다’ 의 X.
//   140회차가 값이 있는 도구의 다시 받기 실패를 PanelState 에 싣게 했지만, 받은 시각은 패널의 시각(추이: vm-track 의 at · 꺼진 VM: waste 의 at ·
//   데이터스토어: 둘 중 늦은 at)을 그대로 넘겼다. 그래서 다른 도구는 방금 새로 받고 **실패한 도구의 옛 값**이 남았을 때, 안내가 옛 값을
//   방금 받은 시각의 값이라고 말했다(안내가 밝혀야 할 단 하나의 사실 — 얼마나 오래된 값인가 — 이 틀렸다).
//   고친 뒤: 안내의 받은 시각은 다시 받기에 실패한 도구(값이 남은 쪽)의 시각 — 여럿이면 가장 이른 것(toolSumText.staleOf).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const st = {};
vi.mock('./useToolSummary.js', () => ({
  useToolSummary: (path) => ({ data: null, error: null, loading: false, at: null, reload: () => {}, ...(st[path] || {}) }),
}));
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), toolAllowed: () => true, hasRole: () => true }));
const { default: VmToolPanels } = await import('./VmToolPanels.jsx');
const { receivedText, staleOf } = await import('./toolSumText.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const OLD = NOW - 5 * HOUR - 17 * 60_000;           // 실패한 도구가 마지막으로 받은 시각(분이 달라 글자가 갈린다)
const NEW = NOW - 2 * 60_000;                        // 방금 새로 받은 다른 도구
const SLOT = '2026-11-18T00';
const TRACK = { days: 30, slots: [SLOT], rows: [{ vcenterId: 'va', name: '법인-va', points: [{ slot: SLOT, ts: NOW, total: 12 }], current: { slot: SLOT, total: 12 }, base: { slot: SLOT, total: 12 } }] };
const LIFE = { days: 7, rows: [{ vcenterId: 'va', name: '법인-va', added: 1, removed: 0, net: 1, byKind: {}, series: [] }], notCollected: [] };
const WASTE = { rows: [{ vcenterId: 'va', name: '법인-va', poweredOff: 3, vms: 10, poweredOffGB: 300, top: { poweredOff: [] } }] };
const OFFS = { ageEdges: [7, 30], rows: [{ vcenterId: 'va', buckets: { lt7: 1, d7: 1, ge30: 1, unknown: 0 }, top: { oldest: [] } }] };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = (only) => text(renderToStaticMarkup(React.createElement(VmToolPanels, { vcIds: [], rows: [], group: 'capacity', only: [only], canTool: () => true })));
const warnOf = (t) => (t.match(/다시 받기에 실패했습니다 — 아래는 (.+?) 값입니다/) || [])[1] || null;

beforeEach(() => { for (const k of Object.keys(st)) delete st[k]; });

describe('145회차 — 다시 받기 실패 안내의 받은 시각은 실패한 도구의 것', () => {
  it('전제: 두 시각의 글자가 다르다(같으면 이 시험이 아무것도 가르지 못한다)', () => {
    expect(receivedText(OLD)).not.toBe(receivedText(NEW));
  });
  it('추이 패널 — vm-track 은 새로 받고 vm-lifecycle 다시 받기만 실패 → 안내는 vm-lifecycle 의 옛 시각', () => {
    st['/tools/vm-track'] = { data: TRACK, error: null, at: NEW };
    st['/tools/vm-lifecycle'] = { data: LIFE, error: new Error('요청 시간 초과'), at: OLD };
    expect(warnOf(render('trend'))).toBe(receivedText(OLD));
  });
  it('추이 패널 — vm-track 다시 받기 실패(옛 값) · vm-lifecycle 새로 받음 → 안내는 vm-track 의 옛 시각(예전에도 맞던 경우 — 회귀 고정)', () => {
    st['/tools/vm-track'] = { data: TRACK, error: new Error('요청 시간 초과'), at: OLD };
    st['/tools/vm-lifecycle'] = { data: LIFE, error: null, at: NEW };
    expect(warnOf(render('trend'))).toBe(receivedText(OLD));
  });
  it('꺼진 VM 패널 — waste 는 새로 받고 off-since(꺼진 지) 다시 받기만 실패 → 안내는 off-since 의 옛 시각', () => {
    st['/tools/waste'] = { data: WASTE, error: null, at: NEW };
    st['/tools/waste/off-since'] = { data: OFFS, error: new Error('요청 시간 초과'), at: OLD };
    expect(warnOf(render('off'))).toBe(receivedText(OLD));
  });
  it('실패가 없으면 안내 없음 · 받은 시각(머리줄)은 예전 그대로', () => {
    st['/tools/waste'] = { data: WASTE, error: null, at: NEW };
    st['/tools/waste/off-since'] = { data: OFFS, error: null, at: NEW };
    const t = render('off');
    expect(warnOf(t)).toBe(null);
    expect(t).toContain(receivedText(NEW));
  });
});

describe('145회차 — staleOf(순수)', () => {
  it('값이 있고 다시 받기가 실패한 도구만 · 여럿이면 가장 이른 받은 시각 · 첫 오류', () => {
    const e1 = new Error('a'); const e2 = new Error('b');
    expect(staleOf([{ data: 1, error: e1, at: NEW }, { data: 1, error: e2, at: OLD }])).toEqual({ error: e1, at: OLD });
    expect(staleOf([{ data: null, error: e1, at: OLD }, { data: 1, error: null, at: NEW }])).toEqual({ error: null, at: null });
    expect(staleOf([false, null, { data: 1, error: e2, at: null }])).toEqual({ error: e2, at: null });
    expect(staleOf(undefined)).toEqual({ error: null, at: null });
  });
});
