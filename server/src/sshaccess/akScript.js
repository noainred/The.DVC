/**
 * sshaccess/akScript.js — 서버의 `~/.ssh/authorized_keys` 를 바꾸는 **원격 스크립트**(순수 — 글자만 만든다 · v3.10.0 · 5축 점검 B 반영으로 다시 짰다).
 *
 * 지키는 것(되돌리지 말 것 — 테스트 sshKeyLogin3100 이 실제 bash · dash 로 고정):
 *  · **한 번에 바꾼다**: 새 내용을 같은 폴더의 임시 파일에 다 쓴 뒤 ① 줄 수 ② 남길 줄의 cksum ③ 마지막 줄을 대조하고, 맞을 때만 `mv` 로 바꾼다.
 *    중간에 실패하면(디스크 가득 · 쓰기 오류 · busybox awk 가 ENOSPC 에도 0 을 돌려주는 경우) 원본은 그대로다. 예전 판의 `cat tmp > f` 는 파일을 먼저 비워
 *    실패하면 authorized_keys 가 0 바이트가 됐다(점검 B-F1). `mv` 라 하드 링크로 이어진 남의 파일도 바꾸지 않는다.
 *  · **줄 판정은 awk 의 글자 비교**(LC_ALL=C · 앞 공백 · 끝 CR 무시): grep 은 파일에 NUL 이 한 바이트라도 있으면 바이너리로 보고 줄을 숨겨
 *    ‘포탈 줄 없음’ 으로 읽혔다(점검 B-F2a).
 *  · **심볼릭 링크 · 일반 파일 아님 · 못 읽음은 실패로 말한다**(‘없음’ 이 아니다 — 거두기가 ‘없음’ 으로 끝나면 키가 계속 들어간다 · 점검 B-F2b).
 *  · **관리자가 손댄 포탈 줄은 건드리지 않는다**: 같은 키 · 같은 표식 줄 가운데 우리 꼴(옵션 없음 / from= + 포워딩 금지 세 가지)이 아닌 줄(command= · restrict 등)이
 *    하나라도 있으면 바꾸지 않는다(점검 B-F4 — 예전 판은 그 줄을 덜 엄한 줄로 바꿨다).
 *  · **되돌림은 우리 줄만**: 더한 줄은 그 글자와 똑같은 줄만 지우고, 바꾼 줄은 바꾸기 전의 포탈 줄(base64 로 받아 둔 것)을 다시 넣는다 —
 *    파일 전체를 사본으로 되쓰지 않는다(그 사이 사람이 고친 것을 버리던 점검 B-F6). 사본 파일(.portal-bak)도 남기지 않는다.
 *  · **어느 로그인 셸에서도 같은 /bin/sh 로 돈다**: 스크립트를 base64 로 싸서 `echo '…' | base64 -d | /bin/sh` 한 줄로 보낸다(tcsh 등에서
 *    POSIX 문법이 다르게 읽히던 점검 B-F10). 끼우는 글자는 전부 아래 정규식을 통과한 것뿐이다(작은따옴표 · 역슬래시 · 줄바꿈이 들어갈 수 없다).
 * 결과는 마지막 표지 줄 하나(`##KL …`) — parseMarker.
 */
export const PORTAL_MARK = 'portal-ssh:';
const TYPE_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521))$/;
const BLOB_RE = /^[A-Za-z0-9+/]{40,4096}={0,2}$/;
const KEYID_RE = /^k_[0-9a-f]{6,24}$/;
/** 서버가 본 접속 주소(`$SSH_CONNECTION` 첫 칸) — IPv4 또는 IPv6 글자만. */
export const IP_RE = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f:]{2,45})$/;
const B64_RE = /^[A-Za-z0-9+/=]*$/;
export const RESTRICT_OPTIONS = Object.freeze(['no-agent-forwarding', 'no-port-forwarding', 'no-X11-forwarding']);
export const MAX_OLD_B64 = 60_000;

