# 설계: Bareos 백업 전용 화면 — 백업 방식 'Bareos' 추가 · 법인별 현황 · 28개 법인 통합 현황

작성 2026-10-30 (v2.827.0 기준) · 상태 **구현됨 v2.828.0**(권장안 A · 표준 검증 — 아래 §9 '구현 결과') · 시안 캔버스: https://claude.ai/artifact/BXe5d4tyALdJ9vR5KeBBwo
(아트보드 4장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명·수치는 가상이고 색·글자는 `web/src/styles.css` `:root` 토큰 그대로.)

## 1. 요구 (사용자 요청 2026-10-30)

1. Backup 현황 › Detail 화면(`#/tools/backup-detail`)의 **백업 방식에 'Bareos' 카테고리**를 추가한다.
2. Bareos 카테고리에 포함된 VM 들만 **별도의 VM 폴더 트리**로 보는 화면을 만든다.
3. **Bareos 백업 전용 화면**을 만든다 — vCenter 처럼 **28개 법인마다 따로** 보고, **28개 법인을 통합**해 보는 화면도 둔다.
4. 시안과 설계를 먼저 보여 준다(이 문서 + 캔버스).

## 2. 지금 있는 것(코드 근거) — 새로 만들지 않아도 되는 부분

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| 백업 방식(사람이 정한 값) `veeam·clone·config·none·check` | 서버 `veeam/backupMarks.js METHOD_VALUES` · `veeam/backupStatus.js METHOD_TEXT` · 웹 `views/tools/backupViewText.js METHODS` · 단축키 `METHOD_KEYS_MAP`(V·C·G·N·K) | 값 하나(`bareos`)를 **같은 자리 전부**에 추가(§4.1) |
| Bareos VM 백업 도구 `bareos-backup`(v2.820~v2.825, admin 전용) — 탭 '백업 대상 · 실행 현황·이력 · 설정' | `web/src/views/tools/BareosBackupTool.jsx` · `server/src/routes/api/bareosBackup.js` · `server/src/bareos/` | 전용 화면은 **이 도구의 탭을 늘리는 방식**(§4.2) — 잡 등록·실행·복원은 그대로 이 탭들이 맡는다 |
| 백업 대상 원장(잡) `{ vcenterId, vmId, vmName, dc, folder, directorId, lastRun, pending, finishedRuns… }` | `server/src/bareos/registry.js`(`bareos-jobs.json`, **MAX_JOBS 500**) | 법인별·통합 화면의 **1차 자료** — Director 에 접속하지 않고 원장 + 폴러 반영값만 읽는다 |
| 법인별 Director 설정 v2 `directors[]` + `sites[].directorId`(vCenter → 법인 Director) | `server/src/bareos/settings.js` | '법인' 축 = `sites[].vcenterId` 로 묶인 vCenter 1개 = Director 1개 |
| 폴러(Director 별 시한 병렬 · 인증 정지 · 엣지 대행 결과 모름) | `server/src/bareos/poller.js` · `ops.js` · `edgeOps.js` | 화면의 Director 상태 점(정상·경고·인증 정지·미설정)과 '결과 모름' 의 출처 |
| 트리 배지 API `GET /tools/bareos-backup/badges?vcenterId=` | `bareosBackup.js` · `VCenterDetail.jsx`(`bareosSet`) | 'Bareos 잡이 있는 VM 집합' 의 기존 판정 — 새 화면도 같은 집합 규칙을 쓴다 |
| 폴더 단위 '이 폴더 백업'(200대 상한) | `VCenterDetail.jsx` 1098행(`onGo(ids.slice(0, 200))`) | Detail 선택 바의 'Bareos 백업 대상으로 등록 →' 가 같은 넘기기 규약을 쓴다 |
| Backup 상단 탭 머리 `VeeamHeader`(Summary · Detail · EM · 백업 실행 · Bareos) | `web/src/views/tools/VeeamHeader.jsx` | 탭을 늘리지 않는다 — Bareos 탭 **안쪽**에 하위 탭을 둔다 |
| 범위·데모 가림(`scoped`·`omittedOutOfScope` · `readDirector({ demoOnly })` · Director 주소 가림) | `bareosBackup.js` GET 본문 | 새 조회 라우트도 **같은 모양**으로(§6) |

## 3. 정보 구조(IA)

