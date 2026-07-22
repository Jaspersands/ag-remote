import asyncio
import json
import os
import re
import sys
import ssl
import urllib.request
import argparse
import websockets

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
            const userEl = art.querySelector('[data-testid="user-input-step"]');
            let userText = "";
            if (userEl) {
                const textEl = userEl.querySelector('.whitespace-pre-wrap');
                userText = textEl ? textEl.innerText.trim() : userEl.innerText.trim();
                userText = userText.replace(/\\d+:\\d+\\s*(AM|PM)$/, '').trim();
            }
            
            const assistantTextEl = art.querySelector('div[class*="leading-relaxed"]');
            let assistantText = "";
            if (assistantTextEl) {
                assistantText = assistantTextEl.innerHTML.trim();
            }
            
            const thoughtBtn = Array.from(art.querySelectorAll('button')).find(b => 
                b.innerText.includes('Worked for') || b.innerText.includes('Thinking') || b.innerText.includes('Thought for')
            );
            const hasThoughts = !!thoughtBtn;
            
            let artifact = null;
            const artifactCard = art.querySelector('.artifact-card');
            if (artifactCard) {
                const lines = artifactCard.innerText.split('\\n');
                artifact = {
                    title: lines[0] || '',
                    summary: lines.slice(1).join('\\n') || ''
                };
            }
            
            const filesHeader = art.querySelector('.files-changed-header');
            const hasFiles = !!filesHeader;
            
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

def normalize_text(text):
    if not text:
        return ""
    text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<script[^>]*>.*?</script>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
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
    path = os.path.expanduser(f"~/.gemini/antigravity/brain/{convo_id}/.system_generated/logs/transcript_full.jsonl")
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
        return []

