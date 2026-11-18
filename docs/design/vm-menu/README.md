# 설계: ‘Virtual Machine’ 메뉴 — 누르면 법인 바로가기와 vCenter 카드만

- 상태: **시안(컨펌 대기)** — 구현은 컨펌 뒤(Opus). 이 폴더는 문서뿐이라 릴리스가 없다.
- **1번 덩어리 구현 v3.19.0** — 숫자 3장 순서 · 설명 문구 제거 · vCenter 탭 카드 위 걷어냄(A) · 바로가기 글자로 찾기 · 400px 분해 중복(B1) · 죽은 코드(B2/B3). 화면(Chromium) 확인은 다음 단계.
- **2번 덩어리 구현 v3.20.0** — 바로가기 복수 선택(§5 ③ 기본값 · 시안 ②): 칩 켜고 끄기 · ‘✕ 전체 법인’ · 범위 바 ‘법인 N곳 선택’ · 리전 밖 선택 풀림 · 세 탭 · 숫자 3장 · 상세 이웃이 고른 법인들로(API 1곳 vcenterId · 2곳 이상 vcenterIds). 화면(Chromium) 확인은 다음 단계.
- 캔버스(Claude Design): https://claude.ai/artifact/E7RGUQQWYhDGuVGAd8prTa (비공개 — 소유자만 열 수 있다)
- 아트보드 원본: 이 폴더의 `*.dc.html` 6개(캔버스에 올린 것과 같은 파일). 캔버스가 실제로 어떻게 그려지는지는 열어 확인하지 않았다(Design 유형 규칙 — 요청 없이는 검증하지 않는다).
- 앞선 설계: `docs/design/virt-platform-menu/`(v2.915 세 메뉴를 허브 하나로) · `docs/design/server-menu-rename/`(v2.994 ‘Virtual Machine(VM)’ · ‘Hypervisor’ 로 나눔).

## 1. 요구(사용자 2026-11-18 10:08 KST · 캡처 2장)

> "1. 메뉴의 Virtual Machine(VM) 메뉴명을 "Virtual Machine" 이라고 변경하고,
> 2. Virtual machine 메뉴를 클릭하면 내가 캡춰한 상단에 법인을 선택하는 메뉴가 나오고, 그 아래로 vCenter 가 카드 형식으로 나오는 예전 버전에서 구현된 메뉴르만 만들어줘, 시안 만들어서 보여줘"

캡처: ① 사이드바(서버 › Virtual Machine(VM) 에 동그라미) ② 화면 상단(제목 · 숫자 3장 · 바로가기 법인 칩).

추가 요청(같은 날 10:33 · 10:36 KST — 시안을 본 뒤):

> "바로가기의 선택을 복수개 선택해서 볼 수 있게 해줘"
> "이전에는 복수 선택이 되는 기능이였어"
> (10:42 · 제목 옆 설명 문구 캡처) "이 문구 제거"
> (10:45) "바로가기 메뉴에 텍스트로 검색하는 기능 추가 AAA AAB 라는 vcenter 가 있을때 AA 를 입력하면 AAA AAB 모두 보이게 해줘"
> (10:52) "1. 어떤 메뉴를 누르면 나오는지 화면으로 보여줘, 시안으로 클릭 가능하게 해서 보여줘 2. Pysical Server . baremetal 을 Pysocal 서버라고 변경해줘"

10:52 요청의 읽기(내 판단): ① 은 **눌러 볼 수 있는 시안**(캔버스 ⑦ — 재생을 누르면 왼쪽 메뉴 · 숫자 3장 · 칩 · 찾기 칸 · 카드가 반응한다).
② 의 ‘Pysocal 서버’ 는 **‘Physical 서버’** 의 오타로 읽었다(원래 이름 ‘Physical Server · Baremetal’ 의 앞 낱말 — 다르면 §5 ⑧ 에서 바로잡는다).

