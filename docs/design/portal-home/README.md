# Handoff: 포탈 홈 — Overview/Summary 재정의 + 특수 기능 메뉴 격상

## Overview
`noainred/The.DVC` 웹 포탈(`web/src/App.jsx` 셸)의 첫 화면과 내비게이션 개편.
1. **Overview / Summary 역할 분리** — 두 화면에 겹치던 KPI(vCenter·호스트·VM·CPU·메모리·스토리지·전력·알람)를 한 곳에만 둔다.
   - Overview = **지금 상태** (연결·상태·알람·사용률·법인별 상태·조치 필요)
   - Summary = **자원 총량과 할당** (물리 vs 할당·오버커밋·OS별 할당·법인별 기여도)
2. **'특수 기능' 탭 폐지** — `specialToolsList.js` 의 91개 항목 + 기존 상단 탭을 10개 상위 메뉴로 격상 (각 항목 1회 소속, 누락 0·중복 0 검증 완료).
3. **서버 메뉴** — 물리 서버 / 가상화 호스트 / 가상화 서버(VM) 3구분.

## About the Design Files
`Portal Home.dc.html` 은 HTML로 만든 **디자인 레퍼런스**다. 그대로 배포하지 말고 기존 React(Vite) 코드베이스 패턴(`App.jsx` TABS·`usePolling`·`STable`·`Kpi`·`styles.css` 변수)으로 재구현한다. 브라우저로 직접 열어 확인 가능(같은 폴더의 `support.js` 필요).

## Fidelity
**High-fidelity.** 색·타이포는 `web/src/styles.css` `:root` 값 그대로. 숫자는 목업(법인명·법인별 수치는 가상) — 실제 값은 `/overview`, `/summary`, `/health` API.

## 셸 (App.jsx 대체)
- 레이아웃: `grid-template-columns: 232px minmax(0,1fr)`, 최소 높이 100vh.
- **좌측 사이드바** (bg `#0f1626`, 우측 보더 `#1f2a40`, sticky 100vh)
  - 브랜드: 34px 로고(radius 9, `linear-gradient(135deg,#3b82f6,#22d3ee)`, "V" 800) + "The Davinci **Virtual Platform**"(13px/700, 뒤 500 `#8b9bb4`) + 버전·소스 배지(JetBrains Mono 10px).
  - 그룹 라벨(Mono 9.5px, letter-spacing .16em, `#5d6b85`): DASHBOARD · OPERATE · INFRA · GOVERN · ADMIN
  - 항목: 7px 10px 패딩, radius 7, 13px/600, 좌측 2자리 인덱스(Mono 10px, opacity .6), 우측 기능 수. 활성 `rgba(59,130,246,.85)` / `#fff`, 호버 `rgba(59,130,246,.14)`, 기본 글자 `#c3cedf`.
  - 활성 메뉴 아래 하위 그룹 목록(좌측 1px `#243049` 라인, 12px). 서버 메뉴에서는 하위 항목이 구분 필터.
  - 하단: UPTIME · ROLE (Mono 10px).
- **상단 헤더** (sticky, `rgba(10,14,23,.92)` + blur 8px, 하단 보더 `#1f2a40`, 11px 24px): 좌측 코드+페이지명(15px/700) · 우측 "기능 · 화면 · VM 찾기 ⌘K" 검색(300px, 32px, `#141b2d`) · vCenter 상태 pill(기존 status-pill 로직 유지) · 사용자.
- **하단 statusbar**: 기존 4셀 그대로(서버 UPTIME · 전체 호스트 · 전체 VM · 활성 알람).
- 기존 상단 필터바(리전·vCenter·검색)는 목록 화면(호스트/VM/데이터스토어/포트그룹/알람) 안에서만 유지.

