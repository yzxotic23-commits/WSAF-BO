; Close all app instances before install/update (feeding spawns same .exe on Windows).
!macro customInit
  nsExec::ExecToLog 'taskkill /F /IM "WhatsApp Auto Feeding.exe" /T'
  Sleep 800
!macroend
