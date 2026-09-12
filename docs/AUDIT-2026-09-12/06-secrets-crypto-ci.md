# 06. 암호화 · 비밀 저장 · CI/공급망 감사 (읽기 전용, 2026-09-12, 기준 커밋 233559b v2.487.0)

범위: `server/src/auth/*`, `security/secretVault.js`·`credentialStore.js`, `util/atomicWrite.js`·`secureCompare.js`,
`packaging/offline/*`(systemd·sudoers), `.github/workflows/*`, `packaging/release/*`, `.gitignore`/git 트리.
이전 감사(`security_check_20260809.MD`, `docs/AUDIT-2026-08-17.md`)에서 해소된 항목은 재보고하지 않았다.
(I-R1 scrypt N=16384 는 이미 문서화된 후속 항목이라 제외.) 코드로 확인한 것만 적고, 실행 재현이 없는 부분은 '추정'으로 표기.

---

## 확정 결함

### F-1 [Medium] 호스트 접근 제어 sudoers — 인자 제한 없는 `firewall-cmd` NOPASSWD 규칙 (CWE-250 / CWE-269)

- 위치: `packaging/offline/install.sh:207`, `server/src/hostaccess/service.js:23` (v2.485 신규 — 이전 감사 이후 추가)
- 코드:
  ```
  %s ALL=(root) NOPASSWD: /usr/bin/firewall-cmd
  %s ALL=(root) NOPASSWD: /usr/bin/systemctl stop sshd.service, /usr/bin/systemctl start sshd.service, ...
  ```
  같은 파일의 RMA 규칙(`install.sh:189-197`, `rma/unitTemplate.js:47-55`)은 `systemctl <verb> <unit>.service` 로
  인자를 고정하는데, 호스트 접근 규칙만 `firewall-cmd` 전체를 인자 없이 허용한다. 주석("정확히 이 명령들만 허용")은
  systemctl 줄에만 해당한다.
- 공격 전제: 서비스 계정(`vmportal`)으로 코드 실행 — RMA 에이전트 프로세스(`vmware-portal-rma@.service` 는
  `NoNewPrivileges=false`, 같은 계정)의 침해, 포탈 RCE, 또는 그 계정 셸.
- PoC(서비스 계정에서):
  ```
  sudo -n /usr/bin/firewall-cmd --set-default-zone=trusted          # 호스트 방화벽 사실상 해제
  sudo -n /usr/bin/firewall-cmd --direct --passthrough ipv4 -I INPUT -j ACCEPT
  sudo -n /usr/bin/firewall-cmd --panic-on                            # 전 트래픽 차단(DoS)
  ```
  root 셸로의 직접 상승은 확인하지 못했다(추정: `--new-zone-from-file=` 계열이 root 로 임의 파일을 읽지만 XML 파서
  오류 메시지에 내용이 실리는지는 미검증). 확인된 영향은 **호스트 방화벽 정책 전체 장악·DoS** 로, 포탈이 방화벽으로
  SSH/웹 클라이언트를 제한하는 기능(v2.485)의 목적 자체를 무력화한다.
- 수정: (a) 래퍼 스크립트(`/usr/local/sbin/vmportal-fw`)를 root 소유 0755 로 두고 그 안에서 허용 서브커맨드
  (`--list-all`, `--add-rich-rule=`, `--remove-rich-rule=`, `--reload`, `--state`)만 화이트리스트 → sudoers 는 래퍼만 허용;
  (b) 또는 sudo 대신 firewalld D-Bus API 를 polkit 규칙(`org.fedoraproject.FirewallD1.config` 등 필요한 메서드만,
  `subject.user == "vmportal"`)으로 허용 — F-2 와도 함께 해결된다.

### F-2 [Medium] `NoNewPrivileges=true` 유닛 안에서 `sudo -n` 호출 — 기능 불능 → 하드닝 해제 유도 (CWE-250, 회귀 위험)

- 위치: `packaging/offline/vmware-portal.service:29` (`NoNewPrivileges=true`) ↔ `server/src/hostaccess/exec.js:27-31`
  (`run('sudo', ['-n', FIREWALL_CMD, ...])`, `sshdCtl`), `docs/HOST-ACCESS.md:11-12`.