## 메뉴 IA (라우트 키 `k` 는 절대 변경 금지 — toolsDenied·딥링크·서버 매핑)
| # | 메뉴 | 그룹 → 항목 |
|---|---|---|
| 01 | Overview | — |
| 02 | Summary | — |
| 03 | 운영관제 | 알람·감시: alarms(화면), svcmon(화면), svcmon-config, alert-channels, part-faults · 점검·리포트: daily-health, davinci-svc, change-history · 분석·검색: insights-hub, insights, aisearch, deepsearch |
| 04 | 자산 | 인벤토리: explore, hardware, serial-lookup, vm-export, topo3d · 라이선스: licenses, license-expiry · 버전·솔루션: vcversion, solutions |
| 05 | 인프라 최적화 | 회수: waste, zombie-vms, thinvms, orphanvmdk, guest-disk · 적정화: rightsizing, capacity, capacity-advisor · 예측: capacity-forecast, forecast |
| 06 | 서버 | 물리 서버: fleet, serveranalysis, bm-usage, gpu, esxitemp, roomtemp, pdu, powermap, nic-speed, nic-models · 가상화 호스트: hosts(화면), esxi, hba · 가상화 서버: vms(화면), vmfinder, guestos, real-os, vmtools, curuser, vm-track |
| 07 | 네트워크 | 인벤토리: networks(화면), ipam(화면), nsx, cvp, dupip · 점검·분석: net-check, net-traffic, net-issues · 중계: relaytopo, relaycheck |
| 08 | 스토리지 | 인벤토리: datastores(화면), dsusage, storage-mon, san-switch, bm-storage · 추이·보고: storage-track, storage-growth, dir-usage |
| 09 | 보호/규정 | 백업·복제: unprotected-vms, vm-clone, vmware-backup, backup(준비 중) · 스냅샷: snapshots, snapshot-age · 준수: cert-expiry, compliance-report |
| 10 | 자동화 | 프로비저닝: vmprovision, diskadd(준비 중), massdeploy(준비 중) · 원격 작업: rma, agent-scans · 비상: shutdown(위험) |
| 11 | 보안 | 위협·접근: threats, login-fails · 점검: secret-scan, codex-check · 계정: credentials |
| 12 | 플랫폼 관리 | vCenter·포탈: vcenters(화면), settings(화면), upgrade(화면), portaldb, mail-diag · 엣지 통신: link-check, comm-map, data-flow, device-flow, portal-check, edge-log · 바로가기: service-hub(새 탭) |

구현 제안: `specialToolsList.js` 각 항목에 `menu`·`group` 필드 추가(코드 소유 기본 배치), `toolSections.js` 로 메뉴 페이지를 그린다. 딥링크 `#/tools/<k>` 는 그대로 동작해야 하며, 메뉴 해시 `#/m/<menuId>` 신설.

## 화면

### Overview (`#/overview`) — 지금 상태
1. 콘솔 스트립: 좌측 보더 2px `#34e0b4`, "▸ GLOBAL OPERATIONS · 지금 상태"(Mono 12px, .26em) + 갱신 시각·펄스 점(`ovPulse` 2.4s).
2. 상태 타일 4개(auto-fit minmax 190px, gap 12): vCenter(→플랫폼 관리) · 가상화 호스트(→서버/호스트) · 가상화 서버 VM(→서버/VM) · 활성 알람(→운영관제). 카드 `#141b2d`/보더 `#243049`/radius 12, 상단 2px 액센트, 값 Mono 32px/700, 하위 분해(정상/점검/끊김 등) 색 점. 호버 보더 `#3b82f6`.
3. 사용률 게이지 3개(CPU·메모리·스토리지): 10px 바, 75%(`#f59e0b`)·90%(`#ef4444`) 임계 눈금, 색 = ≥90 red / ≥75 amber / 그 외 green (`consoleData.js WARN_PCT/CRIT_PCT`).
4. 법인별 상태 그리드(auto-fill minmax 220px, 1px 구분선): 상태 점(CPU/MEM/DS 중 최악), 법인 ID(Mono), 리전, 알람 수, 호스트/VM, 3개 미니 바. 클릭 → 해당 법인 호스트 목록(`selectSite`).
5. 최근 알람(6건, 좌측 3px 심각도 바 + 배지) | 조치 필요(인증서 D-30 · 30일 내 고갈 DS · 파트 장애 · 미보호 VM · 30일+ 스냅샷 → 각 메뉴로 이동).
- 제거: 서버 합계/물리 전용 표(→ 서버 메뉴), 법인별 VM 막대·리전 파이(중복).

