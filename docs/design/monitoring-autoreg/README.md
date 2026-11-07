# 설계: Monitoring › 설정 연동 — 포탈 설정에 등록된 시스템을 골라 Monitoring 대상으로 자동 등록

작성 2026-11-06 (v2.914.0 기준 · 브랜치 `claude/kind-hypatia-4li2qs`) · 상태 **구현됨 v2.915.0**(컨펌 2026-11-06 '7번 1/7 둘 다 구현 · 8번 패싯 · 구현해줘' · 검증 표준 · 실패 알림 포함 — §10) · 시안 캔버스: https://claude.ai/artifact/45bKr4S67wekyVt6uWvPQP
(아트보드 7장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 2차(2026-11-06 "datadog 의 대시보드 참고해서 업데이트 · 기술적인 뷰로")는 ① 설정 연동 탭과 ⑤ 400px 를 기술 뷰로 다시 그리고 ⑦ Monitoring 개요 기술 뷰를 더했다 — §5.1. 법인명·주소·수치는 데모(mock) 데이터와 가상값이다. 색·글자는 `web/src/styles.css` `:root` 토큰과
Monitoring 화면의 `.pc-root` 토큰 그대로. 계정의 ‘Design System’ 아티팩트는 비어 있어 쓰지 않았다 — xfer-ping·bareos-cancel 과 같다.)

## 1. 요구 (사용자 요청 2026-11-06)

- "이 솔루션에서 사용하는, 설정한 모든 정보에 대해서 모니터링 기능에 자동 등록하는 기능 추가해줘. 예를들면 edge, vcenter, proxy, cvp, 스토리지 등 이 서버에서 수집하는 모든 정보를
  이 포탈에서 구현한 모니터링 기능에 사용자 선택해서 추가할 수 있는 기능 클로드 디자인으로 만들어서 시안 보여줘" + "필요하다면 모니터링 기능도 개선해줘".
- 규칙(2026-11-03 '기억해'): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현.
- '모니터링 기능' = 상단 탭 **Monitoring**(`#/svcmon` · `svcmon/` 성능점검 — 대상 트리 + 점검 15종 + 엣지 배정 + CSV 로그)로 읽었다. 네트워크 › 체크(Ping 모니터 `ping/`)는
  별개 기능이고 vCenter·엣지를 이미 자동 등록한다(§2). 사용자가 Ping 모니터 쪽을 뜻했다면 컨펌에서 바로잡는다(§9 ①).

## 2. 지금 있는 것(코드 근거) — 새로 만들지 않아도 되는 것

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| **설정에 등록된 접속처 카탈로그** — 19개 등록부 · 25종(`SETTING_KINDS`) · 종류별 라벨·그룹·프로브(mode/path/authMode)·기본 포트·확인 깊이(identity/http/tls/ssh/smtp/tcp) · 설정 화면 딥링크(`SETTINGS_PATHS`) · 비밀 제거본만 읽음 | `server/src/linkcheck/settingsKinds.js:67` · `settingsLinks.js:80 buildSettingsTargets` · 화면 특수 기능 › 통신 점검 › 설정 전수 점검(`web/src/views/tools/SettingsCheckPanel.jsx`) | **그대로 읽는다.** 두 번째 열거기를 만들지 않는다(같은 등록부를 두 곳에서 읽으면 한쪽만 고쳐진다). 대상 id `<kind>|<ref>` 가 **출처 키**가 된다 |
| Monitoring 대상 모델 `{id, kind, path, name, host, enabled, agent?, order, batch?, tests[]}` · 점검 필드표 `TEST_FIELDS` · 정규화 `cleanTarget/cleanTest` 하나 · SSRF 가드 · 2,000행 대량 등록(all-or-nothing · 중복 이름 skip) | `svcmon/testSchema.js` · `svcmon/store.js:248·189·543 bulkAddTargets` · `routes/svcmon/tree.js:81 /targets/bulk` | 등록은 **기존 대량 등록 경로**로 — 새 저장 경로를 만들지 않는다 |
| 점검 템플릿 — 치환 변수 `{host} {name} {path} {kind}` · 재적용 멱등(`tpl`+`tplKey`, test.id 승계) · 내장 6종 | `svcmon/templates.js` | 종류별 기본 점검을 **내장 템플릿**으로 추가한다(§4.2) |
| 등록 마법사(① 위치 → ② 대상 입력: 표/자유형식/파일 → ③ 템플릿 → 미리보기 → 등록) · 기본 '중지' 등록 · 엣지는 후보 목록에서만 · 배치 원장 + 되돌리기 | `web/src/views/svcmon/BulkTab.jsx` · `svcmon/batches.js` | ② 에 **네 번째 입력 모드 ‘설정된 시스템에서 선택’** 을 넣는다(시안 ②) |
| 엣지 배정 — 대상 `agent` 가 있으면 그 엣지 전용 · `PUT /svcmon/assign/:agent {byAgent:true}` 동기화 · 중앙(`SVCMON_ROLE=central`)은 직접 점검하지 않고 엣지 ack 로 활성 | `central/svcmonAssign.js:113` · `routes/svcmon/edge.js:67` | 등록 뒤 '담당 엣지에 배정 동기화' 체크 하나로 |
| Ping 모니터 자동 등록 선례 — `source:'vcenter'|'edge'|'vcport'` · 삭제 부활 방지 tombstone(`seededVc`·`seededEdge`) · 등록 시각만 · 갱신·삭제 없음 | `server/src/ping/store.js:153·181` | 출처 필드·tombstone 발상을 가져오되, **주소 변경·사라짐도 다룬다**(§4.3 — Ping 쪽의 한계) |
| 통신 점검의 핵심 판정 "자격증명을 보내지 않으므로 401/403 은 정상" · Monitoring http 점검은 `expectStatus` 를 비우면 500 미만 전부 정상 | `settingsKinds.js` 머리말 · `svcmon/checker.js:169` | 종류별 기본 점검이 그대로 성립 — **새 점검 엔진은 필요 없다** |
| 데모 seed(mock 모드 · 배치 `mock-demo`) — Chromium 검증에서 Monitoring 이 비지 않는다 | `server/src/mock/demo/svcmon.js` | 설정 연동 데모 행도 같은 규칙(네트워크 접속 없음)으로 |

