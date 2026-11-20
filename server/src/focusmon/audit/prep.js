/**
 * focusmon/audit/prep.js — 집중 모니터링 **접속 자동 준비**(v3.18.0 · 사용자 "집중 모니터링을 하려면 SSH 로그인 정보를 추가해야 하는데,
 * 지금 엣지에서 root 로 ssh 접근이 되니까 자동으로 설치하는 기능 만들어줘" · 시안 ⑲ §22 · '진행해' = 컨펌 15항목 괄호 값).
 * 중앙과 엣지가 같은 파일을 쓴다 — 그 서버를 맡은 노드가 자기 SSH 공용 접속의 root 키(‘접속 준비’ 를 직접 켠 키만)로 한다.
 *
 * 한 서버 준비(서버당 시한 `PREP_TIMEOUT_MS` — 세션을 실제로 끊는다):
 *  ① 준비 계정(installCred · feature 'focus-mon-prep') ② 그 키로 접속 ③ 권한 확인(`PRIV_COMMAND` + 그 접속의 출발 주소 — from= 을 고른 때만 쓴다)
 *  ④ 준비 파일(`prepScript` — 이 노드의 공개키 한 줄은 **파일 안에** · 명령 값은 수집 계정 이름 하나)을 0600 · 난수 이름으로 올려 root 로 한 번
 *     — 파일이 sshd 의 실제 설정(`sshd -T`)을 **읽기만** 해 막혀 있으면 아무것도 바꾸지 않고 멈추고, 계정이 없으면 만들고(비밀번호 칸 '*'),
 *       공개키는 **그 계정의 권한으로**(runuser) 넣는다 — root 가 남의 홈에 직접 쓰지 않는다(심링크로 다른 파일을 덮게 하는 길을 막는다).
 *  ⑤ 수집 계정 · 집중 모니터링 키로 연결 시험(collector.testTarget — 지금 있는 시험) ⑥ 고른 때만 · 키 로그인이 된 서버 · 같은 키가 ‘설치’ 도 켰을 때 디스크 점검 설치(install.installOnce).
 *  · 출력은 `##DP` 표지 줄만 읽는다(정해 둔 까닭 이름 · 종료값) — 원격 글은 결과 · 감사 · 화면에 싣지 않는다.
 *  · 인증 거부는 자동으로 다시 시도하지 않고, 같은 키의 연속 거부 기억은 설치와 같이 쓴다(install.keyStopped · noteAuth).
 */
import crypto from 'node:crypto';
import { withSsh, isSshAuthError, isSshHostKeyError } from '../../proxy/sshExec.js';
import { READY_TIMEOUT_MS, testTarget, focusAuthGuard, authDevOf } from '../collector.js';
import { ACCT_RE } from './bundle.js';
import { installCredFor, PREP_FEATURE, INSTALL_FEATURE } from './installCred.js';
import { installOnce, PRIV_COMMAND, within, keyStopped, noteAuth } from './install.js';
import { isDemoTarget, demoHello } from '../mock.js';

/** 시한 산수(시험 고정): 접속 + 권한 확인 + 파일 올림 + 준비 exec + 정리 exec + 여유 ≤ 서버당 시한. 연결 시험 · 디스크 점검 설치는 각자 시한이 따로 있다. */
export const PREP_PRIV_MS = 20_000;
export const PREP_UPLOAD_MS = 20_000;
export const PREP_EXEC_MS = 60_000;
export const PREP_CLEANUP_MS = 10_000;
export const PREP_MARGIN_MS = 5_000;
export const PREP_TIMEOUT_MS = 140_000;
/** 준비 파일이 멈춘 까닭(웹 `PREP_FAIL_TEXT` 와 같다 · 시험 대조). */
export const PREP_FAILS = Object.freeze(['args', 'not-root', 'acct-root', 'sshd-missing', 'sshd-unread', 'sshd-pubkey', 'sshd-akfile', 'sshd-allow', 'sshd-deny', 'sshd-groups',
  'sshd-authmethods', 'acct-create', 'acct-shell', 'acct-home', 'acct-sudo', 'key-symlink', 'key-write', 'no-runuser']);
