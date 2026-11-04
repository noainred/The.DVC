/**
 * wikiText.test.js — 위키 화면 판정 함수(v2.881): 주소 · 나무 · 상위 문서 선택지 · 문서 참조 · 템플릿 · 숫자 타일 · 바로 가기 · 초안 저장소.
 */
import { describe, it, expect } from 'vitest';
import {
  parseWikiHash, wikiHash, buildTree, flattenTree, parentOptions, breadcrumb, resolvePageRef, fillTemplate, countTiles, numText,
  quickHref, quickLinksToText, textToQuickLinks, wikiSaveFailText, isConflict, draftKey, loadDraft, saveDraft, clearDraft, diffSummary, searchSummary,
  slashQuery, filterSlash, applySlash, SLASH_COMMANDS,
} from './wikiText.js';

const P = (id, parentId = '', extra = {}) => ({ id, parentId, title: `문서 ${id}`, order: Number(id.slice(1)), status: 'approved', spaceId: 'pub', ...extra });

describe('주소', () => {
  it('콜론 · 슬래시가 든 스페이스 id 도 왕복한다', () => {
    for (const space of ['pub', 'vc:seoul:01', 'a/b c']) {
      for (const r of [{ space }, { space, view: 'search', params: { q: '장애 대응' } }, { space, id: 'W12' }, { space, id: 'W12', view: 'edit' }, { space, id: 'W12', view: 'history' }, { space, view: 'new', params: { parent: 'W3' } }]) {
        const back = parseWikiHash(wikiHash(r));
        expect(back.space).toBe(space);
        expect(back.id).toBe(r.id || '');
        expect(back.view).toBe(r.view || (r.id ? 'page' : 'home'));
        if (r.params) expect(back.params).toMatchObject(r.params);
      }
    }
  });
  it('모르는 보기 · 잘못된 id · 깨진 인코딩은 대문으로', () => {
    expect(parseWikiHash('#/wiki/pub/xyz').view).toBe('home');
    expect(parseWikiHash('#/wiki/pub/W12x').view).toBe('home');
    expect(parseWikiHash('#/wiki/%E0%A4%A').space).toBe('');
    expect(parseWikiHash('#/issues/board')).toMatchObject({ space: '', view: 'home' });
  });
  it('모르는 쿼리 키는 버린다', () => {
    expect(parseWikiHash('#/wiki/pub/search?q=a&evil=1').params).toEqual({ q: 'a' });
  });
});

describe('나무', () => {
  const pages = [P('W1'), P('W2', 'W1'), P('W3', 'W2'), P('W4', 'W9'), P('W5')];
  it('부모를 못 찾은 문서는 맨 위로(숨기지 않는다) · 순서는 order', () => {
    const rows = flattenTree(buildTree(pages));
    expect(rows.map((r) => [r.page.id, r.depth])).toEqual([['W1', 1], ['W2', 2], ['W3', 3], ['W4', 1], ['W5', 1]]);
    expect(flattenTree(buildTree(pages), new Set(['W1'])).map((r) => r.page.id)).toEqual(['W1', 'W4', 'W5']);
  });
  it('자기 자신을 부모로 둔 고리도 끝난다', () => {
    expect(flattenTree(buildTree([P('W1', 'W1')])).length).toBe(1);
  });
  it('상위 문서 선택지 — 자기 · 자기 아래 제외, 3단계를 넘지 않는 곳만', () => {
    expect(parentOptions(pages).map((o) => o.value)).toEqual(['', 'W1', 'W2', 'W4', 'W5']); // W3 아래는 4단계
    expect(parentOptions(pages, 'W2').map((o) => o.value)).toEqual(['', 'W1', 'W4', 'W5']); // W2(높이 2)는 1단계 아래에만
    expect(parentOptions(pages, 'W1').map((o) => o.value)).toEqual(['']); // W1(높이 3)은 맨 위에만
  });
  it('빵 부스러기', () => {
    expect(breadcrumb(pages, 'W3').map((p) => p.id)).toEqual(['W1', 'W2', 'W3']);
  });
  it('문서 참조 — W번호 · 제목(대소문자 무시 · 같은 스페이스 우선)', () => {
    const list = [P('W1', '', { title: 'Runbook', spaceId: 'vc1' }), P('W2', '', { title: 'runbook', spaceId: 'pub' })];
    expect(resolvePageRef('W1', list).id).toBe('W1');
    expect(resolvePageRef('RUNBOOK', list, 'pub').id).toBe('W2');
    expect(resolvePageRef('없는 문서', list)).toBe(null);
  });
});

