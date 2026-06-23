/**
 * 구성도 그래프 — "설정된 구성"(라이브 스냅샷 + 등록된 NSX + 위임 에이전트)을 노드/링크로
 * 직렬화한다. 3D 네트워크 뷰가 소비한다.
 *
 * 계층: 중앙 포탈 → 엣지 포탈(에이전트) → vCenter → (NSX) → ESXi 호스트 → (VM).
 * 에이전트가 push한 vCenter는 그 에이전트 아래에, 중앙 직접수집 vCenter는 중앙 아래에 연결.
 */

import { listInventory } from '../central/inventory.js';
import { getAllGpuGuestDiag } from '../central/gpuGuestDiag.js';
import { listRegistry as listNsxRegistry } from '../nsx/registry.js';
import { config, currentVersion } from '../config.js';

const VM_CAP = 1500; // 3D 성능 위해 VM 노드 총량 상한

export function buildGraph(snap, { vms = false } = {}) {
  const nodes = [];
  const links = [];
  const seen = new Set();
  const add = (n) => { if (!seen.has(n.id)) { seen.add(n.id); nodes.push(n); } };
  const link = (s, t, kind = '') => { if (seen.has(s) && seen.has(t)) links.push({ source: s, target: t, kind }); };

  // 1) 중앙 포탈
  add({ id: 'central', type: 'central', label: `중앙 포탈 v${currentVersion()}`, val: 28, status: 'ok' });

  // 2) vCenter ↔ 담당 에이전트 매핑(인벤토리 push + GPU게스트 진단)
  const vcAgent = new Map();
  for (const inv of listInventory()) if (inv.agent) vcAgent.set(inv.vcenterId, inv.agent);
  const agents = new Set();
  for (const a of getAllGpuGuestDiag()) {
    if (!a.agent) continue;
    agents.add(a.agent);
    for (const vc of a.vcenters || []) if (vc.vcId) vcAgent.set(vc.vcId, a.agent);
  }
  for (const ag of vcAgent.values()) agents.add(ag);

  // 3) 엣지 포탈(에이전트) 노드
  for (const ag of agents) {
    const id = `agent:${ag}`;
    add({ id, type: 'agent', label: `🛰 ${ag}`, val: 18, status: 'ok' });
    link('central', id, 'token');
  }

  // 4) vCenter 노드(설정/스냅샷) — 담당 에이전트 아래, 없으면 중앙 직접수집
  const vcParent = (vcId) => (vcAgent.has(vcId) ? `agent:${vcAgent.get(vcId)}` : 'central');
  for (const v of snap.vcenters || []) {
    const id = `vc:${v.id}`;
    add({ id, type: 'vcenter', label: v.name || v.id, val: 13, status: v.status || 'unknown', region: v.location?.region || v.region || '', version: v.version || '' });
    link(vcParent(v.id), id, vcAgent.has(v.id) ? 'collect' : 'direct');
  }

  // 5) NSX 매니저(등록된 구성) — vcenterId 있으면 그 vCenter 아래, 없으면 중앙
  for (const m of listNsxRegistry()) {
    const id = `nsx:${m.id}`;
    add({ id, type: 'nsx', label: `🛡 ${m.name || m.host}`, val: 11, status: m.status || (m.enabled === false ? 'disabled' : 'unknown'), region: m.region || '' });
    const parent = m.vcenterId && seen.has(`vc:${m.vcenterId}`) ? `vc:${m.vcenterId}` : 'central';
    link(parent, id, 'nsx');
  }

  // 6) ESXi 호스트 → vCenter
  for (const h of snap.hosts || []) {
    const id = `host:${h.id}`;
    add({ id, type: 'host', label: h.name, val: 7, status: h.connectionState || 'unknown',
      cpu: h.cpuUsagePct ?? null, mem: h.memUsagePct ?? null, gpus: (h.gpus || []).length, cluster: h.cluster || '' });
    link(`vc:${h.vcenterId}`, id, 'host');
  }

  // 7) (옵션) VM → 호스트 — 성능 위해 상한. 전원 ON·패스쓰루 GPU 우선.
  let vmCount = 0;
  if (vms) {
    const hostKey = new Map(); // `${vcId}|${hostName}` -> hostNodeId
    for (const h of snap.hosts || []) hostKey.set(`${h.vcenterId}|${h.name}`, `host:${h.id}`);
    const cands = (snap.vms || []).filter((v) => !v.template);
    cands.sort((a, b) => (b.gpu ? 1 : 0) - (a.gpu ? 1 : 0) || (b.powerState === 'POWERED_ON' ? 1 : 0) - (a.powerState === 'POWERED_ON' ? 1 : 0));
    for (const v of cands) {
      if (vmCount >= VM_CAP) break;
      const parent = hostKey.get(`${v.vcenterId}|${v.host}`);
      if (!parent) continue;
      const id = `vm:${v.id}`;
      add({ id, type: 'vm', label: v.name, val: 3, status: v.powerState === 'POWERED_ON' ? 'on' : 'off', gpu: v.gpu ? (v.gpu.type || 'gpu') : null });
      link(parent, id, 'vm');
      vmCount++;
    }
  }

  return {
    nodes, links,
    counts: {
      central: 1, agents: agents.size,
      vcenters: (snap.vcenters || []).length, nsx: listNsxRegistry().length,
      hosts: (snap.hosts || []).length, vms: vmCount,
    },
    source: snap.source, dataSource: config.dataSource, generatedAt: Date.now(),
  };
}