/** 결과 까닭(웹 `PREP_CODE_TEXT` 와 같다). 'login' = 넣었지만 키 로그인 거부 · 실패. */
export const PREP_CODES = Object.freeze(['ok', 'login', 'cred', 'bad-acct', 'acct-root', 'acct-prep', 'no-key', 'conn-unknown', 'key-stopped', 'auth', 'hostkey', 'unreachable', 'timeout',
  'sudo-password', 'sudo-tty', 'upload', 'script', 'script-other', 'busy', 'queue-full']);
/** 단계(0 ~ 7 — 화면 막대 · 시안의 8칸). */
export const PREP_STEPS = Object.freeze(['cred', 'connect', 'priv', 'sshd', 'acct', 'key', 'login', 'audit']);
/** 디스크 점검을 함께 하지 않은 까닭. */
export const AUDIT_SKIPS = Object.freeze(['off', 'login', 'cred', 'key']);
export const PREP_FILE_RE = /^\.dvc-fm-prep\.[0-9a-f]{16}\.sh$/;
/** 넣을 공개키(이 노드의 집중 모니터링 키) — 종류 · 블롭 · 주석 글자만. */
export const PUBKEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) ([A-Za-z0-9+/]{40,}={0,3})(?: ([A-Za-z0-9@._:+-]{1,100}))?$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_RE = /^[0-9a-fA-F:]{2,39}$/;
/** from= 에 넣을 수 있는 주소인가(정규 IPv4 · IPv6 — 그 밖의 글자는 넣지 않는다). */
export const fromIpOk = (ip) => typeof ip === 'string' && (IPV4_RE.test(ip) || (ip.includes(':') && IPV6_RE.test(ip)));
/**
 * 권한 확인 + 이 접속의 SSH_CONNECTION(대상 서버가 본 노드 주소 · 포트 · 서버 주소 · 포트). 상수.
 * v3.18.0 반증 D1: sshd 설정은 **이 주소 · 포트로** 판정한다(Match Address · LocalAddress · LocalPort 안의 Allow/Deny 를 놓치지 않게) —
 * 같은 노드가 같은 길로 수집하러 오므로 이 접속의 값이 수집 접속의 값이다(추정 — 노드에 주소가 여럿이고 길마다 다르면 다를 수 있다).
 */
export const PREP_PRIV_COMMAND = `${PRIV_COMMAND}; echo "##DP conn $SSH_CONNECTION"`;
const portOk = (p) => /^\d{1,5}$/.test(String(p)) && Number(p) >= 1 && Number(p) <= 65535;
/** SSH_CONNECTION 값 → { caddr, laddr, lport } (검사를 지난 것만 — 아니면 null). */
export function connOf(text) {
  const m = /^##DP conn (\S{1,45}) (\d{1,5}) (\S{1,45}) (\d{1,5})\s*$/m.exec(String(text || ''));
  if (!m || !fromIpOk(m[1]) || !fromIpOk(m[3]) || !portOk(m[2]) || !portOk(m[4])) return null;
  return { caddr: m[1], laddr: m[3], lport: Number(m[4]) };
}

/** 넣을 한 줄 — restrict(+ from=) + 종류 + 블롭 + 주석. 규칙 밖이면 null. */
export function keyLineFor(pub, { from = null } = {}) {
  const m = PUBKEY_RE.exec(String(pub || '').trim());
  if (!m) return null;
  if (from != null && !fromIpOk(from)) return null;
  return { line: `${from ? `restrict,from="${from}"` : 'restrict'} ${m[1]} ${m[2]} ${m[3] || 'dvc-focusmon'}`, blob: m[2], type: m[1] };
}

/**
 * 준비 파일(대상 서버에서 root 로 한 번 · 인자 = 수집 계정 하나). 공개키 줄 · 만료 설정은 파일 안에 고정한다.
 * @param {{line:string, blob:string}} key  keyLineFor 의 결과(검사를 지난 값)
 * @param {{age?:'never'|'default'}} o
 */
