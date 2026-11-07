# 설계: 서버 › 가상화 플랫폼 — vCenter · ESXi 호스트 · 가상화 서버 메뉴 3개 → 1개

작성 2026-11-07 (main 82d95f6 · v2.914.0 기준) · 상태 **시안 · 컨펌 대기**(규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현 — 2026-11-03 '기억해') ·
시안 캔버스: https://claude.ai/artifact/EgdqZtuep5B8GLEFZk8gSG (아트보드 9장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스 · HTML 프로토타입이지 복사 대상이 아님).
**법인 · vCenter · 호스트 · VM 이름과 수치는 전부 가상**이고(규모만 운영값 28 vCenter · 658 호스트 · 5,850 VM 에 맞춤) 색 · 글자 · 사이드바 · 상단 바 · 상태바는
`web/src/styles.css` `:root` 토큰과 목 서버 Chromium 캡처(2026-11-07 19:37~19:39 KST · `#/vcenters` · `#/hosts` · `#/vms` · 상세 · 400px)를 따랐다. 계정에 'Design System' 아티팩트가 없어 쓰지 않았다.
§2 는 코드 분석 에이전트 4명(기능 목록 3 + 제약 1)이 파일:줄로 확인한 것, §3 은 조사 에이전트 12명(제품별)의 결과를 메인(Fable)이 추린 것, §4~§6 은 시안 단계(Fable)에서 채웠다.

## 1. 요구(사용자 2026-11-07)

> "vCenter, esxi 호스트, 가상화 서버... 이 3개의 가상화 플랫폼 메뉴를 1개로 합치고 싶어, 유명한 관련 솔루션 찾아서 시안 만들어줘"
> → "클로드 코드로 멋있게 디자인 해줘" → (캔버스를 보며) "백업에 veeam/bareos 포함하고 Snapshot 은 제외"

## 2. 지금 코드에서 확인한 것(설계의 근거 — 파일:줄)

