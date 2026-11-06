# 설계: 설정 메뉴 재배치(가로 스크롤 없애기)

작성 2026-11-05 · 상태 **구현됨 — v2.905.0**(시안 단계 생략: 사용자 결정 2026-11-05 '버그 수정이나 개선을 위한 작업 진행' → 질문에 '설정 메뉴 바로 수정' · 배치안 '9개 묶음 + 2단' · 검증 '표준').
원래 규칙(설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현 — 2026-11-03 '기억해')에 따라 §1 · §2 를 먼저 조사했고, 사용자가 개선 작업으로 바로 진행하기로 정해 시안 아티팩트는 만들지 않았다(§3 은 질문 창에 보인 글자 미리보기 그대로).

## 1. 요구(사용자 2026-11-05)

- 스크린샷: 설정 1단 탭 줄이 화면 폭(약 1,660px 본문)을 넘어 가로 스크롤바가 생김 — 'DataCenter(법인) · 🖥️ vCenter 관리 · NSX 관리 · Horizon 연결 서버 ·
  🗄 수집 서버 · 🎮 GPU 사용량 수집 · 🔌 원격 접속 서버 · 👤 User Control · 🛡️ Security · AI 검색 · 알림 · 메일 발송 · 특수 기능 카테고리 · 포탈 백업 …' 에서 잘림.
- 원문: "설정에 메뉴가 너무 많아져서 스크롤바가 생기는데, 설정의 메뉴를 클로드 디자인으로 최적화해서 재배치해줘" · "시안 설계해줘"

## 2. 지금 구조(코드 확인 — 2026-11-05 16:42~16:43 KST)

화면: `web/src/views/Settings.jsx`(199줄).
- `SUB` 배열 48개 항목(`{ k, label, C, group?, show?, superOnly? }`) + `GROUPS` 7개(label · desc).
- 1단 탭 줄 = 그룹 없는 항목 + 그룹 대표 버튼(첫 등장 순서). 관리자에게 **19개**(아래 표) — `.vcd-views`(`styles.css:826` — `flex-wrap: nowrap; overflow-x: auto`)라 넘치면 가로 스크롤.
- 활성 그룹이면 2단 줄(들여쓰기 · `rgba(37,99,235,.07)` 패널 · 왼쪽 accent 3px 막대 · `flexWrap: wrap`) + 그룹 desc 한 줄.
- 활성 항목 표시: 1단은 `.login-btn`(accent 채움), 비활성은 `.tab`.
- URL: `#/settings/<k>`(`useHashTab` — `valid: SUB_KEYS`, 기본 `vcenter-admin`). 옛 키 이동은 `hooks/hashTab.js MOVED_SUBS`(현재 `settings/edge-tokens` → `#/tools/edge-tokens` 1건).
- 셸: 기본 셸은 v2.726 부터 **좌측 사이드바(`.sb`)** + 한 줄 상단 바. 설정은 사이드바의 한 항목('설정' — `App.jsx:80` `adminOnly · ownerOnly · perm: 'settings'`)이고 본문 안에서 위 탭 줄로 하위를 고른다.
  설정 화면 안에 왼쪽 목록을 두면 **사이드바 + 설정 목록 2열**이 된다(시안에서 폭 계산 필요 — 사이드바 접힘(레일)/펼침 모두).
- 표시 게이팅: `bareos`(`show: toolAllowed('bareos-backup')`) · `isilon-dirusage`(`superOnly` — 슈퍼 관리자). 서버 API 가 따로 집행(표시만 게이팅).

### 2.1 항목 전체(현재 순서 · 1단 19개 / 하위 48개)