## 3. 정직하게 밝혀야 하는 것 (시안 문구에 반영)

1. **카탈로그에 없는 종류가 6개다** — Arista CVP · Veeam B&R(9419) · Veeam Enterprise Manager(9398) · Bareos Director(9101) · Isilon 디렉터리 사용량 직접 호스트(SSH) · LLM(Ollama URL).
   `settingsKinds.js`·`settingsLinks.js` 에 `cvp|veeam|bareos|llm|isidu` 가 0건이다(grep 확인). 사용자가 예로 든 'cvp' 가 바로 여기 들어간다 → 카탈로그에 **추가**한다(§4.1). 통신 점검 화면도 같이 넓어진다.
2. **vCenter 의 담당 엣지가 카탈로그에서 항상 빈 값이다** — `settingsLinks.js:107` 은 `v.remoteAgent` 를 읽지만 `vcenter/registry.js normalize()`(:98~104)에 그 필드가 없다.
   담당 엣지는 스냅샷이 관측한 push 엣지(`inventory[].agent`)로 보완한다(`commmap/build.js` 의 '등록값 → 관측값' 순서와 같게).
3. **PDU 는 SSH 로 수집하는데 카탈로그 프로브는 https 443 이다** — `settingsKinds.js:129~133` · `pdu/registry.js:95 sshPort`. Monitoring 등록은 등록된 `sshPort` 의 SSH 배너를 기본으로 한다.
4. **'proxy'** 는 이 저장소에서 원격접속(HAProxy Data Plane · SSH 프록시 — `proxy/registry.js`)이다. 카탈로그 `set:haproxy`·`set:remoteSsh` 로 이미 들어 있다. 사용자가 다른 뜻(수집 경유)이라면 컨펌에서 바로잡는다.
5. **자격증명은 옮기지 않는다.** 등록되는 점검은 무인증(TCP · 인증서 D-일 · HTTP 상태코드 · SSH/SMTP 배너)뿐이다. 알림 웹훅은 URL 자체가 비밀(`secretVault.js:107`)이라 **등록 대상에서 제외**한다.
6. **통신 점검과 중복 측정이 생긴다** — 통신 점검은 5분마다 중앙에서 도달성을 재고(`linkcheck/poller.js`), Monitoring 은 엣지에서 더 짧은 주기·세부 점검(인증서·HTTP)을 돈다.
   질문이 다르므로 두되, 설정 연동 화면 문구에 "같은 카탈로그 · 다른 질문" 을 밝힌다. 두 기능을 합치는 것은 이번 범위가 아니다.
7. **Ping 모니터 자동 등록(vCenter·엣지)과도 겹친다** — 그쪽은 1분 TCP 지연 추이 전용이다. 설정 연동 행에 "Ping 모니터에 이미 자동 등록됨" 을 표시만 한다.
8. **Monitoring 에는 점검 실패 알림이 없다** — `svcmon/` 아래 `notify` 호출 0건, 있는 것은 엣지 무보고/재개(`central/svcmonSilence.js`)뿐. 개선 ② 로 제안한다(§7).

## 4. 데이터 · 서버

