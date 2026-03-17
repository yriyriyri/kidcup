@echo off
setlocal

cd /d "%USERPROFILE%\Desktop\kidcup"

start "Kidcup Server" cmd /k "cd /d %USERPROFILE%\Desktop\kidcup && npm run start"

timeout /t 5 /nobreak >nul

start chrome --start-fullscreen http://localhost:3000

endlocal