@echo off
net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Administrator privileges are required.
  echo Right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="Shouyinbao-3000" >nul 2>&1
netsh advfirewall firewall add rule name="Shouyinbao-3000" dir=in action=allow protocol=TCP localport=3000 profile=any
if errorlevel 1 (
  echo [FAILED] Could not open TCP port 3000.
) else (
  echo [OK] TCP port 3000 is now open for LAN access.
)
pause
