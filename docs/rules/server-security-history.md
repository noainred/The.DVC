# 규칙 — 서버 보안 감사 조치 기록(2026-09-12 ~ 2026-10-16)

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 원문 그대로다. "되돌리지 말 것" 규칙은 그대로 유효하다 — 서버의 인증·권한·SSRF·비밀·엣지 수신·장비 신뢰·세션 코드를 고치기 전에 읽을 것.

## 목차

- 2026-09-12 보안 감사 조치 — 되돌리지 말 것 (security_check_20260912.MD)
- 2026-09-13 보안 전수 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-13.md)
- 2026-09-13 성능·보안 전수조사(v2.503) 조치 — 되돌리지 말 것 (docs/PERF-AUDIT-2026-09-13.md)
- 2026-09-13 감사 미해결 3건 조치(v2.506) — 되돌리지 말 것
- 2026-09-16 자격증명·비밀 추적 감사 조치(v2.535) — 되돌리지 말 것 (docs/AUDIT-2026-09-16.md)
- 2026-09-16 인증·인가 게이트 전수 감사 조치(v2.536) — 되돌리지 말 것 (docs/AUDIT-2026-09-16b.md)
- 2026-09-16 외부 입력 → 장비 접속·명령 경로 감사 조치(v2.537) — 되돌리지 말 것 (docs/AUDIT-2026-09-16c.md)
- 2026-09-16 저장 파일·저장 데이터·외부 공격면 감사 조치(v2.538) — 되돌리지 말 것 (docs/AUDIT-2026-09-16d.md)
- 2026-09-17 SSH 인증 실패가 주기 수집을 멈추지 않던 결함(v2.541) — 되돌리지 말 것
- 2026-09-24 암호화 모드 재봉인 비용 조치(v2.598 L2598-01) — 되돌리지 말 것
- 2026-09-24 v2.599 조치 — 되돌리지 말 것
- 2026-09-26 v2.621 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-26c.md)
- 2026-09-27 v2.622 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-27.md)
- 2026-09-29 super_admin · CSV 권한(v2.643) — 되돌리지 말 것
- 2026-10-07 mock 모드 내장 데모 계정(v2.716) — 되돌리지 말 것
- 2026-10-09 검토 보고서 — 세션·AD(S-03·S-05·S-06·S-08) — 되돌리지 말 것
- 2026-10-09 검토 보고서 — SSH 호스트키·원격 콘솔 세션·출력 백프레셔(S-01·S-04·I-07) — 되돌리지 말 것
- 2026-10-15 v2.741 점검 — 수집기 라우터 순서·인증 실패 판정·SSH 세션 예산 — 되돌리지 말 것 (docs/AUDIT-2026-10-15b.md)
- 2026-10-16 v2.742 점검 — 자격증명 거부 판정·지속형 503·주문형 로그인 — 되돌리지 말 것 (docs/AUDIT-2026-10-16.md)
- 2026-10-16 v2.743 점검 — 관리자 판본 단일 판정·엣지 등록부 손상 503 — 되돌리지 말 것 (docs/AUDIT-2026-10-16b.md)

## 2026-09-12 보안 감사 조치 — 되돌리지 말 것 (security_check_20260912.MD)

- **central 바인딩은 '실제 저장 키'를 검사한다**(`routes/central.js` requestedAgent/registerName): `/register-collector`
  의 저장 키는 `body.name` 이므로 헤더/쿼리 `agent` 와 **별도로** 항상 대조한다(H-1). agent 이름을 여러 소스에서 OR
  단락으로 고르는 새 라우트를 만들 때, '헤더 하나로 본문 키 검사를 건너뛰는' 형태를 만들지 말 것 — 개별 토큰 엣지가
  남의 수집 서버 URL·토큰을 덮어써 중앙이 그 URL 로 자격증명을 실어 호출하게 되는 유출 피벗이 된다. 회귀 테스트:
  `test/securityH1RegisterCollector.test.js`.
- **연결 테스트 host/url 저장값 고정은 remote 프록시에도 적용**(`routes/remote.js` /test·/deploy/test, H-2): 저장 비밀
  (`********`/미입력) 재사용 시 dataplane url·deploy host/port 를 저장값으로 고정하고 `ssrfBlockReasonResolved`/`ipBlockReason`
  을 건다. v2.480 규칙(vCenter/NSX/…)의 형제 라우트 누락이었다 — 새 "저장 항목 연결 테스트" 는 전부 이 규칙을 따른다.
- **WS upgrade 리스너에서 `new URL(req.url)` 은 try/catch**(`proxy/sshGateway.js`·`guacdTunnel.js`, M-1): 잘못된 요청줄
  로 throw 하면 EventEmitter 가 뒤 리스너(index.js catch-all 소켓 파기)를 호출하지 않아 무인증 FD 누수가 된다. 파싱
  실패 시 throw 대신 return 하고 catch-all 이 파기하게 둔다. 새 upgrade 리스너도 동일.
- **ping 조회 라우트 scope**(`routes/ping.js`, M-2): vCenter 타깃(`vc_<id>`)은 `scopedVcenterIds` 로 거른다(단건 404).
- **패키지/업그레이드 원격 fetch 는 SSRF 가드**(`upgrade/fetchPackage.js` fetchRemoteVersions, M-3): admin 지정 baseUrl 도
  `ssrfBlockReasonResolved` 통과 후에만 조회한다.
- **압축 해제는 출력 상한**(`upgrade/archive.js`, L-1): `zlib.gunzipSync`/`inflateRawSync` 에 `maxOutputLength: MAX_BUNDLE_BYTES`.
  express.raw 본문 한도는 MAX_BUNDLE_BYTES 근처(210mb)로 유지.
- **verifyPassword 는 해시/솔트 길이를 검증**(`auth/auth.js`, L-7): `scrypt$<32hex salt>$<128hex hash>` 규격 미달(특히 빈
  해시)은 즉시 false — 손상/주입 해시가 만능키가 되지 않게. 회귀 테스트: `test/security2026-09-12.test.js`.
- **장비 TLS 상대 인증 — 판정은 `security/tlsTrust.js` 하나**(2026-10-09 S-02, 사용자 승인 기본값 전환 — 예전 M-4 '기본은 자체서명 허용' 을 대체):
  자격증명을 보내는 장비 클라이언트(vCenter·NSX·iDRAC/OME·Horizon·스토리지 REST·Isilon·SAN REST·CVP)는 Agent 의 connect 를 `deviceTlsConnect` 로 만든다 —
  CA 체인(시스템 + `CONFIG_DIR/tls-ca-bundle.pem`) 또는 peerTrust 승인 지문만, 판정은 핸드셰이크 직후·요청 전. env 미설정=판정 · `true`=엄격 · `false`=명시적 예외
  (상태 `exceptions`·자가진단 relax-switches). 새 장비 클라이언트는 이 함수를 쓸 것(`rvI_tlsTrust` ⑨ 스윕이 9개 파일을 고정). 거부 오류(`ERR_TLS_PEER_UNTRUSTED`)에
  `authFailed` 를 붙이지 말 것 — authGuard 가 인증 정지로 읽는다. 무인증 probe(자격증명 없음)만 판정 밖이고 그 dispatcher 로 로그인하지 말 것(idrac probeDispatcher).
  재개 세션은 인증서를 다시 보내지 않으므로 판정 통과 세션만 기억한다. 전역 디스패처로 바꾸지 말 것. (v2.574 SEC-16 'Horizon 기본값은 그대로 둔다' 도 이 결정으로 대체됐다.)
- **.gitignore 는 SECRET_FILES 를 모두 포함**(L-8): `SECRET_FILES ⊆ .gitignore` 를 유지하고, 런타임 DB 는 `server/config/*.db`
  와일드카드로 선차단한다. 배포 기본값(`ipam-scan.json`)에 활성 스캔을 커밋하지 말 것(L-9 — 없으면 스캔 기본 비활성).

## 2026-09-13 보안 전수 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-13.md)

8도메인 병렬 감사(라우트 701건 전수 포함) 확정 조치. 회귀 테스트: `test/securityAudit2026-09-13.test.js`(16건).

- **경로 문자열 비교로 보안 게이트를 만들지 말 것**(`routes/central.js`, C-1 critical): v2.488 의 H-1 대조가
  `req.path === '/register-collector'` 정확 일치에 걸려 있어 **Express 기본 라우팅에서 우회됐다** —
  `strict routing=false`·`case sensitive=false` 라 `/register-collector/`·`/Register-Collector`·
  `/register-collector/.` 은 핸들러에 도달하면서 그 비교만 거짓이 된다(3변형 모두 200 등록 실측).
  이제 강제는 **핸들러 안**(`registerBindingDenied`)에서 경로와 무관하게 하고, 미들웨어의 `normPath()` 는
  심층 방어일 뿐이다. 새 게이트를 `req.path ===` 로 만들지 말 것. 테스트는 변형 경로를 반드시 포함한다.
- **접속처가 바뀌면 저장 비밀을 승계하지 않는다 — 판정은 `util/secretCarry.js` 하나로**(H1·H2·H4):
  `accessMoved(prev, body, idKeys)` + `dropCarriedSecrets(target, body, secretKeys)`. 같은 결함이
  `agent/deployRegistry.js`(SSH 비번·CENTRAL_TOKEN·COLLECTOR_TOKEN)·`proxy/registry.js`(Data Plane URL·
  SSH host)·`net/monitor.js`(캡처 호스트) 세 곳에서 **독립적으로** 발견됐다 — 각자 구현하면 다음 스토어에서
  또 빠진다. v2.480 의 "연결 테스트는 host 를 저장값으로 고정" 은 테스트 라우트만 막으므로, **저장 시점**에
  버리는 이 규칙이 함께 있어야 한다(저장 요청을 한 번 끼우면 그 방어를 지나간다).
  `idKeys` 는 '어디에 접속하는가' 를 정하는 필드다(`['host','port','username']` 또는 `['url']`).
  버릴 때는 `delete`(키 제거)다 — `''` 로 덮으면 "빈 값 = 기존 유지" 규칙을 타는 구현에서 되살아난다.
- **중앙 토큰을 원격 호스트에 배달하는 경로는 설정 소유자 전용**(`routes/admin/deployLlm.js`, H3):
  `autoCentralToken` 은 평문 CENTRAL_TOKEN 을 요청자가 지정한 host 의 `portal.env` 에 기록한다 —
  백업 아카이브와 같은 등급의 자산이므로 `ownerIfAutoCentralToken` 으로 게이트한다(옵션을 쓸 때만 게이트해
  토큰을 직접 입력하는 기존 흐름은 보존). adminOnly 만으로 두면 소유자가 아닌 admin 이 토큰을 받아간다.
- **상태변경 라우트 RBAC 은 `requirePerm` 만으로 대체되지 않는다**(`routes/api/inventory.js`, B/M-1):
  `inv.alarms` 는 **viewer 기본 권한**이고 `requirePerm` 은 역할을 보지 않는다. 알람 음소거 생성/삭제가
  그 상태로 열려 있어 viewer 가 전 vCenter 알람을 영구 음소거할 수 있었다(AUDIT-2026-06-27 C2 의 회귀).
  `requireRole('admin','operator')` + `requirePerm` **둘 다** 걸고, 범위 제한 계정은 전 vCenter 규칙을
  만들거나 지울 수 없게 한다(`alarm-mutes.js muteCreateIssue`/`muteDeleteIssue`/`visibleMutes` — 전 vCenter
  규칙은 그 사용자 화면에도 적용되므로 **목록에서는 숨기지 않는다**).
