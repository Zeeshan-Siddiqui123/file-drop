# P2P File Transfer (Mobile ↔ PC) – Working Plan

Oct 29, 2026 · @Zeeshu

## Overview

The goal is a browser-based tool that sends video files between a mobile phone and a PC, usually over the same local Wi-Fi, with no USB, Bluetooth, WhatsApp or app install. Hosting and relay costs depend on provider limits and whether TURN is needed.

The files travel directly from device to device using WebRTC when a direct connection is possible, so no cloud storage or server-side file upload is needed. A small Node.js server helps the two devices find each other and relays signaling messages. If a TURN relay is required, file data may pass through that relay and incur bandwidth costs.

| Item | Choice | Cost |
| --- | --- | --- |
| Frontend | React + Vite | Free |
| Frontend hosting | Vercel (or Netlify / GitHub Pages) | Free tier; check current limits |
| Signaling server | Node.js + Express + Socket.IO | Free |
| Backend hosting | Render.com web service (or Railway / Fly.io) | Free tier; check current limits |
| Connection setup | Google public STUN server | Free |
| File storage and bandwidth | Direct peer-to-peer when possible; TURN may relay data | Depends on network and provider |

## Architecture

The transfer has two phases: a short signaling handshake through the server, then a direct browser-to-browser data channel.

&#91;embedded content: architecture · 2 browsers, 1 signaling server\]

1. **Signaling phase.** Both browsers connect to the Node.js server over Socket.IO and join a short-lived room using a code or QR link. The server routes the offer, answer and ICE candidates only to the intended peer. Do not use a shared public IP address as proof that devices belong to the same Wi-Fi or should be paired.
2. **P2P transfer phase.** Once the handshake completes, the sender streams the file over an RTCDataChannel as binary ArrayBuffers. The signaling server is no longer involved; a TURN server, if selected by ICE, may relay the file data.
3. **STUN and TURN.** Each browser can use Google's public STUN server (`stun:stun.l.google.com:19302`) to discover a possible route. STUN alone does not work on every network. A TURN relay may be needed on restrictive networks and can incur costs.

## Phase 1: Signaling server (Node.js)

Phase 1 delivers a small server that manages temporary pairing rooms and routes handshake messages between specific peers.

1. Create the project and install dependencies:

```bash
npm init -y
npm install express socket.io
```

2. Create `app.js` with Express providing a health-check endpoint and Socket.IO attached to the HTTP server. The Vite frontend runs separately in development and is deployed as a static site in production.
3. Let a user create or join a short-lived, high-entropy room with a code shared through a QR code or manual entry. The app uses eight-character codes, limits rooms to two peers and expires rooms after ten minutes. Do not derive room membership from client IP addresses: unrelated users can share a public IP, and devices on one Wi-Fi can appear with different addresses.
4. Assign each connected socket a peer ID, validate room membership and message shape, and relay signaling messages only to their specified peer. Define these events:

| Event | Purpose | Sent by |
| --- | --- | --- |
| `join-room` | Join a room and list available peers | Both |
| `signal-offer` | Carry the WebRTC offer (SDP) | Sender |
| `signal-answer` | Carry the WebRTC answer (SDP) | Receiver |
| `ice-candidate` | Carry network route candidates to a specific peer | Both |

5. Notify peers when someone joins or leaves and clean up on disconnect or timeout. Queue incoming ICE candidates until the remote description is set, and prevent duplicate or conflicting offer negotiations.

**Done when:** two browser tabs can pair using a room code, see only peers in that room, exchange targeted test messages, and recover cleanly when a peer disconnects.

## Phase 2: Frontend and WebRTC engine

Phase 2 delivers a web page that connects two browsers and moves a file between them in chunks.

1. Build the React + Vite UI: room creation and entry, a QR invite, a file picker, a progress bar, and receiver approval.
2. Connect to the signaling server with the Socket.IO client and send `join-room` on load.
3. Configure the peer connection with the free Google STUN server:

```js
const peerConfig = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};
```

