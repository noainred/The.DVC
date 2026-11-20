/**
 * nodeLoadText.test.js — 스토리지 장비 상세 › 노드 부하 추이(v2.926) 판정·문구 회귀 고정.
 *
 * 이 화면에서 가장 위험한 거짓은 ① 못 읽은 값을 0 으로 그리기 ② 일부 노드의 합을 클러스터 합계처럼 말하기
 * ③ 조금 읽은 구간과 비교해 '평소보다 +80%' 라고 말하기 ④ 보존 기간 밖으로 창을 옮겨 빈 화면을 '부하 없음' 으로 보이기다.
 * 서버 묶음(NODE_LOAD_GROUPS)·기간(NODE_LOAD_RANGES)과 화면 상수를 같은 소스로 대조한다(두 벌이 갈라지지 않게).
 */
import { describe, it, expect } from 'vitest';
import {
  RANGES, SELECTS, selectOf, groupsAvailable, valueText, rateText, pctText, addSeries, pickSeries, statOf, rankNodes,
  heatScaleMax, heatBin, colText, colKindText, drillEndOf, scrollToEnd, portalLocalToMs, msToPortalLocal, rangeLimitText,
  jobsByCol, tilesOf, partialColsOf, notesOf, sparkPath, sampleText, sourceText, maxBackOf, OVERLAY_COLORS, alignBaseline,
} from './nodeLoadText.js';
import { NODE_LOAD_GROUPS, NODE_LOAD_RANGES, buildNodeLoadSeries } from '../../../../../server/src/storage/nodeLoad.js';

const H = 3_600_000;
const D = 24 * H;

describe('서버와 같은 소스', () => {
  it('묶음·계열 — 화면 선택의 parts 는 서버 묶음 안의 계열이다', () => {
    for (const s of SELECTS) for (const p of s.parts) expect(NODE_LOAD_GROUPS[s.group]).toContain(p);
    // v2.952: 서버 묶음 'fe'(어레이 디렉터 · 노드 · SP 단위)는 SAN 스토리지 성능 화면(SanStorageTool ArraySidePanel)이 그린다 — 아이실론 노드 부하 화면의 선택지가 아니다(의도).
    for (const [g, keys] of Object.entries(NODE_LOAD_GROUPS)) { if (g === 'fe') continue; for (const k of keys) expect(SELECTS.some((s) => s.group === g && s.parts.includes(k))).toBe(true); }
  });
  it('기간 — 같은 키·같은 일수', () => {
    expect(RANGES.map((r) => r.key)).toEqual(Object.keys(NODE_LOAD_RANGES));
    for (const r of RANGES) expect(NODE_LOAD_RANGES[r.key].days).toBe(r.days);
  });
  it('서버 조립 결과를 화면이 그대로 읽는다 — 부분 합 칸은 비고 화면도 비운 칸으로 센다', () => {
    const t0 = 1_800_000_000_000;
    const rows = [
      { node: 1, ts: t0, v: { in: 10, out: 1 } }, { node: 2, ts: t0, v: { in: 20, out: 2 } },
      { node: 1, ts: t0 + H, v: { in: 11, out: 1 } }, { node: 2, ts: t0 + H, v: { in: null, out: 3 } },
    ];
    const s = buildNodeLoadSeries(rows, ['in', 'out'], { kind: 'raw' });
    const resp = { ...s, baseline: { cols: [], cluster: {} } };
    expect(s.cluster.in).toEqual([30, null]);
    expect(s.cluster.out).toEqual([3, 4]);
    expect(pickSeries(resp.cluster, 'net')).toEqual([33, null]);
    expect(partialColsOf(resp, 'in')).toBe(1);
    expect(partialColsOf(resp, 'out')).toBe(0);
  });
});

