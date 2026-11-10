require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();

// ==========================================
// 1. BASE DE DONNÉES SQLITE (Persistance)
// ==========================================
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('Erreur ouverture DB SQLite', err.message);
  else console.log('Connecté à la base de données SQLite.');
});

db.run(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE,
  isVip INTEGER DEFAULT 0,
  vipExpiresAt INTEGER DEFAULT 0
)`);

// ==========================================
// 2. WEBHOOK STRIPE (DOIT ÊTRE AVANT express.json)
// ==========================================
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Erreur signature Webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Traitement du paiement réussi
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const customerEmail = session.customer_email || session.customer_details?.email || session.client_reference_id;

    if (customerEmail) {
      const expirationTime = Date.now() + (30 * 24 * 60 * 60 * 1000); 

      db.run(`INSERT INTO users (email, isVip, vipExpiresAt) VALUES (?, 1, ?) 
              ON CONFLICT(email) DO UPDATE SET isVip=1, vipExpiresAt=?`,
        [customerEmail, expirationTime, expirationTime], (err) => {
          if (err) console.error("Erreur mise à jour VIP DB:", err);
          else console.log(`[STRIPE WEBHOOK] Succès : L'utilisateur ${customerEmail} est désormais VIP.`);
        });
    }
  }

  res.json({ received: true });
});

// ==========================================
// 3. MIDDLEWARES GLOBAUX & ROUTES STATIQUES
// ==========================================
app.use(cors());
app.use(express.json());

// Dossier public : tout est directement à la racine
app.use(express.static(__dirname));

