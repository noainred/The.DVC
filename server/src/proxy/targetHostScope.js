/**
 * 원격 접속 대상 호스트의 사용자 범위(scope) 판정 — 순수 함수(v2.579 에 `routes/remote.js` 에서 분리).
 *
 * 왜 옮겼나(ARCH-05): `proxy/sshGateway.js`(WS 게이트웨이 도메인)가 이 함수를 **라우트 파일**에서
 * 가져다 쓰면서 도메인 → routes 방향 의존이 생겼다(주석은 "런타임 호출이라 순환 안전" 이라 적고
 * 있었지만, 안전한 이유가 '호출 시점' 하나에 걸려 있는 구조는 v2.566 TDZ 사고와 같은 유형이다).
 * 라우트와 게이트웨이가 **같은 판정**을 써야 하므로 둘 다 이 파일을 import 한다. `routes/remote.js` 는
 * 같은 이름을 재수출한다(테스트 `nsxRemoteScope` 가 그 경로로 가져간다). 본문은 원본 그대로다.
 */
/**
 * targetHost 의 사용자 scope 검사(v2.320, 2026-08-13 감사 보류 갭 적용 — 순수, 테스트 고정).
 * 범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM 의 IP/이름 또는 호스트 이름)만
 * 프로브/터널 생성 가능 — 임의 사내 IP 도달성 스캔(정찰)·범위 밖 피벗 준비를 차단한다.
 * 인벤토리에 없는 대상은 범위 계정에겐 거부('vCenter 귀속 없는 데이터 미노출' 규칙과 동일 취지).
 * 전체 범위 계정(allowed=null)은 기존 신뢰 모델 유지(임의 대상 허용 — 변화 없음).
 * @returns {string|null} 거부 사유(존재 여부를 흘리지 않는 일반 문구) 또는 null(허용)
 */
export function targetHostScopeIssue(snap, allowedSet, targetHost) {
  if (!allowedSet) return null;
  const t = String(targetHost || '').toLowerCase();
  for (const vm of snap.vms || []) {
    if (!allowedSet.has(vm.vcenterId)) continue;
    const ips = vm.ipAddresses?.length ? vm.ipAddresses : (vm.ipAddress ? [vm.ipAddress] : []);
    if (ips.some((ip) => String(ip).toLowerCase() === t) || String(vm.name || '').toLowerCase() === t) return null;
  }
  for (const h of snap.hosts || []) {
    if (!allowedSet.has(h.vcenterId)) continue;
    if (String(h.name || '').toLowerCase() === t) return null; // 호스트 name 은 통상 FQDN/IP
  }
  return '범위 내 vCenter 의 VM/호스트(IP·이름)만 대상으로 할 수 있습니다.';
}
