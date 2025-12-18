/**
 * CLIPBOARD FLY - WebSocket Signaling Server
 * Zero-Knowledge Architecture - Server never sees plaintext data
 */

const { WebSocketServer } = require('ws');
const { createServer } = require('http');

const server = createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Clipboard Fly WebSocket Server');
});

const wss = new WebSocketServer({ server });

// Room Management
const rooms = new Map();
const SESSION_TIMEOUT = 15 * 60 * 1000; // 15 minutes
const MAX_ROOM_SIZE = 2;
const CLEANUP_INTERVAL = 60 * 1000;

class Room {
  constructor(roomId) {
    this.id = roomId;
    this.clients = new Map();
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.timeoutId = null;
    this.startTimeout();
  }

  startTimeout() {
    this.clearTimeout();
    this.timeoutId = setTimeout(() => this.expire(), SESSION_TIMEOUT);
  }

  clearTimeout() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  touch() {
    this.lastActivity = Date.now();
    this.startTimeout();
  }

  addClient(peerId, ws) {
    if (this.clients.size >= MAX_ROOM_SIZE) return false;
    this.clients.set(peerId, ws);
    this.touch();
    return true;
  }

  removeClient(peerId) {
    this.clients.delete(peerId);
    if (this.clients.size === 0) this.destroy();
  }

  broadcast(message, excludePeerId = null) {
    this.touch();
    this.clients.forEach((ws, peerId) => {
      if (peerId !== excludePeerId && ws.readyState === 1) {
        ws.send(JSON.stringify(message));
      }
    });
  }

  getClientCount() {
    return this.clients.size;
  }

  expire() {
    this.broadcast({ type: 'session_expired', reason: 'timeout' });
    this.destroy();
  }

  destroy() {
    this.clearTimeout();
    this.clients.forEach((ws) => {
      if (ws.readyState === 1) ws.close(1000, 'Room closed');
    });
    this.clients.clear();
    rooms.delete(this.id);
    console.log(`[Room ${this.id.slice(0, 8)}...] Destroyed`);
  }
}

function generatePeerId() {
  return require('crypto').randomBytes(16).toString('hex');
}

function validateMessage(data) {
  return data && typeof data === 'object' && data.type && typeof data.type === 'string';
}

// WebSocket Handling
wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[Connection] New client from ${clientIp}`);

  let currentRoom = null;
  let peerId = generatePeerId();

  ws.send(JSON.stringify({ type: 'connected', peerId }));

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (!validateMessage(message)) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      return;
    }

    switch (message.type) {
      case 'create_room': {
        if (!message.pinHash || typeof message.pinHash !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'PIN hash required' }));
          return;
        }

        const roomId = message.pinHash;

        if (rooms.has(roomId)) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room already exists. Try a different PIN.' }));
          return;
        }

        const room = new Room(roomId);
        room.addClient(peerId, ws);
        rooms.set(roomId, room);
        currentRoom = room;

        console.log(`[Room ${roomId.slice(0, 8)}...] Created`);
        ws.send(JSON.stringify({ type: 'room_created', roomId, timeout: SESSION_TIMEOUT }));
        break;
      }

      case 'join_room': {
        if (!message.pinHash || typeof message.pinHash !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'PIN hash required' }));
          return;
        }

        const roomId = message.pinHash;
        const room = rooms.get(roomId);

        if (!room) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check your PIN.' }));
          return;
        }

        if (room.getClientCount() >= MAX_ROOM_SIZE) {
          ws.send(JSON.stringify({ type: 'error', message: 'Room is full.' }));
          return;
        }

        room.addClient(peerId, ws);
        currentRoom = room;

        console.log(`[Room ${roomId.slice(0, 8)}...] Peer joined`);

        ws.send(JSON.stringify({
          type: 'room_joined',
          roomId,
          peerCount: room.getClientCount(),
          timeout: SESSION_TIMEOUT
        }));

        room.broadcast({ type: 'peer_joined', peerId, peerCount: room.getClientCount() }, peerId);
        break;
      }

      case 'clipboard': {
        if (!currentRoom) {
          ws.send(JSON.stringify({ type: 'error', message: 'Not in a room' }));
          return;
        }

        if (!message.encrypted || typeof message.encrypted !== 'string') {
          ws.send(JSON.stringify({ type: 'error', message: 'Encrypted data required' }));
          return;
        }

        currentRoom.broadcast({ type: 'clipboard', encrypted: message.encrypted, fromPeer: peerId }, peerId);
        console.log(`[Room ${currentRoom.id.slice(0, 8)}...] Clipboard relayed`);
        break;
      }

      case 'ping': {
        if (currentRoom) currentRoom.touch();
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }

      case 'leave': {
        if (currentRoom) {
          currentRoom.broadcast({ type: 'peer_left', peerId, peerCount: currentRoom.getClientCount() - 1 }, peerId);
          currentRoom.removeClient(peerId);
          currentRoom = null;
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    console.log(`[Connection] Client ${peerId.slice(0, 8)}... disconnected`);
    if (currentRoom) {
      currentRoom.broadcast({ type: 'peer_left', peerId, peerCount: currentRoom.getClientCount() - 1 }, peerId);
      currentRoom.removeClient(peerId);
    }
  });

  ws.on('error', (error) => console.error(`[Error] ${peerId.slice(0, 8)}...:`, error.message));
});

// Cleanup
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (now - room.createdAt > SESSION_TIMEOUT + 60000) {
      console.log(`[Cleanup] Removing stale room ${roomId.slice(0, 8)}...`);
      room.destroy();
    }
  });
}, CLEANUP_INTERVAL);

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Clipboard Fly Server running on port ${PORT}`);
});

process.on('SIGTERM', () => {
  console.log('[Shutdown] Closing...');
  rooms.forEach(room => room.destroy());
  server.close(() => process.exit(0));
});
