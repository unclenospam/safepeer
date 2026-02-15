// ═══ Room Durable Object — WebRTC Signaling ═══
//
// Each room code maps to one Durable Object instance.
// Handles: peer registration, SDP/ICE forwarding, presence.
// No persistence — rooms evict when all peers disconnect.

// Room code charset: no 0/O, 1/I/L to avoid confusion
const ROOM_CODE_CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/**
 * Generate a random XXXX-XXXX room code.
 */
export function generateRoomCode() {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let code = '';
    for (let i = 0; i < 8; i++) {
        code += ROOM_CODE_CHARSET[bytes[i] % ROOM_CODE_CHARSET.length];
    }
    return code.slice(0, 4) + '-' + code.slice(4);
}

/**
 * Parse and validate a room code string.
 * Strips dashes/spaces, uppercases, validates chars.
 * Returns canonical form (uppercase, no dashes) or null.
 */
export function parseRoomCode(input) {
    if (!input || typeof input !== 'string') return null;
    if (input.length > 20) return null; // Quick reject oversized input
    const cleaned = input.replace(/[-\s]/g, '').toUpperCase();
    if (cleaned.length !== 8) return null;
    for (const ch of cleaned) {
        if (!ROOM_CODE_CHARSET.includes(ch)) return null;
    }
    return cleaned;
}

/**
 * Format a canonical room code as XXXX-XXXX.
 */
export function formatRoomCode(canonical) {
    return canonical.slice(0, 4) + '-' + canonical.slice(4);
}

/**
 * Shard IPs across multiple ConnectionLimiter DO instances for scalability.
 * Uses a simple hash to distribute across ~16 shards.
 */
function ipShard(ip) {
    let hash = 0;
    for (let i = 0; i < ip.length; i++) {
        hash = ((hash << 5) - hash + ip.charCodeAt(i)) | 0;
    }
    return 'shard-' + (Math.abs(hash) % 16);
}

// ─── Security Constants ───
const MAX_MESSAGE_SIZE = 65_536;   // 64KB max WebSocket message
const MAX_SDP_SIZE = 16_384;       // 16KB max SDP offer/answer
const MAX_ICE_SIZE = 2_048;        // 2KB max ICE candidate
const MAX_CHAT_TEXT = 4_096;       // 4KB max chat message text
const MAX_PEERS_PER_ROOM = 20;     // Max concurrent peers
const PEER_MSG_LIMIT = 30;         // Max messages per peer per window
const PEER_MSG_WINDOW = 10_000;    // 10 second window
const MAX_ROOMS_PER_IP = 10;       // Max concurrent rooms per IP
const CONNECTION_TTL = 2 * 60 * 60_000; // 2 hours — auto-expire stale entries

// ─── Durable Object: Room ───

