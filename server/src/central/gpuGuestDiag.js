/**
 * 중앙이 각 agent에서 push 받은 'GPU 게스트 수집 진단'을 보관(인메모리).
 * 웹 '수집 진단' 화면이 이 값을 읽어 어느 단계에서 막혔는지 보여준다.
 */

let byAgent = new Map(); // agent명 → { at, receivedAt, mode, vcenters:[...], counts:{hosts,vms} }

export function setGpuGuestDiag(agent, diag, counts) {
  byAgent.set(String(agent || '?'), { ...(diag || {}), receivedAt: Date.now(), counts: counts || {} });
}

export function getAllGpuGuestDiag() {
  return [...byAgent.entries()].map(([agent, d]) => ({ agent, ...d }));
}
