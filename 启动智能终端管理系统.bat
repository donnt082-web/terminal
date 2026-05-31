@echo off
chcp 65001 >nul
title 智能终端管理系统

setlocal enabledelayedexpansion

echo.
echo   ╔════════════════════════════════════════╗
echo   ║     智能终端管理系统 - 启动中...        ║
echo   ╚════════════════════════════════════════╝
echo.

:: ── 切换到项目目录 ──
cd /d "D:\360MoveData\Users\86139\Desktop\terminal-system"

:: ── 启动 WebSocket 服务器（独立窗口） ──
echo   📡 启动 WebSocket 服务器 ...
start "WSServer" /MIN server\node index.js 3000

:: ── 等待服务器就绪 ──
echo   ⏳ 等待服务器就绪 ...
timeout /t 3 /nobreak >nul

:: ── 打开前端页面 ──
echo   🌐 打开管理页面 ...
start "" "frontend\login.html"

echo.
echo   ✅ 启动完成！
echo.
echo   ┌─────────────────────────────────────────┐
echo   │  服务器地址: ws://localhost:3000        │
echo   │  健康检查:   http://localhost:3000      │
echo   │  前端页面:   terminal-system\frontend\  │
echo   └─────────────────────────────────────────┘
echo.
echo   ⚠  关闭此窗口即可停止服务器
echo.
echo   ───────────────────────────────────────────

:: ── 等待用户按键后清理 ──
pause >nul

:: ── 只关闭我们启动的服务器窗口 ──
taskkill /F /FI "WINDOWTITLE eq WSServer" >nul 2>&1

echo   服务器已停止。
timeout /t 2 /nobreak >nul
