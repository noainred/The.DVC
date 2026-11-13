// v3.1.0 — IP 변화 페이지 · 대장 '충돌 의심 · MAC 변경' 문구(ipamChangeText.js) · 알림 설정의 알리지 않을 에이전트 입력(Alerts2 parseQuietAgents).
import { describe, it, expect } from 'vitest';
import { CHANGE_TYPE, CHANGE_ORDER, NOTIFY_TEXT, notifyBadge, changeDetail, macAlertBadge, hasMacAlert } from './ipamChangeText.js';
import { parseQuietAgents, IPAM_RULES } from '../Alerts2.jsx';

describe('ipamChangeText', () => {
  it('종류 · 알림 결과 라벨은 서버 목록과 1:1(모르는 값은 —)', () => {
    expect(CHANGE_ORDER).toEqual(['conflict', 'mac-change', 'new-ip', 'reserved-up', 'rename', 'conflict-resolved', 'baseline']);
    expect(Object.keys(NOTIFY_TEXT).sort()).toEqual(['engine', 'excluded', 'failed', 'flap', 'none', 'off', 'quiet', 'sent', 'skipped', 'summary']);
    expect(notifyBadge('nope')).toEqual(NOTIFY_TEXT.none);
    expect(CHANGE_TYPE.conflict.tone).toBe('red');
  });
  it('내용 칸 — 종류마다(제조사는 서버가 기록에 남긴 이름)', () => {
    expect(changeDetail({ type: 'mac-change', from: 'AA:00:00:00:00:01', fromVendor: 'Intel Corporate', to: 'AA:00:00:00:00:02', flap: true }))
      .toBe('AA:00:00:00:00:01(Intel Corporate) → AA:00:00:00:00:02 · 예전 MAC 으로 되돌아감(이중화 의심)');
    expect(changeDetail({ type: 'new-ip', services: ['SSH', 'HTTPS'], mac: 'AA:00:00:00:00:03', vendor: 'Dell Inc.' })).toBe('SSH,HTTPS · AA:00:00:00:00:03(Dell Inc.)');
    expect(changeDetail({ type: 'new-ip' })).toBe('응답');
    expect(changeDetail({ type: 'reserved-up', status: 'deprecated', services: ['SMB'] })).toBe('관리상태 폐기 — SMB');
    expect(changeDetail({ type: 'rename', src: 'netbios', from: 'A', to: 'B' })).toBe('NetBIOS A → B');
    expect(changeDetail({ type: 'conflict', vm: 'vm-1', note: 'd' })).toBe('VM vm-1 · d');
    expect(changeDetail({ type: 'baseline', spec: '10.0.0.0/24' })).toMatch(/^대역 10\.0\.0\.0\/24 첫 완료 스캔/);
    expect(changeDetail(null)).toBe('');
  });
  it('대장 배지 — 충돌 의심이 먼저 · 최근 MAC 변경 · 없으면 null · 칩 판정', () => {
    expect(macAlertBadge({ macConflict: { mac: 'F4:8E:38:2A:91:0C', vendor: 'Dell Inc.', seen: 2, otherVm: 'vm-z' }, macChangedAt: 1 }).label).toBe('충돌 의심');
    expect(macAlertBadge({ macConflict: { mac: 'X', seen: 3 } }).title).toMatch(/연속 3회/);
    expect(macAlertBadge({ macChangedAt: 1, macPrev: 'AA' })).toMatchObject({ label: 'MAC 변경', tone: 'amber' });
    expect(macAlertBadge({})).toBe(null);
    expect([hasMacAlert({ macConflict: {} }), hasMacAlert({ macChangedAt: 5 }), hasMacAlert({}), hasMacAlert(null)]).toEqual([true, true, false, false]);
  });
});

describe('Alerts2 — IP 관리 규칙 · 알리지 않을 에이전트', () => {
  it('규칙 다섯은 서버 기본값 키와 같다', () => {
    expect(IPAM_RULES.map((r) => r.k)).toEqual(['ipamConflict', 'ipamMacChange', 'ipamNewIp', 'ipamReservedUp', 'ipamRename']);
  });
  it('쉼표 · 줄바꿈으로 나누고 빈 칸 · 중복(대소문자 무시)을 뺀다', () => {
    expect(parseQuietAgents(' edge-a, EDGE-A ,\nedge-b,, ')).toEqual(['edge-a', 'edge-b']);
    expect(parseQuietAgents('')).toEqual([]);
    expect(parseQuietAgents(null)).toEqual([]);
  });
});
