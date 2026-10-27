# 규칙 — vCenter 점검 기능(VM 구성·호스트·DS·클러스터·라이선스·태그·이벤트·증분 수집·스파이크)

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/{vcenter,vmcfg,vmhygiene,hostcfg,dscfg,clustercfg,corelicense,tags,vmchanges,vmlife,contention,availability,cost,migration,vmseries,vmtrack}/

## 목차

- (원래 2827행) 추이 트래킹 diff-저장
- (원래 2858행) 서버별 시계열을 새로 만들 때는 계열 수를 먼저 계산할 것
- (원래 2866행) 키 하나의 첫/마지막 관측은 `metaKey`(MIN/MAX)로
- (원래 2869행) 파괴적 판단의 근거가 되는 기능은 '후보' 까지만 말한다
- (원래 2879행) 가끔 쓰는 무거운 리포트는 상시 적재하지 않는다
- (원래 2885행) 실시간(20초) 스파이크 수집은 '임계 이상 순간' 만, vCenter 마다 독립 파일
- (원래 3190행) 기간은 필터가 아니라 해상도 스위치다 — 화면이 그 사실을 말해야 한다
- (원래 3714행) v2.746 — 가상머신 상세 C안: 사용률 분포 4패널 + 선택 칩 + 400px 목록. 칸·선택 판정은 서버 `inventory/vmDist.js` 하나다
- (원래 5614행) v2.697 — VM 구성 속성(B10)은 30초 인벤토리 요청에 싣지 않는다 — 오래된 VM 부터 주기당 상한만큼 다시 읽는 캐시다
- (원래 5622행) v2.698 — 특수 기능 'VM 구성 점검'(`vm-hygiene`). 판정은 `server/src/vmhygiene/analyze.js` 하나이고 B10 판정(`vmCfgFin
- (원래 5632행) v2.699 — ESXi 호스트 구성·보안(A1·A9·A11·A12). 수집은 호스트 전용 캐시 `hostcfg/cache.js`(VM 캐시와 나눴다) · 판정은 `hostcfg/
- (원래 5644행) v2.700 — 데이터스토어·경로 점검(A2·A17·A19). 멀티패스·vSAN 은 호스트 캐시의 '선택 경로 묶음', DS 운영 속성은 DS 전용 캐시(`dscfg/`)
- (원래 5652행) v2.707 — 경영 보고 묶음(C6·C11·C7). 새 수집 없음 — 이벤트·스냅샷·B10 캐시만 읽는다
- (원래 5692행) v2.706 — 운영 점검 묶음(C5·C4·C2·C3). 새 수집은 '실시간 통계 최근 창' 하나뿐이고, 나머지는 이미 받는 이벤트·호스트 캐시에 얹었다
- (원래 5705행) v2.705 — 인벤토리 증분 수집(B1 — WaitForUpdatesEx). 기본 꺼짐이고, 실패하면 그 주기는 전체 조회다
- (원래 5716행) v2.704 — vCenter 속성 조회는 페이지로 받는다(B2 — RetrievePropertiesEx). 파서는 한 벌이다
- (원래 5725행) v2.703 — 코어 라이선스 산정(A13) + 태그·사용자 지정 속성 점검(A15). 규칙을 모르면 산정하지 않고, 못 읽은 vCenter 는 '확인 안 됨' 이다
- (원래 5738행) v2.702 — VM 이동·구성 변경 이력(A7·A8). 원천은 logs DB 의 vCenter 이벤트이고 상세는 수집 시점에 `detail` 열로 싣는다
- (원래 5751행) v2.701 — 클러스터 HA·DRS 점검(A6) + 호스트 네트워크(A10). 클러스터 구성은 클러스터 전용 캐시(`clustercfg/`)이고 vcenter.clusterCfg

## 본문

- **추이 트래킹 diff-저장**(`vmtrack/`, v2.345~2.355): VM 수량·DS 사용량 추적은 **변경분만
  저장**한다 — 전량 로스터를 매 슬롯 적재하면 5,850 VM·1,100 DS × 2회/일 = 연 수백만 행.
  ds_series 는 첫 관측 + 1GB 이상 변화만(UNIQUE(slot, ds_id) upsert) 기록하고 조회 시 step
  펼침(stepFill). 기준선 원칙: 첫 관측 이전 값은 소급 표시 금지(null/'—'), 구버전 행(ds 열 0)을
  증감 기준으로 쓰지 말 것(v2.351 '+2만 TB' 오표시 실제 발생). prune 용 `ts` 단독 인덱스 유지.
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
    넣으면 거의 전 VM 이 스파이크형이 되어 권고가 전반적으로 커진다. '20초 Peak + vCenter' 템플릿(v2.723 에 'Local + vCenter' 에서 이름만 바꿨다 — 키 'both' 그대로)은 표시만 한다.
    반영 규칙(예: 지속 1분 이상 run 만)은 운영 데이터를 본 뒤 별도 결정.
  - 주기 50분은 겹침 10분(ESXi 버퍼 60분) — 한 주기 실패 = 40분 영구 소실. 상한 60·하한 20 을 서버가
    강제하고 설정 화면이 `intervalWarning` 으로 그 사실을 적는다. 기본 **꺼짐(opt-in)**, 디스크 여유 가드
    (`VMSERIES_MIN_FREE_GB`)로 포탈 디스크를 채우지 않는다. 위임 vCenter 는 엣지가 수집해 `/api/central/vmseries`
    로 push(gzip·청크·BIG_JSON 등록·413 로그 — v2.503 규약)하고 설정은 `vmseries-config` pull 로 내려간다.
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

- ⚠⚠ **v2.746 — 가상머신 상세 C안: 사용률 분포 4패널 + 선택 칩 + 400px 목록. 칸·선택 판정은 서버 `inventory/vmDist.js` 하나다**
  (사용자 요청 "가상머신 상세가 텍스트만 나오는데 멋있게" → 시안 3안 중 C. `server/src/inventory/vmDist.js` + `routes/api/inventory.js /vms` +
  웹 `views/vmDistText.js`(순수)·`VmDistPanels.jsx`·`vmDist.css`·`Vms.jsx`. 회귀 `server/test/vmDist2746.test.js` + 웹 `vmDistText.test.js`·`vmDistRender.test.jsx` —
  변이 서버 15/15 · 웹 22/22 · 검토 수정분 20/20):
  · 칸 = 5% × 20(`usageBinOf` — 못 읽음·음수 null, 100 이상은 칸 19, 100 **초과**는 `over100` 으로 따로 센다). 75 는 칸 15, 90 은 칸 18 — 화면의 75%↑·90%↑ 와 같다.
    **분포·칸 선택은 POWERED_ON VM 만**(꺼진 VM 의 사용률은 낡은 값) — 나머지는 `off` 로 센다. 웹은 칸을 다시 판정하지 않는다.
  · 각 패널의 개수는 **다른 패널의 선택만** 반영한다(자기 선택으로 자기 칸이 0 이 되면 다른 칸을 고를 수 없다 — `deviceFacets.js` 와 같은 규칙).
    **KPI 8장은 선택과 무관**하다 — 응답 `totals`(KPI 집합)와 `total`(표·페이지 집합)은 선택이 있을 때만 다르다. 선택이 없으면 응답은 예전 본문에 `facets:{}` 만 더한 것과 바이트 단위로 같다(테스트 ④ — BASE 구현 오라클 대조).
  · 쿼리 `cpuBin`·`memBin`(`a-b` 칸 번호)·`power`·`osName` 은 `vmPaging.js VM_FILTER_KEYS` 에도 넣었다 — 선택을 바꾸면 옛 커서는 400 `cursor-query-mismatch`.
    `dist=1` 일 때만 분포를 계산한다. 형식 오류는 400 `bad-facet`(field)이고 **memoJson·paged 판정보다 먼저**다.
  · ⚠ 운영 앱은 `util/queryNormalize.js` 가 배열을 마지막 값으로, 객체(`키[x]=`)를 버림으로 바꾼다 — `req.query` 만 보면 '같은 키 두 번 → 400' 이 운영에서 성립하지 않는다.
    라우트가 원문 쿼리를 `parseVmFacets(q, { rawQuery })` 로 넘긴다(`facetShapeIssues`). 테스트 하니스도 그 정규화기를 라우터 앞에 단다 — 빼면 운영 경로를 보지 않는 테스트가 된다.
  · Guest OS 키는 앞뒤 공백을 지운 원문(대소문자 그대로) · 비면 `~` · 200자에서 자르되 서로게이트 쌍 가운데서 자르지 않고 끝 공백을 지우며 `toWellFormed` —
    분포에 나온 이름을 그대로 다시 보내면 같은 키가 된다(검토 RV-S1·C-02: 200번째가 공백이거나 쌍 가운데서 잘리면 그 줄을 눌러도 0대였다).
  · 웹: '보이는 응답이 지금 선택으로 받은 것인가' 는 `selectionView().current` 하나 — 페이저·칩 개수는 current 일 때만 쓴다(선택을 바꾼 직후 한 렌더는 옛 응답이라
    옛 커서로 '다음 페이지' 가 켜졌다). 선택만 바뀐 동안 직전 응답을 흐리게 둔다(필터·GPU 가 바뀌면 예전처럼 Loading). 막대 칸의 aria-pressed 는 **그 칸 하나만 고른 경우**뿐
    (`binButton` — 90%↑ 구간 안의 칸은 '구간에 포함'). 패널의 POWERED_OFF 라벨은 '꺼짐'(KPI '정지' = 전체 − 구동은 그대로). 좁은 화면은 표 대신 2줄 목록이고
    `.vmd-mlist` 는 `max-height:64vh`(없으면 문서가 4만 px 로 늘었다). CSS 는 전부 `.vmd` 아래 · uppercase 금지 · 색은 var(--…).
  · ⚠ 조건(queryKey)이 바뀌면 쪽 번호 기록을 **실제로 비운다**(`vmPageText.navSync` + Vms.jsx 효과). `navView` 는 무시만 해서, 2페이지에서 막대를 골랐다가 '모두 해제' 하면
    예전 커서가 살아나 2페이지로 돌아갔다(통합 Chromium 확인에서 발견 — 요청에 cursor 가 실려 나갔다).
  · ⚠ (같은 릴리스 CI) ReDoS 비율 테스트의 '옛 정규식 > 40ms' 하한은 **고정 입력 크기로 두지 말 것** — 빠른 러너에서 옛 판정이 34.5ms 로 나와 실패했다
    (`audit2744h` INJPKG-02 ③). 옛 판정이 하한을 넘을 때까지 입력을 두 배로 늘린 뒤 같은 크기로 새 판정을 잰다(`growUntilSlow` — 변이 검증: 새 판정을 O(n²) 로 되돌리면 실패).
  · ⚠ 정직 기록: 실운영 vCenter 의 사용률 분포(값이 한쪽에 몰린 경우의 막대 높이)는 보지 못했다 — 목 데이터 2,242대로 확인했다.
- ⚠⚠ **v2.697 — VM 구성 속성(B10)은 30초 인벤토리 요청에 싣지 않는다 — 오래된 VM 부터 주기당 상한만큼 다시 읽는 캐시다**
  (`server/src/vmcfg/`{parse.js(순수 파서·판정·엣지 정제),cache.js,collect.js} + `soapClient.js` 배선 + 웹 `views/vmcfg/vmCfgText.js` + `EntityDetail.jsx VmCfgSection`.
  회귀 `server/test/vmCfg2697.test.js`(변이 5/5) + 웹 `vmCfgText.test.js`(서버·웹 판정 대조)):
  · 구성 16개 경로(`VM_CFG_PATHS`)는 30분, `config.hardware.device` 는 6시간 주기 · 주기당 1,000/150대 · 한 주기 추가 조회 예산 20초(넘기면 다음 조각을 시작하지 않는다).
    **경로는 전부 vSphere 5.0+ 에 있는 것만** — 없는 경로 하나가 RetrievePropertiesEx 전체를 InvalidProperty 로 만든다. 그 오류는 그 종류만 갱신 주기만큼 쉰다.
  · 캐시에 없는 VM 은 `cfg`·`dev` 키 자체가 없다(= 미수집) — 화면이 '아직 읽지 않았습니다' 라고 말한다. 불리언·수치는 못 읽으면 null, limit -1 은 '무제한'.
  · 엣지 수신은 `sanitizeVmCfg`·`sanitizeVmDev`(아는 필드만) · 인벤토리에서 사라진 VM 은 prune · 상태는 `storeStatus().vmCfg`.
  · 판정 코드(`VM_CFG_CODES` 15종)는 서버·웹 두 벌이고 테스트가 같은 입력으로 대조한다 — 코드를 더하면 웹 `VM_CFG_TEXT` 도. ② VM 점검 묶음(A3·A4·A5·A16·A18·A20)이 이 데이터를 쓴다.
- ⚠⚠ **v2.698 — 특수 기능 'VM 구성 점검'(`vm-hygiene`). 판정은 `server/src/vmhygiene/analyze.js` 하나이고 B10 판정(`vmCfgFindings`)을 그대로 쓴다**
  (`vmhygiene/{analyze,settings,notifier}.js` + `routes/api/vmHygiene.js` + 웹 `views/tools/VmHygieneTool.jsx`·`views/vmcfg/vmHygieneText.js`, 사용자 요청 A3·A4·A5·A16·A18·A20.
  회귀 `server/test/vmHygiene2698.test.js` + 웹 `vmHygieneText.test.js` — 변이 4/5 검출, 남은 1종은 결과가 같은 동등 변이(`numOrNull('')` 이 이미 null)):
  · 코드 집합 = 서버 `ALL_CODES`(B10 15 + 이 모듈 6) = 웹 `ALL_TEXT` 키(테스트 대조). 설정 범위 `RANGES` 도 서버·웹 대조.
  · **유령 스냅샷 후보 = 스냅샷 0개 + 델타 파일 있음**(`soapParse.snapshotInfo orphanDeltaGB` — 이미 받는 layoutEx 에서 계산, 왕복 0). 파일 목록이 없으면 null(모름) ·
    스냅샷이 있으면 델타는 정상 체인이다. 엣지 수신 `INV_NUM_KEYS` 에 넣었다. 포탈은 파일을 지우지 않는다(v2.505 규약).
  · 스냅샷 생성일을 모르면 나이를 판정하지 않는다 · 템플릿은 판정 밖(개수만) · 예외 목록(이름·메모 부분 일치)은 스냅샷 정책만 빼고 개수를 밝힌다 ·
    cfg/dev 를 아직 읽지 않은 VM 은 `coverage.notCollected` 로 '구성 판정에서 빠졌다' 를 화면이 말한다.
  · 알림은 기본 꺼짐 · 하루 한 번(시각 이후) · 엣지(`config.agent.centralUrl`)는 보내지 않는다 · 상태 파일 `vm-hygiene-state.json`(등록·손상 보존).
  · ⚠ 칩 버튼은 `whiteSpace:'normal' + maxWidth:'100%'` — 긴 판정 제목이 400px 에서 페이지를 38px 밀어냈다(Chromium 측정).
- ⚠⚠ **v2.699 — ESXi 호스트 구성·보안(A1·A9·A11·A12). 수집은 호스트 전용 캐시 `hostcfg/cache.js`(VM 캐시와 나눴다) · 판정은 `hostcfg/parse.js` 하나**
  (`hostcfg/{parse,cache,collect,analyze}.js` + `routes/api/hostHygiene.js` + 웹 `views/tools/HostHygieneTool.jsx`·`views/hostcfg/hostCfgText.js` + 호스트 상세 `HostCfgSection`.
  회귀 `server/test/hostCfg2699.test.js` + 웹 `hostCfgText.test.js` — 변이 6/7 검출, 남은 1종(InvalidName 처리 제거)은 호출부 catch 가 같은 결과를 내는 동등 변이):
  · ⚠ **VM 캐시(`vmcfg/cache.js`)에 호스트를 넣지 말 것** — 그 prune 은 VM ref 집합 기준이라 매 주기 호스트 항목을 지운다.
  · ⚠ **prune 은 인벤토리의 호스트 전부(`allRefs`) 기준**이다 — 읽을 대상(연결된 호스트)으로 prune 하면 끊긴 호스트의 직전 값이 사라진다(테스트 고정).
  · 경로는 5.0+ 만 본 요청에 · `config.lockdownMode`(6.0+)는 따로 요청하고 InvalidProperty 면 그 vCenter 는 다시 묻지 않는다(`noLockdownPath`) ·
    고급 설정은 `ADV_OPTIONS` 이름마다 QueryOptions(없는 이름은 그 값만 null) · 허용 수준은 QueryHostAcceptanceLevel · 인증서는 HostCertificateManager.certificateInfo.
    6시간 주기 · 주기당 40대 · 예산 15초(시작 전 예산을 넘기면 `cut`). 엣지 수신은 `sanitizeHostCfg`(아는 필드만).
  · 값은 '모름(null)' 과 '없음(빈 값·0)' 을 구분한다 — `syslogHost:''` 는 '설정 없음'(판정), null 은 '아직 안 읽음'(판정 안 함). `ntpServers:[]` 도 읽은 값이다.
  · 드리프트는 같은 클러스터의 **값을 아는 호스트끼리**만(standalone·한 대짜리 클러스터는 밖) · 다수값이 동률이면 `majority:null` 이고 양쪽을 다 표시한다.
  · 끊긴 호스트·미수집 호스트는 판정하지 않고 `coverage` 로 센다. 수집 상태(`status` — vCenter 오류 원문)는 전체 범위 관리자에게만.
  · 정직 기록: vLCM 이미지 준수(REST)는 넣지 않았다 · 실장비 응답(QueryOptions 값 타입·certificateInfo·lockdownMode)은 합성으로만 확인했다.
- ⚠⚠ **v2.700 — 데이터스토어·경로 점검(A2·A17·A19). 멀티패스·vSAN 은 호스트 캐시의 '선택 경로 묶음', DS 운영 속성은 DS 전용 캐시(`dscfg/`)**
  (`dscfg/{parse,collect,analyze}.js` + `hostcfg/parse.js parseMultipath·parseVsan` + `routes/api/storagePaths.js` + 웹 `views/tools/StoragePathsTool.jsx`·`views/dscfg/dsCfgText.js`.
  회귀 `server/test/dsCfg2700.test.js` + 웹 `dsCfgText.test.js` — 변이 7/7):
  · `hostcfg/collect.js OPTIONAL_GROUPS` — 잠금 모드·vSAN·멀티패스를 각각 따로 요청하고 InvalidProperty 면 **그 묶음만** 다시 묻지 않는다(`no*Path`). 새 버전 의존 경로는 여기에 묶음으로 더할 것.
  · ⚠ **멀티패스는 `<path>` 블록만 훑는다** — LU 블록 안에 `<lun>` 태그가 중첩돼 LU 로 자르면 틀린다. 단일 경로 판정은 **공유 LUN(FC·iSCSI·FCoE 전송)만**(로컬 디스크·CD-ROM 은 정상).
  · DS 오버할당은 **내림**(149.9% 는 150% 가 아니다 — 자체 테스트가 잡았다) · 사용량을 모르면 판정하지 않는다 · SIOC 는 마운트 2대 이상 VMFS/NFS 만.
  · VMFS 주 버전은 30초 요청의 `info` 에서 뽑는다(왕복 0, `vmfsMajor` — 중앙 `INV_NUM_KEYS`). SDRS 는 부모 moref 'group-p' 규칙의 **추정**이고 화면이 그렇게 말한다.
  · vSAN 분할 = 보고 멤버 최소값 < vSAN 호스트 수(같으면 정상 — 테스트 고정). ⚠ vsanHealth API(리싱크·객체·헬스 점수)는 읽지 않는다 — 화면이 말한다.
- ⚠⚠ **v2.707 — 경영 보고 묶음(C6·C11·C7). 새 수집 없음 — 이벤트·스냅샷·B10 캐시만 읽는다**
  (`availability/analyze.js` · `cost/{analyze,settings}.js`(`cost-rates.json`) · `migration/analyze.js` + 라우트 `vmAvailability.js`·`costShowback.js`·`migrationReadiness.js` +
  웹 `views/bizreport/*Text.js` + `VmAvailabilityTool`·`CostShowbackTool`·`MigrationReadinessTool`. 회귀 `server/test/biz2707.test.js`(변이 9/9) + 웹 `bizreport/biz2707.test.js`):
  · C6 가동률 = 1 − 정지 ÷ 측정 구간. 측정 구간 = max(기간 시작, 그 vCenter 이벤트 수집 시작, **그 VM 의 마지막 생성·복제·배포·등록**) ~ 그 vCenter 이벤트가 온전한 마지막 시각(로그 폴러의 마지막 수집 성공 — 지금과의 차이가 max(1시간, 수집 주기×3) 안이면 지금. v2.731 A2-01 — 예전 '~ 지금' 은 수집이 멈춘 꼬리를 정상 가동으로 셌다).
    정지 = 끔·일시정지 → 다음 켬(지금도 꺼져 있으면 지금까지). 첫 전원 이벤트가 '켬' 이면 그 전은 꺼져 있던 것이다. 재부팅·재설정·HA 재시작·켜기 실패는 **횟수만**.
    판정 안 함: 이벤트를 받은 적 없는 vCenter(lastTs 없음) · 끔 이벤트 뒤 켬 이벤트 없이 지금 켜져 있음(inconsistent) · 기간 내내 꺼짐(offAll). 법인 합산 = 정지 합 ÷ 측정 합.
    ⚠ '사람이 끈 정지' 판정의 시스템 계정 정규식에 **빈 대안 `^(|…)` 을 넣지 말 것** — 모든 문자열과 맞아 사람 판정이 항상 거짓이 됐다(자체 테스트가 잡았다).
  · C11 단가는 월 단가 · **빈 칸 = null(계산 안 함) · 0 = 무료** · 꺼진 VM 정책 기본 storage · 합계는 단가가 있는 항목만(partialRates). 태그 기준은 첫 태그 하나(multiTag 로 밝힘).
    단가 저장은 admin + 전체 범위 + 감사. 비용은 할당 기준이고 청구서가 아니다(화면이 말한다).
  · C7 등급 blocked > caution > ready > unknown — **막힘은 미수집이어도 사실**이라 먼저 판정하고, 그 밖에서 cfg·dev 중 하나라도 없으면 unknown. 준비율 분모는 판정한 VM(unknown 제외).
    코드 `MIG_CODES` 는 서버·웹 두 벌(테스트 대조). 가상 호환 RDM 은 막지 않는다(물리 호환만).
- ⚠⚠ **v2.706 — 운영 점검 묶음(C5·C4·C2·C3). 새 수집은 '실시간 통계 최근 창' 하나뿐이고, 나머지는 이미 받는 이벤트·호스트 캐시에 얹었다**
  (`vmlife/analyze.js` · `hostcfg/reboots.js` · `contention/{parse,cache,collect,analyze}.js` + 라우트 `vmLifecycle.js`·`contention.js`·`hostHygiene.js /reboots` +
  웹 `VmLifecycleTool.jsx`·`ContentionTool.jsx`·`HostHygieneTool RebootPanel`·`EntityDetail PerfcSection`. 회귀 `server/test/ops2706.test.js`(변이 8/8) + 웹 `views/ops2706.test.js`·`hostCfgText.test.js`):
  · ⚠⚠ **운영 이벤트는 별도 부분 인덱스 `idx_events_ops`**(`OPS_TYPES` = 생성·삭제 + 가용성 + 호스트 운영) — `idx_events_tracked` 에 종류를 더하면 옛 DB 의 인덱스 정의와
    `INDEXED BY` 가 어긋난다. 두 목록은 겹치지 않는다(테스트 고정). 가용성 종류(`AVAIL_TYPES`)는 v2.707 C6 이 같은 경로로 읽는다.
  · C5: VM 은 이벤트 이름으로 묶는다 · VmRemovedEvent 는 '디스크 삭제' 와 '인벤토리 제거' 를 구분하지 못한다(화면이 말한다) · '지금 있는가' 는 이름 대조이고 첫 수집 중이면 null.
  · C4: 스크래치·로그 위치·진단 파티션·BlueScreenTimeout 은 호스트 캐시(`ADV_OPTIONS`·`configManager.diagnosticSystem`). **못 읽은 값은 판정하지 않는다** —
    로그가 스크래치를 따라가는데 스크래치를 모르면 null. 원격 syslog 가 빈 값('')일 때만 'logs-lost'(null 은 모름). 재부팅 분류는 계획(24h 안 유지보수·종료) → 예기치 않음(2h 안
    연결 끊김) → 원인 불명(그 시간대 이벤트를 받았음 = 수집 시작이 부팅 2h 전보다 이르고 부팅 뒤 이벤트가 있음) → 이벤트 없음. 원인을 단정하지 않고 근거 이벤트를 싣는다.
  · C2·C3: 실시간(20초) 통계 최근 15표본을 VM 50개·호스트 25개 묶음 QueryPerf 로(`CONTENTION_*` — 기본 켜짐·15분·주기당 400·15초 예산). Ready %/vCPU = ms ÷ (20,000 × vCPU) × 100,
    `cpu.latency` 는 ×100 값 · -1 표본은 버리고 vCPU·카운터를 모르면 null(0 아님) · 판정은 창 **평균**, 최대는 근거. 측정 안 함·오래됨(max(45분, 주기×3))은 '경합 없음' 이 아니라 따로 센다.
    DS 지연은 호스트 `datastore.*` 인스턴스(UUID) ↔ `ds.dsUuid`(info url) — 못 잇는 UUID 는 개수로. 이웃 VM 은 **상관**이다(화면이 말한다). 엣지 수신은 `sanitizeVmPerfc`·`sanitizeHostPerfc`.
  · 정직 기록: 실장비 vCenter 응답(실시간 통계·HostDiagnosticSystem·BlueScreenTimeout 타입)은 확인하지 못했다(목·합성 입력).
- ⚠⚠ **v2.705 — 인벤토리 증분 수집(B1 — WaitForUpdatesEx). 기본 꺼짐이고, 실패하면 그 주기는 전체 조회다**
  (`vcenter/updateSession.js` + `soapClient.js collectFromVCenterSoap` 의 `INV_TYPES`·`INV_SPECS` + config `VC_WAIT_UPDATES`·`VC_WAIT_UPDATES_FULL_MS`.
  회귀 `server/test/waitUpdates2705.test.js` — 변이 8/8):
  · vCenter 마다 **주 수집과 별도의 오래 사는 세션** + 전용 PropertyCollector + 필터. `maxWaitSeconds=0`(기다리지 않는다) · 잘림이면 같은 호출에서 이어 받는다.
  · 바뀐 속성 이름이 **요청 경로와 정확히 같을 때만** 적용하고, 더 깊은 경로·op add 는 그 객체만 RetrieveProperties 로 다시 읽는다(부분 변경을 합치다 틀리면 오류 없이 틀린 값).
    enter 는 전체 값이다(이전 속성을 남기지 않는다).
  · 실패는 상태를 버리고 던진다(DestroyPropertyCollector + Logout) → 수집기가 그 주기를 예전 전체 조회로. **abort 는 폴백하지 않고 그대로 던진다**(데드라인 규약).
    세션 로그인 거부는 30분 쉰다(접속처·자격증명 지문이 바뀌면 즉시 재시도). 6시간마다 처음부터 · 15분 미사용 세션 정리.
  · ⚠ `updateSession.js` 는 `soapClient.js` 를 import 하지 않는다 — 클라이언트는 호출자가 `makeClient` 로 넘긴다(순환 SCC 상한 `arch2579`).
  · ⚠ 정직 기록: 실장비 vCenter 의 UpdateSet(특히 changeSet name 이 요청 경로보다 깊게 오는 빈도)은 확인하지 못했다 — 깊게 자주 오면 재조회가 늘어 이득이 줄어든다.
    스냅샷 `vcenter.invFetch.refetched` 로 확인할 것. 설정은 포탈 단위다(엣지 하나에서 먼저 켤 것).
- ⚠⚠ **v2.704 — vCenter 속성 조회는 페이지로 받는다(B2 — RetrievePropertiesEx). 파서는 한 벌이다**
  (`vcenter/soapClient.js #retrieveSpec` + `soapParse.js retrieveResultToObjectXml` + config `VC_PROPS_PAGING`·`VC_PROPS_PAGE_SIZE`·`VC_PROPS_MAX_PAGES`.
  회귀 `server/test/retrievePaging2704.test.js` — 변이 7/7):
  · `retrieveProperties`·`retrieveManyObjectProps` 가 Ex + Continue 로 받는다. 응답의 `<objects>` 를 `<returnval>` 로 바꿔 **기존 `parseObjectContent` 를 그대로** 쓴다
    (파서를 두 벌 두면 자기닫힘 같은 수정이 한쪽에만 들어간다). 토큰은 **첫 objects 앞**에서만 읽는다(속성 값 안의 `<token>` 원소를 토큰으로 읽지 않는다 — 테스트 고정).
  · 실패하면 `CancelRetrievePropertiesEx`(외부 신호 무시 — 정리 호출) · `MethodNotFound` 면 그 클라이언트 동안 예전 방식 · 다른 오류(NoPermission 등)는 폴백하지 않는다 ·
    페이지 상한을 넘으면 오류 + 취소. objects 없이 returnval 에 바로 obj 가 오는 응답(옛 모양)도 읽는다(버리면 인벤토리가 통째로 빈다).
  · ⚠ 가짜 vCenter 테스트를 쓸 때 연산 이름 `RetrievePropertiesEx` 를 함께 처리할 것 — `audit2598d` 가 정확히 `RetrieveProperties` 에서만 매달려 실패했다.
  · `retrieveObjectProps`(단일 객체)는 바꾸지 않았다. ⚠ 정직 기록: 실장비 vCenter 로 확인하지 못했다(가짜 서버).
- ⚠⚠ **v2.703 — 코어 라이선스 산정(A13) + 태그·사용자 지정 속성 점검(A15). 규칙을 모르면 산정하지 않고, 못 읽은 vCenter 는 '확인 안 됨' 이다**
  (`corelicense/analyze.js` + `routes/api/coreLicense.js` + `tags/{parse,collect,policy,analyze}.js` + `routes/api/vmTags.js` + 웹 `views/tools/CoreLicenseTool.jsx`·
  `VmTagsTool.jsx`·`views/corelicense/coreLicenseText.js`·`views/tags/vmTagsText.js` + `EntityDetail.jsx VmTagsSection`. 회귀 `server/test/coreLicense2703.test.js`(변이 6/6)·
  `vmTags2703.test.js`(변이 7/7) + 웹 문구 테스트 2종):
  · 코어 규칙 = 호스트마다 **소켓 × max(16, ceil(코어/소켓))**(`MIN_CORES_PER_SOCKET`). 소켓(`summary.hardware.numCpuPkgs` → `host.cpuSockets`)·코어를 모르면 그 호스트는
    산정하지 않고 개수를 밝힌다. vSAN 추가분은 `VSAN_TIB_PER_CORE`(none 0 · vvf 0.25 · vcf 1) 기준 전체 합으로만 낸다. 보고된 코어 라이선스 비교는 **부분 합이면 하지 않는다**.
    엣지 수신 `INV_NUM_KEYS` 에 `cpuSockets` — 위임 vCenter 는 엣지 2.703 이 필요하다.
  · 태그는 vAPI REST(`/api/cis/tagging`, 7.0U2+)를 **인벤토리 수집 안에서 `tagRefreshMs`(기본 6시간)마다** 읽는다(`TAG_SCAN`·`TAG_REFRESH_MS`). REST 세션을 따로 연다.
    사용자 지정 속성은 SOAP `CustomFieldsManager.field` + VM `customValue`. 실패해도 **직전 값을 유지**하고 오류만 남긴다. 엣지 수신은 `sanitizeTagInv`(아는 필드·상한·예약어 VM 참조 거부).
  · 상태 판정은 `tags/analyze.js tagStateOf` 하나(웹 `vmTagsText.js` 와 키 1:1). 못 읽은 vCenter 의 VM 은 '누락' 이 아니라 '확인 안 됨'. 정책(`tag-policy.json` — 설정 파일,
    비밀 없음)은 `rev` 충돌 409 · preserveCorrupt · 저장은 admin + 전체 범위 + 감사. CSV 는 `data.csv`.
  · poolSettled 결과는 `{status, value|reason}` 이다 — `r.ok` 로 읽지 말 것(초판이 그랬다).
  · ⚠ 정직 기록: Broadcom 코어 규칙은 공개 공지 기준(계약마다 다를 수 있다). vAPI 태그·customValue 응답은 실장비로 확인하지 못했다(목 데이터 · 합성 입력).
- ⚠⚠ **v2.702 — VM 이동·구성 변경 이력(A7·A8). 원천은 logs DB 의 vCenter 이벤트이고 상세는 수집 시점에 `detail` 열로 싣는다**
  (`vmchanges/{eventDetail,analyze}.js` + `logs/db.js trackedEvents` + `routes/api/vmChanges.js` + 웹 `views/tools/VmChangesTool.jsx`·`vmchanges/vmChangesText.js` +
  `EntityDetail.jsx VmChangesSection`. 회귀 `server/test/vmChanges2702.test.js`(변이 7/7) + 웹 `vmChangesText.test.js`):
  · 상세는 이동·구성 변경·권한/역할 이벤트에만 싣는다(`TRACKED_TYPES` — 모든 이벤트에 붙이면 장기 보관 DB 가 커진다). 4KB 상한, 잘린 JSON 은 저장하지 않는다.
  · ⚠⚠ **vSphere 이벤트 인자는 같은 태그가 중첩된다** — `<host><host type="HostSystem">host-2</host><name>esx-b</name></host>`. 첫 닫는 태그에서 끊으면 이름을
    놓쳐 '도착 호스트 모름' 이 된다(자체 테스트가 잡았다). `eventDetail.js inner` 는 깊이를 센다. 장치 xsi:type 에는 숫자가 들어간다(`VirtualE1000`).
  · ⚠ 조회는 `INDEXED BY idx_events_tracked`(부분 인덱스) — 통계가 없으면 플래너가 `(vcenterId,ts)` 인덱스로 기간의 **모든 이벤트**를 훑었다(EXPLAIN 실측 — 테스트가 계획을 고정).
    옛 DB 는 `detail` 열을 table_info 로 확인해 더한다(v2.603 규칙). 2.702 이전 이벤트는 상세가 null 이고 화면이 개수로 밝힌다.
  · VM 은 이벤트 엔티티 **이름**으로 묶는다(동명 VM 구분 불가 — 화면이 말한다). 과다 이동 기준 = 7일에 10회를 기간에 비례(`churnThreshold`, 최소 3).
  · 이벤트를 받은 적 없는 vCenter·수집 꺼짐·최소 심각도 > info 는 '이동 없음' 이 아니다(`coverageNote`). 읽기 상한 20,000(`truncated`).
  · VM 상세는 `/tools/vm-changes/of`(30일·20건, 범위 밖 VM 404) — 모달은 `white-space: nowrap` 을 물려받으므로 이력 줄에 `whiteSpace:'normal'` + 그리드 트랙 `minmax(0,1fr)` 이 필요하다
    (Chromium 판독에서 오른쪽이 잘려 발견 — 같은 원인으로 구성 점검·클러스터 칸의 각주도 잘리고 있어 함께 고쳤다).
  · ⚠ 정직 기록: 실장비 이벤트 본문(configChanges·PermissionAddedEvent)은 합성 입력으로만 확인했다.
- ⚠⚠ **v2.701 — 클러스터 HA·DRS 점검(A6) + 호스트 네트워크(A10). 클러스터 구성은 클러스터 전용 캐시(`clustercfg/`)이고 vcenter.clusterCfg 로 싣는다**
  (`clustercfg/{parse,collect,analyze}.js` + `hostcfg/parse.js parseNetwork` + `routes/api/clusterCheck.js` + 웹 `views/tools/ClusterCheckTool.jsx`·`views/clustercfg/clusterCfgText.js` +
  `EntityDetail.jsx ClusterCfgSection`. 회귀 `server/test/clusterCfg2701.test.js` + 웹 `clusterCfgText.test.js`·`hostCfgText.test.js` — 변이 12종 중 11종, 남은 1종은 동등 변이):
  · `configurationEx` 는 VM 별 재정의(dasVmConfig·drsVmConfig)를 함께 실어 커진다 — **5개씩**·30분 주기·주기당 50(`CLUSTER_CFG_*`). HA 의 첫 `<enabled>` 만 HA 다(defaultVmSettings 안의 enabled 를 읽지 말 것).
  · 블록 추출은 선형 indexOf 이고 **태그 다음 글자가 공백·'>' 일 때만** 같은 태그다(`<rules>` 를 `<rule>` 로 읽지 않는다 — 테스트 고정). EVC 는 summary 를 읽었는데 키가 없으면 ''(꺼짐), summary 를 못 읽으면 null.
  · 판정: HA 를 켰는지 모르면 수용 제어·모니터링도 판정하지 않는다 · 단일 호스트 클러스터는 single-host 하나 · EVC 혼재는 **연결된 호스트**의 CPU 모델로만.
  · VM 상세의 '이 VM 의 규칙' 은 vmId 에서 **vCenter id 접두를 떼서** moref 를 얻는다(콜론 split 금지 — vCenter id 에 콜론이 있다). 상세 창은 `toolAllowed('cluster-check')` 를 먼저 본다(403 을 만들지 않게).
  · 엣지 수신은 `sanitizeClusterCfgList`(아는 필드만·규칙 50·VM 참조 100·클러스터 500). **vcenter 객체의 다른 필드(solutions 등)는 여전히 정제하지 않는다**(기존 상태 — 별건).
  · 네트워크(A10)는 호스트 캐시의 선택 경로 묶음 `noNetPath`(20대씩). 업링크 = 스위치 **직속 `<pnic>`**(브리지 nicDevice 아님) · 무차별 = **computedPolicy**(유효 정책) ·
    포트그룹 없는 표준 스위치는 판정에서 뺀다 · 링크 다운은 인벤토리 `host.nics[].link` 를 알 때만 · 포트그룹 드리프트는 목록이 잘렸으면(`pgsTotal > pgs.length`) 비교하지 않는다.
  · ⚠ 정직 기록: 실장비 응답(configurationEx·vswitch·proxySwitch XML)은 합성 입력으로만 확인했다. 위조 전송·MAC 변경은 vSS 기본값이 허용이라 판정하지 않았다(소음).

- **v2.771(점검 R6-F3)**: SOAP → REST 폴백은 **능력 부재의 증거**가 있을 때만(vim fault 는 MethodNotFound·NotSupported·NotImplemented 만, 그 밖의 vim fault 는 던져 lastGood 이월 — `soapFallbackAllowed`).
  VM 장치 조회 실패는 `vmGpuUnknown` 표지 + 직전 vm.gpu 이월(`carryVmGpu`) · 점검중 분기도 보존 창 안의 lastGood 을 싣는다(stale) · 위임 병합은 엣지 stale 을 보존(`edgeStale`)·공개 API 수집 시각 = min(receivedAt, staleSince).
  /summary 의 vCPU/코어·RAM 할당률은 용량 미상 호스트가 있으면 null + `hostsCapacityUnknown`. 남김: 재시작 직후(직전 스냅샷 없음) vmGpuUnknown 표지를 소비처(overview gpuVms·hardwareGpu·gpu/poller)가 아직 읽지 않는다.

- **v2.792 — vCenter › VM 및 폴더 'VM 목록 CSV · 엑셀(폴더 트리)'(Veeam·스냅샷 포함). 판정은 새로 만들지 않는다 — '백업 세부내용' 과 같은 `vcBackup → vmBackupView`, 한 칸 판단은 `backupStatus.backupVerdict`(= `viewClass`)**
  (사용자 요청 "vm 폴더에서 vm list export 할때 Veeam 백업여부, 백업여부 판단할 수 있는 snapshot 포함여부 포함해서 csv export" · 선택 '화면 기준 전체' · 표준 검증. 회귀 `server/test/vmListCsv2792.test.js` + 웹 `vcdVmList.test.js`):
  · `POST /veeam/vm-list.csv?vcenterId=`(읽기 POST — 본문에 화면 VM id) · 게이트 `requirePerm('data.csv')`(관리자 전용 · 웹 canCsv 와 같은 판정) · 조회 범위 밖 404(`vcOf`) ·
    받은 id ∩ 그 vCenter 인벤토리(남의 vCenter id 는 빠진다) · id 없으면 전체(`power:'noOff'` = 화면 visibleVms 와 같은 꺼진 VM 제외) · 상한 `VM_LIST_MAX_IDS`(2만 — /api 본문 1MB 안) 400 ·
    동시 1건(`exportBusy`) · 감사(대수만). 사람이 정한 표시(중요도·메모)는 백업 세부내용 도구 데이터라 싣지 않는다.
  · 열은 `veeam/vmListCsv.js` 하나: Veeam 상태는 '백업 대상·백업 중·대기·없음·연동 없음·모름' 을 나누고(모름 ≠ 없음), 스냅샷은 ① 지금 Veeam 임시 스냅샷(하루 넘으면 '잔존' 따로 — 백업 흔적으로 치지 않는다)
    ② 최근 N일 Veeam 계정 스냅샷 이벤트(모르면 '모름') ③ VM 의 전체 스냅샷(수·크기·최근·이름 — 사람이 만든 것 포함)을 따로 싣는다. 시각은 포탈 시각(머리에 UTC 오프셋).
  · 웹은 판정하지 않는다 — 보이는 VM(검색 중이면 일치 VM) id 만 보낸다(`vcdVmList.vmListRequest`). 검색 결과가 상한을 넘으면 잘라 보내지 않고 거절한다.
  · **엑셀(같은 대상·판정·게이트 — `POST /veeam/vm-list.xlsx`, 시안 https://claude.ai/artifact/MENTpVFxe9D4Y4XgAazpBg 승인 · 회귀 `vmListXlsx2792.test.js`)**: `veeam/vmListXlsx.js` —
    요약 · VM 목록(폴더 트리) · 데이터(행 단위 = CSV 와 같은 `vmListColumns`) · 읽는 법. 폴더 트리는 **엑셀 개요(행 그룹)** 로 접는다 — `outlineProperties.summaryBelow=false`
    (폴더 행이 하위 행 위 — 기본값(아래)이면 −/+ 가 엉뚱한 행에 붙는다) · 단계 = 폴더 깊이, **7 상한**(엑셀 한계 — 더 깊으면 7에 모이고 들여쓰기·'폴더 경로' 는 그대로).
    들여쓰기는 `alignment.indent` 에 **`horizontal:'left'` 를 같이** 줘야 적용된다(빠지면 엑셀·LibreOffice 가 무시 — 렌더 판독에서 확인). 폴더 행 수는 하위 포함 합계,
    Veeam 백업률 = Veeam 백업 ÷ **Veeam 상태를 아는 VM**(연동 없음·아는 VM 0대면 '—', 0% 아님). '먼저 볼 VM' 은 켜진 VM 의 확인 안 됨·모름 + 잔존(전원 무관), 템플릿·vCLS 제외.
    **워커에서 만든다**(`renderVmListWorkbook` — 2만 대를 메인에서 만들면 약 7초·최대 정지 5초, 워커는 최대 정지 62ms · 작성 중 실측) · 워커로는 열이 쓰는 인벤토리 필드만(`slimVmRows`).
    끄는 길 env `VM_LIST_XLSX_WORKER=0` · 시한 `VM_LIST_XLSX_TIMEOUT_MS`(기본 3분 = 웹 내려받기 시한). CSV 도 요청 경로에서 조각으로 만든다(`vmListCsvAsync` — 2만 대 약 130ms).
  · 폴더는 '폴더 1~N단계'(가장 깊은 VM 기준) + '폴더 경로' 열(`vmListCsv.folderParts` — 화면 `buildFolderTree` 와 같은 규칙: '/' 로 나누고 숨은 'vm' 을 뺀다). 열 수가 파일마다 다르니 **테스트는 그 파일의 머리로 열을 찾는다**.
  · **행 순서는 하나**(`vmListCsv.vmTreeCmp` — 라우트·엑셀 트리·데이터 시트·CSV 공용): 폴더는 화면 트리와 같은 **코드 단위 순서**(`Object.keys().sort()` — 'DMZ' < 'Dev'),
    같은 단계에서는 하위 폴더 먼저 그다음 직속 VM(이름 자연 순서). 검증 지적 2건(엑셀 폴더 순서 ≠ 화면 · CSV 경로 문자열 순 ≠ 데이터 시트)을 이것으로 맞췄다 — 라우트 정렬을 되돌리면 테스트가 깨진다.
  · 본문 `view`(search·all·noOff)는 **이름표일 뿐**(파일 이름·엑셀 '화면 조건') — 대상은 ids/power 로만 고른다. 모르는 값은 무시(검증 지적: 세 조건의 파일 이름이 같았다).
- **v2.795 — Veeam Enterprise Manager 를 vCenter 화면의 Veeam 출처로(VM 단위). 대조·수·판정 코어는 그대로 — EM 기록을 B&R 결과와 같은 모양(`jobs[]`·`vms[]`)으로 만들어 `resultsFor` 한 곳에서 합류한다**
  (사용자 요청 'EM 에서 등록되면 vCenter 화면에서도 등록되고 vCenter 세부 백업 내용에도 반영' · 결정 'VM 단위까지' · 'B&R 우선, 실패 시 EM' · 표준 검증. 회귀 `server/test/veeamEmVm2795.test.js`(변이 8/8)):
  · 수집(`veeam/em/client.js readVmBackups` — 항목 `vmBackups`): BackupTaskSession·VmRestorePoint 를 **새것부터 페이지로 받다가 기준보다 오래된 행에서 멈춘다**(날짜 필터 문법 미확인 — 기대지 않는다).
    항목 예산(env `VEEAM_EM_VM_BUDGET_MS`, 기본 120초)·페이지 상한이면 미완결 → 기준을 옮기지 않는다. 행은 결과 파일에 싣지 않고 `veeam/em/vmStore.js`(`veeam-em-vms.json`)에 합친다(폴러 `absorbVmRows`).
  · 저장소: 더 최신일 때만 덮음 · 진행 중 task 는 싣지 않는다(15분 주기 — 오래된 '백업 중' 금지) · 접속처 지문이 바뀌면 비움 · 서버 링크가 없는 행은 EM 의 백업 서버가 하나뿐일 때만 그 서버, 아니면 세기만(`ua`).
  · 출처(`veeam/em/sources.js`): vCenter 는 매핑 결과(수동 > 짝 B&R 등록 > 모름)만 — **모르면 어디에도 싣지 않는다**. 짝 B&R 이 이 vCenter 를 맡고 **지금 정상**(`routes/api/veeam.js brHealthy` —
    마지막 읽기 성공 ∧ `resultMaxAgeMs` 이내)이면 EM 을 빼고, 아니면 넣는다. 설정 매핑 표의 'vCenter 반영' 칸(`admin/veeamEm.js reflectOf`)도 같은 `brHealthy` 하나를 쓴다.
    VM 기록을 아직 저장하지 못했거나 서버를 가릴 수 없는 기록뿐이면 결과를 내지 않는다(뷰만 — '0대' 가 아니라 첫 수집 대기).
  · '연동됨' 판정은 `veeamLinked`(B&R 등록 ∨ EM 출처) 하나 — `serversForVcenter(...).length` 를 다시 직접 쓰지 말 것(EM 으로만 연동된 법인이 '연동 없음' 으로 돌아간다).
  · EM 기록은 `h:''`(vCenter 이름 없음) → `matchToVcenter` 가 moref 면 이름까지 같아야, moref 가 없으면 그 vCenter 에서 유일한 이름일 때만 짝짓는다. 복원 지점 수는 모른다(`rp:-1`).
    HierarchyObjRef 의 루트 GUID 는 vCenter 식별자와 같다는 보장이 없어 쓰지 않는다(문서와 사례 보고가 엇갈림).
  · 응답 캐시(backup-counts·summary·detail) 키에 `em${emSourcesRev()}`(VM 기록·매핑 리비전) — 새 기록이 60초 캐시를 기다리지 않는다.
  · ⚠ 실물 EM 응답 미확인(엔티티·필드는 문서 검색 결과 기준). 실물에서 행이 0이거나 서버 링크가 없으면 설정 › EM 수집 상태의 'VM 별 기록' 칩과 비고가 말한다.
- **v2.798 — VM 목록 내보내기 '필요한 항목만 고르기' + 계정 저장값. 열은 `veeam/vmListCatalog.js` 하나(key 고정 — 저장값에 남는다, 바꾸지 말 것)**
  ⚠ v2.800 정정: 이 창은 **백업 현황 › Detail 의 ‘CSV · 엑셀…’ 로 옮겼고** 디스크·파티션·구성·사용률 항목과 `multi:'partRows'` 는 지웠다(아래 v2.800). vCenter 화면은 VM 전체 정보 내보내기.
  (사용자 요청 "메모, TAG, 디스크 파티션 종류 등 구성 정보에서 내가 필요한 것만 선택해서 export" + "기본값 · 이름1~5 다섯 칸 · 저장하는 값 지정" · 시안 https://claude.ai/artifact/FS8Uk5piEnbFJE7qvLRWQW ·
  결정: 저장값은 계정 · 파일 시스템 종류 수집 포함 · 실시간 조회(생성일·UUID·NIC) 제외 · 표준 검증. 회귀 `server/test/vmListSelect2798.test.js`(변이 7/8 — 남은 1건은 전역 `denyDemoGuest` 가 먼저 막는 이중 방어) + 웹 `vmListExportText.test.js`):
  · `POST /veeam/vm-list.{csv,xlsx}` 본문 `cols`(고른 순서 = 열 순서 · 모르는 key 400) · 없으면 v2.792 열 그대로(`LEGACY_KEYS` — 머리·칸이 같다는 것을 테스트가 대조). `multi:'partRows'` 는 파티션 열을 고른 때만 행 반복 · `tagCols` 는 카테고리별 열.
  · 고른 항목에 필요한 소스만 읽는다(`needsOf`): Veeam 열이 없고 CSV 면 `vcBackup` 을 부르지 않는다(무겁다) — 엑셀은 요약·트리 시트가 써서 늘 부른다. 엑셀 '데이터' 시트는 라우트가 만든 표(`dataTable`)를 그대로 쓴다.
  · 값 규칙: 그 vCenter 에서 못 모은 소스(태그 수집 전·실패 · 게스트 파티션 이번 수집에 없는 VM · 구성 캐시 미도달)는 ‘수집 안 됨’(`MISSING`) · 못 읽은 값은 빈칸 — 0·없음 금지.
  · 저장값 `veeam/vmListPrefs.js`(`vm-list-prefs.json`) — 키는 **인증된 req.user.username**(본문 값 무시) · 'u:' 접두(‘__proto__’ 계정) · 저장할 내용은 사람이 고른 것만(고르지 않은 것은 불러올 때 지금 값 유지) ·
    손상 보존 → 쓰기 503 · 쓰기 게이트 data.csv + 관리자·운영자 · 칸에서 온 기본값(`def.from`)은 그 칸과 같이 바뀐다.
  · 파일 시스템 종류: `soapParse.parseGuestDisks` 가 `filesystemType` 을 읽고(`util/fsType.js fsTypeOf` — 영숫자·._- 32자, 그 밖은 버림) 엣지 정제(`sanitizeGuestDiskVms`)도 같은 함수 · `part_latest.fs` 열(ALTER — 없을 때만).
    ⚠ vSphere 7.0 이상이 주는 값으로 **추정**(실물 미확인) — 옛 판·엣지가 이 판 전이면 빈칸.
  · ⚠⚠ v2.799.1(사용자 보고 — Excel '내용에 문제가 있습니다 · 복구하시겠습니까?'): v2.792 부터 VM 목록 엑셀은 **매번** 손상 판정이었다. 'VM 목록(폴더 트리)' 시트가
    fitToPage(폭 한 장 인쇄)와 outlineProperties(개요 단추 위치)를 함께 쓰는데 exceljs 4.4.0 이 `<sheetPr>` 안에 pageSetUpPr 를 outlinePr **앞**에 쓴다(스키마는
    tabColor → outlinePr → pageSetUpPr). 바로잡기는 `util/xlsxSheetPrOrder.js`(exceljs 렌더 함수 하나를 스키마 순서판으로 — 워커가 불러오는 모듈이 import 해야 워커에도 걸린다).
    LibreOffice·openpyxl·exceljs 로 다시 읽기는 순서를 보지 않아 통과한다 — **엑셀 검증은 생성 XML 의 요소 순서를 직접 본다**(회귀 `server/test/xlsxSheetPr2799.test.js` — 인라인·워커, 변이 2/2).
- **v2.798 — EM 백업 서버 목록 보강 + 매핑 줄에서 '포탈에 B&R 로 등록'** (사용자 보고 'EM 에 등록된 서버가 많은데 전체 리스트를 못 가져온다 — 표에도 일부만' · 선택 '바로 등록' · 표준. 회귀 `server/test/veeamEmBs2798.test.js`(변이 4/4) + 웹 `backupEmText.test.js`):
  · `veeam/em/client.js completeBackupServers` — 목록(`/api/backupServers`)이 개요(`overview.backupServers`)보다 적을 때만 질의 서비스 `type=BackupServer` 로 다시 읽어 이름(대소문자 무시)으로 합친다.
    개요 수를 모르면 그대로(지어내지 않는다) · 질의 실패는 목록 유지 + 사유 · 인증 실패는 위로. 결과 `backupServersMeta`(개요·목록·합친 수) → 매핑 화면 `counts` 가 모자란 EM 을 경고로 밝힌다.
    ⚠ 원인은 **추정**(EM 계정의 역할·범위가 일부만 보이게 함) — 실물로 확인하지 못했다. 고친 뒤에도 경고가 남으면 그 EM 계정 역할부터 볼 것.
  · '포탈에 B&R 로 등록' 은 새 API 를 만들지 않는다 — 기존 `POST /admin/veeam/servers`(관리자·전체 범위·감사·비밀 봉인·SSRF 검사) 그대로 → 성공하면 `PUT /admin/veeam/em/map` 으로 그 줄을 짝짓는다(법인은 비워 B&R 등록을 따름).
    주소는 EM 이 아는 서버 이름을 미리 채울 뿐 — 접속 가능한지는 사람이 확인(화면이 말한다). 두 요청 모두 `r?.ok === false` 확인.
- **v2.799 — 특수 기능 'VM 전체 정보 내보내기'(`vm-export`) — 항목 고르기 · 출처 대체 · 계정 저장값. 열은 `vcenter/vmExportCatalog.js` 하나(key 고정 — 저장값에 남는다)**
  (사용자 요청 "VM 전체 정보 CSV 버그 수정 · 추가할 수 있는 정보 · 클로드 디자인으로 멋지게 · vm list export 참고" · 시안 https://claude.ai/artifact/FCUJ73AgKCxpzcr4J6Y6TC ·
  선택: 시안대로 · 표준 검증 · main 기준 독립. 회귀 `server/test/vmExport2799.test.js`(변이 10/11 — 남은 1건은 data.csv 게이트가 데모 계정을 먼저 막는 이중 방어) + 웹 `vmExportText.test.js`):
  · 출처(`src`)는 항목마다 하나 — snap(인벤토리) · cache(`vm.cfg`·`vm.dev`) · both(실시간 → 없으면 구성 캐시) · live(실시간 전용) · parts(실시간 guest.disk → 없으면 `partsForVcenter`) · tags(`tagInv`).
    실시간 보강은 `liveAvailability`(= `onDemandVcBlock` — 엣지 위임·비활성·점검중·인증 정지는 로그인하지 않는다) 하나로 판정하고, 접속 정보(비밀번호)는 판정 객체에 섞지 않는다(`liveGate`).
  · ⚠ 결함 재발 금지: 실시간 '성공' 이어도 **VM 마다** 속성이 왔는지로 판정한다(예전 `enriched ? 0 : ''` 는 응답에 없는 VM 의 NIC·디스크 수를 0 으로 썼다) ·
    Thin(추정)은 uncommitted 를 못 읽었으면 빈칸 · 메모리 결측 빈칸 · 시각은 `localStamp` + 머리에 시간대(예전 UTC …Z) · 장치 목록이 상한(32)에서 잘린 캐시는 디스크 수·합계를 쓰지 않는다.
  · 미리보기(`POST /tools/vm-export/preview`)는 **실시간을 부르지 않는다** — 실시간 칸은 ‘내려받을 때 조회’(예전: 화면을 열기만 해도 vCenter 전량 조회 + 60초 뒤 내려받으면 한 번 더).
  · 내려받기 `POST /tools/vm-export.{csv,xlsx}` · 예전 `GET /tools/vm-export.csv`(= ‘예전 CSV 그대로’ 100열) 모두 동시 1건(`acquireExport`) + 조건·행 수 감사(VM 이름 없음) · 내려받기 POST 는 `AUDIT_SKIP`(두 줄 방지).
    엑셀은 워커(`util/xlsxWorkerRun.js` — 새 엑셀은 이 공용 실행기를 쓴다; ipam·storage·veeam 의 기존 실행기 이전은 별건).
  · 저장값 `vcenter/vmExportPrefs.js` = `util/exportPrefs.js` 공장(파일 `vm-export-prefs.json`) — 규칙은 v2.798 `veeam/vmListPrefs.js` 와 같다(그쪽 이전은 별건).
  · 라우트는 `routes/api/vmExport.js`(ipamExport.js 에서 옮김) — 전부 data.csv + tools · 범위 밖 404 · 저장값 쓰기는 역할 게이트 먼저.
- **v2.800 — 내보내기 화면 분리(vCenter = 전체 VM · 백업 현황 = 백업)**
  (사용자 보고 "엑셀 다운 받으면 데이터가 안나와"(폴더 트리 시트가 Protected View 에서 빈 화면) + "export 는 여기(백업 현황 Detail)의 CSV 로" + "vCenter 는 전체 VM, 여기는 백업 — 분리" ·
  결정: 화면별 전용 창 · vCenter 쪽은 v2.799 VM 전체 정보 내보내기 재사용 · 표준 검증. 회귀 `vmListSelect2798.test.js` 갱신 · 웹 `vmListExportText`·`vcdVmList`·`audit2785e` 테스트):
  · 빈 시트의 원인(<sheetPr> 의 pageSetUpPr/outlinePr 순서)은 같은 날 다른 세션이 **v2.799.1 `util/xlsxSheetPrOrder.js`**(exceljs 렌더 순서 교정 — 위 항목)로 먼저 고쳤다.
    이 세션은 처음에 폴더 트리 시트에서 fitToPage 를 빼는 쪽으로 고쳤다가, main 병합 때 v2.799.1 로 통일하고 되돌렸다(폭 맞춤 인쇄 유지 · 수정 한 벌).
  · 화면 분리: vCenter › VM 및 폴더의 버튼은 ‘⤓ VM 전체 정보 내보내기…’(창 안에 `tools/VmExport.jsx` 를 그 vCenter 로 — 도구 권한 `toolAllowed('vm-export')`) ·
    백업 현황 › Detail 의 ‘CSV · 엑셀…’ = `VmListExportDialog`(백업 내보내기 — 대상: 화면에 보이는 VM(보기·검색 반영, `backupScreenRequest`, view `detail` → 파일 꼬리 `backup`) 또는 폴더).
    예전 `GET /tools/backup-detail.csv` 는 창 안 ‘예전 CSV(화면 열 그대로)’ 로 남겼다(외부 스크립트 호환).
  · `veeam/vmListCatalog.js` 는 백업 전용 — 묶음 기본 · 메모·태그·속성(+백업 표시) · 자원·IP(v2.792 열인 vCPU·메모리·스토리지·IP 만) · 스냅샷 · Veeam. 구성 항목을 다시 늘리지 말 것
    (같은 값을 `vcenter/vmExportCatalog.js` 와 두 벌로 만들게 된다). 예전 저장값의 사라진 항목은 불러올 때 빼고 개수를 알린다(`droppedCols`), `multi` 는 저장할 때 버린다.
- **v2.801 — VM 엑셀 꾸미기 · 폴더 트리 시트 · Veeam '여부' 두 항목 · 미리보기 크게 보기**
  (사용자 요청 "엑셀로 예쁘게, 가독성 좋게" · "디렉터리를 계층별로 — 폴더별로 나눠서" · "선택 항목에 veeam 마지막 백업 여부 / 백업용 snapshot 최근 생성 여부도" ·
  "미리보기를 전체화면 팝업으로" — 시안 https://claude.ai/artifact/5PT9nUWUwMPTxwURq3xm1h 승인 · 결정: 폴더 트리 시트 · 시안대로 전부 · 여부 기준 기본 1일. 회귀 `vmExcel2801.test.js`):
  · VM 전체 정보 엑셀 = 요약(`vcenter/vmExportSummary.js` — 고른 항목과 무관 · 인벤토리·구성 캐시 · 못 읽은 값은 unknown 으로 따로 · 부분 합은 '≥') · **폴더 트리**
    (뿌리 'vCenter / vm' → 폴더 → VM · 개요 단계 = 깊이(7 상한) · 폴더 행은 굵은 이름 + 회색 'N VM' · 합할 수 있는 열만 합(`SUM_KEYS`) · 전원·여부는 셈 · 열은 앞 20개 `TREE_COLS_MAX`)
    · 데이터 · 읽는 법. VM 목록 엑셀 폴더 트리도 같은 뿌리 행·표기(개요 단계가 한 칸씩 내려갔다 — `vmListXlsx2792` 갱신).
  · 서식은 `vcenter/vmXlsxStyle.js` 하나(두 엑셀 공용 · 워커 안전): 값은 그대로, 색·숫자 서식·줄무늬만. 종류는 **열 key** 로(`KIND_BY_KEY` — 테스트가 key 가 카탈로그에 있는지 본다).
    조건부 서식·수식은 쓰지 않는다(칸 고유 색을 덮고 '복구' 위험). ‘아니오’ 에 빨간 바탕을 칠하지 말 것 — 백업 안 된 VM 이 많은 법인에서 표 전체가 빨갛다(렌더 확인).
    웹 미리보기 칸 색(`web/src/views/tools/exportPreviewText.js cellTone`)은 이 규칙과 한 쌍 — 서버 테스트가 같은 입력으로 대조.
  · Veeam 묶음(VM 전체 정보)은 VM 목록 카탈로그 항목을 key·머리·칸 그대로 빌린다(`VEEAM_KEYS`). 판정 입력(vcBackup)은 veeam 라우트에 있어 **라우트끼리 import 하지 않고**
    `veeam/vmViewProvider.js` 에 veeam 라우트가 mount 때 함수를 건다(의존 방향 — arch2579). 걸린 것이 없거나 실패하면 null → 칸 '수집 안 됨'. Veeam 은 Veeam 항목을 골랐거나 엑셀(요약)일 때만 읽는다.
  · ‘여부’ 판정은 `backupStatus.recentBackupYn`·`recentBackupSnapYn` 하나(예 · 아니오 · 모름 — 연동 없음·Veeam 모름·이벤트 못 읽음은 모름). 기준 `YN_DAYS` 1·2·3·7(기본 1).
  · 미리보기 ‘크게 보기’(`components/ExportPreviewModal.jsx` — body 로 portal · 열 때 한 번 · 첫 100대 · 폴더별로 나눠 보기면 표 정렬은 끈다). 서버 상한: VM 전체 정보 `rows` 3~100 · VM 목록 ids 100.
  · ⚠ 성능(실측 6,000대 × 60열): 처음 판이 19.9초(예전 2.9초)였다 — 열 너비 계산의 `toLocaleString` 칸마다 호출이 5.6초. 숫자 길이는 직접 세고, 트리 열은 20개 상한으로 6.3초.
    나머지 비용은 exceljs 직렬화(워커 안이라 이벤트 루프는 막지 않는다). 칸마다 부르는 함수에 `toLocaleString`·`Intl` 을 넣지 말 것.
- **v2.802 — vCenter 화면 '호스트 · 클러스터 엑셀'(호스트 1대 = 시트 1장)**
  (사용자 요청 "호스트 및 클러스터 정보로 VM 처럼 멋지게 · 호스트에는 정보가 많으니 호스트 1개에 엑셀 sheet 1개 · 최대한 자세하고 많은 정보" —
  시안 https://claude.ai/artifact/HKxFuVeie66ddR2i8VxmFX 승인 · 결정: 시안대로 · 표준 검증. 회귀 `hostExport2802.test.js` · 웹 `hostExportText.test.js`):
  · 시트 = 요약(KPI 8칸 · 클러스터별 · 확인할 것) · 클러스터(HA · 승인 제어 · 모니터링 · DRS · EVC · 규칙 · 빌드 종류) · 호스트 목록(호스트 이름 = 그 시트 링크) ·
    호스트마다 한 장(머리 · KPI · 왼쪽 기본/클러스터/구성·보안 점검 · 오른쪽 네트워크/스토리지/하드웨어/온도/최근 재부팅 · 아래 VM 표) · 읽는 법.
  · **판정을 새로 하지 않는다**: 구성·보안 = `hostcfg/parse.js hostCfgFindings` + `clusterDrift`(드리프트 행) · 재부팅 = `hostcfg/reboots.js analyzeReboots`(라우트가 hostHygiene 과 같은 입력으로 읽는다) ·
    iDRAC 부품 = `idrac/invView.js inventoryView` partState · 업링크 끊김 = 구성 점검의 `net-uplink-down` 사실. 클러스터 묶음 = `clustercfg/analyze.js clusterRefMode`(열쇠 'r:ref'·'n:이름'·'standalone').
  · 화면 글자는 웹 `views/hostcfg/hostCfgText.js` 에 있다 — 서버 사본 `hostcfg/text.js`(번들 경계라 두 벌)를 테스트가 같은 입력으로 대조한다(날짜 줄만 다르다: 화면 = 브라우저 시각, 엑셀 = 포탈 시각).
  · 게이트: data.csv(관리자 전용 키) · 범위 밖 404 · 묶음 권한은 그 기능과 같은 판정(`accessOf` — tools + 도구 키 host-hygiene · cluster-check / iDRAC = `isAdminDetailUser`).
    권한으로 뺀 묶음은 그 자리와 '읽는 법' 에 사유를 적는다(조용히 빼지 않는다). ⚠ 지금은 data.csv 가 관리자 전용이라 내려받는 계정은 전부 관리자이고 묶음이 빠지는 경로는 실제로 열리지 않는다 —
    data.csv 를 운영자에게 열 수 있게 바꾸면 이 판정이 살아난다(그래서 지우지 않는다).
  · 세그먼트 `host-export` 는 특수 기능 카드 키가 아니다 — `toolAccess.UNMAPPED_TOOL_SEGMENTS` 에 사유와 함께 선언. 내려받기 POST 는 `AUDIT_SKIP`(라우트가 감사 한 줄) · 동시 1건 · 한 파일 최대 `HOSTS_MAX`(300)대.
  · 시트 안 링크는 규격 모양(`<hyperlink ref location>` — 관계 없음)으로 쓴다: `util/xlsxInternalLink.js`(exceljs 가 `시트!A1` 링크에 외부 관계 + location 을 둘 다 싣는다 — xlsxSheetPrOrder 와 같은 방식의 패치).
    ⚠ exceljs 는 **읽을 때** 이 링크를 되살리지 않는다(관계 기반만 읽는다) — 링크 검사는 XML 로 할 것. Excel · LibreOffice · openpyxl 은 location 을 읽는다.
  · 데이터스토어는 '이 호스트 VM 의 디스크가 놓인 곳'(VM 장치 캐시)이다 — 호스트별 마운트 목록은 수집하지 않는다(VM 이 없는 데이터스토어는 나오지 않는다 — 읽는 법에 적었다).
    vmk(VMkernel) 목록도 수집하지 않아 관리 IP 만 싣는다.
  · 실측(목 데이터 복제): 300대 · VM 4,800대 — 내용 120ms(메인) · 워크북 3.2초(워커 3.8초) · 1.7MB. 30대 0.5초.
- **v2.803 — 백업 현황 › Detail '백업 방식'(사람이 정한 값) · 표 6열(백업 = Veeam 또는 스냅샷 · Clone) · CSV·엑셀 반영**
  (사용자 요청 "업무 중요도 다음 '백업 방식' — Veeam · Clone · Config 백업 · 백업 안함" + "작업 열 대신 Clone 열" + "스냅샷은 Veeam 이 없을 때 Veeam 자리에" + "CSV/Excel 에도" ·
  시안 https://claude.ai/artifact/D9BQPJJdZ7XQ5iLr4F525V · 결정: 사람이 정한 값만(수집값으로 추정 안 함) · Clone 칸 = 복제 잡 마지막 실행 · 표준 검증.
  회귀 `server/test/backupMethod2803.test.js`(변이 2/2 — method 검증 제거 · PUT 키 목록에서 method 제거) + 웹 `backupViewText.test.js` v2.803 묶음):
  · 저장은 `veeam/backupMarks.js` 표시의 `method`('veeam'|'clone'|'config'|'none'|'') — 중요도와 같은 파일·같은 PUT(`/tools/backup-detail/marks`)·같은 게이트(역할 → 조회 밖 404 → 쓰기 밖 403 → 소속).
    글자는 서버 `backupStatus.METHOD_TEXT` = 웹 `backupViewText.METHODS`(테스트 대조) · 보기 필터 `method-*`(서버 VIEW_FILTERS = 웹 FILTERS + CRIT_FILTERS + METHOD_FILTERS).
  · Clone 칸 자료(`c`)는 **백업 방식이 Clone 인 VM 에만**(`vmBackupView`) — `vmclone/jobState.js cloneStateByVm` 이 실행 노드 기준으로 고른다: 중앙 직접 수집은 이 노드의 `job.lastRun`,
    엣지 위임(site)은 그 엣지의 보고(`dispatch.edgeStateOf` — VM 백업 센터 `mergeJobView` 와 같은 규칙). 보고가 없거나 담당 불일치면 '모름' — 이 노드의 낡은 기록으로 채우지 않는다.
    잡 파일을 못 읽으면 null(모름 — '잡 없음' 을 지어내지 않는다). 잡 이름·대상 경로는 싣지 않는다. Detail 응답 캐시 키에 `vmclone/store.js jobsRev()`(c) — 실행 직후에도 낡지 않게.
  · 예전 CSV(`/tools/backup-detail.csv`)는 '작업' 열을 지우지 않았다(파일 소비자 호환) — '중요도' 앞에 '백업 방식 · Clone 마지막 실행(UTC) · Clone 결과'.
    엑셀 폴더 트리 시트는 '백업 방식'(4)·'Clone'(6) 열이 들어와 폴더 행 병합이 (2~5)·(7~8), 잔존은 9번 칸 — 시트 열을 더 바꾸면 이 번호들을 함께 옮길 것.
  · v2.804(사용자 결정 '백업 방식도 반영'): 엑셀 요약 '먼저 볼 VM'(`vmListXlsx.watchList`)은 '백업 안함' VM 과 Clone 마지막 복제 성공 VM 을 '확인 안 됨'·'모름' 에서 뺀다.
    그 밖의 방식은 이유 앞에 밝히고, 잔존 스냅샷은 방식과 무관 · 표시 파일을 못 읽으면 방식으로 빼지 않는다. 화면 Summary 의 우선순위 VM(`priorityCandidates`)은 아직 방식을 보지 않는다.
