# 설계: 포탈 점검 › 공통 기능(`#/tools/portal-check/common`) — 공통 기능 목록 화면

작성 2026-11-14 (v3.9.0 · main be4f7f8d 기준) · 상태 **구현됨 v3.10.0**(컨펌 2026-11-14 ‘기본값대로’ — §6 기본값 7개 그대로 · 검증 표준 · §7 구현 기록) · 시안 캔버스: https://claude.ai/artifact/GpVXkVRqBa1UqSUzjmTb4H
(아트보드 4장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. **수치 · 모듈 이름 · 설명은 2026-11-14 main 에서 생성기가 실제로 센 값**이다 —
공용 모듈 154 · 공용 위치 밖 77(서버 69 · 웹 8) · 사용처 0 2 · 테스트 0 25 · 서버·웹 두 벌 4 · 훑은 소스 4,088개 파일. ② 의 `deadline.js` 영역별 개수도 실측.
색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로. 계정의 ‘Design System’ 아티팩트는 앞 시안들과 같이 내용이 비어 있어 쓰지 않았다.)

§2 는 코드로 확인한 사실, §3~§6 은 시안 단계(Fable)에서 채웠다. §7 은 구현에서 채운다.

## 1. 요구(사용자 2026-11-14)

> "전체 솔루션에서 사용하는 공통 기능을 개발하는 기능 필요" → 범위 질문에 **공통 기능 목록(카탈로그)** 선택 → 문서 생성기(`docs/COMMON.md`)를 머지한 뒤
> "포탈 화면도 설계 시안부터 진행해줘"

목적은 문서와 같다 — **새 헬퍼 · 컴포넌트를 만들기 전에 ‘이미 있는가’ 를 찾는 것**. 화면이 문서보다 나은 점은 검색 · 구분 거르기 · 정렬 · 모듈 상세뿐이다.

## 2. 지금 코드에서 확인한 것(설계의 근거)

| 사실 | 위치 |
|---|---|
| 목록의 원천은 생성기 하나 — 공용 위치 5곳의 모듈 · 공용 위치 밖 모듈 · 두 벌 · 사용처 0 을 센다. `buildCatalog()` 가 객체로, `renderMd()` 가 문서로 | `scripts/common-doc.mjs` |
| **배포본에는 소스가 없다** — 오프라인 패키지는 `server/src` · `server/config` · `web/dist` 만 담는다(`web/src` · `server/test` · `scripts/` · `docs/` 없음). 포탈이 실행 중에 목록을 다시 만들 수 없다 | `packaging/offline/build-package.sh:111,112,134` |
| 같은 문제를 푼 선례 — 특수 기능 카탈로그는 빌드 때 `web/public/special-tools.json` 을 만들고 서버가 `config.webDist` 에서 읽는다 | `scripts/tools-catalog.mjs` · `server/src/portalcheck/toolCatalog.js` |
| `web/dist` 는 인증 없이 정적으로 서빙된다 — 거기 둔 파일은 로그인 없이 받을 수 있다 | `server/src/index.js:524~529` |
| ‘포탈 점검’ 은 도구 키 `portal-check` 하나에 하위 보기 4개(토큰 · 인벤토리 · 아키텍처 · 법인별 실환경)를 `useHashTab` 으로 싣는다 | `web/src/views/tools/PortalCheck.jsx:44,555` |
| 포탈 점검 API 는 전부 `adminOnly, fullScopeOnly` | `server/src/routes/api/portalCheck.js:218~423` |
| 아키텍처 점검 보기의 구성: 배너 카드 · `Kpi` 5개 · `STable minWidth` · `ErrorBox`(403 은 권한 안내) | `web/src/views/tools/ArchCheckView.jsx` |
| 오른쪽 서랍 선례 | `web/src/views/vms/VmDrawer.jsx` |

## 3. 화면(IA) — 아트보드 4장

