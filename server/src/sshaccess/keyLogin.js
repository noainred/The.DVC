/**
 * sshaccess/keyLogin.js — **키 로그인 설정**(서버의 `~/.ssh/authorized_keys` 에 공개키 한 줄 넣기) · **키 거두기**(포탈이 넣은 줄 지우기)
 * (v3.10.0 · 설계 docs/design/ssh-access §4 · §8 · 시안 ③ SshKey · ⑤ SshSec ‘긴급 조치’).
 *
 * 이 저장소에서 **서버의 파일을 바꾸는 유일한 SSH 동작**이다. 그래서 좁게 만든다:
 *  · 바꾸는 파일은 접속 계정의 `~/.ssh/authorized_keys` 하나. sshd 설정 · sudoers · 남이 넣은 줄은 건드리지 않는다.
 *  · 원격 스크립트는 `akScript.js`(순수) — 임시 파일에 다 쓰고 검증한 뒤 한 번에 바꾼다 · 심볼릭 링크 · 못 읽음은 실패로 말한다 ·
 *    관리자가 옵션을 바꾼 포탈 줄은 건드리지 않는다 · 되돌림은 우리 줄만(사본 파일 없음). 상세는 그 파일 머리말.
 *  · 순서 = 지금 되는 접속(저장 비밀번호 · 이미 되는 키 · 이번 한 번만 넣은 비밀번호)으로 붙어 줄을 더함 → **끊고 그 키로 다시 접속해 확인** → 안 되면 더한 줄을 지움.
 *    비밀번호가 틀리면 다시 시도하지 않는다(계정 잠금 — password 방식으로 한 번만). 줄이 이미 있었으면(우리가 더하지 않았으면) 되돌릴 것이 없다 — 지우지 않는다.
 *  · 서버 쪽 제한(보호 장치 — 기본 켬): `from="<서버가 본 이 포탈 주소>"` + 포워딩 금지 세 가지. 제한 때문에 키 접속이 안 되면 줄을 지우고 사유를 적는다 —
 *    **자동으로 제한을 빼고 다시 넣지 않는다**(사람이 고른다). 제한 없이 들어가 있던 포탈 줄을 제한 줄로 바꾸는 것(다시 넣기)은 **첫 접속이 그 키가 아닐 때만** —
 *    그 키로 붙어 그 줄을 바꾸면 확인이 실패했을 때 되돌릴 길이 없다(점검 B-F5).
 *  · 접속 한 번마다 시한이 있고 넘기면 세션을 실제로 끊는다(withDeadline). 바꾸는 명령을 보낸 뒤 답을 못 받으면 ‘바뀌었을 수 있음’ 으로 말한다 —
 *    ‘바꾼 것 없음’ 이라고 하지 않는다(서버의 명령은 끊겨도 끝까지 돌 수 있다 · 점검 B-F3).
 *  · 엣지가 수집하는 서버는 중앙에서 하지 않는다(키는 그 엣지에 있다).
 *  · 1회 비밀번호는 이 작업의 메모리에만 있다 — 파일 · 로그 · 응답 · 작업 기록 어디에도 남기지 않는다.
 *  · 작업은 종류마다 하나(넣기 · 거두기) — 긴급 거두기가 진행 중인 넣기 작업에 막히지 않는다(점검 B-F8). 같은 서버는 한 번에 한 작업만 만진다(서버 자물쇠).
 *    같은 키의 넣기 작업이 돌고 있으면 거두기가 그 작업을 멈춘다(지금 서버를 끝낸 뒤 — 거둔 키를 뒤 서버에 다시 넣지 않게).
 * 등록부 쓰기(키를 서버에 묶기 · 저장 비밀번호 지우기)는 여기서 하지 않는다 — `service.js` 가 넘겨 준 함수로만 한다(소스 스윕: 묶는 쓰기를 부르는 곳은 service 하나).
 */
import crypto from 'node:crypto';
import * as REFS from '../bmusage/onboard/refs.js';
import * as KS from '../bmusage/onboard/keyStore.js';
import * as INS from './installed.js';
import { noteKeyUse } from './usage.js';
import { READ_COMMAND, parseReadOutput } from './authorizedKeys.js';
import * as AK from './akScript.js';

