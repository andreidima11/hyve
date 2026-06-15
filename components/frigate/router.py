"""Frigate go2rtc WebSocket proxy — capability router."""

from __future__ import annotations

import asyncio
import logging
import ssl
from urllib.parse import quote

import websockets
from fastapi import APIRouter, Query, WebSocket

from components.frigate import camera_proxy as frigate_cam
from core.cameras.entity_lookup import camera_entity
from core.cameras.shared import ws_base_url
from core.cameras.stream_auth import authenticate_ws_user

log = logging.getLogger("frigate.camera.router")

router = APIRouter(prefix="/api/cameras", tags=["cameras", "frigate"])


@router.websocket("/{entity_id}/go2rtc/ws")
async def camera_go2rtc_ws(websocket: WebSocket, entity_id: str, token: str = Query(default=None)):
    user = await authenticate_ws_user(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    try:
        ent = await camera_entity(entity_id)
        attrs = dict(ent.get("attributes") or {})
        stream_name = str(attrs.get("go2rtc_stream") or "").strip()
        if not frigate_cam.matches_entity(ent) or not stream_name:
            await websocket.close(code=1003, reason="go2rtc unavailable")
            return
        inst = frigate_cam.instance_for(ent)
        if not inst:
            await websocket.close(code=1011, reason="frigate unavailable")
            return
        section = dict(getattr(inst, "entry_data", {}) or {})
        base = inst._base_url()
        verify_tls = bool(inst._build_client_kwargs(section).get("verify"))
        upstream_url = f"{ws_base_url(base)}/api/go2rtc/api/ws?src={quote(stream_name, safe='')}"
        upstream_headers = await frigate_cam.ws_headers(inst, section, base)
        ssl_context = None
        if upstream_url.startswith("wss://") and not verify_tls:
            ssl_context = ssl._create_unverified_context()
    except Exception as exc:
        log.warning("camera go2rtc setup %s failed: %s", entity_id, exc)
        await websocket.close(code=1011, reason="go2rtc setup failed")
        return

    await websocket.accept()
    try:
        async with websockets.connect(
            upstream_url,
            additional_headers=upstream_headers,
            ssl=ssl_context,
            open_timeout=8,
            max_size=None,
        ) as upstream:

            async def _browser_to_frigate() -> None:
                while True:
                    message = await websocket.receive()
                    if message.get("type") == "websocket.disconnect":
                        break
                    if message.get("text") is not None:
                        await upstream.send(message["text"])
                    elif message.get("bytes") is not None:
                        await upstream.send(message["bytes"])

            async def _frigate_to_browser() -> None:
                async for message in upstream:
                    if isinstance(message, bytes):
                        await websocket.send_bytes(message)
                    else:
                        await websocket.send_text(message)

            tasks = [
                asyncio.create_task(_browser_to_frigate()),
                asyncio.create_task(_frigate_to_browser()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                task.result()
    except Exception as exc:
        log.warning("camera go2rtc proxy %s failed: %s", entity_id, exc)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
