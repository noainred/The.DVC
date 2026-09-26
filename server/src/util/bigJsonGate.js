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
/**
 * v2.617: 동시 해석 상한. 2026-09-26 운영 중앙이 기동 약 5분 뒤 한 코어 100%·RSS 5GB 로 멈췄다(GC 헛돎 추정 — 확정 아님).
 * 중앙이 재시작하면 엣지 ~30곳이 인벤토리·게스트 디스크·스파이크·설정 사본 등을 한꺼번에 다시 올리는데, 큰 본문 하나가
 * 버퍼 → 문자열(한글이면 2배) → 객체(JSON 의 3~6배) → 정제 사본으로 여러 겹 산다. 개수·바이트 제한이 없어 순간 힙이
 * 0.7~1.5GB(추정) 늘 수 있었다. 이제 동시에 해석 중인 본문을 **개수(maxConcurrent)와 선언 크기 합(maxBytes)** 으로
 * 묶고, 넘으면 본문을 읽지 않고 503 + Retry-After 로 돌려보낸다(엣지 resilientFetch 는 503 을 재시도한다 — 조용한 소실이
 * 아니다). 들어온 것이 하나도 없으면 한도보다 큰 단일 본문도 받는다(안 받으면 영원히 못 들어온다).
 * 슬롯은 응답이 끝날 때(close) 돌려준다 — 해석된 객체는 핸들러가 끝날 때까지 산다.
 */
const _slots = { inflight: 0, bytes: 0, rejected: 0, lastRejectAt: null, peakInflight: 0, peakBytes: 0, lastLogAt: 0 };
export function bigJsonStats() { return { ..._slots }; }

export function bigJsonGate(parser, resolvers, opts = {}) {
  const { central, session } = resolvers || {};
  const maxConcurrent = Math.max(1, Math.floor(Number(opts.maxConcurrent ?? process.env.BIG_JSON_MAX_CONCURRENT) || 6));
  const maxBytes = Math.max(1_048_576, Math.floor(Number(opts.maxBytes ?? process.env.BIG_JSON_MAX_BYTES) || 96 * 1_048_576));
  const retryAfterSec = Math.max(1, Math.floor(Number(opts.retryAfterSec) || 5));
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
  const admit = (req, res, next) => {
    if (!res || typeof res.once !== 'function') return parser(req, res, next); // 응답 객체가 없는 호출(단위 테스트 더블)
    const len = Math.max(0, Number(req.get?.('content-length')) || 0);
    const busy = _slots.inflight > 0 && (_slots.inflight >= maxConcurrent || _slots.bytes + len > maxBytes);
    if (busy) {
      _slots.rejected += 1; _slots.lastRejectAt = Date.now();
      if (Date.now() - _slots.lastLogAt >= 60_000) {
        _slots.lastLogAt = Date.now();
        try { console.warn(`[bigjson] 큰 본문 동시 해석 상한 — 진행 중 ${_slots.inflight}건·${Math.round(_slots.bytes / 1_048_576)}MB · 이 요청 ${Math.round(len / 1_048_576)}MB 을 503 으로 돌려보냈습니다(엣지가 재시도합니다. 누적 ${_slots.rejected}건)`); } catch { /* */ }
      }
      res.set('Retry-After', String(retryAfterSec));
      res.status(503).json({ ok: false, error: 'busy', reason: 'central-parse-busy', retryAfterSec });
      return;
    }
    _slots.inflight += 1; _slots.bytes += len;
    _slots.peakInflight = Math.max(_slots.peakInflight, _slots.inflight);
    _slots.peakBytes = Math.max(_slots.peakBytes, _slots.bytes);
    let released = false;
    const release = () => { if (released) return; released = true; _slots.inflight -= 1; _slots.bytes -= len; };
    res.once('close', release);
    res.once('finish', release);
    parser(req, res, next);
  };
  const gate = (req, res, next) => (allowed(req) ? admit(req, res, next) : next());
  gate._bigJsonGate = true; // 테스트·진단용 표식
  return gate;
}