export function prepScript(key, { age = 'never', conn = null } = {}) {
  if (!key || typeof key.line !== 'string' || typeof key.blob !== 'string' || /['\n\\]/.test(key.line) || !/^[A-Za-z0-9+/=]+$/.test(key.blob)) throw new Error('공개키 줄이 규칙에 맞지 않습니다');
  if (!conn || !fromIpOk(conn.caddr) || !fromIpOk(conn.laddr) || !portOk(conn.lport)) throw new Error('접속 주소 · 포트가 규칙에 맞지 않습니다');
  const fail = (code, rc) => `{ echo '##DP fail ${code}'; exit ${rc}; }`;
  const ageLine = age === 'default' ? '  : # 만료: 서버 기본값(포탈은 바꾸지 않는다)' : "  chage -M 99999 -E -1 -I -1 \"$A\" >/dev/null 2>&1 || echo '##DP warn chage'";
  return `#!/bin/sh
# 서버 집중 모니터링 — 접속 준비(수집 계정 · 공개키) 파일 · 포탈이 대상 서버에서 root 로 한 번 돌린다(v3.18.0)
# 하는 일: sshd 설정 읽기(바꾸지 않음) → 수집 계정이 없으면 만들기(비밀번호 칸 '*'${age === 'default' ? '' : ' · 만료 없음'}) → 그 계정 권한으로 공개키 한 줄 넣기
PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH
umask 022
if [ "$#" -ne 1 ]; then ${fail('args', 64)}; fi
A="$1"
case "$A" in [A-Za-z_]*) ;; *) ${fail('args', 64)} ;; esac
case "$A" in *[!A-Za-z0-9._-]*) ${fail('args', 64)} ;; esac
[ "\${#A}" -le 32 ] || ${fail('args', 64)}
if [ "$(id -u)" != 0 ]; then ${fail('not-root', 77)}; fi
if [ "$A" = root ]; then ${fail('acct-root', 65)}; fi
KEYLINE='${key.line}'
BLOB='${key.blob}'
CADDR='${conn.caddr}'
LADDR='${conn.laddr}'
LPORT='${Number(conn.lport)}'
echo '##DP step sshd'
SSHD=$(command -v sshd 2>/dev/null || true)
[ -n "$SSHD" ] || { [ -x /usr/sbin/sshd ] && SSHD=/usr/sbin/sshd; }
[ -n "$SSHD" ] || ${fail('sshd-missing', 70)}
T=$("$SSHD" -T -C "user=$A,host=$CADDR,addr=$CADDR,laddr=$LADDR,lport=$LPORT" 2>/dev/null) || ${fail('sshd-unread', 70)}
[ -n "$T" ] || ${fail('sshd-unread', 70)}
printf '%s\\n' "$T" | grep -qix 'pubkeyauthentication yes' || ${fail('sshd-pubkey', 71)}
AK=$(printf '%s\\n' "$T" | awk 'tolower($1)=="authorizedkeysfile"{ $1=""; print; exit }')
case " $AK " in *' .ssh/authorized_keys '*|*' %h/.ssh/authorized_keys '*) ;; *) ${fail('sshd-akfile', 71)} ;; esac
if printf '%s\\n' "$T" | grep -qiE '^(allowgroups|denygroups) '; then ${fail('sshd-groups', 71)}; fi
AM=$(printf '%s\\n' "$T" | awk 'tolower($1)=="authenticationmethods"{ $1=""; print; exit }')
case " $AM " in *' any '*|*' publickey '*|'  ') ;; *) ${fail('sshd-authmethods', 71)} ;; esac
set -f
for p in $(printf '%s\\n' "$T" | awk 'tolower($1)=="denyusers"{ for (i = 2; i <= NF; i++) print $i }'); do
  case "$p" in *[,!]*) ${fail('sshd-deny', 71)} ;; esac
  u="\${p%%@*}"
  case "$A" in $u) ${fail('sshd-deny', 71)} ;; esac
done
AU=$(printf '%s\\n' "$T" | awk 'tolower($1)=="allowusers"{ for (i = 2; i <= NF; i++) print $i }')
if [ -n "$AU" ]; then
  ok=0
  for p in $AU; do
    case "$p" in *[,!@]*) continue ;; esac
    case "$A" in $p) ok=1 ;; esac
  done
  [ "$ok" = 1 ] || ${fail('sshd-allow', 71)}
fi
set +f
RU=$(command -v runuser 2>/dev/null || true)
[ -n "$RU" ] || ${fail('no-runuser', 69)}
echo '##DP step acct'
if E=$(getent passwd "$A"); then
  U=$(printf '%s' "$E" | cut -d: -f3); SH=$(printf '%s' "$E" | cut -d: -f7)
  [ "$U" = 0 ] && ${fail('acct-root', 65)}
  case "$SH" in */nologin|*/false|'') ${fail('acct-shell', 66)} ;; esac
  # 반증 D4: 이미 sudo 로 모든 명령을 할 수 있는 계정에는 넣지 않는다(집중 모니터링 키가 root 와 같은 힘이 된다 — 디스크 점검 실행 파일 한 줄 같은 좁은 허용은 괜찮다)
  G=$(id -Gn "$A" 2>/dev/null || true)
  case " $G " in *' wheel '*|*' sudo '*|*' admin '*) ${fail('acct-sudo', 66)} ;; esac
  if command -v sudo >/dev/null 2>&1; then
    SL=$(sudo -n -l -U "$A" 2>/dev/null || true)
    if printf '%s\\n' "$SL" | grep -Eq '(^|[[:space:],:])ALL[[:space:]]*$'; then ${fail('acct-sudo', 66)}; fi
  fi
  echo '##DP exists'
else
  S=/bin/bash; [ -x "$S" ] || S=/bin/sh
  if ! useradd -m -s "$S" "$A" >/dev/null 2>&1; then
    getent passwd "$A" >/dev/null 2>&1 && echo '##DP partial'
    ${fail('acct-create', 66)}
  fi
  usermod -p '*' "$A" >/dev/null 2>&1 || echo '##DP warn passwd'
${ageLine}
  echo '##DP created'
  E=$(getent passwd "$A") || ${fail('acct-create', 66)}
  U=$(printf '%s' "$E" | cut -d: -f3)
  [ "$U" = 0 ] && ${fail('acct-root', 65)}
fi
D=$(printf '%s' "$E" | cut -d: -f6)
case "$D" in /*) ;; *) ${fail('acct-home', 66)} ;; esac
case "$D" in *[!A-Za-z0-9._/-]*) ${fail('acct-home', 66)} ;; esac
if [ ! -d "$D" ] || [ -L "$D" ]; then ${fail('acct-home', 66)}; fi
echo '##DP step key'
W='umask 077; cd "$1" || exit 81; if [ -L .ssh ]; then exit 82; fi; [ -d .ssh ] || mkdir .ssh || exit 83; F=.ssh/authorized_keys; if [ -L "$F" ]; then exit 82; fi; if [ -f "$F" ] && grep -qxF -- "$2" "$F"; then echo "##DP have"; elif [ -f "$F" ] && grep -qF -- "$3" "$F"; then echo "##DP differs"; else if [ -s "$F" ] && [ -n "$(tail -c 1 "$F")" ]; then echo >> "$F" || exit 84; fi; printf "%s\\n" "$2" >> "$F" || exit 84; echo "##DP added"; fi; chmod 700 .ssh && chmod 600 "$F" || exit 84'
"$RU" -u "$A" -- /bin/sh -c "$W" dvcprep "$D" "$KEYLINE" "$BLOB"
R=$?
case "$R" in 0) ;; 81) ${fail('acct-home', 66)} ;; 82) ${fail('key-symlink', 73)} ;; *) ${fail('key-write', 74)} ;; esac
command -v restorecon >/dev/null 2>&1 && restorecon -R "$D/.ssh" >/dev/null 2>&1
M=$(stat -c '%a' "$D" 2>/dev/null || echo '')
case "$M" in *[2367]?|*[2367]) echo '##DP warn home-perm' ;; esac
echo '##DP ok'
`;
}

/** 준비 실행 명령 — 값은 수집 계정 이름(ACCT_RE) · 파일 이름(난수 — PREP_FILE_RE)뿐. 같은 명령 끝에서 올린 파일을 지운다. */
export function prepCommand({ sudo, file, acct }) {
  if (!PREP_FILE_RE.test(file) || !ACCT_RE.test(acct)) throw new Error('준비 명령 값이 규칙에 맞지 않습니다');
  return `${sudo ? 'sudo -n ' : ''}/bin/sh "$HOME/${file}" ${acct}; echo "##DP rc $?"; rm -f "$HOME/${file}"`;
}
export function prepCleanupCommand(file) {
  if (!PREP_FILE_RE.test(file)) throw new Error('준비 파일 이름이 규칙에 맞지 않습니다');
  return `rm -f "$HOME/${file}"`;
}

/** 준비 파일 출력 → 표지만(순수 — 시험 고정). */
export function parsePrepOut(text) {
  const out = { steps: [], fail: null, ok: false, rc: null, created: false, exists: false, added: false, have: false, differs: false, partial: false, warn: [] };
  for (const raw of String(text || '').split('\n').slice(0, 200)) {
    const l = raw.trim();
    if (!l.startsWith('##DP ')) continue;
    const [, k, v] = l.split(' ');
    if (k === 'step' && ['sshd', 'acct', 'key'].includes(v) && !out.steps.includes(v)) out.steps.push(v);
    else if (k === 'fail' && out.fail == null) out.fail = PREP_FAILS.includes(v) ? v : 'other';
    else if (k === 'ok' && v === undefined) out.ok = true;
    else if (k === 'rc' && /^\d{1,3}$/.test(v || '')) out.rc = Number(v);
    else if (k === 'created' && v === undefined) out.created = true;
    else if (k === 'exists' && v === undefined) out.exists = true;
    else if (k === 'added' && v === undefined) out.added = true;
    else if (k === 'have' && v === undefined) out.have = true;
    else if (k === 'differs' && v === undefined) out.differs = true;
    else if (k === 'partial' && v === undefined) out.partial = true;
    else if (k === 'warn' && ['home-perm', 'passwd', 'chage'].includes(v) && !out.warn.includes(v)) out.warn.push(v);
  }
  return out;
}
const stepOfPrep = (p) => (p.ok ? 6 : p.steps.includes('key') ? 5 : p.steps.includes('acct') ? 4 : 3);
/** 권한 확인 출력 → 권한 · 출발 주소(검사를 지난 것만). */
export function parsePrivOut(text) {
  const s = String(text || '');
  const m = /##DI priv (root|sudo|tty|no)\b/.exec(s);
  const conn = connOf(s);
  return { priv: m ? m[1] : 'no', from: conn ? conn.caddr : null, conn };
}

/**
 * 한 서버 준비.
 * @param {{id, name, host, port, username, demo?}} t  집중 모니터링 대상(username = 수집 계정)
 * @param {{keys, connect?, expect:{from?:boolean, age?:'never'|'default', audit?:boolean, program, dir, oldDirs, pick, edge, edgeVcs?, corpVcs?}, credOf?, onPhase?, timeoutMs?, now?, test?}} o
 *   keys = 이 노드의 집중 모니터링 키(공개키를 넣고 · 연결 시험에 쓴다)
 * @returns {Promise<object>}  { mode:'prep', ok, kind, error, prep:{…}, login, install, auditSkip, ready, dir, ms }
 */
export async function prepOnce(t, { keys, connect = withSsh, expect = {}, credOf = installCredFor, onPhase = () => {}, timeoutMs = PREP_TIMEOUT_MS, now = () => Date.now(), test = testTarget } = {}) {
  const t0 = now();
  const wantFrom = expect?.from === true; const age = expect?.age === 'default' ? 'default' : 'never'; const wantAudit = expect?.audit === true;
  const dir = typeof expect?.dir === 'string' ? expect.dir : '';
  const res = (code, extra = {}, more = {}) => ({ mode: 'prep', ok: code === 'ok', kind: code === 'ok' ? 'done' : 'not-ready', error: '', ready: [], dir, ms: now() - t0, login: null, install: null, auditSkip: wantAudit ? null : 'off',
    prep: { code, fail: null, step: 0, rc: null, acct: '', key: '', src: null, cred: null, priv: null, created: false, exists: false, added: false, have: false, warn: [], from: false, ...extra }, ...more });
  const acct = String(t?.username || '');
  if (!ACCT_RE.test(acct)) return res('bad-acct');
  if (acct === 'root') return res('acct-root');
  const ph = (p) => { try { onPhase(p); } catch { /* */ } };
  // 다음 단계(연결 시험 → 고르면 디스크 점검 설치) — 데모 · 실제 공용
  const after = async (prep, cred, { testFn = test, demo = false } = {}) => {
    ph('키 로그인 확인');
    const login = await Promise.resolve().then(() => testFn(t, { keys, connect })).catch(() => ({ ok: false, kind: 'unreachable', error: '연결 시험을 하지 못했습니다.' }));
    const base = { ...res(login?.ok ? 'ok' : 'login', { ...prep, step: login?.ok ? 7 : 6 }), login };
    if (!wantAudit) return base;
    if (!login?.ok) return { ...base, auditSkip: 'login' };
    // 디스크 점검 함께: 같은 키가 ‘설치’ 도 직접 켰을 때만(컨펌 ⑩ — 하나만 켠 키는 준비까지만)
    if (!demo) {
      const ic = credOf(t, { edge: !!expect?.edge, corpVcs: credVcs(), pick: expect?.pick || null, withAuth: false, feature: INSTALL_FEATURE });
      if (!ic || ic.state !== 'ok') return { ...base, auditSkip: 'cred' };
      if (!ic.keyId || !cred?.keyId || ic.keyId !== cred.keyId) return { ...base, auditSkip: 'key' };
    }
    ph('디스크 점검 프로그램 설치');
    const r = await installOnce(t, { keys, connect, credOf, onPhase: ph, now, expect: { program: expect?.program, dir, oldDirs: expect?.oldDirs || [], pick: expect?.pick || null, edge: !!expect?.edge, edgeVcs: expect?.edgeVcs, corpVcs: expect?.corpVcs } })
      .catch(() => null);
    if (!r) return { ...base, auditSkip: 'cred' };
    return { ...base, install: r.install, ready: r.ready || [], dir: r.dir ?? dir };
  };
  // 엣지: 법인 = 그 엣지 스냅샷의 vCenter 들(edgeVcs — 중앙이 보낸 값이 아니다)
  const credVcs = () => (expect?.edge ? (typeof expect.edgeVcs === 'function' ? expect.edgeVcs() : []) : (Array.isArray(expect?.corpVcs) ? expect.corpVcs : []));
  if (t.demo || isDemoTarget(t.id)) {
    ph('준비');
    const n = Number(String(t.id).replace(/\D/g, '').slice(-2)) || 0;
    // 데모 — 장비에 닿지 않는다(연결 시험도 데모 값 · 디스크 점검은 installOnce 의 데모 길)
    return after({ step: 6, acct: 'dvcadmin', key: 'demo-common', src: 'corp', priv: 'sudo', created: n % 2 === 0, exists: n % 2 === 1, added: true, from: wantFrom }, { keyId: 'demo' },
      { testFn: async () => ({ ok: true, kind: 'ok', hello: demoHello(t.id), ms: 12 }), demo: true });
  }
  const info = keys?.keyInfo?.() || null;
  const kl0 = keyLineFor(info?.publicKey || '');
  if (!info?.usable || !kl0) return res('no-key');
  const cred = credOf(t, { edge: !!expect?.edge, corpVcs: credVcs(), pick: expect?.pick || null, withAuth: true, feature: PREP_FEATURE });
  if (!cred || cred.state !== 'ok' || !cred.auth) return res('cred', { cred: cred?.state || 'error', acct: cred?.acct || '', key: cred?.key || '', src: cred?.src || null });
  const who = { acct: cred.acct, key: cred.key, src: cred.src };
  // 반증 D4: 수집 계정이 준비 계정 자신이면 넣지 않는다(root 로 갈 수 있는 계정에 집중 모니터링 키를 주게 된다)
  if (String(cred.auth.username || '') === acct) return res('acct-prep', { step: 1, ...who });
  const fp = cred.auth.fingerprint || '';
  if (keyStopped(fp, now())) return res('key-stopped', { step: 1, ...who });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs); timer.unref?.();
  const file = `.dvc-fm-prep.${crypto.randomBytes(8).toString('hex')}.sh`;
  let step = 1; let priv = null; let parsed = null; let execTimedOut = false; let connBad = false;
  try {
    ph('접속');
    await connect({ host: t.host, port: t.port, username: cred.auth.username, privateKey: cred.auth.privateKey, passphrase: cred.auth.passphrase || undefined, readyTimeout: READY_TIMEOUT_MS, signal: ctl.signal }, async (api) => {
      step = 2; ph('권한 확인');
      const pr = await api.exec(PREP_PRIV_COMMAND, PREP_PRIV_MS);
      const pv = parsePrivOut(pr.stdout);
      priv = pv.priv;
      if (priv === 'no' || priv === 'tty') return {};
      // 반증 D1: sshd 판정 · 주소 제한은 이 접속의 SSH_CONNECTION 으로 — 모르면 아무것도 올리지 않는다
      if (!pv.conn) { connBad = true; return {}; }
      const kl = keyLineFor(info.publicKey, { from: wantFrom ? pv.conn.caddr : null });
      const text = prepScript(kl, { age, conn: pv.conn });
      step = 3; ph('준비 파일 올림');
      try { await within(api.writeFile(file, text, 0o600), PREP_UPLOAD_MS, '파일 올림'); } catch (e) {
        parsed = { upload: String(e?.message || e).slice(0, 80) };
        await api.exec(prepCleanupCommand(file), PREP_CLEANUP_MS).catch(() => null);
        return {};
      }
      ph('계정 · 공개키');
      let r;
      try { r = await api.exec(prepCommand({ sudo: priv === 'sudo', file, acct }), PREP_EXEC_MS); } catch (e) {
        execTimedOut = /타임아웃/.test(String(e?.message || ''));
        await api.exec(prepCleanupCommand(file), PREP_CLEANUP_MS).catch(() => null);
        throw e;
      }
      parsed = parsePrepOut(r.stdout);
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
  if (connBad) return res('conn-unknown', { step: 2, priv, ...who });
  if (parsed?.upload) return res('upload', { step: 3, priv, ...who });
  // 반증 D2: 주소 제한은 이번에 그 줄을 넣었을 때만 '적용' — 같은 키가 다른 옵션으로 있으면(differs) 그대로 두고 알린다
  const prep = { step: parsed ? stepOfPrep(parsed) : 3, fail: parsed?.fail || null, rc: parsed?.rc ?? null, priv, created: !!parsed?.created, exists: !!parsed?.exists, added: !!parsed?.added, have: !!parsed?.have,
    differs: !!parsed?.differs, partial: !!parsed?.partial, warn: parsed?.warn || [], from: wantFrom && !!parsed?.added, ...who };
  if (!parsed?.ok) return res(parsed?.fail ? 'script' : 'script-other', prep);
  // 반증 D3: 사람이(OTP) 누른 준비로 키가 들어갔다 — 그 대상 · 이 노드 키의 인증 정지를 한 번 푼다('다시 연결' 과 같은 판단 · 시험은 한 번만)
  try { focusAuthGuard.clearAuthStop(authDevOf(t, info.fingerprint).id, { verified: false }); } catch { /* 정지 기록을 못 지워도 시험이 'auth-stopped' 로 알린다 */ }
  return after(prep, cred);
}

/** 준비 결과 → 작업 결과 모양(runner.createAuditRunner 의 exec 자리 — 노드마다 줄 하나 · 동시 NODE_INSTALL_CONCURRENCY). */
export function prepExec(credOpts = {}) {
  return (target, o) => prepOnce(target, { ...o, expect: { ...(o.expect || {}), ...credOpts } });
}
