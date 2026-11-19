# 설계: 서버 메뉴 이름 변경 — Virtual Machine(VM) · Hypervisor · Bare Metal Server · Physical Server

작성 2026-11-13 (main 699dea74 · v2.990.0 기준) · 상태 **구현됨 — v2.998.0(코드 · 테스트 표지는 v2.994 — main 이 v2.997 까지 먼저 나가 번호만 올렸다)** — 컨펌 2026-11-13 "추천대로 전부 진행해, 구현해줘"(§4 의 추천안 그대로 · 구현 기록 §5) ·
시안 캔버스: https://claude.ai/artifact/Bdo8qzn9NT3TJBevPJ3Rs6 (아트보드 3장 — 이 폴더의 `*.dc.html` + `shell.css` 가 같은 내용의 레퍼런스 · HTML 프로토타입이지 복사 대상이 아님).
호스트 · 법인 · 클러스터 이름과 표의 값은 **가상**이고(28 · 658 · 5,850 만 운영 규모), 색 · 글자 · 사이드바 수치는 `web/src/styles.css` `:root` 토큰과 `.sb` 규칙(258~294줄)을 옮겼다.
계정의 'Design System' 아티팩트는 비어 있어(파일 0) 쓰지 않았다. 캔버스는 렌더 확인을 하지 않았다(Design 유형 규칙 — 사용자가 열어 본다).

## 1. 요구(사용자 2026-11-13 08:49 KST · 사이드바 '서버' 그룹 스크린샷 첨부)

> 1. 가상화 플랫폼 -> Virtual Machine(VM)
> 2. 물리서버 폴더 -> Bare Metal Server
> 3. 가상화 플랫폼에 있는 ESXi 호스트 메뉴를 "Hypervisor" 라는 제목으로 만들어줘
> 4. 특수기능의 서버분석 메뉴를 "Pysical Server" 라는 이름으로 변경해줘
> 클로드 디자인으로 시안 보여줘

4번의 ‘Pysical’ 은 오타로 보고 시안에는 **Physical Server** 로 적었다(컨펌 때 확인).

## 2. 지금 코드에서 확인한 것(파일:줄)

