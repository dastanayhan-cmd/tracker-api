const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const sqlite3 = require('sqlite3').verbose();
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json()); 
const port = process.env.PORT || 3000;

let botStatus = 'Başlatılıyor...';
let sockInstance = null;
let isConnected = false;

// 1. VERİTABANI
const db = new sqlite3.Database('./tracker.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS targets (number TEXT PRIMARY KEY, name TEXT, pic_url TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (number TEXT, status TEXT, timestamp DATETIME)");
});

// 2. WHATSAPP MOTORU
async function connectToWhatsApp() {
    let auth;
    try {
        auth = await useMultiFileAuthState('auth_info_baileys');
    } catch (e) {
        try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch (err) {}
        auth = await useMultiFileAuthState('auth_info_baileys');
    }

    const { state, saveCreds } = auth;
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: true 
    });

    sockInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            isConnected = false;
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                botStatus = 'Yeniden bağlanılıyor...';
                setTimeout(connectToWhatsApp, 3000);
            } else {
                botStatus = 'Çıkış yapıldı. Lütfen sıfırlayın.';
            }
        } else if (connection === 'open') {
            isConnected = true;
            botStatus = 'Bağlandı 🟢';
            
            try { await sock.sendPresenceUpdate('available'); } catch(e){}
            
            // Veritabanındaki numaralara abone ol
            db.all("SELECT number FROM targets", [], (err, rows) => {
                if (rows) {
                    rows.forEach(async (row) => {
                        try { await sock.presenceSubscribe(`${row.number}@s.whatsapp.net`); } catch(e){}
                    });
                }
            });
        }
    });

    // İŞTE BÜYÜK HATANIN DÜZELTİLDİĞİ YER
    sock.ev.on('presence.update', (json) => {
        try {
            const fullJid = json.id; // Gelen verinin tam adresi (Örn: 905...@s.whatsapp.net)
            const number = fullJid.split('@')[0]; // Veritabanında arayacağımız yalın numara

            // HATA BURADAYDI: Gelen veriyi yalın numarayla arıyordum, artık tam adresle çekiyoruz!
            const presenceInfo = json.presences && (json.presences[fullJid] || Object.values(json.presences)[0]);
            
            if (!presenceInfo) return;

            const status = presenceInfo.lastKnownPresence; 
            
            if (status === 'available' || status === 'unavailable') {
                db.get("SELECT * FROM targets WHERE number = ?", [number], (err, row) => {
                    if (row) {
                        const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                        db.get("SELECT status FROM logs WHERE number = ? ORDER BY timestamp DESC LIMIT 1", [number], (err, lastLog) => {
                            if (!lastLog || lastLog.status !== status) {
                                db.run("INSERT INTO logs (number, status, timestamp) VALUES (?, ?, ?)", [number, status, time]);
                            }
                        });
                    }
                });
            }
        } catch (e) {}
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type === 'notify') {
            for (const msg of messages) {
                if (msg.key.remoteJid === 'status@broadcast') {
                    const senderNum = (msg.key.participant || msg.participant || "").split('@')[0];
                    db.get("SELECT * FROM targets WHERE number = ?", [senderNum], (err, row) => {
                        if (row) {
                            const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                            db.run("INSERT INTO logs (number, status, timestamp) VALUES (?, ?, ?)", [senderNum, "Yeni Durum Paylaştı 📸", time]);
                        }
                    });
                }
            }
        }
    });
    
    return sock;
}
connectToWhatsApp();

app.get('/api/status', (req, res) => res.json({ registered: isConnected, status: botStatus }));

app.get('/api/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ success: false, message: "Numara eksik" });
    phone = phone.replace(/[^0-9]/g, '');

    if (isConnected) return res.json({ success: false, message: "Sistem zaten bağlı." });
    if (!sockInstance) return res.json({ success: false, message: "Sistem hazırlanıyor, bekleyin." });

    try {
        let code = await sockInstance.requestPairingCode(phone);
        let formattedCode = code?.match(/.{1,4}/g)?.join('-') || code;
        res.json({ success: true, code: formattedCode });
    } catch (error) {
        res.json({ success: false, message: "Kod alınamadı." });
    }
});

app.get('/api/targets', (req, res) => db.all("SELECT * FROM targets", [], (err, rows) => res.json(rows || [])));
app.get('/api/logs', (req, res) => {
    db.all("SELECT logs.*, targets.name, targets.pic_url FROM logs LEFT JOIN targets ON logs.number = targets.number ORDER BY timestamp DESC LIMIT 50", [], (err, rows) => res.json(rows || []));
});

app.post('/api/add-target', async (req, res) => {
    let { number, name } = req.body;
    number = number.replace(/\D/g, ''); 
    let picUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'; 
    let finalName = name;
    
    if (sockInstance && isConnected) {
        try {
            const fetchedUrl = await sockInstance.profilePictureUrl(`${number}@s.whatsapp.net`, 'image');
            if(fetchedUrl) picUrl = fetchedUrl;
            if (!finalName) {
                const fetchedStatus = await sockInstance.fetchStatus(`${number}@s.whatsapp.net`);
                finalName = fetchedStatus?.status || 'Kişi (' + number.slice(-4) + ')';
            }
            // Numara eklenir eklenmez takibe başla
            await sockInstance.presenceSubscribe(`${number}@s.whatsapp.net`);
        } catch (e) {}
    }
    db.run("INSERT OR REPLACE INTO targets (number, name, pic_url) VALUES (?, ?, ?)", [number, finalName || number, picUrl], (err) => res.json({ success: !err }));
});

