# Bareos VM 백업 연동(`server/src/bareos/`) 불변조건 (v2.820)

포탈이 Bareos Director 콘솔(9101 · TLS-PSK · CRAM-MD5 · `.api json`)로 VM 마다 잡을 만들고 실행·조회·복원한다.
백업 데이터는 사이트 FD → SD 안에서만 흐르고, 포탈은 제어 명령(수 KB)만 보낸다. 되돌리면 안 되는 규칙:

- **vCenter 비밀번호를 갖지 않는다**: 잡의 플러그인 옵션은 `config_file=<FD 의 INI>` 만 싣는다(vcuser·vcpass 금지 — `bareosRoutes ⑤` 가 명령 문자열로 고정).
  엣지 위임(`collectMode:'site'`) vCenter 는 중앙이 비밀번호를 모르므로 이 방식이 유일하게 맞다.
  v2.821 'FD INI 자동 설정'(사용자 선택)은 관리자가 **그 요청에 직접 입력한** vCenter 비밀번호를 FD 로 전달만 한다 — 저장·감사·응답·명령 인자 금지,
  포탈에 저장된 vCenter 계정을 FD 로 보내는 경로를 만들지 말 것(저장 비밀을 다른 호스트로 승계하는 것 — v2.480 규칙).
- **자동 설정(`autoSetup.js`, v2.821)** — Bareos 서버에 SSH root 로 설정 파일을 쓴다. 되돌리지 말 것(`bareosAutoSetup.test.js`):
  ① SSH·생성 콘솔·vCenter 비밀번호는 원격 명령 문자열에 넣지 않는다(SFTP 0600 임시 파일 → `install`) · 응답·감사에 없음 · 검사 출력은 `maskSecrets`.
  ② **쓰기 전에 전부 살핀다** — 대상에 파일이 있으면 첫 줄이 `MARKER` 일 때만 덮어쓰고, 남의 파일·심링크가 하나라도 있으면 아무것도 쓰지 않는다(`MARKER` 문구를 바꾸면 예전 파일이 남의 파일이 된다).
  ③ 놓기·`bareos-dir -t`·reload 실패 → 새 파일 삭제 + 바꾼 파일 원복. 세션이 시한으로 끊기면 **새 세션으로** 되돌리고 다시 reload(`BUDGET` 단계 합 < 세션 시한 — 테스트가 산수 고정).
  ④ 새 콘솔로 **포탈이 실제 접속에 성공해야만** 설정을 저장. 실패면 되돌리고 다시 reload(같은 이름 콘솔을 그대로 두면 Director 만 새 비밀번호가 돼 쓰던 연결이 끊긴다).
  복원 잡에는 `Storage` 가 있다(Bareos 기본 RestoreFiles 모양) · 표지는 ASCII · 상태 판정과 옛 내용 읽기는 root 명령 하나(심링크 바꿔치기 창을 줄인다) · 일반 설정 저장은 진행 중 409.
  ⑤ 라우트: admin + 전체 범위 + 데모 계정 403 + 동시 1건 + 입력 판정(`planDirector`·`planFdIni`) **뒤에** 본인 OTP(지문 읽기는 쓰기가 없어 OTP 없음).
  ⑥ root 만(`id -u`=0, sudo 경로 없음) · 단일 설정 파일(`bareos-dir.conf`) Director 는 거부 · 원격 명령 값은 화이트리스트(리소스 이름·경로·호스트, 앞 `-` 금지).
  리소스 본문은 웹 `bareosText.js directorPrepBlock` 과 글자까지 같다(테스트 ①이 대조 — 한쪽만 고치지 말 것).
  실환경 미확인(추정): `bconsole reload` 출력 모양(판정에 쓰지 않음 — 접속 시험이 판정). INI 의 `%` 보간은 v2.822.3 에 플러그인 소스로 확인했다(`%%` 로 쓴다).
- **콘솔 명령에 넣는 값은 `names.js` 를 통과한 것만**: 리소스 이름 `[A-Za-z0-9._-]{1,64}` · 플러그인 값은 `" \ : ; @`·제어문자·앞뒤 공백·200자 초과 거부.
  `configure add` 는 FdPluginOptions 를 따옴표 없이 쓰므로 `consoleQuote(…, { literalQuotes: true })` 로 따옴표를 남긴다(빼면 `:` 뒤가 잘린다).
