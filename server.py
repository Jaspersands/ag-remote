import asyncio
import json
import os
import re
import subprocess
import urllib.request
import websockets
import qrcode
import io
import ssl
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Response, HTTPException, Request
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse

import jwt
import time
import secrets
from dotenv import load_dotenv

load_dotenv()

SECRET_KEY = os.getenv("SESSION_SECRET", secrets.token_hex(32))
ALLOWED_EMAILS = [e.strip().lower() for e in os.getenv("ALLOWED_EMAILS", "").split(",") if e.strip()]
AG_REMOTE_PASSCODE = os.getenv("AG_REMOTE_PASSCODE", secrets.token_urlsafe(8))
print(f"[+] Server Authentication Active. Passcode: {AG_REMOTE_PASSCODE}")

def create_session_token(email: str, name: str = "User", picture: str = "") -> str:
    payload = {
        "email": email.lower(),
        "name": name,
        "picture": picture,
        "exp": int(time.time()) + (7 * 24 * 3600)
    }
    return jwt.encode(payload, SECRET_KEY, algorithm="HS256")

def verify_session_token(token: str):
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=["HS256"])
        return payload
    except Exception:
        return None

def is_email_allowed(email: str) -> bool:
    if not ALLOWED_EMAILS:
        return True
    return email.lower() in ALLOWED_EMAILS

def get_auth_user_from_request(request: Request):
    token = request.cookies.get("ag_session")
    if not token:
        auth_header = request.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
    return verify_session_token(token)

app = FastAPI()

@app.post("/api/auth/google")
async def auth_google(request: Request, response: Response):
    data = await request.json()
    credential = data.get("credential")
    if not credential:
        raise HTTPException(status_code=400, detail="Missing credential")
        
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
        
        client_id = os.getenv("GOOGLE_CLIENT_ID") or None
        id_info = id_token.verify_oauth2_token(
            credential, 
            google_requests.Request(), 
            client_id,
            clock_skew_in_seconds=10
        )
        
        email = id_info.get("email", "")
        name = id_info.get("name", "Google User")
        picture = id_info.get("picture", "")
        
        if not is_email_allowed(email):
            raise HTTPException(status_code=403, detail=f"Access denied for email: {email}")
            
        token = create_session_token(email, name, picture)
        response.set_cookie(
            key="ag_session",
            value=token,
            httponly=True,
            samesite="lax",
            max_age=7 * 24 * 3600
        )
        return {"success": True, "token": token, "user": {"email": email, "name": name, "picture": picture}}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Google authentication failed: {str(e)}")

@app.post("/api/auth/passcode")
async def auth_passcode(request: Request, response: Response):
    data = await request.json()
    passcode = data.get("passcode", "").strip()
    if passcode != AG_REMOTE_PASSCODE:
        raise HTTPException(status_code=401, detail="Invalid passcode")
        
    email = "owner@antigravity.local"
    name = "Owner User"
    token = create_session_token(email, name, "")
    response.set_cookie(
        key="ag_session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=7 * 24 * 3600
    )
    return {"success": True, "token": token, "user": {"email": email, "name": name, "picture": ""}}

@app.get("/api/auth/status")
async def auth_status(request: Request):
    user = get_auth_user_from_request(request)
    if user:
        return {"authenticated": True, "user": {"email": user["email"], "name": user["name"], "picture": user.get("picture", "")}}
    return {"authenticated": False, "google_client_id": os.getenv("GOOGLE_CLIENT_ID", "")}

@app.post("/api/auth/logout")
async def auth_logout(response: Response):
    response.delete_cookie("ag_session")
    return {"success": True}

