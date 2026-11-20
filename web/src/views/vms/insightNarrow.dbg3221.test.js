// dbg3221 — VM · 호스트 분석 화면 결함 회귀(4회차):
//   ① 400px — 순서 막대(RankBars .ins-rb)의 이름 열이 96px 로 줄면 말줄임 대신 줄바꿈(‘Windows Server 2022’ · ‘2019’,
//      ‘PowerEdge R740’ · ‘R750’ 이 같은 글자로 보이지 않게). 스냅샷 목록 줄(.ins-pr)은 이름 · 법인 줄을 한 줄 위로 올리고 줄바꿈.
//   ② 과할당 보기 — 호스트 코어 clock 을 몰라 CPU 합에서 뺀 VM 수(excludedNoHostMhz)를 CPU 카드 · 법인별 CPU 막대에 밝힌다
//      (부분 합을 전체 합처럼 보이지 않는다 — 도구 화면 CapacityTools · 내보내기 wasteExport 와 같은 사실).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../test/_stripComments.js';
import { overTotals, corpBars, cpuNoClockText } from './insight-tools/vmOverText.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../..');
const raw = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const css = raw('views/insight/insight.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** max-width:720px 미디어 블록들의 본문을 모은다(중괄호 짝 맞춤). */
function narrowBlocks(text) {
  const out = [];
  const re = /@media\s*\(max-width:\s*720px\)\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    let depth = 1; let i = re.lastIndex;
    for (; i < text.length && depth > 0; i += 1) { if (text[i] === '{') depth += 1; else if (text[i] === '}') depth -= 1; }
    out.push(text.slice(re.lastIndex, i - 1));
  }
  return out.join('\n');
}
const ruleOf = (block, sel) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = block.match(new RegExp(`(?:^|[},\\s])${esc}\\s*(?:,[^{]*)?\\{([^}]*)\\}`));
  return m ? m[1] : '';
};

describe('① 400px — 이름은 말줄임 대신 줄바꿈', () => {
  const nb = narrowBlocks(css);
  it('720px 이하에서 .ins-rb .n 은 줄바꿈한다(nowrap · ellipsis 를 풀어 준다)', () => {
    const r = ruleOf(nb, '.ins-rb .n');
    expect(r).toMatch(/white-space:\s*normal/);
    expect(r).toMatch(/overflow-wrap:\s*anywhere/);
  });
  it('720px 이하에서 .ins-pr 은 이름 칸을 한 줄 전체로 올리고 이름 · 법인 줄을 줄바꿈한다', () => {
    expect(ruleOf(nb, '.ins-pr > span:first-child')).toMatch(/grid-column:\s*1\s*\/\s*-1/);
    const r = ruleOf(nb, '.ins-pr .nm');
    expect(r).toMatch(/white-space:\s*normal/);
    expect(nb).toMatch(/\.ins-pr \.nm,\s*\.ins-pr \.ins-sb\s*\{[^}]*white-space:\s*normal/);
  });
  it('넓은 화면의 한 줄 말줄임은 그대로다(1440px 배치 회귀 방지)', () => {
    const wide = css.replace(/@media\s*\(max-width:\s*720px\)\s*\{[\s\S]*?\}\s*\}/g, '');
    expect(wide).toMatch(/\.ins-rb \.n\s*\{[^}]*white-space:\s*nowrap/);
  });
});

describe('② 과할당 — 호스트 clock 미상으로 CPU 합에서 뺀 VM 을 밝힌다', () => {
  const row = (id, ex) => ({ vcenterId: id, name: id, vms: 10, poweredOnVms: 8,
    cpu: { allocMhz: 1000, usedMhz: 200, idleMhz: 800, candidates: 2 }, mem: { allocMB: 4096, usedMB: 1024, idleMB: 3072, candidates: 1 },
    usageUnknown: { cpu: 0, mem: 0 }, excludedNoHostMhz: ex, top: {} });
  const resp = { rows: [row('A', 7), row('B', 0)], thresholds: { cpuIdlePct: 10, memIdlePct: 20 } };

  it('cpuNoClockText — 0 · 결측이면 빈 글자, 있으면 대수와 ‘합은 하한’', () => {
    expect(cpuNoClockText(0)).toBe('');
    expect(cpuNoClockText(null)).toBe('');
    expect(cpuNoClockText(undefined)).toBe('');
    expect(cpuNoClockText(7)).toContain('7대');
    expect(cpuNoClockText(7)).toContain('합은 하한');
  });
  it('overTotals 합 · corpBars(cpu) 법인별 수가 응답과 같다 · 메모리 막대에는 붙이지 않는다', () => {
    const t = overTotals(resp, []);
    expect(t.excludedNoHostMhz).toBe(7);
    const cpu = Object.fromEntries(corpBars(t, 'cpu').map((b) => [b.vcenterId, b.noClock]));
    expect(cpu).toEqual({ A: 7, B: 0 });
    expect(corpBars(t, 'mem').every((b) => b.noClock === 0)).toBe(true);
  });
  it('VmOverView 는 CPU 카드 note 와 법인별 막대(글 · tip)에 그 수를 싣는다', () => {
    const src = stripComments(raw('views/vms/insight-tools/VmOverView.jsx'));
    expect(src).toMatch(/cpuNoClockText\(t\.excludedNoHostMhz\)/);
    expect(src).toMatch(/c\.noClock > 0 \? ` · clock 미상/);
    expect(src).toMatch(/cpuNoClockText\(c\.noClock\)/);
  });
});
