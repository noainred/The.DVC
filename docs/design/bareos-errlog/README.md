# 설계: 통합 에러 로그 — 실패한 Bareos 실행의 로그를 그 자리에서 보기(따로 · 묶어서)

작성 2026-11-04 (v2.870.0 기준) · 상태 **컨펌 대기** · 시안 캔버스: https://claude.ai/artifact/GdjFFGbUFnFqj8T7pNJCWU
(아트보드 4장 — 이 폴더의 `*.dc.html` 이 같은 내용의 레퍼런스. 법인명 · VM 이름 · jobid · 오류 글은 가상이고 색 · 글자는 `web/src/styles.css` `:root` 토큰 그대로.
계정의 ‘Design System’ 아티팩트는 앞 시안(bareos-cancel)과 같이 내용이 비어 있어 쓰지 않았다.)

## 1. 요구(사용자 2026-11-04)

- "백업 작업이 실패해서 로그를 보고 싶은데 실행 이력을 눌러보면 이 화면이 나오는데, 실행 이력이나 로그 확인이 안돼, 클로드 디자인 사용해서 어떻게 보이게 할건지 시안 보여줘"
- 선택(같은 날): **1 = (가) 에러 로그 화면에서 바로 로그 창(서랍)** · **2 = 묶어 보는 기능과 따로 보는 기능 모두**.
- 규칙: 설계는 Fable + Claude Design 시안 → 컨펌 뒤 Opus 구현(2026-11-03 '기억해').

## 2. 원인(코드 확인 — 2026-11-04 06:33~06:36)

| 사실 | 위치 |
|---|---|
| Bareos 행의 '실행 이력' 은 **고정 주소** `#/tools/bareos-backup/history`(→ v2.860 `runs`)로만 간다 — 어느 VM · 어느 jobid 인지 넘기지 않는다 | `web/src/views/tools/backupSummaryPlan.js:121 errorOpen` |
| 에러 행에는 이미 `vmId` · `jobid` · `job`(Bareos 잡 이름) · `vc` 가 실린다. 원장 잡 id(`j.id`)는 없다 | `server/src/veeam/backupErrors.js:56-57 bareosRows` |
| 진행 · 이력의 이력 표는 대상 드롭다운(166대)의 **첫 대상**을 기본으로 고른다 → 사용자 스크린샷 ②의 'LESTNTP01-NTP.운영'(실패한 VM 과 무관) | `web/src/views/tools/BareosBackupTool.jsx` RunsTab 이력 부분 |
| 로그 읽기는 이미 있다 — `GET /tools/bareos-backup/jobs/:id/log?jobid=`(원장 잡 id · 잡 이름 일치 검사 · 열면서 그 실행 상태를 원장에 반영) · 화면 `LogModal`(요약 · 타임라인 · 볼륨 · 원문 세 보기) | `routes/api/bareosBackup.js:1035` · `BareosBackupTool.jsx:569` |
| '같은 원인' 키가 `src|kind|job|msg40` 이라 Bareos 는 잡 이름이 VM 마다 달라 **한 번도 묶이지 않는다**(스크린샷 ①의 '—') | `backupErrors.js:138 withSameCause` |
| VM 넘기기 수단이 있다 — 법인 화면 '운영에서 열기' 의 `saveTargetFocus/takeTargetFocus`(sessionStorage · 10분) | `bareosViewText.js:288-300` |

곁에서 본 것(이번 범위 밖 · 확인 안 함): 스크린샷 ② 이력 표 jobid 2 가 성공인데 종료 '—'(카탈로그 endtime 해석?) · 복원 192 사유 'SOAP 500: ' 원문 비어 있음.

## 3. 화면(IA) — 아트보드 4장

