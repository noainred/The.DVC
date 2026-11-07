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
