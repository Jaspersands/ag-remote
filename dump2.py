import asyncio
import json
import urllib.request
import websockets

async def get_ws():
    with open('/Users/jaspersands/Library/Application Support/Antigravity/DevToolsActivePort') as f:
        port = int(f.read().splitlines()[0])
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/json") as r:
        targets = json.loads(r.read().decode())
    return next(t["webSocketDebuggerUrl"] for t in targets if t["type"] == "page")

async def main():
    ws_url = await get_ws()
    async with websockets.connect(ws_url, max_size=10**8) as ws:
        js = """
        Array.from(document.querySelectorAll('*')).filter(el => {
            if(el.children.length > 0) return false;
            return el.innerText && el.innerText.toLowerCase().includes('queued');
        }).map(el => {
            let curr = el;
            for(let i=0; i<3 && curr.parentElement; i++) curr = curr.parentElement;
            return curr.outerHTML;
        }).slice(0, 3)
        """
        await ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": js, "returnByValue": True}
        }))
        res = json.loads(await ws.recv())
        print(json.dumps(res, indent=2))

asyncio.run(main())
