"""AI context formatter for Rețele Electrice payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_reteleelectrice_candidates = _extract_mod.extract_reteleelectrice_candidates


def format_reteleelectrice_context(entities: dict[str, Any]) -> str:
    items = extract_reteleelectrice_candidates(entities)
    outages = [
        i
        for i in items
        if "intreruperi" in i.get("entity_id", "") and str(i.get("state", "")).lower() == "on"
    ]
    parts = [f"Rețele Electrice: {len(items)} entități"]
    if outages:
        parts.append(f"{len(outages)} POD cu întrerupere activă")
    return "; ".join(parts)
