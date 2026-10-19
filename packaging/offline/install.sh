#!/usr/bin/env bash
#
# Offline installer for the VMware Global Monitoring Portal on Rocky Linux 9.
# Runs entirely from the bundled package — no internet, no npm, no compiler.
#
# Installs:
#   - bundled Node.js runtime  -> /opt/vmware-portal/runtime/node
#   - portal app               -> /opt/vmware-portal/app  (atomic, with backup)
#   - config (env file)        -> /etc/vmware-portal/portal.env
#   - systemd service          -> /etc/systemd/system/vmware-portal.service
#   - dedicated system user    -> vmportal
#
# Usage:  sudo ./install.sh [--port 4000] [--prefix /opt/vmware-portal] [--user vmportal]
#                          [--package <설치 패키지.tar.gz>] [--manifest <vmware-portal-<버전>.manifest.json>]
#                          [--skip-signature-check]
#
# v2.730(검토 S-10): 기존 설치본 위에 다시 설치(업그레이드)할 때는 **기존 설치본의** 확인 도구·신뢰 공개키로
#   새 패키지 파일과 서명 manifest 를 먼저 확인한다(release-verify-lib.sh). 기본 위치는 압축을 푼 폴더 옆의
#   <패키지>.tar.gz 와 vmware-portal-<버전>.manifest.json 이다. 확인에 실패하면 아무것도 바꾸지 않고 멈춘다.

set -euo pipefail

PREFIX="/opt/vmware-portal"
SERVICE_USER="vmportal"
SERVICE_NAME="vmware-portal"
CONFIG_DIR="/etc/vmware-portal"
PORT="4000"
PKG_FILE=""
MANIFEST_FILE=""
SKIP_SIG=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --package) PKG_FILE="$2"; shift 2 ;;
    --manifest) MANIFEST_FILE="$2"; shift 2 ;;
    --skip-signature-check) SKIP_SIG=1; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# v2.689(B4): 두 값은 아래 sed 치환(`s/^PORT=.*/…/`·`s|@PREFIX@|…|`)과 경로 조립에 그대로 들어간다.
# 검증하지 않으면 `--port '1/;d'` 같은 값이 sed 표현식이 되고, 슬래시가 섞이면 설치가 중간에 멈춘다.
# root 확인보다 먼저 검사한다 — 잘못된 인자는 무엇도 건드리기 전에 거절한다.
if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$PORT < 1 || 10#$PORT > 65535 )); then
  echo "--port 는 1~65535 의 숫자여야 합니다: '$PORT'" >&2; exit 1