| # | 파일 | 내용 |
|---|---|---|
| ① | `Main.dc.html` | 목록(1440). 하위 보기 단추 다섯째 ‘공통 기능’ · 안내 줄(빌드 시점 · 다시 만들 수 없음) · 숫자 카드 5개(누르면 그 조건으로 거름) · 찾기 + 구분 칩 7개 · 표(모듈 · 구분 · 하는 일 · 내보내는 이름 · 사용처 · 영역 · 테스트) |
| ② | `Detail.dc.html` | 검색 ‘시한’ 결과 3건 + `deadline.js` 상세 서랍 — 하는 일 · 내보내는 이름 전부 · 경로 복사 · 영역별 사용처 개수 · 가리키는 테스트 파일 |
| ③ | `Narrow.dc.html` | 400px. 보기 단추 줄바꿈 · 카드 2열 · 구분은 드롭다운 · 표는 상자 안 가로 스크롤(내보내는 이름 열은 상세로) |
| ④ | `States.dc.html` | 상태 6종 — 불러오는 중 · 목록이 실리지 않은 설치본 · 파일을 읽지 못함 · 목록 버전 ≠ 포탈 버전 · 찾는 것이 없음 · 권한 없음 |

시안은 격자(div)로 표를 그렸다 — 구현은 `STable`(제목 클릭 정렬 · `minWidth` · `limit` 은 정렬 뒤)이고, ③ 의 드롭다운은 공용 `Select` 다(날 `<select>` 금지).

## 4. 설계 결정(시안에 그대로 그린 것)

### 4.1 자리 — 포탈 점검의 다섯째 보기(새 도구 키를 만들지 않는다)

`#/tools/portal-check/common`. 도구 키 · 권한 파일 · `toolcats` 배치 · 카탈로그가 바뀌지 않는다. 포탈 점검이 이미 ‘이 서버가 자기 구조를 들여다보는’ 화면들의 자리다.

### 4.2 데이터 — 빌드 때 만든 JSON 을 서버 쪽에 싣고 API 로만 준다

- 생성기가 `docs/COMMON.md` 와 함께 **`server/src/portalcheck/commonCatalog.json`** 을 만든다(커밋되는 생성물 — `server/src` 는 패키지에 통째로 들어간다).
- **`web/public` 에 두지 않는다.** 거기 두면 로그인 없이 받을 수 있고, 목록에는 서버 내부 모듈의 설명(SSRF 판정 · 비밀 승계 규칙 · 인증 정지 등)이 들어 있다.
- API: `GET /api/tools/portal-check/common` — `adminOnly, fullScopeOnly`(다른 보기와 같은 문지기). 화면을 열 때 한 번만 받는다(폴링 없음 — 빌드 시점의 고정 값).
- JSON 모양(안): `{ version, fileCount, dynamicUnknown, scopes:[{id,title,dir}], modules:[{file,scope,summary,exports[],users,areas,areaCounts:[[영역,개수]],tests,testFiles[],twin}] }`.
  `scope` 는 공용 위치 5곳의 id 또는 `outside`. `summary` 는 문서와 같은 150자 요약.
- **사용처는 영역별 개수만 싣고 파일 목록은 싣지 않는다** — `numOrNull.js` 하나가 283개 파일이다. 테스트 파일 이름은 싣는다(모듈당 수 개~수십 개 · 상한 30).
- 크기는 **추정** 150KB 안팎(231개 모듈 × 평균 600B 가량) — 구현 때 실측해 적는다.

### 4.3 화면은 읽기만 한다

‘다시 만들기’ 단추를 두지 않는다 — 배포본에 소스가 없어 만들 수 없다(§2). 안내 줄에 ‘v… 빌드 때 만든 목록’ 을 밝히고, 목록의 버전이 실행 중인 포탈 버전과 다르면 경고 배너를 띄운다(④-4).

### 4.4 ‘못 읽은 것’ 은 0 이 아니다

