# 규칙 — Arista CVP 수집·장애·GBIC·Overview

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/cvp/ · web/src/views/tools/Cvp*·cvp*

## 목차

- (원래 4378행) Arista CloudVision(CVP) 수집(v2.608) — 조회 경로는 전부 추정이고, 화면이 그 사실을 말한다
- (원래 4396행) CVP 개선(v2.640) — 장애 전이는 중앙만 판정하고, 원문 표본·파서 시험이 '추정 경로' 를 좁히는 도구다
- (원래 4414행) CVP 텔레메트리의 빈 응답은 '읽음 0개' 가 아니다 — 실장비(CVP 2023.1.1)로 확인했다
- (원래 4441행) CVP Overview·법인 구분(v2.645)
- (원래 4445행) CVP GBIC 광신호(v2.646)
- (원래 4449행) CVP GBIC — 링크가 내려간 것을 '확인한' 포트는 광량·Tx·바이어스를 판정하지 않는다. 온도·전압은 판정한다
- (원래 4455행) CVP 서버 버전 칩(v2.656)
- (원래 4630행) CVP Overview EOS 버전 패널은 버전 순(최신 먼저)이다
- (원래 4634행) CVP 장비 목록 EOS 버전 칩 · 필터 연동 KPI(v2.652)
- (원래 4639행) CVP 인터페이스 세부 정보(v2.649) — 설명은 설정 노드에서 부품 주기에 읽고, `null`(못 읽음)과 `''`(설명 없음)을 구분한다
- (원래 4688행) CVP 슬롯 전원(`ecb › LinecardN`)은 PSU 가 아니다 — 빈 슬롯/카드 전원 이상을 근거로 가른다
- (v2.922) 포트 드롭 열(in_drop/out_drop — 추정 경로) · 베어메탈 NIC 매핑·대조는 hostMatch 하나
- (v2.935) EndpointLocation(MAC → 지금 배운 포트) — 404 는 본문으로 가르고, likelihood 가 낮은 위치 · 스위치 사이 포트는 업링크가 아니다
- (v3.37) 포트 구성도 — 판정은 서버 cvp/portmap.js 하나 · 배치표는 사진으로 확인한 모델만 · 못 읽은 설명은 예비가 아니다
- (v3.46 · 표지 v3.42) 버그 점검 4회차 — 일부 목록은 저장할 때 '모름' 으로 · 무거운 조회는 heavyGate(합류 · 시작 횟수 · 공평한 차례) · 토폴로지 이름 색인 · 위치 찾기 상한 · 결정 대기 D-1~D-9

## 본문

- ⚠⚠ **Arista CloudVision(CVP) 수집(v2.608) — 조회 경로는 전부 추정이고, 화면이 그 사실을 말한다**
  (`server/src/cvp/`{registry,settings,client,parse,db,store,poller,push,collectRequests}.js + `agent/cvpConfigPull.js` + `central/cvpEdge.js` +
  `routes/api/cvp.js` + 웹 `views/tools/CvpTool.jsx`·`cvpText.js`, 사용자 요청 "arista CVP 에서 네트워크 스위치 정보 가져오는 기능 … CVP 도 Edge 에
  연결되어 있어 … 데이터 용량이 많으니까 별도의 DB". 선택: 엣지 수집 → 엣지 DB → 변경분 gzip·청크 push → 중앙 DB + 중앙 직접 · 토큰·ID/비밀번호 둘 다 ·
  전체 검증. 설계·용량 계산·후보 경로는 `docs/CVP.md`. 회귀 `test/cvp2608{a,b}.test.js` — b 는 목 CVP 로 **pollCvpOnce → 엣지 DB → pushCvpNow → 실제
  centralRouter → 중앙 DB** 를 실제 호출한다):
  - ⚠⚠ **실장비 CVP 를 본 적이 없다** — Resource API·`/cvpservice/*`·텔레메트리 REST(`/api/v1/rest/{serial}/Sysdb/...`) 경로와 필드명, 로그인 응답
    (쿠키/sessionId) 모두 추정이다. 그래서 항목마다 **후보 체인**이고 성공 조건은 '2xx' 가 아니라 **파서가 원하는 것을 읽었다**(v2.545 규약).
    `usedPaths`·`missing`·`seenFields` 를 화면이 그대로 보여 준다 — 첫 실수집에서 이 값을 보고 후보를 좁힐 것(기본값으로 굳히지 말 것).
  - **DB 는 행 수를 먼저 계산했다**: 원시 `port_sample` 은 **링크가 올라온 포트만**·기본 **7일**(200대 × 64포트 30일이면 약 11GB) + `port_daily`(평균·최대, 730일)
    + 최신 전용 표 `device_latest`·`port_latest`(GROUP BY MAX 금지). 전체 RIB 는 수집하지 않는다(BGP 는 피어 요약·prefix 수만).
  - **push 는 구성이 바뀐 장비만 레코드를 보내고 나머지는 수집 시각만(touch)** — 매번 전량이면 5분마다 530KB. 0건이어도 상태 push · 소유 검사는 토큰 종류와
    무관(남의 cvp_id·중앙 직접 등록은 `rejected`). `cvp-data` 는 BIG_JSON 등록.
  - `ports.down` 은 **관리상 켜져 있는데 링크가 내려간 포트만**이다(쓰지 않는 포트를 장애로 세지 않는다). 파트 상태는 partfault 와 같은 5종이고 못 읽으면 `null`
    (빈 배열과 다르다). 텔레메트리 403 은 인증 정지 대상이 아니다.
  - 서버 `truncated` 는 **개수 객체**다 — 진리값으로 읽으면 0 뿐인데 '(잘림)' 으로 뜬다(v2.608 Chromium 판독에서 발견. `cvpText.isTruncated`).
  - CVP 는 vCenter 귀속이 없어 범위 계정 403 · 관리 주소는 비-admin 에 가림 · 기본 꺼짐 · 등록·설정은 admin.

- ⚠⚠ **CVP 개선(v2.640) — 장애 전이는 중앙만 판정하고, 원문 표본·파서 시험이 '추정 경로' 를 좁히는 도구다**
  (`cvp/{faults,faultScan,faultNotify,preview}.js` + `client.js samples` + 라우트 5개 + 웹 `CvpTool.jsx`·`cvpText.js`, 사용자 요청 "CVP 개선해줘" —
  선택 4축 전부 · 전체 검증. 상세 `docs/CVP.md` §7. 회귀 `test/cvpFaults2640`·`cvpPreview2640`·`cvpImprove2640`(실제 api 라우터) + 웹 `cvpText.test.js`):
  - **판정은 중앙 전용**(`faultScan.js` — 엣지가 판정하면 같은 부품이 두 번 열린다: partfault v2.548 F3). 장비 접속 0(DB 최신값만), 적재 뒤 디바운스
    15초(`CVP_FAULT_SCAN_DEBOUNCE_MS`), 진행 중 프라미스 공유. `health/services.js CENTRAL_ONLY_SPEC` 에 `collect.cvpFaults` 로 등재했고
    `edgeSweep2574 EXCLUDED` 에 사유를 적었다(엣지 로그 표 대상이 아니다).
  - **닫는 6규칙은 partfault 그대로**(`faults.js` 머리말) — `unknown` 은 열지도 닫지도 않고 · `absent` 는 `removed` · 장비 실패·낡음·스트리밍 아님·
    관측 누락은 보류(`HOLD_REASON` 6종 — 웹 `HOLD_KEYS` 와 1:1, 테스트 대조). 포트 장애는 **admin up + oper down** 뿐(쓰지 않는 포트를 장애로 세지 않는다).
    알림은 `faultAlerts` **기본 꺼짐**(파트당 1건·순차·상한 밝힘). 수동 닫기는 adminOnly + 사유 필수 + 감사 로그.
  - ⚠ **`INSERT` 열 목록과 `.run` 인자 순서를 대조할 것** — `cvp_fault_event` 의 `device_name`·`fault_key` 가 바뀌어 저장돼 **비-admin 이벤트에 BGP 피어 IP 가
    새고** 라우트 테스트 ③ 이 잡았다(에이전트 생성 코드). 준비문 열 목록을 바꾸면 모든 `.run` 호출부를 같이 볼 것.
  - **원문 표본은 admin 에게만**(`stripSamples` → `samplesHidden:true`) — 관리 IP·피어 IP 가 들어 있다. 종류마다 첫 성공 응답 4,096자 / 마지막 실패 2,048바이트.
    파서 시험(`POST /tools/cvp/parse-preview`)은 왕복 0·저장 0·adminOnly·1MB 상한 — 인식 필드 0 이면 `ok:false` + `keys`(응답에 있던 필드).
  - BGP 피어 IP 가림은 **장비 상세·장애 목록·이벤트 세 응답 전부**(`maskPeers` + faults 라우트의 `(주소 가림)`) — 한 곳만 가리면 우회로다(v2.596 규약).
  - ⚠ **처리량 차트 눈금은 PAD 30 에 들어가지 않는다** — `'50.0 Kbps'` 가 `Kbps` 만 보이고 숫자가 잘렸다(Chromium 판독, 수치로는 안 잡혔다).
    `viewBox` 를 모드별로 왼쪽으로 늘린다(`XL`) — 기하(pad)는 그대로. **y축 라벨이 길어지는 모드를 추가하면 같은 자리를 볼 것.**
  - CSV 응답의 BOM 은 `Response.text()` 가 벗긴다 — 테스트는 `arrayBuffer` 원시 바이트로 본다.
  - ⚠ 정직 기록: 실장비 CVP 는 여전히 없다 — 목 CVP + Chromium(admin·operator × 1440/400) 검증이다.
