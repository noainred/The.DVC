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
/**
 * 바꾸는 스크립트의 자기 시한(초 · 2회차 B1). 포탈은 exec 마다 시한(keyLogin STEP_TIMEOUT_MS)을 두고 넘기면 채널을 닫지만, 서버의 스크립트는 계속 돈다 —
 * 포탈이 ‘결과 모름’ 으로 넘어간 뒤 그 스크립트가 늦게 mv 하면, 그 사이 끝난 거두기 · 다시 넣기의 결과가 틀린다. 그래서 스크립트가 시작한 지 이만큼 지났으면 바꾸기 직전에 멈춘다(`slow` — 바꾼 것 없음).
 * 포탈 시한보다 넉넉히 짧아야 한다(채널 열기 · 명령 전달 왕복 — 800ms+ RTT). 산수는 테스트가 고정한다.
 */
export const SCRIPT_DEADLINE_S = 12;

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
  // 시작 표지(1회차 B5): 바꾸는 스크립트가 **돌기 시작했다**는 것. 끝 표지 없이 이것만 오면(안쪽 셸만 신호로 죽음 · 표지 잘림) ‘결과 모름’ 이다 — ‘바꾼 것 없음’ 이 아니다.
  'echo "##KL begin"',
  '[ -n "$HOME" ] || { echo "##KL fail nohome"; exit 3; }',
  'd="$HOME/.ssh"; f="$d/authorized_keys"; tmp="$d/.authorized_keys.portal.$$"; lk="$d/.authorized_keys.portal.lock"; held=""',
  // 자물쇠 주인 표(1회차 B1): 호스트:pid:시각. 끝 정리 · mv 직전에 **아직 내 자물쇠인지** 본다(남은 자물쇠로 잘못 치워진 뒤 깨어난 쪽이 덮어쓰지 않게).
  // 호스트 = 이름 + 부팅 id + pid 이름공간(2회차 B2 — 이름만 보면 이름이 같은 다른 서버 · 컨테이너가 NFS 홈을 나눠 쓸 때 살아 있는 주인을 ‘pid 없음’ 으로 치웠다).
  // 셋이 다 같을 때만 pid 로 판정한다. 이름공간 글자에 ':' 가 있어 표는 오른쪽부터 가른다.
  'me=$(uname -n 2>/dev/null); [ -z "$me" ] || me="$me/$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)/$(readlink /proc/self/ns/pid 2>/dev/null)"',
  'tok="$me:$$:$(date +%s 2>/dev/null)"',
  // 자기 시한(2회차 B1 — SCRIPT_DEADLINE_S): date 를 못 쓰는 서버(시각이 숫자가 아님)는 시한 없이 돈다.
  't0=$(date +%s 2>/dev/null); case "$t0" in ""|*[!0-9]*) t0=0 ;; esac',
  `late() { [ "$t0" -gt 0 ] || return 1; tn=$(date +%s 2>/dev/null); case "$tn" in ""|*[!0-9]*) return 1 ;; esac; [ "$tn" -gt $((t0 + ${SCRIPT_DEADLINE_S})) ]; }`,
  'owns() { [ "$(cat "$lk/owner" 2>/dev/null)" = "$tok" ]; }',
  'cleanup() { rm -f "$tmp"; if [ -n "$held" ] && owns; then rm -f "$lk/owner"; rmdir "$lk" 2>/dev/null; fi; }',
  'trap cleanup 0; trap \'exit 3\' HUP INT TERM PIPE',
];
/**
 * 서버 쪽 자물쇠(반증 R1 — 넣기 · 거두기가 동시에 같은 파일을 바꾸면 한쪽 갱신이 사라졌다): mkdir 은 원자적이다. 15초 기다려도 못 잡으면 `locked`.
 * 남은 자물쇠 치우기(1회차 B1 · B4 — 예전에는 `find -mmin +2` 하나로 주인 확인 없이 치웠다):
 *   · 주인 표의 호스트가 이 서버이고 그 pid 가 없으면 바로 · 주인 표의 시각이 10분 넘게 지났으면(다른 호스트 — NFS 홈) · 주인 표가 5초 넘게 없으면(만들다 죽음).
 *   · 치울 때는 옆 이름으로 옮긴 뒤 표가 판단한 그것인지 다시 보고, 아니면 되돌린다. 진짜 안전장치는 mv 직전의 `owns`(아니면 `locklost` — 바꾸지 않는다).
 *   · 한계: NFS 홈을 나눠 쓰는 서버끼리 시계가 10분 넘게 어긋나면 살아 있는 주인의 자물쇠를 치울 수 있다(시각 규칙) — 그때도 mv 직전 `owns` · 원본 재대조가 막는다(틈은 ms). NFS 홈이면 시계 동기가 전제다.
 *   · 15번(또는 자기 시한 SCRIPT_DEADLINE_S)을 넘기면 `locked`.
 * mkdir 이 실패했는데 자물쇠 폴더가 없으면 경합이 아니다(쓸 수 없는 ~/.ssh · 읽기 전용) — 기다리지 않고 `notwritable`(1회차 B3).
 * 읽기(분류)부터 mv 까지 잡는다. 사람 · 다른 도구는 이 자물쇠를 모른다 — 그래서 mv 직전에 원본을 다시 대조하고 mv 뒤에 다시 본다(post).
 */
