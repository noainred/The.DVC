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

/* ── 트리 필터(v2.831 시안 — 전체 · 그룹 없음 · 켜진 VM · 잡 없음) ── */
export const GROUP_FILTERS = Object.freeze([['all', '전체'], ['nogroup', '그룹 없음'], ['on', '켜진 VM'], ['nojob', '잡 없음']]);
/** editingId: 편집 중인 그룹 — 그 그룹의 VM 은 '그룹 없음' 에도 보인다(고를 수 있으므로). */
export function groupRowMatches(r, f, editingId = '') {
  switch (f) {
    case 'nogroup': return !r.groupId || (!!editingId && r.groupId === editingId);
    case 'on': return r.power === 'POWERED_ON';
    case 'nojob': return !r.job;
    default: return true;
  }
}
export function groupFilterCounts(vms, editingId = '') {
  const out = {};
  for (const [k] of GROUP_FILTERS) out[k] = 0;
  for (const r of Array.isArray(vms) ? vms : []) for (const [k] of GROUP_FILTERS) if (groupRowMatches(r, k, editingId)) out[k]++;
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
  const rows = (Array.isArray(vms) ? vms : []).filter((r) => groupRowMatches(r, filter, editingId));
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
// v2.830 검토 L3·L4: '보내지 못함'(Director 에 닿기 전 — 인증 정지·접속 실패·옛 엣지)과 '실패'(Director 가 거부)·'결과 모름'(명령 도중 끊김)을 나눈다
export const FIRE_STATE_TEXT = Object.freeze({ started: '시작', skipped: '건너뜀', notsent: '보내지 못함', failed: '실패', unknown: '결과 모름' });
export const FIRE_STATE_TONE = Object.freeze({ started: 'ok', skipped: 'muted', notsent: 'bad', failed: 'bad', unknown: 'warn' });
const FIRE_COUNT_KEYS = Object.freeze([['started', 'started'], ['skipped', 'skipped'], ['notSent', 'notsent'], ['failed', 'failed'], ['unknown', 'unknown']]);
/** 마지막 실행 한 줄 — '10-31 02:10 예약 · 시작 3 · 건너뜀 1'(0 인 칸은 뺀다). 실행 기록이 없으면 '—'. */
export function fireText(f) {
  if (!f) return '—';
  const parts = [`${shortTs(f.at)} ${f.trigger === 'timer' ? '예약' : '수동'}`];
  if (f.error) parts.push(`실패 — ${f.error}`);
  for (const [k, st] of FIRE_COUNT_KEYS) if (f[k] > 0) parts.push(`${FIRE_STATE_TEXT[st]} ${f[k]}`);
  if (parts.length === 1) parts.push(`VM ${f.total ?? 0}대`);
  return parts.join(' · ');
}
/** 마지막 실행의 색 — 실패가 있으면 bad, 결과 모름이 있으면 warn, 시작이 있으면 ok, 그 밖 muted. */
export function fireTone(f) {
  if (!f) return 'muted';
  if (f.error || f.failed > 0 || f.notSent > 0) return 'bad';
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

/* ── v2.831 시안 — 스케줄·보관·실행 이력 ── */
/** 매일(요일 7개)인가. */
export const isDaily = (sched) => (sched?.days || []).length === 7;
/** 매일 ↔ 매주 바꾸기 — 매주로 바꾸면 일요일 하나에서 시작(이미 고른 요일이 있으면 그대로). Full 요일은 실행 요일 안에서만. */
export function setCadence(sched, daily) {
  const days = daily ? [0, 1, 2, 3, 4, 5, 6] : (isDaily(sched) || !(sched.days || []).length ? [0] : sched.days.slice());
  return { ...sched, days, fullDays: (sched.fullDays || []).filter((d) => days.includes(d)) };
}
/** 카드·상세의 스케줄 두 줄 — main '매일 02:10' · sub 'Incremental · 일요일 Full'. 꺼짐이면 '—' · '수동 실행만'. */
export function scheduleParts(sched) {
  if (!sched || !sched.enabled) return { main: '—', sub: '수동 실행만' };
  const days = isDaily(sched) ? '매일' : `매주 ${(sched.days || []).map((d) => DAY_NAMES[d]).join('·')}`;
  const full = sched.fullDays?.length ? ` · ${sched.fullDays.map((d) => `${DAY_NAMES[d]}요일`).join('·')} Full` : '';
  return { main: `${days} ${sched.time}`, sub: `${sched.level}${full}` };
}

export const KEEP_PRESETS = Object.freeze([3, 7, 14, 30]);
/** '제한 없음' 을 끌 때 처음 보이는 값(시안 14). 새 그룹의 처음 값은 제한 없음(null — v2.831.1 사용자 결정). */
export const KEEP_DEFAULT = 14;
export const NEW_GROUP_KEEP = null;
/** 서버 groupRetention.keepText 와 같은 글자(시험이 대조). */
export const keepText = (keep) => (keep == null ? '보관 개수 제한 없음' : `최근 ${keep}회 보관`);
/** −/+ — 범위 안으로. */
export const stepKeep = (keep, d, { min = 1, max = 365 } = {}) => Math.min(max, Math.max(min, (Number.isInteger(keep) ? keep : KEEP_DEFAULT) + d));
/** 보관 개수 풀이 — 매일이면 며칠치, 매주면 몇 주치(스케줄 기준 · 수동 실행도 한 회로 센다). */
export function keepMeaning(keep, sched) {
  if (keep == null) return 'Director 의 보존 설정(풀·클라이언트 보존 기간)만 따릅니다.';
  if (!sched?.enabled) return `수동 실행 ${keep}회분`;
  const per = (sched.days || []).length;
  if (!per) return `${keep}회분`;
  if (per === 7) return `매일이면 ${keep}일치`;
  const weeks = Math.round((keep / per) * 10) / 10;
  return `주 ${per}회면 약 ${weeks}주치`;
}
/**
 * 카드·상세의 보관 두 줄 — 마지막 정리 결과(lastPrune) 기준. 보유 수는 VM 마다 다를 수 있어 범위로('3~14').
 * 체인(기준 Full)을 지키려고 보관 개수보다 많이 남을 수 있다 — 그 사실을 밝힌다.
 */
export function keepParts(g) {
  if (g?.keep == null) return { main: '제한 없음', sub: 'Director 보존 설정을 따름' };
  const p = g.lastPrune;
  if (!p) return { main: `최근 ${g.keep}회`, sub: '첫 정리 전 — 그룹 백업이 끝나면 정리합니다' };
  const lo = p.keptMin; const hi = p.keptMax;
  const held = lo == null ? '—' : lo === hi ? String(lo) : `${lo}~${hi}`;
  const parts = [];
  if (p.failed > 0) parts.push(`정리 실패 ${p.failed}`);
  if (p.notDeleted > 0) parts.push(`지우지 못함 ${p.notDeleted}`);
  if (p.unknownDeleted > 0) parts.push(`지웠는지 모름 ${p.unknownDeleted}`);
  if (p.noBase > 0) parts.push(`기준 Full 없음 ${p.noBase}대(지우지 않음)`);
  if (hi != null && hi > g.keep) parts.push('Full 체인 유지로 더 남김');
  parts.push(`마지막 정리 ${shortTs(p.at)}${p.deleted ? ` · ${p.deleted}건 지움` : ''}`);
  // 체인 때문에 보관 개수보다 많이 남으면 '3개 중 7개' 처럼 읽히지 않게 순서를 바꾼다
  const main = hi != null && hi > g.keep ? `${held}개 보유 · 보관 ${g.keep}회` : `${g.keep}개 중 ${held}개 보유`;
  return { main, sub: parts.join(' · '), bad: p.failed > 0 || p.notDeleted > 0 || p.unknownDeleted > 0 };
}
/**
 * 실행 이력 한 줄의 보관 표지 — 마지막 정리의 기준 Full 시작 시각(VM 마다 baseMin~baseMax) 기준(추정 — 카탈로그 시각 = Director 현지 시각).
 * 한 회차의 백업은 그 회차부터 다음 회차 전까지 시작한다고 본다: 다음 회차가 baseMin 이하 → 전부 정리됨 · 다음 회차가 없거나 baseMax 보다 뒤 → 보관 중 · 그 사이 → 일부 정리.
 * 보관 개수가 없거나·정리 기록이 없거나·시작한 백업이 없으면 null(표지를 달지 않는다 — 모르는 것을 단정하지 않는다).
 * @param {object} f  fires[i] · @param {object|null} next  fires[i-1](더 최근 회차) · @param {object} g
 */
export function fireKeepBadge(f, next, g) {
  const p = g?.lastPrune;
  if (g?.keep == null || !p || !(f?.started > 0) || p.baseMin == null || p.baseMax == null) return null;
  if (next && next.at <= p.baseMin) return 'pruned';
  if (!next || next.at > p.baseMax) return 'kept';
  return 'partial';
}
export const KEEP_BADGE_TEXT = Object.freeze({ kept: '보관 중', pruned: '정리됨', partial: '일부 정리' });
/** 남은 시간 — '17시간 55분 뒤'(음수·모름은 ''). */
export function untilText(ms) {
  if (!(ms > 0)) return '';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}분 뒤`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}시간 ${m % 60}분 뒤`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간 뒤`;
}
/** 그룹 VM 들의 마지막 결과(법인별 현황과 같은 판정 — b) → 성공(경고 포함)·실패·진행·기록 없음 수. */
export function memberResults(rows) {
  const out = { n: 0, ok: 0, warn: 0, fail: 0, run: 0, never: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    out.n++;
    const b = r?.b;
    if (b?.run) out.run++;
    if (b?.st === 'ok') out.ok++;
    else if (b?.st === 'warning') out.warn++;
    else if (b?.st === 'error' || b?.st === 'canceled') out.fail++;
    else if (!b?.run) out.never++;
  }
  return out;
}
/** 카드 오른쪽 위 표지 — 진행 · 실패 · 성공 · 기록 없음. */
export function resultBadge(m) {
  if (!m?.n) return { text: 'VM 없음', tone: 'muted' };
  if (m.run) return { text: `진행 ${m.run}/${m.n}`, tone: 'run' };
  if (m.fail) return { text: `실패 ${m.fail} · 성공 ${m.ok + m.warn}`, tone: 'bad' };
  if (m.ok + m.warn) return { text: `성공 ${m.ok + m.warn}/${m.n}${m.warn ? ` (경고 ${m.warn})` : ''}`, tone: m.never ? 'warn' : 'ok' };
  return { text: '백업 기록 없음', tone: 'muted' };
}
/** 멤버 폴더 요약 — 하나면 그 폴더, 여럿이면 '첫 폴더 외 N곳'. */
export function folderSummary(rows) {
  const set = [...new Set((Array.isArray(rows) ? rows : []).map((r) => r.folder || '').filter(Boolean))].sort();
  if (!set.length) return '—';
  return set.length === 1 ? set[0] : `${set[0]} 외 ${set.length - 1}곳`;
}
/** 멤버 용량 합(GB) — 못 읽은 VM 은 빼고 그 수를 따로. */
export function sizeSum(rows) {
  let gb = 0; let unknown = 0;
  for (const r of Array.isArray(rows) ? rows : []) { if (typeof r?.gb === 'number' && Number.isFinite(r.gb)) gb += r.gb; else unknown++; }
  return { gb, unknown };
}

/**
 * v2.831.1 보관 개수 저장의 본인 OTP 판정 — 서버 groupRetention.keepOtpReasons 와 같은 글자(시험이 같은 입력으로 대조).
 * 화면은 이 결과로 OTP 칸을 연다(서버가 다시 판정한다 — 어긋나면 서버의 needOtp 응답이 칸을 연다).
 */
export function keepOtpReasons(prev, next, hasJob = () => true) {
  const nk = next?.keep === undefined ? (prev?.keep ?? null) : next.keep;
  if (nk == null) return [];
  if (!prev) return [`보관 개수(최근 ${nk}회)를 정한 새 그룹`];
  const pk = prev.keep ?? null;
  const out = [];
  if (pk == null) out.push(`보관 개수를 처음 정함(최근 ${nk}회)`);
  else if (nk < pk) out.push(`보관 개수를 줄임(${pk} → ${nk}회)`);
  const had = new Set(Array.isArray(prev.vmIds) ? prev.vmIds : []);
  const added = (Array.isArray(next?.vmIds) ? next.vmIds : []).filter((id) => !had.has(id) && hasJob(id)).length;
  if (added && pk != null && nk >= pk) out.push(`백업 기록이 있을 수 있는 VM ${added}대를 더함`);
  return out;
}

/**
 * v2.843 보관 정리 미리 보기 결과 한 줄(순수 — 서버 groupRunner.previewPrune 응답). 지우지 않았다는 것 · 지금 카탈로그 기준이라는 것을 함께 말한다.
 * 못 읽은 VM 은 개수에 넣지 않았다고 따로 센다(0 으로 섞지 않는다).
 * @returns {{ text: string, tone: 'warn'|'ok'|'bad' }}
 */
export function prunePreviewText(r) {
  if (!r || typeof r !== 'object') return { text: '', tone: 'ok' };
  const keep = Number.isInteger(r.keep) ? r.keep : null;
  const jobs = Number(r.jobs) || 0;
  const would = Number(r.would) || 0;
  const failed = Number(r.failed) || 0;
  if (!jobs) return { text: '이 그룹에는 Bareos 잡이 등록된 VM 이 없습니다 — 지울 실행 기록이 없습니다.', tone: 'ok' };
  const parts = [];
  if (would > 0) parts.push(`**지금 정리하면 VM ${Number(r.vms) || 0}대에서 실행 기록 ${would}건을 카탈로그에서 지웁니다**(VM 마다 최근 ${keep ?? '—'}회 성공 백업과 그 체인의 기준 Full 은 남깁니다).`);
  else parts.push(`지금 정리하면 지울 실행 기록이 없습니다(확인한 잡 ${jobs - failed}개 — 모두 최근 ${keep ?? '—'}회 안이거나 지우지 않는 조건).`);
  if (failed) parts.push(`${failed}대는 확인하지 못했습니다(아래 사유) — 개수에 넣지 않았습니다.`);
  if (r.noBase) parts.push(`${r.noBase}대는 기준 Full 을 찾지 못해 지우지 않습니다.`);
  parts.push('아무것도 지우지 않은 미리 보기이고 지금 카탈로그 기준입니다 — 실제 정리는 그룹 백업이 끝난 뒤라 그사이 백업이 늘면 그만큼 더 지웁니다.');
  return { text: parts.join(' '), tone: failed ? 'bad' : would > 0 ? 'warn' : 'ok' };
}
