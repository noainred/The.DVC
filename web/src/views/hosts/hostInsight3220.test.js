// v3.22.0 — Hypervisor 탭 ‘분석’ 보기의 순수 계산(hosts/hostInsightText.js · insight-tools/hostToolPanelsText.js).
//   응답은 서버 집계 함수(vcenter/hostInsight.js hostInsightOf · 도구 요약 *SummaryByVc)로 만든 실제 모양 — 화면 계산을 같은 입력으로 대조한다.
import { describe, it, expect } from 'vitest';
import { pickRows } from '../insight/insightCore.js';
import { treemapLayout, fillStep, RAMP, CRIT_BG, NONE_BG } from '../insight/treemap.js';
import { VM_MAP_PREF_KEY, VM_FOLD_PREF_KEY } from '../vms/vmInsightText.js';
import {
  HOST_VIEWS, hostViewInHash, hostIdOfHash, hostViewOf, hostViewHash, sumHostRows, ratiosOf, kpiView, checkItems, fillDefs, SIZE_DEFS, mapGroups,
  hostTileColors, hostScale, n1FailOf, regionRows, mergedTops, CMP_CPU, esxiView, modelView, densityRows, safetyView, hostAvgMemGB, hostsEquivalent,
  groupShownOf, HOST_MAP_PREF_KEY, HOST_FOLD_PREF_KEY, n1PctText,
} from './hostInsightText.js';
import { contentionHostView, hostHygieneView, forecastView, pathsView, hostPanelsFor } from './insight-tools/hostToolPanelsText.js';

const { hostInsightOf } = await import('../../../../server/src/vcenter/hostInsight.js');
const { contentionSummaryByVc } = await import('../../../../server/src/contention/analyze.js');
const { hostCfgSummaryByVc } = await import('../../../../server/src/hostcfg/analyze.js');
const { storagePathsSummaryByVc, capacityForecastSummaryByVc } = await import('../../../../server/src/dscfg/summary.js');

const HOUR = 3_600_000; const DAY = 24 * HOUR; const GB = 1024;
const NOW = Math.floor(Date.now() / HOUR) * HOUR;   // 정시 경계로 고정(docs/rules/common.md)
const readable = (h) => h.connectionState !== 'DISCONNECTED' && h.connectionState !== 'NOT_RESPONDING';   // store.usageReadable 과 같은 규칙
const capKnown = (h) => !!h && [h.cpuCores, h.cpuTotalMhz, h.memTotalMB].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0);

