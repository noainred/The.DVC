# 보안 점검 — 2026-08-08 (전역)

> **조치 경과 (v2.256.0 후속)** — M1·M2 후속을 완료했습니다.
> - **M1 IPAM 7종(해소)**: `buildIpamRows`·`buildSubnetSheets`·`listSubnets`·`buildIpamInsights`·`buildNetmap`
>   에 `allowed`(scope) 인자를 추가 — 캐시 키에 scope 서명, known/conflict 유니버스를 허용 vCenter 로
>   축소(conflictVcenters 유출 차단), 스캔·미귀속 수동 행은 범위 제한 계정에 미노출. `syncLedger`(외부 공유
>   `ipam.db`)는 무스코프 유지. **적대적 검증이 추가로 잡은 형제 2종**(`/tools/ipam/scan-report.csv`·
>   `/tools/ipam/history`)도 범위 제한 계정에 스캔 데이터를 노출하지 않게 게이트했습니다(ledger 차단과 일관).
> - **M2 gpu-guest-data(해소)**: 엣지 간 쓰기 소유권 — hostId/vmId 의 vCenter 를 `listInventory` **최장
>   프리픽스 매칭**으로 판정(콜론 포함 vc.id 오파싱 우회 방지), 소유 엣지가 아니면 그 항목 드롭. 조회(READ)
>   격리는 v2.255 에서 이미 완료(buildGpuInventory scopedVms) — 회귀 테스트만 보강. ⚠️ direct-mode
>   (중앙 직접 수집) vCenter 는 inventory owner 가 없어 TOFU 통과 — 완전 봉인은 `CENTRAL_REQUIRE_AGENT_TOKEN=true`(문서화된 잔여 한계).
> - **M3(핸드오프)**: `M3_UAGMON_HANDOFF.md` 로 소유 세션에 전달(이 세션은 `uagmon/` 미편집).
> - 회귀 테스트: `server/test/ipamScope.test.js`(8케이스). 2회 적대적 검증(각 라운드에서 형제 누락 추가 발견→보강).
>
> **조치 경과 (v2.255.0)** — M1·M2 를 수정했습니다(이 세션 코드). 1차 수정 후 적대적 검증
> 워크플로가 **부분 롤아웃 갭(형제 라우트 다수 미적용)** 을 찾아 2차로 전수 보강했습니다.
> - **M1 (해소·전수)**: 아래 조회 라우트에 `scopedVcenterIds` 교집합을 **요청 필터보다 먼저** 강제
>   (allowed=null=무제한 계정·인증OFF 는 기존 동작 보존): `/search/nl`·`/insights/chatops`(buildContext+
>   search 관통)·`/tools/deep-search`(요청 vcenterIds∩allowed, 공집합=빈결과, 스캔발견물 미노출)·
>   `/tools/vm-finder`(facets=scopeVms 파생)·`/tools/insights`·`/tools/capacity`·`/tools/waste`·
>   `/tools/threats`(scan/NSX-IDS 는 범위제한 계정 미노출)·`/tools/guest-os`(+`/vms`)는 scopeSlice+
>   **scopeKey(캐시 교차 차단)**; `/tools/vmtools`·`/tools/snapshots`·`/tools/duplicate-ips`·
>   `/tools/thin-vms`·`/tools/hardware`·`/tools/esxi`·`/tools/hba`·`/tools/licenses`·
>   `/tools/license-expiry`·`/tools/solutions`·`/tools/capacity-forecast`·`/tools/gpu`(+`.json`/`.csv`,
>   buildGpuInventory 가 hosts·vms 선필터)·`/tools/gpu/vms`·`/tools/ipam/vc-ranges` 는 선필터;
>   `/tools/esxi-temp/history`·`/tools/gpu/history` 는 key 의 vCenter 귀속 검사; `/summary`·`/overview`
>   는 memoJson 에 **extraKey(scopeKey) 추가**(1차 감사가 못 잡은 **캐시 교차로 타 사용자 요약 유출**
>   — 적대적 검증이 발견); 쓰기 라우트 `POST /vms/upgrade-tools` 는 범위 밖 VM 거부.
> - **M1 후속(문서화·미적용)**: `/tools/ipam`·`/ipam/insights`·`/ipam/subnets`·`/ipam/sheet`·
>   `/ipam/netmap`·`/ipam.xlsx`·`/ipam.csv` 7종은 빌더(`ipam/*.js`)가 `ipam.db` 원장(스냅샷 밖·
>   행별 vcenterId)을 읽어 스코프하려면 빌더 시그니처 변경이 필요 — 회귀 부담으로 분리(별도 커밋).
>   `ipam.db` 외부 리더 공유 불변조건 때문에 스키마는 불변, 조회 결과 필터만 추가할 것.
>   `/health`(집계 liveness)·`/tools/gpu/series-meta`(시계열 메타, 개별 vCenter 데이터 없음)는 의도적 비대상.
> - **M2 (agent 모드 위조 봉인)**: `/result`·`/fleet`·`/ip-scan-result`·`/inventory`·`/gpu-guest-data`·
>   **`/agent-config`**(적대적 검증이 추가 발견) 저장 키를 `req.centralAuth.agent`(개별 토큰 해석값)로
>   강제 — `?agent=자기 + body.agent=남` 우회 봉인. `/inventory` 는 **TOFU 소유권**(다른 엣지가 기존
>   vCenter 스냅샷 덮어쓰기 403). 공유 토큰은 하위호환 유지(완전 봉인은 `CENTRAL_REQUIRE_AGENT_TOKEN=true`).
>   **부분(후속)**: `/gpu-guest-data` 는 출처 agent 태깅(provenance)만 — 조회 경로의 엣지 간 hostId/vmId
>   격리는 store 리팩터 필요. 회귀 테스트: `server/test/securityScopeM1M2.test.js`(18케이스).
> - **M3 (미조치)**: UAGMon 코드로 **다른 세션 소유** — 그 세션에 전달 필요.

