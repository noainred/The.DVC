# 보안 감사 보고서 — VMware Global Monitoring Portal (The.DVC)

> 작성: 전체 소스 6개 영역 병렬 정적분석(인증/권한 · 명령주입 · SSRF/TLS · 시크릿/로깅 · 입력검증 · 프론트엔드).
> 대상 커밋 기준: `claude/vmware-global-monitoring-portal-nrnpnt`.
> 성격: 사내 단일테넌트 운영 포탈. 다수 항목이 admin 인증 뒤에 있으나, "포탈 admin → 원격 인프라(수집기/에이전트/게스트)에서 root 코드 실행"으로 신뢰경계를 넘는 것이 핵심 위험.
>
> ⚠️ **이 문서는 최초(1차) 감사 시점의 기록이며 대부분 항목은 이미 조치되었습니다.**
> 조치 이력은 v2.190.0(1차 하드닝) · v2.191.0(2차) · v2.195.0(3차 재감사)에서 진행되었고,
> 아래 "인증·권한 후속 강화(v2.196~2.204)"에 이후 변경이 정리되어 있습니다.
> 항목별 최신 상태·잔여 백로그는 [docs/AUDIT-2026-06-27.md](docs/AUDIT-2026-06-27.md)를 기준으로 보세요.

## 인증·권한 후속 강화 (v2.196 ~ v2.204)

1차 감사의 C4(`/api` 역할 가드 없음)·C5(원격접속 비-admin 허용)·H3(WS 게이트웨이 역할 미검증)은
`requireRole`로 1차 해소되었고, 이후 아래와 같이 **기능 단위 권한 + 인증 강화**로 확장되었습니다.

| 버전 | 강화 내용 |
|---|---|
| v2.196.0 | **기능 권한 매트릭스**(17개 권한 키) 도입 — `auth/permissions.js` + `requirePerm(key)`. WS SSH/RDP 게이트웨이도 role 하드코딩 대신 `userHasPermission('remote.access')`로 검사. **사용자별 데이터 범위(scope)** — `auth/scope.js`로 조회 API(`applyFilters`·`/vcenters`)에서 vCenter/리전 가시성 서버측 제한. 매트릭스는 `permissions.json`에 원자적 쓰기 + 손상 시 `.corrupt` 보존. |
| v2.197.0 | VM 상세 3버튼 개별 권한(`vm.reconfig`/`vm.console`/`remote.access`) — 사양변경·콘솔 라우트에 `requirePerm` 적용. 특수기능 40여 도구 **도구별 접근 제어**(deny-list). |
| v2.202.0 | 데모 계정 `thedvcdemp` — viewer 고정·삭제 불가, **비번 미설정 시 로그인 불가**. `clearLoginCredentials`(비번/OTP 제거 + tokenVersion 인상으로 활성 세션 즉시 폐기). |
| v2.203.0 | 수퍼관리자 `noainred` — admin 고정(로드 시 강등 복구)·강등/삭제/로그인차단 거부·settingsOwners 자동 포함. |
| v2.204.0 | **고권한 OTP 전용 로그인** — admin·operator 로컬 계정의 비밀번호 로그인 차단(403 + 등록 안내, 무차별 대입 카운터 미집계, 감사 로그 기록). 초기 구축 잠금 방지 유예(첫 admin OTP 등록 시 자동 종료). 긴급 해제 `OTP_ROLE_ENFORCE=false`. |

## 4차 감사 (v2.207.0) — 신규 표면(권한·scope·OTP 온보딩) 집중 점검

v2.196~2.206 에서 도입된 기능 권한 매트릭스 · 사용자 scope · OTP 강제 등록 · 특수 계정 ·
콘솔 등록 도구를 대상으로 재점검했다. **확정 결함 3건을 수정**했으며, 신규 CRITICAL 은 없다.

