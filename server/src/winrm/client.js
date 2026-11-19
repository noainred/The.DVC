/**
 * winrm/client.js — WinRM HTTPS(5986) + NTLMv2 로 PowerShell 하나를 돌리고 출력을 받는다(서버 접속 3단계 · 설계 docs/design/server-access ④).
 *
 * 흐름(연결 하나 — NTLM 은 연결 단위 인증이라 같은 TCP 연결에서 이어야 한다):
 *   ① TLS 연결 · 서버 인증서 판정(security/tlsTrust.deviceTlsConnect — CA 체인 또는 장비 신뢰의 승인 지문. **판정 전에는 아무 바이트도 보내지 않는다**)
 *   ② POST /wsman (본문 없음) + `Authorization: Negotiate <NEGOTIATE>` → 401 + CHALLENGE
 *   ③ 같은 연결로 Create(셸) 본문 + `Authorization: Negotiate <AUTHENTICATE>`(NTLMv2 · MIC · 서버 인증서 채널 바인딩) → 200 + ShellId
 *   ④ Command → Receive(Done 까지) → Signal · Delete. 인증이 거부되면(두 번째 401) **다시 시도하지 않는다**(계정 잠금 방지 — 호출부가 계정 단위 정지).
 * 시한: 호출부의 signal(장비 시한)이 오면 연결째 끊는다. 출력은 상한(maxBytes)에서 자른다(넘치면 실패 — 잘린 출력을 값으로 쓰지 않는다).
 * HTTP(5985)는 쓰지 않는다 — 메시지 봉인(Sealing)을 구현하지 않았다(ntlm.js 머리말). 인증서 판정 모드는 장비 수집기와 같은 env 규칙(WINRM_TLS_VERIFY).
 * ⚠ 실제 Windows 서버로는 아직 확인하지 못했다(정직 기록 — 설계 README §7). 시험은 같은 규격으로 만든 가짜 WinRM 서버로 한다.
 */
import { Agent, request } from 'undici';
import * as NTLM from './ntlm.js';
import * as WS from './wsman.js';
import { deviceTlsConnect, unwrapTlsPeer } from '../security/tlsTrust.js';
import { withSsrfLookup } from '../util/ssrfLookup.js';   // DNS 리바인딩 차단(다른 장비 클라이언트와 같은 연결 옵션)

export const WINRM_PORT = 5986;
const MAX_RESPONSE = 4 * 1024 * 1024;

/** 이 모듈의 오류 — kind 로 호출부가 가른다(auth-rejected 는 인증 정지 · 계정 단위 정지 대상). */
export class WinrmError extends Error {
  constructor(kind, message) { super(message); this.name = 'WinrmError'; this.kind = kind; }
}

let _connect = null;
/** 장비 TLS 판정을 거치는 connect 함수(한 번 만든다). 연결마다 서버 인증서(DER)를 꺼내 채널 바인딩에 쓴다. */
function connectFn() {
  if (!_connect) _connect = deviceTlsConnect({ subsystem: 'winrm', envKey: 'WINRM_TLS_VERIFY', envRaw: process.env.WINRM_TLS_VERIFY, label: 'Windows 원격 관리(WinRM)', tls: withSsrfLookup({}), resume: false });   // 채널 바인딩에 연결마다 서버 인증서가 필요하다
  return _connect;
}

/** 시험용 — env 를 바꾼 뒤 다시 만든다. */
export function _resetWinrmForTest() { _connect = null; }

