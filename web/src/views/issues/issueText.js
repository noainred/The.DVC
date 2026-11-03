/**
 * views/issues/issueText.js — 이슈 트래커 화면의 판정과 문구(순수, v2.864).
 *
 * 서버(server/src/issues/store.js)가 상태·유형·우선순위 값을 정하고 여기서는 **이름과 표시**만 정한다. 판정(전이 규칙·권한)은 서버가 하고
 * 화면은 거부 사유를 그대로 보인다. 날짜는 브라우저 시각 기준이고 값이 없으면 '—'(0 이나 빈 날짜로 보이지 않게).
 */
import { dayStamp } from '../../dayStamp.js';

export const STATUS_ORDER = Object.freeze(['backlog', 'todo', 'progress', 'review', 'done']);
export const STATUS_TEXT = Object.freeze({ backlog: '백로그', todo: '할 일', progress: '진행 중', review: '검토', done: '완료' });
export const TYPE_TEXT = Object.freeze({ incident: '장애', task: '작업', request: '요청', improve: '개선' });
export const PRIORITY_TEXT = Object.freeze({ p0: 'P0 긴급', p1: 'P1 높음', p2: 'P2 보통', p3: 'P3 낮음' });
export const FIELD_TEXT = Object.freeze({
  created: '생성', status: '상태', assignee: '담당자', priority: '우선순위', dueAt: '기한', type: '유형', title: '제목', body: '본문',
  blocked: '보류', labels: '라벨', component: '컴포넌트', watchers: '관찰자',
});
export const DAY_MS = 24 * 3600_000;
/** '곧 마감' 으로 보는 기간(서버 통계의 dueSoon 과 같은 2일). */
export const SOON_DAYS = 2;
/** 팀 할당 현황 막대의 1인 기준 열린 이슈 수(표시 기준일 뿐 서버 규칙이 아니다 — 화면이 그렇게 말한다). */
export const LOAD_CAP = 5;

export const statusText = (s) => STATUS_TEXT[s] || s || '—';
export const typeText = (t) => TYPE_TEXT[t] || t || '—';
export const priorityText = (p) => PRIORITY_TEXT[p] || p || '—';

/** 날짜 표기 — 올해면 'M월 D일', 아니면 'YYYY-MM-DD'. 값이 없으면 '—'. */
export function dateText(ms, now = Date.now()) {
  if (ms == null || ms === '') return '—';
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  const n = new Date(now);
  return d.getFullYear() === n.getFullYear() ? `${d.getMonth() + 1}월 ${d.getDate()}일` : dayStamp(d);
}
/** 날짜·시각 표기 — 'YYYY-MM-DD HH:MM'. */
export function timeText(ms) {
  if (ms == null || ms === '') return '—';
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${dayStamp(d)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 자정 기준 날짜 차이(일) — 기한일 - 오늘. */
function dayDiff(dueAt, now) {
  const a = new Date(now); a.setHours(0, 0, 0, 0);
  const b = new Date(Number(dueAt)); b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/**
 * 기한 표시 — null 이면 기한 없음. tone: 'over'(지남) | 'soon'(오늘·내일·모레) | ''(여유).
 * 완료된 이슈는 기한을 판정하지 않는다(지난 기한이 '초과' 로 남지 않게).
 */
export function dueInfo(dueAt, { now = Date.now(), done = false } = {}) {
  if (dueAt == null || dueAt === '') return null;
  const t = Number(dueAt);
  if (!Number.isFinite(t)) return null;
  const date = dateText(t, now);
  if (done) return { text: date, tone: '', days: null };
  const days = dayDiff(t, now);
  if (days < 0) return { text: `${date} · ${-days}일 초과`, tone: 'over', days };
  if (days === 0) return { text: `오늘 · ${date}`, tone: 'soon', days };
  if (days <= SOON_DAYS) return { text: `${days === 1 ? '내일' : `D-${days}`} · ${date}`, tone: 'soon', days };
  return { text: date, tone: '', days };
}

/** 이름 머리글자(아바타) — 빈 이름은 '+'(미할당). */
export function initialOf(name) {
  const s = String(name || '').trim();
  if (!s) return '+';
  const ch = s.replace(/^[\\/]+/, '')[0] || s[0];
  return /[a-z]/i.test(ch) ? ch.toUpperCase() : ch;
}
/** 이름 → 아바타 색 번호(0~5, 안정적). */
export function colorIndexOf(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) % 100003;
  return h % 6;
}

/** 상태별로 묶는다(순서 고정). 모르는 상태는 백로그로 보내지 않고 `unknown` 에 둔다(조용히 사라지지 않게). */
export function groupByStatus(rows) {
  const out = Object.fromEntries(STATUS_ORDER.map((s) => [s, []]));
  out.unknown = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && out[r.status]) out[r.status].push(r); else if (r) out.unknown.push(r);
  }
  return out;
}

