@echo off
cd /d "%~dp0"
set "NODE_HOME=C:\Program Files\nodejs"
if not exist "%NODE_HOME%\npx.cmd" (
  echo Node.js/npx tidak ditemukan di %NODE_HOME%
  exit /b 1
)
echo "%PATH%" | find /I "%NODE_HOME%" >nul || set "PATH=%NODE_HOME%;%PATH%"
"%NODE_HOME%\npx.cmd" @openai/codex login
