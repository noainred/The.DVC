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
import { sendMail, headerSafeText, normalizeAddresses } from '../util/smtp.js';
import { logAudit } from '../audit.js';
import { createAuthGuard, authStopView } from '../util/authGuard.js';

/**
 * SMTP 인증 실패 정지(v2.591 — 감사 F4). 자동 발송(알림·일일 보고·폴더 사용량)은 사건마다 메일을 보낸다 —
 * 릴레이 계정의 비밀번호가 바뀐 구간에 알림 폭주가 오면 **그 수만큼 같은 계정으로 로그인 실패**가 쌓여 AD/메일
 * 계정이 잠긴다(authGuard 가 막으려는 것과 같은 사고). 자격증명 거부(535/534/530 — `util/smtp.js` 가 출처에서
 * `err.authFailed` 로 표시)면 **자동 발송만** 멈추고, 테스트 발송(설정 화면)은 막지 않으며 성공하면 푼다.
 * 계정·서버·비밀번호가 바뀌면 credHash 가 달라져 자동 재개한다. 정지 파일은 도구마다 따로다.
 */
export const mailAuthGuard = createAuthGuard({ file: 'mail-auth-stops.json' });
const SMTP_STOP_ID = 'smtp';
/** 정지 기록의 자격증명 — 계정·서버·포트가 바뀌어도 재개되게 username 에 접속처를 함께 넣는다(평문 미저장 — 지문만). */
function smtpDev(smtp) {
  return { id: SMTP_STOP_ID, username: `${String(smtp?.user || '')}@${String(smtp?.host || '')}:${String(smtp?.port || '')}`, password: String(smtp?.password || '') };
}
/** 사람이 누른 발송인가 — 테스트 발송이거나 실행 주체가 사람(`by` 가 'system' 이 아님). 그 밖은 자동 발송이다. */
function isManualSend(kind, by) { return kind === 'test' || (by != null && by !== '' && by !== 'system'); }

const sentAt = [];          // 최근 발송 성공 시각(표시용)
const attemptAt = [];       // 최근 **시도** 시각(속도 제한용 — v2.591: 실패도 센다)
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
/*
 * v2.742(감사 TIMING-01 — 재현): **자동 발송의 SMTP 로그인은 한 번에 하나다.** 위 정지 확인(authStopFor)은 `await sendMail`
 *   앞의 동기 구간에만 있고 정지 기록은 첫 535 응답이 돌아온 **뒤에야** 세워진다 — 그래서 동시에 들어온 자동 발송은 전부 검사를
 *   통과했다(알림 엔진 40건 → 잘못된 비밀번호로 로그인 40회. 계정 잠금 경로). 이제 계정(smtp.user)이 있는 자동 발송은 줄을 서고,
 *   차례가 오면 정지 기록·속도 제한을 **그때** 다시 본다 — 첫 거부 뒤의 나머지는 로그인 없이 건너뛴다.
 *   · '한 번 성공했으면 동시에 보내도 된다' 로 풀지 않는다 — 막으려는 사고가 '서버 쪽에서 비밀번호가 바뀐 구간' 이라 직전 성공은
 *     다음 시도의 근거가 되지 못한다.
 *   · 사람이 누른 발송(테스트 발송 등)은 줄 서지 않는다 — 정지 중에도 시도하는 경로이고(고쳤는지 확인), 자동 발송 대기열 뒤에서
 *     몇 분씩 기다리게 만들지 않는다. 계정이 없는(인증 없는) 릴레이는 잠글 계정이 없어 예전처럼 바로 보낸다.
 */
let _autoChain = Promise.resolve();
let _autoWaiting = 0;
export async function sendPortalMail(opts = {}) {
  const manual = isManualSend(opts.kind, opts.by ?? 'system');
  if (manual || !loadMail().smtp?.user) return sendPortalMailNow(opts);
  _autoWaiting += 1;
  const run = _autoChain.then(() => { _autoWaiting -= 1; return sendPortalMailNow(opts); });
  _autoChain = run.catch(() => {});
  return run;
}
/** 줄 선 자동 발송 수(상태 표시·테스트용). */
export function mailAutoQueueLength() { return _autoWaiting; }

