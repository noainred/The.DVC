# 규칙 — 웹 화면·메뉴·표·문구 규약

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: web/src/ 전반(메뉴·사이드바·표·문구·드롭다운·게시판)

## 목차

- (원래 895행) 상단 메뉴 2단화 — 탭 규칙은 `.topbar .tabs .tab` 으로 한정한다
- (원래 904행) 1600px 이상에서만 상단 메뉴를 브랜드행 한 줄에 합친다 — 임의 폭에서 합치면 메뉴가
- (원래 935행) v2.725 — 상단 메뉴는 대메뉴 10개 + 하위 메뉴 줄(시안 A '2단 탭')이고, 표는 `web/src/views/topMenu.js` 하나다
- (원래 948행) v2.726 — 메뉴는 좌측 사이드바이고, 계정별 메뉴(내 메뉴 > 배포 메뉴 > 포탈 기본)는 서버에 저장한다
- (원래 1192행) 역할별 ‘도구별 접근’ 표는 특수기능 카탈로그 전체를 쓴다 — 여기에 필터를 붙이지 말 것
- (원래 1227행) 사용자별 특수기능 권한 — '허용 목록' 은 거부 목록과 반대 방향의 성질을 가진다
- (원래 2688행) 리포트 표(`.rpt-wrap`)의 숫자칸·계열명칸은 단어 중간에서 쪼개지 않는다
- (원래 2820행) 웹 폴링 뷰 오류 처리
- (원래 3011행) `text-transform: uppercase` 를 앱 텍스트에 걸지 말 것 — 제품명·단위의 대소문자는 정보다
- (원래 3021행) 표의 상한(`limit`)과 최소폭(`minWidth`)은 `STable` 이 소유한다
- (원래 3044행) 값이 없으면 단위를 붙이지 않는다 — `web/src/views/unitText.js`
- (원래 3047행) 웹에도 `numOrNull` 이 있다
- (원래 3052행) Ping 추이의 '측정 없음' 을 한 문구로 덮지 말 것
- (원래 3106행) 화면 문구에 백틱 금지는 전수 스윕이 고정한다
- (원래 3119행) 그리드·플렉스 자식의 `min-width: 0` 은 한 폭만 재면 놓친다
- (원래 3453행) 로딩 표시의 '요청자' 는 서버가 기록한 로그인 계정이 먼저다
- (원래 4643행) Optimization(`#/tools/waste`) 화면은 시안 A 배치다 — 계산은 `views/tools/wasteViewText.js` 하나
- (v2.764 추가) ESXi 호스트(`#/hosts`) 화면은 시안 B '이상 우선' 배치다 — 판정은 `views/hostTriage.js` 하나
- (v2.805 추가) ESXi 호스트 화면의 '엑셀 수준 상세' — 열 묶음 9개·점검 열은 `views/hostChecksText.js` + 서버 `/hosts/checks` · 상세는 전체 페이지 `#/hosts/<id>`(모달 구성요소 공용)
- (원래 5663행) v2.708 — 드롭다운은 공용 `Select`·`DataList` 하나다(자동 정렬)
- (원래 5801행) 특수 기능 화면(v2.679) — 표시 이름·설명·개발 단계는 '덮어쓰기' 이고 키는 그대로다
- (원래 5848행) 접속 공지 팝업 · 게시판(v2.722)
- (원래 5853행) 게시판 답글·공감(v2.723)
- (원래 5868행) 상단 메뉴에서 특수 기능으로 옮긴 화면은 옛 주소를 살린다

## 본문

- ⚠⚠ **상단 메뉴 2단화 — 탭 규칙은 `.topbar .tabs .tab` 으로 한정한다**(v2.556, 같은 핸드오프 §0):
  `className="tab"` 은 앱 **전역에서 일반 버튼**으로도 쓰인다(접속확인·필터 초기화·CSV 선택·
  집계 단위 … 수십 곳). 전역 `.tab` 을 밑줄 스타일로 바꾸면 그 버튼들이 전부 테두리 없는 글자가
  된다. Chromium 으로 확인했고(전역 `.tab`: radius 8px·active 파란 채움 / 헤더 탭: radius 0·청록
  밑줄) `web/src/shellStyles.test.js` 가 CSS 소스로 그 계약을 고정한다(주석을 먼저 제거해 검사).
  · **브랜드 행의 `flex-wrap: wrap`** 이 좁은 폭 가로 넘침의 해법이다 — 이 셸은 v2.555 까지
    400px 에서 **628px** 로 넘쳤고(원인: `status-pill`·`user-box`) 2단화로 0 이 됐다.
  · 상태 칩 내용·사용자 메뉴 동작은 **그대로 두고 톤만** 바꿨다(모노·자간·배경). 하단 상태바도
    칸 개수·내용은 그대로다.
- ⚠⚠ **1600px 이상에서만 상단 메뉴를 브랜드행 한 줄에 합친다 — 임의 폭에서 합치면 메뉴가
  잘린다**(v2.572, 사용자가 캡처와 함께 "빨간색으로 표시된 부분에 있는 메뉴를 노란색 부분으로
  이동해줘, 버전명/메뉴/로그인 사용자가 1줄로 깔끔하게 보이게 해줘" 요청 — v2.556 의 2행 레이아웃
  에서 행1(로고~버전~여백)과 행2(메뉴 13개) 사이 빈 공간을 메우는 것):
  - **`<nav className="tabs">` 는 이제 JSX 상 `.tb-brandrow` 의 자식이다**(`App.jsx`) — 예전에는
    brandrow 뒤의 형제 블록(행2)이었다. 시각적 순서는 CSS `order` 로만 정한다(마크업 순서와 무관).
  - ⚠⚠ **`flex-wrap: wrap` 은 줄바꿈 여부를 '줄어든 뒤 크기' 가 아니라 각 아이템의 hypothetical
    size(= flex-shrink 적용 전의 flex-basis)로 판단한다.** `.topbar .tabs` 에 `flex:1 1 auto` 를
    주면 `min-width:0` 로 줄어들 수 있는데도 **줄어들기 전 전체 콘텐츠 폭**이 줄맞춤 판정에 쓰여
    옆 칸(user-box)이 다음 줄로 밀려난다(1440px 실측 — 메뉴는 줄어들 수 있었는데 옆 칸이
    튕겨나갔다). **`flex: 1 1 0%`**(flex-basis 0%)로 hypothetical size 를 0 으로 만들어야
    한 줄에 남는다 — `auto` 로 되돌리지 말 것.
  - ⚠⚠ **미디어쿼리는 특정도를 올리지 않는다 — 특정도가 같으면 소스에서 나중 규칙이 이긴다**
    (조건이 참이어도). `.topbar .tabs {...}` 미디어쿼리 블록을 그 선택자의 **기본 규칙보다 앞에**
    두면(v2.572 초판의 실제 결함) 1600px·1920px 에서도 기본 규칙에 덮여 메뉴·사용자칩이 여전히
    다른 줄로 떨어졌다(실측으로 확정). 미디어쿼리는 그 선택자를 건드리는 **모든 기본 규칙 뒤에**
    배치할 것.
  - **1600px 미만(1440px·400px 포함)은 v2.556 그대로 2행**이다 — `.topbar .tabs { flex:1 1 100%; }`
    가 기본값으로 메뉴를 독립된 줄로 떨어뜨린다. **경계는 추측이 아니라 실측**이다 — 2400px
    뷰포트(축소·확장 왜곡이 없는 폭)에서 로고 206.8px + 탭 13개 실제 콘텐츠폭 985.39px +
    상태칩 123.3px + 사용자칩 164.0px + gap(14px×3) + padding(20px×2) = **1561.55px**. 1440px
    에서 강제로 한 줄에 넣으면 `nav.scrollWidth(985) > nav.clientWidth(864)` 로 탭 2개
    ('인사이트'·'설정')가 **스크롤 없이 안 보이게 잘린다** — 그래서 40px 여유를 둔 1600px 를
    썼다. 이 숫자보다 낮춰 되돌리지 말 것(재측정 없이 낮추면 같은 클리핑이 재발한다).
  - **narrow-width 회귀 없음**: A/B 로 확정 — 변경 전 커밋으로 되돌려 400px 헤더를 재빌드해
    스크린샷을 비교하면 **바이트 단위로 동일한 3줄 패턴**(브랜드+상태칩 1줄, 사용자칩 2줄, 메뉴
    3줄+가로스크롤)이었다. `.tb-brandrow` 의 `flex-wrap: wrap`(v2.556 의 400px 안전망)은 손대지
    않았다 — 1600px 미만에서는 이 안전망이 그대로 작동한다.
  - `shellStyles.test.js` 의 기존 7개 계약(탭 선택자 범위·전역 `.tab` 스타일·brandrow
    flex-wrap·`.topbar .tabs` overflow-x:auto 등)은 전부 무수정으로 통과 — 이번 변경은 이
    계약들과 독립적인 **폭 조건부 순서 재배치**다.