@app.get("/symbols-icons/{path:path}")
async def proxy_symbols_icons(path: str, request: Request):
    if not get_auth_user_from_request(request):
        raise HTTPException(status_code=401, detail="Authentication required")
        
    url_str = global_state.app_state.get("url", "")
    if not url_str:
        return Response(status_code=503, content="App URL not discovered yet")
    
    # Parse protocol, host, and port from url_str (e.g. "https://127.0.0.1:56298/c/...")
    match = re.match(r"^(https?://[a-zA-Z0-9\.\-]+:\d+)", url_str)
    if not match:
        return Response(status_code=500, content="Invalid app URL format")
    
    base_url = match.group(1)
    url = f"{base_url}/symbols-icons/{path}"
    
    try:
        # Disable SSL verification since the local dev server uses self-signed certificates
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        
        req = urllib.request.Request(url)
        with urllib.request.urlopen(req, context=ctx) as response_obj:
            content = response_obj.read()
            media_type = response_obj.headers.get("Content-Type", "image/svg+xml")
            return Response(content=content, media_type=media_type)
    except Exception as e:
        return Response(status_code=500, content=str(e))

def get_conversation_id():
    url = global_state.app_state.get("url", "")
    match = re.search(r"/c/([a-f0-9\-]+)", url)
    return match.group(1) if match else None

def resolve_workspace_file(filename: str):
    workspace_root = os.getcwd()
    for root, dirs, files in os.walk(workspace_root):
        if filename in files:
            return os.path.join(root, filename)
    return None

