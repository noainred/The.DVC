# 07. DoS·자원 고갈·원격 실행 표면 감사 (2026-09-12, 읽기 전용)

대상: `/home/claude/the.dvc/server/src`. 기준 문서: `server/CLAUDE.md`, 루트 `CLAUDE.md` 운영 환경 성능 규칙,
`docs/AUDIT-2026-08-17.md`, `security_check_20260809.MD`. 이미 수정 확인된 항목(예: 2026-08-09 L-3 XLSX 압축폭탄,
2026-08-17 #7 upgrade 소켓 파기, #8 WS 매핑 재검사)은 재보고하지 않고 '양호한 방어'에 회귀 없음으로 기록한다.
아래는 **코드에서 직접 확인한 항목만** 적었고, 확인하지 못한 부분은 '추정'으로 표시했다.

---

## 확정 발견 (심각도 순)

### F-1 [Medium-Low · CWE-770 · CWE-400] RDP WS 게이트웨이(guacd 터널)에 동시 세션 상한·유휴 타이머 없음 — SSH 게이트웨이와 비대칭

- **위치**: `server/src/proxy/guacdTunnel.js:69-100` (`handle()`), 비교: `server/src/proxy/sshGateway.js:73,83,99`
- **코드**:
  - SSH 측(`sshGateway.js:73`): `const MAX_SESSIONS = Number(process.env.REMOTE_MAX_SESSIONS) || 80;` + `:83` `bumpIdle()` 유휴 타이머 + `:99` `if (!counted && activeSessions >= MAX_SESSIONS)` 거부.
  - RDP 측(`guacdTunnel.js`): `grep activeSessions|MAX_SESSIONS|idle` → **0건**. `handle()`은 `mappingAccessIssue` → `consumeRdpTicket` → `net.connect(proxy.guacd.port || 4822, proxy.guacd.host)` 로 바로 guacd TCP 를 연다. 핸드셰이크 전 20초 타임아웃(`:98`)과 256KB 버퍼 상한(`:101`)만 있고, **ready 이후에는 상한·유휴 종료가 없다**(`:121` `guacd.setTimeout(0)`).
- **공격자 전제**: `remote.access` 권한을 가진 인증 사용자(operator 포함 가능 — 매트릭스 기본값은 미확인·추정) + RDP 매핑 1개(quick-connect 로 자기 소유 생성 가능).
- **PoC**:
  1. `POST /api/remote/rdp-ticket {username:'x'}` 를 N회 호출(전역 레이트리밋 1800/분 이내).
  2. 각 티켓으로 `wss://portal/api/remote/rdp?mappingId=<m>&ticket=<t>` WS 를 열고 유지.
  3. 세션당 (WS 소켓 + guacd TCP 소켓 + guacd 프로세스 측 RDP 세션) 이 무제한 누적 — SSH 는 80개에서 막히지만 RDP 는 1인이 수백~수천 개를 열 수 있어 guacd 호스트·포탈 FD 를 고갈시킨다.
- **수정안**: `sshGateway.js` 의 `activeSessions/MAX_SESSIONS` 를 공용 모듈(예: `proxy/sessionBudget.js`)로 빼서 SSH·RDP 가 같은 예산을 쓰고, RDP 도 `IDLE_MS` 유휴 종료를 붙인다. 추가로 사용자당 상한(예 8)을 두면 1인 독점을 막는다.

### F-2 [Low · CWE-770] `/remote/quick-connect` 매핑 개수 무제한 + `publicPort` 상한 없음 → 직렬 HAProxy 프로비저닝 큐·레지스트리 팽창

- **위치**: `server/src/routes/remote.js:208-233`, `server/src/proxy/registry.js:185-191` (`nextPublicPort`), `:200-225` (`addMapping`), `server/src/proxy/provision.js:17-22` (`serialize`).
- **코드**:
  - `registry.js:188-190`: `let p = base || 20000; while (used.has(p)) p++; return p;` — **65535 초과 검사 없음**, 매핑 총량/소유자당 상한 없음(`grep MAX_MAPPINGS` 0건).
  - `remote.js:221-223`: 같은 `targetHost` 라도 `targetPort` 가 다르면 새 매핑을 만들고 `await provision(r.mapping)` (SSH 배포면 `deployToProxy` 로 **그 프록시의 전 매핑을 재렌더 + reload**, `provision.js:35-38`).
  - `provision.js:17-22`: `_chain` 프로미스 체인 — 큐 길이 상한 없음.
- **공격자 전제**: `remote.access` 인증 사용자. 범위 계정도 범위 내 인벤토리 호스트 1개면 충분(`targetHostScopeIssue` 는 host 만 검사, port 는 자유).
- **PoC**: `for p in 1..3000: POST /api/remote/quick-connect {protocol:'ssh', targetHost:<범위내 VM IP>, targetPort:p}` → 매핑 3,000개 생성, 각 요청마다 프록시 SSH 배포/HAProxy reload 가 직렬 큐에 쌓여 정상 사용자의 원격접속 프로비저닝이 수십 분 지연. publicPort 는 20000→ 계속 증가하며 45,536개를 넘기면 65535 초과 포트가 HAProxy 설정에 들어가 **전체 reload 실패**(다른 사용자 매핑까지 비활성 — 추정: Data Plane/haproxy -c 가 거부). 매핑은 24h 뒤에나 만료(`proxy/expiry.js:10`).
- **수정안**: `addMapping` 에서 (a) 소유자당 활성 매핑 상한(예 20), 전체 상한(예 2,000), (b) `publicPort > 65535` 거부, (c) quick-connect 는 동일 사용자·동일 host 의 미사용(pending) 매핑을 재사용. 큐 길이 상한(예 50) 초과 시 429.

### F-3 [Low · CWE-770] RMA 하트비트 맵 `heartbeats` 무기한 누적(삭제 경로 없음) + 롱폴 대기자 무제한

- **위치**: `server/src/rma/jobs.js:35,285` (`heartbeats`), `:190-202` (`takeJobsWait` waiters), `server/src/routes/central.js:766-777` (`rma-poll`).
- **코드**:
  - `jobs.js:285`: `heartbeats.set(hbKey(a, inst), {...})` — `grep heartbeats.delete` **0건**, `prune()`(`:86-92`) 은 `jobs` 만 정리.
  - `central.js:766`: `instance` 는 본문 값(`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`) — 엣지가 임의로 정한다.
  - `jobs.js:196-199`: 대기자 `Set` 에 상한 없음, 각 대기자는 최대 55초 HTTP 연결 점유(`central.js:772`).
- **공격자 전제**: 엣지 개별 토큰 보유자(탈취된 `EDGE_TOKEN` 또는 악의적 현장 담당자). 준신뢰 경계라 심각도 Low.
- **PoC**: `POST /api/central/rma-poll {instance: <랜덤 64자>, wait: 0}` 를 1800/분으로 반복 → `heartbeats` 가 분당 1,800개씩 증가(항목당 policy 배열 최대 ~700 문자열). `listRmaAgents()`(UI 폴링)·`instancesOf()` 는 전체 순회 O(n) 이라 하루 뒤(~2.6M 항목) UI 응답이 초 단위로 느려진다. 동시에 `wait:55000` 으로 연결을 열어 두면 대기자 ~1,650개 × HTTP 연결이 유지된다.
- **수정안**: `prune()` 에서 `now - lastSeen > 24h`(또는 `HEARTBEAT_STALE_MS × N`) 항목 삭제, 법인당 인스턴스 상한(예 32) 초과 시 가장 오래된 것 축출. 롱폴은 법인당 동시 대기 상한(예 8) 초과 시 즉시 빈 응답.

### F-4 [Low · CWE-400] RDP 티켓 전역 상한(500) 도달 시 **타 사용자 티켓 축출** — 1인이 다른 사용자의 RDP 접속을 방해 가능

- **위치**: `server/src/proxy/rdpTicket.js:15,27-31`, `server/src/routes/remote.js:28-33`.
- **코드**: `const MAX_TICKETS = 500;` … `if (tickets.size >= MAX_TICKETS) { const oldest = [...].sort(...)[0]; tickets.delete(oldest[0]); }` — 사용자 구분 없이 가장 오래된 티켓을 지운다. 발급 라우트는 `requirePerm('remote.access')` 외 사용자당 상한 없음.
- **공격자 전제**: `remote.access` 인증 사용자.
- **PoC**: 60초 동안 `POST /api/remote/rdp-ticket` 를 600회 호출(레이트리밋 1800/분 이내) → 다른 사용자가 발급받아 아직 connect 하지 않은 티켓이 축출되어 WS 접속이 `RDP 접속 티켓이 필요합니다` 로 실패(재시도 루프와 경쟁). 또한 정렬 `O(n log n)` 이 매 발급마다 실행된다.
- **수정안**: 사용자당 미소비 티켓 상한(예 5, 초과 시 429) + 전역 상한 도달 시 축출 대신 거부. 티켓에 `owner` 를 넣어 `consumeRdpTicket` 이 발급자와 WS 사용자를 대조하면 안전성도 올라간다.

### F-5 [Low · 성능 불변조건 회귀] `alerts.js tick()` 폴러 재진입 가드 없음 (외부 알림 fetch 를 await)

- **위치**: `server/src/alerts.js:333-339` (`tick`), `:389-390,400` (`setInterval(() => tick()…)`, 최소 15초), `:228` (webhook `resilientFetch … timeoutMs: 15000, retries: 1`).
- **코드**: `async function tick() { const cfg = loadAlertConfig(); … await refreshState(cfg, true); }` — `puller.js:70`(`if (pulling) return`)·`metrics/sampler.js:28`·`vmclone/scheduler.js:19`·`bmstor/poller.js:132` 와 달리 진행 중 플래그가 없다.
- **영향**: `intervalSec` 를 15초로 두고 Slack/Teams/webhook 이 느리면(15s × 재시도 1 + 이메일) 틱이 겹쳐 같은 알림이 중복 전송되고 상태 갱신이 경쟁한다(루트 `CLAUDE.md` "새 폴러 추가 시 동일 가드 필수" 위반). 공격자 전제는 없음(구성 의존) — 가용성/정확성 문제.
- **수정안**: `let ticking=false; if (ticking) return; ticking=true; try{…} finally{ticking=false}` 패턴 적용(`bmstor/poller.js` 와 동일).

---

## 관찰(추정 — 취약점으로 확정하지 않음)

- **SSH 수집기 `signal` 미전달**: `bmstor/collect.js:72-80`·`gpu/sshCollect.js:73-75` 는 `withSsh` 에 `signal` 없이 `readyTimeout` 만 준다. 다만 `proxy/sshExec.js:86-97` 의 `exec()` 기본 60초 타임아웃이 스트림을 `kill()` 하고 `withSsh` 종료 시 세션이 닫히므로 "세션이 8분 남는" 유형은 아니다. bmstor 는 `running` 가드(`poller.js:25,82,132`)·동시성 4 로 상한이 있다. CLAUDE.md 의 `withDeadline` 패턴으로 통일하면 좋으나 실증된 누수는 아님(추정).
- **`/tools/rma/run`(`routes/api/rma.js:109`) 은 `adminOnly` 이며 OTP 재인증이 없다**. 자유 명령은 `allowCustom:true` 로 중앙에서 형식만 보고 엣지 `RMA_ALLOW_CUSTOM` 이 최종 게이트(설계 문서와 일치). admin 세션 탈취 시 엣지 opt-in 법인에는 즉시 원격 명령이 가능하므로, `hostaccess/apply` 처럼 `requireOwnOtp` 를 두는 것을 권고(정책 판단).
- **`GET /dl/versions.json`**(`routes/dlsource.js`, 공개·레이트리밋 제외): `readdirSync`+`statSync` 동기 호출이 요청마다 실행되지만 소스 디렉터리는 소수 파일이고 sha256 은 스트리밍+캐시(`shaCache`)라 이벤트 루프 영향은 작다. 캐시 TTL 여부는 미확인(추정).

---

## 확인된 양호한 방어 (파일 근거)

| 영역 | 근거 |
|---|---|
| 전역 레이트리밋 | `util/rateLimit.js:12-14,26-33` — IP 당 1800/분, 버킷 맵 `HARD_CAP=50_000` 정리, `index.js:129-133` 적용(헬스/정적/`/dl` 제외). `clientIp` 는 TRUST_PROXY 미설정 시 peer 주소 사용(XFF 스푸핑 방지). |
| 본문 크기 | `index.js:138-149` — 기본 `express.json({limit:'1mb'})`, 인벤토리/guest-disk/agent-config/svcmon import 만 16mb(`JSON_BODY_LIMIT`). |
| 서버 타임아웃 | `index.js:288-290` keepAlive 75s / headers 90s / request 600s. |
| 로그인 무차별 대입 | `routes/auth.js:47-66` `checkLoginAllowed`/`recordLoginFailure`(peer+계정 키, 429+Retry-After), OTP 잠금 `auth/auth.js:753`(`OTP_MAX_FAILS/OTP_LOCKOUT_MS`). |
| SSH WS 게이트웨이 | `proxy/sshGateway.js:47-49`(mustEnrollOtp·`userHasPermission('remote.access')`), `:73` `MAX_SESSIONS=80`, `:83` 유휴 종료, `:92` 재인증 우회 차단, `:97` `mappingAccessIssue` 재검사. |
| RDP 게이트웨이 부분 방어 | `guacdTunnel.js:61-63,73`(OTP 등록·권한·매핑 재검사), `:98` 접속 20s 타임아웃, `:101,137` 핸드셰이크 버퍼 256KB 상한, 자격증명은 1회용 티켓만(`:83-84`). |
| 미일치 upgrade 소켓 파기 | `index.js:303-307` catch-all `socket.destroy()` — 2026-08-17 #7 회귀 없음. |
| RDP 티켓 | `proxy/rdpTicket.js:14-21` TTL 60s·소비 시 삭제·만료 청소. |
| XLSX 압축폭탄(2026-08-09 L-3) | **수정 확인** — `routes/svcmon/transfer.js:116` `XLSX_MAX_BYTES` 디코딩 후 413, `svcmon/formats.js:81-95` `XLSX_MAX_ROWS=50_000`/`XLSX_MAX_COLS=200` 즉시 중단, CSV `parseCsvRows({maxRows:5000,maxCell:300})`(`:178`). |
| memoJson 캐시 유계 | `util/snapCache.js:20-31` 이름별 `MAX_PER_NAME`(기본 12, 최대 64) LRU — 쿼리스트링 변조로 무한 증가 불가. |
| 캡처/스캔/RMA 잡 큐 | `central/captureJobs.js:38-41` DONE/UNDONE TTL·`MAX_PENDING=20`·`MAX_CLAIMS=2`; `rma/jobs.js:86-92` prune + `MAX_CLAIMS=1`; `ipam/scan.js:114-121` `PING_MAX`(≤32) 슬롯; `ipam/scanStore.js:18` `MAX_MERGE=20_000`; `central.js:768` 결과 `slice(0,500)`. |
| SSH exec 상한 | `proxy/sshExec.js:86,101` 출력 4MB 상한 + `:87-97` exec 타임아웃 60s 스트림 kill + `signal` 지원(`:26-44`). |
| 프로브/매핑 host 검증 | `routes/remote.js:52,80` `SAFE_HOST` + `targetHostScopeIssue`(범위 계정 인벤토리 한정), `proxy/registry.js:206` `SAFE_TARGET_HOST`(quick-connect 도 addMapping 경유로 검증). HAProxy reload 직렬화 `provision.js:17-22`. |
| 백업 복원 | `routes/admin/backupNetSec.js:58` `adminOnly + requireSettingsOwner`, 업로드 없이 서버 보관본만; `backup/service.js:19-21,80,118` `ALLOW_EXT{.json,.env}`·`DENY_NAMES`·`path.basename`. |
| 게스트 계정 추가 | `backupNetSec.js:161` `adminOnly`; `gpu/guestops.js:376-397` 사용자명 화이트리스트(`USERRE`/Windows 20자), 비밀번호는 파일 경유 `chpasswd`(개행 거부), Windows 는 `"`·`%`·개행 거부. VM 이름은 명령에 들어가지 않음(moref 사용). |
| 게스트 로그 스캔 | `security/guestScanScheduler.js:64` `days` 1~90 클램프 후 `guestLoginScan.js:36` 삽입. |
| tcpdump 캡처 | `routes/admin/backupNetSec.js:101,132` `adminOnly`; `net/tcpdump.js:92-99,159-160` `PEERRE`/`IFRE` 검증 + `timeout` 래핑 + `execBudgetMs`. |
| 호스트 접근 제어 | `host-access/{apply,confirm}` = `adminOnly + requireSettingsOwner + requireOwnOtp`, revert 는 OTP 없이(안전 방향) — CLAUDE.md 와 일치. |
| RMA 중앙 라우트 | `routes/api/rma.js` 전부 `adminOnly`; `central.js:748-760` rma-poll 은 agent 모드 토큰 전용 + 법인별 허용 IP; 자격증명 브로커 분당 상한 `CRED_RATE_PER_MIN`(`central.js:805-806`). |
| 에이전트 배포/프로비저닝/복제 | `routes/admin/deployLlm.js:62-280` 전부 `adminOnly`; `routes/admin/opsSettings.js:158-175` provision 쓰기 `adminOnly`, `routes/api/provision.js:40` `canProvision`; `vmclone/scheduler.js:19` 재진입 가드. |
| VM 콘솔/재구성 | `routes/api/vmMetrics.js:103` `requirePerm('vm.console')`, `routes/admin/collectorsDc.js:299` `requirePerm('vm.reconfig')`(쓰기 scope 는 v2.389 문서화, 본 감사 범위 밖). |
| ReDoS | 요청 입력으로 `new RegExp` 를 만드는 곳 없음(`svcmon/templates.js:81` 상수 1건뿐). 검색·CSV·로그 파서는 고정 정규식만 사용. |
| 라우트 내 동기 FS | `readFileSync/readdirSync` 는 `routes/admin/nsxImport.js:81`(admin, 작은 JSON)·`routes/upgrade.js:103`(admin)·`routes/dlsource.js:63`(소수 파일) 뿐 — 대용량 동기 읽기 없음. |
| 폴러 재진입 가드 | `collector/puller.js:70`, `metrics/sampler.js:28`, `vmclone/scheduler.js:19`, `bmstor/poller.js:82,132`(수동 실행과 공유) 확인. |
| LLM 호출 | `llm/config.js:19` `LLM_TIMEOUT_MS` 30s, `llm/ollama.js:15,26` `resilientFetch` 타임아웃·재시도 1. |

---

## 권고 우선순위

1. F-1: RDP 터널에 SSH 와 같은 세션 예산·유휴 종료 적용(코드 10줄 내외, 즉시).
2. F-2: 매핑 상한·publicPort 65535 검사·큐 상한.
3. F-4: RDP 티켓 사용자당 상한 + 축출 대신 거부.
4. F-3: heartbeats 만료 정리·법인당 인스턴스/대기자 상한.
5. F-5: alerts tick 재진입 가드.
