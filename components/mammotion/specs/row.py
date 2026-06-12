"""Parsed mower snapshot row for entity builders."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from components.mammotion.specs.identifiers import slugify_device_name
from components.mammotion.status import telemetry_ready


@dataclass
class MowerRow:
    device_name: str
    obj: str
    label: str
    online: bool
    report_ready: bool
    flags: dict[str, Any] = field(default_factory=dict)
    status: dict[str, Any] = field(default_factory=dict)
    sensors: dict[str, Any] = field(default_factory=dict)
    switches: dict[str, Any] = field(default_factory=dict)
    numbers: dict[str, Any] = field(default_factory=dict)
    selects: dict[str, Any] = field(default_factory=dict)
    binary: dict[str, Any] = field(default_factory=dict)
    location: dict[str, Any] = field(default_factory=dict)
    areas: list[Any] = field(default_factory=list)
    plans: dict[str, Any] = field(default_factory=dict)
    battery: Any = None
    model: str = ""
    device_errors: dict[str, str] = field(default_factory=dict)
    mqtt_connected: bool = True

    @classmethod
    def from_snapshot(cls, row: dict[str, Any]) -> MowerRow | None:
        device_name = str(row.get("device_name") or "").strip()
        if not device_name:
            return None
        flags = row.get("flags") if isinstance(row.get("flags"), dict) else {}
        status = row.get("status") if isinstance(row.get("status"), dict) else {}
        sensors = row.get("sensors") if isinstance(row.get("sensors"), dict) else {}
        if sensors.get("battery_percent") is None and status.get("battery") is not None:
            sensors = {**sensors, "battery_percent": status.get("battery")}
        battery = sensors.get("battery_percent") or status.get("battery")
        report_ready = bool(row.get("telemetry_ready"))
        if not report_ready:
            report_ready = telemetry_ready(sys_status=status.get("sys_status"), battery=battery)
        return cls(
            device_name=device_name,
            obj=slugify_device_name(device_name),
            label=str(row.get("name") or device_name).strip(),
            online=bool(row.get("online", True)),
            report_ready=report_ready,
            flags=flags,
            status=status,
            sensors=sensors,
            switches=row.get("switches") if isinstance(row.get("switches"), dict) else {},
            numbers=row.get("numbers") if isinstance(row.get("numbers"), dict) else {},
            selects=row.get("selects") if isinstance(row.get("selects"), dict) else {},
            binary=row.get("binary_sensors") if isinstance(row.get("binary_sensors"), dict) else {},
            location=row.get("location") if isinstance(row.get("location"), dict) else {},
            areas=list(row.get("areas") or []),
            plans=row.get("plans") if isinstance(row.get("plans"), dict) else {},
            battery=battery,
            model=str(row.get("model") or ""),
            device_errors=row.get("errors") if isinstance(row.get("errors"), dict) else {},
            mqtt_connected=bool(row.get("mqtt_connected", True)),
        )
