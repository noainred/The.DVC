# 설계: 특수 기능 › 리포트 · 점검 › 정기 점검 보고(`#/tools/periodic-report`) — 일일 · 주간 · 월간 · 분기 자동 점검 보고

작성 2026-11-07 (main v2.939.0 `7910e18` 병합 기준 · 브랜치 `claude/pensive-cori-6nqpf3`) · 상태 **시안 — 컨펌 대기(§5)** ·
시안 캔버스: https://claude.ai/artifact/Q39QmkeATriGtawheikGha (아트보드 7장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. HTML 프로토타입이지 복사 대상이 아니다.
**모든 수치 · 법인 코드(KR1 · PL1 · CN2 …) · 날짜 · 상단 버전 배지는 그림용 가상값**이고 기능 이름 · 메뉴 경로 · 도구 키 · 모듈 · 함수 이름만 실제 포탈 것이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로. 축 3개의 범주 색은 feature-usage 시안에서 검증한 값(`#3b82f6 #d97706 #0891b2`)을 다시 썼고 dataviz 검증기를 어두운 패널(`#141b2d`) 위에서 통과했다(2026-11-07 실측).
판정 4종의 상태색(초록 · 주황 · 빨강 · 회색)은 포탈 토큰 그대로인데 검증기의 **범주 팔레트 검사로는 초록↔주황이 적색약 ΔE 5.7 로 실패**한다 — 그래서 시안의 모든 판정 칩은 색만으로 구분하지 않고 **기호(✓ ! × ?)와 글자를 항상 함께** 둔다(일일 헬스체크 · SAN 월간 점검 화면과 같은 규칙).
계정의 ‘Design System’ 아티팩트는 없어서 쓰지 않았다.)

규칙(2026-11-03 ‘기억해’): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현. §2 는 이 세션(Fable)이 코드로 확인한 사실, §3~§6 은 시안 단계에서 채웠다. §7 은 구현에서 채운다.

## 1. 요구(사용자 2026-11-07 19:15 KST)

> "지금 동작하는 모든 기능을 검토해서 일일/주간/월간/분기 단위로 인프라/서비스/설비를 점검해서 정기적 보고를 자동으로 진행하고 보고하는 서비스를 만들고 싶어, 시안 만들어서 보여줘"

진행 중 고른 것: 없음 — 자율 세션(사용자가 중간 질문에 답할 수 없는 환경)이라 30분 규칙의 ‘방식 질문’ 을 생략하고 **표준**(카탈로그 + 기존 장치 조사 → 시안)으로 진행했다. 생략 사실을 보고에 적었다.

해석: ‘점검’ 은 새 수집이 아니라 **이미 포탈이 수집 · 판정해 둔 것을 주기마다 모아 결재 가능한 보고서로 만드는 것**이다. 28개 vCenter · RTT 800ms+ 환경에서 보고서 때문에 장비에 다시 붙으면 폴러 · 엣지와 경합한다(루트 CLAUDE.md 운영 환경). 그래서 설계의 제1 원칙은 ‘새 수집 0건 · 엣지에 새 작업 0건’ 이고, 못 읽은 것은 **확인 불가**로 따로 센다(‘못 읽은 값은 0 이 아니다’).

## 2. 지금 코드에서 확인한 것(설계의 근거)

조사는 v2.914 체크아웃에서 Explore 에이전트 2개로 했고(각 57 · 91회 도구 호출), main v2.939.0 을 병합한 뒤 아래 함수 · 파일의 존재와 줄을 다시 확인했다(줄 번호는 병합 뒤 값).