@app.get("/api/walkthrough")
async def get_walkthrough(request: Request):
    if not get_auth_user_from_request(request):
        raise HTTPException(status_code=401, detail="Authentication required")
        
    convo_id = get_conversation_id()
    if not convo_id:
        raise HTTPException(status_code=404, detail="No active conversation ID found")
    
    path = f"/Users/jaspersands/.gemini/antigravity/brain/{convo_id}/walkthrough.md"
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="Walkthrough not found")
        
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"content": content, "path": path, "name": "walkthrough.md"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/file")
async def get_file_content(request: Request, path: str = None, name: str = None):
    if not get_auth_user_from_request(request):
        raise HTTPException(status_code=401, detail="Authentication required")
        
    target_path = None
    if path:
        target_path = os.path.abspath(path)
    elif name:
        target_path = resolve_workspace_file(name)
        
    if not target_path:
        raise HTTPException(status_code=404, detail="File path could not be resolved")
        
    # Check security: must be in workspace or artifacts folder
    workspace_root = os.path.abspath(os.getcwd())
    artifacts_dir = os.path.abspath("/Users/jaspersands/.gemini/antigravity/brain")
    
    is_in_workspace = target_path.startswith(workspace_root)
    is_in_artifacts = target_path.startswith(artifacts_dir)
    
    if not (is_in_workspace or is_in_artifacts):
        raise HTTPException(status_code=403, detail="Access denied")
        
    if not os.path.exists(target_path):
        raise HTTPException(status_code=404, detail="File not found")
        
    try:
        with open(target_path, "r", encoding="utf-8") as f:
            content = f.read()
        return {"content": content, "path": target_path, "name": os.path.basename(target_path)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# Global state to share between the CDP manager and WebSocket clients
class GlobalState:
    def __init__(self):
        self.devtools_port = None
        self.page_ws_url = None
        self.app_state = {
            "connected": False,
            "url": "",
            "title": "",
            "projects": [],
            "conversations": [],
            "messages": [],
            "pending_tool": None
        }
        self.ws_clients = set()
        self.cdp_ws = None
        self.cdp_lock = asyncio.Lock()

global_state = GlobalState()

# Scrapers and injection scripts
JS_SCRAPER = """
(() => {
    try {
        const url = window.location.href;
        const title = document.title;
        
        // 1. Scrape Sidebar Projects & Conversations
        const projects = [];
        const sections = document.querySelectorAll('.group\\\\/section');
        sections.forEach(sec => {
            const card = sec.querySelector('[data-project-card="true"]');
            if (card) {
                const projectName = card.innerText.split('\\n')[0].trim();
                const convos = Array.from(sec.querySelectorAll('[data-testid^="convo-pill-"]')).map(pill => {
                    const id = pill.getAttribute('data-testid').replace('convo-pill-', '');
                    const name = pill.innerText.trim();
                    
                    let time = '';
                    const convoCard = pill.closest('[role="button"]');
                    if (convoCard) {
                        const timeEl = convoCard.querySelector('.min-w-4') || convoCard.querySelector('.text-xs');
                        if (timeEl) {
                            time = timeEl.innerText.trim();
                        }
                    }
                    return { id, name, time };
                });
                projects.push({ name: projectName, conversations: convos });
            }
        });
        
        const conversations = [];
        const allConvoPills = document.querySelectorAll('[data-testid^="convo-pill-"]');
        allConvoPills.forEach(pill => {
            if (!pill.closest('.group\\\\/section')) {
                const id = pill.getAttribute('data-testid').replace('convo-pill-', '');
                const name = pill.innerText.trim();
                
                let time = '';
                const convoCard = pill.closest('[role="button"]');
                if (convoCard) {
                    const timeEl = convoCard.querySelector('.min-w-4') || convoCard.querySelector('.text-xs');
                    if (timeEl) {
                        time = timeEl.innerText.trim();
                    }
                }
                conversations.push({ id, name, time });
            }
        });

        // 2. Scrape Messages
        const messages = [];
        let pending_tool = null;
        
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        articles.forEach((art, artIdx) => {
            // 1. Extract User message
            const userEl = art.querySelector('[data-testid="user-input-step"]');
            let userText = "";
            if (userEl) {
                const textEl = userEl.querySelector('.whitespace-pre-wrap');
                userText = textEl ? textEl.innerText.trim() : userEl.innerText.trim();
                // Remove timestamp at the end if present (e.g. "4:27 PM" or "8:50 PM")
                userText = userText.replace(/\\d+:\\d+\\s*(AM|PM)$/, '').trim();
            }
            
            // 2. Extract Assistant message (now using innerHTML to keep rich file badges and anchors!)
            const assistantTextEl = art.querySelector('div[class*="leading-relaxed"]');
            let assistantText = "";
            if (assistantTextEl) {
                assistantText = assistantTextEl.innerHTML.trim();
            }
            
            // 3. Extract Thoughts
            const thoughtBtn = Array.from(art.querySelectorAll('button')).find(b => 
                b.innerText.includes('Worked for') || b.innerText.includes('Thinking') || b.innerText.includes('Thought for')
            );
            const hasThoughts = !!thoughtBtn;
            
            // 4. Extract Artifact Card
            let artifact = null;
            const artifactCard = art.querySelector('.artifact-card');
            if (artifactCard) {
                const lines = artifactCard.innerText.split('\\n');
                artifact = {
                    title: lines[0] || '',
                    summary: lines.slice(1).join('\\n') || ''
                };
            }
            
            // 4.5 Extract Files Changed Block (if present)
            const filesHeader = art.querySelector('.files-changed-header');
            const hasFiles = !!filesHeader;
            
            // 5. Check for pending tool approvals inside this assistant response
            const toolConfirmations = art.querySelectorAll('button');
            toolConfirmations.forEach(btn => {
                const btnText = btn.innerText.trim();
                if (btnText.includes('Proceed') || btnText.includes('Run') || btnText.includes('Confirm') || btnText.includes('Sandbox')) {
                    let toolDetails = "";
                    const codeBlock = art.querySelector('pre, code, div.font-mono');
                    if (codeBlock) {
                        toolDetails = codeBlock.innerText.trim();
                    }
                    pending_tool = {
                        text: toolDetails || "Pending tool approval",
                        type: btnText
                    };
                }
            });
            
            if (userText) {
                messages.push({ sender: 'user', text: userText, articleIndex: artIdx });
            }
            if (assistantText || hasThoughts || hasFiles || pending_tool) {
                messages.push({
                    sender: 'assistant',
                    text: assistantText,
                    hasThoughts: hasThoughts,
                    hasFiles: hasFiles,
                    artifact: artifact,
                    pending_tool: pending_tool ? true : false,
                    articleIndex: artIdx
                });
            }
        });
        
        return {
            url,
            title,
            projects,
            conversations,
            messages,
            pending_tool
        };
    } catch (e) {
        return { error: e.toString() };
    }
})()
"""

# Discover Chrome DevTools port and connect to active target page
async def get_devtools_ws_url():
    port_file_path = os.path.expanduser("~/Library/Application Support/Antigravity/DevToolsActivePort")
    if not os.path.exists(port_file_path):
        print(f"[-] DevToolsActivePort file not found at {port_file_path}. Is the Antigravity desktop app running?")
        return None
        
    try:
        with open(port_file_path, "r") as f:
            lines = f.read().splitlines()
            if not lines:
                return None
            port = int(lines[0])
            global_state.devtools_port = port
            
        # Query http://127.0.0.1:{port}/json to find active page
        json_url = f"http://127.0.0.1:{port}/json"
        with urllib.request.urlopen(json_url) as response:
            targets = json.loads(response.read().decode())
            
        page_target = next((t for t in targets if t.get("type") == "page"), None)
        if page_target:
            return page_target["webSocketDebuggerUrl"]
    except Exception as e:
        print(f"[-] Error parsing DevTools port: {e}")
    return None

def normalize_text(text):
    if not text:
        return ""
    # Strip style blocks and their contents
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Strip script blocks and their contents
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
    # Strip remaining HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    # Strip markdown symbols
    text = re.sub(r"[\*\_`#\-\+\>\!\(\)\[\]]", "", text)
    return "".join(c.lower() for c in text if c.isalnum())

def find_matching_transcript_step(scraped_text, transcript_details):
    norm_scraped = normalize_text(scraped_text)
    if not norm_scraped:
        return None
    best_step = None
    best_score = 0
    for detail in transcript_details:
        norm_trans = normalize_text(detail.get("content", ""))
        if not norm_trans:
            continue
        common_len = 0
        min_len = min(len(norm_scraped), len(norm_trans), 80)
        if min_len > 0:
            for k in range(min_len):
                if norm_scraped[k] == norm_trans[k]:
                    common_len += 1
                else:
                    break
        
        # Substring fallback matching
        if common_len < 15:
            prefix_trans = norm_trans[:40]
            if prefix_trans and prefix_trans in norm_scraped:
                common_len = len(prefix_trans)
            else:
                prefix_scraped = norm_scraped[:40]
                if prefix_scraped and prefix_scraped in norm_trans:
                    common_len = len(prefix_scraped)
                    
        if common_len > best_score:
            best_score = common_len
            best_step = detail
    if best_score >= 15:
        return best_step
    return None

_transcript_cache = {}

def parse_transcript_details(convo_id):
    path = f"/Users/jaspersands/.gemini/antigravity/brain/{convo_id}/.system_generated/logs/transcript_full.jsonl"
    if not os.path.exists(path):
        return []
    try:
        mtime = os.path.getmtime(path)
        if path in _transcript_cache:
            cached_mtime, cached_res = _transcript_cache[path]
            if cached_mtime == mtime:
                return cached_res
                
        steps = []
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                steps.append(json.loads(line))
                
        # Group steps by assistant turns (delimited by USER_INPUT steps)
        turns = []
        current_turn_steps = []
        
        for step in steps:
            if step.get("type") == "USER_INPUT":
                if current_turn_steps:
                    turns.append(current_turn_steps)
                    current_turn_steps = []
            else:
                current_turn_steps.append(step)
        if current_turn_steps:
            turns.append(current_turn_steps)
            
        planner_responses = []
        for turn_steps in turns:
            model_steps = [s for s in turn_steps if s.get("source") == "MODEL"]
            if not model_steps:
                continue
                
            planner_steps = [s for s in model_steps if s.get("type") == "PLANNER_RESPONSE"]
            if not planner_steps:
                continue
            final_content = planner_steps[-1].get("content", "")
            
            thinking_parts = []
            for s in planner_steps:
                think = s.get("thinking", "")
                if think:
                    thinking_parts.append(think)
            accumulated_thinking = "\n\n".join(thinking_parts)
            
            modified_files_dict = {}
            for i, step in enumerate(turn_steps):
                if step.get("type") == "PLANNER_RESPONSE" and step.get("source") == "MODEL":
                    tool_calls = step.get("tool_calls", [])
                    for tc in tool_calls:
                        tc_name = tc.get("name")
                        tc_args = tc.get("args", {})
                        target_file = tc_args.get("TargetFile") or tc_args.get("TargetContent")
                        if tc_name in ["replace_file_content", "multi_replace_file_content", "write_to_file"] and target_file:
                            file_path = os.path.abspath(target_file)
                            file_name = os.path.basename(file_path)
                            dir_path = os.path.dirname(file_path)
                            
                            additions = 0
                            deletions = 0
                            
                            for j in range(i + 1, len(turn_steps)):
                                next_step = turn_steps[j]
                                if next_step.get("type") == "CODE_ACTION" and file_name in next_step.get("content", ""):
                                    diff_content = next_step.get("content", "")
                                    for line in diff_content.splitlines():
                                        if line.startswith("+") and not line.startswith("+++"):
                                            additions += 1
                                        elif line.startswith("-") and not line.startswith("---"):
                                            deletions += 1
                                    break
                            
                            key = (file_name, dir_path)
                            if key not in modified_files_dict:
                                modified_files_dict[key] = {"additions": 0, "deletions": 0}
                            modified_files_dict[key]["additions"] += additions
                            modified_files_dict[key]["deletions"] += deletions

            modified_files = []
            for (file_name, dir_path), stats in modified_files_dict.items():
                add = stats["additions"]
                del_count = stats["deletions"]
                modified_files.append({
                    "name": file_name,
                    "path": dir_path,
                    "additions": f"+{add}" if add else "0",
                    "deletions": f"-{del_count}" if del_count else "0",
                    "icon": f"/symbols-icons/icons/files/{file_name.split('.')[-1]}.svg" if "." in file_name else "/symbols-icons/icons/files/file.svg"
                })
                
            files_changed = None
            if modified_files:
                total_add = sum(int(f["additions"].replace("+","")) for f in modified_files)
                total_del = sum(int(f["deletions"].replace("-","")) for f in modified_files)
                files_changed = {
                    "summary": f"{len(modified_files)} files changed",
                    "additions": f"+{total_add}",
                    "deletions": f"-{total_del}",
                    "expanded": True,
                    "files": modified_files
                }
                
            planner_responses.append({
                "content": final_content,
                "thinking": accumulated_thinking,
                "filesChanged": files_changed
            })
            
        _transcript_cache[path] = (mtime, planner_responses)
        return planner_responses
    except Exception as e:
        print(f"[-] Error parsing transcript details: {e}")
        return []

# Task to monitor the desktop app via CDP
async def cdp_monitor_task():
    while True:
        if not global_state.page_ws_url:
            ws_url = await get_devtools_ws_url()
            if ws_url:
                global_state.page_ws_url = ws_url
                print(f"[+] Discovered Antigravity app CDP WebSocket: {ws_url}")
            else:
                await asyncio.sleep(2)
                continue
                
        try:
            print(f"[+] Connecting to Antigravity app CDP...")
            async with websockets.connect(global_state.page_ws_url) as ws:
                global_state.cdp_ws = ws
                global_state.app_state["connected"] = True
                await broadcast_state()
                
                # Main polling loop
                msg_id = 1000
                while True:
                    await asyncio.sleep(0.5)  # Scrape every 500ms
                    
                    async with global_state.cdp_lock:
                        msg_id += 1
                        eval_msg = {
                            "id": msg_id,
                            "method": "Runtime.evaluate",
                            "params": {
                                "expression": JS_SCRAPER,
                                "returnByValue": True
                            }
                        }
                        await ws.send(json.dumps(eval_msg))
                        
                        # Read response (or wait for incoming frames)
                        try:
                            while True:
                                res = await asyncio.wait_for(ws.recv(), timeout=2.0)
                                data = json.loads(res)
                                if data.get("id") == msg_id:
                                    break
                            
                            result = data.get("result", {}).get("result", {}).get("value", {})
                            if result and "error" not in result:
                                new_state = {
                                    "connected": True,
                                    "url": result.get("url", ""),
                                    "title": result.get("title", ""),
                                    "projects": result.get("projects", []),
                                    "conversations": result.get("conversations", []),
                                    "messages": result.get("messages", []),
                                    "pending_tool": result.get("pending_tool")
                                }
                                
                                # Reconstruct details from transcript
                                convo_id = None
                                url = new_state.get("url", "")
                                match = re.search(r"/c/([a-f0-9\-]+)", url)
                                if match:
                                    convo_id = match.group(1)
                                    
                                if convo_id:
                                    transcript_details = parse_transcript_details(convo_id)
                                    for msg in new_state.get("messages", []):
                                        if msg.get("sender") == "assistant":
                                            scraped_text = msg.get("text", "")
                                            detail = find_matching_transcript_step(scraped_text, transcript_details)
                                            if detail:
                                                if msg.get("hasThoughts") and detail.get("thinking"):
                                                    msg["thoughts"] = detail["thinking"]
                                                if msg.get("hasFiles") and detail.get("filesChanged"):
                                                    msg["filesChanged"] = detail["filesChanged"]
                                
                                # Compare states to avoid redundant broadcasts
                                state_changed = False
                                for key in ["url", "title", "projects", "conversations", "messages", "pending_tool"]:
                                    if global_state.app_state.get(key) != new_state.get(key):
                                        state_changed = True
                                        break
                                
                                if not global_state.app_state.get("connected"):
                                    state_changed = True
                                    
                                if state_changed:
                                    global_state.app_state.update(new_state)
                                    # Broadcast to connected iPhone web clients
                                    await broadcast_state()
                        except asyncio.TimeoutError:
                            pass
                        except Exception as e:
                            print(f"[-] Error in CDP scrape recv: {e}")
                            break
        except Exception as e:
            print(f"[-] CDP connection lost or failed: {e}. Retrying in 2 seconds...")
            global_state.app_state["connected"] = False
            global_state.cdp_ws = None
            global_state.page_ws_url = None
            await broadcast_state()
            await asyncio.sleep(2)

# Broadcast the scraped state to all connected iPhone WebSocket clients
async def broadcast_state():
    if not global_state.ws_clients:
        return
    data = json.dumps(global_state.app_state)
    disconnected = set()
    for client in global_state.ws_clients:
        try:
            await client.send_text(data)
        except Exception:
            disconnected.add(client)
    global_state.ws_clients.difference_update(disconnected)

# Execute custom JS actions on the page
async def execute_action(js_code: str):
    if not global_state.cdp_ws:
        print("[-] Cannot execute action: Not connected to CDP")
        return None
    async with global_state.cdp_lock:
        try:
            msg_id = 9999
            eval_msg = {
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": js_code,
                    "awaitPromise": True,
                    "returnByValue": True
                }
            }
            await global_state.cdp_ws.send(json.dumps(eval_msg))
            
            while True:
                res = await asyncio.wait_for(global_state.cdp_ws.recv(), timeout=5.0)
                data = json.loads(res)
                if data.get("id") == msg_id:
                    break
                    
            return data.get("result", {}).get("result", {}).get("value")
        except Exception as e:
            print(f"[-] Action execution failed: {e}")
            return None

