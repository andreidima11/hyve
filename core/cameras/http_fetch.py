"""Authenticated or plain HTTP fetch for camera/image snapshots."""

from __future__ import annotations

from typing import Any

import httpx

from components.frigate import camera_proxy as frigate_cam
from core.cameras.shared import TIMEOUT


async def fetch_http(ent: dict[str, Any], url: str) -> httpx.Response:
    if frigate_cam.matches_entity(ent):
        return await frigate_cam.get_http_response(ent, url)
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        return resp
