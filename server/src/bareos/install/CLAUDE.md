# Bareos 완전 설치(`server/src/bareos/install/`, v2.844) 불변조건 — 되돌리지 말 것

사용자 요청(2026-11-01): '엣지 노드의 ip/id/pw 를 알고 있으니 bareos 를 완전히 자동으로 설치' · '실패하면 구체적으로 오류를 알려주고 고쳐서 다시 시도' ·
결정: 엣지 노드에 함께 · 오프라인 번들 · 설치~4단계 자동 + vCenter 비밀번호 1회 · **OTP 코드 없음(OTP 를 등록한 관리자만)** · pyVmomi 판 선택(권고 8) ·
설정 탭 안 · Director 등록 법인은 **완전 초기화 후 재설치**(실행 때마다 범위 선택 — 패키지·설정 필수, 카탈로그 DB 기본 삭제, 볼륨 기본 보존) · WebUI 포함.
회귀: `server/test/bareosInstall2844.test.js` · `bareosInstallRunner2844.test.js`(runner.sh 를 가짜 루트 + 명령 대역으로 **실제 bash 실행**) · `bareosInstallJob2844.test.js`(중앙 흐름 — 상태 출력은 실제 bash) — 변이 14/14 ·
웹 `web/src/views/tools/bareosInstall2844.test.js`.

- **구조(사용자 원칙 '백업은 법인 로컬')**: 0~3단계는 `runner.sh` 가 **엣지 노드 안에서** `systemd-run --unit=portal-bareos-install` 으로 돈다 —
  중앙은 짧은 SSH 로 `run/state`·`run.log`·`err.<n>` 만 읽는다(화면을 닫거나 중앙이 재시작해도 계속 · 기동 때 `resumeInstallJobs`).
  4~7단계(Director 리소스·FD 플러그인·엣지 경유 probe·매핑)는 기존 `autoSetup` 코드를 그대로 쓴다(MARKER · 남의 파일 거부 · 되돌리기 규칙 그대로).
  4단계의 새 콘솔 확인은 `ctx.verifyConsole`(서버 안 bconsole) — 담당이 엣지인 Director 는 중앙이 9101 에 붙지 않는다(방화벽을 열지 않는다).
- **러너 값은 화이트리스트만**: `plan.env` 는 `plan.js planEnv` 가 값마다 정규식 + 따옴표·`$`·백틱·역슬래시·줄바꿈 거부. 비밀은 싣지 않는다
  (SD 비밀번호는 러너가 서버 안에서 읽어 Director 스토리지 파일에만 · 콘솔 비밀번호는 4단계 SFTP 임시 파일). 화면 입력이 러너에 들어가는 길을 새로 만들면 planEnv 를 지날 것.
- **그 단계만 되돌린다**: 러너는 단계마다 `journal.<n>` 에 바꾼 것(새 패키지 이름 diff · 만든 파일 · 켠 서비스 · 방화벽 · SELinux · pip · 옮긴 사본 · PG 초기화 · DB)을 적고
  실패하면 그 단계만 역순으로 되돌린다. **원래 있던 것은 지우지 않는다**(rpm 이름 diff · `etcnew` 는 설치 전 /etc/bareos 가 없을 때만 · 남의 파일·심링크면 멈춤).
  업그레이드된 기존 패키지는 되돌리지 않는다(오프라인에 옛 RPM 이 없다 — 로그가 밝힌다). 0단계(초기화)는 되돌리지 않는다(지운 것은 복구 불가 — 다시 하면 이미 한 것은 건너뜀).
- **초기화 볼륨 삭제는 세 겹**: 화면 확인(법인 이름 입력) → 서버 `planEnv` 가 시스템 경로를 빼고 → 러너가 **지우기 전에 읽은 SD 설정의 Archive Device** 와 겹치는 것만,
  `safe_voldir`(시스템 경로·얕은 경로·`..`·심링크 거부)를 지난 것만 **안의 파일**을 지운다(디렉터리는 남긴다). 지우기 전 /etc/bareos 는 엣지 안 `reset/` 에 tar 로 보관(법인 밖으로 보내지 않는다).
