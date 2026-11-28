# 설계: 특수 기능 › 리포트 · 점검 › 정기 점검 보고(`#/tools/periodic-report`) — 일일 · 주간 · 월간 · 분기 자동 점검 보고

작성 2026-11-07 (main v2.939.0 `7910e18` 병합 기준 · 브랜치 `claude/pensive-cori-6nqpf3`) · 상태 **구현 — v3.32(§8)** · 컨펌 2026-11-20 '진행해'(§5 기본값 + 구현 때 갱신 두 가지 — §8 1 · 2) · **백업 성공 · 실패 현황 시안 2026-11-27(§9 — 컨펌 대기)** ·
시안 캔버스: https://claude.ai/artifact/Q39QmkeATriGtawheikGha (아트보드 9장 — 2026-11-27 에 ⑧ ⑨ 를 더하고 ① ② ③ ④ ⑦ 을 고쳤다(§9). 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. HTML 프로토타입이지 복사 대상이 아니다.
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
- 구현 기록은 §8 이다.

## 8. 구현 기록(v3.32 — Opus · 2026-11-20)

컨펌: 2026-11-20 사용자 '진행해'. 직전 답변에서 '시안 갱신이 먼저 필요하다' 고 했는데 세션이 Opus 로 돌고 있었다 — 규칙(Opus 는 시안을 만들지 않는다)에 따라 **캔버스는 다시 그리지 않았고**, 갱신해야 할 결정 두 가지(§8 1 · 2)를 이 절에 적고 기본값으로 구현했다. 구현 시점 main v3.30.4 를 병합했고, 마무리 전에 v3.30.6 을 다시 병합했다. 머지 직전 다른 작업이 v3.31.0 을 먼저 게시해 main(v3.31.0)을 병합하고 이 작업을 **v3.32.0** 으로 다시 매겼다(테스트 파일 이름도 `periodicReport3320`).

| 영역 | 파일 |
|---|---|
| 서버 | `server/src/periodic/{rules,catalog,assemble,render,db,service,providers}.js` · `periodic/readers/{common,vsphere,devices,services,facility,index}.js` · `routes/api/periodicReport.js` · `routes/api.js`(등록) · `index.js`(1분 틱 기동 — 중앙만) |
| 기존 코드에서 뽑은 것(판정 코어 하나) | `tools/capacityForecastItems.js`(용량 고갈 예측 항목 — 라우트와 리더가 같이) · `routes/api/reports.js unprotectedData`(미보호 VM) · 공급자 등록 `veeam.js`(Backup Summary) · `reports.js`(미보호 VM) · `vmDns.js`(VM DNS) · `diskbad/jobs.js corpResolverNow`(메일과 같은 법인 판정) |
| 등록 | `mail/kinds.js`(periodic-report) · `auth/toolAccess.js`(세그먼트 = 키) · `toolcats/catalog.js`(리포트·점검) · `insights/{dbLocation,portalDb,dbGuideData}.js`(periodic.db) · `docs/SETTINGS.md` 42번(뒤 번호 +1) · 생성 문서 5종 |
| 웹 | `web/src/views/tools/PeriodicReport.jsx` · `periodicReport/{Archive,ReportView,CatalogTab,ScheduleTab,ScheduleStandalone,parts}.jsx` · `periodicReportText.js` · `periodicReport.css` · `specialToolsList.js` · `SpecialTools.jsx` · `Settings.jsx`(알림·메일 묶음) |
| 테스트 | `server/test/periodicReport3320.test.js`(14) · `web/.../periodicReportText.test.js`(7) · 옮긴 계산을 따라간 스윕 3건(`audit2599e` · `audit2606g` · `bugfixes20260810`) · 등록부 · 분류표 5건(`settingsMenu2905` KEYS_ADDED · `usage/keys.js` SETTINGS_KEYS · `readErrorSweep97` ALLOW · `restoreSweep114` + `backup/stagedRestore.js` · `staleSnapshotSweep126` TABLE) |

