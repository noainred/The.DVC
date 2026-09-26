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
- **SSRF 재검증에 타임아웃 없는 DNS 조회를 핫패스에 넣지 말 것**: `ssrfBlockReasonResolved` 는 타임아웃이
  없어 폴러 루프에서 매 점검마다 부르면 DNS 지연이 이벤트 루프를 막는다(svcmon 비-HTTP 재검증 보류 사유).
  실행시점 재검증이 필요하면 `dns.lookup`(타임아웃)+`ipBlockReason` 후 그 IP 로 직접 접속(uagmon 핀 패턴).

- **전역 TLS 디스패처 금지**: `setGlobalDispatcher`로 프로세스 전체 fetch의 인증서 검증을 끄지 않는다(과거 vCenter용 설정이 업그레이드 번들·NSX까지 오염). 자체서명이 필요한 곳만 로컬 디스패처를 `dispatcher:` 옵션으로 주입한다(`vcenter/restClient.js vcDispatcher`, `nsx/client.js`, `util/resilientFetch.js wanAgent`).
- **WAN(중앙↔엣지) TLS 기본 검증 ON**: `WAN_TLS_INSECURE`는 `=== 'true'`일 때만 검증 해제. 의미를 반전시키지 말 것(과거 '미설정=검증 off'였고 그 구간으로 토큰·자격증명이 흐른다).
- **상태변경 라우트 RBAC**: `/api` 의 POST/PUT/PATCH/DELETE에는 `requireRole('admin','operator')`를 붙인다(읽기성 POST 제외). WS SSH/RDP 게이트웨이도 역할을 검사한다.
  - ✅ **수정됨(v2.313)**: `DELETE /remote/mappings/:id`(`routes/remote.js:208`)에 `requirePerm('remote.access')`
    추가 + 소유자 없는 매핑은 admin 전용으로 보정(과거 `m.owner && …` 단락으로 소유자 없는 레거시 매핑을
    임의 인증 사용자가 삭제 가능했음).
  - ✅ **수정됨(v2.320)**: `/remote/{probe,quick-connect}` 의 `targetHost` 에 scope 적용 —
    범위 계정은 **허용 vCenter 인벤토리에 실재하는 대상**(VM IP/이름·호스트 이름)만 프로브/터널
    생성 가능(`remote.js targetHostScopeIssue`, 순수 — `test/nsxRemoteScope.test.js` 고정).
    인벤토리에 없는 임의 IP 는 범위 계정에 403(내부망 정찰·범위 밖 피벗 준비 차단). 전체 범위
    계정은 기존 신뢰 모델 유지(임의 대상 허용). 이 검사를 형식 검증(SAFE_HOST)만으로 되돌리지 말 것.
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
  - ⚠️ v2.480 정직 기록: 이 규칙은 v2.479 까지 **문서만** 있었다 — 엣지 `/api/upgrade/bundle`·수집기 `/api/collector/upgrade` 는 sha 를 받지도 검증하지도 않았다. 이제 중앙 push(`upgrade.js pushBundleToEdge`·`collector/upgradePush.js`)가 `X-Bundle-Sha256` 헤더를 보내고 수신측이 `upgrade/upgrade.js bundleShaIssue` 로 검증한다(`test/audit2480.test.js`). 헤더를 없애거나 검증을 빼면 이 규칙이 다시 문서만 남는다.
  - ⚠⚠ **v2.591 정직 정정(감사 P6 — 재현)**: push 경로의 `X-Bundle-Sha256` 은 **같은 요청이 스스로 신고한 해시**라
    전송 중 손상·잘림만 잡는다. 악성 번들의 sha 를 계산해 헤더에 실으면 통과한다 — **토큰 탈취·http 중간자 방어가 아니다.**
    실제 방어는 토큰 + TLS(`upgradeAgent`·https 엣지)이고, 이 검사를 근거로 그 둘을 약화하지 말 것. 원격 다운로드
    (`verifyBundleSha`)는 sha 를 별도 TLS 채널(versions.json)에서 받으므로 건전하다. 진짜 push 무결성은 수신측 키 서명
    (rma/signing.js HMAC 패턴)이 필요하다 — 별건.
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

## 중계 토폴로지(`relaytopo/`, v2.431) 불변조건 — v2.435 감사 조치, 되돌리지 말 것

- **host 변경 시 저장 비밀 미이월**(`store.js normNode`·`mergeImport mergeNode`·Main): 노드의
  privateIp/publicIp 가 바뀌면 password/privateKey/passphrase 를 **전부 버린다**. dc 이름만 보고
  이월하던 v2.431 은 `publicIp` 만 공격자 호스트로 바꾸고 비밀을 빈 값으로 저장한 뒤 SSH 테스트를
  부르면 운영 비밀번호가 그 호스트로 평문 전송됐다(uagmon v2.257 M3 와 같은 패턴의 회귀).
  저장·가져오기 **양쪽 모두** 유지할 것 — 한쪽만 남기면 다른 경로로 뚫린다.
