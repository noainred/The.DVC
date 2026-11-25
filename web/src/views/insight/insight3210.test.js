// v3.21.0 — 분석 화면 공용 부품의 순수 계산(insight/insightCore.js · treemap.js · insightPrefs.js). VM · Hypervisor 분석이 같이 쓴다.
//   ① 고른 줄 합산 · 오래됨 · 모름 제외 ② 못 읽은 값은 0 이 아니다 ③ 상위 N 병합 ④ 지도 배치(열 폭 합 100% · 열마다 높이 합 100% · 0 · 모름 칸)
//   ⑤ 색 단계 · S6(경계를 넘은 칸만 경고) ⑥ 자동 크기 · 설정 값 자르기(300 ~ 1,200 · 20 단위) · 기억(try/catch)
import { describe, it, expect } from 'vitest';
import { pickRows, addVal, sumKeys, avgOf, mergeTopN, byName, shareOf, shareText, gbText, barPct, fmtN } from './insightCore.js';
import { treemapLayout, maxTilesInCol, fillStep, tileLineMode, tileColors, scaleLegend, RAMP, CRIT_BG, NONE_BG, TILE_TWO_LINE_MIN_PX } from './treemap.js';
import {
  clampMapH, autoMapHeight, normMapPrefs, mapHeightOf, pickMapSize, setMapH, loadMapPrefs, saveMapPrefs, readPref, writePref,
  normFolded, loadFolded, saveFolded, DEFAULT_MAP_PREFS, MAP_PRESETS,
} from './insightPrefs.js';

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, String(v)); }, m }; };
const throwing = { getItem: () => { throw new Error('막힘'); }, setItem: () => { throw new Error('막힘'); } };

