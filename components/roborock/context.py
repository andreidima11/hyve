"""AI context formatter for Roborock payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_roborock_candidates = _extract_mod.extract_roborock_candidates


def format_roborock_context(entities: dict[str, Any]) -> str:
    devices = (entities or {}).get("devices") if isinstance(entities, dict) else None
    if not isinstance(devices, list) or not devices:
        items = extract_roborock_candidates(entities)
        vacuums = [i for i in items if i.get("domain") == "vacuum"]
        if not vacuums:
            return ""
        cleaning = sum(1 for i in vacuums if str(i.get("state")) == "cleaning")
        return f"Roborock: {len(vacuums)} aspirator(e), {cleaning} în curățare"

    local = sum(1 for d in devices if d.get("transport") == "local")
    cloud = sum(1 for d in devices if d.get("transport") == "cloud")
    offline = sum(1 for d in devices if d.get("transport") == "offline" or not d.get("online"))
    parts = [f"{len(devices)} dispozitiv(e)"]
    if local:
        parts.append(f"{local} local")
    if cloud:
        parts.append(f"{cloud} cloud")
    if offline:
        parts.append(f"{offline} offline")
    return "Roborock: " + ", ".join(parts)
