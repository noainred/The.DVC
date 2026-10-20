// v2.746 — 가상머신 상세 C안(분포 차트 + 표) 판정·문구(vmDistText.js) · 화면 소스 스윕(Vms.jsx · VmDistPanels.jsx · vmDist.css).
//   서버 계약(server/src/inventory/vmDist.js vmDistribution): 칸 번호·개수는 서버가 세고, 화면은 그 결과를 그리기만 한다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { stripComments } from '../test/_stripComments.js';
import { WARN_PCT, CRIT_PCT } from '../console/consoleData.js';
import {
  BIN_PCT, BIN_COUNT, WARN_BIN, CRIT_BIN, EMPTY_FACETS, TONE_COLOR,
  binTone, binColor, binSelected, barHeights, binLabel, parseBinSel, selLabel, thresholdSel, thresholdCount,
  toggleBin, toggleSel, facetParams, facetKey, hasFacet, clearFacet, chipList, osLabel, distNote, panelState,
  panelCount, pctTone, usageView, powerDot, specText, specSort, powerSegments, gpuSegments, osRows, osFooter,
  facetErrorText, NO_DIST_TEXT, EMPTY_PANEL_TEXT, POWER_LABEL, binAria, gpuToggle,
  selectionView, binButton,
} from './vmDistText.js';
import { vmPageQueryKey, pageNavState } from './vmPageText.js';

