"""Mower (Luba / Yuka) entity specs and builder."""

from __future__ import annotations

from typing import Any, Callable

from integrations.entity_utils import set_status_attrs

from components.mammotion.snapshot.plans import plan_display_label
from components.mammotion.specs.identifiers import base_entity, device_id
from components.mammotion.specs.row import MowerRow
from components.mammotion.specs.value import number_value_usable, sensor_value_usable
from components.mammotion.status import activity_from_status

SENSOR_UNITS: dict[str, str] = {
    "battery_percent": "%",
    "ble_rssi": "dBm",
    "wifi_rssi": "dBm",
    "mnet_rssi": "dBm",
    "area": "m²",
    "mowing_speed": "m/s",
    "progress": "%",
    "total_time": "min",
    "elapsed_time": "min",
    "left_time": "min",
    "blade_height": "mm",
    "maintenance_distance": "m",
    "maintenance_work_time": "s",
    "blade_used_time": "s",
    "blade_used_warn_time": "s",
    "rtk_latitude": "°",
    "rtk_longitude": "°",
    "spino_battery": "%",
}

SENSOR_ICONS: dict[str, str] = {
    "battery_percent": "fas fa-battery-half",
    "progress": "fas fa-percent",
    "mowing_speed": "fas fa-gauge-high",
    "ble_rssi": "fas fa-signal",
    "wifi_rssi": "fas fa-wifi",
    "mnet_rssi": "fas fa-tower-cell",
}

MOWER_SENSORS_ALL = [
    "battery_percent",
    "ble_rssi",
    "wifi_rssi",
    "mnet_rssi",
    "connect_type",
    "gps_stars",
    "area",
    "mowing_speed",
    "progress",
    "total_time",
    "elapsed_time",
    "left_time",
    "non_work_hours",
    "l1_satellites",
    "l2_satellites",
    "activity_mode",
    "positioning_mode",
    "position_mode",
    "position_type",
    "rtk_latitude",
    "rtk_longitude",
    "work_area",
    "map_sync_status",
    "mqtt_status",
    "blade_height",
    "camera_brightness",
    "visual_positioning_status",
    "maintenance_distance",
    "maintenance_work_time",
    "blade_used_time",
    "blade_used_warn_time",
    "maintenance_bat_cycles",
]

MOWER_SWITCHES: dict[str, Callable[[dict[str, Any], dict[str, Any]], bool]] = {
    "side_led": lambda f, sw: not f.get("is_luba1", False),
    "rain_detection": lambda f, _: True,
    "blade_status": lambda f, _: f.get("is_luba1", False),
    "manual_light": lambda f, _: f.get("is_mini_or_x_series", False),
    "night_light": lambda f, _: f.get("is_mini_or_x_series", False),
    "voice_on_off": lambda f, _: f.get("is_luba_pro", False),
    "is_mow": lambda f, _: f.get("is_yuka", False) and not f.get("is_yuka_mini", False),
    "is_dump": lambda f, _: f.get("is_yuka", False) and not f.get("is_yuka_mini", False),
    "is_edge": lambda f, _: f.get("is_yuka", False) and not f.get("is_yuka_mini", False),
    "rain_tactics": lambda f, _: True,
    "schedule_updates": lambda f, _: True,
    "bluetooth_enabled": lambda f, _: True,
    "cloud_enabled": lambda f, _: True,
}

MOWER_BUTTONS: dict[str, Callable[[dict[str, Any]], bool]] = {
    "start_map_sync": lambda _: True,
    "start_schedule_sync": lambda _: True,
    "resync_rtk_dock": lambda _: True,
    "release_from_dock": lambda _: True,
    "emergency_nudge_forward": lambda _: True,
    "emergency_nudge_left": lambda _: True,
    "emergency_nudge_right": lambda _: True,
    "emergency_nudge_back": lambda _: True,
    "cancel_task": lambda _: True,
    "relocate_charging_station": lambda _: True,
    "restart_mower": lambda f: not f.get("is_luba1", False),
}

MOWER_BUTTON_LABELS: dict[str, str] = {
    "start_map_sync": "Sync hartă",
    "start_schedule_sync": "Sync program",
    "resync_rtk_dock": "Resync RTK dock",
    "release_from_dock": "Eliberează din dock",
    "emergency_nudge_forward": "Nudge înainte",
    "emergency_nudge_left": "Nudge stânga",
    "emergency_nudge_right": "Nudge dreapta",
    "emergency_nudge_back": "Nudge înapoi",
    "cancel_task": "Anulează task",
    "relocate_charging_station": "Mută stația",
    "restart_mower": "Restart robot",
}

