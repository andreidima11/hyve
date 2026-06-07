from __future__ import annotations

import contextlib

from fastapi import Query, WebSocket, WebSocketDisconnect
from logger import log_line
from routers.dashboard_ws import _authenticate as ws_authenticate

from core.live_entity_hub import LiveEntityWsHub
from routers.integrations import helpers
from routers.integrations.constants import LIVE_POLL_INTERVAL_SEC
from routers.integrations.router import router

_integrations_live_hub: LiveEntityWsHub | None = None


def get_integrations_live_hub() -> LiveEntityWsHub:
    global _integrations_live_hub
    if _integrations_live_hub is None:
        _integrations_live_hub = LiveEntityWsHub(
            name="integ",
            poll_interval_sec=LIVE_POLL_INTERVAL_SEC,
            fetch_items=helpers.all_entities,
            log_icon="🏠",
        )
    return _integrations_live_hub


@router.websocket("/ws/live")
async def integrations_live_ws(websocket: WebSocket, token: str = Query(default=None)):
    """Streams entity-state diffs to the smarthome (devices) page."""
    user = await ws_authenticate(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    await websocket.accept()
    log_line("websocket", "🏠", "INTEG_WS_OPEN", f"user={user.username}")

    hub = get_integrations_live_hub()
    hub.attach(websocket, user)

    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or msg.startswith("ping:"):
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log_line("websocket", "⚠️", "INTEG_WS_ERR", f"{exc}")
    finally:
        await hub.detach(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
        log_line("websocket", "🏠", "INTEG_WS_CLOSE", f"user={user.username}")