- ⚠⚠ **CVP 텔레메트리의 빈 응답은 '읽음 0개' 가 아니다 — 실장비(CVP 2023.1.1)로 확인했다**(v2.641, `cvp/{client,parse,db,push}.js` +
  `cvp/bulk.js` + 웹 `CvpTool.jsx`·`cvpMoreText.js`, 사용자 요청 "기능 개선해줘"(실장비 캡처 5장) · "포트 사용량도 보는 기능" · "CVP 를 CSV
  import/export … 비밀번호·토큰도 포함". 선택 4축 전부 · 전체 검증. 상세 `docs/CVP.md` §8. 회귀 `test/cvp2641.test.js`·`cvpBulk2641.test.js` +
  웹 `cvpMoreText.test.js`·`cvpBulkText.test.js`):
  - **증상**: v2.608 후보 경로가 전부 HTTP 200 + `{"notifications":[]}` 였고 파서가 그것을 '읽었고 0개' 로 세 173대가 초록 `0/0`·'피어 없음' 이었다.
    notifications 형식에서 개체 0개는 **null(못 읽음)** 이다(`parse.notRead`). 새 파서도 이 규칙을 따를 것.
  - ⚠ **v2.642 정정 — 실장비 포인터는 `{"ptr":[조각…]}` 배열이다**(원문 표본 캡처로 확인). v2.641 은 `_ptr` 문자열만 알아 포인터를 한 번도
    따라가지 못했다(포트·BGP·CPU 전부 '읽지 못함'). 값은 `{"int":…}` 타입 래퍼·키는 객체일 수 있고·같은 경로가 여러 notification 으로 나뉜다.
    `/Kernel/proc/stat` 은 PID 별이라 CPU 후보에서 뺐다. 상세 `docs/CVP.md` §9 · 회귀 `test/cvp2642.test.js`. **추정 형식으로 파서를 만들었으면
    실장비 원문 표본을 받는 즉시 그 형식을 픽스처로 옮길 것.**
  - ⚠ **v2.643 — 파트 이름은 포인터 경로 전체, 추종 깊이는 종류별**(사용자 신고 "장애 파트 안나오는거"): 배열 포인터의 자식을 컨테이너 이름
    하나로 묶어 PSU 두 개가 한 부품으로 합쳐졌다(한쪽 ok 가 다른 쪽 장애를 덮는다) → 이름 = 키 전체를 ` › `(`PART_PATH_SEP`)로 이은 것.
    ⚠ 이름이 바뀌면 열린 장애의 키도 바뀐다(이번 캡처에는 열린 장애가 없었다). 추종은 `FOLLOW_DEPTH_BY_KIND`(포트·카운터·메모리 1, 나머지 2) —
    깊이 제한으로 따라가지 않은 포인터는 '확인하지 못한 경로' 로 세지 않는다(예전엔 장비당 상한·시간 예산을 전부 여기 썼다). 이벤트는
    `deviceRefs` 로 서비스태그 대신 **호스트네임**을 싣고 누르면 장비 상세가 열린다(색인에 없는 id 는 그대로 — 이름을 지어내지 않는다).
  - ⚠ **v2.644 — 카운터는 와일드카드 후보, BGP 는 깊이 3**(실장비 캡처: 카운터 세 후보 80대 전부 빈 응답 · BGP 는 VRF 아래가 또 포인터).
    `/Smash/counters/ethIntf/*/current/counter` 의 `*` 은 부모 포인터 키로 펼친다(`expandWildcard` · 최대 6). BGP 피어 값에 상태가 없으면
    피어로는 세되 상태는 모름. **플랫폼마다 다른 이름을 후보에 굳히지 말 것** — 와일드카드와 탐색 표본이 그 역할이다. 상세 `docs/CVP.md` §11.
  - **컬렉션은 `_ptr` 포인터다**(사용자 Telemetry Browser 캡처로 `intfStatus` 확인) — `followPtrs` 가 따라간다. 개체 이름은 **포인터 키**
    (응답 경로 꼬리는 'Ethernet3/1' 에서 잘린다). v2.608 의 `vrfBgpPeerInfoStatusEntryTable`·`/Smash/counters/ethIntf` 는 **이 장비에 없는
    경로**였다 — 경로를 추정할 때는 경로 탐색 표본(`probes`)으로 확인하기 전에 '있다' 고 적지 말 것.
  - **원문 표본은 빈 응답보다 '못 읽은 본문' 을 남긴다**(v2.640 은 빈 응답을 첫 성공으로 잡아 정작 필요한 본문이 없었다). 후보가 여럿이면 뒤 404 가
    앞 403 사유를 덮지 않는다.
  - CPU·메모리 값은 push 레코드 해시에 넣지 않는다(`devSamples` 가 싣는다) — 넣으면 매 주기 전 장비 레코드가 다시 간다.
  - CVP 서버 CSV 비밀 포함 내보내기는 iDRAC 스캔 대역·배포 대상과 같은 **설정 소유자 + 감사 로그** 경로다. 새 경로는 `/tools/cvp/bulk/*`
    (기존 `/tools/cvp/servers/:id/test` 가 `import` 를 id 로 잡으므로 분리했다).
  - ⚠ 정직 기록: 하위 필드 이름(포트 상태·카운터·BGP 새 표·부품·CPU)은 여전히 추정이다. 실장비 CVP 가 없어 목 CVP + Chromium 으로 검증했다.
- **CVP Overview·법인 구분(v2.645)** — `cvp/overview.js`(순수) + `GET /tools/cvp/overview` + 웹 `CvpOverview.jsx`·`cvpOverviewText.js`, 상세 `docs/CVP.md` §12:
  확인 불가(오래됨·스트리밍 아님·못 읽음)는 정상에도 이상에도 넣지 않는다 · **법인 = CVP 서버의 DataCenter**(장비 단위가 아니다 — 화면이 말한다) ·
  트래픽 합은 마지막 수집 **순간값** 합이고 스위치 간 링크는 양쪽에서 세어진다(측정 못 한 포트는 빼고 개수를 밝힌다) · 이벤트 `corpCounts` 는
  **법인 필터 전** 기준(고른 칩만 남으면 해제할 수 없다) · 장비 법인·모델 칩은 스토리지와 같은 `DeviceFacetBar` · 벤더 지원 상태는 지어내지 않는다.
- **CVP GBIC 광신호(v2.646)** — `parse.judgeOptics`·`xcvrDom`·`mergeXcvrDom` + `GET /tools/cvp/optics` + 웹 `CvpOptics.jsx`, 상세 `docs/CVP.md` §13:
  트랜시버 노드는 장착 여부만 준다(건강 아님 — 정상으로 칠하지 않는다) · DOM 은 xcvr 만 추종 깊이 3 + `dom` 이름 포인터만(추정 경로) ·
  **링크가 올라온 포트만** 수신 광량을 판정(바닥이 정상인 미사용 포트를 장애로 세지 않는다) · 장비 임계 먼저, 없으면 CVP 설정 `xcvrRxWarnDbm`/`xcvrRxFaultDbm` ·
  `show interfaces transceiver` 는 스위치 CLI 라 CVP REST 로 실행할 수 없다(스위치 계정이 필요 — 도입하지 않음). CVP 등록·설정은 'CVP 설정' 탭에만 있다.
- ⚠⚠ **CVP GBIC — 링크가 내려간 것을 '확인한' 포트는 광량·Tx·바이어스를 판정하지 않는다. 온도·전압은 판정한다**(v2.656, `cvp/parse.js`
  `xcvrDom.envState`·`judgeOptics` + `cvp/faults.js NO_LINK`·`partObservation closeAs` + `faultNotify.js`, 회귀 `server/test/cvpNoLink2656.test.js` — 변이 2/2):
  링크가 없으면 상대가 빛을 보내지 않고 레이저도 꺼진다(Tx·바이어스 LowAlarm 이 정상) — v2.521 SAN 광량 규약의 CVP 판. **포트 상태를 모르면
  (목록 없음·그 포트 없음) 예전 판정 그대로**다. 판정할 지표가 없으면 state unknown 이고, 전이 쪽이 `optic.portKnown && linked===false` 인 xcvr 의
  unknown 만 관측 ok + `closeAs:'no-link'` 로 바꿔 **열린 장애를 '판정 대상 아님' 으로 닫는다**(고쳐졌다는 뜻이 아님 — 알림 제목 'CVP 장애 판정 제외').
  ⚠ 판정은 엣지(`client.js judgeOptics`)이므로 엣지 위임 CVP 는 엣지 업그레이드가 필요하다. 닫힘 쪽은 중앙이 하므로 구버전 엣지 보고로도 동작한다.
- **CVP 서버 버전 칩(v2.656)** — `cvpOverviewText.cvpServerVersionMap/Of/Chips` + `DeviceFacetBar` 넷째 줄(`ver2*`, 없으면 예전 그대로):
  장비의 EOS 버전과 **다른 축**이다(장비를 관리하는 CVP 서버의 getCvpInfo 버전 — 서버 상태 `cvpVersion` 을 cvpId 로 붙인다). 칩 개수는 다른 축만
  적용한 집합 · 한 종류뿐이면 줄을 만들지 않는다 · 못 읽으면 '(CVP 버전 미상)'.
