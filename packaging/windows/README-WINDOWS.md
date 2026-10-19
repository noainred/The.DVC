# Windows 수집 에이전트 / 포탈 설치 (오프라인)

포탈과 데이터센터 수집기는 **같은 프로그램**입니다. `COLLECTOR_TOKEN` 을 설정하면
그 서버가 **수집 에이전트**가 되어 로컬 iDRAC/OME 전력을 수집하고, 중앙 포탈이 당겨갑니다.

## 구성물
| 항목 | 설명 |
|------|------|
| `runtime\node\node.exe` | 번들된 Node.js Windows 런타임 |
| `app\` | 서버(코드+의존성) + 웹 대시보드(web\dist) |
| `portal.env.bat` | 환경설정 (포트/CONFIG_DIR/수집 토큰 등) |
| `start-portal.bat` | 수동 실행 |
| `install-service.ps1` | 부팅 시 자동 실행(예약 작업) 등록 |
| `uninstall-service.ps1` | 등록 해제 |

## 설치 절차
1. zip 압축 해제 (예: `C:\vmware-portal\`)
   - **경로에 공백을 넣지 마세요**(예: `C:\Program Files\…` 는 피합니다). 예약 작업은 `cmd.exe /c "<경로>\start-portal.bat"` 으로
     이 파일을 실행하는데, 공백이 든 경로에서 cmd 의 따옴표 처리가 맞게 동작하는지는 Windows 실기로 확인하지 못했습니다.
     공백 없는 짧은 경로(`C:\vmware-portal`)를 쓰고 아래 1-1 로 권한을 좁히는 것을 기준으로 안내합니다.
1-1. **설치 폴더와 설정 폴더의 권한을 좁힙니다**(v2.744 — 다음 단계로 토큰을 적기 전에, 서비스를 등록하기 전에)
   - 왜: 예약 작업이 이 폴더의 `start-portal.bat`·`portal.env.bat`·`runtime\node\node.exe` 를 **SYSTEM 권한**으로 실행합니다.
     `C:\` 바로 아래에 새로 만든 폴더는 보통 C:\ 의 권한을 물려받아 **일반 사용자도 파일을 만들거나 바꿀 수 있습니다** —
     그러면 그 사용자가 `portal.env.bat` 에 줄을 넣어 다음 부팅에 SYSTEM 으로 실행시킬 수 있고, 이 파일에 저장되는
     `CENTRAL_TOKEN`·`COLLECTOR_TOKEN` 도 읽힙니다. 설정 폴더(`C:\ProgramData\vmware-portal`)에도 계정·비밀이 저장됩니다.
   - **관리자 권한 PowerShell 또는 명령 프롬프트**에서(따옴표를 그대로 두세요 — PowerShell 이 괄호를 식으로 읽지 않게):
     ```bat
     icacls C:\vmware-portal /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
     icacls C:\vmware-portal\* /reset /T /C
     mkdir C:\ProgramData\vmware-portal
     icacls C:\ProgramData\vmware-portal /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F"
     icacls C:\ProgramData\vmware-portal\* /reset /T /C
     ```
     · `/inheritance:r` 는 물려받은 권한(일반 사용자 쓰기 포함)을 지우고, 남는 권한은 SYSTEM(`S-1-5-18`)과
       Administrators(`S-1-5-32-544`)의 전체 권한뿐입니다. 이름 대신 SID 를 쓰는 것은 Windows 언어에 따라 계정 이름이 달라서입니다.
     · 두 번째 줄(`/reset /T`)은 폴더 안 파일들이 위 권한을 그대로 물려받게 맞춥니다(압축을 풀 때 생긴 개별 권한 정리).
     · 일반 사용자(Users)에게는 읽기 권한도 주지 않습니다 — `portal.env.bat` 에 토큰이 들어갑니다. 수동 실행(`start-portal.bat`)은
       관리자 권한 창에서 하세요. 설정 폴더가 이미 있으면 `mkdir` 줄의 '이미 있음' 오류는 무시해도 됩니다.
   - **확인 명령** — 아래 두 줄의 출력에 SYSTEM·Administrators 두 줄만 있어야 합니다(`Users`·`Authenticated Users`·`Everyone`·
     `CREATOR OWNER` 줄이 보이면 위 명령을 다시 실행하세요. 표시 이름은 Windows 언어에 따라 다를 수 있습니다):
     ```bat
     icacls C:\vmware-portal
     icacls C:\ProgramData\vmware-portal
     ```
   - ⚠ 정직 기록: 이 안내는 Windows 의 일반적인 기본 권한(클라이언트 Windows 는 C:\ 아래 새 폴더에 Authenticated Users 수정 권한,
     Windows Server 는 Users 파일 추가 권한이 물려 내려온다)을 근거로 했고, **이 환경에는 Windows 가 없어 실기로 확인하지 못했습니다.**
     `install-service.ps1` 은 권한을 바꾸지 않습니다(이 릴리스는 안내만 — 실기 확인 전에 스크립트가 기존 폴더 권한을 바꾸지 않게).
     위 확인 명령의 출력으로 현장에서 확인하세요.
2. `portal.env.bat` 편집
   - 수집 에이전트로 쓸 경우:
     ```bat
     set COLLECTOR_TOKEN=강력한-공유-토큰
     set COLLECTOR_DATACENTER=Seoul-DC1
     ```
   - `CONFIG_DIR` 는 기본 `C:\ProgramData\vmware-portal` (업그레이드해도 보존)
   - 포탈 화면(설정의 Edge 노드 포탈 설치·대량 배포 화면에 있는 중앙 토큰)에서 저장·생성한 `CENTRAL_TOKEN` 은 **이 `portal.env.bat`** 에 `set "CENTRAL_TOKEN=..."` 줄로
     기록됩니다(`start-portal.bat` 이 이 파일 경로를 포탈에 넘깁니다 — v2.743). 새 zip 으로 패키지 폴더를 바꿀 때는 이 파일을 보존하세요.
     예전 버전이 `C:\ProgramData\vmware-portal\portal.env.bat` 에 쓴 값은 시작 스크립트가 읽지 않습니다 — 필요하면 그 줄을 이 파일로 옮기세요.
     Windows 에서는 토큰에 `& | < > ^ % ! "` 와 공백을 쓸 수 없습니다(이 파일을 cmd 가 실행합니다).
