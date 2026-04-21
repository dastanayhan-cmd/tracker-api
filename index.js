const express = require('express');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const fs = require('fs');
const pino = require('pino');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

let botStatus = 'Sistem Başlatılıyor...';
let pairingCode = '';
let trackedNumber = ''; 
let logs = [];
let sockInstance = null;
let isConnected = false;

// Logları ve Hedef Numarayı dosyadan çek (Sunucu uyuyup uyanırsa unutmaması için)
if (fs.existsSync('logs.json')) {
    logs = JSON.parse(fs.readFileSync('logs.json'));
}
if (fs.existsSync('target.txt')) {
    trackedNumber = fs.readFileSync('target.txt', 'utf8');
}

async function connectToWhatsApp(botPhoneNumber = null) {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: Browsers.ubuntu('Chrome') 
    });

    sockInstance = sock;
    sock.ev.on('creds.update', saveCreds);

    if (!sock.authState.creds.registered && botPhoneNumber) {
        botStatus = 'Eşleştirme kodu talep ediliyor, lütfen bekleyin...';
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(botPhoneNumber);
                pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
                botStatus = 'Kod alındı! WhatsApp > Bağlı Cihazlar kısmına bu kodu girin.';
            } catch (error) {
                botStatus = 'Kod alınamadı. Numarayı doğru girdiğinizden emin olun.';
            }
        }, 2000);
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            isConnected = false;
            
            if (shouldReconnect) {
                botStatus = 'Bağlantı koptu. Yeniden bağlanılıyor...';
                setTimeout(() => connectToWhatsApp(), 3000);
            } else {
                botStatus = 'WhatsApp çıkışı yapıldı. Sistemi baştan kurmanız gerek.';
                pairingCode = '';
            }
        } else if (connection === 'open') {
            isConnected = true;
            botStatus = 'Bot Başarıyla Bağlandı ve Çalışıyor 🟢';
            pairingCode = '';
            
            if (trackedNumber) {
                await sock.presenceSubscribe(`${trackedNumber}@s.whatsapp.net`);
            }
        }
    });

    // Çevrimiçi/Çevrimdışı ve SON GÖRÜLME Dinleyici
    sock.ev.on('presence.update', (json) => {
        const id = json.id.split('@')[0];
        
        if (trackedNumber && id === trackedNumber) {
            const presenceInfo = json.presences[id];
            const status = presenceInfo?.lastKnownPresence;
            const lastSeenTimestamp = presenceInfo?.lastSeen; // Son görülme verisi
            
            if (status === 'available' || status === 'unavailable') {
                const isOnline = status === 'available';
                let statusText = isOnline ? 'Çevrimiçi 🟢' : 'Çevrimdışı 🔴';
                
                // Karşı taraf çevrimdışıysa ve gizlilik ayarları izin veriyorsa son görülmeyi ekle
                if (!isOnline && lastSeenTimestamp) {
                    const lastSeenDate = new Date(lastSeenTimestamp * 1000).toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                    statusText += ` (Son Görülme: ${lastSeenDate})`;
                }
                
                const time = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
                const logEntry = `${time} - ${statusText}`;
                
                // Aynı veriyi üst üste yazmasını engelle
                if (logs[0] !== logEntry) { 
                    logs.unshift(logEntry);
                    if (logs.length > 100) logs.pop();
                    fs.writeFileSync('logs.json', JSON.stringify(logs));
                }
            }
        }
    });
    
    return sock;
}

connectToWhatsApp();

app.get('/', (req, res) => {
    let logHtml = logs.map(l => `<li style="padding: 8px; border-bottom: 1px solid #eee;">${l}</li>`).join('');
    
    let htmlContent = `
        <html>
        <head>
            <title>WP Tracker Panel</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="refresh" content="30"> <style>
                body { font-family: Arial, sans-serif; background-color: #f4f4f9; padding: 20px; }
                .container { background: white; padding: 20px; border-radius: 10px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); max-width: 600px; margin: auto; }
                input, button { padding: 12px; margin-top: 10px; width: 100%; box-sizing: border-box; border-radius: 5px; border: 1px solid #ccc; font-size: 16px; }
                button { background-color: #25D366; color: white; border: none; font-weight: bold; cursor: pointer; }
                .code-box { font-size: 32px; font-weight: bold; letter-spacing: 5px; color: #075E54; background: #e9edef; padding: 15px; border-radius: 8px; text-align: center; margin: 15px 0; }
                ul { list-style: none; padding: 0; }
            </style>
        </head>
        <body>
            <div class="container">
                <h2 style="text-align: center;">WhatsApp Tracker Paneli</h2>
                <div style="background: #f8f9fa; padding: 10px; border-left: 4px solid #007bff; margin-bottom: 20px;">
                    <p style="margin: 0; font-size: 14px;"><strong>Durum:</strong> ${botStatus}</p>
                </div>
    `;

    if (!isConnected) {
        htmlContent += `
                <form method="POST" action="/get-code">
                    <label><strong>Botun Kurulacağı Kendi Numaranız:</strong></label>
                    <input type="text" name="botNumber" placeholder="90532..." required>
                    <button type="submit">Eşleştirme Kodu Al</button>
                    <p style="font-size: 12px; color: #666;">Başında + olmadan, ülke koduyla bitişik yazın.</p>
                </form>
        `;
        if (pairingCode) {
            htmlContent += `
                <div class="code-box">${pairingCode}</div>
                <p style="text-align: center; font-size: 14px; color: #555;">Kodu görmek için sayfayı arada bir yenileyebilirsiniz.</p>
            `;
        }
    } else {
        htmlContent += `
                <form method="POST" action="/track">
                    <label><strong>Takip Edilecek Numara:</strong></label>
                    <input type="text" name="number" value="${trackedNumber}" placeholder="90533..." required>
                    <button type="submit">Hedefi Ayarla & Takibi Başlat</button>
                    <p style="font-size: 12px; color: #666;">Numara değiştirirseniz yeni numara kalıcı olarak kaydedilir.</p>
                </form>

                <h3>Son Hareketler (Otomatik Yenilenir)</h3>
                <div style="max-height: 400px; overflow-y: auto; background: #fafafa; border: 1px solid #ddd; border-radius: 5px;">
                    <ul>
                        ${logHtml || '<li style="padding: 10px; text-align: center;">Henüz kayıt yok. (Eğer numara çevrimiçi olmuyorsa veya gizlilik ayarları kapalıysa burası boş kalır.)</li>'}
                    </ul>
                </div>
            </div>
        </body>
        </html>
    `;
    }

    res.send(htmlContent);
});

app.post('/get-code', (req, res) => {
    let botNum = req.body.botNumber.replace(/\D/g, ''); 
    connectToWhatsApp(botNum); 
    setTimeout(() => res.redirect('/'), 3000); 
});

app.post('/track', async (req, res) => {
    trackedNumber = req.body.number.replace(/\D/g, ''); 
    // Hedef numarayı sunucu uyusa bile hatırlaması için dosyaya yazıyoruz
    fs.writeFileSync('target.txt', trackedNumber); 
    
    if (sockInstance && trackedNumber) {
        await sockInstance.presenceSubscribe(`${trackedNumber}@s.whatsapp.net`);
    }
    res.redirect('/');
});

app.listen(port, () => {
    console.log(`Sistem ${port} portunda çalışıyor.`);
});
        