# Actions implemented as injected JavaScript
async def action_send_message(text: str):
    escaped_text = text.replace("'", "\\'").replace("\n", "\\n")
    js = f"""
    (() => {{
        const editor = document.querySelector('[aria-label="Message input"]');
        if (!editor) return {{ error: "No message input found" }};
        
        editor.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        
        document.execCommand('insertText', false, '{escaped_text}');
        editor.dispatchEvent(new Event('input', {{ bubbles: true }}));
        
        return new Promise((resolve) => {{
            setTimeout(() => {{
                const sendBtn = document.querySelector('[data-testid="send-button"]');
                if (sendBtn) {{
                    if (sendBtn.disabled) {{
                        resolve({{ success: false, error: "Send button is disabled" }});
                    }} else {{
                        sendBtn.click();
                        resolve({{ success: true }});
                    }}
                }} else {{
                    resolve({{ success: false, error: "Send button not found" }});
                }}
            }}, 100);
        }});
    }})()
    """
    return await execute_action(js)

async def action_approve_tool():
    js = """
    (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.innerText.includes('Proceed') || b.innerText.includes('Run') || b.innerText.includes('Confirm')
        );
        if (btn) {
            btn.click();
            return { success: true };
        }
        return { error: "Proceed button not found" };
    })()
    """
    return await execute_action(js)

