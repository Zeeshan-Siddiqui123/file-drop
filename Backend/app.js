const express = require('express');
const http = require('node:http');
const { createHmac, randomBytes } = require('node:crypto');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3001;
const ROOM_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
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
  ? process.env.CORS_ORIGIN.split(',').map((origin) => {
    try {
      return new URL(origin.trim()).origin;
    } catch {
      throw new Error(`Invalid origin in CORS_ORIGIN: ${origin}`);
    }
  })
  : null;
const turnUrls = process.env.TURN_URLS
  ? process.env.TURN_URLS.split(',').map((url) => url.trim()).filter(Boolean)
  : [];
const turnSharedSecret = process.env.TURN_SHARED_SECRET;
const meteredDomain = process.env.METERED_DOMAIN;
const meteredTurnApiKey = process.env.METERED_TURN_API_KEY;
const turnCredentialTtlSeconds = Number(process.env.TURN_CREDENTIAL_TTL_SECONDS) || 3600;

if (Boolean(meteredDomain) !== Boolean(meteredTurnApiKey)) {
  throw new Error('Set both METERED_DOMAIN and METERED_TURN_API_KEY to use Metered TURN.');
}
if (meteredDomain) {
  let parsedMeteredDomain;
  try {
    parsedMeteredDomain = new URL(meteredDomain);
  } catch {
    throw new Error('METERED_DOMAIN must be a valid HTTPS origin.');
  }
  if (parsedMeteredDomain.protocol !== 'https:' || parsedMeteredDomain.pathname !== '/' || parsedMeteredDomain.search || parsedMeteredDomain.hash) {
    throw new Error('METERED_DOMAIN must be an HTTPS origin without a path, query, or fragment.');
  }
}
if (meteredTurnApiKey && (turnUrls.length > 0 || turnSharedSecret)) {
  throw new Error('Configure either Metered TURN credentials or TURN_URLS/TURN_SHARED_SECRET, not both.');
}
if (turnUrls.length > 0 && !turnSharedSecret) {
  throw new Error('Set TURN_SHARED_SECRET when TURN_URLS is configured.');
}
if (turnUrls.some((url) => !/^turns?:/i.test(url))) {
  throw new Error('TURN_URLS must contain only turn: or turns: URLs.');
}
if (!Number.isInteger(turnCredentialTtlSeconds) || turnCredentialTtlSeconds < 60 || turnCredentialTtlSeconds > 86_400) {
  throw new Error('TURN_CREDENTIAL_TTL_SECONDS must be an integer between 60 and 86400.');
}

if (process.env.NODE_ENV === 'production' && !configuredOrigins) {
  throw new Error('Set CORS_ORIGIN to the frontend origin before starting in production.');
}

app.get('/ice-servers', async (request, response) => {
  const requestOrigin = request.get('origin');
  if (requestOrigin) {
    let normalizedOrigin;
    try {
      normalizedOrigin = new URL(requestOrigin).origin;
    } catch {
      response.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }
    if (configuredOrigins && !configuredOrigins.includes(normalizedOrigin)) {
      response.status(403).json({ error: 'Origin is not allowed.' });
      return;
    }
    response.set('Access-Control-Allow-Origin', normalizedOrigin);
    response.vary('Origin');
  } else if (process.env.NODE_ENV === 'production') {
    response.status(403).json({ error: 'An allowed browser origin is required.' });
    return;
  }

  if (meteredDomain && meteredTurnApiKey) {
    try {
      const credentialUrl = new URL('/api/v1/turn/credentials', meteredDomain);
      credentialUrl.searchParams.set('apiKey', meteredTurnApiKey);
      const providerResponse = await fetch(credentialUrl, { signal: AbortSignal.timeout(10_000) });
      if (!providerResponse.ok) {
        response.status(502).json({ error: `TURN provider returned HTTP ${providerResponse.status}.` });
        return;
      }
      const iceServers = await providerResponse.json();
      if (
        !Array.isArray(iceServers) ||
        iceServers.length === 0 ||
        iceServers.some((iceServer) =>
          !iceServer ||
          (typeof iceServer.urls !== 'string' && !Array.isArray(iceServer.urls)) ||
          (iceServer.username !== undefined && typeof iceServer.username !== 'string') ||
          (iceServer.credential !== undefined && typeof iceServer.credential !== 'string'),
        )
      ) {
        response.status(502).json({ error: 'TURN provider returned invalid ICE server configuration.' });
        return;
      }
      response.set('Cache-Control', 'no-store');
      response.json({ iceServers });
      return;
    } catch (error) {
      console.error('Could not retrieve TURN configuration from the provider:', error.message);
      response.status(502).json({ error: 'Could not retrieve TURN configuration from the provider.' });
      return;
    }
  }

  const iceServers = [...DEFAULT_ICE_SERVERS];
  if (turnUrls.length > 0 && turnSharedSecret) {
    const expiresAt = Math.floor(Date.now() / 1000) + turnCredentialTtlSeconds;
    const username = `${expiresAt}:${randomBytes(12).toString('hex')}`;
    const credential = createHmac('sha1', turnSharedSecret).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }
  response.set('Cache-Control', 'no-store');
  response.json({ iceServers });
});

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