```
Backup 현황 (VeeamHeader — 그대로)
 ├ Summary · Detail · EM · 백업 실행           (기존)
 └ Bareos  (#/tools/bareos-backup)             (기존 탭 — 안쪽 하위 탭을 3 → 5개로)
    ├ 통합 현황      #/tools/bareos-backup/summary   ← 신설 · 28개 법인 한 표 (시안 ③)
    ├ 법인별 현황    #/tools/bareos-backup/detail    ← 신설 · 법인 1개의 Bareos 방식 VM 폴더 트리 (시안 ② · 400px 는 ④)
    ├ 백업 대상      (기존 targets)
    ├ 실행 현황·이력 (기존 history)
    └ 설정          (기존 settings · 전체 범위 관리자만)
```

- Detail 화면(시안 ①)은 **기존 화면에 Bareos 를 끼워 넣는 변경**이다 — 새 화면이 아니다.
- '별도의 VM 폴더 화면' = **법인별 현황** 탭. 백업 방식이 Bareos 인 VM(+ 잡은 있는데 방식이 다른 VM 은 '방식 불일치' 로)만 폴더 › VM 트리로 보인다.
  Veeam·Clone·그 외 VM 은 이 화면에 없다(Detail 이 맡는다 — 화면 복제 금지 규칙).
- **통합 현황** 은 Backup Summary(`BackupSummaryTool.jsx`)의 '법인별 현황' 표와 같은 모양(바로가기 바 · KPI · 법인별 표 · 우선순위 목록)으로 맞춘다 — 사용자가 이미 익힌 배치.

## 4. 설계

### 4.1 백업 방식 'bareos' 추가 (시안 ①)

- 값: `bareos` · 글자 `Bareos` · 칩 색 `#fdba74`(주황 — 기존 5색과 색상·명도 모두 구분. 글자와 함께 쓴다) · 단축키 **B**.
- 바꾸는 자리(한쪽만 고치면 테스트가 깨지는 쌍이다):
  - 서버 `veeam/backupMarks.js METHOD_VALUES` · `veeam/backupStatus.js METHOD_TEXT` · CSV/엑셀 내보내기(`vmListCsv.js`·`vmListXlsx.js` 의 방식 열이 `METHOD_TEXT` 를 쓰는지 확인)
  - 웹 `backupViewText.js METHODS` · `METHOD_FILTERS`(자동) · `METHOD_KEYS_MAP` 에 `b: 'bareos'` · `methodGbTotals`(자동) · 칸 읽는 법 문구
  - 테스트: `backupViewText.test.js`(서버·웹 글자 대조) · 단축키 테스트 · 데모 `mock/demo/backup.js` 에 Bareos 표시 VM 몇 대
- **규칙 유지**: 백업 방식은 사람이 정한 값만(v2.803 — 수집값으로 추정하지 않는다). Bareos 잡이 있다고 방식을 자동으로 `bareos` 로 바꾸지 않는다.
  대신 두 자료의 **불일치를 센다**(0 으로 섞지 않는다):
  - **미등록** = 방식 `bareos` ∧ 원장에 잡 없음 → Detail 필터 'Bareos 미등록', 법인별 KPI, 통합 표의 '미등록' 열
  - **방식 불일치** = 원장에 잡 있음 ∧ 방식 ≠ `bareos` → 법인별 필터 · 통합 KPI
  - 선택지(사용자 결정): '원장 기준으로 방식 일괄 표시' 버튼(사람이 누른다 — 자동 아님). 기본 시안에는 넣지 않았다.
- Detail 의 '백업' 열: Veeam 칩과 같은 꼴로 `Bareos 월-일 시:분` + `레벨 · 결과 · 바이트`. 자료는 원장 `lastRun`(폴러 반영값) — 요청 때 Director 에 접속하지 않는다.
  폴더 줄에 세 번째 막대(Bareos 잡 수 / 전체)를 더한다. 요약 카드에 'Bareos 백업 N · %'.
- 선택 바: 'Bareos 백업 대상으로 등록 →' = 고른 VM id 를 `#/tools/bareos-backup`(백업 대상 탭)으로 넘긴다(200대 상한 — '이 폴더 백업' 과 같은 규약). 등록·실행은 그 화면(관리자 · OTP).

### 4.2 Bareos 탭의 하위 탭 2개 신설 (시안 ② ③ ④)

- `BareosBackupTool.jsx TABS` 에 `['summary','통합 현황']`·`['detail','법인별 현황']` 를 **앞에** 추가하고 기본 탭(fallback)을 `summary` 로 바꾼다
  (지금 `targets`). `useHashTab` 이 주소 `#/tools/bareos-backup/<tab>` 를 그대로 쓴다 — 도구 키는 바뀌지 않는다.