- **CVP Overview EOS 버전 패널은 버전 순(최신 먼저)이다**(v2.657, `cvpOverviewText.versionList`·`cmpEosVersion` — 재사용 Collator numeric): 예전 '갈린 버전 먼저 → 대수' 순은
  사용자 요청으로 바꿨다. '버전 갈림' 은 태그로만 남는다 · 상한 12 · 넘치면 생략 개수를 적는다.
- **CVP 장비 목록 EOS 버전 칩 · 필터 연동 KPI(v2.652)** — 사용자 요청 "CVP 버전별로 보는 기능, 모델 아래 버전 표시" + "아래 조건 필터 걸면 위 숫자 변경":
  `deviceFacets.facetState` 에 선택 셋째 축(`verSel`·`verOf`·`verLabel`, 없으면 예전 두 축 그대로 — 스토리지 화면 무변경)과 `DeviceFacetBar` 셋째 줄을 더했다
  (검색창은 마지막 줄 끝 규약 유지). 버전 = 장비의 **EOS 버전**(`cvpOverviewText.eosVersionOf`) — CVP 서버 자신의 버전이 아니다. KPI 는 필터가 걸리면
  `cvpText.totalsFromDevices`(서버 `cvpTotals` 와 같은 규칙 — 못 읽은 장비는 따로)로 다시 세고 `filterKpiNote` 가 기준 대수·목록 상한 절단·
  '열린 장애(전이)' 는 전체 기준임을 말한다(장비 목록에 전이 기록이 없어 거를 수 없다 — 지어내지 않는다).
- **CVP 인터페이스 세부 정보(v2.649) — 설명은 설정 노드에서 부품 주기에 읽고, `null`(못 읽음)과 `''`(설명 없음)을 구분한다**
  (`cvp/parse.js parseIntfConfig·intfDetailOf·xcvrTypeText` · `poller.js fillDescs` · 웹 `CvpInterfaces.jsx`·`cvpIntfText.js`, 상세 `docs/CVP.md` §16):
  DB 는 설명·세부 열이 NULL 이면 직전 값을 유지(COALESCE)한다 — '' 로 채우면 설명을 지운 것이 된다. `pick` 은 빈 문자열을 건너뛰므로 설명은 키를 직접 찾는다.
  도넛은 읽은 값만 세고 못 읽은 것은 회색 칸이다. ⚠ 설정 노드 경로와 duplex·MAC·MTU·mediaType 필드 이름은 실장비 미확인 추정이다.
- ⚠ **CVP 슬롯 전원(`ecb › LinecardN`)은 PSU 가 아니다 — 빈 슬롯/카드 전원 이상을 근거로 가른다**(v2.648, `cvp/parse.js judgeSlotPower`·
  `client.js slotEvidence`, 상세 `docs/CVP.md` §15): kind 는 psu 그대로(faultKey 불변 — 바꾸면 열린 장애가 영원히 보류), 표시만 '슬롯 전원(카드)'.
  그 슬롯의 링크 up 포트가 있으면 장애 → 주의, 다른 슬라이스는 있는데 그 번호만 없고 센서·트랜시버도 없으면 빈 슬롯(absent — removed 로 닫힘),
  근거가 모자라면 상태를 바꾸지 않는다. ⚠ ecb 의 뜻·'slice 번호 = 라인카드 슬롯' 은 실장비 미확인 추정이다.

  · v2.769(점검 R4-D5-2): 비-admin 응답의 BGP 라벨은 피어를 통째 '(주소 가림)' 으로 바꾸고 VRF 만 남긴다(`maskBgpLabel` — IPv6 정규식으로 피어를 찾지 않는다). `maskErrText` 는 IPv6('::' 축약·콜론 7개)도 상한 있는 선형 정규식으로 가린다 — 세 응답(overview·device·faults) 전부.
- **호스트 업링크 매칭(v2.920 — 설계 `docs/design/san-cvp-traffic/README.md` §4.2, A 단계)** — 판정은 `cvp/hostMatch.js`(순수 `matchUplinks`) 하나, 조회는
  `cvp/db.js portsByDesc`(설명 LIKE 로 넉넉히 뽑고 토큰 경계는 순수 모듈이 판정), 라우트 `routes/api/hostSan.js GET /hosts/:id/net-uplinks`, 화면
  `HostNetCvp.jsx`·`hostNetText.js`(네트워크 카드 NIC 표의 CVP 열 3개 + 업링크 블록). 회귀 `server/test/sanAttrib2920.test.js` ④ · 웹 `hostNetText.test.js`.
  - **근거 없는 매칭을 만들지 않는다**: 근거 우선순위 LLDP(확정) → MAC 테이블(높음) → **포트 설명 일치(보통 — 지금 가능한 유일한 근거)** → 미매칭. 포탈 CVP 수집은
    LLDP·MAC 테이블·discards 를 아직 읽지 않으므로(위 항목들) 매칭은 전부 '보통' 이고 화면이 그렇게 말한다. 설명의 호스트 이름은 **토큰 경계**로 본다(`esx01` ⊄ `esx010`),
    MAC 은 콜론·하이픈·점·붙임 표기 전부. `vmnic0` 글자만으로는 호스트를 특정하지 않는다(어느 호스트나 vmnic0 이 있다). 같은 MAC 이 포트 3개 이상이면 '충돌' 로 표시만.
  - 방향은 스위치 포트 기준 **In = 서버 송신 · Out = 서버 수신** — 응답 `direction` 과 화면 띠·열 이름이 말한다. 값 없음은 '—'(0 금지).
    ✅ v2.923 정정: '드롭은 수집 전' 이었던 이 줄 — 드롭은 v2.922(3a)가 수집하고 v2.923(B-①)이 화면에 싣는다(아래 항목).
  - 범위 계정은 그 호스트 법인의 CVP 서버 행만(`rowOwnerOf` + `datacenterId`), 범위 검사(404)가 도구 키 검사(403)보다 먼저다(존재 은닉).
- ⚠ **v2.922(리눅스 성능 3a) — 포트 드롭 열 · 베어메탈 서버 NIC ↔ 포트 매핑은 hostMatch 하나**(`cvp/{parse,db,poller,push,hostMatch}.js` · `central/cvpEdge.js` · 회귀 `server/test/bmPerf2921Cvp.test.js`):
  - `parseCounters` 후보에 `inDiscards/outDiscards`(필드 이름 **추정** — Arista 공식 경로 미확인) → `portDelta` 의 `inDrop/outDrop`(못 읽으면 null · 리셋 null). `port_latest/port_sample` 에 `in_drop/out_drop`,
    `port_daily` 에 `in_drop_sum/out_drop_sum/in_drop_n/out_drop_n` — **ALTER 로 더한다**(`addPortDropCols` · 멱등 · 기존 행 null). 엣지 push 표본 행은 12칸(뒤 두 칸 드롭) — 구버전 엣지의 10칸 행은 드롭 null.
    해시 키(push RATE_KEYS)·adopt 병합·portSeries·portsByDesc 에도 넣었다. ⚠ 정정(반증 D3): 31140f2a 는 **중앙 정제(sanitizeCvpBody)가 표본 행을 10칸으로 잘라**
    드롭이 중앙에서 사라졌고(이 문장이 ‘정제에도 넣었다’ 고 잘못 적었다), 표본 적재(rateFromSample)가 장비 레코드의 드롭을 null 로 덮었다 — 지금은 12칸 행만 12칸으로 두고(구 엣지 10칸은
    10칸), 10칸 표본은 port_latest 드롭을 덮지 않는다(rateFromSampleNoDrop). 회귀는 **실제 수신 라우트**(POST /api/central/cvp-data)로 `bmPerf2921CvpRecv.test.js`.
  - 베어메탈 성능 화면의 포트 후보는 **v2.920 `hostMatch.matchUplinks` 를 재사용**한다(판정 두 벌 금지). 넓힌 것: `host.aliases`(서비스 태그) · 리눅스 NIC 이름(eno1·bond0 — 이름 단서와 함께일 때만 NIC 지목).
    ⚠ 고친 결함: `descHasName` 이 구분자 있는 이름(`bm-kr1-db01` · `esx-01`)을 설명 토큰 하나와 비교해 **영원히 매칭하지 못했다** → 이름도 나눠 연속 토큰열로 비교(경계 규칙 유지).
    ⚠ 반증 D7 보강(v2.922): 토큰열만 보면 ‘esx-01’ 이 ‘esx-01-b’·‘kr-esx-01’ 에 맞는 새 거짓 양성이 생겼다 → **하이픈·밑줄로 붙은 앞·뒤 토큰이 있으면 다른 호스트**로 본다
    (뒤는 NIC·역할 접미사 `JOIN_OK_RE` — vmnicN·ethN·enoN·mgmt·uplink 등 — 만 허용, 앞은 연결어 `JOIN_PREFIX_OK_RE` — to·link·srv 등 — 만 허용 · 앞 연장은 후보로도 남기지 않는다) ·
    여러 토큰 이름은 영숫자 3자 이상. 반증 36표본: 거짓 음성 0 · 거짓 양성 1(2자 이름 ‘10’ — hostMatchTerms 가 단서로 쓰지 않아 업링크 매칭에는 닿지 않음).
    **v2.920 대비 행동 변화**(릴리스 노트): 구분자 있는 호스트 이름이 이제 매칭된다 · ‘esx01-b’·‘kr-esx01’ 처럼 붙어 이어진 다른 이름은 더 이상 매칭되지 않는다(예전엔 토큰 ‘esx01’ 이 있어 맞았다).
  - PROFILES §10 매핑 출처: ① 수동 매핑 — v2.922 신규(`bmusage/portMap.js`) ② 포트 설명 매칭 — v2.920 hostMatch(가상화 호스트) 를 베어메탈로 확장 ③ LLDP · ④ MAC — **미구현**(경로 미확인).
