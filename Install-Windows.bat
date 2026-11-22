@echo off
rem Media Downloader - Windows installer. Double-click this file.
chcp 65001 >nul
setlocal
set "HERE=%~dp0"
if "%HERE:~-1%"=="\" set "HERE=%HERE:~0,-1%"
set "DEST=%USERPROFILE%\MediaDownloader"
echo.
echo === Installing Media Downloader ===
echo.
if not exist "%DEST%" mkdir "%DEST%"
if /I "%HERE%"=="%DEST%" goto :helper
robocopy "%HERE%\extension" "%DEST%\extension" /MIR /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 ( echo [x] Could not copy the extension. & pause & exit /b 1 )
rem keep the installed .venv, settings and logs when updating
robocopy "%HERE%\helper" "%DEST%\helper" /E /XD .venv __pycache__ state logs bin /XF config.json pindl_host.bat *.log /NFL /NDL /NJH /NJS /NP >nul
if errorlevel 8 ( echo [x] Could not copy the helper. & pause & exit /b 1 )
for %%f in (Update-Windows.bat Uninstall-Windows.bat README.md) do if exist "%HERE%\%%f" copy /y "%HERE%\%%f" "%DEST%\%%f" >nul

:helper
call "%DEST%\helper\install_windows.bat" --nopause
if errorlevel 1 (
  echo.
  echo [x] The helper could not be installed. Read the message above.
  pause
  exit /b 1
)
start "" explorer "%DEST%"
start "" chrome "chrome://extensions/" 2>nul
echo.
echo ======================================================================
echo  DONE! Last step (first time only):
echo.
echo   1. In Chrome open   chrome://extensions
echo   2. Turn on "Developer mode" (top right)
echo   3. Click "Load unpacked" and choose this folder:
echo         %DEST%\extension
echo   4. Updating? Just click the reload icon on the extension instead.
echo.
echo  Your downloads go to your Downloads folder and show up in Chrome's
echo  download list. Several files at once come as one ZIP.
echo ======================================================================
pause
endlocal
