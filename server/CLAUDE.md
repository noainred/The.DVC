# 서버(`server/`) 보안 불변조건

> 루트 CLAUDE.md 에서 이관(2026-08-12) — `server/` 아래 파일을 작업할 때 자동 로드된다.

2026-06-27 전수 감사와 2회 후속 하드닝(v2.190.0·v2.191.0)으로 확립된 규칙. 되돌리면 감사 지적이 재발한다.

## v2.322 전수 감사(2026-08-17) 조치 — 되돌리지 말 것

전 도메인 7차원 적대적 감사(`docs/AUDIT-2026-08-17.md`) 확정 11건 조치. 회귀 방지 테스트:
`test/securityAudit2026-08-17.test.js`.

- **조회 라우트 scope 는 예외 없이** — 새 tools/백업/점검 라우트도 `scopedVcenterIds` 교집합을 반드시:
  `/tools/vmware-config`(`buildVmwareConfigExport({allowed})` — 사이트·귀속 NSX 매니저 교집합, 범위 밖
  vcenterId 404)·`/tools/network-check`(`getNetworkCheck(allowed)`)·`/tools/ip-ping`(POST·GET 모두
  `inUserScope` 404, GET 도 `requirePerm('tools')`)·`/idrac/host-power`(범위 계정은 요청 `serviceTag`
  무시하고 스냅샷 host.serviceTag 로만 폴백 — 클라이언트 태그로 scope 우회 금지). "이 라우트만 백업/
  점검이라 예외"는 없다.
- **`/api/auth` 하위 admin 라우트에도 `requireEnrolled`**: authRouter 는 로그인/공개용이라 index.js 에서
  `requireEnrolled` 없이 mount 된다. 그 안의 admin 라우트(ad-config·ad-test)는 `adminOnly=[authMiddleware,
  requireEnrolled, requireRole('admin')]` 로 게이트해야 한다 — 빠지면 부트스트랩(OTP 미등록) admin 세션이
  AD 를 자기 LDAP 로 바꿔 OTP 강제등록을 우회하는 admin 경로를 만든다.
- **WS 게이트웨이 매핑 접근 재검사**: SSH/RDP 게이트웨이(proxy/sshGateway·guacdTunnel)는 upgrade 에서
  얻은 user 를 handleConnection 에 넘기고 `mappingAccessIssue(user, m)` 로 **소유(소유자 없으면 admin
  전용) + targetHost scope** 를 재검사한다(HTTP 미들웨어를 안 타므로). mappingId 추측으로 타인/범위 밖
  매핑에 붙는 것을 막는다.
- **미일치 WebSocket upgrade 소켓 파기**: index.js 는 게이트웨이 attach 뒤 catch-all `upgrade` 리스너로
  자기 경로가 아닌 소켓을 `socket.destroy()` 한다 — 'upgrade' 리스너가 있으면 Node 가 미처리 소켓을
  자동으로 닫지 않아 무인증 FD 누수 DoS 가 된다. 이 catch-all 을 지우지 말 것.
- **자격증명 파일은 원자적 쓰기 + 로드 손상 preserveCorrupt(전 파일)**: 크라운주얼 4종뿐 아니라 비밀을
  담는 모든 스토어 — idrac/registry·idrac/scanRanges·gpu/settings(gpu-guest)·gpu/physicalRegistry·
  horizon·proxy/registry·agent/deployRegistry — 는 `atomicWriteFileSync` 로 쓰고 로드 catch 에서
  `preserveCorrupt(FILE)` 후 빈 값을 반환한다. `fs.writeFileSync` 직접 쓰기나 catch 의 조용한 빈값 반환
  금지(다음 저장이 온전한 원본을 소거).
