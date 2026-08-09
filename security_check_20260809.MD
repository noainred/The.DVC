# 보안 취약점 점검 — The.DVC v2.257.0 (2026-08-09)

> 방식: 전체 소스 6개 보안 차원(인증/인가/scope · SSRF/TLS · 인젝션 · 시크릿/로깅 · 중앙↔엣지
> 무결성 · 이번 세션 신규 코드)을 다중 에이전트로 **읽기 전용** 병렬 감사한 뒤, 각 후보를 독립
> 스켑틱이 **적대적으로 반증**하고(기본값 real=false), 살아남은 것만 코드로 재확인해 확정했다.
> 대상 커밋: `2638913`(v2.257.0). 성격: 사내 단일테넌트 운영 포탈. 신뢰경계는 "포탈 권한 계정 ·
> 침해된 엣지 토큰 → 중앙 데이터/원격 인프라"이다.
>
> 직전 감사·조치: [security_check_20260808.MD](security_check_20260808.MD)(M1/M2/M3), [SECURITY-AUDIT.md](SECURITY-AUDIT.md)(1차).

## 요약

| 심각도 | 건수 |
|---|---|
| Critical | **0** |
| High | **0** |
| Medium | 2 |
| Low | 3 |

**critical/high 없음.** 확정된 5건은 모두 (a) 침해된 개별 엣지 토큰 또는 (b) admin/operator 권한을
전제로 하며, 영향은 **데이터 무결성/가용성**에 국한된다. 자격증명 유출·RCE·영구 상태 파괴 경로는
발견되지 않았다. 확정 5건 중 4건은 이번 세션 M2 하드닝의 **형제 라우트 누락**(중앙 조회/보고 경로가
저장 경로와 달리 agent 바인딩·소유권 검사를 안 함) — 동일 클래스이므로 같은 모델로 봉인 가능하다.

핵심 원인 요약: `requestedAgent()`(central.js:101-104)는 `query.agent`/`X-Agent-Name`/`body.agent`만
읽으므로, 데이터를 **`?vcenters=`** 로 고르는 라우트는 `want`가 비어 바인딩 미들웨어(central.js:112,
`want` falsy면 단락)를 트리거하지 않는다. 저장 경로(6종)는 이번 세션에 `centralAuth.agent`로 봉인했으나
**조회/보고(select-by-vcenters·IP 전역 키) 경로**는 남았다.

---

## 확정 취약점 (심각도순)

### M-1 [MEDIUM · CWE-639] 연합 로그 조회가 agent↔vCenter 바인딩 미강제 — 타 사이트 조회 필터 탈취·위조 로그 주입
- **위치:** `server/src/routes/central.js:493-509` (`takeLogQueries`/`setLogQueryResult` = `central/logQueries.js:30-42`)
- **시나리오:** 침해된 엣지 1대의 유효 개별 토큰으로 `GET /api/central/log-queries?vcenters=<타사이트-vcId>`
  호출 → `agent` 파라미터가 없어 바인딩 미들웨어를 우회, `authed(req)`만 통과하면 그 vCenter의 대기
  조회(reqId + filter)를 그대로 반환하고 pending에서 삭제한다. filter에는 운영자 자유검색 `q`(계정명·
  IP·조사 키워드)가 포함돼 유출되고, 정상 엣지는 조회를 못 받는다. 이어 `POST /api/central/log-query-result`
  에 획득한 reqId로 최대 2000행 위조 로그를 주입하면 중앙 UI가 해당 사이트 로그로 표시(증거 위조).
- **수정안:** log-queries GET을 `mode==='agent'` 필수 + 요청 `vcenters`를 `req.centralAuth.agent` 소유분
  (listInventory owner)만 반환. log-query-result POST는 reqId의 vcenterId 소유 agent와 일치할 때만 수용.

