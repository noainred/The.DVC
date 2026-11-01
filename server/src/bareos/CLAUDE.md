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
  ⑤ 라우트: admin + 전체 범위(조회·**쓰기** 둘 다 — v2.823 S2 `fullWriteOnly`) + 데모 계정 403 + 동시 1건(Director 마다 · 같은 원격 주소도 하나 — S6) + 입력 판정(`planDirector`·`planFdIni`) **뒤에** 본인 OTP(지문 읽기는 OTP 없음 · v2.842 끌 수 있음).
  ⑥ root 만(`id -u`=0, sudo 경로 없음) · 단일 설정 파일(`bareos-dir.conf`) Director 는 거부 · 원격 명령 값은 화이트리스트(리소스 이름·경로·호스트, 앞 `-` 금지).
  리소스 본문은 웹 `bareosText.js directorPrepBlock` 과 글자까지 같다(테스트 ①이 대조 — 한쪽만 고치지 말 것).
  실환경 미확인(추정): `bconsole reload` 출력 모양(판정에 쓰지 않음 — 접속 시험이 판정). INI 의 `%` 보간은 v2.822.3 에 플러그인 소스로 확인했다(`%%` 로 쓴다).
- **콘솔 명령에 넣는 값은 `names.js` 를 통과한 것만**: 리소스 이름 `[A-Za-z0-9._-]{1,64}` · 플러그인 값은 `" \ : ; @`·제어문자·앞뒤 공백·200자 초과 거부.
  `configure add` 는 FdPluginOptions 를 따옴표 없이 쓰므로 `consoleQuote(…, { literalQuotes: true })` 로 따옴표를 남긴다(빼면 `:` 뒤가 잘린다).
- **복원은 jobid 목록으로만**: 범용 FileSet 하나를 여러 VM 이 공유하므로 `restore … select current`(client+fileset 최신)는 다른 VM 을 섞는다 — 화면·API 에 그 경로를 두지 않는다.
  체인은 **이 잡의 카탈로그 이력으로만**(`jobRuns` + `restore.js chainFromHistory` — 시작 시각 순, 시각을 못 읽으면 jobid 순). `.bvfs_get_jobids` 는
  ClientId + FileSet 으로만 골라(AccurateGetJobids — 잡 이름을 안 본다) 같은 FD 의 다른 VM 이 섞인다(v2.822 S1 — probe 비교용으로만 남겼다).
  고른 jobid 가 **이 대상의 성공한 백업(T·W, type B)** 인지 Director 에서 확인한다.
  명령은 `restore … jobid=a,b … all done yes` — **`select` 를 넣지 않는다**(v2.827.1 실환경: Bareos 22~25 는 select 가 있으면 jobid 를 무시하고 FileSet 을 물어 'No FileSet found for client' 로 거부).
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
  데모 Director 도 현지 시각 문자열(`catTime` — UTC 면 9시간 어긋남 · `bareosDirector`).
- **v2.822 대상별 처리 중 표시 · 일괄 등록 · 단계별 연결 진단 · 실패 알림 메일**의 규칙은 `docs/rules/audits.md` 'Bareos v2.822 모듈 규칙' 절 — 그 기능을 고치기 전에 읽을 것.
- **v2.822 · v2.822.3 검토 확정분**(되돌리지 말 것 — `list jobs` 오름차순 LIMIT · disable 은 메모리 값 · 원장 선검사 · TLS 분류 · 덮어쓰기 복원 전제 · 로드 오류 요약 ·
  SFTP 채널 닫기 · canonDir · 가림 · reload 뒤 대조 · INI `%%` · 실패 메일 커서 · oneAtATime · 구조상 위험 S2-3 · 남긴 것)은 `docs/rules/audits.md` 의
  'Bareos v2.822 · v2.822.3 검토 확정분' 절에 원문 그대로 있다 — 이 폴더를 고치기 전에 읽을 것.