- **secretVault 정책 fail-safe(보안 다운그레이드 금지)**: `secrets-policy.json` 손상 시 plain 으로 조용히
  폴백하지 않는다 — 직전 유효 정책(`_lastGoodPolicy`)을 유지하고 암호화였다면 보안 경고를 출력한다.
  손상→plain 폴백은 이후 자격증명 저장을 무음 평문화한다.
  ⚠⚠ **S-07(2026-10-09 검토 — 재현)**: 위 규칙은 **첫 load 한 번만** 지켜졌다 — preserveCorrupt 가 원본을 옆으로 치워 둘째 load 는
  '파일 없음' 으로 plain, 재시작이면 처음부터 plain, `{}`·모르는 mode 도 plain, mode 없는 저장(레벨만 변경)도 plain 이었다. 이제
  ① 정책은 **mode 가 있고 알려진 값일 때만** 유효(아니면 손상과 같이 보존) ② 못 읽으면 직전 정책 → 신뢰 사본(`secrets-policy.trusted.json`,
  저장·정상 load 때 맞춘다) ③ 둘 다 없고 '파일 없음' 이며 암호화 흔적(키 파일·봉인 값·`secrets-policy.json.corrupt.*`)도 없을 때만 신규 설치 plain
  ④ 그 밖은 **잠금** — `sealSecret`/`sealSecretsDeep` 이 새 비밀을 `SECRETS_POLICY_UNAVAILABLE` 로 던지고 기존 암호문은 재사용 기억으로 그대로 쓴다
  ⑤ 저장은 undefined 키를 '유지' 로 보고 모르는 mode 를 거부, `migrateSecretFiles` 도 정책이 아닌 값을 거부. 정책 파일을 자동으로 다시 쓰지 않고
  키를 만들지 않는다(암호화를 켜는 저장만 키를 미리 준비 — 없을 때만). 회귀 `test/secretsPolicyS07.test.js`(실제 NSX 등록부 저장 + 실제 PUT 라우트 · 변이 16/16).
- **SSRF 재검증에 타임아웃 없는 DNS 조회를 핫패스에 넣지 말 것**: `ssrfBlockReasonResolved` 는 타임아웃이
  없어 폴러 루프에서 매 점검마다 부르면 DNS 지연이 이벤트 루프를 막는다(svcmon 비-HTTP 재검증 보류 사유).
  실행시점 재검증이 필요하면 `dns.lookup`(타임아웃)+`ipBlockReason` 후 그 IP 로 직접 접속(uagmon 핀 패턴).

- **전역 TLS 디스패처 금지**: `setGlobalDispatcher`로 프로세스 전체 fetch의 인증서 검증을 끄지 않는다(과거 vCenter용 설정이 업그레이드 번들·NSX까지 오염). 자체서명이 필요한 곳만 로컬 디스패처를 `dispatcher:` 옵션으로 주입한다(`vcenter/restClient.js vcDispatcher`, `nsx/client.js`, `util/resilientFetch.js wanAgent`).
- **WAN(중앙↔엣지) TLS 기본 검증 ON**: `WAN_TLS_INSECURE`는 `=== 'true'`일 때만 검증 해제. 의미를 반전시키지 말 것(과거 '미설정=검증 off'였고 그 구간으로 토큰·자격증명이 흐른다).
- **중앙↔엣지 URL 은 HTTPS 기본, 평문 HTTP 는 승인된 예외만**(2026-10-09 S-09, 사용자 승인 기본값 전환): 판정은 `collector/transportPolicy.js evaluateCollectorUrl` 하나 —
  등록부 normalize 가 모든 경로(화면·CSV·자기등록·배포 자동등록·배포 대상 동기화)를 덮는다. 원격 http 는 ⓐ 저장값과 같은 URL(업그레이드 전 항목 — 경고) ⓑ 관리자 예외
  (`allowInsecureHttp` + 사유, 감사) ⓒ `COLLECTOR_HTTP_ALLOW` 일 때만이고 그 밖은 400 `insecure-http`. 자기등록은 예외를 만들 수 없고 저장된 https 를 http 로 하향할 수 없다.
  URL 이 바뀌면 예외를 승계하지 않는다. 스킴 없는 주소는 https. 포탈 직접 TLS 는 `util/httpsServer.js`(TLS_CERT_FILE·TLS_KEY_FILE, 설정이 틀리면 fail-closed —
  평문으로 내려가지 않는다), 사설 CA 는 `WAN_TLS_CA_FILE`(기본 신뢰 저장소에 덧붙인다 — 대체하지 않는다). `resilientFetch` 는 https→http 리다이렉트를 따라가지 않는다.
  광고 URL 은 TLS 리스닝일 때만 https(`advertisedListen` — 지어내지 않는다). 회귀 `test/rvJ_s09Transport.test.js`.
  ⚠ v2.731(점검 1회차 A4-01): 중앙↔엣지 클라이언트가 자체 undici Agent 를 만들면(통신 점검 stepHttp·엣지 업그레이드 push·업그레이드 원격 받기)
  `resilientFetch.wanTlsConnectOptions()` 를 **통째로** 펼친다 — 검증 여부만 가져오면 사설 CA(`WAN_TLS_CA_FILE`) 엣지를 거짓 'tls-fail' 로 기록한다.
  사설 CA 는 미리 만든 SecureContext 로 싣는다(ca 배열은 연결마다 약 23~28ms 동기 파싱). 사본을 만들지 말 것. 회귀 `test/audit2731g2b.test.js`.
