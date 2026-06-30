/**
 * Turn a thrown error (often a generic "fetch failed") into a human-readable
 * reason plus a Korean hint about the likely cause, for vCenter connection
 * diagnostics. Looks at the error message, its `cause` (undici wraps the real
 * network error there), and known error codes.
 */
export function describeError(err) {
  const msg = String(err?.message || err || 'unknown error');
  const causeMsg = err?.cause?.message ? String(err.cause.message) : '';
  const code = err?.cause?.code || err?.code || null;
  const full = causeMsg && causeMsg !== msg ? `${msg}: ${causeMsg}` : msg;
  const test = `${full} ${code || ''}`;

  let hint = null;
  if (/\b401\b|invalid credentials|incorrect user|cannot complete login|authentication|permission/i.test(test)) {
    hint = '인증 실패 — 계정/비밀번호 또는 권한을 확인하세요.';
  } else if (code === 'ENOTFOUND' || /ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(test)) {
    hint = 'DNS 조회 실패 — 호스트명/주소를 확인하세요 (DNS 또는 hosts).';
  } else if (code === 'ECONNREFUSED' || /ECONNREFUSED/i.test(test)) {
    hint = '연결 거부 — 포트(443)·vCenter 서비스·방화벽을 확인하세요.';
  } else if (/TIMEOUT|ETIMEDOUT|timed out|UND_ERR_CONNECT_TIMEOUT|aborted/i.test(test)) {
    hint = '연결 시간 초과 — telnet(TCP)은 되는데 여기서 막히면 중계(HAProxy) reload·방화벽 idle로 keep-alive 연결이 끊긴 경우가 많습니다(다음 주기에 새 연결로 자동 복구). 지속되면 네트워크 경로·중계 서버 상태를 확인하세요.';
  } else if (/CERT|SELF_SIGNED|self-signed|DEPTH_ZERO|UNABLE_TO_VERIFY|HOSTNAME/i.test(test)) {
    hint = '인증서 오류 — 자체서명 인증서면 VC_TLS_REJECT_UNAUTHORIZED=false 로 두세요.';
  } else if (/ECONNRESET/i.test(test)) {
    hint = '연결이 재설정됨 — 네트워크/프록시/TLS 설정을 확인하세요.';
  } else if (/EHOSTUNREACH|ENETUNREACH/i.test(test)) {
    hint = '호스트/네트워크에 도달할 수 없음 — 라우팅/방화벽을 확인하세요.';
  }
  return { message: full, code, hint };
}
