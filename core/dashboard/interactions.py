"""Dashboard card interaction actions (tap / double-tap / hold)."""

from __future__ import annotations

from typing import Any

from core.dashboard.entity_routing import resolve_entity_effective_renderer

GESTURES = frozenset({"tap", "double_tap", "hold"})
ACTIONS = frozenset({
    "none",
    "toggle",
    "more_info",
    "history",
    "perform_action",
    "navigate",
    "url",
})

_NUMERIC_HISTORY_DOMAINS = frozenset({"sensor"})
_READ_ONLY_RENDERERS = frozenset({"label", "info", "weather", "weather_rich", "picture", "fusion_solar"})
_INLINE_CONTROL_RENDERERS = frozenset({"light", "climate", "number", "select"})
_TOGGLE_DOMAINS = frozenset({"switch", "input_boolean", "light", "fan", "cover"})
_TILE_DOMAINS = frozenset({"cover", "fan", "media_player"})
_ONE_SHOT_DOMAINS = frozenset({"scene", "button", "script"})


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


def _effective_renderer(widget: dict[str, Any]) -> str:
    if not isinstance(widget, dict):
        return "info"
    renderer = str(widget.get("renderer") or "").strip().lower()
    if widget.get("type") == "entity" or renderer == "entity":
        resolved = resolve_entity_effective_renderer(widget)
        return str(resolved.get("renderer") or "info").strip().lower() or "info"
    return renderer or "info"


def _widget_config(widget: dict[str, Any]) -> dict[str, Any]:
    config = widget.get("config")
    return dict(config) if isinstance(config, dict) else {}


def _supports_numeric_history(widget: dict[str, Any]) -> bool:
    domain = _entity_domain(widget)
    return domain in _NUMERIC_HISTORY_DOMAINS


