/**
 * util/httpsServer.js — 포탈이 **직접 TLS 로** 받을 수 있게 하는 리스너(2026-10-09 검토 S-09, 그룹 J).
 *
 * 왜 필요한가: 이 포탈은 `app.listen()` 하나(평문 HTTP)만 열었다. 중앙 ↔ 엣지 통신에는 수집 토큰
 * (`X-Collector-Token`)·중앙 토큰(`X-Central-Token`)·배포 자격증명·관리 설정이 실리고, 브라우저 원격 콘솔(WS)은
 * 세션 토큰을 쿼리(`?token=`)로 싣는다. 앞에 TLS 종단(HAProxy·nginx)이 없는 현장은 그 전부가 평문이었다
 * (패키지에 TLS 종단 구성은 없다 — `packaging/offline/portal.env.example` 의 `TRUST_PROXY` 는 '프록시가 있다면' 의 안내뿐).
 *
 * 켜는 법(env — 전부 선택. 두 파일을 함께 주면 켜진다):
 *   TLS_CERT_FILE   서버 인증서(PEM). 중간 CA 가 있으면 이 파일에 이어 붙이거나 TLS_CA_FILE 로 준다.
 *   TLS_KEY_FILE    개인키(PEM). 권한은 0600(또는 0640 root:서비스그룹) 권장 — 다른 사용자가 읽을 수 있으면 경고한다.
 *   TLS_CA_FILE     (선택) 체인(중간 CA) — 인증서 뒤에 붙여 함께 보낸다. **클라이언트 인증서 검증(mTLS)이 아니다.**
 *   TLS_PORT        (선택) HTTPS 포트. 기본은 PORT(평문 HTTP 를 HTTPS 로 **바꾼다**).
 *   TLS_HTTP_ALSO   (선택) true 면 PORT 의 평문 HTTP 도 계속 연다(전환 기간용 — TLS_PORT 가 PORT 와 달라야 한다).
 *                   평문이 남아 있다는 사실은 상태(`tlsListenerStatus().httpAlso`)가 말한다.
 *   TLS_RELOAD_CHECK_MS (선택) 인증서·키 파일 변경 확인 주기(기본 3600000 = 1시간, 0 = 끔). 바뀌면 재시작 없이 새 인증서로 바꾼다.
 *
 * ⚠⚠ **설정이 틀렸으면 평문으로 내려가지 않는다(fail-closed).** 두 파일 중 하나만 주었거나·파일을 못 읽거나·
 *   PEM 이 틀렸거나·키와 인증서가 짝이 아니면 `createPortalServers` 가 던지고 index.js 는 사유와 함께 종료한다.
 *   운영자가 TLS 를 원했는데 조용히 HTTP 로 열리면 토큰이 평문으로 나간다 — 그것이 이 기능이 막으려는 사고다.
 *
 * WebSocket(SSH/RDP 원격 콘솔)은 Node 의 https.Server 도 'upgrade' 를 같은 모양으로 내므로 게이트웨이를
 * **모든 서버에** 붙이면 된다(`portal.servers.forEach(...)`). 이 모듈은 Node 내장만 쓴다(util/ 은 도메인을 모른다).
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { numOrNull } from './numOrNull.js';

const RELOAD_DEFAULT_MS = 3600000;
const RELOAD_MIN_MS = 60000;
const RELOAD_MAX_MS = 86400000;
const EXPIRY_WARN_DAYS = 30;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const portOf = (v) => {
  const n = numOrNull(v);
  return n != null && Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
};

/**
 * env → 리스너 설정(순수). 오류가 있으면 `invalid:true` + `errors[]` — 호출자는 켜지 않고 종료해야 한다.
 * @param {object} env  process.env 꼴
 * @param {{port:number}} opts  평문 HTTP 포트(= config.port)
 */