- **상태변경 라우트 RBAC**: `/api` 의 POST/PUT/PATCH/DELETE에는 `requireRole('admin','operator')`를 붙인다(읽기성 POST 제외). WS SSH/RDP 게이트웨이도 역할을 검사한다.
  - ✅ **수정됨(v2.313)**: `DELETE /remote/mappings/:id`(`routes/remote.js:208`)에 `requirePerm('remote.access')`
    추가 + 소유자 없는 매핑은 admin 전용으로 보정(과거 `m.owner && …` 단락으로 소유자 없는 레거시 매핑을
    임의 인증 사용자가 삭제 가능했음).
  - ✅ **수정됨(v2.320)**: `/remote/{probe,quick-connect}` 의 `targetHost` 에 scope 적용 —
    범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM IP/이름·호스트 이름)만 프로브/터널
    생성 가능(`remote.js targetHostScopeIssue`, 순수 — `test/nsxRemoteScope.test.js` 고정).
    인벤토리에 없는 임의 IP 는 범위 계정에 403(내부망 정찰·범위 밖 피벗 준비 차단). 전체 범위
    계정은 기존 신뢰 모델 유지(임의 대상 허용). 이 검사를 형식 검증(SAFE_HOST)만으로 되돌리지 말 것.
    ⚠ v2.744(최종 검토 FD — RF-R1): '인벤토리에 실재하는 대상' 에는 **허용 vCenter 호스트의 원장 관리 IP**(`ipam/ledger.js hostLedgerIp` — FQDN 으로 등록된 ESXi 의
    관리 IP)도 들어간다(`proxy/targetHostScope.js`). IP 대장 호스트 행이 그 IP 를 보여 주고 원격 접속 대상으로 쓰므로, 빠지면 범위 계정이 자기 호스트에 403 을 받는다.
    그 주소가 **범위 밖 객체(VM IP·호스트 이름·관리 IP)와도 겹치면 거부**하고, 비정규 IPv4 표기(`010.0.0.5`)는 거부한다(inet_aton 이 다르게 읽는다 — v2.589).
    회귀 `test/audit2744fd.test.js`.
- **토큰 검증은 `resolveTokenUser` 하나로**: `verifyToken`을 직접 호출해 `payload.role`을 신뢰하지 말 것 — tokenVersion 폐기·최신 역할 반영이 우회된다(WS 게이트웨이에서 실제로 뚫렸던 경로).
- **central 엔드포인트의 agent 바인딩**: `routes/central.js` 미들웨어가 '개별 토큰 ↔ agent' 일치를 강제한다. 새 엔드포인트가 `?agent=`/`body.agent`로 데이터를 고르면 그 미들웨어를 우회하지 않게 할 것(자격증명 횡탈 차단).
- **자격증명 파일은 원자적 쓰기 + 로드 손상 보존**: `util/atomicWrite.js`의 `atomicWriteFileSync`로 쓰고(직접 `fs.writeFileSync` 금지), **로드 catch에서 파싱 실패 시 `preserveCorrupt(FILE)`로 `<file>.corrupt.<ts>` 보존** 후 빈 값 반환. 쓰기만 원자적이고 로드가 손상을 조용히 `[]`로 넘기면, 다음 저장이 온전했던 원본을 빈 목록으로 덮어써 전 자격증명이 영구 유실된다(3차 감사 지적 — vcenters/nsx/collectors/users 4종이 이 비대칭이었음). portal.env(CENTRAL_TOKEN)도 원자적으로 쓴다.
- **소유자 경계는 서버측 강제**: `settingsOwners`(설정 소유 계정)처럼 UI가 숨기는 권한 경계는 서버에서도 검사한다(`routes/admin.js requireSettingsOwner`). 클라이언트 전용 게이트는 admin이 API를 직접 호출해 우회·소유자 목록 탈취가 가능하다.
  - ⚠ **소유자 등급 = 소유자 ∧ 전체 범위**(v2.744 AUTHZ-02, `routes/admin/shared.js requireSettingsOwner`): 소유자 목록에 있어도
    범위가 지정된 계정(scope.vcenters)은 403(`SETTINGS_OWNER_FULL_SCOPE_REASON`)이다. `/auth/me` 의 **`isSettingsOwner`(설정 메뉴 노출 —
    소유자 목록에 있는가) ≠ `settingsOwnerTier`(소유자 등급 라우트를 실제로 통과하는가)** — 화면이 소유자 등급 버튼을 잠글 때는 뒤의 값을 볼 것.
  - **백업 라우트도 소유자 경계에 포함**: 백업 아카이브는 `portal.env`(AUTH_SECRET·CENTRAL_TOKEN)·
    `users.json`(TOTP 시크릿)·`vcenters.json` 등 자격증명 사본이라 `/api/admin/backup/*` 전부에
    `requireSettingsOwner`를 건다(v2.210). AUTH_SECRET이 새면 임의 계정 토큰 위조로 OTP 정책·
    소유자 경계가 동시에 뚫린다. 백업 확장자 화이트리스트(`.json`/`.env`)를 넓히면
    `settings-owners.txt`가 복원 대상이 되어 소유자 목록을 갈아끼울 수 있으니 넓히지 말 것.
  - 유효 소유자 = **UI 저장분 + 서버 파일/환경변수(`settings-owners.txt`·`SETTINGS_OWNERS`) + 중앙 배포 admin + `noainred`**.
    뒤 세 가지는 `security-session.json`에 기록하지 않아 **UI 저장이 지울 수 없다** — 전원이 설정에서
    잠기는 사고의 복구 경로이므로 `fileSettingsOwners()` 합산을 제거하지 말 것.
