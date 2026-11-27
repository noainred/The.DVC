/**
 * guacd (Apache Guacamole proxy daemon) WebSocket tunnel for browser RDP.
 *
 * The browser runs guacamole-common-js (Guacamole.Client) over a WebSocket at
 * /api/remote/rdp. This server performs the guacd handshake (select → args →
 * size/audio/video/image → connect → ready) using connection settings derived
 * from the mapping (host = proxyHost:publicPort) and the user's RDP credentials,
 * then relays the protocol stream between the browser and guacd.
 *
 * Requires a reachable guacd (configured under remote-access → guacd). Untested
 * without a live guacd — verify in your environment.
 */

import net from 'node:net';
import tls from 'node:tls';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer } from 'ws';
import { openGuacdSocket, rdpIgnoreCertArg } from './guacdTransport.js';
/*
 * v2.631(AX3-01): 프레임 상한. ws 기본 maxPayload 는 100MiB 라 인증된 operator(remote.access 기본 보유)가 프레임당 100MB 를 보내
 *   문자열화·파싱(동시 세션 × 100MB)으로 이벤트 루프·힙을 누를 수 있었다. 넘는 프레임은 ws 가 1009 로 닫는다.
 *   guacd 릴레이(클립보드·파일 조각 포함)에 필요한 폭.
 */
export const GUAC_WS_MAX_PAYLOAD = 4 * 1024 * 1024;
import { resolveTokenUser } from '../auth/auth.js';
import { getMapping, touchMapping, mappingProxyOf } from './registry.js';
import { consumeRdpTicket } from './rdpTicket.js';
import { config } from '../config.js';
// WS 매핑 소유·scope 재검사 공용(v2.322) + 사용자 판정·열린 세션 재검증 공용(2026-10-09 S-04 — SSH 게이트웨이와 **같은 함수**).
//   remoteUserIssue = 토큰 무효는 401, OTP 등록 전 세션·데모 계정·원격 접속 권한 없음은 403(판정 본문은 sshGateway.js 에 하나만 둔다).
import { mappingAccessIssue, remoteUserIssue, remoteUpgradeAuth, trackRemoteSession, safeWsClose, authDisabledRemoteUser, MAX_SESSIONS, MAX_SESSIONS_PER_USER } from './sshGateway.js';

/*
 * 79회차(76회차 '남긴 것' 결정 — 권장안): RDP 동시 세션 상한. guacd 는 연결마다 RDP 프로세스(수십~수백 MB)를 띄우는데 상한이 없었다 —
 *   SSH 게이트웨이와 **같은 방식 · 같은 값**(전체 MAX_SESSIONS · 계정당 MAX_SESSIONS_PER_USER — 같은 env, 0 = 계정당 끔)으로 따로 센다.
 *   넘치면 **티켓을 소비하기 전에** 4429 + 사유('too-many-sessions' · 'too-many-sessions-user' — 웹 remote/sshSend.js 표와 1:1)로 닫는다.
 *   세는 시점은 티켓이 확인된 뒤(티켓 없음으로 닫힌 연결은 세지 않는다) · 푸는 곳은 ws close · error · guacd close(한 번만).
 */
let _rdpActive = 0;
const _rdpPerUser = new Map();   // username(소문자) → 열린 RDP 세션 수
const lcUser = (u) => String(u?.username || 'anonymous').toLowerCase();
/** 넘치면 사유 코드(닫힘 사유), 아니면 null. */
export function rdpSessionCapIssue(user) {
  if (_rdpActive >= MAX_SESSIONS) return 'too-many-sessions';
  if (MAX_SESSIONS_PER_USER > 0 && (_rdpPerUser.get(lcUser(user)) || 0) >= MAX_SESSIONS_PER_USER) return 'too-many-sessions-user';
  return null;
}
/** 현재 RDP 세션 수(상태 · 진단 · 시험). */
export function rdpSessionCounts() { return { active: _rdpActive, users: _rdpPerUser.size, max: MAX_SESSIONS, perUserCap: MAX_SESSIONS_PER_USER }; }
function takeRdpSlot(user) {
  const k = lcUser(user);
  _rdpActive += 1; _rdpPerUser.set(k, (_rdpPerUser.get(k) || 0) + 1);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    _rdpActive = Math.max(0, _rdpActive - 1);
    const n = (_rdpPerUser.get(k) || 1) - 1;
    if (n > 0) _rdpPerUser.set(k, n); else _rdpPerUser.delete(k);
  };
}
/** 시험 전용 — 세는 값을 비운다. */
export function _resetRdpSessionsForTest() { _rdpActive = 0; _rdpPerUser.clear(); }