| # | 심각도 | 항목 | 원인 | 조치(v2.207.0) |
|---|---|---|---|---|
| S1 | 🟠 HIGH | **OTP 등록 전 세션이 SSH/RDP 터널 개통 가능** | HTTP 라우터는 `requireEnrolled` 로 막았지만 **WS 업그레이드는 미들웨어 체인을 타지 않아** 게이트가 없었다. 부트스트랩 비밀번호로 로그인한(아직 OTP 미등록) 관리자가 내부 서버로 대화형 SSH/RDP 를 열 수 있었다 | `sshGateway.js`·`guacdTunnel.js` 의 upgrade 핸들러에서 `user.mustEnrollOtp` 를 직접 검사해 403. 정적 회귀 테스트로 누락 방지 |
| S2 | 🟠 HIGH | **사용자 scope 우회 — 범위 밖 자원의 콘솔·성능·이름 조회** | scope 는 목록 API(`applyFilters`)와 `/vcenters` 에만 적용돼 있었고, id 를 직접 받는 경로는 무검사였다. 특히 `vm.console` 은 viewer 기본 권한이라 **범위 제한 계정이 전 세계 임의 VM 의 콘솔 티켓을 발급**받을 수 있었다 | `auth/scope.js` 에 `inUserScope()` 추가 후 `/vms/:id/console`·`/vms/:id/metrics`·`/hosts/:id/metrics` 에 적용(범위 밖은 404 — 존재 여부도 미노출), `/vms/lookup`·`/api/remote/targets` 는 허용 집합으로 필터 |
| S3 | 🟡 MEDIUM | **미인증 응답의 관리 계정명 노출** | `/api/auth/config`(공개)가 `settingsOwners`(설정 소유 *계정명* 목록)를 그대로 내려줘 유효 관리자 계정 열거 단서가 됐다(1차 감사 C1 의 잔여 항목) | 공개 응답에서 제거하고, 인증 후 `/auth/me`·로그인 응답에 **`isSettingsOwner` 불리언**만 제공. 프론트 게이팅을 그 값으로 전환(서버는 계속 `requireSettingsOwner` 로 강제) |

### 점검했으나 문제 없음으로 확인
- 권한 매트릭스 편집(`/api/admin/permissions`)은 `adminOnly` — operator 가 자기 권한을 상향할 경로 없음. 저장 시 카탈로그 화이트리스트·도구 키 슬러그 검증으로 임의 키 주입 차단.
- `mustEnrollOtp` 는 토큰이 아니라 `resolveTokenUser` 가 **매 요청 사용자 레코드에서 계산** — 등록 즉시 반영되고 구토큰으로 우회 불가.
- `confirmTotpEnroll` 의 비밀번호 삭제 + `tokenVersion` 인상으로 등록 후 비밀번호 경로가 실제로 소멸(파일 기준 검증).
- 특수 계정 보호(`noainred` 강등/삭제/차단 거부, `thedvcdemp` viewer 고정)는 서버측에서 강제.
- 콘솔 등록 도구/래퍼: 시크릿을 콘솔에만 출력, 래퍼가 서비스 계정으로 강등 실행해 `users.json` 소유권 훼손 방지. 외부 QR 서비스 사용을 경고로 억제.
- 로그인 테마 20종: `dangerouslySetInnerHTML`/`eval` 없음 — 모든 값이 React 자동 이스케이프 경로.
- `setupState()` 가 노출하는 비밀번호 **파일 경로**는 이미 문서에 공개된 고정 위치이며 값은 미노출, 등록 완료 후 노출 중단.

## 5차 감사 (v2.210.0) — 파일 취급·공개 표면·소유자 경계 재점검

파일 경로 처리 · 원격 명령 조립 · 공개 엔드포인트 · 신규분(v2.208 설정 소유자 파일, v2.209 도구
잠금 표시)을 점검했다. **확정 결함 2건을 수정**했고 신규 CRITICAL 은 없다.

| # | 심각도 | 항목 | 원인 | 조치(v2.210.0) |
|---|---|---|---|---|
| S4 | 🟠 HIGH | **백업 아카이브 인출이 설정 소유자 경계를 우회** | 백업은 `CONFIG_DIR` 의 `.json`/`.env` 를 통째로 담는다 — **`portal.env`(AUTH_SECRET·CENTRAL_TOKEN) · `users.json`(TOTP 시크릿·비밀번호 해시) · `vcenters.json`(vCenter 자격증명)** 전부. UI 는 '설정' 탭이 소유자 전용이지만 API 는 `adminOnly` 여서, **소유자가 아닌 admin 이 `/api/admin/backup/download/:name` 을 직접 호출해 통째로 인출**할 수 있었다. `AUTH_SECRET` 이 새면 임의 계정(수퍼관리자 포함) 토큰을 위조할 수 있어 **OTP 전용 정책과 소유자 경계가 동시에 무너지고**, `users.json` 의 TOTP 시크릿으로 OTP 코드까지 생성 가능하다 | 백업 7개 라우트(status·settings·now·download·view·delete·restore)에 `requireSettingsOwner` 추가. 다운로드·복원은 **감사 로그** 기록. 정적 회귀 테스트로 가드 누락 방지 |
| S5 | 🟡 MEDIUM | **보안 설정 조회가 소유자 계정 목록을 노출** | `GET /api/admin/security/session` 이 `adminOnly` 라, 소유자가 아닌 admin 이 `settingsOwners`(설정 소유 *계정명* 목록)를 열람할 수 있었다. 4차에서 미인증 노출은 막았지만 인증 후 경로가 남아 있었다(누구를 노려야 하는지 알려주는 단서) | 조회에도 `requireSettingsOwner` 적용(변경 PUT 은 4차 이전부터 적용됨) |

