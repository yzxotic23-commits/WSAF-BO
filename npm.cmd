@echo off
set "NODE_HOME=C:\Program Files\nodejs"
if not exist "%NODE_HOME%\npm.cmd" (
  echo Node.js tidak ditemukan di %NODE_HOME%
  exit /b 1
)
echo "%PATH%" | find /I "%NODE_HOME%" >nul || set "PATH=%NODE_HOME%;%PATH%"
"%NODE_HOME%\npm.cmd" %*