기록으로 확인한 것(릴리스 노트 1,330건 · 저장소 이력은 2026-11-02 부터만 있다 — 얕은 복제): **이 화면**의 바로가기는 v2.92 ‘누르면 그 카드로 스크롤 + 반짝’ → v2.942(코드 표지 v2.915)
‘누르면 범위를 그 법인 한 곳으로’ 였고 복수 선택 기록은 찾지 못했다. 같은 모양의 법인 칩이 **복수 선택**인 화면은 스토리지 현황(v2.407) · SAN 스위치(v2.414 · v2.669) · GPU 할당 계층(v2.853 —
‘vCenter 화면의 바로가기와 같은 칩 줄 · 여러 개를 함께 고를 수 있다 · ✕ 전체 법인’)이다. 어느 쪽 기억이든 요청은 같다 — 이 화면의 바로가기도 복수 선택으로 한다(캔버스 ②).

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
| 범위는 법인 **한 곳** | `App.jsx` `tabFilters[...].vcenterId`(문자열 하나) · `filters` · `scope` | 화면 상태에만 있다(주소 · 브라우저에 기억하지 않는다 — 새로고침하면 풀린다). API 에는 `vcenterId=<하나>` 로 실린다. |
| 서버가 받는 범위 | `routes/api/shared.js applyFilters` — `x.vcenterId === query.vcenterId` | 한 곳만. 허브 세 탭이 범위를 실어 부르는 API 는 `/hosts` · `/hosts/checks` · `/hosts/corp` · `/vms` · `/vms/by-vcenter` · `/platform/summary` 6개(고칠 곳은 공용 필터 + `/hosts/corp` · `/vms/by-vcenter` · `/platform/summary` 4곳). `query.vcenterId` 를 직접 읽는 서버 파일은 51개 — 허브 밖 도구들이라 이번 범위가 아니다. |
| 복수 선택이 이미 있는 화면 | `tools/GpuAllocTree.jsx toggleVc`(Set) · ‘✕ 전체 법인’ | 받아 둔 목록을 화면에서 거르는 방식(서버 변경 없음). vCenter 카드도 `/vcenters` 를 통째로 받아 두므로 **카드만 거르는 것은 화면에서 된다**. 위 숫자 3장과 호스트 · VM 탭은 서버가 계산하므로 서버가 목록을 받아야 한다. |
| 바로가기 안 찾기 칸 | 예전(`cbd3fd14^` `VCenters.jsx`) `<SearchBox … placeholder="vCenter · VM 이름 찾기">` 가 `.vc-quicknav` 안에 · 칩도 `shown`(걸러진 목록)으로 그림 | **예전 버전에는 있었다**(릴리스 노트 v2.231 ‘바로가기 버튼 줄도 함께 좁혀집니다’ · v2.232 ‘찾기 칸을 바로가기 상자 안으로’). v2.915 에 찾기가 위쪽 공용 범위 바로 올라가며 칩은 좁히지 않게 됐다 — 지금 `PlatformHub` 는 `chipSites(vcenters, region)` 만 본다(Chromium: 검색해도 칩 28개 그대로 · 카드만 좁혀짐). |
| 법인별 요약 값 | `/platform/summary` `byVc[]` | 법인마다 `hosts.attention` · `hosts.hot` · `vms.attention` · `vms.signals{overload,toolsOld,snapOld}` · `alarms{critical,warning}` 가 이미 온다 — 카드는 지금 알람 수만 쓴다. |
| 이름이 적힌 곳 | `grep "Virtual Machine(VM)"` | 19개 파일(웹 소스 · 주석 · 테스트 8개) — 테스트는 `topMenu` · `sideMenu` · `menuEdit` · `singleMenu2891` · `platformText` · `featureUsageText` · `vmHub2909` · 서버 `platformHub2915`. |

캡처(스크래치패드): `vmm-cur-menu-vms-1440.png`(메뉴 클릭 → VM 탭) · `vmm-cur-vcenters-1440.png`(vCenter 탭) · `vmm-cur-vcenters-chip-1440.png`(칩을 고른 상태) · `vmm-cur-vcenters-400.png`. 캔버스 ⓪ 에 앞의 두 장을 실었다.

## 3. 정직하게 밝혀야 하는 것

