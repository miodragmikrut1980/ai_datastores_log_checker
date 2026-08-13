@echo off
REM Double-click this file in File Explorer to start the companion server.
cd /d "%~dp0"
echo Starting Incident Console companion server...
echo Leave this window open while you use the tool. Close it to stop the server.
echo.
node companion-server.js
pause
