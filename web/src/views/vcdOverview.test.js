// vcdOverview 단위테스트(v2.335) — '호스트 및 클러스터 현황' 평면 행 + CSV.
// 사용자 요구를 고정한다: 트리를 펼치지 않아도 모든 클러스터·모든 호스트가 한 번에 나오고,
// 화면에서 보던 항목(호스트수·VM수·CPU/MEM 사용률·CPU/MEM 가상화율 + 근거 수치)이 CSV 에도
// 그대로 들어간다. 'Off VM 포함' 해제 시 가상화율이 트리 배지와 같은 값으로 내려가야 한다.
import { describe, it, expect } from 'vitest';
import { buildOverviewRows, overviewCsv, ratioText, groupClusters, stateKo, OVERVIEW_COLUMNS } from './vcdOverview.js';

const SITE = { id: 'oc2', name: 'OC2' };
const METRICS = { cpuUsagePct: 29, memUsagePct: 63 };
const HOSTS = [
  // HQ-Admin: 2호스트(코어 32/32, RAM 128GB/128GB)
  { name: 'esx02', cluster: 'HQ-Admin', connectionState: 'CONNECTED', cpuCores: 32, cpuThreads: 64, memTotalMB: 131072, cpuUsagePct: 32, memUsagePct: 65, vmCount: 97, version: '8.0.3', vendor: 'Dell', model: 'R750', powerWatts: 400, tempC: 24.5 },
  { name: 'esx01', cluster: 'HQ-Admin', connectionState: 'CONNECTED', cpuCores: 32, cpuThreads: 64, memTotalMB: 131072, cpuUsagePct: 43, memUsagePct: 62, vmCount: 76, version: '8.0.3', vendor: 'Dell', model: 'R750', powerWatts: 420, tempC: 25.5 },
  // 클러스터 미소속 → standalone
  { name: 'esx99', cluster: '', connectionState: 'MAINTENANCE', cpuCores: 16, cpuThreads: 32, memTotalMB: 65536, cpuUsagePct: 1, memUsagePct: 10, vmCount: 3, version: '7.0.3', vendor: 'HPE', model: 'DL380', powerWatts: 200, tempC: 22 },
];
const VMS = [
  { name: 'a', host: 'esx01', cpuCount: 64, memMB: 65536, powerState: 'POWERED_ON' },
  { name: 'b', host: 'esx01', cpuCount: 32, memMB: 65536, powerState: 'POWERED_OFF' },
  { name: 'c', host: 'esx02', cpuCount: 16, memMB: 32768, powerState: 'POWERED_ON' },
  { name: 'd', host: 'esx99', cpuCount: 8, memMB: 8192, powerState: 'POWERED_ON' },
];
const onlyOn = (vms) => vms.filter((v) => v.powerState !== 'POWERED_OFF');
const rowsOf = (vms) => buildOverviewRows({ site: SITE, hosts: HOSTS, vms, metrics: METRICS });

describe('groupClusters / stateKo / ratioText', () => {
  it('클러스터 미지정은 standalone, 이름순 정렬', () => {
    expect(groupClusters(HOSTS).map(([k, v]) => [k, v.length])).toEqual([['HQ-Admin', 2], ['standalone', 1]]);
    expect(groupClusters(undefined)).toEqual([]);
  });
  it('상태 한글 표기 — 모르는 값은 원문', () => {
    expect(stateKo('CONNECTED')).toBe('정상');
    expect(stateKo('MAINTENANCE')).toBe('점검');
    expect(stateKo('WEIRD')).toBe('WEIRD');
    expect(stateKo(undefined)).toBe('');
  });
  it('가상화율은 소수 1자리(트리 배지와 동일), 분모/분자 없으면 빈 값', () => {
    expect(ratioText(96, 32)).toBe('3.0');
    expect(ratioText(14, 32)).toBe('0.4');
    expect(ratioText(10, 0)).toBe('');
    expect(ratioText(0, 32)).toBe('');
  });
});

