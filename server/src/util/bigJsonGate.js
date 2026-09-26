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
/*
 * ⚠⚠ v2.617 보안 점검 SEC-1 로 다시 짰다(같은 릴리스 — 게시 전): 첫 판은 슬롯이 **전역 풀 하나**였고 세션 계열(로그 분석
 *   붙여넣기·svcmon 가져오기)도 같은 풀을 썼다. 세션 판정은 '유효한 세션인가' 뿐이라 viewer 계정이 느린 본문 6개로 슬롯을
 *   다 잡으면(express.json 에는 본문 읽기 시한이 없다) **모든 엣지 push 가 503** 이 됐다(재현). 이제
 *   ① 풀을 계열별로 나눈다 — 엣지(`/api/central/`)와 세션은 서로의 슬롯을 먹지 못한다
 *   ② 요청자(엣지 이름·사용자)당 동시 슬롯 상한 — 한 요청자가 풀을 독점하지 못한다
 *   ③ 본문 읽기 시한(BIG_JSON_READ_DEADLINE_MS, 기본 300초 — 고RTT 법인의 16MB 도 들어오는 값) — 넘으면 소켓을 끊고 슬롯을 돌려준다.
 */
const newPool = () => ({ inflight: 0, bytes: 0, rejected: 0, lastRejectAt: null, peakInflight: 0, peakBytes: 0, lastLogAt: 0, deadlineCut: 0, byWho: new Map() });
const _pools = { central: newPool(), session: newPool() };
export function bigJsonStats(cls) {
  const view = (p) => { const { byWho, ...rest } = p; return { ...rest, requesters: byWho.size }; };
  if (cls) return view(_pools[cls] || newPool());
  // 예전 형태(합계)도 함께 — 진단 화면·테스트 호환
  const c = view(_pools.central), s = view(_pools.session);
  return { inflight: c.inflight + s.inflight, bytes: c.bytes + s.bytes, rejected: c.rejected + s.rejected, central: c, session: s };
}
const num = (v, d) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n > 0 ? n : d; };

export function bigJsonGate(parser, resolvers, opts = {}) {
  const { central, session } = resolvers || {};
  const limits = {
    central: {
      maxConcurrent: num(opts.maxConcurrent ?? process.env.BIG_JSON_MAX_CONCURRENT, 6),
      maxBytes: Math.max(1_048_576, num(opts.maxBytes ?? process.env.BIG_JSON_MAX_BYTES, 96 * 1_048_576)),
      perWho: num(opts.perWho ?? process.env.BIG_JSON_PER_AGENT, 2),
    },
    session: {
      maxConcurrent: num(opts.sessionMaxConcurrent ?? process.env.BIG_JSON_SESSION_MAX_CONCURRENT, 2),
      maxBytes: Math.max(1_048_576, num(opts.sessionMaxBytes, 32 * 1_048_576)),
      perWho: 1,
    },
  };
  const readDeadlineMs = Math.min(1_800_000, num(opts.readDeadlineMs ?? process.env.BIG_JSON_READ_DEADLINE_MS, 300_000));
  const retryAfterSec = Math.max(1, Math.floor(Number(opts.retryAfterSec) || 5));
  // 판정 함수는 불리언이나 신원 객체({ok, agent} · 사용자 {username})를 돌려준다 — 신원이 있으면 요청자별 상한에 쓴다.
  const ident = (r) => {
    if (!r) return null;
    if (r === true) return '';
    if (typeof r === 'object') { if (r.ok === false) return null; return String(r.agent || r.username || r.name || ''); }
    return null;
  };
  const classify = (req) => {
    const full = String((req.baseUrl || '') + (req.path || ''));
    try {
      if (full.startsWith('/api/central/')) { const w = ident(central && central(req)); return w == null ? null : { cls: 'central', who: w }; }
      // v2.590: 로그 분석 붙여넣기(adminOnly, 라우트가 8MB 를 재검사)도 세션 계열이다.
      if (full.startsWith('/api/svcmon/') || full.startsWith('/api/admin/log-analysis/')) {
        const w = ident(session && session(req)); return w == null ? null : { cls: 'session', who: w };
      }
    } catch { /* 판정 오류는 '미인증' 으로 — 파싱하지 않는다 */ }
    return null;
  };
  const admit = (req, res, next, { cls, who }) => {
    if (!res || typeof res.once !== 'function') return parser(req, res, next); // 응답 객체가 없는 호출(단위 테스트 더블)
    const pool = _pools[cls]; const lim = limits[cls];
    const whoKey = who || `ip:${req.ip || req.socket?.remoteAddress || '?'}`;
    const len = Math.max(0, Number(req.get?.('content-length')) || 0);
    const mine = pool.byWho.get(whoKey) || 0;
    const busy = mine >= lim.perWho
      || (pool.inflight > 0 && (pool.inflight >= lim.maxConcurrent || pool.bytes + len > lim.maxBytes));
    if (busy) {
      pool.rejected += 1; pool.lastRejectAt = Date.now();
      if (Date.now() - pool.lastLogAt >= 60_000) {
        pool.lastLogAt = Date.now();
        try { console.warn(`[bigjson] 큰 본문 동시 해석 상한(${cls}) — 진행 중 ${pool.inflight}건·${Math.round(pool.bytes / 1_048_576)}MB · 요청자 진행 ${mine}건 · 이 요청 ${Math.round(len / 1_048_576)}MB 을 503 으로 돌려보냈습니다(엣지가 재시도합니다. 누적 ${pool.rejected}건)`); } catch { /* */ }
      }
      res.set('Retry-After', String(retryAfterSec));
      res.status(503).json({ ok: false, error: 'busy', reason: 'central-parse-busy', retryAfterSec });
      return;
    }
    pool.inflight += 1; pool.bytes += len; pool.byWho.set(whoKey, mine + 1);
    pool.peakInflight = Math.max(pool.peakInflight, pool.inflight);
    pool.peakBytes = Math.max(pool.peakBytes, pool.bytes);
    let released = false;
    let timer = null;
    const release = () => {
      if (released) return; released = true;
      if (timer) clearTimeout(timer);
      pool.inflight -= 1; pool.bytes -= len;
      const n = (pool.byWho.get(whoKey) || 1) - 1;
      if (n > 0) pool.byWho.set(whoKey, n); else pool.byWho.delete(whoKey);
    };
    res.once('close', release);
    res.once('finish', release);
    // 본문 읽기 시한 — 본문이 끝나면(complete) 해제, 시한 안에 안 끝나면 끊는다(느린 본문으로 슬롯을 붙잡지 못하게).
    timer = setTimeout(() => {
      if (req.complete) return;
      pool.deadlineCut += 1;
      try { console.warn(`[bigjson] 본문을 ${Math.round(readDeadlineMs / 1000)}초 안에 다 받지 못해 연결을 끊었습니다(${cls} · ${whoKey})`); } catch { /* */ }
      release();
      try { req.destroy?.(); } catch { /* */ }
    }, readDeadlineMs);
    timer.unref?.();
    if (typeof req.once === 'function') req.once('end', () => { if (timer) { clearTimeout(timer); timer = null; } });
    parser(req, res, next);
  };
  const gate = (req, res, next) => {
    const c = classify(req);
    return c ? admit(req, res, next, c) : next();
  };
  gate._bigJsonGate = true; // 테스트·진단용 표식
  return gate;
}
