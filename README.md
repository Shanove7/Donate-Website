# Kaxel Donate

Website donasi Kaxel Support dengan tema Neo-Brutalism yang sudah ada, riwayat dan total donasi, QRIS DANA sebagai metode utama, QRIS alternatif, ShopeePay bila dikonfigurasi, login member OTP WhatsApp, dashboard member, invoice, notifikasi, halaman admin, health, dan status layanan.

## URL shortcut

- Website: `/`
- Admin: `/admin`
- Health: `/health`
- Status sistem: `/status`
- Hasil kembali dari payment gateway: `/success`
- Callback gateway: `/api/paygate/callback`

URL shortcut dirutekan lewat `vercel.json`, sehingga pengguna tidak perlu menulis `.html` di akhir URL.

## Environment Variables Vercel

Salin nama dan nilai dari `.env.example`, lalu masukkan setiap variabel sebagai baris tersendiri pada **Project → Settings → Environment Variables**. Setelah selesai, lakukan redeploy.

Variabel pembayaran yang wajib untuk metode utama:

- `SITE_URL=https://donate.khasan.site`
- `BTZ_BASE_URL=https://web.btzpay.my.id`
- `BTZ_CALLBACK_URL=https://donate.khasan.site/api/paygate/callback`
- `BTZ_RETURN_URL=https://donate.khasan.site/success`
- `BTZ_QRISDANA_API_KEY`: API key payment method QRIS DANA dari Betabotz Paygate
- `JSONBIN_ID` dan `JSONBIN_KEY`: **gunakan bin lama** supaya data histori/goal/member tetap terhubung
- `ADMIN_PASSWORD`: password admin yang kuat
- `WASENDER_API_KEY` dan `OTP_HASH_SECRET`: dibutuhkan untuk OTP serta notifikasi WhatsApp

`BTZ_API_KEY` digunakan untuk metode QRIS alternatif (`qris`). Variabel ShopeePay hanya perlu diisi bila fitur itu memang akan digunakan. QRIS GoPay sengaja dinonaktifkan baik di UI maupun API selama maintenance.

Gunakan `DONATION_FEE_ENABLED=false` agar fee layanan tetap nonaktif. Tarif di `MEMBER_FEE_PERCENT` dan `ANONYMOUS_FEE_PERCENT` baru dipakai jika fee diaktifkan. `EARLY_SUPPORTER_CUTOFF` opsional; kosong berarti badge periode awal tidak diberikan.

Jangan commit file `.env` berisi token asli ke GitHub. Jika API key/token pernah dipublikasikan, rotasi sebelum deploy.

## Pembayaran, callback, dan return

Saat transaksi dibuat, backend mengirim `callback_url` dan `return_url` ke endpoint create Betabotz Paygate. Callback `/api/paygate/callback` tidak langsung mempercayai status di payload: server memeriksa kembali transaksi ke endpoint status gateway menggunakan access key yang tersimpan, memvalidasi ID/nominal, memperbarui status, dan mencatat notifikasi. Halaman `/success` memeriksa status transaksi lokal yang tersimpan pada browser melalui endpoint status; halaman itu tidak menganggap redirect sebagai bukti pembayaran sukses.

Dokumentasi provider menjelaskan dukungan parameter `callback_url` dan `return_url` di request create serta status transaksi pada endpoint transaction: https://web.btzpay.my.id/documentation. Hasil nyata tetap bergantung pada API key/payment method dan callback yang dapat dijangkau dari provider.

## Privasi anonim

Donasi tanpa akun diproses dan ditampilkan sebagai `Anonim`; alias yang dikirim dari browser tidak digunakan. Data transaksi member tetap ditampilkan sesuai pengaturan privasi akun.

## Health dan status

`/health` dan `/status` memakai endpoint `/api/health`. Health memeriksa konektivitas gateway, akses baca JSONBin, konfigurasi metode utama, kesiapan WhatsApp, serta URL callback/return. Pemeriksaan tidak membuat transaksi uji atau mengirim OTP. Label “terjangkau/terkonfigurasi” bukan jaminan bahwa pembayaran produksi berhasil.

## Menjalankan lokal

```bash
npm install
npm start
```

Pemeriksaan sintaks:

```bash
node --check api/index.js
```

Catatan: aplikasi masih memakai JSONBin sebagai storage dokumen. JSONBin bukan database transaksional dengan atomic compare-and-set; untuk volume tinggi, rencanakan migrasi ke database transaksional sebelum mengandalkan proses bersamaan dalam skala besar.
