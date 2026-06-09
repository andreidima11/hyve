"""AI context formatter for E.ON România payloads."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from integrations.component_import import import_sibling

_component_dir = Path(__file__).resolve().parent
_extract_mod = import_sibling(_component_dir, "extract")
extract_eon_romania_candidates = _extract_mod.extract_eon_romania_candidates


def format_eon_romania_context(entities: dict[str, Any]) -> str:
    items = extract_eon_romania_candidates(entities)
    bills = [
        item
        for item in items
        if "factura_restanta" in item.get("entity_id", "") and str(item.get("state")) == "Da"
    ]
    balances = [
        item
        for item in items
        if "sold_factura" in item.get("entity_id", "") and str(item.get("state")) == "Da"
    ]
    parts = [f"E.ON România: {len(items)} entități"]
    if balances:
        parts.append(f"{len(balances)} contracte cu sold")
    if bills:
        parts.append(f"{len(bills)} contracte cu facturi restante")
    return "; ".join(parts)
