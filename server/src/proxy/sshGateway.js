/**
 * Browser SSH console gateway. A WebSocket at /api/remote/ssh bridges an
 * xterm.js terminal in the browser to an ssh2 connection that dials the target
 * THROUGH the proxy (proxyHost:publicPort of the mapping), since the portal can
 * only reach targets via the global proxy.
 *
 * Protocol (text frames, JSON for control):
 *   client → {type:'auth', mappingId, username, password}
 *   client → {type:'data', data}         keystrokes
 *   client → {type:'resize', cols, rows}
 *   client → {type:'token', token}       (2026-10-09 S-04) 세션 연장으로 받은 새 토큰 — 같은 계정·같은 세션일 때만 바꾼다
 *   server → {type:'status', text} | raw stdout chunks (binary/text)
 *
 * ── 2026-10-09 검토 반영(그룹 H) ──────────────────────────────────────────────────────────────
 *  S-01  대상 SSH 서버의 **호스트키를 확인**한다 — `sshExec.makeSshHostVerifier`(수집기와 같은 관문). 대상이 프록시를 거쳐도
 *        키는 대상 서버의 것이므로 신뢰 키는 **대상(targetHost:targetPort)** 이다(공개 포트는 매핑마다 재사용될 수 있다).
 *  S-04  열린 연결도 계속 확인한다 — 아래 '원격 세션 레지스트리'(trackRemoteSession). 업그레이드·auth 프레임·주기 재검증·
 *        토큰 갱신이 **같은 판정**(`remoteUserIssue` + `mappingAccessIssue`)을 쓴다. 폐기 이벤트(auth/sessionRevocation.js)는
 *        즉시 닫고, 토큰 만료 시각에 타이머로 닫고, 이벤트로 오지 않는 변경(역할·범위·tokenVersion·sid 교체)은 주기 재검증이 잡는다.
 *  I-07  출력 백프레셔 — 브라우저가 느리면 SSH 채널을 멈추고(stream.pause → SSH 창 흐름 제어) 따라잡으면 다시 푼다.
 *        대기열 상한·전송 대기 시한을 넘기면 **사유를 말하고** 닫는다(조용히 버리지 않는다).
 */

import { WebSocketServer } from 'ws';
import { StringDecoder } from 'node:string_decoder';
/*
 * v2.631(AX3-01): 프레임 상한. ws 기본 maxPayload 는 100MiB 라 인증된 operator(remote.access 기본 보유)가 프레임당 100MB 를 보내
 *   문자열화·파싱(동시 세션 × 100MB)으로 이벤트 루프·힙을 누를 수 있었다. 넘는 프레임은 ws 가 1009 로 닫는다.
 *   SSH 제어 프레임(auth·resize JSON)은 작다. data 는 붙여넣기 전량이 올 수 있어 웹(web/src/remote/sshSend.js)이 32,768자 조각으로
 *   나눠 보낸다(v2.632 AX1-2632-07 — 예전 주석의 '수백 KB 까지 여유' 는 사실이 아니었다: 256KB 를 넘는 붙여넣기 한 번이 1009 로
 *   세션을 끊었다). 이 값을 줄이면 sshSend.js 의 조각 크기(최악 6배 확장)도 다시 계산할 것 — audit2632e 가 두 값을 대조한다.
 */
export const SSH_WS_MAX_PAYLOAD = 256 * 1024;
import { Client as SSHClient } from 'ssh2';
import { resolveTokenUser, sessionInfoOf, touchSessionActivity } from '../auth/auth.js';
import { userHasPermission } from '../auth/permissions.js';
import { getMapping, getProxyById, touchMapping } from './registry.js';
import { scopedVcenterIds } from '../auth/scope.js';
import { store } from '../store.js';
import { targetHostScopeIssue } from './targetHostScope.js'; // v2.579: 도메인은 routes 를 import 하지 않는다(ARCH-05)
import { reqTimeoutMs } from '../agent/envTimeout.js';
import { makeSshHostVerifier, sshHostKeyError } from './sshExec.js';
import { onSessionRevoked, revocationMatches } from '../auth/sessionRevocation.js';
import { numOrNull } from '../util/numOrNull.js';
// v2.606 TIM2606-04: sshExec.js 와 **같은 env 를 같은 함수로** 해석한다 — 예전 'Number(env) || 60000' 은 2^31 초과를
//   통과시켜 ssh2 readyTimeout 이 setTimeout 1ms 가 되고 모든 웹 터미널이 배너 직후 'handshake 시한 초과' 로 끊겼다.
export const SSH_GATEWAY_READY_TIMEOUT_MS = reqTimeoutMs(process.env.SSH_READY_TIMEOUT_MS, 60_000);
import { config, clampIntervalMs, MAX_TIMER_MS } from '../config.js';

/**
 * 원격(SSH·RDP) WS 사용자 판정 — **업그레이드·auth 프레임·주기 재검증·토큰 갱신이 같은 함수를 쓴다**(S-04).
 * 판정을 곳곳에 복제하면 한쪽만 바뀌어 '열 때는 막는데 열린 뒤에는 통과' 가 된다.
 *   · 토큰 무효(서명·만료·tokenVersion·삭제·sid 교체 — resolveTokenUser 가 판정) → 401
 *   · OTP 등록 전 세션 / 데모 계정 → 403 (WS 업그레이드는 requireEnrolled·demoGuest 미들웨어를 타지 않는다)
 *   · 기능 권한 'remote.access' 없음(admin 은 항상 통과) → 403
 * @returns {null | {status:401|403, code:string, text:string}}
 */