| 사실 | 위치 |
|---|---|
| 스크린샷의 '서버' 그룹(가상화 플랫폼 · 물리서버 폴더 · 물리 서버 · 베어메탈 사용률 · 통합 서버 인벤토리 — 5개)은 **포탈 기본 메뉴가 아니다**. 기본은 가상화 플랫폼 · 물리 서버 · Backup · 알람 4개 → 내 메뉴 또는 배포 메뉴로 편집된 상태 | `web/src/views/topMenu.js:23-39` |
| 저장 메뉴는 **주소만** 담는다. 라벨은 기본 메뉴 항목(같은 탭 · 같은 도구+조각)이나 도구 카탈로그(+ 이름 덮어쓰기 `overrides[tool].label`)에서 채운다 → 코드의 라벨을 바꾸면 편집된 메뉴에도 반영된다 | `sidebar/sideMenu.js:8-11, 127, 151` |
| 1번: 항목 `virt` — `label '가상화 플랫폼'` · `tab 'vcenters'` · `tabs ['hosts','vms']` · `also` 도구 16개. 같은 이름이 허브 제목 `<h1>` · `aria-label` · 브레드크럼 뿌리 2곳 · 상수 `PLATFORM_MENU_LABEL` 에도 있다 | `topMenu.js:29-33` · `platform/PlatformHub.jsx:39-47` · `vcd/ObjectShell.jsx:14` · `VCenterDetail.jsx:566` · `platform/platformText.js:20` |
| 2번: 도구 `bm-folders` 카탈로그 라벨 '물리서버 폴더'(기본 메뉴에는 없다 — 특수 기능에서 더한 항목). 화면 제목 · 서비스 인벤토리 문구에도 같은 이름 | `specialToolsList.js:31` · `tools/BmFolders.jsx:140` · `tools/svcInventory/Queues.jsx` · `svcInventoryText.js:9` |
| 3번: ESXi 호스트는 v2.942(코드 표지 v2.915)에 `virt` 항목으로 합쳐졌다 — 허브 탭 `{ k:'hosts', label:'ESXi 호스트' }`. 사이드바에는 따로 없다. `locate('hosts')` 는 `virt` 를 가리키고, 저장 메뉴의 옛 `tab:hosts` 는 별칭으로 `virt` 에 이어진다 | `platform/platformText.js:14-18` · `topMenu.js:104-122` · `sidebar/sideMenu.js:58-69` |
| 4번: 도구 `serveranalysis`(관리자 전용) 카탈로그 라벨 '서버 분석' + 기본 메뉴 '자원관리 › 서버 분석'(`sa`) + **'서버 › 물리 서버'(`bm` — 같은 도구의 Baremetal 구분 · `seg: 'baremetal'`)**. '서버 분석 › …' 로 가리키는 문구가 통합 검색 · 베어메탈 사용률 · 서버실 온도 · 수집 서버 화면 등 웹 27줄(16파일) · 서버 쪽 문자열 16줄(주석 제외 grep 근사치) | `specialToolsList.js:137` · `topMenu.js:34, 64` · `components/invSearchQuery.js:128-129, 275` · `tools/BmUsage.jsx:456` · `tools/RoomTemp.jsx:554-569` |
| 사이드바 자물쇠는 관리자에게 보이는 '관리자 전용' 표시(`isAdmin && c.adminOnly`) | `sidebar/Sidebar.jsx:58, 75` |
| 테스트가 고정한 것: 서버 하위 라벨 · `locate('hosts')` · `missingDefaults` · `vm.also == HUB_TOOL_KEYS` · 기능 사용 현황의 항목 이름 | `topMenu.test.js` · `sidebar/sideMenu.test.js` · `sidebar/menuEdit.test.js` · `singleMenu2891.test.js` · `vms/vmHub2909.test.jsx` · `platform/platformText.test.js` · `featureUsageText.test.js` |

바꾸면 안 되는 것(루트 CLAUDE.md): 탭 id(`vcenters` · `hosts` · `vms`) · 도구 키(`bm-folders` · `serveranalysis`) · 해시 주소. 옛 이름은 `specialToolsList.js` 의 `aka` 로 남긴다.

## 3. 시안(보드 3장)

| 보드 | 내용 |
|---|---|
| ① `Main.dc.html` 사이드바 — 지금 → 바꾼 뒤 | 스크린샷과 같은 편집된 메뉴 기준. 서버 그룹 5 → 6: **Virtual Machine(VM)** · **Hypervisor**(새 항목) · **Bare Metal Server** · 물리 서버(그대로 · 결정 필요) · 베어메탈 사용률 · 통합 서버 인벤토리. 오른쪽에 바뀌는 이름 4 + 결정 1, 아래에 자원관리 그룹(기본 메뉴 3개 기준)의 서버 분석 → **Physical Server** |
| ② `Tools.dc.html` 특수 기능 카드 · 검색 | 카드 2장 이름만 바뀜(설명 · 주소 그대로) · 옛 이름(‘서버 분석’ · ‘물리서버 폴더’)을 입력해도 같은 카드가 나옴(`aka`) |
| ③ `Hypervisor.dc.html` Hypervisor 메뉴를 누른 화면 | 새 화면이 아니라 **지금의 허브 호스트 탭**(`#/hosts`). 사이드바는 Hypervisor 가 켜지고, 허브 제목 = ‘Hypervisor’, 탭 줄 = `vCenter · 법인` · `Hypervisor · ESXi 호스트` · `Virtual Machine · VM`(옛 이름은 작은 글자로) |

