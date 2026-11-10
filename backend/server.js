require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

// Utilisation d'une variable d'environnement pour plus de sécurité
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Comme Root Directory est sur backend/, on sert le static depuis le dossier parent ou en mettant frontend ailleurs. 
// Mais le plus simple : si ton frontend est à la racine, on remonte d'un cran :
app.use(express.static(path.join(__dirname, '../frontend')));

// Route pour accéder au Dashboard Admin sécurisé (/admin)
// Vu que admin.html est maintenant DANS le dossier backend, on pointe directement dessus :
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin.html'));
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.post('/create-checkout-session', async (req, res) => {
  try {
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price: process.env.STRIPE_PRICE_ID || 'price_1UZv382QyJFHgmvBhamAsCtx',
          quantity: 1,
        },
      ],
      mode: 'subscription',
      success_url: `${protocol}://${host}/?vip=true`,
      cancel_url: `${protocol}://${host}/?vip=canceled`,
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const userReports = new Map();
const vipUsers = new Map(); // Stocke l'expiration du VIP par IP
const activeUsersList = new Map(); // Suivi des utilisateurs pour le panel admin
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

// Fonction pour envoyer les stats en temps réel aux admins connectés
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

  // Vérification du bannissement
  const reportData = userReports.get(clientIp);
  if (reportData && reportData.bannedUntil && Date.now() < reportData.bannedUntil) {
    socket.emit('banned', { reason: "Vous êtes temporairement banni." });
    socket.disconnect(true);
    return;
  }

  // Vérification si l'IP a un VIP temporaire actif (parrainage)
  if (vipUsers.has(clientIp)) {
    if (Date.now() < vipUsers.get(clientIp)) {
      socket.isVip = true;
      socket.emit('vip-status', { active: true });
    } else {
      vipUsers.delete(clientIp); // Expiré
    }
  }

  onlineCount++;
  socket.blockedIds = new Set();
  socket.username = 'Visiteur';

  // Enregistrement de l'utilisateur pour le dashboard admin
  activeUsersList.set(socket.id, {
    id: socket.id,
    username: socket.username,
    ip: clientIp,
    isVip: socket.isVip || false,
    connectedAt: new Date().toLocaleTimeString()
  });

  updateOnlineCount();

  // --- ÉVÉNEMENTS ADMIN ---
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
      userReports.set(targetIp, { count: BAN_THRESHOLD, bannedUntil: Date.now() + BAN_DURATION_MS });
      targetSocket.emit('banned', { reason: "Banni par l'administrateur." });
      targetSocket.disconnect(true);
      broadcastAdminStats();
    }
  });
  // -------------------------

  // Gestion du parrainage (48h de VIP pour les deux)
  socket.on('claim-referral', (refCode) => {
    if (refCode) {
      const expirationTime = Date.now() + (48 * 60 * 60 * 1000); // 48 heures

      // 1. Donne 48h de VIP au filleul
      socket.isVip = true;
      vipUsers.set(clientIp, expirationTime);
      
      let userInfo = activeUsersList.get(socket.id);
      if (userInfo) userInfo.isVip = true;

      socket.emit('vip-granted', { hours: 48, reason: "Grâce à ton lien de parrainage !" });

      // 2. Cherche le parrain s'il est en ligne
      for (let [id, s] of io.sockets.sockets) {
        if (s.username === refCode) {
          const parrainIp = getClientIp(s);
          vipUsers.set(parrainIp, expirationTime);
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

    // Met à jour le pseudo et le statut VIP dans la liste admin
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

  socket.on('report-partner', () => {
    if (socket.partnerId) {
      const partnerSocket = io.sockets.sockets.get(socket.partnerId);
      socket.blockedIds.add(socket.partnerId);
      if (partnerSocket) {
        partnerSocket.blockedIds.add(socket.id);
        const targetIp = getClientIp(partnerSocket);
        let targetData = userReports.get(targetIp) || { count: 0, bannedUntil: null };
        targetData.count += 1;
        if (targetData.count >= BAN_THRESHOLD) {
          targetData.bannedUntil = Date.now() + BAN_DURATION_MS;
          partnerSocket.emit('banned', { reason: "Banni pour comportement inapproprié." });
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