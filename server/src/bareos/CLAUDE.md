# Bareos VM 백업 연동(`server/src/bareos/`) 불변조건 (v2.820 · v2.823 법인별 Director)

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
  복원 잡에는 `Storage` 가 있다(Bareos 기본 RestoreFiles 모양) · 표지는 ASCII · 상태 판정과 옛 내용 읽기는 root 명령 하나(심링크 바꿔치기 창을 줄인다) · 진행 중에는 **그 Director 의** 접속값 저장·삭제가 409(v2.823 — 공통 설정 저장은 막지 않는다: 자동 설정은 끝에 그 Director 의 4칸만 동기로 저장한다 · 검토 C5).
  ⑤ 라우트: admin + 전체 범위(조회·**쓰기** 둘 다 — v2.823 S2 `fullWriteOnly`) + 데모 계정 403 + 동시 1건(Director 마다 · 같은 원격 주소도 하나 — S6) + 입력 판정(`planDirector`·`planFdIni`) **뒤에** 본인 OTP(지문 읽기는 쓰기가 없어 OTP 없음).
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
- **로그 열기는 그 실행의 상태도 원장에 반영한다**(v2.822.5 — 폴러 주기를 기다리지 않게). Director 호출은 늘리지 않는다(원래 하던 `llist` 확인 행을 쓴다) · 폴러와 같은 규칙(백업은 이름 일치 + type B, 복원은 type R) · `stateChanged` 는 checkedAt 을 뺀 화면 값만 비교.
- **원장 lastRun 은 같은 jobid 에서 null 로 덮지 않는다**(`list jobs days=` 행은 바이트가 비어 올 수 있다) · 음수 바이트·개수는 null(`director.js nonNeg`).
- **카탈로그 시각은 Director 현지 시각(시간대 없음)** 이다 — 포탈 서버 현지 시각으로 읽는다. 포탈과 Director 의 시간대가 다르면 어긋난다(같은 망·같은 시간대 전제 — 다르면 보정이 필요하다).
  데모 Director 도 현지 시각 문자열을 만든다(`catTime` — UTC 문자열이면 한국 시각 서버에서 9시간 어긋났다, `bareosDirector` 시험).
- **v2.822 대상별 처리 중 표시 · 일괄 등록 · 단계별 연결 진단 · 실패 알림 메일**의 규칙은 `docs/rules/audits.md` 'Bareos v2.822 모듈 규칙' 절(크기 상한으로 옮김 · 2026-10-30 v2.824) — 그 기능을 고치기 전에 읽을 것.
- **v2.822 · v2.822.3 검토 확정분**(되돌리지 말 것 — `list jobs` 오름차순 LIMIT · disable 은 메모리 값 · 원장 선검사 · TLS 분류 · 덮어쓰기 복원 전제 · 로드 오류 요약 ·
  SFTP 채널 닫기 · canonDir · 가림 · reload 뒤 대조 · INI `%%` · 실패 메일 커서 · oneAtATime · 구조상 위험 S2-3 · 남긴 것)은 `docs/rules/audits.md` 의
  'Bareos v2.822 · v2.822.3 검토 확정분' 절에 원문 그대로 있다 — 이 폴더를 고치기 전에 읽을 것(크기 상한으로 옮겼다 · 2026-10-30).