시안이 전제한 동작(구현 때 확정):
- **Virtual Machine(VM)** 은 VM 탭(`#/vms`)을 열고, vCenter 탭 · VM 탭에 있을 때 켜진다. **Hypervisor** 는 호스트 탭(`#/hosts`)을 열고 그 탭에서 켜진다. 지금의 ‘마지막으로 본 탭 기억’(메뉴 클릭 = 마지막 탭)은 두 메뉴가 각자 탭을 가리키게 되면 뜻이 없어져 뺐다.
- 호스트 탭 도구 4개(`host-hygiene` · `esxi` · `hba` · `cluster-check`)를 열면 Hypervisor 가, 나머지 12개는 Virtual Machine(VM) 이 켜진다.
- 도구 이름 안의 ‘ESXi’(ESXi 호스트 구성 점검 · ESXi 버전별)는 요청에 없어 그대로 뒀다.

## 4. 열린 질문(컨펌 때)

1. **‘Pysical’ → Physical** 로 적는 것이 맞는지.
2. **‘물리 서버’(서버 분석의 Baremetal 구분 바로가기)** — 4번 뒤에는 Physical Server 와 뜻이 같은 이름이 둘이 된다(하나는 전체, 하나는 Baremetal 만). 그대로 / 이름 변경(예: ‘Physical Server · Baremetal’) / 기본 메뉴에서 빼기 중 하나.
3. **허브 안의 이름** — 시안처럼 제목 · 탭 · 브레드크럼 뿌리까지 새 이름으로 맞출지, 사이드바 이름만 바꿀지.
4. **편집된 메뉴에 Hypervisor 넣기** — 저장 메뉴(내 메뉴 · 배포 메뉴)에는 새 기본 항목이 자동으로 생기지 않는다(메뉴 편집의 ‘다시 넣기’ 목록에 나온다). 한 번 직접 넣게 둘지, ‘가상화 플랫폼 항목이 있는 메뉴에는 그 아래 자동으로 넣기’ 를 구현 범위에 넣을지(뒤쪽은 사용자가 일부러 지운 경우를 구분해야 해 저장 형식에 표시가 필요하다 — 추정).
5. **‘서버 분석 › …’ 로 가리키는 문구(웹 27줄 · 서버 16줄 — §2)**(통합 검색 결과 이름 · 베어메탈 사용률 · 서버실 온도 안내 등)도 ‘Physical Server › …’ 로 함께 바꿀지. 바꾸지 않으면 메뉴에 없는 이름을 안내하게 된다.
6. 2번의 화면 제목(물리서버 폴더 화면 `<b>` 제목) · 서비스 인벤토리의 ‘물리서버 폴더 규칙’ 문구도 Bare Metal Server 로 바꿀지.

## 5. 구현 기록(코드 표지 v2.994 · 2026-11-13)

### 결정 6개의 답(§4 추천안)

| # | 질문 | 답 |
|---|---|---|
| 1 | 표기 | **Physical Server**('Pysical' 은 오타) |
| 2 | 기본 메뉴 '물리 서버'(`bm`) | 이름 **'Physical Server · Baremetal'** — id · tool · seg 그대로 |
| 3 | 허브 안의 이름 | 새 이름으로 — 제목 · `aria-label` · 탭 줄 · 경로 뿌리 |
| 4 | 저장 메뉴에 Hypervisor 자동 넣기 | **하지 않는다** — 메뉴 편집 '다시 넣기'(`missingDefaults`) 후보로 나온다 · 저장 형식 그대로 |
| 5 | '서버 분석 › …' 위치 안내 문구 | 'Physical Server › …' 로 바꾼다(화면 · 파일 안내만 — 식별자 · 키 · 저장값은 그대로) |
| 6 | 물리서버 폴더 | 화면 제목 · 위치 안내('특수 기능 › …')만 'Bare Metal Server' — 개념 이름('물리서버 폴더 규칙' 등)은 그대로 |

### 바꾼 것(요약)