4. Peer A (the sender) creates the `RTCPeerConnection`, opens an `RTCDataChannel`, and sends the offer. Peer B (the receiver) sets an `ondatachannel` listener and replies with the answer. Both exchange ICE candidates through the server, queueing candidates until the remote description is ready.
5. **Sending:** use modest chunks (start around 16 KiB, then test on target browsers) rather than assuming a 64 KiB message is supported everywhere. Define explicit framing for metadata, file chunks and completion; include a transfer ID, file name, declared size and type in metadata.
6. **Flow control:** pause sending when `dataChannel.bufferedAmount` passes a threshold and resume on the `bufferedamountlow` event. This bounds queued outgoing data, but does not bound memory used by received chunks.
7. **Receiving and completion:** validate metadata and chunk order/size, count received bytes, and accept completion only when the received byte count matches the declared size. Handle cancellation, disconnects and incomplete transfers without presenting them as successful.
8. **Large-file storage:** use the File System Access save picker to stream directly to disk where supported. Other browsers buffer the received file in memory and are limited to 128 MiB. The app caps files at 2 GiB and requires target-device testing before claiming the several-hundred-MB goal. Document browser-specific save/download behavior.

**Done when:** the supported file-size target transfers from phone to PC on the same Wi-Fi, the received byte count matches, and the video plays correctly. Do not claim a several-hundred-MB target until it has been tested on the actual supported mobile and desktop browsers without exhausting memory.

## Phase 3: Deployment and cost constraints

Phase 3 puts both parts online so the app can be opened from a phone and PC with a link. The app requires internet access to reach signaling; direct peer connectivity depends on the network, and TURN may be needed for some users.

1. Push the project to GitHub, with the server and frontend in clearly separate folders.
2. **Backend:** create a Web Service on Render.com from the repo's `Backend` folder. Set the start command to `npm start` (runs `node app.js`), provide the host's `PORT`, and set `CORS_ORIGIN` to the frontend origin. Confirm current free-tier availability, limits and sleep behavior before relying on it.
3. **Frontend:** import the frontend folder into Vercel and deploy. Point the Socket.IO client at the Render URL, via an environment variable rather than a hard-coded address.
4. Enable CORS on the server for the Vercel domain.
5. Open the live URL on the phone and the PC, preferably on the same Wi-Fi, and run the transfer test. Verify direct connectivity and separately test a restrictive network to determine whether TURN is needed and what it costs.

Free-tier note: provider plans, limits and availability can change. Render free services may sleep after inactivity, so the first connection after a pause can take a while to wake. Do not promise zero cost until current hosting limits and any TURN bandwidth requirements are confirmed.

## Testing, risks and next steps

The project is done when the tested file-size target moves from phone to PC without a USB cable or installed app, with browser and network limitations documented and any hosting or relay costs disclosed.

### Build checklist

- [x] Phase 1: signaling server pairs two tabs using a room code and routes messages only to intended peers
- [x] Phase 2: offer, answer and ICE exchange completes and the data channel opens
- [ ] Phase 2: small file (a few MB) transfers, passes byte-count validation and opens correctly
- [ ] Phase 2: supported large-file target transfers on target mobile and desktop browsers without exhausting memory
- [ ] Phase 3: backend live on Render, frontend live on Vercel
- [ ] Final test: real phone to real PC on the same Wi-Fi using the live URLs; document behavior on a restrictive network and whether TURN is required

### Risks and limitations

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Receiver buffers large files in RAM | Receiver tab may crash on large videos; sender flow control does not prevent this | Stream to disk where supported, test on target browsers, and enforce a tested size limit where streaming is unavailable |
| Router blocks device-to-device traffic (client isolation) | Peers cannot connect | Test on another network or use a phone hotspot with the PC joined to it |
| Devices on one Wi-Fi may appear to have different addresses, or unrelated users may share a public IP | IP-based auto-pairing is unreliable and may expose peers to unintended users | Pair with a short-lived room code or QR code and route signaling to the selected peer |
| Strict networks need a relay | STUN alone cannot connect the peers; TURN may relay file data and incur bandwidth costs | Test restrictive networks and decide whether to offer a TURN service, with its cost and privacy implications documented |
| Render free service sleeps when idle | Slow first connection | Open the page once to wake it, or accept the delay |

### Next steps

- Deploy the backend and frontend with the documented environment settings
- Test a few-MB file and several-hundred-MB videos on the target mobile and desktop browsers
- Later: multiple files, transfer resume, and TURN service if target networks need one
