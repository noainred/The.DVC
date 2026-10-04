/**
 * HTTP 요청 출처 판정(순수 함수) — 로컬(루프백) 모드의 CSRF·DNS 리바인딩 방어.
 *
 * 로컬 모드(127.0.0.1 바인딩 · 데스크톱 앱)는 인증이 꺼져 있다. 그래서 브라우저에 열린 임의의
 * 웹페이지가 `http://127.0.0.1:<포트>` 로 요청을 보낼 수 있었다:
 *   - text/plain 본문의 교차출처 POST 는 프리플라이트 없이 나가고 서버는 그 본문을 JSON 으로
 *     파싱했다 → 임의 UAG 대상 등록(서버가 그 주소로 요청을 보낸다).
 *   - DNS 리바인딩(공격자 도메인이 127.0.0.1 로 해석)이면 같은 출처로 보이므로 /api/state 응답
 *     (등록 호스트·계정명)까지 읽을 수 있었다 — 이것은 Host 헤더로만 막힌다.
 *
 * 교차출처 판정은 pyportal `hub/server.py _cross_site` 와 같은 규칙이다:
 *   ① Sec-Fetch-Site 가 있고 same-origin/same-site/none 이 아니면 교차출처
 *   ② Origin 이 있으면 그 host[:port] 가 Host 헤더와 같아야 한다(파싱 실패 = 교차출처)
 */

const SAME_SITE = new Set(['same-origin', 'same-site', 'none']);

/** 로컬 모드에서 허용하는 Host 헤더 — 127.0.0.1 / localhost / [::1] (+ 선택 포트). */
export function loopbackHostOk(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase();
  return /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(h);
}

/** Sec-Fetch-Site 만으로 교차출처인가(브라우저가 계산 — 페이지 스크립트가 바꿀 수 없다). */
export function fetchSiteCross(headers = {}) {
  const site = String(headers['sec-fetch-site'] || '').trim().toLowerCase();
  return Boolean(site) && !SAME_SITE.has(site);
}

/** pyportal `_cross_site` 와 같은 규칙(① + ②). */
export function crossSite(headers = {}) {
  if (fetchSiteCross(headers)) return true;
  const origin = String(headers.origin || '');
  if (!origin) return false;
  let originHost;
  try { originHost = new URL(origin).host; } catch { return true; } // 'null'(file://·sandbox) 포함
  const host = String(headers.host || '').trim().toLowerCase();
  return Boolean(host) && originHost.toLowerCase() !== host;
}

/** Content-Type 이 application/json 인가(매개변수 `; charset=…` 허용). */
export function isJsonContentType(ct) {
  return String(ct || '').split(';')[0].trim().toLowerCase() === 'application/json';
}

/**
 * 상태 변경 요청(POST/PUT/DELETE) 판정 — 통과면 null, 아니면 { code, error }.
 *   - 교차출처 → 403. 로컬 모드는 위 ①+② 전부, 서버(비밀번호) 모드는 ①만 본다:
 *     서버 모드는 Bearer 헤더 인증이라 교차출처 페이지가 인증을 붙일 수 없고(CSRF 표면 없음),
 *     리버스 프록시가 Host 를 바꾸면(nginx 기본 `proxy_set_header Host $proxy_host`) ② 가
 *     정상 사용자를 막는다.
 *   - POST/PUT 은 Content-Type: application/json 필수 → 415(text/plain 단순 요청 차단).
 *     DELETE 는 본문이 없어 화면이 Content-Type 을 붙이지 않는다 — 있으면 JSON 이어야 하고
 *     없으면 통과한다(DELETE 는 단순 요청이 아니라 교차출처에서는 프리플라이트가 필요하고,
 *     이 서버는 CORS 를 허용하지 않으므로 브라우저가 보내지 않는다).
 */
export function mutationVerdict(method, headers = {}, { loopback = true } = {}) {
  const m = String(method || '').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return null;
  if (loopback ? crossSite(headers) : fetchSiteCross(headers)) {
    return { code: 403, error: '교차 출처 요청은 허용되지 않습니다.' };
  }
  const ct = headers['content-type'];
  if (m === 'DELETE' && !ct) return null;
  if (!isJsonContentType(ct)) {
    return { code: 415, error: 'Content-Type: application/json 이 필요합니다.' };
  }
  return null;
}