export function tlsListenConfig(env = process.env, { port } = {}) {
  const errors = [];
  const httpPort = portOf(port) ?? 4000;
  const certFile = str(env.TLS_CERT_FILE);
  const keyFile = str(env.TLS_KEY_FILE);
  const caFile = str(env.TLS_CA_FILE);
  const rawReload = env.TLS_RELOAD_CHECK_MS;
  const reloadN = numOrNull(rawReload);
  // 빈 값은 미지정(기본), 0 은 끔, 나머지는 [1분, 1일] 로 가둔다(setInterval 은 2^31−1ms 를 넘으면 1ms 가 된다).
  const reloadMs = reloadN == null ? RELOAD_DEFAULT_MS : (reloadN <= 0 ? 0 : Math.min(RELOAD_MAX_MS, Math.max(RELOAD_MIN_MS, Math.round(reloadN))));
  if (!certFile && !keyFile) {
    if (caFile) errors.push('TLS_CA_FILE 만 지정했습니다 — TLS_CERT_FILE·TLS_KEY_FILE 이 없으면 HTTPS 를 열지 않습니다.');
    if (str(env.TLS_PORT) || env.TLS_HTTP_ALSO === 'true') errors.push('TLS_PORT·TLS_HTTP_ALSO 는 TLS_CERT_FILE·TLS_KEY_FILE 과 함께만 뜻이 있습니다.');
    return { enabled: false, invalid: errors.length > 0, errors, httpPort, tlsPort: null, httpAlso: false, certFile: '', keyFile: '', caFile, reloadMs };
  }
  if (!certFile || !keyFile) {
    errors.push(`TLS_CERT_FILE 과 TLS_KEY_FILE 은 함께 지정해야 합니다(지금: ${certFile ? 'TLS_KEY_FILE 없음' : 'TLS_CERT_FILE 없음'}).`);
  }
  let tlsPort = httpPort;
  if (str(env.TLS_PORT)) {
    const p = portOf(env.TLS_PORT);
    if (p == null) errors.push(`TLS_PORT 가 올바르지 않습니다(1~65535 정수): ${str(env.TLS_PORT).slice(0, 32)}`);
    else tlsPort = p;
  }
  const httpAlso = env.TLS_HTTP_ALSO === 'true';
  if (httpAlso && tlsPort === httpPort) errors.push(`TLS_HTTP_ALSO=true 는 TLS_PORT 가 PORT(${httpPort}) 와 다를 때만 쓸 수 있습니다 — 한 포트에 HTTP 와 HTTPS 를 함께 열 수 없습니다.`);
  return {
    enabled: errors.length === 0,
    invalid: errors.length > 0,
    errors, certFile, keyFile, caFile, tlsPort,
    httpPort: httpAlso ? httpPort : null,
    httpAlso, reloadMs,
  };
}

function readOne(label, file) {
  try { return fs.readFileSync(file); } catch (e) {
    const why = e?.code === 'ENOENT' ? '파일이 없습니다'
      : e?.code === 'EACCES' ? '읽기 권한이 없습니다(서비스 계정이 읽을 수 있는지 확인)'
        : (e?.message || String(e));
    throw new Error(`${label}(${file}) 을(를) 읽지 못했습니다 — ${why}`);
  }
}

/**
 * 인증서·키·체인을 읽고 검증한다. 던지면 그 문구가 그대로 기동 실패 사유다.
 * @returns {{options:{key,cert}, info:object, warnings:string[], stamp:string}}
 */
