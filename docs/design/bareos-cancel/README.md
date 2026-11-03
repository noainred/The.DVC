# 설계: Bareos 백업 중단 · 취소 — 단일 실행 취소 · 그룹 회차 중단

작성 2026-11-03 (v2.864.0 기준) · 상태 **구현됨 v2.867.0**(컨펌 2026-11-03 '좋아 구현해' · 기본값 5가지 · 표준 검증 — 아래 §9) · 시안 캔버스: https://claude.ai/artifact/1Q74iZfJV9BMgYFcntpfEg
(아트보드 6장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명·VM 이름·수치는 가상이고 색·글자는 `web/src/styles.css` `:root` 토큰 그대로.
계정에 등록된 ‘Design System’ 아티팩트는 내용이 비어 있어 쓰지 않았다.)

## 1. 요구 (사용자 요청 2026-11-03)

- "bareos 백업 중단/취소 기능 만들어줘, 단일 백업 중단, 그룹 백업 중단 기능 — 어떻게 만들건지 클로드 디자인으로 설계해서 보여줘"
- 규칙(같은 날 '기억해'): 설계는 Fable + Claude Design 시안 → **컨펌 뒤** Opus 구현.

## 2. 지금 있는 것(코드 근거) — 새로 만들지 않아도 되는 부분

| 있는 것 | 위치 | 이번 설계에서의 쓰임 |
|---|---|---|
| 단일 취소 API `POST /tools/bareos-backup/jobs/:id/cancel` — admin · 대상 잠금 `oneAtATime` · jobid = body.jobid ∥ pending ∥ lastRun · Director 없음(orphan)이면 추적만 해제 · 감사 'Bareos 백업 취소' | `server/src/routes/api/bareosBackup.js:868~900` | **그대로 쓴다**. 응답에 `canceling:true` 만 더하고 원장 `pending.cancel = {at, by}` 를 적는다 |
| Director 작업 `ops.cancel` — `llist jobid` 로 행 확인 → 잡 이름 불일치 거부 → 끝난 행 `{final}`(type B 만 반영) → Director 가 모르면 `{cleared}` → `cancel jobid=N` | `server/src/bareos/ops.js:300` · `director.js cancelJob` | 단일 취소의 코어. 묶음 취소 `cancelJobs` 는 이 함수를 항목마다 **한 세션 안에서** 돈다 |
| 엣지 대행 — `cancel` TTL 120초 · `edgeResult.js cancel` 정제 · `MUTATING` 등재 | `edgeOps.js:37` · `edgeResult.js:131` | 새 작업 `cancelJobs` 는 같은 자리에 등재(TTL 150초 · VALUE 표) |
| 단일 취소 화면 — 백업 대상 오른쪽 패널의 '취소' 버튼(실행 중일 때 '지금 백업' 자리) · `window.confirm` | `web/src/views/tools/BareosBackupTool.jsx:216·334` | 버튼은 그대로, 확인 창만 시안 ② 모달로 교체 |
| 진행 현황판 '실행 중' 표(VM · jobid · 그룹 · 실행 주체 · 레벨 · 경과 · Director 상태 · 진행량 · 속도 · 판정) · 4초 재읽기 · 열린 동안만 Director 조회 | `web/src/views/tools/BareosLiveTab.jsx:240~` · `routes/api/bareosLive.js` | 행 끝에 '동작' 열('취소…') · 위에 그룹 회차 띠 · 판정 칩에 '멈추는 중' |
| 그룹 실행 `queueGroupRun → onDirLine(줄 대기 _queued) → runGroup(_groupBusy · VM 잠금 · Director 마다 RUN_JOBS_MAX=50 씩 runJobs · started 는 markPending)` · 결과 `lastFire{started·skipped·notSent·failed·unknown·items[]}` · `signal` 인자(시한용) | `server/src/bareos/groupRunner.js` | **중단 경로가 없다** — 세 단계(줄 대기 · 보내는 중 · Director 실행 중)마다 멈추는 길을 더한다(§4.2) |
| 그룹 카드 — 실행 중엔 '지금 백업' 이 비활성 '실행 중' · `sending` 배너 · 마지막 회차 줄 | `web/src/views/tools/BareosGroupsTab.jsx:383~` | 그 자리가 '회차 중단…' 으로 바뀐다(시안 ④) |
| 보관 정리 `pruneDue` — lastFire.started>0 이고 그 VM 들의 pending 이 끝나면 카탈로그 삭제 | `groupRunner.js:245` | 중단된 회차(`lastFire.canceled`)로는 돌지 않게 조건 하나 추가 |
| 상태 코드 `A → canceled`(`names.js statusOf`) · 일일 요약이 취소를 따로 셈(`digest.js`) · `vmView` 는 canceled 를 fail 쪽에 | `names.js:140` · `digest.js:126` · `vmView.js:77` | 취소 결과의 표시는 이미 있다 — '멈추는 중' 만 새 상태 |

