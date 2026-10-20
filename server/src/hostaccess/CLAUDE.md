# 호스트 접근 제어(`hostaccess/`, v2.485) 불변조건 — 되돌리지 말 것

> `server/CLAUDE.md` 에서 옮긴 절(2026-10-20). 이 폴더 파일을 읽을 때 자동으로 로드된다. 원문 그대로다.

포탈 호스트의 SSH/웹 클라이언트 제어·OS 방화벽 추가 규칙을 firewalld 로 적용한다. 서버 접근 경로를 바꾸는 기능이라
잠금 사고(lockout)와 권한 남용을 막는 아래 규칙이 핵심이다(`docs/HOST-ACCESS.md`).

- **commit-confirm**: `applyHostAccess` 는 런타임(`--permanent` 없음)에만 적용하고 `pending`(기한 1~30분)을 파일에 남긴다.
  기한 안에 `confirmHostAccess`(`--runtime-to-permanent`)가 없으면 **자동 `--reload`** 로 직전 영구 설정을 복원한다.
  기동 시 `resumeHostAccessPending` 이 기한을 이어받는다(index.js stagger). 이 타이머·복구를 없애면 잘못 적용한 규칙이
  영구히 남아 관리자가 잠긴다. 중간 명령 실패 시에도 즉시 `--reload`(반쯤 적용된 상태 금지).
- **자기 잠금 방지 검사는 서버(`render.planCommands`)가 강제**한다 — 웹 허용목록에 요청자 IP(`clientIp(req)`) 미포함,
  포탈 포트 누락(정규화가 항상 포함), 존 target `ACCEPT`, 추가 규칙의 포탈 포트 전체 drop/reject 는 오류로
  실행을 막는다. 화면 검증만으로 대체하지 말 것. 웹 모드에는 '차단' 이 없다.
  ⚠ v2.731(점검 1회차 A4-03): '포탈 포트' 는 `config.port` 가 아니라 `util/httpsServer.js listeningPortalPorts()` — **실제로 듣는 포트 전부**다
  (TLS_PORT 만 열면 그 포트, TLS_HTTP_ALSO 면 둘 다). config.port 만 보면 TLS 전용 구성에서 허용목록이 정작 쓰는 4443 을 빼고 닫았다.
  상태 응답 `portalPorts` 를 화면이 말한다. svcmon·selfRegister 처럼 '남에게 알리는 포트' 는 `advertisedListen` 이다(둘을 섞지 말 것).
- **sshd 서비스 중지/재개는 확정 단계에서만**(`confirmHostAccess`) 실행한다 — 런타임 실험 중 SSH 세션을 끊지 않기 위해.
  포탈이 중지한 경우만 `applied.sshdStopped=true` 로 기록해 되돌릴 때 재시작한다(사람이 내린 sshd 는 건드리지 않음).
- **권한 경계**: 적용·확정은 `adminOnly + requireSettingsOwner + 본인 OTP(verifyUserOtp)`. OTP 미등록 계정은 403(needEnroll).
  되돌림은 OTP 없이(안전한 방향). 조회는 admin. 전부 `logAudit`.
- **실행 경계**: `exec.js` 는 셸 없이 spawn 하고 `sudo -n /usr/bin/firewall-cmd` 와 `sudo -n /usr/bin/systemctl
  {stop,start,disable,enable} sshd.service` 만 부른다(sudoers 줄과 인자가 정확히 같아야 한다 — `install.sh`
  `/etc/sudoers.d/vmware-portal-hostaccess`). 사용자 입력은 `normalizeSettings`(CIDR·포트 정규식)를 거친 값만 rich rule
  문자열에 들어간다. 자유 인자 실행 경로를 추가하지 말 것.
- **관리 대상 규칙만 건드린다**(`isManagedRich`): ssh 서비스/22/tcp/`service name="ssh"` rich rule, 웹 포트의
  `port port="P"` rich rule·`P/tcp`·http/https, 추가 규칙, 직전 적용분(`applied.rich`). 그 밖의 존 설정(다른 서비스·포트·
  인터페이스·다른 존)은 보존한다 — 전체 존을 '포탈 설정으로 교체' 하는 방식으로 바꾸지 말 것.

