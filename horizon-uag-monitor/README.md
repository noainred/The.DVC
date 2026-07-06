# Horizon UAG Monitor (Windows 11 트레이 모니터)

전세계 데이터센터(기본 12개)에 배치된 **VMware Horizon UAG / Virtual App 포탈**의
**443 포트 도달성·TLS 인증서 만료·HTTPS 응답속도**를 주기적으로 점검하고, **자체 SQLite DB**에
시계열로 누적하는 **Windows 11 시스템 트레이 상주 프로그램**입니다.

- **닫기(X)** 를 누르면 종료되지 않고 **시스템 트레이에서 계속 실행**됩니다.
- 트레이 메뉴의 **종료** 를 눌러야만 프로그램이 실제로 끝납니다.
- 트레이 아이콘 색상이 전체 상태(초록=정상 / 노랑=주의 / 빨강=위험)를 실시간 반영합니다.

## 기능
- **443 포트 모니터링**: TCP 연결 지연(도달성) 측정.
- **TLS 인증서 만료 감시**: 남은 일수 표시, 임계(기본 30일) 이하면 '주의'.
- **HTTPS 상태·응답속도**: HTTP 상태코드와 응답시간(ms) 측정, 임계 지연 초과 시 '주의'.
- **웹 포탈 모니터링**: UAG 외에 **별도 웹 포탈**도 대상으로 추가 가능. 대상마다
  **유형(UAG/포탈)·프로토콜(https/http)·포트**를 지정하고, 선택적 **콘텐츠 키워드**로
  포탈 페이지가 실제로 정상 로딩되는지(본문에 키워드 포함) 검증한다.
- **자체 DB(SQLite)**: `%LOCALAPPDATA%\HorizonUagMonitor\monitor.db` 에 이력 저장(WAL, 기본 1년 보존).
- **대상 관리**: 12개 데이터센터 기본 시드 + 추가/수정/삭제, 데이터센터·주기·타임아웃 지정.
- **이력 뷰**: 대상별 1일/7일/30일/90일/365일 응답지연 산점 차트 + 정상률/평균/최대 통계.
- **CSV 내보내기**, **Windows 시작 시 자동 실행**(선택).

## 상태 판정
| 상태 | 조건 |
|---|---|
| 정상(초록) | 443 TCP 연결 + HTTP 2xx/3xx + 인증서 여유 + 응답 지연 정상 |
| 주의(노랑) | 도달하나 HTTP 비정상 / 인증서 임박·만료 / 응답 지연 과다 / TLS 오류 |
| 위험(빨강) | 443 TCP 연결 실패(포트 미도달) |

> UAG는 사설/자체 서명 인증서가 흔하므로 **신뢰 검증 실패로 대상을 '위험' 처리하지 않고**
> 도달성·만료일만 기록합니다(인증서 검증 자체는 별도 확장 여지).

## 빌드 (Windows, .NET 8 SDK 필요)
단일 실행 파일(.exe, 설치형 런타임 불필요, Win11 x64):

```powershell
# 저장소 루트에서
cd horizon-uag-monitor
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o publish
# 산출물: horizon-uag-monitor\publish\HorizonUagMonitor.exe
```
또는 `powershell -ExecutionPolicy Bypass -File build.ps1`.

## 다운로드(빌드 산출물)
GitHub Actions(`horizon-monitor-release.yml`)가 windows-latest에서 빌드해 릴리스에 게시합니다:

- `https://github.com/noainred/The.DVC/releases/download/horizon-monitor/HorizonUagMonitor.exe`

## 최초 사용
1. 실행하면 기본 12개 데이터센터 대상이 **비활성·자리표시자 주소**로 들어 있습니다.
2. **설정(대상 관리)** 에서 각 대상의 **호스트/IP를 실제 UAG 주소로 수정**하고 **활성** 체크.
3. 주기(기본 60초)마다 자동 점검되며, 창을 닫아도 트레이에서 계속 동작합니다.
