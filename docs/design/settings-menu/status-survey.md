# 설정 메뉴 51항목 — 미설정·주의 판정 출처 조사 (읽기 전용, 2026-11-06)

경로 표기: 서버는 `server/src/` 기준, 웹은 `web/src/views/` 기준. 웹의 `fetchJson('/x')` 는 `/api/x` 다.
모든 `*.json` 설정 파일은 `config.configDir` 아래(각 모듈의 `FILE = path.join(config.configDir, '…')`).
"비용" 열: **파일** = JSON 1개 읽기(대부분 모듈 내부 캐시가 있어 실제로는 메모리) · **메모리** = 폴러/모듈 상태 변수 · **SQLite** = DB 한 문장 · **외부 호출 필요 → 제외**.
`추정` 표시가 없는 것은 파일:라인을 확인한 것이다.

## 1. 항목별 표

| # | k · 라벨 | 화면 첫 로드 GET | 서버 라우트(파일:라인) → 데이터 모듈(파일:라인) · 저장 형태 | '미설정' 판정 후보 | 이미 계산되는 '주의' 값 | 비용 |
|---|---|---|---|---|---|---|
| 1 | `datacenter-admin` DataCenter(법인) | `/admin/datacenters`, `/admin/vcenters` | `routes/admin/collectorsDc.js:342` → `datacenter/store.js:69 listDatacenters()` · `datacenters.json`(`datacenter/store.js:18`) | 법인 0건 | — | 파일 |
| 2 | `vcenter-admin` vCenter 등록·관리 | `/admin/vcenters` | `routes/admin/vcenters.js:47` → `vcenter/registry.js:51 listRegistry()` · `vcenters.json`(`:24`) | 등록 vCenter 0건 | 인증 실패로 수집 정지된 vCenter 수: `vcenters.js:50-55` 가 행마다 `vcAuthGuard.authStopFor(v)`(`vcenter/restClient.js:22`, 상태 파일 `vcenter-auth-stops.json`) → `authStopped` 를 싣는다. 집계는 `loadVcenterConfig()`(`config.js:465`) 목록을 돌며 `authStopFor` 를 세면 된다(⚠ `authStopFor` 는 자격이 바뀐 기록을 **지운다** — `util/authGuard.js:163·176` 주석; 집계는 지우지 않는 `peekAuthStop`(`:176-184`) 을 쓸 것) | 파일 2개(등록부 + stops) |
| 3 | `vcenter-test` vCenter 연결 테스트 | `/admin/vcenters` | 같음(`vcenters.js:47`) · 테스트 자체는 `POST …/relay-test` | 해당 없음(동작 화면) — 굳이 하면 #2 와 같은 '등록 0건' | — | (#2 와 중복) |
| 4 | `nsx-admin` NSX 관리 | `/admin/nsx/managers`, `/remote/proxies` | `routes/admin/nsxImport.js:57` → `nsx/registry.js:48 listRegistry()` · `nsx.json`(`:19`) | 등록 매니저 0건 (⚠ NSX 는 선택 기능이라 '미설정' 배지가 자연스럽지 않을 수 있음 — '정보' 수준으로 추정) | 인증 정지 수: `nsxImport.js:60-64` `nsxAuthGuard.authStopFor`(`nsx/client.js:42`, `nsx-auth-stops.json`) | 파일 2개 |
| 5 | `horizon-admin` Horizon 연결 서버 | `/admin/horizon` | `routes/admin/horizonAssign.js:21` → `horizon/horizon.js:69 listHorizon()` · `horizon.json`(`:28`) | 등록 서버 0건(선택 기능 — NSX 와 같은 등급) | 인증 정지는 `horizon/sessionPoller.js:59` authGuard(`horizon-auth-stops.json`) 에 있으나 GET 응답엔 안 실림(집계 시 `peekAuthStop` 으로 셀 수 있음) | 파일 |
| 6 | `idrac-admin` iDRAC 서버 등록 | `/admin/idrac`, `/admin/idrac/scan-ranges`, `/admin/idrac/scan-jobs` | `routes/admin/idracCore.js:164` → `idrac/registry.js:140 listRegistry()` · `idrac.json`(`:41`); 원격(엣지) 행은 `insights/analysisServers.js remoteServersResolved`(메모리) | 중앙 등록 0건 **이고** 원격 행도 0건(엣지 위임 환경에서 중앙 등록 0 은 정상 — CLAUDE.md `findRemoteServer` 규칙) | 인증 정지 수: `idrac/poller.js:70 idracAuthStops()` → Map(크기가 곧 개수) | 파일 + 메모리 |
| 7 | `idrac-scan-log` iDRAC 스캔 로그 | `/admin/idrac/scan-log`(30초 폴링), `/admin/datacenters` | `routes/admin/idracScan.js:460` · 스캔 잡은 `central/idracScanJobs.js:28 const jobs = new Map()`(메모리) | 해당 없음(조회 전용) | — | — |
| 8 | `veeam` Veeam 백업 서버 | `/admin/veeam/servers`, `/admin/veeam/vc-accounts` | `routes/admin/veeam.js:93` → `veeam/registry.js:69 listServers()` · `veeam-servers.json`(`:24`) | 등록 서버 0건(선택 기능) | `registryLoadError()`(`veeam.js:94`) 비null = 등록부 못 읽음(주의) · 인증 정지 `veeam/poller.js:24 authGuard`(`veeam-auth-stops.json`) | 파일 |
| 9 | `bareos` Bareos 백업 서버 | `/tools/bareos-backup` | `routes/api/bareosBackup.js:422`(memoJson) → `bareosListView :452` → `bareos/settings.js:101 loadSettings()` · `bareos.json`(`:39`), 모양 `{directors[], sites[]}`(`:7-11`) | `directors.length === 0`(또는 `sites` 0건) | `settingsLoadError()`(`bareos/settings.js:152`) · `directorIssue(d)`(`:213`) 가 Director 레코드 결함 판정 | 파일 |
| 10 | `backup` 포탈 백업 | `/admin/backup/status` | `routes/admin/backupNetSec.js:166` → `backup/settings.js:137 backupStatus()`(settings + lastRun/lastSkip 메모리) · `backup.json`(`:16`), `DEFAULTS.scheduleEnabled:false`(`:20-26`); 백업 목록 `backup/service.js:372 listBackups()`(디렉터리 `backups/` 스캔 `:37`) | `scheduleEnabled === false` → '정기 백업 꺼짐' | `lastRun` 실패 여부(메모리 — 모양은 `backup/settings.js` lastRun 정의 확인 필요, 추정) | 파일 + 메모리 (listBackups 는 디렉터리 readdir — 집계에서 생략 권장) |
| 11 | `nfs-mounts` NFS 마운트(백업 대상) | `/admin/nfs-mounts` | `routes/admin/nfsMounts.js:18` → `system/nfsMounts.js:65 listMounts()` · `nfs-mounts.json`(`:27`) | 해당 없음(선택 기능 — 마운트 0건을 미설정으로 보기 어려움) | — | 파일 |
| 12 | `metrics` 지표 수집 | `/admin/metrics/settings`, `/tools/waste/settings` | `routes/admin/gpuGuest.js:140` → `metrics/settings.js:37 loadMetricsSettings()` · `metrics.json`(`:14`, 없으면 `config.temp` 기본값 `:40`); 상태 `metrics/sampler.js:525 metricsSamplerStatus()`(메모리) | 해당 없음(기본값으로 항상 동작) | 샘플러 상태(`metricsSamplerStatus` — 마지막 실행·오류, 모양 미확인) | 파일 + 메모리 |
| 13 | `storage-intervals` 스토리지 수집 주기 | `/tools/storage/intervals` | `routes/api/storageMon.js:295` → `storage/intervals.js:183 loadIntervalConfig()` · `storage-intervals.json`(`:149`) | 해당 없음(기본값 동작) | `_loadErr`(`storage/intervals.js:158 makeSettingsLoadError`) 파일 손상 | 파일 |
| 14 | `power-off-check` 전원 꺼짐 점검 | `/tools/waste/off-check` | `routes/api/toolsCapacity.js:664` → `tools/powerOffPoller.js:20 powerOffPollerStatus()` → `tools/powerOffSettings.js:12-14`(`power-off-check.json`, `DEFAULTS.enabled:true`) | `enabled === false` 는 사용자가 끈 것 — 미설정 아님. 해당 없음 | `lastResult.ok === false`(메모리 `powerOffPoller.js:17`) | 파일 + 메모리 |
| 15 | `vmseries` VM 실시간 스파이크 수집 | `/tools/vmseries/settings`, `/tools/vmseries/scope-data` | `routes/api/vmSeries.js:158` → `vmseries/settings.js:89 loadVmSeriesSettings()` · `vmseries.json`(`:25`), **기본 꺼짐(opt-in)**(`:5`, `:92` env) | `enabled === false` → '꺼짐(선택)' 정보 배지 정도. 미설정으로 단정 금지(의도된 opt-in) | `_loadErr`(`:35`) | 파일 |
| 16 | `sansw-perf` SAN 스위치 포트 사용량 | `/tools/sanswitch/perf/settings` | `routes/api/sanSwitch.js:427` → `sanswitch/perfSettings.js:58 loadPerfSettings()` · `sanswitch-perf-settings.json`(`:19`), `enabled` 기본 false(`:78`) | 같은 opt-in — 해당 없음(또는 '꺼짐' 정보) | `_loadErr`(`:54`) · 폴러 상태 `sanSwitchPerfStatus()` 메모리 | 파일 (⚠ 라우트의 `perfDbStats()` 는 SQLite — 집계에서 제외) |
| 17 | `isilon-dirusage` 아이실론 디렉터리 사용량 (superOnly) | `/tools/isilon-dirusage` | `routes/api/isilonDirUsage.js:118` → `isidu/settings.js loadSettings`(`DEFAULTS.targets:[]` `:60`) · `isidu-settings.json`(`:40`) | `targets.length === 0`(선택 기능 — 정보 등급) | `isiduSettingsLoadError()`(`:109`) · `storageRegistryLoadError()` | 파일 (⚠ 라우트의 `targetRows()`·`ensureIsiduDemo` 는 무거움 — 집계는 `loadSettings()` 만) |
| 18 | `guest-partition` 게스트 파티션 사용률 | `/tools/guest-partition/settings`, `/tools/guest-partition`, `…/mail` | `routes/api/toolsGuestPart.js:87` → `guestpart/settings.js`(`guest-partition.json` `:23`) + `guestdisk/settings.js:18-19`(`enabled` 기본 false) | `collect.enabled === false` → opt-in 꺼짐(정보) | `settingsLoadError()`(`toolsGuestPart.js:92`) | 파일 2개 |
| 19 | `dir-usage` 폴더 사용량 리포트 | `/admin/dir-usage` | `routes/admin/dirUsage.js:30` → `dirusage/settings.js:36-38`(`DEFAULTS.enabled:false, targets:[]`) · `dirusage.json`(`:24`) | `targets.length === 0`(선택 기능) | `dbStatus`·`schedulerStatus`(`dirUsage.js:13-14`, 모양 미확인) | 파일 (⚠ 라우트의 `getDb().latestAll()` 은 SQLite — 제외) |
| 20 | `gpu-collect` GPU 수집 | `/admin/metrics/settings` | #12 와 같음 — `gpuUtilEnabled`(`metrics/settings.js:17`, 기본 true `:40`) | 해당 없음 | — | (#12 중복) |
| 21 | `gpu-guest` GPU 게스트 수집 | `/admin/vcenters`, `/admin/gpu-guest/deploy/agents` | `routes/admin/gpuGuest.js:260` → `gpu/settings.js:43 loadGpuGuestSettings()` · `gpu-guest.json`(`:16`), `DEFAULTS.enabled:false`(`:19`) | `enabled === false`(opt-in — 정보) | 인증 정지 `gpu/sshCollect.js:28 gpuAuthGuard` | 파일 |
| 22 | `gpu-guest-diag` GPU 수집 진단 | `/admin/gpu-guest/diag`, `/vcenters` | `routes/admin/gpuGuest.js:219` → `getGpuGuestDiag()`·`central/gpuGuestDiag.js getAllGpuGuestDiag()`(메모리) | 해당 없음(조회 전용) | — | 메모리 |
| 23 | `guest-account` 게스트 계정 추가 | `/vms` | 조회는 인벤토리 스냅샷(`store`) · 동작은 `POST /admin/guest/add-user` | 해당 없음(동작 화면) | — | — |
| 24 | `collectors` 수집 서버(원격) | `/admin/collectors`, `/admin/central/ingest-stats`, `/admin/central/agent-tokens`, `/health`, `/admin/datacenters` | `routes/admin/collectorsDc.js:138` → `collector/registry.js:127 listCollectors()` · `collectors.json`(`:22`); 상태 `collector/state.js:129 allCollectorStatus()`(메모리) | 등록 수집 서버 0건(⚠ 엣지 없이 중앙 직접 수집만 하는 설치도 정상 — '정보' 등급으로 추정) | `registryLoadErrorSummary()`(`collector/registry.js:78`) · `allCollectorStatus()[id].ok === false` 인 엣지 수 · `edgeSync`(구버전 엣지 — `upgrade/manager.js` edgeSync.status()) | 파일 + 메모리 |
| 25 | `agent-deploy` Edge 노드 포탈 설치 | `/admin/agent-deploy/installer`, `/admin/packages`, `/admin/agent-deploy/targets`, `/admin/central-token`, `/admin/agent-deploy/defaults`, `/admin/vcenters` | `routes/admin/deployLlm.js:101` → `agent/deployRegistry.js:58 listTargets()` · `agent-deploy-targets.json`(`:16`) | 해당 없음(배포 작업 화면 — 대상 0건이 미설정은 아님) | — | 파일 |
| 26 | `proxy` 중계 서버 | `/remote/config`, `/remote/proxies/full` | `routes/remote.js:168` → `proxy/registry.js:93 getConfigSafe()` · `remote-access.json`(`:32`), `proxyHost` 기본 `PROXY_PUBLIC_HOST || ''`(`:56`) | `proxyHost` 비어 있음 **그리고** 추가 프록시 0건(`listProxies :243`) — 원격접속 기능을 쓰지 않는 설치도 있으니 '정보' 등급 추정 | — | 파일 |
| 27 | `remote` 원격접속 설정 | `/remote/mappings`, `/remote/config`, `/remote/proxies/full`, `/remote/targets` | `routes/remote.js:52` → `proxy/registry.js:323 listMappings()` · 같은 파일 | #26 과 같은 출처 — 매핑 0건은 미설정 아님. 해당 없음 | — | (#26 중복) |
| 28 | `users` 메인포탈 사용자 관리 | `/admin/users`, `/admin/permissions`, `/vcenters` | `routes/admin/users.js:92` → `auth/auth.js:489 listUsers()`(`:178 loadUsers()` — users.json 추정, 경로 미확인) | 해당 없음(관리자 1명은 항상 있음) | 보안 자가진단이 이미 계산: 미등록(OTP 없음) 고권한 계정 `security/selfCheck.js:102-107`(`enrolled < privileged → warn`) — #36 에서 가져다 쓰면 됨 | 파일 |
| 29 | `edge-users` 엣지 사용자 배포 | `/admin/edge-users/agents`, `/admin/edge-users/<agent>` | `routes/admin/gpuGuest.js:293` → `listAgentUserAgents()` + `listCollectors()` | 해당 없음(선택 동작) | — | 파일 |
| 30 | `auth-ad` 인증(AD) | `/auth/ad-config` | `routes/auth.js:361` → `auth/ad.js:72 loadAdConfig()` · `auth.json`(`:23`), 기본 `AD_ENABLED/AD_URL` env(`:25-27`) | `!(ad.enabled && ad.url)` → 'AD 미사용'(선택 — 로컬 계정만 쓰는 설치가 정상이므로 정보 등급) | **`adTransportStatus(ad).warnings`**(`auth/ad.js:133-139`): `plain-ldap`·`tls-verify-off`·`ca-invalid` → 주의 | 파일 |
| 31 | `feature-usage` 기능 사용 현황 | `/admin/usage/report`, `/admin/usage/settings` | `routes/admin/usage.js:37`(gate `[adminOnly, requireSettingsOwner]` `:23`) → `usage/settings.js:109 loadUsageSettings()` · `usage-settings.json`(`:25`) | 해당 없음(기본 enabled:true `:28`) | `usageSettingsLoadError()`(`:119-122` — 못 읽으면 enabled:false 로 강제) | 파일 (⚠ `buildUsageReport` 는 SQLite 집계 — 제외) |
| 32 | `session-security` 세션 보안 | `/admin/security/session` | `routes/admin/opsSettings.js:217` → `security/securitySettings.js:60 loadConfiguredSecurity()` · `security-session.json`(`:13`) + `settings-owners.txt`(`:16`); `DEFAULTS.settingsOwners:['noainred']`(`:18`) | 파일 없음(=기본값 그대로, 소유자가 하드코딩 기본 1명) → '미설정' 후보. `ownerWarnings`(`opsSettings.js:219` scopedOwnerWarnings — 범위 계정이 소유자) → 주의 | `ownerWarnings` | 파일 |
| 33 | `secrets` 자격증명 저장 방식 | `/admin/secrets/policy` | `routes/admin/opsSettings.js:188` → `security/secretVault.js:202 loadSecretsPolicy()` · `secrets-policy.json`(`:47`), mode 기본 `'plain'`(`:120-124`) | `mode === 'plain'` → '평문 저장(보호 미적용)' — 자가진단도 warn 으로 분류(`selfCheck.js:91-94`) | 정책 못 읽어 잠긴 상태 risk / 신뢰 사본 복구 warn(`selfCheck.js:273`) | 파일 |
| 34 | `api-keys` 연동 키 | `/admin/api-keys`, `/vcenters` | `routes/admin/apiKeys.js:34` → `publicapi/keys.js:221 listApiKeys()` · `api-keys.json`(`:35`) | 해당 없음(외부 연동 없는 설치가 정상) | 만료 없는 키(`expiresAt` null — 화면이 경고, `keys.js:23`) 수 · 만료 지난 키 수 | 파일 |
| 35 | `anomaly` 이상동작 탐지 | `/admin/anomaly`, `/admin/vcenters` | `routes/admin/opsSettings.js:165` → `alerts.js:307 getAnomalySettings()` · `alerts.json`(`:33`) | 해당 없음(기본값 동작 — 모양 미확인) | — | 파일 |
| 36 | `host-access` 호스트 접근 제어 | `/admin/host-access` | `routes/admin/hostAccess.js:38` → `hostAccessStatus()`(**OS 방화벽 상태를 읽는 async — 외부(OS) 호출 가능성 → 집계 제외**) · 설정은 `hostaccess/settings.js:15 loadHostAccess()` → `{draft, applied, pending}`(`host-access.json` `:12`) | `applied === null` → '적용한 적 없음'(선택 기능 — 정보) | `pending !== null` 이고 `pending.deadline` 지남 → 확정 대기(주의) | 파일 (hostAccessStatus 는 제외) |
| 37 | `peer-trust` 장비 신뢰 | `/admin/security/peer-trust` | `routes/admin/peerTrust.js:72` → `security/peerTrust.js:598 peerTrustStatus()` → `kinds[ssh|tls].counts {approved, observed, pending, pendingChanged, rejected}` · `peer-trust.json`(메모리 캐시 `load()`) | 해당 없음 | **`counts.pending`(미승인) · `counts.pendingChanged`(지문 바뀜)** 합 → 주의 · `loadError` | 메모리(파일 캐시) (⚠ `tlsTrustStatus()` `security/tlsTrust.js:427` 도 메모리 — 선택) |
| 38 | `security-self-check` 보안 자가진단 | `/admin/security/self-check` | `routes/admin/securityCheck.js:22` → `security/selfCheck.js:156 collectSelfCheck({users})` → `summarize()`(`:47`) `{ok, warn, risk, unknown, total}` | 해당 없음 | **`summary.risk` · `summary.warn`** | 파일 여러 개 stat + 메모리(`collectSelfCheck` 는 비밀 파일 권한 `statFile :114` 등 로컬 fs 만 — 외부 호출 없음. 다만 파일 10여 개 stat 이라 memoJson TTL 안에서만) |
| 39 | `alerts` 알림 | `/admin/alerts` | `routes/admin/opsSettings.js:118` → `alerts.js:809 alertStatus()` → `loadAlertConfig()`(`:100`) · `alerts.json`(`:33`), 채널 기본 전부 `enabled:false`(`:37-42`) | 채널(slack/webhook/teams/email) 중 `enabled` 인 것 0개 → '알림 채널 미설정' | `queue`(발송 대기열 가득 — `:815`) · `firing` 수 | 파일 + 메모리 |
| 40 | `mail` 메일 발송 | `/admin/mail` | `routes/admin/mail.js:34` → `mail/settings.js:61 load()` · `mail.json`(`:24`), smtp 기본 `host:''`(`:29`); 상태 `mail/service.js:166 mailStatus()` | **`mailStatus().configured === false`**(= `smtp.host` 비어 있음, `service.js:173`) | `authStopped`(`:170` — SMTP 인증 정지, `mail-auth-stops.json`) · `lastError` | 파일 + 메모리 |
| 41 | `ai-search` AI 검색 | `/admin/llm-config` | `routes/admin/deployLlm.js:524` → `llm/config.js:36 loadLlmConfig()` · `llm.json`(`:15`), 기본 `enabled: LLM_ENABLED==='true'`, `url: OLLAMA_URL||'http://localhost:11434'`(`:17-20`) | `enabled === false`(선택 기능 — 정보) | `llmUrlIssue(url)`(`:52`) | 파일 |
| 42 | `tool-categories` 특수 기능 카테고리 | `/admin/tool-categories`, `…/preset` | `routes/admin/toolCategories.js:19` → `toolcats/settings.js:32 load()` · `tool-categories.json`(`:17`), `DEFAULTS.categories:[]`(`:19-21` → PRESET 사용) | 해당 없음(빈 값 = 프리셋이 기본) | — | 파일 |
| 43 | `vclogs` vCenter 로그 보관 | `/admin/vclogs/status` | `routes/admin/backupNetSec.js:238` → `logs/poller.js:880 logStatus()`(**SQLite metaAsync + 파일 크기** — 집계 제외) · 설정 `logs/settings.js:11-16`(`vcenter-logs.json`, `enabled:true` 기본) | 해당 없음(기본 켜짐) | `lastRun` 오류(메모리 — 모양 미확인) | 설정 파일만(logStatus 제외) |
| 44 | `diagnostics` 진단·로그 | `/admin/status`, `/admin/logs`, `/admin/memtrack` | `routes/admin/statusTools.js:210` → `store.get()` 스냅샷(메모리) `collectionErrors` | 해당 없음(조회 전용) | `snap.collectionErrors.length`(`statusTools.js:214`) — vCenter 수집 오류 수(주의 후보, 폴링마다 갱신) | 메모리 |
| 45 | `perf-monitor` 서버 성능 측정 | `/admin/perf`, `/admin/perf/hangs`, `/perf/req-status` | `routes/admin/perfMonitor.js:22` → `perf/monitor.js perfSnapshot`(메모리) · 설정 `perf/settings.js:11`(`perf-monitor.json`, `enabled:true` `:22-23`) | 해당 없음 | hang 로그 건수(`perf/hangLog.js hangLogStatus` — 파일, 모양 미확인) | 메모리 |
| 46 | `log-analysis` 로그 분석(개선점) | `/admin/log-analysis`, `…/meta` | `routes/admin/logAnalysis.js:23` → `loganalysis/index.js analyzeLive…`(요청 시 분석 — 무거움) | 해당 없음(조회 전용) | — (분석 결과를 집계에 넣지 말 것) | — |
| 47 | `audit` 감사 로그 | `/admin/audit?…` | `routes/admin/opsSettings.js:98` → `audit.js listAudit` · `audit.ndjson`(`audit.js:14`) | 해당 없음(조회 전용) | — | — |
| 48 | `recent-logins` 최근 로그인 | `/admin/login-history` | `routes/admin/opsSettings.js:107` → `security/loginHistory.js loginHistorySummary` · `login-history.ndjson`(`:24`) | 해당 없음(조회 전용) | — | — |
| 49 | `login-counts` 로그인 횟수 | 같음(#48) | 같음 | 해당 없음 | — | — |
| 50 | `upgrade` ⬆ 업그레이드 | `/upgrade/status`, `/upgrade/detect-install` | `routes/upgrade.js:150` → `upgrade/manager.js:233 status()`: `remoteConfigured: Boolean(s.remoteBase)`(`:238`), `lastCheck: sanitizeCheck(…)`(`:242`) → `lastCheck.remote.available / lastCheck.watch.available`(`upgrade/autoState.js:59·76`), `auto`(autoUpgradeState) · 설정 `upgrade/settings.js:18`(`upgrade.json`) | `remoteConfigured === false` 이고 `watchDir` 도 없음 → '업그레이드 소스 미설정'(오프라인 번들 수동 적용만 쓰는 설치도 있어 정보 등급) | **새 버전: `status().lastCheck?.remote?.available === true || lastCheck?.watch?.available === true`**(마지막 확인 기준 — 외부 호출 없이 메모리 값) · `persist.error` · `lastResult` 실패(`autoState.js:115 sanitizeResult`) | 메모리 |
| 51 | `about` About | `/health`(60초 폴링, `About.jsx:6`) | `routes/api/overviewNsx.js:132` | 해당 없음(조회 전용) | — | — |

### 요약 — 배지 후보로 쓸 만한 것
- **미설정(자연스러운 것만)**: vCenter 0건(#2) · DataCenter 0건(#1) · SMTP host 비어 있음(#40 `mailStatus().configured`) · 알림 채널 0개(#39) · 자격증명 평문(#33 `mode==='plain'`) · 세션 보안 파일 없음/소유자 기본값(#32) · 포탈 정기 백업 꺼짐(#10 `scheduleEnabled`) · Bareos Director 0건(#9, 권한 보일 때만) · 업그레이드 소스 없음(#50).
- **opt-in 기능(enabled 기본 false)** 은 '미설정' 이 아니라 '꺼짐(정보)' 로 구분할 것: vmseries(#15) · sansw-perf(#16) · guest-partition 수집(#18) · dir-usage(#19) · gpu-guest(#21) · ai-search(#41) · AD(#30) · NSX/Horizon/Veeam/isilon(#4·5·8·17).
- **주의(이미 서버가 계산)**: 업그레이드 새 버전(#50) · 자가진단 risk/warn(#38) · 장비 신뢰 pending/pendingChanged(#37) · 인증 정지 수 — vCenter/NSX/iDRAC/Veeam/Horizon/GPU/SMTP(#2·4·6·8·5·21·40, `*-auth-stops.json` 파일을 `peekAuthStop` 으로) · AD 전송 경고(#30) · 수집 서버 ok:false(#24) · 수집 오류 수(#44 `collectionErrors`) · 호스트 접근 pending(#36) · 등록부 loadError 류(#8·9·13·15·16·17·18·24·31).
- **집계 라우트에서 제외해야 하는 호출**: `hostAccessStatus()`(#36, OS) · `logStatus()`(#43, SQLite) · `perfDbStats()`(#16) · `getDb().latestAll()`(#19) · `targetRows()/ensureIsiduDemo()`(#17) · `buildUsageReport`(#31) · `listBackups()` readdir(#10) · 로그 분석(#46) · 모든 `testConnection`/`relay-test`.

## 2. 공통 인증 게이트 · memoJson
| 이름 | 위치 | 뜻 |
|---|---|---|
| `adminOnly` | `routes/admin/shared.js:12` (= `requireRole('admin')`, `auth/auth.js`) | 역할 admin 이상 |
| `fullScopeOnlyWith(reason)` → 각 라우트 파일의 `fleetOnly`/`fleetReadOnly`/`fleetWideOnly`/`fullScopeOnly` | `routes/admin/shared.js:19-28`(팩토리) · 예 `routes/admin/collectorsDc.js:40`, `routes/api/storageMon.js:52`, `routes/svcmon/shared.js:32` | 범위(vCenter 제한) 계정 403 — `gate: {kind:'fullScope'}` 태그 |
| `requireSettingsOwner` | `routes/admin/shared.js:51-64` | `security-session.json` 의 `settingsOwners` 에 든 username **이고** 전체 범위 계정만(v2.744). 인증 꺼짐이면 통과. 예: `/backup/status`, `/security/session`, `/secrets/policy`, `/usage/report`, `/host-access` |
| `requireSuperAdmin` | `auth/roles.js:38-43` | `req.user.superAdmin` 만. 예: 아이실론 설정 API |
| `requirePerm('tools')` | `auth/auth.js` | tools 권한(관리자 아님) — `vmseries/settings`, `waste/off-check`, `guest-partition/settings` 조회 |
| 라우터 마운트 | `index.js:460-482` — `/api/auth`(공개) · `/api/upgrade` · `/api/admin` · `/api/remote` · `/api`(모두 `authMiddleware, requireEnrolled, auditMiddleware`) | 새 `GET /api/settings/status` 는 `api`(또는 `adminRouter`) 에 `adminOnly` + 항목별로 그 항목의 게이트 등급보다 낮은 정보만 싣는 쪽이 안전(⚠ 범위 계정·비소유자에게 소유자 등급 값(SMTP·비밀 정책·세션 보안)이 새지 않게 — 배지만(불리언/개수) 내려도 `fullScope`/`settingsOwner` 로 걸러야 함, 추정) |

`memoJson(req, res, name, compute, { ttlMs = 12_000, extraKey })` — `routes/api/shared.js:16-27`. 키 = `snap.generatedAt|req.originalUrl|extraKey`, `snapMemo` single-flight + `sendCached`(ETag/304). 사용 예: `routes/api/bareosBackup.js:422` `memoJson(req, res, 'bareos-backup-list', () => bareosListView(req), { extraKey: bareosListKey(req) })`, `routes/api/overviewCards.js:160`. 주의(`shared.js:14-15` 주석): 관리자가 즉시 반영을 기대하는 값에는 쓰지 않는다 — 설정 저장 직후 배지가 12초 늦게 바뀌는 것을 허용할지 결정 필요. 스냅샷 세대(`generatedAt`)가 바뀌어도 설정 파일은 안 바뀌므로 extraKey 에 역할·범위(`scopeKey`)를 넣어야 한다.

## 3. `linkcheck/settingsKinds.js` SETTINGS_PATHS (라인 38-61) — 메뉴 경로 문자열 전부
| 키 | label | hash |
|---|---|---|
| vcenter | 설정 › 인프라 등록 › vCenter 등록·관리 | #/settings/vcenter-admin |
| nsx | 설정 › 인프라 등록 › NSX 관리 | #/settings/nsx-admin |
| collector | 설정 › 엣지·원격 › 수집 서버(원격) | #/settings/collectors |
| horizon | 설정 › 인프라 등록 › Horizon 연결 서버 | #/settings/horizon-admin |
| idrac | 설정 › 인프라 등록 › iDRAC 서버 등록 | #/settings/idrac-admin |
| storage | 특수기능 › 스토리지 모니터링 › 장비 등록 | #/tools/storage-mon |
| sanswitch | 특수기능 › SAN 스위치 › 장비 등록 | #/tools/san-switch |
| pdu | 특수기능 › PDU › 장비 등록 | #/tools/pdu |
| bmstor | 특수기능 › 베어메탈 스토리지 › 서버 등록 | #/tools/bm-storage |
| gpuPhysical | 설정 › 수집 › GPU 게스트 수집 › 물리 GPU 서버 | #/settings/gpu-guest |
| remote | 설정 › 엣지·원격 › 원격접속 설정 | #/settings/remote |
| capture | 특수기능 › 네트워크 캡처 › 캡처 호스트 | #/tools/net-traffic |
| deploy | 설정 › 엣지·원격 › 원격 법인(DC)에 Edge 노드 포탈 설치 | #/settings/agent-deploy |
| relaytopo | 특수기능 › 중계 토폴로지 | #/tools/relaytopo |
| credentials | 특수기능 › 통합 계정 관리 | #/tools/credentials |
| mail | 설정 › 알림·연동 › 메일 발송 | #/settings/mail |
| alerts | 설정 › 알림·연동 › 알림 | #/settings/alerts |
| ad | 설정 › 사용자 › 인증(AD) | #/settings/auth-ad |
| upgrade | 설정 › 시스템 › 업그레이드 | #/settings/upgrade |
| packages | 설정 › 시스템 › 업그레이드 › 패키지 저장소 | #/settings/upgrade |
| svcmon | 서비스 모니터 › 대상 관리 | #/svcmon |
| central | portal.env (CENTRAL_URL / CENTRAL_TOKEN) | (빈 문자열) |

## 4. `server/test/settingsMenu2905.test.js` 가 고정하는 것
`Settings.jsx` 원문을 정규식으로 파싱(`^  { k: '…', label: '…', C: X, group: '…'` 줄 모양 — **줄 모양이 바뀌면 테스트가 깨진다**, `:21-24`).
1. ① 하위 키 = `KEYS_V2901` 48개 + `KEYS_ADDED`(`recent-logins`·`login-counts`·`feature-usage`) 정확히 51개, 삭제·개명 없음(`:30-50`). 새 항목을 더하면 `KEYS_ADDED` 에 추가해야 한다.
2. ② 모든 항목이 GROUP_ORDER 9개 묶음 중 하나에 속하고, 같은 묶음은 붙어 있고 순서가 GROUP_ORDER 와 같다.
3. ③ 1단 줄은 줄바꿈(`flexWrap`, 가로 스크롤 금지).
4. ④ `web/`·`server/` 소스(주석 제거 후)에 옛 묶음 이름의 메뉴 경로 문구(`OLD_PATH` 정규식 — '설정 › 수집 서버 › …', '설정 › Security › …' 등)가 남지 않는다(`:73-82`).
5. ⑤ 소스의 `설정 › <묶음 라벨> › <항목>` 문구는 그 항목이 실제로 그 묶음에 있어야 한다(`:84-108`; 문구 50개 이상 발견돼야 함). → **묶음 라벨(`GROUPS[g].label`)이나 항목 라벨을 바꾸면 SETTINGS_PATHS 의 label 문자열(§3)과 소스 문구를 함께 고쳐야 한다.**

## 5. 웹에서 `#/settings/<k>` 로 링크하는 파일 수
`grep -rl "#/settings/" web/src` → **27개 파일**(`.js`/`.jsx`). (`hooks/hashTab.js MOVED_SUBS` 가 옛 주소 `#/settings/edge-tokens` 를 `#/tools/edge-tokens` 로 보냄 — `Settings.jsx:95-96` 주석.)
