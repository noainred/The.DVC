# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- 빌드 검증: `npm run verify` (= `npm test` 단위테스트 + `npm run build` 웹빌드). 서버 실행은 `node server/src/index.js`
  - 단위 테스트는 `server/test/*.test.js`(node:test). 핵심 로직 변경 시 테스트를 추가/갱신하고 커밋 전 `npm test` 통과 확인.
- 오프라인 패키지: `packaging/offline/build-package.sh` (Rocky Linux 9)

## 운영 환경 (성능 설계 시 반드시 고려)

- vCenter: **현재 약 28개 vCenter(~653 호스트·~5,800 VM), 향후 30+까지 확장 예정**. 글로벌 분산.
- 사용자(포탈)는 **한국**에 위치. 일부 vCenter(예: **폴란드, 미국 동부**)는 **RTT 800ms 초과**.
- 고지연·다수 vCenter 환경이므로:
  - **매 폴링 주기마다 이벤트 루프를 블로킹하는 동기 작업 금지**(예: 대량 SQLite write는 반드시 트랜잭션으로 묶기). 과거 IPAM 동기화가 무트랜잭션으로 6천 행 25초 블로킹 → 전체 UI 지연 발생, 트랜잭션으로 해결.
  - vCenter 수집은 **병렬 + per-vCenter 타임아웃**. 느린 1개가 전체 폴링을 막지 않게 한다.
  - 30개 vCenter·고RTT 확장을 가정해 수집/직렬화/DB write를 O(N)·논블로킹으로 유지.
- 적용된 성능 메커니즘(회귀 방지 — 유지할 것):
  - **수집 동시성 제한**(`store.collectPool`, `COLLECT_CONCURRENCY` 기본 8): 28개를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU 순간 100%. 동시 개수를 제한해 평탄화.
  - **폴러 재진입 가드**: `setInterval(()=>asyncFn())` 폴러는 이전 주기가 간격을 넘기면 중첩 실행돼 CPU 누적 악화. store.refresh/idrac.pollOnce/metrics.sampleOnce/nsx.refresh/gpu.pollOnce/collector.pullNow는 진행 중이면 이번 틱을 건너뛴다(새 폴러 추가 시 동일 가드 필수). 같은 작업의 수동 실행 API도 가드를 공유할 것(net/monitor.runMonitorNow 패턴).
  - **롤업 O(N)**(`withRollups`): 호스트/VM/DS/알람을 vCenter별 1회 그룹핑 후 조회(`pick`). 그룹마다 전체 재순회(O(N×vCenter)) 금지.
  - **시계열 prune 스로틀 + ts 인덱스**: 매 샘플 DELETE 스캔 금지 — N틱마다 1회(store 10틱·metrics 20틱·idrac.poller 10틱). `DELETE WHERE ts<?`는 `ts` 단독 인덱스가 있어야 풀스캔을 피한다(복합 `(server_id,ts)`로는 못 탐).
  - **ETag/304**(`util/compress.js`): res.json 래퍼가 본문 SHA-1로 약한 ETag를 발급하고 If-None-Match 일치 시 304(본문 0바이트). 이 래퍼는 res.end로 직접 종료해 Express 기본 ETag가 동작하지 않으므로, 응답 경로 수정 시 ETag 발급을 없애면 프론트 `pollFetch`의 304 지원이 통째로 죽는다(과거 실제 그 상태였음 — 15초 폴 × 30초 스냅샷이면 절반이 무변동 재전송).
  - **SQLite PRAGMA**: idrac/metrics/logs DB는 `WAL + synchronous=NORMAL + busy_timeout=3000`(단건 insert 5ms→0.01ms 실측). **ipam.db만 예외** — 외부 프로그램이 직접 읽는 공유 파일이라 저널 기본(DELETE) 유지 + busy_timeout만. WAL 전환 금지(외부 리더의 -wal/-shm 호환 미확인).
  - **전력 latest 인메모리 캐시**(`idrac/db.js withLatestCache`): latestAll(GROUP BY MAX)은 테이블 풀스캔이라(90일 수렴 시 수억 행) 매 30초 3회 호출이 초 단위 블로킹이었음. 기동 시 1회 시드 후 쓰기 경로에서 O(1) 갱신 — **getDb() 래퍼를 우회한 직접 쓰기 금지**(캐시가 낡음). 전력 대시보드 24h 집계는 60초 캐시(`idrac/service.js aggCache`).
  - **대량 export 청크 패턴**(`routes/api.js gpuSeriesExport`): 대량 시계열 조회는 5만 행 ts 윈도우 청크 + 청크 사이 `setImmediate` 양보 + 행 상한(`GPU_EXPORT_MAX_ROWS` 기본 30만). 1M행 동기 dump는 이벤트 루프 ~10초 정지 실측 — 새 export 추가 시 동일 패턴 필수.
  - **웹 폴링 뷰 오류 처리**: 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 ErrorBox로 갈아치우지 않는다 — `if (error && !data)`일 때만 전체 오류, 그 외엔 배너(고RTT에서 대시보드 깜빡임 방지). 스코프(파라미터) 변경 시 usePolling이 직전 데이터를 비워 이전 스코프 데이터 표시를 막는다.
  - 미해결 후속: node worker_threads로 동기 SQLite 쓰기/SOAP 파싱 오프로딩, 전력 대시보드 시간당 롤업 테이블(캐시 미스 첫 요청의 윈도우 스캔 제거), 위임 잡 인출 2단계 확인응답(claim→ack), 업그레이드 적용 중 라이브 SQLite cpSync 정합성.