describe('값과 단위', () => {
  it('못 읽은 값은 — 이고 단위를 붙이지 않는다', () => {
    for (const u of ['bps', 'B/s', '%']) { expect(valueText(u, null)).toBe('—'); expect(valueText(u, '')).toBe('—'); }
    expect(rateText(0)).toBe('0 B/s');
    expect(rateText(1_234_567)).toBe('1.2 MB/s');
    expect(rateText(-1)).toBe('—');
    expect(pctText(12.345)).toBe('12.3%');
    expect(valueText('bps', 2_500_000)).toMatch(/Mbps/);
  });
  it('In + Out 은 하나라도 비면 null(부분 합 금지)', () => {
    expect(addSeries([1, null, 3], [1, 2, null])).toEqual([2, null, null]);
    expect(pickSeries({ din: [5, 6], dout: [1, null] }, 'disk')).toEqual([6, null]);
    expect(pickSeries({ cpu: ['12.5', null] }, 'cpu')).toEqual([12.5, null]);
  });
  it('평균·순위는 읽은 값만 — 빈 칸을 0 으로 세지 않는다 · 값이 없는 노드는 맨 뒤', () => {
    expect(statOf([10, null, 20])).toEqual({ avg: 15, peak: 20, n: 2, missing: 1 });
    const resp = { nodes: [{ id: 3, v: { in: [null, null] } }, { id: 1, v: { in: [4, 6] } }, { id: 2, v: { in: [10, null] } }] };
    const r = rankNodes(resp, 'in');
    expect(r.map((x) => x.id)).toEqual([2, 1, 3]);
    expect(r[0].w).toBe(100);
    expect(r[2].avg).toBe(null);
    expect(r[2].w).toBe(0);
  });
  it('히트맵 — CPU 는 0~100 절대 눈금, 처리량은 보기의 최대 · 값 없음은 단계 없음', () => {
    expect(heatScaleMax({ nodes: [{ v: { cpu: [10, 20] } }] }, 'cpu')).toBe(100);
    expect(heatScaleMax({ nodes: [{ v: { in: [10, 40] } }, { v: { in: [80, null] } }] }, 'in')).toBe(80);
    expect(heatBin(null, 80)).toBe(null);
    expect(heatBin(0, 80)).toBe(0);
    expect(heatBin(80, 80)).toBe(4);
    expect(heatBin(5, 0)).toBe(0);
  });
  it('묶음 사용 가능 — 값이 있는 묶음만(디스크 키가 없는 장비에 버튼을 그리지 않는다)', () => {
    expect(groupsAvailable([{ inBps: 1 }, { inBps: null }])).toEqual({ net: true, disk: false, cpu: false, proto: false });
    expect(groupsAvailable([{ diskOutBytesPs: '5', cpuPct: 0 }, null])).toEqual({ net: false, disk: true, cpu: true, proto: false });
  });
});

