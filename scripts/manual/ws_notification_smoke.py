#!/usr/bin/env python3
"""Manual smoke: WebSocket notification delivery (requires running Hyve on :8082).

Usage:
    python scripts/manual/ws_notification_smoke.py
"""
from __future__ import annotations

import asyncio
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from dotenv import load_dotenv

load_dotenv()

import auth
import database
import models
import requests
import websockets


def _token() -> str:
    db = next(database.get_db())
    try:
        user = db.query(models.User).first()
        if not user:
            raise RuntimeError("No user in database — create an admin user first")
        return auth.create_access_token({"sub": user.username})
    finally:
        db.close()


async def main() -> None:
    token = _token()
    uri = f"ws://localhost:8082/ws/notifications?token={token}"
    async with websockets.connect(uri) as ws:
        print("WS connected, sending test notification via API...")
        r = requests.post(
            "http://localhost:8082/api/notifications/test",
            headers={"Authorization": f"Bearer {token}"},
            timeout=10,
        )
        print(f"API response: {r.status_code} {r.json()}")
        resp = await asyncio.wait_for(ws.recv(), timeout=5)
        data = json.loads(resp)
        print(f"Received notification: {data}")


if __name__ == "__main__":
    asyncio.run(main())
    print("Full notification delivery test PASSED!")
