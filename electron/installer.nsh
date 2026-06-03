; Tutup instance app sebelum update (tanpa nsExec — lebih aman di NSIS electron-builder).
!macro customInit
  ExecWait '$\"$WINDIR\System32\taskkill.exe$\" /F /IM $\"WhatsApp Auto Feeding.exe$\" /T' $0
  Sleep 500
!macroend
