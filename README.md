# SwiftDrop

SwiftDrop sends files directly between two browsers using WebRTC. The Socket.IO server handles room pairing and WebRTC signaling only; it does not receive or store the file. A TURN relay is not bundled, so some restrictive networks may not connect.

## Requirements

- Node.js 20.19+ or 22.12+
- A modern browser with WebRTC support
- Internet access for the signaling server and Google STUN; devices on the same Wi-Fi usually connect directly

## Run locally

Install the root development runner:

```powershell
npm install
```

Start the signaling server and frontend together:

```powershell
npm run dev
```

The Vite URL is printed in the terminal. In development, Socket.IO uses HTTP long-polling through the Vite proxy to avoid unstable WebSocket upgrades during local/LAN development. **If you start only the frontend with `npm --prefix Frontend run dev`, also start `npm --prefix Backend start` in a second terminal**; otherwise the browser cannot reach the signaling server. Production uses WebSocket with polling fallback.

To test with a phone on the same Wi-Fi, open the Vite network URL using the PC's local IP address and keep both services running. On a phone, use a modern browser; for production, use HTTPS.

## Production setup

Deployment configuration is included for Render (signaling backend) and Vercel (static frontend).

1. Push the repository to GitHub.
2. In Vercel, import the repository and set **Root Directory** to `Frontend`. Set `VITE_SIGNALING_URL` to the public HTTPS origin of the Render backend, for example `https://swiftdrop-signaling.onrender.com`, then deploy. `Frontend/vercel.json` configures the Vite build and output directory.
3. In Render, create a Blueprint from the repository using `render.yaml`. Set `CORS_ORIGIN` to the deployed Vercel origin, such as `https://your-project.vercel.app`. The backend normalizes trailing slashes. The backend starts in production only when this value is configured. Render supplies `PORT`; do not set it yourself.
4. If either provider assigns a different service URL, update the corresponding environment variable and redeploy: Vercel's `VITE_SIGNALING_URL` must be the backend HTTPS origin, and Render's `CORS_ORIGIN` must contain the frontend origin. For multiple frontend origins, separate them with commas.
5. Open the Vercel HTTPS URL on both devices and test pairing and file transfer. Large-file saving still depends on the phone browser's File System Access API support.

The `.env.example` files document the required deployment variables. For local development, no environment setup is needed: the frontend uses Vite's local signaling proxy. Do not copy production example values into `.env.local` for local development. Never commit real `.env` files; the root `.gitignore` excludes them. Any variable prefixed with `VITE_` is included in client-side code and must not contain secrets.

### TURN relay setup

STUN alone cannot connect peers on every network. For a Metered TURN account, set backend-only `METERED_DOMAIN` to the app's HTTPS origin (for example `https://your-app.metered.live`) and `METERED_TURN_API_KEY` to the TURN credential's API key. The backend calls Metered's credential-scoped `/api/v1/turn/credentials` endpoint and returns the ICE server list; the API key stays server-side. Do not put it in a `VITE_` variable. For Coturn instead, set `TURN_URLS` to its comma-separated `turn:`/`turns:` URLs and `TURN_SHARED_SECRET` to the server-side REST-auth secret. Optionally set `TURN_CREDENTIAL_TTL_SECONDS` (60–86400; default 3600). Configure either Metered or Coturn, not both. Redeploy the backend and frontend after configuration. TURN can relay the file itself, so account for provider bandwidth charges.

The current transfer protocol does not support resuming after a peer connection drops. A failed transfer must be started again.

The room code is randomly generated, valid for ten minutes and limited to two peers. The signaling server allows up to six room-join attempts per socket connection. Use HTTPS in production; browsers require a secure context for features such as clipboard and direct-to-disk saving.

## Transfer behavior and limits

- Files are sent in 16 KiB data-channel messages with bounded outgoing buffering, per-batch receiver acknowledgements and a final receiver confirmation after saving.
- Files are limited to 2 GB. Browsers exposing the File System Access save picker write incoming data directly to disk. Other browsers can receive up to 128 MiB in memory; larger incoming offers cannot be accepted there.
- On a phone, do not use the local `http://192.168...:5173` development URL for large incoming files: it is not a secure context, so mobile browsers disable direct-to-disk saving. Open the app using its HTTPS deployment and a browser that supports the save picker. iOS browsers may not offer this API; those browsers remain limited to 128 MiB.
- The receiver must approve each incoming file. In-memory downloads are assembled only after the received byte count matches the sender's declared size.
- STUN is configured for connection setup. TURN is not configured; some networks may require a TURN service, which can relay file data and incur bandwidth costs.
- The app has no user accounts or end-to-end application-level encryption beyond the encryption provided by WebRTC. Treat the room code as a temporary bearer invite and share it only with the intended device.

## Checks

```powershell
npm run lint
npm run build
```

The backend exposes `GET /healthz` for hosting health checks and `GET /ice-servers` for browser ICE configuration.