describe('창 이동(이전 구간 · 날짜·시각 · 드릴다운)', () => {
  const now = Date.UTC(2026, 10, 7, 3, 20); // 12:20 KST
  it('창 끝 시각 → {back, anchor} — 지금 이후는 최신 · 상한을 넘으면 자르고 clamped', () => {
    expect(scrollToEnd(now + 1, { days: 1, now })).toEqual({ back: 0, anchor: null });
    const r = scrollToEnd(now - 3 * D - H, { days: 1, now });
    expect(r.back).toBe(4);
    expect(r.anchor - r.back * D).toBe(now - 3 * D - H);
    expect(scrollToEnd(now - 40 * D, { days: 1, now, maxBack: 29 })).toMatchObject({ back: 29, clamped: true });
    expect(scrollToEnd(now - 40 * D, { days: 1, now, maxBack: 0 })).toEqual({ back: 0, anchor: null, clamped: true });
  });
  it('긴 보기의 칸 → 그 날(포탈 시각) 24시간 창 끝 = 다음 날 0시 · 오늘이면 최신', () => {
    const colTs = Date.UTC(2026, 10, 3, 15, 0); // 11-04 00:00 KST
    expect(drillEndOf(colTs, 540, now)).toBe(Date.UTC(2026, 10, 4, 15, 0)); // 11-05 00:00 KST
    expect(drillEndOf(now - H, 540, now)).toBe(null);
  });
  it('datetime-local(포탈 시각) ↔ ms', () => {
    const t = portalLocalToMs('2026-11-05T09:00', 540);
    expect(t).toBe(Date.UTC(2026, 10, 5, 0, 0));
    expect(msToPortalLocal(t, 540)).toBe('2026-11-05T09:00');
    expect(portalLocalToMs('2026-11-05 09:00')).toBe(null);
  });
  it('갈 수 있는 범위 — 24시간·7일은 원시 보존, 30일·90일은 일 롤업 보존(응답 값)', () => {
    const base = { offsetMin: 540, rawMaxDays: 7, retention: { rawDays: 30, dailyDays: 1825 } };
    const day = { ...base, days: 1, oldest: { sampleTs: now - 29.5 * D, day: '2026-06-01' } };
    expect(maxBackOf(day, now)).toBe(29);
    expect(rangeLimitText(day, 29)).toContain('노드 부하 원시 보존 30일');
    const month = { ...base, days: 30, oldest: { sampleTs: now - 29.5 * D, day: '2026-06-01' } };
    expect(maxBackOf(month, now)).toBeGreaterThanOrEqual(5);
    expect(rangeLimitText(month, 5)).toContain('일 단위 요약 보존 1825일');
    expect(maxBackOf({ ...base, days: 1, oldest: { sampleTs: null, day: null } }, now)).toBe(0);
  });
  it('칸 이름·종류', () => {
    const t = Date.UTC(2026, 10, 5, 4, 0); // 13:00 KST
    expect(colText(t, 'raw', 0, 540)).toBe('11-05 13:00');
    expect(colText(t, 'bucket', 4 * H, 540)).toBe('11-05 13시');
    expect(colText(t, 'daily', D, 540)).toBe('11-05');
    expect(colKindText('bucket', 4 * H)).toBe('4시간 평균');
    expect(colKindText('bucket', 15 * 60_000)).toBe('15분 평균');
    expect(colKindText('raw', 0)).toBe('수집 1회(순간값)');
    expect(sampleText(H)).toBe('1시간');
    expect(sampleText(5 * 60_000)).toBe('5분');
    expect(sampleText(null)).toBe('—');
  });
});

