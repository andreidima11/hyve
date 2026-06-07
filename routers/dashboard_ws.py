"""
Dashboard live WebSocket router (Phase 4).

Pushes entity-state diffs to the dashboard UI. Uses a shared server-side
poller (see ``core.live_entity_hub``) so N browser tabs do not spawn N polls.
"""
from __future__ import annotations

import contextlib

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

import auth
import database
import models
from core.live_entity_hub import LiveEntityWsHub, diff_snapshot, entity_signature
from logger import log_line
from routers.dashboard import _available_entities, _scene_synthetic_entities

router = APIRouter(prefix="/api/dashboard", tags=["dashboard-ws"])

_POLL_INTERVAL_SEC = 1.5
_hub: LiveEntityWsHub | None = None


async def _enrich_dashboard_items(items: list, user: models.User) -> list:
    try:
        db = next(database.get_db())
        try:
            return items + _scene_synthetic_entities(db, user)
        finally:
            db.close()
    except Exception:
        return items


def _get_hub() -> LiveEntityWsHub:
    global _hub
    if _hub is None:
        _hub = LiveEntityWsHub(
            name="dash",
            poll_interval_sec=_POLL_INTERVAL_SEC,
            fetch_items=_available_entities,
            enrich_items=_enrich_dashboard_items,
            log_icon="📊",
        )
    return _hub


# Re-export for integrations router compatibility.
_entity_signature = entity_signature
_diff_snapshot = diff_snapshot


async def _authenticate(token: str | None) -> models.User | None:
    return auth.authenticate_ws_token(token)


@router.websocket("/ws/live")
async def dashboard_live_ws(websocket: WebSocket, token: str = Query(default=None)):
    """Streams entity state diffs to the dashboard."""
    user = await _authenticate(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    await websocket.accept()
    log_line("websocket", "📊", "DASH_WS_OPEN", f"user={user.username}")

    hub = _get_hub()
    hub.attach(websocket, user)

    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or msg.startswith("ping:"):
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log_line("websocket", "⚠️", "DASH_WS_ERR", f"{exc}")
    finally:
        await hub.detach(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
        log_line("websocket", "📊", "DASH_WS_CLOSE", f"user={user.username}")
