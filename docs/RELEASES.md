# 릴리스/다운로드 — GitHub Releases 이전 가이드

기존에는 설치/업그레이드 바이너리를 git의 `download/`에 커밋했다. 이 때문에 `.git`이
릴리스마다 ~190MB씩 커져 29GB까지 부풀었고, 오프라인 패키지 빌드가 디스크 부족으로
실패하기 시작했다. 이를 **GitHub Releases(롤링 `downloads` 태그)** 로 옮긴다.

## 구조

- 빌드는 **GitHub Actions**(`.github/workflows/release.yml`)가 수행한다(로컬/컨테이너 디스크 무관).
- 트리거: **`v*` 태그 push** 또는 수동 실행(workflow_dispatch — 워크플로가 기본 브랜치에 올라간 뒤 사용 가능).
- 산출물(el9/cent9 설치 패키지, Windows 수집기, 업그레이드 번들)과 `versions.json`을
  단일 **롤링 릴리스 `downloads`** 에 자산으로 업로드(`--clobber`)한다.
- 따라서 다운로드 base URL은 버전과 무관하게 고정:
  ```
  https://github.com/noainred/The.DVC/releases/download/downloads
  ```
  포탈 자동 업그레이드는 `${base}/versions.json`, `${base}/<파일>` 을 그대로 가리킨다(코드 무변경).

## 새 릴리스 내는 법

```bash
# 1) package.json 3곳 버전 올리고 release-notes.json 갱신, 소스 커밋/푸시
# 2) 태그를 만들어 push → Actions가 빌드+업로드
git tag v2.18.0
git push origin v2.18.0
```

`versions.json`은 워크플로가 이전 자산을 받아 새 버전 항목을 prepend하고 latest를 갱신한다
(`packaging/release/update-versions.mjs`). 즉 버전 히스토리는 릴리스 자산 안에서 유지된다.

## 컷오버(이전 절차)

1. 워크플로/스크립트 커밋·push (이 커밋).
2. **태그 push로 첫 CI 빌드** → `downloads` 릴리스가 채워지는지 확인.
3. 확인되면 포탈 기본 base URL을 위 Releases 경로로 전환(`server/src/config.js` `packages.baseUrl`).
4. `git rm --cached download/*.tar.gz download/*.zip download/*.sha256` 로 추적 해제(작업트리 파일은
   `.gitignore` 처리됨). 신규 설치 가이드의 링크도 Releases로 갱신.
5. (선택, 파괴적) 이미 쌓인 29GB를 회수하려면 `git filter-repo --path download/ --invert-paths`
   로 히스토리에서 바이너리를 제거 후 force-push. 백업 필수, 기존 clone/PR 참조가 깨진다.

## 폐쇄망/오프라인 사이트

`PACKAGE_BASE_URL`(또는 설정 › 수집 서버의 패키지 base) 를 사내 미러로 덮어쓰면 된다.
미러에는 Releases 자산과 동일한 파일 + `versions.json`을 평면으로 두면 동작한다.