VMware Global Monitoring Portal(The Davinci Virtual Platform) **전역 보안 점검** 결과입니다.
직전 릴리스 **v2.248.0** 기준(브랜치 `claude/vmware-global-monitoring-portal-nrnpnt`).
직전 점검(성능점검 모듈 중심)을 대체·확장해 **인증·중앙/엣지·수집기·pyportal 허브·원격접속·
백업·설치·웹 클라이언트 + 다른 세션이 추가한 UAG 모니터/codex 코드**까지 코드베이스 전역을
대상으로 했습니다.

## 점검 방법

- 15개 서브에이전트 병렬 감사(조사 3 → 8개 보안 렌즈 심층 점검 → 발견별 독립 교차검증).
- **확인(confirmed)** = 코드 정독 또는 `$TMPDIR` 재현으로 검증. **추론** = 읽되 런타임 미재현.
  각 medium 이상은 별도 에이전트가 CONFIRMED/DOWNGRADE/REJECT 로 재판정했습니다.
- 심각도: **critical**=원격 무인증 자격증명 탈취/RCE · **high**=인증 우회·권한 상승·전체
  자격증명 유출 · **medium**=제한적 정보 노출·조건부 우회·가용성 · **low**=심층방어 약화 ·
  **info**=관측·권고.
- 파괴 방지(과거 이 리포지토리가 워크플로 도중 삭제된 사고 대비): 감사 에이전트는 **읽기
  전용**, 재현은 `$TMPDIR` 사본에서만 수행. 점검 전 git 번들 + 작업트리 스냅샷 백업 확보.

## 요약

| 심각도 | 건수 | 항목 |
|---|---|---|
| critical | 0 | — |
| high | 0 | — |
| medium | 3 | ① 사용자 scope 미강제(검색·구형 tools) ② 엣지 데이터 위조(소유권 경계 부재) ③ UAGMon 저장 자격증명 유출(SSRF+비번보존) |
| low | 13 | SSRF 동기가드, pyportal chmod 타이밍, 토큰 단일 비밀, 수집 pull 무상한, RDP 쿼리 폴백, /auth/config 경로노출, svcmon /state 비용, log/analyze 동시성, vm-finder fan-out, UAGMon 3건 등 |
| info | 5 | CSV 가드 불일치, ping `-` 허용, 번들 sha256(설계), CSP 미기본, UAGMon 클릭재킹 |
| 잘 된 방어 | 82 | 아래 요약 |