### 4.1 카탈로그 보강(`linkcheck/settingsKinds.js` · `settingsLinks.js`) — 공용 효과

- `SETTING_KINDS` 에 6종 추가: `set:cvp`(https · 등록 포트 · depth tls) · `set:veeam`(tcp 9419 · tls) · `set:veeamEm`(9398) · `set:bareosDir`(tcp 9101 — 평문 · depth tcp) · `set:isiduHost`(ssh) · `set:llm`(http `/api/tags` · authMode none).
  `SETTINGS_PATHS` 에 각 설정 화면 해시. `buildSettingsTargets` 가 각 등록부의 **비밀 제거 list 함수**(`cvp/registry.js listServers` · `veeam/registry.js listServers` · `veeam/em/registry.js listEms` · `bareos/settings.js loadSettings().directors` · `isidu/settings.js resolveTarget` · `llm/config.js loadLlmConfig`)만 읽는다.
  export 이름을 명시하고 없으면 `sourceErrors`(머리말 규칙 그대로).
- `set:pdu` 에 `sshPort` 를 넘기고 프로브를 ssh 로(443 웹 UI 는 `facts.httpsUi` 로 남긴다) · `set:vcenter` 의 `agent` 는 `remoteAgent` → 스냅샷 관측 엣지 순.
- 테스트: `linkcheckSettings*.test.js` 기존 틀에 6종 열거 · 비밀 0건(`password|token|secret` 키 없음) · PDU 포트 · vCenter 관측 엣지.

### 4.2 Monitoring 쪽 — 출처(origin) 와 종류별 내장 템플릿

- 대상에 **`origin`** 을 둔다: `{ kind:'set:vcenter', ref:'vc-eu-central', settings:'vcenter', syncedAt, hostAtSync }` — `cleanTarget` 화이트리스트에 넣는다(빠지면 저장 때 조용히 사라져 재동기화가 매번 중복 생성 — `tpl/tplKey` 와 같은 교훈).
  CSV 컬럼에는 **넣지 않는다**(`TARGET_FIELDS` 의 `batch` 와 같은 이유 — 사용자 입력으로 받으면 남의 출처를 달 수 있다). 내보내기 JSON 에는 싣는다.
- 종류별 **내장 템플릿** `tpl-set-<kind>`(§표). 치환 변수는 지금의 4개로 충분하다(`{host}` 만 쓴다). 포트는 대상 호스트가 아니라 **카탈로그 target.port** 를 써야 하므로, 템플릿 실체화 때 `port` 를 출처 포트로 **채워 넣는 단계**가 하나 필요하다(`materializeForTarget(templateId, target, { port })` — 포트가 템플릿 항목에 없을 때만).

| 종류 | 기본 점검 | 깊이 |
|---|---|---|
| vCenter | tcp <포트> · cert D-30(1일) · http `https://{host}:<포트>/sdk/vimServiceVersions.xml` expect 200 | identity |
| 수집 서버(엣지) | tcp · cert · http `/api/health` expect 200 · keyword `status` — **중앙에서** 점검(엣지가 자기 자신을 재지 않는다) | identity |
| iDRAC | tcp 443 · http `/redfish/v1/` expect 200 · `insecure:true`(자체서명) | identity |
| NSX · OME · 스토리지(API) · Horizon · HAProxy | tcp · cert · http `/`(expectStatus 비움 → 500 미만 정상) | http |
| SAN(SSH) · PDU · 베어메탈 스토리지 · 물리 GPU · 캡처 호스트 · 배포 대상 · 중계 노드 · 통합 계정 SSH | ssh 배너(등록 포트) | ssh |
| CVP · Veeam · Veeam EM · AD/LDAP(636) | tcp · cert | tls |
| Bareos Director · AD/LDAP(389) | tcp | tcp |
| SMTP | smtp 배너 + EHLO | smtp |
| 알림 웹훅 · 업그레이드 소스 · 패키지 저장소 · LLM | **제외**(비밀 URL · 외부 인터넷 · 로컬) — 컨펌 ④ | — |

### 4.3 동기화 — 새 라우트 `/api/svcmon/settings-sync/*`(`routes/svcmon/settingsSync.js`)

- 게이트는 형제 쓰기 라우트와 같다: `canEdit, fullScopeOnly`(조회 GET 도 — 전 법인 설정 주소가 실리므로 범위 계정에 열지 않는다. 통신 점검 `/targets` 가 adminOnly+fullScopeOnly 인 것과 같은 기준).
- `GET /catalog` — `buildSettingsTargets()` 결과 ∩ Monitoring 대상(`origin` 으로 조인) → 행마다 `state: 'new'|'linked'|'host-changed'|'gone'|'problem'|'excluded'` + 담당 엣지(후보 목록에 있는 이름만 — 없으면 `''` 중앙) + 종류별 템플릿 id + 등록 경로.
  memo 는 **카탈로그 세대(등록부 mtime 합) + 저장소 rev + 배정 rev** 를 키로(12초). 결과에 비밀 0건(`publicTarget` 화이트리스트 + 테스트).
