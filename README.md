# WhatsApp Auto Chat - Terminal Edition

Bot otomatis yang membuat 2 akun WhatsApp saling chat menggunakan AI (OpenAI / Claude) untuk generate percakapan yang natural.

## Fitur

- 100% terminal (tanpa browser)
- Scan QR code di terminal
- AI-powered conversation (OpenAI GPT atau Claude)
- Delay random supaya terlihat natural
- Topik percakapan bisa dikustomisasi
- Auto-stop setelah mencapai batas pesan

## Instalasi

```bash
# 1. Install dependencies
npm install

# 2. Copy dan edit file environment
copy .env.example .env

# 3. Edit .env dan isi API key + nomor target
```

## Konfigurasi (.env)

| Variable | Deskripsi |
|----------|-----------|
| `AI_PROVIDER` | `openai` atau `claude` |
| `OPENAI_API_KEY` | API key dari OpenAI |
| `CLAUDE_API_KEY` | API key dari Anthropic |
| `ACCOUNT1_TARGET` | Nomor WA Account 2 (format: 628xxx) |
| `ACCOUNT2_TARGET` | Nomor WA Account 1 (format: 628xxx) |
| `MIN_DELAY` | Delay minimum antar pesan (detik) |
| `MAX_DELAY` | Delay maksimum antar pesan (detik) |
| `TOPICS` | Topik percakapan (comma separated) |
| `MAX_MESSAGES` | Batas maksimal pesan per sesi |
| `LANGUAGE` | Bahasa percakapan |

## Cara Pakai

```bash
# Jalankan bot
npm start
```

### Flow:
1. Terminal akan menampilkan QR code untuk **Account 1** - scan dengan HP pertama
2. Setelah Account 1 terhubung, muncul QR code untuk **Account 2** - scan dengan HP kedua
3. Setelah kedua akun terhubung, bot otomatis mulai percakapan
4. Account 1 akan mengirim pesan pembuka (topik random dari AI)
5. Account 2 menerima pesan dan membalas otomatis
6. Percakapan berlanjut bolak-balik sampai batas `MAX_MESSAGES`

### Contoh Output:
```
╔══════════════════════════════════════════╗
║   WhatsApp Auto Chat - Terminal Edition  ║
║   AI-Powered Conversation Generator     ║
╚══════════════════════════════════════════╝

🤖 AI Provider: openai
⏱️  Delay: 10s - 30s
📨 Max messages: 50

📲 LANGKAH 1: Hubungkan Account 1
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ (QR CODE)
✅ [account1] Terhubung sebagai: John

📲 LANGKAH 2: Hubungkan Account 2
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ (QR CODE)
✅ [account2] Terhubung sebagai: Jane

🚀 Memulai percakapan...

📤 [14:30:01] Account1 → Account2: Eh bro, lu udah nonton film baru yang rame itu belum?
⏳ Account2 sedang mengetik... (15s)
📤 [14:30:16] Account2 → Account1: Yang mana nih? Banyak banget film baru wkwk
```

## Stop Bot

Tekan `Ctrl + C` untuk menghentikan bot.

## Catatan

- Pastikan kedua nomor HP sudah saling save kontak
- Jangan spam terlalu cepat (set MIN_DELAY minimal 10 detik)
- Session tersimpan di folder `auth/` - tidak perlu scan ulang setelah pertama kali
- Jika ingin reset session, hapus folder `auth/account1` atau `auth/account2`