### M-2 [MEDIUM · CWE-639] IPAM 스캔 결과 병합이 IP 전역 키 — 배정 범위 밖 임의 IP의 열린포트·소유 agent 덮어쓰기
- **위치:** `server/src/routes/central.js:538-547` (`mergeScanResults` = `ipam/scanStore.js:148-161`)
- **시나리오:** `POST /api/central/ip-scan-result`는 저장 attribution만 `centralAuth.agent`로 강제하고,
  보고된 IP가 그 agent의 배정 ranges(`loadScanSettings(agent).ranges`) 안인지 검사하지 않는다. 침해 엣지
  A가 `alive:[{ip:'<사이트B IP>',openPorts:[22,3389],services,hostname}]`를 보내면 lastSeen=중앙
  Date.now()로 항상 최신이 되어(stale 가드 strict `>`) 기존 정상 레코드를 위조값으로 덮어쓰고 소유
  agent를 A로 바꾼다. up/down 이력(recordSeen)까지 오염 → 공유 IPAM 기반 방화벽/자산 판단 왜곡.
- **대조:** 같은 파일·같은 세션(v2.256) 추가된 `gpu-guest-data`는 `ownsVc` 소유권 필터로 정확히 이
  엣지 간 쓰기 격리를 강제한다. ip-scan-result만 누락.
- **수정안:** 수용 전 각 `h.ip`가 `loadScanSettings(agent).ranges` 안인지 검사, 범위 밖은 드롭
  (gpu-guest-data `ownsVc`와 동일 모델).

### L-1 [LOW · CWE-639] Ping 작업 인출/보고가 vCenter 전역 키 — 타 사이트 대상 IP 탈취·도달성 위조
- **위치:** `server/src/routes/central.js:457-473` (`takePingJobs`/`setPingResults` = `central/pingJobs.js:34-59`)
- **시나리오:** M-1과 동일 패턴. `GET /api/central/ping-jobs?vcenters=<타사이트>`가 바인딩 우회 →
  타 사이트 대기 ping 대상(내부망 IP 목록) 반환·가로채기. `POST /api/central/ping-result`로 임의
  vcenterId에 `alive/rttMs` 주입 → UI 녹/적 상태 위조(가짜 'up'이 2분간 유지되어 실제 장애 은폐).
- **심각도:** ping 상태(전이적·인메모리·2분 TTL, 재시작/다음 폴로 정정)에 국한.
- **수정안:** M-1과 동일 — agent 모드에서 요청 vcenterId 소유 검사 후 인출/기록.

### L-2 [LOW · CWE-918] svcmon 점검기 SSRF 가드가 sync 전용 — DNS 이름 경유로 메타데이터·루프백 차단 우회
- **위치:** `server/src/svcmon/checker.js:59`, `server/src/svcmon/store.js:169` (`validateEndpoint`)
- **시나리오:** operator 권한(canEdit) 전제. 저장·실행 직전 재검증이 모두 동기 `ssrfBlockReason`이라
  IP 리터럴/localhost 이름만 차단하고 일반 DNS 이름은 통과시킨다. operator가 host/url을 A레코드=
  169.254.169.254 또는 127.0.0.1인 도메인으로 등록하면 서버가 그 IP로 연결 → http/soap는 keyword 유무의
  불리언 오라클, tcp/banner/cert는 루프백 관리 서비스 프로빙. 주석(checker.js:84)이 막겠다 선언한
  메타데이터·루프백이 DNS 경유로 뚫린다.
- **심각도(및 과장 배제):** 형제 egress(collector·웹훅)는 async `ssrfBlockReasonResolved`, uagmon M3는
  연결 직전 해석 IP 재검증을 쓰는데 svcmon만 sync에 머문 실재 격차. 다만 operator(신뢰 역할) 필요,
  자격증명 미첨부, RFC1918은 정상 기능이라 순증분은 169.254·127.x, **클라우드 메타데이터 자격증명
  탈취는 불가**(IMDSv2/GCP/Azure 필수 헤더를 못 싣고 본문도 미반환 — 불리언 오라클뿐). CLAUDE.md가
  동기 가드를 명시 허용(DNS rebinding은 best-effort 한계로 문서화).
- **수정안:** 실행 직전(특히 http/soap) `ssrfBlockReasonResolved`(해석 IP 검증) 또는 uagmon식 연결
  직전 dns.lookup 결과 IP 재검증 + 그 IP로 연결(호스트네임은 SNI/Host 핀).

