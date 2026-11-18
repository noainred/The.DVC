// dbg3231 — 분석 지도(VM · Hypervisor 같은 부품) 칸 결함 회귀:
//   ① useWidth 가 마운트 때 한 번만 재서 좁게 → 넓게 바꾸면 폭을 다시 재지 않았다(콜백 ref 로) · 폭 모름이면 packLayout 이 전부 tier 'm'(두 줄)이라
//      tileLineMode(낮은 칸 = 한 줄) 보호가 사라졌다(tier 비움) · 좁은 화면에서 넓을 때의 옛 폭으로 자동 높이를 계산했다.
//   ② ‘그 밖 N개’ 목록이 지도 배치 순(크기)이었고 ‘값’ 열이 크기로 정렬됐다 — 값 높은 순 · 채움 값으로.
//   ③ maxTilesPacked 가 ceil(n / 최대 열 수) 어림이라 실제 배치의 가장 긴 열보다 작았다 — 실제 packLayout 의 가장 긴 작은 열로 · 문구도 그 기준.
//   ④ 작은 열 폭 하한(MIN_SUBCOL_W)을 평균(cw / k)에만 걸어 실제 작은 열이 75px 까지 좁아졌다.
//   ⑤ 묶음 칸 대표 값이 오래된 구성원에서 나와도 표시가 없었다 · 모름 구성원 수가 없었다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { treemapLayout } from './treemap.js';
import { packLayout, maxTilesPacked, longestPackedCol, orderMembers, worstMember, MIN_SUBCOL_W } from './tilePack.js';
import { autoMapHeight } from './insightPrefs.js';
import Treemap from './Treemap.jsx';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));

const BIG = [
  { key: 'na', label: '북미', items: [11, 10, 10, 10, 10, 10, 10, 8, 8, 8, 8, 8, 7, 7, 6, 6, 6, 6, 6, 4, 4, 3].map((s, i) => ({ id: `na${i}`, label: `Cluster-NA-${String(i).padStart(2, '0')}`, size: s })) },
  { key: 'as', label: '아시아', items: [32, 27, 21, 13, 10, 8, 6, 5].map((s, i) => ({ id: `as${i}`, label: `Cluster-AS-${i}`, size: s })) },
  { key: 'cn', label: '중국', items: [20, 11, 10, 8, 8, 6, 4].map((s, i) => ({ id: `cn${i}`, label: `Cluster-CN-${i}`, size: s })) },
  { key: 'eu', label: '유럽', items: [33, 24].map((s, i) => ({ id: `eu${i}`, label: `Cluster-EU-${i}`, size: s })) },
];

describe('① 폭을 모를 때 · 다시 잴 때', () => {
  it('폭 모름이면 tier 를 비운다(그리는 쪽이 높이만으로 한 줄 / 두 줄)', () => {
    const L = treemapLayout(BIG);
    for (const w of [null, 0, undefined]) {
      const P = packLayout(L, { widthPx: w, heightPx: 520 });
      expect(P.cols.flatMap((c) => c.tiles).every((t) => t.tier === undefined)).toBe(true);
    }
  });
  it('폭을 못 잰 첫 그림(SSR — 요소 없음)에서도 낮은 칸은 한 줄(one), 두 줄 단계(t-m)를 고정으로 주지 않는다', () => {
    const L = treemapLayout(BIG);
    const html = renderToStaticMarkup(React.createElement(Treemap, {
      layout: L, heightPx: 520, label: '지도', tileView: (t) => ({ title: t.label, line: `${t.size}`, tip: '', bg: '#123', ink: '#fff' }),
    }));
    expect(html).not.toMatch(/ins-tl t-m/);
    expect(html).toMatch(/class="ins-tl one"/);   // 북미 22칸 중 낮은 칸
    expect(html).toMatch(/class="ins-tl two"/);
  });
  it('useWidth 는 콜백 ref — 요소가 새로 붙을 때마다 관찰 · 폭 0 은 모름 · 모르면 onWidth(null)', () => {
    const tm = read('Treemap.jsx');
    expect(tm).toMatch(/function useWidth\(\) \{/);
    expect(tm).toMatch(/const \[el, setEl\] = useState\(null\)/);
    expect(tm).toMatch(/\}, \[el\]\);/);
    expect(tm).not.toMatch(/\}, \[ref\]\);/);
    expect(tm).toMatch(/const \[boxRef, widthPx, boxEl\] = useWidth\(\)/);
    expect(tm).toMatch(/className="ins-map" ref=\{boxRef\}/);
    expect(tm).toMatch(/v > 0 \? v : null/);
    expect(tm).toMatch(/onWidth\(widthPx \|\| null\)/);
    expect(tm).not.toMatch(/useRef/);
  });
  it('두 화면 — 좁은 화면이면 옛 폭으로 자동 높이를 계산하지 않는다', () => {
    for (const f of ['../vms/VmInsight.jsx', '../hosts/HostInsight.jsx']) {
      const s = read(f);
      expect(s).toMatch(/const packedAuto = !!mapW && !narrow;/);
      expect(s).toMatch(/const maxTiles = packedAuto \? maxTilesPacked\(layout, mapW/);
    }
  });
});