- **역할별 축약은 응답을 스프레드하지 말고 전용 모듈에서**(`relaycheck/view.js`, D/M1): v2.478(S9)은
  `targets[].host/port` 만 가렸는데 라우트가 `relayCheckStatus()` 를 `...st` 로 펼쳐 `settings.hosts` 와
  `results[].target.host/port` 가 그대로 나갔고, `key` 가 `"host:port"` 라 가린 값이 복원됐다.
  `relayCheckView(st, targets, isAdmin)` 를 통과한 것만 내보내고, 가린 사실은 `redacted` 로 밝힌다
  (operator 는 `tools` 를 기본 보유한다 — '거부 기본값' 규칙).
- **로그인 잠금에는 계정명과 무관한 출발지 카운터가 있어야 한다**(`security/loginRateLimit.js`, A/M-1):
  `<ip>|<user>`·`acct:<user>` 만으로는 **사용자명을 매번 바꾸면** 어느 카운터도 차지 않는다. 로그인은 요청마다
  동기 scrypt(측정 ~48ms)를 태우므로 단일 출발지로 이벤트 루프를 포화시킬 수 있다. `ip:<ip>` 카운터를
  per-IP+계정 키보다 높은 임계(기본 6×)로 두고, 정상 로그인 1회가 리셋한다(NAT 오탐 완화).
- **로그인 응답시간은 자격 종류와 무관해야 한다**(`auth/auth.js` `burnPasswordWork`/`equalize`, A/M-2):
  더미 scrypt 를 '없는 사용자' 에만 태우면, OTP 전용 + 등록 완료 계정(= 관리자의 최종 상태)이 OTP 형식 검사에서
  즉시 반환돼 없는 계정보다 650배 빨라진다 → **계정당 1회 요청으로 관리자 계정 열거**(잠금 미발동).
  비밀번호 KDF 실행 여부를 추적해 **성공·실패·조기반환 전 경로**에서 작업량을 맞춘다.
- **보존일은 정리 시점이 아니라 조회에서도 강제**(`perf/hangLog.js readHangs`, H/M-1): 정리가 기동·설정 저장·
  append 200건마다만 돌아 hang 이 드문 환경에서는 14일 설정에도 사용자명·IP·UA 가 수십 일 조회됐다.
  컷오프를 조회에 적용하고 가린 건수를 `staleHidden` 으로 밝힌다(조용히 줄이면 '기록이 왜 없지' 가 된다).
- **비밀 파일은 SECRET_FILES 등록과 `.gitignore` 를 **함께**(C/M4): `bm-storage.json` 이 둘 다 빠져 있었다.
  `SECRET_FILES ⊆ .gitignore` 는 회귀 테스트로 고정했다 — 등록만 하고 차단을 잊는 사고를 막는다.
  v2.49x 런타임 파일(`perf-hangs.ndjson`·`perf-monitor.json`·`central-unsupported-servers.json`)도 차단 대상이다.
- **엣지가 push 한 설정 사본도 손상 보존 대상**(`central/agentConfig.js`, C/M3): `central-agent-config.json` 은
  각 법인의 `portal.env`(AUTH_SECRET·CENTRAL_TOKEN)·`users.json`(TOTP)·`vcenters.json` 사본이다. 로드 catch 가
  조용히 `{}` 를 돌려주면 3초 디바운스 persist 가 온전했던 원본을 덮어써 전 법인 사본이 유실된다.
- **소스에 리터럴 NUL 바이트를 두지 말 것**(`svcmon/store.js`, C/L4): `file(1)` 이 `data` 로 보고 grep/ripgrep 이
  **파일 전체를 건너뛰어** 보안 감사의 사각지대가 된다(루트 CLAUDE.md v2.478 오판과 같은 원인).
  같은 값을 `\u0000` 이스케이프로 쓴다. 탐지는 `tr -cd '\000' < 파일 | wc -c`.
- **범용 압축 유틸은 경로 탈출을 스스로 막는다**(`util/zip.js zipMany`, H/L-1): 현재 호출부가 안전해도
  다음 호출부가 vCenter/VM 문자열을 그대로 넘길 수 있다 — 세그먼트 `..`·드라이브 문자를 거부한다.
- **동시 실행 가드의 409 응답에 타 사용자 계정명을 싣지 말 것**(`routes/api/toolsCapacity.js`, H/L-2):
  tools 권한만 있는 계정이 연타해 관리자 로그인 ID 를 알아내는 계정 열거 단서다(본인일 때만 표기).

## 2026-09-13 성능·보안 전수조사(v2.503) 조치 — 되돌리지 말 것 (docs/PERF-AUDIT-2026-09-13.md)

성능 5도메인 + 보안 2도메인 병렬 감사. 회귀 테스트: `test/audit2503.test.js`(16건).

- **idKeys 는 '최종 요청 URL 을 만드는 모든 필드' 다**(`proxy/registry.js`, S-1 high): v2.500 은
  Data Plane 의 idKeys 를 `['url']` 로 뒀는데, 실제 요청 주소는 `proxy/dataplane.js base()` 에서
  `url + (basePath || '/v3') + '/services/haproxy'` 로 **문자열 연결**된다. 그래서
  `{basePath:'@attacker.example/v3', password:'********'}` 로 저장하면 `accessMoved` 가 거짓이라
  비밀번호가 승계되고, 조립된 주소는 앞부분이 **userinfo 로 접혀** 호스트가 공격자 것이 된다
  (`new URL(...).host === 'attacker.example'` 실측). 이제 `DP_ID_KEYS=['url','basePath']` 이고
  `basePathIssue()` 가 `@`·`//`·`?`·`#`·공백·제어문자·비-`/` 시작을 거부한다. **새 스토어의 idKeys 를
  고를 때 호스트 필드만 넣지 말 것** — 경로 조각·포트·계정 등 요청 대상을 바꿀 수 있는 필드 전부다.
- **`util/secretCarry.js` 는 자격증명 스토어 **전부**에 적용한다**(S-2): v2.500 이 세 곳만 고치고
  나머지를 '추정' 으로 남겼는데, 재감사에서 `vcenter/registry.js`·`nsx/registry.js`·`idrac/registry.js`·
  `horizon/horizon.js`(host/username[/domain] 변경) · `collector/registry.js`(url 변경 → **수집 토큰**) ·
  `gpu/physicalRegistry.js`(host/port/username 변경 → SSH 비번)에서 **코드로 확인**됐다. 저장 요청
  1회로 접속처만 바꾸면 다음 수집에서 운영 자격증명이 그 호스트로 평문 전송된다. 새 스토어를
  만들면 여기에 추가할 것 — 회귀 테스트가 이 6개 파일의 import 를 검사한다.
- **역할별 축약은 하위 객체까지 가린다**(`proxy/registry.js getConfigSafe`, S-3): `{...c}` 뒤에
  최상위만 덮어쓰면 `c.proxies[]` 하위 비밀이 그대로 나간다(v2.500 D/M1 relaycheck 과 같은 원인).
  `normalizeProxy` → `redactProxy` 순서를 지킬 것(구버전 항목에 dataplane 이 없으면 redact 가 던진다).
- **계정 무관 로그인 잠금의 출발지는 `clientIp(req)`, 잠금은 짧게**(`security/loginRateLimit.js` ·
  `routes/auth.js`, S-4): v2.500 이 추가한 `ip:` 카운터는 ① `req.socket.remoteAddress` 고정이라
  리버스 프록시 뒤에서 **전 사용자가 한 키를 공유**했고 ② 일단 잠기면 `checkLoginAllowed` 가 시도
  자체를 막아 "정상 로그인 1회가 리셋한다" 는 **발동할 수 없었다**(자기지속) → 48회 실패로 15분
  전체 로그인 마비. 이제 출발지는 전역 레이트리밋과 같은 `clientIp(req)`(trust proxy 규약, v2.428)이고
  이 레이어만 `LOGIN_IP_LOCKOUT_MS`(기본 60초)로 분리한다. 계정을 아는 브루트포스는 per-IP+계정
  (8회/15분)·계정 전역(80회/15분)이 그대로 막는다. **이 분리를 없애 LOCKOUT_MS 로 되돌리지 말 것.**
- **DB 파일은 예외 없이 `chmod 0600`**(`guestdisk/db.js`, S-5): v2.447 에서 12개 모듈에 일괄
  적용한 규약인데 v2.459 신규 파일만 빠져 있었다. 새 SQLite 모듈에도 반드시 넣을 것.

## 2026-09-13 감사 미해결 3건 조치(v2.506) — 되돌리지 말 것

`docs/PERF-AUDIT-2026-09-13.md` 4절에 '남은 미해결' 로 적어 둔 것 중 3건을 닫았다.
회귀 테스트: `test/audit2506.test.js`(28건 — 적대적 검증으로 11건을 고치고 테스트를 보강했다).

- **`/api/svcmon` 은 `requirePerm('svcmon')` 로 게이트한다**(`index.js`, S1 N-2):
  예전에는 `authMiddleware + requireEnrolled` 만 있어 **로그인한 아무 계정이나**
  `GET /api/svcmon/state?limit=2000` 으로 전 법인 감시 대상의 host(내부 IP/FQDN)·점검 포트·
  경로를 페이징할 수 있었다. 라우트 56개 중 읽기 6개(`/state`·`/edges`·`/edge-state`·
  `/templates`·`/log`·`/log/windows`)가 무가드였고, 같은 라우터의 로그 **파일** 라우트는 이미
  편집 권한을 요구하고 있었다(게이팅 비대칭). svcmon 에는 **vCenter scope 축이 없어** 범위 제한
  계정도 전량을 본다 — 그래서 조회 자체에 권한이 필요하다.
  · 엣지 수집은 `/api/central/svcmon-*`(개별 토큰)을 쓰므로 이 게이트와 무관하다(확인함).
  · 프론트 탭 게이트(`web/src/App.jsx`)도 **같은 키**를 써야 한다 — 다른 키면 '메뉴는 보이는데
    API 는 403' 이 되어 사용자가 장애로 오해한다. 예전 값은 `perm:'dashboard'`(전 역할 기본 보유)였다.
- **권한 키를 새로 추가할 때는 `SCHEMA_VERSION` 을 올리고 `KEYS_ADDED_IN` 에 적을 것**
  (`auth/permissions.js`, v2.506): `loadMatrix` 는 저장된 행을 그대로 쓰고(`m.operator ?? DEFAULT`),
  행은 '부여된 키의 배열' 이라 **"그 키가 없던 파일" 과 "관리자가 거부한 키" 를 구분할 수 없다.**
  그래서 카탈로그에 키만 추가하면 권한 UI 를 한 번이라도 저장한 현장에서 그 키가 조용히 '거부' 가
  되어 **operator 가 업그레이드만으로 기존 기능을 잃는다**. `migrateRow` 가 낮은 버전 파일에만
  **기본값에 있는 키를 가산**하고(관리자가 내린 결정은 건드리지 않는다), 저장 시 버전을 찍는다.
  `migrateRow` 는 순수 함수로 export 되어 있다 — 테스트로 고정할 수 있게 한 것이니 되돌리지 말 것.
