@echo off
setlocal

cd /d "%USERPROFILE%\Desktop\kidcup"

start "Kidcup Server" cmd /k "cd /d %USERPROFILE%\Desktop\kidcup && npm run start"

timeout /t 5 /nobreak >nul

start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" http://localhost:3000

endlocal