**원격 무인증 자격증명 탈취·RCE·인증 우회에 해당하는 critical/high 취약점은 발견되지
않았습니다.** 확인된 medium 3건은 모두 **인증된 계정을 전제로 한 정보 노출·데이터 무결성·
조건부 자격증명 유출**이며, ①③은 CLAUDE.md 불변조건의 적용 누락 경로, ②는 문서화된 한계를
넘어선 무결성 공백, ③은 다른 세션이 추가한 UAG 모니터 코드입니다.

---

## MEDIUM — 확인

### M1. 사용자 scope(가시 범위) 경계가 검색·구형 tools 조회 라우트에서 미강제 [확인·CWE-285/639]
**위치**: `server/src/routes/api.js:640`(`/search/nl`), `:1102`(`/tools/deep-search`),
`:1442`(`/tools/vm-finder`), `:452`(`/tools/vmtools`), `:473`(`/tools/snapshots`),
그 외 `/tools/insights`·`/tools/esxi-temp`·`/tools/ipam` 계열. 근원 `llm/nlSearch.js:106`,
`search/deepSearch.js:65`.
**내용**: CLAUDE.md 불변조건 *"사용자 scope는 조회 경로에서 강제(`scopedVcenterIds`), 요청
필터로 우회 불가, 새 인벤토리 조회 API도 동일 적용"* 을 위 라우트들이 지키지 않는다. 모두
`app.use('/api', authMiddleware, requireEnrolled, ...)` 뒤의 '로그인만' 라우트이고 서브라우터
레벨 `requirePerm`/`requireRole`·scope 교차가 **전무**하다.
- `/search/nl` → `nlSearch(query)` 를 `req.user` 없이 호출, `runQuery` 가 `store.get()`
  전체 스냅샷의 vms/hosts/datastores/networks **원본 객체를 슬림화 없이 반환**.
- `/tools/deep-search` → `vcenterIds` 를 생략/빈배열로 보내면 vCenter 필터가 스킵돼 전
  vCenter VM 반환(사용자 scope 미교차).
- `/tools/vm-finder` → `facets.vcenters` 가 전 vCenter id 까지 노출.
- 구형 `/tools/*` 집계 → `req.query.vcenterId` 로만 선택적 필터(코드 주석 `api.js:490` 도
  '기존 tools 집계엔 scope 강제가 없던 보강'이라 자인 — v2.217 은 `/tools/report/*` 만 적용).

**공격 시나리오(확인)**: 한 vCenter 만 보도록 scope 가 걸린 viewer/operator 가
`POST /api/search/nl {"query":"모든 vm"}` 또는 `POST /api/tools/deep-search {"vcenterIds":[]}`
를 호출 → **28개 전 vCenter 의 VM 이름·IP·게스트OS·게이트웨이·host/cluster·스냅샷명·Tools
버전을 수집.** scope 로 숨긴 타 법인/사이트 인벤토리 정찰이 가능하다. 자격증명·제어·쓰기는
아니고 인증된 scope 제한 계정이 전제라 **medium(정보노출형 인가 우회)**.
**대조군(정상)**: `/vms`·`/hosts`·`/datastores`·`/networks`·`/summary`·`/alarms` 는
`applyFilters(...,req.user)` 로 교차, 단건 `/vms/:id/*` 는 `inUserScope`→404, `/tools/report/*`
는 `scopeSlice` 적용. 즉 scope 는 실제 보안 경계로 시행 중이며 위 경로만 사각지대.
**권고**: 이 라우트들에 `scopedVcenterIds(req.user, snap)` 를 서버측 교차 적용 —
`/search/nl` 은 `nlSearch(query, req.user)` 로 allowed 선필터, `deep-search`·`vm-finder` 는
`body.vcenterIds` 를 allowed 와 교집합 강제(빈배열이면 allowed 전체, allowed=null 이면 무제한),
`facets.vcenters` 도 allowed 로 제한. 구형 `/tools/*` 는 `scopeSlice` 패턴 통일. 범위 밖
데이터를 못 받는지 회귀 테스트 추가.