async function sendPortalMailNow({ kind, subject: rawSubject, html = '', text = '', to = null, cc = null, by = 'system', trace = false, fromAddr = '', fromName = null, attachments = [] }) {
  // v2.743(감사 INJPKG-03): 제목의 제어문자(탭·CR·LF)는 공백으로 정리한다 — 호출부(알림·일일 보고·아이실론 등)가 운영 데이터(호스트명·
  //   VM 이름·원격 응답)를 제목에 담는데, 탭 하나에 buildMime 이 던져 그 메일 전체를 잃었다. buildMime 의 throw 는 마지막 방어선으로 남긴다.
  const subject = headerSafeText(rawSubject);
  const cfg = loadMail();
  const at = Date.now();

  const r = resolveRecipients(cfg, kind, to);
  if (!r.ok) {
    // '꺼져 있음'·'수신자 없음' 은 오류가 아니라 정책대로 동작한 것이다 — 이력에는 남기되
    // 실패로 세지 않는다(설정 화면에서 "왜 안 왔는지" 를 확인할 수 있어야 한다).
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'skipped', note: r.reason });
    return { ok: false, skipped: true, reason: r.reason, trace: null };
  }
  // v2.591(감사 F4): 인증 실패로 멈춘 상태면 **자동 발송만** 건너뛴다(시도하지 않는다 — 계정 잠금 방지).
  //   조용히 버리지 않는다 — 이력에 사유와 함께 남기고 호출부에 skipped + authStopped 로 돌려준다.
  const manual = isManualSend(kind, by);
  const stop = cfg.smtp?.user ? mailAuthGuard.authStopFor(smtpDev(cfg.smtp)) : null;
  if (stop && !manual) {
    const note = `SMTP 인증 실패로 자동 발송을 멈춘 상태라 보내지 않았습니다(${stop.attempts}회 거부) — 설정 › 메일 발송에서 계정·비밀번호를 고치면 자동 재개되고, 테스트 발송이 성공해도 풀립니다.`;
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'skipped', note });
    return { ok: false, skipped: true, authStopped: authStopView(stop), reason: note, trace: null };
  }
  // v2.591(감사 F4): 속도 제한은 **시도**를 센다 — 성공만 세면 실패(특히 인증 실패)는 한도에 걸리지 않아
  //   알림 폭주 때 릴레이에 로그인 실패가 무제한으로 쌓였다.
  if (!withinRateLimit(attemptAt, cfg.rateLimitPerHour, at)) {
    const note = `시간당 발송 한도(${cfg.rateLimitPerHour}건)를 넘어 건너뜁니다 — 알림 폭주로 릴레이가 차단되는 것을 막습니다.`;
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'skipped', note });
    return { ok: false, skipped: true, reason: note, trace: null };
  }

  const ccList = cc == null ? r.cc : (Array.isArray(cc) ? cc : [cc]);
  // v2.749: 기능별 보내는 사람(헤더 From) — fromAddr 가 형식에 맞으면 헤더 From 만 바꾼다(봉투 MAIL FROM 은 메일 설정의 주소 그대로 —
  //   반송은 설정한 계정으로 간다). 형식이 틀리면 무시하고 설정값을 쓴다(호출부 설정 저장이 이미 거부한다). 표시 이름도 같다.
  //   ⚠ 사내 SMTP 가 로그인 계정과 다른 From 을 거부할 수 있다 — 거부되면 아래 catch 가 실패로 기록한다(조용히 바꿔 보내지 않는다).
  const fromOverride = typeof fromAddr === 'string' && fromAddr.trim() && normalizeAddresses([fromAddr.trim()]).ok.length === 1 ? fromAddr.trim() : '';
  const headerAddr = fromOverride || cfg.smtp.from;
  const headerName = fromName != null && String(fromName).trim() ? fromName : cfg.smtp.fromName;
  const from = headerName
    ? `${quoteName(headerName)} <${headerAddr}>`
    : headerAddr;

  attemptAt.push(at);
  while (attemptAt.length && attemptAt[0] < at - 3600_000) attemptAt.shift();
  try {
    const res = await sendMail({ ...cfg.smtp, from: cfg.smtp.from, displayFrom: from }, {
      to: r.to, cc: ccList, subject, html, text, attachments: Array.isArray(attachments) ? attachments : [],
    }, { trace });
    sentAt.push(at);
    while (sentAt.length && sentAt[0] < at - 3600_000) sentAt.shift();
    // 로그인이 통했다 — 정지 기록이 있으면 푼다(테스트 발송으로 고쳤는지 확인하는 경로).
    if (cfg.smtp?.user && mailAuthGuard.clearAuthStop(SMTP_STOP_ID)) console.log('[mail] 발송 성공 — SMTP 인증 실패 정지를 풀었습니다');
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'sent', note: `${res.accepted.length}명 수신`, to: res.accepted });
    logAudit({ user: by, action: '메일 발송', target: kindLabel(kind), detail: `${res.accepted.length}명 — ${String(subject || '').slice(0, 120)}` });
    return { ok: true, accepted: res.accepted, trace: res.trace || null, reply: res.text };
  } catch (e) {
    lastError = e.message;
    // v2.591(감사 F4): 자격증명 거부(출처 표시 — util/smtp.js)면 자동 발송을 멈춘다. 수동 발송의 거부도 기록한다
    //   (다음 자동 발송이 같은 계정으로 다시 로그인하지 않게). 타임아웃·연결 거부는 멈추지 않는다(규칙 4).
    let authStopped = null;
    if (e?.authFailed === true && cfg.smtp?.user) {
      authStopped = authStopView(mailAuthGuard.markAuthStopped(SMTP_STOP_ID, smtpDev(cfg.smtp), e.message));
      console.warn(`[mail] SMTP 인증 실패 — 자동 발송을 멈춥니다(${authStopped.attempts}회). 설정 › 메일 발송에서 계정을 고치면 자동 재개됩니다.`);
    }
    remember({ at, kind, subject: String(subject || '').slice(0, 200), state: 'failed', note: e.message.slice(0, 300) });
    // 비밀번호는 util/smtp.js 가 오류 메시지에서 가린다.
    console.warn(`[mail] ${kindLabel(kind)} 발송 실패: ${e.message}`);
    logAudit({ user: by, action: '메일 발송 실패', target: kindLabel(kind), detail: e.message.slice(0, 200) });
    // 실패한 대화가 진단의 핵심이다 — 있으면 그대로 올려 보낸다(비밀번호는 이미 가려져 있다).
    return { ok: false, reason: e.message, trace: e.trace || null, ...(authStopped ? { authStopped } : {}) };
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
  // v2.591(감사 F4): 정지 상태 — 읽기 전용 조회(화면이 볼 때마다 기록을 지우지 않는다).
  const authStopped = cfg.smtp?.user ? authStopView(mailAuthGuard.peekAuthStop(smtpDev(cfg.smtp))) : null;
  return {
    enabled: !!cfg.enabled,
    configured: !!String(cfg.smtp?.host || '').trim(),
    sentLastHour: sentAt.filter((t) => t > hourAgo).length,
    attemptsLastHour: attemptAt.filter((t) => t > hourAgo).length,
    autoQueued: _autoWaiting, // v2.742(TIMING-01): 줄 선 자동 발송(한 번에 하나씩 로그인)
    authStopped,
    rateLimitPerHour: cfg.rateLimitPerHour,
    lastError,
    history: history.slice(0, 50),
  };
}

export function _resetMail() { sentAt.length = 0; attemptAt.length = 0; history.length = 0; lastError = null; }
