# 규칙 — iDRAC·베어메탈 사용률·파트 장애·서버 온도·전력·Overview 서버 수량

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/{idrac,bmusage,partfault,corpusage,power}/ · Overview

## 목차

- (원래 188행) 물리 파트(부품) 장애 — v2.548 재설계. '확인 불가' 를 정상으로도 장애로도 세지 않고, 전이만 기록한다
- (원래 302행) 베어메탈 사용률 — 대상은 `classifyFleet().bareMetal` 하나이고, 한 경로로는 다섯 지표를 다
- (원래 390행) iDRAC 텔레메트리는 `SystemUsage` 하나가 아니다 — 리포트 목록을 열거해 있는 것만 읽는다
- (원래 422행) 사용률 추이 차트의 y축은 0~100 고정이다
- (원래 437행) 사용률 임계 알림은 '지속 + 억제 + 히스테리시스 + 영속' 네 개가 같이 있어야 한다
- (원래 498행) 표본 시각은 '주기 시작 시각' 이 아니라 '그 서버가 실제로 읽힌 시각' 이다
- (원래 506행) 두 번 시도하는 수집 경로는 세션 예산을 스스로 봐야 한다
- (원래 513행) `status`·`last` 같은 '상태 객체' 에 집계를 담아 내보내지 말 것
- (원래 517행) '전체 조회' 분기에서 파티션 키를 빠뜨리지 말 것
- (원래 520행) 식별 키 충돌을 조용히 두지 말 것
- (원래 526행) 인메모리 상태 맵은 대상 목록을 기준으로 정리한다
- (v2.919) 리눅스 베어메탈 통합 성능 모니터링 1단계 — 같은 SSH 1회에 구획 추가 · USE 판정 코어 하나 · 하드웨어 축은 이미 가진 데이터만
- (v2.922) 리눅스 성능 3a — 시간 단위 파일(5분·1시간·1일·장치) · 예전 표 마이그레이션(대조 뒤 삭제) · 피크 A 안 · 추이 API · CVP 포트 대조
- (v2.923) 리눅스 성능 4단계 — 튜닝 탭(항목 26 · 근거 등급 · 출처 · 자동 적용 없음) · 용도 프로파일(rocky9-base · airflow · gpdb) · 장애 기록(partfault 재사용) · 진단 스냅샷(원격 명령 — 규약은 security-api.md v2.923)
- (v2.929) 리눅스 성능 5단계 — 집중 모니터링(별도 타이머 · 법인 상한 · 전역 슬롯 · 인증 즉시 중단) · 알림 규칙(엣지 판정 · 상태 파일 · 하루 상한) · 베이스라인 띠 · 점검 소모품 8칸 · 변경 이벤트(전이 · 해시만) · 구간 비교
- (6단계) 리눅스 성능 6단계 — 서버 비교(같은 법인 기본 · 법인 간은 전체 범위만) · 수집 건강(폴러 계측 · 노드 한 칸 규칙) · 운영 주석 · 진단 플레이북(읽기 전용 · 실행 없음) · 목표선(결측 분모 제외)
- (7a단계) 리눅스 성능 7a단계 로그 분석 — 같은 SSH 세션의 별도 exec · 증분(커서 · boot_id+초 · offset+inode) · 규칙 카탈로그(포탈 엔진 재사용) · 원문 미보관 · 못 읽음은 상태
- (원래 746행) iDRAC 텔레메트리는 Datacenter 전용이다 — Enterprise 서버는 '대체 경로' 로 읽고, 그 부하에
- (원래 844행) 서버 온도 — 히트맵 보드(시안 B). '못 읽은 값' 을 정상으로도 이상으로도 세지 않는다
- (원래 1030행) v2.728 — 엣지 축약 인벤토리는 부품 이름·health·state 를 싣고, 중앙 `INV_SHAPE` 와 한 쌍으로 넓힌다
- (원래 2537행) Overview 에는 지도가 없다 — 그 자리는 '서버·게스트 수량' 이다
- (원래 2818행) 전력 latest 인메모리 캐시
- (원래 2903행) (구 '미해결 후속' 2건 — 적용 완료) 전력 대시보드 시간당 롤업 테이블은 `power_hourly`
- (원래 4471행) 서버 온도 › 센서 상세(v2.659) — iDRAC 전 센서. 판정은 장비 Health → 장비 임계값 순이고, 포탈은 임계를 지어내지 않는다
- (원래 4491행) iDRAC 통합 추이(v2.660) — 새 수집이 아니라 샘플러 적재 3계열 + 기간 조회. 데이터센터는 스캔 대역 이름이다
- (원래 4514행) iDRAC 통합 추이 보강(v2.661) — CPU 사용률은 대체 출처로 채우되 출처를 밝히고, 엣지 서버 전력은 `rmt:` 키로 찾는다
- (원래 4607행) Overview 카드 8장 · 전체 소비 전력(v2.664) — 합산은 `server/src/power/total.js buildPowerTotal` 하나
- (원래 4700행) HPE iLO 는 iDRAC 스캔 모듈이 함께 찾는다 — 새 수집기를 만들지 않았다
- (원래 5022행) 법인별 서버 사용량(v2.625) — 퍼센트를 더하지 않는다. 사용률 × 용량으로 사용량을 만들어 더한다
- (원래 5129행) v2.634 — 폴러의 표본 시각은 '그 서버를 실제로 읽은 시각' 이고, 신선도 경계는 폴 주기 소요에 맞춰 넓힌다

