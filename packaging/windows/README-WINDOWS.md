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
2. `portal.env.bat` 편집
   - 수집 에이전트로 쓸 경우:
     ```bat
     set COLLECTOR_TOKEN=강력한-공유-토큰
     set COLLECTOR_DATACENTER=Seoul-DC1
     ```
   - `CONFIG_DIR` 는 기본 `C:\ProgramData\vmware-portal` (업그레이드해도 보존)
3. **관리자 권한 PowerShell** 에서:
   ```powershell
   Set-ExecutionPolicy -Scope Process Bypass -Force
   .\install-service.ps1
   ```
   부팅 시 자동 실행되는 백그라운드 서비스(예약 작업)로 등록됩니다.
4. 브라우저에서 `http://localhost:4000` 접속 → 버전 뱃지 33번 클릭 →
   **전력 수집** 메뉴에서 로컬 iDRAC/OME 등록.

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
