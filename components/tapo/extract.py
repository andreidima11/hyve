"""Tapo/Kasa pre-built entity list passthrough."""

from __future__ import annotations

from typing import Any


def extract_tapo_candidates(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, dict):
        items = payload.get("items")
        if isinstance(items, list):
            return items
    return []
