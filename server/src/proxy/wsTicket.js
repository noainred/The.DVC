/**
 * 원격 콘솔(SSH · RDP) WebSocket 용 **1회용 단명 티켓**(전체 점검 132회차 — 129회차 결정 D2).
 *
 * 왜: 브라우저는 WebSocket 에 Authorization 머리말을 실을 수 없어, 예전 화면은 세션 토큰(JWT)을 주소 쿼리
 *   (`/api/remote/ssh?token=<JWT>` · RDP 연결 쿼리 `token=`)에 실었다. 쿼리스트링은 상위 리버스 프록시 액세스 로그 ·
 *   브라우저 기록에 남는다 — RDP 자격증명을 티켓(rdpTicket.js)으로 바꾼 이유가 세션 토큰에도 그대로 해당한다
 *   (토큰은 만료 전까지 포탈 API 전체를 여는 값이다).
 *
 * 방식: 인증된 HTTP 요청(Authorization 머리말 — `POST /api/remote/ws-ticket` · RDP 는 `POST /api/remote/rdp-ticket` 응답에 함께)이
 *   **그 요청의 세션 토큰**을 이 티켓에 묶어 두고, WS 주소에는 티켓 ID(`wst=`)만 싣는다. 게이트웨이는 upgrade 에서 티켓을
 *   **소비**해 토큰을 꺼내고 예전과 똑같이 `resolveTokenUser(token)` · `remoteUserIssue` · 매핑 재검사 · `trackRemoteSession` 을 태운다
 *   (sshGateway.js `remoteUpgradeAuth` — 티켓은 '토큰을 실어 나르는 길' 만 바꾼다. 판정은 하나도 바뀌지 않는다).
 *
 *  - 1회용: 소비하면 곧바로 지운다(만료 · 발급자 불일치로 거부될 때도 지운다 — 주소에 실렸던 ID 는 다시 쓸 수 없다).
 *  - 단명: 발급 뒤 {@link WS_TICKET_TTL_MS}. 화면은 받은 직후 WS 를 연다.
 *  - 인메모리만: 디스크 · 로그 · 응답에 토큰을 남기지 않는다(상태 함수는 개수만).
 *  - 상한: 전체 {@link WS_TICKET_MAX} · 계정당 {@link WS_TICKET_MAX_PER_OWNER}(넘으면 그 계정의 가장 오래된 것부터 — 남의 티켓을 밀어내지 않는다).
 *    토큰 길이는 HTTP 머리말 상한(Node 기본 16KB)이 이미 묶는다.
 *  - 폐기된 토큰의 티켓: 티켓은 권한을 **보관하지 않는다** — 소비 시점에 `resolveTokenUser` 가 다시 판정한다(로그아웃 · 삭제 · 강등 · sid 교체 뒤면 401).
 *  - 인증이 꺼진 포탈(AUTH_ENABLED=false): 토큰이 없다(null). 발급은 되고 게이트웨이는 예전처럼 익명 역할로 판정한다(티켓을 보지 않는다).
 */

import crypto from 'node:crypto';
import { capStr, flatStr } from '../util/capStr.js';

/** WS 주소의 쿼리 이름 — 화면(web/src/remote/wsTicket.js)과 같은 값(테스트가 대조한다). */
export const WS_TICKET_PARAM = 'wst';
export const WS_TICKET_TTL_MS = 30_000;
export const WS_TICKET_MAX = 500;
export const WS_TICKET_MAX_PER_OWNER = 20;

const tickets = new Map();        // id → { token, owner, exp } · 삽입 순서 = 발급 순서(TTL 이 같아 만료 순서이기도 하다)

/** 테스트 주입 — 시계. */
const deps = { now: () => Date.now() };
export function _setWsTicketNowForTest(fn = null) { deps.now = typeof fn === 'function' ? fn : () => Date.now(); }

function prune() {
  const now = deps.now();
  for (const [id, t] of tickets) if (t.exp <= now) tickets.delete(id);
}

/**
 * 티켓을 발급한다. token = 이 요청이 실어 보낸 세션 토큰(인증이 꺼진 포탈이면 null), owner = 그 요청의 계정.
 * @returns {string} 티켓 ID(48자 hex)
 */
export function issueWsTicket({ token = null, owner = '' } = {}) {
  prune();
  const who = capStr(owner, 256);
  if (who) {
    const own = [];
    for (const [id, t] of tickets) if (t.owner === who) own.push(id);
    for (let i = 0; i <= own.length - WS_TICKET_MAX_PER_OWNER; i++) tickets.delete(own[i]);
  }
  while (tickets.size >= WS_TICKET_MAX) tickets.delete(tickets.keys().next().value);   // 가장 오래된 것부터(방어적 — 계정당 상한이 먼저 걸린다)
  const id = crypto.randomBytes(24).toString('hex');   // 192비트 — 추측할 수 없다
  tickets.set(id, {
    token: typeof token === 'string' && token ? flatStr(token) : null,   // 머리말 문자열의 부분 문자열을 붙잡지 않게 평탄화
    owner: who,
    exp: deps.now() + WS_TICKET_TTL_MS,
  });
  return id;
}

/**
 * 티켓을 소비한다(1회용) — 유효하면 { token, owner }, 아니면 null. 찾았으면 **만료여도 지운다**.
 * 문자열이 아닌 값은 없는 티켓이다(객체의 toString 을 부르지 않는다).
 */
export function consumeWsTicket(id) {
  const key = typeof id === 'string' ? id : '';
  const t = tickets.get(key);
  if (!t) return null;
  tickets.delete(key);
  const expired = t.exp <= deps.now();
  prune();   // 쓰이지 않고 남은 만료분 청소(발급이 없어도 토큰이 메모리에 남지 않게)
  if (expired) return null;
  return { token: t.token, owner: t.owner };
}

/** 상태(진단 · 테스트) — 개수만. 토큰 · 계정 · ID 는 싣지 않는다. */
export function wsTicketStatus() {
  return { live: tickets.size, ttlMs: WS_TICKET_TTL_MS, max: WS_TICKET_MAX, maxPerOwner: WS_TICKET_MAX_PER_OWNER };
}

/** 테스트용. */
export function _resetWsTickets() { tickets.clear(); }
