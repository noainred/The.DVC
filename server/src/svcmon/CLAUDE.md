# Monitoring(성능점검 `svcmon/`) — 설정 연동 · 개요 기술 뷰 · 실패 알림 불변조건 (v2.915)

> 설계·시안 `docs/design/monitoring-autoreg/README.md`(사용자 선택: ①설정 연동 + ⑦개요 기술 뷰 + 패싯 · 실패 알림 포함 · 검증 표준). 회귀 `server/test/svcmonSettingsSync2915.test.js`.

- **열거기는 하나** — 설정 연동은 통신 점검 카탈로그(`linkcheck/settingsLinks.js buildSettingsTargets`)만 읽는다. 새 등록부를 Monitoring 에 보이려면 **카탈로그에** 더한다
  (`settingsKinds.js` 종류 + `SETTINGS_PATHS` + `remedy.js HOST_FORM` + 로더 + `settingsSync.js SOURCE_OF_KIND` — 테스트가 로더 이름을 대조한다). 로더는 비밀 제거본만(`publicSettings`·`listX` redact).
- **출처(origin)는 서버만 발급** — `store.cleanTarget` 은 `data.origin` 을 읽지 않는다. 설정 연동만 `opts.origin`(updateTarget) · `trustedOrigin`(bulkAddTargets) 로 싣는다.
  수정 경로는 **승계**(손으로 고친 호스트가 다음 감지에서 '주소 변경' 으로 다시 뜬다 — 설정이 진실). CSV 열에 넣지 않는다(`batch` 와 같은 이유). 키를 늘리면 `cleanOrigin` 하나만 고친다.
- **판정**: 새 항목 · 연동 · 주소/포트 변경 · 사라짐 · **보류**(출처 등록부 sourceErrors — 사라짐으로 단정하지 않는다) · 제외(`EXCLUDED_KINDS` — 웹훅 URL 은 비밀) · 설정 문제(SSRF 차단 포함).
  등록부가 손상되면 모듈이 빈 목록을 주므로 로더가 `registryLoadError` 류를 따로 본다(아래 게이트 절). 사라짐은 기본 **중지**(삭제 아님).
- **점검은 무인증뿐**(`checksFor`) — identity 종류만 HTTP 200 고정, 나머지 HTTP 는 기대코드를 비워 500 미만 정상(401/403 = 살아 있음). `insecure:true`(신뢰는 cert 점검이 아니라 만료만).
  재동기화는 `tpl:'settings'` + `tplKey` 로 **test.id 를 승계**한다(연속 횟수·만기 리셋 금지). 사람이 더한 점검은 건드리지 않는다.
- **배정 동기화는 byAgent 배정이거나 배정이 없는 엣지만** — 경로 기준 배정을 byAgent 로 바꾸면 그 엣지의 경로 대상이 통째로 빠진다(파괴적). 건너뜀으로 보고한다.
- **자동 등록 기본 끔** · 켜도 한 번도 연동된 적 없는 키(`known`)만 · 언제나 중지 상태 · 배정 동기화 없음. 감지(5분)는 카탈로그 **읽기만** · 엣지 노드(CENTRAL_URL)는 돌지 않고 라우트는 409.
- **배너의 '새 항목' 은 기준점(첫 감지 · 마지막 확인) 이후 생긴 것만**(`driftSummary` — Chromium 실측: 미등록 258건을 '설정이 바뀌었습니다' 로 띄웠다). 미등록 전체는 `unregistered`.
- **상태 파일** `svcmon-settings-sync.json`(옵션 · known · seen · 일별 요약)은 감지가 쓰므로 `backup/service.js CHANGE_WATCH_EXCLUDE`(번들에는 들어간다). `svcmon-alert.json` 은 `alertSettings.js` 하나만 쓴다
  (`transitions.js` 는 파일을 쓰지 않는다 — ARCH-4·MIXED_STATE 스윕).
