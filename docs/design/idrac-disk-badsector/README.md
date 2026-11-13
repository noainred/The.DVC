# 설계: iDRAC 디스크 배드 섹터 이력 — 이 서버에서 과거에 배드 섹터가 난 적이 있는지 찾기

작성 2026-11-14 (v2.914.0 기준) · 상태 **시안 — 컨펌 대기**(구현 전) · 시안 캔버스: https://claude.ai/artifact/FB317UnqoXFZQjPAGdM2xU
(아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 서버 이름 · IP · 서비스태그 · 시리얼 · 건수 · 날짜는 **전부 가상**이고
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로. 계정의 ‘Design System’ 아티팩트는 내용이 비어 있어(자기 파일 0개) 쓰지 않았다.)

## 1. 요구(사용자 2026-11-14)

- "Idrac 에서 과거에 이 서버에서 하드디스크가 배드 섹터 발생한적 있는지 찾는 기능 시안 만들어줘"
- 규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현(2026-11-03 '기억해').

## 2. 지금 코드(확인 — 2026-11-14)

| 사실 | 위치 |
|---|---|
| 하드웨어 이벤트는 SEL → 없으면 LC 로그를 한 번만 GET 해(쪽 넘김 없음) 그 응답의 **끝 40건** 중 Critical/Warning **최대 15건**만 싣는다. 메시지는 200자 · MessageId 는 버린다(메시지가 없을 때만 대신 쓴다) | `server/src/idrac/redfish.js:789-803` |
| 디스크는 Health · State · `FailurePredicted`(없으면 null) 만 읽는다. 미디어 오류 수 · 불량 블록 수는 읽지 않는다 | `server/src/idrac/redfish.js:732-750` |
| 이벤트를 쌓아 두는 곳이 없다 — 인벤토리는 매번 덮어쓴다. 과거 조회는 '지금 iDRAC 에 남아 있는 로그' 가 전부다 | `server/src/idrac/invCache.js` · `redfish.js` |
| 위임 법인(엣지) 서버는 중앙이 iDRAC 에 직접 못 닿는다 — 상세는 엣지가 실어 보낸 인벤토리 그대로, 즉시 재수집 · GPU 프로브는 **불가** | `server/src/routes/admin/idracScan.js:85-88 · 229` |
| 서버 상세 화면은 탭 3개(센서 차트 · 하드웨어/버전 · GPU 수집 확인), 폭 980px 모달 | `web/src/views/idrac/IdracDetailModal.jsx:221 · 305-307` |

→ 지금 구조로는 '과거에 배드 섹터가 났는가' 를 답할 수 없다(끝 40건 밖이면 보이지 않고, MessageId 가 없어 분류도 못 한다).

## 3. 화면 — 아트보드 3장

서버 상세 모달에 네 번째 탭 **‘디스크 이력’** 을 더한다.

```
서버 상세 › 디스크 이력
 ├ Main    기록 있음 — 조회 줄 · 판정 띠 · 수치 4칸 · 슬롯별 발생 시점 · 기록 표 · 지금 디스크 표 · 읽는 법
 ├ States  상태 8가지 — 조회 전 · 조회 중 · 기록 없음 · 기록 없음+로그 짧음 · 일부만 읽음 · 인증 실패 · 엣지 무응답 · 대상 아님
 └ Narrow  400px — 표 대신 카드 목록, 기록 없는 슬롯은 접음
```

화면이 지키는 것:

1. **‘기록 없음’ 은 ‘발생한 적 없음’ 이 아니다.** 판정 옆에 항상 '로그가 남아 있는 구간(가장 오래된 로그 ~ 오늘)' 을 쓰고, 그 이전은 빗금으로 '확인 불가'.
   기록 없음을 초록 '정상' 으로 칠하지 않는다(중립 띠). 로그 구간이 짧으면 경고 띠로 올린다 — 이유(지움 · 보드 교체 · 덮어쓰기)는 단정하지 않는다.
2. **못 읽음 · 일부만 읽음은 판정하지 않는다.** 인증 실패 · 엣지 무응답은 '읽지 못했습니다', 시한 초과는 '여기까지만 읽었습니다 + 이어서 조회'.
3. **어느 디스크의 기록인가.** LC 로그 메시지는 슬롯(Disk N in Backplane …)만 말하고 시리얼은 없다. 같은 슬롯의 제거 · 삽입 기록으로
   '교체 전 디스크 / 현재 장착' 을 나눈다 — 그 기록이 로그에 없으면 나누지 못한다(화면 '읽는 법' 에 적음).
4. **지금 상태와 이력을 나란히.** 현재 Health 가 OK 여도 이력이 있으면 그 사실을 같은 표에서 보여 준다.
5. 무거운 조회라 **탭을 열 때 자동으로 돌지 않는다**(버튼) · 진행 중 잠금은 그 서버만 · 마지막 결과는 보관해 다시 열면 바로 보인다.
6. 표는 `STable`(머리글 정렬 · `minWidth`), 문구에 백틱 없음, 대문자 변환 없음, 값이 없으면 '—'.

## 4. 분류 — 무엇을 ‘배드 섹터 계열’ 로 세는가

