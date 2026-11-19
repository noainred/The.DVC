// dbg3231(2회차) — ‘그 밖 N개’ 묶음 칸 · 목록 결함 회귀:
//   ① 묶음 칸 글자 단계(packLayout)가 높이만 보고 정해 ‘못 버팀 N’ 표가 붙어도 46 ~ 62px 칸이 'm'(세 줄로 눌림) · 좁은 'one' 칸은 표가 잘렸다
//      → 일반 칸과 같은 tierOf(표 보정 포함)를 쓰는 groupTierOf.
//   ② .ins-tl.grp 와 .ins-tl.stale 의 명시도가 같아 뒤의 .grp 빗금이 오래됨 빗금을 덮었다 → .ins-tl.grp.stale(클래스 3개 · .grp 뒤).
//   ③ 묶음 목록 줄이 오래됨을 툴팁에만 보였고 · 오래된 높은 값이 목록 맨 위에 왔다(묶음 칸 대표 값 worstMember 와 다른 순위)
//      → orderMembers(staleOf) 지금 → 오래됨 → 모름 · 값 칸 ‘(오래됨)’ · 견본 빗금.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { treemapLayout } from './treemap.js';
import { packLayout, tierOf, groupTierOf, orderMembers, worstMember, MARK_ROW_H, MARK_W, PAD_X, TIER, estTextW } from './tilePack.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => stripComments(fs.readFileSync(path.join(HERE, f), 'utf8'));
const readRaw = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');

describe('① 묶음 칸 글자 단계 — 표가 붙으면 일반 칸과 같은 보정', () => {
  const label = '그 밖 6개';
  it('groupTierOf — 표 없음은 예전 판정(46px 이상 m · 22.5px 이상 one) 그대로 · 두 줄 단계는 m 하나', () => {
    expect(groupTierOf(130, 47, label)).toBe('m');
    expect(groupTierOf(300, 200, label)).toBe('m');   // xl · l 로 키우지 않는다
    expect(groupTierOf(130, 32, label)).toBe('one');
    expect(groupTierOf(130, 20, label)).toBe('none');
  });
  it('groupTierOf — 표가 붙으면 두 줄 단계는 minH + MARK_ROW_H 이상 · 한 줄 단계는 이름 + 표 폭이 들어갈 때만', () => {
    expect(groupTierOf(130, 47, label, estTextW, true)).not.toBe('m');
    expect(groupTierOf(130, TIER.m.minH + MARK_ROW_H - 0.1, label, estTextW, true)).not.toBe('m');
    expect(groupTierOf(130, TIER.m.minH + MARK_ROW_H, label, estTextW, true)).toBe('m');
    // 130×32 — 이름 + 표 폭이 안쪽 폭(130 - PAD_X)에 들어가지 않으면 one 이 아니다(표가 오른쪽에서 잘렸다)
    const fitsOne = estTextW(label, TIER.one.name) + MARK_W + 8 <= 130 - PAD_X;
    expect(groupTierOf(130, 32, label, estTextW, true)).toBe(fitsOne ? 'one' : 'none');
    // 일반 칸 tierOf 와 같은 기준
    for (const [w, h] of [[130, 47], [130, 60], [130, 63], [130, 32], [260, 40], [320, 70]]) {
      const t = tierOf(w, h, label, estTextW, { mark: true });
      expect(groupTierOf(w, h, label, estTextW, true)).toBe(t === 'xl' || t === 'l' ? 'm' : t);
    }
  });
  it('packLayout — 구성원 중 하나라도 표(markOf)면 묶음 칸이 h < 63px 에서 m 이 되지 않는다(재현 배치 전수)', () => {
    let grpWithMark = 0;
    for (const H of [360, 520, 760, 1200]) {
      for (const W of [130, 160, 200, 260, 320]) {
        for (const big of [1, 2, 4, 8]) {
          for (const small of [2, 3, 6, 12, 24, 40]) {
            const items = [
              ...Array.from({ length: big }, (_, i) => ({ id: `b${i}`, label: `Big-${i}`, size: 100 })),
              ...Array.from({ length: small }, (_, i) => ({ id: `s${i}`, label: `Small-${i}`, size: 1, fail: i === 0 })),
            ];
            const L = treemapLayout([{ key: 'EU', label: 'EU', items }]);
            const P = packLayout(L, { widthPx: W, heightPx: H, markOf: (t) => !!t.fail });
            for (const t of P.cols.flatMap((c) => c.tiles).filter((x) => x.group)) {
              if (!t.members.some((m) => m.fail)) continue;
              grpWithMark += 1;
              if (t.tier === 'm') expect(t.hPx).toBeGreaterThanOrEqual(TIER.m.minH + MARK_ROW_H);
              if (t.tier === 'one') expect(estTextW(t.label, TIER.one.name) + MARK_W + 8).toBeLessThanOrEqual(t.wPx - PAD_X);
            }
          }
        }
      }
    }
    expect(grpWithMark).toBeGreaterThan(20);   // 시험이 실제로 표 붙은 묶음 칸을 지났다
  });
  it('packLayout 소스 — 묶음 칸 tier 는 groupTierOf(구성원 markOf) 로', () => {
    expect(read('tilePack.js')).toMatch(/tier: r\.t\.group \? groupTierOf\(r\.w, r\.h, r\.t\.label, textW, r\.t\.members\.some\(\(m\) => !!markOf\(m\)\)\)/);
  });
});

