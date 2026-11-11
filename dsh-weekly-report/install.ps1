# 把周报插件安装到 DSH profile —— 方式 A：本地检出 + Junction（改代码即时生效）
#
# 另一种方式（方式 B）：在 DSH「设置 → 插件 → 添加插件」里填仓库地址，
# 由 pnpm 装进 node_modules。两种方式**数据都在同一个用户目录**（见 paths.cjs），
# 所以随时可以切换，不会出现「两套配置」。
#
# 本脚本只负责方式 A（Junction）；若检测到已用方式 B 安装，会提示如何切换。
#
# 用法（在本仓库的 dsh-weekly-report 目录里执行）：
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\install.ps1 -Status
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\install.ps1 -Uninstall
#   powershell -ExecutionPolicy Bypass -File .\dsh-weekly-report\install.ps1 -Profile web
#
# 做三件事（都先备份、幂等、可重复执行）：
#   1. <profile>\node_modules\dsh-weekly-report  = 指向本插件目录的 Junction
#   2. profile/package.json：dependencies 写 link:<插件目录>，bundles 加 dsh-weekly-report
#   3. profile/cordis.patch.yml：insert weekly-report
# 然后完全退出 DSH 再打开，侧边栏出现「周报」。

param(
    [string]$Profile = "desktop",
    [string]$ProfileRoot = "",
    [switch]$Uninstall,
    [switch]$Status,
    [switch]$Copy,   # 不用 Junction，直接复制一份（插件目录会被移动时用；代价是改代码不即时生效）
    [switch]$NoWatchdog  # 不装「面板服务守护」计划任务（默认装：每 2 分钟探活，挂了自动拉起）
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [Text.Encoding]::UTF8

$PluginDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PluginName = "dsh-weekly-report"
$RepoRoot = Split-Path -Parent $PluginDir

if (-not $ProfileRoot) {
    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
    $ProfileRoot = Join-Path $dshHome "profiles\$Profile"
}

$ProfilePkg = Join-Path $ProfileRoot "package.json"
$ProfilePatch = Join-Path $ProfileRoot "cordis.patch.yml"
$NodeModules = Join-Path $ProfileRoot "node_modules"
$LinkPath = Join-Path $NodeModules $PluginName

function Backup-File($path) {
    if (-not (Test-Path $path)) { return $null }
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $bak = "$path.bak-$stamp"
    Copy-Item $path $bak -Force
    return $bak
}

function Write-Bytes($path, $text) {
    [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

# ---------------------------------------------------------------- 状态
if ($Status) {
    Write-Host "repo root  : $RepoRoot  ($(if (Test-Path (Join-Path $RepoRoot '.git')) { 'git checkout' } else { 'NOT a git checkout' }))"
    Write-Host "plugin dir : $PluginDir"
    Write-Host "profile    : $ProfileRoot"
    Write-Host "link path  : $LinkPath"

    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        Write-Host ("link       : " + $(if ($item.LinkType) { "$($item.LinkType) -> $($item.Target)" } else { 'real directory (copy install)' }))
    } else {
        Write-Host "link       : missing" -ForegroundColor Yellow
    }

    if (Test-Path $ProfilePkg) {
        $pkg = Get-Content $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
        $dep = $pkg.dependencies.$PluginName
        Write-Host ("dependency : " + $(if ($dep) { $dep } else { '(none)' }))
        if ($dep -and -not $dep.StartsWith("link:")) {
            Write-Host "             ^ NOT link: - this is the OLD install mode, run with -Uninstall then re-install" -ForegroundColor Red
        }
        Write-Host ("bundle     : " + ($pkg.dsh.profile.bundles -contains $PluginName))
    } else {
        Write-Host "profile package.json not found" -ForegroundColor Red
    }

    if (Test-Path $ProfilePatch) {
        $txt = Get-Content $ProfilePatch -Raw -Encoding UTF8
        Write-Host ("patch insert: " + $txt.Contains("id: weekly-report"))
    }

    $svc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
           Where-Object { $_.CommandLine -match "weekly-report" }
    Write-Host ("service pid : " + (($svc | ForEach-Object { $_.ProcessId }) -join ", "))
    $wd = Get-ScheduledTask -TaskName "周报面板守护" -ErrorAction SilentlyContinue
    if ($wd) {
        $wi = Get-ScheduledTaskInfo -TaskName "周报面板守护" -ErrorAction SilentlyContinue
        $next = if ($wi -and $wi.NextRunTime) { $wi.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' }
        Write-Host ("watchdog   : installed (" + $wd.State + $(if ($next) { ", next $next" } else { '' }) + ")")
    } else {
        Write-Host "watchdog   : NOT installed (panel service won't restart by itself when DSH is closed)" -ForegroundColor Yellow
    }
    $dataDir = Join-Path $PluginDir "service\data"
    Write-Host ("data dir   : " + $dataDir + "  (exists: " + (Test-Path $dataDir) + ")")
    exit 0
}

# ---------------------------------------------------------------- 卸载
if ($Uninstall) {
    if (Test-Path $LinkPath) {
        $item = Get-Item $LinkPath -Force
        if ($item.LinkType) { cmd /c rmdir "$LinkPath" | Out-Null }
        else { Remove-Item $LinkPath -Recurse -Force }
        Write-Host "removed: $LinkPath" -ForegroundColor Green
    }

    if (Test-Path $ProfilePkg) {
        $bak = Backup-File $ProfilePkg
        $pkg = Get-Content $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
        $pkg.dependencies.PSObject.Properties.Remove($PluginName) | Out-Null
        $pkg.dsh.profile.bundles = @($pkg.dsh.profile.bundles | Where-Object { $_ -ne $PluginName })
        Write-Bytes $ProfilePkg ($pkg | ConvertTo-Json -Depth 12)
        Write-Host "package.json updated (backup: $bak)" -ForegroundColor Green
    }

    if (Test-Path $ProfilePatch) {
        $bak = Backup-File $ProfilePatch
        $txt = Get-Content $ProfilePatch -Raw -Encoding UTF8
        $pattern = "(?ms)^- insert:\r?\n\s+- id: weekly-report\r?\n\s+name: 'dsh-weekly-report'\r?\n(\s+config: \{\}\r?\n)?"
        $new = [regex]::Replace($txt, $pattern, "")
        if ($new -ne $txt) {
            Write-Bytes $ProfilePatch $new
            Write-Host "cordis.patch.yml updated (backup: $bak)" -ForegroundColor Green
        }
    }

    # 守护任务（v0.7.1 起默认安装）
    $wd = Get-ScheduledTask -TaskName "周报面板守护" -ErrorAction SilentlyContinue
    if ($wd) {
        Unregister-ScheduledTask -TaskName "周报面板守护" -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "removed scheduled task: 周报面板守护" -ForegroundColor Green
    }

    Write-Host ""
    Write-Host "Done. Restart DSH (fully quit, then reopen)."
    Write-Host "Plugin data is kept at: $PluginDir\service\data  (delete manually for a clean uninstall)"
    return
}

# ---------------------------------------------------------------- 安装
Write-Host "Installing $PluginName (local checkout + junction) ..." -ForegroundColor Cyan
Write-Host "  repo   : $RepoRoot"
Write-Host "  plugin : $PluginDir"
Write-Host "  profile: $ProfileRoot"

if (-not (Test-Path $ProfileRoot)) {
    Write-Host "ERROR: profile not found: $ProfileRoot" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $PluginDir "package.json"))) {
    Write-Host "ERROR: package.json not found in $PluginDir" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path (Join-Path $RepoRoot ".git"))) {
    Write-Host "WARN: $RepoRoot is not a git checkout (installing from a copied folder still works)" -ForegroundColor Yellow
}

