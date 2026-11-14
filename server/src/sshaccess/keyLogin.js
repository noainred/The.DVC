/**
 * sshaccess/keyLogin.js — **키 로그인 설정**(서버의 `~/.ssh/authorized_keys` 에 공개키 한 줄 넣기) · **키 거두기**(포탈이 넣은 줄 지우기)
 * (v3.10.0 · 설계 docs/design/ssh-access §4 · §8 · 시안 ③ SshKey · ⑤ SshSec ‘긴급 조치’).
 *
 * 이 저장소에서 **서버의 파일을 바꾸는 유일한 SSH 동작**이다. 그래서 좁게 만든다:
 *  · 바꾸는 파일은 접속 계정의 `~/.ssh/authorized_keys` 하나. sshd 설정 · sudoers · 남이 넣은 줄은 건드리지 않는다.
 *  · 넣는 줄은 **표식**(`portal-ssh:<키 id>`)을 달고, 지우는 것은 ‘그 키의 공개키 + 그 표식’ 이 함께 있는 줄뿐이다(사람이 직접 넣은 같은 키 줄은 남긴다 — 수를 알려 준다).
 *  · 명령은 고정 틀 + 엄격히 검사한 글자(공개키 base64 · 키 id · 서버가 본 접속 주소)만 끼운다. 사용자 입력 · 서버 이름 · 키 이름은 명령에 들어가지 않는다.
 *  · 순서 = 지금 되는 접속(저장 비밀번호 · 이미 되는 키 · 이번 한 번만 넣은 비밀번호)으로 붙어 줄을 더함 → **끊고 그 키로 다시 접속해 확인** → 안 되면 더한 줄을 지움.
 *    비밀번호가 틀리면 다시 시도하지 않는다(계정 잠금). 줄이 이미 있었으면(우리가 더하지 않았으면) 되돌릴 것이 없다 — 지우지 않는다.
 *  · 서버 쪽 제한(보호 장치 — 기본 켬): `from="<서버가 본 이 포탈 주소>"` + 포워딩 금지 세 가지. 제한 때문에 키 접속이 안 되면 줄을 지우고 사유를 적는다 —
 *    **자동으로 제한을 빼고 다시 넣지 않는다**(사람이 고른다).
 *  · 엣지가 수집하는 서버는 중앙에서 하지 않는다(키는 그 엣지에 있다).
 *  · 1회 비밀번호는 이 작업의 메모리에만 있다 — 파일 · 로그 · 응답 · 작업 기록 어디에도 남기지 않는다.
 * 등록부 쓰기(키를 서버에 묶기 · 저장 비밀번호 지우기)는 여기서 하지 않는다 — `service.js` 가 넘겨 준 함수로만 한다(소스 스윕: 묶는 쓰기를 부르는 곳은 service 하나).
 */
import crypto from 'node:crypto';
import * as REFS from '../bmusage/onboard/refs.js';
import * as INS from './installed.js';
import { noteKeyUse } from './usage.js';
import { PORTAL_MARK, READ_COMMAND, parseReadOutput } from './authorizedKeys.js';

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
export const MAX_JOB_SERVERS = 100;
const STEP_TIMEOUT_MS = 20_000;
const JOB_KEEP_MS = 3600_000;

/* ── 줄 · 명령 만들기(순수 — 테스트가 실제 bash 로 돌린다) ─────────────────────── */

const TYPE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/;
const BLOB_RE = /^[A-Za-z0-9+/]{40,4096}={0,2}$/;
const KEYID_RE = /^k_[0-9a-f]{6,24}$/;
/** 서버가 본 접속 주소(`$SSH_CONNECTION` 첫 칸) — IPv4 또는 IPv6 글자만. 그 밖은 from= 에 쓰지 않는다. */
const IP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f:]{2,45})$/;
export const RESTRICT_OPTIONS = Object.freeze(['no-agent-forwarding', 'no-port-forwarding', 'no-X11-forwarding']);

/** 공개키 글 → { type, blob }. 꼴이 아니면 null. */
export function splitPublicKey(publicKey) {
  const parts = String(publicKey || '').trim().split(/\s+/);
  if (parts.length < 2 || !TYPE_RE.test(parts[0]) || !BLOB_RE.test(parts[1])) return null;
  return { type: parts[0], blob: parts[1] };
}
export const markOf = (keyId) => (KEYID_RE.test(String(keyId || '')) ? `${PORTAL_MARK}${keyId}` : '');