async def action_reject_tool():
    js = """
    (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.innerText.includes('Cancel') || b.innerText.includes('Reject')
        );
        if (btn) {
            btn.click();
            return { success: true };
        }
        return { error: "Cancel button not found" };
    })()
    """
    return await execute_action(js)

async def action_new_conversation():
    js = """
    (() => {
        const btn = Array.from(document.querySelectorAll('button')).find(b => 
            b.innerText.includes('New Conversation') || b.innerText.includes('New Chat')
        );
        if (btn) {
            btn.click();
            return { success: true };
        }
        return { error: "New Conversation button not found" };
    })()
    """
    return await execute_action(js)

async def action_select_project(name: str):
    escaped_name = name.replace("'", "\\'")
    js = f"""
    (() => {{
        const btn = Array.from(document.querySelectorAll('[data-project-card="true"]')).find(b => b.innerText.trim() === '{escaped_name}');
        if (btn) {{
            btn.click();
            return {{ success: true }};
        }}
        return {{ error: "Project button not found" }};
    }})()
    """
    return await execute_action(js)

async def action_select_conversation(id: str):
    js = f"""
    (() => {{
        const span = document.querySelector('[data-testid="convo-pill-{id}"]');
        const btn = span ? span.closest('[role="button"]') : null;
        if (btn) {{
            btn.click();
            return {{ success: true }};
        }}
        window.location.href = 'https://127.0.0.1:64472/c/{id}';
        return {{ success: true, fallback: true }};
    }})()
    """
    return await execute_action(js)

