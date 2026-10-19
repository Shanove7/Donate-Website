import express from 'express'
import fetch from 'node-fetch'
import dotenv from 'dotenv'
import crypto from 'node:crypto'

dotenv.config()

const app = express()
const BTZ_BASE_URL = new URL('https://web.btzpay.my.id').origin
const API_KEY = process.env.BTZ_API_KEY
const QRISDANA_API_KEY = process.env.BTZ_QRISDANA_API_KEY || process.env.QRISDANA_API_KEY || ''
const SHOPEEPAY_API_KEY = process.env.BTZ_SHOPEEPAY_API_KEY || process.env.SHOPEEPAY_API_KEY || ''
const SHOPEEPAY_ACCOUNT_NUMBER = process.env.BTZ_SHOPEEPAY_ACCOUNT_NUMBER || ''
const SHOPEEPAY_ACCOUNT_NAME = process.env.BTZ_SHOPEEPAY_ACCOUNT_NAME || ''
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT || '0.7')
const JSONBIN_ID = process.env.JSONBIN_ID || ''
const JSONBIN_KEY = process.env.JSONBIN_KEY || ''
const WASENDER_API_KEY = process.env.WASENDER_API_KEY || ''
const WASENDER_API_URL = process.env.WASENDER_API_URL || 'https://api.wasender.dev/messages/text'
const OTP_TTL_MS = 5 * 60 * 1000
const OTP_RESEND_MS = 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_FEE_PERCENT = 0.3

app.use(express.json())

let memoryStore = {
    goal: { title: 'Upgrade Server & Kopi Kaxel', target: 1000000 },
    history: [],
    notifications: [],
    comments: [],
    users: [],
    otpChallenges: [],
    chatMessages: []
}

const loadDb = async () => {
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            const res = await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}/latest`, {
                headers: { 'X-Master-Key': JSONBIN_KEY }
            })
            const json = await res.json()
            if (json.record) {
                if (Array.isArray(json.record)) {
                    memoryStore.history = json.record
                } else if (json.record.history) {
                    memoryStore = { ...memoryStore, ...json.record, notifications: json.record.notifications || [], comments: json.record.comments || [], users: json.record.users || [], otpChallenges: json.record.otpChallenges || [], chatMessages: json.record.chatMessages || [] }
                }
            }
        } catch (e) {}
    }
    return memoryStore
}

const saveDb = async (data) => {
    memoryStore = data
    if (JSONBIN_ID && JSONBIN_KEY) {
        try {
            await fetch(`https://api.jsonbin.io/v3/b/${JSONBIN_ID}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Master-Key': JSONBIN_KEY
                },
                body: JSON.stringify(memoryStore)
            })
        } catch (e) {}
    }
}

