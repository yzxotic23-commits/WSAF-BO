# WSAF — WhatsApp Auto Feeding (FeedFlow)

Aplikasi desktop & web untuk auto feeding percakapan WhatsApp antar pasangan akun.

## Isi folder

- `electron/` — Desktop app (Electron)
- `client/` — React UI (FeedFlow + dashboard terintegrasi lama)
- `server/` — Desktop API + AMS HTML legacy
- `src/` — Engine feeding (Baileys, AI, proxy, audit)
- `index.js` — CLI feeding
- `ams.db` — SQLite AMS lokal (prototype, digantikan oleh AMS Project)

## Run

```bash
npm install
npm run web       # http://localhost:47821
npm run desktop   # Electron
```