export function loadTlsMaterial(cfg) {
  const warnings = [];
  const certBuf = readOne('TLS_CERT_FILE', cfg.certFile);
  const keyBuf = readOne('TLS_KEY_FILE', cfg.keyFile);
  const caBuf = cfg.caFile ? readOne('TLS_CA_FILE', cfg.caFile) : null;
  // 체인을 인증서 뒤에 붙여 함께 보낸다(클라이언트가 중간 CA 를 몰라도 검증할 수 있게).
  const cert = caBuf ? Buffer.concat([certBuf, Buffer.from('\n'), caBuf]) : certBuf;
  try { tls.createSecureContext({ key: keyBuf, cert }); } catch (e) {
    throw new Error(`TLS 인증서/개인키를 쓸 수 없습니다 — ${e?.message || e}(PEM 형식·키와 인증서의 짝·암호화된 키 여부를 확인)`);
  }
  const info = { subject: '', issuer: '', san: '', notAfter: null, daysLeft: null, selfSigned: null, fingerprint256: '' };
  try {
    const x = new crypto.X509Certificate(certBuf);
    info.subject = String(x.subject || '').replace(/\n/g, ', ').slice(0, 300);
    info.issuer = String(x.issuer || '').replace(/\n/g, ', ').slice(0, 300);
    info.san = String(x.subjectAltName || '').slice(0, 500);
    const t = Date.parse(x.validTo);
    info.notAfter = Number.isFinite(t) ? t : null;
    info.daysLeft = Number.isFinite(t) ? Math.floor((t - Date.now()) / 86400000) : null;
    info.selfSigned = x.subject === x.issuer;
    info.fingerprint256 = String(x.fingerprint256 || '');
    if (info.daysLeft != null && info.daysLeft < 0) warnings.push(`TLS 인증서가 만료됐습니다(${x.validTo}) — 엣지·브라우저가 연결을 거부합니다.`);
    else if (info.daysLeft != null && info.daysLeft < EXPIRY_WARN_DAYS) warnings.push(`TLS 인증서 만료 ${info.daysLeft}일 남음(${x.validTo}).`);
    if (!info.san) warnings.push('TLS 인증서에 SAN(subjectAltName)이 없습니다 — Node·최신 브라우저는 CN 만으로 호스트를 확인하지 않아 거부합니다.');
  } catch { warnings.push('TLS 인증서 내용을 해석하지 못했습니다(만료일·SAN 미확인).'); }
  try {
    const st = fs.statSync(cfg.keyFile);
    if (process.platform !== 'win32' && (st.mode & 0o007)) warnings.push(`TLS 개인키(${cfg.keyFile}) 를 다른 사용자도 읽을 수 있습니다(권한 ${(st.mode & 0o777).toString(8)}) — chmod 600 권장.`);
  } catch { /* 위에서 이미 읽었다 — stat 실패는 경고만 생략 */ }
  return { options: { key: keyBuf, cert }, info, warnings, stamp: fileStamp(cfg) };
}

function fileStamp(cfg) {
  return [cfg.certFile, cfg.keyFile, cfg.caFile].filter(Boolean).map((f) => {
    try { const s = fs.statSync(f); return `${f}:${s.mtimeMs}:${s.size}`; } catch { return `${f}:missing`; }
  }).join('|');
}

/* ── 상태(이 프로세스의 리스너) ─────────────────────────────────────────────────────────────── */
let _state = { configured: false, tls: false, tlsPort: null, httpPort: null, httpAlso: false, listening: { tls: false, http: false },
  cert: null, warnings: [], reload: { checkMs: 0, lastAt: null, lastOk: null, lastError: null, count: 0 } };

/** 리스너 상태(진단·자체점검·광고 URL 판단용). 파일 경로·지문은 관리 화면 전용 정보다. */
export function tlsListenerStatus() {
  return JSON.parse(JSON.stringify(_state));
}

/**
 * 이 포탈이 **다른 노드에 알릴** 접속 방식(엣지 자기등록 등). TLS 로 리스닝 중이면 https + TLS 포트,
 * 아니면 http + 평문 포트이고 `insecure:true` 다 — TLS 가 없는데 https 로 광고하는 것은 지어낸 값이다.
 * @param {number} [fallbackPort] 리스너가 아직 없을 때(테스트·기동 전) 쓸 평문 포트
 */
export function advertisedListen(fallbackPort) {
  if (_state.tls && _state.tlsPort) return { scheme: 'https', port: _state.tlsPort, insecure: false };
  return { scheme: 'http', port: _state.httpPort || portOf(fallbackPort) || 4000, insecure: true };
}

