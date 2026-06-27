# Hapus asset di GitHub Release (butuh token dengan scope repo).
# Usage:
#   $env:GITHUB_TOKEN = "ghp_xxxx"
#   .\scripts\delete-github-release-asset.ps1 -AssetId 437061113
# Atau hapus latest.yml v1.0.21 lalu upload yang baru:
#   .\scripts\delete-github-release-asset.ps1 -Tag v1.0.21 -AssetName latest.yml
#   .\scripts\delete-github-release-asset.ps1 -Tag v1.0.21 -UploadPath release-build\latest.yml

param(
  [string]$Owner = 'yzxotic23-commits',
  [string]$Repo = 'WSAF-BO',
  [long]$AssetId = 0,
  [string]$Tag = '',
  [string]$AssetName = 'latest.yml',
  [string]$UploadPath = ''
)

$token = $env:GITHUB_TOKEN
if (-not $token) { $token = $env:GH_TOKEN }
if (-not $token) {
  Write-Error 'Set GITHUB_TOKEN atau GH_TOKEN (PAT dengan scope repo).'
  exit 1
}

$headers = @{
  Authorization = "Bearer $token"
  Accept        = 'application/vnd.github+json'
  'User-Agent'  = 'FeedFlow'
  'X-GitHub-Api-Version' = '2022-11-28'
}

function Remove-Asset([long]$id) {
  $uri = "https://api.github.com/repos/$Owner/$Repo/releases/assets/$id"
  Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers
  Write-Host "[ok] Deleted asset id $id"
}

if ($AssetId -gt 0) {
  Remove-Asset $AssetId
} elseif ($Tag) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$Tag" -Headers $headers
  $asset = $release.assets | Where-Object { $_.name -eq $AssetName }
  if (-not $asset) {
    Write-Host "[skip] Asset '$AssetName' not found on $Tag"
  } else {
    Remove-Asset $asset.id
  }
  if ($UploadPath -and (Test-Path $UploadPath)) {
    $uploadUri = "https://uploads.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets?name=$(Split-Path $UploadPath -Leaf)"
    $bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $UploadPath))
    Invoke-RestMethod -Uri $uploadUri -Method Post -Headers @{
      Authorization = "Bearer $token"
      Accept        = 'application/vnd.github+json'
      'Content-Type' = 'application/octet-stream'
    } -Body $bytes | Out-Null
    Write-Host "[ok] Uploaded $(Split-Path $UploadPath -Leaf) to $Tag"
  }
} else {
  Write-Error 'Provide -AssetId or -Tag'
  exit 1
}