describe('잡 엔진 · 타일 · 안내', () => {
  it('잡 표본을 칸에 붙인다 — 모르는 장비(REST)는 null(‘잡 없음’ 이 아니다)', () => {
    const cols = [0, 4 * H, 8 * H];
    expect(jobsByCol({ cols, jobsKnown: false, jobs: [] })).toBe(null);
    const r = jobsByCol({ cols, jobsKnown: true, jobs: [{ ts: H, running: [{ job: 'SmartPools[118838]' }], paused: 0 }, { ts: 5 * H, running: [], paused: 2 }] });
    expect(r).toEqual([['SmartPools'], ['일시정지 2'], null]);
  });
  it('비교는 두 구간 모두 합계를 읽은 칸이 절반 이상일 때만', () => {
    const resp = { cols: [1, 2, 3, 4], nodes: [{ id: 1, v: { in: [10, 10, 10, 10] } }],
      cluster: { in: [10, 10, 10, 10] }, clusterNodes: [1, 1, 1, 1],
      baseline: { label: '지난주 같은 요일', cols: [1, 2, 3, 4], cluster: { in: [5, null, null, null] } } };
    expect(tilesOf(resp, 'in').compare).toBe(null);
    resp.baseline.cluster.in = [5, 5, null, null];
    expect(tilesOf(resp, 'in').compare).toBe(100);
    expect(tilesOf(resp, 'in').clusterLast).toBe(10);
  });
  it('안내 — DB 비활성 · 기록 없음(엣지면 시작 시점) · 목록 상한 · 과거 구간 비었음', () => {
    expect(notesOf({ db: false })[0].tone).toBe('amber');
    const empty = notesOf({ db: true, cols: [], cluster: {}, clusterNodes: [] }, { isEdge: true });
    expect(empty[0].text).toContain('push 를 받은 시점부터');
    expect(notesOf({ db: true, past: true, cols: [] })[0].text).toContain('이 구간에는 노드 부하 기록이 없습니다');
    const part = { db: true, cols: [1, 2], cluster: { in: [1, null], cpu: [5, null] }, clusterNodes: [2, 2] };
    expect(notesOf(part, { sel: 'in' })[0].text).toContain('클러스터 합계를 비운 칸 1개');
    expect(notesOf(part, { sel: 'cpu' })[0].text).toContain('클러스터 평균을 비운 칸 1개');
    const lim = notesOf({ db: true, cols: [1], cluster: { in: [1] }, clusterNodes: [64] }, { snapCount: 66, listed: 64 });
    expect(lim.some((n) => n.text.includes('나머지 2대는 이력이 없고'))).toBe(true);
  });
  it('비교 구간 맞추기 — 칸 간격 절반 안의 가장 가까운 비교 값만, 없으면 null', () => {
    const cols = [0, H, 2 * H, 3 * H];
    expect(alignBaseline(cols, [5 * 60_000, H + 20 * 60_000, 3 * H + 40 * 60_000], [1, 2, 3], H / 2)).toEqual([1, 2, null, null]);
    expect(alignBaseline(cols, [], [], H / 2)).toEqual([null, null, null, null]);
  });
  it('스파크 — 빈 칸에서 선을 끊는다', () => {
    const p = sparkPath([1, null, 2, 3], { w: 30, h: 10, max: 3, pad: 0 });
    expect(p.match(/M/g).length).toBe(2);
    expect(sparkPath([], {})).toBe('');
  });
  it('출처 문구 — 엣지가 보낸 객체는 글자일 때만 쓴다', () => {
    expect(sourceText({ extra: { collectMethod: 'ssh' } }, 'net')).toContain('isi status');
    expect(sourceText({ extra: { nodeLoadProbe: { source: { x: 1 } } } }, 'disk')).toBe('—');
    expect(sourceText({ extra: { nodeLoadProbe: { source: 'isi statistics system' } } }, 'cpu')).toBe('isi statistics system');
  });
  it('겹쳐 보기 색은 4개(선택 상한)', () => {
    expect(OVERLAY_COLORS.length).toBe(4);
    expect(selectOf('nope').key).toBe('in');
  });
});

/* ── v2.932(2차) 디스크 busy·IOPS · 프로토콜 · 노드 드로어 · 클라이언트 분포 ─────────────────────── */
import {
  GROUP_ORDER, GROUP_FIRST, chartParts, opsText, latText, shareText, clientNameText, lateNote, drawerNotes, latestMapOf, protoSummaryOf,
  skewBarsOf, candidateText, distNotes, distCsv,
} from './nodeLoadText.js';

