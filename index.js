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

// VERİTABANI
const db = new sqlite3.Database('./tracker.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS targets (number TEXT PRIMARY KEY, name TEXT, pic_url TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (number TEXT, status TEXT, timestamp DATETIME)");
});

// WHATSAPP MOTORU (AGRESİF MOD)
async function connectToWhatsApp() {
    let auth;
    try {
        auth = await useMultiFileAuthState('auth_info_baileys');
    } catch (e) {
        try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch (err) {}
        auth = await useMultiFileAuthState('auth_info_baileys');
    }

    const { state, saveCreds } = auth;
    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`Baileys Sürümü: ${version.join('.')}, En güncel mi: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        auth: state,
        browser: ["Windows", "Chrome", "20.0.04"],
        syncFullHistory: false,
        markOnlineOnConnect: true // BOTU ZORLA ÇEVRİMİÇİ YAPAR (KRİTİK)
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
            
            // Botun kendisini ağda "Müsait/Çevrimiçi" olarak bağırması lazım
            await sock.sendPresenceUpdate('available');
            
            startAggressivePolling();
        }
    });

    // EKSİK OLAN PARÇA: SÜREKLİ YOKLAMA (POLLING) MOTORU
    function startAggressivePolling() {
        setInterval(() => {
            if (!sockInstance || !isConnected) return;
            
            // Botun kendi durumunu taze tutması
            sockInstance.sendPresenceUpdate('available').catch(()=>{});

            db.all("SELECT number FROM targets", [], (err, rows) => {
                if (rows) {
                    rows.forEach(async (row) => {
                        try {
                            const jid = `${row.number}@s.whatsapp.net`;
                            // Sadece abone olma, bana son durumu "ŞU AN" yolla diye zorla
                            await sockInstance.presenceSubscribe(jid);
                            await sockInstance.sendPresenceUpdate('available', jid); 
                        } catch(e){}
                    });
                }
            });
        }, 15000); // HER 15 SANİYEDE BİR WHATSAPP'I DÜRT
    }

    sock.ev.on('presence.update', (json) => {
        try {
            const id = json.id.split('@')[0];
            const presenceInfo = json.presences && json.presences[id];
            if (!presenceInfo) return;

            const status = presenceInfo.lastKnownPresence; 
            db.get("SELECT * FROM targets WHERE number = ?", [id], (err, row) => {
                if (row && (status === 'available' || status === 'unavailable')) {
                    const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    db.get("SELECT status FROM logs WHERE number = ? ORDER BY timestamp DESC LIMIT 1", [id], (err, lastLog) => {
                        if (!lastLog || lastLog.status !== status) {
                            db.run("INSERT INTO logs (number, status, timestamp) VALUES (?, ?, ?)", [id, status, time]);
                        }
                    });
                }
            });
        } catch (e) {}
    });

    return sock;
}
connectToWhatsApp();

// API UÇ NOKTALARI
app.get('/api/status', (req, res) => res.json({ registered: isConnected, status: botStatus }));

app.get('/api/pair', async (req, res) => {
    let phone = req.query.phone;
    if (!phone) return res.json({ success: false, message: "Numara eksik" });
    phone = phone.replace(/[^0-9]/g, '');

    if (isConnected) return res.json({ success: false, message: "Sistem zaten bağlı." });
    if (!sockInstance) return res.json({ success: false, message: "Sistem hazırlanıyor, 5 sn bekleyin." });

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
                finalName = fetchedStatus?.status || `Kişi (${number.slice(-4)})`;
            }
            
            // Eklenir eklenmez agresif takip başlat
            const jid = `${number}@s.whatsapp.net`;
            await sockInstance.presenceSubscribe(jid);
            
        } catch (e) {}
    }
    db.run("INSERT OR REPLACE INTO targets (number, name, pic_url) VALUES (?, ?, ?)", [number, finalName || number, picUrl], (err) => res.json({ success: !err }));
});

app.get('/api/reset', (req, res) => {
    try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
    setTimeout(() => process.exit(1), 1000); 
    res.json({ success: true });
});

// WEB ARAYÜZÜ
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
            body: JSON.stringify({ name, number })
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
            let sClass = l.status === 'available' ? 'online' : 'offline';
            let sText = l.status === 'available' ? 'Çevrimiçi 🟢' : (l.status === 'unavailable' ? 'Çevrimdışı 🔴' : l.status);
            html += '<div class="log-item"><img src="'+l.pic_url+'"><div><b>'+l.name+'</b><div class="'+sClass+'">'+sText+'</div><small>'+l.timestamp+'</small></div></div>';
        });
        document.getElementById('logsList').innerHTML = html;
    }
    function resetSystem() { fetch('/api/reset').then(() => location.reload()); }
    checkStatus(); setInterval(checkStatus, 5000); setInterval(loadLogs, 8000);
</script>
</body>
</html>
    `);
});

app.listen(port, () => console.log("Hazır!"));
                                                                                                              
