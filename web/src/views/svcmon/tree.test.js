// tree 단위테스트(v2.295, 1차 모듈화 감사 확정 #1) — 성능점검 트리/집계 의미론 고정.
// 핵심은 v2.279 실버그의 재발 방지: '갱신 안 됨(stale)'·'대기(pending)'를 disabled 로 합산해
// 폴러 기아 감시 공백이 '의도적 중지'로 위장되던 집계를, 서버 status 와 같은 6키로 정확히 센다.
import { describe, it, expect } from 'vitest';
import { statusOf } from './constants.js';
import { buildTree, statsOf, matchNode, summarize } from './tree.js';

const T = (path, name, tests, extra = {}) => ({ id: name, path, name, tests, ...extra });
const X = (state, extra = {}) => ({ state, ...extra });

describe('statusOf — state 우선 → enabled → result(서버 status.js 와 정렬)', () => {
  it('명시 state 최우선, 없으면 enabled=false → disabled, 그 외 result.status, 다 없으면 pending', () => {
    expect(statusOf({ }, { state: 'stale' })).toBe('stale');
    expect(statusOf({ enabled: false }, {})).toBe('disabled');
    expect(statusOf({}, { enabled: false })).toBe('disabled');
    expect(statusOf({}, { result: { status: 'ok' } })).toBe('ok');
    expect(statusOf({}, {})).toBe('pending');
  });
});

describe('summarize — v2.279 회귀 고정(6키 정확 집계)', () => {
  it('stale·pending 은 disabled 로 합산되지 않는다(감시 공백 위장 금지)', () => {
    const s = summarize([
      T('A', 't1', [X('ok'), X('stale'), X(undefined)]),          // undefined state → pending
      T('A', 't2', [X('bad'), X('warn')], { enabled: false }),    // enabled=false 인데 state 명시 → state 우선
      T('B', 't3', [{ enabled: false }]),                          // test 비활성 → disabled
    ]);
    expect(s).toEqual({ total: 6, ok: 1, warn: 1, bad: 1, stale: 1, pending: 1, disabled: 1 });
  });
  it('알 수 없는 상태 키는 disabled 가 아니라 pending 으로', () => {
    const s = summarize([T('A', 't', [X('weird-new-state')])]);
    expect(s.pending).toBe(1);
    expect(s.disabled).toBe(0);
  });
});

describe('statsOf — 알람 집계(stale 포함)와 최악 상태 순위', () => {
  it('stale 은 알람에 포함되고 순위는 bad > stale > warn > ok', () => {
    const node = buildTree([
      T('A', 't1', [X('warn'), X('stale')]),
      T('A', 't2', [X('ok')]),
    ], [{ path: 'A' }]);
    const st = statsOf(node);
    expect(st.alarms).toBe(2);          // warn + stale (ok 제외)
    expect(st.worst).toBe('stale');     // stale(3) > warn(2)
  });
});

describe('buildTree — 명시 폴더 유지·경로 중첩·정렬 모드', () => {
  it('대상 없는 폴더도 유지 + 경로(\\ 구분) 중첩', () => {
    const root = buildTree([T('A\\B', 'x', [])], [{ path: 'A' }, { path: 'EMPTY' }]);
    expect([...root.children.keys()].sort()).toEqual(['A', 'EMPTY']);
    expect(root.children.get('A').children.get('B').targets.map((t) => t.name)).toEqual(['x']);
  });
  it("sortMode 'name' 은 이름순, 'manual' 은 order 우선(생성순 보존)", () => {
    const targets = [T('A', 'b', [], { order: 2 }), T('A', 'a', [], { order: 1 })];
    const byName = buildTree(targets, [{ path: 'A' }], 'name');
    expect(byName.children.get('A').targets.map((t) => t.name)).toEqual(['a', 'b']);
    const manual = buildTree([T('A', 'b', [], { order: 1 }), T('A', 'a', [], { order: 2 })], [{ path: 'A' }], 'manual');
    expect(manual.children.get('A').targets.map((t) => t.name)).toEqual(['b', 'a']);
  });
});

describe('matchNode — 폴더/대상/호스트 검색(하위 폴더 전파)', () => {
  it('하위 대상의 host 매칭이 상위 폴더를 살린다', () => {
    const root = buildTree([T('A\\B', 'web', [], { host: '10.0.0.9' })], []);
    expect(matchNode(root.children.get('A'), '0.0.9')).toBe(true);
    expect(matchNode(root.children.get('A'), 'nope')).toBe(false);
    expect(matchNode(root.children.get('A'), '')).toBe(true); // 빈 검색 = 전부
  });
});
