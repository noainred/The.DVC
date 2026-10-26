// components/palette.js 회귀(v2.508 · v2.747 에 version_4/palette.js 에서 옮김) — 팔레트와 카드 검색이 같은 규칙을 쓰는지,
// 잘라낸 개수를 밝히는지, V4 메뉴 트리 없이도 분류명·탭으로 찾는지.
import { describe, it, expect } from 'vitest';
import { search, flatten, tabEntries, catsOfFrom, TAB_GROUP } from './palette.js';
import { TOOLS } from '../views/specialToolsList.js';

const CFG = {
  enabled: true,
  categories: [
    { id: 'storage', label: '스토리지', tools: ['orphanvmdk', 'storage-mon'] },
    { id: 'off', label: '꺼진분류', enabled: false, tools: ['gpu'] },
  ],
};
const TABS = [{ id: 'summary', label: 'Summary' }, { id: 'datastores', label: '스토리지' }, { id: 'settings', label: '설정' }];
const catsOf = catsOfFrom(CFG);
const run = (q, opt = {}) => search(q, { tools: TOOLS, tabs: TABS, catsOf, ...opt });

describe('커맨드 팔레트', () => {
  it('빈 검색어는 아무것도 제안하지 않는다', () => {
    const r = run('  ');
    expect(r.tools).toEqual([]);
    expect(r.tabs).toEqual([]);
    expect(r.empty).toBe(true);
  });

  it('키로 찾는다 — gpu', () => {
    expect(run('gpu').tools.map((t) => t.k)).toContain('gpu');
  });

  it('구 명칭으로 찾는다 — 낭비 · 자원 최적화 → Optimization', () => {
    for (const old of ['낭비', '자원 최적화']) {
      expect(run(old).tools.map((t) => t.k)).toContain('waste');
    }
  });

  it('분류명(특수 기능 카테고리 설정)으로 찾는다 — 스토리지', () => {
    // 분류명 일치는 라벨·키·별칭보다 **뒤 순위**라 기본 상한(6)에서는 잘릴 수 있다. 매칭 자체가 되는지를 본다.
    const keys = run('스토리지', { limit: 100 }).tools.map((t) => t.k);
    expect(keys).toContain('orphanvmdk');
    expect(keys.indexOf('storage-mon')).toBeLessThan(keys.indexOf('orphanvmdk'));
  });

  it('꺼진 분류·꺼진 카테고리 설정은 분류명으로 쓰지 않는다', () => {
    expect(catsOf('gpu')).toEqual([]);
    expect(catsOfFrom({ ...CFG, enabled: false })('orphanvmdk')).toEqual([]);
    expect(catsOfFrom(null)('orphanvmdk')).toEqual([]);
  });

  it('잘라낸 개수를 밝힌다(조용히 자르지 않는다)', () => {
    const r = run('vm', { limit: 2 });
    expect(r.tools.length).toBeLessThanOrEqual(2);
    expect(r.toolsOmitted).toBeGreaterThan(0);
  });

  it('탭은 호출자가 넘긴 것만 — 상단 메뉴 해시를 가리킨다', () => {
    const t = tabEntries(TABS);
    expect(t.map((x) => x.hash)).toEqual(['#/summary', '#/datastores', '#/settings']);
    for (const x of t) expect(x.group).toBe(TAB_GROUP);
    expect(tabEntries(null)).toEqual([]);
    expect(tabEntries([null, { id: '' }, { label: 'x' }])).toEqual([]);
    expect(run('설정').tabs.map((x) => x.id)).toEqual(['settings']);
    expect(search('설정', { tools: TOOLS, tabs: [] }).tabs).toEqual([]);
  });

  it('flatten 은 기능 → 탭 순서이고 V4 화면(#/v4/…)을 내지 않는다', () => {
    // v2.789: 스토리지 도구가 하나 늘어(스토리지 사용량 보고서 — 라벨 일치) 분류명 일치만 있는 orphanvmdk 가 기본 상한(6) 밖으로 밀렸다.
    //   위 '분류명으로 찾는다' 와 같이 상한을 넓혀 그룹 판정을 본다(순서·V4 제외 검사는 그대로).
    const flat = flatten(run('스토리지', { limit: 100 }), { catsOf });
    const kinds = flat.map((x) => x.kind);
    expect(kinds.lastIndexOf('tool')).toBeLessThan(kinds.indexOf('tab'));
    for (const x of flat) {
      expect(['tool', 'tab']).toContain(x.kind);
      expect(x.hash.startsWith('#/v4')).toBe(false);
    }
    expect(flat.find((x) => x.k === 'orphanvmdk')?.group).toBe('스토리지');
  });
});