### L-3 [LOW · CWE-409] XLSX 가져오기 경로의 압축 폭탄(zip bomb) 미방어 — 메모리/이벤트루프 DoS
- **위치:** `server/src/svcmon/formats.js:79-101` (`xlsxToCsv`), `server/src/routes/svcmon.js:409-431`, 본문 상한 `index.js:119-120`
- **시나리오:** admin/operator가 `POST /api/svcmon/targets/import`(또는 hostmap/parse)에 format='xlsx'로
  base64 XLSX 전송(디코딩 후 length만 검사, 압축해제 크기 가드 없음). `wb.xlsx.load(buffer)`가 워크북
  전체를 동기 로드하고 `ws.eachRow`로 행 상한 없이 적재한다. `LIMITS.maxBulkRows`(2000) 검사는 exceljs
  팽창 이후(parseTargetsCsv)라 무력. ~12MB 고압축 XLSX(반복 XML ~1000:1)면 수 GB 할당으로 힙 고갈/
  이벤트 루프 정지 → '이벤트 루프 블로킹 금지' 불변조건 위반.
- **심각도:** 미인증 아님(준신뢰 권한), 영향은 가용성 DoS 한정.
- **수정안:** exceljs load 전 디코딩 버퍼 상한 별도(예 2~4MB) + `xlsxToCsv` `ws.eachRow`에 행 수 상한
  throw(팽창 CSV 재조립 차단). 가능하면 스트리밍 리더로 maxBulkRows 초과 시 즉시 중단.

---

## 확인된 양호한 방어 (불변조건 준수 — 코드로 확인)

1. **중앙 저장 경로 agent 바인딩 정상** — `/svcmon-report`·`/result`·`/agent-config`·`/gpu-guest-data`·
   `/ip-scan-result`가 저장 키로 `centralAuth.agent`만 사용(body.agent 위조 봉인). 결함은 *조회/보고
   select 키가 vcenters/IP 전역인 라우트*에 국한.
2. **gpu-guest-data 엣지 간 쓰기 격리** — `ownsVc` 최장 프리픽스 + direct-mode 거부(central.js:393-423).
3. **공유 CENTRAL_TOKEN 완전 봉인 옵션** — `CENTRAL_REQUIRE_AGENT_TOKEN=true`(central.js:91).
4. **collector/웹훅 egress는 async 해석형 SSRF 가드**(`ssrfBlockReasonResolved`, admin.js:1029).
5. **uagmon M3 연결 직전 해석 IP 재검증**(SSRF 심층 방어 모범).
6. **사용자 scope 전면 강제(v2.255~2.257)** — 검색·도구 집계·IPAM 조회/쓰기 + `/summary`·`/overview`
   캐시 키 scope 서명. 외부 공유 `ipam.db` 원장은 무스코프 유지.
7. **svcmon RBAC** — canEdit=admin/operator로 상태변경 보호(viewer 등록 불가).

---

## 거짓양성으로 기각 (근거)

1. **whois refer SSRF (checker.js:276)** — 반증. 두 번째 whois 접속 대상은 하드코딩 whois.iana.org가
   TLD에 반환하는 권위 서버 값이라 공격자가 지정 불가, 1단계 비재귀, 포트 43 고정 → SSRF 필수요건
   (대상 임의 지정) 미충족. (검증 6건 중 유일한 real=false.)
2. **svcmon SSRF의 '클라우드 자격증명 탈취'** — L-2는 real이나 IMDSv2/GCP/Azure 필수 헤더 미탑재 +
   본문 미반환으로 자격증명 추출 불가 → severity low로 하향.
3. **ping-result '영구 상태 오염'** — L-1은 real이나 인메모리·2분 TTL로 자연 정정 → low.

---

## 조치 경과 (v2.259.0 — 5건 전부 수정 완료)

> 조치 후 **적대적 검증을 1회 더** 돌려 8개 후보를 재점검했고, 그중 **내가 도입한 성능 회귀 1건**
> (ip-scan 범위 검사가 IP마다 `loadScanSettings` 무캐시 파일 읽기 → 8,000 IP에 동기 read 8,000회로
> 이벤트 루프 블로킹)을 잡아 **ranges를 필터 진입 전 1회 로드·컴파일**로 고쳤다. 나머지 7건은 의도된
> 한계(아래)로 real=false.

