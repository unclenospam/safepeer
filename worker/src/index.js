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

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        // CORS headers for cross-origin requests
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
        };

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        try {
            // POST /api/create — Create a new room
            if (path === '/api/create' && request.method === 'POST') {
                return await handleCreate(request, env, corsHeaders);
            }

            // GET /api/join/:code — WebSocket upgrade for signaling
            const joinMatch = path.match(/^\/api\/join\/([A-Za-z0-9-]+)$/);
            if (joinMatch && request.method === 'GET') {
                return await handleJoin(request, env, joinMatch[1]);
            }

            // GET /api/room/:code — Check room status
            const roomMatch = path.match(/^\/api\/room\/([A-Za-z0-9-]+)$/);
            if (roomMatch && request.method === 'GET') {
                return await handleRoomStatus(env, roomMatch[1], corsHeaders);
            }

            // Non-API routes: let assets handle static files,
            // or return 404 for unknown API paths
            return new Response('Not Found', { status: 404, headers: corsHeaders });
        } catch (err) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }
    },
};

/**
 * Create a new room with a generated room code.
 */
async function handleCreate(request, env, corsHeaders) {
    let body = {};
    try {
        body = await request.json();
    } catch {
        // OK — display_name will default
    }

    const displayName = (body.display_name || 'Host').slice(0, 32);
    const roomCode = generateRoomCode();
    const canonical = parseRoomCode(roomCode);

    // The Durable Object ID is derived from the canonical room code
    // This ensures the same code always maps to the same DO instance
    const roomId = env.ROOM.idFromName(canonical);

    // "Touch" the DO so it exists (it will be fully initialized on first WS connect)
    // We don't need to call it here — the DO is created lazily on first fetch

    return new Response(JSON.stringify({
        room_code: roomCode,
        canonical,
    }), {
        status: 200,
        headers: {
            ...corsHeaders,
            'Content-Type': 'application/json',
        },
    });
}

/**
 * WebSocket upgrade — connects to the Room Durable Object for signaling.
 */
async function handleJoin(request, env, codeParam) {
    const canonical = parseRoomCode(codeParam);
    if (!canonical) {
        return new Response(JSON.stringify({ error: 'Invalid room code format' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Route to the Durable Object for this room code
    const roomId = env.ROOM.idFromName(canonical);
    const roomStub = env.ROOM.get(roomId);

    // Forward the request to the Durable Object
    // Pass display name as query parameter
    const url = new URL(request.url);
    const name = url.searchParams.get('name') || 'Anonymous';
    const doUrl = new URL(`https://room.internal/?name=${encodeURIComponent(name)}`);

    return roomStub.fetch(new Request(doUrl.toString(), {
        headers: request.headers,
    }));
}

/**
 * Check if a room exists and get member count.
 */
async function handleRoomStatus(env, codeParam, corsHeaders) {
    const canonical = parseRoomCode(codeParam);
    if (!canonical) {
        return new Response(JSON.stringify({ error: 'Invalid room code format' }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }

    // We can't easily check DO state without connecting,
    // so just return that the code format is valid.
    // The actual room existence is verified on WebSocket connect.
    return new Response(JSON.stringify({
        room_code: formatRoomCode(canonical),
        canonical,
        valid: true,
    }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
}
