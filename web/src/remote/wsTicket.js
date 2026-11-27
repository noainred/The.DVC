/**
 * remote/wsTicket.js — 원격 콘솔(SSH · RDP) WebSocket 주소와 1회용 티켓(전체 점검 132회차). 순수 모듈.
 *
 * 브라우저는 WebSocket 에 Authorization 머리말을 실을 수 없어 예전에는 세션 토큰을 주소 쿼리에 실었다
 * (‘/api/remote/ssh?token=…’ · RDP 연결 쿼리 ‘token=’). 쿼리스트링은 상위 리버스 프록시 액세스 로그 · 브라우저 기록에 남는다.
 * 이제 접속(재시도 · 복제 포함)마다 인증된 POST 로 **1회용 단명 티켓**을 받아 주소에는 그 ID(‘wst=’)만 싣는다
 * (서버 proxy/wsTicket.js — 30초 · 1회 소비). **세션 토큰을 주소에 싣는 코드를 다시 만들지 말 것**(서버 테스트 wsTicket132 가 web/src 전체를 훑는다).
 *   SSH  — POST /remote/ws-ticket → { wst }
 *   RDP  — POST /remote/rdp-ticket 응답에 { ticket(자격증명), wst } 가 함께 온다(요청 한 번)
 */

/** WS 주소의 쿼리 이름 — 서버 proxy/wsTicket.js WS_TICKET_PARAM 과 같은 값(테스트가 대조한다). */
export const WS_TICKET_PARAM = 'wst';
/** 티켓 발급 요청 시한 — 변경 요청 기본(180초)을 기다리지 않는다(콘솔 창이 '연결 중' 으로 오래 멈추지 않게). */
export const WS_TICKET_TIMEOUT_MS = 15_000;

/** 응답에서 WS 티켓 ID 를 꺼낸다 — 형식(hex)이 아니면 ''. */
export function wsTicketOf(r) {
  const t = r && typeof r === 'object' ? r.wst : '';
  return typeof t === 'string' && /^[0-9a-f]{32,128}$/.test(t) ? t : '';
}

/** SSH 용 티켓을 받는다. post = api.js postJson. 못 받으면 사유를 담아 던진다(화면은 wsTicketFailText 로 보인다). */
export async function requestWsTicket(post) {
  const r = await post('/remote/ws-ticket', {}, { timeoutMs: WS_TICKET_TIMEOUT_MS });
  const wst = wsTicketOf(r);
  if (!wst) throw new Error(r && typeof r.reason === 'string' && r.reason ? r.reason : '서버가 티켓을 주지 않았습니다');
  return wst;
}

const wsOrigin = (loc) => `${loc?.protocol === 'https:' ? 'wss' : 'ws'}://${loc?.host || ''}`;

/** SSH 콘솔 WS 주소 — 티켓 ID 만 싣는다. */
export function sshWsUrl(loc, wst) {
  return `${wsOrigin(loc)}/api/remote/ssh?${WS_TICKET_PARAM}=${encodeURIComponent(String(wst || ''))}`;
}

/** RDP(Guacamole 터널) WS 주소 — 쿼리는 client.connect 가 붙인다. */
export function rdpWsUrl(loc) {
  return `${wsOrigin(loc)}/api/remote/rdp`;
}

/** 티켓 발급 실패 문구(SSH · RDP 공용). */
export function wsTicketFailText(e) {
  const m = String(e?.message || e || '').slice(0, 200);
  let why = m;
  if (/timed out|timeout|TimeoutError|AbortError/i.test(m)) why = '포탈 응답이 늦습니다';
  else if (/Failed to fetch|NetworkError|load failed|ERR_NETWORK/i.test(m)) why = '포탈에 연결하지 못했습니다';
  return `접속 티켓을 발급받지 못했습니다${why ? `(${why})` : ''} — 다시 시도하세요.`;
}
