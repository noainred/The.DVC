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
# v2.741(감사 INJPKG-03): 문자 검사만으로는 /usr·/etc·/var/lib·// 같은 시스템 경로가 통과했다 — install.sh 와 **같은 함수**
#   (test/audit2741l.test.js 가 두 정의가 글자 그대로 같은지 대조한다). 그리고 지우기 전에 그 폴더가 정말 이 포탈의 설치본인지 본다.
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
VP_PREFIX=""
vp_check_prefix "$PREFIX" || exit 1
PREFIX="$VP_PREFIX"
# vp_prefix_is_install <prefix> — rm -rf 대상이 이 포탈의 설치본(앱 진입점 또는 번들 Node 런타임)인가.
vp_prefix_is_install() { [[ -f "$1/app/server/src/index.js" || -x "$1/runtime/node/bin/node" ]]; }

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

# 2026-10-09 검토 S-10: 패키지 서명 확인 도구 링크도 같은 규칙(이 설치본을 가리킬 때만).
VERIFY_LINK="/usr/local/bin/vmware-portal-verify"
if [[ -L "$VERIFY_LINK" ]]; then
  if [[ "$(readlink "$VERIFY_LINK")" == "$PREFIX/app/release-verify.sh" ]]; then
    rm -f "$VERIFY_LINK" && echo "==> 패키지 서명 확인 도구 링크 제거: $VERIFY_LINK"
  else
    echo "==> 패키지 서명 확인 도구 링크 유지: $VERIFY_LINK → $(readlink "$VERIFY_LINK") (이 설치본이 아님)"
  fi
fi

# v2.741(INJPKG-01): install.sh 가 만든 root 소유 콘솔 도구 폴더(앱 트리 밖)와 그것을 가리키는 링크.
TOOLS_DIR="${VP_ROOT_TOOLS_BASE:-/usr/local/libexec/vmware-portal}$PREFIX"
for name in vmware-portal-otp vmware-portal-users vmware-portal-verify; do
  link="/usr/local/bin/$name"
  if [[ -L "$link" && "$(readlink "$link")" == "$TOOLS_DIR/$name" ]]; then
    rm -f "$link" && echo "==> 콘솔 도구 링크 제거: $link"
  fi
done
if [[ -d "$TOOLS_DIR" ]]; then rm -rf -- "$TOOLS_DIR" && echo "==> root 소유 콘솔 도구 제거: $TOOLS_DIR"; fi

if vp_prefix_is_install "$PREFIX"; then
  echo "==> 앱/런타임 제거: $PREFIX"
  rm -rf "$PREFIX" "$PREFIX".bak.* 2>/dev/null || true
else
  echo "⚠ $PREFIX 에 포탈 설치본(app/server/src/index.js 또는 runtime/node)이 없어 지우지 않습니다 — 경로를 확인한 뒤 직접 정리하세요." >&2
fi

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
