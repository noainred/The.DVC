# 감사 01 — 인증·RBAC·권한 매트릭스·사용자 vCenter scope (읽기 전용, 2026-09-12)

대상: `/home/claude/the.dvc/server/src` (커밋 현재 작업트리). 방식: `routes/{api,admin,svcmon}/*.js` + `auth.js·central.js·collector.js·remote.js·upgrade.js·insights.js·svcmon.js·capacity.js·ping.js·dlsource.js·metricsExport.js` 의 라우트 등록 전수(상태변경 ~330건, GET ~300건)를 스크립트로 추출해 게이트·scope 참조를 대조하고, 후보는 코드 재독 + 로컬 재현(Node v22.22.2)으로만 확정했다. 직전 감사(2026-08-09·08-17)에서 수정된 항목은 회귀 여부만 확인했다.

요약: **HIGH 0 · MEDIUM 2 · LOW 1 · INFO 4.** 상태변경 라우트 RBAC 누락은 없었고, OTP 미등록 세션이 닿는 보호 API 도 없었다. 확정 2건은 (1) WS upgrade 경로의 URL 파싱 예외로 v2.322 catch-all 이 무력화되는 **무인증 소켓 누수 회귀**, (2) `/api/ping` 조회 라우트의 **scope 미적용**(vCenter 관리 호스트 노출)이다.

---

## 확정 발견

### F-1 [MEDIUM · CWE-248/CWE-400] WebSocket upgrade 핸들러의 `new URL(req.url)` 미보호 — 예외로 catch-all 소켓 파기가 건너뛰어져 무인증 FD 누수(v2.322 #7 회귀)

- **위치**
  - `server/src/proxy/sshGateway.js:27-29`
    ```js
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/remote/ssh') return; // let other upgrade handlers run
    ```
  - `server/src/proxy/guacdTunnel.js:50-52` (동일 패턴)
  - `server/src/index.js:307-311` (catch-all 은 try/catch 가 있으나 **세 번째 리스너**라 앞 리스너가 throw 하면 실행되지 않음)
  - `server/src/index.js:6-9` — `process.on('uncaughtException', …)` 가 "계속 실행" 이므로 프로세스는 죽지 않고 소켓만 남는다.
