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
/**
 * 시한 경주 — fn 이 시한 안에 끝나지 않으면 던진다(fn 이 signal 을 받지 않는 호출부용 · 2회차 C2-2 키 고르기의 연결 시험).
 * 밑의 접속은 그 호출부의 자체 시한으로 끝난다 — 여기는 서버 자물쇠를 무한정 쥐지 않게 하는 것.
 */
export async function withLegDeadline(execs, fn) {
  let tm;
  const timeout = new Promise((_r, rej) => { tm = setTimeout(() => rej(new Error(`시한 초과(${Math.round(legDeadlineMs(execs) / 1000)}초)`)), legDeadlineMs(execs)); });
  try { return await Promise.race([fn(), timeout]); } finally { clearTimeout(tm); }
}
const JOB_KEEP_MS = 3600_000;

/* ── 원격 명령(akScript 의 스크립트를 /bin/sh 한 줄로 싼 것 — 테스트가 실제 셸로 돌린다) ── */
export const WHOAMI_COMMAND = AK.wrapSh(AK.WHOAMI_SCRIPT);
const wrapOrNull = (s) => (s ? AK.wrapSh(s) : null);
export const installCommand = (o) => wrapOrNull(AK.installScript(o));
export const removeCommand = (o) => wrapOrNull(AK.removeScript(o));
export const rollbackCommand = (o) => wrapOrNull(AK.rollbackScript(o));

/* ── 접속(한 번 · 재시도 없음 · 시한) ─────────────────────────────────────── */

const TIMEOUT_RE = /타임아웃|시한 초과|취소|timed? ?out/i;
const KEY_UNUSABLE_TEXT = '그 키로 접속은 되지만 포탈이 보낸 명령이 돌지 않았습니다(그 키 줄에 강제 명령(command=)이 있는 등) — 이 키로는 수집할 수 없어 묶지 않았습니다.';
/**
 * @param {Function} fn  (run) => 결과. run(cmd, mutating) — mutating 이면 ‘바꾸는 명령을 보냈다’ 표시를 세운다(답을 못 받았을 때 문구가 갈린다).
 * @returns {Promise<{ok:true, value:object} | {ok:false, code:string, reason:string, sent:boolean}>}
 */
async function sshRun(server, auth, fn, { execs = 1 } = {}) {
  const { withSsh, withDeadline } = await import('../proxy/sshExec.js');
  const { isAuthFailureText, isPeerRejectText } = await import('../util/authGuard.js');
  const st = { sent: false };
  try {
    // passwordOnly: 비밀번호는 **한 번만** 보낸다(서버가 받는 방식 하나 — password 우선, 없으면 대화형 · 실패 기록 2회 · 계정 잠금 · 테스트 ⑪-b · 구형 알고리즘 재시도 포함).
    const v = await withDeadline(legDeadlineMs(execs), (signal) => withSsh({ host: String(server.host), port: Number(server.port) || 22, username: auth.username, password: auth.password || '',
      privateKey: auth.privateKey, passphrase: auth.passphrase, readyTimeout: READY_TIMEOUT_MS, passwordOnly: true, signal },
    async ({ exec }) => fn(async (cmd, mutating = false) => { if (mutating) st.sent = true; return exec(cmd, STEP_TIMEOUT_MS); })), 'SSH 시한 초과');
    return { ok: true, value: v };
  } catch (e) {
    const msg = String(e?.message || e);
    if (e?.code === 'key-login-unusable') return { ok: false, code: 'key-login-unusable', reason: KEY_UNUSABLE_TEXT, sent: st.sent };
    const code = e?.code === 'SSH_NO_PASSWORD_METHOD' ? 'no-password-method' : isPeerRejectText(msg) ? 'hostkey' : isAuthFailureText(msg) ? 'auth-rejected' : TIMEOUT_RE.test(msg) ? 'timeout' : 'connect';
    const reason = code === 'no-password-method' ? `${msg.replace(/^SSH_NO_PASSWORD_METHOD:\s*/, '').replace(/\s+/g, ' ').slice(0, 160)} — 이미 되는 키로 접속하게 서버 설정을 고르거나 공개키를 서버에 직접 넣으세요.`
      : code === 'hostkey' ? '호스트키를 신뢰하지 않아 끊었습니다 — 설정 › 보안 › 장비 신뢰에서 지문을 확인 · 승인하세요.'
      : code === 'auth-rejected' ? `인증이 거부됐습니다 — 다시 시도하지 않았습니다(계정 잠금 방지).${auth.privateKey ? '' : ' 비밀번호는 서버가 받는 방식 하나(password 또는 대화형)로 한 번만 보냈습니다.'}`
        : code === 'timeout' ? `서버가 시한 안에 답하지 않았습니다(${msg.replace(/\s+/g, ' ').slice(0, 80)})`
          : `접속하지 못했습니다(${msg.replace(/\s+/g, ' ').slice(0, 100)})`;
    return { ok: false, code, reason, sent: st.sent };
  }
}
/**
 * 바꾸는 명령을 보내고 표지를 읽는다. 표지가 없고 **종료 코드도 없으면**(연결이 끊겨 채널만 닫힘 — exec 는 그래도 resolve 한다) 'nocode' —
 * 명령이 돌았을 수 있다(테스트 ⑫-h). 종료 코드가 있는데 표지가 없으면 셸이 스크립트를 받지 않은 것이다('unknown' — 바뀐 것 없음).
 */
