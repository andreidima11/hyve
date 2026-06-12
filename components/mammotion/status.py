"""Mammotion status helpers without PyMammotion imports (safe at component load)."""

from __future__ import annotations


def telemetry_ready(
    *,
    sys_status: int | None,
    battery: int | None,
    charge_state: int | None = None,
) -> bool:
    """True when MQTT report stream has delivered real device telemetry."""
    mode = int(sys_status or 0)
    bat = int(battery if battery is not None else 0)
    charge = int(charge_state if charge_state is not None else 0)
    if mode != 0 or bat != 0 or charge != 0:
        return True
    return False


def activity_from_status(
    *,
    sys_status: int | None,
    charge_state: int | None,
    battery: int | None = None,
) -> tuple[str, str, str]:
    """Map Mammotion WorkMode + charge_state to Hyve lawn_mower state."""
    mode = int(sys_status or 0)
    charge = int(charge_state or 0)
    bat = int(battery if battery is not None else -1)

    MODE_NOT_ACTIVE = 0
    MODE_ONLINE = 1
    MODE_OFFLINE = 2
    MODE_DISABLE = 8
    MODE_INITIALIZATION = 10
    MODE_READY = 11
    MODE_WORKING = 13
    MODE_RETURNING = 14
    MODE_CHARGING = 15
    MODE_UPDATING = 16
    MODE_LOCK = 17
    MODE_PAUSE = 19
    MODE_MANUAL_MOWING = 20
    MODE_JOB_DRAW = 31
    MODE_OBSTACLE_DRAW = 32
    MODE_CHANNEL_DRAW = 34
    MODE_ERASER_DRAW = 35
    MODE_EDIT_BOUNDARY = 36
    MODE_LOCATION_ERROR = 37
    MODE_BOUNDARY_JUMP = 38
    MODE_CHARGING_PAUSE = 39

    if not telemetry_ready(sys_status=mode, battery=bat if bat >= 0 else 0):
        return "idle", "syncing", "Syncing"

    if mode in (MODE_WORKING, MODE_MANUAL_MOWING):
        return "mowing", "mowing", "Mowing"
    if mode == MODE_RETURNING:
        return "returning", "returning", "Returning to dock"
    if mode == MODE_PAUSE or (mode == MODE_READY and charge == 0):
        return "paused", "paused", "Paused"
    if mode in (MODE_LOCK, MODE_LOCATION_ERROR, MODE_BOUNDARY_JUMP):
        return "error", "error", "Error"
    if mode in (MODE_CHARGING, MODE_CHARGING_PAUSE) or (mode == MODE_READY and charge != 0):
        return "docked", "docked", "Docked"
    if mode == MODE_UPDATING:
        return "docked", "updating", "Updating"
    if mode in (
        MODE_JOB_DRAW,
        MODE_OBSTACLE_DRAW,
        MODE_CHANNEL_DRAW,
        MODE_ERASER_DRAW,
        MODE_EDIT_BOUNDARY,
    ):
        return "paused", "mapping", "Mapping"
    if mode in (MODE_READY, MODE_ONLINE, MODE_INITIALIZATION, MODE_NOT_ACTIVE):
        return "idle", "idle", "Idle"
    if mode in (MODE_OFFLINE, MODE_DISABLE):
        return "unavailable", "unavailable", "Unavailable"
    # HA lawn_mower returns None for unmapped modes — treat as idle, not unknown.
    return "idle", "idle", "Idle"