| 1단(현재 표시) | 하위 키 · 라벨 |
|---|---|
| DataCenter(법인) | `datacenter-admin` |
| 🖥️ vCenter 관리 | `vcenter-admin` vCenter 등록·관리 · `vcenter-test` vCenter 연결 테스트 · `veeam` Veeam 백업 서버 · `bareos` Bareos 백업 서버(권한 있을 때) |
| NSX 관리 | `nsx-admin` |
| Horizon 연결 서버 | `horizon-admin` |
| 🗄 수집 서버 | `idrac-admin` iDRAC 서버 등록 · `idrac-scan-log` 스캔 로그 · `metrics` 지표 수집 · `storage-intervals` 스토리지 수집 주기 · `power-off-check` 전원 꺼짐 점검 · `vmseries` VM 실시간 스파이크 수집 · `sansw-perf` SAN 스위치 포트 사용량 · `isilon-dirusage` 아이실론 디렉터리 사용량(슈퍼) · `guest-partition` 게스트 파티션 사용률 · `guest-account` 게스트 계정 추가 · `collectors` 수집 서버(원격) · `agent-deploy` 원격 법인(DC)에 Edge 노드 포탈 설치 — **12개**(가장 큼) |
| 🎮 GPU 사용량 수집 | `gpu-collect` GPU 수집 · `gpu-guest` GPU 게스트 수집 · `gpu-guest-diag` GPU 수집 진단 |
| 🔌 원격 접속 서버 | `proxy` 중계 서버 · `remote` 원격접속 설정 |
| 👤 User Control | `users` 메인포탈 사용자 관리 · `edge-users` 엣지 사용자 배포 · `auth-ad` 인증(AD) |
| 🛡️ Security | `session-security` 세션 보안 · `secrets` 자격증명 저장 방식 · `api-keys` 연동 키(외부 포탈 조회 API) · `anomaly` 이상동작 탐지 · `host-access` 호스트 접근 제어 · `peer-trust` 장비 신뢰(SSH 호스트키·TLS 인증서) · `security-self-check` 보안 자가진단 |
| AI 검색 | `ai-search` |
| 알림 | `alerts` |
| 메일 발송 | `mail` |
| 특수 기능 카테고리 | `tool-categories` |
| 포탈 백업 | `backup` |
| NFS 마운트(백업 대상) | `nfs-mounts` |
| 폴더 사용량 리포트 | `dir-usage` |
| 📋 Log | `vclogs` vCenter 로그 보관 · `diagnostics` 진단·로그 · `perf-monitor` 서버 성능 측정 · `log-analysis` 로그 분석(개선점) · `audit` 감사 로그 |
| ⬆ 업그레이드 | `upgrade` |
| About | `about` |

관찰(사실): 1단 19개 중 **단독 항목이 12개**(DataCenter · NSX · Horizon · AI 검색 · 알림 · 메일 · 특수 기능 카테고리 · 포탈 백업 · NFS 마운트 · 폴더 사용량 리포트 · 업그레이드 · About)라 줄이 길다.
'수집 서버' 그룹(12개)에는 수집 주기 설정 · 장비 등록 · 엣지 배포가 섞여 있고, 그룹 이름 '수집 서버' 와 하위 '수집 서버(원격)' 가 같은 말이다.
NSX · Horizon 등록은 vCenter 관리 그룹 밖에 있다. 이모지가 그룹에만 붙어 있다.

### 2.2 바꾸면 안 되는 것(구현 때 지킬 제약)

- **하위 키 `k` 는 바꾸지 않는다** — 딥링크가 걸려 있다: `server/src/linkcheck/settingsKinds.js SETTINGS_PATHS`(라벨 문자열 '설정 › 수집 서버' · '설정 › User Control › AD 연동' 등 **메뉴 경로 이름**도 들어 있음 — 그룹 이름을 바꾸면 같이 고칠 것)
  · 웹 안 링크(`#/settings/collectors` 9곳 · `bareos` 9 · `agent-deploy` 8 · `edge-tokens` 4(이동 처리) · `veeam` 2 · `guest-partition` 2 · `gpu-guest` 2 · 그 외 1곳씩).
