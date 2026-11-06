# 설계: 설정 › 사용자 › 기능 사용 현황(`#/settings/feature-usage`) — 사용자별 기능 사용 추적

작성 2026-11-06 (v2.911.0 · main 349e9e5 기준) · 상태 **구현 — v2.913.0(§7)** · 컨펌 2026-11-06 '진행해'(§5 기본값 8개 그대로) · 시안 캔버스: https://claude.ai/artifact/GuLA7wngifiCeeXE9teFrW
(아트보드 7장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. **모든 수치 · 사용자 · 날짜는 그림용 가상값**이고 기능 이름 · 메뉴 경로 · 도구 키만 실제 포탈 것이다.
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로. 범주 색 6개(묶음 비중)는 포탈 토큰의 밝은 색이 어두운 패널 위 범주 색 기준(밝기 띠)을 넘겨
한 단계 어두운 값으로 바꿨다 — `#3b82f6 #d97706 #0891b2 #9333ea #0d9488` + 중립 `#5d6b85`(기타) · dataviz 검증기 통과(2026-11-06 실측).
계정의 ‘Design System’ 아티팩트는 앞 시안들과 같이 내용이 비어 있어 쓰지 않았다.)

§2 는 Opus 세션이 코드로 확인한 사실, §3~§6 은 시안 단계(Fable)에서 채웠다. §7 은 구현(Opus)에서 채운다.

## 1. 요구(사용자 2026-11-06)

> "사용자별로 어떤 기능을 사용하는지 트래킹 하는 메뉴 만들어줘, 사용자가 주로 많이 사용하는 ui 개선을 위해 필요해"

진행 중 고른 것: 검증 **표준** · 열람 **설정 소유자만** · 기록 **열람 횟수 + 머문 시간** · **시안 먼저**(Fable → 컨펌 → Opus 구현).

목적이 ‘UI 개선’ 이므로 화면의 중심은 **개인 감시가 아니라 기능 쪽**이다 — 무엇이 많이 쓰이고, 무엇이 안 쓰이며, 자주 쓰는 것이 몇 번 눌러야 나오는가.
사용자별 표는 ‘역할 · 범위마다 쓰는 화면이 어떻게 다른가’ 를 보기 위한 보조 축이다.

## 2. 지금 코드에서 확인한 것(설계의 근거)