- `POST /preview {ids[], templateMode, pathTemplate, state, goneAction, syncAssign}` → `store.planBulkTargets`(저장 없음) + 변경·사라짐 계산. 전부 성공 또는 전부 거부.
- `POST /apply` — ① 추가는 `bulkAddTargets(..., { batch: 'settings:<yyyymmdd-hhmm>' })` + `recordBatch(source:'settings')`(원장 `SOURCES` 에 `'settings'` 추가) ② 주소 변경은 `updateTarget(host)`(점검 id 승계) ③ 사라짐은 기본 `enabled:false` + `origin.gone=true`(삭제는 옵션 · 배치 되돌리기 대상 아님 — 사용자가 고른 것만) ④ `syncAssign` 이면 엣지별 `PUT /assign/:agent {byAgent:true}` 와 같은 함수 호출.
  감사 로그(`logAudit`) 한 건에 요약(추가·변경·중지 수 · 배치 id).
- **주기 감지**(배너): 5분마다 카탈로그를 **읽기만** 해서(네트워크 점검 아님 — `linkcheck/poller.js` 와 별개) `new·host-changed·gone` 수를 `svcmon/settingsDrift.js` 메모리에 두고 `GET /state`(`overview.js:50`)에 `settingsDrift:{new,changed,gone,at}` 로 싣는다.
  범위 계정 판본에는 수만 싣고 이름·주소는 싣지 않는다. 손으로 호스트를 고친 대상은 다음 감지에서 `host-changed` 로 다시 뜬다(시안 ④ 모달 문구) — 이것이 의도다(설정이 진실).
- **자동 등록 토글(종류별 · 기본 끔)**: 켜면 감지 때 `new` 를 중지 상태로 등록한다. 기본값을 끔으로 두는 이유 — 같은 저장소 교훈("서비스는 자동으로 만들지 않는다" · Ping tombstone). 사용자가 지운 연동 대상은 `origin` tombstone(`svcmon-settings-sync.json` `dismissed[]`)으로 부활을 막는다.
- 바꾸지 않는 것: 엣지 코드 · 점검 엔진(`checker.js`) · CSV 스키마 · Ping 모니터.

## 5. 화면(IA) — 시안 캔버스의 아트보드

```
① Main      특수 기능 › Monitoring 설정 › 새 탭 '설정 연동' — 기술 뷰(1440, Datadog 대시보드 참고) — 상단 템플릿 변수(kind·corp·edge·state·depth) + 시간 창 + 갱신 주기 ·
            Query Value 6(스파크라인 · 변화량) · 종류별 등록 커버리지 Top List · 드리프트 감지 추이(24h · 5분 버킷 · 새/변경/사라짐 누적 막대) · 엣지별 배정·보고 표 ·
            왼쪽 패싯(STATE·KIND·CORP·EDGE·DEPTH, 건수) + 모니터 목록식 표(STATE 알약 · 태그 칩 kind/corp/edge/depth · host:port · 기본 점검 · 마지막 동기화) · 이벤트 스트림
② Register  Monitoring '＋ 등록' 마법사 ② 단계에 네 번째 모드 '설정된 시스템에서 선택' — 왼쪽 종류/법인 트리(미등록/전체 수) · 오른쪽 항목 표 · 안내문
③ Apply     미리보기·적용 — 요약 5칸(추가·변경·사라짐·건너뜀·오류) · 결과 표(출처 열) · 종류별 기본 점검 표 · 적용 옵션(상태·사라짐 처리·주소 갱신·배정 동기화·자동 등록)
④ Tree      Monitoring 트리 — 상단 '설정이 바뀌었습니다' 배너 · 트리 '설정 연동' 폴더 + 출처 배지(vCenter/NSX/주소 변경/사라짐) · 상세 모달 '출처' 상자(설정 화면 링크 · 연동 해제)
⑤ Narrow    ① 의 400px 기술 뷰 — 변수 칩 가로 스크롤 · Query Value 3열 · 커버리지·엣지 Top List · 질의 입력 · 카드형 행(알약 · 태그 · 점검 칩)
⑥ Improve   Monitoring 개선안 3건(§7)
⑦ Dash      Monitoring › 개요 기술 뷰(1440, Datadog 참고 · 개선안 ④) — 모니터 요약 7칸(OK/WARN/ALERT/NO DATA/PENDING/DISABLED) · 출처별 체크 상태 타일 · ALERT·WARN 추이 + 평균 응답(1시간 버킷) ·
            엣지 보고·지연 표 · 법인별 호스트 맵(육각형 = 대상 · 최악 상태) · 응답 느린 점검 TOP 8 · 연속 실패·인증서 임박 · 상태 전이 이벤트 스트림
```

