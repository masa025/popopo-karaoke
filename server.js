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

// Simple room/session storage
// Map: roomId -> { streamerSocketId, scores: [], reactionsCount: 0 }
const rooms = new Map();

// Per-socket rate-limit buckets for reactions
// Map: socketId -> { count, windowStart }
const reactionBuckets = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Create or Join Room
  socket.on('join-room', ({ roomId, role }) => {
    socket.join(roomId);
    console.log(`User ${socket.id} joined room ${roomId} as ${role}`);

    if (role === 'streamer') {
      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          streamerSocketId: socket.id,
          scores: [],
          reactionsCount: 0,
          listenersCount: 0
        });
      } else {
        rooms.get(roomId).streamerSocketId = socket.id;
      }
      // Broadcast listener count to streamer
      const room = rooms.get(roomId);
      io.to(roomId).emit('room-status', {
        listenersCount: room.listenersCount
      });
    } else if (role === 'listener') {
      const room = rooms.get(roomId);
      if (room) {
        room.listenersCount++;
        io.to(roomId).emit('room-status', {
          listenersCount: room.listenersCount
        });
      }
    }
  });

  // Handle score updates from listener
  socket.on('score-update', ({ roomId, score }) => {
    // Broadcast to everyone in the room (especially the streamer)
    socket.to(roomId).emit('listener-score', {
      listenerId: socket.id,
      score: parseFloat(score)
    });
  });

  // Handle final overall score + heat sync from streamer to listeners
  socket.on('score-sync-relay', ({ roomId, score, heat }) => {
    socket.to(roomId).emit('global-score-sync', {
      score: parseFloat(score),
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

    // Broadcast reaction details to the streamer and other listeners
    socket.to(roomId).emit('listener-reaction', {
      listenerId: socket.id,
      reactionType
    });
  });

  // Relay song lifecycle events (start / end / final-result) from streamer to listeners
  socket.on('song-event', ({ roomId, event, payload }) => {
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
    // Decrement listenersCount when a listener leaves
    for (const roomId of socket.rooms) {
      const room = rooms.get(roomId);
      if (room) {
        if (socket.id === room.streamerSocketId) {
          // Streamer left - could notify listeners or clean up
          console.log(`Streamer left room ${roomId}`);
        } else {
          room.listenersCount = Math.max(0, room.listenersCount - 1);
          io.to(roomId).emit('room-status', {
            listenersCount: room.listenersCount
          });
        }
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
      // family can be 'IPv4' or 4 depending on Node version
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
  console.log(`Use the Network Access URL to connect your phone!`);
  console.log('==================================================');
});
