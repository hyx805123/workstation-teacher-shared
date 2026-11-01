@echo off
title Allow LAN access for Teacher Workbench (port 8080)

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo.
  echo   [!] Administrator privileges required.
  echo.
  echo   Close this window, right-click this file and choose
  echo   "Run as administrator".
  echo.
  pause
  exit /b 1
)

echo.
echo   Opening TCP port 8080 ...
echo.

netsh advfirewall firewall delete rule name="Teacher Workbench 8080" >nul 2>&1
netsh advfirewall firewall add rule name="Teacher Workbench 8080" dir=in action=allow protocol=TCP localport=8080 profile=private,domain

echo.
echo   Done. The rule applies to Private and Domain networks only,
echo   so public Wi-Fi stays blocked and student data is not exposed.
echo.
echo   Colleagues open:  http://YOUR-IP:8080/
echo   (Run the check script to see your LAN address.)
echo.
pause
