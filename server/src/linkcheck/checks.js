/**
 * linkcheck/checks.js — 단계별 점검 **실행기**(v2.552).
 *
 * 사용자 선택: TCP → TLS(인증서 만료) → HTTP → 인증(토큰) → 정체 대조를 **단계마다 따로 재서**
 * "어느 단계에서 막혔는지" 를 기록한다(이슈 분석 자료가 목적).
 *
 * ⚠⚠ **DNS 를 먼저 따로 잰다.** 이름 해석 실패와 연결 실패는 조치가 정반대인데, 한 번에 붙으면
 *   둘 다 'timeout' 으로 보인다. 또 해석된 주소를 **그 뒤 단계에 넘겨** TOCTOU 를 없앤다
 *   (v2.506 `ssrfLookup` 규약과 같은 판단 — 검사한 주소로 접속한다).
 * ⚠ **SSRF 가드를 통과한 주소만** 찍는다 — 점검 대상 host 는 사용자가 등록한 외부 입력이다.
 * ⚠ 자격증명은 **호출 시점에 등록부에서 직접 읽는다**(링크 객체에 담지 않는다).
 * ⚠ 응답 본문은 **조각만**(`BODY_SNIP`) 남긴다 — 전량을 로그에 담으면 DB 가 폭발하고
 *   자격증명이 섞여 들어올 수 있다.
 */
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { ipBlockReason } from '../collector/registry.js';
// ⚠ DNS 단계가 이미 검사한 주소로 **핀**한다(재해석 금지 — 단계별 계측과 기록의 정직성 때문).
//   판정은 `util/ssrfLookup.js` 하나가 소유한다(v2.506·v2.537 규약 — 훅을 파일마다 복제하지 말 것).
import { pinnedLookup } from '../util/ssrfLookup.js';
import { WAN_TLS_VERIFY } from '../util/resilientFetch.js'; // v2.583: 비밀 헤더를 싣는 점검은 WAN 검증 설정을 따른다
import { certExpiryStatus } from '../security/certMonitor.js';
import { failKindOfCode } from './phases.js';

const BODY_SNIP = 400;
const t = (v) => String(v ?? '').trim();
const ms = (t0) => Date.now() - t0;

/** 1) DNS — IP 리터럴이면 해석하지 않고 그대로 쓴다. */
export async function stepDns(host, { timeoutMs = 5_000 } = {}) {
  const t0 = Date.now();
  const h = t(host);
  if (!h) return { ok: false, ms: 0, failKind: 'dns-fail', error: 'host 가 비어 있습니다.' };
  if (net.isIP(h)) {
    const blocked = ipBlockReason(h);
    if (blocked) return { ok: false, ms: ms(t0), failKind: 'dns-blocked', error: blocked, addrs: [h] };
    return { ok: true, ms: ms(t0), addrs: [h], literal: true };
  }
  try {
    const all = await Promise.race([
      dns.lookup(h, { all: true, verbatim: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`DNS 조회 타임아웃(${Math.round(timeoutMs / 1000)}초)`)), timeoutMs)),
    ]);
    const addrs = (all || []).map((a) => a.address).filter(Boolean);
    if (!addrs.length) return { ok: false, ms: ms(t0), failKind: 'dns-fail', error: '해석 결과가 없습니다.' };
    // ⚠ **차단 대역을 걸러내고 남은 것만** 쓴다(전부 거부하면 이중스택 이름이 하드 실패 — v2.506 규약).
    const allowed = []; const blocked = [];
    for (const a of addrs) { const r = ipBlockReason(a); if (r) blocked.push({ ip: a, reason: r }); else allowed.push(a); }
    if (!allowed.length) {
      return { ok: false, ms: ms(t0), failKind: 'dns-blocked', error: `해석된 주소가 전부 차단 대역입니다(${blocked.map((b) => b.ip).join(', ')}).`, addrs, blocked };
    }
    return { ok: true, ms: ms(t0), addrs: allowed, ...(blocked.length ? { blocked } : {}) };
  } catch (e) {
    const msg = String(e?.message || e);
    return { ok: false, ms: ms(t0), failKind: failKindOfCode(e?.code, msg), error: msg.slice(0, 200) };
  }
}

/** 2) TCP — 해석된 **첫 주소**로 붙는다(DNS 단계가 이미 검사한 주소다). */
export function stepTcp(ip, port, { timeoutMs = 8_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const sock = net.connect({ host: ip, port, family: net.isIPv6(ip) ? 6 : 4 });
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: ms(t0) }); };
    sock.setTimeout(timeoutMs, () => fin({ ok: false, failKind: 'timeout', error: `TCP 연결 타임아웃(${Math.round(timeoutMs / 1000)}초)` }));
    sock.once('connect', () => fin({ ok: true, localPort: sock.localPort }));
    sock.once('error', (e) => fin({ ok: false, failKind: failKindOfCode(e?.code, e?.message), error: `${e?.code || ''} ${e?.message || ''}`.trim().slice(0, 200) }));
  });
}