| 사실 | 위치 |
|---|---|
| 이미 있는 것은 **전 사용자 합산** 도구 클릭 카운터뿐(키별 횟수 · 마지막 시각 · JSON · 2초 디바운스). 사용자 구분 없음. 특수 기능 ‘자주 쓰는 메뉴’ 추천용 | `server/src/tool-usage.js` · `POST /api/tool-usage`(`routes/api/inventory.js:644`) · `SpecialTools.jsx:207,253` · `App.jsx:480` |
| `POST /tool-usage` 는 viewer 포함 모든 계정이 부르고 감사 로그에서 제외(`AUDIT_SKIP`) — 새 수신 경로도 같은 자리 | `audit.js:158` |
| 키 검증은 서버가 아는 도구 키만(`knownToolKeys` — `auth/toolAccess.js` 매핑 합집합 · `MAX_KEYS` 300) | `tool-usage.js:72` |
| 주소 체계: 탭 `#/<tab>`(16개) · 도구 `#/tools/<k>[/<seg>]`(카탈로그 121 · adminOnly 41 · 준비 중 3) · 설정 하위 `#/settings/<k>`(50개 · 9묶음) · 관제 콘솔 `#/console/<page>` · Overview 모드 `#/overview/exec\|eng` | `App.jsx:53` · `specialToolsList.js` · `Settings.jsx SUB` · `console/DvcConsole.jsx:11` |
| 지금 화면 판정은 `tab` + `hashNow` 상태와 `locate(tab, hash, groups)` — 추적 지점으로 쓸 수 있다 | `App.jsx:319,469` · `views/topMenu.js locate` |
| 상단 메뉴 항목은 탭 또는 도구만 가리킨다(설정 하위 탭을 가리키는 형식 없음) | `topMenu.js MENU_GROUPS` · `hashOf` |
| ‘설정’ 탭은 adminOnly + ownerOnly(웹 `isSettingsOwner`) · 서버 `requireSettingsOwner` = **소유자 ∧ 전체 범위**(범위 계정 소유자는 403 `SETTINGS_OWNER_FULL_SCOPE_REASON`) | `App.jsx:79` · `routes/admin/shared.js:51` · `server/CLAUDE.md` |
| 설정 묶음 9개(v2.905 — 늘리면 `settingsMenu2905.test.js` 가 대조): **사용자** 묶음 = 메인포탈 사용자 관리 · 엣지 사용자 배포 · 인증(AD) | `Settings.jsx:52-120` |
| 활동 판정이 이미 있다 — 유휴 타이머와 같은 사건(`mousemove·mousedown·keydown·touchstart·scroll·click·visibilitychange`), 서버 활동 신호는 최대 1분 1회 · api.js 헬퍼를 쓰지 않는 조용한 전송 | `web/src/sessionActivity.js` |
| 인증은 localStorage 토큰 + Authorization 헤더 → `sendBeacon` 불가. 창을 닫는 순간의 마지막 조각은 `fetch keepalive` 로만 시도 | `web/src/api.js:7` |
| 계정 목록 `listUsers()` = username · name · role · scope · managedBy · demo · superuser. **AD 계정은 목록에 없다**(로그인 때만 존재) → 기록 시점에 이름 · 역할을 함께 남겨야 화면에 보인다 | `server/src/auth/auth.js:489` |
| 엣지 포탈도 자체 로그인 사용자가 있다 — 이 기능은 **그 포탈에서 쓴 것만** 센다. 엣지 사용을 중앙으로 모으려면 엣지 push 필드 + 중앙 정제 화이트리스트가 필요(2단계) | `Settings.jsx edge-users` · 루트 CLAUDE.md ‘엣지가 보낸 것은 정제한다’ |
| 저장 패턴: SQLite(`node:sqlite DatabaseSync` + `util/sqliteOpen.js`) · 일 롤업 `ON CONFLICT DO UPDATE` · 하루 경계 KST(`util/dayKey.js`) · prune 스로틀 + ts 인덱스 + 청크 · 종료 시 동기 flush(`util/exitFlush.js`) | `linkcheck/db.js` · `docs/rules/perf-db.md` |
| 민감 작업 재인증 = 본인 OTP + 실패 잠금(PUT `/security/session` 경로가 선례) · 미인증 응답(`/auth/config`)에 계정명 금지 | `server/CLAUDE.md` |
| 화면 규약: 표는 `STable`(제목 클릭 정렬 · null · ‘—’ 는 뒤) · 문구 `BoldText`(백틱 금지) · uppercase 금지 · 무거운 API 폴링 금지(마운트 1회 + 버튼) · 400px `minWidth` · 403 은 `ErrorBox` 권한 안내 | `docs/rules/web.md` · `LogAnalysis.jsx` 머리말 |

## 3. 화면(IA) — 아트보드 7장

