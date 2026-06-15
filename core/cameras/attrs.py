"""Vendor-aware camera attribute hydration and RTSP resolution."""

from __future__ import annotations

from typing import Any

from components.frigate import camera_proxy as frigate_cam
from components.tapo import camera_proxy as tapo_cam
from core.cameras.shared import resolve_rtsp_url


def hydrate_stream_attrs(ent: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    if frigate_cam.matches_entity(ent):
        return frigate_cam.hydrate_stream_attrs(ent, attrs)
    return attrs


async def resolve_rtsp_for_entity(ent: dict[str, Any], attrs: dict[str, Any]) -> str:
    if tapo_cam.matches_entity(ent):
        return await tapo_cam.resolve_rtsp_url(ent, attrs)
    return resolve_rtsp_url(attrs)
