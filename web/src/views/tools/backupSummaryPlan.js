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
  if (r.open === 'bareos') return canBareos ? { key: 'hash', text: '실행 이력', hash: '#/tools/bareos-backup/history' } : canBareosView ? { key: 'hash', text: 'Bareos', hash: '#/tools/bareos-summary' } : null;
  if (r.open === 'live') return canBareos ? { key: 'hash', text: '진행 현황', hash: '#/tools/bareos-backup/live' } : null;
  if (r.open === 'em') return { key: 'hash', text: 'Veeam', hash: '#/tools/backup-em' };
  if (r.open === 'bareos-settings') return canBareos && admin ? { key: 'hash', text: '설정', hash: '#/tools/bareos-backup/settings' } : null;
  return null;
}
/** 같은 원인 칸 — 2건 이상이면 'N건' · 아니면 '—'. */
export const sameText = (n) => (fin(n) && n > 1 ? `${n}건` : '—');
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
