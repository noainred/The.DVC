# shellcheck shell=bash
#
# 오프라인 설치 패키지 서명 확인(검토 S-10, v2.730) — install.sh 가 source 한다.
#
# 기존 설치본(신뢰하는 코드)이 있으면 **그 설치본의** Node 런타임·확인 도구(server/src/upgrade/verifyCli.js)·신뢰 공개키
# (+ CONFIG_DIR/release-signing-keys.conf)로 새 패키지 파일과 서명 manifest 를 확인한다 — 포탈 안의 자동 업그레이드와
# **같은 판정 함수**다. 통과하지 못하면 아무것도 바꾸기 전에 멈춘다.
#
# ⚠ 정직한 한계: 이 함수는 새 패키지 안의 install.sh 가 부른다. 패키지 자체를 바꾼 공격자는 install.sh 도 바꿀 수 있으므로,
#   진짜 확인은 **풀기 전에** 기존 설치본의 도구로 하는 것이다:
#     sudo vmware-portal-verify --file <패키지.tar.gz> --manifest vmware-portal-<버전>.manifest.json   (root 소유 사본 — v2.741)
#   이 자동 확인은 '잘못 받은 패키지'·'보관 중 손상·변조' 를 잡는 두 번째 그물이다(docs/RELEASE-SIGNING.md).
#
# ── root 소유 도구(v2.741 감사 INJPKG-01) ─────────────────────────────────────────────────────────────────────
# 서비스 계정(vmportal)은 $PREFIX·$CONFIG_DIR 를 쓸 수 있다(install.sh 의 chown -R · 유닛 ReadWritePaths). 그래서 root 가 그 트리의
#   스크립트·node 를 실행하거나 그 트리의 파일을 신뢰 기준으로 읽으면, 서비스 계정 권한을 얻은 공격자가 root 로 올라가거나
#   서명 확인을 무력화할 수 있다(예전 /usr/local/bin/vmware-portal-* 는 앱 트리의 .sh 를 가리키는 링크였다). 규칙:
#   ① root 로 부르는 래퍼(vmware-portal-otp·-users·-verify)는 앱 트리 밖 root 소유 사본(vp_root_tools_dir)이다.
#      otp·users 래퍼는 앱 트리를 읽기 전에 서비스 계정으로 권한을 내린다(재시작만 root 사본이 한다).
#   ② 서명 확인 도구(node·server/src·공개키 목록)는 root 소유 사본(<도구 폴더>/verify)만 신뢰 기준으로 쓴다 — 그 사본은
#      install.sh 가 **방금 확인한 패키지**에서 만든다(서비스 계정이 쓸 수 있는 앱 트리에서 복사하지 않는다).
#   ③ root 로 읽는 portal.env 정책·호스트 키 파일은 uid 0 소유일 때만 받는다(호스트 키 파일은 signature.js 가 판정).
#   ④ (v2.742 INJPKG-01) 호스트 키 파일은 서비스 계정 소유 CONFIG_DIR 안에 있어 root 소유여도 지워지거나 바꿔치기될 수 있다 —
#      install.sh 가 그 파일의 root 소유 사본을 <도구 폴더>/trust/ 에 두고(vp_stage_trust_copy), root 로 도는 확인은 그 사본의
#      **회수 항목**을 함께 합친다(env VP_ROOT_TRUST_COPY → signature.js). 원본을 지워도 회수가 사라지지 않는다.
#   ⚠ 정직한 한계: 사본은 install.sh 를 실행할 때만 바뀐다 — 앱 안 업그레이드(서비스 계정)로 들어온 새 공개키 목록은
#     다음 install.sh 실행 전까지 root 확인에 반영되지 않는다(서비스 계정이 root 신뢰 기준을 바꿀 수 없게 한 대가).
#     호스트 키 파일의 회수를 **푼** 경우도 같다 — 지난 사본의 회수가 다음 install.sh 까지 남는다(지우려면 사본을 root 가 직접 지운다).
VP_ROOT_TOOLS_BASE_DEFAULT=/usr/local/libexec/vmware-portal
# vp_root_tools_dir <prefix> — 그 설치본의 root 소유 도구 폴더(설치본마다 따로 — prefix 를 그대로 잇는다).
vp_root_tools_dir() { printf '%s%s\n' "${VP_ROOT_TOOLS_BASE:-$VP_ROOT_TOOLS_BASE_DEFAULT}" "$1"; }
# 호스트 키 파일 이름 — signature.js HOST_KEYS_NAME 과 같다. 사본은 <도구 폴더>/trust/ 에 같은 이름으로 둔다.
VP_HOST_KEYS_NAME=release-signing-keys.conf