- **DNS 리바인딩은 `lookup` 훅으로 막는다 — 판정은 `util/ssrfLookup.js` 하나로**(S1 #2):
  `ssrfBlockReasonResolved(url)` 로 검사한 **뒤 다시 호스트명으로 접속**하면 그 사이에 DNS 가
  바뀌어(TTL 0 리바인딩) 가드를 지나간다. 검사는 맞지만 **검사한 값으로 접속하지 않는 것**이 결함이다.
  · `net.connect`·`tls.connect`·`https.request`·`http.request`·undici `Agent` **전부 `lookup`
    옵션을 받는다.** 검증을 lookup 안에서 하면 소켓이 실제로 쓸 주소를 그 순간 검사하므로
    **TOCTOU 창이 0** 이고, SNI(`servername`)·Host·인증서 검증은 원 호스트명을 그대로 쓴다.
    ⚠ **DNS 조회 횟수는 줄지 않는다** — 초판 문서에 '2회→1회' 라고 적었는데 거짓이었다. IP 리터럴
    방어를 위해 사전 가드를 그대로 남겼기 때문이다(실측: 호스트명 대상 `resilientFetch` 1회 →
    `dns.lookup` 2회). 이 조치의 효과는 '간극 제거' 이고 '조회 절감' 이 아니다. 참조 구현은
    `uagmon/lib/uag.js:30-55`(IP 바꿔치기 방식)이며,
    접속 수단이 5가지로 갈리는 `server/src` 에서는 수단마다 SNI·Host 를 손으로 붙이다 한 곳을
    빠뜨리면 조용히 검증이 약해지므로 lookup 훅으로 일반화했다.
  · 배선 지점(`grep -rn "lookup: ssrfLookup" src/` = **11곳**): `util/resilientFetch.js`(wanAgent —
    dispatcher 미지정 전 호출부를 한 번에 덮는다)·`alerts.js`(webhookAgent)·`horizon/horizon.js`
    (dispatcher)·`vcenter/relayProbe.js`(**4곳** — net/tls/https/http)·`security/certMonitor.js`·
    `upgrade/upgradeAgent.js`·`relaycheck/checks.js`(**2곳**). relayProbe 를 2곳만 고치면 나머지
    2단계가 TOCTOU 로 남는다(실제로 그렇게 만들었다가 검증에서 잡혔다).
  · ⚠ **`resilientFetch(url, {dispatcher})` 로 dispatcher 를 직접 넘기면 wanAgent 의 lookup 이
    통째로 사라진다**(`const disp = dispatcher || wanAgent`). 새 Agent 를 만들어 넘길 때는
    `connect:{ lookup: ssrfLookup }` 을 직접 붙일 것 — `upgrade/upgradeAgent.js` 가 그 경우였다.
  · ⚠ **`globalThis.fetch` 에는 lookup 이 없다.** 토큰을 실어 보내는 호출을 전역 fetch 로 하면
    리바인딩으로 그 토큰이 사내 주소로 나간다 — `collector/registry.js` 의
    `verifyDerivedCollectorUrl` 이 `X-Collector-Token` 을 들고 그 상태였다(기본 `fetchImpl` 을
    `resilientFetch` 기반 `tokenFetch` 로 교체).
  · **멀티-A 는 걸러낸다, 전부 거부하지 않는다**(`filterAddresses`): '하나라도 차단이면 전체 거부' 로
    만들면 사내 **이중스택** 이름(A=192.168.x + AAAA=fd00::x, ULA 는 차단 대역)이 하드 실패한다.
    거른 주소는 후보 집합에서 사라지므로 리바인딩 방어는 동등하다. 남은 게 없을 때만 거부.
  · **한계(실측 확인)**: IP 리터럴 URL 은 lookup 이 불리지 않는다. 그래서 기존 동기
    `ssrfBlockReason(url)` 을 **없애면 안 된다** — 이 훅은 대체가 아니라 '이름이 IP 로 바뀌는
    순간' 을 덮는 보완이다. 타이머를 `unref()` 하지 말 것 — 실측(node 22): unref 한 타이머는
    다른 활성 핸들이 없으면 **울리지 않고 프로세스가 먼저 끝나고**(fired=false, 0ms), 활성 핸들이
    있으면 정상 발화한다(301ms). 즉 문맥에 따라 타임아웃이 있기도 없기도 한 비결정적 방어가 된다.
    (초판 문서의 '연결 무한 대기' 는 틀렸다 — 그 경우 프로세스가 먼저 끝난다.)
- **도구 거부목록은 '막을 수 있는 것' 과 '왜 못 막는지' 를 모두 선언한다**(`auth/toolAccess.js`, S1 #5):
  게이트는 `api.use('/tools', …)`(`routes/api.js`) 에만 걸려 있어, 자기 API 가 `/api/tools/*` 가
  아닌 도구는 구조적으로 범위 밖이다. 감사가 "41개 미매핑" 이라 한 것의 실체가 이것이다.
  · **두 세그먼트 매칭**(`TOOL_PATH2_KEYS`)을 추가했다 — `/tools/report/*` 한 세그먼트가 리포트
    도구 10개를 서비스해 첫 세그먼트만 보는 매처로는 구분할 수 없었다(10개 전부 미집행).
  · `capacity-forecast` 세그먼트는 **엉뚱한 키**(`capacity-forecast`)로 매핑돼 있었다 — 그 경로를
    부르는 화면은 `forecast` 다. 거부하면 다른 화면이 막히고 정작 그 도구는 안 막혔다.
  · **공유 엔드포인트를 한 도구에 묶지 말 것** — `/tools/groups`(특수기능 헤더 공용 콤보)나
    `/tools/ip-ping`(VM 상세에서도 쓴다)을 묶으면 그 도구를 거부한 역할의 **다른 화면이 깨진다.**
  · 못 막는 도구는 `TOOL_ENFORCEMENT_NOTES` 에 **분류 + 사유**로 선언하고, `/admin/permissions`
    응답의 `toolEnforcement` 로 화면에 내려보낸다(관리자가 '차단됨' 을 보고 막힌 줄 오인하는
    무음 실패를 없애는 것이 이 모듈의 존재 이유인데 41개에 남아 있었다).
  · `toolCoverage().undeclared` 가 **0** 임을 테스트가 고정한다 — 새 도구를 추가하면서 매핑도
    선언도 빠뜨리면 CI 가 깨진다. 이 테스트를 지우면 구멍이 다시 조용히 넓어진다.
  · ⚠ **경로 매칭은 소문자로 한다**(`stripExt`): Express 의 `case sensitive routing` 기본값은
    false 다. 대소문자를 구분해 매칭하면 `/api/Tools/Ipam` 이 **라우트에는 닿으면서 매핑만 빗나가**
    게이트 전체를 우회한다(적대적 검증에서 실제로 뚫렸다). 소문자화는 과차단을 만들지 않는다.
  · ⚠ **선언 사유는 '실제로 열어 확인한 것' 만 적을 것.** 초판은 `aisearch`·`explore` 를
    "각자 requirePerm/adminOnly 로 보호됨" 이라 적었는데 `/search/nl`·`/top` 에는 **게이트가
    아예 없었다**. 거짓 사유는 무음 실패보다 나쁘다(관리자가 잘못된 판단을 한다). 두 경로는
    각각 한 화면 전용임을 확인해 `TOOL_EXACT_PATHS` 로 **실제 집행 대상**으로 옮겼다 — 여러 화면이
    공유하는 경로는 절대 여기 넣지 말 것(`dsusage`=`/api/datastores` 가 그래서 SHARED 다).
  · 게이트 본체는 `toolGate({roleOf, issueOf})` 팩토리다 — `routes/api.js` 에 인라인으로 두면
    회귀 테스트가 **소스 문자열 grep** 밖에 할 수 없다(미들웨어 순서가 바뀌어도 통과한다).
    지금 테스트는 실제 express 앱에 이 미들웨어를 마운트하고 실제 `permissions.json` 을 읽혀
    대소문자·확장자·쿼리·끝 슬래시 변형까지 403 을 확인한다.
  · **`toolEnforcement` 를 화면이 실제로 쓴다** — `web/src/views/UserAdmin.jsx` 의 '도구별 접근'
    표에 '서버 집행' 열(`views/userAdmin/toolEnforcementText.js`, 순수 모듈 + 회귀 테스트).
    서버만 내려주고 화면이 쓰지 않으면 이 모듈이 없애려던 무음 실패가 그대로 남는다.

## 2026-09-16 자격증명·비밀 추적 감사 조치(v2.535) — 되돌리지 말 것 (docs/AUDIT-2026-09-16.md)

v2.529~2.534 에 새로 들어온 코드(Horizon 세션 수집·스토리지 증가량·Unity uemcli·PowerMax 용량·
전산실 온도)를 **자격증명·비밀이 어디로 흐르는가** 축으로 감사했다. critical 0 · high 0 ·
medium 1 · low 3 이고 전부 고쳤다. 회귀 테스트: `test/secAudit2535.test.js`(15건 — 주석을
제거한 뒤 소스를 검사한다. 주석에 규칙을 적어 둔 것이 통과 근거가 되면 안 된다).

- **인증 실패 정지 코어는 `util/authGuard.js` 하나다**(medium — 실재 결함):
  스토리지는 v2.528(사용자 신고 PowerStore 401)에 `storage/authGuard.js` 를 가졌는데
  **Horizon 세션 수집에는 같은 방어가 없었다**. `horizon/sessionCollect.js` 는 401/403 을
  `kind:'auth'` 로 정확히 분류하는데 폴러가 그것을 **소비하지 않아**, 다음 주기에 같은 AD
  계정으로 다시 로그인했다 — 기본 5분·하한 60초이므로 서버 1대당 **하루 288~1,440회 실패
  로그인**이고 그것이 **AD 서비스 계정을 스스로 잠그는 경로**다(`util/bulkRun.js` 의
  '자동 재시도 금지' 가 막으려던 것과 같은 사고).
  · 코어를 `util/authGuard.js` 로 올렸다(`createAuthGuard({file})` 팩토리 + `isAuthFailureText`
    + `credHashOf`). `storage/authGuard.js` 는 **위임만** 하고 export 시그니처는 그대로다
    (기존 `storage/poller.js`·테스트 무변경). **20줄을 복사하지 말 것** — 복사하면 다음 도구에서
    또 빠진다(`console/`↔`version_3/` 중복으로 v2.506 svcmon 버그를 두 곳에 고쳐야 했다).
  · **정지 파일은 도구마다 다른 이름**이어야 한다(`storage-auth-stops.json` /
    `horizon-auth-stops.json`). 한 파일에 섞으면 도구 A 의 id 와 B 의 id 가 충돌해 **엉뚱한
    대상이 멈춘다**.
  · Horizon 쪽 배선 규칙: **주기 수집만** 막는다(`trigger !== 'manual'`). '지금 수집' 과 연결
    테스트는 그대로 동작해야 한다 — 비밀번호를 고친 뒤 확인할 길을 없애면 안 된다.
    정지 결과는 `kind:'auth-stopped'` 로 **화면에 표시**하고(수치는 전부 `null` — 0 은
    '사용자 0명' 이라는 거짓이다), 자격증명이 바뀌면 `credHash` 비교로 **자동 재개**한다.
    작업 로그에는 남기지 않는다(정지 중에는 이벤트가 아니다 — 상한을 비이벤트로 소진한다).
  · **새 주기 수집기를 추가하면 이 가드를 붙일 것.** 붙이지 않으면 그 도구가 다음 계정 잠금
    사고의 경로가 된다.
- **우연히 성립하는 게이트를 두지 말 것**(low — `routes/api/pdu.js` CSV export):
  예전 조건은 `if (withPw && !req.user?.isSettingsOwner)` 였다. 그런데 **`req.user` 는
  `isSettingsOwner` 를 담지 않는다** — `auth/auth.js resolveTokenUser` 의 반환은
  `{username, role, name, scope, mustEnrollOtp}` 뿐이고 `isSettingsOwner` 는 `routes/auth.js` 의
  로그인·`/auth/me` **응답 필드로만** 계산된다. 즉 그 조건은 언제나 참이라 결과적으로 닫혀
  있었다 — **우연히** 안전했던 것이다. 누군가 그 필드를 미들웨어로 올리는 순간(그럴 만한 코드가
  이미 있다) 평문 자격증명 일괄 덤프가 소유자 검사 없이 나간다. 이제 `requireSettingsOwner` 를
  **무조건** 통과시킨다. 같은 유형이 v2.500 C-1(경로 문자열 비교)이었다.
  · 일반 규칙: **게이트는 그 시점에 실제로 존재하는 값으로만** 판정한다. '그 필드는 없으니까
    안전하다' 는 근거는 다음 리팩터에 무효가 된다.
- **런타임 상태 파일은 `.gitignore` 에 함께 등록한다**(low): 기본 `CONFIG_DIR` 이 `server/config`
  라 개발 호스트에서 `git add -A` 하면 그대로 올라간다(공개 저장소다). `git check-ignore` 로
  확인해 6종이 빠져 있었다 — `horizon-sessions.json`(Horizon 커넥션 서버 host·계정) ·
  `horizon-session-activity.json` · `horizon-auth-stops.json` · `storage-auth-stops.json`
  (자격증명 **지문**) · `storage-growth-settings.json` · `vmseries.json` + 디렉터리
  `server/config/vmseries/`. 형제 `server/config/vmperf/` 는 이미 등록돼 있었다.
  · **새 설정·상태 파일을 만들면 그 커밋에서 `.gitignore` 를 함께 고칠 것.** 비밀을 봉인하는
    `SECRET_FILES` 등록과 **별개의 항목**이다(봉인해도 host·계정명·지문은 평문으로 남는다).
- **SQLite 파일 권한은 워커에도 적용된다**(low — `ipam/writeWorker.js`): 메인 스레드는 DB 를
  열고 `chmodSync(0o600)` 하지만, 워커가 **먼저** 열면 umask 기본값(0644)으로 만들어지고 메인의
  chmod 는 그 뒤에 온다 — 경합 창이 존재했다(`ipam.db` 는 외부 프로그램이 읽는 공유 파일이라
  WAL 전환 금지 규칙만 있고 권한 규칙이 빠져 있었다). 워커도 연 직후 chmod 한다.
  · **새 DB 모듈·워커는 열자마자 `chmodSync(0o600)`** 할 것. `secAudit2535.test.js` 가 소스를
    검사해 고정한다. ⚠ 그 검사 정규식에 `[^)]*` 를 쓰지 말 것 — `chmodSync(FILE(), 0o600)` 처럼
    인자에 괄호가 있으면 첫 `)` 에서 멈춰 **멀쩡한 모듈 4개를 누락으로 오판한다**(v2.535 에
    실제로 그랬다).

## 2026-09-16 인증·인가 게이트 전수 감사 조치(v2.536) — 되돌리지 말 것 (docs/AUDIT-2026-09-16b.md)

라우트 선언 **763개**의 미들웨어 체인을 전수로 떼어 '게이트가 실제로 존재하고 실제로 집행되는가'
를 봤다. critical 0 · high 1 · low 1 이고 둘 다 고쳤다.
회귀 테스트: `test/authzGates2536.test.js`(4건 — **실제 `api` 라우터를 express 에 마운트해
상태코드로** 본다. 소스 grep 이 아니다).

- ⚠⚠ **인벤토리 권한 `inv.*` 6종은 서버가 집행한다**(high — v2.535 까지 **집행 0**):
  `PERMISSION_CATALOG` 의 '인벤토리' 그룹 6개를 설정 › 사용자 관리가 체크박스로 켜고 끄는데
  `requirePerm('inv.…')` 를 쓰는 곳은 **알람 음소거 쓰기 2곳뿐**이었다. 실제로 쓰이던 자리는
  `web/src/App.jsx:51-58` 의 **탭 표시 조건** — **클라이언트 전용 접근제어**였다.
  · 실측(목 스냅샷 vms 2,242): `viewer` 권한을 `dashboard` 하나로 줄여도 `/api/vms` **200·500건** ·
    `/api/hosts` 186건 · `/api/datastores` 38건 · `/api/alarms` 58건이 나왔다. 같은 하니스에서
    `/api/tools/storage` 는 403 이었으므로 **하니스가 아니라 게이트가 없던 것**이다.
  · **키는 프론트 탭의 `perm` 과 글자 그대로 같아야 한다** — 다르면 '메뉴는 보이는데 API 는 403'
    이 되어 사용자가 장애로 오해한다(v2.506 svcmon 에서 실제로 겪었다). 테스트가 두 곳을 대조한다.
  · **집계(`/summary`·`/overview`·`/compare/matrix`·`/top`·`/vcenters`)는 `dashboard` 수준으로
    남겼다** — 개수·합계만 주고 이름·IP 를 주지 않는다. 조용히 둔 것이 아니라 코드 주석과 감사
    보고서가 그 경계를 밝힌다. 더 좁히려면 대시보드가 통째로 비므로 **별건**으로 다룰 것.
  · 기본 매트릭스는 operator·viewer 가 6종을 **전부 갖는다** → 기본 설치는 동작 불변(실측 확인).
  · v2.480(중계 주소)·v2.506(svcmon)과 **같은 유형의 세 번째 재발**이다. **새 권한 키를
    카탈로그에 추가하면 그 커밋에서 서버 집행 지점도 함께 만들 것** — 프론트 탭 조건만 쓰면
    그것은 접근제어가 아니라 '메뉴 숨김' 이다.
- **형제 라우트와 게이트 기준을 다르게 두지 말 것**(low — `routes/remote.js` `/targets`):
  `/remote/proxies` 는 v2.480 에 `requirePerm('remote.access')` 를 받았는데 `/targets` 는 빠져
  있었다. VM 이름·게스트 OS·전원·**전체 IP** 를 주는 경로다. ⚠ 정직 기록 — v2.535 까지는
  `inv.vms` 도 집행되지 않아 '추가' 노출은 아니었고, **위 항목을 고치는 순간 우회로가 되어서**
  함께 고쳤다. 한 화면(`RemoteAccess.jsx`)만 호출하므로 회귀 없음.
- **게이트 감사 스크립트를 쓸 때는 별칭을 해석할 것**(방법론 — 이 감사에서 실제로 겪었다):
  `const canProvision = requirePerm('vm.provision')` · `canEdit`(svcmon) 처럼 **이름이 가드처럼
  생기지 않은 별칭**을 못 읽으면 멀쩡한 라우트 40여 개를 결함으로 오판한다. 마운트 수준
  가드(`router.use(adminOnly)`)와 `app.use('/api/svcmon', …, requirePerm('svcmon'))` 도 선언
  줄에는 안 보인다 — **후보는 반드시 파일을 열어** 판정할 것.

## 2026-09-16 외부 입력 → 장비 접속·명령 경로 감사 조치(v2.537) — 되돌리지 말 것 (docs/AUDIT-2026-09-16c.md)

3차 감사. 명령 주입 축은 결함 0(tcpdump·SAN vfId·nvidia-smi·hostaccess·deploy·deepSearch 전부
준수 — 보고서 표), SSRF 축에서 medium 2 · low 2 를 고쳤다. 회귀 테스트 `test/ssrfAgents2537.test.js`.

- ⚠⚠ **undici `Agent` 를 만들면 예외 없이 `lookup: ssrfLookup` 을 붙인다** — 목록이 아니라 **전수 스윕**이
  고정한다(medium): v2.506 은 11곳을 배선하고 **그 11곳만** 테스트했다. `new Agent(` 전수를 뽑으니
  훅 없는 dispatcher 가 **9개** 더 있었다 — `vcenter/restClient.js`(SOAP·REST 공용)·`nsx/client.js`·
  `idrac/redfish.js`·`idrac/ome.js`·`storage/collectors/restCommon.js`·`isilon.js`·
  `sanswitch/collectors/fosRest.js`·`svcmon/checker.js`·`rma/testRunner.js`. 전부 사용자가 등록한
  host 로 **자격증명을 싣고** 접속하는 경로다.
  · 손 grep 은 8개를 셌고 **9번째는 스윕이 잡았다**(`await import('undici')` 로 한 줄에 만든 것).
    새 dispatcher 를 만들 때 "테스트 목록에 추가" 하는 방식이면 다시 빠진다 — 그래서 스윕이다.
  · 삼항으로 갈리는 connect(`nsx`·`vcenter`)는 `withSsrfLookup()` 으로 **삼항 바깥**을 감싼다 — 한쪽
    가지에만 붙이면 검증 ON/OFF 배포 중 하나에서 훅이 사라진다(테스트가 바깥 감싸기를 검사한다).
  · `connect: vcConnect` 처럼 **변수 참조**면 스윕은 그 변수의 정의가 `withSsrfLookup(` 인지 본다.
    변수를 다른 이름으로 옮기고 훅을 빼면 그 순간 잡힌다.
  · **실증 기준**: `fetch('https://localhost:1/', { dispatcher })` 가 `ECONNREFUSED` 가 아니라
    `ESSRFBLOCKED` 로 끝나야 훅이 산 것이다. 소스에 문자열이 있다는 것과 다르다.
  · ⚠ **운영 행동 변화**: `localhost` 처럼 이름이 루프백으로 해석되는 대상은 이제 전 클라이언트에서
    차단이다(svcmon http·RMA url 포함). 엣지 자기 서비스 점검은 `127.0.0.1`(IP 리터럴은 lookup 이
    불리지 않는다 — v2.506 문서의 한계) 또는 `SSRF_ALLOW_LOOPBACK=true`. 이 한계 때문에 IP 리터럴을
    받는 스캐너는 **정적 필터가 따로 필요**하다(아래).
- **등록부는 host 를 저장하기 전에 `ssrfBlockReason` 을 통과시킨다 — 다섯 등록부 전부**(medium/low):
  storage·sanswitch·pdu 는 v2.313 부터였고 **iDRAC·NSX 가 아니었다**(형식만 검사). bmstor(SSH)·
  `proxyHost` 도 추가. iDRAC 은 `normalize` 한 곳이 단건·수정·import·`bulkAddByIps`·`registerScanned`
  를 전부 덮는다(확인함) — **우회 경로(normalize 를 안 지나는 저장)를 만들지 말 것**. 기존 저장 항목은
  재검증하지 않는다(수정 시점에 걸린다).
  · `saveConfig`(기본 프록시)는 throw 로 알린다 — 라우트(`PUT /remote/config`)가 **400 + reason** 으로
    받는다. 500 으로 흘리면 사용자는 무엇을 고칠지 모른다.
- **IP 리터럴을 받는 스캐너는 차단 대역을 정적으로 거르고, 거른 개수를 말한다**(low — `idrac/scan.js`):
  `blocked`·`blockedIps`(상한 200)·`blockedTruncated` 가 로컬 `lastRun`(`scanPoller.js`)·위임 결과
  (`central/idracScanJobs.js` 기록·이벤트·result)·화면 문구(`scanRunText.js` `차단대역 제외 N`)까지
  이어진다. 조용히 빼면 '전부 스캔했다' 는 거짓이 된다. 새 스캐너(IPAM 등)도 같은 규칙.
- **고치지 않은 것과 이유**: `execAnswered` 의 `certAccept` 는 `Please input your selection` 꼬리에 `1`
  을 답하는 넓은 규칙이다 — 실장비에서 프롬프트와 데이터가 같은 줄에 붙어 와서 좁힐 수 없었다
  (v2.526). 조회(show) 명령에만 붙고 `1` 은 '이 세션만 허용' 이라 오답 피해가 없다. **파괴적 명령에
  이 규칙을 붙이지 말 것.**

## 2026-09-16 저장 파일·저장 데이터·외부 공격면 감사 조치(v2.538) — 되돌리지 말 것 (docs/AUDIT-2026-09-16d.md)

4차 감사. 목 서버를 인증 켠 채 띄워 **무인증으로 실제로 찔렀다**(경로 탈출·API 열거·브루트포스·
XFF 우회·대용량 본문). 경로 탈출·열거·잠금·헤더는 전부 막혀 있었고, medium 2 · low 2 를 고쳤다.
회귀 테스트 `test/atRest2538.test.js`(8건 — 순수 + 실제 파일 왕복 + **실제 서버 기동**).

- ⚠⚠ **대용량 JSON 파서는 인증된 요청에만 태운다**(medium — `util/bigJsonGate.js`, `index.js`):
  `app.use('/api/central/x', express.json({limit:'16mb'}))` 는 라우터의 토큰 검사보다 **먼저** 돈다.
  실측(목 서버): 무토큰 15MB 1건에 RSS 171→225MB, 6건 동시 409MB, 응답은 그 뒤에야 403 —
  인증 없이 프로세스 메모리를 밀어 올리는 경로였다. `bigJsonGate` 가 **파싱 전에** 토큰/세션 유효성만
  보고(부작용 없는 조회), 없으면 next() 로 넘긴다 → 전역 1MB 파서가 Content-Length 만 보고 413.
  · **이 게이트는 권한 판정이 아니다** — 인증·인가는 여전히 각 라우터가 한다. 게이트는 '파싱 허가'
    다. 두 판정이 어긋나도 안전한 쪽(파싱 생략)으로 실패한다.
  · 마운트 줄(`app.use('/api/central/…', BIG_JSON)`)은 **그대로 둔다** — v2.517·v2.520 테스트가 그 줄을
    고정하고, 새 push 경로를 만들 때 "BIG_JSON 에 등록" 규칙도 그대로다. 등록만 하면 게이트가 덮는다.
  · 마운트 안에서는 `req.path` 가 `/` 라 `req.baseUrl + req.path` 로 본다(초판이 이걸로 틀릴 뻔했다).
  · 실증 기준: **무토큰 3MB → 413, 유효 토큰 3MB → 413 아님** — 테스트가 실제 서버를 띄워 본다.
- **비밀 필드를 가진 파일은 ① load 에 `openSecretsDeep` ② save 에 `sealSecretsDeep` ③ `SECRET_FILES`
  등록 — 셋을 같이**(medium/low): `agent-assignments.json`(위임 스캔 iDRAC 비밀번호)·`guest-scans.json`
  (게스트 계정)·`upgrade.json`·`packages.json`(토큰)이 v2.537 까지 **셋 다 없었다**. v2.500 M4
  (bm-storage)와 같은 계열의 재발이다. 파일에 `password|token|guestPass|…` 를 새로 쓰면 이 세 줄부터.
  `configDir` JSON 전수표(감사 보고서)에서 `pwRefs>0 && seal=0` 인 파일이 곧 후보다.
- **백업 번들·엣지 설정 push 는 `.env` 의 키·토큰을 싣지 않는다**(medium — `util/envRedact.js`,
  `backup/service.js collectConfigDir`, `central/agentConfig.js setAgentConfig`): 운영 CONFIG_DIR
  (`/etc/vmware-portal`)의 `portal.env` 에는 `AUTH_SECRET`(세션 서명 — 관리자 토큰 위조)·`SECRETS_KEY`
  (봉인 키 — 번들 안 암호문을 전부 연다)·`CENTRAL_TOKEN` 이 있고, 엣지들도 자기 `portal.env` 를
  중앙에 push 한다(`agent/configPush.js` 가 `.env` 를 포함). 즉 **번들 하나 = 전체 탈취**였다.
  · 가리는 것은 키 이름이 `SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|API_KEY|_KEY` 로
    끝나는 값뿐. JSON 안의 장비 비밀번호는 **그대로**(번들의 존재 이유 = 복원. 다운로드는 소유자
    게이트 + '자격증명 포함' 감사 기록). 키·토큰은 설치기가 재생성하는 값이라 뺄 수 있다.
  · **줄을 지우지 않고 표식(`REDACTED`)으로 남긴다** — 복원 시 현재 파일의 같은 키 값을 이어 붙인다.
    현재 파일에 없으면 그 줄을 **버린다**(빈 값으로 덮어써 AUTH_SECRET 을 지우면 전 세션 무효).
  · 가린 개수·키 목록을 번들(`central.redacted`)·응답(`redacted`)·화면(백업 완료 문구)이 말한다.
    조용히 빼면 복원 뒤 '왜 키가 사라졌나' 를 모른다.
  · **수신(중앙)에서도 가린다** — 구버전 엣지는 가리지 않고 보낸다. 한쪽만 하면 업그레이드 순서에
    구멍이 생긴다.
- `app.disable('x-powered-by')`(low) — 프레임워크 지문. 실서버 테스트가 헤더 부재를 고정한다.
- **정보(고치지 않음)**: `secrets-policy` 기본은 `plain`(하위호환 — 자가진단이 warn 으로 표시한다) ·
  CSP 는 `CSP` env 로만 · 세션 토큰은 localStorage(XSS 시 탈취 — CSP 없이는 완화가 없다) ·
  `/api/auth/config` 가 setup 미완료 동안 초기 비밀번호 **파일 경로**를 무인증 응답에 싣는다(값이
  아니라 경로. 로그인 화면 안내용 — 코드 주석이 근거를 적고 있다). WS 토큰은 쿼리스트링(프록시 로그).

## 2026-09-17 SSH 인증 실패가 주기 수집을 멈추지 않던 결함(v2.541) — 되돌리지 말 것

사용자 신고(Unity `OC2-unity-03` · 호스트 10.94.41.237): 장비 상세에
`SSH 수집 실패: All configured authentication methods failed` 가 떠 있는데 **정지 안내가 없었다**.
회귀 테스트 `test/sshAuthStop2541.test.js`(7건 — 양성 12문구·음성 11문구를 함께 고정하고,
ssh2 라이브러리 원문까지 검사한다. 변이 검증 완료: 정규식을 되돌리면 그 항목만 깨진다).

- ⚠⚠ **`isAuthFailureText` 는 ssh2 의 정식 문구를 잡아야 한다**(`util/authGuard.js`):
  ssh2 의 인증 실패는 `All configured authentication methods failed` 하나뿐이고
  (`node_modules/ssh2/lib/client.js:863`) 그 객체에 `err.level = 'client-authentication'` 이 붙는다.
  v2.540 까지의 패턴은 `authentication fail` **연속 일치**만 봐서 사이에 낀 `methods` 때문에
  **매치하지 않았다**. 결과는 두 가지였다 — ① SSH 수집기(Unity·Isilon·PowerStore CLI)는
  자격증명이 틀려도 **주기 수집이 멈추지 않아** 매 주기 같은 계정으로 재로그인했다(v2.528 이
  막으려던 **계정 잠금 경로**. 1시간 주기면 장비당 하루 24회, 수동 실행까지 더해진다)
  ② 화면의 `authStopped`(정지 사실·시도 횟수·자격증명 지문 대조)가 **영원히 뜨지 않아**
  엣지 위임 장비의 '중앙 배포가 상했나 / 실제 비밀번호가 다른가' 를 가릴 단서가 없었다.
  · 패턴은 `authentication <낱말 0~3개> fail` 로 넓혔고 반복에 **상한을 둔다**(무한 반복은 긴
    비매치 입력에서 백트래킹한다 — 테스트가 200KB 입력으로 고정한다).
  · **음성 목록을 지우지 말 것**(규칙 4): `ETIMEDOUT`·`ECONNREFUSED`·`ENOTFOUND`·`socket hang up`·
    `Handshake failed: no matching key exchange algorithm`(협상 실패 — 'failed' 가 있지만 자격증명
    문제가 아니고 구형 알고리즘 폴백이 처리한다)·`Cannot parse privateKey`(설정 오류이고 **로그인
    시도가 서버에 도달하지 않아** 계정을 잠그지 않는다)·파싱/예산 초과.
- **판정은 문구보다 `err.level` 을 먼저 본다**(`proxy/sshExec.js isSshAuthError`): 영문 문구는
  라이브러리 판올림으로 바뀔 수 있지만 `level` 은 ssh2 가 직접 붙이는 값이다. `withSsh` 의
  `conn.on('error')` 가 `reject(e)` 로 **원본 오류를 그대로** 넘기므로 호출부에서 읽을 수 있다 —
  오류를 `new Error(e.message)` 로 갈아끼우면 이 판정이 죽는다.
- **실패 문구 조립은 `cliSsh.sshFailureSnapshot` 하나가 한다**: 자격증명 거부면
  `SSH 인증 실패: <원문> — 계정·비밀번호(또는 개인키)를 확인하세요.` 다. **원문을 지우지 말 것** —
  어느 단계에서 거부됐는지(공개키/비밀번호/키보드 인터랙티브)가 진단이다. `isilonSsh.js` 는
  자체 조립 5줄을 버리고 이 함수에 위임한다(CLAUDE.md '코어는 하나다' — 복제해 두면 분류 수정이
  한쪽에만 들어간다). 테스트가 소스를 검사해 고정한다.
- ✅ **v2.541 에 '아직 가드가 없다' 고 적은 주기 SSH 수집기 5종은 v2.590 에 가드를 받았다**
  (`sanswitch/poller.js`·`perfPoller.js`(같은 기록 공유) · `pdu/poller.js` · `gpu/sshCollect.js`(VM 단위) ·
  `bmstor/collect.js` — 전부 UI 표시와 함께. 회귀는 `test/authStop2590.test.js` 가 **실제 로그인 시도 수**로 고정).
  같은 릴리스에서 **vCenter(SOAP `InvalidLogin`·REST 로그인 401)·iDRAC(Redfish 401)·NSX(신원 확인 401/403)** 도
  받았다 — v2.590 감사 전까지 **목록에조차 없었다**(가장 많이 로그인하는 수집기였다). 규칙:
  · **자격증명 거부만 멈춘다** — vCenter 는 로그인 호출의 거부뿐이고 로그인 뒤 401/403 은 멈추지 않는다.
    `InvalidLogin` 이면 REST 폴백도 하지 않는다(주기당 실패 로그인 2회 → 1회).
  · 정지된 vCenter 는 재시작 직후에도 `pending` 이 아니라 `unreachable + authStopped` 로 보인다(기다리면 된다는 거짓 금지).
  · **저장 비밀번호로 한 연결 테스트가 성공하면 정지를 푼다**(`authStopCleared`). 수동 실행은 막지 않는다.
  · 정지 파일 7종은 `.gitignore` 에 등록했다(`*-auth-stops.json`).
  ✅ **v2.591 — v2.590 이 '아직 연결하지 않은 vCenter 주기 수집기' 로 적은 것들이 가드를 받았다**(회귀는
  `test/authStop2591.test.js` 24건 — 가짜 vCenter·Redfish·SSH·SMTP 로 **실제 로그인 시도 수**를 센다. 변이 24종 중 23종 검출):
  · `curuser`·`vmseries`·`osScanner`·`guestScanScheduler` + **guestdisk·VM 복제 스케줄·성능 조회(`/vms/:id/metrics`)** 가
    `vcAuthGuard.peekAuthStop` 으로 주 폴러의 정지를 **읽기만** 하고, 로그인이 거부되면 **같은 기록**에 올린다(정지가 두 벌이면
    한쪽을 풀어도 다른 쪽이 계속 로그인한다). 성능 조회는 멈춘 vCenter 에 로그인하지 않고 **409 `authStopped`** 를 주고,
    화면(`VmMetrics.jsx`)은 20초 자동 갱신을 멈춘다 — '다시 조회' 는 `manual=1` 로 1회 시도(502 는 재시도 대상이라 쓰지 않는다).
  · ⚠ v2.590 목록의 `metrics` 는 **오탐**이었다 — 샘플러·vmperf 는 스냅샷만 읽고 vCenter 에 로그인하지 않는다(감사 F7, import 확인).
  · ⚠⚠ **게스트 계정 거부는 vCenter 거부가 아니다** — `gpu/guestops.js` 가 `InvalidGuestLogin` 에 `authFailed+guestAuth` 를
    붙이고 `isVcAuthError` 가 `guestAuth` 를 **제외**한다. 이 제외를 지우면 게스트 비밀번호 하나가 멀쩡한 vCenter 수집을 멈춘다.
  · ⚠⚠ **여러 대상을 같은 계정으로 도는 조사는 회로 차단기(`util/authGuard.js createAuthBreaker`)** — 연속 거부 3회에서 끊고,
    첫 성공 전에는 하나씩, **인증과 무관한 실패는 `neutral()`**(ok 로 세면 차단기가 무력해진다 — 구현 중 실제로 그랬다).
    공용 계정이면 계정 단위 정지(`acct|…`)까지 남긴다 — VM 단위만 두면 주기마다 아직 안 멈춘 VM 3대로 3회씩 쌓인다.
    남는 상한(정직 기록): 인증과 무관한 실패로 순차 단계가 끝난 뒤에는 최대 `임계 + 동시수 − 1`(동시 4 → 6회)까지 시도할 수 있다.
  ✅ **v2.733(점검 3회차 C3-01) — 주문형 vCenter 성능 조회 5경로도 같은 기록을 본다 — 헬퍼는 `vcenter/authStopGate.js` 하나**:
  스파크라인(`/tools/waste/spark`)·VM 사용량(`/vms/usage`)·호스트/클러스터 추이(`usage-history?scope=host|cluster`)·라이트사이징·VM 찾기 평균.
  정지면 로그인 0(여러 대상 경로는 그 vCenter 만 null + 응답 `authStopped`, 단건은 409) · 거부는 같은 기록 · 여러 대상은 `createVcAuthGate()` 로
  **vCenter 당 첫 시도 결과를 본 뒤** 나머지를 시작한다(동시에 시작하면 틀린 비밀번호가 대상 수만큼 로그인한다 — 재현 112회 → 0).
  정지 VM 의 유휴 판정은 null(판정 불가). 정지 null 은 응답 캐시에 넣지 않는다. **새 주문형 성능 경로도 이 헬퍼로.**
  ✅ 스파크라인의 VM 마다 로그인은 v2.741 LEFT-03 에 vCenter 당 1회 묶음 조회로 고쳤다(`soapClient.js fetchVmsPerfSeries` — v2.742 LEFT-03 정정).
  · iDRAC **대역 스캔**(`idrac/scanAuth.js`, 정지 파일 `idrac-scan-auth-stops.json` — 주 폴러와 분리)은 주기 스캔만 건너뛰고
    건너뛴 개수를 밝힌다. ⚠ 건너뛴 IP 가 있으면 **replace 를 merge 로 낮춘다**(중앙·엣지 둘 다) — 건너뛴 등록 서버가 지워지지 않게.
  · SMTP 535/534 는 출처에서 인증 실패로 못 박는다(`mail-auth-stops.json`). 정지 중 자동 발송은 건너뛰고 이력에 사유,
    테스트 발송은 허용·성공 시 해제. ⚠ 메일 속도 제한은 **시도**를 센다 — 예전엔 성공만 세어 비밀번호가 틀리면 '릴레이 보호'
    한도가 오히려 풀려 AUTH 가 무제한이었다(F4).
  · 네트워크 연속 모니터는 A/B 쪽별(`netmon-auth-stops.json`), 게스트 조사 작업 계정은 작업 단위(`guestscan-auth-stops.json`).
  · 텔레메트리 **403 은 `forbidden`**(auth 아님 — 주기 정지 대상이 아니다, R-BM2). NSX 는 저장 비밀번호 연결 테스트 성공으로
    풀린다(R-N1 — v2.590 은 화면과 이 문서가 '풀린다' 고 적어 놓고 실제로는 풀리지 않았다). bmusage 수동 수집 성공은 **같은
    자격증명일 때만** 주 iDRAC 정지도 푼다(R-BM1).
  ⚠ GPU 게스트는 VM 단위로 멈추므로 **첫 실패 주기에는 VM 마다 1회씩 실패**한다 — 공용 도메인 계정이면 그 합이
  잠금 임계에 닿을 수 있다(정직 기록 — GPU 폴러는 VM 마다 로컬 계정일 수 있어 계정 단위 정지를 보지 않는다).
  bmstor 와 bmusage 의 OS 계정 정지 기록은 공유하지 않는다.
  ⚠ 정직 기록(v2.591): 실장비 응답(게스트 fault 전달·iDRAC 401 본문·SMTP 530 변형 문구·실제 AD 잠금 임계)은 확인하지 못했다 ·
  vmseries **수동** 경로의 거부 기록은 실행해 보지 않았다 · 엣지 `agent/scanner.js` 의 인증 건너뜀 개수는 중앙 `/result` 로
  가지 않는다(엣지 상태·콘솔에만). 새 정지 파일 4종은 `config-doc.mjs` 가 `createAuthGuard({file})` 형태를 못 읽어
  CONFIG-FILES.md 에 없다(v2.590 의 7종도 같다 — 생성기 결함, 별건). ✅ v2.611 정정: 정지 파일 15종 모두 CONFIG-FILES.md 에 있고 전부 git check-ignore 대상이다(LEFT2611-10).

## 2026-09-24 암호화 모드 재봉인 비용 조치(v2.598 L2598-01) — 되돌리지 말 것

- **저장마다 모든 비밀을 값마다 scrypt 로 재봉인하지 않는다**(`security/secretVault.js`): 40대 등록부 1대 수정 저장이 4.1초 동안
  이벤트 루프를 멈췄다(scrypt 값당 ~100ms). 이제 ① 새 봉인은 (alg, logN) 조합마다 **프로세스당 한 번** 키를 만들고 값마다 IV 만 새로
  뽑는다(2^20회마다 키 교체) ② `openSecretsDeep`·`sealSecretsDeep` 이 'HMAC(문맥 + 평문) → 암호문' 을 LRU(20,000)로 기억해 다음 저장에서
  **문맥·평문·정책이 같으면 그 암호문을 그대로** 쓴다. 문맥 = 필드 이름 + 그 객체의 식별 필드(id·name·host 등). 평문은 저장하지 않는다
  ③ kdfCache 는 통째로 비우지 않고 LRU.
- ⚠ **보안 의미 변경(정직 기록)**: 값마다 salt 에서 프로세스당 salt 로 바뀌었다 — 모든 키가 같은 마스터 키에서 나오므로 대입 비용은 줄지 않는다.
  **같은 비밀이 바뀌지 않으면 암호문도 그대로**라 두 백업을 비교하면 '어느 비밀이 바뀌지 않았는가' 가 보인다(평문은 아니다). 식별 필드까지
  같은 두 객체가 같은 비밀을 쓰면 암호문이 같아진다. 다른 장비의 같은 비밀번호는 다르다(테스트 고정). 봉인 형식·기존 파일 복호는 그대로다.
- 백업 지문(`backup/service.js fingerprintContent`)은 봉인 값을 열지 않고 **원문을 그대로** 비교한다 — v2.597 의 '캐시에 있을 때만 연다' 표식이
  캐시 상태로 뒤집혀 무변경 change 백업을 만들었다. 재사용 기억에서 밀려난 값은 새로 봉인되어 백업이 한 번 더 생긴다(안전한 쪽).

## 2026-09-24 v2.599 조치 — 되돌리지 말 것

- **암호문 재사용 문맥에는 경로가 들어간다**(`security/secretVault.js`, RECENT2599-02): v2.598 은 부모 객체의 식별 필드만 봐서 맵 키로만 구분되는
  항목이 같은 문맥이 됐다. 객체는 키, 배열은 강한 식별자(id·name·host·agent·agentName·url — username 제외)가 없으면 위치를 쓴다. 한 번의 봉인
  안에서 같은 암호문을 두 번 내지 않는다. 남은 한계: 서로 다른 파일에서 경로·식별자·필드·평문이 모두 같으면 같은 암호문일 수 있다.
- **인벤토리 소유권 해제는 관리자 API 로만(기본)**(`central/inventory.js setInventoryOwner`, `POST /api/admin/central/inventory/owner`):
  자동 인계 env 기본 0. 켜면 소유 엣지가 오래 조용할 때 다른 개별 토큰 엣지가 넘겨받는다 — 현장 opt-in 이고 인계는 감사·콘솔·응답에 남는다.
- **엣지 수신 원소는 객체만**(`routes/central.js /inventory` + `store.js` 병합부 + `central/edgeRecord.js`): 비객체·예약어 id·범위 밖 vcenterId 는
  버리고 개수를 밝힌다. 중앙 엣지 저장소는 장비·엣지·엣지 수 상한을 둔다(`CENTRAL_EDGE_*`).
- **범위 계정의 OS 스캔 실행은 vCenter 지정 필수**(400) — 비우면 전 vCenter 게스트에 로그인한다. 범위 밖 지정은 404(존재 은닉).

## 2026-09-26 v2.621 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-26c.md)

- **범위 관리자는 범위 밖 중계 프록시를 점검·배포하지 못한다**(`routes/remote.js proxyHiddenFor`, SEC-01): `POST/DELETE /proxies` 의
  `proxyScopeOf` 판정을 형제 라우트(`/proxies/:id/health`·`/test`·`/deploy/test`·`/deploy`)에도 쓴다 — 단건은 404(존재 은닉), 전체 배포는 숨긴
  프록시를 건너뛰고 `omittedOutOfScope` 로 밝힌다. 공유·기본 프록시와 전체 범위 관리자는 예전 그대로.
- **요청 본문 IP 로 직접 접속하는 테스트는 전체 범위 전용 + 정규형 IPv4 + 차단 대역**(`routes/admin/gpuGuest.js` `rawIpFleetOnly`, SEC-02):
  비정규 표기(`000.0.0.0`·`010.0.0.5`)는 inet_aton 이 다르게 읽는다(v2.589 규약). 수집기 `gpu/sshCollect.js usableIp` 도 같은 판정이고
  **루프백은 `SSRF_ALLOW_LOOPBACK` 과 무관하게** 뺀다(게스트 VM 의 IP 로 루프백은 뜻이 없다).
- **폴더 사용량 조회 4종도 전체 범위 전용**(`routes/admin/dirUsage.js fleetReadOnly`, SEC-03) — 응답이 RMA 엣지 IP·호스트명·fileRoots·마운트 경로를 싣는다
  (형제 `/tools/rma`·`/admin/collectors` 는 이미 403 이었다).
- **엣지 push 3종(스토리지·SAN·PDU)은 등록부 손상을 '위임 0대' 로 읽지 않는다**(`registryLoadError()` 선판정, EDGE-03) · 중앙 part-faults 수신은
  그 장비군의 등록부가 손상이면 503 `registryUnreadable`(EDGE-04 — v2.620 EDGE2620-01 의 형제 누락).

## 2026-09-27 v2.622 감사 조치 — 되돌리지 말 것 (docs/AUDIT-2026-09-27.md)

- **Redfish 세션 폴백 실패는 자격증명 거부가 아니다**(`idrac/redfish.js`, LEFT-01): 세션 POST 시한·5xx·429, 세션 생성 뒤 토큰 GET 예외는
  `sessionTransient`(authFailed 없음)로 던진다. 명시적 401/403 과 세션 미지원 4xx 만 예전처럼 Basic 401 이다. 합치면 authGuard 가 멀쩡한 서버를 멈춘다.
- **범위 관리자 차단 3파일 추가**(`routes/admin/opsSettings.js`·`gpuGuest.js`·`nsxImport.js`, SEC-01·03·04): 전역 알림 채널·일일 보고는 전 법인 공통 설정이라
  저장·발송이 전체 범위 전용이다. GPU 게스트 배포·진단·엣지 사용자·물리 GPU 조회와 NSX 매니저 목록도 전체 범위 전용이다(형제 라우트가 이미 403 이었다).

## 2026-09-29 super_admin · CSV 권한(v2.643) — 되돌리지 말 것

- `super_admin` 은 users.json 에만 저장되는 역할이다. 요청 문맥(`resolveTokenUser`·`authenticateLocal`)은 `role:'admin'` + `superAdmin:true` 로
  접는다(`auth/roles.js authzRole`) — 기존 admin 게이트를 전부 그대로 통과시키기 위해서다. 접기를 없애면 super_admin 이 모든 admin 라우트에서 403 이 된다.
- super_admin 계정을 만들고·지우고·역할/비밀번호/OTP 를 바꾸거나 super_admin 역할을 주는 것은 **요청자의 저장 역할이 super_admin** 일 때만이다
  (`superAdminGuardDenied`). 비밀번호·OTP 함수는 `credentialGuardDenied`('본인만')를 먼저 본다(사유 문구 순서 — 테스트 고정).
  중앙 관리 계정 동기화(`applyManagedUsers`)는 super_admin 을 만들지도 바꾸지도 않는다 · AD 토큰의 역할 클레임도 접는다.
- `data.csv` 는 admin 전용 토글 키다: operator·viewer 행에 넣을 수 없고(`sanitizeRow`), admin 에게서 끄는 `adminDenied` 변경과
  비어 있지 않은 adminDenied 의 초기화는 super_admin 만(403 `super-admin-only`). 사용자별 도구 재정의는 super_admin 계정도 대상 밖이다.
- CSV 라우트 게이트는 `requirePerm('data.csv')` 이고 `requirePerm` 은 `userHasPermission` 하나로 판정한다(superAdmin → 전부, admin → adminDenied 외 전부).
- ⚠ **저장 레코드(`getUser`·`listUsers`)의 역할을 `'admin'` 문자열과 비교하지 말 것 — `isAdminTier`**(v2.674 에 찾은 누락 3곳): 긴급중단 승인자
  판정이 super_admin 인 noainred 를 '관리자가 아닙니다' 로 거부했고(`security/emergencyStop.js approverRoleIssue` + 범위 판정은 `authzRole`),
  보안 자가진단 OTP 범위와 OTP 콘솔 도구 `--list` 가 super_admin 을 고권한 계정에서 뺐다. 회귀 `test/emergencyStop.test.js`(라우트 소스도 검사).

## 2026-10-07 mock 모드 내장 데모 계정(v2.716) — 되돌리지 말 것

- 데모 계정(`u.demo`)은 mock 모드에서만 요청 문맥이 `admin` + `demoGuest:true` 다(`auth/auth.js demoGuestOf`). 그 대신 `authMiddleware` 가 라우트 게이트보다 먼저
  `auth/demoGuest.js denyDemoGuest` 로 거른다 — 이 호출을 지우면 데모 계정이 **관리자 권한 전부**를 얻는다(설정 저장·연결 테스트·배포·원격 명령).
- `SAFE_ACTIONS` 는 데모 데이터만 바꾸는 수집·점검이다. 실제 장비·네트워크에 닿는 실행을 넣지 말 것. `READ_DENY` 는 설정·계정·비밀 조회를 막는다 — 새 설정 API 접두는 여기에도.
- WS SSH/RDP 게이트웨이(`proxy/sshGateway.js`·`guacdTunnel.js`)는 `user.demoGuest` 를 거부한다(미들웨어를 타지 않는다).
- live/auto 에서는 데모 계정이 예전처럼 viewer 다(`demoGuestOf` 가 `getDataSource()==='mock'` 을 본다) — 판정을 저장 레코드만으로 바꾸지 말 것.

## 2026-10-09 검토 보고서 — 세션·AD(S-03·S-05·S-06·S-08) — 되돌리지 말 것

- **세션 판정은 `resolveTokenUser` 한 곳**이다 — 순서 not-before → 폐기 → 총 상한(`lt` 기준) → 유휴(`auth/sessionPolicy.js`·`sessionState.js`, 파일 `session-state.json`).
  활동으로 세는 것은 로그인·연장·`POST /auth/activity`(화면 입력 신호, 분당 1회 이하)뿐이고 **폴링은 활동이 아니다**(폴링을 세면 유휴 판정이 영원히 오지 않는다).
- **로그아웃·폐기는 서버가 기억한다**(`POST /auth/logout` — 화면은 토큰을 지우기 **전에** 서버에 알린다). 폐기는 즉시 파일에 쓰고 재시작해도 유지되며 노드별이다.
  폐기 이벤트는 `auth/sessionRevocation.js`(잎 모듈)로 알린다 — WS 게이트웨이가 구독해 열린 콘솔을 끊는다(S-04, 아래 절).
- **AD 토큰은 `src`·`ep`·`sid` 를 싣고 `AD_SESSION_MAX_HOURS`(기본 12) 상한**이다 — AD 쪽 계정 잠금·비활성이 포탈에 반영되는 최대 지연이 이 값이다. 카운터를 되돌려도 폐기된 토큰은 부활하지 않는다.
  ⚠ 로컬 계정과 같은 이름의 AD 로그인 거부(v2.681 R2B-01)는 그대로다.
- **평문 AD 의 새 저장은 거부한다**(`ldap://` simple bind — 비밀번호가 평문으로 흐른다). 기존 설정은 경고만(자가진단 `ad-transport`). StartTLS(`AD_STARTTLS`)는 **업그레이드 성공을
  확인한 뒤에만** bind 하고, 인증서 검증 표지는 명시적 `false` 만 끈다(`tlsRejectUnauthorized: null` = 검증).
- 업그레이드 직후 옛 탭은 한 번 로그아웃될 수 있다(새 토큰 형식) — 릴리스 노트가 말한다. 회귀 `test/rvF_*.test.js`.


## 2026-10-09 검토 보고서 — SSH 호스트키·원격 콘솔 세션·출력 백프레셔(S-01·S-04·I-07) — 되돌리지 말 것

- **SSH 는 인증 전에 호스트키를 확인한다**(`proxy/sshExec.js makeSshHostVerifier` + `security/peerTrust.js checkPeer`, S-01 — 사용자 승인 기본값 전환):
  ssh2 는 `hostVerifier` 가 없으면 어떤 키든 받는다(수정 전 재현: 다른 키의 가짜 서버에 **비밀번호가 도착**했다). 공통 connect·웹 SSH 게이트웨이가 같은
  verifier 를 쓰고, 거부면 ssh2 가 키 교환 안에서 끊어 비밀번호를 보내지 않는다. **새 SSH 접속은 반드시 `withSsh`/sshExec connect 경유** — ssh2 를
  직접 여는 코드를 만들면 이 확인이 빠진다(`grep -rln "from 'ssh2'" server/src` 로 확인: 접속은 sshExec·sshGateway·linkcheck 셋뿐).
  · 정책: **새 설치 enforce · 기존 현장 observe**(처음 보는 키는 기록 후 통과, **바뀐 키는 거부**). 기존 현장 판정은 `EXISTING_MARKERS`(장비 등록부 19종 —
    SSH 를 쓰는 등록부를 새로 만들면 여기에 넣을 것. 빠지면 그것만 쓰던 현장이 업그레이드 직후 SSH 가 전부 끊긴다). env `SSH_HOSTKEY_POLICY` 가 강제.
    손상 파일은 보존 후 두 종류 모두 enforce(닫는 쪽).
  · 거부 오류 `sshHostKeyError`(code `SSH_HOSTKEY_UNTRUSTED`, 문구 끝 `[SSH_HOSTKEY_UNTRUSTED]`, `level:'host-key'`). TLS 거부(`ERR_TLS_PEER_UNTRUSTED`)와 함께
    **인증 실패가 아니다** — `util/authGuard.js isAuthFailureText` 와 `util/errors.js describeError` 가 표지(`PEER_REJECT_MARKERS`)를 **먼저** 본다. 지문 base64 속
    '+401/' 같은 조각이 주기 수집을 '인증 정지' 시키지 않게(재현 픽스처: 주소 'array-403'). 표지 문자열을 바꾸면 그 상수도 같이 바꿀 것(테스트가 대조).
  · 통신 점검(`linkcheck/protocols.js`)은 **관찰만**(`peekPeer` — 상태를 바꾸지 않는다). checkPeer 를 부르면 5분 점검이 observe TOFU 를 대신 해 버린다.
    설정 전수 점검은 등록 호스트 이름을 넘긴다(`stepSsh(…, { host })` — IP 로만 찾으면 이름으로 승인한 키가 '미등록' 이 된다).
  · 관리 API `/api/admin/security/peer-trust*` 6개는 adminOnly + fleetOnly(정책 변경은 + requireSettingsOwner), 승인은 본문 `confirmVerified:true` 필수 · 전부 감사 로그.
    화면 설정 › 보안 › 장비 신뢰(`PeerTrustSettings.jsx`, 키 `peer-trust`) — 폴링 없음.
  · ⚠⚠ v2.731(점검 1회차 A1-01): 한 항목은 신뢰 지문 **목록**이다(상한 8 — 넘으면 400 `trusted-full`). 승인은 **추가**가 기본이고 교체는 `replace:true` 일 때만,
    거부로 지문 하나만 회수한다. 이중화 SP·VIP 뒤 장비는 연결마다 다른 인증서·호스트키를 보여 하나만 기억하면 observe 에서도 번갈아 거부됐다. 저장은 첫 지문을
    예전 자리 `trusted`(객체), 나머지를 `trustedMore` 에 둔다 — **`trusted` 를 배열로 바꾸지 말 것**(이전 버전으로 되돌려 설치하면 전 장비가 거부된다).
    거부 문구는 승인할 노드를 말한다(`peerApproveWhere` — 엣지 이름은 401·403·인증·auth 같은 판정 낱말이 없을 때만 싣는다. 표지 문자열은 그대로).
    처음 보는 장비 기록(관찰·새 대기)은 2초 묶음 저장 + exitFlush, 바뀐 지문·관리자 동작은 즉시 저장.
- **열린 원격 콘솔도 세션 폐기를 따른다**(`proxy/sshGateway.js` 원격 세션 레지스트리 — SSH·RDP 공용, S-04): 업그레이드 때 한 번만 보던 토큰을
  ① 폐기 이벤트(`onSessionRevoked` — 로그아웃·삭제·강등·비번 변경·sid 교체) ② 토큰 exp 시각 타이머 ③ `REMOTE_REVALIDATE_MS`(기본 30초) 재검증으로 다시 본다.
  재검증은 **업그레이드 게이트와 같은 함수** `remoteUserIssue(resolveTokenUser(token))` + 계정 동일성 + 매핑 소유·범위다(판정을 둘로 두지 말 것).
  닫힘 코드 4401(무효)·4403(권한·범위·호스트키)·4404(매핑 없음)·4429(동시 세션 초과) — 웹 `remote/sshSend.js sshCloseReasonText` 와 1:1(웹 테스트가 서버 소스에서 코드를 뽑아 대조).
  · ⚠ v2.731(A5-02): 4403 은 여러 원인이 함께 쓰는 코드다 — **닫힘 사유(reason)가 원인 코드**(`host-key-<판정 사유>`·`mapping-gone`·`mapping-changed`·
    `mapping-denied`·remoteUserIssue 코드)이고 웹 `remoteCloseReasonText` 와 1:1(웹 테스트가 서버 소스에서 뽑아 대조). 새 닫힘 사유를 만들면 그 표에도.
  · 세션 연장: SSH `{type:'token', token}` → `{type:'token-ack', ok, code}` · RDP `dvc-token` Guacamole 명령(guacd 로 넘기지 않는다) — **같은 계정·같은 sid·지금 권한**일
    때만 교체. 웹은 `remote/tokenRenew.js`(SessionExpiryGuard 가 `/auth/extend` 성공 뒤 알린다) — 이 배선을 지우면 연장해도 옛 만료 시각에 콘솔이 닫힌다.
  · 콘솔 입력(SSH data · RDP key/mouse/touch)은 활동이다 — 연결마다 1분 1회 `touchSessionActivity`. RDP 를 닫을 때는 **guacd 소켓을 먼저 destroy**.
  · 한계(정직): 폐기 이벤트는 프로세스 단위다. 이벤트 없는 변경(콘솔 도구로 users.json 수정)은 재검증 주기만큼 늦게 닫힌다.
- **웹 SSH 출력은 백프레셔를 건다**(I-07): `ws.bufferedAmount ≥ high(1MB)` 면 SSH 스트림을 pause(ssh2 창 흐름 제어로 대상 쓰기가 막힌다), `≤ low(256KB)` 면 resume.
  멈춘 채 60초면 4008, 대기열이 8MB 를 넘으면(pause 를 듣지 않는 스트림) 4009. 계정당 동시 세션 `REMOTE_MAX_SESSIONS_PER_USER`(기본 20, 0=끔). UTF-8 은 `StringDecoder`
  로 잇는다. 최악 메모리 ≈ 세션당 3MB × 전체 상한 80. 회귀 `test/rvH_*.test.js`(변이 44/46 — 남은 2종은 동등 변이).

## 2026-10-15 v2.741 점검 — 수집기 라우터 순서·인증 실패 판정·SSH 세션 예산 — 되돌리지 말 것 (docs/AUDIT-2026-10-15b.md)

- **수집기 라우터(`/api/collector`)는 전역 `express.json` 보다 먼저 마운트한다**(index.js 주석, EDGE-02): 전역 파서가 먼저 돌면 라우트별 한도
  (`set-password`·`isidu-run` 4KB · `isidu-test` 16KB)가 적용되지 않고 1MB 로 본문을 다 읽은 뒤에야 토큰을 본다. 본문 파서를 쓰는 라우트는
  `tokenFirst(name)`(토큰·비활성 판정 — 토큰 없으면 403, 수집 토큰 미설정 404)를 **파서 앞에** 둔다. ⚠ 새 JSON POST 를 더하면 `tokenFirst` 와 라우트 파서를 함께 붙일 것
  (전역 파서에 기대는 경로가 이 라우터에는 없다 — `/xfer-test` 는 스트림, `/upgrade` 는 raw). 게이트 이름은 `scripts/api-doc.mjs GUARD_NOTE` 에 등록돼 있다.
- **인증 실패 판정에서 숫자 401/403 은 HTTP 문맥일 때만**(`util/authGuard.js isAuthFailureText`, DEV-01): `HTTP 401`·`HTTP/1.1 401`·`401 Unauthorized`·`403 Forbidden`·
  `status: 401`·`-> 401` 꼴만. 호스트명(`array-403`)·경로·포트 속 숫자가 주기 수집을 인증 정지시키던 것. 낱말 규칙(인증 실패·authentication … fail·permission denied)은 그대로다.
  ⚠ 저장소의 생산자 문구는 전부 'HTTP 401'·'-> 401'·'인증 실패(401)' 꼴이라 계속 정지 대상이다(테스트가 고정). **새 수집기의 401 문구도 이 꼴로 만들 것.**
  ✅ REST 수집기 여러 곳의 `/401/.test(e.message)` 재던짐은 v2.742 DEV-03 에 `restCommon.isCredReject` 로 고쳤다(아래 v2.742 절 — v2.743 LEFT-05 정정).
- **SSH 세션 예산은 SAN·Isilon 수집기에도 있다**(DEV-02 — v2.528 Unity 규약의 형제): SAN `fosSsh` 기본 100초(`SANSW_CLI_SESSION_BUDGET_MS`, 장비 시한 − 15초로 묶음) ·
  Isilon SSH 150초. 필수 항목은 예산을 무시하고, 그 밖은 남은 시간이 조각(5초) 미만이면 시작하지 않고 사유를 남긴다(`extra.cliSkipped`·`cliSkippedKeys`/`cliSkippedCmds`).
  **예산 < 장비 시한** 산수를 `audit2741f` 가 고정한다. 바깥 시한이 짧은 호출부(SAN 연결 테스트 60초)는 `budgetMs` 를 넘긴다(`timeoutMs − 10초`).

## 2026-10-16 v2.742 점검 — 자격증명 거부 판정·지속형 503·주문형 로그인 — 되돌리지 말 것 (docs/AUDIT-2026-10-16.md)

- **스토리지 REST 의 자격증명 거부는 `storage/collectors/restCommon.js isCredReject` 로만 판정한다**(DEV-03): 401 오류는 `credRejectError`(authFailed·status 401 표지)로 만든다.
  `/401/.test(e.message)` 꼴은 호스트명·SID·응답 본문 속 '401' 로 수집 전체를 끊었다(24곳). 표지 없는 옛 오류는 '인증 실패(401)' **접두**만 받는다. 403 은 즉시 중단 대상이 아니다
  (역할 권한 없는 엔드포인트 하나가 수집 전체를 멈추지 않게). 새 REST 수집기의 401 도 credRejectError 로 만들 것 — 소스 스윕(`audit2742k` ⑩)이 7개 파일의 부분 일치 0 을 고정한다.
- **중앙의 지속형 503(등록부·설정 손상, DB 불가)은 `Retry-After: 60` + `Cache-Control: no-store`**(`routes/central.js PERSISTENT_503_HEADERS`, EDGE-03): 다시 물어도 같은 결과라
  엣지가 400·800ms 간격으로 같은 큰 본문을 세 번 보내지 않게 한다. central.js 의 `status(503)` 전부가 그 머리를 거치는지 스윕한다 — 새 503 은 `persistent503()` 로.
  큰 본문 push(isidu·edge-log-result · v2.743 LEFT-03 에 cvp-data·sanswitch-perf 표본·하트비트도)는 `postNo503Retry` 로 503 을 호출 안에서 다시 보내지 않는다
  (다음 주기·claim→ack 가 잇는다 — 커서를 전진하지 않으므로 유실은 없고, 혼잡 503 이면 한 주기 늦어진다).
- **주문형 vCenter 로그인은 `vcenter/dsBrowse.js onDemandVcBlock`·`onDemandLogin` 을 지난다**(VC-03): 비활성·점검중·site·인증 정지면 로그인 0 + 409. 거부는 `noteVcAuthFailure`
  로 주 폴러와 같은 기록에 올린다(v2.732 B4-01 · v2.733 C3-01 규약의 형제 4경로).

## 2026-10-16 v2.743 점검 — 관리자 판본 단일 판정·엣지 등록부 손상 503 — 되돌리지 말 것 (docs/AUDIT-2026-10-16b.md)

(v2.744 LEFT-07 — 루트 CLAUDE.md 에만 있던 v2.743 서버 보안 규칙을 이 파일로 옮겼다. 서버 파일을 고칠 때 이 파일이 읽힌다.)

- **'관리자 판본'(관리 IP·계정명·CONFIG_DIR 절대 경로·오류 원문·등록부 CSV) 판정은 `auth/demoGuest.js isAdminDetailUser` 하나**(AUTHZ-01): mock 데모 계정은 요청 문맥 역할이
  admin 이라 `req.user?.role === 'admin'` 으로 가림을 정하면 데모 계정이 관리자 판본을 받는다. `addressMask.isAdminReq`·`scopeStatus.scopeDbStatus`·`scopeFilePaths`·
  `redactPushStatus`·archScan `scopeArchPaths` 가 이 함수를 쓴다. **라우트에서 역할 문자열로 가림을 정하지 말 것** — v2.744 AUTHZ-01 이 남은 경로를 고치고 소스 스윕
  (`audit2744e`)으로 직접 비교를 허용 목록과 대조한다. memoJson 의 extraKey 에 역할을 넣는 곳은 판정 결과(데모 포함)로 만든다(데모와 관리자가 같은 캐시 칸을 쓰지 않게).
- **데모 계정은 `data.csv` 가 없다**(`auth/permissions.js userHasPermission`) · 실제 접속 GET 과 관리 조회는 `demoGuest.js READ_DENY`·`LIVE_GET_DENY` 로 막는다 —
  새 관리 화면 접두를 만들면 READ_DENY 에도 넣을 것(v2.716 규약).
- **엣지가 등록부를 읽어 '전량' 을 보내는 응답은 `registryLoadError()` 를 먼저 본다**(EDGE-01): 엣지 iDRAC 등록부(idrac.json)가 손상이면 `/api/collector/export` 가
  503 `registryUnreadable` + Retry-After 60 + no-store 이고 중앙 puller 는 직전 스냅샷을 유지한다(`edgeReason` · 통신 지도 `pull-edge-registry`). 빈 목록을 보내면 중앙이
  그 법인의 위임 서버·전력을 통째로 지운다. v2.744 EDGE-01 이 같은 규칙을 fleet push(상태 전용 보고 — 중앙 2.744.0 이상일 때만)·파트 장애 push(`registryUnreadable` →
  보류 사유 `registry-unreadable`)로 넓혔다. EDGE-03 은 **자동 등록**(위임 스캔·주기 스캔의 `registerScanned(…, {auto:true})`)만 손상 등록부 위에 쓰지 않게 했고
  (`util/registryCore.js autoWriteRefusal` 한 벌 — 새 자동 저장 경로는 auto:true 를 넘길 것), 스토리지·SAN·PDU·CVP **설정 pull 적용은 예전처럼 다시 쓰되**
  `registryRecovered` 로 기록한다(그 엣지의 수집 대상은 전부 중앙 배포분이라 다시 쓰는 것이 복구다 — 배포분이 아닌 로컬 항목은 손상 보존본에만 남는다).

