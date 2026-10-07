/**
 * mock/serviceTag.js — 데모 서비스태그 규칙 한 벌(v2.716 — seed.js 에서 옮김. import 0 잎 모듈).
 */
/**
 * v2.708: Dell 서비스태그 모양(7자) — 'M' + 6자리 36진수. 같은 입력은 같은 태그(FNV-1a 두 개 — 충돌 사실상 없음).
 * 데모 모듈(demo/idrac.js)이 이것을 가져다 쓴다(시드와 데모가 같은 태그 규칙 — 한 벌).
 */
export function mockServiceTag(seed) {
  const fnv = (t) => { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const a = fnv(`tag|${seed}`).toString(36).toUpperCase(); const b = fnv(`tag2|${seed}`).toString(36).toUpperCase();
  return `M${(a + b).replace(/[^0-9A-Z]/g, '').padEnd(6, '0').slice(0, 6)}`;
}