async function mutRun(run, cmd) {
  const r = await run(cmd, true);
  const m = AK.parseMarker(r?.stdout);
  // 시작 표지만 있고 끝 표지가 없다(안쪽 셸만 신호로 죽음 · 표지 잘림 — 1회차 B5) → 결과 모름.
  if (m.kind === 'begun') return { kind: 'nocode' };
  return m.kind === 'unknown' && (r?.code === undefined || r?.code === null) ? { kind: 'nocode' } : m;
}
/** 결과를 모르는(바꿨을 수 있는) 실패 사유 — mv 뒤의 확인 실패. ‘바꾼 것 없음’ 꼬리를 붙이지 않는다(1회차 B9 · E1-3). */
const AFTER_MV = new Set(['raced']);
/** 되돌림 · 지우기 결과가 ‘결과 모름’ 인가(1회차 B11 — 모르는데 ‘지우지 못했다’ 고 단정하지 않는다). */
const unknownOutcome = (r) => (!r.ok && r.sent) || (r.ok && (r.value.kind === 'nocode' || (r.value.kind === 'fail' && AFTER_MV.has(r.value.why))));
/** 바꾸는 명령을 보낸 뒤 답을 못 받았을 때 — ‘바꾼 것 없음’ 이라고 하지 않는다. */
const UNCERTAIN_TAIL = ' 바꾸는 명령은 서버에 보냈지만 결과를 받지 못했습니다 — 서버의 authorized_keys 가 바뀌었을 수 있습니다. ‘서버에 들어 있는 키 다시 읽기’ 로 확인하세요(포탈의 서버 설정은 바꾸지 않았습니다).';

/**
 * 1회 비밀번호를 보낼 계정 이름. 공통 계정을 쓰는 서버인데 그 계정을 확인할 수 없으면(바뀜 · 없음) 이름을 짐작하지 않는다
 * (3회차 C 참고 D-5 — 서버 칸 · root 로 넘어가 엉뚱한 계정에 비밀번호를 보내고 그 계정의 실패 기록을 남겼다).
 */