표는 구현 때 `STable`(헤더 정렬) · `BoldText` 문구 규칙(백틱 금지) · 그리드 자식 `min-width:0` · 버튼 행 `flexWrap`.

### 5.1 기술 뷰 — Datadog 대시보드에서 가져온 요소와 데이터 원천(정직 표)

Datadog 을 **모양이 아니라 구성 단위**로 참고했다: 템플릿 변수(상단 `key:value` 칩) · 시간 창/갱신 주기 · Query Value(큰 수 + 스파크라인 + 변화량) · Top List(가로 막대) ·
Timeseries(누적 막대 + 우축 선) · Check Status(종류별 타일) · Host Map(육각형) · Monitor Summary(상태별 칸) · Event Stream · 패싯 + 질의 목록(Monitors/Infrastructure 목록).
색·글자·간격은 포탈 토큰(`.pc-root` · `:root`) 그대로이고 Datadog 의 보라 계열·아이콘은 쓰지 않았다(남의 디자인 재현 아님).

| 위젯 | 데이터 원천(있는 것) | 없어서 추가할 것 |
|---|---|---|
| ① Query Value 6 · 커버리지 Top List · 패싯 · 목록 | `buildSettingsTargets()` ∩ svcmon 대상(`origin` 조인) — §4.3 `GET /catalog` 한 번으로 전부 파생 | 스파크라인은 감지 결과의 **일별 요약**(`svcmon-settings-sync.json` 에 날짜별 new/changed/gone 수 — 30일) |
| ① 드리프트 추이(24h · 5분) | 5분 감지(§4.3)의 결과 | 버킷 보관 — 메모리 링버퍼 288칸(24h) + 일별 요약 파일. CSV 로그에 넣지 않는다(점검 로그와 섞이지 않게) |
| ① 엣지별 배정·보고 | `central/svcmonAssign.js listAssignments()`(대상 수 · 상한 `MAX_TARGETS_PER_AGENT`) · `central/svcmonEdge.js edgeSummary()`(`lastAt`·`ageMs`·`silent`·`rows`·`items`) | 없음 — 두 함수 결과를 엣지 이름으로 조인 |
| ① 이벤트 스트림 | 배치 원장 `svcmon-batches.json`(apply) · 감사 로그 | drift 감지 이벤트는 위 링버퍼에서 |
| ① 질의 입력(`name:vc-* host:10.20.* kind:idrac`) | 서버는 패싯 값(kind·corp·edge·state·depth)만 받는다 | 자유 질의는 **화면에서 파싱**(key:value 공백 구분 · 정규식 아님 · 와일드카드는 접두/접미만 — ReDoS 규칙) |
| ⑦ 모니터 요약 7칸 · 체크 상태 타일 · 호스트 맵 · TOP 8 · 연속 실패 · 인증서 임박 | `GET /svcmon/state`(결과 status·reply·streak·ts · `status.js testState` 6상태) — 전부 지금 응답에 있다. 출처별 타일은 `origin.kind` 로 묶는다 | 없음(묶기만). 인증서 D-일은 cert 점검 reply 값 |
| ⑦ ALERT·WARN 추이 + 평균 응답(1시간) | `GET /svcmon/log/analyze`(`loganalyze.js ANALYZE_BUCKETS` hour…year) | 5분 버킷은 없다 — 1시간 버킷으로 시작. 응답 ms 평균은 집계에 포함돼 있는지 구현 때 확인(없으면 추가) |
| ⑦ 엣지 보고·지연 | `GET /svcmon/edge-state` | 없음 |
| ⑦ 상태 전이 이벤트 | 지금은 **결과만** 있고 전이 이력이 없다 | 폴러/보고 수신에서 `prev.status !== cur.status` 일 때 링버퍼 500건에 push(`svcmon/transitions.js`) — 개선 ② 실패 알림이 같은 훅을 쓴다 |
| 템플릿 변수 · 시간 창 | 화면 상태(URL 해시 쿼리) | 시간 창은 추이·이벤트 위젯만 따른다(현재 상태 위젯은 '지금') — 문구로 밝힌다 |

범위: ①·⑦ 조회는 각각 §6 규칙을 따른다 — ① 은 전체 범위 쓰기 계정, ⑦ 은 svcmon 권한(기존 `/state` 와 같음 · 범위 계정은 지금처럼 자기 범위 결과만).
⑦ 은 기존 KPI 카드 + 트리 화면을 **대체하지 않는다** — 상단 모드 옆 '개요 | 트리' 세그먼트로 전환(트리는 등록·편집, 개요는 읽기).