fi
# v2.741(감사 INJPKG-03): 문자 검사만으로는 /usr·/etc·/var/lib·// 같은 시스템 경로가 통과해 아래 `chown -R 서비스계정`
#   (uninstall 의 `rm -rf`)으로 이어졌다. 정규화(연속 슬래시·끝 슬래시) 뒤 시스템 경로 자체와 그 바로 아래(/usr/local·/var/lib·
#   /home/<사용자> 등)를 거부하고, 이미 있는 폴더는 이 포탈의 설치본(app·runtime)이거나 비어 있을 때만 받는다.
#   ⚠ uninstall.sh 의 vp_check_prefix 와 같은 규칙이다(test/audit2741l.test.js 가 두 함수를 같은 입력으로 대조한다).
vp_check_prefix() {
  local p="$1" top rest
  if ! [[ "$p" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$p" =~ (^|/)\.\.(/|$) ]]; then
    echo "--prefix 는 영문·숫자·. _ - / 만 쓴 절대 경로여야 합니다('..' 불가): '$1'" >&2; return 1
  fi
  while [[ "$p" == *//* ]]; do p="${p//\/\//\/}"; done
  while [[ "$p" == */ && "$p" != / ]]; do p="${p%/}"; done
  if [[ "$p" =~ (^|/)\.(/|$) ]]; then echo "--prefix 에 '.' 경로 조각을 쓸 수 없습니다: '$1'" >&2; return 1; fi
  top="${p#/}"; top="${top%%/*}"; rest="${p#/"$top"}"
  case "$top" in
    ''|bin|boot|dev|etc|lib|lib32|lib64|libx32|proc|root|run|sbin|sys|usr|var|home|opt|srv|tmp|mnt|media|snap|lost+found)
      ;;
    *) VP_PREFIX="$p"; return 0 ;;
  esac
  # 시스템 최상위 폴더 자체는 언제나 거부, 그 아래는 폴더마다 다르다.
  if [[ -z "$rest" ]]; then echo "--prefix 로 시스템 폴더 자체('$p')를 쓸 수 없습니다 — 그 아래 전용 폴더(예: /opt/vmware-portal)를 지정하세요." >&2; return 1; fi
  case "$top" in
    bin|boot|dev|etc|lib|lib32|lib64|libx32|proc|root|run|sbin|sys|snap|lost+found)
      echo "--prefix 로 시스템 폴더('/$top') 아래를 쓸 수 없습니다: '$p'" >&2; return 1 ;;
    usr|var|home)
      # /usr/local·/usr/lib·/var/lib·/var/log·/home/<사용자> 처럼 바로 아래 폴더는 다른 프로그램·사용자가 함께 쓴다.
      if [[ "${rest#/}" != */* ]]; then echo "--prefix 로 공용 폴더('$p')를 쓸 수 없습니다 — 그 아래 전용 폴더(예: $p/vmware-portal)를 지정하세요." >&2; return 1; fi ;;
  esac
  VP_PREFIX="$p"; return 0
}
# vp_prefix_dir_ok <prefix> — 이미 있는 폴더는 이 포탈의 설치본(app·runtime·이전 백업)이거나 비어 있을 때만(lost+found 만 있는 마운트 지점 포함).
#   다른 프로그램의 폴더를 서비스 계정 소유로 바꾸지 않게 한다(chown -R).
vp_prefix_dir_ok() {
  local p="$1" e n=0
  [[ -e "$p" ]] || return 0
  [[ -d "$p" && ! -L "$p" ]] || { echo "--prefix '$p' 는 폴더가 아닙니다(또는 심볼릭 링크)." >&2; return 1; }
  [[ -d "$p/app" || -d "$p/runtime" ]] && return 0
  for e in "$p"/* "$p"/.[!.]*; do
    [[ -e "$e" || -L "$e" ]] || continue
    case "${e##*/}" in lost+found|app.bak.*|app.new.*) ;; *) n=$((n + 1)) ;; esac
  done
  if (( n > 0 )); then
    echo "--prefix '$p' 는 이미 다른 파일이 든 폴더입니다(포탈 설치본 app/·runtime/ 이 없음) — 서비스 계정 소유로 바꾸지 않도록 멈춥니다. 빈 전용 폴더를 지정하세요." >&2
    return 1
  fi
  return 0
}
# v2.742(감사 LEFT-07): --user 는 유닛(User=)·sudoers 줄·chown 에 그대로 들어간다 — 형식만 검사한다(useradd 기본 규칙의 부분집합).
#   ⚠ --user root 는 문서화된 지원 모드(서비스를 root 로 돌리는 설치 — 래퍼가 그 경우를 따로 다룬다)라 거부하지 않는다.
#   uninstall.sh 의 vp_check_user 와 글자 그대로 같은 함수다(test/audit2742a.test.js 가 대조한다).
vp_check_user() {
  if ! [[ "$1" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
    echo "--user 는 영문 소문자·숫자·_ - 로 된 계정 이름(첫 글자는 소문자 또는 _, 32자 이하)이어야 합니다: '$1'" >&2; return 1
  fi
  return 0
}
VP_PREFIX=""
vp_check_prefix "$PREFIX" || exit 1
PREFIX="$VP_PREFIX"
vp_check_user "$SERVICE_USER" || exit 1

# vp_chown_tree_except <폴더> <계정:그룹> <건드리지 않을 파일> — chown -R 과 같지만(링크는 따라가지 않는다) 그 파일 하나만 뺀다.
#   v2.742(감사 INJPKG-01): root 소유 호스트 키 파일을 chown -R 로 서비스 계정에 넘겼다가 되돌리면, 그 사이 서비스 계정이 열어 둔
#   쓰기 핸들이 되돌린 뒤에도 살아 있어 root 소유 파일에 자기 키를 넣을 수 있다 — 애초에 넘기지 않는다.
vp_chown_tree_except() {
  local dir="$1" owner="$2" keep="$3"
  chown -h -- "$owner" "$dir" || return 1
  if [[ -f "$keep" && ! -L "$keep" ]]; then
    find "$dir" -mindepth 1 \( -samefile "$keep" -prune \) -o -exec chown -h -- "$owner" {} + || return 1
  else
    chown -R -- "$owner" "$dir" || return 1
  fi
}

# vp_rma_env_request <portal.env> — RMA sudoers 를 넓히는 요청 값(RMA_SERVICE_UNITS·RMA_ALLOW_REBOOT)과 그 파일을 믿을 수 있는지.
#   v2.742(감사 INJPKG-03): portal.env 는 chown -R 로 서비스 계정 소유가 되고 포탈도 직접 쓴다(central/token.js) — 그 값으로 root 가
#   sudoers 를 넓히면 서비스 계정이 임의 유닛 제어·재부팅 권한을 스스로 줄 수 있었다. 연 파일(fd)의 소유자·권한을 보고 그 fd 에서
#   읽는다(확인 뒤 바꿔치기 차단 — vp_root_env_policy 와 같은 방식). chown -R **전에** 부른다(HOSTKEYS_ROOT 와 같은 이유).
#   결과(전역): VP_RMA_ENV_ROOT(1 = uid 0 소유 · 그룹/기타 쓰기 없음) · VP_RMA_UNITS(마지막 줄, 공백 구분) · VP_RMA_REBOOT(1 = true 줄 있음)
#   ⚠ grep 파이프를 쓰지 않는다 — set -o pipefail 에서 '줄 없음'(grep 1)이 설치를 조용히 끝냈다(v2.742 에 함께 고친 결함).
vp_rma_env_request() {
  local f="$1" fd st line
  VP_RMA_ENV_ROOT=0; VP_RMA_UNITS=""; VP_RMA_REBOOT=0
  [[ -f "$f" && ! -L "$f" ]] || return 0
  exec {fd}<"$f" || return 0
  st="$(stat -L -c '%u %a' "/dev/fd/$fd" 2>/dev/null || echo 'x 0')"
  if [[ "${st%% *}" == 0 ]] && ! (( 8#${st##* } & 8#022 )); then VP_RMA_ENV_ROOT=1; fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      RMA_SERVICE_UNITS=*) VP_RMA_UNITS="${line#RMA_SERVICE_UNITS=}" ;;
      RMA_ALLOW_REBOOT=true*) VP_RMA_REBOOT=1 ;;
    esac
  done <&"$fd"
  exec {fd}<&-
  VP_RMA_UNITS="${VP_RMA_UNITS//,/ }"
  return 0
}

# vp_rma_sudoers <계정> <portal.env 를 믿는가 1|0> <요청 유닛(공백 구분)> <요청 reboot 1|0> <지금 sudoers 파일>
#   RMA sudoers 내용을 stdout 으로 낸다. 믿을 수 있는 portal.env(root 소유)면 요청 그대로(예전 동작), 아니면 **지금 설치된(root 가
#   만든) sudoers 에 이미 있는 줄만** 남긴다 — 서비스 계정이 쓸 수 있는 값으로는 줄일 수만 있고 넓힐 수 없다(원격 RMA 배포가
#   root 로 쓴 줄은 업그레이드 설치 뒤에도 남는다). 더하지 않은 항목은 VP_RMA_IGNORED(공백 구분)에 남긴다.
vp_rma_sudoers() {
  local user="$1" trusted="$2" units="$3" reboot="$4" cur="$5" line u v re had_reboot=0
  local -a req=()
  local -A have=()
  VP_RMA_IGNORED=""
  if [[ "$trusted" != 1 && -f "$cur" && ! -L "$cur" ]]; then
    re='^'"$user"' ALL=\(root\) NOPASSWD: /usr/bin/systemctl (start|stop|restart) ([A-Za-z0-9][A-Za-z0-9@._-]{0,79})\.service$'
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ "$line" =~ $re ]]; then have["${BASH_REMATCH[2]}|${BASH_REMATCH[1]}"]=1
      elif [[ "$line" == "$user ALL=(root) NOPASSWD: /usr/bin/systemctl reboot" ]]; then had_reboot=1
      fi
    done < "$cur"
  fi
  printf '# vmware-portal RMA: 프리셋이 요구하는 systemctl 명령만 허용(commands.js sudo:true)\n%s ALL=(root) NOPASSWD: /usr/bin/systemctl restart vmware-portal.service\n' "$user"
  read -r -a req <<< "$units" || true   # 단어 나누기만 — 글롭(*)을 파일 이름으로 펼치지 않는다
  for u in "${req[@]}"; do
    [[ "$u" =~ ^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$ ]] || continue
    if [[ "$trusted" == 1 ]] || [[ -n "${have["$u|start"]:-}" && -n "${have["$u|stop"]:-}" && -n "${have["$u|restart"]:-}" ]]; then
      for v in start stop restart; do printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl %s %s.service\n' "$user" "$v" "$u"; done
    else
      VP_RMA_IGNORED="${VP_RMA_IGNORED:+$VP_RMA_IGNORED }$u"
    fi
  done
  if [[ "$reboot" == 1 ]]; then
    if [[ "$trusted" == 1 || $had_reboot -eq 1 ]]; then printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n' "$user"
    else VP_RMA_IGNORED="${VP_RMA_IGNORED:+$VP_RMA_IGNORED }reboot"
    fi
  fi
  return 0
}

# ── CONFIG_DIR 파일 안전 쓰기 — v2.744(감사 INJPKG-01) ──────────────────────────────────────────────────────────────
# CONFIG_DIR 은 서비스 계정 소유(chmod 0750, 아래 5)라 서비스 계정이 그 안의 파일을 지우고 심볼릭 링크·하드 링크로 바꿔 둘 수 있다.
#   예전에는 root 로 도는 이 스크립트가 rma-<인스턴스>.env·settings-owners.txt·portal.env 를 경로 그대로 chown·chmod·cat >·
#   printf >·sed -i·>> 해서 링크를 따라갔다 — 서비스 계정이 고른 임의 파일(/etc/shadow 등)이 서비스 계정 소유·0640 이 되거나
#   root 소유로 새로 만들어졌다(로컬 권한 상승, 재현됨). v2.741·v2.742 가 앱 트리·portal.env 값에 세운 '서비스 계정을 믿지 않는다'
#   규칙을 CONFIG_DIR 파일 권한 경로에도 적용한다. 규칙 셋:
#   ① 경로는 lstat 으로만 판정한다(vp_cfg_state) — 링크·일반 파일 아님·하드 링크면 건드리지 않고 알린다.
#   ② 내용·소유자·권한은 root 전용 임시 폴더(CONFIG_DIR 의 부모 아래 — 서비스 계정이 쓸 수 없다)에서 다 맞춘다.
#   ③ 제자리에는 rename(mv -T)으로만 놓는다 — rename 은 링크를 따라가지 않으므로 ①의 확인 뒤에 바꿔치기해도 따라가지 않는다.
#      읽어야 하는 원본은 vp_cfg_snap 으로 그 임시 폴더에 옮긴 사본에서 읽는다(재귀 없음 · 링크를 따라가지 않음 · 일반 파일만).
#   ⚠ 하드 링크는 fs.protected_hardlinks(배포판 기본 1)가 남의 파일에 거는 것을 막는다는 전제다 — ①이 링크 수 1 만 받는다.

# vp_cfg_state <파일> — 0 = 일반 파일(링크 아님·링크 수 1) · 1 = 없음(매달린 링크도 없음) · 2 = 건드리면 안 됨(stderr 에 알린다).
vp_cfg_state() {
  local f="$1" n
  if [[ -L "$f" ]]; then
    echo "⚠ $f 는 심볼릭 링크입니다 — root 로 따라가 쓰거나 소유자·권한을 바꾸지 않도록 건너뜁니다(서비스 계정이 심은 링크일 수 있습니다)." >&2
    echo "  링크를 지우고 내용을 확인한 일반 파일로 둔 뒤 install.sh 를 다시 실행하세요." >&2
    return 2
  fi
  [[ -e "$f" ]] || return 1
  if [[ ! -f "$f" ]]; then
    echo "⚠ $f 는 일반 파일이 아닙니다 — 건너뜁니다." >&2
    return 2
  fi
  n="$(stat -c %h -- "$f" 2>/dev/null || echo 0)"
  if [[ "$n" != 1 ]]; then
    echo "⚠ $f 는 하드 링크입니다(링크 수 $n) — 다른 파일과 같은 내용일 수 있어 건너뜁니다. 일반 파일로 다시 만든 뒤 install.sh 를 다시 실행하세요." >&2
    return 2
  fi
  return 0
}

# vp_cfg_tmp <대상 파일> — root 전용 임시 폴더(0700)를 대상 폴더의 부모 아래에 만들고 그 경로를 낸다(같은 파일 시스템이라 rename 이
#   한 번에 된다). 부모에 못 만들면 기본 임시 폴더에 — 그때 mv 는 대상을 지우고 새로(O_EXCL) 만들어 옮기므로 역시 링크를 따라가지 않는다.
vp_cfg_tmp() {
  local base
  base="$(dirname -- "$(dirname -- "$1")")"
  mktemp -d -- "$base/.vmware-portal-cfg.XXXXXX" 2>/dev/null || mktemp -d 2>/dev/null
}

# vp_cfg_snap <원본> <사본(없는 경로 — root 전용 임시 폴더 안)> — 원본이 일반 파일(링크 아님·링크 수 1·상한 이하)일 때만 내용·소유자·
#   권한·시각(·SELinux 라벨)을 사본으로 옮긴다. 반환 0 = 옮김 · 1 = 읽기·쓰기 실패 · 2 = 건너뜀(stderr 에 사유).
#   v2.744(회귀 검토 GJ-R2): 예전 'cp -a' 는 재귀라, 확인 뒤 원본을 폴더로 바꿔치기하면 root 가 서비스 계정 트리를 root 전용 임시 폴더에
#   통째로 복사한 뒤에야 거절했다(설치 지연·루트 파일 시스템 I/O — 재현됨). 지금은
#   ① 패키지 node(VP_CFG_NODE)로 원본을 O_NOFOLLOW|O_NONBLOCK 으로 한 번 열고, 그 fd 를 fstat 해 확인한 뒤 그 fd 에서 읽는다 —
#      확인 뒤 링크·폴더·FIFO(열기에서 매달리지 않는다)·하드 링크·큰 파일로 바꿔치기해도 따라가거나 복사하지 않는다.
#   ② node 를 쓸 수 없으면(없음·실행 불가) lstat 확인 + 재귀 없는 'cp -P --preserve=all'(원본을 O_NOFOLLOW 로 열고 같은 inode 인지
#      확인한다) + 시한(확인 뒤 FIFO 로 바뀌면 cp 가 열기에서 멈춘다) + 사본 크기 확인.
#   상한은 VP_CFG_MAX_BYTES(기본 16MiB — CONFIG_DIR 의 설정 파일은 수 KB 다. 넘으면 그 사실을 알리고 건너뛴다).
vp_cfg_snap() {
  local src="$1" dst="$2" max="${VP_CFG_MAX_BYTES:-}" node="${VP_CFG_NODE:-}" secs="${VP_CFG_COPY_TIMEOUT:-}" why="" r=0 st
  [[ "$max" =~ ^[0-9]+$ ]] || max=16777216
  [[ "$secs" =~ ^[1-9][0-9]*$ ]] || secs=60
  local js='const fs=require("fs"),C=fs.constants,[src,dst,mx]=process.argv.slice(1),max=Number(mx);
const q=(m,c)=>{process.stdout.write(String(m));process.exit(c)};
let fd,o;
try{fd=fs.openSync(src,C.O_RDONLY|C.O_NOFOLLOW|C.O_NONBLOCK|C.O_NOCTTY)}catch(e){q(e.code==="ELOOP"?"link":e.code==="ENOENT"?"absent":"open:"+e.code,10)}
const s=fs.fstatSync(fd);
if(!s.isFile())q("notreg",10);
if(s.nlink!==1)q("nlink:"+s.nlink,10);
if(!(s.size<=max))q("size:"+s.size,10);
try{o=fs.openSync(dst,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600)}catch(e){q("dst:"+e.code,11)}
try{const b=Buffer.alloc(65536);let n,t=0;
while((n=fs.readSync(fd,b,0,b.length,null))>0){t+=n;if(t>max)q("size:"+t,10);let w=0;while(w<n)w+=fs.writeSync(o,b,w,n-w)}
fs.fchownSync(o,s.uid,s.gid);fs.fchmodSync(o,s.mode&0o7777);fs.futimesSync(o,s.atime,s.mtime)}catch(e){q("io:"+(e.code||"error"),11)}
if(fs.existsSync("/sys/fs/selinux/enforce")){try{require("child_process").spawnSync("chcon",["--reference=/dev/fd/3","--",dst],{stdio:["ignore","ignore","ignore",fd]})}catch(e){}}
fs.closeSync(o);fs.closeSync(fd)'
  if [[ -n "$node" && -x "$node" ]]; then
    why="$("$node" -e "$js" -- "$src" "$dst" "$max" 2>/dev/null)" || r=$?
    case $r in
      0) return 0 ;;
      10) case "$why" in
            link) echo "⚠ $src 는 심볼릭 링크입니다 — root 로 따라가 읽지 않도록 복사하지 않습니다." >&2 ;;
            absent) echo "⚠ $src 가 없어졌습니다 — 복사하지 않습니다." >&2 ;;
            notreg) echo "⚠ $src 는 일반 파일이 아닙니다(폴더·FIFO 등) — 복사하지 않습니다." >&2 ;;
            nlink:*) echo "⚠ $src 는 하드 링크입니다(링크 수 ${why#nlink:}) — 복사하지 않습니다." >&2 ;;
            size:*) echo "⚠ $src 가 너무 큽니다(${why#size:}바이트 — 상한 ${max}바이트) — 복사하지 않습니다(정상 설정 파일은 수 KB 입니다)." >&2 ;;
            *) echo "⚠ $src 를 열지 못했습니다(${why}) — 복사하지 않습니다." >&2 ;;
          esac
          rm -f -- "$dst"; return 2 ;;
      11) echo "⚠ $src 를 복사하지 못했습니다(${why})." >&2; rm -f -- "$dst"; return 1 ;;
    esac
    rm -f -- "$dst"   # node 를 실행하지 못함(실행 불가 마운트 등) — 아래 cp 경로로
  fi
  if [[ -L "$src" ]]; then echo "⚠ $src 는 심볼릭 링크입니다 — root 로 따라가 읽지 않도록 복사하지 않습니다." >&2; return 2; fi
  if [[ ! -f "$src" ]]; then echo "⚠ $src 는 일반 파일이 아닙니다(폴더·FIFO 등이거나 없음) — 복사하지 않습니다." >&2; return 2; fi
  st="$(stat -c '%h %s' -- "$src" 2>/dev/null || echo 'x 0')"
  if [[ "${st%% *}" != 1 ]]; then echo "⚠ $src 는 하드 링크입니다(링크 수 ${st%% *}) — 복사하지 않습니다." >&2; return 2; fi
  if (( ${st##* } > max )); then
    echo "⚠ $src 가 너무 큽니다(${st##* }바이트 — 상한 ${max}바이트) — 복사하지 않습니다(정상 설정 파일은 수 KB 입니다)." >&2; return 2
  fi
  local -a to=()
  if command -v timeout >/dev/null 2>&1; then to=(timeout "$secs"); fi
  "${to[@]}" cp -P --preserve=all -- "$src" "$dst" 2>/dev/null || r=$?
  if [[ $r -ne 0 ]]; then
    rm -f -- "$dst"
    if [[ $r -eq 124 ]]; then echo "⚠ $src 복사가 시한(${secs}초)을 넘겨 끊었습니다(그사이 FIFO 등으로 바뀌었을 수 있다) — 복사하지 않습니다." >&2
    else echo "⚠ $src 를 복사하지 못했습니다(그사이 링크·일반 파일 아님으로 바뀌었을 수 있다) — 복사하지 않습니다." >&2
    fi
    return 2
  fi
  st="$(stat -c '%s' -- "$dst" 2>/dev/null || echo x)"
  if [[ -L "$dst" || ! -f "$dst" || ! "$st" =~ ^[0-9]+$ ]] || (( st > max )); then
    rm -f -- "$dst"
    echo "⚠ $src 의 사본이 일반 파일이 아니거나 상한(${max}바이트)을 넘었습니다(그사이 바뀌었을 수 있다) — 복사하지 않습니다." >&2; return 2
  fi
  return 0
}

# vp_cfg_place <준비한 파일> <대상> <new|replace> — 준비한 일반 파일을 rename 으로 제자리에 놓는다.
#   new = 그 자리에 무엇이든(매달린 링크 포함) 있으면 놓지 않는다(2) · replace = 그 자리의 이름만 바꾼다(링크를 따라가지 않는다).
vp_cfg_place() {
  local src="$1" dst="$2" how="$3"
  [[ -f "$src" && ! -L "$src" ]] || return 1
  if [[ "$how" == new ]]; then
    mv -n -T -- "$src" "$dst" 2>/dev/null || true
    if [[ -e "$src" || -L "$src" ]]; then
      echo "⚠ $dst 가 그사이에 생겨(서비스 계정이 만든 것일 수 있다) 새로 만들지 않았습니다 — 확인한 뒤 install.sh 를 다시 실행하세요." >&2
      return 2
    fi
    return 0
  fi
  mv -f -T -- "$src" "$dst" 2>/dev/null || { echo "⚠ $dst 를 바꾸지 못했습니다(폴더로 바뀌었을 수 있다) — 건너뜁니다." >&2; return 1; }
  return 0
}

# vp_cfg_create <대상> <소유 계정:그룹> <권한> — 없는 파일을 stdin 내용으로 만든다(임시 폴더에서 내용·소유자·권한을 맞춘 뒤 new 로 놓는다).
#   반환 0 = 만듦 · 1 = 실패 · 2 = 대상이 있어(또는 그사이 생겨) 만들지 않음.
vp_cfg_create() {
  local dst="$1" owner="$2" mode="$3" t rc=0
  t="$(vp_cfg_tmp "$dst")" || { echo "⚠ 임시 폴더를 만들지 못해 $dst 를 만들지 않았습니다." >&2; return 1; }
  if cat > "$t/new" && chown -- "$owner" "$t/new" && chmod -- "$mode" "$t/new"; then
    vp_cfg_place "$t/new" "$dst" new || rc=$?
  else
    echo "⚠ $dst 를 만들지 못했습니다(내용·소유자·권한)." >&2; rc=1
  fi
  rm -rf -- "$t"
  return $rc
}

# vp_cfg_copy_new <원본> <대상> — 없는 대상에 원본(일반 파일일 때만)을 vp_cfg_snap 으로 옮긴다(소유자·권한 보존). 반환은 vp_cfg_create 와 같다.
#   원본이 링크·폴더·FIFO·하드 링크·상한 초과면 사본을 만들지 않는다(v2.744 회귀 검토 GJ-R2 — 예전 cp -a 는 폴더를 통째로 복사했다).
vp_cfg_copy_new() {
  local src="$1" dst="$2" t rc=0
  t="$(vp_cfg_tmp "$dst")" || return 1
  if vp_cfg_snap "$src" "$t/new" && [[ -f "$t/new" && ! -L "$t/new" ]]; then
    vp_cfg_place "$t/new" "$dst" new || rc=$?
  else
    echo "⚠ $src 를 옮기지 못했습니다(일반 파일이 아님) — 건너뜁니다." >&2; rc=1
  fi
  rm -rf -- "$t"
  return $rc
}

# vp_cfg_fix <대상> <소유 계정:그룹> <권한(chmod 표기)> [<원래 소유 uid 조건>] — 있는 일반 파일의 소유자·권한을 맞춘다.
#   경로에 chown·chmod 하지 않는다(chmod 는 링크를 따라간다) — vp_cfg_snap 사본을 맞춰 replace 로 바꿔 놓는다. 이미 맞으면 건드리지 않는다.
#   uid 조건을 주면 사본(=그때 그 자리에 있던 파일)의 소유자가 그 uid 일 때만 맞춘다. 반환 0 = 맞음/맞춤 · 1 = 실패 · 2 = 건너뜀.
vp_cfg_fix() {
  local dst="$1" owner="$2" mode="$3" need="${4:-}" t rc=0 before after
  t="$(vp_cfg_tmp "$dst")" || { echo "⚠ 임시 폴더를 만들지 못해 $dst 의 소유자·권한을 맞추지 않았습니다." >&2; return 1; }
  # v2.744(회귀 검토 GJ-R2): 사본은 vp_cfg_snap(재귀 없음 — 확인 뒤 폴더로 바꿔치기해도 트리를 복사하지 않는다)
  if vp_cfg_snap "$dst" "$t/cur" && [[ -f "$t/cur" && ! -L "$t/cur" ]] \
     && { [[ -z "$need" ]] || [[ "$(stat -c %u -- "$t/cur" 2>/dev/null)" == "$need" ]]; }; then
    before="$(stat -c '%u:%g %a' -- "$t/cur")"
    if chown -- "$owner" "$t/cur" && chmod -- "$mode" "$t/cur"; then
      after="$(stat -c '%u:%g %a' -- "$t/cur")"
      if [[ "$before" != "$after" ]]; then vp_cfg_place "$t/cur" "$dst" replace || rc=$?; fi
    else
      rc=1
    fi
  else
    echo "⚠ $dst 의 소유자·권한을 맞추지 않았습니다(그사이 링크·일반 파일 아님·다른 소유자로 바뀌었을 수 있다)." >&2; rc=2
  fi
  rm -rf -- "$t"
  return $rc
}

# vp_cfg_set_line <대상> <KEY> <VALUE> — 있는 일반 파일에서 'KEY=' 로 시작하는 줄을 전부 KEY=VALUE 로 바꾸고 없으면 끝에 붙인다
#   (예전 'grep … || echo … >>' + 'sed -i s#^KEY=.*#…#' 와 같은 결과 — 마지막 줄에 줄바꿈이 없어도 이어 붙이지 않는다).
#   바뀐 것이 없으면 쓰지 않는다. 소유자·권한·SELinux 라벨은 원본 그대로(vp_cfg_snap 사본에서 고쳐 replace 로 놓는다).
#   v2.744(회귀 검토 GJ-R1): 예전에는 bash 문자열에 한 줄씩 덧붙였다(out+=) — 덧붙일 때마다 전체를 다시 복사해 크기의 제곱에 비례했다
#   (서비스 계정이 portal.env 를 키우면 root 설치기가 수 분~수 시간 멈춘다 — 실측 3.3MB 5.9초). 지금은 awk 한 번(선형)이고 결과는 예전과
#   같다(줄 맨 앞 'KEY=' 글자 그대로 일치 — CONFIG_DIR_X= 와 섞지 않는다 · 마지막 줄 줄바꿈 보충 · 없으면 끝에 추가). 키·값은 ENVIRON
#   으로 넘긴다(awk -v 는 값의 역슬래시를 해석한다). 크기 상한은 vp_cfg_snap 이 건다(넘으면 알리고 건너뛴다).
vp_cfg_set_line() {
  local dst="$1" key="$2" val="$3" t rc=0
  t="$(vp_cfg_tmp "$dst")" || { echo "⚠ 임시 폴더를 만들지 못해 $dst 의 $key 줄을 맞추지 않았습니다." >&2; return 1; }
  if ! vp_cfg_snap "$dst" "$t/cur" || [[ ! -f "$t/cur" || -L "$t/cur" ]]; then
    echo "⚠ $dst 를 읽지 못해(그사이 링크·일반 파일 아님으로 바뀌었거나 상한을 넘었을 수 있다) $key 줄을 맞추지 않았습니다." >&2
    rm -rf -- "$t"; return 2
  fi
  # shellcheck disable=SC2016  # $0 은 awk 의 것이다
  if ! VP_K="$key" VP_V="$val" LC_ALL=C awk 'BEGIN { k = ENVIRON["VP_K"] "="; r = ENVIRON["VP_K"] "=" ENVIRON["VP_V"]; s = 0 }
      index($0, k) == 1 { print r; s = 1; next }
      { print }
      END { if (!s) print r }' < "$t/cur" > "$t/new"; then
    echo "⚠ $dst 의 $key 줄을 만들지 못했습니다(awk 실패) — 건드리지 않았습니다." >&2
    rm -rf -- "$t"; return 1
  fi
  if ! cmp -s -- "$t/cur" "$t/new"; then
    if chown --reference="$t/cur" -- "$t/new" && chmod --reference="$t/cur" -- "$t/new"; then
      { command -v chcon >/dev/null 2>&1 && chcon --reference="$t/cur" -- "$t/new" 2>/dev/null; } || true
      vp_cfg_place "$t/new" "$dst" replace || rc=$?
    else
      rc=1
    fi
  fi
  rm -rf -- "$t"
  return $rc
}

# vp_rma_env_file <config_dir> <인스턴스> <서비스 계정> — RMA 인스턴스 환경 파일(rma-<인스턴스>.env)을 준비한다.
#   없으면 기본 내용으로 만들고(서비스 계정 소유·0640), 있으면 소유자·권한만 맞춘다. 반환 0 = 그 인스턴스를 기동해도 된다 ·
#   그 밖 = 링크·일반 파일 아님 등으로 건너뛰었다(그 인스턴스를 기동하지 않는다 — systemd 가 root 로 그 링크를 따라 읽지 않게).
vp_rma_env_file() {
  local cdir="$1" inst="$2" user="$3" f st=0
  f="$cdir/rma-$inst.env"
  vp_cfg_state "$f" || st=$?
  case $st in
    1) printf 'RMA_INSTANCE=%s\nRMA_PRIORITY=100\n' "$inst" | vp_cfg_create "$f" "$user:$user" 0640 || return $? ;;
    0) vp_cfg_fix "$f" "$user:$user" 0640 || st=$?
       # 2 = 그사이 링크 등으로 바뀜 → 기동하지 않는다 · 1 = 임시 폴더·소유자 맞추기 실패(파일은 확인한 일반 파일) → 알리고 기동은 한다
       if [[ $st -eq 2 ]]; then return 2; fi
       if [[ $st -ne 0 ]]; then echo "⚠ $f 의 소유자·권한(서비스 계정 · 0640)을 맞추지 못했습니다 — 파일은 그대로 두고 인스턴스는 기동합니다." >&2; fi ;;
    *) return 2 ;;
  esac
  return 0
}

