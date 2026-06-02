@echo off
REM Jalankan sekali per sesi terminal:  call setup-env.cmd
set "NODE_HOME=C:\Program Files\nodejs"
set "OLLAMA_HOME=%LOCALAPPDATA%\Programs\Ollama"
if exist "%NODE_HOME%\node.exe" (
  echo "%PATH%" | find /I "%NODE_HOME%" >nul || set "PATH=%NODE_HOME%;%PATH%"
)
if exist "%OLLAMA_HOME%\ollama.exe" (
  echo "%PATH%" | find /I "%OLLAMA_HOME%" >nul || set "PATH=%OLLAMA_HOME%;%PATH%"
)
echo PATH siap: node, npm, npx, ollama tersedia di terminal ini.
