@echo off
rem Media Downloader - update to the latest version from GitHub. Double-click this file.
rem (Normally the extension updates itself: popup > "Update now". This is the manual way.)
chcp 65001 >nul
setlocal
set "ZIP=%TEMP%\mediadownloader-update.zip"
set "TMPD=%TEMP%\mediadownloader-update"
echo.
echo === Updating Media Downloader ===
echo Downloading the latest version from GitHub...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; try { Invoke-WebRequest -UseBasicParsing 'https://codeload.github.com/SelimNajaf/ansoc/zip/refs/heads/main' -OutFile '%ZIP%'; if (Test-Path '%TMPD%') { Remove-Item -Recurse -Force '%TMPD%' }; Expand-Archive -Force '%ZIP%' '%TMPD%'; exit 0 } catch { Write-Host $_; exit 1 }"
if errorlevel 1 (
  echo [x] The download failed. Check your internet connection and try again.
  pause
  exit /b 1
)
set "SRC="
for /d %%d in ("%TMPD%\*") do set "SRC=%%d"
if not exist "%SRC%\Install-Windows.bat" (
  echo [x] The downloaded files look wrong. Try again later.
  pause
  exit /b 1
)
call "%SRC%\Install-Windows.bat"
del /q "%ZIP%" 2>nul
endlocal
