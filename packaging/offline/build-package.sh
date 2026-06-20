#!/usr/bin/env bash
#
# Build a fully self-contained OFFLINE installation package for Rocky Linux 9.
#
# The resulting tarball installs on an air-gapped Rocky 9 host with no internet,
# npm, or compiler. It bundles:
#   - the Node.js runtime (linux-x64)
#   - the portal app with server production dependencies vendored (node_modules)
#   - the pre-built web client (web/dist)
#   - install/uninstall scripts + a systemd unit
#
# Two ways to build:
#   ONLINE  (default): downloads the Node.js runtime and installs deps via npm.
#   OFFLINE (--offline): no network at all — reuses an already-downloaded Node
#           tarball (--node-tarball) and the repo's existing node_modules. Run
#           `npm run install:all` once on an internet machine first, then this
#           script can be re-run on an air-gapped build host.
#
# Usage:
#   packaging/offline/build-package.sh [--node-version 22.20.0] [--out DIR]
#   packaging/offline/build-package.sh --offline --node-tarball /path/node-v22.20.0-linux-x64.tar.xz

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.20.0}"
ARCH="x64"
OUT_DIR=""
OFFLINE="${OFFLINE:-0}"
NODE_TARBALL="${NODE_TARBALL:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --node-tarball) NODE_TARBALL="$2"; shift 2 ;;
    --offline) OFFLINE=1; shift ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"
PKG_NAME="vmware-portal"
# Distro stamp in the artifact name; el9 packages are RHEL9-compatible (Rocky /
# CentOS Stream / Alma / RHEL 9). Override with STAMP env, e.g. STAMP=cent9-x64.
STAMP="${STAMP:-el9-${ARCH}}"
BUILD_DIR="$(mktemp -d)"
STAGE="$BUILD_DIR/${PKG_NAME}-offline-${VERSION}-${STAMP}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-offline}"
NODE_PKG="node-v${NODE_VERSION}-linux-${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz"
NODE_SHA_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

echo "==> Building offline package for ${PKG_NAME} v${VERSION} (Rocky Linux 9, ${ARCH})"
[[ "$OFFLINE" == "1" ]] && echo "    mode: OFFLINE (no network)" || echo "    mode: online (bundled Node v${NODE_VERSION})"
mkdir -p "$STAGE" "$OUT_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

# 1) Obtain the Node.js runtime --------------------------------------------
mkdir -p "$STAGE/runtime"
if [[ -n "$NODE_TARBALL" ]]; then
  echo "==> Using local Node.js tarball: $NODE_TARBALL"
  [[ -f "$NODE_TARBALL" ]] || { echo "node tarball not found: $NODE_TARBALL" >&2; exit 1; }
  tar -xf "$NODE_TARBALL" -C "$STAGE/runtime"
elif [[ "$OFFLINE" == "1" ]]; then
  echo "ERROR: --offline 모드에서는 --node-tarball 로 미리 받은 Node 압축본을 지정해야 합니다." >&2
  echo "       https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz 를 미리 받아 복사하세요." >&2
  exit 1
else
  echo "==> Downloading Node.js runtime"
  curl -fsSL "$NODE_URL" -o "$BUILD_DIR/${NODE_PKG}.tar.xz"
  if curl -fsSL "$NODE_SHA_URL" -o "$BUILD_DIR/SHASUMS256.txt" 2>/dev/null; then
    ( cd "$BUILD_DIR" && grep " ${NODE_PKG}.tar.xz\$" SHASUMS256.txt | sha256sum -c - )
    echo "    checksum OK"
  fi
  tar -xJf "$BUILD_DIR/${NODE_PKG}.tar.xz" -C "$STAGE/runtime"
fi
# Normalize the extracted runtime directory to runtime/node
EXTRACTED="$(find "$STAGE/runtime" -maxdepth 1 -type d -name 'node-v*' | head -1)"
[[ -n "$EXTRACTED" ]] || { echo "Node runtime extraction failed" >&2; exit 1; }
mv "$EXTRACTED" "$STAGE/runtime/node"

