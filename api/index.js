import express from 'express'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import crypto from 'node:crypto'

dotenv.config()

const app = express()
const BTZ_BASE_URL = new URL(process.env.BTZ_BASE_URL || 'https://web.btzpay.my.id').origin
const SITE_URL = String(process.env.SITE_URL || 'https://donate.khasan.site').replace(/\/+$/, '')
const BTZ_CALLBACK_URL = String(process.env.BTZ_CALLBACK_URL || `${SITE_URL}/api/paygate/callback`).replace(/\/+$/, '')
const BTZ_RETURN_URL = String(process.env.BTZ_RETURN_URL || `${SITE_URL}/success`).replace(/\/+$/, '')
const API_KEY = process.env.BTZ_API_KEY
const QRISGOPAY_API_KEY = process.env.BTZ_QRISGOPAY_API_KEY || process.env.QRISGOPAY_API_KEY || ''
const QRISDANA_API_KEY = process.env.BTZ_QRISDANA_API_KEY || process.env.QRISDANA_API_KEY || ''
const SHOPEEPAY_API_KEY = process.env.BTZ_SHOPEEPAY_API_KEY || process.env.SHOPEEPAY_API_KEY || ''
const SHOPEEPAY_ACCOUNT_NUMBER = process.env.BTZ_SHOPEEPAY_ACCOUNT_NUMBER || ''
const SHOPEEPAY_ACCOUNT_NAME = process.env.BTZ_SHOPEEPAY_ACCOUNT_NAME || ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
const parsePercent = (value, fallback) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : fallback }
const ANONYMOUS_FEE_PERCENT = parsePercent(process.env.ANONYMOUS_FEE_PERCENT ?? process.env.FEE_PERCENT ?? '0.7', 0.7)
const MEMBER_FEE_PERCENT = parsePercent(process.env.MEMBER_FEE_PERCENT ?? '0.3', 0.3)
const DONATION_FEE_ENABLED = String(process.env.DONATION_FEE_ENABLED ?? 'false').toLowerCase() === 'true'
const EARLY_SUPPORTER_CUTOFF = process.env.EARLY_SUPPORTER_CUTOFF || ''
const OTP_HASH_SECRET = process.env.OTP_HASH_SECRET || process.env.WASENDER_API_KEY || ''
const JSONBIN_ID = process.env.JSONBIN_ID || ''
const JSONBIN_KEY = process.env.JSONBIN_KEY || ''
const WASENDER_API_KEY = process.env.WASENDER_API_KEY || ''
const WASENDER_API_URL = process.env.WASENDER_API_URL || 'https://api.wasender.dev/messages/text'
const OTP_TTL_MS = 5 * 60 * 1000
const OTP_RESEND_MS = 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_FEE_PERCENT = MEMBER_FEE_PERCENT

app.use(express.json({ limit: '32kb' }))
app.set('trust proxy', 1)
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('Cache-Control', req.path.startsWith('/api/') ? 'no-store' : 'public, max-age=0, must-revalidate')
    next()
})

let storageWriteError = ''
let storageReadError = ''

let memoryStore = {
    goal: { title: 'Upgrade Server & Kopi Kaxel', target: 1000000 },
    history: [],
    notifications: [],
    comments: [],
    users: [],
    otpChallenges: [],
    chatMessages: [],
    notificationLogs: [],
    auditLogs: []
}