- **복원은 jobid 목록으로만**: 범용 FileSet 하나를 여러 VM 이 공유하므로 `restore … select current`(client+fileset 최신)는 다른 VM 을 섞는다 — 화면·API 에 그 경로를 두지 않는다.
  체인은 **이 잡의 카탈로그 이력으로만**(`jobRuns` + `restore.js chainFromHistory` — 시작 시각 순, 시각을 못 읽으면 jobid 순). `.bvfs_get_jobids` 는
  ClientId + FileSet 으로만 골라(AccurateGetJobids — 잡 이름을 안 본다) 같은 FD 의 다른 VM 이 섞인다(v2.822 S1 — probe 비교용으로만 남겼다).
  고른 jobid 가 **이 대상의 성공한 백업(T·W, type B)** 인지 Director 에서 확인한다.
- **복원 라우트 순서**: OTP 등록 확인 → 진행 중 409 → jobid·`restorePlan` 판정 → **그다음에** `verifyUserOtp`(전제 실패가 1회용 OTP 를 태우지 않게) → Director 확인 → 실행 → 감사.
  덮어쓰기는 VM 이름 재입력 + 전원 꺼짐 + 스냅샷 0 — 못 읽은 전원·스냅샷 값은 **거부**(0 으로 보지 않는다). 새 VM 은 항상 꺼진 채(`restore_powerstate=off`)·동명 VM 거부.
- **데모 계정은 사람이 등록한 Director 에 닿지 않는다**: 조회 라우트는 `readDirector({ demoOnly: isDemoGuest(req.user) }, …)` 만 쓴다(`audit2719b` 스윕이 이 모양을 대조).
  설정·카탈로그는 `READ_DENY`, 실행·복원 POST 는 `SAFE_ACTIONS` 에 넣지 않는다. 목록의 Director 주소·콘솔 이름·접속 오류 원문은 범위 계정·데모 계정에 가린다.
- **연결 시험은 저장 비밀번호를 승계하면 저장 주소·포트·콘솔 이름으로 고정**(v2.480 규칙). 주소·포트·콘솔 이름이 바뀌면 저장 비밀번호를 폐기(`accessMoved`).
- **인증 실패는 주기 조회를 멈춘다**(`bareosAuthGuard` — auth·pam·tls 오류). 수동 조회는 계속, 성공하면 해제. 자동 재시도 없음.
- **폴러는 할 일이 없으면 접속하지 않는다**(pending 0 이고 대조 틱이 아니면). 재진입 가드 · `withDeadline` 예산 = max(30초, 시한×4).
- **VM 위치 필드는 `vcDcPath`·`folderPath`**(`vcenter/vmPlacement.js`) — 호스트의 `vcDatacenter`(데이터센터 이름)와 다른 값이다. 엣지 수집분은 중앙 정제 `INV_STR_ONLY_KEYS` 를 지난다.
- **원장 lastRun 은 같은 jobid 에서 null 로 덮지 않는다**(`list jobs days=` 행은 바이트가 비어 올 수 있다) · 음수 바이트·개수는 null(`director.js nonNeg`).
- **카탈로그 시각은 Director 현지 시각(시간대 없음)** 이다 — 포탈 서버 현지 시각으로 읽는다. 포탈과 Director 의 시간대가 다르면 어긋난다(같은 망·같은 시간대 전제 — 다르면 보정이 필요하다).
  데모 Director 도 현지 시각 문자열을 만든다(`catTime` — UTC 문자열이면 한국 시각 서버에서 9시간 어긋났다, `bareosDirector` 시험).
- **v2.822 대상별 처리 중 표시**(`bareosBackup.js oneAtATime`): 실행·복원·삭제는 대상마다 한 번에 하나(나머지 409) — pending 검사와 markPending 사이의
  Director 호출 동안 두 번째 요청이 같은 검사를 통과해 실행이 두 번 나갔다(B2). 수동 조회(`/poll`) 응답도 목록 GET 과 같은 `addrVisible` 로 가린다(B3).
