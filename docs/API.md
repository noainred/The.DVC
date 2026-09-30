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
| 엔드포인트 | **880개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 84개 |
| GET | 468개 |
| POST | 275개 |
| PUT | 88개 |
| PATCH | 2개 |
| DELETE | 47개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 9 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 16 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 52 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 8 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 56 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 318 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 9 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 363 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
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
| GET | `/history` | — | [server/src/routes/capacity.js:69](../server/src/routes/capacity.js#L69) |
| GET | `/host` | — | [server/src/routes/capacity.js:57](../server/src/routes/capacity.js#L57) |
| GET | `/summary` | — | [server/src/routes/capacity.js:39](../server/src/routes/capacity.js#L39) |

## `/api/insights`

FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('insights')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/anomalies` | — | [server/src/routes/insights.js:271](../server/src/routes/insights.js#L271) |
| POST | `/chatops` | — | [server/src/routes/insights.js:337](../server/src/routes/insights.js#L337) |
| GET | `/finops` | — | [server/src/routes/insights.js:92](../server/src/routes/insights.js#L92) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:112](../server/src/routes/insights.js#L112) |
| PUT | `/finops/config` | 역할 `admin` · `fleetOnly` | [server/src/routes/insights.js:141](../server/src/routes/insights.js#L141) |
| GET | `/fleet` | — | [server/src/routes/insights.js:149](../server/src/routes/insights.js#L149) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:202](../server/src/routes/insights.js#L202) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:218](../server/src/routes/insights.js#L218) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:252](../server/src/routes/insights.js#L252) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:175](../server/src/routes/insights.js#L175) |
| GET | `/forecast` | — | [server/src/routes/insights.js:291](../server/src/routes/insights.js#L291) |
| GET | `/graph` | — | [server/src/routes/insights.js:316](../server/src/routes/insights.js#L316) |
| GET | `/incidents` | — | [server/src/routes/insights.js:331](../server/src/routes/insights.js#L331) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:115](../server/src/routes/insights.js#L115) |
| GET | `/security` | — | [server/src/routes/insights.js:303](../server/src/routes/insights.js#L303) |
| GET | `/topology` | — | [server/src/routes/insights.js:306](../server/src/routes/insights.js#L306) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central.js:1967](../server/src/routes/central.js#L1967) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:399](../server/src/routes/central.js#L399) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central.js:2052](../server/src/routes/central.js#L2052) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central.js:2056](../server/src/routes/central.js#L2056) |
| GET | `/bmusage-config` | `requireCentral` | [server/src/routes/central.js:1392](../server/src/routes/central.js#L1392) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:535](../server/src/routes/central.js#L535) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central.js:2031](../server/src/routes/central.js#L2031) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central.js:2035](../server/src/routes/central.js#L2035) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:921](../server/src/routes/central.js#L921) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:965](../server/src/routes/central.js#L965) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central.js:1813](../server/src/routes/central.js#L1813) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central.js:1840](../server/src/routes/central.js#L1840) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central.js:1345](../server/src/routes/central.js#L1345) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central.js:1352](../server/src/routes/central.js#L1352) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:995](../server/src/routes/central.js#L995) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1206](../server/src/routes/central.js#L1206) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1128](../server/src/routes/central.js#L1128) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:784](../server/src/routes/central.js#L784) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central.js:2152](../server/src/routes/central.js#L2152) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1052](../server/src/routes/central.js#L1052) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1062](../server/src/routes/central.js#L1062) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1074](../server/src/routes/central.js#L1074) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:684](../server/src/routes/central.js#L684) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central.js:2080](../server/src/routes/central.js#L2080) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central.js:2091](../server/src/routes/central.js#L2091) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central.js:2166](../server/src/routes/central.js#L2166) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central.js:2194](../server/src/routes/central.js#L2194) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central.js:2005](../server/src/routes/central.js#L2005) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central.js:2012](../server/src/routes/central.js#L2012) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central.js:1314](../server/src/routes/central.js#L1314) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central.js:1382](../server/src/routes/central.js#L1382) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central.js:1509](../server/src/routes/central.js#L1509) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central.js:1528](../server/src/routes/central.js#L1528) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central.js:1940](../server/src/routes/central.js#L1940) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central.js:1948](../server/src/routes/central.js#L1948) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:410](../server/src/routes/central.js#L410) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:488](../server/src/routes/central.js#L488) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central.js:1739](../server/src/routes/central.js#L1739) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central.js:1674](../server/src/routes/central.js#L1674) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central.js:1759](../server/src/routes/central.js#L1759) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central.js:1564](../server/src/routes/central.js#L1564) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central.js:1772](../server/src/routes/central.js#L1772) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central.js:1596](../server/src/routes/central.js#L1596) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central.js:1655](../server/src/routes/central.js#L1655) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central.js:1288](../server/src/routes/central.js#L1288) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central.js:1410](../server/src/routes/central.js#L1410) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:577](../server/src/routes/central.js#L577) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:593](../server/src/routes/central.js#L593) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:512](../server/src/routes/central.js#L512) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central.js:1930](../server/src/routes/central.js#L1930) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:861](../server/src/routes/central.js#L861) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:984](../server/src/routes/central.js#L984) |

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

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('svcmon')`

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
| GET | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:182](../server/src/routes/admin/horizonAssign.js#L182) |
| POST | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:190](../server/src/routes/admin/horizonAssign.js#L190) |
| DELETE | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:200](../server/src/routes/admin/horizonAssign.js#L200) |
| PUT | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:195](../server/src/routes/admin/horizonAssign.js#L195) |
| POST | `/assignments/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:207](../server/src/routes/admin/horizonAssign.js#L207) |
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:65](../server/src/routes/admin/opsSettings.js#L65) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:125](../server/src/routes/admin/backupNetSec.js#L125) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:108](../server/src/routes/admin/backupNetSec.js#L108) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:103](../server/src/routes/admin/backupNetSec.js#L103) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:126](../server/src/routes/admin/backupNetSec.js#L126) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:102](../server/src/routes/admin/backupNetSec.js#L102) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:99](../server/src/routes/admin/backupNetSec.js#L99) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:116](../server/src/routes/admin/backupNetSec.js#L116) |
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
| GET | `/codex-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:28](../server/src/routes/admin/statusTools.js#L28) |
| GET | `/codex-check/file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:31](../server/src/routes/admin/statusTools.js#L31) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:34](../server/src/routes/admin/statusTools.js#L34) |
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
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:241](../server/src/routes/admin/backupNetSec.js#L241) |
| GET | `/dir-usage` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:28](../server/src/routes/admin/dirUsage.js#L28) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:41](../server/src/routes/admin/dirUsage.js#L41) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:63](../server/src/routes/admin/dirUsage.js#L63) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:81](../server/src/routes/admin/dirUsage.js#L81) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:55](../server/src/routes/admin/dirUsage.js#L55) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:71](../server/src/routes/admin/dirUsage.js#L71) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:245](../server/src/routes/admin/gpuGuest.js#L245) |
| GET | `/edge-users/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:231](../server/src/routes/admin/gpuGuest.js#L231) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:240](../server/src/routes/admin/gpuGuest.js#L240) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:251](../server/src/routes/admin/gpuGuest.js#L251) |
| GET | `/edge-users/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:220](../server/src/routes/admin/gpuGuest.js#L220) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:45](../server/src/routes/admin/statusTools.js#L45) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:50](../server/src/routes/admin/statusTools.js#L50) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:87](../server/src/routes/admin/nsxImport.js#L87) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:205](../server/src/routes/admin/gpuGuest.js#L205) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:209](../server/src/routes/admin/gpuGuest.js#L209) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:195](../server/src/routes/admin/gpuGuest.js#L195) |
| GET | `/gpu-guest/diag` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:154](../server/src/routes/admin/gpuGuest.js#L154) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:119](../server/src/routes/admin/gpuGuest.js#L119) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:123](../server/src/routes/admin/gpuGuest.js#L123) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:350](../server/src/routes/admin/gpuGuest.js#L350) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` · `rawIpFleetOnly` | [server/src/routes/admin/gpuGuest.js:449](../server/src/routes/admin/gpuGuest.js#L449) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:160](../server/src/routes/admin/gpuGuest.js#L160) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:257](../server/src/routes/admin/gpuGuest.js#L257) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:260](../server/src/routes/admin/gpuGuest.js#L260) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:270](../server/src/routes/admin/gpuGuest.js#L270) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:265](../server/src/routes/admin/gpuGuest.js#L265) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:279](../server/src/routes/admin/gpuGuest.js#L279) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:303](../server/src/routes/admin/gpuGuest.js#L303) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:274](../server/src/routes/admin/gpuGuest.js#L274) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:331](../server/src/routes/admin/gpuGuest.js#L331) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:92](../server/src/routes/admin/gpuGuest.js#L92) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:229](../server/src/routes/admin/backupNetSec.js#L229) |
| GET | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:20](../server/src/routes/admin/horizonAssign.js#L20) |
| POST | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:21](../server/src/routes/admin/horizonAssign.js#L21) |
| DELETE | `/horizon/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:26](../server/src/routes/admin/horizonAssign.js#L26) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:61](../server/src/routes/admin/horizonAssign.js#L61) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:69](../server/src/routes/admin/horizonAssign.js#L69) |
| POST | `/horizon/servers/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:134](../server/src/routes/admin/horizonAssign.js#L134) |
| POST | `/horizon/servers/import/test` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:93](../server/src/routes/admin/horizonAssign.js#L93) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:124](../server/src/routes/admin/horizonAssign.js#L124) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:77](../server/src/routes/admin/horizonAssign.js#L77) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:83](../server/src/routes/admin/horizonAssign.js#L83) |
| POST | `/horizon/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:31](../server/src/routes/admin/horizonAssign.js#L31) |
| GET | `/host-access` | 역할 `admin` | [server/src/routes/admin/hostAccess.js:24](../server/src/routes/admin/hostAccess.js#L24) |
| POST | `/host-access/apply` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:36](../server/src/routes/admin/hostAccess.js#L36) |
| POST | `/host-access/confirm` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:41](../server/src/routes/admin/hostAccess.js#L41) |
| PUT | `/host-access/draft` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:27](../server/src/routes/admin/hostAccess.js#L27) |
| POST | `/host-access/plan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:33](../server/src/routes/admin/hostAccess.js#L33) |
| POST | `/host-access/revert` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:46](../server/src/routes/admin/hostAccess.js#L46) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:182](../server/src/routes/admin/idracCore.js#L182) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:211](../server/src/routes/admin/idracCore.js#L211) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:531](../server/src/routes/admin/idracScan.js#L531) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:525](../server/src/routes/admin/idracScan.js#L525) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` · `liveFleetOnly` | [server/src/routes/admin/idracScan.js:204](../server/src/routes/admin/idracScan.js#L204) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:63](../server/src/routes/admin/idracScan.js#L63) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:117](../server/src/routes/admin/idracScan.js#L117) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:161](../server/src/routes/admin/idracScan.js#L161) |
| GET | `/idrac/:id/trend` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:521](../server/src/routes/admin/idracTrend.js#L521) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:85](../server/src/routes/admin/idracScan.js#L85) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:513](../server/src/routes/admin/idracScan.js#L513) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:236](../server/src/routes/admin/idracScan.js#L236) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:500](../server/src/routes/admin/idracScan.js#L500) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:229](../server/src/routes/admin/idracScan.js#L229) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:519](../server/src/routes/admin/idracCore.js#L519) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:555](../server/src/routes/admin/idracCore.js#L555) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:451](../server/src/routes/admin/idracCore.js#L451) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:261](../server/src/routes/admin/idracCore.js#L261) |
| POST | `/idrac/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:218](../server/src/routes/admin/idracScan.js#L218) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:372](../server/src/routes/admin/idracCore.js#L372) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:298](../server/src/routes/admin/idracCore.js#L298) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:619](../server/src/routes/admin/idracCore.js#L619) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:639](../server/src/routes/admin/idracCore.js#L639) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:229](../server/src/routes/admin/idracCore.js#L229) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:247](../server/src/routes/admin/idracCore.js#L247) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:235](../server/src/routes/admin/idracCore.js#L235) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:236](../server/src/routes/admin/idracCore.js#L236) |
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
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:495](../server/src/routes/admin/idracCore.js#L495) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:221](../server/src/routes/admin/idracCore.js#L221) |
| GET | `/idrac/trend/export.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:436](../server/src/routes/admin/idracTrend.js#L436) |
| GET | `/idrac/trend/export.xlsx` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:459](../server/src/routes/admin/idracTrend.js#L459) |
| GET | `/idrac/trend/servers` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:394](../server/src/routes/admin/idracTrend.js#L394) |
| GET | `/idrac/trend/table` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:401](../server/src/routes/admin/idracTrend.js#L401) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:486](../server/src/routes/admin/idracCore.js#L486) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:56](../server/src/routes/admin/centralIpam.js#L56) |
| GET | `/ipam/scan/log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:175](../server/src/routes/admin/centralIpam.js#L175) |
| GET | `/ipam/scan/ranges.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:199](../server/src/routes/admin/centralIpam.js#L199) |
| POST | `/ipam/scan/ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:210](../server/src/routes/admin/centralIpam.js#L210) |
| GET | `/ipam/scan/ranges/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:205](../server/src/routes/admin/centralIpam.js#L205) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:186](../server/src/routes/admin/centralIpam.js#L186) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:178](../server/src/routes/admin/centralIpam.js#L178) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:112](../server/src/routes/admin/centralIpam.js#L112) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:131](../server/src/routes/admin/centralIpam.js#L131) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:183](../server/src/routes/admin/centralIpam.js#L183) |
| GET | `/ipam/scan/suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:157](../server/src/routes/admin/centralIpam.js#L157) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:84](../server/src/routes/admin/centralIpam.js#L84) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:88](../server/src/routes/admin/centralIpam.js#L88) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:234](../server/src/routes/admin/centralIpam.js#L234) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:252](../server/src/routes/admin/centralIpam.js#L252) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:273](../server/src/routes/admin/centralIpam.js#L273) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:267](../server/src/routes/admin/centralIpam.js#L267) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:258](../server/src/routes/admin/centralIpam.js#L258) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:521](../server/src/routes/admin/deployLlm.js#L521) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:522](../server/src/routes/admin/deployLlm.js#L522) |
| POST | `/llm-test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:526](../server/src/routes/admin/deployLlm.js#L526) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:75](../server/src/routes/admin/statusTools.js#L75) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:19](../server/src/routes/admin/mail.js#L19) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:23](../server/src/routes/admin/mail.js#L23) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:45](../server/src/routes/admin/mail.js#L45) |
| GET | `/memtrack` | 역할 `admin` | [server/src/routes/admin/statusTools.js:182](../server/src/routes/admin/statusTools.js#L182) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:76](../server/src/routes/admin/gpuGuest.js#L76) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:80](../server/src/routes/admin/gpuGuest.js#L80) |
| GET | `/net/agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:161](../server/src/routes/admin/backupNetSec.js#L161) |
| GET | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:193](../server/src/routes/admin/backupNetSec.js#L193) |
| POST | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:168](../server/src/routes/admin/backupNetSec.js#L168) |
| GET | `/net/history` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:210](../server/src/routes/admin/backupNetSec.js#L210) |
| DELETE | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:212](../server/src/routes/admin/backupNetSec.js#L212) |
| GET | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:211](../server/src/routes/admin/backupNetSec.js#L211) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:220](../server/src/routes/admin/backupNetSec.js#L220) |
| GET | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:215](../server/src/routes/admin/backupNetSec.js#L215) |
| PUT | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:216](../server/src/routes/admin/backupNetSec.js#L216) |
| DELETE | `/net/monitors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:217](../server/src/routes/admin/backupNetSec.js#L217) |
| POST | `/net/monitors/:id/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:218](../server/src/routes/admin/backupNetSec.js#L218) |
| POST | `/net/pcap` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:199](../server/src/routes/admin/backupNetSec.js#L199) |
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
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:540](../server/src/routes/admin/deployLlm.js#L540) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:537](../server/src/routes/admin/deployLlm.js#L537) |
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
| GET | `/portal-db` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:98](../server/src/routes/admin/statusTools.js#L98) |
| GET | `/portal-db/health` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:108](../server/src/routes/admin/statusTools.js#L108) |
| GET | `/portal-db/location` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:127](../server/src/routes/admin/statusTools.js#L127) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:143](../server/src/routes/admin/statusTools.js#L143) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:153](../server/src/routes/admin/statusTools.js#L153) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:266](../server/src/routes/admin/opsSettings.js#L266) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:283](../server/src/routes/admin/opsSettings.js#L283) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:275](../server/src/routes/admin/opsSettings.js#L275) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:547](../server/src/routes/admin/deployLlm.js#L547) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:551](../server/src/routes/admin/deployLlm.js#L551) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:89](../server/src/routes/admin/opsSettings.js#L89) |
| PUT | `/report/daily` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:90](../server/src/routes/admin/opsSettings.js#L90) |
| POST | `/report/daily/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:95](../server/src/routes/admin/opsSettings.js#L95) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:167](../server/src/routes/admin/idracCore.js#L167) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:130](../server/src/routes/admin/idracCore.js#L130) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:152](../server/src/routes/admin/idracCore.js#L152) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:142](../server/src/routes/admin/opsSettings.js#L142) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:145](../server/src/routes/admin/opsSettings.js#L145) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:277](../server/src/routes/admin/backupNetSec.js#L277) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:283](../server/src/routes/admin/backupNetSec.js#L283) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:299](../server/src/routes/admin/backupNetSec.js#L299) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:300](../server/src/routes/admin/backupNetSec.js#L300) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:261](../server/src/routes/admin/backupNetSec.js#L261) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:270](../server/src/routes/admin/backupNetSec.js#L270) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:269](../server/src/routes/admin/backupNetSec.js#L269) |
| GET | `/security/login-fails/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:268](../server/src/routes/admin/backupNetSec.js#L268) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:273](../server/src/routes/admin/backupNetSec.js#L273) |
| GET | `/security/self-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/securityCheck.js:22](../server/src/routes/admin/securityCheck.js#L22) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:169](../server/src/routes/admin/opsSettings.js#L169) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:170](../server/src/routes/admin/opsSettings.js#L170) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:190](../server/src/routes/admin/statusTools.js#L190) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:19](../server/src/routes/admin/toolCategories.js#L19) |
| PUT | `/tool-categories` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/toolCategories.js:23](../server/src/routes/admin/toolCategories.js#L23) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:39](../server/src/routes/admin/toolCategories.js#L39) |
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
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:81](../server/src/routes/admin/statusTools.js#L81) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:47](../server/src/routes/admin/vcenters.js#L47) |
| POST | `/vcenters` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:65](../server/src/routes/admin/vcenters.js#L65) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:80](../server/src/routes/admin/vcenters.js#L80) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:72](../server/src/routes/admin/vcenters.js#L72) |
| POST | `/vcenters/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:94](../server/src/routes/admin/nsxImport.js#L94) |
| POST | `/vcenters/import-file` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:111](../server/src/routes/admin/nsxImport.js#L111) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/nsxImport.js:103](../server/src/routes/admin/nsxImport.js#L103) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:88](../server/src/routes/admin/vcenters.js#L88) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:104](../server/src/routes/admin/vcenters.js#L104) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:154](../server/src/routes/admin/backupNetSec.js#L154) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:140](../server/src/routes/admin/backupNetSec.js#L140) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:137](../server/src/routes/admin/backupNetSec.js#L137) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:325](../server/src/routes/admin/collectorsDc.js#L325) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:348](../server/src/routes/admin/collectorsDc.js#L348) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:236](../server/src/routes/auth.js#L236) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` · `requireSettingsOwner` | [server/src/routes/auth.js:244](../server/src/routes/auth.js#L244) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:249](../server/src/routes/auth.js#L249) |
| GET | `/config` | — | [server/src/routes/auth.js:26](../server/src/routes/auth.js#L26) |
| POST | `/extend` | `authMiddleware` | [server/src/routes/auth.js:172](../server/src/routes/auth.js#L172) |
| POST | `/login` | — | [server/src/routes/auth.js:47](../server/src/routes/auth.js#L47) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:145](../server/src/routes/auth.js#L145) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:217](../server/src/routes/auth.js#L217) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:221](../server/src/routes/auth.js#L221) |

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
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:330](../server/src/routes/publicApi.js#L330) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:377](../server/src/routes/publicApi.js#L377) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:392](../server/src/routes/publicApi.js#L392) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:244](../server/src/routes/publicApi.js#L244) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:187](../server/src/routes/publicApi.js#L187) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:229](../server/src/routes/publicApi.js#L229) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:180](../server/src/routes/publicApi.js#L180) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:498](../server/src/routes/api/inventory.js#L498) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:501](../server/src/routes/api/inventory.js#L501) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:509](../server/src/routes/api/inventory.js#L509) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:481](../server/src/routes/api/inventory.js#L481) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:396](../server/src/routes/api/inventory.js#L396) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:404](../server/src/routes/api/inventory.js#L404) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:129](../server/src/routes/api/overviewNsx.js#L129) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:241](../server/src/routes/api/inventory.js#L241) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:133](../server/src/routes/api/vmMetrics.js#L133) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:189](../server/src/routes/api/vmMetrics.js#L189) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:415](../server/src/routes/api/inventory.js#L415) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:222](../server/src/routes/api/overviewNsx.js#L222) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:256](../server/src/routes/api/overviewNsx.js#L256) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:175](../server/src/routes/api/overviewNsx.js#L175) |
| GET | `/overview/cards` | — | [server/src/routes/api/overviewCards.js:80](../server/src/routes/api/overviewCards.js#L80) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:110](../server/src/routes/api/perfClient.js#L110) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:69](../server/src/routes/api/perfClient.js#L69) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:99](../server/src/routes/api/perfClient.js#L99) |
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
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:528](../server/src/routes/api/inventory.js#L528) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:524](../server/src/routes/api/inventory.js#L524) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:24](../server/src/routes/api/bmstor.js#L24) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:135](../server/src/routes/api/bmstor.js#L135) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:79](../server/src/routes/api/bmstor.js#L79) |
| GET | `/tools/bm-storage/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:40](../server/src/routes/api/bmstor.js#L40) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:99](../server/src/routes/api/bmstor.js#L99) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:93](../server/src/routes/api/bmstor.js#L93) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:57](../server/src/routes/api/bmstor.js#L57) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:63](../server/src/routes/api/bmstor.js#L63) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:70](../server/src/routes/api/bmstor.js#L70) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:183](../server/src/routes/api/bmUsage.js#L183) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:342](../server/src/routes/api/bmUsage.js#L342) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:315](../server/src/routes/api/bmUsage.js#L315) |
| PUT | `/tools/bm-usage/distribute` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/bmUsage.js:521](../server/src/routes/api/bmUsage.js#L521) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:400](../server/src/routes/api/bmUsage.js#L400) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:480](../server/src/routes/api/bmUsage.js#L480) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:270](../server/src/routes/api/bmUsage.js#L270) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:533](../server/src/routes/api/bmUsage.js#L533) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:67](../server/src/routes/api/toolsCapacity.js#L67) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1631](../server/src/routes/api/toolsCapacity.js#L1631) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1536](../server/src/routes/api/toolsCapacity.js#L1536) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:92](../server/src/routes/api/commMap.js#L92) |
| GET | `/tools/corp-usage` | 권한 `tools` | [server/src/routes/api/corpUsage.js:89](../server/src/routes/api/corpUsage.js#L89) |
| GET | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:45](../server/src/routes/api/credentials.js#L45) |
| POST | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:55](../server/src/routes/api/credentials.js#L55) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:75](../server/src/routes/api/credentials.js#L75) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:65](../server/src/routes/api/credentials.js#L65) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:83](../server/src/routes/api/credentials.js#L83) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:50](../server/src/routes/api/credentials.js#L50) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:206](../server/src/routes/api/horizonSessions.js#L206) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:46](../server/src/routes/api/curUser.js#L46) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:110](../server/src/routes/api/curUser.js#L110) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:214](../server/src/routes/api/curUser.js#L214) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:125](../server/src/routes/api/curUser.js#L125) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:79](../server/src/routes/api/curUser.js#L79) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:136](../server/src/routes/api/curUser.js#L136) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:176](../server/src/routes/api/curUser.js#L176) |
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:177](../server/src/routes/api/cvp.js#L177) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:624](../server/src/routes/api/cvp.js#L624) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:269](../server/src/routes/api/cvp.js#L269) |
| GET | `/tools/cvp/device-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:327](../server/src/routes/api/cvp.js#L327) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:205](../server/src/routes/api/cvp.js#L205) |
| GET | `/tools/cvp/devices.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:584](../server/src/routes/api/cvp.js#L584) |
| GET | `/tools/cvp/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:344](../server/src/routes/api/cvp.js#L344) |
| GET | `/tools/cvp/faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:510](../server/src/routes/api/cvp.js#L510) |
| POST | `/tools/cvp/faults/close` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:550](../server/src/routes/api/cvp.js#L550) |
| POST | `/tools/cvp/faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:538](../server/src/routes/api/cvp.js#L538) |
| GET | `/tools/cvp/optics` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:395](../server/src/routes/api/cvp.js#L395) |
| GET | `/tools/cvp/overview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:226](../server/src/routes/api/cvp.js#L226) |
| POST | `/tools/cvp/parse-preview` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:571](../server/src/routes/api/cvp.js#L571) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:609](../server/src/routes/api/cvp.js#L609) |
| GET | `/tools/cvp/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:484](../server/src/routes/api/cvp.js#L484) |
| GET | `/tools/cvp/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:441](../server/src/routes/api/cvp.js#L441) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:642](../server/src/routes/api/cvp.js#L642) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:668](../server/src/routes/api/cvp.js#L668) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:671](../server/src/routes/api/cvp.js#L671) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:669](../server/src/routes/api/cvp.js#L669) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:682](../server/src/routes/api/cvp.js#L682) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:710](../server/src/routes/api/cvp.js#L710) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:713](../server/src/routes/api/cvp.js#L713) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:62](../server/src/routes/api/dataFlow.js#L62) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:108](../server/src/routes/api/checksLogs.js#L108) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:29](../server/src/routes/api/deviceFlow.js#L29) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:23](../server/src/routes/api/vcTools.js#L23) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:423](../server/src/routes/api/hardwareGpu.js#L423) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1229](../server/src/routes/api/toolsCapacity.js#L1229) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1344](../server/src/routes/api/toolsCapacity.js#L1344) |
| GET | `/tools/esxi-temp/sensors` | 권한 `tools` | [server/src/routes/api/serverSensors.js:122](../server/src/routes/api/serverSensors.js#L122) |
| GET | `/tools/esxi-temp/sensors/:id` | 권한 `tools` | [server/src/routes/api/serverSensors.js:163](../server/src/routes/api/serverSensors.js#L163) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1427](../server/src/routes/api/toolsCapacity.js#L1427) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:442](../server/src/routes/api/hardwareGpu.js#L442) |
| GET | `/tools/gpu.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:456](../server/src/routes/api/hardwareGpu.js#L456) |
| GET | `/tools/gpu.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:448](../server/src/routes/api/hardwareGpu.js#L448) |
| GET | `/tools/gpu/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:479](../server/src/routes/api/hardwareGpu.js#L479) |
| GET | `/tools/gpu/export.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:480](../server/src/routes/api/hardwareGpu.js#L480) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:187](../server/src/routes/api/toolsAnalytics.js#L187) |
| GET | `/tools/gpu/host` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:520](../server/src/routes/api/hardwareGpu.js#L520) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:472](../server/src/routes/api/hardwareGpu.js#L472) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:536](../server/src/routes/api/hardwareGpu.js#L536) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:391](../server/src/routes/api/toolsCapacity.js#L391) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:23](../server/src/routes/api/toolsGuestDisk.js#L23) |
| GET | `/tools/guest-disk/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestDisk.js:46](../server/src/routes/api/toolsGuestDisk.js#L46) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:77](../server/src/routes/api/toolsGuestDisk.js#L77) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:60](../server/src/routes/api/toolsGuestDisk.js#L60) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:35](../server/src/routes/api/toolsGuestDisk.js#L35) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:44](../server/src/routes/api/toolsInfo.js#L44) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:62](../server/src/routes/api/toolsInfo.js#L62) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:391](../server/src/routes/api/hardwareGpu.js#L391) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:86](../server/src/routes/api/toolsInfo.js#L86) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:88](../server/src/routes/api/horizonSessions.js#L88) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:136](../server/src/routes/api/horizonSessions.js#L136) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:149](../server/src/routes/api/horizonSessions.js#L149) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:120](../server/src/routes/api/horizonSessions.js#L120) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:159](../server/src/routes/api/horizonSessions.js#L159) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:179](../server/src/routes/api/horizonSessions.js#L179) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:36](../server/src/routes/api/toolsAnalytics.js#L36) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:510](../server/src/routes/api/hardwareGpu.js#L510) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:485](../server/src/routes/api/hardwareGpu.js#L485) |
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
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:159](../server/src/routes/api/checksLogs.js#L159) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1704](../server/src/routes/api/toolsCapacity.js#L1704) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1668](../server/src/routes/api/toolsCapacity.js#L1668) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:206](../server/src/routes/api/partFaults.js#L206) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:304](../server/src/routes/api/partFaults.js#L304) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:238](../server/src/routes/api/partFaults.js#L238) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:319](../server/src/routes/api/partFaults.js#L319) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:271](../server/src/routes/api/partFaults.js#L271) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:291](../server/src/routes/api/partFaults.js#L291) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:281](../server/src/routes/api/partFaults.js#L281) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:54](../server/src/routes/api/pdu.js#L54) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:130](../server/src/routes/api/pdu.js#L130) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:276](../server/src/routes/api/pdu.js#L276) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:164](../server/src/routes/api/pdu.js#L164) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:196](../server/src/routes/api/pdu.js#L196) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:190](../server/src/routes/api/pdu.js#L190) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:122](../server/src/routes/api/pdu.js#L122) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:243](../server/src/routes/api/pdu.js#L243) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:249](../server/src/routes/api/pdu.js#L249) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:259](../server/src/routes/api/pdu.js#L259) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:237](../server/src/routes/api/pdu.js#L237) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:151](../server/src/routes/api/pdu.js#L151) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:140](../server/src/routes/api/pdu.js#L140) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:220](../server/src/routes/api/pdu.js#L220) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:113](../server/src/routes/api/pdu.js#L113) |
| GET | `/tools/portal-check/arch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:326](../server/src/routes/api/portalCheck.js#L326) |
| POST | `/tools/portal-check/arch/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:327](../server/src/routes/api/portalCheck.js#L327) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:348](../server/src/routes/api/portalCheck.js#L348) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:197](../server/src/routes/api/portalCheck.js#L197) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:262](../server/src/routes/api/portalCheck.js#L262) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:230](../server/src/routes/api/portalCheck.js#L230) |
| GET | `/tools/power-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/overviewCards.js:128](../server/src/routes/api/overviewCards.js#L128) |
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
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:116](../server/src/routes/api/reports.js#L116) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:107](../server/src/routes/api/reports.js#L107) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:88](../server/src/routes/api/reports.js#L88) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:139](../server/src/routes/api/reports.js#L139) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:132](../server/src/routes/api/reports.js#L132) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:48](../server/src/routes/api/reports.js#L48) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:93](../server/src/routes/api/reports.js#L93) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:58](../server/src/routes/api/reports.js#L58) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:167](../server/src/routes/api/reports.js#L167) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:82](../server/src/routes/api/reports.js#L82) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1068](../server/src/routes/api/toolsCapacity.js#L1068) |
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
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:96](../server/src/routes/api/sanSwitch.js#L96) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:740](../server/src/routes/api/sanSwitch.js#L740) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:764](../server/src/routes/api/sanSwitch.js#L764) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:217](../server/src/routes/api/sanSwitch.js#L217) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:225](../server/src/routes/api/sanSwitch.js#L225) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:274](../server/src/routes/api/sanSwitch.js#L274) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:528](../server/src/routes/api/sanSwitch.js#L528) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:516](../server/src/routes/api/sanSwitch.js#L516) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:408](../server/src/routes/api/sanSwitch.js#L408) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:449](../server/src/routes/api/sanSwitch.js#L449) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:594](../server/src/routes/api/sanSwitch.js#L594) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:604](../server/src/routes/api/sanSwitch.js#L604) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:132](../server/src/routes/api/sanSwitch.js#L132) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:163](../server/src/routes/api/sanSwitch.js#L163) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:833](../server/src/routes/api/sanSwitch.js#L833) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:841](../server/src/routes/api/sanSwitch.js#L841) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:924](../server/src/routes/api/sanSwitch.js#L924) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:869](../server/src/routes/api/sanSwitch.js#L869) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:912](../server/src/routes/api/sanSwitch.js#L912) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:849](../server/src/routes/api/sanSwitch.js#L849) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:855](../server/src/routes/api/sanSwitch.js#L855) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:466](../server/src/routes/api/sanSwitch.js#L466) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:539](../server/src/routes/api/sanSwitch.js#L539) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:338](../server/src/routes/api/sanSwitch.js#L338) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:321](../server/src/routes/api/sanSwitch.js#L321) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:298](../server/src/routes/api/sanSwitch.js#L298) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:306](../server/src/routes/api/sanSwitch.js#L306) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:621](../server/src/routes/api/sanSwitch.js#L621) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:784](../server/src/routes/api/sanSwitch.js#L784) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:241](../server/src/routes/api/sanSwitch.js#L241) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:263](../server/src/routes/api/sanSwitch.js#L263) |
| GET | `/tools/secret-scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/toolsInfo.js:35](../server/src/routes/api/toolsInfo.js#L35) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:60](../server/src/routes/api/serialLookup.js#L60) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:88](../server/src/routes/api/serialLookup.js#L88) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:132](../server/src/routes/api/checksLogs.js#L132) |
| POST | `/tools/service-check/settings-files/confirm` | 역할 `admin` · `settingsFleetOnly` | [server/src/routes/api/checksLogs.js:145](../server/src/routes/api/checksLogs.js#L145) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:146](../server/src/routes/api/vcTools.js#L146) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:59](../server/src/routes/api/vcTools.js#L59) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:78](../server/src/routes/api/storageMon.js#L78) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:605](../server/src/routes/api/storageMon.js#L605) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:678](../server/src/routes/api/storageMon.js#L678) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:690](../server/src/routes/api/storageMon.js#L690) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:698](../server/src/routes/api/storageMon.js#L698) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:223](../server/src/routes/api/storageMon.js#L223) |
| POST | `/tools/storage/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:236](../server/src/routes/api/storageMon.js#L236) |
| POST | `/tools/storage/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:201](../server/src/routes/api/storageMon.js#L201) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:211](../server/src/routes/api/storageMon.js#L211) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:543](../server/src/routes/api/storageMon.js#L543) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:548](../server/src/routes/api/storageMon.js#L548) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:261](../server/src/routes/api/storageMon.js#L261) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:583](../server/src/routes/api/storageMon.js#L583) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:349](../server/src/routes/api/storageMon.js#L349) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:373](../server/src/routes/api/storageMon.js#L373) |
| POST | `/tools/storage/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:396](../server/src/routes/api/storageMon.js#L396) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:479](../server/src/routes/api/storageMon.js#L479) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:536](../server/src/routes/api/storageMon.js#L536) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:364](../server/src/routes/api/storageMon.js#L364) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:381](../server/src/routes/api/storageMon.js#L381) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:709](../server/src/routes/api/storageMon.js#L709) |
| GET | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:289](../server/src/routes/api/storageMon.js#L289) |
| PUT | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:307](../server/src/routes/api/storageMon.js#L307) |
| POST | `/tools/storage/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:147](../server/src/routes/api/storageMon.js#L147) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1116](../server/src/routes/api/toolsCapacity.js#L1116) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:119](../server/src/routes/api/toolsAnalytics.js#L119) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:282](../server/src/routes/api/checksLogs.js#L282) |
| GET | `/tools/vclogs/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/checksLogs.js:298](../server/src/routes/api/checksLogs.js#L298) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:269](../server/src/routes/api/checksLogs.js#L269) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:250](../server/src/routes/api/checksLogs.js#L250) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:218](../server/src/routes/api/checksLogs.js#L218) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:32](../server/src/routes/api/vmClone.js#L32) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:109](../server/src/routes/api/vmClone.js#L109) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:47](../server/src/routes/api/vmClone.js#L47) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:83](../server/src/routes/api/vmClone.js#L83) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:94](../server/src/routes/api/vmClone.js#L94) |
| GET | `/tools/vm-export` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:132](../server/src/routes/api/ipamExport.js#L132) |
| GET | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:141](../server/src/routes/api/ipamExport.js#L141) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1144](../server/src/routes/api/toolsCapacity.js#L1144) |
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
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:218](../server/src/routes/api/vmSeries.js#L218) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:182](../server/src/routes/api/vmSeries.js#L182) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:174](../server/src/routes/api/vmSeries.js#L174) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:157](../server/src/routes/api/vmSeries.js#L157) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:86](../server/src/routes/api/vmSeries.js#L86) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:104](../server/src/routes/api/vmSeries.js#L104) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:169](../server/src/routes/api/vmSeries.js#L169) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:196](../server/src/routes/api/vmSeries.js#L196) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:123](../server/src/routes/api/vcTools.js#L123) |
| GET | `/tools/vmware-config` | 권한 `tools` | [server/src/routes/api/checksLogs.js:166](../server/src/routes/api/checksLogs.js#L166) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:260](../server/src/routes/api/toolsCapacity.js#L260) |
| GET | `/tools/waste/export` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsCapacity.js:439](../server/src/routes/api/toolsCapacity.js#L439) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:627](../server/src/routes/api/toolsCapacity.js#L627) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:597](../server/src/routes/api/toolsCapacity.js#L597) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:611](../server/src/routes/api/toolsCapacity.js#L611) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:603](../server/src/routes/api/toolsCapacity.js#L603) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:402](../server/src/routes/api/toolsCapacity.js#L402) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:859](../server/src/routes/api/toolsCapacity.js#L859) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:880](../server/src/routes/api/toolsCapacity.js#L880) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:937](../server/src/routes/api/toolsCapacity.js#L937) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:974](../server/src/routes/api/toolsCapacity.js#L974) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:436](../server/src/routes/api/inventory.js#L436) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:299](../server/src/routes/api/toolsInfo.js#L299) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:301](../server/src/routes/api/toolsInfo.js#L301) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:12](../server/src/routes/api/vcTools.js#L12) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:717](../server/src/routes/api/toolsCapacity.js#L717) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:282](../server/src/routes/api/inventory.js#L282) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:160](../server/src/routes/api/vmMetrics.js#L160) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:102](../server/src/routes/api/vmMetrics.js#L102) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:369](../server/src/routes/api/inventory.js#L369) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:254](../server/src/routes/api/toolsInfo.js#L254) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:305](../server/src/routes/api/toolsCapacity.js#L305) |

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
| `fullScopeOnly` | 212 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 169 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `requireCentral` | 52 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `csvPerm` | 37 | **CSV 가져오기/내보내기 권한**(`requirePerm('data.csv')` — v2.643). 관리자 이상만(super_admin 항상, admin 은 권한 설정에서 super_admin 이 끌 수 있다). operator·viewer 는 403. |
| `requireSettingsOwner` | 34 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `fleetReadOnly` | 9 | **전체 범위 계정만**(v2.621 SEC-03 — 폴더 사용량 조회. 응답이 RMA 엣지 IP·호스트명·마운트 경로를 싣는다 · v2.622 SEC-03 — GPU 게스트 엣지 배포 설정·엣지 배포 사용자·수집 진단 조회). 범위 제한 계정은 403. |
| `guarded` | 8 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `fullScopeOnlyWith` | 8 | **전체 범위 계정만**(사유 문구를 받는 `fullScopeOnly` — v2.628 SEC2628-01 업그레이드 제어·SEC2628-05 리소스 적정성 진단 등). 범위 제한 계정은 403. |
| `authMiddleware` | 7 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
| `fleetFullScopeOnly` | 4 | **전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403. |
| `fleetWideOnly` | 3 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `reauth` | 3 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `auditMiddleware` | 3 | 상태변경 감사 로그 기록. |
| `requireEnrolled` | 3 | OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다. |
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

