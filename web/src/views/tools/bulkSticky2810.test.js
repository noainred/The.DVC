// v2.810(사용자 요청 '스크롤 내리면 선택 바가 계속 보이게') — Veeam 백업 현황 › Detail 의 일괄 표시 바(선택 없음 · 보이는 VM 전체 선택 ·
//   중요도 · 백업 방식 · 백업 필요)는 표를 내려도 셸 머리 아래에 붙어 있다. 옆 상세 칸은 그 바 아래에 붙는다(예전 top:56 은 바와 겹친다).
// 높이는 화면이 재서 CSS 변수로 넘긴다(숫자를 박지 않는다) · 720px 이하는 고정하지 않는다(.st-bar 와 같은 규칙).
// sticky·겹침은 정적 렌더로 닿지 않는다 — 소스 계약으로 고정하고 화면은 Chromium 으로 본다.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const det = read('./BackupDetailTool.jsx');
const css = read('../../styles.css');

describe('일괄 표시 바 sticky', () => {
  it('바는 .bk-bulk + 높이 측정 ref · 루트가 머리·바 높이를 CSS 변수로 넘긴다', () => {
    expect(det).toMatch(/<div ref=\{bulkRef\} className="card bk-bulk" data-backup-bulk=""/);
    expect(det).toMatch(/const headH = useStickyHeadH\(\);/);
    expect(det).toMatch(/const \[bulkRef, bulkH\] = useBoxHeight\(\);/);
    expect(det).toMatch(/'--bk-head': `\$\{headH\}px`, '--bk-bulk': `\$\{bulkH \? bulkH \+ 8 : 0\}px`/);
  });
  it('훅은 조기 return 위(React #310)', () => {
    const early = det.indexOf('if (vcs && !vcs.length) return');
    expect(early).toBeGreaterThan(0);
    for (const h of ['useStickyHeadH()', 'useBoxHeight()']) {
      const i = det.indexOf(h);
      expect(i, h).toBeGreaterThan(0);
      expect(i, `${h} 는 조기 return 앞`).toBeLessThan(early);
    }
  });
  it('옆 상세 칸은 .bk-side(바 아래) — 인라인 top:56 고정이 남지 않는다', () => {
    expect(det).toMatch(/<div className="bk-side" style=\{\{ flex: '1 1 280px'/);
    expect(det).not.toMatch(/position: 'sticky', top: 56/);
  });
  it('CSS — 바는 머리 아래 sticky · 불투명 배경 · 상세 칸은 바 높이만큼 아래 · 720px 이하는 고정하지 않음', () => {
    expect(css).toMatch(/\.bk-bulk \{ position: sticky; top: calc\(var\(--bk-head, 56px\) \+ 8px\); z-index: 15; background: var\(--panel\); \}/);
    expect(css).toMatch(/\.bk-side \{ position: sticky; top: calc\(var\(--bk-head, 56px\) \+ 8px \+ var\(--bk-bulk, 0px\)\); \}/);
    // 배경이 반투명이면 지나가는 표 줄이 비친다 — --panel 은 불투명 색이어야 한다
    expect(css).toMatch(/--panel: #[0-9a-fA-F]{6};/);
    // 머리와 바 사이 8px 틈은 페이지 바탕색으로 덮는다(지나가는 표 줄이 비치지 않게 — Chromium 판독)
    expect(css).toMatch(/\.bk-bulk::before \{ content: ''; position: absolute; left: -1px; right: -1px; bottom: 100%; height: 9px; background: var\(--bg\); \}/);
    const m = css.match(/@media \(max-width: 720px\) \{\n {2}\.bk-bulk \{ position: static; \}\n {2}\.bk-bulk::before \{ display: none; \}\n {2}\.bk-side \{ top: calc\(var\(--bk-head, 56px\) \+ 8px\); \}\n\}/);
    expect(m, '좁은 화면 규칙').not.toBe(null);
    // 바(z 15)는 셸 머리(.topbar z 30)·사이드바(z 20) 아래
    expect(css).toMatch(/\.topbar \{[^}]*z-index: 30;/);
  });
});

describe('셸 머리 높이 측정은 공용 훅 하나', () => {
  it('STICKY_HEADS 정의는 hooks/useStickyOffset.js 에만 · 특수 기능 홈도 같은 훅', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const hits = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name) && /STICKY_HEADS = /.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(root, p));
      }
    };
    walk(root);
    expect(hits).toEqual(['hooks/useStickyOffset.js']);
    const st = read('../SpecialTools.jsx');
    expect(st).toMatch(/const headH = useStickyHeadH\(!tool\);/);
    expect(st).not.toMatch(/setHeadH/);
  });
});
