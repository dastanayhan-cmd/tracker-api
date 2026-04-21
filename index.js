const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, Browsers } = require('@whiskeysockets/baileys');
const sqlite3 = require('sqlite3').verbose();
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json()); 
const port = process.env.PORT || 3000;

let sockInstance = null;

// 1. Veritabanı Kurulumu
const db = new sqlite3.Database('./tracker.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
});

db.serialize(() => {
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
        if (connection === 'open') console.log("WhatsApp API bağlandı!");
    });

    sock.ev.on('presence.update', (json) => {
        try {
            const id = json.id.split('@')[0];
            const presenceInfo = json.presences && json.presences[id];
            if (!presenceInfo) return;

            const status = presenceInfo.lastKnownPresence; 
            
            db.get("SELECT * FROM targets WHERE number = ?", [id], (err, row) => {
                if (row && (status === 'available' || status === 'unavailable')) {
                    const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    db.run("INSERT INTO logs (number, status, timestamp) VALUES (?, ?, ?)", [id, status, time]);
                }
            });
        } catch (e) {}
    });
}
connectToWhatsApp();

// --------------------------------------------------------
// API UÇ NOKTALARI (TARAYICI VE ANDROID İÇİN)
// --------------------------------------------------------

// 1. Ana Sayfa (Cannot GET / hatasını çözer)
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: Arial; text-align: center; margin-top: 50px;">
            <h2 style="color: #25D366;">WhatsApp Tracker API Başarıyla Çalışıyor! 🚀</h2>
            <p>Bu bir Android arka plan sunucusudur. Eşleştirme kodu almak için URL sonuna parametre ekleyin.</p>
        </div>
    `);
});

// Android Uygulamasının Eşleştirme Kodu İsteyeceği Yer
app.get('/api/pair-android', async (req, res) => {
    const phone = req.query.phone;
    if (!phone) return res.json({ success: false, message: "Numara eksik" });
    
    if (sockInstance && !sockInstance.authState.creds.registered) {
        try {
            let code = await sockInstance.requestPairingCode(phone);
            let formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
            res.json({ success: true, code: formattedCode });
        } catch (error) {
            res.json({ success: false, message: "Kod alınamadı." });
        }
    } else {
        res.json({ success: false, message: "Sistem zaten bir hesaba bağlı." });
    }
});


// 3. Android Uygulamasının Log Çekeceği Yer
app.get('/api/logs', (req, res) => {
    db.all("SELECT * FROM logs ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => {
        res.json(rows || []);
    });
});

// 4. Android Uygulamasının Numara Ekleyeceği Yer
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
    console.log("Sunucu " + port + " portunda hazır.");
});
                    
