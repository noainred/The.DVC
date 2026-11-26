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
| 엔드포인트 | **1644개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 165개 |
| GET | 872개 |
| POST | 520개 |
| PUT | 162개 |
| PATCH | 3개 |
| DELETE | 87개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 33 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 19 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 70 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 10 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 20 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 70 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 384 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 11 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 16 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 21 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 984 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:164](../server/src/routes/collector.js#L164) |
| GET | `/bm-usage/baseline` | `tokenFirst` | [server/src/routes/collector.js:320](../server/src/routes/collector.js#L320) |
| GET | `/bm-usage/capacity` | `tokenFirst` | [server/src/routes/collector.js:355](../server/src/routes/collector.js#L355) |
| GET | `/bm-usage/changes` | `tokenFirst` | [server/src/routes/collector.js:319](../server/src/routes/collector.js#L319) |
| GET | `/bm-usage/compare` | `tokenFirst` | [server/src/routes/collector.js:321](../server/src/routes/collector.js#L321) |
| GET | `/bm-usage/compare-series` | `tokenFirst` | [server/src/routes/collector.js:323](../server/src/routes/collector.js#L323) |
| GET | `/bm-usage/devices` | — | [server/src/routes/collector.js:202](../server/src/routes/collector.js#L202) |
| GET | `/bm-usage/focus` | `tokenFirst` | [server/src/routes/collector.js:299](../server/src/routes/collector.js#L299) |
| POST | `/bm-usage/focus` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:271](../server/src/routes/collector.js#L271) |
| POST | `/bm-usage/focus/stop` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:288](../server/src/routes/collector.js#L288) |
| GET | `/bm-usage/logs` | `tokenFirst` | [server/src/routes/collector.js:340](../server/src/routes/collector.js#L340) |
| GET | `/bm-usage/nics` | — | [server/src/routes/collector.js:203](../server/src/routes/collector.js#L203) |
| POST | `/bm-usage/peer-avg` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:326](../server/src/routes/collector.js#L326) |
| GET | `/bm-usage/snapshot` | `tokenFirst` | [server/src/routes/collector.js:246](../server/src/routes/collector.js#L246) |
| POST | `/bm-usage/snapshot` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:218](../server/src/routes/collector.js#L218) |
| GET | `/bm-usage/snapshots` | `tokenFirst` | [server/src/routes/collector.js:237](../server/src/routes/collector.js#L237) |
| GET | `/bm-usage/top` | `tokenFirst` | [server/src/routes/collector.js:372](../server/src/routes/collector.js#L372) |
| GET | `/bm-usage/top/band` | `tokenFirst` | [server/src/routes/collector.js:384](../server/src/routes/collector.js#L384) |
| GET | `/bm-usage/trend` | — | [server/src/routes/collector.js:201](../server/src/routes/collector.js#L201) |
| POST | `/bmstor-collect` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:526](../server/src/routes/collector.js#L526) |
| POST | `/central-token` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:465](../server/src/routes/collector.js#L465) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:135](../server/src/routes/collector.js#L135) |
| GET | `/export` | — | [server/src/routes/collector.js:64](../server/src/routes/collector.js#L64) |
| POST | `/focus-mon/wake` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:267](../server/src/routes/collector.js#L267) |
| POST | `/idrac-scan` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:480](../server/src/routes/collector.js#L480) |
| POST | `/isidu-run` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:512](../server/src/routes/collector.js#L512) |
| POST | `/isidu-test` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:515](../server/src/routes/collector.js#L515) |
| GET | `/ping` | — | [server/src/routes/collector.js:116](../server/src/routes/collector.js#L116) |
| POST | `/set-password` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:447](../server/src/routes/collector.js#L447) |
| GET | `/token-check` | — | [server/src/routes/collector.js:410](../server/src/routes/collector.js#L410) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:550](../server/src/routes/collector.js#L550) |
| GET | `/xfer-test` | — | [server/src/routes/collector.js:432](../server/src/routes/collector.js#L432) |
| POST | `/xfer-test` | — | [server/src/routes/collector.js:438](../server/src/routes/collector.js#L438) |

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
| GET | `/anomalies` | — | [server/src/routes/insights.js:586](../server/src/routes/insights.js#L586) |
| POST | `/chatops` | — | [server/src/routes/insights.js:661](../server/src/routes/insights.js#L661) |
| GET | `/finops` | — | [server/src/routes/insights.js:140](../server/src/routes/insights.js#L140) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:163](../server/src/routes/insights.js#L163) |
| PUT | `/finops/config` | 역할 `admin` · `fleetOnly` | [server/src/routes/insights.js:194](../server/src/routes/insights.js#L194) |
| GET | `/fleet` | — | [server/src/routes/insights.js:203](../server/src/routes/insights.js#L203) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` · `textFields` | [server/src/routes/insights.js:442](../server/src/routes/insights.js#L442) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` · `textFields` | [server/src/routes/insights.js:458](../server/src/routes/insights.js#L458) |
| GET | `/fleet/hardware-export` | 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:370](../server/src/routes/insights.js#L370) |
| GET | `/fleet/hardware-meta` | 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:347](../server/src/routes/insights.js#L347) |
| PUT | `/fleet/hardware-prefs` | 역할 `admin/operator` · 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:362](../server/src/routes/insights.js#L362) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:508](../server/src/routes/insights.js#L508) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` · `textFields` | [server/src/routes/insights.js:413](../server/src/routes/insights.js#L413) |
| GET | `/forecast` | — | [server/src/routes/insights.js:607](../server/src/routes/insights.js#L607) |
| GET | `/graph` | — | [server/src/routes/insights.js:640](../server/src/routes/insights.js#L640) |
| GET | `/incidents` | — | [server/src/routes/insights.js:655](../server/src/routes/insights.js#L655) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:166](../server/src/routes/insights.js#L166) |
| GET | `/security` | — | [server/src/routes/insights.js:620](../server/src/routes/insights.js#L620) |
| GET | `/topology` | — | [server/src/routes/insights.js:628](../server/src/routes/insights.js#L628) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:237](../server/src/routes/central/opsRoutes.js#L237) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:492](../server/src/routes/central.js#L492) |
| GET | `/bareos-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:178](../server/src/routes/central/opsRoutes.js#L178) |
| POST | `/bareos-op-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:200](../server/src/routes/central/opsRoutes.js#L200) |
| GET | `/bareos-ops` | `requireCentral` | [server/src/routes/central/opsRoutes.js:190](../server/src/routes/central/opsRoutes.js#L190) |
| GET | `/bm-folders` | `requireCentral` | [server/src/routes/central/storageRoutes.js:298](../server/src/routes/central/storageRoutes.js#L298) |
| GET | `/bm-maint` | `requireCentral` | [server/src/routes/central/storageRoutes.js:281](../server/src/routes/central/storageRoutes.js#L281) |
| GET | `/bm-onboard` | `requireCentral` | [server/src/routes/central/storageRoutes.js:260](../server/src/routes/central/storageRoutes.js#L260) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:349](../server/src/routes/central/opsRoutes.js#L349) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:354](../server/src/routes/central/opsRoutes.js#L354) |
| GET | `/bmusage-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:235](../server/src/routes/central/storageRoutes.js#L235) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:653](../server/src/routes/central.js#L653) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:300](../server/src/routes/central/opsRoutes.js#L300) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:305](../server/src/routes/central/opsRoutes.js#L305) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:1281](../server/src/routes/central.js#L1281) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:1379](../server/src/routes/central.js#L1379) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:22](../server/src/routes/central/cvpIsiduRoutes.js#L22) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:51](../server/src/routes/central/cvpIsiduRoutes.js#L51) |
| POST | `/disk-bad` | `requireCentral` | [server/src/routes/central/storageRoutes.js:163](../server/src/routes/central/storageRoutes.js#L163) |
| GET | `/disk-bad-job` | `requireCentral` | [server/src/routes/central/storageRoutes.js:149](../server/src/routes/central/storageRoutes.js#L149) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central/storageRoutes.js:187](../server/src/routes/central/storageRoutes.js#L187) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central/storageRoutes.js:194](../server/src/routes/central/storageRoutes.js#L194) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:1418](../server/src/routes/central.js#L1418) |
| POST | `/focus-mon/sync` | `requireCentral` | [server/src/routes/central.js:639](../server/src/routes/central.js#L639) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1654](../server/src/routes/central.js#L1654) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1571](../server/src/routes/central.js#L1571) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:1139](../server/src/routes/central.js#L1139) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central/opsRoutes.js:472](../server/src/routes/central/opsRoutes.js#L472) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1491](../server/src/routes/central.js#L1491) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1501](../server/src/routes/central.js#L1501) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1513](../server/src/routes/central.js#L1513) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:991](../server/src/routes/central.js#L991) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central/opsRoutes.js:378](../server/src/routes/central/opsRoutes.js#L378) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:397](../server/src/routes/central/opsRoutes.js#L397) |
| GET | `/isidu-config` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:157](../server/src/routes/central/cvpIsiduRoutes.js#L157) |
| POST | `/isidu-data` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:179](../server/src/routes/central/cvpIsiduRoutes.js#L179) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central/opsRoutes.js:486](../server/src/routes/central/opsRoutes.js#L486) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:517](../server/src/routes/central/opsRoutes.js#L517) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central/opsRoutes.js:272](../server/src/routes/central/opsRoutes.js#L272) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:280](../server/src/routes/central/opsRoutes.js#L280) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central/storageRoutes.js:120](../server/src/routes/central/storageRoutes.js#L120) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:224](../server/src/routes/central/storageRoutes.js#L224) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:39](../server/src/routes/central/pduSanRoutes.js#L39) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:70](../server/src/routes/central/pduSanRoutes.js#L70) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:210](../server/src/routes/central/opsRoutes.js#L210) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:218](../server/src/routes/central/opsRoutes.js#L218) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:505](../server/src/routes/central.js#L505) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:587](../server/src/routes/central.js#L587) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:307](../server/src/routes/central/pduSanRoutes.js#L307) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:243](../server/src/routes/central/pduSanRoutes.js#L243) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:330](../server/src/routes/central/pduSanRoutes.js#L330) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:106](../server/src/routes/central/pduSanRoutes.js#L106) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:344](../server/src/routes/central/pduSanRoutes.js#L344) |
| POST | `/sanswitch-flow-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:212](../server/src/routes/central/pduSanRoutes.js#L212) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:141](../server/src/routes/central/pduSanRoutes.js#L141) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:200](../server/src/routes/central/pduSanRoutes.js#L200) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:90](../server/src/routes/central/storageRoutes.js#L90) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central/storageRoutes.js:314](../server/src/routes/central/storageRoutes.js#L314) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:696](../server/src/routes/central.js#L696) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:713](../server/src/routes/central.js#L713) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:611](../server/src/routes/central.js#L611) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:143](../server/src/routes/central/opsRoutes.js#L143) |
| GET | `/veeam-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:97](../server/src/routes/central/opsRoutes.js#L97) |
| POST | `/veeam-data` | `requireCentral` | [server/src/routes/central/opsRoutes.js:112](../server/src/routes/central/opsRoutes.js#L112) |
| GET | `/veeam-run-ops` | `requireCentral` | [server/src/routes/central/opsRoutes.js:158](../server/src/routes/central/opsRoutes.js#L158) |
| POST | `/veeam-run-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:168](../server/src/routes/central/opsRoutes.js#L168) |
| POST | `/vm-clone-report` | `requireCentral` | [server/src/routes/central/opsRoutes.js:336](../server/src/routes/central/opsRoutes.js#L336) |
| GET | `/vm-clone-sync` | `requireCentral` | [server/src/routes/central/opsRoutes.js:320](../server/src/routes/central/opsRoutes.js#L320) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:1221](../server/src/routes/central.js#L1221) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:1403](../server/src/routes/central.js#L1403) |

## `/api/upgrade`

자동 업그레이드 제어(번들 수신·적용).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/apply` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:170](../server/src/routes/upgrade.js#L170) |
| POST | `/bundle` | 역할 `admin` · `fullScopeOnlyWith` · `express.raw` | [server/src/routes/upgrade.js:272](../server/src/routes/upgrade.js#L272) |
| POST | `/check` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:164](../server/src/routes/upgrade.js#L164) |
| GET | `/detect-install` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:189](../server/src/routes/upgrade.js#L189) |
| POST | `/edge-sync` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:262](../server/src/routes/upgrade.js#L262) |
| POST | `/restart` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:178](../server/src/routes/upgrade.js#L178) |
| GET | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:184](../server/src/routes/upgrade.js#L184) |
| PUT | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:199](../server/src/routes/upgrade.js#L199) |
| PUT | `/signature-override` | 역할 `admin` · `fullScopeOnlyWith` · `requireSettingsOwner` | [server/src/routes/upgrade.js:231](../server/src/routes/upgrade.js#L231) |
| GET | `/status` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:159](../server/src/routes/upgrade.js#L159) |

## `/api/remote`

원격 접속(HAProxy/SSH/RDP 중계).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:193](../server/src/routes/remote.js#L193) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:209](../server/src/routes/remote.js#L209) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:412](../server/src/routes/remote.js#L412) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:376](../server/src/routes/remote.js#L376) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:73](../server/src/routes/remote.js#L73) |
| POST | `/mappings` | 역할 `admin` · `textFields` | [server/src/routes/remote.js:435](../server/src/routes/remote.js#L435) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:551](../server/src/routes/remote.js#L551) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:540](../server/src/routes/remote.js#L540) |
| POST | `/probe` | 권한 `remote.access` · `textFields` | [server/src/routes/remote.js:126](../server/src/routes/remote.js#L126) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:160](../server/src/routes/remote.js#L160) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:285](../server/src/routes/remote.js#L285) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:313](../server/src/routes/remote.js#L313) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:332](../server/src/routes/remote.js#L332) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:218](../server/src/routes/remote.js#L218) |
| POST | `/quick-connect` | 권한 `remote.access` · `textFields` | [server/src/routes/remote.js:486](../server/src/routes/remote.js#L486) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:41](../server/src/routes/remote.js#L41) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:567](../server/src/routes/remote.js#L567) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:176](../server/src/routes/remote.js#L176) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:356](../server/src/routes/remote.js#L356) |
| POST | `/ws-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:64](../server/src/routes/remote.js#L64) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alert-settings` | 역할 `admin/operator` | [server/src/routes/svcmon/settingsSync.js:237](../server/src/routes/svcmon/settingsSync.js#L237) |
| PUT | `/alert-settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:243](../server/src/routes/svcmon/settingsSync.js#L243) |
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:32](../server/src/routes/svcmon/edge.js#L32) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:112](../server/src/routes/svcmon/edge.js#L112) |
| PUT | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:67](../server/src/routes/svcmon/edge.js#L67) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:174](../server/src/routes/svcmon/generate.js#L174) |
| DELETE | `/batches/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:189](../server/src/routes/svcmon/generate.js#L189) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:176](../server/src/routes/svcmon/generate.js#L176) |
| POST | `/config-pull-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:120](../server/src/routes/svcmon/edge.js#L120) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:116](../server/src/routes/svcmon/overview.js#L116) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:142](../server/src/routes/svcmon/edge.js#L142) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:129](../server/src/routes/svcmon/edge.js#L129) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:173](../server/src/routes/svcmon/edge.js#L173) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:157](../server/src/routes/svcmon/edge.js#L157) |
| POST | `/flush` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:144](../server/src/routes/svcmon/overview.js#L144) |
| POST | `/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:24](../server/src/routes/svcmon/tree.js#L24) |
| POST | `/folders/delete` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:58](../server/src/routes/svcmon/tree.js#L58) |
| POST | `/folders/move` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:40](../server/src/routes/svcmon/tree.js#L40) |
| PUT | `/folders/rename` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:32](../server/src/routes/svcmon/tree.js#L32) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:44](../server/src/routes/svcmon/logs.js#L44) |
| PUT | `/log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:48](../server/src/routes/svcmon/logs.js#L48) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:100](../server/src/routes/svcmon/logs.js#L100) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:71](../server/src/routes/svcmon/logs.js#L71) |
| POST | `/log/prune` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/logs.js:124](../server/src/routes/svcmon/logs.js#L124) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:84](../server/src/routes/svcmon/logs.js#L84) |
| GET | `/overview` | — | [server/src/routes/svcmon/settingsSync.js:218](../server/src/routes/svcmon/settingsSync.js#L218) |
| POST | `/push-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:181](../server/src/routes/svcmon/edge.js#L181) |
| POST | `/refresh` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:127](../server/src/routes/svcmon/overview.js#L127) |
| PUT | `/reorder/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:53](../server/src/routes/svcmon/tree.js#L53) |
| PUT | `/reorder/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:48](../server/src/routes/svcmon/tree.js#L48) |
| POST | `/settings-sync/ack` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:202](../server/src/routes/svcmon/settingsSync.js#L202) |
| POST | `/settings-sync/apply` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:145](../server/src/routes/svcmon/settingsSync.js#L145) |
| GET | `/settings-sync/catalog` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:102](../server/src/routes/svcmon/settingsSync.js#L102) |
| POST | `/settings-sync/detach/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:209](../server/src/routes/svcmon/settingsSync.js#L209) |
| PUT | `/settings-sync/options` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:190](../server/src/routes/svcmon/settingsSync.js#L190) |
| POST | `/settings-sync/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:136](../server/src/routes/svcmon/settingsSync.js#L136) |
| POST | `/settings-sync/repath` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:169](../server/src/routes/svcmon/settingsSync.js#L169) |
| POST | `/silence-check` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:188](../server/src/routes/svcmon/edge.js#L188) |
| PUT | `/sort` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:68](../server/src/routes/svcmon/tree.js#L68) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:52](../server/src/routes/svcmon/overview.js#L52) |
| POST | `/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:74](../server/src/routes/svcmon/tree.js#L74) |
| DELETE | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:111](../server/src/routes/svcmon/tree.js#L111) |
| PUT | `/targets/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:101](../server/src/routes/svcmon/tree.js#L101) |
| POST | `/targets/:id/tests` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:118](../server/src/routes/svcmon/tree.js#L118) |
| DELETE | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:136](../server/src/routes/svcmon/tree.js#L136) |
| PUT | `/targets/:id/tests/:testId` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:127](../server/src/routes/svcmon/tree.js#L127) |
| POST | `/targets/:id/tests/:testId/run` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/trial.js:73](../server/src/routes/svcmon/trial.js#L73) |
| POST | `/targets/bulk` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:82](../server/src/routes/svcmon/tree.js#L82) |
| GET | `/targets/csv-schema` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:141](../server/src/routes/svcmon/transfer.js#L141) |
| POST | `/targets/enabled` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/trial.js:24](../server/src/routes/svcmon/trial.js#L24) |
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
| POST | `/trial` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/trial.js:58](../server/src/routes/svcmon/trial.js#L58) |
| GET | `/trial/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/trial.js:86](../server/src/routes/svcmon/trial.js#L86) |

## `/api/admin`

설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-deploy` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/deployLlm.js:128](../server/src/routes/admin/deployLlm.js#L128) |
| GET | `/agent-deploy/bulk` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:381](../server/src/routes/admin/deployLlm.js#L381) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:382](../server/src/routes/admin/deployLlm.js#L382) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:387](../server/src/routes/admin/deployLlm.js#L387) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:331](../server/src/routes/admin/deployLlm.js#L331) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:336](../server/src/routes/admin/deployLlm.js#L336) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:353](../server/src/routes/admin/deployLlm.js#L353) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:398](../server/src/routes/admin/deployLlm.js#L398) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:473](../server/src/routes/admin/deployLlm.js#L473) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:416](../server/src/routes/admin/deployLlm.js#L416) |
| GET | `/agent-deploy/defaults` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:114](../server/src/routes/admin/deployLlm.js#L114) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:287](../server/src/routes/admin/deployLlm.js#L287) |
| GET | `/agent-deploy/installer` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:112](../server/src/routes/admin/deployLlm.js#L112) |
| GET | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:155](../server/src/routes/admin/deployLlm.js#L155) |
| POST | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:164](../server/src/routes/admin/deployLlm.js#L164) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:185](../server/src/routes/admin/deployLlm.js#L185) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:267](../server/src/routes/admin/deployLlm.js#L267) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:278](../server/src/routes/admin/deployLlm.js#L278) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:196](../server/src/routes/admin/deployLlm.js#L196) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:565](../server/src/routes/admin/deployLlm.js#L565) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` · `csvPerm` · `fleetOnly` · `textFields` | [server/src/routes/admin/deployLlm.js:234](../server/src/routes/admin/deployLlm.js#L234) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:210](../server/src/routes/admin/deployLlm.js#L210) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:578](../server/src/routes/admin/deployLlm.js#L578) |
| POST | `/agent-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:124](../server/src/routes/admin/deployLlm.js#L124) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:131](../server/src/routes/admin/opsSettings.js#L131) |
| PUT | `/alerts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:132](../server/src/routes/admin/opsSettings.js#L132) |
| POST | `/alerts/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:146](../server/src/routes/admin/opsSettings.js#L146) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:181](../server/src/routes/admin/opsSettings.js#L181) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:182](../server/src/routes/admin/opsSettings.js#L182) |
| GET | `/api-keys` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/apiKeys.js:35](../server/src/routes/admin/apiKeys.js#L35) |
| POST | `/api-keys` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `textFields` | [server/src/routes/admin/apiKeys.js:69](../server/src/routes/admin/apiKeys.js#L69) |
| DELETE | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:106](../server/src/routes/admin/apiKeys.js#L106) |
| PATCH | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:87](../server/src/routes/admin/apiKeys.js#L87) |
| POST | `/api-keys/:id/revoke` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:98](../server/src/routes/admin/apiKeys.js#L98) |
| GET | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:196](../server/src/routes/admin/horizonAssign.js#L196) |
| POST | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:204](../server/src/routes/admin/horizonAssign.js#L204) |
| DELETE | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:214](../server/src/routes/admin/horizonAssign.js#L214) |
| PUT | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:209](../server/src/routes/admin/horizonAssign.js#L209) |
| POST | `/assignments/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:221](../server/src/routes/admin/horizonAssign.js#L221) |
| GET | `/audit` | 역할 `admin` · `auditFullScope` | [server/src/routes/admin/opsSettings.js:113](../server/src/routes/admin/opsSettings.js#L113) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:213](../server/src/routes/admin/backupNetSec.js#L213) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:181](../server/src/routes/admin/backupNetSec.js#L181) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:176](../server/src/routes/admin/backupNetSec.js#L176) |
| POST | `/backup/restore-staged/cancel` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:206](../server/src/routes/admin/backupNetSec.js#L206) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:214](../server/src/routes/admin/backupNetSec.js#L214) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:171](../server/src/routes/admin/backupNetSec.js#L171) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:168](../server/src/routes/admin/backupNetSec.js#L168) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:194](../server/src/routes/admin/backupNetSec.js#L194) |
| GET | `/bm-assets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmAssets.js:27](../server/src/routes/admin/bmAssets.js#L27) |
| GET | `/bm-assets.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/bmAssets.js:34](../server/src/routes/admin/bmAssets.js#L34) |
| POST | `/bm-assets/import` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` · `textFields` | [server/src/routes/admin/bmAssets.js:51](../server/src/routes/admin/bmAssets.js#L51) |
| GET | `/bm-assets/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/bmAssets.js:43](../server/src/routes/admin/bmAssets.js#L43) |
| GET | `/bm-fw-baseline` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmAssets.js:80](../server/src/routes/admin/bmAssets.js#L80) |
| POST | `/bm-fw-baseline` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/bmAssets.js:90](../server/src/routes/admin/bmAssets.js#L90) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:27](../server/src/routes/admin/centralTokens.js#L27) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:60](../server/src/routes/admin/centralTokens.js#L60) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:51](../server/src/routes/admin/centralTokens.js#L51) |
| GET | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:73](../server/src/routes/admin/centralTokens.js#L73) |
| POST | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `textFields` | [server/src/routes/admin/centralTokens.js:77](../server/src/routes/admin/centralTokens.js#L77) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:104](../server/src/routes/admin/centralTokens.js#L104) |
| POST | `/central/agent-tokens/:agent/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:85](../server/src/routes/admin/centralTokens.js#L85) |
| GET | `/central/ingest-stats` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:47](../server/src/routes/admin/centralTokens.js#L47) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:48](../server/src/routes/admin/centralTokens.js#L48) |
| GET | `/central/inventory` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:29](../server/src/routes/admin/centralTokens.js#L29) |
| POST | `/central/inventory/owner` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/centralTokens.js:34](../server/src/routes/admin/centralTokens.js#L34) |
| GET | `/central/token-apply/jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:95](../server/src/routes/admin/centralTokens.js#L95) |
| GET | `/central/token-apply/jobs/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:99](../server/src/routes/admin/centralTokens.js#L99) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:164](../server/src/routes/admin/opsSettings.js#L164) |
| GET | `/codex-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:31](../server/src/routes/admin/statusTools.js#L31) |
| GET | `/codex-check/file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:34](../server/src/routes/admin/statusTools.js#L34) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:37](../server/src/routes/admin/statusTools.js#L37) |
| GET | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:209](../server/src/routes/admin/collectorsDc.js#L209) |
| POST | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:229](../server/src/routes/admin/collectorsDc.js#L229) |
| DELETE | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:274](../server/src/routes/admin/collectorsDc.js#L274) |
| PUT | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:237](../server/src/routes/admin/collectorsDc.js#L237) |
| PUT | `/collectors/:id/datacenter` | 역할 `admin` · `fullReadWriteScopeOnlyWith` | [server/src/routes/admin/collectorsDc.js:256](../server/src/routes/admin/collectorsDc.js#L256) |
| POST | `/collectors/:id/force-token` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:686](../server/src/routes/admin/collectorsDc.js#L686) |
| GET | `/collectors/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:293](../server/src/routes/admin/collectorsDc.js#L293) |
| POST | `/collectors/import` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` · `textFields` | [server/src/routes/admin/collectorsDc.js:322](../server/src/routes/admin/collectorsDc.js#L322) |
| POST | `/collectors/pull` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:580](../server/src/routes/admin/collectorsDc.js#L580) |
| GET | `/collectors/sample.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/collectorsDc.js:308](../server/src/routes/admin/collectorsDc.js#L308) |
| POST | `/collectors/set-password` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `textFields` | [server/src/routes/admin/collectorsDc.js:385](../server/src/routes/admin/collectorsDc.js#L385) |
| POST | `/collectors/test` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/collectorsDc.js:608](../server/src/routes/admin/collectorsDc.js#L608) |
| POST | `/collectors/upgrade` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:587](../server/src/routes/admin/collectorsDc.js#L587) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:60](../server/src/routes/admin/vcenters.js#L60) |
| PUT | `/data-source` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:65](../server/src/routes/admin/vcenters.js#L65) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:483](../server/src/routes/admin/collectorsDc.js#L483) |
| PUT | `/datacenter-order` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:493](../server/src/routes/admin/collectorsDc.js#L493) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:444](../server/src/routes/admin/collectorsDc.js#L444) |
| POST | `/datacenters` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/collectorsDc.js:455](../server/src/routes/admin/collectorsDc.js#L455) |
| DELETE | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:477](../server/src/routes/admin/collectorsDc.js#L477) |
| PUT | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:472](../server/src/routes/admin/collectorsDc.js#L472) |
| PUT | `/datacenters/assign` | 역할 `admin` · `fullReadWriteScopeOnlyWith` | [server/src/routes/admin/collectorsDc.js:463](../server/src/routes/admin/collectorsDc.js#L463) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:394](../server/src/routes/admin/backupNetSec.js#L394) |
| GET | `/dir-usage` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:31](../server/src/routes/admin/dirUsage.js#L31) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:48](../server/src/routes/admin/dirUsage.js#L48) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:71](../server/src/routes/admin/dirUsage.js#L71) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:94](../server/src/routes/admin/dirUsage.js#L94) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/dirUsage.js:63](../server/src/routes/admin/dirUsage.js#L63) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:79](../server/src/routes/admin/dirUsage.js#L79) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:334](../server/src/routes/admin/gpuGuest.js#L334) |
| GET | `/edge-users/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:320](../server/src/routes/admin/gpuGuest.js#L320) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `textFields` | [server/src/routes/admin/gpuGuest.js:329](../server/src/routes/admin/gpuGuest.js#L329) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:340](../server/src/routes/admin/gpuGuest.js#L340) |
| GET | `/edge-users/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:307](../server/src/routes/admin/gpuGuest.js#L307) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:51](../server/src/routes/admin/statusTools.js#L51) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:60](../server/src/routes/admin/statusTools.js#L60) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:91](../server/src/routes/admin/nsxImport.js#L91) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:289](../server/src/routes/admin/gpuGuest.js#L289) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:293](../server/src/routes/admin/gpuGuest.js#L293) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:271](../server/src/routes/admin/gpuGuest.js#L271) |
| GET | `/gpu-guest/diag` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:230](../server/src/routes/admin/gpuGuest.js#L230) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:188](../server/src/routes/admin/gpuGuest.js#L188) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:194](../server/src/routes/admin/gpuGuest.js#L194) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:467](../server/src/routes/admin/gpuGuest.js#L467) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` · `rawIpFleetOnly` · `textFields` | [server/src/routes/admin/gpuGuest.js:594](../server/src/routes/admin/gpuGuest.js#L594) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:236](../server/src/routes/admin/gpuGuest.js#L236) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:346](../server/src/routes/admin/gpuGuest.js#L346) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/gpuGuest.js:350](../server/src/routes/admin/gpuGuest.js#L350) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:360](../server/src/routes/admin/gpuGuest.js#L360) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:355](../server/src/routes/admin/gpuGuest.js#L355) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/gpuGuest.js:369](../server/src/routes/admin/gpuGuest.js#L369) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/gpuGuest.js:397](../server/src/routes/admin/gpuGuest.js#L397) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:364](../server/src/routes/admin/gpuGuest.js#L364) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/gpuGuest.js:429](../server/src/routes/admin/gpuGuest.js#L429) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:161](../server/src/routes/admin/gpuGuest.js#L161) |
| POST | `/guest/add-user` | 역할 `admin` · `textFields` | [server/src/routes/admin/backupNetSec.js:368](../server/src/routes/admin/backupNetSec.js#L368) |
| GET | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:23](../server/src/routes/admin/horizonAssign.js#L23) |
| POST | `/horizon` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/horizonAssign.js:24](../server/src/routes/admin/horizonAssign.js#L24) |
| DELETE | `/horizon/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:29](../server/src/routes/admin/horizonAssign.js#L29) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:74](../server/src/routes/admin/horizonAssign.js#L74) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:82](../server/src/routes/admin/horizonAssign.js#L82) |
| POST | `/horizon/servers/import` | 역할 `admin` · `csvPerm` · `fleetOnly` · `textFields` | [server/src/routes/admin/horizonAssign.js:148](../server/src/routes/admin/horizonAssign.js#L148) |
| POST | `/horizon/servers/import/test` | 역할 `admin` · `csvPerm` · `fleetOnly` · `textFields` | [server/src/routes/admin/horizonAssign.js:106](../server/src/routes/admin/horizonAssign.js#L106) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:138](../server/src/routes/admin/horizonAssign.js#L138) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:90](../server/src/routes/admin/horizonAssign.js#L90) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:96](../server/src/routes/admin/horizonAssign.js#L96) |
| POST | `/horizon/test` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/horizonAssign.js:34](../server/src/routes/admin/horizonAssign.js#L34) |
| GET | `/host-access` | 역할 `admin` · `fleetReadOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:34](../server/src/routes/admin/hostAccess.js#L34) |
| POST | `/host-access/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:49](../server/src/routes/admin/hostAccess.js#L49) |
| POST | `/host-access/confirm` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:55](../server/src/routes/admin/hostAccess.js#L55) |
| PUT | `/host-access/draft` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:39](../server/src/routes/admin/hostAccess.js#L39) |
| POST | `/host-access/plan` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:46](../server/src/routes/admin/hostAccess.js#L46) |
| POST | `/host-access/revert` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:61](../server/src/routes/admin/hostAccess.js#L61) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:167](../server/src/routes/admin/idracCore.js#L167) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracCore.js:227](../server/src/routes/admin/idracCore.js#L227) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:580](../server/src/routes/admin/idracScan.js#L580) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:574](../server/src/routes/admin/idracScan.js#L574) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` · `liveFleetOnly` | [server/src/routes/admin/idracScan.js:247](../server/src/routes/admin/idracScan.js#L247) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:101](../server/src/routes/admin/idracScan.js#L101) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:158](../server/src/routes/admin/idracScan.js#L158) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:202](../server/src/routes/admin/idracScan.js#L202) |
| GET | `/idrac/:id/trend` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:869](../server/src/routes/admin/idracTrend.js#L869) |
| GET | `/idrac/:id/trend/hourly` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:831](../server/src/routes/admin/idracTrend.js#L831) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:125](../server/src/routes/admin/idracScan.js#L125) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:562](../server/src/routes/admin/idracScan.js#L562) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:279](../server/src/routes/admin/idracScan.js#L279) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:549](../server/src/routes/admin/idracScan.js#L549) |
| POST | `/idrac/expand-ips` | 역할 `admin` · `listOrText` | [server/src/routes/admin/idracScan.js:272](../server/src/routes/admin/idracScan.js#L272) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:538](../server/src/routes/admin/idracCore.js#L538) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:574](../server/src/routes/admin/idracCore.js#L574) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:470](../server/src/routes/admin/idracCore.js#L470) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:278](../server/src/routes/admin/idracCore.js#L278) |
| POST | `/idrac/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:261](../server/src/routes/admin/idracScan.js#L261) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:391](../server/src/routes/admin/idracCore.js#L391) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:317](../server/src/routes/admin/idracCore.js#L317) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:628](../server/src/routes/admin/idracCore.js#L628) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:648](../server/src/routes/admin/idracCore.js#L648) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:245](../server/src/routes/admin/idracCore.js#L245) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:264](../server/src/routes/admin/idracCore.js#L264) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:251](../server/src/routes/admin/idracCore.js#L251) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:252](../server/src/routes/admin/idracCore.js#L252) |
| POST | `/idrac/register-scanned` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:350](../server/src/routes/admin/idracScan.js#L350) |
| POST | `/idrac/scan` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:288](../server/src/routes/admin/idracScan.js#L288) |
| GET | `/idrac/scan-agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:336](../server/src/routes/admin/idracScan.js#L336) |
| GET | `/idrac/scan-job-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:523](../server/src/routes/admin/idracScan.js#L523) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:541](../server/src/routes/admin/idracScan.js#L541) |
| GET | `/idrac/scan-jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:513](../server/src/routes/admin/idracScan.js#L513) |
| GET | `/idrac/scan-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:487](../server/src/routes/admin/idracScan.js#L487) |
| GET | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:367](../server/src/routes/admin/idracScan.js#L367) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:377](../server/src/routes/admin/idracScan.js#L377) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:385](../server/src/routes/admin/idracScan.js#L385) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:396](../server/src/routes/admin/idracScan.js#L396) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:417](../server/src/routes/admin/idracScan.js#L417) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:501](../server/src/routes/admin/idracScan.js#L501) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/idracScan.js:411](../server/src/routes/admin/idracScan.js#L411) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracScan.js:475](../server/src/routes/admin/idracScan.js#L475) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:484](../server/src/routes/admin/idracScan.js#L484) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:494](../server/src/routes/admin/idracScan.js#L494) |
| GET | `/idrac/scan-result` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:327](../server/src/routes/admin/idracScan.js#L327) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:514](../server/src/routes/admin/idracCore.js#L514) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/idracCore.js:237](../server/src/routes/admin/idracCore.js#L237) |
| GET | `/idrac/trend/export.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:743](../server/src/routes/admin/idracTrend.js#L743) |
| GET | `/idrac/trend/export.xlsx` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:767](../server/src/routes/admin/idracTrend.js#L767) |
| GET | `/idrac/trend/resolve-host` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:720](../server/src/routes/admin/idracTrend.js#L720) |
| GET | `/idrac/trend/servers` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:654](../server/src/routes/admin/idracTrend.js#L654) |
| GET | `/idrac/trend/table` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:661](../server/src/routes/admin/idracTrend.js#L661) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:505](../server/src/routes/admin/idracCore.js#L505) |
| GET | `/ipam/changes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:439](../server/src/routes/admin/centralIpam.js#L439) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:74](../server/src/routes/admin/centralIpam.js#L74) |
| GET | `/ipam/report` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:457](../server/src/routes/admin/centralIpam.js#L457) |
| PUT | `/ipam/report` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:467](../server/src/routes/admin/centralIpam.js#L467) |
| POST | `/ipam/report/preview` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:473](../server/src/routes/admin/centralIpam.js#L473) |
| POST | `/ipam/report/send-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:480](../server/src/routes/admin/centralIpam.js#L480) |
| POST | `/ipam/scan/agent/delete` | 역할 `admin` · `fleetOnly` · `scanCfgWritable` · `textFields` | [server/src/routes/admin/centralIpam.js:359](../server/src/routes/admin/centralIpam.js#L359) |
| GET | `/ipam/scan/bm-os-suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmOsSuggest.js:63](../server/src/routes/admin/bmOsSuggest.js#L63) |
| POST | `/ipam/scan/bm-os-suggest/apply` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmOsSuggest.js:72](../server/src/routes/admin/bmOsSuggest.js#L72) |
| GET | `/ipam/scan/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:246](../server/src/routes/admin/centralIpam.js#L246) |
| GET | `/ipam/scan/log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:486](../server/src/routes/admin/centralIpam.js#L486) |
| GET | `/ipam/scan/migration` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:410](../server/src/routes/admin/centralIpam.js#L410) |
| POST | `/ipam/scan/migration/dismiss` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:433](../server/src/routes/admin/centralIpam.js#L433) |
| POST | `/ipam/scan/migration/move` | 역할 `admin` · `fleetOnly` · `scanCfgWritable` · `textFields` | [server/src/routes/admin/centralIpam.js:411](../server/src/routes/admin/centralIpam.js#L411) |
| POST | `/ipam/scan/migration/remove` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/centralIpam.js:423](../server/src/routes/admin/centralIpam.js#L423) |
| GET | `/ipam/scan/owners` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:238](../server/src/routes/admin/centralIpam.js#L238) |
| GET | `/ipam/scan/ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:315](../server/src/routes/admin/centralIpam.js#L315) |
| GET | `/ipam/scan/ranges.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:511](../server/src/routes/admin/centralIpam.js#L511) |
| POST | `/ipam/scan/ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` · `scanCfgWritable` · `textFields` | [server/src/routes/admin/centralIpam.js:522](../server/src/routes/admin/centralIpam.js#L522) |
| POST | `/ipam/scan/ranges/line` | 역할 `admin` · `fleetOnly` · `scanCfgWritable` · `textFields` | [server/src/routes/admin/centralIpam.js:333](../server/src/routes/admin/centralIpam.js#L333) |
| GET | `/ipam/scan/ranges/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:517](../server/src/routes/admin/centralIpam.js#L517) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:498](../server/src/routes/admin/centralIpam.js#L498) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:489](../server/src/routes/admin/centralIpam.js#L489) |
| GET | `/ipam/scan/schedule` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:447](../server/src/routes/admin/centralIpam.js#L447) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:137](../server/src/routes/admin/centralIpam.js#L137) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` · `scanCfgWritable` · `textFields` · `listOrText` | [server/src/routes/admin/centralIpam.js:169](../server/src/routes/admin/centralIpam.js#L169) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:494](../server/src/routes/admin/centralIpam.js#L494) |
| GET | `/ipam/scan/suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:201](../server/src/routes/admin/centralIpam.js#L201) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:104](../server/src/routes/admin/centralIpam.js#L104) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:110](../server/src/routes/admin/centralIpam.js#L110) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` · `textFields` · `listOrText` | [server/src/routes/admin/centralIpam.js:547](../server/src/routes/admin/centralIpam.js#L547) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:603](../server/src/routes/admin/centralIpam.js#L603) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` · `csvPerm` · `textFields` | [server/src/routes/admin/centralIpam.js:624](../server/src/routes/admin/centralIpam.js#L624) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:618](../server/src/routes/admin/centralIpam.js#L618) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:609](../server/src/routes/admin/centralIpam.js#L609) |
| GET | `/ipam/vc-ranges/suggest` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:571](../server/src/routes/admin/centralIpam.js#L571) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:586](../server/src/routes/admin/deployLlm.js#L586) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:587](../server/src/routes/admin/deployLlm.js#L587) |
| POST | `/llm-test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:594](../server/src/routes/admin/deployLlm.js#L594) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:24](../server/src/routes/admin/logAnalysis.js#L24) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/admin/logAnalysis.js:47](../server/src/routes/admin/logAnalysis.js#L47) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:41](../server/src/routes/admin/logAnalysis.js#L41) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:56](../server/src/routes/admin/logAnalysis.js#L56) |
| GET | `/login-history` | 역할 `admin` · `loginHistoryFullScope` | [server/src/routes/admin/opsSettings.js:119](../server/src/routes/admin/opsSettings.js#L119) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:88](../server/src/routes/admin/statusTools.js#L88) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:61](../server/src/routes/admin/mail.js#L61) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:69](../server/src/routes/admin/mail.js#L69) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:103](../server/src/routes/admin/mail.js#L103) |
| GET | `/memtrack` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:204](../server/src/routes/admin/statusTools.js#L204) |
| GET | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:142](../server/src/routes/admin/gpuGuest.js#L142) |
| PUT | `/metrics/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:146](../server/src/routes/admin/gpuGuest.js#L146) |
| GET | `/net/agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:275](../server/src/routes/admin/backupNetSec.js#L275) |
| GET | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:307](../server/src/routes/admin/backupNetSec.js#L307) |
| POST | `/net/capture` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:282](../server/src/routes/admin/backupNetSec.js#L282) |
| GET | `/net/history` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:324](../server/src/routes/admin/backupNetSec.js#L324) |
| DELETE | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:326](../server/src/routes/admin/backupNetSec.js#L326) |
| GET | `/net/history/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:325](../server/src/routes/admin/backupNetSec.js#L325) |
| GET | `/net/log-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:351](../server/src/routes/admin/backupNetSec.js#L351) |
| GET | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:330](../server/src/routes/admin/backupNetSec.js#L330) |
| PUT | `/net/monitors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:336](../server/src/routes/admin/backupNetSec.js#L336) |
| DELETE | `/net/monitors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:348](../server/src/routes/admin/backupNetSec.js#L348) |
| POST | `/net/monitors/:id/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:349](../server/src/routes/admin/backupNetSec.js#L349) |
| POST | `/net/pcap` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:313](../server/src/routes/admin/backupNetSec.js#L313) |
| GET | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:18](../server/src/routes/admin/nfsMounts.js#L18) |
| POST | `/nfs-mounts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:25](../server/src/routes/admin/nfsMounts.js#L25) |
| DELETE | `/nfs-mounts/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:33](../server/src/routes/admin/nfsMounts.js#L33) |
| POST | `/nfs-mounts/:id/mount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:41](../server/src/routes/admin/nfsMounts.js#L41) |
| POST | `/nfs-mounts/:id/umount` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nfsMounts.js:49](../server/src/routes/admin/nfsMounts.js#L49) |
| GET | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:60](../server/src/routes/admin/nsxImport.js#L60) |
| POST | `/nsx/managers` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:71](../server/src/routes/admin/nsxImport.js#L71) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:81](../server/src/routes/admin/nsxImport.js#L81) |
| PUT | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:76](../server/src/routes/admin/nsxImport.js#L76) |
| POST | `/nsx/managers/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:86](../server/src/routes/admin/nsxImport.js#L86) |
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `textFields` | [server/src/routes/admin/deployLlm.js:608](../server/src/routes/admin/deployLlm.js#L608) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:605](../server/src/routes/admin/deployLlm.js#L605) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:293](../server/src/routes/admin/opsSettings.js#L293) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:325](../server/src/routes/admin/opsSettings.js#L325) |
| GET | `/os-scan/results.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/opsSettings.js:329](../server/src/routes/admin/opsSettings.js#L329) |
| POST | `/os-scan/run` | 역할 `admin` · `textFields` | [server/src/routes/admin/opsSettings.js:304](../server/src/routes/admin/opsSettings.js#L304) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:296](../server/src/routes/admin/opsSettings.js#L296) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:82](../server/src/routes/admin/deployLlm.js#L82) |
| POST | `/packages/download` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:106](../server/src/routes/admin/deployLlm.js#L106) |
| PUT | `/packages/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:96](../server/src/routes/admin/deployLlm.js#L96) |
| GET | `/perf` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:24](../server/src/routes/admin/perfMonitor.js#L24) |
| DELETE | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:64](../server/src/routes/admin/perfMonitor.js#L64) |
| GET | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:58](../server/src/routes/admin/perfMonitor.js#L58) |
| POST | `/perf/measure` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/admin/perfMonitor.js:51](../server/src/routes/admin/perfMonitor.js#L51) |
| PUT | `/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:34](../server/src/routes/admin/perfMonitor.js#L34) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:145](../server/src/routes/admin/users.js#L145) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:209](../server/src/routes/admin/users.js#L209) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:229](../server/src/routes/admin/users.js#L229) |
| GET | `/portal-db` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:111](../server/src/routes/admin/statusTools.js#L111) |
| GET | `/portal-db/guide` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:115](../server/src/routes/admin/statusTools.js#L115) |
| GET | `/portal-db/health` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:129](../server/src/routes/admin/statusTools.js#L129) |
| GET | `/portal-db/location` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:148](../server/src/routes/admin/statusTools.js#L148) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/statusTools.js:164](../server/src/routes/admin/statusTools.js#L164) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` · `textFields` | [server/src/routes/admin/statusTools.js:174](../server/src/routes/admin/statusTools.js#L174) |
| POST | `/provision/jobs` | 역할 `admin` · `textFields` | [server/src/routes/admin/opsSettings.js:341](../server/src/routes/admin/opsSettings.js#L341) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:387](../server/src/routes/admin/opsSettings.js#L387) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:382](../server/src/routes/admin/opsSettings.js#L382) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:624](../server/src/routes/admin/deployLlm.js#L624) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:628](../server/src/routes/admin/deployLlm.js#L628) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:149](../server/src/routes/admin/opsSettings.js#L149) |
| PUT | `/report/daily` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:150](../server/src/routes/admin/opsSettings.js#L150) |
| POST | `/report/daily/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:156](../server/src/routes/admin/opsSettings.js#L156) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:152](../server/src/routes/admin/idracCore.js#L152) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:115](../server/src/routes/admin/idracCore.js#L115) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:137](../server/src/routes/admin/idracCore.js#L137) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:204](../server/src/routes/admin/opsSettings.js#L204) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:207](../server/src/routes/admin/opsSettings.js#L207) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:445](../server/src/routes/admin/backupNetSec.js#L445) |
| PUT | `/security/guest-scans` | 역할 `admin` · `textFields` | [server/src/routes/admin/backupNetSec.js:456](../server/src/routes/admin/backupNetSec.js#L456) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:479](../server/src/routes/admin/backupNetSec.js#L479) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:480](../server/src/routes/admin/backupNetSec.js#L480) |
| GET | `/security/login-fails` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:417](../server/src/routes/admin/backupNetSec.js#L417) |
| POST | `/security/login-fails/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:435](../server/src/routes/admin/backupNetSec.js#L435) |
| PUT | `/security/login-fails/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:434](../server/src/routes/admin/backupNetSec.js#L434) |
| GET | `/security/login-fails/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/backupNetSec.js:433](../server/src/routes/admin/backupNetSec.js#L433) |
| GET | `/security/net-issues` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:438](../server/src/routes/admin/backupNetSec.js#L438) |
| GET | `/security/peer-trust` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:78](../server/src/routes/admin/peerTrust.js#L78) |
| POST | `/security/peer-trust/approve` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:90](../server/src/routes/admin/peerTrust.js#L90) |
| POST | `/security/peer-trust/approve-observed` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:140](../server/src/routes/admin/peerTrust.js#L140) |
| PUT | `/security/peer-trust/policy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/peerTrust.js:154](../server/src/routes/admin/peerTrust.js#L154) |
| POST | `/security/peer-trust/reject` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:118](../server/src/routes/admin/peerTrust.js#L118) |
| POST | `/security/peer-trust/remove` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/peerTrust.js:130](../server/src/routes/admin/peerTrust.js#L130) |
| GET | `/security/self-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/securityCheck.js:22](../server/src/routes/admin/securityCheck.js#L22) |
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:233](../server/src/routes/admin/opsSettings.js#L233) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:239](../server/src/routes/admin/opsSettings.js#L239) |
| GET | `/settings/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/settingsStatus.js:27](../server/src/routes/admin/settingsStatus.js#L27) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:212](../server/src/routes/admin/statusTools.js#L212) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:20](../server/src/routes/admin/toolCategories.js#L20) |
| PUT | `/tool-categories` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/toolCategories.js:30](../server/src/routes/admin/toolCategories.js#L30) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:50](../server/src/routes/admin/toolCategories.js#L50) |
| GET | `/usage/export.csv` | 역할 `admin` · 권한 `data.csv` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:59](../server/src/routes/admin/usage.js#L59) |
| POST | `/usage/purge` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/admin/usage.js:92](../server/src/routes/admin/usage.js#L92) |
| GET | `/usage/report` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:47](../server/src/routes/admin/usage.js#L47) |
| GET | `/usage/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:72](../server/src/routes/admin/usage.js#L72) |
| PUT | `/usage/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:84](../server/src/routes/admin/usage.js#L84) |
| GET | `/usage/user/:user` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:52](../server/src/routes/admin/usage.js#L52) |
| PUT | `/user-tools/:username` | 역할 `admin` | [server/src/routes/admin/users.js:184](../server/src/routes/admin/users.js#L184) |
| GET | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:103](../server/src/routes/admin/users.js#L103) |
| POST | `/users` | 역할 `admin` | [server/src/routes/admin/users.js:113](../server/src/routes/admin/users.js#L113) |
| DELETE | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:135](../server/src/routes/admin/users.js#L135) |
| PATCH | `/users/:username` | 역할 `admin` | [server/src/routes/admin/users.js:124](../server/src/routes/admin/users.js#L124) |
| DELETE | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:273](../server/src/routes/admin/users.js#L273) |
| POST | `/users/:username/password` | 역할 `admin` | [server/src/routes/admin/users.js:263](../server/src/routes/admin/users.js#L263) |
| POST | `/users/:username/totp/begin` | 역할 `admin` | [server/src/routes/admin/users.js:288](../server/src/routes/admin/users.js#L288) |
| POST | `/users/:username/totp/confirm` | 역할 `admin` | [server/src/routes/admin/users.js:295](../server/src/routes/admin/users.js#L295) |
| POST | `/users/:username/totp/disable` | 역할 `admin` | [server/src/routes/admin/users.js:305](../server/src/routes/admin/users.js#L305) |
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:159](../server/src/routes/admin/vcenters.js#L159) |
| PUT | `/vcenter-order` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:168](../server/src/routes/admin/vcenters.js#L168) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:94](../server/src/routes/admin/statusTools.js#L94) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:73](../server/src/routes/admin/vcenters.js#L73) |
| POST | `/vcenters` | 역할 `admin` · `fleetWideOnly` · `textFields` | [server/src/routes/admin/vcenters.js:94](../server/src/routes/admin/vcenters.js#L94) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:111](../server/src/routes/admin/vcenters.js#L111) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:102](../server/src/routes/admin/vcenters.js#L102) |
| POST | `/vcenters/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:98](../server/src/routes/admin/nsxImport.js#L98) |
| POST | `/vcenters/import-file` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:115](../server/src/routes/admin/nsxImport.js#L115) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/nsxImport.js:107](../server/src/routes/admin/nsxImport.js#L107) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:120](../server/src/routes/admin/vcenters.js#L120) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:137](../server/src/routes/admin/vcenters.js#L137) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:267](../server/src/routes/admin/backupNetSec.js#L267) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:247](../server/src/routes/admin/backupNetSec.js#L247) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:244](../server/src/routes/admin/backupNetSec.js#L244) |
| GET | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:77](../server/src/routes/admin/veeamEm.js#L77) |
| POST | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:88](../server/src/routes/admin/veeamEm.js#L88) |
| DELETE | `/veeam/em/:id` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:100](../server/src/routes/admin/veeamEm.js#L100) |
| POST | `/veeam/em/:id/collect` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:145](../server/src/routes/admin/veeamEm.js#L145) |
| POST | `/veeam/em/:id/test` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:127](../server/src/routes/admin/veeamEm.js#L127) |
| PUT | `/veeam/em/map` | 역할 `admin` · `fleetWideOnly` · `textFields` | [server/src/routes/admin/veeamEm.js:115](../server/src/routes/admin/veeamEm.js#L115) |
| GET | `/veeam/servers` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:93](../server/src/routes/admin/veeam.js#L93) |
| POST | `/veeam/servers` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:124](../server/src/routes/admin/veeam.js#L124) |
| DELETE | `/veeam/servers/:id` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:144](../server/src/routes/admin/veeam.js#L144) |
| POST | `/veeam/servers/:id/collect` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:182](../server/src/routes/admin/veeam.js#L182) |
| POST | `/veeam/servers/:id/test` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:158](../server/src/routes/admin/veeam.js#L158) |
| GET | `/veeam/servers/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:220](../server/src/routes/admin/veeam.js#L220) |
| GET | `/veeam/servers/export.txt` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:225](../server/src/routes/admin/veeam.js#L225) |
| POST | `/veeam/servers/import` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:276](../server/src/routes/admin/veeam.js#L276) |
| POST | `/veeam/servers/import/test` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:235](../server/src/routes/admin/veeam.js#L235) |
| GET | `/veeam/servers/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:269](../server/src/routes/admin/veeam.js#L269) |
| GET | `/veeam/servers/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:230](../server/src/routes/admin/veeam.js#L230) |
| GET | `/veeam/servers/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:231](../server/src/routes/admin/veeam.js#L231) |
| GET | `/veeam/vc-accounts` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:77](../server/src/routes/admin/veeam.js#L77) |
| PUT | `/veeam/vc-accounts` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeam.js:78](../server/src/routes/admin/veeam.js#L78) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:505](../server/src/routes/admin/collectorsDc.js#L505) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:533](../server/src/routes/admin/collectorsDc.js#L533) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/activity` | — | [server/src/routes/auth.js:335](../server/src/routes/auth.js#L335) |
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:416](../server/src/routes/auth.js#L416) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` · `requireSettingsOwner` | [server/src/routes/auth.js:426](../server/src/routes/auth.js#L426) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:440](../server/src/routes/auth.js#L440) |
| GET | `/config` | — | [server/src/routes/auth.js:37](../server/src/routes/auth.js#L37) |
| POST | `/extend` | `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:266](../server/src/routes/auth.js#L266) |
| POST | `/login` | — | [server/src/routes/auth.js:61](../server/src/routes/auth.js#L61) |
| POST | `/logout` | `authMiddleware` | [server/src/routes/auth.js:317](../server/src/routes/auth.js#L317) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:236](../server/src/routes/auth.js#L236) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:365](../server/src/routes/auth.js#L365) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:386](../server/src/routes/auth.js#L386) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:272](../server/src/routes/ping.js#L272) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:282](../server/src/routes/ping.js#L282) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:196](../server/src/routes/ping.js#L196) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:232](../server/src/routes/ping.js#L232) |
| GET | `/series` | — | [server/src/routes/ping.js:103](../server/src/routes/ping.js#L103) |
| GET | `/settings` | — | [server/src/routes/ping.js:219](../server/src/routes/ping.js#L219) |
| PUT | `/settings` | 역할 `admin` | [server/src/routes/ping.js:223](../server/src/routes/ping.js#L223) |
| GET | `/status` | — | [server/src/routes/ping.js:85](../server/src/routes/ping.js#L85) |
| GET | `/targets` | — | [server/src/routes/ping.js:98](../server/src/routes/ping.js#L98) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:163](../server/src/routes/ping.js#L163) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:175](../server/src/routes/ping.js#L175) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:169](../server/src/routes/ping.js#L169) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:289](../server/src/routes/ping.js#L289) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:303](../server/src/routes/ping.js#L303) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:317](../server/src/routes/ping.js#L317) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:324](../server/src/routes/ping.js#L324) |

## `/metrics`

Prometheus/OTel 익스포터(선택 토큰).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/metricsExport.js:31](../server/src/routes/metricsExport.js#L31) |

## `/api/v1`

**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/publicApi.js:218](../server/src/routes/publicApi.js#L218) |
| GET | `/backup/summary` | `guarded` | [server/src/routes/publicApi.js:783](../server/src/routes/publicApi.js#L783) |
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:383](../server/src/routes/publicApi.js#L383) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:399](../server/src/routes/publicApi.js#L399) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:521](../server/src/routes/publicApi.js#L521) |
| GET | `/compliance/licenses` | `guarded` | [server/src/routes/publicApi.js:757](../server/src/routes/publicApi.js#L757) |
| GET | `/compliance/snapshots` | `guarded` | [server/src/routes/publicApi.js:769](../server/src/routes/publicApi.js#L769) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:568](../server/src/routes/publicApi.js#L568) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:595](../server/src/routes/publicApi.js#L595) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:347](../server/src/routes/publicApi.js#L347) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:260](../server/src/routes/publicApi.js#L260) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:321](../server/src/routes/publicApi.js#L321) |
| GET | `/objects/clusters` | `guarded` | [server/src/routes/publicApi.js:744](../server/src/routes/publicApi.js#L744) |
| GET | `/objects/hosts` | `guarded` | [server/src/routes/publicApi.js:710](../server/src/routes/publicApi.js#L710) |
| GET | `/objects/networks` | `guarded` | [server/src/routes/publicApi.js:734](../server/src/routes/publicApi.js#L734) |
| GET | `/objects/vms` | `guarded` | [server/src/routes/publicApi.js:722](../server/src/routes/publicApi.js#L722) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:240](../server/src/routes/publicApi.js#L240) |
| GET | `/resources/gpu` | `guarded` | [server/src/routes/publicApi.js:801](../server/src/routes/publicApi.js#L801) |
| GET | `/resources/power` | `guarded` | [server/src/routes/publicApi.js:795](../server/src/routes/publicApi.js#L795) |
| GET | `/san-storage/arrays` | `guarded` | [server/src/routes/publicApi.js:636](../server/src/routes/publicApi.js#L636) |
| GET | `/san-storage/check` | `guarded` | [server/src/routes/publicApi.js:652](../server/src/routes/publicApi.js#L652) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:691](../server/src/routes/api/inventory.js#L691) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:694](../server/src/routes/api/inventory.js#L694) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:702](../server/src/routes/api/inventory.js#L702) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:674](../server/src/routes/api/inventory.js#L674) |
| GET | `/attach/:kind/:owner` | — | [server/src/routes/api/attach.js:136](../server/src/routes/api/attach.js#L136) |
| POST | `/attach/:kind/:owner` | 역할 `admin/operator` · `uploadPrecheck` · `express.raw` | [server/src/routes/api/attach.js:152](../server/src/routes/api/attach.js#L152) |
| GET | `/attach/admin/archive` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/attach.js:86](../server/src/routes/api/attach.js#L86) |
| PUT | `/attach/admin/settings` | 역할 `admin` · `fleetOnly` · `fullWriteOnly` | [server/src/routes/api/attach.js:77](../server/src/routes/api/attach.js#L77) |
| GET | `/attach/admin/usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/attach.js:70](../server/src/routes/api/attach.js#L70) |
| DELETE | `/attach/file/:id` | 역할 `admin/operator` | [server/src/routes/api/attach.js:121](../server/src/routes/api/attach.js#L121) |
| GET | `/attach/file/:id` | — | [server/src/routes/api/attach.js:105](../server/src/routes/api/attach.js#L105) |
| GET | `/board/persist` | — | [server/src/routes/api/bulletin.js:204](../server/src/routes/api/bulletin.js#L204) |
| POST | `/board/persist/retry` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bulletin.js:209](../server/src/routes/api/bulletin.js#L209) |
| GET | `/board/posts` | — | [server/src/routes/api/bulletin.js:140](../server/src/routes/api/bulletin.js#L140) |
| POST | `/board/posts` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:150](../server/src/routes/api/bulletin.js#L150) |
| DELETE | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:165](../server/src/routes/api/bulletin.js#L165) |
| GET | `/board/posts/:id` | — | [server/src/routes/api/bulletin.js:146](../server/src/routes/api/bulletin.js#L146) |
| PUT | `/board/posts/:id` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:157](../server/src/routes/api/bulletin.js#L157) |
| POST | `/board/posts/:id/comments` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:173](../server/src/routes/api/bulletin.js#L173) |
| DELETE | `/board/posts/:id/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:194](../server/src/routes/api/bulletin.js#L194) |
| POST | `/board/posts/:id/comments/:cid/like` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:190](../server/src/routes/api/bulletin.js#L190) |
| POST | `/board/posts/:id/like` | 역할 `admin/operator` | [server/src/routes/api/bulletin.js:186](../server/src/routes/api/bulletin.js#L186) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:585](../server/src/routes/api/inventory.js#L585) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:593](../server/src/routes/api/inventory.js#L593) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:154](../server/src/routes/api/overviewNsx.js#L154) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:365](../server/src/routes/api/inventory.js#L365) |
| GET | `/hosts/:id` | 권한 `inv.hosts` | [server/src/routes/api/hostChecks.js:80](../server/src/routes/api/hostChecks.js#L80) |
| POST | `/hosts/:id/endpoint-locate` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:382](../server/src/routes/api/hostSan.js#L382) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:201](../server/src/routes/api/vmMetrics.js#L201) |
| GET | `/hosts/:id/net-uplinks` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:261](../server/src/routes/api/hostSan.js#L261) |
| GET | `/hosts/:id/nic-stats` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:231](../server/src/routes/api/vmMetrics.js#L231) |
| GET | `/hosts/:id/san-attribution` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:205](../server/src/routes/api/hostSan.js#L205) |
| GET | `/hosts/checks` | 권한 `inv.hosts` | [server/src/routes/api/hostChecks.js:55](../server/src/routes/api/hostChecks.js#L55) |
| GET | `/hosts/corp` | 권한 `inv.hosts` | [server/src/routes/api/hostCorp.js:38](../server/src/routes/api/hostCorp.js#L38) |
| GET | `/hosts/insight` | 권한 `inv.hosts` | [server/src/routes/api/hostInsight.js:26](../server/src/routes/api/hostInsight.js#L26) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:318](../server/src/routes/api/vmMetrics.js#L318) |
| GET | `/issues` | — | [server/src/routes/api/issues.js:339](../server/src/routes/api/issues.js#L339) |
| POST | `/issues` | `creators` | [server/src/routes/api/issues.js:444](../server/src/routes/api/issues.js#L444) |
| DELETE | `/issues/:key` | 역할 `admin/operator` | [server/src/routes/api/issues.js:608](../server/src/routes/api/issues.js#L608) |
| GET | `/issues/:key` | — | [server/src/routes/api/issues.js:439](../server/src/routes/api/issues.js#L439) |
| PUT | `/issues/:key` | 역할 `admin/operator` | [server/src/routes/api/issues.js:471](../server/src/routes/api/issues.js#L471) |
| POST | `/issues/:key/assign` | 역할 `admin/operator` | [server/src/routes/api/issues.js:528](../server/src/routes/api/issues.js#L528) |
| POST | `/issues/:key/block` | 역할 `admin/operator` | [server/src/routes/api/issues.js:536](../server/src/routes/api/issues.js#L536) |
| POST | `/issues/:key/comments` | 역할 `admin/operator` | [server/src/routes/api/issues.js:566](../server/src/routes/api/issues.js#L566) |
| DELETE | `/issues/:key/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/issues.js:600](../server/src/routes/api/issues.js#L600) |
| PUT | `/issues/:key/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/issues.js:592](../server/src/routes/api/issues.js#L592) |
| POST | `/issues/:key/links` | 역할 `admin/operator` | [server/src/routes/api/issues.js:488](../server/src/routes/api/issues.js#L488) |
| POST | `/issues/:key/links/remove` | 역할 `admin/operator` | [server/src/routes/api/issues.js:496](../server/src/routes/api/issues.js#L496) |
| GET | `/issues/:key/mentionables` | 역할 `admin/operator` | [server/src/routes/api/issues.js:550](../server/src/routes/api/issues.js#L550) |
| POST | `/issues/:key/progress` | 역할 `admin/operator` | [server/src/routes/api/issues.js:520](../server/src/routes/api/issues.js#L520) |
| POST | `/issues/:key/status` | 역할 `admin/operator` | [server/src/routes/api/issues.js:479](../server/src/routes/api/issues.js#L479) |
| POST | `/issues/:key/watch` | 역할 `admin/operator` | [server/src/routes/api/issues.js:545](../server/src/routes/api/issues.js#L545) |
| POST | `/issues/:key/worklog` | 역할 `admin/operator` | [server/src/routes/api/issues.js:506](../server/src/routes/api/issues.js#L506) |
| POST | `/issues/:key/worklog/remove` | 역할 `admin/operator` | [server/src/routes/api/issues.js:513](../server/src/routes/api/issues.js#L513) |
| GET | `/issues/activity` | — | [server/src/routes/api/issues.js:313](../server/src/routes/api/issues.js#L313) |
| GET | `/issues/autocreate` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:283](../server/src/routes/api/issues.js#L283) |
| PUT | `/issues/autocreate` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:294](../server/src/routes/api/issues.js#L294) |
| GET | `/issues/autocreate/alerts` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:231](../server/src/routes/api/issues.js#L231) |
| PUT | `/issues/autocreate/alerts` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:236](../server/src/routes/api/issues.js#L236) |
| POST | `/issues/autocreate/simulate` | 역할 `admin` · `issueSettingsFleetOnly` · `textFields` | [server/src/routes/api/issues.js:305](../server/src/routes/api/issues.js#L305) |
| POST | `/issues/bulk/assign` | 역할 `admin/operator` | [server/src/routes/api/issues.js:464](../server/src/routes/api/issues.js#L464) |
| POST | `/issues/bulk/edit` | 역할 `admin/operator` | [server/src/routes/api/issues.js:457](../server/src/routes/api/issues.js#L457) |
| GET | `/issues/export.csv` | 권한 `data.csv` | [server/src/routes/api/issues.js:361](../server/src/routes/api/issues.js#L361) |
| GET | `/issues/filters` | — | [server/src/routes/api/issues.js:417](../server/src/routes/api/issues.js#L417) |
| POST | `/issues/filters` | 역할 `admin/operator` | [server/src/routes/api/issues.js:422](../server/src/routes/api/issues.js#L422) |
| DELETE | `/issues/filters/:id` | 역할 `admin/operator` | [server/src/routes/api/issues.js:435](../server/src/routes/api/issues.js#L435) |
| PUT | `/issues/filters/:id` | 역할 `admin/operator` | [server/src/routes/api/issues.js:426](../server/src/routes/api/issues.js#L426) |
| POST | `/issues/filters/:id/subscribe` | 역할 `admin/operator` | [server/src/routes/api/issues.js:431](../server/src/routes/api/issues.js#L431) |
| GET | `/issues/inbox` | — | [server/src/routes/api/issues.js:245](../server/src/routes/api/issues.js#L245) |
| POST | `/issues/inbox/read` | `creators` | [server/src/routes/api/issues.js:256](../server/src/routes/api/issues.js#L256) |
| GET | `/issues/meta` | — | [server/src/routes/api/issues.js:162](../server/src/routes/api/issues.js#L162) |
| GET | `/issues/report` | — | [server/src/routes/api/issues.js:269](../server/src/routes/api/issues.js#L269) |
| GET | `/issues/report.csv` | 권한 `data.csv` | [server/src/routes/api/issues.js:273](../server/src/routes/api/issues.js#L273) |
| GET | `/issues/settings` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:216](../server/src/routes/api/issues.js#L216) |
| PUT | `/issues/settings` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:222](../server/src/routes/api/issues.js#L222) |
| GET | `/issues/sprints` | — | [server/src/routes/api/issues.js:375](../server/src/routes/api/issues.js#L375) |
| POST | `/issues/sprints` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:384](../server/src/routes/api/issues.js#L384) |
| PUT | `/issues/sprints/:id` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:392](../server/src/routes/api/issues.js#L392) |
| GET | `/issues/sprints/:id/board` | — | [server/src/routes/api/issues.js:380](../server/src/routes/api/issues.js#L380) |
| POST | `/issues/sprints/:id/close` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:401](../server/src/routes/api/issues.js#L401) |
| GET | `/issues/stats` | — | [server/src/routes/api/issues.js:180](../server/src/routes/api/issues.js#L180) |
| GET | `/issues/suggest` | — | [server/src/routes/api/issues.js:185](../server/src/routes/api/issues.js#L185) |
| GET | `/issues/templates` | `creators` | [server/src/routes/api/issues.js:197](../server/src/routes/api/issues.js#L197) |
| POST | `/issues/templates` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:204](../server/src/routes/api/issues.js#L204) |
| DELETE | `/issues/templates/:id` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:212](../server/src/routes/api/issues.js#L212) |
| PUT | `/issues/templates/:id` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:208](../server/src/routes/api/issues.js#L208) |
| GET | `/issues/versions` | — | [server/src/routes/api/issues.js:347](../server/src/routes/api/issues.js#L347) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:608](../server/src/routes/api/inventory.js#L608) |
| GET | `/notices` | — | [server/src/routes/api/bulletin.js:109](../server/src/routes/api/bulletin.js#L109) |
| POST | `/notices` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:115](../server/src/routes/api/bulletin.js#L115) |
| DELETE | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:130](../server/src/routes/api/bulletin.js#L130) |
| PUT | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:122](../server/src/routes/api/bulletin.js#L122) |
| GET | `/notices/active` | — | [server/src/routes/api/bulletin.js:105](../server/src/routes/api/bulletin.js#L105) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:260](../server/src/routes/api/overviewNsx.js#L260) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:296](../server/src/routes/api/overviewNsx.js#L296) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:211](../server/src/routes/api/overviewNsx.js#L211) |
| GET | `/overview/cards` | — | [server/src/routes/api/overviewCards.js:169](../server/src/routes/api/overviewCards.js#L169) |
| GET | `/overview/trend` | — | [server/src/routes/api/overviewCards.js:221](../server/src/routes/api/overviewCards.js#L221) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:117](../server/src/routes/api/perfClient.js#L117) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:75](../server/src/routes/api/perfClient.js#L75) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:105](../server/src/routes/api/perfClient.js#L105) |
| GET | `/platform/summary` | — | [server/src/routes/api/inventory.js:562](../server/src/routes/api/inventory.js#L562) |
| GET | `/provision/jobs` | — | [server/src/routes/api/provision.js:64](../server/src/routes/api/provision.js#L64) |
| GET | `/provision/jobs/:id` | — | [server/src/routes/api/provision.js:70](../server/src/routes/api/provision.js#L70) |
| GET | `/provision/placement` | 권한 `vm.provision` | [server/src/routes/api/provision.js:28](../server/src/routes/api/provision.js#L28) |
| POST | `/provision/preview` | 권한 `vm.provision` | [server/src/routes/api/provision.js:40](../server/src/routes/api/provision.js#L40) |
| GET | `/provision/saved` | 권한 `vm.provision` | [server/src/routes/api/provision.js:45](../server/src/routes/api/provision.js#L45) |
| GET | `/provision/saved/:id` | 권한 `vm.provision` | [server/src/routes/api/provision.js:48](../server/src/routes/api/provision.js#L48) |
| GET | `/provision/sources` | 권한 `vm.provision` | [server/src/routes/api/provision.js:21](../server/src/routes/api/provision.js#L21) |
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:37](../server/src/routes/api/searchNotes.js#L37) |
| GET | `/release-notes/since` | — | [server/src/routes/api/searchNotes.js:43](../server/src/routes/api/searchNotes.js#L43) |
| GET | `/search/inventory` | — | [server/src/routes/api/invSearch.js:53](../server/src/routes/api/invSearch.js#L53) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:15](../server/src/routes/api/searchNotes.js#L15) |
| GET | `/settings/ssh-access` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:45](../server/src/routes/api/sshAccess.js#L45) |
| POST | `/settings/ssh-access/accounts` | 역할 `admin` · `requireSettingsOwner` · `textFields` · `pwVaultFirst` · `judgeFirst` · `reauth` | [server/src/routes/api/sshAccess.js:202](../server/src/routes/api/sshAccess.js#L202) |
| DELETE | `/settings/ssh-access/accounts/:id/stop` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:217](../server/src/routes/api/sshAccess.js#L217) |
| POST | `/settings/ssh-access/accounts/:id/verify` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:211](../server/src/routes/api/sshAccess.js#L211) |
| PUT | `/settings/ssh-access/assign` | 역할 `admin` · `requireSettingsOwner` · `judgeFirst` · `reauth` | [server/src/routes/api/sshAccess.js:156](../server/src/routes/api/sshAccess.js#L156) |
| GET | `/settings/ssh-access/changes` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:227](../server/src/routes/api/sshAccess.js#L227) |
| DELETE | `/settings/ssh-access/corps/:corp/stop` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:116](../server/src/routes/api/sshAccess.js#L116) |
| POST | `/settings/ssh-access/corps/:corp/stop` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:110](../server/src/routes/api/sshAccess.js#L110) |
| POST | `/settings/ssh-access/inbox/approve` | 역할 `admin` · `requireSettingsOwner` · `vaultFirst` · `reauth` | [server/src/routes/api/sshAccess.js:123](../server/src/routes/api/sshAccess.js#L123) |
| POST | `/settings/ssh-access/inbox/discard` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:130](../server/src/routes/api/sshAccess.js#L130) |
| POST | `/settings/ssh-access/keys` | 역할 `admin` · `requireSettingsOwner` · `vaultFirst` · `reauth` | [server/src/routes/api/sshAccess.js:67](../server/src/routes/api/sshAccess.js#L67) |
| PUT | `/settings/ssh-access/keys/:id/placement` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:75](../server/src/routes/api/sshAccess.js#L75) |
| POST | `/settings/ssh-access/reload-keystore` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:60](../server/src/routes/api/sshAccess.js#L60) |
| POST | `/settings/ssh-access/reload-state` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:55](../server/src/routes/api/sshAccess.js#L55) |
| POST | `/settings/ssh-access/scan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:50](../server/src/routes/api/sshAccess.js#L50) |
| POST | `/settings/ssh-access/servers/:id/account` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:176](../server/src/routes/api/sshAccess.js#L176) |
| GET | `/settings/ssh-access/servers/:id/candidates` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:91](../server/src/routes/api/sshAccess.js#L91) |
| DELETE | `/settings/ssh-access/servers/:id/inherit` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:170](../server/src/routes/api/sshAccess.js#L170) |
| POST | `/settings/ssh-access/servers/:id/installed-keys` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:95](../server/src/routes/api/sshAccess.js#L95) |
| POST | `/settings/ssh-access/servers/:id/key` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:84](../server/src/routes/api/sshAccess.js#L84) |
| POST | `/settings/ssh-access/servers/:id/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:103](../server/src/routes/api/sshAccess.js#L103) |
| POST | `/settings/ssh-access/servers/inherit` | 역할 `admin` · `requireSettingsOwner` · `judgeFirst` · `reauth` | [server/src/routes/api/sshAccess.js:162](../server/src/routes/api/sshAccess.js#L162) |
| POST | `/settings/ssh-access/servers/os` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:183](../server/src/routes/api/sshAccess.js#L183) |
| GET | `/settings/ssh-access/usage` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:224](../server/src/routes/api/sshAccess.js#L224) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:167](../server/src/routes/api/inventory.js#L167) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:721](../server/src/routes/api/inventory.js#L721) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:717](../server/src/routes/api/inventory.js#L717) |
| GET | `/tools/backup-detail` | 권한 `tools` | [server/src/routes/api/veeam.js:1464](../server/src/routes/api/veeam.js#L1464) |
| GET | `/tools/backup-detail.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1536](../server/src/routes/api/veeam.js#L1536) |
| PUT | `/tools/backup-detail/marks` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/veeam.js:1479](../server/src/routes/api/veeam.js#L1479) |
| GET | `/tools/backup-em` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:1425](../server/src/routes/api/veeam.js#L1425) |
| GET | `/tools/backup-em/session` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:1434](../server/src/routes/api/veeam.js#L1434) |
| POST | `/tools/backup-run/backup` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupRun.js:169](../server/src/routes/api/backupRun.js#L169) |
| POST | `/tools/backup-run/plan` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:161](../server/src/routes/api/backupRun.js#L161) |
| GET | `/tools/backup-run/portal-vms` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:93](../server/src/routes/api/backupManage.js#L93) |
| GET | `/tools/backup-run/runs` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:178](../server/src/routes/api/backupRun.js#L178) |
| GET | `/tools/backup-run/runs/:id` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:187](../server/src/routes/api/backupRun.js#L187) |
| POST | `/tools/backup-run/runs/:id/close` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupRun.js:198](../server/src/routes/api/backupRun.js#L198) |
| POST | `/tools/backup-run/servers/:id/repos` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/backupRun.js:237](../server/src/routes/api/backupRun.js#L237) |
| GET | `/tools/backup-run/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/backupRun.js:211](../server/src/routes/api/backupRun.js#L211) |
| PUT | `/tools/backup-run/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` · `reauth` | [server/src/routes/api/backupRun.js:224](../server/src/routes/api/backupRun.js#L224) |
| GET | `/tools/backup-run/vm/:vmId` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:111](../server/src/routes/api/backupManage.js#L111) |
| POST | `/tools/backup-run/vm/:vmId/delete-backup` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:183](../server/src/routes/api/backupManage.js#L183) |
| POST | `/tools/backup-run/vm/:vmId/exclude` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:164](../server/src/routes/api/backupManage.js#L164) |
| POST | `/tools/backup-run/vm/:vmId/points` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:129](../server/src/routes/api/backupManage.js#L129) |
| POST | `/tools/backup-run/vm/:vmId/restore` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:140](../server/src/routes/api/backupManage.js#L140) |
| GET | `/tools/backup-run/vms` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:130](../server/src/routes/api/backupRun.js#L130) |
| GET | `/tools/backup-summary` | 권한 `tools` | [server/src/routes/api/veeam.js:1300](../server/src/routes/api/veeam.js#L1300) |
| GET | `/tools/backup-summary.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1512](../server/src/routes/api/veeam.js#L1512) |
| GET | `/tools/backup-summary/alert` | 권한 `tools` | [server/src/routes/api/veeam.js:1359](../server/src/routes/api/veeam.js#L1359) |
| PUT | `/tools/backup-summary/alert` | 역할 `admin` · 권한 `tools` · `alertFullScope` | [server/src/routes/api/veeam.js:1367](../server/src/routes/api/veeam.js#L1367) |
| POST | `/tools/backup-summary/alert/send` | 역할 `admin` · 권한 `tools` · `alertFullScope` | [server/src/routes/api/veeam.js:1379](../server/src/routes/api/veeam.js#L1379) |
| GET | `/tools/backup-summary/errors` | 권한 `tools` | [server/src/routes/api/veeam.js:1337](../server/src/routes/api/veeam.js#L1337) |
| GET | `/tools/backup-summary/schedule` | 권한 `tools` | [server/src/routes/api/veeam.js:1329](../server/src/routes/api/veeam.js#L1329) |
| GET | `/tools/backup-summary/stale` | 권한 `tools` | [server/src/routes/api/veeam.js:1313](../server/src/routes/api/veeam.js#L1313) |
| GET | `/tools/backup-summary/stale.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1391](../server/src/routes/api/veeam.js#L1391) |
| GET | `/tools/bareos-backup` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:441](../server/src/routes/api/bareosBackup.js#L441) |
| GET | `/tools/bareos-backup/badges` | 권한 `tools` | [server/src/routes/api/bareosBackup.js:1785](../server/src/routes/api/bareosBackup.js#L1785) |
| GET | `/tools/bareos-backup/digest` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:1744](../server/src/routes/api/bareosBackup.js#L1744) |
| PUT | `/tools/bareos-backup/digest` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1748](../server/src/routes/api/bareosBackup.js#L1748) |
| POST | `/tools/bareos-backup/digest/send` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1758](../server/src/routes/api/bareosBackup.js#L1758) |
| GET | `/tools/bareos-backup/dr/check` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1438](../server/src/routes/api/bareosBackup.js#L1438) |
| GET | `/tools/bareos-backup/dr/runs` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1537](../server/src/routes/api/bareosBackup.js#L1537) |
| POST | `/tools/bareos-backup/dr/runs` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1521](../server/src/routes/api/bareosBackup.js#L1521) |
| POST | `/tools/bareos-backup/dr/runs/:id/resume` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1565](../server/src/routes/api/bareosBackup.js#L1565) |
| POST | `/tools/bareos-backup/dr/runs/:id/stop` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1557](../server/src/routes/api/bareosBackup.js#L1557) |
| POST | `/tools/bareos-backup/dr/runs/check` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1513](../server/src/routes/api/bareosBackup.js#L1513) |
| POST | `/tools/bareos-backup/groups` | 역할 `admin` · `textFields` | [server/src/routes/api/bareosGroups.js:272](../server/src/routes/api/bareosGroups.js#L272) |
| DELETE | `/tools/bareos-backup/groups/:id` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:329](../server/src/routes/api/bareosGroups.js#L329) |
| PUT | `/tools/bareos-backup/groups/:id` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:293](../server/src/routes/api/bareosGroups.js#L293) |
| POST | `/tools/bareos-backup/groups/:id/cancel` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:361](../server/src/routes/api/bareosGroups.js#L361) |
| POST | `/tools/bareos-backup/groups/:id/prune-preview` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:345](../server/src/routes/api/bareosGroups.js#L345) |
| POST | `/tools/bareos-backup/groups/:id/run` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:384](../server/src/routes/api/bareosGroups.js#L384) |
| GET | `/tools/bareos-backup/groups/options` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:260](../server/src/routes/api/bareosGroups.js#L260) |
| GET | `/tools/bareos-backup/groups/tree` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:183](../server/src/routes/api/bareosGroups.js#L183) |
| GET | `/tools/bareos-backup/health` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1595](../server/src/routes/api/bareosBackup.js#L1595) |
| POST | `/tools/bareos-backup/health/:vcenterId/thumb-accept` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1640](../server/src/routes/api/bareosBackup.js#L1640) |
| POST | `/tools/bareos-backup/health/run` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1608](../server/src/routes/api/bareosBackup.js#L1608) |
| GET | `/tools/bareos-backup/health/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:1653](../server/src/routes/api/bareosBackup.js#L1653) |
| PUT | `/tools/bareos-backup/health/settings` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1658](../server/src/routes/api/bareosBackup.js#L1658) |
| POST | `/tools/bareos-backup/jobs` | 역할 `admin` · `textFields` | [server/src/routes/api/bareosBackup.js:876](../server/src/routes/api/bareosBackup.js#L876) |
| DELETE | `/tools/bareos-backup/jobs/:id` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1024](../server/src/routes/api/bareosBackup.js#L1024) |
| PATCH | `/tools/bareos-backup/jobs/:id` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1002](../server/src/routes/api/bareosBackup.js#L1002) |
| POST | `/tools/bareos-backup/jobs/:id/cancel` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:954](../server/src/routes/api/bareosBackup.js#L954) |
| GET | `/tools/bareos-backup/jobs/:id/history` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1063](../server/src/routes/api/bareosBackup.js#L1063) |
| GET | `/tools/bareos-backup/jobs/:id/log` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1069](../server/src/routes/api/bareosBackup.js#L1069) |
| POST | `/tools/bareos-backup/jobs/:id/restore` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1111](../server/src/routes/api/bareosBackup.js#L1111) |
| GET | `/tools/bareos-backup/jobs/:id/restore-points` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1095](../server/src/routes/api/bareosBackup.js#L1095) |
| POST | `/tools/bareos-backup/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:928](../server/src/routes/api/bareosBackup.js#L928) |
| POST | `/tools/bareos-backup/jobs/bulk` | 역할 `admin` · `textFields` | [server/src/routes/api/bareosBackup.js:896](../server/src/routes/api/bareosBackup.js#L896) |
| GET | `/tools/bareos-backup/live` | 역할 `admin` | [server/src/routes/api/bareosLive.js:228](../server/src/routes/api/bareosLive.js#L228) |
| POST | `/tools/bareos-backup/logs/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1236](../server/src/routes/api/bareosBackup.js#L1236) |
| POST | `/tools/bareos-backup/policy/collect` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bareosPolicy.js:121](../server/src/routes/api/bareosPolicy.js#L121) |
| GET | `/tools/bareos-backup/policy/volumes` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bareosPolicy.js:91](../server/src/routes/api/bareosPolicy.js#L91) |
| POST | `/tools/bareos-backup/poll` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1767](../server/src/routes/api/bareosBackup.js#L1767) |
| GET | `/tools/bareos-backup/rehearsal` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1672](../server/src/routes/api/bareosBackup.js#L1672) |
| PUT | `/tools/bareos-backup/rehearsal` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1708](../server/src/routes/api/bareosBackup.js#L1708) |
| POST | `/tools/bareos-backup/rehearsal/run` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1721](../server/src/routes/api/bareosBackup.js#L1721) |
| POST | `/tools/bareos-backup/restore-check/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1329](../server/src/routes/api/bareosBackup.js#L1329) |
| GET | `/tools/bareos-backup/restore-folders` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1187](../server/src/routes/api/bareosBackup.js#L1187) |
| POST | `/tools/bareos-backup/restore-points/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1194](../server/src/routes/api/bareosBackup.js#L1194) |
| POST | `/tools/bareos-backup/restore/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1340](../server/src/routes/api/bareosBackup.js#L1340) |
| GET | `/tools/bareos-backup/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:534](../server/src/routes/api/bareosBackup.js#L534) |
| PUT | `/tools/bareos-backup/settings` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` · `textFields` | [server/src/routes/api/bareosBackup.js:571](../server/src/routes/api/bareosBackup.js#L571) |
| POST | `/tools/bareos-backup/settings/directors` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:599](../server/src/routes/api/bareosBackup.js#L599) |
| DELETE | `/tools/bareos-backup/settings/directors/:directorId` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:633](../server/src/routes/api/bareosBackup.js#L633) |
| PUT | `/tools/bareos-backup/settings/directors/:directorId` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:613](../server/src/routes/api/bareosBackup.js#L613) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/director` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:788](../server/src/routes/api/bareosBackup.js#L788) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:821](../server/src/routes/api/bareosBackup.js#L821) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-plugin` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:807](../server/src/routes/api/bareosBackup.js#L807) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-thumbprint` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:836](../server/src/routes/api/bareosBackup.js#L836) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/preflight` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:773](../server/src/routes/api/bareosBackup.js#L773) |
| GET | `/tools/bareos-backup/settings/directors/:directorId/catalog` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:703](../server/src/routes/api/bareosBackup.js#L703) |
| GET | `/tools/bareos-backup/settings/directors/:directorId/suggest` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:712](../server/src/routes/api/bareosBackup.js#L712) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:652](../server/src/routes/api/bareosBackup.js#L652) |
| GET | `/tools/bareos-backup/vm-candidates` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:851](../server/src/routes/api/bareosBackup.js#L851) |
| GET | `/tools/bareos-detail` | 권한 `tools` | [server/src/routes/api/bareosViews.js:195](../server/src/routes/api/bareosViews.js#L195) |
| GET | `/tools/bareos-detail.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/bareosViews.js:225](../server/src/routes/api/bareosViews.js#L225) |
| GET | `/tools/bareos-summary` | 권한 `tools` | [server/src/routes/api/bareosViews.js:188](../server/src/routes/api/bareosViews.js#L188) |
| GET | `/tools/bareos-summary.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/bareosViews.js:206](../server/src/routes/api/bareosViews.js#L206) |
| GET | `/tools/bareos-summary/policy` | 권한 `tools` | [server/src/routes/api/bareosPolicy.js:44](../server/src/routes/api/bareosPolicy.js#L44) |
| GET | `/tools/bareos-summary/pools` | 권한 `tools` | [server/src/routes/api/bareosPolicy.js:70](../server/src/routes/api/bareosPolicy.js#L70) |
| GET | `/tools/bm-folders` | 권한 `tools` | [server/src/routes/api/bmFolders.js:441](../server/src/routes/api/bmFolders.js#L441) |
| GET | `/tools/bm-folders.csv` | 권한 `tools`, `data.csv` | [server/src/routes/api/bmFolders.js:758](../server/src/routes/api/bmFolders.js#L758) |
| GET | `/tools/bm-folders/check` | 권한 `tools` | [server/src/routes/api/bmFolders.js:599](../server/src/routes/api/bmFolders.js#L599) |
| POST | `/tools/bm-folders/edge/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmFolders.js:431](../server/src/routes/api/bmFolders.js#L431) |
| GET | `/tools/bm-folders/hw` | 권한 `tools` | [server/src/routes/api/bmFolders.js:568](../server/src/routes/api/bmFolders.js#L568) |
| POST | `/tools/bm-folders/op` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmFolders.js:784](../server/src/routes/api/bmFolders.js#L784) |
| GET | `/tools/bm-folders/peer` | 권한 `tools` | [server/src/routes/api/bmFolders.js:638](../server/src/routes/api/bmFolders.js#L638) |
| GET | `/tools/bm-folders/search` | 권한 `tools` | [server/src/routes/api/bmFolders.js:535](../server/src/routes/api/bmFolders.js#L535) |
| GET | `/tools/bm-folders/trend` | 권한 `tools` | [server/src/routes/api/bmFolders.js:723](../server/src/routes/api/bmFolders.js#L723) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:131](../server/src/routes/api/bmstor.js#L131) |
| GET | `/tools/bm-storage/auth-choices` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/bmstor.js:576](../server/src/routes/api/bmstor.js#L576) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:680](../server/src/routes/api/bmstor.js#L680) |
| GET | `/tools/bm-storage/compare` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:156](../server/src/routes/api/bmstor.js#L156) |
| GET | `/tools/bm-storage/compare-set` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:384](../server/src/routes/api/bmstor.js#L384) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:613](../server/src/routes/api/bmstor.js#L613) |
| GET | `/tools/bm-storage/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:361](../server/src/routes/api/bmstor.js#L361) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `csvPerm` · `fullScopeOnly` · `textFields` | [server/src/routes/api/bmstor.js:633](../server/src/routes/api/bmstor.js#L633) |
| GET | `/tools/bm-storage/io/series` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:215](../server/src/routes/api/bmstor.js#L215) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:627](../server/src/routes/api/bmstor.js#L627) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/bmstor.js:548](../server/src/routes/api/bmstor.js#L548) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:597](../server/src/routes/api/bmstor.js#L597) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:604](../server/src/routes/api/bmstor.js#L604) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1014](../server/src/routes/api/bmUsage.js#L1014) |
| GET | `/tools/bm-usage/accounts` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:125](../server/src/routes/api/bmOnboard.js#L125) |
| POST | `/tools/bm-usage/accounts` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `textFields` · `accountFirst` · `reauth` | [server/src/routes/api/bmOnboard.js:149](../server/src/routes/api/bmOnboard.js#L149) |
| DELETE | `/tools/bm-usage/accounts/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:159](../server/src/routes/api/bmOnboard.js#L159) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1282](../server/src/routes/api/bmUsage.js#L1282) |
| GET | `/tools/bm-usage/annotations` | 권한 `tools` | [server/src/routes/api/bmAnnotations.js:192](../server/src/routes/api/bmAnnotations.js#L192) |
| POST | `/tools/bm-usage/annotations` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:196](../server/src/routes/api/bmAnnotations.js#L196) |
| DELETE | `/tools/bm-usage/annotations/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:198](../server/src/routes/api/bmAnnotations.js#L198) |
| PUT | `/tools/bm-usage/annotations/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:197](../server/src/routes/api/bmAnnotations.js#L197) |
| GET | `/tools/bm-usage/capacity` | 권한 `tools` | [server/src/routes/api/bmCapacity.js:112](../server/src/routes/api/bmCapacity.js#L112) |
| GET | `/tools/bm-usage/capacity/:key` | 권한 `tools` | [server/src/routes/api/bmCapacity.js:113](../server/src/routes/api/bmCapacity.js#L113) |
| POST | `/tools/bm-usage/capacity/recompute` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCapacity.js:114](../server/src/routes/api/bmCapacity.js#L114) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1253](../server/src/routes/api/bmUsage.js#L1253) |
| GET | `/tools/bm-usage/collect-health` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCollectHealth.js:173](../server/src/routes/api/bmCollectHealth.js#L173) |
| GET | `/tools/bm-usage/compare` | 권한 `tools` | [server/src/routes/api/bmCompare.js:267](../server/src/routes/api/bmCompare.js#L267) |
| POST | `/tools/bm-usage/compare/focus` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:268](../server/src/routes/api/bmCompare.js#L268) |
| GET | `/tools/bm-usage/compare/sets` | 권한 `tools` | [server/src/routes/api/bmCompare.js:269](../server/src/routes/api/bmCompare.js#L269) |
| PUT | `/tools/bm-usage/compare/sets` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:270](../server/src/routes/api/bmCompare.js#L270) |
| DELETE | `/tools/bm-usage/compare/sets/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:271](../server/src/routes/api/bmCompare.js#L271) |
| PUT | `/tools/bm-usage/distribute` | 역할 `admin` · `fleetOnly` · `distOwnerOnly` | [server/src/routes/api/bmUsage.js:1489](../server/src/routes/api/bmUsage.js#L1489) |
| PUT | `/tools/bm-usage/distribute/edge` | 역할 `admin` · `fleetOnly` · `distOwnerOnly` | [server/src/routes/api/bmUsage.js:1519](../server/src/routes/api/bmUsage.js#L1519) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1340](../server/src/routes/api/bmUsage.js#L1340) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1427](../server/src/routes/api/bmUsage.js#L1427) |
| GET | `/tools/bm-usage/faults` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1153](../server/src/routes/api/bmUsage.js#L1153) |
| GET | `/tools/bm-usage/focus` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:298](../server/src/routes/api/bmPerfOps.js#L298) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1210](../server/src/routes/api/bmUsage.js#L1210) |
| GET | `/tools/bm-usage/idle` | 권한 `tools` | [server/src/routes/api/bmIdle.js:173](../server/src/routes/api/bmIdle.js#L173) |
| POST | `/tools/bm-usage/idle/recompute` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmIdle.js:177](../server/src/routes/api/bmIdle.js#L177) |
| POST | `/tools/bm-usage/idle/review` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmIdle.js:174](../server/src/routes/api/bmIdle.js#L174) |
| GET | `/tools/bm-usage/key-overlaps` | 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:146](../server/src/routes/api/bmKeyOverlaps.js#L146) |
| DELETE | `/tools/bm-usage/key-overlaps/decision` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:150](../server/src/routes/api/bmKeyOverlaps.js#L150) |
| POST | `/tools/bm-usage/key-overlaps/decision` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:149](../server/src/routes/api/bmKeyOverlaps.js#L149) |
| GET | `/tools/bm-usage/logs` | 권한 `tools` | [server/src/routes/api/bmLogs.js:154](../server/src/routes/api/bmLogs.js#L154) |
| GET | `/tools/bm-usage/maintenance` | 권한 `tools` | [server/src/routes/api/bmMaint.js:335](../server/src/routes/api/bmMaint.js#L335) |
| POST | `/tools/bm-usage/maintenance` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:346](../server/src/routes/api/bmMaint.js#L346) |
| DELETE | `/tools/bm-usage/maintenance/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:350](../server/src/routes/api/bmMaint.js#L350) |
| PUT | `/tools/bm-usage/maintenance/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:347](../server/src/routes/api/bmMaint.js#L347) |
| POST | `/tools/bm-usage/maintenance/:id/confirm` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:349](../server/src/routes/api/bmMaint.js#L349) |
| POST | `/tools/bm-usage/maintenance/:id/end` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:348](../server/src/routes/api/bmMaint.js#L348) |
| GET | `/tools/bm-usage/maintenance/occurrences` | 권한 `tools` | [server/src/routes/api/bmMaint.js:339](../server/src/routes/api/bmMaint.js#L339) |
| POST | `/tools/bm-usage/maintenance/preview` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:343](../server/src/routes/api/bmMaint.js#L343) |
| POST | `/tools/bm-usage/onboard/analyze` | 역할 `admin` · 권한 `tools`, `data.csv` · `noDemo` | [server/src/routes/api/bmOnboard.js:226](../server/src/routes/api/bmOnboard.js#L226) |
| POST | `/tools/bm-usage/onboard/apply` | 역할 `admin` · 권한 `tools`, `data.csv` · `noDemo` | [server/src/routes/api/bmOnboard.js:242](../server/src/routes/api/bmOnboard.js#L242) |
| GET | `/tools/bm-usage/onboard/codes` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:364](../server/src/routes/api/bmOnboard.js#L364) |
| DELETE | `/tools/bm-usage/onboard/edge-rows` | 역할 `admin` · 권한 `tools` · `noDemo` | [server/src/routes/api/bmOnboard.js:293](../server/src/routes/api/bmOnboard.js#L293) |
| GET | `/tools/bm-usage/onboard/edge-rows` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:271](../server/src/routes/api/bmOnboard.js#L271) |
| GET | `/tools/bm-usage/onboard/missing` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:308](../server/src/routes/api/bmOnboard.js#L308) |
| GET | `/tools/bm-usage/onboard/template.csv` | 역할 `admin` · 권한 `tools`, `data.csv` | [server/src/routes/api/bmOnboard.js:214](../server/src/routes/api/bmOnboard.js#L214) |
| POST | `/tools/bm-usage/onboard/test` | 역할 `admin` · 권한 `tools` · `noDemo` · `textFields` | [server/src/routes/api/bmOnboard.js:349](../server/src/routes/api/bmOnboard.js#L349) |
| GET | `/tools/bm-usage/perf-rules` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:308](../server/src/routes/api/bmPerfOps.js#L308) |
| PUT | `/tools/bm-usage/perf-rules` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmPerfOps.js:309](../server/src/routes/api/bmPerfOps.js#L309) |
| POST | `/tools/bm-usage/perf-rules/dry-run` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/bmPerfOps.js:310](../server/src/routes/api/bmPerfOps.js#L310) |
| GET | `/tools/bm-usage/perf/:key` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1126](../server/src/routes/api/bmUsage.js#L1126) |
| GET | `/tools/bm-usage/perf/:key/devices` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1130](../server/src/routes/api/bmUsage.js#L1130) |
| GET | `/tools/bm-usage/perf/:key/faults` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1149](../server/src/routes/api/bmUsage.js#L1149) |
| GET | `/tools/bm-usage/perf/:key/focus` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:299](../server/src/routes/api/bmPerfOps.js#L299) |
| POST | `/tools/bm-usage/perf/:key/focus` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmPerfOps.js:301](../server/src/routes/api/bmPerfOps.js#L301) |
| GET | `/tools/bm-usage/perf/:key/focus/:id` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:300](../server/src/routes/api/bmPerfOps.js#L300) |
| POST | `/tools/bm-usage/perf/:key/focus/:id/stop` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmPerfOps.js:302](../server/src/routes/api/bmPerfOps.js#L302) |
| GET | `/tools/bm-usage/perf/:key/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1129](../server/src/routes/api/bmUsage.js#L1129) |
| GET | `/tools/bm-usage/perf/:key/logs` | 권한 `tools` | [server/src/routes/api/bmLogs.js:155](../server/src/routes/api/bmLogs.js#L155) |
| GET | `/tools/bm-usage/perf/:key/playbook` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:199](../server/src/routes/api/bmPlaybookSlo.js#L199) |
| GET | `/tools/bm-usage/perf/:key/ports` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1132](../server/src/routes/api/bmUsage.js#L1132) |
| GET | `/tools/bm-usage/perf/:key/profile` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1144](../server/src/routes/api/bmUsage.js#L1144) |
| GET | `/tools/bm-usage/perf/:key/slo` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:200](../server/src/routes/api/bmPlaybookSlo.js#L200) |
| POST | `/tools/bm-usage/perf/:key/snapshot` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1157](../server/src/routes/api/bmUsage.js#L1157) |
| GET | `/tools/bm-usage/perf/:key/snapshots` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1165](../server/src/routes/api/bmUsage.js#L1165) |
| GET | `/tools/bm-usage/perf/:key/snapshots/:id` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1166](../server/src/routes/api/bmUsage.js#L1166) |
| GET | `/tools/bm-usage/perf/:key/top` | 권한 `tools` | [server/src/routes/api/bmTop.js:127](../server/src/routes/api/bmTop.js#L127) |
| GET | `/tools/bm-usage/perf/:key/top/band` | 권한 `tools` | [server/src/routes/api/bmTop.js:128](../server/src/routes/api/bmTop.js#L128) |
| GET | `/tools/bm-usage/perf/:key/tuning` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1143](../server/src/routes/api/bmUsage.js#L1143) |
| GET | `/tools/bm-usage/playbooks` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:198](../server/src/routes/api/bmPlaybookSlo.js#L198) |
| DELETE | `/tools/bm-usage/port-map` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1207](../server/src/routes/api/bmUsage.js#L1207) |
| PUT | `/tools/bm-usage/port-map` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1206](../server/src/routes/api/bmUsage.js#L1206) |
| GET | `/tools/bm-usage/power` | 권한 `tools` | [server/src/routes/api/bmPower.js:137](../server/src/routes/api/bmPower.js#L137) |
| GET | `/tools/bm-usage/profiles` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1145](../server/src/routes/api/bmUsage.js#L1145) |
| PUT | `/tools/bm-usage/purpose` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1146](../server/src/routes/api/bmUsage.js#L1146) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:1566](../server/src/routes/api/bmUsage.js#L1566) |
| GET | `/tools/bm-usage/slo` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:201](../server/src/routes/api/bmPlaybookSlo.js#L201) |
| PUT | `/tools/bm-usage/slo` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmPlaybookSlo.js:202](../server/src/routes/api/bmPlaybookSlo.js#L202) |
| GET | `/tools/bm-usage/ssh-keys` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:79](../server/src/routes/api/bmOnboard.js#L79) |
| POST | `/tools/bm-usage/ssh-keys` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `keyVaultFirst` · `reauth` | [server/src/routes/api/bmOnboard.js:86](../server/src/routes/api/bmOnboard.js#L86) |
| DELETE | `/tools/bm-usage/ssh-keys/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:118](../server/src/routes/api/bmOnboard.js#L118) |
| PUT | `/tools/bm-usage/ssh-keys/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:94](../server/src/routes/api/bmOnboard.js#L94) |
| POST | `/tools/bm-usage/ssh-keys/:id/passphrase` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:101](../server/src/routes/api/bmOnboard.js#L101) |
| POST | `/tools/bm-usage/ssh-keys/rotate` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:108](../server/src/routes/api/bmOnboard.js#L108) |
| PUT | `/tools/bm-usage/tuning/overrides` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmUsage.js:1147](../server/src/routes/api/bmUsage.js#L1147) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:106](../server/src/routes/api/toolsCapacity.js#L106) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1935](../server/src/routes/api/toolsCapacity.js#L1935) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1845](../server/src/routes/api/toolsCapacity.js#L1845) |
| GET | `/tools/cluster-check` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:36](../server/src/routes/api/clusterCheck.js#L36) |
| GET | `/tools/cluster-check.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/clusterCheck.js:62](../server/src/routes/api/clusterCheck.js#L62) |
| GET | `/tools/cluster-check/of` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:49](../server/src/routes/api/clusterCheck.js#L49) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:108](../server/src/routes/api/commMap.js#L108) |
| GET | `/tools/contention` | 권한 `tools` | [server/src/routes/api/contention.js:34](../server/src/routes/api/contention.js#L34) |
| GET | `/tools/contention.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/contention.js:64](../server/src/routes/api/contention.js#L64) |
| GET | `/tools/core-license` | 권한 `tools` | [server/src/routes/api/coreLicense.js:28](../server/src/routes/api/coreLicense.js#L28) |
| GET | `/tools/core-license.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/coreLicense.js:33](../server/src/routes/api/coreLicense.js#L33) |
| GET | `/tools/corp-usage` | 권한 `tools` | [server/src/routes/api/corpUsage.js:97](../server/src/routes/api/corpUsage.js#L97) |
| GET | `/tools/cost-showback` | 권한 `tools` | [server/src/routes/api/costShowback.js:39](../server/src/routes/api/costShowback.js#L39) |
| GET | `/tools/cost-showback.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/costShowback.js:61](../server/src/routes/api/costShowback.js#L61) |
| GET | `/tools/cost-showback/settings` | 권한 `tools` | [server/src/routes/api/costShowback.js:45](../server/src/routes/api/costShowback.js#L45) |
| PUT | `/tools/cost-showback/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/costShowback.js:50](../server/src/routes/api/costShowback.js#L50) |
| GET | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:29](../server/src/routes/api/credentials.js#L29) |
| POST | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:39](../server/src/routes/api/credentials.js#L39) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:59](../server/src/routes/api/credentials.js#L59) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:49](../server/src/routes/api/credentials.js#L49) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:69](../server/src/routes/api/credentials.js#L69) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/credentials.js:34](../server/src/routes/api/credentials.js#L34) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:334](../server/src/routes/api/horizonSessions.js#L334) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:57](../server/src/routes/api/curUser.js#L57) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:123](../server/src/routes/api/curUser.js#L123) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:240](../server/src/routes/api/curUser.js#L240) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:138](../server/src/routes/api/curUser.js#L138) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:92](../server/src/routes/api/curUser.js#L92) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:149](../server/src/routes/api/curUser.js#L149) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:191](../server/src/routes/api/curUser.js#L191) |
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:291](../server/src/routes/api/cvp.js#L291) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:872](../server/src/routes/api/cvp.js#L872) |
| GET | `/tools/cvp/compare` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:436](../server/src/routes/api/cvpNet.js#L436) |
| GET | `/tools/cvp/compliance` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:338](../server/src/routes/api/cvpNet.js#L338) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:388](../server/src/routes/api/cvp.js#L388) |
| GET | `/tools/cvp/device-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:526](../server/src/routes/api/cvp.js#L526) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:321](../server/src/routes/api/cvp.js#L321) |
| GET | `/tools/cvp/devices.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:832](../server/src/routes/api/cvp.js#L832) |
| GET | `/tools/cvp/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:543](../server/src/routes/api/cvp.js#L543) |
| GET | `/tools/cvp/faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:758](../server/src/routes/api/cvp.js#L758) |
| POST | `/tools/cvp/faults/close` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:798](../server/src/routes/api/cvp.js#L798) |
| POST | `/tools/cvp/faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:786](../server/src/routes/api/cvp.js#L786) |
| GET | `/tools/cvp/linkq` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:103](../server/src/routes/api/cvpNet.js#L103) |
| GET | `/tools/cvp/locate` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:263](../server/src/routes/api/cvpNet.js#L263) |
| GET | `/tools/cvp/optics` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:594](../server/src/routes/api/cvp.js#L594) |
| GET | `/tools/cvp/optics/trend` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:211](../server/src/routes/api/cvpNet.js#L211) |
| GET | `/tools/cvp/overview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:344](../server/src/routes/api/cvp.js#L344) |
| POST | `/tools/cvp/parse-preview` | 역할 `admin` · 권한 `tools` · `fullScopeReadPost` | [server/src/routes/api/cvp.js:819](../server/src/routes/api/cvp.js#L819) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:857](../server/src/routes/api/cvp.js#L857) |
| GET | `/tools/cvp/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:730](../server/src/routes/api/cvp.js#L730) |
| GET | `/tools/cvp/portmap` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:448](../server/src/routes/api/cvp.js#L448) |
| GET | `/tools/cvp/portmap/summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:483](../server/src/routes/api/cvp.js#L483) |
| GET | `/tools/cvp/portplan/forecast` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:156](../server/src/routes/api/cvpNet.js#L156) |
| GET | `/tools/cvp/portplan/reclaim` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:130](../server/src/routes/api/cvpNet.js#L130) |
| GET | `/tools/cvp/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:664](../server/src/routes/api/cvp.js#L664) |
| GET | `/tools/cvp/redundancy` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:349](../server/src/routes/api/cvpNet.js#L349) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:895](../server/src/routes/api/cvp.js#L895) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:924](../server/src/routes/api/cvp.js#L924) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:927](../server/src/routes/api/cvp.js#L927) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:925](../server/src/routes/api/cvp.js#L925) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:940](../server/src/routes/api/cvp.js#L940) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:968](../server/src/routes/api/cvp.js#L968) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:972](../server/src/routes/api/cvp.js#L972) |
| GET | `/tools/cvp/snapshots` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:389](../server/src/routes/api/cvpNet.js#L389) |
| POST | `/tools/cvp/snapshots` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:397](../server/src/routes/api/cvpNet.js#L397) |
| DELETE | `/tools/cvp/snapshots/:id` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:422](../server/src/routes/api/cvpNet.js#L422) |
| GET | `/tools/cvp/topology` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvpNet.js:237](../server/src/routes/api/cvpNet.js#L237) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:64](../server/src/routes/api/dataFlow.js#L64) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:200](../server/src/routes/api/checksLogs.js#L200) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:30](../server/src/routes/api/deviceFlow.js#L30) |
| GET | `/tools/disk-bad` | 권한 `tools` | [server/src/routes/api/diskBad.js:241](../server/src/routes/api/diskBad.js#L241) |
| GET | `/tools/disk-bad/jobs` | 권한 `tools` | [server/src/routes/api/diskBad.js:272](../server/src/routes/api/diskBad.js#L272) |
| POST | `/tools/disk-bad/jobs/:id/retry` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/diskBad.js:366](../server/src/routes/api/diskBad.js#L366) |
| POST | `/tools/disk-bad/jobs/:id/stop` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/diskBad.js:353](../server/src/routes/api/diskBad.js#L353) |
| POST | `/tools/disk-bad/scan` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/diskBad.js:295](../server/src/routes/api/diskBad.js#L295) |
| GET | `/tools/disk-bad/server/:id` | 권한 `tools` | [server/src/routes/api/diskBad.js:276](../server/src/routes/api/diskBad.js#L276) |
| PUT | `/tools/disk-bad/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/diskBad.js:377](../server/src/routes/api/diskBad.js#L377) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:55](../server/src/routes/api/vcTools.js#L55) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:111](../server/src/routes/api/edgeLog.js#L111) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:123](../server/src/routes/api/edgeLog.js#L123) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:172](../server/src/routes/api/edgeLog.js#L172) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/edgeLog.js:140](../server/src/routes/api/edgeLog.js#L140) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:460](../server/src/routes/api/hardwareGpu.js#L460) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1516](../server/src/routes/api/toolsCapacity.js#L1516) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1653](../server/src/routes/api/toolsCapacity.js#L1653) |
| GET | `/tools/esxi-temp/sensors` | 권한 `tools` | [server/src/routes/api/serverSensors.js:138](../server/src/routes/api/serverSensors.js#L138) |
| GET | `/tools/esxi-temp/sensors/:id` | 권한 `tools` | [server/src/routes/api/serverSensors.js:181](../server/src/routes/api/serverSensors.js#L181) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` · `textFields` | [server/src/routes/api/toolsCapacity.js:1736](../server/src/routes/api/toolsCapacity.js#L1736) |
| GET | `/tools/focus-mon` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:154](../server/src/routes/api/focusMon.js#L154) |
| GET | `/tools/focus-mon/alerts` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:705](../server/src/routes/api/focusMon.js#L705) |
| POST | `/tools/focus-mon/alerts/preview` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/focusMon.js:757](../server/src/routes/api/focusMon.js#L757) |
| POST | `/tools/focus-mon/alerts/rules` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` · `ruleWrite` | [server/src/routes/api/focusMon.js:753](../server/src/routes/api/focusMon.js#L753) |
| DELETE | `/tools/focus-mon/alerts/rules/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `ruleWrite` | [server/src/routes/api/focusMon.js:755](../server/src/routes/api/focusMon.js#L755) |
| PUT | `/tools/focus-mon/alerts/rules/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `ruleWrite` | [server/src/routes/api/focusMon.js:754](../server/src/routes/api/focusMon.js#L754) |
| GET | `/tools/focus-mon/apps` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:778](../server/src/routes/api/focusMon.js#L778) |
| GET | `/tools/focus-mon/audit` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:118](../server/src/routes/api/focusMonAudit.js#L118) |
| GET | `/tools/focus-mon/audit/:id/runs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:275](../server/src/routes/api/focusMonAudit.js#L275) |
| POST | `/tools/focus-mon/audit/install` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:166](../server/src/routes/api/focusMonAudit.js#L166) |
| PUT | `/tools/focus-mon/audit/install-dir` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:154](../server/src/routes/api/focusMonAudit.js#L154) |
| GET | `/tools/focus-mon/audit/install.sh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:325](../server/src/routes/api/focusMonAudit.js#L325) |
| GET | `/tools/focus-mon/audit/jobs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:265](../server/src/routes/api/focusMonAudit.js#L265) |
| POST | `/tools/focus-mon/audit/run` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMonAudit.js:337](../server/src/routes/api/focusMonAudit.js#L337) |
| GET | `/tools/focus-mon/audit/run/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:286](../server/src/routes/api/focusMonAudit.js#L286) |
| GET | `/tools/focus-mon/audit/run/:runId/report.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:310](../server/src/routes/api/focusMonAudit.js#L310) |
| GET | `/tools/focus-mon/changes` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:559](../server/src/routes/api/focusMon.js#L559) |
| GET | `/tools/focus-mon/coverage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:812](../server/src/routes/api/focusMon.js#L812) |
| GET | `/tools/focus-mon/data` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:526](../server/src/routes/api/focusMon.js#L526) |
| POST | `/tools/focus-mon/edges/:agent/wake` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:368](../server/src/routes/api/focusMon.js#L368) |
| POST | `/tools/focus-mon/events` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:574](../server/src/routes/api/focusMon.js#L574) |
| DELETE | `/tools/focus-mon/events/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:589](../server/src/routes/api/focusMon.js#L589) |
| GET | `/tools/focus-mon/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:823](../server/src/routes/api/focusMon.js#L823) |
| POST | `/tools/focus-mon/groups` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:234](../server/src/routes/api/focusMon.js#L234) |
| DELETE | `/tools/focus-mon/groups/:name` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:250](../server/src/routes/api/focusMon.js#L250) |
| PUT | `/tools/focus-mon/groups/:name` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:241](../server/src/routes/api/focusMon.js#L241) |
| POST | `/tools/focus-mon/key` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:436](../server/src/routes/api/focusMon.js#L436) |
| GET | `/tools/focus-mon/load` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:609](../server/src/routes/api/focusMon.js#L609) |
| GET | `/tools/focus-mon/prep` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:207](../server/src/routes/api/focusMonAudit.js#L207) |
| POST | `/tools/focus-mon/prep` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:238](../server/src/routes/api/focusMonAudit.js#L238) |
| GET | `/tools/focus-mon/proc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:793](../server/src/routes/api/focusMon.js#L793) |
| GET | `/tools/focus-mon/procs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:679](../server/src/routes/api/focusMon.js#L679) |
| POST | `/tools/focus-mon/sessions` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:454](../server/src/routes/api/focusMon.js#L454) |
| DELETE | `/tools/focus-mon/sessions/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:511](../server/src/routes/api/focusMon.js#L511) |
| POST | `/tools/focus-mon/sessions/:id/extend` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:504](../server/src/routes/api/focusMon.js#L504) |
| POST | `/tools/focus-mon/sessions/:id/targets` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:476](../server/src/routes/api/focusMon.js#L476) |
| DELETE | `/tools/focus-mon/sessions/:id/targets/:tid` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:491](../server/src/routes/api/focusMon.js#L491) |
| PUT | `/tools/focus-mon/settings` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:444](../server/src/routes/api/focusMon.js#L444) |
| POST | `/tools/focus-mon/targets` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:198](../server/src/routes/api/focusMon.js#L198) |
| DELETE | `/tools/focus-mon/targets/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:219](../server/src/routes/api/focusMon.js#L219) |
| PUT | `/tools/focus-mon/targets/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:206](../server/src/routes/api/focusMon.js#L206) |
| POST | `/tools/focus-mon/targets/:id/retry` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:410](../server/src/routes/api/focusMon.js#L410) |
| POST | `/tools/focus-mon/targets/:id/test` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:382](../server/src/routes/api/focusMon.js#L382) |
| GET | `/tools/focus-mon/targets/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:305](../server/src/routes/api/focusMon.js#L305) |
| POST | `/tools/focus-mon/targets/group` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:261](../server/src/routes/api/focusMon.js#L261) |
| POST | `/tools/focus-mon/targets/import` | 역할 `admin` · 권한 `data.csv` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:291](../server/src/routes/api/focusMon.js#L291) |
| POST | `/tools/focus-mon/targets/import/preview` | 역할 `admin` · 권한 `data.csv` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:280](../server/src/routes/api/focusMon.js#L280) |
| POST | `/tools/focus-mon/targets/move` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `textFields` | [server/src/routes/api/focusMon.js:349](../server/src/routes/api/focusMon.js#L349) |
| POST | `/tools/focus-mon/targets/test-bulk` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:326](../server/src/routes/api/focusMon.js#L326) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:479](../server/src/routes/api/hardwareGpu.js#L479) |
| GET | `/tools/gpu-alloc` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:533](../server/src/routes/api/hardwareGpu.js#L533) |
| GET | `/tools/gpu-alloc.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:554](../server/src/routes/api/hardwareGpu.js#L554) |
| GET | `/tools/gpu-alloc.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:558](../server/src/routes/api/hardwareGpu.js#L558) |
| GET | `/tools/gpu-alloc/diag` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:582](../server/src/routes/api/hardwareGpu.js#L582) |
| GET | `/tools/gpu-alloc/export-meta` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:538](../server/src/routes/api/hardwareGpu.js#L538) |
| GET | `/tools/gpu-alloc/history` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:590](../server/src/routes/api/hardwareGpu.js#L590) |
| GET | `/tools/gpu.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:495](../server/src/routes/api/hardwareGpu.js#L495) |
| GET | `/tools/gpu.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:487](../server/src/routes/api/hardwareGpu.js#L487) |
| GET | `/tools/gpu/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:633](../server/src/routes/api/hardwareGpu.js#L633) |
| GET | `/tools/gpu/export.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:634](../server/src/routes/api/hardwareGpu.js#L634) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:176](../server/src/routes/api/toolsAnalytics.js#L176) |
| GET | `/tools/gpu/host` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:674](../server/src/routes/api/hardwareGpu.js#L674) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:609](../server/src/routes/api/hardwareGpu.js#L609) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:690](../server/src/routes/api/hardwareGpu.js#L690) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:557](../server/src/routes/api/toolsCapacity.js#L557) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:42](../server/src/routes/api/toolsGuestDisk.js#L42) |
| GET | `/tools/guest-disk/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:98](../server/src/routes/api/toolsGuestDisk.js#L98) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:86](../server/src/routes/api/toolsGuestDisk.js#L86) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:80](../server/src/routes/api/toolsGuestDisk.js#L80) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:54](../server/src/routes/api/toolsGuestDisk.js#L54) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:49](../server/src/routes/api/toolsInfo.js#L49) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:67](../server/src/routes/api/toolsInfo.js#L67) |
| GET | `/tools/guest-partition` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:53](../server/src/routes/api/toolsGuestPart.js#L53) |
| GET | `/tools/guest-partition/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestPart.js:78](../server/src/routes/api/toolsGuestPart.js#L78) |
| GET | `/tools/guest-partition/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:112](../server/src/routes/api/toolsGuestPart.js#L112) |
| POST | `/tools/guest-partition/mail/preview` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/toolsGuestPart.js:118](../server/src/routes/api/toolsGuestPart.js#L118) |
| POST | `/tools/guest-partition/mail/send` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/toolsGuestPart.js:124](../server/src/routes/api/toolsGuestPart.js#L124) |
| POST | `/tools/guest-partition/mail/test` | 역할 `admin` · `fullScopeOnly` · `listOrText` | [server/src/routes/api/toolsGuestPart.js:133](../server/src/routes/api/toolsGuestPart.js#L133) |
| GET | `/tools/guest-partition/settings` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:93](../server/src/routes/api/toolsGuestPart.js#L93) |
| PUT | `/tools/guest-partition/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:103](../server/src/routes/api/toolsGuestPart.js#L103) |
| GET | `/tools/guest-partition/vcenter/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:69](../server/src/routes/api/toolsGuestPart.js#L69) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:428](../server/src/routes/api/hardwareGpu.js#L428) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:92](../server/src/routes/api/toolsInfo.js#L92) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:202](../server/src/routes/api/horizonSessions.js#L202) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:256](../server/src/routes/api/horizonSessions.js#L256) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:269](../server/src/routes/api/horizonSessions.js#L269) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:240](../server/src/routes/api/horizonSessions.js#L240) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:279](../server/src/routes/api/horizonSessions.js#L279) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:301](../server/src/routes/api/horizonSessions.js#L301) |
| GET | `/tools/horizon-sessions/usage` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:165](../server/src/routes/api/horizonSessions.js#L165) |
| GET | `/tools/horizon-sessions/usage.csv` | 권한 `data.csv` | [server/src/routes/api/horizonSessions.js:180](../server/src/routes/api/horizonSessions.js#L180) |
| POST | `/tools/host-export.xlsx` | 권한 `data.csv` | [server/src/routes/api/hostExport.js:152](../server/src/routes/api/hostExport.js#L152) |
| GET | `/tools/host-export/status` | 권한 `data.csv` | [server/src/routes/api/hostExport.js:127](../server/src/routes/api/hostExport.js#L127) |
| GET | `/tools/host-hygiene` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:49](../server/src/routes/api/hostHygiene.js#L49) |
| GET | `/tools/host-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hostHygiene.js:100](../server/src/routes/api/hostHygiene.js#L100) |
| GET | `/tools/host-hygiene/reboots` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:73](../server/src/routes/api/hostHygiene.js#L73) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:39](../server/src/routes/api/toolsAnalytics.js#L39) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:664](../server/src/routes/api/hardwareGpu.js#L664) |
| POST | `/tools/ip-ping` | 권한 `tools` · `textFields` | [server/src/routes/api/hardwareGpu.js:639](../server/src/routes/api/hardwareGpu.js#L639) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:163](../server/src/routes/api/ipamExport.js#L163) |
| GET | `/tools/ipam.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:585](../server/src/routes/api/ipamExport.js#L585) |
| GET | `/tools/ipam.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:551](../server/src/routes/api/ipamExport.js#L551) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:310](../server/src/routes/api/ipamExport.js#L310) |
| PUT | `/tools/ipam/annotation` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/ipamExport.js:322](../server/src/routes/api/ipamExport.js#L322) |
| POST | `/tools/ipam/bulk` | 역할 `admin/operator` · 권한 `tools` · `listOrText` | [server/src/routes/api/ipamExport.js:397](../server/src/routes/api/ipamExport.js#L397) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:221](../server/src/routes/api/ipamExport.js#L221) |
| GET | `/tools/ipam/hostnames` | 권한 `tools` | [server/src/routes/api/ipamServer.js:79](../server/src/routes/api/ipamServer.js#L79) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:179](../server/src/routes/api/ipamExport.js#L179) |
| DELETE | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:381](../server/src/routes/api/ipamExport.js#L381) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:352](../server/src/routes/api/ipamExport.js#L352) |
| PUT | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:366](../server/src/routes/api/ipamExport.js#L366) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:340](../server/src/routes/api/ipamExport.js#L340) |
| GET | `/tools/ipam/manage.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:637](../server/src/routes/api/ipamExport.js#L637) |
| POST | `/tools/ipam/manage/import` | 역할 `admin/operator` · 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:663](../server/src/routes/api/ipamExport.js#L663) |
| GET | `/tools/ipam/manage/sample.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:652](../server/src/routes/api/ipamExport.js#L652) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:267](../server/src/routes/api/ipamExport.js#L267) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:431](../server/src/routes/api/ipamExport.js#L431) |
| POST | `/tools/ipam/policies` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/ipamExport.js:464](../server/src/routes/api/ipamExport.js#L464) |
| DELETE | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:523](../server/src/routes/api/ipamExport.js#L523) |
| PUT | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/ipamExport.js:488](../server/src/routes/api/ipamExport.js#L488) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:440](../server/src/routes/api/ipamExport.js#L440) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:457](../server/src/routes/api/ipamExport.js#L457) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:278](../server/src/routes/api/ipamExport.js#L278) |
| GET | `/tools/ipam/server` | 권한 `tools` | [server/src/routes/api/ipamServer.js:68](../server/src/routes/api/ipamServer.js#L68) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:210](../server/src/routes/api/ipamExport.js#L210) |
| PUT | `/tools/ipam/subnet-note` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:195](../server/src/routes/api/ipamExport.js#L195) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:189](../server/src/routes/api/ipamExport.js#L189) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:231](../server/src/routes/api/ipamExport.js#L231) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:254](../server/src/routes/api/ipamExport.js#L254) |
| GET | `/tools/isilon-dirusage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:120](../server/src/routes/api/isilonDirUsage.js#L120) |
| POST | `/tools/isilon-dirusage/bulk` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:247](../server/src/routes/api/isilonDirUsage.js#L247) |
| GET | `/tools/isilon-dirusage/digest` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:374](../server/src/routes/api/isilonDirUsage.js#L374) |
| PUT | `/tools/isilon-dirusage/digest` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:376](../server/src/routes/api/isilonDirUsage.js#L376) |
| POST | `/tools/isilon-dirusage/digest/preview` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:394](../server/src/routes/api/isilonDirUsage.js#L394) |
| POST | `/tools/isilon-dirusage/digest/send-now` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:386](../server/src/routes/api/isilonDirUsage.js#L386) |
| GET | `/tools/isilon-dirusage/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:190](../server/src/routes/api/isilonDirUsage.js#L190) |
| POST | `/tools/isilon-dirusage/key` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:401](../server/src/routes/api/isilonDirUsage.js#L401) |
| POST | `/tools/isilon-dirusage/mail-now` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:345](../server/src/routes/api/isilonDirUsage.js#L345) |
| GET | `/tools/isilon-dirusage/overview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:146](../server/src/routes/api/isilonDirUsage.js#L146) |
| GET | `/tools/isilon-dirusage/report` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:161](../server/src/routes/api/isilonDirUsage.js#L161) |
| POST | `/tools/isilon-dirusage/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:282](../server/src/routes/api/isilonDirUsage.js#L282) |
| GET | `/tools/isilon-dirusage/settings` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:216](../server/src/routes/api/isilonDirUsage.js#L216) |
| PUT | `/tools/isilon-dirusage/settings` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:231](../server/src/routes/api/isilonDirUsage.js#L231) |
| POST | `/tools/isilon-dirusage/test` | 역할 `admin` · `fullScopeOnly` · `requireSuperAdmin` | [server/src/routes/api/isilonDirUsage.js:310](../server/src/routes/api/isilonDirUsage.js#L310) |
| GET | `/tools/isilon-dirusage/trend` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:180](../server/src/routes/api/isilonDirUsage.js#L180) |
| GET | `/tools/isilon-dirusage/users` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/isilonDirUsage.js:169](../server/src/routes/api/isilonDirUsage.js#L169) |
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:189](../server/src/routes/api/toolsInfo.js#L189) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:116](../server/src/routes/api/toolsInfo.js#L116) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:55](../server/src/routes/api/linkCheck.js#L55) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:195](../server/src/routes/api/linkCheck.js#L195) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:180](../server/src/routes/api/linkCheck.js#L180) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:167](../server/src/routes/api/linkCheck.js#L167) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:205](../server/src/routes/api/linkCheck.js#L205) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:156](../server/src/routes/api/linkCheck.js#L156) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:221](../server/src/routes/api/linkCheck.js#L221) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:289](../server/src/routes/api/linkCheck.js#L289) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:234](../server/src/routes/api/linkCheck.js#L234) |
| GET | `/tools/migration-readiness` | 권한 `tools` | [server/src/routes/api/migrationReadiness.js:34](../server/src/routes/api/migrationReadiness.js#L34) |
| GET | `/tools/migration-readiness.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/migrationReadiness.js:38](../server/src/routes/api/migrationReadiness.js#L38) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:257](../server/src/routes/api/checksLogs.js#L257) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:2002](../server/src/routes/api/toolsCapacity.js#L2002) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1966](../server/src/routes/api/toolsCapacity.js#L1966) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:325](../server/src/routes/api/partFaults.js#L325) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/partFaults.js:461](../server/src/routes/api/partFaults.js#L461) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:359](../server/src/routes/api/partFaults.js#L359) |
| GET | `/tools/part-faults/incidents` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:395](../server/src/routes/api/partFaults.js#L395) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:476](../server/src/routes/api/partFaults.js#L476) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:426](../server/src/routes/api/partFaults.js#L426) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:446](../server/src/routes/api/partFaults.js#L446) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:436](../server/src/routes/api/partFaults.js#L436) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:79](../server/src/routes/api/pdu.js#L79) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:168](../server/src/routes/api/pdu.js#L168) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:355](../server/src/routes/api/pdu.js#L355) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:206](../server/src/routes/api/pdu.js#L206) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `textFields` | [server/src/routes/api/pdu.js:243](../server/src/routes/api/pdu.js#L243) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:232](../server/src/routes/api/pdu.js#L232) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:160](../server/src/routes/api/pdu.js#L160) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/pdu.js:319](../server/src/routes/api/pdu.js#L319) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:325](../server/src/routes/api/pdu.js#L325) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:335](../server/src/routes/api/pdu.js#L335) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:309](../server/src/routes/api/pdu.js#L309) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:192](../server/src/routes/api/pdu.js#L192) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:180](../server/src/routes/api/pdu.js#L180) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/pdu.js:278](../server/src/routes/api/pdu.js#L278) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:147](../server/src/routes/api/pdu.js#L147) |
| GET | `/tools/periodic-report/catalog` | 권한 `tools` | [server/src/routes/api/periodicReport.js:71](../server/src/routes/api/periodicReport.js#L71) |
| POST | `/tools/periodic-report/preview/:pid/keep` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/periodicReport.js:184](../server/src/routes/api/periodicReport.js#L184) |
| POST | `/tools/periodic-report/run` | 역할 `admin` · `fullRwOnly` · `textFields` | [server/src/routes/api/periodicReport.js:174](../server/src/routes/api/periodicReport.js#L174) |
| GET | `/tools/periodic-report/runs` | 권한 `tools` | [server/src/routes/api/periodicReport.js:76](../server/src/routes/api/periodicReport.js#L76) |
| GET | `/tools/periodic-report/runs/:id` | 권한 `tools` | [server/src/routes/api/periodicReport.js:96](../server/src/routes/api/periodicReport.js#L96) |
| POST | `/tools/periodic-report/runs/:id/deliver` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/periodicReport.js:192](../server/src/routes/api/periodicReport.js#L192) |
| GET | `/tools/periodic-report/runs/:id/export.xlsx` | 권한 `tools`, `data.csv` | [server/src/routes/api/periodicReport.js:125](../server/src/routes/api/periodicReport.js#L125) |
| GET | `/tools/periodic-report/runs/:id/report.html` | 권한 `tools` | [server/src/routes/api/periodicReport.js:110](../server/src/routes/api/periodicReport.js#L110) |
| GET | `/tools/periodic-report/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/periodicReport.js:158](../server/src/routes/api/periodicReport.js#L158) |
| PUT | `/tools/periodic-report/settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/periodicReport.js:164](../server/src/routes/api/periodicReport.js#L164) |
| GET | `/tools/periodic-report/status` | 권한 `tools` | [server/src/routes/api/periodicReport.js:62](../server/src/routes/api/periodicReport.js#L62) |
| GET | `/tools/portal-check/arch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:371](../server/src/routes/api/portalCheck.js#L371) |
| POST | `/tools/portal-check/arch/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:372](../server/src/routes/api/portalCheck.js#L372) |
| GET | `/tools/portal-check/common` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:394](../server/src/routes/api/portalCheck.js#L394) |
| GET | `/tools/portal-check/field` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:450](../server/src/routes/api/portalCheck.js#L450) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:412](../server/src/routes/api/portalCheck.js#L412) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:226](../server/src/routes/api/portalCheck.js#L226) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/portalCheck.js:295](../server/src/routes/api/portalCheck.js#L295) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/portalCheck.js:259](../server/src/routes/api/portalCheck.js#L259) |
| GET | `/tools/power-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/overviewCards.js:248](../server/src/routes/api/overviewCards.js#L248) |
| GET | `/tools/ps-inspect` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:57](../server/src/routes/api/psInspect.js#L57) |
| GET | `/tools/ps-inspect/catalog` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:50](../server/src/routes/api/psInspect.js#L50) |
| GET | `/tools/ps-inspect/devices/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:66](../server/src/routes/api/psInspect.js#L66) |
| GET | `/tools/ps-inspect/report` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:87](../server/src/routes/api/psInspect.js#L87) |
| GET | `/tools/ps-inspect/report.csv` | 권한 `tools`, `data.csv` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:99](../server/src/routes/api/psInspect.js#L99) |
| POST | `/tools/ps-inspect/report/send-now` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:126](../server/src/routes/api/psInspect.js#L126) |
| POST | `/tools/ps-inspect/run` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:108](../server/src/routes/api/psInspect.js#L108) |
| PUT | `/tools/ps-inspect/settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:117](../server/src/routes/api/psInspect.js#L117) |
| GET | `/tools/ps-inspect/top-nodes` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:77](../server/src/routes/api/psInspect.js#L77) |
| GET | `/tools/rack` | 권한 `tools` | [server/src/routes/api/rack.js:654](../server/src/routes/api/rack.js#L654) |
| POST | `/tools/rack/op` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/rack.js:715](../server/src/routes/api/rack.js#L715) |
| GET | `/tools/rack/room/:id` | 권한 `tools` | [server/src/routes/api/rack.js:690](../server/src/routes/api/rack.js#L690) |
| GET | `/tools/rack/room/:id/xlsx` | 권한 `tools`, `data.csv` | [server/src/routes/api/rack.js:698](../server/src/routes/api/rack.js#L698) |
| GET | `/tools/rack/versions` | 권한 `tools` | [server/src/routes/api/rack.js:667](../server/src/routes/api/rack.js#L667) |
| GET | `/tools/rack/versions/:vid` | 권한 `tools` | [server/src/routes/api/rack.js:678](../server/src/routes/api/rack.js#L678) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:20](../server/src/routes/api/relaycheck.js#L20) |
| POST | `/tools/relaycheck/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:47](../server/src/routes/api/relaycheck.js#L47) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:40](../server/src/routes/api/relaycheck.js#L40) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:50](../server/src/routes/api/relaytopo.js#L50) |
| PUT | `/tools/relaytopo` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:81](../server/src/routes/api/relaytopo.js#L81) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:140](../server/src/routes/api/relaytopo.js#L140) |
| GET | `/tools/relaytopo/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:111](../server/src/routes/api/relaytopo.js#L111) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:131](../server/src/routes/api/relaytopo.js#L131) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:135](../server/src/routes/api/relaytopo.js#L135) |
| POST | `/tools/relaytopo/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:91](../server/src/routes/api/relaytopo.js#L91) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:124](../server/src/routes/api/relaytopo.js#L124) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/relaytopo.js:149](../server/src/routes/api/relaytopo.js#L149) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:227](../server/src/routes/api/reports.js#L227) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:204](../server/src/routes/api/reports.js#L204) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:177](../server/src/routes/api/reports.js#L177) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:250](../server/src/routes/api/reports.js#L250) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:243](../server/src/routes/api/reports.js#L243) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:137](../server/src/routes/api/reports.js#L137) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:182](../server/src/routes/api/reports.js#L182) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:147](../server/src/routes/api/reports.js#L147) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:287](../server/src/routes/api/reports.js#L287) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:171](../server/src/routes/api/reports.js#L171) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1329](../server/src/routes/api/toolsCapacity.js#L1329) |
| GET | `/tools/rma` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:60](../server/src/routes/api/rma.js#L60) |
| PUT | `/tools/rma/agents/:agent/access` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:126](../server/src/routes/api/rma.js#L126) |
| PUT | `/tools/rma/agents/:agent/mode` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:208](../server/src/routes/api/rma.js#L208) |
| PUT | `/tools/rma/agents/:agent/password` | 역할 `admin` · `fullScopeOnly` · `ownerOtpThen` | [server/src/routes/api/rma.js:197](../server/src/routes/api/rma.js#L197) |
| PUT | `/tools/rma/agents/:agent/remote` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:136](../server/src/routes/api/rma.js#L136) |
| GET | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:80](../server/src/routes/api/rma.js#L80) |
| PUT | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` · `textFields` · `shellScheduleGate` | [server/src/routes/api/rma.js:83](../server/src/routes/api/rma.js#L83) |
| DELETE | `/tools/rma/agents/:agent/schedule/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:96](../server/src/routes/api/rma.js#L96) |
| POST | `/tools/rma/deploy` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` · `textFields` · `ownerOtpThen` | [server/src/routes/api/rma.js:248](../server/src/routes/api/rma.js#L248) |
| POST | `/tools/rma/deploy/list` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/rma.js:240](../server/src/routes/api/rma.js#L240) |
| POST | `/tools/rma/deploy/remove` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` · `textFields` · `ownerOtpThen` | [server/src/routes/api/rma.js:267](../server/src/routes/api/rma.js#L267) |
| GET | `/tools/rma/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:191](../server/src/routes/api/rma.js#L191) |
| GET | `/tools/rma/jobs/:reqId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:187](../server/src/routes/api/rma.js#L187) |
| POST | `/tools/rma/run` | 역할 `admin` · `fullScopeOnly` · `textFields` · `dangerRunGate` | [server/src/routes/api/rma.js:148](../server/src/routes/api/rma.js#L148) |
| PUT | `/tools/rma/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:218](../server/src/routes/api/rma.js#L218) |
| GET | `/tools/rma/tests/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:121](../server/src/routes/api/rma.js#L121) |
| GET | `/tools/rma/tests/results` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:110](../server/src/routes/api/rma.js#L110) |
| POST | `/tools/rma/tests/validate` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/rma.js:105](../server/src/routes/api/rma.js#L105) |
| GET | `/tools/san-flow` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:144](../server/src/routes/api/sanFlow.js#L144) |
| POST | `/tools/san-flow/activate` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` · `togglePrecheck` · `reauth` | [server/src/routes/api/sanFlow.js:294](../server/src/routes/api/sanFlow.js#L294) |
| GET | `/tools/san-flow/candidates` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:199](../server/src/routes/api/sanFlow.js#L199) |
| POST | `/tools/san-flow/check` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` | [server/src/routes/api/sanFlow.js:218](../server/src/routes/api/sanFlow.js#L218) |
| POST | `/tools/san-flow/create` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `reauth` | [server/src/routes/api/sanFlow.js:238](../server/src/routes/api/sanFlow.js#L238) |
| POST | `/tools/san-flow/deactivate` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` · `togglePrecheck` · `reauth` | [server/src/routes/api/sanFlow.js:293](../server/src/routes/api/sanFlow.js#L293) |
| POST | `/tools/san-flow/delete` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` · `reauth` | [server/src/routes/api/sanFlow.js:251](../server/src/routes/api/sanFlow.js#L251) |
| POST | `/tools/san-flow/forget` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` · `reauth` | [server/src/routes/api/sanFlow.js:297](../server/src/routes/api/sanFlow.js#L297) |
| GET | `/tools/san-flow/hosts` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:180](../server/src/routes/api/sanFlow.js#L180) |
| GET | `/tools/san-flow/job/:id` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:317](../server/src/routes/api/sanFlow.js#L317) |
| POST | `/tools/san-flow/preview` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:228](../server/src/routes/api/sanFlow.js#L228) |
| POST | `/tools/san-flow/show` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `textFields` | [server/src/routes/api/sanFlow.js:306](../server/src/routes/api/sanFlow.js#L306) |
| GET | `/tools/san-storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:119](../server/src/routes/api/sanStorage.js#L119) |
| GET | `/tools/san-storage/array` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:137](../server/src/routes/api/sanStorage.js#L137) |
| GET | `/tools/san-storage/check` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:212](../server/src/routes/api/sanStorage.js#L212) |
| GET | `/tools/san-storage/check-settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:236](../server/src/routes/api/sanStorage.js#L236) |
| PUT | `/tools/san-storage/check-settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:240](../server/src/routes/api/sanStorage.js#L240) |
| GET | `/tools/san-storage/check/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:224](../server/src/routes/api/sanStorage.js#L224) |
| GET | `/tools/san-storage/mapping` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:290](../server/src/routes/api/sanStorage.js#L290) |
| PUT | `/tools/san-storage/mapping` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:327](../server/src/routes/api/sanStorage.js#L327) |
| GET | `/tools/san-storage/notify` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:249](../server/src/routes/api/sanStorage.js#L249) |
| PUT | `/tools/san-storage/notify-settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:253](../server/src/routes/api/sanStorage.js#L253) |
| POST | `/tools/san-storage/notify/run-now` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:260](../server/src/routes/api/sanStorage.js#L260) |
| GET | `/tools/san-storage/port-names.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:335](../server/src/routes/api/sanStorage.js#L335) |
| GET | `/tools/san-storage/report` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:267](../server/src/routes/api/sanStorage.js#L267) |
| PUT | `/tools/san-storage/report-settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:270](../server/src/routes/api/sanStorage.js#L270) |
| GET | `/tools/san-storage/report/preview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanStorage.js:277](../server/src/routes/api/sanStorage.js#L277) |
| POST | `/tools/san-storage/report/send-now` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/sanStorage.js:284](../server/src/routes/api/sanStorage.js#L284) |
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:199](../server/src/routes/api/sanSwitch.js#L199) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1067](../server/src/routes/api/sanSwitch.js#L1067) |
| GET | `/tools/sanswitch/attribution` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/hostSan.js:477](../server/src/routes/api/hostSan.js#L477) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1091](../server/src/routes/api/sanSwitch.js#L1091) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:352](../server/src/routes/api/sanSwitch.js#L352) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:360](../server/src/routes/api/sanSwitch.js#L360) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:412](../server/src/routes/api/sanSwitch.js#L412) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:691](../server/src/routes/api/sanSwitch.js#L691) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:679](../server/src/routes/api/sanSwitch.js#L679) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:571](../server/src/routes/api/sanSwitch.js#L571) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:612](../server/src/routes/api/sanSwitch.js#L612) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:763](../server/src/routes/api/sanSwitch.js#L763) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:775](../server/src/routes/api/sanSwitch.js#L775) |
| GET | `/tools/sanswitch/devices/:id/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:852](../server/src/routes/api/sanSwitch.js#L852) |
| GET | `/tools/sanswitch/devices/:id/port-usage.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:861](../server/src/routes/api/sanSwitch.js#L861) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:260](../server/src/routes/api/sanSwitch.js#L260) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:298](../server/src/routes/api/sanSwitch.js#L298) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1174](../server/src/routes/api/sanSwitch.js#L1174) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1182](../server/src/routes/api/sanSwitch.js#L1182) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `fullRwOnly` · `textFields` | [server/src/routes/api/sanSwitch.js:1270](../server/src/routes/api/sanSwitch.js#L1270) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `fullRwOnly` · `textFields` | [server/src/routes/api/sanSwitch.js:1210](../server/src/routes/api/sanSwitch.js#L1210) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1258](../server/src/routes/api/sanSwitch.js#L1258) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1190](../server/src/routes/api/sanSwitch.js#L1190) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1196](../server/src/routes/api/sanSwitch.js#L1196) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:629](../server/src/routes/api/sanSwitch.js#L629) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:702](../server/src/routes/api/sanSwitch.js#L702) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:487](../server/src/routes/api/sanSwitch.js#L487) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:469](../server/src/routes/api/sanSwitch.js#L469) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:441](../server/src/routes/api/sanSwitch.js#L441) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:453](../server/src/routes/api/sanSwitch.js#L453) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:898](../server/src/routes/api/sanSwitch.js#L898) |
| GET | `/tools/sanswitch/perf/traffic-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1010](../server/src/routes/api/sanSwitch.js#L1010) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1115](../server/src/routes/api/sanSwitch.js#L1115) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` · `textFields` | [server/src/routes/api/sanSwitch.js:378](../server/src/routes/api/sanSwitch.js#L378) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:401](../server/src/routes/api/sanSwitch.js#L401) |
| GET | `/tools/secret-scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/toolsInfo.js:40](../server/src/routes/api/toolsInfo.js#L40) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:73](../server/src/routes/api/serialLookup.js#L73) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:102](../server/src/routes/api/serialLookup.js#L102) |
| GET | `/tools/server-cmd` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverCmd.js:35](../server/src/routes/api/serverCmd.js#L35) |
| GET | `/tools/server-cmd/output` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverCmd.js:45](../server/src/routes/api/serverCmd.js#L45) |
| GET | `/tools/server-cmd/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverCmd.js:38](../server/src/routes/api/serverCmd.js#L38) |
| POST | `/tools/server-cmd/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverCmd.js:46](../server/src/routes/api/serverCmd.js#L46) |
| GET | `/tools/server-info` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverInfo.js:21](../server/src/routes/api/serverInfo.js#L21) |
| POST | `/tools/server-info/read` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/serverInfo.js:25](../server/src/routes/api/serverInfo.js#L25) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:224](../server/src/routes/api/checksLogs.js#L224) |
| POST | `/tools/service-check/settings-files/confirm` | 역할 `admin` · `settingsFleetOnly` | [server/src/routes/api/checksLogs.js:240](../server/src/routes/api/checksLogs.js#L240) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:179](../server/src/routes/api/vcTools.js#L179) |
| GET | `/tools/snapshots/creators` | 권한 `tools` | [server/src/routes/api/vcTools.js:219](../server/src/routes/api/vcTools.js#L219) |
| GET | `/tools/snapshots/history` | 권한 `tools` | [server/src/routes/api/vcTools.js:201](../server/src/routes/api/vcTools.js#L201) |
| GET | `/tools/snapshots/history/vm` | 권한 `tools` | [server/src/routes/api/vcTools.js:303](../server/src/routes/api/vcTools.js#L303) |
| GET | `/tools/snapshots/holds` | 권한 `tools` | [server/src/routes/api/vcTools.js:240](../server/src/routes/api/vcTools.js#L240) |
| PUT | `/tools/snapshots/holds` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/vcTools.js:254](../server/src/routes/api/vcTools.js#L254) |
| POST | `/tools/snapshots/holds/release` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/vcTools.js:274](../server/src/routes/api/vcTools.js#L274) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:91](../server/src/routes/api/vcTools.js#L91) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:89](../server/src/routes/api/storageMon.js#L89) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:886](../server/src/routes/api/storageMon.js#L886) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:961](../server/src/routes/api/storageMon.js#L961) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:973](../server/src/routes/api/storageMon.js#L973) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:981](../server/src/routes/api/storageMon.js#L981) |
| GET | `/tools/storage-paths` | 권한 `tools` | [server/src/routes/api/storagePaths.js:36](../server/src/routes/api/storagePaths.js#L36) |
| GET | `/tools/storage-paths.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/storagePaths.js:55](../server/src/routes/api/storagePaths.js#L55) |
| GET | `/tools/storage-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:33](../server/src/routes/api/storageUsage.js#L33) |
| GET | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:75](../server/src/routes/api/storageUsage.js#L75) |
| PUT | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:84](../server/src/routes/api/storageUsage.js#L84) |
| POST | `/tools/storage-usage/mail/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:101](../server/src/routes/api/storageUsage.js#L101) |
| POST | `/tools/storage-usage/mail/send-now` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:93](../server/src/routes/api/storageUsage.js#L93) |
| GET | `/tools/storage-usage/xlsx` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:50](../server/src/routes/api/storageUsage.js#L50) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:238](../server/src/routes/api/storageMon.js#L238) |
| POST | `/tools/storage/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:251](../server/src/routes/api/storageMon.js#L251) |
| POST | `/tools/storage/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:214](../server/src/routes/api/storageMon.js#L214) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:224](../server/src/routes/api/storageMon.js#L224) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:585](../server/src/routes/api/storageMon.js#L585) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:590](../server/src/routes/api/storageMon.js#L590) |
| GET | `/tools/storage/devices/:id/client-dist` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:832](../server/src/routes/api/storageMon.js#L832) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:278](../server/src/routes/api/storageMon.js#L278) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:626](../server/src/routes/api/storageMon.js#L626) |
| GET | `/tools/storage/devices/:id/ifaces` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:757](../server/src/routes/api/storageMon.js#L757) |
| GET | `/tools/storage/devices/:id/node-clients` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:795](../server/src/routes/api/storageMon.js#L795) |
| GET | `/tools/storage/devices/:id/node-load` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:659](../server/src/routes/api/storageMon.js#L659) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:383](../server/src/routes/api/storageMon.js#L383) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:407](../server/src/routes/api/storageMon.js#L407) |
| POST | `/tools/storage/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `textFields` | [server/src/routes/api/storageMon.js:430](../server/src/routes/api/storageMon.js#L430) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `textFields` | [server/src/routes/api/storageMon.js:518](../server/src/routes/api/storageMon.js#L518) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:578](../server/src/routes/api/storageMon.js#L578) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:398](../server/src/routes/api/storageMon.js#L398) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:415](../server/src/routes/api/storageMon.js#L415) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:995](../server/src/routes/api/storageMon.js#L995) |
| GET | `/tools/storage/ifaces` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:738](../server/src/routes/api/storageMon.js#L738) |
| GET | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:308](../server/src/routes/api/storageMon.js#L308) |
| PUT | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:330](../server/src/routes/api/storageMon.js#L330) |
| POST | `/tools/storage/test` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/storageMon.js:158](../server/src/routes/api/storageMon.js#L158) |
| GET | `/tools/svc-inventory` | 권한 `tools` | [server/src/routes/api/svcInventory.js:688](../server/src/routes/api/svcInventory.js#L688) |
| GET | `/tools/svc-inventory.csv` | 권한 `tools`, `data.csv` | [server/src/routes/api/svcInventory.js:860](../server/src/routes/api/svcInventory.js#L860) |
| GET | `/tools/svc-inventory/candidates` | 권한 `tools` | [server/src/routes/api/svcInventory.js:840](../server/src/routes/api/svcInventory.js#L840) |
| GET | `/tools/svc-inventory/members` | 권한 `tools` | [server/src/routes/api/svcInventory.js:739](../server/src/routes/api/svcInventory.js#L739) |
| POST | `/tools/svc-inventory/op` | 역할 `admin/operator` · 권한 `tools` · `textFields` | [server/src/routes/api/svcInventory.js:895](../server/src/routes/api/svcInventory.js#L895) |
| GET | `/tools/svc-inventory/queues` | 권한 `tools` | [server/src/routes/api/svcInventory.js:791](../server/src/routes/api/svcInventory.js#L791) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1380](../server/src/routes/api/toolsCapacity.js#L1380) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:105](../server/src/routes/api/toolsAnalytics.js#L105) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:394](../server/src/routes/api/checksLogs.js#L394) |
| GET | `/tools/vclogs/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/checksLogs.js:425](../server/src/routes/api/checksLogs.js#L425) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:380](../server/src/routes/api/checksLogs.js#L380) |
| POST | `/tools/vclogs/federate` | 권한 `tools` · `textFields` | [server/src/routes/api/checksLogs.js:361](../server/src/routes/api/checksLogs.js#L361) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:332](../server/src/routes/api/checksLogs.js#L332) |
| GET | `/tools/vm-availability` | 권한 `tools` | [server/src/routes/api/vmAvailability.js:97](../server/src/routes/api/vmAvailability.js#L97) |
| GET | `/tools/vm-availability.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmAvailability.js:101](../server/src/routes/api/vmAvailability.js#L101) |
| GET | `/tools/vm-changes` | 권한 `tools` | [server/src/routes/api/vmChanges.js:66](../server/src/routes/api/vmChanges.js#L66) |
| GET | `/tools/vm-changes.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmChanges.js:107](../server/src/routes/api/vmChanges.js#L107) |
| GET | `/tools/vm-changes/of` | 권한 `tools` | [server/src/routes/api/vmChanges.js:84](../server/src/routes/api/vmChanges.js#L84) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:129](../server/src/routes/api/vmClone.js#L129) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:412](../server/src/routes/api/vmClone.js#L412) |
| PUT | `/tools/vm-clone/corps/mounts` | 역할 `admin` · `textFields` | [server/src/routes/api/vmClone.js:362](../server/src/routes/api/vmClone.js#L362) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` · `textFields` | [server/src/routes/api/vmClone.js:192](../server/src/routes/api/vmClone.js#L192) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:264](../server/src/routes/api/vmClone.js#L264) |
| POST | `/tools/vm-clone/jobs/:id/restore` | 역할 `admin` | [server/src/routes/api/vmClone.js:313](../server/src/routes/api/vmClone.js#L313) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:278](../server/src/routes/api/vmClone.js#L278) |
| POST | `/tools/vm-clone/jobs/:id/verify` | 역할 `admin` | [server/src/routes/api/vmClone.js:299](../server/src/routes/api/vmClone.js#L299) |
| POST | `/tools/vm-clone/nfs-datastores` | 역할 `admin` · `textFields` | [server/src/routes/api/vmClone.js:329](../server/src/routes/api/vmClone.js#L329) |
| DELETE | `/tools/vm-clone/nfs-datastores/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:398](../server/src/routes/api/vmClone.js#L398) |
| POST | `/tools/vm-clone/nfs-datastores/:id/attach` | 역할 `admin` | [server/src/routes/api/vmClone.js:346](../server/src/routes/api/vmClone.js#L346) |
| POST | `/tools/vm-clone/nfs-datastores/:id/detach` | 역할 `admin` | [server/src/routes/api/vmClone.js:382](../server/src/routes/api/vmClone.js#L382) |
| GET | `/tools/vm-dns` | 권한 `tools` | [server/src/routes/api/vmDns.js:131](../server/src/routes/api/vmDns.js#L131) |
| GET | `/tools/vm-dns.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmDns.js:226](../server/src/routes/api/vmDns.js#L226) |
| GET | `/tools/vm-dns/changes` | 권한 `tools` | [server/src/routes/api/vmDns.js:171](../server/src/routes/api/vmDns.js#L171) |
| GET | `/tools/vm-dns/policy` | 권한 `tools` | [server/src/routes/api/vmDns.js:184](../server/src/routes/api/vmDns.js#L184) |
| PUT | `/tools/vm-dns/policy` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:197](../server/src/routes/api/vmDns.js#L197) |
| POST | `/tools/vm-dns/probe` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:214](../server/src/routes/api/vmDns.js#L214) |
| GET | `/tools/vm-dns/server` | 권한 `tools` | [server/src/routes/api/vmDns.js:151](../server/src/routes/api/vmDns.js#L151) |
| GET | `/tools/vm-dns/vm` | 권한 `tools` | [server/src/routes/api/vmDns.js:161](../server/src/routes/api/vmDns.js#L161) |
| GET | `/tools/vm-export` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:163](../server/src/routes/api/vmExport.js#L163) |
| GET | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:157](../server/src/routes/api/vmExport.js#L157) |
| POST | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:142](../server/src/routes/api/vmExport.js#L142) |
| POST | `/tools/vm-export.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:149](../server/src/routes/api/vmExport.js#L149) |
| GET | `/tools/vm-export/catalog` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:118](../server/src/routes/api/vmExport.js#L118) |
| DELETE | `/tools/vm-export/prefs` | 역할 `admin/operator` · 권한 `data.csv`, `tools` · `prefsWrite` | [server/src/routes/api/vmExport.js:190](../server/src/routes/api/vmExport.js#L190) |
| GET | `/tools/vm-export/prefs` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:174](../server/src/routes/api/vmExport.js#L174) |
| PUT | `/tools/vm-export/prefs` | 역할 `admin/operator` · 권한 `data.csv`, `tools` · `prefsWrite` | [server/src/routes/api/vmExport.js:186](../server/src/routes/api/vmExport.js#L186) |
| POST | `/tools/vm-export/preview` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:126](../server/src/routes/api/vmExport.js#L126) |
| POST | `/tools/vm-finder` | 권한 `tools` · `textFields` | [server/src/routes/api/toolsCapacity.js:1417](../server/src/routes/api/toolsCapacity.js#L1417) |
| GET | `/tools/vm-hygiene` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:68](../server/src/routes/api/vmHygiene.js#L68) |
| GET | `/tools/vm-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmHygiene.js:119](../server/src/routes/api/vmHygiene.js#L119) |
| POST | `/tools/vm-hygiene/notify-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:113](../server/src/routes/api/vmHygiene.js#L113) |
| GET | `/tools/vm-hygiene/settings` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:92](../server/src/routes/api/vmHygiene.js#L92) |
| PUT | `/tools/vm-hygiene/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:99](../server/src/routes/api/vmHygiene.js#L99) |
| GET | `/tools/vm-lifecycle` | 권한 `tools` | [server/src/routes/api/vmLifecycle.js:79](../server/src/routes/api/vmLifecycle.js#L79) |
| GET | `/tools/vm-lifecycle.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmLifecycle.js:103](../server/src/routes/api/vmLifecycle.js#L103) |
| GET | `/tools/vm-tags` | 권한 `tools` | [server/src/routes/api/vmTags.js:75](../server/src/routes/api/vmTags.js#L75) |
| GET | `/tools/vm-tags.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmTags.js:112](../server/src/routes/api/vmTags.js#L112) |
| GET | `/tools/vm-tags/of` | 권한 `tools` | [server/src/routes/api/vmTags.js:91](../server/src/routes/api/vmTags.js#L91) |
| GET | `/tools/vm-tags/policy` | 권한 `tools` | [server/src/routes/api/vmTags.js:101](../server/src/routes/api/vmTags.js#L101) |
| PUT | `/tools/vm-tags/policy` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmTags.js:105](../server/src/routes/api/vmTags.js#L105) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:22](../server/src/routes/api/vmtrack.js#L22) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:61](../server/src/routes/api/vmtrack.js#L61) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:141](../server/src/routes/api/vmtrack.js#L141) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:76](../server/src/routes/api/vmtrack.js#L76) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:91](../server/src/routes/api/vmtrack.js#L91) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:159](../server/src/routes/api/vmtrack.js#L159) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:104](../server/src/routes/api/vmtrack.js#L104) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:119](../server/src/routes/api/vmtrack.js#L119) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:181](../server/src/routes/api/vmtrack.js#L181) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:199](../server/src/routes/api/vmtrack.js#L199) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:305](../server/src/routes/api/vmSeries.js#L305) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:269](../server/src/routes/api/vmSeries.js#L269) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:261](../server/src/routes/api/vmSeries.js#L261) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:244](../server/src/routes/api/vmSeries.js#L244) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:159](../server/src/routes/api/vmSeries.js#L159) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:177](../server/src/routes/api/vmSeries.js#L177) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:256](../server/src/routes/api/vmSeries.js#L256) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:283](../server/src/routes/api/vmSeries.js#L283) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:161](../server/src/routes/api/vcTools.js#L161) |
| GET | `/tools/vmware-config` | 권한 `tools` · `csvPermIfDownload` | [server/src/routes/api/checksLogs.js:270](../server/src/routes/api/checksLogs.js#L270) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:418](../server/src/routes/api/toolsCapacity.js#L418) |
| GET | `/tools/waste/export` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsCapacity.js:613](../server/src/routes/api/toolsCapacity.js#L613) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:831](../server/src/routes/api/toolsCapacity.js#L831) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:800](../server/src/routes/api/toolsCapacity.js#L800) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:815](../server/src/routes/api/toolsCapacity.js#L815) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:806](../server/src/routes/api/toolsCapacity.js#L806) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:568](../server/src/routes/api/toolsCapacity.js#L568) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1090](../server/src/routes/api/toolsCapacity.js#L1090) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:1113](../server/src/routes/api/toolsCapacity.js#L1113) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:1179](../server/src/routes/api/toolsCapacity.js#L1179) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1218](../server/src/routes/api/toolsCapacity.js#L1218) |
| GET | `/tools/xfer-speed` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:220](../server/src/routes/api/xferSpeed.js#L220) |
| GET | `/tools/xfer-speed/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:441](../server/src/routes/api/xferSpeed.js#L441) |
| GET | `/tools/xfer-speed/heat` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:246](../server/src/routes/api/xferSpeed.js#L246) |
| GET | `/tools/xfer-speed/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:265](../server/src/routes/api/xferSpeed.js#L265) |
| GET | `/tools/xfer-speed/log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:366](../server/src/routes/api/xferSpeed.js#L366) |
| GET | `/tools/xfer-speed/ping` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:320](../server/src/routes/api/xferSpeed.js#L320) |
| POST | `/tools/xfer-speed/run` | 역할 `admin` · `fullScopeOnly` · `textFields` | [server/src/routes/api/xferSpeed.js:394](../server/src/routes/api/xferSpeed.js#L394) |
| PUT | `/tools/xfer-speed/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:419](../server/src/routes/api/xferSpeed.js#L419) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:629](../server/src/routes/api/inventory.js#L629) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:338](../server/src/routes/api/toolsInfo.js#L338) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:340](../server/src/routes/api/toolsInfo.js#L340) |
| POST | `/usage/track` | — | [server/src/routes/api/usage.js:15](../server/src/routes/api/usage.js#L15) |
| DELETE | `/user-menu` | — | [server/src/routes/api/userMenu.js:90](../server/src/routes/api/userMenu.js#L90) |
| GET | `/user-menu` | — | [server/src/routes/api/userMenu.js:62](../server/src/routes/api/userMenu.js#L62) |
| PUT | `/user-menu` | — | [server/src/routes/api/userMenu.js:82](../server/src/routes/api/userMenu.js#L82) |
| DELETE | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:130](../server/src/routes/api/userMenu.js#L130) |
| GET | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:107](../server/src/routes/api/userMenu.js#L107) |
| POST | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:118](../server/src/routes/api/userMenu.js#L118) |
| POST | `/user-menu/restore-prev` | — | [server/src/routes/api/userMenu.js:98](../server/src/routes/api/userMenu.js#L98) |
| GET | `/vcenter-info/:kind` | — | [server/src/routes/api/vcInfo.js:123](../server/src/routes/api/vcInfo.js#L123) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:44](../server/src/routes/api/vcTools.js#L44) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:928](../server/src/routes/api/toolsCapacity.js#L928) |
| GET | `/veeam/backup-counts` | — | [server/src/routes/api/veeam.js:405](../server/src/routes/api/veeam.js#L405) |
| GET | `/veeam/badges` | — | [server/src/routes/api/veeam.js:297](../server/src/routes/api/veeam.js#L297) |
| GET | `/veeam/snap-events` | — | [server/src/routes/api/veeam.js:316](../server/src/routes/api/veeam.js#L316) |
| GET | `/veeam/vm-detail` | — | [server/src/routes/api/veeam.js:455](../server/src/routes/api/veeam.js#L455) |
| POST | `/veeam/vm-list.csv` | 권한 `data.csv` | [server/src/routes/api/veeam.js:338](../server/src/routes/api/veeam.js#L338) |
| POST | `/veeam/vm-list.xlsx` | 권한 `data.csv` | [server/src/routes/api/veeam.js:344](../server/src/routes/api/veeam.js#L344) |
| GET | `/veeam/vm-list/catalog` | 권한 `data.csv` | [server/src/routes/api/veeam.js:354](../server/src/routes/api/veeam.js#L354) |
| DELETE | `/veeam/vm-list/prefs` | 역할 `admin/operator` · 권한 `data.csv` · `prefsWrite` | [server/src/routes/api/veeam.js:400](../server/src/routes/api/veeam.js#L400) |
| GET | `/veeam/vm-list/prefs` | 권한 `data.csv` | [server/src/routes/api/veeam.js:388](../server/src/routes/api/veeam.js#L388) |
| PUT | `/veeam/vm-list/prefs` | 역할 `admin/operator` · 권한 `data.csv` · `textFields` · `prefsWrite` | [server/src/routes/api/veeam.js:396](../server/src/routes/api/veeam.js#L396) |
| POST | `/veeam/vm-list/preview` | 권한 `data.csv` | [server/src/routes/api/veeam.js:367](../server/src/routes/api/veeam.js#L367) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:429](../server/src/routes/api/inventory.js#L429) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:257](../server/src/routes/api/vmMetrics.js#L257) |
| POST | `/vms/:id/endpoint-locate` | 권한 `inv.vms` | [server/src/routes/api/hostSan.js:398](../server/src/routes/api/hostSan.js#L398) |
| GET | `/vms/:id/endpoint-locations` | 권한 `inv.vms` | [server/src/routes/api/hostSan.js:416](../server/src/routes/api/hostSan.js#L416) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:168](../server/src/routes/api/vmMetrics.js#L168) |
| GET | `/vms/:id/partitions` | 권한 `inv.vms` | [server/src/routes/api/toolsGuestPart.js:46](../server/src/routes/api/toolsGuestPart.js#L46) |
| GET | `/vms/:id/power-history` | 권한 `inv.vms` | [server/src/routes/api/vmPower.js:11](../server/src/routes/api/vmPower.js#L11) |
| GET | `/vms/by-vcenter` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:483](../server/src/routes/api/inventory.js#L483) |
| GET | `/vms/insight` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:507](../server/src/routes/api/inventory.js#L507) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:523](../server/src/routes/api/inventory.js#L523) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:286](../server/src/routes/api/toolsInfo.js#L286) |
| POST | `/vms/usage` | 권한 `inv.vms` · `textFields` | [server/src/routes/api/toolsCapacity.js:466](../server/src/routes/api/toolsCapacity.js#L466) |
| GET | `/wiki/backrefs` | — | [server/src/routes/api/wiki.js:206](../server/src/routes/api/wiki.js#L206) |
| GET | `/wiki/broken-links` | — | [server/src/routes/api/wiki.js:318](../server/src/routes/api/wiki.js#L318) |
| GET | `/wiki/home` | — | [server/src/routes/api/wiki.js:184](../server/src/routes/api/wiki.js#L184) |
| GET | `/wiki/meta` | — | [server/src/routes/api/wiki.js:150](../server/src/routes/api/wiki.js#L150) |
| POST | `/wiki/pages` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:222](../server/src/routes/api/wiki.js#L222) |
| DELETE | `/wiki/pages/:id` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:275](../server/src/routes/api/wiki.js#L275) |
| GET | `/wiki/pages/:id` | — | [server/src/routes/api/wiki.js:230](../server/src/routes/api/wiki.js#L230) |
| PUT | `/wiki/pages/:id` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:240](../server/src/routes/api/wiki.js#L240) |
| GET | `/wiki/pages/:id/backlinks` | — | [server/src/routes/api/wiki.js:314](../server/src/routes/api/wiki.js#L314) |
| POST | `/wiki/pages/:id/check` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:259](../server/src/routes/api/wiki.js#L259) |
| POST | `/wiki/pages/:id/comments` | `commenters` | [server/src/routes/api/wiki.js:355](../server/src/routes/api/wiki.js#L355) |
| DELETE | `/wiki/pages/:id/comments/:cid` | `commenters` | [server/src/routes/api/wiki.js:396](../server/src/routes/api/wiki.js#L396) |
| PUT | `/wiki/pages/:id/comments/:cid` | `commenters` | [server/src/routes/api/wiki.js:331](../server/src/routes/api/wiki.js#L331) |
| POST | `/wiki/pages/:id/comments/:cid/issue` | `commenters` | [server/src/routes/api/wiki.js:377](../server/src/routes/api/wiki.js#L377) |
| POST | `/wiki/pages/:id/comments/:cid/resolve` | `commenters` | [server/src/routes/api/wiki.js:389](../server/src/routes/api/wiki.js#L389) |
| GET | `/wiki/pages/:id/diff` | — | [server/src/routes/api/wiki.js:271](../server/src/routes/api/wiki.js#L271) |
| POST | `/wiki/pages/:id/fav` | `commenters` | [server/src/routes/api/wiki.js:404](../server/src/routes/api/wiki.js#L404) |
| GET | `/wiki/pages/:id/mentionables` | `commenters` | [server/src/routes/api/wiki.js:339](../server/src/routes/api/wiki.js#L339) |
| POST | `/wiki/pages/:id/move` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:322](../server/src/routes/api/wiki.js#L322) |
| POST | `/wiki/pages/:id/revert` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:249](../server/src/routes/api/wiki.js#L249) |
| GET | `/wiki/pages/:id/versions/:v` | — | [server/src/routes/api/wiki.js:267](../server/src/routes/api/wiki.js#L267) |
| POST | `/wiki/pages/:id/watch` | `commenters` | [server/src/routes/api/wiki.js:411](../server/src/routes/api/wiki.js#L411) |
| GET | `/wiki/search` | — | [server/src/routes/api/wiki.js:199](../server/src/routes/api/wiki.js#L199) |
| GET | `/wiki/spaces/:id` | — | [server/src/routes/api/wiki.js:218](../server/src/routes/api/wiki.js#L218) |
| PUT | `/wiki/spaces/:id` | 역할 `admin` | [server/src/routes/api/wiki.js:210](../server/src/routes/api/wiki.js#L210) |
| GET | `/wiki/templates` | 역할 `admin` · `templateFleetOnly` | [server/src/routes/api/wiki.js:161](../server/src/routes/api/wiki.js#L161) |
| POST | `/wiki/templates` | 역할 `admin` · `templateFleetOnly` · `templateFullWrite` | [server/src/routes/api/wiki.js:167](../server/src/routes/api/wiki.js#L167) |
| DELETE | `/wiki/templates/:id` | 역할 `admin` · `templateFleetOnly` · `templateFullWrite` | [server/src/routes/api/wiki.js:175](../server/src/routes/api/wiki.js#L175) |
| GET | `/wiki/templates/:id` | — | [server/src/routes/api/wiki.js:179](../server/src/routes/api/wiki.js#L179) |
| PUT | `/wiki/templates/:id` | 역할 `admin` · `templateFleetOnly` · `templateFullWrite` | [server/src/routes/api/wiki.js:171](../server/src/routes/api/wiki.js#L171) |
| GET | `/wiki/trash` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:287](../server/src/routes/api/wiki.js#L287) |
| DELETE | `/wiki/trash/:id` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:300](../server/src/routes/api/wiki.js#L300) |
| POST | `/wiki/trash/:id/restore` | 역할 `admin/operator` | [server/src/routes/api/wiki.js:291](../server/src/routes/api/wiki.js#L291) |
| GET | `/wiki/tree` | — | [server/src/routes/api/wiki.js:195](../server/src/routes/api/wiki.js#L195) |

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
| `fullScopeOnly` | 359 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 218 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `textFields` | 123 | 본문 모양 검사(163회차 — `util/coercionTrap.js`): 이름을 준 칸이 객체 · 배열이면 **400**(code `not-text`) — `String()` · `Number()` · `.trim()` 이 던져 500 이던 자리. 권한 게이트가 아니다(빠진 값 · 글자 · 수 · 불리언은 그대로 통과). |
| `requireSettingsOwner` | 88 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 그리고 **소유자이면서 전체 범위(vCenter 제한 없음) 계정만** 통과한다 — 범위가 지정된 소유자는 403(v2.744 AUTHZ-02). 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `requireCentral` | 70 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `fullRwOnly` | 56 | **조회 · 쓰기 모두 전체 범위인 계정만**(v2.935 — `fullReadWriteScopeOnlyWith` 의 산물 · SAN 스위치 등록 · 수집 · 설정 변경 라우트). 쓰기 범위만 줄인 관리자도 403. |
| `reauth` | 42 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `csvPerm` | 37 | **CSV 가져오기/내보내기 권한**(`requirePerm('data.csv')` — v2.643). 관리자 이상만(super_admin 항상, admin 은 권한 설정에서 super_admin 이 끌 수 있다). operator·viewer 는 403. |
| `demoBlockWrite` | 30 | **데모(손님) 계정 403**(v2.976 집중 모니터링 쓰기 — `isDemoGuest`). `noDemo` 와 같은 뜻 — 관리자 게이트 뒤에 붙는 쓰기 거절이고 권한을 넓히지 않는다. |
| `fullWriteOnly` | 24 | **쓰기 범위도 무제한인 계정만**(v2.823 Bareos 설정 쓰기). 조회는 무제한이어도 수정 가능 vCenter(writeVcenters)가 지정된 계정은 403 — 전 법인 공용 쓰기라 쓰기 범위와 교집합할 수 없다. |
| `fleetWideOnly` | 23 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `tokenFirst` | 22 | **수집 토큰 확인을 본문 해석보다 먼저** 한다(v2.741 — 토큰 없는 요청이 본문 파서·큰 본문 한도에 닿지 않게). 토큰이 없거나 틀리면 403, 수집 토큰 미설정이면 404. |
| `guarded` | 19 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `fullReadWriteScopeOnlyWith` | 14 | **조회 · 쓰기 모두 전체 범위인 계정만**(v2.935 — `routes/admin/shared.js` · `auth/scope.js isFullReadWriteScope`). 조회 범위 또는 쓰기 범위(writeVcenters)를 지정한 계정은 403 — 스위치 설정을 바꾸는 라우트(SAN 플로우 모니터)가 쓴다. |
| `requireSuperAdmin` | 13 | **super_admin 전용**(v2.726 좌측 메뉴 배포·철회 · v2.740 아이실론 디렉터리 사용량 수집 대상 설정 — 조회·저장·일괄 변경·연결 시험·메일·SSH 키). 저장 역할이 super_admin 인 계정만(`req.user.superAdmin`). 역할 admin 은 403 `super-admin-only`(`requiredRole: ['super_admin']`). |
| `express.json` | 11 | 본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약). |
| `fleetReadOnly` | 10 | **전체 범위 계정만**(v2.621 SEC-03 — 폴더 사용량 조회. 응답이 RMA 엣지 IP·호스트명·마운트 경로를 싣는다 · v2.622 SEC-03 — GPU 게스트 엣지 배포 설정·엣지 배포 사용자·수집 진단 조회). 범위 제한 계정은 403. |
| `issueSettingsFleetOnly` | 10 | **전체 범위 계정만**(v2.871 — 이슈 설정: 자동 할당 규칙 · 알림 · 사람별 메일 주소. 전 법인 공용 설정이다). 범위 제한 계정은 403 · 핸들러가 관리자 판본(데모 제외)을 한 번 더 본다. |
| `fullScopeOnlyWith` | 10 | **전체 범위 계정만**(사유 문구를 받는 `fullScopeOnly` — v2.628 SEC2628-01 업그레이드 제어·SEC2628-05 리소스 적정성 진단 등). 범위 제한 계정은 403. |
| `commenters` | 8 | **admin·operator 또는 권한 키 `issues.request`**(v2.881 위키 — 댓글 · 지켜보기. 데모 계정 제외 · 문서의 스페이스가 쓰기 범위 안이어야 한다 — 저장소 `addComment`). |
| `authMiddleware` | 8 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
| `scanCfgWritable` | 5 | IP 스캔 설정 · 대역 · 에이전트 정리를 쓰기 전에 **스캔 설정 파일을 읽지 못한 동안(읽기 오류 — 원본 그대로)이면 409**(사유 포함 — 원본을 기본값 위의 변경으로 덮지 않게 · 103회차). |
| `listOrText` | 5 | 줄 목록 칸 모양 검사(163회차 — `util/coercionTrap.js`): 글자 또는 배열만 받고, 배열이 아닌 객체면 **400**(code `not-text`). 권한 게이트가 아니다. |
| `noDemo` | 4 | **데모(손님) 계정 403**(7b 서버 등록 — `isDemoGuest`). 관리자 게이트 뒤에 붙는 쓰기 거절이고 권한을 넓히지 않는다. |
| `prefsWrite` | 4 | VM 목록 내보내기 내 저장값 쓰기(v2.798) — **데모 손님 403** · 저장 키는 인증된 계정 이름(본문 값 무시) · 손상 파일이면 503 · 감사 로그. |
| `templateFleetOnly` | 4 | **전체 범위 계정만**(v2.889 — 위키 관리자 템플릿: 모든 스페이스의 새 문서 화면에 보이는 전 법인 공용 설정). 범위 제한 계정은 403 · 핸들러가 관리자 판본(데모 제외)을 한 번 더 본다. |
| `requireEnrolled` | 4 | OTP **강제 등록 미완료 세션을 차단**한다(v2.206). 부트스트랩 admin 이 등록 전에 API 를 쓰지 못하게 하는 게이트로, 대부분의 `/api/*` 는 마운트에서 이미 걸린다 — 여기 보이는 것은 `/api/auth` 안의 admin 라우트처럼 **라우터가 따로 건** 경우다. |
| `fleetFullScopeOnly` | 4 | **전체 범위 계정만**(통합 서버 인벤토리 변경 — v2.606 AUTHZ2606-01). 베어메탈은 귀속 전에는 법인 축이 없어 범위로 나눌 수 없고, 귀속을 바꾸는 쓰기가 읽기 범위를 넓히므로 범위 제한 계정은 403. |
| `express.raw` | 3 | 원시 바디 버퍼(업그레이드 번들 등). ⚠ 게이트가 아니다 — 인증을 이 앞에 두어 미인증 요청이 대용량 바디를 적재하지 못하게 한다. |
| `noticeFleetOnly` | 3 | **전체 범위 계정만**(v2.722 — 접속 공지 작성·수정·삭제. 공지는 전 법인 사용자에게 보인다). 범위 제한 계정은 403. |
| `ruleWrite` | 3 | 집중 모니터링 알림 규칙 쓰기 처리기(v3.16.0 ⑯ — `ruleWrite(op)` 가 만드는 마지막 처리기 · 게이트가 아니다): 앞의 `adminOnly` · `fullRwOnly` · `demoBlockWrite` 를 지난 요청만 받고, 규칙 파일을 못 읽으면 **503** · 서버 하나 대상은 보이는 서버만(404) · 감사 로그. |
| `auditMiddleware` | 3 | 상태변경 감사 로그 기록. |
| `creators` | 3 | **admin·operator 또는 권한 키 `issues.request`**(v2.871 — 이슈 생성. 쓰기 역할이 아니면 요청 유형만 — 백로그 · 담당자·상태·관찰자 지정 없음, 저장소 `requestOnly`). viewer 상태변경 예외는 이것과 v2.881 위키 `commenters`(댓글 · 지켜보기) 둘뿐이다. |
| `sprintFleetOnly` | 3 | **전체 범위 계정만**(v2.882 — 이슈 스프린트 만들기 · 고치기 · 끝내기. 스프린트는 공용 + 전 법인 이슈를 담는 전 법인 공용 단위다). 범위 제한 계정은 403 — 이슈 넣기 · 빼기는 이슈의 쓰기 범위로 된다. |
| `ownerOtpThen` | 3 | **설정 소유자 등급 + 본인 OTP 재인증**(`requireSettingsOwner` 뒤 1회용 OTP). 원격 명령 비밀번호 설정 · 해제 · 원격 배포 · 원격 인스턴스 제거처럼 엣지에서 임의 실행 · 권한을 바꾸는 동작에 붙는다(v3.18.8). |
| `judgeFirst` | 3 | **판정 거절을 OTP 앞에서**(v3.24 서버 접속 반증 F9 — 6회차 A2 와 같은 규칙): 서비스를 `dryRun` 으로 한 번 돌려(로그인 · 쓰기 없음) 없는 계정 · OS 불일치 · 도메인 꼴 · 확인 대상 고르기(need-verify) · 낡은 화면(moved) 같은 거절이면 그대로 돌려준다. 통과면 OTP 뒤에서 같은 판정을 다시 한다. |
| `menuFleetOnly` | 3 | **전체 범위 계정만**(v2.726 — 좌측 메뉴 배포. 전 사용자 화면을 바꾼다). 범위 제한 계정은 403. |
| `templateFullWrite` | 3 | **쓰기 범위도 무제한인 계정만**(v2.889 — 위키 관리자 템플릿 쓰기). 조회는 무제한이어도 수정 가능 vCenter(writeVcenters)가 지정된 계정은 403(fullWriteOnly 와 같은 판정). |
| `adFleetOnly` | 3 | **전체 범위 계정만**(v2.628 SEC2628-04 — AD 설정 조회·저장·연결 테스트. AD 는 전 사용자 공통 인증 소스다). 범위 제한 계정은 403. |
| `hwFullScopeOnly` | 3 | **전체 범위 계정만**(서버 하드웨어 정보 내보내기 — v2.967). GET /insights/fleet 과 같은 근거: 미귀속 베어메탈 하드웨어가 들어가 범위로 나눌 수 없다. |
| `ownerIfAutoCentralToken` | 2 | 요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급). |
| `requireOwnOtp` | 2 | **본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다. |
| `distOwnerOnly` | 2 | **설정 소유 계정 등급**(재확인 N1 · 2026-11-19 사용자 결정 — 베어메탈 사용률 엣지 배포 켜기 · 끄기 · 제외 · 중앙에서 켜기 · 해제). 이 동작은 엣지의 실효 보존 기간을 중앙 값 ↔ 엣지 로컬 값으로 바꿔 엣지 이력을 지울 수 있고 중앙은 엣지 로컬 보존을 모르므로, 보존 줄이기와 같은 판정(`settingsOwnerGradeDenial`)으로 막는다(403 `distribute-owner` · 판정이 던지면 거부). 앞의 `fleetOnly`(조회 ∧ 쓰기 전체)는 그대로 먼저 본다. |
| `togglePrecheck` | 2 | SAN 플로우 비활성화 · 다시 켜기의 **사전 확인**(v2.940 반증 L-4) — 스위치 · dvc_ 이름 · 포탈 기록 · 지금 상태 · 엣지 버전을 OTP 재인증 **전에** 본다(거부할 요청이 OTP 를 써 버리지 않게). 404 · 400 · 409. |
| `vaultFirst` | 2 | **새 로그인 키 저장 방식 검사**(v3.9.0 SSH 공용 접속 — 키 등록 · 받는 곳 승인). 자격증명 저장 방식이 암호화가 아니면 409 `keys-need-encryption`, 정책을 못 읽으면 503 `SECRETS_POLICY_UNAVAILABLE` — **OTP(`reauth`) 앞에** 두어 거절될 요청이 1회 비밀번호를 쓰지 않게 한다. 판정은 `keyStore.keyVaultIssue` 하나(저장 함수도 다시 본다). |
| `alertFullScope` | 2 | **전체 범위 계정만**(v2.838 Backup › Summary 백업 안 된 VM 일일 메일 저장 · 지금 보내기 — `fullScopeOnlyWith` 의 산물 · 전 법인 자료를 메일로 보낸다). 범위 제한 계정은 403 · 핸들러가 관리자 판본(데모 제외)을 한 번 더 본다. |
| `rawIpFleetOnly` | 1 | **전체 범위 계정만**(v2.621 SEC-02 — 요청 본문 IP 로 직접 SSH 접속하는 테스트. 정규형 IPv4·차단 대역 검사가 뒤따른다). 범위 제한 계정은 403. |
| `liveFleetOnly` | 1 | **전체 범위 계정만**(v2.629 A6-02 — iDRAC 에 실시간 로그인하는 GPU 조사). 범위 제한 계정은 403. |
| `auditFullScope` | 1 | **전체 범위 계정만**(v2.932 점검 C1-04 — 감사 로그 `/admin/audit` · `fullScopeOnlyWith` 의 산물). 범위 제한 관리자는 403 — 본문에 `requiredOwner` 를 싣지 않는다(소유 계정 등록 안내가 틀린 조치가 되지 않게). |
| `loginHistoryFullScope` | 1 | **전체 범위 계정만**(v2.932 점검 C1-04 — 로그인 기록 `/admin/login-history` · `fullScopeOnlyWith` 의 산물). 범위 제한 관리자는 403 · `requiredOwner` 없음. |
| `uploadPrecheck` | 1 | **첨부 올리기 사전 검사**(v2.904 — 본문을 받기 전에): 데모 계정 403 · 주인(문서 · 이슈)을 볼 수 없으면 404(존재 은닉) · 쓰기 범위 밖이거나 읽기 전용이면 403. 본문(최대 8MB)은 이 검사를 통과한 뒤에만 받는다. |
| `keyVaultFirst` | 1 | `vaultFirst` 와 같은 검사(7b 베어메탈 사용률 SSH 키 등록 라우트 — v3.9.0). OTP 앞. |
| `accountFirst` | 1 | **공통 계정 저장 사전 판정**(베어메탈 사용률 점검 6회차 A2 — OTP 앞): 키 저장소 검사(B-4) + 그 계정을 쓰는 서버가 새로 어긋나는지(바꾼 기본 키의 폴더 밖 · 다른 법인 계정 · 종류) — 대수만 싣는 409 · 등록부를 못 읽으면 503. OTP 를 소모하지 않는다. |
| `settingsFleetOnly` | 1 | **전체 범위 계정만**(v2.633 — 손상 보존본만 남은 중앙 설정 파일을 기본값으로 확정. 그 기본값이 모든 엣지에 배포된다). 범위 제한 계정은 403. |
| `csvPermIfDownload` | 1 | `csvPerm` 과 같되 **download=1(파일 내보내기)일 때만** 요구한다 — 화면 조회(JSON)는 통과(v2.741 AUTHZ-02 — VMware 구성 백업). |
| `fullScopeReadPost` | 1 | **전체 범위 계정만 — 읽기성 POST 예외**(베어메탈 사용률 점검 6회차 A1 · `fullScopeOnlyWith(…, { readPost: true })`): 본문만 파싱하는 진단이라 쓰기 메서드여도 조회 범위로만 본다(쓰기 범위 판정 없음). 지금 cvp parse-preview 하나. |
| `shellScheduleGate` | 1 | 원격 명령 점검 스케줄에 **script · ssh 점검을 저장할 때만** 소유자 등급 + 본인 OTP(`ownerOtpThen`) — 스케줄로 셸을 주기 실행해 실행 게이트를 우회하지 못하게(v3.18.8). |
| `dangerRunGate` | 1 | 원격 명령 실행 중 **위험 동작일 때만** 소유자 등급 + 본인 OTP(`ownerOtpThen`) — 자유 명령 · 서비스 제어 · kill · 재부팅 · ssh-exec · tcp/udp-send · 본문 있는 http-request(판정 `commands.js presetDanger`). 읽기 프리셋은 admin + 전체 범위 그대로(v3.18.8). |
| `pwVaultFirst` | 1 | **새 공통 비밀번호 저장 방식 검사**(v3.24 서버 접속 — 공통 계정 저장). 새 비밀번호가 있으면 자격증명 저장 방식이 암호화가 아닐 때 409 `passwords-need-encryption`, 정책을 못 읽으면 503 — **OTP(`reauth`) 앞에** 둔다(`vaultFirst` 와 같은 규칙 · 판정 `keyStore.keyVaultIssue`). |
| `csvPermUnlessJson` | 1 | `csvPerm` 과 같되 **format=json(화면의 표·붙여넣기 등록)은 통과**(v2.643 — 성능점검 대상 등록 마법사). |

---

## 생성 정보

- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`
- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이
  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).