/** 공개키 글 → { type, blob }. 꼴이 아니면 null. */
export function splitPublicKey(publicKey) {
  const parts = String(publicKey || '').trim().split(/\s+/);
  if (parts.length < 2 || !TYPE_RE.test(parts[0]) || !BLOB_RE.test(parts[1])) return null;
  return { type: parts[0], blob: parts[1] };
}
export const markOf = (keyId) => (KEYID_RE.test(String(keyId || '')) ? `${PORTAL_MARK}${keyId}` : '');
const safeQ = (s) => typeof s === 'string' && s.length > 0 && s.length < 8192 && !/['\\\r\n\0]/.test(s);

/** authorized_keys 에 넣을 한 줄(꼴이 맞지 않으면 null). */
export function buildKeyLine({ publicKey, keyId, restrict = false, fromIp = '' } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark) return null;
  const opts = [];
  if (restrict) {
    if (!fromIp || !IP_RE.test(fromIp)) return null;
    opts.push(`from="${fromIp}"`);
    for (const o of RESTRICT_OPTIONS) opts.push(o);
  }
  const line = `${opts.length ? `${opts.join(',')} ` : ''}${pk.type} ${pk.blob} ${mark}`;
  return safeQ(line) ? line : null;
}

/** 스크립트 → 어느 로그인 셸에서도 같은 /bin/sh 로 도는 한 줄. */
export function wrapSh(script) {
  return `echo '${Buffer.from(String(script), 'utf8').toString('base64')}' | base64 -d | /bin/sh`;
}

const HEAD = [
  'LC_ALL=C; export LC_ALL',
  'umask 077',
  '[ -n "$HOME" ] || { echo "##KL fail nohome"; exit 3; }',
  'd="$HOME/.ssh"; f="$d/authorized_keys"; tmp="$d/.authorized_keys.portal.$$"',
  'trap \'rm -f "$tmp"\' 0',
];
/** 줄 다듬기(앞 공백 · 끝 CR) — awk 안에서 같은 식을 쓴다. 이 글은 셸의 작은따옴표 안에만 들어간다(작은따옴표가 없다). */
const STRIP = '{ s = $0; sub(/\\r$/, "", s); t = s; sub(/^[ \\t]+/, "", t) }';
/** 파일 · 폴더 꼴 검사(심볼릭 링크 · 일반 파일 아님 · 못 읽음은 실패). needDir 면 ~/.ssh 가 없을 때 만든다. */
const CHECKS = (needDir) => [
  'if [ -L "$d" ]; then echo "##KL fail symlink"; exit 3; fi',
  ...(needDir ? [
    'mkd=""',
    'if [ ! -d "$d" ]; then if [ -e "$d" ]; then echo "##KL fail notdir"; exit 3; fi; mkdir "$d" || { echo "##KL fail mkdir"; exit 3; }; mkd=1; fi',
  ] : []),
  'if [ -L "$f" ]; then echo "##KL fail symlink"; exit 3; fi',
  'if [ -e "$f" ] && [ ! -f "$f" ]; then echo "##KL fail notfile"; exit 3; fi',
  'if [ -e "$f" ] && [ ! -r "$f" ]; then echo "##KL fail unreadable"; exit 3; fi',
];
/**
 * 임시 파일을 만들고 검증한 뒤 한 번에 바꾼다. 앞에서 정한 것: 셸 함수 keep(남길 줄을 낸다) · extra(덧붙일 줄을 낸다 — 없으면 :) ·
 * exp(기대 줄 수) · tailn(덧붙인 줄 수) · last(마지막 줄 — 빈 값이면 보지 않음).
 * 쓸 수 없는 파일(관리자가 root 소유 · 읽기 전용으로 둔 것)은 바꾸지 않는다 — mv 는 폴더 권한만 보므로 그 뜻을 우회할 수 있다.
 */
