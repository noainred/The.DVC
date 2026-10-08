import { describe, it, expect } from 'vitest';
import { roleLabel, generatedAtText, SEARCH_PLACEHOLDER } from './headerText.js';

describe('headerText(v2.727) — 헤더 역할 표기', () => {
  it('① super_admin 은 요청 문맥 표지(superAdmin)로 판정한다 — role 원문을 보이지 않는다', () => {
    expect(roleLabel({ role: 'admin', superAdmin: true })).toBe('슈퍼 관리자');
    expect(roleLabel({ role: 'super_admin' })).toBe('super_admin'); // 접히지 않은 원문은 지어내지 않는다
  });
  it('② 데모 계정이 역할보다 먼저다', () => {
    expect(roleLabel({ role: 'admin', demoGuest: true })).toBe('데모 계정');
    expect(roleLabel({ role: 'admin', demoGuest: true, superAdmin: true })).toBe('데모 계정');
  });
  it('③ 세 역할은 한글이고 모르는 역할·빈 사용자는 원문/빈 문자열', () => {
    expect(roleLabel({ role: 'admin' })).toBe('관리자');
    expect(roleLabel({ role: 'operator' })).toBe('운영자');
    expect(roleLabel({ role: 'viewer' })).toBe('조회자');
    expect(roleLabel({ role: 'auditor' })).toBe('auditor');
    expect(roleLabel(null)).toBe('');
  });
  it('④ 수집 시각은 읽지 못하면 빈 문자열(— 를 붙이지 않는다)', () => {
    expect(generatedAtText(null)).toBe('');
    expect(generatedAtText('not-a-date')).toBe('');
    expect(generatedAtText('2026-10-08T12:46:25Z')).toMatch(/\d/);
  });
  it('⑤ 검색 문구는 VM 이름을 약속하지 않는다(팔레트는 기능·화면만 찾는다)', () => {
    expect(SEARCH_PLACEHOLDER).not.toMatch(/VM/);
  });
});
