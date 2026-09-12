# 05 — 웹 프론트엔드 · 세션 · HTTP 계층 보안 감사 (읽기 전용, 2026-09-12)

범위: `web/src`(React/Vite), `server/src/index.js`·`routes/auth.js`·`proxy/*`, `pyportal/`(Python 허브).
방식: 정적 코드 검토만(실행·재현 없음). 코드에서 확인한 것만 적고, 검증 못 한 부분은 **추정**으로 표기.
직전 감사(`security_check_20260809.MD`)에서 해소된 항목(H-R1 Topology3D XSS, M-R2 RDP 쿼리 자격증명)은 회귀 여부만 재확인했고 **회귀 없음**.

## 요약

| # | 심각도 | CWE | 항목 | 위치 |
|---|---|---|---|---|
| F-1 | MEDIUM | CWE-598 | 세션 JWT 전체를 WebSocket **쿼리스트링**에 실어 전송(SSH·RDP) | `web/src/remote/RemoteConsole.jsx:53,172` / `server/src/proxy/sshGateway.js:42` / `guacdTunnel.js:58` |
| F-2 | LOW | CWE-613 | 서버측 로그아웃(토큰 폐기) 부재 — 로그아웃 후에도 토큰이 만료까지 유효 | `web/src/App.jsx:126`, `server/src/routes/auth.js`(로그아웃 라우트 없음) |
| F-3 | LOW | CWE-1021/693 | Node 포탈 **CSP 기본 미적용**(env 옵트인) — XSS 심층방어 부재 | `server/src/index.js:110,119`, `web/index.html`(meta CSP 없음) |
| F-4 | INFO | CWE-922 | "로그인 유지" 시 토큰을 `localStorage` 에 저장 — XSS 성립 시 영구 탈취 | `web/src/api.js:11-14` |
| F-5 | INFO | CWE-200 | 미인증 `/api/auth/config` 가 `setupPending`·`initialPasswordFile`(절대 경로)·세션 정책값 노출 | `server/src/routes/auth.js:17-36`, `server/src/auth/auth.js:264-273` |
| F-6 | INFO | CWE-200 | 공개 `/dl/versions.json` 이 포탈 번들 버전 목록 노출(설계상 필요) | `server/src/routes/dlsource.js:76` |

XSS 싱크(`dangerouslySetInnerHTML`/`innerHTML`/`eval`/`srcdoc`/`document.write`)는 `web/src`(vendor 제외)에 **Topology3D 1곳뿐**이며 `escHtml` 유지 확인. 계정명이 미인증 응답에 실리는 곳은 없음(불변조건 유지).

---

## 확정 결함

### F-1 [MEDIUM] [CWE-598] 세션 JWT 를 WS 쿼리스트링으로 전송

- **코드**
  - `web/src/remote/RemoteConsole.jsx:53`
    ```js
    const ws = new WebSocket(`${proto}://${location.host}/api/remote/ssh?token=${encodeURIComponent(getToken() || '')}`);
    ```
  - `web/src/remote/RemoteConsole.jsx:172`
    ```js
    const q = new URLSearchParams({ token: getToken() || '', mappingId: mapping.id, width: String(w), height: String(h), ticket }).toString();
    ```
  - 서버: `server/src/proxy/sshGateway.js:42` `user = resolveTokenUser(url.searchParams.get('token'));`,
    `server/src/proxy/guacdTunnel.js:58` 동일.
- **문제**: RDP 자격증명은 v2.260 에서 1회용 티켓으로 옮겼지만(`ticket`), **포탈 세션 토큰 자체**는 여전히
  쿼리스트링에 실린다. 이 토큰은 HTTP `Authorization: Bearer` 와 동일한 전권 토큰(TTL 기본 8h)이다.
- **공격 전제**: 포탈 앞단 HAProxy/nginx 등 리버스 프록시의 액세스 로그(쿼리 포함 기본 포맷) 열람 권한,
  또는 브라우저 devtools/네트워크 캡처 열람. 포탈 자체는 WS upgrade 가 express 미들웨어를 타지 않으므로
  `index.js:153`/`audit.js:88` 의 요청 로그에는 남지 않음(확인). 상위 프록시 로그 포맷은 저장소에서
  확인하지 못했음(`packaging`·`config` 에 httplog/log-format 없음) — **추정**.
- **PoC**: 프록시 로그에서 `GET /api/remote/ssh?token=eyJ...` 한 줄을 복사해
  `curl -H "Authorization: Bearer eyJ..." https://portal/api/auth/me` → 해당 사용자 세션으로 전 API 사용 가능(만료 전).
