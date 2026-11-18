# 설계: ‘Virtual Machine’ 메뉴 — 누르면 법인 바로가기와 vCenter 카드만

- 상태: **시안(컨펌 대기)** — 구현은 컨펌 뒤(Opus). 이 폴더는 문서뿐이라 릴리스가 없다.
- 캔버스(Claude Design): https://claude.ai/artifact/E7RGUQQWYhDGuVGAd8prTa (비공개 — 소유자만 열 수 있다)
- 아트보드 원본: 이 폴더의 `*.dc.html` 6개(캔버스에 올린 것과 같은 파일). 캔버스가 실제로 어떻게 그려지는지는 열어 확인하지 않았다(Design 유형 규칙 — 요청 없이는 검증하지 않는다).
- 앞선 설계: `docs/design/virt-platform-menu/`(v2.915 세 메뉴를 허브 하나로) · `docs/design/server-menu-rename/`(v2.994 ‘Virtual Machine(VM)’ · ‘Hypervisor’ 로 나눔).

## 1. 요구(사용자 2026-11-18 10:08 KST · 캡처 2장)

> "1. 메뉴의 Virtual Machine(VM) 메뉴명을 "Virtual Machine" 이라고 변경하고,
> 2. Virtual machine 메뉴를 클릭하면 내가 캡춰한 상단에 법인을 선택하는 메뉴가 나오고, 그 아래로 vCenter 가 카드 형식으로 나오는 예전 버전에서 구현된 메뉴르만 만들어줘, 시안 만들어서 보여줘"

캡처: ① 사이드바(서버 › Virtual Machine(VM) 에 동그라미) ② 화면 상단(제목 · 숫자 3장 · 바로가기 법인 칩).

해석(내 판단 — 다르면 §5 에서 바로잡는다):
- ‘내가 캡춰한 상단’ = 캡처 ② 전체(제목 · 숫자 3장 · 바로가기)를 **그대로 둔다**. ‘법인을 선택하는 메뉴’ = 바로가기 칩 줄.
- ‘예전 버전’ = v2.915 로 허브가 되기 전의 vCenter 화면(요약 카드 → 바로가기 → vCenter 카드).
- ‘메뉴로만’ = 바로가기 아래에 **카드만** 둔다(지금 그 사이에 있는 보기 전환 · 도구 줄 · 요약 3장을 뺀다).

## 2. 지금 코드에서 확인한 것(main v3.18.13 · 목 서버 · Chromium 1440 · 400)

| 무엇 | 어디 | 사실 |
|---|---|---|
| 메뉴 항목 | `web/src/views/topMenu.js` `{ id: 'virt', label: 'Virtual Machine(VM)', tab: 'vms', tabs: ['vcenters'], also: [...] }` | 누르면 `menuTabOf(item)` = 처음 허용 탭 = **VM 탭**(`#/vms`). Chromium 으로 확인(메뉴 클릭 → `#/vms`). |
| 화면 제목 | `platform/platformText.js platformMenuLabel(tab)` | 이름을 따로 적지 않고 `MENU_GROUPS` 의 라벨을 읽는다 — 라벨 하나를 바꾸면 제목 · 경로 첫 칸이 따라온다. |
| 상단 | `platform/PlatformHub.jsx` | 제목 · 엔티티 탭 3장(vCenter · Hypervisor · Virtual Machine — 수 + 배지 + 분해) · 바로가기 칩(법인별 숫자 · 고른 법인은 파랗게 · 접기 기억). 세 탭이 같은 상단을 쓴다. |
| vCenter 탭 본문 | `views/VCenters.jsx` | 상단 아래에 ⓐ 보기 전환 ‘카드 \| 표 · 법인별 비교’ + vCenter 도구 6개 ⓑ 요약 3장(VM 백업 · VM 증가 추이 · 스토리지 증가 추이) ⓒ vCenter 카드(`.vc-grid` — 1440 에서 3열). |
| 카드 | `VCenters.jsx` `.vc-card` | 이름 · 위치 · 상태 / 호스트 · VM(on) · 알람 · 백업 / CPU · 메모리 · 스토리지 막대 / 버전 · id. 누르면 그 vCenter 상세(요약 탭). 예전 버전(`cbd3fd14^`)과 구성이 같다 — 달라진 것은 호스트 · VM 수의 화살표(그 탭으로 이동)와 백업 표기(veeam/bareos)뿐. |
| 칩을 누르면 | `PlatformHub` `onPickVcenter` | 허브 범위가 그 법인으로 좁혀진다 — 숫자 3장이 그 법인 값(목 서버: 1 / 24 / 240)이 되고 카드는 1장만 남는다. 예전 버전은 그 카드로 스크롤만 했다. |
| 표 보기 | `platform/VcTable.jsx` | **이 화면에서만** 쓴다(다른 화면에 없음). |
| 요약 3장 | `VCenters.jsx` `TrendKpis` · 백업 KPI | 각각 Backup 현황 · `#/tools/vm-track` · `#/tools/storage-track` 으로 가는 바로가기 — 값은 그 화면들에 있다. |
| 도구 6개 | `platformText.VC_TOOLS` | vcversion · solutions · licenses · license-expiry · cert-expiry · change-history — 모두 `specialToolsList.js` 에 있다(특수 기능에서 열린다). |
| 이름이 적힌 곳 | `grep "Virtual Machine(VM)"` | 19개 파일(웹 소스 · 주석 · 테스트 8개) — 테스트는 `topMenu` · `sideMenu` · `menuEdit` · `singleMenu2891` · `platformText` · `featureUsageText` · `vmHub2909` · 서버 `platformHub2915`. |