| 사실 | 위치 |
|---|---|
| **일일 보고의 원형이 이미 있다** — `computeHealthReport(snap, opts)` 가 8절(vcenters · hosts · datastores · snapshots · tools · orphaned · alarms · certs)을 `{status: ok\|warn\|crit\|unknown, count, items}` 로 내고 종합은 crit > warn > unknown > ok. 확인 못 한 축은 `summary.unknown` 으로 따로 센다 | `server/src/reports/healthReport.js:14` · `:168 buildDailyReportText` |
| 그 발송 스케줄러 — 60초 틱 · ‘설정 시각을 지났고 오늘 안 보냈으면’ · `lastRunTs` 영속 · 실패 backoff 15→30→60분 · 수동 발송은 예약을 대신하지 않음 → `sendText`(Slack · Teams · 웹훅 + 메일 ‘daily’) | `reports/dailyReport.js:36·149` · `alerts.js sendText` · `routes/admin/opsSettings.js /admin/report/daily` |
| 메일 종류 13 · 새 종류는 `KINDS` 에 추가 + `sendPortalMail({kind, subject, html, text, to, attachments})` · 종류별 수신자 `resolveRecipients` · 시간당 상한 · 첨부 상한 5개 · **5MB**(`ATTACH_MAX_BYTES`) | `mail/kinds.js:17` · `mail/service.js:79` · `util/smtp.js:157` |
| 일 · 주 · 월 정시 판정 코어 — `SCHEDULE_KINDS = once·daily·weekly·monthly`(**quarterly 없음** → 추가) · 유예 30분 · 그 달에 없는 날은 말일 · `nextOccurrence` | `xferspeed/schedule.js:22·66·115` |
| ‘회차’ 판정 — `planDigestTick → send/missed/rebase/none` · **놓친 회차는 몰아 보내지 않음** · `since` 는 서버가 정해 소급 발송 없음 · 받는 사람 = 통합 관리자(메일 기본 받는 사람) ∪ 추가 주소. 아이실론 종합 · 스토리지 사용량 · 게스트 파티션이 같은 코드 | `isidu/digestRules.js:179·202` · `storage/usageMailRules.js` |
| 주 · 월 보고 선례 — 스토리지 사용량 보고(일 · 주 · 월 · ISO 주 · 기준 요일 · 그 날 수집이 없으면 직전 6일 안 최신) + XLSX 첨부(exceljs 워커) | `storage/usageReport.js` · `usageXlsx.js` · `util/xlsxWorkerRun.js` |
| SAN 월간 점검은 **순수 판정만** 있고 스케줄러가 없다 — `checkDevice`/`summarizeAll`(ok · warn · bad · unknown · `uncheckedCount`) · 기록은 라우트를 부를 때만(`healthHistory.recordRun`, 장비당 24회) · 스냅샷 나이로는 판정하지 않음 | `sanswitch/healthCheck.js:183·694` · `routes/api/sanSwitch.js` |
| **PDF 는 서버에 없다** — 웹 `jspdf`+`html2canvas` 동적 import(`saveElementAsPdf` · `saveDocAsPdf`). 메일에 PDF 를 첨부하려면 서버 생성 엔진이 새로 필요하다(의존성 · 오프라인 패키지 · 한글 폰트) | `web/src/views/tools/reportExport.js:111·333` · `web/package.json:25` |
| 게시판 — 서버 내부에서 `createNotice(body, user)` · `createPost` 를 바로 부를 수 있다 · **첨부 없음** · 본문 5천/1만 자. 이슈 자동 등록 선례(시스템 계정 · origin 중복 방지 · 하루 상한) | `bulletin/store.js:581·666` · `issues/autoCreate.js` · `attach/store.js`(kind 는 wiki · issue 만) |
| 알림 채널 — `sendText(text, title, kind)` 가 Slack · Teams · 웹훅 + 메일(`email.enabled`) 을 한 번에 | `alerts.js` · 설정 `alerts.json` · `PUT /admin/alerts` 는 fleetOnly |
| vCenter 인벤토리는 **메모리 스냅샷**(+ 위임분 `central-inventory.json`) · 실패 시 마지막 정상값 6시간 유지 · site push 끊김 5분 → stale · pending · maintenance 구분 있음 | `store.js`(LASTGOOD_HOLD_MS · SITE_STALE_MS · `siteInventoryStale`) · `central/inventory.js` |
| **vCenter 이벤트 DB 에는 직접 수집 vCenter 만** 쌓인다(365일). 엣지 법인 이벤트는 엣지에 있고 중앙은 연합 조회로 WAN 을 왕복한다 → 변경 이력 · 생성/삭제 · 로그인 실패 · 미보호 VM 은 그 법인을 `notCollected` 로 분리한다 | `logs/db.js` · `logs/coverage.js` · `routes/api/checksLogs.js /vclogs/federate` |
| 저장된 이력(보관) — vmtrack 1095일(00 · 12시) · metrics `samples_hourly` 1830일 · capacity 72h/400일 · storage `capacity_daily` 5년 · bmstor 1825일 · SAN `pp_1h` 730일 · 전력 `power_hourly` 90일 · roomtemp 1830일 · part_event 730일 · bmusage `usage_daily` 5년 · pdu 400일 · cvp `port_daily`/`fault_event` 730일 · link 90일/5년 · xfer 180일/5년 · dns 365일 · horizon 400일 · curuser 180일 · isidu 400일 · dirusage 365일 · veeam `license_daily` 400일 | 각 모듈 `db.js` |
| 이력이 **없는** 것(회차 시점 값만 가능) — svcmon 결과(메모리 · CSV 회전 로그) · 경보 recent(메모리 100건) · 인증서 캐시(메모리) · relaycheck(메모리) · hostcfg/vmcfg/contention 캐시(메모리) · **백업 결과 일 롤업 없음**(veeam-latest.json · bareos-jobs.json) | `svcmon/poller.js` · `security/certMonitor.js` · `relaycheck/poller.js` · `veeam/store.js` |
| 도메인별 판정 코어(그대로 쓴다): `hostcfg/analyze` · `vmhygiene/analyze` · `clustercfg/analyze`+`n1` · `dscfg/analyze` · `contention/analyze` · `storage/growth growthMatrix`+`usageInsights`(80/90 · 8주) · `cvp/overview deviceHealth` · `linkcheck/phases judge` · `veeam/backupStatus backupVerdict`(RPO 1/3/7) · `bareos/health judgeCorp` · `vmclone/rpo` · `reports/unprotected` · `svcmon/status testState` · `health/services getServiceCheck` · `portalcheck/tokenScan rowStateOf` · `partfault/transition` · `idrac/roomTemp inletStatus`(ASHRAE) · `pdu/thresholds evaluateSnapshot` · `bmusage/alertRules` · `gpu/activity` · `isidu/digestRules statusOfRow` · `security/certMonitor certExpiryStatus`(30/90) · `license-expiry` · `security/loginFails` · `reports/compliance` · `reports/zombies` · `corelicense/analyze` | 각 모듈 |
| stale 구분 필드가 거의 전 도메인에 있다(`stale`·`staleMs`·`notReadVcenters`·`notCollected`·`unreadVcenters`·`vcenterLicensesUnread`·`veeamStale`·`directorState`) — 보고서는 이것을 ‘확인 불가’ 로 옮긴다 | 각 조회 라우트 응답 |
| 권한 · 범위 — `fullScopeOnlyWith`(= fleetOnly) · `requireSettingsOwner`(소유자 ∧ 전체 범위) · `scopedVcenterIds` · `scopeSlice`/`scopeKey`(memoJson `extraKey` 필수) · `isAdminDetailUser` · 법인↔vCenter 는 `datacenterOfVcenter` · 이름 `corpNameOf` | `routes/admin/shared.js:19·64` · `auth/scope.js:16` · `routes/api/shared.js:91` · `auth/demoGuest.js:130` · `datacenter/store.js:94` · `isidu/corpName.js` |
| 엣지 — 새 종류 push 선례(`agent/*Push.js` → `routes/central.js post('/<kind>', requireCentral())` → `central/*Edge.js` 정제 화이트리스트) · 중앙→엣지 작업 표(`bareos/ops.js` + `edgeOps` 큐)는 **이 서비스가 쓰지 않는다**(1단계는 중앙이 이미 받은 것만 읽는다) | `central/isiduEdge.js` · `central/partFaultEdge.js` · `bareos/service.js onDirector` |
| 성능 유틸 — `createYielder`(시간 기준 양보) · `acquireExport`(서버 전체 동시 1건 · 겹치면 409) · `dayKey`/`portalParts`(KST) · `longTimer`/`adaptiveTimer` | `util/timeSlice.js:16` · `util/exportBusy.js:30` · `util/dayKey.js` |
| 설정 묶음 9개 — ‘알림 · 연동’(`notify`) = alerts · mail · ai-search · tool-categories → 새 하위 `periodic-report` 를 `mail` 다음에. `docs/SETTINGS.md` 는 51(About)이 마지막 번호 → **52** | `web/src/views/Settings.jsx:145 GROUPS` · `docs/SETTINGS.md:503` |
| 도구 122개 · 카탈로그 PRESET ‘리포트 · 점검’ 에 `daily-health` · `insights` · `backup-*` 가 있다 → `periodic-report` 를 여기에 · `auth/toolAccess.js` 매핑 · 테스트가 PRESET 전부 덮는지 대조 | `web/src/views/specialToolsList.js` · `server/src/toolcats/catalog.js:33` |