**시안 · 컨펌 기본값과 달라진 점(정직 기록)**
1. **PDF — 서버 PDF 엔진 대신 자급형 HTML 첨부**(§5 ④ 갱신): 시안 뒤 main 에 생긴 SAN 스토리지 성능 월간 · PowerScale 주간 보고서가 같은 방식(브라우저에서 인쇄 › PDF)이다. 의존성 · 한글 폰트 번들 없이 같은 결과를 낸다.
2. **새로 생긴 분야별 정기 보고 4종은 그대로 두고 판정 요약만 항목으로**(§5 ⑨ 갱신): SAN 스토리지 성능(san-storage-perf) · PowerScale 점검(ps-inspect) · 디스크 배드 섹터(disk-bad)를 항목으로 더했고, IP 관리 정기 보고는 기존 ‘IP 관리’ 항목이 같은 모델(`gatherReportModel`)을 읽는다.
3. **항목 53개**(시안 54): 위 3개를 더하고 아래를 뺐다 — 이유를 남긴다.
   · ‘백업 안 된 VM(찾기 조건)’ — Veeam 판정 항목의 RPO(7일 · 3일)와 같은 원천이고, 조건은 관리자가 메일 알림으로만 정한다(그 메일 ‘백업 안 된 VM’ 은 그대로 나간다).
   · ‘포탈 점검(토큰 · 아키텍처)’ — 조립이 라우트 안이고 엣지 프로브 결과(메모리)에 기대어 회차 시점에 비어 있기 쉽다.
   · ‘평문 자격증명 · 자가 점검’ — 비밀 스캔은 소스 트리 전체를 훑는 무거운 작업이고, 자가 점검은 사용자 목록을 읽을 때 기본 관리자를 만드는 부작용 경로가 있다.
   · ‘스토리지 어레이 전력’ — ‘소비 전력’ 항목이 iDRAC 서버 전력만 싣는다(어레이 전력은 전체 소비 전력 도구에서).
4. **XLSX 는 보관 파일이 아니라 내려받을 때 만든다**(data.csv 권한 · 동시 1건) — 회차 문서 하나에서 만들 수 있어 파일 보관 · 정리를 두지 않았다. 메일에는 HTML 보고서를 첨부한다.
5. **공지는 회차마다 새로 올리지 않고 하나를 갱신**(7일 뒤 내림) — 공지 상한(noticeMax)을 자동 보고가 채우지 않게. 공지 글에는 **판정 · 법인 이름을 싣지 않는다** — 공지는 범위와 무관하게 모든 계정에 보여 범위 계정에 다른 법인 상태가 새기 때문이다(‘가림은 응답 경로 전부에’).
6. **법인 담당자 받는 사람은 이 기능의 설정**(vCenter 별 — PowerScale · IP 관리 정기 보고와 같은 방식) — 게스트 파티션 메일 목록을 빌리지 않았다(기능 사이 결합).
7. **알림 채널 기본 꺼짐** — 기존 일일 리포트(같은 판정 함수 · 같은 채널)와 겹쳐 아침에 두 번 받지 않게(§5 ③ ‘나란히’ 의 결과).
8. **회차 ID 는 기간 기준** — 일일 `D-<그 날>`(만든 날이 아니라 보고한 날) · 주간 `W-<ISO 연도>-<주>` · 월간 `M-<연>-<월>` · 분기 `Q-<연>-<분기>` · 수동은 끝에 `-m<포탈 시각 HHMMSS>`.
9. **첫 설치는 놓침을 줄줄이 적지 않는다** — 기록 · since 가 없으면(기본값 켜짐) 기동 시각 - 30분을 바닥으로 본다(기동 직후 유예 안 회차는 만든다).
10. **대상이 없는 항목은 ‘정상’ 이 아니라 정보(해당 없음)** — 등록된 장비 · 잡 · 링크가 0이면 판정 수에 넣지 않는다.
11. **확인 불가로 남는 것(1단계 한계)**: 미보호 VM · 로그인 실패는 이벤트를 모으지 않는 vCenter(엣지 법인)를 확인 불가로 · 베어메탈 사용률은 이 포탈이 직접 수집한 서버만(엣지 값은 엣지 파일 — 중앙이 보고서를 위해 엣지를 부르지 않는다) · 서비스 모니터 · 전송 속도는 법인 귀속이 없어 전체 항목 · 이력 표가 없는 원천(서비스 모니터 · 인증서 · HAProxy 경로)은 회차 시점 상태.
12. **판정 기준 문구**를 실제 판정에 맞췄다 — 호스트 연결 끊김은 이상(일일 헬스체크 hosts 절), vCenter 알람은 위험(critical)만, 고아 VM 은 이상.
13. **리더 시한 20초** — 던지거나 넘기면 그 항목만 확인 불가(사유 적음) · 회차는 계속.
14. **범위 계정**: 목록 수는 회차 행렬로 다시 세고(문서를 읽지 않음), 보고서 · HTML · XLSX 는 자기 법인 행만, 법인 행이 없는 항목은 숨기고, 전달 기록은 주지 않는다 · 보이는 행이 하나도 없으면 404.
15. **복원 분류**: 설정 `periodic-report.json` 은 ‘그대로’(사람이 고치는 값), 상태 `periodic-report-state.json` 은 ‘지금 것 유지’(실행 회차 — 되돌리면 마지막 회차 · 공지 id 가 옛 값으로 돌아간다).