const COMMIT = [
  'if [ -e "$f" ] && [ ! -w "$f" ]; then echo "##KL fail notwritable"; exit 3; fi',
  '[ -w "$d" ] || { echo "##KL fail notwritable"; exit 3; }',
  'rm -f "$tmp"',
  'keep > "$tmp" || { echo "##KL fail write"; exit 3; }',
  'extra >> "$tmp" || { echo "##KL fail write"; exit 3; }',
  'got=$(awk \'END { print NR }\' "$tmp") || got=-1',
  '[ "$got" = "$exp" ] || { echo "##KL fail verify"; exit 3; }',
  'c1=$(keep | cksum); c2=$(head -n "$((got - tailn))" "$tmp" | cksum)',
  '[ "$c1" = "$c2" ] || { echo "##KL fail verify"; exit 3; }',
  'if [ -n "$last" ]; then [ "$(tail -n 1 "$tmp")" = "$last" ] || { echo "##KL fail verify"; exit 3; }; fi',
  'chmod 600 "$tmp" || { echo "##KL fail write"; exit 3; }',
  'mv -f "$tmp" "$f" || { echo "##KL fail rename"; exit 3; }',
  'if command -v restorecon >/dev/null 2>&1; then if [ -n "${mkd:-}" ]; then restorecon -F "$d" >/dev/null 2>&1; fi; restorecon -F "$f" >/dev/null 2>&1; fi',
];

/**
 * 키 넣기. 결과 표지:
 *   `##KL added <um> 0` · `##KL replaced <um> 0 <바꾸기 전 포탈 줄 base64>` · `##KL present-marked <um> <cu> <ex> <loose>` · `##KL present-unmarked <um> 0` · `##KL fail <사유>`
 *   um = 표식 없는 같은 키 줄 수(사람이 넣은 줄) · cu = 관리자가 옵션을 바꾼 포탈 줄 수 · ex = 원하는 줄과 똑같은 포탈 줄 수 · loose = 우리 꼴이지만 원하는 줄과 다른 포탈 줄 수.
 * @param {{publicKey:string, keyId:string, line:string, replace?:boolean}} o  replace = 우리 꼴의 포탈 줄이 원하는 줄과 다르면 바꾼다(제한 붙이기 · 주소 갱신)
 */
export function installScript({ publicKey, keyId, line, replace = false } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark || !safeQ(line) || !line.includes(` ${pk.blob} `) || !line.endsWith(` ${mark}`)) return null;
  const CLS = `${STRIP} index(t, b) == 0 { next } index(t, m) > 0 { if (t == L) ex++; else if (index(t, ty " ") == 1) un++; else if (t ~ /^from="[^"]*",no-agent-forwarding,no-port-forwarding,no-X11-forwarding /) sd++; else cu++; next } { um++ } END { printf "%d %d %d %d %d %d", NR, ex + 0, un + 0, sd + 0, cu + 0, um + 0 }`;
  const OLD = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { print $0 }`;
  const DROPM = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { next } { print }`;
  return [
    ...HEAD,
    `B='${pk.blob}'; M='${mark}'; L='${line}'; TY='${pk.type}'; RP='${replace ? 1 : 0}'`,
    ...CHECKS(true),
    'st="0 0 0 0 0 0"',
    `if [ -e "$f" ]; then st=$(awk -v b="$B" -v m="$M" -v L="$L" -v ty="$TY" '${CLS}' "$f") || { echo "##KL fail read"; exit 3; }; fi`,
    'set -- $st; nr=$1; ex=$2; un=$3; sd=$4; cu=$5; um=$6',
    'act=add',
    'if [ $((ex + un + sd + cu)) -gt 0 ]; then',
    '  if [ "$cu" -eq 0 ] && [ "$RP" = 1 ] && [ $((un + sd)) -gt 0 ]; then act=replace; else echo "##KL present-marked $um $cu $ex $((un + sd))"; exit 0; fi',
    'elif [ "$um" -gt 0 ]; then echo "##KL present-unmarked $um 0"; exit 0',
    'fi',
    'old=""',
    'if [ "$act" = replace ]; then',
    '  command -v base64 >/dev/null 2>&1 || { echo "##KL fail nobase64"; exit 3; }',
    `  old=$(awk -v b="$B" -v m="$M" '${OLD}' "$f" | base64 | tr -d '\\n') || { echo "##KL fail read"; exit 3; }`,
    `  [ -n "$old" ] && [ \${#old} -le ${MAX_OLD_B64} ] || { echo "##KL fail toolong"; exit 3; }`,
    `  keep() { awk -v b="$B" -v m="$M" '${DROPM}' "$f"; }`,
    '  exp=$((nr - ex - un - sd + 1))',
    'elif [ -e "$f" ]; then',
    `  keep() { awk '{ print }' "$f"; }`,
    '  exp=$((nr + 1))',
    'else',
    '  keep() { :; }',
    '  exp=1',
    'fi',
    `extra() { printf '%s\\n' "$L"; }`,
    'tailn=1; last="$L"',
    ...COMMIT,
    'if [ "$act" = replace ]; then echo "##KL replaced $um 0 $old"; else echo "##KL added $um 0"; fi',
  ].join('\n');
}