- ⚠⚠ **v2.725 — 상단 메뉴는 대메뉴 10개 + 하위 메뉴 줄(시안 A '2단 탭')이고, 표는 `web/src/views/topMenu.js` 하나다**
  (사용자 요청 메뉴 재구성 + Claude Design 시안 https://claude.ai/artifact/HMEPTddM42sLXFikvQX1eq · 업그레이드는 설정 하위. 회귀 `web/src/views/topMenu.test.js`):
  · 화면을 새로 만들지 않는다 — 하위 메뉴는 기존 탭(`#/<tab>`)이나 특수 기능 도구(`#/tools/<k>`)를 가리킬 뿐이다. **탭 id·도구 키는 그대로**
    (해시 라우팅·북마크·toolsDenied 가 쓴다). 옛 주소(#/hosts 등)는 그대로 열린다.
  · ⚠ **App 의 TABS 에 탭을 더하면 MENU_GROUPS 에도 넣을 것** — 빠진 탭은 메뉴로 갈 길이 없다(테스트가 두 집합을 대조한다).
  · 지금 위치는 `locate(tab, hash)` 하나가 판정한다 — 특수 기능 카드로 연 도구도 그 도구가 속한 메뉴가 켜진다. 물리 서버는 서버 분석의
    셋째 주소 조각 `baremetal`(`#/tools/serveranalysis/baremetal/<하위 탭>`)이고 서버 분석은 그 모드에서 구분을 Baremetal 로 고정한다
    (모드가 바뀌면 `key` 로 화면을 새로 만든다 — 하위 탭 훅의 base 가 모드마다 다르다).
  · 노출은 탭 = App visibleTabs, 도구 = `toolVisibility.lockReasonOf`(특수 기능 카드와 같은 판정). 하위 메뉴가 모두 빠진 대메뉴는 숨긴다.
    카탈로그는 첫 번들을 키우지 않게 동적 import 이고, 불러오기 전에는 toolAllowed 만 본다.
  · ⚠ 인증을 끈 목 서버는 화면 쪽 사용자가 언제나 Anonymous 관리자다(App.jsx `!cfg.authEnabled`) — viewer·operator 메뉴는 **인증을 켜고 실제 계정으로**
    확인해야 한다(v2.725 검증: viewer 는 서버·스토리지·네트워크 일부만, operator 는 관리자 전용 도구가 빠진다).

- ⚠⚠ **v2.726 — 메뉴는 좌측 사이드바이고, 계정별 메뉴(내 메뉴 > 배포 메뉴 > 포탈 기본)는 서버에 저장한다**
  (사용자 요청 "상단 1줄과 하위 메뉴 재구성을 좌측 사이드바 구성으로" + "사용자가 자신만의 메뉴 · 슈퍼 관리자는 전체 사용자에게 강제 배포(직접 만든
  사용자에게 강제 적용할지 선택)" · Claude Design 시안 https://claude.ai/artifact/LmmbvpcR9wp9pMWUWmLRu4 · 선택 '전체 검증' · '분류 바로가기 제외'.
  서버 `usermenu/store.js`(순수 정규화 + 파일 `user-menus.json`) · `routes/api/userMenu.js` · 웹 `views/sidebar/`{sideMenu.js,menuEdit.js,
  Sidebar.jsx,MenuEditor.jsx,sidebarIcons.jsx}. 회귀 `server/test/userMenu2726.test.js`(실제 api 라우터) + 웹 `sideMenu.test.js`·`menuEdit.test.js`·
  `shellStyles.test.js`·`topMenu.test.js`):
  · **포탈 기본 메뉴는 여전히 `topMenu.js MENU_GROUPS` 하나**다. 저장 메뉴는 주소(탭·도구+조각)만 담고 라벨·id 는 화면이 기본 메뉴·카탈로그에서
    채운다(`sideMenu.resolveMenu` — 서버는 라벨을 모른다). 모르는 항목은 버리고 `unknown` 으로 센다(지어내지 않는다). `locate`·`visibleMenu`·`entryOf` 는
    groups 인자를 받아 사용자 메뉴에도 그대로 쓴다 — **권한 판정은 바뀌지 않는다**(메뉴에 넣어도 넓어지지 않고, 뺀 화면은 카드·주소로 열린다).
  · ⚠⚠ **저장 모양의 계약**: `{v:1, groups:[{id,label?,tab}|{id,label?,children:[{tab}|{tool,seg?}]}]}` — 같은 항목은 앞의 것만, 빈 그룹은 저장 시 제외,
    상한(그룹 40·항목 400·라벨 40)을 넘으면 400(`field`). 사용자 그룹 id 는 `custom-n`. 특수 기능은 단독 항목(`#/tools`)이다 — 분류 바로가기 하위 메뉴는
    사용자 결정으로 두지 않았다(SpecialTools.jsx 무변경).
  · **배포는 superAdmin 만**(`requireSuperAdmin` — `isSuperAdmin(req.user)`, 범위 superAdmin 도 403 `menuFleetOnly`). `force` 는 직접 만든 사용자의 메뉴를
    `prev`(누가·언제·방식) 로 옮기고 지운다(배포자 자신은 제외) · `keep` 은 건드리지 않는다. 철회(DELETE)는 배포 메뉴만 지운다. 기록 `history` 20건 +
    감사 로그(`user-menu.*`). 대상 수는 로컬 계정 기준이고 AD 계정은 미리 셀 수 없다 — 화면이 말한다. 배포는 '저장된 내 메뉴' 만(바뀐 것이 있으면 버튼 비활성).
  · **새 게이트 이름 `menuFleetOnly`·`requireSuperAdmin` 은 `scripts/api-doc.mjs GUARD_NOTE` 에, 파일은 `archScan KNOWN_CONFIG_FILES` 에 등재했다.**
    상태가 아니라 설정 파일(백업 감시 대상)이다. 손상이면 `preserveCorrupt` + 빈 저장소(저장분도 `safeMenu` 로 재정규화해 읽는다).
  · **사이드바 셸**: full 236px / rail 64px(hover·focus-within 플라이아웃 — `.sb-nav` 가 `overflow:visible` 이어야 하고 `.sb` 에 backdrop-filter·transform 을
    걸지 말 것) / drawer(<720px, 닫히면 `visibility:hidden`). 높이는 App 이 ResizeObserver 로 잰 `--topbar-h`·`--statusbar-h`(숫자를 박지 않는다).
    `localStorage ui.sidebar`('rail'|'open', try/catch) · 저장값 없으면 1200px 미만은 레일. **CSS 는 `.sb`·`.me`·`.app-body` 아래로만**, 전역 `.tab` 그대로,
    uppercase 금지 — `shellStyles.test.js` 가 고정한다. v2.556·v2.573·v2.725 의 상단 메뉴 규칙(`.topbar .tabs`·`.subtabs`·1600px 한 줄)은 지웠다.
  · 편집 창(`MenuEditor`)의 '바뀐 항목' 은 `menuEdit.changeCount`(LCS 기반 최소 개수 — 항목 하나를 지우면 1 이지 밀린 뒤 항목 전부가 아니다).
    저장·삭제·복원·배포는 `putJson/delJson/postJson` 이고 403 은 `ErrorBox error={}` 로 권한 안내.
  · ⚠ 정직 기록: Chromium 은 인증을 켠 목 서버(비밀번호 로그인 재정의 `login-policy-users.txt`)에서 admin·noainred(super_admin)·operator·viewer × 1440/400 을
    봤다. AD 계정·실운영 계정 수백 명 규모의 배포는 보지 못했다(대상 수는 로컬 계정 수).

- ⚠⚠ **역할별 ‘도구별 접근’ 표는 특수기능 카탈로그 전체를 쓴다 — 여기에 필터를 붙이지 말 것**
  (`web/src/views/userAdmin/userToolText.js roleToolRows` + `UserAdmin.jsx:11`, v2.573 —
  사용자 지시 "특수기능이 추가되면 자동으로 권한설정 하는 기능에 추가되게 해줘"):
  - **증상**: v2.572 까지 `const TOOL_ROWS = SPECIAL_TOOLS.filter((t) => !t.adminOnly)` 라
    카탈로그 **86개 중 61개만** 표에 나왔다. 빠진 25개는 대부분 **최근에 추가된 기능**
    (통신 점검 v2.552 · 포탈 점검 v2.560 · 엣지 로그 v2.549 · 파트 장애 v2.547 · 스토리지
    증가량 v2.531 …)이라 — **기능을 더할수록 권한 화면이 조용히 뒤처졌다**.
  - ⚠⚠ **그 필터는 틀린 전제 위에 있었다.** `adminOnly` 는 카드 표시 관례이고 접근제어가
    아니다 — v2.555 가 **사용자별 모달에서 이미 확인해 기록해 둔 사실**인데(아래 항목)
    역할 표에는 적용하지 않았다. 실측: `/api/tools/pdu` 의 조회는 `routes/api/pdu.js:52`
    에서 `requirePerm('tools') + fullScopeOnly` 이고 `/api/tools/storage` 도 같다 — operator 가
    주소로 직접 열 수 있는데 **그 도구가 표에 없으니 관리자는 끌 방법 자체가 없었다**.
    빠진 25개 중 **16개가 서버 집행 대상**(`enforcedToolKeys()`)이었다.
  - **고친 방식**: 필터를 없애고 `roleToolRows(catalog)` 하나가 '거르지 않는다' 를 선언한다
    (키 없는 행만 뺀다 — 표에 그릴 수 없다). adminOnly 행에는 사용자별 모달과 **같은 상수**
    (`ADMIN_MARK_LABEL`·`ADMIN_MARK_TITLE_ROLE`/`_USER`)로 ‘관리자 표시’ 배지를 단다.
    ⚠ 두 화면의 **뜻이 반대**라 title 은 따로 둔다 — 모달은 '고르면 보인다', 역할 표는
    '끄면 막힌다'. 한 문구로 덮으면 반대 방향 안내가 된다(테스트가 두 값이 다름을 고정).
  - ⚠ **머리말도 함께 고쳐야 한다** — 예전 문구는 "관리자 전용 도구는 목록에서 제외됩니다"
    였다. 제외를 없애고 문장을 남기면 **화면이 거짓말을 한다**(테스트가 ‘제외’ 0 을 고정).
  - **회귀는 소스까지 검사한다**(`userToolText.test.js`): ① `roleToolRows(SPECIAL_TOOLS)` 가
    실제 카탈로그와 **개수·순서 모두 일치** ② `UserAdmin.jsx` 에 `SPECIAL_TOOLS.filter`·
    `TOOL_ROWS.filter` 가 **0건** ③ 라벨 문자열을 JSX 에 다시 적지 않았는지. 변이 검증 —
    필터를 되살리면 ②가 실패한다(실측 1 failed / 12 passed).
  - ⚠ **나머지 등록처는 이미 자동이거나 테스트가 막고 있다**(v2.573 에 전수 확인):
    사용자별 모달(`SPECIAL_TOOLS` 직접) · (v2.747 V4 트리 배치는 셸과 함께 폐기) ·
    서버 집행 커버리지(`audit2506.test.js:282` 가 `specialToolsList.js` 를 **정규식으로 읽어**
    미선언 0 을 고정 — 새 도구를 매핑도 선언도 없이 추가하면 CI 가 깨진다). 즉 **남은
    수동 작업은 `auth/toolAccess.js` 에 경로를 매핑하거나 사유를 선언하는 것 하나**이고,
    그것은 경로를 사람이 확인해야 하므로 자동화 대상이 아니다(잘못 매핑하면 **엉뚱한 화면이
    막힌다** — v2.506 `capacity-forecast` 사고).
  - ⚠ **화면이 갑자기 '권한이 열린 것처럼' 보인다** — 새로 나온 25행의 operator·viewer 가
    전부 체크돼 있기 때문이다. 이것은 **바뀐 것이 아니라 원래 그랬던 사실이 보이게 된 것**
    이다(서버 동작은 한 줄도 바꾸지 않았다). 머리말이 그 사실을 말한다.

- ⚠⚠ **사용자별 특수기능 권한 — '허용 목록' 은 거부 목록과 반대 방향의 성질을 가진다**
  (`auth/permissions.js effectiveToolAccess`·`auth/toolAccess.js issueFor` + 웹
  `views/toolVisibility.js`·`views/userAdmin/userToolText.js`, v2.555 — 사용자 요청 "특정 사용자는
  특수기능의 특정 기능만 사용할 수 있고, 나머지 기능은 보여주지 않고 싶다 · 스토리지 엔지니어에게
  스토리지 메뉴만". 선택: **허용 목록 모드 추가**(기존 거부 목록 유지) · **사용자 단위** ·
  **아예 숨긴다** · **사용자 관리 화면 안에 확장** · 전진 검증):
  - ⚠⚠ **판정은 `effectiveToolAccess` 하나가 소유한다.** 이 값을 쓰는 곳이 셋이다 — ① 서버 집행
    (`toolGate`) ② 로그인·`/auth/me` 응답(웹 숨김의 근거) ③ 관리 화면. 세 곳이 각자 `mode==='allow'`
    를 해석하면 **화면은 숨겼는데 API 는 열려 있는** 상태가 된다. 그것이 v2.536 이 기록한 사고
    (프론트 탭 조건만 있고 서버 집행이 없었다 — 그건 접근제어가 아니라 '메뉴 숨김' 이다)다.
    `routes/auth.js` 는 두 응답에 **같은 헬퍼(`toolFields`)** 를 쓴다 — 테스트가 그 사실을 고정한다.
  - ⚠⚠ **허용 목록은 '앞으로 추가되는 도구' 도 차단한다**(거부 기본값). 거부 목록은 새 도구를
    자동으로 **허용**하므로 방향이 반대다. 그래서 화면이 그 성질을 문구로 먼저 말한다.
    **`allowed` 가 배열이면 그것이 전부다** — 웹 `toolAllowed` 가 `toolsDenied` 만 보던 판정으로
    되돌아가면 허용 목록이 **화면에서 통째로 무시**되어 숨겨야 할 메뉴가 그대로 보인다.
  - ⚠⚠ **`allow` + 빈 목록을 버리지 말 것.** "이 계정에 특수기능을 하나도 주지 않는다" 는 정당한
    설정이고, 버리면 그 의도가 조용히 **'제한 없음'** 으로 되돌아간다(이 기능 최악의 거짓).
    반대로 `deny` + 빈 목록은 아무것도 막지 않으므로 '재정의 없음' 과 같다 → 저장하지 않는다.
    ⚠ 의존성 키를 `tools.join(',')` 으로 만들지 말 것 — 빈 배열과 `null` 이 **둘 다 빈 문자열**이
    되어 전면 차단 설정이 '재정의 없음' 으로 읽힌다(웹 3곳은 `JSON.stringify` 를 쓴다).
  - **허용 목록은 역할 거부와 합치지 않는다**(교집합 금지) — 관리자가 "이 사람은 이것만" 이라고
    명시한 것이므로 교집합을 내면 **관리자가 준 것이 조용히 사라진다**. 대신 상위 게이트인
    `tools` 기능 권한은 **여전히 필요**하고, 그 조합(권한 없음 + 허용 목록 있음)을 모달이 경고한다.
  - **`off`(재정의 없음)는 저장하지 않는다** — false 를 쌓으면 '한 번 건드린 사용자' 와 '건드리지
    않은 사용자' 를 구분할 수 없다. **admin 은 재정의 대상이 아니다**(관리자 잠김 방지) — 라우트가
    400 + 사유로 거절한다(조용히 무시하면 관리자가 적용된 줄 안다). 없는 계정에도 저장하지 않는다
    (파일에만 남은 유령 항목이 나중에 같은 이름의 계정에 뜻하지 않은 제한을 건다).
  - ⚠ **`SCHEMA_VERSION` 은 올리지 않는다** — 이것은 **권한 키 추가가 아니다**. 파일에 `users` 가
    없으면 `{}` = '재정의 없음' = 기존 동작이라 **조용한 거부가 생길 수 없다**(버전 마이그레이션은
    '행이 곧 부여 목록' 인 권한 키에만 필요하다 — v2.506 규약).
  - ⚠⚠ **숨김/회색 잠금은 축으로 나눈다**(`views/toolVisibility.js toolHidden` 하나가 판정):
    **허용 목록 모드 → 숨긴다**(사용자가 그것을 요청했다) · **거부 목록 모드 → 기존대로 회색 잠금**
    (`SpecialTools.jsx` 주석이 "항목이 많아 숨김보다 회색 잠금이 낫다" 고 적고 있다 — 기존 현장
    화면이 바뀌면 안 된다). **카드 그리드·V4 내비 트리·⌘K 팔레트 셋이 같은 함수를 쓴다** — 한 곳만
    고치면 "내비에는 없는데 팔레트로는 열린다" 가 된다. `visibleTree` 는 `toolShown` 을 주지 않으면
    예전 규칙을 그대로 쓴다(구버전 호출·테스트 호환).
  - ⚠ **`adminOnly` 플래그는 표시 관례이고 접근제어가 아니다**(`specialToolsList.js`). 사용자 예시인
    스토리지 모니터링이 실제로 그렇다 — 조회 라우트는 `requirePerm('tools') + fullScopeOnly` 라
    operator 는 **이미 API 로 읽을 수 있는데 카드만 감춰져** 있었고(실측: viewer 토큰으로
    `/api/tools/storage` 200), 그 플래그 때문에 "스토리지 엔지니어에게 스토리지만" 이 **성립하지
    않았다**. 그래서 관리자가 **명시적으로 허용한** 도구는 그 관례를 넘어 보여 준다
    (`api.js toolExplicitlyAllowed`). **서버 권한은 무엇도 넓히지 않는다** — 조회에 admin 이 필요한
    도구는 열어도 403 이고, 모달이 그 사실을 미리 적는다(무음 실패 금지).
  - ⚠ **허용 목록 모드에서 '회색 카드는 클릭할 수 없습니다' 안내를 쓰지 말 것** — 숨겨서 회색 카드가
    **하나도 없으므로** 그 문구가 거짓이 된다(v2.555 Chromium 판독에서 발견. 수치로는 안 잡혔다).
    판정·문구는 `toolVisibility.gridIntro` 가 소유하고, 허용 0개면 '없습니다 + 조치' 를 말한다.
  - **403 응답에 `toolMode` 를 싣는다** — '역할이 막았다'(deny)와 '허용 목록에 없다'(allow)는
    사용자가 관리자에게 요청할 내용이 다르다. ⚠ 사유 문구에서 **도구 키에 조사(은/는·이/가)를 붙이지
    말 것** — 키가 영문이라 받침 유무를 알 수 없다(괄호 뒤에 붙인다).
  - ⚠ 서버가 막을 수 있는 도구는 `/api/tools/*` 중 **매핑된 경로**뿐이다(v2.506 `toolEnforcement`).
    허용 목록 모드에서는 **'고르지 않은 전부'** 가 차단 대상이므로 그 기준으로 공백을 세어 모달이
    개수를 밝힌다(`enforcementGapNote`). 판정은 `toolEnforcementText.enforcementOf` 하나가 소유한다.
  - 회귀는 `server/test/userTools2555.test.js` 가 **실제 `api` 라우터를 express 에 마운트해
    상태코드로** 고정한다(소스 grep 이 아니다 — v2.506 이 그 실수를 했다) + 웹
    `toolVisibility.test.js`·`userToolText.test.js`.
  - ⚠ **정직 기록 — 실측으로 확인한 것과 못 한 것**: 목 서버(인증 켬)에 viewer 계정 2개를 만들어
    **실제로 로그인해** 확인했다 — 허용 계정은 카드 **2장**(스토리지 2종)만 보이고, 재정의가 없는
    계정은 **83장** 그대로이며, `/api/tools/{ipam,hardware,gpu}` 는 403 · `/api/tools/storage`·
    `storage-growth` 는 200 이었다. 400px 가로 넘침(584px)은 **두 계정이 동일**하고 원인이 기존 셸
    헤더(`status-pill`·`user-box`)라 **이 변경과 무관**하다(A/B 확인). 실제 운영 계정·AD 계정으로는
    확인하지 못했다.

- **리포트 표(`.rpt-wrap`)의 숫자칸·계열명칸은 단어 중간에서 쪼개지 않는다**(`web/src/styles.css`,
  v2.525 — 사용자 신고 "실시간 글자 1줄에 나오게 해줘"): `overflow-wrap: anywhere` 는 **문장 칸**을
  위한 규칙인데 숫자 칸까지 적용돼 `실시간` 배지가 `실/시간` 으로, `Consumed` 가 `Consum/ed` 로,
  `63.6 GB` 가 `63.6/GB` 로 쪼개졌다. `td.right`·`td:first-child` 만 해제하고(공백 줄바꿈은 유지 —
  `nowrap` 으로 굳히면 400px 에서 표가 뷰포트를 넘친다) 배지 자체에 `white-space:nowrap` 을 준다.
  A/B 실측(Chromium): 칸 폭 50px 이하에서 배지가 **2~4줄** 이었고 이제 항상 1줄, `Consumed` 는
  2줄 → 1줄, 문장 칸은 6줄로 그대로다(회귀 없음). **스크린샷·DOM 측정을 해야 보이는 결함이다.**
- **웹 폴링 뷰 오류 처리**: 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 ErrorBox로 갈아치우지 않는다 — `if (error && !data)`일 때만 전체 오류, 그 외엔 배너(고RTT에서 대시보드 깜빡임 방지). 스코프(파라미터) 변경 시 usePolling이 직전 데이터를 비워 이전 스코프 데이터 표시를 막는다.
- ⚠⚠ **`text-transform: uppercase` 를 앱 텍스트에 걸지 말 것 — 제품명·단위의 대소문자는 정보다**
  (v2.575 BUG-13. CLAUDE.md 가 v2.508 `kWh`·v2.550 `디스크 busy` 에 **두 번** 겪고도 그때마다
  **개별 라벨만** 고쳐(한글로 바꿔 우회) 구조를 남겨 둔 탓에 세 번째가 왔다):
  Chromium 전수 판독(1440px·9화면)에서 **11건**이 실제로 새고 있었다 —
  `vCenter→VCENTER` · `Cores→CORES` · `ESXi→ESXI` · `vCore→VCORE` · `vCPU→VCPU` ·
  `서버 Uptime→UPTIME` · `수집 서버(edge)→(EDGE)`. 제거한 선택자는 `thead th`(전역·181개 표)·
  `.kpi .label`·`.statusbar .sb-label`·`.section-title`·`.collector-diag-path-label` 다.
  한글에는 대문자화가 **무연산**이고, 대문자는 글자가 더 넓으므로 제거는 표를 **좁히는** 방향이라
  가로 넘침 위험도 없다('작은 라벨' 느낌은 `letter-spacing` 이 유지한다).
  ⚠ **수치로는 안 잡힌다 — 스크린샷을 읽어야 보인다.** `test/audit2575.test.js` 가 다섯 선택자를 고정한다.
- ⚠⚠ **표의 상한(`limit`)과 최소폭(`minWidth`)은 `STable` 이 소유한다**(v2.575 BUG-19·23/IMP-12):
  · **`limit` 은 정렬 뒤 자른다.** 호출부에서 `rows.slice(0, N)` 으로 먼저 자르면 표가
    '전체를 정렬한 상위 N' 이 아니라 **'앞 N 을 정렬한 것'** 이 된다 — 열을 눌러도 원래 순서의
    앞 N 안에서만 정렬되므로 **오류 없이 틀린 표**다(v2.556 이 `DataTable` 에 같은 이유로 넣은 규약인데
    `STable` 에는 수단이 없어 호출부 6곳이 먼저 자르고 있었다). **뺀 개수는 호출부가 말한다**(조용한 상한 금지).
  · **`minWidth` 를 주면 컴포넌트가 가로 스크롤 래퍼까지 함께 만든다.** 래퍼만 있으면
    `table{width:100%}` 때문에 브라우저가 스크롤 대신 **열을 짜부라뜨리고**(400px 에서 행이 세로로
    길어진다 — 넘침은 0px 이라 **수치로는 안 잡힌다**), `minWidth` 만 있으면 **페이지가 가로로 밀린다**.
    이 짝을 손으로 맞추다 한쪽을 빠뜨리는 것이 반복 사고라 컴포넌트가 둘을 묶는다. 이미 스크롤
    래퍼 안이면 `wrap={false}`.
- ⚠ **값이 없으면 단위를 붙이지 않는다 — `web/src/views/unitText.js`**(v2.575 BUG-20):
  `— ℃` · `— MB` · `—%` 는 **0 처럼 읽힌다**(v2.534 가 전산실 온도에서 겪은 것과 같은 유형이
  다른 화면 9곳에 남아 있었다). `${v ?? '—'}${단위}` 를 새로 쓰지 말 것.
- ⚠ **웹에도 `numOrNull` 이 있다**(`web/src/numOrNull.js`, v2.575 — **여덟 번째 재발**):
  서버 `util/numOrNull.js` 와 **같은 규칙**이고 테스트가 두 구현을 같은 입력으로 대조한다(웹은
  서버 소스를 import 할 수 없다 — 번들 경계). v2.575 실측 재현 — 연결 끊긴 ESXi 호스트가
  vCenter 개요 표에서 **`흡기온도 0℃ · CPU 0% · MEM 0%`**(정답은 전부 `—`), 처리량을 재지 않는
  Unity·VPLEX·PowerStore 노드가 **`0 bps`**(= '트래픽 없음' 이라는 거짓). 둘 다 **오류 없이 틀린 값**이다.
- ⚠ **Ping 추이의 '측정 없음' 을 한 문구로 덮지 말 것**(`web/src/views/pingEmptyText.js`, v2.575 BUG-16):
  폴러 전역 꺼짐 / 대상 비활성 / 마지막 측정이 조회 기간 밖 / 첫 측정 대기는 **조치가 전부 다르다**
  (앞 셋은 **기다려도 안 된다**). 판정 순서가 계약이고 `waiting` 플래그가 그것을 들고 있다 —
  실패 판정들 **뒤**에 '기다리면 된다' 를 둔다(v2.509·v2.517 규약).

- ⚠⚠ **화면 문구에 백틱 금지는 전수 스윕이 고정한다**(`web/src/views/uiText.test.js`, v2.576 —
  **여섯 번째 재발**): `BoldText` 는 `**강조**` 만 해석하므로 백틱은 **화면에 글자로 보인다**.
  v2.439·v2.440·v2.505·v2.545·v2.553 에 다섯 번 기록하고도 그때마다 **그 파일 하나만** 고쳤고
  (v2.553 테스트는 `settingsCheckText` 만 검사한다) v2.576 에 **6곳**이 남아 있었다 —
  `sanHealthText.cmdNote`(BoldText) · `bulkIoText.tokenHint`(plain) ·
  `UnityCapacityPlanPanel` 의 `sub` prop(plain) · `CurrentUsersSettings`(BoldText) ·
  `curUserText.agentGuide` 2줄(`<li>{g}</li>`). 값 인용은 **홑화살괄호 `‘ ’`** 로 한다.
  · 검출은 **이스케이프된 백틱**(앞선 백슬래시 연속 개수가 **홀수**)이다 — `` `${sel}\` ``
    (백슬래시 짝수 = Windows 경로)는 대상이 아니다.
  · ⚠ **홑따옴표 문자열 안의 백틱까지 정규식으로 잡으려 하지 말 것** — 중첩 템플릿 리터럴
    (`` `평균 ${x == null ? '—' : `${x}%`}` ``)에서 **오탐 30여 건**이 났다. 오탐이 있는 스윕은
    곧 무력화된다(현재 그 형태는 0건).

- ⚠⚠ **그리드·플렉스 자식의 `min-width: 0` 은 한 폭만 재면 놓친다**(`.vc-grid`/`.vc-card`,
  v2.576 — 특수기능·vCenter 목록·IPAM·하드웨어 **5화면이 공유**하는 그리드):
  카드 하나(`스토리지 모니터링`)의 설명문이 **줄바꿈 지점 없는 min-content 456px 토큰**이라
  `min-width: auto` 때문에 트랙을 474px 로 키웠다. 실측 — **1920px 0px / 1440px 115px /
  1280px 0px**(3열이 되며 트랙이 우연히 충분) **/ 400px 99px**. 표준 폭에서 넘치는데 더 넓은
  폭에서는 0 이므로 **여러 폭을 재야 보인다**.
  · 수정은 **`min-width: 0` 과 `.vc-card .muted { overflow-wrap: anywhere }` 둘 다** 필요하다 —
    전자만 두면 텍스트가 카드를 넘쳐 잘리고, 후자만 두면 `auto` 트랙이 여전히 max-content 다.
  · ⚠ `overflow-wrap: anywhere` 는 **설명문 전용**이다. 숫자 칸에 걸면 `63.6 GB` 가 `63.6/GB` 로
    쪼개진다(v2.525 `.rpt-wrap` 실제 사고).
  · 함께 고친 표 3곳 — `DatastoreUsage.DsVcTable`(400px **201px** 넘침 · 한 화면에 11개) ·
    `RelayTopoTool` 2곳(**613px**). 6열이어도 `minWidth` 가 없으면 넘친다(v2.575 스윕은 7열
    이상만 봤다) — **열 수로 면제하지 말 것.**

- **로딩 표시의 '요청자' 는 서버가 기록한 로그인 계정이 먼저다**(v2.585, `perfClientLogic.requesterText` +
  `TaskWho.jsx`, 사용자 요청 "요청자 ID 가 포탈 내부에서 사용하는 ID 말고 job 을 실행한 사용자 ID 로 표시"):
  `GET /perf/req-status` 가 소유자 검사를 통과한 항목에 `user` 를 싣고, 서버 확인 전에는 이 브라우저의 로그인
  계정을 쓴다(요청은 이 탭이 보냈다). 둘 다 없으면 이름을 지어내지 않는다. ⚠ 내부 추적 ID(`w…-…`)는 **대체가
  아니라 보조**다 — 서버 성능 측정·라이브 로그와 대조하는 유일한 열쇠라 작게 남긴다(지우지 말 것).
- **Optimization(`#/tools/waste`) 화면은 시안 A 배치다 — 계산은 `views/tools/wasteViewText.js` 하나**(v2.651, 사용자 요청 "시안 A 적용해줘" —
  디자인 캔버스 `Optimization 시안`): 회수 가능 스토리지 = 꺼진 VM 점유(committed) + Thin 여유(uncommitted) — 겹치지 않는 두 양의 합이고 **추정**이라 적는다.
  꺼진 기간 분포는 `/tools/waste/off-since`(꺼진 VM 전량), 법인별 점유는 `byVcenter`(절단 전 전체) 기준 — 화면에 실린 상위 300대로 세지 말 것
  (부분 합이 된다). 기간 칩의 **표 필터**는 표시 목록 기준이라 개수와 다를 수 있다(문구가 '표시 목록 N대 중' 으로 말한다). 0 인 분포 칸은 중립색(`zero`).
  탭 주소(`#/tools/waste/<탭>`)·검색·엑셀 내보내기·근거 리포트·스파크라인은 그대로다. '확인 필요 후보 · 포탈은 VM 을 지우지 않습니다' 안내를 지우지 말 것(v2.505 규약).