- **RDP 자격증명은 티켓으로**: RDP WS 게이트웨이는 username/password/domain을 URL 쿼리스트링에 싣지 않는다 — `proxy/rdpTicket.js`의 1회용 단기 티켓(`POST /api/remote/rdp-ticket`)으로 발급받아 쿼리엔 티켓 ID만 싣고 게이트웨이가 인메모리에서 조회한다(쿼리스트링은 상위 프록시 액세스 로그·브라우저 히스토리에 남음).
- **서명 확인 화면 끄기(v2.809)는 env warn 과 같은 판정·시한부·소유자+OTP·root 확인 제외**(`upgrade/signatureOverride.js` · `signaturePolicy`) —
  `!runningAsRoot()`·`!t.fatal`·env 우선·`where:'offline'` 제외·상태 파일 등록·인증 꺼짐 409·복원 제외(RESTORE_EXCLUDE)·'지금' 기준 상한 중
  하나라도 빼면 회귀(`test/upgradeSigOverride2809.test.js` 변이 16건 · 반증 1인 M-1·M-2·L-1·L-3 반영).
- **백업 복원은 OTP 로만 끄는 보안 설정을 되살리지 않는다**(v2.842 반증 F1 — 재현): 복원 라우트는 소유자 등급만 보고 OTP 를 묻지 않는다.
  그런 값은 파일째 복원 제외(`RESTORE_EXCLUDE` — v2.809 서명 확인 끄기)이거나 `backup/stagedRestore.js reconcileForApply` 로 **켜기만**
  (security-session.json `bareosSetupOtp` — 지금 파일도 끔일 때만 끔). 새 'OTP 로 끄는' 설정을 만들면 둘 중 하나에 넣을 것(`bareosSetupOtp2842` ⑤).
