"""Build Hyve entities from Mammotion device snapshots (HA-style entity factory)."""

from __future__ import annotations

from typing import Any

from components.mammotion.specs.mower import build_mower_entities
from components.mammotion.specs.row import MowerRow
from components.mammotion.specs.rtk import build_rtk_entities
from components.mammotion.specs.spino import build_spino_entities


def build_entities_from_payload(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    devices = payload.get("devices") or []
    if not isinstance(devices, list):
        return []

    out: list[dict[str, Any]] = []
    for row in devices:
        if not isinstance(row, dict):
            continue
        kind = str(row.get("kind") or "mower")
        if kind == "spino":
            out.extend(build_spino_entities(row))
        elif kind == "rtk":
            out.extend(build_rtk_entities(row))
        else:
            ctx = MowerRow.from_snapshot(row)
            if ctx is not None:
                out.extend(build_mower_entities(ctx))
    return out


def extract_mammotion_entities(payload: Any) -> list[dict[str, Any]]:
    """Backward-compatible alias used by entity store and tests."""
    return build_entities_from_payload(payload)
