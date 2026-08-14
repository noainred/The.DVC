// permMatrixOps 단위테스트(v2.295, 3차 모듈화 감사 확정 #6) — 권한 매트릭스의
// '거부목록(toolsDenied) 반전 의미론'을 고정한다: 목록에 있으면 거부, 없으면 허용.
// UI 체크박스는 반대로 '체크=허용'으로 보여주므로 이 반전이 어긋나면 관리자가
// '허용으로 보이는데 실제 거부'인 매트릭스를 저장하게 된다 — 현재 동작 그대로 고정.
import { describe, it, expect } from 'vitest';
import { hasMatrixKey, toggleMatrixKey, isToolAllowed, toggleToolDenied, setAllToolsDenied } from './permMatrixOps.js';

const MX = () => ({
  operator: ['tools', 'insights'],
  viewer: ['insights'],
  toolsDenied: { operator: ['gpu'], viewer: ['gpu', 'ipam'] },
});

describe('hasMatrixKey / toggleMatrixKey — 기능 권한', () => {
  it('보유 판정 + 결측 matrix(로드 전) 안전', () => {
    expect(hasMatrixKey(MX(), 'operator', 'tools')).toBe(true);
    expect(hasMatrixKey(MX(), 'viewer', 'tools')).toBe(false);
    expect(hasMatrixKey(null, 'viewer', 'tools')).toBe(false);
    expect(hasMatrixKey({}, 'viewer', 'tools')).toBe(false);
  });
  it('토글은 새 matrix 반환(원본 불변) — 추가/제거 왕복', () => {
    const m0 = MX();
    const m1 = toggleMatrixKey(m0, 'viewer', 'tools');
    expect(m1.viewer).toContain('tools');
    expect(m0.viewer).not.toContain('tools');          // 원본 불변(React 상태 규칙)
    const m2 = toggleMatrixKey(m1, 'viewer', 'tools');
    expect(m2.viewer).not.toContain('tools');
    expect(m2.operator).toEqual(m0.operator);          // 다른 역할 불변
  });
});

describe('isToolAllowed — ⚠ 거부목록 반전: 목록에 없으면 허용', () => {
  it('거부목록에 있으면 false, 없으면 true', () => {
    expect(isToolAllowed(MX(), 'operator', 'gpu')).toBe(false);   // denied 목록에 있음 → 거부
    expect(isToolAllowed(MX(), 'operator', 'ipam')).toBe(true);   // 목록에 없음 → 허용
    expect(isToolAllowed(MX(), 'viewer', 'ipam')).toBe(false);
  });
  it('결측(toolsDenied 없음/matrix 없음)이면 전부 허용 — 기본 개방(서버가 최종 강제)', () => {
    expect(isToolAllowed({}, 'viewer', 'gpu')).toBe(true);
    expect(isToolAllowed(null, 'viewer', 'gpu')).toBe(true);
  });
});

describe('toggleToolDenied — 거부 토글(반전 모델)', () => {
  it('목록에 있으면 제거(=허용), 없으면 추가(=거부) — 원본 불변·타 역할 불변', () => {
    const m0 = MX();
    const m1 = toggleToolDenied(m0, 'operator', 'gpu');   // 거부 해제
    expect(isToolAllowed(m1, 'operator', 'gpu')).toBe(true);
    expect(isToolAllowed(m0, 'operator', 'gpu')).toBe(false);   // 원본 불변
    expect(m1.toolsDenied.viewer).toEqual(m0.toolsDenied.viewer); // viewer 불변
    const m2 = toggleToolDenied(m1, 'operator', 'gpu');   // 다시 거부
    expect(isToolAllowed(m2, 'operator', 'gpu')).toBe(false);
  });
  it('toolsDenied 결측에서도 동작(빈 목록에서 시작)', () => {
    const m = toggleToolDenied({ operator: [], viewer: [] }, 'viewer', 'gpu');
    expect(m.toolsDenied.viewer).toEqual(['gpu']);
    expect(m.toolsDenied.operator).toEqual([]);
  });
});

describe('setAllToolsDenied — 전체 허용/차단', () => {
  const KEYS = ['gpu', 'ipam', 'hw'];
  it('허용=거부목록 비움 · 차단=deniableKeys 전부 거부(타 역할 불변)', () => {
    const allow = setAllToolsDenied(MX(), 'viewer', true, KEYS);
    expect(allow.toolsDenied.viewer).toEqual([]);
    expect(allow.toolsDenied.operator).toEqual(['gpu']);   // operator 불변
    const deny = setAllToolsDenied(MX(), 'viewer', false, KEYS);
    expect(deny.toolsDenied.viewer).toEqual(KEYS);
  });
});
