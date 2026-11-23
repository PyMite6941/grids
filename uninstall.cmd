@echo off
rem Grids uninstall (Windows). Double-click it, or run it from a terminal.
rem Nothing is deleted without asking; every question defaults to "no" unless shown otherwise.
setlocal EnableExtensions
chcp 65001 >nul
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

where node >nul 2>nul
if errorlevel 1 goto nonode

node "%ROOT%\web\setup.mjs" --uninstall --from-script
if errorlevel 1 (
  echo.
  echo Uninstall stopped before it finished; nothing else was changed.
  goto end
)
goto folder

:nonode
echo Node.js was not found, so the guided uninstall can't run. Do these by hand:
echo   1. Claude Code:  claude mcp remove --scope user grids
echo   2. Other MCP clients: delete their "grids" entry.
echo   3. Delete your key file if you want: "%ROOT%\.env" or "%USERPROFILE%\.grids\.env"
echo      (and .grids-usage.json beside it), then the folder "%USERPROFILE%\.grids".
echo   Your workbooks are not touched.

:folder
echo.
set "DIRTY="
where git >nul 2>nul
if not errorlevel 1 (
  for /f "delims=" %%i in ('git -C "%ROOT%" status --porcelain 2^>nul') do set "DIRTY=1"
)
if defined DIRTY echo Warning: this folder has changes that are not committed to git; deleting it loses them.
set "ANS="
set /p "ANS=Delete the Grids folder itself (%ROOT%)? (y/n) [n] "
if /i not "%ANS%"=="y" if /i not "%ANS%"=="yes" (
  echo Kept the folder.
  goto end
)
echo Deleting %ROOT% ...
cd /d "%TEMP%"
rem The batch file lives in the folder being deleted: leave batch context first, then delete
(goto) 2>nul & rmdir /s /q "%ROOT%" & (if exist "%ROOT%" (echo Could not delete everything; close any app using it and delete the folder by hand.) else (echo Grids is uninstalled.)) & pause & exit /b 0

:end
echo.
pause