- **수정**: 기존 `proxy/rdpTicket.js` 패턴을 확장해 **WS 접속 티켓**을 발급(`POST /api/remote/ws-ticket`,
  Bearer 로 인증, 30초·1회용, 사용자·mappingId 바인딩)하고 게이트웨이는 `?ticket=` 만 받아
  `resolveTokenUser` 대신 티켓→user 로 해석. 또는 `Sec-WebSocket-Protocol: bearer.<token>` 서브프로토콜로 옮기기
  (헤더는 일반 액세스 로그에 남지 않음). 두 게이트웨이의 `searchParams.get('token')` 폴백은 제거.

### F-2 [LOW] [CWE-613] 서버측 로그아웃 부재

- **코드**: `web/src/App.jsx:126` `const logout = () => { setToken(null); broadcastLogout(); setUser(null); };`
  — 서버 호출 없음. `server/src/routes/auth.js` 에 `/logout` 라우트 없음(`grep -i logout server/src/routes` → 없음).
  토큰 폐기 수단은 `tokenVersion`(비번/역할 변경 시)과 단일세션 `sid` 덮어쓰기(`auth.js:76-81`)뿐.
- **영향**: 공유 PC 등에서 로그아웃 뒤에도 이전에 유출(F-1·XSS·캡처)된 토큰이 TTL(기본 8h) 동안 유효.
  유휴 로그아웃(`App.jsx:111-125`)도 클라이언트 저장소만 지운다.
- **PoC**: 로그인 → 토큰 복사 → UI 로그아웃 → `curl -H "Authorization: Bearer <복사토큰>" /api/auth/me` → 200.
- **수정**: `POST /api/auth/logout`(authMiddleware) 추가 — 단일세션 모드면 `setActiveSession(username, null)`,
  아니면 `jti/sid` 기반 폐기 목록(만료까지 메모리 보관)을 `resolveTokenUser` 에서 대조. 프론트 `logout()`·
  유휴 로그아웃·`SessionExpiryGuard` 에서 호출(실패해도 로컬 정리는 진행).

### F-3 [LOW] [CWE-1021/693] Node 포탈 CSP 기본 비활성

- **코드**: `server/src/index.js:110` 주석 "CSP는 … 기본 비활성(CSP env로 옵트인)",
  `:119` `if (process.env.CSP) res.setHeader('Content-Security-Policy', process.env.CSP);`.
  `web/index.html` 에 `http-equiv` CSP 없음. 반면 pyportal 은 `hub/server.py:47-50` 에서 `default-src 'self' … frame-ancestors 'none'` 강제.
- **영향**: 향후 XSS(H-R1 류의 저장형 인벤토리 이름 등) 발생 시 인라인 스크립트/외부 로드/데이터 유출을 막는 2차 방어가 없다.
  `X-Frame-Options: DENY` 는 있으나 `frame-ancestors` 미설정.