- `server/test/settingsLinks2685.test.js` 가 `Settings.jsx` 를 정규식 `\{ k: '([a-z0-9-]+)'` 로 읽어 키 집합을 만든다 — `SUB` 항목 모양(`{ k: '…'`)을 유지하거나 테스트를 함께 고칠 것.
- `server/test/v4Portal2508.test.js` 는 설정에 '신규 포탈 보기' · `v4-portal` 이 없음을 고정(새 셸·틀 금지 — 루트 CLAUDE.md).
- 화면 규약(`docs/rules/web.md` · 루트 CLAUDE.md): `text-transform: uppercase` 금지 · 문구 백틱 금지 · 그리드·플렉스 자식 `min-width:0` · 버튼 여러 개 행은 `flexWrap` · 화면 변경은 Chromium 1440/400 확인.
- 하위 화면 48개 컴포넌트 자체는 이번 범위가 아니다(메뉴만 재배치).

## 3. 구현한 배치(v2.905 — 사용자가 고른 '9개 묶음 + 2단')

```
⚙️ 설정
[인프라 등록]  백업  수집  엣지·원격  사용자  보안  알림·연동  로그  시스템      ← 1단 9개 · 줄바꿈(가로 스크롤 없음)
 ┃ 인프라 등록 › DataCenter(법인) · [vCenter 등록·관리] · vCenter 연결 테스트 · NSX 관리 · Horizon 연결 서버 · iDRAC 서버 등록 · iDRAC 스캔 로그
백업      : Veeam 백업 서버 · Bareos 백업 서버(권한) · 포탈 백업 · NFS 마운트(백업 대상)
수집      : 지표 수집 · 스토리지 수집 주기 · 전원 꺼짐 점검 · VM 실시간 스파이크 수집 · SAN 스위치 포트 사용량 · 아이실론 디렉터리 사용량(슈퍼)
            · 게스트 파티션 사용률 · 폴더 사용량 리포트 · GPU 수집 · GPU 게스트 수집 · GPU 수집 진단 · 게스트 계정 추가
엣지·원격 : 수집 서버(원격) · 원격 법인(DC)에 Edge 노드 포탈 설치 · 중계 서버 · 원격접속 설정
사용자    : 메인포탈 사용자 관리 · 엣지 사용자 배포 · 인증(AD)
보안      : 세션 보안 · 자격증명 저장 방식 · 연동 키 · 이상동작 탐지 · 호스트 접근 제어 · 장비 신뢰 · 보안 자가진단
알림·연동 : 알림 · 메일 발송 · AI 검색 · 특수 기능 카테고리
로그      : vCenter 로그 보관 · 진단·로그 · 서버 성능 측정 · 로그 분석(개선점) · 감사 로그
시스템    : ⬆ 업그레이드 · About
```

- 코드: `web/src/views/Settings.jsx` — `SUB` 의 모든 항목에 `group`, 1단은 `GROUP_ORDER`(보이는 하위가 없는 묶음은 뺀다), 1단 줄 `flexWrap: 'wrap'`.
- 라벨 변경은 `idrac-scan-log` '스캔 로그' → 'iDRAC 스캔 로그' 하나(묶음이 바뀌어 무엇의 로그인지 이름에 넣었다). 키는 48개 그대로.
- 안내 문구의 메뉴 경로('설정 › 수집 서버 › …' 등)는 새 묶음 이름으로 바꿨다(화면 · 서버 메시지 · 메일 · DB 안내 · 사용자 문서 · `linkcheck/settingsKinds.js`).
  버전 이력 주석 · 릴리스 노트 · 감사 기록은 과거 기록이라 그대로 뒀다. 고정: `server/test/settingsMenu2905.test.js`(① 키 48개 ② 묶음 소속 · 순서 ③ 줄바꿈 ④ 옛 경로 잔존 ⑤ 경로의 항목이 그 묶음에 있는가).
- `docs/SETTINGS.md` 는 새 묶음 순서로 절을 옮기고 번호를 1~48 로 다시 매겼다.


