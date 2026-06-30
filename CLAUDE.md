# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- 빌드 검증: `npm run verify` (= `npm test` 단위테스트 + `npm run build` 웹빌드). 서버 실행은 `node server/src/index.js`
  - 단위 테스트는 `server/test/*.test.js`(node:test). 핵심 로직 변경 시 테스트를 추가/갱신하고 커밋 전 `npm test` 통과 확인.
- 오프라인 패키지: `packaging/offline/build-package.sh` (Rocky Linux 9)

## 운영 환경 (성능 설계 시 반드시 고려)

- vCenter: **현재 13개 DC/13개 vCenter, 향후 30개까지 확장 예정**. 글로벌 분산.
- 사용자(포탈)는 **한국**에 위치. 일부 vCenter(예: **폴란드, 미국 동부**)는 **RTT 800ms 초과**.
- 고지연·다수 vCenter 환경이므로:
  - **매 폴링 주기마다 이벤트 루프를 블로킹하는 동기 작업 금지**(예: 대량 SQLite write는 반드시 트랜잭션으로 묶기). 과거 IPAM 동기화가 무트랜잭션으로 6천 행 25초 블로킹 → 전체 UI 지연 발생, 트랜잭션으로 해결.
  - vCenter 수집은 **병렬 + per-vCenter 타임아웃**. 느린 1개가 전체 폴링을 막지 않게 한다.
  - 30개 vCenter·고RTT 확장을 가정해 수집/직렬화/DB write를 O(N)·논블로킹으로 유지.

## 사용자 선호 (반드시 준수)

- **항상 한글로 응답**: 모든 답변/설명 메시지는 한국어로 작성한다.
- **작업 시작 시 난이도 표시**: 모든 작업을 시작할 때 응답 맨 앞에 난이도와 권장 모델을
  한 줄로 표시한다. 형식: `난이도: 낮음/보통/높음 — Sonnet 적합 | Opus 권장`.
  (단순 편집·UI·엔드포인트=낮음/보통→Sonnet, 아키텍처·동시성·대규모 리팩터·미해결 버그=높음→Opus)
- **새 작업 요청 시 진행상태 표 표시**: 새로운 작업 요청을 받으면 응답 맨 앞(난이도 다음)에
  "작업 현황" 표를 보여준다. 열: `작업 | 상태 | 비고`. 상태는 `✅ 완료 / 🔄 진행중 / ⏳ 대기`.
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리해 진행여부를 보인다.
- **PR 자동 진행**: 작업 완료 시 별도 요청 없이 PR을 생성/갱신한다.
- **PR 완료 시 GitHub 다운로드 링크 자동 안내**: 모든 PR 작업(푸시/머지 등)이 끝나면,
  요청을 기다리지 말고 자동으로 GitHub 다운로드 링크를 함께 알려준다.
  - 브랜치 소스 ZIP:
    `https://github.com/noainred/The.DVC/archive/refs/heads/<branch>.zip`
  - 머지된 경우 main 기준 ZIP:
    `https://github.com/noainred/The.DVC/archive/refs/heads/main.zip`
  - 해당 PR 링크도 함께 제공한다.
- **작업 완료 시 자동 업그레이드가 되도록 반드시 릴리스를 게시**(★사용자 강조): 기능 작업이
  끝나면 버전업·커밋·PR 로 끝내지 말고, **운영 포탈이 원격으로 새 버전을 받을 수 있게
  GitHub 릴리스까지 게시**한다. 바이너리는 git에 커밋하지 않고 GitHub Actions(`.github/
  workflows/release.yml`)가 롤링 `downloads` 릴리스에 게시한다. 절차:
  1. `package.json`(루트/서버/웹 3개) 버전 semver 인상 + `server/src/release-notes.json` 추가.
  2. 변경을 개발 브랜치에 커밋·push 하고 PR 생성/갱신.
  3. **릴리스 게시(필수)**: PR 을 main 에 머지한 뒤, release 워크플로를 돌린다.
     - 권장: main 에 `v<버전>` 태그 push → CI 가 main(=새 버전) 기준으로 빌드·게시.
     - 태그 push 가 프록시 등으로 막히면 대안: release 워크플로를 **main 기준 workflow_dispatch**
       로 수동 실행(`actions_run_trigger run_workflow release.yml ref=main`). 버전은 태그명이
       아니라 `package.json` 에서 읽으므로 동일하게 동작한다.
  4. CI 가 `versions.json` 의 `latest` 를 새 버전으로 갱신하고 설치 패키지·업그레이드 번들을
     `downloads` 릴리스 자산으로 올린다 → 그래야 원격/오프라인 **자동 업그레이드가 작동**한다.
  - 릴리스 자산 베이스: `https://github.com/noainred/The.DVC/releases/download/downloads`
  - 게시 누락 = 자동 업그레이드 정지의 직접 원인이므로, 기능 PR 머지 후 릴리스 게시·CI 성공까지
    확인하고 사용자에게 보고한다.