export function onceUsername(server) {
  const r0 = REFS.resolveOsAuth({ ...server, keyRef: '', osAuth: 'password' }, { feature: 'conn-test' });
  if (r0.ok) return { ok: true, username: r0.username };
  if (t(server.credRef)) return { ok: false, code: r0.code || 'auth-unresolved', reason: `${r0.error || '공통 계정을 확인하지 못했습니다'} — 접속 계정을 정할 수 없어 이번 한 번만 쓸 비밀번호를 보내지 않았습니다.` };
  return { ok: true, username: t(server.username) || 'root' };
}
/** 지금 되는 접속(첫 접속에 쓴다) — 1회 비밀번호가 있으면 그것, 없으면 저장된 자격. */
function firstLegAuth(server, oncePassword, installingKeyId = '') {
  if (oncePassword) {
    const u = onceUsername(server);
    if (!u.ok) return u;
    return { ok: true, username: u.username, password: oncePassword, authKind: 'password-once' };
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
    return mutRun(run, cmd);
  }, { execs: o.restrict ? 2 : 1 });
  // via = 첫 접속에 쓴 인증 방식(작업이 같은 비밀번호의 거부를 세어 멈춘다 — 계정 잠금 · 반증 D3).
  if (!step1.ok) return fail(step1.sent ? 'uncertain' : step1.code, `${step1.reason}${step1.sent ? UNCERTAIN_TAIL : ' 서버에서 바꾼 것은 없습니다.'}`, { via: first.authKind });
  const m = step1.value;
  if (m.kind === 'nocode') return fail('uncertain', `서버가 결과 없이 연결을 닫았습니다.${UNCERTAIN_TAIL}`, { via: first.authKind });
  // raced: 결과는 받았다 — mv 뒤 확인에서 원하는 상태가 아니었다(1회차 반증 12 — ‘결과를 받지 못했습니다’ 꼬리를 붙였다).
  if (m.kind === 'fail' && AFTER_MV.has(m.why)) return fail('uncertain', `${AK.failText(m.why)} 포탈의 서버 설정은 바꾸지 않았습니다.`, { via: first.authKind });
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
  if (m.otherId > 0) notes.push(`같은 공개키를 다른 키 id 로 포탈이 넣은 줄 ${m.otherId}개가 서버에 있습니다(지웠다 다시 등록한 키의 옛 줄 — 이 키를 거두면 함께 지워집니다)${o.restrict ? ' — 그 줄의 제한 여부는 포탈이 판정하지 않습니다' : ''}.`);
  if (m.custom > 0) notes.push(`관리자가 옵션을 바꾼 포탈 줄 ${m.custom}개는 그대로 두었습니다(제한을 다시 넣지 않았습니다 — 그 줄의 제한 여부는 포탈이 판정하지 않습니다).`);
  const replaceSkipped = m.kind === 'present-marked' && !!o.restrict && firstIsKey && m.loose > 0;
  if (replaceSkipped) notes.push('제한 없는 포탈 줄이 있지만 지금 그 키로만 접속돼 제한 줄로 바꾸지 않았습니다(확인이 실패하면 되돌릴 길이 없습니다) — 이번 한 번만 쓸 비밀번호를 넣고 다시 하면 바꿉니다.');

  /** 우리가 바꾼 것만 되돌린다(더한 그 줄을 지우고, 바꿨으면 바꾸기 전 포탈 줄을 다시 넣는다). 이미 있던 줄은 손대지 않는다. → { rolledBack, tail } */
  const rollbackChange = async () => {
    let rolledBack = null; let rollbackReason = ''; let unknown = false;
    if (added || replaced) {
      const cmd = replaced && m.old == null ? null : rollbackCommand({ line, oldB64: replaced ? m.old : '' });
      // 되돌림도 그 차례에 자격을 다시 푼다 — 그 사이 법인 사용 중지가 걸렸으면 키로 접속하지 않는다(3회차 C3-1).
      const fa = first.authKind === 'key' ? firstLegAuth(server, o.oncePassword, key.id) : first;
      const rb = !fa.ok ? { ok: false, reason: `${fa.reason || fa.error || '접속 자격을 풀지 못함'} — 되돌리려고 접속하지 않았습니다` }
        : cmd ? await sshRun(server, fa, async (run) => mutRun(run, cmd)) : { ok: false, reason: '바꾸기 전 줄을 받지 못했습니다' };
      rolledBack = rb.ok && rb.value.kind === 'restored' && rb.value.removed > 0;
      unknown = !rolledBack && unknownOutcome(rb);
      if (!rolledBack) rollbackReason = !rb.ok ? `${rb.reason}${rb.sent ? ' — 되돌림 명령의 결과를 받지 못했습니다' : ''}`
        : rb.value.kind === 'restored' ? '그 사이 줄이 이미 바뀌어 있어 손대지 않았습니다' : rb.value.kind === 'fail' ? AK.failText(rb.value.why)
          : rb.value.kind === 'nocode' ? '되돌림 명령의 결과를 받지 못했습니다(연결 끊김)' : '서버가 예상한 답을 주지 않았습니다';
    }
    const what = replaced ? '바꾼 줄을 원래대로 되돌렸' : '더한 줄을 지웠';
    const tail = !added && !replaced ? ' 줄은 이미 있던 것이라 지우지 않았습니다.'
      : rolledBack ? ` ${what}습니다.`
        : unknown ? ` ${replaced ? '바꾼 줄을 되돌렸는지' : '더한 줄이 지워졌는지'} 모릅니다(${rollbackReason}) — 서버의 authorized_keys 에서 표식 ‘${AK.markOf(key.id)}’ 줄을 확인하세요.`
          : ` ${replaced ? '바꾼 줄을 되돌리지' : '더한 줄을 지우지'} 못했습니다(${rollbackReason}) — 서버의 authorized_keys 에서 표식 ‘${AK.markOf(key.id)}’ 줄을 ${replaced ? '확인하세요' : '직접 지우세요'}.`;
    return { rolledBack, rollbackUnknown: unknown || undefined, tail };
  };
  // 확인 직전에 그 키 자격을 다시 푼다 — 줄을 넣는 사이 법인 사용 중지 · 바꿔치기가 걸렸으면 그 키로 접속하지 않고 넣은 줄을 되돌린다(3회차 C3-1 — 중지 뒤에도 그 키로 확인 · 묶기 · 옛 키 지우기를 했다).
  const kAuthNow = keyLegAuth(server, key.id);
  if (!kAuthNow.ok) {
    const rb = await rollbackChange();
    return fail(kAuthNow.code, `${kAuthNow.error} — 그 키로 확인하지 않았습니다.${rb.tail}`, { line: m.kind, rolledBack: rb.rolledBack, rollbackUnknown: rb.rollbackUnknown, fromIp, notes });
  }
  // ② 끊고 그 키로 다시 접속해 확인한다.
  // 출력도 본다(2회차 B6 — 강제 명령(command=) 줄이면 exec 는 성공하지만 우리 명령은 돌지 않는다: 그런 키에 서버를 묶고 저장 비밀번호까지 지웠다).
  //   이번 접속에만 쓰는 글자(nonce)를 되돌려 받아야 ‘명령을 돌릴 수 있는 키’ 다 — 로그인 메시지가 섞여도 그 줄을 찾는다(셸과 무관하게 /bin/sh 로 싼다).
  const nonce = crypto.randomBytes(6).toString('hex');
  const step2 = await sshRun(server, kAuthNow, async (run) => {
    const u = await run(AK.wrapSh(`echo "##KLV ${nonce} $(uname -s 2>/dev/null)"`));
    const hit = String(u?.stdout ?? '').slice(-200_000).split('\n').map((x) => x.trim()).find((x) => x.startsWith(`##KLV ${nonce}`));
    if (!hit) { const e = new Error(KEY_UNUSABLE_TEXT); e.code = 'key-login-unusable'; throw e; }
    let read = null;
    try { read = parseReadOutput((await run(READ_COMMAND))?.stdout || ''); } catch { read = null; }
    return { uname: t(hit.slice(`##KLV ${nonce}`.length).trim(), 40), read };
  }, { execs: 2 });
  noteKeyUse({ fingerprint: key.fingerprint, keyName: key.name, server: base.name, corp: base.corp, feature: 'conn-test', ok: step2.ok, code: step2.ok ? 'ok' : step2.code, trigger: 'manual', by: o.by });
  if (!step2.ok) {
    const rb = await rollbackChange();
    // 출발지 제한 안내는 그 키가 **거부됐을 때만**(3회차 E3-5 — 로그인은 됐지만 강제 명령으로 명령이 돌지 않은 key-login-unusable 에도 ‘제한을 끄라’ 고 했다).
    return fail('key-login-failed', `키 접속 확인 실패 — ${step2.reason}${rb.tail}${o.restrict && fromIp && (added || replaced) && step2.code === 'auth-rejected' ? restrictText(fromIp) : ''}`, { line: m.kind, rolledBack: rb.rolledBack, rollbackUnknown: rb.rollbackUnknown, fromIp, notes });
  }

  // ④ 확인됨 — 서버를 그 키에 묶고(등록부), 고른 뒷일을 한다.
  // 제한이 붙었다 = 이 키의 포탈 줄이 모두 원하는 제한 줄이고, 표식 없는 같은 키 줄도 없다.
  const exactOnly = m.kind === 'present-marked' && m.exact > 0 && !m.loose && !m.custom;
  const restricted = !!o.restrict && (added || replaced || exactOnly) && !m.unmarked && !m.custom && !m.otherId;
  const out = { ...base, ok: true, code: 'ok', line: m.kind, restricted, fromIp: added || replaced ? fromIp : '', bound: false, passwordRemoved: false,
    unmarked: m.unmarked || 0, custom: m.custom || 0, otherId: m.otherId || 0, replaceSkipped, notes };
  if (step2.value?.read?.ok) INS.noteInstalled(server.id, { host: server.host, port: Number(server.port) || 22, username: kAuthNow.username, file: '~/.ssh/authorized_keys', keys: step2.value.read.keys, truncated: step2.value.read.truncated, by: t(o.by, 64) });
  // 이미 그 키를 쓰는 서버는 다시 묶지 않는다 — 특히 ‘법인 기본 키를 따름’ 인 서버를 이름 고정으로 바꾸지 않는다(법인 기본 키를 바꾸면 따라가야 한다).
  const b = serverUsesKey(server, key.id) ? { ok: true, already: true } : o.bind(server, key.id);
  if (!b.ok) {
    // 키가 그 사이 퇴역 · 삭제됐으면(묶을 수 없다) 우리가 넣은 줄도 되돌린다 — 지운 키의 줄이 서버에 남아 거둘 수도 없게 되던 것(1회차 C1-3).
    if (b.code === 'key-gone') {
      const rb = await rollbackChange();
      return { ...out, ok: false, code: 'bind-failed', rolledBack: rb.rolledBack, rollbackUnknown: rb.rollbackUnknown, reason: `키 접속은 확인됐지만 그 사이 키가 퇴역 · 삭제돼 서버 설정에 적지 않았습니다.${rb.tail}` };
    }
    return { ...out, ok: false, code: 'bind-failed', reason: `키 접속은 확인됐지만 서버 설정에 적지 못했습니다(${t(b.reason, 120)}) — 서버의 키 줄은 남아 있습니다. ‘키 고르기’ 로 이 키를 고르세요.` };
  }
  out.bound = true;
  // 저장 비밀번호 지우기 — 서버 항목에 저장된 비밀번호가 있을 때만(공통 계정의 비밀번호는 다른 서버도 쓰므로 여기서 지우지 않는다).
  if (o.removePassword) {
    if (!server.password) out.passwordRemoved = null;   // 지울 것이 없다(공통 계정을 쓰거나 처음부터 없음)
    else { const c = o.clearPassword(server); out.passwordRemoved = !!c.ok; if (!c.ok) notes.push(`저장 비밀번호를 지우지 못했습니다(${t(c.reason, 100)}).`); }
  }
  if (o.replaceKey && o.replaceKey.id !== key.id) {
    const cmd = removeCommand({ publicKey: o.replaceKey.publicKey, keyId: o.replaceKey.id });
    const ka = keyLegAuth(server, key.id);   // 그 차례에 다시(3회차 C3-1)
    const rm = !ka.ok ? { ok: false, reason: `${ka.error} — 그 키로 접속하지 않았습니다` }
      : cmd ? await sshRun(server, ka, async (run) => mutRun(run, cmd)) : { ok: false, reason: '옛 키의 공개키 꼴이 올바르지 않습니다' };
    out.oldRemoved = rm.ok && rm.value.kind === 'removed' ? rm.value.removed : rm.ok && rm.value.kind === 'none' ? 0 : null;
    out.oldUnmarked = rm.ok && rm.value.kind === 'removed' ? rm.value.unmarked : null;
    if (out.oldRemoved == null) notes.push(`옛 키 줄을 ${unknownOutcome(rm) ? '지웠는지 모릅니다' : '지우지 못했습니다'}(${!rm.ok ? `${rm.reason}${rm.sent ? ' — 결과를 받지 못했습니다' : ''}` : rm.value.kind === 'fail' ? AK.failText(rm.value.why) : rm.value.kind === 'nocode' ? '결과를 받지 못했습니다(연결 끊김)' : '서버가 예상한 답을 주지 않았습니다'}) — 서버의 authorized_keys 에서 확인하세요.`);
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
  const r = await sshRun(server, auth, async (run) => mutRun(run, cmd));
  if (auth.keyFingerprint) noteKeyUse({ fingerprint: auth.keyFingerprint, keyName: auth.keyName, server: base.name, corp: base.corp, feature: 'conn-test', ok: r.ok, code: r.ok ? 'ok' : r.code, trigger: 'manual', by: o.by });
  const pinned = serverUsesKey(server, key.id);
  if (!r.ok) return { ...base, ok: false, code: r.sent ? 'uncertain' : r.code, reason: `${r.reason}${r.sent ? ' 지우는 명령은 보냈지만 결과를 받지 못했습니다 — 지워졌는지 서버에서 확인하세요.' : ''}`, pinned, via: auth.authKind };
  const m = r.value;
  if (m.kind === 'none') return { ...base, ok: true, code: 'none', removed: 0, unmarked: 0, pinned };
  if (m.kind === 'nocode') return { ...base, ok: false, code: 'uncertain', reason: '서버가 결과 없이 연결을 닫았습니다 — 지우는 명령은 보냈으니 지워졌는지 서버에서 확인하세요.', pinned, via: auth.authKind };
  if (m.kind === 'fail' && AFTER_MV.has(m.why)) return { ...base, ok: false, code: 'uncertain', why: m.why, reason: `${AK.failText(m.why)} 지워졌는지 서버에서 확인하세요.`, pinned, via: auth.authKind };
  if (m.kind !== 'removed') return { ...base, ok: false, code: 'revoke-failed', why: m.kind === 'fail' ? m.why : 'unknown', reason: m.kind === 'fail' ? AK.failText(m.why) : '서버가 예상한 답을 주지 않았습니다.', pinned };
  return { ...base, ok: true, code: m.removed > 0 ? 'removed' : 'not-present', removed: m.removed, unmarked: m.unmarked, pinned };
}

