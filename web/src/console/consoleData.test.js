// DVC 콘솔 순수 계산 모듈 회귀 테스트(v2.487) — 판정 규칙·정렬·집계가 화면과 무관하게 고정된다.
import { describe, it, expect } from 'vitest';
import {
  levelOf, colorOf, ageText, domainOf, severityCounts, alarmCountsByDomain, sortAlarms, correlateAlarms,
  normalizeMessage, siteRows, clusterRows, clusterCountByVc, capacityAdvice, datastoreTypeCounts, datastoresOver,
  ipamTop, ipamStats, svcmonLevel, tempColor, hostFacilityRows, storageRows, sanCells, sanTotals, pduSummary,
  nsxManagerRows, networkTypeCounts, buildDomainTiles, rowMatches, fmtInt, fmtPct, CRIT_PCT, WARN_PCT,
} from './consoleData.js';

describe('임계 판정', () => {
  it('75/90 경계(포탈 공용 usageColor 와 동일)', () => {
    expect(levelOf(0)).toBe(0); expect(levelOf(WARN_PCT - 1)).toBe(0); expect(levelOf(WARN_PCT)).toBe(1);
    expect(levelOf(CRIT_PCT - 1)).toBe(1); expect(levelOf(CRIT_PCT)).toBe(2);
  });
  it('값 없음은 null 이고 회색', () => { expect(levelOf(null)).toBeNull(); expect(levelOf('')).toBeNull(); expect(colorOf(undefined)).toBe('#9ca3af'); });
  it('fmt: null 은 —', () => { expect(fmtInt(null)).toBe('—'); expect(fmtInt(1234)).toBe('1,234'); expect(fmtPct(59.6)).toBe('60%'); });
});

describe('ageText', () => {
  const now = Date.parse('2026-09-12T03:00:00Z');
  it('초·분·시·일', () => {
    expect(ageText('2026-09-12T02:59:30Z', now)).toBe('30s');
    expect(ageText('2026-09-12T02:54:00Z', now)).toBe('6m');
    expect(ageText('2026-09-12T01:35:00Z', now)).toBe('1h25m');
    expect(ageText('2026-09-12T01:00:00Z', now)).toBe('2h');
    expect(ageText('2026-09-09T01:00:00Z', now)).toBe('3d');
    expect(ageText(null, now)).toBe('—');
  });
});

const ALARMS = [
  { id: 'a', vcenterId: 'vc-a', entity: 'esx-1', entityType: 'host', severity: 'warning', message: 'High CPU usage (96%)', time: '2026-09-12T02:00:00Z' },
  { id: 'b', vcenterId: 'vc-a', entity: 'esx-2', entityType: 'host', severity: 'warning', message: 'High CPU usage (91%)', time: '2026-09-12T02:30:00Z' },
  { id: 'c', vcenterId: 'vc-b', entity: 'ds-1', entityType: 'datastore', severity: 'critical', message: 'Datastore usage at 97%', time: '2026-09-12T01:00:00Z' },
  { id: 'd', vcenterId: 'vc-a', entity: 'esx-3', entityType: 'host', severity: 'info', message: 'Host in maintenance mode', time: '2026-09-12T02:45:00Z' },
];

describe('알람 집계', () => {
  it('도메인 매핑', () => { expect(domainOf('host')).toBe('COMPUTE'); expect(domainOf('datastore')).toBe('STORAGE'); expect(domainOf('network')).toBe('NETWORK'); expect(domainOf('x')).toBe('OTHER'); });
  it('심각도 카운트', () => expect(severityCounts(ALARMS)).toEqual({ critical: 1, warning: 2, info: 1, total: 4 }));
  it('도메인별 C/W/I', () => { const d = alarmCountsByDomain(ALARMS); expect(d.COMPUTE).toEqual({ critical: 0, warning: 2, info: 1 }); expect(d.STORAGE.critical).toBe(1); });
  it('정렬: critical 먼저, 같은 심각도는 최신순', () => expect(sortAlarms(ALARMS).map((a) => a.id)).toEqual(['c', 'b', 'a', 'd']));
  it('메시지 정규화·상관 그룹', () => {
    expect(normalizeMessage('High CPU usage (96%)')).toBe('High CPU usage (N)');
    const g = correlateAlarms(ALARMS);
    expect(g[0]).toMatchObject({ vcenterId: 'vc-a', count: 2, severity: 'warning', entities: ['esx-1', 'esx-2'] });
    expect(g.length).toBe(3);
  });
});