- **ESXi 호스트(`#/hosts`) 화면은 시안 B '이상 우선' 배치다 — 판정은 `views/hostTriage.js` 하나**(v2.764, 사용자 요청 "B 안으로 해줘" — 디자인 캔버스 `ESXi 호스트 화면 시안`):
  확인 대상 = 점검 + 끊김·무응답 + **CPU > 90**(서버 high-cpu 경보와 같은 기준 — 사용자 선택, `hostTriage.test.js` 가 soapClient 의 비교식과 대조한다). 상단 카드 숫자·표 탭·구간 막대·클러스터 타일은
  전부 같은 `hostReasons`/`cpuBucket` 을 쓴다 — 화면에서 따로 세지 말 것. 사용률은 `hostUsagePct` 로 읽고 못 읽은 호스트는 '미수집' 구간(0% 아님)·평균 제외.
  CPU % 는 정격 용량 대비라 100 을 넘으므로 '100% 초과' 를 별도 구간으로 둔다. 클러스터 키는 (vCenter, 클러스터)다(동명 클러스터 분리). 예전 KPI 카드 6장의 값(전원 On/Off·코어·vCore 비율·메모리·전력·ESXi 버전)은
  요약 띠로 옮겼을 뿐 빼지 않았다. 타일은 1440 에서 12개·720px 이하 4개부터(400px 에서 표까지 스크롤이 길었다 — Chromium 판독).