- 캔버스의 법인 이름 · 숫자는 **목(mock, 가상) 서버 값**이다(11개 법인). 보내 주신 캡처의 28개 법인 · 5,952 VM 이 아니다. 사이드바 구성만 캡처의 것을 그렸다.
- 시안 A 로 가면 **‘표 · 법인별 비교’ 보기가 사라진다** — 그 표는 이 화면에만 있다. 도구 6개와 요약 3장의 값은 다른 화면에 그대로 있다.
- 메뉴를 누르면 카드가 먼저 나오므로 **VM 목록은 한 번 더 눌러야** 한다(상단의 ‘Virtual Machine · VM’ 숫자 카드).
- 화면 제목이 ‘Virtual Machine’ 인데 처음 열리는 탭은 ‘vCenter · 법인’ 이다 — 요청하신 이름 그대로지만 제목과 탭 이름이 엇갈려 보일 수 있다.
- 사용자 메뉴에 ‘Hypervisor’ 항목이 없어도(캡처의 메뉴) 상단의 ‘Hypervisor · ESXi 호스트’ 숫자 카드로 호스트 탭에 갈 수 있다 — 지금과 같다.
- 계정의 ‘Design System’ 은 쓰지 않았다(2026-11-06 확인 때 README · 토큰이 없었다) — 포탈의 색 · 글꼴을 그대로 썼다.
- 눌러 보는 시안(⑦)은 **캔버스에서 띄워 눌러 보지 않았다**(Design 캔버스는 사용자가 요청할 때만 검증한다). 확인한 것은 동작 논리뿐이다 — 보드의 스크립트를 node 에서 실행해
  메뉴 · 칩 2개 · 찾기(‘us’ · ‘zzz’ · ‘V8.0.3 seoul’) · 카드 · 숫자 3장 누름을 흉내 냈고, 합계가 목 서버 스냅샷과 같았다(11 / 186 / 2,242 · 알람 47 · 확인 대상 35 · 조치 필요 472 —
  칩 2개(us-east · eu-central)를 켜면 2 / 54 / 720). B 전환 · 표 보기 · 표의 줄 누름 · A 로 되돌림도 같은 방법으로 흉내 냈다(B 의 VM 백업 합 1,469/0). 템플릿이 쓰는 값 · 반복 항목 필드 누락도 0 이었다. **화면 배치와 누름이 실제로 먹는지는 재생으로 봐야 안다.**
- ⑦ 의 값은 10:52 무렵 목 서버에서 한 번 받은 것이라 ① ~ ⑥ 의 캡처 값(10:11)과 조금 다르다(목 서버 값이 주기마다 흔들린다 — 예: 알람 47 대 42).
- **‘Physical 서버’ 와 자원관리의 ‘Physical Server’ 는 이름이 비슷한 다른 메뉴**다(같은 도구 `serveranalysis` — 앞의 것은 구분이 Baremetal 로 고정된 바로가기). 이름을 줄이면 둘이 더 헷갈릴 수 있다.

## 4. 시안 — 아트보드 8장(⓪ ~ ⑦)

| # | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` 1440×1400 | **시안 A(요청 그대로)** — 메뉴 ‘Virtual Machine’ 을 누르면: 상단(제목 · 숫자 3장 · 바로가기) 바로 아래에 vCenter 카드(3열). 사이에 아무것도 없다. |
| ② | `Picked.dc.html` 1440×760 | **바로가기 복수 선택** — 칩은 켜고 끄는 단추. 3곳을 켠 상태: 카드는 그 3장 · 위 숫자 3장은 고른 법인의 합(목 서버 값: 3 / 50 / 496) · 범위 바는 ‘법인 3곳 선택’ · ‘✕ 전체 법인’ 으로 한 번에 해제 · 켜지 않은 칩도 숫자를 유지한다. |
| ③ | `Narrow.dc.html` 400×1500 | 400px — 숫자 3장은 작게 한 줄 · 칩은 줄바꿈 · 카드는 한 열. |
| ⓪ | `Current.dc.html` 1440×1000 | 지금 캡처 2장 + 지금 · 시안 A 비교표. |
| ④ | `AltB.dc.html` 1440×960 | **대안 B** — 바로가기와 카드 사이에 한 줄만 남긴다(보기 전환 · ‘vCenter 도구 6 ▾’ · 요약 값 3개). 그 밖은 A 와 같다 — 제목 ‘Virtual Machine’ · 제목 옆 설명 문구 없음 · 찾기 칸 · 복수 선택 안내(2026-11-18 11:01 사용자 질문 ‘시안 B 에도 반영된거야?’ 뒤에 맞춤: 제목 줄에 있던 시안 설명 글을 아래 안내로 옮기고 칩 줄에 복수 선택 안내를 넣었다). 이 보드에는 사이드바가 없어 메뉴 이름은 보이지 않는다. |
| ⑤ | `MenuName.dc.html` 760×720 | 메뉴 이름 전 · 후(**두 곳** — ‘Virtual Machine(VM)’ → ‘Virtual Machine’ · ‘Physical Server · Baremetal’ → ‘Physical 서버’) + 이름이 함께 바뀌는 곳 · 바뀌지 않는 것. |
| ⑥ | `Search.dc.html` 1440×760 | **바로가기에서 글자로 찾기** — 찾기 칸에 ‘us’ 를 넣은 상태: 그 글자가 든 법인의 칩 2개와 카드 2장만(일치한 글자 강조 · ‘2곳 · 11곳 중’ · 위 숫자 3장은 그대로). 찾기 칸은 ① ② ③ ④ 보드의 바로가기 줄에도 넣었다. |
| ⑦ | `Proto.dc.html` 1440×1800 · 눌러 보는 보드(`is_interactive`) | **어떤 메뉴를 누르면 무엇이 나오는지** — 재생을 누른 뒤: 왼쪽 메뉴(‘Virtual Machine’ → 법인 카드 화면 · 그 밖의 메뉴 → ‘바뀌지 않는 화면’ 안내 · ‘Physical 서버’ → 이름만 바뀐다는 안내) · 숫자 3장(탭 전환) · 바로가기 칩(복수 선택 → 카드와 숫자 3장이 그 법인들의 합) · 찾기 칸(부분 일치) · ‘✕ 전체 법인’ · 카드(상세 자리 → ‘← 법인 카드로’). Hypervisor · Virtual Machine 탭과 상세는 자리만 그렸다(본문은 지금 화면 그대로라서). 칩 숫자는 지금 코드(`chipCount`)처럼 탭마다 다르다(알람 · 확인 대상 · 조치 필요). 왼쪽 아래 **‘시안 고르기’**(시안용 상자 — 실제 화면에는 없다)에서 ‘B — 한 줄 남김’ 을 고르면 대안 B 로 바뀐다: 파란 점선 한 줄(카드 \| 표 · 법인별 비교 · 도구 · 요약 값 — VM 백업 값은 지금 코드처럼 켠 법인의 합)이 생기고 ‘표 · 법인별 비교’ 도 눌러 볼 수 있다(열 이름은 `VcTable.jsx` 와 같고 ‘수집’ 열만 뺐다). 메뉴 이름 · 복수 선택 · 찾기는 A · B 가 같다. |

## 5. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

| # | 질문 | 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 바로가기와 카드 사이 | **A — 아무것도 두지 않는다**(보기 전환 · 도구 줄 · 요약 3장을 뺀다 · ‘표 · 법인별 비교’ 보기는 없어진다) | B — 한 줄로 남긴다(캔버스 ④) |
| ② | 메뉴를 누르면 여는 탭 | vCenter 탭(카드). VM 목록은 상단 ‘Virtual Machine · VM’ 을 눌러서 | 지금처럼 VM 탭 |
| ③ | 법인 칩을 누르면 | **복수 선택 · 세 탭 공용** — 켠 법인들만 카드로, 위 숫자 3장은 그 합, Hypervisor · Virtual Machine 탭으로 넘어가도 같은 법인들만(서버 4곳 수정) | 카드 화면에서만 복수 선택(다른 탭으로 가면 풀림 — 서버는 요약 1곳만) · 지금처럼 한 곳만 |
| ④ | 상단 숫자 3장 | 그대로(캡처와 같은 모습) | 빼고 바로가기 + 카드만 |
| ⑤ | 이름 | ‘Virtual Machine’ — 화면 제목 · 경로 첫 칸 · 메뉴 편집 · 기능 사용 현황까지 | 사이드바만 |
| ⑥ | 검증 | 표준 — 관련 테스트 + Chromium 1440 · 400 1회 | 전체 검증 · 빠르게 |
| ⑦ | 바로가기 찾기가 좁히는 것 | 칩과 카드 함께(법인을 켜 둔 상태면 칩만 — 카드는 켠 법인 그대로) · 위 숫자 3장은 그대로 | 칩만 좁힘(카드는 그대로) |
| ⑧ | ‘Physical Server · Baremetal’ 의 새 이름 | **‘Physical 서버’**(‘Pysocal 서버’ 를 오타로 읽음) — 메뉴 · 기능 사용 현황 · 그 화면의 안내 글 두 줄. 여는 화면 · 주소 · 자원관리의 ‘Physical Server’ 는 그대로 | 다른 철자(예: ‘Physical Server’ — 자원관리 메뉴와 이름이 같아진다) |

