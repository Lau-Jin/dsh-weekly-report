# Query the scheduled task and print JSON for the panel service.
param([string]$TaskName = '周报自动生成')

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$t = Get-ScheduledTask -TaskName $TaskName
if (-not $t) { '{"installed":false}'; exit 0 }
$i = Get-ScheduledTaskInfo -TaskName $TaskName
$a = $t.Actions[0]
$next = ''
if ($i.NextRunTime) { $next = $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') }

@{
    installed  = $true
    state      = [string]$t.State
    execute    = [string]$a.Execute
    arguments  = [string]$a.Arguments
    next       = $next
    lastResult = $i.LastTaskResult
} | ConvertTo-Json -Compress
