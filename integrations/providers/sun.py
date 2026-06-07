"""Legacy import path — implementation lives in components/sun/."""

from __future__ import annotations

from integrations.component_import import import_sibling
from integrations.component_loader import get_component_entity_class
from integrations.component_paths import BUNDLED_COMPONENTS_DIR

SunEntity = get_component_entity_class("sun")
if SunEntity is None:
    raise ImportError("sun component failed to load from components/sun/")

_sun_dir = BUNDLED_COMPONENTS_DIR / "sun"
_calc = import_sibling(_sun_dir, "calculator")
_entity = import_sibling(_sun_dir, "entity")

# Backward-compatible names for automations and internal callers
_julian_day = _calc.julian_day
_solar_position = _calc.solar_position
_find_next_event = _calc.find_next_event
_find_next_extremum = _calc.find_next_extremum
ensure_default_entry = _entity.ensure_default_entry

__all__ = [
    "SunEntity",
    "ensure_default_entry",
    "_julian_day",
    "_solar_position",
    "_find_next_event",
    "_find_next_extremum",
]
