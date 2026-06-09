"""AI context formatter for Midea AC payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_midea_ac_candidates = _extract_mod.extract_midea_ac_candidates


def format_midea_ac_context(entities: dict[str, Any]) -> str:
    items = extract_midea_ac_candidates(entities)
    if not items:
        return ""
    powered = [
        item
        for item in items
        if item.get("entity_id", "").endswith(":power") and str(item.get("state")) == "on"
    ]
    return f"Midea AC: {len(items)} entități, {len(powered)} pornite"