- **배포 대상 자격증명은 그 배포 대상 자신에게만**(`ops.js resolveNodeAccess`): `agent-deploy-targets.json`
  의 비밀을 쓸 수 있는 것은 **접속 host = 그 배포 대상 host** 일 때뿐이다. IRS 는 중계 엣지를 경유하므로
  '그 중계 엣지가 바로 그 배포 대상' 일 때만 허용한다. 이 검사를 없애면 sshTargetId 로 아무 대상을 골라
  다른 비밀 저장소의 자격증명을 임의 호스트로 내보낼 수 있다.
- **조회 응답은 역할로 축약**(`routes/api/relaytopo.js`): `GET /tools/relaytopo` 는 `requirePerm('tools')`
  로 열려 있고 **operator 가 tools 를 기본 보유**하므로, 원격 `haproxy.cfg` 전문·`portal.env` 발췌·배포
  대상 목록·접속 경로는 `req.user?.role === 'admin'`(**거부 기본값**)일 때만 싣는다(`ops.stripCfg`).
  `render/:dc` 는 관리 블록에 전 사이트 내부 IP 가 들어가므로 adminOnly. `stripCfg` 를 다시 항등함수로
  되돌리지 말 것.
  ⚠ **v2.593(AUTHZ-01)**: 그 축약이 **토폴로지 본체**에는 없었다 — 비-admin 에게 전 사이트 사설·공인 IP·vCenter IP·SSH 계정명이
  그대로 나갔다. `maskTopology` 가 주소·계정을 비우고 점검 결과(issues)는 문구에 주소가 들어가 개수만 준다(`addressHidden`·`issueCount`).
- **원격 haproxy.cfg 교체 3규칙**(`ops.js applySite`): ① `systemctl is-active` 는 **마지막 줄 정확 비교**
  (`isActiveOut`) — `/active$/` 는 'inactive' 에 매치돼 장애를 성공으로 보고하고 롤백을 건너뛴다.
  ② 백업(`cp -a`) 실패 시 **원본을 건드리지 않고 중단**(`set -e` + 종료코드 91/92/93) — `;` 로 이으면
  백업 없는 교체가 되고 롤백이 불가능해진다. ③ 현재 cfg 읽기는 **존재 신호(`__HAS__`/`__NONE__`)를 분리**
  — 파일은 있는데 내용이 비면 중단한다(빈 문자열로 병합하면 관리 블록만 남은 cfg 가 `haproxy -c` 를
  통과해 기존 설정을 전부 날린다).

## 배포 대상 레지스트리(`agent/deployRegistry.js`) 불변조건

- **`SECRET_KEYS` 는 `password`·`privateKey`·`centralToken`·`collectorToken` 4종**(v2.435). 두 토큰이
  빠져 있던 v2.339~2.434 는 `GET /agent-deploy/targets` 응답과 저장 응답에 토큰을 평문으로 실었다.
  중앙 토큰 유출 = 엣지→중앙 API 임의 호출, 수집 토큰 유출 = 그 엣지 수집 데이터 열람이다.
  이 목록에서 값을 빼지 말 것 — `redact()`(응답 가림)과 `saveTarget()`('빈 값 = 기존 유지')이 같은
  배열을 쓰므로, 빼면 두 보호가 동시에 사라진다. 비밀 포함 CSV 내보내기는 `listTargetsRaw()` +
  `requireSettingsOwner` 경로만 유지.

## RMA(원격 명령 에이전트, `rma/`, v2.416) 불변조건 — 되돌리지 말 것

- **개별 토큰 전용**: `/api/central/rma-poll`·`rma-result` 는 `req.centralAuth.mode !== 'agent'` 면 403. 원격 명령은
  자격증명보다 큰 권한이라 공유 CENTRAL_TOKEN 예외(TOFU)를 두지 않는다. 결과 회신은 reqId 소유 agent 만.
- **프리셋 카탈로그 + argv 실행**(`rma/commands.js`): 중앙은 프리셋 id·파라미터만 보내고 **엣지가 다시 검증**해
  argv 배열로 spawn 한다(셸 없음). 파라미터는 화이트리스트 정규식(선행 `-` 차단). 자유 명령(`custom`)은
  **엣지 측 `RMA_ALLOW_CUSTOM=true`** 일 때만 — 중앙 설정으로 켜지게 만들지 말 것(현장 담당자의 opt-in 이 설계).
  파일 내용을 읽는 프리셋·재부팅/전원 프리셋을 추가하지 말 것(portal.env 유출·사고). sudo 프리셋을 늘리면
  `unitTemplate.js RMA_SUDOERS` 와 `install.sh` 의 규칙도 같은 줄로 늘려야 한다.
