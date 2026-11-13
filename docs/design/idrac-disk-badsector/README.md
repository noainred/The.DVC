# 설계: iDRAC 디스크 배드 섹터 이력 — 이 서버에서 과거에 배드 섹터가 난 적이 있는지 찾기

작성 2026-11-14 (v2.914.0 기준) · 상태 **시안 — 컨펌 대기**(구현 전) · 시안 캔버스: https://claude.ai/artifact/FB317UnqoXFZQjPAGdM2xU
(아트보드 13장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 서버 이름 · IP · 서비스태그 · 시리얼 · 건수 · 날짜는 **전부 가상**이고
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
4. **RAID 로 묶이지 않은 디스크**(HBA 모드 · 패스스루 · Ready 상태)는 Patrol Read 가 돌지 않는다 — **문서 확인**(§12.2 ⑲⑳㉑: Patrol Read 는 가상 디스크 구성원 · 핫 스페어에서만 돌고, HBA 모드에서는 설정 자체를 지원하지 않는다). 따라서 그 디스크에는 PDR46 이 생기지 않는다 → '기록 없음' 이 아니라 '이 방법으로는 볼 수 없음' 으로 따로 센다. 남은 미확인: 현행 PERC 10/11/12 · HBA330 문서의 같은 문구, NVMe 직결 디스크, 그리고 포탈이 Redfish 로 '이 디스크가 가상 디스크 구성원인가' 를 읽는 방법.
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

## 13. 추가 요구(사용자 2026-11-14 6차) — 전체 점검의 법인별 조작 · 지금 쓰이는 곳

- "전체 점검때 법인별도 점검 모든 법인 점검하는 기능 추가"
- "os 접근 가능하면 배드섹터 발생한 디스크가 지금 어디에 마운트되서 사용하고 있는지 찾는 기능 추가"

### 13.1 전체 점검 + 법인별

전체 / 법인 선택 점검은 §9 에 이미 있었다. 이번에 더한 것: `Scan` 의 진행 표를 **전체 점검의 예**(법인 28곳)로 바꾸고 행마다 **[다시 점검] · [중단] · [다시 보내기]**,
머리에 [전체 중단], ‘나머지 22곳 더 보기’. 즉 전체 점검이 도는 중에도 법인 하나만 따로 다시 돌리거나 멈출 수 있다(잠금이 법인 단위라는 §9.3 규칙 그대로).

### 13.2 지금 쓰이는 곳 — 아트보드 `Usage.dc.html`

배드 섹터 기록이 있고 아직 쓰는 디스크를 **물리 디스크 → 가상 디스크 → OS 장치 → 마운트(또는 데이터스토어)** 로 따라간다. 고리마다 ‘무엇으로 맞췄는지’ 를 적고, 근거가 없으면 잇지 않고 멈춘다.
`Main` ‘지금 디스크’ 표와 `Fleet` ‘아직 사용 중’ 표에 ‘지금 쓰이는 곳’ 열을 더했다.

| 경우 | 접근 수단(지금 포탈에 있는가) | 맞추는 근거 | 가능 여부 |
|---|---|---|---|
| 베어메탈 Linux · Windows — RAID 로 묶이지 않은 디스크 | OS SSH — **있다**(`bmusage/collectors/osSsh.js` · `proxy/sshExec.js withSsh` · 계정은 베어메탈 스토리지 등록부 `bmstor/registry.js`) | 디스크 시리얼(iDRAC `redfish.js:738`) = OS 가 말하는 시리얼 | 가능(OS 명령이 시리얼을 내 주는지 실장비 확인 필요) |
| 베어메탈 — RAID 가상 디스크의 구성원 | 같음 | 가상 디스크 식별자(NAA) = OS 장치 WWN | **불확실** — Dell 커뮤니티에 PERC 가상 디스크의 `Identifiers` 가 비어 온다는 보고가 있다(§13.4 ㉚ ㉛). 비면 ‘확정하지 못함’(시안 5번) |
| ESXi 호스트 | vCenter — **있다**(OS 로그인 불필요). 단 호스트 디스크 · VMFS extent · vSAN 디스크 그룹은 **지금 수집하지 않는다**(`vcenter/soapParse.js:256` 의 `RawDiskMapping` 은 VM 가상 디스크의 RDM 판정이지 호스트 디스크가 아니다 — 처음에 ‘vSAN DiskMapping 파싱이 있다’ 고 쓴 것은 틀렸고 정정했다) | 디스크 시리얼 · 장치 이름(naa) → VMFS extent 또는 vSAN 디스크 그룹 → 데이터스토어 → VM | 가능하나 vCenter 수집 항목 추가 필요. vSAN 은 데이터스토어 단위까지만(어느 VM 의 데이터가 그 디스크에 있는지는 말하지 못한다) |
| OS 계정이 없는 베어메탈 | 없음 | — | iDRAC 가 아는 가상 디스크까지만 + 등록 안내(기존 `no-os-cred` 문구와 같은 방식 — `bmusage/targets.js:50`) |
| 엣지 위임 법인의 서버 | 엣지가 그 법인 안에서 실행하고 요약만 올린다 | — | 엣지 작업에 포함(§5 · §9.3) |

### 13.3 규칙(제안)

- OS 에서는 **읽기 전용 고정 명령만**(장치 목록 · 마운트). 자유 인자 없음 · 파일 내용은 읽지 않음 · 명령 1회로 받아 구획으로 나눔(`osSsh.js` 방식) · Windows 는 base64 스크립트.
- 대상은 **배드 섹터 기록이 있고 아직 쓰는 디스크가 있는 서버만**(전 서버를 돌지 않는다). 점검에서 새 기록이 나온 서버에 이어서 한 번 + 화면의 [다시 찾기].
- SSH 세션 예산 < 서버 시한 · 로그인 실패는 자동 재시도 없음(`util/authGuard.js`) · 못 읽으면 ‘찾지 못했습니다’(쓰이는 곳을 ‘없음’ 으로 쓰지 않는다).
- 여러 후보가 남으면 **고르지 않는다**(크기 · 순서로 추측 금지). 후보는 참고로만.
- 마운트 경로 · 데이터스토어 이름은 범위 계정에게 자기 법인 것만 보인다. 엣지가 올린 값은 정제(길이 · 문자).
- 가상 디스크가 마운트된 것이지 그 디스크 하나가 마운트된 것이 아니라는 점을 화면에 적는다.

### 13.4 이번에 본 문서

| # | 문서 | 뒷받침하는 것 | 수준 |
|---|---|---|---|
| ㉚ | Dell 커뮤니티 ‘iDRAC9 Redfish output missing virtual disk serial number’ — https://www.dell.com/community/en/conversations/systems-management-general/idrac9-redfish-output-missing-virtual-disk-serial-number/647f9b01f4ccf8a8deecd5ab | PERC 가상 디스크의 식별자가 Redfish 에 안 나오는 경우가 있다 | 커뮤니티 · 요약 |
| ㉛ | Dell 커뮤니티 ‘Finding drive durable names’ — https://www.dell.com/community/en/conversations/systems-management-general/finding-drive-durable-names/6958009504bdbe791572a169 | R670 · PERC H965i 에서 볼륨의 `Identifiers` 가 비어 있었다는 보고 | 커뮤니티 · 요약 |
| ㉜ | Redfish `DurableNameFormat`(NAA) 정의 — https://docs.rs/nv-redfish/0.13.0/nv_redfish/schema/resource/enum.DurableNameFormat.html | NAA 식별자의 형식 | 규격 사본 · 요약 |

**미확인(문서를 찾지 않았거나 못 찾음)**: Linux `lsblk` 의 SERIAL · WWN 열, Windows `Get-PhysicalDisk` · `Get-Disk` 의 시리얼, vSphere API 의 호스트 디스크 · VMFS extent · vSAN 디스크 그룹 속성 이름 —
이것들은 내 기억에 의존한다. 시안의 장치 이름 · 마운트 · VM 수는 전부 가상이다.

### 13.5 정해 주실 것

1. ESXi 호스트를 이번 범위에 넣을지(vCenter 수집 항목이 늘어난다) — 제안: 넣는다. 서버 대부분이 ESXi 라 빼면 쓸모가 크게 준다.
2. OS 계정이 없는 베어메탈은 ‘가상 디스크까지만’ 으로 둘지 — 제안: 그렇게 두고 등록 안내.
3. 새 기록 메일에 ‘지금 쓰이는 곳’ 을 같이 적을지 — 제안: 적는다(찾은 경우만).

### 13.6 Windows 서버(사용자 2026-11-14 "windows 서버들도 있어")

- **접속 수단은 이미 있다**: 포탈의 OS 수집은 Linux · Windows 둘 다 SSH 로 붙고, Windows 는 PowerShell 스크립트 1개를 base64(`-EncodedCommand`)로 보낸다(`server/src/bmusage/collectors/osSsh.js:9 · 79-89` — CIM 조회).
  WinRM 경로는 없다(`winrm` 은 `ipam/netmap.js` 에만 나온다 — 수집용이 아님). 따라서 **Windows 서버에 OpenSSH 서버가 켜져 있고 베어메탈 스토리지에 계정이 등록돼 있어야** 한다.
- 시안: `Usage` 3(RAID 로 묶이지 않은 디스크 → 드라이브) · 3-2(RAID 구성원 → 가상 디스크 → Windows 디스크 → 드라이브 문자 · 폴더에 탑재된 볼륨).
- 읽을 것(안): 물리 디스크 · 디스크 · 파티션 · 볼륨 목록(시리얼 · 고유 ID · 드라이브 문자 · 탑재 경로 · 파일 시스템 · 사용량). 읽기 전용 · 스크립트 고정.
- 한계: 저장소 공간(Storage Spaces) · 동적 디스크 · 클러스터 공유 볼륨은 디스크와 볼륨이 일대일이 아니다 → ‘확정하지 못함’. RAID 가상 디스크는 §13.2 와 같은 식별자 문제(㉚ ㉛)가 있다.
- **미확인**: PowerShell 의 디스크 · 파티션 · 볼륨 조회 명령이 내 주는 속성 이름(시리얼 · 고유 ID)은 내 기억에 의존한다. 실제 Windows 서버 1대로 확인해야 한다.
- Windows 서버가 ESXi 위의 VM 이면 이 기능의 대상이 아니다(물리 디스크는 ESXi 호스트 쪽 — §13.2 ESXi 행).

## 14. 결정 기록 3(사용자 2026-11-14 7차) · 실장비 확인 절차

사용자 답: "1. PDR59 를 PDR 59 라고 표시하고 PDR 57도 PDR 57이라고 표시해 · 2. 알았어 · 3. 전체 점검과 법인별 점검 기능을 구현해줘 · 4. 6시간마다 읽기 · 5. 먼저 확인"

| 항목 | 결정 | 반영 · 비고 |
|---|---|---|
| PDR59 · PDR57(§12.5-1) | **분류에 넣고 ID 그대로 표시** | `Refs` 분류 열 · `Main` 주석 · `Fleet` ‘아직 사용 중’ 표에 PDR59 · PDR57 열. 표기는 Dell 의 ID 그대로 **‘PDR59’ · ‘PDR57’(띄어쓰기 없음)** 로 했다 — 말씀은 ‘PDR 59’ 였고, 띄어 쓰기를 원하신 것이면 바꾼다(**해석**) |
| 가상 디스크 기록 VDR(§12.5-2) | 제안대로 — **서버 단위 참고 기록으로만** | "알았어" 를 제안 수락으로 읽었다(**해석**) |
| 전체 · 법인별 점검(§10.1-5) | **둘 다 구현 범위** | 시안 `Scan` · `Fleet` 그대로. 동시 법인 수는 말씀이 없어 기본값(전부 동시) |
| 읽는 방식(§12.5-3) | **6시간마다 읽기**(이벤트 구독 안 씀) | |
| 실장비 확인(§10.1-11) | **구현 전에 먼저 확인** | 아래 14.1 — 확인 결과가 나온 뒤 Opus 로 구현 |

### 14.1 실장비 확인 — 무엇을 · 어떻게

이 작업 세션(클라우드)은 사내 iDRAC · 서버에 닿지 못한다. 아래는 **읽기 전용 조회**이고, 포탈 서버(또는 그 법인 엣지)에서 직접 실행해 결과를 알려 주시면 된다.
고를 서버 3종: ⓐ RAID 로 묶인 베어메탈(가능하면 과거에 디스크를 교체한 적 있는 서버) ⓑ HBA · vSAN 구성의 ESXi 호스트 ⓒ Windows 베어메탈.
명령은 Redfish 표준 경로와 이 저장소 코드(`redfish.js`)가 쓰는 경로를 바탕으로 **내가 쓴 것이고 실장비에서 돌려 보지 않았다** — 오류가 나면 그 오류 문장도 결과다.

```bash
# 준비 — 비밀번호는 화면에 남기지 않는다
B=https://<iDRAC 주소>; U=<계정>; read -s -p "password: " P; echo
G() { curl -sk -u "$U:$P" "$@"; }
L="$B/redfish/v1/Managers/iDRAC.Embedded.1/LogServices/Lclog/Entries"

# ① 첫 쪽 — 전체 건수 · 한 쪽 건수 · 다음 쪽 링크 · 정렬 방향 · MessageId 모양
G "$L" | jq '{count: .["Members@odata.count"], page: (.Members|length), next: .["Members@odata.nextLink"], first: .Members[0] | {Id, Created, MessageId, Severity, Message}, last: .Members[-1] | {Id, Created, MessageId}}'

# ② 건너뛰기 · 개수 지정이 되는가
G "$L?\$skip=100&\$top=5" | jq '[.Members[] | {Id, Created, MessageId}]'

# ③ ID 로 걸러 받을 수 있는가(되면 6시간 주기 부하가 크게 준다) — MessageId 값은 ①에서 본 모양 그대로 넣는다
G --get --data-urlencode "\$filter=MessageId eq 'PDR54'" "$L" | jq '{count: .["Members@odata.count"], page: (.Members|length), err: .error}'

# ④ 시각으로 걸러 받을 수 있는가(‘지난번 이후 새 로그만’ 의 전제)
G --get --data-urlencode "\$filter=Created ge '2026-11-01T00:00:00-00:00'" "$L" | jq '{count: .["Members@odata.count"], page: (.Members|length), err: .error}'

# ⑤ 전량 읽기 — 걸리는 시간 · 가장 오래된 기록 · ID 분포
time ( n=0; while :; do r=$(G "$L?\$skip=$n"); c=$(echo "$r" | jq '.Members|length'); [ "${c:-0}" -gt 0 ] || break
  echo "$r" | jq -r '.Members[] | [.Created, .MessageId, .Severity, (.Message|.[0:160])] | @tsv'; n=$((n+c)); done > lclog.tsv )
wc -l lclog.tsv; sort lclog.tsv | head -1; cut -f2 lclog.tsv | sort | uniq -c | sort -rn | head -40
grep -E 'PDR|VDR' lclog.tsv | head -60        # 물리 · 가상 디스크 기록의 실제 문장(슬롯 표기 형식 확인)

# ⑥ 가상 디스크 ↔ 물리 디스크 · 식별자
S="$B/redfish/v1/Systems/System.Embedded.1/Storage"
for c in $(G "$S" | jq -r '.Members[]["@odata.id"]'); do
  G "$B$c" | jq '{Id, Name, drives: (.Drives|length), volumes: .Volumes}'
  for v in $(G "$B$c/Volumes" | jq -r '.Members[]?["@odata.id"]'); do
    G "$B$v" | jq '{Id, Name, RAIDType, CapacityBytes, Identifiers, drives: [.Links.Drives[]?["@odata.id"]]}'; done
done
# 디스크 한 개 — 시리얼 · 소속 가상 디스크 · Dell 확장 속성(RaidStatus 등)
G "$B<위에서 본 디스크 경로 하나>" | jq '{Id, SerialNumber, Model, FailurePredicted, volumes: .Links.Volumes, dell: .Oem.Dell.DellPhysicalDisk}'
```

OS 쪽(같은 서버에서):

```bash
lsblk -o NAME,TYPE,SIZE,SERIAL,WWN,MOUNTPOINT          # Linux — 시리얼 · WWN 이 나오는가
```
```powershell
Get-PhysicalDisk | Select-Object FriendlyName, SerialNumber, UniqueId, Size     # Windows
Get-Disk | Select-Object Number, SerialNumber, UniqueId, PartitionStyle
Get-Partition | Select-Object DiskNumber, PartitionNumber, DriveLetter, AccessPaths
```

### 14.2 결과로 정해지는 것

| 확인 | 결과에 따라 |
|---|---|
| ① 정렬 방향 · MessageId 모양 | 분류 대조 방식(ID 전체 일치인지 끝부분 일치인지) · ‘새 로그만’ 을 읽는 방향 |
| ③ ④ 걸러 받기 | 되면 6시간 주기는 가볍다. 안 되면 최신순으로 읽다 지난번 항목에서 멈추는 방식(①의 정렬이 최신순일 때만 가능) — 그것도 안 되면 **주기를 다시 여쭌다** |
| ⑤ 걸린 시간 · 가장 오래된 기록 | 서버당 시한 · 동시성 · ‘로그가 남아 있는 구간’ 의 실제 길이 |
| ⑤ ID 분포 · 문장 | §4 분류표 확정(PDR56 · 삽입 ID 포함) · 슬롯 표기 파서 |
| ⑥ `Identifiers` · `Links` | RAID 가상 디스크를 OS 장치와 맞출 수 있는가(§13.2) · ‘이 방법으로 볼 수 없는 디스크’ 판정(§12.4-7) |
| OS 명령 | 시리얼 · WWN 대조가 실제로 되는가(§13) |

결과를 붙여 주실 때 비밀번호는 넣지 말고, 주소 · 서비스태그 · 시리얼은 가려도 된다(형식만 보이면 충분하다).

### 14.3 아직 답이 없는 것

메일(§10.1-7 · 8 · 9 · 10 · §13.5-3) · ‘지금 쓰이는 곳’ 범위(§13.5-1 · 2) · PR 지켜보기 · 구현 착수 시점(실장비 확인 뒤로 읽었다 — §14 표).

## 15. 요약 장표 · 결정 기록 4(사용자 2026-11-14 8차)

- "요약 장표를 만들어줘, 보고서 형태로" → 아트보드 `Report.dc.html`(A4 가로 1장 · 1123×794 · 캔버스의 ‘요약 보고’ 쪽). 이 설계의 요약 보고로 읽었다(**해석** — 포탈 안의 ‘분석 결과 보고서 화면’ 을 뜻하신 것이면 따로 그린다).
  장표에는 가상 수치를 쓰지 않고 확정된 사실 · 결정만 넣었다. 높이는 계산으로 맞췄고 **그려진 결과를 눈으로 확인하지 않았다** — 아래가 잘리면 알려 주시면 줄인다.
- 남은 질문 8건에 대한 답: "1. 권고데로 · 2. 권고데로 · 3. 권고데로 · 4. 보냄 · 5. 적음 · 6. 넣음 · 7. 권고데로 · 8.(빈칸)"

| # | 항목 | 결정 |
|---|---|---|
| 1 | 메일 받는 사람 | 그 법인 담당자 + 전체 관리자 |
| 2 | 메일 묶음 | 점검 한 번에 법인별 1통 요약(법인당 하루 최대 4통) |
| 3 | 첫 점검의 과거 기록 | 메일 없이 화면에만 · 그다음 점검부터 새 기록만 메일 |
| 4 | PDR54 만 새로 생긴 경우 | 메일을 보낸다 |
| 5 | 메일에 ‘지금 쓰이는 곳’ | 적는다(찾은 경우만) |
| 6 | ‘지금 쓰이는 곳’ 에 ESXi 호스트 | 넣는다(vCenter 수집 항목 추가) |
| 7 | OS 계정이 없는 베어메탈 | 가상 디스크까지만 + 등록 안내 |
| 8 | PR #1043 지켜보기 | **답 없음** — 구독하지 않았다 |

이로써 설계 결정은 모두 정해졌다. 남은 것: **실장비 확인(§14.1 — 사용자 쪽에서 실행)** → 그 결과로 §14.2 를 확정 → Opus 로 구현.
‘법인 담당자’ 의 메일 주소를 어디서 가져오는지(기존 알림 수신자 설정을 쓰는지)는 구현 때 코드로 확인한다 — 아직 보지 않았다.

## 16. 추가하면 좋은 기능 — 제조사 · 모니터링 제품 · 커뮤니티 조사(사용자 2026-11-14 9차)

- "제조사 레딧 모니터링 솔루션 개발사 검색해서 추가하면 좋은 기능 제안해줘"

조사 한계: **Reddit 은 검색하지 못했다**(검색 도구가 reddit.com 에 접근할 수 없다) — 현장 경험은 Dell 커뮤니티 포럼 글로 대신했다. PRTG · Checkmk 의 Dell 디스크 점검은 결과를 찾지 못했다.
아래 출처는 전부 웹 검색 요약 기준이다(원문 미열람). 채택 여부는 미정 — 시안에는 넣지 않았다.

| # | 제안 | 무엇을 더하나 | 근거(출처) | 이 포탈에서의 전제 · 미확인 |
|---|---|---|---|---|
| 1 | **디스크 SMART 누적 값** | 재할당 섹터 · 보류 섹터 · 복구 불가 오류 수를 디스크에서 직접 읽는다. 로그가 넘어가도 디스크에 남아 있어 ‘과거에 났는가’ 를 로그 없이 답한다 | Backblaze 는 SMART 5 · 187 · 188 · 197 · 198 로 고장 위험을 보고, 187 이 0 을 넘으면 교체를 잡는다(ⓐ). Scrutiny 는 제조사 임계 대신 실제 고장 통계 기반 임계를 쓴다(ⓕ) | iDRAC 텔레메트리 스토리지 리포트(Datacenter 라이선스) 또는 OS · ESXi 에서 읽기. RAID 뒤 디스크를 OS 에서 읽으려면 컨트롤러 통과 옵션이 필요(ⓕ) — 속성 이름 · 가능 여부 미확인 |
| 2 | **vSAN · ESXi 쪽 디스크 상태** | vSAN 이 ‘고장 임박’ 으로 표시했거나 데이터를 대피시킨 디스크, ESXi 가 말하는 SMART 상태를 함께 보여 준다 — Patrol Read 가 돌지 않는 HBA · vSAN 디스크(§12.4-7)를 덮는다 | vSAN 은 느려지거나 고장 나는 디스크를 감지해 데이터를 옮기거나 디스크를 내린다. 호스트에서 디스크별 SMART 상태를 조회할 수 있다(ⓑ). 소프트웨어 정의 스토리지가 고장으로 표시한 디스크는 교체 대상(ⓒ) | vCenter 의 vSAN 상태 API 수집 추가 — 지금 없다. API 이름 미확인 |
| 3 | **재발 판정** | 같은 디스크에서 점검마다 계속 나오는가 / 한 번 나오고 멈췄는가를 가른다. ‘계속 나옴’ 을 교체 우선으로 올린다 | Patrol Read 때마다 오류가 나오면 곧 교체, 고쳐진 오류가 그 뒤 멈추면 대개 무해하다는 현장 경험(ⓓ) | 이미 모으는 기록만으로 가능 |
| 4 | **교체 뒤 재발 → 가상 디스크 의심** | 디스크를 바꾼 뒤에도 같은 자리에서 고장 예측 · 불량 블록이 다시 나오면 ‘디스크가 아니라 가상 디스크(puncture) 문제일 수 있음’ 을 알린다 | 두 번 교체해도 예측 실패가 돌아온 사례 — 가상 디스크의 puncture 가 새 디스크로 복사된 것으로 추정(ⓓ) · puncture 설명(§12.1 ③) | 시리얼 이력(§8.3)이 쌓인 뒤부터 가능 |
| 5 | **같은 가상 디스크에 이력 디스크 2개 이상** | 한 RAID 묶음 안에 배드 섹터 이력 디스크가 둘 이상이면 ‘이중 장애 위험’ 으로 맨 위에 올린다. 리빌드 전에 다른 구성원의 이력을 보여 준다 | puncture 는 이중 장애에서 생긴다(§12.1 ③) · 리빌드 중 복구 불가 오류 PDR64(§12.1 ④) · 교체 · 리빌드 전에 백업 먼저(ⓔ) | 가상 디스크 구성원 정보(§14.1 ⑥)가 읽히면 가능 |
| 6 | **펌웨어를 같이 본다** | 기록이 있는 디스크의 펌웨어 판을 옆에 쓰고, 같은 모델 안에서 펌웨어별로 가른다. ‘교체 전에 펌웨어부터’ 안내 | Dell 은 예측 실패 때 디스크 · iDRAC · RAID 컨트롤러 펌웨어를 먼저 올리고, 그래도 남으면 교체하라고 한다(ⓔ) · 특정 모델의 미디어 오류가 펌웨어 문제였던 사례(§12.2 ㉓) | 포탈은 이미 펌웨어 인벤토리를 읽고 ‘Disk’ 로 분류한다(`redfish.js:964 · 1013`) — 엣지 축약 인벤토리에 실리는지는 미확인 |
| 7 | **조치 추적** | 새 ‘복구 불가’ 기록 → 포탈 이슈로 자동 등록, 상태(확인 · 교체 요청 · 교체됨)를 쫓고, 시리얼이 바뀌면 자동으로 닫는다 | Dell SupportAssist 는 예측 고장을 감지해 케이스를 자동으로 열고 부품을 보낸다(ⓖ) — 포탈은 Dell 에 케이스를 열 수 없으니 내부 추적으로 대신한다 | 기존 `server/src/issues/` 모듈(자동 등록 전례 있음 — 연결 방식은 구현 때 확인) |
| 8 | **Patrol Read · 일관성 검사가 켜져 있는가** | 꺼진 컨트롤러를 따로 표시한다 — 꺼져 있으면 기록이 안 생겨 ‘기록 없음’ 을 믿을 수 없다 | 펌웨어 갱신 뒤 Patrol Read · Consistency Check 가 켜져 있는지 확인하라는 Dell 권고(§12.2 ㉓) | 컨트롤러 설정을 Redfish 로 읽는 속성 이름 미확인 |
| 9 | **디스크 가동 시간 기준 고장률** | 디스크 수가 아니라 ‘디스크 × 사용 기간’ 으로 나눈 연간 고장률, 나이대별 분포 | Backblaze Drive Stats 방식(ⓐ) · NetApp 은 드라이브 오류 계수를 점수화한다(ⓗ) | 가동 시간은 SMART 값이라 1번이 먼저 |
| 10 | **핫 스페어 · 자동 교체 설정 점검** | 이력 디스크가 있는 가상 디스크에 핫 스페어가 있는지, ‘예측 실패 시 자동 멤버 교체’ 가 켜져 있는지 | Dell PERC 의 ‘Automatic Replace Member with Predicted Failure’ 기능(ⓘ — 제목만 확인) · NetApp 은 예측 시 스페어로 미리 옮긴다(ⓗ) | 설정 속성 미확인 |

권하는 순서(내 판단): **3 · 5**(지금 모으는 것만으로 되고 교체 우선순위를 바로 준다) → **7**(찾은 뒤의 일을 닫는다) → **1 · 2**(볼 수 없는 디스크와 로그 유실을 메운다 — 가장 값이 크지만 실장비 확인이 필요) → 6 · 8 → 9 · 10.

출처: ⓐ https://www.backblaze.com/blog/hard-drive-smart-stats/ · https://www.computerworld.com/article/2846009/the-5-smart-stats-that-actually-predict-hard-drive-failure.html ·
ⓑ https://knowledge.broadcom.com/external/article/326859/how-to-troubleshoot-vsan-osa-disk-issues.html · https://knowledge.broadcom.com/external/article/395966 · https://blogs.vmware.com/cloud-foundation/2021/01/01/degraded-device-handling/ ·
ⓒ https://www.dell.com/support/kbdoc/000219050/drives-replacement-request-for-drives-marked-as-failed-or-unusable-by-software-defined-storage-solution-sdss ·
ⓓ https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/PERC-H700-predictive-failure-continues-with-new-drive/m-p/7209908 · https://www.dell.com/community/PowerEdge-HDD-SCSI-RAID/R720XD-Correctable-Disk-Media-Errors/td-p/5183008 · https://www.esdm.co.uk/looking-at-perc-raid-controller-log-files-for-disk-errors ·
ⓔ https://www.dell.com/support/kbdoc/en-uk/000126418/poweredge-hdd-what-is-predicted-drive-failure-and-how-to-solve-it ·
ⓕ https://www.linuxlinks.com/scrutiny-webui-smartd-smart-monitoring/ · https://grafana.com/grafana/dashboards/24591 · https://shop.zimaspace.com/blogs/product-comparisons/best-raid-monitoring-tools-home-servers(판매처 블로그 — 2차 자료) ·
ⓖ https://i.dell.com/sites/doccontent/shared-content/services/en/Documents/Dell_SupportAssist_Enterprise_Customer_Overview.pdf · https://m.principledtechnologies.com/Dell/ProSupport_Plus_with_SupportAssist_for_servers_0618.pdf ·
ⓗ https://snia.org/sites/default/files/2025-05/SNIA-SDC21-Jibbe-Binford-Drive-Health-Monitor-for-HDD-drives-On-Prem-and-Cloud.pdf · https://kb.netapp.com/on-prem/ontap/OHW/OHW-KBs/What_is_the_difference_between_disk_predictive_failure_and_physical_disk_failure_in_ONTAP_9 ·
ⓘ https://www.manualslib.com/manual/600037/Dell-6-Series.html?page=38

## 17. 추가 요구(사용자 2026-11-14 10차) — 판단 근거 표시 · 법인별 보기 · 참고 자료

- "판단 근거를 포탈에 표시해줘" · "디스크 배드 섹터 분석 메뉴를 법인별로 보는 기능 추가" · (출처 목록 그림을 ‘판단 근거’ 아트보드에 붙여 넣고) "이것도 추가해줘"

### 17.1 판단 근거 — 아트보드 `Basis.dc.html`

화면의 판정 표지(기록 있음 · 기록 없음 · 아직 사용 중 · 교체됨 · 판단 불가 · 볼 수 없음 · 확정하지 못함)를 누르면 열린다. 판정마다 세 가지를 보여 준다.

1. **확신 수준**: 확정(포탈이 직접 본 값끼리 맞춤 — 시리얼 등) / 추정(로그에 남은 기록으로 미룸) / 판단 안 함(근거가 모자라 말하지 않음).
2. **근거 목록**: 사실 한 줄 + 출처(로그 항목 · 포탈이 적어 둔 시리얼 이력 · iDRAC 스토리지 구성 · Dell 문서) + 시각.
3. **틀릴 수 있는 경우**(또는 ‘왜 말하지 않는가’): 그 판정이 뒤집힐 조건을 한 줄로.

`Main` 판정 띠에 ‘판단 근거 보기’, ‘지금 디스크’ 표의 판정 표지 옆에 확신 수준과 ‘근거’ 링크, `Fleet` 표의 근거 칸이 이 화면을 연다.
구현 규칙: 판정을 내는 순수 함수가 **판정 · 확신 수준 · 근거 목록을 한 번에** 돌려준다(화면이 근거를 따로 지어내지 않는다 — 판정 코어는 하나). 근거가 비면 판정도 ‘판단 안 함’ 이다.

### 17.2 법인별 보기 — 아트보드 `FleetCorp.dc.html`

분석 화면 머리의 **범위** 선택(전체 법인 / 법인 하나) 또는 국가·법인 표의 법인 이름을 누르면 화면 전체가 그 법인으로 좁혀진다.
수치 5칸 · 전체와 견주기(1,000개당) · 모델별 · **서버별 표**(국가·법인 표 자리) · 월별 추이 · [이 법인 점검]. ‘전체로’ 로 돌아간다.

- 법인 계정은 처음부터 자기 법인으로 열리고 범위를 바꿀 수 없다(§10 결정). 범위 밖 법인은 목록에 없다.
- 포탈 도구 화면은 머리의 범위 선택을 이미 갖고 있다(`SpecialTools.jsx` — `docs/design/server-temp/README.md` §‘달리하는 점’ 1). **범위 선택을 두 번 그리지 않는다** — 구현 때 기존 것을 쓴다(시안은 위치만 보여 준다).
- 한 법인만 보면 건수가 적어 비율 · 추이가 한두 건에 흔들린다는 문구를 화면에 넣었다.

### 17.3 참고 자료를 판단 근거에 표시

§16 조사에 쓴 자료 19건을 `Basis` 아래 ‘판단 규칙을 정할 때 참고한 자료’ 표로 넣었다(무엇을 뒷받침하나 · 자료 링크 · 이 포탈에서의 쓰임).
쓰임은 정직하게 나눴다: **판단에 반영**(고장 예측을 따로 세는 규칙 — Dell KB 000126418 · Dell 백서) / **검토 중**(재발 판정 · vSAN 상태 · SMART 값 · 조치 추적 — 아직 판단 규칙에 없다) / **참고만**.
즉 지금 화면의 판정은 ‘검토 중’ 자료에 기대지 않는다는 문구를 같이 넣었다. 붙여 넣으신 그림은 이 표로 바꿨다.

### 17.4 캔버스 직접 편집과 겹친 일

사용자가 캔버스에서 직접 편집(그림 붙여 넣기)하는 사이에 내가 `Fleet.dc.html` · `canvas.json` 을 게시했다(게시 도구가 ‘직전 저장본을 덮었다’ 고 경고).
다시 읽어 확인한 바로는 `canvas.json` 은 내 것과 같았고 붙여 넣은 그림은 `Basis.dc.html` 에 남아 있었다. `Fleet.dc.html` 에 손으로 고친 것이 있었다면 사라졌을 수 있다 — 사용자에게 알렸다.

## 18. 제안 10건을 시안에 추가(사용자 2026-11-14 11차)

- "제안 10건 전부 시안에 추가해줘" → 분석 화면에 탭 3개(조치 · 상태 값 · 설정 점검)와 아트보드 3장.

| 제안(§16) | 시안 위치 | 읽어야 하는 값 | 값을 읽는 방법 확인 |
|---|---|---|---|
| 1 디스크 SMART 누적 값 | `Health` 수치 · ‘로그에는 없는데 디스크 값에 흔적’ 표 · `Priority` ‘디스크 값’ 열 | 재할당 · 보류 · 복구 불가 수 · 가동 시간 | **미확인** — iDRAC 텔레메트리 속성 이름(Datacenter 라이선스), ESXi · OS 에서 읽는 명령, RAID 뒤 디스크를 OS 에서 읽을 수 있는지 |
| 2 vSAN · ESXi 디스크 상태 | `Health` ‘vSAN 상태’ 열 · 수치 2칸 · `Usage` 2번 | vSAN 의 고장 임박 · 대피 표시, ESXi 의 디스크 상태 | **미확인** — vCenter 의 vSAN 상태 API 이름 · 포탈 계정 권한 |
| 3 재발 판정 | `Priority` ‘최근 점검 6회’ 열 · ‘계속 나옴 / 멈춤’ 표지 | 없음(이미 모으는 기록) | 실장비 무관. ‘6회’ 는 시안 값 — 구현 때 설정값으로 |
| 4 교체 뒤 재발 | `Priority` 주황 띠 | 시리얼 이력(§8.3) | 시리얼 이력이 쌓인 뒤부터 |
| 5 같은 묶음에 이력 디스크 둘 이상 | `Priority` 빨간 띠 · ‘같은 묶음에 둘’ 표지 | 가상 디스크 구성원 · RAID 수준 · 핫 스페어 | §14.1 ⑥ 으로 확인 |
| 6 펌웨어 | `Priority` ‘모델 · 펌웨어’ 열 · `Config` ‘모델 · 펌웨어별’ 표 | 디스크 펌웨어 판 | 중앙 직결 서버는 이미 읽는다(`redfish.js:964 · 1013`). 엣지 축약 인벤토리에 실리는지 **미확인** |
| 7 조치 추적 | `Priority` 수치 5칸 · ‘조치’ 열 · 흐름 설명 | 없음(포탈 이슈) | 기존 `server/src/issues/` 와의 연결 방식 — 구현 때 코드로 확인 |
| 8 Patrol Read 켜짐 | `Config` 수치 · ‘살펴볼 컨트롤러’ 표 | 컨트롤러의 Patrol Read 모드 · 일관성 검사 일정 | **미확인** — Redfish(Dell 확장) 속성 이름 |
| 9 가동 시간 기준 비율 | `Health` ‘가동 시간으로 나눈 비율’ · ‘쓴 기간별’ | 가동 시간(1번과 같은 출처) | 1번에 달려 있다 |
| 10 핫 스페어 · 자동 교체 | `Config` 표의 두 열 · 수치 2칸 | 핫 스페어 지정 · ‘고장 예측 때 자동 교체’ 설정 | 핫 스페어는 §14.1 ⑥ 에서 볼 수 있을 것(추정), 자동 교체 설정 속성은 **미확인** |

### 18.1 화면이 지키는 것

- **읽지 못한 값은 0 이 아니다**: `Health` 는 ‘값을 읽은 디스크 3,410 / 11,980’ 을 맨 위에 두고, 못 읽은 디스크는 수치에서 뺀다. `Priority` 의 디스크 값 칸은 ‘못 읽음’.
- **순서는 점수가 아니라 이유의 차례**: 같은 묶음에 둘 → 교체 뒤 재발 → 계속 나옴 → 복구 불가 있음 → 그 밖. 가중치를 지어내지 않았다(근거 없는 숫자를 만들지 않는다).
- **재할당 · 보류가 0 이 아니라고 고장이 아니다**(§16 ⓐ — Backblaze 도 ‘살펴볼 이유’ 라고 한다). 복구 불가 ≥ 1 만 조치 목록에 올린다.
- **펌웨어**: 포탈은 어느 판이 최신인지 모른다 — ‘이 포탈 안에서 같은 모델에 더 높은 판이 있음’ 만 말하고, 차이를 펌웨어 탓으로 단정하지 않는다(오래된 서버일 수 있다).
- **설정 점검은 보여 주기만** 하고 바꾸지 않는다(Patrol Read 를 켜는 동작은 범위 밖).
- Patrol Read 가 꺼진 서버의 ‘기록 없음’ 은 분석에서 ‘믿을 수 없음’ 으로 따로 센다(§12.4-7 과 같은 줄기).
- `Health` 의 ‘어디서 읽었나’ 막대 세 색(`#3b82f6` · `#0d9488` · `#a855f7`)은 색각 분리 · 명도 대역 · 대비 검사를 통과한 조합이다.

### 18.2 실장비 확인에 더할 것(§14.1 에 이어서)

```bash
# ⑦ 디스크의 Dell 확장 속성 전체 — 미디어 오류 수 · 가동 시간 같은 값이 있는지
G "$B<디스크 경로>" | jq '.Oem'
# ⑧ 컨트롤러의 Dell 확장 속성 — Patrol Read 모드 · 일관성 검사 · 자동 교체 설정이 있는지
G "$B<컨트롤러 경로>" | jq '{Oem, StorageControllers}'
# ⑨ 텔레메트리 리포트 목록 — 스토리지 · SMART 리포트가 있는지(Datacenter 라이선스 서버에서)
G "$B/redfish/v1/TelemetryService/MetricReports" | jq '[.Members[]["@odata.id"]]'
```
ESXi 호스트에서는 디스크 하나의 상태 조회(`esxcli storage core device smart get -d <장치>` — Broadcom 문서 §16 ⓑ)가 값을 내 주는지 한 대에서 본다.

### 18.3 정정

- 앞서 `Usage` 2번(vSAN 디스크)과 `Fleet` 첫 행에 ‘PDR46 6건 · vSAN 데이터스토어’ 를 같이 그렸는데, **RAID 로 묶이지 않은 vSAN 디스크에는 PDR46 이 생기지 않는다**(§12.2 ⑲⑳㉑ — 내가 확인한 내용과 어긋난 예시였다).
  `Fleet` 첫 행은 로컬 데이터스토어로, `Usage` 2번은 다른 서버의 ‘vSAN 고장 임박 · 복구 불가 3’ 디스크로 고쳤다.
- `Basis` 참고 자료 표의 ‘검토 중’ · ‘참고만’ 을 ‘시안에 추가 · 실장비 확인 전’ 으로 바꿨다.

### 18.4 규모가 달라진 점

제안 10건으로 구현 범위가 처음 설계(로그 읽기 · 판정 · 분석 · 점검)의 대략 두 배가 된다(내 추정 — 수집 경로가 로그 1개에서 로그 · 디스크 값 · vSAN · 컨트롤러 설정 4개로 늘어난다).
나눠 내는 순서(제안): **1단계** 로그 기반 기능(§3~§15) + 3 · 5 · 7(추가 수집 없이 됨) → **2단계** 6 · 8 · 10(인벤토리 · 설정 읽기) → **3단계** 1 · 2 · 9(새 수집 경로 — 실장비 확인 결과에 달림).

## 19. 요약 장표 갱신(사용자 2026-11-14 12차)

- "요약 장표에도 추가된 기능 반영해줘" → `Report.dc.html` 을 다시 짰다.
- 바뀐 점: 기능 구성을 4열 16칸으로(처음 설계 뒤에 더한 8칸에 ‘추가’ 표지 — 법인별 보기 · 판단 근거 · 교체 우선순위 · 조치 추적 · 디스크 상태 값 · vSAN · ESXi 상태 · 설정 점검 · 모델 · 펌웨어별) ·
  ‘배경’ 칸을 없애고 요약 문장에 합침 · 한계에 ‘추가 기능의 값은 읽는 방법이 미확인’ · 다음 단계를 실장비 확인 → 1 · 2 · 3단계로(나눠 내기는 **제안** — 결정된 것이 아니라고 장표에 적음) · 일정 칸에 ‘범위는 처음 설계의 약 두 배(추정)’.
- 장표에는 여전히 가상 수치를 쓰지 않았다. 한 장(1123×794) 안에 들도록 높이를 계산으로 맞췄고 **그려진 결과를 눈으로 확인하지 않았다**.
