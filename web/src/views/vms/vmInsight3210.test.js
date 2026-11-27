// v3.21.0 — VM 탭 ‘분석’ 보기(vmInsightText.js · vmHubText.js 보기 키)의 순수 계산.
//   ① 서버 대조: 법인별 줄(서버 vmInsightOf)을 화면이 더한 값 = 같은 VM 을 한 법인으로 서버가 센 값 · 상위 N 병합 = 서버의 상위 N
//   ② 오래됨 법인 제외 ③ OS ‘그 밖’ 접기 · 크기 구간 이름 · 하드웨어 버전 ④ 호스트 대수 환산(S2) ⑤ 지도 색 기준 · S6 경계는 응답 값
//   ⑥ 보기 키 — 분석(기본) · 목록(옛 ‘현황’) · 저장된 주소 · 검색어 · 호스트 조건이면 목록 · 과할당은 권한이 있을 때만
import { describe, it, expect } from 'vitest';
import {
  sumVmRows, sumOs, mergedTops, kpiView, checkBase, fillDefs, SIZE_DEFS, mapGroups, regionRows, osRows, sizeBinRows, hwRows, snapBands,
  hostAvgMemGB, hostsEquivalent, wasteSum, VM_STAT_KEYS, VM_FOLD_KEYS, CMP_CPU, arrangeChecks,
} from './vmInsightText.js';
import { HUB_VIEWS, HUB_VIEW_KEYS, hubDefaultView, hubViewOf } from './vmHubText.js';
import { pickRows } from '../insight/insightCore.js';
import { treemapLayout, fillStep } from '../insight/treemap.js';

const { vmInsightOf } = await import('../../../../server/src/inventory/vmInsight.js');
const { signalContext } = await import('../../../../server/src/inventory/vmSignals.js');

const HOUR = 3_600_000; const DAY = 86_400_000;
const ago = (d) => Date.now() - d * DAY - HOUR;
const vm = (vc, name, o = {}) => ({
  id: `${vc}:${name}`, vcenterId: vc, name, host: 'h1', powerState: 'POWERED_ON', template: false, guestOS: 'Ubuntu Linux (64-bit)',
  cpuCount: 2, memMB: 4096, storageGB: 100, cpuUsagePct: 15, memUsagePct: 25, toolsStatus: 'RUNNING', toolsVersionStatus: 'guestToolsCurrent',
  hwVersion: 'vmx-19', connectionState: 'connected', snapshotCount: 0, snapshotSizeGB: 0, ...o,
});
const VMS = [
  vm('va', 'a1', { cpuUsagePct: 95, memUsagePct: 50, cpuCount: 8, memMB: 16384 }),
  vm('va', 'a2', { cpuUsagePct: null, memUsagePct: null }),
  vm('va', 'a3', { cpuUsagePct: 40, guestOS: 'Microsoft Windows Server 2019 (64-bit)', toolsVersionStatus: 'guestToolsNeedUpgrade' }),
  vm('va', 'a4', { powerState: 'POWERED_OFF', cpuUsagePct: 0, memUsagePct: 0, storageGB: 300, snapshotCount: 2, snapshotSizeGB: 40, snapshotOldestTs: ago(100) }),
  vm('va', 'a5', { cpuUsagePct: 70, snapshotCount: 1, snapshotSizeGB: 90.3, snapshotOldestTs: ago(10), cpuCount: null }),
  vm('va', 'tpl', { template: true, powerState: 'POWERED_OFF', cpuUsagePct: 0, memUsagePct: 0, toolsVersionStatus: 'guestToolsNeedUpgrade', storageGB: 50 }),
  vm('vb', 'b1', { cpuUsagePct: 60, connectionState: 'orphaned', guestOS: 'Rocky Linux 9 (64-bit)', memMB: 65536 * 2 }),
  vm('vb', 'b2', { cpuUsagePct: 5, storageGB: null, hwVersion: 'vmx-17', cpuCount: 32 }),
  vm('vb', 'b3', { cpuUsagePct: 80, guestOS: 'unknown', hwVersion: '' }),
  ...[10, 20, 30, 40, 50, 60, 70, 80].map((c, i) => vm('vc', `c${i + 1}`, { cpuUsagePct: c, memUsagePct: 100 - c, snapshotCount: 1, snapshotSizeGB: 10 * (i + 1) + 0.1, snapshotOldestTs: ago(8 + i * 11) })),
];
const vcOf = (id, region) => ({ id, name: id, status: 'connected', location: { region, city: `${id}-city` } });
const CTX = signalContext({ snapAgeDays: 7, snapCount: 3, snapSizeGB: 100, exceptions: [] }, Date.now());
const per = await vmInsightOf({ vcenters: [vcOf('va', '유럽'), vcOf('vb', '유럽'), vcOf('vc', '아시아')], vms: VMS, ctx: CTX });
const one = await vmInsightOf({ vcenters: [vcOf('all', '유럽')], vms: VMS.map((v) => ({ ...v, vcenterId: 'all' })), ctx: CTX });
const pickStats = (r) => Object.fromEntries(VM_STAT_KEYS.map((k) => [k, r[k]]));

