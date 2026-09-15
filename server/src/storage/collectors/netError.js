/**
 * storage/collectors/netError.js — 네트워크 실패 → **행동 가능한 사유**(순수, v2.513).
 *
 * 사용자 신고(2026-09-15): 한 법인의 PowerStore 만 전 섹션이 `fetch failed` 로 뜨고
 * 상단에는 `This operation was aborted` 만 보였다. 둘 다 **무엇을 확인해야 하는지 말해 주지 않는다** —
 * 방화벽인지, 포트가 닫힌 건지, 인증서 문제인지, 장비가 죽은 건지 구분이 안 된다.
 *
 * ## 왜 원문이 쓸모없는가
 *
 * undici 의 `fetch()` 는 전송 계층이 실패하면 **항상 `TypeError: fetch failed`** 를 던지고
 * 진짜 원인은 `err.cause`(`ECONNREFUSED`·`ETIMEDOUT`·`CERT_HAS_EXPIRED` …)에 넣는다.
 * 수집기는 `e.message` 만 섹션 오류에 담았기 때문에 그 `cause` 가 통째로 버려졌다.
 * `AbortSignal.timeout` 도 `TimeoutError: The operation was aborted` 라 '누가 왜 끊었는지' 가 없다.
 *
 * 이 모듈은 **원인 코드를 사람이 읽는 한 줄 + 확인 항목**으로 바꾸되, 원문 코드는 괄호로 남긴다
 * (지어내지 않고, 근거를 지우지도 않는다 — CLAUDE.md 정직 원칙).
 */

/** 오류 사슬(cause)을 따라가며 첫 번째 syscall 코드를 찾는다. undici 는 2~3단 중첩이 흔하다. */
export function errorCode(err) {
  for (let e = err, i = 0; e && i < 5; e = e.cause, i += 1) {
    const c = e.code || e.errno;
    if (typeof c === 'string' && c) return c;
  }
  return '';
}

/** 사슬 전체의 메시지를 모아 합친다(문자열 매칭용). */
export function errorText(err) {
  const parts = [];
  for (let e = err, i = 0; e && i < 5; e = e.cause, i += 1) {
    if (e.name) parts.push(String(e.name));
    if (e.message) parts.push(String(e.message));
  }
  return parts.join(' ');
}

/** 코드 → { 사유, 확인할 것 }. 여기 없는 코드는 원문을 그대로 쓴다(추측 금지). */
const BY_CODE = {
  ECONNREFUSED: ['연결이 거부되었습니다', '장비에서 그 포트가 열려 있는지 · 관리 서비스가 떠 있는지 확인'],
  ETIMEDOUT: ['응답이 없습니다(연결 시간 초과)', '방화벽·ACL 로 막혀 있거나 경로가 없을 때 이렇게 됩니다'],
  EHOSTUNREACH: ['호스트에 도달할 수 없습니다', '수집 서버(엣지)에서 그 대역으로 라우팅이 되는지 확인'],
  ENETUNREACH: ['네트워크에 도달할 수 없습니다', '수집 서버의 라우팅·게이트웨이 확인'],
  ECONNRESET: ['연결이 끊겼습니다', '장비/중간 방화벽이 세션을 끊었을 수 있습니다'],
  EPIPE: ['연결이 끊겼습니다', '장비/중간 방화벽이 세션을 끊었을 수 있습니다'],
  ENOTFOUND: ['호스트 이름을 찾을 수 없습니다', 'DNS 또는 등록한 호스트명 확인(IP 로 등록 권장)'],
  EAI_AGAIN: ['이름 해석에 실패했습니다', '수집 서버의 DNS 설정 확인'],
  EPROTO: ['TLS 협상에 실패했습니다', 'HTTPS 포트가 맞는지 확인(HTTP 포트에 HTTPS 로 접속하면 이렇게 됩니다)'],
  ERR_TLS_CERT_ALTNAME_INVALID: ['인증서의 호스트명이 접속 주소와 다릅니다', 'STORAGE_TLS_VERIFY 를 끄거나 인증서를 교체'],
  CERT_HAS_EXPIRED: ['장비 인증서가 만료되었습니다', '인증서 갱신 또는 STORAGE_TLS_VERIFY 해제'],
  DEPTH_ZERO_SELF_SIGNED_CERT: ['자체서명 인증서가 거부되었습니다', 'STORAGE_TLS_VERIFY=true 로 켜져 있다면 사설 CA 등록 필요'],
  SELF_SIGNED_CERT_IN_CHAIN: ['인증서 체인에 자체서명이 있습니다', '사설 CA 를 신뢰 목록에 등록하거나 STORAGE_TLS_VERIFY 해제'],
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: ['인증서를 검증할 수 없습니다', '중간 CA 누락 — 장비 인증서 체인 확인'],
};

/**
 * 전송 계층 오류를 사람이 읽는 한 줄로.
 * @param err                     fetch/undici 가 던진 오류
 * @param {string} host           대상 호스트(어느 장비인지 밝힌다)
 * @param {number} port           대상 포트
 * @param {number} timeoutMs      요청 타임아웃(타임아웃 문구에 실제 값을 쓴다)
 * @param {boolean} cancelled     호출자가 취소(연결 테스트 종료 등)했는가
 * @returns {string} 예: '10.76.159.29:443 연결이 거부되었습니다 — 장비에서 …  (ECONNREFUSED)'
 */
export function describeFetchError(err, { host = '', port = 443, timeoutMs = 0, cancelled = false } = {}) {
  const where = host ? `${host}:${port} ` : '';
  const text = errorText(err);
  const code = errorCode(err);

  // 호출자 취소(연결 테스트 시한 종료 등)는 장비 탓이 아니다 — 먼저 구분한다.
  if (cancelled) return `${where}수집이 취소되었습니다(상위 작업 시한 종료) — 장비 오류가 아닙니다`;

  // AbortSignal.timeout → TimeoutError. 'aborted' 만 보여주면 원인을 알 수 없다.
  if (/TimeoutError|The operation was aborted|This operation was aborted|HeadersTimeout|BodyTimeout/i.test(text)) {
    const sec = timeoutMs > 0 ? `${Math.round(timeoutMs / 1000)}초` : '제한 시간';
    return `${where}응답이 없습니다(${sec} 초과) — 방화벽·ACL 차단이거나 장비 관리 서비스가 응답하지 않는 상태입니다`;
  }

  const hit = BY_CODE[code];
  if (hit) return `${where}${hit[0]} — ${hit[1]} (${code})`;

  // 코드가 없는데 'fetch failed' 만 남은 경우: 그대로 두면 아무 정보가 없으므로 최소한 대상은 밝힌다.
  if (/fetch failed/i.test(text)) {
    const extra = text.replace(/TypeError|fetch failed/gi, '').replace(/\s+/g, ' ').trim();
    return `${where}연결하지 못했습니다${extra ? ` (${extra.slice(0, 120)})` : ''} — 주소·포트·방화벽을 확인하세요`;
  }
  return `${where}${err?.message || String(err)}`.trim();
}

/**
 * 전송 계층 실패인가(HTTP 응답을 받은 오류와 구분).
 * HTTP 4xx/5xx 는 이미 `httpFailMessage` 가 사유를 만들므로 여기서 다시 감싸지 않는다.
 */
export function isTransportError(err) {
  const t = errorText(err);
  if (/^HTTP \d{3}/.test(String(err?.message || ''))) return false;
  if (/인증 실패\(401\)/.test(String(err?.message || ''))) return false;
  return !!errorCode(err) || /fetch failed|TimeoutError|aborted/i.test(t);
}
