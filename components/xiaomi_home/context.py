"""AI context formatter for Xiaomi Home payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_xiaomi_home_candidates = _extract_mod.extract_xiaomi_home_candidates


def format_xiaomi_home_context(entities: dict[str, Any]) -> str:
    items = extract_xiaomi_home_candidates(entities)
    if not items:
        return ""
    on = sum(1 for i in items if str(i.get("state")) == "on")
    return f"Xiaomi Home: {len(items)} entități, {on} pornite"
