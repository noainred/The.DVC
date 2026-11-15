/**
 * 점검 반복 10회차 K1 — 프로세스 상위 행(진단 스냅샷 · 집중 모니터링 표본 · 기간 비교 procs)의 비관리자 가림 하나.
 *   파서(bmusage/snapshot/command.js parsePsLine · iotop)가 만드는 칸은 `name`(comm — 공백 포함 가능)이다 — 9회차 G1 은 `comm` 만 가려 실제 데이터에
 *   닿지 않았다(시험이 합성 행을 썼다 — 정정). 이름 안 IPv4 는 토큰으로 · 사용자 이름은 관리자 판본만 원문(8b 규약 — Top-N maskTopRows 와 같은 토큰).
 *   깊이 상한 안에서 cpuTop · memTop · ioTop 배열을 찾아 바꾼다(세션 · 표본 · 보관분 꼴이 달라도 같은 함수). 원본은 바꾸지 않는다.
 */
// candidates: 집중 모니터링 요약의 '원인 후보'(focus/summary.js — 표본 name 을 그대로 옮긴다 · 10회차 재확인 K1b)
export const PROC_KEYS = Object.freeze(['cpuTop', 'memTop', 'ioTop', 'candidates']);
export function scrubProcRow(p, { scrub, tok }) {
  if (!p || typeof p !== 'object') return p;
  const o = { ...p };
  if (typeof o.name === 'string') o.name = scrub(o.name);
  if (typeof o.comm === 'string') o.comm = scrub(o.comm);
  if ('user' in o && o.user) o.user = tok(String(o.user));
  return o;
}
export function scrubProcDeep(v, fns, depth = 0) {
  if (depth > 8 || !v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => scrubProcDeep(x, fns, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) {
    out[k] = PROC_KEYS.includes(k) && Array.isArray(x) ? x.map((p) => scrubProcRow(p, fns)) : scrubProcDeep(x, fns, depth + 1);
  }
  return out;
}
