"""Shared camera streaming constants and attribute helpers."""

from __future__ import annotations

from typing import Any

import httpx

TIMEOUT = httpx.Timeout(connect=3.0, read=5.0, write=3.0, pool=3.0)
SNAPSHOT_DEADLINE = 6.0
RTSP_SNAPSHOT_DEADLINE = 14.0
STREAM_CONNECT_DEADLINE = 6.0


def entity_source(ent: dict[str, Any]) -> str:
    return str(ent.get("source") or "").strip().lower()


def jpeg_media_type(data: bytes) -> str:
    if len(data) >= 3 and data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if len(data) >= 8 and data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    return "application/octet-stream"


def resolve_rtsp_url(attrs: dict[str, Any]) -> str:
    for key in ("rtsp_url", "stream_url"):
        url = str(attrs.get(key) or "").strip()
        if url.lower().startswith("rtsp://"):
            return url
    return ""


def http_stream_url(attrs: dict[str, Any]) -> str:
    for key in ("mjpeg_url", "stream_url"):
        url = str(attrs.get(key) or "").strip()
        if url.lower().startswith(("http://", "https://")):
            return url
    return ""


def supports_webm_live(attrs: dict[str, Any]) -> bool:
    providers = attrs.get("live_providers")
    if isinstance(providers, list):
        return "webm" in providers
    return bool(resolve_rtsp_url(attrs))


def prefer_http_snapshot(ent: dict[str, Any], attrs: dict[str, Any], *, source: str) -> bool:
    if source == "frigate":
        return bool(str(attrs.get("snapshot_url") or "").strip())
    providers = attrs.get("live_providers")
    if isinstance(providers, list) and "mjpeg" in providers and "webm" not in providers:
        return bool(str(attrs.get("snapshot_url") or "").strip())
    snapshot_url = str(attrs.get("snapshot_url") or "").strip().lower()
    return snapshot_url.startswith(("http://", "https://"))


def ws_base_url(base: str) -> str:
    if base.startswith("https://"):
        return "wss://" + base[len("https://") :]
    if base.startswith("http://"):
        return "ws://" + base[len("http://") :]
    return base