/* ── 작업(여러 서버 — 1대씩 차례로 · 화면은 진행을 물어 본다) ────────────────── */

const jobs = new Map();
/**
 * 작업 칸 — 넣기는 하나, 거두기는 **키마다** 하나(동시에 최대 MAX_REVOKE_JOBS — 다른 키의 긴급 거두기가 몇 시간 기다리지 않게 · 반증 D2).
 * 넣기와 거두기는 따로 돈다(긴급 거두기가 넣기에 막히지 않게). 같은 서버(접속처)는 서버 자물쇠로 한 번에 한 작업만 만진다.
 */
export const MAX_REVOKE_JOBS = 3;
const slotOf = (kind, keyId) => (kind === 'key-login' ? 'install' : kind === 'key-revoke' ? `revoke:${t(keyId, 32)}` : '');
const viewKey = (slot) => (slot.startsWith('revoke:') ? 'revoke' : slot);
const slots = new Map();   // 칸 → 진행 중인 작업 id
const lastBySlot = new Map();   // 화면 칸(install · revoke) → 마지막 작업 id(끝난 것 포함 — 화면이 다시 열려도 결과를 보여 준다 · 점검 E-2)
const serverLocks = new Map();
function sweep(now) { for (const [id, j] of jobs) if (j.doneAt && now - j.doneAt > JOB_KEEP_MS) jobs.delete(id); }
export function _resetKeyLoginJobsForTest() { jobs.clear(); slots.clear(); lastBySlot.clear(); serverLocks.clear(); }
const runningIn = (slot) => { const id = slots.get(slot); const j = id ? jobs.get(id) : null; return j && !j.doneAt ? j : null; };
const runningRevokes = () => [...slots.keys()].filter((k) => k.startsWith('revoke:')).map(runningIn).filter(Boolean);

