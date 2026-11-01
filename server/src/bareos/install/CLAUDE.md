# Bareos 완전 설치(`server/src/bareos/install/`, v2.844) 불변조건 — 되돌리지 말 것

사용자 요청(2026-11-01): '엣지 노드의 ip/id/pw 를 알고 있으니 bareos 를 완전히 자동으로 설치' · '실패하면 구체적으로 오류를 알려주고 고쳐서 다시 시도' ·
결정: 엣지 노드에 함께 · 오프라인 번들 · 설치~4단계 자동 + vCenter 비밀번호 1회 · **OTP 코드 없음(OTP 를 등록한 관리자만)** · pyVmomi 판 선택(권고 8) ·
설정 탭 안 · Director 등록 법인은 **완전 초기화 후 재설치**(실행 때마다 범위 선택 — 패키지·설정 필수, 카탈로그 DB 기본 삭제, 볼륨 기본 보존) · WebUI 포함.
회귀: `server/test/bareosInstall2844.test.js` · `bareosInstallRunner2844.test.js`(runner.sh 를 가짜 루트 + 명령 대역으로 **실제 bash 실행** — 변이 6/6) ·
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
- **대상**: 행 = vCenter(법인 · vCenter · Bareos 1:1:1) · 엣지 = 인벤토리를 올리는 엣지 · SSH = 배포 등록부(비밀번호 저장된 것만 — 4·5단계 autoSetup 이 비밀번호 SSH 만 쓴다) ·
  재설치는 Director 주소가 그 엣지(SSH 주소 또는 이 기능이 기록한 서버 주소)일 때만 — 다른 서버의 Bareos 는 지우지 않는다.
- **데모**: mock + 실제 Director 미등록이면 `demo.js`(시간으로 진행하는 합성 작업 · 판정은 실제 코드 · 장비에 닿지 않음).
- 실환경 미확인(추정 — 첫 현장 설치에서 확인할 것): Bareos `current` 사전 공개판 RPM 이 Rocky 9.x 의 각 마이너에서 `--alldeps` 로 풀리는지(CI 는 rockylinux:9 최신에서만 확인) ·
  `bconsole -c`(이름 있는 Console) TLS-PSK 접속 출력 모양 · `update_bareos_tables` 가 카탈로그 유지 재설치에서 판 차이를 맞추는지 · WebUI 첫 화면 응답 코드.
