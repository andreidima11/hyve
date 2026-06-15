"""Dashboard visibility rules (HA-style conditions)."""

from __future__ import annotations

import re
from typing import Any

from core.ui_catalog import resolve_dashboard_card
from core.dashboard.constants import _VISIBILITY_OPERATORS


def _widget_renderer(widget: dict[str, Any] | None) -> str:
    if not isinstance(widget, dict):
        return "button"
    return str(resolve_dashboard_card(widget.get("type"), widget.get("renderer")).get("renderer") or "button")


# Cards that may intentionally omit a visible title; do not back-fill from entity_id.
_RENDERERS_WITHOUT_DEFAULT_TITLE = frozenset({
    "weather", "weather_rich", "fusion_solar",
})


def _normalize_visibility_condition(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    condition_type = str(raw.get("condition") or raw.get("type") or "entity").strip().lower() or "entity"
    operator = str(raw.get("operator") or raw.get("comparison") or "is").strip().lower() or "is"
    aliases = {
        "eq": "==",
        "ne": "!=",
        "equals": "==",
        "not_equals": "!=",
        "state": "is",
        "not_state": "is_not",
    }
    operator = aliases.get(operator, operator)
    value = raw.get("value")
    if value is None and "state" in raw:
        value = raw.get("state")

    # HA-style `user` condition: show only for (or, with is_not, hide from) a set
    # of usernames. Evaluated server-side against the requesting account.
    if condition_type in {"user", "users"}:
        if isinstance(value, str):
            users = [u.strip() for u in value.split(",") if u.strip()]
        elif isinstance(value, (list, tuple)):
            users = [str(u).strip() for u in value if str(u).strip()]
        else:
            users = []
        raw_users = raw.get("users")
        if isinstance(raw_users, (list, tuple)):
            users = [str(u).strip() for u in raw_users if str(u).strip()] or users
        if operator not in {"is", "is_not"}:
            operator = "is"
        return {"condition": "user", "users": users, "operator": operator}

    # HA-style `screen` condition: a CSS media query (e.g. "(max-width: 1023px)").
    # Cannot be resolved on the server (it depends on the viewing device), so it
    # is forwarded to the client which evaluates it via matchMedia.
    if condition_type in {"screen", "media", "device"}:
        media = str(raw.get("media") or value or "").strip()
        if not media:
            return None
        return {"condition": "screen", "media": media}

    entity_id = str(raw.get("entity_id") or "").strip()
    if not entity_id:
        return None
    if operator not in _VISIBILITY_OPERATORS:
        operator = "is"
    return {
        "condition": "entity",
        "entity_id": entity_id,
        "operator": operator,
        "value": value,
    }


def _normalize_visibility_config(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    enabled = bool(raw.get("enabled", False))
    logic = str(raw.get("logic") or raw.get("operator") or "and").strip().lower() or "and"
    if logic not in {"and", "or"}:
        logic = "and"
    raw_conditions = raw.get("conditions") if isinstance(raw.get("conditions"), list) else []
    conditions = [item for item in (_normalize_visibility_condition(entry) for entry in raw_conditions) if item]
    return {
        "enabled": enabled,
        "logic": logic,
        "conditions": conditions,
    }


def _widget_visibility_config(widget: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(widget, dict):
        return None
    config = widget.get("config")
    if not isinstance(config, dict):
        return None
    return _normalize_visibility_config(config.get("visibility"))


def _coerce_visibility_value(value: Any) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value or "").strip()
    lowered = text.lower()
    if lowered in {"true", "false"}:
        return lowered == "true"
    if re.fullmatch(r"[-+]?\d+", text):
        return float(text)
    if re.fullmatch(r"[-+]?\d*\.\d+", text):
        return float(text)
    return lowered


def _evaluate_visibility_condition(condition: dict[str, Any], entity_map: dict[str, dict[str, Any]], viewer: str | None = None) -> bool:
    condition_type = str(condition.get("condition") or "entity").strip().lower() or "entity"
    if condition_type == "user":
        users = condition.get("users") if isinstance(condition.get("users"), list) else []
        member = bool(viewer) and viewer in users
        return (not member) if condition.get("operator") == "is_not" else member
    if condition_type == "screen":
        # Device-dependent; the client makes the final call. Visible server-side.
        return True
    entity_id = str(condition.get("entity_id") or "").strip()
    if not entity_id:
        return False
    entity = entity_map.get(entity_id)
    if not entity:
        return False
    operator = str(condition.get("operator") or "is").strip().lower() or "is"
    actual = _coerce_visibility_value(entity.get("state"))
    expected = _coerce_visibility_value(condition.get("value"))
    if operator in {"is", "=="}:
        return actual == expected
    if operator in {"is_not", "!="}:
        return actual != expected
    if not isinstance(actual, (int, float)) or not isinstance(expected, (int, float)):
        return False
    if operator == ">":
        return actual > expected
    if operator == ">=":
        return actual >= expected
    if operator == "<":
        return actual < expected
    if operator == "<=":
        return actual <= expected
    return False


def _evaluate_visibility_rules(visibility: dict[str, Any] | None, entity_map: dict[str, dict[str, Any]], viewer: str | None = None) -> bool:
    if not visibility or not visibility.get("enabled"):
        return True
    conditions = visibility.get("conditions") if isinstance(visibility.get("conditions"), list) else []
    # Screen / media-query conditions are device-dependent and resolved on the
    # client; they never influence the server boolean (the client applies them
    # as an additional AND gate on top of this result).
    conditions = [c for c in conditions if str(c.get("condition") or "entity").strip().lower() != "screen"]
    if not conditions:
        return True
    results = [_evaluate_visibility_condition(condition, entity_map, viewer) for condition in conditions]
    if visibility.get("logic") == "or":
        return any(results)
    return all(results)


def _evaluate_widget_visibility(widget: dict[str, Any], entity_map: dict[str, dict[str, Any]], viewer: str | None = None) -> bool:
    return _evaluate_visibility_rules(_widget_visibility_config(widget), entity_map, viewer)


def _panel_visibility_config(panel: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(panel, dict):
        return None
    return _normalize_visibility_config(panel.get("visibility"))


def _evaluate_panel_visibility(panel: dict[str, Any], entity_map: dict[str, dict[str, Any]], viewer: str | None = None) -> bool:
    return _evaluate_visibility_rules(_panel_visibility_config(panel), entity_map, viewer)

