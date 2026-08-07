#!/usr/bin/env bash
#
# UAG Monitor 패키지 빌드 — 하나의 코드(uagmon/)로 세 가지 배포본을 만든다.
#
#   uag-monitor-<v>.tar.gz              서버(웹) 버전 — 대상 서버의 Node(>=20) 로 실행
#   uag-monitor-<v>-win-x64.zip         Windows 클라이언트 (node.exe 동봉, 더블클릭 실행)
#   uag-monitor-<v>-macos-arm64.tar.gz  macOS(Apple Silicon) 클라이언트 (node 동봉)
#   uag-monitor-<v>-macos-x64.tar.gz    macOS(Intel) 클라이언트 (node 동봉)
#
# 사용:
#   build-clients.sh [--node-zip node-win.zip] [--node-tgz-arm64 <f>] [--node-tgz-x64 <f>] [--out DIR]
#   런타임 파일을 주지 않은 플랫폼의 클라이언트는 건너뛴다(서버 tar.gz 는 항상 생성).
#   런타임은 nodejs.org 공식 배포본 — CI(release.yml)가 SHASUMS256.txt 로 대조 후 넘겨준다.

set -euo pipefail

NODE_ZIP=""; NODE_TGZ_ARM64=""; NODE_TGZ_X64=""; OUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --node-zip) NODE_ZIP="$2"; shift 2 ;;
    --node-tgz-arm64) NODE_TGZ_ARM64="$2"; shift 2 ;;
    --node-tgz-x64) NODE_TGZ_X64="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-offline}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

# 공용 app 스테이지 — data/ 는 런타임 생성물이므로 제외.
stage_app() { # $1 = 대상 디렉터리
  mkdir -p "$1"
  (cd "$REPO_ROOT/uagmon" && tar --exclude='data' --exclude='.gitignore' -cf - server.js package.json lib public README.md) | tar -C "$1" -xf -
  # 배포본 버전은 레포 버전과 항상 일치시킨다(별도 bump 누락 방지).
  node -e "const f='$1/package.json',fs=require('fs');const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
}

echo "==> UAG Monitor v${VERSION} 패키지 빌드"

# 1) 서버(웹) 버전 -------------------------------------------------------------
SRV="$BUILD_DIR/uag-monitor-${VERSION}"
stage_app "$SRV/app"
cp "$SCRIPT_DIR/uag-monitor.service" "$SRV/"
cat > "$SRV/run-server.sh" <<'RUN'
#!/usr/bin/env bash
# UAG Monitor 서버(웹) 모드 실행 — 예:
#   ./run-server.sh --host 0.0.0.0 --port 8123        (최초 1회: --set-password <8자+>)
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js(>=20) 가 필요합니다."; exit 1; }
exec node app/server.js "$@"
RUN
chmod +x "$SRV/run-server.sh"
tar -czf "$OUT_DIR/uag-monitor-${VERSION}.tar.gz" -C "$BUILD_DIR" "uag-monitor-${VERSION}"
echo "    ✓ uag-monitor-${VERSION}.tar.gz (서버/웹)"

# 2) Windows 클라이언트 --------------------------------------------------------
if [[ -n "$NODE_ZIP" && -f "$NODE_ZIP" ]]; then
  command -v unzip >/dev/null && command -v zip >/dev/null || { echo "zip/unzip 필요" >&2; exit 1; }
  WIN="$BUILD_DIR/uag-monitor-${VERSION}-win-x64"
  stage_app "$WIN/app"
  mkdir -p "$WIN/runtime" "$BUILD_DIR/nodewin"
  unzip -q "$NODE_ZIP" -d "$BUILD_DIR/nodewin"
  NODE_EXE="$(find "$BUILD_DIR/nodewin" -name node.exe | head -1)"
  [[ -n "$NODE_EXE" ]] || { echo "node.exe 추출 실패" >&2; exit 1; }
  cp "$NODE_EXE" "$WIN/runtime/node.exe"   # npm 등 없이 node.exe 만 — 실행에 충분, 용량 최소
  # 배치 런처 — cmd 호환을 위해 CRLF 로 생성. 로컬(127.0.0.1) 전용 + 브라우저 자동 오픈.
  printf '@echo off\r\ncd /d "%%~dp0"\r\necho UAG Monitor v%s - http://127.0.0.1:8123 (이 창을 닫으면 종료됩니다)\r\nruntime\\node.exe app\\server.js --host 127.0.0.1 --port 8123 --open\r\npause\r\n' "$VERSION" > "$WIN/UAG-Monitor.bat"
  (cd "$BUILD_DIR" && zip -qr "$OUT_DIR/uag-monitor-${VERSION}-win-x64.zip" "uag-monitor-${VERSION}-win-x64")
  echo "    ✓ uag-monitor-${VERSION}-win-x64.zip"
else
  echo "    - Windows 클라이언트 건너뜀(--node-zip 미지정)"
fi

# 3) macOS 클라이언트 (arm64 / x64) ---------------------------------------------
build_mac() { # $1=arch $2=tgz
  local arch="$1" tgz="$2"
  [[ -n "$tgz" && -f "$tgz" ]] || { echo "    - macOS($arch) 건너뜀(런타임 미지정)"; return 0; }
  local MAC="$BUILD_DIR/uag-monitor-${VERSION}-macos-${arch}"
  stage_app "$MAC/app"
  mkdir -p "$MAC/runtime" "$BUILD_DIR/nodemac-$arch"
  tar -xzf "$tgz" -C "$BUILD_DIR/nodemac-$arch"
  local NODE_BIN
  NODE_BIN="$(find "$BUILD_DIR/nodemac-$arch" -path '*/bin/node' | head -1)"
  [[ -n "$NODE_BIN" ]] || { echo "macOS($arch) node 추출 실패" >&2; exit 1; }
  cp "$NODE_BIN" "$MAC/runtime/node"
  chmod +x "$MAC/runtime/node"
  cat > "$MAC/UAG Monitor.command" <<'CMD'
#!/bin/bash
# UAG Monitor — 더블클릭 실행(로컬 전용, 브라우저 자동 오픈). 창을 닫으면 종료됩니다.
cd "$(dirname "$0")"
# 브라우저로 받은 압축의 격리 속성 때문에 동봉 node 실행이 막히는 경우 정리(무해).
xattr -dr com.apple.quarantine . 2>/dev/null || true
exec ./runtime/node app/server.js --host 127.0.0.1 --port 8123 --open
CMD
  chmod +x "$MAC/UAG Monitor.command"
  tar -czf "$OUT_DIR/uag-monitor-${VERSION}-macos-${arch}.tar.gz" -C "$BUILD_DIR" "uag-monitor-${VERSION}-macos-${arch}"
  echo "    ✓ uag-monitor-${VERSION}-macos-${arch}.tar.gz"
}
build_mac arm64 "$NODE_TGZ_ARM64"
build_mac x64 "$NODE_TGZ_X64"

echo "==> 완료: $OUT_DIR"
