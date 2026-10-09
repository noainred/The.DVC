/**
 * remote/tokenRenew.js — 세션 연장 토큰을 열린 원격 콘솔에 전달(2026-10-09 검토 S-04). 순수 모듈(구독 집합 + 문구).
 *
 * 서버의 SSH/RDP 게이트웨이는 연결마다 그 토큰의 만료 시각에 연결을 닫는다(S-04 — 폐기·만료된 세션의 콘솔이 계속 살지 않게).
 * 세션을 연장해도 열린 콘솔은 **옛 토큰**으로 붙어 있으므로, 연장 직후 새 토큰을 그 연결에 보내야 끊기지 않는다:
 *   SSH  — WS 에 {type:'token', token} (응답 {type:'token-ack', ok, code?})
 *   RDP  — Guacamole tunnel.sendMessage('dvc-token', token) (서버가 소비 — guacd 로 넘기지 않는다, 응답 없음)
 * 서버는 같은 계정·같은 세션(sid)일 때만 바꾼다 — 다른 계정의 토큰을 보내도 교체되지 않는다.
 * 콘솔 창은 같은 페이지 안의 부동 창이라(RemoteConsoleWindow) 메모리 구독으로 충분하다.
 */
const subs = new Set();

/** 구독 — 해제 함수를 돌려준다(콘솔이 닫힐 때 부를 것). */
export function onTokenRenewed(fn) {
  if (typeof fn !== 'function') return () => {};
  subs.add(fn);
  return () => { subs.delete(fn); };
}

/** 새 토큰을 열린 콘솔에 알린다. 알린 구독자 수를 돌려준다(빈 토큰은 알리지 않는다). */
export function notifyTokenRenewed(token) {
  if (typeof token !== 'string' || !token) return 0;
  let n = 0;
  for (const fn of [...subs]) { try { fn(token); n += 1; } catch { /* 한 콘솔의 실패가 다른 콘솔을 막지 않게 */ } }
  return n;
}

/** 서버의 token-ack 가 거부면 사용자에게 보일 문구(성공·다른 메시지면 null). */
export function tokenAckText(msg) {
  if (!msg || typeof msg !== 'object' || msg.type !== 'token-ack' || msg.ok) return null;
  const code = typeof msg.code === 'string' && msg.code ? `(${msg.code.slice(0, 40)})` : '';
  return `세션 연장이 이 콘솔에 반영되지 않았습니다${code} — 이전 만료 시각에 연결이 끊깁니다. 다시 접속하면 새 세션으로 열립니다.`;
}

export const _subscriberCount = () => subs.size;