| 분류(화면) | MessageId | 뜻 | 근거 |
|---|---|---|---|
| 복구 불가 | PDR46 | Patrol Read 가 고칠 수 없는 미디어 오류를 찾음 | 문서 확인(Dell VRTX 매뉴얼 — 출처 ①) |
| 복구 불가 | PDR47 | 컨트롤러가 블록을 puncture 처리 | 문서 확인(①) |
| 복구 불가 | PDR64 | 리빌드 · 복구 중 복구 불가 미디어 오류 | 문서 확인(Dell KB — ②) |
| PDR54(화면에 ID 그대로 — §9) | PDR54 | 미디어 오류를 복구 중에 고쳐 씀 | 문서 확인(Dell 커뮤니티 — ③) |
| 고장 예측 | PDR16 | SMART 고장 예측 보고 | 문서 확인(Dell KB — ④) |
| 복구 불가 | PDR63 | 쓰기 중 불량 블록을 다른 블록으로 옮기지 못함(critical) | 문서 확인(§12.1 ⑤⑥) — 2026-11-14 5차에 분류에 추가 |
| (후보 — 문서 확인됨) | PDR59 · PDR57 | 불량 블록을 옮김(정보성 · 손실 없음) · 불량 블록 표가 차 감(warning) | 문서 확인(§12.1 ⑦⑧). 분류에 넣을지는 미정(§12.5-1) |
| (후보) | PDR56 | 불량 블록 표 80%(기억) | **미확인** — 검색 결과에서 PDR56 문구를 특정하지 못했다 |
| 교체 구분 | PDR5 | 디스크가 디스크 그룹에서 빠짐. **케이블 · 인클로저 문제로도 뜬다** | 문서 확인(§12.1 ⑨⑩) → PDR5 만으로 ‘교체’ 라고 판정하지 않는다(§12.4-6) |
| (후보) | 디스크 삽입 ID(기억: PDR8) | 디스크 삽입 | **미확인** — ‘PDR8 is inserted’ 를 적은 문서를 찾지 못했다 |
| (후보 — 문서 확인됨) | VDR57 · VDR93 · VDR47 | 가상 디스크 쪽 불량 블록 · 미디어 오류 기록 | 문서 확인(§12.1 ⑪) · VDR47 은 커뮤니티 글(⑫). 물리 디스크를 가리키지 않아 슬롯 귀속 불가 — 분류에 넣을지 미정 |

출처: ① https://www.manualsdir.com/manuals/620821/dell-poweredge-vrtx.html?page=450 · ② https://www.dell.com/support/kbdoc/en-ca/000218950/gen5a-physical-disk-failure-eventid-52807 ·
③ https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/R720XD-Correctable-Disk-Media-Errors/td-p/5183008 · ④ https://www.dell.com/support/kbdoc/en-uk/000126418/poweredge-hdd-what-is-predicted-drive-failure-and-how-to-solve-it

시안의 메시지 원문(영문)은 형식을 흉내 낸 가상 문장이다 — 실장비 문장과 글자가 다를 수 있다. 분류는 문장이 아니라 **MessageId** 로 한다.

## 5. 수집 방식(제안)

- 경로: `Managers/<id>/LogServices/Lclog/Entries` 를 `$skip` 으로 넘겨 가며 끝까지 읽는다(`$skip` 순회는 PowerShell Gallery 공개 모듈
  `Get-IdracLifecycleLogsREDFISH` 설명으로 확인). **`$filter` 로 MessageId 만 받아 올 수 있는지 · 한 쪽 건수 · LC 로그 최대 보관 건수는 미확인** —
  실장비 1대로 먼저 잰다. `$filter` 가 되면 조회가 크게 짧아진다.
- **법인 쪽에서 돈다**(운영 규칙 '작업 하나를 법인에 보내 로컬에서 묶어 돌리고 요약만 올린다'): 중앙이 800ms RTT 로 수백 쪽을 왕복하지 않는다.
  엣지 위임 서버는 지금 즉시 조회 수단이 없으므로 **엣지 작업 워커가 새로 필요**하다(전례: `agent/idracScanWorker.js` · `agent/logQueryWorker.js`).
  엣지가 없는 법인(중앙 직결 등록 서버)만 중앙이 직접 읽는다.
- 올리는 것은 요약뿐: 읽은 건수 · 가장 오래된/최신 로그 시각 · 스토리지 계열 건수 · 분류된 기록(시각 · MessageId · 메시지 · 슬롯). 중앙은 아는 필드만 정제(화이트리스트 · 상한).
- 보관: 중앙 SQLite 에 서버별로 쌓는다(트랜잭션 · `(서버, 로그 항목 Id)` 중복 제거). 다음 조회에서 iDRAC 로그가 덮어써졌어도 앞서 찾은 기록은 남는다 —
  이때 '로그가 남아 있는 구간' 과 '포탈이 보관한 기록' 을 구분해 보여 줘야 한다(시안에는 첫 조회만 그렸다).
- 보호: 서버당 동시 1건 · 장비 시한(세션을 실제로 끊음) · 시한 초과 시 읽은 곳(커서)을 저장해 이어서 · 인증 실패는 자동 재시도 없음(`util/authGuard.js`) ·
  관리자 전용 + 범위 밖 404(`/admin/idrac/:id/…` 와 같은 게이트).

## 6. 정해 주실 것

1. **범위** — (가) 이 서버 하나를 버튼으로 조회(시안 그대로) · (나) 가 + 전 서버 목록 화면(특수 기능에 ‘디스크 배드 섹터 이력’ — 어느 서버에 이력이 있는지 한눈에) ·
   (다) 나 + 주기 자동 수집(새 기록이 생기면 파트 장애 알림과 연결). 시안은 (가)만 그렸다.
2. **PDR54 를 배드 섹터 기록으로 셀지** — 시안은 센다(색만 다르게 · 표기는 ‘PDR54’). 복구 불가만 세면 판정 띠가 더 보수적이 된다.
3. **HPE iLO** — 시안은 '대상 아님'. iLO IML 까지 넣을지.
4. **위치** — 서버 상세의 새 탭(시안) vs 하드웨어/버전 탭의 물리 디스크 표 아래.

## 7. 구현 규모(추정 — 컨펌 뒤 다시 잰다)

엣지 작업 워커 + 중앙 수신 · 정제 + SQLite 보관 + 분류 코어(순수 함수 · 테스트) + 라우트 + 탭 화면 + 데모(mock) 데이터 + Chromium 1440/400.
위험 등급: 엣지 수신 계약 · 자격증명 경로가 걸려 변이 검증 대상. 실장비 확인(§4 미확인 ID · §5 `$filter`) 없이는 분류표와 소요 시간을 확정할 수 없다.