## 3. 화면(IA) — 아트보드 7장

| # | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` | **보관함**(1440) — 특수 기능 › 리포트 · 점검 › 정기 점검 보고 · 탭 [보관함 97 \| 점검 항목 54 \| 일정 · 전달] · ‘새로 수집하지 않습니다’ 띠 → 다음 회차 카드 4(주기 · 다음 시각 · 마지막 결과) → KPI 6(최근 회차 종합 · 정상 · 주의 · 이상 · 확인 불가 · 법인 보고 27/28) → 필터(주기 세그먼트 · 법인 · 기간 · 판정 · 검색) → STable(생성 · 회차 ID · 주기 · 기간 · 종합 · 4종 수 · 법인 · 데이터 기준 · 전달 결과 · 열기/XLSX) · 전달 실패 행 · 아래 3칸(누가 보나 · 판정 4종 · 열기 · 내보내기) |
| ② | `Catalog.dc.html` | **점검 항목 · 주기 배치**(1440) — 54항목을 인프라 25 · 서비스 17 · 설비 12 로 묶은 표(항목 · 원천 도구 · 모듈 · 판정 기준(기존 함수 그대로) · 일/주/월/분기 · 원천 상태(중앙 직접 · 엣지 push · 꺼짐 opt-in · 직접 수집만) · 켜기) · 집계 칩(일일 22 · 주간 42 · 월간 47 · 분기 18) · 범례 |
| ③ | `Schedule.dc.html` | **일정 · 전달**(1440) — 왼쪽 주기 카드 4(켜기 · 시각 · 기준 요일/날짜 · 대상 기간 · 다음/마지막 실행 · 지금 만들기(미리보기) · 지금 만들어 보내기) + 회차 규칙 띠 / 오른쪽 메일(종류 · 받는 사람 · 법인 담당자 자기 분량 · 주기 · 첨부 XLSX/PDF) · 알림 채널 · 게시판 · 이슈 · 보관 4 · 지금 상태(스케줄러 · 진행 · 재시도 · 놓침) · 기존 일일 리포트와의 관계 경고 띠 · 저장(fleetOnly · 감사) |
| ④ | `Report.dc.html` | **보고서 열람 — 월간 예시**(1440) — 머리(제목 · 종합 칩 · 기간 · 생성 · 데이터 기준 · 법인 · 항목 · 직전 회차 · 버튼 6) · 목차 칩 → 1 종합(4종 + 정보 · 직전 회차 대비 · 축 카드 3) → 2 조치 필요 6(우선 · 판정 · 법인 · 축 · 항목 · 근거 · 9월 · 바로가기) → 3 법인별 현황(28행 · 축 칸은 그 축의 최악 판정 · 확인 불가 수 · 데이터 기준 · 수집 방식 · 미보고 법인 강조) → 4~6 축별 상세(항목 · 판정 · 근거 · 대상 · 법인 분포 · 직전 · 원천 바로가기) → 7 확인하지 못한 것(사유 · 확인하려면) → 8 부록(원천별 마지막 수집 · 방식 · 보관 · 생성 기록) |
| ⑤ | `Flow.dc.html` | **동작 흐름**(고정 1440×1240 다이어그램) — 중앙 레인: ① 스케줄러(1분 틱 · 회차 판정 · lastRun · 놓침 · 재진입 가드) → ② 조립기(항목 54 리더 · 청크 + 양보 · 동시 1건) → ③ 저장(periodic.db + XLSX · 한 트랜잭션) → ④ 전달(메일 · 채널 · 게시판 · 재시도) → ⑤ 열람(범위 절단 · PDF 는 화면). 조립기는 아래 원천 5(스냅샷 · SQLite 이력 · 상태 파일 · 기존 판정 함수 · 메모리 캐시)를 **읽기만** 한다. 엣지 레인: 기존 push → 중앙 수신 + 정제 → 적재(바뀌는 것 없음) · 2단계(점선) 엣지 정기 점검 요약 push · ‘엣지가 받는 새 작업: 없음’. 아래 규약 카드 3(성능 · 범위 · 저장) |
| ⑥ | `States.dc.html` | **상태 8종** — ⓐ 생성 중(그 주기만 잠금 · 법인/축 진행 · 중단 없음 · 실패 회차는 다시 만들지 않음) ⓑ 엣지 미보고 법인(확인 불가 · 이유 단정 안 함 · 회복 시 자동 반영) ⓒ 전달 실패(생성과 전달 분리 · backoff · 수동 즉시) ⓓ 범위 계정(내 법인 행만 · 귀속 없는 항목 미노출 · 일정 탭 403 ErrorBox) ⓔ 원천 오래됨(회차 기준 ‘오래됨’ · 기준은 API 값) ⓕ 첫 회차(대비 ‘—’ · 0 과 섞지 않음) ⓖ 원천 기능 꺼짐(보고서가 켜지 않음 · 켜는 곳 링크) ⓗ 수동 미리보기(회차 없음 · 보관 · 전달 안 함 · ‘이대로 보관하고 보내기’) |
| ⑦ | `Narrow.dc.html` | **400px** — 보관함(햄버거 · 탭 가로 스크롤 · 버튼 2열 44px · 다음 회차 2×2 · KPI 2열 · 세그먼트 전폭 · 표는 가로 넘김) + 보고서 요약(종합 칩 · 버튼 2열 · 4종 칩 · 축 카드 1열 · 조치 필요 표 가로 넘김) |

