# Delete the weekly report task.
param([string]$TaskName = '周报自动生成')

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$t = Get-ScheduledTask -TaskName $TaskName
if (-not $t) { '{"ok":false,"reason":"not installed"}'; exit 0 }
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
'{"ok":true}'
