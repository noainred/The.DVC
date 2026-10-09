import { describe, it, expect } from 'vitest';
import { policyStateText } from './secretsPolicyText.js';

// S-07(2026-10-09): 정책 파일을 못 읽은 상태를 화면이 말한다 — 정상 정책에는 아무 말도 하지 않는다.
describe('policyStateText', () => {
  it('정상 정책·빈 값은 안내 없음', () => {
    expect(policyStateText(null)).toBe(null);
    expect(policyStateText({ mode: 'plain', level: 2, algorithm: '' })).toBe(null);
    expect(policyStateText({ mode: 'encrypted', level: 3, algorithm: '' })).toBe(null);
  });
  it('잠금 — 새 비밀 저장을 막고 있다는 사실과 조치를 말한다', () => {
    const t = policyStateText({ mode: 'unavailable', locked: true, problem: 'corrupt', evidence: ['key-file'] });
    expect(t).toMatch(/손상됐습니다/);
    expect(t).toMatch(/새 비밀번호·토큰 저장을 막고/);
    expect(t).toMatch(/직접 골라 저장/);
    expect(t).not.toMatch(/평문 저장 중/);
  });
  it('복구값 — 어디서 복구했는지와 지금 방식을 말한다(평문으로 내려갔다고 말하지 않는다)', () => {
    expect(policyStateText({ mode: 'encrypted', recovered: 'trusted-copy', problem: 'missing' })).toMatch(/신뢰 사본.*암호화 저장 중/);
    expect(policyStateText({ mode: 'encrypted', recovered: 'last-good', problem: 'invalid' })).toMatch(/내용이 올바르지 않습니다.*직전 유효 정책으로 계속 암호화/);
    expect(policyStateText({ mode: 'plain', recovered: 'trusted-copy', problem: 'missing' })).toMatch(/평문 저장 중/);
  });
  it('백틱·강조 표기(**)를 쓰지 않는다(화면에 글자로 샌다)', () => {
    for (const p of [{ locked: true, problem: 'missing' }, { mode: 'encrypted', recovered: 'last-good', problem: 'corrupt' }]) {
      expect(policyStateText(p)).not.toMatch(/`|\*\*/);
    }
  });
});
