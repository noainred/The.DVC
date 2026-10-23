# 규칙 — 보안·라우트·외부 API·감사 로그·라이선스

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/routes/ · publicapi · auth · 압축 해제 · CSP

## 목차

- (원래 1289행) express 4 는 async 핸들러의 throw 를 잡지 않는다 — 라우터를 `wrapAsyncRouter` 로 감싼다
- (원래 1313행) 범위(scope)는 '형제 라우트가 하고 있는가' 로 점검한다 — 한 파일에서 하나만 빠지면 실수다
- (원래 1360행) STARTTLS 는 '광고하지 않으면 평문으로 내려간다' 가 기본값이었다
- (원래 1366행) `new Agent(` 스윕은 'Agent 를 안 쓰는 경로' 를 못 본다
- (원래 1371행) `resilientFetch` 는 리다이렉트를 직접 따라가며 출처가 바뀌면 비밀 헤더를 뗀다
- (원래 1520행) 외부 포탈 조회 API — '전부 노출' 이 아니라 허용 목록이고, 계약은 투사(projection)가 집행한다
- (원래 1645행) 무인증으로 열리는 면을 새로 만들지 말 것 — v2.564 의 공개 API 안내 페이지는 v2.565 에 철회됐다
- (원래 1726행) `logAudit` 은 옵션 객체 하나로 부른다 — `logAudit(req, …)` 가 감사 로그 화면을 통째로 죽였다
- (원래 2989행) 무거운 내보내기(exceljs)는 동시 1건 가드가 
- (원래 3001행) `req.query` 의 값은 항상 문자열이다 — 입구에서 고정한다
- (원래 3057행) 오픈소스 라이선스 준수는 '생성물' 로 관리한다 — 손으로 적은 고지는 다음 릴리스에 낡는다
- (원래 3133행) CSP 는 기본으로 켠다 — 그리고 `/intro` 만 완화한다
- (원래 3170행) 압축 해제에는 예외 없이 `maxOutputLength`
- (원래 5120행) v2.633 — 손상 보존본만 남은 중앙 설정 파일은 관리자가 '기본값으로 확정' 한다. 나이로 자동 해제하지 않는다
- (원래 5857행) CLI 계정 관리 메뉴(v2.723) — `server/src/tools/user-admin.js` + 래퍼 `user-admin.sh` → 설치본 `sudo vmware-port
- (원래 5877행) super_admin 은 '저장 역할' 이고 요청 문맥에서는 admin + `superAdmin:true` 다

## 본문

- ⚠⚠ **express 4 는 async 핸들러의 throw 를 잡지 않는다 — 라우터를 `wrapAsyncRouter` 로 감싼다**
  (`util/asyncRoute.js`, v2.574 — 감사 BUG-01·02·03. 회귀는 `test/asyncHang2574.test.js`):
  - **증상은 500 이 아니라 '무응답' 이다.** 동기 throw 는 전역 핸들러가 500 을 주지만 async
    reject 는 **아무도 응답하지 않아** 그 요청이 클라이언트가 끊을 때까지 매달리고 **소켓 fd 를
    잡는다**. `index.js:10` 의 `unhandledRejection` 은 로그만 남기고 계속 실행하므로 프로세스는
    죽지 않는다 — **그래서 더 안 보인다**. 스윕: `routes/` 의 async 라우트 **284건 중 138건**이 무보호였다.
  - ⚠⚠ **래퍼는 핸들러를 `동기로` 부른다.** `Promise.resolve().then(() => handler(...))` 로 감싸면
    실행이 마이크로태스크로 밀려, **라우터 스택에서 핸들러를 꺼내 동기로 부르고 바로 단언하는**
    하니스가 깨진다(`test/collectorDiag2437.test.js:23` — v2.574 초판이 6통과 → 3실패로 만들었다).
    동기 throw 는 express 가 이미 잡으므로 미룰 이유도 없다. 되돌리지 말 것.
  - ⚠ **`use` 는 감싸지 않는다** — `use` 로 마운트되는 **하위 라우터**(그 자체가 `(req,res,next)`
    함수다)를 감싸면 라우터 속성이 사라진 평범한 함수가 되어 마운트가 깨진다.
    4-인자 에러 핸들러도 감싸지 않는다(인자 3개가 되면 express 가 에러 핸들러로 인식하지 못한다).
  - ⚠ **`next(err)` 로 보낸다 — 래퍼가 직접 응답하지 않는다.** 전역 핸들러가 이미 스택 은닉·
    `pushLog`·`headersSent` 를 처리한다. 두 곳이 그 판정을 갖게 하지 말 것.
  - 회귀 테스트가 ① 라우터 14개가 전부 감싸졌는지 ② **감싸기가 라우트 등록보다 앞인지**(뒤면 그
    앞 라우트는 보호되지 않는다) 를 소스로 고정한다. **새 라우터를 만들면 선언 직후에 부를 것.**
  - ⚠ **SQL 에 값을 보간하는 곳은 그 값을 먼저 좁힐 것**: `pdu/db.js rangeOf` 가 `hours`/`to` 를
    클램프하지 않아 `bucketMs` 가 `Infinity` 가 됐고 그것이 `(ts/${bucketMs})` 로 들어가
    SQLite 가 **식별자로 파싱**(`no such column: Infinity`)했다. 실측 `?hours=1e400` →
    **`000 / 8.002s`(무응답)**, 매달린 요청 40개에 fd **111 → 151**. 형제 `sanswitch/perfDb.js` 는
    라우트에서 `Math.min(24*90, …)` 로 클램프해 같은 결함을 피하고 있었다 — PDU 에만 없었다.
    클램프는 **라우트가 아니라 헬퍼**(`rangeOf`)에 둔다(새 시계열 라우트가 자동으로 보호되게).

- ⚠⚠ **범위(scope)는 '형제 라우트가 하고 있는가' 로 점검한다 — 한 파일에서 하나만 빠지면 실수다**
  (v2.574 감사 SEC-01~08. 회귀는 `test/scopeLeak2574.test.js` — **실제 라우터를 띄워 응답으로** 본다):
  - **SEC-01 유출 실증**: `routes/api/checksLogs.js:113` 이 `(_req, res)` 였다(사용자를 아예 보지
    않는다는 뜻이다). 범위 계정 응답이 **admin 응답과 바이트 단위로 동일**했다. 같은 파일의
    형제(`:78`·`vmware-config`)는 둘 다 `allowed.has(reqVc)` 로 거르고 있었다.
  - ⚠⚠ **`scopedVcenterIds()` 는 `Set` 또는 `null` 을 돌려준다.** `allowed.includes(...)` 는
    **TypeError** 이고, 그 라우트가 async 면 위 항목과 겹쳐 **응답 없이 매달린다**.
    전체 범위 계정은 `allowed === null` 이라 `&&` 에서 단락돼 **아무도 못 느낀다** — 그래서 오래 남는다.
    저장소 전수 `allowed.has(` 110곳 vs `allowed.includes(` 1곳(`bmUsage.js:124`)이었다.
    ⚠ 스윕을 `allowed.includes(` 로 넓게 잡으면 **오탐**이다 — 같은 이름의 무관한 배열이 둘 있다
    (`auth/permissions.js:322`·`svcmon/store.js:152`). `allowed = scopedVcenterIds(` 인 파일만 본다.
  - ⚠ **같은 객체 리터럴 안에서 일부 필드만 거르지 말 것**(v2.550.3 재발): `bmUsage.js` 가
    `counts`·`skippedCounts` 는 막고 옆의 `settings.corps`·`authStops` 는 무필터였다.
    `vmSeries.js` 도 `vcenters`·`usage`·`resolved` 는 거르고 옆 `status:` 가 우회했다.
  - **뺀 것은 반드시 밝힌다** — `omittedOutOfScope`·`scoped`·`corpsHidden`·`addressHidden`.
    조용히 빼면 화면이 '전부 봤다' 는 거짓을 말한다(v2.509 규약).
  - ⚠ **엣지 주소를 여는 라우트를 403 으로 막기 전에 그 화면이 누구 것인지 볼 것**:
    `/api/ping/edge/overview` 는 권한 게이트조차 없었지만(viewer 도달) 그 응답은 **메인 내비
    '네트워크 › 체크'** 가 쓴다. 403 으로 막으면 operator 의 정상 업무가 깨지므로 **주소만 가렸다**
    (v2.500 D/M1 relaycheck 이 택한 방식). adminOnly 로 올리는 것은 별건이다.
  - ⚠ **공개 API 선언(`publicapi/allowlist.js`)과 내부 라우트의 `fullScopeOnly` 를 대조할 것**:
    `/faults/parts` 는 `requiresFullScope` 가 빠져 **같은 데이터가 세션 경로에서는 403 인데 키
    경로로는 전량** 나갔다. 그 플래그는 손으로 붙이는 것이라 전 카탈로그에서 2곳뿐이었다.

- ⚠ **STARTTLS 는 '광고하지 않으면 평문으로 내려간다' 가 기본값이었다**(`util/smtp.js`, v2.574 SEC-10):
  조건이 `… && ehloCaps(ehlo).has('STARTTLS')` 하나라, 서버가 그 한 줄을 광고하지 않으면
  블록을 건너뛰고 **`AUTH PLAIN <base64>` 로 내려갔다**(base64 는 암호화가 아니다). 중간자가
  EHLO 응답에서 그 줄만 지우면 자격증명이 평문으로 나간다. 이제 **자격증명이 있으면 중단**하고
  (실증: AUTH 미전송), **없으면 진행**한다(사내 릴레이의 정상 구성 — 막으면 멀쩡한 현장이 깨진다).
  관리자가 체크를 끈 경우는 진행하되 추적 로그에 **평문 전송 사실을 적는다**.
- ⚠ **`new Agent(` 스윕은 'Agent 를 안 쓰는 경로' 를 못 본다**(v2.574 SEC-09):
  `svcmon/checker.js:113` 이 `...(test.insecure ? { dispatcher } : {})` 라 **기본(TLS 검증) 경로는
  전역 `fetch`** 로 나갔다 — CLAUDE.md v2.506 이 직접 경고한 "`globalThis.fetch` 에는 lookup 이
  없다" 가 그대로였다. 실증 기준(v2.537)으로 측정: dispatcher 있음 `ESSRFBLOCKED` / 없음
  **`ECONNREFUSED`(연결이 실제로 시도됐다)**. **두 갈래 모두에 dispatcher 를 줄 것.**
- ⚠ **`resilientFetch` 는 리다이렉트를 직접 따라가며 출처가 바뀌면 비밀 헤더를 뗀다**(v2.574 SEC-14):
  fetch 기본값 `redirect:'follow'` 는 교차 출처에서 `Authorization`·`Cookie` 만 뗀다 —
  이 저장소가 쓰는 **`X-Collector-Token`·`X-Central-Token` 같은 커스텀 헤더는 그대로 따라간다**.
  엣지가 `302 Location: https://공격자/` 한 줄만 돌려주면 중앙이 그 토큰을 보낸다.
  ⚠ `redirect:'manual'` 로 통째로 막지 말 것 — GitHub 릴리스 자산이 실제로 리다이렉트되므로
  **자동 업그레이드가 깨진다**. 뗀 헤더는 `__secretsDroppedOnRedirect` 로 밝힌다.

- ⚠⚠ **외부 포탈 조회 API — '전부 노출' 이 아니라 허용 목록이고, 계약은 투사(projection)가 집행한다**
  (`publicapi/{keys,allowlist,auth,openapi,time}.js` · `routes/publicApi.js` ·
  `routes/admin/apiKeys.js` + 웹 `views/ApiKeys.jsx`·`apiKeyText.js`, v2.562 — 사용자 질문
  "모든 기능에 대해서 api 서비스 엔드포인트를 만들어서 다른 포탈에서 읽어서 사용하게 할 수 있어?".
  선택: **조회 전용 + 허용 목록** · **전용 API 키 신규 발급** · **버전 고정 경로 + OpenAPI** ·
  **설정 화면에서 발급** · 1차 분류 **인벤토리 · 용량/사용량 · 장애/알람**):
  - ⚠⚠ **'엔드포인트가 없다' 가 아니었다** — 이 저장소의 `/api/*` 라우트는 **686개**(조회 204 ·
    상태변경 280)로 이미 있었다. 없던 것은 ① 기계 인증 ② 고정된 계약 ③ 문서다. 그래서 만든 것은
    '새 API' 가 아니라 **좁은 공개 표면**이다. 상태변경 280개에는 RMA 원격 명령 실행 · VM
    프로비저닝 · `shutdown` · 호스트 방화벽 변경 · **백업 다운로드(= `AUTH_SECRET`·TOTP 시크릿
    사본)** 가 섞여 있다 — '전부 노출' 은 외부 키 하나가 인프라를 조작한다는 뜻이다.
    `ENDPOINTS` 는 **전부 GET** 이고 테스트가 `v1.post|put|patch|delete` 가 0 임을 고정한다.
  - ⚠⚠ **`CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 을 재사용하지 말 것**(사용자 선택). 그 토큰은 엣지
    수집 데이터 열람과 **설정 배포** 권한을 주고 **범위를 좁힐 축이 없다**. viewer 비밀번호
    로그인도 아니다(세션·OTP 정책이 기계 호출과 맞지 않는다). 전용 키는 `sha256` **해시만**
    보관하고(`api-keys.json`, SECRET_FILES + `.gitignore` **둘 다**) 평문은 **발급 응답에만**
    실린다. 검증은 `crypto.timingSafeEqual`, 표기는 `tokenFingerprint` 8자(v2.560 규약 —
    **전체 해시를 내보내는 export 를 만들지 말 것**: 그 값이 곧 저장값이다).
  - ⚠⚠ **내부 응답 형태를 그대로 내보내지 않는다 — `project()` 가 선언 필드만 남긴다.** 이
    저장소의 응답은 자체 UI 전용이라 필드가 자유롭게 바뀐다(`zoning.zones` 가 숫자→배열,
    `capacityNote`→`capacityBasisNote` 로 바뀐 전례). 외부 소비자가 내부 형태에 붙으면 그
    변경이 **남의 포탈을 깨뜨린다**. `{...row}` 로 펼치지 말 것 — 지금 없는 필드가 나중에
    들어오며 조용히 샌다(v2.500 D/M1 · v2.503 S-3 와 같은 사고). 테스트가 **응답 키 집합 ==
    선언 `fields`** 를 대조하므로 내부 필드가 사라지면 **소비자가 아니라 우리가 먼저** 안다.
  - ⚠⚠ **범위 축이 없는 자원에 부분 데이터를 주지 않는다 — 403 `needs-full-scope`** 다.
    스토리지 장비는 `datacenterId`(자유 라벨)만 있고 `vcenterId` 가 없어 vCenter 범위와
    교집합할 수 없다(내부 라우트도 그래서 `fullScopeOnly`). 빈 목록은 **'장비 0대' 라는 거짓**
    이고 전량은 범위 위반이다(v2.525 규약). 화면이 그 403 을 **미리** 말한다
    (`fullScopeWarning`) — 숨기면 상대 포탈이 '토큰이 거부됐다' 고 오해한다.
  - ⚠ **`scopedVcenterIds(user, snap)` 의 `null` 은 '제한 없음' 이다** — 빈 집합으로 읽으면
    전체 범위 키가 **아무것도 못 본다**. 범위는 합성 사용자(`req.user`, `role:'viewer'`)로
    기존 판정에 태운다 — 그 역할을 넓히지 말 것.
  - ⚠⚠ **시각 표기는 `publicapi/time.js msOrNull` 하나가 소유한다**(v2.562 자체 검증에서 잡은
    결함): `snap.generatedAt` 은 **ISO 문자열**(`store.js:402`)이고 DB 계열은 epoch ms 숫자다.
    시각을 `numOrNull()` 로 통과시키면 ISO 가 **`null`** 이 되고, 이 API 의 계약이 "읽지 못한
    값은 null" 이라 그것은 **'수집 시각을 읽지 못했다' 는 거짓**이 된다(`/inventory/collection`
    의 `generatedAt` 이 실제로 그랬다). ⚠ **숫자 문자열을 `Date.parse` 에 넘기지 말 것** —
    `Date.parse('12345')` 는 **연도 12345**(epoch 3.27e14)로 해석된다. 표기는 **epoch ms 하나**다.
  - ⚠ **`normalizePeriods` 는 배열이 아니라 `{periods, dropped}` 를 돌려준다**(`storage/growth.js:43`).
    v2.562 초판이 반환값을 그대로 넘겨 `/capacity/storage-growth` 가 **통째로 500**
    (`periods.map is not a function`)이었다. 버린 개수도 응답에 밝힌다.
  - ⚠⚠ **중복 집계는 테스트가 대조해야만 갈라지지 않는다**: `/inventory/summary` 의 합계는 내부
    `/summary` 와 **같은 값이어야 하는데** 그 집계가 라우트 안에 인라인이라 꺼내 쓸 함수가 없다.
    `test/publicApi2562.test.js` 가 두 값을 대조한다(실측 17항목 전부 일치 — 단위만 Ghz/GB/TB ↔
    Mhz/MB/GB 로 다르다). ⚠ 이 대조를 지우면 중복 구현이 **조용히** 어긋난다.
  - ⚠⚠ **`guarded()` 는 `Promise.resolve().then().catch()` 로 감싼다** — express 4 는 async
    핸들러의 throw 를 잡지 않아 요청이 **응답 없이 매달린다**(v2.548 S1 실측 hang). 동기
    `try/catch` 는 async reject 를 **놓친다**. `res.headersSent` 가드도 함께 둔다.
  - **사유를 한 문구로 덮지 않는다**: 401 `missing-key`/`unknown-key`/`revoked`/`expired` ·
    403 `no-groups`/`group-denied`/`needs-full-scope` · 404 `unknown-endpoint` · 429
    `rate-limited`(+`Retry-After`) · 503 `not-collected`/`unavailable`. ⚠ **`no-groups` 는
    403 이다**(키는 유효하고 인가가 빈 것) — 401 로 두면 상대 포탈이 멀쩡한 키를 재발급한다.
    ⚠ 404 에 **경로 목록을 싣지 말 것**(열거 단서) — 카탈로그(`GET /api/v1/`)가 그 역할이고
    거기서는 이미 키가 검증된 상태다.
  - **첫 수집 미완료는 빈 배열이 아니라 503** 이다(v2.509 규약 — '데이터가 없다' 와 구분).
    목록 상한은 `meta.truncated`·`meta.omitted`·`meta.limit` 로 **밝힌다**(조용한 상한 금지).
    응답은 `Cache-Control: no-store`(키마다 범위가 달라 중간 캐시가 섞으면 남의 법인 데이터가 간다).
  - **OpenAPI 는 카탈로그에서 생성하고 그 키가 쓸 수 있는 것만 담는다** — 손으로 쓴 스펙을 두면
    문서와 응답이 갈라지고, 그때 상대 포탈은 **문서를 믿고** 잘못된 코드를 쓴다(v2.553 '조언이
    틀리면 무음 실패보다 나쁘다'). 전량을 담으면 403 이 날 경로를 '있다' 고 말하게 된다.
  - **빈 허용목록을 '전부 허용' 으로 읽지 말 것**(거부 기본값 — v2.555 규약). ⚠ 다만 **vCenter
    범위의 빈 배열은 '전체'** 다 — 도구 권한 허용목록과 **방향이 반대**이므로 화면이 그 차이를
    말한다. 모르는 분류는 **버리고 개수를 밝힌다**.
  - ⚠ **카탈로그에 없는 분류를 라벨인 척 보여주지 말 것**(v2.562 스크린샷 판독에서 발견):
    분류를 없앤 릴리스 뒤에는 옛 키가 사라진 분류를 들고 있고 그것은 아무 경로도 열지 않는다.
    코드만 덩그러니 보여주면 사용자는 **아직 유효한 분류**로 읽는다 → `portal(무효)` + 각주 1회
    (`staleGroups`). 기록은 **지우지 않는다**(무엇을 들고 있었는지가 진단).
  - ⚠ **요청되지 않은 분류를 '있으니까' 로 함께 싣지 말 것**(v2.562 정직 기록): 초판이 관리자가
    고르지 않은 `portal`(포탈 자체 상태)을 함께 넣었는데, 그것이 **선언 필드와 핸들러가 어긋난
    채로** 있었다 — 선언은 `uptimeSec`·`source`·`generatedAt` 인데 핸들러는 `startedAt`·
    `dataSource` 를 만들어 `project()` 가 3개를 영원히 `null` 로 채웠고, 근거로 읽던
    `config.startedAt`·`collector.lastSeenAt` 은 **이 저장소에 없는 필드**였다(grep 0건 →
    `edgesFresh` 가 언제나 0). 요청 범위를 넘겨 만들면 이렇게 검증이 얕아진다. 되살리려면
    **근거 필드를 코드로 확인한 뒤** 별건으로.
  - 권한은 **조회 admin · 발급/수정/폐기/삭제 adminOnly + `requireSettingsOwner`** 다 — 이 키는
    전 함대 조회 데이터에 **상시** 접근하는 자격증명이라 백업 아카이브·중앙 토폰 배달과 같은
    등급이다(v2.210 H3 기준). 전부 `logAudit` 하고 **평문은 남기지 않는다**(지문만 — v2.419).
    ⚠ `logAudit` 의 인자명은 `user`·`target`·`detail` 이다(`audit.js:53`) — `actor` 로 쓰면
    **조용히 버려진다**.
  - ⚠ **표는 가로 스크롤 컨테이너로 감싸는 것만으로 부족하다 — 표에 `minWidth` 를 줄 것**
    (v2.562 판독에서 발견): 없으면 브라우저가 스크롤 대신 **열을 짜부라뜨려** 400px 에서 셀이
    한두 글자 폭으로 세로로 길어진다(실측 페이지 높이 6,054px → `minWidth` 부여 후 3,471px).
    **넘침은 0px 이라 수치로는 안 잡힌다.** ⚠ **0 인 KPI 칸을 경고색으로 칠하지 말 것** —
    숫자는 '문제 없음' 이라 하고 색은 '문제 있음' 이라 말한다(v2.556 규약).
  - ⚠ **정직 기록 — 확인한 것과 못 한 것**: 목 서버(포트 4744)에 실제로 키를 발급해 **401·403·
    404·429·200 전 경로를 HTTP 로 돌렸고** 투사 계약·범위 403·내부 집계 대조(17항목)·평문
    미노출·Chromium 1440/400 을 실측했다. **실제 외부 포탈이 이 API 를 소비하는 것은 확인하지
    못했다** — 첫 연동에서 `GET /api/v1/` 카탈로그와 `openapi.json` 을 상대가 읽는지로 확인할 것.

- ⚠⚠ **무인증으로 열리는 면을 새로 만들지 말 것 — v2.564 의 공개 API 안내 페이지는 v2.565 에 철회됐다**
  (사용자 지시 "무인증으로 만드는 작업은 취소". 삭제된 것: `routes/publicDocs.js` ·
  `publicapi/{samples,docsSettings}.js` · 웹 `views/ApiDocs.jsx`·`apiDocsText.js` ·
  설정 › 연동 키의 on/off 스위치 · 로그인 화면의 '⇗ API 안내' 링크):
  - **되살리지 말 것.** v2.564 는 "운영 데이터가 한 바이트도 나가지 않는다"(합성 샘플만 · 스냅샷
    import 금지 · 목 vCenter 이름 0건)를 실제 HTTP 로 확인하고 만든 것이었지만, 사용자는
    **그 판단 기준 자체를 받지 않았다** — 이 포탈에서 **로그인 없이 열리는 면을 늘리는 것**이
    정책상 허용되지 않는다. '데이터가 안 샌다' 는 근거로 무인증 라우트를 정당화하려 하지 말 것.
  - **연동 문서는 계속 있다** — `docs/API-PUBLIC.md`(저장소 문서)다. 포탈이 **런타임에 무인증으로
    내보내지 않는다**는 점이 다르고, 그것이 이 철회의 전부다. 외부 연동 API(`/api/v1`) 본체와
    키 발급·관리(설정 › 연동 키)는 **그대로 살아 있다**.
  - ⚠ **이미 게시된 릴리스는 되돌릴 수 없다** — 2.564.0 번들이 현장에 있을 수 있으므로 릴리스
    노트에서 그 항목을 **지우지 않고** '철회됨' 으로 표시했다. 기록을 지우면 2.564 를 설치한
    현장이 '왜 화면이 사라졌나' 를 알 길이 없다.
  - ⚠ **v2.564 가 발견했던 별건 2개는 살린다**: ① `docs/API-PUBLIC.md` 오류 표에 `internal`(500)
    이 빠져 있던 것(표가 완전한 척하면서 실제로 오는 코드를 빠뜨렸다 — `publicApi.js:87`)
    ② `App.jsx` 의 `hashchange` 리스너가 **조기 return 아래**에 있어 로그아웃 상태에서는 등록되지
    않는다는 사실(지금은 그 경로를 쓰는 화면이 없어 되돌렸지만, **로그인 전에 보이는 화면을
    다시 만들 일이 생기면 이 함정을 먼저 볼 것**).

- ⚠⚠ **`logAudit` 은 옵션 객체 하나로 부른다 — `logAudit(req, …)` 가 감사 로그 화면을 통째로 죽였다**
  (`audit.js` + 라우트 6파일 11곳, v2.569 — 사용자 신고 "감사로그가 에러나고 안되".
  회귀는 `test/auditMiscall2569.test.js`):
  - **증상**: 설정 › 감사 로그가 `Minified React error #31 … object with keys
    {username, role, name, scope, mustEnrollOtp}` 로 **설정 탭 전체**가 죽었다. 그 키 집합은
    `auth/auth.js resolveTokenUser` 의 반환, 즉 **`req.user`** 다.
  - **원인**: `logAudit({ user, action, target, detail, ip })` 는 **첫 인자를 구조분해**하는데
    라우트 11곳이 `logAudit(req, '액션', {…})` 로 불렀다 — `user = req.user`(객체)가 그대로
    `audit.ndjson` 에 저장됐고, 화면이 `{e.user}` 와 `<option>{u}</option>` 로 렌더하다 죽었다.
    · ⚠ **더 나쁜 것 — `action` 도 함께 잃었다**(`req.action` 이 undefined → JSON 에서 탈락).
      즉 그 기록들은 **누가·무엇을 했는지 둘 다** 없다. 감사 로그의 존재 이유가 사라진 셈이다.
    · 오용 지점은 전부 v2.520~2.552 에 새로 들어온 라우트다 — `horizonSessions`(2) ·
      `bmUsage`(3) · `curUser`(2) · `storageMon`(1) · `linkCheck`(2) · `edgeLog`(1).
  - ⚠⚠ **방어선은 둘이고 둘 다 유지할 것**: ① **쓰기**(`logAudit`) 가 `auditStr` 로 전 필드를
    문자열로 굳히고 오용 형태(`headers`+`method` 가 있는 객체)를 만나면 **`console.warn` 으로
    드러낸다**(조용한 통과 금지 — v2.549 규약) ② **읽기**(`listAudit`) 도 같은 소독을 한다.
    쓰기만 고치면 **이미 저장된 줄**이 계속 화면을 죽이고(운영 파일은 우리가 고칠 수 없다),
    읽기만 고치면 새 줄이 계속 오염된다.
  - **값을 지어내지 않는다** — 객체가 오면 `username` 이 있을 때만 그것을 쓰고, 없으면
    `(형식 오류)` 다. 소실된 `action` 은 빈 문자열이고 화면이 **`작업 미기록`** 으로 그 사실을
    말한다(빈칸으로 두면 화면 결함처럼 읽힌다).
  - ⚠ **A/B 로 확정했다** — 수정 전 코드로 되돌려 같은 데이터를 띄우니 Chromium 에서
    `React error #31` 이 그대로 재현됐고(에러박스 true · 표 없음), 수정 후에는 3행이 정상
    렌더된다(에러 0). 추측이 아니라 재현이다.
  - ⚠ **왜 못 잡았나**: `logAudit` 은 반환값이 없고 실패해도 `catch {}` 라, 오용해도 **라우트는
    정상 200 을 돌려준다**. 테스트도 감사 *파일 내용* 을 보지 않았다. 그래서 회귀 테스트가
    **소스 전수 스윕**(`logAudit(req` 0건)까지 함께 고정한다 — 주석 제거 시 **개행을 보존**할 것
    (지우면 줄 번호가 밀려 엉뚱한 줄을 지목한다 — 이 테스트 초판의 실제 오탐).
  - ⚠ **라우트 파일을 고치면 `node scripts/api-doc.mjs` 를 돌릴 것**(v2.563 규약) — 이번에도
    줄 번호가 밀려 `apiDoc2563.test.js` 2건이 깨졌다.

- ⚠⚠ **무거운 내보내기(exceljs)는 동시 1건 가드가 **없으면 포탈을 죽인다** — `util/exportBusy.js`
  하나를 쓸 것**(v2.575 전수 감사에서 **실측으로 확정한 가용성 취약점**):
  `GET /api/tools/ipam.xlsx` 는 워크북을 통째로 메모리에 조립하는데 가드가 없었다. 실측 —
  순차 80회에 RSS 1.56GB → **2.62GB**(유휴 60초 뒤 728MB 로 회수되므로 **누수는 아니다**),
  **동시 5개에 728MB → 2.45GB**, 그리고 전수 퍼징 중 실제로
  `FATAL ERROR: Ineffective mark-compacts near heap limit`(8GB)으로 **프로세스가 죽었다**.
  게이트는 `requirePerm('tools')` 뿐이고 **operator 는 `tools` 를 기본 보유**하므로
  저권한 계정이 중앙 포탈을 내릴 수 있었다. 형제 라우트 `/tools/waste/export` 는 v2.500 부터
  같은 가드를 갖고 있었는데 여기만 빠져 있었다 — **20줄을 복사하면 다음 내보내기에서 또 빠진다.**
  · `acquireExport(name, req)` → 실패면 **409 `export_busy`**, `release()` 는 반드시 `finally` 에서.
  · 진행자 계정명은 **본인일 때만** 밝힌다(v2.500 감사 L-2 — 계정 열거 단서).
  · 수정 후 실측: 동시 5개 → 178MB → **550MB**(1건 200 · 4건 409), 순차 1회는 그대로 200.
- ⚠⚠ **`req.query` 의 값은 항상 문자열이다 — 입구에서 고정한다**(`util/queryNormalize.js`, v2.575 BUG-22):
  express 4 기본 파서(qs)는 `?id[a]=1` 을 **객체**, `?id=a&id=b` 를 **배열**로 만든다. 라우트는
  거의 전부 문자열을 가정하므로 `.toLowerCase is not a function` 이나 SQLite 바인드 오류
  (`Unknown named parameter 'a'`)로 **500** 이 난다. 퍼징 실측(GET 375경로 × 파라미터 119 ×
  2형태 = **89,250요청**)에서 **7경로 22건**이었다. 라우트마다 `String(...)` 을 덧붙이는 대신
  미들웨어가 모양을 고정한다 — 그래야 **다음에 추가되는 라우트가 자동으로** 보호된다.
  · 배열은 **마지막 값**(HTTP 관례), 객체는 **버린다**(`[object Object]` 로 억지 변환하면
    그것이 검색어·식별자로 들어가 **오류 없이 틀린 조회**가 된다), `__proto__` 류 키는 차단.
  · ⚠ **모든 라우터보다 앞에** 마운트할 것. 배열 쿼리를 받는 라우트를 새로 만들려면 이 모듈을 먼저 볼 것
    (도입 시점에 `Array.isArray(req.query…)` 는 저장소 전체에 **0건**이었다).
- ⚠⚠ **오픈소스 라이선스 준수는 '생성물' 로 관리한다 — 손으로 적은 고지는 다음 릴리스에 낡는다**
  (`scripts/third-party-notices.mjs` → `web/public/THIRD-PARTY-NOTICES.txt` · 루트 `LICENSE` ·
  회귀는 `test/license2576.test.js`, v2.576 — 사용자 질문 "저작권이나 라이선스를 침해했는지 확인"
  에서 **확정 위반 2건**을 찾아 고쳤다):
  - ⚠⚠ **F1(확정) — 서브셋 폰트가 예약 폰트 이름을 쓰고 있었다.** `fontTools` 로 직접 디코드해
    확정: `web/src/vendor/pretendardKsxFont.js` 는 상류 Pretendard **가변폰트(글리프 14,757)**
    를 **2,918 글리프 정적 인스턴스**로 줄인 것인데 `name` 테이블 패밀리명이 **`Pretendard`**
    그대로였다. `Pretendard-OFL.txt:2` 가 **"with Reserved Font Name Pretendard"** 를 선언하고
    OFL 1.1 의 "Modified Version" 정의는 *"adding to, **deleting**, or substituting … **by
    changing formats**"* 이므로 **글리프 삭제와 가변→정적 변환 양쪽 모두** 해당한다. 3조가
    수정본의 예약 이름 사용을 금지한다 → **`DVC Sans KSX`**(nameID 1/3/4/6)로 바꿨다.
    ⚠ **nameID 0(원저작자 저작권)은 지우지 말 것** — OFL 1조가 보존을 요구한다.
    ⚠ **jsPDF 별칭도 예약 이름이면 안 된다**(그 값이 PDF 의 폰트 리소스 이름이 된다) —
    `reportExport.js` 의 `addFont`/`setFont` 를 `'Pretendard'` 로 되돌리지 말 것.
    폰트를 다시 서브셋하면 이 이름 규칙을 **다시 적용**할 것.
  - ⚠⚠ **F2(확정) — 배포 산출물에 라이선스 사본이 없었다.**
    `packaging/offline/build-package.sh:114` 는 **`web/dist` 만** 복사한다 — `web/src` 는 패키지에
    들어가지 않으므로 `web/src/vendor/Pretendard-OFL.txt` 는 **고객에게 배포되지 않았다**(실측:
    `web/dist` 전체 grep `"Open Font License"` **0건**, 서브셋 TTF 에 nameID 13/14 도 없음).
    OFL 2조가 허용하는 세 경로(stand-alone text / human-readable headers / **machine-readable
    metadata fields**)가 **전부 비어 있었다.** → nameID 13·14 주입 +
    **`web/public/THIRD-PARTY-NOTICES.txt`**(vite 가 `web/dist` 로 복사 ⇒ 웹 배포와 오프라인
    패키지 **양쪽** 포함) + About 화면 링크. **`web/src` 에만 두면 배포되지 않는다** — 새 라이선스
    문서는 `web/public` 에 둘 것.
  - **F3 — minify 가 고지 주석을 지운다**(실측: `web/dist/assets/*.js` 118개에 `@license` 16건 ·
    `Copyright` 12건뿐인데 번들에는 d3 계열·recharts·dompurify·pako·guacamole-common-js·jspdf 가
    들어 있다). MIT·ISC·BSD 는 공통으로 사본마다 고지 동봉을 요구한다 → 생성기를 두고 CI 가
    `--check` 한다(`api-doc.mjs` 와 같은 관례). ⚠ **못 읽은 것을 조용히 넘기지 않는다** — 설치되지
    않은 의존성이 있으면 **종료코드 1 이고 문서를 쓰지 않는다**(`docsGen2452` 사고).
    **의존성을 추가·제거하면 `node scripts/third-party-notices.mjs` 를 돌릴 것.**
  - **F4 — `buffers@0.1.1` 은 라이선스 선언이 어디에도 없다**(`exceljs → unzipper → binary →
    buffers`). 오프라인 패키지가 `server/node_modules` 를 `cp -a` 로 **그대로 재배포**하므로
    허락 근거 없이 재배포되는 상태다. `precond@0.2.3` 은 README 에만 MIT. **숨기지 말 것** —
    고지 파일의 전용 절이 개수와 이름을 적는다(상용 납품 실사 대상).
  - **F5 — 루트 `LICENSE`**: 이 저장소는 **공개**인데 `package.json` 3개가 `private: true` 이고
    `license` 필드도 LICENSE 파일도 없었다. 사유 라이선스 선언 + **"제3자 구성요소는 이 조항의
    영향을 받지 않는다"** + 고지 파일 위치를 적는다.
  - **회귀 테스트는 폰트 바이너리를 실제로 디코드한다**(최소 sfnt `name` 파서) — base64 안의
    테이블은 소스 grep 으로 볼 수 없다. 비어 있는 값을 통과시키지 않도록 `assert.ok(v)` 를 **먼저**
    본다(빈 문자열이면 `!/pretendard/i` 가 공허하게 참이 된다).
  - ⚠ **카피레프트는 0건이다**(479개 전수: MIT 372 · ISC 45 · BSD-3 22 · Apache-2.0 15 · BSD-2 6 ·
    기타 소수. GPL/LGPL/**AGPL**/SSPL/BUSL **없음**. `jszip` 만 `MIT OR GPL-3.0-or-later` 듀얼이고
    MIT 선택). 서버 Apache 패키지(`crc-32`·`readdir-glob`)와 `guacamole-common-js` 는 **NOTICE 파일이
    없어** §4(d) 전파 의무가 발생하지 않는다. **새 의존성을 추가할 때 이 성질을 먼저 확인할 것.**
  - ⚠ **타 프로그램 코드 복사는 없다**(v2.576 확인): CLAUDE.md 가 읽었다고 기록한 외부 소스
    3종은 전부 **사실·필드명·수치 관계**만 참조하고 출처를 밝힌다 — `horizon-mcp`(필드명·상태값) ·
    Dell `PyU4V/tools/openapi.json`(필드 **설명문 5줄** 인용, Apache-2.0) ·
    `Comcast/libstorage`(수치 관계만, 식별자는 합성). **픽스처에 실장비 값을 넣지 말 것**(v2.513).

- ⚠⚠ **CSP 는 기본으로 켠다 — 그리고 `/intro` 만 완화한다**(`index.js` `DEFAULT_CSP`/`INTRO_CSP`,
  v2.577. 회귀는 `test/hardening2577.test.js`):
  - v2.576 까지 주석이 *"인라인 스타일/intro 페이지 호환 이슈로 기본 비활성"* 이라 적고 CSP 를
    통째로 꺼 두었는데 **그것은 측정하지 않은 가정이었다.** Chromium 실측 — 메인 포탈 **21화면
    위반 0건**, 위반은 전부 `/intro` 에서만(외부 CDN 스타일시트 2종 + `dc-runtime` 의 문자열
    `eval`). 두 문제를 묶어 적는 바람에 앱 전체가 무방비로 남아 있었다.
  - **왜 중요한가**: 세션 토큰이 `localStorage` 에 있어 **XSS 한 번이면 그대로 탈취**된다
    (v2.538 기록). CSP 가 없으면 그 위험에 **완화 수단이 하나도 없다.**
  - ⚠ **앱 정책에 `'unsafe-eval'`·`'unsafe-inline' script` 를 넣지 말 것** — 넣는 순간 위 완화가
    사라진다. `style-src 'unsafe-inline'` 은 **필수**다(React 의 `style={{}}` 은 스타일 속성이지
    스크립트가 아니다 — 이것을 빼면 화면이 통째로 깨진다).
  - `/intro` 완화가 안전한 근거: 실데이터·API 와 분리된 셀프부트 정적 데모이고 세션 토큰이 없다
    (v2.577 확인 — 사설 IP 0건·법인 문자열 0건·vCenter 이름 0건). **완화 정책을 앱으로 넓히지 말 것.**
  - ⚠ **CSP 를 바꿀 때는 A/B 로 회귀 0을 확인할 것** — v2.577 은 `CSP=off` 와 켠 상태의 콘솔
    오류가 **21건으로 동일**함을 확인했다(남은 오류는 이 컨테이너가 외부 CDN 을 막아 생기는 기존
    현상). 탈출구 `CSP=off`·`CSP=<정책>` 을 없애지 말 것.
  - ⚠ **HSTS 를 기본으로 켜지 말 것**(정직 기록): 이 현장은 IP + 자체서명 접속이 흔한데 HSTS 는
    그 출처의 http 를 **영구히** 막는다. 현재의 '실제 https 일 때만' 조건을 유지한다.
  - ⚠ **정직 기록**: `/intro` 는 외부 CDN(jsdelivr·Google Fonts)에 의존한다 — 폐쇄망에서는 글꼴만
    안 받아지고 기능은 동작하지만, 공급망 관점에서는 **공개 페이지의 외부 의존**이다(별건).

- ⚠ **압축 해제에는 예외 없이 `maxOutputLength`**(v2.577 — v2.488 L-1 의 형제 경로 누락):
  `upgrade/archive.js` 는 v2.488 에 상한을 받았는데 `backup/service.js` 의 `gunzipSync` 2곳은
  빠져 있었다. 실증 **100KB gzip → 100MB(증폭 1,029배)**. ⚠ 정직 기록 — `parseUploadedArchive` 를
  부르는 라우트는 **없어서** 지금 도달 가능한 취약점은 아니었다(잠재). 이름이 'Uploaded' 이고
  업로드 라우트를 붙이는 순간 상한 없는 경로가 되므로 먼저 막았다.
  · ⚠ **소스 검사 정규식에 `[^)]*` 를 쓰지 말 것** — `gunzipSync(fs.readFileSync(p), {...})` 의
    **첫 `)` 에서 잘려** 상한이 있는 호출을 '없다' 고 오판한다. v2.535 가 `chmodSync(FILE(), 0o600)`
    으로 **똑같은 실수**를 기록해 두었는데 v2.577 초판이 그대로 반복했다(자기 테스트가 잡았다).
    괄호 깊이로 잘라낼 것.

- ⚠⚠ **v2.633 — 손상 보존본만 남은 중앙 설정 파일은 관리자가 '기본값으로 확정' 한다. 나이로 자동 해제하지 않는다**
  (`util/settingsLoadError.js confirmSettingsDefault` + `POST /tools/service-check/settings-files/confirm` + 웹 `DavinciChecks.jsx`·
  `settingsFileConfirmText.js`, 사용자 선택 "진행"(추천 ③). 회귀 `server/test/audit2633.test.js` — 13개 파일 실제 확정 · 변이 3/3):
  - 해제는 곧 기본값(대개 꺼짐)을 전 엣지에 배포하는 것이다 — 보존본 나이로 풀면 v2.631 EDGE2631-01 을 시간차로 되살린다.
  - **새 설정 배포 모듈은 `makeSettingsLoadError(fileOf, { label, confirm })`** — confirm 은 그 모듈의 저장 함수로 지금 기본값을 쓴다
    (저장 성공이 곧 `ok()`). 테스트 ① 이 전 호출부의 label·confirm 을 소스로 고정하고 **등록 수 13 을 고정**한다(늘면 FILES 도 갱신).
  - 서버는 등록부에 있는 파일 이름만 받는다(경로 조작 404) · admin + 전체 범위(`settingsFleetOnly`) · 감사 로그 · 보존본은 지우지 않는다 ·
    저장했는데 여전히 못 읽으면 `still-error`(성공이라 말하지 않는다).
  - ⚠ 역할 게이트 테스트는 `AUTH_ENABLED=true` 로 — 꺼져 있으면 requireRole 이 익명(admin)으로 통과시켜 operator 가 200 을 받는다(이번에 실제로 그랬다).
- ⚠⚠ **CLI 계정 관리 메뉴(v2.723) — `server/src/tools/user-admin.js` + 래퍼 `user-admin.sh` → 설치본 `sudo vmware-portal-users`**(사용자 요청 "cli 로 계정 생성 · 특정 계정은
  비밀번호로 로그인 · 계정 편집 · ascii 메뉴"). 회귀 `server/test/userAdmin2723.test.js`(변이 3/3):
  · 계정별 로그인 방식은 **새 저장소를 만들지 않고** 기존 `login-policy-users.txt`(v2.273 사용자별 재정의)를 쓴다 — `securitySettings.setFileLoginPolicy`(그 사용자 줄만 바꾸고 주석·다른 줄 보존, 0600)·
    `loginPolicyOverrideOf`(파일·env 출처 구분). 포탈이 3초 캐시로 다시 읽으므로 **재시작 불필요**. 관리자에게 '비밀번호' 를 지정하면 경고 + 확인.
  · ⚠⚠ 메뉴가 보여 주는 로그인 판정(`userAdminText.loginStateOf`)은 `authenticateLocal`·`isOtpOnlyUser` 규칙을 글로 옮긴 것이다 — **그 규칙을 바꾸면 여기도**.
    테스트가 역할 3 × 비번 × OTP × 방식 4 = 48 조합을 **실제로 로그인해** 대조한다.
  · 계정·비밀번호·OTP 변경은 users.json 직접 쓰기라 **실행 중인 포탈은 재시작해야 안다**(otp-enroll 과 같다) — 끝날 때 재시작을 묻고(래퍼가 root 일 때 종료코드 10 → systemctl restart),
    동작마다 디스크를 다시 읽는다(`auth.reloadUsersFromDisk` — 메뉴를 띄워 둔 사이 포탈 저장을 덮어쓰지 않게). ⚠ users.json 이 아직 없으면 다시 읽지 않는다 —
    다시 시드하며 initial-admin-password.txt 를 다른 값으로 덮어썼다(자체 검증에서 발견). `trusted:true` 신뢰 경로(otp-enroll 과 같은 판단)이지만 데모 역할 고정·수퍼관리자 삭제 불가·마지막 관리자 보호는 그대로.
  · 비밀번호는 화면에 찍지 않는다(TTY 는 입력 숨김, 테스트가 출력에 비밀번호 0 을 고정). 한글 폭은 `dispWidth`(2칸)로 맞춘다 — 글자 수로 맞추면 오른쪽 테두리가 밀린다.
  · 패키지: `build-package.sh` 가 복사, `install.sh` 가 링크, `uninstall.sh` 는 **이 설치본을 가리킬 때만** 링크를 지운다(OTP 링크와 같은 규칙). in-app 업그레이드 설치본은 링크가 없어 `<설치경로>/app/user-admin.sh` 로 실행한다.
- ⚠⚠ **super_admin 은 '저장 역할' 이고 요청 문맥에서는 admin + `superAdmin:true` 다**(`auth/roles.js authzRole`, v2.643 — 사용자 요청
  "super_admin role · noainred 는 super_admin · CSV 가져오기/내보내기는 관리자 이상 · 권한 설정 메뉴에 · super_admin 은 super_admin 만 추가/삭제"):
  - 코드에 `role === 'admin'` 판정이 약 87곳·`requireRole('admin')` 이 수백 곳이라 새 역할을 요청 문맥에 그대로 내보내면 전부 거부된다.
    그래서 `resolveTokenUser`·`authenticateLocal` 이 **접는다**. 저장 레코드를 볼 때만 `isAdminTier(role)` 을 쓴다(마지막 관리자·OTP 강제 판정).
    **새 코드에서 `role === 'super_admin'` 을 req.user 에 대고 비교하지 말 것** — 절대 참이 되지 않는다(`req.user.superAdmin` 을 본다).
  - super_admin 계정의 생성·삭제·역할·비밀번호·OTP 변경과 super_admin 역할 부여는 **요청자의 저장 역할이 super_admin** 일 때만
    (`superAdminGuardDenied`, 코드 `super-admin-only`). 콘솔 도구·중앙 동기화(`trusted`)는 예외지만 **중앙 관리 계정 동기화는 super_admin 을
    만들지도 건드리지도 않는다**. AD 토큰·`AUTH_DISABLED_ROLE` 은 super_admin 이 될 수 없다. `noainred` 는 기동 시 super_admin 으로 올린다.
  - 권한 키 **`data.csv`**(관리 그룹, `adminOnly`+`adminToggle`): operator·viewer 행에서는 항상 빠지고, admin 은 기본 보유이며
    **`matrix.adminDenied` 로 super_admin 만 끌 수 있다**(끄기·되돌리기·기본값 초기화 모두 super_admin). `SCHEMA_VERSION` 3.
    `userHasPermission`: superAdmin → 전부 · admin → adminDenied 외 전부(모르는 키도 통과 — 기존 동작) · 그 외 역할 행.
  - CSV·자유텍스트 가져오기/내보내기/샘플 라우트 약 90곳이 `csvPerm = requirePerm('data.csv')` 다. `server/test/superAdmin2643.test.js` 가
    **라우터 스택을 훑어** CSV 경로 전부에 이 게이트가 있는지(≥80) 고정한다 — 새 CSV 라우트는 게이트를 붙이거나 `NOT_CSV` 에 사유를 적을 것.
    svcmon `/targets/import` 는 JSON 표 입력을 예외로 두는 `csvPermUnlessJson`(fullScopeOnly 뒤), `/targets/csv-schema` 는 스키마 설명이라 열어 둔다.
  - 화면은 `api.canCsv()` 로 CSV 버튼을 **숨긴다**(약 40화면). ⚠ 브라우저에서 표를 CSV 로 만드는 버튼은 **화면 숨김일 뿐**이다 — 데이터는 이미
    화면에 있다(정직 기록). ⚠ svcmon 결과 로그 파일 다운로드(`/svcmon/log/files/:name`)는 게이트하지 않았다(판단 필요로 남김).


  · v2.770(점검 R5-E5): 범위 계정 원격 접속은 **(vcenterId, targetHost) 쌍**으로 판정(`proxy/targetHostScope.js resolveScopedTarget`·`mappingTargetScopeIssue`) — vcenterId 가 비면 일치 객체에서 유일하게 유도하고 모호·범위 밖 중복은 거부,
    유도한 vCenter 로 중계를 고르고 매핑에 저장, WS·/rdp/:id 도 같은 쌍으로 재검사. quick-connect 재사용은 proxyId·vcenterId 일치(소유자 없는 매핑은 admin 만). 매핑 포트는 정수 1~65535, ':' 는 IPv6 대상만.
    인증 off 의 WS 게이트웨이도 HTTP 와 같은 합성 사용자(AUTH_DISABLED_ROLE)로 역할·매핑 판정을 탄다.