## 6. 범위(scope) · 보안

- 카탈로그·미리보기·적용·감지 상태의 이름·주소는 **전체 범위 쓰기 계정**에만(§4.3). 범위 계정 `GET /state` 에는 수만.
- 응답에 비밀 0건 — `buildSettingsTargets` 가 이미 비밀 제거본만 읽고 `publicTarget` 으로 자른다. 새 6종 로더도 같은 규칙(테스트가 키 이름을 스윕).
- `origin` 은 서버가 발급한다 — `/targets`·`/targets/bulk`·CSV 로 들어온 `origin` 은 버린다(`batch` 와 같은 처리).
- SSRF: 카탈로그 주소도 `validateEndpoint`(store) 를 그대로 지난다 — 등록부에 있는 주소라고 가드를 건너뛰지 않는다(통신 점검은 자체 가드가 있지만 Monitoring 저장은 store 가 진실).
- 변이 검증·반증 에이전트: 범위·비밀·엣지 수신 계약(배정 동기화)이 걸리므로 **반증 1인**을 둔다(CLAUDE.md '위험한 수정' 기준).

## 7. Monitoring 개선안(사용자 "필요하다면 모니터링 기능도 개선해줘" — 시안 ⑥)

| # | 무엇 | 근거(실측·코드) | 크기 |
|---|---|---|---|
| ① | KPI 카드 7장을 폭에 맞춰(1440 한 줄 · 400 두 열) | `.pc-cards` 가 `repeat(5,1fr)` 고정(`styles.css:1002`) — 1440 에서 5+2 두 줄, **400 에서 '경고' 카드가 글자 단위로 세로 찌그러짐**(Chromium 실측 `svcmon-400.png`) | CSS 2줄 + Chromium |
| ② | 점검 실패 알림(연속 N회 → `notify()` · 복구 알림 · warn 은 기본 끔) | `svcmon/` 아래 notify 0건 · 있는 것은 엣지 무보고(`central/svcmonSilence.js:71`) — 점검이 실패해도 아무도 모른다 | 서버 훅 + 설정 UI 1절 + 테스트 |
| ③-a | 빈 상태 문구 '＋ Add 로 등록하세요' → 버튼 이름 '＋ 등록' 과 맞춤 | `web/src/views/SvcMonitor.jsx:534` vs 버튼 `:547` | 문구 1건 |
| ③-b | 통신 점검 카탈로그 보강(6종 · PDU sshPort · vCenter 관측 엣지) | §3 1~3 | §4.1 과 같은 작업 |
| ④ | Monitoring 개요 기술 뷰(시안 ⑦ — 모니터 요약 · 출처별 체크 상태 · 추이 · 호스트 맵 · TOP · 전이 이벤트) | 지금 화면은 KPI 7장 + 트리/표뿐 — '어느 종류·법인·엣지가 나쁜가' 를 한눈에 못 본다. 원천은 §5.1 표대로 대부분 있다 | 화면 1장 + 전이 링버퍼 + 1시간 집계 연결 |

제안하지 않은 것(검토했지만 근거 부족): 통신 점검과 Monitoring 통합 — 질문이 다르고(도달성 vs 세부 점검) 두 화면의 사용자가 다르다(adminOnly vs svcmon 권한). 다음 라운드 후보로만 남긴다.

## 8. 검증 계획(구현 때)

- 단위: 카탈로그 6종 열거 · 비밀 키 0건 · `origin` 화이트리스트 왕복(저장→재로드 키 집합 동일) · preview/apply all-or-nothing · 사라짐 기본 중지(삭제 아님) · 범위 계정 403 · 감지 상태 범위 판본 수만 · 템플릿 포트 채움.
- 화면: Chromium 1440/400 — 설정 연동 탭 · 마법사 4번째 모드 · 미리보기 · 트리 배지 · 배너 · KPI 반응형(A/B).
- 반증 1인(§6).

## 9. 컨펌 질문