/**
 * authorized_keys 에 넣을 한 줄. 끼우는 글자는 전부 위 정규식을 통과한 것뿐이다(작은따옴표 · 줄바꿈 · 역슬래시가 들어갈 수 없다).
 * @returns {string|null} 꼴이 맞지 않으면 null(호출부가 거절)
 */
export function buildKeyLine({ publicKey, keyId, restrict = false, fromIp = '' } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark) return null;
  const opts = [];
  if (restrict) {
    if (fromIp) { if (!IP_RE.test(fromIp)) return null; opts.push(`from="${fromIp}"`); }
    opts.push(...RESTRICT_OPTIONS);
  }
  return `${opts.length ? `${opts.join(',')} ` : ''}${pk.type} ${pk.blob} ${mark}`;
}
const safeForSingleQuote = (s) => typeof s === 'string' && s.length > 0 && s.length < 8192 && !/['\\\r\n\0]/.test(s);

/** 서버가 본 이 접속의 출발지 주소를 묻는다(from= 에 쓴다). */
export const WHOAMI_COMMAND = 'echo "##KL ip ${SSH_CONNECTION%% *}"';

/**
 * 줄을 더하는 명령. 이미 있으면 더하지 않는다. 결과는 표지 한 줄:
 *   `##KL added` · `##KL present-marked`(포탈 줄이 이미 있음) · `##KL present-unmarked`(표식 없는 같은 키 줄이 있음) · `##KL fail <사유>`
 * authorized_keys 가 심볼릭 링크이거나 일반 파일이 아니면 건드리지 않는다. 폴더 · 파일을 새로 만들 때만 권한(0700 · 0600 — umask) · SELinux 문맥(restorecon — 있을 때)을 맞춘다.
 */
export function installCommand({ publicKey, keyId, line } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark || !safeForSingleQuote(line) || !line.includes(pk.blob) || !line.endsWith(mark)) return null;
  return [
    'umask 077',
    'd="$HOME/.ssh"; f="$d/authorized_keys"; mkd=""; mkf=""',
    'if [ ! -d "$d" ]; then mkdir -p "$d" || { echo "##KL fail mkdir"; exit 3; }; mkd=1; fi',
    'if [ -L "$f" ]; then echo "##KL fail symlink"; exit 3; fi',
    'if [ ! -e "$f" ]; then : > "$f" || { echo "##KL fail create"; exit 3; }; mkf=1; fi',
    'if [ ! -f "$f" ]; then echo "##KL fail notfile"; exit 3; fi',
    `if grep -F -- '${pk.blob}' "$f" | grep -qF -- '${mark}'; then echo "##KL present-marked"`,
    `elif grep -qF -- '${pk.blob}' "$f"; then echo "##KL present-unmarked"`,
    'else',
    '  if [ -s "$f" ] && [ -n "$(tail -c 1 "$f")" ]; then printf "\\n" >> "$f" || { echo "##KL fail append"; exit 3; }; fi',
    `  printf '%s\\n' '${line}' >> "$f" || { echo "##KL fail append"; exit 3; }`,
    '  if command -v restorecon >/dev/null 2>&1; then',
    '    if [ -n "$mkd" ]; then restorecon -F "$d" >/dev/null 2>&1 || true; fi',
    '    if [ -n "$mkf" ]; then restorecon -F "$f" >/dev/null 2>&1 || true; fi',
    '  fi',
    '  echo "##KL added"',
    'fi',
  ].join('\n');
}

/**
 * 그 키의 **포탈 줄**(공개키 + 표식이 함께 있는 줄)만 지우는 명령. 결과 표지: `##KL removed <지운 수> unmarked <표식 없는 같은 키 줄 수>` · `##KL none`(파일 없음) · `##KL fail <사유>`.
 * 파일은 자리에서 다시 쓴다(inode · 권한 · SELinux 문맥 유지 — 임시 파일에 먼저 만들고 내용만 옮긴다).
 */
