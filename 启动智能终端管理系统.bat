@echo off
title Smart Helmet Terminal
setlocal enabledelayedexpansion

echo.
echo   ====================================
echo      Smart Helmet Terminal - Starting
echo   ====================================
echo.

cd /d "%~dp0"

:: -- find node (PATH first, else E:\node.exe) --
set "NODE=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "E:\node.exe" (
    set "NODE=E:\node.exe"
  ) else (
    echo   [ERROR] node not found. Install Node.js or check E:\node.exe
    echo.
    pause
    exit /b 1
  )
)
echo   Using Node: !NODE!
echo.

:: -- start main server (WS + TCP + API + web, port 3000) --
echo   Starting main server (port 3000) ...
start "WSServer" /d "%~dp0server" cmd /k !NODE! index.js 3000

:: -- start db viewer (port 8090) --
echo   Starting DB viewer (port 8090) ...
start "DBViewer" /d "%~dp0server" cmd /k !NODE! db_viewer.js

:: -- wait for servers --
echo   Waiting for servers ...
timeout /t 3 /nobreak >nul

:: -- open web page (http, NOT file://) --
echo   Opening web page ...
start "" "http://localhost:3000/login.html"

echo.
echo   ====================================
echo      Started
echo   ====================================
echo.
echo   Web    : http://localhost:3000/login.html
echo   DB     : http://localhost:8090
echo   Login  : admin / 123456789
echo.
echo   Each service has its own window. Close it to stop that service.
echo   If a service window shows a red error, send it to me.
echo.
echo   Press any key to close THIS window (services keep running) ...
pause >nul
