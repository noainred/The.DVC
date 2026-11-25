// v2.915 — 베어메탈 ↔ SAN 비교 문구의 정직성 규칙(설계 docs/design/bm-san-compare §3).
import { describe, it, expect } from 'vitest';
import {
  fmtBps, pctTone, deltaText, ratioText, reasonText, reasonBadge, kindTag, typesQuery, SAN_TYPE_CHIPS,
  measuredText, groupMemberText, bmBasisText, sanBasisText, compareRows, chipMeta, statusLine, latestCapAt,
} from './bmSanCompareText.js';

describe('bmSanCompareText', () => {
  it('전송 속도는 10진 단위 · 못 읽은 값은 단위 없이 —', () => {
    expect(fmtBps(null)).toBe('—'); expect(fmtBps('')).toBe('—'); expect(fmtBps('x')).toBe('—');
    expect(fmtBps(1.03e9)).toBe('1.03 GB/s'); expect(fmtBps(612e6)).toBe('612 MB/s'); expect(fmtBps(21.4e6)).toBe('21.4 MB/s');
    expect(fmtBps(5120)).toBe('5 KB/s'); expect(fmtBps(12)).toBe('12 B/s'); expect(fmtBps(0)).toBe('0 B/s');
  });
  it('사용률 색조는 현황 탭과 같은 경계(90 · 75) · null 은 null', () => {
    expect(pctTone(null)).toBe(null); expect(pctTone(74.9)).toBe('green'); expect(pctTone(75)).toBe('amber'); expect(pctTone(90)).toBe('red');
  });
  it('차이 · 배율 문장 — 어느 쪽이 큰지 말하고 분모가 없으면 —', () => {
    expect(deltaText(4.6)).toBe('+4.6%p 베어메탈이 더 찼습니다'); expect(deltaText(-8.7)).toBe('−8.7%p SAN 이 더 찼습니다');
    expect(deltaText(0.01)).toBe('차이 없음'); expect(deltaText(null)).toBe('—');
    expect(ratioText(4.5)).toBe('4.5배 SAN 쪽이 많습니다'); expect(ratioText(0.5)).toBe('2.0배 베어메탈 쪽이 많습니다'); expect(ratioText(null)).toBe('—'); expect(ratioText(0)).toBe('—');
  });
  it('사유 코드 → 문장 · 배지, 모르는 코드는 원문', () => {
    expect(reasonText('serial-unmatched')).toMatch(/시리얼/); expect(reasonText('edge-legacy')).toMatch(/엣지/); expect(reasonText('perf-disabled')).toMatch(/포트 사용량/);
    expect(reasonText('/proc/diskstats 없음')).toBe('/proc/diskstats 없음'); expect(reasonText('')).toBe('');
    expect(reasonBadge('serial-unmatched')).toBe('시리얼 미대조'); expect(reasonBadge('no-samples')).toBe('전송 측정 없음'); expect(reasonBadge('edge-legacy')).toBe('엣지 구버전');
    expect(reasonBadge('collect-failed')).toBe('용량 측정 없음'); expect(reasonBadge('something else')).toBe('측정 불가'); expect(reasonBadge(null)).toBe('');
  });
  it('구분 배지 · 종류 칩 → types 쿼리(비면 기본 VMAX · PowerMax)', () => {
    expect(kindTag('bm')).toEqual({ label: '베어메탈', cls: 'teal' }); expect(kindTag('powermax').label).toBe('PowerMax'); expect(kindTag('vmax').cls).toBe('purple'); expect(kindTag('??').label).toBe('??');
    expect(SAN_TYPE_CHIPS[0].key).toBe('vmax,powermax');
    expect(typesQuery(new Set())).toBe('vmax,powermax'); expect(typesQuery(new Set(['unity480', 'xtremio']))).toBe('unity480,xtremio'); expect(typesQuery(null)).toBe('vmax,powermax');
  });
  it('측정 대수 · 그룹 멤버 · 기준 열 문구', () => {
    expect(measuredText({ measured: 9, total: 10 })).toBe('9/10대 — 부분 합'); expect(measuredText({ measured: 2, total: 2 })).toBe('2/2대');
    expect(measuredText({ measured: 0, total: 3 })).toBe('3대 측정 없음'); expect(measuredText(null)).toBe('');
    expect(groupMemberText({ name: 'HPC', servers: 2 }, { dcNames: ['서울'], totals: { HPC: 3 } })).toBe('서울 2/3대');
    expect(groupMemberText({ name: 'HPC', servers: 3 }, { dcNames: ['서울'], totals: { HPC: 3 } })).toBe('그룹 · 3대');
    expect(groupMemberText({ name: 'HPC', servers: 3 })).toBe('그룹 · 3대');
    expect(bmBasisText({ ago: '3분 전' })).toBe('df · I/O 2초 표본 · 3분 전'); expect(bmBasisText({ ago: '3분 전', ioMeasured: false })).toBe('df · 3분 전');
    expect(sanBasisText({ capAgo: '41분 전', ports: 8, switches: 2, hours: 1 })).toBe('Unisphere 41분 전 · 포트 8 · 스위치 2 · 1시간 평균');
    expect(sanBasisText({ hours: 24 })).toBe('Unisphere — · 1일 평균');
  });
  it('비교 표 행 — 그룹 + 어레이를 사용률 높은 순(null 뒤), 합계 행은 따로 · 부분 합 · 사유 코드 전달', () => {
    const bm = {
      total: { servers: 3, ok: 3, totalBytes: 300, usedBytes: 150, usedPct: 50, io: { totalBps: 100, measured: 2, total: 3, partial: true } },
      groups: [
        { name: 'A', servers: 2, ok: 2, members: ['x', 'y'], totalBytes: 200, usedBytes: 160, usedPct: 80, io: { totalBps: 60, measured: 2, total: 2, partial: false } },
        { name: 'B', servers: 1, ok: 1, members: ['z'], totalBytes: 100, usedBytes: 0, usedPct: null, io: { totalBps: null, measured: 0, total: 1, partial: false } },
      ],
    };
    const san = { arrays: [
      { id: 's1', name: 'PMAX', type: 'powermax', datacenterId: 'kr', datacenterName: '서울', serial: '0001', capacity: { totalBytes: 180, usedBytes: 124, pct: 68.9, at: 5 }, throughput: { avgBps: 1e9, peakAvgBps: 1.5e9, peakBps: 2.4e9, ports: 8, switches: 2 }, throughputReason: null },
      { id: 's2', name: 'VMAX', type: 'vmax', datacenterId: 'pl', datacenterName: '폴란드', serial: '0002', capacity: { totalBytes: 64, usedBytes: 52, pct: 81.3, at: 9 }, throughput: null, throughputReason: 'serial-unmatched' },
    ] };
    const { rows, totals } = compareRows({ bm, san, hours: 1 });
    expect(rows.map((r) => r.name)).toEqual(['VMAX', 'A', 'PMAX', 'B']);
    expect(rows[1].measured).toBe('2/2대'); expect(rows[3].reason).toBe('unmeasured'); expect(rows[0].reason).toBe('serial-unmatched');
    expect(rows[2].bps).toBe(1e9); expect(rows[2].peakBps).toBe(2.4e9);
    expect(compareRows({ bm, san, peak: true }).rows[2].bps).toBe(1.5e9);
    expect(totals.map((t) => t.key)).toEqual(['t:bm', 't:san']);
    expect(totals[0].partial).toBe(true); expect(totals[0].measured).toBe('2/3대 — 부분 합');
    expect(totals[1].pct).toBe(Math.round((176 / 244) * 1000) / 10); expect(totals[1].bps).toBe(1e9); expect(totals[1].measured).toBe('1/2대 측정 합'); expect(totals[1].partial).toBe(true);
    expect(compareRows({ bm: { total: { servers: 0 }, groups: [] }, san: { arrays: [] } }).totals).toEqual([]);
    const dc = compareRows({ bm, san, dcNames: ['서울'], groupTotals: { A: 5 } });
    expect(dc.rows.find((r) => r.name === 'A').where).toBe('서울 2/5대'); expect(dc.totals[0].name).toBe('베어메탈 합계 · 서울');
  });
  it('법인 칩 보조 · 상태 줄 · 최신 스냅샷 시각', () => {
    expect(chipMeta({ name: '서울', servers: 4, arrays: 1, maxPct: 68.9 })).toEqual({ dot: 'var(--green)', count: 5, title: '서울 — 베어메탈 4대 · 어레이 1대 · 최고 사용률 68.9%', bad: false });
    expect(chipMeta({ name: 'x', servers: 1, arrays: 0, maxPct: 92 }).bad).toBe(true); expect(chipMeta({ name: 'x' }).dot).toBe('var(--text-faint)');
    expect(statusLine({ bm: { total: { servers: 10, ok: 10, errors: 0, pending: 0, io: { measured: 9, total: 10 } } }, san: { arrays: [1, 2, 3, 4] }, bmAgo: '3분 전', sanPerfAgo: '2분 전', sanCapAgo: '41분 전' }))
      .toBe('베어메탈 10대 수집 정상 10 · 디스크 I/O 측정 9대 · 측정 불가 1대 · 최근 수집 3분 전 · SAN 어레이 4대 · 포트 표본 2분 전 · 용량 스냅샷 41분 전');
    expect(latestCapAt([{ capacity: { at: 5 } }, { capacity: { at: 9 } }, { capacity: null }])).toBe(9); expect(latestCapAt([])).toBe(null);
  });
});