/**
 * 같은 서버는 한 번에 한 작업만 만진다. 열쇠는 **접속처(주소:포트)** — 등록부 항목 id 로 잡으면 같은 서버를 가리키는 두 항목이 동시에 같은 파일을 바꿨다(반증 R1).
 * 서버 쪽에도 자물쇠가 있다(akScript LOCK — 다른 포탈 · 다른 노드).
 */
export const serverLockKey = (s) => `${String(s?.host || '').trim().toLowerCase()}:${Number(s?.port) || 22}`;
/** 그 접속처를 지금 누가 만지고 있나(키 고르기가 기다리지 않고 409 로 돌려주게 — 2회차 C2-7). */
export function serverLockBusy(key) { return serverLocks.has(key); }
/** 서버 자물쇠(같은 접속처를 바꾸는 다른 동작 — 키 고르기 — 도 함께 잡는다 · 1회차 C1-2). */
export async function withServerLock(key, fn) {
  const prev = serverLocks.get(key) || Promise.resolve();
  let release; const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  serverLocks.set(key, tail);
  await prev;
  try { return await fn(); } finally { release(); if (serverLocks.get(key) === tail) serverLocks.delete(key); }
}

/**
 * 시작 사전 검사(OTP 앞 — 라우트 jobPre). 넣기: 넣기 칸이 차 있거나 **같은 키를 거두는 중**이면 409(거둔 키를 다시 넣지 않게 · 반증 R2).
 * 거두기: 같은 키 거두기가 진행 중이거나 동시 거두기 상한이면 409.
 * @returns {null | {ok:false, code, status, jobId?, reason}}
 */