export { RESTRICT_OPTIONS, splitPublicKey, markOf, buildKeyLine, parseMarker, failText } from './akScript.js';

const t = (v, max = 256) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max).trim();
export const MAX_JOB_SERVERS = 100;
/** 법인 단위 거두기(긴급 조치)의 상한 — 넘는 서버는 호출부가 ‘over-limit’ 으로 밝힌다(점검 C-1). 닿지 않는 서버도 접속 1회 시한 안에 끝난다. */
export const MAX_REVOKE_SERVERS = 500;
export const STEP_TIMEOUT_MS = 20_000;
export const READY_TIMEOUT_MS = 15_000;
/** 접속 한 번(세션)의 시한 — 준비 + exec 수 × exec 시한 + 여유 5초. 넘기면 세션을 끊는다(테스트가 산수를 고정). */
export const legDeadlineMs = (execs) => READY_TIMEOUT_MS + Math.max(1, execs) * STEP_TIMEOUT_MS + 5_000;
const JOB_KEEP_MS = 3600_000;

/* ── 원격 명령(akScript 의 스크립트를 /bin/sh 한 줄로 싼 것 — 테스트가 실제 셸로 돌린다) ── */
export const WHOAMI_COMMAND = AK.wrapSh(AK.WHOAMI_SCRIPT);
const wrapOrNull = (s) => (s ? AK.wrapSh(s) : null);
export const installCommand = (o) => wrapOrNull(AK.installScript(o));
export const removeCommand = (o) => wrapOrNull(AK.removeScript(o));
export const rollbackCommand = (o) => wrapOrNull(AK.rollbackScript(o));

/* ── 접속(한 번 · 재시도 없음 · 시한) ─────────────────────────────────────── */

const TIMEOUT_RE = /타임아웃|시한 초과|취소|timed? ?out/i;
/**
 * @param {Function} fn  (run) => 결과. run(cmd, mutating) — mutating 이면 ‘바꾸는 명령을 보냈다’ 표시를 세운다(답을 못 받았을 때 문구가 갈린다).
 * @returns {Promise<{ok:true, value:object} | {ok:false, code:string, reason:string, sent:boolean}>}
 */
async function sshRun(server, auth, fn, { execs = 1 } = {}) {
  const { withSsh, withDeadline } = await import('../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../util/authGuard.js');
  const st = { sent: false };
  try {
    // passwordOnly: 비밀번호는 password 방식으로 **한 번만** 보낸다(keyboard-interactive 로 다시 보내지 않는다 — 실패 기록 2회 · 계정 잠금 · 테스트 ⑪-b · 구형 알고리즘 재시도 포함).
    const v = await withDeadline(legDeadlineMs(execs), (signal) => withSsh({ host: String(server.host), port: Number(server.port) || 22, username: auth.username, password: auth.password || '',
      privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: READY_TIMEOUT_MS, passwordOnly: true, signal },
    async ({ exec }) => fn(async (cmd, mutating = false) => { if (mutating) st.sent = true; return exec(cmd, STEP_TIMEOUT_MS); })), 'SSH 시한 초과');
    return { ok: true, value: v };
  } catch (e) {
    const msg = String(e?.message || e);
    const code = isPeerRejectText(msg) ? 'hostkey' : isAuthFailureText(msg) ? 'auth-rejected' : TIMEOUT_RE.test(msg) ? 'timeout' : 'connect';
    const reason = code === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
      : code === 'auth-rejected' ? `인증이 거부됐습니다 — 다시 시도하지 않았습니다(계정 잠금 방지).${auth.privateKey ? '' : ' 비밀번호는 password 방식으로 한 번만 보냈습니다 — 서버가 대화형(keyboard-interactive) 로그인만 받으면 이 경로로는 넣을 수 없으니 공개키를 직접 넣으세요(키 폴더의 공개키 복사).'}`
        : code === 'timeout' ? `서버가 시한 안에 답하지 않았습니다(${msg.replace(/\s+/g, ' ').slice(0, 80)})`
          : `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})`;
    return { ok: false, code, reason, sent: st.sent };
  }
}
/** 바꾸는 명령을 보낸 뒤 답을 못 받았을 때 — ‘바꾼 것 없음’ 이라고 하지 않는다. */
const UNCERTAIN_TAIL = ' 바꾸는 명령은 서버에 보냈지만 결과를 받지 못했습니다 — 서버의 authorized_keys 가 바뀌었을 수 있습니다. ‘서버에 들어 있는 키 다시 읽기’ 로 확인하세요(포탈의 서버 설정은 바꾸지 않았습니다).';