### M2. 엣지 1대 침해로 전 사이트 모니터링 데이터 위조 가능 — 적재 라우트에 per-edge 소유권 경계 부재 [확인·CWE-345/639]
**위치**: `server/src/routes/central.js:101-122`(바인딩), `:170`(`/result`), `:270`(`/fleet`),
`:250`(`/inventory`), `:318`(`/gpu-guest-data`), `:437`(`/ip-scan-result`),
`gpu/store.js:10`, `central/inventory.js:67`.
**내용**: 바인딩 미들웨어는 `want = req.query.agent || X-Agent-Name || req.body.agent`(query
최우선)를 토큰의 agent 와 대조한다. 그러나 `body.agent` 를 **저장 키**로 쓰는 라우트는
`?agent=<자기이름>`(바인딩 통과) + `body.agent=<피해자>` 로 우회된다.
- **재현(확인)**: seoul 개별 토큰 + `?agent=seoul` + `{agent:'warsaw'}` → 바인딩 통과 후
  `setResult('warsaw')` 실행. 즉 자기 토큰으로 **남의 이름 데이터를 위조 기록**.
- `/inventory` 는 `body.vcenterId` 를 키로 쓰고 **agent↔vCenter 소유권을 어디서도 강제하지
  않는다** → 어떤 엣지든 `body.agent=자기이름` 만 맞추면 임의 vCenter 의 호스트/VM/알람
  스냅샷을 덮어쓸 수 있다. `/gpu-guest-data` 의 `setGuestGpu` 는 **agent 키조차 없이 전역
  오버레이**를 갱신.

**영향**: 28개 중 1대 엣지(또는 그 개별 토큰)만 확보하면 중앙 대시보드의 전 사이트 인벤토리·
전력·GPU·IP스캔 데이터를 위조·은폐할 수 있다(장애 은폐·허위 알람·인벤토리 블랭킹). **다만
기밀성 방어는 유효**: iDRAC/SSH 비번·passwordHash 를 돌려주는 조회 라우트(`/assignment`·
`/gpu-guest-config`·`/users-config`)는 조회 키가 `query.agent`(바인딩 최우선 소스)와 일치해
개별 토큰이 남의 자격증명을 읽지 못함을 재현으로 확인. 무결성/가용성 리스크라 **medium**.
**권고**: ① `body.agent` 를 저장 키로 쓰는 라우트를 `svcmon-report` 패턴으로 통일
(`mode==='agent'` 강제 + 저장 키를 `req.centralAuth.agent` 로만). ② `/inventory` 는
`(agent,vcenterId)` 매핑으로 담당 vCenter 만 갱신 허용(또는 최소한 push 출처 agent 저장·표시).
③ `/gpu-guest-data` 에 agent 키 부여. ④ 강화 시 `CENTRAL_REQUIRE_AGENT_TOKEN=true` 로 공유
토큰 경로 봉인.

### M3. UAGMon — 저장된 UAG 관리자 자격증명을 인증 사용자가 임의 외부 호스트로 유출 가능 [확인·PoC·CWE-918/522] (다른 세션 코드)
**위치**: `uagmon/lib/store.js:23`(normalizeTarget), `uagmon/lib/uag.js:25`(fetchUagStats),
`uagmon/lib/guard.js`(hostBlockReason).
**내용**: UAG 모니터 서버 모드는 세 조각이 결합해 '숨겨져 저장된' UAG 관리자 비밀번호가
공격자 서버로 전송된다(체인 전체 `$TMPDIR` PoC 로 확인):
1. `normalizeTarget` 은 PUT 수정 시 password 가 비면 **기존 비밀번호를 그대로 유지**
   (host 만 바꿔치기 가능).
2. `fetchUagStats` 는 `target.host` 로 `Authorization: Basic base64(user:pass)` 를 **최초
   GET 에 선제 전송**.
3. `hostBlockReason` 은 공개 호스트(evil.com·8.8.8.8·203.0.113.5)를 **ALLOWED**(PoC 확인 —
   루프백·169.254·10진·16진·::1 은 차단).

