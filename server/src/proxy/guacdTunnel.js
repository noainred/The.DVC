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
import { WebSocketServer } from 'ws';
/*
 * v2.631(AX3-01): 프레임 상한. ws 기본 maxPayload 는 100MiB 라 인증된 operator(remote.access 기본 보유)가 프레임당 100MB 를 보내
 *   문자열화·파싱(동시 세션 × 100MB)으로 이벤트 루프·힙을 누를 수 있었다. 넘는 프레임은 ws 가 1009 로 닫는다.
 *   guacd 릴레이(클립보드·파일 조각 포함)에 필요한 폭.
 */
export const GUAC_WS_MAX_PAYLOAD = 4 * 1024 * 1024;
import { resolveTokenUser } from '../auth/auth.js';
import { getMapping, getProxyById, touchMapping } from './registry.js';
import { consumeRdpTicket } from './rdpTicket.js';
import { config } from '../config.js';
// WS 매핑 소유·scope 재검사 공용(v2.322) + 사용자 판정·열린 세션 재검증 공용(2026-10-09 S-04 — SSH 게이트웨이와 **같은 함수**).
//   remoteUserIssue = 토큰 무효는 401, OTP 등록 전 세션·데모 계정·원격 접속 권한 없음은 403(판정 본문은 sshGateway.js 에 하나만 둔다).
import { mappingAccessIssue, remoteUserIssue, trackRemoteSession, safeWsClose } from './sshGateway.js';

/** 테스트 주입 — 운영에서는 실제 resolveTokenUser·getMapping 이다. */
const rdpDeps = { resolveTokenUser, getMapping, connect: (port, host) => net.connect(port, host) };
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
    const len = parseInt(str.slice(i, dot), 10);
    if (Number.isNaN(len)) return null;
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
    const token = config.auth.enabled ? url.searchParams.get('token') : null;
    let user = null;
    if (config.auth.enabled) {
      // resolveTokenUser = 서명/만료 + 토큰 폐기(tokenVersion) + 최신 역할 — HTTP와 동일 검증.
      user = rdpDeps.resolveTokenUser(token);
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
  if (issue) { safeWsClose(ws, 1011, 'forbidden'); return; }
  touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
  const proxy = getProxyById(m.proxyId);
  if (!proxy.guacd?.host) { safeWsClose(ws, 1011, 'guacd not configured'); return; }

  const host = proxy.proxyHost || m.targetHost;
  const port = proxy.proxyHost ? m.publicPort : m.targetPort;
  // 자격증명은 **1회용 티켓(consumeRdpTicket)에서만** 조회한다(감사 H18·CLAUDE.md 'RDP 자격증명은
  // 티켓으로'). 쿼리스트링 폴백을 제거해 fail-closed — 비번이 URL 로 상위 프록시 로그·브라우저
  // 히스토리에 남는 경로를 봉인한다. 티켓이 없으면 접속을 거부(클라이언트가 티켓 발급을 재시도).
  const tk = consumeRdpTicket(params.get('ticket'));
  // ⚠ WS close 사유는 UTF-8 123바이트 상한 — 예전 한글 문구(약 140바이트)는 ws.close 가 RangeError 를 던져
  //   연결이 닫히지 않은 채 남았다. safeWsClose 가 글자 경계에서 자른다(2026-10-09 S-04 작업 중 확인).
  if (!tk) { safeWsClose(ws, 1011, 'RDP 접속 티켓이 필요합니다(POST /api/remote/rdp-ticket)'); return; }
  const cred = (k) => (tk[k] != null ? String(tk[k]) : '');
  const settings = {
    hostname: host, port: String(port),
    username: cred('username'), password: cred('password'), domain: cred('domain'),
    // width/height 는 비민감 렌더 파라미터라 쿼리에서 받는다(자격증명 아님).
    width: params.get('width') || '1024', height: params.get('height') || '768', dpi: '96',
    security: cred('security') || 'any', 'ignore-cert': 'true', 'resize-method': 'display-update',
  };

  const guacd = rdpDeps.connect(proxy.guacd.port || 4822, proxy.guacd.host);
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

  guacd.on('connect', () => guacd.write(enc('select', 'rdp')));

  guacd.on('data', (data) => {
    if (ready) { if (ws.readyState === ws.OPEN) ws.send(data.toString('utf8')); return; }
    buf += data.toString('utf8');
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
        // forward 'ready' + anything buffered after it to the browser client
        if (ws.readyState === ws.OPEN) ws.send(buf);
        buf = '';
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
  guacd.on('close', () => { session.release(); try { ws.close(); } catch { /* */ } });

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
    // 키·마우스·터치 입력 = 사용자 활동(서버측 유휴 — 그룹 F). 연결마다 1분 1회로 묶는다(touch 가 거른다).
    if (RDP_INPUT_RE.test(text)) session.touch();
    try { guacd.write(text); } catch { /* */ }
  });
  ws.on('close', () => { closed = true; session.release(); try { guacd.end(); } catch { /* */ } });
  ws.on('error', () => { closed = true; session.release(); try { guacd.destroy(); } catch { /* */ } }); // ws 오류에도 소켓 정리
  return { session, isClosed: () => closed };
}

/** 테스트 전용 — 실제 RDP 연결 처리기(가짜 ws·가짜 guacd 소켓으로 폐기를 재현한다). */
export const _rdpHandleForTest = handle;
