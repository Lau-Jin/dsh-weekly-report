# 把插件里的生成引擎同步到桌面留档副本
#
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\sync-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\sync-desktop.ps1 -Check   # 只比较，不写
#
# 唯一真源：<插件>\service\engine\gen_weekly_text.py
# 镜像位置：D:\Reports\gen_weekly_text.py（旧位置，仅留档/兼容）
#
# 有差异才覆盖，覆盖前把镜像备份为 gen_weekly_text.py.bak-<时间戳>。

param(
    [string]$DesktopDir = "D:\Reports",
    [switch]$Check
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $PluginDir "service\engine\gen_weekly_text.py"
$Target = Join-Path $DesktopDir "gen_weekly_text.py"

Write-Host "source: $Source"
Write-Host "target: $Target"

if (-not (Test-Path $Source)) {
    Write-Host "ERROR: canonical engine not found: $Source" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $DesktopDir)) {
    Write-Host "Skip: desktop folder not found ($DesktopDir). Nothing to mirror." -ForegroundColor Yellow
    exit 0
}

$srcHash = (Get-FileHash $Source -Algorithm SHA256).Hash
if (Test-Path $Target) {
    $dstHash = (Get-FileHash $Target -Algorithm SHA256).Hash
    if ($srcHash -eq $dstHash) {
        Write-Host "Already in sync (sha256 $($srcHash.Substring(0,12))...)" -ForegroundColor Green
        exit 0
    }
    Write-Host "Different - needs sync." -ForegroundColor Yellow
} else {
    Write-Host "Mirror missing - will create." -ForegroundColor Yellow
}

if ($Check) {
    Write-Host "Check mode: nothing written."
    exit 0
}

if (Test-Path $Target) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bak = "$Target.bak-$stamp"
    Copy-Item $Target $bak -Force
    Write-Host "backup: $bak"
}

Copy-Item $Source $Target -Force
$newHash = (Get-FileHash $Target -Algorithm SHA256).Hash
Write-Host "Synced. sha256 $($newHash.Substring(0,12))..." -ForegroundColor Green
Write-Host ""
Write-Host "Note: edits belong in the plugin engine; this mirror is for the old desktop layout only."