**검증 기록(2026-11-20)**
- 전량 서버 테스트 1회차(수정 도중 코드)에서 실패 10건 — 전부 이 작업이 원인이었다: 옮긴 계산을 따라가지 않은 스윕 3건(용량 예측 1 · 미보호 VM 2) · 생성 문서 2종 낡음(3건) · 등록부 · 분류표 미등재 4건(`usage/keys.js` · `readErrorSweep97` · `restoreSweep114` · `staleSnapshotSweep126`). 고친 뒤 해당 11개 파일 143건 통과.
- 스윕이 잡은 결함 2건(테스트 통과용 등재가 아니라 코드를 고쳤다):
  · `readers/common.js vcUnreadReason` 이 ‘못 읽은 vCenter’ 판정을 따로 하나 더 두고 있었다 — 공용 `metrics/unreadVcenters.js` 를 부르게 바꿨다(첫 수집 중만 보고서 쪽에서 덧붙인다 — 공용 판정은 합계를 막지 않으려고 일부러 뺀다).
  · ‘소비 전력’(정보) 항목이 `allMeasuredPower` 에 vcSkip 을 넘기지 않아, 점검중 · 수집 실패 · 보고가 오래된 vCenter 와 끊긴 호스트의 마지막 추정 전력이 합계에 들어갔다 — store.js 와 같은 `unreadVcenterReasons + usageReadable` 을 넘기고 뺀 대수를 근거에 적는다.
- Chromium(목 서버 · 1440 / 400 · 메인이 스크린샷 직접 판독) — 페이지 오류 0 · 페이지 가로 넘침 0(400 에서 표는 감싼 틀 안 가로 스크롤). 판독에서 고친 것: 조치 필요 표 상한 30 + ‘전부 보기’ · 타일 판정 칩 늘어짐 · 법인 기준 시각(asOf) · 확인 불가 항목 근거 앞 ‘—’ · 화면에 박힌 숫자 4곳(미리보기 ‘10분’ · 첨부 ‘5MB’ · 인증서 확인 주기 · 카탈로그 ‘기본 N’ — 주기 · 상한은 API 값이 아니면 쓰지 않는다) · 라이선스 도구 이름 · 일정 이력 ‘사유’ 열 1440 넘침 · DB 크기 1MB 미만 ‘0.0 MB’ → KB.
- 전량 verify(커밋 7f3ed71e · 재번호 전): 서버 node:test 11,379건 — 통과 11,378 · 실패 0 · 건너뜀 1. 웹 eslint 오류 0(경고 37 — 새 파일 0). 웹 vitest **실패 1** — `audit2613b` WEB2613-09(화면 도구에 손으로 만든 `setInterval` 폴러 금지)에 `PeriodicReport.jsx` 의 ‘만드는 중일 때 5초 폴링’ 이 걸렸다.
  고친 것: 응답이 올 때마다 ‘아직 만드는 중이면 5초 뒤 한 번 더’ 를 `setTimeout` 으로 예약한다(요청이 겹치지 않고 · 끝나면 멈추고 · 조회 오류면 멈춘다). 상시 주기 조회가 아니라 usePolling 대상이 아니라고 판단했다 — 규약 목록(FOLLOW_UP)에 예외로 올리지 않았다.
  수정 뒤 웹 eslint · vitest(643파일 7,368건) · vite build 통과. 서버 쪽은 바뀐 것이 없어 다시 돌리지 않았다(CI 가 전량을 다시 돈다).

## 9. 백업 성공 · 실패 현황 — 시안(2026-11-27 · Fable) · 컨펌(2026-11-28) · 구현(v3.59 — §9.5)