3. **관리자 권한 PowerShell** 에서:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install-service.ps1
   ```
   부팅 시 자동 실행되는 백그라운드 서비스(예약 작업)로 등록됩니다.
4. 브라우저에서 `http://localhost:4000` 접속 → 관리자 로그인 후 상단 설정 →
   **전력 수집** 메뉴에서 로컬 iDRAC/OME 등록.
   - **최초 관리자 비밀번호**: 고정 기본값이 없습니다(v2.591 — 예전 `admin123` 은 폐지). 최초 기동 때 임의 비밀번호가
     만들어져 `C:\ProgramData\vmware-portal\initial-admin-password.txt` 에 저장됩니다(관리자 권한으로 열기).
     계정은 `admin` 이고, 로그인 직후 OTP 등록을 요구합니다. 무인 배포로 고정하려면 `portal.env.bat` 에서
     `set DEFAULT_ADMIN_PASSWORD=<강력한값>` 의 `rem` 을 지우세요.
   - ⚠ 예전 패키지로 설치해 `admin123` 을 그대로 쓰고 있다면 **즉시 바꾸세요** — 인바운드 4000 을 여는 수집기라
     먼저 로그인한 사람이 OTP 를 등록해 계정을 가져갈 수 있습니다.

## 수동 실행 / 점검
```bat
start-portal.bat
```

## 중앙 포탈에 등록
중앙 포탈의 **수집 서버** 메뉴에서 이 에이전트를 등록합니다:
- URL: `http://<이 서버 IP>:4000`
- 토큰: 위 `COLLECTOR_TOKEN` 과 동일

## 참고
- Node 내장 SQLite 사용을 위해 `NODE_OPTIONS=--experimental-sqlite` 가 기본 설정되어 있습니다.
- 방화벽에서 인바운드 TCP 4000(중앙 포탈→에이전트 당김) 허용이 필요합니다.
- NSSM 등 별도 서비스 래퍼 없이 Windows 예약 작업(SYSTEM, 부팅 시작, 실패 시 재시작)으로 동작합니다.
