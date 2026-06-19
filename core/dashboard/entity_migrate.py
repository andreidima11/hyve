"""Migrate legacy dashboard widget presets to the universal entity card."""

from __future__ import annotations

from typing import Any

# Preset ids and renderer aliases superseded by type=entity + domain routing.
_LEGACY_WIDGET_TYPES = frozenset({
    "button",
    "info",
    "switch_tile",
    "sensor_tile",
    "scene",
    "tile",
    "sensor",
    "number",
    "select",
    "light",
    "switch",
})


def migrate_legacy_widget_type(widget: dict[str, Any]) -> dict[str, Any]:
    wtype = str(widget.get("type") or "").strip()
    if wtype not in _LEGACY_WIDGET_TYPES:
        return widget
    out = dict(widget)
    out["type"] = "entity"
    if wtype in {"switch_tile", "switch"} or out.get("switch_style"):
        out["switch_style"] = True
    if wtype == "sensor_tile" and not str(out.get("size") or "").strip():
        out["size"] = "sm"
    return out