## 3. 화면(IA) — 어디서 누르나

```
Bareos › 운영(관리자)
 ├ 백업 대상   오른쪽 패널 '취소'                      (있음 — 확인 창만 ②)
 ├ 백업 그룹   카드 · 상세의 '지금 백업' 자리 → '회차 중단…'  (④ · 확인 창 ③)
 └ 진행 · 이력 실행 중 표 행 끝 '취소…'(②) · 그룹 회차 띠 '회차 중단…'(③) · 판정 칩 '멈추는 중'   (①)
```

- 한 대상의 취소 버튼은 어느 화면에서 눌러도 **같은 라우트 · 같은 확인 창**이다(판정 코어 하나).
- '멈추는 중' 은 화면 셋에 같은 칩(`BareosLiveTab` · 백업 대상 패널 · 그룹 카드)으로 보인다 — 원장 `pending.cancel` 하나에서 나온다.

## 4. 설계

### 4.1 단일 실행 취소(시안 ② · 바뀌는 것은 확인 창과 상태 표시뿐)

- 확인 창(모달 — `window.confirm` 교체): 지금(레벨 · 시작 · 경과 · 진행량) · 하는 일(cancel 명령 · FD 가 멈추기까지 수 초~수 분) · 결과(취소로 기록 · 복원 지점 아님) ·
  알아 둘 것 3줄(스냅샷 남을 수 있음(추정) · 그룹의 다른 VM 은 계속 · 삭제가 아님 · OTP 없음) · 버튼 '취소 보내기'.
- 상태 변화: 실행 중 → **멈추는 중 n분 n초**(원장 `pending.cancel = {at, by}` · 버튼 '취소 보냄' 잠김 · Director 상태 원문 그대로) → 취소됨(폴러가 A 행을 보면 `lastRun.state='canceled'` — 지금 동작).
  - **멈추지 않음**: 폴러가 `pending.cancel.at + CANCEL_WAIT_MS(10분)` 를 넘겨도 running 이면 `pending.cancel.stuck=true` → 칩 '멈추지 않음' · 버튼 '다시 보내기' 로 풀림 · 'Director 에서 확인' 안내.
  - 이미 끝남: 지금처럼 400 `finished` + 결과 반영.
- 라우트는 그대로(`jobs/:id/cancel`). 성공 응답에 `canceling: true` · 원장에 `pending.cancel` 을 적는 것만 추가. `clearPending` 때 cancel 도 함께 지운다.

### 4.2 그룹 회차 중단(시안 ③ ④ ⑤ — 새 기능)

그룹 실행은 세 단계를 지난다. 단계마다 '중단' 이 하는 일이 다르고, 확인 창이 그 수를 먼저 보여 준다.

| 단계 | 판정 | 중단이 하는 일 | 회차 기록 항목 상태 |
|---|---|---|---|
| 줄 대기 | `_queued.has(id)` | 줄에서 뺀다 — 아무것도 보내지 않는다 | 전부 `halted`(시작 전 멈춤) |
| 보내는 중 | `_groupBusy.has(id)` ∧ 덩어리 사이 | 그룹의 `AbortController` 를 abort → 다음 덩어리를 보내지 않는다. **보내는 중인 덩어리는 끊지 않고** 회신을 받은 뒤 그 jobid 들을 취소(도중에 끊으면 '결과 모름' 이 된다 — v2.830 L4 규칙) | 안 보낸 것 `halted` · 보낸 것은 아래 줄 |
| Director 실행 중 | `markPending` 된 jobid 들 | 이번 회차가 시작한 jobid 묶음을 **법인 쪽에서 한 번에** 취소(`ops.cancelJobs`) · 각 VM 에 `pending.cancel` | 취소 보냄 `canceled` · 끝난 것은 그대로(`started` 유지, lastRun 이 결과) |

