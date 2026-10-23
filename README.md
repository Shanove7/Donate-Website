# Kaxel Donate Website

Website donasi Kaxel Support dengan metode QRIS DANA (utama), QRIS alternatif, dan ShopeePay. Implementasi ini mempertahankan halaman, aset pembayaran, live chat, riwayat publik, serta ticker donasi 24 jam yang sudah ada.

## Environment variables

- `BTZ_API_KEY`: API key QRIS lama/alternatif.
- `BTZ_QRISDANA_API_KEY` atau `QRISDANA_API_KEY`: API key QRIS DANA utama.
- `BTZ_SHOPEEPAY_API_KEY`: API key ShopeePay.
- `BTZ_SHOPEEPAY_ACCOUNT_NUMBER` dan `BTZ_SHOPEEPAY_ACCOUNT_NAME`: tujuan ShopeePay.
- `ADMIN_PASSWORD`: wajib diisi dengan password admin kuat. Endpoint admin menolak akses jika variabel ini kosong.
- `JSONBIN_ID` dan `JSONBIN_KEY`: penyimpanan persisten yang dipakai arsitektur proyek saat ini.
- `WASENDER_API_KEY`: token server-side untuk mengirim OTP dan pesan member melalui Wasender.
- `WASENDER_API_URL`: default `https://api.wasender.dev/messages/text`.
- `OTP_HASH_SECRET`: secret stabil untuk hashing OTP. Isi dengan nilai acak yang kuat dan simpan hanya di environment server. Jika kosong, kode memakai `WASENDER_API_KEY` sebagai fallback.
- `DONATION_FEE_ENABLED`: default `false`. Fee tambahan website tidak dikirim ke gateway selama masih `false`.
- `MEMBER_FEE_PERCENT`: rencana tarif member, default `0.3`.
- `ANONYMOUS_FEE_PERCENT`: rencana tarif anonim, default `0.7`. `FEE_PERCENT` tetap didukung sebagai fallback kompatibilitas.
- `EARLY_SUPPORTER_CUTOFF`: tanggal ISO untuk batas periode badge Early Supporter, misalnya `2026-11-01T00:00:00+07:00`. Jika kosong, badge tersebut tidak diberikan.

Jangan mengaktifkan `DONATION_FEE_ENABLED=true` pada QRIS sebelum metode penagihan dikonfirmasi sesuai aturan provider dan ketentuan yang berlaku. MDR QRIS tidak boleh otomatis dibebankan ke konsumen. Tarif 0,3%/0,7% disiapkan sebagai konfigurasi, bukan bukti bahwa fee boleh ditagihkan.

## Member, OTP, and WhatsApp

- Registrasi/login memakai OTP WhatsApp enam digit, masa berlaku lima menit, maksimal lima percobaan, cooldown 60 detik, dan pembatasan permintaan per nomor/IP.
- OTP disimpan sebagai hash scrypt bersalt; token Wasender tidak pernah dikirim ke browser.
- Status transaksi dan invoice melalui bot hanya diproses jika transaksi terhubung dengan akun member yang nomor WhatsApp-nya terverifikasi.
- Notifikasi status dan invoice menggunakan event key dan log pengiriman untuk mencegah duplikasi, dengan retry terbatas untuk kegagalan yang tercatat.
- Invoice final pada dashboard member tersedia setelah status pembayaran dikenali sebagai berhasil.
- Dashboard member menampilkan total donasi berhasil, jumlah transaksi, level, badge, pengaturan nama publik, dan riwayat transaksi milik akun itu saja.
- Badge `Early Supporter` memerlukan konfigurasi `EARLY_SUPPORTER_CUTOFF`. `Anonymous Hero` dicatat pada transaksi anonim yang berhasil tanpa mengaitkan identitas akun.

## Penyimpanan dan batasan arsitektur

Repository ini masih memakai JSONBin sebagai penyimpanan dokumen, dengan fallback memori untuk pengembangan lokal. JSONBin bukan database transaksional dan tidak menyediakan atomic compare-and-set untuk operasi ini. Karena itu, log notifikasi membantu idempotensi tetapi tidak menjamin exactly-once pada kondisi konkurensi atau gangguan jaringan. Untuk beban produksi, migrasikan data secara terencana ke database transaksional (misalnya PostgreSQL) dan gunakan tabel outbox dengan unique constraint sebelum mengandalkan sistem untuk volume tinggi. Jangan menghapus atau menimpa data JSONBin saat migrasi.

Pemeriksaan status pembayaran mengikuti endpoint polling Betabotz Paygate yang sudah dipakai proyek. Repository ini tidak menunjukkan konfigurasi webhook bertanda tangan; jangan mengklaim webhook telah aktif tanpa dokumentasi provider dan pengujian nyata. Status dan nominal yang dikembalikan provider harus tetap diuji pada akun sandbox/produksi sebelum rilis.

## Menjalankan dan memeriksa

```bash
npm install
npm start
```

Pemeriksaan sintaks yang tersedia di lingkungan pengembangan:

```bash
node --check api/index.js
```

Uji end-to-end memerlukan JSONBin, kredensial Betabotz Paygate, kredensial Wasender, dan transaksi uji yang valid. Jangan menggunakan API key produksi di log atau repository. Jika token Wasender pernah dipublikasikan, rotasi token tersebut sebelum deploy.
 
