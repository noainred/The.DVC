import { describe, it, expect } from 'vitest';
import { statusTiles, usageGauges, siteCards, siteToneCounts, recentAlarms, actionLinks, capacityCards, totalTiles, osRows, corpContribution, serverSegments, serverCorpRows, pctTone } from './v6Data.js';

const G = { vcenters: 12, vcentersConnected: 9, vcentersMaintenance: 1, vcentersDisabled: 1, vcentersPending: 1, vcentersUnreachable: 0,
  hosts: 186, hostsConnected: 170, hostsMaintenance: 11, hostsDisconnected: 5, vms: 2242, vmsPoweredOn: 1918, vmsPoweredOff: 324,
  alarms: 58, alarmsCritical: 5, alarmsWarning: 42, cpuUsagePct: 57, cpuUsedGhz: 10231.7, cpuTotalGhz: 18288.8, memUsagePct: 91,
  memUsedGB: 67609, memTotalGB: 109568, storageUsagePct: null, storageUsedTB: null, storageTotalTB: 1130, datastores: 38, datastoresUsageUnknown: 3, hostsUsageExcluded: 5 };

describe('Overview', () => {
  it('vCenter 타일 분모는 비활성을 뺀 수이고, 첫 수집 중을 정상에 섞지 않는다', () => {
    const t = statusTiles(G).find((x) => x.id === 'vcenter');
    expect(t.value).toBe('9/11');
    expect(t.parts.find((p) => p.k === '첫 수집 중').v).toBe(1);
    expect(t.note).toMatch(/비활성 1곳/);
  });
  it('global 이 없으면 타일도 없다(0 을 지어내지 않는다)', () => { expect(statusTiles(null)).toEqual([]); });
  it('게이지 — 값이 없으면 null·회색, 제외 사실을 밝힌다', () => {
    const [cpu, mem, sto] = usageGauges(G);
    expect(cpu.tone).toBe('ok');
    expect(mem.tone).toBe('crit');
    expect(sto.pct).toBe(null);
    expect(sto.tone).toBe('none');
    expect(sto.note).toMatch(/사용량 미상 데이터스토어 3개/);
    expect(cpu.note).toMatch(/끊긴 호스트 5대/);
  });
  it('임계는 75/90', () => {
    expect(pctTone(74)).toBe('ok'); expect(pctTone(75)).toBe('warn'); expect(pctTone(90)).toBe('crit'); expect(pctTone('')).toBe('none');
  });
  it('법인 카드 — 값이 없는 법인은 판정 대기(none)로 세고 정상에 넣지 않는다', () => {
    const cards = siteCards([{ id: 'a', metrics: { cpuUsagePct: 50, memUsagePct: 80, storageUsagePct: 60 } }, { id: 'b', metrics: {} }]);
    expect(siteToneCounts(cards)).toEqual({ ok: 0, warn: 1, crit: 0, none: 1 });
  });
  it('최근 알람 — 위험 먼저, 같은 등급은 최신 먼저, 비객체 원소 무시', () => {
    const r = recentAlarms({ items: [null, { id: 1, severity: 'warning', time: '2026-01-02T00:00:00Z' }, { id: 2, severity: 'critical', time: '2026-01-01T00:00:00Z' }, { id: 3, severity: 'warning', time: '2026-01-03T00:00:00Z' }] });
    expect(r.map((x) => x.id)).toEqual([2, 3, 1]);
  });
  it('조치 필요 링크는 허용된 도구만', () => {
    expect(actionLinks((k) => k !== 'part-faults').map((a) => a.k)).not.toContain('part-faults');
  });
});

describe('Summary', () => {
  const S = { compute: { cpuCores: 100, memTotalGB: 1000 }, allocation: { vcpuAllocated: 500, vcpuPerCore: 5, ramAllocatedGB: 1200, provisionedStorageTB: 50, avgVmPerHost: 12.1 },
    storage: { capacityTB: 100, usedTB: 60 }, counts: { clusters: 3 }, power: { kw: null },
    osAllocation: [{ name: 'A', vms: 3 }, { name: 'B', vms: 1 }], byVcenter: [{ id: 'x', hosts: 2, vms: 10, powerKw: null }, { id: 'y', hosts: 3, vms: 5, powerKw: 2 }] };
  it('vCPU 4:1 초과는 주의, 메모리 할당 비율', () => {
    const [cpu, mem] = capacityCards(S);
    expect(cpu.ratio).toBe('5:1'); expect(cpu.warn).toBe(true);
    expect(mem.ratio).toBe('120%'); expect(mem.warn).toBe(false);
  });
  it('전력 값이 없으면 — (0 kW 아님)', () => { expect(totalTiles(S).find((t) => t.label === '총 소비전력').value).toBe('—'); });
  it('OS 비중', () => { expect(osRows(S).map((r) => r.share)).toEqual([75, 25]); });
  it('법인 합계는 값이 있는 행만 — 전부 없으면 null', () => {
    const c = corpContribution(S);
    expect(c.total.hosts).toBe(5);
    expect(c.total.powerKw).toBe(2);
    expect(corpContribution({ byVcenter: [{ powerKw: null }] }).total.powerKw).toBe(null);
  });
});

describe('서버 메뉴', () => {
  const OV = { global: G, physicalByCorp: { total: 70, physicalOnly: 3, matchedCount: 67, union: 189, byVcenterPhysicalOnly: { a: 3 } },
    sites: [{ id: 'a', metrics: { hosts: 10, vms: 50, vmsPoweredOn: 40 } }, { id: 'b', metrics: { hosts: 0, vms: 0 } }] };
  it('구분 카드와 합계(물리 전용 + 호스트)', () => {
    const s = serverSegments(OV);
    expect(s.phys.value).toBe(70); expect(s.host.value).toBe(186); expect(s.union).toBe(189);
  });
  it('법인 행 — 물리 전용 + 호스트, 호스트 0 이면 호스트당 VM 은 null', () => {
    const r = serverCorpRows(OV);
    expect(r[0].total).toBe(13); expect(r[0].perHost).toBe(5);
    expect(r[1].perHost).toBe(null);
  });
  it('물리 서버 집계를 못 받으면 물리 전용·합계는 null', () => {
    const r = serverCorpRows({ ...OV, physicalByCorp: { error: 'x' } });
    expect(r[0].physOnly).toBe(null); expect(r[0].total).toBe(null);
    expect(serverSegments({ ...OV, physicalByCorp: { error: 'x' } }).union).toBe(null);
  });
});
