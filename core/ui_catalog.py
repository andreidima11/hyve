from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any

from integrations import config_entries, get_integration_manager


_CATALOG_PATH = Path(__file__).resolve().parent.parent / "ui_catalog.json"
_CARD_RENDERERS = {
    "switch", "button", "info", "label", "weather", "scene",
    # Phase 2 — rich HA-style cards
    "tile", "light", "sensor", "climate", "gauge", "lock", "weather_rich",
    "camera", "vacuum", "fusion_solar",
}
_GENERIC_CARD_RENDERERS = frozenset({"button", "tile", "switch", "info", "scene"})

_FALLBACK_CATALOG: dict[str, Any] = {
    "integrations": [],
    "dashboard_cards": [
        {
            "id": "button",
            "label": "Buton",
            "renderer": "button",
            "requires_entity": True,
            "entity_filter": "controllable",
            "supports_visibility": True,
            "supports_switch_style": True,
            "supports_background": False,
            "default_size": "md",
            "order": 10,
        },
        {
            "id": "info",
            "label": "Info card",
            "renderer": "info",
            "requires_entity": True,
            "entity_filter": "all",
            "supports_visibility": True,
            "supports_switch_style": False,
            "supports_background": False,
            "default_size": "md",
            "order": 20,
        },
        {
            "id": "weather",
            "label": "Weather card",
            "renderer": "weather",
            "requires_entity": True,
            "entity_filter": "weather",
            "supports_visibility": True,
            "supports_switch_style": False,
            "supports_background": False,
            "default_size": "md",
            "order": 30,
        },
        {
            "id": "label",
            "label": "Label / text",
            "renderer": "label",
            "requires_entity": False,
            "entity_filter": "none",
            "supports_visibility": True,
            "supports_switch_style": False,
            "supports_background": True,
            "default_size": "md",
            "order": 40,
        },
    ],
}


