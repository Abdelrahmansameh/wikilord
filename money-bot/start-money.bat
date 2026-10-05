@echo off
cd /d "%~dp0"
echo Money bot. Dashboard: http://localhost:8789
echo Live actions require dryRun:false in config.json as well as this launcher.
echo Close this window to stop it.
echo.
node --disable-warning=ExperimentalWarning src\main.js --live
pause
