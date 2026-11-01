# 법인별 Bareos 설정 · 중앙 계정 통합(`server/src/bareos/manage/`, v2.845) 불변조건 — 되돌리지 말 것

사용자 요청(2026-11-01): '설정에 bareos web login 계정 설정/추가/비밀번호 변경 · 백업 스토리지 추가/관리 · 법인별로 bareos 설정관리 · 중앙에서 bareos 백업 계정 통합관리'.
결정: web login = WebUI 계정(Director Console + Profile) · SSH 없는 Director 는 **그때마다 SSH 비밀번호 입력(저장하지 않는다)** · 쓰기는 본인 OTP(세션 보안 `bareosSetupOtp`).
회귀: `server/test/bareosManage2845.test.js`(가짜 SSH · 가짜 Director 세션 · 라우트 — 변이 35건 중 34 죽음, 남은 1건은 이중 방어의 안쪽 층) · 웹 `web/src/views/tools/bareosCorp2845.test.js`.

- **읽기 · 쓰기 길이 다르다**: 설정 조회는 Director 콘솔 `config` 작업(`show storages|consoles|profiles` · `llist pools` · `show schedules` — SSH 없음).
  **비밀번호 칸은 고르지 않는다**(`showParse.js` — 원문 객체를 돌려주지 않는다 · 정규화는 멱등: 엣지가 거른 값을 중앙이 다시 걸러도 같다).
  만든 곳 · 경로 · 여유는 SSH 읽기(`scan`)로만 알고, 모르면 null('모름' — 사람 파일로 단정하지 않는다 · 바꾼 뒤 오래된 스캔도 모름).
- **쓰기 엔진은 하나**(`apply.js applyManage`) — 중앙 직접 · 엣지 대행(`edgeSetup` 'setup.manage' · 'setup.scan')이 같은 함수를 부르고, 엣지는 `planManage` 를 **다시** 지난다.
  autoSetup 의 원격 규칙(`_remote`)을 그대로 쓴다: root 만 · **포탈 표지(MARKER) 파일만** 바꾸거나 지운다 · 남의 파일 · 심링크면 아무것도 쓰기 전에 멈춤 ·
  비밀(SSH · 계정 · SD 비밀번호)은 명령 인자에 없다(SFTP 0600 → install) · SD 비밀번호는 서버 안에서 읽어 Director Storage 파일에만 · 출력은 비밀 · `Password =` 값을 가린다.
- **순서**: 판정 → 파일 상태 전부 확인 → (스토리지) 삭제 전제 → 실행 중 작업 0 → 경로 준비 → 놓기 → `bareos-sd -t` · `bareos-dir -t` → **같은 셸에서 실행 중 작업 0 을 다시 확인한 뒤에만** SD 재시작(반증 F4) → reload →
  (계정) 새 비밀번호로 서버 안 `bconsole -c` 접속 확인(`DirPort` — 번들 bconsole 바이너리 실측 키워드 · 반증 E1). 어디서 실패해도 놓은 파일 · 이번에 만든 디렉터리 · **이번에 넣은 SELinux 규칙**을 되돌린다(F5 · F2).
  세션이 끊기면 새 세션으로 되돌린다(`rollbackInNewSession`).
- **스토리지 경로**: `volumeDirIssue`(시스템 경로) + `dataDirIssue`(다른 프로그램 · Bareos 자신의 데이터 경로 — /var/log · /var/lib/pgsql 등) · 이미 있는 디렉터리는 **비어 있을 때만** ·
  다른 SD 장치가 쓰는 경로 거부(F2 · F6 — 비어 있지 않은 남의 디렉터리를 재라벨하지 않는다). 장치 Count = Director Storage Maximum Concurrent Jobs(패키지 기본 FileStorage 와 같은 모양).
