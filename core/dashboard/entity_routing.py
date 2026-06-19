"""Resolve HA-style entity card preset to a concrete dashboard renderer."""

from __future__ import annotations

from typing import Any

from core.ui_catalog import _CARD_RENDERERS

_TOGGLE_DOMAINS = frozenset({"switch", "input_boolean"})

_DEDICATED_DOMAIN_RENDERERS: dict[str, str] = {
    "number": "number",
    "select": "select",
    "sensor": "sensor",
    "binary_sensor": "sensor",
    "light": "light",
    "climate": "climate",
    "lock": "lock",
    "vacuum": "vacuum",
    "weather": "weather",
    "scene": "scene",
    "button": "button",
    "script": "button",
}

_TILE_DOMAINS = frozenset({"cover", "fan", "media_player"})


def _entity_domain(widget: dict[str, Any] | None) -> str:
    if not isinstance(widget, dict):
        return ""
    domain = str(widget.get("domain") or "").strip().lower()
    if domain:
        return domain
    entity_id = str(widget.get("entity_id") or "").strip()
    if "." in entity_id:
        return entity_id.split(".", 1)[0].lower()
    return ""


def resolve_entity_effective_renderer(widget: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(widget, dict):
        return {"renderer": "info", "switch_style": False}

    stored = str(widget.get("renderer") or "").strip().lower()
    if stored and stored not in {"entity", ""} and stored in _CARD_RENDERERS:
        return {
            "renderer": stored,
            "switch_style": bool(widget.get("switch_style")),
        }

    domain = _entity_domain(widget)
    switch_style = bool(widget.get("switch_style"))

    dedicated = _DEDICATED_DOMAIN_RENDERERS.get(domain)
    if dedicated:
        return {"renderer": dedicated, "switch_style": False}

    if domain in _TOGGLE_DOMAINS or switch_style:
        return {"renderer": "switch", "switch_style": True}
    if domain in _TILE_DOMAINS:
        return {"renderer": "tile", "switch_style": False}
    return {"renderer": "info", "switch_style": False}