## 6. 구현 메모(컨펌 뒤 · Opus)

- `topMenu.js` `virt`: `label: 'Virtual Machine'` · 처음 여는 탭을 vcenters 로 — `tab: 'vcenters', tabs: ['vms']`.
  이렇게 하면 항목의 정체 키가 `tab:vcenters` 로 돌아가고 `tab:vms` 가 별칭이 된다(`sidebar/sideMenu.js itemAliases` 는 `tabs` 에서 자동으로 만든다).
  v2.994 이후 저장된 사용자 메뉴(`tab:vms`)와 그 이전 메뉴(`tab:vcenters`) 둘 다 풀리는지 테스트로 고정한다. 정체 키를 바꾸지 않으려면 `entry` 필드를 따로 두는 방법도 있다 — 구현 때 판단.
- `App.jsx` 메뉴 클릭: `menuTabOf(item)` 이 vcenters 를 돌려주면 드릴다운을 닫는 재클릭 신호(`setPlatformResetSeq`)가 그대로 탄다. `dashboard` 권한이 없는 계정은 VM 탭으로 떨어진다(`visibleMenu` 의 처음 허용 탭).
- `VCenters.jsx`(A): `HubTabs` 줄 · 요약 3장 · `VcTable` 분기 · `LS_VC_VIEW` 기억을 걷어낸다. 안 쓰게 되는 모듈(`platform/VcTable.jsx` · `VC_VIEWS` · `loadVcView` · `saveVcView` · `TrendKpis`)과 그 테스트는 지운다 — 죽은 코드를 남기지 않는다.
  VM 이름 검색 결과 표(`VmNameSearch`) · 검색 무결과 안내 · 용량 각주는 그대로 둔다(범위 바의 검색이 쓴다).
- `also`(이 항목이 켜지는 도구 12개)는 그대로 — 도구 화면에서 사이드바 강조가 유지된다.
- 이름을 박은 테스트 8개 파일과 주석을 고친다. 릴리스 노트에 ‘메뉴 이름 · 처음 여는 화면이 바뀐다’ 를 적는다.
- **‘Physical Server · Baremetal’ → ‘Physical 서버’(사용자 지시 2026-11-18 10:52 · §5 ⑧)**: `topMenu.js:38` `bm` 의 `label` 만 바꾼다 — `id` · `tool: 'serveranalysis'` · `seg: BAREMETAL_SEG` 는 그대로(주소 `#/tools/serveranalysis/baremetal` · 권한 · 저장된 사용자 메뉴가 깨지지 않게).
  같이 고칠 곳(전수 `grep "Physical Server · Baremetal"` — 2026-11-18): 테스트 `featureUsageText.test.js:26` · `topMenu.test.js:38,51,52` · `sidebar/sideMenu.test.js:110`, 화면 글 `tools/HardwareTools.jsx:651`(구분 칸 안내) · `:665`(화면 설명),
  주석 `topMenu.js:17,37`, 규칙 문서 `docs/rules/web.md:879`. 자원관리 `sa` = ‘Physical Server’(`topMenu.js:68`)는 **건드리지 않는다** — 이름이 비슷한 다른 메뉴라는 점을 릴리스 노트에 한 줄 적는다.
