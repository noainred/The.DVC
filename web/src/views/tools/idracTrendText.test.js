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

describe('v2.661 카드 순서 · 출처 문구', async () => {
  const m = await import('./idracTrendText.js');
  it('카드 6장 — 흡기·배기 추가, 기본 순서는 SERIES 순서', () => {
    expect(m.DEFAULT_ORDER).toEqual(['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'powerW']);
  });
  it('저장된 순서 정규화 — 모르는 키는 버리고 빠진 키는 뒤에 붙인다', () => {
    expect(m.normalizeOrder(['powerW', 'zz', 'powerW', 'cpuPct'])).toEqual(['powerW', 'cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp']);
    expect(m.normalizeOrder(null)).toEqual(m.DEFAULT_ORDER);
  });
  it('◀ ▶ 이동과 끌어서 놓기', () => {
    const o = m.DEFAULT_ORDER;
    expect(m.moveKey(o, 'cpuTemp', -1).slice(0, 2)).toEqual(['cpuTemp', 'cpuPct']);
    expect(m.moveKey(o, 'cpuPct', -1)).toEqual(o, '맨 앞은 그대로');
    expect(m.dropKey(o, 'powerW', 'cpuPct')[0]).toBe('powerW', '앞으로 끌면 그 자리 앞');
    expect(m.dropKey(o, 'cpuPct', 'gpuTemp').slice(0, 3)).toEqual(['cpuTemp', 'gpuTemp', 'cpuPct'], '뒤로 끌면 그 자리 뒤');
  });
  it('저장 — 기본 순서면 지우고, 저장소가 던져도 화면은 동작한다', () => {
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    m.saveOrder(st, ['powerW', ...m.DEFAULT_ORDER.filter((k) => k !== 'powerW')]);
    expect(m.loadOrder(st)[0]).toBe('powerW');
    m.saveOrder(st, [...m.DEFAULT_ORDER]); expect(mem.size).toBe(0);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(m.loadOrder(bad)).toEqual(m.DEFAULT_ORDER);
    expect(() => m.saveOrder(bad, ['cpuPct'])).not.toThrow();
  });
  it('CPU 출처 · 전력 사유 문구', () => {
    expect(m.cpuSourceNote({ cpuSources: { telemetry: 0, os: 3, vcenter: 0, history: 2 } })).toMatch(/베어메탈 사용률\(OS·iDRAC 대체 경로\) 3구간 · 베어메탈 사용률 이력 2구간.*튈 수/);
    expect(m.cpuSourceNote({ cpuSources: { telemetry: 0, os: 0, vcenter: 0, history: 0 } })).toMatch(/읽지 못했습니다/);
    expect(m.cpuSourceNote({})).toBe('');
    expect(m.powerNote({ power: { found: false, reason: 'no-edge-report' } })).toMatch(/엣지의 전력 보고/);
    expect(m.powerNote({ power: { found: true } })).toBe('');
  });
});

describe('v2.662 선 모양', async () => {
  const m = await import('./idracTrendText.js');
  it('기본 — 흡기·배기는 점선, 나머지는 실선 · 굵기 2 · 점 없음', () => {
    expect(m.DEFAULT_STYLES.inletTemp).toEqual({ dash: 'dash', width: 2, dot: false });
    expect(m.DEFAULT_STYLES.exhaustTemp.dash).toBe('dash');
    expect(m.DEFAULT_STYLES.cpuPct).toEqual({ dash: 'solid', width: 2, dot: false });
    expect(m.dashArrayOf('dash')).toBe('6 4');
    expect(m.dashArrayOf('solid')).toBeUndefined();
    expect(m.isDefaultStyles(m.normalizeStyles(null))).toBe(true);
  });
  it('정규화 — 모르는 계열·모양·굵기는 기본값, 전 계열을 채운다', () => {
    const s = m.normalizeStyles({ cpuPct: { dash: 'dot', width: 9, dot: 'y' }, zz: { dash: 'dot' }, gpuTemp: 'x' });
    expect(s.cpuPct).toEqual({ dash: 'dot', width: 2, dot: false });
    expect(s.gpuTemp).toEqual(m.DEFAULT_STYLES.gpuTemp);
    expect(Object.keys(s)).toEqual(m.DEFAULT_ORDER);
    expect(m.normalizeStyles([1, 2])).toEqual(m.DEFAULT_STYLES);
  });
  it('저장 — 기본과 다른 계열만 저장, 전부 기본이면 지운다 · 저장소가 던져도 동작', () => {
    const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
    let s = m.setStyle(m.normalizeStyles(null), 'cpuTemp', { dash: 'dashdot', dot: true });
    m.saveStyles(st, s);
    expect(JSON.parse(mem.get(m.LINE_STYLE_KEY))).toEqual({ cpuTemp: { dash: 'dashdot', width: 2, dot: true } });
    expect(m.loadStyles(st).cpuTemp.dash).toBe('dashdot');
    s = m.setStyle(s, 'cpuTemp', { dash: 'solid', dot: false });
    m.saveStyles(st, s); expect(mem.size).toBe(0);
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    expect(m.loadStyles(bad)).toEqual(m.DEFAULT_STYLES);
    expect(() => m.saveStyles(bad, s)).not.toThrow();
  });
  it('엑셀 쿼리 — 고른 항목만 k:모양:굵기:점', () => {
    const s = m.setStyle(m.normalizeStyles(null), 'powerW', { width: 3, dot: true });
    expect(m.stylesQuery(s, ['inletTemp', 'powerW'])).toBe('inletTemp:dash:2:0,powerW:solid:3:1');
    expect(m.stylesQuery(s, [])).toBe('');
  });
});