요청(2026-11-26): “정기 점검 보고 시안 … 만들어서 보여줘 / 백업 성공/실패 현황도 같이 보여줘”. 고른 것: 전체를 HTML 시안으로 · Veeam · Bareos · VM 백업 전부.
캔버스(같은 링크)에 ⑧ `Backup.dc.html`(일일 보고서 3절) · ⑨ `BackupTrend.dc.html`(주간 변형 · 하루 치 적재 · 데이터 출처 · 컨펌)을 더했고, ① 보관함 · ④ 월간 보고서는 다시 그렸으며(v3.32.0 구현 화면 + 백업),
③ 일정 · 전달 · ② 점검 항목 · ⑦ 400px 은 백업 부분만 고쳤다. ⑤ 동작 흐름 · ⑥ 상태 8종은 그대로다. 하늘색 테두리 · 글자가 이번에 더한 부분이다.

### 9.1 지금 코드에서 확인한 것(v3.53.0 `a821fd9e` — 설계의 근거)

| 백업 | 저장된 값 | 기간 집계 |
|---|---|---|
| Veeam | VM 별 마지막 결과 · 끝난 시각 · RPO. `veeam/backupSummaryAgg.js` 가 `r24`(최근 24시간에 끝난 VM 마지막 결과 — **두 솔루션 합**) · `v7` · `b7`(7일 성공 / 실패 — 솔루션별)을 이미 센다 | 지난 날의 결과는 남지 않는다(`veeam-history.db` 에는 라이선스 · 저장소 일별 표만 있다) |
| Bareos | 원장의 `lastRun` + `finishedRuns`(`bareos/registry.js FINISHED_KEEP = 10`). `bareos/digest.js digestData` 가 법인별 24시간 VM 단위 결과를 센다(일일 요약 메일) | VM 당 끝난 실행 10회까지 |
| VM 백업(복제) | 잡마다 `history`(`vmclone/store.js HISTORY_MAX = 30`) + 위임 법인 보고(`vmclone/dispatch.js listEdgeStates`) | 30회까지 |
| 정기 점검 보고 | 백업 항목 3개는 전부 ‘지금 상태’ 판정이다 — `veeam`(실패 → 이상 · RPO 7일 넘음 → 주의) · `bareos`(**사전 점검만** — 원래 시안 ②의 ‘24시간 성공 · 실패’ 는 구현에 빠졌다) · `vm-clone`(RPO 만) | 기간 중 성공 · 실패 건수는 어디에도 없다 |

### 9.2 설계 결정(시안에 그린 것)

- **위치**: 보고서 3절(조치 필요 다음). 보관함에는 최근 일일 회차의 백업 띠와 표의 ‘백업 실패’ 열.
- **세는 단위**: VM(그날 그 VM 의 마지막 결과). 경고는 성공률에 넣고 취소는 실패에 넣는다 — Backup 현황 Summary(`R24` · `BR24`)와 같은 규칙. ‘실행 없음’ 은 판정하지 않고(RPO 가 판정) ‘확인 불가’ 는 성공에도 실패에도 넣지 않는다.
- **새 판정을 만들지 않는다**: 절은 수 · 목록 · 추이이고, 판정 칸은 서비스 축의 백업 항목 것이다(판정 코어 하나).
- **하루 치 적재(신설)**: `periodic.db` 에 날짜 · 백업 · 법인마다 한 줄(끝남 · 성공 · 경고 · 실패 · 실행 없음 · 확인 불가). 하루 한 번 위 세 원천의 저장값만 읽어 한 트랜잭션으로 쌓는다(Veeam · Director · 법인 엣지를 부르지 않는다). 주간 · 월간 · 분기는 적재분의 합 · 날짜별 추이. 적재가 없는 날은 ‘적재 전’ — 소급해 채우지 않고 합계 옆에 ‘적재 18 / 31일’ 을 적는다.
- **일일은 적재 없이도 된다**: `r24` 가 두 솔루션 합이라 솔루션별 24시간 수는 같은 순회에서 따로 세도록 넓힌다(공급자 `veeam-summary` 재사용) · VM 백업은 `history` 를 기간으로 자른다.
- **실패 목록**: 화면 30건 + ‘전부 보기’ · 메일 본문은 법인별 수만 · XLSX ‘백업 실패’ 시트에 전부. 사유는 저장된 첫 오류 줄(없으면 ‘오류 줄 없음’).
- **범위 · 전달**: 범위 계정은 자기 법인 행만. 공지에는 백업 수치를 싣지 않는다(§8-5 와 같은 이유).

