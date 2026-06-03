@echo off
set "OLLAMA_HOME=%LOCALAPPDATA%\Programs\Ollama"
if exist "%OLLAMA_HOME%\ollama.exe" (
  echo "%PATH%" | find /I "%OLLAMA_HOME%" >nul || set "PATH=%OLLAMA_HOME%;%PATH%"
  "%OLLAMA_HOME%\ollama.exe" %*
  exit /b %ERRORLEVEL%
)
if exist "%ProgramFiles%\Ollama\ollama.exe" (
  set "OLLAMA_HOME=%ProgramFiles%\Ollama"
  echo "%PATH%" | find /I "%OLLAMA_HOME%" >nul || set "PATH=%OLLAMA_HOME%;%PATH%"
  "%OLLAMA_HOME%\ollama.exe" %*
  exit /b %ERRORLEVEL%
)
echo Ollama belum terinstall. Jalankan: winget install Ollama.Ollama
exit /b 1
