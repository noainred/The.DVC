import { describe, it, expect } from 'vitest';
import { layoutDataFlow, W, EDGE_X, BUS_X } from './dataFlowLayout.js';
import { edgeBadge, innerItemText, sinceNote, linkText, routePath, edgeLasts, LEGEND, KIND_LABEL, STATE_LABEL } from './dataFlowText.js';

const data = {
  cats: [{ id: 'inv', label: '인벤토리', routes: 2 }, { id: 'gpu', label: 'GPU', routes: 1 }],
  routes: [
    { id: 'central:POST /inventory', side: 'central', path: '/inventory', kind: 'push', cat: 'inv', state: 'ok' },
    { id: 'collector:GET /export', side: 'collector', path: '/export', kind: 'cpull', cat: 'inv', state: 'fail' },
    { id: 'central:POST /gpu-guest-data', side: 'central', path: '/gpu-guest-data', kind: 'push', cat: 'gpu', state: 'none' },
  ],
  edges: [{ id: 'a', name: 'A', registered: true, used: 2, ok: 1, fail: 1 }, { id: 'b', name: 'B', registered: true, used: 0 }],
  links: [
    { edge: 'a', route: 'central:POST /inventory', state: 'ok', okAt: 100, lastAt: 100 },
    { edge: 'a', route: 'collector:GET /export', state: 'fail', okAt: 50, failAt: 90, lastAt: 90 },
  ],
};

describe('dataFlowLayout', () => {
  it('선은 기록 있는 연결만, 들어오는 선은 경로마다 1개', () => {
    const l = layoutDataFlow(data);
    expect(l.inLines).toHaveLength(3);
    expect(l.outLines).toHaveLength(2);
    expect(l.width).toBe(W);
    expect(l.ticks.map((t) => t.state)).toEqual(['ok', 'fail', 'none']);
    for (const p of l.edgePos.values()) expect(p.x).toBeGreaterThanOrEqual(EDGE_X);
    expect(l.bus.top).toBeLessThan(l.bus.bottom);
    expect(BUS_X).toBeLessThan(EDGE_X);
  });
  it('실패 선은 마지막에 그린다(묻히지 않게)', () => {
    const l = layoutDataFlow(data);
    expect(l.outLines[l.outLines.length - 1].state).toBe('fail');
  });
  it('엣지 선택 — 그 엣지의 선만 강조, 그 엣지가 쓴 경로의 들어오는 선도 강조', () => {
    const l = layoutDataFlow(data, { type: 'edge', id: 'a' });
    expect(l.outLines.every((x) => x.hot)).toBe(true);
    expect(l.inLines.filter((x) => x.hot).map((x) => x.route)).toEqual(['central:POST /inventory', 'collector:GET /export']);
    const lb = layoutDataFlow(data, { type: 'edge', id: 'b' });
    expect(lb.outLines.every((x) => x.dim)).toBe(true);
  });
  it('종류 선택 — 그 종류 경로의 선만 강조', () => {
    const l = layoutDataFlow(data, { type: 'cat', id: 'gpu' });
    expect(l.inLines.filter((x) => x.hot).map((x) => x.route)).toEqual(['central:POST /gpu-guest-data']);
    expect(l.outLines.every((x) => x.dim)).toBe(true);
  });
  it('빈 데이터에서도 죽지 않는다', () => {
    const l = layoutDataFlow({});
    expect(l.inLines).toEqual([]); expect(l.height).toBeGreaterThan(0);
  });
});

describe('dataFlowText', () => {
  it('엣지 배지 — 기록 없음은 정상이 아니다', () => {
    expect(edgeBadge({ registered: true, used: 0 }).text).toBe('기록 없음');
    expect(edgeBadge({ registered: false }).tone).toBe('bad');
    expect(edgeBadge({ registered: true, used: 3, fail: 1 }).text).toBe('실패 1');
    expect(edgeBadge({ registered: true, used: 3 }).tone).toBe('ok');
  });
  it('내부 수집 항목 — 시각·오류가 없으면 정상이라 말하지 않는다', () => {
    expect(innerItemText({ ok: true, value: {} }).text).toMatch('실행 기록 없음');
    expect(innerItemText({ ok: true, value: { last: { at: Date.now(), ok: false, status: 403, reason: '개별 토큰만' } } }).text).toMatch('개별 토큰만');
    expect(innerItemText({ ok: true, value: { lastRun: { at: Date.now(), skipped: '비활성' } } }).text).toMatch('건너뜀');
    expect(innerItemText({ ok: true, value: { last: { at: Date.now(), errors: ['a'] } } }).tone).toBe('bad');
    expect(innerItemText({ ok: true, value: { lastRunTs: 0 } }).tone).toBe('muted');
    expect(innerItemText({ ok: true, value: {} }).tone).toBe('muted');
    expect(innerItemText({ ok: false, error: 'x 없음' }).tone).toBe('bad');
    expect(innerItemText({ ok: true, value: { lastError: { detail: '403' } } }).tone).toBe('bad');
    const t = innerItemText({ ok: true, value: { lastAt: Date.now() - 60_000 } });
    expect(t.tone).toBe('ok'); expect(t.text).toMatch('마지막');
    expect(innerItemText({ ok: true, value: { lastAt: '' } }).tone).toBe('muted'); // '' 를 0 시각으로 읽지 않는다
  });
  it('문구 — 기록 시작·미검증·경로 접두', () => {
    expect(sinceNote({ since: Date.now() - 60_000 })).toMatch('정상으로 칠하지 않습니다');
    expect(sinceNote({ rejectsWithoutTime: 3 })).toMatch('거부 3건');
    expect(linkText({ state: 'fail', lastAt: Date.now(), reason: '토큰 불일치', unverified: true })).toMatch('이름 미검증');
    expect(routePath({ side: 'collector', path: '/export' })).toBe('/api/collector/export');
    expect(routePath({ side: 'central', path: '/inventory' })).toBe('/api/central/inventory');
  });
  it('엣지별 마지막 시각은 성공만 본다', () => {
    const byId = new Map(data.routes.map((r) => [r.id, r]));
    const x = edgeLasts('a', data.links, byId);
    expect(x.up).toBe(100); expect(x.central).toBe(50);
  });
  it('문구에 백틱 없음', () => {
    const all = [...LEGEND, ...Object.values(KIND_LABEL), ...Object.values(STATE_LABEL)];
    for (const s of all) expect(s.includes('`')).toBe(false);
  });
});
