import { describe, it, expect } from 'vitest';
import {
  layoutDataFlow, W, EDGE_X, BUS_X, EDGE_COLS, MAIN_X, MAIN_MIN_H, MAIN_BASE_H, MAIN_ROW_H, UP_KINDS, DOWN_KINDS, edgeDirections, mainSummary,
} from './dataFlowLayout.js';
import {
  edgeBadge, innerItemText, sinceNote, linkText, routePath, edgeLasts, LEGEND, legendLines, KIND_LABEL, STATE_LABEL,
  dirCellText, dirSumText, DIR_LABEL, DIR_KINDS_TEXT, shortEdgeLabels,
} from './dataFlowText.js';

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
  it('v2.591 C1: 최상위 {at, ok:false, reason} 은 실패 · ISO generatedAt 은 시각 · 숫자 문자열은 Date.parse 하지 않는다', () => {
    const now = Date.now();
    const sr = innerItemText({ ok: true, value: { at: now - 120_000, ok: false, status: 400, reason: '요청 IP가 루프백입니다' } }, now);
    expect(sr.tone).toBe('bad'); expect(sr.text).toMatch('루프백');
    expect(innerItemText({ ok: true, value: { at: now, ok: false, status: 413 } }, now).text).toMatch('HTTP 413');
    const inv = innerItemText({ ok: true, value: { generatedAt: new Date(now - 30_000).toISOString() } }, now);
    expect(inv.tone).toBe('ok'); expect(inv.text).toMatch('마지막');
    expect(innerItemText({ ok: true, value: { generatedAt: '12345' } }, now).tone).toBe('muted');
    expect(innerItemText({ ok: true, value: { at: now, ok: true } }, now).tone).toBe('ok');
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

describe('legendLines', () => {
  it('낡음 경계는 서버 값으로 채우고, 없으면 숫자를 지어내지 않는다', () => {
    expect(legendLines({ staleFactor: 4, staleMinMs: 15 * 60_000 })[0]).toMatch('4배(하한 15분)');
    const blank = legendLines({})[0];
    expect(blank).toMatch('서버 설정'); expect(blank.includes('{')).toBe(false);
  });
});

// ── v2.591 엣지 ↔ MAIN ──
const ROUTES6 = [
  { id: 'r-push', kind: 'push', cat: 'inv', state: 'ok' },
  { id: 'r-reply', kind: 'reply', cat: 'ops', state: 'ok' },
  { id: 'r-cpull', kind: 'cpull', cat: 'inv', state: 'ok' },
  { id: 'r-pull', kind: 'pull', cat: 'reg', state: 'ok' },
  { id: 'r-job', kind: 'job', cat: 'ops', state: 'ok' },
  { id: 'r-cpush', kind: 'cpush', cat: 'ops', state: 'ok' },
];
const edgesN = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, name: `EDGE-${i}`, registered: true, used: 1 }));
/** 'M x y H x V y H x' 경로를 선분으로. */
function segs(d) {
  const t = d.trim().split(/\s+/); let x = 0, y = 0; const out = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i][0], v = t[i].length > 1 ? Number(t[i].slice(1)) : null;
    if (c === 'M') { x = v ?? Number(t[++i]); y = Number(t[++i]); continue; }
    if (c === 'H') { const nx = v ?? Number(t[++i]); out.push({ x1: x, y1: y, x2: nx, y2: y }); x = nx; continue; }
    if (c === 'V') { const ny = v ?? Number(t[++i]); out.push({ x1: x, y1: y, x2: x, y2: ny }); y = ny; continue; }
    throw new Error(`알 수 없는 명령 ${t[i]}`);
  }
  return out;
}
const crosses = (sg, r) => {
  const lo = (a, b) => Math.min(a, b), hi = (a, b) => Math.max(a, b);
  if (sg.y1 === sg.y2) return sg.y1 > r.y && sg.y1 < r.y + r.h && hi(sg.x1, sg.x2) > r.x && lo(sg.x1, sg.x2) < r.x + r.w;
  return sg.x1 > r.x && sg.x1 < r.x + r.w && hi(sg.y1, sg.y2) > r.y && lo(sg.y1, sg.y2) < r.y + r.h;
};

