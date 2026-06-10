from __future__ import annotations

from fastapi import Query, WebSocket
from routers.dashboard_ws import _authenticate as ws_authenticate

from core.live_entity_hub import LiveEntityWsHub
from core.ws_live_session import run_entity_live_ws
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
            mirror_driven=True,
            mirror_include_derived=True,
            mirror_sort_mode="name",
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
    await run_entity_live_ws(
        websocket,
        get_integrations_live_hub(),
        user,
        open_tag="INTEG_WS_OPEN",
        close_tag="INTEG_WS_CLOSE",
        err_tag="INTEG_WS_ERR",
    )
