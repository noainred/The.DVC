// v3.23.0 지도 칸 글자(설계 docs/design/insight-tiles · 추천 B + C + D) — tilePack 순수 함수 · 그리기 소스 계약.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { treemapLayout } from './treemap.js';
import { packLayout, tierOf, splitInto, chooseSplit, maxTilesPacked, worstMember, estTextW, MIN_SUBCOL_W, TARGET_MIN_H, NAME_MIN_H, PAD_X } from './tilePack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

// 캡처와 비슷한 모양(가상 값) — 한 지역에 22개 · 다른 지역에 2개
const BIG = [
  { key: 'na', label: '북미', items: [11, 10, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 7, 7, 6, 6, 6, 6, 6, 4, 4, 3].map((s, i) => ({ id: `na${i}`, label: `Cluster-NA-${String(i).padStart(2, '0')}`, size: s })) },
  { key: 'as', label: '아시아', items: [32, 27, 21, 13, 10, 8, 6, 5].map((s, i) => ({ id: `as${i}`, label: `Cluster-AS-${i}`, size: s })) },
  { key: 'cn', label: '중국', items: [20, 11, 10, 8, 8, 6, 4].map((s, i) => ({ id: `cn${i}`, label: `Cluster-CN-${i}`, size: s })) },
  { key: 'eu', label: '유럽', items: [33, 24].map((s, i) => ({ id: `eu${i}`, label: `Cluster-EU-${i}`, size: s })) },
];
// 한 지역에 46개 — 여러 열로도 모자라 묶음이 생기는 경우
const HUGE = [
  { key: 'na', label: '북미', items: Array.from({ length: 46 }, (_, i) => ({ id: `n${i}`, label: `Site-${i}-Workload`, size: Math.max(2, Math.round(14 * Math.pow(0.93, i))) })) },
  { key: 'as', label: '아시아', items: Array.from({ length: 6 }, (_, i) => ({ id: `a${i}`, label: `Asia-${i}`, size: 20 - i })) },
];

const allTiles = (P) => P.cols.flatMap((c) => c.tiles);
function invariants(P, W, H, total) {
  const t = allTiles(P);
  const area = t.reduce((a, x) => a + (x.width / 100) * W * (x.height / 100) * H, 0);
  expect(Math.abs(area - W * H)).toBeLessThan(0.5);                         // 넓이 합 = 지도 넓이
  for (const x of t) {
    expect(x.left).toBeGreaterThanOrEqual(-1e-9); expect(x.top).toBeGreaterThanOrEqual(-1e-9);
    expect(x.left + x.width).toBeLessThanOrEqual(100 + 1e-9); expect(x.top + x.height).toBeLessThanOrEqual(100 + 1e-9);
    const share = ((x.width / 100) * (x.height / 100));
    expect(Math.abs(share - x.size / total)).toBeLessThan(1e-9);               // 넓이가 크기 값에 비례
  }
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {  // 겹침 없음
    const a = t[i], b = t[j];
    const ix = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
    const iy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
    expect(ix > 1e-9 && iy > 1e-9).toBe(false);
  }
}

describe('① 배치 불변식 — 넓이 비례 · 겹침 0 · 지도 밖 0', () => {
  for (const [name, groups] of [['39개', BIG], ['52개', HUGE]]) {
    for (const H of [360, 520, 760, 1200]) {
      it(`${name} · ${H}px`, () => {
        const L = treemapLayout(groups);
        const P = packLayout(L, { widthPx: 1356, heightPx: H });
        invariants(P, 1356, H, L.total);
        const inGroups = P.groups.reduce((a, g) => a + g.members.length, 0);
        const shown = allTiles(P).filter((t) => !t.group).length;
        expect(shown + inGroups).toBe(L.cols.reduce((a, c) => a + c.tiles.length, 0));   // 빠지는 칸 없음
      });
    }
  }
});

