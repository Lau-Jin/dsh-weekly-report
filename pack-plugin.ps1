# 打包成「给同事用的离线包」（不需要 GitHub 权限）
#
#   powershell -ExecutionPolicy Bypass -File .\pack-plugin.ps1
#   powershell -ExecutionPolicy Bypass -File .\pack-plugin.ps1 -Out D:\临时
#   powershell -ExecutionPolicy Bypass -File .\pack-plugin.ps1 -NoScreenshots
#
# 产物：<仓库>\dist\dsh-weekly-report-<版本>.zip
# 压缩包里是 dsh-weekly-report\ 一个目录，解压后跑 install.ps1 即可。
#
# 自动排除（绝不打包）：
#   service\data\       配置 / API Key / 历史周报 / 日志（含邮箱授权码）
#   *.log、*.bak-*、__pycache__\、node_modules\、.git\
# 打包完会自动扫一遍，若命中疑似凭据会直接失败。

param(
    [string]$Out = "",
    [switch]$NoScreenshots,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$RepoRoot = $PSScriptRoot
$PluginDir = Join-Path $RepoRoot "dsh-weekly-report"
$PkgPath = Join-Path $PluginDir "package.json"

if (-not (Test-Path $PkgPath)) {
    Write-Host "ERROR: 找不到 $PkgPath（请在仓库根目录运行）" -ForegroundColor Red
    exit 1
}
$version = (Get-Content $PkgPath -Raw -Encoding UTF8 | ConvertFrom-Json).version

if (-not $Out) { $Out = Join-Path $RepoRoot "dist" }
if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Force -Path $Out | Out-Null }

$zip = Join-Path $Out "dsh-weekly-report-$version.zip"
if ((Test-Path $zip) -and -not $Force) { Remove-Item $zip -Force }

$stage = Join-Path $env:TEMP ("wr-pack-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
$stagePlugin = Join-Path $stage "dsh-weekly-report"
New-Item -ItemType Directory -Force $stagePlugin | Out-Null

# ---------------------------------------------------------------- 收集文件
$excludeDirs = @("service\data", "__pycache__", "node_modules", ".git", "tools")
$excludeFilePatterns = @("*.log", "*.bak-*", "*.pyc", "_t*.html", "_shot.html")
if ($NoScreenshots) { $excludeDirs += "docs\screenshots" }

$copied = 0
$skipped = @()
Get-ChildItem $PluginDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($PluginDir.Length + 1)
    $skip = $false
    foreach ($d in $excludeDirs) {
        if ($rel -like "$d\*" -or $rel -eq $d) { $skip = $true }
    }
    foreach ($pat in $excludeFilePatterns) {
        if ($_.Name -like $pat) { $skip = $true }
    }
    if ($skip) { $skipped += $rel; return }

    $target = Join-Path $stagePlugin $rel
    $dir = Split-Path $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    Copy-Item $_.FullName $target -Force
    $copied++
}

# ---------------------------------------------------------------- 安全检查
# 只查「真实凭据字面值」，不查代码里的赋值语句（会有大量误报）
$patterns = @(
    'sk-[A-Za-z0-9]{20,}',                          # API Key 形态
    '"password"\s*:\s*"[^"]{8,}"',                  # config.json 里落地的明文授权码
    '"token_file"\s*:\s*"[^"]+api-key\.txt"',       # 指向 key 文件的配置
    '"[a-zA-Z0-9._%+-]{4,}@(?:163|qq|gmail|outlook)\.com"'   # 明文邮箱
)
$alarm = @()
Get-ChildItem $stagePlugin -Recurse -File | ForEach-Object {
    if ($_.Extension -match '^\.(png|jpg|zip|docx|pdf)$') { return }
    $text = Get-Content $_.FullName -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    if (-not $text) { return }
    foreach ($p in $patterns) {
        if ($text -match $p) {
            $alarm += "$($_.FullName.Substring($stagePlugin.Length + 1))  ← 匹配 $p"
        }
    }
}
if ($alarm -and -not $Force) {
    Write-Host "打包中止：命中疑似凭据（确认无误后加 -Force 强制打包）" -ForegroundColor Red
    $alarm | Select-Object -Unique | ForEach-Object { "  $_" }
    Remove-Item $stage -Recurse -Force
    exit 1
}

# ---------------------------------------------------------------- 压缩
Compress-Archive -Path $stagePlugin -DestinationPath $zip -CompressionLevel Optimal -Force
$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)

Write-Host ""
Write-Host "已生成：$zip" -ForegroundColor Green
Write-Host "版本：$version   大小：$size KB   文件数：$copied"
if ($skipped.Count) {
    Write-Host "已排除（凭据/运行产物）：$($skipped.Count) 个" -ForegroundColor Yellow
    $skipped | Select-Object -First 6 | ForEach-Object { "  - $_" }
    if ($skipped.Count -gt 6) { "  …" }
}
Write-Host ""
Write-Host "压缩包内容："
$marker = 'dsh-weekly-report\'
$rows = @()
Get-ChildItem $stagePlugin -Recurse -File | ForEach-Object {
    $full = $_.FullName
    $i = $full.IndexOf($marker, [StringComparison]::OrdinalIgnoreCase)
    $rel = if ($i -ge 0) { $full.Substring($i + $marker.Length) } else { $full }
    $rows += [pscustomobject]@{ 文件 = $rel; 字节 = $_.Length }
}
$rows | Select-Object -First 40 | Format-Table -AutoSize | Out-String -Width 90 | Write-Host

Remove-Item $stage -Recurse -Force
Write-Host ""
Write-Host "发给同事：解压 → powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\install.ps1 → 重启 DSH"
Write-Host "详细步骤见：dsh-weekly-report\docs\同事安装说明.md"







