# Wrapper: cari ollama.exe setelah install
$candidates = @(
  "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe",
  "$env:ProgramFiles\Ollama\ollama.exe",
  "C:\Program Files\Ollama\ollama.exe"
)
foreach ($exe in $candidates) {
  if (Test-Path $exe) {
    $dir = Split-Path $exe -Parent
    $env:Path = "$dir;" + $env:Path
    & $exe @args
    exit $LASTEXITCODE
  }
}
$wingetOllama = Get-Command ollama -ErrorAction SilentlyContinue
if ($wingetOllama) {
  & ollama @args
  exit $LASTEXITCODE
}
Write-Error "Ollama belum terinstall. Jalankan: winget install Ollama.Ollama"
exit 1
