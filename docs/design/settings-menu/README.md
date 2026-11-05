# 설계: 설정 메뉴 재배치(가로 스크롤 없애기)

작성 2026-11-05 · 상태 **구현됨 — v2.902.0**(시안 단계 생략: 사용자 결정 2026-11-05 '버그 수정이나 개선을 위한 작업 진행' → 질문에 '설정 메뉴 바로 수정' · 배치안 '9개 묶음 + 2단' · 검증 '표준').
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

## 3. 구현한 배치(v2.902 — 사용자가 고른 '9개 묶음 + 2단')

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
  버전 이력 주석 · 릴리스 노트 · 감사 기록은 과거 기록이라 그대로 뒀다. 고정: `server/test/settingsMenu2902.test.js`(① 키 48개 ② 묶음 소속 · 순서 ③ 줄바꿈 ④ 옛 경로 잔존 ⑤ 경로의 항목이 그 묶음에 있는가).
- `docs/SETTINGS.md` 는 새 묶음 순서로 절을 옮기고 번호를 1~48 로 다시 매겼다.