```
① Main       설정 › 사용자 › 기능 사용 현황 · 탭 [개요 | 기능별 71/190 | 사용자별 23 | 수집 설정] · 기간 7/30/90/직접 · CSV
             띠(엣지 제외 · 머문 시간 정의 · 오늘 부분) → KPI 5(활성 사용자 · 열람 · 머문 시간 · 쓰인 기능 · 30일간 0회)
             → 많이 쓰는 기능 상위 15(위치 · 종류 · 열람 · 사용자 · 머문 · 1회 평균 · 비중 · 지난 기간 대비) | 묶음별 비중 · 일별 추이 · 역할별
             → UI 개선 단서 3칸(승격 후보 · 정리 후보 · 깊이) — 규칙을 칸 아래에 적는다(판단은 사람)
② Features   전 기능 190 한 표 · 필터(종류 · 어디서 여나 · 상태: 쓰임/안 씀/관리자 전용/준비 중) · ‘볼 수 있는 사람’ 열 · 0회는 맨 뒤 구간 + 직전 기간 값
             · 기록 꺼짐 구간 띠(0 으로 세지 않는다)
③ Users      KPI 4(활성 · 1인당 열람 중앙값 · 1인당 기능 수 중앙값 · 한 기능만 쓰는 사용자) · 필터(역할 · 범위 · 출처) ·
             표(계정 · 이름 · 역할 · 범위 · 열람 · 머문 · 활동일 · 기능 수 · 상위 3 기능 · 일별 스파크 · 마지막 접속) · 미접속 18명 구간
④ UserDrawer 행 클릭 → 오른쪽 드로어(580px · 주소 #/settings/feature-usage/users/<계정>) — KPI 4 · 기능별 상위 10 · 일별 · 묶음별(전체 평균과 비교)
⑤ Settings   켜기/끄기(기본 꺼짐 · 누가 언제) · 머문 시간 기준(유휴 N분) · 보관 기간(일) · 제외 계정(데모 기본) · 무엇을 세나(설명) · 고지 문구 ·
             지금 상태(마지막 신호 · 버린 신호 · 저장 방식 · DB 크기) · 기록 지우기(범위 · OTP) · 어떻게 동작하나 5단계
⑥ States     ⓐ 꺼짐(마지막 구간 표시) ⓑ 첫날(부분 · ‘—’) ⓒ 범위 소유자 403 ⓓ 조회 실패(503 · 직전 응답 ‘오래됨’) ⓔ 지우기 확인(OTP) ⓕ 로그인 고지
             ⓖ 추이의 공백 · 오늘(부분) 막대 구분 ⓗ 메뉴 위치(기본: 설정 하위 · 선택: 사이드바 바로 가기)
⑦ Narrow     400px — 설정 1단 · 2단 줄바꿈 · 탭 가로 스크롤 · KPI 2열 · 상위 기능은 표 대신 2줄 목록 + 막대 · 44px 터치
```

## 4. 설계 결정(시안에 그대로 그린 것)

### 4.1 무엇을 세나 — ‘주소가 바뀌는 화면 전환’ 만
- 키 5종: `tab:<id>` · `tool:<k>[/<seg>]` · `settings:<k>` · `console:<page>` · `overview:<exec|eng>`. 검색어 · 입력 값 · 조회한 장비 · 화면 안 버튼은 **세지 않는다**(사용자 선택 ‘열람 + 머문 시간’).
- 서버는 **아는 키만** 받는다: 도구 키는 `knownToolKeys()`(이미 있음), 탭 id · 설정 하위 키 · 콘솔 페이지는 새 `server/src/usage/keys.js` 에 둔다.
  설정 하위 키는 지금 웹(`Settings.jsx SUB`)에만 있으므로 **테스트가 웹 SUB ⊆ 서버 목록을 대조**한다(`settingsMenu2905.test.js` 가 SUB 를 읽는 방식 그대로). 키 집합 상한 300(`tool-usage.js MAX_KEYS` 와 같은 방어선).
- 이 화면(기능 사용 현황) 자신도 센다 — 관리 화면도 UI 다.

### 4.2 머문 시간의 정의(컨펌 항목 ①)
- ‘창이 보이고(`visibilityState === 'visible'`) **마지막 입력 뒤 N분 이내**’ 인 시간만 더한다. N 기본 **5분**, 1~30분, 수집 설정에서 바꾼다.
- 입력 사건은 `sessionActivity.js ACTIVITY_EVENTS` 와 **같은 목록**(판정 코어 하나).
- 화면은 보고 있는 동안 **30초마다 머문 조각**(구현에서 10초 → 30초 — §7 12)(`{k, ms}`)을 보낸다. 창이 가려지거나 유휴 한도를 넘으면 멈춘다. 창을 닫는 순간의 마지막 조각(최대 10초)은 `fetch keepalive` 로 시도하되 **빠질 수 있다고 화면에 적는다**(§3 ⑤ 문구).

### 4.3 저장 — 일 단위 집계만, 원본 이벤트 없음
- `usage.db`(`<dbDir>/usage.db`) 표 하나: `feature_usage_daily(day, user, key, views, active_ms, last_ts, name, role, PRIMARY KEY(day,user,key))` + `day` 인덱스(prune).
  `name` · `role` 은 **기록 시점 값**(AD 계정 · 퇴직 · 역할 변경 뒤에도 표에 보이게).
