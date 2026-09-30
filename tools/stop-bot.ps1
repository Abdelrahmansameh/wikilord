# Stops this bot and its watchdog (not other node apps).
$procs = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]bot\.js' -or $_.CommandLine -match 'tools[\\/]supervise\.cjs' }
if (-not $procs) { Write-Host 'The bot is not running.'; exit 0 }
# watchdog first, so it cannot restart the bot
$procs | Sort-Object { $_.CommandLine -notmatch 'supervise' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; Write-Host "Stopped pid $($_.ProcessId)." }