```
Backup › Summary › 통합 에러 로그
 ├ ①  따로 보기(기본)  행마다 [로그] → 오른쪽 서랍(640px) · [이력 →] → 진행 · 이력에 VM · jobid 를 넘겨 연다
 ├ ②  묶어 보기        같은 모양끼리 한 줄(건수) · 펼치면 낱건 · [묶음 로그] → 서랍이 로그를 차례로 읽어 첫 오류 줄을 대조
 ├ ③  상태             읽는 중(엣지 대행) · 못 읽음(Director) · 로그 없음(카탈로그) · 권한 없음 · 옛 엣지 + '이력 →' 가 가는 곳
 └ ④  400px            목록은 카드 · 서랍은 전체 화면 시트(아래 고정 줄 ‹ › · 이력 → · Full 실행)
```

## 4. 설계

### 4.1 따로 보기(①)
- 열기 칸: Bareos 실패 · 경고 · 취소 행은 **[로그]**(서랍) + **[이력 →]**. 다른 행(Veeam · 오류 볼륨 · 수집 오류)은 지금 그대로.
- 서랍(오른쪽 640px · 목록은 그대로 보인다): 머리(jobid · 잡 이름 · 법인 · Director(중앙/엣지) · 결과 · 레벨 · VM · 끝 시각 · '같은 모양 N건 중 k번째') · 보기 셋(**LogModal 의 요약 · 타임라인 · 원문을 그대로** — 코드를 복제하지 않고 본문 컴포넌트를 꺼내 쓴다) ·
  아래 고정 줄 **‹ 이전 · 다음 ›**(지금 거른 목록 순서 — 열린 서랍이 행을 따라간다 · ↑↓ 키) · 원문 복사 · 이력에서 열기 → · Full 로 지금 실행(LogModal 과 같은 조건 — 쓰기 범위 · 해석이 Full 을 권할 때).
- 늦게 온 이전 응답은 버린다(gen) · 서랍은 요청당 한 건 · 엣지 대행은 `withRelayWait(…, 'log')` 시한 그대로.
- '같은 원인' 칸 → **'같은 모양'** 으로 이름을 바꾼다(아래 4.3 — 원인은 모른다).

### 4.2 이력 →(③ 오른쪽)
- 고정 주소를 버린다. `saveTargetFocus(vc, vmId)` 를 그대로 쓰고 **jobid 를 더 넣는다**(`{ vcenterId, vmId, jobid, at }` — 읽는 쪽은 모르는 키를 무시) → 진행 · 이력이 그 VM 을 대상으로 고르고, 이력 표의 그 jobid 행을 표시하고, LogModal 을 요약으로 연 채 뜬다.
- 대상이 원장에서 지워졌으면(vmId 로 못 찾음) '로그' · '이력 →' 둘 다 비활성 + '대상이 지워져 로그를 읽을 수 없습니다'(원장 기준 상태만).

