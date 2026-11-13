@echo off
rem ===================================================================
rem  Weekly Report Studio - one-click installer (Windows)
rem  Same job as install.mjs, but runs from Explorer double-click.
rem  Kept ASCII-only on purpose: cmd.exe reads this file in the OEM
rem  codepage, so Chinese text here would turn into gibberish.
rem ===================================================================
setlocal
cd /d "%~dp0"
set RESULT=%TEMP%\weekly-report-install.txt

echo Installing Weekly Report Studio ...
echo.

set "NODE_EXE="
where node >nul 2>nul && set "NODE_EXE=node"
if not defined NODE_EXE (
  if exist "%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" (
    set "NODE_EXE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
  )
)
if not defined NODE_EXE (
  echo [X] Node.js not found.
  echo     Install Node 20+ or run this from the DSH install directory.
  echo.
  pause
  exit /b 1
)

"%NODE_EXE%" install.mjs --open --result-file "%RESULT%"
set CODE=%ERRORLEVEL%

if exist "%RESULT%" type "%RESULT%"
echo.
if %CODE%==0 (
  echo [OK] Installed. The panel should open in your browser.
  timeout /t 4 >nul
) else (
  echo [!] Finished with issues. See the lines above.
  echo     Full log: node install.mjs --verify
  echo.
  pause
)
exit /b %CODE%
