@echo off
chcp 65001 >nul
setlocal
title WXGY Checkin - background service (do not close)
cd /d "%~dp0"

set "NODE_NO_WARNINGS=1"

rem Prefer the bundled portable Node, fall back to system Node.
set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE="
if not defined NODE_EXE (
  for /f "delims=" %%i in ('where node 2^>nul') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE goto nonode

netstat -ano | findstr /C:":8787" | findstr /C:"LISTENING" >nul 2>nul
if not errorlevel 1 goto already

echo Starting WXGY Checkin...
echo.

"%NODE_EXE%" server.js %*
set "CODE=%errorlevel%"

echo.
echo Service stopped (exit code %CODE%). Keep this window open while it runs.
if not "%CODE%"=="0" echo Copy the error above when asking for help.
pause
exit /b %CODE%

:already
echo Service is already running. Opening http://127.0.0.1:8787 ...
if /i not "%~1"=="--no-browser" start "" "http://127.0.0.1:8787"
ping -n 3 127.0.0.1 >nul
exit /b 0

:nonode
echo.
echo [ERROR] Node runtime not found.
echo The portable package should contain runtime\node.exe.
echo If you run from source, install Node.js 18+ first.
echo.
pause
exit /b 1