describe('v2.932 — 묶음 4개 · 단위', () => {
  it('묶음 순서·첫 선택은 서버 묶음과 같다', () => {
    expect(GROUP_ORDER).toEqual(Object.keys(NODE_LOAD_GROUPS).filter((g) => g !== 'fe'));   // v2.952: fe 는 SAN 스토리지 성능 화면 몫
    for (const g of GROUP_ORDER) expect(selectOf(GROUP_FIRST[g]).group).toBe(g);
  });
  it('차트 계열 — 처리량은 In·Out 둘, 그 밖은 고른 하나', () => {
    expect(chartParts('in')).toEqual(['in', 'out']); expect(chartParts('disk')).toEqual(['din', 'dout']);
    expect(chartParts('busy')).toEqual(['busy']); expect(chartParts('iops')).toEqual(['iops']); expect(chartParts('lat')).toEqual(['lat']); expect(chartParts('cpu')).toEqual(['cpu']);
  });
  it('ops/s · ms 표기 — 값이 없으면 — 이고 단위를 붙이지 않는다', () => {
    expect(opsText(1234.6)).toBe('1,235 ops/s'); expect(opsText(null)).toBe('—'); expect(opsText(-1)).toBe('—');
    expect(latText(1.25)).toBe('1.3 ms'); expect(latText('')).toBe('—');
    expect(valueText('ops/s', 10)).toBe('10 ops/s'); expect(valueText('ms', 2)).toBe('2.0 ms'); expect(valueText('ms', null)).toBe('—');
    expect(shareText(91.6)).toBe('92%'); expect(shareText(null)).toBe('—');
  });
  it('표본 폴러가 켜진 장비는 디스크·프로토콜 묶음을 연다 — 스냅샷에 키가 없어도', () => {
    const list = [{ id: 1, inBps: 1 }];
    expect(groupsAvailable(list)).toEqual({ net: true, disk: false, cpu: false, proto: false });
    expect(groupsAvailable(list, { sampleEnabled: true })).toEqual({ net: true, disk: true, cpu: false, proto: true });
    expect(groupsAvailable([{ id: 1, busyPct: 3 }]).disk).toBe(true);
    expect(groupsAvailable([{ id: 1, opsPs: 3 }]).proto).toBe(true);
  });
});

describe('v2.932 — 노드 드로어', () => {
  const now = 1_800_000_000_000;
  it('이름 칸 — 장비 보고 · VM · 호스트 · 못 찾음(IP 만) · 같은 IP 둘', () => {
    expect(clientNameText({ name: '', client: '10.0.0.1' })).toEqual({ text: '—', hint: expect.stringContaining('역방향 DNS') });
    expect(clientNameText({ name: 'vm-a', nameSource: 'vm' }).hint).toBe('VM 이름');
    expect(clientNameText({ name: 'esx1', nameSource: 'host', ambiguous: true }).hint).toMatch(/호스트 이름 · 같은 IP/);
    expect(clientNameText({ name: 'nas-cli', nameSource: 'device' }).hint).toBe('장비 보고 이름');
  });
  it('늦은 표본 — 표본 주기 ×3(lateMs)을 넘으면 노란 문구, 아니면 null, 표본이 없으면 null', () => {
    expect(lateNote({ latest: { ts: now - 10 * 60_000 }, lateMs: 15 * 60_000, sample: { sampleMs: 300_000 } }, now)).toBeNull();
    const n = lateNote({ latest: { ts: now - 40 * 60_000 }, lateMs: 15 * 60_000, sample: { sampleMs: 300_000 } }, now);
    expect(n.tone).toBe('amber'); expect(n.text).toMatch(/마지막 표본 40분 전/); expect(n.text).toMatch(/5분/);
    expect(lateNote({ latest: { ts: now - 3 * 3_600_000 }, lateMs: 15 * 60_000, sample: {} }, now).text).toMatch(/3시간 전/);
    expect(lateNote({ latest: { ts: null }, lateMs: 1 }, now)).toBeNull();
  });
  it('안내문 — 클라이언트 없음은 연결 없음이 아니다 · 표본 꺼짐 · 이름 못 찾음 · DB 없음', () => {
    expect(drawerNotes({ clients: [], names: { unknown: 0 } })[0].text).toMatch(/연결 없음.*아닙니다/);
    expect(drawerNotes({ clients: [], past: true, names: {} })[0].text).toMatch(/기록이 없습니다/);
    const t = drawerNotes({ clients: [{}], sample: { sampleEnabled: false }, names: { unknown: 2 } }).map((x) => x.text);
    expect(t[0]).toMatch(/표본 수집이 꺼져/); expect(t[1]).toMatch(/이름을 찾지 못한 주소 2개/);
    expect(drawerNotes({ db: false })).toHaveLength(1);
  });
  it('지금 열 — 클라이언트+프로토콜 키 · 프로토콜 요약은 ops 내림차순', () => {
    const m = latestMapOf({ latest: { rows: [{ client: 'a', proto: 'nfs', ops: 1 }, { client: 'a', proto: 'smb', ops: 2 }] } });
    expect(m.get('a|smb').ops).toBe(2); expect(m.has('a|')).toBe(false);
    expect(protoSummaryOf([{ proto: 'smb', ops: 1 }, { proto: 'nfs', ops: 9, lat: 1.24 }]).map((p) => p.proto)).toEqual(['nfs', 'smb']);
  });
});

