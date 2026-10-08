import { describe, it, expect } from 'vitest';
import { readHides, isHidden, visibleNotices, withHidden, writeHides, timeText, windowText, noticeState, toLocalInput, fromLocalInput, HIDE_KEY, HIDE_MAX, threadComments, likersText, applyLike } from './bulletinText.js';

const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };
const N = (rev, extra = {}) => ({ id: rev.split(':')[0], rev, title: rev, ...extra });

describe('접속 공지 숨김', () => {
  it('오늘 하루는 그날만, 다시 보지 않기는 그 판만 숨긴다', () => {
    const h = withHidden({}, ['a:1'], 'today', ['a:1', 'b:1'], '2026-10-08');
    expect(isHidden(N('a:1'), h, '2026-10-08')).toBe(true);
    expect(isHidden(N('a:1'), h, '2026-10-09')).toBe(false);
    const f = withHidden(h, ['b:1'], 'forever', ['a:1', 'b:1'], '2026-10-08');
    expect(isHidden(N('b:1'), f, '2030-01-01')).toBe(true);
    // 관리자가 고치면 rev 가 바뀌어 다시 보인다.
    expect(isHidden(N('b:2'), f, '2030-01-01')).toBe(false);
  });
  it('지금 목록에 없는 옛 판은 지우고 상한을 둔다', () => {
    const h = withHidden({ 'old:1': 'forever', 'a:1': 'forever' }, [], 'today', ['a:1']);
    expect(Object.keys(h)).toEqual(['a:1']);
    const many = Array.from({ length: HIDE_MAX + 20 }, (_, i) => `n${i}:1`);
    expect(Object.keys(withHidden({}, many, 'forever', many)).length).toBe(HIDE_MAX);
  });
  it('저장소가 깨졌거나 던져도 숨김 없이 보인다', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readHides(bad)).toEqual({});
    expect(writeHides(bad, {})).toBe(false);
    const s = mem(); s.setItem(HIDE_KEY, '[1,2]');
    expect(readHides(s)).toEqual({});
    s.setItem(HIDE_KEY, '{깨짐');
    expect(readHides(s)).toEqual({});
    expect(visibleNotices([N('a:1'), null, { title: 'rev 없음' }], {}, '2026-10-08').map((n) => n.rev)).toEqual(['a:1']);
  });
  it('빈 날짜로는 오늘 숨김이 성립하지 않는다', () => {
    expect(isHidden(N('a:1'), { 'a:1': '' }, '')).toBe(false);
  });
});

describe('공지 표기', () => {
  it('값이 없으면 단위·날짜를 지어내지 않는다', () => {
    expect(timeText(null)).toBe('—');
    expect(timeText('')).toBe('—');
    expect(timeText('abc')).toBe('—');
    expect(windowText({})).toBe('기간 제한 없음');
    expect(toLocalInput(null)).toBe('');
    expect(fromLocalInput('')).toBe(null);
    expect(fromLocalInput('nope')).toBe(null);
  });
  it('입력 왕복', () => {
    const t = new Date(2026, 9, 8, 9, 5).getTime();
    expect(fromLocalInput(toLocalInput(t))).toBe(t);
    expect(timeText(t)).toBe('2026-10-08 09:05');
  });
  it('상태: 꺼짐 > 예정 > 종료 > 노출 중', () => {
    const now = 1000;
    expect(noticeState({ enabled: false, startAt: 2000 }, now).key).toBe('off');
    expect(noticeState({ startAt: 2000 }, now).key).toBe('scheduled');
    expect(noticeState({ endAt: 1000 }, now).key).toBe('ended');
    expect(noticeState({ startAt: 500, endAt: 2000 }, now).key).toBe('live');
  });
});

