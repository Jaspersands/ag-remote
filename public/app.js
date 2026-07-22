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
    const approveToolBtn = document.getElementById('approve-tool-btn');
    const rejectToolBtn = document.getElementById('reject-tool-btn');
    
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');

    let socket = null;
    let currentConvoId = null;

    // Keep track of collapsed project names
    const collapsedProjects = new Set(JSON.parse(localStorage.getItem('collapsedProjects') || '[]'));
    function saveCollapsedProjects() {
        localStorage.setItem('collapsedProjects', JSON.stringify(Array.from(collapsedProjects)));
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
        
        // Find active convo name from general convos or project convos
        let activeConvo = state.conversations ? state.conversations.find(c => c.id === currentConvoId) : null;
        if (!activeConvo && state.projects) {
            for (const proj of state.projects) {
                if (proj.conversations) {
                    activeConvo = proj.conversations.find(c => c.id === currentConvoId);
                    if (activeConvo) break;
                }
            }
        }
        activeConvoTitle.innerText = activeConvo ? activeConvo.name : (state.title || 'No Conversation');
        
        // Set active project title
        activeProjectTitle.innerText = state.title || 'Antigravity Workspace';

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
            
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation(); // Avoid triggering select_project
                const isCollapsed = treeItem.classList.toggle('collapsed');
                if (isCollapsed) {
                    collapsedProjects.add(projectName);
                } else {
                    collapsedProjects.delete(projectName);
                }
                saveCollapsedProjects();
            });
            headerDiv.appendChild(toggleBtn);
            
            // Project name span
            const nameSpan = document.createElement('span');
            nameSpan.className = 'project-name';
            nameSpan.innerText = projectName;
            headerDiv.appendChild(nameSpan);
            
            headerDiv.addEventListener('click', () => {
                sendAction('select_project', { name: projectName });
                closeSidebar();
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
        if (state.messages.length === 0) {
            messageContainer.innerHTML = `
                <div class="empty-state">
                    <div class="empty-icon">🪐</div>
                    <h2>AG-Remote</h2>
                    <p>Start typing below or select a conversation from the sidebar to control Antigravity.</p>
                </div>
            `;
        } else {
            messageContainer.innerHTML = '';
            state.messages.forEach(msg => {
                const msgDiv = document.createElement('div');
                msgDiv.className = `message ${msg.sender}`;
                
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
                    msgDiv.appendChild(thoughtBlock);
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
                msgDiv.appendChild(textSpan);
                
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
                    
                    msgDiv.appendChild(fcDiv);
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
                    msgDiv.appendChild(artDiv);
                }
                
                messageContainer.appendChild(msgDiv);
            });
            
            // Auto scroll messages to bottom
            messagesPane.scrollTop = messagesPane.scrollHeight;
        }

        // 6. Tool Pending Bar
        if (state.pending_tool) {
            toolDetailsText.innerText = state.pending_tool.text;
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

    // Form submission
    chatForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;
        
        sendAction('send_message', { text });
        chatInput.value = '';
    });

    // Tool approvals
    approveToolBtn.addEventListener('click', () => {
        sendAction('approve_tool');
        toolBar.classList.add('hidden');
    });

    rejectToolBtn.addEventListener('click', () => {
        sendAction('reject_tool');
        toolBar.classList.add('hidden');
    });

    // New chat action
    newChatBtn.addEventListener('click', () => {
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
        if (chatMessages) {
            chatMessages.innerHTML = '';
        }
        if (projectsList) {
            projectsList.innerHTML = '';
        }
        if (conversationsList) {
            conversationsList.innerHTML = '';
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
        currentUser = user;
        if (user) {
            userEmailText.innerText = user.email || 'User';
            if (user.picture) {
                userAvatar.src = user.picture;
                userAvatar.style.display = 'block';
            } else {
                userAvatar.style.display = 'none';
            }
            userProfileBadge.classList.remove('hidden');
            authLockScreen.classList.add('hidden');
        } else {
            userProfileBadge.classList.add('hidden');
            authLockScreen.classList.remove('hidden');
        }
    }

    async function checkAuthStatus() {
        try {
            const token = localStorage.getItem('ag_token') || '';
            const headers = {};
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const resp = await fetch('/api/auth/status', { headers });
            const data = await resp.json();
            if (data.authenticated && data.user) {
                renderUserProfile(data.user);
                connectWebSocket();
            } else {
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
            const clientId = "32555940559.apps.googleusercontent.com";
            const redirectUri = "http://localhost:8020/api/auth/google/callback";
            const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent('openid https://www.googleapis.com/auth/userinfo.email')}`;
            
            const width = 500;
            const height = 600;
            const left = (window.screen.width - width) / 2;
            const top = (window.screen.height - height) / 2;
            
            window.open(authUrl, 'GoogleAuthPopup', `width=${width},height=${height},top=${top},left=${left},scrollbars=yes`);
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
            } catch (err) {
                showAuthError(err.message);
            }
        });
    }

    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
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
            renderUserProfile(null);
            isLoggingOut = false;
        });
    }

    // Initialize Auth Check & App
    checkAuthStatus();
});