| 사실 | 위치 |
|---|---|
| 메뉴 '서버' 그룹의 세 항목: `{ id:'vm', label:'가상화 서버', tab:'vms', also:[vmfinder·guestos·vmtools·vm-track·curuser·real-os] }` · `{ id:'esxi', tab:'hosts' }` · `{ id:'vc', tab:'vcenters' }` | `web/src/views/topMenu.js:26-28` |
| 탭 id · 권한: `vcenters`(label 'Platform', perm `dashboard`) · `hosts`(`inv.hosts`) · `vms`(`inv.vms`). TABS 에서 탭을 빼면 isAllowed→null 로 랜딩 폴백되고 `#/hosts/<id>` · `#/vcenters/<vc>/vm/<id>` · 관제 콘솔 내비 · ⌘K 인계 · Overview 법인 클릭(selectSite) 이 깨진다 → **합치기는 메뉴 층(topMenu · sideMenu · 공용 탭 줄)에서만** | `web/src/App.jsx:54-83, 268-283` · `vcd/vcdRoute.js` · `invSearchQuery.js:97-99` |
| 테스트가 고정한 것: 'TABS ⊆ 메뉴 탭 ∧ 메뉴 탭 ⊆ TABS'(`c.tab` 만 센다) · 서버 하위 라벨 6개 · `locate('hosts')→esxi` · children 순서 · `missingDefaults` 에 `tab:hosts` · `vm.also == HUB_TOOL_KEYS` · `INV_FILTER_TABS` 에 'hosts' | `topMenu.test.js:25-33, 48, 92-94` · `sidebar/sideMenu.test.js:21, 87-95` · `menuEdit.test.js:46-53` · `singleMenu2891.test.js:31-40` · `vms/vmHub2909.test.jsx:31-40` · `invSearchQuery.test.js:66-70` |
| `locate()` 는 탭 **정확 일치**만, `also` 는 도구 전용. `visibleMenu()` 는 `tabOk(it.tab)` 하나 → 합친 항목에 탭 별칭(`tabs`)을 두면 locate · visibleMenu · hashOf/entryOf 가 함께 읽어야 하고, `inv.vms` 없는 계정이 호스트 · vCenter 까지 잃지 않게 '하나라도 허용이면 보이고 첫 허용 탭으로 진입' 규칙이 필요 | `topMenu.js:104-125` |
| 저장 메뉴(내 메뉴 · 배포)는 **주소만** 담고 서버는 탭 실재를 모른다 → MENU_GROUPS 에서 `hosts` · `vcenters` 항목을 지우면 기존 저장 메뉴의 그 항목이 `unknown`('미표시 N')으로 조용히 사라진다. 그룹 id 별칭 선례(`LEGACY_GROUP_LABELS`)는 있고 **항목 별칭 선례는 없다** | `server/src/.../user-menu store.js:9-26` · `sidebar/sideMenu.js` |
| 선례: Backup 메뉴 `also:`(도구 여러 개를 메뉴 하나로) · v2.909 가상화 서버 허브 탭 줄(`VmHubTabs` — 권한 없는 도구 숨김 · Vms 와 SpecialTools 두 곳에서 같은 줄) · v2.891 단독 메뉴 · `movedTabHash`(옛 주소 이전) · `topTab`(ipam — 권한 · 주소는 남기고 노출만 옮김) | `topMenu.js:30-32` · `views/vms/VmHubTabs.jsx` · `hooks/hashTab.js` |
| 공용 필터 바(리전 · vCenter · 탭별 Select · 검색 · 메모/IPMS)는 `hosts` · `vms` 에만 보이고 `vcenters` 는 `noFilterTabs`. 필터는 **탭마다 따로**(`tabFilters[tabId]`) | `App.jsx:107-114, 298-299, 542` |
| vCenter 카드 → 호스트 탭 경로 `selectSite` 는 App 이 `onSelectSite` 로 넘기지만 **VCenters.jsx 가 호출하지 않는다(죽은 prop)**. vCenter 화면 → `#/vms` 링크 0건 · 호스트 화면 → `#/vms` 링크 0건 · VM 화면 → `#/hosts` 링크 0건(호스트 이름은 글자만) | `VCenters.jsx` · `Hosts.jsx` · `Vms.jsx`(grep) |
| vCenter 상세 12탭 선택값은 URL 이 아니라 localStorage `vcd.tab`(DEFAULT_TAB 'hosts' · 옛 'trend'→monitor/perf). 개체 보기 탭 수는 **VM 9(8 + 성능 튜닝) · 호스트 10(9 + 성능 튜닝)** | `vcd/vcdTabs.js` · `vcd/objTabs.js` |
| 백업 배지 `152/—` 는 `veeam/snapshot` 쌍(`backupPairCell`) · vCenter 별 Bareos 보호 VM 수는 `/vcenters` 응답에 없다(추정 — 구현 때 확인) | `views/veeamBadge.js` · `VCenters.jsx` |
| 셸 수치: 사이드바 236px(접힘 64 · 서랍 min(280px,85vw)) · 항목 13px/600 · 하위 12.5px + 5px 점 · 활성 cyan(inset 3px `--accent-2`) · 상단 바 44px(⌘K 420×32) · 허브 탭 줄 40px / 3px `--accent` 밑줄 · 상태바 4칸 | `web/src/styles.css` · `sidebar/Sidebar.jsx` |

규모 · 운영 제약(루트 CLAUDE.md): 28 vCenter(30+ 예정) · 일부 RTT 800ms+ · 전량 렌더 금지 · 무거운 API 15초 폴링 금지 · 주기 · 상한 숫자를 화면에 박지 않는다 · 1440/400 둘 다.

## 3. 참고한 솔루션 — 내비게이션 모델과 가져온 것

조사 방식: 제품마다 조사 에이전트 1명이 공식 문서 · 소스를 WebSearch/WebFetch 로 열어 JSON(내비 모델 · 메뉴 이름 · 계층 · 통합 방식 · 장단점 · 출처 · 미확인)을 남겼다(스크래치 `research/<key>.json` · 출처 URL 은 실제로 연 것만).
확신도는 에이전트 자기 평가(대부분 medium · Proxmox high) · **ControlUp/Runecast 는 문서를 열지 못해 출처 0건(기억 바탕 · low) — 설계 근거로 쓰지 않았다**.