## 4. 설계 결정(시안에 그대로 그린 것)

### 4.1 단위와 판정
- 보고 단위는 **항목**(카탈로그 54개 중 그 주기에 실린 것)이고, 항목마다 **법인(= vCenter = Bareos) × 항목** 행을 가진다. 항목 판정은 법인 행들의 최악값, 축 판정은 항목들의 최악값, 종합은 축의 최악값 — 모두 **crit > warn > unknown > ok**(`computeHealthReport` 와 같은 순서). ‘판정 없음(정보)’ 항목(VM 수량 추이 · 소비 전력 · Horizon · 폴더 Top-N · 베어메탈 스토리지 · 인벤토리 변동 · 어레이 전력 · 코어 라이선스)은 수치 · 추이만 싣고 종합 수에 넣지 않는다.
- **확인 불가(unknown)는 따로 센다** — 수집 꺼짐(opt-in) · 엣지 미보고 · 원천 오래됨 · 못 읽음(`notRead*`·`unread*`·`notCollected`) · 인증 정지. 정상으로 흡수하지 않고 종합에서 빼지도 않는다. 일부 법인만 못 읽은 항목은 확인된 범위로 판정하고 ‘확인 불가 법인 N’ 을 같이 적는다.
- 임계값 · 판정 함수는 **각 기능의 것을 그대로 호출**한다(판정 코어 하나). 보고서가 새 임계값을 들이지 않는다 — 기준 숫자는 API 값으로 받아 적고 화면 · 문서에 박지 않는다.

