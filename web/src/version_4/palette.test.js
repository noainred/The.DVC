// version_4/palette.js 회귀(v2.508) — 팔레트와 카드 검색이 같은 규칙을 쓰는지, 잘라낸 개수를 밝히는지.
import { describe, it, expect } from 'vitest';
import { search, flatten, pageEntries, tabEntries } from './palette.js';
import { PAGE_META } from './nav.js';
import { TOOLS } from '../views/specialToolsList.js';

const run = (q, opt = {}) => search(q, { tools: TOOLS, pageMeta: PAGE_META, ...opt });

describe('커맨드 팔레트', () => {
  it('빈 검색어는 아무것도 제안하지 않는다', () => {
    const r = run('  ');
    expect(r.tools).toEqual([]);
    expect(r.pages).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('키로 찾는다 — gpu', () => {
    const r = run('gpu');
    expect(r.tools.map((t) => t.k)).toContain('gpu');
  });

  it('구 명칭으로 찾는다 — 낭비 · 자원 최적화 → Optimization', () => {
    for (const old of ['낭비', '자원 최적화']) {
      expect(run(old).tools.map((t) => t.k)).toContain('waste');
    }
  });

  it('분류명으로 찾는다 — 스토리지', () => {
    // 분류명 일치는 라벨·키·별칭보다 **뒤 순위**라 기본 상한(6)에서는 잘릴 수 있다.
    // 그게 정상 동작이고, 잘린 개수는 toolsOmitted 로 밝힌다. 매칭 자체가 되는지를 본다.
    const r = run('스토리지', { limit: 100 });
    expect(r.tools.map((t) => t.k)).toContain('orphanvmdk');
    // 라벨에 '스토리지' 가 든 것이 분류명으로만 걸린 것보다 먼저 나온다.
    const keys = r.tools.map((t) => t.k);
    expect(keys.indexOf('storage-mon')).toBeLessThan(keys.indexOf('orphanvmdk'));
  });

  it('화면도 찾는다 — 설비', () => {
    const r = run('설비');
    expect(r.pages.map((p) => p.hash)).toContain('#/v4/facility');
  });

  it('잘라낸 개수를 밝힌다(조용히 자르지 않는다)', () => {
    const r = run('vm', { limit: 2 });
    expect(r.tools.length).toBeLessThanOrEqual(2);
    expect(r.toolsOmitted).toBeGreaterThan(0);
  });

  it('화면 목록에 V4 화면 9개가 중복 없이 들어간다', () => {
    const p = pageEntries(PAGE_META);
    expect(p.length).toBe(9);
    expect(new Set(p.map((x) => x.id)).size).toBe(9);
    for (const x of p) expect(x.hash).toBe(`#/v4/${x.id}`);
  });

  it('탭 목록은 개발 포탈 해시를 가리킨다', () => {
    for (const t of tabEntries()) expect(t.hash.startsWith('#/')).toBe(true);
  });

  it('flatten 은 기능 → 화면 → 탭 순서를 유지한다', () => {
    const r = run('스토리지');
    const flat = flatten(r);
    const kinds = flat.map((x) => x.kind);
    const firstPage = kinds.indexOf('page');
    const lastTool = kinds.lastIndexOf('tool');
    if (firstPage >= 0 && lastTool >= 0) expect(lastTool).toBeLessThan(firstPage);
    for (const x of flat) expect(typeof x.hash).toBe('string');
  });
});
