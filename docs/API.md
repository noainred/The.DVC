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
| 엔드포인트 | **1569개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 157개 |
| GET | 820개 |
| POST | 503개 |
| PUT | 159개 |
| PATCH | 3개 |
| DELETE | 84개 |

| 그룹 | 엔드포인트 | 설명 |
|---|---:|---|
| [`/api/collector`](#apicollector) | 32 | 엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다. |
| [`/api/capacity`](#apicapacity) | 3 | 리소스 적정성 진단. 라우터가 스스로 `adminOnly` 를 건다. |
| [`/api/insights`](#apiinsights) | 19 | FinOps·이상탐지·예측·토폴로지·ChatOps. 마운트에서 `requirePerm('insights')`. |
| [`/api/central`](#apicentral) | 70 | 엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다. |
| [`/api/upgrade`](#apiupgrade) | 10 | 자동 업그레이드 제어(번들 수신·적용). |
| [`/api/remote`](#apiremote) | 19 | 원격 접속(HAProxy/SSH/RDP 중계). |
| [`/api/svcmon`](#apisvcmon) | 70 | 성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다. |
| [`/api/admin`](#apiadmin) | 378 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 11 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 16 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 12 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 926 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:164](../server/src/routes/collector.js#L164) |
| GET | `/bm-usage/baseline` | `tokenFirst` | [server/src/routes/collector.js:320](../server/src/routes/collector.js#L320) |
| GET | `/bm-usage/capacity` | `tokenFirst` | [server/src/routes/collector.js:343](../server/src/routes/collector.js#L343) |
| GET | `/bm-usage/changes` | `tokenFirst` | [server/src/routes/collector.js:319](../server/src/routes/collector.js#L319) |
| GET | `/bm-usage/compare` | `tokenFirst` | [server/src/routes/collector.js:321](../server/src/routes/collector.js#L321) |
| GET | `/bm-usage/compare-series` | `tokenFirst` | [server/src/routes/collector.js:323](../server/src/routes/collector.js#L323) |
| GET | `/bm-usage/devices` | — | [server/src/routes/collector.js:202](../server/src/routes/collector.js#L202) |
| GET | `/bm-usage/focus` | `tokenFirst` | [server/src/routes/collector.js:299](../server/src/routes/collector.js#L299) |
| POST | `/bm-usage/focus` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:271](../server/src/routes/collector.js#L271) |
| POST | `/bm-usage/focus/stop` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:288](../server/src/routes/collector.js#L288) |
| GET | `/bm-usage/logs` | `tokenFirst` | [server/src/routes/collector.js:328](../server/src/routes/collector.js#L328) |
| GET | `/bm-usage/nics` | — | [server/src/routes/collector.js:203](../server/src/routes/collector.js#L203) |
| GET | `/bm-usage/snapshot` | `tokenFirst` | [server/src/routes/collector.js:246](../server/src/routes/collector.js#L246) |
| POST | `/bm-usage/snapshot` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:218](../server/src/routes/collector.js#L218) |
| GET | `/bm-usage/snapshots` | `tokenFirst` | [server/src/routes/collector.js:237](../server/src/routes/collector.js#L237) |
| GET | `/bm-usage/top` | `tokenFirst` | [server/src/routes/collector.js:360](../server/src/routes/collector.js#L360) |
| GET | `/bm-usage/top/band` | `tokenFirst` | [server/src/routes/collector.js:372](../server/src/routes/collector.js#L372) |
| GET | `/bm-usage/trend` | — | [server/src/routes/collector.js:201](../server/src/routes/collector.js#L201) |
| POST | `/bmstor-collect` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:514](../server/src/routes/collector.js#L514) |
| POST | `/central-token` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:453](../server/src/routes/collector.js#L453) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:135](../server/src/routes/collector.js#L135) |
| GET | `/export` | — | [server/src/routes/collector.js:64](../server/src/routes/collector.js#L64) |
| POST | `/focus-mon/wake` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:267](../server/src/routes/collector.js#L267) |
| POST | `/idrac-scan` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:468](../server/src/routes/collector.js#L468) |
| POST | `/isidu-run` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:500](../server/src/routes/collector.js#L500) |
| POST | `/isidu-test` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:503](../server/src/routes/collector.js#L503) |
| GET | `/ping` | — | [server/src/routes/collector.js:116](../server/src/routes/collector.js#L116) |
| POST | `/set-password` | `tokenFirst` · `express.json` | [server/src/routes/collector.js:435](../server/src/routes/collector.js#L435) |
| GET | `/token-check` | — | [server/src/routes/collector.js:398](../server/src/routes/collector.js#L398) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:538](../server/src/routes/collector.js#L538) |
| GET | `/xfer-test` | — | [server/src/routes/collector.js:420](../server/src/routes/collector.js#L420) |
| POST | `/xfer-test` | — | [server/src/routes/collector.js:426](../server/src/routes/collector.js#L426) |

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
| GET | `/anomalies` | — | [server/src/routes/insights.js:583](../server/src/routes/insights.js#L583) |
| POST | `/chatops` | — | [server/src/routes/insights.js:658](../server/src/routes/insights.js#L658) |
| GET | `/finops` | — | [server/src/routes/insights.js:138](../server/src/routes/insights.js#L138) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:161](../server/src/routes/insights.js#L161) |
| PUT | `/finops/config` | 역할 `admin` · `fleetOnly` | [server/src/routes/insights.js:192](../server/src/routes/insights.js#L192) |
| GET | `/fleet` | — | [server/src/routes/insights.js:200](../server/src/routes/insights.js#L200) |
| PUT | `/fleet/assign` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:439](../server/src/routes/insights.js#L439) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:455](../server/src/routes/insights.js#L455) |
| GET | `/fleet/hardware-export` | 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:367](../server/src/routes/insights.js#L367) |
| GET | `/fleet/hardware-meta` | 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:344](../server/src/routes/insights.js#L344) |
| PUT | `/fleet/hardware-prefs` | 역할 `admin/operator` · 권한 `data.csv` · `hwFullScopeOnly` | [server/src/routes/insights.js:359](../server/src/routes/insights.js#L359) |
| POST | `/fleet/prune` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:505](../server/src/routes/insights.js#L505) |
| PUT | `/fleet/tag` | 역할 `admin` · `fleetFullScopeOnly` | [server/src/routes/insights.js:410](../server/src/routes/insights.js#L410) |
| GET | `/forecast` | — | [server/src/routes/insights.js:604](../server/src/routes/insights.js#L604) |
| GET | `/graph` | — | [server/src/routes/insights.js:637](../server/src/routes/insights.js#L637) |
| GET | `/incidents` | — | [server/src/routes/insights.js:652](../server/src/routes/insights.js#L652) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:164](../server/src/routes/insights.js#L164) |
| GET | `/security` | — | [server/src/routes/insights.js:617](../server/src/routes/insights.js#L617) |
| GET | `/topology` | — | [server/src/routes/insights.js:625](../server/src/routes/insights.js#L625) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:236](../server/src/routes/central/opsRoutes.js#L236) |
| GET | `/assignment` | `requireCentral` | [server/src/routes/central.js:475](../server/src/routes/central.js#L475) |
| GET | `/bareos-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:177](../server/src/routes/central/opsRoutes.js#L177) |
| POST | `/bareos-op-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:199](../server/src/routes/central/opsRoutes.js#L199) |
| GET | `/bareos-ops` | `requireCentral` | [server/src/routes/central/opsRoutes.js:189](../server/src/routes/central/opsRoutes.js#L189) |
| GET | `/bm-folders` | `requireCentral` | [server/src/routes/central/storageRoutes.js:295](../server/src/routes/central/storageRoutes.js#L295) |
| GET | `/bm-maint` | `requireCentral` | [server/src/routes/central/storageRoutes.js:278](../server/src/routes/central/storageRoutes.js#L278) |
| GET | `/bm-onboard` | `requireCentral` | [server/src/routes/central/storageRoutes.js:258](../server/src/routes/central/storageRoutes.js#L258) |
| GET | `/bmstor-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:348](../server/src/routes/central/opsRoutes.js#L348) |
| POST | `/bmstor-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:353](../server/src/routes/central/opsRoutes.js#L353) |
| GET | `/bmusage-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:235](../server/src/routes/central/storageRoutes.js#L235) |
| POST | `/capacity-report` | `requireCentral` | [server/src/routes/central.js:636](../server/src/routes/central.js#L636) |
| GET | `/capture-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:299](../server/src/routes/central/opsRoutes.js#L299) |
| POST | `/capture-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:304](../server/src/routes/central/opsRoutes.js#L304) |
| POST | `/curuser` | `requireCentral` | [server/src/routes/central.js:1263](../server/src/routes/central.js#L1263) |
| GET | `/curuser-config` | `requireCentral` | [server/src/routes/central.js:1361](../server/src/routes/central.js#L1361) |
| GET | `/cvp-config` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:22](../server/src/routes/central/cvpIsiduRoutes.js#L22) |
| POST | `/cvp-data` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:51](../server/src/routes/central/cvpIsiduRoutes.js#L51) |
| POST | `/disk-bad` | `requireCentral` | [server/src/routes/central/storageRoutes.js:163](../server/src/routes/central/storageRoutes.js#L163) |
| GET | `/disk-bad-job` | `requireCentral` | [server/src/routes/central/storageRoutes.js:149](../server/src/routes/central/storageRoutes.js#L149) |
| GET | `/edge-log-jobs` | `requireCentral` | [server/src/routes/central/storageRoutes.js:187](../server/src/routes/central/storageRoutes.js#L187) |
| POST | `/edge-log-result` | `requireCentral` | [server/src/routes/central/storageRoutes.js:194](../server/src/routes/central/storageRoutes.js#L194) |
| POST | `/fleet` | `requireCentral` | [server/src/routes/central.js:1400](../server/src/routes/central.js#L1400) |
| POST | `/focus-mon/sync` | `requireCentral` | [server/src/routes/central.js:622](../server/src/routes/central.js#L622) |
| GET | `/gpu-guest-config` | `requireCentral` | [server/src/routes/central.js:1633](../server/src/routes/central.js#L1633) |
| POST | `/gpu-guest-data` | `requireCentral` | [server/src/routes/central.js:1553](../server/src/routes/central.js#L1553) |
| POST | `/guest-disk` | `requireCentral` | [server/src/routes/central.js:1121](../server/src/routes/central.js#L1121) |
| GET | `/health-probe` | `requireCentral` | [server/src/routes/central/opsRoutes.js:471](../server/src/routes/central/opsRoutes.js#L471) |
| GET | `/idrac-scan-jobs` | `requireCentral` | [server/src/routes/central.js:1473](../server/src/routes/central.js#L1473) |
| POST | `/idrac-scan-progress` | `requireCentral` | [server/src/routes/central.js:1483](../server/src/routes/central.js#L1483) |
| POST | `/idrac-scan-result` | `requireCentral` | [server/src/routes/central.js:1495](../server/src/routes/central.js#L1495) |
| POST | `/inventory` | `requireCentral` | [server/src/routes/central.js:974](../server/src/routes/central.js#L974) |
| GET | `/ip-scan-assignment` | `requireCentral` | [server/src/routes/central/opsRoutes.js:377](../server/src/routes/central/opsRoutes.js#L377) |
| POST | `/ip-scan-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:396](../server/src/routes/central/opsRoutes.js#L396) |
| GET | `/isidu-config` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:157](../server/src/routes/central/cvpIsiduRoutes.js#L157) |
| POST | `/isidu-data` | `requireCentral` | [server/src/routes/central/cvpIsiduRoutes.js:179](../server/src/routes/central/cvpIsiduRoutes.js#L179) |
| POST | `/link-check` | `requireCentral` | [server/src/routes/central/opsRoutes.js:485](../server/src/routes/central/opsRoutes.js#L485) |
| GET | `/link-check-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:516](../server/src/routes/central/opsRoutes.js#L516) |
| GET | `/log-queries` | `requireCentral` | [server/src/routes/central/opsRoutes.js:271](../server/src/routes/central/opsRoutes.js#L271) |
| POST | `/log-query-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:279](../server/src/routes/central/opsRoutes.js#L279) |
| POST | `/part-faults` | `requireCentral` | [server/src/routes/central/storageRoutes.js:120](../server/src/routes/central/storageRoutes.js#L120) |
| GET | `/partfault-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:224](../server/src/routes/central/storageRoutes.js#L224) |
| GET | `/pdu-config` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:38](../server/src/routes/central/pduSanRoutes.js#L38) |
| POST | `/pdu-data` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:69](../server/src/routes/central/pduSanRoutes.js#L69) |
| GET | `/ping-jobs` | `requireCentral` | [server/src/routes/central/opsRoutes.js:209](../server/src/routes/central/opsRoutes.js#L209) |
| POST | `/ping-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:217](../server/src/routes/central/opsRoutes.js#L217) |
| POST | `/register-collector` | `requireCentral` | [server/src/routes/central.js:488](../server/src/routes/central.js#L488) |
| POST | `/result` | `requireCentral` | [server/src/routes/central.js:570](../server/src/routes/central.js#L570) |
| POST | `/rma-credential` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:302](../server/src/routes/central/pduSanRoutes.js#L302) |
| POST | `/rma-poll` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:238](../server/src/routes/central/pduSanRoutes.js#L238) |
| POST | `/rma-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:325](../server/src/routes/central/pduSanRoutes.js#L325) |
| GET | `/sanswitch-config` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:105](../server/src/routes/central/pduSanRoutes.js#L105) |
| POST | `/sanswitch-data` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:339](../server/src/routes/central/pduSanRoutes.js#L339) |
| POST | `/sanswitch-flow-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:211](../server/src/routes/central/pduSanRoutes.js#L211) |
| POST | `/sanswitch-perf` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:140](../server/src/routes/central/pduSanRoutes.js#L140) |
| POST | `/sanswitch-test-result` | `requireCentral` | [server/src/routes/central/pduSanRoutes.js:199](../server/src/routes/central/pduSanRoutes.js#L199) |
| GET | `/storage-config` | `requireCentral` | [server/src/routes/central/storageRoutes.js:90](../server/src/routes/central/storageRoutes.js#L90) |
| POST | `/storage-data` | `requireCentral` | [server/src/routes/central/storageRoutes.js:311](../server/src/routes/central/storageRoutes.js#L311) |
| GET | `/svcmon-config` | `requireCentral` | [server/src/routes/central.js:679](../server/src/routes/central.js#L679) |
| POST | `/svcmon-config-ack` | `requireCentral` | [server/src/routes/central.js:696](../server/src/routes/central.js#L696) |
| POST | `/svcmon-report` | `requireCentral` | [server/src/routes/central.js:594](../server/src/routes/central.js#L594) |
| GET | `/users-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:142](../server/src/routes/central/opsRoutes.js#L142) |
| GET | `/veeam-config` | `requireCentral` | [server/src/routes/central/opsRoutes.js:96](../server/src/routes/central/opsRoutes.js#L96) |
| POST | `/veeam-data` | `requireCentral` | [server/src/routes/central/opsRoutes.js:111](../server/src/routes/central/opsRoutes.js#L111) |
| GET | `/veeam-run-ops` | `requireCentral` | [server/src/routes/central/opsRoutes.js:157](../server/src/routes/central/opsRoutes.js#L157) |
| POST | `/veeam-run-result` | `requireCentral` | [server/src/routes/central/opsRoutes.js:167](../server/src/routes/central/opsRoutes.js#L167) |
| POST | `/vm-clone-report` | `requireCentral` | [server/src/routes/central/opsRoutes.js:335](../server/src/routes/central/opsRoutes.js#L335) |
| GET | `/vm-clone-sync` | `requireCentral` | [server/src/routes/central/opsRoutes.js:319](../server/src/routes/central/opsRoutes.js#L319) |
| POST | `/vmseries` | `requireCentral` | [server/src/routes/central.js:1203](../server/src/routes/central.js#L1203) |
| GET | `/vmseries-config` | `requireCentral` | [server/src/routes/central.js:1385](../server/src/routes/central.js#L1385) |

## `/api/upgrade`

자동 업그레이드 제어(번들 수신·적용).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/apply` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:163](../server/src/routes/upgrade.js#L163) |
| POST | `/bundle` | 역할 `admin` · `fullScopeOnlyWith` · `express.raw` | [server/src/routes/upgrade.js:262](../server/src/routes/upgrade.js#L262) |
| POST | `/check` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:157](../server/src/routes/upgrade.js#L157) |
| GET | `/detect-install` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:182](../server/src/routes/upgrade.js#L182) |
| POST | `/edge-sync` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:252](../server/src/routes/upgrade.js#L252) |
| POST | `/restart` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:171](../server/src/routes/upgrade.js#L171) |
| GET | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:177](../server/src/routes/upgrade.js#L177) |
| PUT | `/settings` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:192](../server/src/routes/upgrade.js#L192) |
| PUT | `/signature-override` | 역할 `admin` · `fullScopeOnlyWith` · `requireSettingsOwner` | [server/src/routes/upgrade.js:221](../server/src/routes/upgrade.js#L221) |
| GET | `/status` | 역할 `admin` · `fullScopeOnlyWith` | [server/src/routes/upgrade.js:152](../server/src/routes/upgrade.js#L152) |

## `/api/remote`

원격 접속(HAProxy/SSH/RDP 중계).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:172](../server/src/routes/remote.js#L172) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:188](../server/src/routes/remote.js#L188) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:361](../server/src/routes/remote.js#L361) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:345](../server/src/routes/remote.js#L345) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:52](../server/src/routes/remote.js#L52) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:384](../server/src/routes/remote.js#L384) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:500](../server/src/routes/remote.js#L500) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:489](../server/src/routes/remote.js#L489) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:105](../server/src/routes/remote.js#L105) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:139](../server/src/routes/remote.js#L139) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:264](../server/src/routes/remote.js#L264) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:286](../server/src/routes/remote.js#L286) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:305](../server/src/routes/remote.js#L305) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:197](../server/src/routes/remote.js#L197) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:435](../server/src/routes/remote.js#L435) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:37](../server/src/routes/remote.js#L37) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:516](../server/src/routes/remote.js#L516) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:155](../server/src/routes/remote.js#L155) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:329](../server/src/routes/remote.js#L329) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alert-settings` | 역할 `admin/operator` | [server/src/routes/svcmon/settingsSync.js:228](../server/src/routes/svcmon/settingsSync.js#L228) |
| PUT | `/alert-settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:234](../server/src/routes/svcmon/settingsSync.js#L234) |
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:32](../server/src/routes/svcmon/edge.js#L32) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:109](../server/src/routes/svcmon/edge.js#L109) |
| PUT | `/assign/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:67](../server/src/routes/svcmon/edge.js#L67) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:117](../server/src/routes/svcmon/edge.js#L117) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:116](../server/src/routes/svcmon/overview.js#L116) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:139](../server/src/routes/svcmon/edge.js#L139) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:126](../server/src/routes/svcmon/edge.js#L126) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:170](../server/src/routes/svcmon/edge.js#L170) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:154](../server/src/routes/svcmon/edge.js#L154) |
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
| GET | `/overview` | — | [server/src/routes/svcmon/settingsSync.js:209](../server/src/routes/svcmon/settingsSync.js#L209) |
| POST | `/push-now` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:178](../server/src/routes/svcmon/edge.js#L178) |
| POST | `/refresh` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/overview.js:127](../server/src/routes/svcmon/overview.js#L127) |
| PUT | `/reorder/folders` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:53](../server/src/routes/svcmon/tree.js#L53) |
| PUT | `/reorder/targets` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/tree.js:48](../server/src/routes/svcmon/tree.js#L48) |
| POST | `/settings-sync/ack` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:194](../server/src/routes/svcmon/settingsSync.js#L194) |
| POST | `/settings-sync/apply` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:142](../server/src/routes/svcmon/settingsSync.js#L142) |
| GET | `/settings-sync/catalog` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:99](../server/src/routes/svcmon/settingsSync.js#L99) |
| POST | `/settings-sync/detach/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:201](../server/src/routes/svcmon/settingsSync.js#L201) |
| PUT | `/settings-sync/options` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:185](../server/src/routes/svcmon/settingsSync.js#L185) |
| POST | `/settings-sync/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:133](../server/src/routes/svcmon/settingsSync.js#L133) |
| POST | `/settings-sync/repath` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/svcmon/settingsSync.js:165](../server/src/routes/svcmon/settingsSync.js#L165) |
| POST | `/silence-check` | 역할 `admin/operator` · `fullScopeOnly` | [server/src/routes/svcmon/edge.js:185](../server/src/routes/svcmon/edge.js#L185) |
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
| POST | `/agent-deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:81](../server/src/routes/admin/deployLlm.js#L81) |
| GET | `/agent-deploy/bulk` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:327](../server/src/routes/admin/deployLlm.js#L327) |
| GET | `/agent-deploy/bulk/:runId` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:328](../server/src/routes/admin/deployLlm.js#L328) |
| POST | `/agent-deploy/bulk/:runId/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:333](../server/src/routes/admin/deployLlm.js#L333) |
| GET | `/agent-deploy/bulk/presets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:277](../server/src/routes/admin/deployLlm.js#L277) |
| POST | `/agent-deploy/bulk/preview` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:282](../server/src/routes/admin/deployLlm.js#L282) |
| POST | `/agent-deploy/bulk/run` | 역할 `admin` · `fleetOnly` · `ownerIfAutoCentralToken` | [server/src/routes/admin/deployLlm.js:299](../server/src/routes/admin/deployLlm.js#L299) |
| GET | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:344](../server/src/routes/admin/deployLlm.js#L344) |
| POST | `/agent-deploy/collector-sync` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:415](../server/src/routes/admin/deployLlm.js#L415) |
| POST | `/agent-deploy/collector-sync/probe` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:362](../server/src/routes/admin/deployLlm.js#L362) |
| GET | `/agent-deploy/defaults` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:67](../server/src/routes/admin/deployLlm.js#L67) |
| POST | `/agent-deploy/deploy-all` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:236](../server/src/routes/admin/deployLlm.js#L236) |
| GET | `/agent-deploy/installer` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:65](../server/src/routes/admin/deployLlm.js#L65) |
| GET | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:105](../server/src/routes/admin/deployLlm.js#L105) |
| POST | `/agent-deploy/targets` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:114](../server/src/routes/admin/deployLlm.js#L114) |
| DELETE | `/agent-deploy/targets/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:135](../server/src/routes/admin/deployLlm.js#L135) |
| POST | `/agent-deploy/targets/:id/deploy` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:217](../server/src/routes/admin/deployLlm.js#L217) |
| POST | `/agent-deploy/targets/:id/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:227](../server/src/routes/admin/deployLlm.js#L227) |
| GET | `/agent-deploy/targets/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:146](../server/src/routes/admin/deployLlm.js#L146) |
| GET | `/agent-deploy/targets/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:507](../server/src/routes/admin/deployLlm.js#L507) |
| POST | `/agent-deploy/targets/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:184](../server/src/routes/admin/deployLlm.js#L184) |
| GET | `/agent-deploy/targets/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:160](../server/src/routes/admin/deployLlm.js#L160) |
| GET | `/agent-deploy/targets/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:520](../server/src/routes/admin/deployLlm.js#L520) |
| POST | `/agent-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:77](../server/src/routes/admin/deployLlm.js#L77) |
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:120](../server/src/routes/admin/opsSettings.js#L120) |
| PUT | `/alerts` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:121](../server/src/routes/admin/opsSettings.js#L121) |
| POST | `/alerts/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:133](../server/src/routes/admin/opsSettings.js#L133) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:167](../server/src/routes/admin/opsSettings.js#L167) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:168](../server/src/routes/admin/opsSettings.js#L168) |
| GET | `/api-keys` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/apiKeys.js:34](../server/src/routes/admin/apiKeys.js#L34) |
| POST | `/api-keys` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:67](../server/src/routes/admin/apiKeys.js#L67) |
| DELETE | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:103](../server/src/routes/admin/apiKeys.js#L103) |
| PATCH | `/api-keys/:id` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:84](../server/src/routes/admin/apiKeys.js#L84) |
| POST | `/api-keys/:id/revoke` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/apiKeys.js:95](../server/src/routes/admin/apiKeys.js#L95) |
| GET | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:195](../server/src/routes/admin/horizonAssign.js#L195) |
| POST | `/assignments` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:203](../server/src/routes/admin/horizonAssign.js#L203) |
| DELETE | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:213](../server/src/routes/admin/horizonAssign.js#L213) |
| PUT | `/assignments/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:208](../server/src/routes/admin/horizonAssign.js#L208) |
| POST | `/assignments/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:220](../server/src/routes/admin/horizonAssign.js#L220) |
| GET | `/audit` | 역할 `admin` · `auditFullScope` | [server/src/routes/admin/opsSettings.js:104](../server/src/routes/admin/opsSettings.js#L104) |
| DELETE | `/backup/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:207](../server/src/routes/admin/backupNetSec.js#L207) |
| GET | `/backup/download/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:175](../server/src/routes/admin/backupNetSec.js#L175) |
| POST | `/backup/now` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:170](../server/src/routes/admin/backupNetSec.js#L170) |
| POST | `/backup/restore-staged/cancel` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:200](../server/src/routes/admin/backupNetSec.js#L200) |
| POST | `/backup/restore/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:208](../server/src/routes/admin/backupNetSec.js#L208) |
| PUT | `/backup/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:169](../server/src/routes/admin/backupNetSec.js#L169) |
| GET | `/backup/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:166](../server/src/routes/admin/backupNetSec.js#L166) |
| GET | `/backup/view/:name` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/backupNetSec.js:188](../server/src/routes/admin/backupNetSec.js#L188) |
| GET | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:26](../server/src/routes/admin/centralTokens.js#L26) |
| PUT | `/central-token` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:59](../server/src/routes/admin/centralTokens.js#L59) |
| POST | `/central-token/generate` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:50](../server/src/routes/admin/centralTokens.js#L50) |
| GET | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:72](../server/src/routes/admin/centralTokens.js#L72) |
| POST | `/central/agent-tokens` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:76](../server/src/routes/admin/centralTokens.js#L76) |
| DELETE | `/central/agent-tokens/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:103](../server/src/routes/admin/centralTokens.js#L103) |
| POST | `/central/agent-tokens/:agent/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/centralTokens.js:84](../server/src/routes/admin/centralTokens.js#L84) |
| GET | `/central/ingest-stats` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:46](../server/src/routes/admin/centralTokens.js#L46) |
| POST | `/central/ingest-stats/reset` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:47](../server/src/routes/admin/centralTokens.js#L47) |
| GET | `/central/inventory` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:28](../server/src/routes/admin/centralTokens.js#L28) |
| POST | `/central/inventory/owner` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:33](../server/src/routes/admin/centralTokens.js#L33) |
| GET | `/central/token-apply/jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:94](../server/src/routes/admin/centralTokens.js#L94) |
| GET | `/central/token-apply/jobs/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralTokens.js:98](../server/src/routes/admin/centralTokens.js#L98) |
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:150](../server/src/routes/admin/opsSettings.js#L150) |
| GET | `/codex-check` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:30](../server/src/routes/admin/statusTools.js#L30) |
| GET | `/codex-check/file` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:33](../server/src/routes/admin/statusTools.js#L33) |
| POST | `/codex-check/write` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:36](../server/src/routes/admin/statusTools.js#L36) |
| GET | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:208](../server/src/routes/admin/collectorsDc.js#L208) |
| POST | `/collectors` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:228](../server/src/routes/admin/collectorsDc.js#L228) |
| DELETE | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:273](../server/src/routes/admin/collectorsDc.js#L273) |
| PUT | `/collectors/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:236](../server/src/routes/admin/collectorsDc.js#L236) |
| PUT | `/collectors/:id/datacenter` | 역할 `admin` · `fullReadWriteScopeOnlyWith` | [server/src/routes/admin/collectorsDc.js:255](../server/src/routes/admin/collectorsDc.js#L255) |
| POST | `/collectors/:id/force-token` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:673](../server/src/routes/admin/collectorsDc.js#L673) |
| GET | `/collectors/export.csv` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:292](../server/src/routes/admin/collectorsDc.js#L292) |
| POST | `/collectors/import` | 역할 `admin` · 권한 `data.csv` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:321](../server/src/routes/admin/collectorsDc.js#L321) |
| POST | `/collectors/pull` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:579](../server/src/routes/admin/collectorsDc.js#L579) |
| GET | `/collectors/sample.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/collectorsDc.js:307](../server/src/routes/admin/collectorsDc.js#L307) |
| POST | `/collectors/set-password` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:384](../server/src/routes/admin/collectorsDc.js#L384) |
| POST | `/collectors/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:600](../server/src/routes/admin/collectorsDc.js#L600) |
| POST | `/collectors/upgrade` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:586](../server/src/routes/admin/collectorsDc.js#L586) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:37](../server/src/routes/admin/vcenters.js#L37) |
| PUT | `/data-source` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:42](../server/src/routes/admin/vcenters.js#L42) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:482](../server/src/routes/admin/collectorsDc.js#L482) |
| PUT | `/datacenter-order` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:492](../server/src/routes/admin/collectorsDc.js#L492) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:443](../server/src/routes/admin/collectorsDc.js#L443) |
| POST | `/datacenters` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:454](../server/src/routes/admin/collectorsDc.js#L454) |
| DELETE | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:476](../server/src/routes/admin/collectorsDc.js#L476) |
| PUT | `/datacenters/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/collectorsDc.js:471](../server/src/routes/admin/collectorsDc.js#L471) |
| PUT | `/datacenters/assign` | 역할 `admin` · `fullReadWriteScopeOnlyWith` | [server/src/routes/admin/collectorsDc.js:462](../server/src/routes/admin/collectorsDc.js#L462) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:371](../server/src/routes/admin/backupNetSec.js#L371) |
| GET | `/dir-usage` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:30](../server/src/routes/admin/dirUsage.js#L30) |
| PUT | `/dir-usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:47](../server/src/routes/admin/dirUsage.js#L47) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:69](../server/src/routes/admin/dirUsage.js#L69) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:92](../server/src/routes/admin/dirUsage.js#L92) |
| POST | `/dir-usage/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/dirUsage.js:61](../server/src/routes/admin/dirUsage.js#L61) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/dirUsage.js:77](../server/src/routes/admin/dirUsage.js#L77) |
| POST | `/edge-users-bulk` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:326](../server/src/routes/admin/gpuGuest.js#L326) |
| GET | `/edge-users/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:312](../server/src/routes/admin/gpuGuest.js#L312) |
| POST | `/edge-users/:agent` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:321](../server/src/routes/admin/gpuGuest.js#L321) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:332](../server/src/routes/admin/gpuGuest.js#L332) |
| GET | `/edge-users/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:299](../server/src/routes/admin/gpuGuest.js#L299) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:50](../server/src/routes/admin/statusTools.js#L50) |
| POST | `/emergency-stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:59](../server/src/routes/admin/statusTools.js#L59) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:88](../server/src/routes/admin/nsxImport.js#L88) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:284](../server/src/routes/admin/gpuGuest.js#L284) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:288](../server/src/routes/admin/gpuGuest.js#L288) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:266](../server/src/routes/admin/gpuGuest.js#L266) |
| GET | `/gpu-guest/diag` | 역할 `admin` · `fleetReadOnly` | [server/src/routes/admin/gpuGuest.js:225](../server/src/routes/admin/gpuGuest.js#L225) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:183](../server/src/routes/admin/gpuGuest.js#L183) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:189](../server/src/routes/admin/gpuGuest.js#L189) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:434](../server/src/routes/admin/gpuGuest.js#L434) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` · `rawIpFleetOnly` | [server/src/routes/admin/gpuGuest.js:552](../server/src/routes/admin/gpuGuest.js#L552) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:231](../server/src/routes/admin/gpuGuest.js#L231) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:338](../server/src/routes/admin/gpuGuest.js#L338) |
| POST | `/gpu-physical` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:341](../server/src/routes/admin/gpuGuest.js#L341) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:351](../server/src/routes/admin/gpuGuest.js#L351) |
| PUT | `/gpu-physical/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:346](../server/src/routes/admin/gpuGuest.js#L346) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:360](../server/src/routes/admin/gpuGuest.js#L360) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:385](../server/src/routes/admin/gpuGuest.js#L385) |
| POST | `/gpu-physical/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:355](../server/src/routes/admin/gpuGuest.js#L355) |
| POST | `/gpu-physical/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/gpuGuest.js:414](../server/src/routes/admin/gpuGuest.js#L414) |
| POST | `/gpu/collect-util` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:156](../server/src/routes/admin/gpuGuest.js#L156) |
| POST | `/guest/add-user` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:345](../server/src/routes/admin/backupNetSec.js#L345) |
| GET | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:22](../server/src/routes/admin/horizonAssign.js#L22) |
| POST | `/horizon` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:23](../server/src/routes/admin/horizonAssign.js#L23) |
| DELETE | `/horizon/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:28](../server/src/routes/admin/horizonAssign.js#L28) |
| GET | `/horizon/servers/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:73](../server/src/routes/admin/horizonAssign.js#L73) |
| GET | `/horizon/servers/export.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:81](../server/src/routes/admin/horizonAssign.js#L81) |
| POST | `/horizon/servers/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:147](../server/src/routes/admin/horizonAssign.js#L147) |
| POST | `/horizon/servers/import/test` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:105](../server/src/routes/admin/horizonAssign.js#L105) |
| GET | `/horizon/servers/import/test/:id` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:137](../server/src/routes/admin/horizonAssign.js#L137) |
| GET | `/horizon/servers/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:89](../server/src/routes/admin/horizonAssign.js#L89) |
| GET | `/horizon/servers/sample.txt` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:95](../server/src/routes/admin/horizonAssign.js#L95) |
| POST | `/horizon/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/horizonAssign.js:33](../server/src/routes/admin/horizonAssign.js#L33) |
| GET | `/host-access` | 역할 `admin` · `fleetReadOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:32](../server/src/routes/admin/hostAccess.js#L32) |
| POST | `/host-access/apply` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:44](../server/src/routes/admin/hostAccess.js#L44) |
| POST | `/host-access/confirm` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` · `requireOwnOtp` | [server/src/routes/admin/hostAccess.js:49](../server/src/routes/admin/hostAccess.js#L49) |
| PUT | `/host-access/draft` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:35](../server/src/routes/admin/hostAccess.js#L35) |
| POST | `/host-access/plan` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:41](../server/src/routes/admin/hostAccess.js#L41) |
| POST | `/host-access/revert` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/hostAccess.js:54](../server/src/routes/admin/hostAccess.js#L54) |
| GET | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:165](../server/src/routes/admin/idracCore.js#L165) |
| POST | `/idrac` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:225](../server/src/routes/admin/idracCore.js#L225) |
| DELETE | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:571](../server/src/routes/admin/idracScan.js#L571) |
| PUT | `/idrac/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:565](../server/src/routes/admin/idracScan.js#L565) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` · `liveFleetOnly` | [server/src/routes/admin/idracScan.js:244](../server/src/routes/admin/idracScan.js#L244) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:100](../server/src/routes/admin/idracScan.js#L100) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:157](../server/src/routes/admin/idracScan.js#L157) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:201](../server/src/routes/admin/idracScan.js#L201) |
| GET | `/idrac/:id/trend` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:863](../server/src/routes/admin/idracTrend.js#L863) |
| GET | `/idrac/:id/trend/hourly` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:825](../server/src/routes/admin/idracTrend.js#L825) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:124](../server/src/routes/admin/idracScan.js#L124) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:553](../server/src/routes/admin/idracScan.js#L553) |
| POST | `/idrac/bulk-add` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:276](../server/src/routes/admin/idracScan.js#L276) |
| POST | `/idrac/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:540](../server/src/routes/admin/idracScan.js#L540) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:269](../server/src/routes/admin/idracScan.js#L269) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:535](../server/src/routes/admin/idracCore.js#L535) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:571](../server/src/routes/admin/idracCore.js#L571) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:467](../server/src/routes/admin/idracCore.js#L467) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:275](../server/src/routes/admin/idracCore.js#L275) |
| POST | `/idrac/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:258](../server/src/routes/admin/idracScan.js#L258) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:388](../server/src/routes/admin/idracCore.js#L388) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:314](../server/src/routes/admin/idracCore.js#L314) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:625](../server/src/routes/admin/idracCore.js#L625) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:645](../server/src/routes/admin/idracCore.js#L645) |
| POST | `/idrac/poll` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:243](../server/src/routes/admin/idracCore.js#L243) |
| POST | `/idrac/power-purge` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:261](../server/src/routes/admin/idracCore.js#L261) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:249](../server/src/routes/admin/idracCore.js#L249) |
| PUT | `/idrac/power-settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:250](../server/src/routes/admin/idracCore.js#L250) |
| POST | `/idrac/register-scanned` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:347](../server/src/routes/admin/idracScan.js#L347) |
| POST | `/idrac/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:285](../server/src/routes/admin/idracScan.js#L285) |
| GET | `/idrac/scan-agents` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:333](../server/src/routes/admin/idracScan.js#L333) |
| GET | `/idrac/scan-job-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:514](../server/src/routes/admin/idracScan.js#L514) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:532](../server/src/routes/admin/idracScan.js#L532) |
| GET | `/idrac/scan-jobs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:504](../server/src/routes/admin/idracScan.js#L504) |
| GET | `/idrac/scan-log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:478](../server/src/routes/admin/idracScan.js#L478) |
| GET | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:364](../server/src/routes/admin/idracScan.js#L364) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:370](../server/src/routes/admin/idracScan.js#L370) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:378](../server/src/routes/admin/idracScan.js#L378) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:389](../server/src/routes/admin/idracScan.js#L389) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/idracScan.js:410](../server/src/routes/admin/idracScan.js#L410) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:492](../server/src/routes/admin/idracScan.js#L492) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/idracScan.js:404](../server/src/routes/admin/idracScan.js#L404) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:466](../server/src/routes/admin/idracScan.js#L466) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:475](../server/src/routes/admin/idracScan.js#L475) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:485](../server/src/routes/admin/idracScan.js#L485) |
| GET | `/idrac/scan-result` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracScan.js:324](../server/src/routes/admin/idracScan.js#L324) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:511](../server/src/routes/admin/idracCore.js#L511) |
| POST | `/idrac/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/idracCore.js:235](../server/src/routes/admin/idracCore.js#L235) |
| GET | `/idrac/trend/export.csv` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:737](../server/src/routes/admin/idracTrend.js#L737) |
| GET | `/idrac/trend/export.xlsx` | 역할 `admin` · 권한 `data.csv` | [server/src/routes/admin/idracTrend.js:761](../server/src/routes/admin/idracTrend.js#L761) |
| GET | `/idrac/trend/resolve-host` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:714](../server/src/routes/admin/idracTrend.js#L714) |
| GET | `/idrac/trend/servers` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:648](../server/src/routes/admin/idracTrend.js#L648) |
| GET | `/idrac/trend/table` | 역할 `admin` | [server/src/routes/admin/idracTrend.js:655](../server/src/routes/admin/idracTrend.js#L655) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:502](../server/src/routes/admin/idracCore.js#L502) |
| GET | `/ipam/changes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:428](../server/src/routes/admin/centralIpam.js#L428) |
| GET | `/ipam/db-info` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:72](../server/src/routes/admin/centralIpam.js#L72) |
| GET | `/ipam/report` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:446](../server/src/routes/admin/centralIpam.js#L446) |
| PUT | `/ipam/report` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:456](../server/src/routes/admin/centralIpam.js#L456) |
| POST | `/ipam/report/preview` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:462](../server/src/routes/admin/centralIpam.js#L462) |
| POST | `/ipam/report/send-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:469](../server/src/routes/admin/centralIpam.js#L469) |
| POST | `/ipam/scan/agent/delete` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:348](../server/src/routes/admin/centralIpam.js#L348) |
| GET | `/ipam/scan/bm-os-suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmOsSuggest.js:63](../server/src/routes/admin/bmOsSuggest.js#L63) |
| POST | `/ipam/scan/bm-os-suggest/apply` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/bmOsSuggest.js:72](../server/src/routes/admin/bmOsSuggest.js#L72) |
| GET | `/ipam/scan/import` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:235](../server/src/routes/admin/centralIpam.js#L235) |
| GET | `/ipam/scan/log` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:475](../server/src/routes/admin/centralIpam.js#L475) |
| GET | `/ipam/scan/migration` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:399](../server/src/routes/admin/centralIpam.js#L399) |
| POST | `/ipam/scan/migration/dismiss` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:422](../server/src/routes/admin/centralIpam.js#L422) |
| POST | `/ipam/scan/migration/move` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:400](../server/src/routes/admin/centralIpam.js#L400) |
| POST | `/ipam/scan/migration/remove` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:412](../server/src/routes/admin/centralIpam.js#L412) |
| GET | `/ipam/scan/owners` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:227](../server/src/routes/admin/centralIpam.js#L227) |
| GET | `/ipam/scan/ranges` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:304](../server/src/routes/admin/centralIpam.js#L304) |
| GET | `/ipam/scan/ranges.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:500](../server/src/routes/admin/centralIpam.js#L500) |
| POST | `/ipam/scan/ranges/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:511](../server/src/routes/admin/centralIpam.js#L511) |
| POST | `/ipam/scan/ranges/line` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:322](../server/src/routes/admin/centralIpam.js#L322) |
| GET | `/ipam/scan/ranges/sample.csv` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:506](../server/src/routes/admin/centralIpam.js#L506) |
| GET | `/ipam/scan/results` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:487](../server/src/routes/admin/centralIpam.js#L487) |
| POST | `/ipam/scan/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:478](../server/src/routes/admin/centralIpam.js#L478) |
| GET | `/ipam/scan/schedule` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:436](../server/src/routes/admin/centralIpam.js#L436) |
| GET | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:132](../server/src/routes/admin/centralIpam.js#L132) |
| PUT | `/ipam/scan/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:158](../server/src/routes/admin/centralIpam.js#L158) |
| GET | `/ipam/scan/status` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:483](../server/src/routes/admin/centralIpam.js#L483) |
| GET | `/ipam/scan/suggest` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:190](../server/src/routes/admin/centralIpam.js#L190) |
| GET | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:102](../server/src/routes/admin/centralIpam.js#L102) |
| PUT | `/ipam/settings` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:106](../server/src/routes/admin/centralIpam.js#L106) |
| PUT | `/ipam/vc-ranges` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:536](../server/src/routes/admin/centralIpam.js#L536) |
| DELETE | `/ipam/vc-ranges/:vcenterId` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:592](../server/src/routes/admin/centralIpam.js#L592) |
| POST | `/ipam/vc-ranges/import` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:613](../server/src/routes/admin/centralIpam.js#L613) |
| GET | `/ipam/vc-ranges/sample.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/centralIpam.js:607](../server/src/routes/admin/centralIpam.js#L607) |
| POST | `/ipam/vc-ranges/scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/centralIpam.js:598](../server/src/routes/admin/centralIpam.js#L598) |
| GET | `/ipam/vc-ranges/suggest` | 역할 `admin` | [server/src/routes/admin/centralIpam.js:560](../server/src/routes/admin/centralIpam.js#L560) |
| GET | `/llm-config` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:528](../server/src/routes/admin/deployLlm.js#L528) |
| PUT | `/llm-config` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:529](../server/src/routes/admin/deployLlm.js#L529) |
| POST | `/llm-test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:535](../server/src/routes/admin/deployLlm.js#L535) |
| GET | `/log-analysis` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:23](../server/src/routes/admin/logAnalysis.js#L23) |
| POST | `/log-analysis/journal` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:46](../server/src/routes/admin/logAnalysis.js#L46) |
| GET | `/log-analysis/meta` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:40](../server/src/routes/admin/logAnalysis.js#L40) |
| POST | `/log-analysis/paste` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/logAnalysis.js:55](../server/src/routes/admin/logAnalysis.js#L55) |
| GET | `/login-history` | 역할 `admin` · `loginHistoryFullScope` | [server/src/routes/admin/opsSettings.js:110](../server/src/routes/admin/opsSettings.js#L110) |
| GET | `/logs` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:87](../server/src/routes/admin/statusTools.js#L87) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:61](../server/src/routes/admin/mail.js#L61) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:69](../server/src/routes/admin/mail.js#L69) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:103](../server/src/routes/admin/mail.js#L103) |
| GET | `/memtrack` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:203](../server/src/routes/admin/statusTools.js#L203) |
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
| GET | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:58](../server/src/routes/admin/nsxImport.js#L58) |
| POST | `/nsx/managers` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:68](../server/src/routes/admin/nsxImport.js#L68) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:78](../server/src/routes/admin/nsxImport.js#L78) |
| PUT | `/nsx/managers/:id` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:73](../server/src/routes/admin/nsxImport.js#L73) |
| POST | `/nsx/managers/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:83](../server/src/routes/admin/nsxImport.js#L83) |
| POST | `/ollama-deploy` | 역할 `admin` · `fleetOnly` · `requireSettingsOwner` | [server/src/routes/admin/deployLlm.js:549](../server/src/routes/admin/deployLlm.js#L549) |
| POST | `/ollama-deploy/test` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:546](../server/src/routes/admin/deployLlm.js#L546) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:274](../server/src/routes/admin/opsSettings.js#L274) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:305](../server/src/routes/admin/opsSettings.js#L305) |
| GET | `/os-scan/results.csv` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/opsSettings.js:309](../server/src/routes/admin/opsSettings.js#L309) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:284](../server/src/routes/admin/opsSettings.js#L284) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:277](../server/src/routes/admin/opsSettings.js#L277) |
| GET | `/packages` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:42](../server/src/routes/admin/deployLlm.js#L42) |
| POST | `/packages/download` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:59](../server/src/routes/admin/deployLlm.js#L59) |
| PUT | `/packages/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:56](../server/src/routes/admin/deployLlm.js#L56) |
| GET | `/perf` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:22](../server/src/routes/admin/perfMonitor.js#L22) |
| DELETE | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:60](../server/src/routes/admin/perfMonitor.js#L60) |
| GET | `/perf/hangs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:54](../server/src/routes/admin/perfMonitor.js#L54) |
| POST | `/perf/measure` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:47](../server/src/routes/admin/perfMonitor.js#L47) |
| PUT | `/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/admin/perfMonitor.js:31](../server/src/routes/admin/perfMonitor.js#L31) |
| GET | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:145](../server/src/routes/admin/users.js#L145) |
| PUT | `/permissions` | 역할 `admin` | [server/src/routes/admin/users.js:209](../server/src/routes/admin/users.js#L209) |
| POST | `/permissions/reset` | 역할 `admin` | [server/src/routes/admin/users.js:229](../server/src/routes/admin/users.js#L229) |
| GET | `/portal-db` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:110](../server/src/routes/admin/statusTools.js#L110) |
| GET | `/portal-db/guide` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:114](../server/src/routes/admin/statusTools.js#L114) |
| GET | `/portal-db/health` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:128](../server/src/routes/admin/statusTools.js#L128) |
| GET | `/portal-db/location` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:147](../server/src/routes/admin/statusTools.js#L147) |
| POST | `/portal-db/location/preflight` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:163](../server/src/routes/admin/statusTools.js#L163) |
| POST | `/portal-db/location/script` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/statusTools.js:173](../server/src/routes/admin/statusTools.js#L173) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:321](../server/src/routes/admin/opsSettings.js#L321) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:367](../server/src/routes/admin/opsSettings.js#L367) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:362](../server/src/routes/admin/opsSettings.js#L362) |
| POST | `/release-notes` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:559](../server/src/routes/admin/deployLlm.js#L559) |
| DELETE | `/release-notes/:version` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/deployLlm.js:563](../server/src/routes/admin/deployLlm.js#L563) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:136](../server/src/routes/admin/opsSettings.js#L136) |
| PUT | `/report/daily` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:137](../server/src/routes/admin/opsSettings.js#L137) |
| POST | `/report/daily/run` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/opsSettings.js:142](../server/src/routes/admin/opsSettings.js#L142) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:150](../server/src/routes/admin/idracCore.js#L150) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:113](../server/src/routes/admin/idracCore.js#L113) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:135](../server/src/routes/admin/idracCore.js#L135) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:190](../server/src/routes/admin/opsSettings.js#L190) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:193](../server/src/routes/admin/opsSettings.js#L193) |
| GET | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:422](../server/src/routes/admin/backupNetSec.js#L422) |
| PUT | `/security/guest-scans` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:433](../server/src/routes/admin/backupNetSec.js#L433) |
| DELETE | `/security/guest-scans/:id` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:454](../server/src/routes/admin/backupNetSec.js#L454) |
| POST | `/security/guest-scans/:id/run` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:455](../server/src/routes/admin/backupNetSec.js#L455) |
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
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:219](../server/src/routes/admin/opsSettings.js#L219) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:224](../server/src/routes/admin/opsSettings.js#L224) |
| GET | `/settings/status` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/settingsStatus.js:27](../server/src/routes/admin/settingsStatus.js#L27) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:211](../server/src/routes/admin/statusTools.js#L211) |
| GET | `/tool-categories` | — | [server/src/routes/admin/toolCategories.js:19](../server/src/routes/admin/toolCategories.js#L19) |
| PUT | `/tool-categories` | 역할 `admin` · `fleetOnly` | [server/src/routes/admin/toolCategories.js:28](../server/src/routes/admin/toolCategories.js#L28) |
| GET | `/tool-categories/preset` | 역할 `admin` | [server/src/routes/admin/toolCategories.js:47](../server/src/routes/admin/toolCategories.js#L47) |
| GET | `/usage/export.csv` | 역할 `admin` · 권한 `data.csv` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:49](../server/src/routes/admin/usage.js#L49) |
| POST | `/usage/purge` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/admin/usage.js:82](../server/src/routes/admin/usage.js#L82) |
| GET | `/usage/report` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:37](../server/src/routes/admin/usage.js#L37) |
| GET | `/usage/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:62](../server/src/routes/admin/usage.js#L62) |
| PUT | `/usage/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:74](../server/src/routes/admin/usage.js#L74) |
| GET | `/usage/user/:user` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/usage.js:42](../server/src/routes/admin/usage.js#L42) |
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
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:130](../server/src/routes/admin/vcenters.js#L130) |
| PUT | `/vcenter-order` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:139](../server/src/routes/admin/vcenters.js#L139) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:93](../server/src/routes/admin/statusTools.js#L93) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:50](../server/src/routes/admin/vcenters.js#L50) |
| POST | `/vcenters` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/vcenters.js:68](../server/src/routes/admin/vcenters.js#L68) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:83](../server/src/routes/admin/vcenters.js#L83) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:75](../server/src/routes/admin/vcenters.js#L75) |
| POST | `/vcenters/import` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:95](../server/src/routes/admin/nsxImport.js#L95) |
| POST | `/vcenters/import-file` | 역할 `admin` · `csvPerm` · `fleetOnly` | [server/src/routes/admin/nsxImport.js:112](../server/src/routes/admin/nsxImport.js#L112) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` · `csvPerm` | [server/src/routes/admin/nsxImport.js:104](../server/src/routes/admin/nsxImport.js#L104) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:91](../server/src/routes/admin/vcenters.js#L91) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:108](../server/src/routes/admin/vcenters.js#L108) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:261](../server/src/routes/admin/backupNetSec.js#L261) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:241](../server/src/routes/admin/backupNetSec.js#L241) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:238](../server/src/routes/admin/backupNetSec.js#L238) |
| GET | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:76](../server/src/routes/admin/veeamEm.js#L76) |
| POST | `/veeam/em` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:87](../server/src/routes/admin/veeamEm.js#L87) |
| DELETE | `/veeam/em/:id` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:99](../server/src/routes/admin/veeamEm.js#L99) |
| POST | `/veeam/em/:id/collect` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:144](../server/src/routes/admin/veeamEm.js#L144) |
| POST | `/veeam/em/:id/test` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:126](../server/src/routes/admin/veeamEm.js#L126) |
| PUT | `/veeam/em/map` | 역할 `admin` · `fleetWideOnly` | [server/src/routes/admin/veeamEm.js:114](../server/src/routes/admin/veeamEm.js#L114) |
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
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:504](../server/src/routes/admin/collectorsDc.js#L504) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:532](../server/src/routes/admin/collectorsDc.js#L532) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/activity` | — | [server/src/routes/auth.js:334](../server/src/routes/auth.js#L334) |
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:415](../server/src/routes/auth.js#L415) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` · `requireSettingsOwner` | [server/src/routes/auth.js:425](../server/src/routes/auth.js#L425) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `adFleetOnly` | [server/src/routes/auth.js:438](../server/src/routes/auth.js#L438) |
| GET | `/config` | — | [server/src/routes/auth.js:37](../server/src/routes/auth.js#L37) |
| POST | `/extend` | `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:265](../server/src/routes/auth.js#L265) |
| POST | `/login` | — | [server/src/routes/auth.js:61](../server/src/routes/auth.js#L61) |
| POST | `/logout` | `authMiddleware` | [server/src/routes/auth.js:316](../server/src/routes/auth.js#L316) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:235](../server/src/routes/auth.js#L235) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:364](../server/src/routes/auth.js#L364) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:385](../server/src/routes/auth.js#L385) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:271](../server/src/routes/ping.js#L271) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:281](../server/src/routes/ping.js#L281) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:195](../server/src/routes/ping.js#L195) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:231](../server/src/routes/ping.js#L231) |
| GET | `/series` | — | [server/src/routes/ping.js:102](../server/src/routes/ping.js#L102) |
| GET | `/settings` | — | [server/src/routes/ping.js:218](../server/src/routes/ping.js#L218) |
| PUT | `/settings` | 역할 `admin` | [server/src/routes/ping.js:222](../server/src/routes/ping.js#L222) |
| GET | `/status` | — | [server/src/routes/ping.js:84](../server/src/routes/ping.js#L84) |
| GET | `/targets` | — | [server/src/routes/ping.js:97](../server/src/routes/ping.js#L97) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:162](../server/src/routes/ping.js#L162) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:174](../server/src/routes/ping.js#L174) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:168](../server/src/routes/ping.js#L168) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:288](../server/src/routes/ping.js#L288) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:302](../server/src/routes/ping.js#L302) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:304](../server/src/routes/ping.js#L304) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:310](../server/src/routes/ping.js#L310) |

## `/metrics`

Prometheus/OTel 익스포터(선택 토큰).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/metricsExport.js:30](../server/src/routes/metricsExport.js#L30) |

## `/api/v1`

**외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/` | — | [server/src/routes/publicApi.js:182](../server/src/routes/publicApi.js#L182) |
| GET | `/capacity/datastores` | `guarded` | [server/src/routes/publicApi.js:327](../server/src/routes/publicApi.js#L327) |
| GET | `/capacity/storage` | `guarded` | [server/src/routes/publicApi.js:342](../server/src/routes/publicApi.js#L342) |
| GET | `/capacity/storage-growth` | `guarded` | [server/src/routes/publicApi.js:464](../server/src/routes/publicApi.js#L464) |
| GET | `/faults/alarms` | `guarded` | [server/src/routes/publicApi.js:511](../server/src/routes/publicApi.js#L511) |
| GET | `/faults/parts` | `guarded` | [server/src/routes/publicApi.js:536](../server/src/routes/publicApi.js#L536) |
| GET | `/inventory/collection` | `guarded` | [server/src/routes/publicApi.js:294](../server/src/routes/publicApi.js#L294) |
| GET | `/inventory/summary` | `guarded` | [server/src/routes/publicApi.js:199](../server/src/routes/publicApi.js#L199) |
| GET | `/inventory/vcenters` | `guarded` | [server/src/routes/publicApi.js:269](../server/src/routes/publicApi.js#L269) |
| GET | `/openapi.json` | — | [server/src/routes/publicApi.js:192](../server/src/routes/publicApi.js#L192) |
| GET | `/san-storage/arrays` | `guarded` | [server/src/routes/publicApi.js:577](../server/src/routes/publicApi.js#L577) |
| GET | `/san-storage/check` | `guarded` | [server/src/routes/publicApi.js:593](../server/src/routes/publicApi.js#L593) |

## `/api`

포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:651](../server/src/routes/api/inventory.js#L651) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:654](../server/src/routes/api/inventory.js#L654) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:662](../server/src/routes/api/inventory.js#L662) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:634](../server/src/routes/api/inventory.js#L634) |
| GET | `/attach/:kind/:owner` | — | [server/src/routes/api/attach.js:133](../server/src/routes/api/attach.js#L133) |
| POST | `/attach/:kind/:owner` | 역할 `admin/operator` · `uploadPrecheck` · `express.raw` | [server/src/routes/api/attach.js:149](../server/src/routes/api/attach.js#L149) |
| GET | `/attach/admin/archive` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/attach.js:83](../server/src/routes/api/attach.js#L83) |
| PUT | `/attach/admin/settings` | 역할 `admin` · `fleetOnly` · `fullWriteOnly` | [server/src/routes/api/attach.js:74](../server/src/routes/api/attach.js#L74) |
| GET | `/attach/admin/usage` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/attach.js:69](../server/src/routes/api/attach.js#L69) |
| DELETE | `/attach/file/:id` | 역할 `admin/operator` | [server/src/routes/api/attach.js:118](../server/src/routes/api/attach.js#L118) |
| GET | `/attach/file/:id` | — | [server/src/routes/api/attach.js:102](../server/src/routes/api/attach.js#L102) |
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
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:545](../server/src/routes/api/inventory.js#L545) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:553](../server/src/routes/api/inventory.js#L553) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:132](../server/src/routes/api/overviewNsx.js#L132) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:353](../server/src/routes/api/inventory.js#L353) |
| GET | `/hosts/:id` | 권한 `inv.hosts` | [server/src/routes/api/hostChecks.js:67](../server/src/routes/api/hostChecks.js#L67) |
| POST | `/hosts/:id/endpoint-locate` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:382](../server/src/routes/api/hostSan.js#L382) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:201](../server/src/routes/api/vmMetrics.js#L201) |
| GET | `/hosts/:id/net-uplinks` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:261](../server/src/routes/api/hostSan.js#L261) |
| GET | `/hosts/:id/nic-stats` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:231](../server/src/routes/api/vmMetrics.js#L231) |
| GET | `/hosts/:id/san-attribution` | 권한 `inv.hosts` | [server/src/routes/api/hostSan.js:205](../server/src/routes/api/hostSan.js#L205) |
| GET | `/hosts/checks` | 권한 `inv.hosts` | [server/src/routes/api/hostChecks.js:43](../server/src/routes/api/hostChecks.js#L43) |
| GET | `/hosts/corp` | 권한 `inv.hosts` | [server/src/routes/api/hostCorp.js:39](../server/src/routes/api/hostCorp.js#L39) |
| GET | `/idrac/host-power` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:318](../server/src/routes/api/vmMetrics.js#L318) |
| GET | `/issues` | — | [server/src/routes/api/issues.js:338](../server/src/routes/api/issues.js#L338) |
| POST | `/issues` | `creators` | [server/src/routes/api/issues.js:443](../server/src/routes/api/issues.js#L443) |
| DELETE | `/issues/:key` | 역할 `admin/operator` | [server/src/routes/api/issues.js:607](../server/src/routes/api/issues.js#L607) |
| GET | `/issues/:key` | — | [server/src/routes/api/issues.js:438](../server/src/routes/api/issues.js#L438) |
| PUT | `/issues/:key` | 역할 `admin/operator` | [server/src/routes/api/issues.js:470](../server/src/routes/api/issues.js#L470) |
| POST | `/issues/:key/assign` | 역할 `admin/operator` | [server/src/routes/api/issues.js:527](../server/src/routes/api/issues.js#L527) |
| POST | `/issues/:key/block` | 역할 `admin/operator` | [server/src/routes/api/issues.js:535](../server/src/routes/api/issues.js#L535) |
| POST | `/issues/:key/comments` | 역할 `admin/operator` | [server/src/routes/api/issues.js:565](../server/src/routes/api/issues.js#L565) |
| DELETE | `/issues/:key/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/issues.js:599](../server/src/routes/api/issues.js#L599) |
| PUT | `/issues/:key/comments/:cid` | 역할 `admin/operator` | [server/src/routes/api/issues.js:591](../server/src/routes/api/issues.js#L591) |
| POST | `/issues/:key/links` | 역할 `admin/operator` | [server/src/routes/api/issues.js:487](../server/src/routes/api/issues.js#L487) |
| POST | `/issues/:key/links/remove` | 역할 `admin/operator` | [server/src/routes/api/issues.js:495](../server/src/routes/api/issues.js#L495) |
| GET | `/issues/:key/mentionables` | 역할 `admin/operator` | [server/src/routes/api/issues.js:549](../server/src/routes/api/issues.js#L549) |
| POST | `/issues/:key/progress` | 역할 `admin/operator` | [server/src/routes/api/issues.js:519](../server/src/routes/api/issues.js#L519) |
| POST | `/issues/:key/status` | 역할 `admin/operator` | [server/src/routes/api/issues.js:478](../server/src/routes/api/issues.js#L478) |
| POST | `/issues/:key/watch` | 역할 `admin/operator` | [server/src/routes/api/issues.js:544](../server/src/routes/api/issues.js#L544) |
| POST | `/issues/:key/worklog` | 역할 `admin/operator` | [server/src/routes/api/issues.js:505](../server/src/routes/api/issues.js#L505) |
| POST | `/issues/:key/worklog/remove` | 역할 `admin/operator` | [server/src/routes/api/issues.js:512](../server/src/routes/api/issues.js#L512) |
| GET | `/issues/activity` | — | [server/src/routes/api/issues.js:312](../server/src/routes/api/issues.js#L312) |
| GET | `/issues/autocreate` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:282](../server/src/routes/api/issues.js#L282) |
| PUT | `/issues/autocreate` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:293](../server/src/routes/api/issues.js#L293) |
| GET | `/issues/autocreate/alerts` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:230](../server/src/routes/api/issues.js#L230) |
| PUT | `/issues/autocreate/alerts` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:235](../server/src/routes/api/issues.js#L235) |
| POST | `/issues/autocreate/simulate` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:304](../server/src/routes/api/issues.js#L304) |
| POST | `/issues/bulk/assign` | 역할 `admin/operator` | [server/src/routes/api/issues.js:463](../server/src/routes/api/issues.js#L463) |
| POST | `/issues/bulk/edit` | 역할 `admin/operator` | [server/src/routes/api/issues.js:456](../server/src/routes/api/issues.js#L456) |
| GET | `/issues/export.csv` | 권한 `data.csv` | [server/src/routes/api/issues.js:360](../server/src/routes/api/issues.js#L360) |
| GET | `/issues/filters` | — | [server/src/routes/api/issues.js:416](../server/src/routes/api/issues.js#L416) |
| POST | `/issues/filters` | 역할 `admin/operator` | [server/src/routes/api/issues.js:421](../server/src/routes/api/issues.js#L421) |
| DELETE | `/issues/filters/:id` | 역할 `admin/operator` | [server/src/routes/api/issues.js:434](../server/src/routes/api/issues.js#L434) |
| PUT | `/issues/filters/:id` | 역할 `admin/operator` | [server/src/routes/api/issues.js:425](../server/src/routes/api/issues.js#L425) |
| POST | `/issues/filters/:id/subscribe` | 역할 `admin/operator` | [server/src/routes/api/issues.js:430](../server/src/routes/api/issues.js#L430) |
| GET | `/issues/inbox` | — | [server/src/routes/api/issues.js:244](../server/src/routes/api/issues.js#L244) |
| POST | `/issues/inbox/read` | `creators` | [server/src/routes/api/issues.js:255](../server/src/routes/api/issues.js#L255) |
| GET | `/issues/meta` | — | [server/src/routes/api/issues.js:161](../server/src/routes/api/issues.js#L161) |
| GET | `/issues/report` | — | [server/src/routes/api/issues.js:268](../server/src/routes/api/issues.js#L268) |
| GET | `/issues/report.csv` | 권한 `data.csv` | [server/src/routes/api/issues.js:272](../server/src/routes/api/issues.js#L272) |
| GET | `/issues/settings` | 역할 `admin` · `issueSettingsFleetOnly` | [server/src/routes/api/issues.js:215](../server/src/routes/api/issues.js#L215) |
| PUT | `/issues/settings` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:221](../server/src/routes/api/issues.js#L221) |
| GET | `/issues/sprints` | — | [server/src/routes/api/issues.js:374](../server/src/routes/api/issues.js#L374) |
| POST | `/issues/sprints` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:383](../server/src/routes/api/issues.js#L383) |
| PUT | `/issues/sprints/:id` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:391](../server/src/routes/api/issues.js#L391) |
| GET | `/issues/sprints/:id/board` | — | [server/src/routes/api/issues.js:379](../server/src/routes/api/issues.js#L379) |
| POST | `/issues/sprints/:id/close` | 역할 `admin/operator` · `sprintFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:400](../server/src/routes/api/issues.js#L400) |
| GET | `/issues/stats` | — | [server/src/routes/api/issues.js:179](../server/src/routes/api/issues.js#L179) |
| GET | `/issues/suggest` | — | [server/src/routes/api/issues.js:184](../server/src/routes/api/issues.js#L184) |
| GET | `/issues/templates` | `creators` | [server/src/routes/api/issues.js:196](../server/src/routes/api/issues.js#L196) |
| POST | `/issues/templates` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:203](../server/src/routes/api/issues.js#L203) |
| DELETE | `/issues/templates/:id` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:211](../server/src/routes/api/issues.js#L211) |
| PUT | `/issues/templates/:id` | 역할 `admin` · `issueSettingsFleetOnly` · `fullWriteOnly` | [server/src/routes/api/issues.js:207](../server/src/routes/api/issues.js#L207) |
| GET | `/issues/versions` | — | [server/src/routes/api/issues.js:346](../server/src/routes/api/issues.js#L346) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:568](../server/src/routes/api/inventory.js#L568) |
| GET | `/notices` | — | [server/src/routes/api/bulletin.js:109](../server/src/routes/api/bulletin.js#L109) |
| POST | `/notices` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:115](../server/src/routes/api/bulletin.js#L115) |
| DELETE | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:130](../server/src/routes/api/bulletin.js#L130) |
| PUT | `/notices/:id` | 역할 `admin` · `noticeFleetOnly` | [server/src/routes/api/bulletin.js:122](../server/src/routes/api/bulletin.js#L122) |
| GET | `/notices/active` | — | [server/src/routes/api/bulletin.js:105](../server/src/routes/api/bulletin.js#L105) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:238](../server/src/routes/api/overviewNsx.js#L238) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:272](../server/src/routes/api/overviewNsx.js#L272) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:189](../server/src/routes/api/overviewNsx.js#L189) |
| GET | `/overview/cards` | — | [server/src/routes/api/overviewCards.js:155](../server/src/routes/api/overviewCards.js#L155) |
| GET | `/overview/trend` | — | [server/src/routes/api/overviewCards.js:211](../server/src/routes/api/overviewCards.js#L211) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:117](../server/src/routes/api/perfClient.js#L117) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:75](../server/src/routes/api/perfClient.js#L75) |
| GET | `/perf/req-status` | — | [server/src/routes/api/perfClient.js:105](../server/src/routes/api/perfClient.js#L105) |
| GET | `/platform/summary` | — | [server/src/routes/api/inventory.js:524](../server/src/routes/api/inventory.js#L524) |
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
| GET | `/settings/ssh-access` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:44](../server/src/routes/api/sshAccess.js#L44) |
| GET | `/settings/ssh-access/changes` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:140](../server/src/routes/api/sshAccess.js#L140) |
| DELETE | `/settings/ssh-access/corps/:corp/stop` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:115](../server/src/routes/api/sshAccess.js#L115) |
| POST | `/settings/ssh-access/corps/:corp/stop` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:109](../server/src/routes/api/sshAccess.js#L109) |
| POST | `/settings/ssh-access/inbox/approve` | 역할 `admin` · `requireSettingsOwner` · `vaultFirst` · `reauth` | [server/src/routes/api/sshAccess.js:122](../server/src/routes/api/sshAccess.js#L122) |
| POST | `/settings/ssh-access/inbox/discard` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:129](../server/src/routes/api/sshAccess.js#L129) |
| POST | `/settings/ssh-access/keys` | 역할 `admin` · `requireSettingsOwner` · `vaultFirst` · `reauth` | [server/src/routes/api/sshAccess.js:66](../server/src/routes/api/sshAccess.js#L66) |
| PUT | `/settings/ssh-access/keys/:id/placement` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:74](../server/src/routes/api/sshAccess.js#L74) |
| POST | `/settings/ssh-access/reload-keystore` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:59](../server/src/routes/api/sshAccess.js#L59) |
| POST | `/settings/ssh-access/reload-state` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:54](../server/src/routes/api/sshAccess.js#L54) |
| POST | `/settings/ssh-access/scan` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:49](../server/src/routes/api/sshAccess.js#L49) |
| GET | `/settings/ssh-access/servers/:id/candidates` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:90](../server/src/routes/api/sshAccess.js#L90) |
| POST | `/settings/ssh-access/servers/:id/installed-keys` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:94](../server/src/routes/api/sshAccess.js#L94) |
| POST | `/settings/ssh-access/servers/:id/key` | 역할 `admin` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/sshAccess.js:83](../server/src/routes/api/sshAccess.js#L83) |
| POST | `/settings/ssh-access/servers/:id/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:102](../server/src/routes/api/sshAccess.js#L102) |
| GET | `/settings/ssh-access/usage` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/sshAccess.js:137](../server/src/routes/api/sshAccess.js#L137) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:164](../server/src/routes/api/inventory.js#L164) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:681](../server/src/routes/api/inventory.js#L681) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:677](../server/src/routes/api/inventory.js#L677) |
| GET | `/tools/backup-detail` | 권한 `tools` | [server/src/routes/api/veeam.js:1444](../server/src/routes/api/veeam.js#L1444) |
| GET | `/tools/backup-detail.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1516](../server/src/routes/api/veeam.js#L1516) |
| PUT | `/tools/backup-detail/marks` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/veeam.js:1459](../server/src/routes/api/veeam.js#L1459) |
| GET | `/tools/backup-em` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:1405](../server/src/routes/api/veeam.js#L1405) |
| GET | `/tools/backup-em/session` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/veeam.js:1414](../server/src/routes/api/veeam.js#L1414) |
| POST | `/tools/backup-run/backup` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupRun.js:160](../server/src/routes/api/backupRun.js#L160) |
| POST | `/tools/backup-run/plan` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:152](../server/src/routes/api/backupRun.js#L152) |
| GET | `/tools/backup-run/portal-vms` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:93](../server/src/routes/api/backupManage.js#L93) |
| GET | `/tools/backup-run/runs` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:169](../server/src/routes/api/backupRun.js#L169) |
| GET | `/tools/backup-run/runs/:id` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:177](../server/src/routes/api/backupRun.js#L177) |
| POST | `/tools/backup-run/runs/:id/close` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupRun.js:188](../server/src/routes/api/backupRun.js#L188) |
| POST | `/tools/backup-run/servers/:id/repos` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/backupRun.js:227](../server/src/routes/api/backupRun.js#L227) |
| GET | `/tools/backup-run/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/backupRun.js:201](../server/src/routes/api/backupRun.js#L201) |
| PUT | `/tools/backup-run/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` · `reauth` | [server/src/routes/api/backupRun.js:214](../server/src/routes/api/backupRun.js#L214) |
| GET | `/tools/backup-run/vm/:vmId` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:111](../server/src/routes/api/backupManage.js#L111) |
| POST | `/tools/backup-run/vm/:vmId/delete-backup` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:183](../server/src/routes/api/backupManage.js#L183) |
| POST | `/tools/backup-run/vm/:vmId/exclude` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:164](../server/src/routes/api/backupManage.js#L164) |
| POST | `/tools/backup-run/vm/:vmId/points` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupManage.js:129](../server/src/routes/api/backupManage.js#L129) |
| POST | `/tools/backup-run/vm/:vmId/restore` | 역할 `admin` · 권한 `tools` · `reauth` | [server/src/routes/api/backupManage.js:140](../server/src/routes/api/backupManage.js#L140) |
| GET | `/tools/backup-run/vms` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/backupRun.js:121](../server/src/routes/api/backupRun.js#L121) |
| GET | `/tools/backup-summary` | 권한 `tools` | [server/src/routes/api/veeam.js:1280](../server/src/routes/api/veeam.js#L1280) |
| GET | `/tools/backup-summary.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1492](../server/src/routes/api/veeam.js#L1492) |
| GET | `/tools/backup-summary/alert` | 권한 `tools` | [server/src/routes/api/veeam.js:1339](../server/src/routes/api/veeam.js#L1339) |
| PUT | `/tools/backup-summary/alert` | 역할 `admin` · 권한 `tools` · `alertFullScope` | [server/src/routes/api/veeam.js:1347](../server/src/routes/api/veeam.js#L1347) |
| POST | `/tools/backup-summary/alert/send` | 역할 `admin` · 권한 `tools` · `alertFullScope` | [server/src/routes/api/veeam.js:1359](../server/src/routes/api/veeam.js#L1359) |
| GET | `/tools/backup-summary/errors` | 권한 `tools` | [server/src/routes/api/veeam.js:1317](../server/src/routes/api/veeam.js#L1317) |
| GET | `/tools/backup-summary/schedule` | 권한 `tools` | [server/src/routes/api/veeam.js:1309](../server/src/routes/api/veeam.js#L1309) |
| GET | `/tools/backup-summary/stale` | 권한 `tools` | [server/src/routes/api/veeam.js:1293](../server/src/routes/api/veeam.js#L1293) |
| GET | `/tools/backup-summary/stale.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/veeam.js:1371](../server/src/routes/api/veeam.js#L1371) |
| GET | `/tools/bareos-backup` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:438](../server/src/routes/api/bareosBackup.js#L438) |
| GET | `/tools/bareos-backup/badges` | 권한 `tools` | [server/src/routes/api/bareosBackup.js:1779](../server/src/routes/api/bareosBackup.js#L1779) |
| GET | `/tools/bareos-backup/digest` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:1738](../server/src/routes/api/bareosBackup.js#L1738) |
| PUT | `/tools/bareos-backup/digest` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1742](../server/src/routes/api/bareosBackup.js#L1742) |
| POST | `/tools/bareos-backup/digest/send` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1752](../server/src/routes/api/bareosBackup.js#L1752) |
| GET | `/tools/bareos-backup/dr/check` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1434](../server/src/routes/api/bareosBackup.js#L1434) |
| GET | `/tools/bareos-backup/dr/runs` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1533](../server/src/routes/api/bareosBackup.js#L1533) |
| POST | `/tools/bareos-backup/dr/runs` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1517](../server/src/routes/api/bareosBackup.js#L1517) |
| POST | `/tools/bareos-backup/dr/runs/:id/resume` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1561](../server/src/routes/api/bareosBackup.js#L1561) |
| POST | `/tools/bareos-backup/dr/runs/:id/stop` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1553](../server/src/routes/api/bareosBackup.js#L1553) |
| POST | `/tools/bareos-backup/dr/runs/check` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1509](../server/src/routes/api/bareosBackup.js#L1509) |
| POST | `/tools/bareos-backup/groups` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:271](../server/src/routes/api/bareosGroups.js#L271) |
| DELETE | `/tools/bareos-backup/groups/:id` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:328](../server/src/routes/api/bareosGroups.js#L328) |
| PUT | `/tools/bareos-backup/groups/:id` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:292](../server/src/routes/api/bareosGroups.js#L292) |
| POST | `/tools/bareos-backup/groups/:id/cancel` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:360](../server/src/routes/api/bareosGroups.js#L360) |
| POST | `/tools/bareos-backup/groups/:id/prune-preview` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:344](../server/src/routes/api/bareosGroups.js#L344) |
| POST | `/tools/bareos-backup/groups/:id/run` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:383](../server/src/routes/api/bareosGroups.js#L383) |
| GET | `/tools/bareos-backup/groups/options` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:259](../server/src/routes/api/bareosGroups.js#L259) |
| GET | `/tools/bareos-backup/groups/tree` | 역할 `admin` | [server/src/routes/api/bareosGroups.js:182](../server/src/routes/api/bareosGroups.js#L182) |
| GET | `/tools/bareos-backup/health` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1591](../server/src/routes/api/bareosBackup.js#L1591) |
| POST | `/tools/bareos-backup/health/:vcenterId/thumb-accept` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1636](../server/src/routes/api/bareosBackup.js#L1636) |
| POST | `/tools/bareos-backup/health/run` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1604](../server/src/routes/api/bareosBackup.js#L1604) |
| GET | `/tools/bareos-backup/health/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:1649](../server/src/routes/api/bareosBackup.js#L1649) |
| PUT | `/tools/bareos-backup/health/settings` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1654](../server/src/routes/api/bareosBackup.js#L1654) |
| POST | `/tools/bareos-backup/jobs` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:872](../server/src/routes/api/bareosBackup.js#L872) |
| DELETE | `/tools/bareos-backup/jobs/:id` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1020](../server/src/routes/api/bareosBackup.js#L1020) |
| PATCH | `/tools/bareos-backup/jobs/:id` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:998](../server/src/routes/api/bareosBackup.js#L998) |
| POST | `/tools/bareos-backup/jobs/:id/cancel` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:950](../server/src/routes/api/bareosBackup.js#L950) |
| GET | `/tools/bareos-backup/jobs/:id/history` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1059](../server/src/routes/api/bareosBackup.js#L1059) |
| GET | `/tools/bareos-backup/jobs/:id/log` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1065](../server/src/routes/api/bareosBackup.js#L1065) |
| POST | `/tools/bareos-backup/jobs/:id/restore` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1107](../server/src/routes/api/bareosBackup.js#L1107) |
| GET | `/tools/bareos-backup/jobs/:id/restore-points` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1091](../server/src/routes/api/bareosBackup.js#L1091) |
| POST | `/tools/bareos-backup/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:924](../server/src/routes/api/bareosBackup.js#L924) |
| POST | `/tools/bareos-backup/jobs/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:892](../server/src/routes/api/bareosBackup.js#L892) |
| GET | `/tools/bareos-backup/live` | 역할 `admin` | [server/src/routes/api/bareosLive.js:222](../server/src/routes/api/bareosLive.js#L222) |
| POST | `/tools/bareos-backup/logs/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1232](../server/src/routes/api/bareosBackup.js#L1232) |
| POST | `/tools/bareos-backup/policy/collect` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bareosPolicy.js:121](../server/src/routes/api/bareosPolicy.js#L121) |
| GET | `/tools/bareos-backup/policy/volumes` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bareosPolicy.js:91](../server/src/routes/api/bareosPolicy.js#L91) |
| POST | `/tools/bareos-backup/poll` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1761](../server/src/routes/api/bareosBackup.js#L1761) |
| GET | `/tools/bareos-backup/rehearsal` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1668](../server/src/routes/api/bareosBackup.js#L1668) |
| PUT | `/tools/bareos-backup/rehearsal` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1704](../server/src/routes/api/bareosBackup.js#L1704) |
| POST | `/tools/bareos-backup/rehearsal/run` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:1717](../server/src/routes/api/bareosBackup.js#L1717) |
| POST | `/tools/bareos-backup/restore-check/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1325](../server/src/routes/api/bareosBackup.js#L1325) |
| GET | `/tools/bareos-backup/restore-folders` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1183](../server/src/routes/api/bareosBackup.js#L1183) |
| POST | `/tools/bareos-backup/restore-points/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1190](../server/src/routes/api/bareosBackup.js#L1190) |
| POST | `/tools/bareos-backup/restore/bulk` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:1336](../server/src/routes/api/bareosBackup.js#L1336) |
| GET | `/tools/bareos-backup/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:531](../server/src/routes/api/bareosBackup.js#L531) |
| PUT | `/tools/bareos-backup/settings` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:567](../server/src/routes/api/bareosBackup.js#L567) |
| POST | `/tools/bareos-backup/settings/directors` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:595](../server/src/routes/api/bareosBackup.js#L595) |
| DELETE | `/tools/bareos-backup/settings/directors/:directorId` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:629](../server/src/routes/api/bareosBackup.js#L629) |
| PUT | `/tools/bareos-backup/settings/directors/:directorId` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:609](../server/src/routes/api/bareosBackup.js#L609) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/director` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:784](../server/src/routes/api/bareosBackup.js#L784) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:817](../server/src/routes/api/bareosBackup.js#L817) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-plugin` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:803](../server/src/routes/api/bareosBackup.js#L803) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/fd-thumbprint` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:832](../server/src/routes/api/bareosBackup.js#L832) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/auto-setup/preflight` | 역할 `admin` · `fullScopeOnly` · `fullWriteOnly` | [server/src/routes/api/bareosBackup.js:769](../server/src/routes/api/bareosBackup.js#L769) |
| GET | `/tools/bareos-backup/settings/directors/:directorId/catalog` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:699](../server/src/routes/api/bareosBackup.js#L699) |
| GET | `/tools/bareos-backup/settings/directors/:directorId/suggest` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:708](../server/src/routes/api/bareosBackup.js#L708) |
| POST | `/tools/bareos-backup/settings/directors/:directorId/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bareosBackup.js:648](../server/src/routes/api/bareosBackup.js#L648) |
| GET | `/tools/bareos-backup/vm-candidates` | 역할 `admin` | [server/src/routes/api/bareosBackup.js:847](../server/src/routes/api/bareosBackup.js#L847) |
| GET | `/tools/bareos-detail` | 권한 `tools` | [server/src/routes/api/bareosViews.js:195](../server/src/routes/api/bareosViews.js#L195) |
| GET | `/tools/bareos-detail.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/bareosViews.js:225](../server/src/routes/api/bareosViews.js#L225) |
| GET | `/tools/bareos-summary` | 권한 `tools` | [server/src/routes/api/bareosViews.js:188](../server/src/routes/api/bareosViews.js#L188) |
| GET | `/tools/bareos-summary.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/bareosViews.js:206](../server/src/routes/api/bareosViews.js#L206) |
| GET | `/tools/bareos-summary/policy` | 권한 `tools` | [server/src/routes/api/bareosPolicy.js:44](../server/src/routes/api/bareosPolicy.js#L44) |
| GET | `/tools/bareos-summary/pools` | 권한 `tools` | [server/src/routes/api/bareosPolicy.js:70](../server/src/routes/api/bareosPolicy.js#L70) |
| GET | `/tools/bm-folders` | 권한 `tools` | [server/src/routes/api/bmFolders.js:412](../server/src/routes/api/bmFolders.js#L412) |
| GET | `/tools/bm-folders.csv` | 권한 `tools`, `data.csv` | [server/src/routes/api/bmFolders.js:582](../server/src/routes/api/bmFolders.js#L582) |
| POST | `/tools/bm-folders/edge/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmFolders.js:402](../server/src/routes/api/bmFolders.js#L402) |
| GET | `/tools/bm-folders/hw` | 권한 `tools` | [server/src/routes/api/bmFolders.js:521](../server/src/routes/api/bmFolders.js#L521) |
| POST | `/tools/bm-folders/op` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmFolders.js:608](../server/src/routes/api/bmFolders.js#L608) |
| GET | `/tools/bm-folders/search` | 권한 `tools` | [server/src/routes/api/bmFolders.js:488](../server/src/routes/api/bmFolders.js#L488) |
| GET | `/tools/bm-folders/trend` | 권한 `tools` | [server/src/routes/api/bmFolders.js:547](../server/src/routes/api/bmFolders.js#L547) |
| GET | `/tools/bm-storage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:129](../server/src/routes/api/bmstor.js#L129) |
| GET | `/tools/bm-storage/auth-choices` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/bmstor.js:573](../server/src/routes/api/bmstor.js#L573) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:677](../server/src/routes/api/bmstor.js#L677) |
| GET | `/tools/bm-storage/compare` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:153](../server/src/routes/api/bmstor.js#L153) |
| GET | `/tools/bm-storage/compare-set` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:381](../server/src/routes/api/bmstor.js#L381) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:610](../server/src/routes/api/bmstor.js#L610) |
| GET | `/tools/bm-storage/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:358](../server/src/routes/api/bmstor.js#L358) |
| POST | `/tools/bm-storage/import` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:630](../server/src/routes/api/bmstor.js#L630) |
| GET | `/tools/bm-storage/io/series` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:212](../server/src/routes/api/bmstor.js#L212) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` · `csvPerm` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:624](../server/src/routes/api/bmstor.js#L624) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:545](../server/src/routes/api/bmstor.js#L545) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:594](../server/src/routes/api/bmstor.js#L594) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/bmstor.js:601](../server/src/routes/api/bmstor.js#L601) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1002](../server/src/routes/api/bmUsage.js#L1002) |
| GET | `/tools/bm-usage/accounts` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:124](../server/src/routes/api/bmOnboard.js#L124) |
| POST | `/tools/bm-usage/accounts` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `accountFirst` · `reauth` | [server/src/routes/api/bmOnboard.js:147](../server/src/routes/api/bmOnboard.js#L147) |
| DELETE | `/tools/bm-usage/accounts/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:157](../server/src/routes/api/bmOnboard.js#L157) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1272](../server/src/routes/api/bmUsage.js#L1272) |
| GET | `/tools/bm-usage/annotations` | 권한 `tools` | [server/src/routes/api/bmAnnotations.js:192](../server/src/routes/api/bmAnnotations.js#L192) |
| POST | `/tools/bm-usage/annotations` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:196](../server/src/routes/api/bmAnnotations.js#L196) |
| DELETE | `/tools/bm-usage/annotations/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:198](../server/src/routes/api/bmAnnotations.js#L198) |
| PUT | `/tools/bm-usage/annotations/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmAnnotations.js:197](../server/src/routes/api/bmAnnotations.js#L197) |
| GET | `/tools/bm-usage/capacity` | 권한 `tools` | [server/src/routes/api/bmCapacity.js:112](../server/src/routes/api/bmCapacity.js#L112) |
| GET | `/tools/bm-usage/capacity/:key` | 권한 `tools` | [server/src/routes/api/bmCapacity.js:113](../server/src/routes/api/bmCapacity.js#L113) |
| POST | `/tools/bm-usage/capacity/recompute` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCapacity.js:114](../server/src/routes/api/bmCapacity.js#L114) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1243](../server/src/routes/api/bmUsage.js#L1243) |
| GET | `/tools/bm-usage/collect-health` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCollectHealth.js:173](../server/src/routes/api/bmCollectHealth.js#L173) |
| GET | `/tools/bm-usage/compare` | 권한 `tools` | [server/src/routes/api/bmCompare.js:267](../server/src/routes/api/bmCompare.js#L267) |
| POST | `/tools/bm-usage/compare/focus` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:268](../server/src/routes/api/bmCompare.js#L268) |
| GET | `/tools/bm-usage/compare/sets` | 권한 `tools` | [server/src/routes/api/bmCompare.js:269](../server/src/routes/api/bmCompare.js#L269) |
| PUT | `/tools/bm-usage/compare/sets` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:270](../server/src/routes/api/bmCompare.js#L270) |
| DELETE | `/tools/bm-usage/compare/sets/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmCompare.js:271](../server/src/routes/api/bmCompare.js#L271) |
| PUT | `/tools/bm-usage/distribute` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/bmUsage.js:1464](../server/src/routes/api/bmUsage.js#L1464) |
| PUT | `/tools/bm-usage/distribute/edge` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/bmUsage.js:1494](../server/src/routes/api/bmUsage.js#L1494) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1330](../server/src/routes/api/bmUsage.js#L1330) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1417](../server/src/routes/api/bmUsage.js#L1417) |
| GET | `/tools/bm-usage/faults` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1143](../server/src/routes/api/bmUsage.js#L1143) |
| GET | `/tools/bm-usage/focus` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:298](../server/src/routes/api/bmPerfOps.js#L298) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1200](../server/src/routes/api/bmUsage.js#L1200) |
| GET | `/tools/bm-usage/idle` | 권한 `tools` | [server/src/routes/api/bmIdle.js:173](../server/src/routes/api/bmIdle.js#L173) |
| POST | `/tools/bm-usage/idle/recompute` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmIdle.js:177](../server/src/routes/api/bmIdle.js#L177) |
| POST | `/tools/bm-usage/idle/review` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmIdle.js:174](../server/src/routes/api/bmIdle.js#L174) |
| GET | `/tools/bm-usage/key-overlaps` | 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:146](../server/src/routes/api/bmKeyOverlaps.js#L146) |
| DELETE | `/tools/bm-usage/key-overlaps/decision` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:150](../server/src/routes/api/bmKeyOverlaps.js#L150) |
| POST | `/tools/bm-usage/key-overlaps/decision` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmKeyOverlaps.js:149](../server/src/routes/api/bmKeyOverlaps.js#L149) |
| GET | `/tools/bm-usage/logs` | 권한 `tools` | [server/src/routes/api/bmLogs.js:154](../server/src/routes/api/bmLogs.js#L154) |
| GET | `/tools/bm-usage/maintenance` | 권한 `tools` | [server/src/routes/api/bmMaint.js:334](../server/src/routes/api/bmMaint.js#L334) |
| POST | `/tools/bm-usage/maintenance` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:345](../server/src/routes/api/bmMaint.js#L345) |
| DELETE | `/tools/bm-usage/maintenance/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:349](../server/src/routes/api/bmMaint.js#L349) |
| PUT | `/tools/bm-usage/maintenance/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:346](../server/src/routes/api/bmMaint.js#L346) |
| POST | `/tools/bm-usage/maintenance/:id/confirm` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:348](../server/src/routes/api/bmMaint.js#L348) |
| POST | `/tools/bm-usage/maintenance/:id/end` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:347](../server/src/routes/api/bmMaint.js#L347) |
| GET | `/tools/bm-usage/maintenance/occurrences` | 권한 `tools` | [server/src/routes/api/bmMaint.js:338](../server/src/routes/api/bmMaint.js#L338) |
| POST | `/tools/bm-usage/maintenance/preview` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmMaint.js:342](../server/src/routes/api/bmMaint.js#L342) |
| POST | `/tools/bm-usage/onboard/analyze` | 역할 `admin` · 권한 `tools`, `data.csv` · `noDemo` | [server/src/routes/api/bmOnboard.js:224](../server/src/routes/api/bmOnboard.js#L224) |
| POST | `/tools/bm-usage/onboard/apply` | 역할 `admin` · 권한 `tools`, `data.csv` · `noDemo` | [server/src/routes/api/bmOnboard.js:240](../server/src/routes/api/bmOnboard.js#L240) |
| GET | `/tools/bm-usage/onboard/codes` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:359](../server/src/routes/api/bmOnboard.js#L359) |
| DELETE | `/tools/bm-usage/onboard/edge-rows` | 역할 `admin` · 권한 `tools` · `noDemo` | [server/src/routes/api/bmOnboard.js:289](../server/src/routes/api/bmOnboard.js#L289) |
| GET | `/tools/bm-usage/onboard/edge-rows` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:269](../server/src/routes/api/bmOnboard.js#L269) |
| GET | `/tools/bm-usage/onboard/missing` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:303](../server/src/routes/api/bmOnboard.js#L303) |
| GET | `/tools/bm-usage/onboard/template.csv` | 역할 `admin` · 권한 `tools`, `data.csv` | [server/src/routes/api/bmOnboard.js:212](../server/src/routes/api/bmOnboard.js#L212) |
| POST | `/tools/bm-usage/onboard/test` | 역할 `admin` · 권한 `tools` · `noDemo` | [server/src/routes/api/bmOnboard.js:344](../server/src/routes/api/bmOnboard.js#L344) |
| GET | `/tools/bm-usage/perf-rules` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:308](../server/src/routes/api/bmPerfOps.js#L308) |
| PUT | `/tools/bm-usage/perf-rules` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmPerfOps.js:309](../server/src/routes/api/bmPerfOps.js#L309) |
| POST | `/tools/bm-usage/perf-rules/dry-run` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/bmPerfOps.js:310](../server/src/routes/api/bmPerfOps.js#L310) |
| GET | `/tools/bm-usage/perf/:key` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1116](../server/src/routes/api/bmUsage.js#L1116) |
| GET | `/tools/bm-usage/perf/:key/devices` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1120](../server/src/routes/api/bmUsage.js#L1120) |
| GET | `/tools/bm-usage/perf/:key/faults` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1139](../server/src/routes/api/bmUsage.js#L1139) |
| GET | `/tools/bm-usage/perf/:key/focus` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:299](../server/src/routes/api/bmPerfOps.js#L299) |
| POST | `/tools/bm-usage/perf/:key/focus` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmPerfOps.js:301](../server/src/routes/api/bmPerfOps.js#L301) |
| GET | `/tools/bm-usage/perf/:key/focus/:id` | 권한 `tools` | [server/src/routes/api/bmPerfOps.js:300](../server/src/routes/api/bmPerfOps.js#L300) |
| POST | `/tools/bm-usage/perf/:key/focus/:id/stop` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmPerfOps.js:302](../server/src/routes/api/bmPerfOps.js#L302) |
| GET | `/tools/bm-usage/perf/:key/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1119](../server/src/routes/api/bmUsage.js#L1119) |
| GET | `/tools/bm-usage/perf/:key/logs` | 권한 `tools` | [server/src/routes/api/bmLogs.js:155](../server/src/routes/api/bmLogs.js#L155) |
| GET | `/tools/bm-usage/perf/:key/playbook` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:199](../server/src/routes/api/bmPlaybookSlo.js#L199) |
| GET | `/tools/bm-usage/perf/:key/ports` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1122](../server/src/routes/api/bmUsage.js#L1122) |
| GET | `/tools/bm-usage/perf/:key/profile` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1134](../server/src/routes/api/bmUsage.js#L1134) |
| GET | `/tools/bm-usage/perf/:key/slo` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:200](../server/src/routes/api/bmPlaybookSlo.js#L200) |
| POST | `/tools/bm-usage/perf/:key/snapshot` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1147](../server/src/routes/api/bmUsage.js#L1147) |
| GET | `/tools/bm-usage/perf/:key/snapshots` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1155](../server/src/routes/api/bmUsage.js#L1155) |
| GET | `/tools/bm-usage/perf/:key/snapshots/:id` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1156](../server/src/routes/api/bmUsage.js#L1156) |
| GET | `/tools/bm-usage/perf/:key/top` | 권한 `tools` | [server/src/routes/api/bmTop.js:127](../server/src/routes/api/bmTop.js#L127) |
| GET | `/tools/bm-usage/perf/:key/top/band` | 권한 `tools` | [server/src/routes/api/bmTop.js:128](../server/src/routes/api/bmTop.js#L128) |
| GET | `/tools/bm-usage/perf/:key/tuning` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1133](../server/src/routes/api/bmUsage.js#L1133) |
| GET | `/tools/bm-usage/playbooks` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:198](../server/src/routes/api/bmPlaybookSlo.js#L198) |
| DELETE | `/tools/bm-usage/port-map` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1197](../server/src/routes/api/bmUsage.js#L1197) |
| PUT | `/tools/bm-usage/port-map` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1196](../server/src/routes/api/bmUsage.js#L1196) |
| GET | `/tools/bm-usage/power` | 권한 `tools` | [server/src/routes/api/bmPower.js:137](../server/src/routes/api/bmPower.js#L137) |
| GET | `/tools/bm-usage/profiles` | 권한 `tools` | [server/src/routes/api/bmUsage.js:1135](../server/src/routes/api/bmUsage.js#L1135) |
| PUT | `/tools/bm-usage/purpose` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmUsage.js:1136](../server/src/routes/api/bmUsage.js#L1136) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:1541](../server/src/routes/api/bmUsage.js#L1541) |
| GET | `/tools/bm-usage/slo` | 권한 `tools` | [server/src/routes/api/bmPlaybookSlo.js:201](../server/src/routes/api/bmPlaybookSlo.js#L201) |
| PUT | `/tools/bm-usage/slo` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmPlaybookSlo.js:202](../server/src/routes/api/bmPlaybookSlo.js#L202) |
| GET | `/tools/bm-usage/ssh-keys` | 역할 `admin` · 권한 `tools` | [server/src/routes/api/bmOnboard.js:78](../server/src/routes/api/bmOnboard.js#L78) |
| POST | `/tools/bm-usage/ssh-keys` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `keyVaultFirst` · `reauth` | [server/src/routes/api/bmOnboard.js:85](../server/src/routes/api/bmOnboard.js#L85) |
| DELETE | `/tools/bm-usage/ssh-keys/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:117](../server/src/routes/api/bmOnboard.js#L117) |
| PUT | `/tools/bm-usage/ssh-keys/:id` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:93](../server/src/routes/api/bmOnboard.js#L93) |
| POST | `/tools/bm-usage/ssh-keys/:id/passphrase` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:100](../server/src/routes/api/bmOnboard.js#L100) |
| POST | `/tools/bm-usage/ssh-keys/rotate` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` · `reauth` | [server/src/routes/api/bmOnboard.js:107](../server/src/routes/api/bmOnboard.js#L107) |
| PUT | `/tools/bm-usage/tuning/overrides` | 역할 `admin` · 권한 `tools` · `requireSettingsOwner` | [server/src/routes/api/bmUsage.js:1137](../server/src/routes/api/bmUsage.js#L1137) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:72](../server/src/routes/api/toolsCapacity.js#L72) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1790](../server/src/routes/api/toolsCapacity.js#L1790) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1701](../server/src/routes/api/toolsCapacity.js#L1701) |
| GET | `/tools/cluster-check` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:36](../server/src/routes/api/clusterCheck.js#L36) |
| GET | `/tools/cluster-check.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/clusterCheck.js:62](../server/src/routes/api/clusterCheck.js#L62) |
| GET | `/tools/cluster-check/of` | 권한 `tools` | [server/src/routes/api/clusterCheck.js:49](../server/src/routes/api/clusterCheck.js#L49) |
| GET | `/tools/comm-map` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/commMap.js:108](../server/src/routes/api/commMap.js#L108) |
| GET | `/tools/contention` | 권한 `tools` | [server/src/routes/api/contention.js:33](../server/src/routes/api/contention.js#L33) |
| GET | `/tools/contention.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/contention.js:57](../server/src/routes/api/contention.js#L57) |
| GET | `/tools/core-license` | 권한 `tools` | [server/src/routes/api/coreLicense.js:28](../server/src/routes/api/coreLicense.js#L28) |
| GET | `/tools/core-license.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/coreLicense.js:33](../server/src/routes/api/coreLicense.js#L33) |
| GET | `/tools/corp-usage` | 권한 `tools` | [server/src/routes/api/corpUsage.js:97](../server/src/routes/api/corpUsage.js#L97) |
| GET | `/tools/cost-showback` | 권한 `tools` | [server/src/routes/api/costShowback.js:39](../server/src/routes/api/costShowback.js#L39) |
| GET | `/tools/cost-showback.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/costShowback.js:61](../server/src/routes/api/costShowback.js#L61) |
| GET | `/tools/cost-showback/settings` | 권한 `tools` | [server/src/routes/api/costShowback.js:45](../server/src/routes/api/costShowback.js#L45) |
| PUT | `/tools/cost-showback/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/costShowback.js:50](../server/src/routes/api/costShowback.js#L50) |
| GET | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:28](../server/src/routes/api/credentials.js#L28) |
| POST | `/tools/credentials` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:38](../server/src/routes/api/credentials.js#L38) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:58](../server/src/routes/api/credentials.js#L58) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `fullScopeOnly` · `reauth` | [server/src/routes/api/credentials.js:48](../server/src/routes/api/credentials.js#L48) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:68](../server/src/routes/api/credentials.js#L68) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/credentials.js:33](../server/src/routes/api/credentials.js#L33) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:325](../server/src/routes/api/horizonSessions.js#L325) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:57](../server/src/routes/api/curUser.js#L57) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:123](../server/src/routes/api/curUser.js#L123) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:234](../server/src/routes/api/curUser.js#L234) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:138](../server/src/routes/api/curUser.js#L138) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:92](../server/src/routes/api/curUser.js#L92) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:149](../server/src/routes/api/curUser.js#L149) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:191](../server/src/routes/api/curUser.js#L191) |
| GET | `/tools/cvp` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:270](../server/src/routes/api/cvp.js#L270) |
| POST | `/tools/cvp/collect` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:772](../server/src/routes/api/cvp.js#L772) |
| GET | `/tools/cvp/device` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:366](../server/src/routes/api/cvp.js#L366) |
| GET | `/tools/cvp/device-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:427](../server/src/routes/api/cvp.js#L427) |
| GET | `/tools/cvp/devices` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:299](../server/src/routes/api/cvp.js#L299) |
| GET | `/tools/cvp/devices.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:732](../server/src/routes/api/cvp.js#L732) |
| GET | `/tools/cvp/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:444](../server/src/routes/api/cvp.js#L444) |
| GET | `/tools/cvp/faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:658](../server/src/routes/api/cvp.js#L658) |
| POST | `/tools/cvp/faults/close` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:698](../server/src/routes/api/cvp.js#L698) |
| POST | `/tools/cvp/faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:686](../server/src/routes/api/cvp.js#L686) |
| GET | `/tools/cvp/optics` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:495](../server/src/routes/api/cvp.js#L495) |
| GET | `/tools/cvp/overview` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:322](../server/src/routes/api/cvp.js#L322) |
| POST | `/tools/cvp/parse-preview` | 역할 `admin` · 권한 `tools` · `fullScopeReadPost` | [server/src/routes/api/cvp.js:719](../server/src/routes/api/cvp.js#L719) |
| GET | `/tools/cvp/port-series` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:757](../server/src/routes/api/cvp.js#L757) |
| GET | `/tools/cvp/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:630](../server/src/routes/api/cvp.js#L630) |
| GET | `/tools/cvp/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:564](../server/src/routes/api/cvp.js#L564) |
| GET | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:795](../server/src/routes/api/cvp.js#L795) |
| POST | `/tools/cvp/servers` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:824](../server/src/routes/api/cvp.js#L824) |
| DELETE | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:827](../server/src/routes/api/cvp.js#L827) |
| PUT | `/tools/cvp/servers/:id` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:825](../server/src/routes/api/cvp.js#L825) |
| POST | `/tools/cvp/servers/:id/test` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:840](../server/src/routes/api/cvp.js#L840) |
| GET | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:868](../server/src/routes/api/cvp.js#L868) |
| PUT | `/tools/cvp/settings` | 역할 `admin` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/cvp.js:872](../server/src/routes/api/cvp.js#L872) |
| GET | `/tools/data-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/dataFlow.js:64](../server/src/routes/api/dataFlow.js#L64) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:191](../server/src/routes/api/checksLogs.js#L191) |
| GET | `/tools/device-flow` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/deviceFlow.js:30](../server/src/routes/api/deviceFlow.js#L30) |
| GET | `/tools/disk-bad` | 권한 `tools` | [server/src/routes/api/diskBad.js:172](../server/src/routes/api/diskBad.js#L172) |
| GET | `/tools/disk-bad/jobs` | 권한 `tools` | [server/src/routes/api/diskBad.js:199](../server/src/routes/api/diskBad.js#L199) |
| POST | `/tools/disk-bad/jobs/:id/retry` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/diskBad.js:290](../server/src/routes/api/diskBad.js#L290) |
| POST | `/tools/disk-bad/jobs/:id/stop` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/diskBad.js:278](../server/src/routes/api/diskBad.js#L278) |
| POST | `/tools/disk-bad/scan` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/diskBad.js:220](../server/src/routes/api/diskBad.js#L220) |
| GET | `/tools/disk-bad/server/:id` | 권한 `tools` | [server/src/routes/api/diskBad.js:203](../server/src/routes/api/diskBad.js#L203) |
| PUT | `/tools/disk-bad/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/diskBad.js:301](../server/src/routes/api/diskBad.js#L301) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:26](../server/src/routes/api/vcTools.js#L26) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:110](../server/src/routes/api/edgeLog.js#L110) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:122](../server/src/routes/api/edgeLog.js#L122) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:171](../server/src/routes/api/edgeLog.js#L171) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:139](../server/src/routes/api/edgeLog.js#L139) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:458](../server/src/routes/api/hardwareGpu.js#L458) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1372](../server/src/routes/api/toolsCapacity.js#L1372) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1509](../server/src/routes/api/toolsCapacity.js#L1509) |
| GET | `/tools/esxi-temp/sensors` | 권한 `tools` | [server/src/routes/api/serverSensors.js:138](../server/src/routes/api/serverSensors.js#L138) |
| GET | `/tools/esxi-temp/sensors/:id` | 권한 `tools` | [server/src/routes/api/serverSensors.js:181](../server/src/routes/api/serverSensors.js#L181) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1592](../server/src/routes/api/toolsCapacity.js#L1592) |
| GET | `/tools/focus-mon` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:153](../server/src/routes/api/focusMon.js#L153) |
| GET | `/tools/focus-mon/alerts` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:703](../server/src/routes/api/focusMon.js#L703) |
| POST | `/tools/focus-mon/alerts/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:755](../server/src/routes/api/focusMon.js#L755) |
| POST | `/tools/focus-mon/alerts/rules` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `ruleWrite` | [server/src/routes/api/focusMon.js:751](../server/src/routes/api/focusMon.js#L751) |
| DELETE | `/tools/focus-mon/alerts/rules/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `ruleWrite` | [server/src/routes/api/focusMon.js:753](../server/src/routes/api/focusMon.js#L753) |
| PUT | `/tools/focus-mon/alerts/rules/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` · `ruleWrite` | [server/src/routes/api/focusMon.js:752](../server/src/routes/api/focusMon.js#L752) |
| GET | `/tools/focus-mon/apps` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:776](../server/src/routes/api/focusMon.js#L776) |
| GET | `/tools/focus-mon/audit` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:118](../server/src/routes/api/focusMonAudit.js#L118) |
| GET | `/tools/focus-mon/audit/:id/runs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:275](../server/src/routes/api/focusMonAudit.js#L275) |
| POST | `/tools/focus-mon/audit/install` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:166](../server/src/routes/api/focusMonAudit.js#L166) |
| PUT | `/tools/focus-mon/audit/install-dir` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:154](../server/src/routes/api/focusMonAudit.js#L154) |
| GET | `/tools/focus-mon/audit/install.sh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:325](../server/src/routes/api/focusMonAudit.js#L325) |
| GET | `/tools/focus-mon/audit/jobs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:265](../server/src/routes/api/focusMonAudit.js#L265) |
| POST | `/tools/focus-mon/audit/run` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMonAudit.js:337](../server/src/routes/api/focusMonAudit.js#L337) |
| GET | `/tools/focus-mon/audit/run/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:286](../server/src/routes/api/focusMonAudit.js#L286) |
| GET | `/tools/focus-mon/audit/run/:runId/report.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:310](../server/src/routes/api/focusMonAudit.js#L310) |
| GET | `/tools/focus-mon/changes` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:557](../server/src/routes/api/focusMon.js#L557) |
| GET | `/tools/focus-mon/coverage` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:810](../server/src/routes/api/focusMon.js#L810) |
| GET | `/tools/focus-mon/data` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:524](../server/src/routes/api/focusMon.js#L524) |
| POST | `/tools/focus-mon/edges/:agent/wake` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:366](../server/src/routes/api/focusMon.js#L366) |
| POST | `/tools/focus-mon/events` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:572](../server/src/routes/api/focusMon.js#L572) |
| DELETE | `/tools/focus-mon/events/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:587](../server/src/routes/api/focusMon.js#L587) |
| GET | `/tools/focus-mon/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:821](../server/src/routes/api/focusMon.js#L821) |
| POST | `/tools/focus-mon/groups` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:232](../server/src/routes/api/focusMon.js#L232) |
| DELETE | `/tools/focus-mon/groups/:name` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:248](../server/src/routes/api/focusMon.js#L248) |
| PUT | `/tools/focus-mon/groups/:name` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:239](../server/src/routes/api/focusMon.js#L239) |
| POST | `/tools/focus-mon/key` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:434](../server/src/routes/api/focusMon.js#L434) |
| GET | `/tools/focus-mon/load` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:607](../server/src/routes/api/focusMon.js#L607) |
| GET | `/tools/focus-mon/prep` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMonAudit.js:207](../server/src/routes/api/focusMonAudit.js#L207) |
| POST | `/tools/focus-mon/prep` | 역할 `admin` · `requireSettingsOwner` · `fullRwOnly` · `demoBlockWrite` · `reauth` | [server/src/routes/api/focusMonAudit.js:238](../server/src/routes/api/focusMonAudit.js#L238) |
| GET | `/tools/focus-mon/proc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:791](../server/src/routes/api/focusMon.js#L791) |
| GET | `/tools/focus-mon/procs` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:677](../server/src/routes/api/focusMon.js#L677) |
| POST | `/tools/focus-mon/sessions` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:452](../server/src/routes/api/focusMon.js#L452) |
| DELETE | `/tools/focus-mon/sessions/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:509](../server/src/routes/api/focusMon.js#L509) |
| POST | `/tools/focus-mon/sessions/:id/extend` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:502](../server/src/routes/api/focusMon.js#L502) |
| POST | `/tools/focus-mon/sessions/:id/targets` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:474](../server/src/routes/api/focusMon.js#L474) |
| DELETE | `/tools/focus-mon/sessions/:id/targets/:tid` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:489](../server/src/routes/api/focusMon.js#L489) |
| PUT | `/tools/focus-mon/settings` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:442](../server/src/routes/api/focusMon.js#L442) |
| POST | `/tools/focus-mon/targets` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:196](../server/src/routes/api/focusMon.js#L196) |
| DELETE | `/tools/focus-mon/targets/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:217](../server/src/routes/api/focusMon.js#L217) |
| PUT | `/tools/focus-mon/targets/:id` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:204](../server/src/routes/api/focusMon.js#L204) |
| POST | `/tools/focus-mon/targets/:id/retry` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:408](../server/src/routes/api/focusMon.js#L408) |
| POST | `/tools/focus-mon/targets/:id/test` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:380](../server/src/routes/api/focusMon.js#L380) |
| GET | `/tools/focus-mon/targets/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/focusMon.js:303](../server/src/routes/api/focusMon.js#L303) |
| POST | `/tools/focus-mon/targets/group` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:259](../server/src/routes/api/focusMon.js#L259) |
| POST | `/tools/focus-mon/targets/import` | 역할 `admin` · 권한 `data.csv` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:289](../server/src/routes/api/focusMon.js#L289) |
| POST | `/tools/focus-mon/targets/import/preview` | 역할 `admin` · 권한 `data.csv` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:278](../server/src/routes/api/focusMon.js#L278) |
| POST | `/tools/focus-mon/targets/move` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:347](../server/src/routes/api/focusMon.js#L347) |
| POST | `/tools/focus-mon/targets/test-bulk` | 역할 `admin` · `fullRwOnly` · `demoBlockWrite` | [server/src/routes/api/focusMon.js:324](../server/src/routes/api/focusMon.js#L324) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:477](../server/src/routes/api/hardwareGpu.js#L477) |
| GET | `/tools/gpu-alloc` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:531](../server/src/routes/api/hardwareGpu.js#L531) |
| GET | `/tools/gpu-alloc.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:552](../server/src/routes/api/hardwareGpu.js#L552) |
| GET | `/tools/gpu-alloc.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:556](../server/src/routes/api/hardwareGpu.js#L556) |
| GET | `/tools/gpu-alloc/diag` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:580](../server/src/routes/api/hardwareGpu.js#L580) |
| GET | `/tools/gpu-alloc/export-meta` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:536](../server/src/routes/api/hardwareGpu.js#L536) |
| GET | `/tools/gpu-alloc/history` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:588](../server/src/routes/api/hardwareGpu.js#L588) |
| GET | `/tools/gpu.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:493](../server/src/routes/api/hardwareGpu.js#L493) |
| GET | `/tools/gpu.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:485](../server/src/routes/api/hardwareGpu.js#L485) |
| GET | `/tools/gpu/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:631](../server/src/routes/api/hardwareGpu.js#L631) |
| GET | `/tools/gpu/export.json` | 권한 `data.csv`, `tools` | [server/src/routes/api/hardwareGpu.js:632](../server/src/routes/api/hardwareGpu.js#L632) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:173](../server/src/routes/api/toolsAnalytics.js#L173) |
| GET | `/tools/gpu/host` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:672](../server/src/routes/api/hardwareGpu.js#L672) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:607](../server/src/routes/api/hardwareGpu.js#L607) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:688](../server/src/routes/api/hardwareGpu.js#L688) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:429](../server/src/routes/api/toolsCapacity.js#L429) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:42](../server/src/routes/api/toolsGuestDisk.js#L42) |
| GET | `/tools/guest-disk/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:97](../server/src/routes/api/toolsGuestDisk.js#L97) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:86](../server/src/routes/api/toolsGuestDisk.js#L86) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:80](../server/src/routes/api/toolsGuestDisk.js#L80) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:54](../server/src/routes/api/toolsGuestDisk.js#L54) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:49](../server/src/routes/api/toolsInfo.js#L49) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:67](../server/src/routes/api/toolsInfo.js#L67) |
| GET | `/tools/guest-partition` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:50](../server/src/routes/api/toolsGuestPart.js#L50) |
| GET | `/tools/guest-partition/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsGuestPart.js:72](../server/src/routes/api/toolsGuestPart.js#L72) |
| GET | `/tools/guest-partition/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:104](../server/src/routes/api/toolsGuestPart.js#L104) |
| POST | `/tools/guest-partition/mail/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:110](../server/src/routes/api/toolsGuestPart.js#L110) |
| POST | `/tools/guest-partition/mail/send` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:116](../server/src/routes/api/toolsGuestPart.js#L116) |
| POST | `/tools/guest-partition/mail/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:124](../server/src/routes/api/toolsGuestPart.js#L124) |
| GET | `/tools/guest-partition/settings` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:87](../server/src/routes/api/toolsGuestPart.js#L87) |
| PUT | `/tools/guest-partition/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/toolsGuestPart.js:95](../server/src/routes/api/toolsGuestPart.js#L95) |
| GET | `/tools/guest-partition/vcenter/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestPart.js:63](../server/src/routes/api/toolsGuestPart.js#L63) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:426](../server/src/routes/api/hardwareGpu.js#L426) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:91](../server/src/routes/api/toolsInfo.js#L91) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:201](../server/src/routes/api/horizonSessions.js#L201) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:255](../server/src/routes/api/horizonSessions.js#L255) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:268](../server/src/routes/api/horizonSessions.js#L268) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:239](../server/src/routes/api/horizonSessions.js#L239) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:278](../server/src/routes/api/horizonSessions.js#L278) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:298](../server/src/routes/api/horizonSessions.js#L298) |
| GET | `/tools/horizon-sessions/usage` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:164](../server/src/routes/api/horizonSessions.js#L164) |
| GET | `/tools/horizon-sessions/usage.csv` | 권한 `data.csv` | [server/src/routes/api/horizonSessions.js:179](../server/src/routes/api/horizonSessions.js#L179) |
| POST | `/tools/host-export.xlsx` | 권한 `data.csv` | [server/src/routes/api/hostExport.js:152](../server/src/routes/api/hostExport.js#L152) |
| GET | `/tools/host-export/status` | 권한 `data.csv` | [server/src/routes/api/hostExport.js:127](../server/src/routes/api/hostExport.js#L127) |
| GET | `/tools/host-hygiene` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:48](../server/src/routes/api/hostHygiene.js#L48) |
| GET | `/tools/host-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/hostHygiene.js:89](../server/src/routes/api/hostHygiene.js#L89) |
| GET | `/tools/host-hygiene/reboots` | 권한 `tools` | [server/src/routes/api/hostHygiene.js:62](../server/src/routes/api/hostHygiene.js#L62) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:39](../server/src/routes/api/toolsAnalytics.js#L39) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:662](../server/src/routes/api/hardwareGpu.js#L662) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:637](../server/src/routes/api/hardwareGpu.js#L637) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:161](../server/src/routes/api/ipamExport.js#L161) |
| GET | `/tools/ipam.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:567](../server/src/routes/api/ipamExport.js#L567) |
| GET | `/tools/ipam.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:533](../server/src/routes/api/ipamExport.js#L533) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:305](../server/src/routes/api/ipamExport.js#L305) |
| PUT | `/tools/ipam/annotation` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:317](../server/src/routes/api/ipamExport.js#L317) |
| POST | `/tools/ipam/bulk` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:389](../server/src/routes/api/ipamExport.js#L389) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:216](../server/src/routes/api/ipamExport.js#L216) |
| GET | `/tools/ipam/hostnames` | 권한 `tools` | [server/src/routes/api/ipamServer.js:79](../server/src/routes/api/ipamServer.js#L79) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:177](../server/src/routes/api/ipamExport.js#L177) |
| DELETE | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:374](../server/src/routes/api/ipamExport.js#L374) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:345](../server/src/routes/api/ipamExport.js#L345) |
| PUT | `/tools/ipam/ip/:ip` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:359](../server/src/routes/api/ipamExport.js#L359) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:333](../server/src/routes/api/ipamExport.js#L333) |
| GET | `/tools/ipam/manage.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:619](../server/src/routes/api/ipamExport.js#L619) |
| POST | `/tools/ipam/manage/import` | 역할 `admin/operator` · 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:645](../server/src/routes/api/ipamExport.js#L645) |
| GET | `/tools/ipam/manage/sample.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:634](../server/src/routes/api/ipamExport.js#L634) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:262](../server/src/routes/api/ipamExport.js#L262) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:421](../server/src/routes/api/ipamExport.js#L421) |
| POST | `/tools/ipam/policies` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:452](../server/src/routes/api/ipamExport.js#L452) |
| DELETE | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:506](../server/src/routes/api/ipamExport.js#L506) |
| PUT | `/tools/ipam/policies/:id` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:473](../server/src/routes/api/ipamExport.js#L473) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:430](../server/src/routes/api/ipamExport.js#L430) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:447](../server/src/routes/api/ipamExport.js#L447) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:273](../server/src/routes/api/ipamExport.js#L273) |
| GET | `/tools/ipam/server` | 권한 `tools` | [server/src/routes/api/ipamServer.js:68](../server/src/routes/api/ipamServer.js#L68) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:205](../server/src/routes/api/ipamExport.js#L205) |
| PUT | `/tools/ipam/subnet-note` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/ipamExport.js:193](../server/src/routes/api/ipamExport.js#L193) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:187](../server/src/routes/api/ipamExport.js#L187) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:226](../server/src/routes/api/ipamExport.js#L226) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/ipamExport.js:249](../server/src/routes/api/ipamExport.js#L249) |
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
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:188](../server/src/routes/api/toolsInfo.js#L188) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:115](../server/src/routes/api/toolsInfo.js#L115) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:55](../server/src/routes/api/linkCheck.js#L55) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:191](../server/src/routes/api/linkCheck.js#L191) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:176](../server/src/routes/api/linkCheck.js#L176) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:163](../server/src/routes/api/linkCheck.js#L163) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:201](../server/src/routes/api/linkCheck.js#L201) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:152](../server/src/routes/api/linkCheck.js#L152) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:217](../server/src/routes/api/linkCheck.js#L217) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:285](../server/src/routes/api/linkCheck.js#L285) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:230](../server/src/routes/api/linkCheck.js#L230) |
| GET | `/tools/migration-readiness` | 권한 `tools` | [server/src/routes/api/migrationReadiness.js:34](../server/src/routes/api/migrationReadiness.js#L34) |
| GET | `/tools/migration-readiness.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/migrationReadiness.js:38](../server/src/routes/api/migrationReadiness.js#L38) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:246](../server/src/routes/api/checksLogs.js#L246) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1863](../server/src/routes/api/toolsCapacity.js#L1863) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1827](../server/src/routes/api/toolsCapacity.js#L1827) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:321](../server/src/routes/api/partFaults.js#L321) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:453](../server/src/routes/api/partFaults.js#L453) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:353](../server/src/routes/api/partFaults.js#L353) |
| GET | `/tools/part-faults/incidents` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:389](../server/src/routes/api/partFaults.js#L389) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:468](../server/src/routes/api/partFaults.js#L468) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:420](../server/src/routes/api/partFaults.js#L420) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:440](../server/src/routes/api/partFaults.js#L440) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:430](../server/src/routes/api/partFaults.js#L430) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:77](../server/src/routes/api/pdu.js#L77) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:163](../server/src/routes/api/pdu.js#L163) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:350](../server/src/routes/api/pdu.js#L350) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:201](../server/src/routes/api/pdu.js#L201) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:238](../server/src/routes/api/pdu.js#L238) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/pdu.js:227](../server/src/routes/api/pdu.js#L227) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:155](../server/src/routes/api/pdu.js#L155) |
| POST | `/tools/pdu/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:314](../server/src/routes/api/pdu.js#L314) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:320](../server/src/routes/api/pdu.js#L320) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:330](../server/src/routes/api/pdu.js#L330) |
| POST | `/tools/pdu/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:304](../server/src/routes/api/pdu.js#L304) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:187](../server/src/routes/api/pdu.js#L187) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:175](../server/src/routes/api/pdu.js#L175) |
| POST | `/tools/pdu/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:273](../server/src/routes/api/pdu.js#L273) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/pdu.js:142](../server/src/routes/api/pdu.js#L142) |
| GET | `/tools/portal-check/arch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:370](../server/src/routes/api/portalCheck.js#L370) |
| POST | `/tools/portal-check/arch/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:371](../server/src/routes/api/portalCheck.js#L371) |
| GET | `/tools/portal-check/common` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:393](../server/src/routes/api/portalCheck.js#L393) |
| GET | `/tools/portal-check/field` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:449](../server/src/routes/api/portalCheck.js#L449) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:411](../server/src/routes/api/portalCheck.js#L411) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:225](../server/src/routes/api/portalCheck.js#L225) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:294](../server/src/routes/api/portalCheck.js#L294) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:258](../server/src/routes/api/portalCheck.js#L258) |
| GET | `/tools/power-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/overviewCards.js:238](../server/src/routes/api/overviewCards.js#L238) |
| GET | `/tools/ps-inspect` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:57](../server/src/routes/api/psInspect.js#L57) |
| GET | `/tools/ps-inspect/catalog` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:50](../server/src/routes/api/psInspect.js#L50) |
| GET | `/tools/ps-inspect/devices/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:66](../server/src/routes/api/psInspect.js#L66) |
| GET | `/tools/ps-inspect/report` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:87](../server/src/routes/api/psInspect.js#L87) |
| GET | `/tools/ps-inspect/report.csv` | 권한 `tools`, `data.csv` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:99](../server/src/routes/api/psInspect.js#L99) |
| POST | `/tools/ps-inspect/report/send-now` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:126](../server/src/routes/api/psInspect.js#L126) |
| POST | `/tools/ps-inspect/run` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:108](../server/src/routes/api/psInspect.js#L108) |
| PUT | `/tools/ps-inspect/settings` | 역할 `admin` · `fullRwOnly` | [server/src/routes/api/psInspect.js:117](../server/src/routes/api/psInspect.js#L117) |
| GET | `/tools/ps-inspect/top-nodes` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/psInspect.js:77](../server/src/routes/api/psInspect.js#L77) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:20](../server/src/routes/api/relaycheck.js#L20) |
| POST | `/tools/relaycheck/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:47](../server/src/routes/api/relaycheck.js#L47) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaycheck.js:40](../server/src/routes/api/relaycheck.js#L40) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:49](../server/src/routes/api/relaytopo.js#L49) |
| PUT | `/tools/relaytopo` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:78](../server/src/routes/api/relaytopo.js#L78) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:137](../server/src/routes/api/relaytopo.js#L137) |
| GET | `/tools/relaytopo/export` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:108](../server/src/routes/api/relaytopo.js#L108) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:128](../server/src/routes/api/relaytopo.js#L128) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:132](../server/src/routes/api/relaytopo.js#L132) |
| POST | `/tools/relaytopo/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:88](../server/src/routes/api/relaytopo.js#L88) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:121](../server/src/routes/api/relaytopo.js#L121) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/relaytopo.js:146](../server/src/routes/api/relaytopo.js#L146) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:176](../server/src/routes/api/reports.js#L176) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:153](../server/src/routes/api/reports.js#L153) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:126](../server/src/routes/api/reports.js#L126) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:199](../server/src/routes/api/reports.js#L199) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:192](../server/src/routes/api/reports.js#L192) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:86](../server/src/routes/api/reports.js#L86) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:131](../server/src/routes/api/reports.js#L131) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:96](../server/src/routes/api/reports.js#L96) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:235](../server/src/routes/api/reports.js#L235) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:120](../server/src/routes/api/reports.js#L120) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1188](../server/src/routes/api/toolsCapacity.js#L1188) |
| GET | `/tools/rma` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:51](../server/src/routes/api/rma.js#L51) |
| PUT | `/tools/rma/agents/:agent/access` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:112](../server/src/routes/api/rma.js#L112) |
| PUT | `/tools/rma/agents/:agent/mode` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:192](../server/src/routes/api/rma.js#L192) |
| PUT | `/tools/rma/agents/:agent/password` | 역할 `admin` · `fullScopeOnly` · `ownerOtpThen` | [server/src/routes/api/rma.js:181](../server/src/routes/api/rma.js#L181) |
| PUT | `/tools/rma/agents/:agent/remote` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:121](../server/src/routes/api/rma.js#L121) |
| GET | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:68](../server/src/routes/api/rma.js#L68) |
| PUT | `/tools/rma/agents/:agent/schedule` | 역할 `admin` · `fullScopeOnly` · `shellScheduleGate` | [server/src/routes/api/rma.js:71](../server/src/routes/api/rma.js#L71) |
| DELETE | `/tools/rma/agents/:agent/schedule/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:84](../server/src/routes/api/rma.js#L84) |
| POST | `/tools/rma/deploy` | 역할 `admin` · `fullScopeOnly` · `ownerOtpThen` | [server/src/routes/api/rma.js:230](../server/src/routes/api/rma.js#L230) |
| POST | `/tools/rma/deploy/list` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:222](../server/src/routes/api/rma.js#L222) |
| POST | `/tools/rma/deploy/remove` | 역할 `admin` · `fullScopeOnly` · `ownerOtpThen` | [server/src/routes/api/rma.js:249](../server/src/routes/api/rma.js#L249) |
| GET | `/tools/rma/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:175](../server/src/routes/api/rma.js#L175) |
| GET | `/tools/rma/jobs/:reqId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:171](../server/src/routes/api/rma.js#L171) |
| POST | `/tools/rma/run` | 역할 `admin` · `fullScopeOnly` · `dangerRunGate` | [server/src/routes/api/rma.js:132](../server/src/routes/api/rma.js#L132) |
| PUT | `/tools/rma/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:201](../server/src/routes/api/rma.js#L201) |
| GET | `/tools/rma/tests/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:107](../server/src/routes/api/rma.js#L107) |
| GET | `/tools/rma/tests/results` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:96](../server/src/routes/api/rma.js#L96) |
| POST | `/tools/rma/tests/validate` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/rma.js:91](../server/src/routes/api/rma.js#L91) |
| GET | `/tools/san-flow` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:142](../server/src/routes/api/sanFlow.js#L142) |
| POST | `/tools/san-flow/activate` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `togglePrecheck` · `reauth` | [server/src/routes/api/sanFlow.js:292](../server/src/routes/api/sanFlow.js#L292) |
| GET | `/tools/san-flow/candidates` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:197](../server/src/routes/api/sanFlow.js#L197) |
| POST | `/tools/san-flow/check` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:216](../server/src/routes/api/sanFlow.js#L216) |
| POST | `/tools/san-flow/create` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `reauth` | [server/src/routes/api/sanFlow.js:236](../server/src/routes/api/sanFlow.js#L236) |
| POST | `/tools/san-flow/deactivate` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `togglePrecheck` · `reauth` | [server/src/routes/api/sanFlow.js:291](../server/src/routes/api/sanFlow.js#L291) |
| POST | `/tools/san-flow/delete` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `reauth` | [server/src/routes/api/sanFlow.js:249](../server/src/routes/api/sanFlow.js#L249) |
| POST | `/tools/san-flow/forget` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` · `reauth` | [server/src/routes/api/sanFlow.js:295](../server/src/routes/api/sanFlow.js#L295) |
| GET | `/tools/san-flow/hosts` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:178](../server/src/routes/api/sanFlow.js#L178) |
| GET | `/tools/san-flow/job/:id` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:315](../server/src/routes/api/sanFlow.js#L315) |
| POST | `/tools/san-flow/preview` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:226](../server/src/routes/api/sanFlow.js#L226) |
| POST | `/tools/san-flow/show` | 역할 `admin` · 권한 `tools` · `fullReadWriteScopeOnlyWith` | [server/src/routes/api/sanFlow.js:304](../server/src/routes/api/sanFlow.js#L304) |
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
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:196](../server/src/routes/api/sanSwitch.js#L196) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1057](../server/src/routes/api/sanSwitch.js#L1057) |
| GET | `/tools/sanswitch/attribution` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/hostSan.js:477](../server/src/routes/api/hostSan.js#L477) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1081](../server/src/routes/api/sanSwitch.js#L1081) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:347](../server/src/routes/api/sanSwitch.js#L347) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:355](../server/src/routes/api/sanSwitch.js#L355) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:407](../server/src/routes/api/sanSwitch.js#L407) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:681](../server/src/routes/api/sanSwitch.js#L681) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:669](../server/src/routes/api/sanSwitch.js#L669) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:561](../server/src/routes/api/sanSwitch.js#L561) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:602](../server/src/routes/api/sanSwitch.js#L602) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:753](../server/src/routes/api/sanSwitch.js#L753) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:765](../server/src/routes/api/sanSwitch.js#L765) |
| GET | `/tools/sanswitch/devices/:id/port-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:842](../server/src/routes/api/sanSwitch.js#L842) |
| GET | `/tools/sanswitch/devices/:id/port-usage.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:851](../server/src/routes/api/sanSwitch.js#L851) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:255](../server/src/routes/api/sanSwitch.js#L255) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:293](../server/src/routes/api/sanSwitch.js#L293) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1164](../server/src/routes/api/sanSwitch.js#L1164) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1172](../server/src/routes/api/sanSwitch.js#L1172) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1260](../server/src/routes/api/sanSwitch.js#L1260) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1200](../server/src/routes/api/sanSwitch.js#L1200) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1248](../server/src/routes/api/sanSwitch.js#L1248) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1180](../server/src/routes/api/sanSwitch.js#L1180) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1186](../server/src/routes/api/sanSwitch.js#L1186) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:619](../server/src/routes/api/sanSwitch.js#L619) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:692](../server/src/routes/api/sanSwitch.js#L692) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:480](../server/src/routes/api/sanSwitch.js#L480) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:462](../server/src/routes/api/sanSwitch.js#L462) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:436](../server/src/routes/api/sanSwitch.js#L436) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:446](../server/src/routes/api/sanSwitch.js#L446) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:888](../server/src/routes/api/sanSwitch.js#L888) |
| GET | `/tools/sanswitch/perf/traffic-total` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:1000](../server/src/routes/api/sanSwitch.js#L1000) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:1105](../server/src/routes/api/sanSwitch.js#L1105) |
| POST | `/tools/sanswitch/test` | 역할 `admin` · `fullScopeOnly` · `fullRwOnly` | [server/src/routes/api/sanSwitch.js:373](../server/src/routes/api/sanSwitch.js#L373) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:396](../server/src/routes/api/sanSwitch.js#L396) |
| GET | `/tools/secret-scan` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/toolsInfo.js:40](../server/src/routes/api/toolsInfo.js#L40) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:73](../server/src/routes/api/serialLookup.js#L73) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `data.csv`, `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:102](../server/src/routes/api/serialLookup.js#L102) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:215](../server/src/routes/api/checksLogs.js#L215) |
| POST | `/tools/service-check/settings-files/confirm` | 역할 `admin` · `settingsFleetOnly` | [server/src/routes/api/checksLogs.js:229](../server/src/routes/api/checksLogs.js#L229) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:147](../server/src/routes/api/vcTools.js#L147) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:62](../server/src/routes/api/vcTools.js#L62) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:85](../server/src/routes/api/storageMon.js#L85) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:787](../server/src/routes/api/storageMon.js#L787) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:862](../server/src/routes/api/storageMon.js#L862) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:874](../server/src/routes/api/storageMon.js#L874) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:882](../server/src/routes/api/storageMon.js#L882) |
| GET | `/tools/storage-paths` | 권한 `tools` | [server/src/routes/api/storagePaths.js:34](../server/src/routes/api/storagePaths.js#L34) |
| GET | `/tools/storage-paths.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/storagePaths.js:42](../server/src/routes/api/storagePaths.js#L42) |
| GET | `/tools/storage-usage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:33](../server/src/routes/api/storageUsage.js#L33) |
| GET | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:75](../server/src/routes/api/storageUsage.js#L75) |
| PUT | `/tools/storage-usage/mail` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:84](../server/src/routes/api/storageUsage.js#L84) |
| POST | `/tools/storage-usage/mail/preview` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:101](../server/src/routes/api/storageUsage.js#L101) |
| POST | `/tools/storage-usage/mail/send-now` | 역할 `admin` · `fullScopeOnly` · `requireSettingsOwner` | [server/src/routes/api/storageUsage.js:93](../server/src/routes/api/storageUsage.js#L93) |
| GET | `/tools/storage-usage/xlsx` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageUsage.js:50](../server/src/routes/api/storageUsage.js#L50) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:234](../server/src/routes/api/storageMon.js#L234) |
| POST | `/tools/storage/collect-all` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:247](../server/src/routes/api/storageMon.js#L247) |
| POST | `/tools/storage/devices` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:210](../server/src/routes/api/storageMon.js#L210) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:220](../server/src/routes/api/storageMon.js#L220) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:575](../server/src/routes/api/storageMon.js#L575) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:580](../server/src/routes/api/storageMon.js#L580) |
| GET | `/tools/storage/devices/:id/client-dist` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:733](../server/src/routes/api/storageMon.js#L733) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:274](../server/src/routes/api/storageMon.js#L274) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:615](../server/src/routes/api/storageMon.js#L615) |
| GET | `/tools/storage/devices/:id/node-clients` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:696](../server/src/routes/api/storageMon.js#L696) |
| GET | `/tools/storage/devices/:id/node-load` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:648](../server/src/routes/api/storageMon.js#L648) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:373](../server/src/routes/api/storageMon.js#L373) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:397](../server/src/routes/api/storageMon.js#L397) |
| POST | `/tools/storage/devices/import` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:420](../server/src/routes/api/storageMon.js#L420) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:508](../server/src/routes/api/storageMon.js#L508) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:568](../server/src/routes/api/storageMon.js#L568) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:388](../server/src/routes/api/storageMon.js#L388) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:405](../server/src/routes/api/storageMon.js#L405) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:896](../server/src/routes/api/storageMon.js#L896) |
| GET | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:304](../server/src/routes/api/storageMon.js#L304) |
| PUT | `/tools/storage/intervals` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:322](../server/src/routes/api/storageMon.js#L322) |
| POST | `/tools/storage/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:154](../server/src/routes/api/storageMon.js#L154) |
| GET | `/tools/svc-inventory` | 권한 `tools` | [server/src/routes/api/svcInventory.js:683](../server/src/routes/api/svcInventory.js#L683) |
| GET | `/tools/svc-inventory.csv` | 권한 `tools`, `data.csv` | [server/src/routes/api/svcInventory.js:855](../server/src/routes/api/svcInventory.js#L855) |
| GET | `/tools/svc-inventory/candidates` | 권한 `tools` | [server/src/routes/api/svcInventory.js:835](../server/src/routes/api/svcInventory.js#L835) |
| GET | `/tools/svc-inventory/members` | 권한 `tools` | [server/src/routes/api/svcInventory.js:734](../server/src/routes/api/svcInventory.js#L734) |
| POST | `/tools/svc-inventory/op` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/svcInventory.js:890](../server/src/routes/api/svcInventory.js#L890) |
| GET | `/tools/svc-inventory/queues` | 권한 `tools` | [server/src/routes/api/svcInventory.js:786](../server/src/routes/api/svcInventory.js#L786) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1239](../server/src/routes/api/toolsCapacity.js#L1239) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:102](../server/src/routes/api/toolsAnalytics.js#L102) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:383](../server/src/routes/api/checksLogs.js#L383) |
| GET | `/tools/vclogs/export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/checksLogs.js:413](../server/src/routes/api/checksLogs.js#L413) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:369](../server/src/routes/api/checksLogs.js#L369) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:350](../server/src/routes/api/checksLogs.js#L350) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:321](../server/src/routes/api/checksLogs.js#L321) |
| GET | `/tools/vm-availability` | 권한 `tools` | [server/src/routes/api/vmAvailability.js:97](../server/src/routes/api/vmAvailability.js#L97) |
| GET | `/tools/vm-availability.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmAvailability.js:101](../server/src/routes/api/vmAvailability.js#L101) |
| GET | `/tools/vm-changes` | 권한 `tools` | [server/src/routes/api/vmChanges.js:66](../server/src/routes/api/vmChanges.js#L66) |
| GET | `/tools/vm-changes.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmChanges.js:107](../server/src/routes/api/vmChanges.js#L107) |
| GET | `/tools/vm-changes/of` | 권한 `tools` | [server/src/routes/api/vmChanges.js:84](../server/src/routes/api/vmChanges.js#L84) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:128](../server/src/routes/api/vmClone.js#L128) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:411](../server/src/routes/api/vmClone.js#L411) |
| PUT | `/tools/vm-clone/corps/mounts` | 역할 `admin` | [server/src/routes/api/vmClone.js:361](../server/src/routes/api/vmClone.js#L361) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:191](../server/src/routes/api/vmClone.js#L191) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:263](../server/src/routes/api/vmClone.js#L263) |
| POST | `/tools/vm-clone/jobs/:id/restore` | 역할 `admin` | [server/src/routes/api/vmClone.js:312](../server/src/routes/api/vmClone.js#L312) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:277](../server/src/routes/api/vmClone.js#L277) |
| POST | `/tools/vm-clone/jobs/:id/verify` | 역할 `admin` | [server/src/routes/api/vmClone.js:298](../server/src/routes/api/vmClone.js#L298) |
| POST | `/tools/vm-clone/nfs-datastores` | 역할 `admin` | [server/src/routes/api/vmClone.js:328](../server/src/routes/api/vmClone.js#L328) |
| DELETE | `/tools/vm-clone/nfs-datastores/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:397](../server/src/routes/api/vmClone.js#L397) |
| POST | `/tools/vm-clone/nfs-datastores/:id/attach` | 역할 `admin` | [server/src/routes/api/vmClone.js:345](../server/src/routes/api/vmClone.js#L345) |
| POST | `/tools/vm-clone/nfs-datastores/:id/detach` | 역할 `admin` | [server/src/routes/api/vmClone.js:381](../server/src/routes/api/vmClone.js#L381) |
| GET | `/tools/vm-dns` | 권한 `tools` | [server/src/routes/api/vmDns.js:128](../server/src/routes/api/vmDns.js#L128) |
| GET | `/tools/vm-dns.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmDns.js:223](../server/src/routes/api/vmDns.js#L223) |
| GET | `/tools/vm-dns/changes` | 권한 `tools` | [server/src/routes/api/vmDns.js:168](../server/src/routes/api/vmDns.js#L168) |
| GET | `/tools/vm-dns/policy` | 권한 `tools` | [server/src/routes/api/vmDns.js:181](../server/src/routes/api/vmDns.js#L181) |
| PUT | `/tools/vm-dns/policy` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:194](../server/src/routes/api/vmDns.js#L194) |
| POST | `/tools/vm-dns/probe` | 역할 `admin` · 권한 `tools` · `fleetOnly` | [server/src/routes/api/vmDns.js:211](../server/src/routes/api/vmDns.js#L211) |
| GET | `/tools/vm-dns/server` | 권한 `tools` | [server/src/routes/api/vmDns.js:148](../server/src/routes/api/vmDns.js#L148) |
| GET | `/tools/vm-dns/vm` | 권한 `tools` | [server/src/routes/api/vmDns.js:158](../server/src/routes/api/vmDns.js#L158) |
| GET | `/tools/vm-export` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:163](../server/src/routes/api/vmExport.js#L163) |
| GET | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:157](../server/src/routes/api/vmExport.js#L157) |
| POST | `/tools/vm-export.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:142](../server/src/routes/api/vmExport.js#L142) |
| POST | `/tools/vm-export.xlsx` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:149](../server/src/routes/api/vmExport.js#L149) |
| GET | `/tools/vm-export/catalog` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:118](../server/src/routes/api/vmExport.js#L118) |
| DELETE | `/tools/vm-export/prefs` | 역할 `admin/operator` · 권한 `data.csv`, `tools` · `prefsWrite` | [server/src/routes/api/vmExport.js:190](../server/src/routes/api/vmExport.js#L190) |
| GET | `/tools/vm-export/prefs` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:174](../server/src/routes/api/vmExport.js#L174) |
| PUT | `/tools/vm-export/prefs` | 역할 `admin/operator` · 권한 `data.csv`, `tools` · `prefsWrite` | [server/src/routes/api/vmExport.js:186](../server/src/routes/api/vmExport.js#L186) |
| POST | `/tools/vm-export/preview` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmExport.js:126](../server/src/routes/api/vmExport.js#L126) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1276](../server/src/routes/api/toolsCapacity.js#L1276) |
| GET | `/tools/vm-hygiene` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:61](../server/src/routes/api/vmHygiene.js#L61) |
| GET | `/tools/vm-hygiene.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmHygiene.js:99](../server/src/routes/api/vmHygiene.js#L99) |
| POST | `/tools/vm-hygiene/notify-now` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:93](../server/src/routes/api/vmHygiene.js#L93) |
| GET | `/tools/vm-hygiene/settings` | 권한 `tools` | [server/src/routes/api/vmHygiene.js:72](../server/src/routes/api/vmHygiene.js#L72) |
| PUT | `/tools/vm-hygiene/settings` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmHygiene.js:82](../server/src/routes/api/vmHygiene.js#L82) |
| GET | `/tools/vm-lifecycle` | 권한 `tools` | [server/src/routes/api/vmLifecycle.js:78](../server/src/routes/api/vmLifecycle.js#L78) |
| GET | `/tools/vm-lifecycle.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmLifecycle.js:89](../server/src/routes/api/vmLifecycle.js#L89) |
| GET | `/tools/vm-tags` | 권한 `tools` | [server/src/routes/api/vmTags.js:75](../server/src/routes/api/vmTags.js#L75) |
| GET | `/tools/vm-tags.csv` | 권한 `data.csv`, `tools` | [server/src/routes/api/vmTags.js:112](../server/src/routes/api/vmTags.js#L112) |
| GET | `/tools/vm-tags/of` | 권한 `tools` | [server/src/routes/api/vmTags.js:91](../server/src/routes/api/vmTags.js#L91) |
| GET | `/tools/vm-tags/policy` | 권한 `tools` | [server/src/routes/api/vmTags.js:101](../server/src/routes/api/vmTags.js#L101) |
| PUT | `/tools/vm-tags/policy` | 역할 `admin` · `fleetOnly` | [server/src/routes/api/vmTags.js:105](../server/src/routes/api/vmTags.js#L105) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:20](../server/src/routes/api/vmtrack.js#L20) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:51](../server/src/routes/api/vmtrack.js#L51) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:131](../server/src/routes/api/vmtrack.js#L131) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:66](../server/src/routes/api/vmtrack.js#L66) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:81](../server/src/routes/api/vmtrack.js#L81) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:149](../server/src/routes/api/vmtrack.js#L149) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:94](../server/src/routes/api/vmtrack.js#L94) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:109](../server/src/routes/api/vmtrack.js#L109) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:171](../server/src/routes/api/vmtrack.js#L171) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:189](../server/src/routes/api/vmtrack.js#L189) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:302](../server/src/routes/api/vmSeries.js#L302) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:266](../server/src/routes/api/vmSeries.js#L266) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:258](../server/src/routes/api/vmSeries.js#L258) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:241](../server/src/routes/api/vmSeries.js#L241) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:158](../server/src/routes/api/vmSeries.js#L158) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:176](../server/src/routes/api/vmSeries.js#L176) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:253](../server/src/routes/api/vmSeries.js#L253) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:280](../server/src/routes/api/vmSeries.js#L280) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:132](../server/src/routes/api/vcTools.js#L132) |
| GET | `/tools/vmware-config` | 권한 `tools` · `csvPermIfDownload` | [server/src/routes/api/checksLogs.js:259](../server/src/routes/api/checksLogs.js#L259) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:293](../server/src/routes/api/toolsCapacity.js#L293) |
| GET | `/tools/waste/export` | 권한 `data.csv`, `tools` | [server/src/routes/api/toolsCapacity.js:477](../server/src/routes/api/toolsCapacity.js#L477) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:694](../server/src/routes/api/toolsCapacity.js#L694) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:664](../server/src/routes/api/toolsCapacity.js#L664) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:678](../server/src/routes/api/toolsCapacity.js#L678) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:670](../server/src/routes/api/toolsCapacity.js#L670) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:440](../server/src/routes/api/toolsCapacity.js#L440) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:952](../server/src/routes/api/toolsCapacity.js#L952) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:975](../server/src/routes/api/toolsCapacity.js#L975) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:1038](../server/src/routes/api/toolsCapacity.js#L1038) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1077](../server/src/routes/api/toolsCapacity.js#L1077) |
| GET | `/tools/xfer-speed` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:219](../server/src/routes/api/xferSpeed.js#L219) |
| GET | `/tools/xfer-speed/export.csv` | 역할 `admin` · 권한 `data.csv` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:440](../server/src/routes/api/xferSpeed.js#L440) |
| GET | `/tools/xfer-speed/heat` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:245](../server/src/routes/api/xferSpeed.js#L245) |
| GET | `/tools/xfer-speed/history` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:264](../server/src/routes/api/xferSpeed.js#L264) |
| GET | `/tools/xfer-speed/log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:365](../server/src/routes/api/xferSpeed.js#L365) |
| GET | `/tools/xfer-speed/ping` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:319](../server/src/routes/api/xferSpeed.js#L319) |
| POST | `/tools/xfer-speed/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:393](../server/src/routes/api/xferSpeed.js#L393) |
| PUT | `/tools/xfer-speed/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/xferSpeed.js:418](../server/src/routes/api/xferSpeed.js#L418) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:589](../server/src/routes/api/inventory.js#L589) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:352](../server/src/routes/api/toolsInfo.js#L352) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:354](../server/src/routes/api/toolsInfo.js#L354) |
| POST | `/usage/track` | — | [server/src/routes/api/usage.js:15](../server/src/routes/api/usage.js#L15) |
| DELETE | `/user-menu` | — | [server/src/routes/api/userMenu.js:90](../server/src/routes/api/userMenu.js#L90) |
| GET | `/user-menu` | — | [server/src/routes/api/userMenu.js:62](../server/src/routes/api/userMenu.js#L62) |
| PUT | `/user-menu` | — | [server/src/routes/api/userMenu.js:82](../server/src/routes/api/userMenu.js#L82) |
| DELETE | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:130](../server/src/routes/api/userMenu.js#L130) |
| GET | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:107](../server/src/routes/api/userMenu.js#L107) |
| POST | `/user-menu/distribute` | 역할 `admin` · `menuFleetOnly` · `requireSuperAdmin` | [server/src/routes/api/userMenu.js:118](../server/src/routes/api/userMenu.js#L118) |
| POST | `/user-menu/restore-prev` | — | [server/src/routes/api/userMenu.js:98](../server/src/routes/api/userMenu.js#L98) |
| GET | `/vcenter-info/:kind` | — | [server/src/routes/api/vcInfo.js:123](../server/src/routes/api/vcInfo.js#L123) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:15](../server/src/routes/api/vcTools.js#L15) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:790](../server/src/routes/api/toolsCapacity.js#L790) |
| GET | `/veeam/backup-counts` | — | [server/src/routes/api/veeam.js:402](../server/src/routes/api/veeam.js#L402) |
| GET | `/veeam/badges` | — | [server/src/routes/api/veeam.js:294](../server/src/routes/api/veeam.js#L294) |
| GET | `/veeam/snap-events` | — | [server/src/routes/api/veeam.js:313](../server/src/routes/api/veeam.js#L313) |
| GET | `/veeam/vm-detail` | — | [server/src/routes/api/veeam.js:451](../server/src/routes/api/veeam.js#L451) |
| POST | `/veeam/vm-list.csv` | 권한 `data.csv` | [server/src/routes/api/veeam.js:335](../server/src/routes/api/veeam.js#L335) |
| POST | `/veeam/vm-list.xlsx` | 권한 `data.csv` | [server/src/routes/api/veeam.js:341](../server/src/routes/api/veeam.js#L341) |
| GET | `/veeam/vm-list/catalog` | 권한 `data.csv` | [server/src/routes/api/veeam.js:351](../server/src/routes/api/veeam.js#L351) |
| DELETE | `/veeam/vm-list/prefs` | 역할 `admin/operator` · 권한 `data.csv` · `prefsWrite` | [server/src/routes/api/veeam.js:397](../server/src/routes/api/veeam.js#L397) |
| GET | `/veeam/vm-list/prefs` | 권한 `data.csv` | [server/src/routes/api/veeam.js:385](../server/src/routes/api/veeam.js#L385) |
| PUT | `/veeam/vm-list/prefs` | 역할 `admin/operator` · 권한 `data.csv` · `prefsWrite` | [server/src/routes/api/veeam.js:393](../server/src/routes/api/veeam.js#L393) |
| POST | `/veeam/vm-list/preview` | 권한 `data.csv` | [server/src/routes/api/veeam.js:364](../server/src/routes/api/veeam.js#L364) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:411](../server/src/routes/api/inventory.js#L411) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:257](../server/src/routes/api/vmMetrics.js#L257) |
| POST | `/vms/:id/endpoint-locate` | 권한 `inv.vms` | [server/src/routes/api/hostSan.js:398](../server/src/routes/api/hostSan.js#L398) |
| GET | `/vms/:id/endpoint-locations` | 권한 `inv.vms` | [server/src/routes/api/hostSan.js:416](../server/src/routes/api/hostSan.js#L416) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:168](../server/src/routes/api/vmMetrics.js#L168) |
| GET | `/vms/:id/partitions` | 권한 `inv.vms` | [server/src/routes/api/toolsGuestPart.js:43](../server/src/routes/api/toolsGuestPart.js#L43) |
| GET | `/vms/by-vcenter` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:465](../server/src/routes/api/inventory.js#L465) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:485](../server/src/routes/api/inventory.js#L485) |
| POST | `/vms/upgrade-tools` | 역할 `admin/operator` · 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:300](../server/src/routes/api/toolsInfo.js#L300) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:338](../server/src/routes/api/toolsCapacity.js#L338) |
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
| `fullScopeOnly` | 336 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `fleetOnly` | 212 | **전체 범위 계정만**(v2.607 AUTHZ2607-04·07 — 중앙 IPAM 스캔·중앙 인벤토리·감사 로그처럼 전 법인에 걸친 데이터·동작). 범위 제한 계정은 403. |
| `requireSettingsOwner` | 78 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 그리고 **소유자이면서 전체 범위(vCenter 제한 없음) 계정만** 통과한다 — 범위가 지정된 소유자는 403(v2.744 AUTHZ-02). 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
| `requireCentral` | 70 | **central 게이트**(v2.613 DEPS2613-09) — 공유 `CENTRAL_TOKEN`·엣지별 개별 토큰이 하나도 설정돼 있지 않으면 404, 토큰이 맞지 않으면 403. 51개 `/api/central/*` 라우트가 같은 미들웨어를 쓴다(예전의 인라인 2줄 게이트 쌍을 하나로). |
| `fullRwOnly` | 52 | **조회 · 쓰기 모두 전체 범위인 계정만**(v2.935 — `fullReadWriteScopeOnlyWith` 의 산물 · SAN 스위치 등록 · 수집 · 설정 변경 라우트). 쓰기 범위만 줄인 관리자도 403. |
| `csvPerm` | 37 | **CSV 가져오기/내보내기 권한**(`requirePerm('data.csv')` — v2.643). 관리자 이상만(super_admin 항상, admin 은 권한 설정에서 super_admin 이 끌 수 있다). operator·viewer 는 403. |
| `reauth` | 34 | 통합 계정 관리의 재인증 — 로컬 OTP 계정은 OTP, OTP 없는 계정은 설정 소유자만. |
| `demoBlockWrite` | 30 | **데모(손님) 계정 403**(v2.976 집중 모니터링 쓰기 — `isDemoGuest`). `noDemo` 와 같은 뜻 — 관리자 게이트 뒤에 붙는 쓰기 거절이고 권한을 넓히지 않는다. |
| `fullWriteOnly` | 24 | **쓰기 범위도 무제한인 계정만**(v2.823 Bareos 설정 쓰기). 조회는 무제한이어도 수정 가능 vCenter(writeVcenters)가 지정된 계정은 403 — 전 법인 공용 쓰기라 쓰기 범위와 교집합할 수 없다. |
| `fleetWideOnly` | 23 | **전체 범위 계정만**(v2.607 AUTHZ2607-03 — vCenter 등록·데이터 소스 전환·표시 순서). 범위 제한 계정은 403. |
| `tokenFirst` | 21 | **수집 토큰 확인을 본문 해석보다 먼저** 한다(v2.741 — 토큰 없는 요청이 본문 파서·큰 본문 한도에 닿지 않게). 토큰이 없거나 틀리면 403, 수집 토큰 미설정이면 404. |
| `fullReadWriteScopeOnlyWith` | 14 | **조회 · 쓰기 모두 전체 범위인 계정만**(v2.935 — `routes/admin/shared.js` · `auth/scope.js isFullReadWriteScope`). 조회 범위 또는 쓰기 범위(writeVcenters)를 지정한 계정은 403 — 스위치 설정을 바꾸는 라우트(SAN 플로우 모니터)가 쓴다. |
| `requireSuperAdmin` | 13 | **super_admin 전용**(v2.726 좌측 메뉴 배포·철회 · v2.740 아이실론 디렉터리 사용량 수집 대상 설정 — 조회·저장·일괄 변경·연결 시험·메일·SSH 키). 저장 역할이 super_admin 인 계정만(`req.user.superAdmin`). 역할 admin 은 403 `super-admin-only`(`requiredRole: ['super_admin']`). |
| `fleetReadOnly` | 10 | **전체 범위 계정만**(v2.621 SEC-03 — 폴더 사용량 조회. 응답이 RMA 엣지 IP·호스트명·마운트 경로를 싣는다 · v2.622 SEC-03 — GPU 게스트 엣지 배포 설정·엣지 배포 사용자·수집 진단 조회). 범위 제한 계정은 403. |
| `issueSettingsFleetOnly` | 10 | **전체 범위 계정만**(v2.871 — 이슈 설정: 자동 할당 규칙 · 알림 · 사람별 메일 주소. 전 법인 공용 설정이다). 범위 제한 계정은 403 · 핸들러가 관리자 판본(데모 제외)을 한 번 더 본다. |
| `express.json` | 10 | 본문 파서(대용량 JSON 한도). ⚠ 게이트가 아니다 — 이 자리에 있는 이유는 **인증보다 먼저 파싱하지 않기 위해** 라우트 단위로 붙였기 때문이다(`util/bigJsonGate.js` 규약). |
| `guarded` | 10 | 공개 API 전용 래퍼 — 허용 목록 검사 + 스냅샷 준비 + async throw 안전 처리. 미들웨어가 아니라 핸들러를 감싼 것이다. |
| `fullScopeOnlyWith` | 10 | **전체 범위 계정만**(사유 문구를 받는 `fullScopeOnly` — v2.628 SEC2628-01 업그레이드 제어·SEC2628-05 리소스 적정성 진단 등). 범위 제한 계정은 403. |
| `commenters` | 8 | **admin·operator 또는 권한 키 `issues.request`**(v2.881 위키 — 댓글 · 지켜보기. 데모 계정 제외 · 문서의 스페이스가 쓰기 범위 안이어야 한다 — 저장소 `addComment`). |
| `authMiddleware` | 8 | 세션 토큰 검증(`resolveTokenUser`). 대부분의 `/api/*` 는 마운트에서 이미 걸리고, 여기 보이는 것은 **라우터가 따로 건** 경우다(`/api/auth` 안의 admin 라우트 등). |
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
| `menuFleetOnly` | 3 | **전체 범위 계정만**(v2.726 — 좌측 메뉴 배포. 전 사용자 화면을 바꾼다). 범위 제한 계정은 403. |
| `templateFullWrite` | 3 | **쓰기 범위도 무제한인 계정만**(v2.889 — 위키 관리자 템플릿 쓰기). 조회는 무제한이어도 수정 가능 vCenter(writeVcenters)가 지정된 계정은 403(fullWriteOnly 와 같은 판정). |
| `adFleetOnly` | 3 | **전체 범위 계정만**(v2.628 SEC2628-04 — AD 설정 조회·저장·연결 테스트. AD 는 전 사용자 공통 인증 소스다). 범위 제한 계정은 403. |
| `hwFullScopeOnly` | 3 | **전체 범위 계정만**(서버 하드웨어 정보 내보내기 — v2.967). GET /insights/fleet 과 같은 근거: 미귀속 베어메탈 하드웨어가 들어가 범위로 나눌 수 없다. |
| `ownerIfAutoCentralToken` | 2 | 요청이 `autoCentralToken` 옵션을 쓸 때만 **설정 소유자**를 요구한다(평문 CENTRAL_TOKEN 을 원격 호스트에 기록하는 경로라 백업과 같은 등급). |
| `requireOwnOtp` | 2 | **본인 OTP 재인증**(1회용·실패 잠금). 호스트 접근 제어 적용·확정처럼 되돌리기 어려운 동작에 붙는다. |
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
| `csvPermUnlessJson` | 1 | `csvPerm` 과 같되 **format=json(화면의 표·붙여넣기 등록)은 통과**(v2.643 — 성능점검 대상 등록 마법사). |

---

## 생성 정보

- 생성기: `scripts/api-doc.mjs` · 스캐너 회귀: `server/test/apiDoc2563.test.js`
- ⚠ 스캐너가 마운트 경로를 못 찾은 파일·인자 목록을 못 읽은 라우트·해석 못 한 게이트 별칭이
  하나라도 있으면 **생성이 실패**합니다(문서가 조용히 비지 않게 — `docsGen2452.test.js` 의 교훈).