### 9.3 컨펌 항목

1. 위치 — 보고서 3절. 권장: 예.
2. 세는 단위 — VM(그날 마지막 결과) · 경고는 성공 쪽 · 취소는 실패 쪽. 권장: Summary 와 같게.
3. 하루 치 적재 신설 · 보관 400일. 권장: 예(없으면 주간 · 월간 · 분기는 ‘지금 실패 상태’ 와 7일 수만 실을 수 있다).
4. Bareos · VM 백업의 실패를 항목 판정에 넣기 — 지금은 Bareos 는 사전 점검, VM 백업은 RPO 만 판정한다.
5. 이상 기준 — 지금은 Veeam 실패 VM 이 하나라도 있으면 이상이라 28법인 환경은 거의 매일 이상이 된다(시안 ① 의 일일 회차가 전부 ‘이상’ 인 이유). 안: 연속 2회 이상 실패 또는 RPO 7일 넘음만 이상, 한 번 실패는 주의.
6. 실패 목록 상한 — 위 9.2 그대로.

### 9.4 정직 기록

- **수치 · 법인 · VM 이름 · 실패 사유는 전부 그림용 가상값**이다. 합계는 맞춰 놓았다(일일 4,833 = 4,759 + 62 + 12 · 주간 실패 60 = 날짜 합 = 법인 합 · 월간 실패 412 = 날짜 합 = 종류 합).
- 11-07 캔버스의 틀 높이가 내용보다 짧아 아래가 잘려 있었다(점검 항목 2,240 ↔ 실측 3,405 · 월간 보고서 2,760 ↔ 3,732). 이번에 아트보드를 일반 HTML 로 풀어 Chromium 으로 높이 · 가로 넘침을 재고(1440 · 400 — 페이지 가로 넘침 0) 틀을 실측에 맞췄다. 캔버스 자체(Design 런타임)에서 렌더한 것은 아니다.
- ② 점검 항목은 11-07 배치(54줄) 그대로에 백업 한 줄만 더했다 — 구현(53개 · §8-3)과 다른 줄이 남아 있다. ⑦ 400px 의 보관함 표도 11-07 표본 그대로다(회차 ID 가 구현 규칙과 다르다).
- 날짜 오류를 고쳤다: 11-07 표본의 주간 회차가 ‘11-03 (월)’ 로 돼 있었는데 2026-11-03 은 화요일이다 — 다시 그린 장은 11-02 (월) · W-2026-44(10-26 ~ 11-01)로 맞췄고, 일일 회차 ID 도 구현 규칙(보고한 날 — `D-2026-11-06`)으로 바꿨다.

### 9.5 구현 기록(v3.59 · Opus · 2026-11-28)

컨펌(2026-11-28 사용자 답): ① 3절 · ② VM 단위 · 경고는 성공 쪽 · 취소는 실패 쪽 · ③ 하루 치 적재 신설 · 보관 400일 · ④ **넣기**(Bareos · VM 백업 실패를 항목 판정에) ·
⑤ **연속 실패만 이상**(연속 2회 이상 실패 · 마지막 성공 7일 넘음 = 이상, 한 번 실패 · 3일 넘음 = 주의) · ⑥ 화면 30건 + 전부 보기 · 메일은 법인별 수만 · XLSX 전부. 검증 수준: 전체 검증.