if (-not (Test-Path $NodeModules)) { New-Item -ItemType Directory -Force -Path $NodeModules | Out-Null }

# 0) 旧的地址安装（dependencies 不是 link:）先清掉，避免两套并存
if (Test-Path $ProfilePkg) {
    $pkg0 = Get-Content $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    $dep0 = $pkg0.dependencies.$PluginName
    if ($dep0 -and -not $dep0.StartsWith("link:")) {
        Write-Host "NOTE: currently installed by pnpm ($dep0)." -ForegroundColor Yellow
        Write-Host "      数据中心是同一处（%USERPROFILE%\.dsh\weekly-report），可以直接切到 Junction：" -ForegroundColor Yellow
        Write-Host "      run: install.ps1 -Uninstall   then re-run install.ps1" -ForegroundColor Yellow
        exit 1
    }
}

# 1) Junction（或复制）
if (Test-Path $LinkPath) {
    $item = Get-Item $LinkPath -Force
    if ($item.LinkType) { cmd /c rmdir "$LinkPath" | Out-Null }
    else { Remove-Item $LinkPath -Recurse -Force }
}
if ($Copy) {
    Copy-Item $PluginDir $LinkPath -Recurse -Force
    Write-Host "  copied into node_modules (no junction)"
} else {
    $out = cmd /c mklink /J "$LinkPath" "$PluginDir" 2>&1
    if (-not (Test-Path $LinkPath)) {
        Write-Host "ERROR: junction failed: $out" -ForegroundColor Red
        exit 1
    }
    Write-Host "  junction created -> $PluginDir"
}

