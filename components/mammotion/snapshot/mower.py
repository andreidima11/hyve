"""Mower snapshot builder."""

from __future__ import annotations

import math
from typing import Any

from pymammotion.data.model.device import MowerDevice
from pymammotion.utility.constant import VioState
from pymammotion.utility.constant.device_constant import (
    PosType,
    RTKPositionMode,
    WorkMode,
    camera_brightness,
    device_connection,
    device_mode,
)

from components.mammotion.session_bootstrap import device_handle_online, mqtt_transport_connected
from components.mammotion.snapshot.map_data import (
    area_name_from_map,
    iter_map_area_pairs,
    iter_map_plan_items,
    mower_flags,
)
from components.mammotion.status import telemetry_ready


def _safe_enum_name(value: Any) -> str | None:
    name = getattr(value, "name", None)
    return str(name) if name is not None else None


def _format_time_range(start: str, end: str) -> str:
    if not start or not end:
        return "Not set"
    try:
        start_m = int(start)
        end_m = int(end)
    except (TypeError, ValueError):
        return "Not set"
    return f"{start_m // 60:02d}:{start_m % 60:02d} - {end_m // 60:02d}:{end_m % 60:02d}"


def build_mower_snapshot(
    device: MowerDevice,
    *,
    device_name: str,
    coordinator_meta: dict[str, Any] | None = None,
    client: Any | None = None,
) -> dict[str, Any]:
    meta = coordinator_meta or {}
    ms = device.mower_state
    rd = device.report_data
    dev = rd.dev
    work = rd.work
    connect = rd.connect
    maintenance = rd.maintenance
    rtk = rd.rtk
    vision = rd.vision_info
    loc = device.location

    flags = mower_flags(device_name)
    product_key = str(getattr(ms, "product_key", "") or "")
    op_settings = meta.get("operation_settings") if isinstance(meta.get("operation_settings"), dict) else {}

    from components.mammotion.snapshot.plans import plan_snapshot_entry

    plans: dict[str, Any] = {}
    for plan_id, plan in iter_map_plan_items(device):
        entry = plan_snapshot_entry(device, str(plan_id), plan)
        if entry:
            plans[str(plan_id)] = entry

    selected_areas = list(op_settings.get("areas") or [])
    areas: list[dict[str, Any]] = []
    for area_hash, name in iter_map_area_pairs(device):
        areas.append({"hash": area_hash, "name": name, "selected": area_hash in selected_areas})

    sys_status = int(getattr(dev, "sys_status", 0) or 0)
    charge_state = int(getattr(dev, "charge_state", 0) or 0)
    battery_val = getattr(dev, "battery_val", None)
    report_ready = bool(meta.get("telemetry_ready")) or telemetry_ready(
        sys_status=sys_status, battery=battery_val
    )

    return {
        "device_name": device_name,
        "name": device_name,
        "kind": "mower",
        "model": str(getattr(ms, "sub_model_id", "") or product_key),
        "product_key": product_key,
        "online": device_handle_online(client, device_name)
        if client is not None
        else bool(getattr(device, "online", True)),
        "mqtt_connected": mqtt_transport_connected(client, device_name) if client is not None else True,
        "telemetry_ready": report_ready,
        "flags": flags,
        "status": {
            "sys_status": sys_status,
            "charge_state": charge_state,
            "battery": battery_val,
            "work_mode": int(sys_status),
            "work_mode_name": _safe_enum_name(WorkMode(sys_status))
            if sys_status in WorkMode._value2member_map_
            else str(sys_status),
        },
        "sensors": {
            "battery_percent": getattr(dev, "battery_val", None),
            "ble_rssi": getattr(connect, "ble_rssi", None),
            "wifi_rssi": getattr(connect, "wifi_rssi", None),
            "mnet_rssi": getattr(connect, "mnet_rssi", None),
            "connect_type": device_connection(connect) if connect else None,
            "gps_stars": getattr(rtk, "gps_stars", None),
            "area": (int(getattr(work, "area", 0) or 0) & 65535) or None,
            "mowing_speed": (float(getattr(work, "man_run_speed", 0) or 0) / 100.0) if work else None,
            "progress": (int(getattr(work, "area", 0) or 0) >> 16) if work else None,
            "total_time": (int(getattr(work, "progress", 0) or 0) & 65535) if work else None,
            "elapsed_time": (
                (int(getattr(work, "progress", 0) or 0) & 65535)
                - (int(getattr(work, "progress", 0) or 0) >> 16)
            )
            if work
            else None,
            "left_time": (int(getattr(work, "progress", 0) or 0) >> 16) if work else None,
            "non_work_hours": _format_time_range(
                str(getattr(device.non_work_hours, "start_time", "") or ""),
                str(getattr(device.non_work_hours, "end_time", "") or ""),
            ),
            "l1_satellites": (int(getattr(rtk, "co_view_stars", 0) or 0) & 255) if rtk else None,
            "l2_satellites": ((int(getattr(rtk, "co_view_stars", 0) or 0) >> 8) & 255) if rtk else None,
            "activity_mode": device_mode(sys_status) if dev else None,
            "positioning_mode": str(getattr(rtk, "status", "")) if rtk else None,
            "position_mode": RTKPositionMode(int(getattr(rd.basestation_info, "rtk_status", 0) or 0)).name
            if hasattr(rd, "basestation_info")
            else None,
            "position_type": PosType(int(getattr(loc, "position_type", 0) or 0)).name if loc else None,
            "rtk_latitude": (float(getattr(loc.RTK, "latitude", 0) or 0) * 180.0 / math.pi) if loc else None,
            "rtk_longitude": (float(getattr(loc.RTK, "longitude", 0) or 0) * 180.0 / math.pi) if loc else None,
            "blade_height": getattr(work, "knife_height", None) if work else None,
            "camera_brightness": camera_brightness(getattr(vision, "brightness", 0)) if vision else None,
            "visual_positioning_status": VioState(int(getattr(vision, "vio_state", 0) or 0)).name if vision else None,
            "maintenance_distance": getattr(maintenance, "mileage", None),
            "maintenance_work_time": getattr(maintenance, "work_time", None),
            "blade_used_time": getattr(getattr(maintenance, "blade_used_time", None), "blade_used_time", None),
            "blade_used_warn_time": getattr(getattr(maintenance, "blade_used_time", None), "blade_used_warn_time", None),
            "maintenance_bat_cycles": getattr(maintenance, "bat_cycles", None),
            "work_area": area_name_from_map(device, int(getattr(loc, "work_zone", 0) or 0)),
            "map_sync_status": meta.get("map_sync_status", "synced"),
            "mqtt_status": "reported_online" if meta.get("mqtt_online", True) else "reported_offline",
            "firmware_version": getattr(getattr(device, "device_firmwares", None), "device_version", None),
        },
        "binary_sensors": {
            "charging": charge_state != 0 or sys_status in (WorkMode.MODE_CHARGING, WorkMode.MODE_CHARGING_PAUSE),
        },
        "switches": {
            "side_led": int(getattr(ms.side_led, "enable", 1) or 1) == 0 if hasattr(ms, "side_led") else False,
            "rain_detection": bool(getattr(ms, "rain_detection", False)),
            "blade_status": bool(getattr(ms, "blade_status", False)),
            "manual_light": bool(getattr(getattr(ms, "lamp_info", None), "manual_light", False)),
            "night_light": bool(getattr(getattr(ms, "lamp_info", None), "night_light", False)),
            "voice_on_off": int(getattr(getattr(ms, "audio", None), "volume", 0) or 0) > 0,
            "is_mow": bool(op_settings.get("is_mow", True)),
            "is_dump": bool(op_settings.get("is_dump", True)),
            "is_edge": bool(op_settings.get("is_edge", False)),
            "rain_tactics": bool(op_settings.get("rain_tactics", 1)),
            "schedule_updates": bool(getattr(device, "enabled", True)),
            "bluetooth_enabled": bool(meta.get("bluetooth_enabled", True)),
            "cloud_enabled": bool(meta.get("cloud_enabled", True)),
        },
        "numbers": {
            "start_progress": op_settings.get("start_progress"),
            "cutting_angle": op_settings.get("toward"),
            "toward_included_angle": op_settings.get("toward_included_angle"),
            "dumping_interval": op_settings.get("collect_grass_frequency"),
            "blade_height": op_settings.get("blade_height"),
            "working_speed": op_settings.get("speed"),
            "path_spacing": op_settings.get("channel_width"),
            "voice_volume": getattr(getattr(ms, "audio", None), "volume", None),
            "map_offset_lat": meta.get("map_offset_lat"),
            "map_offset_lon": meta.get("map_offset_lon"),
        },
        "selects": {
            "channel_mode": op_settings.get("channel_mode"),
            "mowing_laps": op_settings.get("mowing_laps"),
            "obstacle_laps": op_settings.get("obstacle_laps"),
            "border_mode": op_settings.get("border_mode"),
            "cutting_angle_mode": op_settings.get("toward_mode"),
            "bypass_mode": op_settings.get("ultra_wave"),
            "traversal_mode": getattr(ms, "traversal_mode", None),
            "turning_mode": getattr(ms, "turning_mode", None),
            "wildlife_safety": getattr(getattr(ms, "animal_protection", None), "mode", None),
            "voice_gender": getattr(getattr(ms, "audio", None), "sex", None),
            "cutter_mode": getattr(ms, "cutter_mode", None),
        },
        "location": {
            "latitude": float(getattr(getattr(loc, "device", None), "latitude", 0) or 0),
            "longitude": float(getattr(getattr(loc, "device", None), "longitude", 0) or 0),
        },
        "areas": areas,
        "plans": plans,
        "errors": meta.get("errors") or {},
    }


def minimal_mower_snapshot(device: Any, *, device_name: str) -> dict[str, Any]:
    rd = getattr(device, "report_data", None)
    dev = getattr(rd, "dev", None) if rd is not None else None
    sys_status = int(getattr(dev, "sys_status", 0) or 0) if dev is not None else 0
    charge_state = int(getattr(dev, "charge_state", 0) or 0) if dev is not None else 0
    battery_val = getattr(dev, "battery_val", None) if dev is not None else None
    return {
        "device_name": device_name,
        "name": device_name,
        "kind": "mower",
        "online": bool(getattr(device, "online", True)),
        "telemetry_ready": telemetry_ready(sys_status=sys_status, battery=battery_val),
        "flags": mower_flags(device_name),
        "status": {
            "sys_status": sys_status,
            "charge_state": charge_state,
            "battery": battery_val,
        },
        "sensors": {"battery_percent": getattr(dev, "battery_val", None) if dev is not None else None},
        "switches": {},
        "numbers": {},
        "selects": {},
        "plans": {},
        "areas": [],
        "errors": {},
    }
