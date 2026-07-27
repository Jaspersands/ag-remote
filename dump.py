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
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {"expression": "document.documentElement.outerHTML", "returnByValue": True}
        }))
        res = json.loads(await ws.recv())
        with open('ide.html', 'w') as f:
            f.write(res['result']['result']['value'])

asyncio.run(main())
