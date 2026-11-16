/**
 * focusmon/audit/install.js — 디스크 점검 프로그램 **자동 설치**(v3.17.0 · 사용자 "디스크 점검하는 프로그램을 자동으로 설치하는 기능 추가" · 시안 ⑱ §21 · '진행해' = 컨펌 기본값).
 * 중앙과 엣지가 같은 파일을 쓴다 — 그 서버를 맡은 노드가 자기 SSH 공용 접속의 키로 설치한다(엣지 서버의 키는 법인 밖으로 나가지 않는다).
 *
 * 한 서버 설치(서버당 시한 `INSTALL_TIMEOUT_MS` — 세션을 실제로 끊는다):
 *  ① 설치 계정(installCred — ‘설치’ 를 직접 켠 키만) ② 그 키로 접속 ③ 권한 확인 `PRIV_COMMAND`(root 인가 · 비밀번호 없는 sudo 인가 — 아니면 끝: 아무것도 올리지 않는다)
 *  ④ 설치 파일(bundle.installScript — 디렉터리는 파일 안에 고정)을 설치 계정 홈에 0600 · 난수 이름으로 올림 ⑤ `INSTALL_COMMAND` 로 root 로 한 번 —
 *     명령에 들어가는 값은 등록부의 **수집 계정 이름**(ACCT_RE)과 이 노드가 만든 난수 파일 이름뿐이고, 같은 명령 끝에서 그 파일을 지운다
 *  ⑥ 수집 계정 · 집중 모니터링 키로 준비 확인(runner.auditOnce check — 설치한 디렉터리 하나).
 *  · 설치 파일 출력은 `##DI` 표지 줄만 읽는다(단계 · 실패 까닭 · 끝) — 원격 글은 결과 · 감사 · 화면에 싣지 않는다(정해 둔 까닭 이름 · 종료값만).
 *  · 인증 거부는 자동으로 다시 시도하지 않는다. 같은 키가 **연속 `AUTH_STOP_AFTER` 대** 거부되면 그 키로는 `AUTH_STOP_MS` 동안 접속하지 않는다(계정 잠금 · 일괄 설치).
 *  · 판본: 작업을 준 중앙이 아는 프로그램 sha256(expect.program)과 이 노드의 프로그램이 다르면 설치하지 않는다('version' — 중앙 · 엣지 판이 다를 때).
 *  · 데모(mock) 대상은 SSH 없이 같은 모양의 결과를 낸다(장비에 닿지 않는다).
 */
