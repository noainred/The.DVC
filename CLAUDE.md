# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- 빌드 검증: `npm run verify` (= `npm test` 단위테스트 + `npm run build` 웹빌드). 서버 실행은 `node server/src/index.js`
  - 단위 테스트는 `server/test/*.test.js`(node:test). 핵심 로직 변경 시 테스트를 추가/갱신하고 커밋 전 `npm test` 통과 확인.
- 오프라인 패키지: `packaging/offline/build-package.sh` (Rocky Linux 9)
- 의존성: CI(`ci.yml`)의 `npm audit` 는 **critical 만 차단**(v2.478)이고 **`--omit=dev` 기준**이다. 잔여 수용 항목 — 웹 high `d3-color`(3d-force-graph·react-simple-maps·recharts 경유. v2.500 에서 색 문자열이 **전부 프론트 상수**임을 재확인했다: `Topology3D` COLOR 맵·`WorldMap` 상수·`sInfo.color` 계열, 서버 응답에 color 필드 없음 → 외부 입력 도달 불가. override 강제는 지도·차트 회귀 위험이 실익보다 크다), 서버 moderate `exceljs→uuid`(exceljs 는 `uuid.v4` 만 사용 — CVE 는 v3/v5/v6 의 `buf` 인자 경계검사). 개발·빌드 전용 잔여는 v2.500 의 비파괴 `npm audit fix` 로 11→6 건이 됐고, 남은 critical 은 **dev 전용 `vitest`**(Vitest UI 서버가 열려 있을 때만 성립 — `@vitest/ui` 미설치·`--ui` 미사용. 수정본은 4.1.11+ 로 2.1.9 에서 두 메이저 점프라 미적용). 새 critical 이 뜨면 PR 이 막히니 `npm audit --omit=dev` 로 먼저 확인.
- 작업 방식 메모(2026-09-11 실제 사고): 백그라운드 분석 에이전트 6개가 **10시간 동안 완료 알림 없이** 멈춘 적이 있다. 30분 내 알림이 없으면 죽은 것으로 보고 **직접 grep→파일 열기→판정** 방식으로 전환할 것(대기하지 말 것).
- 소스 NUL 바이트 탐지는 `tr -cd '\000' < 파일 | wc -c` 로(`grep -cP '\x00'` 은 0 을 돌려주는 오탐 — v2.478 문서 오판의 원인). `file` 이 JS 를 'data' 로 분류하면 의심할 것. 분석 에이전트는 `model` 을 지정하지 말고 기본 모델로, 결과를 scratchpad 파일에도 쓰게 하면 12분 안에 돌아온다(2026-09-11 2차 감사 실측).

## 운영 환경 (성능 설계 시 반드시 고려)

- vCenter: **현재 28개 vCenter(~658 호스트·~5,850 VM), 향후 30+까지 확장 예정**. 글로벌 분산.
- 사용자(포탈)는 **한국**에 위치. 일부 vCenter(예: **폴란드, 미국 동부**)는 **RTT 800ms 초과**.
- 고지연·다수 vCenter 환경이므로:
  - **매 폴링 주기마다 이벤트 루프를 블로킹하는 동기 작업 금지**(예: 대량 SQLite write는 반드시 트랜잭션으로 묶기). 과거 IPAM 동기화가 무트랜잭션으로 6천 행 25초 블로킹 → 전체 UI 지연 발생, 트랜잭션으로 해결.
  - vCenter 수집은 **병렬 + per-vCenter 타임아웃**. 느린 1개가 전체 폴링을 막지 않게 한다.
  - 30개 vCenter·고RTT 확장을 가정해 수집/직렬화/DB write를 O(N)·논블로킹으로 유지.
