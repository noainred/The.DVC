# Claude Code 실행 프롬프트 — 서비스 맵 (시안 A · 2차 구현)

아래를 그대로 붙여 넣는다. 저장소 루트에서 실행한다. **착수 전에 README §결정 필요 5건의 답을 받았는지 확인**하고, 없으면 기본값(카테고리 'Service' · 스캔 라벨 조인 켬 · 법인 관리자 = `writeVcenters` · 수동 지정 1순위 + conflict 배지 · 열 순서 그대로)으로 진행하되 보고에 전제를 적는다.

---

`docs/design/service-map/README.md` 를 끝까지 읽고 '특수 기능 › 서비스 맵'(도구 키 `service-map`)을 시안 A · 2차로 구현해 줘. `service-map.dc.html` 은 브라우저로 열어 결과와 대조할 디자인 레퍼런스이고(HTML 프로토타입 — 복사 대상이 아님), 하단 `<script>` 의 `agg()`·`groupSvc()`·`buildTree()`·`mCandidates()`·`applySort()` 수식은 그대로 옮겨도 된다. 트리·모달·인라인 폼은 프로토타입에서 실제로 동작하니 먼저 눌러 보고 시작해 줘.

## 작업 순서

1. **읽기** — 루트 `CLAUDE.md`·`server/CLAUDE.md`·`docs/rules/{perf-db,security-api,web,edge,idrac-server,vcenter}.md` 의 해당 항목, `server/src/insights/fleetInventory.js`(classifyFleet·getFleetInventory), `insights/fleetAssign.js`(저장 규약), `svcmon/store.js`(폴더 경로 규약·SAFE_PATH·디바운스 저장), `corpusage/build.js`(가중 합산), `bmusage/db.js latestUsage`·`bmusage/targets.js`(idOf·maskIdentityFields 사용법), `auth/addressMask.js`, `auth/demoGuest.js isAdminDetailUser`, `auth/scope.js writeScopedVcenterIds·inUserWriteScope`, `tags/parse.js`·`tags/analyze.js`·`tags/policy.js`, `idrac/registry.js`(scanRangeId)·`idrac/scanRanges.js`, `partfault/db.js openFaults`, `central/fleet.js`·`agent/fleetPush.js`, `routes/api/corpUsage.js`(라우트 본보기), `web/src/views/tools/{CorpUsage,FleetInventory}.jsx`·`components/STable.jsx`·`components/primitives.jsx`(Modal)·`views/tools/shared.jsx`(Card)·`views/SvcMonConfig.jsx`(트리 화면 본보기).
2. **서버 1단계** — `src/servicemap/store.js`(service-map.json — 원자적 쓰기·`preserveCorrupt`·mtime+size 무효화·rev 해시·디바운스 배치·상한) · `tree.js`(경로 검증 = svcmon SAFE_PATH 재사용, 파생 폴더, 빈 폴더 유지, 삭제 조건, 법인 안 이름 유일) · `resolve.js`(순수 판정 5단 — 수동 > 태그 > 스캔 > 규칙 > 미지정, conflict·unchecked·자동 생성 루트) · `build.js`(순수 집계 — 폴더 합 = 서비스 합) · `candidates.js`(classifyFleet 출력 그대로 · 비관리자 가림 · 범위) · `access.js`(`corpWriteAccess` — 조회 밖 404 → 쓰기 밖 403 한 함수) · `settings.js`(serviceCategory). 테스트 5종(README §파일)을 먼저 쓰고 통과시킨다. 가중 합산은 `corpusage/build.js` 와 **같은 입력으로 같은 출력**을 내는 대조 테스트를 둔다. 후보 집합은 `classifyFleet` 출력과 같은 집합인지 대조한다.
3. **라우트** — `routes/api/serviceMap.js`(GET 3 + CSV) · `routes/admin/serviceMap.js`(members PUT · folders POST/DELETE · services POST/PATCH/DELETE · settings GET/PUT). scope 교집합을 요청 필터보다 먼저, `memoJson` + `extraKey: scopeKey(...)`, 법인 미지정 서버·설정은 범위 계정에 없음, 쓰기는 `corpWriteAccess`, 법인 불일치 409, 법인 귀속 없는 서버는 fleet-assign 선행(실패 시 되돌림 + `partial`), 모든 쓰기 `logAudit`. 등록부 손상은 503(빈 트리 금지). `toolAccess.js`·`taskLabel.js`·`toolcats/catalog.js` PRESET(서버·가상화·리포트) 등록 — `toolCategories2455`·`v4Portal2508` 테스트가 PRESET 전수를 고정한다.
4. **엣지** — `agent/fleetPush.js` 가 베어메탈 행에 `service`(스캔 엔트리 라벨, 64자 상한)를 싣고 `central/fleet.js` 정제 화이트리스트에 같은 필드를 넣는다. 구버전 엣지(필드 없음)는 빈 값. `edgelog/spec.js` 등재 여부 확인.
5. **웹** — `views/tools/ServiceMap.jsx` + `serviceMap/{Tree,AddServersModal,InlineForms}.jsx` + `serviceMapText.js`(src/reason → 문장, BoldText 백틱 금지) + `views/admin/ServiceMapSettings.jsx`. 훅은 전부 조기 return 위. 표는 `STable`(`minWidth` 1040/1100 · `(미지정)` 행 data-sort `￿` 로 항상 뒤). 모달은 공용 `Modal`. KPI 는 `Card`. 주기·상한 숫자는 `meta` 값. 쓰기 권한이 없으면 버튼 잠금 + 툴팁, 403 은 `ErrorBox`. 범위 select 는 도구 패널 헤더 것을 쓴다(두 번 그리지 않는다). 그리드·플렉스 자식 `min-width:0`, 버튼 행 `flexWrap`.
6. **검증** — `npm run verify` 전량 1회(커밋 직전). Chromium 1440/400 에서 `#/tools/service-map`: 오류 0 · 가로 넘침 0 · 트리 클릭(법인/폴더/서비스/미지정) → 표·KPI·브레드크럼 갱신 · 서버 추가 모달(필터·전부 선택은 현재 필터만·대상 서비스·추가 → 구성원 갱신 + 배너) · ＋폴더(3단)·＋서비스(이름 중복 거부)·이동 · 헤더 정렬(미지정 행 뒤 고정) · 소속 규칙 탭 수동 지정 select · 범위 계정(법인 하나)으로 로그인해 트리가 그 법인만이고 법인 미지정 노드가 없는지 · 설정 저장(stale rev 거부) · 스크린샷 직접 판독. 목 서버 종료 확인.
7. **릴리스** — 기능 변경이므로 `.claude/skills/release/SKILL.md` 절차로 버전업·릴리스 게시·`versions.json` latest 확인까지.

