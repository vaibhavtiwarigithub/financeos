@echo off
REM Start the Kairos dev server on port 3000 and LEAVE IT RUNNING.
REM
REM Why this exists: a dev server started from an agent/tool session is scoped to
REM that session and dies with it, so localhost was never up when you went to
REM look. This window owns the server instead — close the window to stop it.
REM
REM Port 3000 is not negotiable: the Robinhood OAuth callback is registered to
REM http://localhost:3000/api/robinhood-mcp/callback, and Robinhood refuses to
REM complete a grant against any other redirect (a remote https URL dead-ends at
REM robinhood.com/oauth/error). A reassigned port silently breaks the one flow
REM that can authorise the broker.

cd /d "%~dp0.."

echo Checking port 3000...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr /r /c:"TCP.*:3000 .*LISTENING"') do (
  echo Port 3000 already in use by PID %%p.
  echo If that is a stale server, run:  taskkill /PID %%p /F
  echo Then re-run this script.
  pause
  exit /b 1
)

echo Starting Kairos dev server on http://localhost:3000
echo.
echo   Keep this window OPEN. Closing it stops the server.
echo   Robinhood connect: http://localhost:3000/dashboard/settings?tab=trading
echo.
call npm run dev