- **수정**: 기본값 도입(옵트아웃 env 로 전환). Vite 빌드는 인라인 스크립트가 없으므로 예시
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`.
  `/intro` 정적 페이지는 별도 완화 정책을 경로 조건으로 적용.

### F-4 [INFO] [CWE-922] "로그인 유지" 토큰 localStorage 저장

- `web/src/api.js:11-14`: `persist` 이면 `localStorage`, 아니면 `sessionStorage`. 사용자 선택형이며 흔한 트레이드오프.
  XSS 가 성립하면 두 저장소 모두 읽히므로 근본 완화는 F-3(CSP)와 XSS 싱크 부재 유지. 추가로 `HttpOnly` 쿠키 전환은
  CSRF 방어(Origin 검사)를 새로 요구하므로 현 헤더 전용 구조를 유지하는 편이 단순함 — 변경 권고 아님(기록용).

### F-5 [INFO] [CWE-200] 미인증 `/api/auth/config` 노출 내용

- `server/src/routes/auth.js:17-36` + `server/src/auth/auth.js:264-273`: `authEnabled, adEnabled, idleLogout*, sessionWarn*, sessionExtendMin, sessionMaxHours, setupPending, initialPasswordFile`.
- `initialPasswordFile` 은 **절대 경로**(CONFIG_DIR 위치 노출)이며 `setupPending=true` 는 "OTP 등록된 admin 이 없다"는 신호.
  주석대로 문서 공개 경로이고 계정명은 없음 → 불변조건 위반 아님. 원하면 경로 대신 불리언만 내려도 UX 동일.

### F-6 [INFO] 공개 `/dl/versions.json`

- `server/src/routes/dlsource.js:76`: 인증 없이 번들 버전·크기·sha256 목록. 엣지 자동 업그레이드가 쓰는 설계상 공개 엔드포인트.
  포탈 버전 열거(취약 버전 추정) 단서가 되지만 실질 위험 낮음. `/api/health`(instance/agent 이름·vCenter 수)는
  **인증 뒤**에만 열림(`index.js:182` 의 `app.use('/api', authMiddleware, requireEnrolled, api)` 하위 `overviewNsx.js:34`) — 미인증 노출 아님.

---

## 검토했으나 결함 아님(반증 근거)

- `window.open`/`location.href` 대상: `VmConsole.jsx:67,73` 의 `vmrcUrl`/`webConsoleUrl` 은 서버가 vCenter 설정 host 로
  조립(`server/src/vcenter/soapClient.js:61-64`, admin 입력) · `SpecialTools.jsx:138` 의 `serviceHubUrl` 은 env
  `SERVICE_HUB_URL`(`config.js:279`)만 · 모두 `noopener`.
- 동적 `href`(vendor 제외 5곳 전수): `IdracDetailModal.jsx:65,184` `https://${h}`(스킴 고정, h=iDRAC 레지스트리 host),
  `RightsizeReport.jsx:452`·`DiskTrend.jsx:217` `c.url` 은 서버 상수 문서 링크(`tools/rightsize.js:38-63`, `tools/diskTrend.js:27-45`),
  `ScanJobLogModal.jsx:175` `l.hash` 는 서버 상수(`central/scanRemedy.js:111-136`). `javascript:` 유입 경로 없음.
- 해시 라우팅: `SpecialTools.jsx:97-103` `toolFromHash` 가 `TOOLS` 화이트리스트로 검증, `App.jsx:216-224` `tabFromHash`,
  콘솔 `DvcConsole.jsx:35-47` `pageFromHash`; `onExit(hash)` 인자는 `console/nav.js:23-60` 의 정적 내부 해시뿐(`App.jsx:228`).
  해시 값이 DOM 에 HTML 로 들어가는 곳 없음(`title` 속성은 React 이스케이프).
- `web/src/console/*`: `title=`·텍스트 렌더만(`ConsoleAlarms.jsx:61-62` 등), `href`/`innerHTML`/토큰 접근 없음.
- xterm `term.write(s)`(`RemoteConsole.jsx:88`): 원격 바이트를 터미널 에뮬레이터에 쓰는 것으로 JS 실행 싱크 아님(**추정**: xterm 버전별 OSC 처리 미확인).
- 오픈 리다이렉트: `res.redirect` 서버 사용 없음, `Login.jsx` 에 redirect/returnTo 파라미터 없음.
- 서버 HTML 응답: `res.send('<html')`/`text/html` 은 `util/smtp.js`(메일 본문)뿐, 반사형 입력 없음. `/intro` 는 정적 파일(`index.js:186-190`), 내부 HTML 에 `location.search/innerHTML` 사용 없음.
- 서비스워커 `web/public/sw.js:17` 가 `/api`·`/metrics` 를 캐시에서 제외.
- pyportal `static/app.js`: `innerHTML` 사용 0(주석 1곳), 토큰은 `localStorage`→커스텀 헤더(`X-Hub-Token`/`X-Settings-Token`, `app.js:147,1605`).

