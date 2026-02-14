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

    // ─── State ───
    let ws = null;                          // Signaling WebSocket
    let myPeerId = '';                      // Assigned by server
    let displayName = '';                   // Our display name
    let roomCode = '';                      // Current room code
    let reconnectTimer = null;
    const peers = new Map();                // peerId → { pc, dataChannel, displayName, connected }
    const peerNames = new Map();            // peerId → displayName

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
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                handlePeerDisconnected(peerId);
            }
        };

        if (isInitiator) {
            // Create data channel and offer
            const dc = pc.createDataChannel('chat', { ordered: true });
            setupDataChannel(dc, peerId);
            peerState.dataChannel = dc;

            pc.createOffer().then(function(offer) {
                return pc.setLocalDescription(offer);
            }).then(function() {
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
            try {
                const msg = JSON.parse(event.data);
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
        messageInput.focus();
    }

    function addChatMessage(sender, text, timestamp) {
        var div = document.createElement('div');
        div.className = 'message';

        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

        div.innerHTML =
            '<div class="msg-avatar" style="background:' + color + '">' + nameInitial(sender) + '</div>' +
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

    function addSystemMessage(text) {
        var div = document.createElement('div');
        div.className = 'system-message';
        div.textContent = text;
        messagesDiv.appendChild(div);
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
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
        li.innerHTML =
            '<div class="avatar" style="background:' + color + '">' + nameInitial(name) + '</div>' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<span class="status-dot ' + statusClass + '" style="width:8px;height:8px;margin-left:auto;"></span>';
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
        } else if (ws && ws.readyState === WebSocket.OPEN) {
            connectionStatus.className = 'status-dot connected';
            connectionStatus.title = 'Signaling Connected';
        } else {
            connectionStatus.className = 'status-dot disconnected';
            connectionStatus.title = 'Disconnected';
        }
    }

    function showError(msg) {
        loginError.textContent = msg;
        loginError.style.display = 'block';
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

    // Copy room code on click
    roomCodeDisplay.addEventListener('click', function() {
        navigator.clipboard.writeText(this.textContent).then(function() {
            addSystemMessage('Room code copied to clipboard!');
        });
    });

    // Mobile sidebar toggle
    sidebarToggle.addEventListener('click', function() {
        sidebar.classList.toggle('open');
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

})();
