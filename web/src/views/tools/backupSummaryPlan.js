/**
 * Backup › Summary 아래 두 구획(v2.838 — 시안 ① '용량과 일정' · '통합 에러 로그')의 순수 함수. 화면(BackupSummaryCapSched · BackupSummaryErrors)과 테스트가 쓴다.
 *   값은 서버가 센다(GET /tools/backup-summary · /schedule · /errors) — 여기서는 배치 · 글자만 만든다. 못 읽은 값은 '—'(0 이 아니다).
 */
import { bytesText } from './backupSummaryText.js';

const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const p2 = (n) => String(n).padStart(2, '0');
const WD = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 법인별 백업된 용량(시안 '큰 순') — Veeam 복원 지점 합 · Bareos 마지막 실행 크기 합(서버 pa.vbytes · pa.bbytes).
 *   읽은 VM 이 없으면 그 쪽은 null(0 이 아니다) · 한쪽을 못 읽은 법인은 partial(화면 '*').
 * @returns {{ items: Array<{id,name,v,b,total,partial}>, more:number, max:number }}
 */
export function capacityRows(rows, n = 5) {
  const all = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    const pa = r?.pa || {};
    const v = pa.vbytesN > 0 && fin(pa.vbytes) ? pa.vbytes : null;
    const b = pa.bbytesN > 0 && fin(pa.bbytes) ? pa.bbytes : null;
    if (v == null && b == null) continue;
    const partial = !!r.bareosUnknown || (!!r.veeamState && r.veeamState !== 'ok' && r.veeamState !== 'unlinked');
    all.push({ id: r.id, name: r.name || r.id, v, b, total: (v || 0) + (b || 0), partial });
  }
  all.sort((a, b) => b.total - a.total || String(a.name).localeCompare(String(b.name)));
  const items = n > 0 ? all.slice(0, n) : all;
  return { items, more: all.length - items.length, max: all.length ? all[0].total : 0 };
}
/** 막대 폭(%) — 가장 큰 법인 = 100. 0 이면 0. */
export const barPct = (x, max) => (fin(x) && max > 0 ? Math.max(0, Math.min(100, Math.round((x / max) * 1000) / 10)) : 0);

/** 30일 선(svg polyline points) — [[day, used], ...] 를 w×h 안에(위 여백 4). 점이 둘보다 적으면 ''. */
export function linePoints(series, w = 220, h = 44) {
  const s = Array.isArray(series) ? series.filter((p) => Array.isArray(p) && fin(p[0]) && fin(p[1])) : [];
  if (s.length < 2) return '';
  const x0 = s[0][0]; const x1 = s[s.length - 1][0];
  const ys = s.map((p) => p[1]); const lo = Math.min(...ys); const hi = Math.max(...ys);
  const sx = (d) => (x1 === x0 ? 0 : ((d - x0) / (x1 - x0)) * (w - 4) + 2);
  const sy = (v) => (hi === lo ? h / 2 : h - 4 - ((v - lo) / (hi - lo)) * (h - 8));
  return s.map((p) => `${Math.round(sx(p[0]))},${Math.round(sy(p[1]))}`).join(' ');
}

/** 저장소 여유 경고 글자(EM — 전체 범위 계정만). em 이 없으면 null(화면이 '전체 범위 계정만' 을 밝힌다). */
export function repoWarn(em) {
  if (!em) return null;
  const r = em.repo;
  if (!r) return { head: 'Veeam 저장소 — 읽은 값 없음', tone: 'muted', items: [] };
  const items = (r.over || []).map((x) => ({ text: `${x.name} ${x.pct}%`, left: fin(x.daysLeft) ? `남은 일수 추정 ${x.daysLeft}일` : '남은 일수 추정 불가(이력 부족 · 증가 없음)', vc: Array.isArray(x.vc) && x.vc.length ? x.vc.join(', ') : '' }));
  return { head: r.overN ? `Veeam 저장소 ${r.overN}곳 90% 넘음` : 'Veeam 저장소 90% 넘은 곳 없음', tone: r.overN ? 'warn' : 'ok', items, more: Math.max(0, (r.overN || 0) - items.length) };
}

