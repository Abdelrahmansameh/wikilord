@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File tools\stop-bot.ps1
echo.
echo Starting the bot LIVE. Dashboard: http://localhost:8787
echo Close this window or press Ctrl+C to stop it.
echo.
node src/bot.js --live
pause
