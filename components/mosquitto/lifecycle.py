"""Mosquitto integration lifecycle — MQTT bridge at boot and after entry create."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import settings
from core.log_stream import log_line

log = logging.getLogger("components.mosquitto.lifecycle")


async def _start_bridge_for_instance(manager: Any, inst: Any) -> None:
    from components.mosquitto import bridge as mosquitto_bridge

    section = inst.config_section(settings.CFG)
    host = (section.get("host") or "").strip() or "localhost"
    await asyncio.wait_for(
        mosquitto_bridge.start_bridge({**section, "host": host}, key=inst.entry_id),
        timeout=5.0,
    )
    log_line("success", "📡", "MQTT BRIDGE", f"connected to {host}:{section.get('port', 1883)}")


async def startup_all(*, manager: Any, slug: str) -> None:
    del slug
    for inst in manager.entries_for("mosquitto"):
        section = inst.config_section(settings.CFG)
        host = (section.get("host") or "").strip() or "localhost"
        try:
            await _start_bridge_for_instance(manager, inst)
        except asyncio.TimeoutError:
            log_line("error", "⚠️", "MQTT BRIDGE", f"{host}: setup timed out; continuing without this bridge")
        except Exception as exc:
            log_line("error", "⚠️", "MQTT BRIDGE", f"{host}: {exc}")


async def after_entry_wired(*, manager: Any, entry_id: str, slug: str) -> None:
    del slug
    from components.mosquitto import bridge as mosquitto_bridge

    inst = manager.get_by_entry(entry_id)
    if inst is None:
        return
    section = inst.config_section(settings.CFG)
    host = (section.get("host") or "").strip() or "localhost"
    try:
        await mosquitto_bridge.start_bridge({**section, "host": host}, key=inst.entry_id)
    except Exception as exc:
        log.warning("MQTT bridge start failed for new entry: %s", exc)


async def shutdown(*, slug: str) -> None:
    del slug
    from components.mosquitto import bridge as mosquitto_bridge

    await mosquitto_bridge.stop_bridge()


def purge_discovery_on_rename(
    *,
    manager: Any,
    slug: str,
    canonical_id: str,
    old_names: list[str],
) -> int:
    del slug
    from components.mosquitto import bridge as mosquitto_bridge

    removed = 0
    for inst in manager.entries_for("mosquitto"):
        br = mosquitto_bridge.get_bridge(inst.entry_id)
        if br is not None:
            removed += br.purge_discovery_for_device(
                canonical_id,
                old_friendly_names=old_names,
            )
    return removed