const loadDb = async () => {
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            const res = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}/latest`, {
                headers: { 'X-Master-Key': JSONBIN_KEY },
                signal: AbortSignal.timeout(8000)
            })
            if (!res.ok) {
                storageReadError = `JSONBin read HTTP ${res.status}`
                return memoryStore
            }
            const json = await res.json()
            if (json.record == null) { storageReadError = 'JSONBin response does not contain a record'; return memoryStore }
            if (Array.isArray(json.record)) {
                memoryStore.history = json.record
            } else if (json.record && typeof json.record === 'object' && json.record.history) {
                memoryStore = { ...memoryStore, ...json.record, notifications: json.record.notifications || [], comments: json.record.comments || [], users: json.record.users || [], otpChallenges: json.record.otpChallenges || [], chatMessages: json.record.chatMessages || [], notificationLogs: json.record.notificationLogs || [], auditLogs: json.record.auditLogs || [] }
            } else { storageReadError = 'JSONBin record does not contain expected history data'; return memoryStore }
            storageReadError = ''
        } catch (error) { storageReadError = String(error?.message || 'JSONBin read gagal').slice(0, 160) }
    }
    return memoryStore
}

const saveDb = async (data) => {
    memoryStore = data
    if (!JSONBIN_ID || !JSONBIN_KEY) {
        storageWriteError = 'JSONBin belum dikonfigurasi.'
        return false
    }
    if (storageReadError) return false
    try {
        const response = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-Master-Key': JSONBIN_KEY
            },
            body: JSON.stringify(memoryStore),
            signal: AbortSignal.timeout(8000)
        })
        if (!response.ok) {
            storageWriteError = `JSONBin write HTTP ${response.status}`
            return false
        }
        storageWriteError = ''
        return true
    } catch (error) {
        storageWriteError = String(error?.message || 'JSONBin write gagal').slice(0, 160)
        return false
    }
}

const persistBeforeSuccess = async (db, res, message = 'Data gagal disimpan. Periksa akses tulis JSONBin.') => {
    const persisted = await saveDb(db)
    if (process.env.VERCEL && !persisted) {
        res.status(503).json({ success: false, message })
        return false
    }
    return true
}

const databaseAvailable = (res) => {
    if (process.env.VERCEL && (!JSONBIN_ID || !JSONBIN_KEY || storageReadError)) {
        res.status(503).json({ success: false, message: 'JSONBin tidak siap dibaca. Periksa JSONBIN_ID, JSONBIN_KEY, dan akses penyimpanan.' })
        return false
    }
    return true
}

const getFee = (amount, percent = ANONYMOUS_FEE_PERCENT) => Math.round(Number(amount) * percent / 100)
const isPaid = status => ['success', 'sukses', 'paid', 'completed'].includes(String(status || '').toLowerCase())
const isRefunded = status => ['refund', 'refunded', 'chargeback', 'charge_back', 'charge-back'].includes(String(status || '').toLowerCase())
const isVerifiedMember = (db, trx) => {
    if (!trx?.userId || !trx?.registered) return null
    const user = (db.users || []).find(item => item.id === trx.userId && item.phone === trx.whatsapp && (item.whatsappVerifiedAt || item.createdAt))
    return user || null
}
const getMemberStats = (db, user) => {
    const paid = (db.history || []).filter(trx => trx.userId === user.id && isPaid(trx.status))
    const total = paid.reduce((sum, trx) => sum + Math.max(0, Number(trx.amount) || 0), 0)
    const levels = [
        { name: 'Bronze Supporter', min: 1, max: 99999 },
        { name: 'Silver Supporter', min: 100000, max: 499999 },
        { name: 'Gold Supporter', min: 500000, max: 1999999 },
        { name: 'Diamond Supporter', min: 2000000, max: Infinity }
    ]
    const levelIndex = levels.findIndex(item => total >= item.min && total <= item.max)
    const level = levelIndex >= 0 ? levels[levelIndex] : { name: 'New Supporter', min: 0, max: 0 }
    const next = levelIndex < 0 ? levels[0] : levels[levelIndex + 1] || null
    const months = new Set(paid.map(trx => { const date = new Date(trx.paidAt || trx.createdAt); return Number.isNaN(date.getTime()) ? '' : `${date.getUTCFullYear()}-${date.getUTCMonth()}` }).filter(Boolean))
    const badges = []
    if (paid.length) badges.push({ id: 'first-donation', name: 'First Donation', description: 'Donasi pertama berhasil.' })
    if (months.size >= 3) badges.push({ id: 'consistent-supporter', name: 'Consistent Supporter', description: 'Donasi pada tiga bulan berbeda.' })
    const nightDonation = paid.some(trx => { const date = new Date(trx.paidAt || trx.createdAt); if (Number.isNaN(date.getTime())) return false; const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Jakarta', hour: '2-digit', hourCycle: 'h23' }).format(date)); return hour >= 22 || hour < 5 })
    if (nightDonation) badges.push({ id: 'night-owl', name: 'Night Owl', description: 'Pernah berdonasi pada rentang malam.' })
    if (EARLY_SUPPORTER_CUTOFF && new Date(user.createdAt).getTime() <= new Date(EARLY_SUPPORTER_CUTOFF).getTime()) badges.push({ id: 'early-supporter', name: 'Early Supporter', description: 'Bergabung pada periode awal platform.' })
    return { total, successfulTransactions: paid.length, level: level.name, levelMin: level.min, nextLevel: next?.name || null, nextLevelMin: next?.min || null, progress: next ? Math.min(100, Math.max(0, Math.round(((total - (level.min || 0)) / Math.max(1, next.min - (level.min || 0))) * 100))) : 100, badges, feePercent: DONATION_FEE_ENABLED ? MEMBER_FEE_PERCENT : 0, feeEnabled: DONATION_FEE_ENABLED }
}
const hashOtp = (otp, salt) => crypto.scryptSync(`${OTP_HASH_SECRET || 'MISSING_OTP_HASH_SECRET'}:${otp}`, salt, 32).toString('hex')
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))
const formatCurrency = value => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(Number(value) || 0)
const renderInvoiceHtml = trx => `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Invoice ${escapeHtml(trx.invoiceNumber || trx.transactionId)}</title><style>body{font:16px Arial,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:24px}.invoice{max-width:700px;margin:auto;background:white;padding:32px;border:1px solid #cbd5e1;border-radius:18px}.brand{font-size:24px;font-weight:800;color:#2563eb}.line{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e2e8f0;padding:13px 0}.amount{font-size:26px;font-weight:800}.status{display:inline-block;background:#dbeafe;border-radius:8px;padding:6px 10px;overflow-wrap:anywhere}@media(max-width:520px){body{padding:10px}.invoice{padding:18px}.line{font-size:14px}}@media print{body{background:white;padding:0}.invoice{border:0}}</style></head><body><main class="invoice"><div class="brand">KAXEL DONASI</div><p>Bukti transaksi donasi berdasarkan data website</p><div class="line"><b>Nomor invoice</b><span>${escapeHtml(trx.invoiceNumber || `INV-${trx.transactionId}`)}</span></div><div class="line"><b>ID transaksi</b><span>${escapeHtml(trx.transactionId)}</span></div><div class="line"><b>Referensi gateway</b><span>${escapeHtml(trx.gatewayReference || trx.transactionId)}</span></div><div class="line"><b>Donatur</b><span>${escapeHtml(trx.userId ? (trx.publicName || trx.name || 'Donatur') : 'Anonim')}</span></div><div class="line"><b>Tanggal transaksi</b><span>${escapeHtml(new Date(trx.paidAt || trx.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}</span></div><div class="line"><b>Metode pembayaran</b><span>${escapeHtml(String(trx.paymentMethod || '').toUpperCase())}</span></div><div class="line"><b>Status pembayaran</b><span class="status">${escapeHtml(trx.status || 'pending')}</span></div><div class="line"><b>Nominal donasi</b><span>${escapeHtml(formatCurrency(trx.amount))}</span></div><div class="line"><b>Fee layanan</b><span>${escapeHtml(formatCurrency(trx.fee || 0))}</span></div><div class="line"><b>Total pembayaran</b><span class="amount">${escapeHtml(formatCurrency(trx.totalAmount ?? trx.amount))}</span></div><div class="line"><b>Pesan</b><span>${escapeHtml(trx.notes || '-')}</span></div><p style="color:#64748b;font-size:12px;margin-top:24px">Invoice ini dibuat dari data transaksi yang tersimpan di website. Gunakan fitur cetak browser untuk menyimpan sebagai PDF.</p><button onclick="window.print()">Cetak / Simpan PDF</button></main></body></html>`
const sendWhatsApp = async (to, body) => {
    if (!WASENDER_API_KEY || !to) throw new Error('WASENDER_API_KEY atau nomor WhatsApp belum dikonfigurasi.')
    const response = await fetch(WASENDER_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${WASENDER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: String(to).replace(/\D/g, ''), body }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.sent === false || result.success === false) throw new Error(result.message || 'Gateway WhatsApp gagal mengirim pesan.')
    return result
}
const getUserFromToken = (req, db) => { const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return token ? (db.users || []).find(user => user.token === token) : null }
const cleanPhone = value => String(value || '').replace(/\D/g, '')
const deliverMemberWhatsAppOnce = async (db, trx, eventKey, body) => {
    const user = isVerifiedMember(db, trx)
    if (!user || !WASENDER_API_KEY) return false
    db.notificationLogs = db.notificationLogs || []
    let log = db.notificationLogs.find(item => item.eventKey === eventKey)
    if (log?.status === 'sent' || (log?.status === 'pending' && Date.now() - Number(log.updatedAtMs || 0) < 30000) || (log?.status === 'failed' && (Number(log.attempts || 0) >= 5 || Date.now() - Number(log.updatedAtMs || 0) < 60000))) return false
    if (!log) { log = { id: crypto.randomUUID(), eventKey, transactionId: trx.transactionId, userId: user.id, type: eventKey.startsWith('invoice:') ? 'invoice' : 'status', to: user.phone, body, status: 'pending', attempts: 0, createdAt: new Date().toISOString(), updatedAtMs: Date.now() }; db.notificationLogs.push(log) }
    log.status = 'pending'; log.attempts = Number(log.attempts || 0) + 1; log.updatedAtMs = Date.now(); log.lastError = ''
    await saveDb(db)
    try { await sendWhatsApp(user.phone, body); log.status = 'sent'; log.sentAt = new Date().toISOString(); log.lastError = '' }
    catch (error) { log.status = 'failed'; log.lastError = String(error?.message || 'Gateway gagal').slice(0, 200) }
    log.updatedAtMs = Date.now()
    await saveDb(db)
    return log.status === 'sent'
}
const retryFailedMemberWhatsApp = async (db, transactionId) => {
    const logs = (db.notificationLogs || []).filter(item => item.transactionId === transactionId && item.status === 'failed' && Number(item.attempts || 0) < 5 && Date.now() - Number(item.updatedAtMs || 0) >= 60 * 1000)
    for (const log of logs) {
        const trx = (db.history || []).find(item => item.transactionId === transactionId)
        const user = trx && isVerifiedMember(db, trx)
        if (!user || user.phone !== log.to) continue
        await deliverMemberWhatsAppOnce(db, trx, log.eventKey, log.body)
    }
}
const processExpiredStatusMessages = async db => {
    let changed = false
    for (const trx of (db.history || [])) {
        const status = trx.pendingWhatsAppStatus
        if (!status) continue
        if (isVerifiedMember(db, trx)) {
            const body = `KAXEL DONATE - Status transaksi diperbarui\nInvoice: ${trx.invoiceNumber || `INV-${trx.transactionId}`}\nID transaksi: ${trx.transactionId}\nStatus: ${status}\nNominal donasi: Rp${Number(trx.amount || 0).toLocaleString('id-ID')}\nTransaksi belum berhasil dibayar dalam batas waktu.`
            await deliverMemberWhatsAppOnce(db, trx, `status:${trx.transactionId}:${String(status).toLowerCase()}`, body)
        }
        delete trx.pendingWhatsAppStatus
        changed = true
    }
    if (changed) await saveDb(db)
}


const normalizeExpiredTransactions = (db, exemptTransactionId = '') => {
    let changed = false
    const now = Date.now()
    for (const trx of db.history || []) {
        if (exemptTransactionId && String(trx.transactionId) === String(exemptTransactionId)) continue
        if (String(trx.status || '').toLowerCase() !== 'pending') continue
        const created = new Date(trx.createdAt || 0).getTime()
        const explicitExpiry = new Date(trx.expiredAt || 0).getTime()
        const expiry = Number.isFinite(explicitExpiry) && explicitExpiry > 0 ? explicitExpiry : created + 1200000
        if (now >= expiry || (created > 0 && now - created >= 1200000)) {
            trx.status = 'cancelled'
            trx.expiredAt = new Date(expiry).toISOString()
            trx.cancelledAt = new Date(now).toISOString()
            db.notifications = db.notifications || []
            const eventKey = `expired:${trx.transactionId}`
            if (!db.notifications.some(n => n.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${now}`, eventKey, transactionId: trx.transactionId, accessKey: trx.accessKey, type: 'payment', title: 'Transaksi dibatalkan', message: 'Batas pembayaran 20 menit telah habis. Transaksi otomatis dibatalkan.', createdAt: new Date(now).toISOString(), read: false })
            trx.pendingWhatsAppStatus = 'cancelled'
            changed = true
        }
    }
    return changed
}

app.get('/api/health', async (req, res) => {
    const startedAt = Date.now()
    const checks = [
        { id: 'api', label: 'API website', status: 'operational', detail: 'Endpoint API merespons.' },
        { id: 'qrisgopay', label: 'QRIS GoPay', status: 'maintenance', detail: 'Metode dinonaktifkan sementara sesuai konfigurasi.' },
        { id: 'qrisdana', label: 'QRIS DANA utama', status: QRISDANA_API_KEY ? 'configured' : 'error', detail: QRISDANA_API_KEY ? 'API key tersedia; transaksi nyata tetap memerlukan tes gateway.' : 'BTZ_QRISDANA_API_KEY belum diisi.' },
        { id: 'gateway', label: 'Betabotz Paygate', status: 'unknown', detail: 'Memeriksa konektivitas gateway…' },
        { id: 'storage', label: 'JSONBin storage', status: 'unknown', detail: 'Memeriksa koneksi penyimpanan…' },
        { id: 'whatsapp', label: 'WhatsApp OTP', status: WASENDER_API_KEY ? 'configured' : 'warning', detail: WASENDER_API_KEY ? 'Token tersedia; endpoint ini tidak mengirim pesan tes.' : 'WASENDER_API_KEY belum diisi; OTP dan notifikasi WhatsApp belum aktif.' },
        { id: 'callback', label: 'Callback URL', status: /^https:\/\//i.test(BTZ_CALLBACK_URL) ? 'configured' : 'error', detail: BTZ_CALLBACK_URL },
        { id: 'return', label: 'Return URL', status: /^https:\/\//i.test(BTZ_RETURN_URL) ? 'configured' : 'error', detail: BTZ_RETURN_URL },
        { id: 'otp-secret', label: 'OTP hash secret', status: OTP_HASH_SECRET ? 'configured' : 'warning', detail: OTP_HASH_SECRET ? 'Secret tersedia.' : 'OTP_HASH_SECRET belum diisi; set secret acak yang stabil di ENV.' }
    ]
    try {
        const response = await fetch(BTZ_BASE_URL, { method: 'GET', signal: AbortSignal.timeout(4000) })
        const gateway = checks.find(item => item.id === 'gateway')
        gateway.status = response.ok ? 'reachable' : 'warning'
        gateway.detail = `Host gateway merespons HTTP ${response.status}. Ini bukan uji pembuatan transaksi.`
    } catch {
        const gateway = checks.find(item => item.id === 'gateway')
        gateway.status = 'error'
        gateway.detail = 'Host gateway tidak dapat dijangkau dari fungsi server.'
    }
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            const response = await fetch(`https://api.jsonbin.io/v3/b/${encodeURIComponent(JSONBIN_ID)}/latest`, { headers: { 'X-Master-Key': JSONBIN_KEY }, signal: AbortSignal.timeout(4000) })
            const storage = checks.find(item => item.id === 'storage')
            const json = response.ok ? await response.json().catch(() => null) : null
            const validRecord = Boolean(json?.record && (Array.isArray(json.record) || (typeof json.record === 'object' && Array.isArray(json.record.history))) )
            if (response.ok && validRecord) storageReadError = ''
            else storageReadError = response.ok ? 'JSONBin record tidak sesuai struktur yang diharapkan' : `JSONBin read HTTP ${response.status}`
            storage.status = response.ok && validRecord ? (storageWriteError ? 'warning' : 'reachable') : 'error'
            storage.detail = response.ok && validRecord ? (storageWriteError ? `JSONBin dapat dibaca, tetapi penulisan terakhir bermasalah: ${storageWriteError}` : 'JSONBin dapat dibaca; health check tidak melakukan uji tulis.') : response.ok ? 'JSONBin merespons, tetapi record tidak memiliki struktur riwayat yang diharapkan.' : `JSONBin merespons HTTP ${response.status}; periksa JSONBIN_ID/JSONBIN_KEY.`
        } catch {
            storageReadError = 'JSONBin tidak dapat dijangkau dari fungsi server.'
            const storage = checks.find(item => item.id === 'storage')
            storage.status = 'error'
            storage.detail = 'JSONBin tidak dapat dijangkau dari fungsi server.'
        }
    } else {
        const storage = checks.find(item => item.id === 'storage')
        storage.status = 'error'
        storage.detail = 'JSONBIN_ID dan JSONBIN_KEY wajib diisi agar data persisten.'
    }
    const failure = checks.some(item => item.status === 'error' || item.status === 'down')
    const warning = checks.some(item => ['warning', 'unknown'].includes(item.status))
    res.json({ success: true, overall: failure || warning ? 'degraded' : 'operational', timestamp: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()), responseMs: Date.now() - startedAt, checks })
})

app.post('/api/paygate/callback', async (req, res) => {
    try {
        const payload = req.body || {}
        const id = String(payload.pay_id || payload.transactionId || payload.transaction_id || payload.id || payload.raw?.data?.transactionId || payload.raw?.data?.id || '').trim()
        if (!id) return res.status(400).json({ success: false, message: 'ID transaksi callback tidak ditemukan.' })
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const trx = (db.history || []).find(item => String(item.transactionId) === id)
        if (!trx || !trx.accessKey) return res.status(404).json({ success: false, message: 'Transaksi lokal tidak ditemukan.' })

        const verifiedResponse = await fetch(`${BTZ_BASE_URL}/api/qris/transaction/${encodeURIComponent(id)}?key=${encodeURIComponent(String(trx.accessKey))}`, { signal: AbortSignal.timeout(8000) })
        const verifiedJson = await verifiedResponse.json().catch(() => null)
        if (!verifiedResponse.ok || !verifiedJson?.success || !verifiedJson?.data) return res.status(502).json({ success: false, message: 'Callback belum dapat diverifikasi melalui gateway.' })

        const remote = verifiedJson.data
        const remoteId = String(remote.transactionId || remote.id || id)
        if (remoteId !== id) return res.status(409).json({ success: false, message: 'ID transaksi gateway tidak cocok.' })
        const remoteAmount = Number(remote.amount)
        if (Number.isFinite(remoteAmount) && remoteAmount > 0 && ![Number(trx.amount), Number(trx.totalAmount)].includes(remoteAmount)) return res.status(409).json({ success: false, message: 'Nominal transaksi gateway tidak cocok.' })
        const nextStatus = String(remote.status || '').toLowerCase()
        if (!nextStatus) return res.status(502).json({ success: false, message: 'Status transaksi tidak tersedia dari gateway.' })
        const previousStatus = String(trx.status || 'pending')
        const terminal = value => ['success', 'sukses', 'paid', 'completed', 'gagal', 'failed', 'expired', 'cancel', 'cancelled', 'canceled', 'refunded', 'refund', 'chargeback', 'charge_back', 'charge-back'].includes(String(value || '').toLowerCase())
        const preserveTerminalAgainstStalePending = terminal(previousStatus) && ['pending', 'processing', 'waiting'].includes(nextStatus)
        const finalStatus = preserveTerminalAgainstStalePending ? previousStatus : nextStatus
        const changed = finalStatus !== previousStatus
        trx.status = finalStatus
        if (isPaid(finalStatus)) {
            trx.paidAt = trx.paidAt || remote.paidAt || new Date().toISOString()
            if (!trx.userId) trx.earnedBadges = [...new Set([...(trx.earnedBadges || []), 'Anonymous Hero'])]
        }
        if (changed) {
            db.notifications = db.notifications || []
            const eventKey = `payment:${id}:${finalStatus}`
            if (!db.notifications.some(item => item.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: id, accessKey: trx.accessKey, type: 'payment', title: 'Status pembayaran diperbarui', message: `Status transaksi berubah dari ${previousStatus} menjadi ${finalStatus}.`, createdAt: new Date().toISOString(), read: false })
        }
        trx.callbackReceivedAt = new Date().toISOString()
        trx.callbackPayloadStatus = String(payload.status || payload.raw?.data?.status || '')
        const persisted = await saveDb(db)
        if (!JSONBIN_ID || !JSONBIN_KEY || !persisted) return res.status(503).json({ success: false, message: 'Callback belum tersimpan secara persisten. Periksa JSONBIN_ID dan JSONBIN_KEY; provider dapat mencoba lagi.' })

        if (isVerifiedMember(db, trx) && changed && ['success', 'sukses', 'paid', 'completed', 'gagal', 'failed', 'expired', 'cancel', 'cancelled', 'canceled'].includes(String(finalStatus).toLowerCase())) {
            const statusBody = `KAXEL DONATE - Status pembayaran diperbarui\nInvoice: ${trx.invoiceNumber || `INV-${id}`}\nID transaksi: ${id}\nStatus: ${finalStatus}\nNominal donasi: Rp${Number(trx.amount || 0).toLocaleString('id-ID')}\nTotal pembayaran: Rp${Number(trx.totalAmount || trx.amount || 0).toLocaleString('id-ID')}`
            await deliverMemberWhatsAppOnce(db, trx, `status:${id}:${String(finalStatus).toLowerCase()}`, statusBody)
        }
        if (isVerifiedMember(db, trx) && isPaid(finalStatus)) {
            await deliverMemberWhatsAppOnce(db, trx, `invoice:${id}:${String(finalStatus).toLowerCase()}`, `KAXEL DONATE - Invoice ${trx.invoiceNumber || `INV-${id}`}\nPembayaran sudah terverifikasi.\nNominal donasi: Rp${Number(trx.amount || 0).toLocaleString('id-ID')}\nTotal pembayaran: Rp${Number(trx.totalAmount || trx.amount || 0).toLocaleString('id-ID')}\nBuka dashboard member untuk melihat atau mencetak invoice.`)
        }
        res.status(200).json({ success: true, verified: true, transactionId: id, status: finalStatus })
    } catch {
        res.status(500).json({ success: false, message: 'Gagal memproses callback pembayaran.' })
    }
})

app.post('/api/auth/request-otp', async (req, res) => {
    try {
        if (!WASENDER_API_KEY || !OTP_HASH_SECRET) return res.status(503).json({ success: false, message: 'Registrasi OTP belum aktif. Isi WASENDER_API_KEY dan OTP_HASH_SECRET di Environment Variables.' })
        const phone = cleanPhone(req.body?.phone)
        const name = String(req.body?.name || '').trim().slice(0, 60)
        if (!name) return res.status(400).json({ success: false, message: 'Nama wajib diisi.' })
        if (phone.length < 8 || phone.length > 15) return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid.' })
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const now = Date.now()
        const challenges = db.otpChallenges || []
        const previous = challenges.find(x => x.phone === phone && now - x.createdAtMs < OTP_RESEND_MS)
        if (previous) return res.status(429).json({ success: false, message: 'Tunggu 60 detik sebelum meminta OTP lagi.' })
        db.otpRequestLog = db.otpRequestLog || []
        db.otpRequestLog = db.otpRequestLog.filter(x => now - x.createdAtMs < 60 * 60 * 1000)
        const recentPhoneRequests = db.otpRequestLog.filter(x => x.phone === phone).length
        const requestIp = String(req.ip || '').slice(0, 100)
        const recentIpRequests = db.otpRequestLog.filter(x => x.requestIp === requestIp).length
        if (recentPhoneRequests >= 5 || recentIpRequests >= 10) return res.status(429).json({ success: false, message: 'Batas permintaan OTP tercapai. Coba lagi nanti.' })
        const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
        const salt = crypto.randomBytes(16).toString('hex')
        const challenge = { id: crypto.randomUUID(), phone, name, salt, otpHash: hashOtp(otp, salt), requestIp, attempts: 0, createdAtMs: now, expiresAtMs: now + OTP_TTL_MS }
        db.otpChallenges = (db.otpChallenges || []).filter(x => x.expiresAtMs > now && x.phone !== phone)
        db.otpChallenges.push(challenge)
        db.otpRequestLog.push({ phone, requestIp, createdAtMs: now })
        const otpPersisted = await saveDb(db)
        if (process.env.VERCEL && !otpPersisted) return res.status(503).json({ success: false, message: 'Data OTP gagal tersimpan. Periksa akses tulis JSONBin sebelum mencoba lagi.' })
        try { await sendWhatsApp(phone, `Kode OTP Kaxel Support kamu: ${otp}\nBerlaku 5 menit. Jangan bagikan kode ini kepada siapa pun.`) }
        catch (e) { db.otpChallenges = db.otpChallenges.filter(x => x.id !== challenge.id); await saveDb(db); return res.status(502).json({ success: false, message: 'Gagal mengirim OTP WhatsApp. Periksa nomor, koneksi sesi Wasender, dan API key.' }) }
        res.json({ success: true, message: 'OTP dikirim ke WhatsApp kamu.', challengeId: challenge.id, expiresIn: 300 })
    } catch (e) { res.status(500).json({ success: false, message: 'Gagal meminta OTP.' }) }
})

app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const phone = cleanPhone(req.body?.phone)
        const challengeId = String(req.body?.challengeId || '')
        const otp = String(req.body?.otp || '').trim()
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const challenge = (db.otpChallenges || []).find(x => x.id === challengeId && x.phone === phone)
        if (!challenge) return res.status(400).json({ success: false, message: 'OTP tidak ditemukan. Minta kode baru.' })
        if (Date.now() > challenge.expiresAtMs) { db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId); await saveDb(db); return res.status(400).json({ success: false, message: 'OTP sudah kedaluwarsa.' }) }
        challenge.attempts = Number(challenge.attempts || 0) + 1
        if (!/^\d{6}$/.test(otp)) {
            if (challenge.attempts >= OTP_MAX_ATTEMPTS) db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId)
            await saveDb(db)
            return res.status(400).json({ success: false, message: challenge.attempts >= OTP_MAX_ATTEMPTS ? 'Batas percobaan habis. Minta OTP baru.' : 'Kode OTP harus terdiri dari 6 digit.' })
        }
        const otpHash = hashOtp(otp, challenge.salt || '')
        const hashMatches = /^[a-f0-9]{64}$/i.test(otpHash) && /^[a-f0-9]{64}$/i.test(String(challenge.otpHash || '')) && crypto.timingSafeEqual(Buffer.from(otpHash, 'hex'), Buffer.from(challenge.otpHash, 'hex'))
        if (challenge.attempts > OTP_MAX_ATTEMPTS || !hashMatches) { if (challenge.attempts >= OTP_MAX_ATTEMPTS) db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId); await saveDb(db); return res.status(400).json({ success: false, message: challenge.attempts >= OTP_MAX_ATTEMPTS ? 'Batas percobaan habis. Minta OTP baru.' : 'Kode OTP salah.' }) }
        let user = (db.users || []).find(x => x.phone === phone)
        if (!user) { user = { id: crypto.randomUUID(), phone, name: challenge.name, createdAt: new Date().toISOString(), whatsappVerifiedAt: new Date().toISOString(), showPublicIdentity: true, token: crypto.randomBytes(32).toString('hex') }; db.users.push(user) }
        else { user.name = challenge.name || user.name; user.whatsappVerifiedAt = new Date().toISOString(); user.token = crypto.randomBytes(32).toString('hex'); if (user.showPublicIdentity === undefined) user.showPublicIdentity = true }
        db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId)
        const userPersisted = await saveDb(db)
        if (process.env.VERCEL && !userPersisted) return res.status(503).json({ success: false, message: 'Akun gagal tersimpan. Periksa akses tulis JSONBin.' })
        res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone, showPublicIdentity: user.showPublicIdentity !== false }, token: user.token })
    } catch (e) { res.status(500).json({ success: false, message: 'Verifikasi OTP gagal.' }) }
})

