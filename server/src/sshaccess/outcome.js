/**
 * sshaccess/outcome.js — 접속 결과를 **본 곳**(폴러 · 연결 시험)이 부르는 하나(v3.24 서버 접속 — 설계 docs/design/server-access §4.4).
 *
 *  · 키로 접속했으면 키 사용 기록(usage.noteKeyUse — v3.9.0 그대로).
 *  · 공통 계정 **비밀번호**로 접속했으면 계정 사용 기록(같은 파일 · 지문 칸 `ACCT:<id>`) — 그리고 **로그인 거부면 계정 단위 정지**
 *    (state.setAccountStop — 그 비밀번호 판 동안 그 계정을 쓰는 서버 전부가 접속하지 않는다. 서버마다 한 번씩 틀린 비밀번호를 보내
 *    AD 계정 잠금 횟수를 넘기지 않게). 비밀번호를 새로 넣으면 판이 바뀌어 풀린다(refs.resolveOsAuth 가 판을 대조한다).
 *  · 자격 해석이 막아 **접속하지 않은** 결과(authErrorCode)는 사용이 아니다 — 쌓지 않는다(반증 D3 와 같은 규칙).
 *  · 로그인 거부 판정은 **호출부가 접속 단계에서 본 값**(`rejected` — bm-storage `authFailed` · bm-usage `isSshAuthError` · 연결 시험 kind 'auth-rejected')만 쓴다.
 *    문구로 다시 판정하지 않는다(반증 F3 — 로그인에 성공한 뒤 df 의 'Permission denied' 가 문구 판정에 걸려 법인 전체 수집을 멈췄다).
 * 판정(접속 허락)에는 이 기록을 쓰지 않는다 — 정지 여부 판정은 refs.resolveOsAuth 하나다.
 */
import { noteKeyUse, accountUseFingerprint } from './usage.js';
import { setAccountStop } from './state.js';

/**
 * @param {object} srv  withResolvedAuth 가 해석한 서버(keyFingerprint · credAccountId · credVersion — 비밀 아님) 또는 resolveOsAuth 결과를 덧씌운 서버
 * @param {{ok:boolean, rejected?:boolean, error?:string, code?:string, feature:string, trigger?:string, by?:string, authStopped?:boolean}} r
 *   rejected — 접속 단계의 로그인 거부(호출부 판정 · true 일 때만 계정 단위 정지)
 * @returns {{recorded:boolean, accountStopped?:boolean}}
 */
export function noteCredOutcome(srv, { ok = false, rejected: rej = false, code = '', feature = '', trigger = 'poll', by = '', authStopped = false } = {}) {
  if (!srv || typeof srv !== 'object' || srv.authErrorCode) return { recorded: false };
  const server = String(srv.name || srv.host || '').slice(0, 128);
  const corp = String(srv.vcenterId || '');
  const rejected = !ok && !authStopped && rej === true;
  const outCode = ok ? 'ok' : (authStopped ? 'auth-stopped' : (rejected ? 'auth-rejected' : (code || 'fail')));
  if (srv.keyFingerprint) {
    noteKeyUse({ fingerprint: srv.keyFingerprint, keyName: srv.keyName, server, corp, feature, ok: !!ok, code: outCode, trigger, by });
    return { recorded: true };
  }
  if (!srv.credAccountId) return { recorded: false };
  noteKeyUse({ fingerprint: accountUseFingerprint(srv.credAccountId), keyName: srv.credAccountName || '', server, corp, feature, ok: !!ok, code: outCode, trigger, by });
  // 비밀번호 판(credVersion)이 있을 때만 — 키로 접속한 계정 · 판을 모르는 결과로는 계정을 멈추지 않는다.
  if (rejected && srv.credVersion != null) {
    const w = setAccountStop(srv.credAccountId, { server, feature, version: srv.credVersion, accountName: srv.credAccountName || '' });
    return { recorded: true, accountStopped: !!w.ok };
  }
  return { recorded: true };
}