# vp_cfg_settings_owners <config_dir> — '설정' 화면 접근 계정 파일이 없으면 주석만 담은 예시를 만든다(root 소유 0600 —
#   아래 5) 의 chown -R 이 서비스 계정 소유로 넘긴다. 예전과 같은 최종 상태). 링크면 만들지 않고 알린다.
vp_cfg_settings_owners() {
  local f="$1/settings-owners.txt" st=0
  vp_cfg_state "$f" || st=$?
  [[ $st -eq 1 ]] || return 0
  if vp_cfg_create "$f" 0:0 0600 <<'OWNERS'
# '설정' 탭을 볼 수 있는 계정 목록 — 한 줄에 하나(# 은 주석).
# 여기에 적은 계정은 포탈 UI에서 지울 수 없습니다(서버 파일이 우선 합산).
# 수퍼관리자 noainred 는 항상 자동 포함됩니다.
# 예)
# noainred
OWNERS
  then
    echo "==> 설정 접근 계정 파일 생성: $f"
  fi
  return 0
}

[[ $EUID -eq 0 ]] || { echo "이 스크립트는 root 권한으로 실행해야 합니다 (sudo)." >&2; exit 1; }
vp_prefix_dir_ok "$PREFIX" || exit 1

# 패키지 구조 확인 — 실패 시 '무엇이 없는지'와 '가장 흔한 원인'까지 알려준다.
# 이 오류의 대부분은 (1) 설치 패키지가 아닌 업그레이드 번들/소스를 받았거나
# (2) 압축을 푼 폴더가 아닌 곳(설치 대상 /opt/vmware-portal 등)에서 실행한 경우다.
if [[ ! -d "$SCRIPT_DIR/runtime/node" || ! -d "$SCRIPT_DIR/app" ]]; then
  {
    echo "패키지 구조가 올바르지 않습니다 — 이 스크립트와 같은 폴더에 runtime/node 와 app/ 이 있어야 합니다."
    echo ""
    echo "  실행 위치 : $SCRIPT_DIR"
    echo "  runtime/node : $([[ -d "$SCRIPT_DIR/runtime/node" ]] && echo '있음' || echo '없음  ← 누락')"
    echo "  app/         : $([[ -d "$SCRIPT_DIR/app" ]] && echo '있음' || echo '없음  ← 누락')"
    echo "  같은 폴더 내용: $(ls -A "$SCRIPT_DIR" 2>/dev/null | head -8 | tr '\n' ' ')"
    echo ""
    echo "흔한 원인과 해결:"
    echo " 1) 받은 파일이 '설치 패키지'가 아닙니다."
    echo "    설치 패키지 : vmware-portal-offline-<버전>-el9-x64.tar.gz  (약 70MB, Node 런타임 포함) ← 이것이 필요"
    echo "    업그레이드 번들: vmware-portal-<버전>.tar.gz               (약 13MB, 앱만 — 설치용 아님)"
    echo "    git 소스      : 설치 스크립트만 있고 런타임/빌드 결과가 없음 — packaging/offline/build-package.sh 로 먼저 빌드"
    echo " 2) 압축을 푼 폴더가 아닌 곳에서 실행했습니다. 아래처럼 풀린 폴더로 이동해 실행하세요:"
    echo "      tar -xzf vmware-portal-offline-<버전>-el9-x64.tar.gz"
    echo "      cd vmware-portal-offline-<버전>-el9-x64"
    echo "      sudo ./install.sh --port ${PORT}"
    echo ""
    echo "설치 대상 폴더($PREFIX)에서 실행하는 것이 아닙니다 — 그 폴더는 설치가 만들어 줍니다."
  } >&2
  exit 1