describe('① 고른 줄 · 오래됨 · 모름', () => {
  const rows = [
    { id: 'a', total: 10 }, { id: 'b', total: 5, stale: true }, { id: 'c', unknown: true, total: null }, { id: 'd', total: 1 },
  ];
  it('고른 법인이 없으면 전부 · 오래됨 · 모름은 used 에서 빠지고 따로', () => {
    const p = pickRows(rows, []);
    expect(p.picked.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(p.used.map((r) => r.id)).toEqual(['a', 'd']);
    expect(p.stale.map((r) => r.id)).toEqual(['b']);
    expect(p.unknown.map((r) => r.id)).toEqual(['c']);
    expect(p.all).toHaveLength(4);
  });
  it('고른 법인만 · 목록에 없는 id 는 무시 · 객체 아닌 줄은 버린다', () => {
    const p = pickRows([...rows, null, 'x'], ['b', 'd', 'zz']);
    expect(p.picked.map((r) => r.id)).toEqual(['b', 'd']);
    expect(p.used.map((r) => r.id)).toEqual(['d']);
    expect(p.all).toHaveLength(4);
  });
});

describe('② 못 읽은 값은 0 이 아니다', () => {
  it('addVal — 둘 다 모르면 null · 한쪽만 읽으면 그 값 · 배열은 칸마다 · 객체는 키마다', () => {
    expect(addVal(null, null)).toBe(null);
    expect(addVal(undefined, '')).toBe(null);
    expect(addVal(null, 3)).toBe(3);
    expect(addVal(2, null)).toBe(2);
    expect(addVal(2, 3)).toBe(5);
    expect(addVal(true, 1)).toBe(1);   // 참/거짓은 수가 아니다
    expect(addVal([1, 2], [3, null, 4])).toEqual([4, 2, 4]);
    expect(addVal({ a: 1, b: { c: null } }, { a: 2, b: { c: 5 }, d: null })).toEqual({ a: 3, b: { c: 5 }, d: null });
  });
  it('sumKeys — 줄이 없으면 키가 null(0 이 아니다)', () => {
    expect(sumKeys([], ['total', 'on'])).toEqual({ total: null, on: null });
    expect(sumKeys([{ total: 1, on: null }, { total: 2, on: null }], ['total', 'on'])).toEqual({ total: 3, on: null });
  });
  it('avgOf — Σsum ÷ Σn(가중) · n 0 이면 null', () => {
    expect(avgOf({ sum: 300, n: 4 })).toBe(75);
    expect(avgOf({ sum: 0, n: 0 })).toBe(null);
    expect(avgOf(null)).toBe(null);
  });
  it('글자 — 모르면 — 이고 단위가 없다', () => {
    expect(fmtN(null)).toBe('—');
    expect(gbText(null)).toBe('—');
    expect(gbText(512)).toBe('512 GB');
    expect(gbText(2048)).toBe('2.0 TB');
    expect(shareText(1, 0)).toBe('—');
    expect(shareText(1, 400)).toBe('<1%');
    expect(shareText(1, 3)).toBe('33%');      // 10% 이상은 정수
    expect(shareText(1, 30)).toBe('3.3%');    // 10% 미만은 소수 한 자리
    expect(shareOf(null, 5)).toBe(null);
    expect(barPct(null, 10)).toBe(0);
    expect(barPct(20, 10)).toBe(100);
  });
});

describe('③ 상위 N 병합 — 합집합의 상위 N 은 법인별 상위 N 의 합집합 안에 있다', () => {
  const cmp = (a, b) => (b.v - a.v) || byName(a, b);
  it('여러 법인의 상위 3 을 합쳐 다시 3 = 전체에서 고른 상위 3', () => {
    const all = [];
    for (let c = 0; c < 4; c++) for (let i = 0; i < 9; i++) all.push({ id: `c${c}:v${i}`, name: `v${c}-${i}`, v: (c * 37 + i * 11) % 23, corp: c });
    const per = [0, 1, 2, 3].map((c) => all.filter((x) => x.corp === c).sort(cmp).slice(0, 3));
    const want = all.slice().sort(cmp).slice(0, 3);
    expect(mergeTopN(per, cmp, 3).map((x) => x.id)).toEqual(want.map((x) => x.id));
    // 고른 법인만
    const want02 = all.filter((x) => x.corp === 0 || x.corp === 2).sort(cmp).slice(0, 3);
    expect(mergeTopN([per[0], per[2]], cmp, 3).map((x) => x.id)).toEqual(want02.map((x) => x.id));
  });
  it('같은 id 는 한 번 · 빈 목록 · 객체 아닌 항목', () => {
    expect(mergeTopN([[{ id: 'a', v: 1 }], [{ id: 'a', v: 1 }, null]], cmp, 5)).toHaveLength(1);
    expect(mergeTopN(null, cmp, 5)).toEqual([]);
  });
});

describe('④ 지도 배치', () => {
  const groups = [
    { key: '유럽', items: [{ id: 'a', size: 30 }, { id: 'b', size: 10 }, { id: 'z', size: 0 }, { id: 'n', size: null }] },
    { key: '아시아', items: [{ id: 'c', size: 50 }, { id: 'd', size: 7 }, { id: 'e', size: 3 }] },
    { key: '북미', items: [{ id: 'x', size: null }] },
  ];
  it('열 폭의 합 = 100 · 열마다 칸 높이의 합 = 100 · 넓이가 값에 비례', () => {
    const L = treemapLayout(groups);
    expect(L.cols.map((c) => c.key)).toEqual(['아시아', '유럽']);       // 합이 큰 순 · 그릴 칸이 없는 묶음은 열이 없다
    expect(L.cols.reduce((a, c) => a + c.width, 0)).toBeCloseTo(100, 9);
    for (const c of L.cols) expect(c.tiles.reduce((a, t) => a + t.height, 0)).toBeCloseTo(100, 9);
    const area = (t) => t.width * t.height;
    const tiles = L.cols.flatMap((c) => c.tiles);
    const total = tiles.reduce((a, t) => a + t.size, 0);
    for (const t of tiles) expect(area(t) / 10000).toBeCloseTo(t.size / total, 9);
    expect(L.cols[0].tiles.map((t) => t.id)).toEqual(['c', 'd', 'e']);    // 칸은 큰 순
    expect(L.cols[1].left).toBeCloseTo(L.cols[0].width, 9);
  });
  it('0 · 모름 칸은 그리지 않고 hidden 으로(조용히 빼지 않는다)', () => {
    const L = treemapLayout(groups);
    expect(L.hidden.map((t) => t.id).sort()).toEqual(['n', 'x', 'z']);
    expect(maxTilesInCol(L)).toBe(3);
  });
  it('전부 0 이면 열이 없다 · 빈 입력', () => {
    expect(treemapLayout([{ key: 'k', items: [{ id: 'a', size: 0 }] }]).cols).toEqual([]);
    expect(treemapLayout(null)).toEqual({ cols: [], hidden: [], total: 0 });
    expect(maxTilesInCol(null)).toBe(0);
  });
});

describe('⑤ 색 단계 · S6', () => {
  it('절대값 눈금 — 경계 수 · 모르면 null(회색)', () => {
    const def = { steps: [10, 20, 30, 40] };
    expect(fillStep(5, def)).toEqual({ step: 0, over: false });
    expect(fillStep(20, def)).toEqual({ step: 2, over: false });
    expect(fillStep(99, def)).toEqual({ step: 4, over: false });     // 경계가 없는 기준은 빨강이 없다
    expect(fillStep(null, def)).toEqual({ step: null, over: false });
  });
  it('S6 — 경계(crit) 이상만 경고색, 그 아래는 파랑 단계', () => {
    const def = { steps: [20, 40, 60, 80], crit: 90 };
    expect(fillStep(89.9, def).over).toBe(false);
    expect(fillStep(90, def).over).toBe(true);
    expect(tileColors(fillStep(95, def)).bg).toBe(CRIT_BG);
    expect(tileColors(fillStep(85, def)).bg).toBe(RAMP[4]);
    expect(tileColors(fillStep(null, def)).bg).toBe(NONE_BG);
    expect(tileColors({ step: 4, over: false }).ink).toBe('#0b0b0b');   // 밝은 칸만 검정 글자
    expect(tileColors({ step: 1, over: false }).ink).toBe('#ffffff');
  });
  it('범례 글자', () => {
    expect(scaleLegend([10, 20, 30, 40])).toEqual(['10% 미만', '10–20%', '20–30%', '30–40%', '40% 이상']);
    expect(scaleLegend([20, 40, 60, 80], { crit: 90 })).toEqual(['20% 미만', '20–40%', '40–60%', '60–80%', '80–90%']);
    expect(scaleLegend([])).toEqual([]);
  });
  it('칸 안 글 — 칸의 실제 높이(px)로 한 줄 / 두 줄', () => {
    expect(tileLineMode(10, 520)).toBe('two');                       // 10% × 520 = 52px → 두 줄
    expect(tileLineMode(8, 520)).toBe('one');
    expect(tileLineMode(10, 360)).toBe('one');
    expect(tileLineMode(15, 360)).toBe('two');
    expect(tileLineMode((TILE_TWO_LINE_MIN_PX / 520) * 100, 520)).toBe('two');
    expect(tileLineMode(null, 520)).toBe('two');
  });
});

describe('⑥ 지도 크기 · 기억', () => {
  it('자르기 — 300 ~ 1,200 · 20 단위 · 수가 아니면 null', () => {
    expect(clampMapH(100)).toBe(300);
    expect(clampMapH(5000)).toBe(1200);
    expect(clampMapH(531)).toBe(540);
    expect(clampMapH(529)).toBe(520);
    expect(clampMapH('')).toBe(null);
    expect(clampMapH('abc')).toBe(null);
  });
  it('자동 = 가장 긴 묶음의 칸 수 × 64 를 360 ~ 1,200 로', () => {
    expect(autoMapHeight(0)).toBe(360);
    expect(autoMapHeight(3)).toBe(360);
    expect(autoMapHeight(10)).toBe(640);
    expect(autoMapHeight(30)).toBe(1200);
    expect(autoMapHeight(null)).toBe(360);
  });
  it('처음 = 크게 520 · 폭 기본 · 모르는 값은 기본값', () => {
    expect(DEFAULT_MAP_PREFS).toEqual({ size: 'l', h: 520, wide: false });
    expect(normMapPrefs(null)).toEqual({ size: 'l', h: 520, wide: false });
    expect(normMapPrefs({ size: 'huge', h: 'x', wide: 'yes' })).toEqual({ size: 'l', h: 520, wide: false });
    expect(normMapPrefs({ size: 'custom', h: 9999, wide: true })).toEqual({ size: 'custom', h: 1200, wide: true });
    expect(mapHeightOf(null, 3)).toBe(MAP_PRESETS.l);
    expect(mapHeightOf({ size: 'xl' }, 3)).toBe(760);
    expect(mapHeightOf({ size: 'm' }, 3)).toBe(360);
    expect(mapHeightOf({ size: 'auto' }, 10)).toBe(640);
    expect(mapHeightOf({ size: 'custom', h: 800 }, 10)).toBe(800);
  });
  it('미리 정한 크기 → ＋ 두 번 → 직접(custom) · 상한', () => {
    let p = pickMapSize(DEFAULT_MAP_PREFS, 'xl', 3);
    expect(p).toEqual({ size: 'xl', h: 760, wide: false });
    p = setMapH(p, mapHeightOf(p, 3) + 20); p = setMapH(p, mapHeightOf(p, 3) + 20);
    expect(p).toEqual({ size: 'custom', h: 800, wide: false });
    expect(setMapH(p, 99999).h).toBe(1200);
    expect(setMapH(p, 'x')).toEqual(p);
    expect(pickMapSize(p, 'auto', 10)).toEqual({ size: 'auto', h: 640, wide: false });
  });
  it('기억 — 화면별 키 · 저장소가 던져도 기본값(try/catch)', () => {
    const st = memStore();
    expect(saveMapPrefs('vmInsight.map', { size: 'custom', h: 611, wide: true }, st)).toBe(true);
    expect(JSON.parse(st.m.get('vmInsight.map'))).toEqual({ size: 'custom', h: 620, wide: true });
    expect(loadMapPrefs('vmInsight.map', st)).toEqual({ size: 'custom', h: 620, wide: true });
    expect(loadMapPrefs('hostInsight.map', st)).toEqual(DEFAULT_MAP_PREFS);   // 화면마다 따로
    expect(loadMapPrefs('vmInsight.map', throwing)).toEqual(DEFAULT_MAP_PREFS);
    expect(saveMapPrefs('vmInsight.map', {}, throwing)).toBe(false);
    st.setItem('bad', '{깨짐');
    expect(readPref('bad', st)).toBe(null);
    expect(writePref('k', 1, throwing)).toBe(false);
  });
  it('묶음 접힘 — 아는 키 · true 만 · 처음은 전부 펼침', () => {
    const keys = ['now', 'dist'];
    expect(normFolded({ dist: true, now: 'yes', zzz: true }, keys)).toEqual({ dist: true });
    expect(normFolded([true], keys)).toEqual({});
    const st = memStore();
    expect(loadFolded('f', keys, st)).toEqual({});
    saveFolded('f', { now: true, other: true }, keys, st);
    expect(loadFolded('f', keys, st)).toEqual({ now: true });
    expect(loadFolded('f', keys, throwing)).toEqual({});
  });
});
