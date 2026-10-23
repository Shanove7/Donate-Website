# Kaxel Donate

Kaxel Support donation website with member OTP, donation history, admin dashboard, transaction monitoring, and Betabotz Paygate integration.

## Configuration priority

Edit `config.js` first. Non-empty values in this file override environment variables. For blank secret fields, the application can use the matching environment variable as a fallback. The configuration is loaded before the API reads settings.

Required values for persistent existing data:
- `JSONBIN_ID`: ID of the existing JSONBin that contains the current donation history
- `JSONBIN_KEY`: JSONBin master key with read/write permission
- `ADMIN_PASSWORD`: admin login password

For payments and WhatsApp OTP, also configure the appropriate Betabotz Paygate API key and `WASENDER_API_KEY`.

Do not replace the existing JSONBin with a new bin if you need to retain transaction/member history. If the configured JSONBin cannot be read or written, the API now returns an actionable error instead of silently presenting an empty in-memory database as if it were the real data.

## Deploy

Install dependencies with `npm install`, then deploy the project root to Vercel. The API is served from `api/index.js`; public pages are in `public/`.

Check the API diagnostic endpoint at `/api/health` (not `/health`). Do not run real payments until the gateway keys and callback URLs have been verified.

## Security

Keep the repository private when `config.js` contains real credentials. Never commit a populated config file to a public repository. Rotate any key that was exposed publicly.
