/**
 * AD(LDAP) 인증 연결 보호 방식 — 화면 판정·문구(2026-10-09 검토 S-03). 서버 `auth/ad.js adTransportMode`·`adSaveIssue` 와 같은 규칙이다
 * (번들 경계라 두 벌 — 테스트가 규칙을 고정한다). 판정의 진실은 서버다(저장은 서버가 400 으로 거부한다) — 화면은 저장 전에 미리 말한다.
 */

/** 'ldaps' | 'starttls' | 'plain' | 'none' — URL 스킴 + StartTLS 표지. */
export function adModeOf(cfg) {
  const u = String(cfg?.url || '').trim().toLowerCase();
  if (u.startsWith('ldaps://')) return 'ldaps';
  if (u.startsWith('ldap://')) return cfg?.startTls === true ? 'starttls' : 'plain';
  return 'none';
}

export const AD_MODE_LABEL = {
  ldaps: 'LDAPS(처음부터 TLS)',
  starttls: 'StartTLS(연결 뒤 TLS 로 전환 — 실패하면 비밀번호를 보내지 않는다)',
  plain: '평문(암호화 없음)',
  none: 'URL 미입력',
};

/** 서버 경고 코드 → 문구(서버 adTransportStatus.warnings 와 1:1). */
export const AD_TRANSPORT_WARN = {
  'plain-ldap': '이 설정은 평문 ldap:// 로 사용자 비밀번호를 보냅니다. 이미 저장된 설정이라 동작은 유지되지만, URL 을 바꾸거나 다시 켜는 저장은 거부됩니다. ldaps://(636) 로 바꾸거나 StartTLS 를 켜세요.',
  'tls-verify-off': '인증서 검증이 꺼져 있습니다 — 가짜 서버가 비밀번호를 받을 수 있습니다. 사설 CA 인증서를 넣고 검증을 켜세요.',
  'ca-invalid': '저장된 CA 인증서를 읽지 못했습니다 — PEM 형식을 확인하세요.',
};

export function adWarningsText(codes) {
  return (Array.isArray(codes) ? codes : []).map((c) => AD_TRANSPORT_WARN[c] || `확인 필요(${c})`);
}

/**
 * 지금 폼으로 저장하면 서버가 평문이라 거부할지(서버 adSaveIssue 와 같은 조건 — 평문이고 URL·StartTLS 가 바뀌었거나 새로 켬).
 * @param {object} form 화면 값  @param {object|null} saved 마지막으로 서버에서 읽은 값
 */
export function plainSaveBlocked(form, saved) {
  if (adModeOf(form) !== 'plain') return false;
  if (!String(form?.url || '').trim()) return false;
  const s = saved || {};
  const urlChanged = String(form?.url || '').trim() !== String(s.url || '').trim();
  const tlsChanged = (form?.startTls === true) !== (s.startTls === true);
  const turnedOn = !!form?.enabled && !s.enabled;
  return urlChanged || tlsChanged || turnedOn;
}

export const PLAIN_SAVE_BLOCKED_TEXT = '평문 ldap:// 설정은 새로 저장할 수 없습니다 — URL 을 ldaps:// 로 바꾸거나 StartTLS 를 켜세요.';

/** 연결 테스트 실패 단계 → 문구. */
export const AD_TEST_STAGE = {
  config: '설정 오류',
  connect: '연결·TLS 단계',
  starttls: 'StartTLS 단계(비밀번호는 보내지 않았습니다)',
  bind: '로그인(bind) 단계',
  search: '그룹 조회 단계',
  policy: '정책상 보내지 않음',
};