async function readBody(res, max = MAX_RESPONSE) {
  const chunks = []; let n = 0;
  for await (const c of res.body) {
    n += c.length;
    if (n > max) { try { res.body.destroy(); } catch { /* */ } throw new WinrmError('too-large', `WinRM 응답이 ${Math.round(max / 1024)}KB 를 넘었습니다`); }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const negotiateOf = (headers) => {
  const h = headers['www-authenticate'];
  const list = Array.isArray(h) ? h : (h ? [h] : []);
  for (const v of list) { const m = /^(?:Negotiate|NTLM)\s+([A-Za-z0-9+/=]{20,8192})\s*$/i.exec(String(v).trim()); if (m) return Buffer.from(m[1], 'base64'); }
  return null;
};

/**
 * PowerShell 명령 하나를 돌린다.
 * @param {{host:string, port?:number, username:string, domain?:string, password:string, command:string, args?:string[], timeoutMs?:number, signal?:AbortSignal, maxBytes?:number}} o
 *   username · domain — NTLM 에는 계정명과 도메인을 따로 보낸다(로컬 계정은 도메인 '.' 이 아니라 빈 값 — 서버가 자기 이름으로 본다).
 * @returns {Promise<{stdout:string, stderr:string, exitCode:number|null, ms:number}>}
 */
export async function winrmRun({ host, port = WINRM_PORT, username, domain = '', password, command, args = [], timeoutMs = 60_000, signal, maxBytes = 1024 * 1024 } = {}) {
  if (!host || !username || typeof password !== 'string' || !password) throw new WinrmError('no-secret', 'WinRM 접속에는 계정과 비밀번호가 필요합니다(키 로그인은 SSH 방식에서만 됩니다).');
  const t0 = Date.now();
  let certDer = null;
  const base = connectFn();
  // 연결 하나만(NTLM 연결 단위 인증) · 판정을 통과한 소켓의 인증서를 채널 바인딩에 쓴다.
  const agent = new Agent({ connections: 1, pipelining: 1, keepAliveTimeout: 30_000, bodyTimeout: timeoutMs, headersTimeout: Math.min(timeoutMs, 60_000),
    connect: (opts, cb) => base(opts, (err, socket) => {
      if (!err && socket && typeof socket.getPeerCertificate === 'function') { try { certDer = socket.getPeerCertificate(false)?.raw || null; } catch { certDer = null; } }
      // 인증서를 못 꺼내면(이어 쓴 세션 등) 채널 바인딩이 0 이 되어 확장 보호(EPA)를 켠 서버가 거부한다 — 비밀번호를 보내기 전에 끊는다
      if (!err && socket && !certDer) { try { socket.destroy(); } catch { /* */ } return cb(new WinrmError('tls-peer', 'WinRM 서버 인증서를 꺼내지 못해(채널 바인딩) 연결하지 않았습니다.')); }
      cb(err, socket);
    }) });
  const ac = new AbortController();
  // 시한 · 호출부 취소가 오면 연결째 끊는다 — undici 는 연결(TLS 핸드셰이크) 중인 요청의 abort 를 그 연결이 끝날 때까지 미룬다(실측: 1.5초 시한이 10.5초에 끝남).
  //   Agent 를 부수면 연결 중인 소켓도 닫혀 바로 끝난다.
  const kill = (reason) => { if (!ac.signal.aborted) ac.abort(reason); agent.destroy(reason).catch(() => {}); };
  const onAbort = () => kill(signal?.reason instanceof WinrmError ? signal.reason : new WinrmError('timeout', 'WinRM 시한 초과(호출부 취소)'));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const timer = setTimeout(() => kill(new WinrmError('timeout', `WinRM 시한 초과(${Math.round(timeoutMs / 1000)}초)`)), timeoutMs);
  timer.unref?.();
  const url = `https://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${Number(port) || WINRM_PORT}/wsman`;
  const post = async (body, auth) => {
    try {
      const res = await request(url, { method: 'POST', dispatcher: agent, signal: ac.signal,
        headers: { 'content-type': 'application/soap+xml;charset=UTF-8', 'user-agent': 'portal-winrm/1', ...(auth ? { authorization: auth } : {}) }, body: body || '' });
      const text = await readBody(res);
      return { status: res.statusCode, headers: res.headers, text };
    } catch (e) {
      const ex = unwrapTlsPeer(e);
      if (ex?.name === 'TlsPeerError') throw new WinrmError('tls-peer', ex.message);
      if (ex instanceof WinrmError) throw ex;
      if (ac.signal.aborted) throw (ac.signal.reason instanceof WinrmError ? ac.signal.reason : new WinrmError('timeout', 'WinRM 시한 초과'));
      throw new WinrmError('connect', `WinRM 에 접속하지 못했습니다(${String(ex?.code || ex?.message || ex).replace(/\s+/g, ' ').slice(0, 120)})`);
    }
  };
  const call = async (action, body, { selector = '', options = '' } = {}, auth = '') => {
    const r = await post(WS.envelope({ to: url, action, selector, body, options, timeoutS: Math.max(5, Math.floor(timeoutMs / 1000) - 2) }), auth);
    if (r.status === 401) throw new WinrmError('auth-rejected', 'authentication failed — WinRM 이 로그인을 거부했습니다(다시 시도하지 않습니다).');
    if (r.status >= 400) {
      const why = WS.faultReason(r.text);
      if (action === WS.ACTION.receive && WS.isReceiveTimeout(r.text)) return { timeout: true, text: r.text };
      throw new WinrmError('fault', `WinRM 오류(HTTP ${r.status})${why ? ` — ${why}` : ''}`);
    }
    return { text: r.text };
  };
  try {
    // ② NEGOTIATE — 본문 없는 요청에 인증 머리만(대부분의 서버가 401 + CHALLENGE 로 답한다)
    const neg = NTLM.negotiateMessage();
    const r1 = await post('', `Negotiate ${neg.toString('base64')}`);
    if (r1.status !== 401) throw new WinrmError('fault', `WinRM 이 NTLM 협상에 답하지 않았습니다(HTTP ${r1.status}) — Negotiate 인증이 꺼져 있을 수 있습니다.`);
    const chBuf = negotiateOf(r1.headers);
    if (!chBuf) throw new WinrmError('fault', 'WinRM 이 NTLM CHALLENGE 를 주지 않았습니다(Negotiate · NTLM 인증이 꺼져 있거나 Kerberos 만 허용 — Kerberos 는 지원하지 않습니다).');
    let ch;
    try { ch = NTLM.readChallenge(chBuf); } catch (e) { throw new WinrmError('fault', String(e?.message || e)); }
    const { message } = NTLM.authenticateMessage({ user: username, domain, password, negotiate: neg, challenge: ch, certDer });
    // ③ AUTHENTICATE 와 함께 셸 만들기(같은 연결)
    const created = await call(WS.ACTION.create, WS.createShellBody(), { options: WS.CREATE_OPTIONS }, `Negotiate ${message.toString('base64')}`);
    const shellId = WS.parseShellId(created.text);
    let commandId = '';
    try {
      const cmd = await call(WS.ACTION.command, WS.commandBody(command, args), { selector: shellId, options: WS.COMMAND_OPTIONS });
      commandId = WS.parseCommandId(cmd.text);
      const out = { stdout: [], stderr: [], n: 0 };
      let exitCode = null;
      for (let i = 0; i < 1000; i += 1) {
        const rr = await call(WS.ACTION.receive, WS.receiveBody(commandId), { selector: shellId });
        if (rr.timeout) continue;
        const p = WS.parseReceive(rr.text);
        for (const k of ['stdout', 'stderr']) for (const b of p[k]) { out.n += b.length; if (out.n > maxBytes) throw new WinrmError('too-large', `출력이 ${Math.round(maxBytes / 1024)}KB 를 넘었습니다`); out[k].push(b); }
        if (p.done) { exitCode = p.exitCode; break; }
      }
      return { stdout: Buffer.concat(out.stdout).toString('utf8'), stderr: Buffer.concat(out.stderr).toString('utf8').slice(0, 4000), exitCode, ms: Date.now() - t0 };
    } finally {
      // 정리 — 실패해도 결과를 바꾸지 않는다(시한이 이미 지났으면 하지 않는다)
      if (!ac.signal.aborted) {
        if (commandId) await call(WS.ACTION.signal, WS.signalBody(commandId), { selector: shellId }).catch(() => {});
        await call(WS.ACTION.delete, '', { selector: shellId }).catch(() => {});
      }
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
    agent.destroy().catch(() => {});
  }
}
