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
- **NAT traversal** — Google STUN servers + free TURN relay (covers restrictive NATs and firewalls)

## Features

### Text Chat
- Real-time messaging via P2P DataChannels
- Server relay fallback when P2P hasn't connected yet
- Timestamps, sender display names, system event announcements

### Image Sharing
- **P2P image transfer** — images sent directly between peers over DataChannels, never through the server
- **Client-side compression** — large photos resized to max 1920px and JPEG-compressed (quality stepping from 0.85 down to 0.3) to stay under 1MB
- **Binary chunking protocol** — images split into 64KB chunks with binary headers for reliable transfer
- **Three ways to send**: click the 📎 button, drag & drop onto the chat area, or paste from clipboard (Ctrl+V)
- **Preview before sending** — see the image and file info before confirming
- **Lightbox viewer** — click any image in chat to view full-size, close with Escape or X
- **GIF support** — animated GIFs pass through without recompression to preserve animation
- **Supported formats**: JPEG, PNG, GIF, WebP, and any other format your browser supports
- **5MB raw file limit**, compressed to ≤1MB before transfer

## Project Structure

```
safepeer/
├── frontend/           Static site (served via Cloudflare Workers assets)
│   ├── index.html      Login + chat UI (semantic HTML, ARIA)
│   ├── style.css       Dark theme (WCAG AA contrast, mobile responsive)
│   └── app.js          WebRTC mesh, signaling client, image transfer
├── worker/             Cloudflare Worker (signaling server)
│   ├── src/
│   │   ├── index.js    API routes, rate limiting, security headers
│   │   └── room.js     Durable Object: room state + SDP/ICE relay
│   ├── wrangler.toml   Worker config
│   └── package.json
├── .github/workflows/
│   └── deploy.yml      CI/CD: push to main → auto-deploy
└── package.json        Dev scripts
```

## Security

### Server Hardening
- **Security headers** on all responses: CSP (`script-src 'self'`, `img-src 'self' blob:`, `frame-ancestors 'none'`), X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy
- **CORS restricted** to `safepeer.io` and `localhost` only (no wildcard)
- **Rate limiting**: 10 join attempts / 5 room creates per IP per minute
- **Per-peer rate limiting**: 30 messages per 10 seconds inside rooms
- **Input validation**: display names sanitized (32 char max, control chars stripped), room codes length-checked before parsing
- **Message size limits**: SDP 16KB, ICE candidates 2KB, chat text 4KB, total 64KB
- **Room caps**: max 20 peers per room
- **Error sanitization**: generic messages only, no internal state leakage

### Encryption
- **WebRTC DTLS**: all peer-to-peer DataChannels are encrypted at the transport layer
- **No server access**: once peers connect via WebRTC, the signaling server cannot read messages or images
- **Ephemeral rooms**: no data persisted, rooms evict when all peers disconnect
- **Images never touch the server**: image data flows exclusively over P2P DataChannels

### Room Code Security
- 8 characters from a 30-char alphabet = ~656 billion possible codes
- Combined with rate limiting, brute-force guessing is impractical

## Accessibility

WCAG 2.1 AA compliant:
- **Semantic HTML**: `<main>`, `<aside>`, `<nav>`, proper heading hierarchy
- **Screen reader support**: ARIA live regions announce messages, member join/leave, errors, and connection status changes
- **Keyboard navigation**: full Tab support, skip link, Enter/Space on interactive elements
- **Focus indicators**: visible `:focus-visible` outlines on all interactive elements
- **Color contrast**: all text meets 4.5:1 minimum ratio on dark backgrounds
- **Image accessibility**: descriptive alt text on all images, lightbox with keyboard dismiss (Escape)
- **Mobile responsive**: touch-friendly controls, optimized image sizing, collapsible sidebar

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
- **NAT traversal**: Google STUN + free TURN relay servers for broad network compatibility
- **Rooms**: ephemeral — vanish when everyone leaves
- **Peers per room**: 20 max (mesh topology)
- **Images**: 5MB raw max, compressed to ≤1MB, transferred as 64KB chunks over P2P

## License

MIT
