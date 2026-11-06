@echo off
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js is required for this launcher. You can also use Python: python -m http.server 4173
  echo Open http://127.0.0.1:4173 after starting a local server.
  pause
  exit /b 1
)
echo Open http://127.0.0.1:4173 in Chrome or Edge.
node server.mjs
pause