/** 지금 되는 접속(첫 접속에 쓴다) — 1회 비밀번호가 있으면 그것, 없으면 저장된 자격. */
function firstLegAuth(server, oncePassword, installingKeyId = '') {
  if (oncePassword) {
    const r0 = REFS.resolveOsAuth({ ...server, keyRef: '', osAuth: 'password' }, { feature: 'conn-test' });
    return { ok: true, username: r0.ok ? r0.username : (t(server.username) || 'root'), password: oncePassword, authKind: 'password-once' };
  }
  const r = REFS.resolveOsAuth(server, { feature: 'conn-test' });
  // 서버에 설정된 키가 **지금 넣으려는 그 키** 면(공통 계정의 기본 키로 정해 두고 서버에 넣는 흐름) 그 키는 아직 서버에 없을 수 있다 —
  //   저장된 비밀번호가 있으면 그것으로 붙는다(키를 먼저 대 보고 안 되면 비밀번호로 — 처럼 두 번 시도하지 않는다 · 웹 점검 W1).
  if (r.ok && r.authKind === 'key' && installingKeyId && r.keyId === installingKeyId) {
    const pw = REFS.resolveOsAuth({ ...server, keyRef: '', osAuth: 'password' }, { feature: 'conn-test' });
    if (pw.ok && pw.authKind === 'password' && pw.password) return pw;
  }
  if (!r.ok) return { ok: false, code: r.code, reason: r.error };
  if (r.authKind === 'none') return { ok: false, code: 'no-secret', reason: '저장된 인증 수단이 없습니다 — 이번 한 번만 쓸 비밀번호를 넣으세요(저장하지 않습니다).' };
  return r;
}
/** 그 키로 붙는 자격(사용 중지 · 폴더 · 바꿔치기 · 승인 대기 규칙이 그대로 적용된다). */
const keyLegAuth = (server, keyId) => REFS.resolveOsAuth({ ...server, keyRef: keyId, osAuth: '' }, { feature: 'conn-test' });

/** 이 서버가 지금 그 키로 접속하도록 설정돼 있나 — 이름 고정(keyRef) 또는 공통 계정의 기본 키를 따름(점검 B-F9 · installOne 의 ‘다시 묶지 않음’ 과 같은 식). */
export function serverUsesKey(server, keyId) {
  if (!server || !keyId || server.osAuth === 'password') return false;
  if (t(server.keyRef)) return t(server.keyRef) === keyId;
  const acc = t(server.credRef) ? KS.accountById(server.credRef) : null;
  return !!acc && t(acc.keyRef) === keyId;
}

const restrictText = (fromIp) => ` 출발지 제한(from="${fromIp}") 때문일 수 있습니다 — 이 포탈이 서버에 닿는 주소가 접속마다 다르면 ‘서버 쪽 제한’ 을 끄고 다시 하세요(자동으로 빼지 않습니다).`;

/**
 * 서버 한 대에 키 로그인을 설정한다.
 * @param {object} server  OS 등록부 원본
 * @param {object} key     키 저장소 원본(활성)
 * @param {{oncePassword?:string, restrict?:boolean, removePassword?:boolean, replaceKey?:object|null, by?:string,
 *          bind:(server:object, keyId:string)=>object, clearPassword:(server:object)=>object}} o
 * @returns {Promise<object>} { ok, code, reason, line:'added'|'replaced'|'present-marked'|'present-unmarked'|'', rolledBack?, bound?, passwordRemoved?, oldRemoved?,
 *   restricted?, fromIp?, unmarked?, custom?, replaceSkipped?, notes?:string[] }
 */