## 지켜야 할 것

- 판정 코어는 `resolve.js` 하나. 웹에 판정을 복제하지 않는다. 후보 집합은 `classifyFleet` 을 다시 구현하지 않고 그 출력을 쓴다.
- '못 읽은 값은 0 이 아니다' — null 은 합계에서 빼고 `unread`·`stale`·`noCap`·`unchecked` 로 따로 센다. 분모 0 은 null('—').
- 태그를 못 읽은 vCenter 의 구성원은 `unchecked` 이지 `none`(미지정)이 아니다. 수동 지정이 태그를 이길 때는 `conflict` 로 밝힌다(조용히 이기지 않는다).
- 새 엣지 export 필드는 중앙 정제 화이트리스트에도 넣는다. 이름은 인증된 agent 로 덮어쓴다.
- 도구 키 `service-map` 은 릴리스 뒤 바꾸지 않는다(권한 파일·서버 매핑).
- 법인 귀속 없는 데이터(서버·미지정 노드)는 범위 계정에 노출하지 않는다. 쓰기는 '조회 밖 404 → 쓰기 밖 403' 순서의 한 함수. 법인을 넘는 지정은 409.
- 트리 저장 손상은 빈 트리로 시작하지 않는다(503). 폴더 경로는 svcmon SAFE_PATH 와 같은 검증. 상한 초과는 클램프하지 않고 400.
- 보류·캐시에는 시한. 캐시 세대 키(fleetRev · 스냅샷 at · service-map mtime)를 코드 주석에 적는다.
- 정규식 이름 규칙은 길이 상한 뒤 선형 — 중첩 수량자 패턴은 저장 거부.

끝나면 변경 파일 목록, 새 API 의 요청/응답 예시 1개씩, README 와 달리 판단한 부분이 있으면 이유와 함께 알려 줘. 확인하지 못한 것은 '확인 못 함' 으로 적어 줘.