MOWER_NUMBERS: dict[str, Callable[[dict[str, Any]], bool]] = {
    "start_progress": lambda _: True,
    "cutting_angle": lambda _: True,
    "toward_included_angle": lambda _: True,
    "dumping_interval": lambda f: f.get("is_yuka", False) and not f.get("is_yuka_mini", False),
    "blade_height": lambda f: not f.get("is_yuka", False),
    "working_speed": lambda _: True,
    "path_spacing": lambda _: True,
    "voice_volume": lambda f: f.get("is_luba_pro", False),
    "map_offset_lat": lambda _: True,
    "map_offset_lon": lambda _: True,
}

MOWER_SELECTS: dict[str, Callable[[dict[str, Any]], bool]] = {
    "channel_mode": lambda _: True,
    "mowing_laps": lambda _: True,
    "obstacle_laps": lambda _: True,
    "border_mode": lambda _: True,
    "cutting_angle_mode": lambda _: True,
    "bypass_mode": lambda _: True,
    "traversal_mode": lambda _: True,
    "turning_mode": lambda _: True,
    "wildlife_safety": lambda _: True,
    "voice_gender": lambda f: f.get("is_luba_pro", False),
    "cutter_mode": lambda f: f.get("is_mini_or_x_series", False),
}


def _sensor_visible(key: str, flags: dict[str, Any]) -> bool:
    if key == "blade_height":
        return flags.get("is_luba1") or flags.get("is_luba_pro") or flags.get("is_yuka")
    if key in {
        "camera_brightness",
        "visual_positioning_status",
        "maintenance_distance",
        "maintenance_work_time",
        "blade_used_time",
        "blade_used_warn_time",
    }:
        return flags.get("is_luba_pro") or flags.get("is_yuka")
    if key == "maintenance_bat_cycles":
        return (flags.get("is_luba_pro") or flags.get("is_yuka")) and not flags.get("is_yuka_mini")
    return True