### 점검했으나 문제 없음으로 확인
- **경로 탈출 없음**: 요청값으로 파일을 여는 지점은 백업(`path.basename` + 고정 디렉터리)과 `/dl/:file`(고정 목록 조회)뿐. `res.sendFile`/`createReadStream` 에 사용자 입력이 직접 들어가는 경로 없음.
- **원격 명령 조립**: `tcpdump` 캡처는 대상 호스트·인터페이스 화이트리스트 정규식 + 수치 클램프 + `crypto.randomBytes` 파일명(TOCTOU 방지)로 이미 하드닝돼 있음.
- **업로드 복원 미노출**: `parseUploadedArchive()` 는 export 만 되어 있고 **어떤 라우트에도 연결돼 있지 않음**(임의 설정 주입 경로 없음). 회귀 테스트로 고정.
- **복원 화이트리스트**: `.json`/`.env` 만 허용하므로 `settings-owners.txt`·`initial-admin-password.txt` 는 백업·복원 대상이 아니다 → 복원으로 소유자 목록을 갈아끼울 수 없다.
- v2.208 `fileSettingsOwners()`: 읽기 전용 + 계정명 정규식 화이트리스트, UI 저장으로 덮이지 않음.
- v2.209 도구 잠금 표시: 렌더링만 변경, 딥링크 가드·`requirePerm` 불변 → 노출 방식 변경이 권한을 넓히지 않음.

> 수용된 위험: `/api/admin/central-token` 은 설계상 admin 이 엣지 등록용 토큰을 확인하는 기능이라
> 소유자 전용으로 좁히지 않았다(운영 흐름 유지). 대신 발급/회전은 감사 로그에 남는다.
> **운영 주의**: 백업 아카이브 자체가 자격증명 사본이므로 내려받은 파일은 안전한 곳에 보관하고
> 불필요해지면 삭제할 것.

---

## 6차 감사 (v2.214.0) — 신규 Python 서비스 허브(`pyportal`) 첫 전수 점검

v2.211~2.213 에서 새로 추가된 **별도 페이지 `pyportal`(Python 표준 라이브러리 단독 HTTP 서버)** 을
처음으로 전수 점검했다. 프레임워크가 없다는 것은 **프레임워크가 기본 제공하던 방어(CSRF·세션·
타임아웃·요청 상한)를 직접 구현해야 한다**는 뜻이고, 실제로 그 지점에서 결함이 나왔다.
**확정 결함 6건을 수정**했으며 신규 CRITICAL 은 없다.

기존 Node/React 포탈은 5차 감사(v2.210) 이후 **소스 변경이 없어**(버전 파일·릴리스 노트 제외)
불변조건 회귀 여부만 확인했다 — 전역 TLS 디스패처 호출 0건, WAN TLS 기본 검증 ON,
백업 라우트 `requireSettingsOwner` 유지, `verifyToken` 직접 호출 0건, 상태변경 라우트 권한 누락 0건.

