/**
 * views/issues/issueText.js — 이슈 트래커 화면의 판정과 문구(순수, v2.864).
 *
 * 서버(server/src/issues/store.js)가 상태·유형·우선순위 값을 정하고 여기서는 **이름과 표시**만 정한다. 판정(전이 규칙·권한)은 서버가 하고
 * 화면은 거부 사유를 그대로 보인다. 날짜는 브라우저 시각 기준이고 값이 없으면 '—'(0 이나 빈 날짜로 보이지 않게).
 */
import { dayStamp } from '../../dayStamp.js';

export const STATUS_ORDER = Object.freeze(['backlog', 'todo', 'progress', 'review', 'done']);
export const STATUS_TEXT = Object.freeze({ backlog: '백로그', todo: '할 일', progress: '진행 중', review: '검토', done: '완료' });
export const TYPE_TEXT = Object.freeze({ incident: '장애', task: '작업', request: '요청', improve: '개선', epic: '에픽' });
export const PRIORITY_TEXT = Object.freeze({ p0: 'P0 긴급', p1: 'P1 높음', p2: 'P2 보통', p3: 'P3 낮음' });
export const FIELD_TEXT = Object.freeze({
  created: '생성', status: '상태', assignee: '담당자', priority: '우선순위', dueAt: '기한', type: '유형', title: '제목', body: '본문',
  blocked: '보류', labels: '라벨', component: '컴포넌트', watchers: '관찰자', parent: '상위', sprint: '스프린트',
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
  if (f === 'parent') return h.to ? `${who}상위 ${h.from || '없음'} → ${h.to}` : `${who}상위에서 뺌(${h.from || '—'})`;
  if (f === 'sprint') return `${who}스프린트 ${h.note || `${h.from || '백로그'} → ${h.to || '백로그'}`}`;
  if (f === 'link') return h.to ? `${who}연결 더함 — ${linkLine(h.to)}` : `${who}연결 뺌 — ${linkLine(h.from)}`;
  // v2.885 C-3 — 작업 기록 · 예상 · 버전
  if (f === 'worklog') return h.to ? `${who}작업 기록 ${h.to}${h.note ? ` — ${h.note}` : ''}` : `${who}작업 기록 지움 — ${h.from || '—'}`;
  if (f === 'estimate') return `${who}예상 ${h.from || '없음'} → ${h.to || '없음'}`;
  if (f === 'fixVersion') return `${who}수정 버전 ${h.from || '없음'} → ${h.to || '없음'}`;
  if (f === 'affectsVersion') return `${who}영향 버전 ${h.from || '없음'} → ${h.to || '없음'}`;
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
export function vcenterOptions(meta, current = null) {
  const out = (meta?.vcenters || []).filter((v) => v.writable !== false).map((v) => ({ id: v.id, label: v.name }));
  // 감사 A1-01: 쓰기 범위만 지정된 계정(조회 무제한 + writeVcenters)도 공용 이슈를 만들 수 없다 — 서버 vcenterField 와 같은 기준(writeScoped).
  const needVc = !!(meta?.scoped || meta?.writeScoped);
  const list = needVc ? out : [{ id: '', label: '공용(법인 없음)' }, ...out];
  // 감사 A1-05: 수정 창은 지금 값을 선택지에 남긴다(등록에서 빠졌거나 쓰기 밖이어도 — 값이 그대로면 서버가 다시 검사하지 않는다).
  if (current != null && !list.some((o) => o.id === current)) list.unshift({ id: current, label: current ? `${vcName(meta, current)}(지금 값)` : '공용(지금 값)' });
  return list;
}
/** 법인을 반드시 골라야 하는 계정인가(범위·쓰기 범위 중 하나라도 지정). */
export const vcenterRequired = (meta) => !!(meta?.scoped || meta?.writeScoped);

/** 알림 발송 상태 한 줄 — 서버 issueNotifyStatus(). 값이 없으면 '아직 없음'. */
export function notifyStatusText(st) {
  if (!st || typeof st !== 'object') return '';
  const parts = [];
  parts.push(st.lastFlushAt ? `마지막 발송 ${timeText(st.lastFlushAt)}` : '아직 보낸 묶음이 없습니다');
  parts.push(`메일 ${st.mails ?? 0}통`);
  if (st.mailFail) parts.push(`실패 ${st.mailFail}`);
  if (st.mailSkip) parts.push(`건너뜀 ${st.mailSkip}`);
  if (st.noEmail) parts.push(`주소 없는 사람 ${st.noEmail}회`);
  if (st.mailDeferred) parts.push(`시간당 몫 초과로 미룸 ${st.mailDeferred}회`);
  if (st.outOfScope) parts.push(`법인을 볼 수 없어 뺀 수신 ${st.outOfScope}회`);
  if (st.chat || st.chatFail) parts.push(`채팅 ${st.chat ?? 0}${st.chatFail ? ` · 실패 ${st.chatFail}` : ''}`);
  if (st.dropped) parts.push(`묶음 인원 상한으로 뺀 사람 ${st.dropped}명(묶음마다 센 합)`);
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

/* ───────────── v2.880 파트 장애 → 이슈 자동 등록 ───────────── */

/** 칸 값(off/fault/warn) → 화면 글. */
export const AUTO_LEVEL_TEXT = Object.freeze({ off: '끔', fault: 'fault 만', warn: 'fault + warn' });
/** 행 순서 — 서버 kinds 중 어느 장비군이라도 지원하는 것만. */
export function autoKindRows(data) {
  const sup = data?.supported || {};
  return (data?.kinds || []).filter((k) => Object.values(sup).some((list) => Array.isArray(list) && list.includes(k)));
}
/** 켜진 칸 수(끔이 아닌 칸). */
export function autoOnCount(matrix) {
  let n = 0;
  for (const m of Object.values(matrix || {})) for (const v of Object.values(m || {})) if (v && v !== 'off') n += 1;
  return n;
}
const SKIP_TEXT = Object.freeze({ 'not-fault': '장애 아님(unknown · absent)', 'kind-off': '끈 칸', 'warn-off': 'warn 끈 칸', unsupported: '지원 안 하는 칸', 'agent-off': '법인 예외', invalid: '형식 밖' });
/** 자동 등록 상태 한 줄 — 서버 autoCreateStatus(). 실패·상한·건너뜀을 숨기지 않는다. */
export function autoStatusText(st) {
  if (!st || typeof st !== 'object') return '';
  const parts = [st.ranAt ? `마지막 처리 ${timeText(st.ranAt)}` : '아직 처리한 전이가 없습니다(포탈 시작 뒤)'];
  parts.push(`이슈 ${st.created ?? 0}건 · 붙임 ${st.attached ?? 0} · 댓글 ${st.commented ?? 0} · 검토로 ${st.review ?? 0}`);
  if (st.capped) parts.push(`하루 상한으로 안 만든 것 ${st.capped}건`);
  const sk = Object.entries(st.skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SKIP_TEXT[k] || k} ${n}`);
  if (sk.length) parts.push(`건너뜀 — ${sk.join(' · ')}`);
  if (st.errors) parts.push(`실패 ${st.errors}${st.error ? `(${st.error})` : ''}`);
  return parts.join(' · ');
}
/** 시험 실행 결과 한 줄. */
export function simulateText(r) {
  if (!r || typeof r !== 'object') return '';
  const sk = Object.entries(r.skipped || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SKIP_TEXT[k] || k} ${n}`);
  return `지난 ${r.hours}시간 파트 장애 이벤트 ${r.events}건${r.truncated ? '(최근 2,000건만 읽음)' : ''}에 대면 — 새 이슈 ${r.create}건 · 장비 이슈에 붙임 ${r.attach}건 · 댓글 ${r.comment}건`
    + `${r.capped ? ` · 하루 상한으로 안 만듦 ${r.capped}건` : ''}${sk.length ? ` · 건너뜀 ${sk.join(' · ')}` : ''}. 만들지는 않았습니다.`;
}
/** 자동 등록 이슈의 배지 글(없으면 ''). */
export function originText(o) {
  if (!o || o.kind !== 'partfault') return '';
  const dev = o.deviceName || o.deviceId || '';
  return `자동 · 파트 장애${dev ? ` · ${dev}` : ''}${o.parts > 1 ? ` · 부품 ${o.parts}` : ''}`;
}

/* ───────────── v2.882 에픽 · 하위 작업 · 스프린트 · 검색식(시안 ⑥⑦⑧) ───────────── */

/** 빠른 필터 — 검색식 한 줄씩(서버가 해석한다 · 화면은 식만 보낸다). */
export const QUICK_FILTERS = Object.freeze([
  { id: 'mine', name: '내 열린 이슈', query: 'assignee = me() AND status != done' },
  { id: 'myreq', name: '내가 등록한 요청', query: 'reporter = me() AND type = request AND status != done' },
  { id: 'overdue', name: '기한 초과', query: 'due < now() AND status != done' },
  { id: 'sprint', name: '이번 스프린트', query: 'sprint = active()' },
  { id: 'stale', name: '3일 갱신 없음', query: 'status in (progress, review) AND updated < -3d' },
  { id: 'unassigned', name: '미할당', query: 'assignee is empty AND status != done' },
]);
export const QUERY_FIELD_TEXT = Object.freeze({
  key: '키', title: '제목', text: '제목 · 본문 · 댓글', type: '유형', status: '상태', priority: '우선순위', assignee: '담당자', reporter: '보고자', watcher: '관찰자',
  vcenter: '법인', label: '라벨', component: '컴포넌트', epic: '에픽', parent: '상위', sprint: '스프린트', progress: '진행률', due: '기한', created: '생성',
  updated: '갱신', closed: '완료', doc: '관련 문서',
  fixversion: '수정 버전', affectsversion: '영향 버전', sla: 'SLA', // v2.885
});
const OP_TEXT = { '=': '=', '!=': '≠', in: '∈', 'not in': '∉', '>': '>', '>=': '≥', '<': '<', '<=': '≤', '~': '포함', 'is empty': '비어 있음', 'is not empty': '비어 있지 않음' };
const CODE_TEXT = { status: STATUS_TEXT, type: TYPE_TEXT, priority: PRIORITY_TEXT, sla: { breached: '초과', warning: '임박', paused: '멈춤', late: '늦게 지킴', ok: '정상', none: '대상 아님' } };

/** 칩 값 한 개 — me() · now() · active() · 상대 날짜 · 코드 값을 사람 말로. */
export function chipValueText(field, v, { me = '', sprintName = null, vcName = null } = {}) {
  const s = String(v ?? '');
  if (s === 'me()') return me ? `나(${me})` : '나';
  if (s === 'now()') return '오늘';
  if (s === 'active()') return '진행 중 스프린트';
  const rel = /^([+-])(\d{1,4})([dw])$/i.exec(s);
  if (rel) { const n = Number(rel[2]) * (rel[3].toLowerCase() === 'w' ? 7 : 1); return `${n}일 ${rel[1] === '-' ? '전' : '뒤'}`; }
  if (CODE_TEXT[field]?.[s.toLowerCase()]) return CODE_TEXT[field][s.toLowerCase()];
  if (field === 'sprint' && sprintName) return sprintName(s) || s;
  if (field === 'vcenter' && vcName) return vcName(s) || s;
  return s;
}
/** 칩 글 — '담당자 = 나(kim)' · '상태 ∈ 진행 중 · 검토' · 묶음은 '묶음 식'. */
export function chipText(c, opts = {}) {
  if (!c || c.op === 'expr' || !c.field) return '묶음 식(괄호 · OR)';
  const f = QUERY_FIELD_TEXT[c.field] || c.field;
  const op = OP_TEXT[c.op] || c.op;
  if (c.op === 'is empty' || c.op === 'is not empty') return `${f} ${op}`;
  return `${f} ${op} ${(c.values || []).map((v) => chipValueText(c.field, v, opts)).join(' · ')}`;
}
/**
 * 칩 하나 지우기 — 맨 위 AND 의 칸만 칩이므로 남은 칸의 원문을 ' AND ' 로 다시 잇고 정렬 부분(orderStart 뒤)을 그대로 붙인다(한 식 — 두 벌이 아니다).
 * i 가 범위 밖이면 원래 식.
 */
export function removeChip(query, clauses, i, orderStart = -1) {
  const q = String(query || '');
  const cs = Array.isArray(clauses) ? clauses : [];
  if (!(i >= 0 && i < cs.length)) return q;
  const kept = cs.filter((_, j) => j !== i).map((c) => q.slice(c.start, c.end).trim()).filter(Boolean);
  const order = orderStart >= 0 ? q.slice(orderStart).trim() : '';
  return [kept.join(' AND '), order].filter(Boolean).join(' ');
}
/** 오류 밑줄 — 식을 [{ text, bad, title }] 조각으로(첫 오류 구간만 밑줄). */
export function errorSegments(query, errors) {
  const q = String(query || '');
  const e = Array.isArray(errors) ? errors[0] : null;
  if (!e) return [{ text: q, bad: false }];
  const a = Math.max(0, Math.min(q.length, Number(e.start) || 0));
  let b = Math.max(a, Math.min(q.length, Number(e.end) || a));
  if (b === a) b = Math.min(q.length, a + 1);
  const title = `${e.msg}${e.hint ? ` — ${e.hint}` : ''}`;
  const out = [];
  if (a > 0) out.push({ text: q.slice(0, a), bad: false });
  out.push({ text: a < q.length ? q.slice(a, b) : ' ', bad: true, title });
  if (b < q.length) out.push({ text: q.slice(b), bad: false });
  return out;
}

export const SPRINT_STATE_TEXT = Object.freeze({ planned: '예정', active: '진행 중', closed: '끝남' });
/** 'MM-DD ~ MM-DD · 남은 n일' — 끝난 스프린트는 '끝남'. */
export function sprintRangeText(s) {
  if (!s) return '—';
  const md = (d) => String(d || '').slice(5) || '—';
  const tail = s.state === 'closed' ? '끝남' : s.overdue ? '기간 지남' : s.daysLeft != null ? `남은 ${s.daysLeft}일` : '';
  return `${md(s.startDay)} ~ ${md(s.endDay)}${tail ? ` · ${tail}` : ''}`;
}
export function sprintName(sprints, id) {
  if (!id) return '';
  const s = (Array.isArray(sprints) ? sprints : []).find((x) => x.id === id);
  return s ? s.name : id;
}
/** 고를 수 있는 스프린트 — 끝나지 않은 것 + 지금 값(끝났어도 보이게). */
export function sprintOptions(sprints, current = '') {
  return (Array.isArray(sprints) ? sprints : []).filter((s) => s.state !== 'closed' || s.id === current);
}

/**
 * 번다운 선 — days = [{ day, remaining|null }](null = 아직 오지 않은 날 — 그리지 않는다).
 * 기준선은 '가장 많이 남았던 수 → 마지막 날 0'(첫날 값으로 그으면 스프린트 중간에 이슈를 넣었을 때 바닥에 붙어 쓸모가 없다 — Chromium 판독).
 * 반환: { actual: 'x,y …', ideal: 'x,y x,y', max, last } — 값이 하나도 없으면 actual 은 ''.
 */
export function burnPoints(days, w, h, pad = 6) {
  const list = Array.isArray(days) ? days : [];
  const vals = list.map((d) => (Number.isFinite(d?.remaining) ? d.remaining : null));
  const known = vals.filter((v) => v != null);
  const max = Math.max(1, ...known, 0);
  const n = Math.max(1, list.length - 1);
  const x = (i) => pad + ((w - pad * 2) * i) / n;
  const y = (v) => pad + (h - pad * 2) * (1 - v / max);
  const pts = [];
  vals.forEach((v, i) => { if (v != null) pts.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`); });
  const peak = known.length ? Math.max(...known) : null;
  const ideal = peak ? `${x(0).toFixed(1)},${y(peak).toFixed(1)} ${x(list.length - 1).toFixed(1)},${y(0).toFixed(1)}` : '';
  const lastIdx = vals.reduce((m, v, i) => (v != null ? i : m), -1);
  return { actual: pts.join(' '), ideal, max, last: lastIdx >= 0 ? vals[lastIdx] : null, lastIdx };
}
/** 하위 작업 표시 — '하위 2/4'. 자식이 없으면 ''. */
export function childText(r) {
  return r && r.childCount > 0 ? `${r.type === 'epic' ? '이슈' : '하위'} ${r.childDone}/${r.childCount}` : '';
}
/** 에픽 고르기 — 이 이슈의 법인과 맞는 에픽(같은 법인 또는 공용 에픽)만, 자기 자신은 빼고. */
export function epicOptions(epics, issue) {
  const vc = issue?.vcenterId || '';
  return (Array.isArray(epics) ? epics : []).filter((e) => e.type === 'epic' && e.key !== issue?.key && (!e.vcenterId || e.vcenterId === vc));
}

/* ───────────── v2.883 연결(차단함 · 관련 · 중복) ───────────── */
/** 연결 종류 → 이 이슈에서 본 말. 저장은 만든 쪽에만 하고 반대 방향은 서버가 읽을 때 계산한다. */
export const LINK_TEXT = Object.freeze({ blocks: '이 이슈가 막는 이슈', blockedBy: '이 이슈를 막는 이슈', relates: '관련 이슈', duplicates: '원본(이 이슈는 중복)', duplicatedBy: '이 이슈의 중복' });
export const LINK_ORDER = Object.freeze(['blockedBy', 'blocks', 'relates', 'duplicates', 'duplicatedBy']);
/** 더하기 선택지 — 사람 말 순서. */
export const LINK_ADD_TEXT = Object.freeze({ blockedBy: '이 이슈를 막는 이슈', blocks: '이 이슈가 막는 이슈', relates: '관련 이슈', duplicates: '이 이슈의 원본(이 이슈가 중복)', duplicatedBy: '이 이슈의 중복' });
/** 이력의 'blocks ISS-3' → '이 이슈가 막는 이슈 ISS-3'. */
export function linkLine(v) {
  const [type, key] = String(v || '').split(' ');
  return `${LINK_TEXT[type] || type || '—'} ${key || ''}`.trim();
}
/** 연결 묶기 — [{ type, label, items }] (LINK_ORDER 순서 · 빈 종류는 뺀다). */
export function groupLinks(links) {
  const list = Array.isArray(links) ? links : [];
  return LINK_ORDER.map((t) => ({ type: t, label: LINK_TEXT[t], items: list.filter((l) => l.type === t) })).filter((g) => g.items.length);
}
/** 완료 전에 서버가 묻는 것(409) — 무엇을 확인받을지 문구. 모르는 코드는 null. */
export function statusConfirmText(r) {
  if (!r || r.ok !== false) return null;
  if (r.code === 'open-children') {
    const list = (r.children || []).slice(0, 10).map((c) => `· ${c.key} ${c.title}`).join('\n');
    return `${r.reason}\n\n${list}${(r.children || []).length > 10 ? '\n…' : ''}\n\n모두 완료로 바꾸고 이 이슈도 완료할까요? (취소하면 아무것도 바꾸지 않습니다)`;
  }
  if (r.code === 'open-blockers') {
    const list = (r.blockers || []).slice(0, 10).map((c) => `· ${c.key} ${c.title}`).join('\n');
    return `${r.reason}\n\n${list}${r.hidden ? `\n· 볼 수 없는 이슈 ${r.hidden}건` : ''}\n\n막고 있는 이슈가 열린 채로 이 이슈를 완료할까요? (막는 이슈는 그대로 둡니다)`;
  }
  return null;
}
/** 확인을 받으면 다시 보낼 때 더할 값. */
export const STATUS_CONFIRM_FLAG = Object.freeze({ 'open-children': 'closeChildren', 'open-blockers': 'ignoreBlockers' });



/* ───── v2.885 C-3 시간 추적 · SLA · 버전 ───── */
/** 분 → '1h 30m'(서버 issues/store.js minutesText 와 같은 모양). 못 읽으면 '—'. */
export function minutesText(m) {
  if (!Number.isFinite(m) || m < 0) return '—';
  const v = Math.round(m);
  const h = Math.floor(v / 60); const r = v % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
}
/**
 * 시간 입력 → 분. '90' · '90m' · '1h' · '1h 30m' · '1.5h' · '1시간 30분' · '45분' · '2d'(하루 8시간이 아니라 24시간 — 오해를 막으려 d 는 받지 않는다).
 * 못 읽거나 0 이하면 null. 상한은 서버가 본다.
 */
export function parseDuration(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s || s.length > 20) return null;
  if (/^\d{1,5}$/.test(s)) { const n = Number(s); return n > 0 ? n : null; }
  const m = /^(?:(\d{1,4}(?:\.\d{1,2})?)(?:h|시간))?(?:(\d{1,4})(?:m|분))?$/.exec(s);
  if (!m || (m[1] == null && m[2] == null)) return null;
  const total = Math.round(Number(m[1] || 0) * 60 + Number(m[2] || 0));
  return total > 0 ? total : null;
}
/** 예상 대비 기록 — '기록 2h 30m / 예상 4h (63%)' · 예상이 없으면 기록만 · 둘 다 없으면 ''. */
export function timeTrackText(r) {
  const est = Number.isInteger(r?.estimateMin) ? r.estimateMin : null;
  const spent = r?.worklogCount ? r.spentMin : null;
  if (est == null && spent == null) return '';
  if (est == null) return `기록 ${minutesText(spent)}`;
  if (spent == null) return `예상 ${minutesText(est)}`;
  return `기록 ${minutesText(spent)} / 예상 ${minutesText(est)}${est > 0 ? ` (${Math.round((spent / est) * 100)}%)` : ''}`;
}

export const SLA_STATE_TEXT = Object.freeze({ breached: '초과', late: '늦게 지킴', warning: '임박', paused: '멈춤(보류)', running: '진행', met: '지킴', off: '보지 않음' });
const STAGE_TEXT = { respond: '응답', resolve: '해결' };
/** 남은 시간 — dueAt 기준(분 단위로 내림). */
function leftText(dueAt, now) {
  const m = Math.max(0, Math.floor((dueAt - now) / 60_000));
  return minutesText(m);
}
/**
 * 카드 · 목록 배지 — 지금 볼 단계 하나. 열린 이슈의 초과 · 임박 · 멈춤만(진행 · 지킴은 배지 없음 — 화면 소음).
 * @returns {{ cls: string, text: string, title: string }|null}
 */
export function slaBadge(sla, now = Date.now()) {
  if (!sla) return null;
  const stage = ['respond', 'resolve'].find((k) => ['breached', 'warning', 'paused'].includes(sla[k]?.state));
  if (!stage) return null;
  const st = sla[stage];
  const name = STAGE_TEXT[stage];
  if (st.state === 'breached') return { cls: 'bad', text: `SLA ${name} 초과`, title: `${name} 목표 ${minutesText(st.targetMin)} — 흐른 시간 ${minutesText(st.usedMin)}(보류 제외)` };
  if (st.state === 'paused') return { cls: 'mute', text: `SLA 멈춤`, title: `보류 중이라 ${name} 시계가 멈췄습니다 — 흐른 시간 ${minutesText(st.usedMin)} / 목표 ${minutesText(st.targetMin)}` };
  return { cls: 'warn', text: `SLA ${name} ${st.dueAt ? `${leftText(st.dueAt, now)} 남음` : '임박'}`, title: `${name} 목표 ${minutesText(st.targetMin)} — 흐른 시간 ${minutesText(st.usedMin)}(보류 제외)` };
}
/** 상세의 단계 한 줄 — '응답: 지킴 · 12m / 목표 15m' · '해결: 진행 · 1h 2m / 목표 4h · 2h 58m 남음'. */
export function slaStageText(kind, st, now = Date.now()) {
  if (!st) return '';
  const name = STAGE_TEXT[kind] || kind;
  if (st.state === 'off') return `${name}: 보지 않음(목표 0)`;
  const used = st.usedMin == null ? '—' : minutesText(st.usedMin);
  const left = st.dueAt ? ` · ${leftText(st.dueAt, now)} 남음` : '';
  return `${name}: ${SLA_STATE_TEXT[st.state] || st.state} · ${used} / 목표 ${minutesText(st.targetMin)}${left}`;
}

/** 버전 비교(숫자 마디) — x.y.z 가 아니면 null. */
export function versionCmp(a, b) {
  const re = /^\d{1,6}(\.\d{1,6}){0,3}$/;
  if (!re.test(String(a || '')) || !re.test(String(b || ''))) return null;
  const pa = String(a).split('.').map(Number); const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
}
/** 수정 버전이 이 포탈에 들어왔는가 — 'in'(지금 판 이하) · 'later'(아직) · null(포탈 버전 표기가 아니다 — 판정하지 않는다). */
export function fixVersionState(fixVersion, portalVersion) {
  const c = versionCmp(fixVersion, portalVersion);
  return c == null ? null : c <= 0 ? 'in' : 'later';
}

/**
 * v2.885 C-2 CSV 내보내기 매개변수 — 화면의 걸러보기(filterRows)를 서버 목록 매개변수로 옮긴다(서버가 범위 → 같은 조건으로 다시 거른다).
 * 미할당('__none')은 assignee='' · 공용('__none')은 vcenterId='' · '내 이슈만' 은 assignee=me. 검색 글자는 서버 q(본문까지 본다 — 화면보다 넓을 수 있다).
 */
export function csvParams(filters = {}, me = '', { done = 'recent', query = '' } = {}) {
  const p = { done };
  if (query) p.query = query;
  if (filters.q?.trim()) p.q = filters.q.trim();
  if (filters.mine) p.assignee = me;
  else if (filters.assignee) p.assignee = filters.assignee === '__none' ? '' : filters.assignee;
  for (const k of ['priority', 'type', 'status']) if (filters[k]) p[k] = filters[k];
  if (filters.vcenterId) p.vcenterId = filters.vcenterId === '__none' ? '' : filters.vcenterId;
  return p;
}

/** v2.885 필터 화면이 마지막 검색식을 기억하는 세션 저장 키(IssuesPlus FiltersView) — 다른 화면이 검색식으로 필터 화면을 열 때도 쓴다. */
export const ISSUE_QUERY_KEY = 'issues.query';
/** 다른 화면(릴리스 노트)에서 검색식으로 이슈 필터 화면을 연다. */
export function openIssueQuery(query) {
  try { window.sessionStorage.setItem(ISSUE_QUERY_KEY, String(query || '')); } catch { /* 저장소를 못 쓰는 브라우저 — 빠른 필터로 시작한다 */ }
  window.location.hash = '#/issues/filters';
}

/* ───── v2.886 C-5 캘린더 ───── */
const pad2c = (n) => String(n).padStart(2, '0');
/** 달력 한 달 — 월요일 시작 주(7칸) 배열. 칸 = { day:'YYYY-MM-DD', inMonth }. month 는 1~12. */
export function monthGrid(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // 월=0
  const start = Date.UTC(year, month - 1, 1 - lead);
  const daysIn = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weeks = Math.ceil((lead + daysIn) / 7);
  const out = [];
  for (let w = 0; w < weeks; w += 1) {
    const row = [];
    for (let k = 0; k < 7; k += 1) {
      const d = new Date(start + (w * 7 + k) * 86_400_000);
      row.push({ day: `${d.getUTCFullYear()}-${pad2c(d.getUTCMonth() + 1)}-${pad2c(d.getUTCDate())}`, inMonth: d.getUTCMonth() === month - 1 });
    }
    out.push(row);
  }
  return out;
}
/** 이슈를 기한 날짜(브라우저 날짜 — 기한 입력과 같은 기준)별로. 기한 없는 것은 따로 센다. */
export function issuesByDay(rows) {
  const m = new Map(); let none = 0;
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = toDateInput(r?.dueAt);
    if (!d) { none += 1; continue; }
    if (!m.has(d)) m.set(d, []);
    m.get(d).push(r);
  }
  for (const list of m.values()) list.sort((a, b) => (a.priority || '').localeCompare(b.priority || '') || a.num - b.num);
  return { byDay: m, none };
}
/** 스프린트 표지 — 그날 시작 · 끝인 스프린트 이름. sprints = [{name,startDay,endDay,state}] */
export function sprintMarks(sprints, day) {
  const out = [];
  for (const s of Array.isArray(sprints) ? sprints : []) {
    if (s.startDay === day) out.push({ name: s.name, kind: 'start' });
    if (s.endDay === day) out.push({ name: s.name, kind: 'end' });
  }
  return out;
}
/** 달 이동 — { y, m } ± n 달. */
export function shiftMonth({ y, m }, n) {
  const t = (y * 12 + (m - 1)) + n;
  return { y: Math.floor(t / 12), m: (t % 12 + 12) % 12 + 1 };
}
