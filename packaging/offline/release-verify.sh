#!/usr/bin/env bash
#
# 릴리스 산출물 서명 확인(검토 S-10, v2.730) — **이미 설치된(신뢰하는) 포탈**의 신뢰 공개키로 새 패키지를 확인한다.
#
#   sudo /opt/vmware-portal/app/release-verify.sh --file vmware-portal-offline-<버전>-el9-x64.tar.gz \
#        --manifest vmware-portal-<버전>.manifest.json
#
# 종료 코드: 0 = 서명 확인 · 1 = 확인했더니 틀림(설치하지 말 것) · 2 = 확인할 수 없음(신뢰 키·manifest 없음) · 3 = 사용법 오류
# 신뢰 키 = 이 설치본의 server/src/upgrade/release-signing-keys.json + CONFIG_DIR/release-signing-keys.conf(있으면).
# 개인키를 다루지 않는다. 오프라인 패키지 업그레이드 전에 **압축을 풀기 전** 실행하세요(docs/RELEASE-SIGNING.md).
set -euo pipefail
APP_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
NODE="$APP_DIR/../runtime/node/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { echo "Node 런타임을 찾지 못했습니다($APP_DIR/../runtime/node/bin/node)." >&2; exit 3; }
CONFIG_DIR="${CONFIG_DIR:-/etc/vmware-portal}"
POLICY="$(grep -E '^UPGRADE_SIGNATURE_POLICY=' "$CONFIG_DIR/portal.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
exec env CONFIG_DIR="$CONFIG_DIR" UPGRADE_SIGNATURE_POLICY="$POLICY" "$NODE" "$APP_DIR/server/src/upgrade/verifyCli.js" "$@"
