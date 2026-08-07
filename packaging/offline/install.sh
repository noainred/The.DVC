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

set -euo pipefail

PREFIX="/opt/vmware-portal"
SERVICE_USER="vmportal"
SERVICE_NAME="vmware-portal"
CONFIG_DIR="/etc/vmware-portal"
PORT="4000"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "이 스크립트는 root 권한으로 실행해야 합니다 (sudo)." >&2; exit 1; }

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
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"

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

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

# 6-1) OTP 콘솔 등록 도구 바로가기 -------------------------------------------
# admin/operator 는 OTP 전용이라 첫 관리자 등록·잠금 복구에 이 도구가 필요하다.
# 긴 경로를 외우지 않도록 /usr/local/bin 에 링크를 건다(best-effort).
if [[ -x "$APP_DST/otp-enroll.sh" ]]; then
  ln -sf "$APP_DST/otp-enroll.sh" /usr/local/bin/vmware-portal-otp 2>/dev/null \
    && echo "==> OTP 등록 도구: vmware-portal-otp (→ $APP_DST/otp-enroll.sh)"
fi

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
echo ""
echo "  ── 최초 로그인 (admin/operator 는 OTP 전용) ─────────────────────────"
echo "    1) 임의 생성된 최초 비밀번호 확인:"
echo "       sudo cat ${CONFIG_DIR}/initial-admin-password.txt"
echo "       (로그인 화면에도 이 경로가 팝업으로 안내됩니다. DEFAULT_ADMIN_PASSWORD 를"
echo "        미리 지정했다면 그 값을 쓰세요.)"
echo "    2) admin 으로 로그인 → 화면의 안내에 따라 OTP(QR) 등록을 마치면"
echo "       비밀번호는 자동 삭제되고 이후에는 OTP 6자리로만 로그인합니다."
echo "    · 웹 없이 콘솔에서 등록하려면: sudo vmware-portal-otp admin"
