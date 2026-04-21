const express = require('express');
const cors = require('cors');
const fs = require('fs');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const sqlite3 = require('sqlite3').verbose();
const qrcode = require('qrcode');
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json()); // API formatı için JSON kullanıyoruz
const port = process.env.PORT || 3000;

let qrImage = '';
let botStatus = 'Başlatılıyor...';
let sockInstance = null;

// --------------------------------------------------------
// 1. VERİTABANI (Çoklu Numara ve İsimler İçin)
// --------------------------------------------------------
const db = new sqlite3.Database('./tracker.db');
db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS targets (number TEXT PRIMARY KEY, name TEXT, pic_url TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (number TEXT, status TEXT, timestamp DATETIME)");
});

// --------------------------------------------------------
// 2. WHATSAPP MOTORU (Çalışan Sade Çekirdek)
// --------------------------------------------------------
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }), 
        printQRInTerminal: false,
        auth: state,
        browser: ["WP Tracker", "Chrome", "1.0.0"] // Çalışan sihirli kimlik
    });

    sockInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            botStatus = 'Karekod Bekleniyor...';
            qrImage = await qrcode.toDataURL(qr); // QR'ı direkt resme çevirir
        }
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                botStatus = 'Yeniden bağlanılıyor...';
                setTimeout(connectToWhatsApp, 3000);
            } else {
                botStatus = 'Çıkış yapıldı.';
                qrImage = '';
            }
        } else if (connection === 'open') {
            botStatus = 'Bağlandı 🟢';
            qrImage = '';
            
            // Veritabanındaki tüm numaraları radara al
            db.all("SELECT number FROM targets", [], (err, rows) => {
                if (rows) {
                    rows.forEach(async (row) => {
                        try { await sock.presenceSubscribe(`${row.number}@s.whatsapp.net`); } catch(e){}
                    });
                }
            });
        }
    });

    sock.ev.on('presence.update', (json) => {
        try {
            const id = json.id.split('@')[0];
            const presenceInfo = json.presences && json.presences[id];
            if (!presenceInfo) return;

            const status = presenceInfo.lastKnownPresence; 
            
            // Eğer numara veritabanımızda varsa işlemi yap
            db.get("SELECT * FROM targets WHERE number = ?", [id], (err, row) => {
                if (row && (status === 'available' || status === 'unavailable')) {
                    const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    
                    // Art arda aynı durumu yazmayı engelle
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

// --------------------------------------------------------
// 3. API UÇ NOKTALARI (Android'in veri çekeceği yerler)
// --------------------------------------------------------
app.get('/api/status', (req, res) => {
    const isRegistered = sockInstance?.authState?.creds?.registered || false;
    res.json({ registered: isRegistered, status: botStatus, qr: qrImage });
});

app.get('/api/targets', (req, res) => {
    db.all("SELECT * FROM targets", [], (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/add-target', async (req, res) => {
    let { number, name } = req.body;
    number = number.replace(/\D/g, ''); // Sadece rakamları al
    let picUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'; 
    
    if (sockInstance) {
        try {
            // Profil Fotoğrafını Çekme Motoru
            const fetchedUrl = await sockInstance.profilePictureUrl(`${number}@s.whatsapp.net`, 'image');
            if(fetchedUrl) picUrl = fetchedUrl;
        } catch (e) {}
    }

    db.run("INSERT OR REPLACE INTO targets (number, name, pic_url) VALUES (?, ?, ?)", [number, name, picUrl], async (err) => {
        if (!err && sockInstance) {
            try { await sockInstance.presenceSubscribe(`${number}@s.whatsapp.net`); } catch(e){}
            res.json({ success: true, message: "Numara başarıyla eklendi!" });
        } else {
            res.json({ success: false, message: "Eklenemedi." });
        }
    });
});

app.get('/api/logs', (req, res) => {
    const query = `
        SELECT logs.*, targets.name, targets.pic_url 
        FROM logs 
        LEFT JOIN targets ON logs.number = targets.number 
        ORDER BY timestamp DESC LIMIT 50
    `;
    db.all(query, [], (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/reset', (req, res) => {
    try { fs.rmSync('./auth_info_baileys', { recursive: true, force: true }); } catch(e) {}
    qrImage = '';
    res.json({ success: true });
    setTimeout(() => process.exit(1), 1000); 
});

// --------------------------------------------------------
// 4. MOBİL UYUMLU PROFESYONEL WEB ARAYÜZÜ
// --------------------------------------------------------
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WhatsLives Panel</title>
    <style>
        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f0f2f5; margin: 0; padding: 0; }
        .app-container { max-width: 500px; margin: 0 auto; background: white; min-height: 100vh; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
        .header { background-color: #075E54; color: white; padding: 20px; text-align: center; font-size: 20px; font-weight: bold; }
        .section { padding: 20px; display: none; }
        .active-section { display: block; }
        input { width: 100%; padding: 12px; margin: 8px 0; border: 1px solid #ccc; border-radius: 5px; box-sizing: border-box; }
        button { width: 100%; background-color: #25D366; color: white; padding: 14px; margin: 8px 0; border: none; border-radius: 5px; font-weight: bold; cursor: pointer; }
        .btn-danger { background-color: #dc3545; }
        .target-card { display: flex; align-items: center; background: #f8f9fa; padding: 10px; margin-bottom: 10px; border-radius: 8px; border: 1px solid #eee; }
        .target-card img { width: 50px; height: 50px; border-radius: 50%; object-fit: cover; margin-right: 15px; border: 2px solid #25D366; }
        .target-info h4 { margin: 0 0 5px 0; color: #333; }
        .target-info p { margin: 0; font-size: 12px; color: #666; }
        .log-item { background: white; padding: 12px; border-bottom: 1px solid #eee; display: flex; align-items: center; }
        .log-item img { width: 40px; height: 40px; border-radius: 50%; margin-right: 15px; }
        .log-time { font-size: 11px; color: #888; margin-top: 4px; }
        .online { color: #25D366; font-weight: bold; }
        .offline { color: #dc3545; font-weight: bold; }
    </style>
</head>
<body>

<div class="app-container">
    <div class="header">WhatsLives Radar</div>

    <div id="loginSection" class="section">
        <h3 style="text-align:center; color:#075E54;">Sistemi Başlat</h3>
        <p style="text-align:center; font-size:14px; color:#666;" id="statusText">Durum kontrol ediliyor...</p>
        
        <div id="qrContainer" style="text-align: center; margin: 20px 0;">
            </div>

        <button class="btn-danger" onclick="resetSystem()">Oturumu / Karekodu Sıfırla</button>
    </div>

    <div id="dashboardSection" class="section">
        <div style="background:#e9edef; padding:15px; border-radius:8px; margin-bottom:20px;">
            <h4 style="margin-top:0;">Yeni Hedef Ekle</h4>
            <input type="text" id="targetName" placeholder="Kişi Adı (Örn: Yağmur)">
            <input type="text" id="targetNumber" placeholder="Numara (905...)">
            <button onclick="addTarget()">Takibe Başla</button>
        </div>

        <h3>Radardaki Kişiler</h3>
        <div id="targetsList">Yükleniyor...</div>
        <hr style="border:0; border-top:1px solid #ddd; margin:20px 0;">
        <h3>Canlı Hareketler</h3>
        <div id="logsList" style="background:#fafafa; border-radius:8px; border:1px solid #eee; max-height:400px; overflow-y:auto;">
            Yükleniyor...
        </div>
    </div>
</div>

<script>
    async function checkStatus() {
        try {
            const res = await fetch('/api/status');
            const data = await res.json();
            
            if (data.registered) {
                document.getElementById('loginSection').classList.remove('active-section');
                document.getElementById('dashboardSection').classList.add('active-section');
                loadTargets();
                loadLogs();
            } else {
                document.getElementById('loginSection').classList.add('active-section');
                document.getElementById('statusText').innerText = data.status;
                if (data.qr) {
                    document.getElementById('qrContainer').innerHTML = '<img src="' + data.qr + '" style="border-radius:10px; border:2px solid #ccc; width:250px;">';
                }
            }
        } catch(e) {}
    }

    async function resetSystem() {
        if(confirm("Tüm bağlantı koparılacak. Emin misiniz?")) {
            await fetch('/api/reset');
            alert("Sıfırlanıyor...");
            setTimeout(() => location.reload(), 3000);
        }
    }

    async function addTarget() {
        const name = document.getElementById('targetName').value;
        const number = document.getElementById('targetNumber').value;
        if(!name || !number) return alert("Bilgileri doldurun!");
        
        const btn = event.target;
        btn.innerText = "Profil Fotoğrafı Aranıyor...";
        
        const res = await fetch('/api/add-target', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, number })
        });
        const data = await res.json();
        
        if(data.success) {
            document.getElementById('targetName').value = '';
            document.getElementById('targetNumber').value = '';
            loadTargets();
            btn.innerText = "Takibe Başla";
        }
    }

    async function loadTargets() {
        const res = await fetch('/api/targets');
        const targets = await res.json();
        let html = '';
        targets.forEach(t => {
            html += '<div class="target-card"><img src="' + t.pic_url + '" alt="Profil"><div class="target-info"><h4>' + t.name + '</h4><p>+' + t.number + '</p></div></div>';
        });
        document.getElementById('targetsList').innerHTML = html || '<p style="font-size:14px; color:#666;">Henüz eklenen kişi yok.</p>';
    }

    async function loadLogs() {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        let html = '';
        logs.forEach(l => {
            const statusClass = l.status === 'available' ? 'online' : 'offline';
            const statusText = l.status === 'available' ? 'Çevrimiçi 🟢' : 'Çevrimdışı 🔴';
            const pic = l.pic_url || 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
            const name = l.name || l.number;
            html += '<div class="log-item"><img src="' + pic + '" alt="Profil"><div><div style="font-weight:bold;">' + name + '</div><div class="' + statusClass + '">' + statusText + '</div><div class="log-time">' + l.timestamp + '</div></div></div>';
        });
        document.getElementById('logsList').innerHTML = html || '<p style="padding:15px; font-size:14px; color:#666;">Hareket bekleniyor...</p>';
    }

    checkStatus();
    setInterval(checkStatus, 3000); // QR ve bağlantı kontrolünü hızlı yap
    setInterval(loadLogs, 5000); 
</script>

</body>
</html>
    `);
});

app.listen(port, () => {
    console.log("Sistem " + port + " portunda hazır.");
});
        