- **법인별 현황**(`BareosDetailTab`):
  - 법인 선택: `Select`(vCenter 목록 = `mappedVcenters` ∪ 원장에 잡이 있는 vCenter) + 바로가기 바(법인 칩 + Director 상태 점). Summary → Detail 의 `DETAIL_VC_KEY` 처럼
    통합 표에서 고른 법인을 이어받는다(이 브라우저에만).
  - 머리 카드: Director 이름·접속 상태·담당(중앙/엣지)·마지막 조회·FD/SD/풀/스케줄/기본 레벨(범위 계정·데모 계정에는 주소·콘솔 이름 가림 — 기존 `masked` 규칙).
  - KPI 7: Bareos 방식 VM · 잡 등록(활성·비활성) · 미등록 · 마지막 결과(성공·경고·실패) · 지금 백업 중 · 오래된 백업(기준은 Detail 의 '오래된 백업 기준' 과 같은 API 값) · 백업 용량·복원 지점.
  - 필터 탭: 전체 · 잡 등록 · 미등록 · 진행 중 · 실패·경고 · 오래된 백업 · 비활성 · 방식 불일치 · 검색(VM·폴더·잡 이름).
  - 표(`STable` · 폴더 트리): vCenter › 폴더 › VM · 전원 · 용량 · 마지막 백업(레벨·결과·바이트) · 복원 지점 · 스케줄·레벨 · 잡·상태. 폴더 줄 = 잡 등록 수/전체 + 결과 막대(성공·경고·실패·진행, 빈칸 = 미등록).
    폴더 경로는 원장 `folder`(등록 때 값)가 아니라 **인벤토리의 현재 `folderPath`**(`vcenter/vmPlacement.js`)로 그린다 — VM 이 옮겨졌으면 현재 위치가 맞다. 원장 `folder` 는 상세 패널에 '등록 때 위치' 로만.
  - 오른쪽 패널: 고른 VM 의 잡·Director·클라이언트·스케줄·복원 지점·등록자 + 최근 실행 5건(`finishedRuns`) + 버튼(지금 백업 ▾ · 복원 … · 로그 · 백업 대상에서 보기).
    버튼은 기존 TargetsTab 의 동작(POST 라우트·OTP·처리 중 잠금 `targetLocks`)을 **그대로 호출**한다 — 판정·문구는 `bareosText.js` 하나.
  - 400px(시안 ④): 패널이 표 아래로, 탭 줄은 가로 스크롤(`tabstrip-noscroll`), 열은 이름·결과·용량·한 줄 요약으로.
- **통합 현황**(`BareosSummaryTab`):
  - KPI 7: 법인·Director(정상·경고·인증 정지·미설정) · Bareos 방식 VM · 잡 등록 · 미등록·방식 불일치 · 최근 24시간 결과(+결과 모름) · 지금 백업 중 · 오래된 백업.
  - 바로가기 바(28개 법인 칩 — Backup Summary 와 같은 모양, 누르면 표의 그 줄로) + 다빈치/IRS/주의 칩.
  - 법인별 표(`STable` · 제목 정렬 · 값 없는 줄은 뒤): 법인 · Director · Bareos VM · 커버리지 막대 · 성공 · 경고·실패 · 진행 · 미등록 · N일+ 경과 · 복원 지점 · 용량 · 마지막 백업 · 열기.
    인증 정지·미설정 법인은 수치 칸이 `—`(**0 이 아니다**) 이고 커버리지는 '모름'.
  - 우선 확인 2표: 실패·결과 모름 / 미등록·오래된 백업(중요도 상 먼저).

### 4.3 서버 API (신설 2개 · 모두 조회 전용)

| 라우트 | 하는 일 | 자료 |
|---|---|---|
| `GET /tools/bareos-backup/detail?vcenterId=` | 법인 1개: Bareos 방식 VM ∪ 잡 있는 VM 을 폴더 트리로 · KPI · 불일치 | 인벤토리(`store`) + `backupMarks.getMarks()` + `registry.listJobs()` + 폴러 상태(메모리) |
| `GET /tools/bareos-backup/summary` | 28개 법인 집계 + 우선순위 VM 목록 | 위와 같음 — vCenter 마다 O(VM) 한 번 |
| `GET …/detail.csv` · `…/summary.csv` | 내보내기 | 동시 1건(`util/exportBusy.js`) |

