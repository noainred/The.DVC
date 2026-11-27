// 랙 실장도 3회차 점검(2026-11-26 · 2회차 뒤 다시 쓴 코드의 변이 70건 중 살아남은 26건을 막는 테스트 — 테스트 이름의 번호가 그 변이).
// 랙 실장도 3회차 점검(2026-11-26 · 테스트 공백 축) 탐침 — defaultLabelOf 의 IPv6 판정 경계(콜론 2개 이상)
import { describe, it, expect } from 'vitest';
import * as V from './rackView.js';

describe('랙 실장도 3회차 탐침', () => {
  it('W02: 16진 글자로만 된 호스트 이름 + 포트(콜론 하나)는 IPv6 리터럴이 아니다 — 기본 표시 이름으로 채운다', () => {
    expect(V.defaultLabelOf({ name: 'ad01.dc1:443' })).toBe('ad01.dc1:443');
    expect(V.defaultLabelOf({ name: 'cafe:8443' })).toBe('cafe:8443');
    expect(V.defaultLabelOf({ name: 'fd00::1' })).toBe('');
    expect(V.defaultLabelOf({ name: '[2001:db8::10]:443' })).toBe('');
  });
});