## 4. 2차 시안(2026-11-06) — "클로드 디자인으로 효율적·직관적으로 업그레이드"

요청 원문: "설정 메뉴를 클로드 디자인 사용해서 개편해줘 효율적이고 직관적으로 업그레이드 해줘, 시안 만들어서 보여줘" · "모두 그려서 보여줘".
시안 캔버스(Claude Design, Fable 작성): https://claude.ai/artifact/8LDs6tTp3poy6vZuQNtpfT — 아트보드 5장(현재 1 · A · B · C · A-400px). 상태 **시안 — 컨펌 대기**.

### 4.1 조사(코드 확인 2026-11-06 19:03 KST)

- 하위 항목 **51개**(v2.905 48개 + v2.912 `recent-logins`·`login-counts` + v2.913 `feature-usage`). 1단 묶음 9개는 v2.905 그대로.
- 문제: '수집' 묶음 12개라 2단 칩이 2줄 · 검색 없음 · 항목별 설명·상태 없음 · 본문 시작 위치가 묶음마다 다름 · '알림·연동' 안의 '특수 기능 카테고리'.

### 4.2 세 안에 공통인 변경

- 묶음 9 → **10**: '수집' 12개를 **수집 주기·임계 7**(지표 · 스토리지 수집 주기 · 전원 꺼짐 점검 · VM 실시간 스파이크 · SAN 스위치 포트 · 아이실론(슈퍼) · 폴더 사용량 리포트)
  + **게스트·GPU 5**(게스트 파티션 · 게스트 계정 추가 · GPU 수집 · GPU 게스트 · GPU 수집 진단)로 나눔. '특수 기능 카테고리' 는 **시스템** 으로, '알림·연동' 은 **알림·메일**(알림 · 메일 · AI 검색)로.
- **설정 검색**(단축키 `/`, 항목 이름 · 설명 · 옛 이름) · **항목별 설명 한 줄** · **상태 배지**(미설정 · 주의 · 새 버전 — 예시. 새 집계 API 필요) · 슈퍼 전용은 자물쇠 아이콘 · 링크 복사.
- 키 51개 · `#/settings/<k>` 는 바꾸지 않음(§2.2 제약 그대로). 묶음 이름이 바뀌는 항목의 안내 경로 문구 · `linkcheck/settingsKinds.js` · `settingsMenu2905.test.js` 는 함께 고친다.

### 4.3 A · B · C

| 안 | 구조 | 장점 | 단점 · 비용 |
|---|---|---|---|
| **A 왼쪽 목록(트리)** | 설정 안에 240px 목록(묶음 접기 · 검색 · 최근) + 본문. 본문 폭 1440−236−240 = **964px**(레일 64 이면 1,136px) | 51개가 한눈에 · 본문 시작 위치 고정 · 검색 즉시 필터 | 사이드바와 2열 · 720px 미만은 목록을 현재 위치 한 줄로 접고 형제 항목은 가로 스크롤 칩(A-400px 아트보드) |
| **B 카드 허브** | 첫 화면 = 묶음 카드 10장(5×2) + 큰 검색 + 최근 · 즐겨찾기 + 상단 상태 요약. 항목을 열면 A 와 같은 본문 | 처음 들어온 사람에게 전체 지도 · 상태가 카드에 보임 · 자주 가는 곳 1클릭 | 허브 ↔ 항목 한 단계 추가 · 상태 집계 API 구현 비용 · 즐겨찾기 저장 위치(브라우저 로컬 vs 사용자 설정) 결정 필요 |
| **C 탭 유지** | 지금 구조(1단 → 2단 → 본문). 1단을 밑줄형 세그먼트 10개 · 검색 상자 · 2단 칩에 설명 한 줄 · 묶음 설명 문단 삭제 | 변경 최소 · 딥링크 · 안내 문구 영향 최소 | 여전히 묶음을 눌러야 하위가 보임 · 본문 시작 위치가 묶음마다 다름 |

