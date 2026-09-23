# 릴리스/다운로드 — GitHub Releases 가이드

기존에는 설치/업그레이드 바이너리를 git의 `download/`에 커밋했다. 이 때문에 `.git`이
릴리스마다 ~190MB씩 커져 29GB까지 부풀었고, 오프라인 패키지 빌드가 디스크 부족으로
실패하기 시작했다. 현재는 **GitHub Releases(롤링 `downloads` 태그)** 로 게시한다(이전 완료).

## 구조

- 빌드는 **GitHub Actions**(`.github/workflows/release.yml`)가 수행한다(로컬/컨테이너 디스크 무관).
- 트리거: **`v*` 태그 push** 또는 수동 실행(workflow_dispatch, `ref=main`).
- 릴리스와 별개로 **PR CI**(`.github/workflows/ci.yml`, `pull_request` · main `push`(문서만 바뀐 push 제외) ·
  수동 실행)가 다음을 돌린다 — **릴리스 태그를 밀기 전에 PR CI 통과를 먼저 확인**한다.
  - 서버 단위테스트(node:test) · 웹 eslint(훅 규칙 게이트) · 웹 vitest · 웹 빌드(vite)
  - 생성 문서 최신 여부 `--check` — `docs/ENV.md`·`docs/CONFIG-FILES.md`·`docs/API.md`·`THIRD-PARTY-NOTICES.txt`
    (`continue-on-error` — 낡았어도 CI 를 실패시키지 않고 로그에 드러낸다)
  - 의존성 취약점 `npm audit --omit=dev` — server·web 모두 **critical 이면 실패**(high 이하는 정보 출력만)
  - 서비스 허브(pyportal) 파이썬 테스트 — PR 은 3.9, main push·수동 실행은 3.9 + 3.12. pyportal 을 바꾼 PR 은 `pyportal/ver.txt` 갱신을 검사한다
  - ⚠ PR 이 없는 브랜치 push 에는 CI 가 돌지 않는다 — 그때는 workflow_dispatch 로 수동 실행한다.
- 릴리스 워크플로도 빌드 전에 단위테스트를 한 번 더 돌린다. 태그 push 와 수동 실행이 겹쳐도 롤링 릴리스를 동시에
  고치지 않도록 `concurrency: release-downloads`(취소 없음)로 **직렬 실행**한다.
- 산출물(el9/cent9 설치 패키지, Windows 수집기, 업그레이드 번들)과 `versions.json`을
  단일 **롤링 릴리스 `downloads`** 에 자산으로 업로드(`--clobber`)한다.
- 따라서 다운로드 base URL은 버전과 무관하게 고정:
  ```
  https://github.com/noainred/The.DVC/releases/download/downloads
  ```
  포탈 자동 업그레이드는 `${base}/versions.json`, `${base}/<파일>` 을 그대로 가리킨다(코드 무변경).

## 새 릴리스 내는 법

```bash
# 1) package.json 3곳(루트/server/web) 버전 올리고 server/src/release-notes.json 갱신, 소스 커밋/푸시
# 2) PR을 main에 머지하고 CI 통과 확인
# 3) main 기준 태그를 만들어 push → Actions가 빌드+업로드
git tag v<버전> origin/main     # 예: v2.336.0 (버전별 변경 내역은 server/src/release-notes.json 및 포탈 내 릴리스 노트 화면 참조)
git push origin v<버전>
# 4) 게시 확인: versions.json의 latest가 새 버전인지
curl -sL https://github.com/noainred/The.DVC/releases/download/downloads/versions.json | head -5
```

`versions.json`은 워크플로가 이전 자산을 받아 새 버전 항목을 prepend하고 latest를 갱신한다
(`packaging/release/update-versions.mjs`). 즉 버전 히스토리는 릴리스 자산 안에서 유지된다.

### 업로드 순서와 재시도 (v2.502 · v2.551)

