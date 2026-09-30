# Stops only this bot's node process (not other node apps).
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\/]bot\.js' }
if (-not $procs) { Write-Host 'The bot is not running.'; exit 0 }
$procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped bot (pid $($_.ProcessId))." }