→ 인증 사용자가 기존 target 의 host 를 자신이 통제하는 공개 서버로 바꾸고 password 는 비워
저장한 뒤 `/api/targets/:id/test` 또는 `/api/poll-now` 호출 → `redact()` 로 API 에서 못 읽던
UAG 관리자 자격증명이 공격자 HTTPS 서버의 Basic-Auth 헤더로 캡처된다. 서버 모드는 단일 공유
비밀번호라 '전체 유출(high)'은 아니고 인증 필요·정상 기능 악용이라 **medium**. 데스크톱
(127.0.0.1) 모드는 단일 로컬 사용자라 해당 없음.
**권고**: ① host 변경 수정에서 비밀번호 재입력 요구(또는 host 변경 시 저장 password 무효화).
② 연결 **직전** 해석된 IP 기준 SSRF 재검증(포탈 `ssrfBlockReasonResolved` 동형). ③ 모니터링
대상이 사내로 한정되면 RFC1918 + 사내 DNS 화이트리스트로 제한.
**주의**: 이 코드는 **다른 세션이 추가**한 것으로, 본 점검에 포함은 했으나 수정은 그 세션
소유입니다. 위 M3·아래 UAGMon low 3건을 그 세션에 전달 권장.

---

## LOW (13)

1. **svcmon http/soap 점검이 동기 SSRF 가드만 사용** (`svcmon/checker.js:59`, `store.js:165`)
   — 동기 `ssrfBlockReason` 은 IP 리터럴만 검사, DNS 이름은 통과. 같은 코드베이스의
   `relayProbe/horizon/certMonitor` 는 async `ssrfBlockReasonResolved` 사용. operator 권한
   블라인드 SSRF 오라클. → checker/validateTestEndpoints 를 resolved 로 일원화.
2. **pyportal 원자적 쓰기가 chmod 0600 을 rename 이후 수행** (`pyportal/hub/jsonfile.py:53-81`)
   — tmp·rename 직후 최종 파일이 잠깐 0644. 세션 서명키·비번 해시가 그 창에서 그룹/other
   읽기 가능. → tmp 를 `os.open(...,0o600)` 로 생성(권한을 rename 전에 확정).
3. **기본 구성에서 CENTRAL/COLLECTOR 토큰이 같은 EDGE_TOKEN** (`config.js:36,145,186`) — 단일
   비밀 유출 시 pull + central 쓰기 + `/collector/upgrade` 번들 푸시(RCE)가 함대 전역으로 열림.
   → 엣지별 상이 토큰 강제, 이관 완료 사이트 `CENTRAL_REQUIRE_AGENT_TOKEN=true`, 업그레이드용
   토큰 분리 검토.
4. **수집기 pull 응답에 크기 상한 없음** (`collector/puller.js:22-61`) — 침해/오작동 수집기가
   수 GB JSON 으로 중앙 OOM 유발. → 누적 바이트·배열 length cap(`/inventory` 의 `arr(x,n)` 패턴).
5. **RDP 티켓 발급 실패 시 자격증명 쿼리스트링 폴백** (`web/src/remote/RemoteConsole.jsx:169`)
   — 정상은 1회용 티켓(쿼리엔 ID만)이나, 발급 예외 시 `username/password/domain` 을 WS
   쿼리스트링으로 조립 전송 → CLAUDE.md 'RDP 쿼리 미노출' 불변조건 우회 경로. → 폴백 제거하고
   재시도 오류 처리(SSH 처럼 WS 본문 auth 메시지 사용).
6. **미인증 /api/auth/config 가 초기 관리자 비번 파일 절대경로 노출** (`routes/auth.js:23`,
   `web/src/views/Login.jsx:24`) — 로그인 전 `initialPasswordFile` 경로 + `sudo cat` 안내
   노출(서버 구조·'초기 비번 유효' 단서). → 경로를 미인증 응답에서 제거(인증 후 or 소유자만).