- 화면이 바뀌므로 Chromium 1440 · 400(오류 0 · 가로 넘침 0 · 메뉴 클릭 → `#/vcenters` · 칩 · 카드 클릭 · 숫자 3장으로 탭 이동)을 직접 본다.
- **제목 옆 설명 문구 제거(사용자 지시 2026-11-18)**: `PlatformHub.jsx` 의 `<span className="ph-sub">서비스 = vCenter 1 + Bareos 1 · … 탭이 바뀝니다</span>` 를 지운다.
  이 상단은 세 탭(vCenter · Hypervisor · Virtual Machine)이 같이 쓰므로 **‘Hypervisor’ 메뉴 화면에서도 함께 사라진다**. 제목 줄에는 제목과 스냅샷 시각만 남는다(`.ph-snap` 의 오른쪽 밀기는 그대로).
  그 글자를 고정한 테스트 `platform/platformText.test.js:315` 를 ‘문구가 없다’ 로 바꾸고, 안 쓰게 되는 `.ph-head .ph-sub` 스타일도 지운다. 시안 ① · ② · ③ 에서는 이미 뺐다.
- **바로가기 복수 선택(기본값 ③)**: 범위에 `vcenterIds`(목록)를 더한다 — 1곳이면 지금의 `vcenterId` 와 같은 뜻으로 그대로 보낸다(다른 화면 · 주소 · 테스트가 깨지지 않게).
  서버는 `applyFilters` · `/platform/summary` · `/hosts/corp` · `/vms/by-vcenter` 가 쉼표 목록 `vcenterIds` 를 받는다 — **사용자 조회 범위(scope) 교집합이 먼저**이고(지금 순서 그대로), 개수는 등록 vCenter 수로 자르고,
  `memoJson` 캐시 키에 목록이 들어가는지 확인한다(범위 계정 결과가 섞이지 않게 — 위험한 수정이라 변이 검증 대상). 요약은 **칩 숫자용 전체 줄(`byVc`)과 고른 법인의 합(`totals`)을 한 응답에** 준다(켜지 않은 칩의 숫자 유지).
  칩 UI 는 `GpuAllocTree` 와 같은 문법(`aria-pressed` · ‘✕ 전체 법인’). 범위 바의 vCenter 선택 칸은 2곳 이상이면 ‘법인 N곳 선택’ 을 보인다. 리전을 바꾸면 그 리전 밖 선택은 풀린다.
  상세(카드 클릭)의 ‹ 이전 · 다음 › 이웃은 고른 법인들 안에서 돈다(`siblingSites`).

## 7. 함께 찾은 것(2026-11-18 사용자 요청 ‘추가하면 좋은 기능 · 개선 · 버그’ — 채택은 미정)

확인한 방법: 코드 정독 + 목 서버 · Chromium(1440 · 400 · 법인 28곳을 응답에 주입).

| # | 구분 | 내용 | 근거 |
|---|---|---|---|
| B1 | 결함(재현) | 400px 에서 열린 탭의 분해(연결 · 불가 …)가 **탭 안과 탭 아래에 두 번** 나오고 숫자 3장이 모두 130px 로 늘어난다(세 탭 모두) | `platform.css` `.ph-tab.on .parts { display: flex; grid-column: 1 / -1 }` — `.parts` 는 탭의 자식이라 `grid-column` 이 듣지 않는다 · 아래 줄 `.ph-parts-narrow` 가 같은 글자를 이미 그린다. 실측: 탭 안 `flex` · 아래 `flex` · 같은 글자. 그 규칙 한 줄을 지우면 된다. |
| B2 | 죽은 코드 | `VCenters.jsx` `cardRefs`(쓰기만 하고 읽지 않는다) · `styles.css` `.vc-card.flash` + `@keyframes vcFlash`(붙이는 곳 없음) | v2.915 에 ‘카드로 스크롤 + 반짝’ 을 빼며 남았다. |
| B3 | 구현 때 함정 | 브라우저에 `platform.vcView = 'table'` 이 남아 있으면 vCenter 탭에 카드 대신 표가 나온다(재현) | 시안 A 로 가면 그 기억값을 읽지 않게 해야 ‘메뉴를 누르면 카드’ 가 지켜진다(§6 에 반영). |
| I1 | 개선 | 법인 28곳이면 첫 카드가 멀다 — 1440 에서 616px(900px 화면에 첫 줄이 반쯤), 400 에서 1,231px(칩 8줄 345px + 도구 줄 + 요약 3장) | 실측. 시안 A 가 사이 줄을 빼면 1440 은 당겨지지만 400 의 칩 8줄은 남는다 — 좁은 화면은 바로가기를 기본으로 접거나 가로 한 줄로. |
| I2 | 개선 | 카드 정렬이 없다(등록 순서) — 28장(1440 에서 10줄 · 페이지 3,912px)에서 문제 있는 법인을 훑어 찾아야 한다 | 정렬(문제 우선 · 알람 · 사용률 · 이름) 또는 ‘문제 있는 법인만’ 단추. |
| I3 | 개선 | 카드에 ‘확인 대상 호스트 N · 조치 필요 VM N’ | `byVc` 에 이미 오는 값 — 새 수집 없음. |
| I4 | 개선(접근성) | 카드가 `role="button"` 인데 그 안에 단추 2개(호스트 → · VM →) | 키보드 Enter 는 동작(확인). 화면 낭독기에서 안쪽 단추가 묻힐 수 있다 — **추정**(낭독기로 확인하지 않음). |
| F1 | 기능 | 고른 법인 기억 — 새로고침 · 주소 공유 | 범위는 화면 상태에만 있다(`tabFilters` — `useState`). 복수 선택과 함께면 가치가 크다. |
| F2 | 기능 | 법인 묶음 보기 — 한 법인의 서비스 둘(예: 이름에 IRS 가 붙은 쌍)을 나란히 · ‘다빈치 \| IRS’ 구분 | 분류 규칙(`isIrs` — 이름에 IRS)은 이미 코드에 있다. 28장 → 14묶음. |