## 8. 추가 요구(사용자 2026-11-14 2차) — 아직 사용 중인지 · 전 법인 분석

- "과거에 배드 섹터 발생한 디스크를 아직 사용하고 있는지 확인하는 기능 가능해? 찾는거 가능해?"
- "모든 법인의 디스크를 점검해서 발생빈도 모델별 장애 빈도 트렌드 등등 분석 기능 추가 · 국가별 법인별 발생 빈도"

→ 아트보드 `Fleet.dc.html`(특수 기능 ‘디스크 배드 섹터 분석’) 추가 · `Main` 의 '지금 디스크' 표에 ‘배드 섹터 이력 · 아직 사용 중’ 표지 추가. §6-1 범위는 이 요구로 **(다) 전 서버 주기 수집**이 전제가 된다.

### 8.1 가능 여부(근거)

| 질문 | 답 | 근거 · 조건 |
|---|---|---|
| 배드 섹터 난 디스크를 **아직 쓰는지** | **조건부 가능** — 판정은 셋: 아직 사용 중 / 교체됨 / 판단 불가 | 로그는 슬롯만 말한다(시리얼 없음). ① 기록 뒤 그 슬롯에 제거·삽입 기록이 없으면 '아직 사용 중'(로그로 미룸 — 제거·삽입 MessageId 는 §4 미확인) ② 포탈이 수집할 때마다 (서버·슬롯·시리얼)을 적어 두면 그 뒤로는 시리얼 대조로 확정. 둘 다 없으면 '판단 불가' |
| 지금 시리얼 | 중앙 직결 서버는 이미 읽는다. **엣지 위임 서버는 중앙에 시리얼이 없다** | `redfish.js:738 serial` · `collector/compactInv.js:50`(disks 에 serial 없음) → 축약 인벤토리와 중앙 `INV_SHAPE` 를 한 쌍으로 넓혀야 한다 |
| 국가 · 법인별 빈도 | 가능 | 법인 귀속 `idrac/corpAttribution.js idracCorpIndex` · 국가 `vcenter/registry.js location.country`(전례: GPU 할당 국가→법인 트리 `gpu/allocTree.js`) |
| 모델별 빈도 | **지금 꽂힌 디스크만 가능** | 모델은 인벤토리에 있다(`redfish.js:737`). 로그에는 모델이 없어, 이미 교체된 디스크의 모델은 알 수 없다 → 비율이 실제보다 낮게 나온다(가장 나빴던 디스크가 빠진다). 포탈 수집 시작 뒤의 교체분부터 채워진다 |
| 월별 추이 | 가능하나 **과거로 갈수록 적게 잡힌다** | 서버마다 로그가 남은 구간이 다르다 → 달마다 '로그가 그 달을 덮는 서버 비율' 을 같이 그린다(시안 추이 아래 파란 막대) |

### 8.2 분석이 말하지 못하는 것(화면에도 적는다)

1. 분모는 **디스크 수**(현재 장착)다. 디스크-년(사용 기간)이 아니다 — 장착일을 모른다(제조 주차 · 가동 시간을 Redfish 로 읽을 수 있는지 미확인).
2. 못 읽은 서버의 디스크는 분자 · 분모에서 모두 뺀다. 법인 행에 '읽음/전체' 를 같이 쓴다.
3. 장착 수가 적은 모델은 '표본 적음' 표지(기준 수는 구현 때 정한다 — 시안은 문구만).
4. **RAID 로 묶이지 않은 디스크**(HBA 모드 · 패스스루 · Ready 상태)는 Patrol Read 가 돌지 않는다 — **문서 확인**(§12.1 ⑬⑭⑮: Patrol Read 는 가상 디스크 구성원 · 핫 스페어에서만 돌고, HBA 모드에서는 설정 자체를 지원하지 않는다). 따라서 그 디스크에는 PDR46 이 생기지 않는다 → '기록 없음' 이 아니라 '이 방법으로는 볼 수 없음' 으로 따로 센다. 남은 미확인: 현행 PERC 10/11/12 · HBA330 문서의 같은 문구, NVMe 직결 디스크, 그리고 포탈이 Redfish 로 '이 디스크가 가상 디스크 구성원인가' 를 읽는 방법.
5. 디스크 자체의 누적 오류 수(재할당 섹터 등)를 Redfish 로 읽을 수 있으면 로그와 무관하게 '그 디스크' 의 상태를 알 수 있다. iDRAC9 스토리지 텔레메트리(SMART 리포트)가 있다는 것까지만 확인했고(Datacenter 라이선스 · `bmusage/parse/idracTelemetry.js:63` 이 리포트 이름을 이미 안다), 속성 이름 · Enterprise 서버 대체 경로는 미확인.

### 8.3 수집이 바뀌는 점

- 버튼 조회(§5)에 더해 **법인 엣지가 주기로 '지난번 이후 새 로그만' 이어 읽는다**(첫 회만 전량). 주기는 설정값 · 서버 동시성 제한 · 인증 실패 정지 · 0건이어도 상태 보고.
- 중앙 보관 표 3개(안): 기록(서버·로그 항목 Id) · 슬롯 시리얼 이력(서버·슬롯·시리얼·처음/마지막 본 시각) · 서버별 수집 상태(읽은 구간 · 커서 · 마지막 오류). 대량 쓰기는 트랜잭션.
- 분석 라우트는 `memoJson` + 범위 키 · 범위 계정은 자기 법인만 · 전 법인 화면은 `fleetOnly` 여부를 정해야 한다(§8.4-3).

### 8.4 추가로 정해 주실 것

