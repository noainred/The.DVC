/**
 * views/tools/focusMonAlertsText.js — 서버 집중 모니터링 ‘알림’ 탭(v3.16.0 ⑯ — 시안 Alerts)의 순수 함수(문구).
 * 판정은 서버가 한다(focusmon/alerts.js judge) — 여기는 응답을 글자로. 값이 없으면 ‘—’ · 문구에 백틱을 쓰지 않는다.
 */
import { numOrNull } from '../../numOrNull.js';
import { DASH } from './focusMonText.js';

const n = numOrNull;
export const SEV_TEXT = Object.freeze({ warn: { label: '주의', tone: 'warn' }, crit: { label: '위험', tone: 'crit' } });
export const SCOPE_TEXT = Object.freeze({ record: '계속 수집 전체', group: '그룹', server: '서버 하나' });
export const READ_TEXT = Object.freeze({ ok: { label: '읽음', tone: 'ok' }, denied: { label: '권한 없음', tone: 'warn' }, timeout: { label: '응답 없음', tone: 'warn' } });
/** 규칙의 대상 글. */
export function scopeText(r, nameOf = (id) => id) {
  const s = r?.scope || {};
  if (s.kind === 'group') return `그룹 ${s.group}`;
  if (s.kind === 'server') return nameOf(s.target) || s.target;
  return SCOPE_TEXT.record;
}
/** 지금 칸 — 발생 · 보류 · 정상(덮는 서버 수). */
export function nowText(r, { judged = true } = {}) {
  if (!r?.enabled) return { text: '꺼짐', tone: 'off' };
  if (!judged) return { text: '판정 전(1분마다)', tone: 'off' };
  if (r.firing > 0) return { text: `발생 ${r.firing}대${r.hold ? ` · 보류 ${r.hold}` : ''}`, tone: 'crit' };
  if (r.hold > 0) return { text: `판정 보류 ${r.hold}대`, tone: 'off' };
  return { text: r.covered ? `정상 · ${r.covered}대` : '덮는 서버 없음', tone: r.covered ? 'ok' : 'off' };
}
/** 문턱 입력 검사(서버와 같은 범위 — 응답 metrics.range). */
export function thresholdIssue(v, metric) {
  const x = n(v); const r = metric?.range;
  if (x == null) return '문턱을 숫자로 적으세요.';
  if (r && (x < r[0] || x > r[1])) return `문턱은 ${r[0]} ~ ${r[1]} 입니다.`;
  return '';
}
/** 미리 보기 글. */
export function previewText(p) {
  if (!p) return '';
  if (p.unsupported) return p.reason || '이 규칙은 미리 보기를 하지 않습니다.';
  const cov = n(p.coveredMin);
  if (!cov) return '이 서버의 지난 24시간 1분 요약이 없습니다 — 미리 볼 수 없습니다.';
  return p.count ? `지난 24시간에 걸었다면 ${p.count}번 발생했을 것입니다(추정 · 요약이 있는 ${Math.round(cov / 6) / 10}시간 기준)` : `지난 24시간에 걸었다면 한 번도 발생하지 않았을 것입니다(추정 · 요약이 있는 ${Math.round(cov / 6) / 10}시간 기준)`;
}
/** 커널 오류 줄 수 글. */
export function kerrText(v) { const x = n(v); return x == null ? DASH : x === 0 ? '없음' : `${x}줄`; }
/**
 * OOM · 커널 오류 칸(반증 L5) — 커널 메시지를 읽지 못했으면(권한 없음 · 응답 없음 · 아직 모름) 0 · '없음' 이 아니라 '—'(기록이 있으면 그 수) ·
 * 기록 DB 를 못 읽었으면(null) '—'. kind = 'oom' | 'kerr'.
 */
export function kmCell(read, v, kind = 'oom') {
  const x = n(v);
  if (x == null || (read !== 'ok' && x === 0)) return DASH;
  return kind === 'kerr' ? kerrText(x) : String(x);
}
