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

# v2.689: 아래에서 `rm -rf "$PREFIX"` 를 하므로 install.sh 와 같은 규칙으로 먼저 거른다
# ('/'·'..'·공백·셸 특수문자가 든 값으로 엉뚱한 경로를 지우지 않게).
if ! [[ "$PREFIX" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$PREFIX" =~ (^|/)\.\.(/|$) ]]; then
  echo "--prefix 는 영문·숫자·. _ - / 만 쓴 절대 경로여야 합니다('..' 불가): '$PREFIX'" >&2; exit 1
fi

[[ $EUID -eq 0 ]] || { echo "root 권한으로 실행하세요 (sudo)." >&2; exit 1; }

echo "==> 서비스 중지/비활성화: $SERVICE_NAME"
systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
# RMA 인스턴스(vmware-portal-rma@*) 전부 정지 + 템플릿·sudoers 제거
for u in $(systemctl list-units --all --plain --no-legend 'vmware-portal-rma@*' 2>/dev/null | awk '{print $1}'); do
  systemctl disable --now "$u" 2>/dev/null || true
done
rm -f /etc/systemd/system/vmware-portal-rma@.service /etc/sudoers.d/vmware-portal-rma /etc/sudoers.d/vmware-portal-hostaccess
systemctl daemon-reload

# v2.689(B5): install.sh 가 만든 OTP 등록 도구 링크. **이 설치본을 가리킬 때만** 지운다 —
# 다른 prefix 로 설치한 포탈의 링크를 지우지 않게(ln -sf "$PREFIX/app/otp-enroll.sh" 와 같은 문자열 비교).
OTP_LINK="/usr/local/bin/vmware-portal-otp"
if [[ -L "$OTP_LINK" ]]; then
  if [[ "$(readlink "$OTP_LINK")" == "$PREFIX/app/otp-enroll.sh" ]]; then
    rm -f "$OTP_LINK" && echo "==> OTP 등록 도구 링크 제거: $OTP_LINK"
  else
    echo "==> OTP 등록 도구 링크 유지: $OTP_LINK → $(readlink "$OTP_LINK") (이 설치본이 아님)"
  fi
fi

# v2.723: 계정 관리 메뉴 링크도 같은 규칙(이 설치본을 가리킬 때만).
USERS_LINK="/usr/local/bin/vmware-portal-users"
if [[ -L "$USERS_LINK" ]]; then
  if [[ "$(readlink "$USERS_LINK")" == "$PREFIX/app/user-admin.sh" ]]; then
    rm -f "$USERS_LINK" && echo "==> 계정 관리 메뉴 링크 제거: $USERS_LINK"
  else
    echo "==> 계정 관리 메뉴 링크 유지: $USERS_LINK → $(readlink "$USERS_LINK") (이 설치본이 아님)"
  fi
fi

echo "==> 앱/런타임 제거: $PREFIX"
rm -rf "$PREFIX" "$PREFIX".bak.* 2>/dev/null || true

# 설치가 /opt·/usr 밖 prefix 에 등록한 SELinux 영구 라벨 규칙 정리(best-effort).
if [[ "$PREFIX" != /opt/* && "$PREFIX" != /usr/* ]] && command -v semanage >/dev/null 2>&1; then
  semanage fcontext -d "${PREFIX}(/.*)?" 2>/dev/null || true
fi

if [[ "$PURGE" -eq 1 ]]; then
  echo "==> 설정 및 사용자 제거(purge)"
  rm -rf "$CONFIG_DIR"
  userdel "$SERVICE_USER" 2>/dev/null || true
else
  echo "==> 설정 유지: $CONFIG_DIR  (완전 삭제는 --purge)"
fi

# firewalld 포트 허용(install.sh 가 --add-port 한 것)은 지우지 않는다 — 다른 서비스가 같은 포트를 쓸 수 있다.
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "    참고: 설치 때 연 포트는 그대로입니다. 필요하면: firewall-cmd --permanent --remove-port=<포트>/tcp && firewall-cmd --reload"
fi

echo "✅ 제거 완료."
