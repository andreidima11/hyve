"""Read integration settings from config entries (sole source of truth)."""

from __future__ import annotations

import json
from typing import Any

from integrations import config_entries

SEARXNG_DEFAULTS: dict[str, Any] = {
    "fetch_pages": True,
    "max_pages_to_fetch": 2,
    "max_search_results": 5,
    "search_timeout": 10,
    "max_searches_per_request": 5,
    "read_page_max_chars": 6000,
    "max_read_pages_per_request": 5,
}


def list_enabled_entries(slug: str) -> list[dict[str, Any]]:
    key = str(slug or "").strip()
    if not key:
        return []
    return [row for row in config_entries.list_entries(key) if row.get("enabled")]


def primary_entry(slug: str) -> dict[str, Any] | None:
    rows = list_enabled_entries(slug)
    return rows[0] if rows else None


def entry_data(slug: str) -> dict[str, Any]:
    row = primary_entry(slug)
    if not row:
        return {}
    data = row.get("data")
    return dict(data) if isinstance(data, dict) else {}


def is_active(slug: str) -> bool:
    return primary_entry(slug) is not None


def searxng_settings() -> dict[str, Any]:
    if not is_active("searxng"):
        return {}
    data = entry_data("searxng")
    url = str(data.get("url") or "").strip()
    if not url:
        return {}
    merged = {**SEARXNG_DEFAULTS, **data, "url": url, "enabled": True}
    return merged


def waha_settings() -> dict[str, Any]:
    if not is_active("waha"):
        return {}
    data = entry_data("waha")
    return {
        "enabled": True,
        "api_url": str(data.get("api_url") or "").strip(),
        "api_key": str(data.get("api_key") or "").strip(),
        "username": str(data.get("username") or "").strip(),
        "password": str(data.get("password") or ""),
        "session": str(data.get("session") or "default").strip() or "default",
    }


def comfyui_settings() -> dict[str, Any]:
    if not is_active("comfyui"):
        return {}
    data = entry_data("comfyui")
    url = str(data.get("url") or "").strip()
    if not url:
        return {}
    return {**data, "url": url, "enabled": True}


def whisper_settings() -> dict[str, Any]:
    if not is_active("whisper"):
        return {}
    data = entry_data("whisper")
    return {
        "enabled": True,
        "host": str(data.get("host") or "localhost").strip() or "localhost",
        "port": int(data.get("port") or 10300),
        "language": str(data.get("language") or "ro").strip() or "ro",
        "vad_silence_ms": int(data.get("vad_silence_ms") or 2500),
        "vad_sensitivity": str(data.get("vad_sensitivity") or "medium").strip() or "medium",
    }


def piper_settings() -> dict[str, Any]:
    if not is_active("piper"):
        return {}
    data = entry_data("piper")
    return {
        "enabled": True,
        "host": str(data.get("host") or "localhost").strip() or "localhost",
        "port": int(data.get("port") or 10200),
        "voice": str(data.get("voice") or "ro_RO-mihai-medium").strip() or "ro_RO-mihai-medium",
        "speaker_id": int(data.get("speaker_id") or 0),
        "length_scale": str(data.get("length_scale") or "1.0").strip() or "1.0",
    }


def _parse_cctv_cameras(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, list):
        rows = raw
    elif isinstance(raw, str) and raw.strip():
        try:
            rows = json.loads(raw)
        except json.JSONDecodeError:
            return []
    else:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cam_id = str(row.get("id") or "").strip()
        name = str(row.get("name") or "").strip()
        rtsp = str(row.get("rtsp_url") or row.get("url") or "").strip()
        if not cam_id and not rtsp:
            continue
        item = {
            "id": cam_id or name or rtsp,
            "name": name or cam_id or "Camera",
            "rtsp_url": rtsp,
        }
        ctx = str(row.get("context") or "").strip()
        if ctx:
            item["context"] = ctx
        out.append(item)
    return out


def cctv_cameras() -> list[dict[str, Any]]:
    if not is_active("cctv"):
        return []
    return _parse_cctv_cameras(entry_data("cctv").get("cameras"))