- 내용: 본체 유닛은 `NoNewPrivileges=true` 라 setuid 가 무시되어 `sudo` 는 root 로 전환하지 못한다
  (`sudo: The "no new privileges" flag is set, which prevents sudo from running as root`). 호스트 접근 제어는 본체
  프로세스에서 `sudo -n` 을 부르므로 **설치 직후 상태에서 동작할 수 없다**. `exec.js:35 isSudoDenied` 정규식
  (`a password is required|not allowed to execute|...|sudoers`)은 이 메시지를 인식하지 못해 일반 실패로 보고되고,
  문서/화면은 "sudoers 줄을 추가하라"고만 안내한다 → 운영자가 유닛의 `NoNewPrivileges` 를 끄는 방향으로 '고칠'
  가능성이 높고, 그 순간 포탈 전체(모든 RCE 경로)에 F-1 의 sudo 규칙이 열린다.
  (실행 재현은 하지 않았다 — 유닛 파일과 sudo 의 NNP 동작으로 판단. RMA 유닛은 이 이유로 `NoNewPrivileges=false` 를
  명시하고 있어(`vmware-portal-rma@.service:24-25`) 작성자도 제약을 인지하고 있었다.)
- 수정: 본체의 `NoNewPrivileges=true` 는 유지하고, 방화벽 조작을 (a) polkit+D-Bus(setuid 불필요, NNP 하에서도 동작)
  또는 (b) 별도 최소 권한 헬퍼 유닛(socket-activated, 고정 argv)으로 위임. `isSudoDenied` 에 `no new privileges`
  패턴을 추가해 화면이 "유닛 하드닝을 끄지 말고 헬퍼를 쓰라"고 안내하게 할 것. `docs/HOST-ACCESS.md` 도 갱신.

### F-3 [Low] `.gitignore` 가 비밀 파일 3종(SECRET_FILES) + 2종을 누락 (CWE-540 / CWE-312)

- 위치: `.gitignore` ↔ `server/src/security/secretVault.js:58-78 SECRET_FILES`
- 확인(`git check-ignore`): 아래는 **무시되지 않는다**.
  - `server/config/pdu-devices.json` (PDU 접속 비밀번호, `pdu/registry.js:42`)
  - `server/config/relay-topology.json` (Main/Edge/IRS SSH 비밀번호·개인키·패스프레이즈, `relaytopo/store.js:111`)
  - `server/config/mail.json` (SMTP 비밀번호, `mail/settings.js`)
  - `server/config/active-sessions.json` (세션 sid), `server/config/portal.env` (`.env` 패턴은 정확일치라 불일치)
  - 기본 정책(`secrets-policy.json` 미설정)은 **평문 저장**이므로 커밋되면 즉시 평문 유출이다.
- 공격 전제: 개발자가 `CONFIG_DIR` 미설정(기본 `server/config`)으로 기동 후 `git add -A` — `.gitignore` 주석
  (`initial-admin-password.txt` 항목)이 같은 사고 유형을 이미 기록하고 있다.
- 수정: 세 파일을 추가하고, 근본적으로 `server/config/*` 전체를 무시 + `!server/config/*.example.json`
  `!server/config/vcenter-order.json` 등 추적 파일만 예외 허용으로 전환(신규 저장소 추가 시 누락 구조 제거).
  `test/`에 `SECRET_FILES ⊆ .gitignore` 검사 추가.

### F-4 [Low] 런타임 SQLite DB 2개가 git 에 추적됨 (CWE-538)

- 위치: `server/config/capacity.db`(1.4MB, `samples` 437행, `hosts` 에 개발 PC `hostname:"WIN-2022-EQ01"` 포함),
  `config/vm-track.db`(저장소 루트, mock `vc-us-east` 데이터). 최근 커밋 c650240 에서도 갱신되고 있다.
- 영향: 개발 호스트명·성능 시계열 노출 + 커밋마다 바이너리 diff(저장소 비대). 자격증명은 없음(확인).
- 수정: `git rm --cached` 후 `.gitignore` 에 `*.db`, `*.db-wal`, `*.db-shm`, `config/` 추가.