export function remoteUserIssue(user) {
  if (!user) return { status: 401, code: 'session-invalid', text: '로그인 세션이 더 이상 유효하지 않습니다(만료·로그아웃·계정 변경·다른 곳에서 다시 로그인)' };
  // OTP 등록 전 세션(부트스트랩 비밀번호 로그인)은 등록 외 아무 것도 할 수 없다 — HTTP는 requireEnrolled 가 막지만
  // WS 업그레이드는 그 미들웨어를 타지 않으므로 여기서 직접 막는다(누락 시 미등록 관리자가 내부 서버로 SSH 터널을 개통할 수 있었다).
  if (user.mustEnrollOtp || user.demoGuest) {
    return user.demoGuest
      ? { status: 403, code: 'demo-guest', text: '데모 계정은 원격 접속을 쓸 수 없습니다' }
      : { status: 403, code: 'otp-enroll', text: 'OTP 등록을 마쳐야 원격 접속을 쓸 수 있습니다' };
  }
  // 기능 권한 매트릭스로 검사 — admin 은 항상 통과, 그 외는 'remote.access' 보유 시만.
  if (!userHasPermission(user, 'remote.access')) return { status: 403, code: 'no-remote-access', text: '원격 접속 권한(remote.access)이 없습니다' };
  return null;
}

const HTTP_REASON = { 401: 'Unauthorized', 403: 'Forbidden' };
// 업그레이드 때 받은 토큰 — 열린 연결의 재검증·만료 타이머가 쓴다(S-04). ws 객체가 사라지면 함께 사라진다.
const _wsToken = new WeakMap();

export function attachSshGateway(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: SSH_WS_MAX_PAYLOAD });

  server.on('upgrade', (req, socket, head) => {
    // ⚠ 보안(M-1, 2026-09-12): 잘못된 요청줄(예: `GET //[`)은 `new URL` 이 throw 하는데, upgrade
    // 리스너에서 throw 하면 EventEmitter 가 **나머지 리스너를 호출하지 않아** index.js 의 catch-all
    // 소켓 파기가 건너뛰어져 무인증 FD 누수가 됐다(2026-08-17 #7 회귀). throw 대신 return 하면
    // 뒤의 catch-all 이 정상적으로 소켓을 파기한다.
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return; }
    if (url.pathname !== '/api/remote/ssh') return; // let other upgrade handlers run
    // Auth via token query param (browsers can't set WS headers).
    // 역할 검사(감사/SECURITY-AUDIT H3): 원격 SSH 터널 개통은 admin/operator만 — viewer 토큰으로
    // 내부 서버 SSH 접속이 열리던 문제 차단. (operator 역할의 실효 권한이기도 하다.)
    // ⚠ user 는 반드시 블록 '밖'에서 선언한다 — 아래 handleUpgrade 가 이 값을 쓰므로 if 안에서
    // const 로 선언하면 그 줄에서 ReferenceError 가 난다. 터지는 경우는 'handleUpgrade 에 도달하는
    // 모든 경로' = 인증 off + 인증 on 이면서 검사를 전부 통과한 **정상 세션** — 즉 권한 있는
    // 사용자의 원격 접속이 전부 실패한다(거부 경로는 그 전에 return 하므로 영향 없음).
    // 회귀 테스트: test/securityFix2026-09-01.test.js.
    const token = config.auth.enabled ? url.searchParams.get('token') : null;
    let user = null;
    if (config.auth.enabled) {
      // resolveTokenUser = 서명/만료 + 토큰 폐기(tokenVersion) + 최신 역할 — HTTP와 동일 검증.
      // (payload.role 직접 신뢰 금지: 강등/삭제된 계정의 구토큰이 TTL까지 터널을 열 수 있었다.)
      user = remoteDeps.resolveTokenUser(token);
      const deny = remoteUserIssue(user); // OTP 등록 전·데모·remote.access — 열린 뒤 재검증과 같은 함수(S-04)
      if (deny) { socket.write(`HTTP/1.1 ${deny.status} ${HTTP_REASON[deny.status]}\r\n\r\n`); return socket.destroy(); }
    }
    wss.handleUpgrade(req, socket, head, (ws) => { _wsToken.set(ws, token); handleConnection(ws, user); });
  });
}

/**
 * WS 게이트웨이의 매핑 접근 재검사(v2.322 보안 감사) — WS 는 HTTP 미들웨어를 안 타므로
 * probe/quick-connect(v2.320 scope 적용) 이후에도 여기서 소유·scope 를 다시 본다.
 * admin 은 전부, 그 외에는 자기 소유(소유자 없는 매핑은 admin 전용 — v2.313 DELETE 규칙)이고
 * targetHost 가 사용자 scope 안이어야 한다. 위반 사유(사용자 표시용) 또는 null(허용).
 */
export function mappingAccessIssue(user, m) {
  if (!user || !m) return '매핑을 찾을 수 없습니다.';
  if (user.role !== 'admin') {
    if (m.owner !== user.username) return '이 접속 매핑에 대한 권한이 없습니다.'; // 소유자 없는 매핑도 admin 전용
    const scopeIssue = targetHostScopeIssue(store.get(), scopedVcenterIds(user, store.get()), m.targetHost);
    if (scopeIssue) return scopeIssue;
    return null;
  }
  // v2.606 AUTHZ2606-03: admin 의 면제(소유 무관)는 문서화된 설계라 유지하되, **범위 제한 admin**
  //   (scopedVcenterIds 가 Set)에는 대상 범위를 본다 — quick-connect 가 403 인 범위 밖 VM 에 WS 로 붙지 못하게.
  //   전체 범위 admin(null)은 예전 그대로 허용.
  const allowed = scopedVcenterIds(user, store.get());
  if (allowed) {
    const scopeIssue = targetHostScopeIssue(store.get(), allowed, m.targetHost);
    if (scopeIssue) return scopeIssue;
  }
  return null;
}

