"""Snapshot responses for ``camera.*`` and ``image.*`` entities."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx
from fastapi import HTTPException
from fastapi.responses import Response

from components.reolink import camera_proxy as reolink_cam
from components.tapo import camera_proxy as tapo_cam
from core.cameras.attrs import hydrate_stream_attrs, resolve_rtsp_for_entity
from core.cameras.http_fetch import fetch_http
from core.cameras.shared import (
    RTSP_SNAPSHOT_DEADLINE,
    SNAPSHOT_DEADLINE,
    entity_source,
    jpeg_media_type,
    prefer_http_snapshot,
)
from core.http.errors import error_detail

log = logging.getLogger("cameras.snapshot")


async def camera_snapshot_response(ent: dict[str, Any]) -> Response:
    entity_id = str(ent.get("entity_id") or "")
    source = entity_source(ent)
    attrs = hydrate_stream_attrs(ent, dict(ent.get("attributes") or {}))
    if reolink_cam.matches_entity(ent) and attrs.get("reolink_channel") is not None:
        try:
            frame = await asyncio.wait_for(
                reolink_cam.snapshot_bytes(ent, attrs),
                timeout=SNAPSHOT_DEADLINE,
            )
            if not frame or (len(frame) >= 2 and frame[:2] != b"\xff\xd8"):
                raise RuntimeError("Snapshot Reolink nu e JPEG valid")
            return Response(
                content=frame,
                media_type=jpeg_media_type(frame),
                headers={"Cache-Control": "no-store"},
            )
        except asyncio.TimeoutError:
            raise HTTPException(504, error_detail("cameras.snapshot_timeout")) from None
        except Exception as exc:
            log.warning("reolink snapshot %s failed, trying RTSP: %s", entity_id, exc)

    rtsp_url = await resolve_rtsp_for_entity(ent, attrs)
    url = str(attrs.get("snapshot_url") or "").strip()
    if not url and not rtsp_url:
        if tapo_cam.matches_entity(ent):
            raise HTTPException(404, error_detail("cameras.tapo_no_rtsp"))
        raise HTTPException(404, error_detail("cameras.no_snapshot"))
    try:
        if prefer_http_snapshot(ent, attrs, source=source) and url:
            resp = await asyncio.wait_for(fetch_http(ent, url), timeout=SNAPSHOT_DEADLINE)
        elif rtsp_url:
            import core.cctv_capture as cctv_capture

            frame = await asyncio.wait_for(
                asyncio.to_thread(cctv_capture.get_rtsp_frame, rtsp_url, 12.0),
                timeout=RTSP_SNAPSHOT_DEADLINE,
            )
            if not frame:
                raise RuntimeError("ffmpeg nu a returnat cadru")
            return Response(
                content=frame,
                media_type=jpeg_media_type(frame),
                headers={"Cache-Control": "no-store"},
            )
        else:
            resp = await asyncio.wait_for(fetch_http(ent, url), timeout=SNAPSHOT_DEADLINE)
    except asyncio.TimeoutError:
        raise HTTPException(504, error_detail("cameras.snapshot_timeout")) from None
    except Exception as exc:
        if tapo_cam.matches_entity(ent):
            raise HTTPException(
                502,
                error_detail("cameras.tapo_snapshot_failed", {"error": str(exc)}),
            ) from exc
        raise HTTPException(502, error_detail("cameras.snapshot_unavailable", {"error": str(exc)})) from exc
    body = resp.content
    return Response(
        content=body,
        media_type=resp.headers.get("content-type") or jpeg_media_type(body),
        headers={"Cache-Control": "no-store"},
    )


async def image_snapshot_response(ent: dict[str, Any]) -> Response:
    attrs = dict(ent.get("attributes") or {})
    url = str(
        attrs.get("image_url")
        or attrs.get("snapshot_url")
        or attrs.get("entity_picture")
        or attrs.get("url")
        or ""
    ).strip()
    if not url:
        state = str(ent.get("state") or "")
        if state.startswith("http"):
            url = state
    if not url:
        raise HTTPException(404, error_detail("cameras.image_no_url"))
    try:
        resp = await asyncio.wait_for(fetch_http(ent, url), timeout=SNAPSHOT_DEADLINE)
    except asyncio.TimeoutError:
        raise HTTPException(504, error_detail("cameras.image_snapshot_timeout")) from None
    except httpx.HTTPError as exc:
        raise HTTPException(502, error_detail("cameras.image_unavailable", {"error": str(exc)})) from exc
    except Exception as exc:
        raise HTTPException(502, error_detail("cameras.image_unavailable", {"error": str(exc)})) from exc
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "no-store"},
    )