const hc = (o = {}) => ({ at: NOW - HOUR, certNotAfter: NOW + 400 * DAY, services: { ssh: { running: false } }, mp: { luns: 4, shared: 4, paths: 8, dead: 0, deadLuns: [], singlePath: 0, singleLuns: [], policies: {} }, ...o });
const host = (vc, id, cluster, o = {}) => ({
  id: `${vc}:${id}`, vcenterId: vc, name: `${vc}-${id}`, cluster, clusterRef: cluster === 'standalone' ? null : `domain-${cluster}`,
  connectionState: 'CONNECTED', powerState: 'POWERED_ON', version: '8.0.2', vendor: 'Dell Inc.', model: 'PowerEdge R760',
  cpuCores: 32, cpuSockets: 2, cpuThreads: 64, cpuTotalMhz: 64000, cpuUsagePct: 40, memTotalMB: 512 * GB, memUsagePct: 50, powerWatts: 400,
  hcfg: hc(), perfc: { at: NOW - 60_000, diskMaxMs: { avg: 5 }, ds: [] }, ...o,
});
const vm = (vc, hostName, i, o = {}) => ({
  id: `${vc}:vm-${hostName}-${i}`, vcenterId: vc, name: `${hostName}-vm${i}`, host: hostName, powerState: 'POWERED_ON', template: false,
  cpuCount: 4, memMB: 8 * GB, cpuUsagePct: 10, memUsagePct: 20,
  perfc: { at: NOW - 60_000, samples: 15, readyPct: { avg: 2, max: 3 }, costopPct: { avg: 0, max: 0 }, latencyPct: { avg: 0, max: 0 }, readMs: { avg: 3, max: 5 }, writeMs: { avg: 2, max: 4 }, disk: 'scsi0:0' },
  ...o,
});
const HOSTS = [
  host('vc-a', 'h1', 'CL1', { cpuUsagePct: 95, memUsagePct: 93, hcfg: hc({ certNotAfter: NOW - 10 * DAY - HOUR, services: { ssh: { running: true } } }) }),
  host('vc-a', 'h2', 'CL1', { cpuUsagePct: 70, version: '7.0.3', hcfg: hc({ mp: { luns: 4, shared: 4, paths: 8, dead: 3, deadLuns: ['naa.1'], singlePath: 1, singleLuns: ['naa.2'], policies: {} } }) }),
  host('vc-a', 'h3', 'CL1', { cpuUsagePct: 20, model: 'PowerEdge R750' }),
  host('vc-a', 'h4', 'CL2', { connectionState: 'DISCONNECTED', cpuUsagePct: 0, memUsagePct: 0 }),
  host('vc-a', 'h5', 'CL2', { cpuUsagePct: 55, memUsagePct: 85 }),
  host('vc-a', 'h6', 'CL2', { cpuUsagePct: 60, memUsagePct: 80 }),
  host('vc-a', 'h7', 'standalone', { cpuUsagePct: 30, vendor: 'HPE', model: 'ProLiant DL380' }),
  host('vc-b', 'h1', 'BCL', { cpuCores: null, cpuTotalMhz: null, memTotalMB: null, cpuUsagePct: 30 }),
  host('vc-b', 'h2', 'BCL', { connectionState: 'MAINTENANCE', cpuUsagePct: 5, version: '6.7.0' }),
  host('vc-b', 'h3', 'BCL', { cpuUsagePct: 97 }),
  host('vc-c', 'h1', 'CCL', { cpuUsagePct: 92 }),
  host('vc-c', 'h2', 'CCL', { cpuUsagePct: 10 }),
];
const VMS = [];
for (let i = 0; i < 14; i++) VMS.push(vm('vc-a', 'vc-a-h1', i, i < 2 ? { perfc: { ...vm('', '', 0).perfc, readyPct: { avg: 12 + i, max: 20 } } } : {}));
for (let i = 0; i < 10; i++) VMS.push(vm('vc-a', 'vc-a-h2', i));
for (let i = 0; i < 20; i++) VMS.push(vm('vc-b', 'vc-b-h3', i));
for (let i = 0; i < 5; i++) VMS.push(vm('vc-c', 'vc-c-h1', i));
const VCS = [
  { id: 'vc-a', name: 'VC-A', status: 'connected', location: { region: '유럽', city: 'Warsaw', country: 'PL' }, clusterCfg: [
    { ref: 'domain-CL1', name: 'CL1', ha: { enabled: true, admission: true }, drs: { enabled: true, behavior: 'fullyAutomated' }, evc: 'intel', numHosts: 3 },
    { ref: 'domain-CL2', name: 'CL2', ha: { enabled: false }, drs: { enabled: true, behavior: 'manual' }, evc: '', numHosts: 3 },
  ] },
  { id: 'vc-b', name: 'VC-B', status: 'connected', location: { region: '아시아', city: 'Seoul', country: 'KR' } },
  { id: 'vc-c', name: 'VC-C', status: 'connected', location: { region: '아시아', city: 'Busan', country: 'KR' } },
  { id: 'vc-down', name: 'VC-DOWN', status: 'unreachable', location: { region: '북미' } },
];
const ALL = { cluster: true, hw: true, hygiene: true };
const CHECKS = { access: { hw: true, hygiene: true }, byId: {
  'vc-a:h1': { hw: { state: 'fault' }, boot: { kind: 'unexpected' } }, 'vc-a:h2': { hw: { state: 'warn' }, boot: { kind: 'planned' } }, 'vc-b:h3': { hw: { state: 'ok' } },
} };
const build = async (o = {}) => ({ ok: true, initial: false, region: null, ...(await hostInsightOf({ vcenters: VCS, hosts: HOSTS, vms: VMS, readable, capKnown, access: ALL, checks: CHECKS, bootDays: 30, now: NOW, ...o })) });
const R = await build();
const rowOf = (id) => R.rows.find((r) => r.id === id);

