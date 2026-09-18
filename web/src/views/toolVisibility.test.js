import { describe, it, expect } from 'vitest';
import { toolHidden, visibleTools } from './toolVisibility.js';

const T = [
  { k: 'storage-mon', adminOnly: true },
  { k: 'ipam' },
  { k: 'ping' },
];

describe('toolVisibility (v2.555)', () => {
  it('admin 은 무엇도 숨기지 않는다', () => {
    for (const t of T) expect(toolHidden(t, { isAdmin: true, toolsAllowed: [], hideAdminOnly: true })).toBe(false);
  });

  it('거부 목록 모드에서는 기존 정책을 유지한다 — 카드 그리드는 회색 잠금(숨기지 않음)', () => {
    expect(toolHidden(T[1], { toolsAllowed: null, hideAdminOnly: false })).toBe(false);
    expect(toolHidden(T[0], { toolsAllowed: null, hideAdminOnly: false })).toBe(false); // adminOnly 도 그리드에서는 보인다
  });

  it('거부 목록 모드에서 V4 내비·팔레트는 관리자 전용을 숨긴다(기존 동작)', () => {
    expect(toolHidden(T[0], { toolsAllowed: null, hideAdminOnly: true })).toBe(true);
    expect(toolHidden(T[1], { toolsAllowed: null, hideAdminOnly: true })).toBe(false);
  });

  it('허용 목록 모드 — 목록 밖은 숨기고, 목록 안이면 adminOnly 표시 관례도 넘긴다', () => {
    const opt = { toolsAllowed: ['storage-mon'], hideAdminOnly: true };
    expect(toolHidden(T[0], opt)).toBe(false);   // 관리자가 명시했다
    expect(toolHidden(T[1], opt)).toBe(true);
    expect(visibleTools(T, opt).map((t) => t.k)).toEqual(['storage-mon']);
  });

  it('허용 목록이 빈 배열이면 전부 숨긴다 — 빈 배열을 "제한 없음" 으로 읽지 않는다', () => {
    expect(visibleTools(T, { toolsAllowed: [] })).toEqual([]);
  });
});

describe('gridIntro (v2.555) — 없는 안내를 하지 않는다', () => {
  it('허용 목록 모드에서는 "회색 카드" 안내를 쓰지 않는다(숨겨서 회색 카드가 없다)', async () => {
    const { gridIntro } = await import('./toolVisibility.js');
    const t = gridIntro({ toolsAllowed: ['storage-mon'], shownCount: 1 });
    expect(t).not.toContain('회색');
    expect(t).toContain('1개');
  });
  it('허용 0개면 "없습니다" 와 조치를 말한다', async () => {
    const { gridIntro } = await import('./toolVisibility.js');
    const t = gridIntro({ toolsAllowed: [], shownCount: 0 });
    expect(t).toContain('없습니다');
    expect(t).toContain('사용자 관리');
  });
  it('재정의가 없거나 admin 이면 기존 문구를 그대로 쓴다(회귀 없음)', async () => {
    const { gridIntro } = await import('./toolVisibility.js');
    expect(gridIntro({ toolsAllowed: null, shownCount: 80 })).toContain('회색 카드');
    expect(gridIntro({ isAdmin: true, toolsAllowed: [], shownCount: 80 })).toContain('회색 카드');
  });
  it('문구에 백틱이 없다(v2.553 규약)', async () => {
    const { gridIntro } = await import('./toolVisibility.js');
    for (const o of [{ toolsAllowed: null }, { toolsAllowed: [] }, { toolsAllowed: ['a'], shownCount: 1 }]) {
      expect(gridIntro(o)).not.toContain('`');
    }
  });
});