### F-5 [Low] 릴리스 빌드가 `npm install`(lockfile 비강제) 사용 — CI 테스트와 의존성 불일치 가능 (CWE-1357 / CWE-829)

- 위치: `.github/workflows/release.yml:42-43` → `package.json:8 "install:all": "npm install && npm --prefix server install && npm --prefix web install"`.
  `ci.yml:36-39` 는 `npm ci` 를 쓴다.
- 영향: `package.json` 과 lockfile 이 어긋나면 `npm install` 은 lockfile 을 갱신하며 다른 버전을 설치 → CI 가 검증한
  트리와 다른 의존성이 오프라인 설치 패키지·자동 업그레이드 번들(전 함대 확산)에 실린다. 실행 재현은 없음(추정 영향).
- 수정: `install:all` 을 `npm ci && npm --prefix server ci && npm --prefix web ci` 로(또는 `install:ci` 추가해 release 에서 사용).

### F-6 [Low] GitHub Actions 를 메이저 태그로 고정 (CWE-829)

- 위치: `ci.yml:30,32,88,90`, `release.yml:35,38,142,145`, `horizon-monitor-release.yml:23,25,39`
  (`actions/checkout@v4`, `setup-node@v4`, `setup-python@v5`, `setup-dotnet@v4`, `upload-artifact@v4`).
- 영향: 태그 재지정(2025년 `tj-actions` 사례 유형) 시 `contents: write` 권한의 release 잡에서 임의 코드 실행 → 릴리스
  자산 교체. 수정: 커밋 SHA 고정 + Dependabot `github-actions` 생태계 활성화.

---

## 정보성 / 추정

- **I-1 secretVault 기본 정책 = `plain`** (`secretVault.js:95`): 소유자가 명시 전환하기 전까지 vCenter/NSX/SSH 키 등
  전 자격증명이 평문(0600)이다. 설계 문서화됨. 신규 설치는 `encrypted`/level 2 를 기본으로 두고 마이그레이션은
  기존 설치에만 적용하는 것을 권장.
- **I-2 백업 아카이브 비원자 쓰기** (`backup/service.js:54 fs.writeFileSync(..., {mode:0o600})`): 신규 파일이라
  데이터 유실은 없으나 크래시 시 잘린 `.json.gz` 가 목록에 남는다(복원 시 파싱 실패). `atomicWriteFileSync` 로 통일 권장.
- **I-3 `openSecret` 의 logN 무제한** (`secretVault.js:203-205`, 추정): 암호문에 실린 `logN` 을 검증 없이 scrypt 에
  넣는다. `maxmem 256MB` 가 상한이라 logN≥18 은 즉시 throw, ≤17 은 값당 수 초 CPU. 전제가 '설정 파일 쓰기 권한'
  이라 실효 위험은 낮다. `logN` 을 14~16 로 clamp 권장.
- **I-4 `util/smtp.js:95` MIME 경계에 `Math.random`**: 비밀이 아니고 공격자가 본문과 경계를 동시에 제어하는 경로는
  확인되지 않음. `crypto.randomBytes(8)` 로 바꾸면 논쟁 여지가 사라진다. 그 외 `Math.random` 사용처
  (`captureHistory`·`bulkDeploy`·`sanswitch/storage/pdu registry`·`vmclone`·`nfsMounts` id, `svcmon batch` id, 폴링 지터)
  는 모두 **비밀이 아닌 식별자/지터**로 확인 — 토큰·티켓·비밀번호에는 사용되지 않는다.
- **I-5 `gpu/guestops.js:397`**: 게스트 사용자 추가 시 `NOPASSWD:ALL` sudoers 를 쓰는 옵션(`nopasswd`)이 있다 —
  admin 명시 옵션이며 대상은 게스트 VM. 감사 로그에 이 옵션 값이 남는지는 미확인(추정).

---

## 확인된 양호한 방어 (파일 참조)

