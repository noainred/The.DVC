/**
 * 권한 거부(403) 안내 문구 생성 — 순수 함수만 둔다(AccessDenied.jsx 가 렌더).
 *
 * 왜 분리했나: 사용자에게 실제로 보이는 것은 이 문구다(무엇이 필요한지·누구에게 어떻게 요청할지).
 * 웹 테스트 환경이 node(DOM 없음)라 컴포넌트는 렌더 테스트가 불가하므로, 판정·문구 로직을
 * 여기로 빼서 회귀 테스트로 고정한다.
 */

// 서버 권한 키(requirePerm) → 사람이 읽는 이름. 없는 키는 원문을 그대로 보여준다(추측 금지).
export const PERM_LABEL = {
  tools: '특수 기능(도구)',
  'vm.console': 'VM 콘솔 열기',
  'vm.reconfig': 'VM 사양 변경',
  'vm.power': 'VM 전원 제어',
  'vm.provision': 'VM 생성·복제',
  'host.power': '호스트 전원 제어',
  'remote.access': '원격 접속(RDP/SSH)',
  svcmon: '성능점검 관리',
  ipam: 'IP 관리',
  idrac: '서버 하드웨어(iDRAC)',
  nsx: 'NSX 네트워크',
  backup: '백업·복원',
  audit: '감사 로그',
};
export const ROLE_LABEL = { admin: '관리자(admin)', operator: '운영자(operator)', viewer: '조회자(viewer)' };

export const permName = (k) => PERM_LABEL[k] || String(k);
export const roleName = (r) => ROLE_LABEL[r] || String(r);

/**
 * 필요한 권한을 사람 문장으로 정리 → { kind, need, how }.
 *
 * 판정 순서가 중요하다: 설정 소유(owner)는 admin 보다 상위 경계라 가장 먼저 본다. 그 다음 역할,
 * 그 다음 기능 권한. 아무 메타데이터도 없는 403 은 대개 **데이터 범위(scope)** 제한이다
 * (서버가 `{ok:false, reason}` 만 주는 경로 — 그때는 서버 사유를 그대로 보여줘 추측하지 않는다).
 */
export function describePermission(info) {
  if (info?.requiredOwner) {
    return {
      kind: 'owner',
      need: '설정 소유 계정(settings owner)',
      how: '관리자(admin) 역할과 별개인 상위 권한입니다. 서버의 설정 소유 계정 목록에 이 계정의 '
         + '로그인 ID 가 등록되어야 합니다.',
    };
  }
  if (info?.requiredRole?.length) {
    return {
      kind: 'role',
      need: `${info.requiredRole.map(roleName).join(' 또는 ')} 역할`,
      how: '설정 › 사용자 관리에서 계정 역할을 변경해야 합니다.',
    };
  }
  if (info?.requiredPerm?.length) {
    return {
      kind: 'perm',
      need: `${info.requiredPerm.map(permName).join(' 또는 ')} 권한`,
      how: '설정 › 기능 권한 매트릭스에서 이 역할에 해당 권한을 켜야 합니다.',
    };
  }
  return {
    kind: 'scope',
    need: '이 데이터에 대한 접근 범위',
    how: '계정에 지정된 조회/수정 가능 vCenter·리전 범위 밖입니다. 범위 확대가 필요하면 관리자에게 요청하세요.',
  };
}

/**
 * 관리자에게 그대로 전달할 요청 문구 — '무엇을 열어줘야 하는지'가 담겨야 왕복이 줄어든다.
 * 비밀·토큰은 담지 않는다(서버 사유 문구만 인용).
 */
export function buildRequestText({ user, info, reason } = {}) {
  const d = describePermission(info);
  const lines = [
    '[포탈 권한 요청]',
    `계정: ${user?.username || '(알 수 없음)'}${user?.role ? ` / 현재 역할: ${roleName(user.role)}` : ''}`,
    `필요: ${d.need}`,
    `조치: ${d.how}`,
  ];
  if (info?.path) lines.push(`요청 경로: ${info.path}`);
  if (reason) lines.push(`서버 사유: ${reason}`);
  return lines.join('\n');
}
