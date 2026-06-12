"""Serialize PyMammotion device objects into Hyve-friendly snapshots."""

from __future__ import annotations

from typing import Any

from pymammotion.data.model.device import MowerDevice, PoolCleanerDevice

from components.mammotion.snapshot.map_data import device_kind
from components.mammotion.snapshot.mower import build_mower_snapshot, minimal_mower_snapshot
from components.mammotion.snapshot.spino import build_spino_snapshot

__all__ = [
    "build_device_snapshot",
    "build_mower_snapshot",
    "build_spino_snapshot",
    "device_kind",
]


def build_device_snapshot(
    device: Any,
    *,
    device_name: str,
    coordinator_meta: dict[str, Any] | None = None,
    client: Any | None = None,
) -> dict[str, Any]:
    if isinstance(device, PoolCleanerDevice) or device_kind(device_name) == "spino":
        return build_spino_snapshot(device, device_name=device_name)
    if isinstance(device, MowerDevice) or device_kind(device_name) == "mower":
        try:
            return build_mower_snapshot(
                device,
                device_name=device_name,
                coordinator_meta=coordinator_meta,
                client=client,
            )
        except Exception:
            return minimal_mower_snapshot(device, device_name=device_name)
    return {
        "device_name": device_name,
        "name": device_name,
        "kind": "rtk",
        "online": bool(getattr(device, "online", True)),
        "sensors": {},
        "switches": {},
        "numbers": {},
        "selects": {},
        "plans": {},
        "areas": [],
        "flags": {},
        "status": {},
        "errors": {},
    }