describe('답글·공감(v2.723)', () => {
  it('최상위 댓글 아래에 답글을 작성 순으로 묶고, 부모 없는 답글은 버리지 않는다', () => {
    const t = threadComments([
      { id: 'r2', parentId: 'a', createdAt: 5 },
      { id: 'a', createdAt: 1 },
      { id: 'b', createdAt: 3 },
      { id: 'r1', parentId: 'a', createdAt: 2 },
      { id: 'o', parentId: 'gone', createdAt: 4 },
      null,
    ]);
    expect(t.map((x) => x.c.id)).toEqual(['a', 'b', 'o']);
    expect(t[0].replies.map((c) => c.id)).toEqual(['r1', 'r2']);
    expect(t[2].orphan).toBe(true);
    expect(threadComments(undefined)).toEqual([]);
  });
  it('공감 툴팁은 0명·외 N명을 말한다', () => {
    expect(likersText({ likeCount: 0 })).toBe('아직 공감한 사람이 없습니다');
    expect(likersText({})).toBe('아직 공감한 사람이 없습니다');
    expect(likersText({ likeCount: 2, likers: ['a', 'b'] })).toBe('공감: a, b');
    expect(likersText({ likeCount: 32, likers: ['a', 'b'] })).toBe('공감: a, b 외 30명');
  });
  it('공감 응답을 글·댓글에 반영한다', () => {
    const p = { id: 'p', likeCount: 0, comments: [{ id: 'c', likeCount: 0 }, { id: 'd', likeCount: 3 }] };
    const r = { likeCount: 1, liked: true, likers: ['me'] };
    expect(applyLike(p, null, r).likeCount).toBe(1);
    const q = applyLike(p, 'c', r);
    expect(q.comments[0]).toMatchObject({ likeCount: 1, liked: true });
    expect(q.comments[1].likeCount).toBe(3);
    expect(p.comments[0].likeCount).toBe(0);
  });
});

/* ── v2.727(감사 B-01 · E-02 · E-05 · E-08) ─────────────────────────────────────── */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLatest, saveFailText, boardFullText, mbText } from './bulletinText.js';
import { stripComments } from '../../test/_stripComments.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (rel) => stripComments(fs.readFileSync(path.resolve(HERE, rel), 'utf8'));

describe('v2.727 게시판 — 상한 문구 · 최신 응답 가드 · 화면 배선', () => {
  it('B-01: 서버 409 board-full 은 용량·현재 크기·저장 안 됨·조치를 말하는 문장이 된다(사유 코드를 그대로 보이지 않는다)', () => {
    const t = saveFailText({ ok: false, reason: 'board-full', bytes: 16_700_000, max: 16 * 1048576 });
    expect(t).toBe(boardFullText({ bytes: 16_700_000, max: 16 * 1048576 }));
    expect(t).toContain('16.0 MB');
    expect(t).toContain('15.9 MB');
    expect(t).toContain('저장되지 않았습니다');
    expect(t).not.toContain('board-full');
    expect(t).not.toContain('`');
    // 다른 사유는 예전 그대로
    expect(saveFailText({ reason: '게시글은 2000개까지입니다' })).toBe('저장하지 못했습니다 — 게시글은 2000개까지입니다');
    expect(saveFailText(null)).toBe('저장하지 못했습니다.');
    // 값이 없으면 0 MB 가 아니라 —
    expect(mbText(null)).toBe('—');
    expect(mbText('')).toBe('—');
    expect(boardFullText({})).toContain('상한(—)');
  });
  it('E-02: makeLatest — 늦게 온 이전 응답은 버리고, 언마운트(invalidate) 뒤에는 어느 응답도 반영하지 않는다', () => {
    const g = makeLatest();
    const a = g.next();           // 새로고침(지연)
    const b = g.next();           // 검색어 변경
    expect(g.isLatest(b)).toBe(true);
    expect(g.isLatest(a)).toBe(false); // A 가 B 뒤에 도착해도 버린다
    g.invalidate();
    expect(g.isLatest(b)).toBe(false);
    const c = g.next();
    expect(g.isLatest(c)).toBe(true);
  });
  it('E-02/E-08 배선: Board.jsx 의 load() 셋은 전부 세대 가드이고(alive 플래그 0건), 글 수정 폼에도 limits 가 간다', () => {
    const s = src('./Board.jsx');
    expect((s.match(/let alive = true/g) || []).length).toBe(0);
    expect((s.match(/useLatest\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
    expect((s.match(/latest\.isLatest\(k\)/g) || []).length).toBeGreaterThanOrEqual(6);
    // PostDetail 안의 수정 폼: initial={post} 와 limits={limits} 가 같은 PostEditor 에 있다
    const m = s.match(/<PostEditor initial=\{post\}[^>]*>/);
    expect(m, 'PostDetail 의 수정 폼').toBeTruthy();
    expect(m[0]).toContain('limits={limits}');
    expect(s).toMatch(/function PostDetail\(\{[^}]*\blimits\b/);
  });
  it('E-05: .board-pinned 는 실제 CSS 규칙을 가진다(죽은 클래스 금지)', () => {
    const css = fs.readFileSync(path.resolve(HERE, '../../styles.css'), 'utf8');
    expect(css).toMatch(/\.board-pinned\s*>\s*td\s*\{[^}]*--amber/);
    expect(src('./Board.jsx')).toContain("'board-pinned'");
  });
});
