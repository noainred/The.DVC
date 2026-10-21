# 규칙 — 성능·DB·폴러 규약

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: 폴러·DB 모듈·캐시·대량 쓰기·응답 캐시를 새로 만들거나 고칠 때

## 목차

- (원래 79행) 수집 동시성 제한
- (원래 80행) 폴러 재진입 가드
- (원래 461행) SQLite aggregate 는 '하나' 일 때만 빠르다 — 둘을 한 쿼리에 쓰면 인덱스를 통째로 훑는다
- (원래 1819행) 수집 '작업 로그' 는 공용 팩토리 하나다
- (원래 2814행) 롤업 O(N)
- (원래 2815행) 시계열 prune 스로틀 + ts 인덱스
- (원래 2816행) ETag/304
- (원래 2817행) SQLite PRAGMA
- (원래 2819행) 대량 export 청크 패턴
- (원래 2821행) 대량 SQLite 쓰기 오프로딩
- (원래 2832행) 계측 히스토그램은 측정 대상의 실제 분포를 덮어야 한다
- (원래 2838행) 표 정렬 비교기는 `Intl.Collator` 를 한 번 만들어 재사용
- (원래 2842행) 중앙 push 는 gzip + 한도 확인
- (원래 2847행) 응답 캐시 LRU 는 vCenter 수보다 커야 한다
- (원래 2850행) prune 스로틀은 기동 첫 틱을 피한다
- (원래 2853행) N+1 을 '전 키 1쿼리' 로 합치기 전에 반드시 재 볼 것
- (원래 3034행) 동시성 풀은 `util/pool.js` 하나다
- (원래 3154행) 상시 폴링 라우트에는 예외 없이 `memoJson` + `extraKey: scopeKey(...)`
- (원래 3163행) 운영 규모를 재려면 `MOCK_SCALE`
- (원래 3269행) SQLite 모듈의 open 은 예외 없이 '진행 중인 시도' 를 공유한다 — 단일 파일이든 파일별 Map 이든
- (원래 3311행) 런타임 계측 훅으로 잰다 — 'SQL 실행 계획 전수'·'동기 fs 호출 지점별 빈도' 는 grep 으로 안 보인다
- (원래 3336행) 파일 스토어 규약은 넷이 같이 있어야 한다 — 원자 쓰기 · 손상 보존 · 종료 flush · 날짜 코어 하나
- (원래 4888행) v2.617 — 운영 중앙이 기동 약 5분 뒤 멈춘 사건(2026-09-26). 원인은 확정하지 못했고, 다음 재발 때 원인이 남게 했다
- (원래 5602행) v2.693 — 운영 멈춤(2026-10-04 · 이벤트 루프 701초 정지 → 엣지 pull 정지) 대응. 요청 경로의 큰 집계 SQL 은 '장비 × 시간 조각 + 양보 + 한 

## 본문

