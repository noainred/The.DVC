/**
 * sshaccess/readServer.js — **서버 한 대에 한 번 로그인해 기능이 등록한 고정 읽기 묶음을 돌린다**(서버 접속 코어 · 설계 docs/design/server-access §4.2 · §4.5).
 *
 * 순서: ① 등록부에서 서버(엣지 위임 서버는 그 엣지에서 — 중앙은 붙지 않는다 · 수집을 끈 서버는 붙지 않는다) → ② 자격 해석(refs.withResolvedAuth — 서버 단독 →
 *   법인 › OS 종류 → 법인 · 법인 사용 중지 · 허용 기능 · 계정 정지 · 바꿔치기 판정이 여기서 끝난다) → ③ 탐침(공통 계정 비밀번호는 accountGate · 서버 단독 비밀번호는
 *   호출부가 준 일괄 문 `credGate` — 같은 계정명 · 비밀번호로 가는 일괄 안의 접속은 첫 결과를 본 뒤에) → ④ 로그인 한 번 + 명령 하나(시한 · 출력 상한) →
 *   ⑤ 결과 기록(outcome — 키 · 계정 사용 기록 · 로그인 거부면 계정 단위 정지).
 * 하는 일만: 명령은 **기능이 넘긴 고정 문자열**이다(이 함수는 글자를 이어 붙이지 않는다 — 사용자 입력이 명령에 들어갈 길이 없다).
 *   키가 거부되면 비밀번호로 넘어가지 않는다 · 다시 시도하지 않는다 · 비밀번호는 **한 번만** 보낸다(ssh2 의 keyboard-interactive 재시도 끔 — 반증 F1) ·
 *   자격이 없으면 붙지 않는다(빈 비밀번호로 시도해 계정을 잠그지 않게).
 * 시한: 로그인(readyTimeout) + 명령(plan.timeoutMs) < 장비 시한(deadlineMs) — 시험이 산수를 고정한다. 명령 시한 · 출력 상한에 걸리면 던지지 않고 받은 만큼 돌려준다
 *   (`code: 'exec-timeout' | 'exec-truncated'` + stdout — 기능이 끝 표지로 잘림을 판정한다 · 로그인은 성공이므로 탐침은 ok — 반증 F6).
 * 전송: 지금은 SSH 하나(Windows 는 OpenSSH Server + PowerShell — 설계 D2 1단계). WinRM 은 3단계에서 같은 자리에 붙는다.
 * 돌려주는 것: 비밀 없음 — `{ ok, code, reason, os, via, auth:{kind, account, source}, stdout, stderr, ms }`(stdout 은 기능이 해석한다 · 화면 · 저장에 원문을 싣지 않는다).
 */
import crypto from 'node:crypto';
import { listBmServersRaw, registryLoadError } from '../bmstor/registry.js';
import { withResolvedAuth, AUTH_ERROR } from '../bmusage/onboard/refs.js';
import { withSsh, isSshAuthError, isSshHostKeyError } from '../proxy/sshExec.js';
import { withDeadline } from '../util/deadline.js';
import { gateAccountLogin } from './accountGate.js';
import { noteCredOutcome } from './outcome.js';

const t = (v, n = 256) => String(v ?? '').trim().slice(0, n);
/** 로그인 시한(ssh2 readyTimeout) — 명령 시한과 더해 장비 시한보다 작아야 한다(시험). */
export const READ_LOGIN_TIMEOUT_MS = 15_000;
export const READ_DEADLINE_MS = 60_000;

/** 읽기 결과 코드(화면 문구 · 시험이 같은 열쇠를 쓴다). */
export const READ_CODES = Object.freeze(['ok', 'not-found', 'registry-unreadable', 'edge-delegated', 'disabled', 'not-configured', 'cred', 'auth-rejected', 'same-cred-rejected',
  'hostkey', 'timeout', 'exec-timeout', 'exec-truncated', 'connect', 'no-plan']);

