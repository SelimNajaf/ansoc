@echo off
rem Media Downloader (Pinterest, TikTok, Instagram) - Windows helper installer
rem Usage: install_windows.bat [EXTENSION_ID] [--nopause]     (ID is optional; the extension has a fixed ID)
rem        install_windows.bat --uninstall
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "VENV=%HERE%\.venv"
set "VPY=%VENV%\Scripts\python.exe"
set "EXT_ID="
set "NOPAUSE="
set "UNINSTALL="
for %%a in (%*) do (
  if /I "%%~a"=="--nopause" ( set "NOPAUSE=1" ) else if /I "%%~a"=="--uninstall" ( set "UNINSTALL=1" ) else ( set "EXT_ID=%%~a" )
)

if defined UNINSTALL (
  if not exist "%VPY%" ( echo [x] Not installed. & goto :end_fail )
  "%VPY%" "%HERE%\main.py" uninstall
  goto :end_ok
)

rem 1) Python (3.9+) -------------------------------------------------------
call :find_python
if not defined PY (
  echo [..] Python not found. Installing Python 3.12 for this user with winget ^(no admin needed^)...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo [x] winget is not available. Install Python from https://www.python.org/downloads/windows/
    echo     ^(tick "Add python.exe to PATH"^), then run this installer again.
    start "" "https://www.python.org/downloads/windows/"
    goto :end_fail
  )
  winget install -e --id Python.Python.3.12 --scope user --silent --accept-package-agreements --accept-source-agreements
  call :find_python
)
if not defined PY (
  echo [x] Python could not be installed automatically. Install it from https://www.python.org/downloads/windows/ and run this again.
  goto :end_fail
)
echo [ok] Python: %PY%
"%PY%" --version

rem 2) Virtual environment + yt-dlp, gallery-dl, Pillow, exifread, FFmpeg (imageio-ffmpeg)
if not exist "%VPY%" (
  "%PY%" -m venv "%VENV%" || ( echo [x] Could not create the virtual environment. & goto :end_fail )
)
"%VPY%" -m pip install --quiet --upgrade pip
"%VPY%" -m pip install --quiet --upgrade -r "%HERE%\requirements.txt"
if errorlevel 1 ( echo [x] Package install failed ^(no internet or blocked by a proxy?^). Run this again when online. & goto :end_fail )
echo [ok] Packages installed: yt-dlp, gallery-dl, FFmpeg ^(imageio-ffmpeg^)

rem 3) Native Messaging manifest + registry + Desktop\MediaDownloader folders
if "%EXT_ID%"=="" (
  "%VPY%" "%HERE%\main.py" install
) else (
  "%VPY%" "%HERE%\main.py" install --extension-id %EXT_ID%
)
if errorlevel 1 ( echo [x] Registration failed. & goto :end_fail )
echo.
"%VPY%" "%HERE%\main.py" check
echo.
echo [ok] Helper installed.
goto :end_ok

rem ---------------------------------------------------------------------------
:find_python
rem Finds Python 3.9+ (never the Microsoft Store placeholder in WindowsApps).
set "PY="
for %%p in ("%LOCALAPPDATA%\Programs\Python\Python313\python.exe" "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" "%LOCALAPPDATA%\Programs\Python\Python310\python.exe" "%ProgramFiles%\Python313\python.exe" "%ProgramFiles%\Python312\python.exe" "%ProgramFiles%\Python311\python.exe" "%ProgramFiles%\Python310\python.exe") do (
  if not defined PY if exist "%%~p" set "PY=%%~p"
)
if not defined PY call :try_python py -3
if not defined PY call :try_python python
exit /b 0

:try_python
set "_CAND="
for /f "usebackq delims=" %%p in (`%* -c "import sys;print(sys.executable)" 2^>nul`) do set "_CAND=%%p"
if not defined _CAND exit /b 0
echo "%_CAND%" | findstr /I "WindowsApps" >nul && exit /b 0
"%_CAND%" -c "import sys;sys.exit(1 if sys.version_info<(3,9) else 0)" >nul 2>&1 || exit /b 0
set "PY=%_CAND%"
exit /b 0

:end_ok
endlocal & set "_MDL_NP=%NOPAUSE%"
if not defined _MDL_NP pause
exit /b 0

:end_fail
endlocal & set "_MDL_NP=%NOPAUSE%"
if not defined _MDL_NP pause
exit /b 1