| 제품 | 내비 모델(요약) | 최상위 메뉴 이름(원문) | 우리 시안에 가져온 것 | 두고 온 것(우리 규모 · 지연에 맞지 않음) | 근거 |
|---|---|---|---|---|---|
| **VMware vSphere Client 8** | 좌측 인벤토리 트리(Hosts and Clusters · VMs and Templates · Storage · Networking 4렌즈) + 중앙 개체 탭(Summary/Monitor/Configure/Permissions/관련 객체/Updates) + 유형별 평면 리스트 **Global Inventory Lists** + 전역 Search | Hosts and Clusters · VMs and Templates · Storage · Networking · Global Inventory Lists | 개체마다 같은 탭 틀(이미 v2.895) · '트리가 버거우면 유형별 평면 목록' 공식 우회로 → **시안 A 의 엔티티 탭 3** · 시안 B 의 트리+인스펙터 | 전 VM 트리(KB 403293 — 많은 VM 은 트리에서 끄라고 권고) · ELM 15 vCenter 상한(28개 못 묶음) · 지연 30ms 전제 | docs.vmware.com vsphere-vcenter-esxi-management GUID-C99AD4A7 · GUID-6ADB06EF |
| **VMware Aria Operations** | 왼쪽 메뉴는 '할 일' 단위(Home · Operations · Capacity · Environment …) · vCenter/호스트/VM 은 **Environment › Inventory 한 화면의 트리 ↔ 목록 전환** · 어느 노드든 같은 탭 인스펙터 | Environment › Inventory(구 Object Browser) | 메뉴 수는 개체 종류에 비례시키지 않는다 · 루트 집계 개체(vSphere World) = '전체 법인' 행 | 5단 트리 · 버전마다 바뀌는 메뉴 이름 · 다중 vCenter 집계 정합성 함정(KB 391478) | techdocs.broadcom.com aria-operations 8.18 inventory-tab |
| **Veeam ONE** | Virtual Infrastructure 트리(vCenter→DC→Cluster→Host→VM) + 선택 개체 탭(Summary/Alarms/Performance/…) · 알람 **롤업** · Top Objects · 'Show all error objects' | Virtual Infrastructure · Business View | 트리 노드에 자식 알람 합 배지(시안 B) · '문제만' 거르기 | 데스크톱 전용 트리 · 전 vCenter 평면 호스트 표 없음 · 500+ 호스트 트리 지연 보고 | helpcenter.veeam.com one/userguide inventory_pane · information_pane |
| **SolarWinds VMAN** | 'Virtualization' **메뉴 하나** + Virtualization Assets 트리 + 개체 details 페이지(같은 트리를 details 에도) + 목적별 대시보드(Sprawl · Recommendations · Capacity) | My Dashboards › Virtualization | 최상위 메뉴 하나에 요약 · 문제별 보기 · 상세를 넣는 구성 | 법인/지역 축 없음 · 리뷰의 '어수선한 콘솔' · 트리 지연 로딩 언급 없음(미확인) | documentation.solarwinds.com vman_gsg_navigate_ui |
| **Nutanix Prism Central** | 'Infrastructure' 앱 안에서 **Clusters · Hosts · VMs 가 형제 항목** · 각 항목 = Summary 탭 + List 탭(모든 클러스터를 합친 평면 표 · Focus 열 세트 · Filters · View by) · 검색이 주 이동 수단('Prism Reimagined') | Infrastructure › Compute & Storage(VMs …) · Hardware(Clusters · Hosts) | **엔티티 종류별 형제 탭 + 전 클러스터 평면 표 = 시안 A 의 뼈대** | 계층이 화면에 안 보임(→ 브레드크럼 3단을 더함) · PC 1개 범위 · 릴리스마다 바뀌는 라벨 | portal.nutanix.com Prism-Central-Guide vpc_2024_2 main-menu |
| **Proxmox VE · PDM** | 평탄 자원 목록 하나(`/cluster/resources`)를 Server/Folder/Pool/Tag 뷰로 재그룹한 트리 + 인스펙터(Summary 가 항상 첫 탭) · 트리 상태를 브라우저에 기억 · 다중 클러스터는 PDM 이 'Remote' 층 | Server View · Folder View · Pool View · Tag View | 같은 데이터를 보기만 바꿔 그리기(허브 범위 하나) · 마지막 본 탭 기억 | 클러스터 1개 범위 · 모든 개체를 담는 트리 | pve-docs pve-gui.adoc · pve-manager ResourceTree.js |
| **Datadog vSphere · Infrastructure List** | 전용 트리 없음 — VM 과 ESXi 를 같은 개체(host)로 **한 표**에, 소속은 태그(vcenter_server · vsphere_cluster · vsphere_host) · 리스트 ↔ Host Map ↔ 대시보드 · 저장 뷰 | Infrastructure › Hosts · Host Map | 범위 · 검색을 '한 번 고르면 어디서나 같은 키' · 저장 보기 → **시안 C** | vCenter · 클러스터가 개체가 아니라 태그(드릴다운 노드 없음) · VM 이중 표시 | docs.datadoghq.com integrations/vsphere · integrations-core vsphere README |
| **Grafana vSphere 대시보드**(Telegraf vsphere / vmware_exporter) | 트리 없음 — 상단 **캐스케이딩 변수**(vcenter → cluster → esxi → VM)를 네 대시보드가 공유(includeVars) · Overview 한 장에 DC → 클러스터 → 호스트 → VM 행 적층 | VMware vSphere - Overview · Hosts · Datastore · VMs | **상위 범위를 고르면 하위 후보가 좁혀지는 공용 범위 바** · 개요→호스트→VM 순서의 적층 | 드롭다운뿐인 탐색 · 'All' 에서 폭발하는 반복 패널 | telegraf plugins/inputs/vsphere README · jorgedlcruz/vmware-grafana |
| **Zabbix VMware 템플릿** | 모든 개체(vCenter · ESXi · VM)를 '호스트' 로 평탄화 + 호스트 그룹 이름(`{#CLUSTER.NAME} (vm)` …)으로 계층을 여러 축에 투영 · Monitoring › Hosts 한 표 · 템플릿 대시보드 = 인스펙터 | Monitoring › Hosts · Latest data · Problems | 시안 C 의 근거(평탄화 + 그룹 투영) | 부모 참조 없음(소속이 문자열) · 호스트 6,500개 규모 부담 | zabbix release/7.0 templates/app/vmware README |
| **Microsoft SCVMM · Windows Admin Center** | SCVMM: 호스트 그룹 트리(Hyper-V 와 vCenter 경유 ESXi 가 한 트리) + 워크스페이스(VMs and Services · Fabric) 전환 + 결과창/세부창 · WAC: 연결 1개의 도구 열(Dashboard · Servers · Virtual Machines) | VMs and Services · Fabric · WAC: Servers · Virtual Machines | 호스트 그룹(법인 → 사이트) 중첩 발상 · 작업은 한 곳(Jobs) | Windows 데스크톱 콘솔 · 워크스페이스를 오가야 함 · WAC 는 연결 1개 범위 | MicrosoftDocs windowsserverdocs manage-virtual-machines.md 등 |
| **oVirt / RHV Administration Portal**(4.2+) | 좌측 1차 메뉴 6개(Dashboard · Compute · Network · Storage · Administration · Events) · **Compute 아래 Hosts · Virtual Machines 가 형제 평면 리스트** · 이름 클릭 → 같은 영역이 상세로(브레드크럼 `Compute › Hosts › <이름>` + 하위 탭) · 상위 개체 상세의 관계 탭(Cluster › Hosts · VMs, Host › VMs)이 곧 하위 목록 · 검색 문법 교차 참조(`Vms: Hosts.name = …`) | Compute › Hosts · Virtual Machines | **시안 A 와 같은 꼴**(형제 탭 + 브레드크럼 + 상위 상세의 관계 탭) · 대시보드 카드 클릭 → 리스트에 조건 주입 = 교차 링크 | 엔진(관리 서버) 1개 범위(vCenter 축 없음) · 4.2 에서 트리를 없애 계층 맥락이 브레드크럼뿐(트리 복귀 요구) | ovirt-engine webadmin MenuView.ui.xml · PrimaryMenuContainerType.java |
| ControlUp Real-Time Console / Runecast | (출처 0건 · 기억 바탕 — 설계 근거로 쓰지 않음) 조직 트리로 범위를 고르고 가운데 탭 그리드가 그 범위로 재계산 | — | — | — | 미확인 |

