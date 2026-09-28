/**
 * ipamScanLogText.js — IP관리 › 스캔 로그 화면의 판정·문구(순수, v2.636).
 * 서버 `server/src/ipam/scanLog.js` 의 SCAN_LOG_EVENTS 와 이 표의 키가 1:1 이어야 한다(테스트가 대조한다 —
 * 한쪽만 늘면 화면이 코드를 그대로 보여준다).
 */
export const EVENT_TEXT = Object.freeze({
  start: '스캔 시작',
  finish: '스캔 종료',
  fail: '스캔 실패',
  skip: '건너뜀',
  busy: '이미 실행 중',
  report: '엣지 보고',
  reject: '보고 거부',
  settings: '설정 변경',
});
const LEVEL_TEXT = Object.freeze({ info: ['정보', 'gray'], warn: ['주의', 'amber'], error: ['오류', 'red'] });

export function eventText(e) { return EVENT_TEXT[e] || String(e || '—'); }
export function levelBadge(l) { return LEVEL_TEXT[l] || ['—', 'gray']; }
export function triggerText(t) { return t === 'manual' ? '수동' : t === 'periodic' ? '주기' : t ? String(t) : '—'; }
export function agentText(a) { return !a || a === '__local__' ? '이 포탈' : String(a); }

/** 스캔/응답 칸 — 못 읽은 값(null)은 0 이 아니라 '—'. */
export function countsText(e) {
  const s = e?.scanned; const a = e?.alive;
  if (s == null && a == null) return '—';
  const f = (v) => (v == null ? '—' : Number(v).toLocaleString());
  return `${f(s)} / ${f(a)}`;
}
export function durationText(ms) {
  if (ms == null || ms === '') return '—';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}초`;
  return `${Math.floor(n / 60_000)}분 ${Math.round((n % 60_000) / 1000)}초`;
}
/** 대역 칸 — 개수와 앞 몇 개. */
export function rangesText(e) {
  if (e?.ranges == null) return '—';
  const sample = (e.rangesSample || []).join(', ');
  const more = e.ranges > (e.rangesSample || []).length ? ` 외 ${e.ranges - (e.rangesSample || []).length}개` : '';
  return sample ? `${e.ranges}개 · ${sample}${more}` : `${e.ranges}개`;
}
/** 같은 사유로 합쳐진 줄의 반복 표시. */
export function repeatText(e) {
  const n = Number(e?.count);
  if (!Number.isFinite(n) || n < 2) return '';
  return `같은 사유 ${n}회 반복(마지막 ${e.lastAt ? new Date(e.lastAt).toLocaleString('ko-KR') : '—'})`;
}

/** 목록 머리 문구 — 조용한 상한 금지(잘렸으면 말한다). */
export function listHeadText(d) {
  if (!d) return '';
  const shown = (d.entries || []).length;
  const parts = [`${shown.toLocaleString()}건 표시`];
  if (d.matched != null && d.matched !== d.total) parts.push(`조건에 맞는 ${Number(d.matched).toLocaleString()}건`);
  parts.push(`보관 ${Number(d.total || 0).toLocaleString()}건(상한 ${Number(d.max || 0).toLocaleString()}건 — 넘으면 오래된 것부터 지웁니다)`);
  if (d.truncated) parts.push('표시 개수 상한으로 잘렸습니다 — 조건을 좁히거나 개수를 늘리세요');
  return parts.join(' · ');
}

/** 비어 있을 때 — '아무 일도 없었다' 로 단정하지 않는다. */
export function emptyText(filtered) {
  return filtered
    ? '조건에 맞는 기록이 없습니다.'
    : '아직 기록이 없습니다 — 이 기록은 v2.636 부터 쌓입니다. 스캔이 한 번도 돌지 않았거나(주기 스캔 꺼짐·대역 없음은 ‘건너뜀’ 으로 남습니다) 포탈을 막 올린 경우입니다.';
}