describe('엣지 ↔ MAIN(v2.591 — 데이터 방향)', () => {
  it('방향 집합은 서버 종류 6개를 정확히 한 번씩 나눈다(데이터가 가는 쪽)', () => {
    expect([...UP_KINDS, ...DOWN_KINDS].sort()).toEqual(Object.keys(KIND_LABEL).sort());
    expect(UP_KINDS.filter((k) => DOWN_KINDS.includes(k))).toEqual([]);
    expect(UP_KINDS).toContain('cpull');   // 메인이 엣지에서 가져온 자료는 메인을 향한다
    expect(DOWN_KINDS).toContain('pull');  // 엣지가 가져간 설정은 엣지를 향한다
  });
  it('방향 상태는 가장 나쁜 것 · 기록이 없으면 none(정상 아님)', () => {
    const byId = new Map(ROUTES6.map((r) => [r.id, r]));
    const links = [
      { edge: 'a', route: 'r-push', state: 'ok', okAt: 100, lastAt: 100 },
      { edge: 'a', route: 'r-cpull', state: 'stale', okAt: 50, lastAt: 50 },
      { edge: 'a', route: 'r-pull', state: 'fail', okAt: 10, failAt: 90, lastAt: 90, reason: '토큰 불일치' },
      { edge: 'b', route: 'r-job', state: 'ok', okAt: 70, lastAt: 70 },
    ];
    const a = edgeDirections('a', links, byId);
    expect(a.up.state).toBe('stale'); expect(a.up.links).toBe(2); expect(a.up.okAt).toBe(100);
    expect(a.down.state).toBe('fail'); expect(a.down.reason).toBe('토큰 불일치'); expect(a.down.failAt).toBe(90);
    const b = edgeDirections('b', links, byId);
    expect(b.up.state).toBe('none'); expect(b.up.links).toBe(0);
    expect(b.down.state).toBe('ok');
    const s = mainSummary({ routes: ROUTES6, edges: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], links });
    expect(s.upSum).toEqual({ ok: 0, stale: 1, fail: 0, none: 2 });
    expect(s.downSum).toEqual({ ok: 1, stale: 0, fail: 1, none: 1 });
  });
  it('엣지마다 두 가닥 · 다른 카드를 가로지르지 않는다 · 끝점은 MAIN 카드 높이 안(1·7·8·28곳)', () => {
    for (const n of [1, 7, 8, 28]) {
      const l = layoutDataFlow({ routes: ROUTES6, edges: edgesN(n), links: [] });
      expect(l.mainLines).toHaveLength(n * 2);
      const cards = [...l.edgePos.entries()];
      for (const m of l.mainLines) {
        const own = l.edgePos.get(m.edge);
        for (const sg of segs(m.d)) {
          for (const [id, r] of cards) expect(crosses(sg, r), `${n}곳 ${m.key} ↔ ${id}`).toBe(false);
          expect(crosses(sg, l.main), `${n}곳 ${m.key} ↔ MAIN`).toBe(false);
          for (const v of [sg.x1, sg.x2]) { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(W); }
        }
        expect(m.mainY).toBeGreaterThan(l.main.y); expect(m.mainY).toBeLessThan(l.main.y + l.main.h);
        const ss = segs(m.d);
        // 엣지 쪽 끝점은 x 뿐 아니라 y 도 **자기 카드의 높이 안**이어야 한다(v2.591 검토 — x 만 보면 다른 행 카드를 가리켜도 통과했다).
        const inOwn = (y) => y > own.y && y < own.y + own.h;
        if (m.dir === 'up') { expect(ss[0].x1).toBe(own.x + own.w); expect(inOwn(ss[0].y1)).toBe(true); expect(ss[ss.length - 1].x2).toBe(MAIN_X); }
        else { expect(ss[0].x1).toBe(MAIN_X); expect(ss[ss.length - 1].x2).toBe(own.x + own.w); expect(inOwn(ss[ss.length - 1].y2)).toBe(true); }
      }
      // 높이는 MAIN 카드와 마지막 행 간격을 모두 담는다.
      expect(l.height).toBeGreaterThanOrEqual(l.main.y + l.main.h);
      expect(l.main.h).toBeGreaterThanOrEqual(MAIN_MIN_H);
      for (const p of l.edgePos.values()) expect(p.x + p.w).toBeLessThan(MAIN_X);
    }
    expect(EDGE_COLS).toBe(2);
  });
  it('같은 통로의 세로 선이 행끼리 겹치지 않는다(28곳)', () => {
    const l = layoutDataFlow({ routes: ROUTES6, edges: edgesN(28), links: [] });
    const vert = l.mainLines.flatMap((m) => segs(m.d).filter((sg) => sg.x1 === sg.x2).map((sg) => ({ ...sg, key: m.key })));
    for (let i = 0; i < vert.length; i++) for (let j = i + 1; j < vert.length; j++) {
      const a = vert[i], b = vert[j];
      if (a.x1 !== b.x1) continue;
      const overlap = Math.min(Math.max(a.y1, a.y2), Math.max(b.y1, b.y2)) - Math.max(Math.min(a.y1, a.y2), Math.min(b.y1, b.y2));
      expect(overlap, `${a.key} ↔ ${b.key}`).toBeLessThanOrEqual(0);
    }
  });
  it('선 색 = 방향 상태 · MAIN 선택은 MAIN 선만, 엣지 선택은 그 엣지 두 가닥만 강조', () => {
    const links = [{ edge: 'e0', route: 'r-push', state: 'fail', okAt: 1, failAt: 2, lastAt: 2 }];
    const l = layoutDataFlow({ routes: ROUTES6, edges: edgesN(3), links });
    const up0 = l.mainLines.find((m) => m.key === 'up:e0');
    expect(up0.state).toBe('fail');
    expect(l.mainLines.find((m) => m.key === 'down:e0').state).toBe('none');
    expect(l.mainLines[l.mainLines.length - 1].state).toBe('fail'); // 실패를 맨 위에
    const lm = layoutDataFlow({ routes: ROUTES6, edges: edgesN(3), links }, { type: 'main', id: 'main' });
    expect(lm.mainLines.every((m) => m.hot && !m.dim)).toBe(true);
    expect(lm.outLines.every((x) => x.dim)).toBe(true);
    expect(lm.inLines.every((x) => x.dim)).toBe(true);
    const le = layoutDataFlow({ routes: ROUTES6, edges: edgesN(3), links }, { type: 'edge', id: 'e1' });
    expect(le.mainLines.filter((m) => m.hot).map((m) => m.key).sort()).toEqual(['down:e1', 'up:e1']);
    const lc = layoutDataFlow({ cats: [{ id: 'inv' }], routes: ROUTES6, edges: edgesN(3), links }, { type: 'cat', id: 'inv' });
    expect(lc.mainLines.every((m) => m.dim)).toBe(true);
  });
  it('엣지 0곳이면 MAIN 선이 없고 죽지 않는다', () => {
    const l = layoutDataFlow({ routes: ROUTES6 });
    expect(l.mainLines).toEqual([]); expect(l.summary.rows).toEqual([]);
    expect(l.main.h).toBe(MAIN_MIN_H);
  });
  it('방향 칸 문구 — 기록 없음은 —, 실패는 사유와 함께, 정상은 마지막 성공 시각', () => {
    const now = 10_000_000;
    expect(dirCellText({ state: 'none', links: 0 }, now).text).toBe('—');
    expect(dirCellText({ state: 'none', links: 0 }, now).title).toMatch('정상이라는 뜻이 아닙니다');
    const f = dirCellText({ state: 'fail', links: 2, ok: 1, fail: 1, okAt: now - 600_000, failAt: now - 60_000, lastAt: now - 60_000, reason: '소유권 충돌' }, now);
    expect(f.text).toBe('실패'); expect(f.title).toMatch('소유권 충돌'); expect(f.title).toMatch('가장 최근 성공');
    const o = dirCellText({ state: 'ok', links: 1, ok: 1, okAt: now - 30_000, lastAt: now - 30_000 }, now);
    expect(o.text).toMatch('전'); expect(o.state).toBe('ok');
    expect(o.short.endsWith('전')).toBe(false); expect(o.short).toMatch('초');
    expect(dirSumText({ ok: 3, none: 1 })).toBe('정상 3 · 낡음 0 · 실패 0 · 없음 1');
    for (const x of [...Object.values(DIR_LABEL), ...Object.values(DIR_KINDS_TEXT), f.title, o.title]) expect(x.includes('`')).toBe(false);
  });
});