const src = (rel) => stripComments(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'));
const bins20 = (fill = 0) => Array.from({ length: 20 }, () => fill);
const panel = (over = {}) => ({ bins: bins20(0), na: 0, off: 0, over100: 0, ...over });
const dist = (over = {}) => ({
  binPct: 5, bins: 20, total: 0,
  cpu: panel(), mem: panel(),
  power: { on: 0, off: 0, suspended: 0, other: 0 },
  gpu: { total: 0, vgpu: 0, passthrough: 0, mixed: 0, none: 0 },
  os: { top: [], other: 0, distinct: 0, unknownKey: '~' },
  selected: {},
  ...over,
});

describe('칸 판정 — 임계값은 consoleData 의 75·90 하나', () => {
  it('상수는 consoleData 와 같다(숫자를 박지 않는다)', () => {
    expect(BIN_PCT).toBe(5);
    expect(BIN_COUNT).toBe(20);
    expect(WARN_BIN).toBe(WARN_PCT / 5);
    expect(CRIT_BIN).toBe(CRIT_PCT / 5);
    expect(WARN_BIN).toBe(15);
    expect(CRIT_BIN).toBe(18);
    expect(src('./vmDistText.js')).toMatch(/from '\.\.\/console\/consoleData\.js'/);
  });
  it('binTone — 칸 하한 90 이상 crit · 75 이상 warn · 그 밖 ok (경계 칸 15·18 포함)', () => {
    const t = Array.from({ length: 20 }, (_, i) => binTone(i));
    expect(t.slice(0, 15).every((x) => x === 'ok')).toBe(true);
    expect(t.slice(15, 18)).toEqual(['warn', 'warn', 'warn']);
    expect(t.slice(18)).toEqual(['crit', 'crit']);
    expect(binTone(14)).toBe('ok');
  });
  it('binColor — 선택 밖 ok 칸만 흐린 색 · warn·crit 은 제 색 · 선택이 없으면 전부 제 색', () => {
    expect(binColor(3, '')).toBe(TONE_COLOR.ok);
    expect(binColor(3, '18-19')).toBe(TONE_COLOR.dim);
    expect(binColor(16, '18-19')).toBe(TONE_COLOR.warn);
    expect(binColor(18, '18-19')).toBe(TONE_COLOR.crit);
    expect(binColor(3, '3-3')).toBe(TONE_COLOR.ok);
    expect(binColor(3, 'na')).toBe(TONE_COLOR.dim);
    for (const c of Object.values(TONE_COLOR)) expect(c).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
  it('pctTone — 표 칸(값 없음은 none · 0 은 ok)', () => {
    expect(pctTone(null)).toBe('none');
    expect(pctTone('')).toBe('none');
    expect(pctTone(0)).toBe('ok');
    expect(pctTone(74.9)).toBe('ok');
    expect(pctTone(75)).toBe('warn');
    expect(pctTone(89.9)).toBe('warn');
    expect(pctTone(90)).toBe('crit');
    expect(pctTone(150)).toBe('crit');
  });
});

describe('막대 높이 — 0 칸은 0(온도색 금지) · 개수가 있으면 최소 3%', () => {
  it('최댓값 대비 % · 최소 3% · 0 칸 zero', () => {
    const b = bins20(0); b[0] = 200; b[1] = 1; b[19] = 100;
    const h = barHeights(b);
    expect(h).toHaveLength(20);
    expect(h[0]).toEqual({ n: 200, h: 100, zero: false });
    expect(h[1]).toEqual({ n: 1, h: 3, zero: false });
    expect(h[19]).toEqual({ n: 100, h: 50, zero: false });
    expect(h[5]).toEqual({ n: 0, h: 0, zero: true });
  });
  it('전부 0·배열 아님·길이 부족은 0 으로 채운다(NaN 없음)', () => {
    expect(barHeights(bins20(0)).every((x) => x.h === 0 && x.zero)).toBe(true);
    expect(barHeights(null)).toHaveLength(20);
    const odd = barHeights([5, 'x', null, -3]);
    expect(odd).toHaveLength(20);
    expect(odd[0]).toEqual({ n: 5, h: 100, zero: false });
    expect(odd[1].zero && odd[2].zero && odd[3].zero).toBe(true);
    expect(odd.every((x) => Number.isFinite(x.h))).toBe(true);
  });
});

describe('구간 문구·선택', () => {
  it('binLabel — 끝은 (b+1)*5 · na 는 미수집', () => {
    expect(binLabel(18, 19)).toBe('90~100%');
    expect(binLabel(18, 18)).toBe('90~95%');
    expect(binLabel(0)).toBe('0~5%');
    expect(binLabel(15, 19)).toBe('75~100%');
    expect(binLabel('na')).toBe('사용률 미수집');
  });
  it('parseBinSel — 정수 0~19 · a≤b · na · 그 밖 null', () => {
    expect(parseBinSel('18-19')).toEqual({ a: 18, b: 19 });
    expect(parseBinSel('3-3')).toEqual({ a: 3, b: 3 });
    expect(parseBinSel('na')).toEqual({ na: true });
    for (const bad of ['', null, undefined, '19-18', '0-20', '-1-3', '1.5-2', 'a-b', '3', ['1-2'], 5]) expect(parseBinSel(bad)).toBe(null);
    expect(selLabel('18-19')).toBe('90~100%');
    expect(selLabel('na')).toBe('사용률 미수집');
    expect(selLabel('')).toBe('');
  });
  it('thresholdSel — 90%↑ = 18-19 · 75%↑ = 15-19 · 머리 개수는 그 칸들의 합', () => {
    expect(thresholdSel('crit')).toBe('18-19');
    expect(thresholdSel('warn')).toBe('15-19');
    const b = bins20(1); b[14] = 100; b[15] = 2; b[18] = 7; b[19] = 3;
    const p = panel({ bins: b });
    expect(thresholdCount(p, 'crit')).toBe(10);
    expect(thresholdCount(p, 'warn')).toBe(2 + 1 + 1 + 7 + 3);
    expect(thresholdCount(null, 'crit')).toBe(null);
  });
  it('toggleBin·toggleSel — 같은 칸을 다시 누르면 해제 · 다른 칸은 그 칸만', () => {
    expect(toggleBin('', 18)).toBe('18-18');
    expect(toggleBin('18-18', 18)).toBe('');
    expect(toggleBin('18-19', 18)).toBe('18-18');
    expect(toggleBin('3-3', 4)).toBe('4-4');
    expect(toggleBin('', 'na')).toBe('na');
    expect(toggleBin('na', 'na')).toBe('');
    expect(toggleSel('', '18-19')).toBe('18-19');
    expect(toggleSel('18-19', '18-19')).toBe('');
    expect(toggleSel('15-19', '18-19')).toBe('18-19');
  });
  it('panelCount — 선택 구간 합 · na · 패널 없음 null', () => {
    const b = bins20(0); b[18] = 11; b[19] = 7; b[2] = 5;
    const p = panel({ bins: b, na: 9 });
    expect(panelCount(p, '18-19')).toBe(18);
    expect(panelCount(p, '18-18')).toBe(11);
    expect(panelCount(p, 'na')).toBe(9);
    expect(panelCount(null, '18-19')).toBe(null);
    expect(panelCount(p, '')).toBe(null);
  });
  it('binAria — 화면판독 라벨은 구간 + 개수', () => {
    expect(binAria('CPU', 18, 11)).toBe('CPU 90~95% 11대');
    expect(binAria('메모리', 'na', 1234)).toBe('메모리 사용률 미수집 1,234대');
  });
});

describe('facet 쿼리 — 빈 값은 키를 빼고 보낸다', () => {
  it('facetParams', () => {
    expect(facetParams(EMPTY_FACETS)).toEqual({});
    expect(facetParams(null)).toEqual({});
    expect(facetParams({ cpuBin: '18-19', memBin: '', power: 'off', osName: '  Ubuntu 22.04 ' })).toEqual({ cpuBin: '18-19', power: 'off', osName: 'Ubuntu 22.04' });
    expect(facetParams({ cpuBin: 'na', memBin: '3-3', power: '', osName: '~' })).toEqual({ cpuBin: 'na', memBin: '3-3', osName: '~' });
    // 형식이 틀린 값은 보내지 않는다(서버가 400 bad-facet 로 거절하는 값을 만들지 않는다)
    expect(facetParams({ cpuBin: '19-18', memBin: 'x', power: 'maybe', osName: '   ' })).toEqual({});
    expect(facetParams({ osName: 'x'.repeat(201) })).toEqual({});
    expect(facetParams({ osName: 'x'.repeat(200) })).toEqual({ osName: 'x'.repeat(200) });
  });
  it('facetKey·hasFacet·clearFacet', () => {
    expect(facetKey(EMPTY_FACETS)).toBe('');
    expect(facetKey({ power: 'on', cpuBin: '1-1' })).toBe(facetKey({ cpuBin: '1-1', power: 'on' }));
    expect(facetKey({ power: 'on' })).not.toBe(facetKey({ power: 'off' }));
    expect(hasFacet(EMPTY_FACETS)).toBe(false);
    expect(hasFacet({ ...EMPTY_FACETS, osName: '~' })).toBe(true);
    expect(clearFacet({ ...EMPTY_FACETS, cpuBin: '1-1', power: 'on' }, 'cpuBin')).toEqual({ ...EMPTY_FACETS, power: 'on' });
  });
  it('vmPageQueryKey — facet 이 바뀌면 키가 바뀐다 · 빈 facet 은 예전 키와 같다(기존 호출 호환)', () => {
    const base = vmPageQueryKey({ q: 'a' }, false, '');
    expect(vmPageQueryKey({ q: 'a' }, false, '', EMPTY_FACETS)).toBe(base);
    expect(vmPageQueryKey({ q: 'a' }, false, '', undefined)).toBe(base);
    expect(vmPageQueryKey({ q: 'a' }, false, '', { cpuBin: '18-19' })).not.toBe(base);
    expect(vmPageQueryKey({}, false, '', { cpuBin: '18-19' })).not.toBe(vmPageQueryKey({}, false, '', { cpuBin: '18-18' }));
    expect(vmPageQueryKey({}, false, '', { power: 'on', osName: 'X' })).toBe(vmPageQueryKey({}, false, '', { osName: 'X', power: 'on' }));
  });
  it('facetErrorText — 400 bad-facet 은 선택 해제를 안내 · 다른 오류는 빈 문자열', () => {
    expect(facetErrorText('bad-facet')).toMatch(/해제/);
    expect(facetErrorText({ message: 'bad-facet' })).toMatch(/해제/);
    expect(facetErrorText('forbidden')).toBe('');
    expect(facetErrorText(null)).toBe('');
  });
});

describe('선택 칩 — 문구·× 대상·개수(개수는 dist 의 그 패널 합)', () => {
  const b = bins20(0); b[18] = 11; b[19] = 7;
  const d = dist({
    total: 18, cpu: panel({ bins: b }), mem: panel({ bins: bins20(1), na: 2 }),
    power: { on: 18, off: 3, suspended: 0, other: 0 },
    gpu: { total: 5, vgpu: 4, passthrough: 1, mixed: 0, none: 13 },
    os: { top: [{ name: 'Ubuntu 22.04', n: 12, selected: true }, { name: '~', n: 2, selected: false }], other: 4, distinct: 3, unknownKey: '~' },
  });
  it('CPU 90~100% · 18대 — crit 톤', () => {
    const c = chipList({ ...EMPTY_FACETS, cpuBin: '18-19' }, d, {});
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ key: 'cpuBin', tone: 'crit', count: 18 });
    expect(c[0].text).toBe('CPU 90~100% · 18대');
  });
  it('여러 칩 · 전원·OS·GPU · 개수는 각 패널', () => {
    const c = chipList({ cpuBin: '', memBin: 'na', power: 'on', osName: 'Ubuntu 22.04' }, d, { gpuOnly: true, gpuType: 'vgpu' });
    expect(c.map((x) => x.key)).toEqual(['memBin', 'power', 'osName', 'gpu']);
    expect(c[0].text).toBe('메모리 사용률 미수집 · 2대');
    expect(c[1].text).toBe(`전원 ${POWER_LABEL.on} · 18대`);
    expect(c[2].text).toBe('OS Ubuntu 22.04 · 12대');
    expect(c[3].text).toBe('GPU vGPU · 4대');
    const g = chipList(EMPTY_FACETS, d, { gpuOnly: true, gpuType: '' });
    expect(g[0].text).toBe('GPU 할당 VM · 5대');
  });
  it('dist 가 없으면(구버전 서버) 개수 없이', () => {
    const c = chipList({ ...EMPTY_FACETS, cpuBin: '18-19', osName: '~' }, null, {});
    expect(c[0].text).toBe('CPU 90~100%');
    expect(c[0].count).toBe(null);
    expect(c[1].text).toBe('OS (OS 정보 없음)');
  });
  it('선택이 없으면 칩 0개', () => {
    expect(chipList(EMPTY_FACETS, d, {})).toEqual([]);
  });
});

describe('패널 문구', () => {
  it('osLabel', () => {
    expect(osLabel('~')).toBe('(OS 정보 없음)');
    expect(osLabel('')).toBe('(OS 정보 없음)');
    expect(osLabel(null)).toBe('(OS 정보 없음)');
    expect(osLabel('RHEL 9')).toBe('RHEL 9');
  });
  it('distNote — 읽은 수 · 미수집 · 분포 밖 · 100% 초과(0 인 조각은 생략)', () => {
    const b = bins20(0); b[0] = 1000; b[19] = 661;
    expect(distNote(panel({ bins: b, na: 150, off: 371, over100: 3 }))).toBe('구동 중이고 사용률을 읽은 1,661대 · 미수집 150대는 따로 · 구동 중이 아닌 371대는 분포 밖 · 100% 초과 3대는 마지막 칸');
    expect(distNote(panel({ bins: b }))).toBe('구동 중이고 사용률을 읽은 1,661대');
    expect(distNote(null)).toBe('');
  });
  it('panelState — 구동 0 → none · 읽은 것 0 → unread · 그 밖 ok · 없음 missing', () => {
    expect(panelState(null)).toBe('missing');
    expect(panelState(panel({ off: 5 }))).toBe('none');
    expect(panelState(panel({ na: 4 }))).toBe('unread');
    const b = bins20(0); b[3] = 1;
    expect(panelState(panel({ bins: b }))).toBe('ok');
    expect(EMPTY_PANEL_TEXT.none).toBe('구동 중인 VM 이 없어 분포가 없습니다');
    expect(EMPTY_PANEL_TEXT.unread).toMatch(/읽지 못했습니다/);
    expect(NO_DIST_TEXT).toMatch(/표/);
  });
  it('powerSegments — 비율 · 0 인 칸은 막대에서 빼되 고른 칸은 남긴다', () => {
    const s = powerSegments({ on: 75, off: 25, suspended: 0, other: 0 }, '');
    expect(s.total).toBe(100);
    expect(s.items.map((x) => x.key)).toEqual(['on', 'off']);
    expect(s.items[0]).toMatchObject({ n: 75, w: 75, label: POWER_LABEL.on });
    const sel = powerSegments({ on: 75, off: 25, suspended: 0, other: 0 }, 'suspended');
    expect(sel.items.map((x) => x.key)).toEqual(['on', 'off', 'suspended']);
    expect(sel.items[2]).toMatchObject({ n: 0, w: 0, selected: true });
    expect(powerSegments(null, '').total).toBe(0);
  });
  it('gpuSegments — vGPU·패스쓰루·혼합 비율은 전체(할당+없음) 대비', () => {
    const s = gpuSegments({ total: 128, vgpu: 103, passthrough: 25, mixed: 0, none: 2054 }, { gpuOnly: false, gpuType: '' });
    expect(s.total).toBe(128);
    expect(s.none).toBe(2054);
    expect(s.items.map((x) => x.key)).toEqual(['vgpu', 'passthrough']);
    expect(s.items[0].w).toBeCloseTo((103 / 2182) * 100, 5);
    const m = gpuSegments({ total: 3, vgpu: 1, passthrough: 1, mixed: 1, none: 0 }, { gpuOnly: true, gpuType: 'mixed' });
    expect(m.items.find((x) => x.key === 'mixed').selected).toBe(true);
    expect(m.allSelected).toBe(false);
    expect(gpuSegments({ total: 3, vgpu: 3, passthrough: 0, mixed: 0, none: 1 }, { gpuOnly: true, gpuType: '' }).allSelected).toBe(true);
  });
  it('gpuToggle — 기존 gpuOnly·gpuType 상태로 · 같은 것을 다시 누르면 해제', () => {
    expect(gpuToggle({ gpuOnly: false, gpuType: '' }, 'all')).toEqual({ gpuOnly: true, gpuType: '' });
    expect(gpuToggle({ gpuOnly: true, gpuType: '' }, 'all')).toEqual({ gpuOnly: false, gpuType: '' });
    expect(gpuToggle({ gpuOnly: true, gpuType: 'vgpu' }, 'all')).toEqual({ gpuOnly: true, gpuType: '' });
    expect(gpuToggle({ gpuOnly: false, gpuType: '' }, 'vgpu')).toEqual({ gpuOnly: true, gpuType: 'vgpu' });
    expect(gpuToggle({ gpuOnly: true, gpuType: 'vgpu' }, 'vgpu')).toEqual({ gpuOnly: false, gpuType: '' });
    expect(gpuToggle({ gpuOnly: true, gpuType: 'vgpu' }, 'passthrough')).toEqual({ gpuOnly: true, gpuType: 'passthrough' });
    expect(gpuToggle(null, 'bogus')).toEqual({ gpuOnly: false, gpuType: '' });
  });
  it('osRows·osFooter — 폭은 상위 최댓값 대비 · 그 밖 N대 · 종류 M가지', () => {
    const os = { top: [{ name: 'A', n: 100, selected: false }, { name: '~', n: 25, selected: false }, { name: 'Z', n: 0, selected: true }], other: 7, distinct: 9 };
    const r = osRows(os, 'Z');
    expect(r.map((x) => x.label)).toEqual(['A', '(OS 정보 없음)', 'Z']);
    expect(r[0].w).toBe(100);
    expect(r[1].w).toBe(25);
    expect(r[2]).toMatchObject({ w: 0, selected: true, name: 'Z' });
    expect(osFooter(os)).toBe('그 밖 7대 · OS 종류 9가지');
    expect(osFooter({ top: [], other: 0, distinct: 0 })).toBe('');
    expect(osRows(null)).toEqual([]);
  });
});

describe('표 칸', () => {
  it('usageView — 값 없음은 — · 막대 폭은 0~100 · 문구는 값 그대로', () => {
    expect(usageView(null)).toEqual({ text: '—', w: 0, tone: 'none' });
    expect(usageView(97)).toEqual({ text: '97%', w: 97, tone: 'crit' });
    expect(usageView(150)).toEqual({ text: '150%', w: 100, tone: 'crit' });
    expect(usageView(0)).toEqual({ text: '0%', w: 0, tone: 'ok' });
  });
  it('powerDot — 색 + 글자(화면판독)', () => {
    expect(powerDot('POWERED_ON')).toMatchObject({ key: 'on', label: '구동 중' });
    expect(powerDot('POWERED_OFF')).toMatchObject({ key: 'off', label: '꺼짐' });
    expect(powerDot('SUSPENDED')).toMatchObject({ key: 'suspended', label: '일시정지' });
    expect(powerDot(undefined)).toMatchObject({ key: 'other', label: '전원 상태 모름' });
    for (const s of ['POWERED_ON', 'POWERED_OFF', 'SUSPENDED', null]) expect(powerDot(s).color).toMatch(/^var\(--[a-z0-9-]+\)$/);
  });
  it('specText·specSort — vCPU 우선 그다음 메모리 · 둘 다 없으면 null', () => {
    expect(specText({ cpuCount: 32, memMB: 131072 })).toBe('32 · 128 GB');
    expect(specText({ cpuCount: 4, memMB: null })).toBe('4 · —');
    expect(specText({})).toBe('—');
    expect(specSort({ cpuCount: 8, memMB: 1024 })).toBeGreaterThan(specSort({ cpuCount: 4, memMB: 999999 }));
    expect(specSort({ cpuCount: 8, memMB: 2048 })).toBeGreaterThan(specSort({ cpuCount: 8, memMB: 1024 }));
    expect(specSort({})).toBe(null);
  });
});

describe('화면 소스 스윕 — 백틱·별표·uppercase·.vmd 밖 선택자 0', () => {
  const files = ['./vmDistText.js', './VmDistPanels.jsx', './Vms.jsx'];
  it('문구에 이스케이프 백틱·** 없음', () => {
    for (const f of files) {
      const s = src(f);
      expect(s, f).not.toMatch(/\\`/);
      expect(s, f).not.toMatch(/\*\*/);
    }
  });
  it('vmDist.css — 선택자는 전부 .vmd 아래 · uppercase 없음 · 색은 .vmd 토큰 블록 밖에서 var(--…)', () => {
    const css = fs.readFileSync(new URL('./vmDist.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/text-transform\s*:\s*uppercase/);
    const selectors = css.replace(/@(media|container)[^{]+\{/g, '').split('}').map((x) => x.split('{')[0].trim()).filter(Boolean);
    const bad = selectors.flatMap((s) => s.split(',').map((x) => x.trim())).filter((x) => !/^\.vmd($|[\s.:>[])/.test(x));
    expect(bad).toEqual([]);
    expect(selectors.length).toBeGreaterThan(10);
  });
  it('Vms.jsx — 분포 dist=1 요청 · facet 을 queryKey 에 · 기존 정렬 안내 문장 유지 · 공용 UsageCell 을 바꾸지 않음', () => {
    const s = src('./Vms.jsx');
    expect(s).toMatch(/dist: '1'/);
    expect(s).toMatch(/facetParams\(facets\)/);
    expect(s).toMatch(/vmPageQueryKey\(filters, gpuOnly, gpuType, facets\)/);
    expect(s).toMatch(/표의 다른 열로 정렬하면 이 페이지 안에서만 정렬됩니다/);
    expect(src('../components/primitives.jsx')).toMatch(/if \(pct >= 75\) return 'var\(--amber\)'/);
  });
});

describe('선택 반영 중(흐림) — 직전 응답의 커서·개수를 지금 조건에 쓰지 않는다 (W-R1·C-01·W-R4)', () => {
  // 직전 응답: 선택 없음 · 1,000대를 넘어 다음 페이지 커서가 있다.
  const b = bins20(0); b[0] = 20; b[18] = 11; b[19] = 7;
  const R0 = { total: 2242, hasMore: true, nextCursor: 'CURSOR-NOFACET', dist: dist({ cpu: panel({ bins: b }), mem: panel({ bins: b }) }) };
  const last0 = { data: R0, baseKey: 'B', fKey: '' };
  it('응답이 지금 조건의 것이면 current', () => {
    const v = selectionView({ data: R0, loading: false, last: last0, baseKey: 'B', fKey: '' });
    expect(v).toEqual({ view: R0, pendingSel: false, current: true });
    expect(pageNavState([], v.current ? v.view : null).canNext).toBe(true);
  });
  it('막대를 누른 직후 한 렌더(usePolling 이 아직 옛 응답을 들고 있다) — current=false 라 다음 페이지가 꺼진다', () => {
    const v = selectionView({ data: R0, loading: false, last: last0, baseKey: 'B', fKey: 'F1' });
    expect(v.view).toBe(R0);
    expect(v.pendingSel).toBe(false);
    expect(v.current).toBe(false);
    expect(pageNavState([], v.current ? v.view : null)).toMatchObject({ canNext: false, nextCursor: null, canPrev: false });
  });
  it('선택 반영 중 — 옛 응답을 흐리게 보이되 그 응답의 nextCursor 로 다음 페이지를 켜지 않는다', () => {
    const v = selectionView({ data: null, loading: true, last: last0, baseKey: 'B', fKey: 'F1' });
    expect(v.pendingSel).toBe(true);
    expect(v.view).toBe(R0);
    expect(v.current).toBe(false);
    const nav = pageNavState([], v.current ? v.view : null);
    expect(nav.canNext).toBe(false);
    expect(nav.nextCursor).toBe(null);
    // 예전 판정(옛 응답 그대로)은 다음 페이지를 켰다 — 그 커서가 새 선택에 붙어 400 이 났다.
    expect(pageNavState([], v.view).canNext).toBe(true);
  });
  it('선택 반영 중 칩은 개수 없이 — 옛 분포로 세면 칩끼리·알약과 어긋난다', () => {
    const v = selectionView({ data: null, loading: true, last: last0, baseKey: 'B', fKey: 'F1' });
    const facets = { ...EMPTY_FACETS, cpuBin: '18-19', memBin: '18-18' };
    const chips = chipList(facets, v.current ? v.view.dist : null, {});
    expect(chips.map((c) => c.text)).toEqual(['CPU 90~100%', '메모리 90~95%']);
    expect(chips.every((c) => c.count === null)).toBe(true);
  });
  it('새 응답이 도착하면 다시 current · 필터가 바뀌면 흐림 없이 Loading(view 없음)', () => {
    const R1 = { ...R0, nextCursor: 'C1' };
    expect(selectionView({ data: R1, loading: false, last: { data: R1, baseKey: 'B', fKey: 'F1' }, baseKey: 'B', fKey: 'F1' }).current).toBe(true);
    const v = selectionView({ data: null, loading: true, last: last0, baseKey: 'B2', fKey: '' });
    expect(v).toEqual({ view: null, pendingSel: false, current: false });
    expect(selectionView({ data: null, loading: true, last: null, baseKey: 'B', fKey: '' })).toEqual({ view: null, pendingSel: false, current: false });
  });
  it('Vms.jsx — 페이저와 칩 개수는 current 판정을 거친다', () => {
    const s = src('./Vms.jsx');
    expect(s).toMatch(/selectionView\(\{ data, loading, last: lastRef\.current, baseKey, fKey \}\)/);
    expect(s).toMatch(/pageNavState\(stack, current \? view : null\)/);
    expect(s).toMatch(/chipList\(facets, current \? dist : null,/);
    expect(s).not.toMatch(/pageNavState\(stack, view\)/);
  });
});

describe('막대 칸 버튼 — 칸 하나만 고른 상태에서만 \'다시 누르면 해제\' (W-R3)', () => {
  it('구간(90%↑) 안의 칸은 눌림이 아니고, 누르면 그 칸만 남는다고 말한다', () => {
    const r = binButton('CPU', 18, 4, '18-19');
    expect(r.on).toBe(true);
    expect(r.pressed).toBe(false);
    expect(toggleBin('18-19', 18)).toBe('18-18'); // 동작은 그대로 — 문구가 동작을 따라간다
    expect(r.title).toBe('90~95% · 4대 — 눌러서 이 칸만 보기(지금은 90~100% 구간 선택 중)');
    expect(r.title).not.toMatch(/해제/);
    expect(r.label).toBe('CPU 90~95% 4대 · 고른 90~100% 구간에 포함');
  });
  it('칸 하나만 고른 상태 — 눌림 · 다시 누르면 해제(toggleBin 이 빈 값을 주는 때와 같다)', () => {
    const r = binButton('CPU', 18, 4, '18-18');
    expect(r).toEqual({ on: true, pressed: true, label: 'CPU 90~95% 4대', title: '90~95% · 4대 — 다시 누르면 해제' });
    expect(toggleBin('18-18', 18)).toBe('');
  });
  it('고른 구간 밖 · 선택 없음 · 미수집 선택 — 눌림 아님 · 이 구간만 보기', () => {
    for (const sel of ['', '15-17', 'na']) {
      const r = binButton('메모리', 3, 12, sel);
      expect(r).toEqual({ on: false, pressed: false, label: '메모리 15~20% 12대', title: '15~20% · 12대 — 눌러서 이 구간만 보기' });
    }
  });
  it('눌림(pressed)은 언제나 \'누르면 해제\' 와 같다 — 20칸 × 여러 선택', () => {
    for (const sel of ['', 'na', '0-0', '3-3', '15-19', '18-19', '0-19', '19-19']) {
      for (let i = 0; i < 20; i += 1) {
        const r = binButton('CPU', i, 1, sel);
        expect(r.pressed, `${sel} ${i}`).toBe(toggleBin(sel, i) === '');
        expect(/해제/.test(r.title), `${sel} ${i}`).toBe(r.pressed);
        expect(r.on, `${sel} ${i}`).toBe(binSelected(i, sel));
      }
    }
  });
  it('VmDistPanels — 막대 칸은 binButton 을 쓴다(제목·눌림을 따로 만들지 않는다)', () => {
    const s = src('./VmDistPanels.jsx');
    expect(s).toMatch(/binButton\(what, i, h\.n, sel\)/);
    expect(s).toMatch(/aria-pressed=\{bb\.pressed\}/);
    expect(s).not.toMatch(/on \? '다시 누르면 해제' : '눌러서 이 구간만 보기'/);
  });
});

describe('Guest OS 줄의 눌림은 웹 상태(facets.osName)에서 — 다른 패널과 같은 규칙 (C-03)', () => {
  const os = { top: [{ name: 'Ubuntu Linux (64-bit)', n: 30, selected: false }, { name: 'Windows', n: 20, selected: false }, { name: 'Old', n: 0, selected: true }], other: 0, distinct: 3 };
  it('선택 반영 중(옛 응답 selected 전부 false)에도 고른 줄이 눌림', () => {
    const r = osRows(os, 'Ubuntu Linux (64-bit)');
    expect(r.find((x) => x.name === 'Ubuntu Linux (64-bit)').selected).toBe(true);
    expect(r.filter((x) => x.selected)).toHaveLength(1);
  });
  it('해제 직후(옛 응답 selected:true 가 남아 있어도) 웹 상태가 비면 눌림 없음', () => {
    expect(osRows(os, '').every((x) => !x.selected)).toBe(true);
    expect(osRows(os).every((x) => !x.selected)).toBe(true);
  });
  it('눌림은 \'누르면 해제\' 와 같다(toggleSel)', () => {
    for (const sel of ['', 'Windows', 'Old', 'Ubuntu Linux (64-bit)']) {
      for (const r of osRows(os, sel)) expect(r.selected, `${sel} ${r.name}`).toBe(toggleSel(sel, r.name) === '');
    }
  });
  it('VmDistPanels — OsPanel 이 facets.osName 을 넘긴다', () => {
    expect(src('./VmDistPanels.jsx')).toMatch(/osRows\(os, sel\)/);
  });
});

describe('\'정지\' 는 KPI 의 뜻(구동 아님 전부) 하나만 — 새 패널은 POWERED_OFF 를 \'꺼짐\' 이라 부른다 (C-04)', () => {
  it('전원 범례·점·칩 라벨에 \'정지\' 가 없다', () => {
    expect(POWER_LABEL.off).toBe('꺼짐');
    expect(Object.values(POWER_LABEL)).not.toContain('정지');
    // '일시정지' 는 그대로(SUSPENDED) — 홀로 쓰는 '정지' 만 없앤다
    for (const s of ['POWERED_ON', 'POWERED_OFF', 'SUSPENDED', null]) expect(powerDot(s).label).not.toMatch(/(^|[^시])정지/);
    expect(powerDot('POWERED_OFF').label).toBe(POWER_LABEL.off);
    expect(chipList({ ...EMPTY_FACETS, power: 'off' }, null, {})[0].text).toBe('전원 꺼짐');
  });
  it('distNote 의 분포 밖은 \'구동 중이 아닌\' — KPI 정지(= 전체 − 구동)와 같은 집합', () => {
    // VM 18대: 구동 10 · 꺼짐 4 · 일시정지 3 · 전원 모름 1 → 분포 밖 8 = KPI '정지 8'
    const b = bins20(0); b[2] = 10;
    const note = distNote(panel({ bins: b, off: 8 }));
    expect(note).toBe('구동 중이고 사용률을 읽은 10대 · 구동 중이 아닌 8대는 분포 밖');
    expect(note).not.toMatch(/정지/);
  });
});

describe('좁은 화면 목록 높이·화면판독 글자 (W-R2)', () => {
  const css = fs.readFileSync(new URL('./vmDist.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel) => {
    const re = new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g');
    return [...css.matchAll(re)].map((m) => m[2]).join(';');
  };
  it('2줄 목록은 표(DataTable 64vh)와 같은 높이 상한 + 세로 스크롤', () => {
    const r = rule('.vmd .vmd-mlist');
    expect(r).toMatch(/max-height\s*:\s*64vh/);
    expect(r).toMatch(/overflow-y\s*:\s*auto/);
  });
  it('화면판독 글자(absolute)는 행 안에 갇힌다 — 스크롤 상자를 빠져나가 문서 높이를 늘리지 않게', () => {
    expect(rule('.vmd .vmd-sr')).toMatch(/position\s*:\s*absolute/);
    // 화면판독 글자를 담는 두 곳(표 이름 칸 · 목록 이름 줄)이 위치 지정 조상이어야 한다
    expect(rule('.vmd .vmd-name')).toMatch(/position\s*:\s*relative/);
    expect(rule('.vmd .vmd-mrow-n')).toMatch(/position\s*:\s*relative/);
    // 마지막 방어선 — .vmd 자체도(overflow:hidden 이라 그 안에서 잘린다)
    expect(rule('.vmd')).toMatch(/position\s*:\s*relative/);
    const panels = src('./VmDistPanels.jsx');
    const srParents = [...panels.matchAll(/className="(vmd-[a-z-]+)">\s*<span className="vmd-pdot"[^]*?<span className="vmd-sr">/g)].map((m) => m[1]);
    expect(srParents.sort()).toEqual(['vmd-mrow-n', 'vmd-name']);
  });
});