export class Room {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // Map<WebSocket, { peerId: string, displayName: string }>
        this.sessions = new Map();
        this.nextId = 1;
        // Per-peer rate limiting: peerId → { count, windowStart }
        this.peerRates = new Map();
    }

    /**
     * Check per-peer message rate limit. Returns true if allowed.
     */
    isPeerAllowed(peerId) {
        const now = Date.now();
        const entry = this.peerRates.get(peerId);

        if (!entry || now - entry.windowStart > PEER_MSG_WINDOW) {
            this.peerRates.set(peerId, { count: 1, windowStart: now });
            return true;
        }

        if (entry.count >= PEER_MSG_LIMIT) {
            return false;
        }

        entry.count++;
        return true;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const displayName = (url.searchParams.get('name') || 'Anonymous').slice(0, 32);
        const clientIP = url.searchParams.get('ip') || 'unknown';
        const roomCode = url.searchParams.get('room') || '';

        // Enforce max peers per room
        const currentPeers = this.state.getWebSockets().length;
        if (currentPeers >= MAX_PEERS_PER_ROOM) {
            return new Response(JSON.stringify({ error: 'Room is full' }), {
                status: 403,
                headers: { 'Content-Type': 'application/json' },
            });
        }

        // Create WebSocket pair
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        const peerId = 'peer-' + (this.nextId++);

        // Build current member list BEFORE accepting the new socket
        // so the newcomer doesn't appear in their own member list
        const existingMembers = [];
        for (const ws of this.state.getWebSockets()) {
            const info = ws.deserializeAttachment();
            if (info) {
                existingMembers.push({
                    peerId: info.peerId,
                    displayName: info.displayName,
                });
            }
        }

        // Accept the server side and store session info
        // Include clientIP and roomCode for connection tracking on disconnect
        this.state.acceptWebSocket(server);
        server.serializeAttachment({ peerId, displayName, clientIP, roomCode });

        // Send welcome to the new peer (after they connect)
        server.send(JSON.stringify({
            type: 'welcome',
            peerId,
            members: existingMembers,
        }));

        // Broadcast peer-joined to all existing peers
        this.broadcast({
            type: 'peer-joined',
            peerId,
            displayName,
        }, server);

        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Called when a WebSocket message is received (Hibernation API).
     */
    async webSocketMessage(ws, message) {
        // ─── Size check: reject oversized messages early ───
        if (typeof message === 'string' && message.length > MAX_MESSAGE_SIZE) {
            ws.send(JSON.stringify({ type: 'error', message: 'Message too large' }));
            return;
        }

        let data;
        try {
            data = JSON.parse(message);
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
            return;
        }

        const senderInfo = ws.deserializeAttachment();
        if (!senderInfo) return;

        // ─── Per-peer rate limiting ───
        if (!this.isPeerAllowed(senderInfo.peerId)) {
            ws.send(JSON.stringify({ type: 'error', message: 'Rate limited. Slow down.' }));
            return;
        }

        // ─── Validate message type is a known string ───
        if (typeof data.type !== 'string') {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message' }));
            return;
        }

        switch (data.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                // Validate 'to' field
                const targetId = data.to;
                if (!targetId || typeof targetId !== 'string' || targetId.length > 32) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid target' }));
                    return;
                }

                const targetWs = this.findPeerSocket(targetId);
                if (!targetWs) {
                    // Generic error — don't reveal whether peer exists
                    ws.send(JSON.stringify({ type: 'error', message: 'Failed to deliver message' }));
                    return;
                }

                // Forward with sender info, after validating size
                const forwarded = {
                    type: data.type,
                    from: senderInfo.peerId,
                };

                if (data.type === 'offer' || data.type === 'answer') {
                    // Validate SDP: must be a string within size limit
                    if (typeof data.sdp !== 'string' || data.sdp.length > MAX_SDP_SIZE) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid SDP' }));
                        return;
                    }
                    forwarded.sdp = data.sdp;
                } else if (data.type === 'ice-candidate') {
                    // Validate ICE candidate: must be object/null within size limit
                    const candidateStr = JSON.stringify(data.candidate || '');
                    if (candidateStr.length > MAX_ICE_SIZE) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid ICE candidate' }));
                        return;
                    }
                    forwarded.candidate = data.candidate;
                }

                targetWs.send(JSON.stringify(forwarded));
                break;
            }

            case 'chat': {
                // Validate chat text: must be a non-empty string within size limit
                if (typeof data.text !== 'string' || data.text.length === 0 || data.text.length > MAX_CHAT_TEXT) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid message text' }));
                    return;
                }

                // Relay fallback: broadcast chat message when DataChannel isn't available
                this.broadcast({
                    type: 'chat-relay',
                    from: senderInfo.peerId,
                    sender: senderInfo.displayName,
                    text: data.text.slice(0, MAX_CHAT_TEXT),
                    timestamp: Math.floor(Date.now() / 1000),
                }, ws);
                break;
            }

            default:
                // Don't echo unknown type back — prevents reflection attacks
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type' }));
        }
    }

    /**
     * Called when a WebSocket connection closes (Hibernation API).
     */
    async webSocketClose(ws, code, reason, wasClean) {
        const info = ws.deserializeAttachment();
        if (info) {
            this.peerRates.delete(info.peerId);
            this.broadcast({
                type: 'peer-left',
                peerId: info.peerId,
            }, ws);
            // Notify ConnectionLimiter to decrement this IP's room count
            await this.notifyDisconnect(info.clientIP, info.roomCode);
        }
    }

    /**
     * Called on WebSocket error (Hibernation API).
     */
    async webSocketError(ws, error) {
        const info = ws.deserializeAttachment();
        if (info) {
            this.peerRates.delete(info.peerId);
            this.broadcast({
                type: 'peer-left',
                peerId: info.peerId,
            }, ws);
            // Notify ConnectionLimiter to decrement this IP's room count
            await this.notifyDisconnect(info.clientIP, info.roomCode);
        }
    }

    /**
     * Notify the ConnectionLimiter DO that a peer disconnected.
     * Fire-and-forget — errors here shouldn't affect room operation.
     */
    async notifyDisconnect(clientIP, roomCode) {
        if (!clientIP || !roomCode || clientIP === 'unknown') return;
        try {
            const limiterId = this.env.CONNECTION_LIMITER.idFromName(ipShard(clientIP));
            const limiterStub = this.env.CONNECTION_LIMITER.get(limiterId);
            await limiterStub.fetch(new Request('https://limiter.internal/disconnect', {
                method: 'POST',
                body: JSON.stringify({ ip: clientIP, roomCode }),
            }));
        } catch {
            // Best-effort — TTL cleanup handles any missed disconnects
        }
    }

    /**
     * Find a WebSocket by peer ID.
     */
    findPeerSocket(peerId) {
        for (const ws of this.state.getWebSockets()) {
            const info = ws.deserializeAttachment();
            if (info && info.peerId === peerId) {
                return ws;
            }
        }
        return null;
    }

    /**
     * Send a message to all connected WebSockets except the sender.
     */
    broadcast(message, exclude) {
        const json = JSON.stringify(message);
        for (const ws of this.state.getWebSockets()) {
            if (ws !== exclude) {
                try {
                    ws.send(json);
                } catch {
                    // Socket likely closed, will be cleaned up
                }
            }
        }
    }
}