- **번들 신뢰**: 포탈 릴리스와 **같은 서명 키·같은 검증 코드**(`upgrade/signatureCore`) — 서명 + 두 파일(tar · 내용 목록) 해시 + 판 일치가 맞는 것만 쓴다(정책 warn 폴백 없음).
  엣지에 올린 뒤 sha256 을 다시 대조하고, 러너도 1단계에서 `TAR_SHA256` 과 대조한다. dnf 는 번들 저장소만(`--disablerepo='*'`) · `gpgcheck=1`(서명을 끄고 설치하지 않는다).
  번들 해시는 스트림(`sha256File`) — 수백 MB 를 동기로 읽어 이벤트 루프를 막지 않는다.
- **pyVmomi 는 8.x 만**(현장 실측 — Rocky 9 Python 3.9 에서 9.x 는 'Python 3.10 or newer is required'). 번들에 9.x 휠을 넣지 않고(`build-bundle.sh` 가 거부) 화면도 고를 수 없다.
  설치 뒤 `PYTHONPATH=<플러그인 경로>` 로 **실제 불리는 판**을 확인한다(두 곳에 다른 판 — pyvmomi-shadow). 고치기는 사본을 **옮긴다**(지우지 않는다 — moved/).
- **라우트**: 경로는 `/tools/bareos-backup/settings/install`(데모 계정 `READ_DENY` 접두가 덮는다) · admin + `fullScopeOnly` + `fullWriteOnly` + `installGate`
  (데모 계정 403 · 인증이 켜졌으면 **OTP 를 등록한 계정만** — 코드는 묻지 않는다) · 감사 `[OTP 없이 실행]` · 감사·응답에 원격 출력 원문·비밀 없음.
  SSH 인증 실패는 자동 재시도하지 않는다(다시 하기는 `sshFixed` 확인 필요 — 계정 잠금).
- **원인 판정은 지어내지 않는다**(`causes.js`): 근거 = 출력에서 실제로 맞은 줄 · 맞는 규칙이 없으면 '원인 미분류' + 원문. 출력은 `scrubOutput`(저장 SSH·콘솔 비밀번호와 같은 글자가 있는 줄은 뺀다).
- **대상**: 행 = vCenter(법인 · vCenter · Bareos 1:1:1) · 엣지 = 인벤토리를 올리는 엣지(응답 = 인벤토리 수신 · 마지막 인증된 중앙 요청 중 최근 값 — v2.849 `central/agentContact.js`) · SSH = 배포 등록부(비밀번호 저장된 것만 — 4·5단계 autoSetup 이 비밀번호 SSH 만 쓴다) ·
  재설치는 Director 주소가 그 엣지(SSH 주소 또는 이 기능이 기록한 서버 주소)일 때만 — 다른 서버의 Bareos 는 지우지 않는다.
