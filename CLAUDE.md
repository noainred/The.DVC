# CLAUDE.md

## 프로젝트

VMware Global Monitoring Portal — 전세계 분산 vCenter 인프라를 통합 모니터링하는 포탈.
백엔드(Node/Express 집계 API) + 프론트엔드(React/Vite 대시보드). 자세한 내용은 `README.md`.

- 개발 브랜치: `claude/vmware-global-monitoring-portal-nrnpnt`
- 빌드 검증: `npm run verify` (= `npm test` 단위테스트 + `npm run build` 웹빌드). 서버 실행은 `node server/src/index.js`
  - 단위 테스트는 `server/test/*.test.js`(node:test). 핵심 로직 변경 시 테스트를 추가/갱신하고 커밋 전 `npm test` 통과 확인.
- 오프라인 패키지: `packaging/offline/build-package.sh` (Rocky Linux 9)

## 운영 환경 (성능 설계 시 반드시 고려)

- vCenter: **현재 28개 vCenter(~658 호스트·~5,850 VM), 향후 30+까지 확장 예정**. 글로벌 분산.
- 사용자(포탈)는 **한국**에 위치. 일부 vCenter(예: **폴란드, 미국 동부**)는 **RTT 800ms 초과**.
- 고지연·다수 vCenter 환경이므로:
  - **매 폴링 주기마다 이벤트 루프를 블로킹하는 동기 작업 금지**(예: 대량 SQLite write는 반드시 트랜잭션으로 묶기). 과거 IPAM 동기화가 무트랜잭션으로 6천 행 25초 블로킹 → 전체 UI 지연 발생, 트랜잭션으로 해결.
  - vCenter 수집은 **병렬 + per-vCenter 타임아웃**. 느린 1개가 전체 폴링을 막지 않게 한다.
  - 30개 vCenter·고RTT 확장을 가정해 수집/직렬화/DB write를 O(N)·논블로킹으로 유지.
- 적용된 성능 메커니즘(회귀 방지 — 유지할 것):
  - **수집 동시성 제한**(`store.collectPool`, `COLLECT_CONCURRENCY` 기본 8): 28개를 한꺼번에 수집하면 매 주기 SOAP 파싱이 몰려 CPU 순간 100%. 동시 개수를 제한해 평탄화.
  - **폴러 재진입 가드**: `setInterval(()=>asyncFn())` 폴러는 이전 주기가 간격을 넘기면 중첩 실행돼 CPU 누적 악화. store.refresh/idrac.pollOnce/metrics.sampleOnce/nsx.refresh/gpu.pollOnce/collector.pullNow는 진행 중이면 이번 틱을 건너뛴다(새 폴러 추가 시 동일 가드 필수). 같은 작업의 수동 실행 API도 가드를 공유할 것(net/monitor.runMonitorNow 패턴).
  - **롤업 O(N)**(`withRollups`): 호스트/VM/DS/알람을 vCenter별 1회 그룹핑 후 조회(`pick`). 그룹마다 전체 재순회(O(N×vCenter)) 금지.
  - **시계열 prune 스로틀 + ts 인덱스**: 매 샘플 DELETE 스캔 금지 — N틱마다 1회(store 10틱·metrics 20틱·idrac.poller 10틱). `DELETE WHERE ts<?`는 `ts` 단독 인덱스가 있어야 풀스캔을 피한다(복합 `(server_id,ts)`로는 못 탐).
  - **ETag/304**(`util/compress.js`): res.json 래퍼가 본문 SHA-1로 약한 ETag를 발급하고 If-None-Match 일치 시 304(본문 0바이트). 이 래퍼는 res.end로 직접 종료해 Express 기본 ETag가 동작하지 않으므로, 응답 경로 수정 시 ETag 발급을 없애면 프론트 `pollFetch`의 304 지원이 통째로 죽는다(과거 실제 그 상태였음 — 15초 폴 × 30초 스냅샷이면 절반이 무변동 재전송).
  - **SQLite PRAGMA**: idrac/metrics/logs DB는 `WAL + synchronous=NORMAL + busy_timeout=3000`(단건 insert 5ms→0.01ms 실측). **ipam.db만 예외** — 외부 프로그램이 직접 읽는 공유 파일이라 저널 기본(DELETE) 유지 + busy_timeout만. WAL 전환 금지(외부 리더의 -wal/-shm 호환 미확인).
  - **전력 latest 인메모리 캐시**(`idrac/db.js withLatestCache`): latestAll(GROUP BY MAX)은 테이블 풀스캔이라(90일 수렴 시 수억 행) 매 30초 3회 호출이 초 단위 블로킹이었음. 기동 시 1회 시드 후 쓰기 경로에서 O(1) 갱신 — **getDb() 래퍼를 우회한 직접 쓰기 금지**(캐시가 낡음). 전력 대시보드 24h 집계는 60초 캐시(`idrac/service.js aggCache`).
  - **대량 export 청크 패턴**(`routes/api.js gpuSeriesExport`): 대량 시계열 조회는 5만 행 ts 윈도우 청크 + 청크 사이 `setImmediate` 양보 + 행 상한(`GPU_EXPORT_MAX_ROWS` 기본 30만). 1M행 동기 dump는 이벤트 루프 ~10초 정지 실측 — 새 export 추가 시 동일 패턴 필수.
  - **웹 폴링 뷰 오류 처리**: 데이터 보유 중 일시 폴링 오류 1회로 화면 전체를 ErrorBox로 갈아치우지 않는다 — `if (error && !data)`일 때만 전체 오류, 그 외엔 배너(고RTT에서 대시보드 깜빡임 방지). 스코프(파라미터) 변경 시 usePolling이 직전 데이터를 비워 이전 스코프 데이터 표시를 막는다.
  - 미해결 후속: node worker_threads로 동기 SQLite 쓰기/SOAP 파싱 오프로딩, 전력 대시보드 시간당 롤업 테이블(캐시 미스 첫 요청의 윈도우 스캔 제거), 위임 잡 인출 2단계 확인응답(claim→ack), 업그레이드 적용 중 라이브 SQLite cpSync 정합성.