describe('v2.932 — 클라이언트 분포 · 재배치', () => {
  const resp = {
    nodes: [{ id: 1, total: 100, ratio: 0.5, skew: false }, { id: 2, total: 500, ratio: 2.5, skew: true }, { id: 3, total: 0, ratio: 0, skew: false }],
    mean: 200, thresholds: { fixedShare: 0.9, skewFactor: 1.5 },
    clients: [{ client: '10.1.1.1', name: 'vm-a', proto: 'nfs', total: 300, top: 2, topShare: 100, fixed: true, share: { 2: 100 } }, { client: '10.1.1.2', name: 'x,"y"', proto: 'smb', total: 50, top: 1, topShare: 60, fixed: false, share: { 1: 60, 2: 40 } }],
    candidates: [{ client: '10.1.1.1', name: 'vm-a', proto: 'nfs', from: 2, to: 3, ops: 300, fromAfter: 200, toAfter: 300 }],
    names: { unknown: 1 }, note: '포탈은 바꾸지 않습니다',
  };
  it('노드 막대 — 최대 대비 폭 · ops 0 노드도 막대(폭 0) · 쏠림 표지', () => {
    const b = skewBarsOf(resp);
    expect(b.map((x) => x.w)).toEqual([20, 100, 0]); expect(b[1].skew).toBe(true); expect(b[2].ratio).toBe(0);
  });
  it('후보 한 줄 — 이름(IP) · 프로토콜 · 어디서 어디로 · 옮긴 뒤 값', () => {
    expect(candidateText(resp.candidates[0])).toBe('vm-a (10.1.1.1) · nfs — 노드 2 → 노드 3 · 300 ops/s · 옮긴 뒤 노드 2 200 ops/s / 노드 3 300 ops/s');
    expect(candidateText({ client: '10.9.9.9', from: 1, to: 2, ops: 5, fromAfter: 1, toAfter: 2 })).toMatch(/^10\.9\.9\.9 — 노드 1/);
  });
  it('안내문 — 쏠림 없음 · 고정 없음 · 이름 못 찾음 · 서버 note 그대로', () => {
    const noSkew = distNotes({ ...resp, nodes: resp.nodes.map((n) => ({ ...n, skew: false })), names: {}, note: '' }).map((x) => x.text);
    expect(noSkew[0]).toMatch(/쏠린 노드가 없습니다 — .*1\.5배 미만/);
    const noCand = distNotes({ ...resp, candidates: [], names: {}, note: '' }).map((x) => x.text);
    expect(noCand[0]).toMatch(/쏠린 노드 2 에 ‘고정’ 클라이언트.*90%/);
    const t = distNotes(resp).map((x) => x.text);
    expect(t.some((x) => /이름을 찾지 못한 주소 1개/.test(x))).toBe(true); expect(t[t.length - 1]).toBe('포탈은 바꾸지 않습니다');
    expect(distNotes({ ...resp, clients: [], names: {} })[0].text).toMatch(/표본이 없습니다/);
  });
  it('CSV — 머리줄에 노드 열 · 쉼표·따옴표는 감싼다 · 비중 없는 칸은 빈 칸', () => {
    const csv = distCsv(resp).split('\n');
    expect(csv[0]).toBe('client,name,proto,total_ops,top_node,top_share_pct,fixed,node_1_pct,node_2_pct,node_3_pct');
    expect(csv[1]).toBe('10.1.1.1,vm-a,nfs,300,2,100,Y,,100,');
    expect(csv[2]).toBe('10.1.1.2,"x,""y""",smb,50,1,60,N,60,40,');
    expect(csv[3]).toBe('');
  });
});