fi

# v2.744(회귀 검토 GJ-R2): vp_cfg_snap 이 root 로 실행하는 node — 패키지의 것(이 스크립트와 같은 신뢰. 아래 0) 이 이 폴더의
#   release-verify-lib.sh 를 root 로 source 한다). $PREFIX/runtime/node 는 5) 의 chown -R 뒤 서비스 계정 소유라 root 로 실행하지 않는다.
#   없거나 실행되지 않으면(실행 불가 마운트 등) vp_cfg_snap 이 cp 경로로 떨어진다.
VP_CFG_NODE="$SCRIPT_DIR/runtime/node/bin/node"

VERSION="$(cat "$SCRIPT_DIR/VERSION" 2>/dev/null || echo unknown)"
echo "==> VMware Global Monitoring Portal 오프라인 설치 (v${VERSION}) — Rocky Linux 9"

# 0) 패키지 서명 확인(v2.730 검토 S-10) — 런타임·앱을 바꾸기 **전에**(기존 런타임·도구가 신뢰 기준이다).
if [[ -f "$SCRIPT_DIR/release-verify-lib.sh" ]]; then
  # shellcheck source=release-verify-lib.sh
  source "$SCRIPT_DIR/release-verify-lib.sh"
  if ! verify_release_package "$PREFIX" "$SCRIPT_DIR" "$CONFIG_DIR" "$VERSION" "$PKG_FILE" "$MANIFEST_FILE" "$SKIP_SIG"; then
    exit 1
  fi
