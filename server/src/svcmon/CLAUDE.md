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
  v2.932(점검 D1-01): 표지 함수가 없는 로더(vCenter · NSX · Horizon · 배포 대상 · 중계 토폴로지 · 물리 GPU 등 — 손상본을 보존하고 `[]` 를 준다)는 `linkcheck/settingsLinks.js REGISTRY_FILE_OF` 의 파일에 `settingsStatus/sources.js damaged` 판정을 쓴다(판정 복제 금지 — 파일 이름 표는 실제 로더로 손상본이 생기는지 시험 `sweep2932Svcmon` 이 대조한다). **다시 나타난 사라짐 대상**은 '변경' 으로 올라 표지를 지우고
  설정 연동이 끈 것(`origin.goneOff`)만 다시 켠다(M3). 재동기화는 포트·URL 만 고친다(사람이 바꾼 사용 여부·주기·이름은 그대로).
- **엣지 알림 키는 이름 기준**(v2.928 · `alertKeyOf`): (엣지 · 경로 · 대상 이름 · 점검 이름). 엣지는 배정을 다시 굳힐 때마다 점검 id 를 새로 발급하므로 id 키는 같은 실패를 다시 알렸다.
  ⚠ **점검 이름은 유일하지 않다**(마법사 기본 이름 — 반증 재검토 N1 재현: 같은 이름 둘이면 한쪽 실패를 다른 쪽 정상이 '복구' 로 지웠다) —
  `svcmonEdge` 가 이름 키별 id(`nameIds` — metaSet/metaDelete 로만 고친다)를 기억하고 판정 때 **창(`nameWindowOf`) 안에 실제로 보고된 행 + 결과가 아직 없는 메타**만 세어 둘 이상이면 `dupName` → testId 키. 구분자는 제어 문자.
  v2.934(v2.932 남긴 것 — 재현): 개수만 세면 재배정 직후 **GC 대기 중인 옛 id 행**(직전 완결 허용)까지 세어 같은 실패를 한 번 더 알렸다. 창은 이번 스냅샷을 **다 받았으면**(완결 · 1..total 청크 전부 · 예열 아님)
  이번 것만, 아니면 이번 + 직전 완결(뒤 청크 · 유실 청크의 형제를 빼면 N1 이 깨진다). 판정은 **청크의 행 · 메타를 다 반영한 뒤**(행 루프 안에서 하면 한 청크 안 행 순서로 키가 흔들린다) · GC 의 남은 행 키도 같은 창. 회귀 `svcmonRealloc2934`.
  이름을 모르면(중앙 재시작 직후 메타 전) **판정 보류**(`metaPending` = 지금 보류 중인 수) · 메타가 오면 `noteAlertOnly` 로 다시 판정(N2 — 같은 요청 · v2.932 D1-03 — 다음 요청 · 시한, 아래 절).
  직접 실행은 저장소 testId(안정).
- **전이·알림(`transitions.js`)**: 결과를 기록하는 두 자리(폴러 sweep · 엣지 ingestReport)에서만 `noteResult` — O(1), 던지지 않는다. 엣지 재전송(상태·연속 횟수가 같은 행)은 두 번 세지 않는다(measuredAt 은 전송 지연만큼 흔들린다 — 반증 M5).
  v2.932(점검 D1-03 · D1-05 · D1-06): 보류는 `svcmonEdge alertPending` 으로 요청을 넘어 이어지고(메타는 needMeta 다음 push 에 오는데 그 push 의 행은 재전송이라 noteResult 가 다시 불리지 않는다)
  **시한**(push 주기 × 2, 3~15분)을 넘기면 `metaTimeout` 으로 testId 키 판정 · 보류 판정은 범위 검사보다 먼저(경로를 모르면 범위도 모른다) · 복구 결과는 범위 · 끈 종류 검사보다 **먼저** 알린 상태를 닫는다
  (저장 때 일괄로 비우지 않는다 — 범위를 넓힐 때 중복 실패 알림) · 결과가 멈추는 자리에서 상태를 닫는다(폴러 색인 재구성 = 살아 있는 testId · 엣지 완결 GC = **남은 행의 알림 키** — 재배정으로 id 만 바뀐 점검은 남는다 · 엣지 잊기) · 요약 키 판정은 `/:summary(:|$)/`.
  알림은 연속 N회째 한 번 · 복구 한 번 · 20초 창에 6건 이상이면 요약 1건(키에 시각 — 고정 키는 억제 창에 버려졌다, M4) · `enqueueNotify`(폴러를 멈추지 않게) · **기본 꺼짐**. 알린 상태는 메모리(재시작 뒤 한 번 더 알릴 수 있음 — 화면이 밝힌다).
- **개요 집계(`dash.js`)**: 상태는 `status.js testState` · 엣지 `edgeState` 값 그대로(다시 판정하지 않는다). 중앙(실행 안 함)은 직접 결과를 세지 않는다. 30초 memo(저장소 rev 포함) · **시간 기준 양보**(`buildDashAsync` · createYielder 15ms — 동기판 `buildDash` 와 누산기 하나를 공유, 테스트가 결과 대조) · 엣지 행은 엣지 하나씩 · 표 위젯은 상위 K 만 · 같은 세대 동시 요청은 계산 하나를 함께 기다린다(v2.928 — 반증 M6 실측: 로컬 200k 0.39초 · 엣지 192k 0.86초 동기였다 · v2.932 점검 E1-05 도 같은 지적). 남은 동기 구간은 엣지 표의 `edgeSummary` 1회(192k 행 약 50ms — 다른 라우트와 공유).
  화면 문구의 주기·창·건수(감지 주기 · 요약 묶음 창/기준 · 개요 '최근 N시간·N건')는 API 값(`detect` · `batch` · `limits` · `settingsDrift.intervalMs`)으로만 쓴다(v2.932 D1-08 — 요약 기준 +1 은 서버 `alertBatchInfo` 한 곳).