describe('buildOverviewRows — 모든 클러스터·호스트가 한 번에', () => {
  it('vCenter → 클러스터 → (이름순) 호스트 순서로 전부 나온다', () => {
    const rows = rowsOf(VMS);
    expect(rows.map((r) => `${r.level}:${r.cluster}${r.host ? '/' + r.host : ''}`)).toEqual([
      'vCenter:',
      '클러스터:HQ-Admin',
      '호스트:HQ-Admin/esx01',
      '호스트:HQ-Admin/esx02',
      '클러스터:standalone',
      '호스트:standalone/esx99',
    ]);
  });

  it('vCenter 행 — 호스트수·VM수·사용률·가상화율과 근거 수치', () => {
    const [dc] = rowsOf(VMS);
    expect(dc.hostCount).toBe(3);
    expect(dc.vmCount).toBe(176);            // 97 + 76 + 3 (호스트가 보고한 VM 수 합)
    expect(dc.cpuPct).toBe(29);              // site.metrics 그대로
    expect(dc.memPct).toBe(63);
    expect(dc.vcpuAlloc).toBe(120);          // 64 + 32 + 16 + 8
    expect(dc.cpuCores).toBe(80);            // 32 + 32 + 16
    expect(dc.cpuThreads).toBe(160);
    expect(dc.cpuRatio).toBe('1.5');         // 120 / 80
    expect(dc.memAllocGB).toBe(168);         // (65536+65536+32768+8192)/1024
    expect(dc.memPhysGB).toBe(320);
    expect(dc.memRatio).toBe('0.5');
    expect(dc.powerW).toBe(1020);
  });

  it('클러스터 행 — CPU/MEM 사용률은 호스트 단순 평균(트리와 동일)', () => {
    const cl = rowsOf(VMS).find((r) => r.level === '클러스터' && r.cluster === 'HQ-Admin');
    expect(cl.hostCount).toBe(2);
    expect(cl.vmCount).toBe(173);
    expect(cl.cpuPct).toBe(38);              // (32 + 43) / 2 = 37.5 → 38
    expect(cl.memPct).toBe(64);              // (65 + 62) / 2 = 63.5 → 64
    expect(cl.vcpuAlloc).toBe(112);          // esx01 96 + esx02 16
    expect(cl.cpuRatio).toBe('1.8');         // 112 / 64
  });

  it('호스트 행 — 상태·VM수·가상화율 + 하드웨어 정보', () => {
    const h = rowsOf(VMS).find((r) => r.host === 'esx01');
    expect(h).toMatchObject({
      state: '정상', vmCount: 76, cpuPct: 43, memPct: 62,
      vcpuAlloc: 96, cpuCores: 32, cpuThreads: 64, cpuRatio: '3.0',
      memAllocGB: 128, memPhysGB: 128, memRatio: '1.0',
      version: '8.0.3', vendor: 'Dell', model: 'R750', powerW: 420, tempC: 25.5,
    });
    expect(rowsOf(VMS).find((r) => r.host === 'esx99').state).toBe('점검');
  });

  it("'Off VM 포함' 해제(켜진 VM 만 전달) 시 가상화율이 내려간다 — 분모는 그대로", () => {
    const all = rowsOf(VMS).find((r) => r.host === 'esx01');
    const on = rowsOf(onlyOn(VMS)).find((r) => r.host === 'esx01');
    expect(on.vcpuAlloc).toBe(64);           // 꺼진 32 vCPU 제외
    expect(on.cpuRatio).toBe('2.0');         // 64 / 32
    expect(on.cpuCores).toBe(all.cpuCores);  // 물리 코어(분모) 불변
    expect(on.memAllocGB).toBe(64);
    expect(on.memRatio).toBe('0.5');
    expect(on.vmCount).toBe(all.vmCount);    // 호스트 보고 VM 수는 전원 무관
  });

  it('빈 입력에도 vCenter 행 1개는 유지(크래시 없음)', () => {
    const rows = buildOverviewRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ level: 'vCenter', hostCount: 0, vmCount: 0, cpuRatio: '', memRatio: '' });
  });
});

describe('overviewCsv', () => {
  it('헤더는 표 라벨과 동일하고 행 수가 맞는다(CRLF)', () => {
    const rows = rowsOf(VMS);
    const csv = overviewCsv(rows);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(OVERVIEW_COLUMNS.map((c) => c.label).join(','));
    expect(lines[0]).toContain('CPU가상화율');
    expect(lines[0]).toContain('물리RAM(GB)');
    expect(lines).toHaveLength(rows.length + 1);
    expect(lines[1].startsWith('vCenter,OC2,')).toBe(true);
  });

  it('쉼표·따옴표가 든 값은 큰따옴표로 감싸고 이스케이프한다', () => {
    const rows = buildOverviewRows({
      site: { name: 'A,B' },
      hosts: [{ name: 'esx"1', cluster: 'cl,1', cpuCores: 4, memTotalMB: 4096, vmCount: 1 }],
      vms: [{ host: 'esx"1', cpuCount: 4, memMB: 2048 }],
    });
    const csv = overviewCsv(rows);
    expect(csv).toContain('"A,B"');
    expect(csv).toContain('"cl,1"');
    expect(csv).toContain('"esx""1"');
  });

  it('빈 값(null)은 빈 칸으로 나간다', () => {
    const csv = overviewCsv([{ level: '호스트', tempC: null, host: '' }], [
      { key: 'level', label: '구분' }, { key: 'host', label: '호스트' }, { key: 'tempC', label: '흡기온도(℃)' },
    ]);
    expect(csv.split('\r\n')[1]).toBe('호스트,,');
  });
});