NODE_BIN="$STAGE/runtime/node/bin/node"
NPM_CLI="$STAGE/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
run_npm() { "$NODE_BIN" "$NPM_CLI" "$@"; }

# 2) Build the web client (prebuilt static assets — no build on target) ------
echo "==> Building web client"
if [[ "$OFFLINE" == "1" ]]; then
  [[ -d "$REPO_ROOT/web/node_modules" ]] || {
    echo "ERROR: offline 빌드에는 web/node_modules 가 필요합니다. 먼저 온라인에서 'npm run install:all' 실행." >&2; exit 1; }
else
  run_npm --prefix "$REPO_ROOT/web" ci --no-audit --no-fund
fi
run_npm --prefix "$REPO_ROOT/web" run build   # vite (local) — no network needed

# 3) Stage the app + server production dependencies --------------------------
echo "==> Staging app + server dependencies"
APP="$STAGE/app"
mkdir -p "$APP/server" "$APP/web"
cp -r "$REPO_ROOT/server/src" "$APP/server/src"
cp -r "$REPO_ROOT/server/config" "$APP/server/config"
cp "$REPO_ROOT/server/package.json" "$REPO_ROOT/server/package-lock.json" "$APP/server/"
cp "$REPO_ROOT/package.json" "$APP/"
cp -r "$REPO_ROOT/web/dist" "$APP/web/dist"
[[ -f "$REPO_ROOT/README.md" ]] && cp "$REPO_ROOT/README.md" "$APP/"

if [[ "$OFFLINE" == "1" ]]; then
  # The server has no devDependencies, so the existing tree is production-only.
  [[ -d "$REPO_ROOT/server/node_modules" ]] || {
    echo "ERROR: offline 빌드에는 server/node_modules 가 필요합니다. 먼저 'npm run install:all' 실행." >&2; exit 1; }
  cp -a "$REPO_ROOT/server/node_modules" "$APP/server/node_modules"
else
  run_npm --prefix "$APP/server" ci --omit=dev --no-audit --no-fund
fi

# 4) Installer assets --------------------------------------------------------
echo "==> Adding installer + systemd unit"
cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" "$STAGE/"
cp "$SCRIPT_DIR/vmware-portal.service" "$STAGE/"
cp "$SCRIPT_DIR/portal.env.example" "$STAGE/"
cp "$SCRIPT_DIR/OFFLINE-INSTALL.md" "$STAGE/README.md"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
echo "${VERSION}" > "$STAGE/VERSION"

# 5) Pack the full installer package -----------------------------------------
TARBALL="$OUT_DIR/${PKG_NAME}-offline-${VERSION}-${STAMP}.tar.gz"
echo "==> Packing installer package ${TARBALL}"
tar -czf "$TARBALL" -C "$BUILD_DIR" "$(basename "$STAGE")"
( cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )

# 6) Pack the auto-upgrade bundle ---------------------------------------------
# Members live under "vmware-portal/" so the in-app upgrader (watch folder /
# admin UI) can swap the app dir. The Node runtime is NOT included — only the
# app (server + node_modules + web/dist + package.json) is replaced on upgrade.
BUNDLE="$OUT_DIR/${PKG_NAME}-${VERSION}.tar.gz"
echo "==> Packing upgrade bundle ${BUNDLE}"
cp -a "$APP" "$BUILD_DIR/${PKG_NAME}"
tar -czf "$BUNDLE" -C "$BUILD_DIR" "${PKG_NAME}"
( cd "$OUT_DIR" && sha256sum "$(basename "$BUNDLE")" > "$(basename "$BUNDLE").sha256" )

echo ""
echo "✅ Build complete:"
echo "    설치 패키지 : $TARBALL  ($(du -h "$TARBALL" | cut -f1))"
echo "                  → 최초 설치/수동 재설치: 풀고 sudo ./install.sh"
echo "    업그레이드 번들: $BUNDLE  ($(du -h "$BUNDLE" | cut -f1))"
echo "                  → 자동/수동 업그레이드: 감시 폴더에 넣거나 관리자 UI로 적용"
