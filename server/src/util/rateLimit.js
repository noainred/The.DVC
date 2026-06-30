/**
 * 경량 인메모리 레이트 리밋 — 외부 의존성 없이 폭주/DoS·버그 클라이언트를 막는다.
 * 키별(기본 클라이언트 IP) 고정 윈도우 카운터. 정상 폴링(사용자당 분당 수십 요청)은 넉넉히
 * 통과하되, 한 IP가 비정상적으로 많은 요청을 보내면 429 + Retry-After로 차단한다.
 *
 * 분산 배포(다중 인스턴스)에서는 인스턴스별로 동작한다(공유 저장소 아님). 단일/소수 인스턴스에
 * 적합. 환경변수: API_RATE_LIMIT(윈도우당 허용, 기본 1800), API_RATE_WINDOW_MS(기본 60000),
 * API_RATE_DISABLED(=true 비활성).
 */

const DISABLED = String(process.env.API_RATE_DISABLED || '').toLowerCase() === 'true';
const MAX = Math.max(1, Number(process.env.API_RATE_LIMIT) || 1800);   // 분당 1800 = 30 req/s/IP(여유)
const WINDOW_MS = Math.max(1000, Number(process.env.API_RATE_WINDOW_MS) || 60_000);
const HARD_CAP = 50_000; // 키 맵 메모리 상한(초과 시 만료 항목 강제 정리)

const buckets = new Map(); // key -> { count, windowStart }

function clientIp(req) {
  // 실제 peer 우선(X-Forwarded-For 스푸핑 방지). 프록시 뒤면 trust proxy 설정 시 req.ip 사용 가능.
  return (req.socket?.remoteAddress || req.ip || 'unknown').toString();
}

function prune(now) {
  if (buckets.size < HARD_CAP) return;
  for (const [k, b] of buckets) { if (now - b.windowStart >= WINDOW_MS) buckets.delete(k); }
  if (buckets.size >= HARD_CAP) { // 그래도 많으면 절반 비움(백스톱)
    let n = Math.floor(buckets.size / 2);
    for (const k of buckets.keys()) { buckets.delete(k); if (--n <= 0) break; }
  }
}

/** Express 미들웨어. opts.skip(req)=true면 제한 제외(헬스/정적 등). */
export function rateLimit({ skip = null } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    if (DISABLED) return next();
    if (skip && skip(req)) return next();
    const now = Date.now();
    prune(now);
    const key = clientIp(req);
    let b = buckets.get(key);
    if (!b || now - b.windowStart >= WINDOW_MS) { b = { count: 0, windowStart: now }; buckets.set(key, b); }
    b.count++;
    if (b.count > MAX) {
      const retryAfter = Math.ceil((b.windowStart + WINDOW_MS - now) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      res.setHeader('X-RateLimit-Limit', String(MAX));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', retryAfterSec: retryAfter });
    }
    res.setHeader('X-RateLimit-Limit', String(MAX));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, MAX - b.count)));
    next();
  };
}
