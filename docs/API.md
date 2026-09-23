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
| 엔드포인트 | **829개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 78개 |
| GET | 433개 |
| POST | 263개 |
| PUT | 85개 |
| PATCH | 2개 |
| DELETE | 46개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 9 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 16 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 49 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 8 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 56 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 307 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 9 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 326 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:105](../server/src/routes/collector.js#L105) |
| POST | `/bmstor-collect` | `express.json` | [server/src/routes/collector.js:194](../server/src/routes/collector.js#L194) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:76](../server/src/routes/collector.js#L76) |
| GET | `/export` | — | [server/src/routes/collector.js:40](../server/src/routes/collector.js#L40) |
| POST | `/idrac-scan` | `express.json` | [server/src/routes/collector.js:168](../server/src/routes/collector.js#L168) |
| GET | `/ping` | — | [server/src/routes/collector.js:57](../server/src/routes/collector.js#L57) |
| POST | `/set-password` | `express.json` | [server/src/routes/collector.js:148](../server/src/routes/collector.js#L148) |
| GET | `/token-check` | — | [server/src/routes/collector.js:133](../server/src/routes/collector.js#L133) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:211](../server/src/routes/collector.js#L211) |

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
| GET | `/anomalies` | — | [server/src/routes/insights.js:209](../server/src/routes/insights.js#L209) |
| POST | `/chatops` | — | [server/src/routes/insights.js:275](../server/src/routes/insights.js#L275) |
| GET | `/finops` | — | [server/src/routes/insights.js:46](../server/src/routes/insights.js#L46) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:65](../server/src/routes/insights.js#L65) |
| PUT | `/finops/config` | 역할 `admin` | [server/src/routes/insights.js:90](../server/src/routes/insights.js#L90) |
| GET | `/fleet` | — | [server/src/routes/insights.js:93](../server/src/routes/insights.js#L93) |
| PUT | `/fleet/assign` | 역할 `admin` | [server/src/routes/insights.js:140](../server/src/routes/insights.js#L140) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` | [server/src/routes/insights.js:156](../server/src/routes/insights.js#L156) |
| POST | `/fleet/prune` | 역할 `admin` | [server/src/routes/insights.js:190](../server/src/routes/insights.js#L190) |
| PUT | `/fleet/tag` | 역할 `admin` | [server/src/routes/insights.js:113](../server/src/routes/insights.js#L113) |
| GET | `/forecast` | — | [server/src/routes/insights.js:229](../server/src/routes/insights.js#L229) |
| GET | `/graph` | — | [server/src/routes/insights.js:254](../server/src/routes/insights.js#L254) |
| GET | `/incidents` | — | [server/src/routes/insights.js:269](../server/src/routes/insights.js#L269) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:68](../server/src/routes/insights.js#L68) |
| GET | `/security` | — | [server/src/routes/insights.js:241](../server/src/routes/insights.js#L241) |
| GET | `/topology` | — | [server/src/routes/insights.js:244](../server/src/routes/insights.js#L244) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | — | [server/src/routes/central.js:1280](../server/src/routes/central.js#L1280) |
| GET | `/assignment` | — | [server/src/routes/central.js:295](../server/src/routes/central.js#L295) |
| GET | `/bmstor-jobs` | — | [server/src/routes/central.js:1344](../server/src/routes/central.js#L1344) |
| POST | `/bmstor-result` | — | [server/src/routes/central.js:1350](../server/src/routes/central.js#L1350) |
| POST | `/capacity-report` | — | [server/src/routes/central.js:422](../server/src/routes/central.js#L422) |
| GET | `/capture-jobs` | — | [server/src/routes/central.js:1325](../server/src/routes/central.js#L1325) |
| POST | `/capture-result` | — | [server/src/routes/central.js:1331](../server/src/routes/central.js#L1331) |
| POST | `/curuser` | — | [server/src/routes/central.js:682](../server/src/routes/central.js#L682) |
| GET | `/curuser-config` | — | [server/src/routes/central.js:727](../server/src/routes/central.js#L727) |
| GET | `/edge-log-jobs` | — | [server/src/routes/central.js:934](../server/src/routes/central.js#L934) |
| POST | `/edge-log-result` | — | [server/src/routes/central.js:943](../server/src/routes/central.js#L943) |
| POST | `/fleet` | — | [server/src/routes/central.js:759](../server/src/routes/central.js#L759) |
| GET | `/gpu-guest-config` | — | [server/src/routes/central.js:866](../server/src/routes/central.js#L866) |
| POST | `/gpu-guest-data` | — | [server/src/routes/central.js:810](../server/src/routes/central.js#L810) |
| POST | `/guest-disk` | — | [server/src/routes/central.js:553](../server/src/routes/central.js#L553) |
| GET | `/health-probe` | — | [server/src/routes/central.js:1416](../server/src/routes/central.js#L1416) |
| GET | `/idrac-scan-jobs` | — | [server/src/routes/central.js:771](../server/src/routes/central.js#L771) |
| POST | `/idrac-scan-progress` | — | [server/src/routes/central.js:778](../server/src/routes/central.js#L778) |
| POST | `/idrac-scan-result` | — | [server/src/routes/central.js:790](../server/src/routes/central.js#L790) |
| POST | `/inventory` | — | [server/src/routes/central.js:495](../server/src/routes/central.js#L495) |
| GET | `/ip-scan-assignment` | — | [server/src/routes/central.js:1367](../server/src/routes/central.js#L1367) |
| POST | `/ip-scan-result` | — | [server/src/routes/central.js:1376](../server/src/routes/central.js#L1376) |
| POST | `/link-check` | — | [server/src/routes/central.js:1432](../server/src/routes/central.js#L1432) |
| GET | `/link-check-config` | — | [server/src/routes/central.js:1462](../server/src/routes/central.js#L1462) |
| GET | `/log-queries` | — | [server/src/routes/central.js:1298](../server/src/routes/central.js#L1298) |
| POST | `/log-query-result` | — | [server/src/routes/central.js:1307](../server/src/routes/central.js#L1307) |
| POST | `/part-faults` | — | [server/src/routes/central.js:910](../server/src/routes/central.js#L910) |
| GET | `/partfault-config` | — | [server/src/routes/central.js:964](../server/src/routes/central.js#L964) |
| GET | `/pdu-config` | — | [server/src/routes/central.js:1004](../server/src/routes/central.js#L1004) |
| POST | `/pdu-data` | — | [server/src/routes/central.js:1024](../server/src/routes/central.js#L1024) |
| GET | `/ping-jobs` | — | [server/src/routes/central.js:1255](../server/src/routes/central.js#L1255) |
| POST | `/ping-result` | — | [server/src/routes/central.js:1265](../server/src/routes/central.js#L1265) |
| POST | `/register-collector` | — | [server/src/routes/central.js:306](../server/src/routes/central.js#L306) |
| POST | `/result` | — | [server/src/routes/central.js:375](../server/src/routes/central.js#L375) |
| POST | `/rma-credential` | — | [server/src/routes/central.js:1184](../server/src/routes/central.js#L1184) |
| POST | `/rma-poll` | — | [server/src/routes/central.js:1130](../server/src/routes/central.js#L1130) |
| POST | `/rma-result` | — | [server/src/routes/central.js:1206](../server/src/routes/central.js#L1206) |
| GET | `/sanswitch-config` | — | [server/src/routes/central.js:1047](../server/src/routes/central.js#L1047) |
| POST | `/sanswitch-data` | — | [server/src/routes/central.js:1219](../server/src/routes/central.js#L1219) |
| POST | `/sanswitch-perf` | — | [server/src/routes/central.js:1072](../server/src/routes/central.js#L1072) |
| POST | `/sanswitch-test-result` | — | [server/src/routes/central.js:1109](../server/src/routes/central.js#L1109) |
| GET | `/storage-config` | — | [server/src/routes/central.js:883](../server/src/routes/central.js#L883) |
| POST | `/storage-data` | — | [server/src/routes/central.js:974](../server/src/routes/central.js#L974) |
| GET | `/svcmon-config` | — | [server/src/routes/central.js:466](../server/src/routes/central.js#L466) |
| POST | `/svcmon-config-ack` | — | [server/src/routes/central.js:482](../server/src/routes/central.js#L482) |
| POST | `/svcmon-report` | — | [server/src/routes/central.js:397](../server/src/routes/central.js#L397) |
| GET | `/users-config` | — | [server/src/routes/central.js:1244](../server/src/routes/central.js#L1244) |
| POST | `/vmseries` | — | [server/src/routes/central.js:626](../server/src/routes/central.js#L626) |
| GET | `/vmseries-config` | — | [server/src/routes/central.js:747](../server/src/routes/central.js#L747) |

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
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:127](../server/src/routes/remote.js#L127) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:129](../server/src/routes/remote.js#L129) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:202](../server/src/routes/remote.js#L202) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:187](../server/src/routes/remote.js#L187) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:48](../server/src/routes/remote.js#L48) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:218](../server/src/routes/remote.js#L218) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:267](../server/src/routes/remote.js#L267) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:256](../server/src/routes/remote.js#L256) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:66](../server/src/routes/remote.js#L66) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:94](../server/src/routes/remote.js#L94) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:138](../server/src/routes/remote.js#L138) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:142](../server/src/routes/remote.js#L142) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:149](../server/src/routes/remote.js#L149) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:137](../server/src/routes/remote.js#L137) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:229](../server/src/routes/remote.js#L229) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:36](../server/src/routes/remote.js#L36) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:282](../server/src/routes/remote.js#L282) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:110](../server/src/routes/remote.js#L110) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:172](../server/src/routes/remote.js#L172) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:30](../server/src/routes/svcmon/edge.js#L30) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:104](../server/src/routes/svcmon/edge.js#L104) |
| PUT | `/assign/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:62](../server/src/routes/svcmon/edge.js#L62) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:112](../server/src/routes/svcmon/edge.js#L112) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:100](../server/src/routes/svcmon/overview.js#L100) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:134](../server/src/routes/svcmon/edge.js#L134) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:121](../server/src/routes/svcmon/edge.js#L121) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:165](../server/src/routes/svcmon/edge.js#L165) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:149](../server/src/routes/svcmon/edge.js#L149) |
| POST | `/flush` | 역할 `admin` | [server/src/routes/svcmon/overview.js:117](../server/src/routes/svcmon/overview.js#L117) |
| POST | `/folders` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:23](../server/src/routes/svcmon/tree.js#L23) |
| POST | `/folders/delete` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:57](../server/src/routes/svcmon/tree.js#L57) |
| POST | `/folders/move` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:39](../server/src/routes/svcmon/tree.js#L39) |
| PUT | `/folders/rename` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:31](../server/src/routes/svcmon/tree.js#L31) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:26](../server/src/routes/svcmon/logs.js#L26) |
| PUT | `/log` | 역할 `admin` | [server/src/routes/svcmon/logs.js:28](../server/src/routes/svcmon/logs.js#L28) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:72](../server/src/routes/svcmon/logs.js#L72) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:46](../server/src/routes/svcmon/logs.js#L46) |
| POST | `/log/prune` | 역할 `admin` | [server/src/routes/svcmon/logs.js:93](../server/src/routes/svcmon/logs.js#L93) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:56](../server/src/routes/svcmon/logs.js#L56) |
| POST | `/push-now` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:173](../server/src/routes/svcmon/edge.js#L173) |
| POST | `/refresh` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:111](../server/src/routes/svcmon/overview.js#L111) |
| PUT | `/reorder/folders` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:52](../server/src/routes/svcmon/tree.js#L52) |
| PUT | `/reorder/targets` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:47](../server/src/routes/svcmon/tree.js#L47) |
| POST | `/silence-check` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:180](../server/src/routes/svcmon/edge.js#L180) |
| PUT | `/sort` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:67](../server/src/routes/svcmon/tree.js#L67) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:48](../server/src/routes/svcmon/overview.js#L48) |
| POST | `/targets` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:73](../server/src/routes/svcmon/tree.js#L73) |
| DELETE | `/targets/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:109](../server/src/routes/svcmon/tree.js#L109) |
| PUT | `/targets/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:100](../server/src/routes/svcmon/tree.js#L100) |
| POST | `/targets/:id/tests` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:115](../server/src/routes/svcmon/tree.js#L115) |
| DELETE | `/targets/:id/tests/:testId` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:133](../server/src/routes/svcmon/tree.js#L133) |
| PUT | `/targets/:id/tests/:testId` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:124](../server/src/routes/svcmon/tree.js#L124) |
| POST | `/targets/bulk` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:81](../server/src/routes/svcmon/tree.js#L81) |
| GET | `/targets/csv-schema` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:137](../server/src/routes/svcmon/transfer.js#L137) |
| GET | `/targets/export.:format` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:69](../server/src/routes/svcmon/transfer.js#L69) |
| GET | `/targets/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:34](../server/src/routes/svcmon/transfer.js#L34) |
| POST | `/targets/generate` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:90](../server/src/routes/svcmon/generate.js#L90) |
| GET | `/targets/hostmap-template.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:100](../server/src/routes/svcmon/transfer.js#L100) |
| POST | `/targets/hostmap/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:129](../server/src/routes/svcmon/transfer.js#L129) |
| POST | `/targets/hostmap/parse` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:109](../server/src/routes/svcmon/transfer.js#L109) |
| POST | `/targets/import` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:158](../server/src/routes/svcmon/transfer.js#L158) |
| GET | `/targets/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:91](../server/src/routes/svcmon/transfer.js#L91) |
| GET | `/templates` | — | [server/src/routes/svcmon/templates.js:27](../server/src/routes/svcmon/templates.js#L27) |
| POST | `/templates` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:32](../server/src/routes/svcmon/templates.js#L32) |
| DELETE | `/templates/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:65](../server/src/routes/svcmon/templates.js#L65) |
| PUT | `/templates/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:43](../server/src/routes/svcmon/templates.js#L43) |
| POST | `/templates/:id/apply` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:128](../server/src/routes/svcmon/templates.js#L128) |
| POST | `/templates/:id/duplicate` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:55](../server/src/routes/svcmon/templates.js#L55) |
| GET | `/templates/:id/usage` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:122](../server/src/routes/svcmon/templates.js#L122) |
| GET | `/templates/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:78](../server/src/routes/svcmon/templates.js#L78) |
| POST | `/templates/import` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:97](../server/src/routes/svcmon/templates.js#L97) |
| GET | `/templates/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:86](../server/src/routes/svcmon/templates.js#L86) |

## `/api/admin`

설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-deploy` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:66](../server/src/routes/admin/deployLlm.js#L66) |
| GET | `/agent-deploy/bulk` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:287](../server/src/routes/admin/deployLlm.js#L287) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:288](../server/src/routes/admin/deployLlm.js#L288) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:293](../server/src/routes/admin/deployLlm.js#L293) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:239](../server/src/routes/admin/deployLlm.js#L239) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:244](../server/src/routes/admin/deployLlm.js#L244) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:260](../server/src/routes/admin/deployLlm.js#L260) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:304](../server/src/routes/admin/deployLlm.js#L304) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:373](../server/src/routes/admin/deployLlm.js#L373) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:322](../server/src/routes/admin/deployLlm.js#L322) |
| GET | `/agent-deploy/defaults` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:52](../server/src/routes/admin/deployLlm.js#L52) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:198](../server/src/routes/admin/deployLlm.js#L198) |
| GET | `/agent-deploy/installer` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:50](../server/src/routes/admin/deployLlm.js#L50) |
| GET | `/agent-deploy/targets` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:86](../server/src/routes/admin/deployLlm.js#L86) |
| POST | `/agent-deploy/targets` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:95](../server/src/routes/admin/deployLlm.js#L95) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:116](../server/src/routes/admin/deployLlm.js#L116) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:179](../server/src/routes/admin/deployLlm.js#L179) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:189](../server/src/routes/admin/deployLlm.js#L189) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:127](../server/src/routes/admin/deployLlm.js#L127) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:462](../server/src/routes/admin/deployLlm.js#L462) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:147](../server/src/routes/admin/deployLlm.js#L147) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:141](../server/src/routes/admin/deployLlm.js#L141) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:475](../server/src/routes/admin/deployLlm.js#L475) |
| POST | `/agent-deploy/test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:62](../server/src/routes/admin/deployLlm.js#L62) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:28](../server/src/routes/admin/opsSettings.js#L28) |
| PUT | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:29](../server/src/routes/admin/opsSettings.js#L29) |
| POST | `/alerts/test` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:41](../server/src/routes/admin/opsSettings.js#L41) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:64](../server/src/routes/admin/opsSettings.js#L64) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:65](../server/src/routes/admin/opsSettings.js#L65) |
| GET | `/api-keys` | 역할 `admin` | [server/src/routes/admin/apiKeys.js:30](../server/src/routes/admin/apiKeys.js#L30) |
| POST | `/api-keys` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:63](../server/src/routes/admin/apiKeys.js#L63) |
| DELETE | `/api-keys/:id` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:99](../server/src/routes/admin/apiKeys.js#L99) |
| PATCH | `/api-keys/:id` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:80](../server/src/routes/admin/apiKeys.js#L80) |
| POST | `/api-keys/:id/revoke` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:91](../server/src/routes/admin/apiKeys.js#L91) |
| GET | `/assignments` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:177](../server/src/routes/admin/horizonAssign.js#L177) |
| POST | `/assignments` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:185](../server/src/routes/admin/horizonAssign.js#L185) |
| DELETE | `/assignments/:agent` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:195](../server/src/routes/admin/horizonAssign.js#L195) |
| PUT | `/assignments/:agent` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:190](../server/src/routes/admin/horizonAssign.js#L190) |
| POST | `/assignments/import` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:202](../server/src/routes/admin/horizonAssign.js#L202) |
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:23](../server/src/routes/admin/opsSettings.js#L23) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:57](../server/src/routes/admin/backupNetSec.js#L57) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:40](../server/src/routes/admin/backupNetSec.js#L40) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:36](../server/src/routes/admin/backupNetSec.js#L36) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:58](../server/src/routes/admin/backupNetSec.js#L58) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:35](../server/src/routes/admin/backupNetSec.js#L35) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:32](../server/src/routes/admin/backupNetSec.js#L32) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:48](../server/src/routes/admin/backupNetSec.js#L48) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:39](../server/src/routes/admin/centralIpam.js#L39) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:53](../server/src/routes/admin/centralIpam.js#L53) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:48](../server/src/routes/admin/centralIpam.js#L48) |
| GET | `/central/agent-tokens` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:66](../server/src/routes/admin/centralIpam.js#L66) |
| POST | `/central/agent-tokens` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:69](../server/src/routes/admin/centralIpam.js#L69) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralIpam.js:75](../server/src/routes/admin/centralIpam.js#L75) |
| GET | `/central/ingest-stats` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:44](../server/src/routes/admin/centralIpam.js#L44) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:45](../server/src/routes/admin/centralIpam.js#L45) |
| GET | `/central/inventory` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:41](../server/src/routes/admin/centralIpam.js#L41) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:57](../server/src/routes/admin/opsSettings.js#L57) |
| GET | `/codex-check` | 역할 `admin` | [server/src/routes/admin/statusTools.js:23](../server/src/routes/admin/statusTools.js#L23) |
| GET | `/codex-check/file` | 역할 `admin` | [server/src/routes/admin/statusTools.js:26](../server/src/routes/admin/statusTools.js#L26) |
| POST | `/codex-check/write` | 역할 `admin` | [server/src/routes/admin/statusTools.js:29](../server/src/routes/admin/statusTools.js#L29) |
| GET | `/collectors` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:76](../server/src/routes/admin/collectorsDc.js#L76) |
| POST | `/collectors` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:80](../server/src/routes/admin/collectorsDc.js#L80) |
| DELETE | `/collectors/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:101](../server/src/routes/admin/collectorsDc.js#L101) |
| PUT | `/collectors/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:87](../server/src/routes/admin/collectorsDc.js#L87) |
| POST | `/collectors/:id/force-token` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:434](../server/src/routes/admin/collectorsDc.js#L434) |
| GET | `/collectors/export.csv` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:120](../server/src/routes/admin/collectorsDc.js#L120) |
| POST | `/collectors/import` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:149](../server/src/routes/admin/collectorsDc.js#L149) |
| POST | `/collectors/pull` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:346](../server/src/routes/admin/collectorsDc.js#L346) |
| GET | `/collectors/sample.csv` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:135](../server/src/routes/admin/collectorsDc.js#L135) |
| POST | `/collectors/set-password` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:201](../server/src/routes/admin/collectorsDc.js#L201) |
| POST | `/collectors/test` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:367](../server/src/routes/admin/collectorsDc.js#L367) |
| POST | `/collectors/upgrade` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:353](../server/src/routes/admin/collectorsDc.js#L353) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:14](../server/src/routes/admin/vcenters.js#L14) |
| PUT | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:19](../server/src/routes/admin/vcenters.js#L19) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:272](../server/src/routes/admin/collectorsDc.js#L272) |
| PUT | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:275](../server/src/routes/admin/collectorsDc.js#L275) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:242](../server/src/routes/admin/collectorsDc.js#L242) |
| POST | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:248](../server/src/routes/admin/collectorsDc.js#L248) |
| DELETE | `/datacenters/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:266](../server/src/routes/admin/collectorsDc.js#L266) |
| PUT | `/datacenters/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:261](../server/src/routes/admin/collectorsDc.js#L261) |
| PUT | `/datacenters/assign` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:254](../server/src/routes/admin/collectorsDc.js#L254) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:173](../server/src/routes/admin/backupNetSec.js#L173) |
| GET | `/dir-usage` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:21](../server/src/routes/admin/dirUsage.js#L21) |
| PUT | `/dir-usage` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:34](../server/src/routes/admin/dirUsage.js#L34) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:56](../server/src/routes/admin/dirUsage.js#L56) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:73](../server/src/routes/admin/dirUsage.js#L73) |
| POST | `/dir-usage/run` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:48](../server/src/routes/admin/dirUsage.js#L48) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:64](../server/src/routes/admin/dirUsage.js#L64) |
| POST | `/edge-users-bulk` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:150](../server/src/routes/admin/gpuGuest.js#L150) |
| GET | `/edge-users/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:136](../server/src/routes/admin/gpuGuest.js#L136) |
| POST | `/edge-users/:agent` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:145](../server/src/routes/admin/gpuGuest.js#L145) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:156](../server/src/routes/admin/gpuGuest.js#L156) |
| GET | `/edge-users/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:125](../server/src/routes/admin/gpuGuest.js#L125) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:40](../server/src/routes/admin/statusTools.js#L40) |
| POST | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:44](../server/src/routes/admin/statusTools.js#L44) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:56](../server/src/routes/admin/nsxImport.js#L56) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:111](../server/src/routes/admin/gpuGuest.js#L111) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:115](../server/src/routes/admin/gpuGuest.js#L115) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:101](../server/src/routes/admin/gpuGuest.js#L101) |
| GET | `/gpu-guest/diag` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:62](../server/src/routes/admin/gpuGuest.js#L62) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:50](../server/src/routes/admin/gpuGuest.js#L50) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:53](../server/src/routes/admin/gpuGuest.js#L53) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:255](../server/src/routes/admin/gpuGuest.js#L255) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:352](../server/src/routes/admin/gpuGuest.js#L352) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:68](../server/src/routes/admin/gpuGuest.js#L68) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:162](../server/src/routes/admin/gpuGuest.js#L162) |
| POST | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:165](../server/src/routes/admin/gpuGuest.js#L165) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:175](../server/src/routes/admin/gpuGuest.js#L175) |
| PUT | `/gpu-physical/:id` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:170](../server/src/routes/admin/gpuGuest.js#L170) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:184](../server/src/routes/admin/gpuGuest.js#L184) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:208](../server/src/routes/admin/gpuGuest.js#L208) |
| POST | `/gpu-physical/poll` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:179](../server/src/routes/admin/gpuGuest.js#L179) |
| POST | `/gpu-physical/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:236](../server/src/routes/admin/gpuGuest.js#L236) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:36](../server/src/routes/admin/gpuGuest.js#L36) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:161](../server/src/routes/admin/backupNetSec.js#L161) |
| GET | `/horizon` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:15](../server/src/routes/admin/horizonAssign.js#L15) |
| POST | `/horizon` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:16](../server/src/routes/admin/horizonAssign.js#L16) |
| DELETE | `/horizon/:id` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:21](../server/src/routes/admin/horizonAssign.js#L21) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:56](../server/src/routes/admin/horizonAssign.js#L56) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:64](../server/src/routes/admin/horizonAssign.js#L64) |
| POST | `/horizon/servers/import` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:129](../server/src/routes/admin/horizonAssign.js#L129) |
| POST | `/horizon/servers/import/test` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:88](../server/src/routes/admin/horizonAssign.js#L88) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:119](../server/src/routes/admin/horizonAssign.js#L119) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:72](../server/src/routes/admin/horizonAssign.js#L72) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:78](../server/src/routes/admin/horizonAssign.js#L78) |
| POST | `/horizon/test` | 역할 `admin` | [server/src/routes/admin/horizonAssign.js:26](../server/src/routes/admin/horizonAssign.js#L26) |
| GET | `/host-access` | 역할 `admin` | [server/src/routes/admin/hostAccess.js:24](../server/src/routes/admin/hostAccess.js#L24) |
| POST | `/host-access/apply` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:36](../server/src/routes/admin/hostAccess.js#L36) |
| POST | `/host-access/confirm` | 역할 `admin` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:41](../server/src/routes/admin/hostAccess.js#L41) |
| PUT | `/host-access/draft` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:27](../server/src/routes/admin/hostAccess.js#L27) |
| POST | `/host-access/plan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:33](../server/src/routes/admin/hostAccess.js#L33) |
| POST | `/host-access/revert` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:46](../server/src/routes/admin/hostAccess.js#L46) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:82](../server/src/routes/admin/idracCore.js#L82) |
| POST | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:96](../server/src/routes/admin/idracCore.js#L96) |
| DELETE | `/idrac/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:484](../server/src/routes/admin/idracScan.js#L484) |
| PUT | `/idrac/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:478](../server/src/routes/admin/idracScan.js#L478) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` | [server/src/routes/admin/idracScan.js:178](../server/src/routes/admin/idracScan.js#L178) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:43](../server/src/routes/admin/idracScan.js#L43) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:94](../server/src/routes/admin/idracScan.js#L94) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:136](../server/src/routes/admin/idracScan.js#L136) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:62](../server/src/routes/admin/idracScan.js#L62) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` | [server/src/routes/admin/idracScan.js:466](../server/src/routes/admin/idracScan.js#L466) |
| POST | `/idrac/bulk-add` | 역할 `admin` | [server/src/routes/admin/idracScan.js:210](../server/src/routes/admin/idracScan.js#L210) |
| POST | `/idrac/delete` | 역할 `admin` | [server/src/routes/admin/idracScan.js:453](../server/src/routes/admin/idracScan.js#L453) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:203](../server/src/routes/admin/idracScan.js#L203) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:394](../server/src/routes/admin/idracCore.js#L394) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:429](../server/src/routes/admin/idracCore.js#L429) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:330](../server/src/routes/admin/idracCore.js#L330) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:146](../server/src/routes/admin/idracCore.js#L146) |
| POST | `/idrac/import` | 역할 `admin` | [server/src/routes/admin/idracScan.js:192](../server/src/routes/admin/idracScan.js#L192) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:253](../server/src/routes/admin/idracCore.js#L253) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:181](../server/src/routes/admin/idracCore.js#L181) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:488](../server/src/routes/admin/idracCore.js#L488) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:505](../server/src/routes/admin/idracCore.js#L505) |
| POST | `/idrac/poll` | 역할 `admin` | [server/src/routes/admin/idracCore.js:114](../server/src/routes/admin/idracCore.js#L114) |
| POST | `/idrac/power-purge` | 역할 `admin` | [server/src/routes/admin/idracCore.js:132](../server/src/routes/admin/idracCore.js#L132) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:120](../server/src/routes/admin/idracCore.js#L120) |
| PUT | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:121](../server/src/routes/admin/idracCore.js#L121) |
| POST | `/idrac/register-scanned` | 역할 `admin` | [server/src/routes/admin/idracScan.js:273](../server/src/routes/admin/idracScan.js#L273) |
| POST | `/idrac/scan` | 역할 `admin` | [server/src/routes/admin/idracScan.js:219](../server/src/routes/admin/idracScan.js#L219) |
| GET | `/idrac/scan-agents` | 역할 `admin` | [server/src/routes/admin/idracScan.js:259](../server/src/routes/admin/idracScan.js#L259) |
| GET | `/idrac/scan-job-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:427](../server/src/routes/admin/idracScan.js#L427) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` | [server/src/routes/admin/idracScan.js:445](../server/src/routes/admin/idracScan.js#L445) |
| GET | `/idrac/scan-jobs` | 역할 `admin` | [server/src/routes/admin/idracScan.js:417](../server/src/routes/admin/idracScan.js#L417) |
| GET | `/idrac/scan-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:392](../server/src/routes/admin/idracScan.js#L392) |
| GET | `/idrac/scan-ranges` | 역할 `admin` | [server/src/routes/admin/idracScan.js:290](../server/src/routes/admin/idracScan.js#L290) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` | [server/src/routes/admin/idracScan.js:296](../server/src/routes/admin/idracScan.js#L296) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:304](../server/src/routes/admin/idracScan.js#L304) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:315](../server/src/routes/admin/idracScan.js#L315) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` | [server/src/routes/admin/idracScan.js:336](../server/src/routes/admin/idracScan.js#L336) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` | [server/src/routes/admin/idracScan.js:406](../server/src/routes/admin/idracScan.js#L406) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:330](../server/src/routes/admin/idracScan.js#L330) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` | [server/src/routes/admin/idracScan.js:380](../server/src/routes/admin/idracScan.js#L380) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` | [server/src/routes/admin/idracScan.js:389](../server/src/routes/admin/idracScan.js#L389) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` | [server/src/routes/admin/idracScan.js:399](../server/src/routes/admin/idracScan.js#L399) |
| GET | `/idrac/scan-result` | 역할 `admin` | [server/src/routes/admin/idracScan.js:250](../server/src/routes/admin/idracScan.js#L250) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:371](../server/src/routes/admin/idracCore.js#L371) |
| POST | `/idrac/test` | 역할 `admin` | [server/src/routes/admin/idracCore.js:106](../server/src/routes/admin/idracCore.js#L106) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:364](../server/src/routes/admin/idracCore.js#L364) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:24](../server/src/routes/admin/centralIpam.js#L24) |
| GET | `/ipam/scan/results` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:115](../server/src/routes/admin/centralIpam.js#L115) |
| POST | `/ipam/scan/run` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:107](../server/src/routes/admin/centralIpam.js#L107) |
| GET | `/ipam/scan/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:83](../server/src/routes/admin/centralIpam.js#L83) |
| PUT | `/ipam/scan/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:101](../server/src/routes/admin/centralIpam.js#L101) |
| GET | `/ipam/scan/status` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:112](../server/src/routes/admin/centralIpam.js#L112) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:29](../server/src/routes/admin/centralIpam.js#L29) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:30](../server/src/routes/admin/centralIpam.js#L30) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:120](../server/src/routes/admin/centralIpam.js#L120) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:126](../server/src/routes/admin/centralIpam.js#L126) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:145](../server/src/routes/admin/centralIpam.js#L145) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:139](../server/src/routes/admin/centralIpam.js#L139) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:130](../server/src/routes/admin/centralIpam.js#L130) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:483](../server/src/routes/admin/deployLlm.js#L483) |
| PUT | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:484](../server/src/routes/admin/deployLlm.js#L484) |
| POST | `/llm-test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:488](../server/src/routes/admin/deployLlm.js#L488) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/logs` | 역할 `admin` | [server/src/routes/admin/statusTools.js:67](../server/src/routes/admin/statusTools.js#L67) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:19](../server/src/routes/admin/mail.js#L19) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:23](../server/src/routes/admin/mail.js#L23) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:45](../server/src/routes/admin/mail.js#L45) |
| GET | `/memtrack` | 역할 `admin` | [server/src/routes/admin/statusTools.js:170](../server/src/routes/admin/statusTools.js#L170) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:27](../server/src/routes/admin/gpuGuest.js#L27) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:30](../server/src/routes/admin/gpuGuest.js#L30) |
| GET | `/net/agents` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:94](../server/src/routes/admin/backupNetSec.js#L94) |
| GET | `/net/capture` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:126](../server/src/routes/admin/backupNetSec.js#L126) |
| POST | `/net/capture` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:101](../server/src/routes/admin/backupNetSec.js#L101) |
| GET | `/net/history` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:143](../server/src/routes/admin/backupNetSec.js#L143) |
| DELETE | `/net/history/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:145](../server/src/routes/admin/backupNetSec.js#L145) |
| GET | `/net/history/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:144](../server/src/routes/admin/backupNetSec.js#L144) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:153](../server/src/routes/admin/backupNetSec.js#L153) |
| GET | `/net/monitors` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:148](../server/src/routes/admin/backupNetSec.js#L148) |
| PUT | `/net/monitors` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:149](../server/src/routes/admin/backupNetSec.js#L149) |
| DELETE | `/net/monitors/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:150](../server/src/routes/admin/backupNetSec.js#L150) |
| POST | `/net/monitors/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:151](../server/src/routes/admin/backupNetSec.js#L151) |
| POST | `/net/pcap` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:132](../server/src/routes/admin/backupNetSec.js#L132) |
| GET | `/nfs-mounts` | 역할 `admin` | [server/src/routes/admin/nfsMounts.js:15](../server/src/routes/admin/nfsMounts.js#L15) |
| POST | `/nfs-mounts` | 역할 `admin` | [server/src/routes/admin/nfsMounts.js:19](../server/src/routes/admin/nfsMounts.js#L19) |
| DELETE | `/nfs-mounts/:id` | 역할 `admin` | [server/src/routes/admin/nfsMounts.js:27](../server/src/routes/admin/nfsMounts.js#L27) |
| POST | `/nfs-mounts/:id/mount` | 역할 `admin` | [server/src/routes/admin/nfsMounts.js:35](../server/src/routes/admin/nfsMounts.js#L35) |
| POST | `/nfs-mounts/:id/umount` | 역할 `admin` | [server/src/routes/admin/nfsMounts.js:43](../server/src/routes/admin/nfsMounts.js#L43) |
| GET | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:26](../server/src/routes/admin/nsxImport.js#L26) |
| POST | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:36](../server/src/routes/admin/nsxImport.js#L36) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:46](../server/src/routes/admin/nsxImport.js#L46) |
| PUT | `/nsx/managers/:id` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:41](../server/src/routes/admin/nsxImport.js#L41) |
| POST | `/nsx/managers/test` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:51](../server/src/routes/admin/nsxImport.js#L51) |
| POST | `/ollama-deploy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:500](../server/src/routes/admin/deployLlm.js#L500) |
| POST | `/ollama-deploy/test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:497](../server/src/routes/admin/deployLlm.js#L497) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:136](../server/src/routes/admin/opsSettings.js#L136) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:139](../server/src/routes/admin/opsSettings.js#L139) |
| GET | `/os-scan/results.csv` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:143](../server/src/routes/admin/opsSettings.js#L143) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:138](../server/src/routes/admin/opsSettings.js#L138) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:137](../server/src/routes/admin/opsSettings.js#L137) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:33](../server/src/routes/admin/deployLlm.js#L33) |
| POST | `/packages/download` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:44](../server/src/routes/admin/deployLlm.js#L44) |
| PUT | `/packages/settings` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:41](../server/src/routes/admin/deployLlm.js#L41) |
| GET | `/perf` | 역할 `admin` | [server/src/routes/admin/perfMonitor.js:19](../server/src/routes/admin/perfMonitor.js#L19) |
| DELETE | `/perf/hangs` | 역할 `admin` | [server/src/routes/admin/perfMonitor.js:57](../server/src/routes/admin/perfMonitor.js#L57) |
| GET | `/perf/hangs` | 역할 `admin` | [server/src/routes/admin/perfMonitor.js:51](../server/src/routes/admin/perfMonitor.js#L51) |
| POST | `/perf/measure` | 역할 `admin` | [server/src/routes/admin/perfMonitor.js:44](../server/src/routes/admin/perfMonitor.js#L44) |
| PUT | `/perf/settings` | 역할 `admin` | [server/src/routes/admin/perfMonitor.js:28](../server/src/routes/admin/perfMonitor.js#L28) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:37](../server/src/routes/admin/users.js#L37) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:89](../server/src/routes/admin/users.js#L89) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:96](../server/src/routes/admin/users.js#L96) |
| GET | `/portal-db` | 역할 `admin` | [server/src/routes/admin/statusTools.js:86](../server/src/routes/admin/statusTools.js#L86) |
| GET | `/portal-db/health` | 역할 `admin` | [server/src/routes/admin/statusTools.js:96](../server/src/routes/admin/statusTools.js#L96) |
| GET | `/portal-db/location` | 역할 `admin` | [server/src/routes/admin/statusTools.js:115](../server/src/routes/admin/statusTools.js#L115) |
| POST | `/portal-db/location/preflight` | 역할 `admin` | [server/src/routes/admin/statusTools.js:131](../server/src/routes/admin/statusTools.js#L131) |
| POST | `/portal-db/location/script` | 역할 `admin` | [server/src/routes/admin/statusTools.js:141](../server/src/routes/admin/statusTools.js#L141) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:159](../server/src/routes/admin/opsSettings.js#L159) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:176](../server/src/routes/admin/opsSettings.js#L176) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:168](../server/src/routes/admin/opsSettings.js#L168) |
| POST | `/release-notes` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:507](../server/src/routes/admin/deployLlm.js#L507) |
| DELETE | `/release-notes/:version` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:511](../server/src/routes/admin/deployLlm.js#L511) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:44](../server/src/routes/admin/opsSettings.js#L44) |
| PUT | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:45](../server/src/routes/admin/opsSettings.js#L45) |
| POST | `/report/daily/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:50](../server/src/routes/admin/opsSettings.js#L50) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:69](../server/src/routes/admin/idracCore.js#L69) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:41](../server/src/routes/admin/idracCore.js#L41) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:57](../server/src/routes/admin/idracCore.js#L57) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:72](../server/src/routes/admin/opsSettings.js#L72) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:75](../server/src/routes/admin/opsSettings.js#L75) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:196](../server/src/routes/admin/backupNetSec.js#L196) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:197](../server/src/routes/admin/backupNetSec.js#L197) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:198](../server/src/routes/admin/backupNetSec.js#L198) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:199](../server/src/routes/admin/backupNetSec.js#L199) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:184](../server/src/routes/admin/backupNetSec.js#L184) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:190](../server/src/routes/admin/backupNetSec.js#L190) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:189](../server/src/routes/admin/backupNetSec.js#L189) |
| GET | `/security/login-fails/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:188](../server/src/routes/admin/backupNetSec.js#L188) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:193](../server/src/routes/admin/backupNetSec.js#L193) |
| GET | `/security/self-check` | 역할 `admin` | [server/src/routes/admin/securityCheck.js:18](../server/src/routes/admin/securityCheck.js#L18) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:99](../server/src/routes/admin/opsSettings.js#L99) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:100](../server/src/routes/admin/opsSettings.js#L100) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:175](../server/src/routes/admin/statusTools.js#L175) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:17](../server/src/routes/admin/toolCategories.js#L17) |
| PUT | `/tool-categories` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:21](../server/src/routes/admin/toolCategories.js#L21) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:37](../server/src/routes/admin/toolCategories.js#L37) |
| PUT | `/user-tools/:username` | 역할 `admin` | [server/src/routes/admin/users.js:68](../server/src/routes/admin/users.js#L68) |
| GET | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:12](../server/src/routes/admin/users.js#L12) |
| POST | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:16](../server/src/routes/admin/users.js#L16) |
| DELETE | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:28](../server/src/routes/admin/users.js#L28) |
| PATCH | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:22](../server/src/routes/admin/users.js#L22) |
| DELETE | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:114](../server/src/routes/admin/users.js#L114) |
| POST | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:107](../server/src/routes/admin/users.js#L107) |
| POST | `/users/:username/totp/begin` | 역할 `admin` | [server/src/routes/admin/users.js:126](../server/src/routes/admin/users.js#L126) |
| POST | `/users/:username/totp/confirm` | 역할 `admin` | [server/src/routes/admin/users.js:131](../server/src/routes/admin/users.js#L131) |
| POST | `/users/:username/totp/disable` | 역할 `admin` | [server/src/routes/admin/users.js:136](../server/src/routes/admin/users.js#L136) |
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:85](../server/src/routes/admin/vcenters.js#L85) |
| PUT | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:93](../server/src/routes/admin/vcenters.js#L93) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:73](../server/src/routes/admin/statusTools.js#L73) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:27](../server/src/routes/admin/vcenters.js#L27) |
| POST | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:41](../server/src/routes/admin/vcenters.js#L41) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:55](../server/src/routes/admin/vcenters.js#L55) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:48](../server/src/routes/admin/vcenters.js#L48) |
| POST | `/vcenters/import` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:63](../server/src/routes/admin/nsxImport.js#L63) |
| POST | `/vcenters/import-file` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:80](../server/src/routes/admin/nsxImport.js#L80) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:72](../server/src/routes/admin/nsxImport.js#L72) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:62](../server/src/routes/admin/vcenters.js#L62) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:69](../server/src/routes/admin/vcenters.js#L69) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:88](../server/src/routes/admin/backupNetSec.js#L88) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:72](../server/src/routes/admin/backupNetSec.js#L72) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:69](../server/src/routes/admin/backupNetSec.js#L69) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:282](../server/src/routes/admin/collectorsDc.js#L282) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:305](../server/src/routes/admin/collectorsDc.js#L305) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:227](../server/src/routes/auth.js#L227) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `requireSettingsOwner` | [server/src/routes/auth.js:235](../server/src/routes/auth.js#L235) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:240](../server/src/routes/auth.js#L240) |
| GET | `/config` | — | [server/src/routes/auth.js:26](../server/src/routes/auth.js#L26) |
| POST | `/extend` | `authMiddleware` | [server/src/routes/auth.js:166](../server/src/routes/auth.js#L166) |
| POST | `/login` | — | [server/src/routes/auth.js:46](../server/src/routes/auth.js#L46) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:139](../server/src/routes/auth.js#L139) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:211](../server/src/routes/auth.js#L211) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:215](../server/src/routes/auth.js#L215) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:165](../server/src/routes/ping.js#L165) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:175](../server/src/routes/ping.js#L175) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:122](../server/src/routes/ping.js#L122) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:127](../server/src/routes/ping.js#L127) |
| GET | `/series` | — | [server/src/routes/ping.js:96](../server/src/routes/ping.js#L96) |
| GET | `/status` | — | [server/src/routes/ping.js:78](../server/src/routes/ping.js#L78) |
| GET | `/targets` | — | [server/src/routes/ping.js:91](../server/src/routes/ping.js#L91) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:114](../server/src/routes/ping.js#L114) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:116](../server/src/routes/ping.js#L116) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:115](../server/src/routes/ping.js#L115) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:181](../server/src/routes/ping.js#L181) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:195](../server/src/routes/ping.js#L195) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:197](../server/src/routes/ping.js#L197) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:202](../server/src/routes/ping.js#L202) |

## `/metrics`

Prometheus/OTel 익스포터(선택 토큰).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/metricsExport.js:29](../server/src/routes/metricsExport.js#L29) |

## `/api/v1`

**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/publicApi.js:103](../server/src/routes/publicApi.js#L103) |
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:197](../server/src/routes/publicApi.js#L197) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:212](../server/src/routes/publicApi.js#L212) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:243](../server/src/routes/publicApi.js#L243) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:273](../server/src/routes/publicApi.js#L273) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:288](../server/src/routes/publicApi.js#L288) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:171](../server/src/routes/publicApi.js#L171) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:120](../server/src/routes/publicApi.js#L120) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:156](../server/src/routes/publicApi.js#L156) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:113](../server/src/routes/publicApi.js#L113) |

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
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:141](../server/src/routes/api/overviewNsx.js#L141) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:205](../server/src/routes/api/inventory.js#L205) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:107](../server/src/routes/api/vmMetrics.js#L107) |
| GET | `/idrac/host-power` | — | [server/src/routes/api/vmMetrics.js:163](../server/src/routes/api/vmMetrics.js#L163) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:364](../server/src/routes/api/inventory.js#L364) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:232](../server/src/routes/api/overviewNsx.js#L232) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:266](../server/src/routes/api/overviewNsx.js#L266) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:185](../server/src/routes/api/overviewNsx.js#L185) |
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
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:30](../server/src/routes/api/searchNotes.js#L30) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:15](../server/src/routes/api/searchNotes.js#L15) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:52](../server/src/routes/api/inventory.js#L52) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:458](../server/src/routes/api/inventory.js#L458) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:454](../server/src/routes/api/inventory.js#L454) |
| GET | `/tools/bm-storage` | 역할 `admin` | [server/src/routes/api/bmstor.js:16](../server/src/routes/api/bmstor.js#L16) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` | [server/src/routes/api/bmstor.js:106](../server/src/routes/api/bmstor.js#L106) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` | [server/src/routes/api/bmstor.js:50](../server/src/routes/api/bmstor.js#L50) |
| POST | `/tools/bm-storage/import` | 역할 `admin` | [server/src/routes/api/bmstor.js:70](../server/src/routes/api/bmstor.js#L70) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` | [server/src/routes/api/bmstor.js:64](../server/src/routes/api/bmstor.js#L64) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` | [server/src/routes/api/bmstor.js:28](../server/src/routes/api/bmstor.js#L28) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` | [server/src/routes/api/bmstor.js:34](../server/src/routes/api/bmstor.js#L34) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` | [server/src/routes/api/bmstor.js:41](../server/src/routes/api/bmstor.js#L41) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:81](../server/src/routes/api/bmUsage.js#L81) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:213](../server/src/routes/api/bmUsage.js#L213) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:186](../server/src/routes/api/bmUsage.js#L186) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:263](../server/src/routes/api/bmUsage.js#L263) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:316](../server/src/routes/api/bmUsage.js#L316) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:152](../server/src/routes/api/bmUsage.js#L152) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:344](../server/src/routes/api/bmUsage.js#L344) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:40](../server/src/routes/api/toolsCapacity.js#L40) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1492](../server/src/routes/api/toolsCapacity.js#L1492) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1397](../server/src/routes/api/toolsCapacity.js#L1397) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:92](../server/src/routes/api/commMap.js#L92) |
| GET | `/tools/credentials` | 역할 `admin` | [server/src/routes/api/credentials.js:42](../server/src/routes/api/credentials.js#L42) |
| POST | `/tools/credentials` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:52](../server/src/routes/api/credentials.js#L52) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:72](../server/src/routes/api/credentials.js#L72) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:62](../server/src/routes/api/credentials.js#L62) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` | [server/src/routes/api/credentials.js:80](../server/src/routes/api/credentials.js#L80) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` | [server/src/routes/api/credentials.js:47](../server/src/routes/api/credentials.js#L47) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:158](../server/src/routes/api/horizonSessions.js#L158) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:45](../server/src/routes/api/curUser.js#L45) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:109](../server/src/routes/api/curUser.js#L109) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:199](../server/src/routes/api/curUser.js#L199) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:124](../server/src/routes/api/curUser.js#L124) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:78](../server/src/routes/api/curUser.js#L78) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:133](../server/src/routes/api/curUser.js#L133) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:173](../server/src/routes/api/curUser.js#L173) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:62](../server/src/routes/api/dataFlow.js#L62) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:40](../server/src/routes/api/checksLogs.js#L40) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:29](../server/src/routes/api/deviceFlow.js#L29) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:23](../server/src/routes/api/vcTools.js#L23) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:301](../server/src/routes/api/hardwareGpu.js#L301) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1141](../server/src/routes/api/toolsCapacity.js#L1141) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1234](../server/src/routes/api/toolsCapacity.js#L1234) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1296](../server/src/routes/api/toolsCapacity.js#L1296) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:320](../server/src/routes/api/hardwareGpu.js#L320) |
| GET | `/tools/gpu.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:334](../server/src/routes/api/hardwareGpu.js#L334) |
| GET | `/tools/gpu.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:326](../server/src/routes/api/hardwareGpu.js#L326) |
| GET | `/tools/gpu/export.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:357](../server/src/routes/api/hardwareGpu.js#L357) |
| GET | `/tools/gpu/export.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:358](../server/src/routes/api/hardwareGpu.js#L358) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:152](../server/src/routes/api/toolsAnalytics.js#L152) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:350](../server/src/routes/api/hardwareGpu.js#L350) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:398](../server/src/routes/api/hardwareGpu.js#L398) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:346](../server/src/routes/api/toolsCapacity.js#L346) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:20](../server/src/routes/api/toolsGuestDisk.js#L20) |
| GET | `/tools/guest-disk/export.csv` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:43](../server/src/routes/api/toolsGuestDisk.js#L43) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:70](../server/src/routes/api/toolsGuestDisk.js#L70) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:63](../server/src/routes/api/toolsGuestDisk.js#L63) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:57](../server/src/routes/api/toolsGuestDisk.js#L57) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:32](../server/src/routes/api/toolsGuestDisk.js#L32) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:39](../server/src/routes/api/toolsInfo.js#L39) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:57](../server/src/routes/api/toolsInfo.js#L57) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:269](../server/src/routes/api/hardwareGpu.js#L269) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:81](../server/src/routes/api/toolsInfo.js#L81) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:62](../server/src/routes/api/horizonSessions.js#L62) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:105](../server/src/routes/api/horizonSessions.js#L105) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:110](../server/src/routes/api/horizonSessions.js#L110) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:89](../server/src/routes/api/horizonSessions.js#L89) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:119](../server/src/routes/api/horizonSessions.js#L119) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:132](../server/src/routes/api/horizonSessions.js#L132) |
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
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:131](../server/src/routes/api/toolsInfo.js#L131) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:105](../server/src/routes/api/toolsInfo.js#L105) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:52](../server/src/routes/api/linkCheck.js#L52) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:177](../server/src/routes/api/linkCheck.js#L177) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:162](../server/src/routes/api/linkCheck.js#L162) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:150](../server/src/routes/api/linkCheck.js#L150) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:187](../server/src/routes/api/linkCheck.js#L187) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:139](../server/src/routes/api/linkCheck.js#L139) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:203](../server/src/routes/api/linkCheck.js#L203) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:268](../server/src/routes/api/linkCheck.js#L268) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:216](../server/src/routes/api/linkCheck.js#L216) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:74](../server/src/routes/api/checksLogs.js#L74) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1562](../server/src/routes/api/toolsCapacity.js#L1562) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1526](../server/src/routes/api/toolsCapacity.js#L1526) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:125](../server/src/routes/api/partFaults.js#L125) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:194](../server/src/routes/api/partFaults.js#L194) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:149](../server/src/routes/api/partFaults.js#L149) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:209](../server/src/routes/api/partFaults.js#L209) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:163](../server/src/routes/api/partFaults.js#L163) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:181](../server/src/routes/api/partFaults.js#L181) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:171](../server/src/routes/api/partFaults.js#L171) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:48](../server/src/routes/api/pdu.js#L48) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:94](../server/src/routes/api/pdu.js#L94) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` | [server/src/routes/api/pdu.js:241](../server/src/routes/api/pdu.js#L241) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` | [server/src/routes/api/pdu.js:129](../server/src/routes/api/pdu.js#L129) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` | [server/src/routes/api/pdu.js:161](../server/src/routes/api/pdu.js#L161) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` | [server/src/routes/api/pdu.js:155](../server/src/routes/api/pdu.js#L155) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:123](../server/src/routes/api/pdu.js#L123) |
| POST | `/tools/pdu/devices` | 역할 `admin` | [server/src/routes/api/pdu.js:208](../server/src/routes/api/pdu.js#L208) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` | [server/src/routes/api/pdu.js:214](../server/src/routes/api/pdu.js#L214) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/pdu.js:224](../server/src/routes/api/pdu.js#L224) |
| POST | `/tools/pdu/intervals` | 역할 `admin` | [server/src/routes/api/pdu.js:202](../server/src/routes/api/pdu.js#L202) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:112](../server/src/routes/api/pdu.js#L112) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:101](../server/src/routes/api/pdu.js#L101) |
| POST | `/tools/pdu/test` | 역할 `admin` | [server/src/routes/api/pdu.js:185](../server/src/routes/api/pdu.js#L185) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` | [server/src/routes/api/pdu.js:88](../server/src/routes/api/pdu.js#L88) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:299](../server/src/routes/api/portalCheck.js#L299) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:186](../server/src/routes/api/portalCheck.js#L186) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:251](../server/src/routes/api/portalCheck.js#L251) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:219](../server/src/routes/api/portalCheck.js#L219) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:14](../server/src/routes/api/relaycheck.js#L14) |
| POST | `/tools/relaycheck/run` | 역할 `admin` | [server/src/routes/api/relaycheck.js:31](../server/src/routes/api/relaycheck.js#L31) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` | [server/src/routes/api/relaycheck.js:24](../server/src/routes/api/relaycheck.js#L24) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:31](../server/src/routes/api/relaytopo.js#L31) |
| PUT | `/tools/relaytopo` | 역할 `admin` | [server/src/routes/api/relaytopo.js:60](../server/src/routes/api/relaytopo.js#L60) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:116](../server/src/routes/api/relaytopo.js#L116) |
| GET | `/tools/relaytopo/export` | 역할 `admin` | [server/src/routes/api/relaytopo.js:87](../server/src/routes/api/relaytopo.js#L87) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` | [server/src/routes/api/relaytopo.js:107](../server/src/routes/api/relaytopo.js#L107) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:111](../server/src/routes/api/relaytopo.js#L111) |
| POST | `/tools/relaytopo/import` | 역할 `admin` | [server/src/routes/api/relaytopo.js:69](../server/src/routes/api/relaytopo.js#L69) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:100](../server/src/routes/api/relaytopo.js#L100) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` | [server/src/routes/api/relaytopo.js:125](../server/src/routes/api/relaytopo.js#L125) |
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
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:991](../server/src/routes/api/toolsCapacity.js#L991) |
| GET | `/tools/rma` | 역할 `admin` | [server/src/routes/api/rma.js:32](../server/src/routes/api/rma.js#L32) |
| PUT | `/tools/rma/agents/:agent/access` | 역할 `admin` | [server/src/routes/api/rma.js:89](../server/src/routes/api/rma.js#L89) |
| PUT | `/tools/rma/agents/:agent/mode` | 역할 `admin` | [server/src/routes/api/rma.js:168](../server/src/routes/api/rma.js#L168) |
| PUT | `/tools/rma/agents/:agent/password` | 역할 `admin` | [server/src/routes/api/rma.js:157](../server/src/routes/api/rma.js#L157) |
| PUT | `/tools/rma/agents/:agent/remote` | 역할 `admin` | [server/src/routes/api/rma.js:98](../server/src/routes/api/rma.js#L98) |
| GET | `/tools/rma/agents/:agent/schedule` | 역할 `admin` | [server/src/routes/api/rma.js:45](../server/src/routes/api/rma.js#L45) |
| PUT | `/tools/rma/agents/:agent/schedule` | 역할 `admin` | [server/src/routes/api/rma.js:48](../server/src/routes/api/rma.js#L48) |
| DELETE | `/tools/rma/agents/:agent/schedule/:id` | 역할 `admin` | [server/src/routes/api/rma.js:61](../server/src/routes/api/rma.js#L61) |
| POST | `/tools/rma/deploy` | 역할 `admin` | [server/src/routes/api/rma.js:205](../server/src/routes/api/rma.js#L205) |
| POST | `/tools/rma/deploy/list` | 역할 `admin` | [server/src/routes/api/rma.js:198](../server/src/routes/api/rma.js#L198) |
| POST | `/tools/rma/deploy/remove` | 역할 `admin` | [server/src/routes/api/rma.js:222](../server/src/routes/api/rma.js#L222) |
| GET | `/tools/rma/history` | 역할 `admin` | [server/src/routes/api/rma.js:152](../server/src/routes/api/rma.js#L152) |
| GET | `/tools/rma/jobs/:reqId` | 역할 `admin` | [server/src/routes/api/rma.js:148](../server/src/routes/api/rma.js#L148) |
| POST | `/tools/rma/run` | 역할 `admin` | [server/src/routes/api/rma.js:109](../server/src/routes/api/rma.js#L109) |
| PUT | `/tools/rma/settings` | 역할 `admin` | [server/src/routes/api/rma.js:177](../server/src/routes/api/rma.js#L177) |
| GET | `/tools/rma/tests/history` | 역할 `admin` | [server/src/routes/api/rma.js:84](../server/src/routes/api/rma.js#L84) |
| GET | `/tools/rma/tests/results` | 역할 `admin` | [server/src/routes/api/rma.js:73](../server/src/routes/api/rma.js#L73) |
| POST | `/tools/rma/tests/validate` | 역할 `admin` | [server/src/routes/api/rma.js:68](../server/src/routes/api/rma.js#L68) |
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:91](../server/src/routes/api/sanSwitch.js#L91) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:669](../server/src/routes/api/sanSwitch.js#L669) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:689](../server/src/routes/api/sanSwitch.js#L689) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:195](../server/src/routes/api/sanSwitch.js#L195) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:203](../server/src/routes/api/sanSwitch.js#L203) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:252](../server/src/routes/api/sanSwitch.js#L252) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:477](../server/src/routes/api/sanSwitch.js#L477) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:465](../server/src/routes/api/sanSwitch.js#L465) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:386](../server/src/routes/api/sanSwitch.js#L386) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:420](../server/src/routes/api/sanSwitch.js#L420) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:531](../server/src/routes/api/sanSwitch.js#L531) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:541](../server/src/routes/api/sanSwitch.js#L541) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:121](../server/src/routes/api/sanSwitch.js#L121) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:147](../server/src/routes/api/sanSwitch.js#L147) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:758](../server/src/routes/api/sanSwitch.js#L758) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:766](../server/src/routes/api/sanSwitch.js#L766) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:849](../server/src/routes/api/sanSwitch.js#L849) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:794](../server/src/routes/api/sanSwitch.js#L794) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:837](../server/src/routes/api/sanSwitch.js#L837) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:774](../server/src/routes/api/sanSwitch.js#L774) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:780](../server/src/routes/api/sanSwitch.js#L780) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:431](../server/src/routes/api/sanSwitch.js#L431) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:488](../server/src/routes/api/sanSwitch.js#L488) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:316](../server/src/routes/api/sanSwitch.js#L316) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:299](../server/src/routes/api/sanSwitch.js#L299) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:276](../server/src/routes/api/sanSwitch.js#L276) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:284](../server/src/routes/api/sanSwitch.js#L284) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:558](../server/src/routes/api/sanSwitch.js#L558) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:709](../server/src/routes/api/sanSwitch.js#L709) |
| POST | `/tools/sanswitch/test` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:219](../server/src/routes/api/sanSwitch.js#L219) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:241](../server/src/routes/api/sanSwitch.js#L241) |
| GET | `/tools/secret-scan` | 역할 `admin` | [server/src/routes/api/toolsInfo.js:30](../server/src/routes/api/toolsInfo.js#L30) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:35](../server/src/routes/api/serialLookup.js#L35) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:58](../server/src/routes/api/serialLookup.js#L58) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:64](../server/src/routes/api/checksLogs.js#L64) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:146](../server/src/routes/api/vcTools.js#L146) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:59](../server/src/routes/api/vcTools.js#L59) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:42](../server/src/routes/api/storageMon.js#L42) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:548](../server/src/routes/api/storageMon.js#L548) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:608](../server/src/routes/api/storageMon.js#L608) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:620](../server/src/routes/api/storageMon.js#L620) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:628](../server/src/routes/api/storageMon.js#L628) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:170](../server/src/routes/api/storageMon.js#L170) |
| POST | `/tools/storage/collect-all` | 역할 `admin` | [server/src/routes/api/storageMon.js:179](../server/src/routes/api/storageMon.js#L179) |
| POST | `/tools/storage/devices` | 역할 `admin` | [server/src/routes/api/storageMon.js:148](../server/src/routes/api/storageMon.js#L148) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` | [server/src/routes/api/storageMon.js:158](../server/src/routes/api/storageMon.js#L158) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` | [server/src/routes/api/storageMon.js:486](../server/src/routes/api/storageMon.js#L486) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` | [server/src/routes/api/storageMon.js:491](../server/src/routes/api/storageMon.js#L491) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/storageMon.js:204](../server/src/routes/api/storageMon.js#L204) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:526](../server/src/routes/api/storageMon.js#L526) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` | [server/src/routes/api/storageMon.js:292](../server/src/routes/api/storageMon.js#L292) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` | [server/src/routes/api/storageMon.js:316](../server/src/routes/api/storageMon.js#L316) |
| POST | `/tools/storage/devices/import` | 역할 `admin` | [server/src/routes/api/storageMon.js:339](../server/src/routes/api/storageMon.js#L339) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` | [server/src/routes/api/storageMon.js:422](../server/src/routes/api/storageMon.js#L422) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` | [server/src/routes/api/storageMon.js:479](../server/src/routes/api/storageMon.js#L479) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` | [server/src/routes/api/storageMon.js:307](../server/src/routes/api/storageMon.js#L307) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` | [server/src/routes/api/storageMon.js:324](../server/src/routes/api/storageMon.js#L324) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:639](../server/src/routes/api/storageMon.js#L639) |
| GET | `/tools/storage/intervals` | 역할 `admin` | [server/src/routes/api/storageMon.js:232](../server/src/routes/api/storageMon.js#L232) |
| PUT | `/tools/storage/intervals` | 역할 `admin` | [server/src/routes/api/storageMon.js:250](../server/src/routes/api/storageMon.js#L250) |
| POST | `/tools/storage/test` | 역할 `admin` | [server/src/routes/api/storageMon.js:96](../server/src/routes/api/storageMon.js#L96) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1039](../server/src/routes/api/toolsCapacity.js#L1039) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:98](../server/src/routes/api/toolsAnalytics.js#L98) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:172](../server/src/routes/api/checksLogs.js#L172) |
| GET | `/tools/vclogs/export.csv` | 권한 `tools` | [server/src/routes/api/checksLogs.js:182](../server/src/routes/api/checksLogs.js#L182) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:159](../server/src/routes/api/checksLogs.js#L159) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:150](../server/src/routes/api/checksLogs.js#L150) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:133](../server/src/routes/api/checksLogs.js#L133) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:20](../server/src/routes/api/vmClone.js#L20) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:67](../server/src/routes/api/vmClone.js#L67) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:29](../server/src/routes/api/vmClone.js#L29) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:41](../server/src/routes/api/vmClone.js#L41) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:52](../server/src/routes/api/vmClone.js#L52) |
| GET | `/tools/vm-export` | 권한 `tools` | [server/src/routes/api/ipamExport.js:105](../server/src/routes/api/ipamExport.js#L105) |
| GET | `/tools/vm-export.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:114](../server/src/routes/api/ipamExport.js#L114) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1067](../server/src/routes/api/toolsCapacity.js#L1067) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:17](../server/src/routes/api/vmtrack.js#L17) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:46](../server/src/routes/api/vmtrack.js#L46) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:123](../server/src/routes/api/vmtrack.js#L123) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:60](../server/src/routes/api/vmtrack.js#L60) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:74](../server/src/routes/api/vmtrack.js#L74) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:140](../server/src/routes/api/vmtrack.js#L140) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:86](../server/src/routes/api/vmtrack.js#L86) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:101](../server/src/routes/api/vmtrack.js#L101) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:161](../server/src/routes/api/vmtrack.js#L161) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:178](../server/src/routes/api/vmtrack.js#L178) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:198](../server/src/routes/api/vmSeries.js#L198) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:162](../server/src/routes/api/vmSeries.js#L162) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:156](../server/src/routes/api/vmSeries.js#L156) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:139](../server/src/routes/api/vmSeries.js#L139) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:85](../server/src/routes/api/vmSeries.js#L85) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:103](../server/src/routes/api/vmSeries.js#L103) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:151](../server/src/routes/api/vmSeries.js#L151) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:176](../server/src/routes/api/vmSeries.js#L176) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:123](../server/src/routes/api/vcTools.js#L123) |
| GET | `/tools/vmware-config` | 권한 `tools` | [server/src/routes/api/checksLogs.js:81](../server/src/routes/api/checksLogs.js#L81) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:215](../server/src/routes/api/toolsCapacity.js#L215) |
| GET | `/tools/waste/export` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:394](../server/src/routes/api/toolsCapacity.js#L394) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:578](../server/src/routes/api/toolsCapacity.js#L578) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:552](../server/src/routes/api/toolsCapacity.js#L552) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:563](../server/src/routes/api/toolsCapacity.js#L563) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:558](../server/src/routes/api/toolsCapacity.js#L558) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:357](../server/src/routes/api/toolsCapacity.js#L357) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:808](../server/src/routes/api/toolsCapacity.js#L808) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:829](../server/src/routes/api/toolsCapacity.js#L829) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:865](../server/src/routes/api/toolsCapacity.js#L865) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:897](../server/src/routes/api/toolsCapacity.js#L897) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:385](../server/src/routes/api/inventory.js#L385) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:243](../server/src/routes/api/toolsInfo.js#L243) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:245](../server/src/routes/api/toolsInfo.js#L245) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:12](../server/src/routes/api/vcTools.js#L12) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:666](../server/src/routes/api/toolsCapacity.js#L666) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:245](../server/src/routes/api/inventory.js#L245) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:134](../server/src/routes/api/vmMetrics.js#L134) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:76](../server/src/routes/api/vmMetrics.js#L76) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:318](../server/src/routes/api/inventory.js#L318) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:198](../server/src/routes/api/toolsInfo.js#L198) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:260](../server/src/routes/api/toolsCapacity.js#L260) |

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
| `fullScopeOnly` | 63 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `requireSettingsOwner` | 34 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `guarded` | 8 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `authMiddleware` | 7 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
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