주입으로 본 것 중 **결함이 아닌 것**: 실패한 법인 카드의 배지 글자 ‘error’ 는 내가 주입한 가짜 상태값이었다(실제 값은 connected · unreachable · pending · maintenance · disabled). 콘솔 404 1건도 주입한 법인 id 로 상세를 연 탓이다.

- **바로가기 찾기 칸(사용자 지시 2026-11-18)**: `PlatformHub` 의 바로가기 줄 맨 앞에 `SearchBox`(공용 컴포넌트 — 예전 버전이 쓰던 것). 일치 규칙은 카드와 **같은 함수** `platformText.vcMatches`
  (공백 구분 여러 낱말 모두 포함 · 대소문자 무시 · 부분 일치 — 이름 · id · 도시 · 국가 · 리전 · 버전) — ‘AA’ 는 ‘AAA’ · ‘AAB’ 를 모두 찾는다. 새 판정을 만들지 않는다.
  찾기 글자는 위쪽 공용 검색(`q` — 호스트 · VM 이름까지 찾고 VM 이름 검색 표를 띄운다)과 **따로 든다** — 같은 상태를 쓰면 법인을 찾으려다 VM 검색 표가 뜬다.
  카드 화면(`VCenters`)에도 넘겨 카드를 같이 좁힌다(선택이 없을 때). 선택(켠 법인)이 있으면 칩만 좁히고 카드는 선택 그대로 · 켠 칩은 일치하지 않아도 남긴다(무엇을 골랐는지 잃지 않게).
  숫자 3장 · 서버 호출은 바꾸지 않는다(찾기는 범위가 아니다 — v2.958 규칙 그대로). 일치 0곳이면 ‘‘zz’ 가 든 법인이 없습니다’ 한 줄 + 칸은 남긴다(v2.401 — 찾기 칸까지 사라져 지울 수 없던 결함을 되풀이하지 않는다).
  탭을 옮기면(Hypervisor · Virtual Machine) 찾기 글자는 그대로 두되 그 탭 본문에는 걸지 않는다(칩만 좁힌다). 400px 에서는 찾기 칸이 한 줄을 다 쓴다(44px).

## 8. 고침(2026-11-18 13:23 · 13:25 사용자 지시) — 앞 절의 해당 내용을 대신한다

> (13:23 · 위 숫자 3장 캡처) "순서를 하이퍼 바이저와 VM 을 바꿔줘"
> (13:25) "메뉴 이름을 Pysical 서버를 Pysical Server 라고 변경해줘"

### 8-1. 위 숫자 3장의 순서 — vCenter · **Virtual Machine** · **Hypervisor**

