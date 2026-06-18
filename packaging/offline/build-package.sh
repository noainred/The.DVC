#!/usr/bin/env bash
#
# Build a fully self-contained OFFLINE installation package for Rocky Linux 9.
#
# Run this on a machine WITH internet access. It bundles:
#   - the Node.js runtime (linux-x64)
#   - the portal app with server production dependencies vendored (node_modules)
#   - the pre-built web client (web/dist) — no build step needed on the target
#   - install/uninstall scripts + a systemd unit
#
# The resulting tarball can be copied to an air-gapped Rocky 9 host and
# installed with ./install.sh — no internet, no npm, no compiler required.
#
# Usage:  packaging/offline/build-package.sh [--node-version 22.x.y] [--out DIR]

set -euo pipefail

NODE_VERSION="${NODE_VERSION:-22.20.0}"   # bundled Node.js (override with --node-version)
ARCH="x64"
OUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version" 2>/dev/null || echo 0.0.0)"
PKG_NAME="vmware-portal"
STAMP="el9-${ARCH}"
BUILD_DIR="$(mktemp -d)"
STAGE="$BUILD_DIR/${PKG_NAME}-offline-${VERSION}-${STAMP}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-offline}"
NODE_PKG="node-v${NODE_VERSION}-linux-${ARCH}"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_PKG}.tar.xz"
NODE_SHA_URL="https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"

echo "==> Building offline package for ${PKG_NAME} v${VERSION} (Rocky Linux 9, ${ARCH})"
echo "    bundled Node.js: v${NODE_VERSION}"
mkdir -p "$STAGE" "$OUT_DIR"
trap 'rm -rf "$BUILD_DIR"' EXIT

# 1) Download + verify the Node.js runtime ----------------------------------
echo "==> Downloading Node.js runtime"
curl -fsSL "$NODE_URL" -o "$BUILD_DIR/${NODE_PKG}.tar.xz"
if curl -fsSL "$NODE_SHA_URL" -o "$BUILD_DIR/SHASUMS256.txt" 2>/dev/null; then
  ( cd "$BUILD_DIR" && grep " ${NODE_PKG}.tar.xz\$" SHASUMS256.txt | sha256sum -c - )
  echo "    checksum OK"
fi
mkdir -p "$STAGE/runtime"
tar -xJf "$BUILD_DIR/${NODE_PKG}.tar.xz" -C "$STAGE/runtime"
mv "$STAGE/runtime/${NODE_PKG}" "$STAGE/runtime/node"

NODE_BIN="$STAGE/runtime/node/bin/node"
NPM_CLI="$STAGE/runtime/node/lib/node_modules/npm/bin/npm-cli.js"
run_npm() { "$NODE_BIN" "$NPM_CLI" "$@"; }

# 2) Build the web client (prebuilt static assets — no build on target) ------
echo "==> Building web client"
run_npm --prefix "$REPO_ROOT/web" ci --no-audit --no-fund
run_npm --prefix "$REPO_ROOT/web" run build

# 3) Vendor server production dependencies -----------------------------------
echo "==> Vendoring server dependencies (production only)"
APP="$STAGE/app"
mkdir -p "$APP/server" "$APP/web"
cp -r "$REPO_ROOT/server/src" "$APP/server/src"
cp -r "$REPO_ROOT/server/config" "$APP/server/config"
cp "$REPO_ROOT/server/package.json" "$REPO_ROOT/server/package-lock.json" "$APP/server/"
cp "$REPO_ROOT/package.json" "$APP/"
cp -r "$REPO_ROOT/web/dist" "$APP/web/dist"
[[ -f "$REPO_ROOT/README.md" ]] && cp "$REPO_ROOT/README.md" "$APP/"

# install production node_modules into the staged server using the bundled npm
run_npm --prefix "$APP/server" ci --omit=dev --no-audit --no-fund

# 4) Installer assets --------------------------------------------------------
echo "==> Adding installer + systemd unit"
cp "$SCRIPT_DIR/install.sh" "$SCRIPT_DIR/uninstall.sh" "$STAGE/"
cp "$SCRIPT_DIR/vmware-portal.service" "$STAGE/"
cp "$SCRIPT_DIR/portal.env.example" "$STAGE/"
cp "$SCRIPT_DIR/OFFLINE-INSTALL.md" "$STAGE/README.md"
chmod +x "$STAGE/install.sh" "$STAGE/uninstall.sh"
echo "${VERSION}" > "$STAGE/VERSION"

# 5) Pack --------------------------------------------------------------------
TARBALL="$OUT_DIR/${PKG_NAME}-offline-${VERSION}-${STAMP}.tar.gz"
echo "==> Packing ${TARBALL}"
tar -czf "$TARBALL" -C "$BUILD_DIR" "$(basename "$STAGE")"
( cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$TARBALL").sha256" )

echo ""
echo "✅ Offline package ready:"
echo "    $TARBALL"
echo "    $(du -h "$TARBALL" | cut -f1) — copy to the Rocky 9 host, extract, run ./install.sh"
