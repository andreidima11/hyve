"""Roborock LAN vs cloud transport helpers."""
from __future__ import annotations

from typing import Any


def device_transport_snapshot(device: Any) -> dict[str, Any]:
    """Summarize how Hyve is talking to a Roborock device right now."""
    local = bool(getattr(device, "is_local_connected", False))
    connected = bool(getattr(device, "is_connected", False))
    if local:
        mode = "local"
    elif connected:
        mode = "cloud"
    else:
        mode = "offline"
    return {
        "transport": mode,
        "local_connected": local,
        "connected": connected,
    }


def transport_log_message(device: Any, snap: dict[str, Any], *, ip: str | None = None) -> str:
    name = str(getattr(device, "name", "") or "Roborock")
    mode = snap.get("transport") or "offline"
    if mode == "local":
        suffix = f" @ {ip}" if ip else ""
        return f"{name} conectat local (LAN{suffix})"
    if mode == "cloud":
        return (
            f"{name} folosește cloud MQTT — verifică rețeaua (TCP 58867, UDP 58866) "
            "și IP static pentru aspirator"
        )
    return f"{name} offline"
