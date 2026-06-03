@echo off
title WhatsApp Auto Feeding Launcher
taskkill /F /IM "WhatsApp Auto Feeding.exe" /T >nul 2>&1
timeout /t 1 /nobreak >nul
start "" "%LOCALAPPDATA%\FeedFlow\WhatsApp Auto Feeding\WhatsApp Auto Feeding.exe"
if errorlevel 1 (
  echo Installer belum ada di FeedFlow. Jalankan Setup 1.0.23 dari ZIP dulu.
  pause
)