async def action_click_files_changed(article_index: int):
    js = f"""
    (() => {{
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        const art = articles[{article_index}];
        const header = art ? art.querySelector('.files-changed-header') : null;
        if (header) {{
            header.click();
            return {{ success: true }};
        }}
        return {{ error: "Files changed header not found" }};
    }})()
    """
    return await execute_action(js)

async def action_click_review_button(article_index: int):
    js = f"""
    (() => {{
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        const art = articles[{article_index}];
        const btn = art ? art.querySelector('.review-button') : null;
        if (btn) {{
            btn.click();
            return {{ success: true }};
        }}
        return {{ error: "Review button not found" }};
    }})()
    """
    return await execute_action(js)

async def action_click_file_row(name: str, path: str):
    escaped_name = name.replace("'", "\\'")
    escaped_path = path.replace("'", "\\'")
    js = f"""
    (() => {{
        const rows = Array.from(document.querySelectorAll('.group\\\\/file-title'));
        const row = rows.find(r => r.innerText.includes('{escaped_name}') && r.innerText.includes('{escaped_path}'));
        if (row) {{
            row.click();
            return {{ success: true }};
        }}
        return {{ error: "File row not found" }};
    }})()
    """
    return await execute_action(js)

async def action_click_scope_mention(article_index: int, filename: str):
    escaped_filename = filename.replace("'", "\\'")
    js = f"""
    (() => {{
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        const art = articles[{article_index}];
        if (art) {{
            const buttons = Array.from(art.querySelectorAll('.context-scope-mention button'));
            const btn = buttons.find(b => b.innerText.trim() === '{escaped_filename}');
            if (btn) {{
                btn.click();
                return {{ success: true }};
            }}
        }}
        return {{ error: "Scope mention button not found" }};
    }})()
    """
    return await execute_action(js)