- 수신은 메모리 맵에 모았다가 **60초마다 한 트랜잭션**으로 `ON CONFLICT DO UPDATE`(합산). 종료 시 `registerExitFlush`. 하루 경계 KST(`dayKey.js`).
- 상태 · 설정은 `usage-settings.json`: `{enabled, idleMin, keepDays, excluded[], noticeEnabled, notice, toggles:[{at,by,on}]}` — 켜고 끈 기록(`toggles`)이 ‘꺼짐 구간’ 띠와 추이의 빗금 막대의 근거.
- 보관 기본 **180일**(90일~5년) · 하루 1회(03:10 KST) 청크 prune. 원본이 없으므로 백업(`/api/admin/backup`)에 **넣지 않는다**(자격증명 아님 · 개인 기록 성격).
- 규모(추정 — 구현 때 실측): 50명 × 하루 20화면 = 1,000행/일 → 180일 18만 행 · 10MB 안팎.

### 4.4 API 와 문지기
| 경로 | 누가 | 비고 |
|---|---|---|
| `POST /api/usage/hit {k}` · `POST /api/usage/beat {k, ms}` | 로그인 사용자 전부(viewer 포함) | `AUDIT_SKIP` 등재 · 계정은 **`req.user`** 로만(본문 계정명 무시) · 제외 계정 · 모르는 키 · 꺼짐이면 `{ok:false, reason}` 로 조용히 버림 · 사용자당 분당 상한(120) 넘으면 버림 · 기존 `POST /tool-usage` 는 그대로(특수 기능 추천용 — 합치지 않는다) |
| `GET /api/admin/usage/summary?from&to` · `/features` · `/users` · `/users/:u` · `/export.csv` | `requireSettingsOwner`(소유자 ∧ 전체 범위) | 기간 상한 1년 · 집계는 그 표만 읽는다 · 못 읽으면 **503**(빈 표 금지) · 응답에 `partialToday` · `gaps[]`(꺼짐 구간) · `prevAvailable` 를 싣는다 |
| `GET/PUT /api/admin/usage/settings` | `requireSettingsOwner` | PUT 은 감사 로그 · `idleMin` 1~30 · `keepDays` 90~1825 |
| `POST /api/admin/usage/purge {scope, user?, before?, otp}` | `requireSettingsOwner` + 본인 OTP | 감사 로그에 범위 · 행 수 · 누가 · 실패 잠금(민감 작업 재인증 규칙) |
| `GET /api/auth/config` | 미인증 | `usageNotice: {enabled, text}` 만 더한다 — 계정 · 수치 금지 |

### 4.5 화면 규약 적용
- 표 전부 `STable`(정렬 · `minWidth` · ‘—’ 뒤로) · 폴링 없음(마운트 1회 + 기간 변경 + 새로고침 버튼) · 늦게 온 이전 응답은 버린다.
- **결측과 0 을 섞지 않는다**: 직전 기간 기록 없음 → ‘—’(0% 아님) · 꺼짐 구간 → 어떤 합계 · 평균의 분모에도 넣지 않고 빗금 막대 · 오늘 → ‘부분’ 표시(추이에 빗금).
- ‘UI 개선 단서’ 는 집계에서 **규칙으로** 뽑고 규칙을 칸 아래에 적는다 — 승격 후보(메뉴 항목이 아닌 도구 중 열람 상위 3 · 2명 이상) · 정리 후보(메뉴 항목 중 0회 · 권한으로 아무도 못 보는 항목 제외) · 깊이(설정 하위 · 카드 전용 도구 중 열람 상위 · 사용자당 주 3회 이상). 기능 쌍(함께 여는 화면)은 **일 집계로는 못 만든다** — 넣지 않았다.
- ‘볼 수 있는 사람’ 열 = 지금 권한(역할 · `toolAllowed` · 설정 소유자)으로 그 화면을 열 수 있는 계정 수. 0 이면 ‘안 씀’ 이 아니라 ‘닿을 수 없음’.

### 4.6 추적기(웹)
- `web/src/usageTracker.js`(순수 판정 + 전송) · App 의 `tab` · `hashNow` 변화에서 키를 만든다(`locate` 와 같은 조각 규칙). 전송은 `sessionActivity.js` 처럼 **조용히**(api.js 헬퍼 금지 — 401 전역 처리 · 진행 표시에 올리지 않는다). 실패는 버린다(재시도 폭주 금지).
- 수집이 꺼져 있으면(`/auth/me` 의 `usageEnabled:false`) 신호를 보내지 않는다 — 서버가 버리더라도 쓸데없는 요청을 만들지 않는다.

