@echo off
cd /d "%~dp0"
echo Status page for both bots: http://localhost:8790
echo Market analyzer: http://localhost:8791
echo Full bot dashboard, can make changes: http://localhost:8792
echo Money bot dashboard, can make changes: http://localhost:8793
echo From your phone: the https://....ts.net addresses shown by "tailscale serve status".
echo Close this window to stop it.
echo.
node viewer\server.js
pause
