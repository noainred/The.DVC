# 아키텍처 점검(특수 기능 › 포탈 점검) — 판정 계약 (v2.614)

이 문서는 서버 `portalcheck/archScan.js`(판정)와 웹 `views/tools/archCheckText.js`(문구)가 공유하는 계약이다. 표의 코드 집합은 양쪽 테스트가 이 파일과 대조한다 — 코드를 더하면 세 곳(서버 ARCH_CODES · 웹 ARCH_TEXT · 이 표)을 같이 고친다.

## 라우트(서버 그룹 S1 소유)
- `GET  /api/tools/portal-check/arch`      — 게이트 `adminOnly + fullScopeOnlyWith(...)` (routes/api/portalCheck.js 의 형제 라우트와 같은 모양). `memoJson` 30초.
- `POST /api/tools/portal-check/arch/run`  — 같은 게이트, 캐시 무시하고 즉시 재판정. 응답 모양 동일.
- 왕복 0(장비·엣지에 나가지 않는다). 폴링 금지(웹은 마운트 1회 + 버튼).

## 응답 모양
```
{ ok:true, at:<epoch ms>, version:<서버 버전>, tookMs,
  kpi:{ total, ok, warn, fault, unknown },              // 항등식 total = ok+warn+fault+unknown (항목 수 기준)
  items:[ { code, state:'ok'|'warn'|'fault'|'unknown', count, samples:[string ≤20], omitted, detail:{...선택} } ],
  catalog:{ source:'dist'|'missing', count, generatedAt|null, path(admin 전체범위만) },
  inputs:{ errors:[{ code, message }] }                  // 입력을 못 읽은 것 — 그 항목은 unknown
}
```
- `samples` 는 사람이 읽는 짧은 식별자(경로·키·파일명). 절대 경로는 admin 전체범위 계정에만(다른 계정은 basename) — `scopeFilePaths` 규약.
- 응답에 토큰·비밀번호·URL 쿼리 0.