공통으로 보인 것: ① **메뉴는 하나, 개체 종류는 그 안의 전환**(트리든 탭이든) ② 어느 개체를 골라도 **같은 틀의 탭/요약** ③ 수천 VM 은 트리가 아니라 **평면 목록 + 필터**로(vSphere · Aria · Prism 모두 공식 우회로) ④ 범위(vCenter · 클러스터)는 한 번 고르면 **하위 화면이 그 범위를 이어받음**.

## 4. 시안(아트보드 8장) — 시안 캔버스 https://claude.ai/artifact/EgdqZtuep5B8GLEFZk8gSG

| 보드 | 파일 | 내용 |
|---|---|---|
| ① | `IA.dc.html` | **메뉴 3 → 1** — 지금 · 제안 사이드바, 메뉴 이름 후보, 주소 · 탭 id · 권한 '그대로' 표, 시안 A 가 더하는 것 · 지키는 것, 참고 솔루션 8장 카드 |
| ② | `Main.dc.html` | **시안 A 허브 · vCenter 탭(진입)** — 공용 범위 바(리전 · vCenter · 검색 — 세 탭 공통) · 제목 '가상화 플랫폼' · **엔티티 탭 3**(vCenter 28 · 호스트 658 · VM 5,850 — 수 + '지금 볼 것' 배지 + 상태 분해) · 추이 KPI 3(백업 **Veeam / Bareos** · VM 증가 · 스토리지 증가) · 바로가기 칩 · vCenter 카드(호스트 · VM 수가 **그 범위로 탭을 바꾸는 링크**) |
| ③ | `Hosts.dc.html` | 시안 A **호스트 탭** — 엔티티 탭 아래 **바로가기 칩 줄**(②와 같음 · 사용자 요청 2026-11-07 — 칩 = 허브 범위를 그 vCenter 로 · 찾기 = vCenter · 호스트 이름) · 지금 ESXi 호스트 화면(v2.805 · v2.811) 그대로: 호스트별/법인별 세그먼트 · 요약 7칸(호스트 수는 탭이 대신) · 지금 확인할 것 · 클러스터별 CPU · 분포 · 열 묶음 9 표. 표의 VM 수 → VM 탭을 그 호스트 범위로(새 링크) |
| ④ | `Vms.dc.html` | 시안 A **VM 탭** — 엔티티 탭 아래 **바로가기 칩 줄**(②와 같음 · 찾기 = vCenter · VM 이름) · 지금 가상화 서버 허브(v2.909) 그대로: 현황 · 법인별 · 조치 필요 ‖ 도구 6 · 타일 5 · 분포 4 · 표(신호 배지). 호스트 이름 → 호스트 탭(새 링크) |
| ⑤ | `Drill.dc.html` | 시안 A **드릴다운** — vCenter 상세(12탭 · 트리)에 '← 목록' 대신 **브레드크럼 + 이전/다음 vCenter** · 브레드크럼 3단 규약(vCenter › 클러스터 › 호스트 › VM)과 실제 해시 대응 |
| ⑥ | `Narrow.dc.html` | 시안 A **400px** — 필터 두 줄 · 엔티티 탭은 가로 스크롤(스냅 · 오른쪽 흐림) · KPI 2열 · 카드 한 열 |
| ⑦ | `AltTree.dc.html` | **시안 B 인벤토리 트리 + 인스펙터**(vSphere Client · Veeam ONE 식) — 300px 트리(계층 · 유형별 목록 · 문제만 전환 · 알람 롤업 · 지연 로드) + 오른쪽 선택 개체(호스트 10탭 요약) |
| ⑧ | `AltList.dc.html` | **시안 C 통합 인벤토리 표**(Datadog · Zabbix 식) — 와이어프레임만: 유형 토글 · 그룹화 · 열 · 저장 보기 · 선택 패널. 얻는 것/잃는 것을 보드에 적었다 |
| ⑨ | `VcTable.dc.html` | 시안 A **vCenter 탭 ‘표’ 보기(법인별 통합)** — 한 줄에 한 법인(상태 · 호스트 · 확인 대상 · VM · 조치 필요 · CPU · 메모리 · 스토리지 · 알람 · Veeam / Bareos · 수집 경로 · 버전) + 합계 행 · 행 = 허브 범위를 그 법인으로 · 2차에 호스트 · VM 탭의 ‘법인별’ 열을 흡수 |