## 사용자 선호 (반드시 준수)

- **항상 한글로 응답**: 모든 답변/설명 메시지는 한국어로 작성한다.
- **작업 시작 시 난이도 표시**: 모든 작업을 시작할 때 응답 맨 앞에 난이도와 권장 모델을
  한 줄로 표시한다. 형식: `난이도: 낮음/보통/높음 — Sonnet 적합 | Opus 권장`.
  (단순 편집·UI·엔드포인트=낮음/보통→Sonnet, 아키텍처·동시성·대규모 리팩터·미해결 버그=높음→Opus)
- **새 작업 요청 시 진행상태 표 표시**: 새로운 작업 요청을 받으면 응답 맨 앞(난이도 다음)에
  "작업 현황" 표를 보여준다. 열: `작업 | 상태 | 비고`. 상태는 `✅ 완료 / 🔄 진행중 / ⏳ 대기`.
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리해 진행여부를 보인다.
- **`.` 입력 시 작업 현황 표 응답**: 사용자가 `.` 하나만 입력하면(상태 확인 핑),
  현재 **작업중(🔄 진행중)** 인 작업과 **대기중(⏳ 대기)** 인 작업을 "작업 현황" 표
  (`작업 | 상태 | 비고`)로 정리해 보여준다. 릴리스 폴링 등 백그라운드 확인도 표에 포함하고,
  진행/대기 항목이 전혀 없으면 "모두 완료" 상태와 최근 완료 릴리스 버전을 간단히 알린다.
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
  - ⚠️ **자산 1000개 상한**: 롤링 `downloads` 릴리스는 GitHub 상한(릴리스당 1000 자산)에 걸리면
    업로드가 422로 전부 실패한다(자동 업그레이드 정지). release.yml이 업로드 직전
    `prune-assets.mjs`로 **최근 15개 버전만 유지**(`VERSIONS_KEEP`)하고 `versions.json`도 트리밍한다.
    릴리스가 실패하면 CI 로그에서 `file_count limited to 1000` 여부를 먼저 확인할 것.
  - 릴리스 폴링 확인: `versions.json` 의 `latest` 가 새 버전으로 바뀌는지 확인
    (`https://github.com/noainred/The.DVC/releases/download/downloads/versions.json`).