캡처(스크래치패드): `vmm-cur-menu-vms-1440.png`(메뉴 클릭 → VM 탭) · `vmm-cur-vcenters-1440.png`(vCenter 탭) · `vmm-cur-vcenters-chip-1440.png`(칩을 고른 상태) · `vmm-cur-vcenters-400.png`. 캔버스 ⓪ 에 앞의 두 장을 실었다.

## 3. 정직하게 밝혀야 하는 것

- 캔버스의 법인 이름 · 숫자는 **목(mock, 가상) 서버 값**이다(11개 법인). 보내 주신 캡처의 28개 법인 · 5,952 VM 이 아니다. 사이드바 구성만 캡처의 것을 그렸다.
- 시안 A 로 가면 **‘표 · 법인별 비교’ 보기가 사라진다** — 그 표는 이 화면에만 있다. 도구 6개와 요약 3장의 값은 다른 화면에 그대로 있다.
- 메뉴를 누르면 카드가 먼저 나오므로 **VM 목록은 한 번 더 눌러야** 한다(상단의 ‘Virtual Machine · VM’ 숫자 카드).
- 화면 제목이 ‘Virtual Machine’ 인데 처음 열리는 탭은 ‘vCenter · 법인’ 이다 — 요청하신 이름 그대로지만 제목과 탭 이름이 엇갈려 보일 수 있다.
- 사용자 메뉴에 ‘Hypervisor’ 항목이 없어도(캡처의 메뉴) 상단의 ‘Hypervisor · ESXi 호스트’ 숫자 카드로 호스트 탭에 갈 수 있다 — 지금과 같다.
- 계정의 ‘Design System’ 은 쓰지 않았다(2026-11-06 확인 때 README · 토큰이 없었다) — 포탈의 색 · 글꼴을 그대로 썼다.

## 4. 시안 — 아트보드 6장

| # | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` 1440×1400 | **시안 A(요청 그대로)** — 메뉴 ‘Virtual Machine’ 을 누르면: 상단(제목 · 숫자 3장 · 바로가기) 바로 아래에 vCenter 카드(3열). 사이에 아무것도 없다. |
| ② | `Picked.dc.html` 1440×760 | 법인 칩 하나를 고른 상태 — 범위가 그 법인으로(숫자 3장이 그 법인 값 · 카드 1장 · 같은 칩을 다시 누르면 전체). |
| ③ | `Narrow.dc.html` 400×1500 | 400px — 숫자 3장은 작게 한 줄 · 칩은 줄바꿈 · 카드는 한 열. |
| ⓪ | `Current.dc.html` 1440×1000 | 지금 캡처 2장 + 지금 · 시안 A 비교표. |
| ④ | `AltB.dc.html` 1440×900 | **대안 B** — 바로가기와 카드 사이에 한 줄만 남긴다(보기 전환 · ‘vCenter 도구 6 ▾’ · 요약 값 3개). |
| ⑤ | `MenuName.dc.html` 760×640 | 메뉴 이름 전 · 후 + 이름이 함께 바뀌는 곳 · 바뀌지 않는 것. |

