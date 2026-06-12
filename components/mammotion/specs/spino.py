"""Spino pool robot entity builder."""

from __future__ import annotations

from typing import Any

from components.mammotion.specs.identifiers import base_entity, device_id, slugify_device_name
from components.mammotion.specs.mower import SENSOR_UNITS
from components.mammotion.specs.value import sensor_value_usable


def build_spino_entities(row: dict[str, Any]) -> list[dict[str, Any]]:
    device_name = str(row.get("device_name") or "").strip()
    if not device_name:
        return []
    obj = slugify_device_name(device_name)
    label = device_name
    online = bool(row.get("online", True))
    report_ready = bool(row.get("telemetry_ready", online))
    sensors = row.get("sensors") if isinstance(row.get("sensors"), dict) else {}
    switches = row.get("switches") if isinstance(row.get("switches"), dict) else {}
    did = device_id(device_name)
    out: list[dict[str, Any]] = [
        {
            "entity_id": f"vacuum.{obj}",
            "unique_id": f"mammotion:{device_name}",
            "device_id": did,
            "device_name": label,
            "name": label,
            "friendly_name": label,
            "state": "docked" if online else "unavailable",
            "domain": "vacuum",
            "source": "mammotion",
            "controllable": True,
            "available": online,
            "icon": "fas fa-water",
            "attributes": {"device_id": did, "device_name": device_name, "device_class": "spino"},
        }
    ]
    if not online:
        return out
    for key, val in sensors.items():
        if not sensor_value_usable(key, val, report_ready=report_ready):
            continue
        out.append(
            base_entity(
                device_name=device_name,
                obj=obj,
                label=label,
                domain="sensor",
                key=key,
                state=val,
                controllable=False,
                online=online,
                icon="fas fa-gauge",
                unit=SENSOR_UNITS.get(key, ""),
            )
        )
    for key, val in switches.items():
        if val is None:
            continue
        out.append(
            base_entity(
                device_name=device_name,
                obj=obj,
                label=label,
                domain="switch",
                key=key,
                state="on" if val else "off",
                controllable=True,
                online=online,
                icon="fas fa-toggle-on",
            )
        )
    return out