/** 테스트 주입 — 운영에서는 실제 resolveTokenUser·getMapping 이다. */
const rdpDeps = { resolveTokenUser, getMapping, connect: (port, host) => net.connect(port, host), tlsConnect: (opts) => tls.connect(opts) };
const RDP_DEPS_DEFAULT = { ...rdpDeps };
export function _setRdpDepsForTest(o = null) { Object.assign(rdpDeps, o ? o : RDP_DEPS_DEFAULT); }

/**
 * 세션 연장 토큰을 RDP 연결에 넘기는 제어 명령(2026-10-09 S-04). 브라우저가 Guacamole 터널로
 * `tunnel.sendMessage('dvc-token', 새토큰)` 을 보내면 이 서버가 소비하고 guacd 로 넘기지 않는다.
 * 같은 계정·같은 세션의 유효한 토큰일 때만 바꾼다(sshGateway trackRemoteSession.refresh).
 */
export const RDP_TOKEN_OPCODE = 'dvc-token';
/** 브라우저 → guacd 입력 명령(key·mouse·touch) — 서버측 유휴 활동으로 센다. 한 메시지에 여러 명령이 올 수 있어 ';' 경계도 본다(선형). */
const RDP_INPUT_RE = /(?:^|;)(?:3\.key|5\.mouse|5\.touch),/;

// Encode a Guacamole instruction: each element is "<charLen>.<value>", comma
// separated, terminated by ';'.
function enc(...els) {
  return els.map((e) => { const s = String(e); return `${[...s].length}.${s}`; }).join(',') + ';';
}

// Parse one complete instruction starting at `start`; returns {opcode,args,end} or null.
function parseInstruction(str, start) {
  let i = start; const els = [];
  while (i < str.length) {
    const dot = str.indexOf('.', i);
    if (dot < 0) return null;
    // 49회차 F49-1(재현 — 높음): 길이 칸은 숫자만(1~10자리) — parseInt 는 '-4' 를 받아 i 가 뒤로 가 루프가 끝나지 않았다
    //   (브라우저 프레임 '9.dvc-token,-4.' 하나로 이벤트 루프 약 10초 정지 · 작은 힙이면 OOM). guacd 쪽 데이터도 같은 파서를 쓴다.
    const lenText = str.slice(i, dot);
    if (!/^\d{1,10}$/.test(lenText)) return null;
    const len = Number(lenText);
    const vEnd = dot + 1 + len;
    if (vEnd > str.length) return null;
    els.push(str.slice(dot + 1, vEnd));
    const sep = str[vEnd];
    if (sep === ';') return { opcode: els[0], args: els.slice(1), end: vEnd + 1 };
    if (sep === ',') { i = vEnd + 1; continue; }
    return null;
  }
  return null;
}

/*
 * 76회차 F1(재현 — 중간): guacd → 브라우저 중계는 **완전한 명령 단위**로 보낸다. 예전에는 guacd TCP 조각('data')을 받은 그대로 WS 메시지 하나로
 *   보냈는데, 브라우저의 guacamole-common-js 1.5.0 WebSocketTunnel 은 **메시지마다 따로** 파싱한다 — 명령 중간에서 잘린 메시지의 그 명령은
 *   버려지고, 다음 메시지 앞머리(잘린 나머지)는 길이를 못 읽어 그 메시지 전체가 버려졌다(실제 라이브러리로 재현: img 명령이 사라진다).
 *   TCP 조각 경계는 명령 경계와 무관하다(guacd 는 출력 버퍼가 차면 명령 중간에서도 내보낸다). Java 터널(GuacamoleWebSocketTunnelEndpoint)도
 *   완전한 명령만 보낸다. 바이트 → 글자는 StringDecoder 로 잇는다(조각 경계에서 잘린 UTF-8 글자가 깨지지 않게 — SSH 게이트웨이와 같은 방식).
 */
