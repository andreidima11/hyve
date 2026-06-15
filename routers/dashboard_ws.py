"""
Dashboard live WebSocket router (Phase 4).

Pushes entity-state diffs to the dashboard UI. Uses a shared server-side
poller (see ``core.live_entity_hub``) so N browser tabs do not spawn N polls.
"""
from __future__ import annotations

from fastapi import APIRouter, Query, WebSocket

import core.auth as auth
import core.database as database
import core.models as models
from core.live_entity_hub import LiveEntityWsHub, diff_snapshot, entity_signature
from core.ws_live_session import run_entity_live_ws

router = APIRouter(prefix="/api/dashboard", tags=["dashboard-ws"])

_POLL_INTERVAL_SEC = 1.5
_hub: LiveEntityWsHub | None = None


async def _enrich_dashboard_items(items: list, user: models.User) -> list:
    try:
        from routers.dashboard.entities import get_scene_synthetic_entities

        return list(items) + get_scene_synthetic_entities(user)
    except Exception:
        return items


def get_dashboard_live_hub() -> LiveEntityWsHub:
    global _hub
    if _hub is None:
        from routers.dashboard.entities import _available_entities

        _hub = LiveEntityWsHub(
            name="dash",
            poll_interval_sec=_POLL_INTERVAL_SEC,
            fetch_items=_available_entities,
            enrich_items=_enrich_dashboard_items,
            log_icon="📊",
            mirror_driven=True,
            mirror_include_derived=False,
            mirror_sort_mode="dashboard",
        )
    return _hub


def _get_hub() -> LiveEntityWsHub:
    return get_dashboard_live_hub()


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
    await run_entity_live_ws(
        websocket,
        _get_hub(),
        user,
        open_tag="DASH_WS_OPEN",
        close_tag="DASH_WS_CLOSE",
        err_tag="DASH_WS_ERR",
    )