/**
 * 3) TLS — 핸드셰이크 + **인증서 만료·주체**를 읽는다.
 * ⚠ `rejectUnauthorized:false` 다(이 현장은 자체서명이 흔하다) — 그래서 **검증을 안 하는 대신
 *   만료·발급자를 읽어 화면이 말한다**. 조용히 넘기지 않는 것이 요점이다.
 */
export function stepTls(ip, port, servername, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    /*
     * ⚠ **SNI 에 IP 를 넣지 않는다**(v2.553 에 발견): RFC 6066 이 금지하고 Node 가
     *   `DEP0123` 경고를 내며 앞으로 무시한다. IP 로 등록된 장비(이 현장 다수)에서 매 점검마다
     *   경고가 찍히고, '앞으로 무시' 라 동작도 조용히 바뀐다. 이름일 때만 붙인다.
     */
    const sni = t(servername);
    const sock = tls.connect({
      host: ip, port, ...(sni && !net.isIP(sni) ? { servername: sni } : {}),
      rejectUnauthorized: false, family: net.isIPv6(ip) ? 6 : 4,
    });
    const fin = (r) => { if (done) return; done = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: ms(t0) }); };
    sock.setTimeout(timeoutMs, () => fin({ ok: false, failKind: 'tls-fail', error: `TLS 핸드셰이크 타임아웃(${Math.round(timeoutMs / 1000)}초)` }));
    sock.once('secureConnect', () => {
      let cert = null;
      try { cert = sock.getPeerCertificate(); } catch { /* */ }
      const validTo = cert?.valid_to ? Date.parse(cert.valid_to) : NaN;
      const exp = certExpiryStatus(validTo);
      const info = {
        protocol: sock.getProtocol() || '',
        cipher: sock.getCipher()?.name || '',
        authorized: !!sock.authorized,
        authError: t(sock.authorizationError) || '',
        subject: t(cert?.subject?.CN) || '',
        issuer: t(cert?.issuer?.CN) || '',
        validTo: Number.isFinite(validTo) ? validTo : null,
        certStatus: exp.status, certDaysLeft: exp.daysLeft,
      };
      // 만료는 **실패로 본다** — 접속은 됐지만 그대로 두면 곧 끊긴다.
      if (exp.status === 'expired') return fin({ ok: false, failKind: 'tls-expired', error: `인증서가 만료됐습니다(${exp.daysLeft}일 지남).`, ...info });
      fin({ ok: true, ...info });
    });
    sock.once('error', (e) => fin({ ok: false, failKind: failKindOfCode(e?.code, e?.message), error: `${e?.code || ''} ${e?.message || ''}`.trim().slice(0, 200) }));
  });
}

/**
 * 4~5) HTTP + 인증 + 정체 — 한 번의 요청으로 세 단계를 가른다.
 * @param {object} p
 * @param {string} p.url        전체 URL(스킴·호스트·경로)
 * @param {string} p.ip         DNS 단계가 검사한 주소(여기로 붙는다 — TOCTOU 제거)
 * @param {object} p.headers    토큰 등
 * @param {(json:object,res:object)=>string|null} p.identify  정체 대조(불일치면 사유 문자열)
 * @param {(body:string,res:object)=>string|null} p.identifyRaw  JSON 이 아닌 응답의 정체 대조(XML 등)
 */
