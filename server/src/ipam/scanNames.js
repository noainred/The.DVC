/**
 * ipam/scanNames.js — IP 스캔 정방향 DNS 로 물을 **물리서버 이름 공급자**(v2.992 · 설계 bm-folders §13 ③).
 * 이름은 물리서버 폴더 입력(라우트 층 — routes/admin/bmOsSuggest.js)에서 나온다. 도메인(ipam)이 routes/ 를 import 하지 않게(arch2579 ①)
 * 라우트 모듈이 기동 때 공급자를 등록하고 스캔은 이 모듈만 부른다. 공급자가 없거나 실패하면 [](역방향 DNS 만 — 스캔은 그대로).
 */
let _provider = null;
export function setFwdNamesProvider(fn) { _provider = typeof fn === 'function' ? fn : null; }
export async function fwdNamesFor(agent) {
  if (!_provider) return [];
  try { const r = await _provider(agent); return Array.isArray(r) ? r : []; } catch { return []; }
}
