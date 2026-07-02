const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for SPA behavior
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Room storage
// Map: roomId -> { streamerSocketId, songTitle, singerName, listenersCount, isLive, createdAt }
const rooms = new Map();

// Per-socket rate-limit buckets for reactions
const reactionBuckets = new Map();

// Room ID generation (unambiguous characters, 4 chars: readable & typeable on phones)
const ROOM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function generateRoomId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 4; i++) {
      id += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    }
    if (!rooms.has(id)) return id;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-5);
}

function sanitizeText(value, maxLen) {
  return String(value || '').replace(/[<>]/g, '').trim().slice(0, maxLen);
}

function publicRoomInfo(room) {
  return {
    songTitle: room.songTitle,
    singerName: room.singerName,
    isLive: room.isLive,
    listenersCount: room.listenersCount,
    donmaiEnabled: !!room.donmaiEnabled
  };
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Streamer creates a brand-new room with a generated code
  socket.on('create-room', (data, callback) => {
    const songTitle = sanitizeText(data && data.songTitle, 60) || 'アカペラライブ';
    const singerName = sanitizeText(data && data.singerName, 30);
    const roomId = generateRoomId();

    rooms.set(roomId, {
      streamerSocketId: socket.id,
      songTitle,
      singerName,
      listenersCount: 0,
      isLive: false,
      donmaiEnabled: !!(data && data.donmaiEnabled),
      createdAt: Date.now()
    });
    socket.join(roomId);
    console.log(`Room ${roomId} created by ${socket.id} (${songTitle})`);

    if (typeof callback === 'function') {
      callback({ ok: true, roomId, room: publicRoomInfo(rooms.get(roomId)) });
    }
  });

  // Join a room (listener joining, or streamer re-joining after reload / server restart)
  socket.on('join-room', (data, callback) => {
    const roomId = sanitizeText(data && data.roomId, 8).toUpperCase();
    const role = data && data.role;
    let room = rooms.get(roomId);

    if (role === 'streamer') {
      if (!room) {
        // Re-create the room (page reload after server restart, etc.)
        room = {
          streamerSocketId: socket.id,
          songTitle: sanitizeText(data && data.songTitle, 60) || 'アカペラライブ',
          singerName: sanitizeText(data && data.singerName, 30),
          listenersCount: 0,
          isLive: false,
          donmaiEnabled: !!(data && data.donmaiEnabled),
          createdAt: Date.now()
        };
        rooms.set(roomId, room);
      } else {
        room.streamerSocketId = socket.id;
        if (data && data.songTitle) room.songTitle = sanitizeText(data.songTitle, 60);
        if (data && data.singerName) room.singerName = sanitizeText(data.singerName, 30);
        if (data && typeof data.donmaiEnabled !== 'undefined') room.donmaiEnabled = !!data.donmaiEnabled;
      }
      socket.join(roomId);
      if (typeof callback === 'function') {
        callback({ ok: true, roomId, room: publicRoomInfo(room) });
      }
      io.to(roomId).emit('room-status', {
        listenersCount: room.listenersCount,
        streamerOnline: true
      });
      return;
    }

    // Listener
    if (!room) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: 'ルームが見つかりません。コードを確認してください。' });
      }
      return;
    }

    socket.join(roomId);
    room.listenersCount++;
    if (typeof callback === 'function') {
      callback({ ok: true, roomId, room: publicRoomInfo(room) });
    }
    io.to(roomId).emit('room-status', {
      listenersCount: room.listenersCount,
      streamerOnline: !!room.streamerSocketId
    });
  });

  // Handle final overall score + heat sync from streamer to listeners
  socket.on('score-sync-relay', ({ roomId, score, heat }) => {
    socket.to(roomId).emit('global-score-sync', {
      score: parseFloat(score) || 0,
      heat: parseFloat(heat) || 0
    });
  });

  // Handle emoji/particle reactions from listener (rate-limited: max 10/sec per socket)
  socket.on('reaction-send', ({ roomId, reactionType }) => {
    const now = Date.now();
    let bucket = reactionBuckets.get(socket.id);
    if (!bucket || now - bucket.windowStart > 1000) {
      bucket = { count: 0, windowStart: now };
      reactionBuckets.set(socket.id, bucket);
    }
    if (bucket.count >= 10) return; // Drop spam silently
    bucket.count++;

    socket.to(roomId).emit('listener-reaction', {
      listenerId: socket.id,
      reactionType
    });
  });

  // Relay song lifecycle events (start / end / final-result) - streamer only
  socket.on('song-event', ({ roomId, event, payload }) => {
    const room = rooms.get(roomId);
    if (room && socket.id !== room.streamerSocketId) return; // Only the streamer may emit
    if (room) {
      if (event === 'song-start') room.isLive = true;
      if (event === 'song-end') room.isLive = false;
    }
    socket.to(roomId).emit('song-event', { event, payload: payload || {} });
  });

  // Relay final star rating from listener to streamer
  socket.on('final-rating', ({ roomId, stars }) => {
    socket.to(roomId).emit('final-rating', {
      listenerId: socket.id,
      stars: Math.max(1, Math.min(5, parseInt(stars) || 0))
    });
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      const room = rooms.get(roomId);
      if (!room) continue;

      if (socket.id === room.streamerSocketId) {
        // Streamer left: notify listeners, clean up the room if they don't return
        room.streamerSocketId = null;
        socket.to(roomId).emit('room-status', {
          listenersCount: room.listenersCount,
          streamerOnline: false
        });
        setTimeout(() => {
          const r = rooms.get(roomId);
          if (r && !r.streamerSocketId) {
            rooms.delete(roomId);
            console.log(`Room ${roomId} cleaned up (streamer did not return)`);
          }
        }, 10 * 60 * 1000);
      } else {
        room.listenersCount = Math.max(0, room.listenersCount - 1);
        io.to(roomId).emit('room-status', {
          listenersCount: room.listenersCount,
          streamerOnline: !!room.streamerSocketId
        });
      }
    }
  });

  socket.on('disconnect', () => {
    reactionBuckets.delete(socket.id);
    console.log(`User disconnected: ${socket.id}`);
  });
});

// Helper function to resolve local IPv4 address
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('==================================================');
  console.log(`POPOPO Scoring Server is running on:`);
  console.log(`- Local Access:   http://localhost:${PORT}`);
  console.log(`- Network Access: http://${localIP}:${PORT}`);
  console.log('==================================================');
});