describe('보기 줄 · 주소 호환', () => {
  it('분석 · 목록 · 법인별 — 주소 #/hosts/<보기> · #/hosts 는 분석', () => {
    expect(HOST_VIEWS.map(([k, l]) => `${k}:${l}`)).toEqual(['insight:분석', 'list:목록', 'corp:법인별']);
    expect(hostViewOf(hostViewInHash('#/hosts'))).toBe('insight');
    expect(hostViewOf(hostViewInHash('#/hosts/corp'))).toBe('corp');   // 법인별 주소
    expect(hostViewOf(hostViewInHash('#/hosts/list'))).toBe('list');
    expect(hostViewOf(null, { nameFocus: 'esx-01' })).toBe('list');      // VM 표에서 넘어온 ‘그 호스트만’ 은 목록에서 보인다
    expect(hostViewOf(null, { q: 'abc' })).toBe('list');
    expect(hostViewOf('corp', { q: 'abc' })).toBe('corp');
    expect(hostViewHash('corp')).toBe('#/hosts/corp');
    expect(hostViewHash('x')).toBe('#/hosts/insight');
  });
  it('저장된 상세 주소 #/hosts/<id> 는 그대로 상세 — 보기 키는 id 가 아니다', () => {
    expect(hostIdOfHash('#/hosts/vc-a%3Ahost-12')).toBe('vc-a:host-12');
    expect(hostIdOfHash('#/hosts/vc-a:host-12')).toBe('vc-a:host-12');
    for (const k of ['insight', 'list', 'corp']) expect(hostIdOfHash(`#/hosts/${k}`)).toBe('');
    expect(hostIdOfHash('#/hosts')).toBe('');
    expect(hostIdOfHash('#/vms/x')).toBe('');
  });
  it('지도 · 접힘 기억 키는 VM 화면과 다르다', () => {
    expect(HOST_MAP_PREF_KEY).not.toBe(VM_MAP_PREF_KEY);
    expect(HOST_FOLD_PREF_KEY).not.toBe(VM_FOLD_PREF_KEY);
  });
});

describe('법인 줄 합 — 고른 법인 · 오래됨 · 모름', () => {
  it('두 법인 합 = 각 줄의 합 · 평균은 Σsum ÷ Σn', () => {
    const a = rowOf('vc-a'); const b = rowOf('vc-b');
    const s = sumHostRows([a, b]);
    expect(s.hosts.total).toBe(a.hosts.total + b.hosts.total);
    expect(s.hosts.down).toBe(a.hosts.down + b.hosts.down);
    expect(s.cpuAvg.value).toBe(Math.round(((a.cpuAvg.sum + b.cpuAvg.sum) / (a.cpuAvg.n + b.cpuAvg.n)) * 10) / 10);
    expect(s.cpuHist.reduce((x, y) => x + y, 0)).toBe(a.cpuAvg.n + b.cpuAvg.n);   // 칸에는 읽은 호스트만
    expect(s.usageUnknown.cpu).toBe(1);                                        // 끊긴 vc-a h4 — 0% 로 세지 않는다
    expect(s.esxi.versions['8.0.2']).toBe(a.esxi.versions['8.0.2'] + b.esxi.versions['8.0.2']);
  });
  it('오래됨 · 모름 법인은 합에 넣지 않고 따로', () => {
    const rows = R.rows.map((r) => (r.id === 'vc-c' ? { ...r, stale: true } : r));
    const p = pickRows(rows, []);
    expect(p.stale.map((r) => r.id)).toEqual(['vc-c']);
    expect(p.unknown.map((r) => r.id)).toEqual(['vc-down']);   // 개수를 모르는 법인(수 칸이 전부 null)
    expect(rowOf('vc-down').hosts).toBeNull();
    expect(sumHostRows(p.used).hosts.total).toBe(10);
  });
  it('비율 — 한 법인은 서버 값 그대로 · 여럿은 같은 규칙(용량 모름이 있으면 null)', () => {
    const a = rowOf('vc-a');
    expect(ratiosOf([a], sumHostRows([a]))).toEqual({ vcpuPerCore: a.vcpuPerCore, ramPct: a.ramPct });
    const ac = sumHostRows([a, rowOf('vc-c')]);
    expect(ac.vcpuPerCore).toBe(Math.round((ac.vcpu / ac.cores) * 10) / 10);
    expect(sumHostRows([a, rowOf('vc-b')]).vcpuPerCore).toBeNull();   // vc-b 에 용량 모름 호스트 — 모자란 분모로 지어내지 않는다
  });
  it('줄이 없으면 수는 0 이 아니라 null', () => {
    const s = sumHostRows([]);
    expect(s.hosts).toBeNull();
    expect(kpiView(s, 0)[0].value).toBe('—');
  });
});

