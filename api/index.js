import express from 'express'
import fetch from 'node-fetch'
import dotenv from 'dotenv'

dotenv.config()

const app = express()
const BTZ_BASE_URL = new URL('https://web.btzpay.my.id').origin
const API_KEY = process.env.BTZ_API_KEY
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123'
const FEE_PERCENT = parseFloat(process.env.FEE_PERCENT || '0.7')
const JSONBIN_ID = process.env.JSONBIN_ID || ''
const JSONBIN_KEY = process.env.JSONBIN_KEY || ''

app.use(express.json())

let memoryStore = {
    goal: { title: 'Upgrade Server & Kopi Kaxel', target: 1000000 },
    history: []
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
                    memoryStore = json.record
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

const getFee = (amount) => Math.round(Number(amount) * FEE_PERCENT / 100)

app.post('/api/donate', async (req, res) => {
    try {
        if (!API_KEY) {
            return res.status(500).json({ success: false, message: 'API Key belum dipasang di Environment Variables.' })
        }

        const { name, amount, notes, emoji, whatsapp } = req.body
        const parsedAmount = parseInt(amount)

        if (!parsedAmount || isNaN(parsedAmount) || parsedAmount < 100) {
            return res.status(400).json({ success: false, message: 'Nominal minimal Rp100.' })
        }

        const senderName = name?.trim() || 'Anonim'
        const trxNotes = notes?.trim() || 'Semangat terus Kaxel!'
        const chosenEmoji = emoji || '🔥'
        const cleanWa = whatsapp ? whatsapp.replace(/[^0-9+]/g, '') : ''

        const createRes = await fetch(`${BTZ_BASE_URL}/api/qris/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apikey: API_KEY,
                amount: parsedAmount,
                fee: getFee(parsedAmount),
                notes: trxNotes,
                timeout: 900000,
                metadata: {
                    orderId: `DONASI-${Date.now()}`,
                    sender: senderName
                },
                customerInfo: {
                    name: senderName,
                    email: '',
                    phone: cleanWa
                }
            })
        })

        const createJson = await createRes.json()

        if (!createJson.success || !createJson.data?.qrisString) {
            return res.status(400).json({
                success: false,
                message: createJson.message || 'Gagal membuat transaksi QRIS.'
            })
        }

        const trx = createJson.data

        const qrRes = await fetch(`${BTZ_BASE_URL}/api/qris/create-qr-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: trx.qrisString,
                size: '500x500',
                style: '4',
                color: '0f1056',
                format: 'png',
                pngMode: 'styled',
                viewer: '0'
            })
        })

        if (!qrRes.ok) {
            return res.status(500).json({ success: false, message: 'Gagal membuat gambar QR.' })
        }

        const qrBuffer = await qrRes.arrayBuffer()
        const qrBase64 = `data:image/png;base64,${Buffer.from(qrBuffer).toString('base64')}`

        const db = await loadDb()
        db.history.unshift({
            transactionId: trx.transactionId,
            accessKey: trx.accessKey,
            name: senderName,
            whatsapp: cleanWa,
            amount: trx.amount,
            fee: trx.fee,
            totalAmount: trx.totalAmount,
            notes: trxNotes,
            emoji: chosenEmoji,
            status: 'pending',
            createdAt: new Date().toISOString(),
            expiredAt: trx.expiredAt,
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
                expiredAt: trx.expiredAt,
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
            const idx = db.history.findIndex(item => item.transactionId === id)
            if (idx !== -1 && db.history[idx].status !== checkJson.data.status) {
                db.history[idx].status = checkJson.data.status
                if (checkJson.data.status === 'sukses' || checkJson.data.status === 'success') {
                    db.history[idx].paidAt = new Date().toISOString()
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
        const cancelRes = await fetch(`${BTZ_BASE_URL}/api/qris/cancel/${id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                apikey: API_KEY,
                reason: 'cancelled_by_user'
            })
        })
        const cancelJson = await cancelRes.json()

        const db = await loadDb()
        const idx = db.history.findIndex(item => item.transactionId === id)
        if (idx !== -1) {
            db.history[idx].status = 'cancelled'
            await saveDb(db)
        }

        res.json(cancelJson)
    } catch (error) {
        res.status(500).json({ success: false, message: 'Gagal membatalkan transaksi.' })
    }
})

app.get('/api/public-stats', async (req, res) => {
    try {
        const db = await loadDb()
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

        res.json({
            success: true,
            goal: {
                title: db.goal?.title || 'Target Donasi Kaxel',
                target: db.goal?.target || 1000000,
                current: currentRaised
            },
            recent,
            leaderboard
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
