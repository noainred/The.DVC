# 비밀번호 분실·잠금 복구 (관리자 비밀번호 초기화)

설정/관리 화면 로그인 비밀번호를 잊어 **아무도 들어갈 수 없는 잠금** 상태를 푸는 절차입니다.
두 애플리케이션은 **인증 구조가 다르므로 복구 방법도 다릅니다.**

- **다빈치 모니터링 포탈** (Node/React, `server/`·`web/`) — OTP(TOTP) 기반. → [1장](#1-다빈치-모니터링-포탈-nodereact)
- **서비스 허브 pyportal** (Python, `pyportal/`) — 사용자명+비밀번호. → [2장](#2-서비스-허브-pyportal-python)

> ## 설계 원칙 — 왜 "웹에서 누르면 초기화" 버튼이 없나
>
> 로그인 화면은 **인증 이전 화면**입니다. 거기에 "누르면 관리자 비밀번호를 초기화"하는
> **무인증 버튼/엔드포인트**를 두면, 포탈 주소에 접근 가능한 **누구나** 관리자 계정을
> 초기화할 수 있습니다. 초기화 값을 `/tmp` 같은 곳에 평문으로 쓰면(전역 읽기 가능)
> 그 값을 읽어 **계정을 탈취**할 수 있고, 값을 감추더라도 **관리자 세션을 반복 무효화하는
> 가용성 공격(DoS)** 이 됩니다. "초기화된 비밀번호는 변경해야만 사용"으로도 막지 못합니다 —
> 공격자가 그 변경을 직접 하기 때문입니다.
>
> 그래서 두 포탈 모두 복구는 **서버(호스트)에 접속할 수 있는 운영자**만 콘솔에서 실행합니다.
> **파일시스템 접근 권한 = 인증**이라는, 네트워크 공격자에게는 없고 정당한 운영자에게는 있는
> 신뢰 경계에 복구를 묶은 것입니다. 로그인 화면의 "비밀번호 재설정"/"FORGOT PASSWORD?"
> 버튼은 **이 콘솔 절차를 안내**할 뿐, 웹에서 직접 초기화하지 않습니다.
> (관련 불변조건: `pyportal/CLAUDE.md` "임의 URL 점검은 로그인 필수"·"미인증 응답에 설치 상태
> 미노출", `server/CLAUDE.md` OTP 강제 등록·자격증명 미노출.)

---

## 1. 다빈치 모니터링 포탈 (Node/React)

관리자·운영자 계정은 최종적으로 **OTP 전용**입니다(`server/CLAUDE.md` v2.206). 따라서
"비밀번호를 잊었다"는 상황은 대부분 **OTP 기기 분실**이며, 복구는 **OTP 재등록**입니다.

### 1-1. 상황별 요약

| 상황 | 복구 방법 |
|---|---|
| 다른 관리자가 살아 있음 | 그 관리자가 **사용자 관리 → 비밀번호 재설정**(또는 대상 계정 OTP 비활성화) |
| 최초 설치(아직 OTP 등록한 admin 없음) | 서버의 **초기 비밀번호 파일**로 로그인 → OTP 등록 (아래 1-2) |
| 전 관리자가 OTP 기기를 잃어 아무도 로그인 불가 | 서버 콘솔에서 **`otp-enroll.sh`** 로 재등록 (아래 1-3) |
| 긴급 — OTP 강제를 잠시 풀어야 함 | **`OTP_ROLE_ENFORCE=false`** (아래 1-4) |

### 1-2. 최초 설치 비밀번호

첫 기동 시 `admin` 계정 비밀번호가 **임의 생성**되어 서버의 `CONFIG_DIR`(기본
`/etc/vmware-portal`)에 **`initial-admin-password.txt`**(0600)로 저장됩니다. 로그인 화면에도
파일 경로가 안내됩니다(값은 웹으로 내려받지 않음). 서버에서:

```bash
sudo cat /etc/vmware-portal/initial-admin-password.txt
```

이 비밀번호로 로그인하면 **OTP 등록 화면**으로 이동하고, 등록을 마치면 **비밀번호와 이 파일이
자동 삭제**되어 이후에는 OTP 6자리로만 로그인합니다.

### 1-3. 콘솔 OTP 재등록 — `otp-enroll.sh` (잠금 복구의 핵심)

서버에 접속할 수 있는 운영자가 실행합니다. 계정의 **비밀번호를 몰라도** OTP 시크릿을 직접
발급하므로, 이것이 "전원 잠금"의 실질적 복구 경로입니다. 오프라인 설치본 기준 경로:

```bash
# 계정 목록 확인
sudo /opt/vmware-portal/app/otp-enroll.sh --list

# admin 계정에 OTP 재등록(QR/시크릿 출력 → 인증 앱에 등록)
sudo /opt/vmware-portal/app/otp-enroll.sh admin

# 코드로 등록 확정
sudo /opt/vmware-portal/app/otp-enroll.sh admin --confirm 123456

# 분실한 기존 OTP 비활성화(재등록 전 초기화가 필요할 때)
sudo /opt/vmware-portal/app/otp-enroll.sh admin --disable
```

이 래퍼는 **번들 Node 경로 탐색·`CONFIG_DIR` 결정·서비스 계정으로 강등 실행**을 자동 처리합니다.
**`node` 를 직접 실행하지 마세요** — root 로 돌리면 `users.json` 이 root 소유가 되어 이후
포탈이 사용자 정보를 저장하지 못합니다. git 소스/개발 환경에서는 저장소 루트의 `./otp-enroll.sh`
를 그대로 씁니다.

### 1-4. 긴급 해제 — `OTP_ROLE_ENFORCE=false`

OTP 강제 등록 자체를 **임시로** 끕니다(잠금 복구용). 서비스 환경파일(예:
`/etc/vmware-portal/portal.env`)에 넣고 재시작:

```bash
OTP_ROLE_ENFORCE=false
```

비밀번호를 아는 계정이 다시 비밀번호로 로그인할 수 있게 됩니다. **복구가 끝나면 반드시 다시
제거**하세요 — 켜 둔 채로 두면 고권한 계정의 OTP 전용 정책이 무력화됩니다. 전역 로그인 정책
(설정 › 세션 보안)과 사용자별 재정의는 `server/CLAUDE.md` 참고.

### 1-5. 로그인 화면 안내 버튼

로그인 폼의 **`FORGOT PASSWORD?`** 를 누르면 위 1-1·1-3·1-4 요약이 안내로 표시됩니다
(`web/src/views/loginThemes.jsx` — 웹에서 직접 초기화하지 않음). 최초 설치 상태에서는 별도
팝업으로 초기 비밀번호 파일 경로가 안내됩니다(`web/src/views/Login.jsx`).

---

## 2. 서비스 허브 pyportal (Python)

설정 화면은 **사용자명+비밀번호**로 보호됩니다. 콘솔 복구 도구가 내장되어 있습니다(v2.225).

### 2-1. 최초 설치 비밀번호

첫 기동 시 `admin` 비밀번호가 임의 생성되어 **데이터 폴더**(`HUB_DATA_DIR`, systemd 설치본은
`/etc/dc-service-hub`, 단독 실행은 `pyportal/data`)에 **`initial-settings-password.txt`**(0600)로
저장되고 기동 로그에도 경로가 출력됩니다. 비밀번호를 변경하면 이 파일은 자동 삭제됩니다.

### 2-2. 콘솔 비밀번호 초기화 — `app.py --reset-password`

서버에 접속할 수 있는 운영자가 설치 디렉터리에서 실행합니다.

```bash
# 계정 목록
python3 app.py --list-users

# admin 비밀번호를 새 임의 값으로 초기화(계정이 없으면 admin 으로 생성)
python3 app.py --reset-password admin
```

동작(`hub/auth.py` `recover()`):

- 새 **임의 비밀번호(20자, 헷갈리는 0/O/l/1 제외)** 를 생성해 **한 번만** 출력합니다(다시 표시 안 됨).
- 계정이 **중지 상태면 재활성화**하고, **역할은 승격하지 않습니다**(viewer 는 viewer 로).
- **`tokenVersion` 을 올려 기존 로그인 세션을 전부 무효화**합니다.
- 계정이 **아예 없으면 그 이름의 admin 계정을 새로 생성**합니다(전원 삭제 사고 대비).
- 감사 로그에 `user.password_reset`(actor=console)을 남깁니다(비밀번호 값은 미기록).

**서비스를 켠 채로 실행해도 안전**합니다. `users.json` 은 원자적으로 쓰이고, 실행 중인 서버는
다음 로그인 때 파일을 다시 읽어 **재시작이 필요 없습니다**. 출력된 임시 비밀번호로 로그인한 뒤
**즉시 변경**하세요.

### 2-3. systemd 설치본에서 실행할 때 (계정·데이터 폴더 주의)

systemd 유닛(`pyportal/systemd/dc-service-hub.service`)은 `User=dchub`,
`HUB_DATA_DIR=/etc/dc-service-hub`, `PrivateTmp=true` 로 돕니다. 따라서 복구 명령도 **같은 데이터
폴더**를 가리키고 **같은 서비스 계정**으로 실행해야 `users.json` 소유권이 어긋나지 않습니다:

```bash
sudo -u dchub HUB_DATA_DIR=/etc/dc-service-hub \
  python3 /opt/dc-service-hub/app.py --reset-password admin
```

> `PrivateTmp=true` 때문에 서비스의 `/tmp` 는 호스트 `/tmp` 와 분리됩니다 — 초기화 값을 `/tmp`
> 에 쓰는 방식이 운영자에게 보이지도 않는(그리고 위험한) 이유 중 하나입니다.

### 2-4. 로그인 화면 안내 버튼

설정 로그인 모달의 **"비밀번호를 잊으셨나요? · 비밀번호 재설정"** 을 누르면 위 2-2·2-3 명령이
안내로 펼쳐집니다(`pyportal/static/index.html`·`app.js` — 서버 호출 없이 안내만 표시).

---

## 3. 공통 주의

- 복구 명령의 출력(임시 비밀번호)은 **터미널 스크롤백·세션 로그**에 남을 수 있습니다 — 로그인 후
  즉시 변경하고, 필요하면 스크롤백을 지우세요.
- `initial-*-password.txt`·`users.json`·`portal.env` 는 **자격증명 파일**입니다. 백업·복사 시
  0600 권한과 접근 통제를 유지하세요(백업 아카이브는 설정 소유자 전용).
- 복구 후 **감사 로그**(다빈치: 설정 › 감사, pyportal: `audit.log`)에서 `password_reset`/OTP 변경
  기록을 확인하세요.