- **M-1 (해소)** — `/log-queries` GET은 agent 모드에서 요청 vcenters를 `agentOwnsVcenter`(listInventory
  owner, TOFU)로 필터, `/log-query-result`는 reqId의 진짜 vCenter(`logQueries.vcenterOfReq`, 발급 시각에
  기록·TTL 유지)로 소유권 검사(body 값 위조 무시).
- **M-2 (해소)** — `/ip-scan-result`는 agent 모드에서 배정 ranges(`loadScanSettings(agent).ranges`를
  `specToRange` 숫자 경계로 **1회 컴파일**) 안의 IP만 병합, 범위 밖 드롭. ranges 미설정 agent는 TOFU 통과.
- **L-1 (해소)** — `/ping-jobs`·`/ping-result`도 M-1과 동일 소유권 모델.
- **L-2 (해소)** — svcmon 점검기 http/soap가 `ssrfBlockReasonResolved`(해석 IP 검증)로 전환 —
  DNS 이름 우회 차단. (소켓형 tcp/cert/… 은 오라클 없는 저위험 잔여로 문서화, 후속.)
- **L-3 (완화)** — XLSX 가져오기: 디코딩 크기 상한 8MB(413) + 재조립 행 상한(`XLSX_MAX_ROWS` 5만).
  exceljs `load()` 자체의 팽창은 Node 문자열 상한에서 catchable(500 정리)로 확인.

### 의도된 잔여 한계 (real=false — 수정 대상 아님)

- **agentOwnsVcenter TOFU**: 소유주 없는(미등록/direct-mode) vCenter는 통과 — 정상 엣지 작업 분배를
  깨지 않기 위한 의도. 완전 봉인은 `CENTRAL_REQUIRE_AGENT_TOKEN=true`(공유 토큰 차단).
- **공유 CENTRAL_TOKEN 경로**: '구별 불가한 전체 신뢰'라 소유권 검사 안 함(설계). 위 env로 봉인.
- **idrac-scan-result·capture-result**: 인출이 `?agent=` 키라 이미 바인딩 → reqId 학습 경로 없음.
- **소켓형 점검(tcp/cert/udp/…) SSRF**: 오라클(본문) 없고 operator 전제, 저장 시 동기 가드 통과.
- **http/soap DNS 리바인딩 TOCTOU**: `registry.js`에 best-effort로 문서화된 한계.

> 검증: 회귀 테스트 `server/test/centralJobScope.test.js`(6케이스) 추가, 전체 778 통과.
> 이 감사·조치는 정적 분석 + 부분 재현 기반이다.

---

## 재점검 (2026-08-09 후속 — "최대 에이전트·레퍼런스 체크") — 21건 확정 + 조치 (v2.260.0)

> 방식: 이전보다 **넓은 다중 에이전트**(파인더 ~다차원 × 파일군 병렬 → 후보별 **독립 스켑틱 2~3인
> 적대적 반증** → 살아남은 것만 CLAUDE.md 불변조건·직전 감사보고·CWE 와 **교차대조**)로 재점검했다.
> 확정 **21건**(HIGH 3 · MEDIUM 5 · LOW 10 · INFO 3). HIGH 2건은 아래 근본원인(XSS·scope)의 **결합
> 상향**이라 근본 수정으로 함께 해소된다. 신뢰경계는 이전과 동일(포탈 권한 계정 · 침해 엣지 토큰 ·
> **저신뢰 리전의 vCenter 명명 권한**).
>
> ⚠️ **직전 감사 판정 정정(정직)**: v2.259.0 조치 경과에서 `idrac-scan-result·capture-result` 를
> "인출이 `?agent=` 키라 이미 바인딩 → reqId 학습 경로 없음"으로 real=false 처리했다. **재점검에서
> 이는 틀린 판정**으로 확인됐다 — reqId 는 `idscan_<time36>_<seq36>`/`cap_<time36>_<seq36>` 로
> **예측가능**하고, 결과 POST 는 인출과 별개 요청이라 개별 토큰 엣지가 **남의 reqId 로 결과를 위조
> 주입**할 수 있었다(L-R4). 이번에 소유권 검증을 추가해 해소했다.