const getFee = (amount, percent = FEE_PERCENT) => Math.round(Number(amount) * percent / 100)
const sendWhatsApp = async (to, body) => {
    if (!WASENDER_API_KEY || !to) throw new Error('WASENDER_API_KEY atau nomor WhatsApp belum dikonfigurasi.')
    const response = await fetch(WASENDER_API_URL, { method: 'POST', headers: { Authorization: `Bearer ${WASENDER_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ to: String(to).replace(/\D/g, ''), body }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok || result.sent === false || result.success === false) throw new Error(result.message || 'Gateway WhatsApp gagal mengirim pesan.')
    return result
}
const getUserFromToken = (req, db) => { const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''); return token ? (db.users || []).find(user => user.token === token) : null }
const cleanPhone = value => String(value || '').replace(/\D/g, '')

const normalizeExpiredTransactions = (db) => {
    let changed = false
    const now = Date.now()
    for (const trx of db.history || []) {
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
            if (trx.registered && trx.whatsapp && trx.lastNotifiedStatus !== 'cancelled') {
                sendWhatsApp(trx.whatsapp, `KAXEL SUPPORT - Informasi transaksi donasi\nID: ${trx.transactionId}\nStatus: cancelled\nAlasan: batas pembayaran 20 menit habis.`).catch(() => {})
                trx.lastNotifiedStatus = 'cancelled'
            }
            changed = true
        }
    }
    return changed
}

app.post('/api/auth/request-otp', async (req, res) => {
    try {
        if (!WASENDER_API_KEY) return res.status(503).json({ success: false, message: 'Registrasi OTP belum aktif. Admin perlu mengisi WASENDER_API_KEY di ENV.' })
        const phone = cleanPhone(req.body?.phone)
        const name = String(req.body?.name || '').trim().slice(0, 60)
        if (!name) return res.status(400).json({ success: false, message: 'Nama wajib diisi.' })
        if (phone.length < 8 || phone.length > 15) return res.status(400).json({ success: false, message: 'Nomor WhatsApp tidak valid.' })
        const db = await loadDb()
        const now = Date.now()
        const previous = (db.otpChallenges || []).find(x => x.phone === phone && now - x.createdAtMs < OTP_RESEND_MS)
        if (previous) return res.status(429).json({ success: false, message: 'Tunggu 60 detik sebelum meminta OTP lagi.' })
        const otp = String(crypto.randomInt(0, 1000000)).padStart(6, '0')
        const challenge = { id: crypto.randomUUID(), phone, name, otpHash: crypto.createHash('sha256').update(otp).digest('hex'), attempts: 0, createdAtMs: now, expiresAtMs: now + OTP_TTL_MS }
        db.otpChallenges = (db.otpChallenges || []).filter(x => x.expiresAtMs > now && x.phone !== phone)
        db.otpChallenges.push(challenge)
        await saveDb(db)
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
        const challenge = (db.otpChallenges || []).find(x => x.id === challengeId && x.phone === phone)
        if (!challenge) return res.status(400).json({ success: false, message: 'OTP tidak ditemukan. Minta kode baru.' })
        if (Date.now() > challenge.expiresAtMs) { db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId); await saveDb(db); return res.status(400).json({ success: false, message: 'OTP sudah kedaluwarsa.' }) }
        challenge.attempts = Number(challenge.attempts || 0) + 1
        const otpHash = crypto.createHash('sha256').update(otp).digest('hex')
        if (challenge.attempts > OTP_MAX_ATTEMPTS || otpHash !== challenge.otpHash) { if (challenge.attempts >= OTP_MAX_ATTEMPTS) db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId); await saveDb(db); return res.status(400).json({ success: false, message: challenge.attempts >= OTP_MAX_ATTEMPTS ? 'Batas percobaan habis. Minta OTP baru.' : 'Kode OTP salah.' }) }
        let user = (db.users || []).find(x => x.phone === phone)
        if (!user) { user = { id: crypto.randomUUID(), phone, name: challenge.name, createdAt: new Date().toISOString(), token: crypto.randomBytes(32).toString('hex') }; db.users.push(user) }
        else { user.name = challenge.name || user.name; user.token = crypto.randomBytes(32).toString('hex') }
        db.otpChallenges = db.otpChallenges.filter(x => x.id !== challengeId)
        await saveDb(db)
        res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone }, token: user.token })
    } catch (e) { res.status(500).json({ success: false, message: 'Verifikasi OTP gagal.' }) }
})

app.get('/api/auth/me', async (req, res) => {
    const db = await loadDb(); const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Sesi login tidak valid.' })
    res.json({ success: true, user: { id: user.id, name: user.name, phone: user.phone } })
})

app.post('/api/user/chat', async (req, res) => {
    const db = await loadDb(); const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Login WhatsApp diperlukan untuk chat admin.' })
    const message = String(req.body?.message || '').trim()
    if (!message || message.length > 1000) return res.status(400).json({ success: false, message: 'Pesan wajib diisi dan maksimal 1000 karakter.' })
    const item = { id: crypto.randomUUID(), userId: user.id, phone: user.phone, name: user.name, sender: 'user', message, createdAt: new Date().toISOString(), read: false }
    db.chatMessages = db.chatMessages || []; db.chatMessages.push(item); await saveDb(db)
    res.json({ success: true, message: item })
})

app.get('/api/user/chat', async (req, res) => {
    const db = await loadDb(); const user = getUserFromToken(req, db)
    if (!user) return res.status(401).json({ success: false, message: 'Login WhatsApp diperlukan.' })
    res.json({ success: true, messages: (db.chatMessages || []).filter(x => x.userId === user.id) })
})

app.get('/api/admin/chats', async (req, res) => {
    if (String(req.query.password || '') !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const db = await loadDb(); res.json({ success: true, messages: db.chatMessages || [], users: (db.users || []).map(({id,name,phone,createdAt}) => ({id,name,phone,createdAt})) })
})

app.post('/api/admin/chats/reply', async (req, res) => {
    const { password, userId, message } = req.body || {}
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Balasan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb(); const user = (db.users || []).find(x => x.id === userId)
    if (!user) return res.status(404).json({ success: false, message: 'Pengguna tidak ditemukan.' })
    const item = { id: crypto.randomUUID(), userId, phone: user.phone, name: user.name, sender: 'admin', senderName: 'Admin Kaxel', message: text, createdAt: new Date().toISOString(), read: false }
    db.chatMessages = db.chatMessages || []; db.chatMessages.push(item); await saveDb(db)
    res.json({ success: true, message: item })
})

app.post('/api/donate', async (req, res) => {
    try {
        const { name, amount, notes, emoji, whatsapp, paymentMethod = 'qris' } = req.body
        const selectedMethod = String(paymentMethod).toLowerCase()
        if (!['qrisdana', 'qris', 'shopeepay'].includes(selectedMethod)) return res.status(400).json({ success: false, message: 'Metode pembayaran tidak tersedia.' })
        const selectedApiKey = selectedMethod === 'shopeepay' ? SHOPEEPAY_API_KEY : selectedMethod === 'qrisdana' ? QRISDANA_API_KEY : API_KEY
        if (!selectedApiKey) {
            const message = selectedMethod === 'shopeepay'
                ? 'API key ShopeePay belum dipasang. Tambahkan BTZ_SHOPEEPAY_API_KEY di Environment Variables.'
                : selectedMethod === 'qrisdana'
                    ? 'API key QRISDANA belum dipasang. Tambahkan BTZ_QRISDANA_API_KEY atau QRISDANA_API_KEY di Environment Variables.'
                    : 'API Key QRIS belum dipasang di Environment Variables.'
            return res.status(500).json({ success: false, message })
        }
        if (selectedMethod === 'shopeepay' && (!SHOPEEPAY_ACCOUNT_NUMBER || !SHOPEEPAY_ACCOUNT_NAME)) return res.status(500).json({ success: false, message: 'Tujuan ShopeePay belum dikonfigurasi. Tambahkan BTZ_SHOPEEPAY_ACCOUNT_NUMBER dan BTZ_SHOPEEPAY_ACCOUNT_NAME di Environment Variables.' })
        const parsedAmount = parseInt(amount)

        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 100) {
            return res.status(400).json({ success: false, message: 'Nominal minimal Rp100.' })
        }

        const db = await loadDb()
        const registeredUser = getUserFromToken(req, db)
        const senderName = registeredUser ? (registeredUser.name || name?.trim() || 'Donatur') : 'Anonim'
        const trxNotes = notes?.trim() || 'Semangat terus Kaxel!'
        const chosenEmoji = emoji || 'support'
        const cleanWa = registeredUser ? registeredUser.phone : ''
        const feePercent = registeredUser ? OTP_FEE_PERCENT : FEE_PERCENT

        const createRes = await fetch(`${BTZ_BASE_URL}/api/qris/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apikey: selectedApiKey,
                amount: parsedAmount,
                fee: getFee(parsedAmount, feePercent),
                notes: trxNotes,
                timeout: 1200000,
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

        if (selectedMethod === 'qris' || selectedMethod === 'qrisdana') {
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
            whatsapp: cleanWa,
            userId: registeredUser?.id || null,
            registered: Boolean(registeredUser),
            feePercent,
            amount: trx.amount,
            fee: trx.fee,
            totalAmount: trx.totalAmount,
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
        await saveDb(db)

        res.json({
            success: true,
            data: {
                transactionId: trx.transactionId,
                accessKey: trx.accessKey,
                name: senderName,
                amount: trx.amount,
                fee: trx.fee,
                totalAmount: trx.totalAmount,
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

        const checkRes = await fetch(`${BTZ_BASE_URL}/api/qris/transaction/${id}?key=${key}`)
        const checkJson = await checkRes.json()

        if (checkJson.success && checkJson.data) {
            const db = await loadDb()
            const changedByExpiry = normalizeExpiredTransactions(db)
            if (changedByExpiry) await saveDb(db)
            const idx = db.history.findIndex(item => item.transactionId === id)
            if (idx !== -1 && ['cancelled', 'canceled', 'expired', 'cancel'].includes(String(db.history[idx].status).toLowerCase())) {
                return res.json({ success: true, data: { ...checkJson.data, status: db.history[idx].status } })
            }
            if (idx !== -1 && db.history[idx].status === 'pending' && new Date(db.history[idx].expiredAt || new Date(new Date(db.history[idx].createdAt).getTime() + 1200000)).getTime() <= Date.now()) {
                db.history[idx].status = 'cancelled'
                await saveDb(db)
                return res.json({ success: true, data: { ...checkJson.data, status: 'cancelled' } })
            }
            if (idx !== -1 && db.history[idx].status === 'pending' && db.history[idx].status !== checkJson.data.status) {
                const previousStatus = db.history[idx].status
                db.history[idx].status = checkJson.data.status
                if (checkJson.data.status === 'sukses' || checkJson.data.status === 'success') db.history[idx].paidAt = new Date().toISOString()
                const eventKey = `payment:${id}:${checkJson.data.status}`
                if (!db.notifications.some(n => n.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: id, accessKey: db.history[idx].accessKey, type: 'payment', title: 'Status pembayaran diperbarui', message: `Status transaksi berubah dari ${previousStatus} menjadi ${checkJson.data.status}.`, createdAt: new Date().toISOString(), read: false })
                if (db.history[idx].registered && db.history[idx].whatsapp && db.history[idx].lastNotifiedStatus !== checkJson.data.status) {
                    const statusText = String(checkJson.data.status || 'pending')
                    sendWhatsApp(db.history[idx].whatsapp, `KAXEL SUPPORT - Informasi transaksi donasi\nID: ${id}\nStatus: ${statusText}\nNominal: Rp${Number(db.history[idx].amount || 0).toLocaleString('id-ID')}\nTerima kasih telah mendukung kami.`).then(() => {}).catch(() => {})
                    db.history[idx].lastNotifiedStatus = statusText
                }
                await saveDb(db)
            }
        }

        res.json(checkJson)
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengecek status.' })
    }
})

app.post('/api/cancel/:id', async (req, res) => {
    try {
        const { id } = req.params
        const db = await loadDb()
        const existingTrx = db.history.find(item => item.transactionId === id)
        if (!existingTrx) return res.status(404).json({ success: false, message: 'Transaksi tidak ditemukan.' })
        const cancelApiKey = existingTrx.paymentMethod === 'shopeepay' ? SHOPEEPAY_API_KEY : existingTrx.paymentMethod === 'qrisdana' ? QRISDANA_API_KEY : API_KEY
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
            if (db.history[idx].registered && db.history[idx].whatsapp && db.history[idx].lastNotifiedStatus !== cancelledStatus) {
                sendWhatsApp(db.history[idx].whatsapp, `KAXEL SUPPORT - Informasi transaksi donasi\nID: ${id}\nStatus: ${cancelledStatus}\nNominal: Rp${Number(db.history[idx].amount || 0).toLocaleString('id-ID')}`).catch(() => {})
                db.history[idx].lastNotifiedStatus = cancelledStatus
            }
            const eventKey = `payment:${id}:${cancelledStatus}`
            db.notifications = db.notifications || []
            if (!db.notifications.some(n => n.eventKey === eventKey)) db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: id, accessKey: db.history[idx].accessKey, type: 'payment', title: 'Transaksi dibatalkan', message: `Transaksi ${id} dibatalkan.`, createdAt: new Date().toISOString(), read: false })
            await saveDb(db)
        }

        res.status(cancelRes.status).json(cancelJson)
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal membatalkan transaksi.' })
    }
})

app.get('/api/notifications/:id', async (req, res) => {
    const db = await loadDb()
    const trx = db.history.find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    const notifications = (db.notifications || []).filter(n => n.transactionId === trx.transactionId).map(({ accessKey, ...n }) => n)
    res.json({ success: true, notifications })
})

app.post('/api/notifications/read', async (req, res) => {
    const { transactionId, key, notificationId } = req.body || {}
    const db = await loadDb()
    const trx = db.history.find(item => item.transactionId === transactionId && item.accessKey === String(key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    for (const item of db.notifications || []) if (item.transactionId === transactionId && (!notificationId || item.id === notificationId)) item.read = true
    await saveDb(db)
    res.json({ success: true })
})

app.post('/api/comments', async (req, res) => {
    const { transactionId, key, message } = req.body || {}
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Pesan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb()
    normalizeExpiredTransactions(db)
    const trx = db.history.find(item => item.transactionId === transactionId && item.accessKey === String(key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    const comment = { id: `MSG-${Date.now()}`, transactionId, sender: 'donor', senderName: trx.name || 'Donatur', message: text, createdAt: new Date().toISOString(), replies: [] }
    db.comments = db.comments || []
    db.comments.push(comment)
    db.notifications = db.notifications || []
    db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey: `donor-message:${comment.id}`, transactionId, accessKey: trx.accessKey, type: 'message', title: 'Pesan baru dari donatur', message: text, createdAt: comment.createdAt, read: false })
    trx.comments = trx.comments || []
    trx.comments.push(comment.id)
    await saveDb(db)
    res.json({ success: true, comment })
})

app.get('/api/comments/:id', async (req, res) => {
    const db = await loadDb()
    const trx = db.history.find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).json({ success: false, message: 'Akses transaksi tidak valid.' })
    res.json({ success: true, comments: (db.comments || []).filter(c => c.transactionId === trx.transactionId) })
})

app.post('/api/admin/reply', async (req, res) => {
    const { password, commentId, message } = req.body || {}
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const text = String(message || '').trim()
    if (!text || text.length > 1000) return res.status(400).json({ success: false, message: 'Balasan wajib diisi dan maksimal 1000 karakter.' })
    const db = await loadDb()
    const comment = (db.comments || []).find(c => c.id === commentId)
    if (!comment) return res.status(404).json({ success: false, message: 'Komentar tidak ditemukan.' })
    comment.replies = comment.replies || []
    const reply = { id: `RPL-${Date.now()}`, sender: 'admin', senderName: 'Admin Kaxel', message: text, createdAt: new Date().toISOString() }
    comment.replies.push(reply)
    db.notifications = db.notifications || []
    const eventKey = `reply:${comment.id}:${reply.id}`
    db.notifications.unshift({ id: `NTF-${Date.now()}`, eventKey, transactionId: comment.transactionId, accessKey: (db.history.find(h => h.transactionId === comment.transactionId) || {}).accessKey, type: 'reply', title: 'Admin membalas pesan Anda', message: text, createdAt: reply.createdAt, read: false })
    await saveDb(db)
    res.json({ success: true, reply })
})

app.get('/api/admin/comments', async (req, res) => {
    const password = String(req.query.password || '')
    if (password !== ADMIN_PASSWORD) return res.status(401).json({ success: false, message: 'Password Admin salah.' })
    const db = await loadDb()
    res.json({ success: true, comments: db.comments || [] })
})

app.get('/api/invoice/:id', async (req, res) => {
    const db = await loadDb()
    const trx = db.history.find(item => item.transactionId === req.params.id && item.accessKey === String(req.query.key || ''))
    if (!trx) return res.status(403).send('Akses invoice tidak valid.')
    const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))
    res.type('html').send(`<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Invoice ${esc(trx.transactionId)}</title><style>body{font:16px Arial,sans-serif;background:#f1f5f9;color:#0f172a;margin:0;padding:24px}.invoice{max-width:700px;margin:auto;background:white;padding:32px;border:1px solid #cbd5e1;border-radius:18px}.brand{font-size:24px;font-weight:800;color:#2563eb}.line{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid #e2e8f0;padding:13px 0}.amount{font-size:26px;font-weight:800}.status{display:inline-block;background:#dbeafe;border-radius:8px;padding:6px 10px}@media print{body{background:white;padding:0}.invoice{border:0}}</style><main class="invoice"><div class="brand">KAXEL DONASI</div><p>Bukti transaksi donasi</p><div class="line"><b>Nomor transaksi</b><span>${esc(trx.transactionId)}</span></div><div class="line"><b>Donatur</b><span>${esc(trx.name)}</span></div><div class="line"><b>Tanggal</b><span>${esc(new Date(trx.createdAt).toLocaleString('id-ID'))}</span></div><div class="line"><b>Status</b><span class="status">${esc(trx.status)}</span></div><div class="line"><b>Nominal donasi</b><span>${esc(new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(trx.amount))}</span></div><div class="line"><b>Biaya admin</b><span>${esc(new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(trx.fee || 0))}</span></div><div class="line"><b>Total pembayaran</b><span class="amount">${esc(new Intl.NumberFormat('id-ID',{style:'currency',currency:'IDR',maximumFractionDigits:0}).format(trx.totalAmount || trx.amount))}</span></div>${trx.expiredAt && trx.status==='pending'?`<div class="line"><b>Batas pembayaran</b><span>${esc(new Date(trx.expiredAt).toLocaleString('id-ID'))}</span></div>`:''}<div class="line"><b>Pesan</b><span>${esc(trx.notes || '-')}</span></div><p style="color:#64748b;font-size:12px;margin-top:24px">Invoice ini dibuat dari data transaksi website Kaxel. Gunakan fitur cetak browser untuk menyimpan sebagai PDF.</p><button onclick="window.print()">Cetak / Simpan PDF</button></main></html>`)
})

app.get('/api/public-stats', async (req, res) => {
    try {
        const db = await loadDb()
        if (normalizeExpiredTransactions(db)) await saveDb(db)
        const successList = db.history.filter(h => h.status === 'sukses' || h.status === 'success')
        const currentRaised = successList.reduce((acc, cur) => acc + Number(cur.amount), 0)

        const recent = successList.slice(0, 10).map(h => ({
            name: h.name,
            amount: h.amount,
            notes: h.notes,
            emoji: h.emoji,
            paidAt: h.paidAt || h.createdAt
        }))

        const mapTop = {}
        successList.forEach(h => {
            const key = h.name.toLowerCase()
            if (!mapTop[key]) {
                mapTop[key] = { name: h.name, total: 0, count: 0 }
            }
            mapTop[key].total += Number(h.amount)
            mapTop[key].count += 1
        })

        const leaderboard = Object.values(mapTop)
            .sort((a, b) => b.total - a.total)
            .slice(0, 5)

        const transactions = [...db.history]
            .sort((a, b) => new Date(b.createdAt || b.paidAt || 0).getTime() - new Date(a.createdAt || a.paidAt || 0).getTime())
            .slice(0, 15)
            .map(h => ({
                transactionId: h.transactionId || h.id || '',
                name: h.name || 'Anonim',
                amount: Number(h.amount) || 0,
                notes: h.notes || '',
                emoji: h.emoji || 'support',
                status: h.status || 'pending',
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
        res.json({ success: true, goal: { title: 'Target Donasi', target: 1000000, current: 0 }, recent: [], leaderboard: [] })
    }
})

app.post('/api/admin/stats', async (req, res) => {
    try {
        const { password } = req.body
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' })
        }

        const db = await loadDb()
        if (normalizeExpiredTransactions(db)) await saveDb(db)
        const successList = db.history.filter(h => h.status === 'sukses' || h.status === 'success')
        const pendingList = db.history.filter(h => h.status === 'pending')
        const totalRevenue = successList.reduce((acc, cur) => acc + Number(cur.amount), 0)

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
        if (password !== ADMIN_PASSWORD) {
            return res.status(401).json({ success: false, message: 'Password Admin salah!' })
        }

        const db = await loadDb()
        db.goal = {
            title: title?.trim() || 'Target Donasi Kaxel',
            target: Math.max(10000, parseInt(target) || 1000000)
        }
        await saveDb(db)

        res.json({ success: true, goal: db.goal })
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal mengubah target donasi.' })
    }
})

export default app