## 점검 항목 코드(서버 `portalcheck/archScan.js ARCH_CODES` == 웹 `archCheckText.js ARCH_TEXT` 키 — 테스트가 1:1 대조)
| code | 뜻 | state 규칙 |
|---|---|---|
| route-gate-missing | `/api/admin/*`·`/api/tools/*` 라우트 중 `.gate` 태그로 보아 admin 이면서 fullScope/fleet 계열 게이트가 없는 상태 변경(POST/PUT/PATCH/DELETE) 라우트 | 0 → ok · >0 → warn (허용 목록 `ROUTE_GATE_ALLOW` 에 사유와 함께 적힌 것은 제외) |
| asyncroute-unwrapped | 라우터 스택에 `__asyncWrapped` 가 아닌 async 핸들러가 있는 라우트 | 0 → ok · >0 → fault |
| tool-segment-unmapped | `/api/tools/<seg>` 의 seg 가 `TOOL_PATH_KEYS`·`TOOL_PATH2_KEYS`·`UNMAPPED_TOOL_SEGMENTS` 어디에도 없음 | 0 → ok · >0 → fault |
| catalog-missing | `web/dist/special-tools.json` 을 못 읽음 | 못 읽으면 unknown(카탈로그 의존 항목 전부 unknown) |
| catalog-key-orphan | permissions.json 의 toolsDenied/allowed 값·toolcats 배치·TOOL_PATH_KEYS 값 중 카탈로그에 없는 키 | 0 → ok · >0 → warn |
| catalog-adminonly-mismatch | 도구 주 라우트(`/api/tools/<seg>` GET)가 역할 admin 인데 카탈로그 adminOnly 가 아님(한 방향만 — 반대는 v2.555 표시 관례라 `detail.displayOnly` 로 개수만) | 0 → ok · >0 → warn |
| edgelog-spec-drift | STATUS_SPEC 항목의 모듈·함수가 실제로 없음(또는 export 되지 않음) | 0 → ok · >0 → fault |
| bigjson-missing | centralRouter·collectorRouter 의 POST 경로 중 BIG_JSON 미등록이며 허용 목록(`BIG_JSON_SMALL`, 사유) 밖 | 0 → ok · >0 → warn |
| dataflow-cats-unmapped | `dataflow/build.js declaredRoutes()` 의 `unmapped` | 0 → ok · >0 → warn |
| db-file-mode | `config.dbDir` 의 *.db(-wal/-shm 포함) 중 0600 이 아닌 파일 | 0 → ok · >0 → warn |
| db-not-migratable | dbDir 의 *.db 중 `insights/dbLocation.js MIGRATABLE` 에 없는 파일 | 0 → ok · >0 → warn |
| db-no-purpose | MIGRATABLE·RUNTIME_STATE_NAMES 중 `portalDb PURPOSES` 에 설명 없음 | 0 → ok · >0 → warn |
| config-file-unclassified | CONFIG_DIR 의 *.json/*.env/*.txt 중 설정(SECRET_FILES∪CONFIG-FILES 카탈로그)·상태(isRuntimeStateFile)·비밀 어느 분류에도 없는 파일 | 0 → ok · >0 → warn |
| import-cycle | server/src 정적 import 그래프의 순환 SCC 수 > 상한 4(`arch2579` 와 같은 계산) | ≤4 → ok · >4 → warn |
| util-imports-domain | util/ 모듈이 도메인 디렉터리를 import(허용 목록 `UTIL_ALLOW` 제외) | 0 → ok · >0 → warn |

## 게이트 태그(S1)
- `requireRole(...)` → `fn.gate={kind:'role',arg:roles}` · `requirePerm(...)` → `{kind:'perm',arg:keys}` · `fullScopeOnlyWith(reason)` → `{kind:'fullScope'}` · `requireSettingsOwner.gate={kind:'settingsOwner'}` · `toolGate(...)` 반환 → `{kind:'tool'}` · `requireCentral(...)` → `{kind:'central'}` · `fleetOnly` 류는 `fullScopeOnlyWith` 의 산물이므로 자동.
- `util/asyncRoute.js asyncRoute()` 는 `wrapped.gate = handler.gate`(있을 때) — 테스트가 고정.
- 마운트 수준 게이트(index.js `app.use('/api/insights', …, requirePerm('insights'), …)`)는 `archScan.setApp(app)` 주입으로 읽는다(index.js 가 라우터 마운트 뒤 1회 호출).

## 카탈로그 내보내기(그룹 S2)
- `scripts/tools-catalog.mjs`: `web/src/views/specialToolsList.js` 를 ESM import → `web/public/special-tools.json` `{ generatedAt, count, tools:[{k, adminOnly, perm, external, topTab, comingSoon}] }`. `--check` 는 낡으면 exit 1(`generatedAt` 은 비교에서 제외).
- `web/package.json` `"prebuild": "node ../scripts/tools-catalog.mjs"` (vite 가 public/ 을 dist/ 로 복사). `.github/workflows/ci.yml` 에 `--check` 스텝(api-doc 과 같은 관례, continue-on-error).
- 서버 `portalcheck/toolCatalog.js readToolCatalog()` → `{ source:'dist'|'missing', tools, count, generatedAt, path }` — `config.webDist` 의 `special-tools.json`. 없으면 추측하지 않는다.
- 서버 테스트는 `web/src/views/specialToolsList.js` 를 ESM import 해 생성물과 대조(정규식 금지).

## 웹(그룹 W)
- `PortalCheck.jsx` VIEWS 에 `['arch','아키텍처 점검']` 추가(3번째). `ArchCheckView.jsx` — KPI 5칸(합계·정상·경고·결함·확인 불가, 항등식) · 배너(카탈로그 missing 이면 '카탈로그를 읽지 못해 N개 항목은 확인 불가' — 초록 금지) · 항목 표 `STable minWidth` (코드·상태·개수·표본·조치) · '지금 점검' 버튼(POST run) · 마운트 1회 fetch · 늦은 응답 버림.
- `archCheckText.js ARCH_TEXT[code] = { title, meaning, fix }` (백틱 금지 · BoldText) + `kpiOf(items)` + `catalogNote(catalog)` + `stateTone`. vitest: 코드 키 == 서버 ARCH_CODES(서버 파일을 fs 로 읽어 대조), 항등식, 백틱 0.
- `specialToolsList.js` portal-check desc/aka 에 '아키텍처 점검' 추가.
