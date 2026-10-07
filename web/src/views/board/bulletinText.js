/**
 * views/board/bulletinText.js — 접속 공지 팝업·게시판 화면의 판정과 문구(순수, v2.722).
 *
 * '보지 않기' 는 브라우저 저장(localStorage)이다 — 서버에 사용자별 상태를 두지 않는다(같은 계정이라도 다른 PC 에서는 다시 보인다 —
 * 화면이 그렇게 말한다). 키는 공지의 `rev`(id + 수정 시각)라 관리자가 내용을 고치면 다시 보인다.
 *   · 'today' — 오늘(브라우저 날짜) 하루만 숨긴다.
 *   · 'forever' — 이 공지(이 판)를 다시 보지 않는다.
 * 저장소를 못 읽거나 못 쓰면(프라이빗 창 등) 숨김 없이 보인다 — 공지를 놓치는 쪽보다 한 번 더 보는 쪽이 안전하다.
 */
import { dayStamp } from '../../dayStamp.js';

export const HIDE_KEY = 'portal.noticeHide';
export const HIDE_MAX = 200;
export const LEVEL_TEXT = Object.freeze({ info: '안내', warn: '주의', crit: '긴급' });
export const LEVEL_TONE = Object.freeze({ info: 'var(--accent)', warn: 'var(--amber)', crit: 'var(--red)' });

/** 저장된 숨김 표 — 모양이 다르면 빈 표. */
export function readHides(storage) {
  try {
    const raw = storage?.getItem(HIDE_KEY);
    const j = raw ? JSON.parse(raw) : {};
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** 이 공지가 지금 숨겨져 있는가. */
export function isHidden(notice, hides, today = dayStamp()) {
  const v = hides?.[notice?.rev];
  if (v === 'forever') return true;
  return typeof v === 'string' && v === today && today !== '';
}

/** 지금 팝업에 보일 공지. */
export const visibleNotices = (notices, hides, today) => (Array.isArray(notices) ? notices : []).filter((n) => n && n.rev && !isHidden(n, hides, today));

/**
 * 숨김을 기록한 새 표를 돌려준다. 지금 공지 목록에 없는 rev(삭제·수정된 옛 판)는 지워 무한히 쌓이지 않게 하고, 상한을 둔다.
 * @param {'today'|'forever'} how
 */
export function withHidden(hides, revs, how, activeRevs, today = dayStamp()) {
  const keep = new Set(activeRevs || []);
  const out = {};
  for (const [k, v] of Object.entries(hides || {})) if (keep.has(k)) out[k] = v;
  for (const r of revs || []) out[r] = how === 'forever' ? 'forever' : today;
  const keys = Object.keys(out);
  if (keys.length > HIDE_MAX) for (const k of keys.slice(0, keys.length - HIDE_MAX)) delete out[k];
  return out;
}

export function writeHides(storage, hides) {
  try { storage?.setItem(HIDE_KEY, JSON.stringify(hides)); return true; } catch { return false; }
}

/** 날짜·시각 표기(브라우저 시각) — 값이 없으면 '—'. */
export function timeText(ms) {
  if (ms == null || ms === '') return '—';
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${dayStamp(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 노출 기간 문구. */
export function windowText(n) {
  const s = n?.startAt; const e = n?.endAt;
  if (s == null && e == null) return '기간 제한 없음';
  if (s == null) return `${timeText(e)} 까지`;
  if (e == null) return `${timeText(s)} 부터`;
  return `${timeText(s)} ~ ${timeText(e)}`;
}

/** 관리 목록의 상태 — 꺼짐 / 예정 / 노출 중 / 종료. */
export function noticeState(n, now = Date.now()) {
  if (!n || n.enabled === false) return { key: 'off', text: '꺼짐', tone: 'var(--text-dim)' };
  if (n.startAt != null && n.startAt > now) return { key: 'scheduled', text: '예정', tone: 'var(--amber)' };
  if (n.endAt != null && n.endAt <= now) return { key: 'ended', text: '종료', tone: 'var(--text-dim)' };
  return { key: 'live', text: '노출 중', tone: 'var(--green)' };
}

/** <input type="datetime-local"> 값 ↔ epoch ms. 빈 값은 null(제한 없음). */
export function toLocalInput(ms) {
  if (ms == null) return '';
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${dayStamp(d)}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fromLocalInput(v) {
  if (typeof v !== 'string' || !v.trim()) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 저장 실패 문구 — 서버 reason 을 그대로 쓰고, 없으면 일반 문구. */
export const saveFailText = (r) => (r && r.reason ? `저장하지 못했습니다 — ${r.reason}` : '저장하지 못했습니다.');
