@echo off
setlocal

cd /d "%USERPROFILE%\Desktop\kidcup"

echo Pulling latest changes...
git pull

echo Installing dependencies...
call npm install

echo Building project...
call npm run build

echo Starting server...
start "Kidcup Server" cmd /k "cd /d %USERPROFILE%\Desktop\kidcup && npm run start"

timeout /t 5 /nobreak >nul

echo Opening Chrome...
start chrome http://localhost:3000

endlocal