### 4.2 주기와 기간(포탈 시각 KST · 기본값은 컨펌 항목 ①)
| 주기 | 기본 실행 | 대상 기간 | 항목 | 회차 ID |
|---|---|---|---|---|
| 일일 | 매일 08:00 | 어제 00:00~24:00 + 지금 상태 | 22 | `D-YYYY-MM-DD` |
| 주간 | 월요일 08:30 | 지난 ISO 주(월~일) — 스토리지 사용량 보고의 주 정의 | 42 | `W-YYYY-WW` |
| 월간 | 매월 1일 09:00(없는 날은 말일) | 지난 달 | 47 | `M-YYYY-MM` |
| 분기 | 1 · 4 · 7 · 10월 1일 09:30 | 지난 분기 | 18 | `Q-YYYY-N` |
- 회차 판정은 `planDigestTick` 의 규칙(놓친 회차는 몰아 보내지 않음 · 시각 변경 소급 없음) + `xferspeed/schedule.js` 에 `quarterly`(months 1·4·7·10 + monthDay) 를 더한다. 1분 틱 · `lastRun` 영속 · 재진입 가드 · 조립은 서버 전체 **동시 1건**(`acquireExport('periodic-report')`).
- 주간 · 월간 · 분기의 ‘기간 통계’ 는 **이력 표가 있는 원천만**(vmtrack · capacity_daily · cvp · link · xfer · power · part_event · bmusage · pdu · isidu · horizon). 이력이 없는 원천(svcmon · 인증서 · relaycheck · 백업 결과)은 **회차 시점 상태**로 싣고 그 사실을 항목에 적는다. 가동률(%) · 백업 성공률 같은 기간 비율은 2단계(§6) — 대안으로 일일 회차의 `items` 를 누적해 ‘한 달 중 주의였던 날 수’ 를 보고서 DB 자체에서 계산한다(새 수집기 없이).

