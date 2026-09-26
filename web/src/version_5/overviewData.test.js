import { describe, it, expect } from 'vitest';
import { siteLevel, opsStatus, infraTotals, trustSummary, statusCard } from './overviewData.js';

const site = (id, status, m = {}, extra = {}) => ({ id, name: id.toUpperCase(), status, metrics: { hosts: 2, vms: 10, cpuUsagePct: 20, memUsagePct: 30, storageUsagePct: 40, alarmsCritical: 0, alarmsWarning: 0, ...m }, ...extra });
const ov = {
  generatedAt: '2026-09-26T00:00:00Z',
  global: { vcenters: 5, hosts: 10, vms: 50, vmsPoweredOn: 40, storageUsedTB: 30, storageTotalTB: 100, storageUsagePct: 30, datastores: 4 },
  physical: { servers: 7 }, physicalByCorp: { byVcenter: { a: 3 } },
  sites: [site('a', 'connected'), site('b', 'connected', { alarmsWarning: 2 }), site('c', 'unreachable'), site('d', 'pending'), site('e', 'maintenance')],
};

describe('siteLevel — 판정 대기·점검을 정상에 흡수하지 않는다', () => {
  it('상태별', () => {
    const lv = (s) => siteLevel({ status: s.status, alarmsCritical: s.metrics.alarmsCritical, alarmsWarning: s.metrics.alarmsWarning, worst: 40 });
    expect(lv(site('x', 'connected'))).toBe('ok');
    expect(lv(site('x', 'connected', { alarmsWarning: 1 }))).toBe('warn');
    expect(lv(site('x', 'connected', { alarmsCritical: 1 }))).toBe('crit');
    expect(lv(site('x', 'unreachable'))).toBe('crit');
    expect(lv(site('x', 'pending'))).toBe('wait');
    expect(lv(site('x', 'maintenance'))).toBe('maint');
  });
  it('사용률 90% 이상은 위험, 사용률·경보 모두 모르면 대기', () => {
    expect(siteLevel({ status: 'connected', worst: 95 })).toBe('crit');
    expect(siteLevel({ status: 'connected', worst: 80 })).toBe('warn');
    expect(siteLevel({ status: 'connected', worst: null, alarmsUnknown: true })).toBe('wait');
  });
});

describe('opsStatus', () => {
  it('합계 = 정상 + 주의 + 위험 + 대기 + 점검', () => {
    const o = opsStatus({ ov });
    expect(o).toMatchObject({ ok: 1, warn: 1, crit: 1, wait: 1, maint: 1, total: 5 });
    expect(o.ok + o.warn + o.crit + o.wait + o.maint).toBe(o.total);
  });
  it('알람을 못 읽으면 영향 값은 null(0 이 아니다)', () => {
    const o = opsStatus({ ov, alarms: null });
    expect(o.affectedSites).toBeNull();
    expect(o.affectedVms).toBeNull();
  });
  it('영향 호스트의 VM = 경보 걸린 호스트의 vmCount 합 · 확인된 경보는 빼고 · 호스트 목록이 없으면 null', () => {
    const alarms = { items: [
      { vcenterId: 'b', entity: 'h1', entityType: 'host', severity: 'warning' },
      { vcenterId: 'b', entity: 'h1', entityType: 'host', severity: 'critical' },
      { vcenterId: 'a', entity: 'ds1', entityType: 'datastore', severity: 'warning' },
      { vcenterId: 'a', entity: 'h9', entityType: 'host', severity: 'critical', acknowledged: true },
      { vcenterId: 'c', entity: 'h2', entityType: 'host', severity: 'info' },
    ] };
    const hosts = { items: [{ vcenterId: 'b', name: 'h1', vmCount: 12 }, { vcenterId: 'a', name: 'h1', vmCount: 99 }] };
    expect(opsStatus({ ov, alarms, hosts })).toMatchObject({ affectedSites: 2, affectedHosts: 1, affectedVms: 12 });
    expect(opsStatus({ ov, alarms }).affectedVms).toBeNull();
    expect(opsStatus({ ov, alarms, hosts, scopeId: 'a' })).toMatchObject({ total: 1, affectedSites: 1, affectedHosts: 0, affectedVms: 0 });
  });
});

