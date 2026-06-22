# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- 빌드 검증: `npm run build` (웹), 서버는 `node server/src/index.js`
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
- **작업 완료 시 업데이트 버전을 GitHub에 게시**: 기능 작업이 끝나면
  `package.json` 버전을 올리고(semver), `packaging/offline/build-package.sh`로
  설치 패키지와 업그레이드 번들을 빌드해 `download/` 에 갱신 커밋한다
  (`versions.json` 의 `latest` 도 갱신). 그래야 원격/오프라인 업그레이드가 가능하다.
  - 설치 패키지: `download/vmware-portal-offline-<버전>-el9-x64.tar.gz`
  - 업그레이드 번들: `download/vmware-portal-<버전>.tar.gz`
  - 다운로드(raw): `https://github.com/noainred/The.DVC/raw/<branch>/download/<파일>`
