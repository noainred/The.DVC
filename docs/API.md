# API 레퍼런스 (전 엔드포인트)

> ⚙️ **이 파일은 `scripts/api-doc.mjs` 가 소스에서 생성합니다 — 직접 고치지 마세요.**
> 라우트를 추가·삭제하면 `node scripts/api-doc.mjs` 로 다시 만듭니다.
> 외부 포탈이 쓰는 **공개 API** 는 이 파일이 아니라 [API-PUBLIC.md](API-PUBLIC.md) 를 보세요.

## 이 문서를 읽는 법

- **게이트** 열은 그 경로에 실제로 걸린 인증·인가를 **마운트 수준과 라우터 수준까지 합쳐** 적습니다.
  선언 줄만 보면 보이지 않는 것들입니다(예: `/api/svcmon/*` 의 `requirePerm('svcmon')` 은
  `index.js` 의 마운트에 있고, `/api/capacity/*` 의 `adminOnly` 는 라우터의 `use()` 에 있습니다).
- `authMiddleware`·`requireEnrolled`·`auditMiddleware` 는 `/api/*` 대부분에 공통이라 열에서 생략했습니다.
  **생략은 "없다" 가 아닙니다** — 그룹 설명에 어느 경로가 그것을 타는지 적혀 있습니다.
- **게이트가 `—` 인 것이 곧 무방비라는 뜻은 아닙니다.** 토큰 게이트(`/api/collector`·`/api/central`)는
  라우터 미들웨어가 처리하고, 일부 라우트는 핸들러 안에서 직접 검사합니다(`fullScopeOnly` 같은
  헬퍼가 함수 안에 있는 경우). 정확한 판정은 항상 **파일:줄** 을 열어 확인하세요.
- **범위(scope)**: 조회 라우트는 `auth/scope.js scopedVcenterIds` 로 사용자의 vCenter 범위와
  교집합합니다. 범위 밖 단건은 **403 이 아니라 404**(존재 은닉)이고, 조회는 되지만 쓰기 범위
  밖이면 403 입니다. 자세한 규약은 `server/CLAUDE.md`.

## 요약

