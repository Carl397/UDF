#!/usr/bin/env python3
"""Tiny CDP helper: evaluate a JS expression in the emulator WebView.

Usage: python3 scripts/cdp_eval.py "<js expression>"
Connects to tcp://127.0.0.1:9222 (adb-forwarded webview_devtools_remote).
"""
import asyncio
import json
import sys
import urllib.request

import websockets


async def main(expr: str) -> None:
    targets = json.load(urllib.request.urlopen("http://127.0.0.1:9222/json"))
    page = next(t for t in targets if t.get("type") == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=None) as ws:
        await ws.send(
            json.dumps(
                {
                    "id": 1,
                    "method": "Runtime.evaluate",
                    "params": {"expression": expr, "returnByValue": True, "awaitPromise": True},
                }
            )
        )
        while True:
            msg = json.loads(await ws.recv())
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    print("EXCEPTION:", json.dumps(res["exceptionDetails"])[:2000])
                else:
                    print(json.dumps(res.get("result", {}).get("value"), indent=2))
                return


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