- **v2.823 법인별 Director**(`bareosCorp2823`·`bareosReview2823`): 설정 v2 = `directors[]` + `sites[].directorId`(v1 은 **읽을 때만** `dir_default` — 로드는 파일을 쓰지 않는다) ·
  원장 잡은 등록 때의 `directorId` 고정, 잡 라우트는 그 Director 로만(대상이 있는 vCenter 재매핑·대상·매핑이 있는 Director 삭제 409) · Director 일은 작업 표 `ops.js` + `service.onDirector`
  (조회 GET 은 `readDirector({ demoOnly … })`) · 인증 정지·연결 시험 고정·`accessMoved`·자동 설정 동시 1건은 Director 마다 · 폴러는 Director 별 시한 병렬, 시한이어도 읽은 행 반영
  (`ops.poll` 은 던지지 않고 `fault`) · 다시 끌 이름은 `.jobs` 뒤 그 순간 원장(`hooks.disableNow`) · FD 플러그인 켜기는 `myself.conf` 제자리 수정의 유일한 예외(다른 값 거부·사본·`-t`·원복) ·
  매핑·기본값 저장은 `rev` 대조 409. **원문 전체(구버전 호환 한계·검토 번호·실환경 미확인)는 `docs/rules/audits.md` 'Bareos v2.823 법인별 Director 모듈 규칙' 절** — 고치기 전에 읽을 것.
- **v2.824 법인 엣지 대행**(사용자 선택 'Director 마다 선택(중앙/엣지 대행)' · `bareosEdge2824`·`bareosEdgeReview2824`): Director `agent`('' = 중앙 직접 · 엣지 이름 — `pickAgent(knownAgentNames)`
  로만 · 담당만 바뀌면 비밀번호 승계). 중앙은 그 Director 에 **세션을 열지 않는다**(`withDirector` 'edge-relay') — `onDirector` 가 작업 표 한 줄을 `edgeOps.js` 큐에 둔다.
  ① 큐 작업에 **콘솔 비밀번호 없음**(Director id·args·ttlMs·접속값 표지 `connSig` — `settings.directorConnSig` HMAC) · 인출·회신은 개별 토큰 전용·자기 몫만·빈 자리만큼(`max`) ·
  회신은 `sanitizeEdgeResult`(새 작업 종류는 VALUE 표에 · 숫자 key 보존 · 필수 값 없으면 결과 모름).
  ② 엣지 워커: 사본(`edgeStore.js` — `bareos-edge-directors.json`, 엣지 자기 bareos.json 과 섞지 않음)에 있고 담당 = 나 · **사본 표지가 다르거나 없으면 배정을 즉시 다시 받고**
  (`pullBareosConfigForce`) 그래도 다르면 보내지 않는다 · 받은 시각 + ttl 이 지나면 시작하지 않음 · 자동 설정에도 시한(본 SSH 세션에만 — 되돌리기 세션에는 걸지 않는다) · 회신만 재시도(MARGIN_MS > 회신 예산).
  ③ 가져간 상태 변경의 미회신 = 결과 모름(다시 보내지 않음) · `onLate` 를 준 작업(등록)만 늦은 회신을 받아 원장에 넣거나 그 잡을 끈다 · 인출 전 시한 = 보내지 않음.
  ④ 인증 실패 회신은 **중앙이** 정지 기록, 성공 회신은 해제 — 회신 사이 중앙 접속값이 바뀌었으면 하지 않는다(`sameNow`) · 엣지 사본의 정지 키는 `edge-director:<id>`(엣지 자기 Director 와 나눈다).
  ⑤ 자동 설정 대행만 `secretArgs`(SSH·vCenter·**중앙이 만든** 새 콘솔 비밀번호): 대기열 사본은 **엣지가 인출하면 즉시 지움**(요청 본문은 응답까지) · 인출 전 시한 · 목록·로그·감사·응답에 없음.
  2단계는 중앙 판정·저장 가능 여부(`checkDirectorUpdate`)를 **보내기 전에** 보고, 회신 ok → 중앙 저장 · 엣지는 성공 즉시(시한 안일 때만) 사본 갱신.
  ⑥ 폴러는 엣지 Director 를 **기다리지 않는다**(진행 중 poll 1개 · 회신 때 같은 반영 함수 · 회신 전은 실패로 세지 않는다). 화면은 서버 대기 시간(`relayLimits`)만큼 기다리고 시한·504 는 결과 모름.
  확정분·남긴 것 전문은 `docs/rules/audits.md` 'Bareos v2.824 법인 엣지 대행 검토 확정분'.
