@echo off
setlocal

cd /d "%USERPROFILE%\Desktop\kidcup"

start "" cmd /c "npm run start"

timeout /t 5 /nobreak >nul

start chrome --start-fullscreen http://localhost:3000

endlocal