else
  echo "⚠ release-verify-lib.sh 가 패키지에 없습니다 — 서명 확인을 하지 못했습니다(v2.730 이전 형식의 패키지)."
fi

# 1) Service user ------------------------------------------------------------
if ! id "$SERVICE_USER" &>/dev/null; then
  echo "==> 시스템 사용자 생성: $SERVICE_USER"
  useradd --system --no-create-home --shell /sbin/nologin "$SERVICE_USER"
fi

# 2) Runtime -----------------------------------------------------------------
echo "==> Node.js 런타임 설치: $PREFIX/runtime/node"
mkdir -p "$PREFIX/runtime"
rm -rf "$PREFIX/runtime/node"
cp -a "$SCRIPT_DIR/runtime/node" "$PREFIX/runtime/node"

# 3) App (atomic swap with backup; aligns with the in-app auto-upgrade) ------
APP_DST="$PREFIX/app"
BAK=""
if [[ -d "$APP_DST" ]]; then
  BAK="$APP_DST.bak.$(date +%s)"
  echo "==> 기존 앱 백업: $BAK"
  mv "$APP_DST" "$BAK"
fi
echo "==> 앱 설치: $APP_DST"
cp -a "$SCRIPT_DIR/app" "$APP_DST"

# 4) Config — lives in $CONFIG_DIR (OUTSIDE the app), so upgrades never touch it
mkdir -p "$CONFIG_DIR"
# v2.744(감사 INJPKG-01): CONFIG_DIR 안의 파일은 서비스 계정이 링크로 바꿔 둘 수 있다 — 경로를 따라가 쓰지 않는다(위 vp_cfg_* 규칙).
PENV="$CONFIG_DIR/portal.env"
PENV_ST=0; vp_cfg_state "$PENV" || PENV_ST=$?
if [[ $PENV_ST -eq 1 ]]; then
  echo "==> 환경설정 생성: $PENV"
  # generate a persistent AUTH_SECRET so tokens survive restarts
  SECRET="$("$PREFIX/runtime/node/bin/node" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  # 예전과 같은 내용(예시 + AUTH_SECRET·PORT)·소유자(root — 아래 5) 의 chown -R 이 서비스 계정에 넘긴다)·권한(0640)
  if sed -e "s/^AUTH_SECRET=.*/AUTH_SECRET=${SECRET}/" -e "s/^PORT=.*/PORT=${PORT}/" "$SCRIPT_DIR/portal.env.example" \
       | vp_cfg_create "$PENV" 0:0 0640; then
    PENV_ST=0
  else
    PENV_ST=2; echo "⚠ $PENV 를 만들지 못했습니다(위 안내)."
  fi
