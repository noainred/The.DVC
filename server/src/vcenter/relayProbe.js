/**
 * 중계 경로 단계별 진단 — vCenter(또는 중계 HAProxy 엔드포인트)에 대해 TCP 연결 → TLS
 * 핸드셰이크 → HTTP 응답을 각각 짧은 타임아웃으로 분리 테스트한다. "telnet은 되는데 포탈은
 * 멈춤"처럼 어느 단계에서 막혔는지(예: TCP는 OK인데 TLS 무응답 = HAProxy frontend만 살고
 * backend 끊김)를 화면에서 바로 짚게 한다.
 */

import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { ssrfBlockReasonResolved } from '../collector/registry.js';
import { ssrfLookup } from '../util/ssrfLookup.js';   // v2.506: DNS 리바인딩(TOCTOU) 차단
import { splitHostPort } from '../util/hostPort.js';   // v2.603(LEFT2603-02): IPv6 host:port 분리

function tcpStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // v2.506: 4개 접속부 전부에 lookup 을 단다 — 하나라도 빠지면 그 단계가 TOCTOU 로 남는다.
    const sock = net.connect({ host, port, lookup: ssrfLookup });
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done({ ok: true }));
    sock.once('timeout', () => done({ ok: false, error: 'TCP 연결 시간 초과(포트 미개방/방화벽/호스트 다운)' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

function tlsStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch { /* */ } resolve({ ...r, ms: Date.now() - t0 }); };
    const sock = tls.connect(
      // v2.506: lookup 으로 리바인딩 차단(아래 httpStep 과 동일). servername 은 원 호스트 유지.
      { host, port, servername: host, lookup: ssrfLookup, rejectUnauthorized: false, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0', timeout: timeoutMs },
      () => { const c = sock.getPeerCertificate(); done({ ok: true, protocol: sock.getProtocol(), cert: c && c.subject ? { cn: c.subject.CN || '', issuer: c.issuer?.CN || '', validTo: c.valid_to || '' } : null }); },
    );
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => done({ ok: false, error: 'TLS 핸드셰이크 무응답(시간 초과) — TCP는 받지만 암호화 응답이 없음. 중계(HAProxy) frontend만 살아있고 backend(vCenter)로 전달이 끊긴 상태로 의심됩니다.' }));
    sock.once('error', (e) => done({ ok: false, error: e.message }));
  });
}

function httpStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve({ ...r, ms: Date.now() - t0 }); };
    const req = https.request(
      { host, port, path: '/sdk', method: 'GET', rejectUnauthorized: false, servername: host, lookup: ssrfLookup, timeout: timeoutMs },
      (res) => { done({ ok: true, status: res.statusCode }); res.resume(); req.destroy(); },
    );
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'HTTP 응답 시간 초과 — TLS는 되나 vCenter 서비스(vpxd)/경로 응답이 없음' }); });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.end();
  });
}

/**
 * TLS 실패 원인 분류(v2.439). 예전에는 TLS 실패를 **무조건** 'HAProxy backend 끊김 → 재시작' 으로
 * 안내했는데, 실제 현장에서 나온 실패는 전혀 다른 원인이었다:
 *   `error:0A0000C6:SSL routines:tls_get_more_records:packet length too long`
 * 이건 상대가 **평문(HTTP)으로 응답**했는데 우리가 TLS 레코드로 읽어서 나는 오류다(첫 바이트를
 * 레코드 헤더로 해석 → 길이가 터무니없이 큼). 즉 **그 포트는 TLS 가 아니다**. HAProxy 를 재시작해도
 * 절대 고쳐지지 않는데 화면은 재시작을 안내하고 있었다 — 잘못된 조치다.
 * OpenSSL/Node 가 이 상황에서 내는 문구들을 모아 분류한다.
 */
const PLAINTEXT_RE = /packet length too long|wrong version number|record layer failure|unknown protocol|http request|ssl3_get_record|EPROTO/i;
export function classifyTlsError(msg) {
  const m = String(msg || '');
  if (!m) return 'unknown';
  if (/timed? ?out|무응답|ETIMEDOUT/i.test(m)) return 'timeout';
  if (PLAINTEXT_RE.test(m)) return 'plaintext';
  if (/ECONNRESET|socket hang up/i.test(m)) return 'reset';
  return 'unknown';
}