describe('② D · 여러 열', () => {
  it('칸이 많은 지역만 나누고, 작은 열 폭은 하한 이상', () => {
    const items = BIG[0].items.map((x) => ({ ...x }));
    const s = chooseSplit(items, 520, 520);
    expect(s.k).toBeGreaterThan(1);
    expect(520 / s.k).toBeGreaterThanOrEqual(MIN_SUBCOL_W);
    expect(chooseSplit(items, 100, 520).k).toBe(1);                                 // 폭이 하한보다 좁으면 나누지 않는다
    expect(s.minH).toBeGreaterThan(chooseSplit(items, MIN_SUBCOL_W * 2 - 1, 520).minH); // 나누면 가장 낮은 칸이 높아진다(그 폭은 1열뿐)
    expect(chooseSplit(items, 700, 520).minH).toBeGreaterThanOrEqual(TARGET_MIN_H);  // 폭이 넉넉하면 목표 높이에 닿는다
    expect(chooseSplit(BIG[3].items.map((x) => ({ ...x })), 300, 520).k).toBe(1);   // 2개뿐 · 이미 충분히 높다
  });
  it('splitInto 는 순서를 지키고 모두 담는다', () => {
    const items = [9, 8, 7, 6, 5, 4, 3, 2, 1].map((s, i) => ({ id: `x${i}`, size: s }));
    for (const k of [1, 2, 3, 4]) {
      const parts = splitInto(items, k);
      expect(parts.flat().map((x) => x.id)).toEqual(items.map((x) => x.id));
      expect(parts.length).toBeLessThanOrEqual(k);
    }
  });
  it('39개 · 520px — 지금 배치보다 이름이 들어가는 칸이 많다(설계 §4 의 경향)', () => {
    const L = treemapLayout(BIG);
    const W = 1356, H = 520;
    const before = L.cols.flatMap((c) => c.tiles).filter((t) => (t.height / 100) * H >= NAME_MIN_H && estTextW(t.label, 12.5) <= (t.width / 100) * W - PAD_X).length;
    const P = packLayout(L, { widthPx: W, heightPx: H });
    const after = allTiles(P).filter((t) => !t.group && t.tier !== 'none').length;
    expect(after).toBeGreaterThan(before);
  });
  it('실제 지도 폭(지역 하나 ≈ 290px)에서도 나눠 이름이 보이는 칸이 늘면 나눈다', () => {
    const L = treemapLayout(BIG.slice(0, 1).concat([{ key: 'z', label: '그 밖', items: [{ id: 'z', label: 'Z', size: 75 }] }]));
    const P = packLayout(L, { widthPx: 1150 * (166 / 241), heightPx: 520 });
    const na = P.cols.find((c) => c.key === 'na');
    expect(new Set(na.tiles.map((t) => Math.round(t.left * 100))).size).toBeGreaterThan(1);
  });
});

describe('③ C · 작은 칸 묶기', () => {
  it('46개 지역 · 520px — 그 밖 N개 한 칸 · id 는 grp:<지역> · 구성원은 지도에 따로 없다', () => {
    const L = treemapLayout(HUGE);
    const P = packLayout(L, { widthPx: 1356, heightPx: 520 });
    expect(P.groups.length).toBe(1);
    const g = P.groups[0];
    expect(g.id).toBe('grp:na');
    expect(g.members.length).toBeGreaterThanOrEqual(2);
    const tile = allTiles(P).find((t) => t.group);
    expect(tile.label).toBe(`그 밖 ${g.members.length}개`);
    expect(tile.size).toBe(g.members.reduce((a, m) => a + m.size, 0));
    const shownIds = new Set(allTiles(P).filter((t) => !t.group).map((t) => t.id));
    for (const m of g.members) expect(shownIds.has(m.id)).toBe(false);
  });
  it('작은 칸이 하나뿐이면 묶지 않는다 · 폭 · 높이를 모르면 입력 그대로(묶음 없음)', () => {
    const L = treemapLayout([{ key: 'k', items: [{ id: 'a', label: 'A', size: 99 }, { id: 'b', label: 'B', size: 1 }] }]);
    expect(packLayout(L, { widthPx: 1356, heightPx: 520 }).groups).toEqual([]);
    const raw = packLayout(L, { widthPx: null, heightPx: 520 });
    expect(raw.groups).toEqual([]);
    expect(raw.cols[0].tiles.map((t) => t.top)).toEqual(L.cols[0].tiles.map((t) => t.top));
  });
  it('worstMember — 가장 높은 값(모름은 뒤로)', () => {
    const ms = [{ id: 'a', size: 5, v: 40 }, { id: 'b', size: 3, v: null }, { id: 'c', size: 2, v: 91 }];
    expect(worstMember(ms, (m) => m.v)).toEqual({ member: ms[2], value: 91 });
    expect(worstMember([{ id: 'x', size: 1, v: null }], (m) => m.v)).toEqual({ member: null, value: null });   // dbg3231 3회차: 모두 모름이면 대표 없음
    expect(worstMember([], (m) => m.v).member).toBe(null);
  });
});