7. **svcmon `/state` 요청당 전체 deep-copy + edgeSummary 2회 동기 계산** (`routes/svcmon.js:57`,
   `central/svcmonEdge.js:295`) — viewer 가 호출, `edgeTotals` 내부가 `edgeSummary` 를 재실행
   (요청당 2회). 대규모 배포에서 이벤트 루프 부하. *(medium 제기 → 검증에서 low 로 하향:
   OTP 등록 계정 필요·IP별 30req/s 상한·규모 의존)*. → `edgeSummary` 1회 계산 후 재사용,
   요약 짧은 캐시, `listTargets()` 무복사 요약.
8. **/svcmon/log/analyze 동시 실행 상한 부재** (`routes/svcmon.js:811`, `loganalyze.js:344`) —
   요청당 예산은 있으나 병렬 요청 수 무제한 → operator 다수 동시 요청이 CPU·I/O·FD 잠식.
   → in-flight 세마포어(동시 1~2, 초과 429).
9. **/tools/vm-finder?withAvg 가 viewer 요청으로 vCenter 메트릭 fan-out** (`api.js:1442`) —
   요청당 유계지만 반복 시 고RTT vCenter 로 증폭. → operator 제한 또는 캐시/쿨다운.
10. **UAGMon SSRF 가드가 DNS 미해석**(`uagmon/lib/guard.js:6`) — 이름기반/rebinding 우회.
    (다른 세션) → 연결 직전 해석 IP 재검사.
11. **UAGMon 접속 비번이 무솔트 단일 SHA-256**(`uagmon/lib/auth.js:17`) — 파일 유출 시 대사전
    공격 저렴. (다른 세션) → scrypt/argon2id.
12. **UAGMon loopback 모드 CSRF 방어 부재**(`uagmon/server.js:119-131`) — 상태변경에
    Origin/Sec-Fetch-Site 검사 없음(로컬·PNA 로 완화). (다른 세션) → pyportal `_cross_site` 동형.
13. **UAGMon 접속 비번 무솔트 저장·UAG 비번 평문 병존**(`uagmon/lib/store.js:25`) (다른 세션,
    11과 동일 파일 계열) → KDF + 평문 자격증명 대칭암호화 검토.

## INFO (5)

- **CSV 수식가드 불일치**(`svcmon/csvlog.js:57`) — 결과 로그 라이터만 TAB/CR 접두사 누락
  (공유 `util/csv.js guardCell`·pyportal 은 포함). → `guardCell` 로 일원화.
- **ping 호스트 화이트리스트가 선행 `-` 허용**(`util/ping.js:54`) — `execFile` 은 셸 미경유라
  실익 없음(심층방어). → traceroute 처럼 `!startsWith('-')` 추가.
- **엣지 수신측 업그레이드 번들 sha256 미검증**(`collector/upgrade.js:237`) — 설계상 토큰+TLS
  신뢰 채널(서명키 없는 구조에선 수신측 sha256 대조가 무의미). 조치 불필요, 향후 서명 도입 시
  근본 차단.
- **CSP 기본 미적용 + Bearer 토큰 localStorage**(`web/src/api.js:11`, `index.js:95`) — 현재
  클라이언트에 XSS 싱크(innerHTML/dangerouslySetInnerHTML/eval) **전무**해 실경로 없음. 운영
  배포에서 `CSP` env 설정 권장.
- **UAGMon 클릭재킹**(`uagmon/server.js:106`) — CSP `frame-ancestors`/X-Frame-Options 부재.
  (다른 세션) → `frame-ancestors 'none'`.

---

## 잘 지켜지고 있는 방어 (82건 중 핵심)

- **토큰 검증 단일화**: `resolveTokenUser` 하나로 서명/만료 + `tokenVersion` 폐기 대조 +
  role/scope/`mustEnrollOtp` 를 **매 요청 사용자 레코드에서 재계산**(우회·지연 반영 차단).
- **WS SSH/RDP 게이트웨이**가 Express 미들웨어를 안 타는 점을 인지하고 핸들러 내부에서
  `resolveTokenUser` + `mustEnrollOtp` + `userHasPermission('remote.access')` 를 직접 검사.