1. 주기 수집 간격(시안 문구는 '매일 한 번').
2. 새 기록이 생기면 알림(파트 장애 알림 · 메일)을 보낼지, 화면에만 둘지.
3. 전 법인 분석 화면을 범위 계정(자기 법인만)에게도 열지.
4. 추이 차트 색: 복구 불가 `#ef4444` · PDR54 `#f59e0b`(포탈 `--red`·`--amber`). 색각 분리 · 대비는 검증 통과, **명도 대역 검사는 불통과**(amber 가 대역보다 밝음) — 포탈 배지 관례를 따라 유지했다. 범례 · 2px 간격 · 표로 보완.

## 9. 추가 요구(사용자 2026-11-14 3차) — 범위를 골라 한 번에 점검 · PDR54 표기

- "한번에 전체 서버, 모든 법인의 서버 특정 법인의 서버 점검하는 기능 추가"
- "PDR54 를 PDR54 라고 표시해줘"

### 9.1 표기

- 화면 분류 이름 ‘복구됨’ 을 없애고 **‘PDR54’** 로 쓴다(표지 · 수치 칸 · 범례 · 표 머리 · 차트 툴팁 — `Main` · `Narrow` · `Fleet`). 수치 칸에만 뜻(‘미디어 오류를 고쳐 씀’)을 작게 덧붙였다.
- ‘복구 불가’(PDR46 · PDR47 · PDR64 묶음)와 ‘고장 예측’(PDR16)은 그대로 두었다 — 이것도 ID 로 바꿀지는 미정(§9.4-1).

### 9.2 화면 — 아트보드 `Scan.dc.html`(‘지금 점검’)

분석 화면(`Fleet`) 수집 현황 줄의 **[지금 점검]** 에서 연다.

1. **범위**: ‘전체 — 모든 법인의 서버’ / ‘법인을 골라서’(국가로 묶은 체크 목록 · 찾기 · 고른 법인 칩). 고른 범위의 법인 수 · 서버 수를 시작 버튼 옆에 쓴다.
2. **읽는 방식**: ‘새 로그만 이어 읽기’(기본) / ‘처음부터 다시 읽기’.
3. **진행**: 전체 진행 막대 + 법인별 표(상태 · 서버 n/m · 못 읽음 · 새 기록 · 걸린 시간). 끝난 법인부터 결과가 들어온다. [중단].
4. **끝난 뒤**: 읽은 서버 · 못 읽은 서버 · 새 기록 · 새로 ‘아직 사용 중’ 이 된 디스크 · 걸린 시간 + [못 읽은 서버만 다시 점검].

서버 한 대 점검은 서버 상세 ‘디스크 이력’ 탭의 버튼(§3) 그대로다 — 범위는 서버 1대 / 법인 n곳 / 전체 셋.

### 9.3 동작 규칙(제안)

- 점검 작업은 **법인 단위로 쪼개 각 법인 엣지에 하나씩** 보낸다(법인 · vCenter · 엣지 1:1). 중앙은 법인별 진행 요약만 받는다 — 서버 수만큼 WAN 을 왕복하지 않는다.
- 법인 안에서는 서버 동시성 제한 · 서버당 시한. 느린 법인(RTT 800ms+)이 다른 법인을 막지 않는다.
- **진행 중 잠금은 그 법인만**: 점검 중인 법인은 다시 고를 수 없고, 다른 법인은 따로 시작할 수 있다. 주기 자동 점검과 수동 점검은 같은 재진입 가드를 쓴다.
- 엣지가 작업을 받아 가지 않으면 ‘엣지 응답 없음’ 으로 보이고, **기다리는 시한**(엣지 보고 TTL 보다 짧게)이 지나면 ‘시작 못 함’ 으로 닫는다 — 끝나지 않는 작업을 남기지 않는다.
- 로그인 실패 서버는 ‘다시 점검’ 에 넣지 않는다(계정 잠금 방지 · `util/authGuard.js`). 0건이어도 법인별 상태는 올라온다.
- 권한: ‘전체’ 는 전 법인 권한 계정만(`fleetOnly`). 범위 계정에게는 자기 법인만 목록에 보인다(§8.4-3 과 함께 정한다). 상태를 바꾸는 도구라 메뉴는 ‘운영 작업’ 소속 여부를 정해야 한다.
- 시안의 걸린 시간(6분 12초 · 38분 등)은 **가상**이다. 실제 소요는 서버당 로그 건수 · `$filter` 지원(§5) · RTT 에 달려 있어 실장비로 재기 전에는 말할 수 없다.

### 9.4 추가로 정해 주실 것

1. ‘복구 불가’ · ‘고장 예측’ 도 ID(PDR46 · PDR47 · PDR64 · PDR16)로 표기할지.
2. ‘전체’ 점검을 한 번에 몇 법인까지 동시에 돌릴지(전부 동시 / 몇 곳씩).

## 10. 결정 기록

| 날짜 | 항목 | 결정 | 근거(사용자 말) |
|---|---|---|---|
| 2026-11-14 | 범위(§6-1) | **(다) 전 서버 주기 수집 + 전 법인 분석 + 범위를 골라 점검** | 2차 · 3차 요구가 이 범위를 전제로 한다(명시 선택은 아님 — 요구에서 따라 나온 것) |
| 2026-11-14 | 주기 수집 간격(§8.4-1) | **매일** | "주기는 매일" |
| 2026-11-14 | 새 기록 알림(§8.4-2) | **메일을 보낸다** | "새 기록 생기면 메일 보내" |
| 2026-11-14 | 범위 계정에게 분석 화면(§8.4-3) | **연다** — 자기 법인만 보인다. ‘전체’ 점검 실행은 전 법인 권한 계정만 | "열어줘" |
| 2026-11-14 | 화면 표기 | ‘복구됨’ → **‘PDR54’** | "PDR54 를 PDR54 라고 표시해줘" |

### 10.1 아직 답이 없는 것(기본값 제안)

