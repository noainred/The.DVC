# 설계: 서버 › 가상화 서버(`#/vms`) 화면

작성 2026-11-05 (main 4f96dbac 기준) · 상태 **시안 — 컨펌 대기**(규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현 — 2026-11-03 '기억해') ·
시안 캔버스: https://claude.ai/artifact/HygUww3MsmmbyYPooDx8dR (아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스).
이 문서의 §2 는 Opus 세션이 코드로 확인한 사실이고, §3~§5 는 시안 단계(Fable)에서 채웠다.

## 1. 요구(사용자 2026-11-05)

> "클로드 코드로 가상화 서버 화면 설계해줘,"

- 무엇을 바꾸고 싶은지(문제점·목표)는 아직 받지 못했다 → §3 의 방향을 먼저 정한다.

## 2. 지금 코드에서 확인한 것(설계의 근거)

| 사실 | 위치 |
|---|---|
| 메뉴 '서버 › 가상화 서버' 는 탭 `vms`(`#/vms`)를 가리킨다. 탭 id 는 해시 라우팅·권한(`inv.vms`)이 쓰므로 바꾸지 않는다 | `web/src/views/topMenu.js:24` · `web/src/App.jsx:62` |
| 화면 위 공용 필터 바(이름·IP·OS 검색 · 전원)는 App 이 그린다(vms·networks·hosts·datastores 공통) | `web/src/App.jsx:111`, `:547`, `:576` |
| 화면 구성(204줄): ① 갱신 실패 배너 ② '글로벌 가상머신 요약' KPI 8장(전체 VM · 할당 vCPU · 평균 CPU · 할당 메모리 · 평균 메모리 · 할당 디스크 · 평균 디스크 · GPU 할당 VM — GPU 카드는 클릭하면 GPU 필터) ③ `section.vmd` '가상머신 상세' — 분포 패널 + 선택 칩 + 페이지 요약 + 페이저 + 표 ④ IPMS 일치 ⑤ 행 클릭 → 상세 모달 | `web/src/views/Vms.jsx` |
| 분포 패널(v2.746 C안): CPU 사용률 분포(5% 칸 20개) · 메모리 사용률 분포 · 전원 + GPU · Guest OS. 막대 클릭 = 그 칸만, 머리의 '90%↑·75%↑' = 그 수준 이상. 각 패널 개수는 **다른 패널 선택만** 반영. 분포는 **전원 켜진 VM 만** 센다 | `web/src/views/VmDistPanels.jsx` · `vmDistText.js` · `vmDist.css` |
| 표 10열: VM(전원 점) · vCenter · Guest OS · IP(다중) · vCPU·RAM · GPU(있을 때만) · CPU 막대 · 메모리 막대 · 디스크 · 호스트. 좁은 화면(400px)은 표 대신 2줄 목록(`VmMobileList`, `max-height:64vh`) | `Vms.jsx:102` · `VmDistPanels.jsx:280` |
| 상세: 행 클릭 → `EntityDetail(type='vm')` 모달 → '⤢ 개체 보기' 로 vCenter 화면의 VM 개체 탭(`#/vcenters/<vc>/vm/<id>`, v2.895) | `web/src/components/EntityDetail.jsx:737` · `web/src/views/vcd/VmObject.jsx` |
| 데이터: `GET /api/vms` — `paged=1` 커서 페이지 · 서버 정렬 `cpuUsagePct desc` · `dist=1` 분포 · 선택 `cpuBin·memBin·power·osName`(틀리면 400 bad-facet) · `totals`(KPI) · 15초 폴링 | `server/src/routes/api/inventory.js:392` · `server/src/inventory/vmDist.js` |
| 결측 처리는 이미 규약대로: 사용률 미수집 VM 은 평균에서 빼고 '미수집 n대 제외' 를 밝힘 · 디스크 용량 미상 n대 | `Vms.jsx:119`, `:143` |
| 같은 성격의 VM 도구가 특수 기능에 따로 있다: VM 정밀 검색/유휴 VM(`vmfinder`) · Guest OS 종류/버전(`guestos`) · 실제 OS 확인(`real-os`) · VMware Tools 버전(`vmtools`) · 현재 사용자(`curuser`) · VM 수량 추이(`vm-track`). 홈 시안이 이들을 '서버 › 가상화 서버' 묶음으로 열거했다 | `web/src/views/specialToolsList.js` · `docs/design/portal-home/README.md:37` |
| 메뉴 하나 + 화면 위 탭으로 여러 도구를 오가는 선례: '서버 › Backup'(`also: [...]`) | `web/src/views/topMenu.js` veeam 항목 |
| 이 영역 규칙: 칸·선택 판정은 서버 `vmDist.js` 하나 · CSS 는 `.vmd` 아래 · uppercase 금지 · 색은 `var(--…)` | `docs/rules/vcenter.md:119~` |