## 보안 불변조건 (회귀 방지 — 유지할 것)

2026-06-27 전수 감사와 2회 후속 하드닝(v2.190.0·v2.191.0)으로 확립된 규칙. 되돌리면 감사 지적이 재발한다.

- **전역 TLS 디스패처 금지**: `setGlobalDispatcher`로 프로세스 전체 fetch의 인증서 검증을 끄지 않는다(과거 vCenter용 설정이 업그레이드 번들·NSX까지 오염). 자체서명이 필요한 곳만 로컬 디스패처를 `dispatcher:` 옵션으로 주입한다(`vcenter/restClient.js vcDispatcher`, `nsx/client.js`, `util/resilientFetch.js wanAgent`).
- **WAN(중앙↔엣지) TLS 기본 검증 ON**: `WAN_TLS_INSECURE`는 `=== 'true'`일 때만 검증 해제. 의미를 반전시키지 말 것(과거 '미설정=검증 off'였고 그 구간으로 토큰·자격증명이 흐른다).
- **상태변경 라우트 RBAC**: `/api` 의 POST/PUT/PATCH/DELETE에는 `requireRole('admin','operator')`를 붙인다(읽기성 POST 제외). WS SSH/RDP 게이트웨이도 역할을 검사한다.
- **토큰 검증은 `resolveTokenUser` 하나로**: `verifyToken`을 직접 호출해 `payload.role`을 신뢰하지 말 것 — tokenVersion 폐기·최신 역할 반영이 우회된다(WS 게이트웨이에서 실제로 뚫렸던 경로).
- **central 엔드포인트의 agent 바인딩**: `routes/central.js` 미들웨어가 '개별 토큰 ↔ agent' 일치를 강제한다. 새 엔드포인트가 `?agent=`/`body.agent`로 데이터를 고르면 그 미들웨어를 우회하지 않게 할 것(자격증명 횡탈 차단).
- **자격증명 파일은 원자적 쓰기 + 로드 손상 보존**: `util/atomicWrite.js`의 `atomicWriteFileSync`로 쓰고(직접 `fs.writeFileSync` 금지), **로드 catch에서 파싱 실패 시 `preserveCorrupt(FILE)`로 `<file>.corrupt.<ts>` 보존** 후 빈 값 반환. 쓰기만 원자적이고 로드가 손상을 조용히 `[]`로 넘기면, 다음 저장이 온전했던 원본을 빈 목록으로 덮어써 전 자격증명이 영구 유실된다(3차 감사 지적 — vcenters/nsx/collectors/users 4종이 이 비대칭이었음). portal.env(CENTRAL_TOKEN)도 원자적으로 쓴다.
- **소유자 경계는 서버측 강제**: `settingsOwners`(설정 소유 계정)처럼 UI가 숨기는 권한 경계는 서버에서도 검사한다(`routes/admin.js requireSettingsOwner`). 클라이언트 전용 게이트는 admin이 API를 직접 호출해 우회·소유자 목록 탈취가 가능하다.
  - **백업 라우트도 소유자 경계에 포함**: 백업 아카이브는 `portal.env`(AUTH_SECRET·CENTRAL_TOKEN)·
    `users.json`(TOTP 시크릿)·`vcenters.json` 등 자격증명 사본이라 `/api/admin/backup/*` 전부에
    `requireSettingsOwner`를 건다(v2.210). AUTH_SECRET이 새면 임의 계정 토큰 위조로 OTP 정책·
    소유자 경계가 동시에 뚫린다. 백업 확장자 화이트리스트(`.json`/`.env`)를 넓히면
    `settings-owners.txt`가 복원 대상이 되어 소유자 목록을 갈아끼울 수 있으니 넓히지 말 것.
  - 유효 소유자 = **UI 저장분 + 서버 파일/환경변수(`settings-owners.txt`·`SETTINGS_OWNERS`) + 중앙 배포 admin + `noainred`**.
    뒤 세 가지는 `security-session.json`에 기록하지 않아 **UI 저장이 지울 수 없다** — 전원이 설정에서
    잠기는 사고의 복구 경로이므로 `fileSettingsOwners()` 합산을 제거하지 말 것.
