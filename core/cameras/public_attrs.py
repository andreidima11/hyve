"""Strip sensitive camera URLs/credentials before entities reach the browser."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

# Never expose to dashboard / WS / entity detail JSON.
_CLIENT_STRIP_ATTR_KEYS = frozenset({
    "rtsp_url",
    "stream_url",
    "mjpeg_url",
    "snapshot_url",
    "webrtc_url",
    "frigate_url",
})


def _url_has_embedded_credentials(url: str) -> bool:
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    return bool(parsed.username or parsed.password)


def sanitize_camera_attributes(attrs: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(attrs, dict):
        return {}
    out = dict(attrs)
    for key in _CLIENT_STRIP_ATTR_KEYS:
        out.pop(key, None)
    for key in ("stream_url", "rtsp_url"):
        raw = str(out.get(key) or "").strip()
        if raw and (_url_has_embedded_credentials(raw) or raw.lower().startswith("rtsp://")):
            out.pop(key, None)
    return out


def sanitize_entity_for_client(entity: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(entity, dict):
        return {}
    out = dict(entity)
    attrs = out.get("attributes")
    if isinstance(attrs, dict):
        out["attributes"] = sanitize_camera_attributes(attrs)
    return out


def sanitize_entities_for_client(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [sanitize_entity_for_client(item) for item in entities if isinstance(item, dict)]