/**
 * 되돌리기 — 우리가 더한 그 줄(글자 그대로)만 지우고, oldB64 가 있으면(바꾸기였으면) 바꾸기 전의 포탈 줄을 다시 넣는다.
 * 그 줄이 이미 없으면(그 사이 사람이 바꿈) 아무것도 하지 않는다 — 옛 줄도 되살리지 않는다(사람이 지운 것을 되살리지 않게 · 점검 B-F6).
 * 결과: `##KL restored <지운 수>` · `##KL none`(파일 없음) · `##KL fail <사유>`.
 */
export function rollbackScript({ line, oldB64 = '' } = {}) {
  if (!safeQ(line) || typeof oldB64 !== 'string' || oldB64.length > MAX_OLD_B64 || !B64_RE.test(oldB64)) return null;
  const DROPL = `${STRIP} t == L { next } { print }`;
  const CNT = `${STRIP} t == L { c++ } END { print NR, c + 0 }`;
  return [
    ...HEAD,
    `L='${line}'; OLD='${oldB64}'`,
    ...CHECKS(false),
    'if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',
    `st=$(awk -v L="$L" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    'set -- $st; nr=$1; n=$2',
    'if [ "$n" -eq 0 ]; then echo "##KL restored 0"; exit 0; fi',
    'on=0',
    'if [ -n "$OLD" ]; then command -v base64 >/dev/null 2>&1 || { echo "##KL fail nobase64"; exit 3; }; on=$(printf \'%s\' "$OLD" | base64 -d | awk \'END { print NR }\') || { echo "##KL fail read"; exit 3; }; fi',
    `keep() { awk -v L="$L" '${DROPL}' "$f"; }`,
    'if [ "$on" -gt 0 ]; then extra() { printf \'%s\' "$OLD" | base64 -d; }; else extra() { :; }; fi',
    'exp=$((nr - n + on)); tailn=$on; last=""',
    ...COMMIT,
    'echo "##KL restored $n"',
  ].join('\n');
}

/**
 * 키 거두기 — 그 키의 **포탈 줄**(공개키 + 표식)만 모두 지운다. 표식 없는 같은 키 줄(사람이 넣은 줄)은 남기고 수를 알린다.
 * 결과: `##KL removed <지운 수> unmarked <남긴 수>` · `##KL none`(파일 없음) · `##KL fail <사유>`(심볼릭 링크 · 못 읽음 · 못 씀 포함 — ‘없음’ 이 아니다).
 */
export function removeScript({ publicKey, keyId } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark) return null;
  const CNT = `${STRIP} index(t, b) == 0 { next } index(t, m) > 0 { n++; next } { u++ } END { printf "%d %d %d", NR, n + 0, u + 0 }`;
  const DROPM = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { next } { print }`;
  return [
    ...HEAD,
    `B='${pk.blob}'; M='${mark}'`,
    ...CHECKS(false),
    'if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',
    `st=$(awk -v b="$B" -v m="$M" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    'set -- $st; nr=$1; n=$2; u=$3',
    'if [ "$n" -eq 0 ]; then echo "##KL removed 0 unmarked $u"; exit 0; fi',
    `keep() { awk -v b="$B" -v m="$M" '${DROPM}' "$f"; }`,
    'extra() { :; }',
    'exp=$((nr - n)); tailn=0; last=""',
    ...COMMIT,
    'echo "##KL removed $n unmarked $u"',
  ].join('\n');
}

/** 서버가 본 이 접속의 출발지 주소. */
export const WHOAMI_SCRIPT = 'echo "##KL ip ${SSH_CONNECTION%% *}"';

/** 표지 줄 읽기(마지막 `##KL …` 한 줄 — 로그인 배너가 앞에 섞여도). 모르는 사유 글자는 'unknown'. */
const FAIL_WHY = new Set(['nohome', 'symlink', 'notdir', 'mkdir', 'notfile', 'unreadable', 'notwritable', 'read', 'write', 'verify', 'rename', 'nobase64', 'toolong']);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
export function parseMarker(stdout) {
  const lines = String(stdout || '').slice(0, 200_000).split('\n').map((x) => x.trim()).filter((x) => x.startsWith('##KL '));
  const last = lines[lines.length - 1] || '';
  const w = last.split(' ');
  if (w[1] === 'ip') return { kind: 'ip', ip: IP_RE.test(w[2] || '') ? w[2] : '' };
  if (w[1] === 'added' || w[1] === 'present-marked' || w[1] === 'present-unmarked') return { kind: w[1], unmarked: num(w[2]), custom: num(w[3]), exact: num(w[4]), loose: num(w[5]) };
  if (w[1] === 'replaced') return { kind: 'replaced', unmarked: num(w[2]), custom: num(w[3]), old: w[4] && B64_RE.test(w[4]) && w[4].length <= MAX_OLD_B64 ? w[4] : null };
  if (w[1] === 'restored') return { kind: 'restored', removed: num(w[2]) };
  if (w[1] === 'none') return { kind: 'none' };
  if (w[1] === 'removed') return { kind: 'removed', removed: num(w[2]), unmarked: num(w[4]) };
  if (w[1] === 'fail') return { kind: 'fail', why: FAIL_WHY.has(w[2]) ? w[2] : 'unknown' };
  return { kind: 'unknown' };
}

/** 실패 사유 → 문구(사유 글자는 parseMarker 가 아는 것만 남긴다 — 프로토타입 이름이 문구에 실리지 않게). */
export const FAIL_TEXT = Object.freeze({
  nohome: '서버 계정의 HOME 을 알 수 없습니다.', symlink: '~/.ssh 또는 authorized_keys 가 심볼릭 링크라 건드리지 않았습니다 — 서버에서 직접 확인하세요.',
  notdir: '~/.ssh 가 폴더가 아니라 건드리지 않았습니다.', mkdir: '~/.ssh 폴더를 만들지 못했습니다.', notfile: 'authorized_keys 가 일반 파일이 아니라 건드리지 않았습니다.',
  unreadable: 'authorized_keys 를 읽을 수 없어(권한) 건드리지 않았습니다.', notwritable: 'authorized_keys(또는 ~/.ssh)에 이 계정이 쓸 수 없어(관리자가 잠가 둠) 건드리지 않았습니다.', read: 'authorized_keys 를 읽지 못했습니다.',
  write: '임시 파일을 쓰지 못했습니다(권한 · 디스크) — 원래 파일은 그대로입니다.', verify: '새로 쓴 내용이 예상과 달라(디스크 가득 등) 바꾸지 않았습니다 — 원래 파일은 그대로입니다.',
  rename: '새 파일로 바꾸지 못했습니다 — 원래 파일은 그대로입니다.', nobase64: '서버에 base64 명령이 없어 처리하지 않았습니다.', toolong: '바꿀 포탈 줄이 너무 많아 처리하지 않았습니다.',
  unknown: '서버가 예상한 답을 주지 않았습니다.',
});
export const failText = (why) => (Object.hasOwn(FAIL_TEXT, why) ? FAIL_TEXT[why] : FAIL_TEXT.unknown);