/**
 * 화면 필터(보드·목록 공용) — 서버가 준 목록을 다시 거른다. 값이 '' 이면 그 축은 거르지 않는다.
 *  assignee: '' 전체 · '__none' 미할당 · 그 밖은 그 사람 · mine=true 면 me 에게 할당된 것만.
 */
export function filterRows(rows, { q = '', assignee = '', priority = '', type = '', status = '', vcenterId = '', mine = false, me = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  return (Array.isArray(rows) ? rows : []).filter((r) => {
    if (!r) return false;
    if (mine && r.assignee !== me) return false;
    if (assignee === '__none' ? !!r.assignee : (assignee && r.assignee !== assignee)) return false;
    if (priority && r.priority !== priority) return false;
    if (type && r.type !== type) return false;
    if (status && r.status !== status) return false;
    if (vcenterId === '__none' ? !!r.vcenterId : (vcenterId && r.vcenterId !== vcenterId)) return false;
    if (needle && !`${r.key} ${r.title} ${r.assignee || ''} ${r.reporter || ''} ${(r.labels || []).join(' ')} ${r.component || ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/** 내 작업 — 나에게 할당된 열린 이슈(기한순), 내가 보고한 열린 이슈, 전체 미할당, 기한 요약. */
export function myWork(rows, me, now = Date.now()) {
  const open = (Array.isArray(rows) ? rows : []).filter((r) => r && r.status !== 'done');
  const byDue = (a, b) => ((a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)) || (b.updatedAt || 0) - (a.updatedAt || 0);
  const mine = open.filter((r) => !!me && r.assignee === me).sort(byDue);
  const reported = open.filter((r) => !!me && r.reporter === me && r.assignee !== me).sort(byDue);
  const unassigned = open.filter((r) => !r.assignee).sort(byDue);
  let overdue = 0; let soon = 0; let blocked = 0;
  for (const r of mine) {
    const d = dueInfo(r.dueAt, { now });
    if (d?.tone === 'over') overdue += 1; else if (d?.tone === 'soon') soon += 1;
    if (r.blocked) blocked += 1;
  }
  return { mine, reported, unassigned, overdue, soon, blocked };
}

/** 할당 현황 막대 비율(0~100). cap 보다 많으면 100. */
export const loadPct = (open, cap = LOAD_CAP) => Math.max(0, Math.min(100, Math.round(((Number(open) || 0) / cap) * 100)));

/** `<input type="date">` 값 ↔ epoch ms(그 날 09:00 로컬 — 자정으로 두면 '오늘' 판정이 시간대에 흔들린다). */
export function toDateInput(ms) {
  if (ms == null || ms === '') return '';
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? dayStamp(d) : '';
}
export function fromDateInput(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const [y, m, d] = v.split('-').map(Number);
  const t = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 라벨 입력(쉼표·공백 구분) → 배열. 서버가 소문자·중복 정리를 다시 한다. */
export const parseLabels = (s) => String(s || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

/** 바이트 → MB 표기. 값이 없으면 '—'. */
export const mbText = (bytes) => (Number.isFinite(bytes) && bytes >= 0 ? `${(bytes / 1048576).toFixed(1)} MB` : '—');

/** 저장 실패 문구 — 서버 reason 을 그대로, 상한 코드(issues-full)는 문장으로. */
export function saveFailText(r) {
  if (r && r.reason === 'issues-full') return `저장하지 못했습니다 — 이슈 저장 용량이 상한(${mbText(r.max)})에 닿았습니다(지금 약 ${mbText(r.bytes)}). 관리자에게 지난 이슈 정리를 요청하세요.`;
  return r && r.reason ? `저장하지 못했습니다 — ${r.reason}` : '저장하지 못했습니다.';
}

/** 쓰기 응답의 persist 안내 — 빈 문자열이면 안내 없음(게시판 리뷰 I-05 계약과 같다). */
export function persistNote(persist) {
  const s = persist?.state;
  if (s === 'failed') {
    const why = persist.error?.message ? ` 원인: ${persist.error.message}${persist.error.code ? `(${persist.error.code})` : ''}.` : '';
    return `반영됐지만 서버 디스크에 저장하지 못했습니다 — 포탈이 다시 시작되면 사라질 수 있습니다. 자동으로 다시 저장을 시도합니다.${why}`;
  }
  if (s === 'pending') return '반영됐고 디스크 저장을 기다리는 중입니다.';
  return '';
}

/** 이력 한 줄 문장. */
export function historyText(h) {
  if (!h || typeof h !== 'object') return '';
  const f = h.field;
  const who = h.by ? `${h.by} · ` : '';
  const note = h.note ? ` (사유: ${h.note})` : '';
  if (f === 'created') return `${who}이슈 생성 ${h.to || ''}`.trim();
  if (f === 'status') return `${who}상태 ${statusText(h.from)} → ${statusText(h.to)}`;
  if (f === 'assignee') return `${who}담당자 ${h.from || '미할당'} → ${h.to || '미할당'}${note}`;
  if (f === 'priority') return `${who}우선순위 ${priorityText(h.from)} → ${priorityText(h.to)}`;
  if (f === 'type') return `${who}유형 ${typeText(h.from)} → ${typeText(h.to)}`;
  if (f === 'blocked') return h.to ? `${who}보류: ${h.to}` : `${who}보류 해제${h.from ? ` (${h.from})` : ''}`;
  if (f === 'dueAt') return `${who}기한 ${h.from ? dateText(Number(h.from)) : '없음'} → ${h.to ? dateText(Number(h.to)) : '없음'}`;
  if (f === 'progress') return `${who}진행률 ${h.from !== '' && h.from != null ? `${h.from}%` : '없음'} → ${h.to !== '' && h.to != null ? `${h.to}%` : '없음'}${h.note ? ` — ${h.note}` : ''}`;
  if (f === 'body') return `${who}본문 수정`;
  if (f === 'title') return `${who}제목 ‘${h.from}’ → ‘${h.to}’`;
  const label = FIELD_TEXT[f] || f || '';
  return `${who}${label} ${h.from || '—'} → ${h.to || '—'}`;
}

/** 담당자 후보 — 서버 목록 + 지금 값(목록에 없어도 고를 수 있게) 을 이름순으로. */
export function peopleOptions(people, current = '') {
  const map = new Map();
  for (const p of Array.isArray(people) ? people : []) if (p?.username) map.set(p.username, p.name && p.name !== p.username ? `${p.username} (${p.name})` : p.username);
  if (current && !map.has(current)) map.set(current, current);
  return [...map.entries()].map(([username, label]) => ({ username, label })).sort((a, b) => a.username.localeCompare(b.username));
}

/**
 * v2.727(감사 E-02)과 같은 '가장 최근 요청만 반영' 가드 — 호출마다 번호를 받고 응답이 왔을 때 아직 최신인지 본다.
 */
export function makeLatest() {
  let n = 0;
  return { next: () => ++n, isLatest: (k) => k === n, invalidate: () => { n += 1; } };
}

/** 법인(vCenter) 이름 — 메타의 선택지에서 찾고, 없으면 id 그대로(범위 밖·삭제된 vCenter). 빈 값은 '공용'. */
export function vcName(meta, id) {
  if (!id) return '공용';
  return (meta?.vcenters || []).find((v) => v.id === id)?.name || id;
}

/** 새 이슈 창의 법인 선택지 — 쓰기 가능한 것만. 범위 계정은 공용을 고를 수 없다(서버가 400). */
export function vcenterOptions(meta) {
  const out = (meta?.vcenters || []).filter((v) => v.writable !== false).map((v) => ({ id: v.id, label: v.name }));
  return meta?.scoped ? out : [{ id: '', label: '공용(법인 없음)' }, ...out];
}

/** 알림 발송 상태 한 줄 — 서버 issueNotifyStatus(). 값이 없으면 '아직 없음'. */
export function notifyStatusText(st) {
  if (!st || typeof st !== 'object') return '';
  const parts = [];
  parts.push(st.lastFlushAt ? `마지막 발송 ${timeText(st.lastFlushAt)}` : '아직 보낸 묶음이 없습니다');
  parts.push(`메일 ${st.mails ?? 0}통`);
  if (st.mailFail) parts.push(`실패 ${st.mailFail}`);
  if (st.mailSkip) parts.push(`건너뜀 ${st.mailSkip}`);
  if (st.noEmail) parts.push(`주소 없는 사람 ${st.noEmail}회`);
  if (st.chat || st.chatFail) parts.push(`채팅 ${st.chat ?? 0}${st.chatFail ? ` · 실패 ${st.chatFail}` : ''}`);
  if (st.dropped) parts.push(`묶음 상한으로 뺀 사람 ${st.dropped}`);
  if (st.pendingRecipients) parts.push(`대기 ${st.pendingRecipients}명`);
  return parts.join(' · ');
}

/* ───────────── v2.871 진행 공유(사용자 요청 '진행상태를 다른 사람이 볼 수 있게') ───────────── */

/** 진행률 — 0~100 정수만 값이다. 보고가 없으면 null(0 이 아니다 — '못 읽은 값은 0 이 아니다'). */
export function progressOf(r) {
  const n = r?.progress;
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
}

/** 이 일수 동안 아무 갱신이 없으면 '멈춤' 으로 표시한다(진행 중·검토 중인 이슈만 — 할 일·백로그는 대기가 정상이다). */
export const STALE_DAYS = 3;
/** @returns {{ days: number, text: string }|null} */
export function staleInfo(r, now = Date.now(), days = STALE_DAYS) {
  if (!r || (r.status !== 'progress' && r.status !== 'review')) return null;
  const last = Math.max(Number(r.updatedAt) || 0, Number(r.progressAt) || 0);
  if (!last) return null;
  const d = Math.floor((now - last) / DAY_MS);
  return d >= days ? { days: d, text: `${d}일 갱신 없음` } : null;
}

/**
 * 내 요청 진행 현황 — 내가 등록한 이슈 전부(최근 완료 포함). 열린 것 먼저(최근 갱신순), 완료는 뒤(최근 완료순).
 * 담당자가 나여도 넣는다(요청자가 스스로 맡은 경우도 '내 요청' 이다).
 */
export function myRequests(rows, me) {
  if (!me) return { open: [], done: [] };
  const mine = (Array.isArray(rows) ? rows : []).filter((r) => r && r.reporter === me);
  const open = mine.filter((r) => r.status !== 'done').sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const done = mine.filter((r) => r.status === 'done').sort((a, b) => (b.closedAt || b.updatedAt || 0) - (a.closedAt || a.updatedAt || 0));
  return { open, done };
}

/** 활동 피드 한 줄(누가 · 무엇을). 이슈 키·제목은 화면이 따로 붙인다. */
export function activityText(a) {
  if (!a || typeof a !== 'object') return '';
  if (a.field === 'comment') return `${a.by || '?'} · 댓글: ${a.to || ''}`;
  if (a.field === 'created') return `${a.by || '?'} · 이슈 생성`;
  return historyText(a);
}

/** 공유 링크 — 지금 포탈 주소의 #/issues/board/<키>. 받는 사람도 로그인해야 열리고 권한·범위는 서버가 다시 판정한다. */
export function issueLink(key, loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!/^ISS-\d{1,9}$/.test(String(key || '')) || !loc) return '';
  return `${loc.origin}${loc.pathname}#/issues/board/${key}`;
}