export async function installOne(server, key, o = {}) {
  const base = { id: server.id, name: server.name || server.host, corp: t(server.vcenterId) };
  const fail = (code, reason, extra = {}) => ({ ...base, ok: false, code, reason, ...extra });
  if (t(server.agent)) return fail('edge-delegated', '엣지가 수집하는 서버입니다 — 그 엣지 포탈에서 설정합니다(키는 법인 밖으로 나가지 않습니다).');
  if (!key || key.status !== 'active') return fail(key?.status === 'pending' ? 'key-pending' : 'key-retired', key?.status === 'pending' ? REFS.AUTH_ERROR['key-pending'] : '퇴역한 키는 넣지 않습니다.');
  const pi = REFS.keyPlacementIssue(key, server, 'conn-test');
  if (pi) return fail(pi, REFS.AUTH_ERROR[pi]);
  const first = firstLegAuth(server, o.oncePassword, key.id);
  if (!first.ok) return fail(first.code, first.reason);
  // 그 키 자격을 먼저 푼다 — 여기서 막히면(사용 중지 · 바꿔치기) 서버를 건드리기 전에 끝낸다.
  const kAuth = keyLegAuth(server, key.id);
  if (!kAuth.ok) return fail(kAuth.code, kAuth.error);
  // 첫 접속이 바로 그 키면 그 키의 포탈 줄을 바꾸지 않는다(확인이 실패하면 되돌릴 접속이 없다 — 점검 B-F5).
  const firstIsKey = first.authKind === 'key' && first.keyId === key.id;
  const allowReplace = !!o.restrict && !firstIsKey;

  // ① 지금 되는 접속으로 붙어 줄을 더한다(같은 세션에서 출발지 주소 → 줄 더하기).
  let fromIp = ''; let line = '';
  const step1 = await sshRun(server, first, async (run) => {
    if (o.restrict) {
      const w = AK.parseMarker((await run(WHOAMI_COMMAND))?.stdout);
      if (w.kind !== 'ip') return { kind: 'unknown' };   // 표지가 아예 없음 — 명령을 받지 않는 셸(주소 문제가 아니다 · 테스트 ⑫-c)
      fromIp = w.ip;
      if (!fromIp) return { kind: 'fail', why: 'noip' };
    }
    line = AK.buildKeyLine({ publicKey: key.publicKey, keyId: key.id, restrict: !!o.restrict, fromIp }) || '';
    const cmd = line ? installCommand({ publicKey: key.publicKey, keyId: key.id, line, replace: allowReplace }) : null;
    if (!cmd) return { kind: 'fail', why: 'badkey' };
    return AK.parseMarker((await run(cmd, true))?.stdout);
  }, { execs: o.restrict ? 2 : 1 });
  if (!step1.ok) return fail(step1.sent ? 'uncertain' : step1.code, `${step1.reason}${step1.sent ? UNCERTAIN_TAIL : ' 서버에서 바꾼 것은 없습니다.'}`);
  const m = step1.value;
  if (m.kind === 'fail' || m.kind === 'unknown') {
    const why = m.why === 'noip' ? '서버가 본 접속 주소를 읽지 못해 출발지 제한을 붙일 수 없습니다 — 제한 없이 넣으려면 ‘서버 쪽 제한’ 을 끄고 다시 하세요.'
      : m.why === 'badkey' ? '공개키 꼴이 올바르지 않아 넣지 않았습니다.'
        : m.kind === 'unknown' ? '서버가 예상한 답을 주지 않았습니다(셸이 제한된 계정이거나 base64 · awk 가 없는 서버일 수 있습니다).' : AK.failText(m.why);
    return fail('install-failed', `${why} 서버에서 바꾼 것은 없습니다.`);
  }
  const added = m.kind === 'added';
  const replaced = m.kind === 'replaced';
  const notes = [];
  if (m.unmarked > 0) notes.push(`표식 없는 같은 키 줄 ${m.unmarked}개가 서버에 있습니다(사람이 넣은 줄 — 포탈은 건드리지 않습니다)${o.restrict ? ' — 그 줄은 출발지 제한이 없으니 서버에서 직접 정리하세요' : ''}.`);
  if (m.custom > 0) notes.push(`관리자가 옵션을 바꾼 포탈 줄 ${m.custom}개는 그대로 두었습니다(제한을 다시 넣지 않았습니다).`);
  const replaceSkipped = m.kind === 'present-marked' && !!o.restrict && firstIsKey && m.loose > 0;
  if (replaceSkipped) notes.push('제한 없는 포탈 줄이 있지만 지금 그 키로만 접속돼 제한 줄로 바꾸지 않았습니다(확인이 실패하면 되돌릴 길이 없습니다) — 이번 한 번만 쓸 비밀번호를 넣고 다시 하면 바꿉니다.');

  // ② 끊고 그 키로 다시 접속해 확인한다.
  const step2 = await sshRun(server, kAuth, async (run) => {
    const u = await run('uname -s');
    let read = null;
    try { read = parseReadOutput((await run(READ_COMMAND))?.stdout || ''); } catch { read = null; }
    return { uname: t(u?.stdout, 40), read };
  }, { execs: 2 });
  noteKeyUse({ fingerprint: key.fingerprint, keyName: key.name, server: base.name, corp: base.corp, feature: 'conn-test', ok: step2.ok, code: step2.ok ? 'ok' : step2.code, trigger: 'manual', by: o.by });
  if (!step2.ok) {
    // ③ 안 되면 우리가 바꾼 것만 되돌린다(더한 그 줄을 지우고, 바꿨으면 바꾸기 전 포탈 줄을 다시 넣는다). 이미 있던 줄은 손대지 않는다.
    let rolledBack = null; let rollbackReason = '';
    if (added || replaced) {
      const cmd = replaced && m.old == null ? null : rollbackCommand({ line, oldB64: replaced ? m.old : '' });
      const rb = cmd ? await sshRun(server, first, async (run) => AK.parseMarker((await run(cmd, true))?.stdout)) : { ok: false, reason: '바꾸기 전 줄을 받지 못했습니다' };
      rolledBack = rb.ok && rb.value.kind === 'restored' && rb.value.removed > 0;
      if (!rolledBack) rollbackReason = !rb.ok ? `${rb.reason}${rb.sent ? ' — 되돌림 명령의 결과를 받지 못했습니다' : ''}`
        : rb.value.kind === 'restored' ? '그 사이 줄이 이미 바뀌어 있어 손대지 않았습니다' : rb.value.kind === 'fail' ? AK.failText(rb.value.why) : '서버가 예상한 답을 주지 않았습니다';
    }
    const tail = replaced
      ? (rolledBack ? ' 바꾼 줄을 원래대로 되돌렸습니다.' : ` 바꾼 줄을 되돌리지 못했습니다(${rollbackReason}) — 서버의 authorized_keys 에서 표식 ‘${AK.markOf(key.id)}’ 줄을 확인하세요.`)
      : !added ? ' 줄은 이미 있던 것이라 지우지 않았습니다.' : rolledBack ? ' 더한 줄을 지웠습니다.' : ` 더한 줄을 지우지 못했습니다(${rollbackReason}) — 서버의 authorized_keys 에서 표식 ‘${AK.markOf(key.id)}’ 줄을 직접 지우세요.`;
    return fail('key-login-failed', `키 접속 확인 실패 — ${step2.reason}${tail}${o.restrict && fromIp && (added || replaced) ? restrictText(fromIp) : ''}`, { line: m.kind, rolledBack, fromIp, notes });
  }

  // ④ 확인됨 — 서버를 그 키에 묶고(등록부), 고른 뒷일을 한다.
  // 제한이 붙었다 = 이 키의 포탈 줄이 모두 원하는 제한 줄이고, 표식 없는 같은 키 줄도 없다.
  const exactOnly = m.kind === 'present-marked' && m.exact > 0 && !m.loose && !m.custom;
  const restricted = !!o.restrict && (added || replaced || exactOnly) && !m.unmarked && !m.custom;
  const out = { ...base, ok: true, code: 'ok', line: m.kind, restricted, fromIp: added || replaced ? fromIp : '', bound: false, passwordRemoved: false,
    unmarked: m.unmarked || 0, custom: m.custom || 0, replaceSkipped, notes };
  if (step2.value?.read?.ok) INS.noteInstalled(server.id, { host: server.host, port: Number(server.port) || 22, username: kAuth.username, file: '~/.ssh/authorized_keys', keys: step2.value.read.keys, truncated: step2.value.read.truncated, by: t(o.by, 64) });
  // 이미 그 키를 쓰는 서버는 다시 묶지 않는다 — 특히 ‘법인 기본 키를 따름’ 인 서버를 이름 고정으로 바꾸지 않는다(법인 기본 키를 바꾸면 따라가야 한다).
  const b = serverUsesKey(server, key.id) ? { ok: true, already: true } : o.bind(server, key.id);
  if (!b.ok) return { ...out, ok: false, code: 'bind-failed', reason: `키 접속은 확인됐지만 서버 설정에 적지 못했습니다(${t(b.reason, 120)}) — 서버의 키 줄은 남아 있습니다. ‘키 고르기’ 로 이 키를 고르세요.` };
  out.bound = true;
  // 저장 비밀번호 지우기 — 서버 항목에 저장된 비밀번호가 있을 때만(공통 계정의 비밀번호는 다른 서버도 쓰므로 여기서 지우지 않는다).
  if (o.removePassword) {
    if (!server.password) out.passwordRemoved = null;   // 지울 것이 없다(공통 계정을 쓰거나 처음부터 없음)
    else { const c = o.clearPassword(server); out.passwordRemoved = !!c.ok; if (!c.ok) notes.push(`저장 비밀번호를 지우지 못했습니다(${t(c.reason, 100)}).`); }
  }
  if (o.replaceKey && o.replaceKey.id !== key.id) {
    const cmd = removeCommand({ publicKey: o.replaceKey.publicKey, keyId: o.replaceKey.id });
    const rm = cmd ? await sshRun(server, kAuth, async (run) => AK.parseMarker((await run(cmd, true))?.stdout)) : { ok: false, reason: '옛 키의 공개키 꼴이 올바르지 않습니다' };
    out.oldRemoved = rm.ok && rm.value.kind === 'removed' ? rm.value.removed : rm.ok && rm.value.kind === 'none' ? 0 : null;
    out.oldUnmarked = rm.ok && rm.value.kind === 'removed' ? rm.value.unmarked : null;
    if (out.oldRemoved == null) notes.push(`옛 키 줄을 지우지 못했습니다(${!rm.ok ? `${rm.reason}${rm.sent ? ' — 결과를 받지 못했습니다' : ''}` : rm.value.kind === 'fail' ? AK.failText(rm.value.why) : '서버가 예상한 답을 주지 않았습니다'}).`);
  }
  if (notes.length) out.note = notes.join(' ');
  return out;
}