- **업그레이드 번들 sha256 필수**: 자체 업그레이드·엣지 푸시 양쪽 모두 검증하고, 부재도 거부(`UPGRADE_ALLOW_UNVERIFIED`만 예외). 한쪽만 검증하면 함대 확산 경로가 뚫린다.
  - ⚠️ v2.480 정직 기록: 이 규칙은 v2.479 까지 **문서만** 있었다 — 엣지 `/api/upgrade/bundle`·수집기 `/api/collector/upgrade` 는 sha 를 받지도 검증하지도 않았다. 이제 중앙 push(`upgrade.js pushBundleToEdge`·`collector/upgradePush.js`)가 `X-Bundle-Sha256` 헤더를 보내고 수신측이 `upgrade/upgrade.js bundleShaIssue` 로 검증한다(`test/audit2480.test.js`). 헤더를 없애거나 검증을 빼면 이 규칙이 다시 문서만 남는다.
  - ⚠⚠ **v2.591 정직 정정(감사 P6 — 재현)**: push 경로의 `X-Bundle-Sha256` 은 **같은 요청이 스스로 신고한 해시**라
    전송 중 손상·잘림만 잡는다. 악성 번들의 sha 를 계산해 헤더에 실으면 통과한다 — **토큰 탈취·http 중간자 방어가 아니다.**
    실제 방어는 토큰 + TLS(`upgradeAgent`·https 엣지)이고, 이 검사를 근거로 그 둘을 약화하지 말 것. 원격 다운로드
    (`verifyBundleSha`)는 sha 를 별도 TLS 채널(versions.json)에서 받으므로 건전하다. 진짜 push 무결성은 수신측 키 서명
    (rma/signing.js HMAC 패턴)이 필요하다 — 별건.
  - ✅ **2026-10-09 S-10 — 위 두 줄의 '별건' 은 Ed25519 서명 manifest 로 해결했다**(`upgrade/signature.js decideSignature` 하나). 그리고 v2.591 이 '원격 다운로드는
    건전하다' 고 적은 것도 정정한다 — versions.json 의 sha 는 번들과 **같은 채널**(롤링 릴리스·사내 미러)에서 오므로 미러·배포 토큰을 가진 쪽이 둘을 함께 바꿀 수 있다
    (재현). sha256 은 전송 손상만 잡고, 배포자 확인은 미리 고정한 공개키로 한 서명 검증이 한다. 같은 채널에서 온 SHA·탈취 가능한 전송 토큰 HMAC 을 배포자 서명으로 오인하지 말 것.
    ⚠ v2.735.1(사용자 결정 — 서명 키 등록 전 게시): 신뢰 키가 **하나도 설정되지 않은** 설치본은 env 없이 warn 이다(`signatureCore.resolvePolicy`·`trustUnconfigured`).
    키 항목(회수 포함)·호스트 파일·키 파일 오류 중 하나라도 있으면 require 다 — '아무것도 믿지 않음' 을 '설정 안 됨' 으로 약하게 읽지 말 것. 틀린 서명은 여전히 거부.
    ⚠⚠ v2.742(RECENT-01·INJPKG-01): **root 로 도는 확인(install.sh·vmware-portal-verify·release-verify)은 회수를 어느 키 파일에서든 합치고, 키 추가만 root 소유 파일에서 받는다** —
    v2.741 은 서비스 계정 소유 호스트 파일을 통째로 무시해 회수까지 버렸다(회수한 키로 서명한 번들을 root 가 받았다). install.sh 가 root 전용 사본(`<tools>/trust/release-signing-keys.conf`)을
    남기고 root 확인이 env `VP_ROOT_TRUST_COPY` 로 그 사본의 **회수만** 합친다(원본을 지워도 회수가 풀리지 않는다). 서비스 계정 경로(포탈 자신)는 예전 그대로다. 회귀 `audit2742a`.
  - **연결 테스트는 저장 비밀번호를 물려받을 때 host/url 도 저장값으로 고정**(v2.480): vCenter·NSX·Horizon·iDRAC `testConnection`/`testServer`·수집 서버 `/collectors/test`·SMTP·PDU·베어메탈·GPU 게스트 테스트 전부 `{...saved, ...body}` 병합에서 host/url/ip 를 요청값으로 두면 저장 비밀번호가 공격자 호스트로 평문 전송된다(uagmon M3 클래스). 새 "저장 항목 테스트" 를 만들 때 같은 규칙.
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
     - ⚠️ v2.272: 이 passwordHash 삭제는 **OTP 전용 정책일 때만**(`isOtpOnlyRole(role)`) 수행한다 —
       혼용/비번전용 정책에서는 등록 후에도 비번을 **의도적으로 유지**해 둘 다 로그인하게 한다.
       조건(`isOtpOnlyRole`)을 없애 무조건 삭제로 되돌리면 혼용/비번전용 계정이 등록 즉시 비번을
       잃는다. `initial-admin-password.txt`(임의 생성 평문)는 정책과 무관하게 항상 지운다.
  - `mustEnrollOtp`는 토큰이 아니라 `resolveTokenUser`에서 **매 요청 사용자 레코드 기준**으로
    계산한다(등록 즉시 반영·우회 불가).
  - ⚠️ **콘솔 등록 도구(`server/src/tools/otp-enroll.js` + 래퍼 `otp-enroll.sh`)를 없애지 말 것** —
    헤드리스 등록과 '모든 admin이 OTP 분실' 잠금 복구 경로다. 래퍼는 번들 Node 경로·CONFIG_DIR·
    서비스 계정 강등을 처리하므로 문서에서 `node`를 직접 안내하지 말 것(root 실행 시 users.json이
    root 소유가 되어 포탈이 쓰기 불가). 기동 시 `warnIfNoOtpAdmin()`이 부재를 경고한다.
    긴급 해제는 `OTP_ROLE_ENFORCE=false`. viewer·데모는 강제 대상이 아니다.
  - v2.723 콘솔 계정 메뉴(`tools/user-admin.js` + `user-admin.sh`, 설치본 `vmware-portal-users`)도 같은 신뢰 경로(`trusted:true`)다 —
    래퍼의 서비스 계정 강등을 빼지 말 것(같은 이유). 계정별 로그인 방식은 `login-policy-users.txt`(UI 미노출 규칙 그대로 — 화면·API 에 싣지 않는다)를 쓴다.
  - **전역 로그인 정책(v2.272)**: OTP 강제 여부는 이제 설정 소유자가 '설정 › 세션 보안'에서 고르는
    전역 정책(`security-session.json` `loginPolicy`)이 결정한다 — `isOtpOnlyRole`이 이 값을 읽는다
    (핫패스라 `securitySettings.effectiveLoginPolicy`가 3초 캐시·저장 시 즉시 무효화). 값:
    `null`(미설정=**기본**·레거시: 고권한만 OTP 전용, 그 외 혼용) · `otp_only`(전 계정 OTP 전용) ·
    `otp_or_password`(혼용: 비번 또는 OTP) · `password_only`(비번 전용, 비번 없는 레거시 계정만 OTP 폴백).
    - **기본값은 엄격(레거시)을 유지**하고, 약화(`otp_or_password`/`password_only`)는 **owner + 본인
      OTP 재인증 + 감사로그**를 거친 명시적 저장으로만 일어난다(PUT `/security/session` 경로 재사용).
      사용자가 이 3-way 정책을 명시 요청해 도입했으므로, `password_only`가 admin/operator 의 비번
      로그인을 허용하는 것은 **의도된 동작**이다 — 감사 재발을 이유로 정책 자체를 제거하지 말 것
      (대신 기본값·owner 게이트·경고·`OTP_ROLE_ENFORCE=false` 긴급 해제 경로를 유지).
    - AD 계정은 정책 대상이 아니다. `password_only`는 비번 보유 계정의 OTP 를 거부하되(전용),
      비번이 없는(과거 OTP 전용으로 폐기됨) 계정은 OTP 폴백을 허용해 **잠금 사고를 막는다** —
      이 폴백을 없애면 정책 전환만으로 계정이 벽돌이 된다. 회귀 방지 테스트: `server/test/loginPolicy.test.js`.
    - **사용자별 재정의(v2.273, UI 미노출이 요구사항)**: `CONFIG_DIR/login-policy-users.txt`
      (`user=policy` 한 줄씩, 별칭 `otp`/`password`/`both`) + env `LOGIN_POLICY_USERS`(파일 우선)로
      특정 사용자의 정책을 재정의한다. 판정은 `auth.js isOtpOnlyUser(username, role)` —
      재정의 > 전역 > 레거시 순이며 로그인·`mustEnrollOtp`(resolveTokenUser·WS 게이트웨이)·
      enroll 시 비번 폐기가 전부 이 함수를 탄다. `isOtpOnlyRole(role)`은 사용자 특정이 없는
      역할 단위 판단 전용으로 남겨둔 것(warnIfNoOtpAdmin)이니 새 사용자 단위 판정에 쓰지 말 것.
      이 목록은 **설정 UI·미인증 응답 어디에도 싣지 않는다**(계정 열거 단서). 형식 오류 줄은
      무시+1회 경고이며 파일 읽기 실패는 빈 재정의(전역 정책)로 폴백한다.
      테스트: `server/test/loginPolicyUsers.test.js`.
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
  - **scope 는 검색·도구 집계·IPAM 조회/쓰기까지 전면 적용(v2.255~2.257)**: 감사 M1 이 명시했듯
    `/search/nl`·`/tools/deep-search`·`/tools/vm-finder`·`/tools/{gpu,gpu/vms,threats,capacity,waste,thin-vms,`
    `capacity-forecast,guest-os,guest-os/vms,hardware,esxi,hba,licenses,insights}`·`/insights/chatops`·
    `esxi-temp`/`gpu` **history(key 소유권 검사)**·IPAM 조회 전수·IPAM **쓰기**(override/annotation/정책 —
    `ipInWriteScope`: 소유 vCenter∩allowed, 미귀속은 claimed 필수)에 scope 를 건다. **새 조회/집계/쓰기
    라우트를 추가하면 반드시 같은 패턴**(요청 필터보다 먼저 scope 교집합)을 적용하고, **memoJson 캐시
    라우트는 `extraKey: scopeKey(...)` 필수**(빠지면 무제한 계정 결과가 범위 계정에 캐시로 샌다 —
    `/summary`·`/overview` 실제 사례). **vCenter 귀속 없는 데이터(스캔 발견물·미귀속 override·byVcenter
    요약)는 범위 계정에 노출하지 않는다.** 단, 외부 프로그램이 공유하는 `ipam.db` 원장 자체(`syncLedger`)는
    무스코프 유지(외부 리더가 절단본을 받으면 안 됨 — 라우트에서만 scope 주입).
  - ✅ **수정됨(v2.313 보안 감사)**: 아래 조회 갭 2건을 `scopedVcenterIds` 교집합(요청 필터보다 먼저) + `requirePerm` 로 닫음.
    - `provision/{sources,placement,saved,saved/:id}`(`routes/api/provision.js`·`provision/jobs.js listSources`·
      `provision/saved.js listSaved`): `requirePerm('vm.provision')` + scope 교집합. `/placement`는 scope 계정이
      범위 내 vCenter 를 명시하지 않으면 403(범위 밖 라이브 SOAP 차단). 귀속 없는 저장 작업은 범위 계정 미노출.
      테스트: `server/test/provisionScope.test.js`.
    - `/idrac/host-power`(`routes/api/vmMetrics.js`): 스냅샷에서 `name`→호스트 조회 후 `inUserScope` 위반 시 404(존재 은닉).
  - ✅ **수정됨(v2.320)**: `/nsx`·`/nsx/group-members` 에 scope 적용 — 범위 계정에는
    **귀속 매니저만**(매니저.vcenterId∈허용 vCenter ∪ 매니저.region∈허용 vCenter 의 region)
    노출하고, 하위 리소스(게이트웨이/세그먼트/DFW/보안그룹)·rollup(재계산)·collectionErrors 도
    보이는 매니저 기준으로 절단한다(`nsx/scope.js` 순수 판정 — `test/nsxRemoteScope.test.js` 고정).
    **무귀속 매니저는 범위 계정에 숨긴다**('귀속 없는 데이터 미노출' 불변조건). group-members 는
    범위 밖 매니저에 404(존재 은닉). 전체 범위 계정은 기존 전량 반환 유지. 이 필터를 요청 쿼리
    (?managerId/?region) 뒤로 옮기지 말 것(scope 가 요청 필터보다 먼저 — 상위 규칙).
  - **중앙 GPU 오버레이 direct-mode 봉인(v2.257)**: `/api/central/gpu-guest-data` 는 저장 키를
    `centralAuth.agent` 로 강제하고, hostId/vmId 의 소유 vCenter 를 **`listInventory` 최장 프리픽스
    매칭**으로 판정한다(vc.id 에 콜론이 있어 단순 `split(':')` 로는 오파싱). `collectMode!=='site'`
    (중앙 직접 수집) vCenter 는 어떤 엣지도 GPU 오버레이를 못 쓴다(로컬 수집기만 기록). 최장 프리픽스로
    풀어야 하는 이 규칙을 되돌려 콜론 split 로 바꾸면 봉인이 무력화된다.
  - **UAG 모니터(uagmon) 자격증명 유출 방어(v2.257, M3)**: `guard.js hostBlockReason` 는 공개
    IP(IPv4·IPv6 대칭)를 기본 차단(사내 RFC1918·IPv6 ULA 만 허용, `UAGMON_ALLOW_PUBLIC` 옵트인),
    `uag.js fetchUagStats` 는 **연결 직전 해석 IP 를 재검증**하고 접속은 그 IP·TLS/Host 는 원호스트로
    핀(리바인딩 차단), `store.js normalizeTarget` 은 **host 변경 시 저장 비번을 이월하지 않는다**.
    저장·연결 이중검사를 한쪽만 남기면 host 바꿔치기로 Basic 자격증명이 공격자 서버로 선제 전송된다.