추천(설계자 의견, 사용 데이터로 검증한 것은 아님): **A** — 설정은 '찾아 들어가는' 화면이라 목록이 항상 보이는 쪽이 클릭 수와 기억 부담을 가장 줄인다.
B 의 '최근 · 즐겨찾기 · 상태 요약' 은 A 의 목록 머리에 작게 넣을 수 있다. C 는 시간이 가장 적게 든다.

### 4.4 컨펌(2026-11-06 19:27 KST) 과 구현 사양

사용자 결정: **A안 + B의 상태 요약** · 검증 **표준**(바꾼 모듈 테스트 + 전량 verify 1회 + Chromium 1440/400 + 상태 API 반증 1인) · 배지는 **항목별 '미설정' 전부**.

항목별 데이터 출처·판정 후보·비용은 `status-survey.md`(하위 에이전트 조사, 파일:라인 근거)에 있다. 그 조사로 정한 사양:

**메뉴 구조(웹 `Settings.jsx`)**
- 본문 왼쪽 240px 목록: 검색(`/`) · 묶음 10개(접기, 항목 수) · 항목(활성 점 · 배지 · 슈퍼 자물쇠) · 바닥 '최근'(브라우저 로컬 저장, 3개). 720px 미만은 목록을 '현재 위치 한 줄' 버튼으로 접고 형제 항목은 가로 스크롤 칩.
- 묶음 10개(`GROUP_ORDER`): infra · backups · collect(수집 주기·임계 7) · **guestgpu**(게스트·GPU 5 — 신설) · edge · usercontrol · security · notify(**알림·메일** — 알림·메일·AI 검색) · log · system(+ 특수 기능 카테고리).
- 본문 머리: 경로 줄(설정 › 묶음 › 항목) + 즐겨찾기 · 링크 복사 + 제목 + 항목 설명 한 줄(`SUB[].desc` 신설 — 51개 전부). 하위 화면 51개 컴포넌트는 그대로.
- 키 51개 불변. 묶음 이름이 바뀌는 항목의 경로 문구는 전부 고친다 — `linkcheck/settingsKinds.js`(mail · alerts 가 '알림·연동' → '알림·메일', gpuPhysical 이 '수집' → '게스트·GPU') · 소스 안 '설정 › … › …' 문구 · `docs/SETTINGS.md`. `settingsMenu2905.test.js` 는 줄 모양 파서라 `{ k: …, label: …, C: …, group: … }` 한 줄 형식을 유지하고 `desc` 는 그 뒤에 붙인다(테스트 ①②④⑤ 갱신).