describe('① 서버 대조 — 법인별 줄의 합 = 한 법인으로 센 값', () => {
  it('수 · 합 · 분포 · 회수 후보 · 평균(Σsum ÷ Σn)', () => {
    const s = sumVmRows(per.rows);
    const want = pickStats(one.rows[0]);
    const got = pickStats(s);
    // 부동소수 합(디스크 · 스냅샷 GB)은 소수 한 자리로 비교
    const r1 = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v)));
    expect(r1(got)).toEqual(r1(want));
    expect(s.cpuAvg.value).toBe(one.rows[0].cpuAvg.value);
    expect(s.total).toBe(VMS.length);
    expect(s.signals.snapOld).toBeGreaterThan(5); expect(s.reclaim.orphan).toBe(1); expect(s.vcpuUnknown).toBe(1);
  });
  it('OS — 계열 · 종류(이름으로 합침) · 모름(null)', () => {
    const s = sumVmRows(per.rows);
    expect(s.os.family).toEqual(one.rows[0].os.family);
    const norm = (l) => l.map((k) => [k.name, k.count]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(norm(s.os.kinds)).toEqual(norm(one.rows[0].os.kinds));
    expect(s.os.kinds.some((k) => k.name == null)).toBe(true);
  });
  it('상위 N — 고른 법인의 목록을 합쳐 다시 N = 서버가 한 법인으로 고른 N', () => {
    const t = mergedTops(per.top, per.rows.map((r) => r.id), 5);
    const ids = (l) => l.map((x) => x.id.split(':')[1]);
    expect(t.cpuTop).toHaveLength(5); expect(t.snapOldest).toHaveLength(5); expect(t.snapBiggest).toHaveLength(5);   // 대조가 빈 목록끼리가 아니다
    expect(ids(t.cpuTop)).toEqual(ids(one.top[0].cpuTop));
    expect(ids(t.snapOldest)).toEqual(ids(one.top[0].snapOldest));
    expect(ids(t.snapBiggest)).toEqual(ids(one.top[0].snapBiggest));
    // 고른 법인만 — 그 법인 목록 밖은 들어오지 않는다
    expect(mergedTops(per.top, ['vb'], 5).cpuTop.every((x) => x.vcenterId === 'vb')).toBe(true);
    expect(mergedTops(per.top, [], 5).cpuTop).toEqual([]);
  });
  it('비교 순서는 서버와 같다(CPU 큰 순 → 메모리 큰 순 → 이름)', () => {
    const l = [{ id: '1', name: 'b', cpu: 50, mem: 10 }, { id: '2', name: 'a', cpu: 50, mem: 10 }, { id: '3', name: 'c', cpu: 50, mem: 30 }, { id: '4', name: 'd', cpu: 90, mem: null }];
    expect(l.sort(CMP_CPU).map((x) => x.id)).toEqual(['4', '3', '2', '1']);
  });
});