| # | 질문 | 제안 기본값 | 이유 |
|---|---|---|---|
| 1 | PDR54 를 배드 섹터 기록 수(판정 띠 · 분석 수치)에 넣을지 | 넣는다 | 시안이 이미 그렇게 센다. 빼면 ‘기록 디스크’ 수가 크게 준다 |
| 2 | ‘복구 불가’ · ‘고장 예측’ 도 ID(PDR46 · PDR47 · PDR64 · PDR16)로 표기할지 | ID 로 통일 | PDR54 만 ID 면 한 열에 두 가지 표기가 섞인다 |
| 3 | HPE iLO 서버 | 이번에는 ‘대상 아님’ | 로그 형식이 달라 별도 조사가 필요하다 |
| 4 | 서버 상세에서의 위치 | 새 탭 ‘디스크 이력’ | 시안대로 |
| 5 | ‘전체’ 점검 때 동시에 돌릴 법인 수 | 전부 동시 | 법인마다 자기 엣지가 자기 서버를 읽어 서로 부하가 겹치지 않는다 |
| 6 | 매일 점검 시각 | 법인 현지 새벽(설정값) | 시각을 정하지 않으셨다 |
| 7 | 메일 받는 사람 | 그 법인 담당자 + 전체 관리자 | 법인 1:1 규칙 — 다른 법인 기록을 섞어 보내지 않는다 |
| 8 | 메일 묶음 | 법인별 하루 1통 요약 | 기존 메일 경로는 시간당 60건을 넘으면 초과분을 조용히 버린다(`partfault/notify.js` 머리 주석 · `mail/kinds.js`) — 건별 발송은 유실 위험 |
| 9 | 첫 점검에서 나오는 과거 기록(대량) | 메일 없이 화면에만, 둘째 날부터 ‘새 기록’ 만 메일 | 첫 회는 수년 치가 한꺼번에 나온다 |
| 10 | PDR54 만 새로 생긴 경우에도 메일 | 보낸다 | ‘새 기록’ 을 구분 없이 말씀하셨다 |
| 11 | 구현 전에 실장비 1~2대로 로그를 먼저 읽어 볼지(§4 미확인 ID · §5 `$filter` · §8.2-4 HBA/vSAN) | 먼저 확인 | 분류표와 소요 시간을 확정하려면 필요하다 |
| 12 | PR #1043 을 지켜볼지 | — | — |
| 13 | 구현 착수 컨펌 | — | 설계는 컨펌 뒤에만 구현(2026-11-03 규칙) |

## 11. 결정 기록 2(사용자 2026-11-14 4차)

사용자 답: "1. 표시해 · 2. 전체 및 법인별로 점검 가능하게 · 3. 수집주기 6시간 · 4. Pdr54 라고 표시하고 주석 달아줘 · 5. Hpe ilo 제외 · 서버에서의 상세위치 포함"

| 항목 | 결정 | 시안 반영 | 비고(내 해석은 해석이라고 적는다) |
|---|---|---|---|
| PDR54 를 기록 수에 넣을지(§10.1-1) | **넣어서 표시** | 그대로(이미 셈) | "1. 표시해" 를 이 질문의 답으로 읽었다 — **해석** |
| 기록 표기(§10.1-2) | **행마다 실제 ID + 주석**(PDR46 · PDR47 · PDR54 · PDR16) · 묶음 이름에는 ID 를 괄호로 | `Main` · `Narrow` · `States` 기록 행 = ID 표지 + 주석 한 줄 · 수치 칸 · 범례 = ‘복구 불가 (PDR46 · PDR47 · PDR64)’ · ‘PDR54 (미디어 오류를 고쳐 씀)’ · ‘PDR16 (SMART 고장 예측)’ · `Main` 아래 ‘기록 ID 주석’ | "4. Pdr54 라고 표시하고 주석" 은 PDR54 를 말씀하셨다. 다른 ID 에도 같은 방식을 쓴 것은 **내 판단**(한 열에 두 표기가 섞이지 않게) |
| 점검 범위(§9.4-2) | **전체 · 법인별 둘 다** | `Scan`(전체 / 법인 골라서) + `Fleet` 국가·법인 표에 행마다 [점검] | 동시에 돌릴 법인 수는 말씀이 없어 기본값(전부 동시) 유지 |
| 수집 주기(§10) | ~~매일~~ → **6시간** | `Fleet` · `Scan` 문구 | 아래 11.1 |
| HPE iLO(§10.1-3) | **제외** | `States` 8 · `Fleet` · `Scan` 문구 | |
| 위치(§10.1-4) | **서버 상세에 포함**(새 탭) + **디스크의 상세 위치 표시** | 기록 표 · 지금 디스크 표 · 분석 표의 ‘위치’ 열 = Disk N + Backplane · Controller | "서버에서의 상세위치 포함" 을 두 뜻 모두로 반영했다 — **해석**. 위치는 로그 문장의 ‘Disk N in Backplane M of … Controller K’ 에서 뽑는다(문장 형식은 실장비 대조 필요) |

### 11.1 6시간 주기의 전제

- 6시간마다 **새 로그만** 읽는 것이 전제다. ‘지난번 읽은 곳 뒤부터’ 를 iDRAC 에 요청할 수 있는지(`$filter=Created gt …` 또는 최신순 + 멈춤)는 **미확인**(§5).
  안 되면 6시간마다 전 서버 로그 전량을 다시 읽게 되어 부하가 크다 — 그 경우 주기를 다시 여쭌다.
- 메일은 점검 한 번에 법인별 최대 1통(새 기록이 있을 때만) → 법인당 하루 최대 4통(제안 — §10.1-8 미확정).

### 11.2 아직 답이 없는 것

§10.1 의 5(전체 점검 때 동시 법인 수 — 기본값 전부 동시) · 7(메일 받는 사람) · 8(메일 묶음) · 9(첫 점검의 과거 기록 메일 여부) · 10(PDR54 만 새로 생겨도 메일) ·
11(구현 전 실장비 확인) · 12(PR 지켜보기) · 13(구현 착수 컨펌). 6(매일 점검 시각)은 6시간 주기로 바뀌어 없어졌다.

