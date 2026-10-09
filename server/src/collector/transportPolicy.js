/**
 * collector/transportPolicy.js — 중앙 ↔ 엣지 URL 의 **전송 보호 정책**(2026-10-09 검토 S-09, 그룹 J).
 *
 * 왜: 수집 서버 URL 로 중앙이 `X-Collector-Token` 을 실어 export·설정 동기화·업그레이드 번들 push·엣지 비밀번호 변경을
 * 보낸다. 예전 등록부는 스킴 없는 주소에 `http://` 를 붙였고 평문 HTTP 를 그대로 받았다 — 경로에 VPN·IPsec 같은 별도
 * 보호가 없으면 관측자가 토큰을 재사용하거나 설정·수집 데이터를 바꿀 수 있다(사설 IP 라는 사실만으로는 보호되지 않는다).
 * `WAN_TLS_INSECURE` 기본 OFF 는 **HTTPS 인증서 검증** 정책일 뿐 HTTP 를 암호화하지 않는다.
 *
 * 정책(사용자 승인 — 기본값 전환: 원격 URL 은 HTTPS 가 기본, HTTP 는 승인된 예외만):
 *   ① 스킴 없는 주소는 `https://` 를 붙인다(`withDefaultScheme`).
 *   ② `https://` 와 **루프백**(127.0.0.0/8 · ::1 · localhost) `http://` 는 그대로 받는다(망을 지나지 않는다).
 *   ③ 그 밖의 `http://` 는 아래 중 하나일 때만 받는다 — 아니면 거부(`code:'insecure-http'`):
 *      a. **이미 저장된 항목의 URL 이 그대로**인 경우(기존 현장이 업그레이드 즉시 끊기지 않게 — 화면이 '평문 HTTP 사용 중' 으로 경고한다)
 *      b. 관리자 화면·API 의 **명시적 예외**: `allowInsecureHttp:true` + 사유(`insecureHttpReason`, 3~200자). 누가·언제·왜 를 항목에 남기고
 *         라우트가 감사 로그에 적는다. 자기등록·배포 자동 등록 같은 비-관리자 경로는 이 필드를 쓸 수 없다.
 *      c. 운영자가 중앙 `portal.env` 에 둔 허용 목록 `COLLECTOR_HTTP_ALLOW`(쉼표 구분 — IPv4·CIDR·호스트 이름, `*` 는 전체)에 맞는 경우.
 *   ④ URL 이 바뀌면 예외 기록은 **승계하지 않는다**(저장 토큰을 승계하지 않는 v2.503 규칙과 같은 판단 — 승인은 그 주소에 대한 것이다).
 *
 * 비-관리자 경로(엣지 자기등록·배포 자동 등록)에서 거부된 시도는 인메모리 기록(`rejectedHttpRegistrations`)으로 남아
 * 화면이 '어느 엣지가 평문 HTTP 로 등록하려다 거부됐는가' 를 말한다(엣지는 자기 로그에만 사유를 남기므로 중앙에서 볼 길이 없었다).
 */
import { strictIpv4Num, cidrMatch } from '../util/ipv4.js';

export const INSECURE_HTTP_CODE = 'insecure-http';
export const INSECURE_HTTP_REASON_CODE = 'insecure-http-reason';
export const REASON_MIN = 3;
export const REASON_MAX = 200;
const ALLOW_RULES_MAX = 200;
const REJECTED_MAX = 50;