- **v2.923(SAN·CVP 설계 B-①) — 포트 드롭을 화면에 싣는다**(수집·저장·push·정제는 위 v2.922 3a 항목 그대로 — 같은 일을 두 벌로 만들지 않았다):
  CVP 도구 장비 상세 포트 표·포트 사용량 표 ‘드롭(수/송)’ 열(`portUsage` 행에 `inDrop/outDrop`) · 호스트 상세 네트워크 카드 CVP 업링크 블록 KPI ‘업링크 에러/드롭 · 최근 24시간’ +
  포트별 24시간 합. 24시간 합은 `db.portWindowSums`(원시 표본을 JS 로 더함 — 집계 함수 두 개를 한 문장에 쓰지 않는다)이고 **값이 있는 표본만** 더해 표본 수(`dropN/samples`)를
  같이 준다 — 드롭 수집 전·구버전 엣지 10칸 표본은 빠진다(부분 합을 전체 합처럼 말하지 않는다). 데모 합성 포트·백필 행에도 드롭. 회귀 `server/test/cvpDropUi2923.test.js` · 웹 `hostNetText.test.js`.
- **v2.924(SAN·CVP 설계 B-②) — LLDP 이웃 · MAC 테이블(FDB) → 호스트 업링크 매칭 ‘확정 · 높음’**(`cvp/{client,parse,db,poller,push,hostMatch}.js` · `central/cvpEdge.js cleanL2` ·
  `routes/central.js` · `routes/api/hostSan.js` · 웹 `hostNetText.l2Text` · 데모 `mock/demo/cvp.js demoL2` · 회귀 `server/test/cvpL2924.test.js`):
  - **경로·필드는 추정**(LLDP `/Sysdb/l2discovery/lldp/status/local/1/portStatus` · FDB `/Smash/bridging/status/smashFdbStatus` — docs/CVP.md 표). 부품 주기(30분)에만 읽고
    `CVP_L2=false` 로 끈다. 경로 탐색 표본에 두 경로를 더했다. LLDP 는 링크가 올라온 포트만 따라가고 개체 이름은 포인터 경로 전체(포트 › remoteSystem › 번호 — 첫 조각이 로컬 포트).
  - ⚠ **FDB 는 `entitiesOf` 로 읽지 않는다** — 항목 키가 `{fid, addr}` 복합 객체라 `updKey`(첫 스칼라 = VLAN)로 이름을 지으면 같은 VLAN 의 MAC 이 한 개체로 합쳐진다.
    update 마다 값 + 키 객체를 함께 펼친다. 포트당 MAC 이 `FDB_PORT_MAX`(512)를 넘는 포트(스위치 사이 트렁크)는 버리고 `portsOverCap` 으로 밝힌다. 장비당 `FDB_MAX` 4096 · LLDP 512.
  - 저장은 **장비마다 최신 한 벌**(`l2_fdb`·`l2_lldp`·`l2_meta` — 배열이면 교체 · 같은 내용 해시면 다시 쓰지 않음 · null(못 읽음)은 실패 시각만 · undefined 는 그대로).
    장비 정리(pruneDevices)가 L2 행도 지운다. 엣지 이름 변형 모으기(adopt)는 L2 를 옮기지 않고 변형 행을 지운다(두 시각의 목록이 섞이지 않게 — 다시 보낸다).
  - **엣지 push 는 바뀐 장비만**(메타 해시 · 전량 갱신 주기) 별도 배열 `l2` 로 보낸다. **중앙이 `saved.l2` 를 수로 답할 때만** 보낸 것으로 친다 — 구버전 중앙은 필드를 버리고
    그 칸이 없으므로 `L2_UNSUPPORTED_HOLD_MS`(6시간) 동안 L2 를 싣지 않는다(매 주기 큰 본문을 헛보내지 않게). 새 중앙은 L2 가 없어도 `saved.l2 = 0` 을 준다.
  - 매칭 근거 순위 **LLDP(확정) > MAC(높음 — 물리 NIC MAC 학습) > VM MAC(높음 — 그 포트 학습의 절반 이상이 이 호스트 VM vNIC, 2개 이상 또는 학습 1개뿐) > 포트 설명(보통)**.
    포트 학습 수를 모르면 VM MAC 비율을 판정하지 않는다(트렁크일 수 있다). 한 포트가 여러 근거면 가장 강한 하나 + also. 판정 코어는 `hostMatch.matchL2 · mergeUplinks` 하나 —
    베어메탈 성능 화면(PROFILES §10 ‘③ LLDP · ④ MAC — 미구현’)도 같은 함수를 쓰면 된다(두 벌 금지). ⚠ ESXi 는 표준 vSwitch 에서 LLDP 를 보내지 않는다(분산 스위치에서 켜야 한다).
  - ⚠ **반증 1인(v2.924) 확정분 — 되돌리지 말 것**(재현 스크립트로 확인 · 회귀 `cvpL2924.test.js`):
    · H-1 MAC 근거는 그 포트 학습의 **절반 이상이 이 호스트 것**(NIC MAC + VM MAC)일 때만 · 그 포트의 **LLDP 이웃이 다른 장비면 버림** · Vxlan·Vlan·Loopback·Management 는 보지 않음 —
      vmk0(=vmnic0 MAC)을 MLAG peer 가 peer-link 에서 배워 스위치 사이 포트가 '높음' 업링크로 잡히고 호스트 송수신 합에 들어갔다(작은 법인은 포트당 512 상한 아래).
    · M-1 매칭은 **그 호스트 법인의 CVP + 법인 미지정 CVP** 만(전체 범위 계정도) · LLDP 이름은 양쪽 다 도메인이 있으면 전체 이름 일치 — 다른 법인의 같은 짧은 이름이 '확정' 으로 붙었다.
    · M-2 LLDP 추종 요청 상한 3배(`FOLLOW_REQ_MAX_BY_KIND`) · 잘리면 **부분 읽기**(`lldpPartial` — 읽은 포트만 바꾼다).
    · M-3 종류마다 읽은 시각(`fdbAt`·`lldpAt` — push·중앙 저장 모두) · 업링크마다 근거 나이(`l2At`) · 3시간 넘으면 ‘오래됨’ · 수집 현황에 마지막 읽기 실패 수.
    · L-1 push 가 장비마다 양보 · L-2/L-6 큰 L2 삭제는 COMMIT 밖 조각(chunkedDelete) · 중앙은 장비 레코드로 보고한 장비의 L2 만(`requireDevice`) · 고아 L2 는 prune 이 지운다.
    · L-3 NIC MAC 과 VM MAC 을 따로 조회(상한 때문에 NIC 행이 빠졌다) · L-4 FDB 알림 시각 순 · 같은 키 마지막 값 · deletes(배열·맵) · L-7 `saved` 가 없는 답(noDelegation)은 구버전 중앙으로 보지 않는다 · 보류는 `_last.l2HeldUntil`.
    · L-9 이웃 섀시 MAC 이 NIC MAC 이면 LLDP 일치(IP 로 알린 이웃) · NIC 목록이 없어도 portId 가 vmnicN 이면 그 이름.
    · 남긴 것(정직): L-5 vMotion·유지보수 직후 30분 FDB 와 지금 VM 목록이 어긋나 VM MAC 근거가 옮겨 간 쪽 호스트에 잠깐 붙을 수 있다(근거 나이로만 드러난다) ·
      L-8 FDB 응답이 본문 상한(BODY_MAX_BYTES 8MB)을 넘으면 그 장비는 매 주기 못 읽는다(사유가 남는다).