- **반증 검토 확정분(v2.844 — 되돌리지 말 것 · `bareosInstallJob2844` 가 실제 bash 출력으로 고정)**:
  상태 읽기는 **줄 단위 구간**(`readCmd`·`parseRead` — '\n@@unit\n' 로 자르면 err 파일이 없을 때 유닛 상태를 못 읽어 정상 러너를 '중단' 으로 기록했다 · H1) ·
  실행 디렉터리는 **작업마다** `run/<작업 id>`(러너가 인자와 plan.env 의 JOB_ID 를 대조 · H2) · 다시·되돌리기는 그 법인·같은 서버의 **가장 새 작업만**(`requireLatest`) ·
  다시 하기는 **실패한 단계부터만**(앞 단계·초기화를 확인 없이 되풀이하지 않는다) · 러너 회차 시작 표지 `begin`(앞 회차 'all done' 무시 · M3) ·
  업로드 중 중단이면 러너를 띄우지 않는다(M1) · 볼륨 삭제는 `realpath -e` 결과가 적힌 경로와 같을 때만(부모 심링크 우회 · M2) ·
  전부 되돌리기는 **원격 먼저 → 성공하면 포탈 등록·매핑**, 이 설치의 Director 에 백업 대상이 있으면 거부(M4) · 배포 등록부의 SSH 주소가 작업 시작 때와 다르면 거부(M5) ·
  원격 단계 시한 4시간(폴링 + 유닛 `RuntimeMaxSec` · M6) · 동시 시작 준비 잠금(L1) · 실행 중 작업은 bconsole 접속이 확인될 때만 센다(못 읽으면 확인 불가 · L2) ·
  출력의 `Password = ...` 값 가림(L4) · `dnf remove --noautoremove` · firewalld 는 `--reload` 없이 런타임·영구를 따로(호스트 접근 제어의 확정 대기 규칙을 버리지 않게 · L5).
  L3: v2.845 는 잠금 표를 `bareos/setupLocks.js` 하나로 합쳤지만 ⚠ 완전 설치는 **SSH 주소 하나만** 쥐었다(Director id · 러너가 읽은 서버 주소 hostAddr 는 안 쥠 —
  예전 문구 '서로 막는다' 는 과장이었다 · v2.846 C-3 재현). ✅ v2.846: 작업이 도는 동안(원격 단계 포함) **Director id(재설치 · 4단계에서 새로 등록하면 그때 더함) +
  SSH 주소 + 서버 주소**를 한 소유 키로 쥔다(`claimSetupGroup` · `addSetupGroupDirector` — 자동 설정 · 법인별 설정의 단건 API 는 그대로 막힌다 · 진행 중 Director 저장·삭제도 409).
  마무리(FD 지문 · INI)도 가장 새 작업 · M5 · Director·서버 잠금(`finishContext` · `finishOp`).
  ⚠ v2.845 정정(반증 E1): 4단계 새 콘솔 확인의 임시 bconsole.conf 에 `Port =` 를 썼다 — 번들 bconsole 바이너리의 키워드는 `DirPort`(실측 · `Port` 별칭은 확인 못 함). `DirPort` 로 바꿨다.
  남긴 것: bconsole 접속 문구('Connecting to Director')는 실환경 미확인(다르면 '확인 불가' 쪽으로 — 0 으로 보지 않는다).
- **v2.846 버그 점검 확정분(되돌리지 말 것 · `bareosInstallBugs2846` — 러너는 실제 bash · 변이 검증)**:
  ① 전부 되돌리기의 잠금 실패 · 예외 · 인증 실패는 **'rollback-failed'**(`recordRollbackFailed` — cause busy · ssh-auth · remote · timeout)로 남긴다 — 설치 실패('failed')로 적으면
  그 '그대로 다시' 가 0단계(초기화)부터 돌았다(C-1). 화면은 '다시 되돌리기'. 다시 하기(`retryInstall`)는 **되돌리기를 시도한 작업이면 거부**한다
  (⚠ 'failure.step 이 없으면 거부' 로 넓히지 말 것 — 첫 시작 잠금 실패의 정상 재시도까지 막는다). 중앙 재시작 뒤 되돌리기 이어 하기는 러너를 **다시 띄우지 않고 상태만 읽는다**.
  ② 되돌리기 폴링은 SSH 인증 실패면 즉시 멈춘다(자동 재시도 금지 · 다시 되돌리기는 `sshFixed`) · 그 밖 오류는 늘려 가며(C-2).
  ③ 러너 0단계의 실행 중 작업 판정은 사전 점검 · `manage/apply.js` RUNNING_CMD 와 같은 규칙(rc 0 + 'Connecting to Director' + 오류 문구 없음일 때만 센다 · Director 꺼짐 = 없음 ·
  그 밖은 unknown → **멈춤**). 화면의 '확인했음 — 실행 중 작업 확인 없이 진행' 동의만 `RUNNING_UNKNOWN_OK=1`(planEnv 화이트리스트 · **그 회차의 시도 행에만** — 계획 값이 아니라 다시 하기로 이어지지 않는다 · D-2).
  ④ 전부 되돌리기의 M4 는 재설치(기존 Director 를 다시 등록해 쓰는 작업)에도 적용(D-4) · 백업 대상 원장을 못 읽으면 503(대상 수를 0 으로 보지 않는다 · D-7).
  ⑤ 화면: postJson 은 409 를 던지지 않는다 — `okOrThrow` 로 `ok:false` 를 성공으로 보이지 않는다(U-7 · 시작의 precheck 표 되돌림) · 볼륨 크기 합은 못 읽은 것을 0 으로 더하지 않는다(U-12).
