#!/usr/bin/env bash
#
# UAG Monitor 데스크톱 앱 빌드 (Electron) — 브라우저가 아닌 자체 창을 가진 진짜 클라이언트.
#
#   uag-monitor-app-<v>-win-x64.zip         Windows: 풀어서 'UAG Monitor.exe' 실행
#   uag-monitor-app-<v>-macos-arm64.tar.gz  macOS(Apple Silicon): 'UAG Monitor.app'
#   uag-monitor-app-<v>-macos-x64.tar.gz    macOS(Intel): 'UAG Monitor.app'
#
# 동작: uagmon 서버+UI 를 앱 안에 동봉하고, Electron 메인이 127.0.0.1 임의 포트로
# 서버를 띄운 뒤 자체 창으로 연다(uagmon/desktop/main.js).
#
# 요구: 인터넷(레지스트리·Electron 배포본) — CI(release.yml)에서 실행한다.
# 서명 없음: macOS 는 첫 실행 시 우클릭→열기(또는 xattr -dr com.apple.quarantine),
# Windows 는 SmartScreen '추가 정보→실행'이 필요할 수 있다(README 명시).
#
# 사용: build-desktop.sh [--out DIR] [--platforms "win32-x64 darwin-arm64 darwin-x64"]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR=""
PLATFORMS="win32-x64 darwin-arm64 darwin-x64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) OUT_DIR="$2"; shift 2 ;;
    --platforms) PLATFORMS="$2"; shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

VERSION="$(node -p "require('$REPO_ROOT/package.json').version")"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/dist-offline}"
mkdir -p "$OUT_DIR"; OUT_DIR="$(cd "$OUT_DIR" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> UAG Monitor 데스크톱 앱 v${VERSION} 빌드 (${PLATFORMS})"

# 1) 앱 스테이지: desktop(메인) + app(서버·UI 소스)
STAGE="$WORK/stage"
mkdir -p "$STAGE/app"
cp "$REPO_ROOT/uagmon/desktop/main.js" "$STAGE/main.js"
cp "$REPO_ROOT/uagmon/desktop/package.json" "$STAGE/package.json"
(cd "$REPO_ROOT/uagmon" && tar --exclude='data' --exclude='.gitignore' --exclude='desktop' -cf - server.js package.json lib public README.md) | tar -C "$STAGE/app" -xf -
# 버전은 레포 버전으로 스탬프(별도 bump 누락 방지)
node -e "for (const f of ['$STAGE/package.json','$STAGE/app/package.json']) { const fs=require('fs'); const p=JSON.parse(fs.readFileSync(f,'utf8')); p.version='${VERSION}'; fs.writeFileSync(f, JSON.stringify(p,null,2)+'\n'); }"

# 2) Electron 정확 버전 확정 — 바이너리 postinstall 없이 메타만 설치해 버전을 읽는다.
#    (@electron/packager 는 배포 zip 을 스스로 내려받으므로 node_modules 바이너리가 필요 없다)
npm install --prefix "$STAGE" --no-package-lock --ignore-scripts --no-audit --no-fund "electron@^33.0.0" >/dev/null
EVER="$(node -p "require('$STAGE/node_modules/electron/package.json').version")"
echo "    Electron v${EVER}"

# 3) 플랫폼별 패키징 + 압축(맥 .app 은 심볼릭 링크 보존을 위해 tar.gz)
for pf in $PLATFORMS; do
  plat="${pf%-*}"; arch="${pf#*-}"
  npx --yes @electron/packager@18 "$STAGE" "UAG Monitor" \
    --platform="$plat" --arch="$arch" --electron-version "$EVER" \
    --out "$WORK/out" --overwrite --ignore '^/node_modules($|/)' >/dev/null
  SRC="$WORK/out/UAG Monitor-${plat}-${arch}"
  [[ -d "$SRC" ]] || { echo "패키징 실패: $SRC 없음" >&2; exit 1; }
  case "$plat" in
    win32)
      ( cd "$WORK/out" && zip -qryX "$OUT_DIR/uag-monitor-app-${VERSION}-win-x64.zip" "UAG Monitor-${plat}-${arch}" )
      echo "    ✓ uag-monitor-app-${VERSION}-win-x64.zip" ;;
    darwin)
      tar -czf "$OUT_DIR/uag-monitor-app-${VERSION}-macos-${arch}.tar.gz" -C "$WORK/out" "UAG Monitor-${plat}-${arch}"
      echo "    ✓ uag-monitor-app-${VERSION}-macos-${arch}.tar.gz" ;;
  esac
done

echo "==> 완료: $OUT_DIR"
