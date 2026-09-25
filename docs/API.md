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
| 엔드포인트 | **844개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 79개 |
| GET | 440개 |
| POST | 268개 |
| PUT | 87개 |
| PATCH | 2개 |
| DELETE | 47개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 9 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 16 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 51 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 8 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 56 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 308 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 9 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 338 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
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
| GET | `/history` | — | [server/src/routes/capacity.js:63](../server/src/routes/capacity.js#L63) |
| GET | `/host` | — | [server/src/routes/capacity.js:51](../server/src/routes/capacity.js#L51) |
| GET | `/summary` | — | [server/src/routes/capacity.js:36](../server/src/routes/capacity.js#L36) |

## `/api/insights`

FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('insights')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/anomalies` | — | [server/src/routes/insights.js:263](../server/src/routes/insights.js#L263) |
| POST | `/chatops` | — | [server/src/routes/insights.js:329](../server/src/routes/insights.js#L329) |
| GET | `/finops` | — | [server/src/routes/insights.js:92](../server/src/routes/insights.js#L92) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:112](../server/src/routes/insights.js#L112) |
| PUT | `/finops/config` | 역할 `admin` | [server/src/routes/insights.js:138](../server/src/routes/insights.js#L138) |
| GET | `/fleet` | — | [server/src/routes/insights.js:141](../server/src/routes/insights.js#L141) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:194](../server/src/routes/insights.js#L194) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:210](../server/src/routes/insights.js#L210) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:244](../server/src/routes/insights.js#L244) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:167](../server/src/routes/insights.js#L167) |
| GET | `/forecast` | — | [server/src/routes/insights.js:283](../server/src/routes/insights.js#L283) |
| GET | `/graph` | — | [server/src/routes/insights.js:308](../server/src/routes/insights.js#L308) |
| GET | `/incidents` | — | [server/src/routes/insights.js:323](../server/src/routes/insights.js#L323) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:115](../server/src/routes/insights.js#L115) |
| GET | `/security` | — | [server/src/routes/insights.js:295](../server/src/routes/insights.js#L295) |
| GET | `/topology` | — | [server/src/routes/insights.js:298](../server/src/routes/insights.js#L298) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central.js:1785](../server/src/routes/central.js#L1785) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:396](../server/src/routes/central.js#L396) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central.js:1857](../server/src/routes/central.js#L1857) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central.js:1861](../server/src/routes/central.js#L1861) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:532](../server/src/routes/central.js#L532) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central.js:1840](../server/src/routes/central.js#L1840) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central.js:1844](../server/src/routes/central.js#L1844) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:916](../server/src/routes/central.js#L916) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:960](../server/src/routes/central.js#L960) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central.js:1656](../server/src/routes/central.js#L1656) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central.js:1674](../server/src/routes/central.js#L1674) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central.js:1256](../server/src/routes/central.js#L1256) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central.js:1263](../server/src/routes/central.js#L1263) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:988](../server/src/routes/central.js#L988) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1180](../server/src/routes/central.js#L1180) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1102](../server/src/routes/central.js#L1102) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:779](../server/src/routes/central.js#L779) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central.js:1934](../server/src/routes/central.js#L1934) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1045](../server/src/routes/central.js#L1045) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1051](../server/src/routes/central.js#L1051) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1061](../server/src/routes/central.js#L1061) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:679](../server/src/routes/central.js#L679) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central.js:1876](../server/src/routes/central.js#L1876) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central.js:1885](../server/src/routes/central.js#L1885) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central.js:1948](../server/src/routes/central.js#L1948) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central.js:1976](../server/src/routes/central.js#L1976) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central.js:1814](../server/src/routes/central.js#L1814) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central.js:1821](../server/src/routes/central.js#L1821) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central.js:1233](../server/src/routes/central.js#L1233) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central.js:1293](../server/src/routes/central.js#L1293) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central.js:1378](../server/src/routes/central.js#L1378) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central.js:1395](../server/src/routes/central.js#L1395) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central.js:1758](../server/src/routes/central.js#L1758) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central.js:1766](../server/src/routes/central.js#L1766) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:407](../server/src/routes/central.js#L407) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:485](../server/src/routes/central.js#L485) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central.js:1585](../server/src/routes/central.js#L1585) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central.js:1526](../server/src/routes/central.js#L1526) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central.js:1605](../server/src/routes/central.js#L1605) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central.js:1430](../server/src/routes/central.js#L1430) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central.js:1616](../server/src/routes/central.js#L1616) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central.js:1452](../server/src/routes/central.js#L1452) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central.js:1507](../server/src/routes/central.js#L1507) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central.js:1209](../server/src/routes/central.js#L1209) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central.js:1301](../server/src/routes/central.js#L1301) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:574](../server/src/routes/central.js#L574) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:588](../server/src/routes/central.js#L588) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:509](../server/src/routes/central.js#L509) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central.js:1748](../server/src/routes/central.js#L1748) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:856](../server/src/routes/central.js#L856) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:978](../server/src/routes/central.js#L978) |

## `/api/upgrade`

자동 업그레이드 제어(번들 수신·적용).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/apply` | 역할 `admin` | [server/src/routes/upgrade.js:151](../server/src/routes/upgrade.js#L151) |
| POST | `/bundle` | 역할 `admin` · `express.raw` | [server/src/routes/upgrade.js:193](../server/src/routes/upgrade.js#L193) |
| POST | `/check` | 역할 `admin` | [server/src/routes/upgrade.js:145](../server/src/routes/upgrade.js#L145) |
| GET | `/detect-install` | 역할 `admin` | [server/src/routes/upgrade.js:170](../server/src/routes/upgrade.js#L170) |
| POST | `/restart` | 역할 `admin` | [server/src/routes/upgrade.js:159](../server/src/routes/upgrade.js#L159) |
| GET | `/settings` | 역할 `admin` | [server/src/routes/upgrade.js:165](../server/src/routes/upgrade.js#L165) |
| PUT | `/settings` | 역할 `admin` | [server/src/routes/upgrade.js:180](../server/src/routes/upgrade.js#L180) |
| GET | `/status` | 역할 `admin` | [server/src/routes/upgrade.js:140](../server/src/routes/upgrade.js#L140) |

## `/api/remote`

원격 접속(HAProxy/SSH/RDP 중계).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:156](../server/src/routes/remote.js#L156) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:158](../server/src/routes/remote.js#L158) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:297](../server/src/routes/remote.js#L297) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:282](../server/src/routes/remote.js#L282) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:49](../server/src/routes/remote.js#L49) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:313](../server/src/routes/remote.js#L313) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:373](../server/src/routes/remote.js#L373) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:362](../server/src/routes/remote.js#L362) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:93](../server/src/routes/remote.js#L93) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:123](../server/src/routes/remote.js#L123) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:210](../server/src/routes/remote.js#L210) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:231](../server/src/routes/remote.js#L231) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:244](../server/src/routes/remote.js#L244) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:167](../server/src/routes/remote.js#L167) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:333](../server/src/routes/remote.js#L333) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:37](../server/src/routes/remote.js#L37) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:389](../server/src/routes/remote.js#L389) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:139](../server/src/routes/remote.js#L139) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:267](../server/src/routes/remote.js#L267) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:30](../server/src/routes/svcmon/edge.js#L30) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:104](../server/src/routes/svcmon/edge.js#L104) |
| PUT | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:62](../server/src/routes/svcmon/edge.js#L62) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:112](../server/src/routes/svcmon/edge.js#L112) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:100](../server/src/routes/svcmon/overview.js#L100) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:134](../server/src/routes/svcmon/edge.js#L134) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:121](../server/src/routes/svcmon/edge.js#L121) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:165](../server/src/routes/svcmon/edge.js#L165) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:149](../server/src/routes/svcmon/edge.js#L149) |
| POST | `/flush` | 역할 `admin` | [server/src/routes/svcmon/overview.js:117](../server/src/routes/svcmon/overview.js#L117) |
| POST | `/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:23](../server/src/routes/svcmon/tree.js#L23) |
| POST | `/folders/delete` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:57](../server/src/routes/svcmon/tree.js#L57) |
| POST | `/folders/move` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:39](../server/src/routes/svcmon/tree.js#L39) |
| PUT | `/folders/rename` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:31](../server/src/routes/svcmon/tree.js#L31) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:29](../server/src/routes/svcmon/logs.js#L29) |
| PUT | `/log` | 역할 `admin` | [server/src/routes/svcmon/logs.js:31](../server/src/routes/svcmon/logs.js#L31) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:77](../server/src/routes/svcmon/logs.js#L77) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:49](../server/src/routes/svcmon/logs.js#L49) |
| POST | `/log/prune` | 역할 `admin` | [server/src/routes/svcmon/logs.js:101](../server/src/routes/svcmon/logs.js#L101) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:61](../server/src/routes/svcmon/logs.js#L61) |
| POST | `/push-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:173](../server/src/routes/svcmon/edge.js#L173) |
| POST | `/refresh` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:111](../server/src/routes/svcmon/overview.js#L111) |
| PUT | `/reorder/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:52](../server/src/routes/svcmon/tree.js#L52) |
| PUT | `/reorder/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:47](../server/src/routes/svcmon/tree.js#L47) |
| POST | `/silence-check` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:180](../server/src/routes/svcmon/edge.js#L180) |
| PUT | `/sort` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:67](../server/src/routes/svcmon/tree.js#L67) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:48](../server/src/routes/svcmon/overview.js#L48) |
| POST | `/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:73](../server/src/routes/svcmon/tree.js#L73) |
| DELETE | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:109](../server/src/routes/svcmon/tree.js#L109) |
| PUT | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:100](../server/src/routes/svcmon/tree.js#L100) |
| POST | `/targets/:id/tests` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:115](../server/src/routes/svcmon/tree.js#L115) |
| DELETE | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:133](../server/src/routes/svcmon/tree.js#L133) |
| PUT | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:124](../server/src/routes/svcmon/tree.js#L124) |
| POST | `/targets/bulk` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:81](../server/src/routes/svcmon/tree.js#L81) |
| GET | `/targets/csv-schema` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:137](../server/src/routes/svcmon/transfer.js#L137) |
| GET | `/targets/export.:format` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:69](../server/src/routes/svcmon/transfer.js#L69) |
| GET | `/targets/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:34](../server/src/routes/svcmon/transfer.js#L34) |
| POST | `/targets/generate` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:90](../server/src/routes/svcmon/generate.js#L90) |
| GET | `/targets/hostmap-template.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:100](../server/src/routes/svcmon/transfer.js#L100) |
| POST | `/targets/hostmap/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:129](../server/src/routes/svcmon/transfer.js#L129) |
| POST | `/targets/hostmap/parse` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:109](../server/src/routes/svcmon/transfer.js#L109) |
| POST | `/targets/import` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/transfer.js:158](../server/src/routes/svcmon/transfer.js#L158) |
| GET | `/targets/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:91](../server/src/routes/svcmon/transfer.js#L91) |
| GET | `/templates` | — | [server/src/routes/svcmon/templates.js:27](../server/src/routes/svcmon/templates.js#L27) |
| POST | `/templates` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:32](../server/src/routes/svcmon/templates.js#L32) |
| DELETE | `/templates/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:65](../server/src/routes/svcmon/templates.js#L65) |
| PUT | `/templates/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:43](../server/src/routes/svcmon/templates.js#L43) |
| POST | `/templates/:id/apply` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:128](../server/src/routes/svcmon/templates.js#L128) |
| POST | `/templates/:id/duplicate` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:55](../server/src/routes/svcmon/templates.js#L55) |
| GET | `/templates/:id/usage` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:122](../server/src/routes/svcmon/templates.js#L122) |
| GET | `/templates/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:78](../server/src/routes/svcmon/templates.js#L78) |
| POST | `/templates/import` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/templates.js:97](../server/src/routes/svcmon/templates.js#L97) |
| GET | `/templates/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:86](../server/src/routes/svcmon/templates.js#L86) |

## `/api/admin`

설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:69](../server/src/routes/admin/deployLlm.js#L69) |
| GET | `/agent-deploy/bulk` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:311](../server/src/routes/admin/deployLlm.js#L311) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:312](../server/src/routes/admin/deployLlm.js#L312) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:317](../server/src/routes/admin/deployLlm.js#L317) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:261](../server/src/routes/admin/deployLlm.js#L261) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:266](../server/src/routes/admin/deployLlm.js#L266) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:283](../server/src/routes/admin/deployLlm.js#L283) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:328](../server/src/routes/admin/deployLlm.js#L328) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:399](../server/src/routes/admin/deployLlm.js#L399) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:346](../server/src/routes/admin/deployLlm.js#L346) |
| GET | `/agent-deploy/defaults` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:55](../server/src/routes/admin/deployLlm.js#L55) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:220](../server/src/routes/admin/deployLlm.js#L220) |
| GET | `/agent-deploy/installer` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:53](../server/src/routes/admin/deployLlm.js#L53) |
| GET | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:89](../server/src/routes/admin/deployLlm.js#L89) |
| POST | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:98](../server/src/routes/admin/deployLlm.js#L98) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:119](../server/src/routes/admin/deployLlm.js#L119) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:201](../server/src/routes/admin/deployLlm.js#L201) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:211](../server/src/routes/admin/deployLlm.js#L211) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:130](../server/src/routes/admin/deployLlm.js#L130) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:489](../server/src/routes/admin/deployLlm.js#L489) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:168](../server/src/routes/admin/deployLlm.js#L168) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:144](../server/src/routes/admin/deployLlm.js#L144) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:502](../server/src/routes/admin/deployLlm.js#L502) |
| POST | `/agent-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:65](../server/src/routes/admin/deployLlm.js#L65) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:64](../server/src/routes/admin/opsSettings.js#L64) |
| PUT | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:65](../server/src/routes/admin/opsSettings.js#L65) |
| POST | `/alerts/test` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:77](../server/src/routes/admin/opsSettings.js#L77) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:108](../server/src/routes/admin/opsSettings.js#L108) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:109](../server/src/routes/admin/opsSettings.js#L109) |
| GET | `/api-keys` | 역할 `admin` | [server/src/routes/admin/apiKeys.js:33](../server/src/routes/admin/apiKeys.js#L33) |
| POST | `/api-keys` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:66](../server/src/routes/admin/apiKeys.js#L66) |
| DELETE | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:102](../server/src/routes/admin/apiKeys.js#L102) |
| PATCH | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:83](../server/src/routes/admin/apiKeys.js#L83) |
| POST | `/api-keys/:id/revoke` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:94](../server/src/routes/admin/apiKeys.js#L94) |
| GET | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:179](../server/src/routes/admin/horizonAssign.js#L179) |
| POST | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:187](../server/src/routes/admin/horizonAssign.js#L187) |
| DELETE | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:197](../server/src/routes/admin/horizonAssign.js#L197) |
| PUT | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:192](../server/src/routes/admin/horizonAssign.js#L192) |
| POST | `/assignments/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:204](../server/src/routes/admin/horizonAssign.js#L204) |
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:56](../server/src/routes/admin/opsSettings.js#L56) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:85](../server/src/routes/admin/backupNetSec.js#L85) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:68](../server/src/routes/admin/backupNetSec.js#L68) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:64](../server/src/routes/admin/backupNetSec.js#L64) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:86](../server/src/routes/admin/backupNetSec.js#L86) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:63](../server/src/routes/admin/backupNetSec.js#L63) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:60](../server/src/routes/admin/backupNetSec.js#L60) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:76](../server/src/routes/admin/backupNetSec.js#L76) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:76](../server/src/routes/admin/centralIpam.js#L76) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:105](../server/src/routes/admin/centralIpam.js#L105) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:100](../server/src/routes/admin/centralIpam.js#L100) |
| GET | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:118](../server/src/routes/admin/centralIpam.js#L118) |
| POST | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:121](../server/src/routes/admin/centralIpam.js#L121) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:127](../server/src/routes/admin/centralIpam.js#L127) |
| GET | `/central/ingest-stats` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:96](../server/src/routes/admin/centralIpam.js#L96) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:97](../server/src/routes/admin/centralIpam.js#L97) |
| GET | `/central/inventory` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:78](../server/src/routes/admin/centralIpam.js#L78) |
| POST | `/central/inventory/owner` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:83](../server/src/routes/admin/centralIpam.js#L83) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:93](../server/src/routes/admin/opsSettings.js#L93) |
| GET | `/codex-check` | 역할 `admin` | [server/src/routes/admin/statusTools.js:26](../server/src/routes/admin/statusTools.js#L26) |
| GET | `/codex-check/file` | 역할 `admin` | [server/src/routes/admin/statusTools.js:29](../server/src/routes/admin/statusTools.js#L29) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:32](../server/src/routes/admin/statusTools.js#L32) |
| GET | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:82](../server/src/routes/admin/collectorsDc.js#L82) |
| POST | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:86](../server/src/routes/admin/collectorsDc.js#L86) |
| DELETE | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:107](../server/src/routes/admin/collectorsDc.js#L107) |
| PUT | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:93](../server/src/routes/admin/collectorsDc.js#L93) |
| POST | `/collectors/:id/force-token` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:441](../server/src/routes/admin/collectorsDc.js#L441) |
| GET | `/collectors/export.csv` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:126](../server/src/routes/admin/collectorsDc.js#L126) |
| POST | `/collectors/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:155](../server/src/routes/admin/collectorsDc.js#L155) |
| POST | `/collectors/pull` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:352](../server/src/routes/admin/collectorsDc.js#L352) |
| GET | `/collectors/sample.csv` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:141](../server/src/routes/admin/collectorsDc.js#L141) |
| POST | `/collectors/set-password` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:207](../server/src/routes/admin/collectorsDc.js#L207) |
| POST | `/collectors/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:373](../server/src/routes/admin/collectorsDc.js#L373) |
| POST | `/collectors/upgrade` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:359](../server/src/routes/admin/collectorsDc.js#L359) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:34](../server/src/routes/admin/vcenters.js#L34) |
| PUT | `/data-source` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:39](../server/src/routes/admin/vcenters.js#L39) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:278](../server/src/routes/admin/collectorsDc.js#L278) |
| PUT | `/datacenter-order` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:281](../server/src/routes/admin/collectorsDc.js#L281) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:248](../server/src/routes/admin/collectorsDc.js#L248) |
| POST | `/datacenters` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:254](../server/src/routes/admin/collectorsDc.js#L254) |
| DELETE | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:272](../server/src/routes/admin/collectorsDc.js#L272) |
| PUT | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:267](../server/src/routes/admin/collectorsDc.js#L267) |
| PUT | `/datacenters/assign` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:260](../server/src/routes/admin/collectorsDc.js#L260) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:204](../server/src/routes/admin/backupNetSec.js#L204) |
| GET | `/dir-usage` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:24](../server/src/routes/admin/dirUsage.js#L24) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:37](../server/src/routes/admin/dirUsage.js#L37) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:59](../server/src/routes/admin/dirUsage.js#L59) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:76](../server/src/routes/admin/dirUsage.js#L76) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:51](../server/src/routes/admin/dirUsage.js#L51) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:67](../server/src/routes/admin/dirUsage.js#L67) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:200](../server/src/routes/admin/gpuGuest.js#L200) |
| GET | `/edge-users/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:186](../server/src/routes/admin/gpuGuest.js#L186) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:195](../server/src/routes/admin/gpuGuest.js#L195) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:206](../server/src/routes/admin/gpuGuest.js#L206) |
| GET | `/edge-users/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:175](../server/src/routes/admin/gpuGuest.js#L175) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:43](../server/src/routes/admin/statusTools.js#L43) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:48](../server/src/routes/admin/statusTools.js#L48) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:60](../server/src/routes/admin/nsxImport.js#L60) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:160](../server/src/routes/admin/gpuGuest.js#L160) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:164](../server/src/routes/admin/gpuGuest.js#L164) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:150](../server/src/routes/admin/gpuGuest.js#L150) |
| GET | `/gpu-guest/diag` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:109](../server/src/routes/admin/gpuGuest.js#L109) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:74](../server/src/routes/admin/gpuGuest.js#L74) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:78](../server/src/routes/admin/gpuGuest.js#L78) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:305](../server/src/routes/admin/gpuGuest.js#L305) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:404](../server/src/routes/admin/gpuGuest.js#L404) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:115](../server/src/routes/admin/gpuGuest.js#L115) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:212](../server/src/routes/admin/gpuGuest.js#L212) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:215](../server/src/routes/admin/gpuGuest.js#L215) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:225](../server/src/routes/admin/gpuGuest.js#L225) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:220](../server/src/routes/admin/gpuGuest.js#L220) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:234](../server/src/routes/admin/gpuGuest.js#L234) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:258](../server/src/routes/admin/gpuGuest.js#L258) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:229](../server/src/routes/admin/gpuGuest.js#L229) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:286](../server/src/routes/admin/gpuGuest.js#L286) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:47](../server/src/routes/admin/gpuGuest.js#L47) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:192](../server/src/routes/admin/backupNetSec.js#L192) |
| GET | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:17](../server/src/routes/admin/horizonAssign.js#L17) |
| POST | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:18](../server/src/routes/admin/horizonAssign.js#L18) |
| DELETE | `/horizon/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:23](../server/src/routes/admin/horizonAssign.js#L23) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:58](../server/src/routes/admin/horizonAssign.js#L58) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:66](../server/src/routes/admin/horizonAssign.js#L66) |
| POST | `/horizon/servers/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:131](../server/src/routes/admin/horizonAssign.js#L131) |
| POST | `/horizon/servers/import/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:90](../server/src/routes/admin/horizonAssign.js#L90) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:121](../server/src/routes/admin/horizonAssign.js#L121) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:74](../server/src/routes/admin/horizonAssign.js#L74) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:80](../server/src/routes/admin/horizonAssign.js#L80) |
| POST | `/horizon/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:28](../server/src/routes/admin/horizonAssign.js#L28) |
| GET | `/host-access` | 역할 `admin` | [server/src/routes/admin/hostAccess.js:24](../server/src/routes/admin/hostAccess.js#L24) |
| POST | `/host-access/apply` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:36](../server/src/routes/admin/hostAccess.js#L36) |
| POST | `/host-access/confirm` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:41](../server/src/routes/admin/hostAccess.js#L41) |
| PUT | `/host-access/draft` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:27](../server/src/routes/admin/hostAccess.js#L27) |
| POST | `/host-access/plan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:33](../server/src/routes/admin/hostAccess.js#L33) |
| POST | `/host-access/revert` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:46](../server/src/routes/admin/hostAccess.js#L46) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:84](../server/src/routes/admin/idracCore.js#L84) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:98](../server/src/routes/admin/idracCore.js#L98) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:509](../server/src/routes/admin/idracScan.js#L509) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:503](../server/src/routes/admin/idracScan.js#L503) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` | [server/src/routes/admin/idracScan.js:182](../server/src/routes/admin/idracScan.js#L182) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:47](../server/src/routes/admin/idracScan.js#L47) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:98](../server/src/routes/admin/idracScan.js#L98) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:140](../server/src/routes/admin/idracScan.js#L140) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:66](../server/src/routes/admin/idracScan.js#L66) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:491](../server/src/routes/admin/idracScan.js#L491) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:214](../server/src/routes/admin/idracScan.js#L214) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:478](../server/src/routes/admin/idracScan.js#L478) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:207](../server/src/routes/admin/idracScan.js#L207) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:396](../server/src/routes/admin/idracCore.js#L396) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:431](../server/src/routes/admin/idracCore.js#L431) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:332](../server/src/routes/admin/idracCore.js#L332) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:148](../server/src/routes/admin/idracCore.js#L148) |
| POST | `/idrac/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:196](../server/src/routes/admin/idracScan.js#L196) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:255](../server/src/routes/admin/idracCore.js#L255) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:183](../server/src/routes/admin/idracCore.js#L183) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:490](../server/src/routes/admin/idracCore.js#L490) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:507](../server/src/routes/admin/idracCore.js#L507) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:116](../server/src/routes/admin/idracCore.js#L116) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:134](../server/src/routes/admin/idracCore.js#L134) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:122](../server/src/routes/admin/idracCore.js#L122) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:123](../server/src/routes/admin/idracCore.js#L123) |
| POST | `/idrac/register-scanned` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:285](../server/src/routes/admin/idracScan.js#L285) |
| POST | `/idrac/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:223](../server/src/routes/admin/idracScan.js#L223) |
| GET | `/idrac/scan-agents` | 역할 `admin` | [server/src/routes/admin/idracScan.js:271](../server/src/routes/admin/idracScan.js#L271) |
| GET | `/idrac/scan-job-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:452](../server/src/routes/admin/idracScan.js#L452) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:470](../server/src/routes/admin/idracScan.js#L470) |
| GET | `/idrac/scan-jobs` | 역할 `admin` | [server/src/routes/admin/idracScan.js:442](../server/src/routes/admin/idracScan.js#L442) |
| GET | `/idrac/scan-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:416](../server/src/routes/admin/idracScan.js#L416) |
| GET | `/idrac/scan-ranges` | 역할 `admin` | [server/src/routes/admin/idracScan.js:302](../server/src/routes/admin/idracScan.js#L302) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:308](../server/src/routes/admin/idracScan.js#L308) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:316](../server/src/routes/admin/idracScan.js#L316) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:327](../server/src/routes/admin/idracScan.js#L327) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:348](../server/src/routes/admin/idracScan.js#L348) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:430](../server/src/routes/admin/idracScan.js#L430) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:342](../server/src/routes/admin/idracScan.js#L342) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:404](../server/src/routes/admin/idracScan.js#L404) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` | [server/src/routes/admin/idracScan.js:413](../server/src/routes/admin/idracScan.js#L413) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:423](../server/src/routes/admin/idracScan.js#L423) |
| GET | `/idrac/scan-result` | 역할 `admin` | [server/src/routes/admin/idracScan.js:262](../server/src/routes/admin/idracScan.js#L262) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:373](../server/src/routes/admin/idracCore.js#L373) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:108](../server/src/routes/admin/idracCore.js#L108) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:366](../server/src/routes/admin/idracCore.js#L366) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:36](../server/src/routes/admin/centralIpam.js#L36) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:167](../server/src/routes/admin/centralIpam.js#L167) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:159](../server/src/routes/admin/centralIpam.js#L159) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:135](../server/src/routes/admin/centralIpam.js#L135) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:153](../server/src/routes/admin/centralIpam.js#L153) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:164](../server/src/routes/admin/centralIpam.js#L164) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:52](../server/src/routes/admin/centralIpam.js#L52) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:55](../server/src/routes/admin/centralIpam.js#L55) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:172](../server/src/routes/admin/centralIpam.js#L172) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:179](../server/src/routes/admin/centralIpam.js#L179) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:199](../server/src/routes/admin/centralIpam.js#L199) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:193](../server/src/routes/admin/centralIpam.js#L193) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:184](../server/src/routes/admin/centralIpam.js#L184) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:510](../server/src/routes/admin/deployLlm.js#L510) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:511](../server/src/routes/admin/deployLlm.js#L511) |
| POST | `/llm-test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:515](../server/src/routes/admin/deployLlm.js#L515) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:73](../server/src/routes/admin/statusTools.js#L73) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:19](../server/src/routes/admin/mail.js#L19) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:23](../server/src/routes/admin/mail.js#L23) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:45](../server/src/routes/admin/mail.js#L45) |
| GET | `/memtrack` | 역할 `admin` | [server/src/routes/admin/statusTools.js:180](../server/src/routes/admin/statusTools.js#L180) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:32](../server/src/routes/admin/gpuGuest.js#L32) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:35](../server/src/routes/admin/gpuGuest.js#L35) |
| GET | `/net/agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:124](../server/src/routes/admin/backupNetSec.js#L124) |
| GET | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:156](../server/src/routes/admin/backupNetSec.js#L156) |
| POST | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:131](../server/src/routes/admin/backupNetSec.js#L131) |
| GET | `/net/history` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:173](../server/src/routes/admin/backupNetSec.js#L173) |
| DELETE | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:175](../server/src/routes/admin/backupNetSec.js#L175) |
| GET | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:174](../server/src/routes/admin/backupNetSec.js#L174) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:183](../server/src/routes/admin/backupNetSec.js#L183) |
| GET | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:178](../server/src/routes/admin/backupNetSec.js#L178) |
| PUT | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:179](../server/src/routes/admin/backupNetSec.js#L179) |
| DELETE | `/net/monitors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:180](../server/src/routes/admin/backupNetSec.js#L180) |
| POST | `/net/monitors/:id/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:181](../server/src/routes/admin/backupNetSec.js#L181) |
| POST | `/net/pcap` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:162](../server/src/routes/admin/backupNetSec.js#L162) |
| GET | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:18](../server/src/routes/admin/nfsMounts.js#L18) |
| POST | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:22](../server/src/routes/admin/nfsMounts.js#L22) |
| DELETE | `/nfs-mounts/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:30](../server/src/routes/admin/nfsMounts.js#L30) |
| POST | `/nfs-mounts/:id/mount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:38](../server/src/routes/admin/nfsMounts.js#L38) |
| POST | `/nfs-mounts/:id/umount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:46](../server/src/routes/admin/nfsMounts.js#L46) |
| GET | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:30](../server/src/routes/admin/nsxImport.js#L30) |
| POST | `/nsx/managers` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:40](../server/src/routes/admin/nsxImport.js#L40) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:50](../server/src/routes/admin/nsxImport.js#L50) |
| PUT | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:45](../server/src/routes/admin/nsxImport.js#L45) |
| POST | `/nsx/managers/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:55](../server/src/routes/admin/nsxImport.js#L55) |
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:529](../server/src/routes/admin/deployLlm.js#L529) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:526](../server/src/routes/admin/deployLlm.js#L526) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:205](../server/src/routes/admin/opsSettings.js#L205) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:235](../server/src/routes/admin/opsSettings.js#L235) |
| GET | `/os-scan/results.csv` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:239](../server/src/routes/admin/opsSettings.js#L239) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:217](../server/src/routes/admin/opsSettings.js#L217) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:208](../server/src/routes/admin/opsSettings.js#L208) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:36](../server/src/routes/admin/deployLlm.js#L36) |
| POST | `/packages/download` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:47](../server/src/routes/admin/deployLlm.js#L47) |
| PUT | `/packages/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:44](../server/src/routes/admin/deployLlm.js#L44) |
| GET | `/perf` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:22](../server/src/routes/admin/perfMonitor.js#L22) |
| DELETE | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:60](../server/src/routes/admin/perfMonitor.js#L60) |
| GET | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:54](../server/src/routes/admin/perfMonitor.js#L54) |
| POST | `/perf/measure` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:47](../server/src/routes/admin/perfMonitor.js#L47) |
| PUT | `/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:31](../server/src/routes/admin/perfMonitor.js#L31) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:107](../server/src/routes/admin/users.js#L107) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:160](../server/src/routes/admin/users.js#L160) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:168](../server/src/routes/admin/users.js#L168) |
| GET | `/portal-db` | 역할 `admin` | [server/src/routes/admin/statusTools.js:96](../server/src/routes/admin/statusTools.js#L96) |
| GET | `/portal-db/health` | 역할 `admin` | [server/src/routes/admin/statusTools.js:106](../server/src/routes/admin/statusTools.js#L106) |
| GET | `/portal-db/location` | 역할 `admin` | [server/src/routes/admin/statusTools.js:125](../server/src/routes/admin/statusTools.js#L125) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:141](../server/src/routes/admin/statusTools.js#L141) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:151](../server/src/routes/admin/statusTools.js#L151) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:255](../server/src/routes/admin/opsSettings.js#L255) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:272](../server/src/routes/admin/opsSettings.js#L272) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:264](../server/src/routes/admin/opsSettings.js#L264) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:536](../server/src/routes/admin/deployLlm.js#L536) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:540](../server/src/routes/admin/deployLlm.js#L540) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:80](../server/src/routes/admin/opsSettings.js#L80) |
| PUT | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:81](../server/src/routes/admin/opsSettings.js#L81) |
| POST | `/report/daily/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:86](../server/src/routes/admin/opsSettings.js#L86) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:71](../server/src/routes/admin/idracCore.js#L71) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:43](../server/src/routes/admin/idracCore.js#L43) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:59](../server/src/routes/admin/idracCore.js#L59) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:131](../server/src/routes/admin/opsSettings.js#L131) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:134](../server/src/routes/admin/opsSettings.js#L134) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:240](../server/src/routes/admin/backupNetSec.js#L240) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:246](../server/src/routes/admin/backupNetSec.js#L246) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:262](../server/src/routes/admin/backupNetSec.js#L262) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:263](../server/src/routes/admin/backupNetSec.js#L263) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:224](../server/src/routes/admin/backupNetSec.js#L224) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:233](../server/src/routes/admin/backupNetSec.js#L233) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:232](../server/src/routes/admin/backupNetSec.js#L232) |
| GET | `/security/login-fails/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:231](../server/src/routes/admin/backupNetSec.js#L231) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:236](../server/src/routes/admin/backupNetSec.js#L236) |
| GET | `/security/self-check` | 역할 `admin` | [server/src/routes/admin/securityCheck.js:18](../server/src/routes/admin/securityCheck.js#L18) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:158](../server/src/routes/admin/opsSettings.js#L158) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:159](../server/src/routes/admin/opsSettings.js#L159) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:188](../server/src/routes/admin/statusTools.js#L188) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:17](../server/src/routes/admin/toolCategories.js#L17) |
| PUT | `/tool-categories` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:21](../server/src/routes/admin/toolCategories.js#L21) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:37](../server/src/routes/admin/toolCategories.js#L37) |
| PUT | `/user-tools/:username` | 역할 `admin` | [server/src/routes/admin/users.js:138](../server/src/routes/admin/users.js#L138) |
| GET | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:65](../server/src/routes/admin/users.js#L65) |
| POST | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:75](../server/src/routes/admin/users.js#L75) |
| DELETE | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:97](../server/src/routes/admin/users.js#L97) |
| PATCH | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:86](../server/src/routes/admin/users.js#L86) |
| DELETE | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:188](../server/src/routes/admin/users.js#L188) |
| POST | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:180](../server/src/routes/admin/users.js#L180) |
| POST | `/users/:username/totp/begin` | 역할 `admin` | [server/src/routes/admin/users.js:201](../server/src/routes/admin/users.js#L201) |
| POST | `/users/:username/totp/confirm` | 역할 `admin` | [server/src/routes/admin/users.js:207](../server/src/routes/admin/users.js#L207) |
| POST | `/users/:username/totp/disable` | 역할 `admin` | [server/src/routes/admin/users.js:213](../server/src/routes/admin/users.js#L213) |
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:122](../server/src/routes/admin/vcenters.js#L122) |
| PUT | `/vcenter-order` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:131](../server/src/routes/admin/vcenters.js#L131) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:79](../server/src/routes/admin/statusTools.js#L79) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:47](../server/src/routes/admin/vcenters.js#L47) |
| POST | `/vcenters` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:65](../server/src/routes/admin/vcenters.js#L65) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:80](../server/src/routes/admin/vcenters.js#L80) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:72](../server/src/routes/admin/vcenters.js#L72) |
| POST | `/vcenters/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:67](../server/src/routes/admin/nsxImport.js#L67) |
| POST | `/vcenters/import-file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:84](../server/src/routes/admin/nsxImport.js#L84) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:76](../server/src/routes/admin/nsxImport.js#L76) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:88](../server/src/routes/admin/vcenters.js#L88) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:102](../server/src/routes/admin/vcenters.js#L102) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:117](../server/src/routes/admin/backupNetSec.js#L117) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:100](../server/src/routes/admin/backupNetSec.js#L100) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:97](../server/src/routes/admin/backupNetSec.js#L97) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:288](../server/src/routes/admin/collectorsDc.js#L288) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:311](../server/src/routes/admin/collectorsDc.js#L311) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:233](../server/src/routes/auth.js#L233) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `requireSettingsOwner` | [server/src/routes/auth.js:241](../server/src/routes/auth.js#L241) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:246](../server/src/routes/auth.js#L246) |
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
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:237](../server/src/routes/ping.js#L237) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:251](../server/src/routes/ping.js#L251) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:253](../server/src/routes/ping.js#L253) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:259](../server/src/routes/ping.js#L259) |

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
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:267](../server/src/routes/publicApi.js#L267) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:282](../server/src/routes/publicApi.js#L282) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:324](../server/src/routes/publicApi.js#L324) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:371](../server/src/routes/publicApi.js#L371) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:386](../server/src/routes/publicApi.js#L386) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:238](../server/src/routes/publicApi.js#L238) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:187](../server/src/routes/publicApi.js#L187) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:223](../server/src/routes/publicApi.js#L223) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:180](../server/src/routes/publicApi.js#L180) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:428](../server/src/routes/api/inventory.js#L428) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:431](../server/src/routes/api/inventory.js#L431) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:439](../server/src/routes/api/inventory.js#L439) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:414](../server/src/routes/api/inventory.js#L414) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:345](../server/src/routes/api/inventory.js#L345) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:353](../server/src/routes/api/inventory.js#L353) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:165](../server/src/routes/api/overviewNsx.js#L165) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:205](../server/src/routes/api/inventory.js#L205) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:133](../server/src/routes/api/vmMetrics.js#L133) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:189](../server/src/routes/api/vmMetrics.js#L189) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:364](../server/src/routes/api/inventory.js#L364) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:256](../server/src/routes/api/overviewNsx.js#L256) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:290](../server/src/routes/api/overviewNsx.js#L290) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:209](../server/src/routes/api/overviewNsx.js#L209) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:105](../server/src/routes/api/perfClient.js#L105) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:67](../server/src/routes/api/perfClient.js#L67) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:97](../server/src/routes/api/perfClient.js#L97) |
| GET | `/provision/jobs` | — | [server/src/routes/api/provision.js:58](../server/src/routes/api/provision.js#L58) |
| GET | `/provision/jobs/:id` | — | [server/src/routes/api/provision.js:59](../server/src/routes/api/provision.js#L59) |
| GET | `/provision/placement` | 권한 `vm.provision` | [server/src/routes/api/provision.js:28](../server/src/routes/api/provision.js#L28) |
| POST | `/provision/preview` | 권한 `vm.provision` | [server/src/routes/api/provision.js:40](../server/src/routes/api/provision.js#L40) |
| GET | `/provision/saved` | 권한 `vm.provision` | [server/src/routes/api/provision.js:45](../server/src/routes/api/provision.js#L45) |
| GET | `/provision/saved/:id` | 권한 `vm.provision` | [server/src/routes/api/provision.js:48](../server/src/routes/api/provision.js#L48) |
| GET | `/provision/sources` | 권한 `vm.provision` | [server/src/routes/api/provision.js:21](../server/src/routes/api/provision.js#L21) |
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:33](../server/src/routes/api/searchNotes.js#L33) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:15](../server/src/routes/api/searchNotes.js#L15) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:52](../server/src/routes/api/inventory.js#L52) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:458](../server/src/routes/api/inventory.js#L458) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:454](../server/src/routes/api/inventory.js#L454) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:18](../server/src/routes/api/bmstor.js#L18) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:108](../server/src/routes/api/bmstor.js#L108) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:52](../server/src/routes/api/bmstor.js#L52) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:72](../server/src/routes/api/bmstor.js#L72) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:66](../server/src/routes/api/bmstor.js#L66) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:30](../server/src/routes/api/bmstor.js#L30) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:36](../server/src/routes/api/bmstor.js#L36) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:43](../server/src/routes/api/bmstor.js#L43) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:145](../server/src/routes/api/bmUsage.js#L145) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:301](../server/src/routes/api/bmUsage.js#L301) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:274](../server/src/routes/api/bmUsage.js#L274) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:359](../server/src/routes/api/bmUsage.js#L359) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:439](../server/src/routes/api/bmUsage.js#L439) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:229](../server/src/routes/api/bmUsage.js#L229) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:474](../server/src/routes/api/bmUsage.js#L474) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:42](../server/src/routes/api/toolsCapacity.js#L42) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1546](../server/src/routes/api/toolsCapacity.js#L1546) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1451](../server/src/routes/api/toolsCapacity.js#L1451) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:92](../server/src/routes/api/commMap.js#L92) |
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
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:113](../server/src/routes/api/cvp.js#L113) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:184](../server/src/routes/api/cvp.js#L184) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:146](../server/src/routes/api/cvp.js#L146) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:134](../server/src/routes/api/cvp.js#L134) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:169](../server/src/routes/api/cvp.js#L169) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:202](../server/src/routes/api/cvp.js#L202) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:228](../server/src/routes/api/cvp.js#L228) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:231](../server/src/routes/api/cvp.js#L231) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:229](../server/src/routes/api/cvp.js#L229) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:240](../server/src/routes/api/cvp.js#L240) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:267](../server/src/routes/api/cvp.js#L267) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:270](../server/src/routes/api/cvp.js#L270) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:62](../server/src/routes/api/dataFlow.js#L62) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:40](../server/src/routes/api/checksLogs.js#L40) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:29](../server/src/routes/api/deviceFlow.js#L29) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:23](../server/src/routes/api/vcTools.js#L23) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:301](../server/src/routes/api/hardwareGpu.js#L301) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1180](../server/src/routes/api/toolsCapacity.js#L1180) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1280](../server/src/routes/api/toolsCapacity.js#L1280) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1342](../server/src/routes/api/toolsCapacity.js#L1342) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:320](../server/src/routes/api/hardwareGpu.js#L320) |
| GET | `/tools/gpu.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:334](../server/src/routes/api/hardwareGpu.js#L334) |
| GET | `/tools/gpu.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:326](../server/src/routes/api/hardwareGpu.js#L326) |
| GET | `/tools/gpu/export.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:357](../server/src/routes/api/hardwareGpu.js#L357) |
| GET | `/tools/gpu/export.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:358](../server/src/routes/api/hardwareGpu.js#L358) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:158](../server/src/routes/api/toolsAnalytics.js#L158) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:350](../server/src/routes/api/hardwareGpu.js#L350) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:398](../server/src/routes/api/hardwareGpu.js#L398) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:355](../server/src/routes/api/toolsCapacity.js#L355) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:21](../server/src/routes/api/toolsGuestDisk.js#L21) |
| GET | `/tools/guest-disk/export.csv` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:44](../server/src/routes/api/toolsGuestDisk.js#L44) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:75](../server/src/routes/api/toolsGuestDisk.js#L75) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:64](../server/src/routes/api/toolsGuestDisk.js#L64) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:58](../server/src/routes/api/toolsGuestDisk.js#L58) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:33](../server/src/routes/api/toolsGuestDisk.js#L33) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:41](../server/src/routes/api/toolsInfo.js#L41) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:59](../server/src/routes/api/toolsInfo.js#L59) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:269](../server/src/routes/api/hardwareGpu.js#L269) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:83](../server/src/routes/api/toolsInfo.js#L83) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:88](../server/src/routes/api/horizonSessions.js#L88) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:136](../server/src/routes/api/horizonSessions.js#L136) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:149](../server/src/routes/api/horizonSessions.js#L149) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:120](../server/src/routes/api/horizonSessions.js#L120) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:159](../server/src/routes/api/horizonSessions.js#L159) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:179](../server/src/routes/api/horizonSessions.js#L179) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:28](../server/src/routes/api/toolsAnalytics.js#L28) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:388](../server/src/routes/api/hardwareGpu.js#L388) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:363](../server/src/routes/api/hardwareGpu.js#L363) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:92](../server/src/routes/api/ipamExport.js#L92) |
| GET | `/tools/ipam.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:446](../server/src/routes/api/ipamExport.js#L446) |
| GET | `/tools/ipam.xlsx` | 권한 `tools` | [server/src/routes/api/ipamExport.js:425](../server/src/routes/api/ipamExport.js#L425) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:212](../server/src/routes/api/ipamExport.js#L212) |
| PUT | `/tools/ipam/annotation` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:223](../server/src/routes/api/ipamExport.js#L223) |
| POST | `/tools/ipam/bulk` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:304](../server/src/routes/api/ipamExport.js#L304) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:143](../server/src/routes/api/ipamExport.js#L143) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:126](../server/src/routes/api/ipamExport.js#L126) |
| DELETE | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:290](../server/src/routes/api/ipamExport.js#L290) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:251](../server/src/routes/api/ipamExport.js#L251) |
| PUT | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:263](../server/src/routes/api/ipamExport.js#L263) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:239](../server/src/routes/api/ipamExport.js#L239) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:178](../server/src/routes/api/ipamExport.js#L178) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:326](../server/src/routes/api/ipamExport.js#L326) |
| POST | `/tools/ipam/policies` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:357](../server/src/routes/api/ipamExport.js#L357) |
| DELETE | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:401](../server/src/routes/api/ipamExport.js#L401) |
| PUT | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:374](../server/src/routes/api/ipamExport.js#L374) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:335](../server/src/routes/api/ipamExport.js#L335) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:352](../server/src/routes/api/ipamExport.js#L352) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:187](../server/src/routes/api/ipamExport.js#L187) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:136](../server/src/routes/api/ipamExport.js#L136) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:132](../server/src/routes/api/ipamExport.js#L132) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:151](../server/src/routes/api/ipamExport.js#L151) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:166](../server/src/routes/api/ipamExport.js#L166) |
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:133](../server/src/routes/api/toolsInfo.js#L133) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:107](../server/src/routes/api/toolsInfo.js#L107) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:53](../server/src/routes/api/linkCheck.js#L53) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:180](../server/src/routes/api/linkCheck.js#L180) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:165](../server/src/routes/api/linkCheck.js#L165) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:152](../server/src/routes/api/linkCheck.js#L152) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:190](../server/src/routes/api/linkCheck.js#L190) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:141](../server/src/routes/api/linkCheck.js#L141) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:206](../server/src/routes/api/linkCheck.js#L206) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:271](../server/src/routes/api/linkCheck.js#L271) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:219](../server/src/routes/api/linkCheck.js#L219) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:74](../server/src/routes/api/checksLogs.js#L74) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1619](../server/src/routes/api/toolsCapacity.js#L1619) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1583](../server/src/routes/api/toolsCapacity.js#L1583) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:191](../server/src/routes/api/partFaults.js#L191) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:287](../server/src/routes/api/partFaults.js#L287) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:223](../server/src/routes/api/partFaults.js#L223) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:302](../server/src/routes/api/partFaults.js#L302) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:256](../server/src/routes/api/partFaults.js#L256) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:274](../server/src/routes/api/partFaults.js#L274) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:264](../server/src/routes/api/partFaults.js#L264) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:52](../server/src/routes/api/pdu.js#L52) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:126](../server/src/routes/api/pdu.js#L126) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:272](../server/src/routes/api/pdu.js#L272) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:160](../server/src/routes/api/pdu.js#L160) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:192](../server/src/routes/api/pdu.js#L192) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:186](../server/src/routes/api/pdu.js#L186) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:118](../server/src/routes/api/pdu.js#L118) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:239](../server/src/routes/api/pdu.js#L239) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:245](../server/src/routes/api/pdu.js#L245) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:255](../server/src/routes/api/pdu.js#L255) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:233](../server/src/routes/api/pdu.js#L233) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:147](../server/src/routes/api/pdu.js#L147) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:136](../server/src/routes/api/pdu.js#L136) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:216](../server/src/routes/api/pdu.js#L216) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:109](../server/src/routes/api/pdu.js#L109) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:304](../server/src/routes/api/portalCheck.js#L304) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:187](../server/src/routes/api/portalCheck.js#L187) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:252](../server/src/routes/api/portalCheck.js#L252) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:220](../server/src/routes/api/portalCheck.js#L220) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:19](../server/src/routes/api/relaycheck.js#L19) |
| POST | `/tools/relaycheck/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:44](../server/src/routes/api/relaycheck.js#L44) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:37](../server/src/routes/api/relaycheck.js#L37) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:36](../server/src/routes/api/relaytopo.js#L36) |
| PUT | `/tools/relaytopo` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:71](../server/src/routes/api/relaytopo.js#L71) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:128](../server/src/routes/api/relaytopo.js#L128) |
| GET | `/tools/relaytopo/export` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:99](../server/src/routes/api/relaytopo.js#L99) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:119](../server/src/routes/api/relaytopo.js#L119) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:123](../server/src/routes/api/relaytopo.js#L123) |
| POST | `/tools/relaytopo/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:81](../server/src/routes/api/relaytopo.js#L81) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:112](../server/src/routes/api/relaytopo.js#L112) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:137](../server/src/routes/api/relaytopo.js#L137) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:101](../server/src/routes/api/reports.js#L101) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:94](../server/src/routes/api/reports.js#L94) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:75](../server/src/routes/api/reports.js#L75) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:124](../server/src/routes/api/reports.js#L124) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:117](../server/src/routes/api/reports.js#L117) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:35](../server/src/routes/api/reports.js#L35) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:80](../server/src/routes/api/reports.js#L80) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:45](../server/src/routes/api/reports.js#L45) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:152](../server/src/routes/api/reports.js#L152) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:69](../server/src/routes/api/reports.js#L69) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1030](../server/src/routes/api/toolsCapacity.js#L1030) |
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
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:94](../server/src/routes/api/sanSwitch.js#L94) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:738](../server/src/routes/api/sanSwitch.js#L738) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:762](../server/src/routes/api/sanSwitch.js#L762) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:215](../server/src/routes/api/sanSwitch.js#L215) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:223](../server/src/routes/api/sanSwitch.js#L223) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:272](../server/src/routes/api/sanSwitch.js#L272) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:526](../server/src/routes/api/sanSwitch.js#L526) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:514](../server/src/routes/api/sanSwitch.js#L514) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:406](../server/src/routes/api/sanSwitch.js#L406) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:447](../server/src/routes/api/sanSwitch.js#L447) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:592](../server/src/routes/api/sanSwitch.js#L592) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:602](../server/src/routes/api/sanSwitch.js#L602) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:130](../server/src/routes/api/sanSwitch.js#L130) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:161](../server/src/routes/api/sanSwitch.js#L161) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:831](../server/src/routes/api/sanSwitch.js#L831) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:839](../server/src/routes/api/sanSwitch.js#L839) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:922](../server/src/routes/api/sanSwitch.js#L922) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:867](../server/src/routes/api/sanSwitch.js#L867) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:910](../server/src/routes/api/sanSwitch.js#L910) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:847](../server/src/routes/api/sanSwitch.js#L847) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:853](../server/src/routes/api/sanSwitch.js#L853) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:464](../server/src/routes/api/sanSwitch.js#L464) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:537](../server/src/routes/api/sanSwitch.js#L537) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:336](../server/src/routes/api/sanSwitch.js#L336) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:319](../server/src/routes/api/sanSwitch.js#L319) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:296](../server/src/routes/api/sanSwitch.js#L296) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:304](../server/src/routes/api/sanSwitch.js#L304) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:619](../server/src/routes/api/sanSwitch.js#L619) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:782](../server/src/routes/api/sanSwitch.js#L782) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:239](../server/src/routes/api/sanSwitch.js#L239) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:261](../server/src/routes/api/sanSwitch.js#L261) |
| GET | `/tools/secret-scan` | 역할 `admin` | [server/src/routes/api/toolsInfo.js:32](../server/src/routes/api/toolsInfo.js#L32) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:58](../server/src/routes/api/serialLookup.js#L58) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:86](../server/src/routes/api/serialLookup.js#L86) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:64](../server/src/routes/api/checksLogs.js#L64) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:146](../server/src/routes/api/vcTools.js#L146) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:59](../server/src/routes/api/vcTools.js#L59) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:57](../server/src/routes/api/storageMon.js#L57) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:573](../server/src/routes/api/storageMon.js#L573) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:646](../server/src/routes/api/storageMon.js#L646) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:658](../server/src/routes/api/storageMon.js#L658) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:666](../server/src/routes/api/storageMon.js#L666) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:191](../server/src/routes/api/storageMon.js#L191) |
| POST | `/tools/storage/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:204](../server/src/routes/api/storageMon.js#L204) |
| POST | `/tools/storage/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:169](../server/src/routes/api/storageMon.js#L169) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:179](../server/src/routes/api/storageMon.js#L179) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:511](../server/src/routes/api/storageMon.js#L511) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:516](../server/src/routes/api/storageMon.js#L516) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:229](../server/src/routes/api/storageMon.js#L229) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:551](../server/src/routes/api/storageMon.js#L551) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:317](../server/src/routes/api/storageMon.js#L317) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:341](../server/src/routes/api/storageMon.js#L341) |
| POST | `/tools/storage/devices/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:364](../server/src/routes/api/storageMon.js#L364) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:447](../server/src/routes/api/storageMon.js#L447) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:504](../server/src/routes/api/storageMon.js#L504) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:332](../server/src/routes/api/storageMon.js#L332) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:349](../server/src/routes/api/storageMon.js#L349) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:677](../server/src/routes/api/storageMon.js#L677) |
| GET | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:257](../server/src/routes/api/storageMon.js#L257) |
| PUT | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:275](../server/src/routes/api/storageMon.js#L275) |
| POST | `/tools/storage/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:115](../server/src/routes/api/storageMon.js#L115) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1078](../server/src/routes/api/toolsCapacity.js#L1078) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:103](../server/src/routes/api/toolsAnalytics.js#L103) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:172](../server/src/routes/api/checksLogs.js#L172) |
| GET | `/tools/vclogs/export.csv` | 권한 `tools` | [server/src/routes/api/checksLogs.js:188](../server/src/routes/api/checksLogs.js#L188) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:159](../server/src/routes/api/checksLogs.js#L159) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:150](../server/src/routes/api/checksLogs.js#L150) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:133](../server/src/routes/api/checksLogs.js#L133) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:32](../server/src/routes/api/vmClone.js#L32) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:109](../server/src/routes/api/vmClone.js#L109) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:47](../server/src/routes/api/vmClone.js#L47) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:83](../server/src/routes/api/vmClone.js#L83) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:94](../server/src/routes/api/vmClone.js#L94) |
| GET | `/tools/vm-export` | 권한 `tools` | [server/src/routes/api/ipamExport.js:105](../server/src/routes/api/ipamExport.js#L105) |
| GET | `/tools/vm-export.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:114](../server/src/routes/api/ipamExport.js#L114) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1106](../server/src/routes/api/toolsCapacity.js#L1106) |
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
| GET | `/tools/vmware-config` | 권한 `tools` | [server/src/routes/api/checksLogs.js:81](../server/src/routes/api/checksLogs.js#L81) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:224](../server/src/routes/api/toolsCapacity.js#L224) |
| GET | `/tools/waste/export` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:403](../server/src/routes/api/toolsCapacity.js#L403) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:591](../server/src/routes/api/toolsCapacity.js#L591) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:561](../server/src/routes/api/toolsCapacity.js#L561) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:575](../server/src/routes/api/toolsCapacity.js#L575) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:567](../server/src/routes/api/toolsCapacity.js#L567) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:366](../server/src/routes/api/toolsCapacity.js#L366) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:821](../server/src/routes/api/toolsCapacity.js#L821) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:842](../server/src/routes/api/toolsCapacity.js#L842) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:899](../server/src/routes/api/toolsCapacity.js#L899) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:936](../server/src/routes/api/toolsCapacity.js#L936) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:385](../server/src/routes/api/inventory.js#L385) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:272](../server/src/routes/api/toolsInfo.js#L272) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:274](../server/src/routes/api/toolsInfo.js#L274) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:12](../server/src/routes/api/vcTools.js#L12) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:679](../server/src/routes/api/toolsCapacity.js#L679) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:245](../server/src/routes/api/inventory.js#L245) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:160](../server/src/routes/api/vmMetrics.js#L160) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:102](../server/src/routes/api/vmMetrics.js#L102) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:318](../server/src/routes/api/inventory.js#L318) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:227](../server/src/routes/api/toolsInfo.js#L227) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:269](../server/src/routes/api/toolsCapacity.js#L269) |

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
| `fullScopeOnly` | 194 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 141 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `requireCentral` | 51 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `requireSettingsOwner` | 34 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `guarded` | 8 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `authMiddleware` | 7 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
| `fleetFullScopeOnly` | 4 | **전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403. |
| `fleetWideOnly` | 3 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `reauth` | 3 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `auditMiddleware` | 3 | 상태변경 감사 로그 기록. |
| `requireEnrolled` | 3 | OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다. |
| `express.json` | 3 | 본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약). |
| `ownerIfAutoCentralToken` | 2 | 요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급). |
| `requireOwnOtp` | 2 | **본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다. |
| `express.raw` | 2 | 원시 바디 버퍼(업그레이드 번들 등). ⚠ 게이트가 아니다 — 인증을 이 앞에 두어 미인증 요청이 대용량 바디를 적재하지 못하게 한다. |

---

## 생성 정보

- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`
- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이
  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).