/* ══════════════════════ 원격 세션 레지스트리(S-04) — SSH·RDP 공용 ══════════════════════
 *
 * 연결마다 { 계정·sid·인증 출처·토큰·만료 시각·매핑·닫기 함수 } 를 들고 있다가
 *   ① 폐기 이벤트(로그아웃·계정 변경·AD 비활성화 — auth/sessionRevocation.js)가 오면 그 연결만 즉시 닫고
 *   ② 토큰 만료 시각에 타이머로 다시 판정하고
 *   ③ REMOTE_REVALIDATE_MS(기본 30초)마다 resolveTokenUser 를 다시 불러 역할·권한·OTP·tokenVersion·sid·매핑 소유·범위를 본다.
 * 타이머·구독은 **연결이 하나라도 있을 때만** 살아 있다(마지막 연결이 끝나면 해제 — 누수 없음, 테스트 고정).
 * 인증이 꺼진 설치(AUTH_ENABLED=false)는 토큰 개념이 없어 추적하지 않는다(그때도 기존 동작과 같다).
 */
export const REMOTE_REVALIDATE_MS = clampIntervalMs(numOrNull(process.env.REMOTE_REVALIDATE_MS) ?? 30_000, 30_000, 5_000);

/**
 * 테스트 주입 지점 — 운영에서는 실제 auth·registry 함수다.
 *  · resolveTokenUser — 권한 판정(업그레이드·재검증·auth 프레임이 같은 함수 — 로그아웃·유휴·총 상한·AD 정책 포함, 그룹 F)
 *  · sessionInfoOf — 레지스트리 키(계정·sid·출처)와 만료 타이머(exp)용. **권한 판정에 쓰지 않는다**
 *  · touchSessionActivity — 콘솔 입력을 서버측 유휴의 활동으로 기록(터미널·RDP 만 쓰는 사용자가 유휴로 끊기지 않게)
 */
const remoteDeps = { resolveTokenUser, sessionInfoOf, touchSessionActivity, getMapping, now: () => Date.now() };
const REMOTE_DEPS_DEFAULT = { ...remoteDeps };
export function _setRemoteDepsForTest(o = null) { Object.assign(remoteDeps, o ? o : REMOTE_DEPS_DEFAULT); }

const _live = new Map();       // id → entry
const _closedBy = new Map();   // code → 닫은 횟수(상태 화면·진단용)
let _seq = 0;
let _revalTimer = null;
let _unsubRevoke = null;

const lc = (s) => String(s ?? '').toLowerCase();

/** 토큰의 세션 정보(계정·sid·출처·exp) — 서명 검증만 한 값이다(권한 판정은 resolveTokenUser). 못 읽으면 null. */
function infoOf(token) {
  try { return token ? remoteDeps.sessionInfoOf(token) : null; } catch { return null; }
}

function setEntryToken(e, token, user) {
  const p = infoOf(token) || {};
  e.token = token;
  e.username = user?.username || p.username || e.username || '';
  e.sid = p.sid || null;
  e.source = p.source === 'local' ? 'local' : 'ad';
  e.exp = Number.isFinite(Number(p.exp)) && Number(p.exp) > 0 ? Number(p.exp) * 1000 : null;
  e.touchedAt = 0;
  armExpiry(e);
}

/** 콘솔 입력 → 서버측 유휴 활동(그룹 F touchSessionActivity). 연결마다 1분에 1회만 부른다(마우스 이동마다 HMAC 검증을 하지 않게). */
export const REMOTE_TOUCH_MS = 60_000;
function touchEntry(e) {
  if (e.closed || !e.token) return false;
  const now = remoteDeps.now();
  if (e.touchedAt && now - e.touchedAt < REMOTE_TOUCH_MS) return false;
  e.touchedAt = now;
  try { return !!remoteDeps.touchSessionActivity(e.token, { minIntervalMs: REMOTE_TOUCH_MS }); } catch { return false; }
}

function armExpiry(e) {
  clearTimeout(e.expTimer);
  e.expTimer = null;
  if (!e.exp || e.closed) return;
  // 만료 직후(+50ms)에 다시 판정한다 — resolveTokenUser 가 만료 토큰을 null 로 준다. 2^31 넘는 지연은 끊어서 다시 건다.
  const delay = Math.min(MAX_TIMER_MS, Math.max(0, e.exp - remoteDeps.now()) + 50);
  e.expTimer = setTimeout(() => { e.expTimer = null; checkRemoteEntry(e, 'expiry'); if (!e.closed && e.exp) armExpiry(e); }, delay);
  e.expTimer.unref?.();
}

/** 열린 연결 하나의 지금 상태 — 업그레이드 때와 같은 판정 + 매핑 소유·범위·대상 불변. */
function remoteEntryIssue(e) {
  const user = remoteDeps.resolveTokenUser(e.token);
  const ui = remoteUserIssue(user);
  if (ui) return ui;
  if (e.username && lc(user.username) !== lc(e.username)) return { status: 401, code: 'session-invalid', text: '세션의 계정이 바뀌었습니다' };
  if (e.mappingId) {
    const m = remoteDeps.getMapping(e.mappingId);
    if (!m || m.protocol !== e.kind) return { status: 403, code: 'mapping-gone', text: '접속 매핑이 삭제되었거나 바뀌었습니다' };
    if (e.target && (String(m.targetHost) !== e.target.host || Number(m.targetPort) !== e.target.port)) {
      return { status: 403, code: 'mapping-changed', text: '접속 매핑의 대상이 바뀌었습니다' };
    }
    const mi = mappingAccessIssue(user, m);
    if (mi) return { status: 403, code: 'mapping-denied', text: mi };
  }
  return null;
}

