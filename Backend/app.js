const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3001;
const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const MAX_ROOMS_PER_SOCKET = 6;
const ROOM_TTL_MS = 10 * 60 * 1000;
const rooms = new Map();
const roomTimers = new Map();
const roomBySocket = new Map();
const joinsBySocket = new Map();

const app = express();
app.get('/healthz', (_request, response) => {
  response.json({ status: 'ok' });
});

const server = http.createServer(app);
const configuredOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((origin) => origin.trim())
  : null;

if (process.env.NODE_ENV === 'production' && !configuredOrigins) {
  throw new Error('Set CORS_ORIGIN to the frontend origin before starting in production.');
}

const io = new Server(server, {
  cors: {
    origin: configuredOrigins || true,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 100_000,
});

function acknowledge(callback, result) {
  if (typeof callback === 'function') callback(result);
}

function validRoomCode(value) {
  return typeof value === 'string' && ROOM_CODE.test(value);
}

function getRoomPeers(roomCode, socketId) {
  const peerIds = rooms.get(roomCode);
  if (!peerIds) return [];
  return [...peerIds]
    .filter((peerId) => peerId !== socketId)
    .map((peerId) => {
      const peer = io.sockets.sockets.get(peerId);
      return peer
        ? { peerId, name: peer.data.displayName || 'Nearby device' }
        : null;
    })
    .filter(Boolean);
}

function leaveRoom(socket) {
  const roomCode = roomBySocket.get(socket.id);
  if (!roomCode) return;

  const peers = getRoomPeers(roomCode, socket.id);
  roomBySocket.delete(socket.id);
  rooms.get(roomCode)?.delete(socket.id);
  socket.leave(roomCode);

  for (const peer of peers) {
    io.to(peer.peerId).emit('peer-left', { peerId: socket.id });
  }

  if (rooms.get(roomCode)?.size === 0) {
    rooms.delete(roomCode);
    clearTimeout(roomTimers.get(roomCode));
    roomTimers.delete(roomCode);
  }
}

io.on('connection', (socket) => {
  socket.on('join-room', (payload, callback) => {
    const roomCode = payload?.roomCode;
    const displayName =
      typeof payload?.displayName === 'string'
        ? payload.displayName.trim().slice(0, 32)
        : '';

    if (!validRoomCode(roomCode)) {
      acknowledge(callback, { ok: false, error: 'Enter a valid 8-character room code.' });
      return;
    }

    if (roomBySocket.has(socket.id)) {
      acknowledge(callback, { ok: false, error: 'You are already in a room.' });
      return;
    }

    const joinCount = (joinsBySocket.get(socket.id) || 0) + 1;
    joinsBySocket.set(socket.id, joinCount);
    if (joinCount > MAX_ROOMS_PER_SOCKET) {
      acknowledge(callback, { ok: false, error: 'Too many room attempts. Reconnect and try again.' });
      return;
    }

    const peers = rooms.get(roomCode);
    if (peers && peers.size >= 2) {
      acknowledge(callback, { ok: false, error: 'This room is full. Ask for a new room code.' });
      return;
    }

    socket.data.displayName = displayName || 'Nearby device';
    const roomPeers = peers || new Set();
    if (!peers) {
      roomTimers.set(
        roomCode,
        setTimeout(() => {
          const members = rooms.get(roomCode);
          if (!members) return;
          for (const peerId of members) {
            const member = io.sockets.sockets.get(peerId);
            roomBySocket.delete(peerId);
            member?.leave(roomCode);
            member?.emit('room-expired');
          }
          rooms.delete(roomCode);
          roomTimers.delete(roomCode);
        }, ROOM_TTL_MS),
      );
    }
    roomPeers.add(socket.id);
    rooms.set(roomCode, roomPeers);
    roomBySocket.set(socket.id, roomCode);
    socket.join(roomCode);

    acknowledge(callback, {
      ok: true,
      peerId: socket.id,
      peers: getRoomPeers(roomCode, socket.id),
    });

    for (const peerId of roomPeers) {
      if (peerId !== socket.id) {
        io.to(peerId).emit('peer-joined', {
          peerId: socket.id,
          name: socket.data.displayName,
        });
      }
    }
  });

  for (const eventName of ['signal-offer', 'signal-answer']) {
    socket.on(eventName, (payload) => {
      const roomCode = roomBySocket.get(socket.id);
      const targetId = payload?.toPeerId;
      const description = payload?.description;
      if (
        !roomCode ||
        typeof targetId !== 'string' ||
        !rooms.get(roomCode)?.has(targetId) ||
        !description ||
        (description.type !== 'offer' && description.type !== 'answer') ||
        typeof description.sdp !== 'string' ||
        description.sdp.length > 80_000
      ) {
        return;
      }

      io.to(targetId).emit(eventName, {
        fromPeerId: socket.id,
        description,
      });
    });
  }

  socket.on('ice-candidate', (payload) => {
    const roomCode = roomBySocket.get(socket.id);
    const targetId = payload?.toPeerId;
    const candidate = payload?.candidate;
    if (
      !roomCode ||
      typeof targetId !== 'string' ||
      !rooms.get(roomCode)?.has(targetId) ||
      !candidate ||
      typeof candidate.candidate !== 'string' ||
      candidate.candidate.length > 4_096
    ) {
      return;
    }

    io.to(targetId).emit('ice-candidate', {
      fromPeerId: socket.id,
      candidate,
    });
  });

  socket.on('leave-room', () => leaveRoom(socket));
  socket.on('disconnect', () => {
    leaveRoom(socket);
    joinsBySocket.delete(socket.id);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`P2P signaling server listening on port ${PORT}`);
});
