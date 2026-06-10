# FeedFlow — Panduan Aplikasi Desktop

Panduan untuk pengguna dan tim yang memakai **WhatsApp Auto Feeding** (FeedFlow) di **Windows** dan **Mac**.

**Versi yang dipakai:** 1.0.21  
**Unduhan:** [v1.0.21-restored](https://github.com/yzxotic23-commits/WSAF-BO/releases/tag/v1.0.21-restored)

---

## Status aplikasi (Juni 2026)

| Bagian | Kondisi |
|--------|---------|
| Feeding otomatis | Stabil di versi 1.0.21 |
| Tampilan desktop | Stabil di v1.0.21-restored |
| Hubungkan akun (QR) | Berjalan di versi stabil |
| Login pakai nomor telepon | Masih perlu perbaikan |
| Daftar proxy | Ada; kadang perlu disimpan ulang |
| Update Windows | Bisa lewat aplikasi |
| Update Mac | **Manual** — unduh DMG dari GitHub |
| Versi 1.0.22 – 1.0.32 | **Jangan dipakai** |

---

## Fitur di aplikasi desktop

- Hubungkan akun WhatsApp dengan **scan QR**  
- Menu **Settings** untuk pengaturan, bahasa, proxy, dan jumlah pasang akun  
- Tombol **Start** dan **Stop feeding**  
- Tampilan percakapan saat feeding berjalan  
- **Activity log** untuk melihat aktivitas di belakang layar  
- Pengecekan versi terbaru (Windows lebih andal daripada Mac)  

---

## Install pertama kali

### Windows

Unduh dan jalankan **WhatsApp Auto Feeding Setup 1.0.21** dari halaman rilis. Ikuti wizard instalasi, lalu buka aplikasi.

### Mac

Unduh file **DMG**, buka, lalu pindahkan aplikasi ke **Applications**. Jika Mac menolak membuka aplikasi, klik kanan → **Open**.

---

## Update aplikasi

### Windows

Bisa lewat menu cek update di aplikasi, atau unduh installer terbaru dari GitHub dan install di atas versi lama.

### Mac

Selalu unduh **DMG terbaru** dari halaman rilis GitHub, lalu ganti aplikasi di folder Applications.  
Update otomatis di dalam app sering gagal — ini normal untuk aplikasi yang belum ditandatangani resmi oleh Apple.

**Versi yang aman saat ini:** [v1.0.21-restored](https://github.com/yzxotic23-commits/WSAF-BO/releases/tag/v1.0.21-restored)

---

## Rollback (kembali ke versi stabil)

Jika versi baru bermasalah:

1. Tutup aplikasi.  
2. Install ulang **v1.0.21-restored** (Windows: installer, Mac: DMG).  
3. Buka aplikasi — pengaturan dan sesi WhatsApp di komputer Anda **biasanya tetap ada** setelah install ulang.

---

## Di mana data tersimpan?

Pengaturan dan sesi WhatsApp disimpan di folder data pengguna di komputer, terpisah dari folder instalasi.

- **Windows:** di area data pengguna (AppData)  
- **Mac:** di folder dukungan aplikasi di Library pengguna  

Isi umum: pengaturan aplikasi, sesi login WhatsApp, daftar proxy, cache update.

Untuk reset penuh: **Settings → Clear all sessions** di aplikasi.

---

## Alur kerja harian

1. Buka aplikasi.  
2. Pastikan semua akun **terhubung** (nama tampil di panel samping).  
3. Periksa pengaturan AI dan proxy jika diperlukan.  
4. Klik **Start feeding**.  
5. Pantau percakapan dan log.  
6. Stop manual jika perlu, atau tunggu sampai selesai.

Saat feeding dimulai, koneksi preview di layar mungkin terputus sementara — itu normal. Setelah selesai, akun biasanya muncul lagi sebagai terhubung.

---

## Keterbatasan yang perlu diketahui

- Login dengan nomor telepon belum stabil di semua kasus  
- Daftar proxy kadang perlu disimpan ulang agar tampil benar  
- Mac belum mendukung install update otomatis yang andal  
- Versi 1.0.22 sampai 1.0.32 menimbulkan banyak masalah — hindari  

Daftar perbaikan direncanakan ada di folder **planning** dalam proyek ini.

---

## Dokumen lain

- [README.md](./README.md) — ringkasan umum proyek  
- [Halaman rilis GitHub](https://github.com/yzxotic23-commits/WSAF-BO/releases) — unduh installer  

---

## Untuk tim pengembang

Panduan teknis (instalasi dari kode sumber, build installer, konfigurasi lanjutan) tersedia di repositori GitHub dan file contoh pengaturan di dalam proyek. Hubungi maintainer proyek jika membutuhkan akses atau dokumentasi teknis terpisah.