describe('infraTotals', () => {
  it('전체', () => {
    expect(infraTotals(ov)).toMatchObject({ vcenters: 5, physical: 7, hosts: 10, vms: 50, vmsOn: 40, storageTotalTB: 100, storagePct: 30 });
  });
  it('법인 범위 — 그 사이트 롤업 · 연결된 iDRAC 가 없으면 null', () => {
    expect(infraTotals(ov, 'a')).toMatchObject({ vcenters: 1, physical: 3, hosts: 2, vms: 10 });
    expect(infraTotals(ov, 'b').physical).toBeNull();
  });
  it('데이터스토어가 없으면 사용률은 null', () => {
    expect(infraTotals({ global: { storageTotalTB: 0, datastores: 0, storageUsagePct: 0 } }).storagePct).toBeNull();
  });
  it('수집 전(global 없음)은 null', () => {
    expect(infraTotals({})).toBeNull();
    expect(infraTotals(null)).toBeNull();
  });
});

describe('trustSummary', () => {
  it('보고율 = (연결 + 점검) / 전체 · 대기와 실패를 따로 센다', () => {
    const t = trustSummary({ health: { vcenters: 5, vcentersConnected: 2, vcentersPending: 1, vcentersUnreachable: 1, vcentersMaintenance: 1, generatedAt: '2026-09-26T00:00:00Z' }, ov });
    expect(t).toMatchObject({ connected: 2, total: 5, pending: 1, unreachable: 1, maintenance: 1, ratePct: 60 });
    expect(t.generatedMs).toBe(Date.parse('2026-09-26T00:00:00Z'));
  });
  it('health 가 없으면 보고율 null', () => {
    expect(trustSummary({ ov }).ratePct).toBeNull();
  });
});

describe('statusCard — pending 과 unreachable 을 합치지 않는다', () => {
  it('통신 지도가 있으면 엣지 기준(꺼진 엣지 제외 · 확인 불가는 정상이 아니다)', () => {
    const c = statusCard({ health: { vcentersPending: 1 }, commMap: { edges: [{ state: 'ok' }, { state: 'ok' }, { state: 'disabled' }, { state: 'unknown' }] } });
    expect(c.label).toBe('Main · Edge 2/3');
    expect(c.tone).toBe('warn');
    expect(c.detail).toBe('엣지 확인 불가 1 · 첫 수집 중 1');
  });
  it('전부 정상이면 정상', () => {
    expect(statusCard({ commMap: { edges: [{ state: 'ok' }] } })).toMatchObject({ label: 'Main · Edge 1/1 정상', tone: 'ok' });
  });
  it('켜진 엣지가 0곳이면 vCenter 기준으로 말한다', () => {
    expect(statusCard({ health: { vcenters: 2, vcentersConnected: 2 }, commMap: { edges: [{ state: 'disabled' }] } }).label).toBe('Main · vCenter 2/2');
  });
  it('통신 지도 없이 vCenter 기준', () => {
    const c = statusCard({ health: { vcenters: 4, vcentersConnected: 2, vcentersPending: 1, vcentersUnreachable: 1 } });
    expect(c).toMatchObject({ label: 'Main · vCenter 2/4', tone: 'crit', detail: '첫 수집 중 1 · 연결 실패 1' });
  });
  it('아무것도 없으면 연결 중', () => {
    expect(statusCard({}).label).toBe('연결 중…');
  });
});