- **게이트**: `/settings-sync/*` 는 조회도 **adminOnly + fullScopeOnly**(통신 점검 목록과 같다 — 반증 H1: canEdit 판본은 operator 에게 봉인 비밀 웹훅 URL·통합 계정 매핑을 줬다) ·
  행은 `safeAddress`(사용자 정보·쿼리 제거 · 제외 종류는 주소 없음)로 자른다 · `/overview` 는 `/state` 와 같은 조회 기준(엣지 sourceIp 없음) · `/alert-settings` 저장은 adminOnly + fullScopeOnly.
  등록된 대상의 이름·호스트·출처는 `/state` 로 범위 계정도 본다(svcmon 조회 N-2) — 그래서 관리자 전용 정보인 통합 계정 SSH 대상은 **제외 종류**다.
- **손상된 등록부**는 로더가 `registryLoadError` 류를 보고 sourceErrors 로 올린다(반증 M2) → 그 종류의 연동 대상은 '보류'.
  v2.927(점검 D1-01): 표지 함수가 없는 로더(vCenter · NSX · Horizon · 배포 대상 · 중계 토폴로지 · 물리 GPU 등 — 손상본을 보존하고 `[]` 를 준다)는 `linkcheck/settingsLinks.js REGISTRY_FILE_OF` 의 파일에 `settingsStatus/sources.js damaged` 판정을 쓴다(판정 복제 금지 — 파일 이름 표는 실제 로더로 손상본이 생기는지 시험 `sweep2927Svcmon` 이 대조한다). **다시 나타난 사라짐 대상**은 '변경' 으로 올라 표지를 지우고
  설정 연동이 끈 것(`origin.goneOff`)만 다시 켠다(M3). 재동기화는 포트·URL 만 고친다(사람이 바꾼 사용 여부·주기·이름은 그대로).
- **전이·알림(`transitions.js`)**: 결과를 기록하는 두 자리(폴러 sweep · 엣지 ingestReport)에서만 `noteResult` — O(1), 던지지 않는다. 엣지 재전송(상태·연속 횟수가 같은 행)은 두 번 세지 않는다(measuredAt 은 전송 지연만큼 흔들린다 — 반증 M5).
  v2.927(점검 D1-03 · D1-05 · D1-06): 메타 없이 온 엣지 행(needMeta 첫 보고)은 알림 판정만 미룬다(집계·전이는 기록 · 시한 = push 주기 × 2, 3~15분) · 복구 결과는 범위 · 끈 종류 검사보다 **먼저** 알린 상태를 닫는다(저장 때 일괄로 비우지 않는다 — 범위를 넓힐 때 중복 실패 알림) · 점검 삭제/중지 · 엣지 GC · 엣지 잊기에서도 그 키를 지운다 · 요약 키 판정은 `/:summary(:|$)/`.
  알림은 연속 N회째 한 번 · 복구 한 번 · 20초 창에 6건 이상이면 요약 1건(키에 시각 — 고정 키는 억제 창에 버려졌다, M4) · `enqueueNotify`(폴러를 멈추지 않게) · **기본 꺼짐**. 알린 상태는 메모리(재시작 뒤 한 번 더 알릴 수 있음 — 화면이 밝힌다).
- **개요 집계(`dash.js`)**: 상태는 `status.js testState` · 엣지 `edgeState` 값 그대로(다시 판정하지 않는다). 중앙(실행 안 함)은 직접 결과를 세지 않는다. 30초 memo(저장소 rev 포함) · 엣지 행은 정렬하지 않고 읽는다 · 화면 60초 갱신(반증 M6 실측: 로컬 200k 0.39초 · 엣지 192k 0.86초 동기 — 양보 루프는 다음 과제).
  → ✅ v2.927(점검 E1-05): 본문을 생성기 하나로 두고 `buildDashAsync`(createYielder · 128행마다 양보 · 안정 top-K)와 동기 판이 같은 코드를 쓴다 · 개요 라우트는 single-flight. 실측 1,158ms → 최대 정지 20~34ms. 남은 동기 구간은 `edgeSummary` 1회(192k 행 약 50ms — 다른 라우트와 공유).
