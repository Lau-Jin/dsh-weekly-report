@echo off
rem 启动周报面板服务（无窗口）。已在跑则直接退出。
setlocal
set "HERE=%~dp0"
set "NODE=D:\DEEPSEEK\resources\runtime\primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE%" set "NODE=node"

powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8798/api/state' -TimeoutSec 2 -UseBasicParsing; if ($r.StatusCode -eq 200) { exit 0 } } catch {}; exit 1" >nul 2>&1
if %ERRORLEVEL% EQU 0 (
  echo Weekly panel service is already running: http://127.0.0.1:8798/
  exit /b 0
)

start "" /b "%NODE%" "%HERE%service\server.cjs"
timeout /t 3 >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8798/api/state' -TimeoutSec 4 -UseBasicParsing; Write-Host ('OK ' + $r.StatusCode + '  http://127.0.0.1:8798/') } catch { Write-Host 'FAILED - see service\panel.log' }"
endlocal
