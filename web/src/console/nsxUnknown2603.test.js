// v2.603 감사 RECENT2603-01 — NSX 매니저 'unknown'(클러스터 상태 조회 실패 — 판정 보류)은 다운이 아니라 주의다.
import { describe, it, expect } from 'vitest';
import { buildDomainTiles, nsxManagerRows, nsxManagerBadge } from './consoleData.js';

const g = { vcenters: 1, vcentersConnected: 1, hosts: 1, vms: 1, hostsDisconnected: 0, cpuUsagePct: 10, memUsagePct: 10, storageUsagePct: 10, networks: 3 };
const net = (nsx) => buildDomainTiles({ global: g, alarms: [], nsx }).find((t) => t.page === 'network');
const mgr = (status, extra = {}) => ({ id: 'm1', name: 'nsx-a', status, ...extra });

describe('RECENT2603-01 네트워크 타일', () => {
  it('connected 1대 → 0, degraded 1대 → 1', () => {
    expect(net({ managers: [mgr('connected')], rollup: { managers: 1, managersUp: 1, managersDegraded: 0, managersUnknown: 0 } }).level).toBe(0);
    expect(net({ managers: [mgr('degraded')], rollup: { managers: 1, managersUp: 0, managersDegraded: 1, managersUnknown: 0 } }).level).toBe(1);
  });
  it('unknown 1대 → 주의(1). 예전에는 위험(2) — 저하보다 나쁘게 칠했다', () => {
    expect(net({ managers: [mgr('unknown')], rollup: { managers: 1, managersUp: 0, managersDegraded: 0, managersUnknown: 1, listsFailed: { clusterStatus: 1 } } }).level).toBe(1);
  });
  it('구버전 서버 rollup(managersUnknown 없음)은 매니저 목록에서 센다', () => {
    expect(net({ managers: [mgr('unknown')], rollup: { managers: 1, managersUp: 0, managersDegraded: 0 } }).level).toBe(1);
  });
  it('unreachable 은 여전히 위험(2) — unknown 과 섞어도', () => {
    expect(net({ managers: [mgr('unknown'), { ...mgr('unreachable'), id: 'm2' }], rollup: { managers: 2, managersUp: 0, managersDegraded: 0, managersUnknown: 1 } }).level).toBe(2);
  });
});

describe('RECENT2603-01 매니저 표 행·배지', () => {
  it('unknown 행은 1, unreachable 은 2', () => {
    const rows = nsxManagerRows({ managers: [mgr('unknown'), { ...mgr('unreachable'), id: 'm2', name: 'nsx-b' }] });
    expect(rows.find((r) => r.id === 'm1').level).toBe(1);
    expect(rows.find((r) => r.id === 'm2').level).toBe(2);
  });
  it('배지 — unknown 은 회색 상태 확인 불가(사유 포함), degraded 는 저하, 그 밖은 null(StateBadge 폴백)', () => {
    const b = nsxManagerBadge(mgr('unknown', { listFailReasons: { clusterStatus: 'HTTP 503' } }));
    expect(b).toMatchObject({ cls: 'gray', label: '상태 확인 불가' });
    expect(b.title).toContain('HTTP 503');
    expect(nsxManagerBadge(mgr('unknown')).title).toContain('사유 미상');
    expect(nsxManagerBadge(mgr('degraded'))).toMatchObject({ cls: 'amber', label: '저하' });
    expect(nsxManagerBadge(mgr('connected'))).toBeNull();
    expect(nsxManagerBadge(null)).toBeNull();
  });
});
