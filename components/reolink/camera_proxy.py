"""Reolink camera proxy helpers (snapshot, audio controls)."""

from __future__ import annotations

from typing import Any

from fastapi import HTTPException


def matches_entity(ent: dict[str, Any]) -> bool:
    return str(ent.get("source") or "").strip().lower() == "reolink"


def instance_for(ent: dict[str, Any]) -> Any | None:
    try:
        from integrations import get_integration_manager

        manager = get_integration_manager()
        entry_id = str(ent.get("entry_id") or "").strip()
        return manager.get_by_entry(entry_id) if entry_id else manager.get("reolink")
    except Exception:
        return None


async def snapshot_bytes(ent: dict[str, Any], attrs: dict[str, Any]) -> bytes:
    inst = instance_for(ent)
    if not inst:
        raise RuntimeError("Integrarea Reolink nu este disponibilă pentru această cameră.")
    api = await inst._connect()
    ch = int(attrs["reolink_channel"])
    stream = str(attrs.get("reolink_stream") or "sub")
    data = await api.get_snapshot(ch, stream)
    if not data:
        raise RuntimeError("Snapshot Reolink gol")
    return data


async def apply_audio(ent: dict[str, Any], attrs: dict[str, Any], body: Any) -> None:
    from core.http.errors import error_detail

    inst = instance_for(ent)
    if not inst:
        raise HTTPException(404, error_detail("cameras.reolink_unavailable"))
    api = await inst._connect()
    ch = attrs.get("reolink_channel")
    if ch is None:
        raise HTTPException(400, error_detail("cameras.reolink_channel_missing"))
    channel = int(ch)
    action = (body.action or "").strip().lower()
    if action == "set_speaker_volume":
        if body.volume is None:
            raise HTTPException(400, error_detail("cameras.field_volume_required"))
        await api.set_volume(channel, volume_speak=int(body.volume))
        return
    if action == "set_microphone_muted":
        if body.enabled is None:
            raise HTTPException(400, error_detail("cameras.field_enabled_required"))
        await api.set_audio(channel, enable=not body.enabled)
        return
    if action == "set_speaker_muted":
        if body.enabled is None:
            raise HTTPException(400, error_detail("cameras.field_enabled_required"))
        if body.enabled:
            await api.set_volume(channel, volume_speak=0)
        return
    raise HTTPException(400, error_detail("cameras.reolink_audio_action_unknown", {"action": action}))