## 본문

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
    틀렸다** — 진짜 이유는 `collector/agent.js:47-57 compactInv`(지금은 `collector/compactInv.js`) 가 그때는 부품 health·serial·locator 를 **전부 빼서**
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
  - **v2.880 이슈 자동 등록**(`issues/autoCreate.js` · 설정 `issue-autocreate.json` · 화면 이슈 › 설정 › 자동 등록): 중앙 폴러(`poller.js runOnce`)가 `applyTransition` 직후 · 알림 전에
    `applyPartFaultIssues(tr)` 를 한 번 부른다(던지지 않음). 판정은 전이 결과 그대로 — **unknown · absent 는 등록하지 않는다** · 칸은 추출기가 실제로 보고하는
    부품만(`AUTO_SUPPORTED` — idrac/storage/sanswitch, ESXi · NIC · SFP 없음 · 테스트가 추출기 파일과 대조). 같은 `agent|partKey` 를 덮는 열린 이슈가 있으면 댓글 ·
    장비 폭주는 1건 · 하루 상한 · 키 변경(key-migrated)은 출처의 키만 바꾼다 · 해소되면 댓글 + 설정에 따라 '검토'(완료는 사람이) · 보류는 사유가 바뀔 때 댓글.
    법인은 ① iDRAC 서비스 태그 → 호스트의 vCenter(`hostVcByTag`) ② 수집 서버의 vCenter 가 하나 ③ 공용. 'replaceNotify' 를 켜면 이슈가 맡은 파트는 파트 장애
    알림에서 뺀다(기본 끔 — 사용자가 고른 '파트당 1건 즉시' 를 바꾸지 않는다). 이슈의 `origin` 은 서버 내부 경로만 붙인다(라우트 본문으로 받지 않음 — 위조 금지).
    회귀 `server/test/issuesAutoCreate2880.test.js`(변이 11/11).
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
  - **v2.734 장애별·종류별 탭** — 묶기·집계는 `partfault/incidents.js` 하나(`GET /tools/part-faults/incidents?days=&kind=`, 웹 문구 `partFaultText.js`).
    진행 중은 `part_state` 가 진실 · 시작을 못 찾으면 '모름' · 해소 없는 끝은 '종료 기록 없음' · 키 변경은 한 건 · 종류별은 필터 전 전체 기준 · 기록 없는 종류를 0건으로 싣지 않는다.
    이벤트는 최신부터 조각 + 양보 + 상한(넘으면 coveredSince). 회귀 `server/test/partFaultIncidents2734.test.js` + 웹 `partFaultIncidents2734.test.js`.
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
  - **폴러 규약 전부**: 재진입 가드(수동 실행과 **공유**) · 동시성 제한(`BMUSAGE_CONCURRENCY` 기본 32 — v2.918 사용자 결정, 이전 4: 1,000대 법인에서 동시 4 면 한 주기 약 21분) ·
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
- ⚠⚠ **리눅스 베어메탈 통합 성능 모니터링 1단계(v2.919 예정 — 서버만) — 같은 SSH 1회에 구획을 더하고, 판정은 엣지 한 곳·USE 칸마다 code 로**
  (`bmusage/{collectors/osSsh.js,parse/linuxProc.js,rates.js,usage.js,perfCols.js,useJudge.js,hwFacts.js,perfView.js,db.js,edgePull.js}` ·
  `central/{bmUsageEdgePull.js,bmPerfSanitize.js}` · `routes/api/bmUsage.js`. 설계 `docs/design/linux-bm-perf/README.md` §3.2·§4 · 사용자 결정 2026-11-07 '8단계 전부 순차 구현'.
  회귀 `server/test/bmPerf2919.test.js`(30건 · 줄 변이 24건 중 23건 검출 — 1건(PSI 전부 absent → none)은 지금 칸 구성에서 도달하지 않는 등가 변이 · 기준판 f794b98 파일 되돌림 10/10 검출):
  - **구획**: `##STAT` 은 `/proc/stat` 전체(cpu 합계·cpuN·ctxt·intr·procs_*; cpuN 줄 수 = 코어 수) · `##LOAD` · `##PSI`(`/proc/pressure/*` — 없으면 **0줄 = absent**) ·
    `##VMSTAT`(pswpin·pswpout·pgmajfault·oom_kill) · `##SNMP`(Tcp 두 줄) · `##BLKQ` · `##SYSCTL`(화이트리스트 경로 `parse/linuxProc.js SYSCTL_PATHS`) · `##IRQ`(awk 요약 + irqbalance) ·
    `##DFI`(`df -P -i` 등록 마운트) · `##END`. 기존 `##DISK`·`##NET` 명령은 그대로이고 파서가 14열·16열을 다 쓴다. 왕복 1회·세션 예산 산수는 바뀌지 않았다.
    새 구획은 기존 구획 **뒤**에 두고 명령 전체를 `head -c OUTPUT_MAX_BYTES`(1MiB)로 감싼다 — `##END` 가 오지 않으면 `truncated`(그 뒤 구획은 missing). sshExec 4MB 상한에서 결과가 통째로 버려지기 전에 우리가 먼저 자른다.
  - ⚠⚠ **sysctl 파일을 셸 `read` 로 읽지 말 것**(이 컨테이너 dash 실측): dash 는 1바이트씩 읽고 sysctl 정수 파일은 오프셋 0 이 아니면 EOF 라 `swappiness 60` 이 `6` 으로 읽혔다(오류 없이 틀린 값). `grep -H ''` 한 번으로 읽는다.
  - ⚠ **원시 idle 은 `idleRaw`** — `idle` 이름은 기존 규약(idle+iowait)이 쓴다. 분해 필드로 덮으면 cpu_pct 와 분해가 서로 다른 idle 을 쓴다(자체 실측에서 잡았다).
  - **absent vs missing**: 구획 표지 미도착 = missing · 표지는 왔는데 빈 줄만 = absent · 줄은 있는데 파싱 실패 = missing(`readSection`). 판정 칸 code 는 `ok|warn|bad|none(absent)|missing|nopath(경로 없음)` 이고
    none·missing·nopath 는 병목·포화·오류 판정에 넣지 않고 **따로 센다**.
  - **열**: 새 지표 열 28개는 `perfCols.js PERF_COLS` 하나가 계약이다(자원·USE 칸·judged). 이력·최신값은 열 그대로, 일 롤업은 `<열>_max` 만(포화·오류는 피크가 뜻이다).
    최신값 전용: `os_at`·`idrac_at`(그 경로의 **마지막 성공** — 이번에 못 읽었으면 COALESCE 로 지킨다) · `detail_json`(장치별 — 디스크·NIC 각 32 상한) · `tuning_json`(sysctl·THP·governor·hugepages·blkq·irq).
    JSON 열은 64KB 를 넘으면 잘린 JSON 대신 `{truncated:true}`. 열 추가는 `migratePerfColumns`(ALTER ADD COLUMN · 멱등) — 기존 DB 와 새 DB 가 같은 경로다.
  - **rates**: 첫 표본·리셋(음수)·간격 비정상은 null(기존 규약). I/O 0건 간격의 await·보낸 세그먼트 0 의 재전송률은 null(지어내지 않는다). 대표값은 장치 중 최대(maxOrNull) ·
    드롭·오류는 **물리 NIC 만**(veth·bridge 드롭은 회선 드롭이 아니다). 오류·드롭·OOM 은 ‘연속 증가 주기 수’(streak)를 `_prev` 에 들고 간다(null 은 판정 보류 — 끊지 않는다).
  - **판정 코어는 `useJudge.js` 하나**(웹이 복제하지 않는다): 기준값은 `settings.perf`(이 노드 설정 · `PERF_DEFAULTS` — ‘추정’ 값은 주석에 그렇게 적었다)이고 API 가 내려준다.
    ‘병목’ = 한 자원의 세 칸 중 둘 이상 bad · ‘포화’ = S bad · ‘오류’ = E bad · 증가분 > 0 → warn, `errRepeatBad` 주기 연속 → bad. 판정 한 줄(`line`)도 이 노드가 만들고 중앙은 그대로 전한다.
    ⚠ `perf` 는 중앙 배포 키(`DISTRIBUTED_KEYS`)에 넣지 않았다 — 넣으면 배포 서명이 바뀌어 구버전 엣지가 영원히 ‘적용 대기’ 다(전 엣지가 이 판 이상일 때 넣는다).
  - ⚠⚠ **하드웨어 축·교차 판정은 이미 가진 데이터만**(`hwFacts.js` — Redfish 호출 0): 전력 W(idrac/db latest) · cap(인벤토리 powerCap) · 흡기·CPU(sensorStore) · DIMM·SMART 예측·SEL(인벤토리) ·
    부품 장애(partfault openFaults — DB 가 없는 노드에 파일을 만들지 않는다). **받지 않는 값**(스로틀 · ECC 정정 수 · SMART 재할당 · NIC CRC)은 null → missing 이고 교차 ④ 는 단정하지 않는다.
    교차 판정은 커버리지 `both` 일 때만, ‘후보’ 로만 말한다. 커버리지는 두 경로 마지막 성공이 신선도 한계(주기 × 3, 최소 15분) 안인가로 정한다.
  - **엣지 봉투·정제**: 봉투에 `perf`(판정 항목 — 근거·장치별·튜닝·하드웨어 사실 포함) · `perfThresholds` · `perfCols` 를 싣고 행에서 JSON 문자열 열을 뗀다. 중앙은 `central/bmPerfSanitize.js`
    화이트리스트(아는 필드만 · enum 밖 code 는 missing · 장치 32 · 문자열 상한)로 담고 새 수치 열은 수로 좁힌다(기존 9개 열은 예전 계약 그대로 원시값).
  - **API**: `GET /tools/bm-usage` 에 `perf`(code 표)·`perfThresholds`·`perfDefaults`·`perfCols` 추가(기존 필드 불변 — 행의 JSON 열만 뗐다). 서버 1대 상세는
    ⚠ **`GET /tools/bm-usage/perf/:key`**(설계 지시는 `/tools/bm-perf/:key` 였다 — 새 첫 세그먼트는 `auth/toolAccess.js` 도구 매핑 밖이라 ‘베어메탈 사용률’ 을 거부당한 사용자도 읽게 된다. 같은 도구의 하위 경로로 두었다).
    scope 교집합 · 범위 밖·귀속 없음·없는 키 404 · 엣지 위임 서버는 보관분(엣지 판정) 그대로 · `memoJson` + 범위 서명 + 역할 + 마지막 수집 시각. `memoJson` 은 계산 결과의 `__status`(≠200)를 그 상태로 보낸다(캐시 경로 404).
  - ⚠⚠ **반증(review-s1) 반영 — 되돌리지 말 것**(회귀 `server/test/bmPerf2919Review.test.js`):
    · **D1** 출력이 잘리면(##END 미도착) **마지막 구획을 통째로 버린다**(cutSections — 숫자 중간에서 잘린 io_ticks 를 카운터로 쓰면 다음 주기 가짜 100% 가 원시·일 롤업에 남는다) ·
      기존 구획(MEM·DISK·NET·NETINFO·FC·DF)에도 `head -n (상한+1)`(DISK 10,000줄) — 넘으면 linesCapped · 전체 `head -c` 는 `EXEC_MAX_OUTPUT − 256KB` 이고
      구획 상한 × 줄 최대 바이트(가정)의 합(`SECTION_BYTES_SUM`)보다 크다(테스트 고정). 1단계 초판의 1MiB 상한은 예전 다섯 지표를 퇴행시켰다.
    · **D2** 엣지 봉투는 `ENVELOPE_MAX_BYTES`(기본 8MB · 중앙 16MB 의 절반) 안으로 — 넘치면 성능 상세 → code 표 → 전부 제거 순으로 빼고 `perfTruncated` 로 밝힌다. 다섯 지표 행·대상은 언제나 남는다.
    · **D3** 중앙 정제가 엣지 시각(ts·osAt·idracAt·detail.at·tuning.at·hw 시각)을 수신 시각으로 자르고 원본은 `edgeTsRaw`(`util/clampEdgeTs.js` — corpUsage 와 같은 함수).
    · **D4** 행이 신선도 한계(API `freshMs`)를 넘으면 cpu·mem·disk·net 칸은 `stale`(판정에 넣지 않고 따로 센다 · 판정 ‘오래됨’). 인벤토리 캐시는 `inventoryFreshMsFor`(주 폴러 인벤토리 주기 30분 × 4 와 freshMs 중 큰 값) 안일 때만 iDRAC ‘읽음’.
    · **D5** 경로가 있는 칸 중 판정한 칸이 `minJudgedPct`(기본 50 — 추정) 미만이면 ‘정상’ 대신 ‘대부분 못 읽음’(partial). 판정 한 줄은 ‘읽은 칸 j/a’ 를 늘 붙인다.
    · **D6** `migratePerfColumns` 는 실패를 콘솔 오류로 남기고 `migrateError` 를 insertUsage 결과·dbStatus·폴러 `_last.dbMigrateError` 로 올린다. 적재는 **실제로 있는 열만** 쓴다 —
      기존 db 모듈은 열기 실패를 ‘DB 없이 동작’ 으로 두는 관행인데, 열 하나 때문에 DB 전체를 끄면 다섯 지표까지 멈추므로 그 열만 빼고 계속한다.
    · **D8** 명령 앞 `export LC_ALL=C;`(한국어 로캘의 번역된 df 머리글).
    · 미룬 것(D7·D9~D15)은 설계 README §6 의 11번.
- ⚠⚠ **리눅스 성능 3a(v2.922 예정 — 서버만) — 저장은 시간 단위 파일 · 보존은 파일 삭제 · 예전 표는 ‘옮기기 → 행 수 대조 → 삭제’ · 피크는 같은 세션 1초 창**
  (`bmusage/{monthStore,monthMigrate,peakWindow,samplerSpec,deviceRows,trendWindow,trendQuery,portCompare,portMap}.js` · `db.js`(메인 = 최신값·장치 목록·bm_meta) ·
  `routes/api/bmUsage.js`(`/tools/bm-usage/perf/:key/history|devices|ports` · `PUT /tools/bm-usage/port-map`) · `routes/collector.js`(`/bm-usage/trend|devices|nics`) ·
  `central/bmUsageEdgePull.js pullBmTrend`. 설계 README §4.4 · PROFILES §6·§8~§12. 회귀 `server/test/bmPerf2921{,Migrate,Cvp,Size}.test.js`):
  - **파일**: 5분 원시 `bm-usage-YYYY-MM.db`(30일 — 실효는 min(store.rawDays, rawRetentionDays)) · 1시간 `bm-usage-1h-YYYY-MM.db`(365일) · 1일 `bm-usage-1d-YYYY.db`(**연 파일** — 5년 창이 6개) ·
    장치 5분 `bm-usage-dev-YYYY-MM.db`(14일) · 장치 1시간 `bm-usage-dev1h-YYYY-MM.db`(90일). 달·해 경계는 포탈 시각(util/dayKey). **보존이 같은 것끼리 파일을 나눈다** —
    한 파일에 단계를 섞으면 5년 뒤에야 지울 수 있고 그 사이 수천만 행을 DELETE 해야 한다(설계 문장과 다른 결정 — 이유는 monthStore 머리말).
    보존: 기간 끝 ≤ 기준이면 **파일 삭제**(-wal/-shm 포함 · 쓰는 중 pin 이면 다음으로) · 경계 기간만 청크 DELETE. ⚠ 디스크는 최대 한 기간 더 남는다(정직 기록).
  - **조회**: ATTACH 대신 파일별 핸들(진행 중인 open 공유 `opening` Map · LRU `BMUSAGE_MONTH_MAX_OPEN` 24 · pin) · **조회당 파일 10개 상한**(ATTACH 상한과 같은 값 — 넘으면 최근 10 + `filesCapped`) ·
    없는/못 연 기간은 `missingPeriods`(그 기간 없음)로 밝히고 나머지로 계속. 조회는 파일을 만들지 않는다.
  - **적재**: 원시 INSERT OR IGNORE + 새로 들어간 행만 1시간·1일 upsert(합·개수·최대 · null 은 개수 제외 · 피크는 더 클 때만 값과 시각을 같이) · 파일마다 트랜잭션 1회(안에 await 없음).
    1일 표는 예전 모양 + 모든 지표의 합·개수 + 피크. **1초 샘플은 DB 에 없다**(1초 해상도 표가 없다 — 창 표본은 집계 뒤 버린다).
  - ⚠⚠ **마이그레이션(위험한 수정 — 순서를 테스트가 고정)**: 메인 파일을 여는 순간 상태(bm_meta `migrate.v2922`)를 정한다(예전 표에 행이 있으면 copy-raw) —
    copy-raw(rowid 순 청크 → 월 파일 IGNORE + 1시간 롤업은 **파일별 `_mig` 커서를 같은 트랜잭션에서** 올려 재개해도 한 번만) → copy-daily(사본 표 usage_daily_mig — IGNORE) →
    verify(달·해마다 예전 행 수 ≤ 사본 행 수 — 지우기 전) → delete(시작 시 최대 rowid 이하만 청크) → done. 청크마다 시간 기준 양보 · 폴러 틱이 기다리지 않고 잇는다.
    실패면 failed(1시간 뒤 재시도 · 최대 3회 · 대조 실패면 커서 0 부터). **그동안 읽기는 예전 표가 그 구간의 원본**(readRule) — historyRollup 의 ‘원본 폴백 금지’ 는 롤업 대신 원시를
    읽는 것이라 이것과 다르다. 1시간 롤업이 아직 없는 구간은 원시로 메우지 않고 결측 사유 `migrating`. 옮기는 동안 원시·롤업 파일 보존은 멈춘다(대조 전에 사본을 지우지 않게).
    ⚠ 메인 파일 크기는 VACUUM 전에는 줄지 않는다(지운 자리는 메인 파일 안 빈 페이지 — 운영 VACUUM 은 docs/SETTINGS.md 부록 A-2).
  - **장치별**: 물리 디스크·dm/md·물리 NIC·bond(가상 NIC·loop·ram·zram·sr 제외) · 파티션 I/O 는 `store.partitionIo` 옵트인(part 표시 · 대표값에서 뺀다) · 상한 `store.deviceMax`(32 — 물리 → md → dm → 파티션 순,
    한 종류가 상한을 다 차지하지 않게) · 넘은 수는 최신값 `dev_over` + 노트. 장치 목록(usage_devices)은 처음 본 순서 `ord` 가 색 순서(바뀌지 않는다). 마운트는 일 롤업만.
  - **피크 A 안**: 본 명령 뒤 **같은 세션**에서 `/proc/stat`·`/proc/diskstats`·`/proc/net/dev` 를 1초 간격 N+1 번(`store.peakWindowS` 10 · 0 이면 끔) — 세션 예산(50초)에서 남은 시간으로
    줄이고(2초 미만이면 0) 행에 `peak_window_s` · 노트. 시각은 원격 /proc/uptime 간격 + 이 노드 시계. `peak_src`: window10 | sampler | psi | none.
    ⚠⚠ **주기 예산 자동 맞춤(v2.922 메인 지시 — `bmusage/peakPlan.js`)**: 창은 서버마다 수집 시간을 늘려 1,000대 · 동시 32 에서 한 번 도는 데 주기보다 오래 걸렸다.
      ⚠ 정정(반증 D2): 타이머는 **실행이 끝난 뒤 재무장**한다(util/adaptiveTimer) — 틱을 건너뛰는 것이 아니라 **실제 간격 = 실행 소요 + 주기**로 늘어난다
      (예: 실행 6.9분 + 5분 ≈ 12분). 추이(trendWindow.gapsOf)는 기대 간격 × 2(5분 주기면 10분)를 넘는 빈틈을 결측으로 끊으므로 **다섯 지표의 5분 추이까지 전부 결측**이 된다.
      매 주기 예상 실행 소요 = max(1, 대상 ÷ 동시성) × (서버당 기본 소요 + OS 비율 × 창) 가 주기 × `store.peakCycleRatio`(0.7) 를 넘으면 창을 10 → 5 → 3 → 0초로 줄인다
      — 그러면 예상 간격(실행 + 주기, `expectedPeriodMs`) ≤ 주기 × 1.7 < 결측 경계(주기 × 2). 비율 상한은 0.95(1 이상이면 이 보장이 깨진다) —
      `peakWindowS` 는 상한(줄이기만) · 기본 소요는 직전 주기 실측(서버별 소요 − 실제 창, 평균), 없으면 보수적 8초(추정) · 결정은 `_last.peakPlan`·`bmUsageStatus().peakPlan`(수집 건강 ⑫) · 행 노트와 `peak_window_s` 에 실제 값.
      **이 맞춤을 지우거나 상한 대신 결정값을 그대로 쓰지 말 것**(회귀 `server/test/bmPerf2921Plan.test.js` — 변이 11/11).
    B 샘플러: `store.peakSampler` 옵트인일 때만 `##SAMPLER`(고정 경로 · 없으면 absent) · 형식 v1 · 기대 sha256(`store.peakSamplerSha256`)이 없거나 다르면 unverified(값을 쓰지 않는다) — **배포 기능 없음(7단계)**.
  - **D7**: `##BLKQ` = `grep -H ''` 한 번(+ 가상 장치 거르는 grep) · 물리 → md → dm 순 · 상한 `store.blkqMax`(64) · 자르기 전 수는 tuning `blkqTotal`.
  - **D13**: `latestUsage()` 기본은 JSON 열 없는 판본 · 판정 소비처(주 조회·상세·엣지 봉투)만 `{ json:true }`.
  - **추이 API**: 해상도 auto(2일 5분 · 60일 1시간 · 그 위 1일 · 보존 밖이면 한 단계 위 · 장치는 1일 없음 · 마운트는 1일만) · 평균/최대/피크/피크 시각 · 결측 구간(기대 간격 2배) · 기준선(settings.perf) ·
    점 상한 6,000(넘으면 truncated) · 지표·종류·장치 이름은 화이트리스트. 엣지 위임 서버는 엣지 대행(보관 안 함 · 정제 · 최소 엣지 2.922.0). scope 교집합 404 · memoJson + scopeKey + 역할 + 마지막 수집 시각.
  - **CVP 대조(서버 쪽)**: 후보는 `cvp/hostMatch.js matchUplinks` **하나**(v2.920 업링크 매칭 — 별칭·리눅스 NIC 이름을 받게 넓혔다 · 구분자 있는 이름 매칭 결함 수정) · 수동 매핑 `bmusage-portmap.json`
    (admin · 원자 쓰기 · 손상 보존 후 저장 거부 · 감사 로그 · 범위 계정은 자기 법인 CVP 로만 — 안 보이면 404, 보이는데 다른 법인이면 403) · 상태 no-cvp · no-mapping · candidate · no-counters · stale · mapped ·
    대조 ⑤ 는 창(끝 시각·길이)이 20% 안일 때만, 기준 `store.portTolPct` 5%. LLDP·MAC 은 만들지 않았다.
  - **행 크기 실측**(설계 §4.4 정정): 원시 655B · 1시간 1,110B · 1일 1,147B · 장치 5분 213B · 장치 1시간 296B → 1,000대 약 25GB(보존 정확) · 최악 42.7GB(표 — 설계 README §4.4 · 선택지별 크기).
  - ⚠⚠ **반증(review-s3a) 반영 — 되돌리지 말 것**(회귀 `server/test/bmPerf2921Review.test.js` · `bmPerf2921CvpRecv.test.js`):
    · **D1** port-map 쓰기는 `inUserWriteScope` 를 **조건 없이**(조회 밖 404 → 쓰기 밖 403) · 법인 CVP 검사는 `!isFullReadWriteScope` 일 때 · PUT/DELETE 한 함수(`portMapWrite`) · 실제 라우터 테스트(조회 무제한 + writeVcenters).
    · **D3** 중앙 CVP 정제는 12칸 표본을 12칸으로(구 엣지 10칸은 10칸) · 10칸 표본은 port_latest 드롭을 덮지 않는다 — 실제 수신 라우트로 시험.
    · **D4·D5** 원시와 롤업은 다른 파일이라 원시 트랜잭션에 ‘보정 대기’(`_pend` — agent·key·시간 버킷)를 남기고 롤업이 모두 성공하면 지운다 · 남은 대기는 매 틱
      `repairRollups` 가 **원시에서 그 버킷을 다시 집계해 교체**(1일은 legacyMaxTs 뒤 행만 — 예전 일은 사본 표) · 마이그레이션은 보존 안 행의 버킷을 전부 대기로(라이브 선행 이중 계수 없음 m3)
      · 보존 밖 행은 **agent 별 커서**(m1) · 경계(rawCopyFrom·hourlyFrom)는 정시로 맞춰 고정 · 대조에 1시간 표본 수(예전 행만 있는 시간 = 같음 · 경계 시간 ≥).
    · **D6** 마이그레이션 시도 횟수는 재시작하면 0 부터 · 다 쓴 뒤 6시간이면 다시 · 옮기는 중·실패 대기 중에는 예전 표 정리와 원시·롤업 파일 보존을 멈춘다 · 상태(다음 재시도)는 `_last.migration`.
    · **D2** 타이머는 실행 뒤 재무장 — 간격 = 실행 + 주기(`peakPlan.expectedPeriodMs`) · 자동 맞춤이면 간격 ≤ 주기 × 1.7 < 결측 경계.
    · **D7** hostMatch 경계 보강(cvp.md v2.922) · **D8** 1일 추이도 missingPeriods·filesCapped · **D9** 롤업 peak_src = 피크를 낸 행의 출처(섞이면 mixed) ·
      **D11** 5분 추이는 필요한 열만 · 파일 행 수 상태는 10분 캐시(낡으면 지난 값 + stale, 뒤에서 다시 센다) · 마이그레이션 청크 500 · **D12** 피크 노트는 원인을 단정하지 않는다 ·
      **D13** 샘플러 머리 줄 sha256 은 자기 신고 값(설정값과 같아도 위조 방지 아님 · 미래 시각은 형식 오류) · **D14** iDRAC 통합 추이가 원시 보존 밖 구간을 `cpuHistoryNote` 로 밝힌다 ·
      **D15** 포트 대조는 CVP 도구 접근이 있어야 포트 값을 준다(없으면 ‘권한 없음’) · 비관리자에게 포트 설명 주소 가림 · **D10** 은 기록만(README §6-14).
  - ⚠ **정직 기록**: 표본은 커널 문서 형식 + 이 개발 컨테이너(커널 6.18 · dash) 실행 출력이다 — 이 현장 Rocky 9 / RHEL 8 베어메탈 출력은 보지 못했다. `/proc/interrupts` 의 NIC 큐 이름 패턴 ·
    PSI 유무 · `/etc/tuned/active_profile` 존재는 첫 실수집에서 `detail.sections`·`tuning.sections` 를 보고 좁힌다. 화면(2단계)·월 파일/3단 보존/장치별 이력(3단계)·진단 스냅샷(4단계)은 아직이다.
- ⚠⚠ **리눅스 성능 4단계(v2.923 예정 — 서버 + 화면) — 튜닝 · 용도는 ‘사실은 엣지 · 판정은 응답 노드’, 장애 기록은 새 수집 없이 partfault 재사용, 스냅샷은 상수 명령 1회**
  (`bmusage/{parse/linuxFacts.js,tuning/{sources,catalog,judge,overrides}.js,profiles/{rocky9-base,airflow,gpdb,index,match}.js,opsView.js,snapshot/{command,run}.js}` ·
  `routes/api/bmUsage.js`(`/perf/:key/tuning|profile|faults|snapshot|snapshots[/:id]` · `/profiles` · `/faults` · `PUT /purpose` · `PUT /tuning/overrides`) · `routes/collector.js`(`/bm-usage/snapshot(s)`) ·
  `central/bmUsageEdgePull.js runEdgeSnapshot · pullEdgeSnapshots` · `insights/fleetTags.js purposes`. 설계 README §4.1·§4.3 · TUNING-SOURCES · PROFILES §1~§5·§7.
  회귀 `server/test/bmPerf2923{Tuning,Profiles,Facts,Snapshot,Ops}.test.js` · 웹 `bmOpsText.test.jsx`):
  - **수집 구획(같은 SSH 1회 · 읽기 전용 · 상수 조각 `linuxFacts.js FACT_SHELL`)**: `##OSREL`(os-release ID · VERSION_ID · PRETTY_NAME + PAGE_SIZE + getenforce + logind RemoveIPC **명시 설정만**) ·
    `##UNITS`(running 서비스 + 실패 수 — `systemctl` 이 없으면 아무것도 내지 않는다(absent). ⚠⚠ **정정(반증 R7)**: 초판 문서는 ‘wc -l 이 0 을 지어내던 것을 막았다(이 컨테이너 실측)’ 고 적었지만
    그것은 systemctl 이 **없는** 경우만 막았다 — 이 컨테이너는 systemctl 이 **있고 실패**(rc=1 · ‘Failed to connect to bus’)해 여전히 `failed=0` · 빈 목록을 지어냈다(반증 재현 · 거짓 정상 · 거짓 적합 · 거짓 권고로 샜다).
    이제 두 호출의 **종료 코드**를 보고 성공했을 때만 `running=ok` · `failed=<grep -c>` 를 내고, 실패면 `running=rc<n>` · `failed=rc<n>` → 파서가 그 칸을 null(확인 불가). 가짜 systemctl(실패 · 성공 · 3초 시한)로 실제 셸에서 고정(Facts 테스트)) ·
    `##PORTS`(ss -ltn 로컬 포트 — `-p` 없음) · `##PROCS`(**comm 만** · 커널 스레드(‘/’ 든 이름) 제외 — 인자 · 환경 금지) · `##ACCT`(고정 이름 `DETECT_ACCOUNTS` 의 존재만) ·
    `##KARGS`(/proc/cmdline 화이트리스트 키만 — root= · rd.* 는 싣지 않는다) · `##SOFTNET`(앞 세 열만 — 원문 13열이면 1,024코어에서 D1 바이트 산수를 넘겼다) · `##NETQ`(물리 NIC 의 tx_queue_len · 큐 수 —
    셸 글롭으로 세어 프로세스를 띄우지 않는다) · `##XFS` · SYSCTL 14키(G1 요구값 · netdev_budget) · BLKQ `read_ahead_kb`. 바이트 산수(SECTION_BYTES_SUM < OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT)는 그대로 테스트가 고정.
  - **튜닝 열 상한**: 감지 목록이 커서 64KB 를 넘으면 예전 규약은 `{truncated}` 로 **sysctl 까지 잃었다** — `usage.js tuningCol` 이 목록(procs → units → ports …)부터 null + `trimmed` 로 빼고 다시 잰다.
  - **엣지 봉투는 감지 목록을 관찰 대상만**(`profiles/index.js ENVELOPE_WATCH · compactTuningForEnvelope`): 1,000대 × 프로세스 512 · 유닛 256 원목록이면 봉투 8MB 상한을 넘겨 **전 서버의 USE 근거까지 빠진다**(fitEnvelope).
    ⚠ 프로파일이 새 이름 · 포트를 보게 되면 ENVELOPE_WATCH 에도 더할 것 — 테스트가 ‘원목록 감지 = 줄인 목록 감지’(튜닝 26 · 프로파일 점검 · 요구값까지)를 대조한다. 중앙 정제 `tuningFactsOf` 화이트리스트에도 새 필드를 넣는다.
  - **튜닝 판정(`tuning/judge.js`)**: 상태 `advise · ok · info · unknown` + 사유 code(웹 문구 1:1). ⚠⚠ **확인 불가 ≠ 불일치** — 값이 없으면(구획 missing → notRead · 구획은 왔는데 값 없음 → notPresent) 권고로 세지 않는다.
    장치 · NIC 항목은 장치마다 판정하고 가장 나쁜 것(권고 > 확인 불가 > 적합 > 참고). **역할 권장값의 근거는 DB 열뿐** — 다른 역할에 DB 전제 값(TuneD · governor · swappiness 10 · THP madvise · HugeTLB)을 두지 않았다(권장 없음 · 참고).
    우선순위 **기능 프로파일 > 역할(관리자 덮어쓰기 법인 > 전체 > 기본) > OS** — 화면이 누가 정했나(by)를 적는다. 덮어쓰기는 `overridable`(같다/다르다 판정) 항목만 · 파일 `bmusage-tuning.json`(원자 쓰기 · 손상 보존 ·
    util/settingsLoadError 등록 — 손상 · 보존본만 남음이면 판정도 저장도 503 settingsUnreadable: 덮어쓰기를 무시한 판정을 정상처럼 보이지 않게).
  - ⚠ **판정 위치**: 튜닝 · 용도는 엣지가 판정해 보내지 않는다(현재값 사실만) — 응답 노드가 그 노드의 덮어쓰기 · 용도 태그로 판정한다. v2.548 ‘중앙이 엣지 판정을 다시 하지 않는다’ 와 충돌하지 않는다(다시 하는 판정이 아니다).
    그 대가로 엣지 자신의 화면에는 중앙의 용도 태그 · 덮어쓰기가 없다(정직 기록).
  - **용도 프로파일**: 파일 1개 = 프로파일 1개(rocky9-base · airflow · gpdb) + 등록부 · 카탈로그 테스트(출처 id · 등급 · 출처 없으면 ○ · catalogId). Ubuntu · Windows · Hadoop 은 **만들지 않았다**(감지 규칙도 없음 — 매트릭스 ‘프로파일 없음’).
    감지: Airflow 는 유닛 `airflow*` · comm `airflow` 가 강한 단서(계정 · 8080/8974/8793 포트만으로는 아님) · GPDB 는 gpadmin + (postgres 또는 5432/6000대). **수동 태그가 덮는다**(fleet-tags.json `purposes` — 기존 tags 를 보존 · 비면 예전 모양).
    점검 결과 `ok · warn · bad · unknown · notCollected · info` — CLI · HTTP · SQL · airflow.cfg 가 필요한 점검은 **미수집**(정상으로 세지 않는다 — 이 단계는 앱 명령을 실행하지 않는다). gpdb 의 NIC/RAID 점검은 USE code 그대로.
  - **장애 기록(새 수집 없음)**: 라우트 `computeIncidents`(partFaults.js — 같은 30초 메모) → `opsView.incidentsForServer`(scope idrac · agent 축(hwFacts 와 같은 규칙) · 서비스 태그 또는 등록부 id) → 요약 5칸은 code 를 세기만.
    part-faults 도구 접근이 없으면 내용 없이 ‘권한 없음’(v2.922 D15 와 같은 판단) · 비관리자는 `maskIncident` · SEL/LC 는 이 노드 인벤토리가 있는 서버만(엣지 위임 서버는 중앙에 목록이 없다).
  - **진단 스냅샷** — 규약 · 테스트는 `security-api.md` v2.923. 보관은 메인 bm-usage.db `bm_snapshots`(7일 · 실행 때 정리 · 보존 DELETE 허용 목록에 유계 사유) · 설정 `snapshot.{dailyCorpMax 20 · topN 10 · dmesgLines 50}`(추정 시작값 · 배포 키 아님).
  - ⚠⚠ **표지 위조(반증 R1 — 4단계가 연 새 경로)**: `##PROCS` 는 프로세스 이름(comm — 아무 사용자나 정한다)을 줄 머리에 내보낸다. 비특권 사용자가 ‘##MEM’ · ‘MemTotal: 9 kB’ 이름의 프로세스를 띄우면
    예전 `splitSections`(trim 뒤 아무 표지 · 이미 본 구획 재개방)가 MEM 구획을 그 이름들로 덮어 **가짜 메모리 100%** 를 만들고 PROCS 를 비웠으며, ‘##END’ 이름이면 잘림 보호(1단계 D1)까지 꺼졌다(이 컨테이너 재현).
    이제 ① `splitSections(text, { order: LINUX_SECTIONS })` — 줄 머리 그대로 정확 일치 · 명령의 표지 순서에서 **지금보다 뒤의 표지만** · 이미 본 표지는 다시 열지 않는다(스냅샷 파서도 같은 규칙 — R6)
    ② 비특권 입력이 줄 머리에 오는 구획에 고정 접두(`PROCS` `p:` · `UNITS` `u:` · 스냅샷 `DMESG` `d:`) — 파서가 벗기고 접두 없는 줄은 버린다. 전수 점검 결과는 `linuxFacts.js FACT_PREFIX` 주석
    (PORTS · ACCT · KARGS · SOFTNET · OSREL · NETQ · XFS · 기존 NETINFO · FC · DF · HOST 는 줄 머리를 root · 커널 · 고정 형식이 정한다). ⚠ 새 구획을 더하면 `LINUX_SECTIONS` 순서에 넣고, 줄 머리를 누가 정하는지 먼저 본다.
    회귀: 실제 셸 + 실제 shapeLinux 에 ‘##MEM’ · ‘##END’ 이름 프로세스를 띄워 MEM 실제값 · PROCS · 잘림 판정을 대조(Facts 테스트).
  - **주기 명령의 시한(반증 R8 · 추정 근거)**: 주기 수집 명령 전체가 exec 시한 하나라 한 칸이 멈추면 **전 구획(USE 포함)** 을 잃는다 — `systemctl` 3곳은 `timeout 3`(D-Bus 기본 25초) · `getent` 는 `-s files`(SSSD/LDAP 왕복 없음 —
    디렉터리 계정의 gpadmin 은 ‘없음’ 으로 보인다: 정직 기록). SSSD · 바쁜 systemd 실측은 없다(추정).
  - **묶음 값(반증 R9)**: ‘a / b’ 한 칸 사실(`catalog.js pairText` — gpdb SYS2 · mem.dirty · net.rmemMax)은 한쪽이라도 못 읽으면 표시만 ‘—’ 이고 판정은 확인 불가(`hasMissingPart`). 업그레이드 기간(엣지 v2.922 는 새 sysctl 14키를 보내지 않는다)에 GPDB 서버가 늘 권고로 보이던 것을 막는다.
  - **장애 기록 탭의 범위(반증 P1 — 판단 기록)**: 파트 장애 도구 자체는 `fullScopeOnly`(‘부품 장애에는 법인 축이 없다’)지만, 이 탭은 **bm-usage 대상의 법인 귀속**(서버 → vCenter)을 축으로 범위 계정에도 **자기 법인 서버 것만** 보인다
    (2단계 하드웨어 탭 · hwFacts 와 같은 판단 · part-faults 도구 접근은 따로 재검사). 함대 ‘장애 기록’ 보기도 같은 축으로 자른다. 모순이 아니라 축이 다르다 — 회귀 Ops 테스트 ①.
  - ⚠ **정직 기록**: 수집 구획 · 스냅샷 명령은 이 개발 컨테이너(dash · 커널 6.18 · systemd 없음 · ss 없음)에서만 실행해 봤다 — Rocky 9 실장비 출력 미확인(getenforce · logind.conf.d · softnet 열 수 · NIC 큐 디렉터리).
    Airflow 프로세스 comm 이 ‘airflow’ 인지 ‘python3’ 인지는 설치 방식에 따라 다를 수 있다(미확인). GPDB coordinator/segment 는 기본 포트로 **추정**한다. 설계 README §6-11 D12(selCritical 시간 창 · IRQ virtio)는 이번에도 미처리.
- ⚠⚠ **리눅스 성능 5단계(v2.929 예정 — 서버 + 화면) — 집중 모니터링은 ‘별도 타이머 · 같은 수집 함수 · 같은 인증 가드 · 같은 슬롯’, 판정 · 발송은 수집 노드, 설정 파일 내용 · dmesg 원문은 저장하지 않는다**
  (`bmusage/{parse/linuxHealth.js,health.js,changes.js,cycleOps.js,opsDb.js,perfRules.js,perfAlerts.js,baseline.js,compare.js,slots.js,perfOpsView.js,focus/{run,summary}.js,snapshot/reason.js}` ·
  `routes/api/bmPerfOps.js` · `routes/collector.js`(`/bm-usage/focus[/stop] · /changes · /baseline · /compare`) · `central/bmPerfOpsPull.js` · `issues/alertIssues.js applyBmPerfFires`(출처 `bmperf`).
  설계 PROFILES §13 · §14 · README §8. 회귀 `server/test/bmPerf2929{Health,Changes,Focus,Alerts,Baseline}.test.js` · 웹 `bmPerfOpsText.test.jsx`):
  - **수집 구획(같은 SSH 1회 · 1단계 R1 규약 그대로)**: `##CHRONY`(`chronyc -c tracking` 한 줄 · `c:`) · `##DMESG`(awk 가 err · warn · 최근 24시간 **개수만** · `k:` — 원문은 awk 밖으로 나오지 않는다) ·
    `##CHANGES`(`x:` — uptime · boot_id · 커널 · needs-restarting -r · dnf history 최근 6줄(**명령줄 열은 셸에서 버린다**) · `sysctl -a` 휘발성 키를 뺀 **CRC 하나** · /etc/sysctl.d · cron.d · crontab · /var/spool/cron 은
    **cksum(CRC)만**(내용 · 크기는 셸 밖으로 나오지 않는다 — 비밀 혼입) · tuned-adm active · systemctl --failed 개수 · file-nr · conntrack). 멈출 수 있는 명령은 `timeout`(chronyc · dmesg · systemctl 3 · needs-restarting · dnf 8) ·
    rc ≠ 0 이면 그 칸 null(missing) · 명령이 없으면 absent. 줄 머리를 사용자가 정할 수 있는 칸(파일 이름 · dnf 행)은 고정 접두 + 이름 화이트리스트(`../` · 공백 이름은 버린다).
    `LINUX_SECTIONS` 순서(사실 구획 뒤 · 샘플러 앞) · 바이트 산수(SECTION_BYTES_SUM < OUTPUT_MAX_BYTES < EXEC_MAX_OUTPUT)는 Health 테스트가 **실제 dash · bash** 로 고정(가짜 chronyc · dmesg · dnf).
    이 컨테이너 실측: 주 명령 전체 158ms(dash) · 239ms(bash) — 새 구획 포함(chronyc · needs-restarting · dnf 는 이 컨테이너에 없어 absent 경로만 실행됐다).
  - **점검 소모품 8칸(`health.js judgeHealth` — 판정은 수집 노드 · 중앙은 code 를 그대로)**: chrony 오프셋(기본 100ms) · 실패 유닛(4단계 UNITS 사실 — R7 실패=missing) · OOM(vmstat oom_kill 증가) ·
    커널 오류(24시간 err 개수 기준 0) · 가동 시간 · 재부팅 필요 · FD · conntrack(80%) · 인증서(**svcmon cert 점검 재사용** — 서버 주소 · 이름 정확 일치 · 가장 짧은 남은 일수 · 30일) · TuneD · SELinux · firewalld(참고).
    code `ok · warn · bad · missing · absent · perm · na · info` — **주의(attention)는 warn + bad 만**(못 읽음 · 없음 · 해당 없음은 주의에도 정상에도 넣지 않는다). 칸은 `cycleOps.prepareCycleOps` 가 적재 **전에** 행 detail_json 에 싣는다
    (`since` = 그 code 가 된 시각 — change_latest 전이 기록 · 화면 ‘며칠째’).
  - **변경 이벤트(`changes.js diffChangeFacts` — 전이만)**: 첫 관찰은 기준만(이벤트 0) · 이전과 다를 때만 `change_event` · **null(못 읽음)은 비교하지 않고 직전 값을 들고 간다** · 펌웨어(이미 가진 iDRAC 인벤토리 — BIOS 중복 제거) ·
    CVP 매핑(수동 매핑) · 소모품 칸 code 전이. sysctl 전체 CRC 가 **연속 3주기** 바뀌면 휘발성(noisy)으로 보고 그 이벤트를 멈춘다(실장비 휘발성 키 미확인 대비) · 한 주기 24건 상한(넘으면 ‘그 밖 n건’ 한 줄).
    최신 사실은 `change_latest`(서버별 — 재시작 뒤 같은 변화를 다시 적지 않는다) · 쓰기는 한 트랜잭션(`changeWriteBatch`) · 보관 30일(설정 `changes.keepDays` — 설계의 ‘1년’ 은 쓰지 않았다: 메인 DB 행 수) ·
    대상에서 사라진 서버의 최신값은 **마지막 성공 주기의 키**(`_lastLiveKeys`)로 정리한다 — 정리 틱에서 대상 해석(`currentTargets`)을 다시 부르면 bmstor 등록부 캐시를 오염시켰다(bmPerf2923Snapshot 404 — 이번 회차에 잡음).
  - **집중 모니터링(`focus/run.js`)**: 별도 타이머 · 별도 표(`focus_session` · `focus_sample` — 메인 bm-usage.db · 30일 · 폴러 정리 틱이 청크로) · 기본 10분 × 1분(간격 하한 30초 · 길이 상한 60분) ·
    1분 = **주기 수집과 같은 함수**(`collectOsUsage` + `extraCommands` 로 같은 SSH 세션에서 경량 스냅샷 `FOCUS_SNAPSHOT_COMMAND` — 상수 · ps 상위 5 · /proc/pid/io 2초 차이 · ss -s) + Redfish 1회(`idracTelemetryJob` 재사용) →
    `buildUsage` · `buildPerfEntry`(판정 코어 하나). 세션 시한 `withDeadline` 50초 > 예산 45초(시한이 세션을 끊는다).
    ⚠⚠ **법인당 동시 상한(기본 5)은 실행 중 + 시작 중(예약)을 동기적으로 세고 예약**한다(검사와 예약 사이 await 없음 — 4단계 스냅샷 R2 와 같은 판단) · 넘치면 법인별 대기열(순번) · 서버당 1세션.
    ⚠⚠ **인증 거부는 그 분에서 즉시 중단**(다음 분을 예약하지 않는다) — OS · iDRAC 결과를 **주기 수집과 같은 가드 · 같은 식별자**에 기록(실패는 주기 수집도 멈추고 성공은 푼다 — Focus 테스트 ③가 실제 poller 가드로 확인).
    자동 · 수동 모두 정지 계정이면 시작하지 않는다(반증 F11 — 아래). 결측 분은 **비우고** OS · iDRAC 를 따로 센다(경로가 없는 쪽은 요약 null — 화면 ‘경로 없음’).
    ⚠ **전역 슬롯(`slots.js`)**: 주기 수집 풀과 집중이 같은 용량(단일 원천 = poller `CONCURRENCY` → `configureSlots`)을 나눠 쓰고 집중은 **앞자리 대기** · 대기 상한(간격 × 0.75 · 5~45초)을 넘기면 그 분 결측 `pool-busy`.
    피크 창 주기 예산(peakPlan)에는 **활성 집중 수를 뺀 동시성**을 준다. 재시작이면 남은 진행 중 · 대기 세션은 `interrupted` 로 닫는다(타이머가 없다).
    ⚠ **순환 금지(arch2579 SCC 상한 4)**: focus/run 은 poller 를 import 하지 않는다 — 폴러가 로드될 때 `registerFocusPollerHooks` 로 넘긴다(미등록이면 인증 정지 조회는 ‘정지’ 로 답한다 — 계정 잠금 쪽으로 틀리지 않게).
    요약은 `focus/summary.js`(데모 시드가 import) · 사유 정제는 `snapshot/reason.js`(focus 가 snapshot/run 을 import 하면 snapshot/run → poller → focus 순환).
    원인 후보는 **상관**(스냅샷이 있는 분 중 I/O · CPU 1위 횟수 — 문제 자원이 디스크 · 네트워크면 I/O 먼저) · 조치는 code(웹이 문장).
  - **알림 규칙(`perfRules.js` 파일 `bm-perf-rules.json` · `perfAlerts.js`)**: 규칙 6종(USE 판정 변화 · 교차 판정 · 집중 결론 · 베이스라인 이탈 · 점검 소모품 · 용도 점검 실패) — **조건은 수집 노드가 판정한 code 의 변화만**(null 은 보류) ·
    지속 n주기 · 한 사건에 한 번 · 재발 억제(분) · **켠 규칙만 저장** · 하루 상한(법인당 알림 50 · 이슈 20 · 자동 집중 10). 채널은 **기존 알림 채널 설정의 사본**(메일 · 웹훅 · Slack · Teams — 새 채널 설정 없음) ·
    이슈는 **기존 문지기**(`alertIssues` — 출처 `bmperf` · 같은 발송 건 두 번 안 만듦 · 열린 이슈면 댓글). 엣지의 발송 기록은 봉투(`perfAlertSent` 24시간)로 올라가고 이슈는 **중앙이 끌어올 때** 만든다.
    상태 파일 `bm-perf-alert-state.json`(원자 쓰기 · 재시작 뒤 재발송 없음) — **손상이면 보존본을 남기고 warmup**(그 주기는 기준만 · 보내지 않음). 규칙 파일 손상은 기본값(전부 꺼짐)으로 돌되
    주기 상태에 `skipped: 'settings-unreadable'` 로 남기고 규칙 화면 · 서비스 점검(audit2633 20개)이 밝힌다. 유지보수 창 억제는 **원천이 없다**(`maintenanceFor` 는 늘 suppressed:false · source 'none' — 베어메탈 서버의 백업 창을 읽는 스케줄이 없다).
  - **베이스라인(`baseline.js`)**: 지난 4주 같은 요일 · 같은 시각(정확히 7일 배수)의 1시간 롤업 평균 ±40% · 표본 4주 미만 · 결측 25% 초과면 띠 없음(reason) · ML 없음.
    주기 판정용 슬롯 평균은 시간당 한 번(`slotBands` — h IN 질의 1회) · 화면용 띠 계열은 시간 기준 양보(`createYielder`) · 10분 메모 · 최대 14일 · 지표 화이트리스트 5개.
  - **구간 비교(`compare.js`)**: 같은 길이(짧은 쪽) · 같은(거친) 해상도 · **결측은 양쪽에서 뺀다** · 차이 %(A=0 이면 null) · ±20% 표시 · 프로세스 상위 차이는 스냅샷이 있는 구간만 · 튜닝 값 차이는 그 사이 변경 이벤트.
  - ⚠ **정직 기록**: 1분 간격 SSH 의 실장비 부하는 측정하지 못했다 — 이 컨테이너(sshd 없음)에서 명령 실행분만 쟀다: 주 명령 158~239ms + 경량 스냅샷 2.03초(/proc/pid/io 2초 간격) + 피크 창(설정 상한 10초 — 같은 세션) ≈ 분당 약 12초 +
    SSH 연결 · Redfish 1회(미측정 — 800ms RTT 법인은 연결만 수 초 추정). chronyc -c · needs-restarting -r · dnf history 의 Rocky 9 실출력 형식은 미확인(파서는 형식 밖 줄을 버린다 — 칸이 비면 ‘확인 불가’).
    데모 백필(30분 간격 · 14일)에는 디스크 지표 · 4주 이력이 없어 화면 판독의 띠는 서버 `bandOf` 결과를 응답에 끼워 확인했다.
  - ⚠⚠ **반증(review-s5) 반영 — 되돌리지 말 것**(회귀 `bmPerf2929{Alerts,Focus,Changes,Health,Poller,Gates}` · `bmPerfMinEdgeVersion2929` · 웹 `bmPerfOpsText.test.jsx` · 변이 검증):
    · **F1 알림 상태는 한 직렬 큐**(`perfAlerts.withState` — 읽기-수정-쓰기 한 단위 · 같은 _state 를 고친다): 주기 판정과 집중 결론이 각자 `load → await → save` 하면 늦게 끝난 쪽이 덮어 같은 사건을 다시 보내거나 발송 기록을 잃었다.
    · **F6 발송은 주기 밖**: 주기는 판정 · 큐잉만(`alerts.enqueueNotify` — 채널별 레인 · 상한) · 주기당 상한 = 기존 `MAX_SEND`(bmusage/notify.js — 넘친 건은 상태를 되돌려 다음 주기 · deferred) ·
      결과는 `deliveryOutcome` 으로(전 채널 실패 = `failed` — ‘보냄’ 아님) · 실패면 기존 `retryDelayMs`(5분 · 15분 두 번)로 규칙 상태에 retryAt — 사건이 이어지는 동안 그때 다시 보낸다.
    · **F5 못 읽음은 보류**: 규칙 상태에 ‘참이던 칸(on)’ 을 두고 그 칸을 이번에 못 읽으면 조건 null(사건 유지 — 해소 · 재발송 없음) · `healthSince` 는 missing · perm 을 통과(직전 읽은 code = hold · since 유지) ·
      변경 이벤트는 읽은 code 끼리만(missing 전이 없음).
    · **F4 법인 상한 경쟁**: finish 가 `_active` 해제와 **같은 동기 구간에서** 대기열(전 법인 공통 들어온 순서 · 법인 상한 · 노드 상한)을 꺼내 예약 · 그 법인 대기열이 비어 있지 않으면 새 시작도 대기열 뒤로(앞지르기 금지) ·
      끝 구독자(결론 알림)는 기다리지 않는다(L4 — 엣지 대행 중지가 메일 시한만큼 늦게 답하던 것).
    · **F11** 수동도 인증 정지 계정이면 거부 + 법인당 하루 수동 상한(`daily.manualFocus` 20) · **L11** 노드 전체 동시 상한(`focus.nodeMax` 10) · **L8** 길이 상한은 벽시계로도(`summary.wallCapped`).
    · **F13** 기동 때 `initFocus()`(폴러 시작) + 봉투 요약도 초기화 먼저 — 재시작 직후 죽은 세션을 ‘진행 중’ 으로 싣지 않는다. **F14** OS 경로가 없는 세션의 표본 missOs 는 null(‘경로 없음’ 은 결측이 아니다).
    · **L1 needs-restarting**: 종료 코드 대신 출력 표지(LC_ALL=C ‘Reboot is required’ / ‘should not be necessary’ · 못 가르면 `nr=x` = 확인 불가) · 방금 부팅 · rpmdb 최근 변경 · 하루 네 번 10분 창(03 · 09 · 15 · 21시)에만 실행 ·
      그 밖은 `nr=skip` → cycleOps 가 직전 읽은 값을 이어 쓴다(없으면 확인 불가). ⚠ 주기가 10분보다 길면 창을 놓칠 수 있다 — 그때는 부팅 · 패키지 변화 때만 읽는다(정직 기록).
    · **L5** 대상이 일부만 해석된 주기(sourceErrors)의 목록으로는 change_latest 를 지우지 않는다 · **L6** 인벤토리에서 빠진 펌웨어 부품은 못 읽음(직전 버전 유지 — ‘없음’ 이벤트 없음) · **L3** 띠 밖 판정은 서버(`baseline.outsideOf` → 응답 `outside`).
    · 기록만(고치지 않음): **L2** 베이스라인 ‘같은 요일 · 시각’ 은 UTC 7일 배수 — 서머타임 법인(폴란드 · 미국 동부)은 전환 뒤 4주 동안 업무 시각이 1시간 어긋난 띠와 비교된다(법인 시간대 원천 없음) · 띠에 절대 하한이 없어 평균 2% 서버는 3% 에서도 ‘이탈’ ·
      **L7** FD 칸은 시스템 전체 file-nr 대비 — fs.file-max 가 매우 큰 배포판에서는 늘 0%(실제 한계는 프로세스 nofile · 실장비 미확인) · **L9** 엣지 위임 서버의 집중 탭 머리 ‘10분 × 1분(설정)’ 은 중앙 규칙으로 보인다(실제 세션은 그 엣지 규칙 — 세션 칸의 간격 · 횟수가 진실) ·
      **L10** 구간 비교 5분 해상도에서 수집 주기가 1분이면 한 칸에 5표본이 떨어져 마지막 1개만 남는다(Map.set).
- ⚠⚠ **리눅스 성능 6단계(서버 + 화면 — 버전 미정) — 비교 · 수집 건강 · 주석 · 공유 · 플레이북 · 목표선. 새 수집 · 새 SSH 구획 없음(이미 가진 값의 묶음 · 대조), 판정은 서버 코어 하나 · 결측은 개수로**
  (`bmusage/{multiCompare,compareSets,collectHealth,missReason,annotations,playbooks,slo}.js` · `slots.js`(슬롯 최대) · `poller.js`(주기 계측 · `collect_cycle` 표) · `perfRules.js`(규칙 `collect`) ·
  `routes/api/{bmCompare,bmCollectHealth,bmAnnotations,bmPlaybookSlo}.js` · `routes/collector.js`(`/bm-usage/compare-series`) · `central/{bmComparePull,bmCollectHealthSanitize,featureMinEdgeVersion}.js`.
  설계 PROFILES §16 · README §8. 회귀 `server/test/bmPerfStage6{Compare,Health,Annot,PlaybookSlo,MinEdgeVersion}.test.js` · 웹 `bmStage6Text.test.jsx`):
  - **서버 비교(`multiCompare.js` · `GET /tools/bm-usage/compare`)**: 2~5대(설정 `compare.maxServers` 2~8 — 화면은 API 값) · 지표 묶음 4(6대 사용률 · USE · 큐 · 하드웨어) · 창 1시간/24시간/7일(상한 14일).
    **기본은 같은 법인만** — 첫 서버의 법인이 기준이고 다른 법인 서버는 `other-corp` 열(값을 당기지 않는다) · ‘법인 간 허용’(`cross=1`)은 **전체 범위 계정만**(범위 계정이 보내면 404 — 기능 은닉).
    범위 밖 · 없는 서버는 둘 다 `none`(존재 은닉 — 어느 쪽인지 말하지 않는다). 열마다 읽은 시각(`readAt` · 엣지는 보관 시각 `snapAt`)과 상태(ok · stale · old-version · no-sample)를 따로 밝힌다.
    통계(`seriesStats`)는 평균 · 피크 · 마지막 · **n · expected · missing**(결측을 0 으로 채우지 않는다) · 스파크(칸 = min(96, 기대 칸, 점 수)) — 칸이 점보다 많으면 점이 흩어진다(r1 판독 결함 · 고침).
    편차 표(`buildCompareTable`)는 묶음 평균 대비 ×2 이상을 `devHigh`, 3대 이상에서 한 대만 ×2 넘게 벗어나면 `skew` · 축 상한은 `niceCeil`(지표별 scaleMax 를 넘는 값은 `clipped`).
    판정(USE 칸 · 교차)은 **상세와 같은 코어**(`buildPerfEntry` · 데모면 `demoPerfRows` 겹침 공용 — 비교와 상세가 갈리지 않게).
  - **5대 동시 집중(`POST /compare/focus`)**: 키를 **전부 먼저 해석**(하나라도 없거나 범위 밖이면 404 — 아무것도 시작하지 않는다) → 쓰기 범위 하나라도 밖이면 403(전부 거부) → 그 뒤 서버마다 5단계 `focusStartResolved`
    (같은 법인 상한 · 서버당 1세션 · 사유 필수 · 감사 `bm-perf.focus` origin `compare` · 자동 주석). 결과는 서버별(상한 · 중복은 그 서버만 실패).
  - **저장된 세트(`compareSets.js` 파일 `bm-perf-compare-sets.json`)**: 사용자별 20개 · 이름 · 키 목록 · 법인 간 여부 — 원자 쓰기 · 손상 보존 · 손상이면 503(빈 목록으로 덮지 않는다) · 쓰기는 **동기 RMW**(await 없음 — 동시 10건 테스트) · 쓰기 운영자 이상.
  - **수집 건강(`collectHealth.js` · 폴러 계측)**: 매 주기 노드 값(주기 소요 / 예산 · 성공률 · 실패 사유 9종(`missReason.js` — 집중과 같은 코어 · 인증 정지는 `auth-stopped`) · 동시성 최대(`slots.js` `_peak`) ·
    SSH 소요 p50/p95(SSH 를 연 서버만) · 집중 진행/대기 · DB 크기 **파일 실측**(`dbFilesNow` — 폴더를 못 읽으면 null · 크기를 못 읽은 파일이 있으면 합을 내지 않고 `unread` 를 센다)).
    ‘리포트 없음(라이선스) · 첫 주기 · PSI 없음’ 은 **실패가 아니다**(info 로 따로) · 대상 0대 주기는 성공률 null(0% · 100% 아님) · ‘며칠째’ 는 이어지는 동안 유지(프로세스 재시작이면 다시 센다).
    주기 기록은 메인 DB `collect_cycle`(노드 · 시각 PK · 30일 · 정리 틱 청크) — 분류 실패 · 대상 0 · 예외 주기도 기록(무음 실패 금지). 기준 대조 `collectCells` 하나(값 없으면 `unread` 보류)를 보드와 알림 규칙이 같이 쓴다.
  - **알림 규칙 ‘수집 건강’(`collect` — 기본 꺼짐 · 자동 집중 없음)**: 서버가 아니라 **노드 한 칸**(`key:'__node__'` · 이름 ‘수집 노드 <agent>’ · 법인 없음) — 조건 any · cycle · success · db · auth.
  - **운영 주석(`annotations.js` 파일 `bm-perf-annotations.json`)**: 종류 5(작업 · 변경 · 외부 · 장애 · 메모) · 본문 500자 · 연결(ISS-n · 위키 · 집중 id · 백업) · 시각(지난 400일 ~ 앞 7일 · 구간 31일) · 전체 5,000(넘치면 지운 것부터 재사용 · 없으면 409).
    중앙 한 곳 저장(엣지 서버도 중앙에 — 법인 귀속은 대상 해석의 vcenterId) · 원자 쓰기 · 손상 503 · 동기 RMW(동시 20건 테스트) · 고침 이력 20 · **삭제는 흔적**(본문 · 연결을 비우고 누가 · 언제를 남긴다).
    집중 세션 시작은 자동 주석(`by:'system'` · auto `focus` — 사람이 고치거나 지울 수 없다). 엣지 자동 집중(알림 규칙)은 자동 주석을 만들지 않는다(중앙이 시작을 모른다).
  - **진단 플레이북(`playbooks.js` 한 파일)**: 12편 · 판정 id 46개 전부가 적어도 한 편에 걸린다(테스트가 `allJudgmentIds()` 와 대조) · 단계 종류 5(포탈 · 명령 · 설정 · 하드웨어 · 조치) · 방법론 출처 태그(NF · USE · SRE · DELL).
    ⚠⚠ **명령은 복사용 글자이고 포탈은 실행하지 않는다**(`executes:false` · 실행 경로 없음) — 그래도 **검토된 읽기 전용 목록(`READONLY_COMMANDS` · 정확 일치)** 에 있는 줄만 싣는다(반증 F6 정정:
    예전의 ‘도구 화이트리스트 + 금지 인자’ 판정은 `dnf history undo` · `ss -K` · `sort -o` · `awk system()` · 이스케이프 따옴표 주석 우회 등 16+1건을 통과시켰다).
    목록에 더하는 줄은 `lintCommand`(도구별 **허용 인자** · 원문 전체에 셸 금지 문자 · 백슬래시 금지 · 따옴표를 아는 주석 자르기)를 통과해야 한다 — 검토 보조. 카탈로그는 런타임에도 거른다. 자리표시 채우기(`fillOf` — 장치 · 인터페이스 · 마운트)는 **서버가 값 화이트리스트로 거른 것만**(셸 의미 문자 · `..` 금지).
  - **목표선(`slo.js` 파일 `bm-perf-slo.json`)**: 지표 12 · 기준 3(5분 평균 · 5분 피크 · 기간 p95) · 연산 4 · 우선순위 **개별 서버 > 용도(airflow · gpdb — 4단계 감지) > 역할(기본)** · 범위당 12 · 서버 500.
    달성률 = 목표 안 주기 ÷ **값이 있는 주기**(결측 주기는 분모에서 빼고 `missing` 으로 센다 · 값이 하나도 없으면 `no-data` — 0% 아님 · 위반 수 · 위반 시간도 null) · 연속 위반은 결측 칸에서 끊는다 · 최장 위반 · 일별 · 위반 띠.
    해상도는 창 20일 이하 5분 · 그 위 1시간 · 이번 달 = 법인 하루 경계(`DAY_OFFSET_MIN`) 기준. 계열은 3a 추이(이 노드 `trendFor` · 엣지 `pullBmTrend` — 지표마다 1회 · 동시 2).
    정비 창은 원천이 없어 분모에서 빼지 못한다(`maintenance:{source:'none', excluded:0}` · 화면이 말한다 — 8단계). 저장은 관리자 + 설정 소유자 + 감사 `bm-perf.slo` · 손상이면 보존하고 기본 목표로 계산(그 사실을 응답이 말한다).
  - ⚠⚠ **반증 review-s6 반영 — 되돌리지 말 것**(회귀 `bmPerfStage6{Health,PlaybookSlo,Compare,Annot}` · `bmEdgeRoundTrip` · 웹 `bmStage6Text` · 변이 검증):
    · **F1 주기 실패는 ‘정상 · 대상 0’ 이 아니다**: 분류 실패 · 주기 예외 · 계산 실패(`CYCLE_ERRORS`)면 노드 대상 · 성공 수는 null · 상태 `cycle-failed` · 법인 행 대상 null(모름 — KPI 모름 개수) ·
      기준 칸 `error`(‘수집 건강’ 규칙 조건 ‘주기 실패’) · 실패 · 0대 경로에서도 ‘수집 건강’ 규칙만 돈다(`runNodeCollectAlert` — 다른 규칙의 서버 상태는 CARRY_MS 동안 그대로). ‘대상 없음’ 은 사실 0.
    · **F4 · F5 결측**: 법인 행 성공률은 성공 수를 모르면 null(0% 아님) · DB 폴더를 못 읽으면 가족별 값도 null(화면 ‘—’), 일부 파일을 못 읽으면 `partial`(화면 ‘부분’).
    · **F7 피크는 피크 표본만**: 목표선 ‘피크’ 기준과 비교의 피크 칸 · 스파크 피크 · 마지막 피크는 `p.peak` 만(없는 주기를 평균 · 칸 최대로 메우지 않는다 — 목표는 결측 + `peakMissing`) ·
      피크 열이 없는 지표(`SLO_PEAK_METRICS` 밖)에 피크 기준 저장은 400 · 비교 ‘평균+피크’ 는 값 있는 서버가 **모두** 피크를 가질 때만 피크로, 아니면 모두 평균으로 대 본다(`row.basis` — 다른 양을 섞지 않는다).
    · **F8 범위 계정의 노드 상태**: 노드 값을 숨기면(nodeHidden) 노드 상태도 노드 값으로 정하지 않는다(`hidden` — 노드 값과 무관한 사실 off · 주기 없음 · 버전 · 오래됨 · 주기 실패만 그대로) ·
      법인 행 상태 · 칸은 **그 법인 값으로** 같은 판정 코어(`collectCells`)에 대 본다(성공률 · 인증 사유 · 주기 실패 — 주기 소요 · DB 는 노드 전체 값이라 대지 않음).
    · **F12 주기 길이**: 위반 시간 · 기대 주기 수 · 비교 결측은 추이 칸(≥5분)이 아니라 수집 간격으로 센다(이 노드 = 설정 간격 · 엣지 위임 = 점 간격 중앙값 · 롤업 = 칸).
    · **F13 · F9 요청 경로**: 운영 주석 저장소는 mtime · 크기 캐시(읽기는 공유 배열 — 사본 없음 · 쓰기 도중 실패면 캐시를 버린다 · 이력 이전 내용 120자 · 파일 32MB 상한 409) ·
      목표 설정 조회는 대상 · 엣지 보관분을 요청당 한 번 읽어 O(N) 으로 대 본다(서버 목표 500건에 대상 해석 500번 → 1번).
  - ⚠ **정직 기록**: 샘플러(옵션 B)의 서버 부담은 계측하지 않는다 · 수집 건강 ‘며칠째’ 는 프로세스 시작 뒤부터 · 비교 · 목표선 계열은 3a 파일 그대로라 데모 백필(30분 간격)에서는 5분 칸 대부분이 결측으로 보인다(그대로 센다) ·
    월간 목표 리포트(메일)는 만들지 않았다.
- ⚠⚠ **리눅스 성능 7a단계(서버 + 화면 — 버전 미정) — 로그 분석(성능 · 보안 · 이슈 · 장애). 엣지가 읽고 분류 · 집계 · 가림까지 하고, 원문 전체는 저장 · 전송하지 않는다. 못 읽음 · 권한 없음 · 잘림은 0 이 아니라 출처 상태다**
  (`bmusage/logs/{rules,command,parse,classify,store,run,view}.js` · `poller.js`(주기 배선) · `perfRules.js`(설정 `logs` · 규칙 `logs`) · `perfAlerts.js`(조건) · `edgelog/redact.js`(`redactSystemLogLine`) ·
  `mock/demo/bmLogs.js`. 설계 PROFILES §17 · README §8. 회귀 `server/test/bmLogs7a{Command,Parse,Rules,Store,Route,RoundTrip}.test.js` · 웹 `bmLogsText.test.jsx`):
  - **읽기 = 같은 SSH 세션(로그인 1회)의 별도 exec**(`osSsh extraCommands` 이름 `logs` — 주 명령 · 피크 창 뒤 남은 예산 안에서만 · 모자라면 `skipped`). 주 명령에 섞지 않은 이유: 주 명령의 전체 바이트 상한과
    ‘##END 미도착 = 마지막 구획 버림’(1단계 D1)이 로그 수천 줄 때문에 다섯 지표 구획을 밀어내면 안 된다(설계와 다른 결정 — 이름은 그대로 `##JOURNAL · ##DMESG · ##SECURE` + `##JSEC · ##AUDIT · ##APPLOG`).
  - **증분**: journald 는 `-o json`(한 줄 = 한 항목) · `-p warning` · `_TRANSPORT=journal|syslog|stdout`(커널 메시지는 dmesg 가 읽는다 — 두 번 세지 않게) · **항목마다 커서**(awk 가 본 마지막 항목의 `__CURSOR` —
    상한 · 바이트 상한 · `timeout 15`(rc 124 = ‘부분’)에서도 본 데까지 넘어가 같은 줄을 다시 세지 않는다 · 7a 반증 F5) · 커서가 없으면 최근 60분. **`-q` 를 쓰지 않는다**(systemd v239 · v252
    `journal_access_check_and_warn` 원문 — `-q` 면 ‘Hint: … not seeing messages from other users and the system’ 이 꺼진다 · 반증 F2): 힌트 = `perm/own`(자기 저널만 — 세지 않고 위치만) ·
    ‘No journal files were opened due to insufficient permissions’ = `perm/none` · ‘No journal files were found’ = `absent/nofiles` · 수집 계정 uid · 소속(systemd-journal · adm · wheel)을 메타로(화면 권한 안내).
    dmesg `-x` 는 **boot_id + 마지막 [초]**(`--time-format` 에 기대지 않는다 · 재부팅이면 링 버퍼 처음부터) · **첫 읽기는 가동 마지막 60분만**(그 앞은 `older` 로 세기만 — 옛 부팅 줄을 ‘지금’ 사건으로 세지 않는다 · 반증 F6 ·
    uptime 을 모르면 위치만). 파일(secure · audit · 용도 로그)은 **offset + inode**(첫 읽기 = 끝 256KB 안의 마지막 200줄 — 큰 파일을 처음부터 두 번 읽지 않는다: 1GB 실측 1,712 → 60ms ·
    inode 가 바뀌면 같은 폴더에서 옛 inode 의 꼬리부터 — 못 찾으면 `lost` · 크기가 줄면 copytruncate 로 처음부터 · 증분이 64MB 를 넘으면 앞을 건너뛰고 `skippedBytes` · **끝 줄이 미완성(개행 없음)이면
    그 조각은 다음 주기로**(`partial` 바이트 — 반증 F14)). 출처마다 주기당 줄 상한(`logs.lineCap` 기본 5,000 · **100~9,000** — 앱 둘이 한 구획이라 2 × 상한 + 메타 < 구획 줄 상한 20,000)과
    **출처 바이트 상한**(`SRC_BYTES` = (전체 상한 − 메타 여유) / 출처 수 — 한 출처가 다른 구획을 밀어내 영구히 ‘못 받음’ 이 되던 결함 · 반증 F4 · 산수를 테스트가 고정) — 넘친 줄은 ‘잘림’ 으로 세고 **위치는 본 데까지 넘긴다**.
    시각은 지어내지 않는다(`parse.js dateOf`): 30일보다 오래됨 · 시각 없음 = `ts null`(분류 · 시간 칸 · 알림에서 빼고 `#undated:<출처>` 로만) · 하루 안쪽 미래(서버 시계가 빠름) = 받은 시각 + `skew`.
  - **권한 없음의 범위**(반증 F3): 파일이 ‘없어 보이는데’ 상위 폴더가 있고 들어갈 수 없으면 `perm/dir`(0700 `/var/log/audit` — 예전엔 ‘없음’) · 파일만 못 읽으면 `perm/file` · 용도 로그는 후보 경로에서
    **앱 뿌리(anchor)까지만** 올라가 본다(`/root` · `/home` 같은 공용 상위가 막힌 것은 그 앱의 권한 문제가 아니라 ‘없음’). 포탈은 권한을 바꾸지 않는다 — 화면이 필요한 권한을 안내한다.
  - **보안 출처 하나**(반증 F1): sshd 성공 · 실패는 journald 우선순위 info 라 주 읽기(warning)에 안 들어온다 → 별도 구획 `##JSEC`(`-p info SYSLOG_IDENTIFIER=sshd|sshd-session|sudo|su|login|계정 도구` · 자기 커서 ·
    자기 상한 · 원문 보관 없음). 한 주기에 보안 줄은 **한 출처만** 센다(`pickAuthSource`): `/var/log/secure`(읽음 · rsyslog 가 돌거나 모름 — 설계 §17 이 이름을 댄 출처 · authpriv 전체) → JSEC(읽음 —
    자기 저널만은 읽음이 아님) → auditd(인증 실패 · 계정 변경). 고르지 않은 JSEC 줄은 `dup` 으로 세고 빼며, auditd 의 같은 사건은 패턴만 남기고 보안 상위에 넣지 않는다 · 주 저널의 같은 식별자 줄은 `authSkipped`.
    보안 합계는 **그 종류를 담는 출처를 그 기간에 읽었을 때만 0**(`view.js SEC_CARRIERS` — 실패 · 계정 변경 = secure|jsec|audit · 성공 · root · sudo = secure|jsec · AVC = audit) — 아니면 null + 이유(`totalsWhy`).
  - **분류별 담는 출처**(7a 반증 뒤 추가 수정 — ‘못 읽은 값은 0 이 아니다’): `rules.js CLASS_CARRIERS` 는 규칙 카탈로그에서 **기계적으로** 뽑는다(태그 규칙 = 태그 · 태그 없는 규칙 = `srcs` —
    매칭에는 쓰지 않는다 · 테스트가 합집합을 대조). 판정 코어 `classCover(분류, 읽은 출처, 마지막 상태)` 하나: 담는 출처를 하나도 못 읽음 = `none`(값 null · 이유 = 못 읽은 출처) ·
    일부 = `partial`(값은 내고 ‘일부 출처만’) · 전부 = `all`. 서버에 없는 출처(absent · nofile)는 못 읽음이 아니고, secure 와 journald 보안은 서로 대신한다.
    쓰는 곳 전부: 상세 KPI 4 · 시간 칸(그 시간 읽은 출처로 분류마다 null) · 함대 요약 · 봉투 · 함대 표 칸 · 함대 KPI(`kpi.unknown` · `kpi.partial` 서버 수) · 알림 입력(`cover` — none 이면 보류, 해소로 보지 않는다).
  - **구획 위조 방지**: 모든 내용 줄에 고정 접두(`J| Q| K| S| A| G| F|`) · 메타 `X#k=v` · journalctl 자기 줄은 글자 없이 표지(`J#err`) — 로그 줄 ‘##END’ · ‘J#cur=…’ 가 구획 · 커서를 바꾸지 못한다(실제 셸 테스트).
    **명령 조립 값**(커서 · boot_id · 초 · inode · offset)은 화이트리스트 정규식(`CURSOR_RE` 등)을 지난 것만 — 아니면 첫 읽기 꼴. 용도 로그 경로는 **상수 카탈로그만**(`APP_LOGS` — `_paths` 는 테스트 전용, 소스 스윕).
  - **분류**: 규칙 = 파일 하나(`rules.js` — 정규식 · 분류 4 · 심각도(엔진 SEVERITY_RANK) · 출처 태그 · 표본 1줄 · 근거 번호 · 등급 · 연계 표지). 엔진은 `loganalysis` 의 `normalizeRules` · `indexRules`(태그 규칙 → 태그 없는 규칙,
    처음 맞는 하나) · `templateOf` · `safeKey` 재사용. **모든 규칙은 표본으로 자기 시험**(엔진에 넣어 그 규칙이 잡는지). SEC-LOGIN-FAIL 은 `logs/loginFailPattern.js MSG_RE` **같은 객체**.
    SSH 실패 집중(`SEC-SSH-FAIL-BURST` high)은 파생 규칙 — 같은 IP 가 창(분) 안 임계 이상이면 그 줄을 옮긴다(두 번 세지 않음) · 주기 경계는 IP 별 최근 실패 시각 carry(IP 64 · IP 당 임계 개수).
    분류 못 한 줄은 **세기만**(출처 · 시간별 `#none:<출처>` — 템플릿 · 원문 없음). 서명 = 출처 · 규칙 · (보안 꼴 치환 → 같은 줄 계정 · 주소 값 치환 → **표본과 같은 가림** `redactSystemLogLine` → 경로 → `templateOf`)의
    SHA-1 16자(반증 F7 — 서명이 가림을 건너뛰어 계정 · 메일 · 토큰이 나갔다 · 보관된 서명도 읽을 때 `maskStoredTmpl` 로 다시).
    OpenSSH 실제 꼴(반증 F8 — 고정 표본 테스트): 연결 식별 꼴 ‘(invalid|authenticating) user 계정 주소 port N’ 에서 계정 · 주소를 뽑고 주소 꼴이 아니면 버린다(예전 ‘invalid’ 가 IP) ·
    같은 시도의 뒤 줄(`SEC-SSH-PREAUTH` 연결 종료 · `SEC-SSH-MAXAUTH` 최대 시도 · PAM 요약 · `SEC-PAM-DUP` sshd/su/sudo 의 pam_unix · `SEC-AUDIT-LOGIN-FAIL`)은 실패로 다시 세지 않는다 ·
    GPDB 로그인 실패(28P01 · pg_hba 거부 · 없는 role)는 `APP-GP-AUTH-FAIL`(보안 — 반증 F11).
  - **보관(메인 `bm-usage.db`)**: `log_cursor`(읽기 위치 + carry + 마지막 상태 — **rev 비교 후 쓰기**: 같은 rev 를 읽은 늦은 주기는 그 서버를 통째로 건너뛴다 · 손상 상태는 `bad_json` 에 보존하고 처음 읽기) ·
    `log_pattern`(서명별 누적 · 가린 표본 최대 5 · 서버당 500 — 넘으면 분류별 `#over:<분류>` 한 행 · **심각도 높은 것부터 쓰고 high · critical 은 여유 100 까지 접지 않는다** · 묶음 행 심각도는 묶인 것 중 최고 — 반증 F8) · `log_hour`(시간 × 서명 — `#read:` · `#trunc:` · `#none:` 포함) · `log_sec`(시간 × 종류 × 항목 — 상위 20 + ‘(기타)’).
    한 주기 서버 전부를 **한 트랜잭션 · 한 직렬 큐** · 정리는 `pruneTick` 같은 틱 청크 DELETE(보관 `logs.keepDays` 기본 30 · 대상에서 사라진 서버의 위치도) · 쓰기가 실패하면 위치가 넘어가지 않는다.
  - **요약**: 주기 끝에 서버별 24시간 요약을 **메모리**에(`refreshLogSummary` — 봉투 · 함대 표가 요청마다 SQL 을 돌리지 않는다). 질의는 **서버 키마다 PK 앞부분 (agent, key, hour ≥ 창)** 범위만 읽고
    합 · 마지막 시각은 JS 에서 · 서버 · 행 사이 시간 기준 양보(예전 한 문장 `GROUP BY` 는 보관 전체를 훑었다 — 실측 최장 정지 200대 30일 426 → 21ms · 1,000대 7일 756 → 25ms, 총 소요는 1,000대 약 0.7초로 비슷). 공통 원인 후보(`commonCauseCandidates`)는 같은 규칙(medium 이상)이
    여러 서버에서 마지막 발생이 서로 1시간(`COMMON_WINDOW_MS`) 안 — ‘후보’ 일 뿐(화면이 말한다).
  - **알림 규칙 ‘로그 — 장애/보안 high’(`logs` — 기본 꺼짐)**: 입력은 **이번 주기에 로그를 읽고 쓴 서버만**(못 읽음 = 보류 null · 비교 후 쓰기에서 진 서버는 뺀다) · **최근 60분 안의 줄만**(첫 읽기의 지난 줄 · 시각 모름은 기록만) · 조건 fault-sec · fault · sec(장애 분류 줄 · 보안 high 이상 줄 — 집중 포함) · 자동 집중 허용.
    포탈은 차단 · 계정 잠금을 하지 않는다. 설정 `logs.on`(기본 켬 — 끄면 exec 를 붙이지 않는다) · 노드 전용 파일(`bm-perf-rules.json` — 배포 서명과 무관).
  - **데모**: 데모 대상은 SSH 를 열지 않고 명령 출력 꼴의 합성 텍스트(`demoLogStdout`)를 **같은 파서 · 분류 · 쓰기**에 넣는다(첫 주기 24시간 · 그 뒤 직전 읽기부터 · 값 · IP 는 가상 — RFC 5737 대역).
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
- ⚠⚠ **v2.728 — 엣지 축약 인벤토리는 부품 이름·health·state 를 싣고, 중앙 `INV_SHAPE` 와 한 쌍으로 넓힌다**(사용자 신고 iDRAC 상세 하드웨어 탭 PSU·디스크 '—' ·
  NIC 1-1~1-4 중복·전부 ⛔. `collector/compactInv.js`(의존 없는 모듈 — `agent.js` 는 재수출) + `collector/remoteInventory.js INV_SHAPE` + `idrac/nicPorts.js`·`invView.js`.
  회귀 `server/test/idracInv2728.test.js`·`compactInv.test.js` + 웹 `views/idrac/hwStatusText.test.js` — 변이 16/16):
  · 엣지만 고치면 중앙 정제가 버린다 — **새 필드는 두 곳에 함께 넣을 것**(v2.611 CEN2611-01 와 같은 유형). 구버전 엣지 판정은 값이 아니라 **키 유무**
    (`invView.statusFieldsMissing`) — 새 엣지는 빈 health('') 를 보낸다. 일련번호·부품번호·펌웨어는 여전히 싣지 않는다(500대 export 원본 4.1MB → 5.4MB 실측).
  · **NIC 포트는 Id 로 중복을 걸러낸다**(`nicPorts.dedupNicPorts` — fetchInventory 는 NetworkPorts·Ports 두 경로를 모으고 URL 로만 걸러 iDRAC 7.x 에서 2배가 됐다 —
    가짜 Redfish 재현, 실장비 응답은 미확인 추정). 링크 판정은 `nicLinkState` 하나 — `Status.State 'Enabled'`·빈 값은 unknown(회색 '?')이다. ⛔ 로 칠하지 말 것.
  · **서버 부품 요약(`idrac/serverParts.js`)은 표시 전용**이다 — 판정은 `partfault/extract/idrac.js` 를 그대로 쓰고 **partfault DB·전이·알림에 쓰지 않는다**(중앙이 위임 장비를
    판정하면 같은 부품이 두 번 열린다 — v2.548). 목록 `GET /admin/idrac` 은 `?parts=1` 일 때만 싣는다(V4·관제 콘솔 60초 폴링에는 없다) · 범위로 자른 뒤에만 · 15ms 양보.
    상세의 '파트 장애' 칸은 DB 파일이 없으면 열지도 만들지도 않는다(`partFaultDbExists`). 인벤토리 없음·불통·Systems 실패·구버전 엣지는 판정 불가(0건이라 말하지 않는다).
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
  - **v2.666 — 법인별 표의 둘째 열은 '물리 서버(iDRAC)'(= `byVcenter`, ESXi 겸용 포함)이고 '서버·게스트 수량' 카드 5장은 지웠다**(사용자 요청).
    예전 '물리 전용' 열은 iDRAC 서버가 전부 ESXi 인 법인에서 0 이라 '물리 서버 수가 안 나온다' 로 읽혔다. 서버 합계는 여전히 중복 제거 합이라
    합계 ≠ 물리 + 가상화이고 표 머리 문구가 두 정의를 함께 말한다(물리 전용 대수는 칸 title).
  - ⚠⚠ **v2.670 — Overview '경영 보기'(`views/ExecOverview.jsx`·`execOverviewText.js` + 서버 `overview/trend.js`·`GET /overview/trend`)**
    (사용자 제공 시안 `design_handoff_exec_overview`, 선택: 전환 방식 · 추이 전부 · 전체 검증):
    · 엔지니어 보기(`Overview.jsx`)는 그대로 두고 **전환**한다. 모드는 V4 `mode.js` 규칙(저장값 → 역할 기본값, 키 `vmportal.viewMode` 공유)이고
      해시는 시안의 `?view=` 가 아니라 **`#/overview/exec|eng`**(첫 세그먼트가 탭이라 질의를 붙이면 탭 판정이 깨진다) — 그 탭에만, 저장 안 함.
    · 추이는 새 수집이 아니다 — VM(vmtrack 00·12시) · 스토리지(capacityHistoryAll — 카드와 같은 장비 집합) · **서버 전력만**(power_hourly).
      물리 서버 수는 시계열이 없어 그리지 않는다(`no-series`). **부분 합 칸은 null**(빠진 vCenter·장비, 보고 서버 수가 직전 2칸 최대의 90% 미만).
      ⚠ 전력의 기준을 '창 전체 최대' 로 두지 말 것 — 증설한 현장에서 증설 이전 칸이 전부 지워진다(목 데이터로 재현).
    · ⚠ **전력 추이는 칸마다 대표 2시간(`POWER_SAMPLES_PER_BUCKET`)만 인덱스로 읽는다** — 창 전체를 서버별로 묶는 첫 구현은 서버 1천 × 90일에서
      **3.7초 동기 정지**였다(실측). 지금 164ms · 결과 5분 캐시(범위 키). 칸 값은 '칸 전체 평균' 이 아니라 대표 시간 평균이고 각주가 말한다.
    · 범위 계정: 스토리지·전력 추이 null + 사유(카드와 같은 규칙). 주의 항목의 capacity-forecast·license-expiry 는 **마운트 1회**(폴링 금지)이고
      도구 권한을 먼저 본다 — 403 은 '읽기 실패' 가 아니라 '권한 없음' 으로 말한다. ⚠ 인증을 끈 목 서버는 권한 배열이 없어 `can()` 이 참이다(실측 403 2건).
    · 리전 차트 묶음(유럽/북미/아시아(중국 포함)/대한민국)은 `execOverviewText.chartGroup` 하나 — 두 보기가 같이 쓴다. **데이터 리전 값은 바꾸지 않는다**.
    · 스파크라인은 변화가 값의 5% 미만이면 축을 넓힌다(잔물결을 급경사로 과장하지 않는다) · 증감이 표시 단위로 0 이면 '±0'('−0.0 kW' 금지).
  - **v2.677 — 경영 보기 머리 문구('전 세계 …'·vCenter 줄)는 지웠고 KPI 넷째 칸은 '네트워크 스위치'(CVP 등록 수, `cardMeta('network')`)다**(사용자 요청). 연결 불가·첫 수집 중 상태는 헤더·상태바·주의 항목이 말한다 — 머리 문구를 되살리지 말 것. 서버 `/overview/trend` 의 전력 계열은 남아 있지만 이 화면은 더 그리지 않는다.
  - **v2.678 — 경영 보기 KPI 5번째 칸 'GPU 카드' 는 iDRAC 인벤토리 기준이다**(`execOverviewText.gpuKpi`, 사용자 선택 — ESXi 호스트 GPU 는 세지 않는다. 더하면 같은 카드를 두 번 셀 수 있다). 인벤토리를 한 대도 못 읽었으면 '—', 일부만 읽었으면 '최소값' 이라 말한다. 아래 인벤토리 줄의 GPU(장)도 같은 함수를 쓴다.
  - ⚠⚠ **v2.683 — GPU 카드 수량은 `server/src/idrac/gpuCount.js idracGpuCounts` 하나다**(사용자 신고 Overview 455 vs 서버 분석 › GPU 찾기 463 · 결정 "iDRAC 에 등록된 카드만"): 합계 = 활성·비-OME 서버의 iDRAC 인벤토리 GPU 전부(오래된 인벤토리·모델 미상 포함, `gpusStale`·`gpusUnnamed` 로 따로 밝힘). **SSH 등록 GPU 물리 서버(`gpu/physicalRegistry`)의 카드는 합계·모델 집계에 넣지 않는다** — 같은 박스가 iDRAC 에도 있으면 두 번 센다(OS IP ≠ BMC IP 라 가릴 수 없다). GPU 찾기 머리말은 `gpuFinderText.gpuFinderNote` 가 말한다. 두 화면 중 하나에 집계를 다시 인라인으로 두지 말 것(`gpuCount2683.test.js` ②).
  - **v2.671 — Platform(vCenter 목록) 검색창이 전체 vCenter VM 이름도 찾는다**(`views/VCenters.jsx VmNameSearch` + `vcVmSearchText.js` +
    `GET /vms?nameOnly=1`): 두 글자 이상 · 입력 멈춘 뒤 300ms 1회(폴링 금지) · 앞 50대 + 전체 개수 · inv.vms 권한을 먼저 본다 · 범위는 서버
    applyFilters 가 강제. `nameOnly` 가 없으면 /vms 는 예전처럼 이름·게스트 OS·IP·호스트를 본다(다른 화면 영향 없음).
  - ⚠⚠ **v2.672 — 운영 장애: 여러 키를 도는 장기 조회는 `historyRollup` 만 쓴다(원본 폴백 금지)**(`metrics/db.js historyRollup` ·
    `tools/dsGrowth.js` · `util/timeSlice.js` · `insights/forecast.js`, 회귀 `server/test/capForecast2672.test.js` — 변이 4종 전부 검출):
    · 증상(2026-10-01 운영 v2.671): ERR_CONNECTION_TIMED_OUT · stallwatch '약 64~70초 멈춤' 반복 · 스택 `metrics/db.js implHistory`(원본 폴백 줄) ←
      `/tools/capacity-forecast` · 힙 16~18%(nmon: Commit_AS 4GB / RAM 48GB · 파일 캐시 43.8GB) — **메모리가 아니라 동기 SQL 이었다**.
    · 원인 셋: ① `history()` 는 롤업 도입 이전 원본이 있으면 원본으로 폴백하는데(v2.600 DB2600-02) **원본 보존 기본은 5년**
      (`TEMP_RAW_RETENTION_DAYS` 기본 0 = 롤업 기간을 따른다)이고 `ds_usedgb` 는 dead-band 대상이 아니라 분마다 저장된다 —
      키 하나 120일 = 원본 약 17만 행 ② '100개마다 setImmediate' 라 한 건이 느리면 100개 사이가 64~70초 ③ memo 키가 스냅샷 시각이라
      30초마다 새 계산이 **겹쳐** 시작됐다. v2.670 경영 보기가 마운트마다 부르면서 가끔이던 일이 늘 일어났다.
    · 규칙: **여러 키를 도는 루프는 `historyRollup`**(원본으로 절대 떨어지지 않는다 · 버킷은 1시간 정배수로 맞춘다) · 무거운 파생값은
      **스냅샷과 무관한 캐시 + 동시 계산 1건**(stale-while-revalidate — 캐시가 없거나 새 키가 많을 때만 기다린다) · 양보는 **시간 기준**
      (`createYielder` — 개수 기준 금지). 구버전 db 객체(historyRollup 없음)면 `history()` 로 되돌리지 말고 오류로 밝힌다.
    · 대가(정직): 롤업 도입 이전 구간은 예측에 쓰지 않는다 — 항목 `growthPoints`·`growthSince`, 응답 `growth`(출처·기준 시각)로 밝힌다.
    · ✅ (v2.672 가 남긴 위험 — **v2.675 에 고쳤다**, 아래 v2.675 항목) 한 키 차트의 원본 폴백은 롤업 백필(`metrics/rollupBackfill.js`)로 ·
      이상 탐지의 원본 한 문장 집계는 `historyAllSliced`(1시간 조각 + 양보)로 · 첫 수집 중 0 표시는 첫 병합 전 골격(`initial`)으로.
      ⚠ 백필이 끝나기 전(기동 5분 뒤 시작)에는 한 키 차트가 여전히 원본을 읽을 수 있다.
  - ⚠⚠ **v2.673 — 같은 날 두 번째 멈춤 지점: 로그인 실패 분석(`security/loginFails.js`)은 좁은 조건 1회 · 1시간 조각 · 주기 감시는 증분**
    (`logs/loginFailPattern.js` 판정 단일 소스 + `logs/db.js loginFailCandidates`, 회귀 `server/test/loginFails2673.test.js` — 변이 4종 전부 검출):
    · 증상: v2.672 를 적용하기 전 운영 stallwatch 가 `analyzeLoginFails` 에서 14초 넘게 멈춘 것을 잡았다. 로그인 실패 모니터는 **기본 켜짐 · 15분 주기**.
    · 원인: vCenter 이벤트 7일치를 'login'·'auth'·'fail'·'로그인' 으로 **네 번** LIKE 검색(검색어마다 5,000행) — 드문 단어는 매번 7일 전체를 쉬지 않고 훑었다
      (재현: 이벤트 100만 행에 849ms). ⚠ 같은 상한 때문에 흔한 정상 로그인 이벤트가 5,000행을 채워 **실제 실패를 덜 셌다**(재현: 1,000건 중 30건).
    · 규칙: 판정은 정규식(`TYPE_RE`·`MSG_RE`) 하나이고 SQL 은 **같은 뜻의 상위집합**(`LOGIN_FAIL_SQL`)으로 후보만 좁힌다 — 정규식에 갈래를 더하면 SQL 에도
      더할 것(테스트가 갈래마다 실제 SQLite 로 '놓친 실패 0' 을 고정). 훑기는 **최근 1시간 조각부터 거슬러** 시간 기준 양보 · 첫 조각은 위가 열려 있다
      (vCenter 시계가 앞선 실패) · 상한은 실패에만(2만, 넘으면 `scan.truncated`). **주기 감시만 증분**(직전 2시간 재훑기 · 6시간마다 전 범위) — 화면 수동 분석은 언제나 전 범위.
    · ⚠ 비용은 메시지 LIKE 12개가 대부분이다(재현 100만 행: 행 읽기 0.25초 · 조건 전체 1.46초). 조건을 줄여 빠르게 하려면 놓치는 실패가 생긴다 — 그래서 증분을 택했다.
    · 정직 기록: 2시간보다 늦게 수집된 옛 이벤트는 다음 6시간 전 범위 훑기까지 자동 감시 집계에서 빠질 수 있다.
      ✅ 화면의 `scan` 표시(훑은 기간·후보·조각·잘림·분석 시각)는 v2.675 에 넣었다(`views/loginFailsText.js scanNote`·`analyzedAtText`).
  - ⚠⚠ **v2.674 — 포탈 DB 용량 예측은 '파일에 남긴 일 표본의 기울기' 다. 메모리 표본만으로 예측하지 말 것**
    (`insights/portalDb.js` + `portal-db-size-history.json`(상태 파일) + 웹 `views/tools/portalDbText.js`, 사용자 신고 "1개월·6개월·1년 후가 안 나와" ·
    요청 "1주일 후 · 1일 증가량 추가". 회귀 `server/test/portalDbForecast2674.test.js` — 변이 5종(영속·일 기울기·짧은 관측·급감 처리·감소 고정) 전부 검출):
    · 원인: 표본이 메모리에만 있어 재시작마다 지워졌고 관측 1시간 미만이면 예측이 비었다(업그레이드가 잦아 거의 늘 비었다). 30분 표본을 48배 늘린 '일 증가량' 도 냈다.
    · 규칙: 최근 표본(10분, 300개) + 일 표본(한국 시각 하루 마지막, 400일)을 파일에 남긴다 · 일 표본이 2일 이상이면 최근 30일 최소제곱 기울기,
      아니면 최근 표본 처음·끝(1시간 미만이면 일 증가량 null — 숫자를 지어내지 않는다) · 출발점은 **지금 실제 파일 크기**.
    · ⚠⚠ **크게 줄어든 지점(직전의 80% 미만 — 정리·VACUUM·이전) 앞의 일 표본은 쓰지 않는다.** 섞으면 기울기가 큰 음수가 되어 '1년 후 0 B' 가 된다
      (v2.674 Chromium 검증에서 발견 — 보존일 축소 + VACUUM 을 권한 바로 그 상황이다). 감소 추세면 예측은 지금 크기다(`shrinking:true`, 0 으로 내리지 않는다).
    · ⚠⚠ **합계 = 파일별 예측의 합**(줄어드는 파일은 증가 0 — 그 파일의 예측과 같은 규칙. 음수를 더하면 정리 중인 파일이 다른 파일의 증가를 지운다) ·
      **합계 신뢰도는 '증가량이 어디서 나왔는가'** 로 정한다(1일 미만 관측에서 나온 증가가 10% 이상이면 낮음, 7일 미만이 10% 이상이면 보통 — `shortShare`).
      `spanMax`(가장 오래 본 파일)로 정하면 막 생긴 파일 셋의 1시간 관측(증가량의 99%)을 '신뢰도 높음' 으로 말했다(v2.674 Chromium 검증에서 발견).
      표의 '증가/일' 칸도 짧은 관측이면 '관측 짧음' 을 붙인다 — 30일 기울기와 1시간을 늘린 값을 같은 모양으로 보이지 말 것.
  - **v2.674 — 포탈 DB '📖 자세히' 팝업 설명은 `insights/dbGuideData.js` 하나다**(`dbGuide.js guideFor` + `GET /admin/portal-db/guide?file=` adminOnly·fleetOnly,
    폴링 응답에 싣지 않고 팝업을 열 때 한 파일만). 파일마다 코드를 읽고 쓴 설명(근거 `sources`)이고 확인 못 한 것은 '(추정)'. ⚠ **PURPOSES 에 파일을 더하면
    설명도 더할 것** — `test/portalDbGuide2674.test.js` 가 PURPOSES ∪ 이전 대상 DB 전부의 설명·필수 필드·백틱/별표 0 을 고정한다. 주기·보존 기본값·화면 이름이 바뀌면
    설명도 틀려진다 — 그 설정을 바꾸는 릴리스에서 이 파일을 함께 볼 것.
    · 함께 고친 것: 로그인 실패 기록이 깨진 줄 하나로 전체를 버리고 덮어쓰던 것(줄 단위 · `loginStoreSkippedLines`) · `ipam-scan-agents.json` 상태 파일 등록 ·
      공용 `Modal`(resizable)의 min-width 가 max-width 를 이겨 400px 에서 잘리던 것(`min(값, 95vw)`) · 한 줄 설명 8건 + 상세 2건.
    · 설명을 쓰려고 코드를 확인하다 찾은 **v2.643 super_admin 누락 3곳**: 긴급중단 승인자 판정(`emergencyStop.approverRoleIssue` — noainred 를
      '관리자가 아닙니다' 로 거부했다) · 보안 자가진단 OTP 범위 · OTP 콘솔 도구 `--list`. 셋 다 저장 역할을 `'admin'` 문자열로 비교했다 —
      **`getUser`·`listUsers` 의 역할을 비교할 때는 `isAdminTier`**(server/CLAUDE.md v2.643 절). OTP 콘솔 도구는 완료 뒤 '재시작' 을 안내한다
      (포탈은 users.json 을 기동 때 한 번 읽어 메모리에 두고 다시 읽지 않는다 — 재시작 전 저장이 도구의 변경을 덮어쓴다).
      다음 단계 안내(`--confirm`)도 래퍼가 넘긴 호출 형태(`OTP_ENROLL_CMD` — 예 `sudo vmware-portal-otp`)를 쓴다. 예전에는 언제나
      `node server/src/tools/otp-enroll.js` 를 안내해 그대로 따라 하면 CONFIG_DIR 이 달라졌다(회귀 `test/otpToolHint2674.test.js`).
    · ⚠ `registerStateFile('x.json')` 을 `path.join(config.configDir, …)` **안에** 넣지 말 것 — `scripts/config-doc.mjs` 가 그 리터럴 모양으로 파일을 찾아 문서에서 빠진다(이번에 185 → 184 로 줄었다).
  - ⚠⚠ **v2.675 — 운영 멈춤 후보 정리: '행 수에 비례하는 동기 SQL' 을 기동·화면 경로에서 뺐다. 숫자는 합성 대용량 DB 실측이다**
    (사용자 요청 "코드개선 해줘" · 선택: **운영 멈춤 후보 우선** · 전체 검증. 회귀 `server/test/stall2675.test.js`(9건) + 웹 `views/stall2675.test.js`(25건) —
    **변이 37종 중 36종 검출**(남은 1종은 결과가 같은 동등 변이 — 백필 하한 시간의 원본이 비어 있는 경우)):
    · **잰 방법**: 운영 규모 합성 DB — 지표 `ds_usedgb` 1,100키 × 분 단위 × 20일 = 3,168만 행·4.5GB(앞 12일은 롤업 도입 이전 원본) ·
      iDRAC 전력 1,000대 × 15일 = 2,160만 행·1.9GB. `node --import` 느린 SQL 훅(prepare 가로채기)과 stallwatch 로 고치기 전·후를 **같은 코드 경로**로 쟀다.
      ⚠ 운영 DB 로는 재지 못했다 — 운영 수치는 행 수에 비례해 달라진다(추정).
    · ⚠⚠ **'키별 최신값' 을 `GROUP BY k` + `MAX(ts)` 로 만들지 말 것 — 인덱스를 건너뛰며 키를 찾는다(재귀 CTE, loose index scan)**:
      지표 최신값 시드 14,722.9ms → 8.9ms · iDRAC 전력 최신값 시드 1,606ms → 44.8ms · 지표 키 목록(`keysOf`) 1,708.8ms → 11.1ms. 셋 다 기동 직후
      첫 `getDb()`·첫 화면에서 돌았다. 결과는 예전과 같다(테스트 대조). 이 형태는 `(metric, k, ts)`·`(server_id, ts)` 인덱스가 있어야 빠르다 —
      그 인덱스를 지우거나 GROUP BY 로 되돌리면 다시 행 수에 비례한다. v2.550.3 `usage_latest` · v2.292 `withLatestCache` 와 같은 교훈의 세 번째다.
    · ⚠⚠ **`meta()`(MIN·MAX·COUNT 한 문장)를 화면 경로에서 부르지 말 것** — v2.550.3 '집계 둘 이상이면 풀스캔' 의 재발이었다(GPU 추이 메타 2,348.7ms).
      `metaRange`(MIN·MAX **단독 문장** 2개 — 0.1ms) + 개수가 꼭 필요하면 `countAsync`(6시간 조각·양보 — 총 약 1.1초, 최장 멈춤 16.6ms). GPU series-meta 는 5분 기억.
      비었는지 확인은 `EXISTS`(iDRAC 롤업 마이그레이션 판정이 기동마다 `COUNT(*)` 를 했다).
    · ⚠⚠ **이상 탐지는 `historyAllSliced` — 원본 한 문장 집계(`historyAll`)를 요청 경로에서 쓰지 말 것**: 1시간 조각(버킷 정배수) · 맨 위 조각은 위가 열려 있다
      (시계가 앞선 표본) · 최신 조각부터 키당 상한 · **마지막 조립도 키마다 양보**(조각만 나누면 조립에서 약 250ms 가 남았다 — 자체 측정으로 잡았다).
      응답 16,297ms → 1,248ms · 최장 멈춤 1,934.9ms → 71.8ms. 결과는 `historyAll` 과 같다(6가지 조건 대조).
    · **롤업 백필**(`metrics/rollupBackfill.js` — v2.672 가 '근본 해법' 이라 적은 것): 롤업 도입(v2.252) 이전 원본을 `samples_hourly` 로 **한 번** 옮긴다.
      기동 5분 뒤(`METRICS_ROLLUP_BACKFILL_DELAY_MS`) · 키마다 최신 구간부터 · `INSERT OR IGNORE`(이미 있는 시간은 건드리지 않는다) · 재개 지점은 MIN(h) ·
      끝나면 `samples_meta` 표지(다시 하지 않는다) · 40ms 일하고 80ms 쉰다 · 디스크 여유 가드(`METRICS_ROLLUP_BACKFILL_MIN_FREE_GB` 기본 5 — 미만이면
      `disk-low` 로 멈추고 사유를 남긴다) · 진행이 없는 키는 건너뛰고 센다(`stuckKeys` — 무한 루프 방지) · `METRICS_ROLLUP_BACKFILL=0` 으로 끈다.
      ⚠ **원본은 지우지 않는다**(보존 정책은 그대로). 실측 1,897만 행 → 시간당 31만 6,800행 · 153초 · 이전 중 멈춤 경고 0건 · 이전 뒤 한 키 365일 차트
      56.4ms → 1.6ms. 상태는 `/admin/metrics/settings` 의 `status.rollupBackfill` → 웹 `rollupBackfillText.js`(범위 관리자에게는 state·시각만 — 키·행 수는
      전 함대 집계). ⚠ 지연 env 는 `numOrNull` 로 읽는다(`KEY=` 빈 값은 미지정 — v2.618 BUG-1 규약). 백필 로그의 소요 시간은 **실제 시계**(주입한 now 아님).
    · ⚠⚠ **첫 병합 전에는 '골격' 을 먼저 게시한다**(`store.publishSkeleton` — 등록부만으로 vCenter 별 상태: 대기·비활성·점검·site→대기·인증 정지→불가,
      인벤토리 0, `initial:true`. 원장 동기화·전력 오버레이는 부르지 않는다). `/overview`·`/health` 가 `initial` 을 싣고, 화면은 그 동안 **0 이 아니라**
      '첫 수집 중' 을 말한다 — 개요(엔지니어·경영·V6)는 `overviewCardsText.firstCollectNotice`, V6 서버 3구분은 null, 하단 상태바(개발 포탈·V6)는
      `views/statusBarText.statusCounts`(한 벌 — 두 상태바가 같이 쓴다). `/metrics` 는 첫 수집 중 vCenter 를 0(다운)으로 내보내지 않는다.
      ⚠ 응답의 개수 필드(hosts·vms…)는 구버전 화면 호환으로 0 그대로다 — **화면이 `initial` 을 먼저 볼 것**. 읽은 호스트가 없으면 `/health` 의
      `cpuUsagePct` 는 null(예전 `|| 0` 은 '0%' 라는 거짓). 병합이 한 번 일어나면 다시 골격을 내지 않는다(`_merged`).
    · 로그인 실패 분석: 반복 공격 판정을 대상마다 전체 실패를 다시 훑던 것(대상 × 실패)에서 **한 번 훑기**로(예전 구현과 대조 테스트) · 최근 창 기준은
      분석 시각(`now`) · 응답 `scan` 에 `rowsMax`·`days` · 라우트는 같은 조건 60초 기억 + 동시 요청 합류(`snapMemo('loginFails')`), '지금 분석' 이 비운다 ·
      화면은 분석 5분마다·상태 30초마다 부르고 훑은 범위·잘림·분석 시각을 말한다.
    · 헤더 'N/M vCenter' 의 분모는 **비활성을 뺀 수**다 — v2.617 이 '헤더도 분모에서 뺐다' 고 적었지만 개발 포탈 헤더는 빠져 있었다(V6 와 숫자가 달랐다).
    · ⚠ 작업 방식: ① `pkill -f '<패턴>'` 은 그 패턴을 담은 **자기 셸까지 죽인다**(exit 144) — PID 를 `/proc/<pid>/environ` 의 PORT 로 찾아 kill 할 것
      ② 골격 화면은 첫 연결 시한(15초 × 재시도) 동안만 유지된다 — Chromium 확인은 서버 재시작 직후 곧바로 찍고, 그 순간의 `/health` 를 함께 기록한다
      ③ 변이 검증의 드레인 루프는 횟수를 묶을 것(진행 없음 가드를 되돌리는 변이가 테스트를 무한 루프로 만든다 — 실제로 겪었다).
  - ⚠ **표 안의 클릭 가능한 텍스트에 `<a>` 기본 링크 색을 쓰지 말 것**(v2.527 사용자 신고
    "법인 글자가 파란색이라서 안보여"): 이 어두운 표에서 링크 파랑은 읽기 어렵다. **표의 다른
    글자와 같은 색**(`color:'inherit'`)을 쓰고 클릭 가능함은 **점선 밑줄**로 알린다
    (`App.jsx:409` 의 `openList` 관례 — `cursor:'pointer'` + `textDecoration:'underline dotted'`
    + `textUnderlineOffset:3`). 키보드 접근을 위해 `role="button"`·`tabIndex`·Enter/Space 처리도 함께.
- **전력 latest 인메모리 캐시**(`idrac/db.js withLatestCache`): latestAll(GROUP BY MAX)은 테이블 풀스캔이라(90일 수렴 시 수억 행) 매 30초 3회 호출이 초 단위 블로킹이었음. 기동 시 1회 시드 후 쓰기 경로에서 O(1) 갱신 — **getDb() 래퍼를 우회한 직접 쓰기 금지**(캐시가 낡음). 전력 대시보드 24h 집계는 `power_hourly` 롤업이 담당한다(`idrac/db.js`) — v2.503 정정: 여기 적혀 있던 `idrac/service.js aggCache` 60초 캐시는 **v2.292 에 삭제됐다**(코드 주석이 직접 그렇게 밝히고 있는데 이 문서만 낡아 있었다).
- (구 '미해결 후속' 2건 — 적용 완료) 전력 대시보드 시간당 롤업 테이블은 `power_hourly`
  (idrac/db.js, 적재 트랜잭션 내 증분 upsert)로, 위임 잡 인출 2단계 확인응답(claim→ack)은
  v2.290(central/captureJobs.js — claim 기한 + 재수확 reap + 재시도 상한, idracScanJobs 패턴
  이식)으로 해결됨. **새 위임 잡 큐를 추가할 때 같은 claim→ack 패턴을 따를 것.**
- ⚠⚠ **서버 온도 › 센서 상세(v2.659) — iDRAC 전 센서. 판정은 장비 Health → 장비 임계값 순이고, 포탈은 임계를 지어내지 않는다**
  (`idrac/sensorDetail.js`(순수 판정) · `sensorDetailCache.js` · `redfish.js fetchSensorCollection` · `tools/serverSensors.js` ·
  `routes/api/serverSensors.js` + 웹 `views/tools/serverTemp/SensorDetailView.jsx`·`sensorDetailText.js`, 사용자 요청 "서버 온도를 세부적으로 ·
  iDRAC 모든 센서 · inlet 으로 전산실 온도 · CPU 를 온도와 CPU performance 로 · GPU 를 GPU 온도로". 선택: Sensors 컬렉션 전부 · CPU 사용률은
  베어메탈 사용률 재사용 · 전체 검증. 회귀 `server/test/serverSensors2659.test.js` + 웹 `sensorDetailText.test.js`):
  - **Thermal 임계값은 원래 받던 응답에 있었다** — `fetchSensors` 가 버리던 것을 `thermalDetail` 로 살렸다(왕복 0). 시계열(sensorStore)에는 싣지 않는다.
  - **Sensors 컬렉션은 인벤토리 주기(30분)에만** — `$expand=*($levels=1)` 1회가 기본, 거부하면 확장 없이 다시, 멤버를 하나씩 읽는 경우는
    `IDRAC_SENSOR_MEMBER_MAX`(250)·`IDRAC_SENSOR_BUDGET_MS`(45초) 안에서 동시 4. 못 읽은 멤버는 `notRead`, 404 섀시는 `absent`(실패 아님),
    인증 거부는 던진다. ⚠ 이 현장 iDRAC 의 $expand 응답은 확인하지 못했다(가짜 Redfish 로만 검증 — 정직 기록).
  - 상태 다섯(ok/warn/crit/**unknown**/**absent**) — 순서 빈 슬롯 → Health → 임계. 임계도 Health 도 없으면 unknown(정상 아님).
  - 역할은 **이름·PhysicalContext 추정**이고 순서가 계약이다: 전원공급장치 → 흡기·배기 → GPU → CPU → DIMM. PSU 를 흡기보다 먼저 보지 않으면
    HPE '32-P/S 1 Inlet' 이 전산실 온도가 된다(v2.621 DATA-04 와 같은 규칙).
  - CPU 사용률 출처 순서: bmusage 최신값(서비스태그·id·fleetId 대소문자 무시) → iDRAC 텔레메트리(sensorStore latest.cpu) → Sensors 퍼센트 CPU 센서.
    **출처를 칸에 적고**, 오래된 값은 stale, 전부 없고 bmusage 가 꺼져 있으면 'off'. GPU 온도는 **사용률이 아니다**(v2.650 규약) — 문구가 말한다.
  - 신선도: Thermal 이 있으면 `sampleMaxAgeMs`(폴 주기 반영), 컬렉션만 있으면 75분. 낡은 상세·상세 없음은 요약(전산실 온도·경고 수)에서 빼고 따로 센다.
  - 엣지: export 에 `sensorDetail`(콤팩트, 서버당 150) — 중앙 `sanitizeRemoteSensorDetail` 가 `expandCompact` 로 되돌리며 **상태를 다시 판정**한다
    (엣지 state 를 믿지 않는다). **새 필드를 엣지 export 에 더하면 이 정제에도 더할 것**(v2.611 CEN2611-01).
  - 캐시 `idrac-sensor-cache.json` 은 상태 파일(백업 감시 제외)이고 손상이면 새로 시작한다(arch2582 CACHE_OK). 파일명은 리터럴로 둔다(config-doc 생성기).
  - 화면: 폴링하지 않는다(마운트 1회 + 새로고침). 비-admin 은 IP 로 등록된 id·name 을 가린다(상세 조회는 토큰을 되찾는다). 표 `.sd-table` 최소폭 1000px.
    ⚠ 탭 5개가 되며 서버 온도 `Segment` 가 400px 에서 페이지를 51px 밀어냈다 — `flexWrap:'wrap'` 로 고쳤다(같은 탭 묶음을 쓰는 '서버별' 탭도 같이 넘쳤다 · 수정 후 두 탭 모두 0 · 변경 전 코드와의 A/B 는 하지 않았다).
- ⚠⚠ **iDRAC 통합 추이(v2.660) — 새 수집이 아니라 샘플러 적재 3계열 + 기간 조회. 데이터센터는 스캔 대역 이름이다**
  (`idrac/serverTrendSeries.js` · `idrac/scanSite.js` · `routes/admin/idracTrend.js` + metrics `historyRange` · 전력 `bucketRange` + 웹
  `views/tools/IdracTrendTool.jsx`·`idracTrendText.js`, 사용자 제공 핸드오프 `design_handoff_idrac_trend`. 선택: 데이터센터 = **스캔 대역 이름** ·
  전체 검증. 같은 릴리스에 사용자 요청 "미 가상화 물리서버도 idrac scan 할때 사용한 agent 가 속한 데이터 센터로 분류". 회귀
  `server/test/idracTrend2660.test.js`(실제 metrics·전력 DB + 실제 admin 라우터) + 웹 `idracTrendText.test.js`):
  - **계열**: `idracusage_cpu`(dead-band 없음 — 사용률 규약) · `idractemp_cpu`·`idractemp_gpu`(온도 dead-band 0.5℃ — `deadband.js policyKeyFor`).
    `idractemp_max`·inlet·exhaust 는 **예전 그대로 전량 저장**이다(기존 화면이 분 단위 원본을 step 없이 읽는다 — 바꾸면 공백이 생긴다).
    `idractemp_cpu` 가 dead-band 가 됐으므로 `/idrac/:id/temp-history` 는 `historyStep` 으로 읽는다. 상세 모드(`IDRAC_TEMP_SERIES_DETAIL`)면
    serverTempSeries 가 idractemp_cpu 를 적재하므로 여기서는 건너뛴다(두 번 적재 금지). GPU 판정은 `sensorDetail.roleOf`(센서 상세와 같은 판정).
  - **기간 조회는 끝이 있다**(`historyRange`·`bucketRange`) — `history()` 는 '지금까지' 만 받아 과거 기간을 보려면 지금까지 전부 읽어야 했다.
    1시간 정배수 버킷은 롤업, 짧은 버킷의 dead-band 계열(온도·전력)은 step 채움(창 직전 행 이월, 최대 간격 + 5분까지만). ⚠ step 은
    실제 중단 직전 약 35분을 이어 그린다(dead-band 에서 '안 변함' 과 '멈춤' 을 원본만으로 구분할 수 없다 — 기존 historyStep 과 같은 한계).
  - **데이터센터 = 그 서버 IP 를 포함하는 iDRAC 스캔 대역 이름**(`scanSite.js` — 대역을 펼치지 않고 [lo,hi] 구간 비교, 겹치면 가장 좁은 대역,
    **다른 법인 대역이 겹치면 정하지 않음**). 같은 색인이 서버 분석의 **법인 보강**(`analysisServers.withScanDatacenter`)을 한다 — 법인이 비고
    vCenter→법인 할당도 없는 서버만, 에이전트가 속한 데이터센터(모르면 대역의 법인)로. `dcSource` 로 근거를 밝힌다. 판정을 복제하지 말 것.
  - 보관: 조회 가능 기간 `IDRAC_TREND_RETENTION_DAYS`(기본 365, metrics 롤업 보존보다 길 수 없다). 전력은 전력 DB 보관(기본 90일)이라 응답
    `retention.powerDays` 를 화면이 말한다. 첫 적재(`firstTs`) 이전은 무응답이 아니라 '수집 전' 이다(회색 무응답 칸을 칠하지 않는다).
  - 엣지: export 센서 요약에 `cpu`(0~100)를 싣고 중앙 `sanitizeRemoteSensors` 가 받는다 — 위임 서버 CPU 사용률은 엣지 2.660 이 필요하다.
  - CSV: `data.csv` + adminOnly + 동시 1건(`exportBusy`) · 데이터센터 전체 300대 상한(`X-Omitted-Servers`) · BOM · 빈 칸 결측 ·
    `filename=` ASCII 대체 이름에도 기간·시각을 싣는다(웹 `downloadFile` 이 그것을 먼저 읽는다).
  - 화면: 폴링은 `usePolling`(1시간 범위만 30초) · KPI 는 720px 이하 2×2(`.idrac-trend-kpis` — 4칸이면 400px 에서 라벨이 말줄임으로 사라졌다,
    스크린샷 판독) · 도구 키 `idrac-trend`(adminOnly — 주 API 가 /api/admin). V4·V5·V6 트리 · toolcats · toolAccess 선언에 등록했다.
  - ⚠ 정직 기록: 실장비 iDRAC 으로는 보지 못했다 — 목 서버에 합성 적재(3일)를 심어 Chromium 1440/400 으로 확인했다.
- ⚠⚠ **iDRAC 통합 추이 보강(v2.661) — CPU 사용률은 대체 출처로 채우되 출처를 밝히고, 엣지 서버 전력은 `rmt:` 키로 찾는다**
  (`idrac/serverTrendSeries.js CPU_FALLBACK_METRICS`·`bmCpuOf`·`hostCpuFrom` · `bmusage/cpuLatest.js`(센서 상세와 공용) ·
  `bmusage/db.js usageCpuRange` · `routes/admin/idracTrend.js mergeCpuSeries`·`powerKeyOf`·`export.xlsx` · `util/xlsxChart.js` +
  웹 `IdracTrendTool.jsx`·`idracTrendText.js`, 사용자 신고 "CPU 온도·GPU 온도는 나오는데 CPU 사용률과 소비 전력은 안 나와" + 요청
  "엑셀로 차트를 그려 내보내기" · "가상화 서버는 2개(ESXi·iDRAC 상세)" · "흡기/배기 카드 + 위치 변경" · "GPU 온도가 있는 서버만". 회귀
  `server/test/idracTrend2661.test.js` + 웹 `idracTrendText.test.js`):
  - **CPU 사용률이 빈 원인은 라이선스다** — Dell 텔레메트리 SystemUsage 는 Datacenter 전용(v2.554)이고 이 현장은 Enterprise 다. 샘플러가 한 서버·한 주기에
    **한 계열만** 적재한다: `idracusage_cpu`(텔레메트리) > `idracusage_cpu_os`(bmusage 최신값 — 센서 상세와 같은 행·같은 신선도) >
    `idracusage_cpu_vc`(ESXi 호스트 CPU — 서비스태그 일치 · 연결된 호스트 · 샘플러의 freshHosts 만). 출처가 다른 값을 한 계열에 섞지 않으므로 조회가 버킷마다
    출처를 고르고 `cpuSources` 로 밝힌다. **빈 버킷만** 중앙 bmusage 원시 이력(`usageCpuRange` — 대소문자 변형 키로 PK 선탐색, COLLATE NOCASE 금지)으로 채운다.
    ⚠ 엣지 수집 서버의 bmusage 이력은 엣지 DB 에만 있어 과거 구간을 채울 수 없다(정직 기록 — 앞으로는 샘플러가 엣지 보관분 최신값으로 쌓는다).
  - **엣지 서버의 전력 키는 서버 id 가 아니다** — puller 는 `rmt:<호스트>`(충돌 시 `rmt:<수집서버>:<호스트>`)로 적재한다. `powerKeyOf` 가 지금 보고 중인
    항목(수집 서버 + 엣지 서버 id)의 dbKey 를 쓰고, 없으면(중앙 재시작 직후) 법인 축 키만 본다. **법인 축 없는 `rmt:<이름>` 을 추측으로 쓰지 말 것**(v2.605).
  - **흡기·배기는 전용 계열 `idractrend_inlet`·`idractrend_exhaust`(온도 dead-band)** — 상세 모드의 `idractemp_inlet`·`exhaust` 는 전량 저장이고 기존 화면이
    원본을 step 없이 읽으므로 그 이름에 dead-band 를 걸지 말 것. 롤업 행은 서버당 연 8,760 × 2 가 늘어난다(`IDRAC_TREND_AIRFLOW=false` 로 끈다).
  - **엑셀 차트는 DrawingML 을 직접 넣는다**(exceljs 4.4 는 차트를 못 만든다 — 이미지로 넣으면 값을 고칠 수 없다). jszip 은 exceljs 의 의존성을 그 위치에서
    불러온다(새 의존성 없음). `dispBlanksAs gap`(결측을 잇지 않는다) · 전력은 보조 축 · 시트의 `<drawing>` 은 `legacyDrawing`·`tableParts`·`extLst` 앞.
    ⚠ 정직 기록: 이 컨테이너의 LibreOffice 에는 Calc 가 없어 **엑셀/Calc 로 열어 그려지는 것은 보지 못했다** — openpyxl 이 차트·계열 참조를 읽고 재저장하는 것과
    exceljs 재로드까지 확인했다. 첫 실사용에서 엑셀로 열어 확인할 것.
  - 카드 순서는 **브라우저 저장**(`idracTrend.cardOrder`, try/catch)이다 — 서버 설정으로 두면 한 사람이 바꾼 순서가 모두에게 바뀐다. 모르는 키는 버리고 새 카드는 뒤에 붙인다.
  - 'GPU 서버만' = 최신 센서의 GPU 역할 온도(roleOf) 또는 추이 DB 에 `idractemp_gpu` 계열이 있음(`metrics db.keysOf` — 한 번에 읽는다. 서버마다 metaKey 를 부르지 말 것 —
    NDJSON 폴백은 키마다 전량을 훑는다). 데이터센터 전체 내보내기도 `gpuOnly=1` 로 같은 필터.
  - 가상화 서버는 ESXi 호스트 상세 + iDRAC 상세 **둘 다** 버튼을 둔다(사용자 요청). CSV 권한이 없으면 버튼을 숨기되 그 사실을 한 줄로 말한다.
  - **선 모양(v2.662)**: 흡기·배기는 기본 점선(`SERIES[].dash`). 계열별 모양·굵기·점은 `idracTrendText.js` 의 `normalizeStyles`·`loadStyles`·`saveStyles`
    (브라우저 `idracTrend.lineStyle` — 기본과 다른 계열만 저장)가 소유하고 카드 견본·차트·엑셀이 같은 값을 쓴다. 엑셀은 `?styles=k:모양:굵기:점` 을
    서버 `parseExportStyles` 가 허용 목록으로 거르고 `xlsxChart.js PRST_DASH` 로 `<a:prstDash>` 를 싣는다 — 모양 키를 늘리면 **두 목록을 함께** 고칠 것.
  - **서버 표 · 조건 검색(v2.663)**: `GET /admin/idrac/trend/table?hours=&corp=*&site=*` 가 지표마다 전 서버 요약을 **쿼리 1회**로 준다(metrics
    `statsSinceAll`·전력 `statsSince` — 시간당 롤업, 창이 앞쪽으로 최대 1시간 넓다). 조건 판정은 화면 `idracTrendText.filterTable`(이상=기간 최대,
    이하=기간 최소, 값 없음은 판정 불가로 따로 센다 — 0 으로 보지 않는다). ⚠ 서비스태그는 `serverTrendSeries.serviceTagOf`(최상위 → 인벤토리)
    하나로 읽는다 — 적재기가 최상위만 봐서 엣지 서버의 vCenter CPU 대체가 쌓이지 않았다(화면 머리 판정과 출처가 달랐다). 지금 CPU 를 못 읽는
    사유는 `cpuFallbackDiag` → 응답 `cpuDiag` → 웹 `cpuDiagText`.
  - ⚠⚠ **v2.665 — CPU 사용률은 iDRAC 출처만이다. v2.661 의 bmusage(OS)·vCenter 대체는 철회했다**(사용자 지시 "vcenter 에서 가져오지 말고
    idrac 에서 가져오는걸로"). 순서: `idracusage_cpu`(텔레메트리) > `idracusage_cpu_rs`(Sensors 컬렉션 CPU 센서 — `summarizeSensors().sensorCpuUsagePct`,
    컬렉션 시각 기준 `SENSOR_CPU_FRESH_MS` 75분) > `idracusage_cpu_bm`(bmusage 최신 행 중 `bmSrcIsIdrac(src)` — 'os' 토큰이 있거나 src 가 비면 제외).
    이력 채우기도 `usageCpuRange(…, {idracOnly:true})`(`IDRAC_ONLY_SQL`). 옛 계열 `_os`·`_vc`(`CPU_RETIRED_METRICS`)는 **쓰지도 읽지도 않는다** —
    `_os` 는 OS 값과 iDRAC 값이 섞여 있어 가를 수 없다. **여기에 vCenter·OS 대체를 되살리지 말 것.** Enterprise 라이선스 서버는 빈칸일 수 있고
    `cpuDiag` 코드(ok·sensor-stale·bm-os-only·bm-stale·no-idrac-cpu)로 이유를 말한다. 센서 상세 화면(`tools/serverSensors.cpuOf`)은 그대로다(다른 화면).
  - **수집 멈춤 배너(v2.665)**: `/idrac/:id/trend` 응답 `idracState`(`idracStateOf` — 표본 시각·나이·경계, 엣지 서버는 중앙 pull 상태 `lastOkAt`·`ok`·`fails`
    와 `exportAt`)를 웹 `idracStateBanner` 가 판정한다 — pull 정상 + 표본 멈춤 = 엣지의 iDRAC 수집, pull 실패 = 통신. 오류 원문은 `idracScopeOf(req)` 가
    null(전체 범위)일 때만 싣는다. ⚠ 2026-09-30 02:32 멈춤 신고의 원인은 확정하지 못했다(운영 증거 필요 — 배너가 가른다).
  - ⚠⚠ **v2.666 — ESXi CPU(vCenter) 는 '다른 선' 이다. v2.665 규칙을 어기지 않는다**(사용자 요청 "가상화 서버의 경우 hostname 이나
    service tag 로 매칭되는 장비가 있으면 cpu 사용량을 불러와서 같이"): `cpuPct`(iDRAC) 에는 여전히 iDRAC 값만이고, 매칭된 호스트의 vCenter 값은
    **별도 계열 `hostCpuPct`**(샘플러 `host_cpu_pct` — 연결된 호스트·신선한 vCenter 만, `HOST_CPU_SERIES=0` 으로 끔)이다. 웹은 iDRAC 6계열 `SERIES`
    (서버 표·조건 검색·무응답 구간 판정)와 차트용 `CHART_SERIES`(+ESXi CPU)를 나눈다 — **ESXi CPU 를 SERIES 에 넣지 말 것**(무응답 구간을 가린다).
    매칭은 `idrac/hostMatch.js` 의 서비스태그 → 짧은 호스트네임(소문자·첫 '.' 앞·끝 점 제거) 순이고 **IP 는 이름이 아니다**(v2.628 C2628-01) ·
    같은 짧은 이름이 두 호스트면 정하지 않는다(`hostAmbiguous`) · 이름 후보(iDRAC 이름·hostName·인벤토리 hostName)가 서로 다른 호스트면 정하지 않는다.
    CPU 75/90 기준선 토글은 브라우저 저장(`idracTrend.cpuRef`). 과거 스크롤은 같은 길이 창을 칸 단위로(`scrollWindow` — 기준 끝은 스크롤 시작 때 한 번
    잡는다. 매번 Date.now() 면 폴링 사이에 칸이 밀린다) · 과거 구간은 폴링하지 않는다 · 슬라이더는 놓을 때만 조회. 기간 지정(custom)에는 스크롤이 없다.
  - **v2.668 — 매칭된 ESXi 호스트의 GPU 사용률·GPU 메모리 점유도 '다른 선' 이다**(사용자 요청 "이 화면에서 수집한 GPU 사용량 붙여서
    호스트 별로 사용량을 같이"): 계열 `hostGpuPct`·`hostGpuMemPct` 는 GPU 모니터링이 호스트 id 로 이미 적재하는 `gpu_util`·`gpu_mem`
    (`routes/admin/idracTrend.js HOST_GPU_METRICS`)을 **읽기만** 한다 — 새 수집 없음. v2.666 ESXi CPU 와 같이 웹 `CHART_SERIES` 에만 넣고
    iDRAC `SERIES` 에는 넣지 않는다(`gpu:true` 표지). 응답 `hostGpu.hasGpu`(`hostHasGpu` — 스냅샷 host.gpus, 모르면 null)가 **false 일 때만**
    카드·선·내보내기 열을 숨긴다(모르면 보인다 — 'GPU 없음' 을 단정하지 않는다). GPU 온도는 iDRAC gpuTemp 가 있어 싣지 않는다.
    샘플러의 gpu_util 은 ESXi 보고값 → 게스트 nvidia-smi 순이라 출처가 섞여 있다(각주가 둘 다 말한다).
  - **v2.712 — GPU 온도 기준선**(사용자 요청 "45도 이상 100도 미만 · 색상과 굵기를 사용자가 지정"): `idracTrendText.js gpuRefValueOf·normalizeGpuRef·setGpuRef·loadGpuRef·saveGpuRef·showGpuRef`
    (키 `idracTrend.gpuRef` — 브라우저 저장, 기본값과 같으면 지운다). 값은 **정수 [45, 100)** 만 — 범위 밖·빈 칸은 저장하지 않고 직전 값(`Number('')===0` 함정).
    색은 `#rrggbb` 만(style 에 들어간다), 굵기는 `WIDTHS`. GPU 온도 계열이 보일 때만 그린다. 포탈이 정한 위험 수치가 아니다(v2.650 — 임계를 정하지 않는다). 엑셀 내보내기에는 없다.
  - ⚠⚠ **v2.676 — 호스트 상세 '통합 성능 모니터링'(ESXi 호스트 → iDRAC 서버)은 규칙 넷을 각각 판정한다**(`idrac/serverForHost.js`(순수) +
    `GET /admin/idrac/trend/resolve-host` + 웹 `components/IdracTrendLinkButton.jsx` · 회귀 `server/test/idracLink2676.test.js`(변이 5/5) + 웹
    `views/tools/idracLink2676.test.js`. 사용자 요청 "hostname, TAG 넘버, IP 등으로 복합 조회해서 확실하게 연결"):
    · 규칙: 서비스태그 · 짧은 호스트네임(`hostMatch.hostShortName` — IP 는 이름이 아니다) · IP(ESXi `mgmtIp`·IP 형 host.name ↔ iDRAC 쪽 **OS IP** = 등록 이름·
      hostName·hostNames 중 정규형 IPv4) · MAC(ESXi `nics[].mac` ↔ 인벤토리 `nics[].ports[].mac`). ⚠⚠ **iDRAC 자체 주소(`s.host`·인벤토리 network)는 IP 비교에
      넣지 말 것** — BMC 주소와 ESXi 관리 IP 는 다른 주소다(변이 M3 가 잡는다). ⚠ `strictIpv4Num` 은 비정규 표기에 `false` 를 준다 — `!= null` 로 IP 판정하지 말 것(이번에 밟았다).
    · 한 규칙이 서버 둘 이상을 가리키면 근거가 아니다(그 호스트 vCenter 귀속 서버가 하나면 좁힌다) · 규칙끼리 다른 서버면 태그가 있을 때만 태그를 따르고
      `conflicts` 로 밝힌다, 없으면 **연결하지 않고 후보를 보여 준다** · 거꾸로 찾은 호스트(`kindOf`)가 다르면 `reverse.same:false` 를 화면이 말한다.
    · 인계는 `hooks/searchHandoff.js`(메모리 · URL 에 싣지 않음, target `idrac-trend`)이고 통합 추이가 열려 있어도 구독으로 받는다. 버튼은 관리자 + 도구 허용일 때만.
    · 서버 머리 GPU 표지 = 응답 `gpuCards{esxi, idrac}`(모델별 장수 — `gpuCardsOf`, 모르면 null · [] 는 0장). ESXi 먼저, 두 출처 장수가 다르면 ⚠ + 툴팁(단정하지 않는다).
    · '데이터센터' 표기는 이 화면에서 **'서비스'** 다(사용자 요청 — 값은 그대로 스캔 대역 이름 `service`). 법인 귀속 문구처럼 진짜 DataCenter 를 뜻하는 곳은 바꾸지 않는다.
    · 정직 기록: 목 호스트에는 서비스태그·mgmtIp·NIC MAC 이 없어 브라우저 검증은 호스트네임 규칙으로만 연결됐다.
  - ⚠⚠ **v2.687 — 서버 표 '평균 대비 변화' 조건 · ESXi 계열 · '언제 · 얼마나' 시간 목록**(사용자 요청 "모든 차트의 값의 변화를 조회 · 7일 동안 CPU 사용률이
    평균에서 10% 이상 변화(단일·복합)" + "어느 날 어느 시간에 얼마 만큼의 변화가 있었는지 리스트로". 선택: 절대·비율 둘 다 · 기간 중 한 번이라도 · 전체 검증.
    `idracTrendText.js deviationOf·changeEpisodes` + 웹 `IdracTrendChanges.jsx` + 서버 `GET /admin/idrac/:id/trend/hourly`·`mergeHourly`·`TABLE_HOST_KEYS` + 전력 `hourlyStats`.
    회귀 `server/test/idracTrend2687.test.js` + 웹 `idracTrendChange2687.test.js`(변이 4/4):
    · 변화 = max(기간 최대 − 평균, 평균 − 기간 최소) — devAbs(단위 그대로, %지표는 %p) · devPct(÷ 평균 × 100, **평균 ≤ 0 이면 판정 불가**). 음수 기준은 버린다.
    · 표 지표는 `TABLE_SERIES`(iDRAC 6 + ESXi 3)다 — ESXi 계열은 **매칭 호스트 id**(`row.hostId`)로 요약한다. `SERIES`(무응답 구간 판정용 iDRAC 6계열)에 넣지 말 것.
    · 시간 목록은 **표와 같은 창**(표 응답 `since` 를 넘긴다)·같은 시간당 롤업이고 판정 규칙도 표와 한 벌이다(이상=그 시간 최대 · 이하=최소 · 변화=기간 평균 기준).
      그래서 표에서 걸린 서버는 목록에서 적어도 한 시간이 걸린다(테스트 고정). 1시간 단위라 분 단위 시각은 모른다 — 화면이 말한다. 구간 상한 300(`omitted`).
    · **서버 종류 선택**(같은 릴리스 사용자 요청 "CPU 만 있는 서버, GPU 도 있는 서버, 가상화 서버, 베어메탈 서버 선택"): 구성(GPU 있음·CPU 만) × 형태(가상화·베어메탈) 두 축,
      서버 `gpuStateOf`·`typeFilterOf`(쿼리 `gpu`·`kind`, 구버전 `gpuOnly=1` 호환) + 웹 `IdracTypeBar.jsx`·`typeCounts`(칩 개수는 다른 축 선택만 반영).
      'CPU 만' 은 **GPU 0 장으로 읽었을 때만** — 근거가 없으면 unknown 이고 어느 칩에도 넣지 않는다. ⚠ `gpuCardsOf` 는 배열이 아니라 `{cards,total}` 을 돌려준다 —
      초판이 배열로 읽어 전 서버가 unknown 이었고, **배열로 만든 단위 테스트는 통과했다**(목 서버 화면에서 발견). 테스트 입력은 실제 함수의 출력으로 만들 것.
  - ⚠⚠ **v2.729 — 7일 보기가 원본을 읽어 포탈 전체를 멈췄다. 1시간보다 잔 버킷은 원본을 읽는다는 사실을 버킷 표에 반영할 것**
    (사용자 캡처: 7일 조회 24초째 · 같은 시각 `/api/health` 14초 대기 — 이 화면은 iDRAC 에 접속하지 않고 로컬 DB 만 읽는다.
    `routes/admin/idracTrend.js BUCKETS`·`seriesForMemo` + `metrics/db.js historyRangeAsync`·`metaKey`, 회귀 `server/test/idracTrendPerf2729.test.js` — 변이 7/7):
    · **30분 버킷을 되살리지 말 것** — 1시간 미만 버킷은 `samples_hourly` 를 못 써 분 단위 원본을 읽는다. 원본 인덱스 `(metric,k,ts)` 에는 v 가 없어
      행마다 표 본체를 읽고, 원본은 1분마다 전 장비 값이 섞여 쌓여 한 계열의 행이 파일 곳곳에 흩어진다(캐시에 없으면 행마다 디스크 임의 읽기).
      7일 × 30분 = 계열당 약 1만 행. 지금 BUCKETS 는 [1분, 5분, 1시간, 2시간, 6시간, 1일] — 원본은 약 33시간 이하 창만 읽는다.
    · **키 단위 MIN·MAX 도 한 문장이면 그 키 전체 이력을 훑는다**(v2.550.3 의 '파티션으로 좁히면 2.7ms' 는 짧은 키 이야기였다 — 오래 쌓인 GPU·호스트
      계열은 수십만 항목). `metaKey` 는 단독 MIN/MAX 문장 4개다. 테스트가 `k=?` 로 좁힌 준비문에 MIN(ts|h)·MAX(ts|h) 동시 사용 0 을 스윕한다.
    · 원본을 읽는 경로는 `historyRangeAsync` — 6시간 조각(버킷 정배수, 첫 경계는 시작 이후 첫 버킷 경계)마다 양보하고 결과는 `historyRange` 와 같다
      (테스트가 dead-band·일반 계열 × 1분·5분 × 경계 아닌 시작 × 조각 크기로 대조). 라우트는 같은 서버·기간 결과를 30초 기억하고 진행 중 조회에 합류한다.
    · 실측(합성 813만 행, 1분마다 807계열): 7일 처음 1,328ms → 74ms · 다시 217ms → 13ms · 최장 멈춤 1,288ms → 27ms. ⚠ 이 컨테이너는 임의 읽기 0.05ms 라
      운영 시간은 더 길다(운영 DB 로는 재지 못했다). **남은 것**: 24시간(5분)은 여전히 원본 1,440행/계열을 읽는다(조각·양보로 멈춤만 줄였다).
- ⚠⚠ **Overview 카드 8장 · 전체 소비 전력(v2.664) — 합산은 `server/src/power/total.js buildPowerTotal` 하나**(Overview 카드와 특수 기능
  `power-total` 이 같은 함수. `GET /overview/cards`·`GET /tools/power-total`, `routes/api/overviewCards.js` · 웹 `overviewCardsText.js`·`tools/PowerTotal.jsx`):
  · 서버 = `allMeasuredPower` 중 **vCenter 추정(source 'vcenter') 제외** · 네트워크 = CVP PSU `power.inW` 합(없으면 outW, `outputOnly` 로 밝힘 — 필드명 추정) ·
    스토리지 = 스냅샷 `extra.power.watts`(지금은 Unity SSH 뿐 — 그 밖은 `unsupported`). 못 읽음·6시간 넘은 값은 더하지 않고 센다(0 W 금지).
  · Unity 전원은 `SPECS` 맨 뒤 **lowPriority** 항목(`svc_diag -s spinfo`, 25초) — 예산 산수 테스트가 lowPriority 를 1.25배 합에서 빼되 '맨 뒤 · required 아님' 을
    고정한다. 합계는 **DPE 만**(확장 DAE 없음). v2.542 '이 경로에서 spinfo 를 부르지 않는다' 는 이 항목 하나만 예외(테스트 고정).
  · 카드 수치는 등록부·스냅샷 조합(장비 왕복 0). 범위 계정에는 vCenter 축이 없는 값(Agent·스토리지·CVP·전력)을 null + 사유. 가상 서버 수는 롤업과 같은 기준(템플릿 포함).
  · 예전 한 줄 KPI 자동 숨김(kpisRef)은 지웠다 — 8장을 다 보여야 한다(`.ov-cards8` 4열 → 900px 이하 2열).
- ⚠⚠ **HPE iLO 는 iDRAC 스캔 모듈이 함께 찾는다 — 새 수집기를 만들지 않았다**(v2.610, 사용자 요청 "idarc 찾는 모듈에다가
  id/pw 부분만 추가해서 ip 대역을 스캔할때 dell 서버와 hpe 서버를 한번에" + "스캔하면 HPE 서버가 몇 대라는 것을 리스트에"):
  - 대역 엔트리에 `ilo: {username, password}`(선택). `password` 라는 필드 이름이라 secretVault 가 중첩 객체까지 봉인한다 —
    **필드 이름을 바꾸지 말 것**(바꾸면 암호화 모드에서 평문이 된다). 저장 규칙은 iDRAC 비밀번호와 같다(빈 입력 유지 · 대역·엣지·
    iLO 계정이 바뀌면 승계 안 함 — `droppedSecrets` 에 `iloPassword`).
  - ⚠⚠ **벤더를 먼저 가르고 그 벤더 계정으로만 로그인한다**(`probeIdrac(…, {credsFor})`): 서비스 루트는 무인증이라 로그인 전에
    벤더를 안다. HPE 에 Dell 계정을 보내면 매 스캔 iLO 에 실패 로그인이 쌓여 **계정이 잠긴다**. 계정이 없는 벤더는 로그인하지 않고
    `noCreds`(인증 실패로 세지 않는다). iLO 계정이 없으면 예전 동작 그대로다(HPE = 미지원 서버).
  - 실행 엔트리는 `scanRanges.scanEntryRuntime` 하나가 만든다 — 예전엔 세 곳(enabledScanRanges·수동 단건·법인 전체)이 각자 조립했다.
    iLO 계정만 있는 대역도 스캔 대상이다(`scanEntryReady`).
  - 등록: HPE 는 **iLO 계정 + `vendor:'hpe'`**(`registerScanned(…, {ilo})`). 계정 없는 벤더 항목은 등록하지 않고 `skippedNoCreds`.
    전력·센서·인벤토리는 표준 Redfish(`/Chassis/*/Power`·`Thermal`·`Systems`)라 그대로 돌고, Dell 전용 racadm 대체 경로는
    `bmusage/targets.js` 가 HPE 에 걸지 않는다.
  - 'HPE N대' 는 `hpeDetected`(서비스 루트 판별 — 로그인 무관)다. 구버전 엣지 회신은 미지원 목록 `vendor=hpe` 개수라 하한이고
    `hpeDetectedApprox` 로 '대 이상' 을 붙인다(`central/idracScanJobs.hpeCountsOf`).
  - ⚠ 정직 기록: 실제 iLO 장비로 확인하지 못했다(가짜 Redfish 서버). `scanForIdracs` 는 IP 리터럴 + 루프백 차단이라 단위 테스트가
    probe·등록·저장·잡 단위로만 고정한다. 수동 임시 스캔 창·스캔 대역 CSV 는 iLO 계정을 아직 다루지 않는다.
- ⚠⚠ **법인별 서버 사용량(v2.625) — 퍼센트를 더하지 않는다. 사용률 × 용량으로 사용량을 만들어 더한다**
  (`server/src/corpusage/build.js`(순수) + `routes/api/corpUsage.js GET /tools/corp-usage` + 웹 `views/tools/CorpUsage.jsx`·
  `corpUsageText.js` + `bmusage/targets.js` 가상화 블록. 사용자 요청 "iDRAC 사용량을 ESXi 호스트까지 넓혀서 · 법인별 전체/다빈치/IRS ·
  서버 전체/물리/가상화 CPU·메모리 사용량을 1페이지에". 선택: 별도 스위치 + 법인 선택 · 못 읽은 ESXi 는 vCenter 값 + 출처 ·
  사용량 합 + 가중 사용률 · 전체 검증. 회귀 `server/test/corpUsage2625.test.js`(변이 11/11) + 웹 `corpUsageText.test.js`):
  - **대상 판정을 복제하지 않는다** — 물리 = `classifyFleet().bareMetal`, 가상화 = `.virtualizationHosts`(합성 행 제외). ESXi 호스트와
    iDRAC 등록의 연결은 `fleetInventory` 가 싣는 `idracServerId`(받침 iDRAC 의 등록 id — 엣지 보고분은 빈 값)다.
  - ⚠⚠ **지표마다 분모가 다르다** — CPU 만 읽은 서버는 메모리 분모에 넣지 않는다(분자·분모가 같은 서버 집합이어야 사용률이 참).
    못 읽음·오래됨(`freshMs` = 수집 주기×3, 최소 30분)·용량 모름은 합계에서 빼고 **따로 센다**(한 서버는 한 사유). 분모 0 이면 null.
  - **vCenter 대체는 가상화 호스트만, 연결된 호스트만**(`store.usageReadable` 과 같은 기준). 물리 서버에는 vCenter 값이 없다 —
    대체하면 다른 뜻의 숫자를 섞는다. 출처(`src`: idrac·os·vcenter)는 개수로 화면에 남긴다.
  - **ESXi iDRAC 수집은 `bmusage` 설정 `includeVirtualization`(기본 꺼짐)** — 켜도 법인 선택·`idracTelemetry` 를 그대로 따른다.
    경로는 iDRAC 하나(ESXi 에 OS SSH 금지). site vCenter 의 호스트는 그 엣지(`collectedBy`)가 읽는다 — 중앙이 읽으면 iDRAC 세션이 두 배.
    베어메탈로도 잡힌 같은 박스(같은 key)는 한 번만. 꺼져 있으면 제외 목록에도 싣지 않는다(수백 행이 베어메탈 사유 목록을 덮는다).
    엣지 봉투·중앙 정제(`bmUsageEdgePull.sanitizeBmUsageSnap`)에 새 설정 필드를 함께 넣었다 — **새 필드를 만들면 정제 화이트리스트도**.
  - 엣지 수집 법인의 값은 **중앙이 가져온 엣지 보관분(인메모리)** 에서만 읽는다(상시 push 없음) — 없거나 오래되면 합계에서 빠지고 안내가 말한다.
  - 응답은 **법인 합계만**(서버 이름·주소 0 — 테스트가 호스트 이름 누출 0 을 고정) · 범위 계정은 허용 법인만 + 귀속 없음 null ·
    memoJson 12초(scopeKey) · 폴링 금지. 법인 구분은 이름의 IRS(V6 `siteGroupOf` 와 같은 규칙).
  - ⚠ 정직 기록: 목 데이터에 베어메탈·iDRAC 텔레메트리·IRS 법인이 없어 Chromium 검증은 vCenter 경로 + 응답 합성(물리·IRS 행)으로 했다.
  - ⚠⚠ **v2.626 — 물리 서버의 법인 귀속은 `idrac/corpAttribution.js` 하나다**(사용자 신고 "물리서버 사용량 안됨" — 전 법인
    '물리 서버 — 서버 없음'): `fleetInventory.resolveVc` 는 등록부 vcenterId·수동 지정만 보고, 개요(v2.583 `serversByCorp`)는 호스트명·
    서비스태그·DataCenter 단일 vCenter 까지 본다 — 이 현장 물리 전용 서버는 마지막 규칙으로만 귀속돼 사용률 쪽에서 전부 '귀속 없음'
    (수집 제외·합계 제외)이었다. `attributeBareMetalFromSnap` 이 **빈 법인만** 채운다(`vcSource:'corp-rule'` · 기존 귀속 불변 ·
    같은 태그가 두 법인이면 채우지 않는다). 수집 대상(`bmusage/poller.js`)·법인별 사용량·개요가 같은 모듈을 쓴다 — **사본을 만들지 말 것**.
    ⚠⚠ **엣지는 로컬 등록 물리 서버를 가져간다**(`targets.js` `mine = !owner || owner === me`) — 예전 `owner && owner === me` 는
    remoteAgent 가 없는 엣지 로컬 서버를 전부 '위임됨' 으로 빼서 **v2.550 부터 엣지가 물리 서버를 한 대도 수집하지 못했다**
    (옛 테스트가 그 동작을 고정하고 있었다 — 중앙 관점 픽스처로 엣지를 시험한 탓). ✅ 엣지 bm-usage 설정의 중앙 배포는 v2.627 에 만들었다(아래).
  - ⚠⚠ **v2.627 — 베어메탈 사용률 설정은 중앙이 엣지에 배포한다(한 번에 켜기)**(사용자 요청 "한번에 켜는 기능" · 선택: **중앙 설정이
    엣지를 따른다** · **Enterprise 는 배포하지 않음** · 전체 검증. `bmusage/settings.js` 배포 절 + `agent/bmUsageConfigPull.js` +
    `GET /api/central/bmusage-config` + `PUT /tools/bm-usage/distribute` + 웹 `bmUsageDistText.js`. 회귀 `test/bmUsageDistribute2627.test.js`
    — 실제 centralRouter 를 띄워 엣지 인출을 부른다, 변이 4/4 검출):
    · 배포 원본은 **중앙의 로컬 설정 그 자체**다(두 벌을 두지 않는다). 중앙 `bmusage-distribute.json`(켬 + 엣지별 제외 — 설정) ·
      엣지 `bmusage-central.json`(받은 사본 — **상태**, 백업 감시 제외). 엣지 유효 설정 = 로컬 위에 `DISTRIBUTED_KEYS` 만 겹친 것.
    · ⚠⚠ **`DISTRIBUTED_KEYS` 에 `enterprise*` 를 넣지 말 것** — v2.554 의 '장비 부하 동의' 는 그 엣지 관리자의 것이다(테스트가 고정).
    · 엣지가 배포 중이면 저장은 배포 키를 **저장하지 않고** `ignoredCentralManaged` 로 밝힌다(로컬 파일에 써 두면 배포를 끈 뒤 엉뚱한
      값이 살아난다). 화면은 배포 키 입력을 잠그고 배너로 말한다 — Enterprise 칸만 열려 있다.
    · 중앙이 `distribute:false`(끔·그 엣지 제외 — 이름은 대소문자 무시)를 **명시**할 때만 사본을 지운다. 오류·회선 장애·404 는 사본
      유지(한 번의 장애가 28곳을 로컬로 되돌리지 않게). 적용이 바뀌면 `notifyChange` 로 폴러를 재무장한다.
    · 엣지는 `?applied=<sig>` 로 적용 판을 알리고 중앙은 **인메모리**로 기록한다 — 화면 상태 적용됨/대기/인출 기록 없음/제외/꺼짐.
      '인출 기록 없음' 을 실패라 말하지 않는다(재시작 직후·2.627 미만 엣지). 배포 현황은 **전체 범위 admin + 중앙** 에만 싣는다.
    · 저장 즉시 바뀐 척하지 않는다 — 엣지는 다음 인출(`AGENT_BMUSAGE_CONFIG_PULL_MS` 기본 10분, 첫 인출 기동 45초 뒤)에 받는다.
    · ⚠ 정직 기록: 목 스택 2대(중앙+엣지 `Edge-Seoul`)로 꺼짐 → 켬(적용·폴러 주기 600초로 재무장) → 제외(로컬 복귀)를 실제로 돌렸다.
      실엣지 28곳 규모·구버전 엣지 혼재·인증 켠 상태의 viewer 화면은 보지 못했다(배포 절은 서버가 admin 이 아니면 null 로 준다).
    viewer 는 기본 권한에 `tools` 가 없어 막히는 것이 정상이고, tools 를 준 범위 viewer 로 허용 법인 1곳만 보이는 것을 확인했다.
  - ⚠⚠ **v2.927 — '중앙에서 켜기'(한 엣지만)**(사용자 요청 "중앙에서 엣지를 켜는 기능 추가" · 선택: 엣지별 버튼 · 전체 검증 · 반증 1회 반영.
    `bmusage/settings.js` perEdge 절 + `bmusage/edgeCorps.js` + `targets.js siteOwnerByVcenter/edgeCorpIndex` + `PUT /tools/bm-usage/distribute/edge` +
    `central/bmUsageEdgePull.js edgeRoleOf` + 웹 `bmUsageDistText.js edgeOnView·edgeOnConfirmLines`. 회귀 `server/test/bmUsageEdgeOn2927.test.js`(실제 토큰 인증 경로) ·
    `web/.../bmUsageEdgeOn2927.test.js`):
    · **엣지 코드는 바꾸지 않았다** — 2.627 이상 엣지가 그대로 받는다. 그래서 중앙은 그 엣지에 **배포 키 전부**(중앙 로컬 값)를 보내되 켜기 = true · 법인 = 저장한 그 엣지 법인.
      ⚠ 일부 키만 보내지 말 것: 엣지 `applyCentralBmUsage` 가 `normalizeSettings` 로 빠진 키를 **기본값**으로 채워 주기·보존을 조용히 바꾼다(테스트가 키 집합을 고정).
      부작용(주기·보존·OS SSH·iDRAC·알림이 중앙 값으로 바뀜 · 해제하면 엣지 로컬로 복귀 · **보존이 짧아지면 넘친 이력은 정리되고 해제해도 돌아오지 않음**)은
      확인 상자가 **값과 함께**(서버 `perEdgeBase`) 말한다.
    · ⚠⚠ **법인은 저장 때 확정한다**(반증 F2·F3): 관리자가 확인 상자에서 본 목록을 `perEdge[agent].corps` 로 저장하고(화면이 그 목록을 PUT 에 싣는다 — 지금 매핑과 다르면
      409 `corps-changed`), 엣지 인출은 **저장 목록을 그대로** 보낸다. 예전(인출마다 매핑 재계산)에는 점검중·비활성 site vCenter · 인벤토리 push 전 · fleet TTL 만료 ·
      중앙 재기동 같은 순간 상태에서 법인이 빠지고, 0 이면 `no-corps` 로 엣지가 사본을 지워 **수집이 꺼졌다**(반증 실측). 지금 매핑이 저장 목록과 다르면 행·배포 패널이
      '법인 매핑이 바뀜 — 다시 확인 필요' 를 보이고, '다시 확인'(같은 PUT)이 갱신한다. 저장 때 매핑 0 이면 400 `no-corps` — 이미 켜진 엣지에 0 을 보내 끄는 경로는 없다.
      그래서 v1 의 첫 병합 전 503 `mappingNotReady` 보류도 없앴다(인출이 매핑을 보지 않는다). 법인 없는 항목(손으로 고친 파일)은 버리고 `perEdgeOmitted` 로 센다.
    · 저장 시점 매핑(`edgeCorpIndex`): 담당 엣지 = **등록부 `remoteAgent` → 위임 인벤토리 소유(`listInventory().agent`) → 스냅샷 관측 collectedBy**(선례 vmclone/dispatch.js
      execTargetOf · ipam/scanDatacenter.js — 디스크 원천이 먼저라 점검중·골격에도 흔들리지 않는다) + 엣지 보고 베어메탈 vcenterId(중앙이 아는 id 만 · 다른 엣지 담당 사이트
      vCenter 제외). 관측 규칙은 resolveTargets 와 같은 `siteAgentByVcenter`(소스 스윕이 한 곳을 고정).
      ⚠ 정직 기록(반증 F3 정정): fleet 수신은 **모르는 이름**의 공유 토큰 push 귀속만 비운다 — 아는 이름(토큰·인벤토리 등)을 댄 공유 토큰 push 는 그 엣지의 베어메탈 귀속을
      바꿀 수 있고(직접 수집 vCenter 는 TOFU), 그래서 **저장 시점 매핑은 공유 토큰 push 영향을 받을 수 있다** — 확인 상자가 법인 이름을 보여 주고 관리자가 확인한 목록만 저장한다.
    · 우선순위: ① 전체 배포 켬 + 제외 아님 → 전체 배포(v2.627 그대로 — 기존 구성 동작 불변) ② 중앙 켜기 ③ 제외·꺼짐. 조용한 우선순위 금지:
      이미 전체 배포를 받는 엣지에 새 켜기 저장 = 409 `all` · 제외 ↔ 중앙 켜기는 **양방향 409**(반대 지시 — 하나를 먼저 푼다) · 전체 배포를 켜서 가려진
      중앙 켜기는 응답 `perEdgeSuperseded` · 행 · 요약 문구가 밝힌다(가려진 행의 해제 문구는 '전체 배포가 계속 적용됩니다' — 반증 F4). 손으로 둘 다 만든 파일은
      **제외가 이긴다**(장비 부하를 더하지 않는 쪽 · 행 `conflict`).
    · 중앙 켜기 판은 **개별 토큰으로 검증된 인출에만** 준다(공유 토큰 `?agent=` 는 남의 이름을 댈 수 있다 → `per-edge-unverified` · 엣지는 사본을 지운다 · 화면 '받지 못함(공유 토큰)').
      저장 화면은 개별 토큰이 발급되지 않은 엣지를 미리 경고한다(`tokenIssued`).
    · **엣지 노드에만**(반증 F7): 보관분 `node.role`(엣지 export — CENTRAL_URL 이 있으면 'edge')을 `edgeRoleOf` 하나로 판정해 `/edges` 행 `nodeRole` 로 싣는다. 'edge' 가
      아니면 버튼 대신 '이 노드는 엣지가 아닙니다 — 그 포탈의 베어메탈 사용률 설정에서 직접 켜세요'(모르면 '역할을 확인할 수 없어 중앙 켜기를 제공하지 않습니다') · PUT 도 409 `not-edge`.
      중앙·단독 노드는 배포 인출 워커가 없어 저장해도 영원히 '켜기 지시됨' 이었다.
    · 배포 현황은 **행마다 그 엣지에 보낼 판(저장 법인)의 서명**과 비교한다(전역 서명 하나와 비교하면 중앙 켜기 행은 영원히 '대기' — 매핑이 바뀌어도 서명은 그대로).
      해제·배포 끔 직후 아직 사본을 쥔 엣지는 `releasing`(해제 대기).
    · 라우트 게이트는 전체 배포와 같다(adminOnly + fleetOnly) · 켜기 이름은 등록부(`knownAgentNames`)에 있는 것만(404) · **해제는 저장된 지시가 있으면 등록부와 무관하게**
      (반증 F1 — 토큰 폐기로 등록부에서 빠진 엣지의 지시가 지워지지 않고 재발급하면 바로 켜졌다) · 엣지 노드 409 `edge-node` · 상한 넘는 저장 400 `too-many`(엣지 256 · 엣지당 법인 64 —
      조용히 버리지 않는다) · 감사 `bm-usage.distribute.edge`(target = 엣지 · 법인 수).
    · 화면: '엣지에서 꺼짐' 행에만 '중앙에서 켜기'(배포 현황을 받은 전체 범위 관리자 · 중앙 · 엣지 노드) → 표 아래 확인 상자 → 저장 뒤 지시 상태 '켜기 지시됨 — 다음 인출 대기'
      → 전달됨 → 적용됨을 **보관분 상태와 함께**(대체하지 않는다 — 반증 F8, 보관분 오래됨·실패가 보이게). 전체 배포가 끈 엣지는 '중앙의 전체 배포 설정이 끄고 있습니다'(반증 F5).
      예전 문구 '중앙에서는 켤 수 없습니다' 는 v2.627 부터 사실이 아니었다 — 정정했다.
    · 손상된 배포 파일의 '기본값으로 확정'(설정 파일 점검)은 전체 배포 · 제외 · 중앙 켜기를 **모두 비운다** — 라벨이 그 사실을 말한다.
    · ⚠ 정직 기록: 중앙+엣지 목 스택 2대(개별 토큰 · 엣지 `AGENT_BMUSAGE_CONFIG_PULL_MS=60000`)로 꺼짐 → 켜기(적용 · 엣지 유효 설정 켜짐 · 그 법인 · 주기 10분) → 해제(로컬 복귀)를
      실제로 돌렸다. 실엣지 28곳 · 구버전(2.627~2.924) 엣지 실물 · 엣지 보고 베어메탈만으로 매핑되는 법인(vCenter 직접 수집 + iDRAC 위임)은 실물로 보지 못했다(순수·라우터 테스트만).
      사용자 화면의 'OC2' 가 엣지인지 중앙·단독 노드인지는 확인하지 못했다 — 이제 화면이 보관분의 노드 역할로 판정해 버튼을 주거나 막는다.
- ⚠⚠ **v2.634 — 폴러의 표본 시각은 '그 서버를 실제로 읽은 시각' 이고, 신선도 경계는 폴 주기 소요에 맞춰 넓힌다**
  (`idrac/poller.js` sensorAt·powerAt · `idrac/sensorStore.js sensorPollCycle` · `idrac/roomTemp.js effectiveMaxAgeMs`·
  `sampleMaxAgeMs` · 엣지 `compactSensors` 의 `cycleMs`·`intervalMs` · 웹 `roomTempView.staleCardMeta`·`staleBannerText` ·
  서비스 점검 `idrac-cycle` 행. 사용자 신고 "예전에는 온도가 나왔는데 … 수집을 못하고 있어" — 법인 전산실 온도
  '측정 0/980 · 미갱신 975'. 회귀 `server/test/roomTempCycle2634.test.js`(변이 7/7) + 웹 `roomTempStale2634.test.js`):
  - **원인 두 겹**: ① 표본 시각이 주기 시작 시각 하나였다(v2.550.3 bmusage 규약의 iDRAC 누락) ② 경계 15분이 주기 소요를
    몰랐다 — 한 주기가 15분을 넘으면 정상 서버가 전부 빠진다. ⚠ ①만 고쳐도 ②는 남는다(같은 서버의 두 표본 간격이 주기 소요다).
  - 경계 = `max(15분, min(상한 2시간, 2×주기 소요 + 간격))`. 주기 정보가 없으면 **넓히지 않는다**(추측 금지). 원격 표본은
    **엣지가 보낸 자기 주기만** 쓴다 — 중앙 폴러 주기를 엣지 서버에 적용하지 말 것. 구버전 엣지는 15분 그대로.
  - 법인 전산실 온도 · 서버 온도 화면 · 서버 온도 시계열이 같은 `sampleMaxAgeMs` 를 쓴다 — 새 신선도 판정도 이것을 쓸 것.
  - 응답 `staleMsMax`(실제로 쓴 최대 경계)를 화면이 말한다 — '15분' 이라 적고 41분을 쓰면 거짓이다.
  - ⚠ 정직 기록: 운영 포탈의 실제 주기 소요는 보지 못했다(추정). 서비스 점검 'iDRAC 폴 주기' 행이 그 값을 보여준다 —
    주기가 짧은데도 계속 비면 다른 원인이다. `lastRun.at` 은 호환을 위해 여전히 주기 **시작** 시각이다(`finishedAt` 별도).

  · v2.770(점검 R5-E4): replace 스캔의 부분 판정(`scanPartialReasons`)에 **인증서 미신뢰(tlsUntrusted)** 를 넣는다 — 실재가 확인된 장비라 authFailed 와 같은 근거로 merge 강등(일반 무응답은 강등하지 않는다 — 폐기 서버를 지울 수 있어야 한다).
    교체로 지운 등록은 `removedIds` 로 결과·감사 로그(`idrac.scan.replace.removed`)·중앙 정제까지 남긴다. 등록부 accessMoved 는 **정규화한 host** 로 비교(스킴 없는 같은 주소를 이동으로 보지 않는다), CSV 에 없는 열은 키를 만들지 않는다.
