/**
 * views/vcd/objTabs.js — VM · ESXi 호스트 '개체 보기' 의 탭과 묶음(v2.896 — 승인 시안 ⑧~⑪ · 기본값 8~10).
 * 순수 모듈(vitest 고정). 화면은 vcd/VmObject.jsx · HostObject.jsx · ObjectShell.jsx.
 *  - 새 수집 없음: /vms · /hosts 한 행 + 캐시(vmcfg cfg·dev · hcfg · perfc) + 온디맨드(메트릭 · 파티션 · 이벤트)만.
 *  - 수집하지 않는 것(네트워크 어댑터 장치 · 포트그룹 · 권한 목록 · 스냅샷 트리 · 리소스 풀 속성 · 호스트별 DS 마운트 · vLCM)은 탭을 숨기지 않고 '수집하지 않음 · 2차'.
 */
import { numOrNull } from '../../numOrNull.js';

export const VM_OBJ_TABS = Object.freeze([
  { k: 'summary', label: '요약' },
  { k: 'monitor', label: '모니터' },
  { k: 'configure', label: '구성' },
  { k: 'perms', label: '사용 권한' },
  { k: 'datastores', label: '데이터스토어' },
  { k: 'network', label: '네트워크' },
  { k: 'snapshots', label: '스냅샷' },
  { k: 'updates', label: '업데이트' },
]);

export const HOST_OBJ_TABS = Object.freeze([
  { k: 'summary', label: '요약' },
  { k: 'monitor', label: '모니터' },
  { k: 'configure', label: '구성' },
  { k: 'perms', label: '사용 권한' },
  { k: 'vms', label: 'VM' },
  { k: 'pools', label: '리소스 풀' },
  { k: 'datastores', label: '데이터스토어' },
  { k: 'network', label: '네트워크' },
  { k: 'updates', label: '업데이트' },
]);

/** 개체 종류별 탭 목록 · 모르는 탭 키는 요약으로. */
export function objTabsOf(type) { return type === 'host' ? HOST_OBJ_TABS : VM_OBJ_TABS; }
export function normObjTab(type, k) {
  return objTabsOf(type).some((t) => t.k === k) ? k : 'summary';
}

/**
 * VM 의 디스크별 데이터스토어(vmcfg dev.disks) + 그 데이터스토어의 사용률(/datastores).
 * dev 를 아직 읽지 않았으면 null(빈 배열 '디스크 없음' 과 다르다).
 */
export function vmDiskRows(vm, datastores) {
  const disks = Array.isArray(vm?.dev?.disks) ? vm.dev.disks : null;
  if (!disks) return null;
  const byName = new Map((Array.isArray(datastores) ? datastores : []).map((d) => [d?.name, d]));
  return disks.filter((d) => d && typeof d === 'object').map((d) => {
    const ds = d.datastore ? byName.get(d.datastore) : null;
    return {
      label: d.label || '—',
      capacityGB: numOrNull(d.capacityGB),
      mode: d.mode || '',
      sharing: d.sharing || '',
      rdm: d.rdm === true,
      rdmMode: d.rdmMode || '',
      datastore: d.datastore || '',
      dsUsagePct: ds ? numOrNull(ds.usagePct) : null,
      dsType: ds ? (ds.type || '') : '',
      dsKnown: !!ds,
    };
  });
}

/** 디스크 행 → 데이터스토어별 묶음(이 VM 의 디스크 개수 · 용량 합). 용량을 못 읽은 디스크는 합에서 빼고 센다. */
export function vmDatastoreRows(diskRows) {
  if (!Array.isArray(diskRows)) return null;
  const m = new Map();
  for (const d of diskRows) {
    const k = d.datastore || '';
    const e = m.get(k) || { datastore: k, disks: 0, capacityGB: 0, capKnown: 0, dsUsagePct: d.dsUsagePct, dsType: d.dsType, dsKnown: d.dsKnown };
    e.disks++;
    if (d.capacityGB != null) { e.capacityGB += d.capacityGB; e.capKnown++; }
    m.set(k, e);
  }
  return [...m.values()].map((e) => ({ ...e, capacityGB: e.capKnown ? e.capacityGB : null }));
}

/** 이 호스트 위 VM 목록(이름 대조 — 수집기가 VM 행에 호스트 이름을 싣는다). */
export function vmsOnHost(vms, host) {
  if (!host?.name) return [];
  return (Array.isArray(vms) ? vms : []).filter((v) => v && v.host === host.name && v.vcenterId === host.vcenterId);
}