def normalize_interaction(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    action = str(raw.get("action") or "none").strip().lower().replace("-", "_")
    if action not in ACTIONS:
        action = "none"
    out: dict[str, Any] = {"action": action}
    if action == "history":
        try:
            hours = float(raw.get("hours", 24))
        except (TypeError, ValueError):
            hours = 24.0
        out["hours"] = max(0.25, min(hours, 24.0 * 7))
    if action == "perform_action":
        perform = str(raw.get("perform") or raw.get("action_id") or "").strip()
        if perform:
            out["perform"] = perform
    if action == "navigate":
        page_id = str(raw.get("page_id") or "").strip()
        if page_id:
            out["page_id"] = page_id
    if action == "url":
        url = str(raw.get("url") or "").strip()
        if url:
            out["url"] = url
    if action == "more_info":
        tab = str(raw.get("tab") or "overview").strip().lower()
        if tab in {"overview", "history", "attributes"}:
            out["tab"] = tab
    if action == "toggle" and bool(raw.get("confirmation")):
        out["confirmation"] = True
    if out["action"] == "none" and len(out) == 1:
        return None
    return out


def normalize_interactions(raw: Any) -> dict[str, dict[str, Any]] | None:
    if not isinstance(raw, dict):
        return None
    out: dict[str, dict[str, Any]] = {}
    for gesture in GESTURES:
        if gesture not in raw:
            continue
        normalized = normalize_interaction(raw.get(gesture))
        if normalized:
            out[gesture] = normalized
    return out or None


def _pick_action(action: str | None) -> str:
    candidate = str(action or "none").strip().lower().replace("-", "_")
    return candidate if candidate in ACTIONS else "none"


def default_interactions_for_widget(widget: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """Return default tap/double_tap/hold actions for a widget."""
    widget = widget if isinstance(widget, dict) else {}
    renderer = _effective_renderer(widget)
    domain = _entity_domain(widget)
    switch_style = bool(widget.get("switch_style"))

    if renderer in _READ_ONLY_RENDERERS or domain in {"weather", "person", "sun", "device_tracker", "update"}:
        return {
            "tap": {"action": "none"},
            "double_tap": {"action": "none"},
            "hold": {"action": "none"},
        }

    if renderer in _INLINE_CONTROL_RENDERERS:
        return {
            "tap": {"action": "none"},
            "double_tap": {"action": "toggle" if domain in _TOGGLE_DOMAINS or switch_style else "more_info"},
            "hold": {"action": "more_info"},
        }

    if domain in _ONE_SHOT_DOMAINS or renderer in {"scene", "button"}:
        return {
            "tap": {"action": "perform_action", "perform": "domain_default"},
            "double_tap": {"action": "more_info"},
            "hold": {"action": "none"},
        }

    if domain in {"lock", "vacuum", "lawn_mower"} or renderer in {"lock", "vacuum", "lawn_mower"}:
        return {
            "tap": {"action": "more_info"},
            "double_tap": {"action": "perform_action", "perform": "domain_default"},
            "hold": {"action": "none"},
        }

    if domain in _NUMERIC_HISTORY_DOMAINS or renderer == "sensor":
        history = {"action": "history", "hours": 24} if _supports_numeric_history(widget) else {"action": "more_info"}
        return {
            "tap": history,
            "double_tap": {"action": "more_info"},
            "hold": {"action": "none"},
        }

    if domain in _TOGGLE_DOMAINS or switch_style or renderer in {"switch", "tile"} or domain in _TILE_DOMAINS:
        return {
            "tap": {"action": "toggle"},
            "double_tap": {"action": "more_info"},
            "hold": {"action": "history", "hours": 24} if _supports_numeric_history(widget) else {"action": "more_info"},
        }

    if renderer == "camera":
        return {
            "tap": {"action": "more_info"},
            "double_tap": {"action": "none"},
            "hold": {"action": "none"},
        }

    return {
        "tap": {"action": "more_info"},
        "double_tap": {"action": "none"},
        "hold": {"action": "none"},
    }


def stored_interactions(widget: dict[str, Any] | None) -> dict[str, dict[str, Any]] | None:
    if not isinstance(widget, dict):
        return None
    config = _widget_config(widget)
    stored = normalize_interactions(config.get("interactions"))
    if stored:
        return stored
    top = normalize_interactions(widget.get("interactions"))
    return top


def resolve_effective_interaction(widget: dict[str, Any] | None, gesture: str) -> dict[str, Any]:
    gesture_key = str(gesture or "tap").strip().lower()
    if gesture_key not in GESTURES:
        gesture_key = "tap"
    defaults = default_interactions_for_widget(widget)
    stored = stored_interactions(widget) or {}
    override = stored.get(gesture_key)
    if override:
        return dict(override)
    return dict(defaults.get(gesture_key) or {"action": "none"})


def resolve_effective_interactions(widget: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    return {gesture: resolve_effective_interaction(widget, gesture) for gesture in GESTURES}


def interaction_action(widget: dict[str, Any] | None, gesture: str) -> str:
    return _pick_action(resolve_effective_interaction(widget, gesture).get("action"))


def widget_has_action(widget: dict[str, Any] | None, gesture: str) -> bool:
    return interaction_action(widget, gesture) != "none"


def widget_is_interactive(widget: dict[str, Any] | None) -> bool:
    return any(widget_has_action(widget, gesture) for gesture in GESTURES)


def apply_interactions_to_widget_config(widget: dict[str, Any]) -> dict[str, Any]:
    """Normalize and persist interactions under ``config.interactions``."""
    updated = dict(widget or {})
    config = _widget_config(updated)
    top_level = normalize_interactions(updated.pop("interactions", None))
    config_level = normalize_interactions(config.get("interactions"))
    merged_source = {}
    if top_level:
        merged_source.update(top_level)
    if config_level:
        merged_source.update(config_level)
    normalized = normalize_interactions(merged_source)
    if normalized:
        config["interactions"] = normalized
    else:
        config.pop("interactions", None)
    updated["config"] = config or None
    return updated