- **서명**(`rma/signing.js`): 법인 비밀번호(`rma-agents.json`, SECRET_FILES 봉인)가 있으면 잡에 HMAC 을 붙이고 엣지는
  `RMA_PASSWORD` 로 검증(±10분). 비밀번호는 선로에 싣지 않는다(서명만). 응답·감사로그에도 값 미기재.
- **비멱등 잡큐**(`rma/jobs.js`): `MAX_CLAIMS = 1` — 인출 후 미회신은 **재인출 없이** 오류 종결. 캡처 큐처럼 재시도로
  바꾸면 서비스 재시작/자유 명령이 두 번 실행된다. 배정 대상이 오프라인(하트비트 만료)일 때만 다른 인스턴스가 가져간다.
- **롱폴 대기 타이머는 unref 하지 않는다**(응답 대기 중인 HTTP 요청이 있다). 대기 상한 55초(프록시 유휴 타임아웃 아래).
- **패키지 유닛 동일성**: `packaging/offline/vmware-portal-rma@.service` 는 `rma/unitTemplate.js` 와 바이트 단위로 같아야
  한다(`test/rma.test.js` 고정) — 원격 배포와 오프라인 설치가 다른 유닛을 쓰면 안 된다.
- **배포 값은 화이트리스트 후에만 셸/env 에**(`rma/deploy.js`): 인스턴스 이름·경로·계정·env 값 정규식, 비밀번호는
  KEY=VALUE 안전 집합만. 설치 경로는 추측하지 않고 `systemctl show` 출력을 재검증해 쓴다.
- **점검·액션 확장(v2.418)의 경계**: 파일 계열 점검은 엣지 `RMA_FILE_ROOTS`(realpath 기준, `testRunner.pathAllowed`) 밖을
  읽지 않는다 — 접두 문자열 비교로 바꾸면 `/var/logs` 같은 우회가 생긴다. 서비스 제어 프리셋(`unitPolicy`)은 엣지
  `RMA_SERVICE_UNITS` 에 있는 유닛만, `reboot` 는 `RMA_ALLOW_REBOOT` 일 때만 — 이 두 목록은 sudoers(`RMA_SUDOERS`,
  install.sh) 와 항상 같은 원천에서 생성한다. 원격 관리(`config`)는 **축소만**(disabledTests·longpoll·동시성) —
  허용 확대·allowCustom·서명 해제를 중앙이 내려줄 수 있게 만들지 말 것. 폴에 동봉된 점검 결과는 그 법인 스케줄에
  있는 항목 id 만 반영한다(`known` 집합) — 남의 항목 id 로 상태 위조 차단. 점검 이력은 상태 변화 + 1시간 단위만
  저장(diff-저장) — 30초 점검 × 수백 항목 전량 적재 금지.

## 통합 계정 관리(`security/credentialStore.js`, v2.419) 불변조건 — 되돌리지 말 것

- **비밀 값은 어떤 API 응답에도 싣지 않는다**(목록/단건/테스트 응답은 hasPassword/hasKey/지문만). '보기'·'내보내기'
  경로를 만들지 말 것. 백업 아카이브만 예외(기존 설정 소유자 전용 규약).
- **변경은 재인증**: 로컬 OTP 계정은 `verifyUserOtp`(1회용·잠금), OTP 없는 계정은 설정 소유자만. 등록/수정/삭제/
  연결 테스트/브로커 인출 전부 `logAudit`(비밀 미기재).
- **브로커(`/api/central/rma-credential`)는 개별 토큰 전용** + 계정의 `agents`·`hosts` 범위를 **둘 다** 검사 + 분당 상한 +
  `Cache-Control: no-store`. 잡/스케줄/outbox 에 비밀을 싣지 않는다 — 엣지는 실행 직전 브로커에서 받아 메모리에만
  (`RMA_CRED_CACHE_MS`) 두고 파일에 쓰지 않는다. 1회 입력 계정(`spec.secret`)은 `takeJobs` 인출 즉시 중앙에서 삭제.
- **엣지 opt-in**: `ssh-exec`/`ssh` 는 `RMA_ALLOW_SSH=true` + `RMA_SSH_TARGETS`(엣지 정책) 안에서만. 중앙 설정으로 켜지게
  만들지 말 것. `credentials.json` 은 SECRET_FILES 등록(password/privateKey/passphrase 봉인) + 0600 + atomicWrite +
  preserveCorrupt — 정직한 한계: 키 파일이 같은 호스트에 있어 at-rest 보호이며 호스트 완전 장악은 못 막는다.

## SAN 스위치 연결 테스트 대행(v2.421) 불변조건