파일이 없으면(④-2) · 못 읽으면(④-3) 숫자 자리는 ‘—’ 다. 파일 조각 · 경로 원문은 응답과 화면에 싣지 않는다(`safeLoadText` 규칙). ‘사용처 0’ · ‘테스트 0’ 은 판정이 아니라 살펴볼 후보라는 문구를 카드 부제와 표 아래에 둔다.

### 4.5 찾기 — 모듈 이름 · 내보내는 이름 · 설명

대소문자 구분 없이 부분 일치. 찾는 것이 없으면 ‘없다’ 고 단정하지 않고 찾은 범위(공용 위치 5곳 + 공용 위치 밖 77개)를 밝힌다(④-5) — 도메인 폴더 안에만 있는 모듈은 이 목록에 없다.

## 5. 정직하게 밝혀야 하는 것

- **재생성 부담이 늘어난다.** 지금도 공용 모듈의 import 가 늘면 `docs/COMMON.md` 를 다시 만들어야 하는데, 생성물이 둘이 된다(같은 명령 한 번이지만 `server/src` 안의 JSON 이 거의 모든 기능 커밋에서 바뀐다).
- **운영 화면으로서의 쓸모는 제한적이다.** 이 목록은 개발할 때 필요한 정보이고, 배포된 포탈에서는 릴리스 때의 고정 값이다. 문서(`docs/COMMON.md`)로 충분하다면 화면을 만들지 않는 것도 타당한 선택이다.
- 한계는 문서와 같다 — 경로를 런타임에 조합하는 동적 import 와 `pyportal/` 은 세지 못한다.
- `server/src` 에 JSON 생성물을 두는 것이 기존 소스 스윕 테스트(파일 형식 · 등록부)와 부딪히는지는 **확인하지 않았다** — 구현 첫 단계에서 본다.

## 6. 컨펌 질문(기본값 — ‘기본값대로’ 면 이대로 구현)

| # | 항목 | 기본값 | 다른 선택 |
|---|---|---|---|
| ① | 자리 | 포탈 점검의 다섯째 보기 | 독립 도구(새 도구 키 · 권한 · 카탈로그 배치가 따라온다) |
| ② | 열람 | 관리자 ∧ 전체 범위 | 설정 소유자만 |
| ③ | 공용 위치 밖 77개 | 같은 표에 ‘공용 위치 밖’ 구분으로 | 별도 표 |
| ④ | 상세 | 오른쪽 서랍(좁은 화면은 전체 화면) | 행 펼침 |
| ⑤ | 사용처 | 영역별 개수만 | 파일 목록까지(JSON 이 수 배 커진다) |
| ⑥ | 내보내기 | 없음 | CSV 내보내기 |
| ⑦ | 검증 수준 | 표준(관련 테스트 + Chromium 1440/400 1회 + CI) | 전체 검증 / 빠르게 |

## 7. 구현 기록(v3.10.0) — 시안과 다른 점

| 파일 | 하는 일 |
|---|---|
| `scripts/common-doc.mjs` | `buildJson` · `renderJson` — `docs/COMMON.md` 와 함께 `server/src/portalcheck/commonCatalog.json` 을 만들고 `--check` 가 둘 다 본다 |
| `server/src/portalcheck/commonCatalog.js` | 읽기 · 모양 검증(`missing` · `unreadable` 을 가른다 · 숫자는 `numOrNull` · 문자열 · 배열 상한) · 크기 · 수정 시각 캐시 |
| `server/src/routes/api/portalCheck.js` | `GET /tools/portal-check/common` — `adminOnly, fullScopeOnly` + `isAdminDetailUser` |
| `web/src/views/tools/CommonCatalogView.jsx` · `commonCatalogText.js` · `commonCatalog.css` | 화면 · 순수 판정/문구 · 좁은 화면 규칙 |
| `web/src/views/tools/PortalCheck.jsx` | `VIEWS` 에 `['common', '공통 기능']` |

시안과 다른 점(구현하면서 정한 것):

