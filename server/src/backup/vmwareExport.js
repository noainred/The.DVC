/**
 * 사이트 VMware 솔루션 구성 백업 — 포탈이 수집한 인프라 구성(vCenter·ESXi 호스트·VM·
 * 데이터스토어·네트워크·NSX·알람)을 사이트(또는 전체) 단위로 구조화해 내보낸다.
 * vCenter 자체 백업(VAMI/Veeam)을 대체하지 않는 '구성 스냅샷(문서화/DR 참고/감사)'이다.
 */

import { store } from '../store.js';
import { nsxStore } from '../nsx/store.js';
import { currentVersion } from '../config.js';

// VM은 런타임 지표 대신 '구성' 필드만(파일 크기 절약).
const vmConfig = (v) => ({
  id: v.id, name: v.name, vcenterId: v.vcenterId, host: v.host, cluster: v.cluster, folder: v.folder,
  resourcePool: v.resourcePool, powerState: v.powerState, template: v.template, guestOS: v.guestOS,
  cpuCount: v.cpuCount, memMB: v.memMB, storageGB: v.storageGB, thin: v.thin,
  ipAddresses: v.ipAddresses, toolsStatus: v.toolsStatus, toolsVersion: v.toolsVersion,
  gpu: v.gpu || null, snapshotCount: v.snapshotCount, notes: v.notes, tags: v.tags,
});

const hostConfig = (h) => ({
  id: h.id, name: h.name, vcenterId: h.vcenterId, cluster: h.cluster,
  connectionState: h.connectionState, powerState: h.powerState,
  vendor: h.vendor, model: h.model, version: h.version, build: h.build,
  cpuCores: h.cpuCores, cpuThreads: h.cpuThreads, cpuTotalMhz: h.cpuTotalMhz, memTotalMB: h.memTotalMB,
  vmCount: h.vmCount, gpus: h.gpus || [], hbas: h.hbas || [], mgmtIp: h.mgmtIp, mgmtServerIp: h.mgmtServerIp,
});

export function buildVmwareConfigExport({ vcenterId = null } = {}) {
  const snap = store.get();
  const vcs = (snap.vcenters || []).filter((v) => !vcenterId || v.id === vcenterId);
  const ids = new Set(vcs.map((v) => v.id));

  const sites = vcs.map((v) => {
    const hosts = (snap.hosts || []).filter((h) => h.vcenterId === v.id);
    const vms = (snap.vms || []).filter((x) => x.vcenterId === v.id);
    const datastores = (snap.datastores || []).filter((d) => d.vcenterId === v.id);
    const networks = (snap.networks || []).filter((n) => n.vcenterId === v.id);
    const alarms = (snap.alarms || []).filter((a) => a.vcenterId === v.id);
    return {
      vcenter: { id: v.id, name: v.name, status: v.status, version: v.version, build: v.build, fullName: v.fullName, region: v.location?.region || v.region || '' },
      counts: { hosts: hosts.length, vms: vms.length, datastores: datastores.length, networks: networks.length, alarms: alarms.length },
      hosts: hosts.map(hostConfig),
      vms: vms.map(vmConfig),
      datastores: datastores.map((d) => ({ id: d.id, name: d.name, type: d.type, capacityGB: d.capacityGB, freeGB: d.freeGB, usagePct: d.usagePct })),
      networks: networks.map((n) => ({ id: n.id, name: n.name, type: n.type, vlan: n.vlan })),
      alarms: alarms.map((a) => ({ entity: a.entity, entityType: a.entityType, severity: a.severity, message: a.message })),
    };
  });

  // NSX(스코프 vCenter에 매핑된 매니저).
  const nsx = nsxStore.get();
  const mgrs = (nsx.managers || []).filter((m) => !vcenterId || m.vcenterId === vcenterId || ids.has(m.vcenterId));
  const mIds = new Set(mgrs.map((m) => m.id));
  const nsxOut = {
    managers: mgrs.map((m) => ({ id: m.id, name: m.name, host: m.host, version: m.version, status: m.status, vcenterId: m.vcenterId, region: m.region })),
    segments: (nsx.segments || []).filter((s) => mIds.has(s.managerId)),
    gateways: (nsx.gateways || []).filter((g) => mIds.has(g.managerId)),
    dfw: (nsx.dfw || []).filter((p) => mIds.has(p.managerId)),
  };

  return {
    meta: { kind: 'vmware-config-backup', portalVersion: currentVersion(), generatedAt: Date.now(), scope: vcenterId || 'all', sites: sites.length, source: snap.source },
    sites,
    nsx: nsxOut,
  };
}