function closeRemoteEntry(e, issue) {
  if (e.closed) return;
  e.closed = true;
  releaseEntry(e);
  _closedBy.set(issue.code, (_closedBy.get(issue.code) || 0) + 1);
  console.warn(`[remote] ${e.kind} 세션 종료 — ${e.username || '(계정 미상)'}: ${issue.text} (${issue.code})`);
  try { e.close(issue); } catch (err) { console.warn(`[remote] 닫기 실패: ${err?.message || err}`); }
}

function checkRemoteEntry(e, why = 'revalidate') {
  if (e.closed) return null;
  let issue;
  try { issue = remoteEntryIssue(e); }
  catch (err) { issue = { status: 403, code: 'revalidate-error', text: `권한을 다시 확인하지 못했습니다(${String(err?.message || err).slice(0, 80)})` }; }
  if (issue) closeRemoteEntry(e, { ...issue, why });
  return issue;
}

/** 주기 재검증 한 번(테스트·진단용으로 내보낸다). 닫은 연결 수를 돌려준다. */
export function revalidateRemoteSessions() {
  let n = 0;
  for (const e of [..._live.values()]) if (checkRemoteEntry(e)) n++;
  return n;
}

function onRevoked(evt) {
  for (const e of [..._live.values()]) {
    if (!revocationMatches(evt, { username: e.username, sid: e.sid, source: e.source })) continue;
    const why = String(evt?.reason || '').slice(0, 80);
    closeRemoteEntry(e, { status: 401, code: 'revoked', text: `로그인 세션이 폐기되었습니다${why ? `(${why})` : ''}` });
  }
}

function ensureWatchers() {
  if (!_unsubRevoke) _unsubRevoke = onSessionRevoked(onRevoked);
  if (!_revalTimer) {
    _revalTimer = setInterval(revalidateRemoteSessions, REMOTE_REVALIDATE_MS);
    _revalTimer.unref?.();
  }
}

function releaseEntry(e) {
  clearTimeout(e.expTimer);
  e.expTimer = null;
  _live.delete(e.id);
  if (_live.size === 0) {
    if (_revalTimer) { clearInterval(_revalTimer); _revalTimer = null; }
    if (_unsubRevoke) { _unsubRevoke(); _unsubRevoke = null; }
  }
}

const NOOP_HANDLE = Object.freeze({
  id: null, setMapping() {}, refresh() { return { ok: false, code: 'auth-disabled' }; }, release() {}, check() { return null; }, currentUser() { return null; }, touch() { return false; },
});

/**
 * 연결 하나를 레지스트리에 올린다. close(issue) 는 그 연결을 실제로 끊는 함수(입력 전달 중지 + 원격 세션 종료 + WS 닫기).
 * @returns 핸들 — setMapping(id, target) · refresh(newToken) · check() · release() · currentUser() · touch()
 */
export function trackRemoteSession({ kind, token, user, close }) {
  if (!config.auth.enabled) return NOOP_HANDLE;
  const e = { id: ++_seq, kind, close, closed: false, mappingId: null, target: null, expTimer: null, openedAt: remoteDeps.now() };
  setEntryToken(e, token, user);
  _live.set(e.id, e);
  ensureWatchers();
  return {
    id: e.id,
    setMapping(mappingId, target) {
      e.mappingId = mappingId || null;
      e.target = target ? { host: String(target.host), port: Number(target.port) } : null;
    },
    /** 지금 권한으로 다시 판정(auth 프레임처럼 '이 시점의 권한' 이 필요할 때). 문제면 닫고 issue 를 돌려준다. */
    check() { return checkRemoteEntry(e, 'check'); },
    currentUser() { return e.closed ? null : remoteDeps.resolveTokenUser(e.token); },
    /** 사용자 입력(키·마우스)이 있었다 — 서버측 유휴 기준 시각을 민다(연결마다 1분 1회). 권한을 넓히지 않는다(폐기·만료된 세션은 F 가 기록하지 않는다). */
    touch() { return touchEntry(e); },
    /**
     * 세션 연장으로 받은 새 토큰으로 바꾼다 — 같은 계정·(단일 세션이면) 같은 sid·지금 권한 통과일 때만.
     * 거부해도 연결은 닫지 않는다(지금 토큰이 아직 유효할 수 있다 — 만료·재검증이 판단한다).
     */
    refresh(newToken) {
      if (e.closed) return { ok: false, code: 'closed' };
      const p = infoOf(newToken);
      const u = p ? remoteDeps.resolveTokenUser(newToken) : null;
      const ui = remoteUserIssue(u);
      if (ui) return { ok: false, code: ui.code };
      if (lc(u.username) !== lc(e.username)) return { ok: false, code: 'user-mismatch' };
      if (e.sid && p.sid !== e.sid) return { ok: false, code: 'sid-mismatch' };
      if (e.mappingId) {
        const m = remoteDeps.getMapping(e.mappingId);
        const mi = m ? mappingAccessIssue(u, m) : '매핑을 찾을 수 없습니다.';
        if (mi) return { ok: false, code: 'mapping-denied' };
      }
      setEntryToken(e, newToken, u);
      return { ok: true, exp: e.exp };
    },
    release() { if (!e.closed) { e.closed = true; releaseEntry(e); } },
  };
}

