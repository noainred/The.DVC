// 특수 기능 카테고리 섹션(v2.455) — 화면 배치 로직 회귀 고정.
//
// 요구: "특수기능에 기능이 너무 많아서 카테고리로 묶어 보여줄 수 있게. 서버/네트워크/스토리지/
// 가상화 등 사용자가 각 기능을 카테고리에 선택해 포함. **1개 기능을 중복해서 여러 카테고리에
// 넣을 수 있게.**"
//
// 중복 소속이 이 기능의 핵심 요구라 '한 도구는 한 섹션' 으로 되돌아가지 않도록 여기서 고정한다.
import { describe, it, expect } from 'vitest';
import { buildSections, categoriesOf, uncategorizedKeys } from './toolSections.js';

const CFG = {
  enabled: true,
  categories: [
    { id: 'server', label: '서버', icon: '🖥️', tools: ['esxi', 'gpu', 'hba'] },
    { id: 'virt', label: '가상화', icon: '🧊', tools: ['esxi', 'gpu', 'vmtools'] },  // esxi·gpu 중복
    { id: 'net', label: '네트워크', icon: '🌐', tools: ['nsx'] },
  ],
};
const KEYS = ['esxi', 'gpu', 'hba', 'vmtools', 'nsx', 'portaldb'];

describe('buildSections', () => {
  it('★ 한 도구가 여러 카테고리에 동시에 나온다(중복 소속이 요구사항)', () => {
    const secs = buildSections(CFG, KEYS);
    const server = secs.find((s) => s.id === 'server');
    const virt = secs.find((s) => s.id === 'virt');
    expect(server.tools).toContain('esxi');
    expect(virt.tools).toContain('esxi');
    expect(server.tools).toContain('gpu');
    expect(virt.tools).toContain('gpu');
  });

  it("어느 카테고리에도 없는 도구는 사라지지 않고 '기타'로 모인다", () => {
    const secs = buildSections(CFG, KEYS);
    const other = secs[secs.length - 1];
    expect(other.id).toBe('_uncategorized');
    expect(other.tools).toEqual(['portaldb']);
  });

  it("'기타' 표시를 끄면 분류 안 된 도구는 나오지 않는다", () => {
    const secs = buildSections({ ...CFG, showUncategorized: false }, KEYS);
    expect(secs.some((s) => s.id === '_uncategorized')).toBe(false);
  });

  it('카테고리를 쓰지 않으면 빈 배열 — 화면은 기존 단일 그리드를 그린다', () => {
    expect(buildSections({ ...CFG, enabled: false }, KEYS)).toEqual([]);
    expect(buildSections({ enabled: true, categories: [] }, KEYS)).toEqual([]);
    expect(buildSections(null, KEYS)).toEqual([]);
  });

  it('보이지 않는 도구는 빼고, 그래서 빈 카테고리는 통째로 숨긴다', () => {
    // 'nsx' 권한이 없어 목록에 없는 사용자 → 네트워크 카테고리는 제목도 나오지 않아야 한다.
    const secs = buildSections(CFG, ['esxi', 'gpu', 'hba', 'vmtools']);
    expect(secs.some((s) => s.id === 'net')).toBe(false);
    expect(secs.find((s) => s.id === 'server').tools).toEqual(['esxi', 'gpu', 'hba']);
  });

  it('표시 꺼진 카테고리는 건너뛰되 그 도구가 사라지지는 않는다(기타로 간다)', () => {
    const cfg = { ...CFG, categories: CFG.categories.map((c) => (c.id === 'net' ? { ...c, enabled: false } : c)) };
    const secs = buildSections(cfg, KEYS);
    expect(secs.some((s) => s.id === 'net')).toBe(false);
    expect(secs.find((s) => s.id === '_uncategorized').tools).toEqual(expect.arrayContaining(['nsx', 'portaldb']));
  });

  it('섹션 안의 순서는 호출부가 준 순서를 따른다(사용 빈도 정렬 유지)', () => {
    // 호출부가 '많이 쓴 순' 으로 gpu, esxi, hba 를 넘기면 섹션 안에서도 그 순서여야 한다.
    const secs = buildSections(CFG, ['gpu', 'esxi', 'hba', 'vmtools', 'nsx']);
    expect(secs.find((s) => s.id === 'server').tools).toEqual(['gpu', 'esxi', 'hba']);
  });

  it('카테고리 순서는 설정 순서를 따른다', () => {
    const secs = buildSections(CFG, KEYS);
    expect(secs.map((s) => s.id)).toEqual(['server', 'virt', 'net', '_uncategorized']);
  });

  it('중복 정의가 있어도 같은 섹션 안에서는 한 번만 나온다', () => {
    const cfg = { enabled: true, categories: [{ id: 'a', label: 'A', tools: ['esxi', 'esxi'] }] };
    expect(buildSections(cfg, ['esxi']).find((s) => s.id === 'a').tools).toEqual(['esxi']);
  });
});

describe('categoriesOf / uncategorizedKeys', () => {
  it('한 도구가 속한 카테고리를 전부 알려준다(설정 화면의 중복 표시용)', () => {
    expect(categoriesOf(CFG, 'esxi')).toEqual(['서버', '가상화']);
    expect(categoriesOf(CFG, 'hba')).toEqual(['서버']);
    expect(categoriesOf(CFG, 'portaldb')).toEqual([]);
  });

  it('분류 안 된 도구를 찾아낸다', () => {
    expect(uncategorizedKeys(CFG, KEYS)).toEqual(['portaldb']);
    expect(uncategorizedKeys({ categories: [] }, ['a', 'b'])).toEqual(['a', 'b']);
  });
});