## 5. 컨펌 항목(2026-11-06 '진행해' — 기본값 그대로)

| # | 결정 | 시안의 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 머문 시간의 유휴 한도 | 5분(설정에서 1~30) | 고정값 · 또는 ‘창이 보이면 전부’ |
| ② | 보관 기간 | 180일(90일~5년) | 1년 기본 |
| ③ | 기록 지우기 | 넣는다 — 소유자 + 본인 OTP + 감사 · 범위(전체/한 사용자/어느 날 이전) | 보관 기간 축소만으로 대신 |
| ④ | 사용자 고지 | 로그인 화면 아래 문구(수집이 켜져 있을 때만 · 문구 편집 가능) | 고지 없음 · 게시판 공지로 |
| ⑤ | 메뉴 위치 | 설정 › 사용자 › 기능 사용 현황(`#/settings/feature-usage`) | + 사이드바 ‘설정’ 묶음 바로 가기(topMenu 에 ‘설정 하위’ 항목 형식 추가 필요) |
| ⑥ | 기본값 | 설치 직후 **꺼짐** — 소유자가 켠다 | 켜짐 |
| ⑦ | 제외 계정 | 데모 계정 기본 제외 · 소유자가 추가 | 제외 없음 |
| ⑧ | 엣지 포탈 사용분 | 이번에는 **없음**(띠로 밝힘) · 2단계에 엣지 push 로 합산 | 이번에 함께(규모 +1일) |

## 6. 구현 계획(컨펌 뒤 Opus)

- 서버: `server/src/usage/{db.js,keys.js,store.js,settings.js,insights.js}` · `routes/api/usage.js`(hit · beat) · `routes/admin/usage.js`(summary · features · users · settings · purge · csv) · `audit.js AUDIT_SKIP` 2줄 · `auth/config` 에 `usageNotice` · `auth/me` 에 `usageEnabled`.
- 웹: `web/src/usageTracker.js` · `App.jsx` 연결(hashNow · visibility) · `views/FeatureUsage.jsx`(+ `featureUsageText.js` 순수 문구 · 규칙) · `Settings.jsx SUB` 에 `{k:'feature-usage', group:'usercontrol'}` · `Login.jsx` 고지 · `styles.css .fu`.
- 테스트: 키 검증(웹 SUB ⊆ 서버) · 머문 시간 판정(유휴 · 가려짐 · 경계) · 일 집계 합산 · 꺼짐 구간이 합계 · 분모에 안 들어감 · 직전 기간 없음 ‘—’ · 범위 소유자 403 · 본문 계정명 무시 · 분당 상한 · purge OTP · `/auth/config` 에 계정 없음 · 설정 묶음 테스트 갱신.
- 검증(표준): 관련 테스트 + Chromium 1440/400 1회 + 전량 verify + 릴리스.

## 7. 구현 기록(v2.913.0 — Opus)

번호: main 이 같은 날 v2.912.0(설정 › 로그 › 최근 로그인 · 로그인 횟수)을 먼저 써서 v2.913.0 이 됐다. 그 기능과 겹치지 않는다(그쪽은 로그인 성공 기록, 이쪽은 화면 사용).

| 영역 | 파일 |
|---|---|
| 서버 | `server/src/usage/{keys,settings,db,store}.js` · `routes/api/usage.js`(POST /usage/track) · `routes/admin/usage.js`(report · user · export.csv · settings · purge) · `routes/auth.js`(로그인 응답 · /auth/me `usageTrack`, /auth/config `usageNotice`) · `audit.js`(AUDIT_SKIP · 라벨 2 · `res.locals.auditDetail`) |
| 웹 | `web/src/usageTracker.js` · `App.jsx`(추적기 연결) · `views/FeatureUsage.jsx` · `views/featureUsageText.js` · `views/featureUsage.css` · `views/Settings.jsx`(하위 탭) · `views/Login.jsx` · `loginThemes.jsx`(고지) |
| 등록부 | `insights/dbLocation.js` · `portalDb.js` · `dbGuideData.js` · `docs/SETTINGS.md`(31번) · 생성 문서 3종 |
| 테스트 | `server/test/featureUsage2913.test.js`(7) · `web/src/usageTracker.test.js` · `web/src/views/featureUsageText.test.js`(18) · `settingsMenu2905.test.js`(KEYS_ADDED) |