/** 상태(진단·테스트) — 열린 원격 세션 수·재검증 주기·닫은 사유별 횟수. 계정명·토큰은 싣지 않는다. */
export function remoteSessionStatus() {
  const byKind = {};
  for (const e of _live.values()) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
  return {
    live: _live.size, byKind, revalidateMs: REMOTE_REVALIDATE_MS,
    watching: { revalidateTimer: !!_revalTimer, revocationSubscribed: !!_unsubRevoke },
    closedBy: Object.fromEntries(_closedBy),
  };
}

/**
 * v2.731(A5-02·A1-03): 호스트키 거부의 닫힘 사유 — 'host-key-<판정 사유>'(unknown·changed·rejected·not-approved·bad-fingerprint·internal).
 * 닫힘 코드는 4403 그대로다(권한·범위·매핑과 같은 코드) — 웹(remote/sshSend.js remoteCloseReasonText)이 이 사유로 문구를 고른다.
 * 예전 'host key not trusted' 는 웹이 4403 기본 문구('권한·범위가 바뀌어')로 덮어 사용자가 엉뚱한 원인(권한)을 의심했다.
 * 사유 문자열은 영문 소문자·하이픈만 싣는다(장비가 내민 값이 섞이지 않게).
 */
export function hostKeyCloseReason(r) {
  const why = String(r?.reason || '').toLowerCase().replace(/[^a-z-]/g, '').slice(0, 40);
  return `host-key-${why || 'unknown'}`;
}

/** WS close 사유는 UTF-8 123바이트가 상한이다 — 넘으면 ws 가 RangeError 를 던진다(한글 41자 정도). 글자 경계에서 자른다. */
export function safeWsClose(ws, code, reason = '') {
  let r = String(reason || '');
  while (Buffer.byteLength(r) > 123) r = r.slice(0, -1);
  try { ws.close(code, r); } catch { try { ws.terminate?.(); } catch { /* */ } }
}

/* ══════════════════════ SSH 세션 ══════════════════════ */

// 동시 원격 SSH 세션 상한 + 유휴 타임아웃 — 무제한 세션이 포탈 서버 메모리/FD를 고갈시켜
// 리붓되는 것을 막는다. 환경변수로 조정.
const MAX_SESSIONS = Number(process.env.REMOTE_MAX_SESSIONS) || 80;
/**
 * 계정당 동시 SSH 세션 상한(2026-10-09 I-07 검토) — 전체 상한(80)을 한 계정이 다 쓰면 다른 사람이 열 수 없다.
 * 기본 20, 0 = 끔(예전처럼 전체 상한만). 빈 값은 미지정(기본).
 */
export const MAX_SESSIONS_PER_USER = (() => {
  const v = numOrNull(process.env.REMOTE_MAX_SESSIONS_PER_USER);
  if (v == null || v < 0) return 20;
  return Math.floor(v);
})();
// v2.602(감사 TIM2602-03 — Node 동작 재현: setTimeout(3e9) 은 TimeoutOverflowWarning 과 함께 1ms 에 발화한다):
// 2^31−1ms 초과·음수 env 는 콘솔을 즉시 닫았다. [1분, MAX_TIMER_MS] 로 가두고 0·빈 값·숫자 아님은 기본 30분
// (0 = 끔은 문서화된 적이 없다 — 예전에도 0 은 기본값이었다).
export const idleTimeoutMs = (raw) => clampIntervalMs(Number(raw), 30 * 60_000, 60_000);
const IDLE_MS = idleTimeoutMs(process.env.REMOTE_IDLE_TIMEOUT_MS);

/**
 * 출력 백프레셔(I-07). 값은 연결마다 적용된다(ws.bufferedAmount = 브라우저로 아직 못 보낸 바이트).
 *   high  : 이 이상이면 SSH stdout/stderr 를 멈춘다(SSH 창이 닫혀 대상 서버가 쓰기를 기다린다 — 포탈 메모리에 쌓이지 않는다)
 *   low   : 멈춘 뒤 이 아래로 내려가면 다시 푼다(순서는 그대로 — 스트림을 멈췄다 풀 뿐 버리거나 섞지 않는다)
 *   max   : 멈췄는데도 이 이상이면(멈춤이 듣지 않는 경우의 안전망) 사유를 말하고 닫는다
 *   stall : 멈춘 상태로 이 시간 동안 low 아래로 못 내려가면(브라우저가 받지 않음) 사유를 말하고 닫는다
 * 프로세스 전체 상한은 따로 두지 않았다 — 세션 수 상한(전체·계정당) × (high + SSH 패킷 하나)가 곧 상한이다(기본 80 × 약 1MB).
 */
const posInt = (v, def, min) => { const n = numOrNull(v); return n == null || n <= 0 ? def : Math.max(min, Math.floor(n)); };
export const OUT_HIGH_BYTES = posInt(process.env.REMOTE_WS_HIGH_WATER_BYTES, 1048576, 16384);
export const OUT_LOW_BYTES = Math.min(posInt(process.env.REMOTE_WS_LOW_WATER_BYTES, 262144, 0), Math.floor(OUT_HIGH_BYTES / 2));
export const OUT_MAX_BYTES = Math.max(posInt(process.env.REMOTE_WS_MAX_QUEUE_BYTES, 8388608, 65536), OUT_HIGH_BYTES * 2);
export const OUT_STALL_MS = clampIntervalMs(numOrNull(process.env.REMOTE_WS_STALL_MS) ?? 60_000, 60_000, 5_000);
const RESUME_POLL_MS = 200;

let activeSessions = 0;
const _perUser = new Map(); // username(소문자) → 열린 SSH 세션 수
const _outStats = { pauses: 0, resumes: 0, stallClosed: 0, overflowClosed: 0, maxQueued: 0 };