- **v2.822 일괄 등록**(`POST …/jobs/bulk`, `service.createBackupTargets`): vCenter 하나 · `MAX_BULK`(200 — 화면은 응답의 maxBulk·jobsLeft) ·
  원장 여유(MAX_JOBS)를 Director 에 닿기 전에 확인 · **Director 세션 1개**로 순차 · 한 대의 실패가 나머지를 막지 않는다 · 세션이 끊기면 남은 VM 은 '건너뜀'.
  Director 잡은 만들고 원장에 못 넣었으면 그 잡 이름을 사유에 밝힌다(숨기지 않는다).
- **v2.822 단계별 연결 진단**(`console.diagnoseConsole` — 던지지 않는다): 주소 → DNS(그 주소로 고정 — `pinnedLookup`) → TCP → TLS-PSK → 인증 → JSON 모드 → `.clients`.
  실패 뒤 단계는 skipped(실패로 세지 않는다). 비밀번호·콘솔 이름이 틀리면 **TLS 단계**에서 실패한다(PSK 가 비밀번호에서 나온다 — hint 가 그렇게 말한다).
  SSRF 차단 코드는 `'ESSRFBLOCKED'`(util/ssrfLookup) — `blockedCode` 하나로 본다(B1: 'ESSRF' 만 봐서 'connect' 로 분류됐다). TLS 핸드셰이크도 취소를 받는다(B6).
  연결 시험 감사 대상은 **실제 접속한 주소**(B4 — 저장 비밀번호 시험에서 요청 주소를 적던 것).
- **v2.822 실패 알림 메일**(`bareos/notify.js`, 메일 종류 `bareos-backup`): 중앙 전용 · 원장만 읽는다(Director 에 닿지 않는다) · 커서는 대상별 **jobid**
  (카탈로그 시각은 시간대가 없다) · 끝나지 않은 실행으로는 커서를 옮기지 않는다 · 메일 꺼짐이면 커서만 · 발송 실패면 커서 유지 · mock·데모 대상 제외.
  한계: 스케줄 실행은 대조 틱마다 대상별 최신 1건만 원장에 들어와 그 사이 실패가 2건이면 1건만 알린다.
- **v2.822 검토 확정분(되돌리지 말 것)**: ① `list jobs job=X limit=N` 은 **오름차순 + LIMIT = 가장 오래된 N건**(sql_list.cc) — limit 를 넘기지 않고 받아 최신 순으로 자른다(W1).
  ② `disable job=` 은 Director **메모리 값**이라 reload·재시작이면 conf 값(활성)으로 돌아간다(ua_cmds.cc 경고문) — 원장 `retired`(지운 잡 이름)와 enabled:false 대상을
  대조 틱이 `.jobs` 의 enabled 로 보고 다시 끈다. 문구는 '비활성으로 남는다' 고 단정하지 않는다(I3). ③ 등록은 원장 손상·상한을 **Director 에 닿기 전에** 보고, VM 마다
  처리 중 표시(`busy` 409) · 원장 기록이 실패하면 만든 잡을 끄고 이름을 밝힌다 · 파일에 못 쓴 대상은 메모리에도 넣지 않는다(C3). ④ 핸드셰이크 중 소켓 끊김은
  'closed'(TLS 경보 `ERR_SSL_*` 만 'tls' = 인증 정지 대상, C7). ⑤ 덮어쓰기 복원은 지금 인벤토리의 이름·데이터센터·폴더가 등록 때와 같고 같은 폴더에 동명 VM 이
  없을 때만(S3 — 잡은 등록 때 값을 가리킨다). 목록은 `drift` 로 알린다. ⑥ 로드 오류는 원문(JSON.parse 조각)이 아니라 `summarizeRegistryError` 요약(S2) ·
  차단 문구에 호스트 이름 없음(S4). ⑦ 설정 백업 지문에서 pending·restores·missingInDirector 를 뺀다(I6). ⑧ 데모 대상과 실제 Director 를 섞지 않는다 — 실행·변경 409,
  데모 대상 삭제는 원장만(I8). ⑨ 취소는 Director 가 모르는 pending 을 추적만 내린다 · 복원이 진행 중이면 삭제 409(P4·P5). ⑩ Director 를 거치는 화면 GET 은 재시도 0(W2).
  남긴 것(낮음): 카탈로그 memo 세대(P9) · 옛 원장 복원 뒤 Director 고아 잡 탐지(I7). (응답 프레임 개수 상한 P8 은 v2.822.3 에 고쳤다.)
