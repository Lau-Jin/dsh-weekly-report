# Register the panel watchdog: every 2 minutes ping /api/ping, start the service if down.
param(
    [string]$TaskName = '周报面板守护',
    [int]$Port = 8798,
    [string]$Server = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdog = Join-Path $here 'watchdog.ps1'
if (-not (Test-Path $watchdog)) { throw "找不到 watchdog.ps1：$watchdog" }
if (-not $Server) { $Server = Join-Path (Split-Path -Parent $here) 'server.cjs' }

$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdog`" -Port $Port -Server `"$Server`""

$action = New-ScheduledTaskAction -Execute $ps -Argument $argLine -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) `
    -RepetitionInterval (New-TimeSpan -Minutes 2) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal -Description 'DSH 周报面板服务守护（每 2 分钟探活，挂了自动拉起）' -Force | Out-Null

$i = Get-ScheduledTaskInfo -TaskName $TaskName
@{
    ok     = $true
    next   = if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }
    action = "$ps $argLine"
} | ConvertTo-Json -Compress
