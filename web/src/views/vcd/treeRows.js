/**
 * views/vcd/treeRows.js — vCenter 상세 트리(호스트 및 클러스터 · VM 및 폴더 · 검색 결과)에 **보이는 순서대로** VM 행(v2.911 · 시안 docs/design/vm-perf ①).
 *   VM 드로어의 ‹ › · ↑↓ 가 이 순서를 따른다(가상화 서버는 표가 그린 순서 — 같은 규약). 펼침 여부와 무관하게 트리 순서 전체다(접힌 호스트의 VM 으로도 넘어간다).
 *   순수 모듈(vitest 고정). 검색 중이면 일치 결과(cap 까지) · 호스트 보기는 클러스터 → 호스트 → 그 호스트의 VM · 폴더 보기는 폴더 이름순 깊이 우선 뒤 그 폴더의 VM.
 */
export function treeVmRows({ view, query = '', matches = [], cap = Infinity, clusters = [], vmsByHost = new Map(), folderTree = null } = {}) {
  if (query) return (Array.isArray(matches) ? matches : []).slice(0, cap).map((m) => (m && m.v ? m.v : m)).filter(Boolean);
  if (view === 'hosts') {
    const out = [];
    for (const entry of Array.isArray(clusters) ? clusters : []) {
      const hosts = Array.isArray(entry?.[1]) ? entry[1] : [];
      for (const h of hosts) for (const vm of vmsByHost?.get?.(h?.name) || []) out.push(vm);
    }
    return out;
  }
  if (view === 'vms') {
    const out = [];
    const walk = (node) => {
      if (!node) return;
      for (const name of Object.keys(node.folders || {}).sort()) walk(node.folders[name]);
      for (const vm of node.vms || []) out.push(vm);
    };
    walk(folderTree);
    return out;
  }
  return [];
}

/**
 * v2.975 — 트리에 **보이는 순서대로** 호스트 행(호스트 드로어의 ‹ › · ↑↓ · 시안 docs/design/host-drawer ①).
 *   호스트 및 클러스터 보기에서만 호스트가 보인다(VM 및 폴더 보기는 []). 검색 중이면 일치한 호스트(cap 까지) · 아니면 클러스터 → 그 클러스터의 호스트.
 */
export function treeHostRows({ view, query = '', hostMatches = [], cap = Infinity, clusters = [] } = {}) {
  if (view !== 'hosts') return [];
  if (query) return (Array.isArray(hostMatches) ? hostMatches : []).slice(0, cap).filter(Boolean);
  const out = [];
  for (const entry of Array.isArray(clusters) ? clusters : []) for (const h of Array.isArray(entry?.[1]) ? entry[1] : []) if (h) out.push(h);
  return out;
}