1. **④-4 ‘목록 버전 ≠ 포탈 버전’ 상태를 만들지 않았다.** JSON 에 버전을 실으면 릴리스의 버전업(`release.sh`)마다 목록을 다시 만들어야 하고,
   목록은 코드와 같은 패키지에 실려 어긋날 수 없다(어긋나는 경우는 ‘다시 만들지 않았다’ 뿐이고 테스트의 `--check` 가 막는다). 안내 줄의 버전은 실행 중인 포탈의 버전이다.
2. **데모 계정(admin 문맥)은 403** — 시안에 없던 것. 목록에 서버 내부 모듈의 설명과 소스 경로가 있어 관리자 판본(`isAdminDetailUser`)만 받는다.
3. 처음 열면 ‘전체’ 칩만 눌린 상태다(시안 ① 은 ‘공용 모듈’ 카드도 눌린 것처럼 그렸다). 숫자 카드는 누르면 그 조건으로 거르고, 다시 누르면 푼다.
4. 표는 처음 50행 + ‘더 보기’ 50행씩(`STable limit` — 정렬 뒤에 자른다). 시안의 12행은 그림용이었다.
5. 서랍은 기존 VM 상세 서랍(`vms/vmHub.css .vmh-drawer` — 640px · 720 미만 전체 화면)을 그대로 쓴다. 시안은 480px 로 그렸다.
6. JSON 크기는 **실측 약 176KB**(시안의 150KB 는 추정이었다) — 응답 한 번, 화면을 열 때만.
7. 공용 위치 밖 모듈은 내보내는 이름을 싣지 않는다(생성기가 공용 위치의 모듈만 읽는다) — 상세에 그렇게 적는다.
8. `server/src` 에 JSON 생성물을 두는 것이 기존 소스 스윕과 부딪히는지(§5 의 ‘확인하지 않았다’)는 전량 테스트로 확인했다 — 서버 9,883 통과 · 실패 0.

### 7.1 Chromium 판독(1440 · 400)에서 찾아 고친 것

| # | 찾은 것 | 원인 | 고친 것 |
|---|---|---|---|
| 1 | 표 · 서랍의 요약에 `**` 와 백틱이 글자로 보였다 | 요약은 소스 주석의 Markdown 원문 | 화면만 `summaryText` 로 별표를 떼고 백틱 짝은 ‘ ’ 로(문서는 원문 유지) |
| 2 | `store.js` 요약이 ‘v2.617’, `config.js` · `auth.js` · `restClient.js` 는 import 한 줄의 메모 | 생성기가 import 줄 끝 주석 · import 사이 주석 · 선언에 붙은 주석을 모듈 설명으로 읽었다 | 줄 끝 · import 사이 한 줄 메모는 건너뛰고, 선언에 붙은 주석은 내보내는 함수 · 클래스 · 기본 내보내기 · 파일과 같은 이름의 선언일 때만 모듈 설명 |
| 3 | 400px 에서 사용처 · 영역 · 테스트 열이 상자 밖 | 두 열을 숨기고도 표 최소 폭이 980px | 좁은 화면은 560px(`.cc-table`) + ‘옆으로 밀어 봅니다’ 안내 |
| 4 | 1440 에서 `startAlertNotificat ions` 처럼 식별자 가운데 줄바꿈 | 내보내는 이름 칸이 `overflow-wrap: anywhere` | `break-word`(최소 폭을 가장 긴 이름으로) |

2 의 한계(보수적인 쪽을 골랐다): import 뒤 머리 주석이 **모듈 상수에 바로 붙어 있으면**(`TaskWho.jsx` · `EscClose.jsx`) ‘설명 없음’ 이 된다 —
받으면 `store.js` 처럼 상수 하나의 설명이 모듈 설명으로 실린다. 틀린 설명이 빈 설명보다 나쁘다고 봤다. 그 파일의 머리 주석을 맨 앞으로 옮기면 실린다.
영어로 된 요약(소스 주석이 영어인 모듈)과 요약에 실린 주소(`ExportPreviewModal.jsx` 의 시안 링크)는 소스 주석 그대로다 — 고치지 않았다.
