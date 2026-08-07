#!/usr/bin/env bash
#
# UAG Monitor 서버(웹) 패키지 빌드.
#
#   uag-monitor-<v>.tar.gz   서버(웹) 버전 — 대상 서버의 Node(>=20) 로 실행, 브라우저로 접속
#
# Windows/macOS 데스크톱 앱(자체 창, 브라우저 불필요)은 build-desktop.sh 가 만든다
# (uag-monitor-app-<v>-win-x64.zip / -macos-{arm64,x64}.tar.gz).
#
# 사용: build-clients.sh [--out DIR]

set -euo pipefail

OUT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

while [[ $# -gt 0 ]]; do
  case "$1" in
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

echo "==> UAG Monitor v${VERSION} 서버(웹) 패키지 빌드"

SRV="$BUILD_DIR/uag-monitor-${VERSION}"
mkdir -p "$SRV/app"
(cd "$REPO_ROOT/uagmon" && tar --exclude='data' --exclude='.gitignore' --exclude='desktop' -cf - server.js package.json lib public README.md) | tar -C "$SRV/app" -xf -
# 배포본 버전은 레포 버전과 항상 일치시킨다(별도 bump 누락 방지).
node -e "const f='$SRV/app/package.json',fs=require('fs');const p=JSON.parse(fs.readFileSync(f,'utf8'));p.version='${VERSION}';fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n')"
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
echo "==> 완료: $OUT_DIR"
