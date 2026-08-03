/**
 * IP 레저 행 스키마 — 컬럼 순서와 행 변환을 한 곳에 둔다.
 *
 * 메인 스레드(db.js)와 쓰기 워커(writeWorker.js)가 **같은 정의**를 써야 한다. 두 곳에
 * 복사해 두면 컬럼을 하나 추가한 날 워커 쪽 INSERT 만 어긋나 조용히 값이 밀린다.
 * 이 모듈은 순수 함수만 담는다(DB·네트워크 무접촉) — 워커가 가볍게 로드할 수 있게.
 */

export const COLUMNS = ['ip', 'ip_num', 'vcenter_id', 'vcenter_name', 'owner_type', 'server_type', 'owner_name',
  'power_state', 'guest_os', 'os_name', 'os_version', 'host_name', 'cluster', 'scope', 'multi_homed', 'duplicate', 'updated_at',
  // 출처 대조 + 수동 관리(override) + 대역정책 노출 — 외부 프로그램이 vCenter/스캔/수동/정책을 구분하고 관리상태를 읽을 수 있게.
  'discovery', 'reconcile', 'mgmt_status', 'mgmt_owner', 'label', 'device_type', 'first_seen', 'last_seen', 'usage_status',
  'applied_by', 'range_policy_spec'];

export function toRecord(r, updatedAt) {
  return [r.ip, r.ipNum ?? null, r.vcenterId, r.vcenterName, r.ownerType, r.serverType || (r.ownerType === 'host' ? 'BareMetal' : 'VM'), r.ownerName,
    r.powerState || '', r.guestOS || '', r.osName || '', r.osVersion || '', r.hostName || '', r.cluster || '', r.scope || '',
    r.multiHomed ? 1 : 0, r.duplicate ? 1 : 0, updatedAt,
    r.discovery || '', r.reconcile || '', r.mgmtStatus || '', r.owner_ || '', r.label || '', r.deviceType || '',
    r.firstSeen ? new Date(r.firstSeen).toISOString() : '', r.lastSeen ? new Date(r.lastSeen).toISOString() : '', r.usageStatus || '',
    r.appliedBy || '', r.rangePolicySpec || ''];
}
