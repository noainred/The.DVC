# 분산 수집 아키텍처 (대규모: 서버 1,000대+ / 데이터센터 13개)

서버가 많고 데이터센터가 분산되어 있어, 각 DC에 **수집 에이전트**를 두고 로컬에서
전력(iDRAC/OME)을 수집한 뒤, **중앙 포탈**이 이를 당겨와 병합합니다.

```
 [DC1] 수집 에이전트 ── iDRAC/OME 로컬 수집 ─┐
 [DC2] 수집 에이전트 ── iDRAC/OME 로컬 수집 ─┤   /api/collector/export (토큰)
  ...                                        ├─────────────► [중앙 포탈] 병합 → 대시보드
 [DC13] 수집 에이전트 ── iDRAC/OME 로컬 수집 ─┘
```

- 포탈과 수집기는 **같은 프로그램**입니다. `COLLECTOR_TOKEN` 을 설정하면 그 인스턴스가
  수집 에이전트가 되어 `GET /api/collector/export` 를 토큰으로 노출합니다.
- 중앙 포탈은 **수집 서버** 메뉴(관리자)에 에이전트를 등록하고, 주기적으로(기본 60초)
  당겨와 호스트 전력에 병합합니다. 호스트 클릭 시 어느 DC에서 수집됐는지도 표시됩니다.
- 수집 에이전트는 로컬에서만 수집하며, 받은 원격 데이터를 재노출하지 않습니다(루프 없음).

## 1) 각 DC에 수집 에이전트 설치

### Rocky Linux 9
기존 오프라인 설치 패키지를 그대로 설치한 뒤 `portal.env` 에 추가:
```bash
COLLECTOR_TOKEN=강력한-공유-토큰
COLLECTOR_DATACENTER=Seoul-DC1
```
```bash
sudo systemctl restart vmware-portal
```

### Windows Server / Windows 10+
`vmware-portal-win-<버전>-x64.zip` 압축 해제 후 `portal.env.bat` 편집:
```bat
set COLLECTOR_TOKEN=강력한-공유-토큰
set COLLECTOR_DATACENTER=Seoul-DC1
```
관리자 PowerShell:
```powershell
.\install-service.ps1
```
자세한 내용: `packaging/windows/README-WINDOWS.md`

각 에이전트 접속(버전 뱃지 33회 클릭) → **전력 수집** 메뉴에서 로컬 iDRAC 또는 OME 등록.
(OME 하나만 등록하면 그 DC의 전체 서버를 자동 발견합니다.)

## 2) 중앙 포탈에 수집 서버 등록

중앙 포탈 → **수집 서버** 메뉴 → `+ 수집 서버 추가`:
- URL: `http://<에이전트 IP>:4000`
- 토큰: 에이전트의 `COLLECTOR_TOKEN`
- 데이터센터: 표시용 이름

“연결 테스트” 로 확인 후 저장하면 곧바로 당겨오기 시작합니다. 등록된 모든 에이전트의
호스트 전력이 개요/요약/랭킹과 호스트 상세 팝업에 병합되어 표시됩니다.

## 보안 / 네트워크
- 에이전트의 export 는 `COLLECTOR_TOKEN` 으로만 열립니다(미설정 시 404로 비활성).
- 중앙 포탈 → 에이전트로의 인바운드 TCP(기본 4000) 허용 필요.
- 토큰/자격증명은 각 서버의 `$CONFIG_DIR`(리눅스 `/etc/vmware-portal`, 윈도우
  `C:\ProgramData\vmware-portal`)에 0600 으로만 저장되며 업그레이드해도 보존됩니다.

## Windows 패키지 빌드 (인터넷 되는 빌드 PC에서 1회)
```bash
# 1) Node Windows 런타임 zip 준비
#    https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip
# 2) 의존성 설치(최초 1회) 후 빌드
npm run install:all
packaging/windows/build-collector-win.sh --node-zip /path/node-v22.20.0-win-x64.zip
# 결과: dist-offline/vmware-portal-win-<버전>-x64.zip
```
