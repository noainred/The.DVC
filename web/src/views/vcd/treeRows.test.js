// v2.911 — vCenter 트리의 VM 순서(드로어 ‹ › · ↑↓) 회귀: 검색 → 일치 결과(cap) · 호스트 보기 → 클러스터→호스트→VM · 폴더 보기 → 폴더 이름순 깊이 우선.
import { describe, it, expect } from 'vitest';
import { treeVmRows } from './treeRows.js';

const vm = (id, host) => ({ id, name: id, host });

describe('treeVmRows', () => {
  it('호스트 보기: clusters([이름, 호스트[]]) 순 · 호스트마다 vmsByHost · 모르는 호스트는 건너뜀', () => {
    const vmsByHost = new Map([['h1', [vm('a', 'h1'), vm('b', 'h1')]], ['h2', [vm('c', 'h2')]]]);
    const clusters = [['CL-A', [{ name: 'h1' }, { name: 'h9' }]], ['CL-B', [{ name: 'h2' }]]];
    expect(treeVmRows({ view: 'hosts', clusters, vmsByHost }).map((v) => v.id)).toEqual(['a', 'b', 'c']);
    expect(treeVmRows({ view: 'hosts', clusters: [], vmsByHost })).toEqual([]);
  });
  it('폴더 보기: 폴더 이름순 깊이 우선 뒤 그 폴더의 VM(화면 FolderNodes 와 같은 순서)', () => {
    const tree = { folders: { Prod: { folders: { DB: { folders: {}, vms: [vm('p-db')] } }, vms: [vm('p-1')] }, Dev: { folders: {}, vms: [vm('d-1')] } }, vms: [vm('root-1')] };
    expect(treeVmRows({ view: 'vms', folderTree: tree }).map((v) => v.id)).toEqual(['d-1', 'p-db', 'p-1', 'root-1']);
    expect(treeVmRows({ view: 'vms', folderTree: null })).toEqual([]);
  });
  it('검색 중이면 일치 결과(cap) — 보기와 무관 · 모양이 {v} 든 VM 이든', () => {
    const matches = [{ v: vm('m1') }, { v: vm('m2') }, vm('m3')];
    expect(treeVmRows({ view: 'hosts', query: 'm', matches, cap: 2 }).map((v) => v.id)).toEqual(['m1', 'm2']);
    expect(treeVmRows({ view: 'vms', query: 'm', matches }).map((v) => v.id)).toEqual(['m1', 'm2', 'm3']);
  });
  it('모르는 보기 · 빈 인자는 []', () => {
    expect(treeVmRows({ view: 'storage' })).toEqual([]);
    expect(treeVmRows()).toEqual([]);
  });
});
