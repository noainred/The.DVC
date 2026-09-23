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
- **테스트에서 `Date.now()` 를 기준 시각으로 쓰지 말 것 — 시각에 따라 깨진다**(v2.517 에 CI 실패로
  확정): `vmseriesDb2510.test.js` 는 `NOW = Date.now()` 였고, 스파이크를 `t0 + 60초` 에 심으면서
  빈도 버킷은 `floor(t0 / HOUR)` 로 찾았다. `query.js` 는 버킷을 **run 시작 시각**으로 잡으므로
  (`freqMap` 키 = `bucketOf(r.t0)`) `t0` 가 정시 직전 60초에 놓이면 run 이 다음 버킷으로 넘어가
  `runs` 가 0 이 됐다 — **확률 60/3600 ≈ 1.67%**. 제품 코드는 정상이고 테스트가 틀린 버킷을 본 것이다.
  수정은 `NOW = floor(Date.now()/HOUR)*HOUR - 30*60_000`(정시 -30분 — 항상 과거이고 경계에서 30분
  떨어짐) + 버킷 조회도 run 시작 기준. `t0 % HOUR` 이 항상 30분이라 경계가 **불가능**하다
  (10만 표본 검증 0건). 새 시계열 테스트를 쓸 때 같은 규칙 — **기준 시각은 경계에서 떨어뜨려 고정**한다.
  ✅ `chunkedPrune2453.test.js:48` 플래키는 **v2.581 에 원인을 확정하고 고쳤다**(아래 v2.581 항목) —
  프로브 `setInterval(fn, 0)` 의 하한 1ms 대 0.06ms 루프. '재실행하면 통과' 로 넘기지 말고 이 건처럼
  **경계값을 재현해** 확정할 것.
- ✅ **`perfMonitor2498.test.js` 플래키 — v2.560 에 고쳤다(제품 결함이었다).** 아래는 원인 기록이고
  **되돌리지 말 것**. 회귀는 `test/hangClear2560.test.js` 가 세 부분을 각각 고정한다(변이 검증:
  세 부분 중 하나만 되돌리면 6회 중 6회 실패). 실측 — 수정 후 격리 **60회 0실패** · 전량 3회 0실패.
  ⚠ **재발 판정 기준**: `clearHangs()` 직후 `readHangs().exists === true` 이면 이 결함이다.
  ⚠ 여기 적혀 있던 '약 3%' 는 **과소 기록**이었다(v2.560 실측 20~40%: 깨끗한 트리 10회 중 2회,
  다른 세션 10회 중 4회). 플래키 빈도를 적을 때는 **실행 횟수와 함께** 적을 것.
- **(원인 기록) 이것은 테스트가 아니라 제품 결함이었다.**
  실제 실패 지점은 테스트 첫 단언이 아니라 **:402
  `비운 뒤 파일이 다시 생기면 안 된다`**(`after.exists` 가 true)와 **:306 `1 !== 5`** 두 곳이다.
  - **원인**: `hangLog.js clearHangs()` 는 `generation` 을 올리고 `fs.rmSync(FILE)` 를 한다. 그런데
    그 시점에 **이미 issue 된 `fs.appendFile` 은 `O_CREAT|O_APPEND`** 라, write 가 unlink **뒤에**
    도착하면 **파일을 되살린다**. `generation` 검사(`flushQueue` 콜백)는 *잔여 큐* 의 재기록만 막고
    **이미 커널에 넘긴 write 는 못 막는다**.
  - **제품 영향**: 관리자가 hang 이 기록되는 중에 '로그 비우기' 를 누르면 API 는 `{ok:true}` 로
    보고하는데 **사용자명·IP·User-Agent 가 담긴 줄이 남는다**(화면은 '비웠습니다' 라고 말한다).
    v2.500 D/M-1 '보존일은 조회에서도 강제' 와 같은 계열의 정직성 문제다.
  - ⚠ **한 줄 수정은 실패한다.** v2.527 에서 '세대가 바뀐 콜백이 잔재를
    지운다' 로 고쳤더니 **60회 중 60회 실패**가 됐다(`유실 없음 19 !== 20`). 이유: 테스트 헬퍼
    `_resetHangLogCounters()` 가 **`writing = false`** 로 단일 비행 잠금을 강제 해제해, 이전
    테스트의 in-flight 콜백과 현재 테스트의 write 가 **동시에 존재**할 수 있다. 그 상태에서
    잔재를 지우면 방금 쓴 줄을 지운다.
  - ✅ **v2.560 수정 — 세 부분을 같이 고쳤다. 어느 하나도 되돌리지 말 것**(각각이 필수임을 변이
    검증으로 확인했다 — 하나만 되돌리면 6회 중 6회 실패):
    ① `clearHangs()` 는 `writing` 중이면 `clearPending = true` 로 **삭제를 미루고** 콜백이 수행한다
       (즉시 `rmSync` 도 한 번 한다 — 동기 확인이 바로 사라진 것을 보게. 미뤘다는 사실은 반환값
       `deferred` 로 밝힌다).
    ② 미룬 삭제는 콜백에서 **`!mine && clearPending`** 일 때만 한다(`const mine = gen === generation`).
       `mine` 까지 대상으로 하면 **방금 쓴 줄을 지운다** — 그것이 v2.527 의 실패다.
    ③ `_resetHangLogCounters()` 는 **`writing` 을 건드리지 않고 `generation += 1`** 만 한다. 세대가
       오르면 이전 콜백은 `mine=false` 라 카운터도 트림도 건드리지 않고 **대기 줄만 흘려보낸 뒤**
       잠금을 스스로 내린다.
    ⚠ 그리고 콜백의 **큐 배수(`if (queue.length) flushQueue()`)는 세대 판정보다 앞에** 있어야 한다 —
      예전처럼 `gen !== generation` 에서 먼저 `return` 하면 세대가 바뀐 콜백이 대기 줄을 남겨 두고
      끝나 **이후 append 가 영원히 밀린다**(잠금은 이 콜백만 내린다). 비워야 할 줄은 `clearHangs`
      가 이미 큐에서 뺐다.
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
    push 는 **gzip + 청크**(`push.js chunkDevices`, 요청당 700KB)이며 청크 0 은 중앙 목록 교체·이후
    청크는 upsert 병합(`central/sanSwitchEdge.js`) — 이 병합을 없애면 중앙 목록이 마지막 청크만 남는다.
    ⚠ **v2.517 정정 — 이제 기본이 '전체 포트' 다**(사용자 요청 "전체 포트 보는 것으로 기능 개선").
    위의 '문제 포트만' 근거("매 주기 수 MB")는 **압축 전 크기**였고 이 경로는 그 뒤 gzip 이 붙었다.
    실측(v2.517): 128포트 × 8대 = 원본 255~408KB · **gzip 6~12KB(압축비 40배)** → 5분 주기로 하루
    3.5MB 다. 되돌리는 길 두 개를 **지울 것**: ① 엣지 `SANSW_PUSH_PORTS=problem`(회선이 좁은 법인의
    탈출구) ② 장비당 크기 가드 `SANSW_PUSH_DEVICE_MAX_BYTES`(기본 900KB — 넘으면 **그 장비만**
    축약하고 `portsScopeReason` 에 사유를 남긴다. 조용히 줄이면 화면이 '전체를 받았다' 고 거짓말한다).
    `scopeSnapshot` 은 순수 함수이고 테스트가 압축비 20배 하한까지 고정한다 — 그 비율이 깨지면
    '전체 기본' 의 근거가 사라지므로 재검토할 것.
    ⚠ `/api/central/sanswitch-data`·`sanswitch-perf` 는 **BIG_JSON 등록이 필수**다(v2.517 에 누락을
    발견해 추가). `express.json` 기본 1MB 는 **해제 후 길이**라 포트 많은 디렉터 1대가 단독 청크로
    413 이 되고, 413 은 `resilientFetch` 재시도 대상이 아니라 **그 법인 데이터가 조용히 전량 소실**된다.
    ⚠ 화면은 **'전체를 받았는지' 를 추측하지 않는다** — `ports.portsScope`('full'|'problem')로
    구버전 엣지(필드 없음 → 엣지 업그레이드) / 현장 되돌림 / 크기 가드를 **각각 다르게** 안내한다
    (조치가 다르다). 판정·문구는 `web/src/views/tools/sanPortsScopeText.js` 하나가 소유한다.
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
  - ⚠⚠ **물리 파트(부품) 장애 — v2.548 재설계. '확인 불가' 를 정상으로도 장애로도 세지 않고, 전이만 기록한다**
    (`partfault/` + 웹 `views/tools/PartFaults.jsx`·`partFaultText.js`. v2.547 사용자 요청 "서버 스토리지 등의
    모든 장비에 있는 물리 파트 장애가 발생하면 노티를 발생하고 체계적으로 파트 장애를 기록하는 DB 와 화면" ·
    **"엣지에서 수집해서 로컬에서 처리하고 장애만 중앙으로"** → v2.548 사용자 지시 **"이게 가능한지 검토, 다시
    설계해줘"**. 6축 조사 + 적대적 반증(7건 중 4건 확정)으로 v2.547 의 결함 9건을 찾아 재설계했다.
    사용자 선택: **전체 재설계 · 전부 엣지 판정 · 장애 + 판정한 전체 요약**):
    - ⚠⚠ **정직 기록 — v2.547 은 제(Claude)가 만든 결함 4건이 '최악의 거짓' 그 자체였다**(전부 코드 실행으로 재현):
      **F1** `redfish.js fetchInventory` 는 어떤 경우에도 던지지 않아(모든 블록이 `catch{}`, try 밖 `await` 0개)
      연결 거부에도 29ms 만에 신선한 빈 인벤토리가 오는데, 그것을 '부품 0개' 로 읽어 화면이 **초록으로 '모든 부품이
      정상'** 이라 했다. **F2** 파트 키에 법인 축이 없고 `idrac/registry.js:248·272` 가 id 를 **IP 문자열**로
      발급해(등록부에 agent 개념 0건) 두 법인의 다른 서버가 중앙 DB 에서 같은 행이 되고 한쪽 장애가 **거짓 '복구'**
      됐다. **F3** 문서는 opt-in 인데 엣지 push 가 `PARTFAULT_ENABLED` 를 안 봤다. **F4** `extract/storage.js` 의
      fru 리더가 **존재한 적 없는 자료구조**(평면 맵)를 읽어, 실제 `svcDiag.parseSpinfo` 집계 객체가 오면 없는 부품
      8개를 지어냈다. 또 v2.547 문서가 "중앙이 remoteInventory 를 판정하면 두 번 열린다" 라고 적은 것은 **이유가
      틀렸다** — 진짜 이유는 `collector/agent.js:47-57 compactInv` 가 부품 health·serial·locator 를 **전부 빼서**
      중앙에는 판정할 데이터 자체가 없다는 것이다. 결론이 맞아도 근거가 틀리면 다음 사람이 잘못 판단한다.
    - **상태는 다섯이다** — `ok`/`warn`/`fault`/**`unknown`(못 읽음)**/**`absent`(빈 슬롯)**. 뒤 둘을 정상에도
      장애에도 넣지 않는다(v2.526 Unity SPA DIMM 24칸 중 `REMOVED` 12칸 실측 — 고장으로 세면 정상 장비에 장애 12건).
      `redfishPartState` 판정 순서: `State==='Absent'` 가 `Health` 보다 **먼저**, Health 를 못 읽으면 `unknown`,
      예측 실패는 ok→warn 만. ⚠ **`inv.health` 롤업을 쓰지 말 것**(빈 값을 OK 로 접는다) — 원소 배열에서 판정.
    - ⚠⚠ **수집 실패 ≠ 부품 0개(F1)**: `fetchInventory` 가 `inv.collections[<컬렉션>]='ok'|'failed'` 와
      `inv.reachable` 을 싣는다(**'failed' 를 사전 초기화**하고 성공 지점에서만 'ok' — `if (sysId)` 블록은 Systems
      GET 실패 시 catch 조차 안 타므로 `{}` 로 시작하면 '읽었는지' 를 말할 수 없다. 변이 검증으로 확인).
      `extract/idrac.js` 는 실패한 컬렉션의 종류를 **파트를 만들지 않고 `failedKinds`** 로 올리고, 전이는 그 종류의
      열린 장애를 **`collection-failed` 로 보류**한다(규칙 ⑥). `reachable=false` 면 `deviceOk=false`. 메타 없는
      구버전 캐시는 **전부 비어 있을 때만** 불통으로 본다(추측 최소화 — ≤30분이면 메타가 생긴다).
      팬은 Thermal 경로라 `idrac/poller.js` 가 옮겨 넣을 때 `collections.fans` 를 찍는다.
    - ⚠⚠ **키 체계(F2)**: `partKey = scope:deviceKey:kind:partId` — 장비 축은 **`deviceKey`**(iDRAC: 서비스태그 →
      UUID → 로컬 id, `DEVICE_KEY_KIND` 로 등급을 밝힌다. `remoteInventory.js:56` 이 이미 내린 판단) 이고, **법인 축은
      DB 기본키 `(agent, part_key)`** 가 담당한다. partKey 에 agent 를 넣지 않는 이유: `AGENT_NAME` 기본값이
      `os.hostname()` 이라(config.js:236) 호스트명 변경만으로 전 장애가 닫혔다 열린다. `scan.deviceOk`·`kindFailed`
      의 키도 **`agent|deviceId`**(`scan.js devKeyOf`) — deviceId 만 쓰면 한 법인의 성공이 다른 법인의 실패를 덮는다.
      스키마 v1 파일은 open 시 **DROP 후 재생성**하고 `meta.reset` 마커(at·from·to·rows)를 남겨 화면이 배지로
      밝힌다(v2.534 `capacityBasisMigration` 과 같은 판단 — 기준이 바뀐 이력은 이어 붙이지 않는다).
    - **판정 지점은 전 장비군 엣지**(사용자 선택). ⚠ 조사는 스토리지·SAN 을 **중앙 판정**으로 권했다 — 엣지 스냅샷이
      `storage/push.js:29-31 → storageEdge.js:29-31` 로 **축약 없이 중앙에 그대로 도착**하고 BIG_JSON 도 등록돼 있어
      중앙이 바로 판정할 수 있었다(실제로 돌려 정상 파트 3건 확인). 사용자가 '전부 엣지' 를 골랐으므로 중앙은
      `devicesForThisNode()`(agent 없는 장비)만 판정한다. **중앙이 위임 장비를 다시 판정하게 만들지 말 것** — 같은
      부품이 두 번 열린다. 그 대가로 **판정 규칙을 고치면 전 엣지 업그레이드**가 필요하고 구버전 엣지 법인은
      화면이 빈다 → 화면이 **버전 단위로** 밝힌다(`routes/api/partFaults.js classifyEdges`: fresh/stale/legacy/
      old-version/silent/unknown-version, `MIN_EDGE_VERSION`). 엣지 버전은 `selfRegister.js:41` 이 이미 보고한다.
    - **전송은 프로토콜 2 '장애 + 판정한 전체 요약'**(`push.js buildPayload`): 장비마다 `open[]`(상세) +
      `states{ok,unknown,absent: 키꼬리[]}` + `ok/reason/failedKinds/deviceKey`. v2.547 의 '장애만' 은 실측
      18.3KB/push 라 회선 근거가 없었고 `unknownKeys`·`unknownOmitted`·`unknownTruncated` 3단 우회를 낳았다 —
      전량이면 통째로 사라진다. ⚠ **장애 0건이어도 보낸다**(v2.517 `sendStatusOnly` 규약 — `storage/push.js:30`
      의 '0대면 POST 안 함' 결함은 v2.581 BUG-D 에 고쳤다 — v2.586 정정). 프로토콜 1 보고는 받되 **`deviceOk=false`**(닫지 않는 쪽).
    - **중앙 수신(`central/partFaultEdge.js`)은 인메모리다** — 디스크에 쓰지 않는다(전량 요약이면 12.5MB·74ms/push,
      svcmon 이 실측으로 거부한 방식). 진실의 원천은 `part-faults.db`. 재기동 직후 보고가 없으면 전이가
      `device-failed` 로 보류한다. **agent 는 인증된 값으로 덮어쓴다**(엣지가 법인 귀속을 정하지 못하게, F5).
      스토리지·SAN 은 `devicesForAgent(agent)` 에 없는 장비를 **버리고 개수를 밝힌다**(`rejected`). iDRAC 은 중앙
      등록부에 없어 검사 불가 — DB 기본키의 agent 축이 격리한다. 오래된 보고(기본 3시간)는 `deviceOk` 전부 false.
    - **스위치는 `partfault/settings.js partFaultEnabled()` 하나다**(F3): env `PARTFAULT_ENABLED` > 중앙 설정
      (`partfault-settings.json`, 엣지별 off 가능) > 기본 꺼짐. 엣지는 `agent/partFaultConfigPull.js` 로 받는다.
      **엣지에서는 poller(전이·DB·알림)가 돌지 않는다** — 엣지가 스위치를 켜면 알림이 두 번 나가던 것(v2.547).
    - **탐지 지연(F7)**: `idrac/poller.js` 가 인벤토리를 갱신하면 `partfault/hooks.js onSnapshotRefreshed()` 가
      디바운스(15초) 후 엣지는 push · 중앙은 판정을 **즉시** 한다. 남는 지연은 인벤토리 주기(30분)뿐이고 그것은
      iDRAC 부하 때문에 줄이지 않는다 — 화면이 '탐지 지연 상한 = 인벤토리 주기' 를 적는다.
    - **SAN 추출기(F9, `extract/sanswitch.js`)**: 포트는 `slotPort` 키(slot 등급), **링크 없는 포트는 판정하지
      않는다**(v2.521 — 상대가 빛을 안 보내므로 낮은 Rx 는 정상, `notJudged` 로 개수 밝힘). 광량 임계·`isLinked` 는
      `healthCheck.js` 의 export 를 import 한다(숫자 복제 금지 — 테스트가 소스를 검사). **팬/PSU 는 개수만 온다**
      (`parseFruShow` → `{ok,total}`) → `partId:'all'`·`keyKind:'none'` 그룹 파트 하나. ⚠ 팬을 빼 둔 정상 장비가
      fault 로 기록될 수 있다(정직 기록 — 어느 팬인지 알 수 없다). **PDU 는 범위 밖**(F8 — 스냅샷에 상태 필드 없음,
      `SCOPES_OUT_OF_RANGE`). fru 리더(F4)는 `svcDiag` 집계 객체의 `items[]` 만 읽고 **평면 맵 호환은 만들지 않는다**.
    - **전이만 적재**(`part_state` upsert + `part_event`; 파트 3.5만~6.4만 × 48회/일 = 전량 적재 시 연 10억 행).
      **닫는 판정 6규칙**(테스트가 하나씩 고정): ① 장비 수집 실패면 닫지 않음 ② `unknown` 은 열지도 닫지도 않음
      ③ `absent` 는 `removed`/`ok` 사유 구분 ④ 목록에서 사라진 것은 `missing` 보류 ⑤ 장비 단위 ⑥ 컬렉션 단위.
      **`part_state` 를 인메모리로 바꾸지 말 것**(재기동마다 전 파트가 새 장애 = 알림 폭주).
    - **알림은 파트당 1건 즉시**(사용자 선택 — 폭주 위험을 알린 뒤 고른 방식. 임의로 묶지 말 것). 본문에서 `**`
      제거(Slack·메일엔 BoldText 없음), 순차 발송, 상한·`email:skip` 누락을 화면이 밝힌다.
    - **스캔은 장비에 접속하지 않는다**(스냅샷만). '지금 점검' 은 연타해도 장비 부하 0 이지만 폴러와 재진입 가드 공유.
      DB 는 `config.dbDir` 을 따르고 `insights/dbLocation.js MIGRATABLE` 에 등재(둘 중 하나만 하면 이력이 사라진다).
    - ⚠ **정직 기록 — 실장비에서 확인하지 못한 것**: SSH/REST 수집 경로에 따라 SAN `slotPort` 표기(`12` vs `0/12`)가
      달라 같은 장비의 파트 키가 바뀔 수 있다(추정) · `fetchInventory` 의 멤버 단위 GET 실패(루트는 성공)는 'ok' 로
      남아 규칙 ④(missing)가 받는다 · 이 현장 iDRAC 의 IP 중복 실재 여부(목 데이터라 확인 불가).
    - ⚠⚠ **적대적 리뷰(정확성·보안·정직성 3렌즈 + 반증, v2.548 같은 릴리스) 확정 13건 — 되돌리지 말 것**:
      · **S1** `putEdgeReport` 는 `owned[scope]` 를 `Object.hasOwn + instanceof Set` 으로만 읽고 devices/open/states
        의 null·문자열 원소를 건너뛴다. scope `constructor` 하나로 TypeError 가 났고 **express 4 는 async 핸들러의
        throw 를 잡지 않아 요청이 응답 없이 매달렸다**(리뷰 실측 hang). 라우트도 try/catch → 400. 새 central 수신은 같은 규칙.
      · **S2** 수신 상한은 장비 수만이 아니라 **파트 수**다 — `DEVICE_PART_MAX`(2,000)·`REPORT_PART_MAX`(50,000)·
        `SCANNED_MAX_BYTES`(32KB). 장비 1개에 키 꼬리 120만 개(16MB, BIG_JSON 이내)가 파트 객체로 펼쳐져 agent 당
        ~450MB 상주(리뷰 실측 RSS 556MB). 잘린 장비는 `ok:false`(`parts-capped`)로 **닫지 않는 쪽**, 개수는 `partsOmitted`.
      · **C1** 같은 `(agent|partKey)` 가 한 주기에 두 번 관측되면 **가장 나쁜 상태 하나**(fault>warn>unknown>ok)만 쓴다.
        등록부에 같은 서버가 IP 와 서비스태그 두 id 로 있으면 실제로 생기고, 예전엔 ok 관측이 closed·fault 관측이 updated
        를 만들어 DB 에서 닫힘이 이겨 **매 주기 열림/닫힘 + 알림 반복**이었다. `stats.duplicateObserved` 로 밝힌다.
      · **C2/H3** 오래된(3시간) 엣지 보고의 파트는 `observed` 에 넣지 않는다 — 넣으면 lastSeenAt 이 '지금' 으로 갱신
        (거짓 신선)되고 그 보고의 ok 꼬리가 그동안 열린 장애를 **닫는다**. 전이도 `deviceOk===false` 장비의 ok 관측은
        닫지 않고 보류한다(방어선 2중).
      · **C3** Systems GET 만 실패하고 Chassis 는 응답한 주기에 장비 키가 서비스태그→IP 로 **떨어지면 파트를 내지 않는다**
        (`inv.collections.system`·`keyUnstable` → `system-failed` 보류). 그대로 두면 같은 PSU 가 IP 키로 두 번째 행을
        열고 복구 뒤 그 행이 `missing` 으로 영원히 남는다. 등록부에 서비스태그가 있으면 흔들리지 않으므로 진행한다.
      · **C4** 같은 이름 부품이 둘이면 **첫 항목도** `#1`·index 등급이다 — 첫 항목만 name 으로 두면 그 키도 배열 순서에
        묶여 있는데 화면은 경고하지 않고, Members 순서가 뒤집히면 고장 부품이 ok 로 닫히고 #2 가 새로 열린다(재현).
      · **C5/H7** 보류 사유를 나눴다 — `unassigned`(그 agent 가 보고했는데 이 장비가 없음: 재배정·등록 삭제) ·
        `no-report`(보고 자체 없음) · `edge-stale` · `edge-legacy`. `transition` 은 `scan.agentsReported`·
        `scan.deviceReason` 으로 구분한다(없으면 예전대로 `device-failed`). 재배정·삭제된 장비의 장애는 **자동으로 닫지
        않는다**(보고 부재 ≠ 고침) — 관리자가 `POST /tools/part-faults/close`(adminOnly·사유·감사·이벤트 `close/manual`)
        로 닫는다. 화면 문구는 "고쳐졌다는 뜻이 아니다" 를 적는다.
      · **H1/H2/H4** 빈 상태 판정은 **엣지 행을 함께** 본다(전부 위임된 현장에서 '장비가 없다' 오판 → `edges-not-fresh`),
        KPI 의 unknown/absent 는 신선한 엣지 요약을 **합산**하고 요약 없는 엣지는 개수로 밝힌다(`edgeScanTotals`),
        자동 점검이 꺼져 있거나 마지막 점검이 주기 2배를 넘기면 초록 '정상' 대신 `stale-off`/`stale-check`(주기는 서버 값).
      · **H5** `collector/puller.js` 의 실패 경로는 **직전 상태 위에 덮는다** — 통째로 바꾸면 version 이 사라져 엣지 분류가
        '구버전' 대신 '버전 미상' 이 된다. **H6** 엣지 push 는 중앙 응답의 `centralEnabled`·`rejected` 를 읽어 '중앙이
        꺼져 있어 기록·알림되지 않는다' 를 화면이 말한다.
      · ⚠ 리뷰가 확인하지 못한 것(정직 기록): 개별 토큰의 agent 이름이 수집 서버 등록부 name 과 항상 같은지(다르면
        fresh 엣지가 '등록부에 없음' + 등록부 항목이 'silent' 로 이중 표시) · iDRAC scope 로 남의 스토리지 id 를 실으면
        수신이 받는다(자기 agent 행에 한정 — 문서화된 한계) · `openFaults` LIMIT 20,000 초과분은 전이 입력에 없다.
      · 400px 표: 긴 식별 안내는 표 아래 **각주 1회**(`tableFootnotes`)이고 행에는 `keyKindMark`/`deviceKeyMark` 짧은
        표지만 — 행마다 반복하면 셀이 세로로 길어지고(400px 실측) 1440px 에선 같은 문단이 화면을 덮는다(v2.509).
      · ⚠ **테스트 시각 결함을 이 릴리스에서 두 번 밟았다**: `mergeEdgeReports` 는 보고 시각을 `Date.now()` 로 찍는데
        테스트가 `NOW`(정시 −30분, 최대 90분 전) + 4h 를 '오래됨' 으로 썼다 — 실제 나이는 2.5~3.5h 라 **시각에 따라**
        3h 경계를 넘거나 못 넘겼다(v2.517 규약의 변형). 기준은 **모듈이 찍은 `edgeReport(agent).at`** 이어야 한다.
  - ⚠⚠ **베어메탈 사용률 — 대상은 `classifyFleet().bareMetal` 하나이고, 한 경로로는 다섯 지표를 다
    못 얻는다**(`bmusage/` + 웹 `views/tools/BmUsage.jsx`·`bmUsageText.js`, v2.550 — 사용자 요청
    "여기에 분류된 서버들만 CPU memory disk Network HBA 사용율을 수집하고 싶어" + 서버 분석 ›
    구분 › **Baremetal(미가상화 물리)** 스크린샷. 선택: **iDRAC + OS SSH 둘 다(되는 것부터)** ·
    **법인 단위로 켠다** · **5분 · 원시 90일 + 일롤업 5년** · **Linux + Windows 둘 다**):
    - **대상 판정을 복제하지 말 것** — `insights/fleetInventory.js classifyFleet().bareMetal` 을 그대로
      쓴다. 20줄을 복사하면 화면이 '이 서버는 베어메탈' 이라 하고 수집은 빼먹는 일이 생긴다.
    - ⚠⚠ **경로마다 줄 수 있는 것이 다르다.** iDRAC 텔레메트리(`redfish.js fetchUsage` →
      `/redfish/v1/TelemetryService/MetricReports/SystemUsage`)는 **CPU·메모리·I/O(집계)까지**이고
      **디스크·네트워크·HBA 개별 사용률은 없다** — 그것은 OS 경로만 준다. 이 한계를 화면이 말한다.
      텔레메트리는 **iDRAC Datacenter 라이선스**가 필요할 수 있어 404/빈 리포트를 `no-telemetry`·
      `empty-report` 로 나눈다(v2.493 '원인을 단정하지 말 것').
      ⚠ **메트릭 id 를 하나로 굳히지 말 것**(v2.545 후보 체인 규약) — 이 저장소에서 확인된 것은
      `SystemBoardCPUUsage`/`CPUUsage` 뿐이고 MEM·IO id 는 **Dell 문서 기반 추정**이다. 그래서
      `usedIds`(실제로 쓴 id)·`seenIds`(응답에 있던 전체)를 화면이 밝힌다 — 실장비 응답을 받으면 좁힐 것.
    - **OS 계정 저장소를 새로 만들지 않는다** — `bmstor/registry.js`(베어메탈 스토리지 등록부)를
      재사용하고 그 `mounts` 가 곧 디스크 공간 측정 대상이다. 두 벌을 만들면 `secretCarry`·SSRF 가드를
      두 곳에서 지켜야 한다(CLAUDE.md '코어는 하나다').
      ⚠⚠ **iDRAC 등록부의 `host` 에는 스킴이 붙어 있다**(`https://10.0.0.1`) — `bmstor` 는 주소만
      저장하므로 그대로 비교하면 **OS 경로가 영원히 붙지 않는다**(v2.550 실화면 검증에서 발견).
      `targets.js hostKey()` 가 스킴·포트·끝 슬래시·IPv6 대괄호를 떼고 비교한다.
    - **누적 카운터는 `rates.js` 하나가 환산한다.** Linux 의 `/proc/stat`·`/proc/diskstats`·
      `/proc/net/dev`·`/sys/class/fc_host` 는 전부 부팅 이후 누적이라 **두 주기의 차이**가 필요하다.
      ⚠ **첫 표본·카운터 리셋(음수 델타)·간격 비정상은 `null`** 이다 — 0 으로 채우면 화면이
      **'부하 없음' 이라는 거짓**을 말한다(`sanswitch/rates.js` 와 같은 규약).
      ⚠ CPU 의 idle 은 **`idle + iowait`** 다 — iowait 를 busy 로 세면 디스크 대기 중인 서버가 100% 로 보인다.
      ⚠ **속도를 모르는 회선·FC 포트의 사용률(%)을 지어내지 않는다**(`linkPct` 가 `null`) — 처리량만 낸다.
    - **Linux 는 명령 1회**로 `/proc`·`/sys` 를 전부 받아 구획 표지(`##STAT`·`##MEM`·`##DISK`·`##NET`·
      `##NETINFO`·`##FC`·`##DF`)로 쪼갠다 — 200대 × 항목 7개를 따로 물으면 왕복만 1,400회다.
      **Windows 는 PowerShell `-EncodedCommand`(UTF-16LE base64)** 다 — 셸에 넘기는 문자가 base64 뿐이라
      인용부호 이스케이프 사고가 **구조적으로 없다**. `Win32_PerfFormattedData_*` 는 순간값이라
      **첫 주기부터 값이 나온다** — Linux 와 다른 점이고 화면이 그 차이를 말한다.
      ⚠ Windows WMI 클래스는 **이 현장 출력을 본 적이 없다**(정직 기록) — 항목마다 try/catch 라 없는
      클래스는 그 항목만 빠지고, `read`/`missing` 을 화면이 그대로 보여준다.
    - ⚠⚠ **'없는 것(absent)' 과 '못 읽은 것(missing)' 을 같은 칸에 넣지 말 것**: FC HBA 가 아예 없는
      서버를 `missing` 으로 세면 화면이 '확인 불가' 라 말해 사용자가 멀쩡한 서버의 드라이버를 의심한다.
      구획 표지는 항상 출력되므로 '구획은 왔는데 0줄' 은 **구조적으로 없다**는 양성 증거다. 그래도
      '카드가 없다' 고 단정하지 않는다(드라이버 미로드일 수도 있다) — 문구가 두 가지를 함께 말한다.
    - **DB 는 '지표를 열로' 둔다**(`db.js`). 실제 계산 — 200대 · 5분 주기(288회/일):
      지표마다 한 행이면 **51.8만 행/일**(원시 90일 4,670만 행), **지표를 열로 두면 5.76만 행/일**
      (원시 90일 **518만 행**)로 **9배** 차이다. 지표 종류가 고정이라 열이 맞다(`metrics/db.js` 의
      `(metric,k,h)` 는 **지표가 동적**이라 그쪽이 맞는 것이고 여기는 다르다).
      2단 보존(원시 90일 + 일롤업 5년)은 v2.531 스토리지 증가량과 같은 판단이고, **일 롤업은 평균과
      최대를 같이** 둔다(평균만 두면 피크가 사라지고 최대만 두면 평소 부하를 모른다).
      ⚠ **`null` 지표는 평균의 분모(n)에 넣지 않는다** — 넣으면 '못 읽은 주기' 가 평균을 0 쪽으로 끌어내린다.
      하루 경계는 **한국 시각(UTC+9)** 이다(v2.531 `DAY_OFFSET_MIN` 과 같은 값·같은 이유).
    - ⚠⚠ **DB open 은 진행 중인 시도를 공유한다**(v2.550 실화면 검증에서 잡은 결함): `_tried = true` 를
      `await import('node:sqlite')` **앞에** 세우면 부팅 중 동시 호출이 `available:false` 를 받고 화면이
      "이 서버의 Node 가 **SQLite 를 지원하지 않습니다**" 라는 **틀린 원인**을 말한다. `_opening`
      프라미스를 공유하고 `_tried` 는 성패가 확정된 뒤에 세운다 — **새 DB 모듈도 같은 패턴**으로.
    - **법인 단위 opt-in, 기본 전부 꺼짐**(사용자 선택). 이 현장은 등록 서버 1,135대 · 법인 16곳이라
      전량을 한 번에 켜면 주기마다 SSH·Redfish 세션이 수백 개 열린다. 하한(주기 60초)은 서버가 강제하고
      **켠 법인만** 설정에 남긴다(false 를 쌓지 않는다). **법인 귀속이 없는 베어메탈은 기본 제외**다
      (어느 법인 부하인지 알 수 없다) — 포함하려면 명시 옵트인.
    - ⚠ **엣지 위임 서버는 중앙이 접속하지 않는다**(`remoteAgent`). 중앙은 `remoteAgent` 없는 것만,
      엣지는 자기 agent 것만 가져간다 — 이 경계를 지우면 같은 서버에 iDRAC 세션이 두 배로 열린다.
      `serverId` 가 `host:<vc>:<name>` 인 항목은 **수동 태그로 베어메탈이 된 ESXi 호스트**라
      (`fleetInventory.js:170`) iDRAC 등록이 없다 → `no-idrac` 으로 밝힌다.
    - **인증 실패(401/403)는 주기 수집을 멈춘다**(`util/authGuard.js` 재사용 — v2.535 규약). SSH 계정이
      틀리면 5분마다 로그인 실패가 쌓여 **계정이 잠긴다**. 멈추는 것은 자격증명 거부뿐이고(타임아웃·연결
      실패로 멈추면 일시 장애가 수집을 영구 정지시킨다), 자격증명이 바뀌면 자동 재개하며 **수동 실행은
      막지 않는다**. 정지 id 는 `<agent>|os|<key>` 다 — 키만 쓰면 한 법인의 정지가 다른 법인의 같은
      태그 서버를 멈춘다(v2.548 `(agent, part_key)` 와 같은 판단).
    - **폴러 규약 전부**: 재진입 가드(수동 실행과 **공유**) · 동시성 제한(`BMUSAGE_CONCURRENCY` 기본 4) ·
      **서버당 시한이 세션을 실제로 끊는다**(`withDeadline` + `signal` — v2.417) · `startAdaptiveTimer`
      (`(getMs, fn, opts)` 순서) · prune 스로틀 `(++tick % N) === 0`(v2.453) · `ts` 단독 인덱스.
    - **대표값은 최대다**(`usage.js`) — 디스크 6개·NIC 4개인 서버의 '사용률' 은 하나가 아니고, 평균을
      쓰면 한 디스크가 100% 인 서버가 17% 로 보인다. ⚠ 최대를 뽑을 때 `null` 은 건너뛰고 **전부 null 이면
      null** 이다. 화면 각주가 '가장 높은 장치·회선 기준' 이라고 적는다.
    - **CPU·메모리는 OS 우선, 없으면 iDRAC** 이고 **어느 쪽을 썼는지 밝힌다**(`srcOf`). 조용히 고르면
      사용자가 두 화면의 숫자가 다른 이유를 모른다.
    - ⚠ **`Number('') === 0` 함정**(v2.550 초판의 실제 결함, 자체 테스트가 잡았다): 파서의 `num('')` 이
      `null` 대신 0 을 돌려줘 `DISK=D:|3|2000398934016|`(여유 공간 미상)이 **`usedPct: 100`(디스크 가득)**
      으로 계산됐다 — **오류 없이 틀린 값**이라 화면은 정상처럼 보인다. `v == null` 과 **빈 문자열을 먼저**
      본다(v2.525 `Number(null)===0` 규약의 변형).
    - ⚠ 표 머리글에 **영문 소문자를 쓰지 말 것** — `th` 가 `text-transform: uppercase` 라 '디스크 busy' 가
      **`디스크 BUSY`** 로 샜다(v2.508 규약의 재발. 스크린샷을 읽어야 보인다). `디스크 I/O`·`디스크 공간` 으로 고쳤다.
    - **전부 `—` 인 행은 '왜' 를 행이 말한다**(`missingMark` 짧은 표지) + 조치는 표 아래 **각주 1회**
      (`missingFootnotes`, v2.509 규약). 행마다 긴 문장을 넣으면 셀이 세로로 길어진다.
      ⚠ 표는 **가로 스크롤 컨테이너로 감쌀 것** — 지표 열이 8개라 감싸지 않으면 400px 에서 페이지를 밀어낸다.
    - 권한은 `tools` + **vCenter scope** 다 — 베어메탈은 법인 축이 **있으므로** 스토리지·Horizon 처럼
      403 으로 거절하지 않고 그 법인 것만 준다. ⚠ **법인 귀속이 없는 서버는 범위 계정에 노출하지 않는다.**
      DB 파일 경로는 admin 에게만(operator 는 `tools` 기본 보유 — '거부 기본값').
    - ⚠ **정직 기록 — 실장비로 확인하지 못한 것**: ① iDRAC 텔레메트리 `SystemUsage` 의 MEM·IO 메트릭 id
      ② Windows WMI 클래스 전부(특히 HBA — `MSFC_FibrePortHBAAttributes` 는 드라이버 의존) ③ 실제 서버의
      `/sys/class/fc_host` 표기. 목 데이터로 대상 해석·환산·화면·실패 경로는 확인했다. 첫 실수집에서
      `usedIds`·`read`/`missing` 을 보고 좁힐 것.

  - ⚠⚠ **iDRAC 텔레메트리는 `SystemUsage` 하나가 아니다 — 리포트 목록을 열거해 있는 것만 읽는다**
    (`bmusage/parse/idracTelemetry.js` + `idrac/redfish.js fetchUsage(entry,{full})`, v2.551 —
    사용자 요청 "방금 만든 기능 개선해줘" 의 선택 ①):
    - ⚠⚠ **정정 — v2.550 이 CLAUDE.md 에 "iDRAC 텔레메트리에 디스크·NIC·HBA 개별 사용률이 없다" 고
      단정해 적은 것은 `SystemUsage` 리포트 **하나만** 본 결론이었다.** iDRAC9 텔레메트리에는
      `NICStatistics`·`FCPortStatistics`·`StorageDiskSMARTData` 같은 리포트가 따로 있다. 그 단정
      때문에 OS 계정이 없는 서버(이 현장은 그쪽이 다수다)는 네트워크·HBA 가 영원히 `—` 였다.
      **리포트 하나를 보고 '그 경로에는 없다' 고 쓰지 말 것.**
    - **id 를 굳히지 않는다**: 리포트는 **이름 패턴**(`REPORT_KINDS`)으로 찾고 메트릭은 **후보 집합**
      으로 읽는다(v2.545 규약). 장치 축은 `Oem.Dell.FQDD` → `ContextID` → `MetricProperty` URL →
      `Label` 순으로 뽑는다 — 어느 것이 오는지 확인하지 못했다.
    - **장비가 가진 전체 목록(`seenReports`)과 실제로 읽은 것(`usedReports`)을 둘 다 보고한다**
      (사용자 선택: "장비별로 무엇을 읽었는지 밝힌다"). 화면이 `telemetryNote` 로 말한다 —
      첫 실수집에서 이 현장 리포트 구성을 바로 알 수 있고, 그때 패턴을 좁히면 된다.
    - ⚠ **'이 경로에 원래 없는 것' 과 '못 읽은 것' 을 구분한다**: 그 종류의 리포트를 장비가 갖고
      있지 않으면 `absent` 다. 특히 **디스크 busy%(iostat 의 %util)는 이 경로에 사실상 없다** —
      스토리지 리포트가 있어도 SMART·상태·용량 계열이다. 그래서 `diskbusy` 를 따로 `absent` 에 넣어
      화면이 "그 값은 OS 경로만 줍니다" 라고 말한다.
    - ⚠⚠ **왕복 예산을 먼저 계산할 것**(v2.528 Unity 와 같은 함정. 실제 산수):
      장비당 `목록 1회 + 리포트 6개(동시 3) = 3배치 × 2초 ≈ 6초` 이고 200대 · 동시 4면 **300초**로
      **주기(300초)와 같아진다**. 그래서 ① **리포트 목록 6시간 캐시**(목록은 라이선스·펌웨어가
      바뀔 때만 변한다 → 정상 상태 200초) ② **주기당 목록 조회 예산**(`BMUSAGE_LIST_BUDGET` 기본 20)
      을 둔다. 목록이 없는 장비는 그 주기에 `SystemUsage` 만 읽으므로 **v2.550 과 같은 비용**이고
      값도 나온다 — 점진적으로 채워진다. 이 둘을 지우면 첫 주기가 주기를 넘겨 재진입 가드가
      다음 틱을 계속 건너뛴다.
    - **전수 모드가 실패하면 `SystemUsage` 단독 경로로 떨어진다** — 개선이 퇴행이 되지 않게.
      ⚠ 단 **401/403 은 폴백하지 않는다**(같은 결과이고 계정을 잠근다 — v2.535 규약).
    - **iDRAC 의 NIC·FC 값은 누적 바이트다** — OS 경로와 똑같이 `rates.js` 로 환산하고(코어는 하나다)
      **첫 주기는 `null`** 이다. ⚠ `next` 에 **iDRAC 카운터도 담아야 한다** — 안 담으면 매 주기가
      '첫 표본' 이 되어 네트워크·HBA 가 영원히 `null` 이다. `next` 를 OS 조건에 묶지 말 것
      (Windows 는 OS 누적값이 필요 없지만 iDRAC 카운터는 OS 종류와 무관하게 필요하다).
    - **OS 값이 있으면 iDRAC 이 덮지 않는다** — 빈 칸만 채우고 `srcOf` 로 어느 쪽인지 밝힌다.
  - ⚠ **사용률 추이 차트의 y축은 0~100 고정이다**(`views/tools/bmUsageChart.js`, v2.551):
    데이터 범위에 맞추면 3~5% 구간의 잔물결이 **'거의 100%' 처럼** 보인다 — 사용률 차트에서 가장
    위험한 착시다. 처리량(B/s)만 상한이 없으니 데이터 최대에 맞추고 축에 단위를 적는다.
    · **수집이 없던 구간은 선을 잇지 않는다**(끊어진 subpath — `roomTempView.sparkPath` 와 같은 규약).
      끊는 간격은 **서버가 주는 `intervalMs` 의 배수**다(주기를 숫자로 박지 말 것).
    · **점이 1개면 선을 그리지 않는다** — 한 점을 선으로 만들면 추세가 있는 것처럼 보인다.
    · ⚠ **`seriesPoints` 는 값이 `null` 인 점을 버린다**(v2.551 자체 검증에서 잡은 결함): 남겨 두면
      빈 상태 판정이 `points.length` 만 보므로 **값이 전부 결측인데 '비어 있다' 고 말하지 못한다**
      — 차트는 비고 안내도 없는 최악의 조합이 된다.
    · **원시와 일 롤업을 같은 선으로 그리지 않는다** — 뜻이 다르다(순간값 vs 하루 평균/최대).
      기간을 바꾸면 `source` 가 바뀌고 화면이 그 사실을 말한다(`sourceNote`). 롤업에 평균이 없는
      지표(디스크·네트워크·HBA)는 평균을 **지어내지 않는다**.
    · ⚠ 지표명과 통계를 **한 줄에 두지 말 것** — 좁은 열에서 `네트워크 처리량` 이 두 줄로 깨져
      차트마다 높이가 달라진다(v2.551 스크린샷 판독에서 발견. 수치로는 안 잡혔다). 차트 그리드의
      최소폭도 **440px** 이어야 한다 — 300px 이면 1440px 에서 4열이 되어 y축 라벨이 그래프를 먹는다.
  - ⚠⚠ **사용률 임계 알림은 '지속 + 억제 + 히스테리시스 + 영속' 네 개가 같이 있어야 한다**
    (`bmusage/alertRules.js`·`notify.js`, v2.551 — 사용자 선택. **기본 꺼짐**):
    200대 × 5분이면 하루 5.76만 판정이라 폭주 위험이 실재한다.
    · **지속 조건**(`alertSustainMin` 기본 15분) — 한 주기 스파이크(백업·부팅)로 알리지 않는다.
    · **재알림 억제**(`alertRepeatHours` 기본 6시간) — 같은 서버·같은 지표.
    · **히스테리시스**(`HYSTERESIS_PCT` 3) — 경계에서 떨리는 것을 해제로 보지 않는다(오르내림이
      알림을 두 배로 만든다). 해제는 **알린 적이 있을 때만** 1회.
    · **상태를 파일에 남긴다**(`bmusage-alert-state.json`) — 인메모리면 **재시작마다 전 서버가
      새 초과**가 되어 알림이 폭주한다(v2.548 `part_state` 규약과 같은 이유).
    · ⚠⚠ **`null` 은 초과도 정상도 아니다** — 판정 보류(상태를 그대로 유지)다. 정상으로 세면 지속
      카운터가 끊겨 진짜 초과를 놓치고, 초과로 세면 없는 장애를 만든다. 다만 오래 값이 없으면
      진행 중이던 초과를 끊고 **해제 알림은 내지 않는다**(복구가 아니라 **모르는 것**이다).
    · **임계가 비어 있으면 판정하지 않는다** — 0 으로 떨어지면 전 서버가 초과가 된다.
    · 감시는 **퍼센트 지표 6개**뿐이다 — 처리량(B/s)은 장비마다 정상 범위가 달라 임계를 정하지 않는다.
    · 알림 본문에 `**` 를 쓰지 않는다(Slack·메일엔 BoldText 가 없다) · 순차 발송 · 상한과 **잘린
      개수**를 밝힌다 · 위험한 것(초과)을 먼저 보낸다(상한에 걸려 해제가 초과를 밀어내지 않게).
  - ⚠ **release 워크플로의 재시도는 `versions.json` 만으로 부족하다**(v2.551 — v2.502 수정의 보완):
    v2.502 는 "versions.json 하나의 실패가 패키지 게시까지 막는다" 를 고쳐 그 파일에 5회 재시도를
    붙였는데 **패키지 업로드에는 재시도가 없었다**. 2026-09-17 에 같은 간헐적 오류가 그 단계에서 나
    v2.550.3 릴리스가 통째로 실패했다 — `HTTP 500: Error creating asset temp dir (…2.550.3.tar.gz)`.
    (워크플로 재실행으로 해소됐다 — 그날 기록대로 **간헐적 서버 오류**다.) 이제 패키지도 **파일 단위**
    로 4회 재시도하고, 그래도 실패하면 **versions.json 을 갱신하지 않고 중단**한다(없는 파일을
    가리키지 않게). 업로드 단계를 새로 만들면 재시도를 **모든 자산**에 붙일 것.

  - ⚠⚠ **SQLite aggregate 는 '하나' 일 때만 빠르다 — 둘을 한 쿼리에 쓰면 인덱스를 통째로 훑는다**
    (v2.550.3, **518만 행 실 DB 로 측정**. `bmusage/db.js` + `test/bmUsagePerf2550.test.js`):
    - 실측(200대 · 5분 주기 · 90일 = `usage_history` **518만 행 · 633MB**):
      · `SELECT MIN(ts)` 단독 **0.01ms** · `SELECT MAX(ts)` 단독 **0.01ms**
      · `SELECT MIN(ts), MAX(ts)` (둘) → **377ms** (`SCAN … USING COVERING INDEX`)
      · `SELECT COUNT(*), MIN(ts), MAX(ts)` (셋 — 흔한 `meta()` 패턴) → **407ms**
      · `SELECT COUNT(*)` 단독 → **28.9ms**
      · ⚠ **`WHERE <인덱스 선행열>=?` 로 좁히면 2.7ms** — 파티션 조회는 문제가 아니다.
    - 그래서 **결함 판정 기준은 네 조건의 논리곱**이다: ① WHERE 없이 전체 테이블 ② aggregate 2개 이상
      ③ 큰 테이블 ④ **조회 응답 경로**(화면 로드마다). 하나라도 빠지면 고치지 않는다 — v2.550.3 전수
      스윕에서 후보 30여 곳을 셋으로 걸러 **기존 코드에는 새 확정 결함이 0건**이었다(`logs/db.js` 는
      v2.503 이 memo 캐시를, `metrics/db.js` 는 v2.504 가 `metaKey` 로 COUNT 제거를 이미 했고,
      `sanswitch/perfDb.js perfDbStats`·`pdu/db.js dbStats` 는 폴링하지 않는 진단 경로다).
      **없는 결함을 만들어 고치지 말 것.**
    - ⚠⚠ **'최신 1건씩' 을 `GROUP BY` + `MAX(ts)` JOIN 으로 만들지 말 것** — 같은 518만 행에서
      **702ms** 이고 그것이 화면 로드마다 돌았다. 해법은 **최신값 전용 테이블**(`usage_latest`,
      PK `(agent,key)`)을 적재 트랜잭션 안에서 upsert 하고 그것을 읽는 것이다 — **0.53ms(1,130배)**.
      CLAUDE.md 의 `idrac/db.js withLatestCache`(v2.292) 항목이 이미 같은 함정을 기록해 두었는데
      ("latestAll(GROUP BY MAX)은 테이블 풀스캔이라 … 초 단위 블로킹이었음") 새 모듈이 그 교훈을
      놓쳤다 — **새 '최신값' 조회를 만들 때 이 두 줄을 먼저 읽을 것.**
      · ⚠ **`WHERE ts>=?` 로 최근 구간만 좁히는 대안은 효과가 없다**(실측 **303ms**) — 옵티마이저가
        `GROUP BY agent,key` 때문에 여전히 PK 커버링 인덱스를 스캔한다. 그 방향으로 되돌리지 말 것.
      · 최신값 upsert 는 **`ts` 가 더 클 때만** 갱신한다(`WHERE excluded.ts > usage_latest.ts`) —
        엣지 push 는 순서대로 오지 않는다(v2.531 규약).
      · 구버전 DB 는 open 시 **비어 있을 때만 1회 시드**(실측 783ms — 기동 1회). 매번 시드하면
        그게 곧 풀스캔이다.
    - **일 롤업 적재는 `ON CONFLICT DO UPDATE`** 다(행당 `SELECT` + `INSERT OR REPLACE` 는 200행에
      14.5ms, upsert 는 **7.4ms**). ⚠ SQL `MAX()` 는 인자 하나가 NULL 이면 **NULL** 을 주므로
      `NULLIF(MAX(IFNULL(x,-1e308), IFNULL(excluded.x,-1e308)), -1e308)` 로 감싸고 되돌린다 —
      감싸지 않으면 첫 관측이 null 인 지표의 최대가 통째로 사라지고, 하한을 되돌리지 않으면
      **-1e308 이 값으로 저장된다**.
    - ⚠ **`INSERT OR REPLACE` 로 원시 행을 넣으면 일 롤업이 이중 계수된다**: history 는 덮어써도
      롤업 upsert 는 또 누적한다(평균·표본수가 틀어진다). `INSERT OR IGNORE` + `changes === 0` 이면
      롤업을 **건드리지 않는 것**이 정답이다(쿼리 수는 같다). 중복 건수는 `duplicates` 로 밝힌다.
    - **행 수 `COUNT(*)` 는 짧게 캐시하되 캐시임을 숨기지 않는다**(`countsAt`). 진단·참고값이라 초
      단위로 정확할 이유가 없다. 적재·prune 이 행 수를 바꾸면 캐시를 버린다(방금 넣은 값이 안 보이면
      '저장이 안 됐나' 로 읽힌다).
  - ⚠⚠ **표본 시각은 '주기 시작 시각' 이 아니라 '그 서버가 실제로 읽힌 시각' 이다**(v2.550.3
    `bmusage/poller.js`): 누적 카운터를 쓰는 수집기에서 주기 시작 시각 하나를 전 서버에 쓰면
    `perSecond`·`busyPct` 의 **분모(span)가 실제 경과와 달라진다**. 동시성 4로 200대를 돌면 마지막
    서버는 주기 시작보다 수 분 뒤에 읽히고, 그 offset 은 **주기마다 흔들린다**(한 대가 시한에 걸리면
    뒤 서버들이 통째로 밀린다). 재현 계산 — offset `10초→200초` 면 실제 490초를 300초로 나눠
    **63% 과다**, `200초→10초` 면 **63% 과소**, `5초→250초` 면 **82% 과다**다. **오류 없이 틀린 값**이라
    화면은 정상처럼 보인다. `Promise.all` 직후 `Date.now()` 를 찍어 `prev.at`·`row.ts`·`buildUsage(now)`
    **세 곳이 같은 기준**을 쓰게 한다 — 하나만 바꾸면 그만큼 어긋난다.
  - ⚠ **두 번 시도하는 수집 경로는 세션 예산을 스스로 봐야 한다**(v2.550.3 — v2.528 Unity 와 **같은
    유형의 재발**): `bmusage/collectors/osSsh.js` 는 Linux 형식으로 읽고 실패하면 Windows 로 다시
    읽는다. 최악은 `READY(15s) + 30s + 30s = 75s` 인데 폴러의 장비 시한은 **60초**라, 그 순간
    `withDeadline` 이 먼저 던져 **두 번째 시도 결과가 통째로 버려진다**(화면에는 '시한 초과' 만 남는다).
    `SESSION_BUDGET_MS`(50초, **반드시 장비 시한보다 작게**)를 두고 각 시도를 `min(CMD_TIMEOUT, 남은
    예산)` 으로 실행하며, 남은 시간이 `MIN_SLICE_MS`(5초) 아래면 **시작하지 않고 사유를 남긴다**
    (조용한 생략 금지). 테스트가 두 숫자의 관계를 산수로 고정한다.
  - ⚠ **`status`·`last` 같은 '상태 객체' 에 집계를 담아 내보내지 말 것**(v2.550.3): v2.550.1 이
    응답의 `skippedCounts`·`counts` 를 scope 로 걸렀는데 **`status.last.counts.byReason` 경로로
    같은 정보가 무스코프로 그대로 나갔다**(범위 계정이 다른 법인의 대수·사유 분포를 알 수 있다).
    scope 를 고칠 때는 **그 데이터가 응답에 실리는 경로를 전부** 찾을 것 — 한 곳만 고치면 우회로가 남는다.
  - ⚠ **'전체 조회' 분기에서 파티션 키를 빠뜨리지 말 것**(v2.550.3 `usageDaily`): `key` 가 없으면
    agent 조건이 사라져 중앙이 자기 행과 엣지 행을 섞어 돌려줬다. 두 노드의 같은 서비스태그 서버가
    한 계열로 합쳐지는 종류의 거짓이다(v2.548 `(agent, part_key)` 와 같은 판단).
  - ⚠ **식별 키 충돌을 조용히 두지 말 것**(v2.550.3 `bmusage/targets.js keyConflicts`): DB 기본키가
    `(agent, key, ts)` 라 두 서버가 같은 키를 쓰면 **한쪽이 다른쪽을 덮어쓴다** — 그 서버의 사용률이
    다른 서버 값으로 보이고 오류도 나지 않는다(v2.548 F2 와 같은 유형. 서비스태그가 비어 fleetId·
    serverId 로 떨어진 서버끼리 성립한다). **대상에서 빼지는 않는다**(어느 쪽을 버릴지 판단할 근거가
    없고, 빼면 멀쩡한 서버가 조용히 사라진다) — 개수·목록을 올려 화면이 말하고, 조치(서비스태그를
    채우면 해결)와 **'빼지 않았다' 는 사실**을 함께 적는다.
  - ⚠ **인메모리 상태 맵은 대상 목록을 기준으로 정리한다**(v2.550.3): 서버마다 누적 카운터 배열을
    들고 있으면 등록부에서 서버가 빠져도 프로세스 수명 내내 남는다(누수). 더 나쁜 것 — 서버가
    **되돌아오면** 몇 시간 전 카운터와 비교해 `MAX_SPAN_MS` 상한에 걸려 그 주기가 통째로 `null` 이
    되고 '첫 수집' 이라고 말하지도 않는다. 매 주기 `live` 집합으로 걸러낼 것.
  - ⚠ **템플릿 리터럴 안의 SQL 주석에 백틱을 쓰지 말 것**(v2.550.3 에 실제로 겪었다): `` ` `` 하나가
    리터럴을 그 자리에서 끊어 `SyntaxError: missing ) after argument list` 가 된다. 근거는 함수의
    JSDoc(리터럴 밖)에 적는다.
  - ⚠ **소스 검사 테스트를 '상수 이름' 으로 좁히지 말 것**(v2.550.3 에 자기 테스트가 깨졌다):
    v2.550.2 가 `exec(cmd, CMD_TIMEOUT_MS)` 를 `/,\s*[A-Z_]+\s*\);$/` 로 고정했는데 v2.550.3 이
    시한을 예산 기반 `slice()` 로 바꾸자 깨졌다. 규칙의 **의도**('객체가 아니라 숫자')를 검사할 것.
    같은 파일의 다른 검사처럼 **주석을 먼저 제거**하는 것도 잊지 말 것(규칙을 설명하는 주석이 통과
    근거가 되면 안 된다 — v2.535 규약).

  - ⚠⚠ **엣지 로그·진행상태는 '당겨서' 본다 — 상시 수집하지 않는다**(`edgelog/` + `central/edgeLog*.js` +
    `agent/edgeLogWorker.js` + 웹 `views/tools/EdgeLog.jsx`·`edgeLogText.js`, v2.549 — 사용자 요청
    "진행상태를 edge 의 로그를 읽어와서 확인할 수 있는 기능 만들어줘". 선택: **로그 + 진행상태** ·
    **중앙이 당긴다(pull) + 폴백** · **즉석 조회 + 최근분 보관**):
    - **새 네트워크 허용이 필요 없다** — 엣지의 `GET /api/collector/edge-log` 는 `collector/puller.js:23`
      이 이미 60초마다 쓰는 **같은 url·같은 토큰**(`X-Collector-Token`)이다. 이 사실이 pull 방식을 고른
      근거이므로, 새 포트·새 인증을 도입하려 하지 말 것.
    - **상시 폴링 금지** — 로그는 대부분 볼 일이 없다. 사람이 누를 때만 엣지로 나간다(마운트 1회 + 버튼,
      v2.508 V4 규약). 폴링으로 바꾸면 28곳 × 로그 수백 줄이 회선을 상시 점유한다.
    - **폴백은 claim→ack 2단계**(`central/edgeLogJobs.js`) — 인출 즉시 지우면 엣지가 인출 직후 재시작했을
      때 요청이 영영 사라진다(사용자는 버튼을 눌렀는데 아무 일도 안 일어난 것으로 보인다). 엣지당 대기
      1건이고 새 요청이 기존을 덮는다(연타가 큐를 부풀리지 않게). **인메모리다** — 중앙 재시작 시 사라지는
      저비용 요청이라 파일 영속을 두지 않았다(RMA outbox 와 다른 판단: 저쪽은 '명령' 이라 유실이 위험하다).
    - ⚠⚠ **실패 기록을 '보관분' 이라 말하지 말 것**(v2.549 스크린샷 판독에서 잡은 실제 결함):
      실패도 사유를 남기려고 `putEdgeLog` 로 기록하므로 `latestEdgeLog()` 가 **로그 없는 실패 행**일 수
      있다. 그것을 화면에 내주면 "아래는 N분 전 가져온 값" 이라 말해 놓고 **빈 화면**이 된다. 화면에
      내주는 값은 `lastDataEdgeLog()`(내용이 있는 마지막 기록)이고, 실패는 `lastAttempt` 로 **따로**
      전한다. KPI '보관분 있음' 도 `counts.hasData`(내용이 있는 것)만 센다 — `have + failed` 로 세던
      초판은 열면 빈 화면인 엣지를 1 이라고 말했다.
    - **비밀은 출구에서 가린다**(`edgelog/redact.js`) — 각 모듈의 `*Status()` 반환을 그대로 실어 나르므로
      어느 모듈이 상태에 토큰을 담기 시작하면 그 순간 샌다. ⚠ **`key$` 를 가림 규칙에 넣지 말 것** —
      이 저장소에는 비밀이 아닌 `deviceKey`·`partKey`·`dbKey` 가 많고 통째로 `[가림]` 이 되면 파트 장애·
      수집 화면의 식별자가 사라진다. **키를 지우지 않고 표식을 남긴다**(v2.538 규약). 빈 값(`''`)은
      그대로 둔다 — 그 자체가 진단이다.
    - ⚠ **로그 가림은 완전할 수 없다**(정직 기록) — 자유 문자열이라 `KEY=값`·`Bearer …`·`X-*Token` 꼴만
      잡는다. v2.549 표본에서 이 저장소의 로그는 값이 아니라 **이름만** 찍고 있었지만(`… CENTRAL_URL/
      CENTRAL_TOKEN 없음`) 앞으로 누가 값을 찍을 수 있다. 화면의 `logRedactNote()` 가 그 한계를 **항상**
      말한다 — 지우지 말 것(사용자가 로그를 그대로 외부에 공유한다).
    - **'로그가 비었다' 를 '아무 일도 없었다' 라고 말하지 않는다** — 콘솔 링버퍼는 1,000줄
      (`logbuffer.js:7`)이고 재시작하면 사라진다. `logs.oldestId`·`node.startedAt` 을 함께 실어 화면이
      '이미 밀려났다' 와 구분한다. 잘린 줄 수(`truncated`/`omitted`)와 **중앙이 더 자른 것**
      (`centralCapped`)을 **구분해** 밝힌다(조치가 다르다 — limit 을 올린다 / 엣지를 본다).
    - **보관소가 빈 이유를 단정하지 않는다**(`storeNote`) — `store.sinceAt` 으로 '재시작해서 비었다' 와
      '한 번도 안 가져왔다' 를 나눈다. 후자는 **이상이 아니다**(누를 때만 가는 기능이다).
    - **실패 원인을 한 문구로 덮지 말 것**(v2.517 `perfDiagText` 와 같은 판단): `auth`(토큰 불일치 — 다시
      눌러도 같다) / `disabled`(엣지의 `COLLECTOR_TOKEN` 미설정) / `old-version`(업그레이드) /
      `unreachable`·`timeout`(폴백 등록) / `http` / `bad-body`. ⚠ **404 는 두 뜻**이라 본문으로 가른다 —
      이 코드의 엣지는 `{ok:false,reason}` 을, 구버전 엣지는 express 기본 404(HTML)를 준다.
    - ⚠ **폴백 등록 사실은 한 번만 말한다** — 초판은 `FETCH_KIND_TEXT.unreachable` 과 `queued` 분기가
      같은 문장을 넣어 한 줄에 두 번 떴다(스크린샷 판독에서 발견. 수치로는 안 잡혔다).
    - **표 아래 각주는 '해당 종류가 있을 때만'**(`tableFootnotes`) — 눌러도 안 되는 종류의 조치를
      행마다 반복하면 셀이 세로로 길어지고 같은 문단이 화면을 덮는다(v2.509 규약). 행에는 짧은 상태
      라벨만 둔다. ⚠ 표는 **가로 스크롤 컨테이너로 감쌀 것** — 없으면 400px 에서 표(실측 622px)가 페이지를
      밀어낸다(A/B 실측: 감싸기 전 265px → 감싼 뒤 228px = 기존 셸 기준선과 동일).
    - **저장 키는 중앙이 아는 이름**(수집 서버 등록부 `name`)이다 — 엣지 본문의 `node.agent` 를 믿지
      않는다(v2.548 F5). 둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다(`identityNote`).
      폴백 회신(`POST /api/central/edge-log-result`)도 **인증된 agent** 로 저장하고, async throw 가
      express 4 에서 요청을 매달지 않게 try/catch → 400 이다(v2.548 S1).
    - **`/api/central/edge-log-result` 는 BIG_JSON 등록 필수** — 로그 400줄 × 줄당 최대 2,000자면 기본
      1MB 를 넘고, 413 은 재시도 대상이 아니라 **조용한 소실**이 된다(v2.517 규약).
    - **폴백 워커는 무음 실패를 만들지 않는다**(`agent/edgeLogWorker.js`) — v2.549 조사에서 이 저장소의
      위임 워커 4개(`pingWorker`·`logQueryWorker`·`captureWorker`·`bmstorWorker`)가 전부
      `catch { return null; }` 에 상태 객체도 로그도 없어 **4~10초마다 조용히 실패**하고 있었다.
      이 워커는 `_last`(`edgeLogWorkerStatus`)를 남기고 실패를 콘솔에도 적는다. 불필요한 법인은
      `AGENT_EDGELOG_POLL_MS=0` 으로 끈다(기본 60초 × 28곳 = 하루 40,320 요청 — 작지만 공짜는 아니다).
    - 권한은 **adminOnly + fullScopeOnly** 다 — 로그에는 호스트명·IP·장비 식별자가 그대로 들어가고
      operator 는 `tools` 를 기본 보유한다(v2.500 D/M1 relaycheck 과 같은 기준). 엣지는 vCenter 귀속이
      아니라 범위 계정에 나눌 축이 없다 → 403(v2.525 Horizon 규약).
    - ⚠ **정직 기록 — 실장비(실제 엣지)로 확인하지 못한 것**: 이 환경에는 v2.549 엣지가 없어 pull 성공
      경로는 **목 서버에서만** 확인했다(중앙 자신을 상대로 `collectEdgeLog` 38항목 · 495ms). 실패 경로
      (unreachable → 폴백 등록)와 폴백 큐는 실제로 눌러 확인했다. 엣지가 v2.549 로 올라간 뒤 첫 pull 로
      확인할 것 — `usedKey` 류의 폴백이 아니라 **성공/실패가 바로 드러나는** 기능이다.
  - ⚠⚠ **통신 점검 — '측정 주체' 가 링크마다 다르고, 중앙이 못 재는 방향이 절반이 넘는다**
    (`linkcheck/` + `central/linkCheckEdge.js` + `agent/linkCheckWorker.js` + 웹
    `views/tools/LinkCheck.jsx`·`linkCheckText.js`, v2.552 — 사용자 요청 "main 포탈과 edge 포탈의
    모든 통신이 정상인지 측정하는 프로그램을 특수기능에 만들어줘, 현재 포탈에서 설정된 엣지와
    vcenter 와 수집 서버가 통신하는 것을 파악해서 점검하고 **점검하는 로그를 최대한 많이 기록**해서
    이슈가 있을때 분석하는 자료로 사용하고 싶어". 선택: **엣지↔엣지 포함** · 로그 **3단 구조** ·
    점검 **단계별 전체**):
    - ⚠ 설문 답(엣지↔엣지)과 본문(중앙↔엣지·vCenter·수집 서버)이 어긋났다 — **요청 범위를 조용히
      좁히지 않고** 세 방향 전부 만들었다(엣지→중앙과 엣지↔엣지는 **같은 엣지 워커**를 쓴다).
    - **점검 대상을 손으로 등록하게 하지 않는다**(`links.js buildLinks`) — 수집 서버·vCenter
      등록부에서 **계산**한다. 손 등록이면 빠뜨린 링크가 조용히 사라지고 화면의 "모든 통신 정상"
      이 거짓이 된다. 종류 6가지가 계약이다: `central->edge`(수집 토큰) · `central->vcenter`(direct) ·
      `edge->central`(push) · `edge->central-pull`(설정 9종) · `edge->vcenter`(site) · `edge->edge`.
      잘못된 url·담당 엣지 미지정은 **`problems` 로 드러낸다**(조용히 빼지 않는다).
    - ⚠⚠ **중앙이 잴 수 있는 것은 중앙이 나가는 방향뿐이다**(`CENTRAL_KINDS` 2종). 나머지 4종은
      엣지만 잴 수 있고, 그중 **엣지→중앙 push 가 죽으면 중앙 화면이 조용히 낡는다**(엣지 쪽은
      정상으로 보인다) — 그 상황을 보는 것이 이 기능의 핵심 목적이다. **엣지가 재는 링크를 중앙에서
      돌리지 말 것** — '중앙에서 안 닿는다' 를 그 링크 상태로 적는 거짓이 된다.
    - **엣지가 잴 링크는 중앙이 계산해 내려준다**(`GET /api/central/link-check-config`) — 켜진 종류·
      짝·시한은 중앙 설정이고 엣지가 자기 복사본을 들면 중앙에서 바꾼 값이 영원히 안 먹는다
      (v2.409 스토리지 주기와 같은 사고). **자기 몫만**(`from === agent`) 내려간다.
    - ⚠⚠ **엣지 보고는 인증된 agent 의 자기 링크만 받는다**(`putEdgeLinkReport` — v2.548 F5):
      본문 `agent` 를 읽지 않고, `EDGE_KINDS` 아닌 종류(중앙 측정분)와 `from !== agent`(남의 법인)를
      **버리고 개수를 밝힌다**(`rejected`). 상한은 링크 수(`REPORT_LINK_MAX` 500)이고 단계 객체는
      **아는 키만** 담는다. null·문자열 원소를 그대로 순회하면 TypeError 가 나고 **express 4 는
      async throw 를 잡지 않아 요청이 매달린다**(v2.548 S1) → 라우트도 try/catch → 400.
    - **3단 로그**(사용자 선택): ① 주기 요약 표본(`link_sample`, 기본 90일) ② **실패이거나 상태가
      바뀔 때만** 상세 원문(`link_event`, 8KB 상한, 기본 30일) ③ 일 롤업(`link_daily`, 기본 5년) +
      최신 전용 테이블(`link_latest`, `since_ts`·`streak`). 전 주기 상세는 **140링크 × 5분 = 90일
      5.1GB** 라 채택하지 않았다(계산해서 정했다). ⚠ `link_latest` 를 `GROUP BY + MAX(ts)` 로
      되돌리지 말 것(v2.550.3 실측 702ms → 0.53ms).
    - ⚠ **첫 점검은 `first` 다 — `recovered`(복구) 가 아니다**(v2.552 자체 검증에서 잡은 결함):
      이전 상태가 없으면 무엇에서 복구된 것이 아니다. 뒤집으면 장애 구간을 세는 화면이 없는 복구를
      하나 더 센다. 같은 `ts` 재적재는 `INSERT OR IGNORE` + `changes` 로 걸러 **롤업을 두 번 세지
      않는다**(v2.550.3 규약).
    - ⚠⚠ **단계 판정에서 '미시도' 를 '실패' 로 세지 않는다**(`phases.js judge`): DNS → TCP → TLS →
      HTTP → 인증 → 정체 순서이고 실패 단계 **뒤는 시도하지 않은 것**이다. `reached`(도달한 마지막
      단계)가 이슈 분석에서 가장 자주 보는 값이다. 화면의 `trailFromLatest` 도 같은 규칙 —
      표본 테이블에는 단계별 ok 플래그가 없으므로 `reached`·`phase` 로 되돌린다.
    - ⚠ **DNS 를 따로 먼저 잰다** — 이름 해석 실패와 연결 실패는 조치가 정반대인데 한 번에 붙으면
      둘 다 'timeout' 으로 보인다. 그리고 그 주소를 뒤 단계에 **핀**한다(`util/ssrfLookup.js
      pinnedLookup(ip)`) — 재해석하면 단계별 계측이 섞이고 "이 IP 로 점검했다" 는 기록이 거짓이 된다.
      ⚠ `makeSsrfLookup()`(재해석)으로 바꾸지 말 것. `test/ssrfAgents2537.test.js` 전수 스윕이
      `pinnedLookup(` 을 유효 형태로 인정하므로 **인라인 콜백으로 복제하지 말 것**.
    - ⚠⚠ **vCenter·엣지에 로그인하지 않는다**: vCenter 는 `/sdk/vimServiceVersions.xml`(무인증,
      그 주소가 정말 vCenter 인지까지 확인), 엣지는 `/api/collector/ping`(`/export` 는 그 법인
      인벤토리 전량이라 점검 주기마다 당기면 그 자체가 부하). **5분마다 로그인하면 세션 테이블을
      채우고 비밀번호가 바뀐 구간에서 계정을 잠근다**(`bulkRun.js` '자동 재시도 금지' 와 같은 사고).
    - **토큰이 없으면 '인증 실패' 가 아니라 `skip`** 이다 — 없는 것을 인증 실패로 세면 화면이
      "토큰이 거부됐습니다" 라 말해 사용자가 멀쩡한 토큰을 의심한다. 건너뛴 사유는 개수와 함께 밝힌다.
    - ⚠⚠ **측정값이 없는 링크를 '정상' 으로 칠하지 않는다**(`linkCheckText.rowState`) — 이 화면
      최악의 거짓이다. `no-data` 를 **별도 상태(회색)** 로 두고 이유를 순서대로 말한다: 점검 꺼짐 /
      엣지 구버전(눌러도 안 된다) / 엣지 버전 미상 / 첫 보고 대기(기다리면 된다) / 오래된 보고.
      KPI 도 `정상 · 실패 · 측정 없음` 을 **겹치지 않게** 세고 정상률 분모는 **측정분**이다
      (측정 0이면 `null` — 0% 가 아니다).
    - ⚠ **`Number('') === 0` 함정을 또 밟았다**(v2.552 초판, 자체 테스트가 잡았다): `msText('')` 가
      `0ms`(즉시 응답), `certText('')` 가 **`0일 남음`(오늘 만료)** 이 됐다 — **오류 없이 틀린 값**.
      `v == null || v === ''` 를 **먼저** 본다(v2.525·v2.550 규약).
    - **엣지↔엣지는 전량 자동 생성 금지**(`edgePairs`) — 28곳이면 756 방향이고 주기마다 그만큼
      나가면 그 자체가 사고다. **관리자가 고른 짝만** 점검하고, 화면이 그 산수를 적는다(`pairNote`).
      등록부에 없는 이름은 **버리지 않고 표시한다**(이름이 바뀐 것 자체가 진단).
    - **폴러 규약 전부**: 재진입 가드(수동 실행과 **공유**) · 동시성 제한(기본 6) ·
      `startAdaptiveTimer(getMs, fn, opts)` + 설정 변경 리스너 · prune 스로틀 `(++tick % 12) === 0` ·
      `ts` 단독 인덱스. 엣지 워커는 **무음 실패를 만들지 않는다**(`_last` + `console.warn` + 413 로그 —
      v2.549 규약). 기본 **꺼짐(opt-in)**, 주기 하한 60초.
    - `/api/central/link-check` 는 **BIG_JSON 등록 필수**(링크 500개 × 단계 6개 상세면 1MB 를 넘고
      413 은 재시도 대상이 아니라 **그 엣지 측정분의 조용한 전량 소실**이다 — v2.517 규약).
    - 권한은 **adminOnly + fullScopeOnly** — 링크에 전 법인 엣지 주소·내부 IP·인증서 주체·응답
      조각이 담긴다(operator 는 `tools` 를 기본 보유. v2.500 D/M1·v2.549 와 같은 기준). 링크는
      vCenter 귀속이 아니라 범위 계정에 나눌 축이 없다 → 403(v2.525 규약).
    - **화면은 폴링하지 않는다**(마운트 1회 + 버튼 — v2.508 V4 규약). 표는 **가로 스크롤 컨테이너**로
      감싼다(열 11개). 긴 설명은 **배너와 각주에 한 번만**(행마다 반복하면 같은 말이 화면을 덮는다 —
      v2.509). '지금 점검' 응답은 **중앙 즉시분과 엣지 대기분을 나눠** 말한다(v2.516 규약).
    - ⚠ **정직 기록 — 실장비로 확인하지 못한 것**: 이 환경에는 v2.552 엣지가 없어 **엣지 워커의
      성공 경로(`link-check-config` 인출 → 측정 → push)는 목 없이 코드 경로만 확인**했다(중앙 수신·
      거부·DB·화면 판정은 실제로 돌렸다). `central->vcenter` 의 `vimServiceVersions.xml` 응답도 이
      환경에서 받아 보지 못했다 — 형식은 관용적이고 못 읽으면 정체 단계가 **실패**로 떨어진다
      (정상을 지어내지 않는다). 엣지가 올라간 뒤 첫 주기로 확인할 것.
  - ⚠⚠ **설정 전수 통신 점검 — '장비 계정으로 로그인하지 않는다' 가 설계의 중심이다**
    (`linkcheck/settingsKinds.js`·`settingsLinks.js`·`settingsRun.js`·`protocols.js`·`remedy.js` +
    웹 `views/tools/SettingsCheckPanel.jsx`·`settingsCheckText.js`, v2.553 — 사용자 요청
    "설정에 있는 모든 통신이 되는지 점검하고 **해결책 제시**하는 기능". 선택: **전부 25종** ·
    해결책 **고정 조치문 + 맞춤 진단 둘 다** · **도달성만(인증은 수동 1회)** · 전체 검증):
    - **v2.552 와 다른 축이다.** v2.552 `links.js` 는 중앙↔엣지 **토폴로지**(수집 경로가 사는가),
      이것은 **설정에 등록된 모든 접속처**(등록한 주소가 닿는가)다. 대상 id 는 `set:<종류>|<ref>` 라
      링크 id 와 **이름공간이 겹치지 않고**, 폴러·DB·로그·화면(탭)은 **그대로 공유**한다 —
      폴러를 하나 더 만들면 재진입 가드가 둘이 되어 같은 장비에 세션이 두 배로 열린다.
    - ⚠⚠ **저장된 장비 비밀번호로 로그인하지 않는다**: SSH 는 **KEX(협상)까지**(ssh2 는 인증
      **전에** `handshake` 를 낸다 — `ready` 를 기다리면 인증을 한다), SMTP 는 **220 배너 + EHLO**
      (AUTH·MAIL FROM 없음 — 테스트가 소켓에 쓰는 문자열이 `EHLO`·`QUIT` 둘뿐임을 고정한다),
      LDAP 는 **포트 열림까지**(익명 bind 도 안 한다 — 디렉터리 감사·잠금 정책 대상이 될 수 있다).
      토큰을 쓰는 것은 `set:collector`·`set:central` **둘뿐**이고 그것은 **포탈이 발급한** 토큰이라
      잠금 위험이 없다(테스트가 이 두 개만 허용한다). 5분 주기 로그인은 계정을 잠근다 —
      `bulkRun.js` '자동 재시도 금지' · v2.535 `authGuard` 와 같은 사고다.
    - ⚠⚠ **무인증 점검에서 401/403 은 실패가 아니다.** 자격증명을 보내지 않았으므로 "서비스가
      살아 있고 인증을 요구한다" 는 **양성 신호**다. v2.552 의 `stepHttp` 는 401/403 을
      `auth:{ok:false}` 로 가르는데 그것은 **토큰을 보낸** 경우의 판정이라, `settingsRun.js` 가
      `authMode==='none'` 일 때 **ok 로 보정**한다. 이 보정을 지우면 화면이 **정상 장비 수십 대를
      전부 '인증 실패'** 라 말한다(실측: mock 74대가 403 이었다). 404 도 '무인증 경로가 없는
      제품' 일 수 있어 실패로 단정하지 않는다.
    - ⚠⚠ **'정상' 의 뜻이 종류마다 다르다** — `depth` 가 그것을 말한다: `identity`(제품 확인까지 —
      vCenter `vimServiceVersions.xml`·Redfish 서비스 루트·엣지 ping) / `http` / `tls` / `ssh` /
      `smtp` / `tcp`. `tcp` 를 `identity` 처럼 말하면 거짓이다.
      · ⚠ **선언 깊이를 '확인했다' 고 쓰지 말 것**(v2.553 API·스크린샷 판독에서 발견):
        iDRAC 은 선언이 `identity` 인데 403 을 받으면 정체 대조를 **하지 않는다**. 화면은
        `depthReached()` 로 **도달한 단계에서 되돌린** 깊이를 적고, 선언보다 얕으면 표시한다.
      · ⚠ **실패한 대상의 깊이는 `null`(화면 '—')이다** — `judge().reached` 는 **실패한 단계**를
        가리키므로 그대로 옮기면 TCP 실패가 "포트 열림까지 봤습니다" 가 된다(같은 판독에서 발견).
      · ⚠ 측정 전에는 `(예정)` 을 붙인다 — 선언 깊이를 그냥 적으면 확인했다는 뜻으로 읽힌다.
    - **대상은 등록부 13곳에서 계산한다**(손 등록 금지 — v2.552 와 같은 이유). ⚠⚠ **export 이름이
      바뀌면 조용히 0건이 되게 두지 말 것**: 기대하는 export 이름을 `fnNames` 로 명시하고 하나도
      없으면 던져 `sourceErrors` 로 올린다. 이 규칙을 만들며 **실제로 3곳이 조용히 빠져 있었다** —
      `relaytopo/store.js`(listNodes 없음 → `loadTopology().nodes`) · `gpu/physicalRegistry.js`
      (`listPhysical`) · `upgrade/packageSettings.js`(`getPackageSettings`). 업그레이드 원격 소스의
      필드도 `remoteBase` 다(`remoteBaseUrl` 은 존재하지 않는다 — `config.js:307`).
      `m.listX?.() || []` 형태의 폴백을 만들지 말 것(테스트가 소스에서 금지한다).
    - **해결책은 둘이다**(사용자 선택): ① **설정만 보고**(네트워크 왕복 0) 찾는 발견 —
      스킴 오기재·공백·비밀번호 미저장·계정 공백·포트와 수집방식 어긋남·SSRF 차단 대역·중복 등록·
      평문 웹훅·평문 LDAP·Data Plane `basePath` 변조형(v2.503 S-1)·담당 엣지 미지정
      ② **점검 결과 기반** — 실패 단계별 고정 조치문(`FAIL_KINDS.fix`)·인증서 만료 예고(30일)·
      자체서명 사실·SSH 배너. 판정은 서버(`remedy.js`)가 `code`+근거만 주고 **문장은 웹**이 만든다.
    - ⚠⚠ **조언이 틀리면 무음 실패보다 나쁘다**(v2.525 Horizon 실제 사고): 종류마다 **정답 주소
      형식이 다르다**(`HOST_FORM`) — `url`(엣지·Horizon·웹훅·업그레이드·Data Plane: 스킴 **필수**) /
      `host`(스토리지·SAN·PDU·SSH 류: **주소만**) / `either`(iDRAC 은 스킴을 붙여 저장한다) /
      `ldap`. 표에서 빠진 종류가 있으면 **반대 방향 조언**이 나간다 — 테스트가 전 종류 선언을 고정한다.
    - ⚠ **'중앙 직접 수집'(담당 엣지 없음)을 문제라 하지 않는다** — 정상 구성이므로 `info` 이고,
      중앙에서 닿지 않을 때만 뜻이 생긴다. 엣지 위임 대상은 **중앙 폴러가 아예 점검하지 않는다**
      (닿지 않는 것이 정상인데 '실패' 로 적으면 거짓 — `poller.js` 가 `x.agent && node==='central'` 로 제외).
    - **KPI 다섯 칸은 겹치지 않는다** — `합계 = 정상 + 실패 + 설정문제 + 측정없음 + 비활성`.
      ⚠ 화면에서 **비활성 칸을 빼면 합이 안 맞는다**(v2.553 판독: 82 대상인데 74+5+1+0=80 으로
      보였다). 정상률 분모는 **측정분**이고 0 이면 `null`(0% 가 아니다).
    - ⚠ **화면 문구에 백틱을 쓰지 말 것** — `BoldText` 는 `**강조**` 만 해석하고 백틱은 **글자로
      샌다**(v2.439·2.440·2.505·2.545 실제 사고). v2.553 초판이 백틱을 썼고 자체 검사가 잡았다.
      값 인용은 홑화살괄호 `‘ ’` 로 한다. 테스트가 전 코드의 문구에서 백틱 0 을 고정한다.
    - **인증까지 확인하는 길은 각 설정 화면의 '연결 테스트' 다**(25종의 인증 경로를 새로 만들지
      않는다 — 이미 검증된 코드가 있고 복제하면 판정이 갈라진다). 화면이 그 사실과 딥링크를 준다.
    - ⚠ **TLS SNI 에 IP 를 넣지 않는다**(`checks.js`, v2.553 에 발견): RFC 6066 이 금지하고 Node 가
      `DEP0123` 경고를 내며 **앞으로 무시**한다. 이 현장은 IP 등록이 다수라 매 점검마다 찍혔다.
    - ⚠ **정직 기록 — 확인하지 못한 것**: 무인증 확인 경로 중 **Redfish 서비스 루트·OME
      `/api/ApplicationService/Info`·Horizon 루트·PDU 루트**의 실제 응답을 이 환경에서 받아 보지
      못했다(mock 대상은 이 컨테이너의 에이전트 프록시가 403 으로 응답했다 — 그래서 실측치
      `cert 23일`·`403` 은 **프록시의 것**이고 실장비의 것이 아니다). 못 읽으면 정체 단계가
      **실패**로 떨어지지 정상을 지어내지 않는다. SSH 9종·SMTP·LDAP 의 성공 경로도 실장비로
      확인하지 못했다(닫힌 포트의 `refused` 는 실제 소켓으로 확인). 첫 실점검에서 `확인 깊이` 열과
      해결책 목록을 보고 좁힐 것.
  - ⚠⚠ **iDRAC 텔레메트리는 Datacenter 전용이다 — Enterprise 서버는 '대체 경로' 로 읽고, 그 부하에
    관리자가 동의해야 켜진다**(`bmusage/license.js`·`collectors/idracEnterprise.js`·`parse/racadm.js`
    + `idrac/redfish.js fetchUsageSensors`, v2.554 — 사용자 신고 "idarc 텔레메트리는 data center
    라이선스가 필요한데, 내가 가진건 enterprise 라이선스라서, 엔터프라이즈 라이선스 대상 서버도
    수집하는 기능 추가로 만들어줘". 선택: **idrac api/ssh 를 쓰되 부하를 고지하고 동의를 받는다** ·
    **엣지에서 종합하고 중앙은 조회할 때만 가져온다** · **전력·온도는 수집하지 않는다** ·
    **법인 귀속 없음 원인까지 조사**):
    - ⚠⚠ **'왜 비었나' 를 추측으로 말하지 말 것 — 근거가 이미 우리 손에 있었다.** v2.550~2.551 은
      텔레메트리가 비면 `Datacenter 라이선스가 필요할 수 있습니다` 라고 **추측**했다. 그런데
      `redfish.js:653` 이 `inv.licenses` 를 채워 `idrac/invCache.js` 에 보관하고 있다 —
      **장비 왕복 0회로** 등급을 단정할 수 있었다. 이제 `licenseFromInventory()` 가 캐시를 읽고
      화면이 "이 iDRAC 의 라이선스는 **Enterprise** 입니다" 라고 말한다. v2.493 의 '단정하지 말 것' 은
      **근거가 없을 때**의 규칙이고, 근거가 있으면 **말해야 한다**(등급을 못 읽으면 그대로 '미상').
    - ⚠⚠ **Dell 의 `LicenseType` 은 등급이 아니다** — 그 필드는 `Production`/`Evaluation` 이고
      (`redfish.js:664` 가 `LicenseType || LicensePrimaryStatus` 를 `type` 으로 담는다) 등급은
      `Name`·`LicenseDescription` 쪽에 있다. `type` 만 보면 **전 서버가 '등급 미상'** 이 된다.
      등급은 **가장 높은 것 하나**다(`datacenter > enterprise > express > basic` — 한 iDRAC 에
      Express 와 Enterprise 가 함께 설치될 수 있고 기능은 높은 쪽을 따른다). 만료 항목은 후보에서
      빼고 개수를 밝히되 **'라이선스가 없다' 고 단정하지 않는다**.
    - ⚠⚠ **정상인 장비에 부하를 더하지 않는다**(`enterpriseEligible`): 대체 경로는 **텔레메트리
      결과를 본 뒤** 판정한다. 등급만 보고 걸면 ⓐ 등급 미상 서버가 영영 제외되고 ⓑ 텔레메트리가
      잘 되는 Datacenter 장비에도 SSH·추가 GET 이 붙어 **부하가 두 배**가 된다. 관리자가 동의한
      것은 '텔레메트리로 못 읽는 서버' 에 대한 부하다. **401/403 이면 시도하지 않는다** —
      같은 계정이라 결과가 같고 **iDRAC 계정을 잠근다**(v2.535 규약. 잠기면 전력·온도 수집까지 죽는다).
    - ⚠⚠ **동의 없이는 켜지지 않는다**(`settings.js` `enterpriseEnabled && enterpriseAck` 논리곱 +
      `enterpriseActive()`): 사용자 지시가 "**사용할것이냐고 물어보고 사용하겠다고 하면**" 이었다.
      화면이 부하를 **축소하지 않고** 먼저 말하고(센서 GET 4회 + 필요하면 SSH 세션 1개 · BMC 는
      약한 프로세서다) 관리자가 체크해야 저장된다. 동의는 **누가·언제**를 기록한다.
      이 논리곱을 지우면 지시의 집행부가 사라진다. `idracTelemetry` 를 끄면 함께 돌지 않는다
      (그 설정이 'iDRAC 로 수집할지' 를 정하는 축이다).
    - ⚠⚠ **전력(W)·온도(℃)를 사용률의 대체값으로 수집하지 않는다**(사용자 선택 "수집하지 않는다").
      숫자는 있는데 뜻이 다른 최악의 거짓이 된다 — `idracEnterprise.js` 에서 `fetchPower`·
      `fetchSensors` 를 부르지 말 것(테스트가 소스를 검사해 고정한다).
    - **경로는 둘이고 확인한 것을 먼저 쓴다**: ① 표준 Redfish `Chassis/<id>/Sensors`(텔레메트리가
      **아니다**) ② iDRAC SSH `racadm systemperfstatistics`. `auto` 는 ①로 못 읽은 것만 ②로 채운다.
      ⚠ **정직 기록 — 둘 다 실장비 응답·출력을 본 적이 없다.** 그래서 ① id 를 굳히지 않고 컬렉션을
      **열거해 이름 패턴**으로 찾으며 못 찾으면 `absent` 를 **캐시**하고(6시간) ② 파서는 관용적이고
      못 읽으면 `parsed:false` 이며 **원문(`entRaw`)을 화면이 보여준다**(v2.542 `cliRaw` 규약).
      첫 실수집에서 `usedPaths`·`seenSensors`·원문을 보고 좁힐 것.
    - ⚠ **`racadm` 출력에서 `Last`(현재값)를 `Average`·`Peak` 보다 먼저 쓴다** — 5분 주기 추이에
      하루 평균이나 부팅 이후 최고치를 섞으면 차트가 거짓이 된다. 어느 열을 읽었는지 `usedStat`
      으로 밝히고, 최고치·평균을 읽었으면 화면이 "지금 부하가 아닙니다" 라고 적는다.
      **0~100 밖의 수는 퍼센트가 아니다**(시각·표본 수가 같은 줄에 섞여 온다 — 범위를 벗어난 수를
      사용률로 쓰면 **오류 없이 틀린 값**이다).
    - ⚠⚠ **예산 산수**(v2.528 규약): 세션 예산(45초)은 **폴러의 장비 시한(60초)보다 작아야 한다** —
      같거나 크면 `withDeadline` 이 먼저 던져 모은 결과가 통째로 버려진다. SSH 는 남은 예산이
      `MIN_SSH_SLICE_MS` 아래면 **시작하지 않고 사유를 남긴다**(핸드셰이크만 하고 잘리면 결과가 0).
      **주기당 대수 예산**(`BMUSAGE_ENT_PER_RUN` 기본 40)·**탐색 예산**(기본 10)도 둔다 — 200대에
      무제한으로 붙이면 주기를 넘겨 재진입 가드가 다음 틱을 계속 건너뛴다. 미룬 대수는 화면이 말한다.
    - **인증 정지는 경로마다 다른 이름공간**이다 — OS 는 `<agent>|os|<key>`, iDRAC 은
      `<agent>|idrac|<key>`. 한쪽 정지가 다른쪽을 멈추면 멀쩡한 경로가 죽고, 사용자는 엉뚱한
      비밀번호를 고친다. 정지 목록도 `path` 로 구분해 보고한다.
    - **값은 빈 칸만 채운다** — OS·텔레메트리 값을 덮지 않고 `srcOf`(`idrac-ent`)로 어느 쪽인지
      밝힌다. 측정 방식이 달라 같은 서버에서 값이 다를 수 있다(v2.550 규약의 확장).
    - ⚠⚠ **엣지에서 종합하고 중앙은 조회할 때만 가져온다**(사용자 지시. `bmusage/edgePull.js` +
      `routes/collector.js GET /api/collector/bm-usage` + `central/bmUsageEdgePull.js`):
      v2.549 엣지 로그와 **같은 url·같은 토큰**(`X-Collector-Token`)이라 **새 네트워크 허용이
      필요 없다** — 이 사실이 pull 을 고른 근거이므로 새 포트·새 인증을 도입하지 말 것.
      **상시 push 0**(대부분 볼 일이 없는 화면이다). 중앙 보관분은 **인메모리**이고 진실의 원천은
      각 엣지의 DB 다. ⚠ 실패가 **직전 값을 지우지 않는다**(통째로 덮으면 한 번 실패한 뒤 화면이
      '보관분 없음' 이 되어 방금까지 보던 값이 사라진다 — v2.550.3 H5 규약). ⚠ 수집이 꺼져 있어도
      **200 + `enabled:false`** 로 답한다(중앙이 '안 켰다' 와 '못 읽었다' 를 구분해야 한다).
      ⚠ **저장 키는 중앙이 아는 이름**(등록부 `name`)이고 본문의 `node.agent` 는 믿지 않는다 —
      둘이 다르면 그 사실 자체가 진단이므로 화면이 나란히 보여 준다(v2.548 F5 · v2.549 규약).
      ⚠ 엣지 인출은 **전체 범위 계정만**(엣지는 법인 축으로 나눌 수 없다 — v2.525 규약).
    - **'법인 귀속 없음' 의 원인을 말한다**(`bmusage/attribution.js`, 사용자 지시 "네 — 원인까지
      조사"): 이 현장은 이 사유로 **500대**가 제외돼 표가 통째로 비어 있었다. 원인은
      `insights/fleetInventory.js:60 resolveVc` 가 등록부 `vcenterId` 와 `fleet-assign.json` 을
      **둘 다 비어 있는 채로** 만난 것이고 **버그가 아니라 데이터**다. 사유를 넷으로 나눈다 —
      `registry-no-vc`(등록에 법인이 비었다) / `assign-ghost`(**삭제된 vCenter** 를 가리킨다 —
      그 id 를 보여주는 것이 곧 진단) / `edge-no-vc`(그 법인 포탈에서 지정해야 한다) /
      `no-registry-match`(등록이 없거나 **서비스태그가 비어 키가 안 맞는다** — 둘을 구분할 수 없으므로
      **단정하지 않는다**). ⚠ **자동 귀속을 제안하지 않는다** — 어느 서버가 어느 법인인지 포탈은
      알지 못하고, 틀리게 귀속하면 그 법인의 부하 통계가 거짓이 된다.
      ⚠ 이 목록은 **범위 제한 계정에 주지 않는다**('귀속 없는 데이터 미노출' 불변조건).
  - ⚠⚠ **엣지 워커는 '잴 것이 0건' 이어도 중앙에 상태를 올린다 — 조기 return 은 무음 실패다**
    (v2.554 에 고친 **v2.552 결함**. 사용자 실화면으로 확정):
    - **증상**: 엣지 28곳이 전부 v2.553 으로 올라가 있고 중앙 점검이 10분·3회를 돌았는데
      `엣지 → 중앙 push`·`엣지 → 중앙 설정 pull` 112링크 중 56개가 **전부 `측정 없음 · 첫 보고 대기`**
      였다. 화면은 "기다리면 된다" 고 말했지만 **기다려서 될 일이 아니었다**.
    - **원인**: `agent/linkCheckWorker.js` 가 ① 중앙이 점검을 껐거나 ② **그 엣지가 잴 링크가 0개**
      일 때 **조기 return** 해 중앙으로 **아무것도 보내지 않았다**. 중앙은 '보고가 없다' 밖에 모르고
      `rowState` 는 그것을 `edge-waiting`(= 기다리면 된다)으로 읽었다. 이것은 CLAUDE.md v2.517
      `sendStatusOnly` 규약("엣지는 표본이 0건이어도 상태를 올린다 … 0건이면 push 가 조용히 조기
      반환해 중앙으로 아무것도 가지 않았고 — **그게 바로 신고된 상태다**")을 **그대로 어긴 것**이다.
      **새 엣지 워커를 만들 때 이 규약을 먼저 볼 것.**
    - **고친 것 셋**: ① 0건·꺼짐이어도 `pushReport()` 로 **사유(`note`)와 함께** 보고한다(중앙이
      그 문장을 그대로 화면에 쓴다 — 추측하지 않는다) ② `edgelog/spec.js` 에 **워커 상태를 등재**
      했다(v2.552 가 워커를 만들면서 표에 넣지 않아 **엣지 로그 화면에서도 진단할 길이 없었다** —
      새 엣지 워커는 이 표에 함께 넣을 것) ③ `rowState` 가 **시간을 보고 말을 바꾼다** — 중앙 점검이
      주기의 3배를 넘게 돌았는데도 보고가 없으면 `edge-waiting` 이 아니라 **`edge-silent`** 이고,
      원인 셋(개별 토큰 아님 403 / 잴 링크 0개 / 워커 미동작)과 확인 경로(엣지 로그의
      `linkcheck-worker` 줄)를 적는다. ⚠ `runningSinceTs` 가 없으면(첫 주기 전) **escalate 하지 않는다**
      — 없는 문제를 만들지 않는다.
    - ⚠ **남는 한계(정직 기록)**: 중앙이 **403**(개별 토큰이 아님)으로 거부하면 엣지는 그 보고조차
      올릴 수 없다. `/link-check-config`·`/link-check` 는 **엣지별 개별 토큰 전용**이므로(공유
      `CENTRAL_TOKEN` 은 어느 엣지의 측정인지 신뢰할 수 없다) **공유 토큰만 쓰는 현장에서는 이 기능이
      통째로 동작하지 않는다**. 그 사실을 `edge-silent` 문구가 첫 번째 원인으로 적는다.
  - ⚠⚠ **서버 온도 — 히트맵 보드(시안 B). '못 읽은 값' 을 정상으로도 이상으로도 세지 않는다**
    (`web/src/views/tools/serverTemp/`{board.js·parts.jsx·ServerTempBoard.jsx·useTempSparklines.js} +
    `server/src/routes/api/toolsCapacity.js POST /tools/esxi-temp/spark`, v2.556 —
    핸드오프 `docs/design/server-temp/README.md`(사용자 제공 시안. `*.dc.html` 은 **대조용
    프로토타입이고 복사 대상이 아니다**). 선택: **셸까지 한 번에** · 전체 검증 · 완료 후 릴리스):
    - **계산은 `board.js` 하나가 소유한다**(순수·vitest 30건). 버킷·타일 격자·막대 폭·스파크
      path·집계를 컴포넌트에 흩어 두면 **KPI 의 32℃↑ 개수와 히스토그램 임계선이 다른 기준**을
      쓰게 된다. 임계값도 여기(`TEMP_WARN_C`·`TEMP_HOT_C`)가 소유하고 `shared.jsx` 가 재수출한다
      (반대 방향으로 두면 이 모듈의 테스트가 React·api.js 를 끌고 와 node 환경에서 깨진다).
    - ⚠⚠ **`Number(null) === 0` 을 또 밟았다 — 자체 테스트가 내 결함 2건을 잡았다**(v2.525·
      v2.540·v2.550·v2.552 에 이어 다섯 번째. **v2.561 에 여섯 번째** — 그때는 실제로 틀린 값을 만들고 있었고 판정을 `util/numOrNull.js` 하나로 통합했다): ① `sparkPath` 가 `.map(Number).filter(isFinite)`
      라 **결측 점이 0℃ 로 살아남아** 스파크라인이 바닥으로 떨어졌다 ② `tempBuckets`·`tempCounts`
      가 빈 문자열을 0℃(14℃ 칸)로 읽어 그 서버를 **'정상' 으로 셌다**. `Number([]) === 0` 까지
      걸려 파서를 **타입부터 좁혔다**(`tempNum` — 숫자이거나 숫자 문자열일 때만). 둘 다 오류 없이
      틀린 값이라 화면은 정상처럼 보인다.
    - ⚠⚠ **개수가 0 인 히스토그램 칸을 온도색으로 칠하지 말 것**(스크린샷 판독에서 발견. 수치로는
      안 잡혔다): 시안의 `height: max(2%, …)` 를 그대로 쓰면 빈 칸도 2px 막대가 남는데 40℃ 이상
      구간에서는 그것이 **빨간 선**이 되어, KPI 가 `40℃↑ 0` 이라고 말하는 동시에 분포는 '고온
      서버가 있다' 고 말한다. 0 인 칸은 온도가 아니라 **축 눈금**이므로 중립색 1px 이다.
    - ⚠ **범례를 색으로 설명하지 말 것**(같은 판독에서 발견한 **시안의 내부 불일치**): 시안 §3 은
      법인 비교 범례를 '물리=#fbbf24 / 가상화=#4ade80' 로 적었지만 막대 채움은 `tempColor(평균)`
      이라 30℃ 물리 막대도 초록이다 — 범례가 **거짓**이 된다. 막대 색은 '온도' 를 말하므로 범례는
      **자리(위/아래)** 로 설명한다.
    - ⚠⚠ **`minWidth: 0` 을 지우지 말 것**(400px 실측 628px → 400px): flex/grid 자식의 기본
      `min-width: auto` 때문에 안쪽 표(열 11개·975px)가 카드를 **밀어 늘려** 페이지가 가로로
      넘친다. 자식의 `overflow: auto` 만으로는 부족하다(v2.520 규약을 여기서 다시 밟았다).
    - **표는 `DataTable` 을 쓰고 선택 인자를 더했다**(`rowStyle`·`className`·`bare`·`maxHeight`·
      `limit`+`footer`·`onVisible`). 전부 기본값이 예전 동작이라 기존 181개 표는 회귀 0.
      · ⚠ **`limit` 은 정렬 뒤 자른다** — 호출부에서 먼저 자르면 '전체를 정렬한 상위 N' 이 아니라
        '앞 N 을 정렬한 것' 이 되어 표가 거짓이 된다. 그래서 상한을 컴포넌트가 받는다.
      · ⚠ **`onVisible` 로 보이는 행을 받는다** — 정렬을 DataTable 이 소유하므로 그것 없이는
        '보이는 행' 을 알 수 없다. 밖에서 따로 정렬하면 **정렬을 두 곳이 구현**하게 되고, 열을
        바꿔 정렬한 순간 엉뚱한 행의 24시간 차트를 불러온다.
    - **스파크라인은 계열 이름을 정직하게 붙인다**(`sparkMetricFor` + 응답 `metricByKey`):
      iDRAC 장기 이력은 기본 설정에서 **서버당 1계열(`idractemp_max`)** 만 적재되고 흡기 계열은
      `IDRAC_TEMP_SERIES_DETAIL=true` 일 때만 있다(v2.504). 그런데 표의 '현재온도' 는 **흡기**다 —
      표와 차트가 **다른 계열일 수 있다**는 사실을 툴팁이 말한다. 한 문구로 덮지 말 것.
      모르는 출처는 **null**(엉뚱한 계열을 추측해 주지 않는다).
    - **`/tools/esxi-temp/spark` 규약**: 범위 강제는 **존재 은닉**(범위 밖 키는 조회하지 않고
      `series[key]=null`·200) · 상한(`maxItems`)을 **응답에 실어** 화면이 배치 크기를 맞춘다
      (숫자 하드코딩 금지 — `sparkBatch.js`) · 상한을 넘기면 `capped` 로 **밝힌다** · DB 실패는
      **그 키만 null**(응답 전체를 500 으로 만들지 않는다) · 점 2개 미만은 null(한 점을 선으로
      만들면 추세가 있는 것처럼 보인다) · mock 은 `synthesized`. 출처는 **우리 시계열 DB** 라
      vCenter 왕복이 0 이다(순차 배치의 이유는 SOAP 이 아니라 응답 크기·DB 조회 횟수).
    - **법인 그룹 키는 서버 조립 규칙과 글자 그대로 같아야 한다**(`dcKeyOf` =
      `datacenterId || vcenterId || '(미분류)'`). 다르면 비교 목록의 임계 개수와 히트맵 그룹이
      **서로 다른 집합**을 세면서도 오류가 나지 않는다.
    - **히트맵 타일에 애니메이션을 걸지 말 것** — 맥동은 범례 사각 하나만(`hotglow`). 타일 수백
      개에 걸면 GPU 낭비다. 타일은 그룹당 `<svg>` 하나 + `<rect>` 마다 `<title>`(1,157개 실측 문제없음).
    - `EsxiTemp` **래퍼 이름을 바꾸지 말 것** — 도구 키 `esxitemp` 는 `permissions.json`(사용자별
      허용/거부)의 값이자 `auth/toolAccess.js` 의 집행 매핑이다(v2.508 규약).
  - ⚠⚠ **상단 메뉴 2단화 — 탭 규칙은 `.topbar .tabs .tab` 으로 한정한다**(v2.556, 같은 핸드오프 §0):
    `className="tab"` 은 앱 **전역에서 일반 버튼**으로도 쓰인다(접속확인·필터 초기화·CSV 선택·
    집계 단위 … 수십 곳). 전역 `.tab` 을 밑줄 스타일로 바꾸면 그 버튼들이 전부 테두리 없는 글자가
    된다. Chromium 으로 확인했고(전역 `.tab`: radius 8px·active 파란 채움 / 헤더 탭: radius 0·청록
    밑줄) `web/src/shellStyles.test.js` 가 CSS 소스로 그 계약을 고정한다(주석을 먼저 제거해 검사).
    · **브랜드 행의 `flex-wrap: wrap`** 이 좁은 폭 가로 넘침의 해법이다 — 이 셸은 v2.555 까지
      400px 에서 **628px** 로 넘쳤고(원인: `status-pill`·`user-box`) 2단화로 0 이 됐다.
    · 상태 칩 내용·사용자 메뉴 동작은 **그대로 두고 톤만** 바꿨다(모노·자간·배경). 하단 상태바도
      칸 개수·내용은 그대로다.
  - ⚠⚠ **1600px 이상에서만 상단 메뉴를 브랜드행 한 줄에 합친다 — 임의 폭에서 합치면 메뉴가
    잘린다**(v2.572, 사용자가 캡처와 함께 "빨간색으로 표시된 부분에 있는 메뉴를 노란색 부분으로
    이동해줘, 버전명/메뉴/로그인 사용자가 1줄로 깔끔하게 보이게 해줘" 요청 — v2.556 의 2행 레이아웃
    에서 행1(로고~버전~여백)과 행2(메뉴 13개) 사이 빈 공간을 메우는 것):
    - **`<nav className="tabs">` 는 이제 JSX 상 `.tb-brandrow` 의 자식이다**(`App.jsx`) — 예전에는
      brandrow 뒤의 형제 블록(행2)이었다. 시각적 순서는 CSS `order` 로만 정한다(마크업 순서와 무관).
    - ⚠⚠ **`flex-wrap: wrap` 은 줄바꿈 여부를 '줄어든 뒤 크기' 가 아니라 각 아이템의 hypothetical
      size(= flex-shrink 적용 전의 flex-basis)로 판단한다.** `.topbar .tabs` 에 `flex:1 1 auto` 를
      주면 `min-width:0` 로 줄어들 수 있는데도 **줄어들기 전 전체 콘텐츠 폭**이 줄맞춤 판정에 쓰여
      옆 칸(user-box)이 다음 줄로 밀려난다(1440px 실측 — 메뉴는 줄어들 수 있었는데 옆 칸이
      튕겨나갔다). **`flex: 1 1 0%`**(flex-basis 0%)로 hypothetical size 를 0 으로 만들어야
      한 줄에 남는다 — `auto` 로 되돌리지 말 것.
    - ⚠⚠ **미디어쿼리는 특정도를 올리지 않는다 — 특정도가 같으면 소스에서 나중 규칙이 이긴다**
      (조건이 참이어도). `.topbar .tabs {...}` 미디어쿼리 블록을 그 선택자의 **기본 규칙보다 앞에**
      두면(v2.572 초판의 실제 결함) 1600px·1920px 에서도 기본 규칙에 덮여 메뉴·사용자칩이 여전히
      다른 줄로 떨어졌다(실측으로 확정). 미디어쿼리는 그 선택자를 건드리는 **모든 기본 규칙 뒤에**
      배치할 것.
    - **1600px 미만(1440px·400px 포함)은 v2.556 그대로 2행**이다 — `.topbar .tabs { flex:1 1 100%; }`
      가 기본값으로 메뉴를 독립된 줄로 떨어뜨린다. **경계는 추측이 아니라 실측**이다 — 2400px
      뷰포트(축소·확장 왜곡이 없는 폭)에서 로고 206.8px + 탭 13개 실제 콘텐츠폭 985.39px +
      상태칩 123.3px + 사용자칩 164.0px + gap(14px×3) + padding(20px×2) = **1561.55px**. 1440px
      에서 강제로 한 줄에 넣으면 `nav.scrollWidth(985) > nav.clientWidth(864)` 로 탭 2개
      ('인사이트'·'설정')가 **스크롤 없이 안 보이게 잘린다** — 그래서 40px 여유를 둔 1600px 를
      썼다. 이 숫자보다 낮춰 되돌리지 말 것(재측정 없이 낮추면 같은 클리핑이 재발한다).
    - **narrow-width 회귀 없음**: A/B 로 확정 — 변경 전 커밋으로 되돌려 400px 헤더를 재빌드해
      스크린샷을 비교하면 **바이트 단위로 동일한 3줄 패턴**(브랜드+상태칩 1줄, 사용자칩 2줄, 메뉴
      3줄+가로스크롤)이었다. `.tb-brandrow` 의 `flex-wrap: wrap`(v2.556 의 400px 안전망)은 손대지
      않았다 — 1600px 미만에서는 이 안전망이 그대로 작동한다.
    - `shellStyles.test.js` 의 기존 7개 계약(탭 선택자 범위·전역 `.tab` 스타일·brandrow
      flex-wrap·`.topbar .tabs` overflow-x:auto 등)은 전부 무수정으로 통과 — 이번 변경은 이
      계약들과 독립적인 **폭 조건부 순서 재배치**다.

  - ⚠⚠ **역할별 ‘도구별 접근’ 표는 특수기능 카탈로그 전체를 쓴다 — 여기에 필터를 붙이지 말 것**
    (`web/src/views/userAdmin/userToolText.js roleToolRows` + `UserAdmin.jsx:11`, v2.573 —
    사용자 지시 "특수기능이 추가되면 자동으로 권한설정 하는 기능에 추가되게 해줘"):
    - **증상**: v2.572 까지 `const TOOL_ROWS = SPECIAL_TOOLS.filter((t) => !t.adminOnly)` 라
      카탈로그 **86개 중 61개만** 표에 나왔다. 빠진 25개는 대부분 **최근에 추가된 기능**
      (통신 점검 v2.552 · 포탈 점검 v2.560 · 엣지 로그 v2.549 · 파트 장애 v2.547 · 스토리지
      증가량 v2.531 …)이라 — **기능을 더할수록 권한 화면이 조용히 뒤처졌다**.
    - ⚠⚠ **그 필터는 틀린 전제 위에 있었다.** `adminOnly` 는 카드 표시 관례이고 접근제어가
      아니다 — v2.555 가 **사용자별 모달에서 이미 확인해 기록해 둔 사실**인데(아래 항목)
      역할 표에는 적용하지 않았다. 실측: `/api/tools/pdu` 의 조회는 `routes/api/pdu.js:52`
      에서 `requirePerm('tools') + fullScopeOnly` 이고 `/api/tools/storage` 도 같다 — operator 가
      주소로 직접 열 수 있는데 **그 도구가 표에 없으니 관리자는 끌 방법 자체가 없었다**.
      빠진 25개 중 **16개가 서버 집행 대상**(`enforcedToolKeys()`)이었다.
    - **고친 방식**: 필터를 없애고 `roleToolRows(catalog)` 하나가 '거르지 않는다' 를 선언한다
      (키 없는 행만 뺀다 — 표에 그릴 수 없다). adminOnly 행에는 사용자별 모달과 **같은 상수**
      (`ADMIN_MARK_LABEL`·`ADMIN_MARK_TITLE_ROLE`/`_USER`)로 ‘관리자 표시’ 배지를 단다.
      ⚠ 두 화면의 **뜻이 반대**라 title 은 따로 둔다 — 모달은 '고르면 보인다', 역할 표는
      '끄면 막힌다'. 한 문구로 덮으면 반대 방향 안내가 된다(테스트가 두 값이 다름을 고정).
    - ⚠ **머리말도 함께 고쳐야 한다** — 예전 문구는 "관리자 전용 도구는 목록에서 제외됩니다"
      였다. 제외를 없애고 문장을 남기면 **화면이 거짓말을 한다**(테스트가 ‘제외’ 0 을 고정).
    - **회귀는 소스까지 검사한다**(`userToolText.test.js`): ① `roleToolRows(SPECIAL_TOOLS)` 가
      실제 카탈로그와 **개수·순서 모두 일치** ② `UserAdmin.jsx` 에 `SPECIAL_TOOLS.filter`·
      `TOOL_ROWS.filter` 가 **0건** ③ 라벨 문자열을 JSX 에 다시 적지 않았는지. 변이 검증 —
      필터를 되살리면 ②가 실패한다(실측 1 failed / 12 passed).
    - ⚠ **나머지 등록처는 이미 자동이거나 테스트가 막고 있다**(v2.573 에 전수 확인):
      사용자별 모달(`SPECIAL_TOOLS` 직접) · `version_4/tree.js` 배치(미배치 0, `tree.test.js`) ·
      서버 집행 커버리지(`audit2506.test.js:282` 가 `specialToolsList.js` 를 **정규식으로 읽어**
      미선언 0 을 고정 — 새 도구를 매핑도 선언도 없이 추가하면 CI 가 깨진다). 즉 **남은
      수동 작업은 `auth/toolAccess.js` 에 경로를 매핑하거나 사유를 선언하는 것 하나**이고,
      그것은 경로를 사람이 확인해야 하므로 자동화 대상이 아니다(잘못 매핑하면 **엉뚱한 화면이
      막힌다** — v2.506 `capacity-forecast` 사고).
    - ⚠ **화면이 갑자기 '권한이 열린 것처럼' 보인다** — 새로 나온 25행의 operator·viewer 가
      전부 체크돼 있기 때문이다. 이것은 **바뀐 것이 아니라 원래 그랬던 사실이 보이게 된 것**
      이다(서버 동작은 한 줄도 바꾸지 않았다). 머리말이 그 사실을 말한다.

  - ⚠⚠ **사용자별 특수기능 권한 — '허용 목록' 은 거부 목록과 반대 방향의 성질을 가진다**
    (`auth/permissions.js effectiveToolAccess`·`auth/toolAccess.js issueFor` + 웹
    `views/toolVisibility.js`·`views/userAdmin/userToolText.js`, v2.555 — 사용자 요청 "특정 사용자는
    특수기능의 특정 기능만 사용할 수 있고, 나머지 기능은 보여주지 않고 싶다 · 스토리지 엔지니어에게
    스토리지 메뉴만". 선택: **허용 목록 모드 추가**(기존 거부 목록 유지) · **사용자 단위** ·
    **아예 숨긴다** · **사용자 관리 화면 안에 확장** · 전진 검증):
    - ⚠⚠ **판정은 `effectiveToolAccess` 하나가 소유한다.** 이 값을 쓰는 곳이 셋이다 — ① 서버 집행
      (`toolGate`) ② 로그인·`/auth/me` 응답(웹 숨김의 근거) ③ 관리 화면. 세 곳이 각자 `mode==='allow'`
      를 해석하면 **화면은 숨겼는데 API 는 열려 있는** 상태가 된다. 그것이 v2.536 이 기록한 사고
      (프론트 탭 조건만 있고 서버 집행이 없었다 — 그건 접근제어가 아니라 '메뉴 숨김' 이다)다.
      `routes/auth.js` 는 두 응답에 **같은 헬퍼(`toolFields`)** 를 쓴다 — 테스트가 그 사실을 고정한다.
    - ⚠⚠ **허용 목록은 '앞으로 추가되는 도구' 도 차단한다**(거부 기본값). 거부 목록은 새 도구를
      자동으로 **허용**하므로 방향이 반대다. 그래서 화면이 그 성질을 문구로 먼저 말한다.
      **`allowed` 가 배열이면 그것이 전부다** — 웹 `toolAllowed` 가 `toolsDenied` 만 보던 판정으로
      되돌아가면 허용 목록이 **화면에서 통째로 무시**되어 숨겨야 할 메뉴가 그대로 보인다.
    - ⚠⚠ **`allow` + 빈 목록을 버리지 말 것.** "이 계정에 특수기능을 하나도 주지 않는다" 는 정당한
      설정이고, 버리면 그 의도가 조용히 **'제한 없음'** 으로 되돌아간다(이 기능 최악의 거짓).
      반대로 `deny` + 빈 목록은 아무것도 막지 않으므로 '재정의 없음' 과 같다 → 저장하지 않는다.
      ⚠ 의존성 키를 `tools.join(',')` 으로 만들지 말 것 — 빈 배열과 `null` 이 **둘 다 빈 문자열**이
      되어 전면 차단 설정이 '재정의 없음' 으로 읽힌다(웹 3곳은 `JSON.stringify` 를 쓴다).
    - **허용 목록은 역할 거부와 합치지 않는다**(교집합 금지) — 관리자가 "이 사람은 이것만" 이라고
      명시한 것이므로 교집합을 내면 **관리자가 준 것이 조용히 사라진다**. 대신 상위 게이트인
      `tools` 기능 권한은 **여전히 필요**하고, 그 조합(권한 없음 + 허용 목록 있음)을 모달이 경고한다.
    - **`off`(재정의 없음)는 저장하지 않는다** — false 를 쌓으면 '한 번 건드린 사용자' 와 '건드리지
      않은 사용자' 를 구분할 수 없다. **admin 은 재정의 대상이 아니다**(관리자 잠김 방지) — 라우트가
      400 + 사유로 거절한다(조용히 무시하면 관리자가 적용된 줄 안다). 없는 계정에도 저장하지 않는다
      (파일에만 남은 유령 항목이 나중에 같은 이름의 계정에 뜻하지 않은 제한을 건다).
    - ⚠ **`SCHEMA_VERSION` 은 올리지 않는다** — 이것은 **권한 키 추가가 아니다**. 파일에 `users` 가
      없으면 `{}` = '재정의 없음' = 기존 동작이라 **조용한 거부가 생길 수 없다**(버전 마이그레이션은
      '행이 곧 부여 목록' 인 권한 키에만 필요하다 — v2.506 규약).
    - ⚠⚠ **숨김/회색 잠금은 축으로 나눈다**(`views/toolVisibility.js toolHidden` 하나가 판정):
      **허용 목록 모드 → 숨긴다**(사용자가 그것을 요청했다) · **거부 목록 모드 → 기존대로 회색 잠금**
      (`SpecialTools.jsx` 주석이 "항목이 많아 숨김보다 회색 잠금이 낫다" 고 적고 있다 — 기존 현장
      화면이 바뀌면 안 된다). **카드 그리드·V4 내비 트리·⌘K 팔레트 셋이 같은 함수를 쓴다** — 한 곳만
      고치면 "내비에는 없는데 팔레트로는 열린다" 가 된다. `visibleTree` 는 `toolShown` 을 주지 않으면
      예전 규칙을 그대로 쓴다(구버전 호출·테스트 호환).
    - ⚠ **`adminOnly` 플래그는 표시 관례이고 접근제어가 아니다**(`specialToolsList.js`). 사용자 예시인
      스토리지 모니터링이 실제로 그렇다 — 조회 라우트는 `requirePerm('tools') + fullScopeOnly` 라
      operator 는 **이미 API 로 읽을 수 있는데 카드만 감춰져** 있었고(실측: viewer 토큰으로
      `/api/tools/storage` 200), 그 플래그 때문에 "스토리지 엔지니어에게 스토리지만" 이 **성립하지
      않았다**. 그래서 관리자가 **명시적으로 허용한** 도구는 그 관례를 넘어 보여 준다
      (`api.js toolExplicitlyAllowed`). **서버 권한은 무엇도 넓히지 않는다** — 조회에 admin 이 필요한
      도구는 열어도 403 이고, 모달이 그 사실을 미리 적는다(무음 실패 금지).
    - ⚠ **허용 목록 모드에서 '회색 카드는 클릭할 수 없습니다' 안내를 쓰지 말 것** — 숨겨서 회색 카드가
      **하나도 없으므로** 그 문구가 거짓이 된다(v2.555 Chromium 판독에서 발견. 수치로는 안 잡혔다).
      판정·문구는 `toolVisibility.gridIntro` 가 소유하고, 허용 0개면 '없습니다 + 조치' 를 말한다.
    - **403 응답에 `toolMode` 를 싣는다** — '역할이 막았다'(deny)와 '허용 목록에 없다'(allow)는
      사용자가 관리자에게 요청할 내용이 다르다. ⚠ 사유 문구에서 **도구 키에 조사(은/는·이/가)를 붙이지
      말 것** — 키가 영문이라 받침 유무를 알 수 없다(괄호 뒤에 붙인다).
    - ⚠ 서버가 막을 수 있는 도구는 `/api/tools/*` 중 **매핑된 경로**뿐이다(v2.506 `toolEnforcement`).
      허용 목록 모드에서는 **'고르지 않은 전부'** 가 차단 대상이므로 그 기준으로 공백을 세어 모달이
      개수를 밝힌다(`enforcementGapNote`). 판정은 `toolEnforcementText.enforcementOf` 하나가 소유한다.
    - 회귀는 `server/test/userTools2555.test.js` 가 **실제 `api` 라우터를 express 에 마운트해
      상태코드로** 고정한다(소스 grep 이 아니다 — v2.506 이 그 실수를 했다) + 웹
      `toolVisibility.test.js`·`userToolText.test.js`.
    - ⚠ **정직 기록 — 실측으로 확인한 것과 못 한 것**: 목 서버(인증 켬)에 viewer 계정 2개를 만들어
      **실제로 로그인해** 확인했다 — 허용 계정은 카드 **2장**(스토리지 2종)만 보이고, 재정의가 없는
      계정은 **83장** 그대로이며, `/api/tools/{ipam,hardware,gpu}` 는 403 · `/api/tools/storage`·
      `storage-growth` 는 200 이었다. 400px 가로 넘침(584px)은 **두 계정이 동일**하고 원인이 기존 셸
      헤더(`status-pill`·`user-box`)라 **이 변경과 무관**하다(A/B 확인). 실제 운영 계정·AD 계정으로는
      확인하지 못했다.

  - ⚠⚠ **express 4 는 async 핸들러의 throw 를 잡지 않는다 — 라우터를 `wrapAsyncRouter` 로 감싼다**
    (`util/asyncRoute.js`, v2.574 — 감사 BUG-01·02·03. 회귀는 `test/asyncHang2574.test.js`):
    - **증상은 500 이 아니라 '무응답' 이다.** 동기 throw 는 전역 핸들러가 500 을 주지만 async
      reject 는 **아무도 응답하지 않아** 그 요청이 클라이언트가 끊을 때까지 매달리고 **소켓 fd 를
      잡는다**. `index.js:10` 의 `unhandledRejection` 은 로그만 남기고 계속 실행하므로 프로세스는
      죽지 않는다 — **그래서 더 안 보인다**. 스윕: `routes/` 의 async 라우트 **284건 중 138건**이 무보호였다.
    - ⚠⚠ **래퍼는 핸들러를 `동기로` 부른다.** `Promise.resolve().then(() => handler(...))` 로 감싸면
      실행이 마이크로태스크로 밀려, **라우터 스택에서 핸들러를 꺼내 동기로 부르고 바로 단언하는**
      하니스가 깨진다(`test/collectorDiag2437.test.js:23` — v2.574 초판이 6통과 → 3실패로 만들었다).
      동기 throw 는 express 가 이미 잡으므로 미룰 이유도 없다. 되돌리지 말 것.
    - ⚠ **`use` 는 감싸지 않는다** — `use` 로 마운트되는 **하위 라우터**(그 자체가 `(req,res,next)`
      함수다)를 감싸면 라우터 속성이 사라진 평범한 함수가 되어 마운트가 깨진다.
      4-인자 에러 핸들러도 감싸지 않는다(인자 3개가 되면 express 가 에러 핸들러로 인식하지 못한다).
    - ⚠ **`next(err)` 로 보낸다 — 래퍼가 직접 응답하지 않는다.** 전역 핸들러가 이미 스택 은닉·
      `pushLog`·`headersSent` 를 처리한다. 두 곳이 그 판정을 갖게 하지 말 것.
    - 회귀 테스트가 ① 라우터 14개가 전부 감싸졌는지 ② **감싸기가 라우트 등록보다 앞인지**(뒤면 그
      앞 라우트는 보호되지 않는다) 를 소스로 고정한다. **새 라우터를 만들면 선언 직후에 부를 것.**
    - ⚠ **SQL 에 값을 보간하는 곳은 그 값을 먼저 좁힐 것**: `pdu/db.js rangeOf` 가 `hours`/`to` 를
      클램프하지 않아 `bucketMs` 가 `Infinity` 가 됐고 그것이 `(ts/${bucketMs})` 로 들어가
      SQLite 가 **식별자로 파싱**(`no such column: Infinity`)했다. 실측 `?hours=1e400` →
      **`000 / 8.002s`(무응답)**, 매달린 요청 40개에 fd **111 → 151**. 형제 `sanswitch/perfDb.js` 는
      라우트에서 `Math.min(24*90, …)` 로 클램프해 같은 결함을 피하고 있었다 — PDU 에만 없었다.
      클램프는 **라우트가 아니라 헬퍼**(`rangeOf`)에 둔다(새 시계열 라우트가 자동으로 보호되게).

  - ⚠⚠ **범위(scope)는 '형제 라우트가 하고 있는가' 로 점검한다 — 한 파일에서 하나만 빠지면 실수다**
    (v2.574 감사 SEC-01~08. 회귀는 `test/scopeLeak2574.test.js` — **실제 라우터를 띄워 응답으로** 본다):
    - **SEC-01 유출 실증**: `routes/api/checksLogs.js:113` 이 `(_req, res)` 였다(사용자를 아예 보지
      않는다는 뜻이다). 범위 계정 응답이 **admin 응답과 바이트 단위로 동일**했다. 같은 파일의
      형제(`:78`·`vmware-config`)는 둘 다 `allowed.has(reqVc)` 로 거르고 있었다.
    - ⚠⚠ **`scopedVcenterIds()` 는 `Set` 또는 `null` 을 돌려준다.** `allowed.includes(...)` 는
      **TypeError** 이고, 그 라우트가 async 면 위 항목과 겹쳐 **응답 없이 매달린다**.
      전체 범위 계정은 `allowed === null` 이라 `&&` 에서 단락돼 **아무도 못 느낀다** — 그래서 오래 남는다.
      저장소 전수 `allowed.has(` 110곳 vs `allowed.includes(` 1곳(`bmUsage.js:124`)이었다.
      ⚠ 스윕을 `allowed.includes(` 로 넓게 잡으면 **오탐**이다 — 같은 이름의 무관한 배열이 둘 있다
      (`auth/permissions.js:322`·`svcmon/store.js:152`). `allowed = scopedVcenterIds(` 인 파일만 본다.
    - ⚠ **같은 객체 리터럴 안에서 일부 필드만 거르지 말 것**(v2.550.3 재발): `bmUsage.js` 가
      `counts`·`skippedCounts` 는 막고 옆의 `settings.corps`·`authStops` 는 무필터였다.
      `vmSeries.js` 도 `vcenters`·`usage`·`resolved` 는 거르고 옆 `status:` 가 우회했다.
    - **뺀 것은 반드시 밝힌다** — `omittedOutOfScope`·`scoped`·`corpsHidden`·`addressHidden`.
      조용히 빼면 화면이 '전부 봤다' 는 거짓을 말한다(v2.509 규약).
    - ⚠ **엣지 주소를 여는 라우트를 403 으로 막기 전에 그 화면이 누구 것인지 볼 것**:
      `/api/ping/edge/overview` 는 권한 게이트조차 없었지만(viewer 도달) 그 응답은 **메인 내비
      '네트워크 › 체크'** 가 쓴다. 403 으로 막으면 operator 의 정상 업무가 깨지므로 **주소만 가렸다**
      (v2.500 D/M1 relaycheck 이 택한 방식). adminOnly 로 올리는 것은 별건이다.
    - ⚠ **공개 API 선언(`publicapi/allowlist.js`)과 내부 라우트의 `fullScopeOnly` 를 대조할 것**:
      `/faults/parts` 는 `requiresFullScope` 가 빠져 **같은 데이터가 세션 경로에서는 403 인데 키
      경로로는 전량** 나갔다. 그 플래그는 손으로 붙이는 것이라 전 카탈로그에서 2곳뿐이었다.

  - ⚠⚠ **테스트의 `stripComments` 정규식 2줄 판본은 틀렸다 — `test/_stripComments.js` 를 쓸 것**
    (v2.574): `s.replace(<블록주석>, '').replace(<줄주석>, '')` 형태는 **줄 주석 안에 슬래시+별
    조합이 있으면**(이 저장소 실제 사례: `agent/configPush.js:34` 의 `// … (*.json/*.env) …`)
    블록 주석 규칙이 **거기서부터 다음 종료 기호까지 코드를 통째로 지운다**. 실측: 그 파일의
    `catch` 5개가 **전부 사라져**(스트립 후 0개) 새 스윕이 멀쩡한 코드를 '무음 실패' 로 오판했다.
    순서를 뒤집어도 블록 주석 안의 `//` 로 같은 문제가 난다 → **상태 기계**가 정답이다.
    · ⚠ 코어는 **개행만 남기고 나머지 주석 문자는 지운다**. 공백으로 채우면 기존 스윕들의
      **거리 창**(`설정: {[\s\S]{0,200}키`)을 넘겨 멀쩡한 코드를 누락으로 오판한다
      (v2.574 에 `linkCheck2552` 가 실제로 그렇게 깨졌다).
    · ⚠ **JSDoc 안에 블록주석 종료 기호를 쓰지 말 것** — 이 세션에서 **세 번** 밟았다
      (`_stripComments.js` 자신의 머리말 · `edgeSweep2574.test.js` 의 대상 설명 ·
      `storage/db.js` 의 SQL 주석 백틱). 그 자리에서 리터럴·주석이 끊긴다.

  - ⚠ **새 엣지 워커·폴러는 `edgelog/spec.js` 에 자동으로 등재되지 않는다 — 스윕이 고정한다**
    (v2.574 IMP-06·07, `test/edgeSweep2574.test.js`): CLAUDE.md 가 v2.554·v2.560·v2.561 에 **세 번**
    같은 경고를 적었는데도 v2.573 시점에 **13개가 빠져 있었다**(표 41 → 54). 기존 테스트가
    `length >= 20` 만 봤기 때문이다 — **그런 검사는 '추가를 잊은 것' 을 절대 잡지 못한다.**
    이제 소스를 훑어 `*Status()` 를 export 하는 워커·폴러가 전부 표에 있는지 본다(의도적 제외는
    사유와 함께 `EXCLUDED` 에 적는다). 그리고 push/pull 진입 함수를 **실제로 호출한다**(v2.566 TDZ
    교훈 — 순수 헬퍼만 고정하는 테스트는 그 종류를 통과시킨다).
    · 함께 고친 무음 실패: `pingWorker`·`captureWorker`·`bmstorWorker` 가 `catch { return null; }`
      하나로 끝나 **4~10초마다 조용히 실패**하고 있었다(v2.561 이 이름까지 적어 뒀다).

  - ⚠ **STARTTLS 는 '광고하지 않으면 평문으로 내려간다' 가 기본값이었다**(`util/smtp.js`, v2.574 SEC-10):
    조건이 `… && ehloCaps(ehlo).has('STARTTLS')` 하나라, 서버가 그 한 줄을 광고하지 않으면
    블록을 건너뛰고 **`AUTH PLAIN <base64>` 로 내려갔다**(base64 는 암호화가 아니다). 중간자가
    EHLO 응답에서 그 줄만 지우면 자격증명이 평문으로 나간다. 이제 **자격증명이 있으면 중단**하고
    (실증: AUTH 미전송), **없으면 진행**한다(사내 릴레이의 정상 구성 — 막으면 멀쩡한 현장이 깨진다).
    관리자가 체크를 끈 경우는 진행하되 추적 로그에 **평문 전송 사실을 적는다**.
  - ⚠ **`new Agent(` 스윕은 'Agent 를 안 쓰는 경로' 를 못 본다**(v2.574 SEC-09):
    `svcmon/checker.js:113` 이 `...(test.insecure ? { dispatcher } : {})` 라 **기본(TLS 검증) 경로는
    전역 `fetch`** 로 나갔다 — CLAUDE.md v2.506 이 직접 경고한 "`globalThis.fetch` 에는 lookup 이
    없다" 가 그대로였다. 실증 기준(v2.537)으로 측정: dispatcher 있음 `ESSRFBLOCKED` / 없음
    **`ECONNREFUSED`(연결이 실제로 시도됐다)**. **두 갈래 모두에 dispatcher 를 줄 것.**
  - ⚠ **`resilientFetch` 는 리다이렉트를 직접 따라가며 출처가 바뀌면 비밀 헤더를 뗀다**(v2.574 SEC-14):
    fetch 기본값 `redirect:'follow'` 는 교차 출처에서 `Authorization`·`Cookie` 만 뗀다 —
    이 저장소가 쓰는 **`X-Collector-Token`·`X-Central-Token` 같은 커스텀 헤더는 그대로 따라간다**.
    엣지가 `302 Location: https://공격자/` 한 줄만 돌려주면 중앙이 그 토큰을 보낸다.
    ⚠ `redirect:'manual'` 로 통째로 막지 말 것 — GitHub 릴리스 자산이 실제로 리다이렉트되므로
    **자동 업그레이드가 깨진다**. 뗀 헤더는 `__secretsDroppedOnRedirect` 로 밝힌다.

  - ⚠⚠ **'읽지 못한 수치' 를 0 으로 둔갑시키지 않는다 — 판정은 `util/numOrNull.js` 하나다**
    (v2.561 — 사용자 요청 "버그 찾아서 수정". **여섯 번째 재발**이고 이번엔 실제로 틀린 값을 만들고
    있었다. 회귀는 `test/numOrNull2561.test.js`):
    - ⚠⚠ **확정 결함 — 스토리지 용량 적재가 `usedBytes: null` 을 `0` 으로 저장했다**
      (`storage/db.js saveCapacityPoint`). 원인은 `Number(null) === 0` 이고 `Number.isFinite(0)` 이
      참이라 `Number.isFinite(Number(v)) ? Number(v) : null` 형태가 **null 을 0 으로** 바꾼 것이다.
      · **도달 경로**(코드로 확인): `unitySsh.js:163` 은 풀 목록을 못 읽고 `general/system show` 만
        성공하면 `{ totalBytes: <읽음>, usedBytes: sys.usedBytes ?? null }` 을 **정직하게** 내보내고
        (`parseSystemSpace` 는 'Total space' 만 있어도 레코드를 준다), `capacityPointEligible` 은
        **전체 용량만** 검사한다 — 그래서 sink 가 정직해야 했다.
      · **A/B 실측**(정상 7일 + 그 한 주기만 null): 사용량 `0.00T`(실제 27.60T) · 사용률 `0%` ·
        남은 용량 `117.54T`(**27.6T 과다** — 없는 공간에 LUN 을 만들게 된다) ·
        증가량[1d] **`-27.60T`**(하루에 27.6TB 가 줄었다는 거짓 급변).
      · ⚠ **가장 나쁜 것**: `growth.js:206 unknownUsed` 가 **0** 이 되어, 화면이 이미 갖고 있던
        정직 안내 — `StorageGrowthTool.jsx:149` 의 "**사용량을 읽지 못한 장비 N대**가 합계에서
        빠졌습니다 — 0 으로 채우지 않았습니다" — 가 **무력화됐다**. 즉 화면은 '0 으로 채우지
        않았다' 고 약속하면서 0 을 보여주고 있었다. **정직 장치를 무력화하는 강제변환이 가장 위험하다.**
    - **같은 헬퍼가 13벌 복사돼 있었고 7벌이 틀린 형태였다** — `util/numOrNull.js` 하나로 통합했다
      (CLAUDE.md '코어는 하나다'). 타입부터 좁혀 `Number([]) === 0`·`Number([5]) === 5`·
      `Number(true) === 1`·공백만인 문자열까지 막는다(v2.556 규약의 확장).
    - ⚠ **'0 이 정답인 카운터' 에 쓰지 말 것.** 보고가 없을 때 0 이 맞는 값(`central/svcmonEdge.js`
      의 `items`·`reported`, `curuser/aggregate.js`, `edgelog/collect.js`, `tools/diskTrend.js`)은
      의도적으로 `: 0` 이고 이 함수를 쓰지 않는다. 이 함수는 **측정값 전용**이다.
    - ⚠ **없는 결함을 만들어 고치지 말 것**(v2.550.3 규약). 스윕이 잡은 후보 중 셋은 **실행으로
      도달 불가를 확인**해 그대로 뒀고 `REVIEWED_SAFE` 에 근거와 함께 선언했다 —
      `storage/db.js` 의 보존일 2곳(`loadGrowthSettings()` 가 명시적 null 을 기본값으로 막는다.
      손상 설정 파일로 돌려 확인. ⚠ 여기서 0 이 되면 `0 ?? 기본값 === 0` 이라 **전량 삭제**이므로
      경로가 열리면 즉시 고칠 것) · `growth.js` 의 `asOfDay`(호출부가 항상
      `dayIndex(Date.now())`). **여기에 줄을 더할 때는 실행으로 확인한 근거를 함께 적을 것.**
  - ⚠⚠ **엣지 로그 연합 조회가 조용히 실패하면 화면이 영원히 '대기 중' 이다**(v2.561 —
    `agent/logQueryWorker.js`. v2.549 가 `edgeLogWorker` 에만 적용한 규약을 여기에도):
    - v2.560 까지 결과 POST 를 `.catch(() => {})` 로 삼키고 바깥도 `catch { return null; }` 라
      상태 객체도 로그도 없이 **4초마다 무음 실패**했다. 그런데 중앙의 `getLogQueryResult` 는 결과가
      없으면 **영원히 `{state:'pending'}`** 을 돌려준다(`central/logQueries.js:57` — 시한도 사유도
      없다). 즉 사용자가 누르면 **왜 안 되는지 모른 채 무한 대기**한다. CLAUDE.md 가 v2.549 에
      "위임 워커 4개가 전부 `catch { return null; }`" 이라 **적어 두고도 고치지 않은** 것 중 하나다.
    - 이제 인출 403(토큰 거부) · 결과 보고 413 · DB 오류 · 잴 것 0건을 **구분해** `_last` 에 남기고
      콘솔에도 적는다. `edgelog/spec.js` 표에도 등재했다(v2.554 규약 — **새 엣지 워커는 이 표에
      함께 넣을 것**).
    - ⚠ **타이머 콜백의 `runLogQueryWorkerOnce().catch(() => {})` 는 정당하다** — 안쪽이 이미 상태를
      남기고, setInterval 의 unhandled rejection 을 막는 관례다. 테스트는 `resilientFetch` 에 붙은
      빈 catch 만 검사한다(그것이 무음 실패 지점이었다).
    - `/api/central/log-query-result` 를 **BIG_JSON 에 등록**했다 — v2.549 가 형제 경로
      (`edge-log-result`)만 등록해 빠져 있었다. 실측: 500행(`checksLogs.js` 의 limit 상한) ×
      vCenter 이벤트 message **1,900자 = 981KB** 로 기본 1MB 에 닿고 2,000자면 1,079KB 로 넘는다.
      413 은 재시도 대상이 아니라 **그 조회 결과의 조용한 전량 소실**이다.
    - ✅ **v2.561 시점에 같은 상태였던 위임 워커**(`pingWorker` · `captureWorker` · `bmstorWorker`)는
      v2.574 IMP-07 에 `_last` + `console.warn` 을 받았다(`edgeSweep2574` 가 고정 — v2.590 에 이 줄을 정정).
      새 워커도 **UI 표시(spec 표 등재)를 함께** 해야 한다 — 화면이 말하지 않는 상태는 없는 것과 같다.
  - ⚠⚠ **토큰 점검 — 중앙이 평문으로 가진 토큰은 두 가지뿐이고, 나머지는 엣지가 스스로 말해야 한다**
    (`util/tokenFingerprint.js` · `portalcheck/{tokenScan,tokenProbe,tokenFindings,edgeReport}.js` ·
    `central/tokenCheckPull.js` · `routes/api/portalCheck.js` + 웹 `views/tools/PortalCheck.jsx`·
    `tokenCheckText.js`, v2.560 — 사용자 요청 "특수기능에 '포탈 점검' 메뉴 · 첫 서브메뉴 '토큰 점검' —
    ① 모든 토큰의 중복 ② 중앙 저장 토큰과 엣지 저장 토큰으로 통신되는지 ③ 두 값이 동일한지 ④ 점검".
    선택: **엣지 보고 엔드포인트를 이 릴리스에 만든다** · 공유 토큰은 **전용 '주의' 칸** ·
    배포 대상 토큰은 **저장소 대조만**):
    - **중앙이 아는 것과 모르는 것이 설계의 중심이다.** 평문을 가진 것은 ⓐ `collectors.json` 의
      수집 토큰 ⓑ `portal.env` 의 공유 `CENTRAL_TOKEN`·`COLLECTOR_TOKEN` **둘뿐**이다. 엣지별
      **개별 중앙 토큰은 SHA-256 해시만** 보관하고(`central/agentTokens.js:72`) 엣지가 push 하는
      설정 사본은 `*_TOKEN` 이 `REDACTED` 다(v2.538). ⇒ **요구 ③ 의 절반은 엣지가 스스로 보고하지
      않으면 영원히 답할 수 없다** — '모른다' 를 '불일치' 로 뭉개지 말 것.
    - ⚠⚠ **전체 해시를 내보내는 export 를 만들지 말 것**(`util/tokenFingerprint.js` 규칙 2).
      개별 엣지 토큰의 전체 sha256 이 **곧 `central-agent-tokens.json` 의 저장값**이고, 사람이 손으로
      정한 공유 토큰이면 그 해시로 **오프라인 사전 공격**이 성립한다. 나가는 것은 `sha256:xxxxxxxx
      (len=N)` 8자 지문 + 앞뒤공백 플래그뿐이고, 비교는 서버 안에서 `sameToken()`(전체 해시)이 한다.
      8자(32비트)는 충돌하므로 문구도 **'다르면 확실히 다르고, 같으면 가능성이 높다'** 까지만 쓴다
      (v2.528 `credFingerprint` 와 같은 한계). 엣지 거부 기록(`routes/collector.js authDeny.recent[].fp`)과
      **같은 표기**여야 눈으로 대조된다 — 그래서 `tokenFp` 를 이 모듈로 승격했다(두 벌 금지).
    - ⚠⚠ **토큰 값을 trim 하지 말 것**(v2.560 자체 검증에서 잡은 결함): 초판 `edgeReport.js` 가
      `COLLECTOR_TOKEN=' tok '`(12자·공백 있음)을 `len:10 · space:false` 로 보고했다 — **오류 없이
      틀린 값**이고, 하필 이 점검이 가장 잡고 싶은 사고(붙여넣기 공백 → 전체 문자열 비교 실패)를
      **숨겼다**. `tokenMatches`·해시 비교는 모두 원문 전체를 본다. `config.js` 도 env 를 다듬지 않는다.
    - **증거의 강도를 구분한다.** `/api/collector/ping` 이 **200 이면 중앙 저장값 == 엣지 저장값이
      증명**된다(엣지 게이트가 `tokenMatches` 로 전체 문자열 상수시간 비교 — 지문 대조와 달리 확정).
      403 은 **'다르다' 까지만** 안다 — 그때는 자기보고도 같은 토큰으로 당기므로 함께 거부되어
      **'엣지가 무엇을 저장했는지' 를 알 길이 없다**(정직 기록. 화면이 다음 단서로 배포 대상 대조와
      그 엣지 호스트 직접 확인을 안내한다). 200 인데 `identityIssue` 가 걸리면 `wrong-edge` 다 —
      **200 을 무조건 정상으로 칠하면 포워딩 되돌림을 정상으로 센다**.
    - ⚠⚠ **엣지 보고는 `GET /api/collector/token-check`(수집 토큰 게이트)다 — 개별 토큰 전용으로
      만들지 말 것.** `/api/central/link-check` 계열은 개별 토큰 전용이라 공유 `CENTRAL_TOKEN` 만
      쓰는 법인은 403 이고 **"403 을 받고 있다는 사실조차 보고할 수 없다"**(v2.554 가 기록한 한계).
      수집 토큰 게이트는 공유/개별과 무관하므로 그 함정을 **구조적으로** 피한다. `/edge-log`·
      `/bm-usage` 와 같은 url·같은 토큰이라 **새 네트워크 허용도 필요 없다**.
    - **엣지가 중앙 토큰 축을 답하는 방법은 자기확인 1회다** — 자기 토큰으로 중앙
      `/api/central/health-probe` 를 두드려 `yourAgent` 를 받는다. 그 이름이 자기 이름이면 **증명**,
      다른 이름이면 **토큰 뒤바뀜**, 403 이면 **확실히 다름**, `tokenMode:'shared'` 면 공유 토큰이다.
      ⚠ 표적을 인벤토리·설정 pull 같은 무거운 경로로 바꾸지 말 것(점검이 곧 부하가 된다).
    - ⚠ **배포 대상 토큰으로 엣지를 찔러보지 않는다**(사용자 선택). 틀린 토큰 시도는 그 엣지의
      거부 링버퍼(20건 — `routes/collector.js denyRecent`)를 채워 **실제 침입 흔적을 밀어낸다**.
      그 축은 저장값끼리 대조한다(`sameToken`). 배포 대상 이름 필드는 **`agentName`**
      (`agent/deployRegistry.js:24-25`) — `name` 으로 읽으면 전 항목이 host 로 떨어져 등록부와
      **영원히 짝이 맞지 않고** '배포 대상 없음' 이라는 거짓이 된다.
    - ⚠ **배포 대상 중복 경고는 '여러 엣지에 걸쳤을 때' 만이다**(v2.560 스크린샷 판독에서 잡은 오탐):
      ① 배포 대상의 중앙 토큰이 공유 중앙 토큰과 같은 것은 **그것을 심으려는 의도된 구성**이고
      ② 배포 대상의 수집 토큰이 그 엣지 등록값과 같은 것도 정상이다. 전부 warn 으로 올리면 화면이
      정상 구성을 결함처럼 말한다.
    - **접속처는 등록부 저장값에서만 읽는다** — 요청 본문의 url·token 을 받는 API 를 만들지 말 것
      (v2.480 규약). 본문에서 읽는 것은 **엣지 이름 필터**뿐이다. 토큰을 싣는 요청은
      `resilientFetch`(retries **0**)로만 — 전역 `fetch` 는 DNS 리바인딩 lookup 이 없어 저장 토큰이
      사내 주소로 나간다(v2.506). 무인증 확인(`/api/central/health-probe` 로 '이 엣지가 또 다른
      중앙인가')은 **토큰을 싣지 않으므로** 유출 위험이 0 이고, 403 은 '살아 있고 인증을 요구한다'
      는 **양성 신호**다(v2.553 규약).
    - ⚠ **등록부에 없는 엣지도 행을 만든다** — 공유 토큰만 쓰고 자기등록도 하지 않는 사이트는 행이
      아예 생기지 않아 화면이 **'전부 정상' 이라는 거짓**을 말한다. 이름 합집합은 기존 공용 코어
      `central/knownAgents.js knownAgentNames()`(v2.312)를 **얹어서** 쓴다(그 소스로만 아는 엣지가
      사라지지 않게). 출처를 세분할 수 없는 이름은 `other` 로 적고 지어내지 않는다.
    - ⚠⚠ **행 상태 판정은 서버 `tokenScan.js rowStateOf` 하나가 소유한다.** 초판은 서버 `kpisOf` 와
      웹이 각자 판정해 **KPI 합계와 표의 색이 어긋났다**(공유 토큰을 한쪽은 주의, 다른 쪽은 확인
      불가로 셌다). 화면은 `row.state` 를 **읽기만** 하고, 값이 없으면 **확인 불가**다(초록 폴백 금지).
      KPI 항등식 **합계 = 정상 + 결함 + 주의 + 확인 불가**이고 `sharedToken`·`dupFault` 는 별도 축이다.
    - ⚠⚠ **정상률의 분모는 '응답을 받은 행' 이다**(v2.560 자체 검증에서 고친 결함): 값 위생(앞뒤
      공백)만으로 `warn` 이 된 행은 **네트워크 측정을 한 적이 없다**. 초판은 그것을 측정분에 넣어
      점검을 한 번도 누르지 않은 상태에서 **`측정 1곳 · 정상률 0%`** 라고 말했다('통신이 실패했다'
      로 읽히는 거짓). `ANSWERED_STATES`(HTTP 응답을 받은 상태)만 분모다.
    - ⚠⚠ **배너와 KPI 가 다른 축을 한 숫자로 말하지 말 것**(같은 판독에서 발견): 초판 배너는
      `findingCounts.fault`(발견 건수)를 '결함 N건' 이라 썼는데 KPI '결함' 칸은 **행 상태**라,
      중복만 있는 현장에서 배너 '결함 2건' 과 KPI '결함 0' 이 **정면으로 모순**됐다. 중복은 엣지
      2곳에 걸친 값이라 어느 행에도 귀속되지 않는다 — `엣지 N곳에 결함 · 중복 토큰 M건` 으로 나눠 말한다.
    - ⚠⚠ **같은 코드의 발견을 묶는다**(`groupFindings`, 같은 판독에서 발견): 엣지 28곳이 전부 공유
      토큰인 현장이면 `edge-shared-token` 28줄 + `edge-no-report` 28줄 + `probe-not-run` 28줄 =
      **같은 문단 84줄이 화면을 덮는다**(v2.509 규약 정면 위반. 실측 6곳에서도 22건 중 17건이 같은
      문장 3종이었다 — **수치로는 안 잡힌다**). 묶어도 **개수와 대상 엣지는 밝힌다**(조용한 축약 금지).
      ⚠ 위생 항목은 `facts.where`(중앙 등록값 / 엣지 값)까지 키에 넣는다 — 묶으면 엉뚱한 곳을 고친다.
    - **판정은 서버가 `code` + 근거만 주고 문장은 웹이 만든다**(v2.553 `remedy.js` 규약). 발견 코드
      25종 ↔ 화면 문구가 **1:1** 이어야 한다(테스트가 두 목록을 대조 — 한쪽만 늘면 화면이 코드를
      그대로 보여준다). 문구에 **백틱 금지**(`BoldText` 는 `**강조**` 만 해석), 조치문에 ` — ` 를
      넣지 말 것(`제목 — 조치 — 부가` 3단이 된다 — 테스트가 0 을 고정).
    - **중앙 보관분은 인메모리다** — 진실의 원천은 각 엣지의 env 이고 이것은 '방금 본 값' 이다.
      실패가 **직전 보고를 지우지 않는다**(v2.550.3 H5). 저장 키는 **중앙이 아는 이름**(등록부
      `name`)이고 본문 `node.agent` 는 믿지 않는다(v2.548 F5) — 둘이 다르면 그 사실 자체가 진단이라
      화면이 나란히 보여 준다. 수신은 **아는 키만** 담고 `short` 를 8자로 자른다(변조 엣지가 전체
      해시를 실어도 중앙에 남지 않게).
    - 권한은 **adminOnly + fullScopeOnly** — 전 법인 엣지 주소·이름·지문·길이가 들어간다
      (operator 는 `tools` 기본 보유. v2.500 D/M1 · v2.549 · v2.552 와 같은 기준). 엣지는 vCenter
      귀속이 아니라 범위 계정에 나눌 축이 없다 → 403(v2.525 규약). **폴링하지 않는다**(마운트 1회 +
      버튼). 프로브는 동시 4 · 요청 시한 8초 · **총 예산**(기본 90초)이고 예산에 걸려 시도하지 못한
      개수를 **밝힌다**(다시 누르면 이어진다). 재진입 가드는 프로브와 엣지 인출이 **공유**한다.
    - ⚠ **정직 기록 — 실장비(실제 엣지)로 확인하지 못한 것**: 이 환경에는 v2.560 엣지가 없어
      `token-check` 성공 경로는 **중앙 자신을 상대로** 확인했다(`ok`/`wrong-edge`/`token-mismatch`/
      `unreachable`/`not-run` 5경로를 실제 HTTP 로 돌렸고 `measured 3 · probeOk 1 · 33%` 를 실측).
      엣지의 `selfProbe` 성공 경로(`yourAgent` 가 개별 토큰 이름으로 오는 것)는 이 환경에
      `CENTRAL_URL` 이 없어 **코드 경로만** 확인했다 — 엣지가 올라간 뒤 첫 인출로 확인할 것.
  - ⚠⚠ **외부 포탈 조회 API — '전부 노출' 이 아니라 허용 목록이고, 계약은 투사(projection)가 집행한다**
    (`publicapi/{keys,allowlist,auth,openapi,time}.js` · `routes/publicApi.js` ·
    `routes/admin/apiKeys.js` + 웹 `views/ApiKeys.jsx`·`apiKeyText.js`, v2.562 — 사용자 질문
    "모든 기능에 대해서 api 서비스 엔드포인트를 만들어서 다른 포탈에서 읽어서 사용하게 할 수 있어?".
    선택: **조회 전용 + 허용 목록** · **전용 API 키 신규 발급** · **버전 고정 경로 + OpenAPI** ·
    **설정 화면에서 발급** · 1차 분류 **인벤토리 · 용량/사용량 · 장애/알람**):
    - ⚠⚠ **'엔드포인트가 없다' 가 아니었다** — 이 저장소의 `/api/*` 라우트는 **686개**(조회 204 ·
      상태변경 280)로 이미 있었다. 없던 것은 ① 기계 인증 ② 고정된 계약 ③ 문서다. 그래서 만든 것은
      '새 API' 가 아니라 **좁은 공개 표면**이다. 상태변경 280개에는 RMA 원격 명령 실행 · VM
      프로비저닝 · `shutdown` · 호스트 방화벽 변경 · **백업 다운로드(= `AUTH_SECRET`·TOTP 시크릿
      사본)** 가 섞여 있다 — '전부 노출' 은 외부 키 하나가 인프라를 조작한다는 뜻이다.
      `ENDPOINTS` 는 **전부 GET** 이고 테스트가 `v1.post|put|patch|delete` 가 0 임을 고정한다.
    - ⚠⚠ **`CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 을 재사용하지 말 것**(사용자 선택). 그 토큰은 엣지
      수집 데이터 열람과 **설정 배포** 권한을 주고 **범위를 좁힐 축이 없다**. viewer 비밀번호
      로그인도 아니다(세션·OTP 정책이 기계 호출과 맞지 않는다). 전용 키는 `sha256` **해시만**
      보관하고(`api-keys.json`, SECRET_FILES + `.gitignore` **둘 다**) 평문은 **발급 응답에만**
      실린다. 검증은 `crypto.timingSafeEqual`, 표기는 `tokenFingerprint` 8자(v2.560 규약 —
      **전체 해시를 내보내는 export 를 만들지 말 것**: 그 값이 곧 저장값이다).
    - ⚠⚠ **내부 응답 형태를 그대로 내보내지 않는다 — `project()` 가 선언 필드만 남긴다.** 이
      저장소의 응답은 자체 UI 전용이라 필드가 자유롭게 바뀐다(`zoning.zones` 가 숫자→배열,
      `capacityNote`→`capacityBasisNote` 로 바뀐 전례). 외부 소비자가 내부 형태에 붙으면 그
      변경이 **남의 포탈을 깨뜨린다**. `{...row}` 로 펼치지 말 것 — 지금 없는 필드가 나중에
      들어오며 조용히 샌다(v2.500 D/M1 · v2.503 S-3 와 같은 사고). 테스트가 **응답 키 집합 ==
      선언 `fields`** 를 대조하므로 내부 필드가 사라지면 **소비자가 아니라 우리가 먼저** 안다.
    - ⚠⚠ **범위 축이 없는 자원에 부분 데이터를 주지 않는다 — 403 `needs-full-scope`** 다.
      스토리지 장비는 `datacenterId`(자유 라벨)만 있고 `vcenterId` 가 없어 vCenter 범위와
      교집합할 수 없다(내부 라우트도 그래서 `fullScopeOnly`). 빈 목록은 **'장비 0대' 라는 거짓**
      이고 전량은 범위 위반이다(v2.525 규약). 화면이 그 403 을 **미리** 말한다
      (`fullScopeWarning`) — 숨기면 상대 포탈이 '토큰이 거부됐다' 고 오해한다.
    - ⚠ **`scopedVcenterIds(user, snap)` 의 `null` 은 '제한 없음' 이다** — 빈 집합으로 읽으면
      전체 범위 키가 **아무것도 못 본다**. 범위는 합성 사용자(`req.user`, `role:'viewer'`)로
      기존 판정에 태운다 — 그 역할을 넓히지 말 것.
    - ⚠⚠ **시각 표기는 `publicapi/time.js msOrNull` 하나가 소유한다**(v2.562 자체 검증에서 잡은
      결함): `snap.generatedAt` 은 **ISO 문자열**(`store.js:402`)이고 DB 계열은 epoch ms 숫자다.
      시각을 `numOrNull()` 로 통과시키면 ISO 가 **`null`** 이 되고, 이 API 의 계약이 "읽지 못한
      값은 null" 이라 그것은 **'수집 시각을 읽지 못했다' 는 거짓**이 된다(`/inventory/collection`
      의 `generatedAt` 이 실제로 그랬다). ⚠ **숫자 문자열을 `Date.parse` 에 넘기지 말 것** —
      `Date.parse('12345')` 는 **연도 12345**(epoch 3.27e14)로 해석된다. 표기는 **epoch ms 하나**다.
    - ⚠ **`normalizePeriods` 는 배열이 아니라 `{periods, dropped}` 를 돌려준다**(`storage/growth.js:43`).
      v2.562 초판이 반환값을 그대로 넘겨 `/capacity/storage-growth` 가 **통째로 500**
      (`periods.map is not a function`)이었다. 버린 개수도 응답에 밝힌다.
    - ⚠⚠ **중복 집계는 테스트가 대조해야만 갈라지지 않는다**: `/inventory/summary` 의 합계는 내부
      `/summary` 와 **같은 값이어야 하는데** 그 집계가 라우트 안에 인라인이라 꺼내 쓸 함수가 없다.
      `test/publicApi2562.test.js` 가 두 값을 대조한다(실측 17항목 전부 일치 — 단위만 Ghz/GB/TB ↔
      Mhz/MB/GB 로 다르다). ⚠ 이 대조를 지우면 중복 구현이 **조용히** 어긋난다.
    - ⚠⚠ **`guarded()` 는 `Promise.resolve().then().catch()` 로 감싼다** — express 4 는 async
      핸들러의 throw 를 잡지 않아 요청이 **응답 없이 매달린다**(v2.548 S1 실측 hang). 동기
      `try/catch` 는 async reject 를 **놓친다**. `res.headersSent` 가드도 함께 둔다.
    - **사유를 한 문구로 덮지 않는다**: 401 `missing-key`/`unknown-key`/`revoked`/`expired` ·
      403 `no-groups`/`group-denied`/`needs-full-scope` · 404 `unknown-endpoint` · 429
      `rate-limited`(+`Retry-After`) · 503 `not-collected`/`unavailable`. ⚠ **`no-groups` 는
      403 이다**(키는 유효하고 인가가 빈 것) — 401 로 두면 상대 포탈이 멀쩡한 키를 재발급한다.
      ⚠ 404 에 **경로 목록을 싣지 말 것**(열거 단서) — 카탈로그(`GET /api/v1/`)가 그 역할이고
      거기서는 이미 키가 검증된 상태다.
    - **첫 수집 미완료는 빈 배열이 아니라 503** 이다(v2.509 규약 — '데이터가 없다' 와 구분).
      목록 상한은 `meta.truncated`·`meta.omitted`·`meta.limit` 로 **밝힌다**(조용한 상한 금지).
      응답은 `Cache-Control: no-store`(키마다 범위가 달라 중간 캐시가 섞으면 남의 법인 데이터가 간다).
    - **OpenAPI 는 카탈로그에서 생성하고 그 키가 쓸 수 있는 것만 담는다** — 손으로 쓴 스펙을 두면
      문서와 응답이 갈라지고, 그때 상대 포탈은 **문서를 믿고** 잘못된 코드를 쓴다(v2.553 '조언이
      틀리면 무음 실패보다 나쁘다'). 전량을 담으면 403 이 날 경로를 '있다' 고 말하게 된다.
    - **빈 허용목록을 '전부 허용' 으로 읽지 말 것**(거부 기본값 — v2.555 규약). ⚠ 다만 **vCenter
      범위의 빈 배열은 '전체'** 다 — 도구 권한 허용목록과 **방향이 반대**이므로 화면이 그 차이를
      말한다. 모르는 분류는 **버리고 개수를 밝힌다**.
    - ⚠ **카탈로그에 없는 분류를 라벨인 척 보여주지 말 것**(v2.562 스크린샷 판독에서 발견):
      분류를 없앤 릴리스 뒤에는 옛 키가 사라진 분류를 들고 있고 그것은 아무 경로도 열지 않는다.
      코드만 덩그러니 보여주면 사용자는 **아직 유효한 분류**로 읽는다 → `portal(무효)` + 각주 1회
      (`staleGroups`). 기록은 **지우지 않는다**(무엇을 들고 있었는지가 진단).
    - ⚠ **요청되지 않은 분류를 '있으니까' 로 함께 싣지 말 것**(v2.562 정직 기록): 초판이 관리자가
      고르지 않은 `portal`(포탈 자체 상태)을 함께 넣었는데, 그것이 **선언 필드와 핸들러가 어긋난
      채로** 있었다 — 선언은 `uptimeSec`·`source`·`generatedAt` 인데 핸들러는 `startedAt`·
      `dataSource` 를 만들어 `project()` 가 3개를 영원히 `null` 로 채웠고, 근거로 읽던
      `config.startedAt`·`collector.lastSeenAt` 은 **이 저장소에 없는 필드**였다(grep 0건 →
      `edgesFresh` 가 언제나 0). 요청 범위를 넘겨 만들면 이렇게 검증이 얕아진다. 되살리려면
      **근거 필드를 코드로 확인한 뒤** 별건으로.
    - 권한은 **조회 admin · 발급/수정/폐기/삭제 adminOnly + `requireSettingsOwner`** 다 — 이 키는
      전 함대 조회 데이터에 **상시** 접근하는 자격증명이라 백업 아카이브·중앙 토폰 배달과 같은
      등급이다(v2.210 H3 기준). 전부 `logAudit` 하고 **평문은 남기지 않는다**(지문만 — v2.419).
      ⚠ `logAudit` 의 인자명은 `user`·`target`·`detail` 이다(`audit.js:53`) — `actor` 로 쓰면
      **조용히 버려진다**.
    - ⚠ **표는 가로 스크롤 컨테이너로 감싸는 것만으로 부족하다 — 표에 `minWidth` 를 줄 것**
      (v2.562 판독에서 발견): 없으면 브라우저가 스크롤 대신 **열을 짜부라뜨려** 400px 에서 셀이
      한두 글자 폭으로 세로로 길어진다(실측 페이지 높이 6,054px → `minWidth` 부여 후 3,471px).
      **넘침은 0px 이라 수치로는 안 잡힌다.** ⚠ **0 인 KPI 칸을 경고색으로 칠하지 말 것** —
      숫자는 '문제 없음' 이라 하고 색은 '문제 있음' 이라 말한다(v2.556 규약).
    - ⚠ **정직 기록 — 확인한 것과 못 한 것**: 목 서버(포트 4744)에 실제로 키를 발급해 **401·403·
      404·429·200 전 경로를 HTTP 로 돌렸고** 투사 계약·범위 403·내부 집계 대조(17항목)·평문
      미노출·Chromium 1440/400 을 실측했다. **실제 외부 포탈이 이 API 를 소비하는 것은 확인하지
      못했다** — 첫 연동에서 `GET /api/v1/` 카탈로그와 `openapi.json` 을 상대가 읽는지로 확인할 것.

  - ⚠⚠ **import 한 이름을 같은 블록에서 `const` 로 재선언하지 말 것 — TDZ 로 그 함수가 통째로 죽는다**
    (`sanswitch/perfPush.js`, v2.566 — 사용자 신고 "중앙에서 직접 접속한 장비는 트래픽 수집이
    되는데 agent 로 접속한 장비는 차트가 안 보여". 회귀는 `test/sanPerfPush2566.test.js`):
    - **결함**: v2.427 이 커서 정합을 넣으며 이렇게 썼다 —
      `import { …, maxRowid } from './perfDb.js'` 인데 같은 try 블록에
      `const max = await maxRowid();` **뒤에** `const { rows, maxRowid, unavailable } = await
      samplesAfter(…)` 를 뒀다. `const maxRowid` 가 블록 전체를 TDZ 로 만들어 `pushPerfNow()` 는
      **매 호출 첫 줄에서** `ReferenceError: Cannot access 'maxRowid' before initialization` 으로
      죽었다(실행으로 확정). 엣지 위임 스위치의 사용량이 **10일 동안 한 건도** 중앙에 오지 않았고,
      커밋 날짜(2026-09-08)와 사용자 화면의 마지막 표본 시각이 **정확히 일치**한다.
    - ⚠⚠ **조용했던 이유 셋 — 이게 진짜 교훈이다**:
      ① 호출부가 전부 `pushPerfNow().catch(() => {})` 이고 내부 catch 는 `_last.error` 에만 적어
         **콘솔에도 화면에도 남지 않았다**(v2.549·v2.561 '무음 실패 금지' 규약 위반).
      ② v2.517 이 "표본 0건이어도 상태는 올린다" 고 만든 하트비트(`sendStatusOnly`)가 **던지는 줄
         뒤**에 있어 그것도 안 갔다 — 즉 **정직 장치를 만들어 두고 그 앞에서 죽고 있었다**.
      ③ `sanSwitchPerfRelay2423.test.js` 는 순수 헬퍼(`chunkRows`·`reconcileCursor`)와 DB 만 보고
         **`pushPerfNow` 를 한 번도 호출하지 않았다** — 통과하면서 놓쳤다.
      **push·pull 함수를 만들면 그 함수를 실제로 호출하는 테스트를 함께 쓸 것**(순수 헬퍼만
      고정하는 것은 이 종류를 못 잡는다). 새 테스트는 목 HTTP 서버로 본문 도착까지 본다.
    - **전수 스윕은 테스트가 한다** — `import` 된 이름이 같은 파일의 `const`/`let` 구조분해로
      가려지는 곳이 **0건**임을 고정한다(주석 선제거 — v2.535 규약). 서버 636개 파일 중 이 한 곳뿐이었다.
    - ⚠ **서버에는 eslint 가 없다**(웹만 CI 에서 lint). 조사 결과 `no-use-before-define` 을 켜면
      우리 코드에 **161건**이 뜨는데, 표본 4건을 열어 보니 전부 **함수 본문 안의 전방 참조**
      (`round`·`tick`·`bad`·`_cache`)로 호출 시점엔 초기화돼 있어 **안전**하다. 즉 이 규칙은
      치명적인 경우를 **가려 주지 못한다** — 그래서 도입 대신 위의 좁은 스윕을 택했다
      (도입 여부는 별건. vendor 압축 파일 1,802건은 제외한 수치다).
    - **화면도 함께 고쳤다 — 판정 2종 추가**:
      · `stale` — 마지막 표본이 수집 주기의 6배(최소 1시간)보다 오래됐으면 **'기간을 넓히세요' 가
        아니라 '수집이 멈췄다'** 고 말한다. 신고 현장은 10일째 정지인데 화면이 *"수집은 되고
        있습니다 · 조회 기간을 넓히면 보입니다"* 라고 말했다 — 넓혀도 나오는 건 10일 전 값이다.
        ⚠ **수집이 꺼져 있으면 오래된 것이 정상**이므로 `stale` 로 보지 않는다(꺼짐 판정이 말한다).
        ⚠ '예전 값은 더 긴 기간에서 보인다' 는 사실은 **함께 말한다**(그것도 참이다).
      · `edge-push-failed` — 엣지가 `pushError`(마지막 중계 실패 사유)를 상태에 실어 보고하고,
        화면이 **'기다리면 온다' 대신 사유와 함께** 말한다. 이 통로가 없어서 이번 결함이 10일을 갔다.
        **새 엣지 push 경로를 만들면 실패 사유를 상태에 함께 실을 것.**

  - ⚠⚠ **무인증으로 열리는 면을 새로 만들지 말 것 — v2.564 의 공개 API 안내 페이지는 v2.565 에 철회됐다**
    (사용자 지시 "무인증으로 만드는 작업은 취소". 삭제된 것: `routes/publicDocs.js` ·
    `publicapi/{samples,docsSettings}.js` · 웹 `views/ApiDocs.jsx`·`apiDocsText.js` ·
    설정 › 연동 키의 on/off 스위치 · 로그인 화면의 '⇗ API 안내' 링크):
    - **되살리지 말 것.** v2.564 는 "운영 데이터가 한 바이트도 나가지 않는다"(합성 샘플만 · 스냅샷
      import 금지 · 목 vCenter 이름 0건)를 실제 HTTP 로 확인하고 만든 것이었지만, 사용자는
      **그 판단 기준 자체를 받지 않았다** — 이 포탈에서 **로그인 없이 열리는 면을 늘리는 것**이
      정책상 허용되지 않는다. '데이터가 안 샌다' 는 근거로 무인증 라우트를 정당화하려 하지 말 것.
    - **연동 문서는 계속 있다** — `docs/API-PUBLIC.md`(저장소 문서)다. 포탈이 **런타임에 무인증으로
      내보내지 않는다**는 점이 다르고, 그것이 이 철회의 전부다. 외부 연동 API(`/api/v1`) 본체와
      키 발급·관리(설정 › 연동 키)는 **그대로 살아 있다**.
    - ⚠ **이미 게시된 릴리스는 되돌릴 수 없다** — 2.564.0 번들이 현장에 있을 수 있으므로 릴리스
      노트에서 그 항목을 **지우지 않고** '철회됨' 으로 표시했다. 기록을 지우면 2.564 를 설치한
      현장이 '왜 화면이 사라졌나' 를 알 길이 없다.
    - ⚠ **v2.564 가 발견했던 별건 2개는 살린다**: ① `docs/API-PUBLIC.md` 오류 표에 `internal`(500)
      이 빠져 있던 것(표가 완전한 척하면서 실제로 오는 코드를 빠뜨렸다 — `publicApi.js:87`)
      ② `App.jsx` 의 `hashchange` 리스너가 **조기 return 아래**에 있어 로그아웃 상태에서는 등록되지
      않는다는 사실(지금은 그 경로를 쓰는 화면이 없어 되돌렸지만, **로그인 전에 보이는 화면을
      다시 만들 일이 생기면 이 함정을 먼저 볼 것**).

  - ⚠⚠ **문서는 손으로 적는 목록을 두지 않는다 — 생성기가 '못 읽은 것' 을 실패로 만든다**
    (`scripts/api-doc.mjs` + `docs/API.md`·`docs/API-PUBLIC.md`·`docs/ARCHITECTURE.md` +
    `server/test/apiDoc2563.test.js`, v2.563 — 사용자 요청 "전체 소스 분석해서 문서화, 특히
    api 문서는 별도 파일로 자세하게"):
    - **조사 결과 API 문서가 하나도 없었다**(`docs/` 42개 중 `api|endpoint|rest` 0건). 그런데
      라우트는 **820개**(GET 426 · POST 261 · PUT 85 · DELETE 46 · PATCH 2) · 파일 81개다.
      손으로 적으면 다음 릴리스부터 낡는다 — `ENV.md`(329개)·`CONFIG-FILES.md`(130개)가 이미
      생성기를 쓰는 이유가 그것이다.
    - ⚠⚠ **생성기는 '못 읽은 것' 을 조용히 넘기면 안 된다.** `docsGen2452.test.js` 머리말의
      사고가 이 지점이다 — 정규식이 못 잡는 형태가 생기면 항목이 **조용히 사라지는데 생성은
      성공**해 CI 의 `--check` 도 통과했다(환경변수 28개·가장 큰 DB 2개). 그래서 `api-doc.mjs`
      는 ① 마운트 경로를 못 찾은 라우트 파일 ② 인자 목록을 못 읽은 라우트 가 하나라도 있으면
      **종료코드 1 이고 문서를 쓰지 않는다**. 뜻을 모르는 게이트 헬퍼는 문서 안에 **목록으로
      밝힌다**(조용히 '가드 없음' 으로 만들지 않는다).
    - ⚠⚠ **게이트 별칭을 해석하지 않으면 없는 취약점을 만든다**(v2.536 규약): 이 저장소는
      `const toolsPerm = requirePerm('tools')` · `canEdit`(svcmon, **다른 파일의 export**) 처럼
      이름이 가드처럼 생기지 않은 별칭을 쓴다. 해석 못 하면 멀쩡한 라우트가 '무가드' 로 문서에
      실려 다음 사람이 **잘못 판단한다**. import 를 따라가 해석한다.
    - ⚠⚠ **선언 줄에 안 보이는 게이트를 함께 적는다**: 마운트 수준(`app.use('/api/svcmon', …,
      requirePerm('svcmon'), r)`)과 라우터 수준(`capacityRouter.use(adminOnly)`). 빠뜨리면 문서가
      "이 경로는 인증만 하면 된다" 는 **거짓**을 말한다.
    - ⚠ **v2.563 초판이 실제로 틀렸던 것 셋**(테스트가 각각 고정한다):
      ① 가드 없이 바로 핸들러인 라우트를 **35건 놓쳤다** — `(req, res)` 의 쉼표가 깊이 2 라
         인자 경계로 안 잡혀 핸들러 본문을 끝까지 읽다 상한에 걸렸다. **다음 인자가 핸들러인지
         미리 보고 멈춘다**(`peekIsHandler`).
      ② **`req.get('host')`(헤더 읽기)를 라우트로 34건 잘못 셌다.** 없는 엔드포인트를 싣는 것은
         누락만큼 나쁘다. 변수명 블랙리스트가 아니라 **화이트리스트**(그 파일에서 `Router()` 로
         선언됐거나 `register*` 함수의 인자)로 받는다.
      ③ 라우트 인자 사이 **주석 한 줄이 게이트 이름으로** 표에 실렸다 — 주석을 먼저 제거한다
         (v2.535 규약). `...adminOnly` 전개도 접두를 떼야 별칭이 해석된다.
    - ⚠ **테스트는 '경로 문자열' 로 판정하지 말 것**(v2.563 에 자기 테스트가 오탐했다):
      `/api/capacity/host` 는 **실재하는 라우트**이고 `req.get('host')` 는 헤더다 — 문자열이 같다.
      그래서 회귀 테스트는 **행이 가리키는 소스 줄을 실제로 열어** 라우터 메서드 호출인지
      확인한다(820행 전수).
    - **공개 API 문서는 별도 파일**(`API-PUBLIC.md`)이고 **실제 호출로 받은 응답**을 싣는다
      (지어낸 예시 금지). 테스트가 `allowlist.js` 의 선언과 문서를 대조해 **없는 경로를 안내하는
      것**과 **필드 절반 이상 누락**을 막는다.
    - CI 는 `--check` 로 세 문서(ENV·CONFIG-FILES·API)의 최신 여부를 본다(`continue-on-error`
      — 갱신을 잊었다고 릴리스를 막지는 않되 로그에 드러낸다). **라우트를 추가하면
      `node scripts/api-doc.mjs` 를 돌릴 것.**
  - ⚠ **'빈 인벤토리' 배지는 클릭해 원인·상태·로그·조치를 본다**(`web/src/views/collectors/
    emptyInvText.js`·`EmptyInvModal.jsx` + `store.js storeStatus`, v2.560 — 사용자 요청 "빈 인벤터리로
    나올때 상태와 로그, 해결방법을 클릭하면 나오게 해줘"):
    - v2.556 까지 그 배지는 클릭되지 않는 `<span title=…>` 이고 툴팁 한 문장이 **조치가 정반대인
      원인들**을 덮었다 — 등록 0개(등록해야 한다) / 첫 수집 중(**기다리면 된다**) / vCenter 접속
      실패(기다려도 안 된다) / mock 폴백이라 전송 제외(의도된 동작) / **그 vCenter 가 실제로 비었음
      (이상이 아니다)**. v2.516(툴팁에만 두지 말 것) · v2.517(`perfDiagText`) 와 같은 계열이다.
    - ⚠⚠ **판정 순서가 계약이다**: mock id(중앙이 직접 본 것) → 엣지 상태 없음(**판정하지 않는다**)
      → 등록 0개 → mock 폴백 → 접속 실패 → **push 실패** → 첫 수집 중 → 빈 vCenter → 미확정.
      실패가 있는데 '기다리세요' 라고 말하면 거짓이므로 `pending` 은 실패 판정들 **뒤**에 둔다.
      `CAUSE_WAITING` 이 그 방향을 한 값으로 들고 있고, 기다려서 되는 원인은 **첫 수집 하나뿐**이다.
    - **엣지 상태·로그는 v2.549 pull 을 그대로 쓴다**(`POST /tools/edge-log/fetch`) — 새 엔드포인트도
      새 네트워크 허용도 없다. ⚠ **모달을 여는 것만으로 엣지로 나가지 않는다**(28곳에 요청이 나가면
      그게 사고다) — 먼저 중앙이 아는 것을 보여주고 사람이 버튼을 눌러야 나간다.
    - ⚠⚠ **엣지 로그 표에 `collect.inventory` 를 등재했다**(`edgelog/spec.js` + `store.js storeStatus`):
      **가장 중요한 폴러가 그 표에 빠져 있었다** — 그래서 '빈 인벤토리' 의 원인을 중앙에서 볼 길이
      아예 없었다. `storeStatus()` 는 vCenter별 `status`·호스트·VM·오류를 주고 **자격증명을 담지
      않으며** 목록 상한(64)을 밝힌다. **새 폴러를 만들면 이 표에 함께 넣을 것**(v2.554 규약).
    - **mock vCenter id 판정은 `emptyInvText.js` 하나가 소유한다**(`Collectors.jsx` 가 import).
      ⚠ `/^vc-/` 로 넓히지 말 것 — 현장에서 `vc-hg01` 로 이름 지은 **실제** vCenter 가 mock 으로
      오판된다. 생성기 id 는 `vc-<지역>-<도시>` 형식이다(`mock/generator.js:34-36`).
  - ⚠⚠ **`logAudit` 은 옵션 객체 하나로 부른다 — `logAudit(req, …)` 가 감사 로그 화면을 통째로 죽였다**
    (`audit.js` + 라우트 6파일 11곳, v2.569 — 사용자 신고 "감사로그가 에러나고 안되".
    회귀는 `test/auditMiscall2569.test.js`):
    - **증상**: 설정 › 감사 로그가 `Minified React error #31 … object with keys
      {username, role, name, scope, mustEnrollOtp}` 로 **설정 탭 전체**가 죽었다. 그 키 집합은
      `auth/auth.js resolveTokenUser` 의 반환, 즉 **`req.user`** 다.
    - **원인**: `logAudit({ user, action, target, detail, ip })` 는 **첫 인자를 구조분해**하는데
      라우트 11곳이 `logAudit(req, '액션', {…})` 로 불렀다 — `user = req.user`(객체)가 그대로
      `audit.ndjson` 에 저장됐고, 화면이 `{e.user}` 와 `<option>{u}</option>` 로 렌더하다 죽었다.
      · ⚠ **더 나쁜 것 — `action` 도 함께 잃었다**(`req.action` 이 undefined → JSON 에서 탈락).
        즉 그 기록들은 **누가·무엇을 했는지 둘 다** 없다. 감사 로그의 존재 이유가 사라진 셈이다.
      · 오용 지점은 전부 v2.520~2.552 에 새로 들어온 라우트다 — `horizonSessions`(2) ·
        `bmUsage`(3) · `curUser`(2) · `storageMon`(1) · `linkCheck`(2) · `edgeLog`(1).
    - ⚠⚠ **방어선은 둘이고 둘 다 유지할 것**: ① **쓰기**(`logAudit`) 가 `auditStr` 로 전 필드를
      문자열로 굳히고 오용 형태(`headers`+`method` 가 있는 객체)를 만나면 **`console.warn` 으로
      드러낸다**(조용한 통과 금지 — v2.549 규약) ② **읽기**(`listAudit`) 도 같은 소독을 한다.
      쓰기만 고치면 **이미 저장된 줄**이 계속 화면을 죽이고(운영 파일은 우리가 고칠 수 없다),
      읽기만 고치면 새 줄이 계속 오염된다.
    - **값을 지어내지 않는다** — 객체가 오면 `username` 이 있을 때만 그것을 쓰고, 없으면
      `(형식 오류)` 다. 소실된 `action` 은 빈 문자열이고 화면이 **`작업 미기록`** 으로 그 사실을
      말한다(빈칸으로 두면 화면 결함처럼 읽힌다).
    - ⚠ **A/B 로 확정했다** — 수정 전 코드로 되돌려 같은 데이터를 띄우니 Chromium 에서
      `React error #31` 이 그대로 재현됐고(에러박스 true · 표 없음), 수정 후에는 3행이 정상
      렌더된다(에러 0). 추측이 아니라 재현이다.
    - ⚠ **왜 못 잡았나**: `logAudit` 은 반환값이 없고 실패해도 `catch {}` 라, 오용해도 **라우트는
      정상 200 을 돌려준다**. 테스트도 감사 *파일 내용* 을 보지 않았다. 그래서 회귀 테스트가
      **소스 전수 스윕**(`logAudit(req` 0건)까지 함께 고정한다 — 주석 제거 시 **개행을 보존**할 것
      (지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다 — 이 테스트 초판의 실제 오탐).
    - ⚠ **라우트 파일을 고치면 `node scripts/api-doc.mjs` 를 돌릴 것**(v2.563 규약) — 이번에도
      줄 번호가 밀려 `apiDoc2563.test.js` 2건이 깨졌다.

  - ⚠⚠ **스토리지 '장애 장비' 카드는 v2.567 에 넣었다가 v2.568 에 철회했다 — 되살리려면 판정 근거부터
    고칠 것**(사용자 신고 "장애 장비가 3개인데 27개라고 나와" → 지시 "방금 처리한 장애는 적용 취소해줘".
    지운 것: `web/src/views/tools/storageFaultText.js`·`storageFaultText.test.js` + `StorageMonTool.jsx`
    의 카드·필터 + `storageColumns.js` 의 `수집 상태` 라벨 + `Kpi` 의 `title` prop. '미해결 경보' KPI 복원):
    - ⚠⚠ **원인 — 장비가 보고한 헬스 문자열을 '장애' 로 읽었다.** `deviceFault()` 가 신호 셋 중 하나로
      `extra.healthState ?? extra.clusterHealth` 를 `storageNodeText.healthBadge` 에 넘겨 **tone 이
      red 면 장애**로 셌다. 그런데 `healthBadge` 는 `/^(ok|healthy|normal|good)\b/` 가 아니면 전부
      red 다 — **그 함수는 '배지 색' 용이고 '장애 판정' 용이 아니다.**
      · 그 필드를 채우는 수집기는 **둘뿐**이다(grep 확인): `isilonSsh.js:189 clusterHealth`(= `isi status`
        의 `Cluster Health: [ATTN]` 같은 **클러스터 레벨 플래그**) · `xtremio.js:38 healthState`
        (`sys-health-state`). 이 현장 대수는 **Isilon 22 + XtremIO 7 = 29** 이고 오보고가 **27** 이었다 —
        즉 그 두 종류가 **거의 전부** 장애로 찍혔다.
      · ⚠ **Isilon 의 `ATTN` 은 노드 장애가 아니다.** 같은 파일 `:169` 가 이미 `unhealthy =
        nodes.filter(health !== 'OK')` 로 **노드 단위** 판정을 따로 하고 있고, 신고 화면의 첫 행
        `LGES-bigdata` 는 **노드 66대 전부 정상(⚠ 없음)** 인데 장애 목록 맨 위에 있었다. 클러스터
        플래그는 경미한 이벤트에도 켜지므로 그것을 장애로 세면 **정상 장비가 거의 전부 장애가 된다**.
    - **되살릴 때의 규칙**: 장애 판정 신호는 **노드 `unhealthy` 수처럼 '대수' 로 환원되는 것**만 쓴다.
      자유 문자열 헬스는 **표시용**이고 판정에 넣지 말 것(넣으려면 타입별 정상값 목록을 먼저 확정해야
      한다 — `healthBadge` 재사용은 오답이다). 사용자가 센 '장애 3대' 는 **노드 ⚠ 가 붙은 대수**였다.
    - ⚠ **테스트 22건이 전부 통과하며 놓쳤다** — 픽스처의 healthState 가 `OK`/`unknown`/빈 값뿐이라
      **`ATTN` 같은 실제 운영 값이 없었다**. 목 데이터에도 없어 Chromium 검증에서도 안 보였다(목 3대는
      노드 신호만 있었다). **실장비 문자열(`ATTN`·`ATTN_DEGRADED` 등)을 픽스처에 넣고 다시 판단할 것.**
    - ⚠ **표의 `status` 열이 '수집 성패' 라는 사실은 그대로다**(라벨은 `상태` 로 되돌렸다) — 노드가
      고장난 장비의 행이 초록 `정상` 으로 보이는 것은 **v2.566 이전부터의 상태**이고 v2.567 이 만든
      것이 아니다. 별건으로 고칠 때 v2.526 `healthBadge`·v2.542 `sectionBadge` 계열임을 볼 것.
      ↳ v2.586: 초록 `정상` 배지에 '수집 성패이지 장비 건강이 아니다 + 비정상 노드 N대' 툴팁을 붙였다(판정은 그대로).
        헬스 열(`case 'health'`)은 `healthBadge` 톤을 쓴다 — 예전 비고정 정규식 `/ok|healthy|normal/` 이
        `Broken`(**ok** 포함)·`Not OK` 를 **초록**으로 칠했다.
    - ⚠ **이미 게시된 2.567.0 번들은 되돌릴 수 없다** — 릴리스 노트에서 그 항목을 지우지 않고
      '철회됨' 으로 표시했다(v2.565 와 같은 판단).
  - **스토리지 노드 장애 표지는 클릭해 '어느 노드가 왜' 를 본다**(`web/src/views/tools/
    storageNodeText.js` + `StorageMonTool.jsx NodeFaultModal`, v2.523 — 사용자 요청 "장애표지
    클릭하면 어떤 장애인지 확인하는 팝업 만들어줘"): v2.522 까지 노드 열의 `24 ⚠1` 은 클릭되지
    않는 `<b>` 여서 **어느 노드가 비정상인지 알 방법이 없었다**(실패 사유를 툴팁에만 두지 말라는
    v2.516 규약과 같은 유형). 유지 규칙:
    - **`unknown` 을 비정상으로도 정상으로도 세지 않는다** — 수집기들이 이미 그 기준이다
      (`isilon.js:92`·`unity.js:42`: `st !== 'unknown' && !/ok|healthy/`). 화면도 같은 기준을 쓰고
      '상태를 읽지 못한 노드' 수를 **따로** 밝힌다("정상이라는 뜻도 아닙니다").
    - **노드 목록이 없는 수집기에서는 '어느 노드인지 모른다' 고 말한다** — 개수만 주는 수집기가
      있다(`powerstore.js:92`). 지어낸 노드를 보여주지도, '비정상 없음' 이라 말하지도 않는다.
    - **목록이 상한(64)으로 잘렸으면 개수를 밝힌다**(`count > list.length`). 요약 수치와 목록이
      어긋나도 숨기지 않는다("요약은 3대라고 하는데 목록에서는 1대").
    - 장비가 보고한 **원문 상태값**을 우리 판정과 나란히 둔다(판정 근거를 숨기지 않는다).
  - **수집 '작업 로그' 는 공용 팩토리 하나다**(`util/activityLog.js` + 웹 `views/tools/CollectActivity.jsx`,
    v2.516 — 사용자 요구 "스토리지 모니터링 처럼 화면 하단에 진행상태와 로그" · "실패일때 클릭하면
    구체적인 로그"):
    - 스냅샷 저장소(`store.js`)는 장비별 **최신 1건만** 보관한다 — '언제 수집했고 성공/실패였나' 는
      남지 않는다. 이 로그가 화면 '완료' 구획의 원천이고 '진행중' 은 폴러 in-flight 가 담당한다.
    - **상한(MAX, 하한 50·기본 500)을 지우지 말 것** — 28대 × 10분 주기 = 하루 4,032건이라 상한이
      없으면 파일이 무한히 커지고 매 기록마다 전량을 다시 직렬화한다. 오류 문구는 300자로 자른다
      (SSH 추적·스택이 통째로 들어온다). 상한으로 버린 것은 개수를 밝힌다.
    - **손상 파일은 `preserveCorrupt` 대상이 아니다** — 재생성 가능한 캐시이므로 새로 시작한다
      (자격증명 스토어와 의도적으로 다른 취급. 여기서 원본을 보존하면 쓸모없는 파일만 쌓인다).
    - **실패 스냅샷의 수치는 null 이다.** `emptySnapshot` 이 ports/nodes 를 0 으로 초기화하므로
      그대로 실으면 화면에 `0/0 · 0%` 가 찍혀 **'포트 0개' 라는 거짓**이 된다(v2.516 실측으로 발견 —
      `snap.ok ? snap.ports : {}` 로 걸러낸다). 폴러와 엣지 수신 **양쪽 모두** 지킬 것.
    - **엣지 push 는 `collectedAt` 으로 중복을 걸러야 한다**(`central/sanSwitchEdge.js _lastRec`,
      `storageEdge.js` 와 같은 규약) — 엣지는 주기마다 전 장비를 다시 보내므로 한 번의 수집이
      여러 건으로 기록돼 로그가 부풀고 상한을 빨리 소진한다.
    - **실패 사유를 툴팁(`title`)에만 두지 말 것** — 복사·공유가 안 되고 모바일에서는 볼 수 없다.
      v2.515 까지 SAN 스위치 장비 표의 실패 배지가 클릭 안 되는 `<span title=…>` 이었다(스토리지는
      이미 버튼이었다 — 게이팅 비대칭). 배지는 **버튼**으로, 원문은 `<pre>` 로 선택·복사 가능하게.
    - 서버 응답 형태(`{poller, events}`)를 두 도구가 **똑같이** 유지할 것 — 웹이 공용 패널 하나로
      두 화면을 그린다. 키 이름을 바꾸면 한쪽이 조용히 빈다. 주기·상한 **숫자를 문구에 박지 말 것**
      (`poller.intervalMs` 가 주는 값만 쓴다).
  - **'사용량이 왜 비어 있나' 는 판정해서 말한다 — 한 문구로 덮지 말 것**(`sanswitch/perfDiag.js` +
    웹 `views/tools/sanPerfDiagText.js`, v2.517 — 사용자 신고 "데이터 수집이 안되, edge 의 사용량도
    분석하게 해줘"):
    - v2.516 까지 포트 사용량 패널의 빈 상태는 **무조건** "설정 › 수집 서버 › SAN 스위치 포트 사용량
      에서 수집을 켜면 쌓기 시작합니다" 였다. 그 한 문구가 **행동이 정반대인 상황들**을 덮었다 —
      꺼짐(켜면 된다) / 첫 주기(**기다리면** 된다) / REST 장비(portperfshow 를 쓰지 않아 **켜도·
      기다려도 영원히** 안 쌓인다) / 명령 부재·제한 셸(**기다려도 안 된다**) / 엣지 미보고(엣지
      버전·설정 pull 문제) / 표본은 있는데 조회 기간 밖(기간을 넓히면 보인다). v2.493 '값이 없는
      이유를 단정하지 말 것' 이 정확히 이 유형이다.
    - **판정은 서버 순수 모듈 하나, 문구는 웹 순수 모듈 하나.** `perfEmptyDiag` 가 `kind` + 근거
      `facts` 를 주고 `perfDiagText` 가 문구를 만든다. `waiting`('기다리면 채워지는가')을 대충
      true 로 두지 말 것 — 화면이 "기다리세요" 라고 말해 놓고 영원히 안 채워진다.
    - **판정 순서를 지킬 것**: DB 불가 → 기간 밖 → REST → 엣지(미보고/꺼짐/실패/첫수집/push대기)
      → 중앙(꺼짐/실패/첫폴/원인불명). 엣지 위임 장비를 **중앙 폴러 상태로 판정하지 말 것** —
      중앙은 agent 없는 장비만 수집하므로(`registry.js devicesForThisNode`) 무관하다.
      `null` 시각을 `Number()` 로 통과시키면 0(1970년)이 되어 '기간 밖' 으로 오판한다(초판 결함).
    - **엣지는 표본이 0건이어도 상태를 올린다**(`perfPush.js sendStatusOnly`). 예전에는 0건이면
      push 가 조용히 조기 반환해 **중앙으로 아무것도 가지 않았고** — 그게 바로 신고된 상태다.
      중앙은 `central/sanSwitchPerfEdge.js` 에 보관하고(캐시 성격·손상 시 재생성), 장비별 결과는
      중앙 작업 로그에도 남긴다(`_lastRec` 가 이벤트 시각으로 중복 제거). 상태는 **청크 0 에만**.
      보고가 없는 엣지를 '꺼짐' 이라 말하지 말 것 — '모른다' 다.
    - **사용량 작업 로그는 기본 수집과 파일을 나눈다**(`sanswitch/perfActivityLog.js`) — 주기가
      다르다(기본 수집은 구성 조회, 사용량은 SSH 세션을 수 초 붙잡는 캡처). 한 링버퍼에 섞으면
      잦은 쪽이 상한을 먹어 다른 쪽 이력이 조용히 사라진다. **REST 장비의 '건너뜀' 은 기록하지
      않는다** — 매 주기 시도조차 하지 않으므로 상한을 비이벤트로 소진한다(그 사실은 진단이 말한다).
    - **'지금 수집' 은 엣지에도 닿아야 한다**(`collectRequests.js requestPerfCollect` — 기본 수집
      큐와 **별도 큐**, 엣지 단위 one-shot). v2.516 까지 `/tools/sanswitch/perf/collect` 는
      `pollPerfOnce` 만 불렀고 그 안의 `devicesForThisNode()` 는 중앙에서 agent 없는 장비만
      돌려주므로 **위임 장비에 아무 일도 일어나지 않았는데 화면은 말하지 않았다**. 응답은
      '즉시 N대 / 요청 M곳' 으로 나눈다. 엣지 쪽 수집은 **await 하지 말 것** — 캡처가
      표본시간×장비수라 설정 pull·연결 테스트 대행이 그만큼 밀린다.
    - **`portperfshow` 출력은 터미널 폭에 따라 줄바꿈된다**(`fosParse.parsePortPerfShow`, v2.517):
      한 블록(16포트)이 14+2 로 쪼개지면, 헤더 다음 줄을 값 줄로 단정한 예전 파서는 이어지는 헤더
      조각(`46 47`)을 값으로 읽어 **128포트 중 3개만, 그것도 엉뚱한 값으로** 저장했다(0건이 아니라
      **틀린 값**이라 화면은 정상처럼 보인다). 이어붙임은 '직전 포트 + 1' **연속성**을 요구할 것 —
      값 줄(`0 0 0 …`)도 전부 숫자라 연속성 검사가 없으면 헤더로 삼킨다.
      ⚠ 정직 기록: 사용자의 **실제 운영 로그는 줄바꿈이 없었다**(본인 확인). 즉 이 수정은 신고된
      증상의 원인이 아니라 좁은 터미널에서만 성립하는 **별건 방어**다. 포트 수는 장비마다 다르고
      (0–127 / 0–63) `Total` 은 전체 합이므로 **'포트 수가 적으면 이상' 같은 추측 판정을 넣지 말 것**
      (63포트 장비를 오탐한다).
  - **'현재 사용자' 는 게스트 계정을 쓰지 않는다 — 게스트가 발행한 값을 읽는다**(`curuser/`, v2.520 —
    사용자 요청 "vcenter 별로 설정에서 지정한 폴더의 windows 서버에서 로그인한 사용자의 수를 설정에서
    지정한 시간마다 수집" · "10분마다 db 에 저장" · "aaa 가 1개의 vcenter 의 여러 서버에 로그인해
    있으면 그건 1명" · **"Guestos 계정 없이"**):
    - **경로**: 게스트의 스케줄 작업이 `quser` 출력을 base64 로 `vmtoolsd --cmd "info-set
      guestinfo.curuser.*"` 에 실어 VMX 에 쓰고, 포탈은 vCenter `config.extraConfig` 를 **읽기만**
      한다. 게스트 계정도, 게스트→포탈 아웃바운드도 없다. `gpu/guestops.js`(NamePasswordAuthentication)
      경로로 되돌리지 말 것 — 사용자가 명시적으로 배제했다.
    - ⚠ **미검증 전제(정직 기록)**: 게스트가 `info-set` 한 값이 **재부팅 전에도** vCenter
      `config.extraConfig` 조회에 나타나는지 확인하지 못했다. 확인된 것은 ⓐ 게스트에서 비관리자도
      `vmtoolsd --cmd` 로 VM 구성을 바꿀 수 있다 ⓑ 재부팅 후 VMX 에 영구 반영된다(open-vm-tools
      issue #288) 두 가지뿐이다. 그래서 `no-agent` 문구는 '발행기 미설치 **또는** 이 환경이 노출하지
      않음' 두 가지를 **함께** 말한다 — 실장비 1대로 확인되면 문구를 좁힐 것.
    - ⚠ **이 값은 게스트가 스스로 쓴 것**이라 게스트 사용자가 위조할 수 있다 — 모니터링용이지
      **감사 증적이 아니다**. 화면의 `TRUST_NOTE` 를 지우지 말 것.
    - **게스트는 판단하지 않는다** — 원문을 base64 로 싣기만 하고 파싱·상태 지역화(`활성`/`연결 끊김`)
      판정은 포탈 `quser.js` 가 한다. 게스트에서 파싱하면 파서를 고칠 때마다 **수백 대 재배포**다.
      스크립트 내용은 **ASCII 만**(한글 주석은 인코딩에 따라 문법 오류가 된다), 발행 순서는
      **`d*` → `n` → 부가값 → `at` 마지막**(반대면 '새 시각 + 옛 데이터' 로 **거짓 신선**이 된다).
      빈 값은 `-` 로 쓴다(`info-set key ` 는 뒤에 공백만 남는다) — 읽는 쪽이 되돌린다.
    - **'확인하지 못한 서버' 를 '사용자 0명' 으로 뭉개지 말 것.** 상태는 7가지다 — `ok` / `stale` /
      `no-agent` / `guest-error` / `incomplete` / `unparsed` / `clock-skew`. `stale` 서버의 사용자는
      **세지 않고**(지금 값이 맞는지 모른다) 몇 대가 빠졌는지 화면이 밝힌다. 수치는 실패 시 `null`
      이다(0 으로 채우면 '0명' 이라는 거짓).
    - **신선도는 조회 시점에 `at`(게스트 발행 시각)으로 다시 판정한다**(`report.js refreshKinds`) —
      엣지가 push 를 멈추면 중앙 DB 에 `kind:'ok'` 로 며칠 전 값이 남는다. `no-agent`·`guest-error`·
      `unparsed` 는 신선도로 덮어쓰지 않는다(원인을 지우지 않는다).
    - **주기는 두 개이고 합치지 말 것** — ① 포탈이 읽는 주기(`intervalMs`, 기본 10분) ② 게스트
      발행 주기(`guestPublishMs`, 각 서버 schtasks 가 정하므로 포탈이 강제 못 한다). 신선도 경계는
      **②×배수**다. 합치면 포탈 주기를 바꾸는 순간 게스트에 손도 안 댔는데 전 서버가 '오래됨' 이 된다.
    - **메인 인벤토리 수집에 `config.extraConfig` 를 넣지 말 것** — 5,850 VM × 수십 키가 매 폴링마다
      실려 온다. `curuser/collect.js` 가 **대상 moref 만** 따로 배치 조회한다(주기 10분, 왕복 1~2회).
      `vcenter/orphanScan.js` v2.505 와 같은 판단이며 테스트가 고정한다.
    - **폴더 범위가 비면 수집하지 않는다**(전체 VM 으로 확대 해석 금지). 기본 꺼짐(opt-in).
    - DB 계열 수는 먼저 계산했다 — vCenter별 추이 연 152만행(보존 180일 ≈ 75만행), **VM 단위 계열은
      `CURUSER_VM_SERIES=1` 옵트인**(연 2,100만행). 계정명은 **최신 1건에만** 두고 시계열에 넣지 않는다.
    - 화면 회귀(스크린샷 판독으로 잡은 것 — 수치로는 안 잡혔다): 루트 그리드에 `minWidth:0` 만으로는
      부족하고 **열 트랙을 `minmax(0,1fr)`** 로 못 박아야 한다(암시적 트랙이 `auto`=max-content 라
      표가 뷰포트를 넘긴다. 400px 실측 357px → 기준선 228px). 설정 숫자칸도 `minWidth:0` 이 없으면
      설명문 폭으로 자라 옆 칸과 겹친다.
  - **Horizon 실시간 사용자는 '접속 중 세션의 고유 계정' 이다**(`horizon/sessions.js`·`sessionCollect.js`·
    `sessionDb.js`·`sessionPoller.js` + 웹 `views/tools/HorizonSessionsPanel.jsx`·`horizonSessionText.js`,
    v2.525 — 사용자 요청 "Horizon 솔루션 사용중인데 실시간 사용자를 뽑고 싶어"):
    - **화면은 '현재 사용자' 하나이고 소스 탭으로 나눈다**(사용자 선택 "한 화면에 합치기 — 소스 탭"):
      `전체(합집합) | Windows 서버 | Horizon(VDI)`. 전체 = **Windows ∪ VDI**(`curuser/combine.js`) —
      같은 사람이 양쪽에 있으면 1명이다. **단순 합과 겹친 인원을 함께** 낸다(하나만 보여주면 전제가
      감춰진다). ⚠ 한 출처를 못 읽으면 `partial` 로 밝히고 **'전체' 라고 말하지 않는다**.
      ⚠ '레코드가 있다' 를 '읽었다' 로 뭉개지 말 것 — 전 서버가 `stale`/`no-agent` 면 지금 유효한 값은
      **하나도 없다**(목 데이터 실측: 43대 중 stale 41·no-agent 2 인데 `state:'ok'` 였다. `kinds.ok > 0`
      을 본다).
    - **상태 필드를 읽지 못하면 `connected` 는 0 이 아니라 null** 이다 — 0 은 '지금 아무도 없다' 는
      거짓이다. 한 서버라도 못 읽으면 **합계도 단정하지 않는다**(부분 합이 더 위험한 거짓).
    - **계정명이 없고 SID 만 있으면 `userIdOnly` 로 밝힌다** — SID 로도 인원 수는 정확하지만 **이름을
      보여줄 수 없다**. SID 를 이름인 척 표시하지 말 것. SID 는 Windows 쪽 이름과 **절대 겹치지 않으므로**
      합집합에서 `sidOnly` 로 그 사실을 적는다(실제로는 같은 사람일 수 있다 — 지어내지 않는다).
    - ⚠ **응답 필드명을 확인하지 못했다**(정직 기록): `developer.broadcom.com` 등 공식 문서가 이 환경의
      egress 정책에서 차단이다. 경로 `GET /rest/inventory/v1/sessions`(page·size, size 최대 1000)와
      필터명 `user_name`·`desktop_pool_id`·`machine_name`·`client_name`·`state`, 상태값
      `CONNECTED`/`DISCONNECTED`/`PENDING` 은 `matt-coppinger/horizon-mcp`
      (`src/horizon_mcp/tools/inventory.py:533-556`, "verified against 2512~2606")에서 직접 읽었고,
      응답의 **계정명 필드가 `user_name` 인지는 미확정**이다. 그래서 **후보 키 체인**으로 읽고
      `usedUserKey`/`usedStateKey` 를 화면이 밝힌다(v2.522 `usedCmds` 규약). 실장비 응답을 받으면
      체인을 좁히고 고지를 지울 것 — **체인을 '기본값 user_name' 으로 굳히지 말 것.**
    - **로그인·로그아웃·TLS·SSRF 설정은 `horizon.js withHorizonSession` 하나가 갖는다** — 라이선스
      조회와 공용이다. 복사하면 `dispatcher`(사설 인증서·DNS 리바인딩 가드)와 로그아웃 누락 방지가
      두 갈래로 갈라진다. **새 Horizon 조회를 추가하면 이 함수를 쓸 것.**
    - **자격증명 스토어를 새로 만들지 않는다** — 설정 › Horizon 등록(`horizon.json`)을 재사용한다.
      비밀 승계(`util/secretCarry.js`)·SSRF 가드를 두 곳에서 지키게 만들지 말 것.
    - 실패는 **원인별로** 구분한다(`auth`/`no-endpoint`(404)/`http`/`timeout`/`unparsed`) — 조치가
      정반대다. **자동 재시도 금지**(AD 계정 잠금). 기본 **꺼짐(opt-in)**, 주기 5분(하한 1분).
    - DB 는 `horizon-sessions.db` — **원시 세션 객체를 저장하지 않는다**(1만 세션을 매 주기 직렬화하지
      않기 위해 계정·풀 집계만). 실패 주기의 수치는 **NULL**. ⚠ `Number(null) === 0` 이라
      `Number.isFinite(Number(v))` 만 보면 **null 이 0 으로 바뀐다** — v2.525 의 자체 테스트가 이 결함을
      `sessionDb.nOrNull`·`sessions.seriesRow`·웹 `unionNote` **세 곳에서** 잡았다. 새 null 허용 수치를
      쓸 때 `v == null` 을 먼저 볼 것.
    - Horizon 은 **vCenter 에 매인 자원이 아니다** — 법인 범위로 나눌 축이 없으므로 범위 제한 계정에는
      **403(`requiredOwner`)** 으로 거절한다. 빈 값을 주면 '사용자 0명' 이라는 거짓이 된다.
  - **Horizon 서버 등록도 CSV/자유텍스트 대량 등록을 쓴다 — 코어는 그대로 하나다**(`horizon/bulk.js` +
    `routes/admin/horizonAssign.js`, v2.525 — 사용자 요청 "호라이즌 서비스에 호라이즌 서버 등록이
    필요하면 csv/text import/export 기능 추가해줘"):
    - **판정 코어는 `util/bulkImport.js`**(v2.513), 화면은 `views/tools/BulkDeviceIo.jsx` 하나다.
      도구마다 다른 것만 주입한다 — 경로 조각(`resource='servers'`)·단위 이름(`unitLabel`)·타입 열
      숨김(`typeCol={null}` — Horizon 은 장비 타입이 없다).
    - ⚠ **식별 키는 `id` 단독**이다(`upsertHorizon` 이 id 로 찾고 **host 중복을 거부하지 않는다**).
      스토리지 `host+type`·SAN 스위치 `host` 와 다르다 — host 로 두면 정상 구성(같은 host, 다른 id)이
      막히고 id 중복은 **조용히 덮어써진다**.
    - ⚠ **host 의 정답 형식이 도구마다 다르다.** Horizon 은 `https://커넥션서버` 가 **필수**라
      기본 조언("URL 이 들어갔습니다 — 주소만 남기세요")은 **틀린 조언**이 된다(Chromium 판독에서 실제로
      떴다). `enrichAdvice(..., { hostForm: 'url' })` 로 알려줄 것 — **조언이 틀리면 무음 실패보다 나쁘다**
      (사용자가 잘못된 수정을 한다). 같은 이유로 중복 조언도 **그 도구의 키 이름**을 지목한다
      (`specialAdvice` 가 사유 문자열에서 키를 뽑는다 — 언제나 'host' 라고 말하던 것을 고쳤다).
    - **접속처(host·계정·도메인)가 바뀌면 저장 비밀을 승계하지 않는다**(v2.503 규약) — 그 행은
      비밀번호를 비우면 검증이 'password는 필수입니다' 로 떨어진다. **이것이 정상 동작**이고 우회를
      만들지 말 것. 저장 시 폐기된 비밀은 `skipped` 에 사유로 실어 **사용자에게 알린다**.
    - 내보내기·샘플에 **비밀번호를 담지 않는다**. 연결 테스트는 `bulkRun`(kind `'horizon'`) 재진입
      가드 — 연타가 AD 로그인 시도를 곱하지 않게.
  - **Unity(uemcli) SSH 수집 — '수집은 됐는데 정보가 없다' 의 원인은 파싱이었다**(`storage/collectors/
    unitySsh.js`·`cliSsh.js`, v2.525 — 사용자 신고 "unity 장비에 ssh 로 접속은 성공했는데, 수집하는
    정보가 없어 / 용량 정보 확인 및 장비 구성정보 등 최대한 많은 정보를 수집해줘"):
    - ⚠ **`toBytes` 는 uemcli 의 `12094627905536 (11.0T)` 표기를 받아야 한다.** 예전 정규식은
      `^숫자+단위$` 만 받아 이 형태를 **0 으로 버렸고**, `if (!t) continue;` 가 그 풀을 건너뛰어
      **풀 0개 · 용량 섹션 '건너뜀'** 이 됐다(화면은 `0.0 TB`). **앞의 정수 바이트를 우선**할 것 —
      괄호 안은 반올림이라 그것을 쓰면 추이에 없는 계단이 생긴다.
    - ⚠ **CSV 파서 결과가 '비어 있지 않다' 를 '읽었다' 로 쓰지 말 것.** uemcli 배너에 쉼표가 하나만
      있어도 그 줄이 헤더로 잡혀 **필드 없는 레코드 1건**이 생겼고, 화면에 `SP 1대 · 이름 SP0 · 상태 ?`
      로 **없는 장비가 있는 것처럼** 보였다. `recordsFor(text, expect)` 가 CSV·Key=Value 를 **기대 필드
      적중 수로 채점**하고, **기대 필드가 하나도 없는 레코드는 버린다**. 둘 다 0점이면 빈 배열이다.
    - **명령은 항목마다 후보 체인**이고 `core`(용량·상태)와 `deep`(구성 상세)로 나뉜다.
      `UNITY_SSH_DEEP=0` 으로 deep 을 끌 수 있고 **끄면 화면이 밝힌다**(`extra.deepSkipped`).
      **쓰인 명령(`usedCmds`)과 실행되지 않은 명령(`missingCmds`)을 둘 다 표시할 것** — 구성 정보가
      비어 있는 이유를 사용자가 알아야 한다.
    - ⚠ **실장비 출력을 일부만 확인했다**(정직 기록): v2.525 시점에는 전혀 확인하지 못했고, v2.526 에
      사용자가 `svc_diag -s spinfo`·`pool -detail`·`/env/disk show`·`/stor/prov/luns/lun show` 출력을
      제공해 **그 넷은 실제 값으로 맞췄다**. 나머지 명령(포트·NAS·파일시스템·라이선스 등)은 여전히
      Unisphere CLI 지식 기반 추정이고 버전마다 있는 것과 없는 것이 다르다. 그래서 파싱이 아무것도
      못 읽으면 **그 항목을 만들지 않는다**(0 을 지어내지 않는다). 원문은 **연결 테스트에서만** 전부
      담고(주기 수집은 실패한 명령만 — 20여 개 × 4KB 를 매 주기 push 하지 않기 위해) 화면이 보여준다.
    - **상태를 읽지 못한 것(`unknown`)을 정상으로도 이상으로도 세지 않는다** — 디스크·팬·PSU·포트
      전부 '상태 미확인 N' 을 따로 밝힌다(v2.523 스토리지 노드 규약과 같다). 라이선스의 설치 여부를
      읽지 못하면 `false` 가 아니라 **null**('?')이다.
    - **용량 합계는 풀 합계**이고 그 사실을 화면이 밝힌다(**`capacityBasisNote`** — v2.526 에 키를
      바꿨다. 아래 참조) — 풀 밖 미할당 드라이브는 빠진다. **용량을 못 읽은 풀은 합계에서 빼고
      개수를 밝힌다**(`poolsUnreadable`).
    - 경보 목록은 `extra.alertsList` 에 둔다 — `types.js` 의 공용 스냅샷 계약은 `alerts:{unresolved}`
      뿐이고 거기에 타입별 필드를 끼워 넣으면 다른 수집기·중앙 수신과 계약이 어긋난다.
  - **Unity 수집의 진짜 원인은 '인증서 확인 프롬프트' 였다 — 파싱 결함은 별건이었다**(`proxy/sshExec.js`
    `execAnswered`·`storage/collectors/unitySsh.js`·`svcDiag.js`, v2.526):
    - ⚠ **정직 기록 — v2.525 의 진단은 절반만 맞았다.** `toBytes`·CSV 배너 결함은 실재하고 테스트로
      고정돼 있지만, 사용자가 신고한 '접속은 되는데 정보가 없다' 의 **실제 원인은 그것이 아니었다**:
      `uemcli` 첫 실행이 `Please input your selection (The default selection is [1]):` 에서 멈춰
      **명령이 아예 끝나지 않았다**(사용자 캡처로 확인). 그래서 `execAnswered` 로 프롬프트에 자동
      응답한다(`PROMPT_RULES` — 페이저 `--More--` 규칙과 같은 틀. v2.522 `execPaged` 를 일반화한 것).
    - ⚠ **인증서 선택지에서 `[3] Accept and store` 를 절대 고르지 말 것** — 그 선택은 **고객 어레이에
      상태를 쓴다**. 항상 `1`(이 세션에만 허용)이다. 응답 문자열을 '더 편한 쪽' 으로 바꾸지 말 것.
      출력 앞에 붙는 배너·프롬프트 잔재는 `stripUemcliBanner` 가 제거한다(안 하면 첫 레코드가 깨진다).
    - **`svc_diag -s spinfo` 는 Unisphere 계정 없이 하드웨어 정보를 준다**(이 현장 `service` 계정은
      Unisphere 계정이 아니다 — 사용자 확인). FRU 상태·부품 인벤토리·전원(W/V/℃)·DPE 온도가 나온다.
      `storage/collectors/svcDiag.js` 는 **사용자가 준 실제 출력**으로 만든 순수 파서다.
    - ⚠ **`REMOVED` 는 고장이 아니라 빈 슬롯이고, `UNKNOWN` 은 정상도 고장도 아니다.** 실측: SPA 의
      DIMM 24칸 중 OK 가 정확히 12칸이고 12 × 8GB = **96GB** 로 접속 배너와 일치한다. REMOVED 를
      이상으로 세면 **정상 장비에 장애 12건**이 찍힌다. 상대 SP 의 DIMM 이 전부 UNKNOWN 인 것도
      '읽지 못한 것' 이다. 넷(`ok`/`empty`/`unknown`/`fault`)을 각각 세고 화면이 각각 밝힌다.
    - **`temp: 21` 은 상태가 아니라 수치**(DPE 온도)이고 **`ps0: OK 330` 의 330 은 입력 전력(W)** 이다
      (`Input Power : 330 Watts` 와 교차 확인). 그래도 단정하지 않고 **두 출처를 나란히 싣는다**.
    - **구성 정보는 긴 주기로만 수집한다**(`CONFIG_EVERY_MS` 기본 6시간, `UNITY_CONFIG_EVERY_MS`) —
      매 주기 20여 개 SSH 명령을 돌리면 장비와 회선을 붙잡는다. 용량·상태(`when:'always'`)는 매 주기다.
      화면은 **`extra.configAt` 으로 언제 수집한 구성인지 밝힌다**(낡은 값을 지금 값인 척하지 않는다).
    - ⚠ **`extra.capacityNote` 라는 키를 재사용하지 말 것**(v2.526 에 Chromium 판독으로 발견한 실제
      결함): 화면의 `isVirt`(`StorageMonTool.jsx`)가 그 키의 **존재만으로** 'VPLEX/Metro Node — 자체
      용량 없는 가상화 계층' 으로 판정해 **그 장비의 용량 추이 차트를 통째로 숨겼다**. 두 문구는 뜻이
      다르다 — VPLEX 는 '용량이 없다', Unity 는 '용량 숫자를 이렇게 읽으라' 다. Unity 는
      **`capacityBasisNote`** 를 쓰고, `isVirt` 는 이제 `sections.capacity === 'skip'` 도 함께 본다.
    - ⚠ **헬스 배지 색 판정은 `views/tools/storageNodeText.js healthBadge` 하나가 소유한다**(v2.526):
      예전에는 `'healthy'` 문자열만 초록이라 Unity 의 `'OK'` 가 **빨간 `Health: OK`** 로 나왔다
      (배지 색과 글자가 반대말을 한다 — 사람은 색을 먼저 읽는다). `ok|healthy|normal|good` 로 시작하면
      초록, **`unknown`·빈 값은 빨강이 아니라 회색**('확인 불가' 는 이상이 아니다), 그 밖은 원문 그대로 빨강.
    - **픽스처 `test/fixtures/spinfo-sample.txt` 는 합성값이다**(공개 저장소 — v2.513 규약). 단
      **두 관계는 보존한다** — ① DIMM OK 12칸 × 8GB = 96GB ② `ps0: OK 330` ↔ `Input Power : 330 Watts`.
      테스트가 일련번호 접두 `SYNTH` 를 검사하므로 실장비 캡처를 다시 커밋하면 CI 가 깨진다.
    - ⚠⚠ **명령을 늘릴 때는 시한 예산을 함께 볼 것**(v2.528 — v2.526 이 만든 **전량 실패** 회귀.
      사용자 신고 "수정 이후에 유니티 ssh 안되"): v2.526 이 Unity 명령을 **5개 → 24개**로 늘렸는데
      폴러의 장비 시한(`storage/poller.js DEVICE_TIMEOUT_MS` 기본 **180초**)은 그대로였다.
      명령당 시한이 45초(`cliSsh.js CMD_TIMEOUT_MS`)라 **느린 명령 4개면 180초를 넘고**, 그 순간
      `withDeadline` 이 던져 **그때까지 모은 결과가 통째로 버려진다**(용량·상태까지). 즉 '일부가
      빈다' 가 아니라 **그 장비가 통째로 실패**한다 — 증상이 '접속이 안 된다' 처럼 보인다.
      · 이제 `runCliSession` 이 **세션 예산**(`STORAGE_CLI_SESSION_BUDGET_MS` 기본 150초)을 보고
        스스로 멈춘다 — 남은 시간이 부족하면 새 명령을 **시작하지 않고** 여기까지의 결과를 돌려준다.
        시작해 놓고 잘리면 그 결과는 버려지므로 `MIN_SLICE_MS` 아래면 아예 시작하지 않는다.
      · **세션 예산은 장비 시한보다 반드시 작아야 한다** — 같거나 크면 이 가드가 발동하기 전에
        폴러가 먼저 던져 회귀가 그대로 재발한다(`unitySshBudget2528.test.js` 가 두 숫자를 고정한다).
      · **필수 항목은 예산을 무시한다**(없으면 스냅샷이 무의미하다). 그래서 `SPECS` 순서가 계약이다 —
        **필수 → 매주기(always) → 구성(config)**. 순서를 흔들면 예산이 모자랄 때 용량·상태를 잃는다.
      · 건너뛴 항목은 **사유와 함께** 보고한다(`errors[key]` + `extra.cliSkipped`) — '이 장비에 그
        명령이 없다' 와 '이번에 시간이 모자랐다' 는 **조치가 다르다**. 조용히 생략하지 말 것.
    - ⚠⚠ **v2.530 정정 — 원인은 명령 순서가 아니라 `SSH 터미널 폭` 이었다**(사용자 신고
      "unity 스토리지 지금 파싱이 안되" + **실장비 출력 3건 제공**):
      · v2.525 CSV 우선 → 실패 · v2.526 평문 우선 → 실패 · v2.529 CSV 우선 → 실패.
        **셋 다 실패했다는 사실 자체가 순서는 원인이 아니라는 증거**였는데 세 번 모두 순서만
        뒤집었다. 실제 원인은 그 아래층 — `proxy/sshExec.js` 의 `execAnswered` 가
        `{ pty: true }` 로 **ssh2 기본 80칸 터미널**을 요청했고, 장비는 TTY 폭에 맞춰 출력을 접는다.
      · 80칸에서 접힌 `-output csv` 를 **사용자가 준 실제 값으로 재현·실측**한 결과:
        ① `Current allocation` 이 `"29973242855424 (27.2T"` 로 잘리고 ② 접힌 조각이 데이터 줄로
        읽혀 **`ID=47%` · 이름 `38 x 3.8T SAS Flash 4` 인 없는 풀 1개**가 만들어졌다.
        사용자가 **넓은 터미널로 손수 돌린** 같은 명령은 멀쩡했다 — 그것이 결정적 단서였다.
        v2.517 `portperfshow` 줄바꿈과 **같은 계열**인데 그 교훈을 여기에 적용하지 못했다.
      · 수정은 둘이고 **둘 다 필요하다**: ① `sshExec.js WIDE_PTY`(기본 1000칸, `SSH_PTY_COLS`)
        ② `cliSsh.parseCsv` 가 **줄이 따옴표 안에서 끊겼거나 열 수가 헤더와 다르면 CSV 를 통째로
        거부**한다(장비가 요청 폭을 무시할 수 있다). **일부를 살리려 하지 말 것 — 틀린 값은 빈
        값보다 나쁘다**(화면이 정상처럼 보인다). 빈 배열이면 Key=Value 로, 그래도 안 되면 명령
        체인의 다음 후보로 넘어간다 — 안전한 쪽으로 실패한다.
      · **uemcli 후보의 첫 자리는 이제 평문(기본 출력)이다.** 이 장비에서 실제 출력을 받아 본
        형식이 평문뿐이기 때문이고(`test/fixtures/uemcli-*.txt` — pool show · pool show -detail ·
        lun show), 그 이상의 주장이 아니다. **이 장비의 `-output csv` 출력은 한 번도 보지 못했다** —
        캡처를 받으면 다시 판단할 것. `unityUemcli2530.test.js` 가 순서와 실제 수치를 고정한다.
      · **픽스처는 실장비 캡처의 형식만 옮기고 식별자는 합성**했다(v2.513 규약, 공개 저장소).
        단 **용량 수치와 괄호 표기는 보존**한다 — `117544396521472 == 106.9T`,
        `29973242855424 == 27.2T`, `55491782770688 == 50.4T (47%)`, LUN `54975581388800 == 50.0T`.
        접속 배너와 인증서 수락 프롬프트도 지우지 말 것(`stripUemcliBanner` 검증분이다).
      · `-detail` 없이 `pool show` 만 성공하면 **사용량 필드가 아예 없다** — 그대로 두면 화면에
        `0 · 0%` 라는 거짓이 찍힌다. 전체 − 잔여로 되돌려 쓰되 **계산값임을 `usedSource` 로
        구분해 밝힌다**(실측 대조: 106.9T − 79.6T = 27.26T vs 장비 보고 27.2T).
  - **스토리지 증가량은 '일 단위 롤업' 을 비교한다 — 원시 표본을 5년 쌓지 않는다**
    (`storage/db.js capacity_daily`·`storage/growth.js`·`storage/growthSettings.js` + 웹
    `views/tools/StorageGrowthTool.jsx`·`storageGrowthText.js`, v2.531 — 사용자 요청 "특수기능에
    스토리지 증가량 메뉴 · 기간별 증가량을 매트릭스 형태로 · 저장 기간을 설정에서 지정하고 기본 5년 ·
    1일/1주/1달/3개월 등 · 증가 단위 1GB/1TB 구분 · 임원 보고용 보고서 형태"):
    - **보존은 두 단계다**: 원시(`capacity_history`, 기본 90일) + **일 롤업(`capacity_daily`, 기본
      5년)**. 실제 계산으로 정한 것이다 — 5년을 원시로 두면 장비당 `폴링/일 × 1,825일` 이라
      10분 주기였을 때 262,800행/장비(20대 ≈ 525만 행·400MB 추정)였다. 증가량 분석에 필요한
      해상도는 **하루 1점**이고 그때는 1,825행/장비(20대 3.6만 행)다. **합치지 말 것.**
    - 일 롤업은 **그 날의 마지막 관측**을 쓴다(평균이 아니다 — 평균은 수집이 몰린 시간대에
      끌려간다). upsert 는 `last_ts` 가 더 늦을 때만 갱신한다(엣지 push 는 순서대로 오지 않는다).
      `samples` 를 남겨 '그 날은 수집이 1번뿐이었다' 를 화면이 말할 수 있게 한다.
    - ⚠ **`snap.ok` 는 '용량을 읽었다' 가 아니다**(v2.531 에 고친 결함): `unitySsh.js:609` 는
      `ok = (config==='ok' || capacity==='ok')` 이고 `isilonSsh.js:194` 도 같으며 `vplex.js:64` 는
      용량 섹션이 **의도적으로 skip** 인데 ok 다. 그래서 예전에는 `emptySnapshot` 의 초기값
      `{totalBytes:0}` 이 그대로 적재돼 **0 바이트 행**이 쌓였고, 증가량 화면에서 그 한 점은
      `−106TB → +106TB` 라는 거짓 급변이 된다. 판정은 `capacityPointEligible()` 하나가 갖는다 —
      **전체 용량이 유한한 양수**일 때만 적재한다. 되돌리지 말 것.
    - ⚠ **prune 을 `saveAreaResults` 안에만 두지 말 것**(v2.531 에 고친 결함): 그 함수는
      `areasCollector.js` 에서만 불리고 그것은 **중앙 직접 수집 Isilon 전용**이라, Isilon 이 없거나
      전부 엣지 위임인 법인에서는 `capacity_history` 가 **한 번도 정리되지 않았다**. 보존 기간을
      설정으로 여는 마당에 집행이 안 되면 설정이 거짓말이 된다. 스로틀은 `(++tick % N) === 0`
      (v2.453 규칙 — 기동 첫 틱에 즉시 참이 되면 안 된다).
    - **하루 경계는 한국 시각(UTC+9)** 이다(`DAY_OFFSET_MIN`, `STORAGE_GROWTH_TZ_OFFSET_MIN`).
      UTC 로 자르면 한국 기준 오전 9시에 날이 바뀌어 '어제 증가량' 이 사람이 세는 하루와 어긋난다.
    - **증가량 화면의 정직성 규칙**(`growth.js` 머리말 + `storageGrowthText.js` 가 짝으로 고정):
      ① 기준선이 없으면 **`null`**(화면 '—')이고 **왜** 없는지 말한다 — 관측 10일로 30일 증가량을
      만들지 않는다 ② 요청한 날짜에 수집이 없으면 그 이전 가장 가까운 날과 비교하고 **`exact:false`
      + 실제 `spanDays`** 를 밝힌다(숨기면 31일 증가량이 30일로 보고된다) ③ **합계는 기준선이 있는
      장비만** 더하고 `partial`·`measured`·`missing` 으로 밝힌다 — 부분 합을 '전체' 라 말하는 것이
      이 기능의 최악의 거짓이다 ④ 감소(−)를 0 으로 깎지 않는다 ⑤ 소진 예상은 **증가 중 + 전체
      용량을 알 때만** 내고 **근거로 쓴 기간(`basis`)** 을 함께 낸다(1일 추세로 수년을 외삽하지 않게).
    - ⚠ **'관측 N일' 은 조회 구간이 아니라 그 장비의 전체 이력**이다(`db.dailySpans()`).
      조회는 '가장 긴 기간 + 1일' 로 좁히므로 그 값을 쓰면 **700일치를 가진 장비가 '92일' 로 보인다**
      (v2.531 스크린샷 판독에서 발견). 첫 관측 이후 수집이 없던 날은 `gapDays` 로 밝힌다.
    - ⚠ 값이 없는 칸('—')에 **'≈'(구간 근사) 표시를 붙이지 말 것** — 비교 자체를 못 했는데
      '근사 구간' 이라 하면 뜻이 없고 기호 오류처럼 보인다(같은 판독에서 발견).
    - **폴링 금지** — 일 롤업을 읽을 뿐이라 장비 왕복은 0 이지만 5년 × 장비수 행을 매번 읽는다.
      마운트 1회 + 버튼만(`v4Portal2508.test.js` 규약과 같은 판단).
    - **`/tools/storage-growth*` 는 별도 도구 키다**(`auth/toolAccess.js`) — `storage` 와 묶으면
      증가량만 막고 싶을 때 모니터링 화면까지 같이 막힌다.
    - ⚠ **스토리지 수집 기본 주기는 v2.531 에 10분 → 1시간이 됐다**(사용자 지시). 용량은 완만히
      변하고, Unity 처럼 한 주기에 수십 개 SSH 명령을 도는 수집기가 늘었다. **테스트에 기본값을
      박지 말 것** — `INTERVAL_SPEC` 에서 읽는다(v2.531 에 `storageIntervals.test.js` 4건이 이것으로
      깨졌다). '기본값이 얼마인가' 는 `storageGrowth2531.test.js` 가 한 곳에서 고정한다.

  - ⚠⚠ **Unity(uemcli) 파싱은 v2.542 에 전면 재작성됐다 — 명령 26개 → 3개**(사용자 지시
    "지금까지 만든 모든 unity480 파싱 삭제하고 내가 지금 보낸 것에 대한 파싱만 해서 자료 채워줘.
    기존에 만들었던 unity480 파싱 자료와 혼합해서 사용하면 더 복잡해진다"):
    - **버린 것과 이유**: ① `-output csv` 후보 — **이 장비의 CSV 출력을 한 번도 본 적이 없다**
      (v2.530 이 그렇게 적어 두었다). 못 본 형식을 위한 후보가 항목마다 시한(45초)을 두 배로
      쓰게 했고 v2.525·2.526·2.529·2.530 **네 번의 헛수정**을 만든 원인이다 ② 명령별 후보 체인
      ③ `deep`/`config` 2단 수집 + 6시간 구성 캐시 ④ `recordsFor`(CSV/Key=Value 채점) ·
      `normalizeUnitySsh` · `specsFor` ⑤ `svc_diag -s spinfo` **호출**(파서 `svcDiag.js` 는
      파일로 남겼지만 이 경로에서 부르지 않는다 — 사용자가 준 세 출력에 SP 하드웨어가 없다).
    - **직접 증거**: v2.541 화면에 `config: 명령 출력이 끊겼습니다(시한 초과 · 자동응답 0회 ·
      45초 · 26B 수신)` 와 `accounts: 수집 시간 예산 초과로 이번 주기에는 실행하지 않았습니다`
      가 함께 찍혔다 — **명령 수가 예산(150초)을 다 먹어** 뒤 항목은 시도조차 못 했다.
    - **파서의 유일한 규칙은 ` = ` 다**(`collectors/uemcliParse.js`). uemcli 의 사람이 읽는
      출력은 `키 = 값` 이고 **배너는 `: ` 로 갈린다**(`Storage system address: 127.0.0.1`).
      첫 ` = ` 로만 자르면 v2.525 의 '배너 쉼표가 헤더로 잡혀 없는 장비가 생긴다' 와 v2.530 의
      '80칸에서 접힌 CSV 가 없는 풀을 만든다' 가 **둘 다 구조적으로 사라진다**(둘 다 CSV 결함).
      레코드 경계는 줄 맨 앞의 `N:` 다. **CSV 경로를 되살리지 말 것** — 캡처를 받은 뒤에 판단한다.
    - **실행하는 명령은 이 셋뿐이다**: `pool show -detail` → `general/system show` →
      `pool show`(폴백). `unitySshBudget2528.test.js` 가 **명령 수 × 명령당 시한 ≤ 세션 예산**을
      산수로 고정한다 — **명령을 늘리려면 그 테스트를 먼저 볼 것.**
    - ⚠ **짧은 `pool show` 에는 `Current allocation` 이 없다.** `전체 − 잔여` 로 되돌려 쓰되
      `usedSource:'computed'` 로 밝힌다 — 실측 차이는 **정확히 `Preallocated`**(2400305152B)
      만큼이고 그대로 두면 사용량이 그만큼 과다해진다.
    - **채우지 않는 섹션을 '오류' 라 하지 않는다** — nodes·accounts·alerts 는
      `미수집(이 수집 방식에서는 조회하지 않습니다)` 이고 수치는 **null**(0 은 '노드 0대' 라는
      거짓). 배지 색 판정은 `storageNodeText.sectionBadge` 하나가 갖는다 — 예전 인라인 판정은
      `ok`/`skip` 이 아니면 **전부 빨간 '오류'** 라 미수집이 장애처럼 보였다(v2.526 `healthBadge`
      와 같은 유형 — 사람은 색을 먼저 읽는다). **미수집을 오류로, 오류를 회색으로 되돌리지 말 것.**
    - **원문(`cliRaw`)은 주기 수집에서도 전부 싣는다** — 명령이 3개뿐이라 수 KB 다. 실패분만
      싣던 예전 방식으로 되돌리면 '성공 표시인데 값이 비었다' 를 볼 수 없다.
    - 픽스처는 `test/fixtures/uemcli-{pool-detail,system-show,pool-show}-2542.txt` 이고
      **용량 수치·괄호 표기는 실장비 원본 그대로**다(식별자만 합성 — v2.513 규약).
      회귀는 `unityUemcli2542.test.js` **하나**가 갖는다(`unitySsh2525`·`unityUemcli2530`·
      `unityCapacity2540` 은 삭제했다 — 옛 구조를 고정하던 테스트다).
    - ⚠ **정직 기록**: `26B 수신` 의 **원인은 확정하지 못했다**. 명령 3개로 줄여 예산 소진은
      없앴지만, 그 26 바이트 정지가 다른 원인(장비 측 대화형 프롬프트 등)이라면 **여전히 실패한다**.
      그때는 상세의 CLI 원문에 그 26 바이트가 그대로 보인다 — 그것을 근거로 다시 판단할 것.
  - ⚠⚠ **Unity SSH 는 PTY 를 요청하지 않는다 — `[sudo] password for root:` 의 원인이 PTY 였다**
    (`proxy/sshExec.js ABORT_PROMPTS`·`storage/collectors/cliSsh.js pty:false`, v2.543 —
    사용자가 **직접 재현해 확정**):
    - **재현(사용자 단말, 같은 계정 `service`·같은 명령·같은 호스트, 차이는 `-tt` 뿐)**:
      `ssh host 'uemcli /stor/config/pool show -detail'` → **정상 출력 3.737초** /
      `ssh -tt host '(같은 명령)'` → `[sudo] password for root:` 에서 **정지**(Ctrl-C).
      프롬프트가 출력보다 **먼저** 왔으므로 `uemcli` 는 **실행조차 되지 않았다**.
      화면의 `26B 수신` 은 `[sudo] password for root: ` 의 **정확한 바이트 수**다.
    - ⚠ **v2.530 의 `WIDE_PTY`(1000칸)는 PTY 가 만든 줄바꿈을 PTY 로 막으려던 것**이다.
      PTY 가 없으면 장비가 폭에 맞춰 접을 이유 자체가 없다(사용자의 비-PTY 출력이 한 줄도
      접히지 않았다). **PTY 를 되살리지 말 것** — `sudoPty2543.test.js` 가 `pty:false` 를 고정한다.
      프롬프트 자동 응답은 그대로 둔다(PTY 없이도 exec 채널 stdin 에 쓸 수 있다).
    - ⚠⚠ **답할 수 없는 프롬프트에는 비밀번호를 보내지 않는다**(`ABORT_PROMPTS`). 장비가 묻는
      것은 **root** 비밀번호이고 포탈은 service 계정 것만 갖고 있다 — 틀린 값을 반복하면
      **계정이 잠긴다**(`bulkRun.js` '자동 재시도 금지' 와 같은 사고). 즉시 세션을 끊고
      사유를 싣는다(45초 시한을 버리면 명령 수 × 45초가 세션 예산을 통째로 먹는다).
    - **끊긴 명령은 실패다**(`cliSsh.commandCut`). v2.542 까지 `ok` 는 `!cliLooksError` 하나여서
      sudo 26 바이트가 오류 문구가 아니라는 이유로 ① 화면이 `✓ 성공 3 · 실패 0` 이라 했고
      (**동시에 '끊긴 명령 3건'** 이었다) ② 더 나쁜 것 — **그 26 바이트가 명령의 정상 출력으로
      저장돼** 파서가 '형식이 다르다' 고 **엉뚱한 탓**을 했다. 네 번의 헛수정(v2.525·2.526·
      2.529·2.530)이 전부 그 거짓 신호를 보고 파서를 고친 것이다.
    - **머리말이 원인을 말한다**(`unitySsh.applyCutInfo`). 중단됐을 때도 맨 위가
      `uemcli 출력을 읽지 못했습니다` 였다 — 형식 탓이고, 진짜 원인은 CLI 원문을 **펼쳐야만**
      보였다. 섹션 문구는 **짧게**(섹션이 6개라 긴 문장을 넣으면 같은 문단이 한 화면에 6번
      반복된다 — v2.509 규약. **스크린샷을 읽어야 보인다**), 긴 사유는 머리말이 **한 번만**.
      파생 섹션 `config` 도 함께 고칠 것 — 안 고치면 `config: 풀 출력을 읽지 못했습니다` 와
      `pools: 중단됐습니다` 가 **한 화면에서 서로 다른 원인**을 말한다(v2.543 판독에서 발견).
    - **중단을 '응답 상한' 이라 말하지 말 것**(`web/.../storageNodeText.js cliCutText`) —
      조치가 정반대다(상한·시한은 늘리면 되고, 답할 수 없는 프롬프트는 늘려도 영원히 안 된다).
      v2.542 까지 갈래가 둘뿐이라 sudo 중단이 `· 응답 상한으로 끊김` 으로 표시됐다.
    - ⚠ **정직 기록**: 이 수정으로 `26B 수신` 의 원인은 **확정**됐다(사용자 재현). 다만 실장비에서
      포탈이 비-PTY 로 돌려 성공하는 것까지는 **확인하지 못했다** — 엣지가 v2.543 으로 올라간 뒤
      장비 상세의 CLI 원문으로 확인할 것.
  - ⚠⚠ **인증서 프롬프트가 뜬 장비만 파싱이 실패했다 — `stripUemcliBanner` 가 레코드 경계를
    먹고 있었다**(v2.544 — 사용자 신고 "동일한 버전의 unity 스토리지인데 어디는 되고 어디는
    안되고 그래"):
    - **화면이 이미 답을 갖고 있었다.** 두 장비의 유일한 차이는 CLI 원문 헤더다 —
      `OC2-unity-03: 4.3초`(자동응답 없음) → 첫 줄 `1:  ID = pool_1` → 정상 /
      `OC2-unity-02: 4.0초 · **자동응답 certAccept×2**` → 첫 줄 `ID = pool_2` → 레코드 0건.
      **버전 차이가 아니라 '그때 인증서 프롬프트가 떴는가' 였다.**
    - **원인**: 실장비는 프롬프트 줄 **뒤에 이어서** 데이터를 낸다 —
      `Please input your selection (…[1]): 1:    ID = pool_2`. 여기 `1` 이 둘이다(프롬프트의
      기본 선택 / **uemcli 레코드 번호 `1:`**). v2.526 의 `\d*:?` 가 뒤의 `1:` 까지 지웠는데,
      **그때 파서(`parseKeyValueBlocks`)가 `:` 를 키 경계로 읽었으므로 맞는 규칙이었다.**
      v2.542 가 파서를 ` = ` 로 바꾸며 **레코드 경계를 `^N:` 으로 정했는데** 이 규칙은 그대로였다.
      → 명령은 성공(`✓ 성공 3 · 실패 0`)인데 섹션은 `풀 출력을 읽지 못했습니다`.
    - ⚠ **풀이 2개 이상이면 더 나쁘다** — 프롬프트 줄에 붙는 것은 첫 레코드뿐이라 `2:` 이후만
      살아남아 **오류 없이 용량이 과소 보고**된다(실측 재현). 지금 현장은 풀이 1개라 전량
      실패로 드러난 것뿐이다.
    - **고친 것 둘**: ① 프롬프트 접두만 지운다(`:[ \t]*`) ② `parseUemcli` 가 `^N:` 을 한 번도
      못 보면 **키 반복으로 경계를 잡는다**. ⚠ 이때 **여러 레코드를 하나로 합치지 말 것** —
      합치면 뒤 값이 앞 값을 덮어써 **오류 없이 틀린 값**이 된다(v2.530 '틀린 값은 빈 값보다
      나쁘다' 와 같은 규칙).
    - ⚠ **v2.542 의 테스트 21건이 전부 통과하며 놓쳤다** — 픽스처가 **전부 '프롬프트 없는 출력'**
      이었기 때문이다. `test/fixtures/uemcli-prompt-inline-2544.txt` 가 그 경우를 고정한다 —
      **지우지 말 것.** 새 CLI 픽스처를 만들 때도 **프롬프트가 붙은 형태를 함께** 넣을 것.
  - **Unity 모델·버전은 후보 체인으로 읽고 어느 출처인지 밝힌다**(`storage/collectors/
    unityVersion.js`, v2.544 — 사용자 요청 "unity 스토리지 버전 보이게 명령어 추가하고 여기에
    버전 표시해줘"):
    - 표의 '버전' 열 원천은 `snap.version` 인데 v2.542 재작성 이후 **아무 데서도 채우지 않아**
      전 장비가 `—` 였다. 지금 쓰는 `uemcli /stor/general/system show` 에는 **버전이 없다**(용량뿐).
    - 후보는 둘이다(사용자 선택 "둘 다") — ① `uemcli /sys/general show -detail`(**이 장비의
      출력을 본 적이 없다**. 그래서 키를 `VERSION_KEYS` 체인으로 읽고 `usedKey` 를 남긴다)
      ② `svc_diag`(인자 없음 = basic state — **사용자가 실제 출력을 제공**했다).
      ⚠ `svc_diag -s spinfo` 는 여전히 부르지 않는다(v2.542 규약).
    - ⚠⚠ **명령을 늘렸으면 시한 예산을 다시 계산할 것**(v2.528 회귀). 후보 2개 × 45초 = 90초는
      예산(150초)을 먹어 뒤 항목이 시도조차 안 된다. 그래서 `cliSsh` 에 **항목별 시한
      (`spec.timeoutMs`)** 을 만들고 버전 항목에 20초를 줬다(실측 uemcli 4초·svc_diag 11초).
      `unitySshBudget2528.test.js` 가 **필수 항목 최악 합 ≤ 예산**과 후보 수를 고정한다.
    - **버전은 `required` 가 아니다** — 버전을 못 읽어도 용량·상태는 그대로 쓸모가 있다.
      읽지 못하면 **빈 문자열**이고 화면은 `—` 다(지어내지 않는다). 못 읽은 사유는
      `extra.missingCmds.version` 으로 전한다.
    - ⚠ **추출값 옆에 원문을 남긴다** — `c4dev_PIE_8775R-5.4.0.0.5.094-GNOSIS_RETAIL` 에서
      `5.4.0.0.5.094` 만 뽑아 보여주지만 그 추출이 다른 장비에서 빗나갈 수 있다.
      `extra.versionRaw`·`extra.versionSource` 를 표 셀과 상세의 `title` 로 보여준다.
      **점 구간이 3개 미만인 조각을 버전이라 말하지 않는다**(`8775R` 같은 것) — 못 찾으면 원문 그대로.
  - ⚠⚠ **후보 체인의 성공 조건은 '오류가 없다' 가 아니라 '원하는 것을 읽었다' 다**
    (`cliSsh.js spec.accept`, v2.545 — 사용자 신고 2회 "아직 버전명이 나오지 않네"):
    - v2.544 가 버전 후보를 둘로 뒀는데(`uemcli /sys/general show -detail` → `svc_diag`) 후보를
      넘어가는 조건이 `cliLooksError` **하나뿐**이었다. 실측:
      `cliLooksError('버전이 없는 정상 출력') === false` → **첫 후보에서 체인이 끝난다.**
      그래서 수집은 성공인데 **버전 열만 비었다**(화면 그대로).
    - 이것은 v2.525 규약 **'결과가 비어 있지 않다를 읽었다로 쓰지 말 것'** 을 어긴 것이다.
      이제 `spec.accept(stdout)` 가 그 항목이 실제로 원하는 것을 얻었는지 보고, 거짓이면
      **다음 후보로** 넘어간다. ⚠ 파싱이 무거운 항목(풀 상세)에 붙이지 말 것 — 파싱을 두 번 한다.
    - **확인한 명령을 먼저 쓴다** — 후보 순서를 `svc_diag` → `uemcli` 로 뒤집었다. `svc_diag` 는
      사용자가 실제 출력을 **두 번** 제공했고, uemcli 쪽은 **이 장비의 출력을 한 번도 본 적이 없다**.
      '못 본 형식을 앞에 두는 것' 이 v2.525·2.526·2.529·2.530 네 번의 헛수정을 만든 원인이다.
  - ⚠⚠ **CSV 내보내기가 수집 방식을 빠뜨려 왕복에서 되돌아가던 결함**(`storage/csv.js
    exportedCollectMethod`, v2.545):
    - `csv.js` 가 수집 방식을 `type === 'isilon'` 일 때만 내보냈다("isilon 만 유의미"). 그 전제가
      **틀렸다** — `COLLECT_METHODS` 에는 `powerstore: ['api','ssh']` · `unity480: ['api','ssh']` 도 있다.
      가져오기는 빈 값을 `normalizeCollectMethod` 로 **타입 기본값에 보정**하므로(실측
      `unity480` 빈 값 → `api`), **SSH 로 등록한 Unity 를 내보내 고쳐서 다시 넣으면 API 로
      조용히 되돌아갔다**(이 현장 Unity 18대가 대부분 SSH 다). 오류도 경고도 없다.
    - 규칙: **고를 수 있는 방식이 2개 이상인 타입은 반드시 내보낸다.** 1개뿐인 타입은 비운다.
      CSV·자유텍스트 **두 경로가 같은 함수**를 쓴다 — 한쪽만 고치면 그 경로로만 손실이 남는다.
    - **옛 CSV(빈 칸)로 가져오는 것까지 막을 수는 없다** — 그래서 `methodChangeHints` 가
      '지금 등록된 값과 달라지는 행' 만 골라 경고한다(`enrichAdvice().hints` 와 같은 형태라
      화면이 그대로 그린다). ⚠ **판정을 다시 하지 않는다**(v2.513 규약) — 경고만 만든다.
    - ⚠ 화면은 `BoldText` 로 그린다 — **`**강조**` 외의 마크다운(백틱 등)을 쓰면 글자로 샌다**
      (v2.439·2.440·2.505 실제 사고). 이번에도 초안에 백틱을 썼다가 테스트로 잡았다.
  - ⚠⚠ **다중 풀(pool 2개 이상) 규약**(v2.546 — 사용자 질문 "현재 구조에서 pool 이 2개 이상이어도
    계산 가능해?" → 조사 결과 한계 3건, 그중 하나는 **오류 없이 틀린 값**을 만들고 있었다):
    - ★ **사용량을 못 읽은 풀을 0 으로 세지 않는다**(`unitySsh.js` `capacityCounted`). v2.545 까지
      `Number.isFinite(p.usedBytes) ? p.usedBytes : 0` 이라 2풀 중 하나를 못 읽으면 사용률이
      **25.5% → 17%** 로 떨어지는데 `poolsUnreadable` 도 뜨지 않았다(경고 0건). 이제 **전체와
      사용량을 둘 다 읽은 풀만** 더하고, 제외 사유를 **둘로 나눠** 센다 — `poolsUnreadable`
      (전체를 못 읽음) / **`poolsUsedUnreadable`**(사용량만 못 읽음). 조치가 다르다.
    - ★ **판정은 서버가 하고 풀에 `capacityCounted` 로 실어 보낸다**(v2.517 규약). 웹
      `planInput` 이 같은 판정을 복제하면 갈라진다 — 실제로 `sumFree` 는 **모든 풀**을 더하고
      `capacity.usedBytes` 는 읽을 수 있는 풀만 더해 `verifyIdentity` 가 깨져 있었다(실측 차이
      58,770,998,108,160B). ⚠ 구버전 엣지는 이 필드를 안 보내므로 **필드가 없으면 전부 포함**한다
      (0개로 접으면 멀쩡한 장비의 산정이 통째로 사라진다).
    - ★ **일부 풀이 빠진 주기는 `capacity_daily` 에 적재하지 않는다**(`capacityPointEligible`
      `reason:'partial-pools'`, 사용자 선택). 그 주기만 측정 기준이 달라져 증가량 화면에
      거짓 급변이 찍힌다(v2.534 VMAX 와 같은 유형인데 하루 단위로 오락가락해 더 나쁘다).
      ⚠ **화면 표시는 막지 않는다** — 막는 것은 시계열 적재뿐이다(v2.528 규약과 같은 경계).
    - ★ **다중 풀이라고 경고 임계 기준을 버리지 않는다.** v2.545 까지 `planInput` 이
      `alertThresholdPct` 를 `null` 로 둬 그 기준이 통째로 사라졌고, 실질 한도가 **47.6 TB →
      84.7 TB(1.8배)** 로 느슨해지는데 화면은 "표시하지 않습니다" 라고만 했다. 해법은 **대표
      임계를 만들지 않는 것** — 풀마다 자기 임계로 계산해 **더한다**(`경고 임계까지(풀별 합)`).
      임계를 못 읽은 풀은 빼고 개수를 밝힌다. RAID·드라이브는 여전히 대표값을 만들지 않는다.
    - ★ **전체는 여유인데 한 풀만 꽉 찬 경우를 말한다**(`poolPressure`·`poolPressureNote`, 사용자
      제안). 풀마다 `over`/`near`(임계의 90% 이상)/`ok`/**`unknown`** 로 판정하고 `unknown` 을
      `ok` 로 흡수하지 않는다(v2.519·v2.523·v2.534 규약). 문구는 **전체와 풀이 어긋날 때만**
      만든다(항상 띄우면 같은 말이 화면을 덮는다 — v2.509).
    - ⚠⚠ **공간은 풀 경계를 넘지 못한다**(`fitCountByPool`). 합산 여유를 한 덩어리로 나누면
      **오류 없이 틀린 답**이 된다 — 실측: 풀 79.6 + 4.4 TB 에서 80 TB 짜리를 `fitCount` 는
      **1개**라 하고 `fitCountByPool` 은 **0개**라 한다. 풀마다 세어 더하고(`Σ floor`)
      **한 개짜리 최대 크기**를 함께 낸다. 이것도 '딱 맞게 나눠 담을 때의 최대치' 이므로
      화면이 그렇게 적는다.
    - ⚠ **'임계까지' 열에 음수를 그대로 찍지 말 것** — `-11.7 TB` 는 열 이름과 맞물려 읽히지
      않는다. **`초과 11.7 TB`** 로 부호를 말로 바꾼다(v2.546 스크린샷 판독에서 발견).
    - ⚠ **픽스처 `uemcli-pool-detail-2pool-2546.txt` 의 pool_2 는 합성**이다(이 현장에는 다중 풀
      장비가 없어 **실장비 2풀 출력을 본 적이 없다**). pool_1 은 실장비 원본이고, 합성 풀도
      **항등식**(`Total = Current allocation + Remaining + Preallocated`)은 지켰다 — 그 성질이
      깨지면 `checkSpaceIdentity`·`verifyIdentity` 검사가 무의미해진다.
    - ⚠ 화면 문구는 **`BoldText` 로 렌더**해야 `**강조**` 가 별표로 새지 않는다. v2.545 까지
      `UnityCapacityPlanPanel` 의 multiPool 문구가 **BoldText 없이** 그려져 별표가 그대로 보였고,
      `capacityBasisNote` 에는 **백틱**이 들어 있었다(둘 다 v2.546 에 수정).
  - **`planInput` 의 구독·선할당은 풀에서 합산한다**(`unityCapacityPlan.js`, v2.542): 예전에는
    `extra.subscribedBytes`·`extra.preallocatedBytes` 만 봤는데 그것은 옛 수집기가 **단일 풀 값을
    extra 로 올려 준** 것에 기댄 것이었다. v2.542 재작성으로 그 hoist 가 없어지자 '구독분이 다
    채워질 때' 기준이 통째로 사라지고(기준 3개 → 2개) 항등식이 선할당분만큼 어긋났다.
    두 값은 **더할 수 있는 양**이라 여러 풀에서도 합이 뜻을 갖는다(퍼센트인 `alertThresholdPct`
    와 다른 점이다). `extra` 폴백은 REST 경로를 위해 남긴다.
  - **수집 방식 배지는 '등록값' 이 주 배지다**(`views/tools/storageMethodText.js`, v2.542 —
    사용자 신고 "API 를 SSH 로 수정하고 저장했는데 페이지에는 계속 API, 새로고침해도 갱신 안 됨"):
    저장은 정상이었고(수정 폼이 SSH 로 열린다) 표가 `snap.extra.collectMethod`(**마지막 수집이
    실제로 쓴 방식**)를 등록값보다 우선한 것이 원인이다. 엣지가 설정을 다시 받아 수집해 push
    할 때까지 옛 방식이 보이고, 새로고침은 같은 스냅샷을 다시 받으므로 바뀌지 않는다.
    - ⚠ **v2.515 장비 이름 열과 같은 유형의 세 번째 재발**이다. 해법도 같다 — **둘을 나란히**
      보여준다. 주 배지는 등록값이고, 마지막 수집이 다르면 `API 수집분` 호박색 배지를 덧붙인다.
      한쪽만 고르면 반대 방향의 거짓이 된다(지금 쌓인 데이터는 옛 방식으로 받은 것이다).
    - **주기 숫자를 문구에 박지 말 것** — '엣지가 설정을 받아 다시 수집한 뒤' / '다음 수집
      주기에' 로 말한다. 주기는 중앙 설정으로 바뀐다.
    - **수집된 적이 없는 장비를 '대기' 라 하지 않는다** — 비교 대상이 없는 것이다.
  - **Unity 용량 산정은 '기준' 을 숨기지 않는다 — 씬 프로비저닝에서 답은 하나가 아니다**
    (`web/src/views/tools/unityCapacityPlan.js` + `UnityCapacityPlanPanel.jsx` + 서버
    `storage/collectors/unitySsh.js` `sysCapacity`, v2.540 — 사용자 요청 "이 화면 참고해서 용량 산정
    하는 기능 만들어줘"(uemcli `/stor/config/pool show -detail` 캡처 3장) · "이 화면에 맞게 일단
    만들어줘". 범위 선택: 할당 가능량 · 소진 예상일 · 수용 개수 · 원시·유효 용량, **Unity 계열만 먼저**):
    - ⚠⚠ **'더 줄 수 있는 용량' 을 한 숫자로 답하지 말 것.** 세 기준의 답이 다르고 조치도 다르다 —
      ① **물리 잔여**(`Remaining space`) ② **경고 임계까지**(장비 `Alert threshold`, 이 현장 70%)
      ③ **구독분이 다 채워질 때**(`Subscription` − 현재 할당 = 이미 호스트에 약속한 몫). 실측
      (pool_1): 79.6 TB / **47.6 TB** / 56.4 TB 로 **가장 큰 것과 가장 작은 것이 1.7배**다. 물리
      잔여만 보여주면 과대평가이고, 그 숫자로 LUN 을 만들면 임계를 넘겨 경보가 뜬다. 가장 작은
      기준에 **실질 한도** 배지를 달고 `limiting` 으로 표시한다 — 이 배지를 지우지 말 것.
    - **수용 개수(③)도 같은 이유로 기준을 밝힌다** — 200GB 짜리를 실질 한도로 세면 **243개**,
      물리 잔여로 세면 **407개**다(실측). 어느 기준으로 셌는지 적지 않으면 그 숫자는 거짓이다.
    - ⚠ **`extra.capacityNote` 키를 쓰지 말 것**(v2.526 규약) — 화면 `isVirt` 가 존재만으로 VPLEX
      로 판정해 용량 차트를 통째로 숨긴다. Unity 는 **`capacityBasisNote`** 다.
    - **소진 예상은 v2.531 규약을 그대로 따른다** — 증가 중일 때만 내고 **근거 기간·관측 점수**를
      함께 낸다(`basis`). 표본이 적으면 `weak` 로 밝힌다. 감소 추세면 소진일을 내지 않는다.
    - ⚠ **원시 용량은 계산되지 않는다 — '추정' 이라고 말한다.** 드라이브 표기(`38 x 3.8T SAS Flash 4`)의
      `3.8T` 가 10진 TB 인지 TiB 인지 출력만으로는 알 수 없어 **범위**(131.3~144.4 TB)로 내고,
      장비가 보고한 유효 용량(106.9 TB)과의 차이는 패리티·스페어·메타데이터라고 **설명만** 한다.
      `exact:false` 를 `true` 로 굳히지 말 것 — 확인한 것은 범위뿐이다.
    - **항등식을 검사해 어긋나면 화면이 말한다**(`verifyIdentity`): `Total = Current allocation +
      Remaining + Preallocated`. 실측 pool_1 은 정확히 맞는다(117544396521472 = 29973250195456 +
      87568746020864 + 2400305152). 어긋나면 파싱이 깨진 것이므로 조용히 계산을 이어가지 않는다.
    - **시스템 전체 용량(`uemcli /stor/general/system show`)과 풀 합계가 다르면 밝힌다**
      (`extra.capacityCrossCheck`) — 풀 밖 미할당 드라이브가 있다는 뜻이고, 화면 수치는 **풀 합계**
      기준이다. 둘 중 하나를 조용히 고르지 말 것.
    - ⚠ **`Number(null) === 0` 함정을 다시 밟았다**(v2.540 자체 테스트가 잡았다): `tb()`·`daysText()`
      가 null 에 `0.0 TB`·`0.0일` 을 돌려줬다. `bytes == null` 을 **먼저** 본다(v2.525 규약).
    - ⚠ **단위를 TB 로 굳히지 말 것** — 200GB 가 `0.20 TB` 로 찍혔다(Chromium 스크린샷 판독으로 발견.
      수치로는 안 잡혔다). `sizeText()` 가 크기에 따라 GB/TB 를 고른다. 표의 용량 열은 `tb()`(기준
      비교라 단위가 같아야 한다), 단위 크기·남는 공간·하루 증가는 `sizeText()` 다.
    - **풀이 2개 이상이면 경고 임계·RAID·드라이브를 표시하지 않는다**(`multiPool`) — 풀마다 값이
      달라 대표값을 만들면 거짓이 된다. 그 사실을 화면이 적는다.

  - ⚠⚠ **그 가드는 v2.540 까지 SSH 인증 실패를 통째로 놓치고 있었다**(v2.541 — 사용자 신고
    Unity `OC2-unity-03`): ssh2 의 문구 `All configured authentication methods failed` 가
    `authentication fail` **연속 일치** 패턴을 빠져나갔다. 상세는 `server/CLAUDE.md` 의
    'SSH 인증 실패가 주기 수집을 멈추지 않던 결함(v2.541)'. **새 수집기의 실패 문구를 만들 때
    영문 원문만 싣지 말 것** — 자격증명 거부는 출처에서 '인증 실패' 로 못 박는다.
  - **모양이 다른 값을 지문인 척 그리지 말 것**(`views/tools/storageAuthText.js credFpText`,
    v2.541 — Chromium 판독에서 발견): 객체가 아니거나 길이·해시를 읽지 못하는 값이 오면 예전에는
    `계정 없음 · 비번 undefined자·#undefined` 라는 **그럴듯한 한 줄**을 만들었다. 이 지문의 존재
    이유는 '눈으로 대조' 라, 진짜 지문 옆에 놓이면 사용자가 그것을 값으로 읽는다. 읽지 못하면
    `null` 을 돌려 호출부가 '지문을 읽지 못했습니다' 로 다루게 한다. 단 **빈 비밀번호(`len:0`)는
    계속 표시한다** — 그 자체가 진단이다(배포가 비밀번호를 안 실어 왔다).
  - **0 바이트 용량 행은 '행 단위' 로 지운다**(`storage/zeroCapacityPurge.js` +
    `db.purgeZeroCapacityRows`, v2.541 — 사용자 화면에서 수집 전량 실패 장비의 추이가 `0.0 TB`
    선으로 그려졌다): 적재 경로 두 곳(`storage/poller.js`·`central/storageEdge.js`)은 모두
    `capacityPointEligible`(v2.531)에 막히므로 **새로 생기지는 않는다** — 남은 것은 그 가드 이전에
    쌓인 행이다(⚠ 정직 기록: '언제 쌓였나' 는 화면만으로 확정하지 못했다. 원인을 지어내지 않고
    정리만 했다). **장비 이력을 통째로 지우는 `capacityBasisMigration`(v2.534)과 섞지 말 것** —
    그쪽은 '측정 기준이 바뀌어 옛 값이 뜻을 잃은' 경우이고, 이쪽은 **유효한 값은 남긴다**.
    배지도 구분한다 — `기준 변경`(이어서 비교 불가) vs **`이력 정리`**(남은 값은 그대로 유효).
    한 배지로 덮으면 멀쩡한 이력을 못 믿게 만든다.
  - **인증 실패(401)는 주기 수집을 멈춘다 — 재시도해도 결과가 같고 계정만 잠근다**
    (`storage/authGuard.js` + 웹 `views/tools/storageAuthText.js`, v2.528 — 사용자 신고
    "PowerStore PS-HG-2 인증 실패(401) · 장비 등록은 되고 CSV export 하면 비밀번호는 정상"):
    - **멈추는 것은 401/403 뿐**이다. 타임아웃·연결 실패·형식 오류로 멈추면 **일시적 네트워크
      장애가 수집을 영구 정지**시킨다(`isAuthFailure` 가 그 경계이고 테스트가 고정한다).
    - **조용히 멈추지 않는다.** 정지 사실·시점·시도 횟수를 `extra.authStopped` 로 실어 화면이
      말한다. 말없이 멈추면 사용자는 '수집되는 줄' 안다 — 이 기능이 만들 수 있는 최악의 거짓이다.
    - **자격증명이 바뀌면 자동 재개**한다(`credHash` 비교). 비밀번호를 고치는 것이 곧 조치인데
      버튼을 한 번 더 눌러야 하면 '고쳤는데 왜 안 되지' 가 된다. **수동 실행('지금 수집'·연결
      테스트)은 막지 않는다** — 사람이 1회 누르는 것은 잠금 위험이 없고, 고쳤는지 확인할 길을
      없애면 안 된다. 막는 것은 **주기 수집뿐**이다.
    - **엣지 위임 장비의 401 은 원인이 둘이고 조치가 정반대다** — ⓐ 중앙→엣지 배포가 상했다
      ⓑ 장비의 실제 비밀번호가 다르다. 그래서 **엣지가 실제로 쓴 자격증명 지문**(`extra.credFp` +
      `credFpSource`)을 보여 중앙 등록값과 대조하게 한다. 이것이 없으면 화면은 영원히
      "계정/비밀번호 확인" 한 줄만 말한다.
  - **자격증명 지문은 `util/credFingerprint.js` 하나가 소유한다**(v2.528): iDRAC 스캔 로그
    (`central/idracScanJobs.js`, v2.287)가 쓰던 것을 공용 모듈로 옮겼다 — 두 벌이면 표기가 갈라져
    '법인 간 눈으로 대조' 라는 존재 이유가 깨진다.
    - **평문을 넣지 말 것.** 계정명 + 길이 + **비복원** 해시(16비트)뿐이다. 16비트라 역산이
      불가능하고 충돌이 흔하다 — **'지문이 같다 = 비밀번호가 같다' 라고 단정하지 말 것**(다르면
      확실히 다르고, 같으면 '가능성이 높다' 다). 화면 문구도 그렇게 쓴다.
    - ⚠ **하위 16비트를 쓴다**(v2.528 에 고친 **v2.287 결함**): 예전에는 `h.toString(16).slice(0,4)`
      로 **상위** 니블을 잘랐는데 djb2 는 뒤 글자가 주로 하위 비트를 바꾼다 — **끝 글자만 다른
      비밀번호가 같은 지문**이 됐다(실측 `abc`·`abd` 둘 다 `#b873`). 대조가 목적인 값이 대조를
      못 하게 되어 있었다. 되돌리지 말 것.
    - **빈 비밀번호(`len:0`)와 앞뒤 공백을 드러낸다** — 전자는 그 자체가 진단(배포가 비밀번호를
      안 실어 왔다)이고, 후자는 붙여넣기 사고의 최다 원인인데 화면에서는 보이지 않는다.
  - **PowerMax/VMAX 의 용량은 `physicalCapacity` 다 — `provisioned_capacity` 는 55배 틀린다**
    (`storage/collectors/powermax.js powermaxCapacity`, v2.533 — 사용자 신고 "power max 스토리지
    10.x 버전에서는 9.x 버전과 좀 달라진것 같네"):
    - v2.532 가 버전 경로(`/102/…`)를 고쳐 **조회는 되게** 했지만, 10.x 응답에는 9.x 의
      `system_capacity.usable_total_tb` 가 **없어서** 용량이 스냅샷에 실리지 않았다. 실제 10.2.0.9
      응답(사용자 제공)에 있는 것은 `physicalCapacity`(GB 단위)와 `provisioned_capacity`(TB 단위)다.
    - ⚠⚠ **`provisioned_capacity` 를 쓰지 말 것.** 이 어레이 실측:
      `physicalCapacity.total_capacity_gb 209,160.8` / `used_capacity_gb 65,134`(31.1%) 인데
      `provisioned_capacity.total_tb` 는 **11,510.45 TB**(= 11.5 PB, 물리의 약 **55배**)다 —
      씬 프로비저닝 **논리** 용량이다. 그 값이 증가량 DB(`capacity_daily`)에 들어가면 그 장비의
      추이가 통째로 거짓이 된다. 물리 용량만 적재하고 논리 값은 `extra.provisionedTb` 로
      **참고 표시만** 한다(지우지는 않는다 — 오버프로비저닝 비율이 운영 정보다).
    - **우선순위는 `physicalCapacity`(10.x) → `system_capacity`(9.x)** 이고 **둘 다 없으면 `null`
      을 돌려 오류로 보고**한다(0 을 지어내지 않는다 — v2.525 Unity 규약과 같다). 어느 쪽으로
      읽었는지는 `extra.capacityBasis` 가 밝힌다.
    - ⚠ 문구 키는 **`capacityBasisNote`** 다 — v2.526 에 확인한 대로 `capacityNote` 는 화면의
      `isVirt`(VPLEX 판정)가 **존재만으로** 반응해 그 장비의 용량 추이 차트를 통째로 숨긴다.
    - ⚠ **실장비에서 확인하지 못했다**(정직 기록): 픽스처는 사용자가 제공한 실제 응답 본문이고
      테스트가 그 수치를 고정하지만, 이 어레이는 엣지 위임이라 엣지가 v2.533 으로 올라간 뒤에야
      확인된다.
  - ⚠⚠ **v2.534 정정 — 용량은 `system_capacity.usable_used_tb` 가 먼저다. `physicalCapacity` 는
    마지막 수단이다**(사용자 신고 "vmax, powermax 스토리지의 **할당량 말고 실제로 디스크에 기록한
    사용량** 보여줘"):
    - 증상은 **VMAX 11대가 전부 정확히 100%**(전체 == 사용)였고 PowerMax 10.2 한 대만 31.1% 였다.
      원인은 v2.533 이 `physicalCapacity` 를 **①순위**로 본 것이다 — V3 플랫폼(VMAX) 응답에는
      그 필드가 **있고 `used_capacity_gb == total_capacity_gb`** 다.
    - **재현으로 확정**: Comcast/libstorage 의 실캡처(VMAX200K, ucode 5977.1125.1125)를
      `powermaxCapacity` 에 그대로 넣으면 1325680.37/1325680.37 = **100.0%**, 같은 응답의
      `system_capacity` 로는 **440.74/1070.61 = 41.2%** 다. Dell 의 PyU4V 픽스처(PowerMax_2000,
      ucode 5978)도 76290.38/76290.38 — **독립 표본 2건이 일치**한다.
    - ★ **근거는 Dell 공식 스펙 원문**이다. developer.dell.com 은 이 환경에서 차단(http=000)이지만
      **Dell 이 자사 PyU4V 저장소 `tools/openapi.json` 에 PowerMax 10.3 OpenAPI 를 그대로 커밋해
      두었다**. 원문:
      · `usable_used_tb` — "Total Capacity in TBs used by Host, eNas and System **after Data
        reduction is applied**"  ← 이것이 '실제로 디스크에 기록한 양' 이다
      · `subscribed_total_tb` — "Host subscribed capacity plus eNas subscribed capacity"(구독)
      · `subscribed_allocated_tb` — "Host allocated plus eNas allocated capacity"(할당)
      · `disk_group_total_capacity_gb` — "The total disk group (**raw**) capacity including RAID overhead"
      **셋은 다른 필드다 — 화면에서 섞지 말 것.**
    - ⚠ **`physicalCapacity` 를 '원시 용량' 이라 단정하지 말 것.** Dell 자신의 스펙에도 이
      스키마에는 **설명이 없다**(Java DTO 클래스명 `com.emc.em.restapi.common.dto.PhysicalCapacity`
      와 필드명 반복뿐). raw 를 뜻하는 필드는 위의 `disk_group_total_capacity_gb` 로 **따로 있다**.
      확정할 수 있는 것은 "확인한 V3 표본 2건이 used == total 이었다" 까지다. 그래서 이 필드는
      **마지막 수단**이고, `used === total` 이면 `extra.capacitySuspect` 로 **목록·상세 양쪽에서**
      경고한다(상세를 열어야만 알 수 있으면 사용자는 100% 를 용량 부족으로 읽는다).
    - **SRP(풀) 조회를 쓴다**(`powermaxSrp`, `/sloprovisioning/symmetrix/{id}/srp/{srpId}`).
      10.x/V4 는 어레이 레벨에 `usable_*` 가 없어 **`fba_srp_capacity.effective.physical_capacity`
      가 실제 기록량을 주는 유일한 경로**이고 데이터 감축 절감량도 여기에만 있다. ⚠ 한 SRP 에서
      **블록을 하나만** 고른다(`srp_capacity` 통합과 `fba_srp_capacity` 를 둘 다 더하면 중복 집계).
      ⚠ `effective.used_tb`(감축 후 논리)를 사용량으로 쓰지 말 것 — 실캡처에서 physical 0.49TB 인데
      effective 는 1.47TB 로 **3배**다(감축 6:1).
    - ⚠ **단위는 여전히 미확정**: 우리는 `*_tb` 를 10진 1e12 로 보는데 OpenStack Cinder 의 Dell
      PowerMax 드라이버는 같은 필드에 `* units.Ki`(=1024)를 곱해 **TiB** 로 다룬다(약 10% 차이).
      Dell 스펙에 단위 명시가 없다. 실장비 Unisphere 화면값과 대조해 보정할 것.
    - ⚠ **이 현장 VMAX 11대의 실제 응답 본문은 보지 못했다**(정직 기록). 장비 상세의
      `extra.capacityBasis` 가 `system_capacity.usable` 로 바뀌는지로 **즉시 확인된다**.
  - **측정 기준이 바뀌면 그 장비의 용량 이력은 이어 붙이지 않는다**(`storage/capacityBasisMigration.js`
    + `storage/db.js resetCapacityHistory`·`capacityResets`, v2.534 — 사용자 선택 "해당 장비 이력만 삭제"):
    - '할당' 과 '실제 기록' 은 뜻이 달라 한 계열에 섞이면 전환일에 **−수 PB 짜리 거짓 '감소'** 가
      증가량 화면에 찍힌다(CLAUDE.md '감소(−)를 0 으로 깎지 않는다' 규칙 때문에 그대로 표시된다).
    - **대상 타입만**(vmax·powermax) 지우고, `storage_meta` 마커로 **1회만** 돈다 — 재기동마다
      지우면 이력이 영원히 안 쌓인다. 기동 실패가 포탈을 막지 않는다(경고만).
    - ⚠ **조용히 지우지 말 것.** 언제·왜·몇 행을 지웠는지 남겨(`capacity_reset:<id>`) 증가량 화면의
      '관측' 열에 **기준 변경** 배지를 띄운다 — 없으면 '관측 1일' 을 수집 장애로 오해한다.
    - 새 기준 변경이 생기면 `MIGRATION_ID` 를 올린다(그러면 다시 1회 돈다).
  - **VMAX/PowerMax 용량 구성 표는 `powermaxCapacityText.js` 하나가 소유한다**(웹, v2.534):
    행 순서가 계약이다 — **실제 기록 → 할당 → 구독** 순으로 '작은 것부터' 라야 셋의 관계가 보인다.
    강조(굵게)는 **실제 기록 한 행뿐**이다. 없는 값은 행을 만들지 않는다(0 을 지어내지 않는다).
  - **법인·장비 종류 필터와 집계 축은 `deviceFacets.js` 하나가 소유한다**(`web/src/views/tools/
    deviceFacets.js` + `DeviceFacetBar.jsx`, v2.533 — 사용자 요청 "법인별로 구분해서 볼 수있도록 ·
    장비 종류별로 볼 수있도록, 이건 다른 화면에서 사용했던 메뉴와 동일하게"):
    - 스토리지 모니터링이 먼저 갖고 있던 필터 구현(114줄)을 순수 모듈로 옮기고 **증가량 화면이
      같은 모듈을 쓴다**(CLAUDE.md '코어는 하나다'). 20줄을 복사했으면 두 화면의 칩 개수가
      갈라진다 — `console/`↔`version_3/` 중복으로 v2.506 svcmon 버그를 두 곳에 고쳐야 했다.
    - **칩 개수는 '검색만 적용한 집합' 에서 센다.** 자기 축의 선택으로 자기 칩 개수를 줄이면
      선택을 해제할 때까지 다른 칩이 `0` 으로 보여 **고를 수 없는 것처럼** 된다. 각 축의 개수는
      **다른 축의 선택만** 반영한다.
    - **필터를 먼저 걸고 그 다음에 묶는다**(`groupBy(facets.shown, …)`) — 순서를 뒤집으면 범위 밖
      장비가 그룹 합계에 섞인다. 두 축은 AND, 검색어 여러 개도 AND 다.
    - ⚠ **필터를 걸면 KPI·합계 행·주의 장비 목록을 전부 다시 계산할 것.** v2.533 초판이 두 곳을
      빠뜨렸고 **Chromium 스크린샷 판독으로만** 발견했다(수치로는 안 잡혔다) — ① `aggregateGrowth`
      가 `freeBytes` 를 빼먹어 필터를 거는 순간 '남은 용량' KPI 가 **'—'** 가 됐다 ② 주의 장비
      목록이 전체를 그려 **'1대 표시' 라고 해 놓고 범위 밖 장비가 떴다**.
    - **증가율(%)의 분모는 `기준일의 사용량`** 이다(`storageGrowthText.js growthPct`). 현재
      사용량으로 나누면 같은 증가량이 기간마다 다른 퍼센트로 보인다. 기준 사용량이 0 이하면
      퍼센트는 **`null`('—')** 이다 — 0 으로 나눈 값을 지어내지 않는다.
  - **Overview 에는 지도가 없다 — 그 자리는 '서버·게스트 수량' 이다**(`web/src/views/Overview.jsx` +
    `server/src/idrac/serverByCorp.js`, v2.526 — 사용자 요청 "overview 에서 지도 없애줘" ·
    "전체 물리 서버 수량(idrac 에서 찾은 수량), 가상화 호스트 수량, 법인별 서버 수량과 guestos 수량"):
    - ⚠ **`components/WorldMap.jsx` 자체는 지우지 말 것** — 관제 콘솔(`console/pages/ConsoleOverview.jsx`)
      이 같은 컴포넌트를 쓴다. 서버의 `ui-settings` 지도 값(mapHeight/mapView/mapSpread)도 그 화면이
      계속 쓰므로 건드리지 않았다.
    - 지도가 하던 '사이트를 눌러 그 법인 호스트로 이동'(`onSelectSite`)은 **법인 이름 링크로 남겼다** —
      화면을 빼면서 진입 경로까지 없애지 않는다.
    - **물리 서버 귀속 순서는 전력 귀속과 같다**(명시 `vcenterId` → 호스트 이름 → 서비스태그).
      다르게 두면 같은 서버가 전력 화면과 다른 법인에 잡힌다. 집계는 **동기 순수 모듈**이다 —
      전력 귀속(`idrac/service.js allMeasuredPower`)은 전력 DB·OME 캐시·원격 수집기까지 읽는 **비동기**
      경로라 15초 폴링인 `/overview` 에 태울 수 없다.
    - **귀속되지 않은 서버를 아무 법인에나 넣지 않는다**(`unassigned` 로 따로 세고 화면이 밝힌다).
      **귀속 0 인 법인은 `0` 이 아니라 `—`** 다 — '서버가 없다' 가 아니라 '연결되지 않았다' 이다.
      `type === 'ome'` 는 관리 콘솔 등록이라 물리 서버로 세지 않는다(`physicalCapacity` 와 같은 기준).
    - ⚠ **`cols-4` 라는 CSS 클래스는 없다**(`styles.css` 에는 `cols-2`·`cols-3` 만). 쓰면 `.grid` 만
      걸려 1열이 되고 **카드 4장이 세로로 쌓인다** — v2.526 초판이 실제로 그랬고 **가로 넘침 0px 이라
      수치로는 안 잡혔다**(스크린샷을 읽어야 보인다). KPI 줄은 `.kpis`(auto-fit minmax 180px)를 쓸 것.
    - ★ **'서버 합계' 는 같은 장비를 두 번 세지 않는다**(v2.527 — 사용자 요청 "서버의 합/물리서버/
      가상화 호스트 이렇게 구분해서 전체 서버의 수량을 볼 수 있게", 선택 "중복 제거한 실제 대수"):
      이 현장은 **iDRAC 등록 물리 서버 대부분이 곧 ESXi 호스트**다(사용자 화면 실측 SN 27/27 ·
      HB 32/32 · AS 20/20 · GM2 30/30 · HM 38/38). `물리 서버 + 가상화 호스트` 를 그냥 더하면
      실제 대수의 거의 두 배가 된다. 그래서:
      · 표·KPI 의 열은 **`서버 합계` / `물리 전용` / `가상화 호스트`** 다. '물리 전용' 은
        **가상화 호스트로 확인되지 않은** 서버이므로 세 수가 겹치지 않고
        **`합계 = 물리 전용 + 가상화 호스트`** 항등식이 항상 성립한다(테스트가 고정).
      · ⚠ **중복 판정은 귀속(`vcenterId`)과 독립으로 해야 한다.** v2.526 은 명시 지정된 서버를
        만나면 이름·태그 조회를 **건너뛰었다** — 이 현장은 명시 지정이 흔해 그대로 두면
        **중복이 0 으로 나오고 합계가 두 배**가 된다. 되돌리지 말 것.
      · ⚠ **정직성 한계**: 중복은 **이름·서비스태그 일치**로만 찾는다. iDRAC 이름이 ESXi
        호스트명과 다르고 태그도 비어 있으면 못 걸러 합계가 실제보다 커진다. 그래서
        `matchedCount`(확인된 중복)를 **0 이어도** 화면에 적고, 0 일 때는 "중복으로 확인된 장비
        없음(이름·서비스태그가 맞지 않으면 못 찾을 수 있습니다)" 라고 말한다 —
        **'중복이 없다' 고 단정하지 말 것**.
      · 범위 제한 계정용 절단(`routes/api/overviewNsx.js physicalByCorp`)은 **법인별 맵 5개를
        전부** 같은 기준으로 잘라야 한다(`byVcenter`·`…PhysicalOnly`·`…Matched`·`…Hosts`·`…Union`).
        하나라도 빠뜨리면 범위 밖 법인의 대수가 그대로 남는다. 합계 필드도 잘린 맵에서 다시 센다.
    - ⚠ **표 안의 클릭 가능한 텍스트에 `<a>` 기본 링크 색을 쓰지 말 것**(v2.527 사용자 신고
      "법인 글자가 파란색이라서 안보여"): 이 어두운 표에서 링크 파랑은 읽기 어렵다. **표의 다른
      글자와 같은 색**(`color:'inherit'`)을 쓰고 클릭 가능함은 **점선 밑줄**로 알린다
      (`App.jsx:409` 의 `openList` 관례 — `cursor:'pointer'` + `textDecoration:'underline dotted'`
      + `textUnderlineOffset:3`). 키보드 접근을 위해 `role="button"`·`tabIndex`·Enter/Space 처리도 함께.
  - **리포트 표(`.rpt-wrap`)의 숫자칸·계열명칸은 단어 중간에서 쪼개지 않는다**(`web/src/styles.css`,
    v2.525 — 사용자 신고 "실시간 글자 1줄에 나오게 해줘"): `overflow-wrap: anywhere` 는 **문장 칸**을
    위한 규칙인데 숫자 칸까지 적용돼 `실시간` 배지가 `실/시간` 으로, `Consumed` 가 `Consum/ed` 로,
    `63.6 GB` 가 `63.6/GB` 로 쪼개졌다. `td.right`·`td:first-child` 만 해제하고(공백 줄바꿈은 유지 —
    `nowrap` 으로 굳히면 400px 에서 표가 뷰포트를 넘친다) 배지 자체에 `white-space:nowrap` 을 준다.
    A/B 실측(Chromium): 칸 폭 50px 이하에서 배지가 **2~4줄** 이었고 이제 항상 1줄, `Consumed` 는
    2줄 → 1줄, 문장 칸은 6줄로 그대로다(회귀 없음). **스크린샷·DOM 측정을 해야 보이는 결함이다.**
  - **월간 점검은 '확인 불가' 를 '이상 없음' 으로 뭉개지 않는다**(`sanswitch/healthCheck.js` +
    웹 `views/tools/sanHealthText.js`·`SanHealthCheck.jsx`, v2.519 — 사용자 제공 Brocade 월간 점검
    체크리스트 + "장비별 점검 · 전체 점검 버튼 · 이상 유무 간단 보고 · 세부 보고서 PDF"):
    - **상태는 네 가지다**: `ok`(확인했고 정상) / `warn` / `bad` / **`unknown`(확인하지 못함 —
      명령 없음·실행 실패·형식 미인식)**. 점검 보고서는 사람이 "이번 달 이상 없음" 이라고 결재하는
      근거다. 못 본 것을 정상으로 칠하면 이 기능이 만들 수 있는 **가장 위험한 거짓**이다.
      종합(`overall`)이 ok 여도 `uncheckedCount` 를 따로 세어 화면·PDF 가 나란히 적는다.
      ⚠ 이 현장 계정은 `rbash` 라 `switchstatusshow`·`licenseshow` 가 없다(사용자 스크린샷) —
      체크리스트 1단계 핵심 항목이 실제로 '확인 불가' 로 나온다. 그것이 정상 동작이다.
    - **확인 불가가 남아 있으면 배지 자체를 바꾼다** — `정상(일부 미확인)`·호박색. 문구로만 밝히고
      초록 '정상' 을 두면 판정 열만 훑는 사람이 색을 보고 '괜찮다' 고 읽는다(Chromium 판독으로
      발견해 고친 결함). 전부 확인했을 때만 초록이다.
    - **임계값을 지어내지 말 것.** 온도·전압은 **스위치 자신의 센서 상태**(`sensorshow` 의 `is Ok`)를
      따른다 — 모델마다 임계가 달라 포탈이 숫자를 정하면 틀린 경고를 만든다. 측정값은 정보로만 싣는다.
      광량만 수치 판정이고 상수는 웹 `sanSwitchPorts.js` 와 **같은 값**(-9 주의 / -12 이상)이어야
      한다(보고서와 화면이 어긋나면 사용자가 둘 중 어느 것을 믿을지 모른다).
    - **누적 카운터를 '지금 나쁘다' 로 읽지 말 것.** `porterrshow` 는 부팅 이후 누적이다. 기준선
      (`sanswitch/errBaseline.js`)이 있을 때만 당월 신규를 판정하고, 없으면 누적값만 보여주며
      '기준선 없음' 을 밝힌다. 음수 델타(카운터 리셋)는 0 이 아니라 **null**(`rates.js` 규약).
      기준선에 **카운터를 못 읽은 포트를 넣지 말 것** — 0 으로 채우면 다음 점검에서 오래된 누적이
      통째로 '당월 신규' 로 둔갑한다. ⚠ **포탈은 `portstatsclear` 를 실행하지 않는다** —
      다른 팀·다른 도구가 잡아 둔 기준선을 지우는 파괴적 동작이다(v2.505 고아 VMDK 와 같은 판단).
    - **점검은 저장된 스냅샷을 판정한다**(스위치 재접속 없음). 전체 점검이 28대에 동시 SSH 를 열면
      그게 운영 사고다. 최신 데이터가 필요하면 '전체 수집' 을 먼저 누른다 — 응답·화면이
      `collectedAt` 으로 '언제 수집한 데이터로 판정했는지' 를 밝힌다.
    - **스냅샷이 없는 장비를 결과에서 조용히 빼지 말 것** — `missing` 으로 밝힌다. 빼면
      '전부 점검했다' 는 거짓이 된다. 전체 보고서는 그 숫자가 0 이 아니면 **"'전부 이상 없음' 으로
      결론 내리지 마세요"** 를 먼저 적는다. 상세 상한(30대)으로 자른 개수도 밝힌다.
    - **새 명령 4종의 파서는 실장비 출력을 확인하지 못했다**(`sensorshow`·`errdump`·
      `bottleneckmon --show`·`fabricshow`). Broadcom TechDocs 는 이 환경에서 403 이라 원문 형식을
      읽지 못했다. 그래서 파서는 **형식에 관용적**이고 아무것도 못 읽으면 `parsed:false` 를 준다 —
      판정은 그것을 '정상' 이 아니라 '형식 미인식' 으로 다룬다. 실장비 출력을 받으면 정규식을 조이고
      각 파서 머리말의 고지를 지울 것.
    - ⚠ **v2.522 정정 — `errshow` 는 이제 쓴다(페이저 자동 응답으로).** v2.519~2.521 은 "errshow 를
      쓰지 말 것(대화형이라 캡처가 시한까지 매달린다)" 이었다. 그런데 **이 현장 계정에는 비대화형
      `errdump` 가 없고 `errshow` 만 있다**(사용자 스크린샷 — 출력이 `Type <CR> to continue,
      Q<CR> to stop:` 로 멈춘다). 금지하면 RASLog 가 영원히 '확인 불가' 다. 그래서
      `proxy/sshExec.js execPaged` 로 **프롬프트에 자동 응답**한다 — 응답 횟수 상한(`maxPages`,
      넘으면 `q` 로 스스로 끝낸다) + 시한 + 프롬프트 줄 제거 + 상한으로 끊었으면 `truncated`.
      ⚠ 시한이 되면 **모아 둔 출력을 살려 돌려준다**(일반 exec 은 버린다 — 그러면 이 경로의
      존재 이유가 없다). 일반 `exec` 으로 되돌리지 말 것. 실장비로 검증하지는 못했다.
    - `bottleneckmon` 이 **꺼져 있으면 '정상' 이 아니라 '확인 불가'** 다(Slow Drain 을 알 수 없다).
      팬·PSU 를 **개수만 아는 경우**(`ok:null`)도 정상이 아니라 확인 불가다.
    - **PDF 는 기존 벡터 인프라를 재사용한다**(`reportExport.saveDocAsPdf` — 한글 임베드 폰트,
      jsPDF 동적 import). 새 PDF 라이브러리를 들이지 말 것. ⚠ **파일명은 ASCII** 로 만든다
      (문서 안 제목은 한글) — A/B 실측에서 헤드리스 Chromium 이 한글 `download` 파일명을
      `download` 로 떨어뜨렸다(ASCII 는 그대로). 월간 보고서는 아카이브 파일이라 이름을 잃으면
      쓸모가 없다. PDF 문구에서 `**강조**` 를 미리 제거할 것(별표가 그대로 인쇄된다).
  - **SAN 점검의 광량 판정은 '링크가 올라온 포트' 만 본다**(`sanswitch/healthCheck.js isLinked`, v2.521 —
    사용자 신고 "점검결과 포트 광량이 장애수준인데, 확인해보면 사용하지 않는 포트에, 사용하지 않는
    포트는 제외 해야 맞는거 같다"): 링크가 없으면 **상대가 빛을 보내지 않으므로** Rx 가 바닥인 것이
    정상이다. 현장 스크린샷에서 포트 10~15·45·46 이 전부 `비어있음` 인데 -27 dBm 으로 '이상' 이
    나갔다 — 거짓 경보다. 되돌리지 말 것. 부수 규칙:
    - **뺀 개수를 밝힌다**(`링크 없는 포트 N개는 제외`) — 조용히 빼면 '전 포트를 봤다' 는 거짓이 된다.
    - `faulty` 는 빼지 않는다(장애 포트의 광량은 원인 정보다). 제외는 `offline`·`disabled`·`noLicense`.
    - **링크 있는 포트가 하나도 없으면 `ok` 가 아니라 `unknown`** 이다(판정 대상이 없는 것을 정상이라
      말하면 거짓). 전 포트 표에서도 그 포트의 광량은 `unknown` 이 아니라 **`skipped`**(판정 대상
      아님)다 — 둘을 섞으면 '확인 불가 N개' 수치가 의미를 잃는다.
  - **에러 카운터는 종류마다 원인이 다르다 — 한 문장으로 뭉개지 말 것**(`healthCheck.js ERROR_CAUSE`,
    v2.521, 사용자 제공 해석표): `crc err`(광모듈·케이블·상대 장비) / `enc in`(물리 계층) /
    `enc out`(접점·신호 품질) / `link fail`(링크 단절 이력) / `loss sync`·`loss sig`(Link·Optic·Cable) /
    `disc c3`(혼잡·버퍼 크레딧). `errorCauses()` 는 **실제로 발생한 종류만** 낸다(0건인 원인을
    나열하면 없는 원인을 말하는 것이다). `enc_in` 은 파서가 읽고 있었지만 포트 레코드로 옮기지
    않아 v2.521 까지 버려지고 있었다 — 기준선 키(`errBaseline.js KEYS`)에도 함께 넣었다.
    ⚠ 옛 기준선 파일에는 새 키가 없다. 없는 키는 `errorDelta` 가 **null(판정 보류)** 을 준다 —
    **0 으로 채우지 말 것**(오래된 누적이 통째로 '당월 신규' 로 둔갑한다).
  - **불량 포트는 '어떤 장비이고 어디와 조닝됐는지' 까지 말한다**(`zoning.js portZoneDetail`, v2.521 —
    사용자 요청): 점검이 지목한 포트에만 돌린다. **전 포트로 넓히지 말 것** — 분석은
    O(zone × 멤버²)라 수천 zone 패브릭에서 비싸다(라우트가 `PROBLEM_PORT_MAX` 로 제한하고 넘친
    개수를 밝힌다). 포트의 WWN 을 모르는 것(링크 없음·네임서버 미조회)을 **'조닝 안 됨' 이라
    말하지 말 것** — 우리가 그 포트의 WWN 을 모를 뿐이다. 역할은 v2.511 규약대로 확정/추정을 구분한다.
  - **PDF 표의 `w` 는 상대 가중치이고 모든 열에 명시한다**(`reportExport.tableWidths`, v2.521 실제 사고):
    `[{w:38},{w:20},{w:32},{}]` 처럼 **마지막 열만 빼면** 그 열이 기본값 1 을 받아 전체의 `1/91`
    (≈1.9mm)이 된다 — SAN 점검 보고서의 '결과' 열이 한 글자씩 세로로 떨어져 읽을 수 없는 문서가
    됐다(**웹 화면은 멀쩡했다** — PDF 를 열어 봐야 보이는 종류의 결함이고, 사용자가 신고했다).
    `tableWidths` 가 미지정 열에 지정값의 평균을 주어 붕괴는 막지만, 호출부는 전 열에 명시할 것
    (`server/test/sanHealth2521.test.js` 가 소스를 검사해 고정한다).
  - **수집 명령은 항목마다 '후보 체인' 이다 — 후보마다 자기 `bin` 을 갖는다**(`sanswitch/collectors/
    fosSsh.js specs()`, v2.522 — 사용자 요청 "실행되지 않는 명령어가 있는데, 결과가 비슷한 실행
    가능한 명령어를 찾아서 대체해줘"):
    - v2.521 까지 `bin` 이 **항목당 하나**여서 첫 후보의 실행 파일이 없으면 `probeCommands` 가
      **항목 전체를 건너뛰었다** — `errdump` 가 없는 이 스위치에서 뒤 후보 `errshow` 는 **한 번도
      시도되지 않았다**. 이제 후보마다 `bin` 이 있고 **후보 전부가 없을 때만** 건너뛴다.
    - **무엇으로 확인했는지 밝힌다**(`extra.usedCmds` → 항목의 `usedCmd`/`usedAlt`). 대체 명령의
      출력은 원 명령과 같지 않다 — `sensorshow` 대신 `tempshow` 면 **전압을 못 본 것**이므로 판정이
      `ok` 가 아니라 `warn` 이고 문구가 그 사실을 적는다. 이 표시를 지우면 '온도·전압 센서 정상'
      이라는 거짓이 된다.
    - **대체가 없는 항목은 그대로 '확인 불가'** 다. 비슷한 다른 명령을 억지로 끼워 넣어
      **다른 것을 측정해 놓고 같은 것이라 말하지 않는다**.
    - ⚠ **`buildSnapshot` 의 두 번째 `snap.extra = {` 에서 `...(snap.extra || {})` 를 지우지 말 것**
      (v2.522 에 발견한 **v2.519 결함**): 그 대입이 위에서 채운 월간 점검 원천(`sensors`·`raslog`·
      `bottleneck`·`fabricMembers`)을 통째로 덮어써, **그 명령들이 성공해도 판정은 언제나
      '확인 불가'** 였다. 현장 스위치가 실제로 그 명령을 갖고 있지 않아 증상이 구분되지 않았고,
      v2.522 의 스냅샷 조립 테스트가 처음 잡아냈다.
  - **ISL 점검은 '없는 것' 을 이상이라 하지 않는다**(`healthCheck.js` isl·trunk·lsan, v2.522 —
    사용자 요청 "isl 점검 기능 추가"):
    - **ISL 0개는 단독 스위치면 정상**이다. 패브릭 구성원이 2대 이상이라고 **알려졌을 때만** 주의다
      (그 정보가 없으면 정보로만 싣는다). 트렁크·LSAN 도 **없는 것이 정상인 환경이 대다수**다.
    - 트렁크 멤버가 1개인 그룹은 '링크 하나가 빠졌는지 확인하세요(정상 구성일 수도 있습니다)' 로
      **단정하지 않는다**.
    - 새 파서 4종(`parseTempShow`·`parseIslShow`·`parseTrunkShow`·`parseLsanShow`)도 **실장비 출력을
      확인하지 못했다** — 관용적이고 못 읽으면 `parsed:false`(= '형식 미인식', '정상' 아님)다.
  - **점검 이력은 '수집 1회 = 기록 1회' 다**(`sanswitch/healthHistory.js`, v2.522 — 사용자 요청
    "점검 결과를 DB 로 저장해서 최근 10번 점검과 비교"):
    - 점검은 **저장된 스냅샷을 판정**하므로 같은 스냅샷을 두 번 점검하면 결과가 같다. 탭을 열
      때마다 기록하면 '최근 10회' 가 10분 안의 **같은 값 10개**가 된다 — `collectedAt` 으로 중복을
      건다. 이 dedupe 를 없애지 말 것.
    - 장비당 보관 상한(`SANHEALTH_MAX_RUNS` 기본 24)과 `at` 단독 인덱스를 유지한다. 근거
      (evidence)는 **저장하지 않는다**(원문 수천 줄 — 이력의 목적은 '무엇이 달라졌나' 다).
    - **`unknown` 을 `ok` 로 흡수하지 말 것.** `확인 불가 → 정상` 은 '호전' 이 아니라
      **'이제 확인됨'**(`nowKnown`)이고, `정상 → 확인 불가` 는 `nowUnknown` 이다. 뭉개면 없던
      개선을 보고하거나 사라진 항목을 놓친다.
    - 비교는 **'비슷하다' 로 말하지 않는다** — 새로 생긴 문제·해소된 문제·확인 불가로 바뀐 항목을
      각각 세고, `N회 내내 문제인 항목`(매달 같은 경고)을 따로 밝힌다.
  - **'전체 수집' 은 무엇을 했는지 나눠 말한다**(`/tools/sanswitch/collect-all`, v2.516): 중앙 직접
    장비는 즉시 수집하고 엣지 위임 장비는 **재수집 요청만 등록**한다(중앙은 엣지에 명령을 밀어넣을
    수 없다). 응답·화면이 '즉시 N대 / 요청 M대' 로 나눠 표시해야 한다 — 뭉치면 '전부 지금 수집했다'
    는 거짓이 된다. 연타는 `hasPendingRequest` 가 막는다. ✅ 스토리지의 `collect-all` 도 v2.582 에
    엣지 재수집 요청을 등록하도록 맞췄다(형제 도구 비대칭 해소 — v2.586 에 이 줄을 정정).
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
  - ⚠⚠ **포탈 점검 › 인벤토리 점검 — '거부됨' 과 '낡음' 을 구분하지 않으면 며칠 전 값이 지금
    값처럼 보인다**(`central/ingestReject.js` + `portalcheck/invScan.js` + 웹
    `views/tools/invCheckText.js`·`PortalCheck.jsx`, v2.570 — 사용자가 '에이전트 수신 트래픽
    진단' 표의 최근 페이로드가 전부 `—` 인 것을 보고 "여기서 수집되는 데이터가 없으면 어떤 문제가
    발생하는지 확인하고 오류를 점검하려면 어떻게 해야 하는지" → "점검할 수 있는 기능 만들어줘"):
    - **조사에서 코드로 확인한 확정 결함 3건을 이 기능이 고친다** — ① `store.js` 가 위임(site)
      vCenter 의 마지막 push 가 `SITE_INVENTORY_STALE_MS`(기본 5분)를 넘으면 `stale:true` 를
      찍는데 **웹 소비처가 0건**이고 `/health` 도 안 셌다 — 데이터는 디스크 캐시에서 계속
      서빙되므로 며칠 전 값이 지금 값처럼 보일 수 있었다(이 포탈이 만들 수 있는 가장 위험한
      거짓) ② 수신 집계(`routes/central.js`)가 4xx/5xx 를 `return` 으로 빼서 **'안 보냈다' 와
      '보냈는데 막혔다'(mock 차단·소유권 충돌·토큰 불일치)가 화면에서 똑같이 `—`** 로 보였다 —
      조치가 정반대인데 구분이 없었다 ③ 저장된 인벤토리 목록(`GET /api/admin/central/inventory`)에
      화면 진입로가 없어 API 로만 확인 가능했다.
    - **거부는 빼지 않고 따로 기록한다**(`central/ingestReject.js`) — `routes/central.js` 의
      집계 미들웨어가 예전에는 `if (res.statusCode >= 400) return;` 로 거부를 통째로 버렸는데,
      이제 그 지점에서 종류(`mock`/`owner`/`auth`/`bad-request`/`disabled`/`server`)와 근거를
      기록한다. ⚠⚠ **이 기록의 `agent` 이름은 검증되지 않았다** — 거부된 요청이므로 토큰
      바인딩을 통과하지 못했을 수 있고, 그때 이름은 공격자가 고른 값이다. 응답에 `unverified:true`
      를 항상 실어 화면이 그 한계를 말한다(이름을 근거로 조치를 안내하지 않는다).
    - **판정 순서가 계약이다**(`invScan.js scanInventory`): 거부가 마지막 수신보다 **뒤**일 때만
      `rejected` 로 올린다(`never`·`stale` 보다 우선) — 거부가 이미 해소된 과거 기록이면(그 뒤에
      정상 수신이 왔으면) 상태에 반영하지 않는다. 순서를 반대로 두면 옛 거부 기록이 방금 들어온
      정상 수신을 영원히 결함으로 덮는다.
    - **'인벤토리를 안 보낸 엣지' 는 위임 담당으로 학습된 적이 있을 때만 결함이다**
      (`agent.knownOwner`). 스토리지·SAN 전용 엣지처럼 인벤토리를 애초에 다루지 않는 정상
      구성을 결함으로 세면(v2.560 오탐과 같은 유형) 사용자가 멀쩡한 설정을 의심한다. 담당 학습은
      등록부 필드가 아니라 **한 번이라도 성공한 push 에서** 나온다 — 한 번도 없으면 중앙은 누가
      보내야 하는지 자체를 모른다(`owner:null` 로 밝히고 추측하지 않는다).
    - **KPI 다섯 칸은 겹치지 않는다** — 합계 = 정상 수신 + 낡음 + 수신 이력 없음 + 거부됨 +
      확인 불가. `emptyPush`(수신은 정상인데 호스트·VM 0)는 별도 축이라 합에 더하지 않는다.
      신선율의 분모는 **측정분(ok+stale)** 이고 0 이면 `null`(0% 가 아니다).
    - **왕복이 없다** — 토큰 점검과 달리 '지금 점검' 버튼이 없다. 이미 중앙이 가진 값(위임
      vCenter 캐시·수신 통계·거부 기록·엣지 정체)만 조합하므로 마운트 1회 + 새로고침으로 충분하다.
    - **화면은 특수기능 › 포탈 점검 › 인벤토리 점검**(두 번째 서브메뉴)이다. 셸을 더 만들지
      않고(v2.508 규약) `PortalCheck.jsx` 를 서브메뉴 셸로 리팩터해 `TokenCheckView`(기존)와
      `InventoryCheckView`(신규)를 각자 데이터·상태를 갖는 독립 컴포넌트로 나눴다 — 검색어·
      필터 같은 상태가 서브메뉴 사이에 새는 것을 막는다. 권한은 토큰 점검과 같은 기준
      **adminOnly + fullScopeOnly**(엣지·vCenter 는 범위 계정에 나눌 축이 없다).
    - ⚠ **표에 `overflowX:'auto'` 만으로는 부족했다**(v2.562 규약과 같은 재발 — Chromium 400px
      판독에서 발견. 수치로는 안 잡혔다): `.v3-table { width:100% }` 라 `minWidth` 없이는 400px
      에서 스크롤 대신 셀이 줄바꿈되며 행이 세로로 크게 늘어난다(실측: 표 3개 붙은 페이지 높이
      3,601px → `STable style={{minWidth}}` 부여 후 2,469px). **새 다열 표는 `<STable
      style={{minWidth: N}}>` 을 반드시 지정할 것** — `overflowX` 래퍼만으로는 400px 에서 회귀한다.
    - ⚠ **정직 기록**: mock·auth 거부, never, ok 4가지 상태는 목 서버에 실제로 site vCenter 를
      등록하고 `/api/central/inventory` 를 curl 로 직접 두드려 실측했다(API 응답·Chromium 렌더
      양쪽 확인). **stale 상태는 시간 경과가 필요해 스크린샷으로 확인하지 못했다** — 판정 로직은
      `invCheck2570.test.js` 단위 테스트로 고정했다. owner 충돌(같은 vCenter 를 다른 엣지가
      번갈아 push)도 개별 토큰 발급 절차가 필요해 실측하지 못했고 단위 테스트로만 검증했다.

  - **수집 서버 진단 모달은 '문제 요약 → 요청 경로 → 해결 순서 → 증거 → 접힌 상세' 순으로 읽는다**
    (`web/src/views/collectorDiag.js`·`Collectors.jsx DiagModal`, v2.571 — 사용자가 시안 화면(캡처)과
    함께 재구성을 요청했다. "기존 진단 데이터·기능은 보존, 구조만 바꾼다"):
    - **판정은 순수 함수 하나씩** — `denyReasonKind`(거부 사유 3갈래) 하나로 상단 배너·요청-경로
      결과 라벨·해결 절차가 전부 갈린다(중복 판정 금지). `tokenMismatchBanner` 는 **토큰 불일치**
      갈래에만 붙는다 — 미설정·헤더 없음은 "요청이 edge 까지 도착했지만 토큰만 다르다"는 문장이
      성립하지 않는다(미설정은 검증할 토큰 자체가 없고, 헤더 없음은 요청자가 중앙 포맷을 안 지킨
      것이다). 배너 문구는 고정 문자열이다 — 화면이 그대로 옮긴다.
    - **해결 순서를 증거보다 먼저 둔다**(재구성의 핵심) — 예전엔 근거표가 먼저였다. 무엇이 문제인지
      본 다음 바로 "어떻게 고치나"를 보게 한다. 요청-경로 시각화(요청 서버 IP → 결과 → 이 엣지)는
      `denyPathOf(card, collector)` 가 만들고 **거부(deny) 카드에만** 있다 — 이름 충돌·vCenter 중복·
      URL 정체 불일치 카드는 이 절이 통째로 빠진다(그 카드들엔 '요청 경로' 개념이 없다).
    - **`displayIp()` 는 표시 전용 변환** — `::ffff:10.0.0.1` 꼴 IPv4-매핑 IPv6 를 화면에서만 IPv4 로
      풀어 보여준다. 원본 레코드(`card.rows`·`card.bySrc` 의 `r.ip`)는 건드리지 않고 렌더 시점에만
      감싼다 — evidence 문자열처럼 새로 만드는 값에만 미리 적용한다(원본 배열을 mutate 하지 않는다).
    - **User-Agent 는 인증 토큰도 엣지 이름도 아니다** — `uaDisplay()` 가 `node`(엣지 기본 HTTP
      클라이언트가 남기는 값)만 "Node.js HTTP 요청"으로 풀고 원문을 작게 남긴다(`원문: node`).
      그 밖의 값(`curl/8.4.0` 등)은 원문 그대로 — 지어내지 않는다. 표 머리글도 `User-Agent` →
      **`요청 프로그램`** 으로 바꿨다(무엇을 뜻하는지 더 분명하게).
    - **최근 거부 내역·원문 위치는 기본 접힘**이다(native `<details>/<summary>` — 커스텀 JS 토글
      아님). 거부 카드는 요약에 건수를 적고(`최근 거부 내역 보기 (…N건)`), 그 외 카드는 `rows` 가
      없으므로 `원문 위치 보기` 로 라벨이 갈린다 — 접힌 절 하나가 두 종류의 카드를 함께 커버한다.
    - **바로가기 버튼 둘**: "⚙ 수집 서버 설정"(모든 카드 공통 — `onEdit(collector)` 콜백으로 기존
      편집 모달을 그대로 연다. DiagModal 이 새 스토어를 만들지 않는다) · "🔎 토큰 점검 열기"(거부
      카드에만 — `window.location.hash = '#/tools/portal-check'`, 포탈 점검 › 토큰 점검 화면으로
      이동). 둘 다 클릭 시 진단 모달을 먼저 닫는다(모달이 겹쳐 쌓이지 않게).
    - **다크 테마 토큰을 새로 만들지 않는다** — `collector-diag-*` 접두 클래스는 기존
      `--panel`·`--border`·`--text`·`--text-dim`·`--accent`·`--amber`·`--red` 만 재사용한다.
      **720px 이하에서 요청-경로 3단 박스가 1열로 쌓인다**(화살표는 세로로 회전) — Chromium
      1440/720/400px 세 폭에서 가로 넘침 0·콘솔 오류 0 을 확인했다(스크린샷 직접 판독 포함).
    - **서버 변경 없음** — 진단 데이터의 출처(`status.authDeny`·`ident.byAgent`·`ident.vcenterConflicts`·
      `status.identity`)는 그대로이고, 화면이 그 값을 다시 배치·다시 표시할 뿐이다.

  - ⚠⚠ **무거운 내보내기(exceljs)는 동시 1건 가드가 **없으면 포탈을 죽인다** — `util/exportBusy.js`
    하나를 쓸 것**(v2.575 전수 감사에서 **실측으로 확정한 가용성 취약점**):
    `GET /api/tools/ipam.xlsx` 는 워크북을 통째로 메모리에 조립하는데 가드가 없었다. 실측 —
    순차 80회에 RSS 1.56GB → **2.62GB**(유휴 60초 뒤 728MB 로 회수되므로 **누수는 아니다**),
    **동시 5개에 728MB → 2.45GB**, 그리고 전수 퍼징 중 실제로
    `FATAL ERROR: Ineffective mark-compacts near heap limit`(8GB)으로 **프로세스가 죽었다**.
    게이트는 `requirePerm('tools')` 뿐이고 **operator 는 `tools` 를 기본 보유**하므로
    저권한 계정이 중앙 포탈을 내릴 수 있었다. 형제 라우트 `/tools/waste/export` 는 v2.500 부터
    같은 가드를 갖고 있었는데 여기만 빠져 있었다 — **20줄을 복사하면 다음 내보내기에서 또 빠진다.**
    · `acquireExport(name, req)` → 실패면 **409 `export_busy`**, `release()` 는 반드시 `finally` 에서.
    · 진행자 계정명은 **본인일 때만** 밝힌다(v2.500 감사 L-2 — 계정 열거 단서).
    · 수정 후 실측: 동시 5개 → 178MB → **550MB**(1건 200 · 4건 409), 순차 1회는 그대로 200.
  - ⚠⚠ **`req.query` 의 값은 항상 문자열이다 — 입구에서 고정한다**(`util/queryNormalize.js`, v2.575 BUG-22):
    express 4 기본 파서(qs)는 `?id[a]=1` 을 **객체**, `?id=a&id=b` 를 **배열**로 만든다. 라우트는
    거의 전부 문자열을 가정하므로 `.toLowerCase is not a function` 이나 SQLite 바인드 오류
    (`Unknown named parameter 'a'`)로 **500** 이 난다. 퍼징 실측(GET 375경로 × 파라미터 119 ×
    2형태 = **89,250요청**)에서 **7경로 22건**이었다. 라우트마다 `String(...)` 을 덧붙이는 대신
    미들웨어가 모양을 고정한다 — 그래야 **다음에 추가되는 라우트가 자동으로** 보호된다.
    · 배열은 **마지막 값**(HTTP 관례), 객체는 **버린다**(`[object Object]` 로 억지 변환하면
      그것이 검색어·식별자로 들어가 **오류 없이 틀린 조회**가 된다), `__proto__` 류 키는 차단.
    · ⚠ **모든 라우터보다 앞에** 마운트할 것. 배열 쿼리를 받는 라우트를 새로 만들려면 이 모듈을 먼저 볼 것
      (도입 시점에 `Array.isArray(req.query…)` 는 저장소 전체에 **0건**이었다).
  - ⚠⚠ **`text-transform: uppercase` 를 앱 텍스트에 걸지 말 것 — 제품명·단위의 대소문자는 정보다**
    (v2.575 BUG-13. CLAUDE.md 가 v2.508 `kWh`·v2.550 `디스크 busy` 에 **두 번** 겪고도 그때마다
    **개별 라벨만** 고쳐(한글로 바꿔 우회) 구조를 남겨 둔 탓에 세 번째가 왔다):
    Chromium 전수 판독(1440px·9화면)에서 **11건**이 실제로 새고 있었다 —
    `vCenter→VCENTER` · `Cores→CORES` · `ESXi→ESXI` · `vCore→VCORE` · `vCPU→VCPU` ·
    `서버 Uptime→UPTIME` · `수집 서버(edge)→(EDGE)`. 제거한 선택자는 `thead th`(전역·181개 표)·
    `.kpi .label`·`.statusbar .sb-label`·`.section-title`·`.collector-diag-path-label` 다.
    한글에는 대문자화가 **무연산**이고, 대문자는 글자가 더 넓으므로 제거는 표를 **좁히는** 방향이라
    가로 넘침 위험도 없다('작은 라벨' 느낌은 `letter-spacing` 이 유지한다).
    ⚠ **수치로는 안 잡힌다 — 스크린샷을 읽어야 보인다.** `test/audit2575.test.js` 가 다섯 선택자를 고정한다.
  - ⚠⚠ **표의 상한(`limit`)과 최소폭(`minWidth`)은 `STable` 이 소유한다**(v2.575 BUG-19·23/IMP-12):
    · **`limit` 은 정렬 뒤 자른다.** 호출부에서 `rows.slice(0, N)` 으로 먼저 자르면 표가
      '전체를 정렬한 상위 N' 이 아니라 **'앞 N 을 정렬한 것'** 이 된다 — 열을 눌러도 원래 순서의
      앞 N 안에서만 정렬되므로 **오류 없이 틀린 표**다(v2.556 이 `DataTable` 에 같은 이유로 넣은 규약인데
      `STable` 에는 수단이 없어 호출부 6곳이 먼저 자르고 있었다). **뺀 개수는 호출부가 말한다**(조용한 상한 금지).
    · **`minWidth` 를 주면 컴포넌트가 가로 스크롤 래퍼까지 함께 만든다.** 래퍼만 있으면
      `table{width:100%}` 때문에 브라우저가 스크롤 대신 **열을 짜부라뜨리고**(400px 에서 행이 세로로
      길어진다 — 넘침은 0px 이라 **수치로는 안 잡힌다**), `minWidth` 만 있으면 **페이지가 가로로 밀린다**.
      이 짝을 손으로 맞추다 한쪽을 빠뜨리는 것이 반복 사고라 컴포넌트가 둘을 묶는다. 이미 스크롤
      래퍼 안이면 `wrap={false}`.
  - ⚠ **`export { x } from './y'`(재수출)는 그 모듈 스코프에 이름을 만들지 않는다**(v2.575 에 실제로 겪었다):
    사본을 단일 소스로 바꾸면서 재수출만 남겼더니 **같은 파일의 다른 함수가 `cmpVersion is not defined`
    로 죽었다**(테스트 4건이 잡았다). `import { x } from './y'; export { x };` 로 쓸 것.
  - ⚠ **동시성 풀은 `util/pool.js` 하나다**(v2.575 IMP-08) — `poolSettled`(항목별 성패를 담는다) /
    `poolRun`(첫 rejection 을 그대로 올린다). 예전에는 같은 스캐폴드가 **손으로 23벌**이었고
    항목별 `catch` 유무가 갈려(8 vs 15) **오류 의미가 두 가지**였다. 새 수집기는 둘 중 하나를
    **이름으로 골라** 쓴다. `store.collectPool` 은 `poolSettled` 의 별칭으로 남긴다(불변조건 이름 보존).
  - ⚠ **`cmpVersion`·`REGIONS`·`SITE_STALE_MS` 는 단일 소스다**(v2.575 IMP-04·10·11):
    `util/cmpVersion.js`(3벌이 **서로 다르게** 동작했다 — 3세그먼트 강제 vs 자유, `v` 접두 처리. 같은
    입력이 한쪽에서 `null`='버전 미상', 다른 쪽에서 숫자='구버전' 이 됐다) ·
    `util/regions.js` + `web/src/regions.js`(번들 경계라 2벌이고 **테스트가 값을 대조**한다.
    예전 7벌 중 `llm/nlSearch.js` 인라인은 지역 추가 시 **자연어 검색만 조용히 누락**될 자리였다) ·
    `store.js SITE_STALE_MS`(주석이 "같은 값이어야 한다" 고 적고 있던 2벌).
  - ⚠ **값이 없으면 단위를 붙이지 않는다 — `web/src/views/unitText.js`**(v2.575 BUG-20):
    `— ℃` · `— MB` · `—%` 는 **0 처럼 읽힌다**(v2.534 가 전산실 온도에서 겪은 것과 같은 유형이
    다른 화면 9곳에 남아 있었다). `${v ?? '—'}${단위}` 를 새로 쓰지 말 것.
  - ⚠ **웹에도 `numOrNull` 이 있다**(`web/src/numOrNull.js`, v2.575 — **여덟 번째 재발**):
    서버 `util/numOrNull.js` 와 **같은 규칙**이고 테스트가 두 구현을 같은 입력으로 대조한다(웹은
    서버 소스를 import 할 수 없다 — 번들 경계). v2.575 실측 재현 — 연결 끊긴 ESXi 호스트가
    vCenter 개요 표에서 **`흡기온도 0℃ · CPU 0% · MEM 0%`**(정답은 전부 `—`), 처리량을 재지 않는
    Unity·VPLEX·PowerStore 노드가 **`0 bps`**(= '트래픽 없음' 이라는 거짓). 둘 다 **오류 없이 틀린 값**이다.
  - ⚠ **Ping 추이의 '측정 없음' 을 한 문구로 덮지 말 것**(`web/src/views/pingEmptyText.js`, v2.575 BUG-16):
    폴러 전역 꺼짐 / 대상 비활성 / 마지막 측정이 조회 기간 밖 / 첫 측정 대기는 **조치가 전부 다르다**
    (앞 셋은 **기다려도 안 된다**). 판정 순서가 계약이고 `waiting` 플래그가 그것을 들고 있다 —
    실패 판정들 **뒤**에 '기다리면 된다' 를 둔다(v2.509·v2.517 규약).

  - ⚠⚠ **오픈소스 라이선스 준수는 '생성물' 로 관리한다 — 손으로 적은 고지는 다음 릴리스에 낡는다**
    (`scripts/third-party-notices.mjs` → `web/public/THIRD-PARTY-NOTICES.txt` · 루트 `LICENSE` ·
    회귀는 `test/license2576.test.js`, v2.576 — 사용자 질문 "저작권이나 라이선스를 침해했는지 확인"
    에서 **확정 위반 2건**을 찾아 고쳤다):
    - ⚠⚠ **F1(확정) — 서브셋 폰트가 예약 폰트 이름을 쓰고 있었다.** `fontTools` 로 직접 디코드해
      확정: `web/src/vendor/pretendardKsxFont.js` 는 상류 Pretendard **가변폰트(글리프 14,757)**
      를 **2,918 글리프 정적 인스턴스**로 줄인 것인데 `name` 테이블 패밀리명이 **`Pretendard`**
      그대로였다. `Pretendard-OFL.txt:2` 가 **"with Reserved Font Name Pretendard"** 를 선언하고
      OFL 1.1 의 "Modified Version" 정의는 *"adding to, **deleting**, or substituting … **by
      changing formats**"* 이므로 **글리프 삭제와 가변→정적 변환 양쪽 모두** 해당한다. 3조가
      수정본의 예약 이름 사용을 금지한다 → **`DVC Sans KSX`**(nameID 1/3/4/6)로 바꿨다.
      ⚠ **nameID 0(원저작자 저작권)은 지우지 말 것** — OFL 1조가 보존을 요구한다.
      ⚠ **jsPDF 별칭도 예약 이름이면 안 된다**(그 값이 PDF 의 폰트 리소스 이름이 된다) —
      `reportExport.js` 의 `addFont`/`setFont` 를 `'Pretendard'` 로 되돌리지 말 것.
      폰트를 다시 서브셋하면 이 이름 규칙을 **다시 적용**할 것.
    - ⚠⚠ **F2(확정) — 배포 산출물에 라이선스 사본이 없었다.**
      `packaging/offline/build-package.sh:114` 는 **`web/dist` 만** 복사한다 — `web/src` 는 패키지에
      들어가지 않으므로 `web/src/vendor/Pretendard-OFL.txt` 는 **고객에게 배포되지 않았다**(실측:
      `web/dist` 전체 grep `"Open Font License"` **0건**, 서브셋 TTF 에 nameID 13/14 도 없음).
      OFL 2조가 허용하는 세 경로(stand-alone text / human-readable headers / **machine-readable
      metadata fields**)가 **전부 비어 있었다.** → nameID 13·14 주입 +
      **`web/public/THIRD-PARTY-NOTICES.txt`**(vite 가 `web/dist` 로 복사 ⇒ 웹 배포와 오프라인
      패키지 **양쪽** 포함) + About 화면 링크. **`web/src` 에만 두면 배포되지 않는다** — 새 라이선스
      문서는 `web/public` 에 둘 것.
    - **F3 — minify 가 고지 주석을 지운다**(실측: `web/dist/assets/*.js` 118개에 `@license` 16건 ·
      `Copyright` 12건뿐인데 번들에는 d3 계열·recharts·dompurify·pako·guacamole-common-js·jspdf 가
      들어 있다). MIT·ISC·BSD 는 공통으로 사본마다 고지 동봉을 요구한다 → 생성기를 두고 CI 가
      `--check` 한다(`api-doc.mjs` 와 같은 관례). ⚠ **못 읽은 것을 조용히 넘기지 않는다** — 설치되지
      않은 의존성이 있으면 **종료코드 1 이고 문서를 쓰지 않는다**(`docsGen2452` 사고).
      **의존성을 추가·제거하면 `node scripts/third-party-notices.mjs` 를 돌릴 것.**
    - **F4 — `buffers@0.1.1` 은 라이선스 선언이 어디에도 없다**(`exceljs → unzipper → binary →
      buffers`). 오프라인 패키지가 `server/node_modules` 를 `cp -a` 로 **그대로 재배포**하므로
      허락 근거 없이 재배포되는 상태다. `precond@0.2.3` 은 README 에만 MIT. **숨기지 말 것** —
      고지 파일의 전용 절이 개수와 이름을 적는다(상용 납품 실사 대상).
    - **F5 — 루트 `LICENSE`**: 이 저장소는 **공개**인데 `package.json` 3개가 `private: true` 이고
      `license` 필드도 LICENSE 파일도 없었다. 사유 라이선스 선언 + **"제3자 구성요소는 이 조항의
      영향을 받지 않는다"** + 고지 파일 위치를 적는다.
    - **회귀 테스트는 폰트 바이너리를 실제로 디코드한다**(최소 sfnt `name` 파서) — base64 안의
      테이블은 소스 grep 으로 볼 수 없다. 비어 있는 값을 통과시키지 않도록 `assert.ok(v)` 를 **먼저**
      본다(빈 문자열이면 `!/pretendard/i` 가 공허하게 참이 된다).
    - ⚠ **카피레프트는 0건이다**(479개 전수: MIT 372 · ISC 45 · BSD-3 22 · Apache-2.0 15 · BSD-2 6 ·
      기타 소수. GPL/LGPL/**AGPL**/SSPL/BUSL **없음**. `jszip` 만 `MIT OR GPL-3.0-or-later` 듀얼이고
      MIT 선택). 서버 Apache 패키지(`crc-32`·`readdir-glob`)와 `guacamole-common-js` 는 **NOTICE 파일이
      없어** §4(d) 전파 의무가 발생하지 않는다. **새 의존성을 추가할 때 이 성질을 먼저 확인할 것.**
    - ⚠ **타 프로그램 코드 복사는 없다**(v2.576 확인): CLAUDE.md 가 읽었다고 기록한 외부 소스
      3종은 전부 **사실·필드명·수치 관계**만 참조하고 출처를 밝힌다 — `horizon-mcp`(필드명·상태값) ·
      Dell `PyU4V/tools/openapi.json`(필드 **설명문 5줄** 인용, Apache-2.0) ·
      `Comcast/libstorage`(수치 관계만, 식별자는 합성). **픽스처에 실장비 값을 넣지 말 것**(v2.513).

  - ⚠⚠ **화면 문구에 백틱 금지는 전수 스윕이 고정한다**(`web/src/views/uiText.test.js`, v2.576 —
    **여섯 번째 재발**): `BoldText` 는 `**강조**` 만 해석하므로 백틱은 **화면에 글자로 보인다**.
    v2.439·v2.440·v2.505·v2.545·v2.553 에 다섯 번 기록하고도 그때마다 **그 파일 하나만** 고쳤고
    (v2.553 테스트는 `settingsCheckText` 만 검사한다) v2.576 에 **6곳**이 남아 있었다 —
    `sanHealthText.cmdNote`(BoldText) · `bulkIoText.tokenHint`(plain) ·
    `UnityCapacityPlanPanel` 의 `sub` prop(plain) · `CurrentUsersSettings`(BoldText) ·
    `curUserText.agentGuide` 2줄(`<li>{g}</li>`). 값 인용은 **홑화살괄호 `‘ ’`** 로 한다.
    · 검출은 **이스케이프된 백틱**(앞선 백슬래시 연속 개수가 **홀수**)이다 — `` `${sel}\` ``
      (백슬래시 짝수 = Windows 경로)는 대상이 아니다.
    · ⚠ **홑따옴표 문자열 안의 백틱까지 정규식으로 잡으려 하지 말 것** — 중첩 템플릿 리터럴
      (`` `평균 ${x == null ? '—' : `${x}%`}` ``)에서 **오탐 30여 건**이 났다. 오탐이 있는 스윕은
      곧 무력화된다(현재 그 형태는 0건).

  - ⚠⚠ **그리드·플렉스 자식의 `min-width: 0` 은 한 폭만 재면 놓친다**(`.vc-grid`/`.vc-card`,
    v2.576 — 특수기능·vCenter 목록·IPAM·하드웨어 **5화면이 공유**하는 그리드):
    카드 하나(`스토리지 모니터링`)의 설명문이 **줄바꿈 지점 없는 min-content 456px 토큰**이라
    `min-width: auto` 때문에 트랙을 474px 로 키웠다. 실측 — **1920px 0px / 1440px 115px /
    1280px 0px**(3열이 되며 트랙이 우연히 충분) **/ 400px 99px**. 표준 폭에서 넘치는데 더 넓은
    폭에서는 0 이므로 **여러 폭을 재야 보인다**.
    · 수정은 **`min-width: 0` 과 `.vc-card .muted { overflow-wrap: anywhere }` 둘 다** 필요하다 —
      전자만 두면 텍스트가 카드를 넘쳐 잘리고, 후자만 두면 `auto` 트랙이 여전히 max-content 다.
    · ⚠ `overflow-wrap: anywhere` 는 **설명문 전용**이다. 숫자 칸에 걸면 `63.6 GB` 가 `63.6/GB` 로
      쪼개진다(v2.525 `.rpt-wrap` 실제 사고).
    · 함께 고친 표 3곳 — `DatastoreUsage.DsVcTable`(400px **201px** 넘침 · 한 화면에 11개) ·
      `RelayTopoTool` 2곳(**613px**). 6열이어도 `minWidth` 가 없으면 넘친다(v2.575 스윕은 7열
      이상만 봤다) — **열 수로 면제하지 말 것.**

  - ⚠⚠ **CSP 는 기본으로 켠다 — 그리고 `/intro` 만 완화한다**(`index.js` `DEFAULT_CSP`/`INTRO_CSP`,
    v2.577. 회귀는 `test/hardening2577.test.js`):
    - v2.576 까지 주석이 *"인라인 스타일/intro 페이지 호환 이슈로 기본 비활성"* 이라 적고 CSP 를
      통째로 꺼 두었는데 **그것은 측정하지 않은 가정이었다.** Chromium 실측 — 메인 포탈 **21화면
      위반 0건**, 위반은 전부 `/intro` 에서만(외부 CDN 스타일시트 2종 + `dc-runtime` 의 문자열
      `eval`). 두 문제를 묶어 적는 바람에 앱 전체가 무방비로 남아 있었다.
    - **왜 중요한가**: 세션 토큰이 `localStorage` 에 있어 **XSS 한 번이면 그대로 탈취**된다
      (v2.538 기록). CSP 가 없으면 그 위험에 **완화 수단이 하나도 없다.**
    - ⚠ **앱 정책에 `'unsafe-eval'`·`'unsafe-inline' script` 를 넣지 말 것** — 넣는 순간 위 완화가
      사라진다. `style-src 'unsafe-inline'` 은 **필수**다(React 의 `style={{}}` 은 스타일 속성이지
      스크립트가 아니다 — 이것을 빼면 화면이 통째로 깨진다).
    - `/intro` 완화가 안전한 근거: 실데이터·API 와 분리된 셀프부트 정적 데모이고 세션 토큰이 없다
      (v2.577 확인 — 사설 IP 0건·법인 문자열 0건·vCenter 이름 0건). **완화 정책을 앱으로 넓히지 말 것.**
    - ⚠ **CSP 를 바꿀 때는 A/B 로 회귀 0을 확인할 것** — v2.577 은 `CSP=off` 와 켠 상태의 콘솔
      오류가 **21건으로 동일**함을 확인했다(남은 오류는 이 컨테이너가 외부 CDN 을 막아 생기는 기존
      현상). 탈출구 `CSP=off`·`CSP=<정책>` 을 없애지 말 것.
    - ⚠ **HSTS 를 기본으로 켜지 말 것**(정직 기록): 이 현장은 IP + 자체서명 접속이 흔한데 HSTS 는
      그 출처의 http 를 **영구히** 막는다. 현재의 '실제 https 일 때만' 조건을 유지한다.
    - ⚠ **정직 기록**: `/intro` 는 외부 CDN(jsdelivr·Google Fonts)에 의존한다 — 폐쇄망에서는 글꼴만
      안 받아지고 기능은 동작하지만, 공급망 관점에서는 **공개 페이지의 외부 의존**이다(별건).

  - ⚠ **상시 폴링 라우트에는 예외 없이 `memoJson` + `extraKey: scopeKey(...)`**(v2.577 `/top`):
    `/top` 은 `Explore.jsx:59` 가 **15초마다** 부르는데 형제 인벤토리 5종과 달리 캐시가 없어
    **매 요청 VM 배열 5회·호스트 3회를 복사해 정렬**했다. 운영 규모 실측(33 vCenter·6,004 VM)에서
    **콜드/웜 배수 1.0x**(다른 라우트 2.8~5.5x)로 드러났다 — **이 배수가 1.0 이면 캐시가 없는 것이다**.
    수정 후 p50 **14.1ms → 3.0ms**, 동시 20요청 벽시계 28ms.
    · ⚠ **이득의 성격을 과장하지 말 것**: TTL 12초 · 폴링 15초라 **단독 사용자에게는 이득이 없다**.
      이득은 **동시 사용자·탭**과 **버스트**(single-flight 합류)다. 형제 5종과 같은 성질이다.
    · ⚠ `memoJson` 은 값을 **return** 해야 한다 — `res.json()` 을 직접 부르면 캐시가 채워지지 않는다.

  - ⚠ **운영 규모를 재려면 `MOCK_SCALE`**(`mock/generator.js`, v2.577): 이 저장소의 성능 규약은 전부
    **28 vCenter · ~658 호스트 · ~5,850 VM** 을 전제로 쓰였는데 목 데이터는 **11 / 186 / 2,242** 라
    그 규모를 재는 수단이 없었다(v2.576 감사가 "측정은 목 데이터 기준" 을 한계로 적어야 했던 이유).
    `MOCK_SCALE=3` → **33 / 558 / 6,004**. **기본값 1 을 바꾸지 말 것** — 테스트가 vCenter 11개를
    고정하고 데모 화면 수치가 바뀐다. 사본도 `isMockVcenter()` 가 mock 으로 인식해야 한다(엣지 push
    봉인 v2.257 · 빈 인벤토리 판정 v2.560 이 사본에서도 같게 동작하도록).

  - ⚠ **압축 해제에는 예외 없이 `maxOutputLength`**(v2.577 — v2.488 L-1 의 형제 경로 누락):
    `upgrade/archive.js` 는 v2.488 에 상한을 받았는데 `backup/service.js` 의 `gunzipSync` 2곳은
    빠져 있었다. 실증 **100KB gzip → 100MB(증폭 1,029배)**. ⚠ 정직 기록 — `parseUploadedArchive` 를
    부르는 라우트는 **없어서** 지금 도달 가능한 취약점은 아니었다(잠재). 이름이 'Uploaded' 이고
    업로드 라우트를 붙이는 순간 상한 없는 경로가 되므로 먼저 막았다.
    · ⚠ **소스 검사 정규식에 `[^)]*` 를 쓰지 말 것** — `gunzipSync(fs.readFileSync(p), {...})` 의
      **첫 `)` 에서 잘려** 상한이 있는 호출을 '없다' 고 오판한다. v2.535 가 `chmodSync(FILE(), 0o600)`
      으로 **똑같은 실수**를 기록해 두었는데 v2.577 초판이 그대로 반복했다(자기 테스트가 잡았다).
      괄호 깊이로 잘라낼 것.

  - ⚠ **v2.577 에 훑었고 결함 0건으로 확인한 축**(다시 돌리기 전에 이 줄을 볼 것 — 수확이 없다):
    XSS(`dangerouslySetInnerHTML`·`innerHTML` 앱 코드 0건) · 감사로그 NDJSON 주입
    (`JSON.stringify` 가 개행을 이스케이프한다) · 프로토타입 오염(스프레드는 `CreateDataProperty`) ·
    경로 탈출(`backupPath`→`safeName`, `dlsource.findFile`→`SAFE_RE`) · zip slip(파일 전개 없음) ·
    토큰 비교(전부 `tokenMatches`/`timingSafeEqual`, 느슨한 `===` 0건) · XFF 스푸핑(`TRUST_PROXY`
    일 때만 `req.ip`) · 열린 리다이렉트 0건 · 보안 헤더(4종 존재, `X-Powered-By` 없음) ·
    대량 할당(`PATCH /users/:username` adminOnly) · 레이트리밋 커버리지(`/api` 전체) ·
    ReDoS(사용자 입력 패턴은 `rma/testRunner.js:213` 하나이고 관리자 설정값).
    머리막힘(HOL)도 실측했다 — 3.6MB 응답 20개가 도는 중 `/health` **p50 2ms**(유휴 1.7ms)로 **없다**.

  - ⚠⚠ **기간은 필터가 아니라 해상도 스위치다 — 화면이 그 사실을 말해야 한다**
    (`web/src/views/trendMeta.js` + `routes/api/toolsCapacity.js`, v2.578. 회귀는 `trendMeta.test.js`):
    - **배경 — 약속하고 67개 릴리스 동안 하지 않은 일**: 사용자 질문(2026-09-14) "guestos 의 CPU·
      메모리를 7일·14일·30일·60일로 조회하면 결과가 모두 다르다" 에 v2.510 은 **수집 기능**으로
      답했고, 그 릴리스 노트가 *"기간별 결과 차이를 화면이 설명하지 않는 결함 4건은 v2.511 로
      분리"* 라고 적어 두었다. v2.511 은 SAN 조닝이었고 그 넷은 **아무도 하지 않았다**.
      ⚠ **릴리스 노트에 '다음 릴리스로 분리' 라고 적은 것은 그 자체로 미완 작업이다** — 다음
      릴리스 계획에 옮기지 않으면 노트 안에서 잊힌다.
    - **원인 자체는 설계다(고치지 말 것)**: 기간을 늘리면 vCenter 도 이 포탈도 더 거친 롤업을
      쓴다(`USAGE_RANGES` 7d=1h · 30d=6h · 60d=12h · 365d=1d / `PERF_INTERVALS` 30분·2시간·1일).
      실측(90일 표본을 심어 조회) — 평균은 **32.6% → 33.1%** 로 보존되는데 **평균선의 최고점은
      79% → 49% → 44%** 로 무너진다. 비용 근거가 각 주석에 있으므로 롤업 매핑을 바꾸지 말 것.
    - ⚠⚠ **D1 — `collectedSince` 를 '수집 시작' 이라 단정하지 말 것.** `vmperfMeta().firstTs` 는
      **prune 된 `samples` 의 MIN(ts)**(`vmperfDb.js:146`+`pruneVmperf`)라 실제 값은
      `max(수집 시작, 지금 − 보존일)` 이고 보존 기본은 90일이다. 그래서 90일 넘게 돌아간 포탈에서
      "더 긴 기간은 그만큼 시간이 지나야 채워집니다" 는 **거짓**이다(120·365일은 영원히 안 찬다).
      서버가 두 원인을 구분할 정보를 **갖고 있지 않으므로**(지워진 뒤에는 알 수 없다) `sinceNote`
      가 `kind:'either'` 로 **둘 다 말한다**. 응답의 `retentionDays` 를 빼지 말 것 — 빼면 판정이
      경계를 몰라 다시 단정한다. v2.493 '값이 없는 이유를 단정하지 말 것' 계열이다.
    - **D2 — 조용한 기간 대체**: `/tools/rightsize` 는 프리셋 밖이면 **7일**, `POST /vms/usage` 는
      **30일**로 떨어진다. 응답의 `requestedDays` 는 **캐시 객체 밖**에 둘 것 — 캐시 키가 정규화된
      `days` 라 안에 넣으면 다른 요청의 값이 섞인다.
    - ⚠⚠ **D3 — 최대 사용률의 분모는 '구간 평균 할당' 이라 100% 를 넘을 수 있다**(v2.578 검증에서
      실측 **192%** — 12시간 버킷에서 할당 729.7GHz · 최대 1,400.5GHz). 차트 y축이 `[0,100]` 이라
      그대로 두면 **조용히 잘려 100% 에 붙은 선**이 되고 그것은 '꽉 찼다' 는 거짓이다. 넘는 구간은
      **null 로 비우고 개수(`maxPctUnstable`)를 화면이 밝힌다**. ⚠ **클램프(`Math.min(100, …)`)로
      바꾸지 말 것** — 그것이 바로 조용한 보정이다. 절대량(GHz·GB)은 언제나 옳으므로 그대로 둔다.
    - **D4 — 같은 '7일' 의 해상도가 화면마다 다르다**(트리 2시간 · 리포트 30분 · 호스트 추이 30분 ·
      vCenter 합계 1시간). 전부 비용 근거가 있는 설계이므로 통일하지 말고 **각주에 적는다**.
      숫자를 문장에 박지 말 것 — 서버가 주는 `intervalSec`·`bucketMs` 만 쓴다(그래서 호스트·클러스터
      추이 응답에 `intervalSec` 을 추가했다).
    - **조용한 절단**: `/tools/waste/history` 에 `bucket=hour` 를 손으로 주면 365일 × 1시간 = 8,760점
      > 상한 3,000 이라 `ORDER BY b DESC LIMIT` 이 **최근 ≈125일만** 남긴다. `truncated`·`coveredDays`·
      `limit` 을 실어 화면이 밝힌다(v2.509 규약).
    - ✅ v2.510 계획의 **6번(vCenter 실측 설정 읽기)** 의 남은 절반 — `perfCounterMap()` 이 `<level>` 을
      버리던 것 — 은 v2.582 에 `perfCounterLevels()` 로 고쳤다(자기모순 주석도 정정. v2.586 에 이 줄을 갱신).

  - ⚠⚠ **의존 방향은 한쪽이다 — routes/ 는 index.js 만 import 하고, util/ 은 도메인을 모른다**
    (`test/arch2579.test.js` 가 고정, v2.579 — 사용자 요청 "아키텍처 점검, 버그 수정, 튜닝"):
    - **왜**: v2.566 의 TDZ 사고(순환 안에서 이름이 가려져 push 함수가 통째로 죽고 10일간 조용했다)는
      **방향이 뒤집힌 의존**에서 나온다. 644개 모듈·2,510개 edge 를 그래프로 그려 확정한 것 —
      순환 SCC **7 → 5**(남은 5개는 전부 같은 도메인 안의 2-cycle 이고 각 파일이 단독 진입점으로도
      로드된다 — 실측). 없앤 둘이 위험한 것이었다:
      · **ARCH-02** `util/ssrfLookup.js`(leaf util) → `collector/registry.js` → `util/resilientFetch.js`.
        registry.js 는 그 순환을 피하려고 `resilientFetch` 를 **동적 import 로 미루고** 있었다 — 즉
        '지금은 괜찮은' 상태를 우회로 하나가 떠받치고 있었다. IP/URL 차단 판정을 `util/ssrfBlock.js`
        로 옮기고 registry.js 는 재수출한다(호출부 29곳 무변경).
      · **ARCH-03** `collector/agent.js`(export 본문) → `routes/collector.js`(라우트) → `collector/agent.js`.
        거부 링버퍼 상태가 라우트 파일에 살아 있었다 → `collector/denyLog.js`.
      · **ARCH-04** 도메인 4곳(`idrac/roomTempSeries`·`serverTempSeries`·`insights/serialLookup`·
        `agent/autoRegister`)이 `routes/admin/shared.js` 의 **도메인 헬퍼**를 import → `insights/analysisServers.js`.
      · **ARCH-05** `proxy/sshGateway.js` → `routes/remote.js` 의 순수 함수 → `proxy/targetHostScope.js`.
        주석이 "런타임 호출이라 순환 안전" 이라 적고 있었다 — **안전한 이유가 '호출 시점' 하나에
        걸린 구조는 그 자체가 결함**이다.
    - ⚠⚠ **재수출은 `import { x } from …; export { x };` 다** — `export { x } from` 은 그 모듈 스코프에
      이름을 만들지 않아 같은 파일의 다른 함수가 `x is not defined` 로 죽는다(v2.575 실제 사고).
      registry.js 의 `normalize()` 가 `ssrfBlockReason` 을 직접 쓰므로 여기서도 그 형태다.
    - ⚠⚠ **ARCH-01 — v2.575 "동시성 풀 23벌 → 1" 은 절반만 사실이었다.** 그 스윕은 `collectPool`
      이름만 봤고, `eachLimited`(9벌)·`pool`(13벌)·인라인 스캐폴드는 남아 있었다 — **24벌**.
      전부 `util/pool.js` 로 모았다(`poolRun` 13 · `poolSettled` 11). 남긴 것은 둘뿐이고 사유와 함께
      테스트의 `POOL_EXCLUDED` 에 적었다(`svcmon/pool.js` 두 레인 배수 · `routes/admin/gpuGuest.js`
      사전 판정 루프). **결과 모양은 호출부마다 예전 그대로**(`{ok,value}`·`{error}`·`{link,skipped}`) —
      `poolSettled` 결과를 그 모양으로 입히는 3줄 래퍼만 남겼다(동작 변경 0).
      · ⚠ 예전 사본들은 `limit<=0` 이면 **워커 0개를 만들어 아무것도 실행하지 않고 조용히 끝났다**.
        오늘 전 호출부가 하한을 1 로 클램프해 **잠재** 결함이었다(실행으로 확인) — `poolRun` 은
        최소 1 워커라 이제 구조적으로 불가능하다(`③-b` 테스트).
      · ⚠ **`poolRun`/`poolSettled` 는 `Array.isArray(items)` 가 아니면 빈 배열로 본다** — Set/Map 을
        넘기면 조용히 0건이다. 옮긴 24곳은 전부 `items.length` 를 쓰는 배열이었다(확인). 새 호출부는
        `[...set]` 으로 넘길 것.
    - **util/ 의 허용 예외는 명시 목록이다**(`UTIL_ALLOW`): `perf/monitor.js`(횡단 계측) ·
      `vcenter/soapParse.js`(순수 파서가 vcenter/ 아래 산다 — 옮기는 것은 별건). 암묵 허용을 늘리지 말 것.
    - **튜닝 실측(33 vCenter · 558 호스트 · 6,004 VM, `MOCK_SCALE=3`)** — 고칠 것이 **없었다**:
      기동→health **1.1초** · RSS **183MB**(부하 후 227MB) · 폴링 라우트 9종 p50 **1.4~5.4ms** ·
      동시 20 `/api/vms` 벽시계 **89ms** · 루프 프로브 30초 p99 **5.8ms**(72.9ms 스톨 1회) ·
      `/api/hosts` 484KB → gzip **27KB**. 없는 결함을 만들어 고치지 않았다(v2.550.3 규약).
    - ⚠ **정직 기록**: 웹 셸 `console/`(12파일·1,691줄)은 V4 가 `consoleData.js`(순수·import 0)를
      **재수출**해 쓰는 관계라 중복이 아니고 위치만 어색하다 — 손대지 않았다. 남은 순환(v2.579 5개 → v2.586 **4개** — ipam
      settings↔ledger 는 `util/ipv4.js` 로 끊었다. `config ↔ secretVault` 등)은 각각 동적 import·지연 평가로 막혀 있고 실측 로드 OK 라 **이번에 풀지 않았다**.

  - ⚠⚠ **SQLite 모듈의 open 은 예외 없이 '진행 중인 시도' 를 공유한다 — 단일 파일이든 파일별 Map 이든**
    (`test/arch2580.test.js` 가 소스 스윕 + fd 실측으로 고정, v2.580 — 사용자 요청 "아키텍처 점검, 버그 수정,
    튜닝" 2차):
    - **결함(BUG-A)**: `_db` 만 보고 `if (_db) return _db; … _db = new DatabaseSync(FILE)` 로 여는 모듈은
      **첫 호출 2건이 겹치면 같은 파일에 핸들이 2개** 열리고, 뒤 핸들이 `_db` 를 덮어 **앞 핸들은 닫히지
      않은 채 버려진다**(fd 누수 + WAL 연결 2개). `storage/db.js` 에 `capacityResets()`·`dailySpans()` 를
      `Promise.all` 로 부르면 `/proc/self/fd` 에 `storage-history.db` **2개**로 재현했다. v2.550 이
      `bmusage/db.js` 에 같은 결함을 기록해 두었는데 형제 모듈 **7곳**(`storage/db.js`·`sanswitch/perfDb.js`·
      `rma/historyDb.js`·`pdu/db.js`·`rma/testResults.js`·`metrics/vmperfDb.js`·`vmseries/db.js`)에
      적용되지 않았다 — 손 grep 은 6곳을 셌고 **7번째는 테스트 스윕이 잡았다**(v2.579 풀 사본과 같은 교훈).
    - **규칙**: 단일 파일 모듈은 `_opening` 프라미스를 공유하고(`if (_opening) return _opening;`),
      파일별 Map 모듈(`getVmperfDb(vcenterId)` 류)은 **파일 키의 `opening` Map** 을 둔다. `_tried`/
      `'unavailable'` 은 성패가 확정된 뒤에만 세운다(v2.550 규약). 새 DB 모듈은 이 둘 중 하나다 — 스윕이
      `await import('node:sqlite')` 를 쓰면서 핸들을 보관하는 모듈 전부를 검사한다.
    - **BUG-B**: `ping/store.js loadRaw()` 가 파싱 실패를 **조용히 빈 목록**으로 넘겼다 — 다음 저장이 온전했던
      `ping-targets.json` 을 빈 목록으로 덮어써 핑 대상 전량 유실. server/CLAUDE.md '로드 catch 의 조용한
      빈값 반환 금지' 의 누락 지점이고 `preserveCorrupt` + `console.warn` 으로 고쳤다. **비밀이 없는 설정
      파일도 이 규칙의 대상이다** — 유실되는 것이 자격증명이 아니라도 사용자가 손으로 등록한 것이면 같다.
    - ⚠⚠ **TUNE-B/C — '세대 키 + 개수 상한' 캐시는 세대가 바뀌면 옛 세대를 버려야 한다.** 키가
      `${snap.generatedAt}|…` 인 캐시를 '최근 N개' 로만 지키면, 스냅샷이 30초마다 바뀌는 이 서버에서 **다시
      히트할 수 없는 옛 세대 항목이 N개가 찰 때까지 상주**한다. `ipam/ledger.js`(`_ipamCache`·`_sheetCache` —
      `store.js` 가 매 폴링마다 부른다)와 `util/snapCache.js`(`memoJson` 응답 캐시 42 엔드포인트)가 그랬다.
      **힙 스냅샷 2장(4.7분)의 retainer 집계로 확정**했다 — 살아 있는 힙 156→219MB 의 대부분이
      `_ipamCache > Map.table > Object.rows` 아래였고, 힙 상한 160MB 서버는 9분 만에 OOM 이었다.
      v2.503 이 snapCache 에 적어 둔 *"값은 스냅샷이 넘어가면 교체되므로 메모리는 1세대분"* 은 **틀린
      전제**였다 — 주석이 근거를 대신하면 안 된다. 지금은 새 키를 넣을 때 세대(첫 조각)가 다른 항목을
      버린다(같은 세대의 다중 scope 는 유지 · 진행 중 promise 는 보호 · N 은 백스톱). **새 캐시를 만들 때
      '세대가 바뀌면 무엇이 지워지는가' 를 먼저 답할 것** — 답이 '상한에 밀릴 때' 면 이 결함이다.
      · ⚠ RSS 만 보고 '누수' 라 적지 말 것 — 판정은 **힙 상한 대조(OOM 여부) → 힙 스냅샷 retainer** 순서다.
        v2.579 의 'RSS 183/227MB' 2점 측정은 이 성장을 볼 수 없었다(시계열이어야 보인다).
      · `--heapsnapshot-signal` 은 **실제 node PID** 에 보내야 한다 — `cd … && node … &` 의 `$!` 는
        서브셸이라 신호가 셸을 죽인다(v2.580 에 실제로 겪었다).
    - **튜닝**: `Settings.jsx` 가 큰 패널 12개를 `lazy()` 로 떼어 `Settings-*.js` 청크 **605KB/159KB gz →
      250KB/74.7KB gz**. `SUB` 표·키·URL(`#/settings/<k>`)은 그대로다. 새 설정 패널을 추가할 때 정적
      import 로 되돌리지 말 것(청크가 다시 자란다). Suspense 폴백은 공용 `Loading` 하나다.
    - **BUG-C(기존 결함, A/B 확정)**: 설정 › GPU 게스트 수집 필터 행(**166px**)·업그레이드 버튼 행(**83px**)이
      400px 에서 넘쳤다 — 한 줄 고정 flex 에 `flexWrap:'wrap'`. **버튼·필터를 한 줄에 여러 개 두는 flex 행은
      `flexWrap` 을 기본으로** 둘 것(v2.576 그리드 `min-width:0` 규약과 같은 계열 — 수치로는 400px 에서만 보인다).
    - ⚠ **웹 그래프 스크립트는 `export … from` 재수출 edge 를 보지 못한다** — '고아 후보' 2건
      (`components/EntityDetail.jsx`·`views/tools/IpamCore.jsx`)은 재수출로 쓰이는 **정상 모듈**이다.
      팬인 0 을 죽은 코드로 단정하지 말고 grep 으로 재수출을 먼저 볼 것.

  - ⚠⚠ **런타임 계측 훅으로 잰다 — 'SQL 실행 계획 전수'·'동기 fs 호출 지점별 빈도' 는 grep 으로 안 보인다**
    (v2.581 — 사용자 요청 "아키텍처 점검, 버그 수정, 튜닝" 3차. 회귀는 `test/arch2581.test.js`):
    - **방법**: `node --import <훅> src/index.js` 로 `DatabaseSync.prototype.prepare` 와 `fs.*Sync` 를 가로챈다
      (SQL 마다 `EXPLAIN QUERY PLAN` 1회 · 호출 지점은 스택의 `src/` 첫 프레임). ⚠ 세 함정을 실제로 밟았다:
      ① `import { readFileSync } from 'node:fs'` 이름 바인딩은 `module.syncBuiltinESMExports()` 없이는 패치되지
      않는다 ② IPAM 쓰기 워커가 `--import` 를 물려받아 **같은 덤프 파일을 덮었다**(스레드·PID 별 파일명)
      ③ **누적 카운트로 판정하지 말 것** — '839회/분 readFileSync' 는 기동 CJS 로딩이었다. 60초 창 두 덤프의
      **차분**으로 본다.
    - **TUNE-D — `VMPERF_MAX_OPEN_DB` 기본 8 → 48**: `metrics/vmperfDb.js` 는 vCenter 마다 파일 하나인데 상한 8
      이라 33 vCenter 에서 매 샘플 주기 LRU 스래싱(`openFile` **68회/분** → 수정 후 0). v2.503 snapCache 의
      '상한은 vCenter 수보다 커야 한다' 와 같은 판단이고 테스트가 하한 ≥36 을 고정한다. **파일별 핸들 캐시를
      새로 만들면 상한을 vCenter 수(28 · 30+ 예정)로 계산해 정할 것** — `vmseries/db.js` 는 같은 상한(8)이지만
      opt-in 수집이라 이번엔 두었다(켜는 현장이 생기면 같은 결함이다).
    - **TUNE-E — `config.currentVersion()` 메모**: 부를 때마다 `package.json` 을 읽고 있었다(19회/분). 버전은
      프로세스 수명 동안 불변이다(업그레이드 = 재시작).
    - **BUG-D — storage push 0대 무음 조기 반환**(v2.548 이 "아직 남아 있다" 고 적어 둔 것): `statusOnly` 본문을
      보내고 중앙 `saveEdgeStorageStatus` 는 **장비 목록을 건드리지 않는다** — 빈 목록으로 덮으면 엣지 재시작
      직후 한 주기 동안 중앙 화면이 빈다. 화면(`storageListText.edgeReportNotes`)은 사유별로 조치를 나눈다
      (위임 0대 = 정상 / 위임 N대인데 스냅샷 없음 = 엣지 로그 / 등록부 못 읽음). **CLAUDE.md 에 '남아 있다' 고
      적은 결함은 다음 점검 회차의 첫 후보다** — 이 건은 33개 릴리스 동안 문서 안에만 있었다.
    - **BUG-E — `chunkedPrune2453.test.js:48` 플래키 원인 확정**: 프로브가 `setInterval(fn, 0)`(하한 **1ms**)인데
      30청크 setImmediate 루프는 워밍업 시 **0.06ms** 에 끝난다 → 단독 300회 중 269회 실패, 하니스(콜드 ~2ms)
      에서는 20회 0실패. **양보 여부를 벽시계 타이머로 재지 말 것** — 양보 수단(setImmediate)과 같은 큐에 자기를
      다시 거는 프로브가 결정적이다(300회 0실패 · 청크마다 1회).

  - ⚠⚠ **파일 스토어 규약은 넷이 같이 있어야 한다 — 원자 쓰기 · 손상 보존 · 종료 flush · 날짜 코어 하나**
    (v2.582 — 사용자 요청 "아키텍처 점검, 버그 수정, 튜닝 진행해서 각각 5개씩". 회귀는 `test/arch2582.test.js` 14건,
    상세는 `docs/AUDIT-2026-09-23d.md`):
    - **손상 보존(`preserveCorrupt`)은 자격증명 스토어만의 규칙이 아니다.** v2.580 이 `ping/store.js` 한 곳을 고쳤는데
      같은 클래스가 **13곳** 더 있었다(IPAM 주석·override·범위·정책·설정 · 데이터센터 · fleet 태그/귀속 · vCenter 순서 ·
      프로비저닝 저장 · SAN 오류 **기준선** · 알림·전력·로그·업그레이드·파트장애·bmusage 설정). 사용자가 손으로 등록한
      값이면 비밀이 아니어도 대상이다. 스윕 테스트가 `JSON.parse(fs.readFileSync` + `atomicWriteFileSync` 를 둘 다
      쓰는 모듈 전부를 검사한다 — **캐시 성격이면 allowlist 에 사유와 함께** 적는다(조용한 예외 금지).
    - **디바운스 저장은 `util/exitFlush.js` 에 동기 flush 를 등록한다**(`registerExitFlush(name, fn)`). v2.447 이
      fleet·scanStore 두 곳에 각자 exit 훅을 넣은 뒤 디바운스 저장이 9곳으로 늘었는데 훅은 그 둘뿐이었다 — 업그레이드
      재시작마다 마지막 3~10초 창(로그인 실패 이력 포함)을 잃었다. **자체 `process.on('exit'|'SIGTERM')` 을 만들지
      말 것**(스윕이 금지) — 종료 결정은 index.js gracefulExit 하나이고 `exit` 훅 하나로 flush 는 보장된다.
    - **날짜 경계 코어는 `util/dayKey.js` 하나다**(`PORTAL_TZ_OFFSET_MIN`, 옛 이름 3종 호환, **0=UTC 허용**).
      세 벌이던 `DAY_OFFSET_MIN` 중 둘은 `|| 540` 이라 0 을 조용히 540 으로 되돌렸다. 파일명·만료일은
      `todayStamp()/dayKey()`(서버) · `dayStamp()`(웹 — 브라우저 로컬)이고 `new Date().toISOString().slice(0,10)`
      (UTC 날짜)은 양쪽 스윕이 금지한다 — KST 00~09시에 어제 날짜가 된다(이 회차의 작업 시각 09:04 KST = 00:04 UTC 가
      곧 재현). 스케줄 판정(일일 보고)도 `localClock()` 이지 `getHours()` 가 아니다 — 패키지 unit 은 TZ 를 지정하지
      않으므로 서버 프로세스 TZ 는 신뢰할 수 없다.
    - ⚠ **`toMs(null)` 은 NaN 이다** — `Number(null) === 0` 함정(v2.525 규약)을 이 코어의 첫 판에서 또 밟았고 자체
      테스트가 잡았다(`dayKey(null)` 이 `1970-01-01` 을 돌려주고 있었다).
    - **위임 워커의 '표 등재' 와 '실패 기록' 은 다른 일이다**: `agent/idracScanWorker.js` 는 `edgelog/spec.js` 에
      있었지만 중앙 403·시한을 `return null` 로 삼켜 상태에 아무것도 남지 않았다(v2.574 가 형제 3개를 고칠 때 표에
      있다는 이유로 빠졌다). 새 워커는 `lastPollError{kind,detail,streak}` 처럼 **실패를 상태에 싣는지**로 판정할 것.
    - **형제 도구의 규약 비대칭은 결함이다**: 스토리지 '전체 새로고침' 이 SAN 스위치(v2.516)와 달리 엣지 재수집 요청을
      등록하지 않았다 — CLAUDE.md 에 '별건' 이라 적힌 채 66개 릴리스를 갔다. **문서에 '별건'·'남아 있다' 고 적은 것은
      다음 점검의 첫 후보다**(v2.581 BUG-D 와 같은 교훈).
    - **`perfCounterMap()` 은 `<level>` 도 읽는다**(`perfCounterLevels()`, 별도 맵 — 기존 `.get()` 호출부 6곳
      호환). 축소 근거 리포트의 '표본 없음' 사유는 **그 vCenter 가 답한 레벨**을 말한다. 같은 파일 안에서 주석이
      "전부 레벨 1" 과 "mem.active 는 레벨 2" 로 **자기모순**이던 것을 정정했다 — 주석에 레벨 숫자를 박지 말 것.
    - **튜닝 실측**: `/tools/ipam` 은 운영 규모 **5.3MB** 응답을 요청마다 재직렬화·SHA-1·gzip(in-process p50 **71ms**,
      다른 폴링 라우트 ≤1ms) 했다 → `memoJson`(**범위 + 원장 리비전 `ipamRevKey()`** 키 — 후자가 없으면 주석 저장
      직후 TTL 동안 옛 응답). IPMS 검색은 검색어마다 그 전량을 받았다 → 서버 `?q=&limit=`. `vmseries/db.js` 핸들
      상한 8·하드캡 32 는 v2.581 TUNE-D 와 같은 구조라 48·256 으로. **엣지→중앙 단주기 폴링 5종 합산 약 29 req/s
      (28곳)** 는 수치만 기록했다 — 기본값을 늘리면 위임 작업 반응이 늦어지므로 사용자 결정 사항.
    - ⚠ **작업 현황 표의 시각은 `TZ=Asia/Seoul date` 출력만 쓴다.** 이 회차에서 시계를 읽지 않은 추정 시각(09:38)을
      적었다가 사용자 지적(실제 09:04)으로 정정했다 — 추정으로 메우지 말 것.

  - ⚠⚠ **v2.583 — 전체 소스 감사 확정 42건 + 검증 후속 · 로그 분석 메뉴 · 요청 ID · 개요 물리 서버**(사용자 요청
    "전체 소스 분석해서 버그수정, 취약점 분석, 전체 문서 업데이트 … 지금 분석하고 있는 로그를 분석해서 개선점 도출할 수
    있는 메뉴와 기능을 설정에 만들어줘" · "불러오는 중 … 누가 이 지연을 발생시켰는지 ID 도" · "서버 합계에 물리서버
    수량 안나오는거 수정". 감사는 워크플로 6개 발견 에이전트 + 검증 에이전트 · 회귀는 `test/audit2583.test.js` 외 9개 파일):
    - **로그 분석(`loganalysis/` + 웹 `views/LogAnalysis.jsx`·`logAnalysisText.js`)**: 원천 5가지(누적·링 버퍼·저널·
      붙여넣기·엣지 보관분)를 같은 엔진이 본다. ⚠⚠ **엔진은 태그별 '처음 맞는 규칙 하나' 만 센다 — 순서가 곧 분류다.**
      카탈로그 에이전트가 시뮬레이션으로 확인했다: 코어 `gpu-guest-fail-other`(모든 ✗ 줄)가 앞에 있으면 세부 분류 13개가
      **한 번도 맞지 않는다**. 그래서 `index.js activeRules` 순서는 ① 카탈로그 `early` ② 코어 ③ 카탈로그 ④ 코어 `late`.
      테스트가 **전 규칙의 표본이 자기 규칙에 떨어지는지**(가려짐 0)와 소스에 문장이 실재하는지(probe)를 고정한다 —
      규칙을 더하면 그 테스트가 곧 순서 검사다. 카탈로그(`catalog.js`)는 생성물이다: 에이전트 120개 → 변환 스크립트가
      컴파일·태그 일치·표본 매칭·대상 캡처·probe 실재 다섯을 통과한 118개. ⚠ 저널은 서비스 계정(vmportal)에 보통
      **읽기 권한이 없다** — 빈 출력을 '로그 없음' 이라 말하지 말 것(권한·저널 없음·journalctl 없음을 구분).
      ⚠ 로그 분석은 **로그에 찍힌 것만** 본다 — 이번에 스토리지·SAN·PDU push 실패가 `_last` 에만 있고 콘솔에 없어 규칙을
      만들 수 없었다(고쳤다). **새 push/워커는 실패를 상태 객체와 콘솔 둘 다에** 남길 것(v2.566 규약의 이유가 하나 더 늘었다).
    - **요청 ID(`perf/requestId.js` + 웹 `perfClient.js`·`TaskWho.jsx`)**: 브라우저가 `w<탭 6자>-<순번>` 을 만들어
      `X-Request-Id` 로 보내고 서버가 형식 검사 후 되돌린다(없으면 `s<부팅>-<순번>`). 로딩 표시는 문턱을 넘긴 요청만
      5초에 한 번 `/perf/req-status` 로 묻고 **지연의 주체를 나눠** 말한다 — 처리 중(서버) / 이미 응답(전송·브라우저) /
      기록 없음(미도달·재시작·밀려남 — **단정하지 않는다**). 상태 조회는 소유자 본인만(admin 은 전부).
    - **개요 물리 서버**: 귀속 순서 = 명시 vCenter → 호스트명 → 서비스태그 → 통합 서버 인벤토리 지정 → **vCenter 가 하나뿐인
      DataCenter**. 그래도 못 붙인 서버는 법인 열에 억지로 넣지 않고 데이터센터별 고정 행(`unplacedByDatacenter`)으로 센다.
    - ⚠⚠ **범위 계정 롤업은 '걸러서' 만들지 말고 '다시 계산' 한다**(`store.scopedRollups`): `byRegion` 한 행은 그 지역의
      **모든** vCenter 합이고 `global` 은 전 함대 합이다. v2.582 까지 `/overview` 는 존재하지 않는 `r.region` 으로 걸러 빈
      배열을 주고 `global` 을 그대로 내보냈다(범위 계정이 전 함대 수치를 봤다). `/health` 헤더도 같은 기준이다.
      전 함대 값(iDRAC 등록 수·미매핑 전력)은 범위 계정에 null.
    - ⚠⚠ **'바인딩' 과 '결과' 를 다른 시계로 만료시키지 말 것**(`central/logQueries.js`): 바인딩(소유자·vCenter)이 큐잉
      시각, 결과가 결과 시각 기준이라 바인딩이 **먼저** 지워졌고 라우트의 `if (owner && …)` 가 빈 값으로 검사를 건너뛰었다
      (v2.478 IDOR 가드 우회). 결과가 바인딩을 들고, 라우트는 바인딩이 없으면 **거부**(fail-closed). `if (x && …)` 형태의
      권한 검사는 x 가 비는 경로가 곧 우회로다.
    - **숫자 칸 빈 값**: `Number('') === 0` 이 설정 PUT 으로 가면 서버 clamp 가 하한으로 올려 **보존일이 줄고 이력이 지워진다**
      (bm-usage). 서버는 패치에서 빈 값·0(하한>0)을 미지정으로 버리고(`dropUnspecifiedNumbers`), 화면은 이전 값으로 되돌린다.
      **보존일 env 0 = 전부 보관** 계약도 `Number(x) || d` 가 깨고 있었다(`retentionEnv` — 빈 문자열은 미지정).
    - **키 하나 원칙**: 토큰 점검이 표시 이름·id 를 섞어 유령 행을 만들었다 — 엣지의 키는 **수집 서버 id(= 에이전트 이름)**.
      표시 이름은 id 로 접는다(`collectorAlias`).
    - **무인증 거부 감사 로그는 `util/denyAuditGate.js` 하나**: 출처당 1분 한 줄 + 합친 개수. 잠금 발동 줄은 게이트 없이.
    - **엣지 push 0대**: 위임이 정말 0대면 빈 목록으로 중앙을 비우고, 위임은 있는데 스냅샷이 없으면 보내지 않는다(v2.581
      BUG-D 와 같은 판단 — 빈 목록으로 덮으면 재기동 직후 중앙 화면이 빈다).
    - **시간대**: `toLocaleString('ko-KR')`·`getHours()` 류 로컬 getter 도 프로세스 TZ 를 따른다 — 사람이 읽는 시각은
      `util/dayKey.js localStamp`, 파일명은 `fileStamp`. ✅ `vmtrack/diff.js slotKey` 는 v2.586 에 포탈 오프셋으로 옮겼다 —
      KST 호스트에서는 출력이 **바이트 단위로 같고**(9,600시간 대조 0건), UTC 호스트에서만 전환일에 1회 불연속이 생긴다.
    - **응답 본문 캐시와 제자리 수정**: `util/compress.js` 는 응답 객체 **정체성**으로 본문·ETag 를 캐시한다. 모듈 캐시 원소를
      그대로 `res.json` 하고 나중에 제자리에서 고치면 옛 본문이 나간다(provision saved). **캐시 원소를 응답할 때는 사본**.
    - **화면**: JSX 텍스트 노드의 `**` 는 BoldText 를 안 거친다 — `uiText.test.js` 가 스윕한다(문구 모듈 반환값을 plain 으로
      그리는 경우는 호출부를 봐야 해서 스윕이 못 잡는다 — 정직 기록). V4 셸 CSS(`v4.css`·`console.css`)도 uppercase 금지.
      vCenter 카드 본문은 `views/vcCardText.js` 가 상태별로(대기·점검·비활성·연결 실패) 말한다.
    - ⚠ **정직 기록 — 확인하지 못한 것**: 로그 분석의 서비스 저널 경로는 이 컨테이너에 systemd 저널이 없어 **실패 분기만**
      실제로 확인했다(권한·저널 없음·journalctl 없음). 코드 스캔 규칙 118개는 표본이 합성이고 **실제 운영 로그로 맞춰 보지
      못했다** — 첫 실사용에서 '미분류' 탭에 남는 문장을 보고 규칙을 더할 것.

  - ⚠⚠ **통신 지도(v2.584) — 중앙이 이미 가진 값만 조합하고, '기록 없음' 을 정상으로 칠하지 않는다**
    (`server/src/commmap/build.js`(순수) + `routes/api/commMap.js` + 웹 `views/tools/CommMap.jsx`·`commMapLayout.js`·
    `commMapText.js`, 사용자 요청 "이런 방식으로 메인과 edge 가 통신하는 것을 비주얼하게 보여주는 dashboard" +
    라디얼 그래프 캡처. 선택: 특수기능 새 화면 · 위임 자원 외곽 링까지 · 전체 검증):
    - **왕복 0** — 등록부·`allCollectorStatus`·`getIngestStats`·`rejectStats`·`link_latest`·엣지 보고 저장소만 읽는다.
      15초 폴링 화면이라 장비·엣지에 나가는 순간 그 자체가 부하다. 서버 `memoJson` 12초.
    - **판정은 서버가 `state`+`reasons`(코드)로, 문장은 웹 `REASON_TEXT` 가** — 키 집합 1:1 을 서버 테스트가 대조한다
      (v2.553 규약). pull·push 기록이 둘 다 없으면 `unknown`(중앙 재시작 직후가 그렇다 — 두 통계 모두 인메모리) ·
      push 낡음 경계 = `max(siteStaleMs, 관측 push 간격 × 3)`(숫자를 박으면 주기가 긴 법인이 영원히 낡음) ·
      거부는 **마지막 정상 수신보다 뒤일 때만** `push-rejected`(v2.570 순서) 이고 이름은 `unverified`.
    - **위임 자원 담당은 등록값(`remoteAgent`·`agent`)이 먼저, 관측 pusher(`collectedBy`)가 다르면 둘 다 싣고
      `agentMismatch`**(v2.542 배지 규약). 등록부의 어느 엣지와도 안 맞는 이름은 **지어낸 노드에 붙이지 않고**
      `unassigned` 목록으로. 등록부에 없는 스냅샷 vCenter(목 폴백)는 `registryMissing` 으로 밝힌다.
    - ⚠ **실패 중인 엣지의 `status.at` 은 마지막 시도가 아니라 마지막 성공 pull 시각이다** — `puller.js` 가 실패를
      직전 상태 위에 덮고(v2.548 H5) `state.js` 의 `{ at: Date.now(), ...s }` 에서 스프레드가 `at` 을 되돌린다.
      화면 라벨을 '마지막 pull' 로 두면 60초마다 재시도 중인 사실과 어긋난다 → '마지막 정상 pull'. 이 의미는
      파트장애 `classifyEdges` 의 stale 판정이 의존하므로 **state.js 를 고치지 말 것**.
    - **입자(흐름)는 마지막 두 조회 사이의 관측만**(`activityOf` — pull `at` 변화 · pushes 증가). 첫 조회는 전부
      false 다. 점이 없다고 통신이 없다는 뜻이 아니라는 각주를 지우지 말 것. 애니메이션은 SVG SMIL
      (`animateMotion`+`mpath`) 이고 JS 프레임 루프가 없다. 허브 맥동은 요소 하나뿐.
    - ⚠ **ResizeObserver 는 데이터가 온 뒤에 붙여야 한다** — 래퍼 div 는 `Loading` 뒤에 렌더되므로 마운트 1회
      효과(`[]`)로는 ref 가 null 이라 영영 안 붙고, 400px 에서 2열 그리드가 남아 **카드가 18px 로 접혔다**(Chromium
      실측 넘침 229px). 의존성에 `!!data` 를 둔다.
    - ⚠ **`STable` 의 최소폭은 `minWidth` prop 이다** — `style={{minWidth}}` 로 주면 스크롤 래퍼가 안 생겨 페이지가
      가로로 밀린다(같은 실측). v2.575 규약의 실제 재발.
    - ⚠ **기간(길이)에 `elapsedText` 를 쓰지 말 것** — '15초 전' 이 된다(스크린샷 판독에서 발견). 주기·경계는
      `spanText`('15초'). 시점만 `ageText`.
    - 권한 adminOnly + fullScopeOnly(엣지 출처·호스트명·장비 이름 전 법인분). URL 은 **origin 만**(경로·쿼리에
      토큰이 실릴 수 있다 — 테스트가 응답에 토큰 문자열 0 을 고정).
    - ⚠ 정직 기록: Chromium 검증은 **중앙+엣지 목 스택 2대**(실제 pull·push·거부가 오갔다)로 했고 실장비 엣지 28곳
      규모의 라벨 겹침은 보지 못했다 — 바깥 노드 72개 초과면 라벨을 끄고 그 사실을 밝힌다(`labelsHidden`).

  - **로딩 표시의 '요청자' 는 서버가 기록한 로그인 계정이 먼저다**(v2.585, `perfClientLogic.requesterText` +
    `TaskWho.jsx`, 사용자 요청 "요청자 ID 가 포탈 내부에서 사용하는 ID 말고 job 을 실행한 사용자 ID 로 표시"):
    `GET /perf/req-status` 가 소유자 검사를 통과한 항목에 `user` 를 싣고, 서버 확인 전에는 이 브라우저의 로그인
    계정을 쓴다(요청은 이 탭이 보냈다). 둘 다 없으면 이름을 지어내지 않는다. ⚠ 내부 추적 ID(`w…-…`)는 **대체가
    아니라 보조**다 — 서버 성능 측정·라이브 로그와 대조하는 유일한 열쇠라 작게 남긴다(지우지 말 것).
  - **스토리지 표 '버전' 열은 빈 이유를 말한다**(v2.585, `storageVersionText.versionCellInfo` +
    `unitySsh.versionAttemptsOf` — 사용자 신고 "Unity 버전명 안나오는거 개선", 2.583 캡처 18대 전부 `—`):
    로컬 재현으로 파서·`stripUemcliBanner` 는 정상이었다(svc_diag 표본 → `5.4.0.0.5.094`) — 남은 원인은 장비
    출력 자체(비-PTY exec 의 `svc_diag` 응답·`/sys/general show -detail` 의 키)라 **원인을 화면에 드러내는 것**을
    택했다: 사유 + 후보별 시도(성공/값 없음/시한 초과/실패·소요·앞 160자)를 `?` 툴팁으로. 후보 셋째
    `uemcli /sys/soft/ver show` 는 **Type=Installed 만** 읽는다(Candidate 이미지 버전을 현재 버전이라 말하면
    오류 없이 틀린 값). 시한 17초 = 예산 산수(필수 135초 + 3×17 ≤ 187.5초, `unitySshBudget2528.test.js`).
    ⚠ 실장비 출력을 받으면 후보를 좁힐 것 — 이 릴리스는 원인 확정이 아니다.

  - ⚠⚠ **v2.586 — 문서의 미해결 기록 정리 + 서버 결함 스윕 확정 5건**(사용자 요청 "버그 아키텍처 개선 수정 등의
    업그레이드 작업" · 선택 "문서의 미해결 기록 우선 + 전체 검증". 회귀는 `test/audit2586.test.js`·`healthWord2586`·
    `ipv4_2586`·`vmtrack` · 웹 `consoleData.test.js`):
    - ⚠⚠ **상태 단어 판정은 `storage/healthWord.js` 하나다(웹 `storageNodeText.nodeHealthKind` 가 같은 정규식을 쓰고
      테스트가 두 구현을 대조)**. 수집기 3곳(Isilon·VPLEX·XtremIO SSH)이 `/ok|healthy|connected/` 처럼 **경계 없는 부분
      일치**라 `disconnected` 가 **connected** 로, `Broken`·`Not OK` 가 **ok** 로 읽혀 비정상 노드가 **정상으로 세였다**
      (오류 없이 틀린 값). 판정 순서: unknown 집합 → 부정(`not ok`·`non-healthy`) → 나쁨 단어 → 좋음 단어(단어 경계) →
      그 밖은 나쁨(모르는 단어를 정상으로 칠하지 않는다). 파트장애 `healthStringState` 도 `\b` 로 고정했다.
    - **IPv4 파서는 `util/ipv4.js` 하나다**(6벌 통합). 가장 느슨한 판본(`ipam/scan.js isIpv4` — IPAM 키 검증기)이
      `Number('') === 0` 으로 `'10..1.1'`·`'10.1.1.'`·16진·지수를 **유효 IP 로 받았다**. ⚠ **선행 0 은 예전 전 판본처럼
      10진수로 받는다** — 거부로 바꾸면 저장된 스캔 범위·override 키가 깨진다(초판이 그렇게 만들었다가 svcmon T35 가
      잡았다). 원문 토큰을 접속처로 쓰는 곳은 `numToIp` 로 정규화하거나 `genspec nonCanonicalIp` 처럼 거부한다.
      부수 효과로 ipam settings↔ledger 정적 순환이 사라져 SCC 5 → 4(`arch2579` 상한도 4).
    - **숫자 칸 빈 값 두 곳 더**(v2.583 `dropUnspecifiedNumbers` 와 같은 계열): vCenter 로그 보관(`logs/settings.js` —
      빈 칸이 `0` = **무제한**이 되어 prune·용량 상한이 '저장됨' 과 함께 멈췄다) · 일일 보고(`reports/dailyReport.js` —
      시각 칸을 비우면 발송이 00:00 으로). 판정은 `numOrNull(v) ?? cur` — **명시적 0 만** 값이다.
    - ⚠⚠ **로그 문자열을 맵 키로 쓰면 프로토타입 오염이다**(`loganalysis/engine.js safeKey`·`own`): `[__proto__] …`
      한 줄이 `st.tags['__proto__']` 로 `Object.prototype.n = NaN` 을 만들었다(실측). 실시간 분석은 콘솔 **전 줄**을
      받는다. 예약 이름은 `(이름)` 으로 바꾸고 조회는 자기 속성만(`toString` 같은 상속 함수에 더하지 않게). 엣지 보고
      병합(`mergeState`)도 같은 규칙 — 입력이 JSON 이어도 `__proto__` 는 자기 속성으로 들어온다.
    - **Unity 버전 후보의 성공 조건은 '버전' 이다(모델 아님)**: `accept` 가 모델만 읽어도 참이라 첫 후보(`svc_diag`)가
      모델만 주는 장비에서 뒤 uemcli 후보 둘이 **한 번도 실행되지 않았다**. 모델은 버리지 않고 원문 표본에서 건진다
      (`extra.modelSource`). ⚠ v2.585 '18대 전부 —' 의 원인인지는 **확인하지 못했다**(가설 — 실장비 출력 필요).
    - **사람이 읽는 시각 5곳 더**(v2.583 규약의 누락): 폴더 사용량 메일 제목·수집 줄(시각이 없으면 '지금' 을 지어내던 것도
      `—` 로) · VM 복제 클론/스냅샷 이름 · DB 이전 스크립트 파일명·README · 배포 성공 힌트 · 릴리스 노트 기본 날짜.
    - **`vmtrack slotKey` 는 포탈 오프셋이다** — 위 '시간대' 항목의 별건을 닫았다. **도메인 타일 메타**는 `waitMeta` 로
      `loadState` 판정을 받는다(V4·관제 콘솔 양쪽). 위 v2.509·v2.583·v2.578·v2.579 의 '남은 것' 줄도 함께 정정했다 —
      **문서의 '남아 있다' 는 다음 점검의 첫 후보이고, 고친 뒤에는 그 줄을 반드시 고칠 것**(이번에 4줄이 이미 고쳐진
      결함을 '남아 있다' 로 적고 있었다).
    - ✅ (당시 확인하지 못한 것) `curUser /settings` 가 범위 계정에 함대 전체 `overLimit`·`push.last.records` 를 줄
      수 있다는 스윕 후보는 **v2.589 SEC-2589-02 에 고쳤다**(범위 계정에 null — v2.590 에 이 줄을 정정).

  - ⚠⚠ **데이터 흐름 지도(v2.587) — 경로는 라우터 선언에서 읽고, 계측이 없는 방향은 계측부터 만든다**
    (`server/src/dataflow/build.js`(순수) + `central/pullStats.js` + `util/outboundStats.js` + `routes/api/dataFlow.js` +
    웹 `views/tools/DataFlow.jsx`·`dataFlowLayout.js`·`dataFlowText.js`, 사용자 요청 "엣지·수집 agent·iDRAC·GPU·전력 …
    엣지에서 포탈로 통신하는 모든 데이터, push pull 로 가져오는 모든 데이터를 표시" + 노드 그래프 영상. 선택: 엣지 내부
    수집은 **누를 때만** · 통신 지도 확장이 아니라 **새 화면** · 시안은 클로드 디자인 캔버스):
    - **경로 목록을 손으로 적지 않는다** — `declaredRoutes()` 가 `centralRouter`·`collectorRouter` 의 stack 을 읽는다.
      분류(`CATS`)는 `side:path` 정규식이고 걸리지 않으면 `other` + `unmapped` 로 밝힌다 — 테스트가 `unmapped` 0 을
      고정하므로 **새 central/collector 경로를 만들면 `CATS` 에 분류할 것**(안 하면 CI 가 깨진다).
    - ⚠⚠ **GET 은 예전에 기록되지 않았다** — `routes/central.js` 집계 미들웨어가 POST 만 셌다. 이제 GET 도 `pullStats` 에
      남기되 키는 **매칭된 라우트의 선언 경로**(`req.route.path`)이고, 인증에서 막혀 라우트에 닿지 못한 요청은
      **선언 GET 경로 집합에 있을 때만** 실패로 센다(없는 경로로 키를 불리지 못하게 — v2.583 ingestReject 상한 사고).
      이름은 개별 토큰이면 검증됨, 아니면 `verified:false`.
    - **중앙 → 엣지 호출은 `resilientFetch` 한 곳에서 기록한다**(`util/outboundStats.js`, `/api/collector/`·`/api/central/`
      경로만). **쿼리를 버리고** 헤더·본문을 저장하지 않는다(토큰). 전역 `fetch` 를 쓰는 `collector/upgradePush.js` 는
      직접 기록한다 — **포탈 사이 호출을 전역 fetch 로 새로 만들면 여기 기록도 붙일 것**(안 붙이면 지도에서 빠진다).
    - 판정: 기록 없는 연결은 **만들지 않는다**(경로는 `none` 회색) · 실패가 성공보다 뒤일 때만 `fail` · 낡음 =
      `max(관측 간격 × 3, 10분)` · 거부의 시각은 `recent` 원문에만 있어 밀려난 거부는 **개수만**(`rejectsWithoutTime`).
      전부 인메모리라 **중앙 재시작 직후엔 전부 회색**이고 화면이 `since` 로 밝힌다.
    - ⚠ **`<button>` 을 카드로 쓸 때 `display:flex; flex-direction:column; justify-content:flex-start`** — 버튼은 내용을
      세로 가운데 정렬해 카드 위에 빈 띠가 생겼다(v2.587 스크린샷 판독에서 발견. 수치로는 안 잡혔다).
    - ⚠ **그래프 폭은 1440px 본문(약 1390px) 안** — 1400px 초판은 세 번째 열 엣지 카드가 잘렸다(같은 판독). 좁은 화면은
      그래프 상자만 가로 스크롤(페이지 넘침 0 — 400px 실측).
    - ⚠ 정직 기록: 검증은 **중앙+엣지 목 스택 2대**(공유 토큰)로 했다 — 그래서 목 엣지의 pull 은 전부 '이름 미검증'이고
      `capacity-report`·`svcmon-report` 는 '개별 토큰만 허용' 으로 **실제로 거부**되어 빨간 선으로 보였다(제품 동작 그대로).
      시안의 '중앙 직접' 노드는 포탈 사이 통신이 아니라 구현에서 뺐다. 실엣지 28곳 규모의 선 겹침은 보지 못했다.

  - ⚠⚠ **3단 지도(v2.588) — 장비 → 엣지 → 메인. 새 판정을 만들지 않고 두 지도의 조립기를 묶는다**
    (`server/src/devflow/build.js`(순수) + `routes/api/deviceFlow.js` + 웹 `views/tools/DeviceFlow.jsx`·
    `deviceFlowLayout.js`·`deviceFlowText.js`, 사용자 요청 "엣지와 main 이 통신하는것도 표시해줘 · 3단계로 만들어줘,
    장비-edge-main". 선택: 장비는 **종류별 묶음 + 펼치기** · 특수기능 **별도 화면**. 회귀는 `test/devFlow2588.test.js`
    + 웹 `deviceFlow.test.js`):
    - **판정 복제 금지** — 장비 귀속·상태는 `buildCommMap`, 엣지 ↔ 메인은 `buildDataFlow` 의 결과를 그대로 쓴다.
      두 라우트의 입력 수집을 `gatherCommInputs(snap, errs)`·`gatherFlowInputs(errs)` 로 떼어 셋이 같은 입력을 본다
      (따로 모으면 세 화면이 다른 말을 한다). 새 입력은 iDRAC 뿐 — 중앙 등록부(OME 제외) → 메인 직접, 엣지 export
      (`allRemoteServers().collectorId`) → 그 엣지. 담당을 모르면 `unassigned`(지어낸 노드에 붙이지 않는다).
    - ⚠ **`buildCommMap` 의 종류별 상한(40·60)은 통신 지도 전용이다** — 3단 지도는 `resMax/directMax: Infinity` 로
      전량을 받아 **개수는 전량**, 펼침 목록만 `ITEM_MAX`(80)로 자르고 `omitted` 로 밝힌다. 상한 걸린 목록으로 개수를
      세면 '40대' 라는 거짓이 된다. 기본값(인자 없음)은 예전 그대로 40 — 테스트가 고정한다.
    - ⚠⚠ **등록만 알고 판정하지 않은 묶음은 `neutral`(회색)이다** — iDRAC·스토리지·SAN·PDU 는 이 화면이 장비별
      수집 성패를 모른다(`registered`). 초록으로 칠하면 '전부 정상' 이라는 거짓이다. 묶음 상세가 그 사실을 적는다.
    - **채널 넷**(`up`=push·회신 · `down`=pull·작업 · `cpull` · `cpush`)은 데이터 흐름 방향 여섯을 접은 것이다. 선 색 =
      **기록이 있는** 방향 중 가장 나쁜 것, 전부 없으면 `none`(회색 점선). 엣지 카드의 상태 글자는 통신 지도 판정(수신
      기준)이라 선 색과 **축이 다르다** — 범례가 그 사실을 말한다(한쪽으로 합치지 말 것).
    - ⚠ **`REASON_TEXT` 값은 `{title, fix}` 객체다** — 그대로 렌더하면 `[object Object]`(v2.588 스크린샷 판독에서
      발견). `reasonText(code)` 를 쓴다. ⚠ 화면 이동 버튼을 `<a className="btn">` 로 두면 파란 밑줄 글자로 샌다 —
      `button` + `window.location.hash`.
    - 권한 adminOnly + fullScopeOnly · 왕복 0 · memoJson 12초 · 응답에 토큰·URL 경로·iDRAC 비밀번호 0(테스트 고정).
    - ⚠ 정직 기록: 검증은 **중앙+엣지 목 스택 2대**(+ 없는 포트를 가리키는 엣지 1곳)로 했다. 공유 토큰이라 목 엣지의
      pull·push 는 '이름 미검증' 이고 일부 push 가 실제로 거부되어 빨간 선이 됐다(제품 동작 그대로). 실엣지 28곳
      규모(세로 약 2,000px)는 보지 못했다.

  - ⚠⚠ **v2.589 — 5축 병렬 감사 확정분**(사용자 요청 "아키텍처 점검 개선 버그패치 업그레이드 보안점검" · 선택: 병렬 에이전트
    5개 · 전체 검증 · 확정분 전부 수정. 회귀는 `test/audit2589.test.js` 11건 — 변이 검증: 수정 전 코드로 5건 실패 ·
    웹 `components/errorBoxProps.test.js`):
    - ⚠⚠ **인증에 실패한 요청의 이름을 계측 키로 쓰지 말 것**(`routes/central.js` GET 훅 + `central/pullStats.js
      PULL_UNAUTH_KEY`): v2.587 이 막힌 pull 도 세겠다며 `?agent=`/`X-Agent-Name` 을 믿었더니 **토큰 없는 요청 하나로
      실제 엣지의 기록에 실패가 합쳐졌다**(개별 토큰 엣지면 '검증됨' 행이라 지도에 거짓 장애) · 이름 500개로 LRU 가 실제
      기록을 밀어냈다. 버그·보안·아키텍처 **3축이 독립 재현**했다. 인증 실패는 `(인증 실패)` 한 칸 · 상한 초과 때 검증된
      행은 밀지 않는다. v2.570 `ingestReject` 는 이미 `unverified` 로 분리돼 있었는데 GET 계측만 그 규약을 놓쳤다
      (형제 비대칭 — 새 계측기를 만들 때 **인증 실패 경로의 키**를 먼저 정할 것).
    - ⚠⚠ **IPv4 허용 판정은 '정규형만' 이다**(`util/ipv4.js strictIpv4Num`·`cidrMatch`): v2.586 통합에서 빠진 사본 3벌
      (`rma/commands.js targetAllowed`·`security/credentialStore.js hostAllowed`·`rma/settings.js ipAllowed`)이
      `'010.0.0.5'` 를 10.0.0.5 로 허용했는데 실제 접속의 `dns.lookup`(glibc inet_aton)은 **8진수 8.0.0.5** 로 해석한다
      — RMA SSH 명령·볼트 비밀이 허용 대역 밖으로 나갈 수 있었다. 목록 항목(관리자 입력)은 느슨히 읽고, **접속 대상은
      비정규 표기면 거부**한다. ⚠ 손 grep 스윕(v2.586)은 `ipToInt`·`isIpv4` 이름만 봤다 — 이번 테스트는
      `split('.').map(Number)` 형태를 소스에서 금지한다.
    - ⚠ **`ErrorBox` 는 `message`·`error` 둘 다 받는다**(`components/primitives.jsx`): 26곳이 `error=` 로 넘겨 **빈
      '오류:'** 가 떴고 403 권한 안내·업그레이드 중 '잠시 후 다시' 안내까지 함께 사라졌다(v2.398·v2.459 의 단일 지점
      처리가 그 화면들에서 통째로 무력했다). **`.btn`·`.banner` 는 v2.588 까지 CSS 규칙이 없었다**(37·11곳) — 브라우저
      기본 버튼·맨 글자. 둘 다 새 화면에서 계속 쓰이던 클래스라 **수치로는 안 잡히고 스크린샷으로만** 보인다.
    - **svcmon 파일명·버킷 경계는 포탈 오프셋**(`util/dayKey.js portalParts`·`portalMs`) — 로컬 getter 금지(v2.582
      규약의 누락 지점). KST 호스트는 파일명이 한 글자도 바뀌지 않고 UTC 호스트만 전환 시 1회 불연속이 생긴다
      (v2.586 `slotKey` 와 같은 판단). 테스트의 기준 시각 헬퍼도 같은 기준으로 바꿨다(`svcmonAnalyze.test.js L`).
    - **로그 분석 합산에서 `Object.keys(x).length` 를 루프 안에서 세지 말 것** — 168버킷 × 키 700개에서 1,682ms 로
      이벤트 루프를 막았다(A/B 실측 → 65ms). 오래된 버킷의 `http` 도 상위 100개로 줄인다(무인증 404 경로가 들어온다).
    - 그 밖: 통신 지도 수신 행은 **마지막 수신이 가장 늦은 행**(바이트 순 첫 행 금지) · 삭제된 vCenter 명시 지정은 귀속
      아님(`matchedBy.explicitStale`) · `dayKey` 범위 밖 값은 `''` · 통신 점검의 중앙→엣지 호출도 `recordOutbound` ·
      curuser `overLimit`·`push` 는 범위 계정에 null · `VMSERIES_MIN_FREE_GB` 빈 값은 기본 5GB.
    - 의존성: express 4.22.3 · ws 8.21.3(patch, lockfile 만). `--omit=dev` 신규 critical/high 0. dev 전용 잔여에 **vite high**
      가 있다(dev 서버 전용 — 위 의존성 줄의 수용 목록에 없던 이름이라 적어 둔다).
    - ⚠ 정직 기록: 성능 에이전트는 운영 규모(`MOCK_SCALE=3`) 폴링 라우트 p50 ≤ 1ms · 3단 지도 조립기 선형(30×4,000 에서
      14~17ms)으로 **고칠 것이 없다**고 보고했다 — 없는 결함을 만들지 않았다. 확인 못 한 것: 실엣지 규모의 지도 라우트,
      express·ws patch 의 changelog(전량 테스트로만 확인).

  - ⚠⚠ **v2.590 — 6축 병렬 감사(2차 점검) 확정분**(사용자 요청 "한번더" = v2.589 와 같은 "아키텍처 점검 개선 버그패치
    업그레이드 보안점검". 회귀는 `test/audit2590.test.js` 27건 — **변이 검증 6/6**: 수정을 하나씩 되돌리면 그 테스트가 실패한다):
    - ⚠⚠ **`requirePerm` 은 역할을 보지 않는다 — 상태 변경 라우트는 `requireRole` 을 먼저**(D1): IPAM 쓰기 7곳
      (`routes/api/ipamExport.js canWrite`)·`/vms/upgrade-tools` 가 `requirePerm('tools')` 뿐이라 **viewer + tools** 가
      주석·override·정책을 바꾸고 게스트 재부팅 유발 작업을 실행할 수 있었다. `docs/AUDIT-2026-06-27.md` 가 'C2 대부분 수정
      확인' 이라 적은 것이 **틀린 기록**이었다(정정). 테스트는 실제 `api` 라우터를 띄워 상태코드 + `requiredRole` 을 본다.
    - ⚠⚠ **`.gitignore` 는 `server/config/*` 기본 차단 + `!*.example.json`**(D4): 파일 단위 열거라 CONFIG-FILES.md 의
      **33개**가 공개 저장소에 올라갈 수 있었고 `vcenter-order.json` 은 이미 추적 중이었다(추적 해제). v2.575 SEC-12 는
      '고침' 으로 분류됐지만 실제로는 남아 있었다. 테스트가 **문서 전수를 `git check-ignore`** 로 고정한다 —
      새 설정 파일은 이제 자동으로 막힌다.
    - ⚠⚠ **위임 '지금 수집' 요청은 claim→ack 다**(P16, `util/collectRequestQueue.js` — 스토리지·SAN·PDU·SAN 사용량 4큐 공용):
      엣지가 인출하는 순간 지우면 고RTT 회선에서 응답이 유실돼도 '처리됨' 으로 보였다. 결과 push 가 도착하면 `ack`,
      시한 안에 없으면 1회 재인출, 그래도 없으면 폐기하고 `lastDropped` 로 **밝힌다**. 인출 전 수집분(1분 여유)으로는 완료
      처리하지 않는다. **새 위임 큐는 이 팩토리를 쓸 것**(CLAUDE.md 가 v2.290 부터 적은 규약의 네 번째 누락이었다).
    - ⚠⚠ **백업 변경 감시는 상태 파일을 설정으로 보지 않는다**(P1, `backup/service.js isRuntimeStateFile`·`settingsFingerprint`):
      엣지 push·폴러가 쓰는 파일에도 반응해 같은 내용의 change 백업이 보관 슬롯을 채우고 **정기·수동 백업을 지웠다**(엣지가
      많으면 반대로 디바운스가 계속 초기화돼 실제 설정 변경 백업이 한 번도 안 생겼다). 지문이 같으면 생략 · 자동 사유
      (change·startup)는 최대 10개 · 파일명에 사유. ⚠ 8MB 초과 설정 파일은 **조용히 빼지 않고** 결과·번들·화면에 밝힌다(D5).
      복원 전 자동 백업은 설정된 보관 개수를 따른다(P2 — 하드코딩 30 이었다).
    - ⚠⚠ **'못 읽은 값' 은 해소도 정상도 아니다 — 세 곳에서 또 밟았다**:
      · PDU(F5): 장비는 읽혔지만 센서·뱅크 값을 못 읽은 주기를 '정상으로 돌아왔습니다' 로 알렸다. 이제 `readAlertKeys` 로
        **값을 읽은 항목만** 해소 판정하고, 오래(`HOLD_MAX_MS` 6시간) 못 읽으면 알림 없이 끊는다(bmusage 규약과 같다).
      · SAN(F3): `porterrshow` 의 k/m/g 축약 카운터는 **반올림값**이라 `1.2m → 1.2m` 이 '신규 0 — 정상' 이 됐다. 파서가
        `_approx` 를 싣고 포트 행 `errApprox`·`framesApprox` → 기준선 `_approx` → 판정은 **증분 보류(unknown)**, 처리량은
        `fpsHeld:'approx'`. 누적값 표시는 그대로다(누적은 맞다).
      · SAN(F4): REST 스위치 스냅샷은 섹션 키가 달라(`stats`·`media`) 월간 점검이 **이미 받은 광량·에러를 보지 않고**
        '명령이 없거나 권한이 없다' 는 틀린 조치를 줬다(−15.2 dBm 포트가 있는데 종합 '정상(일부 미확인)'). 판정 쪽
        `restHealthSections` 가 SSH 키로 맞추고(구버전 엣지 스냅샷도 고쳐진다) REST 가 조회하지 않는 항목은 그렇게 말한다.
        ⚠ 점검 문구의 **백틱 6곳**도 함께 뺐다(서버 문자열이 BoldText 로 그려진다 — 웹 스윕이 못 보는 자리).
    - **추이 carry-in**(P3·P4·P5): 게스트 디스크는 조회 기간 안에 변화가 없으면 파티션·선이 사라졌다(diff 저장의 이면) →
      기간 시작 전 마지막 행을 `carried:true` 로 싣는다. vmtrack DS 는 1GB 미만씩 늘면 기준이 첫 관측에 고정돼 차트가
      실제에서 계속 벌어졌다 → 비교 기준을 **series 의 마지막 값**으로. prune 은 DS 별 마지막 행(`MAX(rowid)`)을 남긴다.
    - **만료 없는 대기**(P11): 인출하는 엣지가 없는 ping·로그 연합 조회 요청이 영원히 '대기 중' 이었다 → `expired`
      (ping 90초·로그 60초) + 화면이 **'엣지가 가져가지 않았다' 와 '결과가 오지 않았다'** 를 나눠 말한다. 중앙 직접 수집
      vCenter 의 ping 은 엣지 큐에 넣지 않는다(가져갈 엣지가 없다).
    - **svcmon push**(D2): 전 메타를 첫 청크에 몰아 항목 약 5,500개 이상이면 **매 주기 413 · 영원히 needMeta** 였고,
      413 재시도는 뒷부분 행을 오류 없이 버렸다 → `splitSvcmonChunks` 가 메타를 청크마다 나누고 413 이면 스냅샷 전체를
      다시 나눈다. `/api/central/svcmon-report` BIG_JSON 등록. ⚠ 로그 문구를 바꾸면 **로그 분석 카탈로그의 probe 도**
      바꿀 것(`logAnalysis2583` 이 잡았다 — 이번에 실제로 깨졌다).
    - 그 밖: LLM URL SSRF 검사(D6) · 로그 분석 붙여넣기 BIG_JSON 게이트 등록 · 전원꺼짐 점검이 수집 대기·연결 실패 vCenter 의
      'VM 0개' 를 전부 꺼짐으로 세던 것(P6) · VM 복제 일일 스케줄 포탈 오프셋(P8) · 스토리지 보존일 env 출처(P9) · 로그 DB
      크기에 -wal · VACUUM 뒤 체크포인트(P10) · 같은 수집 시각 용량 표본 이중 계수(P12) · 볼트 사용 기록 종료 flush(P13) ·
      업그레이드 체크포인트 하위 디렉터리(P14) · 원시/롤업 보존일 분리 prune(P15) · RMA outbox 가 보내는 중 추가분을 지우던
      것(P17) · DB 점검 quick_check 가 512MB 초과 파일에서 루프를 막던 것 → 생략하고 밝힌다 + 동시 점검 가드(P7) ·
      Horizon 이름 목록 절단 시 전체 사용자 **하한값**(F8) · Isilon 경보 절단·이벤트 절 부재(F10) · 베어메탈 NIC·HBA 사용률
      방향별 최대(F9 — rx+tx 합을 한 방향 속도로 나눠 최대 2배) · `/proc/stat` guest 이중 계수(F11) · HAProxy 백업 파일명(D9).
    - ⚠ **API 문서 생성기는 '선언 줄 끝의 주석 + 다음 줄 핸들러' 를 게이트로 읽는다** — 이번에 `async` 가 '뜻 모르는 게이트' 로
      실렸다. 라우트 선언에 주석을 붙이려면 **선언 위 줄**에 둘 것.
    - 문서: 이미 고친 것을 '아직'·'후속' 으로 적은 줄 2개 정정 · AUDIT-2026-09-21 표 누락(BUG-17·18·21)·SEC-12 분류 정정 ·
      문서의 원시 NUL 바이트 2개 제거(grep 이 문서를 바이너리로 취급했다).

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
    - ✅ 도메인 타일 6장의 메타 문구도 v2.586 에 `loadState` 의 짧은 문구(`waitMeta`)를 받는다 — V4 와
      관제 콘솔 셸 양쪽이 같은 판정을 넘긴다(기본값 '수집 대기' 는 호출부가 안 넘길 때만).
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

- **스토리지 장비 표의 '장비' 열은 `장비가 보고한 이름` 이 먼저다**(`views/tools/StorageMonTool.jsx`
  `Cell 'device'` + `storageColumns.js sortValue`, v2.530 — 사용자 요청 "'장비' 에 들어가는 데이터를
  hostname 에서 획득한 장비 명을 넣어줘"): Isilon 은 `isi status` 의 클러스터 이름, Unity/PowerStore 는
  시스템·클러스터 이름 — 현장 콘솔에 찍히는 그 이름이다.
  - ⚠ **이것은 v2.515 와 반대 방향이다.** v2.514 까지 스냅샷 이름이 우선이었고, 그래서 '수정' 폼에서
    이름을 고쳐 저장해도 표가 그대로라 사용자가 **"수정하는데 수정사항이 반영되지 않는다"** 고
    신고했다(저장은 성공했다). 원인은 순서가 아니라 **고친 값이 화면 어디에도 안 보였던 것**이다.
    그래서 등록 표시명이 다르면 둘째 줄에 **`등록명 …` 이라고 라벨을 붙여** 보여준다 —
    **이 둘째 줄을 지우면 v2.515 결함이 그대로 되살아난다.**
  - **정렬 값(`sortValue('device')`)을 같은 순서로 유지할 것** — 보이는 글자와 정렬 기준이 어긋나면
    사용자가 '정렬이 틀렸다' 고 본다.
  - **두 줄 모두 폭을 `maxWidth:150` + 말줄임으로 묶는다**(실측: 25자 이름에서 장비 열이
    101→195px). 묶지 않으면 표가 밀려 오른쪽 '작업' 열이 잘린다(v2.403 이 고쳤던 문제의 재발).
    전체 문자열은 `title` 로 남긴다.

- **긴 작업의 '진행 중' 잠금은 그 대상만 잠근다 — 화면 전체를 잠그지 말 것**(v2.529 사용자 신고
  "이 상태에서 수정 버튼 누르면 수정 창이 안떠", `views/tools/StorageMonTool.jsx`):
  스토리지 장비 표의 `수집`·`수정`·`삭제` 가 전부 **전역 `busy`** 로 잠겨 있었다. 한 장비를
  수집하는 동안 **다른 장비의 수정·삭제까지** 죽었고, **왜 안 눌리는지 화면이 말하지 않았다**
  (툴팁도 없어 '버튼이 고장난 것' 으로 보인다). Unity 수집이 v2.526(명령 24개)·v2.528(예산 150초)
  이후 최대 2분을 넘기면서 그 창이 몇 초 → 수 분으로 늘어 드러났다.
  - **'지금 수집' 은 `busyId`(그 장비)만 잠근다.** 전역 `busy` 는 전체 새로고침처럼 **진짜 전역**
    작업에만 쓴다. 버튼 글자를 `수집 중…` 으로 바꿔 무엇이 도는지 보이게 한다.
  - **`수정` 은 잠그지 않는다** — 인증 실패·수집 실패 상황에서 **자격증명을 고치는 것이 바로 그
    순간 필요한 조치**다. 그것을 막으면 사용자는 복구할 길이 없다.
  - **잠긴 버튼은 사유를 말한다**(`title`). 반응 없는 버튼은 '고장' 으로 읽힌다.
  - 같은 패턴을 쓰는 다른 표(SAN 스위치·PDU 등)를 만들 때도 **전역 잠금을 기본으로 삼지 말 것**.

- **법인 전산실 운영 온도는 '보기 전환' 화면이다**(`web/src/views/tools/RoomTemp.jsx` +
  순수 모듈 `roomTempView.js` + 서버 `idrac/roomTempSeries.js roomTempSparks`, v2.534 —
  사용자 제공 클로드 디자인 캔버스 '온도 시각화 10안' 의 **적용안 `2a`**):
  - **범위 플롯 / 매트릭스 / 상황실 월보드** 세 가지를 한 페이지에서 토글한다. 플롯·월보드에서
    법인을 누르면 매트릭스로 넘어가 **흡기 높은 서버 상위 6대**가 펼쳐진다.
  - ★ **판정은 흡기 최고값만** 쓴다(v2.381 부터의 규약). 배기·CPU 는 장비·부하에 따라 정상 범위가
    달라 **임계를 정하지 않고** 값과 **열 안에서의 상대 농도**로만 칠한다 — 두 색 체계를 섞지 말 것
    (상태색은 **판정**, 농도는 **비교**다). 흡기 열에 농도를 쓰면 판정이 사라진다.
  - ★ **흡기를 못 읽은 법인은 `ok` 가 아니라 '판정 불가'(회색)** 다. 월보드 카운트에서도
    `unknown` 을 정상에 흡수하지 않는다(v2.519·v2.523 규약과 같다 — 확인 못 한 것을 이상 없음으로
    칠하는 것이 이 화면이 만들 수 있는 가장 위험한 거짓이다).
  - ⚠ **값이 없으면 단위를 붙이지 말 것** — 월보드 타일이 `— ℃` 로 나오면 0℃ 처럼 읽힌다
    (v2.534 스크린샷 판독에서 발견해 고친 결함. 수치로는 안 잡혔다).
  - ⚠ **'상위 N대' 라고 적었으면 N행이 전부 보이는 높이여야 한다** — `maxHeight:240` 에서 6번째
    행이 잘려 '6대' 라고 해 놓고 5행만 보였다(같은 판독에서 발견).
  - **월보드 스파크라인은 폴링하지 않는다** — 보기를 열 때 `/admin/room-temp/spark` 를 **1회**
    부른다(법인 집합이 바뀔 때만 재조회). **1시간 버킷**만 써서 `samples_hourly` 롤업이 걸리게
    한다 — 법인마다 인덱스 선탐색이라 16곳도 가볍다(CLAUDE.md v2.503: '전 키 1쿼리' 로 합치면
    오히려 느려진다).
  - ⚠ **수집이 없던 시간은 선을 잇지 않는다**(`sparkPath` 가 subpath 를 끊는다). 이으면 그 시간도
    값이 있던 것처럼 보인다. 그리고 `p.avg == null` 을 **먼저** 본다 — `Number(null) === 0` 이라
    `Number.isFinite(Number(v))` 만 보면 결측이 **0℃ 로 둔갑**한다(v2.525 규약. 초판이 실제로
    그랬고 자체 테스트가 잡아냈다).
  - 전체 화면은 **Esc 로 닫힌다** — 버튼만 두면 키보드 사용자가 갇힌다.

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
  "작업 현황" 표를 보여준다. 열: `난이도 | 적합 | 실행 | 작업 | 시간 | 상태 | 비고`
  (2026-09-15 사용자 지시 — **`시간` 열을 따로 두고**, `비고` 에는 시간이 아니라 **참고 사항**을 적는다).
  - `난이도`: 낮음/보통/높음 (단순 편집·UI·엔드포인트=낮음/보통, 아키텍처·동시성·대규모
    리팩터·미해결 버그=높음)
  - `적합`: 그 난이도에 적합한 모델(낮음/보통→Sonnet, 높음→Opus)
  - `실행`: 현재 실행 중인 모델. 적합 모델과 다르면 비고에 한 줄로 알려준다.
  - `시간`: 그 항목의 **시각과 소요 시간을 함께** 적는다(2026-09-17 사용자 지시 "시간에 시간도
    표시해줘" — 그 전에도 요청했는데 **이 파일에 적지 않아 세션이 바뀌며 유실됐다**. 지우지 말 것).
    · 완료: `19:46~20:08 (22분)`  · 진행중: `20:09~ (9분째)`  · 대기: `예상 8분`
    · ⚠⚠ **시각은 반드시 한국 시각(KST)** 이다. **이 컨테이너의 `date` 는 UTC 라 그대로 쓰면
      9시간 어긋난다** — `TZ=Asia/Seoul date '+%H:%M'` 으로 뽑을 것. 사용자는 한국에 있다.
    · 완료 항목은 실제 시각, 진행중·대기는 예상을 적는다.
    여기에 참고 사항을 섞지 말 것 — 아래 `비고` 가 그 자리다.
  - `상태`: `✅ 완료 / 🔄 진행중 / ⏳ 대기`
  - `비고`: 참고 사항(판단 근거·전제·주의점·적합 모델과 다를 때의 안내). **소요 시간은 적지 않는다.**
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리해 진행여부를 보인다.
- **`.` 입력 시 작업 현황 표 응답**: 사용자가 `.` 하나만 입력하면(상태 확인 핑),
  현재 **작업중(🔄 진행중)** 인 작업과 **대기중(⏳ 대기)** 인 작업을 같은 형식의 "작업 현황" 표
  (`난이도 | 적합 | 실행 | 작업 | 시간 | 상태 | 비고`)로 정리해 보여준다. 릴리스 폴링 등 백그라운드 확인도
  표에 포함하고, 진행/대기 항목이 전혀 없으면 "모두 완료" 상태와 최근 완료 릴리스 버전을 간단히 알린다.
- **30분 이상 걸릴 것 같으면 착수 전에 방식을 물어볼 것**(2026-09-15 사용자 지시): 작업 현황 표를
  낼 때 **`시간` 열에 예상 소요**를 적고, 항목 합이 30분을 넘길 것 같으면 `AskUserQuestion` 으로 **진행 방식을 먼저
  묻는다**. 선택지는 실제로 시간이 갈리는 축으로 제시한다 — 예: ① 전체 검증(브라우저 A/B 포함, 느리지만
  결함을 잡는다) ② 표준(변경 모듈 테스트 + 브라우저 1회) ③ 빠르게(테스트만, 브라우저 생략 — 생략 사실을
  보고에 적는다). **정직성·검증 생략을 사용자가 고르게 하되, 생략하면 무엇을 못 잡는지 한 줄로 밝힌다.**
  - 시간이 실제로 어디서 나가는지(v2.513 실측 — 이 수치를 기준으로 추정할 것):
    · `npm test` 전량 **115초**(1,910건, SQLite 파일 I/O). 개발 중에는 변경 모듈만 돌린다
      (`node --test server/test/<파일>` ≈ **2초**) — 전량은 커밋 직전 1회.
    · `npm run build`(vite) **20초**. Chromium 검증은 `web/dist` 를 서빙하므로 코드를 고칠 때마다 필요하다.
    · Chromium 1라운드 **1~2분**. 라운드를 나누지 말고 한 번에 몰아서 볼 것.
    · 변경 전 커밋으로 되돌린 A/B 재빌드 **2분**(넘침·깨짐을 발견했을 때만).
    · 실제 연결 테스트처럼 **시한(60초)을 기다려야 하는 확인은 진행 표시까지만** 보고 끊는다.
  - ⚠ 이 규칙은 '검증을 줄여도 된다' 는 뜻이 아니다 — **어디에 시간을 쓸지 사용자가 정하게 하는 것**이다.
    생략한 검증은 반드시 보고에 적는다(CLAUDE.md 'Chromium 생략 시 생략 사실을 적는다' 와 같은 규약).
- **작업 완료 보고 시 토큰 사용량 표시**: 작업이 끝나 최종 보고할 때 그 작업에 사용된
  토큰 정보를 한 줄로 알려준다. 정확한 계측값이 노출되지 않는 환경에서는 추정치임을 명시하고
  근거(도구 호출 수·읽은/생성한 코드 분량)를 간단히 덧붙인다.
- **작업 완료 보고 시 수행 시간도 함께 표시**(2026-09-15 사용자 지시 "작업이 끝나면 수행시간도 같이
  표시해줘"): 토큰 사용량과 같은 줄(또는 바로 아래)에 그 작업의 **실제 수행 시간**을 적는다.
  - **측정**: 착수 시 `date -u +%s` 를 스크래치패드 파일에 적어 두고(예: `scratchpad/task_start`),
    최종 보고 직전에 다시 읽어 차이를 낸다. 세션 시작이 아니라 **그 요청을 받은 시점**이 기준이다.
  - **무엇이 포함되는지 밝힌다**: 이 시간은 벽시계(wall-clock)이므로 `npm test`(전량 115초)·
    `npm run build`(20초)·Chromium 검증(1~2분)·**CI·릴리스 대기**가 전부 들어간다. 릴리스까지 간
    작업이면 대기 시간이 절반을 넘는 경우가 많으니 `총 42분(CI·릴리스 대기 18분 포함)` 처럼
    **큰 항목을 괄호로 분리**해 적는다. 추정으로 메우지 말 것 — 측정값이 없으면 '미측정' 이라 쓴다.
  - **작업 현황 표의 `시간` 열과 혼동하지 말 것**: 그 열은 **항목별** 예상/실제이고, 여기 적는 것은
    **요청 전체의 실제 소요**다. 둘의 합이 맞지 않는 것은 정상이다(병행·대기 때문) — 억지로 맞추지 않는다.
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
