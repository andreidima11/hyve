"""AI context formatter for Frigate payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_frigate_candidates = _extract_mod.extract_frigate_candidates


def format_frigate_context(
    entities: dict[str, Any],
    *,
    entry_data: dict[str, Any] | None = None,
    base_url: str = "",
) -> str:
    items = extract_frigate_candidates(
        entities,
        entry_data=entry_data,
        base_url=base_url,
    )
    if not items:
        return ""
    return f"Frigate: {len(items)} camere disponibile."
