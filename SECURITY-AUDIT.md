# 보안 감사 보고서 — VMware Global Monitoring Portal (The.DVC)

> 작성: 전체 소스 6개 영역 병렬 정적분석(인증/권한 · 명령주입 · SSRF/TLS · 시크릿/로깅 · 입력검증 · 프론트엔드).
> 대상 커밋 기준: `claude/vmware-global-monitoring-portal-nrnpnt`.
> 성격: 사내 단일테넌트 운영 포탈. 다수 항목이 admin 인증 뒤에 있으나, "포탈 admin → 원격 인프라(수집기/에이전트/게스트)에서 root 코드 실행"으로 신뢰경계를 넘는 것이 핵심 위험.

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