app.get('/api/reset', (req, res) => {
    try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
    setTimeout(() => process.exit(1), 1000); 
    res.json({ success: true });
});

// HTML ARAYÜZÜ (SMS Versiyonu)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsLives Panel</title>
    <style>
        body { font-family: 'Segoe UI', sans-serif; background-color: #f0f2f5; margin: 0; }
        .app-container { max-width: 500px; margin: 0 auto; background: white; min-height: 100vh; }
        .header { background-color: #075E54; color: white; padding: 20px; text-align: center; font-weight: bold; }
        .section { padding: 20px; display: none; }
        .active-section { display: block; }
        input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ccc; border-radius: 5px; box-sizing: border-box; }
        button { width: 100%; background-color: #25D366; color: white; padding: 14px; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; }
        .target-card { display: flex; align-items: center; background: #f8f9fa; padding: 10px; margin-bottom: 10px; border-radius: 8px; border: 1px solid #eee; }
        .target-card img { width: 50px; height: 50px; border-radius: 50%; margin-right: 15px; }
        .log-item { background: white; padding: 12px; border-bottom: 1px solid #eee; display: flex; align-items: center; }
        .log-item img { width: 40px; height: 40px; border-radius: 50%; margin-right: 15px; }
        .online { color: #25D366; font-weight: bold; }
        .offline { color: #dc3545; font-weight: bold; }
        .code-display { font-size: 32px; font-weight: bold; color: #075E54; text-align: center; letter-spacing: 5px; margin: 20px 0; background: #e9edef; padding: 15px; border-radius: 8px;}
    </style>
</head>
<body>
<div class="app-container">
    <div class="header">WhatsLives Radar</div>
    <div id="loginSection" class="section">
        <h3 style="text-align:center;">Sistemi Başlat (SMS Kodu)</h3>
        <p id="statusText" style="text-align:center; color:#666;"></p>
        <div style="background:#fafafa; padding:15px; border-radius:8px; border:1px solid #eee; margin-bottom:20px;">
            <input type="text" id="botNumber" placeholder="Kendi Numaranız (Örn: 905...)">
            <button onclick="getCode()">Eşleştirme Kodu Al</button>
            <div id="codeResult"></div>
        </div>
        <button onclick="resetSystem()" style="background:#dc3545;">Sıfırla</button>
    </div>
    <div id="dashboardSection" class="section">
        <div style="background:#e9edef; padding:15px; border-radius:8px; margin-bottom:20px;">
            <input type="text" id="targetName" placeholder="İsim (Boş bırakırsan çekilir)">
            <input type="text" id="targetNumber" placeholder="Numara (905...)">
            <button onclick="addTarget()">Takibe Başla</button>
        </div>
        <h3>Takip Edilenler</h3>
        <div id="targetsList"></div>
        <hr>
        <h3>Canlı Hareketler</h3>
        <div id="logsList"></div>
    </div>
</div>
<script>
    async function checkStatus() {
        const res = await fetch('/api/status');
        const data = await res.json();
        if (data.registered) {
            document.getElementById('loginSection').classList.remove('active-section');
            document.getElementById('dashboardSection').classList.add('active-section');
            loadTargets(); loadLogs();
        } else {
            document.getElementById('loginSection').classList.add('active-section');
            document.getElementById('statusText').innerText = data.status;
        }
    }
    
    async function getCode() {
        const num = document.getElementById('botNumber').value;
        if(!num) return alert("Lütfen kendi numaranızı girin!");
        const btn = event.target;
        btn.innerText = "Kod İsteniyor...";
        const res = await fetch('/api/pair?phone=' + num);
        const data = await res.json();
        if(data.success) {
            document.getElementById('codeResult').innerHTML = '<div class="code-display">' + data.code + '</div><p style="text-align:center; color:red; font-size:12px;">Kodu girmek için 60 saniyeniz var!</p>';
            btn.innerText = "Eşleştirme Kodu Al";
        } else {
            alert(data.message);
            btn.innerText = "Eşleştirme Kodu Al";
        }
    }

    async function addTarget() {
        const name = document.getElementById('targetName').value;
        const number = document.getElementById('targetNumber').value;
        await fetch('/api/add-target', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, number: number })
        });
        location.reload();
    }
    async function loadTargets() {
        const res = await fetch('/api/targets');
        const targets = await res.json();
        let html = '';
        targets.forEach(t => {
            html += '<div class="target-card"><img src="'+t.pic_url+'"><div><h4>'+t.name+'</h4><p>+'+t.number+'</p></div></div>';
        });
        document.getElementById('targetsList').innerHTML = html;
    }
    async function loadLogs() {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        let html = '';
        logs.forEach(l => {
            let sClass = l.status === 'available' ? 'online' : (l.status.includes('Durum') ? 'story' : 'offline');
            let sText = l.status === 'available' ? 'Çevrimiçi 🟢' : (l.status === 'unavailable' ? 'Çevrimdışı 🔴' : l.status);
            html += '<div class="log-item"><img src="'+l.pic_url+'"><div><b>'+l.name+'</b><div class="'+sClass+'">'+sText+'</div><small>'+l.timestamp+'</small></div></div>';
        });
        document.getElementById('logsList').innerHTML = html;
    }
    function resetSystem() { fetch('/api/reset').then(() => location.reload()); }
    checkStatus(); setInterval(checkStatus, 5000); setInterval(loadLogs, 5000);
</script>
</body>
</html>
    `);
});

app.listen(port, () => console.log("Hazır!"));
                       