- **RDP 자격증명은 티켓으로**: RDP WS 게이트웨이는 username/password/domain을 URL 쿼리스트링에 싣지 않는다 — `proxy/rdpTicket.js`의 1회용 단기 티켓(`POST /api/remote/rdp-ticket`)으로 발급받아 쿼리엔 티켓 ID만 싣고 게이트웨이가 인메모리에서 조회한다(쿼리스트링은 상위 프록시 액세스 로그·브라우저 히스토리에 남음).
- **업그레이드 번들 sha256 필수**: 자체 업그레이드·엣지 푸시 양쪽 모두 검증하고, 부재도 거부(`UPGRADE_ALLOW_UNVERIFIED`만 예외). 한쪽만 검증하면 함대 확산 경로가 뚫린다.
- **SSRF 가드**: 외부 입력 host를 네트워크로 찌르는 신규 기능은 `collector/registry.js ssrfBlockReason`(또는 async `ssrfBlockReasonResolved`)를 통과시킨다. RFC1918은 사내망 대상이라 허용, 링크로컬/루프백/우회표기(IPv4-mapped·10/16/8진수)는 차단.
- **셸 명령 조립**: 사용자·원격 출력 값은 화이트리스트 정규식으로 검증 후에만 삽입(선행 `-` 차단 포함). 원격 명령의 출력(유닛명·경로)도 신뢰하지 말고 재검증한다.
- **OTP는 1회용 + 잠금**: 로그인·민감작업 재인증 모두 사용 카운터(minCounter)를 대조하고 실패 잠금을 건다.
- **고권한 OTP 전용 + 강제 등록(v2.206)**: admin/operator 로컬 계정의 최종 상태는 OTP 전용이며,
  '부트스트랩 → 강제 등록 → 비번 폐기' 3단계로 도달한다. 이 3단계를 하나라도 빼면 안 된다:
  1. OTP 미등록 계정만 비밀번호 로그인 허용(최초 설치·계정 발급 직후 경로).
  2. 그 세션은 `mustEnrollOtp`가 붙고 **`requireEnrolled`가 /api 전 보호 라우터를 차단**한다
     (`/api/auth/{me,totp/begin,totp/confirm}`만 열림). 새 보호 라우터를 mount 할 때
     `authMiddleware` 뒤에 `requireEnrolled`를 빠뜨리면 등록 전 세션이 그 API를 쓸 수 있다.
  3. `confirmTotpEnroll`이 **passwordHash 삭제 + tokenVersion 인상**을 수행한다 — 이 삭제를
     제거하면 비밀번호 로그인 경로가 영구히 남아 정책이 무의미해진다. admin이면
     `initial-admin-password.txt`도 함께 지운다.
  - `mustEnrollOtp`는 토큰이 아니라 `resolveTokenUser`에서 **매 요청 사용자 레코드 기준**으로
    계산한다(등록 즉시 반영·우회 불가).
  - ⚠️ **콘솔 등록 도구(`server/src/tools/otp-enroll.js` + 래퍼 `otp-enroll.sh`)를 없애지 말 것** —
    헤드리스 등록과 '모든 admin이 OTP 분실' 잠금 복구 경로다. 래퍼는 번들 Node 경로·CONFIG_DIR·
    서비스 계정 강등을 처리하므로 문서에서 `node`를 직접 안내하지 말 것(root 실행 시 users.json이
    root 소유가 되어 포탈이 쓰기 불가). 기동 시 `warnIfNoOtpAdmin()`이 부재를 경고한다.
    긴급 해제는 `OTP_ROLE_ENFORCE=false`. viewer·데모는 강제 대상이 아니다.