/**
 * 서버 한 대에서 그 키의 포탈 줄을 지운다(긴급 조치 · 교체 뒤 정리).
 * 심볼릭 링크 · 못 읽음 · 쓰지 못함은 **실패**(‘없음’ 이 아니다 — 점검 B-F2). 파일이 없을 때만 ‘none’.
 * @returns {Promise<object>} { ok, code:'removed'|'not-present'|'none'|…, removed, unmarked, reason?, pinned? }
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
  const r = await sshRun(server, auth, async (run) => AK.parseMarker((await run(cmd, true))?.stdout));
  if (auth.keyFingerprint) noteKeyUse({ fingerprint: auth.keyFingerprint, keyName: auth.keyName, server: base.name, corp: base.corp, feature: 'conn-test', ok: r.ok, code: r.ok ? 'ok' : r.code, trigger: 'manual', by: o.by });
  const pinned = serverUsesKey(server, key.id);
  if (!r.ok) return { ...base, ok: false, code: r.sent ? 'uncertain' : r.code, reason: `${r.reason}${r.sent ? ' 지우는 명령은 보냈지만 결과를 받지 못했습니다 — 지워졌는지 서버에서 확인하세요.' : ''}`, pinned };
  const m = r.value;
  if (m.kind === 'none') return { ...base, ok: true, code: 'none', removed: 0, unmarked: 0, pinned };
  if (m.kind !== 'removed') return { ...base, ok: false, code: 'revoke-failed', why: m.kind === 'fail' ? m.why : 'unknown', reason: m.kind === 'fail' ? AK.failText(m.why) : '서버가 예상한 답을 주지 않았습니다.', pinned };
  return { ...base, ok: true, code: m.removed > 0 ? 'removed' : 'not-present', removed: m.removed, unmarked: m.unmarked, pinned };
}

/* ── 작업(여러 서버 — 1대씩 차례로 · 화면은 진행을 물어 본다) ────────────────── */