- 적용된 성능 메커니즘(회귀 방지 — 유지할 것):
  - **수집 동시성 제한**(`store.collectPool`, `COLLECT_CONCURRENCY` 기본 8): 28개를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU 순간 100%. 동시 개수를 제한해 평탄화.
  - **폴러 재진입 가드**: `setInterval(()=>asyncFn())` 폴러는 이전 주기가 간격을 넘기면 중첩 실행돼 CPU 누적 악화. store.refresh/idrac.pollOnce/metrics.sampleOnce/nsx.refresh/gpu.pollOnce/collector.pullNow는 진행 중이면 이번 틱을 건너뛴다(새 폴러 추가 시 동일 가드 필수). 같은 작업의 수동 실행 API도 가드를 공유할 것(net/monitor.runMonitorNow 패턴).
  - **스토리지 폴러 주기는 중앙 배포값**(`storage/intervals.js`, v2.409): 수집/push/설정 pull 주기를
    모듈 로드 시 `const INTERVAL_MS = ...env...` 로 굳히지 말 것 — 그러면 중앙(설정 › 수집 서버 ›
    스토리지 수집 주기)에서 아무리 바꿔도 **엣지를 재시작해야** 먹어 기능이 통째로 죽는다.
    `runtimeIntervals()` 를 매 틱 조회하고 `startAdaptiveTimer` 로 재무장한다(setInterval 은 생성
    시 간격에 묶인다). 값 변경 시 `onIntervalsChange` 리스너가 **무장된 타이머를 즉시 재무장**하는
    것도 유지할 것(없으면 60분 주기에서 최대 1시간 뒤 적용). 재진입 가드는 그대로 둔다.
    배포 계약: **중앙이 지정한 키만** 내려간다 — 전 키를 채워 보내면 각 법인이 portal.env 로 잡아
    둔 현장 설정을 통째로 덮어쓴다. 하한(60초 / 영역수집 10분)은 서버가 강제하고, 빈 값·0 은
    하한으로 승격하지 않고 '미지정'으로 버린다(미입력이 최소주기로 둔갑하는 사고 방지).
  - **SAN 스위치 수집도 같은 규약**(`sanswitch/`, v2.410): 동시 수집 제한(`SANSW_CONCURRENCY`
    기본 4) + 장비당 타임아웃 + 재진입 가드 + `startAdaptiveTimer`. 포트 목록이 크므로
    (디렉터 최대 512~768포트) **중앙 push 는 문제 포트만 올린다**(`push.js slimSnapshot`) —
    정상 포트까지 매 주기 밀면 고RTT 회선에서 수 MB 가 반복 전송된다. 요약 수치(total/
    licensed/online/free)는 전체 기준을 유지하고 뺀 개수는 `portsOmitted` 로 표시할 것.
    포트 처리량은 누적 카운터 델타로 계산하므로(`rates.js`) **첫 수집은 null** 이고 카운터
    리셋(음수 델타)도 null 이다 — 0 으로 채우면 '트래픽 없음'으로 오해된다.
    push 는 **gzip + 청크**(`push.js chunkDevices`, 요청당 700KB — 중앙 express.json 1MB 한도 아래)이며
    청크 0 은 중앙 목록 교체·이후 청크는 upsert 병합(`central/sanSwitchEdge.js`) — 이 병합을 없애면
    중앙 목록이 마지막 청크만 남는다.
  - **장비당 타임아웃은 세션을 실제로 끊어야 한다**(v2.417, `proxy/sshExec.js withDeadline` + `withSsh`
    signal): `Promise.race` 로 결과만 포기하면 SSH 세션이 남은 명령을 끝까지 돌려(최대 ~8.5분) 동시성
    상한이 실효를 잃고 다음 주기가 같은 장비에 두 번째 세션을 연다. SAN·스토리지·perf 폴러 전부 이
    패턴이다 — 새 SSH 수집기를 추가하면 creds 에 `signal` 을 넘길 것. `exec()` 출력 상한(4MB)도 유지.
  - **SAN 조닝은 '보여 주는 것' 이지 '판정해 주는 것' 이 아니다**(`sanswitch/zoning.js`,
    `web/src/views/tools/sanZoningView.js`, v2.511 — 사용자 요청 "조닝 정보를 그림으로 예쁘게"·"둘 다"):
    - **역할(이니시에이터/타깃)의 근거를 반드시 구분해 표시한다.** 스위치 네임서버가 FC4 역할을
      알려주면 `confirmed`(●), 아니면 zone 그래프를 **BFS 2-색칠**해 나눈 `inferred`(◐)다. 이 구분을
      없애고 한 색으로 칠하면 추정을 사실로 말하게 된다. `classifyEndpoints` 의 **판정 순서**도 지킬 것 —
      `ns`(확정)를 `conflict`(홀수 사이클 → middle)보다 **먼저** 본다. 뒤집으면 다중 이니시에이터
      zone 이 전부 middle 로 덮여 그 결함을 영영 못 찾는다(테스트가 고정).
    - **`nsRoles` 가 없으면 '확정' 배지는 영원히 안 붙는다** — 초판이 실제로 그랬다(라우트가
      `nsRoles` 를 만들지 않아 confirmed 분기가 도달 불가). 수집은 `fosParse.parseNsRoles`(nsshow 의
      `Device type:`/`FC4s:`)와 `fosRest`(`fc4-features`/`name-server-device-type`)가 한다. ⚠ 실장비
      nsshow 출력은 확인하지 못했다(사용자 제공 캡처는 cfgshow 뿐) — **없으면 빈 객체**이고 그림은
      추정으로 떨어진다. 이 폴백을 '기본값 initiator' 따위로 바꾸지 말 것.
    - **`Initiator+Target`(VPLEX 같은 겸용)은 한쪽 열에 넣지 않는다** — 가운데 열이다. 같은 장비의
      FE/BE 는 **WWN 이 달라** 양쪽 열에 각각 나오는 것이 정상이다(오류로 보고 '고치지' 말 것).
    - **WWN 라벨은 뒤 4바이트만 쓰면 서로 다른 장비가 같은 이름으로 보인다** — 이 현장 Unity
      SPA0/SPB0 가 실제로 그랬다(`…00:00:00:a0` 두 줄. **스크린샷을 읽어야 잡힌다** — 수치로는
      안 잡혔다). `labelMap()` 이 충돌한 것만 앞으로 늘린다. 전부 늘리면 박스를 넘친다.
    - **폴링 금지** — 탭을 열 때 1회만 부른다(zone 수천 개 패브릭에서 분석이 O(zone×멤버²)).
      수집 자체는 스냅샷만 읽으므로 vCenter/스위치 왕복이 없다.
    - **상한으로 잘린 zone·별칭·노드·행·열은 개수를 밝힌다**(`limited`·`omitted`), 페이저
      (`--More--`)로 잘린 출력도 `truncated` 로 밝힌다(조용한 상한 금지).
    - **'로그인 안 함' 판정은 포트 목록이 온전할 때만**(`portsComplete`) — 엣지 위임 장비는 문제
      포트만 중앙에 올라온다(`push.js slimSnapshot`). 일부만 보고 단정하면 거짓이 된다.
    - ⚠ `zoning.zones` 는 v2.510 까지 **숫자(항상 0)** 였고 v2.511 에 **배열**이 됐다. 개수는
      `zoneCount`. 되돌리면 그림이 통째로 빈다.
    - **테스트 픽스처에 실제 운영 식별자를 넣지 말 것**(v2.513 — 이 저장소는 **공개**다):
      `test/fixtures/cfgshow-sample.txt` 는 v2.511 에 실장비 출력을 그대로 커밋했다가(호스트명·
      WWN·어레이 구성) 익명화했다. 파서는 **형식만** 검증하므로 실제 값은 이득이 0 이고 노출만
      남는다. 되돌리지 말 것. 단 익명화할 때 **두 성질은 보존**한다 — ① WWN 앞 OUI 접두
      (`WWN_HINTS` 가 벤더·방향 추정에 쓴다) ② Unity SPA0/SPB0 의 **뒤 4바이트 동일**
      (`labelMap()` 라벨 충돌의 유일한 재현 사례). 상세는 `test/sanZoning2511.test.js` 헤더.
      새 수집기 픽스처를 만들 때도 같은 규칙 — 실장비 캡처는 형식만 옮기고 값은 합성한다.
  - **장비 대량 등록(CSV·자유텍스트)은 판정·문구를 복제하지 말 것**(`util/bulkImport.js`·`util/bulkText.js`·
    `util/bulkAdvice.js`·`util/bulkRun.js` + 웹 `views/tools/BulkDeviceIo.jsx`·`bulkIoText.js`, v2.513 —
    사용자 요청 "csv와 free text import/export · sample download · 실제로 테스트해서 검증 ·
    통과한 일부만 등록 · 어떤 부분을 고치라고 조언"):
    - **코어는 하나다.** 스토리지(v2.313)가 먼저 가졌던 `storage/csv.js analyzeImport` 를 일반화해
      `util/bulkImport.js` 로 옮겼고 스토리지는 위임만 한다. SAN 스위치가 같은 기능을 요구받았을 때
      20줄을 복사했으면 두 판정이 갈라진다(이 저장소는 `console/`↔`version_3/` 중복으로 v2.506
      svcmon 버그를 두 곳에 고쳐야 했다). 웹도 모달 하나(`BulkDeviceIo`)를 두 화면이 쓴다.
    - **식별 키는 도구마다 다르다** — 스토리지 `host+type`, SAN 스위치 **`host` 단독**
      (`sanswitch/registry.js saveDevice` 가 host 중복을 거부한다). 틀리면 '드라이런 통과 →
      저장 예외' 가 되고 export→편집→import 왕복이 장비를 복제한다.
    - **'테스트 불가'(skipped)를 '실패'(fail)로 뭉치지 말 것.** 엣지 위임 장비는 중앙에서 닿을 수
      없어 **시도하지 않은** 것이다. 실패라 말하면 사용자가 멀쩡한 자격증명을 의심하며 고친다.
      화면 기본 선택에서도 skipped 를 빼지 않는다(등록해야 엣지가 수집한다) — 빼는 것은 fail 뿐.
      `passedLines()` 는 `ok` 만 돌려주므로 '연결 성공분만' 옵션은 skipped 도 제외한다 —
      그 사실을 화면이 **말한다**(`testOnlyNote`, 조용한 제외 금지).
    - **자동 재시도 금지**(`bulkRun.js`). 잘못된 비밀번호를 반복하면 어레이·스위치 계정이 잠긴다.
      같은 도구의 실행이 진행 중이면 새 실행을 거절한다(연타가 로그인 시도를 곱하지 않게).
      run 객체는 비밀번호를 들고 있으므로 TTL 15분 폐기 + `publicRun` 이 자격증명을 뺀다.
    - **`:` 는 `aliasOf` 가 해석될 때만 키 경계다**(`bulkText.js looksKeyed`). 아니면
      `https://10.30.0.14/` 의 `https:` 가 키로 읽혀 그 줄이 **경고 없이 사라진다**(초판의 실제
      결함 — 6행 입력이 5행으로 보고됐고 단위 테스트 25건이 전부 통과했다). WWN(`50:06:…`)·
      시각·`host:443` 도 같은 이유로 보호된다. 키로 읽어 아는 필드가 0개면 위치 해석으로
      폴백하고 **경고를 남긴다**.
    - **`enrichAdvice` 는 판정을 다시 하지 않는다** — `report` 를 장식만 한다(검증 단일 소스
      `deviceInputIssue` 를 건드리지 않기 위해). 필드로 환원되지 않는 문제(파일 내 중복)는
      `fieldOfIssue` 가 **null** 을 주고 전용 문구를 쓴다 — 엉뚱한 열을 지목하면 거짓 조언이다.
    - **조언 문구는 `BoldText` 로 렌더**(`**강조**` 가 별표로 샌다 — v2.439/2.440/2.505 실제 사고).
      조언은 문장이라 길다 — 셀에 `whiteSpace:'normal'` 이 없으면 오른쪽에서 잘린다(v2.513
      스크린샷 판독에서 실제로 잘려 있었다. 수치로는 안 잡혔다).
    - **요약 줄 접두('검증 결과:' / '등록 결과:')를 지우지 말 것** — 형태가 같아 한 화면에
      나란히 뜨면 사람이 구분하지 못한다(같은 판독에서 발견).
  - **롤업 O(N)**(`withRollups`): 호스트/VM/DS/알람을 vCenter별 1회 그룹핑 후 조회(`pick`). 그룹마다 전체 재순회(O(N×vCenter)) 금지.
  - **시계열 prune 스로틀 + ts 인덱스**: 매 샘플 DELETE 스캔 금지 — N틱마다 1회(store 10틱·metrics 20틱·idrac.poller 10틱). `DELETE WHERE ts<?`는 `ts` 단독 인덱스가 있어야 풀스캔을 피한다(복합 `(server_id,ts)`로는 못 탐).
  - **ETag/304**(`util/compress.js`): res.json 래퍼가 본문 SHA-1로 약한 ETag를 발급하고 If-None-Match 일치 시 304(본문 0바이트). 이 래퍼는 res.end로 직접 종료해 Express 기본 ETag가 동작하지 않으므로, 응답 경로 수정 시 ETag 발급을 없애면 프론트 `pollFetch`의 304 지원이 통째로 죽는다(과거 실제 그 상태였음 — 15초 폴 × 30초 스냅샷이면 절반이 무변동 재전송).
  - **SQLite PRAGMA**: idrac/metrics/logs DB는 `WAL + synchronous=NORMAL + busy_timeout=3000`(단건 insert 5ms→0.01ms 실측). **ipam.db만 예외** — 외부 프로그램이 직접 읽는 공유 파일이라 저널 기본(DELETE) 유지 + busy_timeout만. WAL 전환 금지(외부 리더의 -wal/-shm 호환 미확인).
  - **전력 latest 인메모리 캐시**(`idrac/db.js withLatestCache`): latestAll(GROUP BY MAX)은 테이블 풀스캔이라(90일 수렴 시 수억 행) 매 30초 3회 호출이 초 단위 블로킹이었음. 기동 시 1회 시드 후 쓰기 경로에서 O(1) 갱신 — **getDb() 래퍼를 우회한 직접 쓰기 금지**(캐시가 낡음). 전력 대시보드 24h 집계는 `power_hourly` 롤업이 담당한다(`idrac/db.js`) — v2.503 정정: 여기 적혀 있던 `idrac/service.js aggCache` 60초 캐시는 **v2.292 에 삭제됐다**(코드 주석이 직접 그렇게 밝히고 있는데 이 문서만 낡아 있었다).
  - **대량 export 청크 패턴**(`routes/api.js gpuSeriesExport`): 대량 시계열 조회는 5만 행 ts 윈도우 청크 + 청크 사이 `setImmediate` 양보 + 행 상한(`GPU_EXPORT_MAX_ROWS` 기본 30만). 1M행 동기 dump는 이벤트 루프 ~10초 정지 실측 — 새 export 추가 시 동일 패턴 필수.
  - **웹 폴링 뷰 오류 처리**: 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 ErrorBox로 갈아치우지 않는다 — `if (error && !data)`일 때만 전체 오류, 그 외엔 배너(고RTT에서 대시보드 깜빡임 방지). 스코프(파라미터) 변경 시 usePolling이 직전 데이터를 비워 이전 스코프 데이터 표시를 막는다.
  - **대량 SQLite 쓰기 오프로딩**(`ipam/writeWorker.js`, v2.215): 레저 동기화는 DELETE+수천 행
    INSERT 다. 트랜잭션으로 fsync 는 1회지만 **바인딩·INSERT 자체가 동기 CPU** 라 5,850 VM 규모에서
    그 시간 동안 메인 루프가 멈춘다(node:sqlite 는 동기 API 뿐 — 스레드를 옮기는 것 말고 방법이 없다).
    쓰기는 워커만 하고 메인은 폴백일 때만 쓴다(두 연결이 동시에 쓰면 SQLITE_BUSY). 컬럼 정의는
    `ipam/record.js` 하나를 공유할 것 — 복사해 두면 컬럼 추가한 날 워커 INSERT 만 밀린다.
    워커 생성/실행 실패는 항상 인라인 폴백(`IPAM_WRITE_WORKER=0` 으로 완전 비활성).
  - **추이 트래킹 diff-저장**(`vmtrack/`, v2.345~2.355): VM 수량·DS 사용량 추적은 **변경분만
    저장**한다 — 전량 로스터를 매 슬롯 적재하면 5,850 VM·1,100 DS × 2회/일 = 연 수백만 행.
    ds_series 는 첫 관측 + 1GB 이상 변화만(UNIQUE(slot, ds_id) upsert) 기록하고 조회 시 step
    펼침(stepFill). 기준선 원칙: 첫 관측 이전 값은 소급 표시 금지(null/'—'), 구버전 행(ds 열 0)을
    증감 기준으로 쓰지 말 것(v2.351 '+2만 TB' 오표시 실제 발생). prune 용 `ts` 단독 인덱스 유지.
  - **계측 히스토그램은 측정 대상의 실제 분포를 덮어야 한다**(`perf/stats.js BUCKETS_MS`, v2.503):
    v2.498 의 첫 버킷 경계가 50ms 였는데 이 서버 API 는 거의 전부 스냅샷 집계라 50ms 미만이다 —
    전 표본이 0번 버킷에 몰려 p50·p95·p99 가 **모두 maxMs 로 붕괴**했다(실측: `/datastores` p50=p95=max=2,
    `/vms` 25, `/hosts` 13). 표가 '측정하고 있다' 는 착시만 주고 튜닝 정보를 주지 않았다.
    1·2·5·10·25ms 경계를 추가했고 이 경계들을 빼면 붕괴가 재발한다. 카운터는 메모리에만 있어
    (설정만 `perf-monitor.json`) 경계를 바꿔도 마이그레이션 대상이 없다.
  - **표 정렬 비교기는 `Intl.Collator` 를 한 번 만들어 재사용**(`components/sortableText.js`, v2.503):
    `localeCompare(x, undefined, {...})` 는 호출마다 옵션을 다시 해석한다. 정렬은 비교가 O(N log N)
    이라 그 비용이 그대로 곱해진다 — 1,100행 실측 **50.1ms → 2.2ms(22배)**. `STable` 은 정렬 결과를
    `useMemo` 로 들고 있다(폴링 틱마다 전량 재정렬하던 것) — 단, **훅은 조기 return 위**에 둔다.
  - **중앙 push 는 gzip + 한도 확인**(v2.503): 스토리지·PDU push 가 gzip·청크 없이 **기본 1MB** 한도로
    올라가고 있었다. 413 은 `resilientFetch` 재시도 대상이 아니라 그 법인 데이터가 **조용히 전량
    소실**된다(guest-disk 가 v2.466 에 겪은 사고). 새 push 경로를 만들면 ① gzip ② 중앙 `BIG_JSON`
    등록 여부 ③ 413 로그를 함께 확인할 것. `express.json` 의 limit 은 **압축 해제 후 길이**라
    gzip 만으로는 413 이 해결되지 않는다.
  - **응답 캐시 LRU 는 vCenter 수보다 커야 한다**(`util/snapCache.js MAX_PER_NAME`, v2.503): 화면 대부분이
    `?vcenterId=` 로 스코프를 나누므로, 상한이 vCenter 수(28, 30+ 확장 예정)보다 작으면 법인별 화면을
    동시에 보는 사용자 몇 명으로 LRU 가 스래싱해 v2.447 이 고친 '히트율 0%' 가 재발한다. 기본 32.
  - **prune 스로틀은 기동 첫 틱을 피한다**(v2.453 규칙 — v2.503 에서 `capacity/sampler.js`·`logs/poller.js`
    두 곳의 재발을 수정): `% N === 1` 과 `tick++ % N === 0`(tick 초기값 0)은 **첫 샘플/첫 폴에서 즉시 참**
    이다. 보존기간을 줄이고 재시작하면 첫 틱이 그 차액을 한 번에 지운다. `(++tick % N) === 0` 으로 쓸 것.
  - **N+1 을 '전 키 1쿼리' 로 합치기 전에 반드시 재 볼 것**(v2.503 실측): `/tools/capacity-forecast` 의
    DS별 조회를 `historyAll` 형태로 합쳤더니 **2.3배 느렸다**(1,563ms → 3,586ms). `samples_hourly` PK 가
    `(metric,k,h)` 라 키별 조회는 인덱스 선탐색이지만 `WHERE metric=? AND h>=? GROUP BY k,b` 는 파티션
    전체를 훑고 temp b-tree 로 정렬한다. 그래서 memo + `setImmediate` 양보를 택했다. 스키마를 보지 않고
    '합치면 빠르다' 고 단정하지 말 것.
  - **서버별 시계열을 새로 만들 때는 계열 수를 먼저 계산할 것**(`idrac/serverTempSeries.js`, v2.504):
    서버별 적재는 (대상 수 × 계열 수 × 24 × 365) 행/년 이다. iDRAC 온도 추이는 사용자 요청으로
    추가했지만 **기본은 서버당 1계열**(`idractemp_max`)로 뒀다 — 965 서버 ≈ 연 845만 행으로, 이미
    쓰고 있는 `temp_host`(ESXi 655 호스트 ≈ 연 574만 행)와 같은 규모다. 흡기·배기·CPU 를 더하면
    4배(연 3,380만 행)라 `IDRAC_TEMP_SERIES_DETAIL=true` 옵트인으로만 켜진다. 시간당 롤업은
    `(metric,k,hour)` upsert 라 **샘플 주기를 줄여도 행 수가 줄지 않는다** — 계열 수가 전부다.
    결측 종류는 행을 만들지 않고(0 은 '급냉' 으로 보인다), 15분 이상 지난 표본은 적재하지 않는다
    (죽은 서버의 마지막 값을 매 분 다시 쓰면 장기 차트가 평탄선이 된다 — v2.387 실제 사례).
  - **키 하나의 첫/마지막 관측은 `metaKey`(MIN/MAX)로**(`metrics/db.js`, v2.504): `meta(metric)` 의
    `COUNT(*)` 는 그 지표 파티션 전체를 훑는다(v2.503 감사 지적). 기준선 표시처럼 건수가 필요 없는
    곳에서 `meta()` 를 부르지 말 것.
  - **파괴적 판단의 근거가 되는 기능은 '후보' 까지만 말한다**(`tools/orphanVmdk.js`, v2.505):
    고아 VMDK 탐지는 사용자가 **파일을 지울지 결정하는 근거**가 된다. 그래서 ① 삭제 API 를 만들지
    않았고(화면에도 버튼 없음) ② 문구를 '삭제 대상' 이 아니라 **'확인 필요 후보'** 로 고정했고
    ③ 판정을 세 단계로 나눴다(소유 VM 없음 / 미등록 VM 폴더 / 판정 보류). 판정은 **이 vCenter
    인벤토리 기준**이라 공유 데이터스토어·FCD(쿠버네티스 PV)·콘텐츠 라이브러리·Replication·
    미등록 VM 은 멀쩡히 쓰이는데도 소유자 없이 보인다 — 이 제외 목록과 `SHARED_DS_WARNING`,
    `confidenceOf()` 를 화면에서 지우지 말 것. 경로 비교는 반드시 `normDsPath` 로 정규화한다
    (대소문자·공백 표기 차이로 비교가 어긋나면 **쓰고 있는 디스크가 고아로 보고된다**).
    디스크립터와 익스텐트는 `logicalDiskKey` 로 묶어 크기를 합산한다(따로 세면 회수 용량이
    디스크립터 크기로 보인다). 데모(mock) 모드에서는 판정하지 않는다 — 없는 고아를 지어내지 않는다.
  - **가끔 쓰는 무거운 리포트는 상시 적재하지 않는다**(`vcenter/orphanScan.js`, v2.505): 고아 VMDK 의
    소유 집합 원천(`layoutEx.file`)은 이미 매 폴링에서 받지만, 경로 문자열을 스냅샷에 넣으면
    5,850 VM × 파일 10~20개 = 6~12만 문자열이 `/central/inventory` push 와 응답 캐시에서 매번
    직렬화된다. 그래서 실행 시점에 그 데이터스토어의 VM 만 다시 읽는다 — 정상 운영 비용 0,
    실행 시 SOAP 왕복 2회. 기존 `dsBrowse` 의 60초 캐시·90초 시한·파일 상한·시한초과 태스크 취소를
    재사용하고 데이터스토어별 재진입 가드를 더했다(연타가 vCenter 부하를 곱하지 않게).
  - **실시간(20초) 스파이크 수집은 '임계 이상 순간' 만, vCenter 마다 독립 파일**(`vmseries/`, v2.510 —
    사용자 결정 "50% 이상만 저장 · 평균은 vCenter 병행 · DB 분리하는거 꼭 기억해"):
    - 20초 원본을 행으로 쌓지 말 것 — 5,850 VM × 10계열 × 4,320/일 = 연 **184억 행**이다. 저장 단위는
      트리거(cpu/mem % · ready %/vCPU · 벌룬/스왑>0) 중 하나라도 넘는 **순간의 전 카운터 값**을 50분치
      BLOB 1행으로 패킹한 것(`spikes.js packMoments`)이고, 임계 미만은 저장하지 않는다. 평균·p95 는
      vCenter 롤업이 맡는다(롤업은 평균을 보존하고 피크를 파괴한다 — 이 수집은 그 반대만 한다).
    - **'스파이크 0' 과 '미측정' 을 구분하는 것은 `cover` 표다**(엔티티·시간별 관측 표본 수). 행이 없는 것을
      '스파이크 없음' 으로 읽는 화면을 만들지 말 것 — `localReportFor` 의 `freq[].measured`·`coverage` 를 써서
      미측정은 회색 음영으로 그린다. 커서(`cursor`)가 50분 주기 × 60분 버퍼의 겹침을 두 번 세지 않게 한다.
    - **DB 파일은 `vmseries/<id>-<sha1 8자>.db`** — `metrics/vmperfDb.js dbFileName` 재사용(단사 매핑). 조회
      경로는 `create:false` 로 열어 없는 id 로 파일을 무한 생성하지 않는다. 대상 제외 = 파일째 삭제.
    - **권고 vCPU 산정에 20초 최대를 넣지 말 것** — `rightsize.js:176` 의 `최대 > p95 × 1.5` 규칙에 20초 최대를
      넣으면 거의 전 VM 이 스파이크형이 되어 권고가 전반적으로 커진다. 'Local + vCenter' 템플릿은 표시만 한다.
      반영 규칙(예: 지속 1분 이상 run 만)은 운영 데이터를 본 뒤 별도 결정.
    - 주기 50분은 겹침 10분(ESXi 버퍼 60분) — 한 주기 실패 = 40분 영구 소실. 상한 60·하한 20 을 서버가
      강제하고 설정 화면이 `intervalWarning` 으로 그 사실을 적는다. 기본 **꺼짐(opt-in)**, 디스크 여유 가드
      (`VMSERIES_MIN_FREE_GB`)로 포탈 디스크를 채우지 않는다. 위임 vCenter 는 엣지가 수집해 `/api/central/vmseries`
      로 push(gzip·청크·BIG_JSON 등록·413 로그 — v2.503 규약)하고 설정은 `vmseries-config` pull 로 내려간다.
  - (구 '미해결 후속' 2건 — 적용 완료) 전력 대시보드 시간당 롤업 테이블은 `power_hourly`
    (idrac/db.js, 적재 트랜잭션 내 증분 upsert)로, 위임 잡 인출 2단계 확인응답(claim→ack)은
    v2.290(central/captureJobs.js — claim 기한 + 재수확 reap + 재시도 상한, idracScanJobs 패턴
    이식)으로 해결됨. **새 위임 잡 큐를 추가할 때 같은 claim→ack 패턴을 따를 것.**

## 보안 불변조건 (회귀 방지 — 유지할 것)

서버 보안 불변조건(전역 TLS·RBAC·토큰 검증·scope·OTP·WS 게이트웨이 등 전 항목)은
`server/CLAUDE.md` 로 이관했다 — server/ 아래 파일을 만질 때 자동 로드된다.
되돌리면 안 되는 규칙들이므로 삭제 금지. 새 보안 규칙도 그 파일에 추가할 것.

## 서비스 허브(`pyportal/`) 불변조건

pyportal 전용 불변조건(6차 감사 v2.214.0 ~ v2.216 추가분)은 `pyportal/CLAUDE.md` 로 이관했다 —
pyportal/ 아래 파일을 만질 때 자동 로드된다. 되돌리면 안 되는 규칙들이므로 삭제 금지.

## 프론트엔드 회귀 방지

- **신규 포탈은 V4 하나다**(`web/src/version_4/`, v2.508 — v2.490 의 V3 를 승격): 셸을 더 만들지 말 것.
  `console/` ↔ `version_3/` 가 페이지별 **58~87% 동일**했고 v2.506 svcmon 권한 버그를 **두 곳에**
  고쳐야 했다(`server/test/audit2506.test.js:64` 가 그 배열을 하드코딩한다). 네 번째 복제를 만들면
  같은 수정이 세 곳이 된다. V4 에 화면을 더할 때 지킬 것:
  - **도구 키(`#/tools/<k>`) 는 어떤 이름 변경에도 바꾸지 않는다** — `permissions.json` 의
    `toolsDenied` 값이자 `auth/toolAccess.js` 의 집행 매핑이다. 옛 이름은 `specialToolsList.js` 의
    **`aka` 배열**에 남긴다(v2.508 신설). desc 에 검색어를 끼워 넣는 우회를 되살리지 말 것.
    검색 매칭은 `views/toolSearch.js` 하나가 소유한다 — 카드 그리드와 ⌘K 팔레트가 같은 모듈을 쓴다.
  - **새 도구를 추가하면 `version_4/tree.js` 에 배치한다** — 안 하면 내비에서 영원히 못 찾는다
    (레거시 그리드에만 남는다). `tree.test.js` 가 '주소속 1회 · 미분류 0 · 유령 키 0' 을 고정한다.
    **상태를 바꾸는 도구**(rma·vm-clone·vmprovision·shutdown·diskadd·backup·massdeploy·agent-scans)는
    무조건 `운영 작업` 이 주소속이다 — 조회 그룹을 훑다가 실행 버튼을 만나지 않게.
    `toolcats/catalog.js` 의 PRESET 도 같이 채운다(빠지면 화면에서 '기타' 로 밀린다).
  - **모드 토글은 권한이 아니다**(`version_4/mode.js`): 바꾸는 것은 표 행수·기간·원시 열·펼침뿐이고
    **권한·데이터 범위·임계값(75/90)은 두 모드가 같다**. ⚠ '호출 API 도 같다' 고 쓰지 말 것 —
    ②와 ⑤는 패널이 달라 실제 호출 집합이 다르다(시안 초안의 오류였고 v2.508 에 정정했다).
    `localStorage` 접근은 반드시 try/catch(프라이빗 창에서 throw).
  - **V4 에서 무거운 API 는 15초 폴링 금지**: `/tools/capacity-forecast` 는 실측 1.5초(v2.503)라
    120초 이상 · 페이지 마운트 시에만. **고아 VMDK 스캔(`/tools/orphan-vmdk`)은 폴링 금지** —
    실행마다 vCenter SOAP 왕복이다(v2.505). 버튼 실행 + 재진입 가드.
    목록(`/tools/orphan-vmdk/datastores`)은 스냅샷 memo 라 폴링해도 된다 — 둘을 구분할 것.
    이 규약은 `server/test/v4Portal2508.test.js` 가 고정한다.
  - **'수집 대기' 로 뭉개지 말 것 — 화면이 '기다리면 되는지' 를 말해야 한다**(`version_4/loadState.js`,
    v2.509. 2026-09-14 사용자 질문 "기다리면 나오는거야?" 가 그대로 증거다): 업그레이드 재시작 직후
    KPI·패널이 전부 '수집 대기'·'불러오는 중…' 이었는데, 그 한 문구가 **행동이 정반대인 상황들**을
    덮고 있었다 — 첫 수집 중(기다리면 채워진다) / vCenter 연결 실패(**기다려도 안 된다**) /
    응답 시한 초과·연결 실패(재시도 중) / 등록 0개. `/health` 가 `vcentersPending`(첫 수집 전·중)과
    `vcentersUnreachable` 을 **따로** 세어 주는데(`routes/api/overviewNsx.js`, 그 주석이 직접
    "'pending' 을 'unreachable' 과 구분해" 라고 적고 있다) 프론트가 그걸 안 쓰고 있었다.
    - **pending 과 unreachable 을 합치지 말 것.** 합치면 '조치하세요' 라고 말해 놓고 잠시 뒤
      저절로 채워진다(거짓 안내). 대기가 하나라도 있으면 '수집 중' 이 이긴다 — `loadState.test.js` 고정.
    - **타임아웃·연결 실패는 ErrorBox(화면 전체 오류)로 띄우지 않는다** — 재시도 중이지 장애가 아니다.
      `usePolling` 은 20초 타임아웃 × 3회 뒤 실패로 떨어지고 15초 후 다시 폴링한다(`api.js:135`).
      오류 문구 판정은 브라우저별 변형을 다 받아야 한다 — Chrome 은 `timeout` 이 아니라
      **`signed timed out`** 이라 'timeout' 만 보면 놓친다(테스트에서 실제로 걸렸다).
    - **긴 설명은 상단 배너가 한 번만** 한다. 패널·KPI 는 짧은 문구(`short`). 패널마다 긴 문장을
      넣으면 화면이 같은 말로 뒤덮인다(스크린샷을 읽어야 보인다 — 수치로는 안 잡혔다).
    - LIVE 배지는 **첫 수집 중에 'OK' 라고 말하지 않는다**(`liveText`). v2.508 까지
      `28/28 vCenter OK` 뿐이라 수집 중에도 정상처럼 보였다.
    - 수집 주기·동시성·데드라인 **숫자를 문구에 박지 말 것** — `/health` 가 주는 값만 쓰고
      나머지는 '몇 분' 처럼 범위로 말한다.
    - ⚠ 남은 것: 도메인 타일 6장의 메타 문구는 `console/consoleData.js buildDomainTiles` 가
      만들어(관제 콘솔 셸과 공유) 아직 '수집 대기' 다. 배너가 설명하지만 완전히 고친 것은 아니다.
  - **표 머리글에 영문 소문자 단위를 쓰지 말 것**: `.v3-table th` 가 `text-transform: uppercase` 라
    `kWh` 가 **`KWH`** 로 샌다(v2.508 실제 발견 — 스크린샷을 읽어야 잡힌다). 한글 라벨로 쓰고
    단위는 각주에 적는다.
  - CSS 클래스 접두는 승격 후에도 `v3-` 를 유지했다(163개 규칙 전량 치환은 이득 없이 소실 위험).
    V4 전용 셸 크롬만 `v4-` 를 쓴다.
- **위임(엣지) 수집 환경에서 중앙 화면이 비면 안 된다**(v2.493, 2026-09-12 실제 신고 — 같은 유형이
  v2.381→2.383 에서 이미 한 번 발생했다): 위임 법인 서버는 중앙 레지스트리에 없고, 엣지가 export 로
  **최신 스냅샷만** 올려 보낸다(`collector/agent.js compactSensors` → 중앙 `collector/remoteInventory.js`).
  새 상세/조회 화면을 만들 때 `loadRegistry().find(...)` 로 못 찾으면 **빈 응답으로 끝내지 말고**
  `findRemoteServer(id)` 의 값을 쓸 것 — 이미 그 값을 쓰는 화면이 있는지 먼저 확인한다
  (`routes/admin/idracCore.js /idrac/temps` 의 `s.remote ? s.sensors : getSensorSeries(s.id).latest`,
  `idrac/roomTemp.js`). v2.493 은 iDRAC 상세 센서 탭이 이 확인을 빠뜨려, **같은 서버가 '법인별 온도'
  에서는 52℃ 로 보이는데 상세에서는 '센서 0개·0샘플'** 로 보이던 결함을 고친 것이다. 중앙에 이력이
  없으면 `seriesAvailable:false` 로 밝히고 최신값만 표로 보여준다 — 없는 이력을 1점 차트로 지어내지 않는다.
- **값이 없는 이유를 단정하지 말 것**(같은 v2.493 건): '텔레메트리 미지원' 처럼 원인을 특정하는 문구는
  그 원인을 실제로 확인했을 때만 쓴다. 표본이 0건인 것과 '표본은 있는데 그 지표만 없는 것' 은 다르고,
  조회 실패(404/403)와 '수집 0' 도 다르다. 네 경우를 구분하는 판정은 순수 모듈에 두고 테스트로 고정한다
  (`web/src/views/idrac/sensorText.js`). 조회 오류를 `.catch(() => {})` 로 삼키면 사용자는 원인을 알 수 없다.
- **수집 주기·상한 같은 숫자는 화면에 하드코딩하지 말 것**: API 가 실제 값(`intervalMs` 등)을 주면 그것을
  쓴다. v2.493 까지 센서 탭은 '1분 간격' 을 고정 문자열로 표시해, 주기를 바꾸면 문구가 사실과 달라졌다.

- **React 훅은 조기 return 위에서 선언**: `if (!data) return <Loading/>` 같은 조기 반환 뒤에 `useState`를
  추가하면 렌더 간 훅 개수가 달라져 **React #310으로 화면 전체가 크래시**한다(v2.202 사용자 관리에서 실제
  발생 → v2.203 긴급 수정). 뷰에 상태를 추가할 때는 항상 컴포넌트 최상단에 선언할 것.
