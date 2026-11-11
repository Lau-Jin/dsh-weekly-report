# 周报面板服务守护：探 /api/ping，不通就把服务拉起来（无窗口）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File watchdog.ps1 -Port 8798 -Server "D:\...\service\server.cjs"
#
# 由面板「系统定时任务 → 面板服务守护」注册的计划任务每 2 分钟调一次。
# 服务在 → 直接退出（不写日志、不占资源）；服务不在 → 拉起 node，再验一次，写一行日志。

param(
    [int]$Port = 8798,
    [string]$Server = ''
)

$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $env:USERPROFILE '.dsh\weekly-report'
$logDir = Join-Path $dataDir 'logs'
$logFile = Join-Path $logDir 'watchdog.log'

function Write-Log([string]$Message) {
    try {
        if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
        $line = '[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $Message
        Add-Content -Path $logFile -Value $line -Encoding UTF8
    } catch { /* 日志写不进去也不影响拉起 */ }
}

function Test-Panel {
    try {
        $r = Invoke-WebRequest -Uri ("http://127.0.0.1:$Port/api/ping") -TimeoutSec 2 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

# 2 次探测（给忙碌中的服务留点余地），都失败才认为真的不在
if (Test-Panel) { exit 0 }
Start-Sleep -Milliseconds 500
if (Test-Panel) { exit 0 }

# 找 node：环境变量 > DSH 自带运行时 > PATH
$node = $env:WEEKLY_PANEL_NODE
if (-not $node -or -not (Test-Path $node)) {
    $candidates = @()
    if ($env:USERPROFILE) {
        $candidates += (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
    }
    $candidates += 'D:\DEEPSEEK\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
    $node = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $node) { $node = 'node' }

if (-not $Server) { $Server = Join-Path (Split-Path -Parent $here) 'server.cjs' }
if (-not (Test-Path $Server)) {
    Write-Log "拉起失败：找不到 $Server"
    exit 1
}

# 非默认端口时，把端口通过环境变量传给孩子进程（server.cjs 读 WEEKLY_PANEL_PORT）
$prevPort = $env:WEEKLY_PANEL_PORT
$env:WEEKLY_PANEL_PORT = "$Port"
try {
    Start-Process -FilePath $node -ArgumentList ('"' + $Server + '"') -WindowStyle Hidden
} catch {
    Write-Log ("拉起失败：" + $_.Exception.Message)
    exit 1
} finally {
    $env:WEEKLY_PANEL_PORT = $prevPort
}

# 等它起来再说成功
for ($i = 0; $i -lt 10; $i++) {
    Start-Sleep -Milliseconds 700
    if (Test-Panel) {
        Write-Log "服务不在，已拉起：$node $Server（端口 $Port）"
        exit 0
    }
}

Write-Log "拉起后仍无响应：$node $Server（看 panel.log）"
exit 1
