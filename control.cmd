@echo off
chcp 65001 >nul
title 大肥狗AI 控制台
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [x] 没找到 node，请先安装 Node.js 18 以上版本。
  echo.
  pause
  exit /b 1
)

node control.js menu

echo.
echo   已退出控制面板（服务仍在后台运行）。
pause
