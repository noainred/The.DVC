import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import * as T from './idracTrendText.js';
import {
  statsOf, gapAreas, customRangeError, periodText, pMaxOf, valueText, corpsOf, sitesOf, serversOf, serverLabel,
  retentionNote, emptyNote, bucketLabel, PRESETS, MIN, HOUR, DAY,
} from './idracTrendText.js';

const NOW = new Date(2026, 8, 30, 12, 30).getTime();

describe('iDRAC 통합 추이 문구(v2.660)', () => {
  it('요약은 결측을 빼고, 값이 없으면 null(0 이 아니다)', () => {
    const pts = [{ cpuPct: null }, { cpuPct: 10 }, { cpuPct: 30 }];
    expect(statsOf(pts, 'cpuPct')).toEqual({ cur: 30, curT: null, avg: 20, max: 30 });
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
    expect(m.DEFAULT_ORDER).toEqual(['cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'powerW', 'hostCpuPct', 'hostGpuPct', 'hostGpuMemPct']); // v2.666 ESXi CPU 카드(가상화 서버에만 보인다)
  });
  it('저장된 순서 정규화 — 모르는 키는 버리고 빠진 키는 뒤에 붙인다', () => {
    expect(m.normalizeOrder(['powerW', 'zz', 'powerW', 'cpuPct'])).toEqual(['powerW', 'cpuPct', 'cpuTemp', 'gpuTemp', 'inletTemp', 'exhaustTemp', 'hostCpuPct', 'hostGpuPct', 'hostGpuMemPct']);
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
    expect(m.cpuSourceNote({ cpuSources: { telemetry: 0, sensor: 3, bmIdrac: 0, history: 2 } })).toMatch(/iDRAC CPU 센서 3구간 · iDRAC 대체 경로 이력 2구간.*튈 수/);
    expect(m.cpuSourceNote({ cpuSources: { telemetry: 0, sensor: 0, bmIdrac: 0, history: 0 } })).toMatch(/iDRAC 의 어느 경로로도 읽지 못했습니다/);
    expect(Object.values(m.CPU_SRC).join()).not.toMatch(/vCenter|OS/);
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

describe('v2.663 서버 표 · 조건 검색 · CPU 진단', async () => {
  const m = await import('./idracTrendText.js');
  const rows = [
    { id: 'a', name: 'a', cpuTemp: { max: 81, min: 40, avg: 60 }, gpuTemp: null, powerW: { max: 500, min: 200, avg: 300 } },
    { id: 'b', name: 'b', cpuTemp: { max: 60, min: 30, avg: 45 }, gpuTemp: { max: 70, min: 25, avg: 50 }, powerW: { max: 250, min: 180, avg: 200 } },
    { id: 'c', name: 'c', cpuTemp: null, gpuTemp: null, powerW: null },
  ];
  it('이상은 최대, 이하는 최소 · 빈 값 조건은 무시 · 값 없음은 판정 불가로 따로 센다', () => {
    const c = [m.newCond('cpuTemp', 'ge', '70'), m.newCond('powerW', 'le', '')];
    const r = m.filterTable(rows, c, 'all');
    expect(r.rows.map((x) => x.id)).toEqual(['a']);
    expect(r.unknown).toBe(1); expect(r.active).toBe(1);
    expect(m.filterTable(rows, [m.newCond('powerW', 'le', '190')]).rows.map((x) => x.id)).toEqual(['b']);
  });
  it('모두 / 하나라도', () => {
    const c = [m.newCond('cpuTemp', 'ge', '70'), m.newCond('gpuTemp', 'ge', '65')];
    expect(m.filterTable(rows, c, 'all').rows).toEqual([]);
    expect(m.filterTable(rows, c, 'any').rows.map((x) => x.id)).toEqual(['a', 'b']);
    expect(m.filterTable(rows, c, 'any').unknown).toBe(1);
  });
  it('조건 없으면 전부 · 숫자 아닌 값은 조건이 아니다(0 으로 읽지 않는다)', () => {
    expect(m.filterTable(rows, [m.newCond('cpuTemp', 'le', 'abc')]).rows).toHaveLength(3);
    expect(m.condText([m.newCond('cpuTemp', 'ge', '70'), m.newCond('powerW', 'le', '300')], 'any')).toBe('CPU 온도 70℃ 이상 또는 소비 전력 300W 이하');
    expect(m.cellHit(rows[0], 'cpuTemp', [m.newCond('cpuTemp', 'ge', '70')])).toBe(true);
    expect(m.cellHit(rows[1], 'cpuTemp', [m.newCond('cpuTemp', 'ge', '70')])).toBe(false);
  });
  it('표 CSV — BOM · 결측은 빈 칸 · 수식 가드', () => {
    const csv = m.tableCsv([{ ...rows[2], name: '=cmd', corpName: 'HM', site: 's', kind: 'esxi' }], 24);
    expect(csv.startsWith('﻿# 최근 24시간')).toBe(true);
    expect(csv).toContain("HM,s,'=cmd,,ESXi,,,");
  });
  it('기간 라벨 · CPU 진단 문구', () => {
    expect(m.hoursLabel(6)).toBe('6시간'); expect(m.hoursLabel(168)).toBe('7일'); expect(m.hoursLabel(24)).toBe('24시간');
    expect(m.cpuDiagText({ code: 'ok', source: 'sensor', name: 'CPU Usage' })).toMatch(/CPU 센서\(CPU Usage\)/);
    expect(m.cpuDiagText({ code: 'ok', source: 'bmIdrac' })).toMatch(/iDRAC 대체 경로/);
    expect(m.cpuDiagText({ code: 'sensor-stale', ageMs: 3 * 3_600_000 })).toMatch(/3시간 전/);
    expect(m.cpuDiagText({ code: 'bm-os-only' })).toMatch(/OS\(SSH\) 경로라/);
    expect(m.cpuDiagText({ code: 'no-idrac-cpu' })).toMatch(/vCenter 값은 쓰지 않습니다/);
    expect(m.cpuDiagText({ code: 'sensor-stale', ageMs: '' })).toMatch(/— 전/);
    expect(m.cpuDiagText(null)).toBe('');
  });
  it('v2.665 멈춤 배너 — 어디서 멈췄는지 가른다', () => {
    expect(m.idracStateBanner(null)).toBe(null);
    expect(m.idracStateBanner({ stale: null, remote: true })).toBe(null);
    const T = new Date(2026, 8, 30, 2, 32).getTime();
    const edge = m.idracStateBanner({ stale: 'stale', remote: true, sampleAt: T, ageMs: 80 * 60_000, maxAgeMs: 15 * 60_000, collector: { known: true, ok: true, id: 'OC2', lastOkAt: T, lastOkAgeMs: 60_000 } });
    expect(edge.tone).toBe('amber'); expect(edge.title).toMatch(/엣지의 iDRAC 수집/);
    expect(edge.lines.join()).toMatch(/1시간 20분 전\(02:32\).*15분/);
    expect(edge.lines.join()).toMatch(/collect\.idrac/);
    const pull = m.idracStateBanner({ stale: 'stale', remote: true, sampleAt: T, ageMs: 1, maxAgeMs: 1, collector: { known: true, ok: false, id: 'OC2', lastOkAt: null, fails: 5, error: 'timeout' } });
    expect(pull.tone).toBe('red'); expect(pull.lines.join()).toMatch(/연속 실패 5회.*사유: timeout/);
    const hidden = m.idracStateBanner({ stale: 'stale', remote: true, collector: { known: true, ok: false, id: 'c', errorHidden: true } });
    expect(hidden.lines.join()).toMatch(/전체 범위 관리자에게만/);
    expect(m.idracStateBanner({ stale: 'stale', remote: true, collector: { known: false } }).lines.join()).toMatch(/모릅니다/);
    expect(m.idracStateBanner({ stale: 'stale', remote: false, sampleAt: T, ageMs: 60_000, maxAgeMs: 1 }).lines.join()).toMatch(/직접 폴링/);
    for (const b of [edge, pull]) expect(b.lines.join()).not.toMatch(/`/);
  });
});

describe('v2.693 — 중앙 pull 이 멈췄으면 엣지 탓으로 말하지 않는다', async () => {
  const m = await import('./idracTrendText.js');
  it('ok 로 남은 상태라도 pullStale 이면 빨간 배너 · 중앙 pull 을 지목한다', () => {
    const b = m.idracStateBanner({ stale: 'stale', remote: true, sampleAt: 1, ageMs: 50 * 60_000, maxAgeMs: 15 * 60_000,
      collector: { known: true, ok: true, id: 'GM1', lastOkAt: 1, lastOkAgeMs: 41 * 60_000, pullStale: true, pullIntervalMs: 60_000, pullerRunningForMs: 12 * 60_000, pullerStuckReleases: 2 } });
    expect(b.tone).toBe('red');
    expect(b.title).toMatch(/중앙이 엣지에서/);
    const t = b.lines.join();
    expect(t).toMatch(/41분째 pull 하지 못하고/);
    expect(t).toMatch(/12분째/);
    expect(t).toMatch(/2회 버렸습니다/);
    expect(t).not.toMatch(/pull 은 정상/);
    expect(t).not.toMatch(/`/);
  });
  it('pullStale 이 없으면 예전 판정 그대로', () => {
    const b = m.idracStateBanner({ stale: 'stale', remote: true, collector: { known: true, ok: true, id: 'GM1', lastOkAt: 1, lastOkAgeMs: 60_000 } });
    expect(b.title).toMatch(/엣지의 iDRAC 수집/);
  });
});

// v2.666 ────────────────────────────────────────────────────────────────
import {
  CHART_SERIES, HOST_CPU_SERIES, loadCpuRef, saveCpuRef, showCpuRef, maxBackOf, scrollWindow, scrollLabel, presetSpanOf,
  hostCpuNote, DEFAULT_ORDER as ORDER2666, normalizeStyles as ns2666,
} from './idracTrendText.js';
import { SERIES as S2666, gapAreas as gap2666, kindBasisText as kb2666 } from './idracTrendText.js';

describe('v2.666 ESXi CPU(vCenter) 계열 · 기준선 토글 · 과거 스크롤', () => {
  it('ESXi CPU 는 차트 계열에만 — iDRAC 6계열(표·조건·무응답 판정)에는 넣지 않는다', () => {
    expect(S2666.some((s) => s.k === 'hostCpuPct')).toBe(false);
    expect(CHART_SERIES.includes(HOST_CPU_SERIES)).toBe(true);
    expect(ORDER2666).toContain('hostCpuPct');
    expect(ns2666(null).hostCpuPct.dash).toBe('dot');
    // iDRAC 값이 모두 비고 vCenter 값만 있는 점은 여전히 'iDRAC 무응답' 이다
    const pts = [{ t: 1, cpuPct: 5 }, { t: 2, hostCpuPct: 40 }, { t: 3, cpuPct: 6 }];
    expect(gap2666(pts)).toEqual([{ x1: 2, x2: 3 }]);
  });
  it('기준선 토글 — 기본 켜짐 · 끄면 저장 · 저장 실패는 조용히', () => {
    const m = new Map();
    const st = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) };
    expect(loadCpuRef(st)).toBe(true);
    saveCpuRef(st, false); expect(loadCpuRef(st)).toBe(false);
    saveCpuRef(st, true); expect(loadCpuRef(st)).toBe(true);
    expect(loadCpuRef({ getItem: () => { throw new Error('x'); } })).toBe(true);
    const s = { cpuPct: { cur: 1 } };
    expect(showCpuRef(true, { cpuPct: true }, s)).toBe(true);
    expect(showCpuRef(false, { cpuPct: true }, s)).toBe(false);
    expect(showCpuRef(true, { cpuPct: false, hostCpuPct: true }, { hostCpuPct: { cur: 3 } })).toBe(true);
    expect(showCpuRef(true, { cpuPct: true }, {})).toBe(false);
  });
  it('과거 스크롤 — 같은 길이 창을 칸 단위로 · 보관 기간 안 · 기준 끝 고정', () => {
    const H = 3_600_000;
    expect(presetSpanOf('1h')).toBe(H); expect(presetSpanOf('custom')).toBe(null);
    expect(maxBackOf(H, 1)).toBe(23);
    expect(maxBackOf(H, 0)).toBe(0);
    const w = scrollWindow(H, 2, 10 * H);
    expect(w).toEqual({ start: 7 * H, end: 8 * H, back: 2 });
    expect(scrollWindow(H, 99, 10 * H, 3).back).toBe(3);
    expect(scrollWindow(H, -5, 10 * H).back).toBe(0);
    expect(scrollLabel(0, '1h')).toBe('최근 구간');
    expect(scrollLabel(3, '1h')).toBe('3칸 전 (1시간 단위)');
  });
  it('매칭 근거·각주 — 호스트네임 매칭을 말하고, 매칭이 없으면 각주 없음', () => {
    expect(kb2666({ kind: 'esxi', matchedBy: 'hostname', host: { name: 'esx01' }, serviceTag: '' })).toContain('호스트네임 일치');
    expect(kb2666({ kind: 'baremetal', serviceTag: 'ABC', hostAmbiguous: true })).toContain('여럿');
    expect(hostCpuNote({})).toBe('');
    expect(hostCpuNote({ hostCpu: { hostName: 'esx01', matchedBy: 'serviceTag' } })).toContain('섞지 않습니다');
  });
});

import { HOST_GPU_SERIES, SERIES as S2668, shownSeriesOf, hostGpuEmptyText, hostGpuNote } from './idracTrendText.js';
describe('v2.668 ESXi 호스트 GPU 계열', () => {
  it('iDRAC SERIES 에 섞지 않고 차트 계열에만 둔다', () => {
    expect(S2668.some((s) => s.gpu || s.vc)).toBe(false);
    expect(HOST_GPU_SERIES.map((s) => s.k)).toEqual(['hostGpuPct', 'hostGpuMemPct']);
    for (const s of HOST_GPU_SERIES) expect(CHART_SERIES).toContain(s);
  });
  it('매칭 없음 → 숨김 · GPU 없음 확인 → 숨김 · 모름 → 보임', () => {
    const ks = (d) => shownSeriesOf(d).map((s) => s.k);
    expect(ks(null)).not.toContain('hostGpuPct');
    expect(ks({ hostCpu: {}, hostGpu: { hasGpu: false } })).not.toContain('hostGpuPct');
    expect(ks({ hostCpu: {}, hostGpu: { hasGpu: false } })).toContain('hostCpuPct');
    expect(ks({ hostCpu: {}, hostGpu: { hasGpu: null } })).toContain('hostGpuMemPct');
    expect(ks({ hostCpu: {}, hostGpu: { hasGpu: true } })).toContain('hostGpuPct');
  });
  it('각주는 출처를 밝히고 값이 없으면 그렇게 말한다', () => {
    expect(hostGpuNote({ hostGpu: { hostName: 'esx01', hasGpu: true, firstTs: {} } })).toMatch(/iDRAC 값이 아닙니다.*아직 적재된 값이 없습니다/);
    expect(hostGpuNote({ hostGpu: { hasGpu: false } })).toBe('');
    expect(hostGpuEmptyText({ hostGpu: { hasGpu: false } })).toBe('GPU 없음');
    expect(hostGpuEmptyText({ hostGpu: { hasGpu: true } })).toMatch(/GPU 모니터링/);
  });
});

describe('v2.712 GPU 온도 기준선', () => {
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  it('값은 정수 45 이상 100 미만만', () => {
    expect(T.gpuRefValueOf(45)).toBe(45);
    expect(T.gpuRefValueOf(99)).toBe(99);
    expect(T.gpuRefValueOf('80')).toBe(80);
    for (const bad of [44, 100, 120, 85.5, '', '  ', '8e1', null, undefined, true, [85], NaN]) expect(T.gpuRefValueOf(bad)).toBe(null);
  });
  it('잘못된 칸은 그 칸만 버리고 직전 값을 유지한다', () => {
    let r = T.normalizeGpuRef(null);
    expect(r).toEqual({ on: true, value: 85, color: '#ec4899', width: 2 });
    r = T.setGpuRef(r, { value: 70, color: '#22C55E', width: 4 });
    expect(r).toEqual({ on: true, value: 70, color: '#22c55e', width: 4 });
    r = T.setGpuRef(r, { value: '', color: 'red;x', width: 9 });
    expect(r).toEqual({ on: true, value: 70, color: '#22c55e', width: 4 });
    r = T.setGpuRef(r, { value: 100 });
    expect(r.value).toBe(70);
  });
  it('저장은 기본값과 다를 때만 · 손상된 저장값은 기본값', () => {
    const s = mem();
    T.saveGpuRef(s, T.normalizeGpuRef(null));
    expect(s.m.has(T.GPU_REF_KEY)).toBe(false);
    T.saveGpuRef(s, { on: false, value: 60, color: '#ef4444', width: 3 });
    expect(T.loadGpuRef(s)).toEqual({ on: false, value: 60, color: '#ef4444', width: 3 });
    s.setItem(T.GPU_REF_KEY, '{not json');
    expect(T.loadGpuRef(s)).toEqual(T.normalizeGpuRef(null));
    s.setItem(T.GPU_REF_KEY, JSON.stringify({ value: 30, color: 'url(x)', width: '2' }));
    expect(T.loadGpuRef(s)).toEqual(T.normalizeGpuRef(null));
  });
  it('GPU 온도 계열이 보일 때만 그린다', () => {
    const r = T.normalizeGpuRef(null);
    expect(T.showGpuRef(r, { gpuTemp: true }, { gpuTemp: { max: 30 } })).toBe(true);
    expect(T.showGpuRef(r, { gpuTemp: false }, { gpuTemp: { max: 30 } })).toBe(false);
    expect(T.showGpuRef(r, { gpuTemp: true }, { gpuTemp: null })).toBe(false);
    expect(T.showGpuRef({ ...r, on: false }, { gpuTemp: true }, { gpuTemp: { max: 30 } })).toBe(false);
  });
});
