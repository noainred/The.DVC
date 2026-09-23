#!/usr/bin/env bash
#
# Build a self-contained WINDOWS (x64) package of the portal/collector.
#
# The portal and the datacenter collector are the SAME Node app — running it
# with COLLECTOR_TOKEN set turns it into a collector agent. This produces a zip
# that runs on Windows Server / Windows 10+ with no internet, npm, or compiler:
#   - bundles the Node.js Windows runtime (node.exe)
#   - vendored node_modules (pure-JS deps: express/cors/undici — cross-platform)
#   - prebuilt web/dist
#   - start-portal.bat + install-service.ps1 (scheduled-task service)
#
# The server deps contain no native addons, so the repo's existing
# node_modules (from `npm run install:all`) are reused as-is.
#
# Usage (run on any machine; provide a downloaded Windows Node zip):
#   packaging/windows/build-collector-win.sh \
#       --node-zip /path/node-v22.23.2-win-x64.zip [--out DIR]
#
# Get the Node zip from: https://nodejs.org/dist/v22.23.2/node-v22.23.2-win-x64.zip

set -euo pipefail

NODE_ZIP="${NODE_ZIP:-}"
OUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-zip) NODE_ZIP="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$NODE_ZIP" && -f "$NODE_ZIP" ]] || { echo "ERROR: --node-zip <node-vXX-win-x64.zip> 가 필요합니다." >&2; exit 1; }
command -v unzip >/dev/null || { echo "ERROR: unzip 필요" >&2; exit 1; }
command -v zip   >/dev/null || { echo "ERROR: zip 필요" >&2; exit 1; }

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"
PKG="vmware-portal-win-${VERSION}-x64"
BUILD_DIR="$(mktemp -d)"
STAGE="$BUILD_DIR/$PKG"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-offline}"
trap 'rm -rf "$BUILD_DIR"' EXIT
mkdir -p "$STAGE/runtime" "$OUT_DIR"
# zip은 BUILD_DIR 안에서( cd ) 실행되므로 OUT_DIR을 절대경로로 정규화한다(상대 --out 대응).
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

echo "==> Windows 패키지 빌드: $PKG"

# 1) Node Windows runtime
unzip -q "$NODE_ZIP" -d "$STAGE/runtime"
EXTRACTED="$(find "$STAGE/runtime" -maxdepth 1 -type d -name 'node-v*-win-x64' | head -1)"
[[ -n "$EXTRACTED" ]] || { echo "node 런타임 추출 실패" >&2; exit 1; }
mv "$EXTRACTED" "$STAGE/runtime/node"

# 2) Build web client (needs web/node_modules already installed)
[[ -d "$REPO_ROOT/web/node_modules" ]] || { echo "먼저 온라인에서 'npm run install:all' 실행 필요" >&2; exit 1; }
( cd "$REPO_ROOT/web" && npm run build )

# 3) Stage the app (server src + vendored deps + web dist)
APP="$STAGE/app"
mkdir -p "$APP/server" "$APP/web"
cp -r "$REPO_ROOT/server/src" "$APP/server/src"
cp -r "$REPO_ROOT/server/config" "$APP/server/config"
# 보안(v2.591 P2 — offline build-package.sh 의 L-9 와 같은 규칙): 빌드 호스트의 '런타임' config
# (테스트·개발 중 생긴 auth-secret·DB·감사 로그·내부 IP 가 담긴 수집 설정)를 공개 릴리스 자산에 싣지 않는다.
# v2.590 의 Windows zip 에는 CI 머신의 auth-secret·audit.ndjson·ping-targets.json 이 실제로 들어 있었다 —
# CONFIG_DIR 없이 앱 폴더에서 실행하면 그 공개 서명키로 세션 토큰을 위조할 수 있다. 예제만 남긴다.
find "$APP/server/config" -mindepth 1 -maxdepth 1 \
  \( -name '*.db' -o -name '*.db-wal' -o -name '*.db-shm' -o -name '*.ndjson' \
     -o -name 'ipam-scan.json' -o -name 'portal.env' -o -name 'secrets-key' -o -name 'auth-secret' \
     -o -name '*.txt' -o -name '*.corrupt.*' -o -type d \
     -o \( -name '*.json' ! -name '*.example.json' \) \) -exec rm -rf {} + 2>/dev/null || true
cp "$REPO_ROOT/server/package.json" "$APP/server/"
[[ -d "$REPO_ROOT/server/node_modules" ]] || { echo "server/node_modules 필요 ('npm run install:all')" >&2; exit 1; }
cp -a "$REPO_ROOT/server/node_modules" "$APP/server/node_modules"
cp "$REPO_ROOT/package.json" "$APP/"
cp -r "$REPO_ROOT/web/dist" "$APP/web/dist"

# 4) Scripts + docs
cp "$SCRIPT_DIR/start-portal.bat" "$STAGE/"
cp "$SCRIPT_DIR/install-service.ps1" "$STAGE/"
cp "$SCRIPT_DIR/uninstall-service.ps1" "$STAGE/"
cp "$SCRIPT_DIR/portal.env.example.bat" "$STAGE/portal.env.bat"
cp "$SCRIPT_DIR/README-WINDOWS.md" "$STAGE/README.md"
echo "${VERSION}" > "$STAGE/VERSION"

# 5) Zip it
OUT="$OUT_DIR/${PKG}.zip"
( cd "$BUILD_DIR" && zip -qr "$OUT" "$PKG" )
( cd "$OUT_DIR" && sha256sum "$(basename "$OUT")" > "$(basename "$OUT").sha256" )

echo ""
echo "✅ Windows 패키지 완료: $OUT ($(du -h "$OUT" | cut -f1))"
echo "   압축 해제 후 portal.env.bat 수정 → 관리자 PowerShell 에서 .\\install-service.ps1"