elif [[ $PENV_ST -eq 0 ]]; then
  echo "==> 기존 환경설정 유지: $PENV"
fi
# ensure the app reads user config from $CONFIG_DIR
if [[ $PENV_ST -eq 0 ]]; then
  vp_cfg_set_line "$PENV" CONFIG_DIR "$CONFIG_DIR" || echo "⚠ $PENV 의 CONFIG_DIR 줄을 맞추지 못했습니다(위 안내)."
else
  echo "⚠ $PENV 를 일반 파일로 쓸 수 없어(위 안내) 만들거나 고치지 않았습니다 — 포탈 설정이 이 파일에 있으니 고친 뒤 install.sh 를 다시 실행하세요."
fi

# '설정' 화면 접근 계정 파일 — 없으면 주석만 담은 예시를 만들어 둔다(운영자가 편집).
# UI 저장분과 합쳐 적용되므로, 모든 관리자가 설정에 못 들어가는 잠금 상황의 복구 경로가 된다.
vp_cfg_settings_owners "$CONFIG_DIR"

# Migrate user config from an older in-app location (current or backed-up app)
# into $CONFIG_DIR so existing registrations/users/settings are kept.
# v2.744(INJPKG-01): 대상이 링크면 건너뛰고(vp_cfg_state 가 알린다), 원본은 일반 파일만 · 놓을 때는 rename(vp_cfg_copy_new).
for f in vcenters.json users.json upgrade.json; do
  MIG_ST=0; vp_cfg_state "$CONFIG_DIR/$f" || MIG_ST=$?
  if [[ $MIG_ST -eq 1 ]]; then
    for src in "$BAK/server/config/$f" "$APP_DST/server/config/$f"; do
      if [[ -n "$src" && -f "$src" && ! -L "$src" ]]; then
        if vp_cfg_copy_new "$src" "$CONFIG_DIR/$f"; then echo "==> 기존 설정 이전: $f -> $CONFIG_DIR/"; fi
        break
      fi
    done
  fi
done

# 5) Permissions -------------------------------------------------------------
# v2.741(감사 INJPKG-01): 호스트 신뢰 키 파일(release-signing-keys.conf)은 root 로 도는 서명 확인이 root 소유일 때만 읽는다
#   (signature.js). root 가 둔 파일을 아래 chown -R 이 서비스 계정 소유로 바꾸지 않게 소유자를 되돌린다. 서비스 계정 소유인
#   예전 파일은 바꾸지 않는다(내용을 이 설치가 보증할 수 없다) — 확인한 뒤 root 로 바꾸라고 알린다.
HOSTKEYS="$CONFIG_DIR/release-signing-keys.conf"
HOSTKEYS_ROOT=0
if [[ -f "$HOSTKEYS" && ! -L "$HOSTKEYS" && "$(stat -c %u -- "$HOSTKEYS" 2>/dev/null)" == 0 ]]; then HOSTKEYS_ROOT=1; fi
# v2.742(INJPKG-03): RMA sudoers 를 넓히는 portal.env 값은 chown -R 전에 — 그때의 소유자로 믿을지 정한다(아래 6-0).
vp_rma_env_request "$CONFIG_DIR/portal.env"
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
if [[ $HOSTKEYS_ROOT -eq 1 ]]; then
  # v2.742(INJPKG-01): root 소유 호스트 키 파일은 넘기지 않는다(넘겼다 되돌리는 사이 열린 쓰기 핸들이 남는다).
  vp_chown_tree_except "$CONFIG_DIR" "$SERVICE_USER:$SERVICE_USER" "$HOSTKEYS"
else
  chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
fi
chmod 0750 "$CONFIG_DIR"
if [[ $HOSTKEYS_ROOT -eq 1 ]]; then
  # v2.744(감사 INJPKG-01): 위 HOSTKEYS_ROOT 판정과 여기 사이에는 chown -R 이 돈다(큰 트리면 수 초) — 그사이 서비스 계정이 이 파일을
  #   지우고 링크(/etc/shadow 등)로 바꾸면 예전 'chown 0:0 · chmod go-w · chmod o+r' 이 링크를 따라가 그 파일을 모두가 읽게 만들었다.
  #   지금은 사본에서 맞춰 rename 으로 놓는다(vp_cfg_fix) — 그 자리가 지금도 root 소유 일반 파일일 때만.
  vp_cfg_fix "$HOSTKEYS" 0:0 go-w,o+r 0 || echo "⚠ $HOSTKEYS 의 권한(go-w,o+r)을 맞추지 않았습니다(위 안내) — 내용을 확인한 뒤 root:root 소유·chmod 644 의 새 파일로 두세요."