/**
 * 이 포탈이 **실제로 듣는 포탈 포트 전부**(v2.731 G2b A4-02) — 호스트 접근 제어(방화벽 허용목록·자기 잠금 검사)와
 * svcmon 엣지 진단처럼 '포탈 포트' 를 쓰는 곳은 `config.port` 가 아니라 이 값을 쓴다.
 *
 * 왜: `TLS_PORT` 를 PORT 와 다르게 주면 그 포트에 HTTPS **만** 열고 PORT 는 듣지 않는다(TLS_HTTP_ALSO 가 없을 때 —
 * INSTALL.md 전환 절차의 최종 상태). 그런데 호스트 접근은 `config.port` 만 관리 대상에 넣어, 허용목록을 적용해도 실제
 * 포탈 포트(4443/tcp)는 **모든 출처에 열린 채** 남았다(화면은 '허용목록 적용' — 접근 제어 우회).
 *
 * 순서: TLS 포트가 먼저(광고 포트 — `advertisedListen` 과 같다), TLS_HTTP_ALSO 면 평문 포트도.
 * 리스너를 아직 만들지 않았으면(기동 순서·도구·테스트) **env 로 같은 판정**을 한다 — config.port 로 단정하지 않는다.
 * env 설정이 틀렸으면(createPortalServers 가 기동을 멈출 설정) 평문 포트 하나다.
 * @param {number} [fallbackPort]  평문 포트(= config.port)
 * @param {{env?: object}} [o]
 * @returns {number[]}
 */
export function listeningPortalPorts(fallbackPort, { env = process.env } = {}) {
  const plain = portOf(fallbackPort) || 4000;
  if (_state.created) {
    const out = [];
    if (_state.tls && _state.tlsPort) out.push(_state.tlsPort);
    if (_state.httpPort) out.push(_state.httpPort);
    return out.length ? [...new Set(out)] : [plain];
  }
  const cfg = tlsListenConfig(env, { port: plain });
  if (!cfg.enabled) return [cfg.httpPort || plain];
  return [...new Set([cfg.tlsPort, ...(cfg.httpAlso && cfg.httpPort ? [cfg.httpPort] : [])])];
}

/** 테스트 전용 — 상태를 처음으로 되돌린다. */
export function _resetHttpsServerState() {
  _state = { configured: false, tls: false, tlsPort: null, httpPort: null, httpAlso: false, listening: { tls: false, http: false },
    cert: null, warnings: [], reload: { checkMs: 0, lastAt: null, lastOk: null, lastError: null, count: 0 } };
}

/**
 * 포탈 서버(들)를 만든다. 반환 객체는 index.js 가 `app.listen` 자리에서 쓴다.
 *   const portal = createPortalServers(app, { port: config.port });
 *   portal.servers.forEach(({ server }) => { attachSshGateway(server); ... });
 *   portal.listen(() => { ...기동 로그... });
 * @param {import('express').Express|Function} app
 * @param {{port:number, env?:object, log?:Console}} opts
 * @returns {{ servers: Array<{server, scheme:'http'|'https', port:number}>, primary, scheme, listen(cb), close(cb),
 *             closeAllConnections(), closeIdleConnections(), reloadNow(): {ok:boolean, changed:boolean, reason?:string} }}
 */
