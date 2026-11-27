#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 계정 관리 콘솔 메뉴 래퍼(v2.723) — 계정 생성·편집·비밀번호·계정별 로그인 방식·OTP·삭제.
#
#   sudo vmware-portal-users          # 메뉴(오프라인 설치본 — install.sh 가 만든 root 소유 래퍼)
#   sudo vmware-portal-users --list   # 목록만
#
# ⚠ v2.741(감사 INJPKG-01): 이 파일은 앱 트리 안에 있어 서비스 계정이 고칠 수 있다 — `sudo <앱 경로>/user-admin.sh` 처럼 root 로
#   직접 실행하지 말 것(서비스 계정 권한을 얻은 공격자의 코드가 root 로 돈다). root 소유 래퍼(vmware-portal-users)는 이 파일을
#   읽기 전에 서비스 계정으로 권한을 내리고 VP_LAUNCHER=1 을 넘긴다 — 그때 '지금 재시작'(종료코드 10)은 래퍼가 root 로 한다.
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

# vp_env_key_value <키 이름> — stdin 의 env 파일 본문에서 그 키의 값(마지막 줄 우선). 보안 잔여 11-27 M3: packaging/offline/release-verify-lib.sh 의 같은 이름 함수와
#   글자 그대로 같은 사본이다(이 파일은 그 라이브러리를 읽을 수 없다 — 시험이 세 사본 · JS parseSecretsKey 를 대조한다). 고칠 때는 셋을 함께.
vp_env_key_value() {
  local key="$1" line="" body="" rest="" v="" val="" found=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    body="$line"
    if [[ "$body" == "export "* ]]; then body="${body:7}"; body="${body#"${body%%[![:space:]]*}"}"; fi
    [[ "$body" == "$key"* ]] || continue
    rest="${body:${#key}}"; rest="${rest#"${rest%%[![:space:]]*}"}"
    [[ "$rest" == =* ]] || continue
    v="${rest:1}"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"
    if (( ${#v} >= 2 )) && { [[ "${v:0:1}" == '"' && "${v: -1}" == '"' ]] || [[ "${v:0:1}" == "'" && "${v: -1}" == "'" ]]; }; then v="${v:1:${#v}-2}"; fi
    val="$v"; found=1
  done
  if (( found )); then printf '%s' "$val"; fi
  return 0
}

RUN_USER=""; CAN_RESTART=0
# root 소유 래퍼가 서비스 계정으로 낮춰 부른 경우 — 재시작은 그 래퍼가 한다(종료코드 10 을 그대로 돌려준다).
[[ "${VP_LAUNCHER:-}" == 1 ]] && CAN_RESTART=1
if [[ "$(id -u)" -eq 0 ]]; then
  CAN_RESTART=1
  ROOT_TOOL="${VP_ROOT_TOOLS_BASE:-/usr/local/libexec/vmware-portal}$PREFIX/vmware-portal-users"
  if [[ -z "${VP_LAUNCHER:-}" && -f "$ROOT_TOOL" && ! -L "$ROOT_TOOL" && "$(stat -c %u "$ROOT_TOOL" 2>/dev/null)" == 0 ]]; then
    exec "$ROOT_TOOL" "$@"   # 변조되지 않은 이 파일이 할 수 있는 안내 — 보안은 root 소유 래퍼가 맡는다
  fi
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
  # 보안 잔여 11-27 M3(반증 1회차 M-2): root 로 낮춰 부를 때 portal.env 의 SECRETS_KEY 를 **환경으로** 넘긴다(명령줄 아님 — sudo 로그 · /proc cmdline).
  #   서비스 계정이 못 읽는 portal.env(root:root)에서도 도구가 봉인된 OTP 키를 열고 새로 봉인하게. 링크 · 일반 파일이 아니면 읽지 않는다(64KB 상한).
  if [[ -z "${SECRETS_KEY:-}" && -f "$CONFIG_DIR/portal.env" && ! -L "$CONFIG_DIR/portal.env" ]]; then
    SKEY="$(head -c 65536 -- "$CONFIG_DIR/portal.env" 2>/dev/null | vp_env_key_value SECRETS_KEY || true)"
    if [[ ${#SKEY} -ge 16 ]]; then export SECRETS_KEY="$SKEY"; fi
    unset SKEY
  fi
  KEEP_ENV=(); if [[ -n "${SECRETS_KEY:-}" ]]; then KEEP_ENV=(--preserve-env=SECRETS_KEY); fi
  sudo -u "$RUN_USER" "${KEEP_ENV[@]}" env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" USER_ADMIN_CAN_RESTART="$CAN_RESTART" "${EXTRA_ENV[@]}" "$NODE" "$TOOL" "$@"
else
  env CONFIG_DIR="$CONFIG_DIR" SERVICE_NAME="$SERVICE_NAME" USER_ADMIN_CAN_RESTART="$CAN_RESTART" "${EXTRA_ENV[@]}" "$NODE" "$TOOL" "$@"
fi
rc=$?
if [[ $rc -eq 10 ]]; then
  if [[ "${VP_LAUNCHER:-}" == 1 && "$(id -u)" -ne 0 ]]; then exit 10; fi   # root 소유 래퍼가 재시작한다
  if [[ $CAN_RESTART -eq 1 && "$(id -u)" -eq 0 ]]; then
    echo "==> ${SERVICE_NAME} 재시작 중…"
    if systemctl restart "$SERVICE_NAME"; then echo "==> 재시작했습니다."; exit 0; fi
    echo "✖ 재시작에 실패했습니다 — sudo systemctl status ${SERVICE_NAME} 로 확인하세요." >&2; exit 1
  fi
  echo "재시작은 root 로 하세요: sudo systemctl restart ${SERVICE_NAME}"; exit 0
fi
exit $rc