/** 스킴이 없으면 https:// 를 붙인다(새 기본값). 스킴 대소문자는 소문자로. */
export function withDefaultScheme(url) {
  const s = String(url ?? '').trim();
  if (!s) return s;
  if (/^https?:\/\//i.test(s)) return s.replace(/^https?:/i, (m) => m.toLowerCase());
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // 다른 스킴은 그대로(형식 검사가 거부한다)
  return `https://${s}`;
}

/** 루프백 호스트인가(이름 해석은 하지 않는다 — localhost 계열 이름과 IP 리터럴만). */
export function isLoopbackHost(hostname) {
  const h = String(hostname ?? '').replace(/^\[|\]$/g, '').toLowerCase();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const n = strictIpv4Num(h);
  if (typeof n === 'number') return (n >>> 24) === 127;
  return false;
}

/**
 * URL 하나의 전송 보호 상태(순수).
 * @returns {{scheme:string, host:string, loopback:boolean, insecure:boolean, valid:boolean}}
 */
export function urlTransport(url) {
  try {
    const u = new URL(String(url ?? ''));
    const scheme = u.protocol.replace(/:$/, '');
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const loopback = isLoopbackHost(host);
    return { scheme, host, loopback, insecure: scheme === 'http' && !loopback, valid: true };
  } catch {
    return { scheme: '', host: '', loopback: false, insecure: false, valid: false };
  }
}

/** 비교용 정규형 — 스킴·호스트(소문자)·포트(기본 포트 보정)·경로(끝 슬래시 제거). 파싱 실패면 ''. */
export function canonUrl(url) {
  try {
    const u = new URL(String(url ?? '').trim());
    const port = u.port || (u.protocol === 'https:' ? '443' : u.protocol === 'http:' ? '80' : '');
    let p = u.pathname || '';
    while (p.endsWith('/')) p = p.slice(0, -1);
    return `${u.protocol}//${u.hostname.toLowerCase()}:${port}${p}`;
  } catch { return ''; }
}

/* ── 운영자 허용 목록(COLLECTOR_HTTP_ALLOW) ─────────────────────────────────────────────── */

/**
 * env → 규칙 목록(순수). 형식이 틀린 항목은 `invalid` 로 따로 센다(조용히 버리지 않는다).
 * 규칙: `*`(전체) · IPv4 · IPv4/CIDR · 호스트 이름(정확히 일치, 대소문자 무시).
 */
export function parseHttpAllowlist(env = process.env) {
  const raw = String((env && env.COLLECTOR_HTTP_ALLOW) ?? '').slice(0, 8192);
  const rules = []; const invalid = [];
  for (const part of raw.split(',')) {
    const t = part.trim().toLowerCase();
    if (!t) continue;
    if (rules.length >= ALLOW_RULES_MAX) { invalid.push(t.slice(0, 64)); continue; }
    if (t === '*') { rules.push({ kind: 'all', text: '*' }); continue; }
    if (/^[0-9./]+$/.test(t)) {
      if (cidrMatch(0, t) == null) { invalid.push(t.slice(0, 64)); continue; }
      rules.push({ kind: 'ipv4', text: t });
      continue;
    }
    if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(t) && t.length <= 253) {
      rules.push({ kind: 'host', text: t });
      continue;
    }
    invalid.push(t.slice(0, 64));
  }
  return { rules, invalid, wildcard: rules.some((r) => r.kind === 'all') };
}

/** URL 의 호스트가 허용 목록에 맞으면 그 규칙 문자열, 아니면 null. IPv4 는 정규형일 때만 비교한다. */
export function allowlistMatch(url, env = process.env) {
  const { rules } = parseHttpAllowlist(env);
  if (!rules.length) return null;
  const t = urlTransport(url);
  if (!t.valid) return null;
  const n = strictIpv4Num(t.host);
  for (const r of rules) {
    if (r.kind === 'all') return '*';
    if (r.kind === 'ipv4' && typeof n === 'number' && cidrMatch(n, r.text) === true) return r.text;
    if (r.kind === 'host' && r.text === t.host) return r.text;
  }
  return null;
}

/** 허용 목록 요약(화면용 — 규칙 원문은 관리 화면에만 싣는다). */
export function allowlistSummary(env = process.env) {
  const { rules, invalid, wildcard } = parseHttpAllowlist(env);
  return { configured: rules.length > 0, rules: rules.map((r) => r.text), invalid, wildcard };
}

/* ── 저장 판정 ───────────────────────────────────────────────────────────────────────── */

function cleanReason(v) {
  if (typeof v !== 'string') return '';
  return [...v].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127).join('').trim().slice(0, REASON_MAX);
}

const SOURCE_FIX = {
  admin: "엣지에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 https:// 주소로 등록하세요. VPN·IPsec 처럼 별도로 보호된 구간이라 HTTP 가 꼭 필요하면 '평문 HTTP 예외' 를 체크하고 사유를 적으세요.",
  'self-register': '엣지에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 EDGE_ADVERTISE_URL=https://… 로 알리거나, 관리자가 설정 › 수집 서버에서 사유와 함께 예외로 등록하거나, 중앙 portal.env 의 COLLECTOR_HTTP_ALLOW 에 이 주소를 넣으세요.',
  internal: '엣지에 TLS 를 켜고 https:// 주소(광고 URL)를 쓰거나, 관리자가 설정 › 수집 서버에서 사유와 함께 예외로 등록하거나, 중앙 portal.env 의 COLLECTOR_HTTP_ALLOW 에 이 주소를 넣으세요.',
};