- 라우트 `POST /tools/bareos-backup/groups/:id/cancel` — admin · 쓰기 범위(`groupFor(req,res)` 와 같은 판정) · 데모 403 · body `{ confirmName, includeScheduled?: false, skipNext?: false }`.
  - `confirmName !== g.name` → 400. 그룹이 실행 중이 아니면 409('실행 중인 회차가 없습니다'). 이미 멈추는 중이면 409.
  - 응답 202 `{ ok, phase: 'queued'|'sending'|'running', halted, canceling, kept }`. 뒤 일은 비동기(엣지 대행이면 몇 분) — 화면은 4초 재읽기로 따라간다.
  - 범위 `includeScheduled`: 이 그룹 VM 의 `lastRun.state ∈ running·queued·waiting` 인 jobid(Bareos 스케줄 · 수동 실행)도 함께 취소(사용자 결정 ①).
  - `skipNext`: `groups.json` 에 `skipSlot = 다음 회차 key` 를 적고 `decideFire` 가 그 회차를 '건너뜀(사용자 선택)' 으로 기록(사용자 결정 ③).
- `groupRunner.js`:
  - `_cancel: Map<groupId, {ctrl: AbortController, at, by, scope}>` · `cancelGroupRun(groupId, o)` — 줄 대기면 `_queued` 에서 빼고 `onDirLine` 의 일을 건너뛰게 표지 · 보내는 중이면 `ctrl.abort()` · 그 뒤 `ops.cancelJobs` 를 Director 마다 한 번.
  - `runGroup` 의 덩어리 루프: 덩어리를 보내기 **전에** `signal.aborted` 면 남은 VM 을 `halted` 로 적고 루프를 끝낸다. 덩어리 회신 뒤 aborted 면 그 회신의 started jobid 들을 취소 목록에 넣는다.
  - 중단 중(`_cancel.has(id)`)에는 `groupRunning` 이 true — 같은 그룹 '지금 백업' · 수정 · 삭제 409(지금 규칙 그대로).
  - 회차 기록 `lastFire.canceled = { at, by, phase, scope, canceled, halted, kept }` · 항목 state 에 `canceled` · `halted` 추가(`chunkErrorState`·`itemState` 는 그대로 — 둘은 보내기 결과만 판정).
- `ops.cancelJobs(s, { items: [{ key, jobid, name }] })` — 항목마다 `ops.cancel` 과 같은 검사(행 확인 · 이름 대조 · 끝난 행 `final` · 모르는 행 `cleared`) · 한 세션 · 결과는 항목별 `{ key, canceled|final|cleared|error }` · 항목 상한 `RUN_JOBS_MAX`.
  `MUTATING` 등재 · `edgeOps` TTL 150초 · `edgeResult` VALUE 표(숫자 key 보존 · 필수 값 없으면 결과 모름). 묶음의 '결과 모름' 은 VM 마다 `pending.cancel.unknown=true` 로 두고 폴러가 결과로 덮는다.
- 폴러(`poller.js`): A 행을 보면 지금처럼 canceled 로 끝냄 · `pending.cancel` 이 있고 10분 넘게 running 이면 `stuck` 표지 · 회차의 모든 pending 이 끝나면 `lastFire.canceled.done=true`(카드의 '멈추는 중' 이 '중단됨' 으로).
- 보관 정리: `pruneDue` 에 `if (g.lastFire.canceled) return false` — 중단된 회차로는 돌지 않는다(사용자 결정 ④). 다음 정상 회차가 끝난 뒤 돈다(카드에 그 사실을 적는다).
- 옛 엣지: `cancelJobs` 를 모르면 '알 수 없는 작업' 회신 → 라우트 결과 `error: '법인 엣지를 업그레이드한 뒤 다시 시도'` · 단건 취소를 N번 돌려보내지 않는다(WAN 왕복 — 사용자 결정 ⑤). 단건 '취소…' 는 그대로 된다.

### 4.3 화면 세부(시안 ① ④ ⑥)