## 12. 참조 문서 — 이 시안과 기능이 기대는 근거 전부(사용자 2026-11-14 5차)

- "이 시안과 기능에 포함된 모든 참조 문서에 대한 내용을 추가해서 기능의 신뢰성을 높여줘"

→ 아트보드 `Refs.dc.html`(분석 화면의 ‘근거’ 보기 — 화면 안에서 ID 의 뜻 · Dell 권장 조치 · 출처 · 확인 수준을 본다) 추가,
`Main` · `Fleet` 에 ‘근거 문서’ 링크, 미확인 항목 재조사, 이 절.

**확인 수준을 정직하게 적는다**: 아래 외부 문서는 전부 **웹 검색 결과의 요약으로 확인**했다. 원문 페이지는 이 작업 세션의 네트워크 정책에 막혀
열지 못했다(`www.manualsdir.com` · `www.powershellgallery.com` 접속 불가 — 다른 호스트는 시도하지 않았다). 즉 ‘문서 확인’ 은 ‘그 문서가 그렇게 말한다고 검색 요약이 전한다’ 는 뜻이고,
문구 한 자 한 자를 대조한 것이 아니다. 매뉴얼 미러 사이트(manualsdir · manualslib · manualowl)는 Dell 매뉴얼의 사본이지 Dell 공식 호스트가 아니다.
**실장비 대조는 0건**이다.

### 12.1 외부 문서 — 기록 ID

| # | 문서 | 뒷받침하는 것 | 수준 |
|---|---|---|---|
| ① | Dell PowerEdge VRTX 매뉴얼 450쪽 — https://www.manualsdir.com/manuals/620821/dell-poweredge-vrtx.html?page=450 | PDR46 = Patrol Read 가 고칠 수 없는 미디어 오류. 옮길 수 없는 불량 블록일 수 있다 | 매뉴얼 사본 · 요약 |
| ② | 같은 매뉴얼 451쪽 — …?page=451 | PDR47 = 고칠 수 없는 미디어 오류 → 컨트롤러가 블록을 puncture. 쓰면 풀린다 | 매뉴얼 사본 · 요약 |
| ③ | Dell KB 000139251 ‘Double Faults and Punctures in RAID Arrays’ — https://www.dell.com/support/kbdoc/el-gr/000139251/double-faults-and-punctures-in-raid-arrays | puncture 가 무엇이고 어떻게 복구하는가 | Dell KB · 요약 |
| ④ | Dell KB 000218950 ‘Gen 5a Physical Disk Failure EventID 52807’ — https://www.dell.com/support/kbdoc/en-ca/000218950/gen5a-physical-disk-failure-eventid-52807 | PDR64 = 리빌드 · 복구 중 고칠 수 없는 미디어 오류. 권장: 디스크 교체 | Dell KB · 요약(Avamar 제품 문서) |
| ⑤ | Dell KB 000403212 ‘PDR63 A Bad Disk Block … Cannot be Reassigned During a Write Operation’ — https://www.dell.com/support/kbdoc/ar-bh/000403212/ppdma-dm5510-pdr63-a-bad-disk-block-on-arg1-cannot-be-reassigned-during-a-write-operation | PDR63 문구 · 권장: 디스크 교체 | Dell KB · 요약(PowerProtect 제품 문서) |
| ⑥ | VRTX 매뉴얼 459쪽 — …?page=459 | PDR63: 데이터 손실 · 이중화 손실 가능 | 매뉴얼 사본 · 요약 |
| ⑦ | VRTX 매뉴얼 457쪽 — …?page=457 | PDR59 = 불량 블록을 다른 블록으로 옮김 · 손실 없음 · 정보성 · 권장: 지켜봄 | 매뉴얼 사본 · 요약 |
| ⑧ | VRTX 매뉴얼 456쪽 — …?page=456 | PDR57 = 불량 블록 표가 차 감 · warning · 권장: 교체 + 백업 복원. (80% 인지 가득인지는 요약으로 특정 못 함) | 매뉴얼 사본 · 요약 |
| ⑨ | VRTX 매뉴얼 429쪽 — …?page=429 | PDR5 = 디스크가 디스크 그룹에서 빠짐. 케이블 · 인클로저 문제로도 뜸 · 정보성 | 매뉴얼 사본 · 요약 |
| ⑩ | Dell KB 000481601 ‘Drives are Missing in iDRAC — PDR5 or PR8’ — https://www.dell.com/support/kbdoc/ru-lt/000481601/powerflex-drives-are-missing-in-idrac | PDR5 가 디스크 펌웨어 문제(NVMe PM1733a/PM1735a)로도 뜬다 → 교체의 증거가 아니다 | Dell KB · 요약 |
| ⑪ | VRTX 매뉴얼 888쪽 — …?page=888 | VDR57(초기화 중 미디어 오류를 고치고 불량 블록을 옮김) · VDR93(불량 블록 미디어 오류가 지워짐) | 매뉴얼 사본 · 요약 |
| ⑫ | Dell 커뮤니티 ‘R720XD Correctable Disk Media Errors’ — https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/R720XD-Correctable-Disk-Media-Errors/td-p/5183008 | PDR54 = 미디어 오류를 고쳐 씀 · 조치 불필요 · VDR47 사례. 교체 뒤에도 계속 뜬 사례가 있다 | 커뮤니티 · 요약 |
| ⑬ | Dell KB 000126418 ‘What is Predictive Drive Failure — PDR16’ — https://www.dell.com/support/kbdoc/en-uk/000126418/poweredge-hdd-what-is-predicted-drive-failure-and-how-to-solve-it | PDR16 = SMART 고장 예측 | Dell KB · 요약 |
| ⑭ | Dell KB 000221846 ‘SAS, SATA SSD: SMART predictive failures triggered by Remaining Write Rated Endurance’ — https://www.dell.com/support/kbdoc/000221846/sas-sata-ssd-smart-predictive-failure | SSD 의 PDR16 은 쓰기 수명 소진으로도 뜬다 → **PDR16 을 배드 섹터와 같은 뜻으로 세면 안 된다** | Dell KB · 요약 |
| ⑮ | Dell KB 000308774(제목: 교체 뒤 24시간마다 PDR16 이 적힘) — https://www.dell.com/support/kbdoc/en-ai/000308774/poweredge-idrac9-pdr16-felet-predictive-failure-loggas-var-24-e-timme-efter-bytet?lang=tw | PDR16 이 반복 기록될 수 있다 → 같은 디스크 · 같은 ID 는 건수보다 ‘있음’ 으로 본다 | **제목만 확인** |
| ⑯ | Dell KB 000143247 ‘Understanding Disk Errors: PDR1001, PDR3 …’ — https://www.dell.com/support/kbdoc/en-uk/000143247/dell-enterprise-hdd-what-is-the-meaning-of-led-on-physical-drives-pd | 물리 디스크 오류 ID 일반 | 제목만 확인 |
| ⑰ | Dell KB SLN111146(가상 디스크 bad block 지우기) — https://www.dell.com/support/article/ky/en/kydhs1/SLN111146 · 커뮤니티 ‘R520 Virtual disk bad block medium error is detected’ | 가상 디스크 bad block 은 구성 디스크의 복구 불가 블록에서 온다 · OMSA 이벤트 2387 · 2417 | Dell KB · 커뮤니티 · 요약 |
| ⑱ | Dell Error and Event Message(EEMI) 참조 안내서 — https://www.dell.com/support/manuals/en-qa/enterprise-solution-resources/eemi_automated_2024/swusoftware-change-event-messages · https://dell.com/support/manuals/en-ca/idrac9-lifecycle-controller-v3.3-series/eemi_pub/introduction | 전체 ID 의 공식 목록. PDR = Physical Disk · VDR = Virtual Disk 범주. **구현 전에 이 안내서로 ①~⑰ 을 다시 맞춘다** | 존재만 확인 |