- **Director 접속 없음**: 폴러가 마지막으로 반영한 원장 값만 읽는다. 고RTT 법인(폴란드·미국 동부 800ms+)이 화면을 늦추지 않는다. 화면 폴링은 기존 Bareos 탭의 `usePolling(BASE, …, 10_000)` 를 늘리지 않고 — 새 탭은 **마운트 1회 + 새로고침 버튼 + 60초**(무거운 집계 15초 금지 규칙).
- **응답 캐시**: `memoJson` + `extraKey: scopeKey(req) + marksRev() + registry rev + poller tick` — 표시를 저장하면 즉시 수가 바뀌어야 한다(`marksRev` 가 이미 그 용도).
- **못 읽은 값은 null**(`numOrNull`): 표시 파일 손상(`marksUnreadable`)·원장 로드 오류(`registryLoadError`)·인증 정지·결과 모름은 0 으로 내리지 않고 `null` + 안내 배너(`settingsUnreadable`/`registryUnreadable` 와 같은 모양, 503 은 쓰기에만).
- 집계는 요청 경로에서 28 × VM 수(≈5,850)를 한 번 도는 O(N) — 현재 규모에서는 조각 양보가 필요 없지만, VM 수가 커지면 `createYielder` 를 붙일 자리를 함수 하나로 모아 둔다.

### 4.4 ⚠ 원장 상한 — 통합 운영의 전제

`registry.js MAX_JOBS = 500`. 28개 법인 × 법인당 수십~백여 대면 금방 닿는다(시안의 가상 수치만으로 1,231). 전용 화면을 만들기 **전에** 상한을 올려야 한다(예: 5,000).
파일 1개(`bareos-jobs.json`)를 원자적으로 통째로 쓰는 구조다. 폴러 쓰기는 이미 틱당 1회로 묶여 있다(`registry.inBatch` · 변경 없으면 쓰지 않음 — poller.js 133행) —
남는 문제는 **크기**다: 잡 5,000 × 약 1KB(복원·끝난 실행 이력 포함) ≈ 5MB 를 `JSON.stringify(…, null, 2)` 로 동기 기록하면 틱마다 수십 ms 의 이벤트 루프 점유가 된다(추정 — 실측 전).
→ 상한을 올릴 때 들여쓰기 제거·크기 실측·필요하면 Director 별 파일 분할을 함께 본다. 이 항목은 구현 1단계의 선행 작업이다.

## 5. 권한 · 범위 · 데모

- 도구 키는 그대로 `bareos-backup` 이고 **admin 전용**이다(`specialToolsList.js adminOnly: true`, `toolAccess.js`). 통합·법인별 현황은 조회 화면이라 운영자(비관리자)도 보고 싶을 수 있다.
  - **선택지 A(권장)**: 조회 전용 도구 키 `bareos-summary`·`bareos-detail` 를 새로 만들고(adminOnly 아님 · `toolcats/catalog.js` '보호/규정' 소속 · 서버 `toolAccess` 매핑), Bareos 탭 안의 하위 탭이 그 키의 허용 여부로 보인다. 실행·복원 버튼은 `bareos-backup` 권한이 있을 때만.
  - **선택지 B**: 기존 키 안의 탭으로만 두고 관리자만 본다(작업 최소 — 시안은 이 모양으로 그렸다).
- 범위 계정: `scopeQuery` → 서버가 자기 vCenter 만(기존 GET 의 `scoped`·`omittedOutOfScope` + `ScopeOmitBanner`). 통합 표는 자기 법인만 보인다.
- 데모 계정: `readDirector({ demoOnly })` · Director 주소·콘솔 이름·오류 원문 가림(`masked`) — 새 라우트도 같은 함수를 지난다(`audit2719b` 스윕이 모양을 대조).
- 쓰기(지금 백업·복원·등록)는 **새로 만들지 않는다** — 기존 POST 라우트 + OTP 그대로.

## 6. 테스트 계획

- 서버: `bareosView.test.js` — 방식·원장 네 조합(등록+방식 / 미등록 / 불일치 / 둘 다 없음)이 각 칸에 **한 번씩만** 들어가는가 · 인증 정지 법인이 `null` 인가 · 범위 계정 생략 · 데모 가림 · 캐시 키에 `marksRev` 포함.
- 서버/웹 대조: `METHOD_TEXT` ↔ `METHODS` 글자 · 단축키 B · CSV 열.
- 웹: `bareosViewText.test.js`(폴더 줄 수 · 막대 비율 · '—' 규칙) · `specialToolsList`·`toolcats` 대조(선택지 A 일 때).
- 화면: Chromium 1440/400 · 오류 0 · 가로 넘침 0 · 탭 전환 · 법인 선택 · A/B.

