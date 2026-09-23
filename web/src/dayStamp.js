/**
 * 브라우저 쪽 날짜 표기(v2.582 BUG-3) — 내려받기 파일명·만료일은 **사용자의 로컬 날짜**다.
 * `new Date().toISOString().slice(0, 10)` 은 UTC 날짜라 한국 시각 00:00~09:00 에는 **어제**가 된다
 * (보고서 파일명이 틀리면 아카이브에서 찾지 못한다). 서버의 `util/dayKey.js` 와 짝이다 —
 * 서버는 설정 오프셋(기본 UTC+9), 웹은 브라우저 시간대(= 사용자)를 쓴다.
 * 못 읽으면 빈 문자열(날짜를 지어내지 않는다).
 */
export function dayStamp(ts = Date.now()) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const t = d.getTime();
  if (!Number.isFinite(t)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