## 확인된 양호한 방어

- **XSS 싱크 부재/이스케이프**: `web/src` 전수에서 `dangerouslySetInnerHTML|innerHTML|document.write|eval|new Function|srcdoc|insertAdjacentHTML` 실사용은 `Topology3D.jsx:50` 1곳이며 `escHtml`(`:6`)·`Number()` 강제 유지(H-R1 회귀 없음). `components/boldText.jsx` 는 React 요소 배열로 굵게 처리.
- **인증은 순수 Bearer 헤더**: `api.js:124-126` `authHeaders`, 서버 `auth/`·`index.js` 에 cookie 파싱 없음, 웹에 `credentials:'include'` 없음 → 브라우저 자동 전송 자격증명이 없어 CSRF 성립 불가. 파일 다운로드도 `downloadFile`(`api.js:242`) 로 헤더 인증.
- **보안 헤더**(`index.js:111-120`): `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `X-Permitted-Cross-Domain-Policies: none`, HTTPS 시 HSTS.
- **CORS 기본 차단**(`index.js:125-126`): `CORS_ORIGINS` 미설정 시 `{origin:false}` (와일드카드 제거), credentials 옵션 미사용.
- **에러 스택 은닉**: 전역 4-인자 에러 핸들러(`index.js:219`).
- **정적 서빙**: `/dl/:file` 은 `SAFE_RE`(`dlsource.js:22,33-37`) 화이트리스트 + 디렉터리 고정; SPA 폴백은 확장자 있는 경로를 404(`index.js:203-207`); `index.html` `no-cache`, 해시 자산만 `immutable`.
- **WS 게이트웨이**: `resolveTokenUser`(tokenVersion·최신 역할)·`mustEnrollOtp`·`remote.access` 권한 검사(`sshGateway.js:42-52`), RDP 자격증명은 티켓만(`guacdTunnel.js:84`), 미일치 upgrade 소켓 파기(`index.js:307-311`).
- **로그의 쿼리 제거**: 요청 로그 `index.js:153` `originalUrl.split('?')[0]`, 감사 `audit.js:88` 동일.
- **세션 위생**: 유휴 로그아웃(`App.jsx:111-125`, 서버 정책값 `idleLogoutMin`), 크로스탭 로그아웃 브로드캐스트(`api.js:18`), 만료 경고·연장은 서버 `exp`·`sessionMaxHours` 로 상한(`routes/auth.js:110-140`), 단일세션 `sid`(`auth.js:76-81`).
- **미인증 응답에 계정명 없음**: `/api/auth/config`(`auth.js:17-36`) 에 `settingsOwners` 미포함, `isSettingsOwner` 는 `/auth/me` 불리언(`auth.js:107-108`), `serviceHubUrl` 도 인증 후만.
- **pyportal**: 엄격 CSP + `frame-ancestors 'none'` + XFO DENY(`hub/server.py:42-50`); 상태변경 요청은 `Origin`/`Sec-Fetch-Site` 교차출처 차단(`server.py:182-195, 263`); 쿠키는 **GET/HEAD 에서만** 자격증명으로 인정하고 상태변경은 커스텀 헤더 필수(`server.py:172-180`, CSRF 차단); 정적 경로는 `normpath`+`resolve().relative_to(STATIC_DIR)`+확장자 화이트리스트(`server.py:955-960`).

## 한계

- 정적 검토만 수행. 상위 프록시(HAProxy) 로그 포맷·xterm OSC 처리·`cors` 패키지 런타임 동작은 코드/문서 지식 기반 판단(**추정**).
- `web/src/vendor/` 와 `server/src/intro/support.js`(번들 라이브러리)는 제외.
