/**
 * storageListText.test.js — v2.522 회귀 고정.
 *
 * 2026-09-16 사용자 신고의 절반은 **표가 거짓말을 한 것**이었다: 법인·타입 필터로 0대가 된
 * 화면에서 표 안이 `등록된 장비가 없습니다 — "+ 장비 등록"으로 시작하세요.` 였다.
 * 42대가 등록돼 있는데. 그 문구를 믿으면 뒤이은 중복 오류는 설명이 안 된다.
 */
import { describe, it, expect } from 'vitest';
import { emptyListText, conflictText } from './storageListText.js';

describe('emptyListText', () => {
  it('진짜 등록 0대일 때만 "등록된 장비가 없습니다"', () => {
    const r = emptyListText({ registered: 0, facetOn: false, query: '' });
    expect(r.text).toContain('등록된 장비가 없습니다');
    expect(r.canClear).toBe(false);   // 풀 필터가 없다 — 버튼을 띄우면 눌러도 아무 일이 없다
  });

  it('필터로 0대면 등록 대수를 밝히고 "등록된 장비가 없습니다"라고 말하지 않는다', () => {
    const r = emptyListText({ registered: 42, facetOn: true, query: '' });
    expect(r.text).not.toContain('등록된 장비가 없습니다');
    expect(r.text).toContain('42');
    expect(r.text).toContain('필터');
    expect(r.canClear).toBe(true);
  });

  it('검색으로 0대면 검색어를 되짚어 준다', () => {
    const r = emptyListText({ registered: 42, facetOn: false, query: 'MIL-PS' });
    expect(r.text).toContain('MIL-PS');
    expect(r.text).not.toContain('등록된 장비가 없습니다');
    expect(r.canClear).toBe(true);
  });

  it('필터 + 검색이 함께면 둘 다 걸려 있다고 말한다(하나만 풀고 또 헤매지 않게)', () => {
    const r = emptyListText({ registered: 42, facetOn: true, query: 'MIL' });
    expect(r.text).toContain('MIL');
    expect(r.text).toContain('필터');
    expect(r.canClear).toBe(true);
  });

  it('필터도 검색도 없는 빈 하위 목록은 "등록이 없다"고 말하지 않는다', () => {
    const r = emptyListText({ registered: 42, facetOn: false, query: '' });
    expect(r.text).not.toContain('등록된 장비가 없습니다');
    expect(r.text).toContain('42');
    expect(r.canClear).toBe(false);
  });

  it('인자가 없어도 던지지 않는다', () => {
    expect(() => emptyListText()).not.toThrow();
  });
});

describe('conflictText', () => {
  const c = { id: 'st-a', name: 'HD-PS-1', host: '10.228.123.28', type: 'powerstore', datacenterId: 'dc-hd', agent: 'HD', enabled: true, pulled: false };

  it('충돌 장비의 이름·host·법인·수집주체를 말한다', () => {
    const t = conflictText(c, { dcName: (id) => (id === 'dc-hd' ? 'HD' : id), typeLabel: () => 'PowerStore' });
    expect(t.head).toContain('HD-PS-1');
    expect(t.head).toContain('10.228.123.28');
    expect(t.where).toContain('HD');
    expect(t.where).toContain('수집 HD');
    expect(t.where).toContain('PowerStore');
  });

  it('법인 이름을 모르면 id 를 그대로 쓴다(지어내지 않는다)', () => {
    const t = conflictText(c);   // dcName 주입 없음
    expect(t.where).toContain('dc-hd');
  });

  it('비활성·중앙 배포분을 숨기지 않는다 — "왜 목록에 안 보이지"의 답이다', () => {
    const t = conflictText({ ...c, enabled: false, pulled: true, datacenterId: '', agent: '' });
    expect(t.where).toContain('법인 미지정');
    expect(t.where).toContain('수집 중앙');
    expect(t.where).toContain('비활성');
    expect(t.where).toContain('중앙 배포분');
  });

  it('충돌 정보가 없으면 null(문장을 지어내지 않는다)', () => {
    expect(conflictText(null)).toBe(null);
  });

  it('문구에 ** 강조가 없다 — 별표로 새는 사고(v2.439/2.440/2.505) 방지', () => {
    const t = conflictText(c);
    for (const s of [t.head, t.where, t.hint]) expect(s).not.toContain('**');
  });
});