/**
 * 일괄 문(서버 단독 비밀번호 — 반증 F2): 같은 계정명 · 비밀번호(해시 — 원문을 열쇠로 두지 않는다)로 가는 일괄 안의 접속은 첫 결과를 본 뒤에.
 *   거부면 나머지는 보내지 않는다(`same-cred-rejected`) · 성공이면 함께 · 연결 실패면 다음 하나가 탐침. 일괄 하나 동안만 산다(메모리 · 호출부가 만든다).
 */
export function makeCredGate() {
  const state = new Map();   // 열쇠 → { verdict:'ok'|'rejected'|null, inflight:Promise|null }
  return async function credGate(key, run) {
    for (let i = 0; i < 10_000; i += 1) {
      const st = state.get(key) || { verdict: null, inflight: null };
      if (st.verdict === 'rejected') return { ok: false, sameCredRejected: true };
      if (st.verdict === 'ok') return run();
      if (st.inflight) { await st.inflight; continue; }
      let done; st.inflight = new Promise((r) => { done = r; }); state.set(key, st);
      let v = null;
      try { const r = await run(); v = r?.ok ? 'ok' : (r?.authFailed ? 'rejected' : null); return r; }
      finally { st.verdict = v; st.inflight = null; done(); }
    }
    return { ok: false, sameCredRejected: true };
  };
}
const credKey = (srv) => crypto.createHash('sha256').update(`${t(srv.username || 'root', 128).toLowerCase()}\0${srv.password || ''}`).digest('hex').slice(0, 24);

/**
 * @param {string} serverId  bm-storage 등록부 id
 * @param {{feature:string, plan:{linux?:{command:string,timeoutMs:number,maxBytes?:number}, windows?:{command:string,timeoutMs:number,maxBytes?:number}}, deadlineMs?:number, signal?:AbortSignal,
 *          by?:string, trigger?:string, credGate?:Function}} o
 *   plan — OS 마다 고정 명령 하나. 서버에 OS 를 정하지 않았으면 linux 로 읽는다(추측해서 두 OS 를 차례로 대 보지 않는다 — 계정 잠금).
 */