/** 그 키를 서버에서 거두는 작업이 도는 중인가 — 키 고르기 · 교체의 새 키로 쓰지 않는다(3회차 C 참고 D-2 — 넣기만 막았다). */
export function revokingIssue(keyId) {
  const k = t(keyId, 32); const rv = k ? runningIn(`revoke:${k}`) : null;
  return rv ? { ok: false, code: 'revoking', status: 409, jobId: rv.id, reason: '그 키를 서버에서 거두는 작업이 진행 중입니다 — 거두는 키로 서버를 묶지 않습니다.' } : null;
}
export function jobStartIssue(kind, keyId = '') {
  const k = t(keyId, 32);
  if (kind === 'key-login') {
    const cur = runningIn('install');
    if (cur) return { ok: false, code: 'busy', status: 409, jobId: cur.id, reason: '다른 키 로그인 설정 작업이 진행 중입니다 — 끝나거나 멈춘 뒤 다시 하세요.' };
    const rv = k ? runningIn(`revoke:${k}`) : null;
    if (rv) return { ok: false, code: 'revoking', status: 409, jobId: rv.id, reason: '그 키를 서버에서 거두는 작업이 진행 중입니다 — 거두는 키를 다시 넣지 않습니다.' };
    return null;
  }
  if (kind === 'key-revoke') {
    const same = k ? runningIn(`revoke:${k}`) : null;
    if (same) return { ok: false, code: 'busy', status: 409, jobId: same.id, reason: '그 키를 거두는 작업이 이미 진행 중입니다 — 진행을 보세요.' };
    if (runningRevokes().length >= MAX_REVOKE_JOBS) return { ok: false, code: 'busy', status: 409, reason: `키 거두기 작업이 이미 ${MAX_REVOKE_JOBS}개 진행 중입니다 — 하나가 끝난 뒤 다시 하세요.` };
    return null;
  }
  return { ok: false, code: 'bad-kind', status: 400, reason: '모르는 작업입니다.' };
}
/** 화면 · 라우트용 — 그 종류(와 키)의 진행 중인 작업 id(없으면 ''). */
export function busyJob(kind, keyId = '') { const p = jobStartIssue(kind, keyId); return p && p.jobId ? p.jobId : ''; }
/** 작업 종류(라우트가 멈추기 게이트를 고른다 — 거두기를 멈추는 것은 OTP · 반증 D1). 없으면 ''. */
export function jobKind(id) { return jobs.get(t(id, 20))?.kind || ''; }
/** 진행 중인 넣기 작업의 키 id(없으면 '') — 그 키를 지우거나 회전으로 퇴역시키지 못하게(1회차 C1-3). */
export function installingKeyId() { const j = runningIn('install'); return j ? t(j.meta?.keyId, 32) : ''; }
/** 진행 중인 넣기 작업이 쓰는 키 id 들 — 넣는 키와 지울 옛 키(교체). 옛 키를 그 사이 지우면 남은 서버의 옛 키 줄을 거둘 수 없게 된다(2회차 D2-2). */
export function installingKeyIds() { const j = runningIn('install'); return j ? [t(j.meta?.keyId, 32), t(j.meta?.replaceKeyId, 32)].filter(Boolean) : []; }
/** 멈추기에 OTP 가 필요한 작업인가 — 거두기, 또는 옛 키 교체가 붙은 넣기(남은 서버에 옛 키 — 유출 키일 수 있다 — 가 남는다 · 1회차 A4). */
export function cancelNeedsOtp(id) { const j = jobs.get(t(id, 20)); return !!j && (j.kind === 'key-revoke' || !!j.meta?.replaceKeyId); }
/** 작업을 멈춘다(지금 서버는 끝까지 — 되돌림을 끊지 않는다 · 남은 서버는 ‘멈춤’ 으로 적는다). */
export function cancelJob(id, { by = '', why = '' } = {}) {
  const j = jobs.get(t(id, 20));
  if (!j) return { ok: false, code: 'not-found', status: 404, reason: '작업을 찾을 수 없습니다(끝난 지 1시간이 지났을 수 있습니다).' };
  if (j.doneAt) return { ok: false, code: 'done', status: 409, reason: '이미 끝난 작업입니다.' };
  if (!j.cancelled) { j.cancelled = true; j.cancelledBy = t(by, 64); j.cancelWhy = t(why, 120); }
  return { ok: true, jobId: j.id };
}