| 부분 | 파일 | 한 일 |
|---|---|---|
| 순수 규칙 | `server/src/periodic/backupLedger.js` | 결과 글자 → 상태 · 관측(obs) · 관측 범위(seen) · 확정 판정 · 그날 마지막 결과 · 연속 실패 · 항목 판정(`backupJudge`) · 3절 조립 · 합계 · 범위 절단 · 비관리자 판본 · 회차 행렬 요약 |
| 적재 DB | `server/src/periodic/db.js`(표 5개 `pr_bk_obs` · `pr_bk_seen` · `pr_bk_cursor` · `pr_bk_day` · `pr_bk_vmday`) · `backupStore.js` | 관측 한 번 · 확정 한 묶음이 각각 한 트랜잭션 · 정리는 날 인덱스 + 청크 · 'VM 마다 그날 마지막' 은 행을 읽어 JS 로(GROUP BY + MAX 금지) |
| 연결 | `backupService.js` · `service.js` · `assemble.js` | 서비스 틱의 관측 주기마다 관측 → 확정 · 회차 조립 때 3절(앞 기간 같은 길이 · 연속 실패 · 7일 이하 줄무늬) · 항목 판정 자료는 회차마다 공급자 한 번(ctx.cache) |
| 공급자 | `routes/api/veeam.js backupObserveData` | Backup 현황 Detail 과 같은 VM 단위 결과(`vcBackup` → `backupVmRows`) · 로그 DB · vCenter 를 부르지 않는다(`snapEvents: false`) · 원문 사유와 공개 문구를 함께 |
| 항목 판정 | `readers/services.js` veeam · bareos · vmClone · `catalog.js` | ④ ⑤ 그대로 — Bareos 는 사전 점검과 백업 결과 중 나쁜 쪽 · VM 백업도 같은 3일 · 7일 기준(첫 구현은 'RPO 넘김 = 주의' 로 컨펌과 달랐다 — §9.6 F7) |
| 라우트 | `routes/api/periodicReport.js` | 보고서 3절 판본(`backupView` — 비관리자 공개 문구 · 범위로 자른 뒤 합계를 다시 낸다) · 보관함 '백업' 수(행렬에서 범위로 다시 센다) · XLSX '백업 법인별' · '백업 실패' · 범위 계정 상태에는 적재 수를 싣지 않는다 |
| HTML · 메일 · 채널 | `render.js` | 3절 · 뒤 절 번호 밀기 · 메일 본문 한 단락(법인별 실패 수) · 채널 한 줄(합계만) · 확정된 날이 없는 수는 '—' |
| 화면 | `web/src/views/tools/periodicReport/BackupSection.jsx` · `ReportView.jsx` · `Archive.jsx` · `ScheduleTab.jsx` | 3절(타일 · 백업별 카드 · 날짜별 실패 · 법인별 · 실패 목록 30 + 전부 보기 · 되풀이 줄무늬) · 보관함 띠와 '백업 실패' 열 · 일정 카드(주기 · 백업 · 적재 · 보관 · 적재 상태) |
| 시험 | `server/test/periodicBackup3590.test.js`(11) · `web/.../periodicReportText.test.js`(+3) | 규칙 · DB 끝에서 끝까지 · 판정 · 범위 · 가림 · HTML · 실제 API |

**시안과 다르게 한 것**(근거와 함께):

- **'일일은 적재 없이' 를 하지 않았다** — 시안 §9.2 는 일일을 Summary `r24` 로 세자고 했지만, 일일도 적재를 쓴다. `r24` 는 '최근 24시간' 이라 보고 기간(전날 00 ~ 24시)과 다르고 회차를 만드는 시각에 따라 수가 바뀐다. 적재로 세면 일일 · 주간 · 월간이 같은 수를 합한 것이 된다(일일 합 = 주간 합). 대신 적재를 켠 첫날은 일일도 '적재 전' 이다.
- **'확인 불가' 를 VM 수가 아니라 '법인 · 백업 · 날' 수로 센다** — 그 법인을 읽지 못한 날에는 대상 VM 수도 모른다(시안의 '확인 불가 31'(VM)은 쓸 수 없는 값이었다).
- **확정 조건(§9.6 에서 다시 설계)** — 관측 두 번 사이의 틈마다 '잃은 것이 있는 틈인가' 를 그 틈에 걸친 날에 매기고, 그날 걸친 틈이 하나라도 잃은 틈이면 그날 그 법인 · 백업은 확인 불가. Veeam 은 VM 마다 마지막 결과 하나뿐이라 틈 길이(서버 상수)로, Bareos · VM 백업은 원본의 보관 개수(Bareos 보기 5건 · 복제 30회)와 Bareos 대조 창(최근 2일)으로 가른다 — 첫 구현은 기록형을 '날 끝 뒤 한 번 읽으면 다 보인다' 로 봤다(틀림).
- 연속 실패는 '일' 이 아니라 '회'(실행 횟수)로 적는다 — 시안의 '15일째' 는 하루 한 번 도는 잡일 때만 맞다.

**타협한 것 · 남은 것**:

- 데모(목) 모드에는 적재 씨앗이 없다 — 데모 보고서의 3절은 '적재 전' 으로 보인다.
- 보고서 문서의 실패 목록은 (백업, VM) 1,000줄 · 되풀이 200줄이 상한이다(분기 회차에서 넘으면 화면 · XLSX 가 '상위 N(전체 M)' 으로 말한다 — 'XLSX 에 전부' 는 상한 안에서만 맞다).
- Veeam 은 관측 틈이 짧아도, VM 이 관측 주기보다 자주 돌면(예: 매시간 백업 + 그날 마지막 실행이 다음 실행에 덮인 뒤 관측) 그날 마지막 결과를 놓칠 수 있다 — 틈 한도는 '빠진 날을 확인 불가로' 만 막는다.
- 줄무늬(날마다 결과)는 7일 이하 기간만 · 월간 · 분기는 날짜별 실패 칸과 실패한 날 수로 본다.

### 9.6 다섯 축 점검 · 반증 · 다시 설계(v3.59 · 2026-11-28)

첫 구현(`8c77c96a`)을 보안 · 판정 · 엣지 · 화면 · 성능 다섯 에이전트가 따로 읽고 재현했다(읽기 전용 · 재현 스크립트는 세션 스크래치패드). 같은 뿌리에서 나온 결함이 많아
**부분 수정이 아니라 구조를 다시 설계**했다(루트 CLAUDE.md '회차마다 수정이 새 결함을 만들면 구조를 다시 설계').

| 뿌리 | 확정 결함(재현) | 다시 설계한 것 |
|---|---|---|
| 기록형 '다 봤다' 를 증명하지 않음 | 화면 H1 · 판정 F2 · 성능 축 밖 — 8일 끈 뒤 · Director 3일 단절 뒤 · 엣지 44시간 끊김 뒤 밀려난 실행이 '알았음 · 실행 없음'(실패가 사라지거나 성공으로 뒤집힘) | 관측 틈마다 lossy — 완결 시작점(보기가 가득 찼으면 가장 오래된 실행 · 기록 새로 시작한 시각) · Bareos 대조 창(`RECONCILE_RECENT_DAYS` − 12시간) · 잘린 조회는 신선하지 않음 · 잃은 날은 다시 채우지 않음 |
| 복제 출처가 Detail 과 다른 실행 위치 판정 | 엣지 E1 · 판정 F8(위임 잡 미보고 → 중앙 · 지금 신선 · 실행 없음 · 만든 시각부터 7일 넘음 = 이상) · E2(옛 담당 엣지 보고에 묶임) · E3(엣지 시계 앞섬 → 같은 실행 여러 줄) · E4(원장 읽기 오류 → 해당 없음) | `execTargets` · `edgeStateOf` 하나 — 지금 담당 엣지의 보고만 · 없으면 모름 · 엣지 원래 시각(미래면 아직 받지 않음) · `jobsLoadError` 면 확인 불가 |
| 같은 실행을 두 번 셈 | 판정 F1 · F9 — lastRun 이 기록에도 같은 실행으로 있어 한 번 실패가 연속 2회 → 이상(컨펌 ⑤ 위반) | 연속 실패는 끝난 시각이 같은 줄을 한 번만 · 공급자도 jobid 로 걸러 싣는다 · 복제는 기록만 센다 |
| 요약에 '알았음' 수가 없음 | 화면 M2 M3 M4 M5 M6 · 판정 F4 F5 F6 F12 · 보안 S-1 — 모르는 수가 0(앞 기간 · 날 막대 · 보관함 칸 · 지금 실패 · 범위 판본 확정 날) · 일부 날만 확정된 앞 기간과 견줌 · 기다리는 법인-날이 표지 없이 빠짐 · 범위 판본에 전 법인 적재 시작 날 | 날마다 알았음 줄 · 앞 기간 날 표지(다 확정됐을 때만 견줌) · 확정 대기 줄(확인 불가로 셈 · 7일 안 보이면 없어진 법인) · 법인별 실패 수 · 상한의 법인 몫(30) · 지금 결과를 못 읽은 법인은 '지금 실패' 에서 뺌 · 범위 판본은 확정 날을 다시 세고 적재 시작 날을 싣지 않음 |
| 성능 | 성능 P1~P8(분기 조립 0.5초 정지 · vmFacts 상한 없음 · 첫 관측 한 트랜잭션 · 대상 목록 매번 다시 씀 · 정리 청크 · 겹친 인덱스) | 이번 기간 실패 줄만 7일 조각 + 양보 · 키 사이 양보 · 관측 4,000줄 조각 트랜잭션 · 같은 대상 목록은 쓰지 않음 · 밀린 확정 한 번에 7일 · 정리 50ms 목표 청크 · 날로 시작하는 기본 키에 겹친 인덱스 제거 |