- `sanswitch/testRuns.js` 의 run 객체에는 비밀번호(device.password)가 있지만 **`getTestRun()` 응답에는 device/비밀번호를
  절대 넣지 않는다**(sanitize). 엣지에 내려가는 `testNow` 만 비밀번호를 포함한다(엣지가 로그인해야 함) — 이것은
  `sanswitch-config` 와 같은 신뢰 경계(개별 토큰 바인딩 agent 대조 후 서빙).
- 결과 회신(`POST /api/central/sanswitch-test-result`)은 **그 요청의 대상 엣지와 같은 agent 만** 받는다
  (`completeTestRun` 대조). 회신 본문은 `sanitizeResult` 로 화면이 쓰는 필드만·크기 제한해 저장한다(임의 필드/대용량 차단).
- SSH 추적 로그(`proxy/sshExec.js trace/verbose`)에 비밀번호·개인키를 찍지 않는다. ssh2 debug 는 프로토콜 단계만 남긴다.
  구형 알고리즘 폴백은 협상 실패(`no matching …`)에만 1회이며 항상 추적 로그에 남긴다(조용한 하향 금지).

## 호스트 접근 제어(`hostaccess/`, v2.485) 불변조건 — 되돌리지 말 것

포탈 호스트의 SSH/웹 클라이언트 제어·OS 방화벽 추가 규칙을 firewalld 로 적용한다. 서버 접근 경로를 바꾸는 기능이라
잠금 사고(lockout)와 권한 남용을 막는 아래 규칙이 핵심이다(`docs/HOST-ACCESS.md`).

- **commit-confirm**: `applyHostAccess` 는 런타임(`--permanent` 없음)에만 적용하고 `pending`(기한 1~30분)을 파일에 남긴다.
  기한 안에 `confirmHostAccess`(`--runtime-to-permanent`)가 없으면 **자동 `--reload`** 로 직전 영구 설정을 복원한다.
  기동 시 `resumeHostAccessPending` 이 기한을 이어받는다(index.js stagger). 이 타이머·복구를 없애면 잘못 적용한 규칙이
  영구히 남아 관리자가 잠긴다. 중간 명령 실패 시에도 즉시 `--reload`(반쯤 적용된 상태 금지).
- **자기 잠금 방지 검사는 서버(`render.planCommands`)가 강제**한다 — 웹 허용목록에 요청자 IP(`clientIp(req)`) 미포함,
  포탈 포트(`config.port`) 누락(정규화가 항상 포함), 존 target `ACCEPT`, 추가 규칙의 포탈 포트 전체 drop/reject 는 오류로
  실행을 막는다. 화면 검증만으로 대체하지 말 것. 웹 모드에는 '차단' 이 없다.
- **sshd 서비스 중지/재개는 확정 단계에서만**(`confirmHostAccess`) 실행한다 — 런타임 실험 중 SSH 세션을 끊지 않기 위해.
  포탈이 중지한 경우만 `applied.sshdStopped=true` 로 기록해 되돌릴 때 재시작한다(사람이 내린 sshd 는 건드리지 않음).
- **권한 경계**: 적용·확정은 `adminOnly + requireSettingsOwner + 본인 OTP(verifyUserOtp)`. OTP 미등록 계정은 403(needEnroll).
  되돌림은 OTP 없이(안전한 방향). 조회는 admin. 전부 `logAudit`.
- **실행 경계**: `exec.js` 는 셸 없이 spawn 하고 `sudo -n /usr/bin/firewall-cmd` 와 `sudo -n /usr/bin/systemctl
  {stop,start,disable,enable} sshd.service` 만 부른다(sudoers 줄과 인자가 정확히 같아야 한다 — `install.sh`
  `/etc/sudoers.d/vmware-portal-hostaccess`). 사용자 입력은 `normalizeSettings`(CIDR·포트 정규식)를 거친 값만 rich rule
  문자열에 들어간다. 자유 인자 실행 경로를 추가하지 말 것.
- **관리 대상 규칙만 건드린다**(`isManagedRich`): ssh 서비스/22/tcp/`service name="ssh"` rich rule, 웹 포트의
  `port port="P"` rich rule·`P/tcp`·http/https, 추가 규칙, 직전 적용분(`applied.rich`). 그 밖의 존 설정(다른 서비스·포트·
  인터페이스·다른 존)은 보존한다 — 전체 존을 '포탈 설정으로 교체' 하는 방식으로 바꾸지 말 것.

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
- **REST 수집기 TLS 검증 옵트인**(`storage/collectors/*`·`sanswitch/collectors/fosRest.js`, M-4): `STORAGE_TLS_VERIFY`/
  `SANSWITCH_TLS_VERIFY` 로 켤 수 있게 하되 기본은 자체서명 허용(기존 동작). 전역 디스패처로 바꾸지 말 것.
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
