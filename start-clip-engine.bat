@echo off
REM Daily use: build once if needed, start the dashboard in production mode, open the browser.
cd /d "%~dp0"
if not exist "apps\web\.next\BUILD_ID" (
  echo Building Clip Engine...
  call pnpm build || goto :error
)
call pnpm db:migrate || goto :error
start "" http://localhost:3000
call pnpm start
goto :eof
:error
echo Startup failed. See messages above.
pause
