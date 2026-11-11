# 发布：把本机改动推送到仓库（仓库是唯一主数据源）
#
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Message "修了 xxx"
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Bump minor
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Bump none
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -NoPush
#   powershell -ExecutionPolicy Bypass -File .\publish.ps1 -Status
#
# 做四件事：
#   1. 列改动，并对疑似凭据/运行时文件告警
#   2. bump 插件版本号（dsh-weekly-report\package.json）
#   3. git add -A && commit
#   4. git push origin main

param(
    [string]$Message = "",
    [ValidateSet("patch", "minor", "major", "none")][string]$Bump = "patch",
    [switch]$NoBump,
    [switch]$NoPush,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$RepoRoot = $PSScriptRoot
$RootPkg = Join-Path $RepoRoot "package.json"          # 仓库入口包（插件页填地址安装用）
$PluginPkg = Join-Path $RepoRoot "dsh-weekly-report\package.json"

function Read-Json($path) { return Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json }
function Write-Json($path, $obj) {
    [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 12) + "`n", (New-Object System.Text.UTF8Encoding($false)))
}
function Next-Version([string]$ver, [string]$kind) {
    $p = $ver.Split("."); $major = [int]$p[0]; $minor = [int]$p[1]; $patch = [int]$p[2]
    switch ($kind) {
        "major" { $major++; $minor = 0; $patch = 0 }
        "minor" { $minor++; $patch = 0 }
        default { $patch++ }
    }
    return "$major.$minor.$patch"
}

if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
    Write-Host "ERROR: run this from the repo root." -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $PluginPkg)) {
    Write-Host "ERROR: $PluginPkg not found." -ForegroundColor Red
    exit 1
}

$changed = git -C $RepoRoot status --porcelain
if (-not $changed) {
    Write-Host "Nothing to commit (working tree clean)." -ForegroundColor Green
    exit 0
}

Write-Host "Changed files:" -ForegroundColor Cyan
$changed | ForEach-Object { "  $_" }

$bad = $changed | Where-Object { $_ -match "service/data|\.log$|\.bak-|api-key\.txt|weekly_config\.json" }
if ($bad) {
    Write-Host ""
    Write-Host "WARNING: likely credentials/runtime files - check before publishing:" -ForegroundColor Red
    $bad | ForEach-Object { "  $_" }
}

if ($Status) { exit 0 }

$pluginVersion = (Read-Json $PluginPkg).version
if (-not $NoBump -and $Bump -ne "none") {
    $next = Next-Version $pluginVersion $Bump
    $pp = Read-Json $PluginPkg; $pp.version = $next; Write-Json $PluginPkg $pp
    # 仓库入口包也要同步版本（插件页按版本判断有没有新版）
    if (Test-Path $RootPkg) {
        $rp = Read-Json $RootPkg; $rp.version = $next; Write-Json $RootPkg $rp
        Write-Host ""
        Write-Host "Version: $pluginVersion -> $next (plugin + repo entry package)" -ForegroundColor Yellow
    } else {
        Write-Host ""
        Write-Host "Version: $pluginVersion -> $next" -ForegroundColor Yellow
    }
} else {
    Write-Host ""
    Write-Host "Version unchanged: $pluginVersion" -ForegroundColor Yellow
}

if (-not $Message) { $Message = "更新周报插件 $((Read-Json $PluginPkg).version)" }

git -C $RepoRoot add -A
git -C $RepoRoot -c core.quotepath=false commit -q -m $Message
if ($LASTEXITCODE -ne 0) { Write-Host "Commit failed." -ForegroundColor Red; exit 1 }
Write-Host "Committed: $Message" -ForegroundColor Green

if ($NoPush) { Write-Host "Skip push (-NoPush)."; exit 0 }

git -C $RepoRoot push origin main
if ($LASTEXITCODE -ne 0) { Write-Host "Push failed." -ForegroundColor Red; exit 1 }

Write-Host ""
Write-Host "Pushed to origin/main:" -ForegroundColor Green
git -C $RepoRoot -c core.quotepath=false log --oneline -1
Write-Host ""
Write-Host "Other machines (junction install): cd to their checkout and 'git pull', then restart DSH. No reinstall needed."


