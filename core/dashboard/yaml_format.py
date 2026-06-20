"""YAML projection for dashboard pages, panels, and widgets."""

from __future__ import annotations

from typing import Any

from core.dashboard.interactions import (
    default_interactions_for_widget,
    normalize_interactions,
    stored_interactions,
)

_WIDGET_YAML_KEYS = (
    "id",
    "type",
    "entity_id",
    "unique_id",
    "title",
    "icon",
    "color",
    "size",
    "renderer",
    "switch_style",
    "show_background",
    "favorite",
    "page_id",
    "col_span",
    "row_span",
    "col_start",
    "row_start",
    "layout_column",
    "interactions",
    "config",
    "visibility",
)

_PANEL_YAML_KEYS = (
    "id",
    "title",
    "size",
    "icon",
    "pages",
    "show_pagination",
    "col_start",
    "row_start",
    "row_span",
    "visibility",
    "background",
    "widgets",
)

_PAGE_YAML_KEYS = (
    "id",
    "title",
    "subtitle",
    "icon",
    "columns",
    "theme",
    "parent_page_id",
    "preferences",
    "panels",
)


def _strip_none_values(data: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in data.items():
        if value is None:
            continue
        if value == "":
            continue
        if value is False and key not in {"switch_style", "show_background", "favorite", "show_pagination"}:
            continue
        if isinstance(value, dict):
            nested = _strip_none_values(value)
            if nested:
                out[key] = nested
            continue
        if isinstance(value, list):
            if value:
                out[key] = value
            continue
        out[key] = value
    return out


def _interactions_for_yaml(widget: dict[str, Any]) -> dict[str, dict[str, Any]] | None:
    stored = stored_interactions(widget)
    if not stored:
        return None
    defaults = default_interactions_for_widget(widget)
    diff: dict[str, dict[str, Any]] = {}
    for gesture, spec in stored.items():
        default_spec = defaults.get(gesture) or {"action": "none"}
        if spec != default_spec:
            diff[gesture] = dict(spec)
    return diff or None


def widget_to_yaml_dict(widget: dict[str, Any]) -> dict[str, Any]:
    """Project a normalized widget into a concise YAML-friendly dict."""
    if not isinstance(widget, dict):
        return {}
    raw: dict[str, Any] = {}
    for key in _WIDGET_YAML_KEYS:
        if key == "interactions":
            continue
        if key == "config":
            config = widget.get("config")
            if isinstance(config, dict):
                config_copy = dict(config)
                config_copy.pop("interactions", None)
                config_copy.pop("entity_ids", None)
                if config_copy:
                    raw["config"] = config_copy
            continue
        if key in widget and widget.get(key) not in (None, ""):
            raw[key] = widget.get(key)

    interactions = _interactions_for_yaml(widget)
    if interactions:
        raw["interactions"] = interactions

    return _strip_none_values(raw)


def panel_to_yaml_dict(panel: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(panel, dict):
        return {}
    raw: dict[str, Any] = {}
    for key in _PANEL_YAML_KEYS:
        if key == "widgets":
            widgets = panel.get("widgets")
            if isinstance(widgets, list):
                raw["widgets"] = [widget_to_yaml_dict(item) for item in widgets if isinstance(item, dict)]
            continue
        if key in panel and panel.get(key) not in (None, ""):
            raw[key] = panel.get(key)
    return _strip_none_values(raw)


def page_section_to_yaml_dict(section: dict[str, Any]) -> dict[str, Any]:
    """Project a normalized dashboard page section into YAML."""
    if not isinstance(section, dict):
        return {}
    raw: dict[str, Any] = {
        "id": str(section.get("page_id") or section.get("id") or ""),
        "title": str(section.get("title") or "Dashboard"),
        "subtitle": str(section.get("subtitle") or ""),
        "icon": str(section.get("icon") or ""),
        "columns": int(section.get("columns") or 0),
        "theme": str(section.get("theme") or ""),
        "parent_page_id": str(section.get("parent_page_id") or ""),
        "preferences": dict(section.get("preferences") or {}),
        "panels": [panel_to_yaml_dict(p) for p in (section.get("panels") or []) if isinstance(p, dict)],
    }
    return _strip_none_values(raw)


def prepare_yaml_widget_for_store(raw: dict[str, Any]) -> dict[str, Any]:
    """Accept YAML widget input (``interactions`` at top level) for normalization."""
    if not isinstance(raw, dict):
        return {}
    widget = dict(raw)
    top_interactions = normalize_interactions(widget.pop("interactions", None))
    config = widget.get("config")
    if not isinstance(config, dict):
        config = {}
    else:
        config = dict(config)
    if top_interactions:
        existing = normalize_interactions(config.get("interactions")) or {}
        existing.update(top_interactions)
        config["interactions"] = existing
    widget["config"] = config or None
    return widget


def prepare_yaml_panels_for_store(raw_panels: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_panels, list):
        return []
    panels: list[dict[str, Any]] = []
    for panel in raw_panels:
        if not isinstance(panel, dict):
            continue
        item = dict(panel)
        widgets = item.get("widgets")
        if isinstance(widgets, list):
            item["widgets"] = [prepare_yaml_widget_for_store(w) for w in widgets if isinstance(w, dict)]
        panels.append(item)
    return panels
