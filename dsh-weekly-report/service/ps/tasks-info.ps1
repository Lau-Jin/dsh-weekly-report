# Query the weekly report scheduled task and print JSON.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less .ps1 as ANSI, and
# non-ASCII comments can swallow a line ending and corrupt the next line.
param(
    [string]$ScheduleTask = '周报自动生成'
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# Since v0.8.0 the task runs `wscript.exe //nologo <vbs>` (hidden start), so the real
# python command line lives in the generated VBS. Read it back from the "COMMAND:"
# comment line so the panel can tell whether the task points at this plugin.
function Get-LauncherCommand([string]$Arguments) {
    $m = [regex]::Match($Arguments, '"([^"]+\.vbs)"', 'IgnoreCase')
    if (-not $m.Success) { return '' }
    $vbs = $m.Groups[1].Value
    if (-not (Test-Path $vbs)) { return '' }
    $line = Select-String -Path $vbs -Pattern "^'\s*COMMAND:\s*(.+)$" -Encoding Default | Select-Object -First 1
    if ($line) { return $line.Matches[0].Groups[1].Value.Trim() }
    return ''
}

function Get-TaskInfo([string]$Name) {
    $t = Get-ScheduledTask -TaskName $Name
    if (-not $t) { return @{ installed = $false } }
    $i = Get-ScheduledTaskInfo -TaskName $Name
    $a = $t.Actions[0]
    $next = ''
    if ($i.NextRunTime) { $next = $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') }
    $target = ((([string]$a.Execute) + ' ' + ([string]$a.Arguments)).Trim())
    return @{
        installed  = $true
        state      = [string]$t.State
        target     = $target
        command    = (Get-LauncherCommand ([string]$a.Arguments))
        next       = $next
        lastResult = $i.LastTaskResult
    }
}

@{
    schedule = (Get-TaskInfo $ScheduleTask)
} | ConvertTo-Json -Compress -Depth 4