### HIGH

- **H-R1 [CWE-79] 3D 토폴로지 nodeLabel 저장형 XSS** (`web/src/views/Topology3D.jsx`) — **[해소]**
  `nodeLabel` 문자열은 3d-force-graph(float-tooltip)가 `innerHTML` 로 렌더한다. `n.label`/`n.region`
  은 vCenter 인벤토리의 VM/호스트/vCenter **이름**(외부 입력)이라, 저신뢰 리전의 VM 을
  `<img src=x onerror=…>` 로 명명하면 글로벌 admin 세션에서 실행되는 저장형 XSS 였다.
  → `escHtml()` 로 label/region 을 HTML 이스케이프, cpu/gpus 는 `Number()` 강제. (프론트 유일 XSS 싱크
  — `grep dangerouslySetInnerHTML|innerHTML|.html(` 전수로 형제 싱크 없음 확인.)
- **H-R2 [CWE-79] 체인A(상향): 저신뢰 vCenter 명명권 → XSS → 글로벌 admin 세션 탈취(교차테넌트 상향)**
  — **[해소]** H-R1 수정으로 상향 경로 차단.
- **H-R3 [CWE-200] 체인B(상향): scope 미강제 3종(vclogs·GPU export·IPAM override) 결합 → 범위제한
  계정의 전 함대 정찰·표적화** — **[해소]** 아래 M-R1·L-R1·M-R3 수정으로 세 조회면 모두 scope 강제.

### MEDIUM

- **M-R1 [CWE-639] `/tools/vclogs`·`/export.csv`·`/federate` 사용자 scope 미강제** — **[해소]**
  `scopeLogFilter()` 로 로그 DB 조회에 `f.vcenterIds` 화이트리스트를 강제(빈 배열=결과 없음), `meta`
  도 범위 내 vCenter 만 남겨 타 사이트 존재/건수 미노출. `/federate` POST 는 `inUserScope` 로 404.
  (`server/src/logs/db.js` 필터에 `vcenterIds` IN 절 추가.)
- **M-R2 [CWE-598/522] RDP 자격증명 쿼리스트링 폴백 잔존** (`guacdTunnel.js`·`RemoteConsole.jsx`)
  — **[해소]** 서버는 자격증명을 **티켓에서만** 읽고 `params.get()` 폴백 제거(티켓 없으면 접속 거부),
  클라이언트는 티켓 발급 실패 시 **폴백 없이 중단**(오류 표시). CLAUDE.md 'RDP 자격증명은 티켓으로'
  불변조건 완전 강제.
- **M-R3 [CWE-639] `PUT /tools/ipam/ip/:ip` 가 body.claimedVcenterId 신뢰** — **[해소]** 기존
  레코드가 있으면 **기존 소유권**으로 접근 가부를 먼저 판정(body 값으로 위장한 타 scope 예약 탈취
  차단) 후, 새 claim 도 scope 안일 때만 허용.
- **M-R4 [CWE-918] 엣지 자기등록 수집서버 URL 이 동기 SSRF 가드만 통과** — **[해소]**
  `/register-collector` 핸들러(async)가 저장 전 `ssrfBlockReasonResolved`(DNS 해석 IP 검증)를
  통과시킨다(registry API 는 동기 유지 — 기존 호출부 무회귀). 침해 엣지가 `urlHint` 로 중앙을
  루프백/메타데이터로 SSRF 하는 경로 차단(RFC1918 사내는 허용).

### LOW

- **L-R1 [CWE-639] GPU 시계열 export(`/tools/gpu/export.csv|json`) scope 미강제** — **[해소]**
  `scopedVcenterIds` 로 범위 밖(미상 호스트 포함) 행 제외.
- **L-R2 [CWE-1236] IPAM/스캔/GPU/로그 CSV export 수식 인젝션 가드 미적용** — **[해소]**
  5개 export 의 인라인 `esc` 를 `util/csv.js guardCell`(= + - @ 셀에 `'` 접두)로 통일.
