"""Camera capability payloads for the UI."""

from __future__ import annotations

from typing import Any

from components.frigate import camera_proxy as frigate_cam
from core.cameras.shared import entity_source


def camera_capabilities_payload(ent: dict[str, Any], attrs: dict[str, Any]) -> dict[str, Any]:
    source = entity_source(ent)
    payload = {
        "entity_id": ent.get("entity_id") or "",
        "source": source,
        "has_audio": bool(attrs.get("has_audio")),
        "two_way_audio": bool(attrs.get("two_way_audio")),
        "go2rtc_available": False,
        "go2rtc_stream": "",
        "microphone_mutable": bool(attrs.get("microphone_mutable")),
        "speaker_volume_mutable": bool(
            attrs.get("speaker_volume_mutable") or attrs.get("volume_speak") is not None or source == "reolink"
        ),
        "speaker_volume": attrs.get("speaker_volume"),
        "two_way_audio_capable": bool(attrs.get("two_way_audio")),
        "supports_talk": False,
        "talk_methods": [],
    }
    if frigate_cam.matches_entity(ent):
        return frigate_cam.enrich_capabilities(payload, attrs)
    return payload
