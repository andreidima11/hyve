"""Tapo camera proxy helpers (RTSP resolve, audio controls)."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

log = logging.getLogger("tapo.camera")


def matches_entity(ent: dict[str, Any]) -> bool:
    return str(ent.get("source") or "").strip().lower() == "tapo"


async def device_for_entity(ent: dict[str, Any]) -> tuple[Any, Any]:
    from core.http.errors import error_detail
    from integrations import get_integration_manager

    entry_id = str(ent.get("entry_id") or "").strip()
    manager = get_integration_manager()
    integration = manager.get_by_entry(entry_id) if entry_id else manager.get("tapo")
    if not integration or getattr(integration, "slug", "") != "tapo":
        raise HTTPException(404, error_detail("cameras.tapo_unavailable"))
    attrs = ent.get("attributes") or {}
    dev = await integration._connect()
    target = integration._find_device(dev, attrs.get("tapo_device_key"))
    if target is None:
        raise HTTPException(404, error_detail("cameras.tapo_device_not_found"))
    return integration, target


async def resolve_rtsp_url(ent: dict[str, Any], attrs: dict[str, Any]) -> str:
    from core.cameras.shared import resolve_rtsp_url as rtsp_from_attrs

    if not matches_entity(ent):
        return rtsp_from_attrs(attrs)
    try:
        integration, target = await device_for_entity(ent)
        section = dict(getattr(integration, "entry_data", {}) or {})
        url = integration._rtsp_url(target, section=section)
        if url:
            return url
    except HTTPException:
        raise
    except Exception as exc:
        log.warning("tapo RTSP resolve for %s failed: %s", ent.get("entity_id"), exc)
    return rtsp_from_attrs(attrs)


async def apply_audio(target: Any, body: Any) -> None:
    from core.http.errors import error_detail

    action = (body.action or "").strip().lower()
    if action == "set_speaker_muted":
        if body.enabled is None:
            raise HTTPException(400, error_detail("cameras.field_enabled_required"))
        volume = 0 if body.enabled else 50
        await target._raw_query({"method": "set", "audio_config": {"speaker": {"volume": volume}}})
        return
    if action == "set_microphone_muted":
        if body.enabled is None:
            raise HTTPException(400, error_detail("cameras.field_enabled_required"))
        await target._raw_query({
            "method": "set",
            "audio_config": {"microphone": {"mute": "on" if body.enabled else "off"}},
        })
        return
    if action == "set_speaker_volume":
        if body.volume is None:
            raise HTTPException(400, error_detail("cameras.field_volume_required"))
        await target._raw_query({
            "method": "set",
            "audio_config": {"speaker": {"volume": int(body.volume)}},
        })
        return
    raise HTTPException(400, error_detail("cameras.tapo_audio_action_unknown", {"action": action}))