describe('④ B · 글자 단계', () => {
  it('큰 칸 xl · 보통 l · 두 줄 m · 낮은 칸 one · 그보다 작으면 none', () => {
    expect(tierOf(300, 120, 'Seoul-Sandbox')).toBe('xl');
    expect(tierOf(200, 60, 'Dallas-DB')).toBe('l');
    expect(tierOf(200, 48, 'Dallas-DB')).toBe('m');
    expect(tierOf(200, 30, 'Dallas-DB')).toBe('one');
    expect(tierOf(200, 20, 'Dallas-DB')).toBe('none');
    expect(tierOf(40, 200, 'A-very-long-cluster-name')).toBe('none');
    expect(tierOf(120, 30, 'Dallas-DB', estTextW, { mark: true })).toBe('none');   // 한 줄 칸에 ‘못 버팀’ 표까지 들어가지 않으면 글 없음
    expect(tierOf(200, 30, 'Dallas-DB', estTextW, { mark: true })).toBe('one');
    expect(tierOf(200, 50, 'Dallas-DB', estTextW, { mark: true })).toBe('one');   // 두 줄 + 표 = 세 줄이 안 들어가면 한 줄로
    expect(tierOf(200, 64, 'Dallas-DB', estTextW, { mark: true })).toBe('m');           // 폭이 모자라면 글 없음(잘린 글자를 그리지 않는다)
  });
  it('maxTilesPacked — 폭을 모르면 나누지 않은 수 · 알면 나눌 수 있는 만큼 줄인다', () => {
    const L = treemapLayout(BIG);
    expect(maxTilesPacked(L, null)).toBe(22);
    expect(maxTilesPacked(L, 1356)).toBeLessThan(22);
    expect(maxTilesPacked(null, 1356)).toBe(0);
  });
});

describe('⑤ 그리기 소스 계약(Treemap.jsx · 두 화면)', () => {
  const tm = read('Treemap.jsx');
  it('넓은 화면은 폭을 재서 packLayout · 묶음 칸은 aria-expanded · 목록은 STable', () => {
    expect(tm).toMatch(/ResizeObserver/);
    expect(tm).toMatch(/packLayout\(layout, \{ widthPx, heightPx, textW, markOf:/);
    expect(tm).toMatch(/aria-expanded=\{open\}/);
    expect(tm).toMatch(/<STable/);
    expect(tm).toMatch(/narrow \? null : packLayout/);                          // 좁은 화면은 지금처럼 세로 띠
  });
  it('VM · Hypervisor 가 groupView · onWidth 를 넘기고 자동 높이는 maxTilesPacked', () => {
    for (const f of ['../vms/VmInsight.jsx', '../hosts/HostInsight.jsx']) {
      const s = read(f);
      expect(s).toMatch(/groupView=\{groupView\} onWidth=\{setMapW\}/);
      expect(s).toMatch(/packedAuto \? maxTilesPacked\(layout, mapW[,)]/);   // dbg3231: 좁은 화면이면 옛 폭을 쓰지 않는다(packedAuto = mapW ∧ 넓은 화면)
      expect(s).toMatch(/: maxTilesInCol\(layout\)/);
      expect(s).toMatch(/worstMember\(members/);
    }
    expect(read('../hosts/HostInsight.jsx')).toMatch(/whereOf=\{\(t\) => corpName\(t\.row\)\}/);   // 클러스터 이름은 법인마다 겹칠 수 있다 — 목록에 법인 칸
    {
    }
  });
  it('글자 단계 스타일 — 12px 아래로 내려가지 않는다(글 없음 칸의 표 제외)', () => {
    const css = read('insight.css');
    expect(css).toMatch(/\.ins-tl\.t-xl b \{ font-size: 16px; \}/);
    expect(css).toMatch(/\.ins-tl\.t-none b, \.ins-tl\.t-none span \{ display: none; \}/);
    const sizes = [...css.matchAll(/\.ins-tl\.t-(?:xl|l|m|one)[^{]*\{[^}]*font-size: ([\d.]+)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    for (const n of sizes) expect(n).toBeGreaterThanOrEqual(12);
  });
});