규모(설계 제약): 운영 28 vCenter · 약 5,850 VM(루트 CLAUDE.md) · 목 데이터 2,242대(v2.746 노트). 전량 렌더 금지(페이지) · 무거운 API 15초 폴링 금지 ·
주기·상한 숫자를 화면에 박지 않는다 · 표는 정렬 가능(STable/DataTable) · 1440/400 둘 다.

## 3. 시안 두 가지(아트보드 6장) — 시안 캔버스 https://claude.ai/artifact/HygUww3MsmmbyYPooDx8dR

이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스(HTML 프로토타입 — 복사 대상이 아님). **법인 · vCenter 이름(VC-KR1 · esx-kr1-07 · web-kr1-023 …)·수치는 전부 가상**이고
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로(새 hex 없음 · 배지 색은 기존 `.badge` 와 같은 rgba 톤). 계정의 'Design System' 아티팩트는 지금도 `project/README.md`·`tokens.json` 이 없어 쓰지 않았다.

| 보드 | 파일 | 내용 |
|---|---|---|
| ① | `Current.dc.html` | **현재 화면 재현(before)** — KPI 8장(`auto-fit minmax(180px)`) · '가상머신 상세' 분포 4패널 · 표 10열. 페이지 요약 문구는 근사(`vmPageText.js` 원문을 옮기지 않음) |
| ② | `Main.dc.html` | **시안 1 '가상화 서버 허브' — 현황 탭**: 화면 위 탭 줄(현황 · 법인별 · 조치 필요 ‖ 기존 VM 도구 6개) · KPI 8장 → **타일 5장**(전체 VM · CPU · 메모리 · 디스크 · GPU — 같은 값을 합친 것, 빠진 값 없음) · 분포 4패널은 한 카드 안에 가로 4열 + 칩 줄 · 표에 **'신호' 열**(Tools 구버전 · 스냅샷 n일 · IP 없음) |
| ③ | `ByCorp.dc.html` | 시안 1 **법인별 탭**: 요약 4장 + 법인(= vCenter) 표(VM · 구동 · 정지 · 비중 · vCPU · 메모리 · 평균 CPU/메모리 · GPU · 90%↑ · 미수집 · 수집 경로) + 합계 행 · 행 클릭 → 현황 탭을 그 법인 범위로 |
| ④ | `Attention.dc.html` | 시안 1 **조치 필요 탭**: 신호 카드 5장(과부하 · 사용률 미수집 · Tools 구버전 · 스냅샷 30일↑ · 유휴 후보) → 고른 신호의 VM 목록(사유 배지 · 같은 호스트 과부하 수 · 상세/개체 보기) |
| ⑤ | `Narrow.dc.html` | 시안 1 현황 **400px**: 탭 가로 스크롤 · 타일 2열(디스크는 2칸) · 분포는 세로 쌓기(전원·GPU·OS 는 접힘) · 표 대신 2줄 목록(기존 `VmMobileList` 자리) |
| ⑥ | `AltA.dc.html` | **시안 2 '구조 유지 · 다듬기만'**: 탭 없음 · KPI 8장을 한 줄(`kpis-1row` 기존 클래스) · 패널을 카드 안 4열로 평탄화 · 관련 도구는 머리의 링크 줄 |

### 시안 1 이 바꾸는 것(정보 구조)

