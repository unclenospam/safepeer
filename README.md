# Safepeer

Encrypted peer-to-peer chat. No accounts, no servers storing your messages — just direct browser-to-browser connections.

**[safepeer.io](https://safepeer.io)**

## How It Works

1. **Create a room** — get a shareable code like `LAKE-3847`
2. **Share the code** — friends join with one click
3. **Chat directly** — messages flow peer-to-peer via WebRTC, not through a server

The server only connects peers (WebRTC signaling). Once connected, it drops out entirely. All chat goes directly between browsers over encrypted DataChannels.

## Architecture

```
Browser A              Cloudflare Worker              Browser B
┌──────────┐          ┌──────────────────┐           ┌──────────┐
│          │◄──WS────►│  Signaling only: │◄───WS────►│          │
│  WebRTC  │          │  · Room codes    │           │  WebRTC  │
│  P2P     │◄════════════ Direct P2P ══════════════►│  P2P     │
└──────────┘          │  · SDP exchange  │           └──────────┘
  (after handshake,   │  · ICE candidates│
   server not used)   └──────────────────┘
```

- **Frontend** — vanilla JS, no build step, no frameworks
- **Signaling** — Cloudflare Worker + Durable Object (ephemeral rooms, zero persistence)
- **Transport** — WebRTC DataChannels with DTLS encryption
- **NAT traversal** — Google STUN servers (free, works ~85% of networks)

## Project Structure

```
safepeer/
├── frontend/           Static site (Cloudflare Pages via Workers)
│   ├── index.html      Login + chat UI
│   ├── style.css       Dark theme
│   └── app.js          WebRTC mesh + signaling client
├── worker/             Cloudflare Worker (signaling server)
│   ├── src/
│   │   ├── index.js    API routes: create, join, room status
│   │   └── room.js     Durable Object: room state + SDP/ICE relay
│   ├── wrangler.toml   Worker config
│   └── package.json
├── .github/workflows/
│   └── deploy.yml      CI/CD: push to main → auto-deploy
└── package.json        Dev scripts
```

## Development

```bash
# Install dependencies
cd worker && npm install

# Start local dev server
npm run dev
# → http://localhost:8787

# Open two browser tabs to test P2P chat
```

## Deployment

Deploys automatically via GitHub Actions on push to `main`.

**Setup (one time):**
1. Create a Cloudflare API token with Workers permissions
2. Add GitHub secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
3. Push to `main` — done

## Limits

Runs entirely on Cloudflare's free tier:
- **Workers**: 100K requests/day
- **Durable Objects**: included, auto-hibernation
- **STUN**: free via Google (no TURN = no relay costs)
- **Rooms**: ephemeral — vanish when everyone leaves

## License

MIT