## 5. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

| # | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 바로가기와 카드 사이 | **A — 아무것도 두지 않는다**(보기 전환 · 도구 줄 · 요약 3장을 뺀다 · ‘표 · 법인별 비교’ 보기는 없어진다) | B — 한 줄로 남긴다(캔버스 ④) |
| ② | 메뉴를 누르면 여는 탭 | vCenter 탭(카드). VM 목록은 상단 ‘Virtual Machine · VM’ 을 눌러서 | 지금처럼 VM 탭 |
| ③ | 법인 칩을 누르면 | 지금처럼 범위를 그 법인으로(카드 1장) | 예전처럼 그 카드로 스크롤만(범위는 그대로) |
| ④ | 상단 숫자 3장 | 그대로(캡처와 같은 모습) | 빼고 바로가기 + 카드만 |
| ⑤ | 이름 | ‘Virtual Machine’ — 화면 제목 · 경로 첫 칸 · 메뉴 편집 · 기능 사용 현황까지 | 사이드바만 |
| ⑥ | 검증 | 표준 — 관련 테스트 + Chromium 1440 · 400 1회 | 전체 검증 · 빠르게 |

## 6. 구현 메모(컨펌 뒤 · Opus)

- `topMenu.js` `virt`: `label: 'Virtual Machine'` · 처음 여는 탭을 vcenters 로 — `tab: 'vcenters', tabs: ['vms']`.
  이렇게 하면 항목의 정체 키가 `tab:vcenters` 로 돌아가고 `tab:vms` 가 별칭이 된다(`sidebar/sideMenu.js itemAliases` 는 `tabs` 에서 자동으로 만든다).
  v2.994 이후 저장된 사용자 메뉴(`tab:vms`)와 그 이전 메뉴(`tab:vcenters`) 둘 다 풀리는지 테스트로 고정한다. 정체 키를 바꾸지 않으려면 `entry` 필드를 따로 두는 방법도 있다 — 구현 때 판단.
- `App.jsx` 메뉴 클릭: `menuTabOf(item)` 이 vcenters 를 돌려주면 드릴다운을 닫는 재클릭 신호(`setPlatformResetSeq`)가 그대로 탄다. `dashboard` 권한이 없는 계정은 VM 탭으로 떨어진다(`visibleMenu` 의 처음 허용 탭).
- `VCenters.jsx`(A): `HubTabs` 줄 · 요약 3장 · `VcTable` 분기 · `LS_VC_VIEW` 기억을 걷어낸다. 안 쓰게 되는 모듈(`platform/VcTable.jsx` · `VC_VIEWS` · `loadVcView` · `saveVcView` · `TrendKpis`)과 그 테스트는 지운다 — 죽은 코드를 남기지 않는다.
  VM 이름 검색 결과 표(`VmNameSearch`) · 검색 무결과 안내 · 용량 각주는 그대로 둔다(범위 바의 검색이 쓴다).
- `also`(이 항목이 켜지는 도구 12개)는 그대로 — 도구 화면에서 사이드바 강조가 유지된다.
- 이름을 박은 테스트 8개 파일과 주석을 고친다. 릴리스 노트에 ‘메뉴 이름 · 처음 여는 화면이 바뀐다’ 를 적는다.
- 화면이 바뀌므로 Chromium 1440 · 400(오류 0 · 가로 넘침 0 · 메뉴 클릭 → `#/vcenters` · 칩 · 카드 클릭 · 숫자 3장으로 탭 이동)을 직접 본다.
