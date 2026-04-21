const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const sqlite3 = require('sqlite3').verbose();
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json()); // Android'den gelen JSON verilerini okumak için
const port = process.env.PORT || 3000;

let sockInstance = null;

// 1. Veritabanı Kurulumu (SQLite)
const db = new sqlite3.Database('./tracker.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
});

db.serialize(() => {
    // Takipler ve Loglar tablolarını oluştur
    db.run("CREATE TABLE IF NOT EXISTS targets (number TEXT PRIMARY KEY, name TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (number TEXT, status TEXT, timestamp DATETIME)");
});

// 2. WhatsApp Motoru
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: Browsers.ubuntu('Chrome')
    });

    sockInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') console.log("WhatsApp API'ye bağlandı!");
    });

    // Numara online/offline olduğunda Veritabanına kaydet
    sock.ev.on('presence.update', (json) => {
        try {
            const id = json.id.split('@')[0];
            const presenceInfo = json.presences && json.presences[id];
            if (!presenceInfo) return;

            const status = presenceInfo.lastKnownPresence; // available veya unavailable
            
            db.get("SELECT * FROM targets WHERE number = ?", [id], (err, row) => {
                if (row && (status === 'available' || status === 'unavailable')) {
                    const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    // Logu veritabanına yaz
                    db.run("INSERT INTO logs (number, status, timestamp) VALUES (?, ?, ?)", [id, status, time]);
                }
            });
        } catch (e) {}
    });
}
connectToWhatsApp();

// 3. ANDROID UYGULAMASI İÇİN API UÇ NOKTALARI
// Uygulamaya numaraları listeler
app.get('/api/logs', (req, res) => {
    db.all("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        res.json(rows || []);
    });
});

// Uygulamadan hedef numara ekleme isteği alır
app.post('/api/add-target', async (req, res) => {
    const { number, name } = req.body;
    db.run("INSERT OR REPLACE INTO targets (number, name) VALUES (?, ?)", [number, name], async (err) => {
        if (!err && sockInstance) {
            await sockInstance.presenceSubscribe(number + '@s.whatsapp.net');
            res.json({ success: true, message: "Numara eklendi!" });
        } else {
            res.json({ success: false });
        }
    });
});

app.listen(port, () => {
    console.log("Android API Sunucusu " + port + " portunda hazır.");
});
  
