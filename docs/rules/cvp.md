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