- **권한 거부(403)는 '오류'로 표시하지 않는다**(v2.398): 403 은 장애가 아니라 정책대로 동작한
  접근 제어다. "오류: forbidden" 으로 보여주면 사용자가 시스템 장애로 오해해 새로고침·재로그인을
  반복하고 장애 문의를 올린다. 공용 `ErrorBox`(오류 표시 단일 지점 — 86개 파일·132곳)가 403 을
  감지해 `components/AccessDenied.jsx`(필요 권한·부여 방법·관리자 요청 문구)로 자동 전환하므로
  **뷰에서 따로 처리할 필요 없다**. 유지 규칙:
  - `api.js` 의 실패 경로는 반드시 `httpFail()` 로 `HttpError`(status·requiredRole/Perm/Owner)를
    던진다. `new Error(reason)` 으로 되돌리면 403 메타데이터가 사라져 안내가 범용 문구로 퇴화한다.
  - 서버에서 새 권한 게이트를 만들 때는 기존 응답 형태를 유지할 것 —
    `{error:'forbidden', requiredRole|requiredPerm}` 또는 `{requiredOwner:true, reason}`.
    이 키가 없으면 화면이 '데이터 범위 제한'으로만 안내한다(틀리진 않지만 부정확).
  - `usePolling` 은 403 을 받으면 그 (path,params) 폴링을 **중단**한다 — 정책 거부는 재시도해도
    결과가 같고, 15초마다 같은 403 을 만드는 것은 서버 로그·감사만 오염시킨다.
  - 문구 로직은 `components/accessDeniedText.js`(순수 함수)에 둔다 — 웹 테스트가 node 환경
    (DOM 없음)이라 컴포넌트 렌더 테스트가 불가하므로 판정·문구는 여기서 회귀로 고정한다.