app.get('/api/auth/me', async (req, res) => {
    const db = await loadDb(); if (!databaseAvailable(res)) return; const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Sesi login tidak valid.' })
    res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone, createdAt: user.createdAt, showPublicIdentity: user.showPublicIdentity !== false, whatsappVerified: Boolean(user.whatsappVerifiedAt || user.createdAt) } })
})

app.get('/api/member/dashboard', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const user = getUserFromToken(req, db)
    if (!user || !(user.whatsappVerifiedAt || user.createdAt)) return res.status(401).json({ success: false, message: 'Login member terverifikasi diperlukan.' })
    const stats = getMemberStats(db, user)
    const transactions = (db.history || []).filter(trx => trx.userId === user.id).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 50).map(trx => ({ transactionId: trx.transactionId, invoiceNumber: trx.invoiceNumber || `INV-${trx.transactionId}`, createdAt: trx.createdAt, amount: Number(trx.amount) || 0, fee: Number(trx.fee) || 0, totalAmount: Number(trx.totalAmount) || Number(trx.amount) || 0, paymentMethod: trx.paymentMethod || '', status: trx.status || 'pending', gatewayReference: trx.gatewayReference || trx.transactionId, notes: trx.notes || '', paidAt: trx.paidAt || null, expiredAt: trx.expiredAt || null, invoiceAvailable: isPaid(trx.status) }))
    res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone, createdAt: user.createdAt, showPublicIdentity: user.showPublicIdentity !== false, whatsappVerified: true }, stats, transactions })
})

