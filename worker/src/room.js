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

// ─── Durable Object: Room ───

export class Room {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        // Map<WebSocket, { peerId: string, displayName: string }>
        this.sessions = new Map();
        this.nextId = 1;
    }

    async fetch(request) {
        const url = new URL(request.url);
        const displayName = url.searchParams.get('name') || 'Anonymous';

        // Create WebSocket pair
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Accept the server side
        this.state.acceptWebSocket(server);

        const peerId = 'peer-' + (this.nextId++);

        // Store session info — we use tags for the hibernation API
        server.serializeAttachment({ peerId, displayName });

        // Build current member list for the welcome message
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
        let data;
        try {
            data = JSON.parse(message);
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const senderInfo = ws.deserializeAttachment();
        if (!senderInfo) return;

        switch (data.type) {
            case 'offer':
            case 'answer':
            case 'ice-candidate': {
                // Forward signaling message to the target peer
                const targetId = data.to;
                if (!targetId) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Missing "to" field' }));
                    return;
                }

                const targetWs = this.findPeerSocket(targetId);
                if (!targetWs) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Peer not found: ' + targetId }));
                    return;
                }

                // Forward with sender info
                const forwarded = {
                    type: data.type,
                    from: senderInfo.peerId,
                };

                if (data.type === 'offer' || data.type === 'answer') {
                    forwarded.sdp = data.sdp;
                } else if (data.type === 'ice-candidate') {
                    forwarded.candidate = data.candidate;
                }

                targetWs.send(JSON.stringify(forwarded));
                break;
            }

            case 'chat': {
                // Relay fallback: broadcast chat message when DataChannel isn't available
                this.broadcast({
                    type: 'chat-relay',
                    from: senderInfo.peerId,
                    sender: senderInfo.displayName,
                    text: data.text,
                    timestamp: Math.floor(Date.now() / 1000),
                }, ws);
                break;
            }

            default:
                ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type: ' + data.type }));
        }
    }

    /**
     * Called when a WebSocket connection closes (Hibernation API).
     */
    async webSocketClose(ws, code, reason, wasClean) {
        const info = ws.deserializeAttachment();
        if (info) {
            this.broadcast({
                type: 'peer-left',
                peerId: info.peerId,
            }, ws);
        }
    }

    /**
     * Called on WebSocket error (Hibernation API).
     */
    async webSocketError(ws, error) {
        const info = ws.deserializeAttachment();
        if (info) {
            this.broadcast({
                type: 'peer-left',
                peerId: info.peerId,
            }, ws);
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
