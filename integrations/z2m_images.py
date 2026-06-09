"""Zigbee2MQTT device images (proxied for Hyve CSP)."""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.parse import quote

import httpx

log = logging.getLogger("z2m_images")

Z2M_IMAGE_BASE = "https://www.zigbee2mqtt.io/images/devices"
_CACHE: dict[str, tuple[bytes, str]] = {}
_SLUG_RE = re.compile(r"[/\\]+")


def model_image_slug(model: str) -> str:
    """Map Z2M ``definition.model`` to the filename stem on zigbee2mqtt.io."""
    raw = str(model or "").strip()
    if not raw:
        return ""
    return _SLUG_RE.sub("-", raw)


def proxy_image_url(model: str) -> str:
    """Same-origin URL served by :func:`fetch_device_image_bytes`."""
    slug = model_image_slug(model)
    if not slug:
        return ""
    return f"/api/integrations/device-image?model={quote(slug, safe='')}"


def attach_device_images(devices: list[dict[str, Any]], *, slug: str = "") -> list[dict[str, Any]]:
    """Add ``image_url`` to grouped device dicts when a Z2M model is known."""
    key = str(slug or "").strip().lower()
    if key not in {"mosquitto", "zigbee2mqtt"}:
        return devices
    for dev in devices:
        model = str(dev.get("model") or "").strip()
        if model:
            dev["image_url"] = proxy_image_url(model)
    return devices


def _candidate_urls(slug: str) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()

    def _add(stem: str) -> None:
        stem = str(stem or "").strip()
        if not stem or stem in seen:
            return
        seen.add(stem)
        out.append(f"{Z2M_IMAGE_BASE}/{stem}.png")

    _add(slug)
    if "/" in slug or "\\" in slug:
        _add(model_image_slug(slug))
    return out


async def fetch_device_image_bytes(model: str) -> tuple[bytes, str] | None:
    """Download a device image from zigbee2mqtt.io (in-memory cache)."""
    slug = model_image_slug(model)
    if not slug:
        return None
    cached = _CACHE.get(slug)
    if cached:
        return cached

    timeout = httpx.Timeout(12.0, connect=5.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        for url in _candidate_urls(slug):
            try:
                res = await client.get(url)
            except Exception as exc:
                log.debug("Z2M image fetch failed %s: %s", url, exc)
                continue
            if res.status_code != 200:
                continue
            content_type = (res.headers.get("content-type") or "image/png").split(";")[0].strip()
            if not content_type.startswith("image/"):
                continue
            body = bytes(res.content)
            if not body:
                continue
            item = (body, content_type)
            _CACHE[slug] = item
            return item
    return None