1. '모니터링 기능' = Monitoring(svcmon) 으로 읽었다. 네트워크 › 체크(Ping 모니터)를 뜻했다면 그쪽은 이미 vCenter·엣지를 자동 등록하므로 **나머지 종류 추가**만 하면 된다(설계가 더 작아진다).
2. 진입점 둘 다(설정 연동 탭 + 마법사 4번째 모드)로 갈지, 하나만 둘지. 권장: **둘 다**(탭은 운영 중 차이 검토 · 마법사는 첫 등록).
3. 자동 등록 토글 기본값 **끔**(새 설정 항목은 배너로 알리고 사람이 등록). 켜 두길 원하면 중지 상태로 등록한다.
4. 제외 종류(알림 웹훅 · 업그레이드 소스 · 패키지 저장소 · LLM)를 그대로 제외할지.
5. 개선안 ①~③ 을 이번 구현에 함께 넣을지(①·③-a 는 작고, ② 는 설정 UI 가 하나 더 생긴다).
6. 검증 수준: 표준(관련 테스트 + Chromium + 반증 1인) 권장.
7. (2차) 기술 뷰 범위 — ① 설정 연동 탭만 기술 뷰로 구현할지, ⑦ Monitoring 개요 기술 뷰까지 함께 갈지. ⑦ 은 전이 링버퍼·1시간 집계 연결이 더 붙어 약 1시간이 늘어난다.
8. (2차) 자유 질의 입력(`name:vc-* kind:idrac`)을 넣을지, 패싯 체크만 둘지. 권장: 패싯만 먼저(질의 파서는 다음 라운드).

## 10. 구현(v2.915) — 시안과 달라진 점 · 정직 기록

컨펌: ①설정 연동 탭 + ⑦Monitoring 개요 기술 뷰 둘 다 · 자유 질의 대신 **패싯** · 검증 표준(관련 테스트 + 전량 + Chromium 1440/400 + 반증 1인) · 개선 ②실패 알림 포함.
질문 1~6 은 답이 없어 권장 기본값으로 갔다(Monitoring=svcmon · 진입점 둘 다 · 자동 등록 기본 끔 · 제외 종류 유지 · 개선안 포함).

- **종류별 기본 점검은 템플릿 탭의 내장 템플릿이 아니라 `settingsSync.checksFor`(순수 함수)** 로 만든다 — 포트가 대상마다 달라 템플릿 치환 변수(`{host}` 등 4개)로는 표현이 안 되고,
  재동기화가 `tpl:'settings'`+`tplKey` 로 test.id 를 승계해야 해서다. 마법사 ③(템플릿 선택)은 설정된 시스템 모드에서 쓰지 않는다(종류별 기본 · 끄면 대상만).
- **무인증 HTTP 는 기대코드를 비운다** — checker 가 비우면 500 미만을 정상으로 본다(시안 ③ 의 '목록 허용 확장' 은 필요 없었다 — 정정).
- **자유 질의 입력은 넣지 않았다**(컨펌 8) — 패싯(STATE · KIND · CORP · EDGE · DEPTH, 다른 축 선택을 반영한 건수) + 이름·주소 검색.
- **배너의 '새 항목'** 은 첫 감지·마지막 '새 항목 확인' 이후 생긴 것만 센다(Chromium 실측 결함 — 처음 판본이 미등록 258건을 '설정이 바뀌었습니다' 로 띄웠다).
- **알림은 기본 꺼짐**(설정 › Monitoring 설정 › 알림) — 업그레이드만으로 전 법인 포탈이 실패 중인 점검 수만큼 알림을 쏘지 않게. 저장은 admin + 전체 범위.
- **개요의 시간별 추이·전이 이벤트는 메모리**(재시작하면 비어 있음 — 화면이 '재시작 이후' 로 밝힌다). 5분 버킷이 아니라 1시간 버킷.
- 카탈로그 보강(통신 점검도 같이 넓어진다): 새 6종 · PDU 프로브 SSH(등록 sshPort) · vCenter 담당 엣지 = 스냅샷 관측 `collectedBy`(등록부에 `remoteAgent` 필드가 없었다).
- 반증 1인 결과(§10.1)를 반영했다.

### 10.1 반증 1인(2026-11-06) — 높음 1 · 중간 7 · 낮음 15

