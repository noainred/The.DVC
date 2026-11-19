// 새 코드 점검 145회차(140회차 반증) — Hypervisor ‘데이터스토어 — 곧 가득 · 경로’ 패널의 다시 받기 실패 안내 받은 시각.
//   예전: 패널 시각 = 두 도구 중 **늦은** at — 예측은 새로 받고 경로의 다시 받기만 실패하면(옛 경로 값이 남음) 안내가
//   ‘아래는 받은 시각 <방금> 값입니다’ 라고 옛 경로 값을 새 값처럼 말했다. 고친 뒤: 실패한 도구의 받은 시각(toolSumText.staleOf).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const st = {};
vi.mock('../../vms/insight-tools/useToolSummary.js', () => ({
  useToolSummary: (path) => ({ data: null, error: null, loading: false, at: null, reload: () => {}, ...(st[path] || {}) }),
}));
vi.mock('../../../api.js', async (orig) => ({ ...(await orig()), toolAllowed: () => true, hasRole: () => true }));
const { default: HostToolPanels } = await import('./HostToolPanels.jsx');
const { receivedText } = await import('../../vms/insight-tools/toolSumText.js');

const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const OLD = NOW - 5 * HOUR - 17 * 60_000;
const NEW = NOW - 2 * 60_000;
const PATHS = { rows: [{ vcenterId: 'va', name: '법인-va', totals: { dead: 2, hostsDead: 1, singlePath: 0, hostsSingle: 0 }, coverage: { hosts: 3, read: 3 }, notCollected: 0, top: { dead: [] } }] };
const FC = { rows: [{ vcenterId: 'va', name: '법인-va', datastores: 4, soon: 1, high: 1, noForecast: 0, soonest: [] }], soonDays: 30, highPct: 85 };
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = () => text(renderToStaticMarkup(React.createElement(HostToolPanels, { vcIds: [], rows: [], group: 'capacity', canTool: () => true })));
const warnOf = (t) => (t.match(/다시 받기에 실패했습니다 — 아래는 (.+?) 값입니다/) || [])[1] || null;

beforeEach(() => { for (const k of Object.keys(st)) delete st[k]; });

describe('145회차 — 데이터스토어 패널: 안내의 받은 시각은 실패한 도구의 것', () => {
  it('예측은 새로 받고 경로 다시 받기만 실패(옛 경로 값) → 안내는 경로의 옛 시각', () => {
    expect(receivedText(OLD)).not.toBe(receivedText(NEW));
    st['/tools/capacity-forecast'] = { data: FC, error: null, at: NEW };
    st['/tools/storage-paths'] = { data: PATHS, error: new Error('요청 시간 초과'), at: OLD };
    expect(warnOf(render())).toBe(receivedText(OLD));
  });
  it('둘 다 성공이면 안내 없음 · 머리줄 받은 시각은 예전 그대로(늦은 쪽)', () => {
    st['/tools/capacity-forecast'] = { data: FC, error: null, at: NEW };
    st['/tools/storage-paths'] = { data: PATHS, error: null, at: OLD };
    const t = render();
    expect(warnOf(t)).toBe(null);
    expect(t).toContain(receivedText(NEW));
  });
});
