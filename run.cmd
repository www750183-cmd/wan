@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
node sync.mjs
echo.
echo ============================================
echo  Done. Output files:
echo    free-quota-list.md  (readable list)
echo    data\offers.json    (structured data)
echo ============================================
pause