### 4.3 항목 카탈로그 — 54(기본 배치 · 관리자가 주기 · 켜기 변경 가능)
축별 원천 키(도구 키)와 기본 주기(D 일일 · W 주간 · M 월간 · Q 분기):
- **인프라 25** — vCenter 도달성 DWMQ · 호스트 연결 DWMQ · DS 사용률 DWMQ · 오래된 스냅샷 DWM · vCenter 알람 D · VMware Tools WM · 고아/좀비 WM · 호스트 구성 WM · VM 구성 WM · 클러스터 HA·DRS WMQ · DS 경로/vSAN WM · 경합 DW · VM 수량 추이 WMQ(정보) · 어레이 사용률/장애 DWM · 증가량/소진 WMQ · SAN 포트 오류/광량 DWM · SAN 월간 점검 M · CVP DWM · 중복 IP WM · VM DNS WM · 용량 고갈 MQ · 버전/패치 MQ · 라이선스 만료 WMQ · 인증서 만료 DWMQ · 코어 라이선스 Q(정보)
- **서비스 17** — svcmon 상태 DWM · Veeam 판정 DWM · Bareos 요약/사전 점검 DWM · 미보호 VM WM(직접 수집만) · 백업 안 된 VM DW · VM 복제 RPO DW · 통신 점검 DWM(기본 꺼짐) · 엣지 보고 신선도 DWM · 전송 속도 WMQ · HAProxy 경로 DW · 포탈 점검 WM · 포탈 내부 서비스 DW · 포탈 DB MQ · 로그인 실패 WM(직접 수집만) · 자격증명/자가 점검 MQ · Horizon WM(정보) · 포탈 서버 적정성 MQ
- **설비 12** — 파트 장애 DWM(opt-in) · 흡기/전산실 온도 DWM · 소비 전력 WMQ(정보) · PDU DWM · 베어메탈 사용률 WM(opt-in) · 베어메탈 스토리지 M(정보) · GPU WMQ · 어레이 전력 M(정보) · 아이실론 디렉터리 WM · 게스트 파티션 WM · 폴더 Top-N M(정보) · 인벤토리 변동 MQ(정보)
- 카탈로그는 서버 모듈(`periodic/catalog.js`)이 진실의 원천이고 각 항목은 **리더**(`read(ctx) → {status, count, basis, byCorp[], asOf, source, unknownReason?}`)를 가진다. 리더는 저장된 것만 읽는다(vCenter 로그인 · SSH · Director 호출 금지 — 테스트가 소스 스윕으로 고정).

### 4.4 저장
- `periodic.db`(`<dbDir>/periodic.db`, `node:sqlite` + `util/sqliteOpen.js`): `runs(id, kind, period_from, period_to, as_of, generated_at, by, overall, ok, warn, crit, unknown, info, corps, corps_reported, duration_ms, status)` · `items(run_id, key, axis, vcenter_id, corp, status, count, basis, as_of, source_ts, detail_json)` · `deliveries(run_id, channel, target, status, at, reason, attempt)` · `ts` 단독 인덱스 · 적재는 **한 트랜잭션** · prune 은 주기별 보관 일수로 스로틀 + 청크.
- XLSX 파일(법인별 시트 · 전체 요약 · 조치 필요 · 확인 불가)은 `<dataDir>/periodic/<run-id>.xlsx` — exceljs 워커(`runXlsxWorker`) · 같은 보관 기간.
- 설정 `periodic-report.json`(원자적 쓰기 · 손상 보존): `{kinds:{daily:{enabled,hour,minute,skipWeekend}, weekly:{…,weekday}, monthly:{…,monthDay}, quarterly:{…}}, catalog:{overrides:{key:{periods,enabled}}}, delivery:{mail:{enabled,extraTo,corpOwners,kinds,attachXlsx}, chat:{enabled,kinds}, board:{enabled,kinds}, issues:{enabled}}, retainDays:{…}, lastRun:{…}}`.
- 보관 기본 — 일일 90일 · 주간 365일 · 월간 1095일 · 분기 1825일(컨펌 ②). 백업(`/api/admin/backup`)에는 설정 파일만 넣는다(보고서 · XLSX 는 재생산 가능하지 않지만 자격증명이 아니고 크다 — 컨펌 때 물을 것).
- 규모(추정 — 구현 때 실측): 회차당 행 ≈ 항목 47 × 법인 28 ≈ 1,300 · 일일 365회 + 주간 52 + 월간 12 + 분기 4 → 연 약 50만 행 · 보관 적용 시 약 15만 행 · XLSX 1~3MB/회차.

### 4.5 전달
| 경로 | 무엇을 | 규칙 |
|---|---|---|
| 메일 `kind: 'periodic'`(KINDS 추가) | HTML 본문(종합 · 축 요약 · 조치 필요 · 확인 불가 수 · 열기 링크) + XLSX 첨부 | 받는 사람 = 통합 관리자(기본 받는 사람) ∪ 추가 주소 · **법인 담당자**(vCenter 담당자 주소 — 게스트 파티션 메일의 목록 재사용)는 자기 법인 분량만(범위 절단과 같은 함수) · 첨부 5MB 초과 시 링크만 · 전달 실패는 backoff 재시도(생성과 분리) |
| 알림 채널 `sendText` | 종합 · 4종 수 · 조치 필요 상위 5 · 링크(텍스트) | 일일 헬스체크 리포트와 같은 경로 · 주기별 켜기 |
| 게시판 `createNotice` | 요약 + 링크(5천 자 상한 · 첨부 없음) | 시스템 계정 `periodic-report` · 주간/월간/분기 기본 |
| 이슈 자동 등록(선택) | ‘이상’ 조치 항목 → 이슈 | `issues/autoCreate` 방식(origin 중복 방지 · 하루 상한) · 기본 꺼짐 |
| PDF | **화면에서 저장**(웹 jspdf — 다른 보고서와 같은 방식) | 서버 PDF 첨부는 2단계(컨펌 ④) |