### Summary (`#/summary`) — 자원 총량과 할당
1. 제목 "자원 총량과 할당" + 법인 필터(기존 corp select).
2. 용량 vs 할당 카드 3개: CPU(vCPU:코어 비율, 4:1 초과 amber) · 메모리(할당/물리 %, 1.5:1 초과 amber) · 스토리지(용량/사용/프로비저닝). 물리 바 `#3b82f6`, 할당 바 `#a855f7`. 비율 카드 클릭 시 기존 RatioModal.
3. 총량 타일 6개: 물리 코어 · 물리 메모리 · 스토리지 용량 · 클러스터 · 호스트당 VM · 총 소비전력.
4. OS별 할당: 상단 비중 스택 바(12px) + 표(Guest OS/VM/비중/vCPU/메모리/디스크). 계열 클릭 → `GuestOsVmsModal`.
5. 법인(vCenter)별 기여도 표 + 합계 행(`#1a2236`, 700).
- 제거: vCenter/호스트/VM/알람 개수 KPI, 물리 사용률 바(Overview 소유).

### 메뉴 페이지 (`#/m/<id>`)
- 헤더: 코드(Mono 10.5px `#5d6b85`) · 메뉴명 24px/700 · 설명 · 우측 "화면 N · 기능 N".
- 그룹마다: 3px 컬러 마커 + 그룹명 13.5px/700 + 개수 + 구분선, 카드 그리드(auto-fill minmax 250px, gap 10).
- 카드: `#141b2d`, 보더 `#243049`, radius 10, 13/15/12 패딩. 아이콘(`specialToolsList` 이모지) + 라벨 13px/700 + 배지(화면 `#60a5fa` / 관리자 / 준비 중 / 위험 `#ef4444` / 새 탭 `#22d3ee`) + 설명 2줄 clamp + 경로(`#/tools/<k>`) · "열기 →". 호버: 보더 `#3b82f6`, bg `#1a2236`. 위험 카드 bg `rgba(239,68,68,.05)`, 보더 `rgba(239,68,68,.35)`.
- 잠금: viewer = 비화면 기능 전부 🔒, operator = adminOnly 🔒, 준비 중 → opacity .45. (기존 `toolAllowed`/`AccessDenied` 재사용)

### 서버 메뉴 추가 요소
- 구분 카드 3개: 물리 서버(PHYSICAL, `#22d3ee`, iDRAC) · 가상화 호스트(HYPERVISOR, `#3b82f6`, vCenter·ESXi) · 가상화 서버(VIRTUAL, `#22c55e`, VM). 값 Mono 34px. 클릭 시 해당 구분만 필터(재클릭 해제), 선택 시 보더=구분색, bg `#1a2236`.
- 산식 안내(점선 보더): 서버 합계 = 물리 전용 + 가상화 호스트, iDRAC↔ESXi 동일 장비 중복 제외, VM은 합계 미포함 (`idrac/serverByCorp.js` 규칙, `overviewServerText.js` 문구 재사용).
- 세그먼트: 전체 / 물리 서버 / 가상화 호스트 / 가상화 서버 (활성 `#3b82f6`).
- '전체'일 때 법인별 서버 구분 표: 법인 · 물리 전용 · 가상화 호스트 · 서버 합계 · 가상화 서버 · 구동중 · 호스트당 VM (+합계 행, 미귀속 행은 기존 `unplacedRows`).

## State
- `page`: 'overview' | 'summary' | menuId (해시 동기화, 랜딩은 `vmportal.landingTab` 유지)
- `seg`: 'all' | 'phys' | 'host' | 'vm' (서버 메뉴)
- 데이터: `/overview`(15s) · `/alarms` · `/summary`(15s) · `/health`(20s) · `/vcenters` — 기존 폴링 그대로. 값 없음은 0이 아니라 '—'.

## Design Tokens (styles.css)
bg `#0a0e17` · bg-soft `#111726` · panel `#141b2d` · panel-2 `#1a2236` · panel-deep `#0f1626` · border `#243049` · border-soft `#1f2a40` · text `#e6edf6` · text-dim `#8b9bb4` · text-faint `#5d6b85` · accent `#3b82f6` · accent-2 `#22d3ee` · green `#22c55e` · amber `#f59e0b` · red `#ef4444` · purple `#a855f7` · mint `#34e0b4`
폰트: Pretendard(본문 13px/1.4) · JetBrains Mono(숫자·코드, tabular-nums). Radius: 카드 12 / 기능 카드 10 / 버튼 7–8 / 배지 4. 그림자 없음.

## Files
- `Portal Home.dc.html` — 전체 디자인(셸 + Overview + Summary + 10개 메뉴 페이지). 로직 클래스의 `T`(기능 정의)·`MENUS`(IA)가 배치 원본.
- `support.js` — 미리보기 런타임(구현 대상 아님).