/** 리소스 풀 탭 — VM 의 resourcePool 이름으로 묶은 합(풀 자체 속성은 수집하지 않는다). 이름이 없으면 '—' 묶음. */
export function resourcePoolRows(vms) {
  const m = new Map();
  for (const v of Array.isArray(vms) ? vms : []) {
    if (!v) continue;
    const k = v.resourcePool || '';
    const e = m.get(k) || { pool: k, vms: 0, on: 0, vcpu: 0, memMB: 0 };
    e.vms++;
    if (v.powerState === 'POWERED_ON') e.on++;
    e.vcpu += numOrNull(v.cpuCount) ?? 0;
    e.memMB += numOrNull(v.memMB) ?? 0;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.vms - a.vms || a.pool.localeCompare(b.pool));
}

/**
 * 호스트 데이터스토어 탭 — 호스트별 마운트 목록은 수집하지 않는다. 대신 '이 호스트 VM 의 디스크가 놓인 데이터스토어' 를 VM dev 로 역산한다.
 * dev 를 아직 읽지 않은 VM 수를 따로 센다(그 VM 의 데이터스토어는 이 목록에 빠질 수 있다).
 */
export function hostDatastoresFromVms(vms, datastores) {
  const byName = new Map((Array.isArray(datastores) ? datastores : []).map((d) => [d?.name, d]));
  const m = new Map();
  let unread = 0;
  for (const v of Array.isArray(vms) ? vms : []) {
    const disks = Array.isArray(v?.dev?.disks) ? v.dev.disks : null;
    if (!disks) { unread++; continue; }
    for (const d of disks) {
      if (!d?.datastore) continue;
      const e = m.get(d.datastore) || { datastore: d.datastore, vms: new Set(), disks: 0, ds: byName.get(d.datastore) || null };
      e.vms.add(v.id); e.disks++;
      m.set(d.datastore, e);
    }
  }
  const rows = [...m.values()].map((e) => ({
    datastore: e.datastore, vms: e.vms.size, disks: e.disks,
    usagePct: e.ds ? numOrNull(e.ds.usagePct) : null, type: e.ds?.type || '', capacityGB: e.ds ? numOrNull(e.ds.capacityGB) : null,
  })).sort((a, b) => b.vms - a.vms || a.datastore.localeCompare(b.datastore));
  return { rows, unread };
}

/** 같은 vCenter 안에서 이 호스트와 같은 ESXi 빌드인 호스트 수(버전을 못 읽었으면 null). */
export function sameBuildCount(hosts, host) {
  if (!host?.version) return null;
  const list = Array.isArray(hosts) ? hosts : [];
  return { same: list.filter((h) => h.version === host.version && (h.build || '') === (host.build || '')).length, total: list.length };
}

/** VM 스냅샷 사실 — 개수 · 크기 · 가장 오래된 것(일) · 이름 · 고아 델타. 못 읽은 값은 null. */
export function vmSnapshotFacts(vm, now = Date.now()) {
  const count = numOrNull(vm?.snapshotCount);
  const oldest = numOrNull(vm?.snapshotOldestTs);
  return {
    count,
    sizeGB: numOrNull(vm?.snapshotSizeGB),
    oldestTs: oldest,
    oldestDays: oldest != null && oldest > 0 ? Math.max(0, Math.floor((now - oldest) / 86_400_000)) : null,
    names: Array.isArray(vm?.snapshotNames) ? vm.snapshotNames.filter((x) => typeof x === 'string').slice(0, 20) : [],
    orphanDeltaGB: numOrNull(vm?.orphanDeltaGB),
  };
}

/** VMware Tools 버전 상태 문구(vSphere toolsVersionStatus2). 모르는 값은 원문. */
export const TOOLS_STATUS_TEXT = Object.freeze({
  guestToolsCurrent: ['green', '최신'],
  guestToolsNeedUpgrade: ['amber', '업그레이드 가능'],
  guestToolsSupportedOld: ['amber', '오래됨(지원)'],
  guestToolsSupportedNew: ['blue', '호스트보다 새 판'],
  guestToolsTooOld: ['red', '너무 오래됨'],
  guestToolsTooNew: ['red', '너무 새 판'],
  guestToolsBlacklisted: ['red', '사용 금지 판'],
  guestToolsUnmanaged: ['gray', '게스트가 관리(OVT 등)'],
  guestToolsNotInstalled: ['red', '설치 안 됨'],
});
export function toolsStatusBadge(s) {
  if (!s) return ['gray', '—'];
  return TOOLS_STATUS_TEXT[s] || ['gray', String(s).slice(0, 40)];
}