| 항목 | 값 |
|---|---|
| 엔드포인트 | **952개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 98개 |
| GET | 521개 |
| POST | 285개 |
| PUT | 94개 |
| PATCH | 2개 |
| DELETE | 50개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 9 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 16 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 52 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 8 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 56 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 331 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 9 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 422 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:106](../server/src/routes/collector.js#L106) |
| POST | `/bmstor-collect` | `express.json` | [server/src/routes/collector.js:204](../server/src/routes/collector.js#L204) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:77](../server/src/routes/collector.js#L77) |
| GET | `/export` | — | [server/src/routes/collector.js:41](../server/src/routes/collector.js#L41) |
| POST | `/idrac-scan` | `express.json` | [server/src/routes/collector.js:169](../server/src/routes/collector.js#L169) |
| GET | `/ping` | — | [server/src/routes/collector.js:58](../server/src/routes/collector.js#L58) |
| POST | `/set-password` | `express.json` | [server/src/routes/collector.js:149](../server/src/routes/collector.js#L149) |
| GET | `/token-check` | — | [server/src/routes/collector.js:134](../server/src/routes/collector.js#L134) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:224](../server/src/routes/collector.js#L224) |

## `/api/capacity`

리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `role:admin`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/history` | — | [server/src/routes/capacity.js:71](../server/src/routes/capacity.js#L71) |
| GET | `/host` | — | [server/src/routes/capacity.js:59](../server/src/routes/capacity.js#L59) |
| GET | `/summary` | — | [server/src/routes/capacity.js:39](../server/src/routes/capacity.js#L39) |

## `/api/insights`

FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('insights')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/anomalies` | — | [server/src/routes/insights.js:312](../server/src/routes/insights.js#L312) |
| POST | `/chatops` | — | [server/src/routes/insights.js:380](../server/src/routes/insights.js#L380) |
| GET | `/finops` | — | [server/src/routes/insights.js:92](../server/src/routes/insights.js#L92) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:112](../server/src/routes/insights.js#L112) |
| PUT | `/finops/config` | 역할 `admin` · `fleetOnly` | [server/src/routes/insights.js:141](../server/src/routes/insights.js#L141) |
| GET | `/fleet` | — | [server/src/routes/insights.js:149](../server/src/routes/insights.js#L149) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:202](../server/src/routes/insights.js#L202) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:218](../server/src/routes/insights.js#L218) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:252](../server/src/routes/insights.js#L252) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:175](../server/src/routes/insights.js#L175) |
| GET | `/forecast` | — | [server/src/routes/insights.js:333](../server/src/routes/insights.js#L333) |
| GET | `/graph` | — | [server/src/routes/insights.js:359](../server/src/routes/insights.js#L359) |
| GET | `/incidents` | — | [server/src/routes/insights.js:374](../server/src/routes/insights.js#L374) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:115](../server/src/routes/insights.js#L115) |
| GET | `/security` | — | [server/src/routes/insights.js:346](../server/src/routes/insights.js#L346) |
| GET | `/topology` | — | [server/src/routes/insights.js:349](../server/src/routes/insights.js#L349) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central.js:2070](../server/src/routes/central.js#L2070) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:406](../server/src/routes/central.js#L406) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central.js:2155](../server/src/routes/central.js#L2155) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central.js:2159](../server/src/routes/central.js#L2159) |
| GET | `/bmusage-config` | `requireCentral` | [server/src/routes/central.js:1495](../server/src/routes/central.js#L1495) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:542](../server/src/routes/central.js#L542) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central.js:2134](../server/src/routes/central.js#L2134) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central.js:2138](../server/src/routes/central.js#L2138) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:959](../server/src/routes/central.js#L959) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:1057](../server/src/routes/central.js#L1057) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central.js:1916](../server/src/routes/central.js#L1916) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central.js:1943](../server/src/routes/central.js#L1943) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central.js:1448](../server/src/routes/central.js#L1448) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central.js:1455](../server/src/routes/central.js#L1455) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:1096](../server/src/routes/central.js#L1096) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1309](../server/src/routes/central.js#L1309) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1229](../server/src/routes/central.js#L1229) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:822](../server/src/routes/central.js#L822) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central.js:2255](../server/src/routes/central.js#L2255) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1153](../server/src/routes/central.js#L1153) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1163](../server/src/routes/central.js#L1163) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1175](../server/src/routes/central.js#L1175) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:710](../server/src/routes/central.js#L710) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central.js:2183](../server/src/routes/central.js#L2183) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central.js:2194](../server/src/routes/central.js#L2194) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central.js:2269](../server/src/routes/central.js#L2269) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central.js:2299](../server/src/routes/central.js#L2299) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central.js:2108](../server/src/routes/central.js#L2108) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central.js:2115](../server/src/routes/central.js#L2115) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central.js:1417](../server/src/routes/central.js#L1417) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central.js:1485](../server/src/routes/central.js#L1485) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central.js:1612](../server/src/routes/central.js#L1612) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central.js:1631](../server/src/routes/central.js#L1631) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central.js:2043](../server/src/routes/central.js#L2043) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central.js:2051](../server/src/routes/central.js#L2051) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:417](../server/src/routes/central.js#L417) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:495](../server/src/routes/central.js#L495) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central.js:1842](../server/src/routes/central.js#L1842) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central.js:1777](../server/src/routes/central.js#L1777) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central.js:1862](../server/src/routes/central.js#L1862) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central.js:1667](../server/src/routes/central.js#L1667) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central.js:1875](../server/src/routes/central.js#L1875) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central.js:1699](../server/src/routes/central.js#L1699) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central.js:1758](../server/src/routes/central.js#L1758) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central.js:1391](../server/src/routes/central.js#L1391) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central.js:1513](../server/src/routes/central.js#L1513) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:584](../server/src/routes/central.js#L584) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:600](../server/src/routes/central.js#L600) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:519](../server/src/routes/central.js#L519) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central.js:2033](../server/src/routes/central.js#L2033) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:899](../server/src/routes/central.js#L899) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:1081](../server/src/routes/central.js#L1081) |

## `/api/upgrade`

자동 업그레이드 제어(번들 수신·적용).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/apply` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:155](../server/src/routes/upgrade.js#L155) |
| POST | `/bundle` | 역할 `admin` · `fullScopeOnlyWith` · `express.raw` | [server/src/routes/upgrade.js:197](../server/src/routes/upgrade.js#L197) |
| POST | `/check` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:149](../server/src/routes/upgrade.js#L149) |
| GET | `/detect-install` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:174](../server/src/routes/upgrade.js#L174) |
| POST | `/restart` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:163](../server/src/routes/upgrade.js#L163) |
| GET | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:169](../server/src/routes/upgrade.js#L169) |
| PUT | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:184](../server/src/routes/upgrade.js#L184) |
| GET | `/status` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:144](../server/src/routes/upgrade.js#L144) |

## `/api/remote`

원격 접속(HAProxy/SSH/RDP 중계).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:159](../server/src/routes/remote.js#L159) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:175](../server/src/routes/remote.js#L175) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:330](../server/src/routes/remote.js#L330) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:314](../server/src/routes/remote.js#L314) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:52](../server/src/routes/remote.js#L52) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:352](../server/src/routes/remote.js#L352) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:412](../server/src/routes/remote.js#L412) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:401](../server/src/routes/remote.js#L401) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:96](../server/src/routes/remote.js#L96) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:126](../server/src/routes/remote.js#L126) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:240](../server/src/routes/remote.js#L240) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:261](../server/src/routes/remote.js#L261) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:274](../server/src/routes/remote.js#L274) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:184](../server/src/routes/remote.js#L184) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:372](../server/src/routes/remote.js#L372) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:37](../server/src/routes/remote.js#L37) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:428](../server/src/routes/remote.js#L428) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:142](../server/src/routes/remote.js#L142) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:298](../server/src/routes/remote.js#L298) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:30](../server/src/routes/svcmon/edge.js#L30) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:107](../server/src/routes/svcmon/edge.js#L107) |
| PUT | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:65](../server/src/routes/svcmon/edge.js#L65) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:115](../server/src/routes/svcmon/edge.js#L115) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:100](../server/src/routes/svcmon/overview.js#L100) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:137](../server/src/routes/svcmon/edge.js#L137) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:124](../server/src/routes/svcmon/edge.js#L124) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:168](../server/src/routes/svcmon/edge.js#L168) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:152](../server/src/routes/svcmon/edge.js#L152) |
| POST | `/flush` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:117](../server/src/routes/svcmon/overview.js#L117) |
| POST | `/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:23](../server/src/routes/svcmon/tree.js#L23) |
| POST | `/folders/delete` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:57](../server/src/routes/svcmon/tree.js#L57) |
| POST | `/folders/move` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:39](../server/src/routes/svcmon/tree.js#L39) |
| PUT | `/folders/rename` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:31](../server/src/routes/svcmon/tree.js#L31) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:30](../server/src/routes/svcmon/logs.js#L30) |
| PUT | `/log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:34](../server/src/routes/svcmon/logs.js#L34) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:82](../server/src/routes/svcmon/logs.js#L82) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:54](../server/src/routes/svcmon/logs.js#L54) |
| POST | `/log/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:106](../server/src/routes/svcmon/logs.js#L106) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:66](../server/src/routes/svcmon/logs.js#L66) |
| POST | `/push-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:176](../server/src/routes/svcmon/edge.js#L176) |
| POST | `/refresh` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:111](../server/src/routes/svcmon/overview.js#L111) |
| PUT | `/reorder/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:52](../server/src/routes/svcmon/tree.js#L52) |
| PUT | `/reorder/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:47](../server/src/routes/svcmon/tree.js#L47) |
| POST | `/silence-check` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:183](../server/src/routes/svcmon/edge.js#L183) |
| PUT | `/sort` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:67](../server/src/routes/svcmon/tree.js#L67) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:48](../server/src/routes/svcmon/overview.js#L48) |
| POST | `/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:73](../server/src/routes/svcmon/tree.js#L73) |
| DELETE | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:109](../server/src/routes/svcmon/tree.js#L109) |
| PUT | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:100](../server/src/routes/svcmon/tree.js#L100) |
| POST | `/targets/:id/tests` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:115](../server/src/routes/svcmon/tree.js#L115) |
| DELETE | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:133](../server/src/routes/svcmon/tree.js#L133) |
| PUT | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:124](../server/src/routes/svcmon/tree.js#L124) |
| POST | `/targets/bulk` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:81](../server/src/routes/svcmon/tree.js#L81) |
| GET | `/targets/csv-schema` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:141](../server/src/routes/svcmon/transfer.js#L141) |
| GET | `/targets/export.:format` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/transfer.js:72](../server/src/routes/svcmon/transfer.js#L72) |
| GET | `/targets/export.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/transfer.js:37](../server/src/routes/svcmon/transfer.js#L37) |
| POST | `/targets/generate` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:90](../server/src/routes/svcmon/generate.js#L90) |
| GET | `/targets/hostmap-template.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/transfer.js:103](../server/src/routes/svcmon/transfer.js#L103) |
| POST | `/targets/hostmap/export.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/transfer.js:132](../server/src/routes/svcmon/transfer.js#L132) |
| POST | `/targets/hostmap/parse` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:112](../server/src/routes/svcmon/transfer.js#L112) |
| POST | `/targets/import` | 역할 `admin/operator` · `fullScopeOnly` · `csvPermUnlessJson` | [server/src/routes/svcmon/transfer.js:169](../server/src/routes/svcmon/transfer.js#L169) |
| GET | `/targets/sample.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/transfer.js:94](../server/src/routes/svcmon/transfer.js#L94) |
| GET | `/templates` | — | [server/src/routes/svcmon/templates.js:30](../server/src/routes/svcmon/templates.js#L30) |
| POST | `/templates` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:35](../server/src/routes/svcmon/templates.js#L35) |
| DELETE | `/templates/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:68](../server/src/routes/svcmon/templates.js#L68) |
| PUT | `/templates/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:46](../server/src/routes/svcmon/templates.js#L46) |
| POST | `/templates/:id/apply` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:131](../server/src/routes/svcmon/templates.js#L131) |
| POST | `/templates/:id/duplicate` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:58](../server/src/routes/svcmon/templates.js#L58) |
| GET | `/templates/:id/usage` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:125](../server/src/routes/svcmon/templates.js#L125) |
| GET | `/templates/export.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/templates.js:81](../server/src/routes/svcmon/templates.js#L81) |
| POST | `/templates/import` | 역할 `admin/operator` · `csvPerm` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:100](../server/src/routes/svcmon/templates.js#L100) |
| GET | `/templates/sample.csv` | 역할 `admin/operator` · `csvPerm` | [server/src/routes/svcmon/templates.js:89](../server/src/routes/svcmon/templates.js#L89) |

## `/api/admin`

설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:80](../server/src/routes/admin/deployLlm.js#L80) |
| GET | `/agent-deploy/bulk` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:322](../server/src/routes/admin/deployLlm.js#L322) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:323](../server/src/routes/admin/deployLlm.js#L323) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:328](../server/src/routes/admin/deployLlm.js#L328) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:272](../server/src/routes/admin/deployLlm.js#L272) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:277](../server/src/routes/admin/deployLlm.js#L277) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:294](../server/src/routes/admin/deployLlm.js#L294) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:339](../server/src/routes/admin/deployLlm.js#L339) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:410](../server/src/routes/admin/deployLlm.js#L410) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:357](../server/src/routes/admin/deployLlm.js#L357) |
| GET | `/agent-deploy/defaults` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:66](../server/src/routes/admin/deployLlm.js#L66) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:231](../server/src/routes/admin/deployLlm.js#L231) |
| GET | `/agent-deploy/installer` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:64](../server/src/routes/admin/deployLlm.js#L64) |
| GET | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:100](../server/src/routes/admin/deployLlm.js#L100) |
| POST | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:109](../server/src/routes/admin/deployLlm.js#L109) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:130](../server/src/routes/admin/deployLlm.js#L130) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:212](../server/src/routes/admin/deployLlm.js#L212) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:222](../server/src/routes/admin/deployLlm.js#L222) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:141](../server/src/routes/admin/deployLlm.js#L141) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:500](../server/src/routes/admin/deployLlm.js#L500) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:179](../server/src/routes/admin/deployLlm.js#L179) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:155](../server/src/routes/admin/deployLlm.js#L155) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:513](../server/src/routes/admin/deployLlm.js#L513) |
| POST | `/agent-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:76](../server/src/routes/admin/deployLlm.js#L76) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:73](../server/src/routes/admin/opsSettings.js#L73) |
| PUT | `/alerts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:74](../server/src/routes/admin/opsSettings.js#L74) |
| POST | `/alerts/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:86](../server/src/routes/admin/opsSettings.js#L86) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:119](../server/src/routes/admin/opsSettings.js#L119) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:120](../server/src/routes/admin/opsSettings.js#L120) |
| GET | `/api-keys` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/apiKeys.js:34](../server/src/routes/admin/apiKeys.js#L34) |
| POST | `/api-keys` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:67](../server/src/routes/admin/apiKeys.js#L67) |
| DELETE | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:103](../server/src/routes/admin/apiKeys.js#L103) |
| PATCH | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:84](../server/src/routes/admin/apiKeys.js#L84) |
| POST | `/api-keys/:id/revoke` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:95](../server/src/routes/admin/apiKeys.js#L95) |
| GET | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:194](../server/src/routes/admin/horizonAssign.js#L194) |
| POST | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:202](../server/src/routes/admin/horizonAssign.js#L202) |
| DELETE | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:212](../server/src/routes/admin/horizonAssign.js#L212) |
| PUT | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:207](../server/src/routes/admin/horizonAssign.js#L207) |
| POST | `/assignments/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:219](../server/src/routes/admin/horizonAssign.js#L219) |
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:65](../server/src/routes/admin/opsSettings.js#L65) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:130](../server/src/routes/admin/backupNetSec.js#L130) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:113](../server/src/routes/admin/backupNetSec.js#L113) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:108](../server/src/routes/admin/backupNetSec.js#L108) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:131](../server/src/routes/admin/backupNetSec.js#L131) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:107](../server/src/routes/admin/backupNetSec.js#L107) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:104](../server/src/routes/admin/backupNetSec.js#L104) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:121](../server/src/routes/admin/backupNetSec.js#L121) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:24](../server/src/routes/admin/centralTokens.js#L24) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:53](../server/src/routes/admin/centralTokens.js#L53) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:48](../server/src/routes/admin/centralTokens.js#L48) |
| GET | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:66](../server/src/routes/admin/centralTokens.js#L66) |
| POST | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:69](../server/src/routes/admin/centralTokens.js#L69) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:75](../server/src/routes/admin/centralTokens.js#L75) |
| GET | `/central/ingest-stats` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:44](../server/src/routes/admin/centralTokens.js#L44) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:45](../server/src/routes/admin/centralTokens.js#L45) |
| GET | `/central/inventory` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:26](../server/src/routes/admin/centralTokens.js#L26) |
| POST | `/central/inventory/owner` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:31](../server/src/routes/admin/centralTokens.js#L31) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:102](../server/src/routes/admin/opsSettings.js#L102) |
| GET | `/codex-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:30](../server/src/routes/admin/statusTools.js#L30) |
| GET | `/codex-check/file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:33](../server/src/routes/admin/statusTools.js#L33) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:36](../server/src/routes/admin/statusTools.js#L36) |
| GET | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:84](../server/src/routes/admin/collectorsDc.js#L84) |
| POST | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:88](../server/src/routes/admin/collectorsDc.js#L88) |
| DELETE | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:109](../server/src/routes/admin/collectorsDc.js#L109) |
| PUT | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:95](../server/src/routes/admin/collectorsDc.js#L95) |
| POST | `/collectors/:id/force-token` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:478](../server/src/routes/admin/collectorsDc.js#L478) |
| GET | `/collectors/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:128](../server/src/routes/admin/collectorsDc.js#L128) |
| POST | `/collectors/import` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:157](../server/src/routes/admin/collectorsDc.js#L157) |
| POST | `/collectors/pull` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:389](../server/src/routes/admin/collectorsDc.js#L389) |
| GET | `/collectors/sample.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/collectorsDc.js:143](../server/src/routes/admin/collectorsDc.js#L143) |
| POST | `/collectors/set-password` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:209](../server/src/routes/admin/collectorsDc.js#L209) |
| POST | `/collectors/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:410](../server/src/routes/admin/collectorsDc.js#L410) |
| POST | `/collectors/upgrade` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:396](../server/src/routes/admin/collectorsDc.js#L396) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:34](../server/src/routes/admin/vcenters.js#L34) |
| PUT | `/data-source` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:39](../server/src/routes/admin/vcenters.js#L39) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:303](../server/src/routes/admin/collectorsDc.js#L303) |
| PUT | `/datacenter-order` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:313](../server/src/routes/admin/collectorsDc.js#L313) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:268](../server/src/routes/admin/collectorsDc.js#L268) |
| POST | `/datacenters` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:277](../server/src/routes/admin/collectorsDc.js#L277) |
| DELETE | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:297](../server/src/routes/admin/collectorsDc.js#L297) |
| PUT | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:292](../server/src/routes/admin/collectorsDc.js#L292) |
| PUT | `/datacenters/assign` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:283](../server/src/routes/admin/collectorsDc.js#L283) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:263](../server/src/routes/admin/backupNetSec.js#L263) |
| GET | `/dir-usage` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:29](../server/src/routes/admin/dirUsage.js#L29) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:46](../server/src/routes/admin/dirUsage.js#L46) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:68](../server/src/routes/admin/dirUsage.js#L68) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:86](../server/src/routes/admin/dirUsage.js#L86) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:60](../server/src/routes/admin/dirUsage.js#L60) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:76](../server/src/routes/admin/dirUsage.js#L76) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:249](../server/src/routes/admin/gpuGuest.js#L249) |
| GET | `/edge-users/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:235](../server/src/routes/admin/gpuGuest.js#L235) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:244](../server/src/routes/admin/gpuGuest.js#L244) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:255](../server/src/routes/admin/gpuGuest.js#L255) |
| GET | `/edge-users/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:224](../server/src/routes/admin/gpuGuest.js#L224) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:50](../server/src/routes/admin/statusTools.js#L50) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:59](../server/src/routes/admin/statusTools.js#L59) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:87](../server/src/routes/admin/nsxImport.js#L87) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:209](../server/src/routes/admin/gpuGuest.js#L209) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:213](../server/src/routes/admin/gpuGuest.js#L213) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:199](../server/src/routes/admin/gpuGuest.js#L199) |
| GET | `/gpu-guest/diag` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:158](../server/src/routes/admin/gpuGuest.js#L158) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:123](../server/src/routes/admin/gpuGuest.js#L123) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:127](../server/src/routes/admin/gpuGuest.js#L127) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:354](../server/src/routes/admin/gpuGuest.js#L354) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` · `rawIpFleetOnly` | [server/src/routes/admin/gpuGuest.js:453](../server/src/routes/admin/gpuGuest.js#L453) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:164](../server/src/routes/admin/gpuGuest.js#L164) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:261](../server/src/routes/admin/gpuGuest.js#L261) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:264](../server/src/routes/admin/gpuGuest.js#L264) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:274](../server/src/routes/admin/gpuGuest.js#L274) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:269](../server/src/routes/admin/gpuGuest.js#L269) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:283](../server/src/routes/admin/gpuGuest.js#L283) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:307](../server/src/routes/admin/gpuGuest.js#L307) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:278](../server/src/routes/admin/gpuGuest.js#L278) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:335](../server/src/routes/admin/gpuGuest.js#L335) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:96](../server/src/routes/admin/gpuGuest.js#L96) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:240](../server/src/routes/admin/backupNetSec.js#L240) |
| GET | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:21](../server/src/routes/admin/horizonAssign.js#L21) |
| POST | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:22](../server/src/routes/admin/horizonAssign.js#L22) |
| DELETE | `/horizon/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:27](../server/src/routes/admin/horizonAssign.js#L27) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:72](../server/src/routes/admin/horizonAssign.js#L72) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:80](../server/src/routes/admin/horizonAssign.js#L80) |
| POST | `/horizon/servers/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:146](../server/src/routes/admin/horizonAssign.js#L146) |
| POST | `/horizon/servers/import/test` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:104](../server/src/routes/admin/horizonAssign.js#L104) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:136](../server/src/routes/admin/horizonAssign.js#L136) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:88](../server/src/routes/admin/horizonAssign.js#L88) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:94](../server/src/routes/admin/horizonAssign.js#L94) |
| POST | `/horizon/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:32](../server/src/routes/admin/horizonAssign.js#L32) |
| GET | `/host-access` | 역할 `admin` · `fleetReadOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:28](../server/src/routes/admin/hostAccess.js#L28) |
| POST | `/host-access/apply` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:40](../server/src/routes/admin/hostAccess.js#L40) |
| POST | `/host-access/confirm` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:45](../server/src/routes/admin/hostAccess.js#L45) |
| PUT | `/host-access/draft` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:31](../server/src/routes/admin/hostAccess.js#L31) |
| POST | `/host-access/plan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:37](../server/src/routes/admin/hostAccess.js#L37) |
| POST | `/host-access/revert` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:50](../server/src/routes/admin/hostAccess.js#L50) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:183](../server/src/routes/admin/idracCore.js#L183) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:212](../server/src/routes/admin/idracCore.js#L212) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:531](../server/src/routes/admin/idracScan.js#L531) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:525](../server/src/routes/admin/idracScan.js#L525) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` · `liveFleetOnly` | [server/src/routes/admin/idracScan.js:204](../server/src/routes/admin/idracScan.js#L204) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:63](../server/src/routes/admin/idracScan.js#L63) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:117](../server/src/routes/admin/idracScan.js#L117) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:161](../server/src/routes/admin/idracScan.js#L161) |
| GET | `/idrac/:id/trend` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:809](../server/src/routes/admin/idracTrend.js#L809) |
| GET | `/idrac/:id/trend/hourly` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:771](../server/src/routes/admin/idracTrend.js#L771) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:85](../server/src/routes/admin/idracScan.js#L85) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:513](../server/src/routes/admin/idracScan.js#L513) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:236](../server/src/routes/admin/idracScan.js#L236) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:500](../server/src/routes/admin/idracScan.js#L500) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:229](../server/src/routes/admin/idracScan.js#L229) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:520](../server/src/routes/admin/idracCore.js#L520) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:556](../server/src/routes/admin/idracCore.js#L556) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:452](../server/src/routes/admin/idracCore.js#L452) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:262](../server/src/routes/admin/idracCore.js#L262) |
| POST | `/idrac/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:218](../server/src/routes/admin/idracScan.js#L218) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:373](../server/src/routes/admin/idracCore.js#L373) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:299](../server/src/routes/admin/idracCore.js#L299) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:610](../server/src/routes/admin/idracCore.js#L610) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:630](../server/src/routes/admin/idracCore.js#L630) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:230](../server/src/routes/admin/idracCore.js#L230) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:248](../server/src/routes/admin/idracCore.js#L248) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:236](../server/src/routes/admin/idracCore.js#L236) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:237](../server/src/routes/admin/idracCore.js#L237) |
| POST | `/idrac/register-scanned` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:307](../server/src/routes/admin/idracScan.js#L307) |
| POST | `/idrac/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:245](../server/src/routes/admin/idracScan.js#L245) |
| GET | `/idrac/scan-agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:293](../server/src/routes/admin/idracScan.js#L293) |
| GET | `/idrac/scan-job-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:474](../server/src/routes/admin/idracScan.js#L474) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:492](../server/src/routes/admin/idracScan.js#L492) |
| GET | `/idrac/scan-jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:464](../server/src/routes/admin/idracScan.js#L464) |
| GET | `/idrac/scan-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:438](../server/src/routes/admin/idracScan.js#L438) |
| GET | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:324](../server/src/routes/admin/idracScan.js#L324) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:330](../server/src/routes/admin/idracScan.js#L330) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:338](../server/src/routes/admin/idracScan.js#L338) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:349](../server/src/routes/admin/idracScan.js#L349) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:370](../server/src/routes/admin/idracScan.js#L370) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:452](../server/src/routes/admin/idracScan.js#L452) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/idracScan.js:364](../server/src/routes/admin/idracScan.js#L364) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:426](../server/src/routes/admin/idracScan.js#L426) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:435](../server/src/routes/admin/idracScan.js#L435) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:445](../server/src/routes/admin/idracScan.js#L445) |
| GET | `/idrac/scan-result` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:284](../server/src/routes/admin/idracScan.js#L284) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:496](../server/src/routes/admin/idracCore.js#L496) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:222](../server/src/routes/admin/idracCore.js#L222) |
| GET | `/idrac/trend/export.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:683](../server/src/routes/admin/idracTrend.js#L683) |
| GET | `/idrac/trend/export.xlsx` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:707](../server/src/routes/admin/idracTrend.js#L707) |
| GET | `/idrac/trend/resolve-host` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:660](../server/src/routes/admin/idracTrend.js#L660) |
| GET | `/idrac/trend/servers` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:596](../server/src/routes/admin/idracTrend.js#L596) |
| GET | `/idrac/trend/table` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:603](../server/src/routes/admin/idracTrend.js#L603) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:487](../server/src/routes/admin/idracCore.js#L487) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:60](../server/src/routes/admin/centralIpam.js#L60) |
| POST | `/ipam/scan/agent/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:311](../server/src/routes/admin/centralIpam.js#L311) |
| GET | `/ipam/scan/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:199](../server/src/routes/admin/centralIpam.js#L199) |
| GET | `/ipam/scan/log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:385](../server/src/routes/admin/centralIpam.js#L385) |
| GET | `/ipam/scan/migration` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:357](../server/src/routes/admin/centralIpam.js#L357) |
| POST | `/ipam/scan/migration/dismiss` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:380](../server/src/routes/admin/centralIpam.js#L380) |
| POST | `/ipam/scan/migration/move` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:358](../server/src/routes/admin/centralIpam.js#L358) |
| POST | `/ipam/scan/migration/remove` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:370](../server/src/routes/admin/centralIpam.js#L370) |
| GET | `/ipam/scan/owners` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:191](../server/src/routes/admin/centralIpam.js#L191) |
| GET | `/ipam/scan/ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:268](../server/src/routes/admin/centralIpam.js#L268) |
| GET | `/ipam/scan/ranges.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:409](../server/src/routes/admin/centralIpam.js#L409) |
| POST | `/ipam/scan/ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:420](../server/src/routes/admin/centralIpam.js#L420) |
| POST | `/ipam/scan/ranges/line` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:286](../server/src/routes/admin/centralIpam.js#L286) |
| GET | `/ipam/scan/ranges/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:415](../server/src/routes/admin/centralIpam.js#L415) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:396](../server/src/routes/admin/centralIpam.js#L396) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:388](../server/src/routes/admin/centralIpam.js#L388) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:116](../server/src/routes/admin/centralIpam.js#L116) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:135](../server/src/routes/admin/centralIpam.js#L135) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:393](../server/src/routes/admin/centralIpam.js#L393) |
| GET | `/ipam/scan/suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:161](../server/src/routes/admin/centralIpam.js#L161) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:88](../server/src/routes/admin/centralIpam.js#L88) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:92](../server/src/routes/admin/centralIpam.js#L92) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:444](../server/src/routes/admin/centralIpam.js#L444) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:500](../server/src/routes/admin/centralIpam.js#L500) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:521](../server/src/routes/admin/centralIpam.js#L521) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:515](../server/src/routes/admin/centralIpam.js#L515) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:506](../server/src/routes/admin/centralIpam.js#L506) |
| GET | `/ipam/vc-ranges/suggest` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:468](../server/src/routes/admin/centralIpam.js#L468) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:521](../server/src/routes/admin/deployLlm.js#L521) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:522](../server/src/routes/admin/deployLlm.js#L522) |
| POST | `/llm-test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:528](../server/src/routes/admin/deployLlm.js#L528) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:86](../server/src/routes/admin/statusTools.js#L86) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:19](../server/src/routes/admin/mail.js#L19) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:23](../server/src/routes/admin/mail.js#L23) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:45](../server/src/routes/admin/mail.js#L45) |
| GET | `/memtrack` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:202](../server/src/routes/admin/statusTools.js#L202) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:80](../server/src/routes/admin/gpuGuest.js#L80) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:84](../server/src/routes/admin/gpuGuest.js#L84) |
| GET | `/net/agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:172](../server/src/routes/admin/backupNetSec.js#L172) |
| GET | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:204](../server/src/routes/admin/backupNetSec.js#L204) |
| POST | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:179](../server/src/routes/admin/backupNetSec.js#L179) |
| GET | `/net/history` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:221](../server/src/routes/admin/backupNetSec.js#L221) |
| DELETE | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:223](../server/src/routes/admin/backupNetSec.js#L223) |
| GET | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:222](../server/src/routes/admin/backupNetSec.js#L222) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:231](../server/src/routes/admin/backupNetSec.js#L231) |
| GET | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:226](../server/src/routes/admin/backupNetSec.js#L226) |
| PUT | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:227](../server/src/routes/admin/backupNetSec.js#L227) |
| DELETE | `/net/monitors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:228](../server/src/routes/admin/backupNetSec.js#L228) |
| POST | `/net/monitors/:id/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:229](../server/src/routes/admin/backupNetSec.js#L229) |
| POST | `/net/pcap` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:210](../server/src/routes/admin/backupNetSec.js#L210) |
| GET | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:18](../server/src/routes/admin/nfsMounts.js#L18) |
| POST | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:22](../server/src/routes/admin/nfsMounts.js#L22) |
| DELETE | `/nfs-mounts/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:30](../server/src/routes/admin/nfsMounts.js#L30) |
| POST | `/nfs-mounts/:id/mount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:38](../server/src/routes/admin/nfsMounts.js#L38) |
| POST | `/nfs-mounts/:id/umount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:46](../server/src/routes/admin/nfsMounts.js#L46) |
| GET | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:57](../server/src/routes/admin/nsxImport.js#L57) |
| POST | `/nsx/managers` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:67](../server/src/routes/admin/nsxImport.js#L67) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:77](../server/src/routes/admin/nsxImport.js#L77) |
| PUT | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:72](../server/src/routes/admin/nsxImport.js#L72) |
| POST | `/nsx/managers/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:82](../server/src/routes/admin/nsxImport.js#L82) |
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:542](../server/src/routes/admin/deployLlm.js#L542) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:539](../server/src/routes/admin/deployLlm.js#L539) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:216](../server/src/routes/admin/opsSettings.js#L216) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:246](../server/src/routes/admin/opsSettings.js#L246) |
| GET | `/os-scan/results.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/opsSettings.js:250](../server/src/routes/admin/opsSettings.js#L250) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:228](../server/src/routes/admin/opsSettings.js#L228) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:219](../server/src/routes/admin/opsSettings.js#L219) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:41](../server/src/routes/admin/deployLlm.js#L41) |
| POST | `/packages/download` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:58](../server/src/routes/admin/deployLlm.js#L58) |
| PUT | `/packages/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:55](../server/src/routes/admin/deployLlm.js#L55) |
| GET | `/perf` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:22](../server/src/routes/admin/perfMonitor.js#L22) |
| DELETE | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:60](../server/src/routes/admin/perfMonitor.js#L60) |
| GET | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:54](../server/src/routes/admin/perfMonitor.js#L54) |
| POST | `/perf/measure` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:47](../server/src/routes/admin/perfMonitor.js#L47) |
| PUT | `/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:31](../server/src/routes/admin/perfMonitor.js#L31) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:107](../server/src/routes/admin/users.js#L107) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:163](../server/src/routes/admin/users.js#L163) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:182](../server/src/routes/admin/users.js#L182) |
| GET | `/portal-db` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:109](../server/src/routes/admin/statusTools.js#L109) |
| GET | `/portal-db/guide` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:113](../server/src/routes/admin/statusTools.js#L113) |
| GET | `/portal-db/health` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:127](../server/src/routes/admin/statusTools.js#L127) |
| GET | `/portal-db/location` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:146](../server/src/routes/admin/statusTools.js#L146) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:162](../server/src/routes/admin/statusTools.js#L162) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:172](../server/src/routes/admin/statusTools.js#L172) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:266](../server/src/routes/admin/opsSettings.js#L266) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:283](../server/src/routes/admin/opsSettings.js#L283) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:275](../server/src/routes/admin/opsSettings.js#L275) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:549](../server/src/routes/admin/deployLlm.js#L549) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:553](../server/src/routes/admin/deployLlm.js#L553) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:89](../server/src/routes/admin/opsSettings.js#L89) |
| PUT | `/report/daily` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:90](../server/src/routes/admin/opsSettings.js#L90) |
| POST | `/report/daily/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:95](../server/src/routes/admin/opsSettings.js#L95) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:168](../server/src/routes/admin/idracCore.js#L168) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:131](../server/src/routes/admin/idracCore.js#L131) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:153](../server/src/routes/admin/idracCore.js#L153) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:142](../server/src/routes/admin/opsSettings.js#L142) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:145](../server/src/routes/admin/opsSettings.js#L145) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:311](../server/src/routes/admin/backupNetSec.js#L311) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:317](../server/src/routes/admin/backupNetSec.js#L317) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:333](../server/src/routes/admin/backupNetSec.js#L333) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:334](../server/src/routes/admin/backupNetSec.js#L334) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:286](../server/src/routes/admin/backupNetSec.js#L286) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:304](../server/src/routes/admin/backupNetSec.js#L304) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:303](../server/src/routes/admin/backupNetSec.js#L303) |
| GET | `/security/login-fails/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:302](../server/src/routes/admin/backupNetSec.js#L302) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:307](../server/src/routes/admin/backupNetSec.js#L307) |
| GET | `/security/self-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/securityCheck.js:22](../server/src/routes/admin/securityCheck.js#L22) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:169](../server/src/routes/admin/opsSettings.js#L169) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:170](../server/src/routes/admin/opsSettings.js#L170) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:210](../server/src/routes/admin/statusTools.js#L210) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:19](../server/src/routes/admin/toolCategories.js#L19) |
| PUT | `/tool-categories` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/toolCategories.js:28](../server/src/routes/admin/toolCategories.js#L28) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:47](../server/src/routes/admin/toolCategories.js#L47) |
| PUT | `/user-tools/:username` | 역할 `admin` | [server/src/routes/admin/users.js:141](../server/src/routes/admin/users.js#L141) |
| GET | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:65](../server/src/routes/admin/users.js#L65) |
| POST | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:75](../server/src/routes/admin/users.js#L75) |
| DELETE | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:97](../server/src/routes/admin/users.js#L97) |
| PATCH | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:86](../server/src/routes/admin/users.js#L86) |
| DELETE | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:206](../server/src/routes/admin/users.js#L206) |
| POST | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:198](../server/src/routes/admin/users.js#L198) |
| POST | `/users/:username/totp/begin` | 역할 `admin` | [server/src/routes/admin/users.js:219](../server/src/routes/admin/users.js#L219) |
| POST | `/users/:username/totp/confirm` | 역할 `admin` | [server/src/routes/admin/users.js:225](../server/src/routes/admin/users.js#L225) |
| POST | `/users/:username/totp/disable` | 역할 `admin` | [server/src/routes/admin/users.js:231](../server/src/routes/admin/users.js#L231) |
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:124](../server/src/routes/admin/vcenters.js#L124) |
| PUT | `/vcenter-order` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:133](../server/src/routes/admin/vcenters.js#L133) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:92](../server/src/routes/admin/statusTools.js#L92) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:47](../server/src/routes/admin/vcenters.js#L47) |
| POST | `/vcenters` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:65](../server/src/routes/admin/vcenters.js#L65) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:80](../server/src/routes/admin/vcenters.js#L80) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:72](../server/src/routes/admin/vcenters.js#L72) |
| POST | `/vcenters/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:94](../server/src/routes/admin/nsxImport.js#L94) |
| POST | `/vcenters/import-file` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:111](../server/src/routes/admin/nsxImport.js#L111) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/nsxImport.js:103](../server/src/routes/admin/nsxImport.js#L103) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:88](../server/src/routes/admin/vcenters.js#L88) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:104](../server/src/routes/admin/vcenters.js#L104) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:165](../server/src/routes/admin/backupNetSec.js#L165) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:151](../server/src/routes/admin/backupNetSec.js#L151) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:148](../server/src/routes/admin/backupNetSec.js#L148) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:325](../server/src/routes/admin/collectorsDc.js#L325) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:348](../server/src/routes/admin/collectorsDc.js#L348) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:252](../server/src/routes/auth.js#L252) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` · `requireSettingsOwner` | [server/src/routes/auth.js:260](../server/src/routes/auth.js#L260) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:265](../server/src/routes/auth.js#L265) |
| GET | `/config` | — | [server/src/routes/auth.js:26](../server/src/routes/auth.js#L26) |
| POST | `/extend` | `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:183](../server/src/routes/auth.js#L183) |
| POST | `/login` | — | [server/src/routes/auth.js:47](../server/src/routes/auth.js#L47) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:152](../server/src/routes/auth.js#L152) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:232](../server/src/routes/auth.js#L232) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:236](../server/src/routes/auth.js#L236) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:221](../server/src/routes/ping.js#L221) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:231](../server/src/routes/ping.js#L231) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:176](../server/src/routes/ping.js#L176) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:182](../server/src/routes/ping.js#L182) |
| GET | `/series` | — | [server/src/routes/ping.js:96](../server/src/routes/ping.js#L96) |
| GET | `/status` | — | [server/src/routes/ping.js:78](../server/src/routes/ping.js#L78) |
| GET | `/targets` | — | [server/src/routes/ping.js:91](../server/src/routes/ping.js#L91) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:149](../server/src/routes/ping.js#L149) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:157](../server/src/routes/ping.js#L157) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:153](../server/src/routes/ping.js#L153) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:238](../server/src/routes/ping.js#L238) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:252](../server/src/routes/ping.js#L252) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:254](../server/src/routes/ping.js#L254) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:260](../server/src/routes/ping.js#L260) |

## `/metrics`

Prometheus/OTel 익스포터(선택 토큰).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/metricsExport.js:29](../server/src/routes/metricsExport.js#L29) |

## `/api/v1`

**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/publicApi.js:170](../server/src/routes/publicApi.js#L170) |
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:273](../server/src/routes/publicApi.js#L273) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:288](../server/src/routes/publicApi.js#L288) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:360](../server/src/routes/publicApi.js#L360) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:411](../server/src/routes/publicApi.js#L411) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:426](../server/src/routes/publicApi.js#L426) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:244](../server/src/routes/publicApi.js#L244) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:187](../server/src/routes/publicApi.js#L187) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:229](../server/src/routes/publicApi.js#L229) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:180](../server/src/routes/publicApi.js#L180) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:503](../server/src/routes/api/inventory.js#L503) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:506](../server/src/routes/api/inventory.js#L506) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:514](../server/src/routes/api/inventory.js#L514) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:486](../server/src/routes/api/inventory.js#L486) |
| GET | `/board/posts` | — | [server/src/routes/api/bulletin.js:72](../server/src/routes/api/bulletin.js#L72) |
| POST | `/board/posts` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:81](../server/src/routes/api/bulletin.js#L81) |
| DELETE | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:96](../server/src/routes/api/bulletin.js#L96) |
| GET | `/board/posts/:id` | — | [server/src/routes/api/bulletin.js:77](../server/src/routes/api/bulletin.js#L77) |
| PUT | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:88](../server/src/routes/api/bulletin.js#L88) |
| POST | `/board/posts/:id/comments` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:104](../server/src/routes/api/bulletin.js#L104) |
| DELETE | `/board/posts/:id/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:112](../server/src/routes/api/bulletin.js#L112) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:401](../server/src/routes/api/inventory.js#L401) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:409](../server/src/routes/api/inventory.js#L409) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:130](../server/src/routes/api/overviewNsx.js#L130) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:244](../server/src/routes/api/inventory.js#L244) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:133](../server/src/routes/api/vmMetrics.js#L133) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:189](../server/src/routes/api/vmMetrics.js#L189) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:420](../server/src/routes/api/inventory.js#L420) |
| GET | `/notices` | — | [server/src/routes/api/bulletin.js:44](../server/src/routes/api/bulletin.js#L44) |
| POST | `/notices` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:47](../server/src/routes/api/bulletin.js#L47) |
| DELETE | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:62](../server/src/routes/api/bulletin.js#L62) |
| PUT | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:54](../server/src/routes/api/bulletin.js#L54) |
| GET | `/notices/active` | — | [server/src/routes/api/bulletin.js:40](../server/src/routes/api/bulletin.js#L40) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:229](../server/src/routes/api/overviewNsx.js#L229) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:263](../server/src/routes/api/overviewNsx.js#L263) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:180](../server/src/routes/api/overviewNsx.js#L180) |
| GET | `/overview/cards` | — | [server/src/routes/api/overviewCards.js:147](../server/src/routes/api/overviewCards.js#L147) |
| GET | `/overview/trend` | — | [server/src/routes/api/overviewCards.js:200](../server/src/routes/api/overviewCards.js#L200) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:115](../server/src/routes/api/perfClient.js#L115) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:74](../server/src/routes/api/perfClient.js#L74) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:104](../server/src/routes/api/perfClient.js#L104) |
| GET | `/provision/jobs` | — | [server/src/routes/api/provision.js:59](../server/src/routes/api/provision.js#L59) |
| GET | `/provision/jobs/:id` | — | [server/src/routes/api/provision.js:64](../server/src/routes/api/provision.js#L64) |
| GET | `/provision/placement` | 권한 `vm.provision` | [server/src/routes/api/provision.js:28](../server/src/routes/api/provision.js#L28) |
| POST | `/provision/preview` | 권한 `vm.provision` | [server/src/routes/api/provision.js:40](../server/src/routes/api/provision.js#L40) |
| GET | `/provision/saved` | 권한 `vm.provision` | [server/src/routes/api/provision.js:45](../server/src/routes/api/provision.js#L45) |
| GET | `/provision/saved/:id` | 권한 `vm.provision` | [server/src/routes/api/provision.js:48](../server/src/routes/api/provision.js#L48) |
| GET | `/provision/sources` | 권한 `vm.provision` | [server/src/routes/api/provision.js:21](../server/src/routes/api/provision.js#L21) |
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:33](../server/src/routes/api/searchNotes.js#L33) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:15](../server/src/routes/api/searchNotes.js#L15) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:75](../server/src/routes/api/inventory.js#L75) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:533](../server/src/routes/api/inventory.js#L533) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:529](../server/src/routes/api/inventory.js#L529) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:25](../server/src/routes/api/bmstor.js#L25) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:136](../server/src/routes/api/bmstor.js#L136) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:80](../server/src/routes/api/bmstor.js#L80) |
| GET | `/tools/bm-storage/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:41](../server/src/routes/api/bmstor.js#L41) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:100](../server/src/routes/api/bmstor.js#L100) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:94](../server/src/routes/api/bmstor.js#L94) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:58](../server/src/routes/api/bmstor.js#L58) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:64](../server/src/routes/api/bmstor.js#L64) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:71](../server/src/routes/api/bmstor.js#L71) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:185](../server/src/routes/api/bmUsage.js#L185) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:346](../server/src/routes/api/bmUsage.js#L346) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:319](../server/src/routes/api/bmUsage.js#L319) |
| PUT | `/tools/bm-usage/distribute` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/bmUsage.js:525](../server/src/routes/api/bmUsage.js#L525) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:404](../server/src/routes/api/bmUsage.js#L404) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:484](../server/src/routes/api/bmUsage.js#L484) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:274](../server/src/routes/api/bmUsage.js#L274) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:537](../server/src/routes/api/bmUsage.js#L537) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:68](../server/src/routes/api/toolsCapacity.js#L68) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1626](../server/src/routes/api/toolsCapacity.js#L1626) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1537](../server/src/routes/api/toolsCapacity.js#L1537) |
| GET | `/tools/cluster-check` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:35](../server/src/routes/api/clusterCheck.js#L35) |
| GET | `/tools/cluster-check.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/clusterCheck.js:57](../server/src/routes/api/clusterCheck.js#L57) |
| GET | `/tools/cluster-check/of` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:46](../server/src/routes/api/clusterCheck.js#L46) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:93](../server/src/routes/api/commMap.js#L93) |
| GET | `/tools/contention` | 권한 `tools` | [server/src/routes/api/contention.js:32](../server/src/routes/api/contention.js#L32) |
| GET | `/tools/contention.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/contention.js:54](../server/src/routes/api/contention.js#L54) |
| GET | `/tools/core-license` | 권한 `tools` | [server/src/routes/api/coreLicense.js:28](../server/src/routes/api/coreLicense.js#L28) |
| GET | `/tools/core-license.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/coreLicense.js:33](../server/src/routes/api/coreLicense.js#L33) |
| GET | `/tools/corp-usage` | 권한 `tools` | [server/src/routes/api/corpUsage.js:98](../server/src/routes/api/corpUsage.js#L98) |
| GET | `/tools/cost-showback` | 권한 `tools` | [server/src/routes/api/costShowback.js:32](../server/src/routes/api/costShowback.js#L32) |
| GET | `/tools/cost-showback.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/costShowback.js:49](../server/src/routes/api/costShowback.js#L49) |
| GET | `/tools/cost-showback/settings` | 권한 `tools` | [server/src/routes/api/costShowback.js:36](../server/src/routes/api/costShowback.js#L36) |
| PUT | `/tools/cost-showback/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/costShowback.js:38](../server/src/routes/api/costShowback.js#L38) |
| GET | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:45](../server/src/routes/api/credentials.js#L45) |
| POST | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:55](../server/src/routes/api/credentials.js#L55) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:75](../server/src/routes/api/credentials.js#L75) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:65](../server/src/routes/api/credentials.js#L65) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:83](../server/src/routes/api/credentials.js#L83) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:50](../server/src/routes/api/credentials.js#L50) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:294](../server/src/routes/api/horizonSessions.js#L294) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:47](../server/src/routes/api/curUser.js#L47) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:113](../server/src/routes/api/curUser.js#L113) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:217](../server/src/routes/api/curUser.js#L217) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:128](../server/src/routes/api/curUser.js#L128) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:82](../server/src/routes/api/curUser.js#L82) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:139](../server/src/routes/api/curUser.js#L139) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:179](../server/src/routes/api/curUser.js#L179) |
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:239](../server/src/routes/api/cvp.js#L239) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:693](../server/src/routes/api/cvp.js#L693) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:335](../server/src/routes/api/cvp.js#L335) |
| GET | `/tools/cvp/device-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:396](../server/src/routes/api/cvp.js#L396) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:268](../server/src/routes/api/cvp.js#L268) |
| GET | `/tools/cvp/devices.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:653](../server/src/routes/api/cvp.js#L653) |
| GET | `/tools/cvp/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:413](../server/src/routes/api/cvp.js#L413) |
| GET | `/tools/cvp/faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:579](../server/src/routes/api/cvp.js#L579) |
| POST | `/tools/cvp/faults/close` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:619](../server/src/routes/api/cvp.js#L619) |
| POST | `/tools/cvp/faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:607](../server/src/routes/api/cvp.js#L607) |
| GET | `/tools/cvp/optics` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:464](../server/src/routes/api/cvp.js#L464) |
| GET | `/tools/cvp/overview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:291](../server/src/routes/api/cvp.js#L291) |
| POST | `/tools/cvp/parse-preview` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:640](../server/src/routes/api/cvp.js#L640) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:678](../server/src/routes/api/cvp.js#L678) |
| GET | `/tools/cvp/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:553](../server/src/routes/api/cvp.js#L553) |
| GET | `/tools/cvp/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:510](../server/src/routes/api/cvp.js#L510) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:716](../server/src/routes/api/cvp.js#L716) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:742](../server/src/routes/api/cvp.js#L742) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:745](../server/src/routes/api/cvp.js#L745) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:743](../server/src/routes/api/cvp.js#L743) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:756](../server/src/routes/api/cvp.js#L756) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:784](../server/src/routes/api/cvp.js#L784) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:787](../server/src/routes/api/cvp.js#L787) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:62](../server/src/routes/api/dataFlow.js#L62) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:108](../server/src/routes/api/checksLogs.js#L108) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:29](../server/src/routes/api/deviceFlow.js#L29) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:23](../server/src/routes/api/vcTools.js#L23) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:427](../server/src/routes/api/hardwareGpu.js#L427) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1230](../server/src/routes/api/toolsCapacity.js#L1230) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1345](../server/src/routes/api/toolsCapacity.js#L1345) |
| GET | `/tools/esxi-temp/sensors` | 권한 `tools` | [server/src/routes/api/serverSensors.js:138](../server/src/routes/api/serverSensors.js#L138) |
| GET | `/tools/esxi-temp/sensors/:id` | 권한 `tools` | [server/src/routes/api/serverSensors.js:181](../server/src/routes/api/serverSensors.js#L181) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1428](../server/src/routes/api/toolsCapacity.js#L1428) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:446](../server/src/routes/api/hardwareGpu.js#L446) |
| GET | `/tools/gpu.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:460](../server/src/routes/api/hardwareGpu.js#L460) |
| GET | `/tools/gpu.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:452](../server/src/routes/api/hardwareGpu.js#L452) |
| GET | `/tools/gpu/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:490](../server/src/routes/api/hardwareGpu.js#L490) |
| GET | `/tools/gpu/export.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:491](../server/src/routes/api/hardwareGpu.js#L491) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:187](../server/src/routes/api/toolsAnalytics.js#L187) |
| GET | `/tools/gpu/host` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:531](../server/src/routes/api/hardwareGpu.js#L531) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:476](../server/src/routes/api/hardwareGpu.js#L476) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:547](../server/src/routes/api/hardwareGpu.js#L547) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:392](../server/src/routes/api/toolsCapacity.js#L392) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:23](../server/src/routes/api/toolsGuestDisk.js#L23) |
| GET | `/tools/guest-disk/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestDisk.js:46](../server/src/routes/api/toolsGuestDisk.js#L46) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:77](../server/src/routes/api/toolsGuestDisk.js#L77) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:60](../server/src/routes/api/toolsGuestDisk.js#L60) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:35](../server/src/routes/api/toolsGuestDisk.js#L35) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:44](../server/src/routes/api/toolsInfo.js#L44) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:62](../server/src/routes/api/toolsInfo.js#L62) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:395](../server/src/routes/api/hardwareGpu.js#L395) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:86](../server/src/routes/api/toolsInfo.js#L86) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:170](../server/src/routes/api/horizonSessions.js#L170) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:224](../server/src/routes/api/horizonSessions.js#L224) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:237](../server/src/routes/api/horizonSessions.js#L237) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:208](../server/src/routes/api/horizonSessions.js#L208) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:247](../server/src/routes/api/horizonSessions.js#L247) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:267](../server/src/routes/api/horizonSessions.js#L267) |
| GET | `/tools/horizon-sessions/usage` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:134](../server/src/routes/api/horizonSessions.js#L134) |
| GET | `/tools/horizon-sessions/usage.csv` | 권한 `data.csv` | [server/src/routes/api/horizonSessions.js:149](../server/src/routes/api/horizonSessions.js#L149) |
| GET | `/tools/host-hygiene` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:39](../server/src/routes/api/hostHygiene.js#L39) |
| GET | `/tools/host-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hostHygiene.js:75](../server/src/routes/api/hostHygiene.js#L75) |
| GET | `/tools/host-hygiene/reboots` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:51](../server/src/routes/api/hostHygiene.js#L51) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:36](../server/src/routes/api/toolsAnalytics.js#L36) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:521](../server/src/routes/api/hardwareGpu.js#L521) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:496](../server/src/routes/api/hardwareGpu.js#L496) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:118](../server/src/routes/api/ipamExport.js#L118) |
| GET | `/tools/ipam.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:473](../server/src/routes/api/ipamExport.js#L473) |
| GET | `/tools/ipam.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:452](../server/src/routes/api/ipamExport.js#L452) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:246](../server/src/routes/api/ipamExport.js#L246) |
| PUT | `/tools/ipam/annotation` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:257](../server/src/routes/api/ipamExport.js#L257) |
| POST | `/tools/ipam/bulk` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:326](../server/src/routes/api/ipamExport.js#L326) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:170](../server/src/routes/api/ipamExport.js#L170) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:153](../server/src/routes/api/ipamExport.js#L153) |
| DELETE | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:312](../server/src/routes/api/ipamExport.js#L312) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:285](../server/src/routes/api/ipamExport.js#L285) |
| PUT | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:298](../server/src/routes/api/ipamExport.js#L298) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:273](../server/src/routes/api/ipamExport.js#L273) |
| GET | `/tools/ipam/manage.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:525](../server/src/routes/api/ipamExport.js#L525) |
| POST | `/tools/ipam/manage/import` | 역할 `admin/operator` · 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:550](../server/src/routes/api/ipamExport.js#L550) |
| GET | `/tools/ipam/manage/sample.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:539](../server/src/routes/api/ipamExport.js#L539) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:212](../server/src/routes/api/ipamExport.js#L212) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:353](../server/src/routes/api/ipamExport.js#L353) |
| POST | `/tools/ipam/policies` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:384](../server/src/routes/api/ipamExport.js#L384) |
| DELETE | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:428](../server/src/routes/api/ipamExport.js#L428) |
| PUT | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:401](../server/src/routes/api/ipamExport.js#L401) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:362](../server/src/routes/api/ipamExport.js#L362) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:379](../server/src/routes/api/ipamExport.js#L379) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:221](../server/src/routes/api/ipamExport.js#L221) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:163](../server/src/routes/api/ipamExport.js#L163) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:159](../server/src/routes/api/ipamExport.js#L159) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:178](../server/src/routes/api/ipamExport.js#L178) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:200](../server/src/routes/api/ipamExport.js#L200) |
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:160](../server/src/routes/api/toolsInfo.js#L160) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:110](../server/src/routes/api/toolsInfo.js#L110) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:53](../server/src/routes/api/linkCheck.js#L53) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:180](../server/src/routes/api/linkCheck.js#L180) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:165](../server/src/routes/api/linkCheck.js#L165) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:152](../server/src/routes/api/linkCheck.js#L152) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:190](../server/src/routes/api/linkCheck.js#L190) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:141](../server/src/routes/api/linkCheck.js#L141) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:206](../server/src/routes/api/linkCheck.js#L206) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:271](../server/src/routes/api/linkCheck.js#L271) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:219](../server/src/routes/api/linkCheck.js#L219) |
| GET | `/tools/migration-readiness` | 권한 `tools` | [server/src/routes/api/migrationReadiness.js:29](../server/src/routes/api/migrationReadiness.js#L29) |
| GET | `/tools/migration-readiness.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/migrationReadiness.js:33](../server/src/routes/api/migrationReadiness.js#L33) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:159](../server/src/routes/api/checksLogs.js#L159) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1699](../server/src/routes/api/toolsCapacity.js#L1699) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1663](../server/src/routes/api/toolsCapacity.js#L1663) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:206](../server/src/routes/api/partFaults.js#L206) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:304](../server/src/routes/api/partFaults.js#L304) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:238](../server/src/routes/api/partFaults.js#L238) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:319](../server/src/routes/api/partFaults.js#L319) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:271](../server/src/routes/api/partFaults.js#L271) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:291](../server/src/routes/api/partFaults.js#L291) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:281](../server/src/routes/api/partFaults.js#L281) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:58](../server/src/routes/api/pdu.js#L58) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:138](../server/src/routes/api/pdu.js#L138) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:287](../server/src/routes/api/pdu.js#L287) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:172](../server/src/routes/api/pdu.js#L172) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:204](../server/src/routes/api/pdu.js#L204) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:198](../server/src/routes/api/pdu.js#L198) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:130](../server/src/routes/api/pdu.js#L130) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:251](../server/src/routes/api/pdu.js#L251) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:257](../server/src/routes/api/pdu.js#L257) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:267](../server/src/routes/api/pdu.js#L267) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:245](../server/src/routes/api/pdu.js#L245) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:159](../server/src/routes/api/pdu.js#L159) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:148](../server/src/routes/api/pdu.js#L148) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:228](../server/src/routes/api/pdu.js#L228) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:121](../server/src/routes/api/pdu.js#L121) |
| GET | `/tools/portal-check/arch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:338](../server/src/routes/api/portalCheck.js#L338) |
| POST | `/tools/portal-check/arch/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:339](../server/src/routes/api/portalCheck.js#L339) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:360](../server/src/routes/api/portalCheck.js#L360) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:199](../server/src/routes/api/portalCheck.js#L199) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:268](../server/src/routes/api/portalCheck.js#L268) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:232](../server/src/routes/api/portalCheck.js#L232) |
| GET | `/tools/power-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/overviewCards.js:222](../server/src/routes/api/overviewCards.js#L222) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:19](../server/src/routes/api/relaycheck.js#L19) |
| POST | `/tools/relaycheck/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:44](../server/src/routes/api/relaycheck.js#L44) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:37](../server/src/routes/api/relaycheck.js#L37) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:38](../server/src/routes/api/relaytopo.js#L38) |
| PUT | `/tools/relaytopo` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:73](../server/src/routes/api/relaytopo.js#L73) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:130](../server/src/routes/api/relaytopo.js#L130) |
| GET | `/tools/relaytopo/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:101](../server/src/routes/api/relaytopo.js#L101) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:121](../server/src/routes/api/relaytopo.js#L121) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:125](../server/src/routes/api/relaytopo.js#L125) |
| POST | `/tools/relaytopo/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:83](../server/src/routes/api/relaytopo.js#L83) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:114](../server/src/routes/api/relaytopo.js#L114) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:139](../server/src/routes/api/relaytopo.js#L139) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:143](../server/src/routes/api/reports.js#L143) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:131](../server/src/routes/api/reports.js#L131) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:112](../server/src/routes/api/reports.js#L112) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:166](../server/src/routes/api/reports.js#L166) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:159](../server/src/routes/api/reports.js#L159) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:72](../server/src/routes/api/reports.js#L72) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:117](../server/src/routes/api/reports.js#L117) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:82](../server/src/routes/api/reports.js#L82) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:194](../server/src/routes/api/reports.js#L194) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:106](../server/src/routes/api/reports.js#L106) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1069](../server/src/routes/api/toolsCapacity.js#L1069) |
| GET | `/tools/rma` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:35](../server/src/routes/api/rma.js#L35) |
| PUT | `/tools/rma/agents/:agent/access` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:92](../server/src/routes/api/rma.js#L92) |
| PUT | `/tools/rma/agents/:agent/mode` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:171](../server/src/routes/api/rma.js#L171) |
| PUT | `/tools/rma/agents/:agent/password` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:160](../server/src/routes/api/rma.js#L160) |
| PUT | `/tools/rma/agents/:agent/remote` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:101](../server/src/routes/api/rma.js#L101) |
| GET | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:48](../server/src/routes/api/rma.js#L48) |
| PUT | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:51](../server/src/routes/api/rma.js#L51) |
| DELETE | `/tools/rma/agents/:agent/schedule/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:64](../server/src/routes/api/rma.js#L64) |
| POST | `/tools/rma/deploy` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:208](../server/src/routes/api/rma.js#L208) |
| POST | `/tools/rma/deploy/list` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:201](../server/src/routes/api/rma.js#L201) |
| POST | `/tools/rma/deploy/remove` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:225](../server/src/routes/api/rma.js#L225) |
| GET | `/tools/rma/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:155](../server/src/routes/api/rma.js#L155) |
| GET | `/tools/rma/jobs/:reqId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:151](../server/src/routes/api/rma.js#L151) |
| POST | `/tools/rma/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:112](../server/src/routes/api/rma.js#L112) |
| PUT | `/tools/rma/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:180](../server/src/routes/api/rma.js#L180) |
| GET | `/tools/rma/tests/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:87](../server/src/routes/api/rma.js#L87) |
| GET | `/tools/rma/tests/results` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:76](../server/src/routes/api/rma.js#L76) |
| POST | `/tools/rma/tests/validate` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:71](../server/src/routes/api/rma.js#L71) |
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:130](../server/src/routes/api/sanSwitch.js#L130) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:831](../server/src/routes/api/sanSwitch.js#L831) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:855](../server/src/routes/api/sanSwitch.js#L855) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:254](../server/src/routes/api/sanSwitch.js#L254) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:262](../server/src/routes/api/sanSwitch.js#L262) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:311](../server/src/routes/api/sanSwitch.js#L311) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:578](../server/src/routes/api/sanSwitch.js#L578) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:566](../server/src/routes/api/sanSwitch.js#L566) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:458](../server/src/routes/api/sanSwitch.js#L458) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:499](../server/src/routes/api/sanSwitch.js#L499) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:644](../server/src/routes/api/sanSwitch.js#L644) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:654](../server/src/routes/api/sanSwitch.js#L654) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:169](../server/src/routes/api/sanSwitch.js#L169) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:200](../server/src/routes/api/sanSwitch.js#L200) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:928](../server/src/routes/api/sanSwitch.js#L928) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:936](../server/src/routes/api/sanSwitch.js#L936) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1019](../server/src/routes/api/sanSwitch.js#L1019) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:964](../server/src/routes/api/sanSwitch.js#L964) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1007](../server/src/routes/api/sanSwitch.js#L1007) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:944](../server/src/routes/api/sanSwitch.js#L944) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:950](../server/src/routes/api/sanSwitch.js#L950) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:516](../server/src/routes/api/sanSwitch.js#L516) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:589](../server/src/routes/api/sanSwitch.js#L589) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:380](../server/src/routes/api/sanSwitch.js#L380) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:363](../server/src/routes/api/sanSwitch.js#L363) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:340](../server/src/routes/api/sanSwitch.js#L340) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:348](../server/src/routes/api/sanSwitch.js#L348) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:671](../server/src/routes/api/sanSwitch.js#L671) |
| GET | `/tools/sanswitch/perf/traffic-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:777](../server/src/routes/api/sanSwitch.js#L777) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:879](../server/src/routes/api/sanSwitch.js#L879) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:278](../server/src/routes/api/sanSwitch.js#L278) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:300](../server/src/routes/api/sanSwitch.js#L300) |
| GET | `/tools/secret-scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/toolsInfo.js:35](../server/src/routes/api/toolsInfo.js#L35) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:60](../server/src/routes/api/serialLookup.js#L60) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:88](../server/src/routes/api/serialLookup.js#L88) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:132](../server/src/routes/api/checksLogs.js#L132) |
| POST | `/tools/service-check/settings-files/confirm` | 역할 `admin` · `settingsFleetOnly` | [server/src/routes/api/checksLogs.js:145](../server/src/routes/api/checksLogs.js#L145) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:146](../server/src/routes/api/vcTools.js#L146) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:59](../server/src/routes/api/vcTools.js#L59) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:80](../server/src/routes/api/storageMon.js#L80) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:611](../server/src/routes/api/storageMon.js#L611) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:686](../server/src/routes/api/storageMon.js#L686) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:698](../server/src/routes/api/storageMon.js#L698) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:706](../server/src/routes/api/storageMon.js#L706) |
| GET | `/tools/storage-paths` | 권한 `tools` | [server/src/routes/api/storagePaths.js:34](../server/src/routes/api/storagePaths.js#L34) |
| GET | `/tools/storage-paths.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/storagePaths.js:42](../server/src/routes/api/storagePaths.js#L42) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:225](../server/src/routes/api/storageMon.js#L225) |
| POST | `/tools/storage/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:238](../server/src/routes/api/storageMon.js#L238) |
| POST | `/tools/storage/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:203](../server/src/routes/api/storageMon.js#L203) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:213](../server/src/routes/api/storageMon.js#L213) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:549](../server/src/routes/api/storageMon.js#L549) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:554](../server/src/routes/api/storageMon.js#L554) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:265](../server/src/routes/api/storageMon.js#L265) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:589](../server/src/routes/api/storageMon.js#L589) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:355](../server/src/routes/api/storageMon.js#L355) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:379](../server/src/routes/api/storageMon.js#L379) |
| POST | `/tools/storage/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:402](../server/src/routes/api/storageMon.js#L402) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:485](../server/src/routes/api/storageMon.js#L485) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:542](../server/src/routes/api/storageMon.js#L542) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:370](../server/src/routes/api/storageMon.js#L370) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:387](../server/src/routes/api/storageMon.js#L387) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:717](../server/src/routes/api/storageMon.js#L717) |
| GET | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:295](../server/src/routes/api/storageMon.js#L295) |
| PUT | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:313](../server/src/routes/api/storageMon.js#L313) |
| POST | `/tools/storage/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:149](../server/src/routes/api/storageMon.js#L149) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1117](../server/src/routes/api/toolsCapacity.js#L1117) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:119](../server/src/routes/api/toolsAnalytics.js#L119) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:282](../server/src/routes/api/checksLogs.js#L282) |
| GET | `/tools/vclogs/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/checksLogs.js:298](../server/src/routes/api/checksLogs.js#L298) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:269](../server/src/routes/api/checksLogs.js#L269) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:250](../server/src/routes/api/checksLogs.js#L250) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:218](../server/src/routes/api/checksLogs.js#L218) |
| GET | `/tools/vm-availability` | 권한 `tools` | [server/src/routes/api/vmAvailability.js:71](../server/src/routes/api/vmAvailability.js#L71) |
| GET | `/tools/vm-availability.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmAvailability.js:75](../server/src/routes/api/vmAvailability.js#L75) |
| GET | `/tools/vm-changes` | 권한 `tools` | [server/src/routes/api/vmChanges.js:48](../server/src/routes/api/vmChanges.js#L48) |
| GET | `/tools/vm-changes.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmChanges.js:76](../server/src/routes/api/vmChanges.js#L76) |
| GET | `/tools/vm-changes/of` | 권한 `tools` | [server/src/routes/api/vmChanges.js:61](../server/src/routes/api/vmChanges.js#L61) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:32](../server/src/routes/api/vmClone.js#L32) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:109](../server/src/routes/api/vmClone.js#L109) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:47](../server/src/routes/api/vmClone.js#L47) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:83](../server/src/routes/api/vmClone.js#L83) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:94](../server/src/routes/api/vmClone.js#L94) |
| GET | `/tools/vm-dns` | 권한 `tools` | [server/src/routes/api/vmDns.js:128](../server/src/routes/api/vmDns.js#L128) |
| GET | `/tools/vm-dns.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmDns.js:220](../server/src/routes/api/vmDns.js#L220) |
| GET | `/tools/vm-dns/changes` | 권한 `tools` | [server/src/routes/api/vmDns.js:167](../server/src/routes/api/vmDns.js#L167) |
| GET | `/tools/vm-dns/policy` | 권한 `tools` | [server/src/routes/api/vmDns.js:180](../server/src/routes/api/vmDns.js#L180) |
| PUT | `/tools/vm-dns/policy` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:192](../server/src/routes/api/vmDns.js#L192) |
| POST | `/tools/vm-dns/probe` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:208](../server/src/routes/api/vmDns.js#L208) |
| GET | `/tools/vm-dns/server` | 권한 `tools` | [server/src/routes/api/vmDns.js:147](../server/src/routes/api/vmDns.js#L147) |
| GET | `/tools/vm-dns/vm` | 권한 `tools` | [server/src/routes/api/vmDns.js:157](../server/src/routes/api/vmDns.js#L157) |
| GET | `/tools/vm-export` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:132](../server/src/routes/api/ipamExport.js#L132) |
| GET | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:141](../server/src/routes/api/ipamExport.js#L141) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1145](../server/src/routes/api/toolsCapacity.js#L1145) |
| GET | `/tools/vm-hygiene` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:42](../server/src/routes/api/vmHygiene.js#L42) |
| GET | `/tools/vm-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmHygiene.js:76](../server/src/routes/api/vmHygiene.js#L76) |
| POST | `/tools/vm-hygiene/notify-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:70](../server/src/routes/api/vmHygiene.js#L70) |
| GET | `/tools/vm-hygiene/settings` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:48](../server/src/routes/api/vmHygiene.js#L48) |
| PUT | `/tools/vm-hygiene/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:59](../server/src/routes/api/vmHygiene.js#L59) |
| GET | `/tools/vm-lifecycle` | 권한 `tools` | [server/src/routes/api/vmLifecycle.js:61](../server/src/routes/api/vmLifecycle.js#L61) |
| GET | `/tools/vm-lifecycle.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmLifecycle.js:71](../server/src/routes/api/vmLifecycle.js#L71) |
| GET | `/tools/vm-tags` | 권한 `tools` | [server/src/routes/api/vmTags.js:46](../server/src/routes/api/vmTags.js#L46) |
| GET | `/tools/vm-tags.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmTags.js:86](../server/src/routes/api/vmTags.js#L86) |
| GET | `/tools/vm-tags/of` | 권한 `tools` | [server/src/routes/api/vmTags.js:62](../server/src/routes/api/vmTags.js#L62) |
| GET | `/tools/vm-tags/policy` | 권한 `tools` | [server/src/routes/api/vmTags.js:78](../server/src/routes/api/vmTags.js#L78) |
| PUT | `/tools/vm-tags/policy` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmTags.js:79](../server/src/routes/api/vmTags.js#L79) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:18](../server/src/routes/api/vmtrack.js#L18) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:47](../server/src/routes/api/vmtrack.js#L47) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:124](../server/src/routes/api/vmtrack.js#L124) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:61](../server/src/routes/api/vmtrack.js#L61) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:75](../server/src/routes/api/vmtrack.js#L75) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:141](../server/src/routes/api/vmtrack.js#L141) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:87](../server/src/routes/api/vmtrack.js#L87) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:102](../server/src/routes/api/vmtrack.js#L102) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:162](../server/src/routes/api/vmtrack.js#L162) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:179](../server/src/routes/api/vmtrack.js#L179) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:219](../server/src/routes/api/vmSeries.js#L219) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:183](../server/src/routes/api/vmSeries.js#L183) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:175](../server/src/routes/api/vmSeries.js#L175) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:158](../server/src/routes/api/vmSeries.js#L158) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:87](../server/src/routes/api/vmSeries.js#L87) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:105](../server/src/routes/api/vmSeries.js#L105) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:170](../server/src/routes/api/vmSeries.js#L170) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:197](../server/src/routes/api/vmSeries.js#L197) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:123](../server/src/routes/api/vcTools.js#L123) |
| GET | `/tools/vmware-config` | 권한 `tools` | [server/src/routes/api/checksLogs.js:166](../server/src/routes/api/checksLogs.js#L166) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:261](../server/src/routes/api/toolsCapacity.js#L261) |
| GET | `/tools/waste/export` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsCapacity.js:440](../server/src/routes/api/toolsCapacity.js#L440) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:628](../server/src/routes/api/toolsCapacity.js#L628) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:598](../server/src/routes/api/toolsCapacity.js#L598) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:612](../server/src/routes/api/toolsCapacity.js#L612) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:604](../server/src/routes/api/toolsCapacity.js#L604) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:403](../server/src/routes/api/toolsCapacity.js#L403) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:860](../server/src/routes/api/toolsCapacity.js#L860) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:881](../server/src/routes/api/toolsCapacity.js#L881) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:938](../server/src/routes/api/toolsCapacity.js#L938) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:975](../server/src/routes/api/toolsCapacity.js#L975) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:441](../server/src/routes/api/inventory.js#L441) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:302](../server/src/routes/api/toolsInfo.js#L302) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:304](../server/src/routes/api/toolsInfo.js#L304) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:12](../server/src/routes/api/vcTools.js#L12) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:718](../server/src/routes/api/toolsCapacity.js#L718) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:285](../server/src/routes/api/inventory.js#L285) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:160](../server/src/routes/api/vmMetrics.js#L160) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:102](../server/src/routes/api/vmMetrics.js#L102) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:374](../server/src/routes/api/inventory.js#L374) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:257](../server/src/routes/api/toolsInfo.js#L257) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:306](../server/src/routes/api/toolsCapacity.js#L306) |

## `/dl`

중앙 업그레이드 소스(`versions.json` + 번들). **공개**다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/:file` | — | [server/src/routes/dlsource.js:85](../server/src/routes/dlsource.js#L85) |
| GET | `/versions.json` | — | [server/src/routes/dlsource.js:81](../server/src/routes/dlsource.js#L81) |

---

## 게이트 헬퍼 용어집

표의 게이트 열에 나오는 이름 중 `역할`·`권한` 으로 환원되지 않는 것들입니다.

| 이름 | 붙은 라우트 | 뜻 |
|---|---:|---|
| `fullScopeOnly` | 213 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 187 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `requireCentral` | 52 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `csvPerm` | 37 | **CSV 가져오기/내보내기 권한**(`requirePerm('data.csv')` — v2.643). 관리자 이상만(super_admin 항상, admin 은 권한 설정에서 super_admin 이 끌 수 있다). operator·viewer 는 403. |
| `requireSettingsOwner` | 35 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `fleetReadOnly` | 10 | **전체 범위 계정만**(v2.621 SEC-03 — 폴더 사용량 조회. 응답이 RMA 엣지 IP·호스트명·마운트 경로를 싣는다 · v2.622 SEC-03 — GPU 게스트 엣지 배포 설정·엣지 배포 사용자·수집 진단 조회). 범위 제한 계정은 403. |
| `guarded` | 8 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `fullScopeOnlyWith` | 8 | **전체 범위 계정만**(사유 문구를 받는 `fullScopeOnly` — v2.628 SEC2628-01 업그레이드 제어·SEC2628-05 리소스 적정성 진단 등). 범위 제한 계정은 403. |
| `authMiddleware` | 7 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
| `requireEnrolled` | 4 | OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다. |
| `fleetFullScopeOnly` | 4 | **전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403. |
| `fleetWideOnly` | 3 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `noticeFleetOnly` | 3 | **전체 범위 계정만**(v2.722 — 접속 공지 작성·수정·삭제. 공지는 전 법인 사용자에게 보인다). 범위 제한 계정은 403. |
| `reauth` | 3 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `auditMiddleware` | 3 | 상태변경 감사 로그 기록. |
| `adFleetOnly` | 3 | **전체 범위 계정만**(v2.628 SEC2628-04 — AD 설정 조회·저장·연결 테스트. AD 는 전 사용자 공통 인증 소스다). 범위 제한 계정은 403. |
| `express.json` | 3 | 본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약). |
| `ownerIfAutoCentralToken` | 2 | 요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급). |
| `requireOwnOtp` | 2 | **본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다. |
| `express.raw` | 2 | 원시 바디 버퍼(업그레이드 번들 등). ⚠ 게이트가 아니다 — 인증을 이 앞에 두어 미인증 요청이 대용량 바디를 적재하지 못하게 한다. |
| `rawIpFleetOnly` | 1 | **전체 범위 계정만**(v2.621 SEC-02 — 요청 본문 IP 로 직접 SSH 접속하는 테스트. 정규형 IPv4·차단 대역 검사가 뒤따른다). 범위 제한 계정은 403. |
| `liveFleetOnly` | 1 | **전체 범위 계정만**(v2.629 A6-02 — iDRAC 에 실시간 로그인하는 GPU 조사). 범위 제한 계정은 403. |
| `settingsFleetOnly` | 1 | **전체 범위 계정만**(v2.633 — 손상 보존본만 남은 중앙 설정 파일을 기본값으로 확정. 그 기본값이 모든 엣지에 배포된다). 범위 제한 계정은 403. |
| `csvPermUnlessJson` | 1 | `csvPerm` 과 같되 **format=json(화면의 표·붙여넣기 등록)은 통과**(v2.643 — 성능점검 대상 등록 마법사). |

---

## 생성 정보

- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`
- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이
  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).