| # | 심각도 | 항목 | 원인 | 조치(v2.214.0) |
|---|---|---|---|---|
| P1 | 🟠 HIGH | **미인증 사용자가 서비스 허브를 사내망 스캐너로 사용** | `POST /api/health/check` 가 공개였고 `{"urls":[…200개]}` 로 **임의 주소**를 받았다. SSRF 가드는 루프백·링크로컬만 막고 RFC1918 은 (사내 서비스가 대상이라) 허용하므로, 로그인 없이 사내 IP:포트를 넣어 **응답코드·지연·오류메시지로 호스트/포트 생사를 열거**할 수 있었다. 실측: 열린 포트 `healthy 200 69ms`, 닫힌 포트 `unreachable Connection refused` | 임의 URL 점검은 **설정 로그인 필수**. 미인증은 **등록된 바로가기 재점검만** 가능하고 그마저 **30초 쿨다운**(부하 증폭 차단). 회귀 테스트 5건 |
| P2 | 🟠 HIGH | **쿠키 자격증명 + 단순요청 파싱 → CSRF** | 서버가 `hub_settings`/`hub_token` **쿠키를 상태변경에도 인정**했다. 교차출처 POST 는 `Content-Type: text/plain` 이면 프리플라이트 없이 전송되고, 그 본문은 그대로 JSON 으로 파싱된다(실측 201). 즉 쿠키가 설정된 브라우저를 악성 페이지로 유인하면 바로가기·데이터센터·사용자·백업을 조작할 수 있었다 | **쿠키는 조회(GET/HEAD)에서만** 인정하고 상태변경은 **커스텀 헤더 필수**(교차출처에서 붙일 수 없음). 추가로 `Origin`/`Sec-Fetch-Site` 로 **교차출처 상태변경을 403** 차단 |
| P3 | 🟠 HIGH | **미인증 응답이 초기 비밀번호 파일의 절대경로를 노출** | 공개 `GET /api/meta` 가 `initialPasswordFile: /etc/dc-service-hub/initial-settings-password.txt` 를 그대로 실었다. 서버 디렉터리 구조가 드러날 뿐 아니라, **"초기 비밀번호가 아직 유효하다"**(= 아무도 비밀번호를 바꾸지 않았다)는 사실까지 알려 표적을 지정해 준다. 4차 감사의 "미인증 응답에 계정명 금지"와 같은 유형 | 경로는 **로그인한 사용자에게만**. 미인증에는 `null` 만 반환 |
| P4 | 🟡 MEDIUM | **전역 로그인 잠금 → 설정 화면 영구 차단(가용성 공격)** | 실패 카운터가 **전역 1개**였다. 아무나 8회 틀리면 **정상 관리자까지 5분간** 로그인 불가였고(실측 `299초 후 다시 시도`), 5분마다 반복하면 사실상 영구 차단이다 | 잠금을 **출발지(IP)별**로 분리. 분산 시도 대비 전역 상한은 임계값 10배로 2차 방어에만 사용 |
| P5 | 🟡 MEDIUM | **소켓 타임아웃·동시 연결 상한 없음(slowloris)** | 요청을 보내지 않고 연결만 붙잡아도 스레드가 무한정 점유되고, 연결당 스레드를 **상한 없이** 생성했다 | 핸들러 `timeout=20`(유휴 keep-alive 정리) + **동시 연결 세마포어 64**. 유휴 종료는 오류 로그로 찍지 않음 |
| P6 | 🟢 LOW | **로그 인젝션** | 요청 라인(클라이언트 임의 값)을 그대로 출력해 제어문자·ANSI 이스케이프로 로그를 오염시킬 수 있었다 | 출력 전 `unicode_escape` 로 이스케이프 |

### 점검했으나 문제 없음으로 확인 (pyportal)
- **경로 탈출**: 정적 서빙은 `resolve()` 후 `relative_to(STATIC_DIR)` 재확인 + 확장자 화이트리스트,
  백업 파일명은 정규식 + `basename` 이중 검사 → `../` · 절대경로 모두 차단(테스트 고정).
- **XSS**: 화면이 사용자 입력을 `textContent` 로만 렌더하고 `innerHTML` 사용 0건, CSP `default-src 'self'`
  (인라인 style/script 금지)까지 걸려 있음.
- **저장 URL 스킴**: `http`/`https` 화이트리스트 — `javascript:`·`data:` 저장 불가(카드 클릭이 스크립트
  실행 경로가 되는 것을 원천 차단).
- **SSRF 가드 자체**: 해석된 주소 기준 검사라 10진수·8진수·IPv4-mapped 우회 표기가 자동으로 걸리고,
  리다이렉트를 따라가지 않아 "가드 통과 후 루프백 회귀"도 불가.
- **비밀번호 저장**: pbkdf2_hmac(sha256) 21만 회 + 계정별 salt, 변경 시 해당 계정 세션 전량 폐기.
- **요청 본문**: 라우팅 전 일괄 drain + 1MB 상한(초과 시 연결 재사용 중단) → keep-alive desync 없음.

> 수용된 위험: 설정 세션 토큰을 **localStorage** 에 보관한다(쿠키 CSRF 를 피하려는 선택). XSS 가
> 성립하면 탈취 가능하나, CSP + `textContent` 렌더로 XSS 표면을 없애 상쇄한다.
> **운영 주의**: 허브는 기본 평문 HTTP 다 — 사내망 밖에 노출한다면 리버스 프록시로 TLS 를 씌우고
> `HUB_TOKEN` 을 설정할 것.

