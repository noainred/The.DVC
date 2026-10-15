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
# Usage:  sudo ./install.sh [--port 4000] [--prefix /opt/vmware-portal]
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
VP_PREFIX=""
vp_check_prefix "$PREFIX" || exit 1
PREFIX="$VP_PREFIX"

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
if [[ ! -f "$CONFIG_DIR/portal.env" ]]; then
  echo "==> 환경설정 생성: $CONFIG_DIR/portal.env"
  install -m 0640 "$SCRIPT_DIR/portal.env.example" "$CONFIG_DIR/portal.env"
  # generate a persistent AUTH_SECRET so tokens survive restarts
  SECRET="$("$PREFIX/runtime/node/bin/node" -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
  sed -i "s/^AUTH_SECRET=.*/AUTH_SECRET=${SECRET}/" "$CONFIG_DIR/portal.env"
  sed -i "s/^PORT=.*/PORT=${PORT}/" "$CONFIG_DIR/portal.env"
else
  echo "==> 기존 환경설정 유지: $CONFIG_DIR/portal.env"
fi
# ensure the app reads user config from $CONFIG_DIR
grep -q '^CONFIG_DIR=' "$CONFIG_DIR/portal.env" || echo "CONFIG_DIR=$CONFIG_DIR" >> "$CONFIG_DIR/portal.env"
sed -i "s#^CONFIG_DIR=.*#CONFIG_DIR=$CONFIG_DIR#" "$CONFIG_DIR/portal.env"

# '설정' 화면 접근 계정 파일 — 없으면 주석만 담은 예시를 만들어 둔다(운영자가 편집).
# UI 저장분과 합쳐 적용되므로, 모든 관리자가 설정에 못 들어가는 잠금 상황의 복구 경로가 된다.
if [[ ! -f "$CONFIG_DIR/settings-owners.txt" ]]; then
  cat > "$CONFIG_DIR/settings-owners.txt" <<'OWNERS'
# '설정' 탭을 볼 수 있는 계정 목록 — 한 줄에 하나(# 은 주석).
# 여기에 적은 계정은 포탈 UI에서 지울 수 없습니다(서버 파일이 우선 합산).
# 수퍼관리자 noainred 는 항상 자동 포함됩니다.
# 예)
# noainred
OWNERS
  chmod 0600 "$CONFIG_DIR/settings-owners.txt"
  echo "==> 설정 접근 계정 파일 생성: $CONFIG_DIR/settings-owners.txt"
fi

# Migrate user config from an older in-app location (current or backed-up app)
# into $CONFIG_DIR so existing registrations/users/settings are kept.
for f in vcenters.json users.json upgrade.json; do
  if [[ ! -f "$CONFIG_DIR/$f" ]]; then
    for src in "$BAK/server/config/$f" "$APP_DST/server/config/$f"; do
      if [[ -n "$src" && -f "$src" ]]; then
        echo "==> 기존 설정 이전: $f -> $CONFIG_DIR/"
        cp -a "$src" "$CONFIG_DIR/$f"
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
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"
if [[ $HOSTKEYS_ROOT -eq 1 ]]; then
  chown 0:0 -- "$HOSTKEYS" && chmod go-w -- "$HOSTKEYS" && chmod o+r -- "$HOSTKEYS"
elif [[ -e "$HOSTKEYS" || -L "$HOSTKEYS" ]]; then
  echo "⚠ $HOSTKEYS 는 root 소유가 아닙니다 — root 로 실행하는 서명 확인(install.sh·vmware-portal-verify)은 이 파일을 읽지 않습니다."
  echo "  내용을 확인한 뒤: sudo chown root:root '$HOSTKEYS' && sudo chmod 644 '$HOSTKEYS'"
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
  SUDO_TMP="$(mktemp)"
  printf '# vmware-portal RMA: 프리셋이 요구하는 systemctl 명령만 허용(commands.js sudo:true)\n%s ALL=(root) NOPASSWD: /usr/bin/systemctl restart vmware-portal.service\n' "$SERVICE_USER" > "$SUDO_TMP"
  # v2.418: portal.env 의 RMA_SERVICE_UNITS(쉼표/공백 구분)·RMA_ALLOW_REBOOT 로 start/stop/restart·reboot 줄 추가
  RMA_UNITS="$(grep -E '^RMA_SERVICE_UNITS=' "$CONFIG_DIR/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr ',' ' ')"
  for u in $RMA_UNITS; do
    if [[ "$u" =~ ^[A-Za-z0-9][A-Za-z0-9@._-]{0,79}$ ]]; then
      for verb in start stop restart; do printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl %s %s.service\n' "$SERVICE_USER" "$verb" "$u" >> "$SUDO_TMP"; done
    fi
  done
  if grep -qE '^RMA_ALLOW_REBOOT=true' "$CONFIG_DIR/portal.env" 2>/dev/null; then printf '%s ALL=(root) NOPASSWD: /usr/bin/systemctl reboot\n' "$SERVICE_USER" >> "$SUDO_TMP"; fi
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
if grep -qE '^RMA_ENABLED=true' "$CONFIG_DIR/portal.env" 2>/dev/null; then
  RMA_INSTANCES="$(grep -E '^RMA_INSTANCES=' "$CONFIG_DIR/portal.env" | tail -1 | cut -d= -f2-)"
  for inst in ${RMA_INSTANCES:-default}; do
    if [[ "$inst" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
      [[ -f "$CONFIG_DIR/rma-$inst.env" ]] || printf 'RMA_INSTANCE=%s\nRMA_PRIORITY=100\n' "$inst" > "$CONFIG_DIR/rma-$inst.env"
      chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR/rma-$inst.env" 2>/dev/null || true; chmod 0640 "$CONFIG_DIR/rma-$inst.env"
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
