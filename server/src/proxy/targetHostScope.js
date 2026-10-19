/**
 * 원격 접속 대상 호스트의 사용자 범위(scope) 판정 — 순수 함수(v2.579 에 `routes/remote.js` 에서 분리).
 *
 * 왜 옮겼나(ARCH-05): `proxy/sshGateway.js`(WS 게이트웨이 도메인)가 이 함수를 **라우트 파일**에서
 * 가져다 쓰면서 도메인 → routes 방향 의존이 생겼다(주석은 "런타임 호출이라 순환 안전" 이라 적고
 * 있었지만, 안전한 이유가 '호출 시점' 하나에 걸려 있는 구조는 v2.566 TDZ 사고와 같은 유형이다).
 * 라우트와 게이트웨이가 **같은 판정**을 써야 하므로 둘 다 이 파일을 import 한다. `routes/remote.js` 는
 * 같은 이름을 재수출한다(테스트 `nsxRemoteScope` 가 그 경로로 가져간다).
 */
// v2.744(최종 검토 RF-R1): 호스트의 IP 는 IP 대장과 같은 판정(hostLedgerIp — 이름이 IP 면 그 이름, 아니면 정규형 관리 IP)을 쓴다.
//   복제 금지 — 대장이 '이 호스트의 IP' 라고 보여 주는 값과 원격 접속이 '그 호스트' 로 인정하는 값이 갈라지지 않게.
import { hostLedgerIp } from '../ipam/ledger.js';
import { ipToNum } from '../util/ipv4.js';

const SCOPE_REASON = '범위 내 vCenter 의 VM/호스트(IP·이름)만 대상으로 할 수 있습니다.';

const vmIpsOf = (vm) => (vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []));

/**
 * 범위 밖 객체(허용되지 않은 vCenter 의 VM·호스트, vCenter 귀속 없는 호스트)가 같은 IP 를 갖고 있는가 — 숫자로 비교한다
 * (느슨한 표기 '10.20.0.044' 도 같은 IP 로 본다 — 넓게 잡을수록 안전한 쪽이다).
 */
function claimedOutsideScope(snap, allowedSet, n) {
  const same = (v) => { const x = ipToNum(String(v ?? '')); return x != null && x === n; };
  for (const vm of snap.vms || []) {
    if (allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some(same)) return true;
  }
  for (const h of snap.hosts || []) {
    if (allowedSet.has(h.vcenterId)) continue;
    if (same(h.name)) return true;
    const hip = hostLedgerIp(h);
    if (hip && hip.n === n) return true;
  }
  return false;
}

/**
 * targetHost 의 사용자 scope 검사(v2.320, 2026-08-13 감사 보류 갭 적용 — 순수, 테스트 고정).
 * 범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM 의 IP/이름 또는 호스트 이름·원장 IP)만
 * 프로브/터널 생성 가능 — 임의 사내 IP 도달성 스캔(정찰)·범위 밖 피벗 준비를 차단한다.
 * 인벤토리에 없는 대상은 범위 계정에겐 거부('vCenter 귀속 없는 데이터 미노출' 규칙과 동일 취지).
 * 전체 범위 계정(allowed=null)은 기존 신뢰 모델 유지(임의 대상 허용 — 변화 없음).
 *
 * v2.744(최종 검토 RF-R1 — 재현): 이름(FQDN)으로 등록된 ESXi 의 IP 대장 행 IP 는 관리 IP 다(hostLedgerIp). 예전에는 호스트를
 *   이름으로만 대조해, 범위 안 호스트를 그 행의 IP 로 원격 접속하면 403 이었다(화면은 '도달 불가 — 방화벽/포트 확인' 으로 안내).
 *   이제 허용 vCenter 호스트의 원장 IP 도 그 호스트로 인정한다. 넓히는 쪽이므로 경계를 함께 둔다 —
 *   · 관리 IP 가 비정규 표기·0.0.0.0 이면 hostLedgerIp 가 null 을 준다(인정하지 않는다 — 8진 해석 위험).
 *   · 대상 문자열은 원장 IP(정규형)와 **글자 그대로 같을 때만** 맞는다 — '10.20.0.011' 같은 비정규 표기는 같은 IP 로 보지 않는다.
 *   · 같은 IP 를 범위 밖 객체도 갖고 있으면 이 규칙으로는 인정하지 않는다(그 IP 가 실제로 어느 장비인지 알 수 없다 — 안전한 쪽).
 *   기존 규칙(VM IP·VM 이름·호스트 이름)은 예전 그대로다.
 * @returns {string|null} 거부 사유(존재 여부를 흘리지 않는 일반 문구) 또는 null(허용)
 */
export function targetHostScopeIssue(snap, allowedSet, targetHost) {
  if (!allowedSet) return null;
  const t = String(targetHost || '').toLowerCase();
  for (const vm of snap.vms || []) {
    if (!allowedSet.has(vm.vcenterId)) continue;
    if (vmIpsOf(vm).some((ip) => String(ip).toLowerCase() === t) || String(vm.name || '').toLowerCase() === t) return null;
  }
  let ledgerHit = null;
  for (const h of snap.hosts || []) {
    if (!allowedSet.has(h.vcenterId)) continue;
    if (String(h.name || '').toLowerCase() === t) return null; // 호스트 name 은 통상 FQDN/IP
    if (ledgerHit == null) { const hip = hostLedgerIp(h); if (hip && hip.ip === t) ledgerHit = hip.n; }
  }
  if (ledgerHit != null && !claimedOutsideScope(snap, allowedSet, ledgerHit)) return null;
  return SCOPE_REASON;
}