## 7. 단계와 추정(구현 승인 후)

| 단계 | 내용 | 예상 |
|---|---|---|
| 0 | 원장 상한·쓰기 모으기(§4.4) + 테스트 | 40분 |
| 1 | 백업 방식 `bareos`(§4.1) — 서버·웹·CSV·단축키·데모·테스트·Detail 열·막대·선택 바 | 60분 |
| 2 | `GET …/detail` + 법인별 현황 탭(§4.2) + 400px | 90분 |
| 3 | `GET …/summary` + 통합 현황 탭 + CSV | 70분 |
| 4 | (선택지 A) 조회 전용 도구 키 2개 · 카탈로그 · 권한 테스트 | 30분 |
| 5 | 문서(`docs/rules/vcenter.md` 또는 새 `docs/rules/bareos.md`) · 릴리스 | 20분 |

합계 약 5~5.5시간(선택지 B 면 4 단계 생략). 30분을 넘으므로 착수 전에 방식(① 전체 검증 ② 표준 ③ 빠르게)을 묻는다.

## 8. 사용자 결정이 필요한 것

1. 권한 모양 — 선택지 A(조회 전용 도구 키 신설, 운영자도 봄) / B(관리자만).
2. Bareos 칩 색 `#fdba74`(주황) — 다른 색을 원하면 명도가 기존 5색과 비슷한 것으로.
3. '원장 기준으로 방식 일괄 표시' 버튼을 둘지(자동 표시는 규칙상 하지 않는다).
4. 원장 상한 값(예 5,000)과 §4.4 선행 작업 승인.
5. 기본 탭을 '통합 현황' 으로 바꾸는 것(지금은 '백업 대상').

## 9. 구현 결과 (v2.828.0 — 사용자 결정 '권장안 A · 표준 검증')

정한 값: 권한은 A(조회 전용 도구 키 신설) · 칩 색 주황 `#fdba74` · '원장 기준으로 방식 일괄 표시' 버튼은 넣지 않음 · Bareos 상단 탭은 통합 현황 권한이 있으면 통합 현황으로 연다.

| 위 설계 | 실제 구현 | 이유 |
|---|---|---|
| 하위 탭 `#/tools/bareos-backup/summary`·`/detail` | **별도 도구 키** `#/tools/bareos-summary`·`#/tools/bareos-detail`(라우트 `/api/tools/bareos-summary`·`/bareos-detail` + `.csv`) | 권장안 A — 관리 도구(`bareos-backup`)는 adminOnly 라 그 안의 탭이면 운영자가 못 연다. 도구 키 = 경로 첫 마디 규약(`audit2613a`) |
| 원장 상한 5,000 | **3,000** + 들여쓰기 없는 쓰기 | 실측(대상마다 끝난 실행 10건): 5,000개면 파일 8MB·쓰기 54ms·`listJobs` 깊은 복사 47ms. 3,000 은 그 6할. 조회 화면은 깊은 복사 없는 `jobDigests` 를 쓴다 |
| Detail 백업 열에 Bareos 세 번째 줄 | 'Clone' 열을 **'Clone · Bareos'** 로(그 vCenter 에 Bareos 칸이 있을 때만) + 폴더 줄 주황 막대 | 1440 폭의 열 수를 늘리지 않으려고 |
| 통합 KPI '최근 24시간 결과' | **'마지막 결과'**(잡마다 마지막으로 끝난 실행) | 원장이 실행 시각별 이력을 10건만 남겨 24시간 창을 정확히 셀 수 없다 — 지어내지 않았다 |
| viewer 도 조회 | **'특수 기능(tools)' 권한이 있는 계정**(기본: admin·operator) | 다른 도구와 같은 권한 축. viewer 에게 열려면 권한 매트릭스에서 tools 를 준다 |

남은 것(정직 기록):
- 데모 모드에서 백업 방식 표시는 실제 파일이라 Bareos 방식 VM 은 0 으로 시작한다(데모 Director 는 대상 5개만 시드 — '방식 불일치' 로 보인다).
- Director 시각은 Director 현지 시각을 포탈 현지 시각으로 읽는다(기존 규칙 그대로 — 시간대가 다르면 '오래된 백업' 판정이 어긋난다).
- 포탈이 등록하지 않은 Bareos 잡(Director 에 손으로 만든 잡)은 원장에 없어 세지 않는다.