describe('② 오래됨 · 모름 법인은 합에 섞지 않는다', () => {
  it('stale 줄은 합에서 빠지고 따로 · 모름 줄의 null 은 0 으로 더하지 않는다', () => {
    const rows = per.rows.map((r) => (r.id === 'vb' ? { ...r, stale: true } : r));
    const p = pickRows(rows, []);
    expect(p.stale.map((r) => r.id)).toEqual(['vb']);
    const s = sumVmRows(p.used);
    expect(s.total).toBe(VMS.filter((v) => v.vcenterId !== 'vb').length);
    const none = sumVmRows([]);
    expect(none.total).toBe(null);
    expect(kpiView(none, 0)[0].value).toBe('—');
  });
  it('줄이 없을 때 OS 합', () => {
    expect(sumOs([])).toEqual({ family: null, kinds: [], kindsRest: null });
  });
});

describe('③ OS 접기 · 크기 구간 · 하드웨어 버전', () => {
  it('많은 순 N 종 + ‘그 밖’(접은 종류 + 서버 kindsRest) + ‘OS 모름’ 따로', () => {
    const os = { kinds: [{ name: 'A', family: 'linux', count: 9 }, { name: 'B', family: 'windows', count: 5 }, { name: null, family: null, count: 4 }, { name: 'C', family: 'linux', count: 2 }, { name: 'D', family: 'other', count: 1 }], kindsRest: 7 };
    const r = osRows(os, 2);
    expect(r.map((x) => [x.name, x.n])).toEqual([['A', 9], ['B', 5], ['그 밖 2종', 10], ['OS 모름', 4]]);
    expect(osRows({ kinds: [{ name: 'A', count: 1 }], kindsRest: 0 }, 8).map((x) => x.name)).toEqual(['A']);
  });
  it('크기 구간 — 서버 키 k = 앞 키 초과 k 이하', () => {
    const v = sizeBinRows({ 1: 3, 2: 4, 4: 1, 8: 0, 16: 2, more: 1, unknown: 5 }, [1, 2, 4, 8, 16], 'vCPU');
    expect(v.rows.map((x) => x.name)).toEqual(['1 vCPU', '2 vCPU', '3–4 vCPU', '5–8 vCPU', '9–16 vCPU', '17 vCPU 이상']);
    expect(v.rows.map((x) => x.n)).toEqual([3, 4, 1, 0, 2, 1]);
    expect(v.unknown).toBe(5);
    const m = sizeBinRows({}, [2, 4, 64], 'GB');
    expect(m.rows.map((x) => x.name)).toEqual(['2 GB 이하', '2–4 GB', '4–64 GB', '64 GB 초과']);
    expect(m.rows.every((x) => x.n === null)).toBe(true);    // 모르면 null(0 이 아니다)
  });
  it('하드웨어 버전 — 많은 순 + 그 밖 · 못 읽음 따로', () => {
    const h = hwRows({ versions: { 'vmx-19': 5, 'vmx-17': 9, 'vmx-13': 1 }, rest: 2, unread: 3 }, 2);
    expect(h.rows.map((x) => [x.name, x.n])).toEqual([['vmx-17', 9], ['vmx-19', 5], ['그 밖', 3]]);
    expect(h.unread).toBe(3);
  });
  it('스냅샷 구간 이름은 응답의 기준 일수 · 경계', () => {
    expect(snapBands({ snapAge: { d7_30: 1, d30_90: 2, d90p: 3 } }, { snapAgeDays: 14, snapAgeEdgesDays: [30, 90] }).map((b) => [b.label, b.n]))
      .toEqual([['14–30일', 1], ['30–90일', 2], ['90일 이상', 3]]);
    expect(snapBands({}, {})[0]).toMatchObject({ label: '기준–—일', n: null });
  });
});

