# Update Server — Auto-update FeedFlow Desktop

Upload isi folder ini ke web server HTTPS (atau GitHub Releases raw URL).

## File yang dibutuhkan

| Platform | Manifest | Installer |
|----------|----------|-----------|
| Windows  | `latest.yml` | `WhatsApp Setup X.X.X.exe` |
| macOS    | `latest-mac.yml` | `.zip` (preferred) atau `.dmg` |

Generate manifest setelah build:

```bash
npm run build:win
npm run update:manifest

npm run build:mac
npm run update:manifest
```

## Konfigurasi di `.env` (folder install app)

```env
APP_UPDATE_URL=https://your-domain.com/updates/
APP_UPDATE_CHECK_HOURS=4
```

App akan:
- Cek update ~4 detik setelah startup
- Cek ulang saat window difokuskan
- Download otomatis (minor & bugfix)
- Tampilkan banner hijau → restart untuk install

## CI (GitHub Actions)

Workflow **Release Desktop** otomatis menghasilkan `latest.yml` dan `latest-mac.yml` di artifact `windows-installer` / `macos-dmg`.