/** 한 명령이 이보다 길게 끝나지 않으면 스트림 이상으로 보고 닫는다(guacd 명령은 blob 조각 수 KB — 브라우저 → guacd 프레임 상한과 같은 값). */
export const GUAC_RELAY_MAX_PENDING = GUAC_WS_MAX_PAYLOAD;
const HIGH_SURROGATE_RE = /[\uD800-\uDBFF]/;

/**
 * str 앞에서부터 **완전한** Guacamole 명령들이 끝나는 위치 — 0 이면 아직 완전한 명령이 없다, -1 이면 형식이 깨졌다.
 * 길이 칸은 숫자 1~10자리(49회차 F49-1 과 같은 규칙), 값의 길이는 **유니코드 글자 수**다(guacd 는 UTF-8 글자로 센다 — 이 서버의 enc 와 같다).
 * 선형: 원소마다 길이만큼 건너뛴다(4바이트 글자가 있을 때만 글자를 센다). astral 을 넘기면 그 판정을 다시 하지 않는다.
 */
export function guacCompleteEnd(str, astral = HIGH_SURROGATE_RE.test(str)) {
  const n = str.length;
  let i = 0;
  let last = 0;
  while (i < n) {
    let j = i;
    let len = 0;
    while (j < n) {
      const c = str.charCodeAt(j);
      if (c < 48 || c > 57) break;
      len = len * 10 + (c - 48);
      j++;
      if (j - i > 10) return -1;
    }
    if (j >= n) return last;                       // 길이 칸이 아직 다 오지 않았다
    if (j === i || str.charCodeAt(j) !== 46) return -1;   // 숫자 없음 · '.' 아님
    let k = j + 1;
    if (!astral) k += len;
    else {
      for (let c = 0; c < len && k < n; c++) {
        const u = str.charCodeAt(k);
        k += (u >= 0xD800 && u <= 0xDBFF) ? 2 : 1;
      }
    }
    if (k >= n) return last;                       // 값 또는 구분자가 아직 다 오지 않았다
    const sep = str.charCodeAt(k);
    if (sep === 59) { last = k + 1; i = k + 1; continue; }   // ';' 명령 끝
    if (sep === 44) { i = k + 1; continue; }                 // ',' 다음 원소
    return -1;
  }
  return last;
}

/**
 * guacd 출력 → 브라우저 WS 중계기(76회차 F1). push(Buffer) 는 완전한 명령까지만 send 로 넘기고 나머지는 다음 조각과 잇는다.
 * 형식이 깨졌거나 한 명령이 상한을 넘으면 fail(사유) 를 한 번 부르고 더 보내지 않는다.
 */
export function makeGuacRelay(send, fail, { maxPending = GUAC_RELAY_MAX_PENDING } = {}) {
  const dec = new StringDecoder('utf8');
  let pending = '';
  let astral = false;
  let dead = false;
  const feed = (text) => {
    if (dead || !text) return;
    pending += text;
    astral = astral || HIGH_SURROGATE_RE.test(text);
    const end = guacCompleteEnd(pending, astral);
    if (end < 0) { dead = true; pending = ''; fail('guacd 출력 형식 오류'); return; }
    if (end > 0) {
      const out = end === pending.length ? pending : pending.slice(0, end);
      pending = end === pending.length ? '' : pending.slice(end);
      if (!pending) astral = false;
      send(out);
    }
    if (pending.length > maxPending) { dead = true; pending = ''; fail('guacd 명령이 너무 깁니다'); }
  };
  // decode 는 핸드셰이크 단계도 **같은 디코더**로 글자를 만들게 내준다(ready 직전 조각 끝의 잘린 글자를 잃지 않게).
  return { push: (buf) => feed(dec.write(buf)), decode: (buf) => dec.write(buf), text: feed, pendingLength: () => pending.length };
}

