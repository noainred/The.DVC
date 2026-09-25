import { describe, it, expect } from 'vitest';
import { searchResults, DATA_TARGETS, TOOL_RESULT_MAX } from './searchData.js';
import { resolveTree } from './tree.js';
import { TOOLS } from '../views/specialToolsList.js';

const ALL = ['overview', 'summary', 'vcenters', 'svcmon', 'hosts', 'vms', 'datastores', 'networks', 'ipam', 'alarms', 'tools', 'settings', 'upgrade'];
const adminTree = resolveTree(TOOLS, { isAdmin: true, visibleTabIds: ALL });

describe('통합 검색', () => {
  it('빈 검색어는 결과 없음', () => {
    expect(searchResults('  ', adminTree, TOOLS)).toEqual({ data: [], tools: [], toolsOmitted: 0 });
  });
  it('데이터 대상 5종 + 기능 결과(상한과 잘린 개수)', () => {
    const r = searchResults('스냅샷', adminTree, TOOLS);
    expect(r.data.map((d) => d.key)).toEqual(DATA_TARGETS.map((d) => d.key));
    expect(r.data[0].label).toBe('가상머신에서 ‘스냅샷’ 찾기');
    expect(r.tools.some((t) => t.key === 'tool:snapshots')).toBe(true);
    expect(r.tools.length).toBeLessThanOrEqual(TOOL_RESULT_MAX);
  });
  it('보이지 않는 화면으로는 보내지 않는다', () => {
    const viewer = resolveTree(TOOLS, { isAdmin: false, visibleTabIds: ['overview', 'summary', 'vms'], can: () => true, toolAllowed: () => true });
    const r = searchResults('abc', viewer, TOOLS);
    expect(r.data.map((d) => d.key)).toEqual(['tab:vms']);
    expect(searchResults('스토리지 모니터링', viewer, TOOLS).tools.some((t) => t.key === 'tool:storage-mon')).toBe(false);
  });
  it('그룹 이름으로도 찾는다', () => {
    expect(searchResults('자동화', adminTree, TOOLS).tools.some((t) => t.key === 'tool:rma')).toBe(true);
  });
  it('많이 걸리면 잘린 개수를 밝힌다', () => {
    const r = searchResults('e', adminTree, TOOLS);
    expect(r.tools.length).toBe(TOOL_RESULT_MAX);
    expect(r.toolsOmitted).toBeGreaterThan(0);
  });
});
