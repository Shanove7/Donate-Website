# Donate Website

Website donasi dengan pilihan pembayaran QRIS MUA dan E-Wallet.

## Environment Variables

- `BTZ_APIexpressAPI key untuk metode QRIS lama (pilihan kedua).
- `BTZ_QRISDANA_API_KEY` atau `QRISDANA_API_KEY`: API key untuk metode QRISDANA (pilihan utama).
- `BTZ_SHOPEEPAY_API_KEY` atau `SHOPEEPAY_API_KEY`: API key ShopeePay.
- `BTZ_SHOPEEPAY_ACCOUNT_NUMBER`: nomor tujuan ShopeePay.
- `BTZ_SHOPEEPAY_ACCOUNT_NAME`: nama tujuan ShopeePay.
- `ADMIN_PASSWORD`: password admin.
- `FEE_PERCENT`: persentase biaya admin.
- `JSONBIN_ID` dan `JSONBIN_KEY`: penyimpanan database JSONBin.

QRISDANA memakai alur API Betabotz Paygate yang sudah digunakan proyek ini, tetapi menggunakan API key terpisah. Jika akun/provider QRISDANA yang digunakan mempunyai endpoint atau format API berbeda, integrasi backend perlu disesuaikan dengan dokumentasi provider tersebut.
