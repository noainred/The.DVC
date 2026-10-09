// 검토 I-02(그룹 B) — VM 목록 서버 페이지 문구·판정(vmPageText.js).
import { describe, it, expect } from 'vitest';
import { VM_PAGE_SIZE, vmPageQueryKey, cursorErrorKind, resetNoticeText, pageNavState, vmPageSummary, vmPageSortNote, navView, navNext, navPrev, navFirst, navAfterError } from './vmPageText.js';

const items = (n) => Array.from({ length: n }, (_, i) => ({ id: `vc1:vm-${i}` }));

describe('vmPageText', () => {
  it('페이지 크기는 서버 상한(5,000)보다 작다 — 전량을 한 번에 그리지 않는다', () => {
    expect(VM_PAGE_SIZE).toBeGreaterThan(0);
    expect(VM_PAGE_SIZE).toBeLessThan(5000);
  });

  it('조건 키 — 필터 순서와 무관 · GPU 선택이 바뀌면 다르다', () => {
    expect(vmPageQueryKey({ a: '1', b: '2' }, false, '')).toBe(vmPageQueryKey({ b: '2', a: '1' }, false, ''));
    expect(vmPageQueryKey({}, false, '')).not.toBe(vmPageQueryKey({}, true, ''));
    expect(vmPageQueryKey({}, true, 'vgpu')).not.toBe(vmPageQueryKey({}, true, ''));
    expect(vmPageQueryKey(null, false, '')).toBe(vmPageQueryKey({}, false, ''));
  });

  it('커서 오류 종류 — 409 만료와 400 거절을 구분 · 다른 오류는 null', () => {
    expect(cursorErrorKind('cursor-stale')).toBe('stale');
    expect(cursorErrorKind({ message: 'cursor-stale' })).toBe('stale');
    for (const c of ['cursor-invalid', 'cursor-sort-mismatch', 'cursor-query-mismatch']) expect(cursorErrorKind(c)).toBe('invalid');
    for (const c of [null, '', 'forbidden', '/vms -> 500', 'bad-sort']) expect(cursorErrorKind(c)).toBe(null);
    expect(resetNoticeText('stale')).toMatch(/첫 페이지/);
    expect(resetNoticeText('invalid')).toMatch(/첫 페이지/);
    expect(resetNoticeText(null)).toBe('');
  });

  it('이전·다음 상태 — 다음은 hasMore 이고 커서가 있을 때만', () => {
    expect(pageNavState([], { hasMore: true, nextCursor: 'abc' })).toMatchObject({ pageNo: 1, canPrev: false, canFirst: false, canNext: true, nextCursor: 'abc' });
    expect(pageNavState(['x'], { hasMore: false, nextCursor: null })).toMatchObject({ pageNo: 2, canPrev: true, canNext: false });
    expect(pageNavState([], { hasMore: true, nextCursor: null }).canNext).toBe(false); // 예전 응답(커서 없음)은 다음을 약속하지 않는다
    expect(pageNavState(undefined, null)).toMatchObject({ pageNo: 1, canNext: false });
  });

  it('요약 — 몇 개를 보고 있는지 · 전체 몇 개 · 순서상 위치', () => {
    const s = vmPageSummary({ total: 6001, items: items(1000), hasMore: true, snapshotAt: 'T1', page: { start: 1000, next: 2000, size: 1000, orderTotal: 6001, remaining: 4001, vanished: 0, added: 0, orderAsOf: 'T1' } });
    expect(s.head).toBe('1,000개 표시 (순서상 1,001–2,000번째 / 6,001) · 전체 6,001개');
    expect(s.notes).toEqual(['아직 4,001개가 더 있습니다 — 다음 페이지로 이어 보세요.']);
  });

  it('요약 — 건너뛴 것·새로 생긴 것·순서 기준 시점을 숨기지 않는다', () => {
    const s = vmPageSummary({ total: 5990, items: items(1000), snapshotAt: 'T2', page: { start: 1000, next: 2003, size: 1000, orderTotal: 6001, remaining: 0, vanished: 3, added: 25, orderAsOf: 'T1' } });
    expect(s.notes.join(' ')).toMatch(/3개는 건너뛰었습니다/);
    expect(s.notes.join(' ')).toMatch(/25개는 이 순회에 없습니다/);
    expect(s.notes.join(' ')).toMatch(/첫 페이지를 받은 시점 기준/);
    expect(s.notes.join(' ')).not.toMatch(/더 있습니다/);
  });

  it('요약 — 페이지 정보가 없는 예전 응답·빈 결과·값 없음은 0 이나 null 을 지어내지 않는다', () => {
    expect(vmPageSummary({ total: 6001, items: items(5000) }).head).toMatch(/6,001개 중 5,000개만/);
    expect(vmPageSummary({ total: 10, items: items(10) }).head).toBe('전체 10개를 모두 표시합니다.');
    expect(vmPageSummary({ total: 0, items: [], page: { start: 0, next: 0 } }).head).toBe('조건에 맞는 VM 이 없습니다.');
    const odd = vmPageSummary({ total: null, items: items(2), page: {} });
    expect(odd.head).not.toMatch(/null|undefined|NaN/);
    expect(odd.notes).toEqual([]);
  });

  it('정렬 안내 — 나눠 받을 때만 · 백틱 없음', () => {
    expect(vmPageSortNote({ hasMore: false, page: { start: 0, size: 1000 } })).toBe('');
    expect(vmPageSortNote({ hasMore: true, page: { start: 0, size: 1000 } })).toMatch(/1,000개씩 나눠 받습니다/);
    expect(vmPageSortNote({ hasMore: false, page: { start: 1000, size: 1000 } })).toMatch(/나눠 받습니다/); // 마지막 페이지에서도
    for (const t of [vmPageSortNote({ hasMore: true, page: { start: 0, size: 1000 } }), resetNoticeText('stale'), vmPageSummary({ total: 5, items: items(5), page: { start: 0, next: 5, added: 1, vanished: 1, orderAsOf: 'a' }, snapshotAt: 'b' }).notes.join('')]) {
      expect(t).not.toMatch(/`/);
    }
  });

  it('페이지 이동 전이 — 조건이 바뀌면 첫 페이지 · 커서 오류는 한 번만 첫 페이지로', () => {
    const K = 'k1';
    let nav = navFirst(K);
    expect(navView(nav, K)).toEqual({ stack: [], notice: null });
    nav = navNext(nav, K, 'c1');
    nav = navNext(nav, K, 'c2');
    expect(navView(nav, K).stack).toEqual(['c1', 'c2']);
    expect(navNext(nav, K, '').stack).toEqual(['c1', 'c2']);              // 빈 커서는 쌓지 않는다
    expect(navView(nav, 'k2').stack).toEqual([]);                           // 필터가 바뀌면 첫 페이지
    expect(navPrev(nav, K).stack).toEqual(['c1']);
    // 만료(409) — 첫 페이지 + 안내
    const r = navAfterError(nav, K, 'cursor-stale');
    expect(r).toEqual({ key: K, stack: [], notice: 'stale' });
    expect(navView(r, K).notice).toBe('stale');
    expect(navAfterError(r, K, 'cursor-stale')).toBe(null);                 // 첫 페이지에서는 되돌릴 것이 없다(무한 반복 금지)
    expect(navAfterError(nav, K, 'cursor-query-mismatch')).toMatchObject({ notice: 'invalid' });
    expect(navAfterError(nav, K, '/vms -> 500')).toBe(null);                // 일반 오류는 페이지를 유지(배너로 말한다)
    expect(navView(navNext(r, K, 'c9'), K).notice).toBe(null);              // 이동하면 안내는 사라진다
  });
});
