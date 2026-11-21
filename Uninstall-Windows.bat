@echo off
rem Media Downloader - uninstall. Your downloaded files (Desktop\Medias) are NOT deleted.
chcp 65001 >nul
setlocal
set "DEST=%USERPROFILE%\MediaDownloader"
echo.
echo === Uninstalling Media Downloader ===
if exist "%DEST%\helper\.venv\Scripts\python.exe" (
  "%DEST%\helper\.venv\Scripts\python.exe" "%DEST%\helper\main.py" uninstall
)
echo.
echo  1. In Chrome open chrome://extensions and click "Remove" on Media Downloader.
echo  2. Delete the program folder %DEST% ?
choice /C YN /M "    Delete it now"
if errorlevel 2 goto :done
cd /d "%USERPROFILE%"
rmdir /s /q "%DEST%"
echo [ok] Program folder deleted.
:done
echo.
echo Your downloads in Desktop\Medias were kept.
pause
endlocal