## 사용자 선호 (반드시 준수)

- ★★ **정직 — 가장 중요한 덕목** (사실 기반·과장 금지, 엔지니어 간 대화): 질의응답·기술문의·
  디자인 등 **모든 대화**에서 근거 있는 사실만 말한다. **거짓말·상상해서 지어낸 내용·허황된 내용
  금지** — 사용자는 잠깐 기분이 좋아지는 거짓보다 확실하고 정직한 대화를 원한다. 부풀리기·수사적
  강조·기분을 맞추는 표현(칭찬·아부·불필요한 감탄)을 금지한다. 주장에는 기술적 근거(코드 위치·
  실측값·문서)를 붙이고, 검증하지 못한 내용은 반드시 추정임을 명시한다. 모르면 모른다고 말한다.
  실패·한계·리스크는 축소 없이 그대로 보고한다.
- **항상 한글로 응답**: 모든 답변/설명 메시지는 한국어로 작성한다.
- **새 작업 요청 시 작업 현황 표 표시**: 새로운 작업(명령) 요청을 받으면 응답 맨 앞에
  "작업 현황" 표를 보여준다. 열: `난이도 | 적합 | 실행 | 작업 | 상태 | 비고`.
  - `난이도`: 낮음/보통/높음 (단순 편집·UI·엔드포인트=낮음/보통, 아키텍처·동시성·대규모
    리팩터·미해결 버그=높음)
  - `적합`: 그 난이도에 적합한 모델(낮음/보통→Sonnet, 높음→Opus)
  - `실행`: 현재 실행 중인 모델. 적합 모델과 다르면 비고에 한 줄로 알려준다.
  - `상태`: `✅ 완료 / 🔄 진행중 / ⏳ 대기`
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리해 진행여부를 보인다.
- **`.` 입력 시 작업 현황 표 응답**: 사용자가 `.` 하나만 입력하면(상태 확인 핑),
  현재 **작업중(🔄 진행중)** 인 작업과 **대기중(⏳ 대기)** 인 작업을 같은 형식의 "작업 현황" 표
  (`난이도 | 적합 | 실행 | 작업 | 상태 | 비고`)로 정리해 보여준다. 릴리스 폴링 등 백그라운드 확인도
  표에 포함하고, 진행/대기 항목이 전혀 없으면 "모두 완료" 상태와 최근 완료 릴리스 버전을 간단히 알린다.
