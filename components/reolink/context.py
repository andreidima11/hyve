"""AI context formatter for Reolink payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_reolink_candidates = _extract_mod.extract_reolink_candidates


def format_reolink_context(entities: dict[str, Any]) -> str:
    items = extract_reolink_candidates(entities)
    if not items:
        return ""
    cams = sum(1 for i in items if i.get("domain") == "camera")
    motion = sum(
        1
        for i in items
        if i.get("domain") == "binary_sensor" and str(i.get("state")) == "on"
    )
    return f"Reolink: {len(items)} entități, {cams} camere, {motion} senzori activi."