# 2) package.json：dependencies + bundles
if (Test-Path $ProfilePkg) {
    $bak = Backup-File $ProfilePkg
    $pkg = Get-Content $ProfilePkg -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $pkg.dependencies) {
        $pkg | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
    }
    $pkg.dependencies | Add-Member -NotePropertyName $PluginName -NotePropertyValue "link:$PluginDir" -Force

    # bundles：先去掉重复（老版本脚本用反向区间插过，会留下重复项），再插到 siyuan-bridge 之后
    $old = @($pkg.dsh.profile.bundles)
    $clean = New-Object System.Collections.Generic.List[string]
    foreach ($b in $old) {
        if ($b -and -not $clean.Contains($b)) { $clean.Add($b) }
    }
    if (-not $clean.Contains($PluginName)) {
        $anchor = $clean.IndexOf("dsh-siyuan-bridge")
        if ($anchor -ge 0) { $clean.Insert($anchor + 1, $PluginName) }
        else { $clean.Add($PluginName) }
    }
    $pkg.dsh.profile.bundles = $clean.ToArray()
    Write-Bytes $ProfilePkg ($pkg | ConvertTo-Json -Depth 12)
    Write-Host "  package.json updated (backup: $bak)"
} else {
    Write-Host "  WARN: $ProfilePkg not found, skipped" -ForegroundColor Yellow
}

# 3) cordis.patch.yml：insert
if (Test-Path $ProfilePatch) {
    $txt = Get-Content $ProfilePatch -Raw -Encoding UTF8
    if ($txt.Contains("id: weekly-report")) {
        Write-Host "  cordis.patch.yml already has the insert"
    } else {
        $bak = Backup-File $ProfilePatch
        $block = "- insert:`r`n    - id: weekly-report`r`n      name: 'dsh-weekly-report'`r`n      config: {}`r`n"
        Write-Bytes $ProfilePatch ($block + $txt)
        Write-Host "  cordis.patch.yml updated (backup: $bak)"
    }
} else {
    Write-Host "  WARN: $ProfilePatch not found, skipped" -ForegroundColor Yellow
}

# 4) 面板服务守护（每 2 分钟探活，挂了自动拉起；-NoWatchdog 可跳过）
if ($NoWatchdog) {
    Write-Host "  watchdog: skipped (-NoWatchdog)"
} else {
    $wdScript = Join-Path $PluginDir "service\ps\watchdog-install.ps1"
    if (Test-Path $wdScript) {
        try {
            $r = & powershell -NoProfile -ExecutionPolicy Bypass -File $wdScript -TaskName "周报面板守护" 2>&1
            Write-Host "  watchdog: installed (every 2 min -> http://127.0.0.1:8798/api/ping)"
        } catch {
            Write-Host "  WARN: watchdog install failed: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    } else {
        Write-Host "  WARN: watchdog-install.ps1 not found, skipped" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Installed (local checkout + junction)." -ForegroundColor Green
Write-Host "Next:"
Write-Host "  1) Fully quit DSH and reopen it"
Write-Host "  2) Sidebar shows a '周报' (calendar) icon"
Write-Host "  3) In the panel: paste your API Key -> save; set folders; generate"
Write-Host ""
Write-Host "Update later:"
Write-Host "  cd `"$RepoRoot`" ; git pull      # then restart DSH (junction needs no reinstall)"
Write-Host ""
Write-Host "Check:   install.ps1 -Status"
Write-Host "Remove:  install.ps1 -Uninstall"