export function createPortalServers(app, { port, env = process.env, log = console } = {}) {
  const cfg = tlsListenConfig(env, { port });
  if (cfg.invalid) throw new Error(`[tls] HTTPS 리스너 설정 오류 — ${cfg.errors.join(' ')}`);
  const servers = [];
  let material = null;
  if (cfg.enabled) {
    material = loadTlsMaterial(cfg);
    const s = https.createServer({ ...material.options, minVersion: 'TLSv1.2' }, app);
    servers.push({ server: s, scheme: 'https', port: cfg.tlsPort });
    if (cfg.httpAlso) servers.push({ server: http.createServer(app), scheme: 'http', port: cfg.httpPort });
  } else {
    servers.push({ server: http.createServer(app), scheme: 'http', port: cfg.httpPort });
  }
  _state = {
    created: true, // v2.731 A4-02: listeningPortalPorts 가 env 대신 이 상태를 쓴다
    configured: cfg.enabled,
    tls: cfg.enabled,
    tlsPort: cfg.enabled ? cfg.tlsPort : null,
    httpPort: cfg.enabled ? (cfg.httpAlso ? cfg.httpPort : null) : cfg.httpPort,
    httpAlso: cfg.enabled ? cfg.httpAlso : false,
    listening: { tls: false, http: false },
    cert: material ? material.info : null,
    warnings: material ? material.warnings.slice() : [],
    reload: { checkMs: cfg.enabled ? cfg.reloadMs : 0, lastAt: null, lastOk: null, lastError: null, count: 0 },
  };
  for (const w of _state.warnings) log.warn?.(`[tls] ⚠ ${w}`);

  let stamp = material ? material.stamp : '';
  const httpsEntry = servers.find((x) => x.scheme === 'https');
  /** 인증서·키 파일이 바뀌었으면 다시 읽어 새 연결부터 새 인증서를 쓴다. 실패하면 이전 인증서를 그대로 둔다. */
  const reloadNow = ({ force = false } = {}) => {
    if (!httpsEntry) return { ok: false, changed: false, reason: 'TLS 리스너가 없습니다.' };
    const next = fileStamp(cfg);
    if (!force && next === stamp) return { ok: true, changed: false };
    _state.reload.lastAt = Date.now();
    try {
      const m = loadTlsMaterial(cfg);
      httpsEntry.server.setSecureContext({ ...m.options, minVersion: 'TLSv1.2' });
      stamp = m.stamp;
      _state.cert = m.info; _state.warnings = m.warnings.slice();
      _state.reload.lastOk = true; _state.reload.lastError = null; _state.reload.count += 1;
      log.log?.(`[tls] 인증서를 다시 읽었습니다(${m.info.subject || '주체 미상'}, 만료 ${m.info.daysLeft ?? '?'}일 남음).`);
      for (const w of m.warnings) log.warn?.(`[tls] ⚠ ${w}`);
      return { ok: true, changed: true };
    } catch (e) {
      _state.reload.lastOk = false; _state.reload.lastError = String(e?.message || e).slice(0, 300);
      log.warn?.(`[tls] 인증서 재로드 실패 — 이전 인증서를 계속 씁니다: ${_state.reload.lastError}`);
      stamp = next; // 같은 깨진 파일로 매 주기 같은 경고를 반복하지 않는다(파일이 다시 바뀌면 재시도)
      return { ok: false, changed: false, reason: _state.reload.lastError };
    }
  };
  let reloadTimer = null;
  if (httpsEntry && cfg.reloadMs > 0) {
    reloadTimer = setInterval(() => { try { reloadNow(); } catch { /* 위에서 기록한다 */ } }, cfg.reloadMs);
    reloadTimer.unref?.();
  }

  const listen = (cb) => {
    let pending = servers.length;
    for (const { server, scheme, port: p } of servers) {
      server.listen(p, () => {
        _state.listening[scheme === 'https' ? 'tls' : 'http'] = true;
        if (--pending === 0 && typeof cb === 'function') cb();
      });
    }
    return api;
  };
  const close = (cb) => {
    if (reloadTimer) { clearInterval(reloadTimer); reloadTimer = null; }
    let pending = servers.length;
    const done = () => { if (--pending === 0 && typeof cb === 'function') cb(); };
    for (const { server } of servers) { try { server.close(done); } catch { done(); } }
  };
  const api = {
    servers,
    primary: servers[0].server,
    scheme: servers[0].scheme,
    listen,
    close,
    closeAllConnections: () => { for (const { server } of servers) { try { server.closeAllConnections?.(); } catch { /* Node 18.2 미만 */ } } },
    closeIdleConnections: () => { for (const { server } of servers) { try { server.closeIdleConnections?.(); } catch { /* */ } } },
    reloadNow,
  };
  return api;
}