- **스토리지 삭제**: 볼륨 경로를 못 읽으면 · 심링크면 멈춘다(못 읽은 값은 0 이 아니다 — F3) · 볼륨 파일 0 · 이 스토리지(`Storage =`) · 이 장치(`Device =`)를 가리키는 설정 0(대소문자 · 한 줄 리소스) ·
  매핑에 쓰는 스토리지 · 마지막 스토리지 거부 · **디렉터리는 지우지 않는다**(원래 있던 · 나눠 쓰는 디렉터리일 수 있다 — F6).
- **WebUI 계정**: `TLS Enable = No`(bareos-webui(php)는 TLS-PSK 를 못 쓴다 — 패키지 admin.conf.example) · Profile 은 Director 에 있는 것만 · 포탈 전용 콘솔(d.consoleName) · 패키지 콘솔(bareos-mon)은 바꾸지 않는다.
  비밀번호는 입력(12자 이상 · `"` `\` 공백 없음) 또는 생성(24자) — **생성한 것만 그 응답에 한 번**(감사 · 로그 · 저장 없음). 웹 `bareosCorpText.js` 의 본문 · 판정이 서버와 글자까지 같다(시험 ③).
- **SSH 출처**(`service.sshSourceFor`): 배포 등록부 계정은 Director 주소가 그 엣지 노드(SSH 주소 · 완전 설치 기록 · 담당 엣지의 루프백)일 때만 ·
  **담당 엣지가 있으면 그 엣지의 계정만**(다른 법인 엣지의 root 비밀번호를 이 엣지 대행 작업에 싣지 않는다 — F1) · 등록부 출처면 요청 host 를 받지 않는다(저장 비밀은 저장 주소로만 — v2.480).
  그 밖은 입력(저장하지 않는다 — 화면이 실행마다 비운다). 데모는 'demo'(SSH 없음).
- **라우트**(`routes/api/bareosManage.js` — `/tools/bareos-backup/settings/corp` · `/settings/accounts`, 데모 계정 READ_DENY 접두가 덮는다): admin + fullScopeOnly + 쓰기는 fullWriteOnly + 데모 계정 403 ·
  OTP 는 **입력 판정 · SSH 판정 뒤에**(일괄은 보낼 법인이 하나도 없으면 OTP 를 쓰지 않고 400 — F7) · Director · 서버 잠금은 `setupLocks`(자동 설정 · 완전 설치와 공유) · 끝나면 `requestReconcile`(reload 가 꺼 둔 잡을 켠다).
  일괄 생성 비밀번호는 **법인마다 다르다**(결과 행에 한 번 · CSV 는 화면이 한 번만). 감사에는 작업 · 이름 · 파일 경로만.
- **재설치 뒤 다시 등록**: 서버가 `.jobs` 를 다시 읽어 지금 빠진 원장 대상만(화면 목록을 믿지 않는다 · **빈 `.jobs` 는 409 판정 불가** — v2.847 D2-2) · 같은 원장 행(`registry.rebindJobs` — 스케줄 · 레벨 · 켜짐 그대로, 실행 기록은 카탈로그 세대가 바뀌었을 때만 새로 시작 — 아래 v2.847 · 이 함수만 잡 이름을 바꾼다) ·
  지금 매핑으로 · 원장에 묶지 못한 잡은 끈다(F8 — 일반 등록 orphanCleanup 과 같은 규칙) · 늦은 엣지 회신도 같은 규칙. OTP 없음(대상 등록과 같은 등급 — 콘솔 configure).
- **v2.846 버그 점검 확정분(되돌리지 말 것 — `bareosBugs2846a` 변이 12/12)**: 다시 묶기(`registry.rebindJobs`)는 **(v2.847: 세대가 바뀌었을 때만) 실행 기록을 새로 시작**한다
  (재설치는 카탈로그 DB 삭제가 기본 → jobid 가 1 부터 — lastRun · finishedRuns · lastRate · 끝난 restores 를 `beforeRebind` 요약으로 옮기고 `runsEpoch` 를 남긴다 ·
  notify 는 runsEpoch 가 바뀌면 그 대상의 커서 · seen · 복원 커서를 지운다 · D-1) · 위치 칸(vmName · dc · folder)도 지금 값(D-8) ·
  다시 등록은 **200건 묶음**(엣지 회신 정제 addJobs 상한 500 — E-1) · 회신에 없는 항목은 '결과 모름' · 묶지 못한 잡은 `service.orphanCleanup`(끄기 + 지운 이름 — E-4) ·
  스토리지 삭제는 그룹이 지정한 스토리지도 매핑으로 보고 · 볼륨 경로가 없으면 · 설정 목록을 못 읽었으면 멈춘다(D-5) ·
  서버 시간 예산(단건 560초 · 일괄 540초 · 새 법인 시작 420초까지)이 화면 시한(600초)보다 짧다 — 결과 모름 법인에는 생성 비밀번호를 `maybeApplied` 와 함께 돌려준다(C-4) ·
  화면 조회는 `fetchJson(경로, 쿼리, undefined, 옵션)`(옵션을 둘째 자리에 넣으면 시한 20초 · 재시도 2회 — U-1 · 웹 `fetchJsonArgs2846` 스윕) · 진행 중에는 법인 선택을 잠근다(U-4).
- **v2.847 버그 점검 2회차(되돌리지 말 것 — `bareosBugs2847a`·`c` · 변이 포함)**: 실행 기록 새로 시작은 `catalogGeneration` 이 'new'(원장 최대 lastRun jobid 가 그 잡 이름의
  카탈로그 `history` 에 없음) 또는 'unknown'(묻지 못함)일 때만 · 'same' 이면 커서 · 복원 · runsEpoch 그대로 · 비워도 **진행 중 복원은 남긴다**(D2-3 — v2.846 은 무조건 비워 이미 알린 실패를 다시 메일로 보냈다) ·
  카탈로그가 그대로인 다시 묶기에서 위치가 바뀌면 그 jobid 까지의 옛 위치를 `placements` 에 남겨 옛 지점의 덮어쓰기를 옛 위치로 판정(D2-1 — `restore.placementAt` · 라우트가 jobid 를 넘긴다) ·
  다시 등록은 **원장 이름 그대로만** 만든다(`exactSfx` — 있으면 '이미 있음' 건너뜀 · `-r2` 로 두 번째 잡을 만들지 않는다 · D2-2) · 명령 도중 끊김(`ops.MID_COMMAND_CODES` — groupRunner 와 같은 표)은
  결과 모름 → `.jobs` 한 번(원장 이름이 지금 있으면 묶는다 · 없으면 확정 실패 — E2-1) · 결과는 성공 · 실패 · 결과 모름 · 보내지 않음 넷(E2-6) · 서버 예산 540초(`REREGISTER_BUDGET_MS` — C2-5) ·
  단건 · 일괄 쓰기 예산은 **라우트 진입부터**(설정 조회 `planFor({ waitMs })` 포함 · 공유 조회에 signal 을 넘기지 않는다 · 남은 시간 < 90초면 OTP 전에 503 — C2-1) · 그룹 원장을 못 읽으면 스토리지 삭제 · 편집 거부(D2-6).
- **엣지 회신**: `setup.manage` 는 파일 경로가 `/etc/bareos/bareos-(dir|sd).d/<종류>/<이름>.conf` 모양인 것만 · 파일 목록이 비면 결과 모름(REQUIRED) · `setup.scan` 은 `normScanResult`.
- **남긴 것(추정 · 실환경 미확인)**: `show storages|consoles|profiles` 의 칸 모양(실측 전 — 문자열 · 배열 둘 다 받는다) · reload 성공을 bconsole 종료 코드로만 본다(E2) ·
  apply 경로 시한 합은 시험으로 고정하지 않았다(E3 — 세션 시한이면 새 세션으로 되돌린다) · 풀 편집은 새 볼륨부터(기존 볼륨은 `update volume … AllFromPool` 을 사람이) ·
  중앙이 504 로 잠금을 푼 뒤 엣지가 되돌리기를 계속하는 동안 중앙 직접 완전 설치는 엣지 잠금에 막히지 않는다(E6) · 재등록 늦은 회신은 잡 잠금이 풀린 뒤 처리된다.
