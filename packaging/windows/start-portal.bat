@echo off
rem Launch the portal/collector using the bundled Node runtime.
rem Loads env from portal.env.bat in the same folder.
setlocal enableextensions
set "HERE=%~dp0"
if exist "%HERE%portal.env.bat" call "%HERE%portal.env.bat"

if not defined CONFIG_DIR set "CONFIG_DIR=C:\ProgramData\vmware-portal"
if not exist "%CONFIG_DIR%" mkdir "%CONFIG_DIR%"
if not defined NODE_OPTIONS set "NODE_OPTIONS=--experimental-sqlite"

"%HERE%runtime\node\node.exe" "%HERE%app\server\src\index.js"
