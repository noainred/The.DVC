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
  'key-revoke-done': '서버에서 키 거두기 끝남', 'inbox-new': '받는 곳에 새 키 파일',
});

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').slice(0, max);
let queue = [];
let timer = null;
let _last = null;
let _send = null;   // 테스트 주입

/** 사건 → 메일 한 통(순수 — 테스트 고정). 보낼 것이 없으면 null. */
export function buildMail(events) {
  const rows = (Array.isArray(events) ? events : []).filter((e) => e && MAIL_EVENTS[e.kind]).slice(0, MAX_LINES);
  if (!rows.length) return null;
  const line = (e) => `${MAIL_EVENTS[e.kind]}${e.corp ? ` · ${one(e.corp, 60)}` : ''}${e.target ? ` · ${one(e.target, 120)}` : ''}${e.by ? ` · ${one(e.by, 40)}` : ''}${e.detail && e.kind !== 'inbox-new' ? ` — ${one(e.detail, 160)}` : ''}`;
  const subject = rows.length === 1 ? `[SSH 키 보안] ${line(rows[0]).slice(0, 120)}` : `[SSH 키 보안] 사건 ${rows.length}건 — ${MAIL_EVENTS[rows[0].kind]} 외`;
  const text = `${rows.map(line).join('\n')}\n\n자세한 내용: 설정 › 보안 › SSH 공용 접속 › 키 보안`;
  const html = `<ul>${rows.map((e) => `<li>${esc(line(e))}</li>`).join('')}</ul><p>자세한 내용: 설정 › 보안 › SSH 공용 접속 › 키 보안</p>`;
  return { subject, text, html, count: rows.length };
}

async function flush() {
  timer = null;
  const batch = queue; queue = [];
  const m = buildMail(batch);
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
  onEvents((events) => {
    const pick = events.filter((e) => MAIL_EVENTS[e.kind]);
    if (!pick.length) return;
    queue = queue.concat(pick);   // 전개 push 를 쓰지 않는다(audit2603a 스윕)
    if (queue.length > MAX_LINES * 4) queue = queue.slice(-MAX_LINES * 4);
    if (!timer) { timer = setTimeout(() => { flush().catch(() => {}); }, FLUSH_MS); timer.unref?.(); }
  });
}
export function lastKeyNotify() { return _last ? { ..._last } : null; }
export async function _flushKeyNotifyForTest() { if (timer) { clearTimeout(timer); timer = null; } await flush(); }
export function _setKeyNotifySendForTest(fn) { _send = fn; }
