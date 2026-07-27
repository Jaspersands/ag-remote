document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const openSidebarBtn = document.getElementById('open-sidebar');
    const closeSidebarBtn = document.getElementById('close-sidebar');
    const newChatBtn = document.getElementById('new-chat-btn');
    const projectList = document.getElementById('project-list');
    const convoList = document.getElementById('convo-list');
    
    const activeProjectTitle = document.getElementById('active-project-title');
    const activeConvoTitle = document.getElementById('active-convo-title');
    
    const connectionStatus = document.getElementById('connection-status');
    const statusText = document.getElementById('status-text');
    
    const messagesPane = document.getElementById('messages-pane');
    const messagesList = document.getElementById('messages-list');
    
    const toolBar = document.getElementById('tool-bar');
    const toolDetailsText = document.getElementById('tool-details-text');
    const toolActionsContainer = document.getElementById('tool-actions-container');
    
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const attachFileBtn = document.getElementById('attach-file-btn');
    const fileInput = document.getElementById('file-input');
    const attachmentsPreview = document.getElementById('attachments-preview');

    let pendingFiles = [];

    let socket = null;
    let currentConvoId = null;
    let isLoggingOut = false;
    let globalGoogleClientId = '';
    let currentUserEmail = '';
    let sessionStartTime = null;    // when the user logged in
    let firstMessageTime = null;    // when the first message was sent this session

    // Per-user localStorage helpers
    function userKey(key) {
        return currentUserEmail ? `user:${currentUserEmail}:${key}` : key;
    }

    // Keep track of collapsed project names (per-user)
    const collapsedProjects = new Set();
    function saveCollapsedProjects() {
        localStorage.setItem(userKey('collapsedProjects'), JSON.stringify(Array.from(collapsedProjects)));
    }
    function loadCollapsedProjects() {
        collapsedProjects.clear();
        const saved = JSON.parse(localStorage.getItem(userKey('collapsedProjects')) || '[]');
        saved.forEach(p => collapsedProjects.add(p));
    }

    // Keep track of locally expanded files changed headers
    const localExpandedFiles = new Set();

    // Sidebar drawer controls for mobile
    function openSidebar() {
        sidebar.classList.remove('closed');
        sidebarOverlay.classList.remove('hidden');
    }

    function closeSidebar() {
        sidebar.classList.add('closed');
        sidebarOverlay.classList.add('hidden');
    }

    openSidebarBtn.addEventListener('click', openSidebar);
    closeSidebarBtn.addEventListener('click', closeSidebar);
    sidebarOverlay.addEventListener('click', closeSidebar);

    // Initialize Models
    async function fetchModels() {
        try {
            const resp = await fetch('/api/models');
            const data = await resp.json();
            if (data.models) {
                if (data.current) currentModelName.innerText = data.current.name;
                modelList.innerHTML = '';
                data.models.forEach(model => {
                    const li = document.createElement('li');
                    li.innerText = model.name;
                    li.addEventListener('click', () => {
                        currentModelName.innerText = model.name;
                        fetch('/api/models/switch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('ag_token') || ''}` }, body: JSON.stringify({ model: model.id }) });
                        modelDropdown.classList.add('hidden');
                    });
                    modelList.appendChild(li);
                });
            }
        } catch (e) {
            console.error('Failed to fetch models', e);
        }
    }

    modelSelectorBtn.addEventListener('click', () => {
        modelDropdown.classList.toggle('hidden');
    });

    // Connect to WebSocket Server
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const token = localStorage.getItem('ag_token') || '';
        const wsUrl = `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`;
        
        console.log(`[Connecting to AG-Remote WebSocket: ${wsUrl}]`);
        if (socket) {
            try { 
                socket.onclose = null;
                socket.close(); 
            } catch (e) {}
        }
        socket = new WebSocket(wsUrl);
        
        socket.onopen = () => {
            console.log('[WebSocket connection established]');
        };
        
        socket.onclose = () => {
            if (isLoggingOut) return;
            console.log('[WebSocket connection closed. Reconnecting in 3 seconds...]');
            updateConnectionUI(false, false);
            setTimeout(connectWebSocket, 3000);
        };
        
        socket.onerror = (err) => {
            console.error('[WebSocket error]:', err);
        };
        
        socket.onmessage = (event) => {
            try {
                const state = JSON.parse(event.data);
                updateAppUI(state);
            } catch (e) {
                console.error('[Error parsing state update]:', e);
            }
        };
    }

    // Update the Connection status badge
    function updateConnectionUI(serverConnected, appConnected) {
        if (serverConnected && appConnected) {
            connectionStatus.className = 'status-badge connected';
            statusText.innerText = 'Computer Paired';
            chatInput.disabled = false;
            sendBtn.disabled = false;
            chatInput.placeholder = 'Ask anything...';
        } else {
            connectionStatus.className = 'status-badge disconnected';
            statusText.innerText = serverConnected ? 'Computer Offline' : 'Disconnected';
            chatInput.disabled = true;
            sendBtn.disabled = true;
            chatInput.placeholder = serverConnected ? 'Run python3 agent.py on your computer to pair...' : 'Connecting to relay server...';
        }
    }

    // Update entire UI based on state
    function updateAppUI(state) {
        // 1. Connection status
        const appConnected = state.connected;
        updateConnectionUI(true, appConnected);
        
        if (!appConnected) return;

        // 2. Active titles
        // Parse active convo ID from URL
        const url = state.url || '';
        const idMatch = url.match(/\/c\/([a-zA-Z0-9\-]+)/);
        currentConvoId = idMatch ? idMatch[1] : null;
        
        // Find active project and conversation
        let activeProjectName = null;
        let activeConvo = state.conversations ? state.conversations.find(c => c.id === currentConvoId) : null;
        
        if (state.projects) {
            for (const proj of state.projects) {
                if (proj.conversations && proj.conversations.some(c => c.id === currentConvoId)) {
                    activeProjectName = proj.name;
                    if (!activeConvo) {
                        activeConvo = proj.conversations.find(c => c.id === currentConvoId);
                    }
                    break;
                }
            }
        }

        let projectDisplayName = 'Antigravity Workspace';
        let convoDisplayName = '';

        if (activeProjectName) {
            projectDisplayName = getProjectSettings(activeProjectName).alias || activeProjectName;
        }

        if (activeConvo) {
            convoDisplayName = activeConvo.name;
        } else if (state.title && state.title !== 'Antigravity Workspace' && state.title !== 'Antigravity') {
            convoDisplayName = state.title;
        }

        if (activeProjectName) {
            activeProjectTitle.innerText = projectDisplayName;
            if (convoDisplayName && convoDisplayName !== projectDisplayName) {
                activeConvoTitle.innerText = convoDisplayName;
                activeConvoTitle.style.display = 'block';
            } else {
                activeConvoTitle.innerText = '';
                activeConvoTitle.style.display = 'none';
            }
        } else {
            // General conversation or no project active
            activeProjectTitle.innerText = convoDisplayName || 'Antigravity Workspace';
            activeConvoTitle.innerText = '';
            activeConvoTitle.style.display = 'none';
        }

        lastState = state;

        // 3. Render Projects and Nested Conversations
        projectList.innerHTML = '';
        state.projects.forEach(proj => {
            const projectName = proj.name;
            const treeItem = document.createElement('li');
            treeItem.className = 'project-tree-item';
            if (collapsedProjects.has(projectName)) {
                treeItem.classList.add('collapsed');
            }
            
            // Project header container
            const headerDiv = document.createElement('div');
            headerDiv.className = 'project-header';
            
            // Check if this project or any of its conversations is active
            const hasActiveConvo = proj.conversations && proj.conversations.some(c => c.id === currentConvoId);
            if (hasActiveConvo) {
                headerDiv.classList.add('active');
            }
            
            // Toggle chevron button
            const toggleBtn = document.createElement('button');
            toggleBtn.className = 'project-toggle-btn';
            toggleBtn.setAttribute('aria-label', 'Toggle conversations');
            toggleBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none" class="chevron-icon">
                    <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
            `;
            
            const toggleCollapse = (e) => {
                if (e) e.stopPropagation();
                const isCollapsed = treeItem.classList.toggle('collapsed');
                if (isCollapsed) {
                    collapsedProjects.add(projectName);
                } else {
                    collapsedProjects.delete(projectName);
                }
                saveCollapsedProjects();
            };
            
            toggleBtn.addEventListener('click', toggleCollapse);
            headerDiv.appendChild(toggleBtn);
            
            // Project name span
            const nameSpan = document.createElement('span');
            nameSpan.className = 'project-name';
            const projSettings = getProjectSettings(projectName);
            nameSpan.innerText = projSettings.alias || projectName;
            headerDiv.appendChild(nameSpan);

            // Project settings gear button
            const settingsBtn = document.createElement('button');
            settingsBtn.className = 'project-settings-btn';
            settingsBtn.setAttribute('title', 'Project Settings');
            settingsBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none">
                    <circle cx="12" cy="12" r="3"></circle>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
            `;
            settingsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openProjectSettingsModal(projectName, proj);
            });
            headerDiv.appendChild(settingsBtn);
            
            headerDiv.addEventListener('click', () => {
                toggleCollapse();
                sendAction('select_project', { name: projectName });
            });
            treeItem.appendChild(headerDiv);
            
            // Nested conversation list
            const nestedUl = document.createElement('ul');
            nestedUl.className = 'project-convo-list';
            
            if (proj.conversations && proj.conversations.length > 0) {
                proj.conversations.forEach(convo => {
                    const convoLi = document.createElement('li');
                    if (convo.id === currentConvoId) {
                        convoLi.className = 'active';
                    }
                    
                    const cNameSpan = document.createElement('span');
                    cNameSpan.innerText = convo.name;
                    convoLi.appendChild(cNameSpan);

                    if (convo.id === currentConvoId && state.is_generating) {
                        const spinner = document.createElement('div');
                        spinner.className = 'generating-spinner';
                        spinner.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" class="spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>';
                        convoLi.appendChild(spinner);
                    }
                    
                    if (convo.time) {
                        const cTimeSpan = document.createElement('span');
                        cTimeSpan.className = 'time';
                        cTimeSpan.innerText = convo.time;
                        convoLi.appendChild(cTimeSpan);
                    }
                    
                    convoLi.addEventListener('click', (e) => {
                        e.stopPropagation();
                        sendAction('select_conversation', { id: convo.id });
                        closeSidebar();
                    });
                    nestedUl.appendChild(convoLi);
                });
            } else {
                const emptyLi = document.createElement('li');
                emptyLi.style.fontStyle = 'italic';
                emptyLi.style.opacity = '0.5';
                emptyLi.style.cursor = 'default';
                emptyLi.innerText = 'No conversations';
                nestedUl.appendChild(emptyLi);
            }
            
            treeItem.appendChild(nestedUl);
            projectList.appendChild(treeItem);
        });

        // 4. Render General Conversations (unassigned to any project)
        const generalConvoSection = document.getElementById('general-convo-section');
        convoList.innerHTML = '';
        
        if (state.conversations && state.conversations.length > 0) {
            generalConvoSection.classList.remove('hidden');
            state.conversations.forEach(convo => {
                const li = document.createElement('li');
                if (convo.id === currentConvoId) {
                    li.className = 'active';
                }
                
                const nameSpan = document.createElement('span');
                nameSpan.innerText = convo.name;
                li.appendChild(nameSpan);

                if (convo.id === currentConvoId && state.is_generating) {
                    const spinner = document.createElement('div');
                    spinner.className = 'generating-spinner';
                    spinner.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2" fill="none" class="spin"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"></path></svg>';
                    li.appendChild(spinner);
                }
                
                if (convo.time) {
                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'time';
                    timeSpan.innerText = convo.time;
                    li.appendChild(timeSpan);
                }
                
                li.addEventListener('click', () => {
                    sendAction('select_conversation', { id: convo.id });
                    closeSidebar();
                });
                convoList.appendChild(li);
            });
        } else {
            generalConvoSection.classList.add('hidden');
        }

        // 5. Render Messages
        const messageContainer = document.getElementById('messages-list');
        const messagesPane = document.getElementById('messages-pane');
        const isAtBottom = messagesPane && (messagesPane.scrollHeight - messagesPane.scrollTop - messagesPane.clientHeight) < 100;
        if (state.messages.length === 0) {
            messageContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🪐</div>
                    <h2>AG-Remote</h2>
                    <p>Start typing below or select a conversation from the sidebar to control Antigravity.</p>
                </div>
            `;
        } else {
            const emptyState = messageContainer.querySelector('.empty-state');
            if (emptyState) emptyState.remove();

            const queuedNodes = messageContainer.querySelectorAll('.queued-message');
            queuedNodes.forEach(n => n.remove());

            const currentNodes = messageContainer.children;
            if (currentNodes.length > state.messages.length) {
                messageContainer.innerHTML = '';
            }

            state.messages.forEach((msg, index) => {
                let msgDiv = messageContainer.children[index];
                let isNew = false;
                
                if (!msgDiv) {
                    msgDiv = document.createElement('div');
                    messageContainer.appendChild(msgDiv);
                    isNew = true;
                }
                
                const msgStateStr = JSON.stringify(msg);
                if (!isNew && msgDiv.getAttribute('data-state') === msgStateStr) {
                    return; 
                }
                
                msgDiv.setAttribute('data-state', msgStateStr);
                msgDiv.className = `message ${msg.sender}`;
                msgDiv.innerHTML = '';
                
                const contentDiv = document.createElement('div');
                contentDiv.className = 'message-content';
                
                // Renders thought block if present
                // Renders thought block if present
                if (msg.hasThoughts) {
                    const thoughtBlock = document.createElement('div');
                    thoughtBlock.className = 'thought-block';
                    
                    const thoughtSummary = document.createElement('div');
                    thoughtSummary.className = 'thought-summary';
                    
                    const thoughtsText = msg.thoughts || '';
                    if (thoughtsText) {
                        thoughtSummary.innerText = thoughtsText.split('\n')[0].replace(/\*\*/g, '').trim() || 'Thinking Process';
                    } else {
                        thoughtSummary.innerText = 'Thinking Process';
                    }
                    
                    thoughtSummary.addEventListener('click', () => {
                        thoughtBlock.classList.toggle('open');
                    });
                    
                    const thoughtDetails = document.createElement('div');
                    thoughtDetails.className = 'thought-details';
                    thoughtDetails.innerText = thoughtsText || 'Loading thinking log...';
                    
                    thoughtBlock.appendChild(thoughtSummary);
                    thoughtBlock.appendChild(thoughtDetails);
                    contentDiv.appendChild(thoughtBlock);
                }
                
                // Renders main text message (using innerHTML to allow rich links and badges)
                const textSpan = document.createElement('span');
                textSpan.innerHTML = msg.text || '';
                
                // Add click listeners to any context scope mentions to open them
                textSpan.querySelectorAll('.context-scope-mention button').forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const filename = btn.innerText.trim();
                        loadFileContent('/api/file', { name: filename });
                        sendAction('click_scope_mention', { articleIndex: msg.articleIndex, filename: filename });
                    });
                });
                contentDiv.appendChild(textSpan);
                
                // Renders files changed block if present
                if (msg.hasFiles) {
                    const fcDiv = document.createElement('div');
                    fcDiv.className = 'files-changed-container';
                    
                    const fcHeader = document.createElement('div');
                    fcHeader.className = 'fc-header';
                    
                    const isLocalExpanded = localExpandedFiles.has(msg.articleIndex);
                    if (isLocalExpanded) {
                        fcHeader.classList.add('expanded');
                    }
                    
                    const summaryText = msg.filesChanged ? msg.filesChanged.summary : 'Loading files changed...';
                    const additionsText = msg.filesChanged ? msg.filesChanged.additions : '';
                    const deletionsText = msg.filesChanged ? msg.filesChanged.deletions : '';
                    
                    fcHeader.innerHTML = `
                        <div class="fc-summary-info">
                            <span class="fc-summary-text">${summaryText}</span>
                            <div class="fc-stats">
                                <span class="text-green">${additionsText}</span>
                                <span class="text-red">${deletionsText}</span>
                            </div>
                            <svg class="chevron-icon" viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2.5" fill="none">
                                <polyline points="6 9 12 15 18 9"></polyline>
                            </svg>
                        </div>
                        <button class="review-btn btn-sm">Review</button>
                    `;
                    
                    fcDiv.appendChild(fcHeader);
                    
                    // Create files list container
                    const fcList = document.createElement('div');
                    fcList.className = 'fc-files-list';
                    if (!isLocalExpanded) {
                        fcList.style.display = 'none';
                    }
                    
                    if (msg.filesChanged && msg.filesChanged.files && msg.filesChanged.files.length > 0) {
                        msg.filesChanged.files.forEach(file => {
                            const fileRow = document.createElement('div');
                            fileRow.className = 'fc-file-row';
                            
                            // Map icon paths correctly to our proxy
                            let iconSrc = file.icon || '/symbols-icons/icons/files/python.svg';
                            fileRow.innerHTML = `
                                <div class="fc-file-info">
                                    <img class="fc-file-icon" src="${iconSrc}" width="16" height="16">
                                    <span class="fc-file-name">${file.name}</span>
                                    <span class="fc-file-path">${file.path}</span>
                                </div>
                                <div class="fc-file-stats text-xs">
                                    <span class="text-green">${file.additions}</span>
                                    <span class="text-red">${file.deletions}</span>
                                </div>
                            `;
                            
                            fileRow.addEventListener('click', () => {
                                loadFileContent('/api/file', { path: file.path + '/' + file.name });
                                sendAction('click_file_row', { name: file.name, path: file.path });
                            });
                            fcList.appendChild(fileRow);
                        });
                    } else {
                        const emptyRow = document.createElement('div');
                        emptyRow.className = 'p-2 text-xs text-muted text-center';
                        emptyRow.style.opacity = '0.5';
                        emptyRow.innerText = 'Loading files list...';
                        fcList.appendChild(emptyRow);
                    }
                    fcDiv.appendChild(fcList);
                    
                    fcHeader.addEventListener('click', (e) => {
                        if (e.target.closest('.review-btn')) return;
                        
                        // Toggle local state (instant, no server delay/reload!)
                        if (localExpandedFiles.has(msg.articleIndex)) {
                            localExpandedFiles.delete(msg.articleIndex);
                            fcHeader.classList.remove('expanded');
                            fcList.style.display = 'none';
                        } else {
                            localExpandedFiles.add(msg.articleIndex);
                            fcHeader.classList.add('expanded');
                            fcList.style.display = 'flex';
                        }
                    });
                    
                    fcHeader.querySelector('.review-btn').addEventListener('click', () => {
                        sendAction('click_review_button', { articleIndex: msg.articleIndex });
                    });
                    
                    contentDiv.appendChild(fcDiv);
                }
                
                // Renders artifact if present (making it clickable to open the walkthrough!)
                if (msg.artifact) {
                    const artDiv = document.createElement('div');
                    artDiv.className = 'artifact-badge';
                    artDiv.style.cursor = 'pointer';
                    artDiv.innerHTML = `<strong>📄 Artifact: ${msg.artifact.title}</strong><span>${msg.artifact.summary}</span>`;
                    artDiv.addEventListener('click', () => {
                        loadFileContent('/api/walkthrough');
                        sendAction('click_artifact', { articleIndex: msg.articleIndex });
                    });
                    contentDiv.appendChild(artDiv);
                }
                
                msgDiv.appendChild(contentDiv);
            });
            
            // Render Queued Messages
            if (state.queued_messages && state.queued_messages.length > 0) {
                state.queued_messages.forEach(qText => {
                    const qDiv = document.createElement('div');
                    qDiv.className = 'message user queued-message';
                    qDiv.style.opacity = '0.6';
                    
                    const qContent = document.createElement('div');
                    qContent.className = 'message-content text-muted';
                    qContent.innerHTML = `<span style="font-style: italic;">Queued: ${qText}</span>`;
                    qDiv.appendChild(qContent);
                    
                    messageContainer.appendChild(qDiv);
                });
            }
            
            // Auto scroll messages to bottom only if user was already at bottom
            if (isAtBottom && messagesPane) {
                messagesPane.scrollTop = messagesPane.scrollHeight;
            }
        }

        // 6. Tool Pending Bar
        if (state.pending_tool) {
            toolDetailsText.innerText = state.pending_tool.text;
            
            // Clear and render dynamic buttons
            if (toolActionsContainer) {
                toolActionsContainer.innerHTML = '';
                if (state.pending_tool.buttons && Array.isArray(state.pending_tool.buttons)) {
                    state.pending_tool.buttons.forEach(btnText => {
                        const btn = document.createElement('button');
                        btn.innerText = btnText;
                        
                        // Style based on text
                        if (btnText.match(/cancel|reject|deny/i)) {
                            btn.className = 'btn btn-danger';
                        } else if (btnText.match(/allow|proceed|approve|always/i)) {
                            btn.className = 'btn btn-success';
                        } else {
                            btn.className = 'btn btn-outline';
                        }
                        
                        btn.addEventListener('click', () => {
                            hapticTap();
                            sendAction('click_tool_button', {
                                articleIndex: state.pending_tool.articleIndex,
                                buttonText: btnText
                            });
                            toolBar.classList.add('hidden');
                        });
                        
                        toolActionsContainer.appendChild(btn);
                    });
                }
            }
            
            toolBar.classList.remove('hidden');
        } else {
            toolBar.classList.add('hidden');
        }
    }

    // Helper to send actions via WebSocket
    function sendAction(action, payload = {}) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            console.error('WebSocket not connected');
            return;
        }
        const msg = JSON.stringify({ action, ...payload });
        socket.send(msg);
    }

    // Helper for haptics
    function hapticTap() {
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    }

    // Textarea auto-resize
    chatInput.addEventListener('input', () => {
        chatInput.style.height = '24px';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 150) + 'px';
    });

    // File Attachment Logic
    function renderAttachmentsPreview() {
        if (pendingFiles.length === 0) {
            attachmentsPreview.classList.add('hidden');
            attachmentsPreview.innerHTML = '';
            return;
        }
        
        attachmentsPreview.classList.remove('hidden');
        attachmentsPreview.innerHTML = '';
        
        pendingFiles.forEach((file, index) => {
            const thumb = document.createElement('div');
            thumb.className = 'attachment-thumbnail';
            
            if (file.type.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = file.base64;
                thumb.appendChild(img);
            } else {
                const icon = document.createElement('div');
                icon.className = 'file-icon';
                icon.innerText = '📄';
                thumb.appendChild(icon);
            }
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'attachment-remove';
            removeBtn.innerHTML = '×';
            removeBtn.title = file.name;
            removeBtn.addEventListener('click', () => {
                pendingFiles.splice(index, 1);
                renderAttachmentsPreview();
            });
            
            thumb.appendChild(removeBtn);
            attachmentsPreview.appendChild(thumb);
        });
    }

    async function processFiles(files) {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const reader = new FileReader();
            reader.onload = (e) => {
                pendingFiles.push({
                    name: file.name,
                    type: file.type,
                    base64: e.target.result
                });
                renderAttachmentsPreview();
            };
            reader.readAsDataURL(file);
        }
    }

    attachFileBtn.addEventListener('click', () => {
        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
            processFiles(e.target.files);
        }
        fileInput.value = '';
    });

    chatInput.addEventListener('paste', (e) => {
        if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length > 0) {
            e.preventDefault();
            processFiles(e.clipboardData.files);
        }
    });
    
    // Handle Drag and Drop
    const inputArea = document.getElementById('input-area');
    inputArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        inputArea.style.opacity = '0.7';
    });
    inputArea.addEventListener('dragleave', () => {
        inputArea.style.opacity = '1';
    });
    inputArea.addEventListener('drop', (e) => {
        e.preventDefault();
        inputArea.style.opacity = '1';
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            processFiles(e.dataTransfer.files);
        }
    });

    // Handle Enter to submit (Shift+Enter for newline)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            chatForm.dispatchEvent(new Event('submit'));
        }
    });

    // Form submission
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text && pendingFiles.length === 0) return;
        
        // Track the first message time for 5-hour window calculation
        if (!firstMessageTime) {
            firstMessageTime = new Date();
        }
        
        hapticTap();
        sendAction('send_message', { text, files: pendingFiles });
        
        chatInput.value = '';
        chatInput.style.height = '24px';
        pendingFiles = [];
        renderAttachmentsPreview();
    });

    // Stop action
    stopBtn.addEventListener('click', () => {
        hapticTap();
        sendAction('stop_generation');
    });

    // New chat action
    newChatBtn.addEventListener('click', () => {
        hapticTap();
        sendAction('new_conversation');
        closeSidebar();
    });

    // File Viewer Modal Actions
    const fileViewerModal = document.getElementById('file-viewer-modal');
    const fileViewerTitle = document.getElementById('file-viewer-title');
    const fileViewerContent = document.getElementById('file-viewer-content');
    const closeFileViewerBtn = document.getElementById('close-file-viewer');

    function compileMarkdown(markdown) {
        if (!markdown) return '';
        
        let html = markdown;
        
        // Escape HTML special characters first
        html = html
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
            
        // Bold: **text**
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        
        // Italic: *text*
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        
        // Code inline: `code`
        html = html.replace(/`(.*?)`/g, '<code class="inline-code">$1</code>');
        
        // Code blocks: ```language ... ```
        html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="block-code">$2</code></pre>');
        
        // Headers: #, ##, ###, ####
        html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
        html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
        html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
        html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
        
        // Lists: * item or - item or 1. item
        html = html.replace(/^\s*[\*\-]\s+(.*?)$/gm, '<li>$1</li>');
        html = html.replace(/^\s*\d+\.\s+(.*?)$/gm, '<li>$1</li>');
        
        // Wrap consecutive <li> elements in <ul>
        html = html.replace(/(<li>.*?<\/li>)/gs, '<ul>$1</ul>');
        html = html.replace(/<\/ul>\s*<ul>/g, '');
        
        // Blockquotes: > text
        html = html.replace(/^\>\s+(.*?)$/gm, '<blockquote>$1</blockquote>');
        
        // Links: [text](url)
        html = html.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2" target="_blank" class="md-link">$1</a>');
        
        // Line breaks
        html = html.replace(/\n/g, '<br>');
        
        return html;
    }

    function showFileContent(title, content, isHtml = false) {
        fileViewerTitle.innerText = title;
        if (isHtml) {
            fileViewerContent.classList.remove('plain-text-code');
            fileViewerContent.innerHTML = content;
        } else {
            fileViewerContent.classList.add('plain-text-code');
            fileViewerContent.innerText = content;
        }
        fileViewerModal.classList.remove('hidden');
    }

    function closeFileViewer() {
        fileViewerModal.classList.add('hidden');
    }

    if (closeFileViewerBtn) {
        closeFileViewerBtn.addEventListener('click', closeFileViewer);
    }
    
    // Close modal when clicking backdrop
    if (fileViewerModal) {
        const modalBackdrop = fileViewerModal.querySelector('.modal-backdrop');
        if (modalBackdrop) {
            modalBackdrop.addEventListener('click', closeFileViewer);
        }
    }

    async function loadFileContent(endpoint, params = {}) {
        showFileContent('Loading...', 'Fetching file contents...', false);
        try {
            const urlParams = new URLSearchParams(params).toString();
            const token = localStorage.getItem('ag_token') || '';
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const resp = await fetch(`${endpoint}${urlParams ? '?' + urlParams : ''}`, { headers });
            if (!resp.ok) {
                const data = await resp.json();
                throw new Error(data.detail || 'Failed to load file');
            }
            const data = await resp.json();
            const name = data.name || 'File Content';
            const content = data.content || '';
            
            if (name.endsWith('.md')) {
                const compiled = compileMarkdown(content);
                showFileContent(name, compiled, true);
            } else {
                showFileContent(name, content, false);
            }
        } catch (err) {
            showFileContent('Error loading file', err.message, false);
        }
    }

    function clearAppUI() {
        if (messagesList) {
            messagesList.innerHTML = '';
        }
        if (projectList) {
            projectList.innerHTML = '';
        }
        if (convoList) {
            convoList.innerHTML = '';
        }
        const fileDrawer = document.getElementById('file-drawer');
        if (fileDrawer) {
            fileDrawer.classList.add('hidden');
        }
        const drawerContent = document.getElementById('drawer-content');
        if (drawerContent) {
            drawerContent.innerHTML = '';
        }
        const convoTitle = document.getElementById('convo-title');
        if (convoTitle) {
            convoTitle.innerText = 'Antigravity Remote';
        }
        if (chatInput) {
            chatInput.value = '';
        }
        updateConnectionUI(false, false);
        currentConvoId = null;
        expandedFilesState = {};
        thinkingExpandedState = {};
    }

    // Auth DOM Elements
    const authLockScreen = document.getElementById('auth-lock-screen');
    const passcodeForm = document.getElementById('passcode-form');
    const passcodeInput = document.getElementById('passcode-input');
    const authErrorMsg = document.getElementById('auth-error-msg');
    const userProfileBadge = document.getElementById('user-profile-badge');
    const userAvatar = document.getElementById('user-avatar');
    const userEmailText = document.getElementById('user-email-text');
    const logoutBtn = document.getElementById('logout-btn');

    let currentUser = null;

    function showAuthError(msg) {
        if (authErrorMsg) {
            authErrorMsg.innerText = msg;
            authErrorMsg.classList.remove('hidden');
        }
    }

    function hideAuthError() {
        if (authErrorMsg) {
            authErrorMsg.classList.add('hidden');
        }
    }

    function renderUserProfile(user) {
        const previousEmail = currentUserEmail;
        currentUser = user;
        if (user) {
            const newEmail = user.email || '';
            // If a different user logged in, clear old user's data from DOM and localStorage
            if (previousEmail && previousEmail !== newEmail) {
                clearAppUI();
                collapsedProjects.clear();
            }
            currentUserEmail = newEmail;
            sessionStartTime = new Date(); // record login time
            firstMessageTime = null;       // reset per-session message tracking
            loadCollapsedProjects(); // load this user's collapsed state

            // Apply this user's saved theme
            const userTheme = localStorage.getItem(userKey('ag_theme')) || 'dark';
            document.documentElement.setAttribute('data-theme', userTheme);
            if (themeSelect) themeSelect.value = userTheme;

            userEmailText.innerText = user.email || 'User';
            if (user.picture) {
                userAvatar.src = user.picture;
                userAvatar.style.display = 'block';
            } else {
                userAvatar.style.display = 'none';
            }
            userProfileBadge.classList.remove('hidden');
            authLockScreen.classList.add('hidden');
            authLockScreen.style.display = 'none';
        } else {
            currentUserEmail = '';
            collapsedProjects.clear();
            userProfileBadge.classList.add('hidden');
            authLockScreen.classList.remove('hidden');
            authLockScreen.style.display = 'flex';
        }
    }

    async function checkAuthStatus() {
        try {
            const token = localStorage.getItem('ag_token') || '';
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const resp = await fetch('/api/auth/status', { 
                headers,
                cache: 'no-store'
            });
            const data = await resp.json();
            if (data.authenticated && data.user) {
                renderUserProfile(data.user);
                connectWebSocket();
                fetchModels();
            } else {
                if (data.google_client_id) {
                    globalGoogleClientId = data.google_client_id;
                }
                localStorage.removeItem('ag_token');
                clearAppUI();
                renderUserProfile(null);
            }
        } catch (err) {
            console.error('Auth check error:', err);
            clearAppUI();
            renderUserProfile(null);
        }
    }

    const googleLoginBtn = document.getElementById('google-login-btn');
    if (googleLoginBtn) {
        googleLoginBtn.addEventListener('click', () => {
            hideAuthError();
            const clientId = globalGoogleClientId || '367177401520-4jg61r571kgefpidfn19nff02qo8ik50.apps.googleusercontent.com';
            const redirectUri = window.location.origin + '/api/auth/google/callback';
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid%20email%20profile&access_type=offline&prompt=select_account`;
            
            window.location.href = authUrl;
        });
    }

    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'GOOGLE_AUTH_SUCCESS') {
            hideAuthError();
            if (event.data.token) {
                localStorage.setItem('ag_token', event.data.token);
            }
            renderUserProfile(event.data.user);
            connectWebSocket();
        } else if (event.data && event.data.type === 'GOOGLE_AUTH_ERROR') {
            showAuthError(event.data.error || 'Google Login failed');
        }
    });

    async function handleGoogleCredentialResponse(response) {
        hideAuthError();
        try {
            const resp = await fetch('/api/auth/google', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ credential: response.credential })
            });
            let data = null;
            try {
                data = await resp.json();
            } catch (e) {
                const text = await resp.text().catch(() => '');
                throw new Error(text || `Authentication error (${resp.status})`);
            }
            if (!resp.ok || !data || !data.success) {
                throw new Error((data && data.detail) || 'Google Authentication failed');
            }
            if (data.token) {
                localStorage.setItem('ag_token', data.token);
            }
            renderUserProfile(data.user);
            connectWebSocket();
        } catch (err) {
            showAuthError(err.message);
        }
    }

    if (passcodeForm) {
        passcodeForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            hideAuthError();
            const passcode = passcodeInput.value.trim();
            if (!passcode) return;

            try {
                const resp = await fetch('/api/auth/passcode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ passcode })
                });
                let data = null;
                try {
                    data = await resp.json();
                } catch (e) {
                    const text = await resp.text().catch(() => '');
                    throw new Error(text || `Authentication error (${resp.status})`);
                }
                if (!resp.ok || !data || !data.success) {
                    throw new Error((data && data.detail) || 'Invalid passcode');
                }
                if (data.token) {
                    localStorage.setItem('ag_token', data.token);
                }
                passcodeInput.value = '';
                renderUserProfile(data.user);
                connectWebSocket();
                fetchModels();
            } catch (err) {
                showAuthError(err.message);
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            isLoggingOut = true;
            const token = localStorage.getItem('ag_token') || '';
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }

            if (socket) {
                try {
                    socket.onclose = null;
                    socket.close();
                } catch (e) {}
                socket = null;
            }
            
            updateConnectionUI(false, false);
            localStorage.removeItem('ag_token');
            sessionStorage.clear();
            document.cookie = "ag_session=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;";

            try {
                await fetch('/api/auth/logout', { method: 'POST', headers });
            } catch (err) {}
            
            clearAppUI();
            // Close any open modals before showing login screen
            document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
            if (globalSettingsModal) globalSettingsModal.classList.add('hidden');
            renderUserProfile(null);
            isLoggingOut = false;
        });
    }

    // Global & Project Settings Modals Setup
    let lastState = null;

    function getProjectSettings(name) {
        try {
            return JSON.parse(localStorage.getItem(userKey('proj_settings_' + name)) || '{}');
        } catch(e) {
            return {};
        }
    }

    function saveProjectSettings(name, settings) {
        localStorage.setItem(userKey('proj_settings_' + name), JSON.stringify(settings));
    }

    const globalSettingsModal = document.getElementById('global-settings-modal');
    const closeGlobalSettingsBtn = document.getElementById('close-global-settings');
    const modalLogoutBtn = document.getElementById('modal-logout-btn');
    const themeSelect = document.getElementById('theme-select');

    const projectSettingsModal = document.getElementById('project-settings-modal');
    const closeProjectSettingsBtn = document.getElementById('close-project-settings');
    const projectSettingsForm = document.getElementById('project-settings-form');
    const projectAliasInput = document.getElementById('project-alias-input');
    const projectNotesInput = document.getElementById('project-notes-input');
    const projectModeSelect = document.getElementById('project-mode-select');
    const projectInfoName = document.getElementById('project-info-name');
    const projectInfoCount = document.getElementById('project-info-count');
    let currentEditingProject = null;

    // Theme setup - default to dark until we know who's logged in
    document.documentElement.setAttribute('data-theme', 'dark');
    if (themeSelect) themeSelect.value = 'dark';

    if (themeSelect) {
        themeSelect.addEventListener('change', (e) => {
            const theme = e.target.value;
            localStorage.setItem(userKey('ag_theme'), theme);
            document.documentElement.setAttribute('data-theme', theme);
        });
    }

    // Global Settings Listeners & Usage Metrics Computation
    async function openGlobalSettingsModal() {
        if (!globalSettingsModal) return;

        // Immediately update usage text to show loading...
        document.getElementById('usage-weekly-tokens').innerText = "Loading from server...";
        document.getElementById('usage-5hr-tokens').innerText = "Loading from server...";

        // Count projects and conversations from live state
        let projCount = 0;
        let convoCount = 0;
        if (lastState) {
            if (lastState.projects) projCount = lastState.projects.length;
            if (lastState.conversations) convoCount += lastState.conversations.length;
            if (lastState.projects) {
                lastState.projects.forEach(p => {
                    if (p.conversations) convoCount += p.conversations.length;
                });
            }
        }
        const messageCount = messagesList ? messagesList.children.length : 0;
        
        // Fetch actual quota from backend
        try {
            const resp = await fetch('/api/quota');
            const data = await resp.json();
            
            const weeklyEl = document.getElementById('usage-weekly-tokens');
            const fiveHourEl = document.getElementById('usage-5hr-tokens');
            
            if (data.error) {
                weeklyEl.innerText = "Error loading quota";
                fiveHourEl.innerText = "Error loading quota";
            } else if (data.claude_gpt && data.claude_gpt.weekly_refresh) {
                // Determine which group to show based on current model name
                let group = data.claude_gpt;
                if (currentModelName.innerText.includes('Gemini')) {
                    group = data.gemini;
                }
                
                weeklyEl.innerHTML = `${group.weekly_pct || '0%'} used <br><span style="font-size: 0.85em; opacity: 0.8">Resets in ${group.weekly_refresh}</span>`;
                fiveHourEl.innerHTML = `${group.fivehr_pct || '0%'} used <br><span style="font-size: 0.85em; opacity: 0.8">Resets in ${group.fivehr_refresh}</span>`;
            } else if (data.raw_refreshes && data.raw_refreshes.length > 0) {
                weeklyEl.innerText = data.raw_refreshes[0];
                fiveHourEl.innerText = data.raw_refreshes[1] || '—';
            } else {
                weeklyEl.innerText = "No limit data found";
                fiveHourEl.innerText = "No limit data found";
            }
        } catch (err) {
            console.error('Failed to fetch quota', err);
        }

        // Update DOM
        const projEl = document.getElementById('usage-projects-count');
        const convoEl = document.getElementById('usage-convos-count');
        const msgEl = document.getElementById('usage-messages-count');
        const userEmailEl = document.getElementById('settings-user-email');

        if (projEl) projEl.innerText = `${projCount} project${projCount !== 1 ? 's' : ''}`;
        if (convoEl) convoEl.innerText = `${convoCount} conversation${convoCount !== 1 ? 's' : ''}`;
        if (msgEl) msgEl.innerText = `${messageCount} message${messageCount !== 1 ? 's' : ''} in current session`;
        if (userEmailEl && currentUser) userEmailEl.innerText = currentUser.email || 'Logged in user';

        globalSettingsModal.classList.remove('hidden');
    }


    if (userProfileBadge) {
        userProfileBadge.addEventListener('click', openGlobalSettingsModal);
    }
    if (closeGlobalSettingsBtn) {
        closeGlobalSettingsBtn.addEventListener('click', () => {
            if (globalSettingsModal) globalSettingsModal.classList.add('hidden');
        });
    }
    if (globalSettingsModal) {
        globalSettingsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
            globalSettingsModal.classList.add('hidden');
        });
    }
    if (modalLogoutBtn && logoutBtn) {
        modalLogoutBtn.addEventListener('click', () => {
            if (globalSettingsModal) globalSettingsModal.classList.add('hidden');
            logoutBtn.click();
        });
    }

    // Project Settings Listeners
    function openProjectSettingsModal(projectName, projObj) {
        currentEditingProject = projectName;
        const settings = getProjectSettings(projectName);
        if (projectAliasInput) projectAliasInput.value = settings.alias || '';
        if (projectNotesInput) projectNotesInput.value = settings.notes || '';
        if (projectModeSelect) projectModeSelect.value = settings.mode || 'auto';
        if (projectInfoName) projectInfoName.innerText = projectName;
        if (projectInfoCount) {
            const count = projObj && projObj.conversations ? projObj.conversations.length : 0;
            projectInfoCount.innerText = `${count} conversation${count !== 1 ? 's' : ''}`;
        }
        if (projectSettingsModal) projectSettingsModal.classList.remove('hidden');
    }

    if (closeProjectSettingsBtn) {
        closeProjectSettingsBtn.addEventListener('click', () => {
            if (projectSettingsModal) projectSettingsModal.classList.add('hidden');
        });
    }
    if (projectSettingsModal) {
        projectSettingsModal.querySelector('.modal-backdrop')?.addEventListener('click', () => {
            projectSettingsModal.classList.add('hidden');
        });
    }
    if (projectSettingsForm) {
        projectSettingsForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (!currentEditingProject) return;
            const updated = {
                alias: projectAliasInput ? projectAliasInput.value.trim() : '',
                notes: projectNotesInput ? projectNotesInput.value.trim() : '',
                mode: projectModeSelect ? projectModeSelect.value : 'auto'
            };
            saveProjectSettings(currentEditingProject, updated);
            
            // Dispatch update to backend so agent.py can manipulate the desktop IDE
            sendAction('update_project_settings', {
                project: currentEditingProject,
                notes: updated.notes,
                mode: updated.mode
            });
            
            if (projectSettingsModal) projectSettingsModal.classList.add('hidden');
            
            // Re-render UI with new project settings
            if (lastState) updateAppUI(lastState);
        });
    }

    // Initialize Auth Check & App
    checkAuthStatus();
});