- **메뉴** `web/src/views/topMenu.js`: `virt` = 'Virtual Machine(VM)' · `tab:'vms'` · `tabs:['vcenters']` · also VM 6 + vCenter 6 / 새 `hv` = 'Hypervisor' · `tab:'hosts'` · also 호스트 4 / `bm` · `sa` 이름. 메뉴 클릭 진입 탭 판정 `menuTabOf`(App `goMenu` 가 씀).
- **저장 메뉴** `sidebar/sideMenu.js`: 코드는 그대로(별칭은 topMenu `tabs` 에서 만든다) — 결과적으로 별칭이 `tab:vcenters → tab:vms` 하나가 됐고 옛 `tab:hosts` 는 실제 항목 hv 로 풀린다.
- **허브** `platform/platformText.js`: `PLATFORM_TABS` 이름(Hypervisor · ESXi 호스트 / Virtual Machine · VM) · `platformMenuLabel(tab)`(MENU_GROUPS 라벨을 읽음 — 상수 `PLATFORM_MENU_LABEL` 삭제) · `VM_ITEM_TOOL_KEYS` · `HV_ITEM_TOOL_KEYS` · 마지막 본 탭 기억(`loadLastTab` · `saveLastTab` · `LS_TAB`) 삭제.
  `PlatformHub.jsx` 제목 · `aria-label` · '마지막으로 본 탭을 기억합니다' 문구 삭제(`platform.css` 의 `.ph-note` 규칙도 — 오른쪽 밀기는 `.ph-snap` 이 맡음). 경로 뿌리 `vcd/ObjectShell.jsx` · `VCenterDetail.jsx`.
- **App** `web/src/App.jsx`: 메뉴 클릭은 `menuTabOf(item)` — 마지막 탭으로 가지 않는다 · `setTab` 의 기억 저장 삭제 · 쓰지 않게 된 `lsSafe` 삭제. vCenter 탭으로 갈 때의 드릴다운 닫기 신호는 그대로.
- **카탈로그** `specialToolsList.js`: `serveranalysis` 'Physical Server'(aka '서버 분석' · '서버분석') · `bm-folders` 'Bare Metal Server'(aka 에 '물리서버 폴더' 추가 — '물리 서버 폴더' 는 원래 있었다) · `bm-usage` 설명의 위치 안내. 서버 `toolcats/catalog.js` 는 도구 라벨을 갖지 않는다(분류 라벨만).
- **위치 안내 문구**: 웹 `invSearchQuery.js`(검색 화면 이름 — 서버에 두 벌 없음) · `collectorDiag.js` · `Collectors.jsx` · `overviewCardsText.js` · `collectors/collectorDcText.js` · `tools/{BmUsage,IdracTrendTool,RoomTemp,CorpUsage,FleetHwExportModal,HardwareTools,FleetInventory,BmFolders}.jsx` · `tools/{bmUsageText,fleetCorpText}.js` · `tools/svcInventory/Queues.jsx`(위치 안내 2줄) / 서버 `insights/dbGuideData.js`(9줄) · `insights/hwExport/xlsx.js`(2줄).
- **기능 사용 현황** `featureUsageText.js`: 코드는 그대로 — 이름이 'Virtual Machine(VM)'(tab:vms) · 'Virtual Machine(VM) › vCenter'(tab:vcenters) · 'Hypervisor'(tab:hosts) 로 따라간다.

### 남긴 것

- 주석 안의 '서버 분석' · '물리서버 폴더' · '가상화 플랫폼'(식별자 · 동작과 무관).
- 개념 이름 '물리서버 폴더 규칙'(웹 `svcInventoryText.SRC_LABEL` · 서버 `routes/api/svcInventory.js` 두 벌) · 저장소 손상 · 폴더 이름 변경/삭제 결과 문구 · 서버 오류 사유(`servicemap/ops.js` · `routes/api/bmFolders.js`).
- 일반 용어 '물리 서버'(Overview 카드 · 법인별 서버 사용량 `ROLE_LABEL` · 서버 온도 `KIND_LABEL`) · 도구 이름 안의 'ESXi'.
- `release-notes.json` 의 옛 릴리스 문구(기록).
- 브라우저에 남은 localStorage `platform.tab` 값 — 읽는 코드가 없어 무해(지우는 코드는 넣지 않았다).