describe('④ S2 — 호스트 약 N대분', () => {
  const corps = [
    { id: 'va', hosts: 4, capUnknown: 0, memTotalGB: 2048 },
    { id: 'vb', hosts: 3, capUnknown: 1, memTotalGB: 1024 },
    { id: 'vc', hosts: null, memTotalGB: null },
    { id: 'vd', hosts: 2, capUnknown: 0, memTotalGB: 9999, stale: true },
  ];
  it('고른 범위 호스트 한 대의 평균 메모리 — 용량을 읽은 호스트만 · 오래됨 제외', () => {
    expect(hostAvgMemGB(corps, [])).toBeCloseTo(3072 / 6, 9);
    expect(hostAvgMemGB(corps, ['vb'])).toBe(512);
    expect(hostAvgMemGB(corps, ['vc'])).toBe(null);
    expect(hostAvgMemGB(null, [])).toBe(null);
  });
  it('환산 — 기준이 없으면 null(문구 생략)', () => {
    expect(hostsEquivalent(1024, 512)).toBe(2);
    expect(hostsEquivalent(1134, 589)).toBe(1.9);
    expect(hostsEquivalent(1024, null)).toBe(null);
    expect(hostsEquivalent(null, 512)).toBe(null);
  });
  it('Optimization 요약 합 — 고른 법인 · 후보 수 · 미사용 메모리', () => {
    const rows = [{ vcenterId: 'va', cpu: { candidates: 2 }, mem: { candidates: 3, idleMB: 2048 } }, { vcenterId: 'vb', cpu: { candidates: 1 }, mem: { candidates: null, idleMB: 1024 } }];
    expect(wasteSum(rows, [])).toMatchObject({ cpuCand: 3, memCand: 3, memIdleMB: 3072 });
    expect(wasteSum(rows, ['vb'])).toMatchObject({ cpuCand: 1, memCand: null });
    expect(wasteSum(rows, ['zz'])).toBe(null);
  });
});

describe('⑤ 지도 — 색 · 크기 기준', () => {
  it('S6 경계는 응답의 과부하 % — 평균 CPU · 메모리만 · 디스크 기준은 게스트 파티션 요약이 있을 때만', () => {
    const d = fillDefs({ overloadPct: 85 });
    expect(d.map((f) => f.key)).toEqual(['att', 'cpu', 'mem']);
    expect(d.find((f) => f.key === 'cpu').crit).toBe(85);
    expect(d.find((f) => f.key === 'att').crit).toBe(null);
    expect(fillStep(86, d.find((f) => f.key === 'cpu')).over).toBe(true);
    const gp = new Map([['va', { overVms: 3, reported: 30 }]]);
    const d2 = fillDefs({ overloadPct: 90 }, gp);
    const disk = d2.find((f) => f.key === 'disk');
    expect(disk.val({ id: 'va' })).toBe(10);
    expect(disk.val({ id: 'vb' })).toBe(null);       // 요약에 없는 법인은 모름(회색)
    expect(fillDefs({}).find((f) => f.key === 'cpu').crit).toBe(null);
  });
  it('지역별 칸 · 모름 법인은 칸 없음 · 크기 기준', () => {
    const rows = [...per.rows, { id: 'down', name: 'down', region: '북미', unknown: true, total: null }];
    const L = treemapLayout(mapGroups(rows, SIZE_DEFS[0]));
    expect(L.cols.map((c) => c.key)).toEqual(['유럽', '아시아']);
    expect(L.hidden.map((t) => t.id)).toEqual(['down']);
    expect(L.cols[0].tiles.map((t) => t.id)).toEqual(['va', 'vb']);
    const reg = regionRows(per.rows, VMS.length);
    expect(reg.map((g) => [g.key, g.n])).toEqual([['유럽', 9], ['아시아', 8]]);
    expect(reg[0].share).toBe('53%');
  });
});