/**
 * 그 포트가 실제로 무엇인지 **평문 HTTP 로 한 번 더** 확인한다(TLS 가 평문이라고 판정됐을 때만).
 * '이 포트는 TLS 가 아니다' 까지만 말하면 사용자는 여전히 무엇을 잘못 등록했는지 모른다 —
 * 응답한 서버의 정체(Server 헤더·상태·포탈 여부)를 근거로 제시해야 조치가 결정된다.
 */
function plainHttpStep(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; resolve({ ...r, ms: Date.now() - t0 }); };
    const req = http.request({ host, port, path: '/', method: 'GET', lookup: ssrfLookup, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 2048) body += c; });   // 앞부분만 — 대용량 페이지를 끌어오지 않는다
      res.on('end', () => done({
        ok: true, status: res.statusCode,
        server: String(res.headers.server || '').slice(0, 60),
        title: (body.match(/<title[^>]*>([^<]{0,80})/i) || [])[1] || '',
        portal: /vmware-portal|The Davinci|Virtual Platform/i.test(body) || /vmware-portal/i.test(String(res.headers['x-powered-by'] || '')),
      }));
      req.destroy();
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: '평문 HTTP 응답 시간 초과' }); });
    req.on('error', (e) => done({ ok: false, error: e.message }));
    req.end();
  });
}

/**
 * 중계 표준 포트 프로파일(relaycheck/settings.js DEFAULT_PROFILE 와 같은 규약). 잘못된 포트를
 * 등록했을 때 '무엇을 대신 써야 하는지' 를 짚어 주기 위한 참고표다 — 값을 바꾸면 저기와 함께 바꿀 것.
 */
const RELAY_PORTS = {
  4000: '중계 엣지(Edge DVC) 자신의 포탈 — 평문 HTTP',
  4001: 'HQ(중앙) 포탈 — 평문 HTTP',
  4065: '중계 엣지 자신의 vCenter(HTTPS)',
  4066: 'IRS vCenter(HTTPS)',
  4067: 'IRS SSH',
  4068: 'IRS 포탈 — 평문 HTTP',
};
const VCENTER_PORTS = [443, 4065, 4066];

/**
 * 단계 결과 → 판정 문구(순수, v2.439). 네트워크 없이 테스트로 고정하기 위해 분리했다 —
 * 이 문구가 사용자가 실제로 따라 하는 조치이므로 원인별로 정확해야 한다.
 */
export function buildVerdict({ port, steps, tlsCause }) {
  const portNote = RELAY_PORTS[port] ? `이 포트(${port})는 중계 표준 규약상 **${RELAY_PORTS[port]}** 입니다.` : '';
  const suggest = VCENTER_PORTS.includes(port) ? '' : ' vCenter 는 보통 **443**(직결) 또는 중계 경유 시 **4065**(엣지 자신의 vCenter) · **4066**(IRS vCenter)입니다.';

  if (!steps.tcp?.ok) return { state: 'tcp', text: 'TCP 연결 자체가 안 됩니다 — 포트 닫힘/방화벽/호스트 다운. 중계/대상 주소를 확인하세요.' };
  if (tlsCause === 'plaintext') {
    // v2.439: 가장 흔한 오등록. 재시작이 아니라 **주소를 고쳐야** 한다.
    const pl = steps.plain;
    const who = pl?.ok
      ? `실제로 평문 HTTP 로 응답했습니다(HTTP ${pl.status}${pl.server ? ` · Server: ${pl.server}` : ''}${pl.title ? ` · "${pl.title}"` : ''})${pl.portal ? ' — **이 포트는 vCenter 가 아니라 포탈** 입니다.' : '.'}`
      : '평문 확인 요청은 응답하지 않았지만, TLS 오류 자체가 이 포트가 TLS 가 아님을 뜻합니다.';
    return {
      state: 'tls-plaintext',
      text: `핵심: 이 포트는 **TLS(HTTPS)가 아닙니다** — 평문으로 응답해 TLS 해석이 실패했습니다(${steps.tls?.error || ''}). ${who} ${portNote}${suggest} HAProxy 를 재시작해도 고쳐지지 않습니다. vCenter 등록 주소의 **포트를 고치거나**, 중계 설정에서 이 포트가 vCenter 로 가도록 바꾸세요.`,
    };
  }
  if (tlsCause === 'reset') return { state: 'tls', text: `TLS 핸드셰이크 중 연결이 끊겼습니다(${steps.tls?.error || ''}). 중계(HAProxy) backend 가 내려갔거나, 대상이 우리 TLS 버전·암호군을 거부했을 수 있습니다 — 중계 서버에서 backend UP 여부를 먼저 확인하세요. ${portNote}` };
  if (steps.tls && !steps.tls.ok) return { state: 'tls', text: `TCP는 되는데 TLS 응답이 없습니다(${steps.tls.error || '무응답'}). 중계(HAProxy) frontend는 TCP만 받고 backend(vCenter)로 전달이 끊긴 상태가 가장 유력합니다 → 중계 서버에서 HAProxy backend UP 여부 확인 후 systemctl restart haproxy. ${portNote}` };
  if (steps.http && !steps.http.ok) return { state: 'http', text: 'TLS는 되는데 HTTP 응답이 없습니다 — vCenter 서비스(vpxd) 지연/중단 또는 경로 문제.' };
  return { state: 'ok', text: '정상 — TCP·TLS·HTTP 모두 응답합니다. 일시적 문제였거나 다음 주기에 복구됩니다.' };
}