describe('② 오래된 묶음 칸 빗금 — .grp 빗금이 덮지 않는다', () => {
  it('.ins-tl.grp.stale 규칙이 .ins-tl.grp 뒤에 있고 두 빗금(오래됨 + 묶음)을 겹친다', () => {
    const css = readRaw('insight.css');
    const grp = css.indexOf('.ins-tl.grp {');
    const stale = css.indexOf('.ins-tl.stale {');
    const both = css.indexOf('.ins-tl.grp.stale {');
    expect(grp).toBeGreaterThan(-1);
    expect(stale).toBeGreaterThan(-1);
    expect(both).toBeGreaterThan(grp);   // 명시도는 더 높지만 순서도 뒤에(나중에 같은 명시도 규칙이 끼어도 지지 않게)
    const rule = css.slice(both, css.indexOf('}', both));
    const staleImg = css.slice(stale, css.indexOf('}', stale)).match(/background-image:\s*([^;]+);/)[1].trim();
    const grpImg = css.slice(grp, css.indexOf('}', grp)).match(/background-image:\s*([^;]+);/)[1].trim();
    expect(rule).toContain(staleImg);
    expect(rule).toContain(grpImg);
  });
  it('묶음 칸 단추는 stale class 를 붙이고 색은 backgroundColor(빗금을 지우지 않게)', () => {
    const tm = read('Treemap.jsx');
    expect(tm).toMatch(/ins-tl grp t-\$\{t\.tier\}[^`]*\$\{v\.stale \? ' stale' : ''\}`/);
  });
});

describe('③ 묶음 목록 줄 — 오래됨 표시 · 순서', () => {
  it('orderMembers(staleOf) — 지금 값(높은 순) → 오래된 값(높은 순) → 모름 · 첫 줄 = worstMember 대표', () => {
    const st = (m) => m.stale === true;
    const ms = [
      { id: 'old99', size: 1, v: 99, stale: true },
      { id: 'now10', size: 1, v: 10 },
      { id: 'now5', size: 3, v: 5 },
      { id: 'old50', size: 2, v: 50, stale: true },
      { id: 'unk', size: 9, v: null },
      { id: 'unkOld', size: 1, v: null, stale: true },
    ];
    const out = orderMembers(ms, (m) => m.v, st).map((m) => m.id);
    expect(out).toEqual(['now10', 'now5', 'old99', 'old50', 'unk', 'unkOld']);
    expect(out[0]).toBe(worstMember(ms, (m) => m.v, st).member.id);
    // staleOf 없으면 예전 그대로(값 높은 순 · 모름 뒤)
    expect(orderMembers(ms, (m) => m.v).map((m) => m.id)).toEqual(['old99', 'old50', 'now10', 'now5', 'unk', 'unkOld']);
    expect(ms[0].id).toBe('old99');   // 원본 그대로
  });
  it('Treemap 목록 — 순서에 staleOf · 값 칸 ‘(오래됨)’ · 견본 빗금(class) · 견본 색은 backgroundColor', () => {
    const tm = read('Treemap.jsx');
    expect(tm).toMatch(/orderMembers\(og\.members, valOf, \(m\) => tileView\(m\)\.stale === true\)/);
    expect(tm).toMatch(/\{v\.line\}\{v\.stale \? <span className="ins-grpst"> \(오래됨\)<\/span> : null\}/);
    expect(tm).toMatch(/<i className=\{v\.stale \? 'stale' : undefined\} style=\{\{ backgroundColor: v\.bg \}\} \/>/);
    expect(tm).not.toMatch(/<i style=\{\{ background: v\.bg \}\}/);
    const css = readRaw('insight.css');
    expect(css).toMatch(/\.ins-grpn i\.stale \{ background-image: repeating-linear-gradient/);
  });
});
