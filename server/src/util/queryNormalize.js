/**
 * 쿼리스트링 정규화 — **`req.query` 의 모든 값은 문자열이다**(v2.575 BUG-22).
 *
 * express 4 의 기본 쿼리 파서는 `qs`(extended)라 `?id[a]=1` 은 **객체**, `?id=a&id=b` 는
 * **배열**이 된다. 라우트 코드는 거의 전부 문자열을 가정하므로 그런 값이 들어오면
 * `.toLowerCase is not a function`(TypeError) 이나 SQLite 바인드 오류
 * (`Unknown named parameter 'a'`)로 **500** 이 난다. 목 서버 전수 퍼징 실측(GET 375경로 ×
 * 파라미터 119 × 2형태 = 89,250요청)에서 **7경로 22건**이 500 이었다 —
 * `/api/admin/agent-deploy/installer` · `/api/admin/audit` · `/api/admin/net/log-issues` ·
 * `/api/tools/report/changes` · `/api/tools/report/unprotected` · `/api/tools/vclogs` ·
 * `/api/tools/vclogs/export.csv`.
 *
 * 라우트마다 `String(...)` 을 덧붙이는 대신 **입구에서 모양을 고정한다** — 그래야 다음에
 * 추가되는 라우트가 자동으로 보호된다(CLAUDE.md '코어는 하나다').
 *
 * 규칙
 *  - 문자열은 그대로.
 *  - 배열(`?id=a&id=b`)은 **마지막 값**을 쓴다(HTTP 관례. 앞 값을 쓰면 뒤에 덧붙인 쪽이
 *    무시돼 '설정했는데 안 먹는다' 가 된다). 원소가 문자열이 아니면 버린다.
 *  - 객체·그 밖의 값은 **버린다**(그 키가 없는 것과 같다). 문자열로 억지 변환하면
 *    `[object Object]` 가 검색어·식별자로 들어가 **오류 없이 틀린 조회**가 된다.
 *  - ⚠ `Array.isArray(req.query.x)` 를 기대하는 라우트는 이 저장소에 **0건**임을 확인하고
 *    도입했다(스윕: `grep -rn "Array.isArray(req.query"` → 0). 배열 쿼리를 받는 라우트를
 *    새로 만들려면 이 미들웨어를 먼저 볼 것.
 *  - ⚠ **`__proto__`·`constructor`·`prototype` 키는 버린다** — `qs` 의 중첩 파싱과 조합하면
 *    프로토타입 오염 시도의 입구가 된다. 정규화된 객체는 `Object.create(null)` 기반이다.
 */

const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);

/** 순수 — 파싱된 쿼리 객체를 `{키: 문자열}` 로 만든다. 테스트가 이 함수를 고정한다. */
export function normalizeQuery(q) {
  const out = Object.create(null);
  if (!q || typeof q !== 'object') return out;
  for (const k of Object.keys(q)) {
    if (DANGEROUS.has(k)) continue;
    const v = q[k];
    if (typeof v === 'string') { out[k] = v; continue; }
    if (Array.isArray(v)) {
      // 마지막 문자열 원소만 취한다(중첩 배열·객체 원소는 값이 아니다).
      for (let i = v.length - 1; i >= 0; i -= 1) {
        if (typeof v[i] === 'string') { out[k] = v[i]; break; }
      }
      continue;
    }
    // 객체·숫자·불리언 등은 파서가 만들 수 없거나(숫자/불리언) 값이 아니다(객체) → 버린다.
  }
  return out;
}

/** express 미들웨어. **라우터보다 먼저** 마운트할 것(뒤에 두면 그 앞 라우트가 보호되지 않는다). */
export function queryNormalizer() {
  return function queryNormalizeMiddleware(req, _res, next) {
    try { req.query = normalizeQuery(req.query); } catch { /* 파싱 실패는 라우트가 처리 */ }
    next();
  };
}

export default queryNormalizer;