export function attachRdpGateway(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: GUAC_WS_MAX_PAYLOAD });
  server.on('upgrade', (req, socket, head) => {
    // ⚠ 보안(M-1): 잘못된 요청줄로 `new URL` 이 throw 하면 뒤 리스너(index.js catch-all)가 실행되지
    // 않아 소켓이 파기되지 않는다 — throw 대신 return(sshGateway 와 동일).
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return; }
    if (url.pathname !== '/api/remote/rdp') return;
    // 역할 검사(감사/SECURITY-AUDIT H3): RDP 터널 개통은 admin/operator만(viewer 차단).
    // ⚠ user 는 블록 '밖'에서 선언 — 아래 handleUpgrade 가 쓴다(sshGateway 와 동일 규칙·동일 결함).
    // 132회차: 세션 토큰은 주소에 싣지 않는다 — 1회용 WS 티켓(`wst=` · rdp-ticket 응답에 함께 온다)에서 꺼낸다. 옛 화면의 `token=` 은 이번 판까지만
    //   (판정은 SSH 와 같은 함수 — sshGateway.js remoteUpgradeAuth). RDP 자격증명 티켓(`ticket=`)은 예전 그대로 아래 handle 이 발급자 대조 뒤 소비한다.
    let token = null;
    let user = null;
    if (config.auth.enabled) {
      // resolveTokenUser = 서명/만료 + 토큰 폐기(tokenVersion) + 최신 역할 — HTTP와 동일 검증.
      ({ token, user } = remoteUpgradeAuth(url.searchParams, { resolveTokenUser: rdpDeps.resolveTokenUser }));
    } else {
      user = authDisabledRemoteUser(); // v2.770(점검 R5-E5-6): 인증 off 도 HTTP 와 같은 익명 역할로 같은 판정(예전 user=null → 전부 mapping-denied)
    }
    {
      // OTP 등록 전 세션·데모 계정·remote.access 없음 — WS 업그레이드는 requireEnrolled 미들웨어를 타지 않는다.
      // 판정은 SSH 게이트웨이·열린 연결 재검증과 같은 함수다(S-04).
      const deny = remoteUserIssue(user);
      if (deny) { socket.write(`HTTP/1.1 ${deny.status} ${deny.status === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`); return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, (ws) => handle(ws, url.searchParams, user, token));
  });
}

