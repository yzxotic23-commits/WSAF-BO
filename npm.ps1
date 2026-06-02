# Wrapper npm/npx — PATH Node.js untuk terminal Cursor lama
$nodeHome = "C:\Program Files\nodejs"
if (-not (Test-Path "$nodeHome\npm.cmd")) {
  Write-Error "Node.js tidak ditemukan di $nodeHome"
  exit 1
}
if ($env:Path -notlike "*$nodeHome*") {
  $env:Path = "$nodeHome;$env:Path"
}
& "$nodeHome\npm.cmd" @args
exit $LASTEXITCODE