async def action_click_artifact(article_index: int):
    js = f"""
    (() => {{
        const articles = Array.from(document.querySelectorAll('[role="article"]'));
        const art = articles[{article_index}];
        const card = art ? art.querySelector('.artifact-card') : null;
        if (card) {{
            card.click();
            return {{ success: true }};
        }}
        return {{ error: "Artifact card not found" }};
    }})()
    """
    return await execute_action(js)

# FastAPI WebSocket route for iPhone web client
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    token = websocket.cookies.get("ag_session") or websocket.query_params.get("token")
    user = verify_session_token(token)
    
    if not user:
        await websocket.close(code=4001, reason="Unauthorized")
        return
        
    await websocket.accept()
    global_state.ws_clients.add(websocket)
    print(f"[+] Authenticated WebSocket client connected: {user.get('email')} ({websocket.client})")
    
    # Send initial state
    await websocket.send_text(json.dumps(global_state.app_state))
    
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            action = payload.get("action")
            
            print(f"[+] Received iPhone action: {action}")
            res = None
            if action == "send_message":
                res = await action_send_message(payload.get("text", ""))
            elif action == "approve_tool":
                res = await action_approve_tool()
            elif action == "reject_tool":
                res = await action_reject_tool()
            elif action == "new_conversation":
                res = await action_new_conversation()
            elif action == "select_project":
                res = await action_select_project(payload.get("name", ""))
            elif action == "select_conversation":
                res = await action_select_conversation(payload.get("id", ""))
            elif action == "click_files_changed":
                res = await action_click_files_changed(payload.get("articleIndex", 0))
            elif action == "click_review_button":
                res = await action_click_review_button(payload.get("articleIndex", 0))
            elif action == "click_file_row":
                res = await action_click_file_row(payload.get("name", ""), payload.get("path", ""))
            elif action == "click_scope_mention":
                res = await action_click_scope_mention(payload.get("articleIndex", 0), payload.get("filename", ""))
            elif action == "click_artifact":
                res = await action_click_artifact(payload.get("articleIndex", 0))
            print(f"[+] Action result: {res}")
    except WebSocketDisconnect:
        print(f"[-] WebSocket client disconnected: {websocket.client}")
        global_state.ws_clients.remove(websocket)
    except Exception as e:
        print(f"[-] WebSocket error: {e}")
        if websocket in global_state.ws_clients:
            global_state.ws_clients.remove(websocket)