/**
 * 작업을 시작한다. `run(server, job)` 를 서버마다 차례로 부른다 — 한 대의 예외는 그 서버의 실패로 적고 다음으로 간다.
 * 거두기는 같은 키를 넣는 작업이 돌고 있으면 그 작업을 멈춘다(넣기는 같은 키 거두기 중에는 시작하지 않는다 — jobStartIssue).
 * run 이 `job.stop(why)` 를 부르면 남은 서버는 하지 않는다(같은 비밀번호가 거부될 때 — 계정 잠금 · 반증 D3).
 * @param {{kind:'key-login'|'key-revoke', servers:object[], run:Function, by?:string, meta?:object, onDone?:(view:object)=>void}} o
 * @returns {{ok:true, jobId:string, stopped?:string} | {ok:false, code:string, status:number, reason:string}}
 */
export function startJob({ kind, servers, run, by = '', meta = {}, onDone = null } = {}, { now = Date.now() } = {}) {
  sweep(now);
  const slot = slotOf(kind, meta?.keyId);
  if (!slot) return { ok: false, code: 'bad-kind', status: 400, reason: '모르는 작업입니다.' };
  const pre = jobStartIssue(kind, meta?.keyId);
  if (pre) return pre;
  if (!Array.isArray(servers) || !servers.length) return { ok: false, code: 'empty', status: 400, reason: '대상 서버가 없습니다.' };
  const max = kind === 'key-revoke' ? MAX_REVOKE_SERVERS : MAX_JOB_SERVERS;
  if (servers.length > max) return { ok: false, code: 'too-many', status: 400, reason: `한 번에 ${max}대까지입니다 — 나눠서 하세요.` };
  let stopped = '';
  if (kind === 'key-revoke' && meta?.keyId) {
    const inst = runningIn('install');
    if (inst && inst.meta?.keyId === meta.keyId) { cancelJob(inst.id, { by, why: '같은 키 거두기가 시작됨' }); stopped = inst.id; }
  }
  const id = `kj_${crypto.randomBytes(6).toString('hex')}`;
  const job = { id, kind, slot, by: t(by, 64), meta, startedAt: now, doneAt: 0, total: servers.length, results: [], current: '', cancelled: false, cancelledBy: '', cancelWhy: '' };
  const handle = { id, stop: (why) => { if (!job.cancelled) { job.cancelled = true; job.cancelledBy = ''; job.cancelWhy = t(why, 120); } } };
  jobs.set(id, job); slots.set(slot, id); lastBySlot.set(viewKey(slot), id);
  (async () => {
    for (const s of servers) {
      if (job.cancelled) {
        job.results.push({ id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'cancelled', reason: `작업을 멈춰 이 서버는 하지 않았습니다${job.cancelWhy ? `(${job.cancelWhy})` : ''}.` });
        continue;
      }
      job.current = s.name || s.host;
      let r;
      // 자물쇠를 기다리는 사이 멈췄으면 그 서버는 하지 않는다(2회차 C2-2 — 앞 동작이 오래 쥐고 있으면 멈추기가 듣지 않았다).
      try { r = await withServerLock(serverLockKey(s), () => (job.cancelled ? { id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'cancelled', reason: `작업을 멈춰 이 서버는 하지 않았습니다${job.cancelWhy ? `(${job.cancelWhy})` : ''}.` } : run(s, handle))); } catch (e) { r = { id: s.id, name: s.name || s.host, corp: t(s.vcenterId), ok: false, code: 'error', reason: `처리 중 오류(${String(e?.message || e).replace(/\s+/g, ' ').slice(0, 100)})` }; }
      job.results.push(r);
      // 서버마다 이벤트 루프에 차례를 넘긴다(1회차 C1-1 — SSH 전에 바로 실패하는 서버 500대가 한 턴에 돌아 포탈이 수 초 멈췄다).
      await new Promise((res) => { setImmediate(res); });
    }
    job.current = ''; job.doneAt = Date.now();
    if (slots.get(slot) === id) slots.delete(slot);
    try { onDone?.(jobView(id)); } catch { /* 요약 기록 실패는 작업 결과를 바꾸지 않는다 */ }
  })();
  return { ok: true, jobId: id, ...(stopped ? { stopped } : {}) };
}
/** 진행 · 결과(비밀 없음). 없으면 null. */
export function jobView(id) {
  sweep(Date.now());   // 끝난 지 1시간 지난 작업은 보기에서도 정리한다(1회차 E1-7 — 시작할 때만 정리해 칸이 무기한 남았다)
  const j = jobs.get(t(id, 20));
  if (!j) return null;
  return { id: j.id, kind: j.kind, by: j.by, meta: j.meta, startedAt: j.startedAt, doneAt: j.doneAt || null, running: !j.doneAt, total: j.total, done: j.results.length, current: j.current,
    cancelled: j.cancelled, cancelledBy: j.cancelledBy || '', results: j.results.map((r) => ({ ...r, notes: Array.isArray(r.notes) ? [...r.notes] : undefined })) };
}
/** 칸마다 마지막 작업(1시간 안 — 진행 중이면 진행 중인 것). 화면이 다시 열려도 결과를 이어 보여 준다. */
export function lastJobs() {
  const out = {};
  const brief = (v) => ({ id: v.id, kind: v.kind, running: v.running, startedAt: v.startedAt, doneAt: v.doneAt, total: v.total, done: v.done, by: v.by, keyName: t(v.meta?.keyName, 64) });
  for (const [slot, id] of lastBySlot) { const v = jobView(id); if (v) out[slot] = brief(v); }
  // 거두기는 키마다 돌 수 있다 — 1시간 안의 거두기 작업을 최근 것부터 최대 5개(화면이 다른 사람이 돌린 거두기도 이어 본다).
  out.revokes = [...jobs.values()].filter((j) => j.kind === 'key-revoke').sort((a, b) => b.startedAt - a.startedAt).slice(0, 5).map((j) => brief(jobView(j.id)));
  return out;
}