class AntigravityAgent:
    def __init__(self, server_url, email):
        self.server_url = server_url.rstrip("/")
        self.email = email.strip().lower()
        self.cdp_ws_url = None
        self.cdp_ws = None
        self.cdp_lock = asyncio.Lock()
        self.last_app_state = {}

    async def get_devtools_ws_url(self):
        port_file_path = os.path.expanduser("~/Library/Application Support/Antigravity/DevToolsActivePort")
        if not os.path.exists(port_file_path):
            print("[-] Antigravity app not detected. Please open the Antigravity desktop application.")
            return None
        try:
            with open(port_file_path, "r") as f:
                lines = f.read().splitlines()
                if not lines:
                    return None
                port = int(lines[0])
            json_url = f"http://127.0.0.1:{port}/json"
            with urllib.request.urlopen(json_url) as response:
                targets = json.loads(response.read().decode())
            page_target = next((t for t in targets if t.get("type") == "page"), None)
            return page_target["webSocketDebuggerUrl"] if page_target else None
        except Exception as e:
            print(f"[-] DevTools error: {e}")
            return None

    async def execute_action(self, js_code):
        async with self.cdp_lock:
            if not self.cdp_ws:
                return {"error": "CDP WebSocket not connected"}
            msg_id = 9999
            eval_msg = {
                "id": msg_id,
                "method": "Runtime.evaluate",
                "params": {
                    "expression": js_code,
                    "returnByValue": True
                }
            }
            await self.cdp_ws.send(json.dumps(eval_msg))
            while True:
                resp_text = await self.cdp_ws.recv()
                resp = json.loads(resp_text)
                if resp.get("id") == msg_id:
                    result = resp.get("result", {}).get("result", {}).get("value", {})
                    return result

    async def execute_command(self, payload):
        action = payload.get("action")
        if action == "send_message":
            text = payload.get("text", "").replace("\\", "\\\\").replace("`", "\\`").replace("$", "\\$")
            js = f"""
            (() => {{
                const input = document.querySelector('textarea, div[contenteditable="true"]');
                if (!input) return {{ error: "Input not found" }};
                input.focus();
                if (input.tagName === 'TEXTAREA') {{
                    input.value = `{text}`;
                    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }} else {{
                    input.innerText = `{text}`;
                    input.dispatchEvent(new Event('input', {{ bubbles: true }}));
                }}
                setTimeout(() => {{
                    const form = input.closest('form');
                    const sendBtn = form ? form.querySelector('button[type="submit"]') : null;
                    if (sendBtn && !sendBtn.disabled) {{
                        sendBtn.click();
                    }} else {{
                        input.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }}));
                    }}
                }}, 100);
                return {{ success: true }};
            }})()
            """
            return await self.execute_action(js)
        elif action == "approve_tool":
            js = """
            (() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const approveBtn = buttons.find(b => {
                    const txt = b.innerText.trim();
                    return txt === 'Proceed' || txt === 'Run' || txt === 'Confirm';
                });
                if (approveBtn) { approveBtn.click(); return { success: true }; }
                return { error: "Approve button not found" };
            })()
            """
            return await self.execute_action(js)
        elif action == "reject_tool":
            js = """
            (() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                const cancelBtn = buttons.find(b => b.innerText.trim() === 'Cancel');
                if (cancelBtn) { cancelBtn.click(); return { success: true }; }
                return { error: "Cancel button not found" };
            })()
            """
            return await self.execute_action(js)
        elif action == "new_conversation":
            js = """
            (() => {
                const btn = document.querySelector('[data-testid="new-convo-button"]') || 
                            Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('New'));
                if (btn) { btn.click(); return { success: true }; }
                return { error: "New conversation button not found" };
            })()
            """
            return await self.execute_action(js)
        elif action == "select_conversation":
            convo_id = payload.get("id", "")
            js = f"""
            (() => {{
                const pill = document.querySelector('[data-testid="convo-pill-{convo_id}"]');
                if (pill) {{ pill.click(); return {{ success: true }}; }}
                return {{ error: "Conversation not found" }};
            }})()
            """
            return await self.execute_action(js)
        return {"error": "Unknown action"}

    async def start(self):
        print(f"[+] Antigravity Remote Agent Starting...")
        print(f"[+] Server Relay URL: {self.server_url}")
        print(f"[+] Paired Account Email: {self.email}")
        
        while True:
            self.cdp_ws_url = await self.get_devtools_ws_url()
            if not self.cdp_ws_url:
                await asyncio.sleep(3)
                continue
            
            try:
                print(f"[+] Connecting to local Antigravity app CDP...")
                async with websockets.connect(self.cdp_ws_url) as cdp_ws:
                    self.cdp_ws = cdp_ws
                    print(f"[+] Local CDP Connected!")
                    
                    ws_scheme = "wss" if self.server_url.startswith("https") else "ws"
                    server_host = self.server_url.replace("https://", "").replace("http://", "")
                    relay_url = f"{ws_scheme}://{server_host}/ws/agent?email={self.email}"
                    
                    print(f"[+] Connecting to Central Relay: {relay_url}")
                    async with websockets.connect(relay_url) as relay_ws:
                        print(f"[+] Registered on Central Relay Server as: {self.email}")
                        
                        async def cdp_scraper_loop():
                            while True:
                                try:
                                    res = await self.execute_action(JS_SCRAPER)
                                    if res and "error" not in res:
                                        new_state = {
                                            "connected": True,
                                            "url": res.get("url", ""),
                                            "title": res.get("title", ""),
                                            "projects": res.get("projects", []),
                                            "conversations": res.get("conversations", []),
                                            "messages": res.get("messages", []),
                                            "pending_tool": res.get("pending_tool")
                                        }
                                        url = res.get("url", "")
                                        match = re.search(r"/c/([a-f0-9\-]+)", url)
                                        convo_id = match.group(1) if match else None
                                        
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
                                        
                                        if self.last_app_state != new_state:
                                            self.last_app_state = new_state
                                            await relay_ws.send(json.dumps({
                                                "type": "state_update",
                                                "state": new_state
                                            }))
                                except Exception as e:
                                    print(f"[-] Scraper loop error: {e}")
                                await asyncio.sleep(0.5)

                        async def relay_command_loop():
                            while True:
                                msg_text = await relay_ws.recv()
                                payload = json.loads(msg_text)
                                print(f"[+] Executing Remote Command: {payload.get('action')}")
                                result = await self.execute_command(payload)
                                await relay_ws.send(json.dumps({
                                    "type": "action_result",
                                    "action": payload.get("action"),
                                    "result": result
                                }))

                        await asyncio.gather(cdp_scraper_loop(), relay_command_loop())

            except Exception as e:
                print(f"[-] Disconnected: {e}. Retrying in 3 seconds...")
                await asyncio.sleep(3)

def main():
    parser = argparse.ArgumentParser(description="AG-Remote Agent")
    parser.add_argument("--server", default="http://localhost:8020", help="Relay Server URL")
    parser.add_argument("--email", default="jaspersands02@gmail.com", help="Google Account Email")
    args = parser.parse_args()
    
    agent = AntigravityAgent(args.server, args.email)
    asyncio.run(agent.start())

if __name__ == "__main__":
    main()
