#!/usr/bin/env bash
#
# Uninstall the VMware Global Monitoring Portal from a Rocky Linux 9 host.
# Usage:  sudo ./uninstall.sh [--purge]   (--purge also removes config + user)

set -euo pipefail

PREFIX="/opt/vmware-portal"
CONFIG_DIR="/etc/vmware-portal"
SERVICE_USER="vmportal"
SERVICE_NAME="vmware-portal"
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "root 권한으로 실행하세요 (sudo)." >&2; exit 1; }

echo "==> 서비스 중지/비활성화: $SERVICE_NAME"
systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

echo "==> 앱/런타임 제거: $PREFIX"
rm -rf "$PREFIX" "$PREFIX".bak.* 2>/dev/null || true

if [[ "$PURGE" -eq 1 ]]; then
  echo "==> 설정 및 사용자 제거(purge)"
  rm -rf "$CONFIG_DIR"
  userdel "$SERVICE_USER" 2>/dev/null || true
else
  echo "==> 설정 유지: $CONFIG_DIR  (완전 삭제는 --purge)"
fi

echo "✅ 제거 완료."