export function removeCommand({ publicKey, keyId } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark) return null;
  return [
    'umask 077',
    'f="$HOME/.ssh/authorized_keys"',
    'if [ -L "$f" ] || [ ! -f "$f" ]; then echo "##KL none"; exit 0; fi',
    `n=$(grep -F -- '${pk.blob}' "$f" | grep -cF -- '${mark}')`,
    `u=$(grep -F -- '${pk.blob}' "$f" | grep -vcF -- '${mark}')`,
    'if [ "${n:-0}" -gt 0 ]; then',
    '  tmp="$f.portal.$$"',
    `  awk -v b='${pk.blob}' -v m='${mark}' 'index($0, b) > 0 && index($0, m) > 0 { next } { print }' "$f" > "$tmp" && cat "$tmp" > "$f"; rc=$?`,
    '  rm -f "$tmp"',
    '  if [ "$rc" -ne 0 ]; then echo "##KL fail rewrite"; exit 3; fi',
    'fi',
    'echo "##KL removed ${n:-0} unmarked ${u:-0}"',
  ].join('\n');
}

/** 표지 줄 읽기(마지막 `##KL …` 한 줄 — 로그인 배너가 앞에 섞여도). */
export function parseMarker(stdout) {
  const lines = String(stdout || '').slice(0, 65536).split('\n').map((x) => x.trim()).filter((x) => x.startsWith('##KL '));
  const last = lines[lines.length - 1] || '';
  const w = last.split(' ');
  if (w[1] === 'ip') return { kind: 'ip', ip: IP_RE.test(w[2] || '') ? w[2] : '' };
  if (w[1] === 'added' || w[1] === 'present-marked' || w[1] === 'present-unmarked' || w[1] === 'none') return { kind: w[1] };
  if (w[1] === 'removed') return { kind: 'removed', removed: Number(w[2]) || 0, unmarked: Number(w[4]) || 0 };
  if (w[1] === 'fail') return { kind: 'fail', why: t(w[2], 20) };
  return { kind: 'unknown' };
}

const FAIL_TEXT = Object.freeze({
  mkdir: '~/.ssh 폴더를 만들지 못했습니다.', create: 'authorized_keys 를 만들지 못했습니다.', symlink: 'authorized_keys 가 심볼릭 링크라 건드리지 않았습니다.',
  notfile: 'authorized_keys 가 일반 파일이 아니라 건드리지 않았습니다.', append: 'authorized_keys 에 쓰지 못했습니다(권한 · 디스크).', rewrite: 'authorized_keys 를 다시 쓰지 못했습니다.',
});

/* ── 접속(한 번 · 재시도 없음) ────────────────────────────────────────────── */

async function sshRun(server, auth, fn) {
  const { withSsh } = await import('../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../util/authGuard.js');
  try {
    const v = await withSsh({ host: String(server.host), port: Number(server.port) || 22, username: auth.username, password: auth.password || '',
      privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: 15_000 }, async ({ exec }) => fn(exec));
    return { ok: true, value: v };
  } catch (e) {
    const msg = String(e?.message || e);
    const code = isPeerRejectText(msg) ? 'hostkey' : isAuthFailureText(msg) ? 'auth-rejected' : 'connect';
    return { ok: false, code, reason: code === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
      : code === 'auth-rejected' ? '인증이 거부됐습니다 — 다시 시도하지 않았습니다(계정 잠금 방지).' : `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})` };
  }
}

/** 지금 되는 접속(첫 접속에 쓴다) — 1회 비밀번호가 있으면 그것, 없으면 저장된 자격. */
function firstLegAuth(server, oncePassword) {
  if (oncePassword) {
    const r0 = REFS.resolveOsAuth({ ...server, keyRef: '', osAuth: 'password' }, { feature: 'conn-test' });
    return { ok: true, username: r0.ok ? r0.username : (t(server.username) || 'root'), password: oncePassword, authKind: 'password-once' };
  }
  const r = REFS.resolveOsAuth(server, { feature: 'conn-test' });
  if (!r.ok) return { ok: false, code: r.code, reason: r.error };
  if (r.authKind === 'none') return { ok: false, code: 'no-secret', reason: '저장된 인증 수단이 없습니다 — 이번 한 번만 쓸 비밀번호를 넣으세요(저장하지 않습니다).' };
  return r;
}
/** 그 키로 붙는 자격(사용 중지 · 폴더 · 바꿔치기 · 승인 대기 규칙이 그대로 적용된다). */
const keyLegAuth = (server, keyId) => REFS.resolveOsAuth({ ...server, keyRef: keyId, osAuth: '' }, { feature: 'conn-test' });

