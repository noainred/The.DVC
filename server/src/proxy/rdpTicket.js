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
import { capStr } from '../util/capStr.js';

const TTL_MS = 60_000;      // 발급 후 60초 내 사용
const MAX_TICKETS = 500;    // 폭주/누수 방지 상한

const tickets = new Map();  // id → { creds, exp, owner }

/**
 * v2.632 AX3-03: 필드별 길이 상한. 예전에는 개수(500)만 막아 remote.access 계정 하나가 1MB 비밀번호 티켓 500개로
 * 약 500MB 힙을 60초씩 반복 점유할 수 있었다(v2.617 멈춤 사건의 유력 가설이 '힙 한계 근처 GC 헛돎' 이었다).
 * 넘는 값은 **자르지 않고 거부**한다 — 잘린 비밀번호로 접속하면 원인을 알 수 없는 로그인 실패가 되고 계정이 잠긴다.
 */
export const RDP_FIELD_MAX = Object.freeze({ username: 256, password: 1024, domain: 256, security: 32 });
/** 사용자당 동시 보관 티켓 상한 — 넘으면 그 사용자의 가장 오래된 것부터 지운다(다른 사용자의 티켓을 밀어내지 않게). */
export const MAX_TICKETS_PER_OWNER = 20;

/** 입력 검사 — 문제가 있으면 사유 문자열, 없으면 null. 문자열·숫자만 받는다(객체의 toString 을 부르지 않는다). */
export function rdpCredsIssue(creds = {}) {
  for (const [k, max] of Object.entries(RDP_FIELD_MAX)) {
    const v = creds[k];
    if (v == null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number') return `${k} 형식이 올바르지 않습니다.`;
    if (String(v).length > max) return `${k} 가 너무 깁니다(최대 ${max}자).`;
  }
  return null;
}

function prune() {
  const now = Date.now();
  for (const [id, t] of tickets) if (t.exp <= now) tickets.delete(id);
}

/** 자격증명을 보관하고 티켓 ID를 반환. creds: { username, password, domain, security } */
export function issueRdpTicket(creds = {}, { owner = '' } = {}) {
  prune();
  const who = capStr(owner, 256);
  if (who) {
    const own = [...tickets.entries()].filter(([, t]) => t.owner === who).sort((a, b) => a[1].exp - b[1].exp);
    for (let i = 0; i <= own.length - MAX_TICKETS_PER_OWNER; i++) tickets.delete(own[i][0]);
  }
  if (tickets.size >= MAX_TICKETS) {
    // 가장 오래된 것부터 축출(정상 흐름에선 도달하지 않음 — 방어적).
    const oldest = [...tickets.entries()].sort((a, b) => a[1].exp - b[1].exp)[0];
    if (oldest) tickets.delete(oldest[0]);
  }
  const id = crypto.randomBytes(24).toString('hex');
  tickets.set(id, {
    creds: {
      username: capStr(creds.username || '', RDP_FIELD_MAX.username),
      password: capStr(creds.password || '', RDP_FIELD_MAX.password),
      domain: capStr(creds.domain || '', RDP_FIELD_MAX.domain),
      security: capStr(creds.security || '', RDP_FIELD_MAX.security),
    },
    exp: Date.now() + TTL_MS,
    owner: who,
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
