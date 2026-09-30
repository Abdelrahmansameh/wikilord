@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-bot.ps1
echo.
echo Starting the bot LIVE (restarts itself if it stops). Dashboard: http://localhost:8787
echo Close this window to stop it, or double-click stop-bot.bat.
echo.
node tools\supervise.cjs --live
pause