describe('사이트·클러스터', () => {
  const sites = [
    { id: 'vc-a', name: 'A', location: { city: 'Seoul', region: '아시아' }, status: 'connected', metrics: { hosts: 10, vms: 100, cpuUsagePct: 50, memUsagePct: 92, storageUsagePct: 70, powerKw: 3.2, alarmsCritical: 1, alarmsWarning: 2 } },
    { id: 'vc-b', name: 'B', location: { city: 'Frankfurt', region: '유럽' }, status: 'unreachable', metrics: null },
  ];
  it('worst 내림차순, 메트릭 없으면 null 로 뒤', () => {
    const r = siteRows(sites);
    expect(r[0].id).toBe('vc-a'); expect(r[0].worst).toBe(92); expect(r[1].worst).toBeNull(); expect(r[1].hosts).toBeNull();
  });
  const clusters = [
    { vcenterId: 'vc-a', cluster: 'CL1', hosts: 4, cpuUsedPct: 91, memUsedPct: 60, ramOvercommitPct: 80, ramHeadroomGB: 100, ramAllocatedGB: 400, memTotalGB: 500 },
    { vcenterId: 'vc-a', cluster: 'CL2', hosts: 3, cpuUsedPct: 20, memUsedPct: 30, ramOvercommitPct: 120, ramHeadroomGB: 900, ramAllocatedGB: 600, memTotalGB: 500 },
    { vcenterId: 'vc-b', cluster: 'CL3', hosts: 2, cpuUsedPct: 10, memUsedPct: 10, ramOvercommitPct: 10, ramHeadroomGB: 990, ramAllocatedGB: 10, memTotalGB: 100 },
  ];
  it('클러스터 부하 정렬·vCenter 별 개수', () => {
    expect(clusterRows(clusters).map((c) => c.name)).toEqual(['CL1', 'CL2', 'CL3']);
    expect(clusterCountByVc(clusters)).toEqual({ 'vc-a': 2, 'vc-b': 1 });
  });
  it('용량 어드바이저 규칙 3종(호스트 2대 클러스터는 배치 후보 제외)', () => {
    const a = capacityAdvice(clusters);
    expect(a.map((x) => x.level)).toEqual([2, 1, 0]);
    expect(a[0].title).toContain('CL1'); expect(a[1].title).toContain('120%'); expect(a[2].title).toContain('CL2');
  });
});