/** 테스트 주입 — ssh2 Client 생성자(가짜로 바꿔 백프레셔를 결정적으로 재현). */
const sshDeps = { Client: SSHClient };
export function _setSshDepsForTest(o = null) { sshDeps.Client = o?.Client || SSHClient; }

function handleConnection(ws, user, opts = {}) {
  const token = opts.token !== undefined ? opts.token : (_wsToken.get(ws) ?? null);
  const limits = { high: OUT_HIGH_BYTES, low: OUT_LOW_BYTES, max: OUT_MAX_BYTES, stallMs: OUT_STALL_MS, ...(opts.limits || {}) };
  let ssh = null;
  let stream = null;
  let counted = false;
  let countedUser = '';
  let idleTimer = null;
  let closed = false;
  const send = (obj) => { try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch { /* closed */ } };
  const bumpIdle = () => { if (!IDLE_MS || closed) return; clearTimeout(idleTimer); idleTimer = setTimeout(() => { send({ type: 'status', text: `\r\n[유휴 ${Math.round(IDLE_MS / 60000)}분 — 세션을 닫습니다]` }); closeAll(4000, 'idle'); }, IDLE_MS); idleTimer.unref?.(); };

  // ── 출력 백프레셔(I-07) ──
  const out = { paused: false, stallTimer: null, pollTimer: null };
  const queued = () => Number(ws.bufferedAmount) || 0;
  const pauseOutput = () => {
    if (out.paused || closed) return;
    out.paused = true;
    _outStats.pauses++;
    try { stream?.pause(); } catch { /* */ }
    try { stream?.stderr?.pause(); } catch { /* */ }
    out.stallTimer = setTimeout(() => {
      out.stallTimer = null;
      if (!out.paused || closed) return;
      _outStats.stallClosed++;
      send({ type: 'status', text: `\r\n[브라우저가 ${Math.round(limits.stallMs / 1000)}초 동안 출력을 받지 못해 세션을 닫습니다 — 네트워크·브라우저 탭 상태를 확인한 뒤 다시 여세요]` });
      closeAll(4008, 'output stalled');
    }, limits.stallMs);
    out.stallTimer.unref?.();
    // 보낸 조각의 완료 콜백이 resume 을 부르지만, 콜백이 오지 않는 경우(소켓 이상)에도 풀 수 있게 짧은 주기로 본다.
    out.pollTimer = setInterval(resumeIfDrained, RESUME_POLL_MS);
    out.pollTimer.unref?.();
  };
  const clearOutTimers = () => {
    clearTimeout(out.stallTimer); out.stallTimer = null;
    clearInterval(out.pollTimer); out.pollTimer = null;
  };
  function resumeIfDrained() {
    if (!out.paused || closed) return;
    if (queued() > limits.low) return;
    out.paused = false;
    clearOutTimers();
    _outStats.resumes++;
    try { stream?.resume(); } catch { /* */ }
    try { stream?.stderr?.resume(); } catch { /* */ }
  }
  const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
  const forward = (which) => (d) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    const text = decoders[which].write(d); // 조각 경계에서 잘린 UTF-8 글자를 다음 조각과 합친다
    if (!text) return;
    try { ws.send(text, (err) => { if (!err) resumeIfDrained(); }); } catch { return; }
    const q = queued();
    if (q > _outStats.maxQueued) _outStats.maxQueued = q;
    if (q > limits.max) {
      _outStats.overflowClosed++;
      send({ type: 'status', text: `\r\n[출력 대기열이 상한(${Math.round(limits.max / 1048576)}MB)을 넘어 세션을 닫습니다]` });
      closeAll(4009, 'output queue overflow');
      return;
    }
    if (q >= limits.high) pauseOutput();
  };

  // ── 원격 세션 레지스트리(S-04) ──
  const session = trackRemoteSession({
    kind: 'ssh', token, user,
    close: (issue) => {
      send({ type: 'status', text: `\r\n[원격 연결을 닫습니다 — ${issue.text}]` });
      closeAll(issue.status === 401 ? 4401 : 4403, issue.code);
    },
  });

  function closeAll(code, reason) {
    if (closed) return;
    closed = true;
    cleanup();
    safeWsClose(ws, code, reason);
  }

  ws.on('message', (raw) => {
    if (closed) return; // 폐기·종료 뒤 도착한 입력은 대상으로 보내지 않는다(S-04)
    bumpIdle();
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'token') {
      // 세션 연장(POST /auth/extend)으로 받은 새 토큰 — 같은 계정·같은 세션일 때만 바꾼다(S-04 만료 타이머가 새 만료를 따른다).
      const r = session.refresh(typeof msg.token === 'string' ? msg.token : '');
      return send({ type: 'token-ack', ok: !!r.ok, ...(r.ok ? {} : { code: r.code }) });
    }

    if (msg.type === 'auth') {
      // 재인증(auth 프레임 중복) 거부 — 한 소켓에서 여러 auth를 보내면 매번 새 SSHClient가
      // 생성되는데 ssh 참조는 마지막 것만 남아 이전 연결이 누수되고, counted가 이미 true라
      // MAX_SESSIONS 한도도 우회된다(소켓 1개로 무제한 SSH 연결). 이미 인증됐으면 무시.
      if (ssh || counted) return send({ type: 'status', text: '이미 인증된 세션입니다.' });
      // S-04: auth 프레임을 늦게 보낸 경우에도 **지금** 권한으로 판정한다(업그레이드 뒤 강등·삭제·폐기됐을 수 있다).
      if (config.auth.enabled) {
        if (session.check()) return; // 닫았다(사유는 close 콜백이 보냈다)
        user = session.currentUser() || user;
      }
      const m = getMapping(msg.mappingId);
      if (!m || m.protocol !== 'ssh') { send({ type: 'status', text: 'SSH 매핑을 찾을 수 없습니다.' }); return closeAll(4404, 'mapping not found'); }
      // v2.322: 소유·scope 재검사(범위 밖/타인 매핑을 mappingId 추측으로 여는 것 차단).
      const issue = mappingAccessIssue(user, m);
      // v2.731(A5-02·A1-03): 닫힘 사유는 원인을 가르는 코드다 — 'forbidden' 하나로는 웹이 권한·매핑·호스트키를 구분하지 못했다.
      if (issue) { send({ type: 'status', text: issue }); return closeAll(4403, 'mapping-denied'); }
      if (!counted && activeSessions >= MAX_SESSIONS) {
        send({ type: 'status', text: `동시 원격 세션 한도(${MAX_SESSIONS})를 초과했습니다. 사용하지 않는 세션을 닫고 잠시 후 다시 시도하세요.` });
        return closeAll(4429, 'too many sessions');
      }
      const ukey = lc(user?.username || 'anonymous');
      if (MAX_SESSIONS_PER_USER > 0 && (_perUser.get(ukey) || 0) >= MAX_SESSIONS_PER_USER) {
        send({ type: 'status', text: `이 계정의 동시 원격 세션 한도(${MAX_SESSIONS_PER_USER})를 초과했습니다. 사용하지 않는 세션을 닫고 다시 시도하세요.` });
        return closeAll(4429, 'too many sessions for user');
      }
      if (!counted) { activeSessions++; counted = true; countedUser = ukey; _perUser.set(ukey, (_perUser.get(ukey) || 0) + 1); }
      touchMapping(m.id); // reset the 1-day ephemeral expiry clock on use
      session.setMapping(m.id, { host: m.targetHost, port: m.targetPort });
      const proxyHost = getProxyById(m.proxyId).proxyHost;
      const host = proxyHost || m.targetHost;     // dial through the assigned proxy frontend
      const port = proxyHost ? m.publicPort : m.targetPort;
      // 보안상 프록시 주소는 노출하지 않고 '대상'만 표시한다.
      send({ type: 'status', text: `연결 중 ${m.targetHost}:${m.targetPort}…` });

      // ssh -v 스타일 진행 로그(단계별 1회씩) — 접속이 지루하지 않게 과정을 보여준다.
      // 프록시 주소·IP 등 내부 정보는 노출하지 않도록 문구를 가공한다.
      const vshown = new Set();
      const vsend = (key, text) => { if (vshown.has(key)) return; vshown.add(key); send({ type: 'status', text: `🔹 ${text}` }); };
      const onDebug = (line) => {
        const s = String(line || '');
        if (/Trying|Connecting to|socket/i.test(s)) vsend('tcp', '대상에 TCP 연결 중…');
        else if (/Remote ident|remote software|server.*version/i.test(s)) { const v = (s.match(/SSH-[\w.\-@ ]+/) || [])[0]; vsend('ident', `서버 식별 수신${v ? `: ${v.trim()}` : ''}`); }
        else if (/KEXINIT|key exchange|\bKEX\b/i.test(s)) vsend('kex', '키 교환(KEX) 협상 중…');
        else if (/NEWKEYS|encrypt|cipher/i.test(s)) vsend('enc', '암호화 채널 수립…');
        else if (/keyboard-interactive/i.test(s)) vsend('kbd', '인증 시도: keyboard-interactive…');
        else if (/userauth.*password|password auth|Trying password/i.test(s)) vsend('pw', '인증 시도: password…');
        else if (/userauth|authenticat/i.test(s)) vsend('auth', '인증 협상 중…');
      };

      // S-01: 호스트키 확인 — 키는 **대상 서버**의 것이다(프록시는 TCP 를 그대로 넘긴다). 비밀번호 전송 전에 판정한다.
      let hk = null;
      ssh = new sshDeps.Client();
      ssh.on('banner', (b) => vsend('banner', `서버 배너: ${String(b).replace(/\s+/g, ' ').trim().slice(0, 120)}`));
      ssh.on('handshake', (n) => vsend('hs', `핸드셰이크 완료 · 암호화 ${(n && (n.kex || n.serverHostKey)) || 'OK'}`));
      ssh.on('ready', () => {
        if (closed) { try { ssh.end(); } catch { /* */ } return; }
        send({ type: 'status', text: '인증 성공. 셸을 엽니다…' });
        // Fetch the remote hostname so the tab can be labelled by the actual server.
        try {
          ssh.exec('hostname', (e, hs) => {
            if (e || !hs) return;
            collectHostnameLabel(hs, (h) => send({ type: 'hostname', name: h }));
          });
        } catch { /* optional */ }
        ssh.shell({ term: 'xterm-256color', cols: msg.cols || 80, rows: msg.rows || 24 }, (err, s) => {
          if (err) { send({ type: 'status', text: `셸 오류: ${err.message}` }); return closeAll(1011, 'shell error'); }
          if (closed) { try { s.end(); } catch { /* */ } return; }
          stream = s;
          s.on('data', forward('out'));
          s.on('close', () => { send({ type: 'status', text: '\r\n[세션 종료]' }); closeAll(1000, 'session end'); });
          s.stderr?.on('data', forward('err'));
        });
      });
      // 일부 서버(하드닝된 Linux/네트워크 장비/Windows OpenSSH 등)는 password 대신
      // keyboard-interactive 만 허용한다. ssh2는 명시적으로 켜지 않으면 이 방식을
      // 시도하지 않아 'All configured authentication methods failed' 로 끝난다.
      // 같은 비밀번호로 모든 프롬프트에 응답해 password/keyboard-interactive 양쪽을 지원.
      ssh.on('keyboard-interactive', (name, instr, lang, prompts, finish) => {
        finish(prompts.map(() => msg.password || ''));
      });
      ssh.on('error', (err) => {
        if (hk && !hk.ok) {
          // 호스트키 거부 — 인증 실패가 아니다(비밀번호는 보내지 않았다). 조치는 관리자 지문 승인이다.
          send({ type: 'status', text: sshHostKeyError(hk).message.replace(/\s*\[SSH_HOSTKEY_UNTRUSTED\]$/, '') });
          return closeAll(4403, hostKeyCloseReason(hk));
        }
        const hint = /All configured authentication methods failed|authentication/i.test(err.message)
          ? ' — 아이디/비밀번호를 확인하세요. (계정이 맞다면 대상 서버가 비밀번호 로그인을 막아둔 경우일 수 있습니다)'
          : '';
        send({ type: 'status', text: `연결 실패: ${err.message}${hint}` });
        closeAll(1011, 'connect failed');
      });
      ssh.on('close', () => closeAll(1000, 'ssh closed'));
      ssh.connect({
        host, port, username: msg.username, password: msg.password,
        tryKeyboard: true, debug: onDebug,
        // 고RTT(800ms+) + 프록시 경유 + keyboard-interactive 인증의 다중 왕복을 고려해 상향(20s→60s).
        readyTimeout: SSH_GATEWAY_READY_TIMEOUT_MS, keepaliveInterval: 15000,
        hostVerifier: makeSshHostVerifier(m.targetHost, m.targetPort, (r) => {
          hk = r;
          if (r.ok && r.reason !== 'approved') vsend('hk', `서버 키 ${r.algo} ${r.fp} — 아직 승인되지 않은 키입니다(관찰 모드라 연결합니다). 관리자가 설정에서 지문을 확인·승인하세요.`);
        }),
      });
    } else if (msg.type === 'data' && stream) {
      session.touch(); // 키 입력 = 사용자 활동(서버측 유휴 — 그룹 F). 1분 1회로 묶는다.
      stream.write(msg.data);
    } else if (msg.type === 'resize' && stream) {
      try { stream.setWindow(msg.rows, msg.cols, 0, 0); } catch { /* ignore */ }
    }
  });

  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    closed = true;
    clearTimeout(idleTimer); idleTimer = null;
    clearOutTimers();
    session.release();
    if (counted) {
      activeSessions = Math.max(0, activeSessions - 1);
      const n = (_perUser.get(countedUser) || 1) - 1;
      if (n > 0) _perUser.set(countedUser, n); else _perUser.delete(countedUser);
      counted = false;
    }
    try { stream?.end(); } catch { /* */ } try { ssh?.end(); } catch { /* */ }
  }
  ws.on('close', cleanup);
  // ws 오류(비정상 소켓 종료)에도 SSH 연결·카운터를 정리 — 리스너가 없으면 정상 종료 노이즈가
  // 전역 fatal 로그로 새고, close가 안 오는 경우 세션 카운트가 새어 MAX_SESSIONS를 잠식한다.
  ws.on('error', cleanup);
  return { session, isClosed: () => closed, outState: () => ({ paused: out.paused, queued: queued(), timers: !!(out.stallTimer || out.pollTimer || idleTimer) }) };
}