// ═══ ConnectionLimiter Durable Object — Per-IP Room Limit ═══
//
// Tracks active room connections per IP globally. Sharded by IP hash
// (16 shards) to distribute load. Each shard handles a subset of IPs.
// Uses TTL-based expiration as a safety net for missed disconnects.

export class ConnectionLimiter {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // ip → Map<roomCode, joinedAt>
        this.connections = new Map();
    }

    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        let body;
        try {
            body = await request.json();
        } catch {
            return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
        }

        const ip = body.ip;
        if (!ip || typeof ip !== 'string') {
            return new Response(JSON.stringify({ error: 'Missing IP' }), { status: 400 });
        }

        switch (path) {
            case '/check': {
                // Check if this IP can join another room
                this.pruneExpired(ip);
                const rooms = this.connections.get(ip);
                const count = rooms ? rooms.size : 0;
                const allowed = count < MAX_ROOMS_PER_IP;
                return new Response(JSON.stringify({ allowed, count, limit: MAX_ROOMS_PER_IP }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            case '/connect': {
                // Record that this IP joined a room
                const roomCode = body.roomCode;
                if (!roomCode || typeof roomCode !== 'string') {
                    return new Response(JSON.stringify({ error: 'Missing roomCode' }), { status: 400 });
                }
                if (!this.connections.has(ip)) {
                    this.connections.set(ip, new Map());
                }
                this.connections.get(ip).set(roomCode, Date.now());
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            case '/disconnect': {
                // Record that this IP left a room
                const roomCode = body.roomCode;
                if (!roomCode) {
                    return new Response(JSON.stringify({ error: 'Missing roomCode' }), { status: 400 });
                }
                const rooms = this.connections.get(ip);
                if (rooms) {
                    rooms.delete(roomCode);
                    if (rooms.size === 0) this.connections.delete(ip);
                }
                return new Response(JSON.stringify({ ok: true }), {
                    headers: { 'Content-Type': 'application/json' },
                });
            }

            default:
                return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
        }
    }

    /**
     * Remove stale entries older than CONNECTION_TTL for a specific IP.
     */
    pruneExpired(ip) {
        const rooms = this.connections.get(ip);
        if (!rooms) return;
        const now = Date.now();
        for (const [code, joinedAt] of rooms) {
            if (now - joinedAt > CONNECTION_TTL) {
                rooms.delete(code);
            }
        }
        if (rooms.size === 0) this.connections.delete(ip);
    }
}