- 진행 · 이력(①): KPI 에 '멈추는 중' · '오늘 취소' · 그룹 회차 띠(그룹마다 한 줄 — 보냄 n/N · 실행 중 · 시작 대기 · 끝남 · 단계 · '회차 중단…') · 멈추는 중 띠(요청 시각 · 범위 · 취소 보냄 · 취소됨 · running · 시작 전 멈춤 · 경과) ·
  실행 중 표 '동작' 열('취소…' / 잠긴 '취소 보냄' + 사유 풍선) · 판정 칩 '멈추는 중 n분 n초' · 시작 대기 N 상자('회차를 중단하면 보내지 않는다').
  표는 `STable`(정렬) · '동작' 열은 `data-nosort` · 1440 에서 열 10개가 넘치면 가로 스크롤 상자.
- 그룹 카드(④): 실행 중 — 진행 막대(끝남 · 실행 중 · 대기) + '회차 중단…' · 멈추는 중 — 주황 테두리 · 막대(성공 · 취소됨 · running · 시작 전 멈춤) · 잠긴 '중단 보냄' ·
  중단 뒤 — 마지막 회차 줄 '중단됨 시각 · 계정 · 성공 · 취소 · 시작 전 멈춤' · 보관 정리 안내 · 스냅샷 남음 안내(추정) · 다음 실행에 '건너뜀' 표시.
  마지막 실행 창(FireModal)의 결과 열에 '취소' · '시작 전 멈춤' · '멈추지 않음'.
- 400px(⑥): 카드 버튼 줄바꿈 · 확인 창 전폭 · 표는 가로 스크롤 상자.
- 문구: 백틱 0 · 값 인용은 ‘ ’ · 주기·상한 숫자(10분 · 150초)는 API 값으로 내려 화면에 박지 않는다.

### 4.4 권한 · 범위 · 데모

- 두 라우트 모두 admin + 쓰기 범위(조회 밖 404 → 쓰기 밖 403 — `jobFor`·`groupFor` 그대로) · 데모 계정 403(`SAFE_ACTIONS` 아님).
- OTP 는 묻지 않는다(멈춤은 데이터를 지우지 않는다 · 지금 단일 취소도 OTP 없음) — 사용자 결정 ②에서 바꿀 수 있다.
- 감사: 'Bareos 백업 취소'(있음) · 'Bareos 그룹 회차 중단'(새 — 그룹 · 회차 · 범위 · 취소 n · 시작 전 멈춤 n · 계정).
- 범위 계정 화면: 자기 법인 행만 · 쓰기 범위 밖이면 버튼 잠김 + 사유(`targetLocks` 규칙 그대로).

## 5. 사용자 결정(컨펌 때 골라 주세요 — 캔버스의 주황 메모와 같다)

| # | 쟁점 | 기본값(시안) | 다른 선택 |
|---|---|---|---|
| ① | 그룹 중단 범위 | 이번 회차가 시작한 실행만 | 체크박스 '이 그룹 VM 의 실행 중 전부'(Bareos 스케줄 · 수동 포함) |
| ② | 그룹 중단 확인 | 그룹 이름 재입력 · OTP 없음 | OTP 도 받기(`bareosSetupOtp` 처럼 끌 수 있게) |
| ③ | 다음 예약 회차 | 그대로 돈다 | 체크박스 '다음 회차 1회 건너뛰기' |
| ④ | 중단된 회차의 보관 정리 | 하지 않는다 | 그 회차로도 돌린다(기준 Full 어긋남 위험 — 권하지 않음) |
| ⑤ | 옛 엣지 | '엣지 업그레이드' 안내 · 단건 취소는 됨 | 단건 취소 N번 폴백(WAN 왕복 N회 — 사용자 원칙에 어긋남) |

## 6. 하지 않는 것(정직 기록)

- '일시 정지 · 재개' — Bareos Director 에 잡 일시 정지 명령이 없다(취소뿐). 재개는 '지금 백업' 으로 다시 돌린다.
- 법인 전체 '모든 실행 취소' 버튼 — 한 번에 수십 대를 멈추는 실수 위험. 그룹 단위까지만.
- 복원 작업 취소 — 이번 범위 밖(복원은 `ops.restore` 가 별도 pending). 다음 과제 후보.