- **수집 동시성 제한**(`store.collectPool`, `COLLECT_CONCURRENCY` 기본 8): 28개를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU 순간 100%. 동시 개수를 제한해 평탄화.
- **폴러 재진입 가드**: `setInterval(()=>asyncFn())` 폴러는 이전 주기가 간격을 넘기면 중첩 실행돼 CPU 누적 악화. store.refresh/idrac.pollOnce/metrics.sampleOnce/nsx.refresh/gpu.pollOnce/collector.pullNow는 진행 중이면 이번 틱을 건너뛴다(새 폴러 추가 시 동일 가드 필수). 같은 작업의 수동 실행 API도 가드를 공유할 것(net/monitor.runMonitorNow 패턴).
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
- **롤업 O(N)**(`withRollups`): 호스트/VM/DS/알람을 vCenter별 1회 그룹핑 후 조회(`pick`). 그룹마다 전체 재순회(O(N×vCenter)) 금지.
- **시계열 prune 스로틀 + ts 인덱스**: 매 샘플 DELETE 스캔 금지 — N틱마다 1회(store 10틱·metrics 20틱·idrac.poller 10틱). `DELETE WHERE ts<?`는 `ts` 단독 인덱스가 있어야 풀스캔을 피한다(복합 `(server_id,ts)`로는 못 탐).
- **ETag/304**(`util/compress.js`): res.json 래퍼가 본문 SHA-1로 약한 ETag를 발급하고 If-None-Match 일치 시 304(본문 0바이트). 이 래퍼는 res.end로 직접 종료해 Express 기본 ETag가 동작하지 않으므로, 응답 경로 수정 시 ETag 발급을 없애면 프론트 `pollFetch`의 304 지원이 통째로 죽는다(과거 실제 그 상태였음 — 15초 폴 × 30초 스냅샷이면 절반이 무변동 재전송).
- **SQLite PRAGMA**: idrac/metrics/logs DB는 `WAL + synchronous=NORMAL + busy_timeout=3000`(단건 insert 5ms→0.01ms 실측). **ipam.db만 예외** — 외부 프로그램이 직접 읽는 공유 파일이라 저널 기본(DELETE) 유지 + busy_timeout만. WAL 전환 금지(외부 리더의 -wal/-shm 호환 미확인).
- **대량 export 청크 패턴**(`routes/api/hardwareGpu.js gpuSeriesExport`): 대량 시계열 조회는 5만 행 ts 윈도우 청크 + 청크 사이 `setImmediate` 양보 + 행 상한(`GPU_EXPORT_MAX_ROWS` 기본 30만). 1M행 동기 dump는 이벤트 루프 ~10초 정지 실측 — 새 export 추가 시 동일 패턴 필수.
- **대량 SQLite 쓰기 오프로딩**(`ipam/writeWorker.js`, v2.215): 레저 동기화는 DELETE+수천 행
  INSERT 다. 트랜잭션으로 fsync 는 1회지만 **바인딩·INSERT 자체가 동기 CPU** 라 5,850 VM 규모에서
  그 시간 동안 메인 루프가 멈춘다(node:sqlite 는 동기 API 뿐 — 스레드를 옮기는 것 말고 방법이 없다).
  쓰기는 워커만 하고 메인은 폴백일 때만 쓴다(두 연결이 동시에 쓰면 SQLITE_BUSY). 컬럼 정의는
  `ipam/record.js` 하나를 공유할 것 — 복사해 두면 컬럼 추가한 날 워커 INSERT 만 밀린다.
  워커 생성/실행 실패는 항상 인라인 폴백(`IPAM_WRITE_WORKER=0` 으로 완전 비활성).
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
- ⚠ **동시성 풀은 `util/pool.js` 하나다**(v2.575 IMP-08) — `poolSettled`(항목별 성패를 담는다) /
  `poolRun`(첫 rejection 을 그대로 올린다). 예전에는 같은 스캐폴드가 **손으로 23벌**이었고
  항목별 `catch` 유무가 갈려(8 vs 15) **오류 의미가 두 가지**였다. 새 수집기는 둘 중 하나를
  **이름으로 골라** 쓴다. `store.collectPool` 은 `poolSettled` 의 별칭으로 남긴다(불변조건 이름 보존).
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

- ⚠⚠ **v2.617 — 운영 중앙이 기동 약 5분 뒤 멈춘 사건(2026-09-26). 원인은 확정하지 못했고, 다음 재발 때 원인이 남게 했다**
  (사용자 캡처: active · 07:37:58 이후 로그 0줄 · 한 코어 100% · RSS 5.1→5.3GB/수 초 · 브라우저 ERR_CONNECTION_TIMED_OUT.
  회귀 `server/test/stallWatch2617.test.js` + 웹 `views/audit2617.test.js`(v2.747 에 version_5/ 에서 옮김)):
  - **코드 조사 결과(에이전트 2회)**: 영길이 매치 `while(re.exec)` 13곳 전부 안전 · 로그 분석 탭 최악 25ms · 5분 무렵 발화하는
    기본 타이머 없음 → **무한 루프 후보 0**. 가장 유력한 것은 **V8 힙 한계 근처의 GC 헛돎**(추정). 마지막 로그가 gpu-guest 였던 것은
    그 폴러가 자주 찍어서일 뿐 증거가 아니다. **'마지막 로그 줄 = 원인' 으로 단정하지 말 것.**
  - **멈춤 감시(`perf/stallWatch.js`)**: 워커 스레드가 공유 버퍼의 박동을 보고 멈추면 **`fs.writeSync(2)`** 로 직접 쓴다(console 은
    메인 경유라 멈춘 동안 못 나간다) + `inspector.Session.connectToMainThread()` 로 **메인 스택 자동 채취**(포트를 열지 않는다).
    ⚠ 박동 간격은 경계보다 짧아야 한다(같거나 길면 거짓 멈춤 — 자체 테스트가 잡았다) · 워커 eval 코드는 `process.getBuiltinModule`
    (부모가 ESM 입력 모드면 `require` 가 없다 — 자체 테스트가 잡았다). 엣지 로그 표에는 넣지 않았다(폴러 판정과 뜻이 다름 —
    edgeSweep `EXCLUDED` 에 사유) · 서비스 점검에 전용 행.
  - **힙 순간치 줄이기**: 엣지 pull `poolRun`(기본 4, 예전 `Promise.all` 무제한) · 큰 본문 동시 해석 상한(`bigJsonGate` 6건·96MB →
    503 + Retry-After, 진행 0건이면 한도보다 큰 단일 본문도 받는다) · 스냅샷 교체 때 **모든 이름**의 옛 세대 응답 캐시 제거
    (`snapCacheSweep` — v2.580 은 같은 이름에 새 키가 올 때만 지웠다) · 시작 백업 10분 뒤 · 위임 인벤토리 저장 30초 디바운스 ·
    링 버퍼 줄 8KB(평탄화 — slice 만 하면 SlicedString 이 원문을 붙잡는다).
  - **재발하면**: `journalctl -u vmware-portal | grep stallwatch` 가 멈춘 함수를 말한다. 스택이 없으면 GC 쪽이다 — 그때 다음 후보는
    에이전트 보고의 나머지(엣지별 상주 저장소 상한 16MB/엣지 · svcmon 행 상한 · 엣지 설정 사본 32MB/엣지)다.
  - **비활성(disabled) vCenter 는 '연결 불가'·'첫 수집 중' 이 아니다** — `/health`·전역 롤업에 `vcentersDisabled`. 헤더·개요·V4·관제
    콘솔·V5 가 모두 분모에서 뺐다(V5 결함이 기존 화면 4곳에도 있었다 — 형제 비대칭).
  - ⚠ 정직 기록: 코드 리뷰가 찾은 'V5 사이트 클릭' 결함은 **현재 V5 화면에 selectSite 를 부르는 곳이 없어** 드러나지 않았다(방어적 수정).