### 4.0 2026-11-07 21:00~21:20 추천 13건 반영(사용자 '모두 반영해줘')

| # | 반영 | 어디 |
|---|---|---|
| 1 | ④ 위쪽 줄 수 줄임 — ‘조건(전원 · 메모 · IPMS)’ 을 탭 줄 오른쪽 끝으로 · 바로가기 줄에 ‘접기’(상태 기억) | ③④ |
| 2 | 엔티티 탭 분해는 그 탭에만 있는 것 — vCenter: 연결 · 불가 · REST 폴백 · 엣지 위임 · 알람 / VM: 구동 · 정지 · 미수집 · 템플릿(평균 CPU · GPU 는 타일에만) · VM 탭 ‘전체 VM’ 타일 → ‘조치 필요’ 신호 분해 타일 | ②③④⑥⑨ |
| 3 | 상세 한 규칙 — 이름 클릭 = 개체 보기(브레드크럼) · 전체 페이지 상세(호스트) · 드로어(VM)는 그 안의 보조 버튼 | ③④⑤ 각주 · IA 표 |
| 4 | 배지 수는 가벼운 요약 하나(`memoJson` + `scopeKey`) · 없으면 ‘—’(0 금지) | IA 표 · §6 |
| 5 | VM 증가 · 스토리지 증가 KPI 는 `vm-track` 권한 게이트 — 없으면 두 칸 숨김 | ② 각주 · §6 |
| 6 | 바로가기 칩에 그 탭의 숫자(알람 · 확인 대상 · 조치 필요) · 고른 법인 파랗게(`.chip.on`) | ②③④⑥ |
| 7 | 400px 엔티티 탭 = 3칸 한 줄(수 + 이름 + 배지) · 분해는 아래 한 줄 | ⑥ |
| 8 | 백업 Veeam / Bareos 를 전 탭에 — 호스트 표 열 · VM ‘백업 없음’ 신호 · 트리 VM 표 | ③④⑦⑨ |
| 9 | 알람 수에 ‘(미조회 2곳 제외)’ 단서 + 툴팁 | ②③④⑥⑨ |
| 10 | 마지막 본 탭(·보기) 기억 — localStorage · 처음은 vCenter | ②③④⑨ 머리 각주 · §6 |
| 11 | 세 탭 모두 ‘‖ 도구’ 줄 — vCenter 6 · 호스트 4 · VM 6(도구 키 그대로 · `also` 추가) · 호스트 탭의 점검 집계 · 엑셀 버튼은 표 머리로 | ②③④⑨ |
| 12 | vCenter 탭 ‘표’ 보기 = 법인별 통합(2차에 HostsCorp · VmsByCorp 흡수) | ⑨ 신규 · ③ 법인별 탭에 ‘2차’ 표시 |
| 13 | vCenter 탭 ‘트리’ 보기 = 시안 B 의 지연 로드 트리(카드 \| 표 \| 트리 전환) · 머리 줄의 ‘인벤토리 트리’ 버튼 제거 | ②⑨ 보기 줄 · ⑦ 제목 |

