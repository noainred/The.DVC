import { describe, it, expect } from 'vitest';
import { vmOnText, alarmText } from './worldMapText.js';

// 2차 공통 기능 점검 8회차: 연결 끊긴 vCenter 를 'VM - (0 on)' · '위험 0 · 경고 0'(알람 없음)으로 보였다.
describe('worldMapText', () => {
  it('지표가 없으면 —', () => {
    expect(vmOnText(undefined)).toBe('—');
    expect(vmOnText({})).toBe('—');
    expect(alarmText({})).toBe('—');
    expect(alarmText(null)).toBe('—');
  });
  it('값은 그대로 · 0 은 값', () => {
    expect(vmOnText({ vms: 120, vmsPoweredOn: 0 })).toBe('120 (0 on)');
    expect(vmOnText({ vms: 120 })).toBe('120 (— on)');
    expect(alarmText({ alarmsCritical: 0, alarmsWarning: 3 })).toBe('위험 0 · 경고 3');
    expect(alarmText({ alarmsCritical: 2 })).toBe('위험 2 · 경고 —');
  });
});
