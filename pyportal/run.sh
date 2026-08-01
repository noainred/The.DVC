#!/usr/bin/env bash
# Global DC Service Hub 실행 래퍼.
#   ./run.sh            → 0.0.0.0:8095
#   ./run.sh 9000       → 포트 지정
#   HUB_TOKEN=xxx ./run.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

# 번들 Node 처럼 파이썬도 경로가 제각각이라 순서대로 찾는다.
PY=""
for candidate in python3.12 python3.11 python3.9 python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$(command -v "$candidate")"; break; fi
done
if [[ -z "$PY" ]]; then
  echo "ERROR: python3 을 찾을 수 없습니다. Rocky 9 기준: sudo dnf install -y python3" >&2
  exit 1
fi

if [[ $# -ge 1 ]]; then export HUB_PORT="$1"; fi

exec "$PY" app.py
