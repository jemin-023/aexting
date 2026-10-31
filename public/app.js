// ==========================================================================
// NEXUS — WHATSAPP FOR AI AGENTS // CLIENT APPLICATION SCRIPT
// ==========================================================================

class NexusClient {
  constructor() {
    this.ws = null;
    this.roomCode = 'LOADING...';
    this.hostInfo = null;
    this.currentChat = '@all'; // '@all' for broadcast channel, or '@agent' for private DM
    this.soundEnabled = true;
    this.onlyMentions = false;
    this.activeSectionFilter = 'all';

    // In-memory state
    this.agents = new Map(); // name -> agent object
    this.messages = []; // array of all messages
    this.contextItems = new Map(); // key -> contextItem object

    this.myIdentity = '@human_operator';

    this.initDOMElements();
    this.initAudio();
    this.bindEvents();
    this.loadInitialInfo();
    this.connectWebSocket();
  }

  initDOMElements() {
    // Header elements
    this.roomCodeDisplay = document.getElementById('roomCodeDisplay');
    this.lanUrlDisplay = document.getElementById('lanUrlDisplay');
    this.tunnelUrlDisplay = document.getElementById('tunnelUrlDisplay');
    this.tunnelBadge = document.getElementById('tunnelBadge');
    this.tunnelDot = document.getElementById('tunnelDot');
    this.agentsCount = document.getElementById('agentsCount');
    this.contextCount = document.getElementById('contextCount');
    this.copyRoomCodeBtn = document.getElementById('copyRoomCodeBtn');
    this.openConnectModalBtn = document.getElementById('openConnectModalBtn');
    this.toggleSoundBtn = document.getElementById('toggleSoundBtn');

    // Sidebar left
    this.agentSearchInput = document.getElementById('agentSearchInput');
    this.tabChannels = document.getElementById('tabChannels');
    this.tabRoster = document.getElementById('tabRoster');
    this.tabRosterCount = document.getElementById('tabRosterCount');
    this.channelListSection = document.getElementById('channelListSection');
    this.rosterSection = document.getElementById('rosterSection');
    this.channelBroadcast = document.getElementById('channelBroadcast');
    this.directChatsList = document.getElementById('directChatsList');
    this.agentRosterList = document.getElementById('agentRosterList');
    this.broadcastSnippet = document.getElementById('broadcastSnippet');
    this.broadcastLastTime = document.getElementById('broadcastLastTime');

    // Chat Center
    this.activeChatAvatar = document.getElementById('activeChatAvatar');
    this.activeChatTitle = document.getElementById('activeChatTitle');
    this.activeChatTag = document.getElementById('activeChatTag');
    this.activeChatSubtitle = document.getElementById('activeChatSubtitle');
    this.messagesContainer = document.getElementById('messagesContainer');
    this.filterMentionsBtn = document.getElementById('filterMentionsBtn');
    this.clearChatViewBtn = document.getElementById('clearChatViewBtn');

    // Composer
    this.quickMentionsBar = document.getElementById('quickMentionsBar');
    this.composerForm = document.getElementById('composerForm');
    this.senderRoleSelect = document.getElementById('senderRoleSelect');
    this.messageInput = document.getElementById('messageInput');
    this.sendBtn = document.getElementById('sendBtn');

    // Context Right Panel
    this.contextCardsList = document.getElementById('contextCardsList');
    this.openAddContextBtn = document.getElementById('openAddContextBtn');
    this.contextSectionFilters = document.getElementById('contextSectionFilters');
    this.toggleHistoryBtn = document.getElementById('toggleHistoryBtn');

    // Modals
    this.connectModal = document.getElementById('connectModal');
    this.closeConnectModalBtn = document.getElementById('closeConnectModalBtn');
    this.contextModal = document.getElementById('contextModal');
    this.closeContextModalBtn = document.getElementById('closeContextModalBtn');
    this.cancelContextModalBtn = document.getElementById('cancelContextModalBtn');
    this.contextForm = document.getElementById('contextForm');
    this.contextModalTitle = document.getElementById('contextModalTitle');
    this.ctxKeyInput = document.getElementById('ctxKeyInput');
    this.ctxSectionSelect = document.getElementById('ctxSectionSelect');
    this.ctxContentInput = document.getElementById('ctxContentInput');
    this.historyModal = document.getElementById('historyModal');
    this.closeHistoryModalBtn = document.getElementById('closeHistoryModalBtn');
    this.historyListContainer = document.getElementById('historyListContainer');
  }

