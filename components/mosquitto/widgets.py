"""Mosquitto extract — Z2M dashboard widget candidate extractors."""

from __future__ import annotations

import json
import logging
from typing import Any

from core.smart_home_registry import entity_domain
from integrations.entity_utils import finalize_entities as _finalize
from integrations.entity_utils import is_state_controllable, slugify

log = logging.getLogger("integrations.mosquitto")

def extract_z2m_candidates(payload: Any) -> list[dict[str, Any]]:
    """Legacy Z2M bridge/devices payload → flat entity list (dashboard widgets)."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append(name: str, state: Any, entity_id: str | None = None) -> None:
        label = (name or entity_id or "").strip()
        if not label:
            return
        eid = entity_id or f"sensor.{slugify(label)}"
        if eid in seen:
            return
        seen.add(eid)
        items.append({
            "entity_id": eid,
            "name": label,
            "state": str(state if state is not None else "unknown"),
            "domain": entity_domain(eid),
            "source": "zigbee2mqtt",
            "aliases": [],
            "unit": "",
            "controllable": is_state_controllable(state, eid),
        })

    if isinstance(payload, list):
        for entry in payload:
            if not isinstance(entry, dict):
                continue
            name = str(entry.get("friendly_name") or entry.get("name") or entry.get("ieee_address") or "").strip()
            state = entry.get("state")
            if state is None:
                state = entry.get("last_seen") or "unknown"
            _append(name, state)
        return _finalize(items, default_source="zigbee2mqtt")

    if not isinstance(payload, dict):
        return items

    devices = payload.get("devices")
    if isinstance(devices, list):
        for device in devices:
            if not isinstance(device, dict):
                continue
            ieee = str(device.get("ieee_address") or device.get("friendly_name") or "").strip()
            name = str(device.get("friendly_name") or ieee or "device").strip()
            for definition in device.get("definitions") or []:
                if not isinstance(definition, dict):
                    continue
                prop = str(definition.get("property") or definition.get("name") or "state").strip()
                label = f"{name} {prop}".strip()
                _append(label, definition.get("value"), f"sensor.{slugify(label)}")
            for expose in device.get("exposes") or []:
                if not isinstance(expose, dict):
                    continue
                prop = str(expose.get("name") or expose.get("property") or "state").strip()
                label = f"{name} {prop}".strip()
                _append(label, expose.get("value"), f"sensor.{slugify(label)}")

    for key, value in payload.items():
        if key in {"devices", "bridge"}:
            continue
        if isinstance(value, (str, int, float, bool)):
            _append(str(key), value, f"sensor.{slugify(str(key))}")

    return _finalize(items, default_source="zigbee2mqtt")


def extract_z2m_widget_candidates(payload: Any) -> list[dict[str, Any]]:
    """Recursive Z2M JSON walk for dashboard entity picker (``z2m:`` entity ids)."""
    items: list[dict[str, Any]] = []
    seen: set[str] = set()

    def _append(name: str, state: Any, entity_id: str | None = None) -> None:
        label = (name or entity_id or "").strip()
        if not label:
            return
        eid = (entity_id or f"z2m:{slugify(label)}").strip()
        if eid in seen:
            return
        seen.add(eid)
        controllable = is_state_controllable(state, eid)
        items.append({
            "entity_id": eid,
            "name": label,
            "state": str(state or "unknown"),
            "domain": "switch" if controllable else "sensor",
            "source": "zigbee2mqtt",
            "aliases": [],
            "unit": "",
            "controllable": controllable,
        })

    def _walk(node: Any) -> None:
        if isinstance(node, list):
            for child in node:
                _walk(child)
            return
        if not isinstance(node, dict):
            return

        possible_name = node.get("friendly_name") or node.get("name") or node.get("device") or node.get("label")
        entity_id = node.get("ha_entity_id") or node.get("entity_id")
        state = node.get("state") or node.get("value")

        if possible_name and state is not None:
            _append(str(possible_name), state, str(entity_id) if entity_id else None)

        for child in node.values():
            if isinstance(child, (dict, list)):
                _walk(child)

    _walk(payload)
    items.sort(key=lambda item: item.get("name") or "")
    return _finalize(items, default_source="zigbee2mqtt")