- **작업 완료 보고 시 토큰 사용량 표시**: 작업이 끝나 최종 보고할 때 그 작업에 사용된
  토큰 정보를 한 줄로 알려준다. 정확한 계측값이 노출되지 않는 환경에서는 추정치임을 명시하고
  근거(도구 호출 수·읽은/생성한 코드 분량)를 간단히 덧붙인다.
- **모든 표는 제목(헤더) 클릭 정렬**(v2.422~, 사용자 요구 '기억해줘'): 데이터를 보거나 조회하는 화면에
  표(`<table>`)가 있으면 **각 열 제목을 클릭해 오름/내림차순 정렬**할 수 있어야 한다. 웹의 `<table>` 은 전부
  공용 `components/STable.jsx` 로 바꿨다(v2.422, 181개) — **새 표는 `<table>` 대신 `<STable>` 을 쓴다**(props
  동일). 헤더 클릭 시 셀 내용(텍스트·숫자·단위·%·날짜 인식)으로 tbody 행을 재배열하며(`components/sortableText.js`),
  th 에 onClick 이 있거나 th 가 컴포넌트면 자체 정렬 표로 보고 손대지 않는다. 정확한 정렬 값이 필요한 셀은
  td 에 `data-sort`, 정렬 제외 열은 th 에 `data-nosort`, 합계 행은 `data-pin`(첫 셀 '합계/총계' 는 자동)을 쓴다.
  규칙: null/'—' 는 방향과 무관하게 항상 뒤로, 문자열은 `localeCompare`(숫자 인식), 숫자·날짜는 수치 비교.
