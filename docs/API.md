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
| 엔드포인트 | **821개** |
| 마운트 그룹 | 14개 |
| 라우트 파일 | 74개 |
| GET | 427개 |
| POST | 261개 |
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
| [`/api/admin`](#apiadmin) | 303 | 설정·관리. `authMiddleware + requireEnrolled + auditMiddleware` 뒤에 있고 대부분 `adminOnly`, 비밀을 다루는 것은 `requireSettingsOwner` 가 추가된다. |
| [`/api/auth`](#apiauth) | 9 | 로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다). |
| [`/api/ping`](#apiping) | 14 | 네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자). |
| [`/metrics`](#metrics) | 1 | Prometheus/OTel 익스포터(선택 토큰). |
| [`/api/v1`](#apiv1) | 10 | **외부 포탈용 공개 조회 API**(v2.562). 전용 API 키(`X-Api-Key`)로 인증하고 조회 전용이다. 상세는 [API-PUBLIC.md](API-PUBLIC.md). |
| [`/api`](#api) | 322 | 포탈 화면이 쓰는 **주 조회·작업 API**. `authMiddleware + requireEnrolled` 뒤이고, `/tools/*` 는 `toolGate` 가 사용자별 도구 권한을 집행한다. |
| [`/dl`](#dl) | 2 | 중앙 업그레이드 소스(`versions.json` + 번들). **공개**다. |

---

## `/api/collector`

엣지(수집 서버)가 **자기 데이터를 내주는** 경로. 수집 토큰(`X-Collector-Token`) 게이트이고 사용자 세션을 타지 않는다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/bm-usage` | — | [server/src/routes/collector.js:175](../server/src/routes/collector.js#L175) |
| POST | `/bmstor-collect` | `express.json` | [server/src/routes/collector.js:262](../server/src/routes/collector.js#L262) |
| GET | `/edge-log` | — | [server/src/routes/collector.js:146](../server/src/routes/collector.js#L146) |
| GET | `/export` | — | [server/src/routes/collector.js:110](../server/src/routes/collector.js#L110) |
| POST | `/idrac-scan` | `express.json` | [server/src/routes/collector.js:238](../server/src/routes/collector.js#L238) |
| GET | `/ping` | — | [server/src/routes/collector.js:127](../server/src/routes/collector.js#L127) |
| POST | `/set-password` | `express.json` | [server/src/routes/collector.js:218](../server/src/routes/collector.js#L218) |
| GET | `/token-check` | — | [server/src/routes/collector.js:203](../server/src/routes/collector.js#L203) |
| POST | `/upgrade` | `express.raw` | [server/src/routes/collector.js:279](../server/src/routes/collector.js#L279) |

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
| GET | `/anomalies` | — | [server/src/routes/insights.js:206](../server/src/routes/insights.js#L206) |
| POST | `/chatops` | — | [server/src/routes/insights.js:272](../server/src/routes/insights.js#L272) |
| GET | `/finops` | — | [server/src/routes/insights.js:44](../server/src/routes/insights.js#L44) |
| GET | `/finops/config` | — | [server/src/routes/insights.js:62](../server/src/routes/insights.js#L62) |
| PUT | `/finops/config` | 역할 `admin` | [server/src/routes/insights.js:87](../server/src/routes/insights.js#L87) |
| GET | `/fleet` | — | [server/src/routes/insights.js:90](../server/src/routes/insights.js#L90) |
| PUT | `/fleet/assign` | 역할 `admin` | [server/src/routes/insights.js:137](../server/src/routes/insights.js#L137) |
| PUT | `/fleet/assign-bulk` | 역할 `admin` | [server/src/routes/insights.js:153](../server/src/routes/insights.js#L153) |
| POST | `/fleet/prune` | 역할 `admin` | [server/src/routes/insights.js:187](../server/src/routes/insights.js#L187) |
| PUT | `/fleet/tag` | 역할 `admin` | [server/src/routes/insights.js:110](../server/src/routes/insights.js#L110) |
| GET | `/forecast` | — | [server/src/routes/insights.js:226](../server/src/routes/insights.js#L226) |
| GET | `/graph` | — | [server/src/routes/insights.js:251](../server/src/routes/insights.js#L251) |
| GET | `/incidents` | — | [server/src/routes/insights.js:266](../server/src/routes/insights.js#L266) |
| GET | `/power-breakdown` | — | [server/src/routes/insights.js:65](../server/src/routes/insights.js#L65) |
| GET | `/security` | — | [server/src/routes/insights.js:238](../server/src/routes/insights.js#L238) |
| GET | `/topology` | — | [server/src/routes/insights.js:241](../server/src/routes/insights.js#L241) |

## `/api/central`

엣지 → 중앙 **push·pull** 경로. 개별/공유 중앙 토큰 게이트이며 라우터 미들웨어가 토큰↔agent 일치를 강제한다.

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| POST | `/agent-config` | — | [server/src/routes/central.js:1239](../server/src/routes/central.js#L1239) |
| GET | `/assignment` | — | [server/src/routes/central.js:255](../server/src/routes/central.js#L255) |
| GET | `/bmstor-jobs` | — | [server/src/routes/central.js:1303](../server/src/routes/central.js#L1303) |
| POST | `/bmstor-result` | — | [server/src/routes/central.js:1309](../server/src/routes/central.js#L1309) |
| POST | `/capacity-report` | — | [server/src/routes/central.js:387](../server/src/routes/central.js#L387) |
| GET | `/capture-jobs` | — | [server/src/routes/central.js:1284](../server/src/routes/central.js#L1284) |
| POST | `/capture-result` | — | [server/src/routes/central.js:1290](../server/src/routes/central.js#L1290) |
| POST | `/curuser` | — | [server/src/routes/central.js:650](../server/src/routes/central.js#L650) |
| GET | `/curuser-config` | — | [server/src/routes/central.js:695](../server/src/routes/central.js#L695) |
| GET | `/edge-log-jobs` | — | [server/src/routes/central.js:898](../server/src/routes/central.js#L898) |
| POST | `/edge-log-result` | — | [server/src/routes/central.js:907](../server/src/routes/central.js#L907) |
| POST | `/fleet` | — | [server/src/routes/central.js:727](../server/src/routes/central.js#L727) |
| GET | `/gpu-guest-config` | — | [server/src/routes/central.js:830](../server/src/routes/central.js#L830) |
| POST | `/gpu-guest-data` | — | [server/src/routes/central.js:778](../server/src/routes/central.js#L778) |
| POST | `/guest-disk` | — | [server/src/routes/central.js:521](../server/src/routes/central.js#L521) |
| GET | `/health-probe` | — | [server/src/routes/central.js:1372](../server/src/routes/central.js#L1372) |
| GET | `/idrac-scan-jobs` | — | [server/src/routes/central.js:739](../server/src/routes/central.js#L739) |
| POST | `/idrac-scan-progress` | — | [server/src/routes/central.js:746](../server/src/routes/central.js#L746) |
| POST | `/idrac-scan-result` | — | [server/src/routes/central.js:758](../server/src/routes/central.js#L758) |
| POST | `/inventory` | — | [server/src/routes/central.js:463](../server/src/routes/central.js#L463) |
| GET | `/ip-scan-assignment` | — | [server/src/routes/central.js:1326](../server/src/routes/central.js#L1326) |
| POST | `/ip-scan-result` | — | [server/src/routes/central.js:1335](../server/src/routes/central.js#L1335) |
| POST | `/link-check` | — | [server/src/routes/central.js:1388](../server/src/routes/central.js#L1388) |
| GET | `/link-check-config` | — | [server/src/routes/central.js:1418](../server/src/routes/central.js#L1418) |
| GET | `/log-queries` | — | [server/src/routes/central.js:1257](../server/src/routes/central.js#L1257) |
| POST | `/log-query-result` | — | [server/src/routes/central.js:1266](../server/src/routes/central.js#L1266) |
| POST | `/part-faults` | — | [server/src/routes/central.js:874](../server/src/routes/central.js#L874) |
| GET | `/partfault-config` | — | [server/src/routes/central.js:928](../server/src/routes/central.js#L928) |
| GET | `/pdu-config` | — | [server/src/routes/central.js:963](../server/src/routes/central.js#L963) |
| POST | `/pdu-data` | — | [server/src/routes/central.js:983](../server/src/routes/central.js#L983) |
| GET | `/ping-jobs` | — | [server/src/routes/central.js:1214](../server/src/routes/central.js#L1214) |
| POST | `/ping-result` | — | [server/src/routes/central.js:1224](../server/src/routes/central.js#L1224) |
| POST | `/register-collector` | — | [server/src/routes/central.js:266](../server/src/routes/central.js#L266) |
| POST | `/result` | — | [server/src/routes/central.js:332](../server/src/routes/central.js#L332) |
| POST | `/rma-credential` | — | [server/src/routes/central.js:1143](../server/src/routes/central.js#L1143) |
| POST | `/rma-poll` | — | [server/src/routes/central.js:1089](../server/src/routes/central.js#L1089) |
| POST | `/rma-result` | — | [server/src/routes/central.js:1165](../server/src/routes/central.js#L1165) |
| GET | `/sanswitch-config` | — | [server/src/routes/central.js:1006](../server/src/routes/central.js#L1006) |
| POST | `/sanswitch-data` | — | [server/src/routes/central.js:1178](../server/src/routes/central.js#L1178) |
| POST | `/sanswitch-perf` | — | [server/src/routes/central.js:1031](../server/src/routes/central.js#L1031) |
| POST | `/sanswitch-test-result` | — | [server/src/routes/central.js:1068](../server/src/routes/central.js#L1068) |
| GET | `/storage-config` | — | [server/src/routes/central.js:847](../server/src/routes/central.js#L847) |
| POST | `/storage-data` | — | [server/src/routes/central.js:938](../server/src/routes/central.js#L938) |
| GET | `/svcmon-config` | — | [server/src/routes/central.js:434](../server/src/routes/central.js#L434) |
| POST | `/svcmon-config-ack` | — | [server/src/routes/central.js:450](../server/src/routes/central.js#L450) |
| POST | `/svcmon-report` | — | [server/src/routes/central.js:361](../server/src/routes/central.js#L361) |
| GET | `/users-config` | — | [server/src/routes/central.js:1203](../server/src/routes/central.js#L1203) |
| POST | `/vmseries` | — | [server/src/routes/central.js:594](../server/src/routes/central.js#L594) |
| GET | `/vmseries-config` | — | [server/src/routes/central.js:715](../server/src/routes/central.js#L715) |

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
| GET | `/config` | 역할 `admin` | [server/src/routes/remote.js:135](../server/src/routes/remote.js#L135) |
| PUT | `/config` | 역할 `admin` | [server/src/routes/remote.js:137](../server/src/routes/remote.js#L137) |
| POST | `/deploy` | 역할 `admin` | [server/src/routes/remote.js:210](../server/src/routes/remote.js#L210) |
| POST | `/deploy/test` | 역할 `admin` | [server/src/routes/remote.js:195](../server/src/routes/remote.js#L195) |
| GET | `/mappings` | 권한 `remote.access` | [server/src/routes/remote.js:47](../server/src/routes/remote.js#L47) |
| POST | `/mappings` | 역할 `admin` | [server/src/routes/remote.js:226](../server/src/routes/remote.js#L226) |
| DELETE | `/mappings/:id` | 권한 `remote.access` | [server/src/routes/remote.js:275](../server/src/routes/remote.js#L275) |
| POST | `/mappings/:id/apply` | 역할 `admin` | [server/src/routes/remote.js:264](../server/src/routes/remote.js#L264) |
| POST | `/probe` | 권한 `remote.access` | [server/src/routes/remote.js:84](../server/src/routes/remote.js#L84) |
| GET | `/proxies` | 권한 `remote.access` | [server/src/routes/remote.js:112](../server/src/routes/remote.js#L112) |
| POST | `/proxies` | 역할 `admin` | [server/src/routes/remote.js:146](../server/src/routes/remote.js#L146) |
| DELETE | `/proxies/:id` | 역할 `admin` | [server/src/routes/remote.js:150](../server/src/routes/remote.js#L150) |
| POST | `/proxies/:id/health` | 역할 `admin` | [server/src/routes/remote.js:157](../server/src/routes/remote.js#L157) |
| GET | `/proxies/full` | 역할 `admin` | [server/src/routes/remote.js:145](../server/src/routes/remote.js#L145) |
| POST | `/quick-connect` | 권한 `remote.access` | [server/src/routes/remote.js:237](../server/src/routes/remote.js#L237) |
| POST | `/rdp-ticket` | 권한 `remote.access` | [server/src/routes/remote.js:35](../server/src/routes/remote.js#L35) |
| GET | `/rdp/:id` | 권한 `remote.access` | [server/src/routes/remote.js:290](../server/src/routes/remote.js#L290) |
| GET | `/targets` | 권한 `remote.access` | [server/src/routes/remote.js:118](../server/src/routes/remote.js#L118) |
| POST | `/test` | 역할 `admin` | [server/src/routes/remote.js:180](../server/src/routes/remote.js#L180) |

## `/api/svcmon`

성능점검(서비스 모니터링). 마운트에서 `requirePerm('svcmon')` — v2.506 에 추가된 게이트다.

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `requirePerm('svcmon')`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/assign` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:25](../server/src/routes/svcmon/edge.js#L25) |
| DELETE | `/assign/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:97](../server/src/routes/svcmon/edge.js#L97) |
| PUT | `/assign/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:55](../server/src/routes/svcmon/edge.js#L55) |
| GET | `/batches` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:173](../server/src/routes/svcmon/generate.js#L173) |
| DELETE | `/batches/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:188](../server/src/routes/svcmon/generate.js#L188) |
| POST | `/batches/:id/rollback` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:175](../server/src/routes/svcmon/generate.js#L175) |
| POST | `/config-pull-now` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:105](../server/src/routes/svcmon/edge.js#L105) |
| GET | `/diag` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:89](../server/src/routes/svcmon/overview.js#L89) |
| GET | `/edge-state` | — | [server/src/routes/svcmon/edge.js:127](../server/src/routes/svcmon/edge.js#L127) |
| GET | `/edges` | — | [server/src/routes/svcmon/edge.js:114](../server/src/routes/svcmon/edge.js#L114) |
| DELETE | `/edges/:agent` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:152](../server/src/routes/svcmon/edge.js#L152) |
| POST | `/edges/:agent/probe` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:142](../server/src/routes/svcmon/edge.js#L142) |
| POST | `/flush` | 역할 `admin` | [server/src/routes/svcmon/overview.js:104](../server/src/routes/svcmon/overview.js#L104) |
| POST | `/folders` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:23](../server/src/routes/svcmon/tree.js#L23) |
| POST | `/folders/delete` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:57](../server/src/routes/svcmon/tree.js#L57) |
| POST | `/folders/move` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:39](../server/src/routes/svcmon/tree.js#L39) |
| PUT | `/folders/rename` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:31](../server/src/routes/svcmon/tree.js#L31) |
| GET | `/log` | — | [server/src/routes/svcmon/logs.js:17](../server/src/routes/svcmon/logs.js#L17) |
| PUT | `/log` | 역할 `admin` | [server/src/routes/svcmon/logs.js:19](../server/src/routes/svcmon/logs.js#L19) |
| GET | `/log/analyze` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:63](../server/src/routes/svcmon/logs.js#L63) |
| GET | `/log/files/:name` | 역할 `admin/operator` | [server/src/routes/svcmon/logs.js:37](../server/src/routes/svcmon/logs.js#L37) |
| POST | `/log/prune` | 역할 `admin` | [server/src/routes/svcmon/logs.js:84](../server/src/routes/svcmon/logs.js#L84) |
| GET | `/log/windows` | — | [server/src/routes/svcmon/logs.js:47](../server/src/routes/svcmon/logs.js#L47) |
| POST | `/push-now` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:160](../server/src/routes/svcmon/edge.js#L160) |
| POST | `/refresh` | 역할 `admin/operator` | [server/src/routes/svcmon/overview.js:98](../server/src/routes/svcmon/overview.js#L98) |
| PUT | `/reorder/folders` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:52](../server/src/routes/svcmon/tree.js#L52) |
| PUT | `/reorder/targets` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:47](../server/src/routes/svcmon/tree.js#L47) |
| POST | `/silence-check` | 역할 `admin/operator` | [server/src/routes/svcmon/edge.js:167](../server/src/routes/svcmon/edge.js#L167) |
| PUT | `/sort` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:67](../server/src/routes/svcmon/tree.js#L67) |
| GET | `/state` | — | [server/src/routes/svcmon/overview.js:37](../server/src/routes/svcmon/overview.js#L37) |
| POST | `/targets` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:73](../server/src/routes/svcmon/tree.js#L73) |
| DELETE | `/targets/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:109](../server/src/routes/svcmon/tree.js#L109) |
| PUT | `/targets/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:100](../server/src/routes/svcmon/tree.js#L100) |
| POST | `/targets/:id/tests` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:115](../server/src/routes/svcmon/tree.js#L115) |
| DELETE | `/targets/:id/tests/:testId` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:133](../server/src/routes/svcmon/tree.js#L133) |
| PUT | `/targets/:id/tests/:testId` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:124](../server/src/routes/svcmon/tree.js#L124) |
| POST | `/targets/bulk` | 역할 `admin/operator` | [server/src/routes/svcmon/tree.js:81](../server/src/routes/svcmon/tree.js#L81) |
| GET | `/targets/csv-schema` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:136](../server/src/routes/svcmon/transfer.js#L136) |
| GET | `/targets/export.:format` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:68](../server/src/routes/svcmon/transfer.js#L68) |
| GET | `/targets/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:33](../server/src/routes/svcmon/transfer.js#L33) |
| POST | `/targets/generate` | 역할 `admin/operator` | [server/src/routes/svcmon/generate.js:90](../server/src/routes/svcmon/generate.js#L90) |
| GET | `/targets/hostmap-template.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:99](../server/src/routes/svcmon/transfer.js#L99) |
| POST | `/targets/hostmap/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:128](../server/src/routes/svcmon/transfer.js#L128) |
| POST | `/targets/hostmap/parse` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:108](../server/src/routes/svcmon/transfer.js#L108) |
| POST | `/targets/import` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:157](../server/src/routes/svcmon/transfer.js#L157) |
| GET | `/targets/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/transfer.js:90](../server/src/routes/svcmon/transfer.js#L90) |
| GET | `/templates` | — | [server/src/routes/svcmon/templates.js:26](../server/src/routes/svcmon/templates.js#L26) |
| POST | `/templates` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:31](../server/src/routes/svcmon/templates.js#L31) |
| DELETE | `/templates/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:64](../server/src/routes/svcmon/templates.js#L64) |
| PUT | `/templates/:id` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:42](../server/src/routes/svcmon/templates.js#L42) |
| POST | `/templates/:id/apply` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:127](../server/src/routes/svcmon/templates.js#L127) |
| POST | `/templates/:id/duplicate` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:54](../server/src/routes/svcmon/templates.js#L54) |
| GET | `/templates/:id/usage` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:121](../server/src/routes/svcmon/templates.js#L121) |
| GET | `/templates/export.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:77](../server/src/routes/svcmon/templates.js#L77) |
| POST | `/templates/import` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:96](../server/src/routes/svcmon/templates.js#L96) |
| GET | `/templates/sample.csv` | 역할 `admin/operator` | [server/src/routes/svcmon/templates.js:85](../server/src/routes/svcmon/templates.js#L85) |

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
| GET | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:27](../server/src/routes/admin/opsSettings.js#L27) |
| PUT | `/alerts` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:28](../server/src/routes/admin/opsSettings.js#L28) |
| POST | `/alerts/test` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:40](../server/src/routes/admin/opsSettings.js#L40) |
| GET | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:63](../server/src/routes/admin/opsSettings.js#L63) |
| PUT | `/anomaly` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:64](../server/src/routes/admin/opsSettings.js#L64) |
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
| GET | `/audit` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:22](../server/src/routes/admin/opsSettings.js#L22) |
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
| POST | `/certs/refresh` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:56](../server/src/routes/admin/opsSettings.js#L56) |
| GET | `/codex-check` | 역할 `admin` | [server/src/routes/admin/statusTools.js:23](../server/src/routes/admin/statusTools.js#L23) |
| GET | `/codex-check/file` | 역할 `admin` | [server/src/routes/admin/statusTools.js:26](../server/src/routes/admin/statusTools.js#L26) |
| POST | `/codex-check/write` | 역할 `admin` | [server/src/routes/admin/statusTools.js:29](../server/src/routes/admin/statusTools.js#L29) |
| GET | `/collectors` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:75](../server/src/routes/admin/collectorsDc.js#L75) |
| POST | `/collectors` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:79](../server/src/routes/admin/collectorsDc.js#L79) |
| DELETE | `/collectors/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:100](../server/src/routes/admin/collectorsDc.js#L100) |
| PUT | `/collectors/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:86](../server/src/routes/admin/collectorsDc.js#L86) |
| POST | `/collectors/:id/force-token` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:428](../server/src/routes/admin/collectorsDc.js#L428) |
| GET | `/collectors/export.csv` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:118](../server/src/routes/admin/collectorsDc.js#L118) |
| POST | `/collectors/import` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:147](../server/src/routes/admin/collectorsDc.js#L147) |
| POST | `/collectors/pull` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:340](../server/src/routes/admin/collectorsDc.js#L340) |
| GET | `/collectors/sample.csv` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:133](../server/src/routes/admin/collectorsDc.js#L133) |
| POST | `/collectors/set-password` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/collectorsDc.js:195](../server/src/routes/admin/collectorsDc.js#L195) |
| POST | `/collectors/test` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:361](../server/src/routes/admin/collectorsDc.js#L361) |
| POST | `/collectors/upgrade` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:347](../server/src/routes/admin/collectorsDc.js#L347) |
| GET | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:13](../server/src/routes/admin/vcenters.js#L13) |
| PUT | `/data-source` | 역할 `admin` | [server/src/routes/admin/vcenters.js:18](../server/src/routes/admin/vcenters.js#L18) |
| GET | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:266](../server/src/routes/admin/collectorsDc.js#L266) |
| PUT | `/datacenter-order` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:269](../server/src/routes/admin/collectorsDc.js#L269) |
| GET | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:236](../server/src/routes/admin/collectorsDc.js#L236) |
| POST | `/datacenters` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:242](../server/src/routes/admin/collectorsDc.js#L242) |
| DELETE | `/datacenters/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:260](../server/src/routes/admin/collectorsDc.js#L260) |
| PUT | `/datacenters/:id` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:255](../server/src/routes/admin/collectorsDc.js#L255) |
| PUT | `/datacenters/assign` | 역할 `admin` | [server/src/routes/admin/collectorsDc.js:248](../server/src/routes/admin/collectorsDc.js#L248) |
| POST | `/deep-search/probe` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:173](../server/src/routes/admin/backupNetSec.js#L173) |
| GET | `/dir-usage` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:21](../server/src/routes/admin/dirUsage.js#L21) |
| PUT | `/dir-usage` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:34](../server/src/routes/admin/dirUsage.js#L34) |
| GET | `/dir-usage/history/:targetId` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:56](../server/src/routes/admin/dirUsage.js#L56) |
| GET | `/dir-usage/preview/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:73](../server/src/routes/admin/dirUsage.js#L73) |
| POST | `/dir-usage/run` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:48](../server/src/routes/admin/dirUsage.js#L48) |
| GET | `/dir-usage/scan/:id` | 역할 `admin` | [server/src/routes/admin/dirUsage.js:64](../server/src/routes/admin/dirUsage.js#L64) |
| POST | `/edge-users-bulk` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:149](../server/src/routes/admin/gpuGuest.js#L149) |
| GET | `/edge-users/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:135](../server/src/routes/admin/gpuGuest.js#L135) |
| POST | `/edge-users/:agent` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:144](../server/src/routes/admin/gpuGuest.js#L144) |
| DELETE | `/edge-users/:agent/:username` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/gpuGuest.js:155](../server/src/routes/admin/gpuGuest.js#L155) |
| GET | `/edge-users/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:124](../server/src/routes/admin/gpuGuest.js#L124) |
| GET | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:40](../server/src/routes/admin/statusTools.js#L40) |
| POST | `/emergency-stop` | 역할 `admin` | [server/src/routes/admin/statusTools.js:44](../server/src/routes/admin/statusTools.js#L44) |
| GET | `/geocode` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:49](../server/src/routes/admin/nsxImport.js#L49) |
| GET | `/gpu-guest/deploy/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:110](../server/src/routes/admin/gpuGuest.js#L110) |
| PUT | `/gpu-guest/deploy/:agent` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:114](../server/src/routes/admin/gpuGuest.js#L114) |
| GET | `/gpu-guest/deploy/agents` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:100](../server/src/routes/admin/gpuGuest.js#L100) |
| GET | `/gpu-guest/diag` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:61](../server/src/routes/admin/gpuGuest.js#L61) |
| GET | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:50](../server/src/routes/admin/gpuGuest.js#L50) |
| PUT | `/gpu-guest/settings` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:53](../server/src/routes/admin/gpuGuest.js#L53) |
| POST | `/gpu-guest/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:251](../server/src/routes/admin/gpuGuest.js#L251) |
| POST | `/gpu-guest/test-ssh` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:341](../server/src/routes/admin/gpuGuest.js#L341) |
| GET | `/gpu-guest/vms` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:67](../server/src/routes/admin/gpuGuest.js#L67) |
| GET | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:161](../server/src/routes/admin/gpuGuest.js#L161) |
| POST | `/gpu-physical` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:164](../server/src/routes/admin/gpuGuest.js#L164) |
| DELETE | `/gpu-physical/:id` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:174](../server/src/routes/admin/gpuGuest.js#L174) |
| PUT | `/gpu-physical/:id` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:169](../server/src/routes/admin/gpuGuest.js#L169) |
| POST | `/gpu-physical/auto-register` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:183](../server/src/routes/admin/gpuGuest.js#L183) |
| POST | `/gpu-physical/bulk-auto-register` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:207](../server/src/routes/admin/gpuGuest.js#L207) |
| POST | `/gpu-physical/poll` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:178](../server/src/routes/admin/gpuGuest.js#L178) |
| POST | `/gpu-physical/test` | 역할 `admin` | [server/src/routes/admin/gpuGuest.js:235](../server/src/routes/admin/gpuGuest.js#L235) |
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
| POST | `/idrac` | 역할 `admin` | [server/src/routes/admin/idracCore.js:94](../server/src/routes/admin/idracCore.js#L94) |
| DELETE | `/idrac/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:483](../server/src/routes/admin/idracScan.js#L483) |
| PUT | `/idrac/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:477](../server/src/routes/admin/idracScan.js#L477) |
| GET | `/idrac/:id/gpu-probe` | 역할 `admin` | [server/src/routes/admin/idracScan.js:178](../server/src/routes/admin/idracScan.js#L178) |
| GET | `/idrac/:id/inventory` | 역할 `admin` | [server/src/routes/admin/idracScan.js:43](../server/src/routes/admin/idracScan.js#L43) |
| GET | `/idrac/:id/sensors` | 역할 `admin` | [server/src/routes/admin/idracScan.js:94](../server/src/routes/admin/idracScan.js#L94) |
| GET | `/idrac/:id/temp-history` | 역할 `admin` | [server/src/routes/admin/idracScan.js:136](../server/src/routes/admin/idracScan.js#L136) |
| GET | `/idrac/:id/vcenter-host` | 역할 `admin` | [server/src/routes/admin/idracScan.js:62](../server/src/routes/admin/idracScan.js#L62) |
| POST | `/idrac/assign-vcenter` | 역할 `admin` | [server/src/routes/admin/idracScan.js:465](../server/src/routes/admin/idracScan.js#L465) |
| POST | `/idrac/bulk-add` | 역할 `admin` | [server/src/routes/admin/idracScan.js:210](../server/src/routes/admin/idracScan.js#L210) |
| POST | `/idrac/delete` | 역할 `admin` | [server/src/routes/admin/idracScan.js:452](../server/src/routes/admin/idracScan.js#L452) |
| POST | `/idrac/expand-ips` | 역할 `admin` | [server/src/routes/admin/idracScan.js:203](../server/src/routes/admin/idracScan.js#L203) |
| GET | `/idrac/firmware-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:384](../server/src/routes/admin/idracCore.js#L384) |
| GET | `/idrac/gpu-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:419](../server/src/routes/admin/idracCore.js#L419) |
| GET | `/idrac/hardware-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:320](../server/src/routes/admin/idracCore.js#L320) |
| GET | `/idrac/hardware-summary` | 역할 `admin` | [server/src/routes/admin/idracCore.js:140](../server/src/routes/admin/idracCore.js#L140) |
| POST | `/idrac/import` | 역할 `admin` | [server/src/routes/admin/idracScan.js:192](../server/src/routes/admin/idracScan.js#L192) |
| GET | `/idrac/nic-models` | 역할 `admin` | [server/src/routes/admin/idracCore.js:245](../server/src/routes/admin/idracCore.js#L245) |
| GET | `/idrac/nic-speed` | 역할 `admin` | [server/src/routes/admin/idracCore.js:175](../server/src/routes/admin/idracCore.js#L175) |
| GET | `/idrac/parts-inventory` | 역할 `admin` | [server/src/routes/admin/idracCore.js:478](../server/src/routes/admin/idracCore.js#L478) |
| GET | `/idrac/parts-servers` | 역할 `admin` | [server/src/routes/admin/idracCore.js:495](../server/src/routes/admin/idracCore.js#L495) |
| POST | `/idrac/poll` | 역할 `admin` | [server/src/routes/admin/idracCore.js:109](../server/src/routes/admin/idracCore.js#L109) |
| POST | `/idrac/power-purge` | 역할 `admin` | [server/src/routes/admin/idracCore.js:126](../server/src/routes/admin/idracCore.js#L126) |
| GET | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:114](../server/src/routes/admin/idracCore.js#L114) |
| PUT | `/idrac/power-settings` | 역할 `admin` | [server/src/routes/admin/idracCore.js:115](../server/src/routes/admin/idracCore.js#L115) |
| POST | `/idrac/register-scanned` | 역할 `admin` | [server/src/routes/admin/idracScan.js:273](../server/src/routes/admin/idracScan.js#L273) |
| POST | `/idrac/scan` | 역할 `admin` | [server/src/routes/admin/idracScan.js:219](../server/src/routes/admin/idracScan.js#L219) |
| GET | `/idrac/scan-agents` | 역할 `admin` | [server/src/routes/admin/idracScan.js:259](../server/src/routes/admin/idracScan.js#L259) |
| GET | `/idrac/scan-job-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:426](../server/src/routes/admin/idracScan.js#L426) |
| POST | `/idrac/scan-job/cancel` | 역할 `admin` | [server/src/routes/admin/idracScan.js:444](../server/src/routes/admin/idracScan.js#L444) |
| GET | `/idrac/scan-jobs` | 역할 `admin` | [server/src/routes/admin/idracScan.js:416](../server/src/routes/admin/idracScan.js#L416) |
| GET | `/idrac/scan-log` | 역할 `admin` | [server/src/routes/admin/idracScan.js:391](../server/src/routes/admin/idracScan.js#L391) |
| GET | `/idrac/scan-ranges` | 역할 `admin` | [server/src/routes/admin/idracScan.js:290](../server/src/routes/admin/idracScan.js#L290) |
| PUT | `/idrac/scan-ranges` | 역할 `admin` | [server/src/routes/admin/idracScan.js:296](../server/src/routes/admin/idracScan.js#L296) |
| DELETE | `/idrac/scan-ranges/:id` | 역할 `admin` | [server/src/routes/admin/idracScan.js:304](../server/src/routes/admin/idracScan.js#L304) |
| GET | `/idrac/scan-ranges/export.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:314](../server/src/routes/admin/idracScan.js#L314) |
| POST | `/idrac/scan-ranges/import` | 역할 `admin` | [server/src/routes/admin/idracScan.js:335](../server/src/routes/admin/idracScan.js#L335) |
| PUT | `/idrac/scan-ranges/interval` | 역할 `admin` | [server/src/routes/admin/idracScan.js:405](../server/src/routes/admin/idracScan.js#L405) |
| GET | `/idrac/scan-ranges/sample.csv` | 역할 `admin` | [server/src/routes/admin/idracScan.js:329](../server/src/routes/admin/idracScan.js#L329) |
| POST | `/idrac/scan-ranges/scan` | 역할 `admin` | [server/src/routes/admin/idracScan.js:379](../server/src/routes/admin/idracScan.js#L379) |
| GET | `/idrac/scan-ranges/status` | 역할 `admin` | [server/src/routes/admin/idracScan.js:388](../server/src/routes/admin/idracScan.js#L388) |
| POST | `/idrac/scan-ranges/stop` | 역할 `admin` | [server/src/routes/admin/idracScan.js:398](../server/src/routes/admin/idracScan.js#L398) |
| GET | `/idrac/scan-result` | 역할 `admin` | [server/src/routes/admin/idracScan.js:250](../server/src/routes/admin/idracScan.js#L250) |
| GET | `/idrac/temps` | 역할 `admin` | [server/src/routes/admin/idracCore.js:361](../server/src/routes/admin/idracCore.js#L361) |
| POST | `/idrac/test` | 역할 `admin` | [server/src/routes/admin/idracCore.js:104](../server/src/routes/admin/idracCore.js#L104) |
| GET | `/idrac/unsupported` | 역할 `admin` | [server/src/routes/admin/idracCore.js:354](../server/src/routes/admin/idracCore.js#L354) |
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
| POST | `/llm-test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:485](../server/src/routes/admin/deployLlm.js#L485) |
| GET | `/logs` | 역할 `admin` | [server/src/routes/admin/statusTools.js:67](../server/src/routes/admin/statusTools.js#L67) |
| GET | `/mail` | 역할 `admin` | [server/src/routes/admin/mail.js:19](../server/src/routes/admin/mail.js#L19) |
| PUT | `/mail` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:23](../server/src/routes/admin/mail.js#L23) |
| POST | `/mail/test` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/mail.js:45](../server/src/routes/admin/mail.js#L45) |
| GET | `/memtrack` | 역할 `admin` | [server/src/routes/admin/statusTools.js:165](../server/src/routes/admin/statusTools.js#L165) |
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
| POST | `/nsx/managers` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:29](../server/src/routes/admin/nsxImport.js#L29) |
| DELETE | `/nsx/managers/:id` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:39](../server/src/routes/admin/nsxImport.js#L39) |
| PUT | `/nsx/managers/:id` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:34](../server/src/routes/admin/nsxImport.js#L34) |
| POST | `/nsx/managers/test` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:44](../server/src/routes/admin/nsxImport.js#L44) |
| POST | `/ollama-deploy` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:491](../server/src/routes/admin/deployLlm.js#L491) |
| POST | `/ollama-deploy/test` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:490](../server/src/routes/admin/deployLlm.js#L490) |
| GET | `/os-scan` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:135](../server/src/routes/admin/opsSettings.js#L135) |
| GET | `/os-scan/results` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:138](../server/src/routes/admin/opsSettings.js#L138) |
| GET | `/os-scan/results.csv` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:142](../server/src/routes/admin/opsSettings.js#L142) |
| POST | `/os-scan/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:137](../server/src/routes/admin/opsSettings.js#L137) |
| PUT | `/os-scan/settings` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:136](../server/src/routes/admin/opsSettings.js#L136) |
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
| GET | `/portal-db/health` | 역할 `admin` | [server/src/routes/admin/statusTools.js:94](../server/src/routes/admin/statusTools.js#L94) |
| GET | `/portal-db/location` | 역할 `admin` | [server/src/routes/admin/statusTools.js:110](../server/src/routes/admin/statusTools.js#L110) |
| POST | `/portal-db/location/preflight` | 역할 `admin` | [server/src/routes/admin/statusTools.js:126](../server/src/routes/admin/statusTools.js#L126) |
| POST | `/portal-db/location/script` | 역할 `admin` | [server/src/routes/admin/statusTools.js:136](../server/src/routes/admin/statusTools.js#L136) |
| POST | `/provision/jobs` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:158](../server/src/routes/admin/opsSettings.js#L158) |
| DELETE | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:175](../server/src/routes/admin/opsSettings.js#L175) |
| PUT | `/provision/saved/:id` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:167](../server/src/routes/admin/opsSettings.js#L167) |
| POST | `/release-notes` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:498](../server/src/routes/admin/deployLlm.js#L498) |
| DELETE | `/release-notes/:version` | 역할 `admin` | [server/src/routes/admin/deployLlm.js:502](../server/src/routes/admin/deployLlm.js#L502) |
| GET | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:43](../server/src/routes/admin/opsSettings.js#L43) |
| PUT | `/report/daily` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:44](../server/src/routes/admin/opsSettings.js#L44) |
| POST | `/report/daily/run` | 역할 `admin` | [server/src/routes/admin/opsSettings.js:49](../server/src/routes/admin/opsSettings.js#L49) |
| GET | `/room-temp` | 역할 `admin` | [server/src/routes/admin/idracCore.js:69](../server/src/routes/admin/idracCore.js#L69) |
| GET | `/room-temp/history` | 역할 `admin` | [server/src/routes/admin/idracCore.js:41](../server/src/routes/admin/idracCore.js#L41) |
| GET | `/room-temp/spark` | 역할 `admin` | [server/src/routes/admin/idracCore.js:57](../server/src/routes/admin/idracCore.js#L57) |
| GET | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:71](../server/src/routes/admin/opsSettings.js#L71) |
| PUT | `/secrets/policy` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:74](../server/src/routes/admin/opsSettings.js#L74) |
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
| GET | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:98](../server/src/routes/admin/opsSettings.js#L98) |
| PUT | `/security/session` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/admin/opsSettings.js:99](../server/src/routes/admin/opsSettings.js#L99) |
| GET | `/status` | 역할 `admin` | [server/src/routes/admin/statusTools.js:170](../server/src/routes/admin/statusTools.js#L170) |
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
| GET | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:75](../server/src/routes/admin/vcenters.js#L75) |
| PUT | `/vcenter-order` | 역할 `admin` | [server/src/routes/admin/vcenters.js:83](../server/src/routes/admin/vcenters.js#L83) |
| GET | `/vcenter/relay-test` | 역할 `admin` | [server/src/routes/admin/statusTools.js:73](../server/src/routes/admin/statusTools.js#L73) |
| GET | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:26](../server/src/routes/admin/vcenters.js#L26) |
| POST | `/vcenters` | 역할 `admin` | [server/src/routes/admin/vcenters.js:31](../server/src/routes/admin/vcenters.js#L31) |
| DELETE | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:45](../server/src/routes/admin/vcenters.js#L45) |
| PUT | `/vcenters/:id` | 역할 `admin` | [server/src/routes/admin/vcenters.js:38](../server/src/routes/admin/vcenters.js#L38) |
| POST | `/vcenters/import` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:56](../server/src/routes/admin/nsxImport.js#L56) |
| POST | `/vcenters/import-file` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:73](../server/src/routes/admin/nsxImport.js#L73) |
| GET | `/vcenters/import-suggestions` | 역할 `admin` | [server/src/routes/admin/nsxImport.js:65](../server/src/routes/admin/nsxImport.js#L65) |
| POST | `/vcenters/test` | 역할 `admin` | [server/src/routes/admin/vcenters.js:52](../server/src/routes/admin/vcenters.js#L52) |
| POST | `/vcenters/test-all` | 역할 `admin` | [server/src/routes/admin/vcenters.js:59](../server/src/routes/admin/vcenters.js#L59) |
| POST | `/vclogs/collect` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:88](../server/src/routes/admin/backupNetSec.js#L88) |
| PUT | `/vclogs/settings` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:72](../server/src/routes/admin/backupNetSec.js#L72) |
| GET | `/vclogs/status` | 역할 `admin` | [server/src/routes/admin/backupNetSec.js:69](../server/src/routes/admin/backupNetSec.js#L69) |
| GET | `/vm/:id/hardware` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:276](../server/src/routes/admin/collectorsDc.js#L276) |
| POST | `/vm/:id/reconfig` | 권한 `vm.reconfig` | [server/src/routes/admin/collectorsDc.js:299](../server/src/routes/admin/collectorsDc.js#L299) |

## `/api/auth`

로그인·OTP·`/me`. **로그인 전** 호출되므로 `requireEnrolled` 를 타지 않는다(내부 admin 라우트는 스스로 게이트한다).

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:220](../server/src/routes/auth.js#L220) |
| PUT | `/ad-config` | 역할 `admin` · `authMiddleware` · `requireEnrolled` · `requireSettingsOwner` | [server/src/routes/auth.js:228](../server/src/routes/auth.js#L228) |
| POST | `/ad-test` | 역할 `admin` · `authMiddleware` · `requireEnrolled` | [server/src/routes/auth.js:233](../server/src/routes/auth.js#L233) |
| GET | `/config` | — | [server/src/routes/auth.js:23](../server/src/routes/auth.js#L23) |
| POST | `/extend` | `authMiddleware` | [server/src/routes/auth.js:159](../server/src/routes/auth.js#L159) |
| POST | `/login` | — | [server/src/routes/auth.js:43](../server/src/routes/auth.js#L43) |
| GET | `/me` | `authMiddleware` | [server/src/routes/auth.js:132](../server/src/routes/auth.js#L132) |
| POST | `/totp/begin` | `authMiddleware` | [server/src/routes/auth.js:204](../server/src/routes/auth.js#L204) |
| POST | `/totp/confirm` | `authMiddleware` | [server/src/routes/auth.js:208](../server/src/routes/auth.js#L208) |

## `/api/ping`

네트워크 Ping 모니터링(조회=인증, 대상 관리=관리자).

**공통 게이트**(마운트·라우터 수준): `authMiddleware` → `requireEnrolled` → `auditMiddleware`

| 메서드 | 경로 | 게이트(공통 제외) | 소스 |
|---|---|---|---|
| GET | `/edge/overview` | — | [server/src/routes/ping.js:148](../server/src/routes/ping.js#L148) |
| POST | `/edge/sync` | 역할 `admin` | [server/src/routes/ping.js:158](../server/src/routes/ping.js#L158) |
| POST | `/poll-now` | 역할 `admin` | [server/src/routes/ping.js:109](../server/src/routes/ping.js#L109) |
| POST | `/seed-vcenters` | 역할 `admin` | [server/src/routes/ping.js:114](../server/src/routes/ping.js#L114) |
| GET | `/series` | — | [server/src/routes/ping.js:91](../server/src/routes/ping.js#L91) |
| GET | `/status` | — | [server/src/routes/ping.js:73](../server/src/routes/ping.js#L73) |
| GET | `/targets` | — | [server/src/routes/ping.js:86](../server/src/routes/ping.js#L86) |
| POST | `/targets` | 역할 `admin` | [server/src/routes/ping.js:101](../server/src/routes/ping.js#L101) |
| DELETE | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:103](../server/src/routes/ping.js#L103) |
| PUT | `/targets/:id` | 역할 `admin` | [server/src/routes/ping.js:102](../server/src/routes/ping.js#L102) |
| GET | `/vcport/overview` | — | [server/src/routes/ping.js:164](../server/src/routes/ping.js#L164) |
| GET | `/vcport/ports` | — | [server/src/routes/ping.js:178](../server/src/routes/ping.js#L178) |
| PUT | `/vcport/ports` | 역할 `admin` | [server/src/routes/ping.js:180](../server/src/routes/ping.js#L180) |
| POST | `/vcport/sync` | 역할 `admin` | [server/src/routes/ping.js:185](../server/src/routes/ping.js#L185) |

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
| GET | `/alarm-mutes` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:405](../server/src/routes/api/inventory.js#L405) |
| POST | `/alarm-mutes` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:408](../server/src/routes/api/inventory.js#L408) |
| DELETE | `/alarm-mutes/:id` | 역할 `admin/operator` · 권한 `inv.alarms` · `auditMiddleware` | [server/src/routes/api/inventory.js:416](../server/src/routes/api/inventory.js#L416) |
| GET | `/alarms` | 권한 `inv.alarms` | [server/src/routes/api/inventory.js:391](../server/src/routes/api/inventory.js#L391) |
| GET | `/compare/matrix` | — | [server/src/routes/api/compareMatrix.js:28](../server/src/routes/api/compareMatrix.js#L28) |
| GET | `/datastores` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:337](../server/src/routes/api/inventory.js#L337) |
| GET | `/datastores/:id/browse` | 권한 `inv.datastores` | [server/src/routes/api/inventory.js:345](../server/src/routes/api/inventory.js#L345) |
| GET | `/health` | — | [server/src/routes/api/overviewNsx.js:86](../server/src/routes/api/overviewNsx.js#L86) |
| GET | `/hosts` | 권한 `inv.hosts` | [server/src/routes/api/inventory.js:197](../server/src/routes/api/inventory.js#L197) |
| GET | `/hosts/:id/metrics` | 권한 `inv.hosts` | [server/src/routes/api/vmMetrics.js:75](../server/src/routes/api/vmMetrics.js#L75) |
| GET | `/idrac/host-power` | — | [server/src/routes/api/vmMetrics.js:134](../server/src/routes/api/vmMetrics.js#L134) |
| GET | `/networks` | 권한 `inv.networks` | [server/src/routes/api/inventory.js:356](../server/src/routes/api/inventory.js#L356) |
| GET | `/nsx` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:174](../server/src/routes/api/overviewNsx.js#L174) |
| GET | `/nsx/group-members` | 권한 `inv.nsx` | [server/src/routes/api/overviewNsx.js:208](../server/src/routes/api/overviewNsx.js#L208) |
| GET | `/overview` | — | [server/src/routes/api/overviewNsx.js:127](../server/src/routes/api/overviewNsx.js#L127) |
| GET | `/perf/client-config` | — | [server/src/routes/api/perfClient.js:90](../server/src/routes/api/perfClient.js#L90) |
| POST | `/perf/client-stall` | — | [server/src/routes/api/perfClient.js:67](../server/src/routes/api/perfClient.js#L67) |
| GET | `/provision/jobs` | — | [server/src/routes/api/provision.js:58](../server/src/routes/api/provision.js#L58) |
| GET | `/provision/jobs/:id` | — | [server/src/routes/api/provision.js:59](../server/src/routes/api/provision.js#L59) |
| GET | `/provision/placement` | 권한 `vm.provision` | [server/src/routes/api/provision.js:28](../server/src/routes/api/provision.js#L28) |
| POST | `/provision/preview` | 권한 `vm.provision` | [server/src/routes/api/provision.js:40](../server/src/routes/api/provision.js#L40) |
| GET | `/provision/saved` | 권한 `vm.provision` | [server/src/routes/api/provision.js:45](../server/src/routes/api/provision.js#L45) |
| GET | `/provision/saved/:id` | 권한 `vm.provision` | [server/src/routes/api/provision.js:48](../server/src/routes/api/provision.js#L48) |
| GET | `/provision/sources` | 권한 `vm.provision` | [server/src/routes/api/provision.js:21](../server/src/routes/api/provision.js#L21) |
| GET | `/release-notes` | — | [server/src/routes/api/searchNotes.js:19](../server/src/routes/api/searchNotes.js#L19) |
| POST | `/search/nl` | — | [server/src/routes/api/searchNotes.js:11](../server/src/routes/api/searchNotes.js#L11) |
| GET | `/summary` | — | [server/src/routes/api/inventory.js:50](../server/src/routes/api/inventory.js#L50) |
| POST | `/tool-usage` | — | [server/src/routes/api/inventory.js:435](../server/src/routes/api/inventory.js#L435) |
| GET | `/tool-usage/top` | — | [server/src/routes/api/inventory.js:431](../server/src/routes/api/inventory.js#L431) |
| GET | `/tools/bm-storage` | 역할 `admin` | [server/src/routes/api/bmstor.js:16](../server/src/routes/api/bmstor.js#L16) |
| POST | `/tools/bm-storage/collect` | 역할 `admin` | [server/src/routes/api/bmstor.js:106](../server/src/routes/api/bmstor.js#L106) |
| GET | `/tools/bm-storage/export.csv` | 역할 `admin` | [server/src/routes/api/bmstor.js:50](../server/src/routes/api/bmstor.js#L50) |
| POST | `/tools/bm-storage/import` | 역할 `admin` | [server/src/routes/api/bmstor.js:70](../server/src/routes/api/bmstor.js#L70) |
| GET | `/tools/bm-storage/sample.csv` | 역할 `admin` | [server/src/routes/api/bmstor.js:64](../server/src/routes/api/bmstor.js#L64) |
| POST | `/tools/bm-storage/servers` | 역할 `admin` | [server/src/routes/api/bmstor.js:28](../server/src/routes/api/bmstor.js#L28) |
| DELETE | `/tools/bm-storage/servers/:id` | 역할 `admin` | [server/src/routes/api/bmstor.js:34](../server/src/routes/api/bmstor.js#L34) |
| PUT | `/tools/bm-storage/settings` | 역할 `admin` | [server/src/routes/api/bmstor.js:41](../server/src/routes/api/bmstor.js#L41) |
| GET | `/tools/bm-usage` | 권한 `tools` | [server/src/routes/api/bmUsage.js:59](../server/src/routes/api/bmUsage.js#L59) |
| GET | `/tools/bm-usage/activity` | 권한 `tools` | [server/src/routes/api/bmUsage.js:186](../server/src/routes/api/bmUsage.js#L186) |
| POST | `/tools/bm-usage/collect` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:164](../server/src/routes/api/bmUsage.js#L164) |
| GET | `/tools/bm-usage/edges` | 권한 `tools` | [server/src/routes/api/bmUsage.js:236](../server/src/routes/api/bmUsage.js#L236) |
| POST | `/tools/bm-usage/edges/pull` | 역할 `admin/operator` · 권한 `tools` | [server/src/routes/api/bmUsage.js:289](../server/src/routes/api/bmUsage.js#L289) |
| GET | `/tools/bm-usage/history` | 권한 `tools` | [server/src/routes/api/bmUsage.js:130](../server/src/routes/api/bmUsage.js#L130) |
| PUT | `/tools/bm-usage/settings` | 역할 `admin` | [server/src/routes/api/bmUsage.js:317](../server/src/routes/api/bmUsage.js#L317) |
| GET | `/tools/capacity` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:38](../server/src/routes/api/toolsCapacity.js#L38) |
| GET | `/tools/capacity-forecast` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1436](../server/src/routes/api/toolsCapacity.js#L1436) |
| GET | `/tools/capacity/disk-history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1341](../server/src/routes/api/toolsCapacity.js#L1341) |
| GET | `/tools/credentials` | 역할 `admin` | [server/src/routes/api/credentials.js:42](../server/src/routes/api/credentials.js#L42) |
| POST | `/tools/credentials` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:52](../server/src/routes/api/credentials.js#L52) |
| DELETE | `/tools/credentials/:id` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:72](../server/src/routes/api/credentials.js#L72) |
| PUT | `/tools/credentials/:id` | 역할 `admin` · `reauth` | [server/src/routes/api/credentials.js:62](../server/src/routes/api/credentials.js#L62) |
| POST | `/tools/credentials/:id/test` | 역할 `admin` | [server/src/routes/api/credentials.js:80](../server/src/routes/api/credentials.js#L80) |
| POST | `/tools/credentials/inspect-key` | 역할 `admin` | [server/src/routes/api/credentials.js:47](../server/src/routes/api/credentials.js#L47) |
| GET | `/tools/current-users/combined` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:157](../server/src/routes/api/horizonSessions.js#L157) |
| GET | `/tools/curuser` | 권한 `tools` | [server/src/routes/api/curUser.js:44](../server/src/routes/api/curUser.js#L44) |
| GET | `/tools/curuser/activity` | 권한 `tools` | [server/src/routes/api/curUser.js:107](../server/src/routes/api/curUser.js#L107) |
| GET | `/tools/curuser/agent-script` | 권한 `tools` | [server/src/routes/api/curUser.js:194](../server/src/routes/api/curUser.js#L194) |
| POST | `/tools/curuser/collect` | 역할 `admin` | [server/src/routes/api/curUser.js:120](../server/src/routes/api/curUser.js#L120) |
| GET | `/tools/curuser/history` | 권한 `tools` | [server/src/routes/api/curUser.js:76](../server/src/routes/api/curUser.js#L76) |
| GET | `/tools/curuser/settings` | 권한 `tools` | [server/src/routes/api/curUser.js:129](../server/src/routes/api/curUser.js#L129) |
| PUT | `/tools/curuser/settings` | 역할 `admin` | [server/src/routes/api/curUser.js:168](../server/src/routes/api/curUser.js#L168) |
| POST | `/tools/deep-search` | 권한 `tools` | [server/src/routes/api/checksLogs.js:38](../server/src/routes/api/checksLogs.js#L38) |
| GET | `/tools/duplicate-ips` | 권한 `tools` | [server/src/routes/api/vcTools.js:23](../server/src/routes/api/vcTools.js#L23) |
| GET | `/tools/edge-log` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:114](../server/src/routes/api/edgeLog.js#L114) |
| GET | `/tools/edge-log-local` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:126](../server/src/routes/api/edgeLog.js#L126) |
| GET | `/tools/edge-log/:agent` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:175](../server/src/routes/api/edgeLog.js#L175) |
| POST | `/tools/edge-log/fetch` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/edgeLog.js:143](../server/src/routes/api/edgeLog.js#L143) |
| GET | `/tools/esxi` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:272](../server/src/routes/api/hardwareGpu.js#L272) |
| GET | `/tools/esxi-temp` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1084](../server/src/routes/api/toolsCapacity.js#L1084) |
| GET | `/tools/esxi-temp/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1178](../server/src/routes/api/toolsCapacity.js#L1178) |
| POST | `/tools/esxi-temp/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1240](../server/src/routes/api/toolsCapacity.js#L1240) |
| GET | `/tools/gpu` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:291](../server/src/routes/api/hardwareGpu.js#L291) |
| GET | `/tools/gpu.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:305](../server/src/routes/api/hardwareGpu.js#L305) |
| GET | `/tools/gpu.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:297](../server/src/routes/api/hardwareGpu.js#L297) |
| GET | `/tools/gpu/export.csv` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:328](../server/src/routes/api/hardwareGpu.js#L328) |
| GET | `/tools/gpu/export.json` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:329](../server/src/routes/api/hardwareGpu.js#L329) |
| GET | `/tools/gpu/history` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:150](../server/src/routes/api/toolsAnalytics.js#L150) |
| GET | `/tools/gpu/series-meta` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:321](../server/src/routes/api/hardwareGpu.js#L321) |
| GET | `/tools/gpu/vms` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:356](../server/src/routes/api/hardwareGpu.js#L356) |
| GET | `/tools/groups` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:338](../server/src/routes/api/toolsCapacity.js#L338) |
| GET | `/tools/guest-disk` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:18](../server/src/routes/api/toolsGuestDisk.js#L18) |
| GET | `/tools/guest-disk/export.csv` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:40](../server/src/routes/api/toolsGuestDisk.js#L40) |
| POST | `/tools/guest-disk/run` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:66](../server/src/routes/api/toolsGuestDisk.js#L66) |
| PUT | `/tools/guest-disk/settings` | 역할 `admin` | [server/src/routes/api/toolsGuestDisk.js:59](../server/src/routes/api/toolsGuestDisk.js#L59) |
| GET | `/tools/guest-disk/status` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:54](../server/src/routes/api/toolsGuestDisk.js#L54) |
| GET | `/tools/guest-disk/vm/:id` | 권한 `tools` | [server/src/routes/api/toolsGuestDisk.js:29](../server/src/routes/api/toolsGuestDisk.js#L29) |
| GET | `/tools/guest-os` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:31](../server/src/routes/api/toolsInfo.js#L31) |
| GET | `/tools/guest-os/vms` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:49](../server/src/routes/api/toolsInfo.js#L49) |
| GET | `/tools/hardware` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:240](../server/src/routes/api/hardwareGpu.js#L240) |
| GET | `/tools/hba` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:73](../server/src/routes/api/toolsInfo.js#L73) |
| GET | `/tools/horizon-sessions` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:61](../server/src/routes/api/horizonSessions.js#L61) |
| GET | `/tools/horizon-sessions/activity` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:104](../server/src/routes/api/horizonSessions.js#L104) |
| POST | `/tools/horizon-sessions/collect` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:109](../server/src/routes/api/horizonSessions.js#L109) |
| GET | `/tools/horizon-sessions/history` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:88](../server/src/routes/api/horizonSessions.js#L88) |
| GET | `/tools/horizon-sessions/settings` | 권한 `tools` | [server/src/routes/api/horizonSessions.js:118](../server/src/routes/api/horizonSessions.js#L118) |
| PUT | `/tools/horizon-sessions/settings` | 역할 `admin` | [server/src/routes/api/horizonSessions.js:131](../server/src/routes/api/horizonSessions.js#L131) |
| GET | `/tools/insights` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:27](../server/src/routes/api/toolsAnalytics.js#L27) |
| GET | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:346](../server/src/routes/api/hardwareGpu.js#L346) |
| POST | `/tools/ip-ping` | 권한 `tools` | [server/src/routes/api/hardwareGpu.js:334](../server/src/routes/api/hardwareGpu.js#L334) |
| GET | `/tools/ipam` | 권한 `tools` | [server/src/routes/api/ipamExport.js:70](../server/src/routes/api/ipamExport.js#L70) |
| GET | `/tools/ipam.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:416](../server/src/routes/api/ipamExport.js#L416) |
| GET | `/tools/ipam.xlsx` | 권한 `tools` | [server/src/routes/api/ipamExport.js:395](../server/src/routes/api/ipamExport.js#L395) |
| GET | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:182](../server/src/routes/api/ipamExport.js#L182) |
| PUT | `/tools/ipam/annotation` | 권한 `tools` | [server/src/routes/api/ipamExport.js:193](../server/src/routes/api/ipamExport.js#L193) |
| POST | `/tools/ipam/bulk` | 권한 `tools` | [server/src/routes/api/ipamExport.js:274](../server/src/routes/api/ipamExport.js#L274) |
| GET | `/tools/ipam/history` | 권한 `tools` | [server/src/routes/api/ipamExport.js:113](../server/src/routes/api/ipamExport.js#L113) |
| GET | `/tools/ipam/insights` | 권한 `tools` | [server/src/routes/api/ipamExport.js:96](../server/src/routes/api/ipamExport.js#L96) |
| DELETE | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:260](../server/src/routes/api/ipamExport.js#L260) |
| GET | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:221](../server/src/routes/api/ipamExport.js#L221) |
| PUT | `/tools/ipam/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:233](../server/src/routes/api/ipamExport.js#L233) |
| GET | `/tools/ipam/manage-meta` | 권한 `tools` | [server/src/routes/api/ipamExport.js:209](../server/src/routes/api/ipamExport.js#L209) |
| GET | `/tools/ipam/netmap` | 권한 `tools` | [server/src/routes/api/ipamExport.js:148](../server/src/routes/api/ipamExport.js#L148) |
| GET | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:296](../server/src/routes/api/ipamExport.js#L296) |
| POST | `/tools/ipam/policies` | 권한 `tools` | [server/src/routes/api/ipamExport.js:327](../server/src/routes/api/ipamExport.js#L327) |
| DELETE | `/tools/ipam/policies/:id` | 권한 `tools` | [server/src/routes/api/ipamExport.js:371](../server/src/routes/api/ipamExport.js#L371) |
| PUT | `/tools/ipam/policies/:id` | 권한 `tools` | [server/src/routes/api/ipamExport.js:344](../server/src/routes/api/ipamExport.js#L344) |
| GET | `/tools/ipam/policies/ip/:ip` | 권한 `tools` | [server/src/routes/api/ipamExport.js:305](../server/src/routes/api/ipamExport.js#L305) |
| GET | `/tools/ipam/policies/preview` | 권한 `tools` | [server/src/routes/api/ipamExport.js:322](../server/src/routes/api/ipamExport.js#L322) |
| GET | `/tools/ipam/scan-report.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:157](../server/src/routes/api/ipamExport.js#L157) |
| GET | `/tools/ipam/sheet` | 권한 `tools` | [server/src/routes/api/ipamExport.js:106](../server/src/routes/api/ipamExport.js#L106) |
| GET | `/tools/ipam/subnets` | 권한 `tools` | [server/src/routes/api/ipamExport.js:102](../server/src/routes/api/ipamExport.js#L102) |
| GET | `/tools/ipam/vc-ranges` | 권한 `tools` | [server/src/routes/api/ipamExport.js:121](../server/src/routes/api/ipamExport.js#L121) |
| GET | `/tools/ipam/vc-ranges.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:136](../server/src/routes/api/ipamExport.js#L136) |
| GET | `/tools/license-expiry` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:123](../server/src/routes/api/toolsInfo.js#L123) |
| GET | `/tools/licenses` | 권한 `tools` | [server/src/routes/api/toolsInfo.js:97](../server/src/routes/api/toolsInfo.js#L97) |
| GET | `/tools/link-check` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:56](../server/src/routes/api/linkCheck.js#L56) |
| GET | `/tools/link-check/daily` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:181](../server/src/routes/api/linkCheck.js#L181) |
| GET | `/tools/link-check/event/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:166](../server/src/routes/api/linkCheck.js#L166) |
| GET | `/tools/link-check/events` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:154](../server/src/routes/api/linkCheck.js#L154) |
| POST | `/tools/link-check/run` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:191](../server/src/routes/api/linkCheck.js#L191) |
| GET | `/tools/link-check/samples` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:143](../server/src/routes/api/linkCheck.js#L143) |
| GET | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:207](../server/src/routes/api/linkCheck.js#L207) |
| PUT | `/tools/link-check/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:272](../server/src/routes/api/linkCheck.js#L272) |
| GET | `/tools/link-check/targets` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/linkCheck.js:220](../server/src/routes/api/linkCheck.js#L220) |
| GET | `/tools/network-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:66](../server/src/routes/api/checksLogs.js#L66) |
| GET | `/tools/orphan-vmdk` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1506](../server/src/routes/api/toolsCapacity.js#L1506) |
| GET | `/tools/orphan-vmdk/datastores` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1470](../server/src/routes/api/toolsCapacity.js#L1470) |
| GET | `/tools/part-faults` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:129](../server/src/routes/api/partFaults.js#L129) |
| POST | `/tools/part-faults/close` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:198](../server/src/routes/api/partFaults.js#L198) |
| GET | `/tools/part-faults/events` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:153](../server/src/routes/api/partFaults.js#L153) |
| GET | `/tools/part-faults/reset` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:213](../server/src/routes/api/partFaults.js#L213) |
| POST | `/tools/part-faults/scan` | 역할 `admin/operator` · 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:167](../server/src/routes/api/partFaults.js#L167) |
| PUT | `/tools/part-faults/settings` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:185](../server/src/routes/api/partFaults.js#L185) |
| GET | `/tools/part-faults/status` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/partFaults.js:175](../server/src/routes/api/partFaults.js#L175) |
| GET | `/tools/pdu` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:52](../server/src/routes/api/pdu.js#L52) |
| GET | `/tools/pdu/:id` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:95](../server/src/routes/api/pdu.js#L95) |
| POST | `/tools/pdu/collect-all` | 역할 `admin` | [server/src/routes/api/pdu.js:242](../server/src/routes/api/pdu.js#L242) |
| GET | `/tools/pdu/csv/export` | 역할 `admin` | [server/src/routes/api/pdu.js:130](../server/src/routes/api/pdu.js#L130) |
| POST | `/tools/pdu/csv/import` | 역할 `admin` | [server/src/routes/api/pdu.js:162](../server/src/routes/api/pdu.js#L162) |
| GET | `/tools/pdu/csv/sample` | 역할 `admin` | [server/src/routes/api/pdu.js:156](../server/src/routes/api/pdu.js#L156) |
| GET | `/tools/pdu/db-stats` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:124](../server/src/routes/api/pdu.js#L124) |
| POST | `/tools/pdu/devices` | 역할 `admin` | [server/src/routes/api/pdu.js:209](../server/src/routes/api/pdu.js#L209) |
| DELETE | `/tools/pdu/devices/:id` | 역할 `admin` | [server/src/routes/api/pdu.js:215](../server/src/routes/api/pdu.js#L215) |
| POST | `/tools/pdu/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/pdu.js:225](../server/src/routes/api/pdu.js#L225) |
| POST | `/tools/pdu/intervals` | 역할 `admin` | [server/src/routes/api/pdu.js:203](../server/src/routes/api/pdu.js#L203) |
| GET | `/tools/pdu/series/env` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:113](../server/src/routes/api/pdu.js#L113) |
| GET | `/tools/pdu/series/power` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/pdu.js:102](../server/src/routes/api/pdu.js#L102) |
| POST | `/tools/pdu/test` | 역할 `admin` | [server/src/routes/api/pdu.js:186](../server/src/routes/api/pdu.js#L186) |
| POST | `/tools/pdu/thresholds` | 역할 `admin` | [server/src/routes/api/pdu.js:89](../server/src/routes/api/pdu.js#L89) |
| GET | `/tools/portal-check/inventory` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:281](../server/src/routes/api/portalCheck.js#L281) |
| GET | `/tools/portal-check/tokens` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:168](../server/src/routes/api/portalCheck.js#L168) |
| POST | `/tools/portal-check/tokens/edge-pull` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:233](../server/src/routes/api/portalCheck.js#L233) |
| POST | `/tools/portal-check/tokens/probe` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/portalCheck.js:201](../server/src/routes/api/portalCheck.js#L201) |
| GET | `/tools/relaycheck` | 권한 `tools` | [server/src/routes/api/relaycheck.js:14](../server/src/routes/api/relaycheck.js#L14) |
| POST | `/tools/relaycheck/run` | 역할 `admin` | [server/src/routes/api/relaycheck.js:31](../server/src/routes/api/relaycheck.js#L31) |
| PUT | `/tools/relaycheck/settings` | 역할 `admin` | [server/src/routes/api/relaycheck.js:24](../server/src/routes/api/relaycheck.js#L24) |
| GET | `/tools/relaytopo` | 권한 `tools` | [server/src/routes/api/relaytopo.js:30](../server/src/routes/api/relaytopo.js#L30) |
| PUT | `/tools/relaytopo` | 역할 `admin` | [server/src/routes/api/relaytopo.js:48](../server/src/routes/api/relaytopo.js#L48) |
| POST | `/tools/relaytopo/apply/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:104](../server/src/routes/api/relaytopo.js#L104) |
| GET | `/tools/relaytopo/export` | 역할 `admin` | [server/src/routes/api/relaytopo.js:75](../server/src/routes/api/relaytopo.js#L75) |
| POST | `/tools/relaytopo/fetch` | 역할 `admin` | [server/src/routes/api/relaytopo.js:95](../server/src/routes/api/relaytopo.js#L95) |
| POST | `/tools/relaytopo/fetch/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:99](../server/src/routes/api/relaytopo.js#L99) |
| POST | `/tools/relaytopo/import` | 역할 `admin` | [server/src/routes/api/relaytopo.js:57](../server/src/routes/api/relaytopo.js#L57) |
| GET | `/tools/relaytopo/render/:dc` | 역할 `admin` | [server/src/routes/api/relaytopo.js:88](../server/src/routes/api/relaytopo.js#L88) |
| POST | `/tools/relaytopo/test-ssh` | 역할 `admin` | [server/src/routes/api/relaytopo.js:113](../server/src/routes/api/relaytopo.js#L113) |
| GET | `/tools/report/alerts` | 권한 `tools` | [server/src/routes/api/reports.js:100](../server/src/routes/api/reports.js#L100) |
| GET | `/tools/report/capacity` | 권한 `tools` | [server/src/routes/api/reports.js:93](../server/src/routes/api/reports.js#L93) |
| GET | `/tools/report/certs` | 권한 `tools` | [server/src/routes/api/reports.js:74](../server/src/routes/api/reports.js#L74) |
| GET | `/tools/report/changes` | 권한 `tools` | [server/src/routes/api/reports.js:123](../server/src/routes/api/reports.js#L123) |
| GET | `/tools/report/compliance` | 권한 `tools` | [server/src/routes/api/reports.js:116](../server/src/routes/api/reports.js#L116) |
| GET | `/tools/report/health` | 권한 `tools` | [server/src/routes/api/reports.js:34](../server/src/routes/api/reports.js#L34) |
| GET | `/tools/report/rightsizing` | 권한 `tools` | [server/src/routes/api/reports.js:79](../server/src/routes/api/reports.js#L79) |
| GET | `/tools/report/snapshot-age` | 권한 `tools` | [server/src/routes/api/reports.js:44](../server/src/routes/api/reports.js#L44) |
| GET | `/tools/report/unprotected` | 권한 `tools` | [server/src/routes/api/reports.js:152](../server/src/routes/api/reports.js#L152) |
| GET | `/tools/report/zombies` | 권한 `tools` | [server/src/routes/api/reports.js:68](../server/src/routes/api/reports.js#L68) |
| GET | `/tools/rightsize` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:939](../server/src/routes/api/toolsCapacity.js#L939) |
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
| GET | `/tools/sanswitch` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:94](../server/src/routes/api/sanSwitch.js#L94) |
| GET | `/tools/sanswitch/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:665](../server/src/routes/api/sanSwitch.js#L665) |
| POST | `/tools/sanswitch/collect-all` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:685](../server/src/routes/api/sanSwitch.js#L685) |
| POST | `/tools/sanswitch/devices` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:192](../server/src/routes/api/sanSwitch.js#L192) |
| DELETE | `/tools/sanswitch/devices/:id` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:200](../server/src/routes/api/sanSwitch.js#L200) |
| POST | `/tools/sanswitch/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:249](../server/src/routes/api/sanSwitch.js#L249) |
| DELETE | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:473](../server/src/routes/api/sanSwitch.js#L473) |
| POST | `/tools/sanswitch/devices/:id/err-baseline` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:461](../server/src/routes/api/sanSwitch.js#L461) |
| GET | `/tools/sanswitch/devices/:id/healthcheck` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:382](../server/src/routes/api/sanSwitch.js#L382) |
| GET | `/tools/sanswitch/devices/:id/healthcheck/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:416](../server/src/routes/api/sanSwitch.js#L416) |
| GET | `/tools/sanswitch/devices/:id/perf` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:527](../server/src/routes/api/sanSwitch.js#L527) |
| GET | `/tools/sanswitch/devices/:id/perf/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:537](../server/src/routes/api/sanSwitch.js#L537) |
| GET | `/tools/sanswitch/devices/:id/ports` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:118](../server/src/routes/api/sanSwitch.js#L118) |
| GET | `/tools/sanswitch/devices/:id/zoning` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:144](../server/src/routes/api/sanSwitch.js#L144) |
| GET | `/tools/sanswitch/devices/export.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:754](../server/src/routes/api/sanSwitch.js#L754) |
| GET | `/tools/sanswitch/devices/export.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:762](../server/src/routes/api/sanSwitch.js#L762) |
| POST | `/tools/sanswitch/devices/import` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:845](../server/src/routes/api/sanSwitch.js#L845) |
| POST | `/tools/sanswitch/devices/import/test` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:790](../server/src/routes/api/sanSwitch.js#L790) |
| GET | `/tools/sanswitch/devices/import/test/:id` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:833](../server/src/routes/api/sanSwitch.js#L833) |
| GET | `/tools/sanswitch/devices/sample.csv` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:770](../server/src/routes/api/sanSwitch.js#L770) |
| GET | `/tools/sanswitch/devices/sample.txt` | 역할 `admin` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:776](../server/src/routes/api/sanSwitch.js#L776) |
| GET | `/tools/sanswitch/healthcheck-all` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:427](../server/src/routes/api/sanSwitch.js#L427) |
| GET | `/tools/sanswitch/perf/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:484](../server/src/routes/api/sanSwitch.js#L484) |
| POST | `/tools/sanswitch/perf/collect` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:312](../server/src/routes/api/sanSwitch.js#L312) |
| POST | `/tools/sanswitch/perf/prune` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:295](../server/src/routes/api/sanSwitch.js#L295) |
| GET | `/tools/sanswitch/perf/settings` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:272](../server/src/routes/api/sanSwitch.js#L272) |
| PUT | `/tools/sanswitch/perf/settings` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:280](../server/src/routes/api/sanSwitch.js#L280) |
| GET | `/tools/sanswitch/perf/storage-summary` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/sanSwitch.js:554](../server/src/routes/api/sanSwitch.js#L554) |
| POST | `/tools/sanswitch/poll` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:705](../server/src/routes/api/sanSwitch.js#L705) |
| POST | `/tools/sanswitch/test` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:216](../server/src/routes/api/sanSwitch.js#L216) |
| GET | `/tools/sanswitch/test/:runId` | 역할 `admin` | [server/src/routes/api/sanSwitch.js:238](../server/src/routes/api/sanSwitch.js#L238) |
| GET | `/tools/secret-scan` | 역할 `admin` | [server/src/routes/api/toolsInfo.js:22](../server/src/routes/api/toolsInfo.js#L22) |
| GET | `/tools/serial-lookup` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:38](../server/src/routes/api/serialLookup.js#L38) |
| GET | `/tools/serial-lookup/export.csv` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/serialLookup.js:61](../server/src/routes/api/serialLookup.js#L61) |
| GET | `/tools/service-check` | 권한 `tools` | [server/src/routes/api/checksLogs.js:60](../server/src/routes/api/checksLogs.js#L60) |
| GET | `/tools/snapshots` | 권한 `tools` | [server/src/routes/api/vcTools.js:146](../server/src/routes/api/vcTools.js#L146) |
| GET | `/tools/solutions` | 권한 `tools` | [server/src/routes/api/vcTools.js:59](../server/src/routes/api/vcTools.js#L59) |
| GET | `/tools/storage` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:46](../server/src/routes/api/storageMon.js#L46) |
| GET | `/tools/storage-growth` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:528](../server/src/routes/api/storageMon.js#L528) |
| GET | `/tools/storage-growth/:id/daily` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:588](../server/src/routes/api/storageMon.js#L588) |
| GET | `/tools/storage-growth/settings` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:600](../server/src/routes/api/storageMon.js#L600) |
| POST | `/tools/storage-growth/settings` | 역할 `admin` · `requireSettingsOwner` | [server/src/routes/api/storageMon.js:608](../server/src/routes/api/storageMon.js#L608) |
| GET | `/tools/storage/activity` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:159](../server/src/routes/api/storageMon.js#L159) |
| POST | `/tools/storage/collect-all` | 역할 `admin` | [server/src/routes/api/storageMon.js:168](../server/src/routes/api/storageMon.js#L168) |
| POST | `/tools/storage/devices` | 역할 `admin` | [server/src/routes/api/storageMon.js:137](../server/src/routes/api/storageMon.js#L137) |
| DELETE | `/tools/storage/devices/:id` | 역할 `admin` | [server/src/routes/api/storageMon.js:147](../server/src/routes/api/storageMon.js#L147) |
| GET | `/tools/storage/devices/:id/areas` | 역할 `admin` | [server/src/routes/api/storageMon.js:466](../server/src/routes/api/storageMon.js#L466) |
| GET | `/tools/storage/devices/:id/areas/json` | 역할 `admin` | [server/src/routes/api/storageMon.js:471](../server/src/routes/api/storageMon.js#L471) |
| POST | `/tools/storage/devices/:id/collect` | 역할 `admin` | [server/src/routes/api/storageMon.js:185](../server/src/routes/api/storageMon.js#L185) |
| GET | `/tools/storage/devices/:id/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:506](../server/src/routes/api/storageMon.js#L506) |
| GET | `/tools/storage/devices/export.csv` | 역할 `admin` | [server/src/routes/api/storageMon.js:272](../server/src/routes/api/storageMon.js#L272) |
| GET | `/tools/storage/devices/export.txt` | 역할 `admin` | [server/src/routes/api/storageMon.js:296](../server/src/routes/api/storageMon.js#L296) |
| POST | `/tools/storage/devices/import` | 역할 `admin` | [server/src/routes/api/storageMon.js:319](../server/src/routes/api/storageMon.js#L319) |
| POST | `/tools/storage/devices/import/test` | 역할 `admin` | [server/src/routes/api/storageMon.js:402](../server/src/routes/api/storageMon.js#L402) |
| GET | `/tools/storage/devices/import/test/:id` | 역할 `admin` | [server/src/routes/api/storageMon.js:459](../server/src/routes/api/storageMon.js#L459) |
| GET | `/tools/storage/devices/sample.csv` | 역할 `admin` | [server/src/routes/api/storageMon.js:287](../server/src/routes/api/storageMon.js#L287) |
| GET | `/tools/storage/devices/sample.txt` | 역할 `admin` | [server/src/routes/api/storageMon.js:304](../server/src/routes/api/storageMon.js#L304) |
| GET | `/tools/storage/history` | 권한 `tools` · `fullScopeOnly` | [server/src/routes/api/storageMon.js:619](../server/src/routes/api/storageMon.js#L619) |
| GET | `/tools/storage/intervals` | 역할 `admin` | [server/src/routes/api/storageMon.js:212](../server/src/routes/api/storageMon.js#L212) |
| PUT | `/tools/storage/intervals` | 역할 `admin` | [server/src/routes/api/storageMon.js:230](../server/src/routes/api/storageMon.js#L230) |
| POST | `/tools/storage/test` | 역할 `admin` | [server/src/routes/api/storageMon.js:85](../server/src/routes/api/storageMon.js#L85) |
| GET | `/tools/thin-vms` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:984](../server/src/routes/api/toolsCapacity.js#L984) |
| GET | `/tools/threats` | 권한 `tools` | [server/src/routes/api/toolsAnalytics.js:96](../server/src/routes/api/toolsAnalytics.js#L96) |
| GET | `/tools/vclogs` | 권한 `tools` | [server/src/routes/api/checksLogs.js:159](../server/src/routes/api/checksLogs.js#L159) |
| GET | `/tools/vclogs/export.csv` | 권한 `tools` | [server/src/routes/api/checksLogs.js:170](../server/src/routes/api/checksLogs.js#L170) |
| GET | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:147](../server/src/routes/api/checksLogs.js#L147) |
| POST | `/tools/vclogs/federate` | 권한 `tools` | [server/src/routes/api/checksLogs.js:138](../server/src/routes/api/checksLogs.js#L138) |
| GET | `/tools/vclogs/sources` | 권한 `tools` | [server/src/routes/api/checksLogs.js:122](../server/src/routes/api/checksLogs.js#L122) |
| GET | `/tools/vm-clone` | 역할 `admin` | [server/src/routes/api/vmClone.js:20](../server/src/routes/api/vmClone.js#L20) |
| GET | `/tools/vm-clone/badges` | 권한 `tools` | [server/src/routes/api/vmClone.js:67](../server/src/routes/api/vmClone.js#L67) |
| POST | `/tools/vm-clone/jobs` | 역할 `admin` | [server/src/routes/api/vmClone.js:29](../server/src/routes/api/vmClone.js#L29) |
| DELETE | `/tools/vm-clone/jobs/:id` | 역할 `admin` | [server/src/routes/api/vmClone.js:41](../server/src/routes/api/vmClone.js#L41) |
| POST | `/tools/vm-clone/jobs/:id/run` | 역할 `admin` | [server/src/routes/api/vmClone.js:52](../server/src/routes/api/vmClone.js#L52) |
| GET | `/tools/vm-export` | 권한 `tools` | [server/src/routes/api/ipamExport.js:75](../server/src/routes/api/ipamExport.js#L75) |
| GET | `/tools/vm-export.csv` | 권한 `tools` | [server/src/routes/api/ipamExport.js:84](../server/src/routes/api/ipamExport.js#L84) |
| POST | `/tools/vm-finder` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:1012](../server/src/routes/api/toolsCapacity.js#L1012) |
| GET | `/tools/vm-track` | 권한 `tools` | [server/src/routes/api/vmtrack.js:17](../server/src/routes/api/vmtrack.js#L17) |
| GET | `/tools/vm-track/changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:44](../server/src/routes/api/vmtrack.js#L44) |
| GET | `/tools/vm-track/ds-change-log` | 권한 `tools` | [server/src/routes/api/vmtrack.js:121](../server/src/routes/api/vmtrack.js#L121) |
| GET | `/tools/vm-track/ds-changes` | 권한 `tools` | [server/src/routes/api/vmtrack.js:58](../server/src/routes/api/vmtrack.js#L58) |
| GET | `/tools/vm-track/ds-list` | 권한 `tools` | [server/src/routes/api/vmtrack.js:72](../server/src/routes/api/vmtrack.js#L72) |
| GET | `/tools/vm-track/ds-pivot` | 권한 `tools` | [server/src/routes/api/vmtrack.js:138](../server/src/routes/api/vmtrack.js#L138) |
| GET | `/tools/vm-track/ds-series` | 권한 `tools` | [server/src/routes/api/vmtrack.js:84](../server/src/routes/api/vmtrack.js#L84) |
| GET | `/tools/vm-track/ds-series-all` | 권한 `tools` | [server/src/routes/api/vmtrack.js:99](../server/src/routes/api/vmtrack.js#L99) |
| GET | `/tools/vm-track/ds-top` | 권한 `tools` | [server/src/routes/api/vmtrack.js:159](../server/src/routes/api/vmtrack.js#L159) |
| POST | `/tools/vm-track/snapshot` | 역할 `admin` | [server/src/routes/api/vmtrack.js:176](../server/src/routes/api/vmtrack.js#L176) |
| DELETE | `/tools/vmseries/data` | 역할 `admin` | [server/src/routes/api/vmSeries.js:185](../server/src/routes/api/vmSeries.js#L185) |
| GET | `/tools/vmseries/local` | 권한 `tools` | [server/src/routes/api/vmSeries.js:149](../server/src/routes/api/vmSeries.js#L149) |
| POST | `/tools/vmseries/run` | 역할 `admin` | [server/src/routes/api/vmSeries.js:143](../server/src/routes/api/vmSeries.js#L143) |
| GET | `/tools/vmseries/scope-data` | 권한 `tools` | [server/src/routes/api/vmSeries.js:126](../server/src/routes/api/vmSeries.js#L126) |
| GET | `/tools/vmseries/settings` | 권한 `tools` | [server/src/routes/api/vmSeries.js:72](../server/src/routes/api/vmSeries.js#L72) |
| PUT | `/tools/vmseries/settings` | 역할 `admin` | [server/src/routes/api/vmSeries.js:90](../server/src/routes/api/vmSeries.js#L90) |
| GET | `/tools/vmseries/status` | 권한 `tools` | [server/src/routes/api/vmSeries.js:138](../server/src/routes/api/vmSeries.js#L138) |
| GET | `/tools/vmseries/top` | 권한 `tools` | [server/src/routes/api/vmSeries.js:163](../server/src/routes/api/vmSeries.js#L163) |
| GET | `/tools/vmtools` | 권한 `tools` | [server/src/routes/api/vcTools.js:123](../server/src/routes/api/vcTools.js#L123) |
| GET | `/tools/vmware-config` | 권한 `tools` | [server/src/routes/api/checksLogs.js:73](../server/src/routes/api/checksLogs.js#L73) |
| GET | `/tools/waste` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:213](../server/src/routes/api/toolsCapacity.js#L213) |
| GET | `/tools/waste/export` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:386](../server/src/routes/api/toolsCapacity.js#L386) |
| GET | `/tools/waste/history` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:567](../server/src/routes/api/toolsCapacity.js#L567) |
| GET | `/tools/waste/off-check` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:544](../server/src/routes/api/toolsCapacity.js#L544) |
| POST | `/tools/waste/off-check/run` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:552](../server/src/routes/api/toolsCapacity.js#L552) |
| PUT | `/tools/waste/off-check/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:547](../server/src/routes/api/toolsCapacity.js#L547) |
| GET | `/tools/waste/off-since` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:349](../server/src/routes/api/toolsCapacity.js#L349) |
| GET | `/tools/waste/settings` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:756](../server/src/routes/api/toolsCapacity.js#L756) |
| PUT | `/tools/waste/settings` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:777](../server/src/routes/api/toolsCapacity.js#L777) |
| DELETE | `/tools/waste/settings/data` | 역할 `admin` | [server/src/routes/api/toolsCapacity.js:813](../server/src/routes/api/toolsCapacity.js#L813) |
| POST | `/tools/waste/spark` | 권한 `tools` | [server/src/routes/api/toolsCapacity.js:845](../server/src/routes/api/toolsCapacity.js#L845) |
| GET | `/top` | — | [server/src/routes/api/inventory.js:364](../server/src/routes/api/inventory.js#L364) |
| GET | `/ui-settings` | — | [server/src/routes/api/toolsInfo.js:233](../server/src/routes/api/toolsInfo.js#L233) |
| PUT | `/ui-settings` | 역할 `admin/operator` | [server/src/routes/api/toolsInfo.js:235](../server/src/routes/api/toolsInfo.js#L235) |
| GET | `/vcenters` | — | [server/src/routes/api/vcTools.js:12](../server/src/routes/api/vcTools.js#L12) |
| GET | `/vcenters/:id/usage-history` | — | [server/src/routes/api/toolsCapacity.js:644](../server/src/routes/api/toolsCapacity.js#L644) |
| GET | `/vms` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:237](../server/src/routes/api/inventory.js#L237) |
| GET | `/vms/:id/console` | 권한 `vm.console` | [server/src/routes/api/vmMetrics.js:103](../server/src/routes/api/vmMetrics.js#L103) |
| GET | `/vms/:id/metrics` | 권한 `inv.vms` | [server/src/routes/api/vmMetrics.js:45](../server/src/routes/api/vmMetrics.js#L45) |
| GET | `/vms/lookup` | 권한 `inv.vms` | [server/src/routes/api/inventory.js:310](../server/src/routes/api/inventory.js#L310) |
| POST | `/vms/upgrade-tools` | 권한 `tools` · `auditMiddleware` | [server/src/routes/api/toolsInfo.js:189](../server/src/routes/api/toolsInfo.js#L189) |
| POST | `/vms/usage` | 권한 `inv.vms` | [server/src/routes/api/toolsCapacity.js:258](../server/src/routes/api/toolsCapacity.js#L258) |

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
| `fullScopeOnly` | 56 | **전체 범위 계정만**. vCenter 범위를 지정한 계정은 403 — 그 자원에 법인 축이 없어 교집합할 수 없기 때문이다(빈 목록을 주면 '장비 0대' 라는 거짓이 된다). |
| `requireSettingsOwner` | 33 | **설정 소유 계정**(`settings-owners.txt`·`SETTINGS_OWNERS`·중앙 배포 admin). admin 이라도 소유자가 아니면 403. 백업 아카이브·중앙 토큰 배달 등 **비밀을 다루는 경로**에 붙는다. |
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