describe('확인할 것 · 권한 없는 칸 숨김', () => {
  it('전 권한 — 서버 판정 그대로 6칸', () => {
    const s = sumHostRows([rowOf('vc-a'), rowOf('vc-b'), rowOf('vc-c')]);
    const c = checkItems(s, R.access, R.thresholds);
    expect(c.map((x) => x.key)).toEqual(['overload', 'hw', 'reboot', 'n1', 'ha', 'downMaint']);
    expect(c[0].value).toBe(s.overloaded);
    expect(c[0].sub).toBe(`CPU ${R.thresholds.overloadPct}% 초과`);
    expect(c[1].value).toBe(2);                     // 장애 1 + 경고 1
    expect(c[2].value).toBe(1);
    expect(c[2].label).toBe('예기치 않은 재부팅(30일)');
    expect(c[4].value).toBe(1);                     // CL2 HA 꺼짐
    expect(c[5].value).toBe(2);                     // 끊김 1 + 점검 1
  });
  it('권한이 없으면 칸이 0 이 아니라 없다 — 서버도 키를 싣지 않는다', async () => {
    const r = await build({ access: { cluster: false, hw: false, hygiene: false }, checks: null, bootDays: null });
    expect('hw' in r.rows[0]).toBe(false);
    expect(Object.keys(r.rows.find((x) => x.id === 'vc-a').clusters)).toEqual(['total']);
    const c = checkItems(sumHostRows(r.rows.filter((x) => !x.unknown)), r.access, r.thresholds);
    expect(c.map((x) => x.key)).toEqual(['overload', 'downMaint']);
    expect(safetyView(sumHostRows(r.rows).clusters, r.access)).toBeNull();
    expect(fillDefs(r.thresholds, r.access).map((f) => f.key)).toEqual(['max', 'cpu', 'mem']);
    expect(r.clusters.every((x) => !('n1Ok' in x))).toBe(true);
  });
});

