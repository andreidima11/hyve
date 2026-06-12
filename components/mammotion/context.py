"""LLM context formatting for Mammotion entities."""

from __future__ import annotations

from typing import Any


def format_mammotion_context(entities: dict[str, Any]) -> str:
    items = entities.get("items") if isinstance(entities, dict) else None
    if not isinstance(items, list):
        return ""
    mowers = [i for i in items if isinstance(i, dict) and i.get("domain") == "lawn_mower"]
    if not mowers:
        return ""
    lines = ["Mammotion lawn mowers:"]
    for ent in mowers:
        name = ent.get("friendly_name") or ent.get("name") or ent.get("entity_id")
        state = ent.get("state")
        attrs = ent.get("attributes") if isinstance(ent.get("attributes"), dict) else {}
        status = attrs.get("status") or attrs.get("status_key") or ""
        battery = attrs.get("battery_level") or attrs.get("battery")
        line = f"- {name}: {state}"
        if status:
            line += f" ({status})"
        if battery is not None:
            line += f", battery {battery}%"
        lines.append(line)
    return "\n".join(lines)
