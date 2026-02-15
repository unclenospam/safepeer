# Safepeer

Encrypted peer-to-peer chat. No accounts, no servers storing your messages — just direct browser-to-browser connections.

**[safepeer.io](https://safepeer.io)**

## How It Works

1. **Create a room** — get a shareable code like `LAKE-3847`
2. **Share the code** — friends join with one click via code or invite link
3. **Chat directly** — messages and images flow peer-to-peer via WebRTC, not through a server

The server only connects peers (WebRTC signaling). Once connected, it drops out entirely. All chat goes directly between browsers over encrypted DataChannels.

## Features

- **Peer-to-peer messaging** — text sent directly between browsers over WebRTC DataChannels
- **Image sharing** — send JPG, PNG, GIF, and WebP images P2P (compressed client-side, chunked into 64KB binary transfers)
- **Multiple channels** — create and switch between chat channels within a room
- **Reactions** — react to messages with emoji
- **Replies** — reply to specific messages with inline previews
- **Typing indicators** — see when others are typing
- **User statuses** — set an emoji status visible to all room members
- **Invite links** — share a direct URL or room code to invite others
- **Mute toggle** — mute/unmute notification sounds
- **Markdown** — bold, italic, code blocks, and links in messages
- **No accounts** — just pick a display name and go
- **Mobile responsive** — collapsible sidebar, touch-friendly controls

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
- **Signaling** — Cloudflare Worker + Durable Objects (ephemeral rooms, zero persistence)
- **Transport** — WebRTC DataChannels with DTLS encryption
- **NAT traversal** — Google STUN servers (free, works ~85% of networks)
- **Connection limiting** — per-IP concurrent room limits via sharded Durable Objects

## Project Structure

```
safepeer/
├── frontend/           Static site (served via Cloudflare Workers assets)
│   ├── index.html      Login + chat UI (semantic HTML, ARIA)
│   ├── style.css       Dark theme (WCAG AA contrast, mobile responsive)
│   ├── app.js          WebRTC mesh, signaling client, image transfer
│   ├── robots.txt      Search engine crawler rules
│   └── llms.txt        LLM-friendly site description
├── worker/             Cloudflare Worker (signaling server)
│   ├── src/
│   │   ├── index.js    API routes, rate limiting, security headers
│   │   └── room.js     Durable Objects: Room signaling + ConnectionLimiter
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
- **Per-IP connection limiting**: max 10 concurrent rooms per IP (sharded Durable Objects with TTL expiration)
- **Input validation**: display names sanitized (32 char max, control chars stripped), room codes length-checked before parsing
- **Message size limits**: SDP 16KB, ICE candidates 2KB, chat text 4KB, total 64KB
- **Room caps**: max 20 peers per room
- **Error sanitization**: generic messages only, no internal state leakage

### Encryption
- **WebRTC DTLS**: all peer-to-peer DataChannels are encrypted at the transport layer
- **No server access**: once peers connect via WebRTC, the signaling server cannot read messages or images
- **Ephemeral rooms**: no data persisted, rooms evict when all peers disconnect

### Image Security
- **Blob URLs only**: images are never inserted as inline data — always rendered via `URL.createObjectURL()`
- **Client-side compression**: images are resized and compressed before sending (max 1920px, JPEG quality stepping)
- **Binary chunking**: image data uses a custom binary protocol with magic bytes and hash-based correlation
- **P2P only**: images are never relayed through the server (the 4KB relay limit makes this impossible)

### Room Code Security
- 8 characters from a 30-char alphabet = ~656 billion possible codes
- Combined with rate limiting, brute-force guessing is impractical

## Accessibility

WCAG 2.1 AA compliant:
- **Semantic HTML**: `<main>`, `<aside>`, `<nav>`, proper heading hierarchy
- **Screen reader support**: ARIA live regions announce messages, images, member join/leave, errors, and connection status changes
- **Keyboard navigation**: full Tab support, skip link, Enter/Space on interactive elements
- **Focus indicators**: visible `:focus-visible` outlines on all interactive elements
- **Color contrast**: all text meets 4.5:1 minimum ratio on dark backgrounds
- **Mobile responsive**: collapsible sidebar, touch-friendly controls
- **Image lightbox**: Escape key closes, background click closes, focus trapped

## Development

```bash
# Install dependencies
cd worker && npm install

# Start local dev server
npm run dev
# → http://localhost:8787

# Open two browser tabs to test P2P chat and image sharing
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
- **Peers per room**: 20 max (mesh topology)
- **Images**: 5MB raw file limit, compressed to ≤1MB before sending

## License

MIT