- **기능 권한은 서버가 진실의 원천**: `auth/permissions.js` 매트릭스 + `requirePerm(key)`로 라우트를
  보호한다. 프론트 `can()/toolAllowed()`는 UX 게이팅일 뿐이므로, 새 상태변경 라우트에 `requirePerm`을
  빠뜨리면 메뉴만 숨겨진 채 API가 열린다. WS SSH/RDP 게이트웨이도 `userHasPermission('remote.access')`로
  검사한다(role 하드코딩 금지). admin은 항상 전 권한(매트릭스로 낮출 수 없음 — 관리자 잠김 방지).
- **사용자 scope는 조회 경로에서 강제**: `auth/scope.js scopedVcenterIds`를 `applyFilters`·`/vcenters`에
  적용해 요청 필터로 우회할 수 없게 한다. 새 인벤토리 조회 API를 추가하면 동일하게 적용할 것.
  - **id를 직접 받는 단건 라우트는 `inUserScope()`로 별도 검사**한다(목록 필터가 안 걸리는 경로).
    `/vms/:id/console`·`/vms/:id/metrics`·`/hosts/:id/metrics`가 그 예이며, 범위 밖은 403이 아니라
    **404**로 응답해 존재 여부도 흘리지 않는다. 누락 시 범위 제한 계정이 전 사이트 VM의 콘솔
    티켓을 발급받을 수 있다(v2.207 실제 수정 사례 — `vm.console`은 viewer 기본 권한).
- **WS 게이트웨이는 미들웨어를 타지 않는다**: SSH/RDP upgrade 핸들러는 `requireEnrolled`·
  `requirePerm`이 자동 적용되지 않으므로, 인증·권한·**`mustEnrollOtp`**를 모두 핸들러 안에서
  직접 검사해야 한다(v2.207: 등록 전 세션이 터널을 열 수 있던 결함 수정).
- **미인증 응답에 계정명을 싣지 않는다**: `/api/auth/config`는 로그인 전 조회되므로
  `settingsOwners` 같은 *계정명 목록*을 넣으면 관리자 계정 열거 단서가 된다. 소유자 판단은
  인증 후 `/auth/me`의 `isSettingsOwner` 불리언으로 내려준다(서버는 `requireSettingsOwner` 유지).
- **특수 계정 보호**: `noainred`(superuser)는 admin 고정·강등/삭제/로그인차단 거부 + settingsOwners 자동
  포함, `thedvcdemp`(demo)는 viewer 고정·삭제 거부. 시드(`ensureSuperUser`/`ensureDemoUser`)는 같은
  이름의 기존 수동 계정을 덮어쓰지 않는다(하이재킹 방지).

## 서비스 허브(`pyportal/`) 불변조건 — 6차 감사(v2.214.0)

별도 페이지·별도 프로세스로 도는 Python 허브(표준 라이브러리 단독). **프레임워크가 없다는 것은
프레임워크가 대신 해 주던 방어를 직접 유지해야 한다**는 뜻이다. 아래를 되돌리면 6차 감사 지적이 재발한다.