describe('② 그 밖 N개 목록 — 값 높은 순 · 값 열은 채움 값으로 정렬', () => {
  it('orderMembers — 값 높은 순 · 같으면 크기 큰 순 · 모름은 뒤(크기 큰 순) · 원본 그대로', () => {
    const ms = [{ id: 'a', size: 6, v: 82 }, { id: 'b', size: 6, v: 73 }, { id: 'c', size: 2, v: null }, { id: 'd', size: 6, v: 98 }, { id: 'e', size: 9, v: 73 }, { id: 'f', size: 5, v: null }, { id: 'g', size: 1, v: '' }];
    const before = ms.map((m) => m.id);
    expect(orderMembers(ms, (m) => m.v).map((m) => m.id)).toEqual(['d', 'a', 'e', 'b', 'f', 'c', 'g']);
    expect(ms.map((m) => m.id)).toEqual(before);
    expect(orderMembers(null, (m) => m.v)).toEqual([]);
  });
  it('Treemap 목록은 orderMembers(valOf) 순 · 값 열 data-sort = 채움 값(모름 ‘—’) · 두 화면이 valOf 를 넘긴다', () => {
    const tm = read('Treemap.jsx');
    expect(tm).toMatch(/valOf \? orderMembers\(og\.members, valOf\) : og\.members/);
    expect(tm).toMatch(/\{ogMembers\.map\(\(m\) =>/);
    expect(tm).toMatch(/data-sort=\{valOf \? \(numOrNull\(valOf\(m\)\) \?\? '—'\) : m\.size\}/);
    expect(read('../vms/VmInsight.jsx')).toMatch(/valOf=\{\(t\) => fill\.val\(t\.row\)\}/);
    expect(read('../hosts/HostInsight.jsx')).toMatch(/valOf=\{\(t\) => fill\.val\(t\.cell\)\}/);
  });
});

describe('③ 자동 높이 = 실제 배치의 가장 긴 작은 열', () => {
  it('BIG · 726px — 예전 어림(8 → 512px)이 아니라 그 높이에서 실제로 놓은 가장 긴 열(설계 §6⑤)', () => {
    const L = treemapLayout(BIG);
    for (const W of [726, 1122, 1356]) {
      const n = maxTilesPacked(L, W);
      const H = autoMapHeight(n);
      const real = longestPackedCol(packLayout(L, { widthPx: W, heightPx: H, group: false }));
      expect(real).toBe(n);                                   // 그 높이에서 실제 가장 긴 열 = 쓴 칸 수
      expect(autoMapHeight(real)).toBeLessThanOrEqual(H);     // 가장 긴 열 × 64 가 그 높이에 들어간다
    }
    expect(maxTilesPacked(L, 726)).toBeGreaterThan(8);
  });
  it('지역마다 15 ~ 21칸이고 나눠도 이름이 더 보이지 않으면 나누지 않은 가장 긴 열(21 → 1,200px)', () => {
    const mk = (key, n) => ({ key, label: key, items: Array.from({ length: n }, (_, i) => ({ id: `${key}${i}`, label: `${key}-CL${i % 3}`, size: 6 })) });
    const L = treemapLayout([mk('A', 21), mk('B', 18), mk('C', 21), mk('D', 15)]);
    const n = maxTilesPacked(L, 1122);
    const real = longestPackedCol(packLayout(L, { widthPx: 1122, heightPx: autoMapHeight(n), group: false }));
    expect(autoMapHeight(real)).toBeLessThanOrEqual(autoMapHeight(n));
  });
  it('문구 — 여러 열을 놓을 때는 ‘여러 열로 나눈 뒤 가장 긴 열’, 아니면 ‘가장 긴 지역’', () => {
    for (const f of ['../vms/VmInsight.jsx', '../hosts/HostInsight.jsx']) {
      const s = read(f);
      expect(s).toMatch(/autoNote=\{packedAuto \? `자동 = 칸이 많은 지역을 여러 열로 나눈 뒤 가장 긴 열의 칸 수로 정합니다/);
      expect(s).toMatch(/: `자동 = 가장 긴 지역의 칸 수로 정합니다/);
    }
  });
});

describe('④ 작은 열 폭 하한은 실제 작은 열 폭에', () => {
  it('무작위 1,500회 — packLayout 이 고른 작은 열은 모두 MIN_SUBCOL_W 이상', () => {
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let narrowN = 0; let splitN = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const nA = 3 + Math.floor(rnd() * 30);
      const items = Array.from({ length: nA }, (_, i) => ({ id: `x${i}`, label: `Cluster-${i}`, size: Math.max(1, Math.round(rnd() < 0.15 ? 40 + rnd() * 60 : 1 + rnd() * 8)) }));
      const tot = items.reduce((a, t) => a + t.size, 0);
      const L = treemapLayout([{ key: 'a', label: 'A', items }, { key: 'b', label: 'B', items: [{ id: 'b', label: 'B', size: Math.round(tot * (0.2 + rnd())) }] }]);
      const W = 726; const H = [360, 520, 760][trial % 3];
      const P = packLayout(L, { widthPx: W, heightPx: H });
      for (const c of P.cols) {
        const subs = new Map(); c.tiles.forEach((t) => subs.set(t.left.toFixed(5), (t.width / 100) * W));
        if (subs.size < 2) continue;
        splitN++;
        for (const w of subs.values()) if (w < MIN_SUBCOL_W - 1e-6) narrowN++;
      }
    }
    expect(splitN).toBeGreaterThan(0);   // 나누는 경우가 실제로 있다(검사가 비어 있지 않다)
    expect(narrowN).toBe(0);
  });
});

describe('⑤ 묶음 칸 — 오래됨 · 모름', () => {
  it('worstMember(staleOf) — 지금 값이 있으면 오래된 값보다 먼저 · 오래된 값은 지금 값이 없을 때만 · 모름은 맨 뒤', () => {
    const st = (m) => m.row.stale === true;
    const a = { size: 5, row: { stale: true, v: 97 } }; const b = { size: 6, row: { v: 40 } }; const c = { size: 9, row: { v: null } };
    expect(worstMember([a, b, c], (m) => m.row.v, st)).toEqual({ member: b, value: 40 });
    expect(worstMember([c, a], (m) => m.row.v, st)).toEqual({ member: a, value: 97 });
    expect(worstMember([c], (m) => m.row.v, st)).toEqual({ member: c, value: null });
    expect(worstMember([a, b], (m) => m.row.v)).toEqual({ member: a, value: 97 });   // staleOf 없으면 예전 그대로
  });
  it('두 화면 groupView — 오래되지 않은 값 먼저 · 오래됨 N · 모름 N · stale 플래그 · 묶음 칸 빗금(class · backgroundColor)', () => {
    for (const f of ['../vms/VmInsight.jsx', '../hosts/HostInsight.jsx']) {
      const s = read(f);
      expect(s).toMatch(/worstMember\(members, \(m\) => fill\.val\(m\.(row|cell)\), isStale\)/);
      expect(s).toMatch(/오래됨 \$\{staleN\}/);
      expect(s).toMatch(/모름 \$\{unknownN\}/);
      expect(s).toMatch(/stale: repStale \|\| \(members\.length > 0 && staleN === members\.length\)/);
    }
    const tm = read('Treemap.jsx');
    expect(tm).toMatch(/ins-tl grp t-\$\{t\.tier\}[^`]*\$\{v\.stale \? ' stale' : ''\}`/);
    expect(tm).not.toMatch(/style=\{\{ \.\.\.pos, background: v\.bg/);   // 인라인 background 단축형은 .stale 빗금(background-image)을 지운다
    expect((tm.match(/style=\{\{ \.\.\.pos, backgroundColor: v\.bg, color: v\.ink \}\}/g) || []).length).toBe(2);
  });
});