def _load_raw_catalog() -> dict[str, Any]:
    if not _CATALOG_PATH.exists():
        return deepcopy(_FALLBACK_CATALOG)
    try:
        payload = json.loads(_CATALOG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return deepcopy(_FALLBACK_CATALOG)
    if not isinstance(payload, dict):
        return deepcopy(_FALLBACK_CATALOG)
    merged = deepcopy(_FALLBACK_CATALOG)
    for key in ("integrations", "dashboard_cards"):
        value = payload.get(key)
        if isinstance(value, list):
            merged[key] = value
    return merged


# --- Cache layer ---------------------------------------------------------
# `_load_raw_catalog`, `dashboard_card_catalog` and `integration_catalog` are
# called on every dashboard/integration HTTP request. The catalog file rarely
# changes, so we cache by file mtime to avoid disk I/O + JSON parse + dict
# normalization on the hot path.
_CACHE: dict[str, Any] = {"mtime": -1.0, "raw": None, "cards": None, "integrations": None}


def _current_mtime() -> float:
    try:
        return _CATALOG_PATH.stat().st_mtime
    except OSError:
        return 0.0


def _cached_raw_catalog() -> dict[str, Any]:
    mtime = _current_mtime()
    if _CACHE["raw"] is None or _CACHE["mtime"] != mtime:
        _CACHE["raw"] = _load_raw_catalog()
        _CACHE["mtime"] = mtime
        _CACHE["cards"] = None
        _CACHE["integrations"] = None
    return _CACHE["raw"]


def invalidate_ui_catalog_cache() -> None:
    """Force a reload on the next call — invoke this if the catalog file is
    written from inside the process."""
    _CACHE["raw"] = None
    _CACHE["cards"] = None
    _CACHE["integrations"] = None
    _CACHE["mtime"] = -1.0


def _normalize_card_entry(entry: dict[str, Any]) -> dict[str, Any]:
    card_id = str(entry.get("id") or "").strip()
    if not card_id:
        return {}
    renderer = str(entry.get("renderer") or card_id).strip() or card_id
    if renderer not in _CARD_RENDERERS:
        renderer = "button"
    return {
        "id": card_id,
        "label": str(entry.get("label") or card_id.replace("_", " ").title()).strip(),
        "description": str(entry.get("description") or "").strip(),
        "renderer": renderer,
        "requires_entity": bool(entry.get("requires_entity", renderer not in {"label"})),
        "entity_filter": str(entry.get("entity_filter") or ("none" if renderer == "label" else "controllable")).strip(),
        "supports_visibility": bool(entry.get("supports_visibility", True)),
        "supports_switch_style": bool(entry.get("supports_switch_style", renderer == "button")),
        "supports_background": bool(entry.get("supports_background", renderer == "label")),
        "default_size": str(entry.get("default_size") or ("md")).strip(),
        "subtitle_label": str(entry.get("subtitle_label") or ("Text opțional" if renderer == "label" else "Subtitlu / text")).strip(),
        "subtitle_placeholder": str(entry.get("subtitle_placeholder") or ("Poți lăsa gol pentru doar titlu" if renderer == "label" else "ex: Parter sau text scurt")).strip(),
        "show_in_picker": bool(entry.get("show_in_picker", True)),
        "switch_style_default": bool(entry.get("switch_style_default", False)),
        "order": int(entry.get("order") or 999),
    }


def dashboard_card_catalog() -> list[dict[str, Any]]:
    _cached_raw_catalog()
    if _CACHE["cards"] is None:
        raw_cards = _cached_raw_catalog().get("dashboard_cards")
        normalized = [_normalize_card_entry(entry) for entry in raw_cards if isinstance(entry, dict)]
        _CACHE["cards"] = [entry for entry in sorted(normalized, key=lambda item: (item["order"], item["label"].lower())) if entry]
    return _CACHE["cards"]


def resolve_dashboard_card(card_type: str | None, renderer: str | None = None) -> dict[str, Any]:
    card_id = str(card_type or "").strip()
    if card_id == "weather_gradient":
        card_id = "weather"
    resolved_renderer = str(renderer or "").strip()
    if resolved_renderer == "weather_gradient":
        resolved_renderer = "weather"
    catalog = {entry["id"]: entry for entry in dashboard_card_catalog()}
    entry = deepcopy(catalog.get(card_id) or {})
    if not entry and card_id in _CARD_RENDERERS:
        entry = _normalize_card_entry({"id": card_id, "renderer": card_id})
    if not entry:
        entry = deepcopy(catalog.get("button") or _normalize_card_entry({"id": "button", "renderer": "button"}))
        entry["id"] = card_id or entry["id"]
    catalog_renderer = str(entry.get("renderer") or "").strip()
    if resolved_renderer and resolved_renderer in _CARD_RENDERERS:
        # Saved widgets sometimes carry renderer=button while type=fusion_solar etc.
        if card_id in catalog and resolved_renderer in _GENERIC_CARD_RENDERERS and catalog_renderer:
            pass
        else:
            entry["renderer"] = resolved_renderer
    elif entry.get("renderer") not in _CARD_RENDERERS:
        entry["renderer"] = "button"
    return entry


def _integration_has_config_schema(slug: str) -> bool:
    """True when a loaded component provider exposes a non-empty CONFIG_SCHEMA."""
    cls = get_integration_manager().get_class(slug)
    if not cls:
        return False
    try:
        schema = cls.get_config_schema()
    except Exception:
        return False
    return bool(schema)


def _normalize_integration_entry(entry: dict[str, Any]) -> dict[str, Any]:
    slug = str(entry.get("slug") or "").strip()
    if not slug:
        return {}
    config_key = str(entry.get("config_key") or slug).strip() or slug
    panel_id = str(entry.get("config_panel_id") or slug).strip() or slug
    toggle_input_id = str(entry.get("toggle_input_id") or f"{config_key}_enabled").strip()
    toggle_slug = str(entry.get("toggle_slug") or slug).strip() or slug
    return {
        "slug": slug,
        "config_key": config_key,
        "config_panel_id": panel_id,
        "toggle_input_id": toggle_input_id,
        "toggle_slug": toggle_slug,
        "label": str(entry.get("label") or slug.replace("_", " ").title()).strip(),
        "title_key": str(entry.get("title_key") or f"config.{slug}_section").strip(),
        "description_key": str(entry.get("description_key") or f"integrations.catalog.{slug}_desc").strip(),
        "description": str(entry.get("description") or "").strip(),
        "icon": str(entry.get("icon") or "fa-puzzle-piece").strip(),
        "image": str(entry.get("image") or "").strip(),
        "accent": str(entry.get("accent") or "#94a3b8").strip(),
        "icon_background": str(entry.get("icon_background") or "rgba(148,163,184,0.18)").strip(),
        "text_color": "#7dd3fc",
        "supports_sync": bool(entry.get("supports_sync", False)),
        "updates_live": bool(entry.get("updates_live", False)),
        "uses_refresh_layers": bool(entry.get("uses_refresh_layers", False)),
        "admin_only": bool(entry.get("admin_only", False)),
        "order": int(entry.get("order") or 999),
    }


def integration_catalog() -> list[dict[str, Any]]:
    raw_integrations = _cached_raw_catalog().get("integrations")
    configured = {
        entry["slug"]: entry
        for entry in (_normalize_integration_entry(item) for item in raw_integrations if isinstance(item, dict))
        if entry
    }
    claimed_config_keys = {
        str(entry.get("config_key") or entry["slug"]).strip()
        for entry in configured.values()
    }

    manager = get_integration_manager()
    for integration in manager.all():
        if integration.slug in configured:
            continue
        if integration.config_key in claimed_config_keys:
            continue
        if not integration.supports_sync:
            continue
        current = configured.get(integration.slug, _normalize_integration_entry({
            "slug": integration.slug,
            "config_key": integration.config_key,
            "config_panel_id": integration.slug,
            "toggle_input_id": f"{integration.config_key}_enabled",
            "toggle_slug": integration.slug,
            "label": integration.label or integration.slug,
            "icon": integration.icon,
            "supports_sync": integration.supports_sync,
        }))
        current["label"] = current.get("label") or integration.label or integration.slug
        current["icon"] = current.get("icon") or integration.icon or "fa-puzzle-piece"
        current["description"] = current.get("description") or getattr(integration, 'description', '') or ''
        current["supports_sync"] = bool(current.get("supports_sync", integration.supports_sync) or integration.supports_sync)
        current["updates_live"] = bool(getattr(integration, "updates_live", False))
        configured[integration.slug] = current
        claimed_config_keys.add(integration.config_key)

    # Annotate each entry with the live enabled flag (config entries only).
    for entry in configured.values():
        slug = str(entry.get("slug") or "").strip()
        entries = config_entries.list_entries(slug) if slug else []
        entry["enabled"] = any(bool(row.get("enabled", True)) for row in entries) if entries else False
        entry["has_config_schema"] = _integration_has_config_schema(entry["slug"])
        inst = manager.get(entry["slug"])
        if inst is not None:
            entry["updates_live"] = bool(getattr(inst, "updates_live", False))
            entry["uses_refresh_layers"] = bool(getattr(inst, "uses_refresh_layers", False))

    return sorted(configured.values(), key=lambda item: (item["order"], item["label"].lower()))