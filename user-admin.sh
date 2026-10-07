#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 계정 관리 콘솔 메뉴 래퍼(v2.723) — 계정 생성·편집·비밀번호·계정별 로그인 방식·OTP·삭제.
#
#   sudo /opt/vmware-portal/app/user-admin.sh          # 메뉴
#   sudo /opt/vmware-portal/app/user-admin.sh --list   # 목록만
#   (오프라인 설치본은 install.sh 가 /usr/local/bin/vmware-portal-users 링크를 건다)
#
# otp-enroll.sh 와 같은 일을 처리한다:
#   · 번들 Node 런타임 경로 탐색(시스템 node 폴백)
#   · CONFIG_DIR 결정(환경변수 → portal.env → 기본 /etc/vmware-portal → 앱 내부 config)
#   · root 로 실행하면 서비스 계정으로 강등 실행(users.json 이 root 소유가 되어 포탈이 저장하지 못하는 사고 방지)
# 다른 점: 도구가 '지금 재시작' 을 고르면(종료코드 10) 이 래퍼가 root 권한으로 서비스를 재시작한다.
#   실행 중인 포탈은 사용자 목록을 메모리에 들고 있어 재시작해야 계정 변경을 안다.
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"   # …/app (링크로 불려도 실제 위치)
PREFIX="$(dirname "$APP_DIR")"
TOOL="$APP_DIR/server/src/tools/user-admin.js"
SERVICE_NAME="${SERVICE_NAME:-vmware-portal}"

[[ -f "$TOOL" ]] || { echo "✖ 계정 관리 도구를 찾을 수 없습니다: $TOOL (v2.723.0 이상 필요)" >&2; exit 1; }

if [[ -z "${CONFIG_DIR:-}" ]]; then
  for env_file in /etc/vmware-portal/portal.env "$PREFIX/portal.env"; do
    if [[ -f "$env_file" ]]; then
      val="$(sed -n 's/^[[:space:]]*CONFIG_DIR[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -1 | tr -d '"'"'"'')"
      [[ -n "$val" ]] && CONFIG_DIR="$val"
      break
    fi
  done
fi
CONFIG_DIR="${CONFIG_DIR:-/etc/vmware-portal}"
[[ -d "$CONFIG_DIR" ]] || CONFIG_DIR="$APP_DIR/server/config"

NODE="$PREFIX/runtime/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
  [[ -n "$NODE" ]] || { echo "✖ Node 런타임을 찾을 수 없습니다(번들·시스템 모두)." >&2; exit 1; }
fi

RUN_USER=""; CAN_RESTART=0
if [[ "$(id -u)" -eq 0 ]]; then
  CAN_RESTART=1
  RUN_USER="$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || true)"
  [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]] && RUN_USER="$(stat -c '%U' "$CONFIG_DIR" 2>/dev/null || echo '')"
  [[ "$RUN_USER" == "root" ]] && RUN_USER=""
fi

# portal.env 의 LOGIN_POLICY_USERS·OTP_ROLE_ENFORCE 를 도구에도 넘긴다(쉘 평가 없이 값만) — 포탈과 같은 판정을 보여 주려고.
EXTRA_ENV=()
for key in LOGIN_POLICY_USERS OTP_ROLE_ENFORCE; do
  if [[ -z "${!key:-}" && -f /etc/vmware-portal/portal.env ]]; then
    v="$(sed -n "s/^[[:space:]]*${key}[[:space:]]*=[[:space:]]*//p" /etc/vmware-portal/portal.env | tail -1 | tr -d '"'"'"'')"
    [[ -n "$v" ]] && EXTRA_ENV+=("${key}=${v}")
  elif [[ -n "${!key:-}" ]]; then
    EXTRA_ENV+=("${key}=${!key}")
  fi
done

if [[ -n "$RUN_USER" ]] && id "$RUN_USER" &>/dev/null; then
  sudo -u "$RUN_USER" env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" USER_ADMIN_CAN_RESTART="$CAN_RESTART" "${EXTRA_ENV[@]}" "$NODE" "$TOOL" "$@"
else
  env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" USER_ADMIN_CAN_RESTART="$CAN_RESTART" "${EXTRA_ENV[@]}" "$NODE" "$TOOL" "$@"
fi
rc=$?
if [[ $rc -eq 10 ]]; then
  if [[ $CAN_RESTART -eq 1 ]]; then
    echo "==> ${SERVICE_NAME} 재시작 중…"
    if systemctl restart "$SERVICE_NAME"; then echo "==> 재시작했습니다."; exit 0; fi
    echo "✖ 재시작에 실패했습니다 — sudo systemctl status ${SERVICE_NAME} 로 확인하세요." >&2; exit 1
  fi
  echo "재시작은 root 로 하세요: sudo systemctl restart ${SERVICE_NAME}"; exit 0
fi
exit $rc
