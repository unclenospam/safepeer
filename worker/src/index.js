// ═══ Safepeer — Cloudflare Worker Entry Point ═══
//
// API Routes (handled by Worker):
//   POST /api/create          → Create a new room, return room code
//   GET  /api/join/:code      → WebSocket upgrade, join room signaling
//   GET  /api/room/:code      → Check if room exists + member count
//
// Static files (/, /style.css, /app.js) are served automatically
// by Cloudflare's assets config from the frontend/ directory.

import { generateRoomCode, parseRoomCode, formatRoomCode } from './room.js';

export { Room } from './room.js';

// ─── Security Headers ───
// Applied to all responses to prevent XSS, clickjacking, and content sniffing.
const SECURITY_HEADERS = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; img-src 'self' blob:; frame-ancestors 'none';",
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'microphone=(), camera=(), geolocation=()',
};

// ─── Allowed Origins ───
const ALLOWED_ORIGINS = [
    'https://safepeer.io',
    'https://www.safepeer.io',
    'https://safepeer-signaling.sjestus.workers.dev',
];

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    // In development (localhost), allow it; in production, restrict to known origins
    const isAllowed = ALLOWED_ORIGINS.includes(origin) || origin.startsWith('http://localhost');
    return {
        'Access-Control-Allow-Origin': isAllowed ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
}

// ─── Rate Limiter ───
// Sliding window per IP. Protects against brute-force room code guessing.
// Note: Workers may run across multiple isolates, so this is per-isolate.
// Still effective — an attacker hits the same isolate for many sequential requests.

const WINDOW_MS = 60_000; // 1 minute
const JOIN_LIMIT = 10;    // max join attempts per IP per window
const CREATE_LIMIT = 5;   // max room creations per IP per window

class RateLimiter {
    constructor(limit) {
        this.limit = limit;
        this.clients = new Map(); // ip → { count, windowStart }
    }

    isAllowed(ip) {
        const now = Date.now();
        const entry = this.clients.get(ip);

        // Prune expired entries periodically (every 100 checks)
        if (this.clients.size > 100) {
            for (const [key, val] of this.clients) {
                if (now - val.windowStart > WINDOW_MS) this.clients.delete(key);
            }
        }

        if (!entry || now - entry.windowStart > WINDOW_MS) {
            // New window
            this.clients.set(ip, { count: 1, windowStart: now });
            return true;
        }

        if (entry.count >= this.limit) {
            return false; // Rate limited
        }

        entry.count++;
        return true;
    }
}

const joinLimiter = new RateLimiter(JOIN_LIMIT);
const createLimiter = new RateLimiter(CREATE_LIMIT);

function getClientIP(request) {
    return request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
}

function rateLimitResponse(corsHeaders) {
    return new Response(JSON.stringify({ error: 'Too many requests. Try again later.' }), {
        status: 429,
        headers: {
            ...SECURITY_HEADERS,
            ...corsHeaders,
            'Content-Type': 'application/json',
            'Retry-After': '60',
        },
    });
}

// Helper: build response with security + CORS headers
function secureJsonResponse(body, status, corsHeaders) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            ...SECURITY_HEADERS,
            ...corsHeaders,
            'Content-Type': 'application/json',
        },
    });
}

// ─── Display Name Validation ───
// Strip control characters, limit length, allow Unicode letters/numbers/spaces/dashes
const MAX_DISPLAY_NAME = 32;
function sanitizeDisplayName(raw) {
    if (!raw || typeof raw !== 'string') return 'Anonymous';
    // Strip control characters and trim
    const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (cleaned.length === 0) return 'Anonymous';
    return cleaned.slice(0, MAX_DISPLAY_NAME);
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Dynamic CORS: only allow known origins
        const corsHeaders = getCorsHeaders(request);

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: { ...SECURITY_HEADERS, ...corsHeaders } });
        }

        const clientIP = getClientIP(request);

        try {
            // POST /api/create — Create a new room
            if (path === '/api/create' && request.method === 'POST') {
                if (!createLimiter.isAllowed(clientIP)) {
                    return rateLimitResponse(corsHeaders);
                }
                return await handleCreate(request, env, corsHeaders);
            }

            // GET /api/join/:code — WebSocket upgrade for signaling
            const joinMatch = path.match(/^\/api\/join\/([A-Za-z0-9-]+)$/);
            if (joinMatch && request.method === 'GET') {
                if (!joinLimiter.isAllowed(clientIP)) {
                    return rateLimitResponse(corsHeaders);
                }
                return await handleJoin(request, env, joinMatch[1]);
            }

            // GET /api/room/:code — Check room status
            const roomMatch = path.match(/^\/api\/room\/([A-Za-z0-9-]+)$/);
            if (roomMatch && request.method === 'GET') {
                return await handleRoomStatus(env, roomMatch[1], corsHeaders);
            }

            // Non-API routes: let assets handle static files,
            // or return 404 for unknown API paths
            return new Response('Not Found', { status: 404, headers: { ...SECURITY_HEADERS, ...corsHeaders } });
        } catch (err) {
            // Don't leak internal error details to clients
            return secureJsonResponse({ error: 'Internal server error' }, 500, corsHeaders);
        }
    },
};

/**
 * Create a new room with a generated room code.
 */
async function handleCreate(request, env, corsHeaders) {
    // Reject oversized request bodies (max 1KB for create)
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > 1024) {
        return secureJsonResponse({ error: 'Request too large' }, 413, corsHeaders);
    }

    let body = {};
    try {
        body = await request.json();
    } catch {
        // OK — display_name will default
    }

    const displayName = sanitizeDisplayName(body.display_name || 'Host');
    const roomCode = generateRoomCode();
    const canonical = parseRoomCode(roomCode);

    // The Durable Object ID is derived from the canonical room code
    // This ensures the same code always maps to the same DO instance
    const roomId = env.ROOM.idFromName(canonical);

    return secureJsonResponse({ room_code: roomCode, canonical }, 200, corsHeaders);
}

/**
 * WebSocket upgrade — connects to the Room Durable Object for signaling.
 */
async function handleJoin(request, env, codeParam) {
    // Early length check to prevent regex DoS on long inputs
    if (codeParam.length > 20) {
        return secureJsonResponse({ error: 'Invalid room code' }, 400, {});
    }

    const canonical = parseRoomCode(codeParam);
    if (!canonical) {
        return secureJsonResponse({ error: 'Invalid room code' }, 400, {});
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426, headers: SECURITY_HEADERS });
    }

    // Route to the Durable Object for this room code
    const roomId = env.ROOM.idFromName(canonical);
    const roomStub = env.ROOM.get(roomId);

    // Forward the request to the Durable Object
    // Sanitize display name before passing to DO
    const url = new URL(request.url);
    const name = sanitizeDisplayName(url.searchParams.get('name'));
    const doUrl = new URL(`https://room.internal/?name=${encodeURIComponent(name)}`);

    return roomStub.fetch(new Request(doUrl.toString(), {
        headers: request.headers,
    }));
}

/**
 * Check if a room exists and get member count.
 */
async function handleRoomStatus(env, codeParam, corsHeaders) {
    if (codeParam.length > 20) {
        return secureJsonResponse({ error: 'Invalid room code' }, 400, corsHeaders);
    }

    const canonical = parseRoomCode(codeParam);
    if (!canonical) {
        return secureJsonResponse({ error: 'Invalid room code' }, 400, corsHeaders);
    }

    // Don't reveal whether room is active — just validate format
    return secureJsonResponse({
        room_code: formatRoomCode(canonical),
        canonical,
        valid: true,
    }, 200, corsHeaders);
}