describe('문구', () => {
  it('템플릿 {{issue}} — 키 형식만 채운다', () => {
    expect(fillTemplate('관련: {{issue}} / {{issue}}', 'ISS-7')).toBe('관련: ISS-7 / ISS-7');
    expect(fillTemplate('관련: {{issue}}', '<b>')).toBe('관련: ');
  });
  it('숫자 타일 — 못 읽은 값은 0 이 아니라 —', () => {
    const t = countTiles({ pages: 3, changed7d: null }, { me: '' });
    expect(t.find((x) => x.k === 'pages').value).toBe(3);
    expect(numText(t.find((x) => x.k === 'changed7d').value)).toBe('—');
    expect(t.find((x) => x.k === 'myDrafts').value).toBe(null); // 로그인 이름이 없으면 내 초안을 지어내지 않는다
    expect(numText(0)).toBe('0');
  });
  it('바로 가기 — 포탈 주소는 같은 창, http(s) 는 새 창, 나머지는 거절', () => {
    expect(quickHref('#/issues/board')).toEqual({ href: '#/issues/board', ext: false });
    expect(quickHref('https://x.example')).toEqual({ href: 'https://x.example', ext: true });
    expect(quickHref('javascript:alert(1)')).toBe(null);
    const list = [{ title: '보드', href: '#/issues/board', desc: '' }, { title: '런북', href: '#/wiki/pub/W1', desc: '처음 | 볼 것' }];
    expect(textToQuickLinks(quickLinksToText(list))).toEqual(list);
  });
  it('저장 실패 · 충돌', () => {
    expect(wikiSaveFailText({ ok: false, reason: 'wiki-full', bytes: 9 * 1048576, max: 8 * 1048576 })).toContain('8.0 MB');
    const c = { ok: false, code: 'conflict', current: { version: 5, by: 'kim', at: Date.now() } };
    expect(isConflict(c)).toBe(true);
    expect(wikiSaveFailText(c)).toContain('v5');
    expect(isConflict({ ok: true })).toBe(false);
  });
  it('비교 · 찾기 요약', () => {
    expect(diffSummary({ from: { v: 1 }, to: { v: 3 }, added: 2, removed: 1, truncated: false })).toBe('v1 → v3: 2줄 더함 · 1줄 뺌');
    expect(diffSummary({ from: { v: 1 }, to: { v: 3 }, added: 2, removed: 1, truncated: true })).toContain('문서가 커서');
    expect(searchSummary({ total: 80, rows: new Array(50), limit: 50 }, 'a')).toContain('80건 중 50건');
  });
});

describe('초안 저장소 — 이 브라우저에만, 못 쓰면 조용히 넘어간다', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
  it('저장 · 읽기 · 지우기', () => {
    const st = mem();
    const k = draftKey('vc:1', 'W3');
    expect(saveDraft(k, { body: '본문', baseVersion: 2 }, st)).toBe(true);
    expect(loadDraft(k, st)).toMatchObject({ body: '본문', baseVersion: 2 });
    clearDraft(k, st);
    expect(loadDraft(k, st)).toBe(null);
  });
  it('저장소가 던지거나 깨진 값이면 null', () => {
    const boom = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('quota'); }, removeItem: () => { throw new Error('x'); } };
    expect(loadDraft('k', boom)).toBe(null);
    expect(saveDraft('k', { body: 'x' }, boom)).toBe(false);
    expect(() => clearDraft('k', boom)).not.toThrow();
    const st = mem(); st.setItem('k', '{깨짐'); expect(loadDraft('k', st)).toBe(null);
    st.setItem('k', JSON.stringify({ body: 3 })); expect(loadDraft('k', st)).toBe(null);
  });
});

describe('v2.886 슬래시 명령', () => {
  it('줄 머리의 /낱말만 명령이다(주소 · 경로의 / 는 아니다)', () => {
    expect(slashQuery('/', 1)).toEqual({ start: 0, q: '' });
    expect(slashQuery('글\n  /표', 6)).toEqual({ start: 4, q: '표' });
    expect(slashQuery('https://a/b', 11)).toBe(null);
    expect(slashQuery('a /b', 4)).toBe(null);
    expect(slashQuery('/a b', 4)).toBe(null, '공백이 들어가면 끝');
    expect(slashQuery(`${' '.repeat(50)}/x`, 52)).toBe(null, '40자 넘게 훑지 않는다');
  });
  it('거르기 — 앞부분이 맞는 것 먼저 · 영어 별칭', () => {
    expect(filterSlash('').length).toBe(SLASH_COMMANDS.length);
    expect(filterSlash('표')[0].k).toBe('table');
    expect(filterSlash('warn')[0].k).toBe('warn');
    expect(filterSlash('콜아웃').map((c) => c.k)).toEqual(['info', 'warn', 'danger', 'tip']);
    expect(filterSlash('없는말')).toEqual([]);
  });
  it('적용 — /낱말 자리를 바꾸고 커서를 스니펫 안에 둔다', () => {
    const t = SLASH_COMMANDS.find((c) => c.k === 'task');
    expect(applySlash('앞\n/체크뒤', 5, t)).toEqual({ body: '앞\n- [ ] 뒤', caret: 8 });
    const code = SLASH_COMMANDS.find((c) => c.k === 'code');
    const r = applySlash('/code', 5, code);
    expect(r.body).toBe('```bash\n\n```');
    expect(r.caret).toBe(8);
    const today = SLASH_COMMANDS.find((c) => c.k === 'today');
    expect(applySlash('/오늘', 3, today, new Date(2026, 10, 4))).toEqual({ body: '2026-11-04', caret: 10 });
    expect(applySlash('글', 1, t)).toBe(null);
  });
});

describe('v2.887 당번 표', () => {
  it('글 ↔ 표 · 끝을 비우면 하루 · 못 읽은 줄 번호', async () => {
    const { oncallToText, textToOncall, oncallRange } = await import('./wikiText.js');
    const { rows, bad } = textToOncall('kim | 2026-11-03 | 2026-11-09 | 야간\nlee | 2026-11-10\n이상한 줄\npark | 2026-11-09 | 2026-11-01');
    expect(rows).toEqual([{ who: 'kim', from: '2026-11-03', to: '2026-11-09', note: '야간' }, { who: 'lee', from: '2026-11-10', to: '2026-11-10', note: '' }]);
    expect(bad).toEqual([3, 4]);
    expect(oncallToText(rows)).toBe('kim | 2026-11-03 | 2026-11-09 | 야간\nlee | 2026-11-10');
    expect(oncallRange(rows[0])).toBe('11월 3일 ~ 11월 9일');
    expect(oncallRange(rows[1])).toBe('11월 10일');
  });
});