### 개선 포인트 10 (6차 감사 백로그)

취약점은 아니지만 **다음에 손대면 가치가 큰 순서**로 정리했다. 난이도는 구현 규모 기준.

| # | 개선 포인트 | 왜 필요한가 | 난이도 |
|---|---|---|---|
| 1 | **점검 이력 시간당 롤업 테이블** | 한 달 차트는 매번 원본 수십만 행을 스캔해 집계한다. 링크가 늘고 주기가 짧아지면(1분) 첫 조회가 눈에 띄게 느려진다. Node 포탈이 전력 시계열에서 쓴 `power_hourly` 패턴(적재 트랜잭션 내 증분 upsert)을 그대로 적용하면 수억 행 → 수백 행 스캔이 된다 | 보통 |
| 2 | **상태 전환 알림(웹훅/메일)** | 지금은 사람이 화면을 봐야만 장애를 안다. `healthy → unreachable` **전환 시점**에만 알림을 쏘면(플래핑 억제 포함) 허브가 '보는 도구'에서 '알려 주는 도구'가 된다. 표준 라이브러리 `urllib` 로 웹훅 POST 만 해도 충분 | 보통 |
| 3 | **바로가기·데이터센터 표시 순서 지정** | 표시 개수 제한(v2.213)이 "등록 순서대로 앞에서 N개"라, **순서를 바꿀 수단이 없으면 반쪽 기능**이다. `order` 정수 필드 + 위/아래 이동 버튼이면 충분(드래그는 과함) | 낮음 |
| 4 | **설정 세션 무상태화(HMAC 서명 토큰)** | 세션이 메모리에만 있어 **서버를 재시작하면 전원 로그아웃**된다. 업그레이드·설정 변경 재기동이 잦으면 성가시다. 서명 토큰(만료·발급시각 포함) + 비밀번호 변경 시 무효화용 카운터로 바꾸면 재시작에도 유지된다 | 보통 |
| 5 | **백업 아카이브 암호화(passphrase)** | 백업에는 계정 비밀번호 해시가 들어간다. 지금은 0600 + admin 전용으로 보호하지만, **파일이 서버 밖으로 나가는 순간 보호가 사라진다**. 내보낼 때 passphrase 기반 대칭 암호화(PBKDF2+AES 대신 표준 라이브러리라면 `hashlib`+HMAC 스트림)로 한 겹 더 | 보통 |
| 6 | **감사 로그 파일 분리(JSON Lines)** | 현재 로그인·설정 변경·백업 인출이 stdout 에만 남아 journald 로 흘러간다. `audit.log`(JSON Lines, 회전 포함)로 분리하면 "누가 언제 무엇을 바꿨나"를 나중에도 조회·보존할 수 있다 | 낮음 |
| 7 | **허브 자체 TLS 지원** | 기본이 평문 HTTP 라 설정 비밀번호·세션 토큰이 사내망에 그대로 흐른다. `ssl.SSLContext` 로 인증서 경로만 받아 감싸면(환경변수 2개) 리버스 프록시 없이도 TLS 가 된다 | 낮음 |
| 8 | **CI 에 pyportal 테스트·파이썬 린트 추가** | 지금 GitHub Actions 는 릴리스 빌드만 돈다. **114개 테스트가 CI 에서 실행되지 않으므로** 다른 사람이 고치면 회귀를 놓친다. `python3 -m unittest` 한 줄만 워크플로에 넣어도 방어선이 생긴다 | 낮음 |
| 9 | **메인 포탈 ↔ 서비스 허브 상호 링크** | 두 포탈이 완전히 분리돼 있어 운영자가 주소를 외워야 한다. 메인 포탈 '특수 기능'에 허브 링크(설정 가능한 URL) 한 칸을 두면 동선이 이어진다. 인증은 각자 유지(연동하지 않는 편이 안전) | 낮음 |
| 10 | **Node 포탈 미해결 후속 2건 처리** | CLAUDE.md 에 남아 있는 항목 — ① **worker_threads 로 동기 SQLite 쓰기 오프로딩**(대량 적재 시 이벤트 루프 블로킹 잔존) ② **업그레이드 적용 중 라이브 SQLite `cpSync` 정합성**(백업 시점에 WAL 이 섞일 수 있음 → 백업 전 체크포인트 또는 `sqlite3 .backup` 사용) | 높음 |

---

