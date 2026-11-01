@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Teacher Workbench - Menu

set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"

if not defined NODE_EXE goto NONODE

"%NODE_EXE%" "%~dp0menu.js"
exit /b 0

:NONODE
echo ============================================================
echo   [FAIL] Node.js not found
echo ============================================================
echo   Install Node.js 18+ from https://nodejs.org , then run again.
echo ============================================================
pause
exit /b 1