### 12.2 외부 문서 — 볼 수 있는 범위 · 읽는 방법

| # | 문서 | 뒷받침하는 것 | 수준 |
|---|---|---|---|
| ⑲ | Dell PERC H310 사용 설명서 21쪽 — https://www.manualslib.com/manual/692159/Dell-H310.html?page=21 | Patrol Read 는 가상 디스크 구성원 · 핫 스페어에서만 돈다. Ready 상태 디스크는 돌지 않는다 | 매뉴얼 사본 · 요약(구형 컨트롤러) |
| ⑳ | Dell PowerEdge T140 문제 해결 안내서 90쪽 — https://www.manualowl.com/m/Dell/PowerEdge-T140/Manual/593027?page=90 | HBA 모드의 PERC 는 Patrol Read 설정을 지원하지 않는다 | 매뉴얼 사본 · 요약 |
| ㉑ | Dell iDRAC8 사용 설명서 209쪽 — https://www.manualslib.com/manual/1244291/Dell-Idrac-8.html?page=209 | HBA 모드에서는 가상 디스크 · 핫 스페어가 없고 모든 디스크가 non-RAID | 매뉴얼 사본 · 요약 |
| ㉒ | Dell PERC 10 사용 설명서 — https://dl.dell.com/topicspdf/perc10_ug_en-us.pdf | 현행 컨트롤러의 같은 내용 | **목차만 보임 — 본문 미확인** |
| ㉓ | Dell KB 000239838 ‘Seagate Summit SAS or SATA Drives Report Medium Errors …’ — https://www.dell.com/support/kbdoc/en-us/000239838/seagate-summit-hard-drives-failing-at-increased-rate?lang=en | 특정 모델의 미디어 오류가 펌웨어 문제일 수 있다 → 모델별 분석에서 ‘모델 + 펌웨어’ 를 같이 봐야 한다. 펌웨어 갱신 뒤 Patrol Read · Consistency Check 가 켜져 있는지 확인하라는 권고 | Dell KB · 요약 |
| ㉔ | PowerShell Gallery 모듈 `Get-IdracLifecycleLogsREDFISH` — https://www.powershellgallery.com/packages/Get-IdracLifecycleLogsREDFISH/10.0.0/Content/Get-IdracLifecycleLogsREDFISH.psm1 | `LogServices/Lclog/Entries` 를 `$skip` 을 올려 가며 끝까지 읽는다 · 날짜 범위 · 메시지 ID 옵션이 있다(서버 쪽 필터인지 받은 뒤 거르는지는 요약에 없음) | 공개 스크립트 · 요약(작성 주체 미확인 — 앞서 ‘Dell 공개’ 라고 쓴 것을 정정) |
| ㉕ | DMTF Redfish LogEntry 규격 — https://redfish.dmtf.org/schemas/v1/LogEntry.v1_20_0.json | 로그 항목의 `MessageId` · `Created` 속성 | 표준 규격 |
| ㉖ | HPE iLO OData 질의 옵션 문서 — https://servermanagementportal.ext.hpe.com/docs/redfishservices/ilos/supplementdocuments/odataqueryoptions | `$filter=Created gt …` · `$top` · `$skip` 문법의 예. **iDRAC 의 동작을 증명하지 않는다** | 타사 문서(문법 참고만) |
| ㉗ | Dell 백서 ‘Redfish Life Cycle Events’(iDRAC9 5.00.00.00 부터) — https://downloads.dell.com/manuals/all-products/esuprt_solutions_int/esuprt_solutions_int_solutions_resources/dell-management-solution-resources_White-Papers26_en-us.pdf | LC 이벤트를 구독(push)으로 받을 수 있다 · 구독 필터에 MessageId 를 쓸 수 있다 → 6시간 폴링의 대안 후보(§12.5-3) | Dell 백서 · 요약 |
| ㉘ | iDRAC9 Redfish API 안내서 v4.x — https://dell.com/support/manuals/en-us/idrac9-lifecycle-controller-v4.x-series/idrac9_4.00.00.00_redfishapiguide_pub | `DellPhysicalDisk` 자원이 있다(속성 이름은 미확인) | 존재만 확인 |
| ㉙ | iDRAC9 텔레메트리 백서 — https://dl.dell.com/manuals/all-products/esuprt_software_int/esuprt_software_ent_systems_mgmt/idrac9-lifecycle-controller-v4x-series_White-Papers2_en-us.pdf · Dell KB 000178016(라이선스) | 스토리지 리포트 3종에 SMART 지표가 있다 · 텔레메트리는 라이선스 등급에 달려 있다 | Dell 백서 · 요약 |

