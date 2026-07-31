/**
 * RDP 접속용 단기 1회용 티켓 — RDP WebSocket(/api/remote/rdp)에 자격증명(사용자/비번/도메인)을
 * URL 쿼리스트링으로 싣던 것을 대체한다(감사 H18). Guacamole WebSocketTunnel.connect()는
 * 쿼리스트링만 받으므로, 자격증명을 브라우저 히스토리/상위 리버스프록시 액세스 로그에 남기지
 * 않으려면 쿼리에는 '티켓 ID'만 싣고 실제 자격증명은 서버 메모리에 보관해 게이트웨이가 조회한다.
 *
 * - 1회용: consume 시 즉시 삭제(재사용 불가).
 * - 단기 TTL(기본 60초): 발급 직후 connect까지만 유효. 만료분은 발급/소비 시 청소.
 * - 인메모리만: 디스크에 남기지 않는다(자격증명 영속화 금지).
 */

import crypto from 'node:crypto';

const TTL_MS = 60_000;      // 발급 후 60초 내 사용
const MAX_TICKETS = 500;    // 폭주/누수 방지 상한

const tickets = new Map();  // id → { creds, exp }

function prune() {
  const now = Date.now();
  for (const [id, t] of tickets) if (t.exp <= now) tickets.delete(id);
}

/** 자격증명을 보관하고 티켓 ID를 반환. creds: { username, password, domain, security } */
export function issueRdpTicket(creds = {}) {
  prune();
  if (tickets.size >= MAX_TICKETS) {
    // 가장 오래된 것부터 축출(정상 흐름에선 도달하지 않음 — 방어적).
    const oldest = [...tickets.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) tickets.delete(oldest[0]);
  }
  const id = crypto.randomBytes(24).toString('hex');
  tickets.set(id, {
    creds: {
      username: String(creds.username || ''),
      password: String(creds.password || ''),
      domain: String(creds.domain || ''),
      security: String(creds.security || ''),
    },
    exp: Date.now() + TTL_MS,
  });
  return id;
}

/** 티켓을 소비(1회용) — 유효하면 creds 반환 후 삭제, 아니면 null. */
export function consumeRdpTicket(id) {
  prune();
  const key = String(id || '');
  const t = tickets.get(key);
  if (!t) return null;
  tickets.delete(key);
  if (t.exp <= Date.now()) return null;
  return t.creds;
}

/** 테스트용. */
export function _resetRdpTickets() { tickets.clear(); }