function handle(ws, params, user, token = null) {
  const m = rdpDeps.getMapping(params.get('mappingId'));
  if (!m || m.protocol !== 'rdp') { safeWsClose(ws, 1011, 'rdp mapping not found'); return; }
  // v2.322: 소유·scope 재검사(SSH 게이트웨이와 동일 — 범위 밖/타인 매핑 차단).
  const issue = mappingAccessIssue(user, m);
  // v2.731(A5-02·A1-03): SSH 게이트웨이와 같은 사유 코드 — 브라우저 Guacamole 터널은 닫힘 사유를 상태 메시지로 넘기고 화면이 그것으로 문구를 고른다.
  if (issue) { safeWsClose(ws, 1011, 'mapping-denied'); return; }
  // 76회차 F3: 매핑의 중계가 지워졌으면 열지 않는다 — 기본 프록시 + 같은 공개 포트는 다른 매핑의 대상이다(티켓 자격증명을 보내기 전 · 소비하기 전에 닫는다).
  const proxy = mappingProxyOf(m);
  if (!proxy) { safeWsClose(ws, 1011, 'mapping-proxy-gone'); return; }
  // 79회차: 동시 세션 상한(전체 · 계정당 — SSH 와 같은 값) — 티켓을 소비하기 전에 닫는다(사용자가 티켓을 다시 받지 않아도 되게).
  { const cap = rdpSessionCapIssue(user); if (cap) { safeWsClose(ws, 4429, cap); return; } }
  touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
  if (!proxy.guacd?.host) { safeWsClose(ws, 1011, 'guacd not configured'); return; }

  const host = proxy.proxyHost || m.targetHost;
  const port = proxy.proxyHost ? m.publicPort : m.targetPort;
  // 자격증명은 **1회용 티켓(consumeRdpTicket)에서만** 조회한다(감사 H18·CLAUDE.md 'RDP 자격증명은
  // 티켓으로'). 쿼리스트링 폴백을 제거해 fail-closed — 비번이 URL 로 상위 프록시 로그·브라우저
  // 히스토리에 남는 경로를 봉인한다. 티켓이 없으면 접속을 거부(클라이언트가 티켓 발급을 재시도).
  const tk = consumeRdpTicket(params.get('ticket'), { user: user?.username || '' });   // 19회차 A-11: 발급자만
  // ⚠ WS close 사유는 UTF-8 123바이트 상한 — 예전 한글 문구(약 140바이트)는 ws.close 가 RangeError 를 던져
  //   연결이 닫히지 않은 채 남았다. safeWsClose 가 글자 경계에서 자른다(2026-10-09 S-04 작업 중 확인).
  if (!tk) { safeWsClose(ws, 1011, 'RDP 접속 티켓이 필요합니다(POST /api/remote/rdp-ticket)'); return; }
  const releaseSlot = takeRdpSlot(user);   // 79회차: 여기부터 센다(아래 close · error 셋이 한 번 푼다)
  const cred = (k) => (tk[k] != null ? String(tk[k]) : '');
  const settings = {
    hostname: host, port: String(port),
    username: cred('username'), password: cred('password'), domain: cred('domain'),
    // width/height 는 비민감 렌더 파라미터라 쿼리에서 받는다(자격증명 아님). 48회차: 정수 · 범위만(guacd 인자로 그대로 간다).
    width: rdpDim(params.get('width'), '1024'), height: rdpDim(params.get('height'), '768'), dpi: '96',
    // 48회차 F2(사용자 결정): RDP 대상 인증서 검증은 프록시 설정(guacd.verifyRdpCert)으로 — 기본은 예전처럼 끔.
    security: cred('security') || 'any', 'ignore-cert': rdpIgnoreCertArg(proxy.guacd), 'resize-method': 'display-update',
  };

  // 48회차 F2(사용자 결정): guacd.tls 면 TLS(인증서 검증 — 이 구간 connect 명령에 RDP 비밀번호가 실린다), 아니면 예전처럼 평문 TCP.
  const { socket: guacd, readyEvent } = openGuacdSocket(proxy.guacd, { netConnect: (p, h) => rdpDeps.connect(p, h), tlsConnect: (o) => rdpDeps.tlsConnect(o) });
  let closed = false;
  // 원격 세션 레지스트리(S-04): 계정 삭제·강등·비밀번호 변경·sid 교체·토큰 만료·범위 축소·매핑 삭제면
  //   **guacd 소켓을 먼저 끊어** 키보드·마우스 입력이 RDP 대상에 닿지 않게 하고 WS 를 닫는다.
  const session = trackRemoteSession({
    kind: 'rdp', token, user,
    close: (iss) => { closed = true; try { guacd.destroy(); } catch { /* */ } safeWsClose(ws, iss.status === 401 ? 4401 : 4403, iss.code); },
  });
  session.setMapping(m.id, { host: m.targetHost, port: m.targetPort });
  // guacd 호스트가 방화벽/미도달이면 SYN_SENT로 OS 타임아웃(~2분)까지 ws가 열린 채 쌓인다 →
  // 연결 타임아웃을 명시(핸드셰이크 완료 전만; ready 후에는 정상 유휴 대비 해제).
  guacd.setTimeout(20_000, () => { if (!ready) { safeWsClose(ws, 1011, 'guacd 연결 타임아웃'); try { guacd.destroy(); } catch { /* */ } } });
  let ready = false;
  let buf = '';
  const MAX_HANDSHAKE_BUF = 256 * 1024; // 핸드셰이크 중 파싱 불가 데이터가 무한 누적되는 것 차단
  // 76회차 F1: ready 뒤 guacd 출력은 완전한 명령 단위로만 브라우저에 보낸다(위 makeGuacRelay).
  const relay = makeGuacRelay(
    (text) => { if (ws.readyState === ws.OPEN) ws.send(text); },
    (why) => { closed = true; try { guacd.destroy(); } catch { /* */ } safeWsClose(ws, 1011, why); },
  );

  guacd.on(readyEvent, () => guacd.write(enc('select', 'rdp')));   // TLS 면 'secureConnect'(검증 통과 뒤) — 검증 실패는 'error' 로 닫힌다

  guacd.on('data', (data) => {
    if (ready) { relay.push(data); return; }
    buf += relay.decode(data);
    let inst;
    while ((inst = parseInstruction(buf, 0))) {
      if (inst.opcode === 'args') {
        const names = inst.args; // [version, name1, name2, ...]
        guacd.write(enc('size', settings.width, settings.height, settings.dpi));
        guacd.write(enc('audio'));
        guacd.write(enc('video'));
        guacd.write(enc('image'));
        const values = names.map((n, i) => (i === 0 ? n : (settings[n] ?? ''))); // echo version at index 0
        guacd.write(enc('connect', ...values));
        buf = buf.slice(inst.end);
      } else if (inst.opcode === 'ready') {
        ready = true;
        guacd.setTimeout(0); // 핸드셰이크 완료 — 연결 타임아웃 해제(정상 세션은 오래 유휴 가능)
        // forward 'ready' + anything buffered after it to the browser client — 76회차 F1: 뒤에 붙은 잘린 명령은 다음 조각과 이어 보낸다
        const rest = buf;
        buf = '';
        relay.text(rest);
        break;
      } else if (inst.opcode === 'error') {
        // guacd가 핸드셰이크 중 error를 보내면(연결 실패 등) 조용히 무시하면 ws가 영영 hang한다.
        // 브라우저에 알리고 종료한다.
        safeWsClose(ws, 1011, `guacd: ${(inst.args && inst.args[0]) || 'error'}`);
        try { guacd.destroy(); } catch { /* */ }
        return;
      } else {
        buf = buf.slice(inst.end); // ignore other handshake instructions
      }
    }
    // 파싱 가능한 명령이 없는데 버퍼가 상한을 넘으면(오작동/오염 스트림) 무한 증식 차단.
    if (!ready && buf.length > MAX_HANDSHAKE_BUF) {
      safeWsClose(ws, 1011, 'guacd 핸드셰이크 오류(버퍼 초과)');
      try { guacd.destroy(); } catch { /* */ }
    }
  });

  guacd.on('error', (err) => { safeWsClose(ws, 1011, `guacd: ${err.message}`); });
  guacd.on('close', () => { releaseSlot(); session.release(); try { ws.close(); } catch { /* */ } });

  ws.on('message', (msg) => {
    if (closed) return; // 폐기 뒤 도착한 입력은 대상에 보내지 않는다(S-04)
    const text = msg.toString();
    // 세션 연장 토큰(브라우저가 보내는 제어 명령) — guacd 로 넘기지 않고 여기서 소비한다.
    if (text.startsWith(`${RDP_TOKEN_OPCODE.length}.${RDP_TOKEN_OPCODE},`)) {
      const inst = parseInstruction(text, 0);
      if (inst && inst.opcode === RDP_TOKEN_OPCODE && inst.end === text.length) {
        session.refresh(String(inst.args[0] || ''));
        return;
      }
    }
    // 48회차 F1(재현 — 높음): 포탈이 guacd 와 핸드셰이크(select rdp → args → connect → ready)를 끝내기 **전** 의 브라우저 프레임은 버린다.
    //   예전에는 그대로 guacd 로 써서, 범위 계정이 자기 rdp 매핑 · 티켓으로 연 WS 에 'select ssh' + 'connect <임의 호스트:포트>' 를 먼저 보내면
    //   guacd 가 그것을 첫 select · connect 로 받아 매핑 대상 · targetHostScope · 프로토콜 · 프록시 경로를 모두 건너뛰었다.
    //   정상 클라이언트는 ready 를 받기 전에 세션 명령을 보내지 않는다(그 전 키 · 마우스 입력은 버려도 무해 — 연결 전이다).
    if (!ready) return;
    // 키·마우스·터치 입력 = 사용자 활동(서버측 유휴 — 그룹 F). 연결마다 1분 1회로 묶는다(touch 가 거른다).
    if (RDP_INPUT_RE.test(text)) session.touch();
    try { guacd.write(text); } catch { /* */ }
  });
  ws.on('close', () => { closed = true; releaseSlot(); session.release(); try { guacd.end(); } catch { /* */ } });
  ws.on('error', () => { closed = true; releaseSlot(); session.release(); try { guacd.destroy(); } catch { /* */ } }); // ws 오류에도 소켓 정리
  return { session, isClosed: () => closed };
}

/** 48회차: RDP 화면 크기 — 정수만(아니면 기본값) · 49회차 F49-3: 범위 밖은 100~8192 로 자른다(8192 를 넘는 창이 기본 1024 로 떨어져 비율이 깨졌다). */
export function rdpDim(v, dflt) {
  const s = String(v ?? '').trim();
  if (!/^\d{1,6}$/.test(s)) return dflt;
  return String(Math.min(8192, Math.max(100, Number(s))));
}
/** 시험 전용 — Guacamole 명령 파서(49회차 F49-1). */
export const _parseInstructionForTest = parseInstruction;

/** 테스트 전용 — 실제 RDP 연결 처리기(가짜 ws·가짜 guacd 소켓으로 폐기를 재현한다). */
export const _rdpHandleForTest = handle;
