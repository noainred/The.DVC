/**
 * 토폴로지·의존성 맵 — 스냅샷에서 vCenter → 클러스터 → 호스트 → VM 계층 트리를 구성한다.
 * 장애 영향 범위 파악용. 30개 vCenter·대량 VM을 고려해 VM은 vCenter focus 시에만 펼치고,
 * 그 외에는 호스트별 VM 개수만 집계해 O(N)·작은 페이로드를 유지한다.
 */

import { numOrNull } from '../util/numOrNull.js';
import { usageReadable } from '../store.js';
import { clusterIndex, clusterLabelOf } from '../clustercfg/analyze.js'; // v2.744(감사 VC-02): 클러스터 묶음 키·이름 한 벌(ref 우선)

const num = (x) => (Number.isFinite(x) ? x : 0);
// v2.632 WEB2632-03: 사용률은 '못 읽음' 을 0 으로 채우지 않는다. 끊긴·무응답 호스트는 사용량을 읽을 수 없으므로
// (store.usageReadable — 사용률 기준 단일 소스) null 이고, VM·호스트의 결측 값도 null 이다(화면 '—').
const pctOrNull = (x) => numOrNull(x);

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
  // 노드 내역(노드 합이 호스트 수로 오해되지 않게 분해해서 노출): vCenter+클러스터+호스트(+focus 시 VM).
  const counts = { vcenters: 0, clusters: 0, hosts: 0, vms: 0 };
  // v2.744(감사 VC-02): 클러스터 노드는 (vCenter, 클러스터 moref) 로 묶는다 — 이름으로 묶으면 다른 데이터센터의 같은 이름 클러스터 호스트가
  //   한 노드에 섞여 장애 영향 범위가 틀렸다. 같은 이름이 둘 이상이면 라벨에 데이터센터를 붙인다(clusterLabelOf). 클러스터에 속하지 않은
  //   호스트('standalone'·소속 미상)는 예전처럼 이름 그대로 묶는다.
  const cidx = clusterIndex(snap.hosts || []);
  for (const v of vcs) {
    const hs = hostsByVc.get(v.id) || [];
    const clusters = new Map();   // 묶음 키 → { cl(이름), gk(clusterIndex 키 또는 null), hosts }
    for (const h of hs) {
      const cl = h.cluster || '(standalone)';
      const gk = cidx.keyOf(h);
      const k = gk ?? `n:${cl}`;
      if (!clusters.has(k)) clusters.set(k, { cl, gk, hosts: [] });
      clusters.get(k).hosts.push(h);
    }
    const clusterNodes = [...clusters.values()].map(({ cl, gk, hosts: chosts }) => {
      const meta = cidx.meta(gk);
      const hostNodes = chosts.map((h) => {
        const vms = vmsByHost.get(`${v.id}|${h.name}`) || [];
        const on = vms.filter((x) => x.powerState === 'POWERED_ON').length;
        const node = {
          id: h.id, type: 'host', label: h.name,
          state: h.connectionState, power: h.powerState,
          cpuPct: usageReadable(h) ? pctOrNull(h.cpuUsagePct) : null,
          memPct: usageReadable(h) ? pctOrNull(h.memUsagePct) : null,
          watts: num(h.powerWatts), gpus: (h.gpus || []).length,
          vmCount: vms.length, vmOn: on,
          children: [],
        };
        // focus(특정 vCenter)일 때만 개별 VM 펼침 — 호스트당 상위 200개로 제한.
        if (vcenterId && (!host || host === h.name || host === h.id)) {
          node.children = vms.slice(0, 200).map((vm) => ({
            id: vm.id, type: 'vm', label: vm.name, power: vm.powerState,
            cpuPct: pctOrNull(vm.cpuUsagePct), memPct: pctOrNull(vm.memUsagePct),
            guestOS: vm.guestOS, gpu: vm.gpu ? (vm.gpu.mode || 'gpu') : null, ip: vm.ipAddress || (vm.ipAddresses || [])[0] || '',
          }));
          nodeCount += node.children.length;
          counts.vms += node.children.length;
        }
        nodeCount++;
        counts.hosts++;
        return node;
      }).sort((a, b) => b.vmCount - a.vmCount);
      nodeCount++;
      counts.clusters++;
      // 노드 id: ref 로 묶은 클러스터는 ref(같은 이름 두 노드가 같은 id 를 갖지 않게), 그 밖은 예전 id 그대로.
      return {
        id: meta.clusterRef ? `${v.id}|cluster|r:${meta.clusterRef}` : `${v.id}|cluster|${cl}`, type: 'cluster',
        label: gk ? clusterLabelOf({ name: cl, ...meta }) : cl,
        clusterRef: meta.clusterRef, vcDatacenter: meta.vcDatacenter, sameName: meta.sameName,
        hosts: hostNodes.length, vmCount: hostNodes.reduce((a, h) => a + h.vmCount, 0),
        children: hostNodes,
      };
    }).sort((a, b) => b.vmCount - a.vmCount);
    nodeCount++;
    counts.vcenters++;
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
    counts, // { vcenters, clusters, hosts, vms } — '노드 N'의 구성 내역
    vcenters: (snap.vcenters || []).map((v) => ({ id: v.id, name: v.name || v.id })),
    tree,
    generatedAt: Date.now(),
  };
}