/**
 * 수집 서버 URL 저장 판정(순수 — 시각은 now 로 받는다).
 * @param {{url:string, existing?:object|null, body?:object, ctx?:{source?:string, actor?:string}, env?:object, now?:number}} p
 * @returns {{ok:true, exception:object|null, transport:object} | {ok:false, code:string, reason:string, transport:object}}
 *   exception: 항목에 남길 예외 기록(null 이면 지운다). ok 일 때 `keep:true` 면 기존 기록을 그대로 둔다.
 */
export function evaluateCollectorUrl({ url, existing = null, body = {}, ctx = null, env = process.env, now = Date.now() } = {}) {
  const transport = urlTransport(url);
  if (!transport.insecure) return { ok: true, exception: null, transport };
  const source = ctx?.source === 'admin' || ctx?.source === 'self-register' ? ctx.source : 'internal';
  const sameAsSaved = existing && canonUrl(existing.url) && canonUrl(existing.url) === canonUrl(url);
  const wantsException = source === 'admin' && body?.allowInsecureHttp === true;
  if (wantsException) {
    const reason = cleanReason(body?.insecureHttpReason);
    if (reason.length < REASON_MIN) {
      return { ok: false, code: INSECURE_HTTP_REASON_CODE, transport,
        reason: `평문 HTTP 예외에는 사유가 필요합니다(${REASON_MIN}~${REASON_MAX}자 — 예: 'IPsec 터널 안 구간').` };
    }
    // 같은 주소·같은 사유로 이미 승인돼 있으면 그대로 둔다 — 다른 칸만 고친 저장이 승인자·시각을 덮어쓰지 않게(감사도 새로 남기지 않는다).
    const prev = existing?.insecureHttp;
    if (sameAsSaved && prev && prev.source === 'admin' && String(prev.reason || '') === reason) return { ok: true, transport, keep: true };
    return { ok: true, transport, exception: { source: 'admin', reason, by: String(ctx?.actor || '').slice(0, 128) || '(알 수 없음)', at: now } };
  }
  if (sameAsSaved) {
    // 관리자가 예외를 명시적으로 내리면(false) 기록을 지운다 — 기존 주소라 계속 동작하되 '승인 기록 없음' 으로 보인다.
    if (source === 'admin' && body?.allowInsecureHttp === false) return { ok: true, exception: null, transport, legacy: true };
    return { ok: true, transport, keep: true, legacy: !existing.insecureHttp };
  }
  const rule = allowlistMatch(url, env);
  if (rule) return { ok: true, transport, exception: { source: 'env', rule, at: now } };
  return { ok: false, code: INSECURE_HTTP_CODE, transport,
    reason: `평문 HTTP 주소(${transport.host})는 승인된 예외만 받습니다 — 수집 토큰과 설정이 암호화되지 않은 채 전송됩니다. ${SOURCE_FIX[source]}` };
}

/**
 * 저장된 항목의 전송 상태(화면·자체점검용, 순수).
 * state: 'tls' | 'loopback' | 'http-approved'(관리자 예외) | 'http-allowlisted'(허용 목록) | 'http-legacy'(승인 기록 없는 기존 항목) | 'invalid'
 */
export function transportOf(entry, env = process.env) {
  const t = urlTransport(entry?.url);
  if (!t.valid) return { state: 'invalid', scheme: '', insecure: false };
  if (t.scheme === 'https') return { state: 'tls', scheme: 'https', insecure: false };
  if (t.loopback) return { state: 'loopback', scheme: 'http', insecure: false };
  const ex = entry?.insecureHttp;
  if (ex && typeof ex === 'object' && ex.source === 'admin') {
    return { state: 'http-approved', scheme: 'http', insecure: true, exception: { source: 'admin', reason: String(ex.reason || ''), by: String(ex.by || ''), at: Number(ex.at) || null } };
  }
  const rule = allowlistMatch(entry?.url, env);
  if (rule) return { state: 'http-allowlisted', scheme: 'http', insecure: true, rule };
  if (ex && typeof ex === 'object' && ex.source === 'env') {
    // 등록 당시 허용 목록에 있었지만 지금은 빠졌다 — 계속 동작하되 그 사실을 말한다.
    return { state: 'http-legacy', scheme: 'http', insecure: true, formerRule: String(ex.rule || '') };
  }
  return { state: 'http-legacy', scheme: 'http', insecure: true };
}

