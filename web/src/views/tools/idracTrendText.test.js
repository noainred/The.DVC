import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  statsOf, gapAreas, customRangeError, periodText, pMaxOf, valueText, corpsOf, sitesOf, serversOf, serverLabel,
  retentionNote, emptyNote, bucketLabel, PRESETS, MIN, HOUR, DAY,
} from './idracTrendText.js';

const NOW = new Date(2026, 8, 30, 12, 30).getTime();

describe('iDRAC 통합 추이 문구(v2.660)', () => {
  it('요약은 결측을 빼고, 값이 없으면 null(0 이 아니다)', () => {
    const pts = [{ cpuPct: null }, { cpuPct: 10 }, { cpuPct: 30 }];
    expect(statsOf(pts, 'cpuPct')).toEqual({ cur: 30, avg: 20, max: 30 });
    expect(statsOf([{ cpuPct: null }], 'cpuPct')).toBeNull();
    expect(valueText(null, '%')).toBe('—');
    expect(valueText(1234.5, ' W')).toBe('1,234.5 W');
  });

  it('무응답 구간 — 수집 시작 이전과 전부 빈 기간은 칠하지 않는다', () => {
    const mk = (t, v) => ({ t, cpuPct: v, cpuTemp: null, gpuTemp: null, powerW: null });
    expect(gapAreas([mk(0, null), mk(1, null)])).toEqual([], '전부 비면 무응답이 아니라 데이터 없음');
    expect(gapAreas([mk(0, 1), mk(1, null), mk(2, null), mk(3, 5)])).toEqual([{ x1: 1, x2: 3 }]);
    expect(gapAreas([mk(0, null), mk(1, null), mk(2, 4)], 2)).toEqual([], '첫 적재 이전은 무응답이 아니다');
  });

  it('기간 지정 검증 — 서버 parseWindow 와 같은 규칙', () => {
    expect(customRangeError(NaN, NOW)).toMatch(/모두 입력/);
    expect(customRangeError(NOW, NOW - HOUR)).toMatch(/뒤여야/);
    expect(customRangeError(NOW - 30 * MIN, NOW)).toMatch(/최소 1시간/);
    expect(customRangeError(NOW - 400 * DAY, NOW, { now: NOW, retentionDays: 365 })).toMatch(/보관 기간\(365일\)/);
    expect(customRangeError(NOW - DAY, NOW + HOUR, { now: NOW })).toMatch(/현재 이후/);
    expect(customRangeError(NOW - DAY, NOW, { now: NOW })).toBeNull();
  });

  it('조회 기간 문구 — 날짜가 다르면 날짜를 붙인다', () => {
    expect(periodText(NOW - HOUR, NOW)).toBe('11:30 ~ 12:30');
    expect(periodText(NOW - DAY, NOW)).toBe('2026-09-29 12:30 ~ 2026-09-30 12:30');
    expect(bucketLabel(5 * MIN)).toBe('5분');
    expect(PRESETS.map(([k]) => k)).toEqual(['1h', '6h', '24h', '7d', '30d', '90d', '1y']);
  });

  it('전력 축 — 최대 1.15배를 200W 단위로, 값이 없으면 1000', () => {
    expect(pMaxOf([{ powerW: 520 }])).toBe(600);
    expect(pMaxOf([{ powerW: null }])).toBe(1000);
  });

  it('선택 목록 — 법인 → 데이터센터(스캔 대역) → 서버, 괄호 항목은 뒤로', () => {
    const s = [
      { id: 'a', name: 'srv10', corp: 'HG', corpName: 'HG', site: 'HG-GPU', kind: 'esxi' },
      { id: 'b', name: 'srv2', corp: 'HG', corpName: 'HG', site: 'HG-GPU', kind: 'baremetal' },
      { id: 'c', name: 'x', corp: 'HG', corpName: 'HG', site: '(스캔 대역 밖)', kind: 'baremetal' },
      { id: 'd', name: 'y', corp: '', corpName: '(법인 미지정)', site: '(스캔 대역 밖)', kind: 'baremetal' },
      { id: 'e', name: 'z', corp: 'AS', corpName: 'AS', site: 'AS', kind: 'baremetal' },
    ];
    expect(corpsOf(s).map((c) => c.value)).toEqual(['AS', 'HG', '']);
    expect(sitesOf(s, 'HG')).toEqual([{ value: 'HG-GPU', n: 2 }, { value: '(스캔 대역 밖)', n: 1 }]);
    expect(serversOf(s, 'HG', 'HG-GPU').map((x) => x.name)).toEqual(['srv2', 'srv10'], '숫자 인식 정렬');
    expect(serverLabel(s[0])).toBe('srv10 · ESXi');
    expect(serverLabel(s[1])).toBe('srv2 · 베어메탈');
  });

  it('보관·빈 상태 안내 — 서버가 준 값만 쓴다', () => {
    expect(retentionNote({ retention: { metricsDays: 365, powerDays: 90 } })).toMatch(/전력 DB 보관 기간\(90일\)/);
    expect(retentionNote({ retention: { metricsDays: 365, powerDays: 400 } })).not.toMatch(/전력/);
    expect(emptyNote({ points: [{ cpuPct: 1 }] })).toBe('');
    expect(emptyNote({ enabled: false, points: [] })).toMatch(/꺼져/);
    expect(emptyNote({ points: [{ cpuPct: null }] })).toMatch(/소급하지 않습니다/);
  });

  it('문구에 백틱·별표가 없다', () => {
    const src = fs.readFileSync(new URL('./idracTrendText.js', import.meta.url), 'utf8');
    for (const s of src.match(/'[^'\n]*'/g) || []) { expect(s.includes('`')).toBe(false); expect(s.includes('**')).toBe(false); }
  });
});

describe('판별 근거 문구', () => {
  it('서비스태그가 없으면 대조할 수 없다고 말한다', async () => {
    const { kindBasisText } = await import('./idracTrendText.js');
    expect(kindBasisText({ serviceTag: '', kind: 'baremetal' })).toMatch(/대조할 수 없어/);
    expect(kindBasisText({ serviceTag: 'ABC', kind: 'esxi' })).toBe('서비스태그 ABC → ESXi 호스트 일치');
  });
});
