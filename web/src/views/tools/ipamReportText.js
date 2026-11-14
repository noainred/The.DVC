// ipamReportText.js — IP 관리 › 설정 › '정기 보고' 화면의 입력 정리 · 표시 문구(순수 · v3.7.0 재설계 묶음 라 — 시안 ⑫).
// 저장 검사(주소 형식 · 요일 · 시간대)는 서버(ipam/reportRules.normalizeReport)가 한다 — 화면은 줄을 나누고 보낼 모양만 만든다.

export const DAY_LABELS = Object.freeze(['일', '월', '화', '수', '목', '금', '토']);
export const FREQ_LABEL = Object.freeze({ weekly: '매주', daily: '매일' });
export const CLOCK_LABEL = Object.freeze({ main: '메인 서버 시각', corp: '법인 현지 시각' });
export const HISTORY_STATE = Object.freeze({
  sent: { label: '보냄', tone: 'green' }, skipped: { label: '건너뜀', tone: 'gray' }, failed: { label: '실패', tone: 'red' }, missed: { label: '놓침', tone: 'amber' },
});

/** 쉼표 · 줄바꿈 · 세미콜론으로 나눈 주소 목록(빈 칸 · 중복 제거 — 형식 검사는 서버). */
export function splitAddrs(text) {
  const out = []; const seen = new Set();
  for (const t of String(text || '').split(/[,;\n]/)) { const x = t.trim(); if (x && !seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x); } }
  return out;
}
/** 서버 값 → 화면 폼(주소는 글자 칸). */
export function formOf(r) {
  const corps = {};
  for (const [id, c] of Object.entries(r?.corps || {})) corps[id] = { toText: (c.to || []).join(', '), tz: c.tz || '' };
  return { enabled: !!r?.enabled, freq: r?.freq || 'weekly', days: Array.isArray(r?.days) ? r.days : [0], time: r?.time || '09:00', clock: r?.clock || 'main',
    includeAdmin: r?.includeAdmin !== false, toText: (r?.to || []).join(', '), fullPct: r?.fullPct ?? 90, sections: { ...(r?.sections || {}) }, corps };
}
/** 화면 폼 → 저장 본문. 받는 사람도 시간대도 없는 법인은 싣지 않는다. */
export function bodyOf(f) {
  const corps = {};
  for (const [id, c] of Object.entries(f?.corps || {})) {
    const to = splitAddrs(c.toText); const tz = String(c.tz || '').trim();
    if (to.length || tz) corps[id] = { to, tz };
  }
  return { enabled: !!f.enabled, freq: f.freq, days: f.freq === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : [...(f.days || [])].sort(), time: f.time, clock: f.clock,
    includeAdmin: !!f.includeAdmin, to: splitAddrs(f.toText), fullPct: f.fullPct === '' ? null : Number(f.fullPct), sections: f.sections, corps };
}
/** 회차 한 줄 — '매주 일 09:00(메인 서버 시각)'. */
export function scheduleText(f) {
  const days = f.freq === 'daily' ? '' : ` ${(f.days || []).map((d) => DAY_LABELS[d]).join('·') || '요일 없음'}`;
  return `${FREQ_LABEL[f.freq] || f.freq}${days} ${f.time}(${CLOCK_LABEL[f.clock] || f.clock})`;
}
/** 기록 한 줄의 대상 글자. */
export function targetText(t, corpName = {}) {
  if (t === 'overall') return '전체 종합';
  if (t === 'all') return '전체 종합 + 법인별';
  if (t === 'corps') return '법인별';
  return corpName[t] || t || '—';
}
