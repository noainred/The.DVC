/**
 * 토폴로지·의존성 맵 — 스냅샷에서 vCenter → 클러스터 → 호스트 → VM 계층 트리를 구성한다.
 * 장애 영향 범위 파악용. 30개 vCenter·대량 VM을 고려해 VM은 vCenter focus 시에만 펼치고,
 * 그 외에는 호스트별 VM 개수만 집계해 O(N)·작은 페이로드를 유지한다.
 */

const num = (x) => (Number.isFinite(x) ? x : 0);

export function buildTopology(snap, { vcenterId = null, host = null } = {}) {
  const vcs = (snap.vcenters || []).filter((v) => !vcenterId || v.id === vcenterId);
  const hostsByVc = new Map();
  for (const h of snap.hosts || []) {
    if (vcenterId && h.vcenterId !== vcenterId) continue;
    if (!hostsByVc.has(h.vcenterId)) hostsByVc.set(h.vcenterId, []);
    hostsByVc.get(h.vcenterId).push(h);
  }
  // 호스트별 VM(전원 ON 우선). focus 시에만 개별 VM 노드 생성.
  const vmsByHost = new Map();
  for (const v of snap.vms || []) {
    if (v.template) continue;
    if (vcenterId && v.vcenterId !== vcenterId) continue;
    const key = `${v.vcenterId}|${v.host || ''}`;
    if (!vmsByHost.has(key)) vmsByHost.set(key, []);
    vmsByHost.get(key).push(v);
  }

  const tree = [];
  let nodeCount = 0;
  for (const v of vcs) {
    const hs = hostsByVc.get(v.id) || [];
    const clusters = new Map();
    for (const h of hs) {
      const cl = h.cluster || '(standalone)';
      if (!clusters.has(cl)) clusters.set(cl, []);
      clusters.get(cl).push(h);
    }
    const clusterNodes = [...clusters.entries()].map(([cl, chosts]) => {
      const hostNodes = chosts.map((h) => {
        const vms = vmsByHost.get(`${v.id}|${h.name}`) || [];
        const on = vms.filter((x) => x.powerState === 'POWERED_ON').length;
        const node = {
          id: h.id, type: 'host', label: h.name,
          state: h.connectionState, power: h.powerState,
          cpuPct: num(h.cpuUsagePct), memPct: num(h.memUsagePct),
          watts: num(h.powerWatts), gpus: (h.gpus || []).length,
          vmCount: vms.length, vmOn: on,
          children: [],
        };
        // focus(특정 vCenter)일 때만 개별 VM 펼침 — 호스트당 상위 200개로 제한.
        if (vcenterId && (!host || host === h.name || host === h.id)) {
          node.children = vms.slice(0, 200).map((vm) => ({
            id: vm.id, type: 'vm', label: vm.name, power: vm.powerState,
            cpuPct: num(vm.cpuUsagePct), memPct: num(vm.memUsagePct),
            guestOS: vm.guestOS, gpu: vm.gpu ? (vm.gpu.mode || 'gpu') : null, ip: vm.ipAddress || (vm.ipAddresses || [])[0] || '',
          }));
          nodeCount += node.children.length;
        }
        nodeCount++;
        return node;
      }).sort((a, b) => b.vmCount - a.vmCount);
      nodeCount++;
      return {
        id: `${v.id}|cluster|${cl}`, type: 'cluster', label: cl,
        hosts: hostNodes.length, vmCount: hostNodes.reduce((a, h) => a + h.vmCount, 0),
        children: hostNodes,
      };
    }).sort((a, b) => b.vmCount - a.vmCount);
    nodeCount++;
    tree.push({
      id: v.id, type: 'vcenter', label: v.name || v.id, status: v.status,
      region: v.location?.region || v.region || '', version: v.version,
      hosts: hs.length, clusters: clusterNodes.length,
      vmCount: clusterNodes.reduce((a, c) => a + c.vmCount, 0),
      children: clusterNodes,
    });
  }

  return {
    focus: { vcenterId: vcenterId || null, host: host || null },
    nodeCount,
    vcenters: (snap.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id })),
    tree,
    generatedAt: Date.now(),
  };
}