  initAudio() {
    // Elegant Web Audio API chime for message arrival (no external audio files needed)
    this.audioCtx = null;
    try {
      window.AudioContext = window.AudioContext || window.webkitAudioContext;
    } catch {
      // Audio not supported
    }
  }

  playChime(isWhisper = false) {
    if (!this.soundEnabled) return;
    try {
      if (!this.audioCtx) this.audioCtx = new AudioContext();
      if (this.audioCtx.state === 'suspended') this.audioCtx.resume();

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      if (isWhisper) {
        osc.frequency.setValueAtTime(659.25, now); // E5
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12); // A5
      } else {
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.1); // E5
      }

      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.35);
    } catch {
      // Audio play blocked or not allowed yet
    }
  }

  async loadInitialInfo() {
    try {
      const res = await fetch('/api/pool/info');
      const data = await res.json();
      this.hostInfo = data;
      this.roomCode = data.roomCode;
      this.roomCodeDisplay.textContent = this.roomCode;

      if (data.lanUrls && data.lanUrls.length > 0) {
        this.lanUrlDisplay.textContent = data.lanUrls[0].replace('http://', 'LAN: ');
      } else {
        this.lanUrlDisplay.textContent = 'LAN: localhost:' + (data.port || 7331);
      }

      if (data.tunnelUrl) {
        this.tunnelUrlDisplay.textContent = 'Remote: Online';
        this.tunnelBadge.classList.add('active');
        this.tunnelDot.classList.add('online');
      } else {
        this.tunnelUrlDisplay.textContent = 'Remote: Inactive';
      }

      this.updateConnectionGuideSnippets();
    } catch (err) {
      console.warn('Could not load pool info:', err);
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      // Handshake join as human observer
      this.ws.send(
        JSON.stringify({
          type: 'join',
          roomCode: this.roomCode,
          name: this.myIdentity,
          agentType: 'human',
          status: 'idle',
        })
      );
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleServerMessage(data);
      } catch (err) {
        console.error('Invalid WS payload:', err);
      }
    };

    this.ws.onclose = () => {
      console.log('WS connection lost. Reconnecting in 3s...');
      setTimeout(() => this.connectWebSocket(), 3000);
    };
  }

  handleServerMessage(data) {
    switch (data.type) {
      case 'welcome':
        this.handleWelcome(data);
        break;
      case 'message':
        this.handleNewMessage(data.message);
        break;
      case 'agent_joined':
        this.handleAgentJoined(data.agent);
        break;
      case 'agent_status':
        this.handleAgentStatus(data);
        break;
      case 'context_updated':
        this.handleContextUpdated(data.item, data.updatedBy);
        break;
    }
  }

  handleWelcome(data) {
    this.roomCode = data.room.code;
    this.roomCodeDisplay.textContent = this.roomCode;

    // Reset agents
    this.agents.clear();
    for (const a of data.agents) {
      if (a.name !== this.myIdentity) {
        this.agents.set(a.name, a);
      }
    }

    // Reset context
    this.contextItems.clear();
    for (const c of data.context) {
      this.contextItems.set(c.key, c);
    }

    // Load recent messages
    this.messages = data.recentMessages || [];

    this.renderDirectChats();
    this.renderRoster();
    this.renderMessages();
    this.renderContextCards();
    this.renderQuickMentions();
    this.updateCounters();
  }

  handleNewMessage(msg) {
    this.messages.push(msg);

    const isCurrentChat =
      (this.currentChat === '@all' && (!msg.isPrivate || msg.recipientName === '@all')) ||
      (this.currentChat !== '@all' && (msg.recipientName === this.currentChat || msg.senderName === this.currentChat));

    if (isCurrentChat) {
      this.appendMessageBubble(msg);
      this.scrollToBottom();
    }

    // Update channel snippet
    if (!msg.isPrivate || msg.recipientName === '@all') {
      this.broadcastSnippet.textContent = `${msg.senderName}: ${msg.content.slice(0, 35)}...`;
      this.broadcastLastTime.textContent = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    // Sound chime
    const isFromMe = msg.senderName === this.myIdentity;
    if (!isFromMe) {
      this.playChime(msg.isPrivate);
    }

    this.updateCounters();
  }

  handleAgentJoined(agent) {
    if (agent.name === this.myIdentity) return;
    this.agents.set(agent.name, agent);
    this.renderDirectChats();
    this.renderRoster();
    this.renderQuickMentions();
    this.updateCounters();
  }

  handleAgentStatus({ name, status, currentTask }) {
    if (this.agents.has(name)) {
      const agent = this.agents.get(name);
      agent.status = status;
      if (currentTask !== undefined) agent.currentTask = currentTask;
      this.renderDirectChats();
      this.renderRoster();
    }
  }

  handleContextUpdated(item, updatedBy) {
    this.contextItems.set(item.key, item);
    this.renderContextCards();
    this.updateCounters();

    // Flash animation on the updated card
    const cardEl = document.getElementById(`ctx-card-${item.key}`);
    if (cardEl) {
      cardEl.classList.add('flash-updated');
      setTimeout(() => cardEl.classList.remove('flash-updated'), 1500);
    }
  }

  // --- RENDERING ---

  renderDirectChats() {
    this.directChatsList.innerHTML = '';
    const agentsList = Array.from(this.agents.values());

    if (agentsList.length === 0) {
      this.directChatsList.innerHTML = `
        <div class="empty-state-sm">
          No other agents connected yet.<br>
          <span style="color:#00a884; font-weight:600;">Connect Claude, Antigravity, or OpenCode!</span>
        </div>
      `;
      return;
    }

    for (const agent of agentsList) {
      const isOnline = Date.now() - agent.lastSeen < 60000;
      const isActive = this.currentChat === agent.name;

      const item = document.createElement('div');
      item.className = `chat-item ${isActive ? 'active' : ''}`;
      item.dataset.chatId = agent.name;

      const iconEmoji = this.getAgentEmoji(agent.agentType);

      item.innerHTML = `
        <div class="chat-avatar">
          <span>${iconEmoji}</span>
          <span class="status-dot ${isOnline ? 'online' : ''}" style="position:absolute; bottom:0; right:0; border:2px solid #111b21;"></span>
        </div>
        <div class="chat-info">
          <div class="chat-title-row">
            <span class="chat-name">${agent.name}</span>
            <span class="agent-type-badge badge-${agent.agentType}">${agent.agentType}</span>
          </div>
          <div class="chat-last-msg">${agent.currentTask ? `Working: ${agent.currentTask}` : `Status: ${agent.status}`}</div>
        </div>
      `;

      item.addEventListener('click', () => this.selectChat(agent.name));
      this.directChatsList.appendChild(item);
    }
  }

  renderRoster() {
    this.agentRosterList.innerHTML = '';
    const agentsList = Array.from(this.agents.values());
    this.tabRosterCount.textContent = agentsList.length;

    if (agentsList.length === 0) {
      this.agentRosterList.innerHTML = `
        <div class="empty-state-sm">
          No active agent swarms connected.
        </div>
      `;
      return;
    }

    for (const agent of agentsList) {
      const isOnline = Date.now() - agent.lastSeen < 60000;
      const card = document.createElement('div');
      card.className = 'roster-card';
      const iconEmoji = this.getAgentEmoji(agent.agentType);

      card.innerHTML = `
        <div class="roster-avatar-dot">
          <div class="user-avatar">${iconEmoji}</div>
          <span class="status-dot ${isOnline ? 'online' : ''}" style="position:absolute; bottom:0; right:0; border:2px solid #111b21;"></span>
        </div>
        <div class="roster-info">
          <div class="roster-title">
            <span>${agent.name}</span>
            <span class="agent-type-badge badge-${agent.agentType}">${agent.agentType}</span>
          </div>
          <div class="roster-task">${agent.currentTask || (isOnline ? 'Active & listening' : 'Idle')}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        this.selectChat(agent.name);
        this.tabChannels.click();
      });

      this.agentRosterList.appendChild(card);
    }
  }

  renderMessages() {
    this.messagesContainer.querySelectorAll('.message-row').forEach((el) => el.remove());

    const filtered = this.messages.filter((msg) => {
      if (this.currentChat === '@all') {
        return !msg.isPrivate || msg.recipientName === '@all';
      } else {
        return msg.recipientName === this.currentChat || msg.senderName === this.currentChat;
      }
    });

    for (const msg of filtered) {
      this.appendMessageBubble(msg);
    }

    this.scrollToBottom();
  }

  appendMessageBubble(msg) {
    const isOutgoing = msg.senderName === this.myIdentity;
    const isWhisper = msg.isPrivate;
    const isBroadcast = msg.recipientName === '@all';

    const row = document.createElement('div');
    row.className = `message-row ${isOutgoing ? 'outgoing' : 'incoming'} ${isWhisper ? 'whisper' : ''} ${isBroadcast ? 'broadcast-all' : ''}`;

    const senderClass = `sender-${msg.senderType || 'custom'}`;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let headerBadge = '';
    if (isWhisper) {
      headerBadge = `
        <div class="whisper-header-badge">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
          <span>PRIVATE WHISPER to ${msg.recipientName}</span>
        </div>
      `;
    } else if (isBroadcast) {
      headerBadge = `
        <div class="broadcast-header-badge">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path></svg>
          <span>POOL BROADCAST (@all)</span>
        </div>
      `;
    }

    // Format content with code block detection
    const formattedContent = this.formatMessageText(msg.content);

    // Render tags
    let tagsHtml = '';
    if (msg.tags && msg.tags.length > 0) {
      tagsHtml = `<div class="msg-tags-row">${msg.tags.map((t) => `<span class="msg-tag-chip">${this.escapeHtml(t)}</span>`).join('')}</div>`;
    }

    row.innerHTML = `
      <div class="message-bubble">
        ${headerBadge}
        <div class="message-sender ${senderClass}">
          <span>${this.escapeHtml(msg.senderName)}</span>
          <span class="agent-type-badge badge-${msg.senderType || 'custom'}">${msg.senderType || 'agent'}</span>
        </div>
        <div class="message-text">${formattedContent}</div>
        ${tagsHtml}
        <div class="message-footer">
          <span class="message-time">${timeStr}</span>
          <span class="message-status-ticks">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"></polyline><polyline points="20 12 15 17"></polyline></svg>
          </span>
        </div>
      </div>
    `;

    this.messagesContainer.appendChild(row);
  }

  formatMessageText(rawText) {
    if (!rawText) return '';

    // Check for ```code blocks```
    const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
    let text = rawText;

    if (codeBlockRegex.test(rawText)) {
      text = rawText.replace(codeBlockRegex, (match, lang, code) => {
        const language = lang || 'code';
        return `
          <div class="message-code-block">
            <div class="code-block-header">
              <span>${this.escapeHtml(language)}</span>
              <button class="icon-btn-sm copy-snippet-btn" data-code="${encodeURIComponent(code)}" title="Copy Snippet">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
            <pre><code>${this.escapeHtml(code.trim())}</code></pre>
          </div>
        `;
      });
    } else {
      // Escape HTML and format inline code `code`
      text = this.escapeHtml(text);
      text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    }

    // Format @mentions
    text = text.replace(/(@[a-zA-Z0-9_\-]+)/g, '<span style="color:#25d366; font-weight:700;">$1</span>');

    return text;
  }

  renderContextCards() {
    this.contextCardsList.innerHTML = '';
    const items = Array.from(this.contextItems.values());

    const filtered = items.filter((item) => {
      if (this.activeSectionFilter === 'all') return true;
      return item.section.toLowerCase() === this.activeSectionFilter.toLowerCase();
    });

    if (filtered.length === 0) {
      this.contextCardsList.innerHTML = `
        <div class="empty-state-sm">
          No context items in section <strong>${this.activeSectionFilter}</strong>.<br>
          Click "+ Add Key" to record shared knowledge.
        </div>
      `;
      return;
    }

    for (const item of filtered) {
      const card = document.createElement('div');
      card.className = 'context-card';
      card.id = `ctx-card-${item.key}`;

      const sectionClass = `pill-${item.section.toLowerCase()}`;
      const timeStr = new Date(item.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      card.innerHTML = `
        <div class="context-card-header">
          <div class="context-card-title-group">
            <span class="context-card-key">${this.escapeHtml(item.key)}</span>
            <div class="context-card-meta">
              <span class="section-pill ${sectionClass}">${item.section}</span>
              <span class="version-tag">v${item.version}</span>
              <span>• by ${this.escapeHtml(item.updatedBy)} (${timeStr})</span>
            </div>
          </div>
        </div>
        <div class="context-card-content">${this.escapeHtml(item.content)}</div>
        <div class="context-card-actions">
          <button class="btn-text-sm ctx-edit-btn" data-key="${encodeURIComponent(item.key)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            Edit
          </button>
          <button class="btn-text-sm ctx-append-btn" data-key="${encodeURIComponent(item.key)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            Append
          </button>
          <button class="btn-text-sm ctx-copy-btn" data-content="${encodeURIComponent(item.content)}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            Copy
          </button>
        </div>
      `;

      // Bind card actions
      card.querySelector('.ctx-edit-btn').addEventListener('click', () => this.openEditContextModal(item));
      card.querySelector('.ctx-append-btn').addEventListener('click', () => this.promptAppendContext(item));
      card.querySelector('.ctx-copy-btn').addEventListener('click', (e) => {
        navigator.clipboard.writeText(item.content);
        const btn = e.currentTarget;
        btn.innerHTML = '<span>Copied!</span>';
        setTimeout(() => {
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> Copy`;
        }, 1200);
      });

      this.contextCardsList.appendChild(card);
    }
  }

  renderQuickMentions() {
    // Keep @all, append active agents
    this.quickMentionsBar.innerHTML = `
      <span class="quick-mention-label">Tag:</span>
      <button class="tag-chip tag-all" data-tag="@all">@all</button>
    `;

    for (const agent of this.agents.values()) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.dataset.tag = agent.name;
      chip.textContent = agent.name;
      this.quickMentionsBar.appendChild(chip);
    }

    this.quickMentionsBar.querySelectorAll('.tag-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        const current = this.messageInput.value;
        this.messageInput.value = current ? `${tag} ${current}` : `${tag} `;
        this.messageInput.focus();
      });
    });
  }

  updateCounters() {
    this.agentsCount.textContent = this.agents.size;
    this.contextCount.textContent = this.contextItems.size;
  }

  selectChat(chatId) {
    this.currentChat = chatId;

    // Update active highlight in sidebar
    document.querySelectorAll('.chat-item').forEach((item) => {
      if (item.dataset.chatId === chatId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });

    if (chatId === '@all') {
      this.activeChatTitle.textContent = '#pool-broadcast';
      this.activeChatTag.textContent = 'GLOBAL BROADCAST';
      this.activeChatTag.style.background = 'rgba(6, 182, 212, 0.15)';
      this.activeChatTag.style.color = '#06b6d4';
      this.activeChatSubtitle.textContent = 'All agents in pool can see and tag each other';
      this.messageInput.placeholder = "Type message... ('@all' for all agents, '@agent' for whisper)";
    } else {
      this.activeChatTitle.textContent = chatId;
      this.activeChatTag.textContent = 'DIRECT WHISPER (1:1)';
      this.activeChatTag.style.background = 'rgba(168, 85, 247, 0.2)';
      this.activeChatTag.style.color = '#c084fc';
      this.activeChatSubtitle.textContent = `Private messaging with ${chatId}`;
      this.messageInput.placeholder = `Whisper to ${chatId}...`;
    }

    this.renderMessages();
  }

  sendMessage() {
    const rawContent = this.messageInput.value.trim();
    if (!rawContent) return;

    let to = this.currentChat;
    let content = rawContent;

    // If typing in broadcast channel, check if starts with @agent
    if (to === '@all') {
      const match = rawContent.match(/^(@[a-zA-Z0-9_\-]+)\s+([\s\S]*)$/);
      if (match) {
        to = match[1];
        content = match[2];
      }
    }

    const sender = this.senderRoleSelect.value;
    const senderType = sender.replace('@', '');

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'message',
          roomCode: this.roomCode,
          to,
          content,
        })
      );
    } else {
      // Fallback to REST
      fetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          from: sender,
          to,
          content,
          agentType: senderType,
        }),
      });
    }

    this.messageInput.value = '';
    this.messageInput.style.height = 'auto';
  }

  openEditContextModal(item) {
    this.contextModalTitle.textContent = `Edit Context: ${item.key}`;
    this.ctxKeyInput.value = item.key;
    this.ctxKeyInput.disabled = true;
    this.ctxSectionSelect.value = item.section;
    this.ctxContentInput.value = item.content;
    this.contextModal.classList.remove('hidden');
    this.ctxContentInput.focus();
  }

  promptAppendContext(item) {
    const entry = prompt(`Append new line to "${item.key}":`);
    if (!entry || !entry.trim()) return;

    fetch('/api/context/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        roomCode: this.roomCode,
        key: item.key,
        section: item.section,
        entry: `[${new Date().toLocaleTimeString()} by ${this.myIdentity}]: ${entry.trim()}`,
        updatedBy: this.myIdentity,
      }),
    });
  }

  async showHistoryModal() {
    this.historyModal.classList.remove('hidden');
    this.historyListContainer.innerHTML = '<div class="empty-state-sm">Loading history audit log...</div>';

    try {
      const res = await fetch(`/api/context/history?roomCode=${encodeURIComponent(this.roomCode)}`);
      const data = await res.json();
      const history = data.history || [];

      if (history.length === 0) {
        this.historyListContainer.innerHTML = '<div class="empty-state-sm">No updates recorded yet.</div>';
        return;
      }

      this.historyListContainer.innerHTML = '';
      for (const h of history) {
        const item = document.createElement('div');
        item.className = 'history-item';
        const time = new Date(h.timestamp).toLocaleString();

        item.innerHTML = `
          <div class="history-header">
            <strong>[${h.section}] ${this.escapeHtml(h.key)}</strong>
            <span>${time} by ${this.escapeHtml(h.updatedBy)}</span>
          </div>
          <div class="history-diff-new">${this.escapeHtml(h.newContent)}</div>
        `;
        this.historyListContainer.appendChild(item);
      }
    } catch (err) {
      this.historyListContainer.innerHTML = `<div class="empty-state-sm" style="color:red">Failed to load history: ${err.message}</div>`;
    }
  }

  updateConnectionGuideSnippets() {
    const hostUrl = this.hostInfo?.tunnelUrl || this.hostInfo?.lanUrls?.[0] || window.location.origin;
    const room = this.roomCode;

    const claudeEl = document.getElementById('claudeMcpCmd');
    if (claudeEl) {
      claudeEl.textContent = `claude mcp add aexting -- npx -y aexting-mcp --host "${hostUrl}" --code "${room}" --name "claude"`;
    }

    const antigravityEl = document.getElementById('antigravityMcpJson');
    if (antigravityEl) {
      antigravityEl.textContent = JSON.stringify(
        {
          mcpServers: {
            aexting: {
              command: 'npx',
              args: ['-y', 'aexting-mcp', '--host', hostUrl, '--code', room, '--name', '@antigravity', '--type', 'antigravity'],
            },
          },
        },
        null,
        2
      );
    }

    const cliEl = document.getElementById('cliJoinCmd');
    if (cliEl) {
      cliEl.textContent = `# Interactive terminal chat\nnpx -y aexting join --url "${hostUrl}" --code "${room}" --name "@terminal_agent"\n\n# One-shot command send\nnpx -y aexting send --url "${hostUrl}" --code "${room}" --name "@agent" --to "@all" "System updated!"`;
    }

    const curlEl = document.getElementById('curlCmd');
    if (curlEl) {
      curlEl.textContent = `# Send message\ncurl -X POST ${hostUrl}/api/messages \\\n  -H "Content-Type: application/json" \\\n  -d '{"roomCode":"${room}","from":"@curl_agent","to":"@all","content":"Hello Swarm!"}'\n\n# Read shared context\ncurl ${hostUrl}/api/context?roomCode=${room}\n\n# Set shared context\ncurl -X POST ${hostUrl}/api/context \\\n  -H "Content-Type: application/json" \\\n  -d '{"roomCode":"${room}","key":"architecture","content":"Service mesh deployed","updatedBy":"@curl_agent"}'`;
    }
  }

  bindEvents() {
    // Copy Room Code
    this.copyRoomCodeBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(this.roomCode);
      this.roomCodeDisplay.style.color = '#25d366';
      setTimeout(() => (this.roomCodeDisplay.style.color = ''), 1000);
    });

    // Toggle Sound
    this.toggleSoundBtn.addEventListener('click', () => {
      this.soundEnabled = !this.soundEnabled;
      this.toggleSoundBtn.style.opacity = this.soundEnabled ? '1' : '0.4';
    });

    // Tabs in sidebar
    this.tabChannels.addEventListener('click', () => {
      this.tabChannels.classList.add('active');
      this.tabRoster.classList.remove('active');
      this.channelListSection.classList.remove('hidden');
      this.rosterSection.classList.add('hidden');
    });

    this.tabRoster.addEventListener('click', () => {
      this.tabRoster.classList.add('active');
      this.tabChannels.classList.remove('active');
      this.rosterSection.classList.remove('hidden');
      this.channelListSection.classList.add('hidden');
    });

    // Main pool channel click
    this.channelBroadcast.addEventListener('click', () => this.selectChat('@all'));

    // Composer submit
    this.composerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendMessage();
    });

    // Enter to send, Shift+Enter for newline
    this.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      }
    });

    // Filter agents input
    this.agentSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.toLowerCase();
      document.querySelectorAll('.chat-item, .roster-card').forEach((el) => {
        const text = el.textContent.toLowerCase();
        el.style.display = text.includes(q) ? '' : 'none';
      });
    });

    // Context filter buttons
    this.contextSectionFilters.querySelectorAll('.context-filter-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.contextSectionFilters.querySelectorAll('.context-filter-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.activeSectionFilter = btn.dataset.section;
        this.renderContextCards();
      });
    });

    // Modals open/close
    this.openConnectModalBtn.addEventListener('click', () => {
      this.updateConnectionGuideSnippets();
      this.connectModal.classList.remove('hidden');
    });
    this.closeConnectModalBtn.addEventListener('click', () => this.connectModal.classList.add('hidden'));

    this.openAddContextBtn.addEventListener('click', () => {
      this.contextModalTitle.textContent = 'Add Global Context Key';
      this.ctxKeyInput.value = '';
      this.ctxKeyInput.disabled = false;
      this.ctxContentInput.value = '';
      this.contextModal.classList.remove('hidden');
      this.ctxKeyInput.focus();
    });
    this.closeContextModalBtn.addEventListener('click', () => this.contextModal.classList.add('hidden'));
    this.cancelContextModalBtn.addEventListener('click', () => this.contextModal.classList.add('hidden'));

    this.toggleHistoryBtn.addEventListener('click', () => this.showHistoryModal());
    this.closeHistoryModalBtn.addEventListener('click', () => this.historyModal.classList.add('hidden'));

    // Context Form submit
    this.contextForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const key = this.ctxKeyInput.value.trim();
      const section = this.ctxSectionSelect.value;
      const content = this.ctxContentInput.value.trim();
      if (!key || !content) return;

      await fetch('/api/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.roomCode,
          key,
          section,
          content,
          updatedBy: this.myIdentity,
        }),
      });

      this.contextModal.classList.add('hidden');
    });

    // Modal tabs
    document.querySelectorAll('.modal-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.modal-tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.modal-tab-content').forEach((c) => c.classList.remove('active'));
        tab.classList.add('active');
        const contentId = tab.dataset.tab;
        const target = document.getElementById(contentId);
        if (target) target.classList.add('active');
      });
    });

    // Copy buttons inside modal
    document.querySelectorAll('.copy-code-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const targetId = btn.dataset.target;
        const text = document.getElementById(targetId)?.textContent || '';
        navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
        setTimeout(() => (btn.textContent = 'Copy'), 1200);
      });
    });

    // Code snippet copy buttons inside chat
    this.messagesContainer.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.copy-snippet-btn');
      if (copyBtn) {
        const code = decodeURIComponent(copyBtn.dataset.code || '');
        navigator.clipboard.writeText(code);
        copyBtn.style.color = '#25d366';
        setTimeout(() => (copyBtn.style.color = ''), 1000);
      }
    });

    // Clear chat view
    this.clearChatViewBtn.addEventListener('click', () => {
      this.messages = [];
      this.renderMessages();
    });
  }

  scrollToBottom() {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  getAgentEmoji(type) {
    switch (type) {
      case 'claude': return '🟣';
      case 'antigravity': return '🔵';
      case 'opencode': return '🟢';
      case 'aider': return '⚡';
      case 'human': return '👤';
      default: return '🤖';
    }
  }

  escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

// Start client on DOM load
window.addEventListener('DOMContentLoaded', () => {
  window.nexus = new NexusClient();
});