describe('v2.617 — 비활성(disabled) vCenter 는 판정 대기도 연결 실패도 아니다', () => {
  const ovOff = { ...ov, sites: [...ov.sites, site('f', 'disabled')] };
  it('siteLevel 은 off', () => {
    expect(siteLevel({ status: 'disabled' })).toBe('off');
  });
  it('opsStatus 는 off 를 따로 세고 total 에서 뺀다(항등식 유지)', () => {
    const o = opsStatus({ ov: ovOff });
    expect(o.off).toBe(1);
    expect(o.ok + o.warn + o.crit + o.wait + o.maint).toBe(o.total);
    expect(o.wait).toBe(opsStatus({ ov }).wait);
  });
  it('trustSummary 범위 모드 — 비활성 사이트는 첫 수집 중이 아니다', () => {
    const t = trustSummary({ ov: ovOff, scopeId: 'f' });
    expect(t.pending).toBe(0);
    expect(t.total).toBe(0);
    expect(t.disabled).toBe(1);
    expect(t.ratePct).toBe(null);
  });
  it('trustSummary 전체 모드 — 분모에서 뺀다(구버전 서버면 사이트에서 센다)', () => {
    const h = { vcenters: 4, vcentersConnected: 3, vcentersDisabled: 1 };
    expect(trustSummary({ health: h, ov: ovOff }).ratePct).toBe(100);
    const old = { vcenters: 6, vcentersConnected: 2, vcentersMaintenance: 1 };
    const t = trustSummary({ health: old, ov: ovOff });
    expect(t.disabled).toBe(1);
    expect(t.total).toBe(5);
  });
  it('statusCard — 비활성만 있으면 초록이고 detail 이 비활성을 밝힌다', () => {
    const c = statusCard({ health: { vcenters: 4, vcentersConnected: 3, vcentersDisabled: 1 } });
    expect(c.tone).toBe('ok');
    expect(c.label).toBe('Main · vCenter 3/3');
    expect(c.detail).toContain('비활성 1');
  });
});

describe('v2.617 — 주의 목록은 위험 먼저, 그 근거를 말한다', async () => {
  const { attentionSites } = await import('./overviewData.js');
  it('사용률 때문에 위험이면 사용률을 적는다 · 위험이 앞', () => {
    const rows = [
      { id: 'w', name: 'W', status: 'connected', alarmsCritical: 0, alarmsWarning: 9, worst: 40 },
      { id: 'c', name: 'C', status: 'connected', alarmsCritical: 0, alarmsWarning: 1, worst: 95 },
      { id: 'u', name: 'U', status: 'unreachable', alarmsCritical: 0, alarmsWarning: 0, worst: null },
      { id: 'o', name: 'O', status: 'connected', alarmsCritical: 0, alarmsWarning: 0, worst: 10 },
    ];
    const a = attentionSites(rows);
    expect(a.map((x) => x.id)).toEqual(['c', 'u', 'w']);
    expect(a[0].why).toBe('위험 0 · 주의 1 · 사용률 95%');
    expect(a[1].why).toBe('연결 실패');
    expect(a[2].why).toBe('위험 0 · 주의 9');
  });
});

describe('v2.618 — 모르는 값을 0 으로 말하지 않는다(WEB-4·5)', async () => {
  const { attentionSites, opsStatus } = await import('./overviewData.js');
  it('경보 미확인 법인', () => {
    const a = attentionSites([{ id: 'r', name: 'R', status: 'connected', alarmsCritical: 0, alarmsWarning: 0, alarmsUnknown: true, worst: 95 }]);
    expect(a[0].why).toBe('경보 미확인 · 사용률 95%');
  });
  it('VM 수를 모르는 영향 호스트', () => {
    const o = opsStatus({
      ov: { sites: [{ id: 'a', name: 'A', status: 'connected', metrics: {} }] },
      alarms: { items: [{ severity: 'critical', vcenterId: 'a', entityType: 'host', entity: 'h1' }, { severity: 'warning', vcenterId: 'a', entityType: 'host', entity: 'h2' }] },
      hosts: { items: [{ vcenterId: 'a', name: 'h1', vmCount: 7 }, { vcenterId: 'a', name: 'h2', vmCount: null }] },
    });
    expect(o.affectedVms).toBe(7);
    expect(o.affectedVmsUnknown).toBe(1);
  });
});