- **v2.847 2회차 점검(되돌리지 말 것 · `bareosBugs2847b` · 웹 `bareosBugs2847` — 변이 포함)**: 실패 · 중단 카드의 '전부 되돌리기' 는 **아는 칸만**(`sshFixed === true`) 넘긴다 —
  `onClick={onRollback}` 이 클릭 이벤트를 본문에 펼쳐 요청이 나가지 않았다(U2-1 · v2.846 회귀) · SSH 인증 실패로 멈춘(failed · stopped) 작업의 첫 되돌리기도 `sshFixed` 필요(S2-2) ·
  M4 는 `jobDirectorId` 로 센다(directorId 없는 옛 대상 — D2-5) · 기동 때 **HTTP 를 열기 전에** 이어 읽을 작업(원격 단계 · 되돌리는 중)의 잠금을 선점하고(`reserveInstallResumeLocks`) kick 이 넘겨받는다 ·
  이어 읽기가 잠금을 못 잡으면 'failed' 로 적지 않고 30초 뒤 다시(러너는 서버에서 돈다 — C2-2) · 화면 동의 `runningUnknownOk` 는 **지금 사전 점검이 확인 불가일 때만** 시작 본문에 싣는다(U2-5).
- **v2.850 번들 받는 곳 · 서버 디렉터리**(사용자 요청 · `bareosBundleSource2850` 변이 10/10 · 웹 `bareosBundleSource2850`): 받는 주소는 화면 저장값 > env `BAREOS_BUNDLE_BASE_URL` > 업그레이드 패키지 주소에서 유도
  (`bundleSourceInfo` · 저장 `bundleSource.js` — http/https · 계정 정보 · ?# 금지 · `ssrfBlockReason` 차단 대역 거부). **서버 디렉터리**는 읽기만 한다(복사 · 삭제 없음 — 지우기는 받은 번들 폴더만) ·
  같은 서명 · 해시 검증을 지난 판만 쓰고(`listAllBundles` · `pickBundle` 이 두 폴더) · 개요(화면 열기)가 검증(같은 파일은 기억 · 동시 해시 하나) · 막 바뀐 본체는 `SETTLE_MS` 동안 '확인 중'(서버 디렉터리만 — 포탈이 받은 직후 검증을 막지 않게) ·
  심링크 · 일반 파일이 아닌 것 거부 · 받기는 서버 디렉터리에 같은 판이 검증돼 있으면 받지 않는다.
- **데모**: mock + 실제 Director 미등록이면 `demo.js`(시간으로 진행하는 합성 작업 · 판정은 실제 코드 · 장비에 닿지 않음).
- 실환경 미확인(추정 — 첫 현장 설치에서 확인할 것): Bareos `current` 사전 공개판 RPM 이 Rocky 9.x 의 각 마이너에서 `--alldeps` 로 풀리는지(CI 는 rockylinux:9 최신에서만 확인) ·
  `bconsole -c`(이름 있는 Console) TLS-PSK 접속 출력 모양 · `update_bareos_tables` 가 카탈로그 유지 재설치에서 판 차이를 맞추는지 · WebUI 첫 화면 응답 코드.
