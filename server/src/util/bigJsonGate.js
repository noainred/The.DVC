/**
 * util/bigJsonGate.js — 대용량 JSON 파서를 **인증된 요청에만** 태우는 게이트(v2.538).
 *
 * 문제: `app.use('/api/central/inventory', express.json({limit:'16mb'}))` 처럼 마운트하면 그 파서는
 * 라우터의 토큰 검사보다 **먼저** 돈다. 토큰 없는 요청도 16MB 를 다 읽고 JSON.parse 한 뒤에야
 * 403 을 받는다 — 무인증 메모리 증폭(실측 무토큰 15MB ×6 동시 → RSS +238MB).
 *
 * 해법: 파싱 전에 "이 요청이 이미 유효한 토큰/세션을 들고 있는가" 만 본다(부작용 없는 조회).
 *  - 예 → 큰 파서 실행(그 뒤 전역 1MB 파서는 `req._body` 로 건너뛴다)
 *  - 아니오 → next() (본문은 읽지 않는다). 이어지는 전역 1MB 파서가 Content-Length > 1MB 면
 *    본문을 읽지 않고 413 을 내고, 그 아래면 라우터 인증이 401/403 을 낸다.
 *
 * ⚠ 이것은 **권한 판정이 아니다** — 인증·인가는 여전히 각 라우터가 한다. 여기서 허용해도 라우터가
 *   거부할 수 있고, 여기서 거부해도(파싱 생략) 라우터가 다시 본다. 두 판정이 어긋나도 안전한 쪽
 *   (파싱 생략)으로 실패한다.
 * ⚠ 마운트 안에서는 `req.path` 가 마운트 기준(`/`)이라 `req.baseUrl + req.path` 로 전체 경로를 본다.
 *
 * @param {import('express').RequestHandler} parser  express.json({limit:big})
 * @param {{ central:(req)=>boolean, session:(req)=>boolean }} resolvers  경로 계열별 '이미 인증됐나' 판정
 */
export function bigJsonGate(parser, resolvers) {
  const { central, session } = resolvers || {};
  const allowed = (req) => {
    const full = String((req.baseUrl || '') + (req.path || ''));
    try {
      if (full.startsWith('/api/central/')) return Boolean(central && central(req));
      if (full.startsWith('/api/svcmon/')) return Boolean(session && session(req));
      // v2.590: 로그 분석 붙여넣기(adminOnly, 라우트가 8MB 를 재검사)도 세션 계열이다. v2.583 이 BIG_JSON 에 등록했지만
      // 여기 접두 목록에 없어 판정이 항상 false → 16MB 파서가 한 번도 돌지 않고 전역 1MB 가 걸려, 2MB 붙여넣기가 413 이었다.
      if (full.startsWith('/api/admin/log-analysis/')) return Boolean(session && session(req));
    } catch { /* 판정 오류는 '미인증' 으로 — 파싱하지 않는다 */ }
    return false;
  };
  const gate = (req, res, next) => (allowed(req) ? parser(req, res, next) : next());
  gate._bigJsonGate = true; // 테스트·진단용 표식
  return gate;
}