/**
 * 서버 한 대에 키 로그인을 설정한다.
 * @param {object} server  OS 등록부 원본
 * @param {object} key     키 저장소 원본(활성)
 * @param {{oncePassword?:string, restrict?:boolean, removePassword?:boolean, replaceKey?:object|null, by?:string,
 *          bind:(server:object, keyId:string)=>object, clearPassword:(server:object)=>object}} o
 * @returns {Promise<object>} { ok, code, reason, line:'added'|'present-marked'|'present-unmarked'|'', rolledBack?, bound?, passwordRemoved?, oldRemoved?, restricted?, fromIp? }
 */
export async function installOne(server, key, o = {}) {
  const base = { id: server.id, name: server.name || server.host, corp: t(server.vcenterId) };
  const fail = (code, reason, extra = {}) => ({ ...base, ok: false, code, reason, ...extra });
  if (t(server.agent)) return fail('edge-delegated', '엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 설정합니다(키는 법인 밖으로 나가지 않습니다).');
  if (!key || key.status !== 'active') return fail(key?.status === 'pending' ? 'key-pending' : 'key-retired', key?.status === 'pending' ? REFS.AUTH_ERROR['key-pending'] : '퇴역한 키는 넣지 않습니다.');
  const pi = REFS.keyPlacementIssue(key, server, 'conn-test');
  if (pi) return fail(pi, REFS.AUTH_ERROR[pi]);
  const first = firstLegAuth(server, o.oncePassword);
  if (!first.ok) return fail(first.code, first.reason);
  // 그 키 자격을 먼저 푼다 — 여기서 막히면(사용 중지 · 바꿔치기) 서버를 건드리기 전에 끝낸다.
  const kAuth = keyLegAuth(server, key.id);
  if (!kAuth.ok) return fail(kAuth.code, kAuth.error);

  // ① 지금 되는 접속으로 붙어 줄을 더한다(같은 세션에서 출발지 주소 → 줄 더하기).
  let fromIp = ''; let line = '';
  const step1 = await sshRun(server, first, async (exec) => {
    if (o.restrict) {
      const w = parseMarker((await exec(WHOAMI_COMMAND, STEP_TIMEOUT_MS))?.stdout);
      fromIp = w.kind === 'ip' ? w.ip : '';
      if (!fromIp) return { kind: 'fail', why: 'noip' };
    }
    line = buildKeyLine({ publicKey: key.publicKey, keyId: key.id, restrict: !!o.restrict, fromIp });
    const cmd = line ? installCommand({ publicKey: key.publicKey, keyId: key.id, line }) : null;
    if (!cmd) return { kind: 'fail', why: 'badkey' };
    return parseMarker((await exec(cmd, STEP_TIMEOUT_MS))?.stdout);
  });
  if (!step1.ok) return fail(step1.code, `${step1.reason} 서버에서 바꾼 것은 없습니다.`);
  const m = step1.value;
  if (m.kind === 'fail' || m.kind === 'unknown') {
    const why = m.why === 'noip' ? '서버가 본 접속 주소를 읽지 못해 출발지 제한을 붙일 수 없습니다 — 제한 없이 넣으려면 ‘서버 쪽 제한’ 을 끄고 다시 하세요.'
      : m.why === 'badkey' ? '공개키 꼴이 올바르지 않아 넣지 않았습니다.' : (FAIL_TEXT[m.why] || '서버가 예상한 답을 주지 않았습니다(셸이 제한된 계정일 수 있습니다).');
    return fail('install-failed', `${why} 서버에서 바꾼 것은 없습니다.`);
  }
  const added = m.kind === 'added';

  // ② 끊고 그 키로 다시 접속해 확인한다.
  const step2 = await sshRun(server, kAuth, async (exec) => {
    const u = await exec('uname -s', STEP_TIMEOUT_MS);
    let read = null;
    try { read = parseReadOutput((await exec(READ_COMMAND, STEP_TIMEOUT_MS))?.stdout || ''); } catch { read = null; }
    return { uname: t(u?.stdout, 40), read };
  });
  noteKeyUse({ fingerprint: key.fingerprint, keyName: key.name, server: base.name, corp: base.corp, feature: 'conn-test', ok: step2.ok, code: step2.ok ? 'ok' : step2.code, trigger: 'manual', by: o.by });
  if (!step2.ok) {
    // ③ 안 되면 더한 줄을 지운다(우리가 더했을 때만 — 이미 있던 줄은 손대지 않는다).
    let rolledBack = null; let rollbackReason = '';
    if (added) {
      const rb = await sshRun(server, first, async (exec) => parseMarker((await exec(removeCommand({ publicKey: key.publicKey, keyId: key.id }), STEP_TIMEOUT_MS))?.stdout));
      rolledBack = rb.ok && rb.value.kind === 'removed' && rb.value.removed > 0;
      if (!rolledBack) rollbackReason = rb.ok ? '서버가 예상한 답을 주지 않았습니다' : rb.reason;
    }
    const hint = o.restrict && fromIp ? ` 출발지 제한(from="${fromIp}") 때문일 수 있습니다 — 이 포탈이 서버에 닿는 주소가 접속마다 다르면 ‘서버 쪽 제한’ 을 끄고 다시 하세요(자동으로 빼지 않습니다).` : '';
    const tail = !added ? ' 줄은 이미 있던 것이라 지우지 않았습니다.' : rolledBack ? ' 더한 줄을 지웠습니다.' : ` 더한 줄을 지우지 못했습니다(${rollbackReason}) — 서버의 authorized_keys 에서 표식 ‘${markOf(key.id)}’ 줄을 직접 지우세요.`;
    return fail('key-login-failed', `키 접속 확인 실패 — ${step2.reason}${tail}${hint}`, { line: m.kind, rolledBack, fromIp });
  }

  // ④ 확인됨 — 서버를 그 키에 묶고(등록부), 고른 뒷일을 한다.
  const out = { ...base, ok: true, code: 'ok', line: m.kind, restricted: !!o.restrict && added, fromIp: added ? fromIp : '', bound: false, passwordRemoved: false };
  if (step2.value?.read?.ok) INS.noteInstalled(server.id, { host: server.host, port: Number(server.port) || 22, username: kAuth.username, file: '~/.ssh/authorized_keys', keys: step2.value.read.keys, truncated: step2.value.read.truncated, by: t(o.by, 64) });
  const b = t(server.keyRef) === key.id && server.osAuth !== 'password' ? { ok: true, already: true } : o.bind(server, key.id);
  if (!b.ok) return { ...out, ok: false, code: 'bind-failed', reason: `키 접속은 확인됐지만 서버 설정에 적지 못했습니다(${t(b.reason, 120)}) — 서버의 키 줄은 남아 있습니다. ‘키 고르기’ 로 이 키를 고르세요.` };
  out.bound = true;
  if (o.removePassword) { const c = o.clearPassword(server); out.passwordRemoved = !!c.ok; if (!c.ok) out.note = `저장 비밀번호를 지우지 못했습니다(${t(c.reason, 100)}).`; }
  if (o.replaceKey && o.replaceKey.id !== key.id) {
    const cmd = removeCommand({ publicKey: o.replaceKey.publicKey, keyId: o.replaceKey.id });
    const rm = cmd ? await sshRun(server, kAuth, async (exec) => parseMarker((await exec(cmd, STEP_TIMEOUT_MS))?.stdout)) : { ok: false, reason: '옛 키의 공개키 꼴이 올바르지 않습니다' };
    out.oldRemoved = rm.ok && rm.value.kind === 'removed' ? rm.value.removed : null;
    out.oldUnmarked = rm.ok && rm.value.kind === 'removed' ? rm.value.unmarked : null;
    if (out.oldRemoved == null) out.note = `${out.note ? `${out.note} ` : ''}옛 키 줄을 지우지 못했습니다(${rm.ok ? '서버가 예상한 답을 주지 않았습니다' : rm.reason}).`;
  }
  return out;
}

