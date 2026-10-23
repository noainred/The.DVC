# 규칙 — Horizon 세션·앱 사용·현재 사용자(Windows)

> 루트 `CLAUDE.md` 에서 옮긴 기록(2026-10-20, v2.746 시점). 문구는 원문 그대로이고 목록 들여쓰기만 한 단계 줄였다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 이 영역 코드를 고치기 전에 이 파일을 읽을 것. 새 교훈은 테스트 → 이 파일 순으로 남기고 루트 CLAUDE.md 에는 쌓지 않는다.

**언제 읽나**: server/src/{horizon,curuser}/ · web/src/views/tools/Horizon*·CurrentUsers*

## 목차

- (원래 1881행) '현재 사용자' 는 게스트 계정을 쓰지 않는다 — 게스트가 발행한 값을 읽는다
- (원래 1921행) Horizon 실시간 사용자는 '접속 중 세션의 고유 계정' 이다
- (원래 1958행) Horizon 앱·데스크톱별 사용 현황(v2.684) — 어느 앱인지 모르면 '팜(앱 미구분)' 이고, 누적은 하한이다
- (원래 1975행) Horizon 연결 서버 등록 화면은 `web/src/views/HorizonAdmin.jsx` 한 벌이다
- (원래 1983행) v2.686 — 연결 테스트는 확인한 기능만 말한다 · 판정은 `server/src/horizon/featureProbe.js` 하나
- (원래 2004행) Horizon 서버 등록도 CSV/자유텍스트 대량 등록을 쓴다 — 코어는 그대로 하나다

## 본문

