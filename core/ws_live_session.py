"""Shared WebSocket session loop for entity live hubs."""

from __future__ import annotations

import contextlib
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect

from core.live_entity_hub import LiveEntityWsHub
from core.logger import log_line


async def run_entity_live_ws(
    websocket: WebSocket,
    hub: LiveEntityWsHub,
    user: Any,
    *,
    open_tag: str,
    close_tag: str,
    err_tag: str,
) -> None:
    """Attach client, handle ping/pong, detach on exit."""
    log_line("websocket", "📊", open_tag, f"user={getattr(user, 'username', '')}")
    hub.attach(websocket, user)
    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or msg.startswith("ping:"):
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log_line("websocket", "⚠️", err_tag, f"{exc}")
    finally:
        await hub.detach(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
        log_line("websocket", "📊", close_tag, f"user={getattr(user, 'username', '')}")
