const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('@whiskeysockets/baileys');
const sqlite3 = require('sqlite3').verbose();
const pino = require('pino');

const app = express();
app.use(cors());
app.use(express.json()); 
const port = process.env.PORT || 3000;

let sockInstance = null;

// --------------------------------------------------------
// 1. VERİTABANI (Profil Fotoğrafı Sütunu Eklendi)
// --------------------------------------------------------
const db = new sqlite3.Database('./tracker.db', (err) => {
    if (err) console.error("Veritabanı hatası:", err.message);
});

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS targets (number TEXT PRIMARY KEY, name TEXT, pic_url TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (number TEXT, status TEXT, timestamp DATETIME)");
});

// --------------------------------------------------------
// 2. WHATSAPP MOTORU
// --------------------------------------------------------
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
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'open') {
            console.log("WhatsApp API bağlandı! 🟢");
            // Uyanınca kayıtlı numaraları tekrar radara al
            db.all("SELECT number FROM targets", [], (err, rows) => {
                if (rows) {
                    rows.forEach(async (row) => {
                        await sock.presenceSubscribe(row.number + '@s.whatsapp.net');
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
}
connectToWhatsApp();

// --------------------------------------------------------
// 3. API UÇ NOKTALARI (Android ve Web Arayüzü İçin)
// --------------------------------------------------------

// Bot durumunu kontrol eder
app.get('/api/status', (req, res) => {
    const isRegistered = sockInstance?.authState?.creds?.registered || false;
    res.json({ registered: isRegistered });
});

// Eşleştirme Kodu Verir
app.get('/api/pair', async (req, res) => {
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
        res.json({ success: false, message: "Zaten bağlı veya hazır değil." });
    }
});

// Kayıtlı Numaraları Profil Fotoğraflarıyla Getirir
app.get('/api/targets', (req, res) => {
    db.all("SELECT * FROM targets", [], (err, rows) => {
        res.json(rows || []);
    });
});

// Yeni Numara Ekler (Profil Fotoğrafını Çekmeye Çalışır)
app.post('/api/add-target', async (req, res) => {
    const { number, name } = req.body;
    let picUrl = 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png'; // Varsayılan Boş Resim
    
    if (sockInstance) {
        try {
            // WhatsApp sunucularından karşı tarafın profil fotoğrafını çek!
            const fetchedUrl = await sockInstance.profilePictureUrl(number + '@s.whatsapp.net', 'image');
            if(fetchedUrl) picUrl = fetchedUrl;
        } catch (e) {
            console.log("Profil fotoğrafı gizli veya yok.");
        }
    }

    db.run("INSERT OR REPLACE INTO targets (number, name, pic_url) VALUES (?, ?, ?)", [number, name, picUrl], async (err) => {
        if (!err && sockInstance) {
            await sockInstance.presenceSubscribe(number + '@s.whatsapp.net');
            res.json({ success: true, message: "Numara başarıyla eklendi!" });
        } else {
            res.json({ success: false });
        }
    });
});

// Logları Getirir
app.get('/api/logs', (req, res) => {
    // Logları isimlerle birleştirip getir
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

// --------------------------------------------------------
// 4. MOBİL UYUMLU PROFESYONEL WEB ARAYÜZÜ (FRONTEND)
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
        .code-display { font-size: 32px; font-weight: bold; color: #075E54; text-align: center; letter-spacing: 5px; margin: 20px 0; background: #e9edef; padding: 15px; border-radius: 8px;}
        
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
        <p style="font-size:14px; color:#666; text-align:center;">Botun çalışacağı numarayı girin.</p>
        <input type="text" id="botNumber" placeholder="Örn: 905321234567">
        <button onclick="getCode()">Eşleştirme Kodu Al</button>
        <div id="codeResult"></div>
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
    // Sayfa açıldığında botun durumunu kontrol et
    async function checkStatus() {
        const res = await fetch('/api/status');
        const data = await res.json();
        
        if (data.registered) {
            document.getElementById('loginSection').classList.remove('active-section');
            document.getElementById('dashboardSection').classList.add('active-section');
            loadTargets();
            loadLogs();
            setInterval(loadLogs, 10000); // Her 10 saniyede bir logları yenile
        } else {
            document.getElementById('loginSection').classList.add('active-section');
        }
    }

    // Kod İsteme API Çağrısı
    async function getCode() {
        const num = document.getElementById('botNumber').value;
        if(!num) return alert("Numara girin!");
        
        document.getElementById('codeResult').innerHTML = '<p>İsteniyor...</p>';
        const res = await fetch('/api/pair?phone=' + num);
        const data = await res.json();
        
        if(data.success) {
            document.getElementById('codeResult').innerHTML = '<div class="code-display">' + data.code + '</div><p style="text-align:center;">WhatsApp > Bağlı Cihazlar kısmına girin.</p>';
            // Kodu aldıktan sonra sürekli durumu kontrol et, bağlandığında paneli aç
            setInterval(() => { location.reload(); }, 5000);
        } else {
            alert(data.message);
        }
    }

    // Hedef Ekleme API Çağrısı
    async function addTarget() {
        const name = document.getElementById('targetName').value;
        const number = document.getElementById('targetNumber').value;
        if(!name || !number) return alert("Bilgileri doldurun!");

        const btn = event.target;
        btn.innerText = "Ekleniyor...";

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

    // Hedefleri Çekme
    async function loadTargets() {
        const res = await fetch('/api/targets');
        const targets = await res.json();
        let html = '';
        targets.forEach(t => {
            html += \`
                <div class="target-card">
                    <img src="\${t.pic_url}" alt="Profil">
                    <div class="target-info">
                        <h4>\${t.name}</h4>
                        <p>+\${t.number}</p>
                    </div>
                </div>
            \`;
        });
        document.getElementById('targetsList').innerHTML = html || '<p>Henüz takip edilen kimse yok.</p>';
    }

    // Logları Çekme
    async function loadLogs() {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        let html = '';
        logs.forEach(l => {
            const statusClass = l.status === 'available' ? 'online' : 'offline';
            const statusText = l.status === 'available' ? 'Çevrimiçi 🟢' : 'Çevrimdışı 🔴';
            const pic = l.pic_url || 'https://cdn.pixabay.com/photo/2015/10/05/22/37/blank-profile-picture-973460_960_720.png';
            const name = l.name || l.number;

            html += \`
                <div class="log-item">
                    <img src="\${pic}" alt="Profil">
                    <div>
                        <div style="font-weight:bold;">\${name}</div>
                        <div class="\${statusClass}">\${statusText}</div>
                        <div class="log-time">\${l.timestamp}</div>
                    </div>
                </div>
            \`;
        });
        document.getElementById('logsList').innerHTML = html || '<p style="padding:15px;">Hareket bekleniyor...</p>';
    }

    checkStatus();
</script>

</body>
</html>
    `);
});

app.listen(port, () => {
    console.log("Sunucu " + port + " portunda hazır.");
});
