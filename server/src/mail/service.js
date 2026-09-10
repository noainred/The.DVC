/**
 * mail/service.js — 포탈 공용 메일 발송 진입점 (v2.454).
 *
 * 어떤 기능이든 여기 하나만 부르면 된다:
 *
 *   import { sendPortalMail } from '../mail/service.js';
 *   await sendPortalMail({ kind: 'alert', subject: '…', html: '…', text: '…' });
 *
 * 여기서 처리하는 것: 전역 on/off · 종류별 on/off · 수신자 결정(명시 > 종류별 > 기본) ·
 * 속도 제한 · 발송 이력 · 감사로그 · 실패 격리.
 *
 * **호출부는 실패를 신경 쓰지 않아도 된다** — 이 함수는 throw 하지 않고 `{ok, reason}` 을 돌려준다.
 * 폴러 안에서 메일 하나 때문에 수집이 죽으면 안 되기 때문이다(alerts.js 의 채널 호출과 같은 원칙).
 *
 * 비밀번호는 이 모듈을 통과하지 않는다 — 설정에서 읽어 `util/smtp.js` 로 바로 넘기고,
 * 이력·로그·응답 어디에도 남기지 않는다.
 */
import { load as loadMail } from './settings.js';
import { resolveRecipients, withinRateLimit, kindLabel } from './kinds.js';
import { sendMail } from '../util/smtp.js';
import { logAudit } from '../audit.js';

const sentAt = [];          // 최근 발송 시각(속도 제한용)
const history = [];         // 최근 발송 이력(최신 우선) — 비밀 없음
let lastError = null;

function remember(entry) {
  const cfg = loadMail();
  history.unshift(entry);
  const max = Math.max(20, Number(cfg.historyMax) || 200);
  while (history.length > max) history.pop();
}

/**
 * 메일 1건 발송.
 *
 * @param {object} o
 * @param {string} o.kind      mail/kinds.js 의 종류 id
 * @param {string} o.subject
 * @param {string} [o.html]
 * @param {string} [o.text]
 * @param {string[]|string} [o.to] 명시 수신자(주면 종류별·기본 수신자보다 우선)
 * @param {string[]|string} [o.cc]
 * @param {string} [o.by]      감사로그에 남길 실행 주체(사람이 누른 경우 사용자명)
 * @param {boolean} [o.trace]  단계별 SMTP 대화를 수집해 결과에 담는다(진단 화면 전용).
 *                             비밀번호는 util/smtp.js 가 가린다 — 여기서 따로 지울 필요가 없다.
 * @returns {Promise<{ok:boolean, reason?:string, accepted?:string[], skipped?:boolean}>}
 */
export async function sendPortalMail({ kind, subject, html = '', text = '', to = null, cc = null, by = 'system', trace = false }) {
  const cfg = loadMail();
  const at = Date.now();

  const r = resolveRecipients(cfg, kind, to);
  if (!r.ok) {
    // '꺼져 있음'·'수신자 없음' 은 오류가 아니라 정책대로 동작한 것이다 — 이력에는 남기되
    // 실패로 세지 않는다(설정 화면에서 "왜 안 왔는지" 를 확인할 수 있어야 한다).
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'skipped', note: r.reason });
    return { ok: false, skipped: true, reason: r.reason, trace: null };
  }
  if (!withinRateLimit(sentAt, cfg.rateLimitPerHour, at)) {
    const note = `시간당 발송 한도(${cfg.rateLimitPerHour}건)를 넘어 건너뜁니다 — 알림 폭주로 릴레이가 차단되는 것을 막습니다.`;
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'skipped', note });
    return { ok: false, skipped: true, reason: note, trace: null };
  }

  const ccList = cc == null ? r.cc : (Array.isArray(cc) ? cc : [cc]);
  const from = cfg.smtp.fromName
    ? `${quoteName(cfg.smtp.fromName)} <${cfg.smtp.from}>`
    : cfg.smtp.from;

  try {
    const res = await sendMail({ ...cfg.smtp, from: cfg.smtp.from, displayFrom: from }, {
      to: r.to, cc: ccList, subject, html, text,
    }, { trace });
    sentAt.push(at);
    while (sentAt.length && sentAt[0] < at - 3600_000) sentAt.shift();
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'sent', note: `${res.accepted.length}명 수신`, to: res.accepted });
    logAudit({ user: by, action: '메일 발송', target: kindLabel(kind), detail: `${res.accepted.length}명 — ${String(subject || '').slice(0, 120)}` });
    return { ok: true, accepted: res.accepted, trace: res.trace || null, reply: res.text };
  } catch (e) {
    lastError = e.message;
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'failed', note: e.message.slice(0, 300) });
    // 비밀번호는 util/smtp.js 가 오류 메시지에서 가린다.
    console.warn(`[mail] ${kindLabel(kind)} 발송 실패: ${e.message}`);
    logAudit({ user: by, action: '메일 발송 실패', target: kindLabel(kind), detail: e.message.slice(0, 200) });
    // 실패한 대화가 진단의 핵심이다 — 있으면 그대로 올려 보낸다(비밀번호는 이미 가려져 있다).
    return { ok: false, reason: e.message, trace: e.trace || null };
  }
}

/** 표시 이름에 따옴표·제어문자가 섞이면 헤더가 깨진다 — 안전한 형태로만 감싼다. */
function quoteName(n) {
  // eslint-disable-next-line no-control-regex
  const clean = String(n || '').replace(/[\x00-\x1f\x7f"\\<>]/g, '').trim().slice(0, 80);
  if (!clean) return '';
  return /^[A-Za-z0-9 ._-]+$/.test(clean) ? clean : `"${clean}"`;
}

/** 설정 화면·상태 API 용. 비밀 없음. */
export function mailStatus() {
  const cfg = loadMail();
  const hourAgo = Date.now() - 3600_000;
  return {
    enabled: !!cfg.enabled,
    configured: !!String(cfg.smtp?.host || '').trim(),
    sentLastHour: sentAt.filter((t) => t > hourAgo).length,
    rateLimitPerHour: cfg.rateLimitPerHour,
    lastError,
    history: history.slice(0, 50),
  };
}

export function _resetMail() { sentAt.length = 0; history.length = 0; lastError = null; }