// Route pour générer le sitemap XML dynamiquement
app.get('/sitemap.xml', (req, res) => {
    res.header('Content-Type', 'application/xml');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const baseUrl = `${protocol}://${host}`;

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <url>
        <loc>${baseUrl}/</loc>
        <changefreq>daily</changefreq>
        <priority>1.0</priority>
    </url>
    <url>
        <loc>${baseUrl}/cgu.html</loc>
        <changefreq>monthly</changefreq>
        <priority>0.3</priority>
    </url>
    <url>
        <loc>${baseUrl}/privacy.html</loc>
        <changefreq>monthly</changefreq>
        <priority>0.3</priority>
    </url>
</urlset>`;
    res.send(sitemap);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/admin.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/cgu.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'cgu.html'));
});

app.get('/privacy.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'privacy.html'));
});

// ==========================================
// 4. API AUTH & PAIEMENT STRIPE
// ==========================================
app.post('/api/login', (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email requis" });

  db.run(`INSERT OR IGNORE INTO users (email, isVip, vipExpiresAt) VALUES (?, 0, 0)`, [email], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
      if (err || !user) return res.status(500).json({ error: "Erreur lecture DB" });
      const isVipActive = user.isVip === 1 && (user.vipExpiresAt === 0 || Date.now() < user.vipExpiresAt);
      res.json({ success: true, email: user.email, isVip: isVipActive });
    });
  });
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const { email } = req.body;
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');

    const sessionOptions = {
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID || 'price_1UZv382QyJFHgmvBhamAsCtx',
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${protocol}://${host}/?vip=true`,
      cancel_url: `${protocol}://${host}/?vip=canceled`,
    };

    if (email) {
      sessionOptions.customer_email = email;
      sessionOptions.client_reference_id = email;
    }

    const session = await stripe.checkout.sessions.create(sessionOptions);
    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// 5. SOCKET.IO & LOGIQUE CHAT / ADMIN
// ==========================================
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

const userReports = new Map();
const activeUsersList = new Map(); 
const BAN_THRESHOLD = 3;
const BAN_DURATION_MS = 15 * 60 * 1000;

let waitingUsers = {
  'all': [],
  'fr': [],
  'vip_women': [],
  'vip_usa': []
};

let onlineCount = 0;

function updateOnlineCount() {
  io.emit('online-count', onlineCount);
  broadcastAdminStats();
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : socket.handshake.address;
}

function broadcastAdminStats() {
  const vipCount = Array.from(activeUsersList.values()).filter(u => u.isVip).length;
  const stats = {
    onlineCount: activeUsersList.size,
    vipCount: vipCount,
    users: Array.from(activeUsersList.values())
  };
  io.emit('admin-stats-broadcast', stats);
}

io.on('connection', (socket) => {
  const clientIp = getClientIp(socket);

  const reportData = userReports.get(clientIp);
  if (reportData && reportData.bannedUntil && Date.now() < reportData.bannedUntil) {
    socket.emit('banned', { reason: "Vous êtes temporairement banni." });
    socket.disconnect(true);
    return;
  }

  onlineCount++;
  socket.blockedIds = new Set();
  socket.username = 'Visiteur';
  socket.isVip = false;

  activeUsersList.set(socket.id, {
    id: socket.id,
    username: socket.username,
    ip: clientIp,
    isVip: socket.isVip,
    connectedAt: new Date().toLocaleTimeString()
  });

  updateOnlineCount();

  socket.on('check-user-vip', (email) => {
    if (!email) return;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
      if (!err && user) {
        const active = user.isVip === 1 && (user.vipExpiresAt === 0 || Date.now() < user.vipExpiresAt);
        if (active) {
          socket.isVip = true;
          socket.userEmail = email;
          let userInfo = activeUsersList.get(socket.id);
          if (userInfo) userInfo.isVip = true;
          socket.emit('vip-status', { active: true });
          broadcastAdminStats();
        }
      }
    });
  });

  socket.on('admin-login', (password) => {
    const ADMIN_PWD = process.env.ADMIN_PASSWORD || 'camconnect2026';
    if (password === ADMIN_PWD) {
      socket.emit('admin-auth-success');
      const vipCount = Array.from(activeUsersList.values()).filter(u => u.isVip).length;
      socket.emit('admin-stats-update', {
        onlineCount: activeUsersList.size,
        vipCount: vipCount,
        users: Array.from(activeUsersList.values())
      });
    } else {
      socket.emit('admin-auth-error', "Mot de passe incorrect.");
    }
  });

  socket.on('admin-ban-user', (targetSocketId) => {
    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      const targetIp = getClientIp(targetSocket);
      userReports.set(targetIp, { count: BAN_THRESHOLD, bannedUntil: Date.now() + BAN_DURATION_MS, lastReason: "Banni directement par l'admin" });
      targetSocket.emit('banned', { reason: "Banni par l'administrateur." });
      targetSocket.disconnect(true);
      broadcastAdminStats();
    }
  });

  socket.on('claim-referral', (refCode) => {
    if (refCode) {
      socket.isVip = true;
      let userInfo = activeUsersList.get(socket.id);
      if (userInfo) userInfo.isVip = true;

      socket.emit('vip-granted', { hours: 48, reason: "Grâce à ton lien de parrainage !" });

      for (let [id, s] of io.sockets.sockets) {
        if (s.username === refCode) {
          s.isVip = true;
          let parrainInfo = activeUsersList.get(s.id);
          if (parrainInfo) parrainInfo.isVip = true;

          s.emit('vip-granted', { hours: 48, reason: `Un ami (${socket.username || 'Nouveau'}) a rejoint via ton lien !` });
          break;
        }
      }
      broadcastAdminStats();
    }
  });

  socket.on('find-match', (data) => {
    const lang = data.lang || 'all';
    const isVip = data.isVip || socket.isVip || false;
    socket.username = data.username || 'Inconnu';
    socket.isVip = isVip;

    let userInfo = activeUsersList.get(socket.id);
    if (userInfo) {
      userInfo.username = socket.username;
      userInfo.isVip = isVip;
    }
    broadcastAdminStats();

    if (lang.startsWith('vip_') && !isVip) return;

    let queue = waitingUsers[lang] || waitingUsers['all'];
    queue = queue.filter(s => s.connected && s.id !== socket.id);
    waitingUsers[lang] = queue;

    let partnerIndex = queue.findIndex(s => s.id !== socket.id && !socket.blockedIds.has(s.id) && !s.blockedIds.has(socket.id));

    if (partnerIndex !== -1) {
      const partner = queue.splice(partnerIndex, 1)[0];
      socket.partnerId = partner.id;
      partner.partnerId = socket.id;

      socket.emit('match-found', { partnerId: partner.id, initiate: true, partnerName: partner.username, partnerVip: partner.isVip });
      partner.emit('match-found', { partnerId: socket.id, initiate: false, partnerName: socket.username, partnerVip: socket.isVip });
    } else {
      if (!queue.some(s => s.id === socket.id)) queue.push(socket);
      socket.emit('waiting');
    }
  });

  socket.on('signal', (data) => {
    if (data.targetId) io.to(data.targetId).emit('signal', { senderId: socket.id, signal: data.signal });
  });

  socket.on('chat-message', (msg) => {
    if (socket.partnerId) io.to(socket.partnerId).emit('chat-message', msg);
  });

  // Gestion des messages privés entre amis récents
  socket.on('private-message', (data) => {
    if (data && data.targetId && data.message) {
      io.to(data.targetId).emit('private-message', {
        senderId: socket.id,
        senderName: socket.username,
        message: data.message
      });
    }
  });

  socket.on('typing', (isTyping) => {
    if (socket.partnerId) io.to(socket.partnerId).emit('typing', isTyping);
  });

  socket.on('add-friend', () => {
    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      if (partnerSocket) partnerSocket.emit('friend-request', { from: socket.id, name: socket.username });
    }
  });

  socket.on('accept-friend', (data) => {
    const requesterSocket = io.sockets.sockets.get(data.targetId);
    if (requesterSocket) {
      socket.emit('friend-added', { partnerId: data.targetId, partnerName: requesterSocket.username });
      requesterSocket.emit('friend-added', { partnerId: socket.id, partnerName: socket.username });
    }
  });

  socket.on('report-partner', (data) => {
    const reportReason = data && data.reason ? data.reason : "Non spécifié";

    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      socket.blockedIds.add(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.blockedIds.add(socket.id);
        const targetIp = getClientIp(partnerSocket);
        
        let targetData = userReports.get(targetIp) || { count: 0, bannedUntil: null, lastReason: '' };
        targetData.count += 1;
        targetData.lastReason = reportReason;

        if (targetData.count >= BAN_THRESHOLD) {
          targetData.bannedUntil = Date.now() + BAN_DURATION_MS;
          partnerSocket.emit('banned', { reason: `Banni pour : ${reportReason}` });
          partnerSocket.disconnect(true);
        }
        userReports.set(targetIp, targetData);
      }
    }
    handleDisconnect();
  });

  const handleDisconnect = () => {
    for (let key in waitingUsers) {
      waitingUsers[key] = waitingUsers[key].filter(s => s.id !== socket.id);
    }
    if (socket.partnerId) {
      io.to(socket.partnerId).emit('partner-disconnected');
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      if (partnerSocket) partnerSocket.partnerId = null;
      socket.partnerId = null;
    }
  };

  socket.on('next-partner', handleDisconnect);
  socket.on('disconnect', () => {
    handleDisconnect();
    activeUsersList.delete(socket.id);
    onlineCount = Math.max(0, onlineCount - 1);
    updateOnlineCount();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Serveur prêt sur http://localhost:${PORT}`);
});