**시안과 달라진 점(정직 기록)**
1. 기능별 표의 **‘볼 수 있는 사람’ 열은 넣지 않았다** — AD 계정은 서버가 열거할 수 없어(로그인 때만 존재) 계정 수가 틀린 값이 된다. 대신 **권한 열**(관리자 전용 · tools 권한 · 설정 소유자 · 슈퍼 관리자)을 보이고, ‘안 씀’ 안내에 '권한 때문에 아무도 열 수 없는 화면일 수 있다' 를 적었다. 정리 후보 규칙 문구도 같은 내용이다.
2. **Overview 보기 모드(경영 · 엔지니어)는 따로 세지 않는다** — `#/overview/exec` 도 `tab:overview` 다(모드는 대개 저장값이라 주소로 갈리지 않는다 — 주소로 세면 같은 화면이 두 키로 갈린다).
3. 개인 상세 드로어는 **주소에 싣지 않았다**(화면 상태). 탭 4개는 주소에 싣는다(`#/settings/feature-usage/<탭>`).
4. 기간은 7 · 30 · 90 · **365**일(‘직접’ 대신). API 는 `from`·`to`(최대 366일)도 받는다.
5. 400px 의 상위 기능은 2줄 목록 대신 **STable + 가로 스크롤**(표 규약 하나로).
6. 정리 주기: ‘03:10 하루 1회’ 대신 **저장 60번(약 1시간)마다**(perf-db `(++tick % N) === 0` — 기동 첫 틱 금지).
7. 열람은 **1초 넘게 머문 화면만** 1회로 센다(메뉴를 훑으며 지나간 화면 제외) · 서버는 2초 안 같은 키를 한 번으로 센다(마지막으로 센 열람 기준).
8. 머문 시간은 계정당 **벽시계 상한**을 둔다 — 창 두 개가 동시에 보내도 직전 조각 뒤 흐른 시간까지만 더한다(조각당 45초 상한 + 이것).
9. 켜고 끈 것은 각 사용자가 **다시 로그인 · 새로고침해야** 화면 추적기에 반영된다(설정은 /auth/me 로 받는다). 그 사이 신호는 서버가 버린다 — 설정이 진실의 원천이다.
10. 감사 로그: 설정 저장 · 지우기는 자동 감사 줄 하나에 `detail`(무엇이 어떻게 · 범위 · 행 수)을 싣는다 — 라우트가 `res.locals.auditDetail` 을 남기면 `auditMiddleware` 가 같은 줄에 붙인다(두 줄 방지 · AUDIT_SKIP 에 쓰기 경로를 넣지 않는다 — 데모 계정 쓰기 차단도 그 목록을 본다).
11. 범주 색 5 + 중립은 시안 그대로(dataviz 검증 통과 값) · 묶음에 고정(순위로 칠하지 않는다).
12. 머문 조각 주기 **10초 → 30초**(서버 조각 상한 15초 → 45초) — 전역 요청 상한(`util/rateLimit.js`)이 **IP당 분당 1,800회**라, 프록시 뒤 한 IP 로 50명이 들어오면 10초 주기만으로 분당 300회가 더해진다. 30초면 분당 100회. 대가: 창을 닫는 순간 잃을 수 있는 몫이 최대 30초로 늘어난다(창이 가려질 때 · pagehide 때 남은 몫을 keepalive 로 보내는 것은 그대로).

**검증**: 서버 단위 테스트 7 + 웹 18(위 표) · 수동 스모크(열람 1 · 머문 시간 · 중복 1회 · 파일 0600) · Chromium 1440/400 은 PR 보고에 적는다.
**남은 것(다음 점검 후보)**: 엣지 포탈 사용분 합산(2단계 — 엣지 push + 중앙 정제 화이트리스트) · 화면 안 주요 버튼 계측(사용자가 이번에 고르지 않음).
