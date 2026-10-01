@echo off
cd /d "%~dp0"
echo Market analyzer. Dashboard: http://localhost:8788
echo Close this window to stop it.
echo.
node --disable-warning=ExperimentalWarning src\main.js
pause