- **쉬운 등록(v2.960 · 설계 README §11 · 회귀 `svcmonEasyRegister`)**: 사용/중지는 `store.setEnabledMany` 하나(enabled 만 · 저장 한 번 · 재검증 없음) → 바뀐 대상의 엣지는
  `central/svcmonAssignSync.js syncByAgentAssignments`(설정 연동 · 사용/중지 · 시험이 공유 — 사본 금지 · 경로 기준 배정은 건너뜀 보고). **엣지는 배정 스냅샷의 켜진 대상만 돈다** — 중앙에서 켜고 끄면 배정을 다시 굳혀야 반영된다.
  시험 점검(`trial.js`): 중지된 대상만(이미 켠 대상은 실패해도 끄지 않게 건너뜀) · 직접 시험은 폴러 워커 풀 · 결과를 폴러 결과 · 전이 · CSV 에 넣지 않는다 · 동시에 하나(409) ·
  엣지 시험은 켜고 배정 → 첫 보고(measuredAt ≥ 시작 — v2.988 부터 배정 ack 뒤)로 판정 · 기대 점검 = 켜진 점검 − 배정 제외 유형 · **시한**(`edgeDeadlineMs` — 넘기면 중지로 되돌림) · 대기는 `svcmon-trial.json`(재시작 이어 판정 · CHANGE_WATCH_EXCLUDE) ·
  알림 억제는 `transitions.muteTarget`(경로 · 대상 이름 소문자 · 시한 — 복구 판정 뒤 · 범위 검사 뒤). 개요 `coverage` 는 관리자 판본 ∧ 전체 범위 ∧ 중앙 노드에만 — **캐시 본문(전 계정 공유)에 넣지 않고 응답마다** 붙인다.
  반증(§11.7.1): 배정 파일 로드 오류면 배정을 **다시 굳히지 않는다**(빈 목록으로 덮으면 다른 엣지 배포분이 지워진다) · 되돌린 대상은 `revertMuteMs` 동안 억제를 잇는다(엣지가 옛 스냅샷으로 잰다) ·
  사람의 사용/중지 · 주소 수정 · 삭제는 `cancelTrials`(사람이 마지막) · 엣지 판정은 지금 주소 · 기대 이름 · 점검마다 최근 행 하나.
  법인 판정(`corpOf`)은 `key`(DataCenter id — 묶음) · `id`(예전 뜻) · `label`. 법인 담당 엣지(`corpEdgesOf`)는 근거(수집 vCenter 의 collectedBy · 수집 서버 등록부의 법인)가 있고 배정 후보인 것만 · 둘 이상이면 고르지 않는다 · 엣지 포탈 자신은 제외.
- **잔여 작업(v2.988 · README §11.8 · 회귀 `svcmonEasyRegisterFollowup`)**: 엣지 시험은 **배정 적용이 확인된 뒤 측정분만**(`trial.readyAtFor` — 여유 없음): ack(시작 이후) · 같은 sig 의 '변경 없음' pull 확인(그 sig 가 **오류 없이** 적용된 적 있을 때만 — `okSigs` · 메모리 `noteUnchangedPull`) · 시험이 굳힌 sig 가 그대로이고 ack 가 시작 전(이미 켜진 채 실려 있던 대상 → 시작 이후 행). ack 만 보면 A→B→A 배정에서 엣지가 다시 ack 하지 않아 거짓 실패였다(반증 R1).
  엣지 메타 `k`(infra|service)는 **아는 값만**(그 밖 = 빈 값 · `metaSig` 판 `m2:`) · 빈 값(옛 엣지)은 v2.960 과 같게 — 억제는 어느 구분이든 · 시험은 거르지 않음 · 개요는 경로 · 이름 조인. 수신 계약은 넓히기만 할 것.
  '법인 폴더로 정리'(`planRepath` · `executeRepath`)는 **설정 연동이 놓은 자리에 그대로 있는 대상만**(`row.repath` — 지금 법인을 알 때(corpKey) · 법인 등록부를 읽었을 때만) · 계획 때 지금 경로를 다시 대조 · 옮길 폴더의 (구분 · 경로 · 이름) 충돌이면 건너뜀 · 경로 기준 배정 엣지가 옮기기 전/뒤를 덮으면 건너뜀 · 배정 파일 못 읽으면 건너뜀 · id 승계. 출처의 법인은 '놓인 자리' 라 주소 변경 적용이 덮지 않는다.
  '지금 한 번 점검'(`runOnceTest`)은 실행 역할일 때만 · 결과는 응답으로만(폴러 결과 · 전이 · 알림 금지) · 동시 상한. 데모 엣지 배정 후보는 mock 에서만(데모 엣지 대상의 시험은 이 포탈이 대신 — 보고하지 않는다).
