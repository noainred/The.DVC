# Claude Code 실행 프롬프트 — 서비스 인벤토리 (시안 A · 3차 구현)

아래를 그대로 붙여 넣는다. 저장소 루트에서 실행한다. **착수 전에 README §결정 필요 4건의 답을 받았는지 확인**하고, 없으면 기본값(독립 도구 `svc-inventory` · 법인 관리자 = `writeVcenters` · 스캔 라벨은 비어 있을 수 있음 · 전력 열 없음)으로 진행하되 보고에 전제를 적는다.

---

`docs/design/service-map/README.md` 를 끝까지 읽고 '특수 기능 › 서비스 인벤토리'(도구 키 `svc-inventory`)를 시안 A · 3차로 구현해 줘. `service-map.dc.html` 은 브라우저로 열어 결과와 대조할 디자인 레퍼런스이고(HTML 프로토타입 — 복사 대상이 아님), 하단 `<script>` 의 `autoResolve()`·`resolve()`·`agg()`·`unmappedValues()`·`renderUn()` 의 묶음 키·`applySort()` 는 그대로 옮겨도 된다. 뷰 5개와 큐 조치가 프로토타입에서 실제로 동작하니 먼저 눌러 보고 시작해 줘.

## 작업 순서

1. **읽기** — 루트 `CLAUDE.md`·`server/CLAUDE.md`·`docs/rules/{perf-db,security-api,web,edge,idrac-server,vcenter}.md` 의 해당 항목, `server/src/insights/fleetInventory.js`(classifyFleet·fleetGhostReport·prune), `insights/fleetAssign.js`(저장 규약), `svcmon/store.js`(SAFE_PATH·디바운스 저장), `corpusage/build.js`(가중 합산), `bmusage/db.js latestUsage`·`bmusage/targets.js`, `auth/addressMask.js`·`auth/demoGuest.js isAdminDetailUser`·`auth/scope.js`, `tags/parse.js`·`tags/analyze.js`·`tags/policy.js`, `idrac/registry.js`(scanRangeId)·`idrac/scanRanges.js`(라벨 저장), `partfault/db.js openFaults`, `central/fleet.js`·`agent/fleetPush.js`, `vcenter/soapClient.js`(VM 속성 목록 1843행 부근·2105행 VM 객체), `routes/api/corpUsage.js`(라우트 본보기), `web/src/views/tools/{CorpUsage,FleetInventory}.jsx`·`components/STable.jsx`·`components/primitives.jsx`(Modal)·`views/tools/shared.jsx`(Card)·`views/SvcMonConfig.jsx`(트리 본보기).
2. **수집 속성** — VM 속성에 `config.instanceUuid` 를 더하고 스냅샷 `vm.instanceUuid` 로 싣는다. 없는 VM 은 키를 `vm.id` 로 폴백하고 `keyKind` 를 밝힌다. 테스트 `vmInstanceUuid.test.js`.
3. **서버 1단계** — `src/servicemap/store.js`(service-map.json — 원자적 쓰기·`preserveCorrupt`·mtime+size 무효화·rev 해시·디바운스 배치·상한) · `tree.js`(SAFE_PATH 재사용, 파생 폴더, 빈 폴더 유지, 삭제 조건, 법인 안 이름 유일) · `resolve.js`(순수 — 폴더 최장 접두 → 스캔 라벨/별칭 → 태그(선택·unchecked) → 이름 규칙 → 없음(reason) · pin 우선 + drift · 지워진 서비스 pin 무시) · `build.js`(순수 집계 + 파생 호스트 + 역조인) · `queues.js`(미지정 묶음 · 매핑 안 된 값 · 드리프트 · 유령) · `candidates.js` · `access.js`(`corpWriteAccess` — 조회 밖 404 → 쓰기 밖 403) · `settings.js`. 테스트 6종(README §파일)을 먼저 쓰고 통과시킨다. 가중 합산은 `corpusage/build.js` 와 **같은 입력으로 같은 출력** 대조.
4. **라우트** — `routes/api/svcInventory.js`(GET 7 + CSV) · `routes/admin/svcInventory.js`(folder-rules · aliases · pins · services · folders · scan-entry-label · review · ghosts · settings). scope 교집합 먼저, `memoJson` + `extraKey: scopeKey(...)`, 법인 미지정 서버·설정은 범위 계정에 없음, 법인 불일치 409, fleet-assign 선행(실패 시 되돌림 + `partial`), 모든 쓰기 `logAudit`, 손상은 503(빈 트리 금지). `toolAccess.js`·`taskLabel.js`·`toolcats/catalog.js` PRESET 등록 — `toolCategories2455`·`v4Portal2508` 테스트가 PRESET 전수를 고정한다.
5. **엣지** — `agent/fleetPush.js` 가 베어메탈 행에 `service`(스캔 엔트리 라벨, 64자 상한)를 싣고 `central/fleet.js` 정제 화이트리스트에 넣는다. 구버전 엣지는 빈 값. `edgelog/spec.js` 등재 확인.
6. **웹** — `views/tools/SvcInventory.jsx` + `svcInventory/{Tree,Queues,AddOneModal,InlineForms,AttrCard}.jsx` + `svcInventoryText.js`(src/reason → 문장, BoldText 백틱 금지) + `views/admin/SvcInventorySettings.jsx`. 훅은 전부 조기 return 위. 표는 `STable`(`minWidth` 1040/860/620 · `(미지정)` 행 data-sort `￿`). 모달은 공용 `Modal`. KPI 는 `Card`. 주기·상한 숫자는 `meta` 값. 쓰기 권한이 없으면 버튼 잠금 + 툴팁, 403 은 `ErrorBox`. 범위 select 는 도구 패널 헤더 것을 쓴다. 그리드·플렉스 자식 `min-width:0`, 버튼 행 `flexWrap`.
7. **검증** — `npm run verify` 전량 1회(커밋 직전). Chromium 1440/400 에서 `#/tools/svc-inventory`: 오류 0 · 가로 넘침 0 · 트리 클릭 → 표·KPI·브레드크럼 · 서비스별 표 14열이 1440 에서 다 보이는지 · 속성 저장 · 미지정 묶음 연결(폴더·엔트리) → 미지정 수 감소 · 매핑 안 된 값 조치 2종 · 드리프트 되돌리기/유지 · 유령 미리보기 → 정리 · 한 대씩 모달 고정 → 드리프트 배너 · 서비스명 묶기 · 범위 계정(법인 하나)으로 로그인해 트리가 그 법인만이고 법인 미지정 노드·서버가 없는지 · 설정 저장(stale rev 거부) · 스크린샷 직접 판독. 목 서버 종료 확인.
8. **릴리스** — 기능 변경이므로 `.claude/skills/release/SKILL.md` 절차로 버전업·릴리스 게시·`versions.json` latest 확인까지.

