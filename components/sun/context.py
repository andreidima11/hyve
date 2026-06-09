"""AI context formatter for Sun payloads."""

from __future__ import annotations

from typing import Any


def format_sun_context(entities: dict[str, Any]) -> str:
    if not isinstance(entities, dict):
        return ""
    elev = entities.get("elevation")
    if elev is None:
        return ""
    return (
        f"Sun elevation {elev}°, next sunrise {entities.get('next_rising')}, "
        f"next sunset {entities.get('next_setting')}."
    )
