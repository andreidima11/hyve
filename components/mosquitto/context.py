"""AI context formatter for Mosquitto MQTT payloads."""

from __future__ import annotations

from typing import Any


def format_mosquitto_context(entities: dict[str, Any]) -> str:
    if not isinstance(entities, dict):
        return ""
    devices = entities.get("z2m_devices") or []
    names = [
        d.get("friendly_name")
        for d in devices
        if isinstance(d, dict) and d.get("type") != "Coordinator"
    ]
    names = [n for n in names if n]
    disc_count = len(entities.get("discovery") or {})
    if not names and not disc_count:
        return ""
    bits = []
    if names:
        preview = ", ".join(names[:8])
        more = f" (+{len(names) - 8})" if len(names) > 8 else ""
        bits.append(f"{len(names)} dispozitive Zigbee ({preview}{more})")
    if disc_count:
        bits.append(f"{disc_count} entități MQTT-Discovery")
    return "Mosquitto MQTT: " + "; ".join(bits) + "."
