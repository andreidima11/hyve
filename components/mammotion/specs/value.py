"""Value gating — expose entities only when telemetry has real data."""

from __future__ import annotations

from typing import Any

# Numeric sensors that read 0 before the first MQTT report.
SENSORS_ZERO_MEANS_EMPTY = frozenset(
    {
        "battery_percent",
        "ble_rssi",
        "wifi_rssi",
        "mnet_rssi",
        "gps_stars",
        "area",
        "progress",
        "mowing_speed",
        "total_time",
        "elapsed_time",
        "left_time",
        "l1_satellites",
        "l2_satellites",
        "blade_height",
        "maintenance_distance",
        "maintenance_work_time",
        "blade_used_time",
        "blade_used_warn_time",
        "maintenance_bat_cycles",
        "rtk_latitude",
        "rtk_longitude",
    }
)


def sensor_value_usable(key: str, value: Any, *, report_ready: bool) -> bool:
    if value is None or value == "":
        return False
    if isinstance(value, str) and value.strip().lower() in {"unknown", "none", "not set"}:
        return False
    if not report_ready and key in SENSORS_ZERO_MEANS_EMPTY:
        if isinstance(value, (int, float)) and value == 0:
            return False
    return True


def number_value_usable(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, (int, float)) and value == 0:
        return False
    return True
