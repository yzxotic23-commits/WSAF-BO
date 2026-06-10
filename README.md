# FeedFlow — WhatsApp Auto Feeding

Aplikasi untuk Windows dan Mac yang membuat dua akun WhatsApp (atau lebih) saling mengirim pesan secara otomatis. Pesan dihasilkan oleh AI agar terlihat natural, dengan jeda waktu yang bisa diatur.

**Versi stabil saat ini:** 1.0.21  
**Unduhan resmi:** [v1.0.21-restored di GitHub](https://github.com/yzxotic23-commits/WSAF-BO/releases/tag/v1.0.21-restored)

> **Penting:** Versi 1.0.22 sampai 1.0.32 tidak disarankan dipakai karena banyak masalah (login, feeding, update di Mac). Pakai **v1.0.21-restored** sampai versi baru yang sudah diuji tersedia.

---

## Apa yang bisa dilakukan aplikasi ini?

- Menghubungkan akun WhatsApp lewat **scan QR** dari dalam aplikasi  
- Menjalankan **feeding** — percakapan otomatis antar pasang akun  
- Mengatur **bahasa**, **jeda antar pesan**, dan **batas jumlah pesan**  
- Menggunakan **AI** (langganan Codex atau AI lokal Ollama)  
- Menggunakan **proxy** jika diperlukan, lewat menu pengaturan  
- Menyimpan sesi login agar tidak perlu scan QR setiap kali buka aplikasi  

---

## Cara install (pengguna biasa)

### Windows

1. Buka halaman [rilis v1.0.21-restored](https://github.com/yzxotic23-commits/WSAF-BO/releases/tag/v1.0.21-restored).  
2. Unduh file instalasi Windows (Setup versi 1.0.21).  
3. Jalankan instalasi, lalu buka **WhatsApp Auto Feeding**.  
4. Hubungkan kedua akun lewat QR di panel samping.  
5. Klik **Start feeding** setelah semua akun terhubung.

### Mac

1. Dari halaman rilis yang sama, unduh file **DMG** untuk Mac (Apple Silicon).  
2. Buka file DMG, lalu tarik aplikasi ke folder **Applications**.  
3. Jika Mac memblokir aplikasi: klik kanan pada ikon app → pilih **Open**.  
4. Hubungkan akun lewat QR, lalu **Start feeding**.

**Update di Mac:** unduh file DMG terbaru secara manual dari halaman rilis. Update otomatis di dalam aplikasi sering gagal pada versi lama — lebih aman install manual.

---

## Cara pakai (singkat)

1. **Hubungkan akun** — scan QR untuk setiap akun sampai status di panel samping menunjukkan semua sudah terhubung.  
2. **Atur pengaturan** — bahasa percakapan, jeda pesan, proxy (jika perlu), dan sumber AI lewat menu **Settings**.  
3. **Mulai feeding** — klik **Start feeding**. Aplikasi akan menjalankan percakapan antar akun.  
4. **Pantau aktivitas** — lihat pesan dan catatan aktivitas di layar aplikasi.  
5. **Selesai** — feeding berhenti sendiri sesuai batas pesan, atau klik **Stop** kapan saja.

Setelah feeding selesai, akun biasanya kembali online di aplikasi tanpa perlu scan QR lagi (selama sesi masih tersimpan).

---

## Di mana data disimpan?

Data Anda (pengaturan, sesi WhatsApp, daftar proxy) disimpan di folder data pengguna di komputer, **bukan** di folder instalasi aplikasi.

- **Windows:** folder data aplikasi di AppData pengguna  
- **Mac:** folder Application Support di Library pengguna  

Untuk menghapus semua sesi WhatsApp dan mulai dari awal: buka **Settings → Clear all sessions** di aplikasi.

---

## Update aplikasi

| Platform | Cara update yang disarankan |
|----------|----------------------------|
| **Windows** | Gunakan fitur cek update di aplikasi, atau unduh installer baru dari GitHub |
| **Mac** | Unduh DMG terbaru dari GitHub, lalu ganti aplikasi lama di folder Applications |

Jika update di Mac menampilkan error, abaikan update otomatis dan install manual dari halaman rilis **v1.0.21-restored**.

---

## Masalah umum & solusi

| Masalah | Apa yang bisa dicoba |
|---------|----------------------|
| Tombol Start feeding tidak aktif | Pastikan semua akun sudah terhubung; refresh status atau hapus sesi lalu hubungkan ulang |
| QR terus kedaluwarsa | Hapus semua sesi, hubungkan satu per satu; tutup aplikasi ganda yang berjalan bersamaan |
| Daftar proxy tidak muncul | Simpan ulang daftar proxy di Settings dan uji koneksi proxy |
| Update Mac gagal | Install manual dari DMG; jangan pakai versi 1.0.22–1.0.32 |
| AI tidak merespons | Pastikan login Codex sudah dilakukan, atau AI lokal (Ollama) sudah berjalan |

---

## Riwayat versi (ringkas)

| Versi | Keterangan |
|-------|------------|
| **1.0.21-restored** | Versi stabil saat ini — disarankan untuk dipakai |
| 1.0.22 – 1.0.32 | Dibatalkan — banyak gangguan pada login, feeding, dan update |
| 1.0.21 | Versi stabil sebelum perubahan besar |

Rencana perbaikan minggu depan ada di folder **planning** di dalam proyek ini.

---

## Panduan tambahan

- **[README-DESKTOP.md](./README-DESKTOP.md)** — detail khusus aplikasi desktop (install, update, rollback)  
- **[Halaman rilis GitHub](https://github.com/yzxotic23-commits/WSAF-BO/releases)** — unduh installer Windows dan DMG Mac  

---

## Lisensi

MIT