> 잔여(수용된) 한계: `/overview`·`/summary` 등 **전역 집계 수치**는 scope 를 적용하지 않는다
> (단일 스냅샷 단일 계산 캐시 구조 — 식별 정보가 아닌 합계만 노출). 자원 **식별 단위** 유출은
> 위 S2 로 차단됐다. AD 계정은 OTP 강제 등록 대상이 아니다(AD 인증 체계를 따름).

---

## 🔴 CRITICAL — 즉시 조치

| # | 항목 | 위치 | 영향 | 조치 |
|---|------|------|------|------|
| C1 | 기본 admin 비밀번호 `admin123` 자동 시드 + 로그인 **속도제한/잠금 없음** + 미인증 `/auth/config`가 admin 계정명 노출 | `config.js:146`, `auth/auth.js:96`, `routes/auth.js:19`, `routes/auth.js:13` | 기본 설치본은 공개된 자격증명으로 원격 즉시 탈취 가능 | 기본비번 사용 중이면 기동 거부/최초 강제변경, 평문 로깅 금지, 로그인 IP·계정별 rate-limit+잠금, `settingsOwners` 미인증 응답에서 제거 |
| C2 | **전역 TLS 검증 비활성화**(`setGlobalDispatcher`)가 프로세스 전체 `fetch`에 적용 + 업그레이드 번들 **서명 없음**, 체크섬은 공격자 채널과 동일 출처 | `vcenter/restClient.js:25-45`(via `store.js`), `upgrade/fetchPackage.js:58`, `upgrade/upgrade.js:321-352`, `routes/collector.js:47` | GitHub/미러↔포탈 MITM → 트로이목마 번들 자가설치 → 포탈 및 모든 에이전트 **RCE** | 전역 dispatcher 쓰지 말고 vCenter fetch에만 로컬 Agent 주입. 번들 Ed25519/minisign 서명 검증 후 설치. 검증TLS 채널에서만 versions.json 취득 |
| C3 | `revealCreds:true`가 저장된 평문 비밀번호를 **API 응답으로 반환** | `routes/admin.js:538,600,634` | 모든 리다ction 무력화 — admin 세션 탈취 시 게스트/물리 SSH 비번 평문 유출 | 평문 분기 제거, 길이마스킹만 표시 |
| C4 | `/api` 라우터에 **역할 가드 없음** — 임의 `viewer`가 운영 VM Tools 업그레이드·알람뮤트·UI설정 변경 | `index.js:91`, `routes/api.js:1346,703,748,465,1379,1687` | 권한상승: 최저권한 계정이 admin급 동작 | 상태변경 라우트에 `requireRole` 부여(읽기/쓰기 라우터 분리, default-deny) |
| C5 | 원격접속 `quick-connect`/`probe`가 **비-admin 허용** → 임의 host:port로 HAProxy 매핑 생성/내부 SSH·포트탐침 | `routes/remote.js:39,161` | 포탈 프록시를 **오픈릴레이/내부 피벗**으로 악용 | admin 강제 + targetHost를 실제 인벤토리 VM IP로 제한 |
| C6 | 시드 admin 비밀번호가 **admin 가시 로그버퍼**(`/admin/logs`)에 평문 출력 | `auth/auth.js:97` (`logbuffer.js`→Diagnostics UI) | 운영자가 `DEFAULT_ADMIN_PASSWORD` 설정 시 실비번이 UI에 노출 | 비번 로깅 제거, 랜덤 생성+최초변경 |

## 🟠 HIGH