- **v2.825.1 버그 점검**(사용자 요청 '버그 찾아서 수정' · `bareosBugs2825_1`·`_1b`): 성공으로 인증 정지를 풀 때는 **그 접속값이 지금 설정과 같을 때만**(`clearAuthStopIfSame`) ·
  복원은 설정만 보면 아는 전제를 OTP 앞에서 · 엣지 성공 회신에 유효한 잡 이름이 없으면 결과 모름 · `ops.poll` 은 **대조를 먼저**(work 가 예산을 넘어도 `.jobs`·다시 끄기가 돈다) ·
  엣지 자동 설정은 Director·서버마다 한 번에 하나(되돌리기까지) · 재시작하면 결과를 잃는 작업은 `inflight.js` → 업그레이드 자동 적용이 기다린다 · 취소의 끝난 행은 type B 만 반영.
  전문·남긴 것은 `docs/rules/audits.md` 'Bareos v2.825.1 버그 점검 확정분'.
- **v2.828 결과 창**(`decBytesText` 하나) — audits.md 'v2.833' 끝. **v2.841·842**: 목록 `.schedule` · @@own(job 제외) · 겹침은 화면·서버 둘 다 · 쓰기 OTP 는 세션 보안 `bareosSetupOtp`(기본 켬·불리언 false 만·꺼도 OTP 등록 계정만) — audits.md.
- **v2.830 백업 그룹**(`groups`·`groupSchedule`·`groupRunner`·`jobLocks` · `bareosGroups2830`): 스케줄은 포탈이 실행(그룹 잡은 Director 스케줄 없이 등록) · 회차는 **보내기 전에** 한 틱 한 번의 쓰기로 기록 · VM 은 그룹 하나 · 같은 Director 는 차례로 · 대상 잠금 공용. v2.831 보관 개수(`groupRetention` — 카탈로그 삭제)는 실행이 끝난 뒤 기준 Full 앞만·순서 어긋나면 안 지움 · 넓히는 저장은 본인 OTP(v2.831.1). 전문은 `docs/rules/audits.md` 'Bareos v2.830'·'v2.831' 절.
- **v2.833·834 진행 현황판**(`liveStatus`·`liveParse` · `bareosLive2833`): 화면이 열린 동안만 `status client=`·`status director` · Director 마다 시한 · 흐름은 법인마다 · 모름은 null · 멈춤 의심은 FD 조회 성공일 때만. 전문 audits.md 'v2.833'·'v2.834'(정책 수집 'v2.839'·'v2.840').
- 실환경 미확인(추정 — `tools/bareos-probe.js` 로 확인할 것): Node↔Director TLS-PSK 협상 · 잡 수준 FdPluginOptions 와 FileSet 플러그인 문자열 병합 ·
  `.bvfs_get_jobids` JSON 모양 · Profile ACL 지시어 이름 · `list jobs days=N` · 25.x `.jobs` 의 enabled 칸(master 소스 기준 — 없으면 다시 끄기를 하지 않는다) · Migration 행의 시작 시각.
- **v2.828 조회 화면**(`bareos-summary`·`bareos-detail` — Director 에 접속하지 않는다 · 원장 상한 3,000): 전문은 audits.md 'Bareos v2.828 조회 화면 모듈 규칙'(옮김).
- **v2.843 법인 로컬**(`bareosLocal2843`): 정리 미리 보기 `prunePreview`(pruneJobs 와 같은 판정 · delete 없음 · MUTATING 밖) · 설정 응답 `siteAgent` — audits.md 'v2.843'.
- **v2.844 완전 설치**: 규칙 전문은 `install/CLAUDE.md`(엣지 노드 안 러너 · 그 단계만 되돌림 · 볼륨 삭제 세 겹 · 번들 서명 · OTP 코드 없음).
