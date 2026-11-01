@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Teacher Workbench - Rollback

set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE goto NONODE

if "%~1"=="" (
  "%NODE_EXE%" "%~dp0rollback.js"
  echo.
  set /p VER=Input version number to rollback, or press Enter to cancel:
  if not "%VER%"=="" "%NODE_EXE%" "%~dp0rollback.js" %VER%
) else (
  "%NODE_EXE%" "%~dp0rollback.js" %1
)
echo.
pause
exit /b 0

:NONODE
echo ============================================================
echo   [FAIL] Node.js not found
echo ============================================================
echo   Install Node.js 18+ from https://nodejs.org , then run again.
echo ============================================================
pause
exit /b 1
