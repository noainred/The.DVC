#!/usr/bin/env bash
#
# release.sh — 릴리스의 '기계적이고 되돌리기 쉬운' 준비 단계만 자동화한다.
#
# 왜 이 범위인가(정직한 설계): 태그 push·PR 머지·워크플로 실행 같은 '외부로 나가고
# 되돌리기 어려운' 단계는 스크립트로 자동화하지 않는다(CLAUDE.md 원칙 — 커밋/푸시는
# 사용자가 명시할 때만). 이 스크립트는 로컬 파일 3종만 정확히 고치고, 나머지 게시
# 절차는 화면에 '체크리스트'로 안내한다. 그래서 실수로 잘못된 릴리스가 원격에 나가지 않는다.
#
# 하는 일:
#   1) 루트/서버/웹 package.json 의 version 을 <version> 으로 동시 인상(jq, 원자적 교체)
#   2) server/src/release-notes.json 의 notes 배열 맨 앞에 새 항목 추가(최신 먼저 규약 유지)
#   3) (--pyportal "<요약>" 지정 시) pyportal/ver.txt 맨 위에 '버전 (날짜) 요약' 한 줄 추가
#   4) 남은 수동 게시 절차(verify→커밋→PR→머지→태그/워크플로)를 안내
#
# 사용:
#   scripts/release.sh <version> "<한줄 제목>" ["세부 노트1" "세부 노트2" ...]
#   scripts/release.sh 2.333.0 "스토리지 — 수집 작업 로그 패널" "진행중/완료 2구획" "5초 폴링"
#   scripts/release.sh 2.333.0 "허브 CSRF 강화" --pyportal "상태변경 커스텀 헤더 필수화"
#
set -euo pipefail

# 저장소 루트에서 실행되도록 고정(어디서 호출해도 동일 동작).
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$ROOT" ]] || { echo "git 저장소 안에서 실행하세요." >&2; exit 1; }
cd "$ROOT"
command -v jq >/dev/null || { echo "jq 가 필요합니다(brew install jq)." >&2; exit 1; }

VER="${1:-}"; TITLE="${2:-}"
[[ -n "$VER" && -n "$TITLE" ]] || { grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
shift 2 || true

# --pyportal "<요약>" 파싱 + 나머지는 release-notes 세부 항목(bullet)으로 수집.
PYPORTAL_SUMMARY=""
BULLETS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --pyportal) PYPORTAL_SUMMARY="${2:-}"; shift 2 ;;
    *) BULLETS+=("$1"); shift ;;
  esac
done

# semver 형식 + '현재보다 높은가' 검증(오타로 낮은 버전을 올려 자동 업그레이드가 멈추는 사고 방지).
[[ "$VER" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "버전은 semver(x.y.z) 여야 합니다: '$VER'" >&2; exit 1; }
CUR="$(jq -r .version package.json)"
if [[ "$(printf '%s\n%s\n' "$CUR" "$VER" | sort -V | tail -1)" != "$VER" || "$CUR" == "$VER" ]]; then
  echo "새 버전($VER)은 현재($CUR)보다 높아야 합니다." >&2; exit 1
fi

DATE="$(date +%Y-%m-%d)"   # 사용자 머신의 실제 날짜(스크립트에서 하드코딩 금지 — 정직한 타임스탬프).

# 세부 노트가 없으면 제목 한 줄을 노트로(빈 배열이면 릴리스노트가 비어 보임).
if [[ ${#BULLETS[@]} -eq 0 ]]; then
  NOTES_JSON="$(jq -n --arg t "$TITLE" '[$t]')"
else
  NOTES_JSON="$(printf '%s\n' "${BULLETS[@]}" | jq -R . | jq -s .)"
fi

echo "==> package.json 3종 버전 인상: $CUR -> $VER"
for f in package.json server/package.json web/package.json; do
  jq --arg v "$VER" '.version=$v' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done

echo "==> release-notes.json 항목 추가(최신 먼저)"
RN="server/src/release-notes.json"
jq --arg v "$VER" --arg d "$DATE" --arg t "$TITLE" --argjson n "$NOTES_JSON" \
  '.notes |= ([{version:$v, date:$d, title:$t, notes:$n}] + .)' "$RN" > "$RN.tmp" && mv "$RN.tmp" "$RN"

if [[ -n "$PYPORTAL_SUMMARY" ]]; then
  echo "==> pyportal/ver.txt 항목 추가(단독 배포 버전 표시의 진실의 원천)"
  printf '%s (%s) %s\n' "$VER" "$DATE" "$PYPORTAL_SUMMARY" | cat - pyportal/ver.txt > pyportal/ver.txt.tmp \
    && mv pyportal/ver.txt.tmp pyportal/ver.txt
fi

cat <<EOF

✅ 버전 파일 준비 완료: v$VER ($DATE)
   - package.json ×3, server/src/release-notes.json${PYPORTAL_SUMMARY:+, pyportal/ver.txt}

── 남은 게시 절차(수동 — 외부로 나가는 단계는 직접 확인 후) ─────────────────
 1) 검증:   npm run verify        (테스트가 127.0.0.1 을 열므로 샌드박스면 /sandbox 로 localhost 허용)
 2) 커밋:   git add -A && git commit -m "…(v$VER)"      # 자기 세션 변경만 선별 스테이징
 3) PR:     개발 브랜치 push → PR 생성/갱신 → main 머지
 4) 릴리스: main 에 'v$VER' 태그 push  (막히면 release.yml 을 ref=main 으로 workflow_dispatch)
 5) 확인:   versions.json 의 latest 가 $VER 로 바뀌는지
            https://github.com/noainred/The.DVC/releases/download/downloads/versions.json
 ⚠ 롤링 릴리스 자산 1000개 상한 — CI(prune-assets.mjs)가 최근 15버전만 유지. 실패 시 CI 로그의
   'file_count limited to 1000' 먼저 확인.
EOF