### 4.3 묶어 보기(②)
- 서버: Bareos 행의 묶음 키 = `src|vc|kind|msg앞머리`(잡 이름 제외) + **1시간 창**(같은 키에서 시각이 1시간 안이면 같은 묶음 — 새것부터 훑으며 묶는다). Veeam 은 지금 키 그대로. 응답에 행마다 `group`(묶음 id) · `same`(묶음 크기)를 싣는다 — 묶는 계산은 순수 함수(`backupErrors.js`) 하나, 웹은 다시 판정하지 않는다.
- 화면: 세그먼트 [따로 보기 | 묶어 보기 N]. 묶어 보기는 묶음 한 줄(처음~마지막 시각 · 법인 · 솔루션 · 대상(`pv-54220daf-vm-*` + N대) · 결과 · 메시지 · 건수 · 펼치기 · [묶음 로그]) · 펼치면 낱건 행(로그 · 이력 →). 거르기 칩은 낱건에 걸리고 묶음은 남은 낱건으로 다시 센다. 정렬은 묶음 단위. 보기 선택은 브라우저에 기억(사람별 편의).
- **묶음 로그 서랍**: 묶음의 로그를 차례로 읽어 **첫 오류 줄**(첫 'Fatal error:' · 없으면 보고 머리줄이 아닌 첫 'Error:' — VM 이름 · jobid · 숫자를 지워 비교)을 대조 → 띠 '13건 같은 오류 · 1건 다른 오류 · 1건 못 읽음' + 가장 많은 줄 + 해석 + 건마다 줄(같음/다름/못 읽음 + [로그]). 진행 막대(읽음 k/N) · 다시 읽기(Director 에 N번 더 묻는다고 말한다) · 대조 결과 복사 · 낱건으로 보기.
- 데이터 경로(새 라우트 하나): `POST /tools/bareos-backup/logs/bulk` `{ items:[{ id, jobid }] }`(최대 15 · admin · 조회 범위 404 규칙) → Director 마다 **세션 하나**로 작업 표 `ops.logs`(항목마다 `jobStatus` 이름 대조 + `jobLog` · 세션째 끊기면 남은 것 'skipped') → 응답은 jobid 마다 `{ firstError, code }` 만(원문은 낱건에서). 엣지 대행: 작업 'logs' 등재(`RESULT_MS` 240초 · `edgeResult` VALUE 표 · `MUTATING` 아님). **옛 엣지(모르는 작업)는 업그레이드 안내 — 낱건 15번으로 돌려보내지 않는다**(v2.867 취소와 같은 규칙).

### 4.4 상태(③) — 지어내지 않는다
읽는 중(엣지 · 경과 · 시한) · 못 읽음(Director 접속 · 인증 정지면 자동 재시도 없음) · 로그 없음(카탈로그에서 지워짐 — 원장 상태만) · 권한 없음(bareos-summary 만 → 열기 'Bareos') · 옛 엣지(묶음만 안 됨). 코드는 서버가, 문장은 `bareosLiveText.liveCodeText` 표를 쓴다.

## 5. 서버 변경 요약(구현 때)
- `backupErrors.js`: Bareos 행에 `jobKey`(원장 잡 id) · 묶음 키 · `group` · 1시간 창 — 순수 함수 + 시험.
- `routes/api/bareosBackup.js`: `POST /logs/bulk`(adminOnly · `jobFor` 범위 규칙 · 15건 상한 · `RESULT_MS.logs` 시한 신호).
- `bareos/ops.js logs` · `edgeOps.js RESULT_MS.logs` · `edgeResult.js logs` 정제 · `edge/worker` 작업 표 · `portalcheck/archScan.js` 허용 목록.
- 웹: `backupSummaryPlan.js`(errorOpen 에 jobKey · 묶음 보기 거르기 · 세그먼트 기억) · `BackupSummaryErrors.jsx`(서랍 · 묶음 서랍) · `BareosBackupTool.jsx`(LogModal 본문 분리 · takeTargetFocus 의 jobid) · `bareosLiveText.js`(코드 표).
- 시험: 묶음 키 · 1시간 창 · 첫 오류 줄 추출 · 대조 · 범위 404/403 · 15건 상한 · 엣지 정제 · 옛 엣지 안내 · 웹 errorOpen/세그먼트. 변이 검증: 범위 · 엣지 수신 계약 · 상한.

## 6. 기본값(컨펌 때 정할 것)
1. 묶음 창 **1시간**(Bareos) — 스크린샷의 15건은 6분 안. 더 넓히면 다른 회차가 섞인다.
2. 묶음 로그 상한 **15건** — Director 세션 하나에서 차례로(명령마다 콘솔 시한 15초 → 최악 15×2×15초 = 7.5분 · 엣지 TTL 240초 안에 못 끝나면 못 읽은 건은 '못 읽음').
3. '같은 원인' 칸 이름 → **'같은 모양'**(대조 전에는 원인이 아니다).
4. 서랍 폭 640px · 400px 은 전체 화면 시트.
5. '이력 →' 는 남긴다(이력 표 · 복원 지점이 거기 있다) — 다만 VM · jobid 를 넘긴다.