- **v2.925(SAN·CVP 설계 B-③) — ESXi vmnic 드롭·에러와 같은 1시간 스위치 드롭을 나란히 · ‘어느 쪽 드롭’ 판정**(`vcenter/nicPerf.js`(순수) · `soapClient.js fetchHostNicStats` ·
  `GET /hosts/:id/nic-stats`(`routes/api/vmMetrics.js`) · `cvp/db.js portWindowSums recentMs` · net-uplinks `hour` · 웹 `HostNicCounters.jsx`·`hostNicText.js` · 회귀 `server/test/esxiNic2925.test.js` · 웹 `hostNicText.test.js`):
  - ESXi 쪽은 **주기 수집이 아니다** — 호스트 상세 ‘네트워크’ 카드의 버튼으로만 vCenter QueryPerf 를 instance ‘*’ 로 한 번(로그인 1회 · `net.{droppedRx,droppedTx,errorsRx,errorsTx,packetsRx,packetsTx}.summation`
    · 실시간 20초 × 180 = 최근 1시간). 게이트는 형제 `/hosts/:id/metrics` 와 같다(inv.hosts · 범위 밖 404 · 인증 정지 vCenter 는 로그인하지 않음). 같은 호스트 동시 요청은 진행 중인 조회 하나를 함께 쓴다(캐시는 아니다).
  - 집계 계열(instance '')·이름이 이상한 인스턴스는 버리고 vmnic 은 64개 상한. vCenter 결측(-1)은 0 으로 세지 않는다 — 값이 있는 표본만 더하고 결측이 섞이면 `partial`(화면 ‘(일부)’).
    카탈로그에 없는 카운터는 `missingCounters` + 그 칸 null. ⚠ ‘실시간은 통계 레벨과 무관’ 은 VMware 문서 기준이고 실장비로 확인하지 못했다(계열이 비면 ‘—’ 와 안내).
  - 스위치 쪽은 net-uplinks 의 `hour`(같은 원시 표본에서 최근 1시간 — `portWindowSums({ recentMs })`, `day` 모양은 그대로). 판정은 **방향 짝**:
    서버 수신 = 스위치 Out 드롭 ↔ ESXi droppedRx · 서버 송신 = 스위치 In 드롭 ↔ ESXi droppedTx. 양쪽 값이 다 있을 때만 ‘ESXi 쪽 · 스위치 쪽 · 양쪽 · 드롭 없음’,
    결측이 섞인 0 · 매칭 포트 없음/둘 이상은 ‘판정 보류’(한쪽에만 드롭이 보이면 그쪽 드롭만 말한다). 판정 코어는 웹 `hostNicText.sideVerdict` 하나.
  - 데모는 `synthNicStats`(인벤토리 NIC 이 없으면 가상 스위치 업링크 이름) — 몇몇 호스트의 한 NIC 에만 수신 드롭.

- **CVP EndpointLocation(v2.935 — 설계 `docs/design/san-cvp-traffic/README.md` §10, 회귀 `test/cvpEndpoint2935.test.js` · `cvpEpReview2935.test.js`)**
  - 경로 · 필드는 공개 proto 기준 **추정**(`GET /api/resources/endpointlocation/v1/EndpointLocation?key.searchTerm=<MAC>` · 2021.1+ · 단건). 파서는 관용 — JSON 이 아니면 parsed:false(위치 없음과 구분).
  - 404 는 본문으로 가른다(`endpoint.js notFoundKind`): 구체적 not found = 위치 없음, ‘Not Found’ 한 마디는 **답한 MAC 없이 8번 이어질 때만** 미지원(pNIC MAC 몇 개가 안 배워졌다고 CVP 전체를
    미지원으로 적지 않는다). 연결 실패 · 401 · 403 이 3번 이어지면 그만 묻는다. 인증 정지 CVP 는 버튼으로도 로그인하지 않는다(`cvpAuthGuard`).
  - 대상 고르기(`pickEndpointMacs`)는 셋 다 **오래전에 물은 것부터** · 호스트 몫 절반 — 스냅샷 순서로 고르면 같은 앞부분만 계속 묻는다(반증 M-1 재현).
    **엣지에서는 법인 필터를 건너뛴다** — 법인 할당표(datacenters.json)는 중앙에만 있다(반증 H-1 — 엣지에서 묻는 MAC 이 0개였다).
  - 업링크 근거(`hostMatch.matchEndpoint`): MAC 마다 가장 높은 likelihood 위치만 · 물리 아닌 인터페이스 · LLDP 이웃이 다른 장비인 포트 제외(B-② H-1 과 같은 방어).
    VM 위치 판정은 net-uplinks 와 같은 호스트 업링크(LLDP 이름 규칙 + 위 규칙)로 하고, 위치 모르는 업링크 NIC 이 있거나 LAG 면 **판정 보류**(거짓 불일치 금지).
  - 엣지 push 커서는 `ep_meta.seq`(쓸 때마다 늘어나는 순번) — 물어본 시각(at)으로 자르면 같은 at 경계 · 늦게 커밋된 작은 at 을 건너뛴다. 엣지 이름은 대소문자를 가리지 않는다(큐 · DB owners).
  - 라우트: 범위 밖 404 → 도구 키 cvp 403 → 역할(admin · operator — `toolActorOf`, 인증 꺼짐도 익명 역할) → **쓰기 범위 밖 403**. 범위 계정 + 법인 미지정 vCenter = CVP 0대.
    비-admin 의 오류 사유는 `maskErrText` 로 가린다. DB 를 못 읽으면 ‘아직 안 물음’ 이 아니라 ‘읽지 못함’. 주기 숫자 · 켜짐은 API 값(partsEveryMs · scan).
  - v2.940(회귀 `test/sanCvpRest2940.test.js` ①②): 반증 L-10 — 엣지 시각이 수신 시각으로 잘리면 원본을 `ep_meta.edge_at` 에 따로 두고 VM 위치 카드가 '엣지 시계 +n분' 을 보인다.
    주기 요약(`endpoints`)은 엣지 상태 정제(`cleanStatus`)가 아는 필드만 받아 넘기고(예전에는 버렸다) CVP 도구 서버 표 '위치 조회(주기)' 열이 보여 준다(못 읽은 수는 '—').
  - v2.966(회귀 `test/cvpEpStartup2966.test.js` · 변이 3/3): 위치 조회 시각(`poller._epAt`)은 **부품 주기(`_partsAt`)와 따로** 센다. 예전에는 부품 주기에 묶여 기동 직후 첫 주기
    (vCenter 첫 수집 전 — 인벤토리가 빔)에 묻는 MAC 이 0개인데도 그 주기를 '했다' 로 쳐서 다음 부품 주기(기본 30분)까지 위치 칸이 비었다. 이제 인벤토리가 비면(`inventoryReady`)
    묻지도 소모하지도 않고, 부품 단계가 예산을 다 써 건너뛴 주기(`stopped:'budget'`)도 소모하지 않는다(다음 폴링은 부품 주기가 아니라 예산이 남는다 — 이 분기는 데모로 재현이 안 돼 테스트 밖).
    인증 · 연결 멈춤은 소모한다(매 폴링 재시도로 두드리지 않게).

- **전체 점검 25회차(`cvpIpamFullAudit25`)**: 설정 파일을 못 읽으면 ~~보존 정리 보류~~ → **27회차 정정: 설정 상한(원시 90일 · 일 롤업 3650일)으로만 정리**(`poller.prunePerSettings` — 기본 원시 7일 · 일 롤업 730일로 지우던 것 · 전면 보류는 디스크가 끝없이 찼다) ·
  확정은 두 보존을 최대값으로 · GET `loadError` · PUT 409(화면은 `requireChanged` — 27회차 D-2) · 27회차 D-6: 수정의 중복 검사는 **주소 · 담당을 바꿀 때만** · 메시지에 상대 서버 이름 ·
  등록부 저장 · 삭제 · pull 반영은 쓰기 성공 뒤에 메모리 교체 · 수정에도 주소 + 담당 중복 검사 · 엣지 상태 authStopped 시각은 수신 시각으로(tsClamp).

- **CVP 포트 구성도(v3.37 — 설계 `docs/design/cvp-port-map/README.md`, 회귀 `server/test/cvpPortMap337.test.js` · 웹 `cvpPortMapText.test.js`)**
  - 판정 코어는 **서버 `cvp/portmap.js` 하나**(배치표 · 분류 · 연결 근거). 웹 `cvpPortMapText.js` 는 색 · 칸 묶기 · 문장만 — 분류를 웹에서 다시 하지 않는다.
    트랜시버 → 포트 매핑(`xcvrMapOf` · `intfOfPartName`)만 웹 `cvpIntfText.js` 와 두 벌이고, 테스트 ④ 가 같은 입력으로 대조한다.
  - **배치표(`FACEPLATES`)는 사진으로 확인한 모델만** 넣는다(공개 NetBox devicetype-library 의 Arista 전면 · 후면 사진 판독). 확인 못 한 모델을 짐작으로 넣지 말 것 —
    없는 모델은 번호 규칙(`source:'rule'`)으로 그리고 화면이 '번호 규칙(실물 배치 아님)' 이라고 말한다. 7504N 은 섀시만 확인 — 카드 안은 번호 규칙(`cardRule`)이고 슬롯 번호 매김도 추정.
  - 분류: admin down → 꺼짐 · oper up → 사용 · oper 모름 → 확인 불가 · 링크 없음 + **설명 null(못 읽음) → 확인 불가(예비로 세지 않는다)** · 설명 있음 → 확인 필요 ·
    설명 '' → 예비(배치표의 RJ45 칸 = 구리 · 트랜시버 꽂힘/빈 케이지 · 트랜시버 목록 못 읽음이나 목록에 없음 = 'GBIC 모름'). 관리 포트는 그리되 개수에서 뺀다.
  - 연결 근거는 **링크가 올라온 포트만**: 설명 낱말 ↔ LLDP sysName(도메인 뗀 이름 포함) 일치 · 불일치(지금 붙은 상대 = LLDP 를 표시) · LLDP 만 · 설명만 · 근거 없음.
    장비의 LLDP 를 읽은 적이 없으면(`l2_meta.lldp_at` null) 일치/불일치를 판정하지 않고 `lldpUnread` 로 '설명만(LLDP 못 읽음)' 이라고 말한다 — 이웃 없음으로 단정하지 말 것.
    설명에서 이름 뽑기 · 낱말 나누기는 200자로 먼저 자르고 문자 하나 구분자로 나눈다(선형 — 테스트 ⑤).
  - 라우트 `GET /tools/cvp/portmap`(장비 1대) · `/tools/cvp/portmap/summary`(전 스위치 · LLDP 없이 분류만)는 형제 CVP 라우트와 같은 게이트(tools + `fullScopeOnly` — 범위 계정 403).
    비-admin 은 설명 · LLDP 문자열을 `maskErrText` 로 가리고 LLDP chassisId(MAC)는 누구에게도 싣지 않는다. 장비 · 엣지 왕복 0 — 엣지 수신 계약은 바꾸지 않았다.
  - 화면: 전역 `tbody td { white-space: nowrap }` 때문에 긴 칸이 표를 넓힌다 — 설명 · LLDP · 장비 칸은 `whiteSpace:'normal'` + `minWidth` 를 함께 준다(Chromium 판독에서 찾은 넘침).