- **WS 게이트웨이는 미들웨어를 타지 않는다**: SSH/RDP upgrade 핸들러는 `requireEnrolled`·
  `requirePerm`이 자동 적용되지 않으므로, 인증·권한·**`mustEnrollOtp`**를 모두 핸들러 안에서
  직접 검사해야 한다(v2.207: 등록 전 세션이 터널을 열 수 있던 결함 수정).
- **미인증 응답에 계정명을 싣지 않는다**: `/api/auth/config`는 로그인 전 조회되므로
  `settingsOwners` 같은 *계정명 목록*을 넣으면 관리자 계정 열거 단서가 된다. 소유자 판단은
  인증 후 `/auth/me`의 `isSettingsOwner` 불리언으로 내려준다(서버는 `requireSettingsOwner` 유지).
- **특수 계정 보호**: `noainred`(superuser)는 admin 고정·강등/삭제/로그인차단 거부 + settingsOwners 자동
  포함, `thedvcdemp`(demo)는 viewer 고정·삭제 거부. 시드(`ensureSuperUser`/`ensureDemoUser`)는 같은
  이름의 기존 수동 계정을 덮어쓰지 않는다(하이재킹 방지).
- **사용자별 쓰기(수정) 범위 — writeVcenters(v2.369)**: `user.scope.writeVcenters` 는 '수정/변경
  가능 vCenter' 의 별도 축이다. 판정은 `auth/scope.js writeScopedVcenterIds`(항상 **조회 범위와의
  교집합** — 조회 못 하는 vCenter 는 수정도 불가) / `inUserWriteScope` 하나로만 한다.
  **미설정(빈 배열)=쓰기 범위=조회 범위**(기존 계정 동작 보존) — 이 기본값을 바꾸면 전 계정이
  잠긴다. 적용 지점: VM 프로비저닝 생성/저장작업 수정·삭제, VM 복제 잡 생성/실행/삭제,
  `/vms/upgrade-tools`, `/guest/add-user`, `/vms/:id/console`(콘솔=조작 능력),
  `POST /vm/:id/reconfig`(VM 사양 변경 — v2.389 에서 누락 발견·추가. `collectorsDc.js`
  `vmScopeDenied` 헬퍼. 같은 파일 `GET /vm/:id/hardware` 는 조회 범위만 검사), IPAM 쓰기 전수
  (annotation/override/bulk/정책 — `ipamExport.js writeScopeDenied`). 응답 규약: **조회 범위 밖은
  기존대로 404(존재 은닉), 조회는 되지만 쓰기 범위 밖은 403**(존재가 이미 보이므로 은닉 무의미).
  새 vCenter 대상 상태변경 라우트를 추가하면 반드시 같은 검사를 넣을 것(회귀 테스트:
  `test/writeScope.test.js`).
  ⚠ v2.733(C3-02a 게스트 조사 작업): **바깥 조건을 `scopedVcenterIds` 로 두지 말 것** — 조회 무제한 + writeVcenters 계정이
  통째로 검사에서 빠진다. 판정은 '조회 밖 404 → 쓰기 밖 403' 순서의 **한 함수**(`backupNetSec.js guestScanAccess`)이고, 대상 vCenter 가 없는
  작업은 범위 계정에 밖이다. GET 은 조회 범위로 보여 주고 쓰기 밖 항목에 `writable:false` 를 달아 화면이 버튼을 잠근다.

