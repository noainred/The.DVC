#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OTP(TOTP) 콘솔 등록 래퍼 — 리눅스 설치본에서 긴 경로/계정 지정 없이 실행한다.
#
#   sudo /opt/vmware-portal/app/otp-enroll.sh --list
#   sudo /opt/vmware-portal/app/otp-enroll.sh admin
#   sudo /opt/vmware-portal/app/otp-enroll.sh admin --confirm 123456
#   sudo /opt/vmware-portal/app/otp-enroll.sh admin --disable
#
# 이 스크립트는 다음을 자동으로 처리한다:
#   · 번들 Node 런타임 경로(<prefix>/runtime/node/bin/node) 탐색 — 시스템 node 폴백
#   · CONFIG_DIR 결정(환경변수 → portal.env → 기본 /etc/vmware-portal → 앱 내부 config)
#   · 서비스 계정으로 강등 실행(root 로 실행 시) — users.json 이 root 소유가 되어
#     이후 포탈이 사용자 정보를 저장하지 못하는 사고를 방지
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # …/app
PREFIX="$(dirname "$APP_DIR")"                            # …/vmware-portal
TOOL="$APP_DIR/server/src/tools/otp-enroll.js"
SERVICE_NAME="${SERVICE_NAME:-vmware-portal}"

[[ -f "$TOOL" ]] || { echo "✖ 등록 도구를 찾을 수 없습니다: $TOOL (v2.205.0 이상 필요)" >&2; exit 1; }

# 1) CONFIG_DIR — 환경변수가 최우선, 없으면 표준 위치의 portal.env, 그다음 기본값.
if [[ -z "${CONFIG_DIR:-}" ]]; then
  for env_file in /etc/vmware-portal/portal.env "$PREFIX/portal.env"; do
    if [[ -f "$env_file" ]]; then
      # portal.env 의 CONFIG_DIR 만 안전하게 추출(쉘 평가 없이).
      val="$(sed -n 's/^[[:space:]]*CONFIG_DIR[[:space:]]*=[[:space:]]*//p' "$env_file" | tail -1 | tr -d '"'"'"'')"
      [[ -n "$val" ]] && CONFIG_DIR="$val"
      break
    fi
  done
fi
CONFIG_DIR="${CONFIG_DIR:-/etc/vmware-portal}"
[[ -d "$CONFIG_DIR" ]] || CONFIG_DIR="$APP_DIR/server/config"   # git 소스/개발 환경 폴백

# 2) Node 런타임 — 오프라인 패키지의 번들 Node 우선.
NODE="$PREFIX/runtime/node/bin/node"
if [[ ! -x "$NODE" ]]; then
  NODE="$(command -v node || true)"
  [[ -n "$NODE" ]] || { echo "✖ Node 런타임을 찾을 수 없습니다(번들·시스템 모두)." >&2; exit 1; }
fi

# 3) 실행 계정 — root 라면 서비스 계정으로 강등(파일 소유권 보존).
RUN_USER=""
if [[ "$(id -u)" -eq 0 ]]; then
  RUN_USER="$(systemctl show -p User --value "$SERVICE_NAME" 2>/dev/null || true)"
  [[ -z "$RUN_USER" || "$RUN_USER" == "root" ]] && RUN_USER="$(stat -c '%U' "$CONFIG_DIR" 2>/dev/null || echo '')"
  [[ "$RUN_USER" == "root" ]] && RUN_USER=""
fi

if [[ -n "$RUN_USER" ]] && id "$RUN_USER" &>/dev/null; then
  exec sudo -u "$RUN_USER" env CONFIG_DIR="$CONFIG_DIR" "$NODE" "$TOOL" "$@"
fi
exec env CONFIG_DIR="$CONFIG_DIR" "$NODE" "$TOOL" "$@"