### 4.6 API 와 문지기
| 경로 | 누가 | 비고 |
|---|---|---|
| `GET /api/tools/periodic-report/runs?kind&from&to&corp` · `/runs/:id` · `/runs/:id/export.xlsx` | 로그인 사용자(`requirePerm('tools')`) | `scopedVcenterIds` 교집합으로 `items` 절단 · 귀속 없는 항목(vcenter_id null)은 범위 계정 미노출 · `memoJson` + `extraKey: scopeKey(...)` · 못 읽으면 503(빈 목록 금지) · 응답에 `asOf` · `partial` · `unknownReasons[]` |
| `GET /api/tools/periodic-report/catalog` | 로그인 사용자 | 읽기(항목 · 주기 · 원천 상태) |
| `PUT /api/admin/periodic-report/catalog` · `GET/PUT /api/admin/periodic-report/settings` | `fullScopeOnly`(전체 범위 관리자) | 400 으로 거부(조용히 고치지 않음 — usageMailRules 규칙) · 감사 로그 `detail` |
| `POST /api/admin/periodic-report/run {kind, preview}` | `fullScopeOnly` | preview=true 면 회차 없이 10분 캐시 · 아니면 수동 회차(by=user) · 동시 1건 409 |
| `POST /api/admin/periodic-report/runs/:id/deliver {channel}` | `fullScopeOnly` | 전달만 재시도(backoff 무시) |
| 엣지(2단계) `POST /api/central/periodic-check` | `requireCentral()` + agent 바인딩 | 정제 화이트리스트(`central/periodicEdge.js`) · 수신 시각으로 자름 |

### 4.7 성능 · 범위 · 엣지 규약(루트 CLAUDE.md 운영 환경에 대한 답)
- ‘이 값을 못 읽으면?’ → 확인 불가 + 사유 + 확인 경로. ‘범위 계정이면?’ → 내 법인 행만 · 전 법인 설정 403 · 귀속 없는 항목 미노출. ‘엣지 위임이면?’ → 중앙이 이미 받은 push 만 읽고, 미보고는 확인 불가 · 엣지에 새 작업 0.
- 조립은 법인 단위 조각 + `createYielder` 양보 · 동시 1건 · 조립 중 vCenter 로그인 0회(테스트가 리더 소스를 스윕) · DB 적재 한 트랜잭션 · prune 스로틀 · 큰 응답은 `BIG_JSON` 불필요(요약만) · XLSX 는 워커.
- 상시 폴링 없음 — 보관함은 마운트 1회 + 버튼, 생성 중일 때만 그 회차 상태를 5초 폴링(그 대상만 잠금).

### 4.8 화면 규약
- 표 전부 `STable`(제목 클릭 정렬 · `minWidth` · null·‘—’ 뒤로) · 문구는 `BoldText`(백틱 금지) · uppercase 금지 · 그리드 자식 `min-width:0` · 버튼 행 `flexWrap` · 403 은 `ErrorBox` · 주기 · 보관 · 임계 숫자는 API 값.
- 판정 칩은 기호 + 글자(색만 금지) · 0 과 ‘—’ 를 섞지 않음 · 직전 회차 없으면 대비 ‘—’ · 부분 · 오래됨 · 미리보기는 띠/배지.

## 5. 컨펌 항목