### 4.1 시안 A '플랫폼 허브(엔티티 탭)' 가 바꾸는 것 — 권장

1. **메뉴**: '서버' 그룹 6항목 → 4항목. 항목 하나 `{ id:'virt', label:'가상화 플랫폼', tab:'vcenters', tabs:['hosts','vms'], also:[VM 도구 6] }`(추정 — §6). 옛 주소 · 탭 id · 도구 키 · 권한 id 는 그대로.
2. **엔티티 탭 3** = 지금의 세 화면. 제목 h1 만 허브로 올라가고 각 화면의 본문(하위 보기 · KPI · 표 · 드로어 · 내보내기)은 그대로. 탭 수는 헤더 `/health` 와 같은 집계, 배지는 호스트 '확인 대상'(`/hosts/checks`) · VM '조치 필요'(`/vms` signals) — 새 API 없음(추정).
3. **범위 하나**: 리전 · vCenter · 검색을 세 탭이 공유(지금은 탭마다 따로 · vCenter 탭엔 필터 바가 없음). **공용 필터 바는 세 탭이 똑같다**(사용자 요청 2026-11-07 — 범위 · 리전 · vCenter · 검색 · 안내문 · 스냅샷 시각). 상태(호스트) · 전원(VM) · 메모/IPMS 는 탭 고유 조건이라 **그 탭의 보기 줄로 내렸다**(③ 세그먼트 옆 · ④ 탭 줄 아래 '조건' 줄). Grafana 캐스케이딩 변수 · Datadog 태그 키와 같은 발상.
4. **교차 링크**: vCenter 카드의 호스트 · VM 수 → 그 범위로 탭 이동(죽은 prop `selectSite` 를 살리는 것) · 호스트 행 VM 수 → VM 탭(`/vms?host`) · VM 행 호스트 → 호스트 탭. 지금은 세 화면 사이 직접 링크가 0건이다.
5. **브레드크럼 3단**: 드릴다운(vCenter 상세 · 개체 보기)에서 '← 목록' 대신 `가상화 플랫폼 › vCenter › 클러스터 › 호스트 › VM` + 이전/다음 vCenter. 주소는 지금 그대로.
6. **백업 표기**: `veeam/snapshot` → **`Veeam / Bareos`**(스냅샷 제외 — 사용자 지시). vCenter 별 Bareos 보호 VM 수가 응답에 없으면 집계를 더한다(§5-6).
7. 400px: 엔티티 탭 가로 스크롤 · 나머지는 각 화면의 기존 400px 판.

### 4.2 시안 B · C

