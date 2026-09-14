/**
 * version_4/tree.js 회귀(v2.508) — 시안 ⑧의 약속은 '미분류 0 · 주소속 1회' 다.
 * 새 도구를 추가하고 트리에 넣지 않으면 사용자는 그 기능을 **내비에서 영원히 못 찾는다**
 * (레거시 그리드에만 남는다). 그 사고를 여기서 막는다.
 */
import { describe, it, expect } from 'vitest';
import { TREE, PAGE_IDS, primaryToolKeys, groupLabelOfTool, groupLabelsOfTool, visibleTree } from './tree.js';
import { TOOLS } from '../views/specialToolsList.js';

const ALL_KEYS = TOOLS.map((t) => t.k);

describe('IA 트리 커버리지', () => {
  it('그룹이 11개다', () => {
    expect(TREE.length).toBe(11);
    expect(new Set(TREE.map((g) => g.id)).size).toBe(11);
  });

  it('모든 도구가 주소속에 정확히 1회 배치된다 — 미분류 0', () => {
    const primary = primaryToolKeys();
    const missing = ALL_KEYS.filter((k) => !primary.includes(k));
    expect(missing).toEqual([]);
    const dup = primary.filter((k, i) => primary.indexOf(k) !== i);
    expect(dup).toEqual([]);
    expect(primary.length).toBe(ALL_KEYS.length);
  });

  it('트리에 유령 도구 키가 없다', () => {
    const known = new Set(ALL_KEYS);
    const ghosts = TREE.flatMap((g) => g.items.filter((i) => i.kind === 'tool').map((i) => i.k))
      .filter((k) => !known.has(k));
    expect(ghosts).toEqual([]);
  });

  it('별칭은 주소속과 다른 그룹에만 둔다', () => {
    for (const g of TREE) {
      const aliases = g.items.filter((i) => i.kind === 'tool' && i.alias).map((i) => i.k);
      for (const k of aliases) expect(groupLabelOfTool(k)).not.toBe(g.label);
    }
  });

  it('상태를 바꾸는 도구는 운영 작업이 주소속이다', () => {
    // 조회 그룹을 훑다가 실행 버튼을 만나지 않게 한다.
    for (const k of ['rma', 'vmprovision', 'vm-clone', 'agent-scans', 'diskadd', 'backup', 'massdeploy', 'shutdown']) {
      expect(groupLabelOfTool(k)).toBe('운영 작업');
    }
  });

  it('V4 화면 9개가 트리에서 도출된다', () => {
    expect([...PAGE_IDS].sort()).toEqual(
      ['alarms', 'compare', 'compute', 'facility', 'network', 'overview', 'power', 'storage', 'tools'],
    );
  });

  it('개발 포탈 탭이 중복 없이 들어간다', () => {
    const tabs = TREE.flatMap((g) => g.items.filter((i) => i.kind === 'tab').map((i) => i.id));
    expect(new Set(tabs).size).toBe(tabs.length);
    for (const t of tabs) {
      const node = TREE.flatMap((g) => g.items).find((i) => i.kind === 'tab' && i.id === t);
      expect(node.hash.startsWith('#/')).toBe(true);
      expect(node.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('분류명 조회 — 주소속과 별칭을 모두 돌려준다', () => {
    expect(groupLabelOfTool('orphanvmdk')).toBe('스토리지');
    expect(groupLabelsOfTool('hba').sort()).toEqual(['네트워크', '스토리지']);
    expect(groupLabelOfTool('없는키')).toBe(null);
  });
});

describe('역할 필터', () => {
  it('관리자 전용 도구는 비관리자에게 보이지 않는다', () => {
    const shown = visibleTree(TOOLS, { isAdmin: false });
    const keys = shown.flatMap((g) => g.items.filter((i) => i.kind === 'tool').map((i) => i.k));
    const adminKeys = TOOLS.filter((t) => t.adminOnly).map((t) => t.k);
    expect(adminKeys.length).toBeGreaterThan(0);
    for (const k of adminKeys) expect(keys).not.toContain(k);
  });

  it('관리자는 모든 주소속 도구를 본다', () => {
    const shown = visibleTree(TOOLS, { isAdmin: true });
    const keys = shown.flatMap((g) => g.items.filter((i) => i.kind === 'tool' && !i.alias).map((i) => i.k));
    expect(new Set(keys).size).toBe(TOOLS.length);
  });

  it('항목이 전부 걸러진 그룹은 접힌다', () => {
    const shown = visibleTree(TOOLS, { isAdmin: true, pageAllowed: () => false, tabAllowed: () => false });
    for (const g of shown) expect(g.items.length).toBeGreaterThan(0);
  });
});