const LOCK = [
  'i=0; nf=0; nos=""',
  'while :; do',
  '  if mkdir "$lk" 2>/dev/null; then',
  // 주인 표를 못 쓰면(디스크 가득 등) 자물쇠를 남기지 않고 사유를 가른다(1회차 반증 6 — 빈 표가 든 자물쇠가 남고 ‘관리자가 잠가 둠’ 이라고 했다).
  // 주인 표를 쓰는 사이 자물쇠 폴더가 사라졌으면(남은 자물쇠를 치우던 쪽이 막 만든 내 자물쇠를 옮김 — 2회차 B3) 실패가 아니라 경합이다: 다시 잡는다.
  '    if ! printf \'%s\\n\' "$tok" 2>/dev/null > "$lk/owner"; then',
  '      if [ ! -d "$lk" ]; then nf=$((nf + 1)); [ "$nf" -ge 5 ] && { echo "##KL fail write"; exit 3; }; continue; fi',
  '      rm -f "$lk/owner"; rmdir "$lk" 2>/dev/null; if [ -w "$d" ]; then echo "##KL fail write"; else echo "##KL fail notwritable"; fi; exit 3',
  '    fi',
  '    held=1; break',
  '  fi',
  // 쓸 수 없는 폴더면 남은 자물쇠가 있어도 기다리지 않는다(2회차 반증 R2R-4 — 옛 자물쇠가 남은 읽기 전용 ~/.ssh 에서 늘 locked).
  '  [ -w "$d" ] || { echo "##KL fail notwritable"; exit 3; }',
  // mkdir 이 실패했는데 자물쇠 폴더가 없다: 그 사이 보유자가 놓은 것일 수 있어 다시 해 본다(1회차 반증 7 ① — 헛 notwritable).
  '  if [ ! -d "$lk" ]; then',
  '    nf=$((nf + 1)); [ "$nf" -ge 5 ] && { echo "##KL fail write"; exit 3; }',
  '    continue',
  '  fi',
  '  i=$((i + 1)); if [ "$i" -ge 15 ] || late; then echo "##KL fail locked"; exit 3; fi',
  '  o=$(cat "$lk/owner" 2>/dev/null); stale=""; now=$(date +%s 2>/dev/null); case "$now" in ""|*[!0-9]*) now=0 ;; esac',
  '  if [ -n "$o" ]; then',
  '    nos=""',
  '    ot=${o##*:}; r=${o%:*}; op=${r##*:}; oh=${r%:*}',
  '    case "$op" in ""|*[!0-9]*) op="" ;; esac',
  '    if [ -n "$me" ] && [ -n "$op" ] && [ "$oh" = "$me" ] && ! kill -0 "$op" 2>/dev/null; then stale=1; fi',
  '    case "$ot" in ""|*[!0-9]*) ;; *) if [ "$now" -gt $((ot + 600)) ]; then stale=1; fi ;; esac',
  // 주인 표가 없는 자물쇠: **처음 본 때부터** 5초(1회차 반증 7 ② — 대기자 자신의 대기 횟수로 재서, 막 만든 자물쇠를 치웠다).
  '  else',
  '    [ -n "$nos" ] || nos=$now',
  '    if [ "$now" -ge $((nos + 5)) ]; then stale=1; fi',
  '  fi',
  // 옮기기 직전에 표를 다시 읽어 판단한 그 자물쇠일 때만 옮긴다(2회차 B3 — 그 사이 생긴 남의 새 자물쇠를 옮겼다). 남는 틈은 옮긴 뒤 다시 보고 되돌린다 —
  // 되돌릴 자리에 이미 새 자물쇠가 있으면 되돌리지 않는다(mv 가 그 안으로 들어간다). 그 주인은 mv 직전 `owns` 에서 locklost 로 멈춘다(바꾸지 않음).
  '  if [ -n "$stale" ] && [ "$(cat "$lk/owner" 2>/dev/null)" = "$o" ] && mv "$lk" "$lk.stale.$$" 2>/dev/null; then',
  '    if [ "$(cat "$lk.stale.$$/owner" 2>/dev/null)" = "$o" ]; then rm -rf "$lk.stale.$$"; elif [ ! -e "$lk" ]; then mv "$lk.stale.$$" "$lk" 2>/dev/null || rm -rf "$lk.stale.$$"; else rm -rf "$lk.stale.$$"; fi',
  '    continue',
  '  fi',
  '  sleep 1',
  'done',
];
/** 자물쇠를 잡은 **직후**(분류 전) 원본의 cksum — mv 직전에 다시 대조한다(1회차 반증 8 — 분류 뒤에 재서 그 사이 바뀐 것을 놓쳤다). */
const C0 = ['if [ -e "$f" ]; then c0=$(cksum < "$f") || { echo "##KL fail read"; exit 3; }; else c0=""; fi'];
/** 줄 다듬기(앞 공백 · 끝 CR) — awk 안에서 같은 식을 쓴다. 이 글은 셸의 작은따옴표 안에만 들어간다(작은따옴표가 없다). */
const STRIP = '{ s = $0; sub(/\\r$/, "", s); t = s; sub(/^[ \\t]+/, "", t) }';
/** 파일 · 폴더 꼴 검사(심볼릭 링크 · 일반 파일 아님 · 못 읽음은 실패). needDir 면 ~/.ssh 가 없을 때 만든다. */
const CHECKS = (needDir) => [
  'if [ -L "$d" ]; then echo "##KL fail symlink"; exit 3; fi',
  // 홈 · ~/.ssh 를 이 계정으로 따라갈 수 없으면 파일이 있는지 모른다 — ‘없음’ 이 아니라 실패(3회차 E3-4 — root 소유 0700 ~/.ssh 에서 거두기가 ‘파일 없음’ 으로 끝나고 키 줄이 남았다).
  'if [ ! -x "$HOME" ] || { [ -d "$d" ] && [ ! -x "$d" ]; }; then echo "##KL fail noaccess"; exit 3; fi',
  ...(needDir ? [
    'mkd=""',
    // 처음 넣기 둘이 겹치면 진 쪽의 mkdir 이 실패한다 — 그 사이 생긴 진짜 폴더면 실패가 아니다(2회차 B4). 남이 만든 폴더면 mkd 를 세우지 않는다.
    'if [ ! -d "$d" ]; then if [ -e "$d" ]; then echo "##KL fail notdir"; exit 3; fi; if mkdir "$d" 2>/dev/null; then mkd=1; elif [ -d "$d" ] && [ ! -L "$d" ]; then :; else echo "##KL fail mkdir"; exit 3; fi; fi',
  ] : []),
  'if [ -L "$f" ]; then echo "##KL fail symlink"; exit 3; fi',
  'if [ -e "$f" ] && [ ! -f "$f" ]; then echo "##KL fail notfile"; exit 3; fi',
  'if [ -e "$f" ] && [ ! -r "$f" ]; then echo "##KL fail unreadable"; exit 3; fi',
];
/**
 * 임시 파일을 만들고 검증한 뒤 한 번에 바꾼다. 앞에서 정한 것: 셸 함수 keep(남길 줄을 낸다) · extra(덧붙일 줄을 낸다 — 없으면 :) · post(바꾼 뒤 원하는 상태인가) ·
 * exp(기대 줄 수) · tailn(덧붙인 줄 수). 남길 줄과 덧붙인 줄을 **둘 다** cksum 으로 대조한다(반증 D4 — 덧붙인 옛 줄은 줄 수만 봤다).
 * 쓸 수 없는 파일(관리자가 root 소유 · 읽기 전용으로 둔 것)은 바꾸지 않는다 — mv 는 폴더 권한만 보므로 그 뜻을 우회할 수 있다.
 * root 에게 `test -w` 는 모드 444 에서도 참이라 소유자 쓰기 비트를 따로 본다(반증 R8).
 * mv 뒤에 다시 읽어 원하는 상태가 아니면(자물쇠를 모르는 쪽이 그 사이 바꿈) `raced` — ‘성공’ 이라고 하지 않는다(반증 R1).
 */