- **B 인벤토리 트리 + 인스펙터**: 메뉴 하나 · 트리 하나 · 인스펙터 하나(가장 '유명한' 모양). 트리는 vCenter 노드만 먼저, 클러스터 · 호스트는 펼칠 때(`/hosts` 집계), VM 은 호스트를 펼칠 때(`/vms?host`) — 5,850 VM 을 한 번에 그리지 않는다. 전 법인 평면 목록(확인 대상 칩 · 분포 패널)은 '유형별 목록' 전환으로. 400px 은 서랍. **위험**: 승인된 v2.805 · v2.909 화면을 트리 아래로 밀어 넣어야 하고, 트리 규모 문제를 vSphere · Veeam 자신도 피한다(§3).
- **C 통합 표**: 메뉴도 화면도 하나지만 유형 전용 요약(지금 확인할 것 · 클러스터 타일 · 분포 패널 · vCenter 카드)이 들어갈 자리가 없다 → 와이어프레임만.
- 권장은 **A**. B 의 트리는 A 의 vCenter 탭 안 '인벤토리 트리' 보기(상단 버튼)로 2차에 더할 수 있다(시안 ②③④ 머리 줄의 버튼이 그 자리).

## 5. 열린 질문(컨펌 때 정해 주실 것)

1. **A · B · C** 중 어느 쪽인지(권장 A · 'A + 2차에 B 트리' 가능).
2. **메뉴 이름**: 가상화 플랫폼(기본 · 사용자 표현) · 가상 인프라(Veeam 'Virtual Infrastructure' · VMAN 'Virtualization') · 인벤토리(vSphere · Aria).
3. **진입 탭**: 마지막 본 탭을 기억하고(§4.0-10) 처음은 vCenter — 처음을 VM 으로 할지만 남음.
4. **범위 공유**: 세 탭 공용 바로 맞춤(사용자 요청 2026-11-07 21:00) — 남은 질문은 없음.
5. **엔티티 탭 모양**: 수 + 배지가 있는 큰 탭(시안)인지, 가상화 서버 허브와 같은 얇은 탭 줄인지.
5-1. **‘법인별’ 두 벌 흡수(2차)**: 호스트 · VM 탭의 ‘법인별’ 을 vCenter 탭 ‘표’ 로 합치는 데 동의하는지(1차는 그대로 두고 표시만).
6. **백업 Veeam / Bareos**: vCenter 별 Bareos 보호 VM 수 집계가 `/vcenters` 에 없으면(추정) 어느 쪽에서 셀지(법인 Bareos 요약 → 중앙).
7. **저장 메뉴 호환**: 내 메뉴 · 배포 메뉴에 남은 옛 항목 3개를 새 항목으로 이어 붙일지(별칭 · 시안 기본) 아니면 옛 항목을 그대로 두고 허브로만 열리게 할지.
8. **검증 수준**(구현 때): ① 전체(변이 검증 + 반증 + Chromium 1440/400 전 탭) ② 표준(관련 테스트 + Chromium 1회) ③ 빠르게.

## 6. 구현 메모(추정 — 컨펌 뒤 Opus)