describe('가상화 호스트 현황 — 칸 배치 · 색 · S6 · 못 버팀', () => {
  it('처음 색 = 한 대 빠진 뒤 메모리 · 파랑 3단 + 경계 이상만 빨강', () => {
    const f = fillDefs(R.thresholds, R.access);
    expect(f.map((x) => x.key)).toEqual(['n1mem', 'max', 'cpu', 'mem']);
    expect(f[0].steps).toEqual([50, 75]);
    expect(f[0].crit).toBe(R.thresholds.n1LimitPct);
    expect(hostTileColors(fillStep(40, f[1])).bg).toBe(RAMP[1]);
    expect(hostTileColors(fillStep(60, f[1])).bg).toBe(RAMP[2]);
    expect(hostTileColors(fillStep(80, f[1])).bg).toBe(RAMP[3]);
    expect(hostTileColors(fillStep(90, f[1])).bg).toBe(CRIT_BG);
    expect(hostTileColors(fillStep(null, f[1])).bg).toBe(NONE_BG);   // 모름은 회색(0 단계가 아니다)
    expect(hostScale(f[1]).map((x) => x.text)).toEqual(['50% 미만', '50–75%', '75–90%', '90% 이상(경고)', '값 모름']);
  });
  it('칸 = 클러스터 · 독립 호스트는 법인마다 한 칸 · 고르는 id = 법인 · 모름 법인은 칸이 없다', () => {
    const groups = mapGroups(R.clusters, R.rows, SIZE_DEFS[0]);
    const layout = treemapLayout(groups);
    const tiles = layout.cols.flatMap((c) => c.tiles);
    expect(tiles.map((t) => t.label).sort()).toEqual(['BCL', 'CCL', 'CL1', 'CL2', '독립 호스트']);
    expect(tiles.find((t) => t.label === '독립 호스트').pick).toBe('vc-a');
    expect(new Set(tiles.map((t) => t.pick))).toEqual(new Set(['vc-a', 'vc-b', 'vc-c']));
    expect(layout.cols.map((c) => c.label).sort()).toEqual(['아시아', '유럽']);
    expect(tiles.reduce((a, t) => a + t.size, 0)).toBe(12);   // 크기 = 호스트 수
  });
  it('‘못 버팀’ 은 서버 n1Ok === false 만(모름 · 독립 호스트는 표 없음)', () => {
    const cl2 = R.clusters.find((c) => c.name === 'CL2');
    const alone = R.clusters.find((c) => c.standalone);
    expect(n1FailOf(alone)).toBe(false);
    expect(n1FailOf({ n1Ok: null })).toBe(false);
    expect(n1FailOf(cl2)).toBe(cl2.n1Ok === false);
  });
  it('한 대 빠진 뒤 값 999(남은 용량 없음 — 서버 n1)는 ‘999%’ 가 아니라 ‘수용 불가’', async () => {
    const { n1Groups } = await import('../../../../server/src/clustercfg/n1.js');
    const one = n1Groups([host('va', 'solo', 'ONE')], readable);
    const row = (Array.isArray(one) ? one : [...(one?.values?.() || [])]).map((x) => x.row || x).find((x) => x && x.cluster === 'ONE');
    expect(row.memAfterFailPct).toBe(999);   // 서버 표지(남은 호스트 용량 0)
    expect(row.n1Ok).toBe(false);
    expect(n1PctText(row.memAfterFailPct)).toBe('수용 불가');
    expect(n1PctText(87.4)).toBe('87%');
    expect(n1PctText(null)).toBe('—');
  });
  it('지역별 분포 — 합에 넣은 법인만 · 호스트 많은 순', () => {
    const used = R.rows.filter((r) => !r.unknown);
    const g = regionRows(used, 12);
    expect(g.map((x) => [x.key, x.n])).toEqual([['유럽', 7], ['아시아', 5]]);
    expect(g[1].cities).toBe('Seoul 3 · Busan 2');
  });
});

describe('상위 N 병합 · 분포 · S2', () => {
  it('법인별 상위 N 의 합집합에서 다시 고른 N = 전체에서 고른 N', async () => {
    const big = await build({ topN: 100 });
    const want = big.top.flatMap((t) => t.cpuTop).sort(CMP_CPU).slice(0, 3).map((x) => x.id);
    const got = mergedTops((await build({ topN: 3 })).top, ['vc-a', 'vc-b', 'vc-c'], 3).cpuTop.map((x) => x.id);
    expect(got).toEqual(want);
    expect(got[0]).toBe('vc-b:h3');
  });
  it('못 버티는 클러스터 목록에 법인 id 를 붙인다 · 고르지 않은 법인은 빠진다', () => {
    const t = mergedTops(R.top, ['vc-b'], 5);
    expect(t.n1Fail.every((x) => x.vcenterId === 'vc-b')).toBe(true);
    const all = mergedTops(R.top, ['vc-a', 'vc-b', 'vc-c'], 5);
    expect(all.n1Fail.length).toBe(R.top.reduce((a, x) => a + (x.n1Fail?.length || 0), 0));
  });
  it('ESXi — 새 버전이 위 · 세대 묶음 · 못 읽음 따로', () => {
    const e = esxiView(sumHostRows(R.rows.filter((r) => !r.unknown)).esxi);
    expect(e.rows.map((x) => x.name)).toEqual(['ESXi 8.0.2', 'ESXi 7.0.3', 'ESXi 6.7.0']);
    expect(e.genSegs.map((x) => x.label)).toEqual(['ESXi 8', 'ESXi 7', 'ESXi 6']);
  });
  it('서버 모델 · 제조사 · VM 밀도 구간 이름', () => {
    const s = sumHostRows(R.rows.filter((r) => !r.unknown));
    const m = modelView(s.model, s.vendor, 1);
    expect(m.rows[0]).toMatchObject({ name: 'PowerEdge R760', n: 10 });
    expect(m.rows[1].name).toBe('그 밖 2종');
    expect(m.vendorText).toBe('제조사 — Dell Inc. 11 · HPE 1');
    expect(densityRows(s.vmsPerHost, R.thresholds.vmsPerHostEdges).map((x) => x.name)).toEqual(['9대 이하', '10–12대', '13–15대', '16대 이상']);
    expect(densityRows(s.vmsPerHost, R.thresholds.vmsPerHostEdges).map((x) => x.n)).toEqual([9, 1, 1, 1]);
  });
  it('S2 — 메모리 여유를 호스트 대수로(용량 읽은 호스트 평균 · 오래됨 제외)', () => {
    const used = [rowOf('vc-a'), rowOf('vc-b')];
    const avg = hostAvgMemGB(used);
    expect(avg).toBe(512);                         // 용량 모름 vc-b h1 은 분모에서도 빠진다
    expect(hostsEquivalent(1024, avg)).toBe(2);
    expect(hostAvgMemGB([{ ...rowOf('vc-a'), stale: true }])).toBeNull();
  });
  it('묶음 — 도구 권한이 없으면 숨긴다(용량은 두 도구 중 하나라도)', () => {
    expect(groupShownOf(() => false)).toEqual({ perf: false, config: false, capacity: false, dist: true });
    expect(groupShownOf((k) => k === 'storage-paths').capacity).toBe(true);
  });
});