/** 24시간 눈금 시작 — 지금이 든 정시(브라우저 시각). */
export const hourStart = (now) => Math.floor(now / HOUR) * HOUR;
/** 24칸 머리 — 'HH'(브라우저 시각 · 한국 사용자는 KST). */
export const hourLabels = (from) => Array.from({ length: 24 }, (_, i) => p2(new Date(from + i * HOUR).getHours()));
/**
 * 띠 위치(%) — [from, from+24h] 안으로 자른다. 창 밖이면 null. 너무 짧아도 보이게 최소 0.8%.
 * @param {{at:number, end:number}} it
 */
export function barOf(it, from, hours = 24) {
  if (!fin(it?.at) || !fin(it?.end)) return null;
  const to = from + hours * HOUR;
  const s = Math.max(it.at, from); const e = Math.min(it.end, to);
  if (!(e > s) && !(it.at >= from && it.at < to)) return null;
  const left = ((s - from) / (to - from)) * 100;
  const width = Math.max(0.8, ((Math.max(e, s) - s) / (to - from)) * 100);
  return { left: Math.round(left * 10) / 10, width: Math.round(Math.min(width, 100 - left) * 10) / 10 };
}
/** 시각 'HH:MM'(브라우저 시각). */
export const hm = (ms) => (fin(ms) ? `${p2(new Date(ms).getHours())}:${p2(new Date(ms).getMinutes())}` : '—');
/** 7일 칸 머리 — 첫 칸 '오늘(요일)' · 그 뒤 '요일 MM-DD'. */
export function dayLabel(day, i) {
  const d = new Date(day + 12 * HOUR);   // 포탈 0시가 브라우저와 달라도 그날 한낮으로 요일을 읽는다
  return i === 0 ? `오늘(${WD[d.getDay()]})` : `${WD[d.getDay()]} ${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** 겹침 경고 한 줄(시안 'OC2 21:00~05:00 Veeam 잡 58개와 Bareos 그룹 19개가 같은 창'). 없으면 ''. */
export function overlapText(row) {
  const o = row?.overlap;
  if (!o) return '';
  return `${row.name} ${hm(o.from)}~${hm(o.to)} Veeam 잡 ${o.veeam}개와 Bareos 그룹 회차 ${o.bareos}개가 같은 창`;
}
/** 법인 줄 정렬 — 24시간 안에 가장 먼저 시작하는 것 먼저 · 일정이 없는 법인은 뒤. */
export function sortSchedRows(rows) {
  const first = (r) => Math.min(...[...(r.veeam || []), ...(r.bareos || [])].map((x) => x.at).filter(fin), Infinity);
  return [...(Array.isArray(rows) ? rows : [])].sort((a, b) => first(a) - first(b) || String(a.name).localeCompare(String(b.name)));
}

/* ── 통합 에러 로그 ── */
export const ERROR_KIND = Object.freeze({
  fail: { text: '실패', color: '#fca5a5', bg: 'rgba(239,68,68,.16)' },
  warn: { text: '경고', color: '#fcd34d', bg: 'rgba(245,158,11,.16)' },
  stuck: { text: '멈춤 의심', color: '#fcd34d', bg: 'rgba(245,158,11,.16)' },
  collect: { text: '수집 오류', color: '#fca5a5', bg: 'rgba(239,68,68,.10)' },
  volume: { text: '오류 볼륨', color: '#fdba74', bg: 'rgba(249,115,22,.16)' },   // v2.840 Bareos 정책 수집본의 VolStatus Error(수집 시각)
});
export const ERROR_SRC = Object.freeze({
  veeam: { text: 'Veeam', color: '#93c5fd', bg: 'rgba(59,130,246,.18)' },
  bareos: { text: 'Bareos', color: '#5eead4', bg: 'rgba(20,184,166,.18)' },
  collect: { text: '포탈 수집', color: '#cbd5e1', bg: 'rgba(148,163,184,.16)' },
});
export const ERROR_DAY_OPTS = Object.freeze([[1, '24시간'], [7, '7일'], [30, '30일']]);
/** 결과 칩 · 솔루션 칩 거르기 — kind '' = 전체 · src '' = 둘 다(수집 오류는 솔루션을 고르면 빠진다). */
export function filterErrors(rows, { kind = '', src = '' } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => (!kind || r.kind === kind) && (!src || r.src === src));
}
/** 대상 칸 — 굵은 글자(잡 또는 VM) · 옅은 글자(VM · jobid · 서버). */
export function errorTarget(r) {
  const main = r.job || r.vm || r.server || '—';
  const sub = [r.job && r.vm ? r.vm : '', r.jobid ? `jobid ${r.jobid}` : '', !r.vm && r.server && r.job ? r.server : ''].filter(Boolean).join(' · ');
  return { main, sub };
}
/**
 * 열기 — 그 행의 원문을 보는 화면(권한이 없으면 없음). 링크는 화면 주소만(도구 키 그대로).
 * @returns {{ key, text, hash? } | null}
 */
export function errorOpen(r, { canBareos = false, canBareosView = false, admin = false } = {}) {
  if (r.open === 'detail') return { key: 'detail', text: 'Detail' };
  // v2.872(시안 docs/design/bareos-errlog ①): 그 실행의 로그를 이 화면 서랍에서 — 예전 고정 주소 '실행 이력' 은 대상 목록의 첫 VM 을 보였다(사용자 스크린샷)
  if (r.open === 'bareos') return canBareos ? (r.jobKey && r.jobid ? { key: 'log', text: '로그' } : { key: 'hash', text: '진행 · 이력', hash: '#/tools/bareos-backup/runs' }) : canBareosView ? { key: 'hash', text: 'Bareos', hash: '#/tools/bareos-summary' } : null;
  if (r.open === 'live') return canBareos ? { key: 'hash', text: '진행 현황', hash: '#/tools/bareos-backup/live' } : null;
  if (r.open === 'em') return { key: 'hash', text: 'Veeam', hash: '#/tools/backup-em' };
  if (r.open === 'bareos-settings') return canBareos && admin ? { key: 'hash', text: '설정', hash: '#/tools/bareos-backup/settings' } : null;
  if (r.open === 'pools') return canBareosView ? { key: 'hash', text: '보존 · 풀', hash: '#/tools/bareos-summary/pools' } : null;   // v2.840 오류 볼륨
  return null;
}
/** 같은 모양 칸(v2.872 — 예전 '같은 원인') — 2건 이상이면 'N건' · 아니면 '—'. 같은 원인인지는 묶음 로그가 로그를 읽은 뒤에만 말한다. */
export const sameText = (n) => (fin(n) && n > 1 ? `${n}건` : '—');

/* ── v2.872 로그 서랍 · 묶어 보기(시안 docs/design/bareos-errlog · 사용자 컨펌 2026-11-04 — 따로 보기와 묶어 보기 둘 다) ── */

/** '이력 →' — 진행 · 이력에서 그 VM · 그 jobid 의 로그를 연 채로(bareosViewText.saveRunFocus). 운영 권한 · 원장 잡이 있을 때만. */
export function errorHistory(r, { canBareos = false } = {}) {
  return canBareos && r?.open === 'bareos' && r.jobKey && r.vmId ? { key: 'history', text: '이력 →', hash: '#/tools/bareos-backup/runs' } : null;
}
/** 서랍이 열 실행 — 로그를 읽을 수 있는 Bareos 실행 행만(원장 잡 id · jobid). */
export const canOpenLog = (r) => r?.src === 'bareos' && r.open === 'bareos' && !!r.jobKey && Number.isInteger(r.jobid) && r.jobid > 0;
/** 서랍의 작업 대상(JobLogPanel 의 job) — 원장 잡 id · VM 이름. 쓰기 범위를 모르므로 Full 실행 단추는 서랍에 두지 않는다(이력 → 에서). */
export const logJobOf = (r) => ({ id: r.jobKey, vmName: r.vm || r.job || '', writable: false });
/** 서랍이 기다릴 시한의 Director 표지 — 엣지 대행 법인이면 엣지 회신 시한(서버 relayLimits)만큼(bareosText.withRelayWait). */
export const logDirOf = (r) => (r?.relay ? { agent: 'edge' } : null);

/** 보기(따로 · 묶어) — 브라우저에 기억(사람별 편의 · 못 읽으면 따로). */
export const ERROR_VIEWS = Object.freeze([['rows', '따로 보기'], ['groups', '묶어 보기']]);
const VIEW_KEY = 'backup-summary.errors.view';
export function loadErrorView(storage = globalThis.localStorage) {
  try { const v = storage?.getItem(VIEW_KEY); return ERROR_VIEWS.some(([k]) => k === v) ? v : 'rows'; } catch { return 'rows'; }
}
export function saveErrorView(v, storage = globalThis.localStorage) {
  try { storage?.setItem(VIEW_KEY, v); } catch { /* 기억만 못 함 */ }
}

/** 잡 이름들의 공통 앞부분 + '*'(모두 같으면 그 이름 · 공통이 3자 미만이면 '여러 잡'). */
export function jobPattern(names) {
  const xs = [...new Set((Array.isArray(names) ? names : []).map((x) => String(x || '')).filter(Boolean))];
  if (!xs.length) return '';
  if (xs.length === 1) return xs[0];
  let p = xs[0];
  for (const x of xs.slice(1)) { let i = 0; while (i < p.length && i < x.length && p[i] === x[i]) i++; p = p.slice(0, i); }
  return p.length >= 3 ? `${p}*` : '여러 잡';
}

/**
 * 묶어 보기 — 거른 낱건(rows · 새것 먼저)을 서버의 묶음 id(group)로 모은다. 묶음 순서는 그 묶음의 가장 새 행 순서. 순수.
 *   group 이 없는 행(구버전 서버)은 저마다 한 묶음. 거르기 칩은 낱건에 걸리고 묶음 크기는 남은 낱건으로 다시 센다.
 * @returns {{ id, rows, n, head, newest, oldest, target, vms, runs }[]}  runs = 로그를 읽을 수 있는 실행 수
 */
export function groupErrors(rows) {
  const by = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r, i) => {
    const id = r?.group || `row${i}`;
    const g = by.get(id);
    if (g) g.rows.push(r); else by.set(id, { id, rows: [r] });
  });
  return [...by.values()].map((g) => {
    const head = g.rows[0];
    const ats = g.rows.map((r) => r.at).filter(fin);
    const vms = new Set(g.rows.map((r) => r.vmId || r.vm).filter(Boolean)).size;
    return { id: g.id, rows: g.rows, n: g.rows.length, head, newest: ats.length ? Math.max(...ats) : null, oldest: ats.length ? Math.min(...ats) : null,
      target: g.rows.length > 1 ? jobPattern(g.rows.map((r) => r.job)) : (head.job || head.vm || head.server || '—'), vms, runs: g.rows.filter(canOpenLog).length };
  });
}
/**
 * 묶어 보기 정렬 — 묶음 단위(펼친 낱건은 묶음을 따라간다 · 공용 STable 은 행을 낱개로 섞어 묶음이 깨진다 — GPU 계층 표와 같은 방식). 순수.
 *   key: time(가장 새 시각) · corp · src · target · kind · msg · n · 모르는 값은 방향과 무관하게 뒤.
 */
export const GROUP_SORT_KEYS = Object.freeze(['time', 'corp', 'src', 'target', 'kind', 'msg', 'n']);
export function sortGroups(groups, { key = 'time', dir = 'desc' } = {}) {
  const val = (g) => ({ time: g.newest, corp: g.head?.vcName || null, src: g.head?.src || null, target: g.target || null, kind: g.head?.kind || null, msg: g.head?.msg || null, n: g.n }[key] ?? null);
  const sgn = dir === 'asc' ? 1 : -1;
  return [...(Array.isArray(groups) ? groups : [])].map((g, i) => ({ g, i, v: val(g) })).sort((a, b) => {
    if (a.v === null || a.v === '') return b.v === null || b.v === '' ? a.i - b.i : 1;
    if (b.v === null || b.v === '') return -1;
    const c = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v), 'ko');
    return c ? c * sgn : a.i - b.i;
  }).map((x) => x.g);
}

/** 묶음 시각 칸 — 'MM-DD HH:MM' 또는 'MM-DD HH:MM ~ HH:MM'(같은 날) · 'MM-DD HH:MM ~ MM-DD HH:MM'. */
export function groupTimeText(g) {
  if (!fin(g?.newest)) return '—';
  if (!fin(g.oldest) || g.oldest === g.newest) return mdhm(g.newest);
  const a = mdhm(g.oldest); const b = mdhm(g.newest);
  return a.slice(0, 5) === b.slice(0, 5) ? `${a} ~ ${b.slice(6)}` : `${a} ~ ${b}`;
}

/** 묶음 로그 상한(서버 ops.LOGS_MAX 와 같은 값 — 서버가 400 으로 거른다). */
export const BULK_LOG_MAX = 15;
/** 묶음 로그 요청 항목 — 로그를 읽을 수 있는 실행만 · 새것부터 상한까지. more = 상한 밖 실행 수. */
export function bulkLogItems(g) {
  const runs = (g?.rows || []).filter(canOpenLog);
  return { items: runs.slice(0, BULK_LOG_MAX).map((r) => ({ id: r.jobKey, jobid: r.jobid })), rows: runs.slice(0, BULK_LOG_MAX), more: Math.max(0, runs.length - BULK_LOG_MAX) };
}
/** 묶음 대조 칸(서버 compareFirstErrors.match) → 글자 · 색. */
export const MATCH_TEXT = Object.freeze({
  same: { text: '같은 오류', tone: 'bad' }, other: { text: '다른 오류', tone: 'warn' }, none: { text: '오류 줄 없음', tone: 'muted' }, unread: { text: '못 읽음', tone: 'muted' },
});
/** 묶음 대조 한 줄 — 0 인 칸은 뺀다. 같은 오류라고 말할 근거가 없으면(전부 제각각) 그렇게 말한다. */
export function bulkSummaryText(s) {
  if (!s || !fin(s.total)) return '';
  const parts = [];
  if (s.same) parts.push(`${s.same}건이 같은 오류`);
  if (s.other) parts.push(`${s.other}건 다른 오류`);
  if (s.none) parts.push(`${s.none}건 오류 줄 없음`);
  if (s.unread) parts.push(`${s.unread}건 못 읽음`);
  if (!s.same && s.other > 1) parts.unshift('같은 오류로 묶이는 실행이 없습니다(첫 오류 줄이 모두 다름)');
  return parts.join(' · ') || '읽은 실행이 없습니다';
}
/** 시각 'MM-DD HH:MM'(브라우저 시각). */
export const mdhm = (ms) => (fin(ms) ? (() => { const d = new Date(ms); return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`; })() : '—');

