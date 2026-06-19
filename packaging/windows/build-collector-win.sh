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
#       --node-zip /path/node-v22.20.0-win-x64.zip [--out DIR]
#
# Get the Node zip from: https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip

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
