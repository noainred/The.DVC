/**
 * Bareos 백업 그룹 탭의 판정·문구(v2.830 · 순수 — BareosGroupsTab.jsx 가 쓴다).
 * 스케줄 문구 scheduleText 는 서버 bareos/groupSchedule.js 와 **한 쌍**이다 — 서버가 그룹마다 scheduleText 를 주지만 편집 창은 저장 전에 미리 보여야 한다.
 *   두 벌이므로 테스트(bareosGroupText.test.js)가 서버 시험(bareosGroups2830 ①)과 같은 입력·같은 글자로 대조한다.
 * 화면 문구에 백틱을 쓰지 않는다(BoldText 규칙) · 값이 없으면 '—'.
 */
import { buildBareosTree, shortTs } from './bareosViewText.js';

export const DAY_NAMES = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
export const LEVELS = Object.freeze(['Incremental', 'Differential', 'Full']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 서버 groupSchedule.scheduleText 와 같은 글자. */
export function scheduleText(sched) {
  if (!sched || !sched.enabled) return '스케줄 꺼짐(수동 실행만)';
  const days = (sched.days || []).length === 7 ? '매일' : (sched.days || []).map((d) => DAY_NAMES[d]).join('·');
  const full = sched.fullDays?.length ? ` (Full: ${sched.fullDays.map((d) => DAY_NAMES[d]).join('·')})` : '';
  return `${days} ${sched.time} ${sched.level}${full}`;
}

/** 새 그룹 편집 창의 처음 값 — 매일 02:10 Incremental(서버 기본과 같은 모양). */
export const NEW_SCHEDULE = Object.freeze({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: '02:10', level: 'Incremental', fullDays: [] });

/**
 * 저장 전 화면 판정 — 서버가 다시 본다(이건 버튼 잠금·안내용). 문제 목록(비면 저장 가능).
 * @param {{ name, vmIds, schedule }} draft
 */
export function draftIssues(draft, { maxMembers = 200 } = {}) {
  const out = [];
  if (!String(draft?.name || '').trim()) out.push('그룹 이름을 적으세요.');
  const n = Array.isArray(draft?.vmIds) ? draft.vmIds.length : 0;
  if (!n) out.push('그룹에 넣을 VM 을 하나 이상 고르세요.');
  if (n > maxMembers) out.push(`그룹 하나에는 VM 을 ${maxMembers}대까지 넣을 수 있습니다(${n}대).`);
  const s = draft?.schedule || {};
  if (!TIME_RE.test(String(s.time || ''))) out.push('실행 시각을 HH:MM 으로 고르세요.');
  if (s.enabled && !(s.days || []).length) out.push('스케줄을 켜려면 요일을 하나 이상 고르세요.');
  return out;
}

/** 요일 하나 켜고 끄기(정렬 유지). Full 요일은 실행 요일 안에서만 남긴다. */
export function toggleDay(sched, day, key = 'days') {
  const cur = new Set(sched[key] || []);
  if (cur.has(day)) cur.delete(day); else cur.add(day);
  const next = { ...sched, [key]: [...cur].sort((a, b) => a - b) };
  if (key === 'days') next.fullDays = (next.fullDays || []).filter((d) => next.days.includes(d));
  return next;
}

/* ── 트리 필터 ── */
export const GROUP_FILTERS = Object.freeze([
  ['all', '전체'], ['bareos', 'Bareos 방식'], ['nojob', '잡 없음'], ['nogroup', '그룹 없음'], ['ingroup', '그룹 있음'],
]);
export function groupRowMatches(r, f) {
  switch (f) {
    case 'bareos': return r.method === 'bareos';
    case 'nojob': return !r.job;
    case 'nogroup': return !r.groupId;
    case 'ingroup': return !!r.groupId;
    default: return true;
  }
}
export function groupFilterCounts(vms) {
  const out = {};
  for (const [k] of GROUP_FILTERS) out[k] = 0;
  for (const r of Array.isArray(vms) ? vms : []) for (const [k] of GROUP_FILTERS) if (groupRowMatches(r, k)) out[k]++;
  return out;
}

/**
 * 이 VM 을 지금 고를 수 있나 — 편집 중인 그룹(editingId)의 VM 이거나 그룹이 없고, 등록할 수 있어야(또는 이미 잡이 있어야) 한다.
 * @returns {{ ok: boolean, why?: string }}
 */
export function pickable(r, { editingId = '', groupName = () => '' } = {}) {
  if (r.groupId && r.groupId !== editingId) return { ok: false, why: `다른 그룹 ‘${groupName(r.groupId) || '?'}’ 에 있습니다 — VM 하나는 그룹 하나에만 넣습니다.` };
  if (!r.job && !r.eligible) return { ok: false, why: r.reason || '백업 대상으로 등록할 수 없는 VM 입니다.' };
  return { ok: true };
}

/**
 * 트리(법인별 현황과 같은 빌더 — 폴더 › VM). 필터는 이 탭의 것으로 바꿔 끼운다(결과 기준 필터가 아니라 그룹 기준).
 * 폴더마다 그 아래 **고를 수 있는** VM id 를 모은다(폴더 체크박스).
 */
export function buildGroupTree(vms, { filter = 'all', q = '', editingId = '', groupName } = {}) {
  const rows = (Array.isArray(vms) ? vms : []).filter((r) => groupRowMatches(r, filter));
  const tree = buildBareosTree(rows, { filter: 'all', q });
  const fill = (n) => {
    const ids = [];
    for (const r of n.rows) if (pickable(r, { editingId, groupName }).ok) ids.push(r.id);
    for (const c of n.children) { fill(c); ids.push(...c.pickIds); }
    n.pickIds = ids;
    return n;
  };
  return fill(tree);
}

/** 폴더 체크 상태 — 고를 수 있는 VM 기준. */
export function checkState(ids, sel) {
  if (!ids?.length) return 'none';
  let n = 0;
  for (const id of ids) if (sel.has(id)) n++;
  return n === 0 ? 'none' : n === ids.length ? 'all' : 'some';
}

/* ── 실행 결과 문구 ── */
export const FIRE_STATE_TEXT = Object.freeze({ started: '시작', skipped: '건너뜀', failed: '실패', unknown: '결과 모름' });
export const FIRE_STATE_TONE = Object.freeze({ started: 'ok', skipped: 'muted', failed: 'bad', unknown: 'warn' });
/** 마지막 실행 한 줄 — '10-31 02:10 예약 · 시작 3 · 건너뜀 1'(0 인 칸은 뺀다). 실행 기록이 없으면 '—'. */
export function fireText(f) {
  if (!f) return '—';
  const parts = [`${shortTs(f.at)} ${f.trigger === 'timer' ? '예약' : '수동'}`];
  if (f.error) parts.push(`실패 — ${f.error}`);
  for (const k of ['started', 'skipped', 'failed', 'unknown']) if (f[k] > 0) parts.push(`${FIRE_STATE_TEXT[k]} ${f[k]}`);
  if (parts.length === 1) parts.push(`VM ${f.total ?? 0}대`);
  return parts.join(' · ');
}
/** 마지막 실행의 색 — 실패가 있으면 bad, 결과 모름이 있으면 warn, 시작이 있으면 ok, 그 밖 muted. */
export function fireTone(f) {
  if (!f) return 'muted';
  if (f.error || f.failed > 0) return 'bad';
  if (f.unknown > 0) return 'warn';
  return f.started > 0 ? 'ok' : 'muted';
}
/** 다음 실행 — 서버가 준 next(서버 현지 시각 기준 ms). */
export const nextText = (next) => (next?.at ? `${shortTs(next.at)} ${next.level}` : '—');
/** 스토리지·풀 한 줄 — 비면 '잡 기본값'. */
export const storageText = (g, siteDefaults) => {
  const st = g.storage || (siteDefaults?.storage ? `기본(${siteDefaults.storage})` : '기본');
  const pl = g.pool || (siteDefaults?.pool ? `기본(${siteDefaults.pool})` : '기본');
  return `${st} · ${pl}`;
};
