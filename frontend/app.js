// ═══ Safepeer — WebRTC P2P Chat Client ═══

(function() {
    'use strict';

    // ─── Configuration ───
    // Worker URL — update this after deployment, or leave empty for same-origin
    const WORKER_URL = '';  // Leave empty — same-origin when deployed to Cloudflare Workers

    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // ─── Image Transfer Constants ───
    const IMAGE_CHUNK_SIZE = 64 * 1024;      // 64KB chunks
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024;  // 5MB raw file limit
    const MAX_COMPRESSED_SIZE = 1024 * 1024;  // 1MB after compression
    const MAX_IMAGE_DIM = 1920;              // Max width/height px
    const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];
    const IMG_MAGIC = [0x49, 0x4D, 0x47, 0x00]; // "IMG\0" magic bytes

    // ─── State ───
    let ws = null;                          // Signaling WebSocket
    let myPeerId = '';                      // Assigned by server
    let displayName = '';                   // Our display name
    let roomCode = '';                      // Current room code
    let reconnectTimer = null;
    const peers = new Map();                // peerId → { pc, dataChannel, displayName, connected }
    const peerNames = new Map();            // peerId → displayName
    let pendingImageFile = null;            // File queued for preview before sending
    const incomingTransfers = new Map();    // transferId → { meta, chunks: ArrayBuffer[], received: number, placeholderId: string }

    // ─── DOM Elements ───
    const loginView = document.getElementById('login-view');
    const chatView = document.getElementById('chat-view');
    const displayNameInput = document.getElementById('display-name');
    const roomCodeInput = document.getElementById('room-code');
    const roomNameInput = document.getElementById('room-name');
    const joinBtn = document.getElementById('join-btn');
    const createBtn = document.getElementById('create-btn');
    const loginError = document.getElementById('login-error');
    const messagesDiv = document.getElementById('messages');
    const messageInput = document.getElementById('message-input');
    const sendBtn = document.getElementById('send-btn');
    const roomTitle = document.getElementById('room-title');
    const roomCodeDisplay = document.getElementById('room-code-display');
    const memberList = document.getElementById('member-list');
    const memberCount = document.getElementById('member-count');
    const connectionStatus = document.getElementById('connection-status');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const attachBtn = document.getElementById('attach-btn');
    const fileInput = document.getElementById('file-input');
    const imagePreview = document.getElementById('image-preview');
    const previewImg = document.getElementById('preview-img');
    const previewInfo = document.getElementById('preview-info');
    const previewCancel = document.getElementById('preview-cancel');
    const previewSend = document.getElementById('preview-send');
    const lightbox = document.getElementById('lightbox');
    const lightboxImg = document.getElementById('lightbox-img');
    const lightboxClose = document.getElementById('lightbox-close');

    // ─── Accessibility: Screen Reader Announcements ───
    function announce(text) {
        var el = document.getElementById('sr-announcements');
        if (el) {
            el.textContent = '';
            setTimeout(function() { el.textContent = text; }, 50);
        }
    }

    // ─── Color Generation (for avatars) ───
    const COLORS = [
        '#5865f2', '#3ba55d', '#faa61a', '#ed4245', '#eb459e',
        '#57f287', '#fee75c', '#5865f2', '#9b59b6', '#e67e22',
        '#1abc9c', '#e91e63', '#2ecc71', '#3498db', '#f39c12',
    ];

    function nameColor(name) {
        let hash = 0;
        for (let i = 0; i < name.length; i++) {
            hash = name.charCodeAt(i) + ((hash << 5) - hash);
        }
        return COLORS[Math.abs(hash) % COLORS.length];
    }

    function nameInitial(name) {
        return (name || '?')[0].toUpperCase();
    }

    function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ─── Image Transfer Helpers ───

    /**
     * Simple 32-bit hash of a string, used for binary chunk headers.
     */
    function hashString(str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash) + str.charCodeAt(i);
            hash = hash & hash; // Convert to 32-bit integer
        }
        return hash >>> 0; // Unsigned
    }

    /**
     * Compress an image file using Canvas API.
     * GIFs pass through raw to preserve animation.
     * Returns Promise<{ blob, width, height }>
     */
    function compressImage(file) {
        return new Promise(function(resolve, reject) {
            // GIFs: pass through raw (canvas kills animation)
            if (file.type === 'image/gif') {
                if (file.size > MAX_IMAGE_SIZE) {
                    reject(new Error('GIF is too large (max 5MB)'));
                    return;
                }
                resolve({ blob: file, width: 0, height: 0 });
                return;
            }

            var reader = new FileReader();
            reader.onerror = function() { reject(new Error('Failed to read image file')); };
            reader.onload = function() {
                var img = new Image();
                img.onerror = function() { reject(new Error('Failed to decode image. Format may not be supported by your browser.')); };
                img.onload = function() {
                    var w = img.naturalWidth;
                    var h = img.naturalHeight;

                    // Scale down if needed
                    if (w > MAX_IMAGE_DIM || h > MAX_IMAGE_DIM) {
                        var scale = Math.min(MAX_IMAGE_DIM / w, MAX_IMAGE_DIM / h);
                        w = Math.round(w * scale);
                        h = Math.round(h * scale);
                    }

                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);

                    // Try quality steps until under size limit
                    var qualities = [0.85, 0.7, 0.5, 0.3];
                    var attempt = 0;

                    function tryCompress() {
                        if (attempt >= qualities.length) {
                            reject(new Error('Image too large even after compression'));
                            return;
                        }
                        canvas.toBlob(function(blob) {
                            if (!blob) {
                                reject(new Error('Failed to compress image'));
                                return;
                            }
                            if (blob.size <= MAX_COMPRESSED_SIZE) {
                                resolve({ blob: blob, width: w, height: h });
                            } else {
                                attempt++;
                                tryCompress();
                            }
                        }, 'image/jpeg', qualities[attempt]);
                    }
                    tryCompress();
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(file);
        });
    }

    /**
     * Send an image blob to all connected peers via DataChannels.
     */
    async function sendImage(blob, fileName, mimeType) {
        // Check for open DataChannels
        var hasOpen = false;
        var peerCount = 0;
        var dcStates = [];
        for (var entry of peers) {
            peerCount++;
            var peer = entry[1];
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                hasOpen = true;
                break;
            }
            dcStates.push((peerNames.get(entry[0]) || entry[0]) + ': ' + (peer.dataChannel ? peer.dataChannel.readyState : 'no channel') + ' / ' + (peer.pc ? peer.pc.connectionState : 'no pc'));
        }
        if (!hasOpen) {
            if (peerCount === 0) {
                addSystemMessage('No peers in the room. Image sending requires a peer-to-peer connection.');
            } else {
                addSystemMessage('P2P connection not established yet. Text uses server relay but images require a direct connection. Peer states: ' + dcStates.join(', '));
            }
            return;
        }

        var transferId = myPeerId + '-' + Date.now();
        var buffer = await blob.arrayBuffer();
        var totalChunks = Math.ceil(buffer.byteLength / IMAGE_CHUNK_SIZE);
        var timestamp = Math.floor(Date.now() / 1000);

        // Send metadata as JSON
        var meta = {
            type: 'image-meta',
            transferId: transferId,
            fileName: fileName,
            mimeType: mimeType,
            totalChunks: totalChunks,
            totalSize: buffer.byteLength,
            sender: displayName,
            timestamp: timestamp,
        };
        var metaJson = JSON.stringify(meta);

        for (var entry of peers) {
            var peer = entry[1];
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(metaJson);
                } catch(err) {
                    console.error('Failed to send image meta to', entry[0], err);
                }
            }
        }

        // Send binary chunks with headers
        var transferHash = hashString(transferId);
        for (var i = 0; i < totalChunks; i++) {
            var start = i * IMAGE_CHUNK_SIZE;
            var end = Math.min(start + IMAGE_CHUNK_SIZE, buffer.byteLength);
            var chunkData = buffer.slice(start, end);

            // Build header: 24 bytes
            var headerBuf = new ArrayBuffer(24);
            var headerView = new DataView(headerBuf);
            // Magic "IMG\0"
            headerView.setUint8(0, IMG_MAGIC[0]);
            headerView.setUint8(1, IMG_MAGIC[1]);
            headerView.setUint8(2, IMG_MAGIC[2]);
            headerView.setUint8(3, IMG_MAGIC[3]);
            // Transfer ID hash
            headerView.setUint32(4, transferHash, true);
            // Chunk index
            headerView.setUint32(8, i, true);
            // Total chunks
            headerView.setUint32(12, totalChunks, true);
            // Reserved (bytes 16-23 already zero)

            // Combine header + chunk data
            var combined = new Uint8Array(24 + chunkData.byteLength);
            combined.set(new Uint8Array(headerBuf), 0);
            combined.set(new Uint8Array(chunkData), 24);

            for (var entry2 of peers) {
                var peer2 = entry2[1];
                if (peer2.dataChannel && peer2.dataChannel.readyState === 'open') {
                    try {
                        peer2.dataChannel.send(combined.buffer);
                    } catch(err) {
                        console.error('Failed to send image chunk to', entry2[0], err);
                    }
                }
            }
        }

        // Show our own image locally
        var localUrl = URL.createObjectURL(blob);
        addImageMessage(displayName, localUrl, fileName, timestamp);
    }

    /**
     * Handle incoming binary image chunk.
     */
    function handleImageChunk(arrayBuffer) {
        if (arrayBuffer.byteLength < 24) return; // Too small

        var view = new DataView(arrayBuffer);

        // Verify magic bytes
        if (view.getUint8(0) !== IMG_MAGIC[0] ||
            view.getUint8(1) !== IMG_MAGIC[1] ||
            view.getUint8(2) !== IMG_MAGIC[2] ||
            view.getUint8(3) !== IMG_MAGIC[3]) {
            return; // Not an image chunk
        }

        var transferHash = view.getUint32(4, true);
        var chunkIndex = view.getUint32(8, true);
        var totalChunks = view.getUint32(12, true);

        // Find matching transfer by hash
        var matchedId = null;
        for (var entry of incomingTransfers) {
            if (hashString(entry[0]) === transferHash) {
                matchedId = entry[0];
                break;
            }
        }

        if (!matchedId) {
            console.warn('Received image chunk for unknown transfer');
            return;
        }

        var transfer = incomingTransfers.get(matchedId);
        if (!transfer) return;

        // Store chunk data (minus the 24-byte header)
        transfer.chunks[chunkIndex] = arrayBuffer.slice(24);
        transfer.received++;

        // Update loading placeholder progress
        var placeholder = document.getElementById(transfer.placeholderId);
        if (placeholder) {
            var pct = Math.round((transfer.received / transfer.meta.totalChunks) * 100);
            placeholder.textContent = 'Receiving image... ' + pct + '%';
        }

        // Check if all chunks received
        if (transfer.received >= transfer.meta.totalChunks) {
            reassembleImage(matchedId);
        }
    }

    /**
     * Reassemble all chunks into a complete image and display it.
     */
    function reassembleImage(transferId) {
        var transfer = incomingTransfers.get(transferId);
        if (!transfer) return;

        // Calculate total size
        var totalSize = 0;
        for (var i = 0; i < transfer.meta.totalChunks; i++) {
            if (!transfer.chunks[i]) {
                console.error('Missing chunk', i, 'for transfer', transferId);
                return;
            }
            totalSize += transfer.chunks[i].byteLength;
        }

        // Concatenate all chunks
        var combined = new Uint8Array(totalSize);
        var offset = 0;
        for (var i = 0; i < transfer.meta.totalChunks; i++) {
            combined.set(new Uint8Array(transfer.chunks[i]), offset);
            offset += transfer.chunks[i].byteLength;
        }

        // Create blob and URL
        var blob = new Blob([combined], { type: transfer.meta.mimeType || 'image/jpeg' });
        var blobUrl = URL.createObjectURL(blob);

        // Remove loading placeholder
        var placeholder = document.getElementById(transfer.placeholderId);
        if (placeholder) {
            placeholder.remove();
        }

        // Display the image
        addImageMessage(
            transfer.meta.sender,
            blobUrl,
            transfer.meta.fileName,
            transfer.meta.timestamp
        );

        // Clean up
        incomingTransfers.delete(transferId);
    }

    /**
     * Show a file selection dialog for images.
     */
    function showImagePreview(file) {
        if (!file) return;

        // Validate file type
        if (!ALLOWED_MIME.includes(file.type) && !file.name.toLowerCase().endsWith('.heic')) {
            addSystemMessage('Unsupported image format. Use JPG, PNG, GIF, WebP, or HEIC.');
            return;
        }

        // Validate raw file size
        if (file.size > MAX_IMAGE_SIZE) {
            addSystemMessage('Image too large (max 5MB).');
            return;
        }

        pendingImageFile = file;

        // Show preview
        var reader = new FileReader();
        reader.onload = function() {
            previewImg.src = reader.result;
            var sizeKB = Math.round(file.size / 1024);
            previewInfo.textContent = file.name + ' (' + sizeKB + ' KB)';
            imagePreview.style.display = 'flex';
            previewSend.focus();
        };
        reader.readAsDataURL(file);
    }

    /**
     * Lightbox functions.
     */
    function openLightbox(src, alt) {
        lightboxImg.src = src;
        lightboxImg.alt = alt || 'Full size image';
        lightbox.style.display = 'flex';
        lightbox.focus();
        announce('Viewing full size image');
    }

    function closeLightbox() {
        lightbox.style.display = 'none';
        lightboxImg.src = '';
        messageInput.focus();
    }

    // ─── API Helpers ───
    function apiUrl(path) {
        return (WORKER_URL || '') + path;
    }

    // ─── Signaling WebSocket ───
    function connectSignaling(code, name) {
        const proto = WORKER_URL ? (WORKER_URL.startsWith('https') ? 'wss:' : 'ws:') : (location.protocol === 'https:' ? 'wss:' : 'ws:');
        const host = WORKER_URL ? new URL(WORKER_URL).host : location.host;
        const url = proto + '//' + host + '/api/join/' + encodeURIComponent(code) + '?name=' + encodeURIComponent(name);

        ws = new WebSocket(url);

        ws.onopen = function() {
            updateConnectionStatus();
        };

        ws.onclose = function() {
            updateConnectionStatus();
            scheduleReconnect();
        };

        ws.onerror = function() {
            updateConnectionStatus();
        };

        ws.onmessage = function(event) {
            try {
                const data = JSON.parse(event.data);
                handleSignalingMessage(data);
            } catch(e) {
                console.error('Failed to parse signaling message:', e);
            }
        };
    }

    function scheduleReconnect() {
        if (!reconnectTimer && roomCode) {
            reconnectTimer = setTimeout(function() {
                reconnectTimer = null;
                connectSignaling(roomCode, displayName);
            }, 3000);
        }
    }

    function sendSignaling(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(obj));
        }
    }

    // ─── Signaling Message Handler ───
    function handleSignalingMessage(data) {
        switch (data.type) {
            case 'welcome':
                myPeerId = data.peerId;
                // Initiate connections to all existing members
                for (const member of (data.members || [])) {
                    peerNames.set(member.peerId, member.displayName);
                    // We are the newcomer — create offers to all existing peers
                    createPeerConnection(member.peerId, true);
                }
                updateMemberList();
                break;

            case 'peer-joined':
                peerNames.set(data.peerId, data.displayName);
                addSystemMessage(data.displayName + ' joined the room');
                updateMemberList();
                // The new peer will send us an offer, so we wait
                break;

            case 'peer-left':
                handlePeerLeft(data.peerId);
                break;

            case 'offer':
                handleOffer(data.from, data.sdp);
                break;

            case 'answer':
                handleAnswer(data.from, data.sdp);
                break;

            case 'ice-candidate':
                handleIceCandidate(data.from, data.candidate);
                break;

            case 'chat-relay':
                // Fallback: message relayed through server
                addChatMessage(data.sender, data.text, data.timestamp);
                break;

            case 'error':
                showError(data.message);
                break;
        }
    }

    // ─── WebRTC Peer Connection Management ───

    function createPeerConnection(peerId, isInitiator) {
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        const peerState = {
            pc,
            dataChannel: null,
            displayName: peerNames.get(peerId) || 'Unknown',
            connected: false,
        };
        peers.set(peerId, peerState);

        // ICE candidate handling
        pc.onicecandidate = function(event) {
            if (event.candidate) {
                sendSignaling({
                    type: 'ice-candidate',
                    to: peerId,
                    candidate: event.candidate,
                });
            }
        };

        pc.onconnectionstatechange = function() {
            console.log('[WebRTC] Connection state for', peerId, ':', pc.connectionState);
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                if (pc.connectionState === 'failed') {
                    addSystemMessage('P2P connection failed with ' + (peerNames.get(peerId) || peerId) + '. Chat will use server relay.');
                }
                handlePeerDisconnected(peerId);
            }
        };

        pc.oniceconnectionstatechange = function() {
            console.log('[WebRTC] ICE state for', peerId, ':', pc.iceConnectionState);
        };

        if (isInitiator) {
            // Create data channel and offer
            const dc = pc.createDataChannel('chat', { ordered: true });
            setupDataChannel(dc, peerId);
            peerState.dataChannel = dc;

            console.log('[WebRTC] Creating offer for', peerId);
            pc.createOffer().then(function(offer) {
                return pc.setLocalDescription(offer);
            }).then(function() {
                console.log('[WebRTC] Sending offer to', peerId);
                sendSignaling({
                    type: 'offer',
                    to: peerId,
                    sdp: pc.localDescription.sdp,
                });
            }).catch(function(err) {
                console.error('Failed to create offer for', peerId, err);
            });
        } else {
            // Wait for data channel from the other side
            pc.ondatachannel = function(event) {
                peerState.dataChannel = event.channel;
                setupDataChannel(event.channel, peerId);
            };
        }

        return pc;
    }

    function setupDataChannel(dc, peerId) {
        dc.binaryType = 'arraybuffer';

        dc.onopen = function() {
            const peer = peers.get(peerId);
            if (peer) {
                peer.connected = true;
            }
            updateConnectionStatus();
            updateMemberList();
            addSystemMessage('Connected to ' + (peerNames.get(peerId) || peerId) + ' (P2P)');
        };

        dc.onclose = function() {
            handlePeerDisconnected(peerId);
        };

        dc.onerror = function(err) {
            console.error('DataChannel error with', peerId, err);
        };

        dc.onmessage = function(event) {
            // Binary data = image chunk
            if (event.data instanceof ArrayBuffer) {
                handleImageChunk(event.data);
                return;
            }

            try {
                var msg = JSON.parse(event.data);

                if (msg.type === 'image-meta') {
                    // Incoming image transfer metadata
                    var placeholderId = 'img-loading-' + msg.transferId;
                    incomingTransfers.set(msg.transferId, {
                        meta: msg,
                        chunks: new Array(msg.totalChunks),
                        received: 0,
                        placeholderId: placeholderId,
                    });

                    // Show loading placeholder in chat
                    var div = document.createElement('div');
                    div.className = 'message';
                    var color = nameColor(msg.sender);
                    var time = msg.timestamp ? new Date(msg.timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

                    var avatarDiv = document.createElement('div');
                    avatarDiv.className = 'msg-avatar';
                    avatarDiv.setAttribute('role', 'img');
                    avatarDiv.setAttribute('aria-label', msg.sender);
                    avatarDiv.style.background = color;
                    avatarDiv.textContent = nameInitial(msg.sender);

                    var contentDiv = document.createElement('div');
                    contentDiv.className = 'msg-content';

                    var headerDiv = document.createElement('div');
                    headerDiv.className = 'msg-header';
                    var nameSpan = document.createElement('span');
                    nameSpan.className = 'msg-name';
                    nameSpan.style.color = color;
                    nameSpan.textContent = msg.sender;
                    var timeSpan = document.createElement('span');
                    timeSpan.className = 'msg-time';
                    timeSpan.textContent = time;
                    headerDiv.appendChild(nameSpan);
                    headerDiv.appendChild(timeSpan);

                    var loadingDiv = document.createElement('div');
                    loadingDiv.className = 'msg-image-loading';
                    loadingDiv.id = placeholderId;
                    loadingDiv.textContent = 'Receiving image... 0%';

                    contentDiv.appendChild(headerDiv);
                    contentDiv.appendChild(loadingDiv);
                    div.appendChild(avatarDiv);
                    div.appendChild(contentDiv);

                    messagesDiv.appendChild(div);
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                    announce('Receiving image from ' + msg.sender);
                    return;
                }

                // Regular text message
                addChatMessage(msg.sender, msg.text, msg.timestamp);
            } catch(e) {
                console.error('Failed to parse DataChannel message:', e);
            }
        };
    }

    async function handleOffer(fromPeerId, sdp) {
        const pc = createPeerConnection(fromPeerId, false);

        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            sendSignaling({
                type: 'answer',
                to: fromPeerId,
                sdp: pc.localDescription.sdp,
            });
        } catch(err) {
            console.error('Failed to handle offer from', fromPeerId, err);
        }
    }

    async function handleAnswer(fromPeerId, sdp) {
        const peer = peers.get(fromPeerId);
        if (!peer) return;

        try {
            await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));
        } catch(err) {
            console.error('Failed to handle answer from', fromPeerId, err);
        }
    }

    async function handleIceCandidate(fromPeerId, candidate) {
        const peer = peers.get(fromPeerId);
        if (!peer) return;

        try {
            if (candidate) {
                await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
            }
        } catch(err) {
            console.error('Failed to add ICE candidate from', fromPeerId, err);
        }
    }

    function handlePeerLeft(peerId) {
        const name = peerNames.get(peerId) || peerId;
        const peer = peers.get(peerId);
        if (peer) {
            if (peer.dataChannel) {
                try { peer.dataChannel.close(); } catch {}
            }
            if (peer.pc) {
                try { peer.pc.close(); } catch {}
            }
            peers.delete(peerId);
        }
        peerNames.delete(peerId);
        addSystemMessage(name + ' left the room');
        updateMemberList();
        updateConnectionStatus();
    }

    function handlePeerDisconnected(peerId) {
        const peer = peers.get(peerId);
        if (peer) {
            peer.connected = false;
            updateConnectionStatus();
            updateMemberList();
        }
    }

    // ─── Send Message ───
    function broadcastMessage(text) {
        const msg = {
            sender: displayName,
            text: text,
            timestamp: Math.floor(Date.now() / 1000),
        };
        const json = JSON.stringify(msg);

        let sentViaDC = false;

        // Send via DataChannels to all connected peers
        for (const [peerId, peer] of peers) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try {
                    peer.dataChannel.send(json);
                    sentViaDC = true;
                } catch(err) {
                    console.error('Failed to send to', peerId, err);
                }
            }
        }

        // Fallback: if no DataChannels are open, relay through signaling server
        if (!sentViaDC && peerNames.size > 0) {
            sendSignaling({ type: 'chat', text: text });
        }

        // Show our own message locally
        addChatMessage(displayName, text, msg.timestamp);
    }

    // ─── UI Functions ───
    function switchToChat(code) {
        loginView.style.display = 'none';
        chatView.style.display = 'flex';
        roomTitle.textContent = 'Room';
        roomCodeDisplay.textContent = code;
        roomCodeDisplay.setAttribute('aria-label', 'Room code: ' + code + '. Press Enter to copy.');
        messageInput.focus();
        announce('Joined room ' + code);
    }

    function addChatMessage(sender, text, timestamp) {
        var div = document.createElement('div');
        div.className = 'message';

        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

        div.innerHTML =
            '<div class="msg-avatar" role="img" aria-label="' + escapeHtml(sender) + '" style="background:' + color + '">' + nameInitial(sender) + '</div>' +
            '<div class="msg-content">' +
                '<div class="msg-header">' +
                    '<span class="msg-name" style="color:' + color + '">' + escapeHtml(sender) + '</span>' +
                    '<span class="msg-time">' + time + '</span>' +
                '</div>' +
                '<div class="msg-text">' + escapeHtml(text) + '</div>' +
            '</div>';

        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    function addImageMessage(sender, imageUrl, fileName, timestamp) {
        var div = document.createElement('div');
        div.className = 'message';

        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

        var avatarDiv = document.createElement('div');
        avatarDiv.className = 'msg-avatar';
        avatarDiv.setAttribute('role', 'img');
        avatarDiv.setAttribute('aria-label', sender);
        avatarDiv.style.background = color;
        avatarDiv.textContent = nameInitial(sender);

        var contentDiv = document.createElement('div');
        contentDiv.className = 'msg-content';

        var headerDiv = document.createElement('div');
        headerDiv.className = 'msg-header';
        var nameSpan = document.createElement('span');
        nameSpan.className = 'msg-name';
        nameSpan.style.color = color;
        nameSpan.textContent = sender;
        var timeSpan = document.createElement('span');
        timeSpan.className = 'msg-time';
        timeSpan.textContent = time;
        headerDiv.appendChild(nameSpan);
        headerDiv.appendChild(timeSpan);

        var img = document.createElement('img');
        img.className = 'msg-image';
        img.src = imageUrl;
        img.alt = 'Image from ' + sender + ': ' + (fileName || 'image');
        img.addEventListener('click', function() {
            openLightbox(imageUrl, img.alt);
        });

        contentDiv.appendChild(headerDiv);
        contentDiv.appendChild(img);
        div.appendChild(avatarDiv);
        div.appendChild(contentDiv);

        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        announce('Image from ' + sender);
    }

    function addSystemMessage(text) {
        var div = document.createElement('div');
        div.className = 'system-message';
        div.setAttribute('role', 'status');
        div.textContent = text;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        announce(text);
    }

    function updateMemberList() {
        memberList.innerHTML = '';

        // Add ourselves first
        addMemberToList(displayName, true);

        // Add all known peers
        for (const [peerId, name] of peerNames) {
            const peer = peers.get(peerId);
            const connected = peer ? peer.connected : false;
            addMemberToList(name, connected);
        }

        memberCount.textContent = 1 + peerNames.size;
    }

    function addMemberToList(name, isConnected) {
        var li = document.createElement('li');
        var color = nameColor(name);
        var statusClass = isConnected ? 'connected' : 'disconnected';
        var statusLabel = isConnected ? 'connected' : 'connecting';
        li.innerHTML =
            '<div class="avatar" role="img" aria-label="' + escapeHtml(name) + '" style="background:' + color + '">' + nameInitial(name) + '</div>' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<span class="status-dot ' + statusClass + '" style="width:8px;height:8px;margin-left:auto;" aria-label="' + statusLabel + '"></span>';
        memberList.appendChild(li);
    }

    function updateConnectionStatus() {
        let anyP2P = false;
        for (const [_, peer] of peers) {
            if (peer.connected) {
                anyP2P = true;
                break;
            }
        }

        if (anyP2P) {
            connectionStatus.className = 'status-dot connected';
            connectionStatus.title = 'P2P Connected';
            connectionStatus.setAttribute('aria-label', 'Connection status: peer-to-peer connected');
        } else if (ws && ws.readyState === WebSocket.OPEN) {
            connectionStatus.className = 'status-dot connected';
            connectionStatus.title = 'Signaling Connected';
            connectionStatus.setAttribute('aria-label', 'Connection status: signaling connected');
        } else {
            connectionStatus.className = 'status-dot disconnected';
            connectionStatus.title = 'Disconnected';
            connectionStatus.setAttribute('aria-label', 'Connection status: disconnected');
        }
    }

    function showError(msg) {
        loginError.textContent = msg;
        loginError.style.display = 'block';
        announce('Error: ' + msg);
        setTimeout(function() { loginError.style.display = 'none'; }, 5000);
    }

    // ─── Event Listeners ───

    // Create Room
    createBtn.addEventListener('click', async function() {
        var name = displayNameInput.value.trim();
        var rname = roomNameInput.value.trim() || 'unnamed';

        if (!name) { showError('Please enter a display name'); return; }

        displayName = name;

        try {
            const response = await fetch(apiUrl('/api/create'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: name, room_name: rname }),
            });

            if (!response.ok) {
                const err = await response.json().catch(function() { return {}; });
                showError(err.error || 'Failed to create room');
                return;
            }

            const data = await response.json();
            roomCode = data.room_code;

            // Connect to signaling for this room
            connectSignaling(roomCode, name);
            switchToChat(roomCode);
            addSystemMessage('Room created! Share this code: ' + roomCode);
        } catch(err) {
            showError('Network error: ' + err.message);
        }
    });

    // Join Room
    joinBtn.addEventListener('click', function() {
        var name = displayNameInput.value.trim();
        var code = roomCodeInput.value.trim();

        if (!name) { showError('Please enter a display name'); return; }
        if (!code) { showError('Please enter a room code'); return; }

        displayName = name;
        roomCode = code;

        connectSignaling(code, name);
        switchToChat(code);
        addSystemMessage('Joining room...');
    });

    // Send Message
    function sendMessage() {
        var text = messageInput.value.trim();
        if (!text) return;

        broadcastMessage(text);
        messageInput.value = '';
        messageInput.focus();
    }

    sendBtn.addEventListener('click', sendMessage);

    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    // Room code keyboard formatting — auto-insert dash
    roomCodeInput.addEventListener('input', function() {
        var val = this.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (val.length > 4) {
            val = val.slice(0, 4) + '-' + val.slice(4, 8);
        }
        this.value = val;
    });

    // Copy room code on click or keyboard
    function copyRoomCode() {
        navigator.clipboard.writeText(roomCodeDisplay.textContent).then(function() {
            addSystemMessage('Room code copied to clipboard!');
        });
    }
    roomCodeDisplay.addEventListener('click', copyRoomCode);
    roomCodeDisplay.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            copyRoomCode();
        }
    });

    // Mobile sidebar toggle
    sidebarToggle.addEventListener('click', function() {
        var isOpen = sidebar.classList.toggle('open');
        sidebarToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });

    // Close sidebar on message area click (mobile)
    document.querySelector('.chat-main').addEventListener('click', function() {
        sidebar.classList.remove('open');
    });

    // Enter key on login fields
    displayNameInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') roomCodeInput.focus();
    });
    roomCodeInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') joinBtn.click();
    });
    roomNameInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') createBtn.click();
    });

    // ─── Image Event Listeners ───

    // Attach button opens file picker
    attachBtn.addEventListener('click', function() {
        fileInput.click();
    });

    // File selected via file picker
    fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) {
            showImagePreview(fileInput.files[0]);
            fileInput.value = ''; // Reset so same file can be re-selected
        }
    });

    // Preview dialog: Cancel
    previewCancel.addEventListener('click', function() {
        imagePreview.style.display = 'none';
        pendingImageFile = null;
        previewImg.src = '';
        messageInput.focus();
    });

    // Preview dialog: Send
    previewSend.addEventListener('click', async function() {
        if (!pendingImageFile) return;

        var file = pendingImageFile;
        pendingImageFile = null;
        imagePreview.style.display = 'none';
        previewImg.src = '';

        addSystemMessage('Compressing and sending image...');

        try {
            var result = await compressImage(file);
            var mimeType = file.type === 'image/gif' ? 'image/gif' : 'image/jpeg';
            await sendImage(result.blob, file.name, mimeType);
        } catch(err) {
            addSystemMessage('Failed to send image: ' + err.message);
        }

        messageInput.focus();
    });

    // Drag and drop on messages area
    messagesDiv.addEventListener('dragover', function(e) {
        e.preventDefault();
        e.stopPropagation();
        messagesDiv.classList.add('drag-over');
    });

    messagesDiv.addEventListener('dragleave', function(e) {
        e.preventDefault();
        e.stopPropagation();
        messagesDiv.classList.remove('drag-over');
    });

    messagesDiv.addEventListener('drop', function(e) {
        e.preventDefault();
        e.stopPropagation();
        messagesDiv.classList.remove('drag-over');

        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            var file = e.dataTransfer.files[0];
            if (file.type && file.type.startsWith('image/')) {
                showImagePreview(file);
            } else {
                addSystemMessage('Only image files are supported.');
            }
        }
    });

    // Clipboard paste (Ctrl+V with image)
    messageInput.addEventListener('paste', function(e) {
        if (e.clipboardData && e.clipboardData.items) {
            for (var i = 0; i < e.clipboardData.items.length; i++) {
                var item = e.clipboardData.items[i];
                if (item.type && item.type.startsWith('image/')) {
                    e.preventDefault();
                    var file = item.getAsFile();
                    if (file) {
                        showImagePreview(file);
                    }
                    return;
                }
            }
        }
    });

    // Lightbox: close button
    lightboxClose.addEventListener('click', function() {
        closeLightbox();
    });

    // Lightbox: click on background to close
    lightbox.addEventListener('click', function(e) {
        if (e.target === lightbox) {
            closeLightbox();
        }
    });

    // Lightbox: Escape key to close
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (lightbox.style.display !== 'none') {
                closeLightbox();
            } else if (imagePreview.style.display !== 'none') {
                imagePreview.style.display = 'none';
                pendingImageFile = null;
                previewImg.src = '';
                messageInput.focus();
            }
        }
    });

})();