## 옮긴 절 (2026-10-20 — 이 파일을 짧게 유지하려고)

- 모듈별 불변조건은 그 폴더의 CLAUDE.md 로 옮겼다(그 폴더 파일을 읽을 때 자동 로드된다): `src/relaytopo/`(중계 토폴로지) · `src/agent/`(배포 대상 레지스트리) ·
  `src/rma/`(원격 명령 에이전트) · `src/security/`(통합 계정 관리) · `src/sanswitch/`(SAN 연결 테스트 대행) · `src/hostaccess/`(호스트 접근 제어).
- 날짜별 감사 조치(2026-09-12 ~ 10-16, 20절)는 `docs/rules/server-security-history.md` 로 옮겼다 — 인증·권한·SSRF(`lookup: ssrfLookup`)·큰 본문 게이트·
  비밀 봉인·인증 실패 정지·세션 폐기·장비 신뢰(peerTrust)·관리자 판본(`isAdminDetailUser`)·엣지 등록부 손상 503 코드를 고치기 전에 읽을 것.
- 새 보안 규칙은 테스트로 고정하고, 모듈 전용이면 그 폴더 CLAUDE.md, 서버 전반이면 이 파일에 **짧게** 적는다(크기 상한 — `server/test/claudeMdSize.test.js`).
