#!/usr/bin/env bash
#
# 릴리스 산출물 서명 확인(검토 S-10, v2.730) — **이미 설치된(신뢰하는) 포탈**의 신뢰 공개키로 새 패키지를 확인한다.
#
#   sudo vmware-portal-verify --file vmware-portal-offline-<버전>-el9-x64.tar.gz \
#        --manifest vmware-portal-<버전>.manifest.json      (install.sh 가 만든 root 소유 사본 — 아래 ⚠ 참고)
#
# 종료 코드: 0 = 서명 확인 · 1 = 확인했더니 틀림(설치하지 말 것) · 2 = 확인할 수 없음(신뢰 키·manifest 없음) · 3 = 사용법 오류
# 신뢰 키 = 이 설치본의 server/src/upgrade/release-signing-keys.json + CONFIG_DIR/release-signing-keys.conf(있으면).
# 개인키를 다루지 않는다. 오프라인 패키지 업그레이드 전에 **압축을 풀기 전** 실행하세요(docs/RELEASE-SIGNING.md).
#
# ⚠ v2.741(감사 INJPKG-01): 이 파일은 앱 트리 안에 있어 서비스 계정이 고칠 수 있다 — root 로 실행하면 서비스 계정 권한을 얻은
#   공격자의 코드가 root 로 돈다. root 로 확인할 때는 install.sh 가 만든 root 소유 사본 `sudo vmware-portal-verify` 를 쓰세요
#   (그 사본은 신뢰 기준도 root 소유 사본만 쓴다). 아래 전달은 이 파일이 변조되지 않았을 때의 안내일 뿐 보안 장치가 아니다.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
ROOT_TOOL="${VP_ROOT_TOOLS_BASE:-/usr/local/libexec/vmware-portal}$(dirname "$APP_DIR")/vmware-portal-verify"
if [[ "$(id -u)" -eq 0 && -f "$ROOT_TOOL" && ! -L "$ROOT_TOOL" && "$(stat -c %u "$ROOT_TOOL" 2>/dev/null)" == 0 ]]; then
  exec "$ROOT_TOOL" "$@"
fi
if [[ "$(id -u)" -eq 0 && "$(stat -c %u "${BASH_SOURCE[0]}" 2>/dev/null || echo 0)" != 0 ]]; then
  echo "⚠ 서비스 계정이 고칠 수 있는 앱 트리의 확인 도구를 root 로 실행하고 있습니다 — install.sh(v2.741 이상)로 설치하면 생기는 'sudo vmware-portal-verify' 를 쓰세요." >&2
fi
NODE="$APP_DIR/../runtime/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node 런타임을 찾지 못했습니다($APP_DIR/../runtime/node/bin/node)." >&2; exit 3; }
CONFIG_DIR="${CONFIG_DIR:-/etc/vmware-portal}"
POLICY="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' "$CONFIG_DIR/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
# v2.742(INJPKG-01): root 소유 도구 폴더의 호스트 키 사본(회수 보존) — root 로 돌 때만 signature.js 가 읽는다.
TRUST_COPY="${VP_ROOT_TOOLS_BASE:-/usr/local/libexec/vmware-portal}$(dirname "$APP_DIR")/trust/release-signing-keys.conf"
exec env CONFIG_DIR="$CONFIG_DIR" UPGRADE_SIGNATURE_POLICY="$POLICY" VP_ROOT_TRUST_COPY="$TRUST_COPY" "$NODE" "$APP_DIR/server/src/upgrade/verifyCli.js" "$@"