def build_mower_entities(row: MowerRow) -> list[dict[str, Any]]:
    state, status_key, status_label = activity_from_status(
        sys_status=row.status.get("sys_status"),
        charge_state=row.status.get("charge_state"),
        battery=row.battery,
    )
    if not row.online:
        state = "unavailable"
        status_key = "unavailable"

    attrs: dict[str, Any] = {
        "device_name": row.device_name,
        "device_model": row.model,
        "progress": row.sensors.get("progress"),
        "mowing_speed": row.sensors.get("mowing_speed"),
        "work_area": row.sensors.get("work_area"),
    }
    if row.battery is not None and sensor_value_usable(
        "battery_percent", row.battery, report_ready=row.report_ready
    ):
        attrs["battery_level"] = row.battery
        attrs["battery"] = row.battery
    set_status_attrs(attrs, key=status_key, label=status_label)

    did = device_id(row.device_name)
    attrs.setdefault("device_id", did)
    attrs.setdefault("device_name", row.device_name)
    out: list[dict[str, Any]] = [
        {
            "entity_id": f"lawn_mower.{row.obj}",
            "unique_id": f"mammotion:{row.device_name}",
            "device_id": did,
            "device_name": row.label,
            "name": row.label,
            "friendly_name": row.label,
            "state": state,
            "domain": "lawn_mower",
            "source": "mammotion",
            "controllable": True,
            "available": row.online,
            "icon": "fas fa-leaf",
            "attributes": attrs,
        }
    ]

    if not row.online:
        return out

    lat, lon = row.location.get("latitude"), row.location.get("longitude")
    if lat or lon:
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="device_tracker",
                key="location",
                state="home",
                controllable=False,
                online=row.online,
                icon="fas fa-location-dot",
                extra_attrs={"latitude": lat, "longitude": lon},
            )
        )

    if "charging" in row.binary:
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="binary_sensor",
                key="charging",
                state="on" if row.binary.get("charging") else "off",
                controllable=False,
                online=row.online,
                icon="fas fa-plug",
                extra_attrs={"device_class": "battery_charging"},
            )
        )

    for err_key, err_message in row.device_errors.items():
        if not err_message:
            continue
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="binary_sensor",
                key=f"fault_{err_key}",
                state="on",
                controllable=False,
                online=row.online,
                icon="fas fa-triangle-exclamation",
                extra_attrs={"device_class": "problem", "fault_message": err_message},
            )
        )

    for key in MOWER_SENSORS_ALL:
        if not _sensor_visible(key, row.flags):
            continue
        value = row.sensors.get(key)
        if not sensor_value_usable(key, value, report_ready=row.report_ready):
            continue
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="sensor",
                key=key,
                state=value,
                controllable=False,
                online=row.online,
                icon=SENSOR_ICONS.get(key, "fas fa-gauge"),
                unit=SENSOR_UNITS.get(key, ""),
            )
        )

    fw = row.sensors.get("firmware_version")
    if fw:
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="update",
                key="firmware",
                state=fw,
                controllable=False,
                online=row.online,
                icon="fas fa-download",
                extra_attrs={"installed_version": fw},
            )
        )

    if row.flags.get("supports_video"):
        cam = base_entity(
            device_name=row.device_name,
            obj=row.obj,
            label=row.label,
            domain="camera",
            key="webrtc",
            state="idle",
            controllable=True,
            online=row.online,
            icon="fas fa-video",
            extra_attrs={
                "model_name": row.device_name,
                "stream_type": "agora_webrtc",
                "live_providers": ["agora"],
            },
        )
        caps = cam["attributes"].setdefault("capabilities", {})
        if isinstance(caps, dict):
            caps["stream_type"] = "agora_webrtc"
        out.append(cam)

    for key, pred in MOWER_SWITCHES.items():
        if not pred(row.flags, row.switches):
            continue
        val = row.switches.get(key)
        if val is None and key not in row.switches:
            continue
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="switch",
                key=key,
                state="on" if val else "off",
                controllable=True,
                online=row.online,
                icon="fas fa-toggle-on",
            )
        )

    for area in row.areas:
        if not isinstance(area, dict):
            continue
        area_hash = area.get("hash")
        if area_hash is None:
            continue
        key = f"area_{area_hash}"
        area_name = str(area.get("name") or key)
        out.append(
            {
                **base_entity(
                    device_name=row.device_name,
                    obj=row.obj,
                    label=row.label,
                    domain="switch",
                    key=key,
                    state="on" if area.get("selected") else "off",
                    controllable=True,
                    online=row.online,
                    icon="fas fa-map",
                ),
                "name": f"{row.label} {area_name}",
                "friendly_name": f"{row.label} {area_name}",
                "attributes": {
                    "device_name": row.device_name,
                    "hash": area_hash,
                    "area_name": area_name,
                },
            }
        )

    for key, pred in MOWER_BUTTONS.items():
        if not pred(row.flags):
            continue
        btn_label = MOWER_BUTTON_LABELS.get(key, key.replace("_", " "))
        action_ent = base_entity(
            device_name=row.device_name,
            obj=row.obj,
            label=row.label,
            domain="button",
            key=key,
            state="",
            controllable=True,
            online=row.online,
            icon="fas fa-circle-play",
        )
        action_ent["name"] = f"{row.label} {btn_label}"
        action_ent["friendly_name"] = action_ent["name"]
        action_ent["attributes"]["mammotion_button_kind"] = "action"
        out.append(action_ent)

    for plan_id, plan in row.plans.items():
        if not isinstance(plan, dict):
            continue
        pid = str(plan.get("plan_id") or plan_id)
        schedule_label = plan_display_label(plan, pid)
        key = f"task_{pid}"
        zone_names = plan.get("zone_names") if isinstance(plan.get("zone_names"), list) else []
        task_ent = base_entity(
            device_name=row.device_name,
            obj=row.obj,
            label=row.label,
            domain="button",
            key=key,
            state="",
            controllable=True,
            online=row.online,
            icon="fas fa-calendar-check",
        )
        task_ent["name"] = f"{row.label} {schedule_label}"
        task_ent["friendly_name"] = task_ent["name"]
        task_ent["attributes"].update(
            {
                "task_id": pid,
                "plan_id": pid,
                "enabled": plan.get("enabled"),
                "zone_names": zone_names,
                "mammotion_button_kind": "schedule",
            }
        )
        out.append(task_ent)

    for key, pred in MOWER_NUMBERS.items():
        if not pred(row.flags):
            continue
        val = row.numbers.get(key)
        if not number_value_usable(val):
            continue
        out.append(
            base_entity(
                device_name=row.device_name,
                obj=row.obj,
                label=row.label,
                domain="number",
                key=key,
                state=val,
                controllable=True,
                online=row.online,
                icon="fas fa-sliders",
            )
        )

    from components.mammotion.specs.selects import build_select_capabilities, resolve_select_option

    select_flags = {
        **row.flags,
        "device_firmware": row.status.get("firmware_version") or row.status.get("device_firmware"),
    }
    for key, pred in MOWER_SELECTS.items():
        if not pred(row.flags):
            continue
        option_list, _flat = build_select_capabilities(key, select_flags, row.device_name)
        if not option_list:
            continue
        option = resolve_select_option(key, row.selects.get(key), _flat)
        if option is None:
            continue
        caps: dict[str, Any] = {"options": option_list}
        ent = base_entity(
            device_name=row.device_name,
            obj=row.obj,
            label=row.label,
            domain="select",
            key=key,
            state=option,
            controllable=True,
            online=row.online,
            icon="fas fa-list",
            extra_attrs={"options": option_list},
        )
        ent["attributes"]["capabilities"] = caps
        out.append(ent)

    from components.mammotion.specs.diagnostic import build_diagnostic_entities

    out.extend(build_diagnostic_entities(row, status_key=status_key))
    return out