const jobs = new Map();
/** 작업 칸 — 넣기와 거두기는 따로 돈다(긴급 거두기가 넣기에 막히지 않게). */
const SLOT_OF = Object.freeze({ 'key-login': 'install', 'key-revoke': 'revoke' });
const slots = new Map();   // 칸 → 진행 중인 작업 id
const lastBySlot = new Map();   // 칸 → 마지막 작업 id(끝난 것 포함 — 화면이 다시 열려도 결과를 보여 준다 · 점검 E-2)
const serverLocks = new Map();
function sweep(now) { for (const [id, j] of jobs) if (j.doneAt && now - j.doneAt > JOB_KEEP_MS) jobs.delete(id); }
export function _resetKeyLoginJobsForTest() { jobs.clear(); slots.clear(); lastBySlot.clear(); serverLocks.clear(); }

/** 같은 서버는 한 번에 한 작업만 만진다(넣기 · 거두기가 같은 파일을 동시에 바꾸지 않게). */
async function withServerLock(id, fn) {
  const key = String(id);
  const prev = serverLocks.get(key) || Promise.resolve();
  let release; const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  serverLocks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (serverLocks.get(key) === tail) serverLocks.delete(key); }
}

/** 그 종류의 칸에 진행 중인 작업 id(없으면 ''). */
export function busyJob(kind) {
  const slot = SLOT_OF[kind]; const id = slot ? slots.get(slot) : '';
  const j = id ? jobs.get(id) : null;
  return j && !j.doneAt ? j.id : '';
}
/** 작업을 멈춘다(지금 서버는 끝까지 — 되돌림을 끊지 않는다 · 남은 서버는 ‘멈춤’ 으로 적는다). */
export function cancelJob(id, { by = '', why = '' } = {}) {
  const j = jobs.get(t(id, 20));
  if (!j) return { ok: false, code: 'not-found', status: 404, reason: '작업을 찾을 수 없습니다(끝난 지 1시간이 지났을 수 있습니다).' };
  if (j.doneAt) return { ok: false, code: 'done', status: 409, reason: '이미 끝난 작업입니다.' };
  if (!j.cancelled) { j.cancelled = true; j.cancelledBy = t(by, 64); j.cancelWhy = t(why, 120); }
  return { ok: true, jobId: j.id };
}