- **v2.805 — ESXi 호스트 화면의 '엑셀 수준 상세'(승인 시안 https://claude.ai/artifact/EFh5K3UDzuGpUpqVyqXPf1)** — 요약 8칸 · '지금 확인할 것' 카드 3 + 칩 10 · 호스트 목록 표 30열 9묶음 · 전체 페이지 상세(사용자 선택). 회귀 `hostChecksText.test.js` + `server/test/hostChecks2805.test.js`:
  · 판정은 셋뿐이다 — 확인 대상(카드·탭)은 `hostTriage.js` 그대로, 구성·보안(열·칩 코드)은 `hostcfg/hostCfgText.js hostCfgFindings`, iDRAC 부품·최근 재부팅·Veeam·VM 할당 합은 서버
    `GET /hosts/checks`(`vcenter/hostChecks.js` — 호스트·클러스터 엑셀과 같은 함수 `hwSummary`·`analyzeReboots`·`recentBackupYn`). 화면에서 따로 세지 말 것. 칩 수는 그 묶음을 못 읽었으면 **null('—')** 이지 0 이 아니다.
  · `/hosts/checks` 는 무거운 집계(로그 DB·iDRAC 등록부·Veeam 대조 — 서버 60초 캐시, 범위·판본 키)라 **마운트 1회 + 필터 변경 + '다시 읽기' 버튼**만 — 15초 폴링(/hosts)에 섞지 말 것.
    묶음 권한은 엑셀과 같은 `accessOf`(구성 점검 도구 → 재부팅 · 관리자 판본 → iDRAC) — 권한 없는 묶음은 키 자체가 없고 iDRAC 열은 그때 빠진다.
  · 열 묶음 끄기는 `localStorage ui.hosts.cols`(try/catch · 모르는 키는 버림) — '기본' 묶음은 끌 수 없다. 표는 `DataTable` + `.ht-table`(첫 열 sticky · nowrap · 래퍼가 스크롤 컨테이너).
  · 상세는 `#/hosts/<id>`(Hosts.jsx 가 해시 둘째 조각으로 가른다 — 탭 id 는 그대로 `hosts`). **모달과 같은 구성요소**(`EntityDetail.jsx` 의 `HostBasicRows`·`HostCfgSection`·`PerfcSection`·
    `ClusterCfgSection`·`HostHbaTable` + `HostGpuPanel`·`HostPowerPanel`·`HostMetricButton`·`IdracTrendLinkButton`·`HostVmsModal`)를 export 해 쓴다 — 화면을 복제하지 않는다. 호스트 한 대는
    `GET /hosts/:id`(범위 밖 404 — `/hosts/checks` 를 먼저 등록해 'checks' 가 id 로 잡히지 않게). 정직 기록: 목 데이터 호스트는 NIC 인벤토리가 없어 네트워크 표는 '없음' 문구만 봤다.
- ⚠⚠ **v2.708 — 드롭다운은 공용 `Select`·`DataList` 하나다(자동 정렬)**(`web/src/components/`{Select.jsx,DataList.jsx,selectSort.js}, 사용자 요청 "모든 드랍박스 메뉴를 소팅되서 보이게 하고 앞으로 만들면 소팅"):
  · 날 `<select>`·`<datalist>` 는 eslint `no-restricted-syntax` 와 `selectSort.test.js` 스윕이 막는다. 선택지는 보이는 글자 순(숫자 인식 — vcenter-2 < vcenter-10),
    value ''·'all'·'*'·'__…' 이거나 글자가 '전체·모든·—·(·선택' 으로 시작하거나 `data-pin` 이면 맨 위 고정.
  · **순서가 곧 뜻인 목록**(기간·심각도·단계·권장 먼저·최신 버전 먼저·폴링 중 에이전트 먼저)은 `sort={false}` — 데이터 목록에 붙이지 말 것(사용자 선택 '의미 순서 유지').
- ⚠⚠ **특수 기능 화면(v2.679) — 표시 이름·설명·개발 단계는 '덮어쓰기' 이고 키는 그대로다**(`server/src/toolcats/`{catalog,settings}.js +
  웹 `views/toolSections.js applyOverrides·buildStageSections·introLine` + `views/ToolNamesStages.jsx`(드로어·설정 화면 공용) + `SpecialTools.jsx`,
  사용자 제공 핸드오프 '특수 기능 화면 재구성'. 회귀 `server/test/toolNames2679.test.js` + 웹 `toolSections.test.js`):
  · 설정 파일은 기존 `tool-categories.json` 에 `stages`(null = 단계 축 꺼짐 — **업그레이드로 자동으로 켜지지 않는다**) · `overrides`(키 → label/desc/stage,
    빈 값은 키를 지운다) · `stageDisplay`(badge|suffix). 단계 색은 `STAGE_COLORS` 팔레트만(서버 400) — 임의 문자열이 style 로 들어가지 않게.
  · 첫 단계가 기본값 — 없는 단계를 가리키면 화면은 기본 단계로 본다(서버는 저장 때 그 stage 를 지우고 경고). 단계 축을 끄면(null) 지정은 남긴다.
  · 카테고리 저장(PUT 에 overrides·stages 없음)은 덮어쓰기를 건드리지 않는다 — `Object.hasOwn(body, …)` 일 때만 바꾼다(테스트 고정).
  · 바꾼 이름은 특수 기능 화면·도구 제목에만 쓴다. ⌘K 팔레트는 원래 이름이다(드로어 안내가 말한다). 원래 이름은 `aka` 로 검색된다.
  · 분류 바 sticky top = 셸 머리 실제 높이 + 8px(ResizeObserver) · 720px 이하는 고정하지 않는다(탭이 여러 줄이라 400px 화면의 1/3 을 가렸다 — Chromium 판독).
  · v2.810: 화면 안 sticky 바의 높이 측정은 `web/src/hooks/useStickyOffset.js` 하나(셸 머리 `useStickyHeadH` · 바 `useBoxHeight` — 셸 머리 선택자 사본 금지).
    Veeam 백업 현황 › Detail 의 일괄 표시 바(`.bk-bulk`)도 같은 규칙 — 머리 아래 sticky · 불투명 배경 · 옆 상세 칸(`.bk-side`)은 바 아래 · 720px 이하 고정 안 함.
    회귀 `web/src/views/tools/bulkSticky2810.test.js`.
- **접속 공지 팝업 · 게시판(v2.722)** — `server/src/bulletin/store.js`(notices.json·board.json, 원자 쓰기·손상 보존·상한 거부) + `routes/api/bulletin.js`
  (`/notices/*`·`/board/*`, 회귀 `server/test/bulletin2722.test.js` — 실제 api 라우터로 역할별 상태코드) + 웹 `views/board/`{Board.jsx,NoticePopup.jsx,bulletinText.js}:
  · 팝업은 **로그인 뒤에만**(App 의 `<Portal>` 옆 — 모든 셸 위) · 폴링 없음 · '보지 않기' 는 브라우저 저장이고 키가 `rev`(id + 수정 시각)라 고치면 다시 보인다.
  · 쓰기 권한: 공지 = admin + 전체 범위 · 글·댓글 = admin·operator(서버 불변조건 '/api 상태변경은 requireRole(admin, operator)') · 수정·삭제 = 작성자 또는 관리자 · 고정 = 관리자.
  · 상단 탭 'board' 를 더하면 V5 `tree.js`(TAB_NAMES·platform) · V6 `menus.js`(TAB_INFO·platform) · `noFilterTabs` 도 함께. 1600px 한 줄 메뉴는 14개에서도 잘리지 않았다(실측 nav scrollWidth == clientWidth).
- **게시판 답글·공감(v2.723)** — 답글은 댓글 배열에 `parentId`(최상위 댓글 id)로 묶는 **한 단계**다(답글에 단 답글은 최상위 아래로 옮기고 `replyTo`).
  답글이 달린 댓글을 지우면 **자리를 남기고**(`deleted` — 내용·작성자 지움, 세지 않음) 마지막 답글이 지워지면 자리도 치운다. 공감은 이름 목록 `likes` 이고
  요청은 상태를 명시한다(`POST …/like {on:true|false}` — 연타·재전송이 두 번 세지 않는다). 응답에는 개수·내 공감·앞 30명만(`likeView`) — `likes` 배열을 내보내지 말 것.
  공감·답글도 쓰기 권한(admin·operator, 서버 불변조건). 옛 board.json 은 그대로 읽힌다(필드 없음 = 공감 0·최상위). 회귀 `server/test/bulletin2723.test.js`(변이 3/3).
- **상단 메뉴에서 특수 기능으로 옮긴 화면은 옛 주소를 살린다**(v2.592 — 사용자 요청 "인싸이트를 특수기능으로
  이동해줘"): 상단 '인사이트' 탭(`views/Insights.jsx`, FinOps 등 7패널)은 특수 기능 카드 **`insights-hub`**
  (`#/tools/insights-hub/<패널>`)가 됐다. ⚠⚠ **기존 카드 `insights`(운영 인사이트 — `tools/InsightsThreats.jsx`)는
  다른 화면이다** — v2.592 초판이 둘을 같은 것으로 보고 옛 주소를 `#/tools/insights` 로 보냈다가 Chromium 판독에서
  엉뚱한 화면이 떠서 잡았다. 도구 키는 바꾸지 않으므로(`toolsDenied` 값) 새 키를 만들었다.
  · 옛 주소 `#/insights[/<패널>]` 는 `hooks/hashTab.js MOVED_TABS`·`movedTabHash` 가 `replaceState` 로 바꾼다
    (App 최초 렌더 + hashchange). **지우지 말 것** — 북마크·공유 링크가 있다. 옮긴 탭이 늘면 이 표에 더한다.
  · 탭 권한(`perm:'insights'`)은 카드의 `perm` 으로 옮겼다 — 데이터 API `/api/insights/*` 는 원래대로 requirePerm.


## 원래 루트 「프론트엔드 회귀 방지」 절


- ⚠⚠ **V4·V5·V6 셸은 지웠다 — 되살리거나 고치지 않는다**(v2.747, 2026-10-20 사용자 요청 "독립셀 version 4,5,6 은 삭제하고
  더이상 수정하거나 업데이트 하지 않도록 변경해줘, 그리고 설정에서 신규 포탈 보기 메뉴 삭제"): `web/src/version_{4,5,6}/` ·
  `views/V4Portal.jsx`(설정 › 신규 포탈 보기)를 지웠다. 화면은 **기본 셸(App 라우터) + 관제 콘솔(`console/`)** 둘이다.
  `server/test/v4Portal2508.test.js` 가 폴더 부활·옛 경로 import·설정 메뉴 부활을 막는다. 새 셸·새 틀을 만들지 말 것.
  - 기본 화면이 쓰던 모듈은 옮겨 살렸다: ⌘K 팔레트 `components/Palette.jsx`·`palette.js` · Overview 보기 모드 `views/overviewMode.js` ·
    로딩 판정 `components/loadState.js`(관제 콘솔) · Summary 기여도 `views/corpContribution.js`. V4·V5·V6 만 쓰던 함수는 함께 지웠다
    (`physicalServersKpi`·`corpTotalLabel`·`modeSpec`·`viewFromHash`·`liveText`·`shouldBanner`).
  - **옛 주소는 버리지 않는다**: `#/v3·#/v4·#/m/…` → `#/overview`, `#/v5/<주소>`·`#/v6/<주소>` → `#/<주소>` (`hooks/hashTab.js legacyShellHash`,
    App 의 `migrateMovedHash` 가 기동·hashchange 때 적용). 남은 셸 플래그 `localStorage ui.shell` 은 기동 시 지운다.
  - ⌘K 팔레트는 V4 메뉴 트리 없이 동작한다 — 분류명은 특수 기능 카테고리 설정(`/admin/tool-categories`, 카드 그리드와 같은 출처),
    탭은 App 의 `visibleTabs`(권한으로 거른 것)를 받는다. **새 도구를 추가할 때 고칠 트리가 없다**(V4·V5·V6 트리 배치 규칙은 폐기).
  - 셸이 사라져도 남는 규칙(v2.508 에서 정한 것):
    - **도구 키(`#/tools/<k>`) 는 어떤 이름 변경에도 바꾸지 않는다** — `permissions.json` 의 `toolsDenied` 값이자 `auth/toolAccess.js` 의
      집행 매핑이다. 옛 이름은 `specialToolsList.js` 의 **`aka` 배열**에 남긴다. 검색 매칭은 `views/toolSearch.js` 하나(카드 그리드 = ⌘K).
    - 새 도구는 `toolcats/catalog.js` 의 PRESET 도 채운다(빠지면 화면에서 '기타' 로 밀린다). 상태를 바꾸는 도구(rma·vm-clone·vmprovision·
      shutdown·diskadd·backup·massdeploy·agent-scans)는 PRESET 의 '운영 작업' 분류에 둔다.
    - **모드 토글은 권한이 아니다**(`views/overviewMode.js`): 권한·데이터 범위·임계값(75/90)은 두 보기가 같다. `localStorage` 는 try/catch.
    - **무거운 API 는 15초 폴링 금지**: `/tools/capacity-forecast`(실측 1.5초)는 120초 이상·마운트 시에만, 고아 VMDK 스캔(`/tools/orphan-vmdk`)은
      폴링 금지(버튼 + 재진입 가드). 목록(`/tools/orphan-vmdk/datastores`)은 스냅샷 memo 라 폴링해도 된다.
    - **'수집 대기' 로 뭉개지 말 것**(`components/loadState.js`, v2.509 — "기다리면 나오는거야?"): pending(기다리면 채워진다)과
      unreachable(기다려도 안 된다)을 합치지 않는다 · 타임아웃·연결 실패는 화면 전체 오류가 아니다(재시도 중) · 수집 주기 숫자를 문구에 박지 않는다.
    - **표 머리글에 영문 소문자 단위를 쓰지 말 것**(uppercase 셸 CSS 에서 `kWh` 가 `KWH` 로 샜다 — 한글 라벨 + 각주).
- **위임(엣지) 수집 환경에서 중앙 화면이 비면 안 된다**(v2.493, 2026-09-12 실제 신고 — 같은 유형이
  v2.381→2.383 에서 이미 한 번 발생했다): 위임 법인 서버는 중앙 레지스트리에 없고, 엣지가 export 로
  **최신 스냅샷만** 올려 보낸다(`collector/agent.js compactSensors` → 중앙 `collector/remoteInventory.js`).
  새 상세/조회 화면을 만들 때 `loadRegistry().find(...)` 로 못 찾으면 **빈 응답으로 끝내지 말고**
  `findRemoteServer(id)` 의 값을 쓸 것 — 이미 그 값을 쓰는 화면이 있는지 먼저 확인한다
  (`routes/admin/idracCore.js /idrac/temps` 의 `s.remote ? s.sensors : getSensorSeries(s.id).latest`,
  `idrac/roomTemp.js`). v2.493 은 iDRAC 상세 센서 탭이 이 확인을 빠뜨려, **같은 서버가 '법인별 온도'
  에서는 52℃ 로 보이는데 상세에서는 '센서 0개·0샘플'** 로 보이던 결함을 고친 것이다. 중앙에 이력이
  없으면 `seriesAvailable:false` 로 밝히고 최신값만 표로 보여준다 — 없는 이력을 1점 차트로 지어내지 않는다.
- **값이 없는 이유를 단정하지 말 것**(같은 v2.493 건): '텔레메트리 미지원' 처럼 원인을 특정하는 문구는
  그 원인을 실제로 확인했을 때만 쓴다. 표본이 0건인 것과 '표본은 있는데 그 지표만 없는 것' 은 다르고,
  조회 실패(404/403)와 '수집 0' 도 다르다. 네 경우를 구분하는 판정은 순수 모듈에 두고 테스트로 고정한다
  (`web/src/views/idrac/sensorText.js`). 조회 오류를 `.catch(() => {})` 로 삼키면 사용자는 원인을 알 수 없다.
- **수집 주기·상한 같은 숫자는 화면에 하드코딩하지 말 것**: API 가 실제 값(`intervalMs` 등)을 주면 그것을
  쓴다. v2.493 까지 센서 탭은 '1분 간격' 을 고정 문자열로 표시해, 주기를 바꾸면 문구가 사실과 달라졌다.

- **스토리지 장비 표의 '장비' 열은 `장비가 보고한 이름` 이 먼저다**(`views/tools/StorageMonTool.jsx`
  `Cell 'device'` + `storageColumns.js sortValue`, v2.530 — 사용자 요청 "'장비' 에 들어가는 데이터를
  hostname 에서 획득한 장비 명을 넣어줘"): Isilon 은 `isi status` 의 클러스터 이름, Unity/PowerStore 는
  시스템·클러스터 이름 — 현장 콘솔에 찍히는 그 이름이다.
  - ⚠ **이것은 v2.515 와 반대 방향이다.** v2.514 까지 스냅샷 이름이 우선이었고, 그래서 '수정' 폼에서
    이름을 고쳐 저장해도 표가 그대로라 사용자가 **"수정하는데 수정사항이 반영되지 않는다"** 고
    신고했다(저장은 성공했다). 원인은 순서가 아니라 **고친 값이 화면 어디에도 안 보였던 것**이다.
    그래서 등록 표시명이 다르면 둘째 줄에 **`등록명 …` 이라고 라벨을 붙여** 보여준다 —
    **이 둘째 줄을 지우면 v2.515 결함이 그대로 되살아난다.**
  - **정렬 값(`sortValue('device')`)을 같은 순서로 유지할 것** — 보이는 글자와 정렬 기준이 어긋나면
    사용자가 '정렬이 틀렸다' 고 본다.
  - **두 줄 모두 폭을 `maxWidth:150` + 말줄임으로 묶는다**(실측: 25자 이름에서 장비 열이
    101→195px). 묶지 않으면 표가 밀려 오른쪽 '작업' 열이 잘린다(v2.403 이 고쳤던 문제의 재발).
    전체 문자열은 `title` 로 남긴다.

- **긴 작업의 '진행 중' 잠금은 그 대상만 잠근다 — 화면 전체를 잠그지 말 것**(v2.529 사용자 신고
  "이 상태에서 수정 버튼 누르면 수정 창이 안떠", `views/tools/StorageMonTool.jsx`):
  스토리지 장비 표의 `수집`·`수정`·`삭제` 가 전부 **전역 `busy`** 로 잠겨 있었다. 한 장비를
  수집하는 동안 **다른 장비의 수정·삭제까지** 죽었고, **왜 안 눌리는지 화면이 말하지 않았다**
  (툴팁도 없어 '버튼이 고장난 것' 으로 보인다). Unity 수집이 v2.526(명령 24개)·v2.528(예산 150초)
  이후 최대 2분을 넘기면서 그 창이 몇 초 → 수 분으로 늘어 드러났다.
  - **'지금 수집' 은 `busyId`(그 장비)만 잠근다.** 전역 `busy` 는 전체 새로고침처럼 **진짜 전역**
    작업에만 쓴다. 버튼 글자를 `수집 중…` 으로 바꿔 무엇이 도는지 보이게 한다.
  - **`수정` 은 잠그지 않는다** — 인증 실패·수집 실패 상황에서 **자격증명을 고치는 것이 바로 그
    순간 필요한 조치**다. 그것을 막으면 사용자는 복구할 길이 없다.
  - **잠긴 버튼은 사유를 말한다**(`title`). 반응 없는 버튼은 '고장' 으로 읽힌다.
  - 같은 패턴을 쓰는 다른 표(SAN 스위치·PDU 등)를 만들 때도 **전역 잠금을 기본으로 삼지 말 것**.

- **법인 전산실 운영 온도는 '보기 전환' 화면이다**(`web/src/views/tools/RoomTemp.jsx` +
  순수 모듈 `roomTempView.js` + 서버 `idrac/roomTempSeries.js roomTempSparks`, v2.534 —
  사용자 제공 클로드 디자인 캔버스 '온도 시각화 10안' 의 **적용안 `2a`**):
  - **범위 플롯 / 매트릭스 / 상황실 월보드** 세 가지를 한 페이지에서 토글한다. 플롯·월보드에서
    법인을 누르면 매트릭스로 넘어가 **흡기 높은 서버 상위 6대**가 펼쳐진다.
  - ★ **판정은 흡기 최고값만** 쓴다(v2.381 부터의 규약). 배기·CPU 는 장비·부하에 따라 정상 범위가
    달라 **임계를 정하지 않고** 값과 **열 안에서의 상대 농도**로만 칠한다 — 두 색 체계를 섞지 말 것
    (상태색은 **판정**, 농도는 **비교**다). 흡기 열에 농도를 쓰면 판정이 사라진다.
  - ★ **흡기를 못 읽은 법인은 `ok` 가 아니라 '판정 불가'(회색)** 다. 월보드 카운트에서도
    `unknown` 을 정상에 흡수하지 않는다(v2.519·v2.523 규약과 같다 — 확인 못 한 것을 이상 없음으로
    칠하는 것이 이 화면이 만들 수 있는 가장 위험한 거짓이다).
  - ⚠ **값이 없으면 단위를 붙이지 말 것** — 월보드 타일이 `— ℃` 로 나오면 0℃ 처럼 읽힌다
    (v2.534 스크린샷 판독에서 발견해 고친 결함. 수치로는 안 잡혔다).
  - ⚠ **'상위 N대' 라고 적었으면 N행이 전부 보이는 높이여야 한다** — `maxHeight:240` 에서 6번째
    행이 잘려 '6대' 라고 해 놓고 5행만 보였다(같은 판독에서 발견).
  - **월보드 스파크라인은 폴링하지 않는다** — 보기를 열 때 `/admin/room-temp/spark` 를 **1회**
    부른다(법인 집합이 바뀔 때만 재조회). **1시간 버킷**만 써서 `samples_hourly` 롤업이 걸리게
    한다 — 법인마다 인덱스 선탐색이라 16곳도 가볍다(CLAUDE.md v2.503: '전 키 1쿼리' 로 합치면
    오히려 느려진다).
  - ⚠ **수집이 없던 시간은 선을 잇지 않는다**(`sparkPath` 가 subpath 를 끊는다). 이으면 그 시간도
    값이 있던 것처럼 보인다. 그리고 `p.avg == null` 을 **먼저** 본다 — `Number(null) === 0` 이라
    `Number.isFinite(Number(v))` 만 보면 결측이 **0℃ 로 둔갑**한다(v2.525 규약. 초판이 실제로
    그랬고 자체 테스트가 잡아냈다).
  - 전체 화면은 **Esc 로 닫힌다** — 버튼만 두면 키보드 사용자가 갇힌다.

- **React 훅은 조기 return 위에서 선언**: `if (!data) return <Loading/>` 같은 조기 반환 뒤에 `useState`를
  추가하면 렌더 간 훅 개수가 달라져 **React #310으로 화면 전체가 크래시**한다(v2.202 사용자 관리에서 실제
  발생 → v2.203 긴급 수정). 뷰에 상태를 추가할 때는 항상 컴포넌트 최상단에 선언할 것.
- **권한 거부(403)는 '오류'로 표시하지 않는다**(v2.398): 403 은 장애가 아니라 정책대로 동작한
  접근 제어다. "오류: forbidden" 으로 보여주면 사용자가 시스템 장애로 오해해 새로고침·재로그인을
  반복하고 장애 문의를 올린다. 공용 `ErrorBox`(오류 표시 단일 지점 — 86개 파일·132곳)가 403 을
  감지해 `components/AccessDenied.jsx`(필요 권한·부여 방법·관리자 요청 문구)로 자동 전환하므로
  **뷰에서 따로 처리할 필요 없다**. 유지 규칙:
  - `api.js` 의 실패 경로는 반드시 `httpFail()` 로 `HttpError`(status·requiredRole/Perm/Owner)를
    던진다. `new Error(reason)` 으로 되돌리면 403 메타데이터가 사라져 안내가 범용 문구로 퇴화한다.
  - 서버에서 새 권한 게이트를 만들 때는 기존 응답 형태를 유지할 것 —
    `{error:'forbidden', requiredRole|requiredPerm}` 또는 `{requiredOwner:true, reason}`.
    이 키가 없으면 화면이 '데이터 범위 제한'으로만 안내한다(틀리진 않지만 부정확).
  - `usePolling` 은 403 을 받으면 그 (path,params) 폴링을 **중단**한다 — 정책 거부는 재시도해도
    결과가 같고, 15초마다 같은 403 을 만드는 것은 서버 로그·감사만 오염시킨다.
  - 문구 로직은 `components/accessDeniedText.js`(순수 함수)에 둔다 — 웹 테스트가 node 환경
    (DOM 없음)이라 컴포넌트 렌더 테스트가 불가하므로 판정·문구는 여기서 회귀로 고정한다.