- **CVP 네트워크 기능 2차(v3.38 — 설계 `docs/design/cvp-network-features/README.md` §9, 회귀 `server/test/cvpNet338.test.js` · 웹 `cvpNetText.test.js`)**
  - 판정 코어는 서버 순수 모듈 하나씩: `cvp/linkq.js`(④ ⑩) · `cvp/portplan.js`(⑤ ⑨) · `cvp/opticstrend.js`(⑮) · `cvp/topology.js`(⑥ ⑦ — `switchIndex` · `uplinkPortsOf` 는 위치 찾기 · 예측도 같이 쓴다) ·
    `cvp/locate.js`(①) · `cvp/snapdiff.js`(⑬) · 직선 추세는 `cvp/trend.js` 하나. 웹 `cvpNetText.js` 는 문장 · 색 · 배치만 — 판정을 웹에서 다시 하지 않는다.
  - 라우트는 `routes/api/cvpNet.js`(형제 cvp.js 와 같은 게이트 — tools + `fullScopeOnly`, 범위 계정 403). 스냅샷 찍기 · 지우기는 `requireRole('admin','operator')` + 감사 로그.
    비-admin 은 설명 · LLDP 문자열을 `maskErrText`, 비교의 BGP 피어 주소는 '(주소 가림)'(maskPeers 와 같은 등급). 장비 · 엣지 왕복 0 — v3.38 에서는 **엣지 수신 계약을 바꾸지 않았다**(중앙이 받던 장비 레코드 · 표본으로 계산 — ⚠ v3.41 는 info 에 mlagStatus · cfgReadAt 를 더했다: 아래 v3.41 항목).
  - 일 기록 표(`cvp.db`): `port_lastlink`(포트별 마지막 링크 날 — **최신 전용 표**, port_daily GROUP BY MAX 로 만들지 않는다) · `dev_linkhist`(장비 기록 시작 날) · `port_flap_daily` ·
    `dev_port_daily` · `xcvr_daily`. 쓰기는 기존 적재 경로 안(`insertSample` · `saveDevices` 트랜잭션)에서 upsert(스칼라 MIN/MAX). **옛 레코드(ts ≤ 저장된 ts)는 플랩 · 포트 수 · 광량을 쓰지 않는다**(순서 뒤바뀜을 플랩으로 세지 않게 — 테스트 ⑦).
    플랩 = 직전 oper 'up' → 지금 down/nolink + 관리상 켜짐. 광량 일 최저는 `optic.linked === true` 만 · -60 ~ +15 dBm 밖은 못 읽은 값. 일 기록 3종은 일 롤업과 같은 보존일로 정리, 최신 표 2종은 `pruneDevices` 가 장비와 함께 지운다.
  - v3.38 이전 기록의 마지막 링크 날은 `backfillLastLink`(장비마다 트랜잭션 + 양보 · `cvp_kv` 표지로 한 번)가 옮긴다 — 회수 조회가 기다리지 않고 시작만 하고 `backfilling` 을 밝힌다.
  - 요청 경로 조회는 **날 하나씩**(`day` 단독 인덱스) + `createYielder` — 오류 합 · 플랩 · 포트 수 · 광량. 업링크 사용률은 포트마다 PK 범위 + 양보(상한 2,000 포트).
  - '못 읽은 값' 규칙: 오류 카운터를 기간 안에 한 번도 못 읽은 포트는 '판정 못 함'(0 이 아니다) · 기록 시작 뒤 한 번도 링크가 없던 포트는 일수로 세지 않는다(never) ·
    장비 기록이 없으면 회수 후보 아님 · 예측은 기록 90일(GBIC 14일) 미만이면 '기록 부족', 목표 쪽으로 늘지 않으면 '예측 없음' · 양끝 비교에서 한쪽 null 은 '비교 못 함' · 스냅샷의 못 읽은 묶음은 null(빈 배열과 다르다).
  - 토폴로지 이름 맞추기: 전체 이름(소문자) 우선, 짧은 이름(첫 점 앞)은 **하나뿐일 때만**(다른 법인 동명 장비를 잇지 않는다). 층은 자동 추정(서버 이웃 있음 = leaf · 스위치 이웃 2+ = spine).
  - 위치 찾기: IP → MAC 은 vCenter 인벤토리로만(스위치 ARP 표는 수집하지 않는다 — 화면이 밝힌다). 답 = 이웃이 CVP 스위치가 아닌 포트, LLDP 로 못 가르는 포트(채널)는 배운 MAC 64개 이상이면 업링크로 본다(basis 'macs' — 추정).
  - 스냅샷: 장비마다 gzip JSON 한 행 · 50대씩 트랜잭션 · 반쪽 스냅샷은 지운다 · 최근 30개 · 180일(`SNAP_MAX` · `SNAP_RETENTION_DAYS`) · 동시 1건(409). 한쪽이 한 CVP 만 찍었으면 비교도 그 CVP 만(나머지를 사라짐 · 새로 생김으로 지어내지 않는다).
  - 데모: `mock/demo/cvp.js demoFabricLinks`(leaf ↔ spine 양쪽 LLDP · 일곱 번째 leaf 설명 불일치 · 아홉 번째 MTU 불일치) · `demoNetHistory`(`db.importNetHistory` — 지금은 데모 시드만 쓴다). 이름 · 수치는 가상.
  - 남긴 것(다음 차수): ② 설정 백업 — 새 수집(엣지 계약 변경)이라 v3.38 · v3.41 모두 하지 않았다. ~~③ 버전 준수 · ⑧ MLAG/채널 이중화~~ → **v3.41 에 구현**(아래 항목). ⑪ 트래픽 흐름 · ⑭ 경로 추적은 예약 작업(아직 등록하지 않음).
