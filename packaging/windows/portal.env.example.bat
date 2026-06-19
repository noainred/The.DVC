@echo off
rem ===========================================================================
rem  VMware Global Monitoring Portal / Collector - Windows 환경설정
rem  start-portal.bat 가 이 파일을 불러옵니다. 값 수정 후 서비스를 재시작하세요.
rem ===========================================================================

rem --- 포트 ---
set PORT=4000

rem --- 사용자 설정 저장 위치(앱 폴더 밖 권장: 업그레이드해도 보존) ---
set CONFIG_DIR=C:\ProgramData\vmware-portal

rem --- 데이터 소스: mock | live | auto ---
set DATA_SOURCE=mock

rem --- Node 내장 SQLite (iDRAC 전력 이력) 활성화. 그대로 두세요. ---
set NODE_OPTIONS=--experimental-sqlite

rem ===========================================================================
rem  [수집 에이전트로 쓸 때] 아래 두 값을 채우면 이 서버가 수집 에이전트가 됩니다.
rem  COLLECTOR_TOKEN: 중앙 포탈에서 이 에이전트를 당겨올 때 사용할 공유 토큰
rem  COLLECTOR_DATACENTER: 이 에이전트가 있는 데이터센터 이름
rem ===========================================================================
rem set COLLECTOR_TOKEN=change-me-strong-token
rem set COLLECTOR_DATACENTER=Seoul-DC1

rem --- iDRAC/OME 전력 수집 주기(ms) ---
set IDRAC_POLL_INTERVAL_MS=60000

rem --- 인증 (수집 전용 서버는 AUTH_ENABLED=true 유지 권장) ---
set AUTH_ENABLED=true
rem set AUTH_SECRET=
set DEFAULT_ADMIN_PASSWORD=admin123