**세션 토큰 / 인증**
- HS256 HMAC JWT, 서명은 헤더의 `alg` 를 신뢰하지 않고 항상 HMAC-SHA256, 길이 검사 + `timingSafeEqual` (`auth/auth.js:86-110`).
- `AUTH_SECRET` 미설정 시 `CONFIG_DIR/auth-secret`(0600, 원자적) 1회 생성·영속; 파일 쓰기 실패 시에만 프로세스 랜덤 + 경고
  (`auth.js:48-67`). 설치 스크립트는 32바이트 랜덤 `AUTH_SECRET` 을 `portal.env`(0640) 에 기록(`install.sh:93-97`).
- 토큰 폐기: `tokenVersion` 대조 + 단일 세션 `sid`(`auth.js:886-912`, `sessions.js:60` 128bit `randomBytes`).
- `/auth/extend`: 경고 창 안에서만, 기존 `exp` 기준 연장, `sessionMaxHours` 절대 상한, `sid/tv` 승계, 감사로그
  (`routes/auth.js:128-169`).
- 비밀번호: scrypt + 16바이트 랜덤 솔트 + `timingSafeEqual`, 미존재 사용자에도 동일 비용 scrypt(열거 방지) (`auth.js:20-36, 293`).
- 초기 관리자 비밀번호: 12바이트 랜덤, 파일 0600, admin OTP 등록 확정 시 자동 삭제 (`auth.js:173-177, 799-801`).

**TOTP**
- 시크릿 20바이트 `crypto.randomBytes`, RFC 6238 SHA1/30s/6자리, ±1 창, `timingSafeEqual` (`auth/totp.js:14-21, 53-66`).
- 재사용 방지 `minCounter`(로그인·재인증·등록확정 모두 기록: `auth.js:301-304, 762-770, 791`), 재인증 잠금
  (`checkOtpAllowed/recordOtpFailure`, `auth.js:758-767`), 로그인 경로는 IP+계정 레이트리밋(`routes/auth.js:50-59`).
- pending 시크릿은 confirm 전 활성 시크릿을 건드리지 않음(`auth.js:734-738`); begin/confirm 양쪽 동일 권한 경계
  (`credentialGuardDenied`, `auth.js:685-691, 784`).

**비밀 저장(secretVault / credentialStore)**
- AEAD 만 허용(AES-GCM 128/192/256, ChaCha20-Poly1305), 봉인마다 새 16바이트 salt + 12바이트 IV, scrypt KDF, 자기서술 포맷
  (`secretVault.js:85-90, 180-193`) — IV 재사용 없음.
- 마스터 키 `SECRETS_KEY` env 우선, 없으면 `secrets-key`(0600, 원자적) (`secretVault.js:139-157`).
- 정책 fail-safe: 손상 시 `_lastGoodPolicy` 유지 + 암호화였다면 경고(`secretVault.js:104-118`) — 2026-08-17 #11 조치 유지 확인.
- 마이그레이션 중 복호 실패 파일은 재기록하지 않음(암호문 소거 방지, `secretVault.js:265-269`).
- `credentials.json`: 읽기 API 는 비밀 미반환(`publicView`), 브로커는 agent+host 이중 검사, 사용 카운터는 별도 파일
  (`credentialStore.js:129-137, 205-216`).

**원자적 쓰기 / 권한**
- `atomicWriteFileSync`: `openSync(tmp,'w',mode)` 로 처음부터 0600, fsync → rename → 디렉터리 fsync, 실패 시 tmp 정리
  (`util/atomicWrite.js:10-27`); `preserveCorrupt` (`:36-44`). 점검한 비밀 스토어(pdu/relaytopo/mail/credentials/sessions)
  전부 `mode:0o600` 로 호출.
- `install.sh`: `CONFIG_DIR` 0750, `portal.env` 0640, `settings-owners.txt` 0600, `rma-*.env` 0640, 서비스 계정 소유 (`:93, 115, 134-136, 222`).
- 본체 유닛 하드닝: `NoNewPrivileges/PrivateTmp/ProtectSystem=full/ProtectHome/ProtectControlGroups/ProtectKernelTunables/RestrictSUIDSGID`,
  `NODE_ENV=production` (`vmware-portal.service:19, 29-37`).