elif [[ -e "$HOSTKEYS" || -L "$HOSTKEYS" ]]; then
  echo "⚠ $HOSTKEYS 는 root 소유가 아닙니다 — root 로 실행하는 서명 확인(install.sh·vmware-portal-verify)은 이 파일의 키 추가를 받지 않고 회수 항목만 합칩니다."
  echo "  내용을 확인한 뒤 root:root 소유·chmod 644 의 **새 파일**로 바꾸세요(기존 파일을 chown 하면 서비스 계정이 열어 둔 핸들로 계속 쓸 수 있다 — docs/RELEASE-SIGNING.md 8절)."
fi

# SELinux 라벨 처리(best-effort — 어떤 실패도 설치를 막지 않는다)
# ① 영구 규칙: 사용자 지정 --prefix 가 /opt·/usr 밖이면(/data·/srv·/home 등) 그 경로의
#    정책 기본 라벨 자체가 default_t/var_t 라 restorecon 을 해도 systemd 가 실행을 거부한다
#    (기동 무한 재시작: 203/EXEC Permission denied). /opt 와 같은 usr_t 를 semanage 로
#    영구 등록해 restorecon·전체 재라벨(autorelabel) 후에도 유지되게 한다.
# ② 복원: 패키지를 /tmp 나 /root 아래에서 풀면 cp -a 가 user_tmp_t/admin_home_t 라벨을
#    /opt 까지 그대로 가져온다(root 쉘 직접 실행은 되므로 설치 중에는 안 드러남). 경로
#    기본 라벨(usr_t/etc_t)로 복원해 어디서 풀어도 안전하게 만든다.
# ③ 검증: 실제 남은 라벨을 확인해 실행 불가 타입이면 chcon 으로 임시 보정하고, 영구
#    반영 방법(semanage 설치)을 안내한다. SELinux 미사용이면 전체를 조용히 건너뛴다.
SEL_MODE="$(getenforce 2>/dev/null || echo Disabled)"
if [[ "$SEL_MODE" == "Enforcing" || "$SEL_MODE" == "Permissive" ]]; then
  echo "==> SELinux(${SEL_MODE}) 라벨 처리"
  if [[ "$PREFIX" != /opt/* && "$PREFIX" != /usr/* ]] && command -v semanage >/dev/null 2>&1; then
    semanage fcontext -a -t usr_t "${PREFIX}(/.*)?" 2>/dev/null \
      || semanage fcontext -m -t usr_t "${PREFIX}(/.*)?" 2>/dev/null || true
  fi
  if command -v restorecon >/dev/null 2>&1; then
    restorecon -R "$PREFIX" "$CONFIG_DIR" 2>/dev/null || true
  fi
  NODE_TYPE="$(stat -c %C "$PREFIX/runtime/node/bin/node" 2>/dev/null | awk -F: '{print $3}' || true)"
  case "$NODE_TYPE" in
    default_t|var_t|tmp_t|user_tmp_t|user_home_t|admin_home_t|home_root_t|mnt_t)
      echo "⚠ SELinux: ${PREFIX} 라벨(${NODE_TYPE})은 systemd 가 실행을 거부하는 타입입니다."
      chcon -R -t usr_t "$PREFIX" 2>/dev/null \
        && echo "   chcon 으로 usr_t 임시 보정했습니다(전체 재라벨 시 원복될 수 있음)." || true
      if ! command -v semanage >/dev/null 2>&1; then
        echo "   영구 반영(권장): dnf install policycoreutils-python-utils 후"
        echo "     semanage fcontext -a -t usr_t '${PREFIX}(/.*)?' && restorecon -R '${PREFIX}'"
      fi
      ;;
  esac
fi

# 6) systemd service ---------------------------------------------------------
echo "==> systemd 서비스 설치: $SERVICE_NAME"
sed -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    "$SCRIPT_DIR/vmware-portal.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

# 6-0) RMA(원격 명령 에이전트, v2.416) 템플릿 유닛 — 항상 설치하되 인스턴스는 portal.env 의
# RMA_ENABLED=true 일 때만 기동한다(기본 off — 각 법인 담당자가 명시적으로 켠다).
# 인스턴스 이름은 RMA_INSTANCES(공백 구분, 기본 'default'). 여러 개면 한 서버에 여러 프로세스.
if [[ -f "$SCRIPT_DIR/vmware-portal-rma@.service" ]]; then
  sed -e "s|@PREFIX@|$PREFIX|g" \
      -e "s|@USER@|$SERVICE_USER|g" \
      -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
      "$SCRIPT_DIR/vmware-portal-rma@.service" > "/etc/systemd/system/vmware-portal-rma@.service"
  # sudoers: 포탈 서비스 재시작 프리셋(commands.js portal-restart)만 허용 — visudo 검증 실패 시 설치하지 않음.
  # v2.418: portal.env 의 RMA_SERVICE_UNITS(쉼표/공백 구분)·RMA_ALLOW_REBOOT 로 start/stop/restart·reboot 줄 추가.
  # v2.742(INJPKG-03): 그 값은 portal.env 가 root 소유일 때만 sudoers 를 **넓힌다**(위 5) 에서 chown -R 전에 읽었다). 아니면 지금 설치된
  #   sudoers 에 이미 있는 줄만 남긴다(vp_rma_sudoers — 줄일 수는 있고 넓힐 수는 없다).
  SUDO_TMP="$(mktemp)"
  vp_rma_sudoers "$SERVICE_USER" "$VP_RMA_ENV_ROOT" "$VP_RMA_UNITS" "$VP_RMA_REBOOT" /etc/sudoers.d/vmware-portal-rma > "$SUDO_TMP"
  if [[ -n "$VP_RMA_IGNORED" ]]; then
    echo "⚠ $CONFIG_DIR/portal.env 가 root 소유가 아니라(서비스 계정이 쓸 수 있다) RMA sudoers 에 새로 더하지 않았습니다: $VP_RMA_IGNORED"
    echo "  이미 허용돼 있던 줄은 그대로 둡니다. 더하려면 portal.env 내용을 확인한 뒤 sudo chown root:root $CONFIG_DIR/portal.env 후 install.sh 를 다시 실행하세요"
    echo "  (설치가 끝나면 다시 서비스 계정 소유가 됩니다). 원격 RMA 배포(설정 › RMA)는 root 로 sudoers 를 직접 씁니다."
  fi
  if visudo -cf "$SUDO_TMP" >/dev/null 2>&1; then install -m 0440 "$SUDO_TMP" /etc/sudoers.d/vmware-portal-rma; fi
  rm -f "$SUDO_TMP"
fi

# v2.485 호스트 접근 제어(설정 › Security › 호스트 접근 제어): 포탈이 firewalld 로 SSH/웹 클라이언트 제어·OS 방화벽 추가
# 규칙을 적용하려면 서비스 계정에 firewall-cmd 와 sshd 서비스 start/stop/enable/disable 의 sudo 가 필요하다.
# 정확히 이 명령들만 허용(다른 systemctl 인자는 불가). visudo 검증 실패 시 설치하지 않는다(화면이 필요한 줄을 안내).
if command -v firewall-cmd &>/dev/null; then
  HA_TMP="$(mktemp)"
  printf '# vmware-portal 호스트 접근 제어(v2.485): firewalld 제어 + sshd 서비스 중지/재개만 허용\n%s ALL=(root) NOPASSWD: /usr/bin/firewall-cmd\n%s ALL=(root) NOPASSWD: /usr/bin/systemctl stop sshd.service, /usr/bin/systemctl start sshd.service, /usr/bin/systemctl disable sshd.service, /usr/bin/systemctl enable sshd.service\n' "$SERVICE_USER" "$SERVICE_USER" > "$HA_TMP"
  if visudo -cf "$HA_TMP" >/dev/null 2>&1; then install -m 0440 "$HA_TMP" /etc/sudoers.d/vmware-portal-hostaccess; fi
  rm -f "$HA_TMP"
fi

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

# 6-0-1) RMA 인스턴스 기동(RMA_ENABLED=true 인 경우)
# v2.744(INJPKG-01): portal.env 가 링크 등이면(위 4 에서 알렸다) root 가 그 링크를 따라 읽지 않는다.
if [[ $PENV_ST -eq 0 && -f "$PENV" && ! -L "$PENV" ]] && grep -qE '^RMA_ENABLED=true' "$PENV" 2>/dev/null; then
  RMA_INSTANCES="$(grep -E '^RMA_INSTANCES=' "$PENV" | tail -1 | cut -d= -f2- || true)"   # 줄이 없으면 grep 1 — pipefail 로 설치가 끝나지 않게
  for inst in ${RMA_INSTANCES:-default}; do
    if [[ "$inst" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
      # v2.744(감사 INJPKG-01): 예전에는 '-f' 가드 밖에서 chown·chmod 를 경로에 그대로 해서 서비스 계정이 심은 링크를 따라갔다
      #   (rma-<이름>.env → /etc/shadow 면 shadow 가 서비스 계정 소유·0640 이 됐다 — 재현됨). 링크면 그 인스턴스를 기동하지도 않는다.
      if ! vp_rma_env_file "$CONFIG_DIR" "$inst" "$SERVICE_USER"; then
        echo "⚠ RMA 인스턴스 '$inst' 는 환경 파일($CONFIG_DIR/rma-$inst.env)을 준비하지 못해 기동하지 않습니다(위 안내)."
        continue
      fi
      systemctl enable "vmware-portal-rma@$inst" >/dev/null 2>&1 || true
      systemctl restart "vmware-portal-rma@$inst" 2>&1 || true
      echo "==> RMA 인스턴스 기동: vmware-portal-rma@$inst"
    else
      echo "⚠ RMA_INSTANCES 항목 '$inst' 은 이름 형식(영숫자·._-)에 맞지 않아 건너뜁니다."
    fi
  done
fi

# 6-1) root 로 부르는 콘솔 도구 — 앱 트리 밖 root 소유 사본(v2.741 감사 INJPKG-01) ------------------------
# 예전에는 /usr/local/bin/vmware-portal-{otp,verify,users} 가 앱 트리의 .sh 를 가리키는 링크였다. 앱 트리는 서비스 계정이
#   쓸 수 있으므로(chown -R · 유닛 ReadWritePaths) 서비스 계정 권한을 얻은 공격자가 그 파일을 고치면 다음 `sudo vmware-portal-…`
#   가 root 로 그 코드를 실행했다. 이제 root 소유 래퍼(release-verify-lib.sh vp_install_root_tools)를 가리킨다 —
#   otp·users 는 앱 트리를 읽기 전에 서비스 계정으로 권한을 내리고, verify 는 방금 확인한 패키지로 만든 root 소유 사본만 쓴다.
TOOLS_DIR=""
TOOLS_RC=2
if declare -F vp_install_root_tools >/dev/null; then
  TOOLS_DIR="$(vp_root_tools_dir "$PREFIX")"
  TOOLS_RC=0
  vp_install_root_tools "$PREFIX" "$SCRIPT_DIR" "$SERVICE_USER" "$SERVICE_NAME" "$CONFIG_DIR" || TOOLS_RC=$?
  if [[ $TOOLS_RC -eq 1 ]]; then
    echo "⚠ root 소유 서명 확인 사본을 만들지 못했습니다($TOOLS_DIR/verify) — vmware-portal-verify 를 걸지 않습니다. 다음 install.sh 가 다시 만듭니다."
  elif [[ $TOOLS_RC -ne 0 ]]; then
    echo "⚠ root 소유 콘솔 도구 폴더를 만들지 못했습니다($TOOLS_DIR) — 콘솔 도구 바로가기를 걸지 않습니다."
  fi
fi
# vp_link <링크 이름> <root 래퍼 이름> <앱 트리 도구(있을 때만)> <설명>
vp_link() {
  local link="/usr/local/bin/$1" target="$TOOLS_DIR/$2" cur
  # 이 설치본의 예전 링크(앱 트리를 가리킴)는 어떤 경우에도 남기지 않는다 — 그것이 root 상승 경로다.
  if [[ -L "$link" ]]; then
    cur="$(readlink "$link")"
    if [[ "$cur" == "$APP_DST/"* ]]; then rm -f -- "$link"; fi
  fi
  if [[ -n "$TOOLS_DIR" && -f "$target" && -x "$target" ]]; then
    ln -sfn "$target" "$link" 2>/dev/null && echo "==> $4: $1 (→ $target · root 소유 사본)"
  fi
  return 0   # best-effort — 링크 실패로 설치를 멈추지 않는다(set -e)
}
# OTP 콘솔 등록 도구 — admin/operator 는 OTP 전용이라 첫 관리자 등록·잠금 복구에 이 도구가 필요하다.
if [[ -x "$APP_DST/otp-enroll.sh" ]]; then vp_link vmware-portal-otp vmware-portal-otp "OTP 등록 도구"; fi
# 릴리스 서명 확인 도구(v2.730 검토 S-10) — 다음 오프라인 업그레이드 전에 이 설치본(신뢰 기준)으로 새 패키지를 확인한다.
if [[ -x "$APP_DST/release-verify.sh" ]]; then vp_link vmware-portal-verify vmware-portal-verify "패키지 서명 확인 도구"; fi
# 계정 관리 콘솔 메뉴(v2.723) — 계정 생성·편집·비밀번호·계정별 로그인 방식·OTP·삭제. (/usr/local/bin/vmware-portal-users)
if [[ -x "$APP_DST/user-admin.sh" ]]; then vp_link vmware-portal-users vmware-portal-users "계정 관리 메뉴"; fi

# 7) firewalld (optional, best-effort) ---------------------------------------
if command -v firewall-cmd &>/dev/null && systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-port="${PORT}/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
  echo "==> firewalld: ${PORT}/tcp 허용"
fi

sleep 1
echo ""
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo "✅ 설치 완료. 포탈이 실행 중입니다."
else
  echo "⚠ 서비스가 아직 활성화되지 않았습니다. 로그를 확인하세요."
fi
echo "    URL    : http://<이 서버 IP>:${PORT}"
echo "    상태   : systemctl status ${SERVICE_NAME}"
echo "    로그   : journalctl -u ${SERVICE_NAME} -f"
echo "    설정   : ${CONFIG_DIR}/portal.env  (수정 후 systemctl restart ${SERVICE_NAME})"
echo "    RMA    : portal.env 에 RMA_ENABLED=true (+RMA_PASSWORD) 후 install.sh 재실행 또는"
echo "             systemctl enable --now vmware-portal-rma@default  (원격 명령 에이전트, 엣지 전용)"
echo ""
echo "  ── 최초 로그인 (admin/operator 는 OTP 전용) ─────────────────────────"
echo "    1) 임의 생성된 최초 비밀번호 확인:"
echo "       sudo cat ${CONFIG_DIR}/initial-admin-password.txt"
echo "       (로그인 화면에도 이 경로가 팝업으로 안내됩니다. DEFAULT_ADMIN_PASSWORD 를"
echo "        미리 지정했다면 그 값을 쓰세요.)"
echo "    2) admin 으로 로그인 → 화면의 안내에 따라 OTP(QR) 등록을 마치면"
echo "       비밀번호는 자동 삭제되고 이후에는 OTP 6자리로만 로그인합니다."
echo "    · 웹 없이 콘솔에서 등록하려면: sudo vmware-portal-otp admin"
echo "    · 계정 생성·편집·비밀번호·로그인 방식(콘솔 메뉴): sudo vmware-portal-users"
