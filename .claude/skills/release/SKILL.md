---
name: release
description: 이 저장소의 릴리스 절차를 정확히 수행한다 — package.json 3종 버전업 + release-notes.json + (pyportal 변경 시) ver.txt 를 scripts/release.sh 로 준비하고, 검증·커밋·PR·태그/워크플로 게시까지 안내·수행. "릴리스", "release", "버전 올려", "배포" 요청에 사용.
---

# 릴리스 절차

이 프로젝트는 기능 작업이 끝나면 **GitHub 릴리스까지 게시**해야 원격/오프라인 자동 업그레이드가
동작한다(CLAUDE.md 사용자 강조 규칙). 아래 순서를 따른다.

## 1) 버전 파일 준비 (기계적 — 스크립트 사용)

```
scripts/release.sh <version> "<한줄 제목>" ["세부 노트"...]
# pyportal 을 변경한 릴리스면:
scripts/release.sh <version> "<제목>" --pyportal "<pyportal 한줄 요약>"
```
스크립트가 루트/서버/웹 `package.json` 3개의 version 을 semver 인상하고,
`server/src/release-notes.json` 의 `notes` 배열 맨 앞에 항목을 추가하며(최신 먼저),
`--pyportal` 지정 시 `pyportal/ver.txt` 맨 위에 `버전 (날짜) 요약` 을 추가한다.
버전이 현재보다 낮으면 거부한다(자동 업그레이드 정지 사고 방지).

## 2) 검증
`npm run verify`(서버 테스트 + 웹 lint + vitest + 빌드). 테스트가 `127.0.0.1` 을 바인딩하므로
샌드박스 환경이면 `/sandbox` 로 localhost 를 허용하거나 검증 명령만 샌드박스를 해제한다
(과거 `listen EPERM` 으로 verify 가 멈춘 사례).

## 3) 커밋·PR
- **자기 세션이 바꾼 파일만 선별 스테이징**한다(다중 창 동시작업 — 낯선 변경은 제외·보고).
- 개발 브랜치(`claude/vmware-global-monitoring-portal-nrnpnt`)에 커밋·push → PR 생성/갱신 → main 머지.

## 4) 릴리스 게시 (필수 — 외부 게시, 직접 확인 후)
- 권장: main 에 `v<버전>` 태그 push → CI 가 main 기준으로 빌드·게시.
- 태그 push 가 막히면: release.yml 을 **main 기준 workflow_dispatch** 로 실행
  (버전은 태그명이 아니라 package.json 에서 읽으므로 동일 동작).

## 5) 확인
`versions.json` 의 `latest` 가 새 버전으로 바뀌는지 확인:
`https://github.com/noainred/The.DVC/releases/download/downloads/versions.json`
⚠ 롤링 `downloads` 릴리스는 자산 1000개 상한 — CI 가 최근 15버전만 유지(prune-assets.mjs).
실패 시 CI 로그에서 `file_count limited to 1000` 여부를 먼저 확인.

## 완료 보고
게시·CI 성공까지 확인하고, GitHub 다운로드 링크(브랜치 ZIP·main ZIP)와 PR 링크를 함께 안내한다.
