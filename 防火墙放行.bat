@echo off
chcp 65001 >nul
net session >nul 2>&1
if errorlevel 1 (
  echo [提示] 需要管理员权限。
  echo 请右键本文件，选择「以管理员身份运行」。
  pause
  exit /b 1
)

netsh advfirewall firewall delete rule name="收银宝(3000)" >nul 2>&1
netsh advfirewall firewall add rule name="收银宝(3000)" dir=in action=allow protocol=TCP localport=3000
if errorlevel 1 (
  echo [失败] 放行失败，请检查后重试。
) else (
  echo [完成] 已放行 TCP 3000 端口，手机/其他电脑现在可以访问了。
)
pause