1. **탭 줄**(Backup 메뉴 선례 `topMenu.js` `also:`): 현황 · 법인별 · 조치 필요 는 이 화면 안의 보기, 그 오른쪽 6개는 **기존 도구(`#/tools/<k>`)를 그대로 여는 링크** — 도구 키·권한 파일·`toolcats` 배치는 바꾸지 않는다. `locate()` 가 그 도구를 열어도 '서버 › 가상화 서버' 가 켜지게 `also` 에 등재.
2. **타일 5장** = KPI 8장의 값을 묶은 것(전체 VM{구동·정지·미수집} · CPU{평균·할당 vCPU·90%↑·미수집 제외} · 메모리{평균·할당·75%↑} · 디스크{평균·할당·용량 미상} · GPU{vGPU·패스쓰루 + 필터}). '할당 vCPU / vCore' 카드의 vCore 는 지금도 vCPU 와 같은 값(`Vms.jsx:139`)이라 한 줄로 줄였다.
3. **법인별 탭** — 새 서버 집계가 필요하다: `/api/vms` `totals` 를 vCenter 별로 나눈 `byVcenter[]`(VM · 구동 · 정지 · vCPU · ramGB · 평균 CPU/메모리(구동 VM · 미수집 제외) · GPU · 90%↑ · usageUnknown · 스냅샷 시각/수집 경로). 한 번에 계산해 `memoJson` + `scopeKey`(범위 계정은 자기 법인만).
4. **조치 필요 탭** — 신호 판정은 **서버 한 곳**(`inventory/vmDist.js` 옆 `vmSignals.js` 같은 순수 모듈)에서 하고 화면은 다시 판정하지 않는다. 신호별 근거(구현 전 확인 항목):
   - 과부하: 구동 VM 의 `cpuUsagePct ≥ 90 || memUsagePct ≥ 90` — 지금 분포의 90%↑ 칸과 같은 판정(`vmDist.js`). 미수집(null)은 과부하가 아니라 '미수집'.
   - 사용률 미수집: `totals.usageUnknown` 과 같은 집합(이미 있음).
   - Tools 구버전: `toolsStatus === 'OUTDATED'`(+ 구동 중 `NOT_RUNNING`). **`/api/vms` 항목에 `toolsStatus` 가 실리는지 구현 때 확인**(목 생성기 `mock/generator.js:705` 에는 있음 · `vmtools` 도구는 별도 경로).
   - 스냅샷 30일↑: `snapshotOldestTs`(목 `generator.js:718`). 같은 확인 필요. 기준 일수는 API 값으로 내려보내고 화면에 박지 않는다.
   - 유휴 후보: 1주 평균 CPU 는 `vmfinder` 가 계산한다 — 그 결과가 없으면 '—' 와 링크. 이 탭이 vCenter 성능 API 를 새로 부르지 않는다(RTT 800ms+).
5. 표 '신호' 열은 위 신호 중 행 단위 배지(Tools · 스냅샷 · IP 없음). 열이 늘어 1440 에서 가로 넘침 여부는 Chromium 으로 본다(`STable minWidth` 뒤 스크롤).
6. 유지: 서버 정렬 `cpuUsagePct desc` + 커서 페이지 · 분포 패널(`VmDistPanels`)과 칩 · 15초 폴링은 `/api/vms` 하나(법인별·조치 필요 탭은 **탭을 열 때 1회 + 버튼**, 15초 폴링 금지) · 좁은 화면 2줄 목록 · `IpmsMatches` · 상세 모달 → 개체 보기.

### 시안 2 가 바꾸는 것

KPI 한 줄(`kpis-1row`, 30px → 24px 값) · 패널 카드 평탄화 · 관련 도구 링크 줄. 서버 변경 없음. 1440 에서 한 줄 8장은 장당 약 165px — 라벨은 말줄임(`kpis-1row` 가 이미 그렇게 한다).

## 4. 열린 질문(컨펌 때 정해 주실 것)

1. 시안 1(허브: 탭 3 + 도구 6) 과 시안 2(구조 유지) 중 어느 쪽인지. 시안 1 이면 **법인별·조치 필요 탭을 같이** 넣을지, 현황 탭(타일 5장 + 신호 열)만 먼저인지.
2. 조치 필요 신호 중 Tools 구버전 · 스냅샷 30일↑ 은 `/api/vms` 항목 필드 확인이 먼저다 — 없으면 1차에서 빼고 과부하 · 미수집 둘만.
3. 타일 5장으로 줄이는 것에 동의하는지(KPI 8장 그대로 두고 탭만 넣는 조합도 가능).

## 5. 구현 메모(컨펌 뒤)

- 파일: `Vms.jsx`(탭 상태는 `useHashTab` — `#/vms/<tab>`) · 새 `views/vms/ByCorp.jsx` · `Attention.jsx` · 순수 문구 모듈 `vmHubText.js`(테스트) · 서버 `inventory/vmByVcenter.js` · `vmSignals.js` + `routes/api/inventory.js` 확장 · `topMenu.js` `vm` 항목 `also:`.
- 테스트: 서버 집계(미수집 제외 · 범위 계정 · 빈 vCenter) · 신호 판정(null 은 과부하 아님 · 꺼진 VM 제외) · 웹 문구 · 탭 라우팅 · `topMenu.test.js`(도구가 어느 메뉴에 속하는지).
- 검증: 관련 테스트 + Chromium 1440/400(탭 3개 × 2 폭) · 변이 검증은 범위(scope) 집계에만.