그 밖에 고친 것: 판정 F7(VM 백업 '주의' 를 컨펌 그대로 3일) · F10(HTML 단위 '법인 · 백업 · 날') · F11(일일 시각이 확정 시각보다 이르면 일정 카드가 경고 — 지연은 API 값) ·
화면 M1(문서에 없는 vCenter 이름이 '—') · L2~L6 · L9 · 보안 S-2(설정의 객체 주기가 500 → 400) · **기존 결함** 보안 E-1(범위 계정 항목 근거에 전 법인 분포 · 수 — 정기 점검 보고 전 항목 · v3.32 부터).
변이 검증: 첫 구현 32건 중 31(살아남은 1건은 출력이 같은 변이 — 단언 보강) · 다시 설계 뒤 32/32(살아남았던 3건은 시험이 그 경로를 돌지 않던 것 — 보강).

**반증 1인(재설계 뒤 · 실행으로 재현 9건)** — 고친 것: F1 Veeam 연속 실패를 공급자의 마지막 성공(`lb`) 뒤 실행만으로(관측이 빈 동안의 성공을 원본이 몰라 '연속 2회 → 이상' 이 되던 것) ·
F3 신선한 관측이 없던 날의 대상 목록은 앞뒤 이틀 목록의 교집합만(잡이 없던 날에 새 잡을 대상으로 지어내 '실행 없음' 을 만들던 것) · F5 복제 결과 출처(중앙 · 담당 엣지)가 바뀐 틈은 잃은 틈(죽은 옛 엣지가 끝낸 실패를 새 엣지 기록은 모른다) ·
F6 앞 기간은 두 기간 모두 확인 불가 줄이 없을 때만 견줌 · F7 '지금 실패' 의 모름은 (법인, 백업) 마다 — 실지 않은 백업의 모름이 다른 백업을 빼지 않게 · F8 범위 판본은 행이 전부 범위 안이어도 전 법인 근거 · 직전 판정을 싣지 않음(기존 결함 E-1 의 남은 경로).
시험이 돌지 않던 경로(실제 원장 보기 → 관측용 잡 `bareosJobView` · 복제 30회 가득 참 · 잘린 조회 · Bareos · 복제 3일 넘음)도 실제 저장소로 시험한다(⑬). 수정마다 변이 12/12.
남긴 것: F2 잘린 조회(poll 중단 — partial)가 6시간 넘게 이어지고 매시간 도는 Bareos 잡이 있는 법인은 그날이 확인 불가(잦은 잡의 최근 5건이 그 사이 밀려난다 — 정직한 결과 · 평상 폴링에서는 생기지 않음) ·
F4 관측에서 빠진 법인(마지막 잡 삭제 · 연동 해제)은 7일 동안 '확정 대기' 로 확인 불가에 들어간다(그 뒤 없어졌다고 본다) · F9 Veeam 은 B&R 조회 틈이 3시간을 넘으면 하루 한 번 도는 VM 뿐이어도 그날 확인 불가(설계 한계 — 그사이 다시 돈 VM 의 결과가 덮였는지 모른다).

**남긴 것 · 타협**:
- Bareos 원장은 대조 틱(기본 10분)에서만 스케줄 실행을 받는데, `dir.at` 은 대조가 아닌 틱에도 앞으로 간다(엣지 L1) — 기본 폴링(60초)에서는 확정 지연(3시간) 안에 대조가 돌아 문제가 없고, 늦게 들어온 실행은 다시 확정한다. 폴링을 18분 넘게 늘린 현장에서는 마지막 실행이 확정 뒤에 들어올 수 있다(다시 확정으로 고쳐진다).
- 중앙 직접 Director 의 카탈로그 시각은 중앙 현지 시각으로 읽는다(기존 한계 · `bareos/CLAUDE.md`) — 시간대가 다른 Director 는 날 묶음이 몇 시간 어긋난다.
- 자동 재시도(Veeam 재시도 · Bareos Reschedule)가 새 실행으로 남으면 예약 한 번의 실패가 '연속 2회' 로 셀 수 있다(실환경 확인 필요 — 추정).
- 월간 · 분기 '앞 기간' 은 같은 길이의 바로 앞 날들이다(앞 달 회차의 합계와 다를 수 있다 — 의도).