describe('특수 기능 요약 패널 — 도구 판정 그대로 합 · 상위 병합', () => {
  const snap = { vcenters: VCS, hosts: HOSTS, vms: VMS, datastores: [] };
  const vcName = new Map(VCS.map((v) => [v.id, v.name]));
  it('경합(호스트) — 법인 합 · 고른 법인만', () => {
    const resp = contentionSummaryByVc(snap, { now: NOW, vcName, topN: 5 });
    const v = contentionHostView(resp, []);
    expect(v.hostsReadyCrit).toBe(1);                     // 대기 심각 VM 이 있는 호스트 = vc-a h1
    expect(v.hosts[0].name).toBe('vc-a-h1');
    expect(contentionHostView(resp, ['vc-b']).hostsReadyCrit).toBe(0);
  });
  it('ESXi 호스트 구성 점검 — 심각 · 경고 종류만 · 인증서 만료 목록', () => {
    const resp = { ...hostCfgSummaryByVc(snap, { now: NOW, vcName, topN: 5 }), partial: false, notReadVcenters: [] };
    const v = hostHygieneView(resp, []);
    expect(v.certExpired).toBe(1);
    expect(v.ssh).toBe(1);
    expect(v.certList.map((x) => x.name)).toEqual(['vc-a-h1']);
    expect(v.codes.every((c) => c.sev === 'crit' || c.sev === 'warn')).toBe(true);
    expect(v.codes[0].title).toBe('호스트 인증서가 만료됐습니다');
  });
  it('경로 · 용량 예측 — 합 · 상위 순서', () => {
    const p = pathsView(storagePathsSummaryByVc(snap, { vcName, topN: 5 }), []);
    expect(p.dead).toBe(3);
    expect(p.deadHosts[0].name).toBe('vc-a-h2');
    const items = [
      { id: 'ds1', name: 'ds1', vcenterId: 'vc-a', usagePct: 95, daysToFull: 20 },
      { id: 'ds2', name: 'ds2', vcenterId: 'vc-b', usagePct: null, daysToFull: null },
      { id: 'ds3', name: 'ds3', vcenterId: 'vc-c', usagePct: 40, daysToFull: 60 },
    ];
    const f = forecastView({ summary: true, ...capacityForecastSummaryByVc(items, { vcenters: VCS }, { vcName, topN: 5 }) }, ['vc-a', 'vc-c']);
    expect(f.soon).toBe(2);
    expect(f.soonest.map((x) => x.id)).toEqual(['ds1', 'ds3']);
    expect(f.usageUnknown).toBe(0);                       // 고르지 않은 vc-b 의 모름은 세지 않는다
  });
  it('패널 권한 — 없는 도구의 패널은 없다', () => {
    expect(hostPanelsFor('perf', () => false)).toEqual([]);
    expect(hostPanelsFor('capacity', (k) => k === 'forecast')).toEqual(['ds']);
    expect(hostPanelsFor('config', (k) => k === 'host-hygiene')).toEqual(['hygiene']);
  });
});