- 지금: vCenter · Hypervisor · Virtual Machine(`web/src/views/platform/platformText.js:16` `PLATFORM_TABS` · `entityTabs()`(`:172` — 3장을 만드는 함수가 제 순서를 따로 적어 둔다: `:178` vcenters · `:188` hosts · `:197` vms)).
- 시안: Hypervisor 와 Virtual Machine 의 자리를 바꿨다 — 캔버스 ① ② ③ ④ ⑥ ⑦ ⑧ ⑨ 전부(⓪ 은 지금 화면 캡처라 그대로).
- 사이드바의 순서는 이미 Virtual Machine · Hypervisor 다(`topMenu.js` ‘서버’ 묶음) — 위 숫자 3장이 그 순서와 같아진다.
- 구현 메모(정정 — 처음에 ‘`PLATFORM_TABS` 의 순서만 바꾼다’ 고 적었으나 틀렸다): **두 곳을 함께** 바꾼다 — `PLATFORM_TABS`(`:16`)와 `entityTabs()` 의 반환 순서(`:178` ~ `:197`). 한쪽만 바꾸면 위 숫자 3장은 그대로다(키 `vcenters` · `hosts` · `vms` 와 주소는 그대로). 순서를 고정한 테스트(`platform/platformText.test.js` · `audit2741j.test.js`)를 고친다. 400px 의 3칸 줄 · 분해 줄(`ph-parts-narrow`)도 같은 배열을 쓰므로 함께 바뀐다 — Chromium 400 으로 확인한다.
  바뀌는 것은 **보이는 순서뿐**이다 — vCenter 카드의 ‘호스트 →’ · ‘VM →’ 이동, 드릴다운(vCenter → 호스트 → VM)은 그대로다.

### 8-2. 메뉴 이름 — ‘Physical Server · Baremetal’ → **‘Physical Server’**

- §1 의 읽기(‘Pysocal 서버’ → ‘Physical 서버’)와 §5 ⑧ · §6 의 ‘Physical 서버’ 는 **이 지시로 바뀌었다**: 새 이름은 **‘Physical Server’**(‘Pysical Server’ 를 오타로 읽음 — 원래 이름에서 뒤의 ‘· Baremetal’ 을 뗀 것).
- ⚠ **이름이 같은 메뉴가 두 곳이 된다**: 서버 › Physical Server(`topMenu.js:38` `bm` — 구분이 Baremetal 로 고정) · 자원관리 › Physical Server(`topMenu.js:68` `sa` — 구분 전체). 둘 다 같은 도구(`serveranalysis`)다. v2.994 에 ‘· Baremetal’ 을 붙인 것이 이 둘을 가르기 위해서였다(`topMenu.js:37` 주석).
  코드에서 메뉴 이름이 서로 달라야 한다는 검사나 이름으로 항목을 찾는 곳은 찾지 못했다(`topMenu.test.js` · `sidebar/*.test.js` · `topMenu.js` · `sideMenu.js` 를 봄 — 항목은 `id` 로 가린다). 기능은 깨지지 않지만 **사람이 헷갈릴 수 있다** — 메뉴 편집 · 기능 사용 현황에서는 묶음 이름(서버 › · 자원관리 ›)이 함께 보여야 가려진다.
- 구현 메모(§6 의 ‘Physical 서버’ 항목을 대신): `topMenu.js:38` 의 `label` 을 `'Physical Server'` 로 — `id` · `tool` · `seg` 는 그대로. 같이 고칠 곳은 §6 과 같다(`featureUsageText.test.js:26` · `topMenu.test.js:38,51,52` · `sidebar/sideMenu.test.js:110` · `tools/HardwareTools.jsx:651,665` · 주석 `topMenu.js:17,37` · `docs/rules/web.md:879`).
  `HardwareTools.jsx:651` 의 안내 글은 ‘서버 › Physical Server 메뉴는 Baremetal 로 고정입니다 — 다른 구분은 자원관리 › Physical Server 에서’ 처럼 **묶음 이름을 앞에 붙여** 두 메뉴를 가린다.
- 컨펌 질문 ⑧(다시): 이름이 같은 두 메뉴를 어떻게 가릴지 — **그대로 둔다(기본 · 사용자 지시대로)** / 자원관리 쪽 이름을 바꾼다 / 서버 쪽 항목을 없애고 자원관리 것 하나만 둔다.
