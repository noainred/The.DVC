/**
 * Veeam 백업 현황 › EM 탭(v2.788) 순수 도우미 — 화면(BackupEmTool.jsx)과 테스트가 같은 함수를 쓴다.
 * 규칙: 못 읽은 값(null·undefined)은 '—' 이고 단위를 붙이지 않는다(0 과 구분 — web/src/numOrNull.js 규칙).
 */
import { numOrNull } from '../../numOrNull.js';
import { fmtNum, shortTs } from './backupViewText.js';
import { agoText } from './relTime.js';

export { fmtNum, shortTs };

/** 바이트 → 'TB'·'GB'·'MB'(1000 단위 — Veeam 화면과 같다). 모르면 '—'. */
export function fmtBytes(v) {
  const n = numOrNull(v);
  if (n == null || n < 0) return '—';
  const U = [['PB', 1e15], ['TB', 1e12], ['GB', 1e9], ['MB', 1e6]];
  for (const [u, d] of U) if (n >= d) return `${(n / d).toFixed(n / d >= 100 ? 0 : 1)} ${u}`;
  return `${Math.round(n)} B`;
}
/** 초 → '5시간 12분'·'42분'·'30초'. 모르면 '—'. */
export function fmtDur(sec) {
  const n = numOrNull(sec);
  if (n == null || n < 0) return '—';
  const h = Math.floor(n / 3600); const m = Math.floor((n % 3600) / 60);
  if (h) return `${h}시간${m ? ` ${m}분` : ''}`;
  if (m) return `${m}분`;
  return `${Math.round(n)}초`;
}
const p2 = (x) => String(x).padStart(2, '0');
/** 'YYYY-MM-DD'(이 브라우저 시간대). 모르면 '—'. */
export function dateText(ts) {
  const t = numOrNull(ts);
  if (t == null || t <= 0) return '—';
  const d = new Date(t);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
/** 'n분 전'·'n시간 전'·'n일 전' — 공용 코어(relTime.agoText) 한 줄 껍데기(DEPS2613-11 — 상대 시각을 따로 구현하지 않는다). */
export const ago = (ts, now = Date.now()) => agoText(ts, now);

export const JOB_FILTERS = [['all', '전체'], ['fail', '실패'], ['warn', '경고'], ['run', '실행 중'], ['ok', '정상'], ['none', '기록 없음']];
export const JOB_LABEL = { fail: '실패', warn: '경고', run: '실행 중', ok: '정상', none: '기록 없음' };
export const TONE = { fail: '#fca5a5', warn: '#fcd34d', run: '#67e8f9', ok: '#86efac', none: 'var(--text-dim)' };
export const BADGE_BG = { fail: 'rgba(239,68,68,.16)', warn: 'rgba(245,158,11,.16)', run: 'rgba(34,211,238,.14)', ok: 'rgba(34,197,94,.14)', none: 'var(--panel-deep)' };

/** 수집 항목 이름 — 서버 veeam/em/client.js EM_SECTIONS 와 같은 키·순서(테스트가 대조). */
export const SECTION_LABEL = Object.freeze({
  overview: '전체 개요', jobStats: '작업 통계', vms: 'VM 개요', processed: '처리 VM', repoReport: '저장소 보고서',
  backupServers: '백업 서버', jobs: '작업', repositories: '저장소', sessions: '세션',
});
/** 수집 상태 칩 — 항목별 성공·실패(사유). 수집 전이면 빈 목록. */
export function sectionChips(status) {
  const sec = status?.sections || {};
  return Object.keys(SECTION_LABEL).filter((k) => sec[k]).map((k) => ({ k, label: SECTION_LABEL[k], ok: sec[k].ok === true, reason: sec[k].reason || '' }));
}

/** 수집 상태 한 줄 — { tone:'ok'|'warn'|'bad'|'muted', text }. */
export function statusLine(status, now = Date.now()) {
  if (!status) return { tone: 'muted', text: '아직 수집 전입니다(첫 수집은 포탈 시작 2분 뒤 · 설정에서 지금 수집).' };
  if (status.kind === 'auth-stopped' || status.authStop) return { tone: 'bad', text: `인증 실패로 주기 수집을 멈췄습니다 — 설정 › Veeam 백업 서버 › Enterprise Manager 에서 계정을 고치세요${status.lastOkTs ? ` · 마지막 성공 ${shortTs(status.lastOkTs)}` : ''}` };
  if (!status.ok) return { tone: 'bad', text: `마지막 수집 실패 — ${status.error || '사유 모름'}${status.lastOkTs ? ` · 아래 값은 마지막 성공(${shortTs(status.lastOkTs)}) 기준` : ''}` };
  if (status.stale) return { tone: 'warn', text: `마지막 성공 ${shortTs(status.lastOkTs)}(${ago(status.lastOkTs, now)}) — 수집이 늦어지고 있습니다` };
  const failed = sectionChips(status).filter((c) => !c.ok).length;
  return { tone: failed ? 'warn' : 'ok', text: `마지막 수집 ${shortTs(status.ts)}(${ago(status.ts, now)})${failed ? ` · ${failed}개 항목을 읽지 못했습니다` : ''}` };
}

/** 만료 남은 일 — 'D-47'·'만료'·'—'. */
export function ddayText(daysLeft) {
  const d = numOrNull(daysLeft);
  if (d == null) return '—';
  return d < 0 ? `만료(${-d}일 지남)` : `D-${d}`;
}
export const ddayTone = (daysLeft) => { const d = numOrNull(daysLeft); return d == null ? 'none' : d < 0 || d <= 7 ? 'fail' : d <= 30 ? 'warn' : d <= 90 ? 'run' : 'ok'; };

/** 라이선스 카드 — 사용률(둘 다 아는 서버만 합) · 서버별 줄(사용 많은 순). */
export function licenseCard(lic) {
  const t = lic?.totals || {};
  const items = (Array.isArray(lic?.items) ? lic.items : []).map((x) => {
    const i = x.license?.instances || null;
    const used = numOrNull(i?.used); const licensed = numOrNull(i?.licensed);
    return { id: x.id, name: x.name, used, licensed, pct: used != null && licensed ? Math.round((used / licensed) * 1000) / 10 : null, edition: x.license?.edition || '', type: x.license?.type || '', expires: x.license?.expires ?? null, supportExpires: x.license?.supportExpires ?? null, demo: !!x.demo };
  }).sort((a, b) => ((b.used ?? -1) - (a.used ?? -1)) || String(a.name).localeCompare(String(b.name)));
  const used = numOrNull(t.used); const licensed = numOrNull(t.licensed);
  return {
    items, used, licensed, remain: used != null && licensed != null ? licensed - used : null,
    pct: used != null && licensed ? Math.round((used / licensed) * 1000) / 10 : null,
    unknown: numOrNull(t.unknown) || 0, earliest: t.earliest || null, earliestSupport: t.earliestSupport || null,
  };
}

/** 저장소 사용률 색 — 90% 이상 빨강 · 80% 이상 주황 · 모르면 흐림. */
export const repoTone = (pct) => { const p = numOrNull(pct); return p == null ? 'none' : p >= 90 ? 'fail' : p >= 80 ? 'warn' : 'run'; };

/** 작업 필터 + 검색(이름·백업 서버). */
export function filterJobs(items, f = 'all', q = '') {
  const s = String(q || '').trim().toLowerCase();
  return (Array.isArray(items) ? items : []).filter((j) => (f === 'all' || j.state === f) && (!s || `${j.name} ${j.server}`.toLowerCase().includes(s)));
}

/** 24시간 실행 결과 막대 조각(%). 끝난 세션이 0 이면 null(막대를 그리지 않는다). */
export function runBar(counts) {
  const c = counts || {};
  const total = (numOrNull(c.ok) || 0) + (numOrNull(c.warn) || 0) + (numOrNull(c.fail) || 0);
  if (!total) return null;
  const p = (n) => Math.round(((numOrNull(n) || 0) / total) * 1000) / 10;
  return { ok: p(c.ok), warn: p(c.warn), fail: p(c.fail), total };
}

/**
 * 이력 → 작은 선(SVG points 문자열). series = [[day, a, b], ...], val = (a, b) => 값|null.
 * 값이 2개 미만이면 null(선을 그리지 않는다 — 한 점은 추이가 아니다). 값이 없는 날은 건너뛴다(0 으로 내리지 않는다).
 */
export function sparkPoints(series, val, { w = 120, h = 28 } = {}) {
  const pts = (Array.isArray(series) ? series : []).map(([d, a, b]) => [d, val(a, b)]).filter(([, v]) => v != null && Number.isFinite(v));
  if (pts.length < 2) return null;
  const d0 = pts[0][0]; const d1 = pts[pts.length - 1][0];
  const vs = pts.map(([, v]) => v); const lo = Math.min(...vs); const hi = Math.max(...vs);
  const x = (d) => (d1 === d0 ? 0 : ((d - d0) / (d1 - d0)) * w);
  const y = (v) => (hi === lo ? h / 2 : h - ((v - lo) / (hi - lo)) * h);
  return { points: pts.map(([d, v]) => `${x(d).toFixed(1)},${y(v).toFixed(1)}`).join(' '), days: pts.length, first: vs[0], last: vs[vs.length - 1] };
}
export const usedPctOf = (cap, free) => { const c = numOrNull(cap); const f = numOrNull(free); return c != null && c > 0 && f != null ? Math.round(((c - f) / c) * 1000) / 10 : null; };