import crypto from 'node:crypto';
import { withSsh, isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { READY_TIMEOUT_MS } from '../collector.js';
import { installScript, programSha, dirIssue, ACCT_RE, INSTALL_FAILS } from './bundle.js';
import { installCredFor } from './installCred.js';
import { auditOnce } from './runner.js';
import { isDemoTarget } from '../mock.js';
import { demoAuditOutput } from './mock.js';

/**
 * 시한 산수(v3.17.0 반증 D5 — 설치 exec 시한이 장비 시한과 같아 넘치면 세션째 끊겨 올린 파일을 지우지 못했다):
 *   접속(READY_TIMEOUT_MS) + 권한 확인 + 파일 올림 + 설치 exec + 정리 exec + 여유 ≤ 장비 시한. 시험이 산수를 고정한다.
 */
export const INSTALL_PRIV_MS = 20_000;
export const INSTALL_UPLOAD_MS = 20_000;
export const INSTALL_EXEC_MS = 90_000;
export const INSTALL_CLEANUP_MS = 10_000;
export const INSTALL_MARGIN_MS = 5_000;
export const INSTALL_TIMEOUT_MS = 160_000;
export const NODE_INSTALL_CONCURRENCY = 4;
export const AUTH_STOP_AFTER = 3;
export const AUTH_STOP_MS = 10 * 60_000;
/** 결과 까닭(화면 문구 키 — 웹 `INSTALL_CODE_TEXT` 와 같다 · 시험 대조). 'script' 는 설치 파일이 멈춘 것(fail = INSTALL_FAILS). */
export const INSTALL_CODES = Object.freeze(['ok', 'cred', 'bad-dir', 'bad-acct', 'version', 'key-stopped', 'auth', 'hostkey', 'unreachable', 'timeout', 'sudo-password', 'sudo-tty', 'upload', 'script', 'script-other', 'check', 'not-ready']);
/** 단계(0 ~ 7 — 화면 막대). */
export const INSTALL_STEPS = Object.freeze(['cred', 'connect', 'priv', 'dir', 'files', 'sudoers', 'old', 'check']);
/** 권한 확인(상수) — root · 비밀번호 없는 sudo · 아님. */
//   sudo 가 tty 를 요구하면(sudoers `Defaults requiretty` — 옛 RHEL 7 기본값일 수 있다 · 추정) 'tty' — 비밀번호 문제와 고칠 곳이 다르다.
export const PRIV_COMMAND = "if [ \"$(id -u)\" = 0 ]; then echo '##DI priv root'; elif E=$(sudo -n true 2>&1); then echo '##DI priv sudo'; else case \"$E\" in *tty*) echo '##DI priv tty' ;; *) echo '##DI priv no' ;; esac; fi";
/** 설치 실행 — 값은 수집 계정 이름(ACCT_RE) · 파일 이름(이 노드의 난수 — FILE_RE)뿐. 같은 명령 끝에서 올린 파일을 지운다. */
export const FILE_RE = /^\.dvc-da-install\.[0-9a-f]{16}\.sh$/;
export function installCommand({ sudo, file, acct }) {
  if (!FILE_RE.test(file) || !ACCT_RE.test(acct)) throw new Error('설치 명령 값이 규칙에 맞지 않습니다');
  return `${sudo ? 'sudo -n ' : ''}/bin/sh "$HOME/${file}" ${acct}; echo "##DI rc $?"; rm -f "$HOME/${file}"`;
}
/** 설치 exec 가 시한 · 오류로 끝났을 때 올린 파일만 지운다(이름은 FILE_RE — 값 삽입 규칙 그대로). */
export function cleanupCommand(file) {
  if (!FILE_RE.test(file)) throw new Error('설치 파일 이름이 규칙에 맞지 않습니다');
  return `rm -f "$HOME/${file}"`;
}
/** 시한 경주(파일 올림처럼 자체 시한이 없는 단계 — 넘치면 던진다). */
export function within(p, ms, what) {
  let t; const lim = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} 시한(${Math.round(ms / 1000)}s) 초과`)), ms); t.unref?.(); });
  return Promise.race([p, lim]).finally(() => clearTimeout(t));
}

/** 설치 파일 출력 → 표지만(순수 — 시험 고정). */
export function parseInstallOut(text) {
  const out = { steps: [], fail: null, ok: false, rc: null, nopy: false, oldRm: 0, oldKeep: 0 };
  for (const raw of String(text || '').split('\n').slice(0, 400)) {
    const l = raw.trim();
    if (!l.startsWith('##DI ')) continue;
    const [, k, v] = l.split(' ');
    if (k === 'step' && ['dir', 'files', 'sudoers', 'old'].includes(v) && !out.steps.includes(v)) out.steps.push(v);
    else if (k === 'fail' && out.fail == null) out.fail = INSTALL_FAILS.includes(v) ? v : 'other';
    else if (k === 'ok' && v === undefined) out.ok = true;
    else if (k === 'rc' && /^\d{1,3}$/.test(v || '')) out.rc = Number(v);
    else if (k === 'nopy' && v === undefined) out.nopy = true;
    else if (k === 'old-rm') out.oldRm += 1;
    else if (k === 'old-keep') out.oldKeep += 1;
  }
  return out;
}
const stepOf = (p) => (p.ok ? 6 : p.steps.includes('sudoers') ? 5 : p.steps.includes('files') ? 4 : 3);

/* ── 같은 키 연속 거부(노드 기억 — v3.18.0 접속 준비도 같은 기억을 쓴다: 같은 root 키가 설치 · 준비 양쪽에서 거부를 쌓는다) ── */
const authFails = new Map(); // keyFingerprint → { n, at }
export function _resetInstallForTest() { authFails.clear(); }
export function keyStopped(fp, now) { const r = authFails.get(fp); return !!r && r.n >= AUTH_STOP_AFTER && now - r.at < AUTH_STOP_MS; }
export function noteAuth(fp, ok, now) {
  if (!fp) return;
  if (ok) { authFails.delete(fp); return; }
  const r = authFails.get(fp); const n = r && now - r.at < AUTH_STOP_MS ? r.n + 1 : 1;
  authFails.set(fp, { n, at: now });
  if (authFails.size > 500) authFails.delete(authFails.keys().next().value);
}

/**
 * 한 서버 설치.
 * @param {{id, name, host, port, username, demo?}} t  집중 모니터링 대상(username = 수집 계정)
 * @param {{keys, connect?, expect:{program, dir, oldDirs, pick, edge}, credOf?, onPhase?, timeoutMs?, now?}} o
 * @returns {Promise<object>}  { mode:'install', ok, kind, error, install:{code, fail, step, rc, acct, key, src, dir, nopy, oldRm, oldKeep, priv, cred}, ready, dir, ms }
 */
export async function installOnce(t, { keys, connect = withSsh, expect = {}, credOf = installCredFor, onPhase = () => {}, timeoutMs = INSTALL_TIMEOUT_MS, now = () => Date.now() } = {}) {
  const t0 = now();
  const dir = typeof expect?.dir === 'string' ? expect.dir : '';
  const oldDirs = (Array.isArray(expect?.oldDirs) ? expect.oldDirs : []).slice(0, 3).map((x) => (x == null ? '' : x)).filter((x) => typeof x === 'string' && !dirIssue(x));
  const res = (code, extra = {}) => ({ mode: 'install', ok: code === 'ok', kind: code === 'ok' ? 'done' : 'not-ready', error: '', ready: [], dir, ms: now() - t0,
    install: { code, fail: null, step: 0, rc: null, acct: '', key: '', src: null, dir, nopy: false, oldRm: 0, oldKeep: 0, priv: null, cred: null, ...extra } });
  if (dirIssue(dir)) return res('bad-dir');
  if (!ACCT_RE.test(String(t?.username || ''))) return res('bad-acct');
  if (/^[0-9a-f]{64}$/.test(expect?.program || '') && expect.program !== programSha()) return res('version');
  if (t.demo || isDemoTarget(t.id)) {
    try { onPhase('설치'); } catch { /* */ }
    // 데모 — 장비에 닿지 않는다. 준비 확인은 실데이터와 같은 길(그 디렉터리의 준비 줄)을 탄다.
    return { ...res('ok', { step: 7, acct: 'dvcadmin', key: 'demo-common', src: 'corp', priv: 'sudo' }), ready: demoAuditOutput(t.id, 'check', dir).ready, dir };
  }
  // 엣지: 법인 = 그 엣지 스냅샷의 vCenter 들(installExec 의 edgeVcs — 중앙이 보낸 값이 아니다 · JSON 으로는 함수를 실을 수 없다)
  const corpVcs = expect?.edge ? (typeof expect.edgeVcs === 'function' ? expect.edgeVcs() : []) : (Array.isArray(expect?.corpVcs) ? expect.corpVcs : []);
  const cred = credOf(t, { edge: !!expect?.edge, corpVcs, pick: expect?.pick || null, withAuth: true });
  if (!cred || cred.state !== 'ok' || !cred.auth) return res('cred', { cred: cred?.state || 'error', acct: cred?.acct || '', key: cred?.key || '', src: cred?.src || null });
  const who = { acct: cred.acct, key: cred.key, src: cred.src };
  const fp = cred.auth.fingerprint || '';
  if (keyStopped(fp, now())) return res('key-stopped', { step: 1, ...who });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs); timer.unref?.();
  const file = `.dvc-da-install.${crypto.randomBytes(8).toString('hex')}.sh`;
  let step = 1; let priv = null; let parsed = null; let execTimedOut = false;
  try {
    let text;
    try { text = installScript({ dir, oldDirs }); } catch { return res('bad-dir', who); }
    onPhase('접속');
    await connect({ host: t.host, port: t.port, username: cred.auth.username, privateKey: cred.auth.privateKey, passphrase: cred.auth.passphrase || undefined, readyTimeout: READY_TIMEOUT_MS, signal: ctl.signal }, async (api) => {
      step = 2; onPhase('권한 확인');
      const pr = await api.exec(PRIV_COMMAND, INSTALL_PRIV_MS);
      const m = /##DI priv (root|sudo|tty|no)\b/.exec(String(pr.stdout || ''));
      priv = m ? m[1] : 'no';
      if (priv === 'no' || priv === 'tty') return {};
      step = 3; onPhase('설치 파일 올림');
      try { await within(api.writeFile(file, text, 0o600), INSTALL_UPLOAD_MS, '파일 올림'); } catch (e) {
        parsed = { upload: String(e?.message || e).slice(0, 80) };
        await api.exec(cleanupCommand(file), INSTALL_CLEANUP_MS).catch(() => null); // 반쯤 올라간 파일
        return {};
      }
      onPhase('설치');
      let r;
      try { r = await api.exec(installCommand({ sudo: priv === 'sudo', file, acct: t.username }), INSTALL_EXEC_MS); } catch (e) {
        // 설치 exec 가 시한 · 오류로 끝났다 — 같은 세션에서 올린 파일만 지우고(명령 끝의 rm 이 돌지 않았다) 시한으로 알린다
        execTimedOut = /타임아웃/.test(String(e?.message || ''));
        await api.exec(cleanupCommand(file), INSTALL_CLEANUP_MS).catch(() => null);
        throw e;
      }
      parsed = parseInstallOut(r.stdout);
      return {};
    }, { signal: ctl.signal });
    noteAuth(fp, true, now());
  } catch (e) {
    if (isSshHostKeyError(e)) return res('hostkey', { step, ...who });
    if (isSshAuthError(e)) { noteAuth(fp, false, now()); return res('auth', { step: 1, ...who }); }
    if (ctl.signal.aborted || execTimedOut) return res('timeout', { step, priv, ...who });
    return res('unreachable', { step, priv, ...who });
  } finally { clearTimeout(timer); }
  if (priv === 'no' || priv === 'tty') return res(priv === 'tty' ? 'sudo-tty' : 'sudo-password', { step: 2, priv, ...who });
  if (parsed?.upload) return res('upload', { step: 3, priv, ...who });
  if (!parsed?.ok) return res(parsed?.fail ? 'script' : 'script-other', { step: parsed ? stepOf(parsed) : 3, fail: parsed?.fail || null, rc: parsed?.rc ?? null, nopy: !!parsed?.nopy, priv, ...who });
  // ⑥ 수집 계정으로 준비 확인(설치한 디렉터리 하나) — 키 로그인이 거부되면 '설치함 · 확인 못 함'
  onPhase('준비 확인');
  const ck = await auditOnce(t, { mode: 'check', keys, connect, expect: { program: expect?.program, cands: [dir] }, deadlineMs: 60_000 }).catch(() => null);
  const done = { step: 7, rc: parsed.rc, nopy: parsed.nopy, oldRm: parsed.oldRm, oldKeep: parsed.oldKeep, priv, ...who };
  if (!ck || ck.kind !== 'done') return { ...res('check', done), ok: true, kind: 'done', error: ck?.error || '', ready: [] };
  return { ...res('ok', done), ready: ck.ready || [], dir: ck.dir ?? dir };
}

/** 설치 결과 → 작업 결과 모양(runner.createAuditRunner 의 exec 자리에 꽂는다 — 노드마다 줄 하나 · 동시 NODE_INSTALL_CONCURRENCY). */
export function installExec(credOpts = {}) {
  return (target, o) => installOnce(target, { ...o, expect: { ...(o.expect || {}), ...credOpts } });
}
