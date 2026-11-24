/**
 * 146회차(141 결정 D2) — 키 · 비밀번호 · 물려받기 승인이 없는 예전 항목은 이제 접속하지 않고(no-cred) 수집 건강 사유가 cred-config 다.
 *   그 조치 문구가 ‘키 설정’ 만이 아니라 ‘접속 자격 없음’ 도 말해야 한다(예전 사유는 ‘인증 거부’ — 빈 비밀번호로 시도했다).
 */
import { describe, it, expect } from 'vitest';
import { REASON_TEXT } from './bmCollectText.js';

describe('146회차 결정 D2 — cred-config 조치 문구', () => {
  it('접속 자격 없음(키 · 비밀번호 · 물려받기 승인 없음)을 말하고 빈 비밀번호로 시도하지 않는다고 밝힌다 · 백틱 없음', () => {
    const a = REASON_TEXT['cred-config'].action;
    expect(a).toMatch(/접속 자격 없음\(키 · 비밀번호 · 물려받기 승인 모두 없음/);
    expect(a).toMatch(/빈 비밀번호로는 시도하지 않습니다/);
    expect(a).toMatch(/법인 사용 중지 · 폴더 · 쓸 수 있는 기능 · 퇴역 · 바꿔치기/);
    expect(a.includes('`')).toBe(false);
  });
});
