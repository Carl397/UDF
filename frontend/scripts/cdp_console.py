#!/usr/bin/env python3
"""CDP console capture: reload the WebView page and print console/log entries."""
import asyncio
import json
import urllib.request

import websockets


async def main() -> None:
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
        mid = 0

        async def send(method, params=None):
            nonlocal mid
            mid += 1
            await ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))

        await send("Runtime.enable")
        await send("Log.enable")
        await send("Page.enable")
        await send("Page.reload", {"ignoreCache": True})

        loop = asyncio.get_event_loop()
        end = loop.time() + 10
        while loop.time() < end:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=1)
            except asyncio.TimeoutError:
                continue
            msg = json.loads(raw)
            m = msg.get("method")
            if m == "Runtime.consoleAPICalled":
                args = [a.get("value", a.get("description", "")) for a in msg["params"]["args"]]
                print(f"[console.{msg['params']['type']}]", " ".join(str(a) for a in args)[:1500])
            elif m == "Runtime.exceptionThrown":
                d = msg["params"]["exceptionDetails"]
                desc = d.get("exception", {}).get("description") or d.get("text")
                print("[exception]", str(desc)[:3000])
            elif m == "Log.entryAdded":
                e = msg["params"]["entry"]
                print(f"[log.{e['level']}]", e.get("text", "")[:800], e.get("url", ""))


if __name__ == "__main__":
    asyncio.run(main())
