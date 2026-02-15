// ═══ Safepeer — WebRTC P2P Chat Client ═══

(function() {
    'use strict';

    // ─── Configuration ───
    const WORKER_URL = '';
    const ICE_SERVERS = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ];

    // ─── Image Transfer Constants ───
    const IMAGE_CHUNK_SIZE = 64 * 1024;
    const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
    const MAX_COMPRESSED_SIZE = 1024 * 1024;
    const MAX_IMAGE_DIM = 1920;
    const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/heic'];

    const REACTION_EMOJIS = ['👍','👎','❤️','😂','😮','😢','🔥','🎉','🤔','👀','💯','🙏','👏','🚀','✅','❌'];
    const STATUS_EMOJIS = ['😊','😎','🤓','💻','🎮','🎵','☕','🍕','💤','🏃','📚','🔥','❤️','🌙','✨','🎯','🤝','🚀'];
    const TYPING_TIMEOUT = 3000;
    const MAX_CHANNELS = 20;

    // ─── State ───
    let ws = null;
    let myPeerId = '';
    let displayName = '';
    let roomCode = '';
    let reconnectTimer = null;
    let muted = false;
    let myStatus = '';
    let activeChannel = 'general';
    let replyingTo = null;   // { msgId, sender, text }
    let typingTimer = null;
    let nextMsgId = 1;

    const peers = new Map();
    const peerNames = new Map();
    const peerStatuses = new Map();   // peerId → emoji
    const channels = ['general'];     // channel name list
    const channelMessages = new Map(); // channel → [msgElement, ...]
    const channelUnread = new Map();   // channel → count
    const typingPeers = new Map();     // peerId → timeout

    // Message data for reactions/replies (msgId → { sender, text, channel, reactions })
    const messageData = new Map();

    // ─── Image Transfer State ───
    let pendingImageFile = null;
    const incomingTransfers = new Map();

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
    const shareBtn = document.getElementById('share-btn');
    const shareToast = document.getElementById('share-toast');
    const channelListEl = document.getElementById('channel-list');
    const channelNameDisplay = document.getElementById('channel-name-display');
    const addChannelBtn = document.getElementById('add-channel-btn');
    const newChannelForm = document.getElementById('new-channel-form');
    const newChannelInput = document.getElementById('new-channel-input');
    const typingIndicator = document.getElementById('typing-indicator');
    const typingText = document.getElementById('typing-text');
    const replyBar = document.getElementById('reply-bar');
    const replyPreview = document.getElementById('reply-preview');
    const replyCancel = document.getElementById('reply-cancel');
    const reactionPicker = document.getElementById('reaction-picker');
    const muteBtn = document.getElementById('mute-btn');
    const muteIconOn = document.getElementById('mute-icon-on');
    const muteIconOff = document.getElementById('mute-icon-off');
    const statusBtn = document.getElementById('status-btn');
    const statusPicker = document.getElementById('status-picker');
    const statusPickerGrid = document.getElementById('status-picker-grid');
    const clearStatusBtn = document.getElementById('clear-status-btn');
    const myStatusEmoji = document.getElementById('my-status-emoji');

    // Image DOM elements
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

    // ─── Audio ───
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    let audioCtx = null;
    function playTone(freq, duration, type) {
        if (muted) return;
        if (!audioCtx) audioCtx = new AudioCtx();
        var o = audioCtx.createOscillator();
        var g = audioCtx.createGain();
        o.type = type || 'sine';
        o.frequency.value = freq;
        g.gain.value = 0.08;
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(); o.stop(audioCtx.currentTime + duration);
    }
    function playJoinSound() { playTone(880, 0.15); setTimeout(function(){ playTone(1100, 0.15); }, 100); }
    function playLeaveSound() { playTone(440, 0.2); }
    function playMessageSound() { playTone(660, 0.1, 'triangle'); }

    // ─── Accessibility ───
    function announce(text) {
        var el = document.getElementById('sr-announcements');
        if (el) { el.textContent = ''; setTimeout(function() { el.textContent = text; }, 50); }
    }

    // ─── Helpers ───
    const COLORS = [
        '#5865f2','#3ba55d','#faa61a','#ed4245','#eb459e',
        '#57f287','#fee75c','#5865f2','#9b59b6','#e67e22',
        '#1abc9c','#e91e63','#2ecc71','#3498db','#f39c12',
    ];
    function nameColor(name) {
        var h = 0; for (var i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
        return COLORS[Math.abs(h) % COLORS.length];
    }
    function nameInitial(name) { return (name || '?')[0].toUpperCase(); }
    function escapeHtml(str) { var d = document.createElement('div'); d.textContent = str; return d.innerHTML; }
    function apiUrl(path) { return (WORKER_URL || '') + path; }

    // ─── Markdown Parser ───
    function renderMarkdown(text) {
        var html = escapeHtml(text);
        // Code blocks ```...```
        html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        // Inline code `...`
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Bold **...**
        html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        // Italic *...*
        html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
        // Links https://...
        html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
        return html;
    }

    // ─── Channel Management ───
    function renderChannelList() {
        channelListEl.innerHTML = '';
        channels.forEach(function(ch) {
            var li = document.createElement('li');
            li.className = 'channel' + (ch === activeChannel ? ' active' : '');
            li.setAttribute('role', 'listitem');
            li.setAttribute('tabindex', '0');
            var nameSpan = document.createElement('span');
            nameSpan.textContent = '# ' + ch;
            li.appendChild(nameSpan);
            var unread = channelUnread.get(ch) || 0;
            if (unread > 0 && ch !== activeChannel) {
                var badge = document.createElement('span');
                badge.className = 'channel-unread';
                badge.textContent = unread > 99 ? '99+' : unread;
                li.appendChild(badge);
            }
            li.addEventListener('click', function() { switchChannel(ch); });
            li.addEventListener('keydown', function(e) { if (e.key === 'Enter') switchChannel(ch); });
            channelListEl.appendChild(li);
        });
    }

    function switchChannel(ch) {
        // Save current scroll
        activeChannel = ch;
        channelUnread.set(ch, 0);
        channelNameDisplay.textContent = '# ' + ch;
        messageInput.placeholder = 'Message #' + ch;
        renderChannelList();
        renderMessages();
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
        announce('Switched to channel ' + ch);
    }

    function addChannel(name) {
        var cleaned = name.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
        if (!cleaned || cleaned.length === 0) return;
        if (channels.includes(cleaned)) { switchChannel(cleaned); return; }
        if (channels.length >= MAX_CHANNELS) return;
        channels.push(cleaned);
        channelMessages.set(cleaned, []);
        channelUnread.set(cleaned, 0);
        renderChannelList();
        // Broadcast channel creation to peers
        broadcastPeerMessage({ type: 'channel-create', channel: cleaned });
        switchChannel(cleaned);
    }

    function renderMessages() {
        messagesDiv.innerHTML = '';
        var msgs = channelMessages.get(activeChannel) || [];
        msgs.forEach(function(el) { messagesDiv.appendChild(el); });
    }

    // ─── Signaling WebSocket ───
    function connectSignaling(code, name) {
        var proto = WORKER_URL ? (WORKER_URL.startsWith('https') ? 'wss:' : 'ws:') : (location.protocol === 'https:' ? 'wss:' : 'ws:');
        var host = WORKER_URL ? new URL(WORKER_URL).host : location.host;
        var url = proto + '//' + host + '/api/join/' + encodeURIComponent(code) + '?name=' + encodeURIComponent(name);
        ws = new WebSocket(url);
        ws.onopen = function() { updateConnectionStatus(); };
        ws.onclose = function() { updateConnectionStatus(); scheduleReconnect(); };
        ws.onerror = function() { updateConnectionStatus(); };
        ws.onmessage = function(event) {
            try { handleSignalingMessage(JSON.parse(event.data)); } catch(e) { console.error('Parse error:', e); }
        };
    }

    function scheduleReconnect() {
        if (!reconnectTimer && roomCode) {
            reconnectTimer = setTimeout(function() { reconnectTimer = null; connectSignaling(roomCode, displayName); }, 3000);
        }
    }

    function sendSignaling(obj) {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    }

    // ─── Signaling Handler ───
    function handleSignalingMessage(data) {
        switch (data.type) {
            case 'welcome':
                myPeerId = data.peerId;
                for (var m of (data.members || [])) {
                    peerNames.set(m.peerId, m.displayName);
                    createPeerConnection(m.peerId, true);
                }
                updateMemberList();
                break;
            case 'peer-joined':
                peerNames.set(data.peerId, data.displayName);
                addSystemMessage(data.displayName + ' joined the room', 'general');
                playJoinSound();
                updateMemberList();
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
                handleIncomingChat(data.sender, data.text, data.timestamp, data.channel || 'general', data.replyTo || null, data.msgId || null);
                break;
            case 'error':
                showError(data.message);
                break;
        }
    }

    // ─── WebRTC ───
    function createPeerConnection(peerId, isInitiator) {
        var pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        var peerState = { pc: pc, dataChannel: null, displayName: peerNames.get(peerId) || 'Unknown', connected: false };
        peers.set(peerId, peerState);

        pc.onicecandidate = function(event) {
            if (event.candidate) sendSignaling({ type: 'ice-candidate', to: peerId, candidate: event.candidate });
        };
        pc.onconnectionstatechange = function() {
            if (pc.connectionState === 'failed') {
                addSystemMessage('P2P failed with ' + (peerNames.get(peerId) || peerId) + '. Using server relay.', 'general');
                handlePeerDisconnected(peerId);
            } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
                handlePeerDisconnected(peerId);
            }
        };

        if (isInitiator) {
            var dc = pc.createDataChannel('chat', { ordered: true });
            setupDataChannel(dc, peerId);
            peerState.dataChannel = dc;
            pc.createOffer().then(function(offer) { return pc.setLocalDescription(offer); }).then(function() {
                sendSignaling({ type: 'offer', to: peerId, sdp: pc.localDescription.sdp });
            }).catch(function(err) { console.error('Offer error', peerId, err); });
        } else {
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
            var peer = peers.get(peerId);
            if (peer) peer.connected = true;
            updateConnectionStatus();
            updateMemberList();
            addSystemMessage('Connected to ' + (peerNames.get(peerId) || peerId) + ' (P2P)', 'general');
            // Send our channels and status to new peer
            broadcastPeerMessageTo(peerId, { type: 'sync-channels', channels: channels });
            if (myStatus) broadcastPeerMessageTo(peerId, { type: 'status', emoji: myStatus });
        };
        dc.onclose = function() { handlePeerDisconnected(peerId); };
        dc.onerror = function() {};
        dc.onmessage = function(event) {
            if (event.data instanceof ArrayBuffer) {
                handleImageChunk(event.data);
                return;
            }
            try {
                var msg = JSON.parse(event.data);
                if (msg.type === 'image-meta') {
                    handleImageMeta(peerId, msg);
                    return;
                }
                handlePeerMessage(peerId, msg);
            } catch(e) { console.error('DC parse error:', e); }
        };
    }

    function handlePeerMessage(peerId, msg) {
        switch (msg.type) {
            case 'chat':
                handleIncomingChat(msg.sender, msg.text, msg.timestamp, msg.channel || 'general', msg.replyTo || null, msg.msgId || null);
                break;
            case 'typing':
                handleTypingEvent(peerId, msg.channel);
                break;
            case 'reaction':
                handleIncomingReaction(msg.msgId, msg.emoji, msg.sender, msg.remove);
                break;
            case 'channel-create':
                if (msg.channel && !channels.includes(msg.channel) && channels.length < MAX_CHANNELS) {
                    channels.push(msg.channel);
                    channelMessages.set(msg.channel, []);
                    channelUnread.set(msg.channel, 0);
                    renderChannelList();
                }
                break;
            case 'sync-channels':
                if (Array.isArray(msg.channels)) {
                    msg.channels.forEach(function(ch) {
                        if (!channels.includes(ch) && channels.length < MAX_CHANNELS) {
                            channels.push(ch);
                            channelMessages.set(ch, []);
                            channelUnread.set(ch, 0);
                        }
                    });
                    renderChannelList();
                }
                break;
            case 'status':
                peerStatuses.set(peerId, msg.emoji || '');
                updateMemberList();
                break;
            default: break;
        }
    }

    function handleIncomingChat(sender, text, timestamp, channel, replyTo, msgId) {
        if (!channels.includes(channel)) {
            channels.push(channel);
            channelMessages.set(channel, []);
            channelUnread.set(channel, 0);
            renderChannelList();
        }
        var id = msgId || ('remote-' + (nextMsgId++));
        addChatMessage(sender, text, timestamp, channel, replyTo, id);
        if (channel !== activeChannel) {
            channelUnread.set(channel, (channelUnread.get(channel) || 0) + 1);
            renderChannelList();
        }
        playMessageSound();
    }

    async function handleOffer(fromPeerId, sdp) {
        var pc = createPeerConnection(fromPeerId, false);
        try {
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: sdp }));
            var answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignaling({ type: 'answer', to: fromPeerId, sdp: pc.localDescription.sdp });
        } catch(err) { console.error('Offer handle error', err); }
    }

    async function handleAnswer(fromPeerId, sdp) {
        var peer = peers.get(fromPeerId);
        if (!peer) return;
        try { await peer.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: sdp })); } catch(err) { console.error('Answer error', err); }
    }

    async function handleIceCandidate(fromPeerId, candidate) {
        var peer = peers.get(fromPeerId);
        if (!peer) return;
        try { if (candidate) await peer.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch(err) {}
    }

    function handlePeerLeft(peerId) {
        var name = peerNames.get(peerId) || peerId;
        var peer = peers.get(peerId);
        if (peer) {
            if (peer.dataChannel) try { peer.dataChannel.close(); } catch {}
            if (peer.pc) try { peer.pc.close(); } catch {}
            peers.delete(peerId);
        }
        peerNames.delete(peerId);
        peerStatuses.delete(peerId);
        typingPeers.delete(peerId);
        updateTypingIndicator();
        addSystemMessage(name + ' left the room', 'general');
        playLeaveSound();
        updateMemberList();
        updateConnectionStatus();
    }

    function handlePeerDisconnected(peerId) {
        var peer = peers.get(peerId);
        if (peer) { peer.connected = false; updateConnectionStatus(); updateMemberList(); }
    }

    // ─── Broadcasting ───
    function broadcastPeerMessage(msg) {
        var json = JSON.stringify(msg);
        for (var [, peer] of peers) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try { peer.dataChannel.send(json); } catch {}
            }
        }
    }

    function broadcastPeerMessageTo(peerId, msg) {
        var peer = peers.get(peerId);
        if (peer && peer.dataChannel && peer.dataChannel.readyState === 'open') {
            try { peer.dataChannel.send(JSON.stringify(msg)); } catch {}
        }
    }

    // ─── Send Message ───
    function broadcastMessage(text) {
        var msgId = myPeerId + '-' + (nextMsgId++);
        var timestamp = Math.floor(Date.now() / 1000);
        var msg = { type: 'chat', sender: displayName, text: text, timestamp: timestamp, channel: activeChannel, msgId: msgId, replyTo: replyingTo };
        var json = JSON.stringify(msg);
        var sentViaDC = false;

        for (var [, peer] of peers) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                try { peer.dataChannel.send(json); sentViaDC = true; } catch {}
            }
        }
        if (!sentViaDC && peerNames.size > 0) {
            sendSignaling({ type: 'chat', text: text, channel: activeChannel, msgId: msgId, replyTo: replyingTo });
        }
        addChatMessage(displayName, text, timestamp, activeChannel, replyingTo, msgId);
        clearReply();
    }

    // ─── Typing Indicators ───
    function sendTypingEvent() {
        broadcastPeerMessage({ type: 'typing', channel: activeChannel });
    }

    function handleTypingEvent(peerId, channel) {
        if (channel !== activeChannel) return;
        clearTimeout(typingPeers.get(peerId));
        typingPeers.set(peerId, setTimeout(function() { typingPeers.delete(peerId); updateTypingIndicator(); }, TYPING_TIMEOUT));
        updateTypingIndicator();
    }

    function updateTypingIndicator() {
        var typers = [];
        for (var [pid] of typingPeers) {
            typers.push(peerNames.get(pid) || 'Someone');
        }
        if (typers.length === 0) {
            typingIndicator.style.display = 'none';
        } else {
            typingIndicator.style.display = 'flex';
            if (typers.length === 1) typingText.textContent = typers[0] + ' is typing...';
            else if (typers.length === 2) typingText.textContent = typers[0] + ' and ' + typers[1] + ' are typing...';
            else typingText.textContent = typers.length + ' people are typing...';
        }
    }

    // ─── Reactions ───
    function toggleReaction(msgId, emoji) {
        var data = messageData.get(msgId);
        if (!data) return;
        if (!data.reactions) data.reactions = {};
        if (!data.reactions[emoji]) data.reactions[emoji] = [];
        var idx = data.reactions[emoji].indexOf(displayName);
        var removing = idx !== -1;
        if (removing) data.reactions[emoji].splice(idx, 1);
        else data.reactions[emoji].push(displayName);
        if (data.reactions[emoji].length === 0) delete data.reactions[emoji];
        broadcastPeerMessage({ type: 'reaction', msgId: msgId, emoji: emoji, sender: displayName, remove: removing });
        renderReactions(msgId);
    }

    function handleIncomingReaction(msgId, emoji, sender, remove) {
        var data = messageData.get(msgId);
        if (!data) return;
        if (!data.reactions) data.reactions = {};
        if (!data.reactions[emoji]) data.reactions[emoji] = [];
        var idx = data.reactions[emoji].indexOf(sender);
        if (remove) { if (idx !== -1) data.reactions[emoji].splice(idx, 1); }
        else { if (idx === -1) data.reactions[emoji].push(sender); }
        if (data.reactions[emoji].length === 0) delete data.reactions[emoji];
        renderReactions(msgId);
    }

    function renderReactions(msgId) {
        var container = document.querySelector('[data-msg-id="' + msgId + '"] .msg-reactions');
        if (!container) return;
        var data = messageData.get(msgId);
        container.innerHTML = '';
        if (!data || !data.reactions) return;
        Object.keys(data.reactions).forEach(function(emoji) {
            var users = data.reactions[emoji];
            if (users.length === 0) return;
            var chip = document.createElement('span');
            chip.className = 'reaction-chip' + (users.includes(displayName) ? ' mine' : '');
            chip.innerHTML = emoji + ' <span class="reaction-count">' + users.length + '</span>';
            chip.title = users.join(', ');
            chip.addEventListener('click', function() { toggleReaction(msgId, emoji); });
            container.appendChild(chip);
        });
    }

    function showReactionPicker(msgId, anchorEl) {
        reactionPicker.innerHTML = '';
        reactionPicker.style.display = 'grid';
        var rect = anchorEl.getBoundingClientRect();
        reactionPicker.style.top = (rect.top - 50) + 'px';
        reactionPicker.style.left = rect.left + 'px';
        REACTION_EMOJIS.forEach(function(emoji) {
            var btn = document.createElement('button');
            btn.textContent = emoji;
            btn.addEventListener('click', function() { toggleReaction(msgId, emoji); reactionPicker.style.display = 'none'; });
            reactionPicker.appendChild(btn);
        });
    }

    // ─── Reply ───
    function setReply(msgId, sender, text) {
        replyingTo = { msgId: msgId, sender: sender, text: text.slice(0, 80) };
        replyPreview.innerHTML = 'Replying to <strong>' + escapeHtml(sender) + '</strong>: ' + escapeHtml(replyingTo.text);
        replyBar.style.display = 'flex';
        messageInput.focus();
    }

    function clearReply() {
        replyingTo = null;
        replyBar.style.display = 'none';
    }

    // ─── UI Functions ───
    function switchToChat(code) {
        loginView.style.display = 'none';
        chatView.style.display = 'flex';
        roomTitle.textContent = 'Room';
        roomCodeDisplay.textContent = code;
        roomCodeDisplay.setAttribute('aria-label', 'Room code: ' + code + '. Press Enter to copy.');
        channelMessages.set('general', []);
        channelUnread.set('general', 0);
        renderChannelList();
        switchChannel('general');
        messageInput.focus();
        announce('Joined room ' + code);
    }

    function addChatMessage(sender, text, timestamp, channel, replyTo, msgId) {
        channel = channel || 'general';
        msgId = msgId || ('msg-' + (nextMsgId++));
        if (!channelMessages.has(channel)) channelMessages.set(channel, []);

        messageData.set(msgId, { sender: sender, text: text, channel: channel, reactions: {} });

        var div = document.createElement('div');
        div.className = 'message';
        div.setAttribute('data-msg-id', msgId);
        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

        var html = '';

        // Reply reference
        if (replyTo && replyTo.sender) {
            html += '<div class="msg-reply-ref" data-reply-to="' + escapeHtml(replyTo.msgId || '') + '">' +
                '<span class="reply-name">' + escapeHtml(replyTo.sender) + '</span> ' +
                escapeHtml((replyTo.text || '').slice(0, 60)) + '</div>';
        }

        html += '<div class="msg-avatar" role="img" aria-label="' + escapeHtml(sender) + '" style="background:' + color + '">' + nameInitial(sender) + '</div>' +
            '<div class="msg-content">';

        if (replyTo && replyTo.sender) {
            html += '<div class="msg-reply-ref" data-reply-to="' + escapeHtml(replyTo.msgId || '') + '">' +
                '<span class="reply-name">' + escapeHtml(replyTo.sender) + '</span> ' +
                escapeHtml((replyTo.text || '').slice(0, 60)) + '</div>';
        }

        html += '<div class="msg-header">' +
                '<span class="msg-name" style="color:' + color + '">' + escapeHtml(sender) + '</span>' +
                '<span class="msg-time">' + time + '</span>' +
            '</div>' +
            '<div class="msg-text">' + renderMarkdown(text) + '</div>' +
            '<div class="msg-reactions"></div>' +
            '</div>' +
            '<div class="msg-actions">' +
                '<button class="msg-action-btn" data-action="react" title="React">😀</button>' +
                '<button class="msg-action-btn" data-action="reply" title="Reply">↩</button>' +
            '</div>';

        div.innerHTML = html;

        // Bind action buttons
        div.querySelector('[data-action="react"]').addEventListener('click', function(e) {
            e.stopPropagation();
            showReactionPicker(msgId, e.target);
        });
        div.querySelector('[data-action="reply"]').addEventListener('click', function(e) {
            e.stopPropagation();
            setReply(msgId, sender, text);
        });

        channelMessages.get(channel).push(div);

        if (channel === activeChannel) {
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    function addSystemMessage(text, channel) {
        channel = channel || activeChannel;
        if (!channelMessages.has(channel)) channelMessages.set(channel, []);
        var div = document.createElement('div');
        div.className = 'system-message';
        div.setAttribute('role', 'status');
        div.textContent = text;
        channelMessages.get(channel).push(div);
        if (channel === activeChannel) {
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        announce(text);
    }

    function updateMemberList() {
        memberList.innerHTML = '';
        addMemberToList(displayName, true, myStatus);
        for (var [peerId, name] of peerNames) {
            var peer = peers.get(peerId);
            addMemberToList(name, peer ? peer.connected : false, peerStatuses.get(peerId) || '');
        }
        memberCount.textContent = 1 + peerNames.size;
    }

    function addMemberToList(name, isConnected, status) {
        var li = document.createElement('li');
        var color = nameColor(name);
        var statusClass = isConnected ? 'connected' : 'disconnected';
        var statusLabel = isConnected ? 'connected' : 'connecting';
        var statusHtml = status ? '<span class="member-status-emoji">' + status + '</span>' : '';
        li.innerHTML =
            '<div class="avatar" role="img" aria-label="' + escapeHtml(name) + '" style="background:' + color + '">' +
                nameInitial(name) + statusHtml +
            '</div>' +
            '<span>' + escapeHtml(name) + '</span>' +
            '<span class="status-dot ' + statusClass + '" style="width:8px;height:8px;margin-left:auto;" aria-label="' + statusLabel + '"></span>';
        memberList.appendChild(li);
    }

    function updateConnectionStatus() {
        var anyP2P = false;
        for (var [, peer] of peers) { if (peer.connected) { anyP2P = true; break; } }
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

    // ─── Share ───
    function getShareUrl() {
        var origin = location.origin || (location.protocol + '//' + location.host);
        return origin + '/#' + roomCodeDisplay.textContent;
    }

    function showShareToast(text) {
        shareToast.textContent = text;
        shareToast.classList.add('visible');
        announce(text);
        clearTimeout(shareToast._timer);
        shareToast._timer = setTimeout(function() { shareToast.classList.remove('visible'); }, 2500);
    }

    async function shareRoom() {
        var url = getShareUrl();
        if (navigator.share) {
            try { await navigator.share({ title: 'Safepeer Room', text: 'Join my Safepeer room: ' + roomCodeDisplay.textContent, url: url }); showShareToast('Shared!'); return; }
            catch (err) { if (err.name === 'AbortError') return; }
        }
        try { await navigator.clipboard.writeText(url); showShareToast('Invite link copied!'); }
        catch (err) { showShareToast('Link: ' + url); }
    }

    // ─── Status Picker ───
    function initStatusPicker() {
        STATUS_EMOJIS.forEach(function(emoji) {
            var btn = document.createElement('button');
            btn.textContent = emoji;
            btn.addEventListener('click', function() { setStatus(emoji); statusPicker.style.display = 'none'; });
            statusPickerGrid.appendChild(btn);
        });
    }

    function setStatus(emoji) {
        myStatus = emoji;
        myStatusEmoji.textContent = emoji;
        broadcastPeerMessage({ type: 'status', emoji: emoji });
        updateMemberList();
    }

    function clearStatus() {
        myStatus = '';
        myStatusEmoji.textContent = '';
        broadcastPeerMessage({ type: 'status', emoji: '' });
        updateMemberList();
        statusPicker.style.display = 'none';
    }

    initStatusPicker();

    // ─── Image Transfer ───
    function hashString(str) {
        var hash = 0;
        for (var i = 0; i < str.length; i++) {
            hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
        }
        return hash >>> 0;
    }

    function compressImage(file) {
        return new Promise(function(resolve, reject) {
            if (file.type === 'image/gif') {
                resolve({ blob: file, width: 0, height: 0 });
                return;
            }
            var reader = new FileReader();
            reader.onload = function() {
                var img = new Image();
                img.onload = function() {
                    var w = img.width;
                    var h = img.height;
                    var scale = Math.min(1, MAX_IMAGE_DIM / Math.max(w, h));
                    w = Math.round(w * scale);
                    h = Math.round(h * scale);
                    var canvas = document.createElement('canvas');
                    canvas.width = w;
                    canvas.height = h;
                    var ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, w, h);
                    var qualities = [0.85, 0.7, 0.5, 0.3];
                    function tryQuality(idx) {
                        if (idx >= qualities.length) {
                            reject(new Error('Image too large even after compression'));
                            return;
                        }
                        canvas.toBlob(function(blob) {
                            if (!blob) { reject(new Error('Compression failed')); return; }
                            if (blob.size <= MAX_COMPRESSED_SIZE) {
                                resolve({ blob: blob, width: w, height: h });
                            } else {
                                tryQuality(idx + 1);
                            }
                        }, 'image/jpeg', qualities[idx]);
                    }
                    tryQuality(0);
                };
                img.onerror = function() { reject(new Error('Failed to load image')); };
                img.src = reader.result;
            };
            reader.onerror = function() { reject(new Error('Failed to read file')); };
            reader.readAsDataURL(file);
        });
    }

    function hasOpenDataChannels() {
        for (var [, peer] of peers) {
            if (peer.dataChannel && peer.dataChannel.readyState === 'open') return true;
        }
        return false;
    }

    function sendImageToPeers(blob, fileName) {
        var transferId = myPeerId + '-' + Date.now();
        var mimeType = blob.type || 'image/jpeg';
        var reader = new FileReader();
        reader.onload = function() {
            var buffer = reader.result;
            var totalChunks = Math.ceil(buffer.byteLength / IMAGE_CHUNK_SIZE);
            var meta = { type: 'image-meta', transferId: transferId, fileName: fileName, mimeType: mimeType, totalChunks: totalChunks, totalSize: buffer.byteLength, sender: displayName, timestamp: Math.floor(Date.now() / 1000) };
            var metaJson = JSON.stringify(meta);
            var transferIdHash = hashString(transferId);

            for (var [, peer] of peers) {
                if (peer.dataChannel && peer.dataChannel.readyState === 'open') {
                    try { peer.dataChannel.send(metaJson); } catch(e) {}
                }
            }

            for (var i = 0; i < totalChunks; i++) {
                var start = i * IMAGE_CHUNK_SIZE;
                var end = Math.min(start + IMAGE_CHUNK_SIZE, buffer.byteLength);
                var chunkData = buffer.slice(start, end);
                var headerBuf = new ArrayBuffer(24 + chunkData.byteLength);
                var view = new DataView(headerBuf);
                view.setUint8(0, 0x49); // I
                view.setUint8(1, 0x4D); // M
                view.setUint8(2, 0x47); // G
                view.setUint8(3, 0x00);
                view.setUint32(4, transferIdHash);
                view.setUint32(8, i);
                view.setUint32(12, totalChunks);
                new Uint8Array(headerBuf, 24).set(new Uint8Array(chunkData));

                for (var [, peer2] of peers) {
                    if (peer2.dataChannel && peer2.dataChannel.readyState === 'open') {
                        try { peer2.dataChannel.send(headerBuf); } catch(e) {}
                    }
                }
            }

            var localBlob = new Blob([buffer], { type: mimeType });
            var localUrl = URL.createObjectURL(localBlob);
            addImageMessage(displayName, localUrl, fileName, Math.floor(Date.now() / 1000), activeChannel);
        };
        reader.readAsArrayBuffer(blob);
    }

    function handleImageMeta(peerId, meta) {
        incomingTransfers.set(meta.transferId, {
            meta: meta,
            chunks: new Array(meta.totalChunks),
            received: 0,
            hash: hashString(meta.transferId)
        });
        addImageLoadingPlaceholder(meta.transferId, meta.sender, meta.timestamp, meta.meta_channel || activeChannel);
    }

    function handleImageChunk(data) {
        var view = new DataView(data);
        if (view.getUint8(0) !== 0x49 || view.getUint8(1) !== 0x4D || view.getUint8(2) !== 0x47) return false;
        var transferHash = view.getUint32(4);
        var chunkIndex = view.getUint32(8);
        var totalChunks = view.getUint32(12);
        var chunkData = data.slice(24);

        for (var [tid, transfer] of incomingTransfers) {
            if (transfer.hash === transferHash) {
                if (!transfer.chunks[chunkIndex]) {
                    transfer.chunks[chunkIndex] = chunkData;
                    transfer.received++;
                }
                if (transfer.received >= totalChunks) {
                    reassembleImage(tid);
                }
                return true;
            }
        }
        return true;
    }

    function reassembleImage(transferId) {
        var transfer = incomingTransfers.get(transferId);
        if (!transfer) return;
        var totalSize = 0;
        for (var i = 0; i < transfer.chunks.length; i++) {
            if (!transfer.chunks[i]) return;
            totalSize += transfer.chunks[i].byteLength;
        }
        var combined = new Uint8Array(totalSize);
        var offset = 0;
        for (var j = 0; j < transfer.chunks.length; j++) {
            combined.set(new Uint8Array(transfer.chunks[j]), offset);
            offset += transfer.chunks[j].byteLength;
        }
        var blob = new Blob([combined], { type: transfer.meta.mimeType });
        var blobUrl = URL.createObjectURL(blob);
        removeImageLoadingPlaceholder(transferId);
        addImageMessage(transfer.meta.sender, blobUrl, transfer.meta.fileName, transfer.meta.timestamp, activeChannel);
        incomingTransfers.delete(transferId);
    }

    function addImageLoadingPlaceholder(transferId, sender, timestamp, channel) {
        channel = channel || activeChannel;
        if (!channelMessages.has(channel)) channelMessages.set(channel, []);
        var div = document.createElement('div');
        div.className = 'message';
        div.setAttribute('data-transfer-id', transferId);
        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
        div.innerHTML =
            '<div class="msg-avatar" style="background:' + color + '">' + nameInitial(sender) + '</div>' +
            '<div class="msg-content">' +
                '<div class="msg-header">' +
                    '<span class="msg-name" style="color:' + color + '">' + escapeHtml(sender) + '</span>' +
                    '<span class="msg-time">' + time + '</span>' +
                '</div>' +
                '<div class="msg-image-loading"></div>' +
            '</div>';
        channelMessages.get(channel).push(div);
        if (channel === activeChannel) {
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
    }

    function removeImageLoadingPlaceholder(transferId) {
        var el = document.querySelector('[data-transfer-id="' + transferId + '"]');
        if (el) el.remove();
        // Also remove from channelMessages arrays
        for (var [, msgs] of channelMessages) {
            for (var i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].getAttribute && msgs[i].getAttribute('data-transfer-id') === transferId) {
                    msgs.splice(i, 1);
                }
            }
        }
    }

    function addImageMessage(sender, imageUrl, fileName, timestamp, channel) {
        channel = channel || activeChannel;
        var msgId = 'img-' + (nextMsgId++);
        if (!channelMessages.has(channel)) channelMessages.set(channel, []);
        messageData.set(msgId, { sender: sender, text: '[Image: ' + fileName + ']', channel: channel, reactions: {} });

        var div = document.createElement('div');
        div.className = 'message';
        div.setAttribute('data-msg-id', msgId);
        var color = nameColor(sender);
        var time = timestamp ? new Date(timestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';

        div.innerHTML =
            '<div class="msg-avatar" role="img" aria-label="' + escapeHtml(sender) + '" style="background:' + color + '">' + nameInitial(sender) + '</div>' +
            '<div class="msg-content">' +
                '<div class="msg-header">' +
                    '<span class="msg-name" style="color:' + color + '">' + escapeHtml(sender) + '</span>' +
                    '<span class="msg-time">' + time + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="msg-actions">' +
                '<button class="msg-action-btn" data-action="react" title="React">😀</button>' +
            '</div>';

        var img = document.createElement('img');
        img.className = 'msg-image';
        img.src = imageUrl;
        img.alt = 'Image from ' + sender + ': ' + fileName;
        img.addEventListener('click', function() { openLightbox(imageUrl, img.alt); });
        div.querySelector('.msg-content').appendChild(img);

        var reactionsDiv = document.createElement('div');
        reactionsDiv.className = 'msg-reactions';
        div.querySelector('.msg-content').appendChild(reactionsDiv);

        div.querySelector('[data-action="react"]').addEventListener('click', function(e) {
            e.stopPropagation();
            showReactionPicker(msgId, e.target);
        });

        channelMessages.get(channel).push(div);
        if (channel === activeChannel) {
            messagesDiv.appendChild(div);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        announce('Image from ' + sender);
    }

    // ─── Lightbox ───
    function openLightbox(src, alt) {
        lightboxImg.src = src;
        lightboxImg.alt = alt || 'Full size image';
        lightbox.style.display = 'flex';
        lightbox.focus();
    }

    function closeLightbox() {
        lightbox.style.display = 'none';
        lightboxImg.src = '';
    }

    // ─── Image Preview Helpers ───
    function showImagePreview(file) {
        pendingImageFile = file;
        var reader = new FileReader();
        reader.onload = function() {
            previewImg.src = reader.result;
            var sizeKB = Math.round(file.size / 1024);
            previewInfo.textContent = file.name + ' (' + (sizeKB > 1024 ? (sizeKB / 1024).toFixed(1) + ' MB' : sizeKB + ' KB') + ')';
            imagePreview.style.display = 'flex';
        };
        reader.readAsDataURL(file);
    }

    function hideImagePreview() {
        imagePreview.style.display = 'none';
        previewImg.src = '';
        previewInfo.textContent = '';
        pendingImageFile = null;
        fileInput.value = '';
    }

    function validateAndPreviewImage(file) {
        if (!file) return;
        if (!ALLOWED_MIME.includes(file.type)) {
            addSystemMessage('Unsupported image format. Use JPG, PNG, GIF, or WebP.');
            return;
        }
        if (file.size > MAX_IMAGE_SIZE) {
            addSystemMessage('Image too large (max 5 MB).');
            return;
        }
        showImagePreview(file);
    }

    async function sendPendingImage() {
        if (!pendingImageFile) return;
        if (!hasOpenDataChannels()) {
            addSystemMessage('Image sending requires a peer-to-peer connection. No P2P links are open.');
            hideImagePreview();
            return;
        }
        var file = pendingImageFile;
        hideImagePreview();
        try {
            var result = await compressImage(file);
            sendImageToPeers(result.blob, file.name);
        } catch(e) {
            addSystemMessage('Failed to send image: ' + e.message);
        }
    }

    // ═══ Event Listeners ═══

    createBtn.addEventListener('click', async function() {
        var name = displayNameInput.value.trim();
        if (!name) { showError('Please enter a display name'); return; }
        displayName = name;
        try {
            var response = await fetch(apiUrl('/api/create'), {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ display_name: name, room_name: roomNameInput.value.trim() || 'unnamed' }),
            });
            if (!response.ok) { var err = await response.json().catch(function(){return {};}); showError(err.error || 'Failed to create room'); return; }
            var data = await response.json();
            roomCode = data.room_code;
            connectSignaling(roomCode, name);
            switchToChat(roomCode);
            addSystemMessage('Room created! Share this code: ' + roomCode, 'general');
        } catch(err) { showError('Network error: ' + err.message); }
    });

    joinBtn.addEventListener('click', function() {
        var name = displayNameInput.value.trim();
        var code = roomCodeInput.value.trim();
        if (!name) { showError('Please enter a display name'); return; }
        if (!code) { showError('Please enter a room code'); return; }
        displayName = name;
        roomCode = code;
        connectSignaling(code, name);
        switchToChat(code);
        addSystemMessage('Joining room...', 'general');
    });

    function sendMessage() {
        var text = messageInput.value.trim();
        if (!text) return;
        broadcastMessage(text);
        messageInput.value = '';
        messageInput.focus();
    }

    sendBtn.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });

    // Typing detection
    messageInput.addEventListener('input', function() {
        clearTimeout(typingTimer);
        sendTypingEvent();
        typingTimer = setTimeout(function() {}, TYPING_TIMEOUT);
    });

    // Room code formatting
    roomCodeInput.addEventListener('input', function() {
        var val = this.value.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        if (val.length > 4) val = val.slice(0, 4) + '-' + val.slice(4, 8);
        this.value = val;
    });

    // Copy room code
    function copyRoomCode() {
        navigator.clipboard.writeText(roomCodeDisplay.textContent).then(function() { showShareToast('Room code copied!'); });
    }
    roomCodeDisplay.addEventListener('click', copyRoomCode);
    roomCodeDisplay.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copyRoomCode(); } });

    shareBtn.addEventListener('click', shareRoom);

    // Channel creation
    addChannelBtn.addEventListener('click', function() {
        newChannelForm.style.display = newChannelForm.style.display === 'none' ? 'flex' : 'none';
        if (newChannelForm.style.display === 'flex') newChannelInput.focus();
    });
    newChannelInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            var name = newChannelInput.value.trim();
            if (name) addChannel(name);
            newChannelInput.value = '';
            newChannelForm.style.display = 'none';
        } else if (e.key === 'Escape') {
            newChannelInput.value = '';
            newChannelForm.style.display = 'none';
        }
    });

    // Reply
    replyCancel.addEventListener('click', clearReply);

    // Mute
    muteBtn.addEventListener('click', function() {
        muted = !muted;
        muteBtn.classList.toggle('muted', muted);
        muteIconOn.style.display = muted ? 'none' : 'block';
        muteIconOff.style.display = muted ? 'block' : 'none';
    });

    // Status
    statusBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        statusPicker.style.display = statusPicker.style.display === 'none' ? 'block' : 'none';
    });
    clearStatusBtn.addEventListener('click', clearStatus);

    // Close pickers on outside click
    document.addEventListener('click', function(e) {
        if (!reactionPicker.contains(e.target)) reactionPicker.style.display = 'none';
        if (!statusPicker.contains(e.target) && e.target !== statusBtn) statusPicker.style.display = 'none';
    });

    // Sidebar toggle
    sidebarToggle.addEventListener('click', function() {
        var isOpen = sidebar.classList.toggle('open');
        sidebarToggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
    document.querySelector('.chat-main').addEventListener('click', function() { sidebar.classList.remove('open'); });

    // Login field navigation
    displayNameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') roomCodeInput.focus(); });
    roomCodeInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') joinBtn.click(); });
    roomNameInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') createBtn.click(); });

    // ─── Image Event Listeners ───
    attachBtn.addEventListener('click', function() { fileInput.click(); });

    fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files[0]) {
            validateAndPreviewImage(fileInput.files[0]);
        }
    });

    previewCancel.addEventListener('click', hideImagePreview);
    previewSend.addEventListener('click', sendPendingImage);

    // Drag and drop
    messagesDiv.addEventListener('dragover', function(e) {
        e.preventDefault();
        messagesDiv.classList.add('drag-over');
    });
    messagesDiv.addEventListener('dragleave', function(e) {
        e.preventDefault();
        messagesDiv.classList.remove('drag-over');
    });
    messagesDiv.addEventListener('drop', function(e) {
        e.preventDefault();
        messagesDiv.classList.remove('drag-over');
        var files = e.dataTransfer.files;
        if (files && files.length > 0 && files[0].type.startsWith('image/')) {
            validateAndPreviewImage(files[0]);
        }
    });

    // Clipboard paste
    messageInput.addEventListener('paste', function(e) {
        var items = e.clipboardData && e.clipboardData.items;
        if (!items) return;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.startsWith('image/')) {
                e.preventDefault();
                var file = items[i].getAsFile();
                if (file) validateAndPreviewImage(file);
                return;
            }
        }
    });

    // Lightbox
    lightboxClose.addEventListener('click', closeLightbox);
    lightbox.addEventListener('click', function(e) {
        if (e.target === lightbox) closeLightbox();
    });
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && lightbox.style.display !== 'none') {
            closeLightbox();
        }
    });

    // URL hash auto-fill
    function checkUrlHash() {
        var hash = location.hash.replace('#', '').trim();
        if (hash.length >= 8 && hash.length <= 9) {
            roomCodeInput.value = hash.toUpperCase();
            roomCodeInput.dispatchEvent(new Event('input'));
            displayNameInput.focus();
        }
    }
    checkUrlHash();
    window.addEventListener('hashchange', checkUrlHash);

    // ─── Mobile Keyboard Avoidance ───
    (function() {
        if (!window.visualViewport) return;
        var root = document.documentElement;
        var initialHeight = window.visualViewport.height;

        function onViewportResize() {
            var vpHeight = window.visualViewport.height;
            root.style.setProperty('--app-height', vpHeight + 'px');
            // Auto-scroll messages when keyboard opens (>25% height reduction)
            if (vpHeight < initialHeight * 0.75 && messagesDiv) {
                requestAnimationFrame(function() {
                    messagesDiv.scrollTop = messagesDiv.scrollHeight;
                });
            }
        }

        window.visualViewport.addEventListener('resize', onViewportResize);
        onViewportResize();
    })();

})();
