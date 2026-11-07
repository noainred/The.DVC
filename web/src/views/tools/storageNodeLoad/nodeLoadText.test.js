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
    for (const [g, keys] of Object.entries(NODE_LOAD_GROUPS)) for (const k of keys) expect(SELECTS.some((s) => s.group === g && s.parts.includes(k))).toBe(true);
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
    expect(groupsAvailable([{ inBps: 1 }, { inBps: null }])).toEqual({ net: true, disk: false, cpu: false });
    expect(groupsAvailable([{ diskOutBytesPs: '5', cpuPct: 0 }, null])).toEqual({ net: false, disk: true, cpu: true });
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