- **v2.823 법인별 Director**(사용자 요청 — 법인마다 Bareos 를 깔고 그 법인 vCenter 는 그 법인 Bareos 로 · 초기 설치 뒤 세부 설정은 포탈에서 · `bareosCorp2823`):
  ① 설정 v2 = `directors[]` + `sites[].directorId`(vCenter 하나 → Director 하나). v1 파일은 **읽을 때만** `dir_default` 로 바꾼다(로드는 파일을 다시 쓰지 않는다) ·
  저장은 v2 + 구버전 호환 `director` 사본(첫 Director). Director id 는 난수 · 바꾸지 않는다. 같은 이름·같은 콘솔(주소:포트·이름) 두 항목 거부.
  ⚠ 구버전 호환의 한계(검토 C4): 되돌린 구버전은 첫 Director 만 읽고, **구버전에서 저장하면** 나머지 Director·법인 묶음이 사라진다 → 다시 올리면 2.823 에서 만든 잡이
  없는 Director 를 가리킨다. 그런 잡(덜 됨이 아니라 '없음')은 원장에서만 취소·삭제된다(C3 `orphanOf` — Director 쪽 잡은 그대로라고 문구·감사에 남긴다).
  ② **원장 잡은 등록 때의 `directorId` 를 고정**하고 잡 라우트는 그 Director 로만 보낸다(`settings.jobDirectorId` — 옛 잡은 매핑에서 푼다). 그래서 백업 대상이 있는
  vCenter 를 **그 잡들이 가리키는 Director 와 다른 곳**에 묶거나 매핑을 지우면 409(S3 — 매핑 없는 옛 잡도 비교한다), 매핑·대상이 있는 Director 삭제도 409. 지운 잡 기록(retired)은 (Director, 이름)이 열쇠(같은 이름이 다른 Director 에 생겨도 지우지 않는다).
  ③ Director 일은 작업 표 `ops.js`(직렬화 가능한 인자만 — 2차 엣지 대행이 같은 표를 쓴다) + `service.onDirector`. 조회 GET 은 `readDirector({ demoOnly … }, id, kind, args)` ·
  `onDirector(` 는 `audit2719b` 실접속 목록에 있다. 인증 정지·연결 시험 고정(v2.480)·`accessMoved` 비밀번호 폐기·자동 설정 동시 1건은 **Director 마다**(옛 Director 는 인증 정지 id 'director' 를 잇는다).
  ④ 폴러는 Director 마다 병렬(동시 8) + **Director 별 시한** — 느린 법인 하나가 나머지를 막지 않는다 · 상태는 `pollerStatus().directors`.
  **시한·끊김이어도 읽은 행은 반영하고 회전은 시작한 항목 수만큼 나아간다**(`ops.poll` 은 세션 오류를 던지지 않고 `fault` 로 돌려준다 — C1·P1 라이브락) ·
  다시 끌 이름은 `.jobs` 를 읽은 **뒤** 그 순간의 원장으로 고른다(`hooks.disableNow` — 틱 시작 사본이면 사용자가 그사이 켠 잡을 껐다, P3) ·
  idle 틱은 마지막 실제 결과를 덮지 않는다(한 번도 접속 안 했으면 '조회 전' — W4) · 범위 계정의 폴러 상태·`/poll` 은 자기 법인 Director 만(S1).
  ⑤ 자동 설정 확장: 사전 점검(쓰기·OTP 없음 — 못 읽은 항목은 '확인 불가', 없음으로 단정하지 않는다) · Pool·Schedule(MARKER 파일 · JobDefs 의 레벨별 풀 · 웹 블록과 글자까지 같다) ·
  **FD 플러그인 켜기는 패키지 파일 `myself.conf` 를 제자리 수정하는 유일한 예외** — Client 블록 하나·여러 줄일 때만, 없는 줄만 넣고 같은 값이면 그대로,
  **다른 값이면 거부**(깨진 글자 U+FFFD·Client 블록 안 `@` 포함 지시도 거부 — S7·S8), 임시 디렉터리 → 쓰기 전 사본(심링크 아님 확인) → `bareos-fd -t` → 재시작 →
  실패면 사본으로 원복(심링크 아님 확인 — S5)·재시작(세션이 끊기면 새 세션으로). 매핑 채움은 쓰기 없음(빈 칸만 · 하나뿐·포탈 이름·설치 기본 이름만 고르고 그 밖은 비운다 ·
  INI 경로가 다른 vCenter 와 겹치면 해시 접미사 — C7). 화면 단계 순서는 점검 → 리소스 → 플러그인 → **매핑 채움·저장 → FD INI**(FD INI 가 저장된 매핑을 쓴다 — W3).
  매핑·기본값 저장은 GET 의 `rev` 를 돌려받아 다르면 409 `stale`(다른 화면의 저장을 덮지 않는다 — P4) · 인벤토리에서 빠진 vCenter 의 **저장된** 매핑은 그대로 받는다(W1).
  데모(mock)는 사람이 등록한 Director 가 **0개**일 때만(I4). 검토 기록 전문은 `docs/rules/audits.md` 'Bareos v2.823 법인별 Director 검토 확정분'.
  실환경 미확인(추정): 플러그인 경로(`/usr/lib64` · `/usr/lib` 의 python3-fd.so) · 기본 리소스 이름을 conf **파일 이름**으로 읽는 것 · VDDK 경로 · 레벨별 풀 지시어가 잡의 pool= 을 덮는 순서.
- **v2.824 법인 엣지 대행**(사용자 선택 'Director 마다 선택(중앙/엣지 대행)' · `bareosEdge2824`): Director `agent`('' = 중앙 직접 · 엣지 이름 = 대행 — 라우트가
  `pickAgent(knownAgentNames)` 로만 받는다 · 담당만 바뀌면 비밀번호 승계). 중앙은 그 Director 에 **세션을 열지 않는다**(`withDirector` 가 'edge-relay' 로 거부) —
  `onDirector` 가 작업 표 한 줄을 `edgeOps.js` 큐에 둔다. 큐 작업에 **콘솔 비밀번호 없음**(Director id·args·남은 시간 ttlMs) · 인출·회신은 개별 토큰 전용·자기 몫만 ·
  회신은 `edgeResult.js sanitizeEdgeResult`(새 작업 종류는 VALUE 표에도) · 가져간 상태 변경의 미회신 = 결과 모름(다시 보내지 않음) · 인출 전 시한 = 보내지 않음.
  자동 설정 대행만 `secretArgs`(SSH·vCenter·**중앙이 만든** 새 콘솔 비밀번호): 중앙 메모리만 · **엣지가 인출하면 즉시 지움** · 인출 전 2분 · 목록·로그·감사·응답에 없음.
  2단계 회신 ok → 중앙이 그 콘솔 값으로 저장, 엣지는 성공 즉시 자기 사본(`edgeStore.js` — `bareos-edge-directors.json`, 엣지 자기 bareos.json 과 섞지 않음)을 갱신.
  엣지 워커는 사본에 있고 담당 = 나 인 Director 만 · 받은 시각 + ttl 이 지나면 시작하지 않음 · 회신만 재시도. 인증 실패 회신(`authFailed`)은 **중앙이** 그 cred 로 정지 기록 →
  주기 조회는 큐에 넣지 않는다. 폴러는 엣지 Director 를 **기다리지 않는다**(Director 당 진행 중 poll 1개 · 회신 때 같은 반영 함수 · P3 은 회신 뒤 최신 원장으로 보상 setEnabled).
  엣지 Director 의 연결 시험은 저장값(엣지 사본 — 최대 5분 지연)으로만 — 입력한 새 비밀번호를 시험용으로 엣지에 보내지 않는다.
- 실환경 미확인(추정 — `tools/bareos-probe.js` 로 확인할 것): Node↔Director TLS-PSK 협상 · 잡 수준 FdPluginOptions 와 FileSet 플러그인 문자열 병합 ·
  `.bvfs_get_jobids` JSON 모양 · Profile ACL 지시어 이름 · `list jobs days=N` · 25.x `.jobs` 의 enabled 칸(master 소스 기준 — 없으면 다시 끄기를 하지 않는다) · Migration 행의 시작 시각.
