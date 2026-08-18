@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js。
  echo 请先到 https://nodejs.org 下载安装 LTS 版本，然后重新运行本脚本。
  pause
  exit /b 1
)

echo 正在启动收银宝服务端（端口 3000）...
start "收银宝服务端" cmd /k "chcp 65001 >nul && node server.js"
timeout /t 2 /nobreak >nul
start "" http://127.0.0.1:3000

echo.
echo 服务已启动。
echo 手机/其他电脑请打开「收银宝服务端」窗口，访问里面打印的"局域网访问"地址。
echo 关闭服务：直接关掉「收银宝服务端」窗口即可。
pause