/** 등록부 전체의 전송 상태 개수(겹치지 않는다 — 합계 = 전 항목). */
export function transportSummary(collectors = [], env = process.env) {
  const s = { total: 0, tls: 0, loopback: 0, httpApproved: 0, httpAllowlisted: 0, httpLegacy: 0, invalid: 0, insecure: 0 };
  for (const c of collectors || []) {
    if (!c || typeof c !== 'object') continue;
    const t = transportOf(c, env);
    s.total++;
    if (t.state === 'tls') s.tls++;
    else if (t.state === 'loopback') s.loopback++;
    else if (t.state === 'http-approved') s.httpApproved++;
    else if (t.state === 'http-allowlisted') s.httpAllowlisted++;
    else if (t.state === 'http-legacy') s.httpLegacy++;
    else s.invalid++;
    if (t.insecure) s.insecure++;
  }
  return s;
}

/* ── 비-관리자 경로의 거부 기록(인메모리) ────────────────────────────────────────────────── */
let _rejected = [];

/** 거부 1건을 남긴다(같은 출처·이름은 최신 것으로 교체). 토큰은 받지도 남기지도 않는다. */
export function recordRejectedHttpRegistration({ source, name, url, now = Date.now() } = {}) {
  const src = source === 'self-register' ? 'self-register' : 'internal';
  const nm = String(name ?? '').slice(0, 128);
  let host = '';
  try { const u = new URL(String(url)); host = `${u.protocol}//${u.host}`; } catch { host = String(url ?? '').slice(0, 200); }
  const prev = _rejected.find((r) => r.source === src && r.name === nm);
  _rejected = _rejected.filter((r) => r !== prev);
  _rejected.unshift({ source: src, name: nm, url: host.slice(0, 260), at: now, count: (prev?.count || 0) + 1 });
  if (_rejected.length > REJECTED_MAX) _rejected.length = REJECTED_MAX;
}
/** 최근 거부 기록(최신 먼저). 같은 이름의 항목이 나중에 등록되면 화면이 걸러 보인다. */
export function rejectedHttpRegistrations() { return _rejected.map((r) => ({ ...r })); }
/** 그 이름의 거부 기록을 지운다(관리자가 등록·예외 승인한 뒤). */
export function clearRejectedHttpRegistration(name) {
  const nm = String(name ?? '').toLowerCase();
  _rejected = _rejected.filter((r) => r.name.toLowerCase() !== nm);
}
/** 테스트 전용. */
export function _resetRejected() { _rejected = []; }

/* ── 엣지 쪽: 중앙 URL 판정 · 자기등록 URL 조립 ─────────────────────────────────────────── */

/**
 * 엣지의 CENTRAL_URL 판정(순수). 비어 있으면 configured:false.
 * insecure 면 경고 문구를 준다 — 이 엣지가 중앙에 보내는 X-Central-Token·인벤토리·결과가 평문이다.
 */
