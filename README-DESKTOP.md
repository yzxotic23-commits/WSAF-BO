# WhatsApp Auto Feeding — Desktop (Windows & macOS)

## Audit singkat (status repo)

| Area | Status | Catatan |
|------|--------|---------|
| Core bot (Baileys + AI) | Ada | `index.js`, `src/*` — stabil di CLI |
| Paket Windows v1.0.10 | Ada | Folder `WhatsApp-Auto-Feeding-Windows-v1.0.10/` (installer/docs), **tanpa source Electron di repo** |
| Source Electron | **Ditambahkan** | Folder `desktop/` — GUI connect, settings, feeding log |
| Path lintas OS | **Diperbaiki** | `src/app-paths.js` + `WA_APP_DATA` |
| Build macOS | **Siap** | `npm run build:mac` (harus dijalankan di Mac) |
| Auto-update macOS | Belum | `latest.yml` di paket Windows; perlu channel DMG/ZIP terpisah untuk Mac |

### Fitur desktop (baru di repo)

- Connect akun via **QR** di jendela app
- Edit **.env** dan **proxies.txt** dari UI
- **Start / Stop feeding** (menjalankan `index.js` non-interaktif, log di panel)
- Data disimpan di folder user (bukan folder install):
  - **macOS:** `~/Library/Application Support/whatsapp-auto-chat/`
  - **Windows:** `%APPDATA%/whatsapp-auto-chat/`

### Yang masih via terminal

- **Codex login:** `npm run codex-login` (browser OAuth)
- Pairing code penuh / beberapa flow advanced — bisa ditambah di UI berikutnya

---

## macOS — development

### Syarat

- macOS 12+
- [Node.js](https://nodejs.org) 20+ (atau `brew install node`)
- Opsional: [Ollama](https://ollama.com) untuk fallback AI

### Setup

```bash
cd "/path/to/Whatsapp Auto Feeding"
chmod +x scripts/macos-setup.sh scripts/macos-start.sh
./scripts/macos-setup.sh
```

### Login Codex (sekali)

```bash
npm run codex-login
# Token: ~/.codex/auth.json
```

### Jalankan aplikasi GUI

```bash
npm run desktop
# atau
./scripts/macos-start.sh
```

### CLI feeding (tanpa GUI)

```bash
npm start
```

---

## macOS — build installer (.dmg)

Build **harus di mesin Mac** (Apple Silicon atau Intel):

```bash
npm install
npm run build:mac          # universal-ish (dmg + zip)
npm run build:mac:arm      # Apple Silicon
npm run build:mac:intel    # Intel
```

Output: `release/WhatsApp Auto Feeding-x.x.x.dmg`

Gatekeeper: app unsigned mungkin perlu **klik kanan → Open** pertama kali, atau Developer ID + notarisasi untuk distribusi publik.

### Tanpa Mac fisik — dapatkan DMG lewat GitHub (seperti CI build)

File `.dmg` **tidak bisa** dibuat di PC Windows. Alternatif gratis:

1. Push repo ke GitHub.
2. **Actions** → **Release Desktop** → **Run workflow**.
3. Unduh artifact **macos-dmg** (`.dmg` + `.zip` siap share).

Lihat juga folder `WhatsApp-Auto-Feeding-macOS-v1.0.10/BACA-PAKET.txt`.

---

## Windows — development

```bat
npm install
npm run desktop
```

Build:

```bat
npm run build:win
```

---

## Variabel lingkungan (desktop / CLI)

| Variable | Fungsi |
|----------|--------|
| `WA_APP_DATA` | Folder data (.env, auth/, proxies.txt) — di-set otomatis oleh Electron |
| `WA_NON_INTERACTIVE` | `1` = tanpa prompt readline (feeding dari app) |
| `WA_LANGUAGE` | Bahasa feeding: Indonesia, English, … |
| `WA_LOGIN_METHOD` | `qr` atau `pairing` |
| `WA_POST_FEEDING` | `exit`, `continue`, `new` (mode non-interaktif) |

---

## Struktur folder

```
desktop/           # Electron main, preload, UI
src/               # WhatsApp, proxy, AI, app-paths
index.js           # CLI feeding loop
auth/              # Session WA (dev; production di userData)
release/           # Output electron-builder (gitignore disarankan)
```
