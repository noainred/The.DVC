/**
 * periodic/readers/index.js — 항목 키 → 리더. 카탈로그(catalog.js ITEMS)의 키와 1:1(테스트가 대조 — 빠진 리더 · 남는 리더 0).
 */
import * as V from './vsphere.js';
import * as D from './devices.js';
import * as S from './services.js';
import * as F from './facility.js';

export const READERS = Object.freeze({
  'vc-reach': V.vcReach, 'host-state': V.hostState, 'ds-usage': V.dsUsage, 'snapshot-age': V.snapshotAge, 'vc-alarms': V.vcAlarms, 'vm-tools': V.vmTools,
  zombies: V.zombies, 'host-hygiene': V.hostHygiene, 'vm-hygiene': V.vmHygiene, 'cluster-check': V.clusterCheck, 'storage-paths': V.storagePaths,
  contention: V.contention, 'vm-count': V.vmCount, 'capacity-eta': V.capacityEta, compliance: V.compliance, 'license-expiry': V.licenseExpiry,
  'cert-expiry': V.certExpiry, 'core-license': V.coreLicense,
  'array-health': D.arrayHealth, 'storage-growth': D.storageGrowth, 'san-ports': D.sanPorts, 'san-monthly': D.sanMonthly, 'san-storage-perf': D.sanStoragePerf,
  'ps-inspect': D.psInspect, cvp: D.cvp, ipam: D.ipam, 'vm-dns': D.vmDns,
  svcmon: S.svcmon, veeam: S.veeam, bareos: S.bareos, unprotected: S.unprotected, 'vm-clone': S.vmClone, 'link-check': S.linkCheck, 'edge-fresh': S.edgeFresh,
  'xfer-speed': S.xferSpeed, relaycheck: S.relaycheck, 'portal-services': S.portalServices, 'portal-db': S.portalDb, 'login-fails': S.loginFails,
  horizon: S.horizon, 'capacity-advisor': S.capacityAdvisor,
  'part-faults': F.partFaults, 'disk-bad': F.diskBad, 'inlet-temp': F.inletTemp, pdu: F.pdu, power: F.power, 'bm-usage': F.bmUsage, 'bm-storage': F.bmStorage,
  gpu: F.gpu, 'isilon-dirusage': F.isilonDirusage, 'guest-partition': F.guestPartition, 'dir-usage': F.dirUsage, 'fleet-change': F.fleetChange,
});