- **화면이 바뀌는 변경은 Chromium 으로 직접 보고 보고할 것**(v2.507 사용자 지시 '앞으로는 필요할때
  Chromium 사용하자'): 단위 테스트는 **문자열과 판정**만 본다 — 줄바꿈·클리핑·카드 높이·그리드 정렬·
  대소문자 변환(CSS `text-transform`)·`**강조**` 가 별표로 새는 것은 **브라우저만 잡는다**.
  실제 사고: v2.439/v2.440/v2.505 의 `**강조**` 노출, v2.202 React #310 크래시.
  - **띄우는 기준**: 화면에 보이는 것이 바뀌면 띄운다 — 새 화면·새 표/차트, 텍스트 길이가 눈에 띄게
    변하는 문구 수정(라벨 11자→27자 같은 것), 조건부 렌더·훅 추가, 권한/빈 상태 분기. 순수 서버 로직·
    테스트·문서만 바뀌면 생략하고 **생략했다는 사실을 보고에 적는다**(v2.507 에서 '문자열만 바뀌었다'
    고 판단해 건너뛴 것이 사용자 지적을 받았다 — 판단이 틀릴 수 있으니 침묵하지 말 것).
  - **실행 방법**(v2.507 실측, 이 환경에서 그대로 동작):
    ```
    cd server && mkdir -p tmp && CONFIG_DIR=tmp DATA_SOURCE=mock AUTH_ENABLED=false PORT=<포트> \
      node src/index.js &          # 목 데이터 · 인증 없음. web/dist 를 그대로 서빙하므로 먼저 vite build
    until curl -sf http://127.0.0.1:<포트>/api/health >/dev/null; do sleep 2; done
    ```
    Playwright 는 전역 설치분을 `createRequire('/opt/node22/lib/node_modules/playwright/package.json')`
    로 불러오고 `chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] })`.
    `playwright install` 은 하지 말 것(이미 있다).
  - **볼 것**: ① `pageerror`·console error 수집(0 인지) ② `scrollWidth - clientWidth` 로 가로 넘침
    ③ `1440px` 과 `400px` 두 폭 ④ 실제 클릭해서 화면이 열리는지 ⑤ 스크린샷을 **직접 읽어** 확인
    (수치만 보면 잘린 텍스트를 놓친다 — v2.507 의 스토리지 카드 클리핑을 스크린샷에서 발견했다).
  - **내가 만든 결함인지 A/B 로 확정할 것**: 넘침·깨짐을 발견하면 변경 전 코드로 되돌려 재빌드해
    같은 수치가 나오는지 본다. v2.507 에서 이 절차가 '가로 스크롤 115px' 이 **기존 문제**임을
    밝혀냈다 — 확인 없이 내 탓이라 적거나 남의 탓이라 적는 것 둘 다 거짓 보고다.
  - **끝나면 목 서버를 반드시 죽일 것**: 과거 목 서버 4개가 남아 있었다. `pgrep -af "node src/index.js"`
    가 0 인지 확인하고 보고한다. `server/tmp/` 는 `.gitignore` 에 있다(PR #467) — 커밋되지 않는다.
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
     **pyportal 을 변경한 릴리스면 `pyportal/ver.txt` 맨 위에 `버전 (날짜) 한줄요약` 추가**
     (단독 복사 배포의 버전 표시 소스 — 코드 상수가 아니라 이 파일이 진실의 원천).
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