describe('⑥ 보기 키 · 확인할 것 · 묶음', () => {
  it('보기 줄 — 분석 · 목록 · 법인별 · 조치 필요 · 과할당(옛 키 list · corp · attention 그대로)', () => {
    expect([...HUB_VIEW_KEYS]).toEqual(['insight', 'list', 'corp', 'attention', 'over']);
    expect(HUB_VIEWS.map(([, l]) => l)).toEqual(['분석', '목록', '법인별', '조치 필요', '과할당']);
  });
  it('#/vms = 분석 · 저장된 주소는 그대로 · 검색어 · 호스트 조건이면 목록 · 과할당은 권한이 있을 때만', () => {
    expect(hubViewOf(null)).toBe('insight');
    expect(hubViewOf('list')).toBe('list');
    expect(hubViewOf('corp')).toBe('corp');
    expect(hubViewOf('attention')).toBe('attention');
    expect(hubViewOf('nope')).toBe('insight');
    expect(hubViewOf(null, { q: 'srv-1' })).toBe('list');
    expect(hubViewOf(null, { host: 'esx01' })).toBe('list');
    expect(hubViewOf('insight', { q: 'srv-1' })).toBe('insight');   // 주소로 고른 보기는 그대로
    expect(hubViewOf('over', { canOver: true })).toBe('over');
    expect(hubViewOf('over', { canOver: false })).toBe('insight');
    expect(hubDefaultView({ q: '   ' })).toBe('insight');
  });
  it('확인할 것(VM 집계 쪽) — 순서 · 못 읽으면 null', () => {
    const c = checkBase(sumVmRows(per.rows), { snapAgeDays: 7 });
    expect(c.head.map((x) => x.key)).toEqual(['overload']);
    expect(c.tail.map((x) => x.key)).toEqual(['snapOld', 'toolsOld', 'orphan', 'off']);
    expect(c.tail[0].sub).toBe('7일 넘긴 VM');
    expect(c.tail.find((x) => x.key === 'off').href).toBeUndefined();
    expect(checkBase(sumVmRows([]), { wasteHref: '#/tools/waste' }).tail.map((x) => x.value)).toEqual([null, null, null, null]);
    expect(checkBase({}, { wasteHref: '#/tools/waste' }).tail.find((x) => x.key === 'off').href).toBe('#/tools/waste');
  });
  it('묶음 키(접힘 기억 값)', () => {
    expect([...VM_FOLD_KEYS]).toEqual(['now', 'capacity', 'perf', 'config', 'dist']);
  });
  it('문구에 백틱이 없다', () => {
    const texts = [...kpiView(sumVmRows(per.rows), 3).flatMap((k) => [k.label, k.sub, k.tip]), ...Object.values(checkBase({}, {})).flat().flatMap((x) => [x.label, x.sub, x.tip])];
    for (const t of texts) expect(String(t)).not.toMatch(/`/);
  });
});

describe('⑦ 확인할 것 — 도구 칸 끼우기(insight-tools checkItems)', () => {
  const base = checkBase({ signals: { overload: 1, snapOld: 2, toolsOld: 3 }, reclaim: { orphan: 0, offCount: 9, offDiskGB: 10 } }, { snapAgeDays: 7 });
  it('과부하 → 도구 칸 → 스냅샷 → Tools → 고아 → 정지 · 도구의 꺼진 VM 은 정지 VM 자리를 대신한다(두 번 세지 않는다)', () => {
    const tools = [{ key: 'disk-filling', label: '디스크가 차 가는 VM', value: '12', tone: 'warn', title: 't1' }, { key: 'powered-off', label: '꺼진 VM', value: '8', tone: '', title: 't2' }];
    const l = arrangeChecks(base, tools);
    expect(l.map((x) => x.key)).toEqual(['overload', 'disk-filling', 'snapOld', 'toolsOld', 'orphan', 'powered-off']);
    expect(l[1].tip).toBe('t1');
  });
  it('도구 칸이 없으면(권한 없음) VM 집계 칸만 · 정지 VM 은 VM 집계 값', () => {
    expect(arrangeChecks(base, []).map((x) => x.key)).toEqual(['overload', 'snapOld', 'toolsOld', 'orphan', 'off']);
    expect(arrangeChecks(base, null).find((x) => x.key === 'off').value).toBe(9);
    expect(arrangeChecks(base, [null, { label: '키 없음' }]).length).toBe(5);
  });
});
