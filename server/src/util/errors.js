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

  // 2026-10-09 검토 S-01·S-02: 장비 신원 거부를 먼저 본다 — 문구의 주소·지문 조각이 '401/403' 로 읽혀 '인증 실패' 라고 말하면
  // 사용자가 멀쩡한 비밀번호를 고친다. 코드는 cause 사슬 어디에든 있을 수 있다(fetch failed → TlsPeerError).
  let peerCode = null;
  for (let e = err, i = 0; e && typeof e === 'object' && i < 6; e = e.cause, i += 1) {
    if (e.code === 'ERR_TLS_PEER_UNTRUSTED' || e.code === 'SSH_HOSTKEY_UNTRUSTED') { peerCode = e.code; break; }
  }
  if (!peerCode && test.includes('[SSH_HOSTKEY_UNTRUSTED]')) peerCode = 'SSH_HOSTKEY_UNTRUSTED';
  if (!peerCode && (test.includes('ERR_TLS_PEER_UNTRUSTED') || test.includes('장비 인증서를 신뢰할 수 없어 연결을 끊었습니다'))) peerCode = 'ERR_TLS_PEER_UNTRUSTED';
  if (peerCode) {
    // TLS 거부 문구(security/tlsTrust.js)는 지문·조치(승인·사설 CA)를 이미 담고 있어 힌트를 덧붙이지 않는다(rvI_tlsTrust ⑤ — 같은 말 두 번).
    // SSH 거부도 문구에 지문·조치가 있지만, 오래된 화면이 hint 만 그리는 곳이 있어 짧은 안내를 둔다 — '인증 실패' 글자를 넣지 않는다.
    return {
      message: full, code: code || peerCode,
      hint: peerCode === 'SSH_HOSTKEY_UNTRUSTED'
        ? '장비 SSH 호스트키가 승인되지 않아 비밀번호를 보내기 전에 끊었습니다 — 설정 › 장비 신뢰에서 지문을 별도 경로로 확인해 승인하세요(자격증명 거부가 아닙니다).'
        : null,
    };
  }

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
    // 2026-10-09 검토 S-02: 검증을 끄는 env 를 권하지 않는다 — 사설 CA 등록 또는 지문 승인이 조치다.
    hint = '인증서 오류 — 장비라면 사설 CA 를 CONFIG_DIR/tls-ca-bundle.pem 로 등록하거나 설정 › 장비 신뢰에서 지문을 승인하세요. 중앙↔엣지(수집 서버) HTTPS 는 장비 신뢰가 아니라 portal.env 의 WAN_TLS_CA_FILE(사설 CA)로 신뢰합니다 — WAN_TLS_INSECURE 로 검증을 끄지 마세요.';
  } else if (/ECONNRESET/i.test(test)) {
    hint = '연결이 재설정됨 — 네트워크/프록시/TLS 설정을 확인하세요.';
  } else if (/EHOSTUNREACH|ENETUNREACH/i.test(test)) {
    hint = '호스트/네트워크에 도달할 수 없음 — 라우팅/방화벽을 확인하세요.';
  }
  return { message: full, code, hint };
}