**상태 집계 `GET /api/settings/status`(서버 신설 — 반증 대상)**
- 응답: `{ items: { [k]: { grade: 'unset'|'off'|'warn'|'ok', text, count? } }, groups: { [g]: { unset, off, warn } }, upgradeAvailable }`. 메뉴는 `unset`(호박 '미설정') · `warn`(빨강 점 + 수) · `off`(회색 '꺼짐' — opt-in 기능, 미설정 아님) · 시스템 '새 버전'(초록) 만 그린다. `ok` 는 표시 없음.
- 등급 규칙: `enabled` 기본 false 인 opt-in 기능(vmseries · sansw-perf · guest-partition · dir-usage · gpu-guest · ai-search · AD · NSX · Horizon · Veeam · isilon · 수집 서버 0건 · 중계 proxyHost 비어 있음)은 **`off`** — '못 읽은 값은 0 이 아니다' 와 같은 취지로 선택 기능 미사용을 장애처럼 보이지 않게 한다. `unset` 은 조사표 '미설정(자연스러운 것)' 9개: DataCenter 0 · vCenter 0 · SMTP host 빔 · 알림 채널 0 · 자격증명 평문 · 세션 보안 파일 없음(소유자 기본값) · 정기 백업 꺼짐 · Bareos Director 0(권한 보일 때만) · 업그레이드 소스 없음. 조회 전용·동작 화면은 등급 없음.
- `warn` 은 서버가 **이미 계산하는 값만**: 새 버전(`upgrade.status().lastCheck.remote|watch.available`) · 자가진단 `risk+warn` · 장비 신뢰 `pending+pendingChanged` · 인증 정지 수(`peekAuthStop` — `authStopFor` 는 기록을 지우므로 금지) · AD 전송 경고 · 수집 서버 `ok:false` 수 · 수집 오류 수 · 호스트 접근 `pending` 기한 초과 · 등록부 `loadError` 류.
- **제외(느리거나 DB)**: `hostAccessStatus()` · `logStatus()` · `perfDbStats()` · `getDb().latestAll()` · `targetRows()/ensureIsiduDemo()` · `buildUsageReport` · `listBackups()` readdir · 로그 분석 · 모든 연결 테스트. 파일·메모리 값만 — 라우트 한 번에 외부 호출 0, SQLite 0.
- 게이트: `adminOnly` + 설정 화면과 같은 소유자 조건. 항목별 원 라우트 등급이 더 높은 것(`requireSettingsOwner`: backup · session-security · secrets · host-access · feature-usage · mail PUT / `requireSuperAdmin`: isilon / `fullScopeOnly` 류)은 **그 권한이 없는 계정의 응답에서 항목을 뺀다**(불리언도 정보). `memoJson` + `extraKey: scopeKey(req) + 역할 + 소유자 여부`, TTL 12초(설정 저장 직후 배지가 최대 12초 늦는 것을 허용 — 저장 라우트는 건드리지 않는다). 못 읽은 등록부는 `warn`(loadError) 이지 `unset` 이 아니다.
- 웹: 마운트 1회 + 60초 폴링 + 설정 저장 뒤 수동 새로고침 버튼(무거운 15초 폴링 금지 규약). 응답 실패면 배지를 모두 숨기고 목록 바닥에 '상태를 못 읽음' 한 줄(값 없음 ≠ 정상).
- 테스트: 라우트 테스트(권한별 항목 가림 · 등급 규칙 · 외부 호출 0 — 모듈 스텁으로 고정) · `settingsMenu` 테스트 갱신 · 웹 `desc` 51개 전부 존재.

### 4.5 구현(v2.916) — 사양과 달라진 점

- 상태 API 게이트는 항목별로 가리는 대신 **라우트 전체를 `adminOnly + requireSettingsOwner`**(설정 소유자 ∧ 전체 범위)로 묶었다. 배지 대부분(SMTP 유무 · 비밀 정책 · 정기 백업 여부)이
  소유자 등급 값의 요약이라 항목별 예외를 두는 것보다 단순하고 새지 않는다. 슈퍼 전용(아이실론)만 `isSuperAdmin` 으로 따로 뺀다. 범위가 지정된 소유자는 403 → 화면은 배지 없이 목록만 + 바닥 한 줄 안내.
- '미설정' 은 §4.4 의 9개 중 **세션 보안을 뺀 8개**. 파일이 없을 때의 소유자 기본값은 실제로 동작하는 설정이라 미설정으로 단정하지 않았다(정직 규칙).
- iDRAC 인증 정지 수는 넣지 않았다 — `idracAuthStops()` 가 `authStopFor`(기록을 지우는 판정)를 쓴다. vCenter 인증 정지는 스냅샷 `collectionErrors[].authStopped` 로 센다.
- `memoJson` TTL 은 12초가 아니라 **5초**(키: 스냅샷 세대 + 슈퍼 여부). 화면은 마운트 · 60초 · 항목 이동마다 다시 읽고, 요약 칩 옆 '다시 읽기' 버튼이 있다.
- 시안 B 의 '즐겨찾기' 도 넣었다(브라우저 저장소 — 편의 기능이라 서버에 두지 않는다. 읽기 · 쓰기 실패는 무시).