/** 테스트 전용 — 실제 연결 처리기(가짜 ws·가짜 ssh2 로 백프레셔·폐기를 재현한다). */
export const _handleConnectionForTest = handleConnection;

/** 현재 동시 SSH 세션 수(상태/진단용). */
export function activeSshSessionCount() { return activeSessions; }

/** 출력 백프레셔 계측(진단용) — 멈춤·재개 횟수, 대기열 최대치, 사유별 종료 수. */
export function sshOutputStats() {
  return { ..._outStats, limits: { high: OUT_HIGH_BYTES, low: OUT_LOW_BYTES, max: OUT_MAX_BYTES, stallMs: OUT_STALL_MS }, perUserCap: MAX_SESSIONS_PER_USER, perUserOpen: _perUser.size };
}

/**
 * 탭 라벨용 `hostname` 채널을 읽는다(v2.607 감사 SEC2607-05). 예전엔 `out += d` 를 close 까지 **무상한·무시한**
 * 누적했다 — 접속한 VM 이 그 채널에 끝없이 쓰면 WS 세션이 열려 있는 동안 중앙 메모리가 계속 늘었다. 라벨에 쓰는 것은
 * 첫 단어뿐이므로 {@link HOSTNAME_MAX_CHARS} 자에서 멈추고 채널을 닫으며, {@link HOSTNAME_TIMEOUT_MS} 안에 끝나지
 * 않아도 닫는다. 결과는 한 번만 보낸다.
 */
export const HOSTNAME_MAX_CHARS = 256;
export const HOSTNAME_TIMEOUT_MS = 5_000;
export function collectHostnameLabel(hs, onName, { max = HOSTNAME_MAX_CHARS, timeoutMs = HOSTNAME_TIMEOUT_MS } = {}) {
  let out = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { hs.close?.(); } catch { /* */ }
    const h = out.trim().split(/\s+/)[0];
    if (h) onName(h.slice(0, max));
  };
  const timer = setTimeout(finish, timeoutMs);
  timer.unref?.();
  hs.on('data', (d) => {
    if (done) return;
    out += String(d).slice(0, max - out.length + 1);
    if (out.length > max) { out = out.slice(0, max); finish(); }
  });
  hs.on('close', finish);
  hs.on?.('error', finish);
}