export function centralUrlTransport(url) {
  const s = String(url ?? '').trim();
  if (!s) return { configured: false, insecure: false, scheme: '', warning: '' };
  const t = urlTransport(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  if (!t.valid) return { configured: true, insecure: false, scheme: '', warning: `CENTRAL_URL 형식이 올바르지 않습니다: ${s.slice(0, 120)}` };
  return {
    configured: true, insecure: t.insecure, scheme: t.scheme, host: t.host,
    warning: t.insecure ? `CENTRAL_URL 이 평문 HTTP(${t.host}) 입니다 — 중앙 토큰(X-Central-Token)·인벤토리·수집 결과가 암호화되지 않은 채 전송됩니다. 중앙에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 CENTRAL_URL=https://… 로 바꾸세요(사설 CA 면 이 엣지에 WAN_TLS_CA_FILE).` : '',
  };
}

/**
 * 자기등록에서 중앙이 피어 IP 로 URL 을 유도할 때(순수). 엣지가 알린 scheme 이 https 일 때만 https —
 * 알리지 않으면(구버전 엣지) 예전처럼 http 이고, 그 http 는 위 저장 판정을 받는다.
 */
export function selfRegisterDerivedUrl({ ip, port, scheme } = {}) {
  const h = String(ip ?? '');
  const host = h.includes(':') && !h.startsWith('[') ? `[${h}]` : h;
  return `${scheme === 'https' ? 'https' : 'http'}://${host}:${port}`;
}

/* ── 보안 자체점검 항목(security/selfCheck.js 가 부른다 — 입력은 주입, 순수) ─────────────────── */

/**
 * '중앙 ↔ 엣지 전송 보호' 자체점검 한 줄. 상태 기준:
 *   risk — 승인 기록 없는 평문 HTTP 수집 서버가 있다 · 이 엣지의 CENTRAL_URL 이 평문이다
 *   warn — 평문은 예외 승인·허용 목록 것뿐이다 · 이 포탈이 평문 HTTP 로만 받는다(앞단 TLS 종단이 있으면 무시 — 포탈은 그 존재를 모른다)
 *          · 사설 CA 파일을 쓰지 못했다 · TLS 인증서 경고(만료 임박 등)
 *   ok   — 그 밖
 * @param {{collectors?:object[], env?:object, listener?:object, wanTls?:object, centralUrl?:string}} p
 */
export function wanTransportCheckItem({ collectors = [], env = process.env, listener = null, wanTls = null, centralUrl = '' } = {}) {
  const s = transportSummary(collectors, env);
  const rows = [];
  for (const c of collectors || []) {
    if (!c || typeof c !== 'object') continue;
    const t = transportOf(c, env);
    if (!t.insecure) continue;
    if (rows.length >= 50) break;
    rows.push({ id: String(c.id || ''), url: String(c.url || '').slice(0, 200), state: t.state, reason: t.exception?.reason || t.rule || '' });
  }
  const central = centralUrlTransport(centralUrl);
  const notes = [];
  let status = 'ok';
  const bump = (st) => { if ((st === 'risk') || (st === 'warn' && status === 'ok')) status = st; };
  if (s.httpLegacy) { bump('risk'); notes.push(`승인 기록 없는 평문 HTTP 수집 서버 ${s.httpLegacy}대 — 수집 토큰이 암호화되지 않은 채 전송된다.`); }
  if (s.httpApproved + s.httpAllowlisted) { bump('warn'); notes.push(`예외로 승인된 평문 HTTP 수집 서버 ${s.httpApproved + s.httpAllowlisted}대(관리자 예외 ${s.httpApproved} · 허용 목록 ${s.httpAllowlisted}).`); }
  if (central.insecure) { bump('risk'); notes.push(central.warning); }
  if (listener && !listener.tls) { bump('warn'); notes.push('이 포탈은 평문 HTTP 로만 받는다(TLS_CERT_FILE·TLS_KEY_FILE 미설정) — 앞단에 TLS 종단(HAProxy·nginx)이 있으면 무시해도 된다.'); }
  if (listener?.tls && listener.httpAlso) { bump('warn'); notes.push(`HTTPS 와 함께 평문 HTTP(:${listener.httpPort})도 열려 있다(TLS_HTTP_ALSO — 전환 기간용).`); }
  for (const w of listener?.warnings || []) { bump('warn'); notes.push(w); }
  if (wanTls?.caError) { bump('warn'); notes.push(wanTls.caError); }
  return {
    id: 'wan-transport',
    group: '통신·실행',
    title: '중앙↔엣지 전송 보호(HTTPS)',
    status,
    detail: notes.length ? notes.join(' ') : `수집 서버 ${s.total}대 전부 HTTPS 또는 루프백${listener?.tls ? ' · 이 포탈은 HTTPS 로 받는다' : ''}.`,
    rows,
    evidence: 'collectors.json · TLS_CERT_FILE/TLS_KEY_FILE · WAN_TLS_CA_FILE · COLLECTOR_HTTP_ALLOW · CENTRAL_URL',
    howto: status === 'ok' ? '' : '엣지·중앙에 TLS(TLS_CERT_FILE·TLS_KEY_FILE)를 켜고 수집 서버 URL·CENTRAL_URL 을 https:// 로 바꾼다. 사설 CA 는 WAN_TLS_CA_FILE 로 신뢰시킨다. HTTP 가 꼭 필요한 보호 구간만 설정 › 수집 서버에서 사유와 함께 예외로 둔다.',
    summary: s,
  };
}