- **v2.822.3 2차 검토(5축 + 반증 2인) 확정분**: ① 공용 `proxy/sshExec.js` 의 SFTP 읽기·쓰기·올리기는 끝나면 `sftp.end()`(I2-1 — 채널이 쌓여 MaxSessions 를
  넘으면 exec 가 거부됐다 · `bareosSftpChannels28223`). ② 자동 설정의 원격 읽기·쓰기·삭제는 **부모 디렉터리 정규 경로 검사**(`canonDir` — readlink -f)를
  같은 셸 명령 안에서(S2-1 — bareos-dir.d 는 패키지가 bareos 소유로 둔다; 남는 창은 bareos 계정을 쥔 경우뿐). FD INI 는 `/etc/bareos/**.ini` 만(S2-2 — 매핑 저장은 그대로).
  ③ 가림은 생성 콘솔 비밀번호만 — 출력에 SSH 비밀번호가 있으면 출력 전체를 싣지 않는다(S2-5 부분 가림 오라클). 감사에는 원격 출력을 싣지 않는다(`setupAuditReason`, I2-10).
  ④ reload 를 보냈으면 되돌린 뒤 다시 reload(C2-4) · 새 콘솔 접속 뒤 저장 실패도 되돌린다(C2-5) · 되돌린 뒤 인증 정지 기록을 지운다(P2-12).
  ⑤ FD INI 값의 `%` 는 `%%`(플러그인이 ConfigParser 보간으로 읽는다 — C2-1). ⑥ reload 뒤 `requestReconcile()`(C2-3) · 시한에 잘린 대조는 다음 틱(P2-5) ·
  빈 `.jobs` 로 retired·missing 을 바꾸지 않는다(I2-5). ⑦ 실패 메일은 `finishedRuns` + 판정한 jobid(seen)로 — 포탈 실행이 진행 중이면 커서를 그 앞에서 멈춘다(C2-2).
  ⑧ 취소·활성 전환도 `oneAtATime`(C2-14) · 데모 Director 일 때 자동 설정 409(I2-6) · 명령별 응답 상한은 요청값(최대 64MB — C2-8, 단 **프레임 하나는 4MB** —
  Director 가 큰 JSON 을 나눠 보내는지는 미확인) · 쌓인 프레임 누적 카운터·개수 상한(P8) · 화면 설정 저장은 **달라진 Director 칸만**(`directorPatch` — W2-1).
  **구조상 남는 위험(S2-3)**: 포탈 콘솔은 잡을 만들려고 `configure` 가 필요한데 Bareos 는 그 하위 명령·리소스 단위 ACL 이 없다 — 포탈 콘솔 자격 = Director 관리자 +
  전 FD root 등급이다(ACL 을 좁혀도 우회). 비밀번호를 그 등급으로 지킨다(체크리스트에 적었다).
  남긴 것(낮음 — 반증 판정표 adv2_server.md·adv2_web.md): DNS 핀·IPv6 리터럴(S2-4) · 콘솔 이름 바꾼 재실행의 옛 콘솔(S2-6) · INI 소유자(S2-8) · 시한 끊김 tmp(S2-9) ·
  두 포탈의 같은 콘솔(I2-4) · 엣지 메일(I2-7) · 자동 설정 진행 상태 노출·탭 이동 뒤 표시(P2-1·W2-4 — 데이터 손실은 ⑧ 로 막았다) · BUDGET 강제(P2-7) · 일괄 등록 180초(P2-11) ·
  목록 memo(P7) · 카탈로그 memo 세대(P9) · 고아 잡(I7) · Migration 새 잡의 일시 lastRun(C2-7).
- 실환경 미확인(추정 — `tools/bareos-probe.js` 로 확인할 것): Node↔Director TLS-PSK 협상 · 잡 수준 FdPluginOptions 와 FileSet 플러그인 문자열 병합 ·
  `.bvfs_get_jobids` JSON 모양 · Profile ACL 지시어 이름 · `list jobs days=N` · 25.x `.jobs` 의 enabled 칸(master 소스 기준 — 없으면 다시 끄기를 하지 않는다) · Migration 행의 시작 시각.
