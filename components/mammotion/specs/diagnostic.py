"""Diagnostic sensors and event entities for Mammotion mowers."""

from __future__ import annotations

from typing import Any

from components.mammotion.specs.identifiers import base_entity, device_id, unique_id
from components.mammotion.specs.row import MowerRow


def build_diagnostic_entities(row: MowerRow, *, status_key: str) -> list[dict[str, Any]]:
    """HA-style diagnostic platform — connectivity, work mode, fault/activity events."""
    if not row.online:
        return []

    out: list[dict[str, Any]] = []
    did = device_id(row.device_name)
    diag_attrs = {"entity_category": "diagnostic", "device_id": did}

    if row.report_ready:
        work_mode = row.status.get("work_mode_name")
        if work_mode:
            out.append(
                base_entity(
                    device_name=row.device_name,
                    obj=row.obj,
                    label=row.label,
                    domain="sensor",
                    key="diagnostic_work_mode",
                    state=work_mode,
                    controllable=False,
                    online=row.online,
                    icon="fas fa-circle-info",
                    extra_attrs=diag_attrs,
                )
            )

        sys_status = row.status.get("sys_status")
        if sys_status is not None:
            out.append(
                base_entity(
                    device_name=row.device_name,
                    obj=row.obj,
                    label=row.label,
                    domain="sensor",
                    key="diagnostic_sys_status",
                    state=int(sys_status),
                    controllable=False,
                    online=row.online,
                    icon="fas fa-microchip",
                    extra_attrs=diag_attrs,
                )
            )

        map_sync = row.sensors.get("map_sync_status")
        if map_sync:
            out.append(
                base_entity(
                    device_name=row.device_name,
                    obj=row.obj,
                    label=row.label,
                    domain="sensor",
                    key="diagnostic_map_sync",
                    state=str(map_sync),
                    controllable=False,
                    online=row.online,
                    icon="fas fa-map",
                    extra_attrs=diag_attrs,
                )
            )

        mqtt_reported = row.sensors.get("mqtt_status") == "reported_online"
        mqtt_ok = mqtt_reported or bool(row.mqtt_connected)
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="binary_sensor",
                key="diagnostic_mqtt_link",
                state="on" if mqtt_ok else "off",
                controllable=False,
                online=row.online,
                icon="fas fa-cloud",
                extra_attrs={**diag_attrs, "device_class": "connectivity"},
            )
        )

        out.append(
            {
                "entity_id": f"event.{row.obj}_activity",
                "unique_id": unique_id(row.device_name, "event", "activity"),
                "device_id": did,
                "device_name": row.label,
                "name": f"{row.label} activity",
                "friendly_name": f"{row.label} activity",
                "state": status_key or "idle",
                "domain": "event",
                "source": "mammotion",
                "controllable": False,
                "available": row.online,
                "icon": "fas fa-bell",
                "attributes": {
                    **diag_attrs,
                    "device_name": row.device_name,
                    "event_types": [
                        "idle",
                        "syncing",
                        "mowing",
                        "paused",
                        "returning",
                        "docked",
                        "error",
                        "unavailable",
                        "mapping",
                        "updating",
                    ],
                },
            }
        )

    if row.device_errors:
        first_key = next(iter(row.device_errors))
        out.append(
            {
                "entity_id": f"event.{row.obj}_fault",
                "unique_id": unique_id(row.device_name, "event", "fault"),
                "device_id": did,
                "device_name": row.label,
                "name": f"{row.label} fault",
                "friendly_name": f"{row.label} fault",
                "state": first_key,
                "domain": "event",
                "source": "mammotion",
                "controllable": False,
                "available": row.online,
                "icon": "fas fa-triangle-exclamation",
                "attributes": {
                    **diag_attrs,
                    "device_name": row.device_name,
                    "event_types": list(row.device_errors.keys()),
                    "fault_messages": dict(row.device_errors),
                    "last_fault": row.device_errors[first_key],
                },
            }
        )
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="sensor",
                key="diagnostic_fault_count",
                state=len(row.device_errors),
                controllable=False,
                online=row.online,
                icon="fas fa-list-check",
                extra_attrs=diag_attrs,
            )
        )

    return out