/* ── 일일 메일(이 조건을 알림으로) ── */
const UNIT = { h: '시간', d: '일', w: '주' };
const SRC = { all: '실제 백업 전부', veeam: 'Veeam 만', bareos: 'Bareos 만', policy: '정책에 맞는 백업만' };
/** 찾기 조건 → 저장할 q(서버가 다시 정규화한다). */
export const alertQueryOf = (o) => ({ n: Number(o?.n), unit: o?.unit || 'd', src: o?.src || 'all', excludeNone: o?.excludeNone !== false, onlyOn: o?.onlyOn !== false, includeNever: o?.includeNever !== false, vc: o?.vc || '' });
/** 조건 한 줄. vcName = id → 이름. */
export function alertCondText(q, vcName = (id) => id) {
  if (!q) return '—';
  const bits = [`최근 ${q.n}${UNIT[q.unit] || '일'}`, SRC[q.src] || q.src, q.vc ? `법인 ${vcName(q.vc)}` : '전체 법인'];
  if (q.excludeNone) bits.push('백업 안함 제외');
  if (q.onlyOn) bits.push('켜진 VM 만');
  if (!q.includeNever) bits.push('한 번도 없음 빼고');
  return bits.join(' · ');
}
/** 찾기 조건과 저장된 조건이 같은가(화면 '지금 조건과 같음'). */
export function sameAlertQuery(a, b) {
  if (!a || !b) return false;
  const x = alertQueryOf(a); const y = alertQueryOf(b);
  return Object.keys(x).every((k) => x[k] === y[k]);
}
/** 마지막 발송 글자. */
export function alertStatusText(st) {
  if (!st || !st.day) return '아직 보낸 적 없음';
  if (st.ok === true) return `${st.day} 보냄${Number.isFinite(st.n) ? ` — ${st.n}대` : ''}`;
  return `${st.day} 보내지 못함(${st.tries}번 시도) — ${st.reason || '사유 모름'}`;
}

export { bytesText, DAY };