- **쿠키 자격증명은 조회(GET/HEAD)에서만**: `X-Settings-Token`·`X-Hub-Token` 쿠키를 상태변경까지
  인정하면 CSRF 가 성립한다 — 교차출처 POST 는 `Content-Type: text/plain` 이면 프리플라이트 없이
  전송되고 그 본문이 그대로 JSON 으로 파싱된다(실측 201). 상태변경은 **커스텀 헤더 필수**이며,
  `Origin`/`Sec-Fetch-Site` 로 교차출처 상태변경을 **403** 으로 한 번 더 막는다(`_credential`/`_cross_site`).
- **임의 URL 점검은 로그인 필수**: `POST /api/health/check` 의 `urls` 는 서버가 대신 요청을 보내는
  기능이라 미인증 공개 시 **사내망 포트 스캐너**가 된다(열린 포트 `healthy 200`, 닫힌 포트
  `Connection refused` 로 구분됨). 미인증은 **등록된 바로가기 재점검만** + 30초 쿨다운(`public_check_cooldown`).
- **미인증 응답에 서버 경로·설치 상태를 싣지 않는다**: `/api/meta` 의 `initialPasswordFile` 은
  **로그인한 사용자에게만**. 경로 노출은 구조를 드러낼 뿐 아니라 "초기 비밀번호가 아직 유효하다"는
  사실을 알려 표적을 지정해 준다(Node 쪽 `/api/auth/config` 계정명 금지와 같은 규칙).
- **로그인 실패 잠금은 출발지(IP)별**: 전역 카운터 하나만 두면 아무나 몇 번 틀리는 것으로
  **정상 관리자까지 설정 화면에서 밀어낼 수 있다**(가용성 공격). 전역 상한은 임계값 10배로
  분산 시도 방어에만 쓴다(`SessionStore.GLOBAL_FACTOR`).
- **소켓 타임아웃·동시 연결 상한 유지**: 핸들러 `timeout = 20`(slowloris·유휴 keep-alive 정리),
  `HubServer` 의 연결 세마포어 64(스레드 폭주 차단). 유휴 종료는 오류 로그로 찍지 않는다.
- **요청 본문은 라우팅 전에 일괄 drain**: 본문을 쓰지 않는 핸들러(리셋·백업 생성) 뒤의 요청이
  `501 Unsupported method ('{}PUT')` 로 깨진다(keep-alive desync).
- **SSRF 가드·스킴 화이트리스트·리다이렉트 미추적**: `hub/ssrf.py` 는 **해석된 주소**를 검사해
  10진수·IPv4-mapped 우회를 자동 차단하고, RFC1918 은 사내 대상이라 허용한다. 저장 URL 은
  `http`/`https` 만 — `javascript:` 를 허용하면 카드 클릭이 스크립트 실행 경로가 된다.
- **CSP 때문에 인라인 style/script 금지**: 색상은 CSS 클래스로. 화면은 사용자 입력을 `textContent`
  로만 렌더한다(innerHTML 조립 금지).
- **백업은 자격증명 사본**: `users.json`(비밀번호 해시) 포함 → 목록·다운로드·복원은 admin 세션만,
  파일은 0600.

## 프론트엔드 회귀 방지

- **React 훅은 조기 return 위에서 선언**: `if (!data) return <Loading/>` 같은 조기 반환 뒤에 `useState`를
  추가하면 렌더 간 훅 개수가 달라져 **React #310으로 화면 전체가 크래시**한다(v2.202 사용자 관리에서 실제
  발생 → v2.203 긴급 수정). 뷰에 상태를 추가할 때는 항상 컴포넌트 최상단에 선언할 것.

## 사용자 선호 (반드시 준수)

- **항상 한글로 응답**: 모든 답변/설명 메시지는 한국어로 작성한다.
- **작업 시작 시 난이도 표시**: 모든 작업을 시작할 때 응답 맨 앞에 난이도와 권장 모델을
  한 줄로 표시한다. 형식: `난이도: 낮음/보통/높음 — Sonnet 적합 | Opus 권장`.
  (단순 편집·UI·엔드포인트=낮음/보통→Sonnet, 아키텍처·동시성·대규모 리팩터·미해결 버그=높음→Opus)
