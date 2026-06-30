@echo off
rem ==========================================================================
rem  VMware Global Monitoring Portal / Collector - Windows environment
rem  start-portal.bat reads this file. Edit the values, then run
rem  install-service.ps1 (admin PowerShell).
rem
rem  IMPORTANT (avoid broken lines / errors):
rem   - Save this file as ANSI (not UTF-8) with Windows CRLF line endings.
rem   - Use ASCII-only values (letters, digits, - _ . :). No Korean in values.
rem ==========================================================================

rem --- HTTP port ---
set PORT=4000

rem --- Config/data dir (kept across upgrades) ---
set CONFIG_DIR=C:\ProgramData\vmware-portal

rem --- Data source: mock | live | auto ---
set DATA_SOURCE=mock

rem --- Node built-in SQLite (iDRAC power history). Keep as-is. ---
set NODE_OPTIONS=--experimental-sqlite

rem ==========================================================================
rem  [Power-collection agent] Set a token to make this server a collector that
rem  the central portal pulls power from. ASCII-only token.
rem ==========================================================================
rem set COLLECTOR_TOKEN=change-me-strong-token
rem set COLLECTOR_DATACENTER=Seoul-DC1

rem [Central-orchestrated scan agent] Pull IP assignments from the central
rem portal by this agent name and scan locally:
rem set AGENT_NAME=Seoul-DC1
rem set CENTRAL_URL=http://central-portal:4000
rem set CENTRAL_TOKEN=change-me-strong-token
rem set AGENT_SCAN_INTERVAL_MS=3600000

rem --- Active Directory (LDAP) login (optional) ---
rem set AD_ENABLED=true
rem set AD_URL=ldaps://dc.corp.local:636
rem set AD_DOMAIN=corp.local
rem set AD_BASE_DN=DC=corp,DC=local
rem set AD_ADMIN_GROUP=VMware-Portal-Admins

rem --- iDRAC/OME poll interval (ms) ---
set IDRAC_POLL_INTERVAL_MS=60000

rem --- Auth (set AUTH_ENABLED=false to disable login) ---
set AUTH_ENABLED=true
rem set AUTH_SECRET=
set DEFAULT_ADMIN_PASSWORD=admin123