describe('스토리지·네트워크·IPAM', () => {
  it('DS 유형 카운트·임계 초과 + 예측 결합', () => {
    const ds = [{ id: '1', type: 'VMFS', usagePct: 96 }, { id: '2', type: 'vSAN', usagePct: 50 }, { id: '3', type: 'NFS41', usagePct: 88 }];
    expect(datastoreTypeCounts(ds)).toEqual({ VMFS: 1, vSAN: 1, NFS: 1, 기타: 0 });
    const over = datastoresOver(ds, 85, [{ id: '1', daysToFull: 12, synthesized: false }]);
    expect(over.map((d) => d.id)).toEqual(['1', '3']); expect(over[0].daysToFull).toBe(12); expect(over[1].daysToFull).toBeNull();
  });
  it('IPAM /24 사용률', () => {
    const s = [{ subnet: '10.0.0.0/24', used: 254 }, { subnet: '10.0.1.0/24', used: 127 }];
    expect(ipamTop(s)[0].pct).toBe(100); expect(ipamStats(s)).toEqual({ count: 2, over90: 1, avgPct: 75 }); expect(ipamStats([]).avgPct).toBeNull();
  });
  it('네트워크 유형', () => expect(networkTypeCounts([{ type: 'DISTRIBUTED_PORTGROUP' }, { type: 'STANDARD_PORTGROUP' }, { type: 'X' }])).toEqual({ distributed: 1, standard: 1, other: 1 }));
  it('NSX 매니저 행: 노드 DOWN 이면 주의, 연결 끊김이면 위험', () => {
    const nsx = { managers: [{ id: 'm1', name: 'a', status: 'connected' }, { id: 'm2', name: 'b', status: 'unreachable' }], transportNodes: [{ managerId: 'm1', status: 'UP' }, { managerId: 'm1', status: 'DOWN' }], collectionErrors: [] };
    const r = nsxManagerRows(nsx);
    expect(r.find((m) => m.id === 'm1')).toMatchObject({ level: 1, nodes: { up: 1, down: 1, other: 0 } });
    expect(r.find((m) => m.id === 'm2').level).toBe(2);
  });
  it('스토리지 어레이 행: 스냅샷 없으면 용량 null', () => {
    const rows = storageRows([{ id: 'x', name: 'arr', type: 'unity480', snap: { capacity: { pct: 80, totalBytes: 1e15, usedBytes: 8e14 }, nodes: { count: 2 } } }, { id: 'y', name: 'nosnap', type: 'isilon', snap: null }], [{ type: 'unity480', label: 'Unity 480' }]);
    expect(rows[0]).toMatchObject({ pct: 80, typeLabel: 'Unity 480', nodes: 2, ok: true }); expect(rows[1].pct).toBeNull(); expect(rows[1].ok).toBeNull();
  });
  it('SAN 셀·합계', () => {
    const cells = sanCells([{ id: 's1', name: 'S1', snap: { ports: { total: 48, online: 46, offline: 2, faulty: 0 } } }, { id: 's2', name: 'S2', snap: null }]);
    expect(cells[0].level).toBe(2); expect(cells[1].level).toBeNull();
    expect(sanTotals(cells)).toEqual({ devices: 2, online: 46, total: 48, offline: 2, faulty: 0, measured: 1 });
  });
});

describe('설비', () => {
  it('온도 색 눈금', () => { expect(tempColor(21)).toBe('#3b82f6'); expect(tempColor(23)).toBe('#d1d5db'); expect(tempColor(25)).toBe('#f59e0b'); expect(tempColor(26)).toBe('#ef4444'); expect(tempColor(null)).toBeNull(); });
  it('vCenter 별 호스트 온도·iDRAC 연동 집계', () => {
    const hosts = [
      { vcenterId: 'vc-a', name: 'h1', tempC: 24.5, idracBacked: true, powerWatts: 200, connectionState: 'CONNECTED' },
      { vcenterId: 'vc-a', name: 'h2', tempC: null, idracBacked: false, powerWatts: null, connectionState: 'DISCONNECTED' },
    ];
    const r = hostFacilityRows(hosts, [{ id: 'vc-a', name: 'A', city: 'Seoul', region: '아시아', powerKw: 0.2 }]);
    expect(r[0]).toMatchObject({ hosts: 2, measured: 1, maxTemp: 24.5, idracBacked: 1, idracPct: 50, powerReporting: 1, disconnected: 1, powerKw: 0.2, name: 'A' });
  });
  it('PDU 요약', () => {
    const p = { devices: [{ snapshot: { ok: true, summary: { powerW: 1200, sensors: 2, tempMaxC: 27 } } }, { snapshot: { ok: false } }, { snapshot: null }], activeViolations: [{ key: 'k' }] };
    expect(pduSummary(p)).toEqual({ devices: 3, ok: 1, failed: 1, none: 1, powerW: 1200, sensors: 2, tempMaxC: 27, violations: 1 });
  });
  it('svcmon 레벨', () => { expect(svcmonLevel(null)).toBeNull(); expect(svcmonLevel({ total: 0 })).toBeNull(); expect(svcmonLevel({ total: 3, bad: 1 })).toBe(2); expect(svcmonLevel({ total: 3, bad: 0, warn: 0, stale: 1 })).toBe(1); expect(svcmonLevel({ total: 3, bad: 0, warn: 0, stale: 0 })).toBe(0); });
});

