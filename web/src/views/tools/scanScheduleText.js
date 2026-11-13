// scanScheduleText.js — 주기 스캔 일정 · 쉬는 시간 · 스캔 속도의 표시 문구와 입력 정리(순수 · v3.7.0 재설계 묶음 라 — 시안 ⑭).
// 판정(쉬는 시간에 걸렸는가 · 늦음 · 다음 예정)은 서버(ipam/scanQuiet.js · scanSchedule.js)가 한다. 여기는 입력 줄 모양과 글자만.

/** 스캔 속도 — 동시에 스캔하는 IP 수 · 응답 대기(ms)에 이름을 붙인 것. 값은 기존 칸(concurrency · timeoutMs)에 그대로 들어간다. */
export const SPEED_PRESETS = Object.freeze([
  { k: 'slow', label: '느리게', concurrency: 32, timeoutMs: 1000, note: '회선이 좁거나 방화벽이 민감한 곳' },
  { k: 'normal', label: '보통', concurrency: 128, timeoutMs: 700, note: '기본값' },
  { k: 'fast', label: '빠르게', concurrency: 256, timeoutMs: 500, note: '같은 건물 안 · 넓은 대역' },
]);
/** 지금 값이 어느 속도인가(없으면 'custom' — 직접 넣은 값). */
export function speedOf(s) {
  const c = Number(s?.concurrency); const t = Number(s?.timeoutMs);
  return SPEED_PRESETS.find((p) => p.concurrency === c && p.timeoutMs === t)?.k || 'custom';
}

export const DAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
/** 쉬는 시간 한 줄 검사 — 화면이 저장 전에 말한다(서버도 같은 규칙으로 400). */
export function quietRowIssue(q) {
  if (!TIME_RE.test(String(q?.from || '')) || !TIME_RE.test(String(q?.to || ''))) return '00:00~23:59 형식으로 넣으세요';
  if (q.from === q.to) return '시작과 끝이 같습니다';
  if (Array.isArray(q.days) && q.days.length === 0) return '요일을 하나 이상 고르세요';
  return '';
}
/** 화면 줄 → 저장 값(매일이면 days 를 싣지 않는다). */
export function quietToBody(rows) {
  return (rows || []).map((q) => ({ from: q.from, to: q.to, ...(Array.isArray(q.days) && q.days.length && q.days.length < 7 ? { days: [...q.days].sort() } : {}) }));
}
export function quietLabel(q) {
  const d = Array.isArray(q?.days) && q.days.length && q.days.length < 7 ? `(${q.days.map((x) => DAY_LABELS[x]).join('·')})` : '';
  return `${q?.from || '—'}~${q?.to || '—'}${d}`;
}

/** 시간표 줄 상태 → 글자 · 색. */
export const SCHED_STATE = Object.freeze({
  ok: { label: '정상', tone: 'green' },
  late: { label: '늦음', tone: 'amber', title: '마지막 완료가 주기의 2배보다 오래됐습니다 — 놓친 회차는 몰아서 다시 돌지 않습니다' },
  none: { label: '기록 없음', tone: 'gray', title: '완료한 스캔 기록이 없습니다(0회라는 뜻이 아닙니다)' },
  off: { label: '꺼짐', tone: 'gray' },
});
export const RUN_KIND = Object.freeze({ done: '끝남', fail: '실패', skip: '건너뜀', running: '스캔 중' });

/** 분 → '13:05'. */
export function hhmm(min) {
  const m = Math.max(0, Math.min(1440, Math.round(Number(min) || 0)));
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
/** 주기(ms) → '60분' · '6시간'. 못 읽으면 '—'. */
export function intervalText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const m = Math.round(n / 60000);
  return m % 60 === 0 && m >= 60 ? `${m / 60}시간` : `${m}분`;
}
/** 걸린 시간(ms) → '3분 20초' · '45초'. */
export function durText(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const s = Math.round(n / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분${s % 60 ? ` ${s % 60}초` : ''}` : `${s}초`;
}
