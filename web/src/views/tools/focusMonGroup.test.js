/**
 * focusMonGroup.test.js — v2.982 서버 집중 모니터링 '서버 그룹'(사용자 요청 2026-11-12 "등록된 서버를 그룹별로 분류해서 보는 기능 추가" → 시안 ⑫ · '구현해줘').
 *  · 그룹 묶음 · 단추 · 거르기: 순서(응답 → 그 밖에 쓰인 이름 → 그룹 없음) · 대수 0 은 단추에서 빠짐 · 없는 그룹을 고르면 전체(단추도 '전체' 가 켜짐 — 같은 판정)
 *  · 그룹 시작: 상한을 넘으면 앞 N대 · 나머지 알림
 *  · 자동 묶기 제안: 그룹 없음 · 데모가 아닌 서버만 · 둘 이상 · 있는 그룹 이름은 그 표기로
 *  · 그룹 요약(개요 · 그룹별로): 값 없는 서버는 평균에 넣지 않음(0 아님)
 *  · CSV 안내 · 수정 칸 · 웹 GROUP_RE 는 서버와 같은 글자
 *  · 화면 소스: 그룹 쓰기 응답의 ok:false 를 성공으로 읽지 않는다 · 고른 그룹은 브라우저가 기억 · 백틱 없음
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  GROUP_NONE, GROUP_RE, groupLabel, groupSections, groupChips, filterByGroup, groupChipOn, groupSummary, groupStartPlan, groupStartText,
  groupSuggestions, suggestionText, csvGroupNote, csvHeaderNotes, csvChangeText, editFormOf, editChanges, EDIT_FIELDS,
} from './focusMonText.js';

const T = (id, group = '', extra = {}) => ({ id, name: id, host: `10.0.0.${id.length}`, agent: '', group, ...extra });

describe('그룹 묶음 · 단추 · 거르기', () => {
  const list = [{ name: 'DB', n: 1 }, { name: 'WEB', n: 2 }, { name: '빈 그룹', n: 0 }];
  const ts = [T('w1', 'WEB'), T('d1', 'DB'), T('x1'), T('w2', 'WEB'), T('o1', 'OLD')];
  it('순서: 응답 그룹 → 응답에 없는 이름 → 그룹 없음 · 빈 그룹은 keepEmpty 일 때만', () => {
    expect(groupSections(ts, list).map((x) => x.key)).toEqual(['DB', 'WEB', 'OLD', '']);
    expect(groupSections(ts, list).find((x) => x.key === '').label).toBe(GROUP_NONE);
    expect(groupSections(ts, list, { keepEmpty: true }).map((x) => x.key)).toEqual(['DB', 'WEB', '빈 그룹', 'OLD', '']);
    expect(groupSections([], list)).toEqual([]);
  });
  it('단추: 전체 + 대수 있는 그룹 · 대수', () => {
    expect(groupChips(ts, list)).toEqual([
      { key: 'all', label: '전체', n: 5 }, { key: 'DB', label: 'DB', n: 1 }, { key: 'WEB', label: 'WEB', n: 2 }, { key: 'OLD', label: 'OLD', n: 1 }, { key: '', label: GROUP_NONE, n: 1 },
    ]);
  });
  it('거르기 · 없는 그룹(지워졌거나 다 옮겨짐)이면 전체 — 단추도 같은 판정으로 전체가 켜진다', () => {
    expect(filterByGroup(ts, 'WEB').map((t) => t.id)).toEqual(['w1', 'w2']);
    expect(filterByGroup(ts, '').map((t) => t.id)).toEqual(['x1']);
    expect(filterByGroup(ts, 'all')).toBe(ts);
    expect(filterByGroup(ts, '없는 그룹')).toBe(ts);
    const grouped = ts.filter((t) => t.group);
    expect(filterByGroup(grouped, '')).toBe(grouped); // 그룹 없음 서버가 없으면 빈 목록에 머물지 않는다
    const chips = groupChips(grouped, list);
    expect(groupChipOn(chips, '', 'all')).toBe(true);
    expect(groupChipOn(chips, '', '')).toBe(true); // 고른 값 그 자체 — 단추가 없으니 그려지지 않는다
    expect(groupChipOn(chips, 'WEB', 'all')).toBe(false);
    expect(groupChipOn(chips, 'WEB', 'WEB')).toBe(true);
    expect(groupChipOn(chips, '없는 그룹', 'all')).toBe(true);
    // 판정 하나: 단추 목록에 있는 키를 고르면 그 대수만큼 거른다
    for (const c of chips) expect(filterByGroup(grouped, c.key).length).toBe(c.n);
  });
  it('groupLabel', () => {
    expect(groupLabel('')).toBe(GROUP_NONE);
    expect(groupLabel(null)).toBe(GROUP_NONE);
    expect(groupLabel('DB')).toBe('DB');
  });
});

describe('그룹 시작 — 수집 상한', () => {
  it('상한 안이면 전부 · 넘으면 앞 N대와 나머지 · 중복 id 는 하나', () => {
    expect(groupStartPlan(['a', 'b', 'a'], 20)).toEqual({ start: ['a', 'b'], rest: [] });
    const ids = Array.from({ length: 23 }, (_, i) => `s${i}`);
    const p = groupStartPlan(ids, 20);
    expect(p.start).toHaveLength(20);
    expect(p.rest).toEqual(['s20', 's21', 's22']);
    expect(groupStartText('WAS', p, 20)).toMatch(/WAS 23대 가운데 앞 20대로 시작합니다/);
    expect(groupStartText('WAS', p, 20)).toMatch(/나머지 3대/);
    expect(groupStartText('', p, 20)).toMatch(new RegExp(`^${GROUP_NONE}`));
    expect(groupStartText('WAS', { start: ['a'], rest: [] }, 20)).toBe('');
  });
});

describe('자동 묶기 제안', () => {
  const ts = [
    T('lab-test-01', '', { host: '10.72.1.11' }), T('lab-test-02', '', { host: '10.72.1.12' }),
    T('web01', '', { host: '10.72.2.5', agent: 'edge-pl' }), T('web02', '', { host: '10.72.2.6', agent: 'edge-pl' }),
    T('db-01', 'DB', { host: '10.72.1.20' }), T('db-02', '', { host: '10.72.9.1' }),
    T('demo-01', '', { demo: true }), T('demo-02', '', { demo: true }),
  ];
  const sg = groupSuggestions(ts, [{ name: 'DB' }, { name: 'Web' }]);
  const byKind = Object.fromEntries(sg.map((x) => [x.kind, x]));
  it('이름 앞부분: 그룹 없음 · 데모 아닌 서버 · 둘 이상만(db-02 하나뿐이라 빠짐 · db-01 은 이미 그룹)', () => {
    expect(byKind.prefix.moves.map((m) => [m.group, m.ids])).toEqual([['lab-test', ['lab-test-01', 'lab-test-02']], ['Web', ['web01', 'web02']]]);
  });
  it('있는 그룹 이름은 대소문자를 무시하고 그 표기로(web → Web) · 새 그룹 표시', () => {
    const txt = suggestionText(byKind.prefix, [{ name: 'DB' }, { name: 'Web' }]);
    expect(txt).toMatch(/lab-test\(새 그룹\) 2대/);
    expect(txt).toMatch(/Web 2대/);
    expect(txt).not.toMatch(/Web\(새 그룹\)/);
  });
  it('담당 노드 · IP 대역(/24)', () => {
    expect(byKind.node.moves.map((m) => [m.group, m.ids.length])).toEqual([['중앙', 3], ['edge-pl', 2]]);
    expect(byKind.subnet.moves.map((m) => m.group)).toEqual(['10.72.1', '10.72.2']);
  });
  it('묶을 것이 없으면 빈 목록 · 만든 이름은 모두 그룹 이름 규칙을 지킨다', () => {
    expect(groupSuggestions([T('a', 'X'), T('b', 'X')])).toEqual([]);
    expect(groupSuggestions([T('one')])).toEqual([]);
    const odd = groupSuggestions([T('#$%-01'), T('#$%-02'), T('..x-1'), T('..x-2')]);
    for (const k of odd) for (const m of k.moves) expect(GROUP_RE.test(m.group)).toBe(true);
  });
});

describe('그룹 요약 — 개요 · 그룹별로 나눠 보기', () => {
  it('값 없는 서버는 평균에 넣지 않는다(0 이 아니다) · 가장 바쁜 서버', () => {
    const rows = [
      { id: 'a', t: { name: 'a' }, sum: { cpu: 10 } }, { id: 'b', t: { name: 'b' }, sum: { cpu: 50 } },
      { id: 'c', t: { name: 'c' }, sum: null }, { id: 'd', t: { name: 'd' }, sum: { cpu: null } },
    ];
    expect(groupSummary(rows)).toEqual({ n: 4, valued: 2, avg: 30, top: { name: 'b', cpu: 50 } });
    expect(groupSummary([{ id: 'c', t: { name: 'c' }, sum: null }])).toEqual({ n: 1, valued: 0, avg: null, top: null });
    expect(groupSummary([])).toEqual({ n: 0, valued: 0, avg: null, top: null });
  });
});

describe('CSV 안내 · 수정 칸', () => {
  it('그룹 열이 없으면 그대로 둔다는 안내 · 있으면 새 그룹 목록 · 상한 초과 경고', () => {
    expect(csvGroupNote({ header: true, groupColumn: false })).toMatch(/그대로 둡니다/);
    expect(csvGroupNote({ header: false })).toMatch(/그대로 둡니다/);
    expect(csvGroupNote({ header: true, groupColumn: true, newGroups: [] })).toBe('그룹 열을 읽어 그룹도 정합니다 — 빈 칸은 그룹 없음.');
    expect(csvGroupNote({ header: true, groupColumn: true, newGroups: ['WAS', 'MES'] })).toMatch(/새로 만들 그룹 2개: WAS, MES/);
    expect(csvGroupNote(null)).toBe('');
    expect(csvHeaderNotes({ header: true, missing: [], groupsOver: true, newGroups: ['a', 'b'], groupsMax: 50 }).join(' ')).toMatch(/새 그룹 2개를 더하면 그룹이 50개를 넘습니다/);
    expect(csvHeaderNotes({ header: true, missing: [] })).toEqual([]);
    expect(csvChangeText({ action: 'update', changes: ['group'], before: { group: '' }, value: { group: 'WEB' } })).toBe(`그룹 ${GROUP_NONE} → WEB`);
  });
  it('수정 칸에 그룹 · 바뀐 칸 글', () => {
    expect(EDIT_FIELDS).toContain('group');
    const t = { id: 'x', name: 'a', host: '10.0.0.1', port: 22, username: 'u', agent: '', group: 'DB' };
    expect(editFormOf(t).group).toBe('DB');
    expect(editFormOf({ ...t, group: undefined }).group).toBe('');
    const ch = editChanges(t, { ...editFormOf(t), group: '' });
    expect(ch.changes.map((c) => [c.label, c.from, c.to])).toEqual([['그룹', 'DB', GROUP_NONE]]);
  });
});

describe('서버와 같은 규칙', () => {
  it('웹 GROUP_RE 는 서버 registry.js 의 GROUP_RE 와 같은 글자', () => {
    const srv = fs.readFileSync(new URL('../../../../server/src/focusmon/registry.js', import.meta.url), 'utf8');
    const m = /export const GROUP_RE = (\/.+\/[a-z]*);/.exec(srv);
    expect(m).toBeTruthy();
    expect(m[1]).toBe(String(GROUP_RE));
    for (const ok of ['DB', '백업 파일', 'web-01', 'A.b_c d', '가'.repeat(32)]) expect(GROUP_RE.test(ok)).toBe(true);
    for (const bad of ['', ' DB', '-db', '가'.repeat(33), 'a/b', 'a`b', 'a<b']) expect(GROUP_RE.test(bad)).toBe(false);
  });
});

describe('화면 소스', () => {
  const src = fs.readFileSync(new URL('./FocusMonTool.jsx', import.meta.url), 'utf8');
  const bulk = fs.readFileSync(new URL('./FocusMonBulk.jsx', import.meta.url), 'utf8');
  const fnBody = (name) => { const i = src.indexOf(`const ${name} = `); expect(i).toBeGreaterThan(0); return src.slice(i, src.indexOf('\n  };', i)); };
  it('그룹 쓰기 응답의 ok:false 를 성공으로 읽지 않는다', () => {
    for (const f of ['moveGroup', 'createGroup', 'renameGroup', 'applySuggestion']) expect(fnBody(f)).toMatch(/ok === false/);
    expect(src).toMatch(/delJson\(`\/tools\/focus-mon\/groups\/\$\{encodeURIComponent\(g\.name\)\}`\); if \(r\?\.ok === false\) return r;/);
  });
  it('그룹 이름은 경로에 넣을 때 encodeURIComponent', () => {
    const uses = src.match(/\/tools\/focus-mon\/groups\/\$\{[^}]+\}/g) || [];
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/encodeURIComponent/);
  });
  it('고른 그룹 · 보기 · 나눠 보기는 브라우저가 기억 · 다른 화면도 고른 그룹으로 거른 서버를 받는다', () => {
    expect(src).toMatch(/lsGet\('fm\.view\.group', 'all'\)/);
    expect(src).toMatch(/lsGet\('fm\.tg\.group'/);
    expect(src).toMatch(/lsGet\('fm\.ov\.split', 'flat'\)/);
    expect(src).toMatch(/<Overview main=\{main\} ids=\{shownIds\}/);
    expect(src).toMatch(/<Compare main=\{main\} ids=\{shownIds\}/);
    expect(src).toMatch(/<IostatCompare main=\{main\} ids=\{shownIds\}/);
    expect(src).toMatch(/<Procs main=\{main\} ids=\{shownIds\}/);
  });
  it('수정 저장은 그룹을 함께 보낸다 · CSV 적용은 그룹 상한 초과면 잠근다', () => {
    expect(src).toMatch(/agent: f\.agent, group: f\.group \|\| '' \}/);
    expect(bulk).toMatch(/plan\.groupsOver/);
  });
  it('화면 글에 백틱 · 대문자 변환 없음', () => {
    const css = fs.readFileSync(new URL('./focusMon.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/text-transform:\s*uppercase/);
    for (const f of [groupStartText('A', { start: ['a'], rest: ['b'] }, 1), csvGroupNote({ groupColumn: true, newGroups: ['x'] }), csvGroupNote({}), suggestionText({ moves: [{ group: 'g', ids: ['a', 'b'], names: ['a', 'b'] }] })]) expect(f).not.toMatch(/`/);
  });
});
