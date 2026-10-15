#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# OTP(TOTP) 콘솔 등록 래퍼 — 리눅스 설치본에서 긴 경로/계정 지정 없이 실행한다.
#
#   sudo vmware-portal-otp --list                  (오프라인 설치본 — install.sh 가 만든 root 소유 래퍼)
#   sudo vmware-portal-otp admin
#   sudo vmware-portal-otp admin --confirm 123456
#   sudo vmware-portal-otp admin --disable
#
# ⚠ v2.741(감사 INJPKG-01): 이 파일은 앱 트리 안에 있어 서비스 계정이 고칠 수 있다 — `sudo <앱 경로>/otp-enroll.sh` 처럼 root 로
#   직접 실행하지 말 것(서비스 계정 권한을 얻은 공격자의 코드가 root 로 돈다). root 소유 래퍼(vmware-portal-otp)는 이 파일을
#   읽기 전에 서비스 계정으로 권한을 내린다.
#
# 이 스크립트는 다음을 자동으로 처리한다:
#   · 번들 Node 런타임 경로(<prefix>/runtime/node/bin/node) 탐색 — 시스템 node 폴백
#   · CONFIG_DIR 결정(환경변수 → portal.env → 기본 /etc/vmware-portal → 앱 내부 config)
#   · 서비스 계정으로 강등 실행(root 로 실행 시) — users.json 이 root 소유가 되어
#     이후 포탈이 사용자 정보를 저장하지 못하는 사고를 방지
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# v2.741: 링크로 불려도 실제 위치를 쓴다(readlink -f — 예전에는 링크가 있는 폴더를 앱 폴더로 읽어 '도구를 찾을 수 없습니다' 로 끝났다).
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"   # …/app
PREFIX="$(dirname "$APP_DIR")"                            # …/vmware-portal
TOOL="$APP_DIR/server/src/tools/otp-enroll.js"
SERVICE_NAME="${SERVICE_NAME:-vmware-portal}"
# 도구가 다음 단계를 안내할 때 쓸 호출 형태(v2.674) — root 로 실행했으면 sudo 를 붙여 안내한다.
#   root 소유 래퍼가 낮춰 불렀으면 그 래퍼의 호출 형태(VP_LAUNCHER_CMD — 예 'sudo /usr/local/bin/vmware-portal-otp')를 쓴다.
CMD_HINT="$0"; [[ "$(id -u)" -eq 0 ]] && CMD_HINT="sudo $0"
[[ "${VP_LAUNCHER:-}" == 1 && -n "${VP_LAUNCHER_CMD:-}" ]] && CMD_HINT="$VP_LAUNCHER_CMD"
if [[ "$(id -u)" -eq 0 && -z "${VP_LAUNCHER:-}" ]]; then
  ROOT_TOOL="${VP_ROOT_TOOLS_BASE:-/usr/local/libexec/vmware-portal}$PREFIX/vmware-portal-otp"
  if [[ -f "$ROOT_TOOL" && ! -L "$ROOT_TOOL" && "$(stat -c %u "$ROOT_TOOL" 2>/dev/null)" == 0 ]]; then
    exec "$ROOT_TOOL" "$@"   # 변조되지 않은 이 파일이 할 수 있는 안내 — 보안은 root 소유 래퍼가 맡는다
  fi
fi

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
  exec sudo -u "$RUN_USER" env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" OTP_ENROLL_CMD="$CMD_HINT" "$NODE" "$TOOL" "$@"
fi
# SERVICE_NAME 도 넘긴다(v2.674) — 도구의 완료 문구가 재시작할 서비스 이름을 이 래퍼가 본 이름 그대로 말하게.
exec env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" OTP_ENROLL_CMD="$CMD_HINT" "$NODE" "$TOOL" "$@"
