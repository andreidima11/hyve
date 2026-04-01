#!/usr/bin/env python3
"""Quick test: connect WebSocket, fire test notification, verify delivery."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from dotenv import load_dotenv
load_dotenv()
import auth, database, models, asyncio, websockets, json, requests

db = next(database.get_db())
user = db.query(models.User).first()
token = auth.create_access_token({"sub": user.username})

async def main():
    uri = f"ws://localhost:8082/ws/notifications?token={token}"
    async with websockets.connect(uri) as ws:
        print("WS connected, sending test notification via API...")
        r = requests.post("http://localhost:8082/api/notifications/test",
                          headers={"Authorization": f"Bearer {token}"})
        print(f"API response: {r.status_code} {r.json()}")
        resp = await asyncio.wait_for(ws.recv(), timeout=5)
        data = json.loads(resp)
        print(f"Received notification: {data}")

asyncio.run(main())
print("Full notification delivery test PASSED!")