- **'현재 사용자' 는 게스트 계정을 쓰지 않는다 — 게스트가 발행한 값을 읽는다**(`curuser/`, v2.520 —
  사용자 요청 "vcenter 별로 설정에서 지정한 폴더의 windows 서버에서 로그인한 사용자의 수를 설정에서
  지정한 시간마다 수집" · "10분마다 db 에 저장" · "aaa 가 1개의 vcenter 의 여러 서버에 로그인해
  있으면 그건 1명" · **"Guestos 계정 없이"**):
  - **경로**: 게스트의 스케줄 작업이 `quser` 출력을 base64 로 `vmtoolsd --cmd "info-set
    guestinfo.curuser.*"` 에 실어 VMX 에 쓰고, 포탈은 vCenter `config.extraConfig` 를 **읽기만**
    한다. 게스트 계정도, 게스트→포탈 아웃바운드도 없다. `gpu/guestops.js`(NamePasswordAuthentication)
    경로로 되돌리지 말 것 — 사용자가 명시적으로 배제했다.
  - ⚠ **미검증 전제(정직 기록)**: 게스트가 `info-set` 한 값이 **재부팅 전에도** vCenter
    `config.extraConfig` 조회에 나타나는지 확인하지 못했다. 확인된 것은 ⓐ 게스트에서 비관리자도
    `vmtoolsd --cmd` 로 VM 구성을 바꿀 수 있다 ⓑ 재부팅 후 VMX 에 영구 반영된다(open-vm-tools
    issue #288) 두 가지뿐이다. 그래서 `no-agent` 문구는 '발행기 미설치 **또는** 이 환경이 노출하지
    않음' 두 가지를 **함께** 말한다 — 실장비 1대로 확인되면 문구를 좁힐 것.
  - ⚠ **이 값은 게스트가 스스로 쓴 것**이라 게스트 사용자가 위조할 수 있다 — 모니터링용이지
    **감사 증적이 아니다**. 화면의 `TRUST_NOTE` 를 지우지 말 것.
  - **게스트는 판단하지 않는다** — 원문을 base64 로 싣기만 하고 파싱·상태 지역화(`활성`/`연결 끊김`)
    판정은 포탈 `quser.js` 가 한다. 게스트에서 파싱하면 파서를 고칠 때마다 **수백 대 재배포**다.
    스크립트 내용은 **ASCII 만**(한글 주석은 인코딩에 따라 문법 오류가 된다), 발행 순서는
    **`d*` → `n` → 부가값 → `at` 마지막**(반대면 '새 시각 + 옛 데이터' 로 **거짓 신선**이 된다).
    빈 값은 `-` 로 쓴다(`info-set key ` 는 뒤에 공백만 남는다) — 읽는 쪽이 되돌린다.
  - **'확인하지 못한 서버' 를 '사용자 0명' 으로 뭉개지 말 것.** 상태는 7가지다 — `ok` / `stale` /
    `no-agent` / `guest-error` / `incomplete` / `unparsed` / `clock-skew`. `stale` 서버의 사용자는
    **세지 않고**(지금 값이 맞는지 모른다) 몇 대가 빠졌는지 화면이 밝힌다. 수치는 실패 시 `null`
    이다(0 으로 채우면 '0명' 이라는 거짓).
  - **신선도는 조회 시점에 `at`(게스트 발행 시각)으로 다시 판정한다**(`report.js refreshKinds`) —
    엣지가 push 를 멈추면 중앙 DB 에 `kind:'ok'` 로 며칠 전 값이 남는다. `no-agent`·`guest-error`·
    `unparsed` 는 신선도로 덮어쓰지 않는다(원인을 지우지 않는다).
  - **주기는 두 개이고 합치지 말 것** — ① 포탈이 읽는 주기(`intervalMs`, 기본 10분) ② 게스트
    발행 주기(`guestPublishMs`, 각 서버 schtasks 가 정하므로 포탈이 강제 못 한다). 신선도 경계는
    **②×배수**다. 합치면 포탈 주기를 바꾸는 순간 게스트에 손도 안 댔는데 전 서버가 '오래됨' 이 된다.
  - **메인 인벤토리 수집에 `config.extraConfig` 를 넣지 말 것** — 5,850 VM × 수십 키가 매 폴링마다
    실려 온다. `curuser/collect.js` 가 **대상 moref 만** 따로 배치 조회한다(주기 10분, 왕복 1~2회).
    `vcenter/orphanScan.js` v2.505 와 같은 판단이며 테스트가 고정한다.
  - **폴더 범위가 비면 수집하지 않는다**(전체 VM 으로 확대 해석 금지). 기본 꺼짐(opt-in).
  - DB 계열 수는 먼저 계산했다 — vCenter별 추이 연 152만행(보존 180일 ≈ 75만행), **VM 단위 계열은
    `CURUSER_VM_SERIES=1` 옵트인**(연 2,100만행). 계정명은 **최신 1건에만** 두고 시계열에 넣지 않는다.
  - 화면 회귀(스크린샷 판독으로 잡은 것 — 수치로는 안 잡혔다): 루트 그리드에 `minWidth:0` 만으로는
    부족하고 **열 트랙을 `minmax(0,1fr)`** 로 못 박아야 한다(암시적 트랙이 `auto`=max-content 라
    표가 뷰포트를 넘긴다. 400px 실측 357px → 기준선 228px). 설정 숫자칸도 `minWidth:0` 이 없으면
    설명문 폭으로 자라 옆 칸과 겹친다.
- **Horizon 실시간 사용자는 '접속 중 세션의 고유 계정' 이다**(`horizon/sessions.js`·`sessionCollect.js`·
  `sessionDb.js`·`sessionPoller.js` + 웹 `views/tools/HorizonSessionsPanel.jsx`·`horizonSessionText.js`,
  v2.525 — 사용자 요청 "Horizon 솔루션 사용중인데 실시간 사용자를 뽑고 싶어"):
  - **화면은 '현재 사용자' 하나이고 소스 탭으로 나눈다**(사용자 선택 "한 화면에 합치기 — 소스 탭"):
    `전체(합집합) | Windows 서버 | Horizon(VDI)`. 전체 = **Windows ∪ VDI**(`curuser/combine.js`) —
    같은 사람이 양쪽에 있으면 1명이다. **단순 합과 겹친 인원을 함께** 낸다(하나만 보여주면 전제가
    감춰진다). ⚠ 한 출처를 못 읽으면 `partial` 로 밝히고 **'전체' 라고 말하지 않는다**.
    ⚠ '레코드가 있다' 를 '읽었다' 로 뭉개지 말 것 — 전 서버가 `stale`/`no-agent` 면 지금 유효한 값은
    **하나도 없다**(목 데이터 실측: 43대 중 stale 41·no-agent 2 인데 `state:'ok'` 였다. `kinds.ok > 0`
    을 본다).
  - **상태 필드를 읽지 못하면 `connected` 는 0 이 아니라 null** 이다 — 0 은 '지금 아무도 없다' 는
    거짓이다. 한 서버라도 못 읽으면 **합계도 단정하지 않는다**(부분 합이 더 위험한 거짓).
  - **계정명이 없고 SID 만 있으면 `userIdOnly` 로 밝힌다** — SID 로도 인원 수는 정확하지만 **이름을
    보여줄 수 없다**. SID 를 이름인 척 표시하지 말 것. SID 는 Windows 쪽 이름과 **절대 겹치지 않으므로**
    합집합에서 `sidOnly` 로 그 사실을 적는다(실제로는 같은 사람일 수 있다 — 지어내지 않는다).
  - ⚠ **응답 필드명을 확인하지 못했다**(정직 기록): `developer.broadcom.com` 등 공식 문서가 이 환경의
    egress 정책에서 차단이다. 경로 `GET /rest/inventory/v1/sessions`(page·size, size 최대 1000)와
    필터명 `user_name`·`desktop_pool_id`·`machine_name`·`client_name`·`state`, 상태값
    `CONNECTED`/`DISCONNECTED`/`PENDING` 은 `matt-coppinger/horizon-mcp`
    (`src/horizon_mcp/tools/inventory.py:533-556`, "verified against 2512~2606")에서 직접 읽었고,
    응답의 **계정명 필드가 `user_name` 인지는 미확정**이다. 그래서 **후보 키 체인**으로 읽고
    `usedUserKey`/`usedStateKey` 를 화면이 밝힌다(v2.522 `usedCmds` 규약). 실장비 응답을 받으면
    체인을 좁히고 고지를 지울 것 — **체인을 '기본값 user_name' 으로 굳히지 말 것.**
  - **로그인·로그아웃·TLS·SSRF 설정은 `horizon.js withHorizonSession` 하나가 갖는다** — 라이선스
    조회와 공용이다. 복사하면 `dispatcher`(사설 인증서·DNS 리바인딩 가드)와 로그아웃 누락 방지가
    두 갈래로 갈라진다. **새 Horizon 조회를 추가하면 이 함수를 쓸 것.**
  - **자격증명 스토어를 새로 만들지 않는다** — 설정 › Horizon 등록(`horizon.json`)을 재사용한다.
    비밀 승계(`util/secretCarry.js`)·SSRF 가드를 두 곳에서 지키게 만들지 말 것.
  - 실패는 **원인별로** 구분한다(`auth`/`no-endpoint`(404)/`http`/`timeout`/`unparsed`) — 조치가
    정반대다. **자동 재시도 금지**(AD 계정 잠금). 기본 **꺼짐(opt-in)**, 주기 5분(하한 1분).
  - DB 는 `horizon-sessions.db` — **원시 세션 객체를 저장하지 않는다**(1만 세션을 매 주기 직렬화하지
    않기 위해 계정·풀 집계만). 실패 주기의 수치는 **NULL**. ⚠ `Number(null) === 0` 이라
    `Number.isFinite(Number(v))` 만 보면 **null 이 0 으로 바뀐다** — v2.525 의 자체 테스트가 이 결함을
    `sessionDb.nOrNull`·`sessions.seriesRow`·웹 `unionNote` **세 곳에서** 잡았다. 새 null 허용 수치를
    쓸 때 `v == null` 을 먼저 볼 것.
  - Horizon 은 **vCenter 에 매인 자원이 아니다** — 법인 범위로 나눌 축이 없으므로 범위 제한 계정에는
    **403(`requiredOwner`)** 으로 거절한다. 빈 값을 주면 '사용자 0명' 이라는 거짓이 된다.
- ⚠⚠ **Horizon 앱·데스크톱별 사용 현황(v2.684) — 어느 앱인지 모르면 '팜(앱 미구분)' 이고, 누적은 하한이다**
  (`horizon/appUsage.js`(순수 해석) · `appUsageReport.js`(순수 보고서) · `sessionCollect.js` 카탈로그 · `sessionDb.js` `hz_usage_daily`·`hz_usage_cover`
  + `GET /tools/horizon-sessions/usage`·`usage.csv` + 웹 `views/tools/HorizonUsagePanel.jsx`·`horizonUsageText.js`, 사용자 요청 "커넥션 서버나 UAG API 로
  어떤 사용자가 어떤 서비스를 쓰는지 실시간·누적" → 1단계(커넥션 서버만 — UAG 는 세션 수만 주고 앱을 모른다). 회귀 `server/test/horizonUsage2684.test.js` + 웹 `horizonUsageText.test.js` — 변이 8/8):
  · **새 로그인을 만들지 않는다** — 앱 풀(`/rest/inventory/v1/application-pools`)·데스크톱 풀·팜 목록은 **세션 조회와 같은 `withHorizonSession` 안에서**,
    6시간(`HZ_CATALOG_TTL_MS`)에 한 번 · 실패 뒤에는 30분 뒤에만 다시 읽는다. 데스크톱 풀·팜 경로는 버전이 붙어(`v13`·`v10`) 후보 체인이고 읽은 경로를 보고한다.
    실패해도 **직전 목록을 지우지 않고** 실패를 새 성공으로 기록하지 않는다(`at` 그대로 · `failedAt`).
  · **해석 순서가 계약이다**(`resolveServices`): 세션의 앱 이름 필드(후보 체인 — **확인된 필드 없음**) → 앱 풀 ID → 앱 세션의 팜(앱 하나면 그 앱 `farm-single-app`,
    여럿이면 `kind:'farm'`) → 데스크톱 풀 → 미확인. **팜에 앱이 여럿인데 하나를 골라 붙이지 말 것**(오류 없이 틀린 값). 근거(`basis`)를 서비스마다 싣고
    웹 `BASIS_TEXT` 와 1:1(테스트 대조). 서비스 키는 `종류:이름(소문자)` — 같은 이름 앱은 팟이 달라도 한 서비스다.
  · **누적은 하한이고 화면이 매번 말한다**(주기 폴링이라 짧은 실행은 안 잡힌다). 하루 1행 upsert 의 관측·수집 횟수는 **더 늦은 ts 일 때만** 늘린다(같은 주기 재적재 금지).
    **수집이 없던 날은 0명이 아니라 null('수집 없음')** · 지나간 날 중 기대 횟수의 절반 미만은 `partial` · 일평균 분모는 수집이 있던 지나간 날만.
  · '지금 접속 중' 은 최신 수집 레코드의 `latest.services` 다 — 최신 수집 성공 서버가 0대면 '—'(0 아님), 여러 서버 합은 '+' 표지(같은 사람 중복 가능).
  · 조회 기간 상한 92일(행 수 비례 동기 집계 — v2.672·v2.675), 최신 수집 시각 키로 결과 기억, 폴링 금지(마운트 + 버튼). 범위 계정 403(Horizon 은 법인 축이 없다).
    CSV 는 `data.csv` + 감사 로그. 계정명 가림은 상위 패널 정책 그대로이고 **가린 상태에서는 계정명으로 검색되지 않는다**(검색으로 이름을 알아내는 우회 차단).
  · ⚠ 정직 기록: 공식 문서는 여전히 차단 — 근거는 공개 코드 `matt-coppinger/horizon-mcp`. 실장비 커넥션 서버로는 확인하지 못했다(합성 데이터·가짜 응답).
    첫 실수집에서 '이름을 안 근거' 열을 볼 것 — '팜까지만 앎' 이 많으면 그 버전 세션 응답에 앱 이름 필드가 없다는 뜻이고, 2단계(이벤트 DB)가 답이다.
- **Horizon 연결 서버 등록 화면은 `web/src/views/HorizonAdmin.jsx` 한 벌이다**(v2.685, 사용자 신고 "설정에 Horizon 등록 메뉴가 없어"):
  설정 › Horizon 연결 서버(`#/settings/horizon-admin`, variant page — 실시간 사용자 수집 설정 모달도 연다)와 라이선스 만료 도구(variant details)가
  같은 `HorizonServerManager` 를 쓴다. 등록 폼을 다시 복제하지 말 것. ⚠ 통신 점검 딥링크(`linkcheck/settingsKinds.js SETTINGS_PATHS`)가 전부
  `#/settings?tab=…` 라 어떤 메뉴에도 맞지 않았다(첫 해시 조각이 'settings?tab=…' 이 된다) — 설정 주소는 `#/settings/<하위 키>` 이고
  `server/test/settingsLinks2685.test.js` 가 모든 링크가 실제 메뉴·도구·탭 키인지 고정한다. **화면 문구에 메뉴 이름을 적으면 그 메뉴가 실재하는지 볼 것.**
  주소는 `horizon.js normalizeHorizonHost` 하나(IP·호스트명 → https:// · 경로 제거 · http 존중)를 저장·연결 테스트·대량 등록이 쓰고,
  ⚠ `accessMoved` 에도 **정규화된 host** 를 넘긴다 — 원문으로 비교하면 표기만 다른 같은 주소에서 저장 비밀번호를 버린다(변이 검증). 대량 등록 조언은 `hostForm:'url-auto'`.
  연결 테스트는 로그인과 라이선스 조회를 나눠 말한다 — 라이선스 404 는 '로그인 성공 · 그 서버에 라이선스 API 없음'(버전·다른 API 응답을 함께 싣는다, 필드 이름은 실장비 미확인).
- ⚠⚠ **v2.686 — 연결 테스트는 확인한 기능만 말한다 · 판정은 `server/src/horizon/featureProbe.js` 하나**(사용자 스크린샷 + curl, 실장비 Connection Server 7.13.1.
  회귀 `server/test/horizon2686.test.js`(23) + 웹 `horizonAdmin2686.test.js`(22) — 변이 14/14 + 리뷰 반영 17/17):
  · v2.685 는 라이선스 경로만 보고 "실시간 사용자·앱별 사용 수집은 동작할 수 있습니다" 라고 말했는데 그 서버의 세션 경로는 404 였다. 이제 **같은 로그인 한 번** 안에서
    기능별(`FEATURES` — 경로는 수집기 상수 `SESSION_PATH`·`CATALOG_PATHS` 를 그대로 쓴다)로 `page=1&size=1` 을 한 번씩 조회한다. **기능을 늘리면 FEATURES 와 웹 `FEATURE_LABEL` 을 함께**.
  · 성공 = **2xx + JSON**(배열 기대면 배열). 사용자 브라우저 실측: 토큰 없는 요청은 없는 경로에도 200 HTML(509B)이고, 토큰을 붙인 요청은 없는 경로에 404 JSON 이다 —
    그래서 인증된 404 는 '그 서버에 그 API 가 없다' 로 읽는다. 후보 경로는 404 일 때만 다음으로, 시도한 경로는 전부 `attempts` 에 남긴다.
  · 실측 경로(7.13.1, 인증): `/rest/monitor/connection-servers` 200 · `monitor/v1`·`config/v1/connection-servers` 404 · 라이선스·세션·앱 풀 404 · 데스크톱 풀·팜 200.
  · 같은 로그인으로 버전을 읽었으면 'UAG·로드밸런서인지 확인' 을 안내하지 않는다(그 주소는 커넥션 서버다). **근거 없는 최소 버전 숫자를 적지 말 것**(v2.685 '8 2006 이상' 은 근거가 없었다).
  · 로그인 2xx 인데 토큰이 없으면 `no-token`(로그인 성공이라 말하지 않는다). 세션 수집 분류: **로그인 단계** 401/403 만 `auth`(주기 정지 대상) · 로그인 뒤 401/403 은 `forbidden`(역할 권한 — 정지하지 않는다) ·
    로그인 404 는 `no-login-endpoint`. 세션 404 서버는 주기 수집만 `HZSESS_NO_ENDPOINT_BACKOFF_MS`(기본 6시간) 쉰다(수동·등록 변경은 즉시 재확인, 인메모리).
  · 라이선스 404 는 6시간 기억(`kind:'unsupported'`) · 실패 중 이어 보이는 직전 라이선스 행은 `stale`·`lastOkAt` 을 든다.
  · ⚠ `HorizonSessionsPanel` 이 import 하는 `horizonSessionText.kindAdvice` 는 **문자열**이다(`curUserText.kindAdvice` 는 객체) — v2.574 가 다른 모듈을 근거로 `.text` 를 붙여
    조치 안내가 한 번도 안 떴다. **같은 이름 함수의 반환 모양을 모듈마다 확인할 것.**
  · 정직 기록: 다른 Horizon 버전의 경로 가용성은 확인하지 못했다. 7.13.1 에서 실시간 사용자를 보려면 Horizon 8 업그레이드나 다른 수집 방식이 필요하다(범위 밖).
  · **같은 릴리스 적대적 리뷰 반영**(확정 15 · 반증 1, 변이 17/17): 쉬는 종류는 `BACKOFF_KINDS`(세션 404 · 로그인 404 · 토큰 없음 — 뒤 둘은 커넥션 서버가 아닐 수 있는 주소로
    AD 자격증명을 반복 전송하지 않으려고) · **로그인이 된 결과**(ok·forbidden·no-endpoint·unparsed)는 인증 정지를 푼다 · v2.685 가 로그인 뒤 403 으로 남긴 정지(사유가 '세션 조회 실패')는 기동 후 첫 주기에 푼다 ·
    **쉬는 주기는 최신값 표에 쓰지 않는다**(`sessionDb.commitHzSessions` — 쓰면 '마지막 조회' 가 방금이 되고 포탈 문구가 '장비가 돌려준 사유' 칸에 들어간다). 다음 확인 시각은
    `/tools/horizon-sessions` 행의 `backoffUntil` → 상세 창 `backoffNote` · 연결 테스트가 세션·라이선스 성공을 확인하면 쉬기·라이선스 404 기억을 지운다 ·
    연결 테스트 예산 `TEST_BUDGET_MS`(45초) < 대량 테스트 행 시한(60초) — 넘긴 기능은 `not-tried` · 로그인(64KB)·라이선스(4MB)·기능 조회(1MB) 본문 상한(`readJsonCapped`) ·
    로그인 뒤 401 은 웹에서도 '역할 권한' 으로 말한다(수집 쪽 forbidden 과 같은 뜻) · 세션이 안 되는 서버의 앱·데스크톱 풀·팜 줄은 '지금은 영향이 없습니다'.
    ⚠ env 기본값을 `6 * 3_600_000` 처럼 곱셈식으로 쓰면 `env-doc` 생성기가 첫 숫자(6)를 기본값으로 적는다 — 리터럴로 쓸 것.
- **Horizon 서버 등록도 CSV/자유텍스트 대량 등록을 쓴다 — 코어는 그대로 하나다**(`horizon/bulk.js` +
  `routes/admin/horizonAssign.js`, v2.525 — 사용자 요청 "호라이즌 서비스에 호라이즌 서버 등록이
  필요하면 csv/text import/export 기능 추가해줘"):
  - **판정 코어는 `util/bulkImport.js`**(v2.513), 화면은 `views/tools/BulkDeviceIo.jsx` 하나다.
    도구마다 다른 것만 주입한다 — 경로 조각(`resource='servers'`)·단위 이름(`unitLabel`)·타입 열
    숨김(`typeCol={null}` — Horizon 은 장비 타입이 없다).
  - ⚠ **식별 키는 `id` 단독**이다(`upsertHorizon` 이 id 로 찾고 **host 중복을 거부하지 않는다**).
    스토리지 `host+type`·SAN 스위치 `host` 와 다르다 — host 로 두면 정상 구성(같은 host, 다른 id)이
    막히고 id 중복은 **조용히 덮어써진다**.
  - ⚠ **host 의 정답 형식이 도구마다 다르다.** Horizon 은 `https://커넥션서버` 가 **필수**라
    기본 조언("URL 이 들어갔습니다 — 주소만 남기세요")은 **틀린 조언**이 된다(Chromium 판독에서 실제로
    떴다). `enrichAdvice(..., { hostForm: 'url' })` 로 알려줄 것 — **조언이 틀리면 무음 실패보다 나쁘다**
    (사용자가 잘못된 수정을 한다). 같은 이유로 중복 조언도 **그 도구의 키 이름**을 지목한다
    (`specialAdvice` 가 사유 문자열에서 키를 뽑는다 — 언제나 'host' 라고 말하던 것을 고쳤다).
  - **접속처(host·계정·도메인)가 바뀌면 저장 비밀을 승계하지 않는다**(v2.503 규약) — 그 행은
    비밀번호를 비우면 검증이 'password는 필수입니다' 로 떨어진다. **이것이 정상 동작**이고 우회를
    만들지 말 것. 저장 시 폐기된 비밀은 `skipped` 에 사유로 실어 **사용자에게 알린다**.
  - 내보내기·샘플에 **비밀번호를 담지 않는다**. 연결 테스트는 `bulkRun`(kind `'horizon'`) 재진입
    가드 — 연타가 AD 로그인 시도를 곱하지 않게.

  · v2.770(점검 R5-E5-3): 커넥션 서버의 세션 목록이 **배열이고 비어 있으면** 상태 수치는 0 으로 확정(stateBlind 아님) — 유휴 팟 하나가 전체 '접속 중' 을 '—' 로 만들었다. 비배열은 여전히 모름.