GitHub 업로드 엔드포인트는 간헐적으로 HTTP 500 을 준다(2026-09-13 v2.502.0 · 2026-09-17 v2.550.3 실제 사고 —
둘 다 재실행으로 해소됐다). 한 파일의 일시 오류가 나머지 업로드를 취소시키지 않도록 워크플로가 이렇게 올린다.

1. **패키지를 먼저, 파일 단위로** 올린다 — 파일마다 최대 **4회** 재시도(실패하면 그 자산을 지우고 시도마다 10초씩 늘려 대기).
2. 패키지가 하나라도 끝내 실패하면 **`versions.json` 을 갱신하지 않고 중단**한다(없는 파일을 가리키지 않게) — 로그에
   `::error::패키지 업로드 실패` 가 남는다.
3. 패키지가 모두 올라간 뒤에 `versions.json` 을 **최대 5회** 재시도로 올린다(시도마다 15초씩 늘려 대기). 여기서 실패하면
   패키지는 올라갔지만 자동 업그레이드는 이전 버전에 머문다 — 워크플로가 실패로 끝나므로 재실행한다.
4. 업로드 단계를 새로 만들면 **모든 자산에** 같은 재시도를 붙인다(v2.502 는 versions.json 에만 붙여 v2.550.3 이 실패했다).

### ⚠️ 자산 1000개 상한 & 자동 prune (필수)

GitHub는 **릴리스 1개당 자산 1000개** 상한이 있다. 롤링 `downloads` 릴리스는 버전마다
설치/오프라인/윈도우/업그레이드 번들 + `.sha256`(버전당 ~8개)이 쌓이므로, 방치하면
~125버전에서 상한에 도달해 업로드가 `HTTP 422 (file_count limited to 1000 assets)` 로
**전부 실패**한다(= `versions.json` 갱신 중단 → 자동 업그레이드 정지). 이를 막기 위해:

- 워크플로가 업로드 **직전** `packaging/release/prune-assets.mjs` 로 오래된 버전 자산을 지워
  **최근 N개 버전만 유지**한다(기본 `VERSIONS_KEEP=15`). `versions.json` 항목도 동일하게 최근 15개로 트리밍.
- 자동 업그레이드는 `latest`만 있으면 되므로 오래된 버전 자산 삭제는 안전하다.
- 최초 정리 실행은 삭제 대상이 많아(수백 개) prune 단계가 수 분 걸릴 수 있으나 **일회성**이며,
  이후에는 한두 개만 정리해 빠르다.

## 컷오버(이전 절차) — ✅ 완료된 이력

아래 1~4단계는 **이미 완료**됐다(포탈 기본 base URL이 Releases 경로, `download/`는 `.gitignore`).
이력 참고용으로만 남긴다.

1. 워크플로/스크립트 커밋·push.
2. **태그 push로 첫 CI 빌드** → `downloads` 릴리스가 채워지는지 확인.
3. 포탈 기본 base URL을 Releases 경로로 전환(`server/src/config.js` `packages.baseUrl`). — 완료
4. `git rm --cached download/*` 로 추적 해제 + `.gitignore` 처리. — 완료
5. (선택, 파괴적·미실행) 이미 쌓인 29GB를 회수하려면 `git filter-repo --path download/ --invert-paths`
   로 히스토리에서 바이너리를 제거 후 force-push. 백업 필수, 기존 clone/PR 참조가 깨진다.

## 폐쇄망/오프라인 사이트

`PACKAGE_BASE_URL`(또는 설정 › 수집 서버의 패키지 base) 를 사내 미러로 덮어쓰면 된다.
미러에는 Releases 자산과 동일한 파일 + `versions.json`을 평면으로 두면 동작한다.
자동 업그레이드가 `versions.json` 을 감시하는 원격 소스는 별도 키 `UPGRADE_REMOTE_BASE` 다(`server/src/config.js`) —
`EDGE_MODE=all` 엣지는 지정하지 않으면 중앙 포탈의 `/dl`(중앙의 패키지 디렉터리를 공개 제공 — `server/src/routes/dlsource.js`)을 소스로 쓴다.
