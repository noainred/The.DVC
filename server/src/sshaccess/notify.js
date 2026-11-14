/**
 * sshaccess/notify.js — SSH 키 보안 사건을 메일로 알린다(v3.10.0 · 설계 docs/design/ssh-access §8 ‘알림’).
 *
 *  · 메일 종류 `ssh-key`(mail/kinds.js — 받는 사람 · 켬/끔은 설정 › 메일의 공용 경로). 꺼져 있거나 받는 사람이 없으면 보내지 않는다(메일 경로가 그렇게 답한다).
 *  · 사건마다 보내지 않는다 — 5초 동안 모아 **한 통**으로(몰아서 생긴 사건이 시간당 상한에 막혀 일부만 가지 않게).
 *  · 보내는 사건만 고른다(KINDS) — 주기 성공 같은 것은 없다. 받는 곳 새 파일 · 포탈 밖 변경 · 사용 중지/재개 · 보호 장치 변경 · 승인 요청/결정 · 키 거두기 · 다시 읽기.
 *  · 본문에는 사건의 글(대상 이름 · 지문 앞부분 · 누가)만 — 개인키 · 비밀번호는 사건 기록에 애초에 없다.
 *  · 데모(mock) 모드는 보내지 않는다. 실패는 삼키고 마지막 결과만 남긴다(사건 기록 · 감사 로그가 원본이다 — 메일은 알림일 뿐).
 */
import { onEvents } from './state.js';

export const MAIL_KIND = 'ssh-key';
const FLUSH_MS = 5_000;
const MAX_LINES = 60;
export const MAIL_EVENTS = Object.freeze({
  'approval-requested': '승인 요청', 'approval-decided': '승인 결과', 'guard-changed': '보호 장치 변경',
  'corp-stop': '법인 키 사용 중지', 'corp-resume': '법인 키 사용 재개',
  'key-changed-outside': '키가 포탈 밖에서 바뀜', 'key-added-outside': '키가 포탈 밖에서 들어옴', 'account-changed-outside': '공통 계정이 포탈 밖에서 바뀜',
  'state-reloaded': '상태 파일 다시 읽음', 'keystore-reloaded': '키 저장소 다시 읽음(포탈 밖 변경 받아들임)',
  // 서버마다의 ‘키 거둠’ 은 메일로 보내지 않는다 — 작업 끝 요약 한 통(점검 C-4 — 고지연 법인 100대 거두기가 메일 100통으로 포탈 전체 시간당 한도를 다 썼다).
  'key-revoke-done': '서버에서 키 거두기 끝남', 'key-job-interrupted': '키 작업이 서버를 바꾸던 중에 중단됨', 'inbox-new': '받는 곳에 새 키 파일',
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').slice(0, max);
let queue = [];
let dropped = 0;   // 대기열 상한으로 버린 사건 수 — 다음 메일의 ‘외 N건’ 에 더한다
let timer = null;
let _last = null;
let _send = null;   // 테스트 주입

/** 사건 → 메일 한 통(순수 — 테스트 고정). 보낼 것이 없으면 null. */
export function buildMail(events, { dropped = 0 } = {}) {
  const all = (Array.isArray(events) ? events : []).filter((e) => e && MAIL_EVENTS[e.kind]);
  const rows = all.slice(0, MAX_LINES);
  if (!rows.length) return null;
  const more = all.length - rows.length + Math.max(0, Number(dropped) || 0);   // 대기열에서 넘쳐 버린 수도 더한다(2회차 C2-6)   // 넘친 사건은 말없이 버리지 않고 수를 밝힌다(1회차 C1-5)
  const line = (e) => `${MAIL_EVENTS[e.kind]}${e.corp ? ` · ${one(e.corp, 60)}` : ''}${e.target ? ` · ${one(e.target, 120)}` : ''}${e.by ? ` · ${one(e.by, 40)}` : ''}${e.detail && e.kind !== 'inbox-new' ? ` — ${one(e.detail, 160)}` : ''}`;
  const total = all.length + Math.max(0, Number(dropped) || 0);
  const subject = total === 1 ? `[SSH 키 보안] ${line(rows[0]).slice(0, 120)}` : `[SSH 키 보안] 사건 ${total}건 — ${MAIL_EVENTS[rows[0].kind]} 외`;
  const moreText = more > 0 ? `\n… 외 ${more}건은 이 메일에 싣지 않았습니다 — 화면의 키 보안 사건 기록을 보세요.` : '';
  const text = `${rows.map(line).join('\n')}${moreText}\n\n자세한 내용: 설정 › 보안 › SSH 공용 접속 › 키 보안`;
  const html = `<ul>${rows.map((e) => `<li>${esc(line(e))}</li>`).join('')}</ul>${more > 0 ? `<p>… 외 ${more}건은 이 메일에 싣지 않았습니다 — 화면의 키 보안 사건 기록을 보세요.</p>` : ''}<p>자세한 내용: 설정 › 보안 › SSH 공용 접속 › 키 보안</p>`;
  return { subject, text, html, count: total };
}

async function flush() {
  timer = null;
  const batch = queue; queue = [];
  const lost = dropped; dropped = 0;
  const m = buildMail(batch, { dropped: lost });
  if (!m) return;
  try {
    const { isMockMode } = await import('../mock/demo/flags.js');
    if (isMockMode()) { _last = { at: Date.now(), ok: false, skipped: 'mock', count: m.count }; return; }
  } catch { /* 판정 모듈이 없으면 보낸다 */ }
  try {
    const send = _send || (await import('../mail/service.js')).sendPortalMail;
    const r = await send({ kind: MAIL_KIND, subject: m.subject, html: m.html, text: m.text });
    _last = { at: Date.now(), ok: !!(r && r.ok !== false), count: m.count, reason: r && r.ok === false ? one(r.reason || r.error, 120) : '' };
  } catch (e) { _last = { at: Date.now(), ok: false, count: m.count, reason: one(e?.message || e, 120) }; }
}

/** 기동 때 한 번 — 상태 저장소의 사건 알림에 붙는다(여러 번 불러도 한 번만). */
let hooked = false;
export function startKeyNotify() {
  if (hooked) return;
  hooked = true;
  onEvents((events, { lost = [] } = {}) => {
    // 기록 상한에 밀려 남지 못한 사건도 ‘외 N건’ 에 센다(2회차 반증 R2R-10).
    dropped += (Array.isArray(lost) ? lost : []).filter((e) => MAIL_EVENTS[e?.kind]).length;
    const pick = events.filter((e) => MAIL_EVENTS[e.kind]);
    if (!pick.length) return;
    queue = queue.concat(pick);   // 전개 push 를 쓰지 않는다(audit2603a 스윕)
    if (queue.length > MAX_LINES * 4) { dropped += queue.length - MAX_LINES * 4; queue = queue.slice(-MAX_LINES * 4); }
    if (!timer) { timer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS); timer.unref?.(); }
  });
}
export function lastKeyNotify() { return _last ? { ..._last } : null; }
export async function _flushKeyNotifyForTest() { if (timer) { clearTimeout(timer); timer = null; } await flush(); }
export function _setKeyNotifySendForTest(fn) { _send = fn; }