- `topMenu.js`: 항목 하나에 `tabs:[...]`(탭 별칭) 추가 → `locate()` · `visibleMenu()`(하나라도 허용) · `hashOf/entryOf`(첫 허용 탭) · `groupOfTool` 이 함께 읽는다. 테스트 기대값 갱신: `topMenu.test.js`(집합 대조는 `tabs` 까지 세게) · `sideMenu.test.js`(children 순서 · missingDefaults) · `menuEdit.test.js` · `singleMenu2891.test.js` · `vmHub2909.test.jsx` · `invSearchQuery.test.js`(INV_FILTER_TABS 는 그대로).
- `sideMenu.js`: 항목 별칭표(`tab:hosts` · `tab:vcenters` → 'virt' 항목) — `LEGACY_GROUP_LABELS` 와 분리 · `unknown` 으로 떨어지지 않게.
- 공용 탭 줄 컴포넌트(가칭 `views/platform/PlatformTabs.jsx`): App 이 `vcenters` · `hosts` · `vms` 탭을 그릴 때 위에 얹는다(세 화면의 h1 은 허브로). 수 · 배지는 기존 응답(`/health` · `/hosts/checks` · `/vms` signals)에서.
- App: `tabFilters` 를 세 탭이 공유하는 범위(리전 · vCenter · q)와 탭 고유(상태 · 전원 · 메모/IPMS)로 나눈다 · `noFilterTabs` 에서 `vcenters` 를 빼고 VCenters 가 범위를 받아 카드를 거른다(클라이언트) · `platformResetSeq` 조건(`item.tab==='vcenters'`)은 정리 가능.
- 교차 링크: VCenters 카드 → `onSelectSite`(hosts) 호출 + VM 용 `onSelectVms` · Hosts 표 VM 수 → `patchFilter({ host }, 'vms')` 는 필터 바에 '호스트' 칩이 필요(새 필터 키 — 서버 `/vms?host` 는 이미 있음).
- 브레드크럼: `VCenterDetail` · `ObjectShell` 머리의 '← 목록' 자리에 `vcdRoute` 파싱값으로. 이전/다음 vCenter 는 `/vcenters` 목록 순서.
- 상세 한 규칙(§4.0-3): 호스트 표 · 트리 · VM 표의 이름 링크를 개체 보기(`vcHash`)로 통일 — `HostDetail` 전체 페이지는 개체 보기의 '전체 페이지 상세 →' 버튼(이미 있음)으로, `VmDrawer` 는 행 끝 '빠른 확인' 버튼으로. 옛 동작(행 클릭 = 드로어)은 v2.909 승인 사항이라 **컨펌 항목**.
- 탭 배지 · 칩 숫자(§4.0-4 · 6): vCenter 별 알람 · 확인 대상 호스트 · 조치 필요 VM 수를 한 응답으로 — 기존 `/health`(알람) · `/hosts/corp`(법인별 확인 대상 — 서버 30초 캐시) · `/vms/by-vcenter`(법인별 신호) 를 묶는 가벼운 요약(`memoJson` + `scopeKey`) 하나. 15초 폴링 금지 · 첫 수집 전은 '—'.
- 도구 줄(§4.0-11): `topMenu.js` 항목의 `also` 에 vcversion · solutions · licenses · license-expiry · cert-expiry · change-history · host-hygiene · esxi · hba · cluster-check 를 더하고(VM 도구 6은 그대로), 탭 줄은 `VmHubTabs` 의 '권한 없는 도구 숨김' 규약을 그대로 쓴다. `vmHub2909.test.jsx` 의 `vm.also == HUB_TOOL_KEYS` 대조는 '포함' 으로 바꾼다.
- 마지막 본 탭 · 보기(§4.0-10): localStorage 키 하나(`platform.tab` · `platform.vcView`), `vcd.tab` 과 같은 try/catch 규약.
- vm-track 게이트(§4.0-5): 지금 `VCenters.jsx:129` 의 `toolAllowed('vm-track')` 그대로 — 두 칸을 숨기고 백업 칸만 남긴다.
- 표 보기(§4.0-12 · 보드 ⑨): 1차는 `/vcenters` 응답 + 위 요약만으로 그린다(새 집계 없음 — 추정). HostsCorp · VmsByCorp 흡수는 2차.
- 백업: `backupPairCell` 의 둘째 값을 snapshot → bareos 로 바꾸려면 vCenter 별 Bareos 보호 VM 수가 필요 — 법인 Bareos 요약(`bareos-summary`)에서 받는지 구현 때 확인. 없으면 1차는 Veeam 만 + 'Bareos —'.
- 릴리스: 포탈 동작이 바뀌므로 기능 릴리스(버전업 · 릴리스 게시 · `versions.json` 확인). 화면이 바뀌니 Chromium 1440/400 · 세 탭 · 드릴다운 · 400px.

## 7. 조사 방식 · 정직 기록

- 조사: 제품 12개 × 에이전트 1명(두 워크플로 × 6) + 코드 분석 4명(기능 목록 vms · hosts · vcenters + 제약 · 선례). 결과 JSON 은 세션 스크래치에만 있고 저장소에는 이 README 의 요약과 출처 호스트만 남긴다.
- 미확인: ControlUp/Runecast 출처 0건(기억 바탕 — 근거로 쓰지 않음) · Nutanix 메뉴 라벨은 릴리스별 차이 있음(조사 결과대로 적음) · '새 API 없음' · vCenter 별 Bareos 수 부재는 추정.
- 캔버스는 타입 규약대로 **브라우저 렌더 검증을 하지 않았다**(사용자가 요청하면 Chromium 으로 본다). 포탈 코드는 바꾸지 않았다 — 릴리스 없음.
- 정정: 진행 메시지 하나에 시각을 확인하지 않고 '[19:52]' 라고 적었다(실제 19:44경). 이후 메시지는 `TZ=Asia/Seoul date` 값으로 적었다.
