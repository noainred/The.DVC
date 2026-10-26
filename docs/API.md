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
| 엔드포인트 | **1056개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 107개 |
| GET | 571개 |
| POST | 325개 |
| PUT | 104개 |
| PATCH | 2개 |
| DELETE | 54개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 14 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 16 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 56 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 8 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 56 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 361 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 11 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 485 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:162](../server/src/routes/collector.js#L162) |
| POST | `/bmstor-collect` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:306](../server/src/routes/collector.js#L306) |
| POST | `/central-token` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:245](../server/src/routes/collector.js#L245) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:133](../server/src/routes/collector.js#L133) |
| GET | `/export` | — | [server/src/routes/collector.js:62](../server/src/routes/collector.js#L62) |
| POST | `/idrac-scan` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:260](../server/src/routes/collector.js#L260) |
| POST | `/isidu-run` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:292](../server/src/routes/collector.js#L292) |
| POST | `/isidu-test` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:295](../server/src/routes/collector.js#L295) |
| GET | `/ping` | — | [server/src/routes/collector.js:114](../server/src/routes/collector.js#L114) |
| POST | `/set-password` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:227](../server/src/routes/collector.js#L227) |
| GET | `/token-check` | — | [server/src/routes/collector.js:190](../server/src/routes/collector.js#L190) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:330](../server/src/routes/collector.js#L330) |
| GET | `/xfer-test` | — | [server/src/routes/collector.js:212](../server/src/routes/collector.js#L212) |
| POST | `/xfer-test` | — | [server/src/routes/collector.js:218](../server/src/routes/collector.js#L218) |

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
| GET | `/anomalies` | — | [server/src/routes/insights.js:363](../server/src/routes/insights.js#L363) |
| POST | `/chatops` | — | [server/src/routes/insights.js:431](../server/src/routes/insights.js#L431) |
| GET | `/finops` | — | [server/src/routes/insights.js:105](../server/src/routes/insights.js#L105) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:129](../server/src/routes/insights.js#L129) |
| PUT | `/finops/config` | 역할 `admin` · `fleetOnly` | [server/src/routes/insights.js:159](../server/src/routes/insights.js#L159) |
| GET | `/fleet` | — | [server/src/routes/insights.js:167](../server/src/routes/insights.js#L167) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:221](../server/src/routes/insights.js#L221) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:237](../server/src/routes/insights.js#L237) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:285](../server/src/routes/insights.js#L285) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:193](../server/src/routes/insights.js#L193) |
| GET | `/forecast` | — | [server/src/routes/insights.js:384](../server/src/routes/insights.js#L384) |
| GET | `/graph` | — | [server/src/routes/insights.js:410](../server/src/routes/insights.js#L410) |
| GET | `/incidents` | — | [server/src/routes/insights.js:425](../server/src/routes/insights.js#L425) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:132](../server/src/routes/insights.js#L132) |
| GET | `/security` | — | [server/src/routes/insights.js:397](../server/src/routes/insights.js#L397) |
| GET | `/topology` | — | [server/src/routes/insights.js:400](../server/src/routes/insights.js#L400) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central.js:2346](../server/src/routes/central.js#L2346) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:422](../server/src/routes/central.js#L422) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central.js:2431](../server/src/routes/central.js#L2431) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central.js:2435](../server/src/routes/central.js#L2435) |
| GET | `/bmusage-config` | `requireCentral` | [server/src/routes/central.js:1629](../server/src/routes/central.js#L1629) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:564](../server/src/routes/central.js#L564) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central.js:2410](../server/src/routes/central.js#L2410) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central.js:2414](../server/src/routes/central.js#L2414) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:1061](../server/src/routes/central.js#L1061) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:1159](../server/src/routes/central.js#L1159) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central.js:2062](../server/src/routes/central.js#L2062) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central.js:2089](../server/src/routes/central.js#L2089) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central.js:1582](../server/src/routes/central.js#L1582) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central.js:1589](../server/src/routes/central.js#L1589) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:1198](../server/src/routes/central.js#L1198) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1423](../server/src/routes/central.js#L1423) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1343](../server/src/routes/central.js#L1343) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:919](../server/src/routes/central.js#L919) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central.js:2545](../server/src/routes/central.js#L2545) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1265](../server/src/routes/central.js#L1265) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1275](../server/src/routes/central.js#L1275) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1287](../server/src/routes/central.js#L1287) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:793](../server/src/routes/central.js#L793) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central.js:2459](../server/src/routes/central.js#L2459) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central.js:2470](../server/src/routes/central.js#L2470) |
| GET | `/isidu-config` | `requireCentral` | [server/src/routes/central.js:2181](../server/src/routes/central.js#L2181) |
| POST | `/isidu-data` | `requireCentral` | [server/src/routes/central.js:2203](../server/src/routes/central.js#L2203) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central.js:2559](../server/src/routes/central.js#L2559) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central.js:2589](../server/src/routes/central.js#L2589) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central.js:2384](../server/src/routes/central.js#L2384) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central.js:2391](../server/src/routes/central.js#L2391) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central.js:1551](../server/src/routes/central.js#L1551) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central.js:1619](../server/src/routes/central.js#L1619) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central.js:1746](../server/src/routes/central.js#L1746) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central.js:1777](../server/src/routes/central.js#L1777) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central.js:2319](../server/src/routes/central.js#L2319) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central.js:2327](../server/src/routes/central.js#L2327) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:435](../server/src/routes/central.js#L435) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:517](../server/src/routes/central.js#L517) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central.js:1988](../server/src/routes/central.js#L1988) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central.js:1923](../server/src/routes/central.js#L1923) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central.js:2008](../server/src/routes/central.js#L2008) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central.js:1813](../server/src/routes/central.js#L1813) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central.js:2021](../server/src/routes/central.js#L2021) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central.js:1845](../server/src/routes/central.js#L1845) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central.js:1904](../server/src/routes/central.js#L1904) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central.js:1525](../server/src/routes/central.js#L1525) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central.js:1647](../server/src/routes/central.js#L1647) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:606](../server/src/routes/central.js#L606) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:622](../server/src/routes/central.js#L622) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:541](../server/src/routes/central.js#L541) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central.js:2309](../server/src/routes/central.js#L2309) |
| GET | `/veeam-config` | `requireCentral` | [server/src/routes/central.js:2263](../server/src/routes/central.js#L2263) |
| POST | `/veeam-data` | `requireCentral` | [server/src/routes/central.js:2278](../server/src/routes/central.js#L2278) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:1001](../server/src/routes/central.js#L1001) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:1183](../server/src/routes/central.js#L1183) |

## `/api/upgrade`

자동 업그레이드 제어(번들 수신·적용).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/apply` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:157](../server/src/routes/upgrade.js#L157) |
| POST | `/bundle` | 역할 `admin` · `fullScopeOnlyWith` · `express.raw` | [server/src/routes/upgrade.js:209](../server/src/routes/upgrade.js#L209) |
| POST | `/check` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:151](../server/src/routes/upgrade.js#L151) |
| GET | `/detect-install` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:176](../server/src/routes/upgrade.js#L176) |
| POST | `/restart` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:165](../server/src/routes/upgrade.js#L165) |
| GET | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:171](../server/src/routes/upgrade.js#L171) |
| PUT | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:186](../server/src/routes/upgrade.js#L186) |
| GET | `/status` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:146](../server/src/routes/upgrade.js#L146) |

## `/api/remote`

원격 접속(HAProxy/SSH/RDP 중계).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:168](../server/src/routes/remote.js#L168) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:184](../server/src/routes/remote.js#L184) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:339](../server/src/routes/remote.js#L339) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:323](../server/src/routes/remote.js#L323) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:52](../server/src/routes/remote.js#L52) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:361](../server/src/routes/remote.js#L361) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:477](../server/src/routes/remote.js#L477) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:466](../server/src/routes/remote.js#L466) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:101](../server/src/routes/remote.js#L101) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:135](../server/src/routes/remote.js#L135) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:249](../server/src/routes/remote.js#L249) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:270](../server/src/routes/remote.js#L270) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:283](../server/src/routes/remote.js#L283) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:193](../server/src/routes/remote.js#L193) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:412](../server/src/routes/remote.js#L412) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:37](../server/src/routes/remote.js#L37) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:493](../server/src/routes/remote.js#L493) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:151](../server/src/routes/remote.js#L151) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:307](../server/src/routes/remote.js#L307) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:32](../server/src/routes/svcmon/edge.js#L32) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:109](../server/src/routes/svcmon/edge.js#L109) |
| PUT | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:67](../server/src/routes/svcmon/edge.js#L67) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:117](../server/src/routes/svcmon/edge.js#L117) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:107](../server/src/routes/svcmon/overview.js#L107) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:139](../server/src/routes/svcmon/edge.js#L139) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:126](../server/src/routes/svcmon/edge.js#L126) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:170](../server/src/routes/svcmon/edge.js#L170) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:154](../server/src/routes/svcmon/edge.js#L154) |
| POST | `/flush` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:135](../server/src/routes/svcmon/overview.js#L135) |
| POST | `/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:23](../server/src/routes/svcmon/tree.js#L23) |
| POST | `/folders/delete` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:57](../server/src/routes/svcmon/tree.js#L57) |
| POST | `/folders/move` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:39](../server/src/routes/svcmon/tree.js#L39) |
| PUT | `/folders/rename` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:31](../server/src/routes/svcmon/tree.js#L31) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:44](../server/src/routes/svcmon/logs.js#L44) |
| PUT | `/log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:48](../server/src/routes/svcmon/logs.js#L48) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:97](../server/src/routes/svcmon/logs.js#L97) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:68](../server/src/routes/svcmon/logs.js#L68) |
| POST | `/log/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:121](../server/src/routes/svcmon/logs.js#L121) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:81](../server/src/routes/svcmon/logs.js#L81) |
| POST | `/push-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:178](../server/src/routes/svcmon/edge.js#L178) |
| POST | `/refresh` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:118](../server/src/routes/svcmon/overview.js#L118) |
| PUT | `/reorder/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:52](../server/src/routes/svcmon/tree.js#L52) |
| PUT | `/reorder/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:47](../server/src/routes/svcmon/tree.js#L47) |
| POST | `/silence-check` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:185](../server/src/routes/svcmon/edge.js#L185) |
| PUT | `/sort` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:67](../server/src/routes/svcmon/tree.js#L67) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:50](../server/src/routes/svcmon/overview.js#L50) |
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
| POST | `/agent-deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:81](../server/src/routes/admin/deployLlm.js#L81) |
| GET | `/agent-deploy/bulk` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:323](../server/src/routes/admin/deployLlm.js#L323) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:324](../server/src/routes/admin/deployLlm.js#L324) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:329](../server/src/routes/admin/deployLlm.js#L329) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:273](../server/src/routes/admin/deployLlm.js#L273) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:278](../server/src/routes/admin/deployLlm.js#L278) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:295](../server/src/routes/admin/deployLlm.js#L295) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:340](../server/src/routes/admin/deployLlm.js#L340) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:411](../server/src/routes/admin/deployLlm.js#L411) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:358](../server/src/routes/admin/deployLlm.js#L358) |
| GET | `/agent-deploy/defaults` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:67](../server/src/routes/admin/deployLlm.js#L67) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:232](../server/src/routes/admin/deployLlm.js#L232) |
| GET | `/agent-deploy/installer` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:65](../server/src/routes/admin/deployLlm.js#L65) |
| GET | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:101](../server/src/routes/admin/deployLlm.js#L101) |
| POST | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:110](../server/src/routes/admin/deployLlm.js#L110) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:131](../server/src/routes/admin/deployLlm.js#L131) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:213](../server/src/routes/admin/deployLlm.js#L213) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:223](../server/src/routes/admin/deployLlm.js#L223) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:142](../server/src/routes/admin/deployLlm.js#L142) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:503](../server/src/routes/admin/deployLlm.js#L503) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:180](../server/src/routes/admin/deployLlm.js#L180) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:156](../server/src/routes/admin/deployLlm.js#L156) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:516](../server/src/routes/admin/deployLlm.js#L516) |
| POST | `/agent-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:77](../server/src/routes/admin/deployLlm.js#L77) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:105](../server/src/routes/admin/opsSettings.js#L105) |
| PUT | `/alerts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:106](../server/src/routes/admin/opsSettings.js#L106) |
| POST | `/alerts/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:118](../server/src/routes/admin/opsSettings.js#L118) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:152](../server/src/routes/admin/opsSettings.js#L152) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:153](../server/src/routes/admin/opsSettings.js#L153) |
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
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:97](../server/src/routes/admin/opsSettings.js#L97) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:207](../server/src/routes/admin/backupNetSec.js#L207) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:175](../server/src/routes/admin/backupNetSec.js#L175) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:170](../server/src/routes/admin/backupNetSec.js#L170) |
| POST | `/backup/restore-staged/cancel` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:200](../server/src/routes/admin/backupNetSec.js#L200) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:208](../server/src/routes/admin/backupNetSec.js#L208) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:169](../server/src/routes/admin/backupNetSec.js#L169) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:166](../server/src/routes/admin/backupNetSec.js#L166) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:188](../server/src/routes/admin/backupNetSec.js#L188) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:26](../server/src/routes/admin/centralTokens.js#L26) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:55](../server/src/routes/admin/centralTokens.js#L55) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:50](../server/src/routes/admin/centralTokens.js#L50) |
| GET | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:68](../server/src/routes/admin/centralTokens.js#L68) |
| POST | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:72](../server/src/routes/admin/centralTokens.js#L72) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:97](../server/src/routes/admin/centralTokens.js#L97) |
| POST | `/central/agent-tokens/:agent/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:80](../server/src/routes/admin/centralTokens.js#L80) |
| GET | `/central/ingest-stats` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:46](../server/src/routes/admin/centralTokens.js#L46) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:47](../server/src/routes/admin/centralTokens.js#L47) |
| GET | `/central/inventory` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:28](../server/src/routes/admin/centralTokens.js#L28) |
| POST | `/central/inventory/owner` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:33](../server/src/routes/admin/centralTokens.js#L33) |
| GET | `/central/token-apply/jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:88](../server/src/routes/admin/centralTokens.js#L88) |
| GET | `/central/token-apply/jobs/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:92](../server/src/routes/admin/centralTokens.js#L92) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:135](../server/src/routes/admin/opsSettings.js#L135) |
| GET | `/codex-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:30](../server/src/routes/admin/statusTools.js#L30) |
| GET | `/codex-check/file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:33](../server/src/routes/admin/statusTools.js#L33) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:36](../server/src/routes/admin/statusTools.js#L36) |
| GET | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:138](../server/src/routes/admin/collectorsDc.js#L138) |
| POST | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:148](../server/src/routes/admin/collectorsDc.js#L148) |
| DELETE | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:171](../server/src/routes/admin/collectorsDc.js#L171) |
| PUT | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:156](../server/src/routes/admin/collectorsDc.js#L156) |
| POST | `/collectors/:id/force-token` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:562](../server/src/routes/admin/collectorsDc.js#L562) |
| GET | `/collectors/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:190](../server/src/routes/admin/collectorsDc.js#L190) |
| POST | `/collectors/import` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:219](../server/src/routes/admin/collectorsDc.js#L219) |
| POST | `/collectors/pull` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:468](../server/src/routes/admin/collectorsDc.js#L468) |
| GET | `/collectors/sample.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/collectorsDc.js:205](../server/src/routes/admin/collectorsDc.js#L205) |
| POST | `/collectors/set-password` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:282](../server/src/routes/admin/collectorsDc.js#L282) |
| POST | `/collectors/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:489](../server/src/routes/admin/collectorsDc.js#L489) |
| POST | `/collectors/upgrade` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:475](../server/src/routes/admin/collectorsDc.js#L475) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:34](../server/src/routes/admin/vcenters.js#L34) |
| PUT | `/data-source` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:39](../server/src/routes/admin/vcenters.js#L39) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:376](../server/src/routes/admin/collectorsDc.js#L376) |
| PUT | `/datacenter-order` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:386](../server/src/routes/admin/collectorsDc.js#L386) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:341](../server/src/routes/admin/collectorsDc.js#L341) |
| POST | `/datacenters` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:350](../server/src/routes/admin/collectorsDc.js#L350) |
| DELETE | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:370](../server/src/routes/admin/collectorsDc.js#L370) |
| PUT | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:365](../server/src/routes/admin/collectorsDc.js#L365) |
| PUT | `/datacenters/assign` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:356](../server/src/routes/admin/collectorsDc.js#L356) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:371](../server/src/routes/admin/backupNetSec.js#L371) |
| GET | `/dir-usage` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:30](../server/src/routes/admin/dirUsage.js#L30) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:47](../server/src/routes/admin/dirUsage.js#L47) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:69](../server/src/routes/admin/dirUsage.js#L69) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:92](../server/src/routes/admin/dirUsage.js#L92) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:61](../server/src/routes/admin/dirUsage.js#L61) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:77](../server/src/routes/admin/dirUsage.js#L77) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:320](../server/src/routes/admin/gpuGuest.js#L320) |
| GET | `/edge-users/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:306](../server/src/routes/admin/gpuGuest.js#L306) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:315](../server/src/routes/admin/gpuGuest.js#L315) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:326](../server/src/routes/admin/gpuGuest.js#L326) |
| GET | `/edge-users/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:293](../server/src/routes/admin/gpuGuest.js#L293) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:50](../server/src/routes/admin/statusTools.js#L50) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:59](../server/src/routes/admin/statusTools.js#L59) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:87](../server/src/routes/admin/nsxImport.js#L87) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:278](../server/src/routes/admin/gpuGuest.js#L278) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:282](../server/src/routes/admin/gpuGuest.js#L282) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:260](../server/src/routes/admin/gpuGuest.js#L260) |
| GET | `/gpu-guest/diag` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:219](../server/src/routes/admin/gpuGuest.js#L219) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:183](../server/src/routes/admin/gpuGuest.js#L183) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:188](../server/src/routes/admin/gpuGuest.js#L188) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:425](../server/src/routes/admin/gpuGuest.js#L425) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` · `rawIpFleetOnly` | [server/src/routes/admin/gpuGuest.js:537](../server/src/routes/admin/gpuGuest.js#L537) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:225](../server/src/routes/admin/gpuGuest.js#L225) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:332](../server/src/routes/admin/gpuGuest.js#L332) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:335](../server/src/routes/admin/gpuGuest.js#L335) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:345](../server/src/routes/admin/gpuGuest.js#L345) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:340](../server/src/routes/admin/gpuGuest.js#L340) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:354](../server/src/routes/admin/gpuGuest.js#L354) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:378](../server/src/routes/admin/gpuGuest.js#L378) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:349](../server/src/routes/admin/gpuGuest.js#L349) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:406](../server/src/routes/admin/gpuGuest.js#L406) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:156](../server/src/routes/admin/gpuGuest.js#L156) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:345](../server/src/routes/admin/backupNetSec.js#L345) |
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
| GET | `/host-access` | 역할 `admin` · `fleetReadOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:38](../server/src/routes/admin/hostAccess.js#L38) |
| POST | `/host-access/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:50](../server/src/routes/admin/hostAccess.js#L50) |
| POST | `/host-access/confirm` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:55](../server/src/routes/admin/hostAccess.js#L55) |
| PUT | `/host-access/draft` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:41](../server/src/routes/admin/hostAccess.js#L41) |
| POST | `/host-access/plan` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:47](../server/src/routes/admin/hostAccess.js#L47) |
| POST | `/host-access/revert` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:60](../server/src/routes/admin/hostAccess.js#L60) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:185](../server/src/routes/admin/idracCore.js#L185) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:228](../server/src/routes/admin/idracCore.js#L228) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:553](../server/src/routes/admin/idracScan.js#L553) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:547](../server/src/routes/admin/idracScan.js#L547) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` · `liveFleetOnly` | [server/src/routes/admin/idracScan.js:226](../server/src/routes/admin/idracScan.js#L226) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:82](../server/src/routes/admin/idracScan.js#L82) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:139](../server/src/routes/admin/idracScan.js#L139) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:183](../server/src/routes/admin/idracScan.js#L183) |
| GET | `/idrac/:id/trend` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:853](../server/src/routes/admin/idracTrend.js#L853) |
| GET | `/idrac/:id/trend/hourly` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:815](../server/src/routes/admin/idracTrend.js#L815) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:106](../server/src/routes/admin/idracScan.js#L106) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:535](../server/src/routes/admin/idracScan.js#L535) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:258](../server/src/routes/admin/idracScan.js#L258) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:522](../server/src/routes/admin/idracScan.js#L522) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:251](../server/src/routes/admin/idracScan.js#L251) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:536](../server/src/routes/admin/idracCore.js#L536) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:572](../server/src/routes/admin/idracCore.js#L572) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:468](../server/src/routes/admin/idracCore.js#L468) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:278](../server/src/routes/admin/idracCore.js#L278) |
| POST | `/idrac/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:240](../server/src/routes/admin/idracScan.js#L240) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:389](../server/src/routes/admin/idracCore.js#L389) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:315](../server/src/routes/admin/idracCore.js#L315) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:626](../server/src/routes/admin/idracCore.js#L626) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:646](../server/src/routes/admin/idracCore.js#L646) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:246](../server/src/routes/admin/idracCore.js#L246) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:264](../server/src/routes/admin/idracCore.js#L264) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:252](../server/src/routes/admin/idracCore.js#L252) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:253](../server/src/routes/admin/idracCore.js#L253) |
| POST | `/idrac/register-scanned` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:329](../server/src/routes/admin/idracScan.js#L329) |
| POST | `/idrac/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:267](../server/src/routes/admin/idracScan.js#L267) |
| GET | `/idrac/scan-agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:315](../server/src/routes/admin/idracScan.js#L315) |
| GET | `/idrac/scan-job-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:496](../server/src/routes/admin/idracScan.js#L496) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:514](../server/src/routes/admin/idracScan.js#L514) |
| GET | `/idrac/scan-jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:486](../server/src/routes/admin/idracScan.js#L486) |
| GET | `/idrac/scan-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:460](../server/src/routes/admin/idracScan.js#L460) |
| GET | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:346](../server/src/routes/admin/idracScan.js#L346) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:352](../server/src/routes/admin/idracScan.js#L352) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:360](../server/src/routes/admin/idracScan.js#L360) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:371](../server/src/routes/admin/idracScan.js#L371) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:392](../server/src/routes/admin/idracScan.js#L392) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:474](../server/src/routes/admin/idracScan.js#L474) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/idracScan.js:386](../server/src/routes/admin/idracScan.js#L386) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:448](../server/src/routes/admin/idracScan.js#L448) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:457](../server/src/routes/admin/idracScan.js#L457) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:467](../server/src/routes/admin/idracScan.js#L467) |
| GET | `/idrac/scan-result` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:306](../server/src/routes/admin/idracScan.js#L306) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:512](../server/src/routes/admin/idracCore.js#L512) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:238](../server/src/routes/admin/idracCore.js#L238) |
| GET | `/idrac/trend/export.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:727](../server/src/routes/admin/idracTrend.js#L727) |
| GET | `/idrac/trend/export.xlsx` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:751](../server/src/routes/admin/idracTrend.js#L751) |
| GET | `/idrac/trend/resolve-host` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:704](../server/src/routes/admin/idracTrend.js#L704) |
| GET | `/idrac/trend/servers` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:638](../server/src/routes/admin/idracTrend.js#L638) |
| GET | `/idrac/trend/table` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:645](../server/src/routes/admin/idracTrend.js#L645) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:503](../server/src/routes/admin/idracCore.js#L503) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:63](../server/src/routes/admin/centralIpam.js#L63) |
| POST | `/ipam/scan/agent/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:316](../server/src/routes/admin/centralIpam.js#L316) |
| GET | `/ipam/scan/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:204](../server/src/routes/admin/centralIpam.js#L204) |
| GET | `/ipam/scan/log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:390](../server/src/routes/admin/centralIpam.js#L390) |
| GET | `/ipam/scan/migration` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:362](../server/src/routes/admin/centralIpam.js#L362) |
| POST | `/ipam/scan/migration/dismiss` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:385](../server/src/routes/admin/centralIpam.js#L385) |
| POST | `/ipam/scan/migration/move` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:363](../server/src/routes/admin/centralIpam.js#L363) |
| POST | `/ipam/scan/migration/remove` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:375](../server/src/routes/admin/centralIpam.js#L375) |
| GET | `/ipam/scan/owners` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:196](../server/src/routes/admin/centralIpam.js#L196) |
| GET | `/ipam/scan/ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:273](../server/src/routes/admin/centralIpam.js#L273) |
| GET | `/ipam/scan/ranges.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:414](../server/src/routes/admin/centralIpam.js#L414) |
| POST | `/ipam/scan/ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:425](../server/src/routes/admin/centralIpam.js#L425) |
| POST | `/ipam/scan/ranges/line` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:291](../server/src/routes/admin/centralIpam.js#L291) |
| GET | `/ipam/scan/ranges/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:420](../server/src/routes/admin/centralIpam.js#L420) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:401](../server/src/routes/admin/centralIpam.js#L401) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:393](../server/src/routes/admin/centralIpam.js#L393) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:121](../server/src/routes/admin/centralIpam.js#L121) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:140](../server/src/routes/admin/centralIpam.js#L140) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:398](../server/src/routes/admin/centralIpam.js#L398) |
| GET | `/ipam/scan/suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:166](../server/src/routes/admin/centralIpam.js#L166) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:93](../server/src/routes/admin/centralIpam.js#L93) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:97](../server/src/routes/admin/centralIpam.js#L97) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:449](../server/src/routes/admin/centralIpam.js#L449) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:505](../server/src/routes/admin/centralIpam.js#L505) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:526](../server/src/routes/admin/centralIpam.js#L526) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:520](../server/src/routes/admin/centralIpam.js#L520) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:511](../server/src/routes/admin/centralIpam.js#L511) |
| GET | `/ipam/vc-ranges/suggest` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:473](../server/src/routes/admin/centralIpam.js#L473) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:524](../server/src/routes/admin/deployLlm.js#L524) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:525](../server/src/routes/admin/deployLlm.js#L525) |
| POST | `/llm-test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:531](../server/src/routes/admin/deployLlm.js#L531) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:86](../server/src/routes/admin/statusTools.js#L86) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:34](../server/src/routes/admin/mail.js#L34) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:38](../server/src/routes/admin/mail.js#L38) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:64](../server/src/routes/admin/mail.js#L64) |
| GET | `/memtrack` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:202](../server/src/routes/admin/statusTools.js#L202) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:140](../server/src/routes/admin/gpuGuest.js#L140) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:144](../server/src/routes/admin/gpuGuest.js#L144) |
| GET | `/net/agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:269](../server/src/routes/admin/backupNetSec.js#L269) |
| GET | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:301](../server/src/routes/admin/backupNetSec.js#L301) |
| POST | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:276](../server/src/routes/admin/backupNetSec.js#L276) |
| GET | `/net/history` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:318](../server/src/routes/admin/backupNetSec.js#L318) |
| DELETE | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:320](../server/src/routes/admin/backupNetSec.js#L320) |
| GET | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:319](../server/src/routes/admin/backupNetSec.js#L319) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:328](../server/src/routes/admin/backupNetSec.js#L328) |
| GET | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:323](../server/src/routes/admin/backupNetSec.js#L323) |
| PUT | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:324](../server/src/routes/admin/backupNetSec.js#L324) |
| DELETE | `/net/monitors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:325](../server/src/routes/admin/backupNetSec.js#L325) |
| POST | `/net/monitors/:id/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:326](../server/src/routes/admin/backupNetSec.js#L326) |
| POST | `/net/pcap` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:307](../server/src/routes/admin/backupNetSec.js#L307) |
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
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:545](../server/src/routes/admin/deployLlm.js#L545) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:542](../server/src/routes/admin/deployLlm.js#L542) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:256](../server/src/routes/admin/opsSettings.js#L256) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:286](../server/src/routes/admin/opsSettings.js#L286) |
| GET | `/os-scan/results.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/opsSettings.js:290](../server/src/routes/admin/opsSettings.js#L290) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:268](../server/src/routes/admin/opsSettings.js#L268) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:259](../server/src/routes/admin/opsSettings.js#L259) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:42](../server/src/routes/admin/deployLlm.js#L42) |
| POST | `/packages/download` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:59](../server/src/routes/admin/deployLlm.js#L59) |
| PUT | `/packages/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:56](../server/src/routes/admin/deployLlm.js#L56) |
| GET | `/perf` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:22](../server/src/routes/admin/perfMonitor.js#L22) |
| DELETE | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:60](../server/src/routes/admin/perfMonitor.js#L60) |
| GET | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:54](../server/src/routes/admin/perfMonitor.js#L54) |
| POST | `/perf/measure` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:47](../server/src/routes/admin/perfMonitor.js#L47) |
| PUT | `/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:31](../server/src/routes/admin/perfMonitor.js#L31) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:134](../server/src/routes/admin/users.js#L134) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:196](../server/src/routes/admin/users.js#L196) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:215](../server/src/routes/admin/users.js#L215) |
| GET | `/portal-db` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:109](../server/src/routes/admin/statusTools.js#L109) |
| GET | `/portal-db/guide` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:113](../server/src/routes/admin/statusTools.js#L113) |
| GET | `/portal-db/health` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:127](../server/src/routes/admin/statusTools.js#L127) |
| GET | `/portal-db/location` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:146](../server/src/routes/admin/statusTools.js#L146) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:162](../server/src/routes/admin/statusTools.js#L162) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:172](../server/src/routes/admin/statusTools.js#L172) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:302](../server/src/routes/admin/opsSettings.js#L302) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:348](../server/src/routes/admin/opsSettings.js#L348) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:343](../server/src/routes/admin/opsSettings.js#L343) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:555](../server/src/routes/admin/deployLlm.js#L555) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:559](../server/src/routes/admin/deployLlm.js#L559) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:121](../server/src/routes/admin/opsSettings.js#L121) |
| PUT | `/report/daily` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:122](../server/src/routes/admin/opsSettings.js#L122) |
| POST | `/report/daily/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:127](../server/src/routes/admin/opsSettings.js#L127) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:170](../server/src/routes/admin/idracCore.js#L170) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:133](../server/src/routes/admin/idracCore.js#L133) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:155](../server/src/routes/admin/idracCore.js#L155) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:175](../server/src/routes/admin/opsSettings.js#L175) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:178](../server/src/routes/admin/opsSettings.js#L178) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:422](../server/src/routes/admin/backupNetSec.js#L422) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:433](../server/src/routes/admin/backupNetSec.js#L433) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:453](../server/src/routes/admin/backupNetSec.js#L453) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:454](../server/src/routes/admin/backupNetSec.js#L454) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:394](../server/src/routes/admin/backupNetSec.js#L394) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:412](../server/src/routes/admin/backupNetSec.js#L412) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:411](../server/src/routes/admin/backupNetSec.js#L411) |
| GET | `/security/login-fails/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:410](../server/src/routes/admin/backupNetSec.js#L410) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:415](../server/src/routes/admin/backupNetSec.js#L415) |
| GET | `/security/peer-trust` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:72](../server/src/routes/admin/peerTrust.js#L72) |
| POST | `/security/peer-trust/approve` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:84](../server/src/routes/admin/peerTrust.js#L84) |
| POST | `/security/peer-trust/approve-observed` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:134](../server/src/routes/admin/peerTrust.js#L134) |
| PUT | `/security/peer-trust/policy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/peerTrust.js:147](../server/src/routes/admin/peerTrust.js#L147) |
| POST | `/security/peer-trust/reject` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:112](../server/src/routes/admin/peerTrust.js#L112) |
| POST | `/security/peer-trust/remove` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:124](../server/src/routes/admin/peerTrust.js#L124) |
| GET | `/security/self-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/securityCheck.js:22](../server/src/routes/admin/securityCheck.js#L22) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:204](../server/src/routes/admin/opsSettings.js#L204) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:209](../server/src/routes/admin/opsSettings.js#L209) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:210](../server/src/routes/admin/statusTools.js#L210) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:19](../server/src/routes/admin/toolCategories.js#L19) |
| PUT | `/tool-categories` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/toolCategories.js:28](../server/src/routes/admin/toolCategories.js#L28) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:47](../server/src/routes/admin/toolCategories.js#L47) |
| PUT | `/user-tools/:username` | 역할 `admin` | [server/src/routes/admin/users.js:171](../server/src/routes/admin/users.js#L171) |
| GET | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:92](../server/src/routes/admin/users.js#L92) |
| POST | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:102](../server/src/routes/admin/users.js#L102) |
| DELETE | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:124](../server/src/routes/admin/users.js#L124) |
| PATCH | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:113](../server/src/routes/admin/users.js#L113) |
| DELETE | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:239](../server/src/routes/admin/users.js#L239) |
| POST | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:231](../server/src/routes/admin/users.js#L231) |
| POST | `/users/:username/totp/begin` | 역할 `admin` | [server/src/routes/admin/users.js:252](../server/src/routes/admin/users.js#L252) |
| POST | `/users/:username/totp/confirm` | 역할 `admin` | [server/src/routes/admin/users.js:258](../server/src/routes/admin/users.js#L258) |
| POST | `/users/:username/totp/disable` | 역할 `admin` | [server/src/routes/admin/users.js:264](../server/src/routes/admin/users.js#L264) |
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
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:261](../server/src/routes/admin/backupNetSec.js#L261) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:241](../server/src/routes/admin/backupNetSec.js#L241) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:238](../server/src/routes/admin/backupNetSec.js#L238) |
| GET | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:58](../server/src/routes/admin/veeamEm.js#L58) |
| POST | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:69](../server/src/routes/admin/veeamEm.js#L69) |
| DELETE | `/veeam/em/:id` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:79](../server/src/routes/admin/veeamEm.js#L79) |
| POST | `/veeam/em/:id/collect` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:121](../server/src/routes/admin/veeamEm.js#L121) |
| POST | `/veeam/em/:id/test` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:103](../server/src/routes/admin/veeamEm.js#L103) |
| PUT | `/veeam/em/map` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:91](../server/src/routes/admin/veeamEm.js#L91) |
| GET | `/veeam/servers` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:93](../server/src/routes/admin/veeam.js#L93) |
| POST | `/veeam/servers` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:124](../server/src/routes/admin/veeam.js#L124) |
| DELETE | `/veeam/servers/:id` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:142](../server/src/routes/admin/veeam.js#L142) |
| POST | `/veeam/servers/:id/collect` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:178](../server/src/routes/admin/veeam.js#L178) |
| POST | `/veeam/servers/:id/test` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:154](../server/src/routes/admin/veeam.js#L154) |
| GET | `/veeam/servers/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:216](../server/src/routes/admin/veeam.js#L216) |
| GET | `/veeam/servers/export.txt` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:221](../server/src/routes/admin/veeam.js#L221) |
| POST | `/veeam/servers/import` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:270](../server/src/routes/admin/veeam.js#L270) |
| POST | `/veeam/servers/import/test` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:231](../server/src/routes/admin/veeam.js#L231) |
| GET | `/veeam/servers/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:263](../server/src/routes/admin/veeam.js#L263) |
| GET | `/veeam/servers/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:226](../server/src/routes/admin/veeam.js#L226) |
| GET | `/veeam/servers/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:227](../server/src/routes/admin/veeam.js#L227) |
| GET | `/veeam/vc-accounts` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:77](../server/src/routes/admin/veeam.js#L77) |
| PUT | `/veeam/vc-accounts` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:78](../server/src/routes/admin/veeam.js#L78) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:398](../server/src/routes/admin/collectorsDc.js#L398) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:426](../server/src/routes/admin/collectorsDc.js#L426) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/activity` | — | [server/src/routes/auth.js:279](../server/src/routes/auth.js#L279) |
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:334](../server/src/routes/auth.js#L334) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` · `requireSettingsOwner` | [server/src/routes/auth.js:344](../server/src/routes/auth.js#L344) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:357](../server/src/routes/auth.js#L357) |
| GET | `/config` | — | [server/src/routes/auth.js:26](../server/src/routes/auth.js#L26) |
| POST | `/extend` | `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:210](../server/src/routes/auth.js#L210) |
| POST | `/login` | — | [server/src/routes/auth.js:47](../server/src/routes/auth.js#L47) |
| POST | `/logout` | `authMiddleware` | [server/src/routes/auth.js:261](../server/src/routes/auth.js#L261) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:180](../server/src/routes/auth.js#L180) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:303](../server/src/routes/auth.js#L303) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:313](../server/src/routes/auth.js#L313) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:223](../server/src/routes/ping.js#L223) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:233](../server/src/routes/ping.js#L233) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:177](../server/src/routes/ping.js#L177) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:183](../server/src/routes/ping.js#L183) |
| GET | `/series` | — | [server/src/routes/ping.js:97](../server/src/routes/ping.js#L97) |
| GET | `/status` | — | [server/src/routes/ping.js:79](../server/src/routes/ping.js#L79) |
| GET | `/targets` | — | [server/src/routes/ping.js:92](../server/src/routes/ping.js#L92) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:150](../server/src/routes/ping.js#L150) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:158](../server/src/routes/ping.js#L158) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:154](../server/src/routes/ping.js#L154) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:240](../server/src/routes/ping.js#L240) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:254](../server/src/routes/ping.js#L254) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:256](../server/src/routes/ping.js#L256) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:262](../server/src/routes/ping.js#L262) |

## `/metrics`

Prometheus/OTel 익스포터(선택 토큰).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/metricsExport.js:30](../server/src/routes/metricsExport.js#L30) |

## `/api/v1`

**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/publicApi.js:171](../server/src/routes/publicApi.js#L171) |
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:316](../server/src/routes/publicApi.js#L316) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:331](../server/src/routes/publicApi.js#L331) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:453](../server/src/routes/publicApi.js#L453) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:500](../server/src/routes/publicApi.js#L500) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:525](../server/src/routes/publicApi.js#L525) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:283](../server/src/routes/publicApi.js#L283) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:188](../server/src/routes/publicApi.js#L188) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:258](../server/src/routes/publicApi.js#L258) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:181](../server/src/routes/publicApi.js#L181) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:600](../server/src/routes/api/inventory.js#L600) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:603](../server/src/routes/api/inventory.js#L603) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:611](../server/src/routes/api/inventory.js#L611) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:583](../server/src/routes/api/inventory.js#L583) |
| GET | `/board/persist` | — | [server/src/routes/api/bulletin.js:195](../server/src/routes/api/bulletin.js#L195) |
| POST | `/board/persist/retry` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bulletin.js:200](../server/src/routes/api/bulletin.js#L200) |
| GET | `/board/posts` | — | [server/src/routes/api/bulletin.js:132](../server/src/routes/api/bulletin.js#L132) |
| POST | `/board/posts` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:141](../server/src/routes/api/bulletin.js#L141) |
| DELETE | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:156](../server/src/routes/api/bulletin.js#L156) |
| GET | `/board/posts/:id` | — | [server/src/routes/api/bulletin.js:137](../server/src/routes/api/bulletin.js#L137) |
| PUT | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:148](../server/src/routes/api/bulletin.js#L148) |
| POST | `/board/posts/:id/comments` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:164](../server/src/routes/api/bulletin.js#L164) |
| DELETE | `/board/posts/:id/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:185](../server/src/routes/api/bulletin.js#L185) |
| POST | `/board/posts/:id/comments/:cid/like` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:181](../server/src/routes/api/bulletin.js#L181) |
| POST | `/board/posts/:id/like` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:177](../server/src/routes/api/bulletin.js#L177) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:494](../server/src/routes/api/inventory.js#L494) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:502](../server/src/routes/api/inventory.js#L502) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:132](../server/src/routes/api/overviewNsx.js#L132) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:337](../server/src/routes/api/inventory.js#L337) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:125](../server/src/routes/api/vmMetrics.js#L125) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:213](../server/src/routes/api/vmMetrics.js#L213) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:517](../server/src/routes/api/inventory.js#L517) |
| GET | `/notices` | — | [server/src/routes/api/bulletin.js:103](../server/src/routes/api/bulletin.js#L103) |
| POST | `/notices` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:107](../server/src/routes/api/bulletin.js#L107) |
| DELETE | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:122](../server/src/routes/api/bulletin.js#L122) |
| PUT | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:114](../server/src/routes/api/bulletin.js#L114) |
| GET | `/notices/active` | — | [server/src/routes/api/bulletin.js:99](../server/src/routes/api/bulletin.js#L99) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:238](../server/src/routes/api/overviewNsx.js#L238) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:272](../server/src/routes/api/overviewNsx.js#L272) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:189](../server/src/routes/api/overviewNsx.js#L189) |
| GET | `/overview/cards` | — | [server/src/routes/api/overviewCards.js:155](../server/src/routes/api/overviewCards.js#L155) |
| GET | `/overview/trend` | — | [server/src/routes/api/overviewCards.js:211](../server/src/routes/api/overviewCards.js#L211) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:117](../server/src/routes/api/perfClient.js#L117) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:75](../server/src/routes/api/perfClient.js#L75) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:105](../server/src/routes/api/perfClient.js#L105) |
| GET | `/provision/jobs` | — | [server/src/routes/api/provision.js:59](../server/src/routes/api/provision.js#L59) |
| GET | `/provision/jobs/:id` | — | [server/src/routes/api/provision.js:64](../server/src/routes/api/provision.js#L64) |
| GET | `/provision/placement` | 권한 `vm.provision` | [server/src/routes/api/provision.js:28](../server/src/routes/api/provision.js#L28) |
| POST | `/provision/preview` | 권한 `vm.provision` | [server/src/routes/api/provision.js:40](../server/src/routes/api/provision.js#L40) |
| GET | `/provision/saved` | 권한 `vm.provision` | [server/src/routes/api/provision.js:45](../server/src/routes/api/provision.js#L45) |
| GET | `/provision/saved/:id` | 권한 `vm.provision` | [server/src/routes/api/provision.js:48](../server/src/routes/api/provision.js#L48) |
| GET | `/provision/sources` | 권한 `vm.provision` | [server/src/routes/api/provision.js:21](../server/src/routes/api/provision.js#L21) |
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:33](../server/src/routes/api/searchNotes.js#L33) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:15](../server/src/routes/api/searchNotes.js#L15) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:151](../server/src/routes/api/inventory.js#L151) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:630](../server/src/routes/api/inventory.js#L630) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:626](../server/src/routes/api/inventory.js#L626) |
| GET | `/tools/backup-detail` | 권한 `tools` | [server/src/routes/api/veeam.js:617](../server/src/routes/api/veeam.js#L617) |
| GET | `/tools/backup-detail.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:689](../server/src/routes/api/veeam.js#L689) |
| PUT | `/tools/backup-detail/marks` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/veeam.js:632](../server/src/routes/api/veeam.js#L632) |
| GET | `/tools/backup-em` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:578](../server/src/routes/api/veeam.js#L578) |
| GET | `/tools/backup-em/session` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:587](../server/src/routes/api/veeam.js#L587) |
| GET | `/tools/backup-summary` | 권한 `tools` | [server/src/routes/api/veeam.js:564](../server/src/routes/api/veeam.js#L564) |
| GET | `/tools/backup-summary.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:665](../server/src/routes/api/veeam.js#L665) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:26](../server/src/routes/api/bmstor.js#L26) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:143](../server/src/routes/api/bmstor.js#L143) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:87](../server/src/routes/api/bmstor.js#L87) |
| GET | `/tools/bm-storage/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:48](../server/src/routes/api/bmstor.js#L48) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:107](../server/src/routes/api/bmstor.js#L107) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:101](../server/src/routes/api/bmstor.js#L101) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:65](../server/src/routes/api/bmstor.js#L65) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:71](../server/src/routes/api/bmstor.js#L71) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:78](../server/src/routes/api/bmstor.js#L78) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:214](../server/src/routes/api/bmUsage.js#L214) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:381](../server/src/routes/api/bmUsage.js#L381) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:353](../server/src/routes/api/bmUsage.js#L353) |
| PUT | `/tools/bm-usage/distribute` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/bmUsage.js:560](../server/src/routes/api/bmUsage.js#L560) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:439](../server/src/routes/api/bmUsage.js#L439) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:519](../server/src/routes/api/bmUsage.js#L519) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:305](../server/src/routes/api/bmUsage.js#L305) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:572](../server/src/routes/api/bmUsage.js#L572) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:72](../server/src/routes/api/toolsCapacity.js#L72) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1787](../server/src/routes/api/toolsCapacity.js#L1787) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1698](../server/src/routes/api/toolsCapacity.js#L1698) |
| GET | `/tools/cluster-check` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:36](../server/src/routes/api/clusterCheck.js#L36) |
| GET | `/tools/cluster-check.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/clusterCheck.js:62](../server/src/routes/api/clusterCheck.js#L62) |
| GET | `/tools/cluster-check/of` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:49](../server/src/routes/api/clusterCheck.js#L49) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:108](../server/src/routes/api/commMap.js#L108) |
| GET | `/tools/contention` | 권한 `tools` | [server/src/routes/api/contention.js:33](../server/src/routes/api/contention.js#L33) |
| GET | `/tools/contention.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/contention.js:57](../server/src/routes/api/contention.js#L57) |
| GET | `/tools/core-license` | 권한 `tools` | [server/src/routes/api/coreLicense.js:28](../server/src/routes/api/coreLicense.js#L28) |
| GET | `/tools/core-license.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/coreLicense.js:33](../server/src/routes/api/coreLicense.js#L33) |
| GET | `/tools/corp-usage` | 권한 `tools` | [server/src/routes/api/corpUsage.js:98](../server/src/routes/api/corpUsage.js#L98) |
| GET | `/tools/cost-showback` | 권한 `tools` | [server/src/routes/api/costShowback.js:37](../server/src/routes/api/costShowback.js#L37) |
| GET | `/tools/cost-showback.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/costShowback.js:59](../server/src/routes/api/costShowback.js#L59) |
| GET | `/tools/cost-showback/settings` | 권한 `tools` | [server/src/routes/api/costShowback.js:43](../server/src/routes/api/costShowback.js#L43) |
| PUT | `/tools/cost-showback/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/costShowback.js:48](../server/src/routes/api/costShowback.js#L48) |
| GET | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:45](../server/src/routes/api/credentials.js#L45) |
| POST | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:55](../server/src/routes/api/credentials.js#L55) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:75](../server/src/routes/api/credentials.js#L75) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:65](../server/src/routes/api/credentials.js#L65) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:83](../server/src/routes/api/credentials.js#L83) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:50](../server/src/routes/api/credentials.js#L50) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:324](../server/src/routes/api/horizonSessions.js#L324) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:57](../server/src/routes/api/curUser.js#L57) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:123](../server/src/routes/api/curUser.js#L123) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:233](../server/src/routes/api/curUser.js#L233) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:138](../server/src/routes/api/curUser.js#L138) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:92](../server/src/routes/api/curUser.js#L92) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:149](../server/src/routes/api/curUser.js#L149) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:191](../server/src/routes/api/curUser.js#L191) |
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:266](../server/src/routes/api/cvp.js#L266) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:768](../server/src/routes/api/cvp.js#L768) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:362](../server/src/routes/api/cvp.js#L362) |
| GET | `/tools/cvp/device-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:423](../server/src/routes/api/cvp.js#L423) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:295](../server/src/routes/api/cvp.js#L295) |
| GET | `/tools/cvp/devices.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:728](../server/src/routes/api/cvp.js#L728) |
| GET | `/tools/cvp/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:440](../server/src/routes/api/cvp.js#L440) |
| GET | `/tools/cvp/faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:654](../server/src/routes/api/cvp.js#L654) |
| POST | `/tools/cvp/faults/close` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:694](../server/src/routes/api/cvp.js#L694) |
| POST | `/tools/cvp/faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:682](../server/src/routes/api/cvp.js#L682) |
| GET | `/tools/cvp/optics` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:491](../server/src/routes/api/cvp.js#L491) |
| GET | `/tools/cvp/overview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:318](../server/src/routes/api/cvp.js#L318) |
| POST | `/tools/cvp/parse-preview` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:715](../server/src/routes/api/cvp.js#L715) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:753](../server/src/routes/api/cvp.js#L753) |
| GET | `/tools/cvp/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:626](../server/src/routes/api/cvp.js#L626) |
| GET | `/tools/cvp/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:560](../server/src/routes/api/cvp.js#L560) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:791](../server/src/routes/api/cvp.js#L791) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:817](../server/src/routes/api/cvp.js#L817) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:820](../server/src/routes/api/cvp.js#L820) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:818](../server/src/routes/api/cvp.js#L818) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:831](../server/src/routes/api/cvp.js#L831) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:859](../server/src/routes/api/cvp.js#L859) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:862](../server/src/routes/api/cvp.js#L862) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:64](../server/src/routes/api/dataFlow.js#L64) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:190](../server/src/routes/api/checksLogs.js#L190) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:30](../server/src/routes/api/deviceFlow.js#L30) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:25](../server/src/routes/api/vcTools.js#L25) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:440](../server/src/routes/api/hardwareGpu.js#L440) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1369](../server/src/routes/api/toolsCapacity.js#L1369) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1506](../server/src/routes/api/toolsCapacity.js#L1506) |
| GET | `/tools/esxi-temp/sensors` | 권한 `tools` | [server/src/routes/api/serverSensors.js:138](../server/src/routes/api/serverSensors.js#L138) |
| GET | `/tools/esxi-temp/sensors/:id` | 권한 `tools` | [server/src/routes/api/serverSensors.js:181](../server/src/routes/api/serverSensors.js#L181) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1589](../server/src/routes/api/toolsCapacity.js#L1589) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:459](../server/src/routes/api/hardwareGpu.js#L459) |
| GET | `/tools/gpu.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:475](../server/src/routes/api/hardwareGpu.js#L475) |
| GET | `/tools/gpu.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:467](../server/src/routes/api/hardwareGpu.js#L467) |
| GET | `/tools/gpu/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:515](../server/src/routes/api/hardwareGpu.js#L515) |
| GET | `/tools/gpu/export.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:516](../server/src/routes/api/hardwareGpu.js#L516) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:219](../server/src/routes/api/toolsAnalytics.js#L219) |
| GET | `/tools/gpu/host` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:556](../server/src/routes/api/hardwareGpu.js#L556) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:491](../server/src/routes/api/hardwareGpu.js#L491) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:572](../server/src/routes/api/hardwareGpu.js#L572) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:429](../server/src/routes/api/toolsCapacity.js#L429) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:42](../server/src/routes/api/toolsGuestDisk.js#L42) |
| GET | `/tools/guest-disk/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:97](../server/src/routes/api/toolsGuestDisk.js#L97) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:86](../server/src/routes/api/toolsGuestDisk.js#L86) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:80](../server/src/routes/api/toolsGuestDisk.js#L80) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:54](../server/src/routes/api/toolsGuestDisk.js#L54) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:48](../server/src/routes/api/toolsInfo.js#L48) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:66](../server/src/routes/api/toolsInfo.js#L66) |
| GET | `/tools/guest-partition` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:50](../server/src/routes/api/toolsGuestPart.js#L50) |
| GET | `/tools/guest-partition/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestPart.js:72](../server/src/routes/api/toolsGuestPart.js#L72) |
| GET | `/tools/guest-partition/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:104](../server/src/routes/api/toolsGuestPart.js#L104) |
| POST | `/tools/guest-partition/mail/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:110](../server/src/routes/api/toolsGuestPart.js#L110) |
| POST | `/tools/guest-partition/mail/send` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:116](../server/src/routes/api/toolsGuestPart.js#L116) |
| POST | `/tools/guest-partition/mail/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:124](../server/src/routes/api/toolsGuestPart.js#L124) |
| GET | `/tools/guest-partition/settings` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:87](../server/src/routes/api/toolsGuestPart.js#L87) |
| PUT | `/tools/guest-partition/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:95](../server/src/routes/api/toolsGuestPart.js#L95) |
| GET | `/tools/guest-partition/vcenter/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:63](../server/src/routes/api/toolsGuestPart.js#L63) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:408](../server/src/routes/api/hardwareGpu.js#L408) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:90](../server/src/routes/api/toolsInfo.js#L90) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:200](../server/src/routes/api/horizonSessions.js#L200) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:254](../server/src/routes/api/horizonSessions.js#L254) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:267](../server/src/routes/api/horizonSessions.js#L267) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:238](../server/src/routes/api/horizonSessions.js#L238) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:277](../server/src/routes/api/horizonSessions.js#L277) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:297](../server/src/routes/api/horizonSessions.js#L297) |
| GET | `/tools/horizon-sessions/usage` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:163](../server/src/routes/api/horizonSessions.js#L163) |
| GET | `/tools/horizon-sessions/usage.csv` | 권한 `data.csv` | [server/src/routes/api/horizonSessions.js:178](../server/src/routes/api/horizonSessions.js#L178) |
| GET | `/tools/host-hygiene` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:47](../server/src/routes/api/hostHygiene.js#L47) |
| GET | `/tools/host-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hostHygiene.js:88](../server/src/routes/api/hostHygiene.js#L88) |
| GET | `/tools/host-hygiene/reboots` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:61](../server/src/routes/api/hostHygiene.js#L61) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:39](../server/src/routes/api/toolsAnalytics.js#L39) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:546](../server/src/routes/api/hardwareGpu.js#L546) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:521](../server/src/routes/api/hardwareGpu.js#L521) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:152](../server/src/routes/api/ipamExport.js#L152) |
| GET | `/tools/ipam.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:544](../server/src/routes/api/ipamExport.js#L544) |
| GET | `/tools/ipam.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:515](../server/src/routes/api/ipamExport.js#L515) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:290](../server/src/routes/api/ipamExport.js#L290) |
| PUT | `/tools/ipam/annotation` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:301](../server/src/routes/api/ipamExport.js#L301) |
| POST | `/tools/ipam/bulk` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:371](../server/src/routes/api/ipamExport.js#L371) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:212](../server/src/routes/api/ipamExport.js#L212) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:187](../server/src/routes/api/ipamExport.js#L187) |
| DELETE | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:357](../server/src/routes/api/ipamExport.js#L357) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:329](../server/src/routes/api/ipamExport.js#L329) |
| PUT | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:342](../server/src/routes/api/ipamExport.js#L342) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:317](../server/src/routes/api/ipamExport.js#L317) |
| GET | `/tools/ipam/manage.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:596](../server/src/routes/api/ipamExport.js#L596) |
| POST | `/tools/ipam/manage/import` | 역할 `admin/operator` · 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:621](../server/src/routes/api/ipamExport.js#L621) |
| GET | `/tools/ipam/manage/sample.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:610](../server/src/routes/api/ipamExport.js#L610) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:254](../server/src/routes/api/ipamExport.js#L254) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:403](../server/src/routes/api/ipamExport.js#L403) |
| POST | `/tools/ipam/policies` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:434](../server/src/routes/api/ipamExport.js#L434) |
| DELETE | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:488](../server/src/routes/api/ipamExport.js#L488) |
| PUT | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:455](../server/src/routes/api/ipamExport.js#L455) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:412](../server/src/routes/api/ipamExport.js#L412) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:429](../server/src/routes/api/ipamExport.js#L429) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:265](../server/src/routes/api/ipamExport.js#L265) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:201](../server/src/routes/api/ipamExport.js#L201) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:197](../server/src/routes/api/ipamExport.js#L197) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:220](../server/src/routes/api/ipamExport.js#L220) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:242](../server/src/routes/api/ipamExport.js#L242) |
| GET | `/tools/isilon-dirusage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:118](../server/src/routes/api/isilonDirUsage.js#L118) |
| POST | `/tools/isilon-dirusage/bulk` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:242](../server/src/routes/api/isilonDirUsage.js#L242) |
| GET | `/tools/isilon-dirusage/digest` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:367](../server/src/routes/api/isilonDirUsage.js#L367) |
| PUT | `/tools/isilon-dirusage/digest` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:369](../server/src/routes/api/isilonDirUsage.js#L369) |
| POST | `/tools/isilon-dirusage/digest/preview` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:387](../server/src/routes/api/isilonDirUsage.js#L387) |
| POST | `/tools/isilon-dirusage/digest/send-now` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:379](../server/src/routes/api/isilonDirUsage.js#L379) |
| GET | `/tools/isilon-dirusage/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:188](../server/src/routes/api/isilonDirUsage.js#L188) |
| POST | `/tools/isilon-dirusage/key` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:394](../server/src/routes/api/isilonDirUsage.js#L394) |
| POST | `/tools/isilon-dirusage/mail-now` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:340](../server/src/routes/api/isilonDirUsage.js#L340) |
| GET | `/tools/isilon-dirusage/overview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:144](../server/src/routes/api/isilonDirUsage.js#L144) |
| GET | `/tools/isilon-dirusage/report` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:159](../server/src/routes/api/isilonDirUsage.js#L159) |
| POST | `/tools/isilon-dirusage/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:277](../server/src/routes/api/isilonDirUsage.js#L277) |
| GET | `/tools/isilon-dirusage/settings` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:211](../server/src/routes/api/isilonDirUsage.js#L211) |
| PUT | `/tools/isilon-dirusage/settings` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:226](../server/src/routes/api/isilonDirUsage.js#L226) |
| POST | `/tools/isilon-dirusage/test` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:305](../server/src/routes/api/isilonDirUsage.js#L305) |
| GET | `/tools/isilon-dirusage/trend` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:178](../server/src/routes/api/isilonDirUsage.js#L178) |
| GET | `/tools/isilon-dirusage/users` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:167](../server/src/routes/api/isilonDirUsage.js#L167) |
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:187](../server/src/routes/api/toolsInfo.js#L187) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:114](../server/src/routes/api/toolsInfo.js#L114) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:53](../server/src/routes/api/linkCheck.js#L53) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:186](../server/src/routes/api/linkCheck.js#L186) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:171](../server/src/routes/api/linkCheck.js#L171) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:158](../server/src/routes/api/linkCheck.js#L158) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:196](../server/src/routes/api/linkCheck.js#L196) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:147](../server/src/routes/api/linkCheck.js#L147) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:212](../server/src/routes/api/linkCheck.js#L212) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:277](../server/src/routes/api/linkCheck.js#L277) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:225](../server/src/routes/api/linkCheck.js#L225) |
| GET | `/tools/migration-readiness` | 권한 `tools` | [server/src/routes/api/migrationReadiness.js:34](../server/src/routes/api/migrationReadiness.js#L34) |
| GET | `/tools/migration-readiness.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/migrationReadiness.js:38](../server/src/routes/api/migrationReadiness.js#L38) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:242](../server/src/routes/api/checksLogs.js#L242) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1860](../server/src/routes/api/toolsCapacity.js#L1860) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1824](../server/src/routes/api/toolsCapacity.js#L1824) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:321](../server/src/routes/api/partFaults.js#L321) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:453](../server/src/routes/api/partFaults.js#L453) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:353](../server/src/routes/api/partFaults.js#L353) |
| GET | `/tools/part-faults/incidents` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:389](../server/src/routes/api/partFaults.js#L389) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:468](../server/src/routes/api/partFaults.js#L468) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:420](../server/src/routes/api/partFaults.js#L420) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:440](../server/src/routes/api/partFaults.js#L440) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:430](../server/src/routes/api/partFaults.js#L430) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:60](../server/src/routes/api/pdu.js#L60) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:140](../server/src/routes/api/pdu.js#L140) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:293](../server/src/routes/api/pdu.js#L293) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:178](../server/src/routes/api/pdu.js#L178) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:210](../server/src/routes/api/pdu.js#L210) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:204](../server/src/routes/api/pdu.js#L204) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:132](../server/src/routes/api/pdu.js#L132) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:257](../server/src/routes/api/pdu.js#L257) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:263](../server/src/routes/api/pdu.js#L263) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:273](../server/src/routes/api/pdu.js#L273) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:251](../server/src/routes/api/pdu.js#L251) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:164](../server/src/routes/api/pdu.js#L164) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:152](../server/src/routes/api/pdu.js#L152) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:234](../server/src/routes/api/pdu.js#L234) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:123](../server/src/routes/api/pdu.js#L123) |
| GET | `/tools/portal-check/arch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:356](../server/src/routes/api/portalCheck.js#L356) |
| POST | `/tools/portal-check/arch/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:357](../server/src/routes/api/portalCheck.js#L357) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:378](../server/src/routes/api/portalCheck.js#L378) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:211](../server/src/routes/api/portalCheck.js#L211) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:280](../server/src/routes/api/portalCheck.js#L280) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:244](../server/src/routes/api/portalCheck.js#L244) |
| GET | `/tools/power-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/overviewCards.js:234](../server/src/routes/api/overviewCards.js#L234) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:20](../server/src/routes/api/relaycheck.js#L20) |
| POST | `/tools/relaycheck/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:46](../server/src/routes/api/relaycheck.js#L46) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:39](../server/src/routes/api/relaycheck.js#L39) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:41](../server/src/routes/api/relaytopo.js#L41) |
| PUT | `/tools/relaytopo` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:76](../server/src/routes/api/relaytopo.js#L76) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:133](../server/src/routes/api/relaytopo.js#L133) |
| GET | `/tools/relaytopo/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:104](../server/src/routes/api/relaytopo.js#L104) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:124](../server/src/routes/api/relaytopo.js#L124) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:128](../server/src/routes/api/relaytopo.js#L128) |
| POST | `/tools/relaytopo/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:86](../server/src/routes/api/relaytopo.js#L86) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:117](../server/src/routes/api/relaytopo.js#L117) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:142](../server/src/routes/api/relaytopo.js#L142) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:163](../server/src/routes/api/reports.js#L163) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:140](../server/src/routes/api/reports.js#L140) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:115](../server/src/routes/api/reports.js#L115) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:186](../server/src/routes/api/reports.js#L186) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:179](../server/src/routes/api/reports.js#L179) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:75](../server/src/routes/api/reports.js#L75) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:120](../server/src/routes/api/reports.js#L120) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:85](../server/src/routes/api/reports.js#L85) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:222](../server/src/routes/api/reports.js#L222) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:109](../server/src/routes/api/reports.js#L109) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1185](../server/src/routes/api/toolsCapacity.js#L1185) |
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
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:189](../server/src/routes/api/sanSwitch.js#L189) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1071](../server/src/routes/api/sanSwitch.js#L1071) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1095](../server/src/routes/api/sanSwitch.js#L1095) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:340](../server/src/routes/api/sanSwitch.js#L340) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:348](../server/src/routes/api/sanSwitch.js#L348) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:398](../server/src/routes/api/sanSwitch.js#L398) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:668](../server/src/routes/api/sanSwitch.js#L668) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:656](../server/src/routes/api/sanSwitch.js#L656) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:548](../server/src/routes/api/sanSwitch.js#L548) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:589](../server/src/routes/api/sanSwitch.js#L589) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:747](../server/src/routes/api/sanSwitch.js#L747) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:759](../server/src/routes/api/sanSwitch.js#L759) |
| GET | `/tools/sanswitch/devices/:id/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:836](../server/src/routes/api/sanSwitch.js#L836) |
| GET | `/tools/sanswitch/devices/:id/port-usage.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:845](../server/src/routes/api/sanSwitch.js#L845) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:248](../server/src/routes/api/sanSwitch.js#L248) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:286](../server/src/routes/api/sanSwitch.js#L286) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1168](../server/src/routes/api/sanSwitch.js#L1168) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1176](../server/src/routes/api/sanSwitch.js#L1176) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1259](../server/src/routes/api/sanSwitch.js#L1259) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1204](../server/src/routes/api/sanSwitch.js#L1204) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1247](../server/src/routes/api/sanSwitch.js#L1247) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1184](../server/src/routes/api/sanSwitch.js#L1184) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1190](../server/src/routes/api/sanSwitch.js#L1190) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:606](../server/src/routes/api/sanSwitch.js#L606) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:679](../server/src/routes/api/sanSwitch.js#L679) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:467](../server/src/routes/api/sanSwitch.js#L467) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:450](../server/src/routes/api/sanSwitch.js#L450) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:427](../server/src/routes/api/sanSwitch.js#L427) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:435](../server/src/routes/api/sanSwitch.js#L435) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:882](../server/src/routes/api/sanSwitch.js#L882) |
| GET | `/tools/sanswitch/perf/traffic-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1014](../server/src/routes/api/sanSwitch.js#L1014) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1119](../server/src/routes/api/sanSwitch.js#L1119) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:364](../server/src/routes/api/sanSwitch.js#L364) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:387](../server/src/routes/api/sanSwitch.js#L387) |
| GET | `/tools/secret-scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/toolsInfo.js:39](../server/src/routes/api/toolsInfo.js#L39) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:62](../server/src/routes/api/serialLookup.js#L62) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:90](../server/src/routes/api/serialLookup.js#L90) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:214](../server/src/routes/api/checksLogs.js#L214) |
| POST | `/tools/service-check/settings-files/confirm` | 역할 `admin` · `settingsFleetOnly` | [server/src/routes/api/checksLogs.js:228](../server/src/routes/api/checksLogs.js#L228) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:154](../server/src/routes/api/vcTools.js#L154) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:61](../server/src/routes/api/vcTools.js#L61) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:80](../server/src/routes/api/storageMon.js#L80) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:611](../server/src/routes/api/storageMon.js#L611) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:686](../server/src/routes/api/storageMon.js#L686) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:698](../server/src/routes/api/storageMon.js#L698) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:706](../server/src/routes/api/storageMon.js#L706) |
| GET | `/tools/storage-paths` | 권한 `tools` | [server/src/routes/api/storagePaths.js:34](../server/src/routes/api/storagePaths.js#L34) |
| GET | `/tools/storage-paths.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/storagePaths.js:42](../server/src/routes/api/storagePaths.js#L42) |
| GET | `/tools/storage-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:26](../server/src/routes/api/storageUsage.js#L26) |
| GET | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:39](../server/src/routes/api/storageUsage.js#L39) |
| PUT | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:46](../server/src/routes/api/storageUsage.js#L46) |
| POST | `/tools/storage-usage/mail/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:63](../server/src/routes/api/storageUsage.js#L63) |
| POST | `/tools/storage-usage/mail/send-now` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:55](../server/src/routes/api/storageUsage.js#L55) |
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
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1236](../server/src/routes/api/toolsCapacity.js#L1236) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:148](../server/src/routes/api/toolsAnalytics.js#L148) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:379](../server/src/routes/api/checksLogs.js#L379) |
| GET | `/tools/vclogs/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/checksLogs.js:409](../server/src/routes/api/checksLogs.js#L409) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:365](../server/src/routes/api/checksLogs.js#L365) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:346](../server/src/routes/api/checksLogs.js#L346) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:317](../server/src/routes/api/checksLogs.js#L317) |
| GET | `/tools/vm-availability` | 권한 `tools` | [server/src/routes/api/vmAvailability.js:97](../server/src/routes/api/vmAvailability.js#L97) |
| GET | `/tools/vm-availability.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmAvailability.js:101](../server/src/routes/api/vmAvailability.js#L101) |
| GET | `/tools/vm-changes` | 권한 `tools` | [server/src/routes/api/vmChanges.js:55](../server/src/routes/api/vmChanges.js#L55) |
| GET | `/tools/vm-changes.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmChanges.js:91](../server/src/routes/api/vmChanges.js#L91) |
| GET | `/tools/vm-changes/of` | 권한 `tools` | [server/src/routes/api/vmChanges.js:68](../server/src/routes/api/vmChanges.js#L68) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:50](../server/src/routes/api/vmClone.js#L50) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:147](../server/src/routes/api/vmClone.js#L147) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:67](../server/src/routes/api/vmClone.js#L67) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:123](../server/src/routes/api/vmClone.js#L123) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:132](../server/src/routes/api/vmClone.js#L132) |
| GET | `/tools/vm-dns` | 권한 `tools` | [server/src/routes/api/vmDns.js:128](../server/src/routes/api/vmDns.js#L128) |
| GET | `/tools/vm-dns.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmDns.js:220](../server/src/routes/api/vmDns.js#L220) |
| GET | `/tools/vm-dns/changes` | 권한 `tools` | [server/src/routes/api/vmDns.js:167](../server/src/routes/api/vmDns.js#L167) |
| GET | `/tools/vm-dns/policy` | 권한 `tools` | [server/src/routes/api/vmDns.js:180](../server/src/routes/api/vmDns.js#L180) |
| PUT | `/tools/vm-dns/policy` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:192](../server/src/routes/api/vmDns.js#L192) |
| POST | `/tools/vm-dns/probe` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:208](../server/src/routes/api/vmDns.js#L208) |
| GET | `/tools/vm-dns/server` | 권한 `tools` | [server/src/routes/api/vmDns.js:147](../server/src/routes/api/vmDns.js#L147) |
| GET | `/tools/vm-dns/vm` | 권한 `tools` | [server/src/routes/api/vmDns.js:157](../server/src/routes/api/vmDns.js#L157) |
| GET | `/tools/vm-export` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:166](../server/src/routes/api/ipamExport.js#L166) |
| GET | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:175](../server/src/routes/api/ipamExport.js#L175) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1273](../server/src/routes/api/toolsCapacity.js#L1273) |
| GET | `/tools/vm-hygiene` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:51](../server/src/routes/api/vmHygiene.js#L51) |
| GET | `/tools/vm-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmHygiene.js:87](../server/src/routes/api/vmHygiene.js#L87) |
| POST | `/tools/vm-hygiene/notify-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:81](../server/src/routes/api/vmHygiene.js#L81) |
| GET | `/tools/vm-hygiene/settings` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:59](../server/src/routes/api/vmHygiene.js#L59) |
| PUT | `/tools/vm-hygiene/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:70](../server/src/routes/api/vmHygiene.js#L70) |
| GET | `/tools/vm-lifecycle` | 권한 `tools` | [server/src/routes/api/vmLifecycle.js:77](../server/src/routes/api/vmLifecycle.js#L77) |
| GET | `/tools/vm-lifecycle.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmLifecycle.js:87](../server/src/routes/api/vmLifecycle.js#L87) |
| GET | `/tools/vm-tags` | 권한 `tools` | [server/src/routes/api/vmTags.js:48](../server/src/routes/api/vmTags.js#L48) |
| GET | `/tools/vm-tags.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmTags.js:92](../server/src/routes/api/vmTags.js#L92) |
| GET | `/tools/vm-tags/of` | 권한 `tools` | [server/src/routes/api/vmTags.js:64](../server/src/routes/api/vmTags.js#L64) |
| GET | `/tools/vm-tags/policy` | 권한 `tools` | [server/src/routes/api/vmTags.js:81](../server/src/routes/api/vmTags.js#L81) |
| PUT | `/tools/vm-tags/policy` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmTags.js:85](../server/src/routes/api/vmTags.js#L85) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:19](../server/src/routes/api/vmtrack.js#L19) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:48](../server/src/routes/api/vmtrack.js#L48) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:125](../server/src/routes/api/vmtrack.js#L125) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:62](../server/src/routes/api/vmtrack.js#L62) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:76](../server/src/routes/api/vmtrack.js#L76) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:142](../server/src/routes/api/vmtrack.js#L142) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:88](../server/src/routes/api/vmtrack.js#L88) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:103](../server/src/routes/api/vmtrack.js#L103) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:163](../server/src/routes/api/vmtrack.js#L163) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:180](../server/src/routes/api/vmtrack.js#L180) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:301](../server/src/routes/api/vmSeries.js#L301) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:265](../server/src/routes/api/vmSeries.js#L265) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:257](../server/src/routes/api/vmSeries.js#L257) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:240](../server/src/routes/api/vmSeries.js#L240) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:158](../server/src/routes/api/vmSeries.js#L158) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:176](../server/src/routes/api/vmSeries.js#L176) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:252](../server/src/routes/api/vmSeries.js#L252) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:279](../server/src/routes/api/vmSeries.js#L279) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:131](../server/src/routes/api/vcTools.js#L131) |
| GET | `/tools/vmware-config` | 권한 `tools` · `csvPermIfDownload` | [server/src/routes/api/checksLogs.js:255](../server/src/routes/api/checksLogs.js#L255) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:293](../server/src/routes/api/toolsCapacity.js#L293) |
| GET | `/tools/waste/export` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsCapacity.js:477](../server/src/routes/api/toolsCapacity.js#L477) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:694](../server/src/routes/api/toolsCapacity.js#L694) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:664](../server/src/routes/api/toolsCapacity.js#L664) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:678](../server/src/routes/api/toolsCapacity.js#L678) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:670](../server/src/routes/api/toolsCapacity.js#L670) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:440](../server/src/routes/api/toolsCapacity.js#L440) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:952](../server/src/routes/api/toolsCapacity.js#L952) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:975](../server/src/routes/api/toolsCapacity.js#L975) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:1037](../server/src/routes/api/toolsCapacity.js#L1037) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1074](../server/src/routes/api/toolsCapacity.js#L1074) |
| GET | `/tools/xfer-speed` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:186](../server/src/routes/api/xferSpeed.js#L186) |
| GET | `/tools/xfer-speed/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:334](../server/src/routes/api/xferSpeed.js#L334) |
| GET | `/tools/xfer-speed/heat` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:212](../server/src/routes/api/xferSpeed.js#L212) |
| GET | `/tools/xfer-speed/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:231](../server/src/routes/api/xferSpeed.js#L231) |
| POST | `/tools/xfer-speed/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:287](../server/src/routes/api/xferSpeed.js#L287) |
| PUT | `/tools/xfer-speed/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:312](../server/src/routes/api/xferSpeed.js#L312) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:538](../server/src/routes/api/inventory.js#L538) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:349](../server/src/routes/api/toolsInfo.js#L349) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:351](../server/src/routes/api/toolsInfo.js#L351) |
| DELETE | `/user-menu` | — | [server/src/routes/api/userMenu.js:90](../server/src/routes/api/userMenu.js#L90) |
| GET | `/user-menu` | — | [server/src/routes/api/userMenu.js:62](../server/src/routes/api/userMenu.js#L62) |
| PUT | `/user-menu` | — | [server/src/routes/api/userMenu.js:82](../server/src/routes/api/userMenu.js#L82) |
| DELETE | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:130](../server/src/routes/api/userMenu.js#L130) |
| GET | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:107](../server/src/routes/api/userMenu.js#L107) |
| POST | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:118](../server/src/routes/api/userMenu.js#L118) |
| POST | `/user-menu/restore-prev` | — | [server/src/routes/api/userMenu.js:98](../server/src/routes/api/userMenu.js#L98) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:14](../server/src/routes/api/vcTools.js#L14) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:790](../server/src/routes/api/toolsCapacity.js#L790) |
| GET | `/veeam/backup-counts` | — | [server/src/routes/api/veeam.js:281](../server/src/routes/api/veeam.js#L281) |
| GET | `/veeam/badges` | — | [server/src/routes/api/veeam.js:247](../server/src/routes/api/veeam.js#L247) |
| GET | `/veeam/snap-events` | — | [server/src/routes/api/veeam.js:266](../server/src/routes/api/veeam.js#L266) |
| GET | `/veeam/vm-detail` | — | [server/src/routes/api/veeam.js:330](../server/src/routes/api/veeam.js#L330) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:392](../server/src/routes/api/inventory.js#L392) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:152](../server/src/routes/api/vmMetrics.js#L152) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:94](../server/src/routes/api/vmMetrics.js#L94) |
| GET | `/vms/:id/partitions` | 권한 `inv.vms` | [server/src/routes/api/toolsGuestPart.js:43](../server/src/routes/api/toolsGuestPart.js#L43) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:464](../server/src/routes/api/inventory.js#L464) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:299](../server/src/routes/api/toolsInfo.js#L299) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:338](../server/src/routes/api/toolsCapacity.js#L338) |

## `/dl`

중앙 업그레이드 소스(`versions.json` + 번들). **공개**다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/:file` | — | [server/src/routes/dlsource.js:93](../server/src/routes/dlsource.js#L93) |
| GET | `/versions.json` | — | [server/src/routes/dlsource.js:89](../server/src/routes/dlsource.js#L89) |

---

## 게이트 헬퍼 용어집

표의 게이트 열에 나오는 이름 중 `역할`·`권한` 으로 환원되지 않는 것들입니다.

| 이름 | 붙은 라우트 | 뜻 |
|---|---:|---|
| `fullScopeOnly` | 252 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 201 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `requireCentral` | 56 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `requireSettingsOwner` | 40 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 그리고 **소유자이면서 전체 범위(vCenter 제한 없음) 계정만** 통과한다 — 범위가 지정된 소유자는 403(v2.744 AUTHZ-02). 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `csvPerm` | 37 | **CSV 가져오기/내보내기 권한**(`requirePerm('data.csv')` — v2.643). 관리자 이상만(super_admin 항상, admin 은 권한 설정에서 super_admin 이 끌 수 있다). operator·viewer 는 403. |
| `fleetWideOnly` | 23 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `requireSuperAdmin` | 13 | **super_admin 전용**(v2.726 좌측 메뉴 배포·철회 · v2.740 아이실론 디렉터리 사용량 수집 대상 설정 — 조회·저장·일괄 변경·연결 시험·메일·SSH 키). 저장 역할이 super_admin 인 계정만(`req.user.superAdmin`). 역할 admin 은 403 `super-admin-only`(`requiredRole: ['super_admin']`). |
| `fleetReadOnly` | 10 | **전체 범위 계정만**(v2.621 SEC-03 — 폴더 사용량 조회. 응답이 RMA 엣지 IP·호스트명·마운트 경로를 싣는다 · v2.622 SEC-03 — GPU 게스트 엣지 배포 설정·엣지 배포 사용자·수집 진단 조회). 범위 제한 계정은 403. |
| `authMiddleware` | 8 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
| `guarded` | 8 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `fullScopeOnlyWith` | 8 | **전체 범위 계정만**(사유 문구를 받는 `fullScopeOnly` — v2.628 SEC2628-01 업그레이드 제어·SEC2628-05 리소스 적정성 진단 등). 범위 제한 계정은 403. |
| `tokenFirst` | 6 | **수집 토큰 확인을 본문 해석보다 먼저** 한다(v2.741 — 토큰 없는 요청이 본문 파서·큰 본문 한도에 닿지 않게). 토큰이 없거나 틀리면 403, 수집 토큰 미설정이면 404. |
| `express.json` | 6 | 본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약). |
| `requireEnrolled` | 4 | OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다. |
| `fleetFullScopeOnly` | 4 | **전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403. |
| `noticeFleetOnly` | 3 | **전체 범위 계정만**(v2.722 — 접속 공지 작성·수정·삭제. 공지는 전 법인 사용자에게 보인다). 범위 제한 계정은 403. |
| `reauth` | 3 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `auditMiddleware` | 3 | 상태변경 감사 로그 기록. |
| `menuFleetOnly` | 3 | **전체 범위 계정만**(v2.726 — 좌측 메뉴 배포. 전 사용자 화면을 바꾼다). 범위 제한 계정은 403. |
| `adFleetOnly` | 3 | **전체 범위 계정만**(v2.628 SEC2628-04 — AD 설정 조회·저장·연결 테스트. AD 는 전 사용자 공통 인증 소스다). 범위 제한 계정은 403. |
| `ownerIfAutoCentralToken` | 2 | 요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급). |
| `requireOwnOtp` | 2 | **본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다. |
| `express.raw` | 2 | 원시 바디 버퍼(업그레이드 번들 등). ⚠ 게이트가 아니다 — 인증을 이 앞에 두어 미인증 요청이 대용량 바디를 적재하지 못하게 한다. |
| `rawIpFleetOnly` | 1 | **전체 범위 계정만**(v2.621 SEC-02 — 요청 본문 IP 로 직접 SSH 접속하는 테스트. 정규형 IPv4·차단 대역 검사가 뒤따른다). 범위 제한 계정은 403. |
| `liveFleetOnly` | 1 | **전체 범위 계정만**(v2.629 A6-02 — iDRAC 에 실시간 로그인하는 GPU 조사). 범위 제한 계정은 403. |
| `settingsFleetOnly` | 1 | **전체 범위 계정만**(v2.633 — 손상 보존본만 남은 중앙 설정 파일을 기본값으로 확정. 그 기본값이 모든 엣지에 배포된다). 범위 제한 계정은 403. |
| `csvPermIfDownload` | 1 | `csvPerm` 과 같되 **download=1(파일 내보내기)일 때만** 요구한다 — 화면 조회(JSON)는 통과(v2.741 AUTHZ-02 — VMware 구성 백업). |
| `csvPermUnlessJson` | 1 | `csvPerm` 과 같되 **format=json(화면의 표·붙여넣기 등록)은 통과**(v2.643 — 성능점검 대상 등록 마법사). |

---

## 생성 정보

- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`
- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이
  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).