# vp_path_root_only <경로> — 경로와 그 위 모든 폴더가 root 소유이고 그룹·기타가 쓸 수 없는가(sticky 폴더 /tmp 는 허용 —
#   남이 root 항목을 바꾸거나 지울 수 없다). 하나라도 아니면 그 경로는 서비스 계정이 갈아끼울 수 있다.
vp_path_root_only() {
  local p st uid mode
  p="$(readlink -f -- "$1" 2>/dev/null)" || return 1
  [[ "$p" == /* ]] || return 1
  while :; do
    st="$(stat -c '%u %a' -- "$p" 2>/dev/null)" || return 1
    uid="${st%% *}"; mode="${st##* }"
    [[ "$uid" == 0 ]] || return 1
    if (( 8#$mode & 8#022 )) && ! (( 8#$mode & 8#1000 )); then return 1; fi
    [[ "$p" == / ]] && return 0
    p="$(dirname -- "$p")"
  done
}

# vp_tree_root_only <폴더> — 그 아래 전부가 root 소유 · 그룹/기타 쓰기 없음 · 심볼릭 링크 없음.
vp_tree_root_only() {
  local bad
  [[ -d "$1" ]] || return 1
  bad="$(find "$1" \( -type l -o ! -uid 0 -o -perm /022 \) -print -quit 2>/dev/null)" || return 1
  [[ -z "$bad" ]]
}

# vp_anchor_ok <도구 폴더> — root 소유 서명 확인 사본을 신뢰 기준으로 쓸 수 있는가.
vp_anchor_ok() {
  local v="$1/verify"
  [[ -x "$v/node" && -f "$v/server/src/upgrade/verifyCli.js" ]] || return 1
  vp_path_root_only "$v" && vp_tree_root_only "$v"
}

# vp_path_controllers <절대 경로> — 그 경로를 찾아가는 길 전체를 root 말고 누가 바꿀 수 있는가(v2.744 최종 수정분 검토 VERIFY-01).
#   / 부터 모든 폴더·링크·마지막 항목을 lstat 으로 한 단계씩 본다 — 링크를 무작정 따라가지 않고, 링크를 만나면 그 링크(소유자) 다음에
#   **링크 대상의 길**을 이어서 본다(vp_path_root_only 의 readlink -f 는 '링크가 놓인 폴더' 를 보지 않는다 — 서비스 계정 폴더 안의 링크가
#   root 소유 폴더를 가리키면 통과했다).
#   반환 0 = 판정함 — stdout 에 그 길의 비-root 소유자 'uid:gid'(uid 기준 중복 없이 처음 나온 순서 · 공백 구분 · 비었으면 root 만 바꿀 수 있다).
#   반환 1 = 판정할 수 없음 — stdout 에 사유: 'stat:<경로>'(확인 실패) · 'writable:<경로>'(그룹·기타가 쓸 수 있다 — 소유자 밖의 계정도
#            바꿀 수 있다. sticky 폴더는 남의 항목을 바꾸지 못하므로 허용) · 'loop:<경로>'(링크 40단계 초과) · 'relative'(절대 경로가 아님).
vp_path_controllers() {
  local p="${1:-}" cur="" nxt="/" comp="" st="" uid="" gid="" mode="" typ="" t="" hops=0 seen=" " i=0 sticky=0 res=""
  local -a todo=() lt=()
  if [[ "$p" != /* ]]; then printf 'relative'; return 1; fi
  IFS=/ read -r -a todo <<< "${p#/}"
  while :; do
    if ! st="$(stat -c '%u %g %a %F' -- "$nxt" 2>/dev/null)"; then printf 'stat:%s' "$nxt"; return 1; fi
    read -r uid gid mode typ <<< "$st"
    if [[ "$uid" != 0 && "$seen" != *" $uid:"* ]]; then seen+="$uid:$gid "; fi
    if [[ "$typ" == symbolic* ]]; then
      hops=$((hops + 1))
      if (( hops > 40 )); then printf 'loop:%s' "$nxt"; return 1; fi
      if ! t="$(readlink -- "$nxt")"; then printf 'stat:%s' "$nxt"; return 1; fi
      if [[ "$t" == /* ]]; then cur=""; fi
      lt=()
      IFS=/ read -r -a lt <<< "${t#/}"
      todo=("${lt[@]}" "${todo[@]:i}"); i=0
    else
      sticky=0
      if [[ "$typ" == directory ]] && (( 8#$mode & 8#1000 )); then sticky=1; fi
      if (( 8#$mode & 8#022 )) && (( sticky == 0 )); then printf 'writable:%s' "$nxt"; return 1; fi
      cur="${nxt%/}"
    fi
    nxt=""
    while (( i < ${#todo[@]} )); do
      comp="${todo[i]}"; i=$((i + 1))
      case "$comp" in
        ''|.) ;;
        ..) cur="${cur%/*}" ;;
        *) nxt="$cur/$comp"; break ;;
      esac
    done
    if [[ -z "$nxt" ]]; then break; fi
  done
  res="${seen# }"; printf '%s' "${res% }"
  return 0
}

# vp_path_controllers_text <사유> — vp_path_controllers 의 판정 불가 사유를 사람이 읽는 문장으로.
vp_path_controllers_text() {
  case "${1:-}" in
    stat:*) printf '%s 를 확인하지 못했습니다' "${1#stat:}" ;;
    writable:*) printf '%s 를 그룹·기타가 쓸 수 있습니다(소유자 밖의 계정도 바꿀 수 있다)' "${1#writable:}" ;;
    loop:*) printf '%s 에서 링크가 너무 많이 이어집니다' "${1#loop:}" ;;
    relative) printf '절대 경로가 아닙니다' ;;
    *) printf '경로를 판정하지 못했습니다(%s)' "${1:-?}" ;;
  esac
}

# vp_policy_reader <후보 node>… — root 로 portal.env 를 읽을 때 실행해도 되는 node 하나(v2.744 최종 수정분 검토 VERIFY-02).
#   후보 가운데 **길 전체가 root 전용**(vp_path_controllers 가 비-root 소유자 없이 판정)이고 실행할 수 있는 첫 node 를 돌려준다. 없으면 빈 값 —
#   호출부는 node 없이(vp_safe_read 의 시한 있는 한 번 열기) 읽는다. 예전에는 서비스 계정이 바꿀 수 있는 옛 설치본 node 를 정책 한 줄을
#   읽으려고 root 로 실행했다(--skip-signature-check 로 도구를 실행하지 않는 경로에서도).
vp_policy_reader() {
  local n c
  for n in "$@"; do
    [[ -n "$n" && -x "$n" ]] || continue
    if c="$(vp_path_controllers "$n")" && [[ -z "$c" ]]; then printf '%s' "$n"; return 0; fi
  done
  return 0
}

# vp_root_read <파일> <node> [사본 경로] — root 로 도는 확인이 서비스 계정이 쓸 수 있는 파일을 **한 번만** 연다(v2.744 최종 검토 — RZ-REV-03 의 형제).
#   `[[ -f && ! -L ]]` 로 확인한 뒤 bash 로 다시 열면 그 사이에 FIFO 로 바꿔 root 를 무기한 매달리게 하거나(열기가 막힌다) 링크로 바꿔
#   따라가게 할 수 있다. node 가 O_NOFOLLOW·O_NONBLOCK·O_NOCTTY 로 한 번 열고, 연 fd 로 일반 파일·하드 링크 없음·크기 상한을 본 뒤 그 fd 에서 읽는다.
#   ⚠ node 는 **root 로 실행해도 되는 것**만 넘긴다(root 소유 확인 사본 · 길 전체가 root 전용인 node — vp_policy_reader). 이 함수가 그 node 를 실행한다.
#   stdout 첫 줄 = '<소유 uid> <권한 8진>'. 사본 경로를 주면 내용은 그 파일(새로 만든다 — O_EXCL)에, 안 주면 첫 줄 뒤에 그대로 싣는다.
#   반환 0 = 읽음 · 10 = 일반 파일이 아님(링크·FIFO·폴더·장치·소켓·하드 링크·상한 초과) · 11 = 파일 없음 ·
#        12 = 그 밖의 열기·읽기·사본 쓰기 오류(권한 없음 EACCES · 경로 중간이 폴더가 아님 ENOTDIR 등 — v2.744 최종 수정분 검토 VERIFY-04:
#             예전에는 10 으로 접어 '링크·FIFO·장치' 라는 틀린 원인을 말했다) · 3 = node 없음(실행 불가) · 그 밖 = node 비정상 종료.
#   실패(10·11·12)면 stdout 에 사유 한 마디 — 'link' · 'notreg' · 'nlink:<수>' · 'size:<바이트>' · 'absent' · 'open:<코드>' · 'io:<코드>' · 'dst:<코드>'.
vp_root_read() {
  local f="$1" node="$2" out="${3:-}" r=0
  [[ -n "$node" && -x "$node" ]] || return 3
  "$node" -e 'const fs=require("fs"),C=fs.constants;const a=process.argv.slice(1);const src=a[0],max=Number(a[1]),out=a[2]||"";
const q=(m,c)=>{process.stdout.write(String(m));process.exit(c)};
let fd,st,buf,off=0;
try{fd=fs.openSync(src,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|C.O_NOCTTY)}catch(e){const c=e.code||"error";
if(c==="ENOENT")q("absent",11);if(c==="ELOOP")q("link",10);if(c==="ENXIO"||c==="EISDIR"||c==="EAGAIN"||c==="EWOULDBLOCK")q("notreg",10);q("open:"+c,12)}
try{st=fs.fstatSync(fd)}catch(e){q("io:"+(e.code||"error"),12)}
if(!st.isFile())q("notreg",10);if(st.nlink!==1)q("nlink:"+st.nlink,10);if(!(st.size<=max))q("size:"+st.size,10);
try{buf=Buffer.alloc(st.size);while(off<st.size){const n=fs.readSync(fd,buf,off,st.size-off,off);if(n<=0)break;off+=n}}catch(e){q("io:"+(e.code||"error"),12)}
const head=st.uid+" "+(st.mode&0o7777).toString(8)+"\n";
if(out){try{const o=fs.openSync(out,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o644);fs.writeSync(o,buf,0,off);fs.closeSync(o)}catch(e){q("dst:"+(e.code||"error"),12)}process.stdout.write(head)}
else{process.stdout.write(head);process.stdout.write(buf.subarray(0,off))}' "$f" "${VP_ROOT_READ_MAX_BYTES:-16777216}" ${out:+"$out"} || r=$?
  return $r
}

# vp_safe_read <파일> [node] [권한을 내릴 uid:gid] — 서비스 계정이 쓸 수 있는 파일을 **한 번만** 열어 읽는다(v2.744 최종 수정분 검토 VERIFY-03·06).
#   node 를 주면 vp_root_read 다. node 가 없거나(3) 비정상 종료하면 예전처럼 '확인 뒤 bash 로 다시 열기'(시한 없음 — 그 사이 FIFO 로 바꾸면
#   root 가 무기한 매달렸다)를 하지 않고, lstat 확인 뒤 **시한(VP_ROOT_READ_TIMEOUT 초, 기본 10) 안에서** bash 가 한 번 열고 연 fd 의
#   종류·링크 수·inode(지금 그 경로에 있는 파일과 같은가 — 링크로 바꿔치기했으면 다르다)·크기를 본 뒤 그 fd 에서 읽는다.
#   uid:gid 를 주면(root 일 때만 뜻이 있다) 그 시한 있는 읽기를 그 계정 권한으로 한다 — root 가 서비스 계정 경로를 직접 열지 않게.
#   ⚠ 정직한 한계: node 없는 경로는 bash 의 열기가 링크를 따라간다 — 확인과 열기 사이(수 마이크로초)에 링크로 바꾸면 그 대상을 한 번 연 뒤
#     inode 가 달라 버린다(내용은 쓰지 않는다). 권한을 내릴 계정이 없는 root 분기(옛 패키지 신뢰 경로)에서만 root 가 연다.
#   stdout·반환은 vp_root_read 와 같다(+ 124 = 시한 초과 · 사유 'open:no-timeout'(timeout 명령 없음)·'open:no-drop'(권한을 내릴 수 없음)).
vp_safe_read() {
  local f="$1" node="${2:-}" as="${3:-}" out="" r=0 err="" u="" max="${VP_ROOT_READ_MAX_BYTES:-16777216}" secs="${VP_ROOT_READ_TIMEOUT:-10}"
  local -a pre=()
  if [[ -n "$node" ]]; then
    if out="$(vp_root_read "$f" "$node")"; then printf '%s' "$out"; return 0; else r=$?; fi
    case "$r" in 10|11|12) printf '%s' "$out"; return "$r" ;; esac
    # 3 = node 를 실행할 수 없다 · 그 밖 = node 비정상 종료 — 아래 시한 있는 한 번 열기로(사유는 호출부가 묻지 않는다)
  fi
  [[ "$max" =~ ^[0-9]+$ ]] || max=16777216
  [[ "$secs" =~ ^[1-9][0-9]*$ ]] || secs=10
  if ! err="$(LC_ALL=C stat -c '%F' -- "$f" 2>&1)"; then
    case "$err" in
      *"No such file"*) printf 'absent'; return 11 ;;
      *"Not a directory"*) printf 'open:ENOTDIR'; return 12 ;;
      *"Permission denied"*) printf 'open:EACCES'; return 12 ;;
      *) printf 'open:stat'; return 12 ;;
    esac
  fi
  case "$err" in
    symbolic*) printf 'link'; return 10 ;;
    regular*) ;;
    *) printf 'notreg'; return 10 ;;
  esac
  if ! command -v timeout >/dev/null 2>&1; then printf 'open:no-timeout'; return 12; fi
  if [[ -n "$as" && "$(id -u)" == 0 ]]; then
    if command -v setpriv >/dev/null 2>&1; then pre=(setpriv --reuid="${as%%:*}" --regid="${as##*:}" --clear-groups --)
    elif command -v runuser >/dev/null 2>&1 && u="$(getent passwd "${as%%:*}" | cut -d: -f1)" && [[ -n "$u" ]]; then pre=(runuser -u "$u" --)
    else printf 'open:no-drop'; return 12
    fi
  fi
  r=0
  ( cd / && exec timeout -k 2 "$secs" "${pre[@]}" bash -c 'f=$1; max=$2
if ! exec 3<"$f"; then if [ -r "$f" ]; then printf "open:error"; else printf "open:EACCES"; fi; exit 12; fi
a=$(stat -L -c "%d:%i %u %a %h %s %F" /dev/fd/3 2>/dev/null) || { printf "io:stat"; exit 12; }
b=$(stat -c "%d:%i" -- "$f" 2>/dev/null) || { printf "notreg"; exit 10; }
read -r id uid mode nl sz typ <<< "$a"
case "$typ" in regular*) ;; *) printf "notreg"; exit 10 ;; esac
[ "$id" = "$b" ] || { printf "notreg"; exit 10; }
[ "$nl" = 1 ] || { printf "nlink:%s" "$nl"; exit 10; }
[ "$sz" -le "$max" ] || { printf "size:%s" "$sz"; exit 10; }
printf "%s %s\n" "$uid" "$mode"
head -c "$max" <&3' _ "$f" "$max" 2>/dev/null ) || r=$?
  return $r
}

# vp_root_read_text <파일> <반환 코드> <사유 한 마디> — vp_root_read·vp_safe_read 실패를 **실제 원인**대로 말한다(v2.744 최종 수정분 검토 VERIFY-04).
vp_root_read_text() {
  local f="$1" rc="$2" why="${3:-}" c=""
  case "$rc:$why" in
    10:link) printf '%s 는 심볼릭 링크라 따라가 읽지 않습니다' "$f" ;;
    10:nlink:*) printf '%s 는 하드 링크라(링크 수 %s) 읽지 않습니다' "$f" "${why#nlink:}" ;;
    10:size:*) printf '%s 가 크기 상한(%s바이트)을 넘어(%s바이트) 읽지 않습니다' "$f" "${VP_ROOT_READ_MAX_BYTES:-16777216}" "${why#size:}" ;;
    10:*) printf '%s 가 일반 파일이 아니거나(FIFO·폴더·장치·소켓) 확인 사이에 바뀌어 읽지 않습니다' "$f" ;;
    12:open:no-timeout) printf 'timeout 명령이 없어 %s 를 시한 없이 열지 않습니다' "$f" ;;
    12:open:no-drop) printf 'setpriv·runuser 가 없어 권한을 내려 %s 를 열 수 없습니다 — root 로 열지 않습니다' "$f" ;;
    12:open:*)
      c="${why#open:}"
      case "$c" in
        EACCES|EPERM) printf '%s 를 열 권한이 없습니다(%s — 이 계정은 그 파일이나 폴더를 읽을 수 없습니다)' "$f" "$c" ;;
        ENOTDIR) printf '%s 의 경로 중간이 폴더가 아니라 열 수 없습니다(ENOTDIR)' "$f" ;;
        ENAMETOOLONG) printf '%s 의 경로가 너무 길어 열 수 없습니다(ENAMETOOLONG)' "$f" ;;
        *) printf '%s 를 열지 못했습니다(%s)' "$f" "$c" ;;
      esac ;;
    12:io:*) printf '%s 를 읽는 중 오류가 났습니다(%s)' "$f" "${why#io:}" ;;
    12:dst:*) printf '%s 의 사본을 쓰지 못했습니다(%s)' "$f" "${why#dst:}" ;;
    124:*|137:*) printf '%s 를 읽는 데 시한(%s초)을 넘겨 끊었습니다(확인 사이에 FIFO 등으로 바뀌었을 수 있다)' "$f" "${VP_ROOT_READ_TIMEOUT:-10}" ;;
    *) printf '%s 를 읽지 못했습니다(코드 %s)' "$f" "$rc" ;;
  esac
}

# vp_root_env_policy <config_dir> [node] — portal.env 의 UPGRADE_SIGNATURE_POLICY 를 **root 소유이고 그룹·기타가 쓸 수 없는 파일일 때만** 돌려준다.
#   연 파일(fd)의 소유자·권한을 보므로 확인 뒤 바꿔치기가 끼어들지 않는다. 믿을 수 없으면 값을 쓰지 않고 한 줄 알린다(stderr).
#   v2.744: 한 번만 연다(vp_safe_read — node 가 있으면 vp_root_read, 없거나 비정상 종료면 시한 있는 한 번 열기).
#   v2.744(최종 수정분 검토 VERIFY-05): 권한도 본다 — root 소유라도 그룹·기타가 쓸 수 있으면(root:vmportal 0660 등) 서비스 계정이 정책을
#     warn 으로 낮출 수 있었다. 형제 vp_stage_trust_copy · install.sh vp_rma_env_request 와 같은 '& 022' 판정이다.
#   ⚠ node 는 root 로 실행해도 되는 것만 넘긴다(vp_policy_reader) — 이 함수가 그 node 를 실행한다.
vp_root_env_policy() {
  local f="$1/portal.env" node="${2:-}" res="" rc=0 st="" uid="" mode="" body="" v="" re=$'(^|\n)UPGRADE_SIGNATURE_POLICY='
  if res="$(vp_safe_read "$f" "$node")"; then rc=0; else rc=$?; fi
  case "$rc" in
    0) ;;
    11) return 0 ;;
    *) echo "ⓘ $(vp_root_read_text "$f" "$rc" "$res") — 그 안의 UPGRADE_SIGNATURE_POLICY 를 root 확인에 쓰지 않습니다." >&2; return 0 ;;
  esac
  st="${res%%$'\n'*}"; uid="${st%% *}"; mode="${st##* }"
  if [[ "$res" == *$'\n'* ]]; then body="${res#*$'\n'}"; fi
  if [[ "$uid" == 0 && "$mode" =~ ^[0-7]+$ ]] && ! (( 8#$mode & 8#022 )); then
    v="$(printf '%s\n' "$body" | grep -E '^UPGRADE_SIGNATURE_POLICY=' 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  elif [[ "$body" =~ $re ]]; then
    if [[ "$uid" == 0 ]]; then
      echo "ⓘ $f 는 root 소유지만 그룹·기타가 쓸 수 있어(권한 $mode — 서비스 계정이 쓸 수 있다) 그 안의 UPGRADE_SIGNATURE_POLICY 를 root 확인에 쓰지 않습니다(sudo chmod go-w 로 고치세요)." >&2
    else
      echo "ⓘ $f 는 root 소유가 아니라(서비스 계정이 쓸 수 있다) 그 안의 UPGRADE_SIGNATURE_POLICY 를 root 확인에 쓰지 않습니다." >&2
    fi
  fi
  printf '%s' "$v"
  return 0
}

# vp_as_user <계정> 명령… — 권한을 그 계정으로 내린 뒤 실행한다(runuser → setpriv). 터미널이면 새 pty 를 만든다
#   (낮은 권한 프로세스가 root 의 터미널에 입력을 밀어 넣지 못하게 — runuser --pty). 내릴 수 없으면 실행하지 않는다.
vp_as_user() {
  local u="$1"; shift
  if command -v runuser >/dev/null 2>&1; then
    local pty=()
    if [[ -t 0 && -t 1 ]] && runuser --help 2>&1 | grep -q -- '--pty'; then pty=(--pty); fi
    runuser -u "$u" "${pty[@]}" -- "$@"
  elif command -v setpriv >/dev/null 2>&1; then
    setpriv --reuid="$(id -u "$u")" --regid="$(id -g "$u")" --init-groups -- "$@"
  else
    echo "✖ runuser·setpriv 가 없어 '$u' 계정으로 권한을 내릴 수 없습니다 — root 로 앱 트리를 실행하지 않습니다." >&2
    return 126
  fi
}

# vp_write_launcher <파일> <종류 otp|users|verify> <prefix> <서비스 계정> <서비스 이름> <config_dir> <도구 폴더>
#   root 소유 래퍼를 만든다. 값은 printf %q 로 넣고, 판정 함수는 이 파일의 정의를 그대로 싣는다(declare -f — 사본을 두 벌 두지 않는다).
vp_write_launcher() {
  local out="$1" kind="$2" prefix="$3" user="$4" svc="$5" cdir="$6" tools="$7" tool=""
  case "$kind" in otp) tool=otp-enroll.sh ;; users) tool=user-admin.sh ;; verify) tool="" ;; *) return 1 ;; esac
  {
    echo '#!/bin/bash'
    echo "# vmware-portal root 래퍼($kind) — install.sh 가 만든 root 소유 사본(v2.741 감사 INJPKG-01). 손으로 고치지 마세요."
    echo "# VP_LAUNCHER_PREFIX=$prefix"
    echo '# 앱 트리(<prefix>/app)·런타임은 서비스 계정이 쓸 수 있다 — root 로 그 파일을 읽거나 실행하지 않는다.'
    echo 'set -uo pipefail'
    printf 'PREFIX=%q\nSERVICE_USER=%q\nSERVICE_NAME=%q\nCONFIG_DIR=%q\nTOOLS=%q\nTOOL=%q\nKIND=%q\n' "$prefix" "$user" "$svc" "$cdir" "$tools" "$tool" "$kind"
    declare -f vp_as_user vp_root_read vp_safe_read vp_root_read_text vp_root_env_policy vp_path_root_only vp_tree_root_only vp_anchor_ok
    cat <<'BODY'
if [[ "$KIND" == verify ]]; then
  # 서명 확인 — root 소유 사본(node·server/src·공개키 목록)만 신뢰 기준으로 쓴다.
  if ! vp_anchor_ok "$TOOLS"; then
    echo "✖ root 소유 서명 확인 도구가 없거나 안전하지 않습니다($TOOLS/verify) — install.sh 로 다시 설치하세요." >&2
    exit 2
  fi
  POLICY="${UPGRADE_SIGNATURE_POLICY:-}"
  [[ -n "$POLICY" ]] || POLICY="$(vp_root_env_policy "$CONFIG_DIR" "$TOOLS/verify/node")"
  # v2.742(INJPKG-01): 호스트 키 파일의 root 소유 사본 — 그 회수 항목을 함께 합친다(없으면 signature.js 가 '없음' 으로 본다).
  exec env CONFIG_DIR="$CONFIG_DIR" UPGRADE_SIGNATURE_POLICY="$POLICY" VP_ROOT_TRUST_COPY="$TOOLS/trust/release-signing-keys.conf" \
    "$TOOLS/verify/node" "$TOOLS/verify/server/src/upgrade/verifyCli.js" "$@"
fi
APP_TOOL="$PREFIX/app/$TOOL"
if [[ "$(id -u)" -ne 0 ]]; then exec /bin/bash "$APP_TOOL" "$@"; fi   # root 가 아니면 권한 경계가 없다 — 앱 트리 래퍼 그대로
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "✖ 서비스 계정 '$SERVICE_USER' 이 없습니다 — root 로 앱 트리를 실행하지 않습니다." >&2; exit 1; }
if [[ "$(id -u "$SERVICE_USER")" -eq 0 ]]; then   # 서비스가 root 로 도는 설치(--user root) — 앱 트리도 root 소유다
  exec env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" VP_LAUNCHER=1 VP_LAUNCHER_CMD="sudo $0" /bin/bash "$APP_TOOL" "$@"
fi
[[ -f "$APP_TOOL" ]] || { echo "✖ 도구를 찾을 수 없습니다: $APP_TOOL" >&2; exit 1; }
cd / 2>/dev/null || true   # root 의 작업 폴더(/root 등)는 서비스 계정이 들어갈 수 없다
vp_as_user "$SERVICE_USER" env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" VP_LAUNCHER=1 VP_LAUNCHER_CMD="sudo $0" /bin/bash "$APP_TOOL" "$@"
rc=$?
if [[ "$KIND" == users && $rc -eq 10 ]]; then
  # 도구가 '지금 재시작' 을 골랐다(종료코드 10) — 재시작만 root 사본이 한다(앱 트리 코드는 root 로 돌지 않는다).
  echo "==> ${SERVICE_NAME} 재시작 중…"
  if systemctl restart "$SERVICE_NAME"; then echo "==> 재시작했습니다."; exit 0; fi
  echo "✖ 재시작에 실패했습니다 — sudo systemctl status ${SERVICE_NAME} 로 확인하세요." >&2; exit 1
fi
exit $rc
BODY
  } > "$out"
  chmod 0755 "$out"
}

# vp_stage_trust_copy <config_dir> <지금 도구 폴더> <새 도구 폴더> <검사용 node>
#   호스트 신뢰 키 파일(<config_dir>/release-signing-keys.conf)의 root 소유 사본을 <새 도구 폴더>/trust/ 에 둔다(v2.742 INJPKG-01).
#   규칙: 원본이 root 소유 · 그룹/기타 쓰기 없음 · JSON 으로 읽히면 그 내용으로 바꾼다(연 파일 fd 에서 읽는다 — 확인 뒤 바꿔치기 차단).
#     원본이 없거나 · root 소유가 아니거나 · 읽히지 않으면 **지난 사본을 그대로** 둔다 — 그 상태는 서비스 계정이 만들 수 있으므로
#     (CONFIG_DIR 를 쓸 수 있다) 원본을 지우는 것만으로 회수가 풀리면 안 된다. 반환 0 = 준비(사본 없음 포함) · 1 = 실패.
vp_stage_trust_copy() {
  local src="$1/$VP_HOST_KEYS_NAME" cur="$2/trust/$VP_HOST_KEYS_NAME" dir="$3/trust" node="$4" st="" rc=0 hdr=""
  local dst="$dir/$VP_HOST_KEYS_NAME" fresh=0 keep="root 소유 사본(회수 목록)을 바꾸지 않습니다 — 지난 사본이 있으면 그대로 둡니다."
  ( umask 022; mkdir -p -- "$dir" ) || return 1
  rm -f -- "$dst.part"
  # v2.744(최종 검토 — RZ-REV-03 의 형제): 확인 뒤 bash 로 다시 열지 않고 vp_root_read 로 한 번만 연다(FIFO 로 바꿔 root 를 매달거나
  #   링크로 바꿔 따라가게 하지 못하게).
  # v2.744(최종 수정분 검토 VERIFY-06): node 를 실행할 수 없으면(없음·실행 불가 마운트·비정상 종료) 원본을 **열지 않는다** — 그때는 아래
  #   JSON 검사도 할 수 없어 사본을 바꿀 수 없는데, 예전 경로는 '확인 뒤 다시 열기'(시한 없음)로 원본을 열어 root 를 매달 수 있었다.
  if [[ -z "$node" || ! -x "$node" ]]; then
    if [[ -e "$src" || -L "$src" ]]; then
      echo "ⓘ 검사용 node(${node:-없음})를 실행할 수 없어 $src 를 읽지 않습니다 — $keep"
    fi
  else
    if hdr="$(vp_root_read "$src" "$node" "$dst.part")"; then rc=0; else rc=$?; fi
    case "$rc" in
      0)
        st="${hdr%%$'\n'*}"
        if [[ "${st%% *}" == 0 && "${st##* }" =~ ^[0-7]+$ ]] && ! (( 8#${st##* } & 8#022 )); then
          if "$node" -e 'const fs=require("fs");const f=process.argv[1];if(fs.statSync(f).size>262144)process.exit(1);const d=JSON.parse(fs.readFileSync(f,"utf8"));if(!d||typeof d!=="object"||Array.isArray(d))process.exit(1)' "$dst.part" 2>/dev/null; then
            fresh=1
          else
            echo "⚠ $src 를 신뢰 키 문서(JSON)로 읽지 못해 root 소유 사본을 바꾸지 않습니다 — 지난 사본이 있으면 그대로 둡니다."
          fi
        else
          echo "ⓘ $src 는 root 소유가 아니거나 그룹·기타가 쓸 수 있어 root 소유 사본(회수 목록)을 바꾸지 않습니다 — 지난 사본이 있으면 그대로 둡니다."
        fi ;;
      11) ;;
      10|12) echo "ⓘ $(vp_root_read_text "$src" "$rc" "$hdr") — $keep" ;;
      *) echo "ⓘ 검사용 node 가 정상 종료하지 않아(코드 $rc) $src 를 읽지 않습니다 — $keep" ;;
    esac
  fi
  if [[ $fresh -eq 1 ]]; then
    mv -f -- "$dst.part" "$dst" || return 1
    echo "==> 호스트 신뢰 키 파일의 root 소유 사본을 만들었습니다: $cur"
    return 0
  fi
  rm -f -- "$dst.part"
  if [[ -f "$cur" ]]; then
    cp -- "$cur" "$dst" || return 1
    [[ -e "$src" || -L "$src" ]] || echo "ⓘ $src 가 없어 지난 root 소유 사본($cur)의 회수 목록을 그대로 둡니다 — 회수를 풀려면 그 사본을 root 가 직접 지우세요(docs/RELEASE-SIGNING.md 8절)."
  fi
  return 0
}

# vp_install_root_tools <prefix> <script_dir> <서비스 계정> <서비스 이름> <config_dir>
#   방금 확인한 패키지(script_dir — root 가 푼 폴더)에서 root 소유 도구 폴더를 새로 만든다(만든 뒤 한 번에 바꾼다).
#   반환 0 = 서명 확인 사본까지 준비됨 · 1 = 래퍼만(사본 실패 — vmware-portal-verify 는 걸지 않는다) · 2 = 실패
vp_install_root_tools() {
  local prefix="$1" sdir="$2" user="$3" svc="$4" cdir="$5" tools tmp anchor_rc=0
  tools="$(vp_root_tools_dir "$prefix")"
  ( umask 022; mkdir -p -- "$(dirname -- "$tools")" ) || return 2
  tmp="$tools.new.$$"
  rm -rf -- "$tmp"
  ( umask 022; mkdir -p -- "$tmp/verify/server" ) || return 2
  if [[ -x "$sdir/runtime/node/bin/node" && -f "$sdir/app/server/src/upgrade/verifyCli.js" && -f "$sdir/app/server/package.json" ]]; then
    # -a 를 쓰지 않는다 — tar 가 보존한 빌드 머신 소유자(uid)를 옮겨 오지 않게(아래에서 root 로 다시 맞춘다).
    cp -- "$sdir/runtime/node/bin/node" "$tmp/verify/node" \
      && cp -R -- "$sdir/app/server/src" "$tmp/verify/server/src" \
      && cp -- "$sdir/app/server/package.json" "$tmp/verify/server/package.json" \
      && { [[ ! -f "$sdir/app/package.json" ]] || cp -- "$sdir/app/package.json" "$tmp/verify/package.json"; } \
      || anchor_rc=1
  else
    anchor_rc=1
  fi
  [[ $anchor_rc -eq 0 ]] || rm -rf -- "$tmp/verify"
  vp_write_launcher "$tmp/vmware-portal-otp" otp "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  vp_write_launcher "$tmp/vmware-portal-users" users "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  if [[ $anchor_rc -eq 0 ]]; then
    vp_write_launcher "$tmp/vmware-portal-verify" verify "$prefix" "$user" "$svc" "$cdir" "$tools" || return 2
  fi
  # 호스트 키 파일의 root 소유 사본(회수 보존) — 실패하면 지난 도구 폴더(지난 사본)를 그대로 둔다(바꾸면 사본이 사라진다).
  vp_stage_trust_copy "$cdir" "$tools" "$tmp" "$sdir/runtime/node/bin/node" || { rm -rf -- "$tmp"; return 2; }
  chown -R 0:0 -- "$tmp" && chmod -R u+rwX,go+rX,go-w -- "$tmp" || { rm -rf -- "$tmp"; return 2; }
  [[ $anchor_rc -ne 0 ]] || chmod 0755 -- "$tmp/verify/node"
  rm -rf -- "$tools.old.$$"
  if [[ -e "$tools" ]]; then mv -- "$tools" "$tools.old.$$" || { rm -rf -- "$tmp"; return 2; }; fi
  mv -- "$tmp" "$tools" || return 2
  rm -rf -- "$tools.old.$$"
  return $anchor_rc
}

# verify_release_package <prefix> <script_dir> <config_dir> <version> <package_file|""> <manifest_file|""> <skip 0|1>
#   반환 0 = 설치 계속 · 1 = 멈춤
verify_release_package() {
  local prefix="$1" sdir="$2" cdir="$3" ver="$4" pkg="$5" man="$6" skip="$7"
  local base; base="$(basename "$sdir")"
  if [[ -z "$pkg" && -f "$sdir/../$base.tar.gz" ]]; then pkg="$sdir/../$base.tar.gz"; fi
  if [[ -z "$man" && -f "$sdir/../vmware-portal-$ver.manifest.json" ]]; then man="$sdir/../vmware-portal-$ver.manifest.json"; fi

  local node js trust runas_uid="" runas_gid="" tools anchored=0 noverify="" rnode="" res=""
  local old_node="$prefix/runtime/node/bin/node" old_js="$prefix/app/server/src/upgrade/verifyCli.js"
  tools="$(vp_root_tools_dir "$prefix")"
  if vp_anchor_ok "$tools"; then
    # v2.741(INJPKG-01): 지난 install.sh 가 만든 root 소유 사본 — 서비스 계정이 바꿀 수 없는 신뢰 기준이다.
    node="$tools/verify/node"; js="$tools/verify/server/src/upgrade/verifyCli.js"; trust="existing"; anchored=1
  elif [[ -d "$prefix/app" && -x "$old_node" && -f "$old_js" ]]; then
    node="$old_node"; js="$old_js"; trust="existing"
    # root 소유 사본이 아직 없는 설치본(v2.741 이전) — 앱 트리의 도구는 서비스 계정이 쓸 수 있으므로 root 로 실행하지 않고
    #   그 도구를 바꿀 수 있는 계정 권한으로 실행한다(서비스 계정이 변조했다면 이 확인을 믿을 수 없다 — 그 사실을 말한다).
    #   ⚠ 권한을 내리는 것은 **root 로 실행할 때만**이다 — root 가 아니면 넘을 권한 경계가 없고(지금 계정이 이미 그 권한이다)
    #     setpriv·runuser 는 다른 계정으로 바꿀 수 없어 확인이 통째로 실패한다(v2.741 CI — uid 1001 에서 setgroups 거부).
    #   v2.744(최종 수정분 검토 VERIFY-01): 실행 계정은 old_js 의 소유자 하나가 아니라 **node·js 를 찾아가는 길 전체**(vp_path_controllers —
    #     폴더·링크·파일을 lstat 으로 · 링크는 대상의 길까지)를 바꿀 수 있는 계정으로 정한다. 예전 'stat -c %u old_js || echo 0' 은
    #     ① 중간 링크를 따라가(app 을 root 소유 폴더로 가는 링크로 바꾸면 0) ② node 를 보지 않았고 ③ stat 이 실패하면 0 — 곧 서비스 계정이
    #     바꾼 node 를 root 로 실행했다. 길 전체가 root 전용이면 root 로(--user root 설치), 바꿀 수 있는 비-root 계정이 하나면 그 계정으로,
    #     판정할 수 없거나 여러 계정이 바꿀 수 있으면 **실행하지 않는다**(아래에서 멈추거나 --skip-signature-check 면 확인 없이 넘긴다).
    local ou="" og="" ctl_n="" ctl_j="" c="" seen=" " n=0
    if [[ "$(id -u)" == 0 ]]; then
      if ! ctl_n="$(vp_path_controllers "$old_node")"; then
        noverify="기존 설치본의 확인 도구(node)를 누가 바꿀 수 있는지 판정하지 못했습니다 — $(vp_path_controllers_text "$ctl_n")"
      elif ! ctl_j="$(vp_path_controllers "$old_js")"; then
        noverify="기존 설치본의 확인 도구(verifyCli.js)를 누가 바꿀 수 있는지 판정하지 못했습니다 — $(vp_path_controllers_text "$ctl_j")"
      else
        for c in $ctl_n $ctl_j; do
          if [[ "$seen" != *" ${c%%:*}:"* ]]; then seen+="$c "; n=$((n + 1)); ou="${c%%:*}"; og="${c##*:}"; fi
        done
        if (( n == 0 )); then ou=0
        elif (( n > 1 )); then
          ou=""; noverify="기존 설치본의 확인 도구를 여러 계정(uid $(printf '%s ' $seen | sed 's/:[0-9]*//g; s/ $//; s/ /·/g'))이 바꿀 수 있어 어느 계정으로도 안전하게 실행할 수 없습니다"
        fi
      fi
    fi
    if [[ -n "$noverify" ]]; then
      :   # 아래에서 멈춘다(그 도구를 root 로 실행하지 않는다)
    elif [[ "$(id -u)" == 0 && "$ou" != 0 ]]; then
      runas_uid="$ou"; runas_gid="$og"
      echo "⚠ 기존 설치본에 root 소유 서명 확인 도구가 없습니다(v2.741 이전) — 이번 확인은 기존 설치본의 도구를 그 소유 계정(uid $ou) 권한으로 실행합니다."
      echo "  그 계정이 변조됐다면 이 확인을 믿을 수 없습니다. 이번 설치가 root 소유 확인 도구($tools)를 만듭니다."
    fi
  else
    node="$sdir/runtime/node/bin/node"; js="$sdir/app/server/src/upgrade/verifyCli.js"; trust="package"
    if [[ -d "$prefix/app" ]]; then
      echo "⚠ 기존 설치본에 서명 확인 도구가 없습니다(v2.730 이전). 이번 설치는 호스트에 신뢰 기준이 없어 새 패키지 안의 도구로 확인합니다 —"
      echo "  이 확인은 무결성(손상·잘못 받은 파일)만 봅니다. 배포자 확인은 신뢰하는 다른 서버의 release-verify.sh 로 하세요."
    fi
  fi

  if [[ -n "$noverify" ]]; then
    # v2.744(최종 수정분 검토 VERIFY-01): 예전에는 이 경우 root 로 열렸다(실패하면 열리는 기본값). 이제 실행하지 않는다.
    if [[ "$skip" == "1" ]]; then
      echo "⚠ --skip-signature-check: ${noverify}. 그 도구를 실행하지 않고(root 로 실행하지 않는다) 서명 확인 없이 설치를 계속합니다."
      return 0
    fi
    echo "✗ ${noverify}." >&2
    echo "  서명을 확인할 수 없어 설치를 멈춥니다. 아무것도 바뀌지 않았습니다." >&2
    echo "  조치: ① 기존 설치 폴더($prefix)와 그 위 폴더를 서비스 계정 하나(또는 root)만 쓸 수 있게 고친 뒤 다시 실행하세요" >&2
    echo "         (예: sudo chown -R <서비스 계정>: \"$prefix\" · 그룹·기타 쓰기 빼기 sudo chmod -R go-w \"$prefix\")." >&2
    echo "        ② 또는 신뢰하는 다른 서버에서 release-verify.sh 로 패키지와 manifest 를 확인한 뒤 --skip-signature-check 로 설치하세요(docs/RELEASE-SIGNING.md)." >&2
    return 1
  fi

  # root 로 portal.env 를 읽을 node(v2.744 최종 수정분 검토 VERIFY-02) — root 로 실행해도 되는 것만: root 소유 확인 사본(위 vp_anchor_ok)
  #   또는 길 전체가 root 전용인 node(--user root 옛 설치본·새 패키지). 서비스 계정이 바꿀 수 있는 node 는 정책 한 줄을 읽으려고 root 로
  #   실행하지 않는다(예전에는 --skip-signature-check 로 도구를 실행하지 않는 경로에서도 실행했다). 없으면 node 없이 시한 있는 한 번 열기로 읽는다.
  if [[ $anchored -eq 1 ]]; then rnode="$node"; else rnode="$(vp_policy_reader "$node")"; fi
  local pol="${UPGRADE_SIGNATURE_POLICY:-}"
  if [[ -z "$pol" ]]; then
    if [[ -n "$runas_uid" || "$(id -u)" != 0 ]]; then
      # 소유 계정 권한으로 도는 옛 도구는 예전처럼 portal.env 정책을 따른다(그 도구 자체가 그 계정의 신뢰 수준이다).
      #   root 가 아닌 실행도 같다 — 넘는 권한 경계가 없으므로 root 소유 파일만 받는 규칙이 지킬 것이 없다.
      #   v2.744(최종 수정분 검토 VERIFY-03): root 가 서비스 계정 경로를 grep 으로 직접 열지 않는다(FIFO 면 시한 없이 매달리고 링크면 따라갔다) —
      #   그 소유 계정 권한으로 시한 안에서 한 번 연다(vp_safe_read — node 를 실행하지 않는다 · 소유자는 예전처럼 따지지 않는다).
      local body="" rrc=0
      if [[ -n "$runas_uid" ]]; then
        if res="$(vp_safe_read "$cdir/portal.env" "" "$runas_uid:$runas_gid")"; then rrc=0; else rrc=$?; fi
        if [[ $rrc -eq 0 ]]; then
          if [[ "$res" == *$'\n'* ]]; then body="${res#*$'\n'}"; fi
          pol="$(printf '%s\n' "$body" | grep -E '^UPGRADE_SIGNATURE_POLICY=' 2>/dev/null | tail -1 | cut -d= -f2- || true)"
        elif [[ $rrc -ne 11 ]]; then
          echo "ⓘ $(vp_root_read_text "$cdir/portal.env" "$rrc" "$res") — 그 안의 UPGRADE_SIGNATURE_POLICY 를 쓰지 않습니다(정책은 확인 도구의 기본값을 따릅니다)." >&2
        fi
      else
        pol="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' "$cdir/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"   # root 가 아니다 — 예전 그대로
      fi
    else
      pol="$(vp_root_env_policy "$cdir" "$rnode")"   # root 로 도는 확인 — root 소유·그룹/기타 쓰기 없는 portal.env 의 정책만 받는다(한 번만 연다)
    fi
  fi

  # _vp_verify_run 인자… — 고른 도구를 실행한다. 소유 계정 권한으로 낮출 때는 패키지·manifest 를 그 계정이 읽을 수 있는
  #   root 소유 임시 폴더에 복사해 넘긴다(이름은 그대로 — manifest 의 파일 이름과 대조한다).
  _vp_verify_run() {
    if [[ -z "$runas_uid" ]]; then
      # v2.742(INJPKG-01): root 소유 도구 폴더의 호스트 키 사본 — root 로 도는 확인이 그 회수 항목을 함께 합친다(옛 도구는 무시한다).
      CONFIG_DIR="$cdir" UPGRADE_SIGNATURE_POLICY="$pol" VP_ROOT_TRUST_COPY="$tools/trust/$VP_HOST_KEYS_NAME" "$node" "$js" "$@"
      return
    fi
    local drop=()
    if command -v setpriv >/dev/null 2>&1; then drop=(setpriv --reuid="$runas_uid" --regid="$runas_gid" --clear-groups --)
    elif command -v runuser >/dev/null 2>&1 && getent passwd "$runas_uid" >/dev/null 2>&1; then drop=(runuser -u "$(getent passwd "$runas_uid" | cut -d: -f1)" --)
    else echo "✖ setpriv·runuser 가 없어 권한을 내릴 수 없습니다 — 기존 설치본의 도구를 root 로 실행하지 않습니다." >&2; return 3
    fi
    ( cd / && "${drop[@]}" env CONFIG_DIR="$cdir" UPGRADE_SIGNATURE_POLICY="$pol" "$node" "$js" "$@" )
  }

  if [[ -z "$pkg" || -z "$man" || ! -f "$pkg" || ! -f "$man" ]]; then
    # v2.735.1: 기존 설치본에 서명 공개키가 아직 하나도 설정되지 않았으면(키 등록 전 릴리스) 그 설치본의 정책이 warn 이다 —
    #   그 도구에 직접 묻는다(--policy). 이 인자를 모르는 옛 도구는 3 을 돌려주고, 그때는 예전처럼 '필수' 로 본다.
    if [[ "$trust" == "existing" && "$skip" != "1" ]]; then
      local polout=""
      polout="$(_vp_verify_run --policy 2>/dev/null || true)"
      if [[ "$polout" == "policy=warn source=unconfigured"* ]]; then
        echo "⚠ 서명 manifest 를 찾지 못했지만 기존 설치본에 서명 공개키가 아직 설정되지 않아(키 등록 전 릴리스) 경고 후 설치를 계속합니다."
        echo "  배포자 확인이 빠진 설치입니다 — 서명 키가 등록된 릴리스부터 확인이 다시 필수가 됩니다(docs/RELEASE-SIGNING.md)."
        return 0
      fi
    fi
    if [[ "$trust" == "existing" && "$skip" != "1" ]]; then
      echo "✗ 업그레이드 설치는 서명 확인이 필요합니다 — 패키지 파일과 서명 manifest 를 찾지 못했습니다." >&2
      echo "  패키지 파일 : ${pkg:-(없음)}  (기본: 압축을 푼 폴더 옆의 $base.tar.gz)" >&2
      echo "  manifest    : ${man:-(없음)}  (기본: 같은 위치의 vmware-portal-$ver.manifest.json — 릴리스 자산에서 함께 받으세요)" >&2
      echo "  다른 위치면 --package <파일> --manifest <파일> 로 지정하세요. 확인 없이 진행하려면 --skip-signature-check(권장하지 않음)." >&2
      return 1
    fi
    if [[ "$skip" == "1" && "$trust" == "existing" ]]; then
      echo "⚠ --skip-signature-check: 패키지 서명을 확인하지 않고 설치합니다(패키지·manifest 없음)."
    else
      echo "ⓘ 서명 manifest 를 찾지 못해 확인을 건너뜁니다(신규 설치). 배포자 확인은 docs/RELEASE-SIGNING.md 의 '오프라인 패키지' 절을 보세요."
    fi
    return 0
  fi

  local rc=0 how vtmp="" vpkg="$pkg" vman="$man"
  if [[ "$trust" == "package" ]]; then how='패키지 안의 도구 — 무결성만'
  elif [[ -n "$runas_uid" ]]; then how="기존 설치본의 도구·신뢰 키 — 소유 계정(uid $runas_uid) 권한"
  elif [[ "$node" == "$tools/verify/node" ]]; then how='root 소유 확인 도구·신뢰 키'
  else how='기존 설치본의 도구·신뢰 키'
  fi
  echo "==> 패키지 서명 확인(${how})"
  if [[ -n "$runas_uid" ]]; then
    vtmp="$(mktemp -d "${TMPDIR:-/var/tmp}/vmware-portal-verify.XXXXXX")" \
      && chgrp "$runas_gid" "$vtmp" && chmod 0750 "$vtmp" \
      && vpkg="$vtmp/$(basename -- "$pkg")" && vman="$vtmp/$(basename -- "$man")" \
      && cp -- "$pkg" "$vpkg" && cp -- "$man" "$vman" \
      && chgrp "$runas_gid" "$vpkg" "$vman" && chmod 0640 "$vpkg" "$vman" \
      || { echo "✖ 확인용 임시 사본을 만들지 못했습니다(${vtmp:-mktemp 실패})." >&2; [[ -z "$vtmp" ]] || rm -rf -- "$vtmp"; vtmp=""; rc=3; }
  fi
  if [[ $rc -eq 0 ]]; then _vp_verify_run --file "$vpkg" --manifest "$vman" --version "$ver" || rc=$?; fi
  [[ -z "$vtmp" ]] || rm -rf -- "$vtmp"
  if [[ $rc -eq 0 ]]; then return 0; fi
  if [[ "$skip" == "1" ]]; then
    echo "⚠ --skip-signature-check: 서명 확인 실패(코드 $rc)를 무시하고 설치를 계속합니다 — 배포자를 확인하지 않은 코드입니다."
    return 0
  fi
  if [[ "$trust" == "package" && $rc -eq 2 ]]; then
    echo "ⓘ 새 패키지 안의 신뢰 키로는 확인할 수 없습니다(코드 2 — 신규 설치라 호스트에 신뢰 기준이 없음). 설치를 계속합니다."
    return 0
  fi
  echo "✗ 서명 확인에 실패해 설치를 멈춥니다(코드 $rc). 아무것도 바뀌지 않았습니다." >&2
  return 1
}
