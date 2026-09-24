/**
 * v2.599 감사 그룹 f 회귀 — 웹 테스트는 node 환경(DOM 없음)이라 컴포넌트를 그리지 못한다.
 * 순수 헬퍼는 실행으로, 컴포넌트의 '세대 가드 배선' 은 소스로 고정한다(실제 경쟁은 Chromium 에서 확인했다).
 *  - WEB2599-02 통신 점검 › 점검 로그: 늦게 온 이전 기간 응답이 새 선택을 덮는다
 *  - WEB2599-03 엣지 로그: 두 엣지 연달아 '지금 가져오기' — 진행 표시 해제·느린 응답이 보던 화면을 덮는다
 *  - WEB2599-06 3단 지도: 엣지 0곳이면 가운데 열이 설명 없이 빈다
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { busyAdd, busyRemove, staleFetchNote } from './edgeLogText.js';
import { layoutDeviceFlow, EDGE_X, MAIN_MIN_H } from './deviceFlowLayout.js';
import { noEdgesNote } from './deviceFlowText.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
// 주석을 먼저 지운다(설명 주석이 통과 근거가 되지 않게 — v2.535 규약). 개행은 보존.
const code = (f) => fs.readFileSync(path.join(HERE, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ''))
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

describe('WEB2599-03 엣지별 진행 표시', () => {
  it('A·B 를 연달아 잠그고 A 가 먼저 풀려도 B 는 잠긴 채다', () => {
    let s = new Set();
    s = busyAdd(s, 'A');
    s = busyAdd(s, 'B');
    s = busyRemove(s, 'A');
    expect(s.has('B')).toBe(true);
    expect(s.has('A')).toBe(false);
  });
  it('새 Set 을 돌려준다(제자리 수정하면 React 가 다시 그리지 않는다)', () => {
    const a = new Set(['x']);
    expect(busyAdd(a, 'y')).not.toBe(a);
    expect(busyRemove(a, 'x')).not.toBe(a);
    expect(a.has('x')).toBe(true);
  });
  it('보던 화면을 바꾸지 않은 결과는 어느 엣지가 어떻게 끝났는지 말한다', () => {
    expect(staleFetchNote('edge-a', { ok: true }).text).toMatch(/edge-a.*끝났습니다.*바꾸지 않았습니다/);
    const f = staleFetchNote('edge-a', { ok: false, reason: 'timeout' });
    expect(f.tone).toBe('bad');
    expect(f.text).toMatch(/실패.*timeout/);
    expect(f.text).not.toMatch(/`/);
  });
  it('EdgeLog.jsx — 진행 표시는 집합, 화면 반영은 세대가 같을 때만', () => {
    const s = code('EdgeLog.jsx');
    expect(s).not.toMatch(/busyAgent/);
    expect(s).toMatch(/useRef\(0\)/);
    for (const fn of ['fetchEdge', 'openStored', 'openLocal']) {
      const body = s.slice(s.indexOf(`async function ${fn}`), s.indexOf('\n  }\n', s.indexOf(`async function ${fn}`)));
      expect(body, fn).toMatch(/const g = \+\+viewGen\.current/);
      expect(body, fn).toMatch(/g (===|!==) viewGen\.current/);
    }
  });
});

describe('WEB2599-02 점검 로그 세대 가드', () => {
  it('LinkCheck.jsx — 로그 조회는 useLatest 를 거친다(setEvents 를 직접 await 결과로 부르지 않는다)', () => {
    const s = code('LinkCheck.jsx');
    expect(s).toMatch(/useLatest\(\)/);
    expect(s).not.toMatch(/setEvents\(await/);
    const body = s.slice(s.indexOf('const loadEvents'), s.indexOf('useEffect(() => { loadEvents'));
    expect(body).toMatch(/latestEvents\(/);
    expect(body).toMatch(/setEvents\(d\)/);
  });
});

describe('WEB2599-06 3단 지도 엣지 0곳', () => {
  it('엣지가 없으면 가운데 열에 안내 상자 자리가 있다', () => {
    const l = layoutDeviceFlow({ main: { groups: [] }, edges: [] });
    expect(l.emptyEdges).toMatchObject({ x: EDGE_X });
    expect(l.height).toBeGreaterThan(l.emptyEdges.y + l.emptyEdges.h);
    expect(l.rows.map((r) => r.kind)).toEqual(['direct']);
  });
  it('메인 카드 최소 높이는 내용(실측 256px + 테두리 2px)을 덮는다 — 240 이면 선 범례 마지막 줄이 잘렸다', () => {
    expect(MAIN_MIN_H).toBeGreaterThanOrEqual(258);
  });
  it('엣지가 있으면 안내 상자가 없다', () => {
    expect(layoutDeviceFlow({ edges: [{ id: 'a', name: 'A', groups: [] }] }).emptyEdges).toBe(null);
  });
  it('문구 — 등록 경로를 말하고, 담당 장비가 있으면 붙일 곳 없음을 말하고, 없으면 정상일 수 있다고 말한다', () => {
    expect(noEdgesNote({})).toMatch(/설정 › 수집 서버/);
    expect(noEdgesNote({})).toMatch(/정상/);
    const n = noEdgesNote({ totals: { unassignedDevices: 4 } });
    expect(n).toMatch(/4대/);
    expect(n).not.toMatch(/정상/);
    expect(n).not.toMatch(/`/);
  });
  it('DeviceFlow.jsx 가 안내 상자를 그린다', () => {
    expect(code('DeviceFlow.jsx')).toMatch(/lay\.emptyEdges && [\s\S]{0,400}noEdgesNote\(data\)/);
  });
});
