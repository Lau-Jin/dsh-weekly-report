# Query two scheduled tasks (weekly report + panel watchdog) in one call, print JSON.
param(
    [string]$ScheduleTask = '周报自动生成',
    [string]$WatchdogTask = '周报面板守护'
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Get-TaskInfo([string]$Name) {
    $t = Get-ScheduledTask -TaskName $Name
    if (-not $t) { return @{ installed = $false } }
    $i = Get-ScheduledTaskInfo -TaskName $Name
    $a = $t.Actions[0]
    $next = ''
    if ($i.NextRunTime) { $next = $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') }
    return @{
        installed  = $true
        state      = [string]$t.State
        target     = ((([string]$a.Execute) + ' ' + ([string]$a.Arguments)).Trim())
        next       = $next
        lastResult = $i.LastTaskResult
    }
}

@{
    schedule = (Get-TaskInfo $ScheduleTask)
    watchdog = (Get-TaskInfo $WatchdogTask)
} | ConvertTo-Json -Compress -Depth 4