- **RDP 자격증명 1회용 티켓**(60s TTL·인메모리·consume 즉시 삭제) — 쿼리스트링 미노출(정상 경로).
- **central 개별 토큰↔agent 바인딩** + `svcmon-report/config/config-ack` 의 `mode!=='agent'`
  거부 → 공유 CENTRAL_TOKEN 로 엣지 데이터 위조 불가(M2 는 그 규약이 커버 못하는 별개 경로).
- **collector 인증이 256MB raw 버퍼링 '앞'에서 상수시간 토큰 비교**(DoS 증폭 방지, 토큰은
  길이만 로그).
- **OTP 전용 정책**: `confirmTotpEnroll` 이 passwordHash 삭제 + tokenVersion 인상 +
  `initial-admin-password.txt` 제거.
- **미인증 응답 계정 열거 차단**: `/api/auth/config` 에 settingsOwners 계정명 미포함(소유자
  판단은 인증 후 `/auth/me` 불리언).
- **단건 라우트 scope**: `/vms/:id/console·metrics`·`/hosts/:id/metrics` 가 범위 밖일 때
  403 아닌 **404** 로 존재 여부까지 은닉.
- **상태변경 RBAC 일관**: `/api` mutating 라우트 전부 `requirePerm`/`requireRole` 보유.
- **SSRF 가드(코어)**: `collector/registry.js` 가 호스트를 실제 IP 값으로 정규화 후 대역 비교
  (10진·8진·16진·축약·IPv4-mapped 우회 차단), RFC1918 사내망 허용, 이름기반은 async
  `ssrfBlockReasonResolved` 로 DNS 해석까지 검사.
- **원자적 쓰기 + 손상 보존 쌍**: svcmon 신규 저장소 4종 + 코어 자격증명 파일이
  `atomicWriteFileSync` + `preserveCorrupt`(파싱 실패·형식 불일치 모두 `.corrupt.<ts>` 보존).
- **codexCheck 리포트**: API·웹 탭 모두 admin 전용, 파일명 고정 포맷(사용자 입력 없음).
- **UAGMon(다른 세션)**: 루프백 외 바인딩은 비밀번호 없으면 기동 거부, Bearer 전용(쿠키
  미사용→CSRF 표면 없음), 로그인 실패 IP별 잠금 + timingSafeEqual.

---

## 조치 우선순위 (권고)

| 순위 | 항목 | 소유 |
|---|---|---|
| 1 | **M1** 검색·구형 tools 라우트에 scope 교차(정보 격리 경계 복원) | 이 세션 코드(수정 가능) |
| 2 | **M2** central 적재 라우트 소유권 경계(`body.agent`→`centralAuth.agent`, `/inventory` agent↔vcenter) | 코어(수정 가능) |
| 3 | **M3 + UAGMon low 4건** host 변경 시 비번 무효화·연결직전 SSRF 재검증·KDF·CSRF | **다른 세션 소유 — 전달** |
| 4 | LOW 1·2·5·6(SSRF 일원화·chmod 타이밍·RDP 폴백·경로 노출) | 코어(수정 가능) |
| 5 | LOW 3·4·8·9(토큰 분리·pull 상한·analyze 동시성·fan-out) + INFO | 운영/후속 |

## 결론

전역 점검에서도 **critical/high 는 없습니다.** 최근 대규모 기능 추가(성능점검 CSV·템플릿·
대량등록·엣지 위임·로그 분석)에도 코어 불변조건(토큰 단일화·중앙 바인딩·SSRF 정규화·원자적
쓰기+손상보존·WS 게이트웨이 직접 검사·RDP 티켓·404 은닉)이 유지됨을 82개 방어로 확인했습니다.
실질 리스크는 **① 문서화된 scope 경계의 적용 누락(M1)** 과 **② 엣지 적재 무결성 경계 공백(M2)**,
그리고 **③ 다른 세션이 추가한 UAG 모니터의 자격증명 유출(M3)** 입니다. ①②는 이 세션에서
수정 가능하고, ③ 및 UAGMon 계열은 소유 세션에 전달이 필요합니다.

> 본 점검은 정적 분석 + 부분 `$TMPDIR` 재현입니다. 운영 반영 전 M2 의 위조 재현과 M1 의
> scope 우회를 스테이징에서 재현·회귀 테스트로 고정할 것을 권합니다.