| # | 항목 | 위치 | 영향 | 조치 |
|---|------|------|------|------|
| H1 | SSRF: 인증된 relay-test가 **임의 host:port**에 raw TCP/TLS/HTTP — 내부 포트스캔·TLS 인증서 핑거프린트·메타데이터(169.254.169.254) | `routes/admin.js:144`, `vcenter/relayProbe.js:56` | 내부망 스캐너/서비스 식별 | `vcenterId`로만 대상 결정(자유 `host=` 제거), RFC1918/loopback/link-local 차단, DNS 재바인딩 방지 |
| H2 | RDP 자격증명(user/pw/domain)+베어러 토큰을 **WebSocket 쿼리스트링**으로 전송 | `web/.../RemoteConsole.jsx:145`, `proxy/guacdTunnel.js:50` | HAProxy/프록시 액세스로그에 평문 RDP 비번+세션토큰 기록 | upgrade 후 첫 WS 메시지로 자격증명 전달, 토큰은 1회용 티켓 |
| H3 | WS SSH/RDP 게이트웨이가 **역할 미검증**(유효 토큰이면 viewer도 터널) + 인증 비활성화 시 미인증 터널 | `proxy/sshGateway.js:27-30`, `guacdTunnel.js:50` | 인프라 대화형 SSH/RDP 무단 개통 | WS upgrade에서 operator/admin 역할 강제, 인증 off면 게이트웨이 미바인딩 |
| H4 | **임의 파일 읽기**: `import-file`의 `path`를 무제한 수용 → JSON 파싱 가능한 모든 호스트 파일(users.json 등) 유출, 에러메시지로 비-JSON 첫 바이트 노출 | `routes/admin.js:838-853` | confused-deputy 파일읽기(설정/시크릿) | `config.configDir` 등 allowlist 하위로 `path.resolve` 제한, 에러 `err.message` 미반환 |
| H5 | Windows 게스트 프로세스 탐침이 `cmd.exe` 배치에 `pattern`을 `["%]`만 제거 후 삽입 → `& \| < > ^ ( )` 생존 | `search/deepSearch.js:71` (via `POST /deep-search/probe`) | Windows 게스트 **RCE** | pattern `[A-Za-z0-9._-]` 화이트리스트 또는 cmd 메타문자 전부 이스케이프 |
| H6 | HAProxy **config 주입**: `addMapping`의 `targetHost` 진리값 검사만 → 개행 포함 시 임의 디렉티브 주입(배포되는 설정파일) | `proxy/registry.js:196`, `proxy/deploy.js:22` | 백도어 frontend/admin socket 삽입 | targetHost 엄격검증(IP/호스트명, 개행·공백 금지) |
| H7 | `mode:0o600`은 **덮어쓰기 시 미적용**인데 일부 시크릿 파일에 `chmodSync` 폴백 없음(개인키/토큰/users.json/TOTP시드/AD설정) | `proxy/registry.js:67`, `agent/deployRegistry.js:28`, `auth/auth.js:104`, `auth/ad.js:46`, `llm/config.js:32`, `security/securitySettings.js:51`, `audit.js:44` | 느슨한 권한으로 한번 생성되면 평문 시크릿 로컬 유출 | 모든 시크릿 write 후 `chmodSync(f,0o600)` 추가, CONFIG_DIR `0o700` |
| H8 | 인증 비활성화 시 **익명 admin** 부여(모든 mutation 가능) | `auth/auth.js:245,260` | 단일 env 오설정으로 전체 노출 | 인증 off면 read-only로 강등, mutation 라우트 거부 |
| H9 | TOTP **재사용/무차별** 가능(1회용 추적 없음, 시도제한 없음, window=±1) + OTP가 단일요소 | `auth/totp.js:49`, `auth/auth.js:113` | 6자리 온라인 무차별/리플레이로 계정탈취 | 사용된 step 거부(1회용), OTP 시도제한/잠금 |
| H10 | 2인 긴급중단 OTP가 **단일 세션**에서 두 코드 제출 가능 + OTP 1회용 부재로 단독 우회 가능 | `routes/admin.js:115-134` | 2인 통제 무력화(한 admin이 단독 토글) | 각 승인을 별도 인증세션에 바인딩, OTP 1회용, 동일 IP/세션 경보 |
| H11 | 에이전트/메트릭 **공유토큰 비교가 timing-safe 아님** + central이 iDRAC 자격증명 평문 반환 | `routes/collector.js:28`, `central.js:26`, `metricsExport.js:26`, `central.js:35` | 타이밍 사이드채널로 토큰복구→위조 인벤토리/업그레이드 푸시(RCE), iDRAC 비번 유출 | `crypto.timingSafeEqual`(길이가드 후), 자산별 스코프·단기 시크릿 |

## 🟡 MEDIUM