const COMMIT = [
  'if [ -e "$f" ]; then',
  '  [ -w "$f" ] || { echo "##KL fail notwritable"; exit 3; }',
  // 소유자 쓰기 비트는 ls 로 본다(1회차 B4 — find 가 없는 서버에서 root 의 444 보호가 조용히 빠졌다). `-r--…` 의 셋째 글자가 '-' 면 잠긴 파일.
  '  case "$(ls -ld -- "$f" 2>/dev/null)" in ??-*) echo "##KL fail notwritable"; exit 3 ;; esac',
  'fi',
  '[ -w "$d" ] || { echo "##KL fail notwritable"; exit 3; }',
  'rm -f "$tmp"',
  'keep > "$tmp" || { echo "##KL fail write"; exit 3; }',
  'extra >> "$tmp" || { echo "##KL fail write"; exit 3; }',
  'got=$(awk \'END { print NR }\' "$tmp") || got=-1',
  '[ "$got" = "$exp" ] || { echo "##KL fail verify"; exit 3; }',
  'c1=$(keep | cksum); c2=$(head -n "$((got - tailn))" "$tmp" | cksum)',
  '[ "$c1" = "$c2" ] || { echo "##KL fail verify"; exit 3; }',
  'if [ "$tailn" -gt 0 ]; then c3=$(extra | cksum); c4=$(tail -n "$tailn" "$tmp" | cksum); [ "$c3" = "$c4" ] || { echo "##KL fail verify"; exit 3; }; fi',
  'chmod 600 "$tmp" || { echo "##KL fail write"; exit 3; }',
  // mv 직전: 아직 내 자물쇠인가(B1) · 그 사이 원본이 바뀌지 않았나(B10 — 자물쇠를 모르는 쪽의 쓰기. 남는 틈은 이 줄과 mv 사이뿐).
  'owns || { echo "##KL fail locklost"; exit 3; }',
  // 자기 시한(2회차 B1): 포탈이 이미 ‘결과 모름’ 으로 넘어갔을 수 있다 — 늦게 바꾸지 않는다.
  'if late; then echo "##KL fail slow"; exit 3; fi',
  // 아직 포탈이 듣고 있는가(2회차 반증 R2R-3 — 자기 시한은 스크립트 시작부터만 잰다: 셸 기동 · 홈 자동 마운트로 늦게 시작하면 포탈이 포기한 뒤 바꿀 수 있었다).
  //   포탈이 접속을 끊었으면 이 쓰기가 SIGPIPE/EPIPE 로 실패해 바꾸지 않고 끝난다(sshd 가 세션의 출력 관을 닫는다 — 실제 sshd 에서는 확인하지 못함 · 추정).
  //   이 표지 뒤로 끝 표지가 없으면 ‘결과 모름’ 이다(begun 과 같음).
  'echo "##KL commit" || exit 3',
  'if [ -e "$f" ]; then [ "$(cksum < "$f")" = "$c0" ] || { echo "##KL fail changed"; exit 3; }; else [ -z "$c0" ] || { echo "##KL fail changed"; exit 3; }; fi',
  'mv -f "$tmp" "$f" || { echo "##KL fail rename"; exit 3; }',
  'if command -v restorecon >/dev/null 2>&1; then if [ -n "${mkd:-}" ]; then restorecon -F "$d" >/dev/null 2>&1; fi; restorecon -F "$f" >/dev/null 2>&1; fi',
  'post || { echo "##KL fail raced"; exit 3; }',
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
  const CLS = `${STRIP} index(t, b) == 0 { next } index(t, m) > 0 { if (t == L) ex++; else if (index(t, ty " ") == 1) un++; else if (t ~ /^from="[0-9A-Fa-f.:]+",no-agent-forwarding,no-port-forwarding,no-X11-forwarding /) sd++; else cu++; next } { um++ } END { printf "%d %d %d %d %d %d", NR, ex + 0, un + 0, sd + 0, cu + 0, um + 0 }`;
  const OLD = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { print $0 }`;
  const DROPM = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { next } { print }`;
  return [
    ...HEAD,
    `B='${pk.blob}'; M='${mark}'; L='${line}'; TY='${pk.type}'; RP='${replace ? 1 : 0}'`,
    ...CHECKS(true),
    'cls() {',
    '  st="0 0 0 0 0 0"',
    `  if [ -e "$f" ]; then st=$(awk -v b="$B" -v m="$M" -v L="$L" -v ty="$TY" '${CLS}' "$f") || { echo "##KL fail read"; exit 3; }; fi`,
    '  set -- $st; nr=$1; ex=$2; un=$3; sd=$4; cu=$5; um=$6',
    '  act=add',
    '  if [ $((ex + un + sd + cu)) -gt 0 ]; then',
    '    if [ "$cu" -eq 0 ] && [ "$RP" = 1 ] && [ $((un + sd)) -gt 0 ]; then act=replace; else echo "##KL present-marked $um $cu $ex $((un + sd))"; exit 0; fi',
    '  elif [ "$um" -gt 0 ]; then echo "##KL present-unmarked $um 0"; exit 0',
    '  fi',
    '}',
    // 바꿀 것이 없으면(이미 있음) 자물쇠 없이 끝난다 — 쓸 수 없는 ~/.ssh(root 소유)에서도 ‘있음’ 으로 답한다(1회차 축 B 재확인). 바꿀 것이 있으면 자물쇠 안에서 다시 판정한다.
    // 단 **자물쇠 폴더가 없을 때만**(2회차 B1 — 누가 바꾸는 중인데 그 앞의 파일을 보고 답했다). 쓸 수 없는 ~/.ssh 에는 자물쇠가 생길 수 없으니 그 경우는 그대로 빠르다.
    'if [ ! -d "$lk" ] || [ ! -w "$d" ]; then cls; fi',
    ...LOCK,
    ...C0,
    'cls',
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
    `post() { n=$(awk -v L="$L" '${STRIP} t == L { c++ } END { print c + 0 }' "$f") && [ "$n" -ge 1 ]; }`,
    'tailn=1',
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
    'if [ ! -d "$d" ]; then echo "##KL none"; exit 0; fi',
    // 바꿀 것이 없으면(파일 없음 · 그 줄 없음) 자물쇠 없이 답한다 — 쓸 수 없는 ~/.ssh 에서도(1회차 반증 5). 있으면 자물쇠 안에서 다시 본다(B2).
    // 빠른 답은 자물쇠 폴더가 없을 때만(2회차 B1 — 다른 쪽이 바꾸는 중이면 기다렸다 다시 본다).
    'if [ ! -d "$lk" ] || [ ! -w "$d" ]; then',
    '  if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',
    `  st=$(awk -v L="$L" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    '  set -- $st; if [ "$2" -eq 0 ]; then echo "##KL restored 0"; exit 0; fi',
    'fi',
    ...LOCK,
    ...C0,
    'if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',
    `st=$(awk -v L="$L" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    'set -- $st; nr=$1; n=$2',
    'if [ "$n" -eq 0 ]; then echo "##KL restored 0"; exit 0; fi',
    'on=0',
    'if [ -n "$OLD" ]; then command -v base64 >/dev/null 2>&1 || { echo "##KL fail nobase64"; exit 3; }; on=$(printf \'%s\' "$OLD" | base64 -d | awk \'END { print NR }\') || { echo "##KL fail read"; exit 3; }; fi',
    `keep() { awk -v L="$L" '${DROPL}' "$f"; }`,
    'if [ "$on" -gt 0 ]; then extra() { printf \'%s\' "$OLD" | base64 -d; }; else extra() { :; }; fi',
    // 되살린 옛 줄 안에 원하는 줄과 같은 줄이 있을 수 있다 — 기대값은 ‘옛 줄 안의 L 수’(1회차 B8 — 0 을 기대해 제대로 되돌리고도 raced 라고 했다).
    `ol=0; if [ "$on" -gt 0 ]; then ol=$(printf '%s' "$OLD" | base64 -d | awk -v L="$L" '${STRIP} t == L { c++ } END { print c + 0 }'); fi`,
    `post() { n2=$(awk -v L="$L" '${STRIP} t == L { c++ } END { print c + 0 }' "$f") && [ "$n2" -eq "$ol" ]; }`,
    'exp=$((nr - n + on)); tailn=$on',
    ...COMMIT,
    'echo "##KL restored $n"',
  ].join('\n');
}

/**
 * 키 거두기 — 그 공개키의 **포탈 줄**(공개키 + 포탈 표식 — 어느 키 id 든)만 모두 지운다. 표식 없는 같은 키 줄(사람이 넣은 줄)은 남기고 수를 알린다.
 * 키 id 를 가리지 않는 것은 지웠다 다시 등록한 키(새 id)의 거두기가 옛 id 로 넣은 포탈 줄을 남기던 것(반증 R10) 때문이다 — 같은 공개키이므로 같은 키다.
 * 결과: `##KL removed <지운 수> unmarked <남긴 수>` · `##KL none`(파일 없음) · `##KL fail <사유>`(심볼릭 링크 · 못 읽음 · 못 씀 · 경합 포함 — ‘없음’ 이 아니다).
 */
export function removeScript({ publicKey, keyId } = {}) {
  const pk = splitPublicKey(publicKey); const mark = markOf(keyId);
  if (!pk || !mark) return null;
  const anyMark = ` ${PORTAL_MARK}k_`;
  const CNT = `${STRIP} index(t, b) == 0 { next } index(t, m) > 0 { n++; next } { u++ } END { printf "%d %d %d", NR, n + 0, u + 0 }`;
  const DROPM = `${STRIP} index(t, b) > 0 && index(t, m) > 0 { next } { print }`;
  return [
    ...HEAD,
    `B='${pk.blob}'; M='${anyMark}'`,
    ...CHECKS(false),
    'if [ ! -d "$d" ]; then echo "##KL none"; exit 0; fi',
    // 지울 것이 없으면 자물쇠 없이 답한다(1회차 반증 5 — root 소유 ~/.ssh 의 비 root 계정에서 ‘실패’ 로 답했다). 있으면 자물쇠 안에서 다시 본다(B2).
    // 빠른 답은 **자물쇠 폴더가 없을 때만**(2회차 B1 — 시한을 넘긴 넣기가 서버에서 아직 자물쇠를 쥐고 있는데 긴급 거두기가 ‘줄 없음’ 으로 끝나고, 그 뒤 키가 들어갔다).
    'if [ ! -d "$lk" ] || [ ! -w "$d" ]; then',
    '  if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',
    `  st=$(awk -v b="$B" -v m="$M" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    '  set -- $st; if [ "$2" -eq 0 ]; then echo "##KL removed 0 unmarked $3"; exit 0; fi',
    'fi',
    ...LOCK,
    ...C0,
    'if [ ! -e "$f" ]; then echo "##KL none"; exit 0; fi',   // 자물쇠를 잡은 뒤 다시 본다(1회차 B2 — 처음 넣기와 겹친 거두기가 ‘없음’ 으로 끝나고 키가 들어갔다)
    `st=$(awk -v b="$B" -v m="$M" '${CNT}' "$f") || { echo "##KL fail read"; exit 3; }`,
    'set -- $st; nr=$1; n=$2; u=$3',
    'if [ "$n" -eq 0 ]; then echo "##KL removed 0 unmarked $u"; exit 0; fi',
    `keep() { awk -v b="$B" -v m="$M" '${DROPM}' "$f"; }`,
    'extra() { :; }',
    `post() { n2=$(awk -v b="$B" -v m="$M" '${STRIP} index(t, b) > 0 && index(t, m) > 0 { c++ } END { print c + 0 }' "$f") && [ "$n2" -eq 0 ]; }`,
    'exp=$((nr - n)); tailn=0',
    ...COMMIT,
    'echo "##KL removed $n unmarked $u"',
  ].join('\n');
}

/** 서버가 본 이 접속의 출발지 주소. */
export const WHOAMI_SCRIPT = 'echo "##KL ip ${SSH_CONNECTION%% *}"';

/** 표지 줄 읽기(마지막 `##KL …` 한 줄 — 로그인 배너가 앞에 섞여도). 모르는 사유 글자는 'unknown'. */
const FAIL_WHY = new Set(['nohome', 'symlink', 'notdir', 'mkdir', 'notfile', 'unreadable', 'notwritable', 'read', 'write', 'verify', 'rename', 'nobase64', 'toolong', 'locked', 'raced', 'locklost', 'changed', 'slow', 'noaccess']);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
export function parseMarker(stdout) {
  const lines = String(stdout || '').slice(-200_000).split('\n').map((x) => x.trim()).filter((x) => x.startsWith('##KL '));
  const last = lines[lines.length - 1] || '';
  const w = last.split(' ');
  if (w[1] === 'begin' || w[1] === 'commit') return { kind: 'begun' };   // 시작했는데(또는 바꾸기 직전인데) 끝 표지가 없다 — 결과 모름(B5 · 2회차 반증 R2R-3)
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
  unreadable: 'authorized_keys 를 읽을 수 없어(권한) 건드리지 않았습니다.', noaccess: '홈 또는 ~/.ssh 폴더를 이 계정으로 열 수 없어(권한) authorized_keys 가 있는지 알 수 없습니다 — 건드리지 않았습니다(‘줄 없음’ 이 아닙니다).', notwritable: 'authorized_keys(또는 ~/.ssh)에 이 계정이 쓸 수 없어(관리자가 잠가 둠) 건드리지 않았습니다.', read: 'authorized_keys 를 읽지 못했습니다.',
  write: '임시 파일을 쓰지 못했습니다(권한 · 디스크) — 원래 파일은 그대로입니다.', verify: '새로 쓴 내용이 예상과 달라(디스크 가득 등) 바꾸지 않았습니다 — 원래 파일은 그대로입니다.',
  rename: '새 파일로 바꾸지 못했습니다 — 원래 파일은 그대로입니다.',
  locked: '다른 작업이 이 서버의 authorized_keys 를 바꾸는 중이라 기다리다 그만뒀습니다 — 원래 파일은 그대로입니다. 잠시 뒤 다시 하세요(남은 자물쇠 ~/.ssh/.authorized_keys.portal.lock 는 주인이 없으면 다음 작업이 치웁니다).',
  locklost: '작업 중에 자물쇠를 다른 쪽이 가져가 바꾸지 않았습니다 — 원래 파일은 그대로입니다. 잠시 뒤 다시 하세요.',
  changed: '그 사이 다른 쪽(사람 · 구성 관리 도구)이 authorized_keys 를 바꿔 바꾸지 않았습니다 — 원래 파일은 그대로입니다. 다시 하세요.',
  slow: `서버에서 스크립트가 시작한 지 ${SCRIPT_DEADLINE_S}초 안에 바꾸기까지 가지 못해 멈췄습니다(서버가 느림 · 자물쇠를 오래 기다림) — 원래 파일은 그대로입니다. 잠시 뒤 다시 하세요.`,
  raced: '바꾼 직후 다시 읽어 보니 다른 쪽(사람 · 구성 관리 도구)이 그 사이 파일을 바꿔 원하는 상태가 아닙니다 — 서버에 들어 있는 키를 다시 읽어 확인하세요.', nobase64: '서버에 base64 명령이 없어 처리하지 않았습니다.', toolong: '바꿀 포탈 줄이 너무 많아 처리하지 않았습니다.',
  unknown: '서버가 예상한 답을 주지 않았습니다.',
});
export const failText = (why) => (Object.hasOwn(FAIL_TEXT, why) ? FAIL_TEXT[why] : FAIL_TEXT.unknown);
