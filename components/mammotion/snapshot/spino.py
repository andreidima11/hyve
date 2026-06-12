"""Spino pool robot snapshot builder."""

from __future__ import annotations

from typing import Any

from pymammotion.data.model.device import PoolCleanerDevice


def _safe_enum_name(value: Any) -> str | None:
    name = getattr(value, "name", None)
    return str(name) if name is not None else None


def build_spino_snapshot(device: PoolCleanerDevice, *, device_name: str) -> dict[str, Any]:
    ps = device.pool_state
    return {
        "device_name": device_name,
        "name": device_name,
        "kind": "spino",
        "online": bool(getattr(device, "online", True)),
        "status": {"battery": getattr(ps, "battery", None)},
        "sensors": {"spino_battery": getattr(ps, "battery", None)},
        "switches": {
            "spino_buzzer": bool(getattr(ps, "buzzer", False)),
            "spino_turbo_clean": bool(getattr(ps, "turbo_clean", False)),
            "spino_platform_cleaning": bool(getattr(ps, "platform_cleaning", False)),
            "spino_waterline_parking": bool(getattr(ps, "waterline_parking", False)),
        },
        "selects": {
            "spino_work_mode": _safe_enum_name(getattr(ps, "work_mode", None)),
            "spino_wall_material": _safe_enum_name(getattr(ps, "wall_material", None)),
            "spino_bottom_type": _safe_enum_name(getattr(ps, "bottom_type", None)),
        },
        "numbers": {"spino_floor_speed": getattr(ps, "floor_speed", None)},
        "plans": {},
        "areas": [],
        "flags": {},
    }