app.post('/api/member/profile', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const user = getUserFromToken(req, db)
    if (!user || !(user.whatsappVerifiedAt || user.createdAt)) return res.status(401).json({ success: false, message: 'Login member terverifikasi diperlukan.' })
    if (typeof req.body?.showPublicIdentity !== 'boolean') return res.status(400).json({ success: false, message: 'Pilihan privasi tidak valid.' })
    user.showPublicIdentity = req.body.showPublicIdentity
    user.updatedAt = new Date().toISOString()
    for (const trx of db.history || []) if (trx.userId === user.id) trx.publicName = user.showPublicIdentity ? (trx.name || user.name) : 'Anonim'
    if (!(await persistBeforeSuccess(db, res, 'Pengaturan privasi belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true, showPublicIdentity: user.showPublicIdentity })
})

app.get('/api/member/invoice/:id', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const user = getUserFromToken(req, db)
    if (!user || !(user.whatsappVerifiedAt || user.createdAt)) return res.status(401).send('Login member terverifikasi diperlukan.')
    const trx = (db.history || []).find(item => item.transactionId === req.params.id && item.userId === user.id)
    if (!trx) return res.status(404).send('Transaksi tidak ditemukan.')
    if (!isPaid(trx.status)) return res.status(409).send('Invoice final tersedia setelah pembayaran terverifikasi.')
    res.type('html').send(renderInvoiceHtml(trx))
})

app.post('/api/user/chat', async (req, res) => {
    const db = await loadDb(); if (!databaseAvailable(res)) return; const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Login WhatsApp diperlukan untuk chat admin.' })
    const message = String(req.body?.message || '').trim()
    if (!message || message.length > 1000) return res.status(400).json({ success: false, message: 'Pesan wajib diisi dan maksimal 1000 karakter.' })
    const item = { id: crypto.randomUUID(), userId: user.id, phone: user.phone, name: user.name, sender: 'user', message, createdAt: new Date().toISOString(), read: false }
    db.chatMessages = db.chatMessages || []; db.chatMessages.push(item)
    if (!(await persistBeforeSuccess(db, res, 'Pesan chat belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true, message: item })
})

app.get('/api/user/chat', async (req, res) => {
    const db = await loadDb(); if (!databaseAvailable(res)) return; const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Login WhatsApp diperlukan.' })
    res.json({ success: true, messages: (db.chatMessages || []).filter(x => x.userId === user.id) })
})

app.get('/api/admin/chats', async (req, res) => {
    const adminAuth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!ADMIN_PASSWORD || adminAuth !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const db = await loadDb(); if (!databaseAvailable(res)) return; res.json({ success: true, messages: db.chatMessages || [], users: (db.users || []).map(({id,name,phone,createdAt}) => ({id,name,phone,createdAt})) })
})

app.post('/api/admin/chats/reply', async (req, res) => {
    const { password, userId, message } = req.body || {}
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Balasan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb(); if (!databaseAvailable(res)) return; const user = (db.users || []).find(x => x.id === userId)
    if (!user) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' })
    const item = { id: crypto.randomUUID(), userId, phone: user.phone, name: user.name, sender: 'admin', senderName: 'Admin Kaxel', message: text, createdAt: new Date().toISOString(), read: false }
    db.chatMessages = db.chatMessages || []; db.chatMessages.push(item)
    if (!(await persistBeforeSuccess(db, res, 'Pesan chat belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true, message: item })
})

app.post('/api/donate', async (req, res) => {
    try {
        const { name, amount, notes, emoji, whatsapp, paymentMethod = 'qris' } = req.body
        const selectedMethod = String(paymentMethod).toLowerCase()
        if (selectedMethod === 'qrisgopay') return res.status(503).json({ success: false, message: 'QRIS GoPay sedang maintenance. Silakan pilih QRIS DANA.' })
        if (!['qrisdana', 'qris', 'shopeepay'].includes(selectedMethod)) return res.status(400).json({ success: false, message: 'Metode pembayaran tidak tersedia.' })
        const selectedApiKey = selectedMethod === 'shopeepay' ? SHOPEEPAY_API_KEY : selectedMethod === 'qrisgopay' ? QRISGOPAY_API_KEY : selectedMethod === 'qrisdana' ? QRISDANA_API_KEY : API_KEY
        if (!selectedApiKey) {
            const message = selectedMethod === 'shopeepay'
                ? 'API key ShopeePay belum dipasang. Tambahkan BTZ_SHOPEEPAY_API_KEY di Environment Variables.'
                : selectedMethod === 'qrisgopay'
                    ? 'API key QRIS GoPay belum dipasang. Tambahkan BTZ_QRISGOPAY_API_KEY di Environment Variables.'
                    : selectedMethod === 'qrisdana'
                    ? 'API key QRISDANA belum dipasang. Tambahkan BTZ_QRISDANA_API_KEY atau QRISDANA_API_KEY di Environment Variables.'
                    : 'API Key QRIS belum dipasang di Environment Variables.'
            return res.status(500).json({ success: false, message })
        }
        if (selectedMethod === 'shopeepay' && (!SHOPEEPAY_ACCOUNT_NUMBER || !SHOPEEPAY_ACCOUNT_NAME)) return res.status(500).json({ success: false, message: 'Tujuan ShopeePay belum dikonfigurasi. Tambahkan BTZ_SHOPEEPAY_ACCOUNT_NUMBER dan BTZ_SHOPEEPAY_ACCOUNT_NAME di Environment Variables.' })
        const parsedAmount = parseInt(amount)

        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 2000) {
            return res.status(400).json({ success: false, message: 'Nominal minimal Rp2.000.' })
        }

        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const registeredUser = getUserFromToken(req, db)
        const senderName = registeredUser ? (registeredUser.name || 'Donatur') : 'Anonim'
        const trxNotes = notes?.trim() || 'Semangat terus Kaxel!'
        const chosenEmoji = emoji || 'support'
        const cleanWa = registeredUser ? registeredUser.phone : ''
        const configuredFeePercent = registeredUser ? OTP_FEE_PERCENT : ANONYMOUS_FEE_PERCENT
        const feePercent = DONATION_FEE_ENABLED ? configuredFeePercent : 0
        const feeAmount = DONATION_FEE_ENABLED ? getFee(parsedAmount, configuredFeePercent) : 0

        const createRes = await fetch(`${BTZ_BASE_URL}/api/qris/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apikey: selectedApiKey,
                amount: parsedAmount,
                fee: feeAmount,
                notes: trxNotes,
                timeout: 1200000,
                callback_url: BTZ_CALLBACK_URL,
                return_url: BTZ_RETURN_URL,
                metadata: {
                    orderId: `DONASI-${Date.now()}`,
                    sender: senderName
                },
                customerInfo: {
                    name: senderName,
                    email: '',
                    phone: cleanWa
                },
                ...(selectedMethod === 'shopeepay' ? {
                    accountNumber: SHOPEEPAY_ACCOUNT_NUMBER,
                    accountName: SHOPEEPAY_ACCOUNT_NAME
                } : {})
            })
        })

        const createJson = await createRes.json()

        if (!createJson.success || !createJson.data?.transactionId) {
            return res.status(400).json({ success: false, message: createJson.message || `Gagal membuat transaksi ${selectedMethod === 'shopeepay' ? 'ShopeePay' : selectedMethod === 'qrisdana' ? 'QRISDANA' : 'QRIS'}.` })
        }

        const trx = createJson.data
        let qrBase64 = ''

        if (['qris', 'qrisdana', 'qrisgopay'].includes(selectedMethod)) {
            if (!trx.qrisString) return res.status(400).json({ success: false, message: 'Gateway tidak mengembalikan data QRIS untuk transaksi ini.' })
            const qrRes = await fetch(`${BTZ_BASE_URL}/api/qris/create-qr-code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data: trx.qrisString, size: '500x500', style: '4', color: '0f1056', format: 'png', pngMode: 'styled', viewer: '0' })
            })
            if (!qrRes.ok) return res.status(500).json({ success: false, message: 'Gagal membuat gambar QR.' })
            const qrBuffer = await qrRes.arrayBuffer()
            qrBase64 = `data:image/png;base64,${Buffer.from(qrBuffer).toString('base64')}`
        } else if (!trx.paymentUrl) {
            return res.status(502).json({ success: false, message: 'Gateway tidak mengembalikan paymentUrl ShopeePay. Periksa konfigurasi payment method di Betabotz Paygate.' })
        }

        db.history.unshift({
            transactionId: trx.transactionId,
            accessKey: trx.accessKey,
            name: senderName,
            publicName: registeredUser && registeredUser.showPublicIdentity === false ? 'Anonim' : senderName,
            whatsapp: cleanWa,
            userId: registeredUser?.id || null,
            registered: Boolean(registeredUser && (registeredUser.whatsappVerifiedAt || registeredUser.createdAt)),
            whatsappVerifiedAt: registeredUser?.whatsappVerifiedAt || null,
            feePercent,
            configuredFeePercent,
            feePercentApplied: feePercent,
            feeEnabled: DONATION_FEE_ENABLED,
            amount: Number(trx.amount ?? parsedAmount),
            fee: Number(trx.fee ?? feeAmount),
            totalAmount: Number(trx.totalAmount ?? (parsedAmount + feeAmount)),
            invoiceNumber: `INV-${String(trx.transactionId).replace(/[^a-zA-Z0-9-]/g, '').slice(0, 48)}`,
            gatewayReference: trx.transactionId,
            paymentMethod: selectedMethod,
            paymentUrl: trx.paymentUrl || '',
            accountDetails: trx.accountDetails || {},
            notes: trxNotes,
            emoji: chosenEmoji,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiredAt: trx.expiredAt || new Date(Date.now() + 1200000).toISOString(),
            comments: [],
            paidAt: null
        })
        const trxPersisted = await saveDb(db)
        if (process.env.VERCEL && !trxPersisted) return res.status(503).json({ success: false, message: 'Transaksi gagal disimpan. Periksa JSONBIN_ID dan JSONBIN_KEY lalu coba lagi.' })
        const savedTrx = db.history[0]

        res.json({
            success: true,
            data: {
                transactionId: trx.transactionId,
                accessKey: trx.accessKey,
                name: senderName,
                amount: savedTrx.amount,
                fee: savedTrx.fee,
                totalAmount: savedTrx.totalAmount,
                paymentMethod: selectedMethod,
                paymentUrl: trx.paymentUrl || '',
                accountDetails: trx.accountDetails || {},
                expiredAt: trx.expiredAt || new Date(Date.now() + 1200000).toISOString(),
                notes: trxNotes,
                qrImage: qrBase64
            }
        })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Terjadi kesalahan pada server.' })
    }
})

app.get('/api/status/:id', async (req, res) => {
    try {
        const { id } = req.params
        const { key } = req.query
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const localTrx = (db.history || []).find(item => item.transactionId === id && item.accessKey === String(key || ''))
        if (!localTrx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
        const checkRes = await fetch(`${BTZ_BASE_URL}/api/qris/transaction/${encodeURIComponent(id)}?key=${encodeURIComponent(String(key || ''))}`, { signal: AbortSignal.timeout(8000) })
        const checkJson = await checkRes.json()

        if (checkJson.success && checkJson.data) {
            const gatewayTransactionId = String(checkJson.data.transactionId || checkJson.data.id || id)
            if (gatewayTransactionId !== id) return res.status(502).json({ success: false, message: 'Referensi transaksi gateway tidak cocok.' })
            const gatewayAmount = Number(checkJson.data.amount)
            if (Number.isFinite(gatewayAmount) && gatewayAmount > 0 && ![Number(localTrx.amount), Number(localTrx.totalAmount)].includes(gatewayAmount)) return res.status(502).json({ success: false, message: 'Nominal transaksi gateway tidak cocok dengan catatan website.' })
            const changedByExpiry = normalizeExpiredTransactions(db, isPaid(checkJson.data.status) ? id : '')
            if (changedByExpiry) {
                const expiryPersisted = await saveDb(db)
                if (process.env.VERCEL && !expiryPersisted) return res.status(503).json({ success: false, message: 'Status kedaluwarsa belum tersimpan ke JSONBin.' })
            }
            await processExpiredStatusMessages(db)
            const idx = db.history.findIndex(item => item.transactionId === id && item.accessKey === String(key || ''))
            if (idx !== -1 && ['cancelled', 'canceled', 'expired', 'cancel'].includes(String(db.history[idx].status).toLowerCase()) && !isPaid(checkJson.data.status)) {
                await retryFailedMemberWhatsApp(db, id)
                return res.json({ success: true, data: { ...checkJson.data, status: db.history[idx].status } })
            }
            if (idx !== -1 && db.history[idx].status === 'pending' && !isPaid(checkJson.data.status) && new Date(db.history[idx].expiredAt || new Date(new Date(db.history[idx].createdAt).getTime() + 1200000)).getTime() <= Date.now()) {
                db.history[idx].status = 'cancelled'
                const expiredPersisted = await saveDb(db)
                if (process.env.VERCEL && !expiredPersisted) return res.status(503).json({ success: false, message: 'Status kedaluwarsa belum tersimpan ke JSONBin.' })
                return res.json({ success: true, data: { ...checkJson.data, status: 'cancelled' } })
            }
            if (idx !== -1 && ((db.history[idx].status === 'pending' && db.history[idx].status !== checkJson.data.status) || (!isPaid(db.history[idx].status) && isPaid(checkJson.data.status)) || (isPaid(db.history[idx].status) && isRefunded(checkJson.data.status)))) {
                const previousStatus = db.history[idx].status
                db.history[idx].status = checkJson.data.status
                if (isPaid(checkJson.data.status)) { db.history[idx].paidAt = new Date().toISOString(); if (!db.history[idx].userId) db.history[idx].earnedBadges = [...new Set([...(db.history[idx].earnedBadges || []), 'Anonymous Hero'])] }
                const eventKey = `payment:${id}:${checkJson.data.status}`
                if (!db.notifications.some(n => n.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: id, accessKey: db.history[idx].accessKey, type: 'payment', title: 'Status pembayaran diperbarui', message: `Status transaksi berubah dari ${previousStatus} menjadi ${checkJson.data.status}.`, createdAt: new Date().toISOString(), read: false })
                const statusText = String(checkJson.data.status || 'pending')
                db.history[idx].lastNotifiedStatus = statusText
                const statusPersisted = await saveDb(db)
                if (process.env.VERCEL && !statusPersisted) return res.status(503).json({ success: false, message: 'Perubahan status belum tersimpan ke JSONBin.' })
                const savedTrx = db.history[idx]
                if (isVerifiedMember(db, savedTrx)) {
                    const statusBody = `KAXEL SUPPORT - Status transaksi donasi diperbarui\nInvoice: ${savedTrx.invoiceNumber || `INV-${id}`}\nID transaksi: ${id}\nStatus: ${statusText}\nNominal donasi: Rp${Number(savedTrx.amount || 0).toLocaleString('id-ID')}\nFee layanan: Rp${Number(savedTrx.fee || 0).toLocaleString('id-ID')}\nTotal pembayaran: Rp${Number(savedTrx.totalAmount || savedTrx.amount || 0).toLocaleString('id-ID')}\nMetode: ${String(savedTrx.paymentMethod || '').toUpperCase()}`
                    if (isPaid(statusText) || ['cancelled', 'canceled', 'cancel', 'expired'].includes(statusText.toLowerCase())) await deliverMemberWhatsAppOnce(db, savedTrx, `status:${id}:${statusText.toLowerCase()}`, statusBody)
                }
            }
            const settledTrx = db.history.find(item => item.transactionId === id && item.accessKey === String(key || ''))
            if (settledTrx && isPaid(settledTrx.status) && isVerifiedMember(db, settledTrx)) {
                const paidStatus = String(settledTrx.status).toLowerCase()
                const statusBody = `KAXEL SUPPORT - Status transaksi donasi diperbarui\nInvoice: ${settledTrx.invoiceNumber || `INV-${id}`}\nID transaksi: ${id}\nStatus: ${paidStatus}\nNominal donasi: Rp${Number(settledTrx.amount || 0).toLocaleString('id-ID')}\nFee layanan: Rp${Number(settledTrx.fee || 0).toLocaleString('id-ID')}\nTotal pembayaran: Rp${Number(settledTrx.totalAmount || settledTrx.amount || 0).toLocaleString('id-ID')}`
                await deliverMemberWhatsAppOnce(db, settledTrx, `status:${id}:${paidStatus}`, statusBody)
            }
        }

        const latestDb = await loadDb()
        if (!databaseAvailable(res)) return
        await retryFailedMemberWhatsApp(latestDb, id)
        res.json(checkJson)
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengecek status.' })
    }
})

app.post('/api/cancel/:id', async (req, res) => {
    try {
        const { id } = req.params
        const suppliedKey = String(req.body?.key || req.query.key || '')
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        const existingTrx = db.history.find(item => item.transactionId === id && item.accessKey === suppliedKey)
        if (!existingTrx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' })
        const cancelApiKey = existingTrx.paymentMethod === 'shopeepay' ? SHOPEEPAY_API_KEY : existingTrx.paymentMethod === 'qrisgopay' ? QRISGOPAY_API_KEY : existingTrx.paymentMethod === 'qrisdana' ? QRISDANA_API_KEY : API_KEY
        if (!cancelApiKey) return res.status(500).json({ success: false, message: 'API key untuk metode pembayaran ini belum dipasang.' })
        const cancelRes = await fetch(`${BTZ_BASE_URL}/api/qris/cancel/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apikey: cancelApiKey, reason: 'cancelled_by_user' })
        })
        const cancelJson = await cancelRes.json()

        const idx = db.history.findIndex(item => item.transactionId === id)
        if (idx !== -1 && cancelJson.success) {
            db.history[idx].status = cancelJson.data?.status || 'cancel'
            const cancelledStatus = String(db.history[idx].status)
            const eventKey = `payment:${id}:${cancelledStatus}`
            db.notifications = db.notifications || []
            if (!db.notifications.some(n => n.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: id, accessKey: db.history[idx].accessKey, type: 'payment', title: 'Transaksi dibatalkan', message: `Transaksi ${id} dibatalkan.`, createdAt: new Date().toISOString(), read: false })
            const cancelPersisted = await saveDb(db)
            if (process.env.VERCEL && !cancelPersisted) return res.status(503).json({ success: false, message: 'Pembatalan dari gateway diterima tetapi belum tersimpan ke JSONBin.' })
            const cancelledTrx = db.history[idx]
            if (isVerifiedMember(db, cancelledTrx)) {
                const statusBody = `KAXEL SUPPORT - Status transaksi donasi diperbarui\nInvoice: ${cancelledTrx.invoiceNumber || `INV-${id}`}\nID transaksi: ${id}\nStatus: ${cancelledStatus}\nNominal donasi: Rp${Number(cancelledTrx.amount || 0).toLocaleString('id-ID')}`
                await deliverMemberWhatsAppOnce(db, cancelledTrx, `status:${id}:${cancelledStatus.toLowerCase()}`, statusBody)
            }
        }

        res.status(cancelRes.status).json(cancelJson)
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal membatalkan transaksi.' })
    }
})

app.get('/api/notifications/:id', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const trx = db.history.find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    const notifications = (db.notifications || []).filter(n => n.transactionId === trx.transactionId).map(({ accessKey, ...n }) => n)
    res.json({ success: true, notifications })
})

app.post('/api/notifications/read', async (req, res) => {
    const { transactionId, key, notificationId } = req.body || {}
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const trx = db.history.find(item => item.transactionId === transactionId && item.accessKey === String(key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    for (const item of db.notifications || []) if (item.transactionId === transactionId && (!notificationId || item.id === notificationId)) item.read = true
    if (!(await persistBeforeSuccess(db, res, 'Status notifikasi belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true })
})

app.post('/api/comments', async (req, res) => {
    const { transactionId, key, message } = req.body || {}
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Pesan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    normalizeExpiredTransactions(db)
    const trx = db.history.find(item => item.transactionId === transactionId && item.accessKey === String(key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    const comment = { id: `MSG-${Date.now()}`, transactionId, sender: 'donor', senderName: trx.userId ? (trx.publicName || trx.name || 'Donatur') : 'Anonim', message: text, createdAt: new Date().toISOString(), replies: [] }
    db.comments = db.comments || []
    db.comments.push(comment)
    db.notifications = db.notifications || []
    db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey: `donor-message:${comment.id}`, transactionId, accessKey: trx.accessKey, type: 'message', title: 'Pesan baru dari donatur', message: text, createdAt: comment.createdAt, read: false })
    trx.comments = trx.comments || []
    trx.comments.push(comment.id)
    if (!(await persistBeforeSuccess(db, res, 'Komentar belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true, comment })
})

app.get('/api/comments/:id', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const trx = db.history.find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    const comments = (db.comments || []).filter(c => c.transactionId === trx.transactionId).map(c => c.sender === 'donor' ? { ...c, senderName: trx.userId ? (trx.publicName || trx.name || 'Donatur') : 'Anonim' } : c)
    res.json({ success: true, comments })
})

app.post('/api/admin/reply', async (req, res) => {
    const { password, commentId, message } = req.body || {}
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Balasan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const comment = (db.comments || []).find(c => c.id === commentId)
    if (!comment) return res.status(404).json({ success: false, message: 'Komentar tidak ditemukan.' })
    comment.replies = comment.replies || []
    const reply = { id: `RPL-${Date.now()}`, sender: 'admin', senderName: 'Admin Kaxel', message: text, createdAt: new Date().toISOString() }
    comment.replies.push(reply)
    db.notifications = db.notifications || []
    const eventKey = `reply:${comment.id}:${reply.id}`
    db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: comment.transactionId, accessKey: (db.history.find(h => h.transactionId === comment.transactionId) || {}).accessKey, type: 'reply', title: 'Admin membalas pesan Anda', message: text, createdAt: reply.createdAt, read: false })
    if (!(await persistBeforeSuccess(db, res, 'Balasan admin belum tersimpan. Periksa JSONBin.'))) return
    res.json({ success: true, reply })
})

app.get('/api/admin/comments', async (req, res) => {
    const password = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    res.json({ success: true, comments: db.comments || [] })
})

app.get('/api/invoice/:id', async (req, res) => {
    const db = await loadDb()
        if (!databaseAvailable(res)) return
    const trx = (db.history || []).find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).send('Akses invoice tidak valid.')
    if (!isPaid(trx.status)) return res.status(409).send('Invoice final tersedia setelah pembayaran terverifikasi.')
    res.type('html').send(renderInvoiceHtml(trx))
})

app.get('/api/public-config', (req, res) => {
    res.json({ success: true, fees: { enabled: DONATION_FEE_ENABLED, memberPercent: MEMBER_FEE_PERCENT, anonymousPercent: ANONYMOUS_FEE_PERCENT }, paymentMethods: { qrisgopay: { enabled: false, status: 'maintenance' }, qrisdana: { enabled: Boolean(QRISDANA_API_KEY), status: QRISDANA_API_KEY ? 'available' : 'unconfigured' }, qris: { enabled: Boolean(API_KEY), status: API_KEY ? 'available' : 'unconfigured' }, shopeepay: { enabled: Boolean(SHOPEEPAY_API_KEY && SHOPEEPAY_ACCOUNT_NUMBER && SHOPEEPAY_ACCOUNT_NAME), status: SHOPEEPAY_API_KEY && SHOPEEPAY_ACCOUNT_NUMBER && SHOPEEPAY_ACCOUNT_NAME ? 'available' : 'unconfigured' } } })
})

app.get('/api/public-stats', async (req, res) => {
    try {
        const db = await loadDb()
        if (!databaseAvailable(res)) return
        if (normalizeExpiredTransactions(db) && !(await persistBeforeSuccess(db, res, 'Pembaruan status kedaluwarsa gagal tersimpan.'))) return
        await processExpiredStatusMessages(db)
        const successList = db.history.filter(h => isPaid(h.status))
        const currentRaised = successList.reduce((acc, cur) => acc + Math.max(0, Number(cur.amount) || 0), 0)

        const now = Date.now()
        const recent = successList
            .filter(h => {
                const paidAt = new Date(h.paidAt || h.createdAt || 0).getTime()
                return Number.isFinite(paidAt) && paidAt > 0 && paidAt <= now && now - paidAt < 24 * 60 * 60 * 1000
            })
            .sort((a, b) => new Date(b.paidAt || b.createdAt || 0).getTime() - new Date(a.paidAt || a.createdAt || 0).getTime())
            .slice(0, 10)
            .map(h => ({
                name: !h.userId ? 'Anonim' : (h.publicName || h.name || 'Anonim'),
                amount: h.amount,
                notes: h.notes,
                emoji: h.emoji,
                paidAt: h.paidAt || h.createdAt
            }))

        const mapTop = {}
        successList.forEach(h => {
            const publicName = !h.userId ? 'Anonim' : (h.publicName || h.name || 'Anonim')
            const key = publicName.toLowerCase()
            if (!mapTop[key]) {
                mapTop[key] = { name: publicName, total: 0, count: 0 }
            }
            mapTop[key].total += Number(h.amount)
            mapTop[key].count += 1
        })

        const leaderboard = Object.values(mapTop)
            .sort((a, b) => b.total - a.total)
            

        const transactions = [...db.history]
            .sort((a, b) => new Date(b.createdAt || b.paidAt || 0).getTime() - new Date(a.createdAt || a.paidAt || 0).getTime())
            .slice(0, 15)
            .map(h => ({
                transactionId: h.transactionId || h.id || '',
                name: !h.userId ? 'Anonim' : (h.publicName || h.name || 'Anonim'),
                amount: Number(h.amount) || 0,
                notes: h.notes || '',
                emoji: h.emoji || 'support',
                status: h.status || 'pending',
                badges: Array.isArray(h.earnedBadges) ? h.earnedBadges : [],
                paymentMethod: h.paymentMethod || h.method || '',
                createdAt: h.createdAt || null,
                paidAt: h.paidAt || null
            }))

        res.json({
            success: true,
            goal: {
                title: db.goal?.title || 'Target Donasi Kaxel',
                target: db.goal?.target || 1000000,
                current: currentRaised
            },
            recent,
            leaderboard,
            transactions
        })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memuat statistik donasi.' })
    }
})

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { password } = req.body
        if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' })
        }

        const db = await loadDb()
        if (!databaseAvailable(res)) return
        if (normalizeExpiredTransactions(db) && !(await persistBeforeSuccess(db, res, 'Pembaruan status kedaluwarsa gagal tersimpan.'))) return
        await processExpiredStatusMessages(db)
        const successList = db.history.filter(h => isPaid(h.status))
        const pendingList = db.history.filter(h => h.status === 'pending')
        const totalRevenue = successList.reduce((acc, cur) => acc + Math.max(0, Number(cur.amount) || 0), 0)

        res.json({
            success: true,
            goal: db.goal,
            stats: {
                totalRevenue,
                totalSuccess: successList.length,
                totalPending: pendingList.length,
                totalTransactions: db.history.length
            },
            history: db.history
        })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal memuat data admin.' })
    }
})

app.post('/api/admin/goal', async (req, res) => {
    try {
        const { password, title, target } = req.body
        if (!ADMIN_PASSWORD || password !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' })
        }

        const db = await loadDb()
        if (!databaseAvailable(res)) return
        db.goal = {
            title: title?.trim() || 'Target Donasi Kaxel',
            target: Math.max(10000, parseInt(target) || 1000000)
        }
        if (!(await persistBeforeSuccess(db, res, 'Target donasi belum tersimpan. Periksa JSONBin.'))) return

        res.json({ success: true, goal: db.goal })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengubah target donasi.' })
    }
})

if (!process.env.VERCEL && process.argv[1] && process.argv[1].endsWith('api/index.js')) {
    const port = Number(process.env.PORT || 3000)
    app.listen(port, () => console.log(`Kaxel Donate API aktif di port ${port}`))
}

export default app
