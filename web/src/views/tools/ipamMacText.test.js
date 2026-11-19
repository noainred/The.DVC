// v2.999 — IP 대장 '제조사 · MAC' 칸 · 요약 · 에이전트 표 'MAC' 칸 문구(ipamMacText.js). 판정은 서버(macVendor.js) — 여기는 문구만.
import { describe, it, expect } from 'vitest';
import { macVendorText, macKindBadge, isUnregisteredVirtual, scanMacSummary, scanMacSummaryParts, macSortValue, macStaleText, macStatsCell, macStatsText, MAC_SRC } from './ipamMacText.js';

describe('ipamMacText — 제조사 칸 · 종류 배지', () => {
  it('종류가 제조사를 대신하는 경우(이중화 · 임의 지정)와 표에 없는 경우를 가른다', () => {
    expect(macVendorText({ vendor: 'Dell Inc.', kind: null })).toBe('Dell Inc.');
    expect(macVendorText({ vendor: null, kind: 'gateway', platform: 'VRRP' })).toBe('게이트웨이 이중화(VRRP)');
    expect(macVendorText({ vendor: null, kind: 'random' })).toBe('임의 지정 MAC');
    expect(macVendorText({ vendor: null, kind: 'virtual', platform: 'QEMU/KVM' })).toBe('QEMU/KVM');
    expect(macVendorText({ vendor: 'VMware, Inc.', kind: 'virtual', platform: 'VMware' })).toBe('VMware, Inc.');
    expect(macVendorText({ vendor: null, kind: null })).toBe('제조사 미상');
    expect(macVendorText(undefined)).toBe('제조사 미상');
  });
  it('배지 — 가상 NIC · 이중화 · 임의 지정, 그 밖은 없음', () => {
    expect(macKindBadge('virtual', 'VMware').label).toBe('가상 NIC · VMware');
    expect(macKindBadge('gateway', 'HSRP').label).toBe('게이트웨이 이중화 · HSRP');
    expect(macKindBadge('random').label).toBe('임의 지정');
    expect(macKindBadge(null)).toBe(null);
    expect(MAC_SRC.arp.label).toBe('ARP');
    expect(MAC_SRC.netbios.label).toBe('NetBIOS');
  });
});

describe('ipamMacText — 미등록 가상 NIC · 요약', () => {
  const rows = [
    { ownerType: 'scanned', mac: 'A', macVendor: 'Dell Inc.' },
    { ownerType: 'scanned', mac: 'B', macVendor: 'VMware, Inc.', macKind: 'virtual' },
    { ownerType: 'scanned', mac: 'C', macKind: 'random' },
    { ownerType: 'scanned', mac: 'D', macKind: 'gateway' },
    { ownerType: 'scanned', mac: 'E' },
    { ownerType: 'scanned' },
    { ownerType: 'vm', mac: 'F', macVendor: 'VMware, Inc.', macKind: 'virtual' },
  ];
  it('스캔 행만 센다 · MAC 없는 행은 total 에만 · VM 행의 가상 NIC 은 미등록이 아니다', () => {
    const s = scanMacSummary(rows);
    expect(s).toEqual({ total: 6, withMac: 5, vendor: 2, random: 1, gateway: 1, unknown: 1, virtualUnreg: 1 });
    expect(isUnregisteredVirtual(rows[1])).toBe(true);
    expect(isUnregisteredVirtual(rows[6])).toBe(false);
    expect(isUnregisteredVirtual(null)).toBe(false);
  });
  it('요약 조각은 0 인 것을 뺀다', () => {
    expect(scanMacSummaryParts({ vendor: 3, unknown: 0, random: 1, gateway: 0 }).map((p) => p.label)).toEqual(['제조사 확인 3', '임의 지정 1']);
    expect(scanMacSummaryParts(null)).toEqual([]);
  });
  it('정렬 값 — MAC 이 없으면 null(항상 뒤로) · 제조사 글자 + MAC', () => {
    expect(macSortValue({})).toBe(null);
    expect(macSortValue({ mac: '00:11:22:33:44:55', macVendor: 'Dell Inc.' })).toBe('Dell Inc. 00:11:22:33:44:55');
    expect(macSortValue({ mac: '7A:00:00:00:00:01', macKind: 'random' })).toBe('임의 지정 MAC 7A:00:00:00:00:01');
  });
});

describe('ipamMacText — IP 상세 오래됨 · 에이전트 표 MAC 칸', () => {
  it('오래됨 — 표에 없었던 횟수와 지우는 기준 · 다른 사유 · 지금 값이면 빈 문구', () => {
    expect(macStaleText({ stale: false })).toBe('');
    expect(macStaleText({ stale: true, arpMiss: 2 }, 3)).toBe('지난 스캔 2회 연속 스캐너 이웃 표에 없었습니다 — 3회가 되면 이 MAC 을 지웁니다');
    expect(macStaleText({ stale: true, arpMiss: 0 })).toMatch(/다시 보지 못했습니다/);
  });
  it('보고 없음(이전 버전) · 사유(읽지 않음 · 읽기 실패) · 같은 서브넷 없음 · 읽은 수 / 같은 서브넷 수 · 못 읽은 수는 —', () => {
    expect(macStatsCell({ at: 1, alive: 3, nameStats: { named: 1 } })).toMatchObject({ text: '보고 없음', tone: 'muted' });
    expect(macStatsCell(null)).toMatchObject({ text: '—' });
    expect(macStatsCell({ nameStats: { mac: { reason: 'unsupported' } } })).toMatchObject({ text: '읽지 않음', tone: 'muted' });
    expect(macStatsCell({ nameStats: { mac: { reason: 'unreadable' } } })).toMatchObject({ text: '읽기 실패', tone: 'amber' });
    expect(macStatsCell({ nameStats: { mac: { onLink: 0, found: 0, reason: null } } }).text).toBe('같은 서브넷 없음');
    expect(macStatsCell({ nameStats: { mac: { onLink: 1200, found: 1180, reason: null } } }).text).toBe('1,180 / 1,200');
    expect(macStatsCell({ nameStats: { mac: { onLink: 12, found: null, reason: null } } }).text).toBe('— / 12');
    expect(macStatsCell({ nameStats: { mac: { onLink: null, found: null, reason: null } } }).text).toBe('—');
  });
  it('한 줄 요약 — 같은 서브넷이 있을 때만 · 읽기 실패는 알린다 · 요약이 없으면 빈 문구', () => {
    expect(macStatsText({ mac: { onLink: 12, found: 11, reason: null } })).toBe('MAC 11/12');
    expect(macStatsText({ mac: { onLink: 0, found: 0, reason: null } })).toBe('');
    expect(macStatsText({ mac: { reason: 'unreadable' } })).toBe('MAC 이웃 표 읽기 실패');
    expect(macStatsText({ named: 1 })).toBe('');
    expect(macStatsText(null)).toBe('');
  });
});