/**
 * 작업을 시작한다(칸마다 하나). `run(server)` 를 서버마다 차례로 부른다 — 한 대의 예외는 그 서버의 실패로 적고 다음으로 간다.
 * 거두기는 같은 키를 넣는 작업이 돌고 있으면 그 작업을 멈춘다.
 * @param {{kind:'key-login'|'key-revoke', servers:object[], run:Function, by?:string, meta?:object, onDone?:(view:object)=>void}} o
 * @returns {{ok:true, jobId:string, stopped?:string} | {ok:false, code:'busy'|'too-many'|'empty'|'bad-kind', status:number, reason:string}}
 */
export function startJob({ kind, servers, run, by = '', meta = {}, onDone = null } = {}, { now = Date.now() } = {}) {
  sweep(now);
  const slot = SLOT_OF[kind];
  if (!slot) return { ok: false, code: 'bad-kind', status: 400, reason: '모르는 작업입니다.' };
  const cur = slots.has(slot) ? jobs.get(slots.get(slot)) : null;   // 기록이 이미 정리된 작업은 끝난 것이다(없는 작업 때문에 ‘진행 중’ 으로 잠기지 않게)
  if (cur && !cur.doneAt) return { ok: false, code: 'busy', status: 409, jobId: cur.id, reason: slot === 'revoke' ? '다른 키 거두기 작업이 진행 중입니다 — 끝난 뒤 다시 하세요.' : '다른 키 로그인 설정 작업이 진행 중입니다 — 끝나거나 멈춘 뒤 다시 하세요.' };
  if (!Array.isArray(servers) || !servers.length) return { ok: false, code: 'empty', status: 400, reason: '대상 서버가 없습니다.' };
  const max = slot === 'revoke' ? MAX_REVOKE_SERVERS : MAX_JOB_SERVERS;
  if (servers.length > max) return { ok: false, code: 'too-many', status: 400, reason: `한 번에 ${max}대까지입니다 — 나눠서 하세요.` };
  let stopped = '';
  if (slot === 'revoke' && meta?.keyId) {
    const inst = slots.has('install') ? jobs.get(slots.get('install')) : null;
    if (inst && !inst.doneAt && inst.meta?.keyId === meta.keyId) { cancelJob(inst.id, { by, why: '같은 키 거두기가 시작됨' }); stopped = inst.id; }
  }
  const id = `kj_${crypto.randomBytes(6).toString('hex')}`;
  const job = { id, kind, slot, by: t(by, 64), meta, startedAt: now, doneAt: 0, total: servers.length, results: [], current: '', cancelled: false, cancelledBy: '', cancelWhy: '' };
  jobs.set(id, job); slots.set(slot, id); lastBySlot.set(slot, id);
  (async () => {
    for (const s of servers) {
      if (job.cancelled) {
        job.results.push({ id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'cancelled', reason: `작업을 멈춰 이 서버는 하지 않았습니다${job.cancelWhy ? `(${job.cancelWhy})` : ''}.` });
        continue;
      }
      job.current = s.name || s.host;
      let r;
      try { r = await withServerLock(s.id, () => run(s)); } catch (e) { r = { id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'error', reason: `처리 중 오류(${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 100)})` }; }
      job.results.push(r);
    }
    job.current = ''; job.doneAt = Date.now();
    if (slots.get(slot) === id) slots.delete(slot);
    try { onDone?.(jobView(id)); } catch { /* 요약 기록 실패는 작업 결과를 바꾸지 않는다 */ }
  })();
  return { ok: true, jobId: id, ...(stopped ? { stopped } : {}) };
}
/** 진행 · 결과(비밀 없음). 없으면 null. */
export function jobView(id) {
  const j = jobs.get(t(id, 20));
  if (!j) return null;
  return { id: j.id, kind: j.kind, by: j.by, meta: j.meta, startedAt: j.startedAt, doneAt: j.doneAt || null, running: !j.doneAt, total: j.total, done: j.results.length, current: j.current,
    cancelled: j.cancelled, cancelledBy: j.cancelledBy || '', results: j.results.map((r) => ({ ...r, notes: Array.isArray(r.notes) ? [...r.notes] : undefined })) };
}
/** 칸마다 마지막 작업(1시간 안 — 진행 중이면 진행 중인 것). 화면이 다시 열려도 결과를 이어 보여 준다. */
export function lastJobs() {
  const out = {};
  for (const [slot, id] of lastBySlot) { const v = jobView(id); if (v) out[slot] = { id: v.id, kind: v.kind, running: v.running, startedAt: v.startedAt, doneAt: v.doneAt, total: v.total, done: v.done, by: v.by }; }
  return out;
}
