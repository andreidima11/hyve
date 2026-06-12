"""Mammotion select entities — enum options (parity with Mammotion-HA)."""

from __future__ import annotations

from enum import Enum
from typing import Any, Callable

from pymammotion.data.model.mowing_modes import (
    BorderPatrolMode,
    CuttingMode,
    CuttingSpeedMode,
    DetectionStrategy,
    MowOrder,
    ObstacleLapsMode,
    PathAngleSetting,
    TraversalMode,
    TurningMode,
    WildlifeSafety,
)

_SELECT_ENUMS: dict[str, type[Enum]] = {
    "channel_mode": CuttingMode,
    "mowing_laps": BorderPatrolMode,
    "obstacle_laps": ObstacleLapsMode,
    "border_mode": MowOrder,
    "cutting_angle_mode": PathAngleSetting,
    "bypass_mode": DetectionStrategy,
    "traversal_mode": TraversalMode,
    "turning_mode": TurningMode,
    "wildlife_safety": WildlifeSafety,
    "cutter_mode": CuttingSpeedMode,
}

_VOICE_GENDER_OPTIONS = ["MAN", "WOMAN"]


def _enum_names(enum_cls: type[Enum]) -> list[str]:
    return [member.name for member in enum_cls]


def select_options_for_key(key: str, flags: dict[str, Any], device_name: str = "") -> list[str]:
    """Return allowed option names for a select key on this device."""
    if key == "voice_gender":
        return list(_VOICE_GENDER_OPTIONS)
    enum_cls = _SELECT_ENUMS.get(key)
    if enum_cls is None:
        return []
    if key == "cutting_angle_mode" and flags.get("is_luba1"):
        return [name for name in _enum_names(enum_cls) if name != "random_angle"]
    if key == "bypass_mode":
        from pymammotion.utility.device_type import DeviceType

        firmware = str(flags.get("device_firmware") or "")
        strategies = DetectionStrategy.for_device(device_name, firmware)
        return [s.name for s in strategies]
    return _enum_names(enum_cls)


def resolve_select_option(key: str, raw: Any, options: list[str]) -> str | None:
    """Map stored value (int/str) to an option name present in *options*."""
    if raw is None or raw == "":
        return None
    if isinstance(raw, str):
        text = raw.strip()
        if text in options:
            return text
        upper = text.upper()
        if upper in options:
            return upper
    enum_cls = _SELECT_ENUMS.get(key)
    if enum_cls is not None:
        try:
            if isinstance(raw, str) and raw.isdigit():
                member = enum_cls(int(raw))
            elif isinstance(raw, int):
                member = enum_cls(raw)
            else:
                member = enum_cls[raw] if isinstance(raw, str) else None
            if member is not None and member.name in options:
                return member.name
        except (KeyError, ValueError, TypeError):
            pass
    if key == "voice_gender":
        text = str(raw).strip().upper()
        return text if text in options else None
    return None


def build_select_capabilities(
    key: str,
    flags: dict[str, Any],
    device_name: str,
) -> tuple[list[dict[str, str]], list[str]]:
    """Return (capabilities.options, flat option names)."""
    names = select_options_for_key(key, flags, device_name)
    if not names:
        return [], []
    opts = [{"value": name, "label": name} for name in names]
    return opts, names