### 12.3 이 저장소 안의 근거

| 사실 | 위치 |
|---|---|
| 지금 이벤트 수집은 로그 한 쪽의 끝 40건 · Critical/Warning 15건 · MessageId 버림 | `server/src/idrac/redfish.js:789-803` |
| 디스크 인벤토리의 모델 · 시리얼 · `FailurePredicted`(없으면 null) | `server/src/idrac/redfish.js:732-750` |
| 엣지 축약 인벤토리의 디스크에는 시리얼이 없다 | `server/src/collector/compactInv.js:50` |
| 엣지 위임 서버는 중앙에서 즉시 재수집 · 프로브 불가 | `server/src/routes/admin/idracScan.js:85-88 · 229` |
| 서버 상세 모달(탭 3개 · 폭 980) · 물리 디스크 표 · 이벤트 목록 | `web/src/views/idrac/IdracDetailModal.jsx:221 · 305-307 · 438-455 · 522-535` |
| 법인 귀속 · 국가 | `server/src/idrac/corpAttribution.js:142 idracCorpIndex` · `server/src/vcenter/registry.js:74-102` · `server/src/gpu/allocTree.js:287` |
| 텔레메트리 스토리지 리포트 이름 패턴 | `server/src/bmusage/parse/idracTelemetry.js:63` |
| 파트 장애 메일 경로와 그 한계(순차 발송 · 시간당 상한 주석) | `server/src/partfault/notify.js:1-20` · `server/src/mail/kinds.js:75`(시간 창 — 상한 숫자는 직접 확인 안 함) |
| 엣지 작업 워커 전례 | `server/src/agent/idracScanWorker.js` · `server/src/agent/logQueryWorker.js` |
| 운영 규칙(법인 로컬 실행 · 엣지 정제 · 보류 시한 · 인증 정지 · 못 읽은 값은 0 이 아니다) | 루트 `CLAUDE.md` · `docs/rules/idrac-server.md` · `docs/rules/edge.md` · `docs/rules/perf-db.md` |
| 시안 색 · 글자 토큰 | `web/src/styles.css:1-35` |

### 12.4 신뢰성 장치 — 구현이 지킬 것

1. **분류표는 한 곳**(순수 모듈)에 두고 ID 마다 `뜻 · 분류 · 출처 URL · 확인 수준 · 대조한 날짜` 를 같이 적는다. 화면 ‘근거’ 보기는 이 표를 그대로 그린다(문구를 두 벌로 두지 않는다).
2. **출처 없는 ID 는 분류에 없다** — 테스트가 고정한다. 미확인 ID(PDR56 · 삽입 ID 등)는 실장비 로그 또는 EEMI 로 확인한 뒤에만 넣는다.
3. **원문을 버리지 않는다**: 스토리지 계열 기록은 분류되지 않은 것도 MessageId · 메시지 · 시각 · 로그 항목 Id 를 보관한다 → 분류표가 바뀌면 다시 분류할 수 있다.
4. **PDR16 은 배드 섹터 수에 넣지 않고 따로 센다**(⑭ SSD 수명 · ⑮ 반복 기록). 시안도 처음부터 따로 세고 있다.
5. **같은 디스크 · 같은 ID 의 반복**은 건수와 함께 ‘처음 · 마지막 시각’ 을 보여 준다(⑫ ⑮ — 건수만 보면 부풀려 읽힌다).
6. **‘교체됨’ 은 PDR5 만으로 판정하지 않는다**(⑨ ⑩ 케이블 · 펌웨어로도 뜬다). 순서: 시리얼이 달라짐(확정) → 제거 + 삽입 기록이 둘 다 있음(추정) → 그 밖은 ‘판단 불가’.
7. **볼 수 없는 디스크를 ‘기록 없음’ 에 넣지 않는다**(⑲ ⑳ ㉑): RAID 로 묶이지 않은 디스크는 따로 세고, 분석의 분모에서도 뺀다.
8. **모델별 분석은 모델 + 펌웨어**로 본다(㉓).
9. **실장비 대조를 기록한다**: 대조한 서버 수 · 날짜 · 어긋난 점을 이 문서와 ‘근거’ 보기에 적는다. 대조 전에는 화면에 ‘실장비 대조 전’ 이라고 쓴다.
10. 기존 규칙 그대로: 못 읽음 · 일부만 읽음은 판정하지 않는다 · 로그가 남은 구간을 항상 같이 쓴다 · 엣지가 보낸 것은 정제한다 · 인증 실패는 자동 재시도하지 않는다.

### 12.5 이번 조사로 새로 생긴 질문

1. 문서로 확인된 **PDR59**(불량 블록을 옮김) · **PDR57**(불량 블록 표가 차 감)을 분류에 넣을지 — 제안: 넣는다(PDR59 는 PDR54 와 같은 줄에 ID 그대로, PDR57 은 경고).
2. 가상 디스크 기록(**VDR57 · VDR93 · VDR47**)을 볼지 — 제안: 서버 단위 참고 기록으로만(디스크 슬롯에 귀속 못 함).
3. 6시간 폴링 대신 LC 이벤트 구독(㉗)을 쓸지 — 제안: 이번에는 폴링. 구독은 엣지가 수신 포트를 열어야 해 별도 검토.