- **빈 칸 점검 · ③ 버전 준수 · ⑧ 이중화(v3.41 — 사용자 실장비 캡처: DCS-7280SR-48C6 · EOS 4.27.4M 포트 표의 속도 · VLAN · LAG · 수신 · 송신 · 오류가 전부 '—', 회귀 `server/test/cvpRedundancy339.test.js` · 웹 `cvpNetText.test.js`)**
  - **VLAN · 채널 소속은 인터페이스 상태 노드(intfStatus)에 없다**(추정 — parseInterfaces 의 pick(vlan · lag)은 실장비에서 늘 비었던 것으로 본다. 데모만 값을 채웠다). 부품 주기에 따로 읽는다:
    `switchport`(…/bridging/switchIntfConfig/switchIntfConfig) · `lagMember`(…/lag/input/config/cli/phyIntf 외) · `mlag`(…/Sysdb/mlag/status) — **경로 · 필드 이름 모두 실장비 미확인 추정**, 경로 탐색 표본(PROBE_PATHS)에 5곳을 더했다.
  - 새 장비별 종류는 **`kinds`(종류별 상태 표 ks)에 반드시 등록**한다 — 빠지면 readKind 가 던져 그 장비의 카운터 · BGP · 부품 · LLDP 까지 부품 주기마다 잃는다(v3.41 개발 중 통합 테스트 ② 가 잡은 결함 · 변이로 고정).
  - 채널 소속이 포인터(`lag: {ptr:[…,'Port-Channel10']}`)로 오면 entitiesOf 가 필드로 세지 않는다 — `rawLagScan` 이 알림을 한 번 더 훑는다. **컬렉션의 포트별 포인터는 소속 값이 아니다**(세면 빈 맵으로 '읽음' 이 되어 포인터를 따라가지 않는다 — 변이로 고정).
  - 부품 주기 사이에는 수집기 메모리의 직전 값(`_l2cfg` — 키 = CVP id + 장비 시리얼)을 `L2CFG_TTL_MS`(부품 주기 3배) 안에서만 쓴다. 재시작 뒤 첫 부품 주기 전은 비어 있다(모름).
    '채널 없음' 과 '소속 못 읽음' 은 둘 다 lag '' 라 **info.cfgReadAt(VLAN · 채널을 읽은 시각)** 로 가른다.
  - 엣지 → 중앙 info 에 `mlagStatus`(칸 여섯 + at) · `cfgReadAt` 를 더했다 — `db.INFO_KEYS` 와 `central/cvpEdge.cleanInfo` 를 **같이** 고친다(아는 칸만 · 문자열 64자 · 시각은 수신 시각으로 자름 — 변이로 고정).
  - 속도: 'speed' · 'bandwidth' · 'speedEnum' 에 값이 없으면 이름에 speed · linkmode 가 든 필드에서 **단위가 붙은 값만**(자동 협상 · 광고 · 지원 칸 제외). 단위 없는 수는 추정하지 않는다.
  - 장비 상세 › 포트의 **'모든 포트가 비어 있는 칸 — 이유'** 는 웹 `cvpNetText.emptyColumnNotes` 하나(근거 = 그 CVP 의 usedPaths · missing · seenFields — 장비별이 아니다). 단정하지 않는다.
  - ③ 버전 준수(`cvp/compliance.js` · `GET /tools/cvp/compliance`): **새 수집 없음** — v2.641 CVP 단위 항목(인벤토리 준수 코드 · bugexposure · lifecycle)을 그대로. 포탈은 판정하지 않고 상태만 나눈다 —
    '0000' 만 준수로 읽고 다른 코드는 그대로 보인다(뜻을 지어내지 않는다) · 읽었는데 값이 없으면 '공지 없음' · 못 읽었으면 '못 읽음' · 종료일은 소프트웨어 · 하드웨어 중 이른 날, 180일 안 = 곧.
  - **수명주기 날짜는 epoch ms 숫자다**(parse.tsOf · cleanInfo) — 읽기는 `compliance.lifeMs` 하나. Overview 의 '지원 종료 지남' 은 v3.38 까지 `Date.parse(숫자)` = NaN 으로 **한 번도 세지 못했다**(v3.41 수정 · 테스트 ④).
  - ⑧ 이중화(`cvp/redundancy.js` · `GET /tools/cvp/redundancy`): 채널 = 관리상 켜진 멤버 중 링크 올라온 수(전부 ok · 일부 degraded · 0 down · 모르는 멤버 섞임 unknown · 전부 꺼짐 off).
    MLAG = active + connected + 피어 링크 up 이면 ok · disabled = 안 씀 · 상태 못 읽음 = unread(인벤토리 'MLAG 켜짐' 은 함께만). **장애로 열지 않는다**(화면만 — 시안 §6-5 기본값).
  - 반증 1인(v3.41) 반영: 포인터 추종이 잘리면 **부분 맵**(직전 완전한 맵 유지 · 없으면 맵에 없는 포트를 비우지 않고 cfgReadAt.lagPartial) · MLAG ok 는 협상 · 피어 링크를 **둘 다 읽고** 정상일 때만 ·
    내려간 멤버가 확인되면 모르는 멤버가 섞여도 이중화 상실 · 기억 시간 = 부품 주기 × 3 · MLAG 는 포트 목록 없이도 · 엣지 정제 `SAMPLE_KINDS_MAX` 32 · `cleanProbes` 는 `PROBE_MAX`(예전 28 고정이 새 경로 표본을 버렸다) ·
    빈 mlagStatus 는 싣지 않음 · 채널 표에 포트 개체가 있으면 소속 칸 없는 포트 = 채널 없음(연속 실패 차단 방지) · 'flags' 가 lag 에 맞지 않게 칸 이름 전체 일치 · hwEndOfLife 는 지원 종료 판정에서 뺌(뜻 미확인) · 비관리자 MLAG 문자열 가림.
  - 남긴 것: ② 설정 백업(다음 차수 · 보관 결정 = 비밀 줄을 가린 판을 중앙에). 속도 · 처리량 빈 칸은 실장비 '읽은 경로' 원문 표본을 받아야 원인을 확정한다(이번 보강은 추정 후보). MLAG 는 운영 상태인데 부품 주기(30분)로 읽는다(반증 E3 — 화면이 읽은 시각을 보인다).
