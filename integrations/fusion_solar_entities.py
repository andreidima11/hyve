"""Legacy import path — see components/fusion_solar/extract.py."""

from __future__ import annotations

from integrations.component_import import import_sibling
from integrations.component_paths import BUNDLED_COMPONENTS_DIR

_mod = import_sibling(BUNDLED_COMPONENTS_DIR / "fusion_solar", "extract")

extract_fusion_solar_candidates = _mod.extract_fusion_solar_candidates
device_kpi_schema = _mod.device_kpi_schema
DEV_STRING_INVERTER = _mod.DEV_STRING_INVERTER
DEV_EMI = _mod.DEV_EMI
DEV_GRID_METER = _mod.DEV_GRID_METER
DEV_RESIDENTIAL_INVERTER = _mod.DEV_RESIDENTIAL_INVERTER
DEV_BATTERY = _mod.DEV_BATTERY
DEV_C_I_ESS = _mod.DEV_C_I_ESS
DEV_POWER_SENSOR = _mod.DEV_POWER_SENSOR
_append_sensor = _mod._append_sensor
_api_has_value = _mod._api_has_value
_fusion_attrs = _mod._fusion_attrs
_safe_float = _mod._safe_float
_slugify = _mod._slugify

__all__ = [
    "extract_fusion_solar_candidates",
    "device_kpi_schema",
    "DEV_STRING_INVERTER",
    "DEV_EMI",
    "DEV_GRID_METER",
    "DEV_RESIDENTIAL_INVERTER",
    "DEV_BATTERY",
    "DEV_C_I_ESS",
    "DEV_POWER_SENSOR",
    "_append_sensor",
    "_api_has_value",
    "_fusion_attrs",
    "_safe_float",
    "_slugify",
]