- RMA sudoers: argv 고정(`systemctl <verb> <unit>.service`), 유닛명 정규식, `RMA_ALLOW_REBOOT` 옵트인, `visudo -cf` 통과
  시에만 0440 설치, uninstall 이 제거 (`install.sh:187-198`, `rma/unitTemplate.js:47-55`, `rma/deploy.js:113-117`, `uninstall.sh:31`).

**공유 토큰 / HMAC 비교**
- `util/secureCompare.js`: 랜덤 키 HMAC 으로 길이까지 정규화한 상수시간 비교; `tokenMatches` 를 central 공유 토큰
  (`routes/central.js:126`), 수집기 토큰(`routes/collector.js:26-28`), metrics export 토큰(`routes/metricsExport.js:36`,
  쿼리 토큰은 opt-in)에 사용. 개별 agent 토큰은 SHA-256 해시 저장 + 조기 종료 없는 `timingSafeEqual` (`central/agentTokens.js:104-113`).
- RMA 잡 서명: HMAC-SHA256, 정규화 직렬화, ±10분 skew, `timingSafeEqual` (`rma/signing.js`).
- 토큰 생성 전부 CSPRNG: agent 토큰 32B(`agentTokens.js:69`), central 토큰 32B(`central/token.js:35`), 수집 토큰 24B
  (`routes/admin/deployLlm.js:101,221,407`), RDP 티켓 24B(`proxy/rdpTicket.js:32`).

**CI / 공급망**
- `ci.yml`: `permissions: contents: read`, `npm ci`, eslint 게이트, `npm audit --audit-level=critical` 차단, pyportal 표준
  라이브러리 전용 검사 (`ci.yml:16-17, 36-39, 70-76, 94-100`).
- Windows Node zip: `set -euo pipefail` + `grep -F "  ${zip}"` + `sha256sum -c` — grep 미스/해시 불일치 모두 비0 종료
  (`release.yml:62-71`). 리눅스 tar.xz: SHASUMS 다운로드 실패 시 명시 중단 + `sha256sum -c`(`build-package.sh:73-76`).
  `curl | bash` 패턴 없음. Dockerfile 없음.
- 롤링 릴리스 직렬화(`concurrency: release-downloads, cancel-in-progress:false`), `prune-assets.mjs` 는 `versions.json`
  에 있는 버전만 유지하고 버전 문자열 없는 자산(versions.json 등)은 항상 보존 — 잘못된 자산 삭제 경로 없음.
- macOS 앱은 macOS 러너에서 ad-hoc 서명 + 기동 검증(`release.yml:137-167`), 배포 서명/공증 없음은 문서화됨.
- `.gitignore` 는 `auth-secret`, `secrets-key`, `secrets-policy.json`, `users.json`, `vcenters.json`, `credentials.json`,
  `initial-admin-password.txt`, `central-agent-*.json`, `backups/` 등 핵심 비밀을 차단. git 트리·히스토리 전수 grep 에서
  개인키(`BEGIN … PRIVATE`)·실제 비밀번호 리터럴 없음(매치는 모두 UI 라벨/정책 상수).
- 백업 라우트 전부 `adminOnly + requireSettingsOwner`, 아카이브 0600, 복원 확장자 화이트리스트 `.json/.env` 유지
  (`routes/admin/backupNetSec.js:32-58`, `backup/service.js:19, 54, 119`).

---

## 우선순위 요약

| # | 심각도 | 항목 | 조치 |
|---|---|---|---|
| F-1 | Medium | `firewall-cmd` 인자 무제한 sudo 규칙 | 래퍼/서브커맨드 화이트리스트 또는 polkit+D-Bus |
| F-2 | Medium | NNP=true 유닛에서 `sudo -n` — 하드닝 해제 유도 | NNP 유지 + 헬퍼/D-Bus 위임, 오류 메시지 인식 |
| F-3 | Low | `.gitignore` 비밀 파일 5종 누락 | 항목 추가 + `server/config/*` 전체 무시 구조 |
| F-4 | Low | 런타임 DB 2개 추적 | `git rm --cached` + `*.db` 무시 |
| F-5 | Low | release 가 `npm install` | `npm ci` |
| F-6 | Low | Actions 태그 고정 | SHA 고정 + Dependabot |
