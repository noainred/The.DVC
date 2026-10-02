// v2.687 — 서버 표 · 조건 검색: '평균 대비 변화' 조건(절대 차이·비율) + ESXi 계열 + '언제 · 얼마나' 구간 목록.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as m from './idracTrendText.js';

const H = m.HOUR;
const row = (k, st, extra = {}) => ({ id: extra.id || 'r', [k]: st, ...extra });

describe('평균 대비 변화 조건(v2.687)', () => {
  it('변화 = 최대·최소 중 평균에서 더 먼 쪽 — 절대값과 비율', () => {
    expect(m.deviationOf({ avg: 30, min: 25, max: 42 })).toEqual({ abs: 12, pct: 40, dir: 'up' });
    expect(m.deviationOf({ avg: 30, min: 10, max: 35 })).toEqual({ abs: 20, pct: 66.7, dir: 'down' });
    expect(m.deviationOf({ avg: 0, min: 0, max: 5 }).pct).toBe(null); // 평균 0 — 비율을 지어내지 않는다
    expect(m.deviationOf({ avg: -5, min: -10, max: 0 }).pct).toBe(null); // 평균 음수 — 비율은 뜻이 없다
    expect(m.deviationOf({ avg: null, min: 1, max: 2 })).toBe(null);
    expect(m.deviationOf(null)).toBe(null);
  });
  it('사용자 사례 — 7일 CPU 사용률이 평균에서 ±10 이상(절대·비율) · 단일·복합', () => {
    const rows = [
      row('cpuPct', { avg: 30, min: 28, max: 42 }, { id: 'a', powerW: { avg: 500, min: 480, max: 700 } }), // +12%p · 40%
      row('cpuPct', { avg: 30, min: 25, max: 35 }, { id: 'b', powerW: { avg: 500, min: 490, max: 510 } }), // ±5%p · 16.7%
      row('cpuPct', { avg: 80, min: 75, max: 89 }, { id: 'c' }),                                             // +9%p · 11.3%
      { id: 'd', cpuPct: null },
    ];
    const abs = [m.newCond('cpuPct', 'devAbs', '10')];
    expect(m.filterTable(rows, abs).rows.map((r) => r.id)).toEqual(['a']);
    expect(m.filterTable(rows, abs).unknown).toBe(1); // 값이 없는 d 는 판정 불가
    expect(m.filterTable(rows, [m.newCond('cpuPct', 'devPct', '10')]).rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    const both = [m.newCond('cpuPct', 'devAbs', '10'), m.newCond('powerW', 'devPct', '20')];
    expect(m.filterTable(rows, both, 'all').rows.map((r) => r.id)).toEqual(['a']);
    expect(m.filterTable(rows, [m.newCond('cpuPct', 'devAbs', '10'), m.newCond('cpuPct', 'devPct', '15')], 'any').rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(m.condText(abs)).toBe('CPU 사용률 평균 대비 ±10%p 이상 변화');
    expect(m.condText([m.newCond('powerW', 'devPct', '20')])).toBe('소비 전력 평균 대비 ±20% 이상 변화');
  });
  it('음수 기준은 쓰지 않는다 · 단위 표기(%p · % · ℃ · W)', () => {
    expect(m.activeConds([m.newCond('cpuPct', 'devAbs', '-1')])).toEqual([]);
    expect(m.condUnit('cpuPct', 'devAbs')).toBe('%p');
    expect(m.condUnit('cpuPct', 'devPct')).toBe('%');
    expect(m.condUnit('cpuTemp', 'devAbs')).toBe('℃');
    expect(m.condUnit('powerW', 'ge')).toBe('W');
  });
  it('ESXi 계열도 조건 대상 — 베어메탈(값 없음)은 판정 불가', () => {
    expect(m.TABLE_SERIES.map((s) => s.k)).toEqual(['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'powerW', 'hostCpuPct', 'hostGpuPct', 'hostGpuMemPct']);
    expect(m.SERIES).toHaveLength(6); // 무응답 구간 판정용 iDRAC 계열은 그대로
    const rows = [{ id: 'e', hostGpuPct: { avg: 10, min: 0, max: 60 } }, { id: 'b', hostGpuPct: null }];
    const r = m.filterTable(rows, [m.newCond('hostGpuPct', 'devAbs', '30')]);
    expect(r.rows.map((x) => x.id)).toEqual(['e']); expect(r.unknown).toBe(1);
  });
  it('CSV 에 변화 열', () => {
    const csv = m.tableCsv([{ id: 'a', name: 'A', cpuPct: { avg: 30, min: 28, max: 42 } }], 168);
    expect(csv).toContain('CPU 사용률 평균 대비 변화(%p)');
    expect(csv.split('\r\n')[2]).toContain(',12,40,');
  });
});

describe('언제 · 얼마나 — 구간 목록(v2.687)', () => {
  const t0 = new Date(2026, 9, 1, 13, 0).getTime();
  const pts = [
    { ts: t0, avg: 30, min: 28, max: 32 },
    { ts: t0 + H, avg: 40, min: 30, max: 45 },     // +15 → 걸림
    { ts: t0 + 2 * H, avg: 50, min: 40, max: 52 }, // +22 → 걸림(정점)
    { ts: t0 + 3 * H, avg: 30, min: 29, max: 31 },
    { ts: t0 + 5 * H, avg: 20, min: 12, max: 25 },  // −18 → 걸림(따로 — 4시간 칸 없음)
    { ts: t0 + 6 * H, avg: null, min: 1, max: 99 }, // 값이 이상한 칸은 판정하지 않는다
  ];
  const r0 = row('cpuPct', { avg: 30, min: 12, max: 52 });
  it('연속 시간은 한 구간 · 정점 시각·값 · 평균 대비 변화 · 최신 먼저', () => {
    const { episodes, omitted, hitHours } = m.changeEpisodes({ cpuPct: pts }, r0, [m.newCond('cpuPct', 'devAbs', '10')]);
    expect(hitHours).toBe(3); expect(omitted).toBe(0);
    expect(episodes).toHaveLength(2);
    const [down, up] = episodes;
    expect([down.start, down.hours, down.dir, down.peak, down.delta, down.deltaPct]).toEqual([t0 + 5 * H, 1, 'down', 12, -18, -60]);
    expect([up.start, up.end, up.hours, up.peakTs, up.peak, up.delta, up.deltaPct]).toEqual([t0 + H, t0 + 3 * H, 2, t0 + 2 * H, 52, 22, 73.3]);
    expect(m.episodeRangeText(up)).toBe('10-01 14:00 ~ 16:00');
    expect(m.episodeDeltaText(up)).toBe('+22%p (+73.3%)');
    expect(m.episodeDeltaText(down)).toBe('−18%p (−60%)');
  });
  it('이상·이하 조건도 그 시간 최대·최소로 · 조건 없는 지표·값 없는 계열은 목록 없음', () => {
    expect(m.changeEpisodes({ cpuPct: pts }, r0, [m.newCond('cpuPct', 'ge', '50')]).episodes.map((e) => e.peak)).toEqual([52]);
    expect(m.changeEpisodes({ cpuPct: pts }, r0, [m.newCond('cpuPct', 'le', '15')]).episodes.map((e) => e.peak)).toEqual([12]);
    expect(m.changeEpisodes({ cpuPct: null }, r0, [m.newCond('cpuPct', 'devAbs', '1')]).episodes).toEqual([]);
    expect(m.changeEpisodes({ cpuPct: pts }, r0, []).episodes).toEqual([]);
  });
  it('날짜를 넘는 구간은 끝에도 날짜 · 표의 판정과 같은 결론(창 최대가 걸리면 적어도 한 시간은 걸린다)', () => {
    const late = new Date(2026, 9, 1, 23, 0).getTime();
    const e = m.changeEpisodes({ cpuPct: [{ ts: late, avg: 50, min: 45, max: 60 }, { ts: late + H, avg: 55, min: 50, max: 61 }] },
      row('cpuPct', { avg: 30, min: 30, max: 61 }), [m.newCond('cpuPct', 'devAbs', '10')]).episodes[0];
    expect(m.episodeRangeText(e)).toBe('10-01 23:00 ~ 10-02 01:00');
    expect(m.filterTable([row('cpuPct', { avg: 30, min: 30, max: 61 })], [m.newCond('cpuPct', 'devAbs', '10')]).rows).toHaveLength(1);
  });
  it('구간 상한을 넘으면 개수를 밝힌다 · CSV', () => {
    const many = Array.from({ length: m.EPISODE_MAX + 5 }, (_, i) => ({ ts: t0 + i * 2 * H, avg: 50, min: 50, max: 90 }));
    const res = m.changeEpisodes({ cpuPct: many }, row('cpuPct', { avg: 50, min: 50, max: 90 }), [m.newCond('cpuPct', 'devAbs', '10')]);
    expect(res.episodes).toHaveLength(m.EPISODE_MAX); expect(res.omitted).toBe(5);
    const csv = m.episodesCsv('srv', res.episodes.slice(0, 1));
    expect(csv).toContain('평균 대비 변화'); expect(csv).toContain('srv');
  });
  it('화면 — 시간 목록 창과 표 연결 · 문구에 백틱 없음', () => {
    const tbl = fs.readFileSync(new URL('./IdracTrendTable.jsx', import.meta.url), 'utf8');
    const chg = fs.readFileSync(new URL('./IdracTrendChanges.jsx', import.meta.url), 'utf8');
    expect(tbl).toContain('IdracTrendChanges');
    expect(tbl).toContain('since={data.since}');
    expect(chg).toContain('/trend/hourly');
    expect(chg).not.toMatch(/setInterval|usePolling/);
  });
});

describe('서버 종류 선택(v2.687)', () => {
  const sv = [
    { id: 'a', kind: 'esxi', gpuState: 'gpu' },
    { id: 'b', kind: 'esxi', gpuState: 'cpu' },
    { id: 'c', kind: 'baremetal', gpuState: 'gpu' },
    { id: 'd', kind: 'baremetal', gpuState: 'unknown' },
    { id: 'e', kind: 'baremetal', gpu: true },   // 구버전 응답 — gpuState 없음, GPU 온도 플래그만
    { id: 'f', kind: 'esxi' },                   // 구버전 응답 — 판정 불가
  ];
  it('두 축을 함께 고른다 · 판정 불가는 CPU 만에 넣지 않는다', () => {
    expect(m.filterByType(sv, { gpu: 'gpu', kind: '' }).map((s) => s.id)).toEqual(['a', 'c', 'e']);
    expect(m.filterByType(sv, { gpu: 'cpu', kind: '' }).map((s) => s.id)).toEqual(['b']);
    expect(m.filterByType(sv, { gpu: 'gpu', kind: 'esxi' }).map((s) => s.id)).toEqual(['a']);
    expect(m.filterByType(sv, { gpu: '', kind: 'baremetal' }).map((s) => s.id)).toEqual(['c', 'd', 'e']);
    expect(m.filterByType(sv, m.EMPTY_TYPE)).toHaveLength(6);
  });
  it('칩 개수는 다른 축의 선택만 반영 · 판정 불가 수', () => {
    const c = m.typeCounts(sv, { gpu: 'gpu', kind: 'esxi' });
    expect(c.gpu).toEqual({ '': 3, gpu: 1, cpu: 1 }); // 형태 = 가상화 안에서
    expect(c.kind).toEqual({ '': 3, esxi: 1, baremetal: 2 }); // 구성 = GPU 안에서
    expect(c.unknown).toBe(1); // 가상화 중 판정 불가(f)
  });
  it('쿼리·문구', () => {
    expect(m.typeQuery({ gpu: 'cpu', kind: '' })).toEqual({ gpu: 'cpu' });
    expect(m.typeQuery(m.EMPTY_TYPE)).toEqual({});
    expect(m.typeText({ gpu: 'gpu', kind: 'baremetal' })).toBe('GPU 있음 · 베어메탈');
    expect(m.typeText(m.EMPTY_TYPE)).toBe('');
  });
  it('화면 — 예전 체크박스를 종류 선택으로 바꿨다(두 보기·내보내기 공용)', () => {
    const tool = fs.readFileSync(new URL('./IdracTrendTool.jsx', import.meta.url), 'utf8');
    expect(tool).toContain('IdracTypeBar');
    expect(tool).not.toMatch(/gpuOnly/);
    expect(tool).toContain('typeQuery(typeFilter)');
  });
});