describe('v2.591 검토 반영', () => {
  const byId = new Map(ROUTES6.map((r) => [r.id, r]));
  it('낡음 칸의 시각은 낡은 연결의 마지막 성공이다(다른 연결의 최근 성공이 아니다)', () => {
    const now = 100_000_000;
    const links = [
      { edge: 'a', route: 'r-pull', state: 'ok', okAt: now - 30_000, lastAt: now - 30_000 },
      { edge: 'a', route: 'r-job', state: 'stale', okAt: now - 2 * 3_600_000, lastAt: now - 2 * 3_600_000 },
    ];
    const d = edgeDirections('a', links, byId).down;
    expect(d.state).toBe('stale'); expect(d.okAt).toBe(now - 30_000); expect(d.worstOkAt).toBe(now - 2 * 3_600_000);
    const x = dirCellText(d, now);
    expect(x.short).toMatch('시간'); expect(x.short).not.toMatch('초');
    expect(x.title).toMatch('낡은 연결의 마지막 성공');
  });
  it('실패 사유는 서로 다른 것을 전부 든다 · 이름 미검증을 밝힌다', () => {
    const links = [
      { edge: 'a', route: 'r-push', state: 'fail', failAt: 3, reason: '소유권 충돌' },
      { edge: 'a', route: 'r-reply', state: 'fail', failAt: 5, reason: '토큰 불일치', unverified: true },
      { edge: 'a', route: 'r-cpull', state: 'fail', failAt: 4, reason: '소유권 충돌' },
    ];
    const d = edgeDirections('a', links, byId).up;
    expect(d.reasons).toEqual(['토큰 불일치', '소유권 충돌']);
    expect(d.worstUnverified).toBe(1);
    const t = dirCellText(d, 10).title;
    expect(t).toMatch('토큰 불일치 / 소유권 충돌'); expect(t).toMatch('이름 미검증');
  });
  it('고른 엣지가 사라지면 선택을 버린다(선이 전부 흐린 채 남지 않게)', () => {
    const l = layoutDataFlow({ routes: ROUTES6, edges: edgesN(2), links: [] }, { type: 'edge', id: 'GONE' });
    expect(l.sel).toBe(null);
    expect(l.mainLines.some((m) => m.dim)).toBe(false);
    expect(layoutDataFlow({ cats: [], routes: ROUTES6, edges: edgesN(1) }, { type: 'cat', id: 'x' }).sel).toBe(null);
    expect(layoutDataFlow({ routes: ROUTES6, edges: edgesN(1) }, { type: 'main', id: 'main' }).sel?.type).toBe('main');
  });
  it('MAIN 카드는 엣지 목록이 다 들어가는 높이다(엣지 3~4곳에서 마지막 행이 잘리던 것)', () => {
    for (const n of [1, 3, 4, 5, 6, 28]) {
      const l = layoutDataFlow({ routes: ROUTES6, edges: edgesN(n), links: [] });
      expect(l.main.h).toBeGreaterThanOrEqual(MAIN_BASE_H + n * MAIN_ROW_H);
    }
    expect(MAIN_MIN_H).toBe(MAIN_BASE_H);
  });
  it('짧은 이름 — 앞부분이 겹치면 뒷부분으로 구분하고, 짧은 이름은 그대로', () => {
    expect(shortEdgeLabels(['LGES-HG01', 'LGES-HG02'], 10)).toEqual(['LGES-HG01', 'LGES-HG02']);
    const x = shortEdgeLabels(['EDGE-IN-MUMBAI-DC2', 'EDGE-IN-MUMBAI-DC3', 'EDGE-PL-WROCLAW'], 10);
    expect(new Set(x).size).toBe(3);
    expect(x[0]).toMatch(/DC2$/); expect(x[2]).toBe('EDGE-PL-W…');
    for (const v of x) expect(v.length).toBeLessThanOrEqual(10);
    // 뒷부분까지 같으면 원래 이름(말줄임은 화면이 한다) — 지어낸 구분을 만들지 않는다.
    expect(shortEdgeLabels(['AAAAAAAAAAAAAXYZ', 'AAAAAAAAAAAAAXYZ'], 10)).toEqual(['AAAAAAAAAAAAAXYZ', 'AAAAAAAAAAAAAXYZ']);
  });
});