- **버그 점검(실제 릴리스 v3.46.0 — 코드 · 테스트 표지는 v3.42: main 이 v3.45 까지 먼저 나가 번호만 올렸다 · 사용자 요청 '버그 안 나올 때까지' · 5축(판정 · DB/수집/엣지 · 보안 · 성능 · 웹) × 반증 1인 × 4회차 · 회귀 `server/test/cvpBugRound342.test.js` · `cvpPushPartial342.test.js` · 웹 `cvpBugRound342.test.jsx`)**
  - **채널 소속 '' 는 DB 에서 NULL 이 된다**(`txt('')`) — 새 화면 라우트는 장비 `info.cfgReadAt.lag`(lagPartial 아님)가 있을 때만 NULL 을 '' 로 읽는다(VLAN 도 같은 규칙). '' 를 그대로 저장하면 안 된다 — 파서가 소속 필드가 없을 때도 '' 를 준다(못 읽음이 '소속 없음' 으로 둔갑).
  - **포트 목록을 못 읽은 장비(portsRead=false)의 옛 port_latest 행은 새 화면에 싣지 않는다**(`cdb.portRowsOf` — 장비별 PK 조회 + 양보 · 몇 대인지 `portsUnread`). 스트리밍이 끊긴 장비는 마지막 포트가 무기한 남는다.
  - **일부 목록(`portsPartial` — 포인터 추종 · 파서 · 엣지 상한에 잘림)은 옛 포트 행을 지우지 않고 포트 수(고갈 예측)도 적지 않는다**. 빠진 옛 행은 **저장할 때** oper 'unknown' · 처리량 NULL 로 적는다(`markPortsStale` — ts 는 마지막으로 본 때 그대로 · **rate_ts = 모름이 된 시각**) · 모름이 된 지 `PARTIAL_STALE_KEEP_MS`(7일)가 지나면 지운다(`delPortsStaleOld` — 보류에는 시한 · 시한 삭제가 표시보다 먼저: 반대면 오래 조용하던 장비의 행이 표시 직후 지워진다). 밀린 표본은 '모름' 행의 처리량을 다시 채우지 않는다(`rateFromSample` 가드). 읽는 쪽은 아무것도 보정하지 않는다 — 2회차의 '읽을 때 보정'(staleOperFix)은 읽기 경로 4곳이 빠지고 엣지 · 중앙 기록이 어긋나 3회차에 걷어냈다. 엣지 push 레코드에는 옛 행을 싣지 않고(`deviceRecordsFor` — 장비 ts 보다 오래된 포트 행) 표지(info.portsPartial · INFO_KEYS · 엣지 정제)만 보낸다 — 중앙이 같은 saveDevices 로 자기 옛 행을 스스로 표시한다. 전후 비교는 'unknown' 을 값으로 보지 않고(`snapdiff.linkWord`) 한쪽만 모르면 '비교 못 함(portState)'. 플랩: 빠지기 직전에 올라와 있던 포트는 기억해 두었다가(`_staleWasUp` — 프로세스 메모리) 다시 보였을 때 내려가 있으면 플랩으로 센다(재시작하면 그 사이 한 번을 못 셀 뿐이다). 본문에는 일부 목록 표지(`pp`)를 실어 양쪽 다 일부여도 '비교 못 함(portState)'. 4회차: 기억은 **그때 모름으로 적은 바로 그 행**에만 쓴다(기억 = 포트 키 → 모름으로 적은 시각 · 행의 rate_ts 와 같을 때만 참 — 행이 지워지는 경로를 일일이 따라가 기억을 지우지 않는다) · 장비가 **원래 '모름' 으로 보고하던 포트**는 목록에서 빠진 때 rate_ts 를 찍어 그때부터 시한을 센다(`stampNativeUnknown` — 시한 삭제보다 먼저) · 한쪽이 일부 목록이면 전후 비교가 포트 '사라짐' · '생김' 을 세지 않는다.
  - 추세 창은 **날짜**(최근 N일)로 자르고 마지막 기록이 오래되면 `stale`(값을 '지금' 으로 쓰지 않는다 · lastAt · GBIC 는 lastRx — 임계 이하면 위험 쪽). 예측 지평선은 응답 `horizonDays`(화면에 '1년' 을 박지 않는다).
  - 토폴로지: 이름 색인은 **같은 CVP 전체 → 같은 CVP 짧은 이름 → 전역 전체 → 전역 짧은** 순서 · 단계 안 여럿이면 스트리밍 중인 하나 · 못 고르면 `AMBIG`(링크도 '기타 이웃' 도 아니다 · 업링크로는 센다). IP 이름은 통째로(`shortOf`).
    관리 포트(`ma*`)는 **양쪽 끝 모두** 링크 · 업링크 · 층에서 뺀다. 층 = 스파인 후보는 전체 스위치 이웃 수, 리프 판정만 MLAG 피어를 뺀다(피어 = 직접 연결 + 나머지 이웃 공유 ≥ 큰 쪽의 절반 + **서로 유일한 최고 후보**(점수 = 공유 비율 먼저 · 같으면 공유 수 — 공유 수만 보면 스파인 MLAG 쌍이 있을 때 리프 ↔ 스파인이 진짜 피어와 동점) — 동점이면 쌍을 정하지 않는다: 장비 키 순서가 층을 바꾸면 안 된다). 4대 대칭 구성은 모양만으로 가를 수 없다(결정 필요 D-8 — MLAG 상태로 확정하는 것이 다음 작업). 화면의 이웃 수는 피어 포함.
    양끝 비교의 '설명이 가리키는 상대' 는 설명 어디에든 상대 이름이 있으면 같음(`portmap.descMentions` — 포트 구성도 연결 근거와 같은 판정) · 없으면 **다른 알려진 스위치**를 가리킬 때만 다름(MLAG-PEER-1 · ISL-1 류 · 자기 이름 제외). 이름 색인은 도메인까지 쓴 이름을 도메인이 다른 FQDN 장비의 짧은 이름으로 맞추지 않는다. 짧은 이름 함수는 `portmap.shortOf` 하나. 양쪽 설명 링크는 합치지 않는다(상대 포트 짝을 지어내게 된다 — 결정 필요 D-6). 4회차: 짧은 이름 후보는 **한쪽이 다른 쪽의 라벨 단위 접두**일 때만('leaf1.dc1' ↔ 'leaf1.dc1.corp.com' 은 같고 'spine1.kr.corp' ↔ 'spine1.us.corp' 는 다르다 — '장비 이름에 도메인이 없을 때만' 은 이름 자체에 점이 든 장비를 스위치 아님으로 만들었다) · 설명 링크의 상대는 **첫 장비 이름꼴 낱말**이고, 그 낱말이 자기 자신일 때만('leaf1:Et49 <-> spine1:Et1') 다음 낱말로 넘어간다(`portmap.deviceNamesFromDesc`) — 낱말 전부에서 스위치를 찾았더니(4회차 첫 수정) 서버 포트 설명에 **언급만 된** 스위치('esx01 vmnic2 (moved from leaf2 Et10)')로 거짓 선을 긋고 그 선이 층 추정까지 뒤집었다(수정 검토 F1 — 추정 선은 층 · 피어 추정에도 들어간다).
  - QSFP: 트랜시버 이름이 칸(Ethernet49)이고 포트가 레인(Ethernet49/1)이면 레인으로 링크를 본다 — 레인 행이 모두 올라왔거나 **첫 레인(/1)만 올라왔고 속도가 40G 이상 · 모름**(단일 포트 모드 — /2~/4 는 비활성 레인)이면 링크 있음 · 그 밖에 일부만이면 `lanesPartial`(Rx 판정 안 함 — 링크 없음도 아니고 재고는 링크 있음 · 장애 닫힘 NO_LINK 아님). 새 optic 필드는 엣지 정제 화이트리스트에도.
  - 무거운 CVP 조회 8개(링크 품질 · 회수 · 예측 · GBIC 추세 · 토폴로지 · 이중화 · 전후 비교 · 전 스위치 여유)는 `cvp/heavyGate.js heavyJson` — **같은 키(라우트 · 관리자 판본 여부 · 값)는 계산 하나를 함께 기다린다** · 줄(lane)마다 동시 2건(무거운 줄 · 가벼운 줄 = 위치 찾기) · 줄 16 · **동시에 기다리는 수로는 거절하지 않는다**(3회차의 '계정당 3' 은 줄이 비어도 4번째를 거절해 공용 계정 · 인증 꺼짐에서 정상 사용이 막혔고, 4회차에 걷어냈다) — 대신 계정마다 **새 계산을 시작하는 횟수**(`START_BURST` 건을 모아 쓰고 `START_REFILL_MS` 마다 1건 회복 · 합류는 세지 않는다 · 계정 이름이 없으면 4배 — 한 계정이 '보내고 바로 끊기' 를 되풀이하면 끊긴 계산의 첫 구간만으로 자리가 내내 찼다) · 차례는 **계정 간 공평하게**(돌고 있는 계산이 적은 계정 것부터 · 한 계정은 줄의 절반까지 — 계정 이름이 없으면 따지지 않는다) · **계산을 시작하지 못하고** 빠진 요청(줄에서 취소 · 시작 직전 떠남)은 시작 횟수를 돌려받는다(자리가 찬 동안 탭을 넘기면 돈 계산이 0건인데 429 가 났다) · 시각이 뒤로 가면 회복 기준을 지금으로 당긴다 · 계산은 **다음 매크로태스크에서** 시작하고 시작 직전에 떠났는지 본다(양보 없이 끝나는 짧은 계산 12건이 마이크로태스크로 한 덩어리가 됐다) · 긴 키 값은 자르지 않고 해시(앞 200자가 같은 다른 요청이 같은 본문을 받았다) · 기다리는 요청이 없으면 줄에서는 바로 빼고 돌던 계산은 **확인 지점(`hx.check()` · DB 조회의 `stop`)에서 멈춘다**(멈추기로 한 순간 합류 표에서 지운다 — 떠난 요청은 조용히 끝낸다) · 자리는 계산 finally 에서 · 줄이 차면 **429 + Retry-After**(503 은 웹이 '업그레이드 중' 으로 바꾸고 자동으로 두 번 더 보낸다) · 형식 검증(400 · 404)은 그 앞에. 계산 함수는 응답 객체에 손대지 않고 `{ status?, body }` 를 돌려준다(여러 요청이 같은 결과를 받는다 — 요청별 값을 계산 안에서 쓰지 말 것 · 키에 넣을 것). 위치 찾기는 가벼운 줄(lane 'light')로 — 줄 밖이면 동시 12건이 정지 0.7초를 쌓는다 · **답에 나온 장비의 LLDP · 채널만** 읽는다(전 장비 LLDP 를 검색마다 읽지 않는다). 답 장비가 `LOCATE_DEVS_MAX` 를 넘으면 **상한 안 장비의 행만** 판정해 싣고(LLDP · 채널 · MAC 수를 같은 집합으로 — `fdbPortTotals(…, { max })`) 뺀 대수를 `devicesOmitted` 로 밝힌다(상한 밖 장비의 업링크가 근거 없는 '가장자리' 로 나왔다). 웹은 `cvpHeavy.js fetchHeavy`(자동 재시도 없음 · 긴 시한 — 위치 찾기는 `fetchJson(…, { retries: 0 })`)로 부르고 effect 정리에서 취소한다(버린 요청이 줄을 차지하지 않게). 2회차 판(전역 한 줄 · 미들웨어 · 503)은 가벼운 조회가 기다리고(0.4 → 4.5초) 같은 조회가 합류하지 않아 3회차에 다시 만들었다. 요청 경로 큰 조회: LLDP 는 장비 단위 `.all` + 양보(커서를 연 채 양보하면 saveL2 교체 때 옛 행 + 새 행이 섞인다) · 일 표는 **rowid 쪽 단위**(`eachDay` — 커서를 연 채 양보하면 WAL 체크포인트가 밀려 첫 COMMIT 이 91~181ms 멈춘다 · 날 하나를 한 번에 읽으면 조각이 86~184ms).
  - 비관리자 MLAG 문자열 가림은 장비 목록 · 상세(`publicInfo`) · 이중화 모두. `maskErrText` IPv4 끝 조건은 `(?!\d|\.\d)`(문장 끝 마침표).
  - 스냅샷: 삭제는 머리 행을 먼저 done=2 로 · 저장은 `done=0` 일 때만 완료(경쟁 → `SNAP_GONE` 409) · 읽은 뒤 머리 재확인 · 깨진 행은 '비교 못 함'(범위로 거른다) · 범위가 다른 스냅샷끼리 비교 400 · 범위 입력이 글자가 아니면 400.
  - 엣지 push: 여러 청크 가운데 **뒤 청크만 실패**하면 앞 청크의 레코드는 중앙에 이미 들어갔다 — 그 push 에 실었던 장비의 '보낸 해시'(레코드 `_sent` · L2 `_l2Sent` 둘 다 — 이벤트 · 표본 · EndpointLocation 은 커서라 틈이 없다)를 지워 다음 주기에 해시와 상관없이 다시 보낸다(안 그러면 상태가 예전에 보낸 것과 같아졌을 때 touch 만 가서 중앙이 전량 갱신 주기까지 실패한 push 의 상태로 남는다 · 회귀는 실제 `pushCvpNow`).
  - 엣지 이름 변형 모으기는 v3.38 표를 **합친다**(기록 시작 날 MIN · 플랩 합 · 사용 최대 MAX · GBIC 최저 MIN) — 버리면 기록 시작 날이 '오늘' 이 된다. 링크 날 기억은 ROLLBACK · 장비 정리 · 모으기 뒤 비운다.
  - 결정 필요로 남긴 것(사용자): D-1 LLDP portId(MAC) 가림 · D-3 xcvr_daily 보존 · D-5 회수 'never' 기준(포트 첫 관측일) · D-6 양쪽 설명 링크 합치기 · D-7/N1 GBIC 추세 · 링크 품질 임계(장비 임계 vs 포탈 임계) · D-8 층 추정(MLAG 상태로 피어 확정) · D-9 채널 · MLAG 읽는 순서(지금은 부품 뒤 · LLDP 앞).
    알려진 한계: QSFP 단일 포트 판정은 속도 기준(실장비 미확인) · 플랩 기억은 프로세스 메모리 · 층 추정은 모양만으로 못 가르는 구성이 남는다(D-8 — MLAG 상태로 확정이 다음 작업) · 4회차에도 0건이 아니었다(확정 43 → 36 → 27 → 10 · 상 0 · 중 1) · 4회차 수정 검토도 6건(중 1 · 하 5)을 찾았다 — **수정 검토는 매 회차 결함을 찾았다(13 · 14 · 6)**: 이 영역의 위험한 수정(동시 상한 · 보존 삭제 · 엣지 push · 층 추정에 들어가는 링크)은 반증 1인을 거친 뒤에 내보낸다 · 위치 찾기 답 장비가 상한을 넘으면 잘리는 순서가 정해져 있지 않다(스위치 1,000대 초과 — 운영 규모 밖).
    보수적으로 정해 둔 것: D-2 위치 찾기 — LLDP 이웃이 ESXi(이름 일치)인 포트(+ 그 포트 채널)는 MAC 64개 이상이어도 가장자리 · D-4 버그 기록 없음 = 회색 '기록 없음'(초록 '노출 없음' 아님).
