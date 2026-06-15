"""Live MJPEG/WebM streaming for camera entities."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import StreamingResponse

from components.frigate import camera_proxy as frigate_cam
from core.cameras.attrs import hydrate_stream_attrs, resolve_rtsp_for_entity
from core.cameras.shared import STREAM_CONNECT_DEADLINE, TIMEOUT, http_stream_url, supports_webm_live
from core.http.errors import error_detail

log = logging.getLogger("cameras.streaming")


async def _iter_generic_http_stream(url: str) -> AsyncIterator[bytes]:
    async with httpx.AsyncClient(timeout=TIMEOUT) as client:
        stream_cm = client.stream("GET", url)
        resp = await asyncio.wait_for(stream_cm.__aenter__(), timeout=STREAM_CONNECT_DEADLINE)
        try:
            resp.raise_for_status()
            async for chunk in resp.aiter_raw(chunk_size=8192):
                if chunk:
                    yield chunk
        finally:
            await stream_cm.__aexit__(None, None, None)


async def _iter_camera_http_stream(ent: dict[str, Any], url: str) -> AsyncIterator[bytes]:
    if frigate_cam.matches_entity(ent):
        async for chunk in frigate_cam.iter_http_stream(ent, url):
            yield chunk
        return
    async for chunk in _iter_generic_http_stream(url):
        yield chunk


async def _iter_rtsp_mjpeg(rtsp_url: str, entity_id: str) -> AsyncIterator[bytes]:
    import core.cctv_capture as cctv_capture

    try:
        async for chunk in cctv_capture.aiter_rtsp_mjpeg(rtsp_url):
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        return
    except Exception as exc:
        log.warning("camera RTSP stream %s failed: %s", entity_id, exc)


async def _iter_rtsp_webm(rtsp_url: str, entity_id: str, *, include_audio: bool) -> AsyncIterator[bytes]:
    import core.cctv_capture as cctv_capture

    try:
        async for chunk in cctv_capture.aiter_rtsp_webm(rtsp_url, include_audio=include_audio):
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        return
    except Exception as exc:
        log.warning("camera RTSP WebM %s failed: %s", entity_id, exc)


async def _iter_http_mjpeg_proxy(ent: dict[str, Any], url: str, entity_id: str) -> AsyncIterator[bytes]:
    try:
        async for chunk in _iter_camera_http_stream(ent, url):
            yield chunk
    except (asyncio.CancelledError, GeneratorExit):
        return
    except asyncio.TimeoutError:
        log.warning("camera stream proxy %s timed out connecting", entity_id)
    except Exception as exc:
        log.warning("camera stream proxy %s failed: %s", entity_id, exc)


async def camera_mjpeg_stream_response(ent: dict[str, Any]) -> StreamingResponse:
    entity_id = str(ent.get("entity_id") or "")
    attrs = hydrate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    url = http_stream_url(attrs)
    rtsp_url = "" if url else await resolve_rtsp_for_entity(ent, attrs)
    if not url and not rtsp_url:
        raise HTTPException(404, error_detail("cameras.no_stream"))

    if rtsp_url:
        return StreamingResponse(
            _iter_rtsp_mjpeg(rtsp_url, entity_id),
            media_type="multipart/x-mixed-replace; boundary=ffmpeg",
        )
    return StreamingResponse(
        _iter_http_mjpeg_proxy(ent, url, entity_id),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


async def camera_webm_stream_response(ent: dict[str, Any]) -> StreamingResponse:
    entity_id = str(ent.get("entity_id") or "")
    attrs = dict(ent.get("attributes") or {})
    if not supports_webm_live(attrs):
        raise HTTPException(404, error_detail("cameras.no_webm_live"))
    rtsp_url = await resolve_rtsp_for_entity(ent, attrs)
    if not rtsp_url:
        raise HTTPException(404, error_detail("cameras.no_rtsp_for_webm"))

    include_audio = attrs.get("has_audio")
    include_audio = True if include_audio is None else bool(include_audio)
    return StreamingResponse(
        _iter_rtsp_webm(rtsp_url, entity_id, include_audio=include_audio),
        media_type="video/webm",
        headers={"Cache-Control": "no-store"},
    )