| # | 결정 | 시안의 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 주기별 실행 시각 · 기준 | 일일 08:00 · 주간 월 08:30 · 월간 1일 09:00 · 분기 1/4/7/10월 1일 09:30 | 다른 시각 · 주말 건너뛰기 기본 켬 |
| ② | 보관 기간 | 일일 90일 · 주간 1년 · 월간 3년 · 분기 5년 | 전부 1년 · 더 길게 |
| ③ | 기존 ‘일일 리포트’(설정 › 알림)와의 관계 | **나란히**(그대로 두고 경고 띠 — 둘 다 켜면 두 번 받음) | 흡수(기존 설정 화면이 여기로 안내 · 기존 발송 끔) |
| ④ | PDF | **화면에서 저장**(의존성 추가 없음) | 서버 PDF 엔진 신설(메일 첨부 — 의존성 · 오프라인 패키지 · 한글 폰트 번들, 규모 +1단계) |
| ⑤ | 엣지 법인의 이벤트 기반 항목(미보호 VM · 로그인 실패 · 변경 이력) | **1단계 확인 불가**로 싣고 2단계에 엣지 요약 push | 이번에 함께(엣지 워커 + 중앙 정제 + 테스트, 규모 +1단계) |
| ⑥ | 법인 담당자 메일 | 넣는다 — vCenter 담당자 주소 재사용 · 자기 법인 분량만 | 통합 관리자만 |
| ⑦ | 게시판 공지 · 이슈 자동 등록 | 공지 켜짐(주간 이상) · 이슈 꺼짐 | 둘 다 끔 · 이슈도 켬 |
| ⑧ | 메뉴 위치 | 도구 `#/tools/periodic-report`(탭 3) + 설정 › 알림 · 연동 › 정기 점검 보고(같은 일정 · 전달 화면으로) | 설정 하위만 · 상단 메뉴 승격 |
| ⑨ | 항목 54 기본 배치 | 그대로 | 줄이기(예: 정보 항목 제외) |
| ⑩ | 보고서 · XLSX 를 포탈 백업에 포함 | 설정 파일만 | 보고서 DB 까지 |

## 6. 구현 계획(컨펌 뒤 Opus — L 등급)

- 서버: `server/src/periodic/{catalog.js, readers/*.js(축별), assemble.js, schedule.js(quarterly 포함), scheduler.js, db.js, store.js, settings.js, deliver.js, xlsx.js, html.js}` · `routes/api/periodicReport.js` · `routes/admin/periodicReport.js` · `mail/kinds.js` 에 `periodic` · `toolcats/catalog.js` PRESET · `auth/toolAccess.js` · `index.js` stagger 기동 · `insights/dbLocation.js`·`portalDb.js`·`dbGuideData.js` 등록 · `docs/SETTINGS.md` 52 · 생성 문서(api-doc · config-doc) · 릴리스 노트.
- 웹: `web/src/views/tools/PeriodicReport.jsx`(보관함 · 점검 항목 · 일정 · 전달) · `PeriodicReportView.jsx`(보고서) · `periodicReportText.js`(순수 문구 · 판정 라벨) · `periodicReport.css` · `specialToolsList.js` · `Settings.jsx SUB`(`notify` 묶음) · `reportExport.js` 재사용(PDF).
- 테스트: 회차 판정(일 · 주 · 월 · 분기 · 말일 · 놓침 · 소급 없음 · 재진입) · 종합 순서(crit>warn>unknown>ok · 정보 제외) · 확인 불가가 정상에 안 섞임 · 리더가 저장된 것만 읽음(소스 스윕: `soapClient`·`ssh`·Director 호출 0) · 범위 절단(귀속 없는 항목 미노출 · 메일 담당자 분량 = 같은 함수) · fullScopeOnly 403 · 전달 실패와 생성 분리 · backoff · 첨부 5MB 초과 시 링크 · 설정 400 · prune · 카탈로그 PRESET 대조 · `settingsMenu2905` 갱신 · 웹 문구 테스트.
- 검증(표준): 관련 테스트 + Chromium 1440/400 1회(관리자 · 범위 계정 A/B) + 전량 verify + 릴리스. 예상 규모(추정): 구현 세션 4~6시간(Opus) + 검증 · 릴리스 1시간 — 실측은 구현 보고에.

## 7. 정직 기록(시안 단계)

- 조사는 v2.914 체크아웃에서 했고 main v2.939.0(187 커밋 뒤)을 병합한 뒤 §2 의 함수 · 파일 · 줄을 다시 확인했다. 그 사이 `periodic-report` 류 기능은 추가되지 않았다(grep 0건).
- 진행 메시지의 시각 중 **19:52 · 20:02 는 측정하지 않은 추정값**이었다(규칙 위반 — 실제 측정은 19:15 · 19:41 뿐). 보고에 정정으로 적었다.
- 시안은 Chromium 으로 보지 않았다(규칙상 시안 단계는 캔버스 확인만 — 구현 때 1440/400 판독). 캔버스의 표 · 칩 배치는 브라우저에서 사용자가 보는 것이 최종이다.
- 구현 기록(§7 본문)은 Opus 구현에서 채운다.