/** host(스킴 제거), port(기본 443)에 대해 3단계 테스트. timeoutMs는 단계별 상한. */
export async function probeRelayPath(rawHost, { timeoutMs = 6000 } = {}) {
  const clean = String(rawHost || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  // v2.603(LEFT2603-02): ':' 로 자르면 IPv6(`[2001:db8::10]:443`)의 host 가 '[2001' 이 된다 — 공용 파서로.
  //   접속에는 대괄호 없는 host, SSRF 검사에는 대괄호 붙인 host:port 를 쓴다.
  const hp = splitHostPort(clean);
  const host = hp ? hp.host : clean;
  const port = hp ? hp.port : 443;
  const steps = { tcp: null, tls: null, http: null, plain: null };

  // SSRF/내부 포트스캔 방어 — 이 함수는 임의 host:port로 TCP/TLS/HTTP를 찔러 보고 단계별
  // 성공 여부를 그대로 돌려주므로(오라클), 링크로컬·메타데이터·루프백·미지정 주소는 프로브
  // 자체를 하지 않는다. 등록된 vCenter는 사내망(RFC1918)에 있어 통과한다(가드에서 허용).
  // 호출부(admin.js)를 건드리지 않기 위해 여기서 기존 반환 형태(verdict)로 즉시 반환한다.
  // 이 함수는 이미 async라 DNS 해석까지 검사하는 resolved 가드를 쓴다 — 169.254.169.254로
  // 해석되는 '이름'을 통한 우회(동기 가드는 IP 리터럴만 검사)를 차단한다.
  const blocked = await ssrfBlockReasonResolved(hp ? hp.hostPort : clean);
  if (blocked) {
    return { host, port, steps, blocked: true, reason: blocked, verdict: { state: 'blocked', text: `진단을 수행할 수 없는 주소입니다 — ${blocked}` } };
  }

  steps.tcp = await tcpStep(host, port, timeoutMs);
  if (steps.tcp.ok) steps.tls = await tlsStep(host, port, timeoutMs);
  if (steps.tls?.ok) steps.http = await httpStep(host, port, timeoutMs);

  const tlsCause = steps.tls && !steps.tls.ok ? classifyTlsError(steps.tls.error) : null;
  // 평문으로 판정되면 그 포트의 정체를 확인한다(추가 요청 1회, 같은 host:port — SSRF 가드는 이미 통과).
  if (tlsCause === 'plaintext') steps.plain = await plainHttpStep(host, port, timeoutMs);
  const verdict = buildVerdict({ port, steps, tlsCause });
  return { host, port, steps, tlsCause, portRole: RELAY_PORTS[port] || '', verdict };
}