## 7. 실환경 미확인(추정 — `tools/bareos-probe.js` 로 확인할 것)

- 취소 뒤 VMware 플러그인이 스냅샷을 거두는지(남을 수 있다고 안내했다 — 실측 없음).
- `cancel jobid=N` 뒤 Director 상태 원문('is waiting for client to cancel' 등)과 A 로 끝나기까지 시간.
- 취소(A)된 잡 다음 Incremental 의 기준 시각 — Bareos 가 마지막 **성공(T·W)** 잡을 기준으로 잡는다고 보았다.

## 8. 테스트 계획(컨펌 뒤 구현 때)

- `ops.cancelJobs`: 항목마다 `ops.cancel` 과 같은 입력에서 같은 결과(한 함수) · 상한 · 이름 불일치 거부 · 끝난 행 final · 모르는 행 cleared · `edgeResult` 정제(숫자 key · 필수 값).
- `groupRunner`: 줄 대기 중단 → 아무것도 보내지 않고 전부 halted · 보내는 중 중단 → 다음 덩어리 안 보냄 + 보낸 덩어리 회신 뒤 취소 · 실행 중 중단 → cancelJobs 한 번(Director 마다) · 중단 중 지금 백업·수정·삭제 409 · `pruneDue` 가 canceled 회차에 false · skipNext 가 한 회차만.
- 라우트: 이름 불일치 400 · 실행 중 아님 409 · 범위(조회 밖 404 · 쓰기 밖 403) · 데모 403 · 감사 한 줄 · 응답에 비밀 없음.
- 폴러: `pending.cancel` 10분 → stuck · A 행 → canceled 로 끝 · 회차 전부 끝나면 `canceled.done`.
- 웹: 확인 창 문구(백틱 0) · 멈추는 중 칩 셋이 같은 함수 · 400px 줄바꿈 · Chromium 1440/400(목 서버 — 데모 Director 는 실행이 30초라 '멈추는 중' 을 보려면 목에 cancel 지연을 둔다).
- 변이 검증 + 반증 1인: 쓰기 경로(중단 · 범위 · 보관 정리 · 엣지 회신) — 동시성 · 데이터 손실 부류라 위험 수정에 해당.

## 9. 구현 결과(v2.867.0 — 2026-11-03)

- 사용자 결정은 시안 기본값 그대로(§5 ①~⑤): 이번 회차만(범위 확대는 체크박스) · 그룹 이름 재입력 · OTP 없음 · 다음 회차 그대로(건너뛰기는 체크박스) · 중단 회차 보관 정리 안 함 · 옛 엣지는 업그레이드 안내.
- 버전: 시안 작성 때 v2.865 로 적었으나 그사이 main 에 2.865.0 · 2.866.0 이 먼저 게시되어 **v2.867.0** 으로 다시 매겼다(코드 주석 · 시험 이름 `bareosCancel2867`).
- 시안과 다르게 한 것(이유):
  · '회차 중단…' 은 **이번 회차가 있을 때만** 연다(줄 대기 · 보내는 중 · 이번 회차 실행 중). 그 밖 실행(Bareos 스케줄)만 도는 그룹에는 열지 않는다 — 그 실행은 진행 현황판 행마다 '취소…'.
    시안 ③ 의 '그룹 VM 의 실행 중 전부' 는 회차가 있을 때의 범위 확대로만 남겼다(회차 없는 그룹 카드에 중단 단추가 늘 보이면 '실행 중' 으로 오해한다).
  · 시안 ① 의 KPI '멈추는 중 · 오늘 취소' 는 새 카드 대신 기존 카드의 보조 줄('실행 중' 카드 · '오늘 성공 / 실패' 카드)에 넣었다(카드 수를 늘리지 않음 — v2.850 개편의 '한 화면은 한 질문').
  · 시안 ① 의 '시작 대기 N' 상자는 그룹 회차 띠의 '보냄 n / N' 으로 합쳤다(같은 수를 두 번 보이지 않게).
- 판정 · 규칙 전문: `docs/rules/audits.md` 'Bareos v2.867 백업 중단 · 취소 — 모듈 규칙'. 시험 `server/test/bareosCancel2867.test.js`(12건 · 변이 11/11) · `web/src/views/tools/bareosCancelText.test.js`(9건).