/**
 * 서버 한 대에서 그 키의 포탈 줄을 지운다(긴급 조치 · 교체 뒤 정리).
 * @returns {Promise<object>} { ok, code, removed, unmarked, reason?, pinned? }
 */
export async function revokeOne(server, key, o = {}) {
  const base = { id: server.id, name: server.name || server.host, corp: t(server.vcenterId) };
  if (t(server.agent)) return { ...base, ok: false, code: 'edge-delegated', reason: '엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 거둡니다.' };
  const cmd = removeCommand({ publicKey: key?.publicKey, keyId: key?.id });
  if (!cmd) return { ...base, ok: false, code: 'bad-key', reason: '키의 공개키 꼴이 올바르지 않습니다.' };
  const auth = firstLegAuth(server, o.oncePassword);
  if (!auth.ok) {
    const more = auth.code === 'corp-stopped' ? ' 법인 키 사용 중지 중에는 키로 접속하지 않습니다 — 이번 한 번만 쓸 비밀번호를 넣거나 서버에서 직접 지우세요.' : '';
    return { ...base, ok: false, code: auth.code, reason: `${auth.reason}${more}` };
  }
  const r = await sshRun(server, auth, async (exec) => parseMarker((await exec(cmd, STEP_TIMEOUT_MS))?.stdout));
  if (auth.keyFingerprint) noteKeyUse({ fingerprint: auth.keyFingerprint, keyName: auth.keyName, server: base.name, corp: base.corp, feature: 'conn-test', ok: r.ok, code: r.ok ? 'ok' : r.code, trigger: 'manual', by: o.by });
  if (!r.ok) return { ...base, ok: false, code: r.code, reason: r.reason };
  const m = r.value;
  if (m.kind === 'none') return { ...base, ok: true, code: 'none', removed: 0, unmarked: 0 };
  if (m.kind !== 'removed') return { ...base, ok: false, code: 'revoke-failed', reason: FAIL_TEXT[m.why] || '서버가 예상한 답을 주지 않았습니다.' };
  return { ...base, ok: true, code: m.removed > 0 ? 'removed' : 'not-present', removed: m.removed, unmarked: m.unmarked, pinned: t(server.keyRef) === key.id };
}