- **원리**: Node http 파서는 `GET //[ HTTP/1.1` 같은 요청줄을 그대로 `req.url='//['` 로 넘긴다. `new URL('//[', 'http://localhost')` 는 `TypeError: Invalid URL` 을 던지고, EventEmitter 는 동기 throw 시 **나머지 리스너를 호출하지 않는다** → guacd 리스너·index.js catch-all 모두 미실행 → 소켓은 어느 쪽도 `destroy()` 하지 않은 채 열려 있다(upgrade 분기에서 http 가 파서·타임아웃을 소켓에서 떼어 놓으므로 keepAliveTimeout 도 걸리지 않는다).
- **재현(로컬, 동일 리스너 구조로 검증)**: keepAliveTimeout=2s 서버에서 아래 요청 후 4초 뒤 `server.getConnections()==1`, 클라이언트 소켓 미종료, catch-all 로그 미출력, `uncaughtException: Invalid URL` 기록.
  ```
  printf 'GET //[ HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n' | nc <portal> 4000
  ```
  (연결을 유지한 채 반복하면 FD 상한까지 무인증 점유 — 2026-08-17 #7 이 막으려던 바로 그 클래스. 부수 효과로 요청당 스택트레이스 1건이 `/api/admin/logs` 링버퍼에 적재된다.)
- **전제**: 무인증.
- **수정**: 두 게이트웨이의 URL 파싱을 try/catch 로 감싸고 실패 시 `socket.destroy()` 후 return(또는 `req.url.split('?')[0]` 로 pathname 을 먼저 비교하고 `URL` 은 자기 경로일 때만 파싱). index.js catch-all 을 **첫 번째** upgrade 리스너로 옮겨 경로 미일치를 먼저 파기하는 것도 함께 권장(리스너 순서 의존 제거). `test/securityAudit2026-08-17.test.js` 에 `//[` 케이스 추가.

### F-2 [MEDIUM · CWE-639/CWE-200] `/api/ping` 조회 라우트 scope 미적용 — 범위 제한 계정이 전 vCenter 관리 호스트·이름·응답시간 열람

- **위치**: `server/src/routes/ping.js`
  - `:52` `GET /status` → `statusAll(['manual','vcenter'])` (전 vCenter 타깃 상태)
  - `:56` `GET /targets` → `listTargets().filter(source manual|vcenter)` — scope 무검사
  - `:58-64` `GET /series?id=vc_<vcenterId>` — id 검증 없이 `seriesOf(id)`
  - `:101-109` `GET /vcport/overview` → `overviewGrouped('vcport','vcenterId', {groupName: vcNameMap()})` — 전 vCenter 그룹
  - 타깃 내용: `server/src/ping/store.js:150-152` `{ id:'vc_'+vcId, name: vc.name||host, host: hostFromUrl(vc.host), port:443, source:'vcenter' }` — 즉 **vCenter 관리 호스트명/IP 그대로**.
  - 마운트: `index.js:181` `authMiddleware, requireEnrolled, auditMiddleware` 만(권한·scope 없음). 라우터 주석 "조회=인증".
- **전제**: scope 제한 viewer(로그인만 되면 됨. `requirePerm` 도 없어 매트릭스에서 tools/dashboard 를 빼도 도달).
- **요청 예**
  ```
  GET /api/ping/targets            Authorization: Bearer <scope-limited viewer>
  → {"targets":[{"id":"vc_site-b","name":"SEOUL-VC","host":"vc.seoul.corp.local","port":443,"source":"vcenter"},…]}
  GET /api/ping/series?id=vc_site-b&range=7d   → 범위 밖 vCenter 443 RTT 시계열
  GET /api/ping/vcport/overview                → 전 vCenter 이름·포트 응답 그룹
  ```
- **대조**: 동일 정보(vCenter host/이름/RTT)를 다루는 `/tools/network-check` 는 2026-08-17 #4 에서 Medium 으로 scope 를 걸었다(`getNetworkCheck(allowed)`). CLAUDE.md "조회 라우트 scope 는 예외 없이" 위반. `/edge/overview` 의 엣지 노드 타깃(datacenterId 그룹)은 vCenter 귀속이 없어 '무귀속 데이터 범위 계정 미노출' 규칙상 범위 계정에는 숨기는 것이 맞다(별도 판단).
- **수정**: `scopedVcenterIds(req.user, store.get())` 이 non-null 이면 `source==='vcenter'` 타깃은 `id==='vc_'+allowedId` 만 통과(`/targets`·`/status`), `/series` 는 `vc_` 접두 id 가 범위 밖이면 404, `/vcport/overview` 는 그룹 키(vcenterId) 교집합. 라우터에 `requirePerm('dashboard')` 또는 `'tools'` 게이트 추가 권장.

### F-3 [LOW · CWE-287/CWE-697] `verifyPassword` 가 길이 0 해시를 통과시킴 — `scrypt$<salt>$` 형태 레코드는 **모든 비밀번호가 일치**

- **위치**: `server/src/auth/auth.js:26-36`
  ```js
  const expected = Buffer.from(hashHex, 'hex');           // hashHex==='' → length 0
  const actual = crypto.scryptSync(password, Buffer.from(saltHex,'hex'), expected.length); // keylen 0 → 빈 버퍼
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);   // 0===0 && true
  ```
  로컬 검증: `scryptSync('x', salt, 0)` 은 throw 없이 길이 0 버퍼를 반환하고 `timingSafeEqual(빈,빈)===true` (Node 22.22.2).
- **전제(추정)**: `passwordHash` 를 검증 없이 기록하는 경로가 있어야 한다. 코드상 후보는 `applyManagedUsers(managed)` (`auth.js:526-556`, `m.passwordHash` 형식 미검증 — 중앙 배포 사용자 pull) 과 설정 소유자의 백업 복원(`users.json`). 정상 `hashPassword()` 는 항상 128자 hex 를 만들므로 UI 경로로는 발생하지 않는다. 중앙→엣지 pull 경로가 중앙 토큰만으로 임의 해시를 밀 수 있는지는 이번 범위(HTTP 인증)에서 확인하지 못했다 — `agent/usersConfigPull.js`·`routes/central.js` 의 users-config 응답 조립부를 보면 확정된다.
- **수정**: `verifyPassword` 에서 `scheme!=='scrypt' || saltHex.length!==32 || expected.length!==64` 이면 false. `applyManagedUsers` 도 `/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/` 아닌 해시는 skip.

---

## INFO (검증됨, 위험 낮음 — 개선 권장)

- **I-1 [CWE-613] `POST /api/auth/extend` 에 `requireEnrolled` 없음** (`routes/auth.js:128`). OTP 미등록 부트스트랩 세션도 만료 임박 시 토큰을 연장할 수 있다. 실효 영향은 작다(등록 외 API 는 여전히 `requireEnrolled` 로 차단, 비번 재로그인도 가능). `verifyToken` 직접 호출(`:131`)은 `authMiddleware`(=`resolveTokenUser`) 뒤에 있고 `sid/tv` 를 승계하므로 CLAUDE.md '토큰 검증은 resolveTokenUser 하나로' 취지에 반하지 않음(회귀 아님). 권장: `authMiddleware, requireEnrolled` 로 마운트.
- **I-2 [CWE-307/CWE-770] 로그인 잠금 키가 `TRUST_PROXY` 를 무시** (`routes/auth.js:47` `gateIp = req.socket.remoteAddress`). `util/rateLimit.js:18-23 clientIp()` 는 trust proxy 설정 시 `req.ip` 를 쓰는데 로그인 잠금만 소켓 주소 고정이라, HAProxy/nginx 뒤 배포에서는 **모든 클라이언트가 한 IP 키**를 공유 → 임의 클라이언트가 8회 실패로 특정 계정을 전 사용자에게 15분 잠글 수 있다(계정 전역 레이어 80회보다 훨씬 낮은 임계로 가용성 공격 성립). 스푸핑 우려는 `clientIp()` 가 이미 TRUST_PROXY 설정시에만 XFF 를 신뢰하므로 `clientIp(req)` 로 통일하면 해결.
- **I-3 [CWE-918(관리자 주도)] `POST /api/auth/ad-test`** (`routes/auth.js:202-205`)는 `adminOnly` 만(설정 소유자 아님)이고 body `config.url`·`tlsRejectUnauthorized`·`timeoutMs` 를 그대로 `ldap.createClient` 에 넘긴다(`auth/ad.js:266-272`). 비소유자 admin 이 포탈을 임의 내부 호스트:포트로 접속시켜 오류 메시지·지연으로 도달성을 판별할 수 있다(저장 비밀 유출은 없음 — AD 는 서비스 계정을 저장하지 않음). `PUT /ad-config` 가 owner 경계인 것과 등급을 맞추거나 `ssrfBlockReason` 을 url 에 적용 권장.
- **I-4 [기능 회귀, 보안 아님] `AUTH_ENABLED=false` 에서 WS SSH/RDP 가 항상 거부**: `sshGateway.js:38-51` 은 인증 off 면 `user=null` 로 `handleConnection` 에 넘기고, `mappingAccessIssue(null, m)`(`:62`) 는 `!user` 에 즉시 '매핑을 찾을 수 없습니다.' 를 반환한다(guacdTunnel.js:73 동일). 보안상 fail-closed 라 문제는 아니나 의도된 동작인지 확인 필요.

---

## 확인된 양호한 방어 (코드로 확인, 회귀 없음)

- **마운트 체인**: `index.js:171-182` 보호 라우터 전부 `authMiddleware → requireEnrolled` (upgrade/admin/remote/ping 은 `auditMiddleware`, insights 는 `requirePerm('insights')` 추가). `/api/auth` 만 공개 마운트이고 그 안의 admin 라우트는 `adminOnly=[authMiddleware, requireEnrolled, requireRole('admin')]`(`routes/auth.js:187`), `PUT /ad-config` 는 `requireSettingsOwner` 추가(`:197`) — 2026-08-17 #3 유지.
- **토큰**: `verifyToken` 직접 호출은 `routes/auth.js:131`(위 I-1) 뿐, WS 게이트웨이·HTTP 모두 `resolveTokenUser`(`auth.js:886-912`: 서명·exp·삭제 계정·단일세션 sid·tokenVersion·**레코드 기준 role/scope/mustEnrollOtp**). HMAC 은 헤더 alg 와 무관하게 SECRET 고정(알고리즘 혼동 없음). `tokenVersion` 인상 지점: 비번 설정·로그인 차단·역할 변경·OTP 등록/해제·중앙 비번 회전(`:430,455,487,795,847,543`).
- **OTP**: 로그인(`auth.js:299-305`)·재인증(`verifyUserOtp :754-773`) 모두 `minCounter=totpLastCounter` 로 1회용 + 계정 단위 잠금(`loginRateLimit.js:100-141`, 창≤잠금 클램프). 등록 확정도 카운터 기록(`:791`). `disableTotp` 의 `force` 는 HTTP 에서 전달되지 않음(`admin/users.js:94`).
- **부트스트랩 3단계**: `authenticateLocal :308-312` (OTP 전용 강제 시 미등록만 비번 허용) → `mustEnrollOtp` 매 요청 계산(`:907`) → `confirmTotpEnroll` 이 `isOtpOnlyUser` 일 때 passwordHash 삭제 + tv 인상 + `initial-admin-password.txt` 삭제(`:794-801`).
- **AD/LDAP**: `authenticateAD :242` 빈 비밀번호 거부(unauthenticated bind 차단), 필터 값 RFC4515 이스케이프(`ad.js:213-218`), 그룹 매칭 기본 exact, LDAPS 검증 기본 ON.
- **로그인 레이트리밋**: per-IP(8/15분) + 계정 전역(×10) 이중(`loginRateLimit.js:53-94`), 존재하지 않는 사용자도 동일 scrypt 비용(`auth.js:292-293`), 사용자명/비번 타입 검증(`routes/auth.js:41`).
- **설정 소유자 경계** `requireSettingsOwner`(`admin/shared.js:33-40`, username 정확일치): `/backup/{status,download,view,settings,now,restore,delete}` 전부(`backupNetSec.js:32-58`), `/central-token`(GET/PUT/generate), `/central/agent-tokens` 발급·회수, `/security/session`, `/secrets/policy`, `/mail*`, `/host-access/*`(+본인 OTP `requireOwnOtp`), `/edge-users*`, `/collectors/set-password`, `/ad-config` PUT. 보호 계정 가드 3종(`credentialGuardDenied·identityGuardDenied·ownerSetEntryDenied`)이 사용자 관리 6경로 전부에 `actor` 를 받는다(`admin/users.js`).
- **상태변경 RBAC**: 추출한 POST/PUT/PATCH/DELETE ~330건 중 게이트 없는 것은 읽기성 4건뿐 — `POST /search/nl`(scope 적용 `searchNotes.js:14`), `POST /insights/chatops`(scope `insights.js:268`), `POST /provision/preview`(`canProvision`), `POST /tool-usage`(사용 빈도 카운터). svcmon 은 `canEdit/adminOnly`, capacity 는 `router.use(adminOnly)`, `/tools/*` 는 `requirePerm('tools')`/`toolsPerm`+`fullScopeOnly` 또는 `adminOnly`, IPAM 쓰기는 `requirePerm('tools')`+`writeScopeDenied`.
- **도구별 거부목록 서버 집행**: `api.js:40-45` + `auth/toolAccess.js`(register* 보다 먼저 등록).
- **scope**: `applyFilters(…, req.user)` 가 요청 필터보다 먼저 교집합(`api/shared.js:46-51`); 단건 라우트 404 규약 유지 — `/vms/:id/metrics`·`/hosts/:id/metrics`·`/vms/:id/console`(`vmMetrics.js:56,86,107`), `/datastores/:id/browse`(`inventory.js:317`), `/vcenters/:id/usage-history`(`toolsCapacity.js:304`), `/provision/saved/:id`(`provision.js:53`), `/provision/jobs/:id` 소유자 한정(`provision/jobs.js:59-64`), `/remote/rdp/:id`·`/remote/targets`(`remote.js:261-268,111-117`). `memoJson` 호출 18곳 모두 `extraKey`(파일별 `extraKey` 출현 수 ≥ `memoJson` 수) — `/summary`·`/overview` 캐시 누수 회귀 없음. 2026-08-17 조치(`/tools/vmware-config`·`network-check`·`ip-ping`·`idrac/host-power`·nsx·provision·vclogs) 코드 유지 확인.
- **WS 게이트웨이**(`sshGateway.js:38-51`, `guacdTunnel.js:55-65`): `resolveTokenUser` → `mustEnrollOtp` 403 → `userHasPermission('remote.access')` → 연결 시 `mappingAccessIssue`(소유자 없는 매핑 admin 전용 + `targetHostScopeIssue`) 재검사, RDP 자격증명은 1회용 티켓만(`consumeRdpTicket`, 쿼리 폴백 없음), SSH auth 프레임 중복 거부·세션 상한·유휴 타임아웃. catch-all 리스너는 존재(`index.js:307-311`) — 단 F-1 의 순서 의존 결함.

## 미확인/범위 밖 메모

- `agent/usersConfigPull.js` 및 `routes/central.js` users-config 의 `passwordHash` 신뢰 범위(F-3 전제)는 central 감사(별도 범위)에서 확인 권장.
- svcmon 조회(`/state`·`/edges`·`/log`)는 "조회=로그인 사용자" 설계이며 vCenter 귀속 데이터가 아니라 scope 판정 대상에서 제외했다(엣지 agent 이름·점검 대상 host 가 viewer 에게 보이는 것은 설계 확인 필요).