export async function stepHttp({ url, ip, headers = {}, timeoutMs = 15_000, identify = null, identifyRaw = null, method = 'GET' } = {}) {
  const t0 = Date.now();
  const out = { http: null, auth: null, identity: null };
  let res;
  let body = '';
  try {
    const { Agent } = await import('undici');
    const u = new URL(url);
    // ⚠ **검사한 IP 로 붙고 SNI·Host 는 원 호스트명**을 쓴다(v2.506 규약).
    // ⚠⚠ v2.583(감사 확정): 예전에는 `rejectUnauthorized: false` 고정 + fetch 기본 `redirect:'follow'` 라,
    //   중앙↔엣지 링크가 싣는 **X-Collector-Token·X-Central-Token 이 검증 안 된 TLS 로 나가고**, 상대가 302 를
    //   주면 **제3의 출처로 그 토큰을 다시 보냈다**(undici 는 authorization·cookie 만 뗀다 — v2.574 SEC-14 와 같은
    //   유형, 여기가 형제 누락). 규칙: 비밀 헤더를 싣는 요청은 WAN 설정(`WAN_TLS_VERIFY`, 기본 검증 ON)을 따르고,
    //   점검 요청은 **리다이렉트를 따라가지 않는다**(3xx 는 그 상태 그대로 결과다). 비밀이 없는 정체 확인
    //   (vCenter·장비 무인증 경로)은 자체서명이 흔하므로 예전처럼 검증하지 않는다 — 보낼 비밀이 없다.
    const carriesSecret = Object.keys(headers || {}).some((k) => /token|authorization|cookie|api-key/i.test(k));
    const dispatcher = new Agent({
      // ⚠ 같은 이유로 SNI 에 IP 를 넣지 않는다(RFC 6066 · Node DEP0123).
      connect: { rejectUnauthorized: carriesSecret ? WAN_TLS_VERIFY : false, lookup: pinnedLookup(ip), ...(net.isIP(u.hostname) ? {} : { servername: u.hostname }) },
      headersTimeout: timeoutMs, bodyTimeout: timeoutMs,
    });
    res = await fetch(url, { method, headers, dispatcher, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    body = (await res.text().catch(() => '')).slice(0, BODY_SNIP * 4);
  } catch (e) {
    // undici 는 원인을 e.cause 에 둔다('fetch failed' 만으로는 원인을 알 수 없다) — 문구에 원인을 덧붙인다.
    const cause = e?.cause?.message ? ` — ${e.cause.message}` : '';
    const msg = `${String(e?.message || e)}${cause}`;
    out.http = { ok: false, ms: ms(t0), failKind: failKindOfCode(e?.code || e?.cause?.code, msg), error: msg.slice(0, 200) };
    return out;
  }
  const httpMs = ms(t0);
  const status = res.status;
  const snippet = body.slice(0, BODY_SNIP);
  const common = { status, ms: httpMs, contentType: t(res.headers.get('content-type')), bodySnippet: snippet, bytes: body.length };

  // ⚠ 401/403/404 는 HTTP 오류가 아니라 **인증 단계**로 가른다 — 조치가 다르다.
  if (status === 401 || status === 403) {
    out.http = { ok: true, ...common };
    out.auth = { ok: false, ms: 0, failKind: 'auth', error: `HTTP ${status} — 토큰이 거부됐습니다.`, status };
    return out;
  }
  if (status === 404) {
    out.http = { ok: true, ...common };
    out.auth = { ok: false, ms: 0, failKind: 'auth', error: 'HTTP 404 — 상대에 그 엔드포인트가 없습니다(토큰 미설정 또는 구버전).', status };
    return out;
  }
  if (status >= 300 && status < 400) {
    // 리다이렉트는 따라가지 않는다(v2.583) — 목적지를 밝혀 사람이 판단하게 한다.
    const loc = t(res.headers.get('location')).slice(0, 200);
    out.http = { ok: false, ...common, failKind: 'http-error', error: `HTTP ${status} — 리다이렉트는 따라가지 않습니다${loc ? `(→ ${loc})` : ''}. 포트포워딩·프록시가 다른 곳으로 보내고 있는지 확인하세요.` };
    return out;
  }
  if (!res.ok) {
    out.http = { ok: false, ...common, failKind: 'http-error', error: `HTTP ${status}` };
    return out;
  }
  out.http = { ok: true, ...common };
  out.auth = { ok: true, ms: 0, status };

  /*
   * ⚠ 정체 대조가 **JSON 이 아닌 경우**도 있다 — vCenter 의 `vimServiceVersions.xml` 은 XML 이다.
   *   JSON 만 받는 분기에 넣으면 그 링크의 정체 단계가 '응답이 JSON 이 아닙니다' 로 **항상 실패**한다.
   *   그래서 원문 대조(`identifyRaw`)를 **먼저** 본다.
   */
  if (identifyRaw) {
    const reason = identifyRaw(body, res);
    out.identity = reason
      ? { ok: false, ms: 0, failKind: 'identity', error: t(reason).slice(0, 300), bodySnippet: snippet }
      : { ok: true, ms: 0 };
    return out;
  }

  if (identify) {
    let json = null;
    try { json = JSON.parse(body); } catch { /* 본문이 JSON 이 아니다 */ }
    if (!json) {
      out.identity = { ok: false, ms: 0, failKind: 'not-portal', error: `응답이 JSON 이 아닙니다(${t(res.headers.get('content-type')) || '타입 없음'}).`, bodySnippet: snippet };
      return out;
    }
    const reason = identify(json, res);
    out.identity = reason
      ? { ok: false, ms: 0, failKind: 'identity', error: t(reason).slice(0, 300), got: { agent: t(json.agent), hostname: t(json.hostname), version: t(json.version), instance: t(json.instance) } }
      : { ok: true, ms: 0, got: { agent: t(json.agent), hostname: t(json.hostname), version: t(json.version) } };
  }
  return out;
}