- **L-R3 [CWE-307] 로그인 시점 TOTP 계정 단위 잠금 부재(IP 로테이션 우회)** — **[해소]**
  `loginRateLimit.js` 에 계정 전역(모든 IP 합산) 레이어를 추가(per-IP × `LOGIN_GLOBAL_FACTOR`=10 임계).
  단일 출발지 그리핑은 per-IP 잠금이 먼저 막고, 계정 전역 잠금은 진짜 분산 브루트포스에서만 발동
  (pyportal `GLOBAL_FACTOR` 동형 — 낮은 임계 계정잠금이 부르는 가용성 공격을 피함).
- **L-R4 [CWE-639] idrac-scan-result/progress·capture-result reqId 소유권 미검증** — **[해소]**
  (위 정정 참조) `agentOfReq`/`captureAgentOfReq` 로 배정 agent 를 조회, agent 모드면 보고 agent 와
  일치 강제(`reqAgentDenied`). 공유 토큰·미상 잡은 TOFU 통과.
- **L-R5 [CWE-770] ping-result 결과 맵 distinct-IP 총량 상한 부재** — **[해소]**
  vCenter 당 `MAX_RESULT_IPS`=512, 초과 시 오래된 항목부터 축출(pending 은 이미 MAX_IPS=64).
- **L-R6 [CWE-918] 웹훅 전송 직전 SSRF 재검증·리다이렉트 추적** — **[해소]** `alerts.js post()` 가
  전송 직전 `ssrfBlockReasonResolved` 재검증 + `redirect:'manual'`(3xx 미추적, 우회 SSRF 차단).
- **L-R7 [CWE-22] `downloadPackage` fname 경로 이탈 임의 쓰기** — **[해소]** 원격 versions.json 의
  fname 을 `path.basename` + 확장자 화이트리스트(.tar.gz/.zip)로 강제(fetch·write 양쪽).
- **L-R8 [CWE-377/367] pyportal 원자적 쓰기 임시파일 월드리더블 창** — **[해소]**
  `_open_private()` 로 tmp 를 처음부터 `0o600`(+`O_EXCL` symlink race 차단)으로 생성.
- **L-R9 [uagmon] loopback 모드 CSRF(Origin/Sec-Fetch-Site 미검사)** — **[문서화·후속]** 데스크톱
  단독 도구(loopback 바인드)라 노출면이 좁아 이번 배치에서 제외. pyportal `_cross_site` 이식 예정.
- **L-R10 [uagmon] 접속 비밀번호 무솔트 단일 SHA-256(KDF 부재)** — **[문서화·후속]** 단일 비번
  소도구. scrypt/argon2id 전환은 저장형식 마이그레이션이 필요해 별도 처리.

### INFO

- **I-R1 [CWE-916] scrypt 작업계수 Node 기본(N=16384) < 현행 권고(N=2¹⁷)** (`auth.js:18-22`)
  — **[문서화·후속]** N 상향은 **기존 저장 해시와 비호환**(고정 N 검증이라 상향 시 기존 비밀번호
  로그인 불가)이라, 버전드 해시 포맷 + 로그인 시 재해시(rehash-on-verify)가 선행돼야 안전하다.
  admin/operator 는 이미 OTP 전용(비번 없음)이라 실효 위험은 viewer/demo 로 한정.
- **I-R2 패키지 소스 baseUrl SSRF 가드 비대칭(admin 전용)** — **[문서화·후속]** admin 만 설정 가능,
  타 세션 소유 파일(admin.js) 경계라 그 세션과 협의.
- **I-R3 [uagmon] 클릭재킹 방어(frame-ancestors/X-Frame-Options) 부재** — **[문서화·후속]**

> 기각/양호로 판정돼 확정에서 제외된 후보는 반증 로그에 근거를 남겼다(적대적 검증 기본값 real=false).
> 이번 조치도 정적 분석 + 부분 재현 기반이며, DNS 리바인딩 TOCTOU 등 best-effort 한계는 유지된다.