describe('도메인 타일', () => {
  const g = { vcenters: 3, vcentersConnected: 3, vcentersMaintenance: 0, hosts: 10, vms: 50, hostsDisconnected: 0, cpuUsagePct: 50, memUsagePct: 60, storageUsagePct: 91, datastores: 5, storageUsedTB: 9, storageTotalTB: 10, networks: 7, powerKw: 12.3, powerReporting: 8 };
  it('6개 타일, 없는 데이터는 level null 로 표시(추정 금지)', () => {
    const t = buildDomainTiles({ global: g, alarms: ALARMS, nsx: null, svcmon: null, pdu: null, idracPoller: null, dsOver: 2, storageDevices: null });
    expect(t.map((x) => x.name)).toEqual(['컴퓨트', '스토리지', '네트워크', '설비 · 전력', '물리 서버 BMC', '서비스 점검']);
    expect(t[0].level).toBe(0); expect(t[1].level).toBe(2); expect(t[1].meta).toContain('임계 초과 2');
    expect(t[2].level).toBeNull(); expect(t[4].level).toBeNull(); expect(t[4].value).toBe('—'); expect(t[5].level).toBeNull();
    expect(t[3].level).toBe(0); expect(t[3].value).toBe('12.3 kW');
  });
  it('호스트 끊김·vCenter 불가면 컴퓨트 위험, BMC 무응답 5% 이상이면 위험', () => {
    const t = buildDomainTiles({ global: { ...g, hostsDisconnected: 1 }, alarms: [], nsx: { rollup: { managers: 2, managersUp: 2, managersDegraded: 0, segments: 1, edgeNodes: 1 } }, svcmon: { summary: { total: 4, ok: 3, warn: 0, bad: 1, stale: 0 } }, pdu: { devices: [], activeViolations: [] }, idracPoller: { servers: 100, lastRun: { ok: 90, failed: 10 } }, dsOver: 0 });
    expect(t[0].level).toBe(2); expect(t[2].level).toBe(0); expect(t[4]).toMatchObject({ level: 2, value: '90%' }); expect(t[5].level).toBe(2);
  });
  it('전체 데이터 없음(global null)도 크래시 없이 6개', () => expect(buildDomainTiles({ global: null, alarms: [], permission: { idrac: false, pdu: false } }).length).toBe(6));
});

describe('rowMatches', () => {
  it('공백 구분 AND, 대소문자 무시', () => {
    const r = { name: 'vc-eu-central', city: 'Frankfurt', hosts: 30 };
    expect(rowMatches(r, 'frank')).toBe(true); expect(rowMatches(r, 'eu 30')).toBe(true); expect(rowMatches(r, 'seoul')).toBe(false); expect(rowMatches(r, '')).toBe(true);
  });
});

describe('buildDomainTiles — 서비스 점검 타일의 원인 표시(v2.506)', () => {
  const base = { global: null, alarms: [], nsx: null, pdu: null, idracPoller: null, dsOver: null, storageDevices: null };
  const svcTile = (o) => buildDomainTiles({ ...base, ...o }).find((t) => t.name === '서비스 점검');

  it('권한이 없어 폴링을 안 걸었으면 권한 없음으로 밝힌다(거짓 원인 금지)', () => {
    // v2.506 에서 /api/svcmon 이 requirePerm('svcmon') 아래로 들어갔다. 셸은 권한이 없으면
    // path 를 null 로 넘겨 폴링을 안 건다 → svcmon=null. 그 상태를 '점검 상태 대기'(수집 원인)로
    // 쓰면 사용자가 수집 장애로 오해한다(CLAUDE.md v2.493 규칙).
    const t = svcTile({ svcmon: null, permission: { svcmon: false } });
    expect(t.meta).toMatch(/권한/);
    expect(t.meta).not.toMatch(/대기/);
    expect(t.level).toBe(null);
    expect(t.value).toBe('—');
  });
  it('권한은 있는데 아직 데이터가 없으면 수집 대기로 남긴다', () => {
    const t = svcTile({ svcmon: null, permission: { svcmon: true } });
    expect(t.meta).toBe('점검 상태 대기');
  });
  it('permission 을 안 넘긴 호출부는 기존 문구를 유지한다(하위호환)', () => {
    expect(svcTile({ svcmon: null }).meta).toBe('점검 상태 대기');
  });
  it('데이터가 있으면 권한 플래그와 무관하게 집계를 보여준다', () => {
    const t = svcTile({ svcmon: { summary: { total: 4, ok: 3, warn: 0, bad: 1, stale: 0 } }, permission: { svcmon: false } });
    expect(t.value).toBe('4');
    expect(t.meta).toMatch(/실패 1/);
  });
});
