/**
 * auth/toolAccess.js — 특수 기능 '도구별 접근'(toolsDenied) 의 **서버 집행** (v2.447, 감사 S2).
 *
 * 문제: 관리자가 '설정 › 사용자 관리 › 특수 기능 도구별 접근' 에서 도구를 거부해도 그 목록은
 * 프론트(`web/src/api.js toolAllowed`)에서만 쓰였다. 서버에는 참조 코드가 한 줄도 없어
 * curl 로 `/api/tools/<도구>` 를 직접 부르면 그대로 200 이 나왔다 — 관리자는 화면에서
 * '차단됨' 을 보고 통제가 걸린 줄 오인한다(무음 실패). server/CLAUDE.md 의
 * "기능 권한은 서버가 진실의 원천, 프론트는 UX 게이팅일 뿐" 을 정면으로 위반한 상태였다.
 *
 * 설계(가용성 우선):
 *  · 경로 첫 세그먼트 → 도구 키 매핑에 **확실한 것만** 등재한다. 매핑에 없는 경로는 통과시킨다 —
 *    잘못된 매핑으로 정상 사용자를 막는 쪽이 더 큰 사고다(모르면 막지 않는다).
 *  · 확장자(.csv/.json/.xlsx)는 떼고 매칭한다(`/tools/ipam.csv` = ipam).
 *  · admin 은 항상 통과(roleToolsDenied 가 admin 에 빈 배열을 준다).
 *  · 거부 응답은 기존 403 형태를 유지한다 — 프론트 ErrorBox 가 AccessDenied 로 자동 전환하려면
 *    `{error:'forbidden', requiredPerm}` 계약이 필요하다(CLAUDE.md 프론트 규칙).
 */
import { roleToolsDenied } from './permissions.js';

/**
 * 라우트 경로 첫 세그먼트 → 프론트 도구 키(`web/src/views/specialToolsList.js` 의 k).
 * 이름이 다른 것만 주의: deep-search→deepsearch, duplicate-ips→dupip, esxi-temp→esxitemp,
 * guest-os→guestos, network-check→net-check, rightsize→rightsizing, sanswitch→san-switch,
 * storage→storage-mon, thin-vms→thinvms, vm-finder→vmfinder.
 * 의도적 제외(도구 화면 전용이 아니거나 키가 불분명): ip-ping(VM 상세에서 사용), report,
 * service-check, vclogs, vmware-config.
 */
export const TOOL_PATH_KEYS = Object.freeze({
  'bm-storage': 'bm-storage',
  capacity: 'capacity',
  'capacity-forecast': 'capacity-forecast',
  credentials: 'credentials',
  'deep-search': 'deepsearch',
  'duplicate-ips': 'dupip',
  esxi: 'esxi',
  'esxi-temp': 'esxitemp',
  gpu: 'gpu',
  'guest-disk': 'guest-disk',
  'guest-os': 'guestos',
  hardware: 'hardware',
  hba: 'hba',
  insights: 'insights',
  ipam: 'ipam',
  'license-expiry': 'license-expiry',
  licenses: 'licenses',
  'network-check': 'net-check',
  pdu: 'pdu',
  relaycheck: 'relaycheck',
  relaytopo: 'relaytopo',
  rightsize: 'rightsizing',
  rma: 'rma',
  sanswitch: 'san-switch',
  'secret-scan': 'secret-scan',
  'serial-lookup': 'serial-lookup',
  snapshots: 'snapshots',
  solutions: 'solutions',
  storage: 'storage-mon',
  'thin-vms': 'thinvms',
  threats: 'threats',
  'vm-clone': 'vm-clone',
  'vm-export': 'vm-export',
  'vm-finder': 'vmfinder',
  'vm-track': 'vm-track',
  vmtools: 'vmtools',
  waste: 'waste',
});

/** `/ipam.csv?x=1` · `ipam/settings` → 'ipam'. 매핑에 없으면 null(= 검사 안 함). */
export function toolKeyForPath(pathname) {
  const first = String(pathname || '').replace(/^\/+/, '').split(/[/?#]/)[0];
  if (!first) return null;
  const base = first.replace(/\.(csv|json|xlsx|xls|txt)$/i, '');   // 내보내기 확장자 제거
  return TOOL_PATH_KEYS[base] || null;
}

/**
 * 이 역할이 이 경로를 쓸 수 있는가. 거부면 사유 객체, 허용이면 null.
 * @param {string} role  req.user.role (인증 비활성 환경은 호출부가 대체 역할을 넘긴다)
 * @param {string} pathname  `/tools` 하위 경로(예: '/ipam.csv')
 */
export function toolAccessIssue(role, pathname) {
  if (role === 'admin') return null;
  const key = toolKeyForPath(pathname);
  if (!key) return null;                       // 매핑 없는 경로는 이 게이트의 대상이 아니다
  const denied = roleToolsDenied(role);
  if (!denied.includes(key)) return null;
  return { tool: key, reason: `이 기능(${key})에 대한 접근이 관리자 설정으로 차단되어 있습니다.` };
}