# Start background monitoring task on FastAPI startup
@app.on_event("startup")
async def startup_event():
    asyncio.create_task(cdp_monitor_task())
    asyncio.create_task(cloudflare_tunnel_task())

# Start Cloudflare Tunnel process in background
async def cloudflare_tunnel_task():
    print("[+] Starting Cloudflare Tunnel...")
    process = subprocess.Popen(
        ["/usr/local/bin/cloudflared", "tunnel", "--url", "http://localhost:8020"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True
    )
    
    # Parse stderr of cloudflared to find the .trycloudflare.com URL
    tunnel_url = None
    while True:
        line = process.stderr.readline()
        if not line:
            break
        print(f"[cloudflared] {line.strip()}")
        
        # Look for the URL match
        match = re.search(r"https://[a-zA-Z0-9\-]+\.trycloudflare\.com", line)
        if match:
            tunnel_url = match.group(0)
            print("\n" + "="*60)
            print(f"[+] CLOUDFLARE TUNNEL ONLINE!")
            print(f"[+] Public URL: {tunnel_url}")
            print("="*60 + "\n")
            
            # Print QR code in terminal and save as PNG
            qr = qrcode.QRCode(version=1, box_size=10, border=4)
            qr.add_data(tunnel_url)
            qr.make(fit=True)
            
            # Save PNG
            img = qr.make_image(fill_color="black", back_color="white")
            img.save("public/qr.png")
            
            f = io.StringIO()
            qr.print_ascii(out=f)
            print("[+] Scan this QR Code with your iPhone to open AG-Remote:")
            print(f.getvalue())
            print("[+] Saved QR code PNG to public/qr.png")
            break
        await asyncio.sleep(0.1)

# Serve the static frontend assets from 'public/' directory
app.mount("/", StaticFiles(directory="public", html=True), name="public")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8020)