| 등급 | 지적 | 조치 |
|---|---|---|
| 높음 H1 | 카탈로그 조회가 canEdit 라 operator 가 봉인 비밀 웹훅 URL(제외 행 address)·통합 계정 매핑을 받았다(재현) | 설정 연동 라우트 전부 **adminOnly + fullScopeOnly** · 행 주소 `safeAddress`(사용자 정보·쿼리 제거 · 제외 종류 주소 없음) · 통합 계정 SSH 대상을 제외 종류로 · 회귀 테스트 |
| 중간 M1 | 미리보기 뒤 옵션(사라짐 처리 '삭제' 등)을 바꾸면 미리보기와 다른 동작이 적용됐다 | 옵션을 바꾸면 미리보기를 지운다(다시 봐야 적용 버튼이 열린다) |
| 중간 M2 | 손상된 등록부(던지지 않고 [])를 '사라짐' 으로 판정(재현) | 로더가 `registryLoadError` 류를 sourceErrors 로 올린다 → '보류' · 통신 점검 화면도 '못 읽음' 을 말한다 |
| 중간 M3 | 사라짐(중지) 대상이 다시 나타나면 영구히 중지·표지(재현) | '변경(다시 나타남)' 으로 올리고 적용 시 표지 제거 · 설정 연동이 끈 것(`goneOff`)만 다시 켠다 |
| 중간 M4 | 요약 알림 키 고정 → 5분 억제 창이 다음 요약을 버림(재현) | 키에 시각 |
| 중간 M5 | 엣지 재전송을 measuredAt 비교로 못 가름(전송 지연만큼 흔들림 — 재현) | 상태·연속 횟수가 바뀐 행만 새 측정으로 |
| 중간 M6 | `/overview` 동기 집계(로컬 200k 0.39초 · 엣지 192k 0.86초 실측) | v2.915: memo 30초 · 엣지 행 정렬 생략 · 화면 60초. **v2.926: 시간 기준 양보(`buildDashAsync`) · 엣지 하나씩 · 표 위젯 상위 K · 동시 요청 계산 공유로 마무리** |
| 중간 M7(정책) | 등록하면 이름·호스트·출처가 `/state` 로 범위 계정에도 보인다 | svcmon 조회 원칙(N-2) 그대로 두고, 관리자 전용 정보(통합 계정 매핑)는 제외 종류로 막았다 |
| 낮음 | 재동기화가 사람이 바꾼 점검 사용 여부·주기·이름을 덮음 · 배너 '사라짐' 수가 처리 뒤에도 뜸 · 역할 'both' 문구 | 포트·URL 만 고침 · 배너는 표지 없는 사라짐만 · 문구 정정 |
| 낮음 | 엣지 재배정 때 엣지 testId 가 새로 발급돼 실패 중인 점검을 다시 알림 · 중앙 재시작 직후 엣지 메타가 없어 알림 이름이 testId 로 나감 | **v2.926: 엣지 알림 키를 (엣지·경로·대상·점검 이름)으로 · 이름을 모르면 판정 보류** |
| 낮음(남김) | 그 밖 소소한 일관성(반증 보고 전문) | 다음 점검 후보 |
- 별건으로 고친 것: `server/test/vcinfo2898.test.js` ④ 라우트 테스트가 고정 날짜 작업 기록(2026-11-05)을 `Date.now()` 로 정리해 보관 기한(24시간)을 넘긴 날부터 실패하던 시한폭탄 — 기준 시각 고정.

### 10.2 v2.926 개선(2026-11-07 '프로그램 개선해줘' — 고른 범위: 트리 결함 2건 · 개요 집계 성능 · 알림 정확도 2건 · 개요→트리 바로가기 · 검증 표준)

- 트리 점검 표 열 최소폭 합 920px → 720px — 1440px(트리 340px)에서 'TEST METHOD' 열이 잘렸다(Chromium 실측 · 테스트가 합을 고정).
- 대상을 고르면 섹션 경로가 내부 id(`g-4c30c45c`) 대신 '경로\이름'.
- 개요 호스트 맵 칸을 누르면 그 대상을 트리에서 바로 고르고 트리 상자 안에서만 스크롤한다(창은 움직이지 않는다). 중앙 저장소에 없는 엣지 행은 이름 검색으로.
- 개요 집계 양보·동시 요청 공유 · 엣지 알림 키(§10.1 M6 · 낮음 행).
- 반증 재검토(v2.926 — 높음 1 · 중간 2 · 낮음 6): **N1 높음** 이름 기반 엣지 알림 키가 같은 이름의 점검 둘에서 충돌해 거짓 복구·실패/복구 반복(재현) →
  엣지별 이름 키 개수를 세어 겹치면 testId 키 · 구분자 제어 문자 · 변이 검증(고친 줄을 빼면 테스트 실패 확인). **N2** 메타가 같은 요청에 오면 보류분을 그 자리에서 재판정 ·
  보류 수는 현재 수. **N3** 호스트 맵 전체 localeCompare 정렬(400k 0.84~1.44초)·에이전트 이름용 전 행 순회 제거 — 그룹 버킷 + 표시분만 정렬 · `listAgentNames`.
  L1 늦게 끝난 옛 계산이 새 캐시를 덮지 않게 · L6 바로가기는 조상 폴더를 펼치고 목록 밖이면 이름 검색. 남김: L2(양보 중 원본 변경으로 섞인 시점 — 예외 없음) ·
  L3(엣지 행 조인에 구분 없음 — 엣지 메타에 구분이 없다) · L4(이름 변경 시 옛 키 잔류 — 메모리, 재시작 시 정리) · 엣지 표(edgeRows)의 전 행 순회 1회(1.28M 행 상한 약 0.3초 — 현 규모 수 ms 추정).

