"""RTK base station entity builder."""

from __future__ import annotations

from typing import Any

from components.mammotion.specs.identifiers import base_entity, slugify_device_name
from components.mammotion.specs.mower import SENSOR_UNITS
from components.mammotion.specs.value import sensor_value_usable


def build_rtk_entities(row: dict[str, Any]) -> list[dict[str, Any]]:
    device_name = str(row.get("device_name") or "").strip()
    if not device_name:
        return []
    obj = slugify_device_name(device_name)
    sensors = row.get("sensors") if isinstance(row.get("sensors"), dict) else {}
    report_ready = bool(row.get("telemetry_ready", True))
    online = bool(row.get("online", True))
    out: list[dict[str, Any]] = []
    for key, val in sensors.items():
        if not sensor_value_usable(key, val, report_ready=report_ready):
            continue
        out.append(
            base_entity(
                device_name=device_name,
                obj=obj,
                label=device_name,
                domain="sensor",
                key=key,
                state=val,
                controllable=False,
                online=online,
                icon="fas fa-satellite-dish",
                unit=SENSOR_UNITS.get(key, ""),
            )
        )
    return out