- **새 작업 요청 시 진행상태 표 표시**: 새로운 작업 요청을 받으면 응답 맨 앞(난이도 다음)에
  "작업 현황" 표를 보여준다. 열: `작업 | 상태 | 비고`. 상태는 `✅ 완료 / 🔄 진행중 / ⏳ 대기`.
  현재 진행 중인 작업 + 추가로 해야 할 작업(미릴리스 포함)을 모두 한 표에 정리해 진행여부를 보인다.
- **`.` 입력 시 작업 현황 표 응답**: 사용자가 `.` 하나만 입력하면(상태 확인 핑),
  현재 **작업중(🔄 진행중)** 인 작업과 **대기중(⏳ 대기)** 인 작업을 "작업 현황" 표
  (`작업 | 상태 | 비고`)로 정리해 보여준다. 릴리스 폴링 등 백그라운드 확인도 표에 포함하고,
  진행/대기 항목이 전혀 없으면 "모두 완료" 상태와 최근 완료 릴리스 버전을 간단히 알린다.
- **PR 자동 진행**: 작업 완료 시 별도 요청 없이 PR을 생성/갱신한다.
- **PR 완료 시 GitHub 다운로드 링크 자동 안내**: 모든 PR 작업(푸시/머지 등)이 끝나면,
  요청을 기다리지 말고 자동으로 GitHub 다운로드 링크를 함께 알려준다.
  - 브랜치 소스 ZIP:
    `https://github.com/noainred/The.DVC/archive/refs/heads/<branch>.zip`
  - 머지된 경우 main 기준 ZIP:
    `https://github.com/noainred/The.DVC/archive/refs/heads/main.zip`
  - 해당 PR 링크도 함께 제공한다.
- **작업 완료 시 자동 업그레이드가 되도록 반드시 릴리스를 게시**(★사용자 강조): 기능 작업이
  끝나면 버전업·커밋·PR 로 끝내지 말고, **운영 포탈이 원격으로 새 버전을 받을 수 있게
  GitHub 릴리스까지 게시**한다. 바이너리는 git에 커밋하지 않고 GitHub Actions(`.github/
  workflows/release.yml`)가 롤링 `downloads` 릴리스에 게시한다. 절차:
  1. `package.json`(루트/서버/웹 3개) 버전 semver 인상 + `server/src/release-notes.json` 추가.
  2. 변경을 개발 브랜치에 커밋·push 하고 PR 생성/갱신.
  3. **릴리스 게시(필수)**: PR 을 main 에 머지한 뒤, release 워크플로를 돌린다.
     - 권장: main 에 `v<버전>` 태그 push → CI 가 main(=새 버전) 기준으로 빌드·게시.
     - 태그 push 가 프록시 등으로 막히면 대안: release 워크플로를 **main 기준 workflow_dispatch**
       로 수동 실행(`actions_run_trigger run_workflow release.yml ref=main`). 버전은 태그명이
       아니라 `package.json` 에서 읽으므로 동일하게 동작한다.
  4. CI 가 `versions.json` 의 `latest` 를 새 버전으로 갱신하고 설치 패키지·업그레이드 번들을
     `downloads` 릴리스 자산으로 올린다 → 그래야 원격/오프라인 **자동 업그레이드가 작동**한다.
  - 릴리스 자산 베이스: `https://github.com/noainred/The.DVC/releases/download/downloads`
  - 게시 누락 = 자동 업그레이드 정지의 직접 원인이므로, 기능 PR 머지 후 릴리스 게시·CI 성공까지
    확인하고 사용자에게 보고한다.
  - ⚠️ **자산 1000개 상한**: 롤링 `downloads` 릴리스는 GitHub 상한(릴리스당 1000 자산)에 걸리면
    업로드가 422로 전부 실패한다(자동 업그레이드 정지). release.yml이 업로드 직전
    `prune-assets.mjs`로 **최근 15개 버전만 유지**(`VERSIONS_KEEP`)하고 `versions.json`도 트리밍한다.
    릴리스가 실패하면 CI 로그에서 `file_count limited to 1000` 여부를 먼저 확인할 것.
  - 릴리스 폴링 확인: `versions.json` 의 `latest` 가 새 버전으로 바뀌는지 확인
    (`https://github.com/noainred/The.DVC/releases/download/downloads/versions.json`).
