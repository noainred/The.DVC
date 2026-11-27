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
# v2.597(감사 DEPS2597-03 — 정정): 예전 주석은 'no native addons' 라 했지만 사실이 아니다 — ssh2(sshcrypto.node)·
# cpu-features(cpufeatures.node)는 빌드 호스트(Linux) ELF 로 실린다. Windows 에서는 로드되지 않고 ssh2 가 순수 JS 로
# 폴백한다(기능은 같고 SSH 암호화가 느리다). 저장소의 node_modules(`npm run install:all`)를 그대로 쓴다.
#
# Usage (run on any machine; provide a downloaded Windows Node zip):
#   packaging/windows/build-collector-win.sh \
#       --node-zip /path/node-v22.23.5-win-x64.zip [--out DIR] [--node-sha256 <64자리 sha256>]
#
# Get the Node zip from: https://nodejs.org/dist/v22.23.5/node-v22.23.5-win-x64.zip
#
# 런타임 무결성(보안 잔여 11-27 G4): zip 은 풀기 전에 packaging/node-runtime.sha256(저장소 고정값)과 대조한다.
#   릴리스 워크플로가 zip 이름을 node-win.zip 으로 바꾸므로 이름이 아니라 **해시로** 고정값 줄을 찾는다.
#   고정되지 않은 zip 은 nodejs.org SHASUMS256.txt 의 서명을 확인한 뒤 --node-sha256 으로 명시해야 한다(환경 변수로는 받지 않는다).

set -euo pipefail

# 검증 버전(server/src/util/runtimeCheck.js RUNTIME_CONTRACT.releaseVersion 과 같아야 한다 — 시험이 대조).
VERIFIED_NODE_VERSION="22.23.5"
NODE_ZIP="${NODE_ZIP:-}"
NODE_SHA256=""
OUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-zip) NODE_ZIP="$2"; shift 2 ;;
    --node-sha256) NODE_SHA256="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

[[ -n "$NODE_ZIP" && -f "$NODE_ZIP" ]] || { echo "ERROR: --node-zip <node-vXX-win-x64.zip> 가 필요합니다." >&2; exit 1; }

# 보안 잔여 11-27 G4 — 런타임 zip 해시 확인(도구 검사 · unzip · 웹 빌드보다 먼저).
if [[ -n "$NODE_SHA256" ]]; then
  NODE_SHA256="$(printf '%s' "$NODE_SHA256" | tr '[:upper:]' '[:lower:]')"
  [[ "$NODE_SHA256" =~ ^[0-9a-f]{64}$ ]] || { echo "ERROR: --node-sha256 은 64자리 16진수 sha256 이어야 합니다." >&2; exit 1; }
fi
if command -v sha256sum >/dev/null; then NODE_ZIP_SHA="$(sha256sum -- "$NODE_ZIP" | cut -d' ' -f1)" || NODE_ZIP_SHA=""
elif command -v shasum >/dev/null; then NODE_ZIP_SHA="$(shasum -a 256 -- "$NODE_ZIP" | cut -d' ' -f1)" || NODE_ZIP_SHA=""
else NODE_ZIP_SHA=""; fi
[[ "$NODE_ZIP_SHA" =~ ^[0-9a-f]{64}$ ]] || { echo "ERROR: Node 런타임 zip 의 해시를 계산하지 못했습니다(sha256sum 또는 shasum 필요) — 무결성을 확인할 수 없어 중단합니다." >&2; exit 1; }
if [[ -n "$NODE_SHA256" ]]; then
  [[ "$NODE_ZIP_SHA" == "$NODE_SHA256" ]] || { echo "ERROR: Node 런타임 zip 의 해시가 --node-sha256 명시값과 다릅니다 — 변조·손상되었거나 다른 파일입니다." >&2; exit 1; }
  echo "    런타임 해시 확인: --node-sha256 명시값 일치(저장소 고정값이 아님 — 운영 배포 전 확인)"
else
  NODE_PIN_FILE="$REPO_ROOT/packaging/node-runtime.sha256"
  [[ -r "$NODE_PIN_FILE" ]] || { echo "ERROR: 저장소 고정값 파일(packaging/node-runtime.sha256)을 읽지 못했습니다 — 런타임 무결성을 확인할 수 없어 중단합니다." >&2; exit 1; }
  NODE_PIN_NAME="$(awk -v h="$NODE_ZIP_SHA" '$0 !~ /^#/ && NF == 2 && $1 == h && $2 ~ /^node-v[0-9]+\.[0-9]+\.[0-9]+-win-x64\.zip$/ { print $2; exit }' "$NODE_PIN_FILE")"
  if [[ -z "$NODE_PIN_NAME" ]]; then
    echo "ERROR: Node 런타임 zip 의 해시가 저장소 고정값(packaging/node-runtime.sha256)에 없습니다 — 변조·손상되었거나 다른 버전입니다." >&2
    echo "       검증 버전 ${VERIFIED_NODE_VERSION} 의 node-v${VERIFIED_NODE_VERSION}-win-x64.zip 을 받으세요. 다른 버전을 꼭 넣어야 하면 nodejs.org SHASUMS256.txt 의 서명을 확인한 뒤 --node-sha256 <해시> 로 지정하세요." >&2
    exit 1
  fi
  echo "    런타임 해시 확인: 저장소 고정값 일치(${NODE_PIN_NAME})"
fi

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
# 검토 I-06 · 보안 잔여 11-27 G4: 풀린 폴더 이름으로 버전을 알린다(Windows node.exe 는 여기서 실행할 수 없다 — build-package.sh 와 같은 안내).
case "$(basename "$EXTRACTED")" in
  "node-v${VERIFIED_NODE_VERSION}-win-x64") ;;
  node-v22.*) echo "ⓘ 번들 Node 런타임 $(basename "$EXTRACTED") — 계약(22.x) 안이지만 검증 버전(${VERIFIED_NODE_VERSION})과 다릅니다." ;;
  *) echo "⚠⚠ 번들 Node 런타임이 $(basename "$EXTRACTED") 입니다 — 지원 범위는 Node 22.x(검증 ${VERIFIED_NODE_VERSION})입니다. 장비 통신이 실패할 수 있습니다(docs/INSTALL.md 부록 A.0)." >&2 ;;
esac
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
# v2.741(감사 INJPKG-05): 거부 목록이 아니라 **허용 목록**이다 — 예제(*.example.json)만 남기고 나머지(점 파일·하위 폴더·
#   원자 쓰기 임시 파일 .*.tmp-*·*.bak·*.conf·rma-*.env·이름 없는 새 확장자)는 전부 지운다. 거부 목록은 나열하지 않은 확장자를
#   그대로 실었다. 저장소에 추적되는 server/config 파일은 *.example.json 뿐이다(test/audit2741l.test.js 가 git ls-files 로 고정).
#   두 빌드(offline·Windows)의 식은 같아야 한다(test/audit2597.test.js 가 대조).
find "$APP/server/config" -mindepth 1 -maxdepth 1 \
  ! -name '*.example.json' -exec rm -rf {} + 2>/dev/null || true
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
