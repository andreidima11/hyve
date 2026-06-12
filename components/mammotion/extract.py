"""Mammotion device snapshots → Hyve entities (delegates to entity_factory)."""

from __future__ import annotations

from components.mammotion.entity_factory import extract_mammotion_entities

# Re-export spec tables for tests / backward compatibility.
from components.mammotion.specs.mower import (  # noqa: F401
    MOWER_BUTTONS,
    MOWER_NUMBERS,
    MOWER_SELECTS,
    MOWER_SENSORS_ALL,
    MOWER_SWITCHES,
    SENSOR_ICONS,
    SENSOR_UNITS,
)

__all__ = [
    "MOWER_BUTTONS",
    "MOWER_NUMBERS",
    "MOWER_SELECTS",
    "MOWER_SENSORS_ALL",
    "MOWER_SWITCHES",
    "SENSOR_ICONS",
    "SENSOR_UNITS",
    "extract_mammotion_entities",
]
