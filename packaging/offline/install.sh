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
[[ -d "$SCRIPT_DIR/runtime/node" && -d "$SCRIPT_DIR/app" ]] || {
  echo "패키지 구조가 올바르지 않습니다 (runtime/ 또는 app/ 누락)." >&2; exit 1; }

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

# Preserve user config (registered vCenters / users / upgrade settings) so a
# reinstall/upgrade never wipes them — these live inside the app dir.
if [[ -n "$BAK" ]]; then
  for rel in server/config/vcenters.json server/config/users.json server/config/upgrade.json; do
    if [[ -f "$BAK/$rel" ]]; then
      echo "==> 기존 설정 보존: $rel"
      cp -a "$BAK/$rel" "$APP_DST/$rel"
    fi
  done
fi

# 4) Config ------------------------------------------------------------------
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

# 5) Permissions -------------------------------------------------------------
chown -R "$SERVICE_USER:$SERVICE_USER" "$PREFIX"
chown -R "$SERVICE_USER:$SERVICE_USER" "$CONFIG_DIR"
chmod 0750 "$CONFIG_DIR"

# 6) systemd service ---------------------------------------------------------
echo "==> systemd 서비스 설치: $SERVICE_NAME"
sed -e "s|@PREFIX@|$PREFIX|g" \
    -e "s|@USER@|$SERVICE_USER|g" \
    -e "s|@CONFIG_DIR@|$CONFIG_DIR|g" \
    "$SCRIPT_DIR/vmware-portal.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

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
echo "    기본 로그인: admin / admin123  (DEFAULT_ADMIN_PASSWORD 로 변경 가능)"
