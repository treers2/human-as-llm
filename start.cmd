@echo off
chcp 65001 >nul
title 大肥狗AI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没找到 node，请先安装 Node.js 18 以上版本。
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动 大肥狗AI...
echo.
node server.js

echo.
echo   服务已退出。
pause
