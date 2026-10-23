# horizon-uag-monitor (Windows 트레이 앱) 불변조건

포탈(`server/`·`web/`)과 별개인 .NET 8 WinForms 앱이다. 릴리스는 `.github/workflows/horizon-monitor-release.yml`
(롤링 릴리스 `horizon-monitor`)이고 포탈 버전과 무관하다. 소스를 고치면 `dotnet test tests/UagMonitor.Tests.csproj` 를 돌린다
(화면과 무관한 논리 63건 — Linux 에서도 돈다(`apt install dotnet-sdk-8.0`). WinForms 화면은 Linux 에서 띄울 수 없다).
⚠ 이 테스트는 PR CI(`ci.yml`)에서 돌지 않는다 — 릴리스 워크플로(수동·`horizon-v*` 태그)에서만 돈다. 소스를 고쳤으면 직접 돌릴 것.

- **알람 판정은 `AlarmEngine`(순수)이 하고 화면(`AlarmOverlay`)은 그리기만 한다.** 규칙: 주의·위험이 알람, 끄면(확인) 같은 상태에서는
  다시 울리지 않고 ① 정상을 거쳐 재발 ② 주의→위험 악화 ③ 다른 대상의 새 장애에서만 다시 울린다. 위험→주의는 다시 울리지 않는다.
  **오래된 점검 결과(주기×3, 최소 3분)는 알람이 아니다** — 앱을 켠 직후 DB 에 남은 예전 '위험'으로 울리지 않게 하는 장치다.
  v2.760: 결과가 오래돼 사라진 알람이 '확인됨' 이었으면 그 등급을 기억해, 정상을 거치지 않고 같은 등급 이하로 돌아오면 **확인된 채로** 되살린다(절전 뒤 재울림 방지).
- **저장 폴더 위치는 DB 안에 둘 수 없다.** `%LOCALAPPDATA%\HorizonUagMonitor\location.json`(`DataLocation`)에만 둔다.
  `--db` 로 실행하면 설정에서 폴더를 못 바꾼다(`CommandLineOverride`). 지정 폴더를 시작 때 못 쓰면 기본 폴더로 열고 **location.json 은 지우지 않는다**.
- **폴더 이동 순서가 안전장치다**(`DataMigrator` + `Database.ExportCopyTo/FinishMigration`): 점검 → 별도 연결로 `VACUUM INTO` 복사(점검은 계속)
  → 잠금 잡고 복사 이후 샘플 따라잡기 + 무결성/행 수 검증 → 제자리로 이동 → **새 위치 기록이 성공한 뒤에만** 연결 전환 → 예전 파일 삭제.
  어느 단계가 실패해도 예전 DB 로 계속 동작하고 만든 파일은 지운다. 대상 폴더에 `monitor.db` 가 있으면 **덮어쓰지 않는다**(전환 또는 취소).
  단계를 바꾸면 `tests/DataMigrationTests.cs`(변이 검증 4종으로 확인했다)를 먼저 볼 것.
- **SQLite 연결은 `Pooling=False`.** 풀이 파일 핸들을 잡고 있으면 이동 뒤 예전 파일을 지울 수 없다.
- **디자인은 `Theme.cs` 한 곳**(승인된 Claude Design 시안: 남색 머리말 · 밝은 본문 · 상태 칩). 색·글꼴을 화면마다 새로 정하지 말 것.
  카드에 왼쪽 색 막대를 되살리지 않는다(시안은 칩 + 옅은 상태색 바탕).
- ⚠ 정직 기록: v1.1 의 화면(알람 띠 · 설정 탭 · 시안 적용)은 Linux 에서 **컴파일과 논리 테스트까지만** 확인했다. 실제 모양은 Windows 에서 본 적이 없다.
- **v1.2 — 세대(`Database.Generation`)·종료 분류·버킷 집계·청크 prune**: ① `SwitchTo`(기존 DB 로 전환)만 세대를 올린다 — 폴더 이동(`FinishMigration`)은
  같은 내용·같은 id 를 옮기는 것이라 올리지 않는다(올리면 진행 중 정상 점검 8건을 버리고 끈 알람이 다시 울린다). 점검 루프는 대상 목록을 읽기 **전에**
  세대를 잡고 `InsertSample(s, expectedGeneration)` 이 잠금 안에서 대조한다. `_inFlight` 키는 `(세대, id)`. ② 종료(앱 토큰 취소) 중 결과는 샘플을
  만들지 않는다(`MonitorRules.ClassifyFailure` — 앱 토큰이면 예외 종류와 무관하게 `AppStopping`, 요청 시한만 '시간 초과'). ③ 이력 창은 원시
  `History(LIMIT 20000)` 이 아니라 `HistoryBuckets`(1일=1분 … 365일=4시간, 점 ≤ 약 2,200)로 그리고 통계도 같은 집계다 — 2만 건 상한은 60초 주기에서
  약 14일이었다. 버킷의 가장 나쁜 상태는 Down 이 하나라도 있으면 Down. ④ `Prune` 은 5,000건 청크 사이에 잠금을 놓고 끝에 `wal_checkpoint(TRUNCATE)`
  (VACUUM 은 이동의 `VACUUM INTO` 가 담당). 되돌리기 전에 `tests/MonitorFixTests.cs`(변이 10종 검출)를 볼 것.
- **v2.767(점검 R2-B5) — 저장 실패·오래됨·최신 조회**: ① 점검 결과 저장(InsertSample) 예외를 삼키지 않는다 — `SaveFailureTracker`(MonitorRules.cs)가
  연속 실패를 세고 error.log 는 첫 실패 즉시 + 5분마다 한 줄 + 복구 한 줄. 트레이 툴팁·메인 창 바닥 줄이 '저장 실패' 를 보인다.
  ② 트레이 아이콘·머리말 집계는 `MonitorRules.CountStatuses` 하나로 — **오래된 결과(주기×3, 최소 3분)는 대기**, 저장 실패 중이면 '정상' 으로 그리지 않는다.
  오래됨 경계는 알람 엔진과 같은 `MonitorRules.IsFresh`(복제 금지). 트레이는 점검 완료가 없어도 10초마다 다시 그린다(멈추면 Updated 도 안 온다).
  ③ `LatestByEndpoint` 는 대상별 `ORDER BY ts DESC, id DESC LIMIT 1`(인덱스 시크) — `GROUP BY + MAX(ts)` 로 되돌리지 말 것(630만 행 약 0.5초, 잠금+UI 스레드).
  ④ `MonitorService.Snapshot` 은 `Database.ChangeStamp()`(연결 세대 + total_changes)가 같으면 직전 결과를 메인 창·트레이가 나눠 쓴다 — 연결을 바꾸는 곳은
  `_connEpoch` 를 올릴 것. 근거·변이 검증은 `tests/SaveAndLatestTests.cs`. MainForm·TrayAppContext 변경은 Linux 에서 WinForms 참조 팩(Microsoft.WindowsDesktop.App.Ref 8.0.10)으로 컴파일만 확인했다(화면은 미확인).