| # | 항목 | 위치 | 조치 |
|---|------|------|------|
| M1 | 보안 헤더 전무(helmet/CSP/X-Frame-Options/HSTS) → SSH/RDP 콘솔 **클릭재킹**, XSS 탈취 완화 부재 | `index.js` | `helmet()` + CSP(`frame-ancestors 'none'`, `connect-src 'self'`+WS) |
| M2 | **CORS 와이드오픈**(`cors()` 기본 `*`) | `index.js:62` | 자기 출처로 제한 또는 제거(동일출처 SPA) |
| M3 | AD LDAPS **인증서 검증 기본 off** | `auth/ad.js:30` | 기본 `true`, 명시적 opt-out만 |
| M4 | 프로토타입 오염(`__proto__` 키)이 central agent-config/백업 복원 맵에 유입 | `routes/central.js:147`, `central/agentConfig.js:13`, `backup/service.js:111` | 예약키 거부 + `Object.create(null)` |
| M5 | 선행 `-` **인자 주입**(ping/tcpdump positional) — DoS/flag 악용 | `util/ping.js:38`, `net/tcpdump.js:11`, `routes/remote.js:38` | 선행 `-` 거부, 엄격 IP/호스트 검증, `--` 구분 |
| M6 | central push **64MB JSON** 본문 + 최대 50만 항목 보존(힙 고갈 DoS) | `index.js:65`, `routes/central.js:58` | 한도 축소(≈16MB), 에이전트별 바이트 캡 |
| M7 | uncaughtException 스택/`err.message`가 admin 클라이언트·로그버퍼로 노출(내부경로) | `index.js:7`, `routes/admin.js:619` 등 | 서버측만 기록, UI엔 일반메시지+error id |
| M8 | `installerInfo(path)` 임의경로 존재/크기 오라클 + deployAgent 소스로 사용 | `routes/admin.js:221`, `agent/deploy.js:19` | download/packages 디렉터리로 한정 |
| M9 | `AUTH_SECRET` 미설정 시 프로세스별 랜덤(재시작/다중노드 토큰 깨짐 → 약한 정적시크릿 유혹) + JWT `alg` 미고정 | `auth/auth.js:35,59` | 미설정 시 기동 거부, `alg==='HS256'` 강제 검증 |
| M10 | 예측가능 `/tmp/portal-cap-${Date.now()}` 등 → root 수집기 symlink/TOCTOU | `proxy/guestops.js:175`, `net/tcpdump.js:150` | 원격 `mktemp`/랜덤 접미사 |

## 🟢 LOW / 정보

- `vmrc://`/web콘솔 URL을 서버 데이터로 네비게이트 — 스킴 allowlist 권장 (`web/.../VmConsole.jsx:66`).
- 에이전트 env 배포 시 값 개행 → 추가 env 키 주입 (`agent/deploy.js:171`).
- TOTP 시드 평문 저장(`auth/auth.js:187`) — `AUTH_SECRET` 파생키로 암호화 고려.
- `X-Forwarded-For` 무검증 신뢰로 브루트포스 분석 오염 (`routes/auth.js:24`).
- `sftpWriteFile` 기본모드 `0o644`(현 호출부는 명시 0600) (`proxy/sshExec.js:56`).
- `audit.ndjson` 비-append-only(호스트 공격자 편집 가능) — 해시체인 고려.
- `/dl` 미인증 번들 열람/열거 (`routes/dlsource.js`).
- `guestLoginScan` `days/maxLines` Number 강제 부재 (`security/guestLoginScan.js:9`).

## ✅ 양호(조치 불필요)로 확인된 것
- 사용자 비번: scrypt + per-user 16B salt + `timingSafeEqual`.
- JWT 서명검증 timing-safe, `exp` 강제; `alg:none`/RS256 혼동 불가(항상 HS256 재계산).
- **SQL 인젝션 없음** — 모든 쿼리 `?` 바인딩(`logs/db.js`의 검색어 포함).
- 업그레이드 압축해제 zip-slip 방어(`acceptMember` + `path.resolve startsWith`), 크기/멤버 캡.
- 리스트/GET 응답 비번 리다ction(`hasPassword`/`********`), 요청로거 쿼리·바디·Authorization 미기록.
- 감사로그에 비번/바디 미기록.
- 프론트 XSS 싱크 없음(`dangerouslySetInnerHTML`/`eval` 부재, `highlight()`는 React 자동이스케이프), 정적서빙 traversal 없음, 베어러 헤더라 CSRF 내성.
- 커밋된 시크릿 없음(`.example.json` placeholder만), `.gitignore` 적정.

## 권장 조치 순서
1. **C1·C6**(기본비번/로그노출/rate-limit) — 가장 쉽고 즉효.
2. **C3·C4·C5**(평문비번 응답 제거, /api·remote 역할가드) — 권한상승 차단.
3. **C2**(전역TLS 스코프화 + 번들 서명) — MITM RCE 차단.
4. **H1·H4·H5·H6**(SSRF·임의읽기·Win주입·HAProxy주입).
5. **H7·H8·H11·M1·M2·M3**(권한파일·익명admin·timing·헤더·CORS·AD TLS).
