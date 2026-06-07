"""Reolink pre-built entity list passthrough + camera stream attr fixes."""

from __future__ import annotations

from typing import Any


def patch_camera_stream_attrs(attrs: dict[str, Any]) -> None:
    """Normalize stored camera attrs for Hyve WebM live (fixes stale sync payloads)."""
    if attrs.get("reolink_channel") is None and attrs.get("device_class") != "camera":
        return
    mjpeg = str(attrs.get("mjpeg_url") or "").strip()
    if mjpeg.lower().startswith("rtsp://"):
        attrs.pop("mjpeg_url", None)
    snap = str(attrs.get("snapshot_url") or "").strip()
    if snap and "cmd=Snap" in snap:
        attrs.pop("snapshot_url", None)
    rtsp = ""
    for key in ("rtsp_url", "stream_url"):
        url = str(attrs.get(key) or "").strip()
        if url.lower().startswith("rtsp://"):
            rtsp = url
            break
    if not rtsp:
        return
    attrs["rtsp_url"] = str(attrs.get("rtsp_url") or rtsp).strip()
    attrs.setdefault("reolink_snapshot", True)
    providers = attrs.get("live_providers")
    if not isinstance(providers, list) or "webm" not in providers:
        attrs["live_providers"] = ["webm", "rtsp", "snapshot"]
    attrs.setdefault("has_audio", True)
    attrs.setdefault("snapshot_refresh", 5)


def extract_reolink_candidates(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    items = payload.get("items")
    if not isinstance(items, list):
        return []
    for item in items:
        if item.get("domain") == "camera":
            patch_camera_stream_attrs(item.setdefault("attributes", {}))
    return items