## 지켜야 할 것

- 판정 코어는 `resolve.js` 하나. 웹에 판정을 복제하지 않는다. 후보·파생 호스트는 `classifyFleet`·스냅샷 출력을 쓰고 다시 구현하지 않는다.
- **서비스를 자동으로 만드는 코드 경로를 두지 않는다.** 규칙·별칭은 기존 서비스에만 붙는다.
- '못 읽은 값은 0 이 아니다' — null 은 합계에서 빼고 `unread`·`stale`·`noCap`·`unchecked` 로 따로 센다. 분모 0 은 null('—').
- 고정이 자동과 다르면 `drift` 로 큐에 올린다(배지만 달고 끝내지 않는다). 유령 키는 자동 삭제하지 않는다(미리보기 → 사람이 삭제).
- 새 엣지 export 필드는 중앙 정제 화이트리스트에도 넣는다. 이름은 인증된 agent 로 덮어쓴다.
- 도구 키 `svc-inventory` 는 릴리스 뒤 바꾸지 않는다. 법인 귀속 없는 데이터는 범위 계정에 노출하지 않는다. 법인을 넘는 고정은 409.
- 트리 저장 손상은 빈 트리로 시작하지 않는다(503). 폴더 경로는 svcmon SAFE_PATH 와 같은 검증. 상한 초과는 400.
- 캐시 세대 키(fleetRev · 스냅샷 at · service-map mtime · scan-ranges mtime)를 코드 주석에 적는다. 정규식 이름 규칙은 길이 상한 뒤 선형.

끝나면 변경 파일 목록, 새 API 의 요청/응답 예시 1개씩, README 와 달리 판단한 부분이 있으면 이유와 함께 알려 줘. 확인하지 못한 것은 '확인 못 함' 으로 적어 줘.