/* ── 작업(여러 서버 — 1대씩 차례로 · 화면은 진행을 물어 본다) ────────────────── */

const jobs = new Map();
let running = null;
function sweep(now) { for (const [id, j] of jobs) if (j.doneAt && now - j.doneAt > JOB_KEEP_MS) jobs.delete(id); }
export function _resetKeyLoginJobsForTest() { jobs.clear(); running = null; }

/**
 * 작업을 시작한다(한 번에 하나). `run(server)` 를 서버마다 차례로 부른다 — 한 대의 예외는 그 서버의 실패로 적고 다음으로 간다.
 * @returns {{ok:true, jobId:string} | {ok:false, code:'busy'|'too-many'|'empty', status:number, reason:string}}
 */
export function startJob({ kind, servers, run, by = '', meta = {} } = {}, { now = Date.now() } = {}) {
  sweep(now);
  const cur = running ? jobs.get(running) : null;   // 기록이 이미 정리된 작업은 끝난 것이다(없는 작업 때문에 ‘진행 중’ 으로 잠기지 않게)
  if (cur && !cur.doneAt) return { ok: false, code: 'busy', status: 409, reason: '다른 키 작업이 진행 중입니다 — 끝난 뒤 다시 하세요.' };
  if (!Array.isArray(servers) || !servers.length) return { ok: false, code: 'empty', status: 400, reason: '대상 서버가 없습니다.' };
  if (servers.length > MAX_JOB_SERVERS) return { ok: false, code: 'too-many', status: 400, reason: `한 번에 ${MAX_JOB_SERVERS}대까지입니다 — 나눠서 하세요.` };
  const id = `kj_${crypto.randomBytes(6).toString('hex')}`;
  const job = { id, kind, by: t(by, 64), meta, startedAt: now, doneAt: 0, total: servers.length, results: [], current: '' };
  jobs.set(id, job); running = id;
  (async () => {
    for (const s of servers) {
      job.current = s.name || s.host;
      let r;
      try { r = await run(s); } catch (e) { r = { id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'error', reason: `처리 중 오류(${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 100)})` }; }
      job.results.push(r);
    }
    job.current = ''; job.doneAt = Date.now();
  })();
  return { ok: true, jobId: id };
}
/** 진행 · 결과(비밀 없음). 없으면 null. */
export function jobView(id) {
  const j = jobs.get(t(id, 20));
  if (!j) return null;
  return { id: j.id, kind: j.kind, by: j.by, meta: j.meta, startedAt: j.startedAt, doneAt: j.doneAt || null, running: !j.doneAt, total: j.total, done: j.results.length, current: j.current, results: j.results.map((r) => ({ ...r })) };
}