- ⚠⚠ **v2.693 — 운영 멈춤(2026-10-04 · 이벤트 루프 701초 정지 → 엣지 pull 정지) 대응. 요청 경로의 큰 집계 SQL 은 '장비 × 시간 조각 + 양보 + 한 번에 하나'**
  (`sanswitch/perfDb.js bucketAgg`·`sliceBounds`·`heavyQuery` + `collector/puller.js` 주기 상한 + `health/services.js` + `idracTrend.js pullStaleOf` + 웹 `idracStateBanner`.
  회귀 `server/test/stall2693.test.js` 7건 — 변이 5/5 · 웹 `idracTrendText.test.js` v2.693 절):
  · 원인은 확정하지 못했다(스택 없음 = 네이티브 동기 호출 추정, 직전 멈춤 19초·15초가 SAN 사용량 조회). SAN 조회는 법인 전 스위치 × 전 포트 × 최대 366일을 한 문장으로
    GROUP BY 했다. 지금은 장비마다·버킷 정배수 6시간 조각마다 묻고 `createYielder` 로 양보한다 — 조각을 버킷 경계에 맞추므로 결과는 예전 한 문장과 **같다**(테스트 대조).
    합성 2,200만 행 실측: 30일 조회 최장 멈춤 **21.0초 → 50ms**, 총 21.0초 → 8.9초. ⚠ 조각 경계를 버킷 정배수에서 떼면 한 그룹이 두 조각에 나뉘어 AVG 가 틀린다(변이 M4).
  · 같은 조회는 합류, 다른 조회는 직렬(`_chain`), 결과 20초 기억(`SANSW_PERF_QUERY_TTL_MS`) · **쓰기(import·save·prune)는 기억을 버린다**(`invalidatePerfQueries` — 세대 번호로 진행 중 결과도 다시 기억하지 않는다).
    ⚠ v2.728 정정: 기억은 수집 주기만큼이고 **쓰기는 기억을 버리지 않는다**(5분마다 오는 엣지 push 가 매번 버렸다) · 줄은 둘(multi/single) · 진행 중 조회는 비우지 않는다 — 위 v2.728 SAN 항목.
  · ⚠⚠ **재진입 가드는 '끝나지 않는 주기' 를 영원히 붙잡을 수 있다** — pull 주기에 상한(`pullCycleMaxMs`, 기본 max(주기×3, 5분), env `COLLECTOR_PULL_CYCLE_MAX_MS`). 넘긴 주기는 abort 하고
    가드를 풀어 새 주기를 시작한다(가드는 주기 번호 — 늦게 끝난 옛 주기가 새 가드를 풀지 않는다). 버린 주기가 붙잡은 수집 서버(`cycleBusy`)는 새 주기가 건너뛰고, 그것도 상한×2 를 넘기면 놓아준다.
    **새 폴러의 재진입 가드도 같은 질문을 할 것: '이 주기가 영원히 끝나지 않으면 무엇이 멈추는가'.** 상태는 `pullerStatus()`.
  · 서비스 점검 '원격 수집기' 는 개수가 아니라 `pullerHealth` 로 판정 · iDRAC 배너는 상태 'ok' 라도 정상 pull 이 max(주기×3, 5분)를 넘기면 `pullStale` → '중앙이 pull 하지 못한다'.

