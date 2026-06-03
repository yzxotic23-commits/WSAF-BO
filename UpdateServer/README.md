# Update Server — Auto-update FeedFlow Desktop

**Mode otomatis (default):** app installer cek **GitHub Releases**  
`https://github.com/yzxotic23-commits/WSAF-BO/releases/latest/download/`

Setiap push tag `v*` → GitHub Actions build + upload ke Releases → user dapat update tanpa upload manual.

## Alur otomatis

1. Kamu push tag: `git tag v1.0.22 && git push origin v1.0.22`
2. Actions: build Windows + Mac → job **publish-github-release**
3. File di GitHub Release: `.exe`, `.zip`, `.dmg`, `latest.yml`, `latest-mac.yml`
4. User buka app versi lama → toast update → download → **Update Now** → restart

## File di setiap GitHub Release

| Platform | File |
|----------|------|
| Windows  | `WhatsApp Auto Feeding Setup X.X.X.exe`, `latest.yml`, `.blockmap` |
| macOS    | `.zip` (utama untuk updater), `.dmg`, `latest-mac.yml` |

Generate manifest lokal (opsional):

```bash
npm run build:win
node scripts/generate-update-manifest.js release win
```

## Konfigurasi `.env` (opsional)

Default sudah di kode — kosongkan pun update jalan (repo public).

```env
APP_UPDATE_GITHUB_OWNER=yzxotic23-commits
APP_UPDATE_GITHUB_REPO=WSAF-BO
APP_UPDATE_CHECK_HOURS=4
```

CDN sendiri (override):

```env
APP_UPDATE_URL=https://your-domain.com/updates/
```

## CI

Workflow **Release Desktop** → artifact + **GitHub Release** otomatis pada tag `v*`.
