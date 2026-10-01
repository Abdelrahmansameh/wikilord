@echo off
cd /d "%~dp0"
echo Read-only status page for both bots: http://localhost:8790
echo From your phone: the https://....ts.net address shown by "tailscale serve status".
echo Close this window to stop it.
echo.
node viewer\server.js
pause
