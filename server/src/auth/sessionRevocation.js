/**
 * 세션 폐기 이벤트(2026-10-09 검토 S-04·S-05·S-08) — 인증 쪽이 '이 세션/계정은 더 이상 유효하지 않다' 를 알리면
 * 이미 열려 있는 장기 연결(SSH·RDP WebSocket 등)이 즉시 닫을 수 있게 하는 프로세스 안 발행·구독 지점.
 *
 * 왜 따로 두나: 인증 모듈(auth/auth.js·routes/auth.js)과 게이트웨이(proxy/sshGateway.js·guacdTunnel.js)가 서로를
 * import 하면 순환이 생긴다. 이 모듈은 아무것도 import 하지 않는 잎이라 양쪽이 안전하게 쓴다.
 *
 * 이벤트 모양(필드는 아는 것만 채운다 — 빈 필드는 '그 축으로는 거르지 않는다' 가 아니라 '모른다' 다):
 *   { username?, sid?, reason, scope?: 'session'|'user'|'source'|'all', source?: 'local'|'ad', at }
 *   - scope 'session' : username + sid 가 일치하는 연결만
 *   - scope 'user'    : 그 username 의 모든 연결(계정 삭제·강등·비밀번호 변경·tokenVersion 증가)
 *   - scope 'source'  : 그 인증 출처(예 'ad')의 모든 연결(AD 비활성화·역할 매핑 변경)
 *   - scope 'all'     : 전부(서명 비밀 교체 등)
 * 구독자가 던져도 다른 구독자에게 전달은 계속된다(한 게이트웨이의 결함이 다른 연결 폐기를 막지 않게).
 *
 * 이벤트는 '즉시 닫기' 용 보조 수단이다 — 장기 연결은 주기 재검증(resolveTokenUser 재호출)도 함께 해야 한다
 * (만료·다른 프로세스에서의 변경처럼 이벤트로 오지 않는 폐기가 있다).
 */

const subs = new Set();

/** 구독. 반환값을 부르면 해지된다. */
export function onSessionRevoked(fn) {
  if (typeof fn !== 'function') throw new TypeError('onSessionRevoked: 함수가 필요합니다');
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** 발행. 구독자 수를 돌려준다(테스트·로그용). */
export function notifySessionRevoked(evt = {}) {
  const e = { ...evt, at: Number.isFinite(evt.at) ? evt.at : Date.now() };
  if (!e.scope) e.scope = e.sid ? 'session' : e.username ? 'user' : e.source ? 'source' : 'all';
  let n = 0;
  for (const fn of [...subs]) {
    try { fn(e); n++; } catch (err) { console.warn(`[sessionRevocation] 구독자 오류: ${err?.message || err}`); }
  }
  return n;
}

/**
 * 연결(conn = { username, sid, source })이 이 이벤트로 폐기 대상인지 — 게이트웨이들이 같은 판정을 쓰게 한 곳에 둔다.
 * username 비교는 대소문자 무시(로그인·토큰 해석과 같은 규칙).
 */
export function revocationMatches(evt, conn) {
  if (!evt || !conn) return false;
  const lc = (s) => String(s ?? '').toLowerCase();
  switch (evt.scope) {
    case 'all': return true;
    case 'source': return !!evt.source && lc(conn.source) === lc(evt.source);
    case 'user': return !!evt.username && lc(conn.username) === lc(evt.username);
    case 'session': return !!evt.sid && !!conn.sid && conn.sid === evt.sid
      && (!evt.username || lc(conn.username) === lc(evt.username));
    default: return false;
  }
}

/** 테스트용 — 구독자 수. */
export function _subscriberCount() { return subs.size; }
