/**
 * 진단 스냅샷 · 집중 모니터링의 사유 정제(순수 · v2.923 본문 그대로 — v2.929 에 snapshot/run.js 에서 나눴다).
 * focus/run.js 가 snapshot/run.js 를 import 하면 snapshot/run → poller(동적) → focus/run 순환이 생긴다(arch2579 SCC 상한).
 */
/**
 * 사유 — 줄바꿈 · 제어 문자를 빼고 2~300자. 비면 실행하지 않는다(400).
 * v2.923(반증): C1 제어 문자(U+0080~009F)와 양방향 제어(U+202A~202E · U+2066~2069 — 감사 화면에서 글자 순서를 뒤집어 보이게 한다) · 폭 없는 문자(U+200B~200F · U+FEFF)도 뺀다.
 */
export function cleanReason(v) {
  if (typeof v !== 'string') return '';
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
  return s.length >= 2 ? s : '';
}