export async function readServer(serverId, { feature, plan = {}, deadlineMs = READ_DEADLINE_MS, signal, by = '', trigger = 'manual', credGate = null } = {}) {
  const t0 = Date.now();
  if (registryLoadError()) return { ok: false, code: 'registry-unreadable', reason: 'OS 계정 등록부(bm-storage.json)를 읽지 못했습니다 — 접속하지 않았습니다.' };
  const raw = listBmServersRaw().find((s) => s.id === t(serverId, 64));
  if (!raw) return { ok: false, code: 'not-found', reason: '서버를 찾을 수 없습니다.' };
  if (t(raw.agent)) return { ok: false, code: 'edge-delegated', reason: `엣지(${t(raw.agent, 64)})가 수집하는 서버입니다 — 그 엣지 포탈의 같은 화면에서 읽습니다(비밀은 법인 밖으로 나가지 않습니다).` };
  if (raw.enabled === false) return { ok: false, code: 'disabled', reason: '수집을 끈 서버입니다 — 붙지 않습니다(베어메탈 스토리지에서 켜면 읽습니다).' };
  const os = raw.os === 'windows' ? 'windows' : 'linux';
  const step = plan[os];
  if (!step || typeof step.command !== 'string' || !step.command) return { ok: false, code: 'no-plan', os, reason: `이 기능은 ${os === 'windows' ? 'Windows' : 'Linux'} 읽기 묶음이 없습니다.` };
  const [srv] = withResolvedAuth([raw], { feature });
  const auth = { kind: srv.privateKey ? 'key' : 'password', account: t(srv.credAccountName || '', 64), source: t(srv.credSource || (srv.keyRef || srv.credRef ? 'own' : ''), 16) };
  if (srv.authErrorCode) return { ok: false, code: 'cred', credCode: srv.authErrorCode, reason: String(srv.authError || '').slice(0, 300), os, auth };
  if (!srv.privateKey && !srv.password) return { ok: false, code: 'not-configured', os, auth, reason: '이 서버에 정한 계정이 없습니다(따로 정함 · 물려받기 승인 모두 없음) — 설정 › 보안 › 서버 접속에서 정하세요.' };
  // 시한은 탐침 대기 밖에서 연다(run 안) — 호출부 signal(일괄 취소)과 합친다. 시한이 오면 세션째 끊는다(withSsh signal).
  const run = () => withDeadline(deadlineMs, (sig) => withSsh({ host: String(srv.host), port: Number(srv.port) || 22, username: srv.username || 'root', password: srv.password || '',
    privateKey: srv.privateKey, passphrase: srv.passphrase, readyTimeout: READ_LOGIN_TIMEOUT_MS, singlePasswordAttempt: true, signal: signal ? AbortSignal.any([sig, signal]) : sig },
  async ({ exec }) => ({ out: await exec(step.command, step.timeoutMs, { partial: true, maxBytes: step.maxBytes }) }))
    // 로그인에 성공하면 명령이 시한 · 상한에 걸려도 ok(탐침 판정 — 비밀번호는 맞았다)
    .then((x) => ({ ok: true, out: x.out }))
    .catch((e) => ({ ok: false, error: String(e?.message || e), hostkey: isSshHostKeyError(e), authFailed: isSshAuthError(e), timeout: sig.aborted || !!signal?.aborted })), '서버 읽기 시한 초과')
    .catch((e) => ({ ok: false, error: String(e?.message || e), timeout: true }));
  const viaAccount = srv.credAccountId && srv.credVersion != null;
  const gated = viaAccount
    ? () => gateAccountLogin(srv, run, { feature, rejected: (x) => x?.authFailed === true, stopped: (code) => ({ ok: false, gated: code }) })
    : (!srv.privateKey && typeof credGate === 'function' ? () => credGate(credKey(srv), run) : run);
  const r = await gated();
  if (r.gated) return { ok: false, code: 'cred', credCode: r.gated, os, auth, reason: AUTH_ERROR[r.gated] || AUTH_ERROR['account-stopped'] };
  if (r.sameCredRejected) return { ok: false, code: 'same-cred-rejected', os, auth, reason: '같은 계정명 · 비밀번호로 이번 일괄에서 먼저 읽은 서버가 로그인을 거부해 이 서버에는 보내지 않았습니다(계정 잠금 방지).' };
  // 키 · 공통 계정 사용 기록 + 로그인 거부면 계정 단위 정지(outcome 하나 — 접속 단계 판정만)
  if (srv.keyFingerprint || srv.credAccountId) noteCredOutcome(srv, { ok: !!r.ok, rejected: r.authFailed === true, code: r.ok ? 'ok' : (r.timeout ? 'timeout' : 'fail'), feature, trigger, by });
  const ms = Date.now() - t0;
  if (!r.ok) {
    const code = r.authFailed ? 'auth-rejected' : r.hostkey ? 'hostkey' : r.timeout ? 'timeout' : 'connect';
    const reason = code === 'auth-rejected' ? '로그인이 거부됐습니다(다시 시도하지 않습니다 — 계정 잠금 방지).'
      : code === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
        : code === 'timeout' ? `시한 안에 끝나지 않았습니다(${Math.round(deadlineMs / 1000)}초).`
          : `접속하지 못했습니다(${String(r.error || '').replace(/\s+/g, ' ').slice(0, 120)})`;
    return { ok: false, code, reason, os, via: 'ssh', auth, ms };
  }
  const out = r.out || {};
  const exit = out.code;
  const base = { os, via: 'ssh', auth, ms, exit: Number.isInteger(exit) ? exit : null, stdout: String(out.stdout || ''), stderr: String(out.stderr || '').slice(0, 2000) };
  if (out.timedOut) return { ok: false, code: 'exec-timeout', reason: `명령이 시한(${Math.round((step.timeoutMs || 0) / 1000)}초) 안에 끝나지 않았습니다 — 받은 칸만 씁니다.`, partial: true, ...base };
  if (out.truncated) return { ok: false, code: 'exec-truncated', reason: '출력이 상한을 넘어 잘랐습니다 — 받은 칸만 씁니다.', partial: true, ...base };
  return { ok: true, code: 'ok', ...base };
}
