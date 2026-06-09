"""AI context formatter for Tapo payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_tapo_candidates = _extract_mod.extract_tapo_candidates


def format_tapo_context(entities: dict[str, Any]) -> str:
    items = extract_tapo_candidates(entities)
    if not items:
        return ""
    on = sum(1 for i in items if str(i.get("state")).lower() == "on")
    cams = sum(1 for i in items if i.get("domain") == "camera")
    return f"Tapo: {len(items)} entități, {cams} camere, {on} active."
