from __future__ import annotations

import re
import unicodedata
import uuid
from typing import Any

import settings
from core import dashboard_store
from integrations.entity_utils import resolve_entity_by_id
from integrations.extractors import infer_source as _infer_source
from routers.dashboard.constants import (
    STANDALONE_PANEL_ID,
    _DEFAULT_DASHBOARD_ICON,
    _DEFAULT_PAGE_ID,
    _DEFAULT_PAGE_TITLE,
    _DEFAULT_PANEL_TITLE,
    _DEFAULT_PREFS,
    _FA_ICON_RE,
    _FA_STYLE_TOKENS,
    _MDI_ICON_RE,
    _MDI_NAME_RE,
    _VISIBILITY_OPERATORS,
)
from ui_catalog import resolve_dashboard_card

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


def _normalize_panel_background(raw: Any) -> dict[str, Any] | None:
    """Normalize an optional section background: {color, opacity}."""
    if not isinstance(raw, dict):
        return None
    color = str(raw.get("color") or "").strip()
    if not color:
        return None
    try:
        opacity = float(raw.get("opacity", 1))
    except (TypeError, ValueError):
        opacity = 1.0
    opacity = max(0.0, min(1.0, opacity))
    return {"color": color, "opacity": opacity}


def _slugify(value: str) -> str:
    text = re.sub(r"[^a-z0-9]+", "_", (value or "").strip().lower())
    return text.strip("_") or "device"


def _page_slug(title: str) -> str:
    """Produce a friendly page id from a human title.

    Strips diacritics (acasă → acasa), lowercases, replaces non-alphanum with
    `_`, collapses repeats. Returns "pagina" when nothing usable is left.
    """
    raw = (title or "").strip().lower()
    if not raw:
        return "pagina"
    # NFKD then drop combining marks → strip diacritics.
    decomposed = unicodedata.normalize("NFKD", raw)
    ascii_only = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_only).strip("_")
    return slug or "pagina"


def _unique_page_id(base: str, taken: set[str], keep: str | None = None) -> str:
    """Return a page id derived from `base` not present in `taken`.

    If `keep` is supplied and matches `base` (or `base_N`), it is reused as-is
    so callers can rename a page to its existing slug without churn.
    """
    base = (base or "pagina").strip("_") or "pagina"
    if keep and (keep == base or keep.startswith(f"{base}_")):
        # Existing id already derived from this slug; keep it stable.
        return keep
    if base not in taken:
        return base
    bump = 2
    while f"{base}_{bump}" in taken:
        bump += 1
    return f"{base}_{bump}"


def _normalize_icon(value: Any, default: str = "") -> str:
    raw = str(value or "").strip()
    tokens = [token.strip() for token in re.split(r"\s+", raw) if token.strip()]
    if not tokens:
        return default

    raw_lower = raw.lower()
    if raw_lower.startswith("mdi:"):
        mdi_name = raw_lower[4:].strip()
        return f"mdi:{mdi_name}" if _MDI_NAME_RE.match(mdi_name) else default
    if len(tokens) == 1 and _MDI_ICON_RE.match(tokens[0].lower()):
        token = tokens[0].lower()
        mdi_name = token[4:]
        return f"mdi:{mdi_name}" if _MDI_NAME_RE.match(mdi_name) else default
    if len(tokens) >= 2 and tokens[0].lower() == "mdi" and tokens[1].lower().startswith("mdi-"):
        mdi_name = tokens[1].lower()[4:]
        return f"mdi:{mdi_name}" if _MDI_NAME_RE.match(mdi_name) else default

    icon_token = next(
        (
            token.lower()
            for token in tokens
            if _FA_ICON_RE.match(token.lower()) and token.lower() not in _FA_STYLE_TOKENS and token.lower() != "fa"
        ),
        "",
    )
    if not icon_token:
        return default

    style_token = next((token.lower() for token in tokens if token.lower() in _FA_STYLE_TOKENS), "") or "fas"
    return f"{style_token} {icon_token}".strip()


def _normalize_widget_entity_records(value: Any) -> list[dict[str, str]]:
    raw_items = value if isinstance(value, list) else []
    result: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw_items:
        if isinstance(item, dict):
            entity_id = str(item.get("entity_id") or "").strip()
            unique_id = str(item.get("unique_id") or "").strip()
        else:
            entity_id = str(item or "").strip()
            unique_id = ""
        dedupe_key = unique_id or entity_id
        if not dedupe_key or dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        record: dict[str, str] = {}
        if entity_id:
            record["entity_id"] = entity_id
        if unique_id:
            record["unique_id"] = unique_id
        if not record.get("entity_id") and unique_id:
            record["entity_id"] = unique_id
        if isinstance(item, dict):
            title = str(item.get("title") or "").strip()
            subtitle = str(item.get("subtitle") or item.get("entity_name") or "").strip()
            if title:
                record["title"] = title
            if subtitle:
                record["subtitle"] = subtitle
        result.append(record)
    return result[:12]


def _normalize_widget_entity_ids(value: Any) -> list[str]:
    return [record["entity_id"] for record in _normalize_widget_entity_records(value)]


def _widget_entity_records(widget: dict[str, Any] | None) -> list[dict[str, str]]:
    if not isinstance(widget, dict):
        return []
    records: list[dict[str, str]] = []
    seen: set[str] = set()
    config = widget.get("config") if isinstance(widget.get("config"), dict) else {}
    configured = _normalize_widget_entity_records(config.get("entities"))
    configured_by_id = {record["entity_id"]: record for record in configured}

    def add(record: dict[str, str]) -> None:
        entity_id = str(record.get("entity_id") or "").strip()
        unique_id = str(record.get("unique_id") or "").strip()
        dedupe_key = unique_id or entity_id
        if not dedupe_key or dedupe_key in seen:
            return
        seen.add(dedupe_key)
        records.append({key: value for key, value in record.items() if value})

    primary = str(widget.get("entity_id") or "").strip()
    primary_uid = str(widget.get("unique_id") or "").strip()
    if primary or primary_uid:
        base = configured_by_id.get(primary) or {"entity_id": primary}
        if primary_uid:
            base = {**base, "unique_id": primary_uid}
        add(base)
    for record in configured:
        add(record)
    for entity_id in _normalize_widget_entity_ids(config.get("entity_ids")):
        add({"entity_id": entity_id})
    for key in (
        "entity_load", "entity_grid", "entity_daily", "entity_monthly", "entity_yearly",
        "entity_grid_export", "entity_grid_import", "entity_feed_in", "entity_consumption",
    ):
        eid = str(config.get(key) or "").strip()
        if eid:
            add({"entity_id": eid})
    for record in _normalize_widget_entity_records(config.get("power_entities")):
        add(record)
    return records


def _widget_entity_ids(widget: dict[str, Any] | None) -> list[str]:
    refs: list[str] = []
    for record in _widget_entity_records(widget):
        for key in ("entity_id", "unique_id"):
            value = str(record.get(key) or "").strip()
            if value and value not in refs:
                refs.append(value)
    return refs


def _resolve_primary_entity(
    uid: str,
    eid: str,
    entity_map: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    """Resolve widget refs; ``entity_id`` wins when it points at a different entity."""
    by_uid = resolve_entity_by_id(uid, entity_map) if uid else None
    by_eid = resolve_entity_by_id(eid, entity_map) if eid else None
    if by_uid and by_eid:
        uid_eid = str(by_uid.get("entity_id") or "").strip()
        eid_eid = str(by_eid.get("entity_id") or "").strip()
        if uid_eid and eid_eid and uid_eid != eid_eid:
            return by_eid
        return by_uid
    return by_uid or by_eid


def _apply_primary_entity_ref(
    target: dict[str, Any],
    primary: dict[str, Any],
) -> bool:
    changed = False
    new_uid = str(primary.get("unique_id") or "").strip()
    new_eid = str(primary.get("entity_id") or "").strip()
    if new_uid and target.get("unique_id") != new_uid:
        target["unique_id"] = new_uid
        changed = True
    if new_eid and target.get("entity_id") != new_eid:
        target["entity_id"] = new_eid
        changed = True
    return changed


def _sync_widget_record_ref(
    record: dict[str, Any],
    entity_map: dict[str, dict[str, Any]],
) -> bool:
    uid = str(record.get("unique_id") or "").strip()
    eid = str(record.get("entity_id") or "").strip()
    primary = _resolve_primary_entity(uid, eid, entity_map)
    if not primary:
        return False
    return _apply_primary_entity_ref(record, primary)


def reconcile_widget_entity_refs(
    widget: dict[str, Any],
    entity_map: dict[str, dict[str, Any]],
) -> bool:
    """Align stored widget refs with the live catalog."""
    if not isinstance(widget, dict) or not entity_map:
        return False
    changed = False

    uid = str(widget.get("unique_id") or "").strip()
    eid = str(widget.get("entity_id") or "").strip()
    primary = _resolve_primary_entity(uid, eid, entity_map)
    if primary and _apply_primary_entity_ref(widget, primary):
        changed = True

    config = widget.get("config")
    if isinstance(config, dict):
        entities = config.get("entities")
        if isinstance(entities, list):
            for record in entities:
                if isinstance(record, dict) and _sync_widget_record_ref(record, entity_map):
                    changed = True
            if changed:
                config["entity_ids"] = [
                    str(record.get("entity_id") or "").strip()
                    for record in entities
                    if isinstance(record, dict) and record.get("entity_id")
                ]
        for key in (
            "entity_load", "entity_grid", "entity_daily", "entity_monthly", "entity_yearly",
            "entity_grid_export", "entity_grid_import", "entity_feed_in", "entity_consumption",
        ):
            slot_ref = str(config.get(key) or "").strip()
            if not slot_ref:
                continue
            hit = resolve_entity_by_id(slot_ref, entity_map)
            if hit and hit.get("entity_id") and config.get(key) != hit["entity_id"]:
                config[key] = hit["entity_id"]
                changed = True
        power_entities = config.get("power_entities")
        if isinstance(power_entities, list):
            for record in power_entities:
                if isinstance(record, dict) and _sync_widget_record_ref(record, entity_map):
                    changed = True
    return changed


def sync_widget_entity_ref(
    widget: dict[str, Any],
    entity_map: dict[str, dict[str, Any]],
) -> bool:
    """Ensure widget entity_id/unique_id refer to the same live entity."""
    if not isinstance(widget, dict):
        return False
    uid = str(widget.get("unique_id") or "").strip()
    eid = str(widget.get("entity_id") or "").strip()
    primary = _resolve_primary_entity(uid, eid, entity_map)
    if primary:
        return _apply_primary_entity_ref(widget, primary)
    if eid and uid:
        widget.pop("unique_id", None)
        return True
    return False


def reconcile_dashboard_section(
    section: dict[str, Any],
    entity_items: list[dict[str, Any]],
) -> bool:
    entity_map = {}
    for item in entity_items:
        eid = item.get("entity_id")
        if eid:
            entity_map[eid] = item
        uid = item.get("unique_id")
        if uid and uid not in entity_map:
            entity_map[uid] = item
    changed = False
    for panel in section.get("panels") or []:
        widgets = panel.get("widgets")
        if not isinstance(widgets, list):
            continue
        for widget in widgets:
            if isinstance(widget, dict) and reconcile_widget_entity_refs(widget, entity_map):
                changed = True
    return changed


def _apply_widget_patch(widget: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    updated = dict(widget or {})
    config_patch = patch.get("config") if isinstance(patch.get("config"), dict) else None
    visibility_patch = _normalize_visibility_config(patch.get("visibility")) if "visibility" in (patch or {}) else None
    for key, value in (patch or {}).items():
        if value is None:
            continue
        if key == "col_span_v2":
            continue
        if key in {"favorite", "show_background", "switch_style"}:
            updated[key] = bool(value)
        elif key == "config" and isinstance(value, dict):
            existing_config = updated.get("config") if isinstance(updated.get("config"), dict) else {}
            updated["config"] = {**existing_config, **value}
        elif key in {"type", "entity_id", "entity_name", "title", "source", "icon", "color", "size", "renderer", "page_id"}:
            updated[key] = str(value).strip()
        elif key == "unique_id":
            val = str(value).strip()
            if val:
                updated["unique_id"] = val
            else:
                updated.pop("unique_id", None)
        elif key == "layout_column":
            normalized_column = _normalize_widget_layout_column(value)
            if normalized_column is None:
                updated.pop("layout_column", None)
            else:
                updated["layout_column"] = normalized_column
        elif key in {"col_span", "row_span"}:
            max_v = 4 if key == "col_span" else 12
            normalized_span = _normalize_widget_span(value, max_value=max_v)
            if normalized_span is None:
                updated.pop(key, None)
            else:
                updated[key] = normalized_span
        elif key in {"col_start", "row_start"}:
            max_v = 4 if key == "col_start" else 999
            normalized_start = _normalize_widget_span(value, max_value=max_v)
            if normalized_start is None:
                updated.pop(key, None)
            else:
                updated[key] = normalized_start

    if config_patch is not None or visibility_patch is not None:
        existing_config = updated.get("config") if isinstance(updated.get("config"), dict) else {}
        merged_config = {**existing_config, **(config_patch or {})}
        if visibility_patch is not None:
            merged_config["visibility"] = visibility_patch
        updated["config"] = merged_config or None

    visibility_config = _widget_visibility_config(updated)
    if isinstance(updated.get("config"), dict):
        raw_entities = updated["config"].get("entities")
        raw_entity_ids = updated["config"].get("entity_ids")
        if config_patch is not None:
            if "entities" in config_patch:
                raw_entities = config_patch.get("entities")
                raw_entity_ids = config_patch.get("entity_ids")
            elif "entity_ids" in config_patch:
                raw_entities = []
                raw_entity_ids = config_patch.get("entity_ids")
        entity_records = _normalize_widget_entity_records(raw_entities)
        record_ids = {record["entity_id"] for record in entity_records}
        for entity_id in _normalize_widget_entity_ids(raw_entity_ids):
            if entity_id not in record_ids:
                record_ids.add(entity_id)
                entity_records.append({"entity_id": entity_id})
        if entity_records:
            updated["config"]["entities"] = entity_records
            updated["config"]["entity_ids"] = [record["entity_id"] for record in entity_records]
        else:
            updated["config"].pop("entity_ids", None)
            updated["config"].pop("entities", None)
        if visibility_config is not None:
            updated["config"]["visibility"] = visibility_config
        elif "visibility" in updated["config"]:
            updated["config"].pop("visibility", None)
        if not updated["config"]:
            updated["config"] = None

    card_meta = resolve_dashboard_card(str(updated.get("type") or "").strip(), str(updated.get("renderer") or "").strip())
    updated["type"] = str(card_meta.get("id") or updated.get("type") or "button").strip() or "button"
    updated["renderer"] = str(card_meta.get("renderer") or "button").strip() or "button"
    if updated.get("size") not in {"sm", "md", "wide"}:
        updated["size"] = str(card_meta.get("default_size") or "md")

    entity_id = str(updated.get("entity_id") or "").strip()
    title = str(updated.get("title") or "").strip()
    entity_name = str(updated.get("entity_name") or "").strip()

    if not entity_id:
        entity_id = f"label.{_slugify(title or entity_name or 'section')}"
    renderer = str(card_meta.get("renderer") or _widget_renderer(updated) or "").strip()
    if not title and renderer not in _RENDERERS_WITHOUT_DEFAULT_TITLE:
        title = entity_name or entity_id
    if _widget_renderer(updated) == "label":
        entity_name = entity_name
    elif not entity_name:
        entity_name = title or entity_id

    updated["entity_id"] = entity_id
    updated["title"] = title
    updated["entity_name"] = entity_name
    updated["source"] = str(updated.get("source") or _infer_source(entity_id, entity_name)).strip()
    updated["icon"] = str(updated.get("icon") or "").strip()
    updated["color"] = str(updated.get("color") or "").strip()
    updated["favorite"] = bool(updated.get("favorite", False))
    updated["show_background"] = bool(updated.get("show_background", False))
    updated["switch_style"] = bool(updated.get("switch_style", False) or updated.get("type") == "switch")
    page_id_value = updated.get("page_id")
    if page_id_value is None or str(page_id_value).strip() == "":
        updated["page_id"] = None
    else:
        updated["page_id"] = str(page_id_value).strip()
    normalized_column = _normalize_widget_layout_column(updated.get("layout_column"))
    if normalized_column is None:
        updated.pop("layout_column", None)
    else:
        updated["layout_column"] = normalized_column
    for span_key in ("col_span", "row_span"):
        max_v = 12 if span_key == "col_span" else 8
        normalized_span = _normalize_widget_span(updated.get(span_key), max_value=max_v)
        if normalized_span is None:
            updated.pop(span_key, None)
        else:
            updated[span_key] = normalized_span
    for start_key in ("col_start", "row_start"):
        max_v = 12 if start_key == "col_start" else 999
        normalized_start = _normalize_widget_span(updated.get(start_key), max_value=max_v)
        if normalized_start is None:
            updated.pop(start_key, None)
        else:
            updated[start_key] = normalized_start
    return updated


def _normalize_widget_record(widget: dict[str, Any]) -> dict[str, Any]:
    normalized = _apply_widget_patch(widget or {}, {})
    normalized["id"] = str(normalized.get("id") or str(uuid.uuid4())[:8]).strip()
    return normalized


def _normalize_panel_pages(raw_pages: Any) -> list[dict[str, Any]]:
    """Normalize a panel's `pages` array. Returns [] when no valid pages."""
    if not isinstance(raw_pages, list):
        return []
    pages: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for idx, item in enumerate(raw_pages):
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or "").strip()
        raw_id = str(item.get("id") or "").strip()
        page_id = raw_id or _slugify(title) or f"pg_{str(uuid.uuid4())[:8]}"
        # Avoid duplicates
        base_id = page_id
        bump = 2
        while page_id in seen_ids:
            page_id = f"{base_id}_{bump}"
            bump += 1
        seen_ids.add(page_id)
        pages.append({
            "id": page_id,
            "title": title or f"Pagina {idx + 1}",
            "icon": _normalize_icon(item.get("icon"), ""),
        })
        if len(pages) >= 10:
            break
    return pages


def _normalize_panel_record(panel: dict[str, Any], index: int = 0) -> dict[str, Any]:
    raw_widgets = panel.get("widgets")
    widgets = [_normalize_widget_record(item) for item in raw_widgets] if isinstance(raw_widgets, list) else []
    title = str(panel.get("title") or "").strip()
    size = str(panel.get("size") or "md").strip()
    if size not in {"sm", "md", "wide"}:
        size = "md"
    pages = _normalize_panel_pages(panel.get("pages"))
    page_ids = {p["id"] for p in pages}
    if pages:
        # Reset stale page_id references and assign orphans to the first page.
        first_page_id = pages[0]["id"]
        for widget in widgets:
            wp = widget.get("page_id")
            if not wp or wp not in page_ids:
                widget["page_id"] = first_page_id
    else:
        # No pages defined: clear any stale page_id reference.
        for widget in widgets:
            widget["page_id"] = None
    return {
        "id": str(panel.get("id") or f"panel_{index + 1}").strip() or f"panel_{index + 1}",
        "title": title,
        "size": size,
        "icon": _normalize_icon(panel.get("icon"), ""),
        "pages": pages,
        "show_pagination": bool(panel.get("show_pagination", True)),
        "kind": "standalone" if str(panel.get("id") or "").strip() == STANDALONE_PANEL_ID or panel.get("kind") == "standalone" else "panel",
        # Free 2D grid placement (None = auto-flow / not yet positioned).
        "col_start": _normalize_widget_span(panel.get("col_start"), max_value=12),
        "row_start": _normalize_widget_span(panel.get("row_start"), max_value=999),
        "row_span": _normalize_widget_span(panel.get("row_span"), max_value=999),
        "visibility": _normalize_visibility_config(panel.get("visibility")),
        "background": _normalize_panel_background(panel.get("background")),
        "widgets": widgets,
    }


def _make_panel(title: str | None = None, widgets: list[dict[str, Any]] | None = None, panel_id: str | None = None, size: str = "md", icon: str = "", pages: list[dict[str, Any]] | None = None, show_pagination: bool = True, **_kw: Any) -> dict[str, Any]:
    return _normalize_panel_record({
        "id": str(panel_id or str(uuid.uuid4())[:8]).strip(),
        "title": str(title or "").strip(),
        "size": size if size in {"sm", "md", "wide"} else "md",
        "icon": _normalize_icon(icon, ""),
        "pages": pages or [],
        "show_pagination": bool(show_pagination),
        "widgets": widgets or [],
    })


def _section_panels_only(panels: list[dict[str, Any]]) -> list[dict[str, Any]]:
    section_panels: list[dict[str, Any]] = []
    standalone_widgets: list[dict[str, Any]] = []
    for panel in panels or []:
        if not isinstance(panel, dict):
            continue
        normalized = _normalize_panel_record(panel, len(section_panels))
        if normalized.get("kind") == "standalone" or normalized.get("id") == STANDALONE_PANEL_ID:
            standalone_widgets.extend(list(normalized.get("widgets") or []))
        else:
            section_panels.append(normalized)
    if standalone_widgets:
        if section_panels:
            section_panels[0]["widgets"] = standalone_widgets + list(section_panels[0].get("widgets") or [])
        else:
            section_panels.append(_make_panel(_DEFAULT_PANEL_TITLE, standalone_widgets, "panel_1", "wide"))
    return [_normalize_panel_record(panel, idx) for idx, panel in enumerate(section_panels)]


def _make_page(
    title: str | None = None,
    subtitle: str | None = None,
    icon: str | None = None,
    panels: list[dict[str, Any]] | None = None,
    preferences: dict[str, Any] | None = None,
    page_id: str | None = None,
    columns: int | str | None = None,
) -> dict[str, Any]:
    resolved_title = str(title or _DEFAULT_PAGE_TITLE).strip() or _DEFAULT_PAGE_TITLE
    resolved_id = str(page_id or _slugify(resolved_title) or _DEFAULT_PAGE_ID).strip() or _DEFAULT_PAGE_ID
    return {
        "id": resolved_id,
        "title": resolved_title,
        "subtitle": str(subtitle or "Panou control").strip() or "Panou control",
        "icon": _normalize_icon(icon, _DEFAULT_DASHBOARD_ICON),
        "columns": _normalize_page_columns(columns),
        "preferences": {**_DEFAULT_PREFS, **(preferences or {})},
        "panels": _section_panels_only(list(panels or [])),
    }


def _normalize_page_columns(value: Any) -> int:
    """Normalize page column count: 0 means responsive/auto, 1-4 are fixed."""
    try:
        columns = int(value or 0)
    except (TypeError, ValueError):
        columns = 0
    if columns < 0:
        return 0
    if columns > 4:
        return 4
    return columns


def _normalize_widget_layout_column(value: Any) -> int | None:
    try:
        column = int(value or 0)
    except (TypeError, ValueError):
        return None
    if column < 1:
        return None
    return min(column, 4)


def _normalize_widget_span(value: Any, *, max_value: int = 4) -> int | None:
    """Normalize a grid span (col_span / row_span). Returns int in [1, max_value] or None."""
    if value is None:
        return None
    try:
        span = int(value)
    except (TypeError, ValueError):
        return None
    if span < 1:
        return None
    return min(span, max_value)


def _normalize_page_record(page: dict[str, Any], index: int = 0) -> dict[str, Any]:
    raw_panels = page.get("panels")
    panels = _section_panels_only(raw_panels) if isinstance(raw_panels, list) else []
    title = str(page.get("title") or ("Dashboard" if index == 0 else f"{_DEFAULT_PAGE_TITLE} {index + 1}")).strip()
    title = title or ("Dashboard" if index == 0 else f"{_DEFAULT_PAGE_TITLE} {index + 1}")
    page_id = str(page.get("id") or _slugify(title) or f"page_{index + 1}").strip() or f"page_{index + 1}"
    prefs = page.get("preferences")
    if not isinstance(prefs, dict):
        prefs = {}
    theme = str(page.get("theme") or "").strip().lower()
    if theme not in {"", "default", "dark", "light", "midnight", "sunrise", "forest", "ocean"}:
        theme = ""
    parent_page_id = str(page.get("parent_page_id") or "").strip()
    return {
        "id": page_id,
        "title": title,
        "subtitle": str(page.get("subtitle") or ("Panou control" if index == 0 else "")).strip(),
        "icon": _normalize_icon(page.get("icon"), _DEFAULT_DASHBOARD_ICON),
        "columns": _normalize_page_columns(page.get("columns")),
        "preferences": {**_DEFAULT_PREFS, **prefs},
        "panels": panels,
        "theme": theme,
        "parent_page_id": parent_page_id,
    }


def _normalize_dashboard_store(dashboard: Any) -> dict[str, Any]:
    if not isinstance(dashboard, dict):
        dashboard = {}

    raw_pages = dashboard.get("pages")
    pages: list[dict[str, Any]] = []
    if isinstance(raw_pages, list) and raw_pages:
        pages = [_normalize_page_record(page, idx) for idx, page in enumerate(raw_pages) if isinstance(page, dict)]
    else:
        prefs = dashboard.get("preferences") if isinstance(dashboard.get("preferences"), dict) else {}
        panels: list[dict[str, Any]] = []
        raw_panels = dashboard.get("panels")
        if isinstance(raw_panels, list) and raw_panels:
            panels = [_normalize_panel_record(panel, idx) for idx, panel in enumerate(raw_panels) if isinstance(panel, dict)]
        else:
            legacy_widgets = dashboard.get("widgets")
            if isinstance(legacy_widgets, list) and legacy_widgets:
                panels = [_make_panel(_DEFAULT_PANEL_TITLE, legacy_widgets, "panel_1", "wide")]

        pages = [
            _make_page(
                title=str(dashboard.get("title") or "Dashboard"),
                subtitle=str(dashboard.get("subtitle") or "Acasă"),
                icon=dashboard.get("icon"),
                panels=panels,
                preferences=prefs,
                page_id=str(dashboard.get("current_page_id") or _DEFAULT_PAGE_ID),
            )
        ]

    current_page_id = str(dashboard.get("current_page_id") or "").strip()
    if not current_page_id or not any(page.get("id") == current_page_id for page in pages):
        current_page_id = str((pages[0] if pages else {}).get("id") or _DEFAULT_PAGE_ID)

    raw_templates = dashboard.get("templates") if isinstance(dashboard.get("templates"), list) else []
    templates: list[dict[str, Any]] = []
    for tmpl in raw_templates:
        if not isinstance(tmpl, dict):
            continue
        tid = str(tmpl.get("id") or "").strip()
        name = str(tmpl.get("name") or "").strip()
        widget = tmpl.get("widget") if isinstance(tmpl.get("widget"), dict) else None
        if not tid or not name or not widget:
            continue
        templates.append({"id": tid, "name": name, "widget": widget})

    return {
        "pages": pages,
        "current_page_id": current_page_id,
        "templates": templates,
    }


def _find_page(pages: list[dict[str, Any]], page_id: str | None) -> tuple[int | None, dict[str, Any] | None]:
    if not pages:
        return None, None
    resolved_id = str(page_id or "").strip()
    if resolved_id:
        for idx, page in enumerate(pages):
            if page.get("id") == resolved_id:
                return idx, page
    return 0, pages[0]


_SECTION_MIGRATION_DONE: set[str] = set()

def _migrate_to_section_layout(page: dict[str, Any]) -> bool:
    """One-time migration: convert 12-col widget spans to 4-col section layout.

    Returns True if any changes were made.
    """
    page_id = page.get("id") or _DEFAULT_PAGE_ID
    if page_id in _SECTION_MIGRATION_DONE:
        return False
    panels = page.get("panels") or []
    needs_migration = False
    for panel in panels:
        for widget in (panel.get("widgets") or []):
            if widget.get("col_span_v2") or (isinstance(widget.get("col_span"), (int, float)) and widget["col_span"] > 4):
                needs_migration = True
                break
        if needs_migration:
            break
    if not needs_migration:
        _SECTION_MIGRATION_DONE.add(page_id)
        return False

    log.info("Migrating dashboard page %s to section-based 4-col layout", page_id)
    for panel in panels:
        panel.pop("size", None)
        panel.pop("col_start", None)
        panel.pop("row_start", None)
        panel.pop("row_span", None)
        for widget in (panel.get("widgets") or []):
            old_col = widget.get("col_span")
            if isinstance(old_col, (int, float)) and old_col > 4:
                if old_col <= 3:
                    widget["col_span"] = 1
                elif old_col <= 6:
                    widget["col_span"] = 2
                elif old_col <= 9:
                    widget["col_span"] = 3
                else:
                    widget["col_span"] = 4
            widget.pop("col_span_v2", None)
            widget.pop("col_start", None)
            widget.pop("row_start", None)

    _SECTION_MIGRATION_DONE.add(page_id)
    return True


def _read_dashboard_raw() -> dict[str, Any]:
    """Load the dashboard store (pages/current_page_id/templates) from files."""
    try:
        return dashboard_store.load_store()
    except Exception:
        log.exception("dashboard store load failed; falling back to empty store")
        return {"pages": [], "current_page_id": "", "templates": []}


def _write_dashboard_raw(payload: dict[str, Any]) -> None:
    """Persist the dashboard store to files, preserving templates if omitted."""
    data = dict(payload or {})
    if "templates" not in data:
        try:
            data["templates"] = dashboard_store.load_store().get("templates") or []
        except Exception:
            data["templates"] = []
    dashboard_store.save_store(data)


def _dashboard_section(page_id: str | None = None) -> dict[str, Any]:
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    _, page = _find_page(store.get("pages") or [], page_id or store.get("current_page_id"))
    page = page or _make_page(page_id=_DEFAULT_PAGE_ID)

    if _migrate_to_section_layout(page):
        _save_dashboard(
            {
                "page_id": page.get("id") or _DEFAULT_PAGE_ID,
                "pages": store.get("pages") or [],
                "current_page_id": store.get("current_page_id") or page.get("id") or _DEFAULT_PAGE_ID,
                "panels": list(page.get("panels") or []),
                "preferences": page.get("preferences") or {},
                "title": page.get("title"),
                "subtitle": page.get("subtitle"),
                "icon": page.get("icon"),
                "columns": page.get("columns"),
                "theme": page.get("theme"),
                "parent_page_id": page.get("parent_page_id"),
            },
            page.get("id") or page_id,
        )

    return {
        "page_id": page.get("id") or _DEFAULT_PAGE_ID,
        "pages": store.get("pages") or [],
        "current_page_id": store.get("current_page_id") or page.get("id") or _DEFAULT_PAGE_ID,
        "panels": _section_panels_only(list(page.get("panels") or [])),
        "preferences": {**_DEFAULT_PREFS, **(page.get("preferences") or {})},
        "title": str(page.get("title") or "Dashboard"),
        "subtitle": str(page.get("subtitle") or "Acasă"),
        "icon": _normalize_icon(page.get("icon"), _DEFAULT_DASHBOARD_ICON),
        "columns": _normalize_page_columns(page.get("columns")),
        "theme": str(page.get("theme") or ""),
        "parent_page_id": str(page.get("parent_page_id") or ""),
    }


def _dashboard_user_prefs(username: str | None) -> dict[str, Any]:
    """Per-user dashboard preferences stored under config dashboard.user_prefs.

    The dashboard layout itself stays central (Home Assistant-style); only the
    viewer's own default page is kept per account.
    """
    if not username:
        return {}
    cfg = settings.reload_config()
    store = cfg.get("dashboard") if isinstance(cfg.get("dashboard"), dict) else {}
    prefs = store.get("user_prefs") if isinstance(store.get("user_prefs"), dict) else {}
    entry = prefs.get(username)
    return dict(entry) if isinstance(entry, dict) else {}


def _user_default_page_id(username: str | None) -> str | None:
    pid = str(_dashboard_user_prefs(username).get("default_page_id") or "").strip()
    return pid or None


def _set_user_default_page_id(username: str | None, page_id: str | None) -> None:
    if not username:
        return
    cfg = settings.reload_config()
    store = cfg.get("dashboard") if isinstance(cfg.get("dashboard"), dict) else {}
    prefs = dict(store.get("user_prefs") if isinstance(store.get("user_prefs"), dict) else {})
    entry = dict(prefs.get(username) if isinstance(prefs.get(username), dict) else {})
    cleaned = str(page_id or "").strip()
    if cleaned:
        entry["default_page_id"] = cleaned
    else:
        entry.pop("default_page_id", None)
    if entry:
        prefs[username] = entry
    else:
        prefs.pop(username, None)
    # Shallow-merged into the dashboard dict; pages/templates are untouched.
    settings.save_config({"dashboard": {"user_prefs": prefs}})
    settings.reload_config()


def _save_dashboard(section: dict[str, Any], page_id: str | None = None) -> None:
    store = _normalize_dashboard_store({
        "pages": section.get("pages") or [],
        "current_page_id": section.get("current_page_id") or section.get("page_id") or page_id,
    })
    target_page_id = str(page_id or section.get("page_id") or store.get("current_page_id") or _DEFAULT_PAGE_ID).strip() or _DEFAULT_PAGE_ID
    page_idx, page = _find_page(store.get("pages") or [], target_page_id)
    pages = list(store.get("pages") or [])
    if page is None or page_idx is None:
        pages.append(
            _normalize_page_record(
                {
                    "id": target_page_id,
                    "title": str(section.get("title") or "Dashboard"),
                    "subtitle": str(section.get("subtitle") or "Acasă"),
                    "icon": _normalize_icon(section.get("icon"), _DEFAULT_DASHBOARD_ICON),
                    "columns": _normalize_page_columns(section.get("columns")),
                    "preferences": {**_DEFAULT_PREFS, **(section.get("preferences") or {})},
                    "panels": _section_panels_only(list(section.get("panels") or [])),
                },
                len(pages),
            )
        )
    else:
        merged = {
            **page,
            "id": target_page_id,
            "title": str(section.get("title") or page.get("title") or "Dashboard"),
            "subtitle": str(section.get("subtitle") or page.get("subtitle") or "Acasă"),
            "icon": _normalize_icon(section.get("icon") or page.get("icon"), _DEFAULT_DASHBOARD_ICON),
            "columns": _normalize_page_columns(section.get("columns", page.get("columns", 0))),
            "preferences": {**_DEFAULT_PREFS, **(section.get("preferences") or page.get("preferences") or {})},
            "panels": _section_panels_only(list(section.get("panels") or page.get("panels") or [])),
        }
        if "theme" in section:
            merged["theme"] = section.get("theme") or ""
        if "parent_page_id" in section:
            merged["parent_page_id"] = section.get("parent_page_id") or ""
        pages[page_idx] = _normalize_page_record(merged, page_idx)

    payload = {
        "pages": [_normalize_page_record(page, idx) for idx, page in enumerate(pages)],
        "current_page_id": target_page_id,
    }
    existing_cfg = settings.reload_config()
    existing_store = _normalize_dashboard_store(_read_dashboard_raw())
    payload["templates"] = existing_store.get("templates") or []
    _write_dashboard_raw(payload)
    settings.reload_config()


def _all_panel_widgets(section: dict[str, Any]) -> list[dict[str, Any]]:
    widgets: list[dict[str, Any]] = []
    for panel in section.get("panels") or []:
        widgets.extend(list(panel.get("widgets") or []))
    return widgets


def _find_panel(section: dict[str, Any], panel_id: str) -> tuple[int | None, dict[str, Any] | None]:
    panels = section.get("panels") or []
    for idx, panel in enumerate(panels):
        if panel.get("id") == panel_id:
            return idx, panel
    return None, None


def _find_widget(section: dict[str, Any], widget_id: str) -> tuple[int | None, dict[str, Any] | None, int | None, dict[str, Any] | None]:
    panels = section.get("panels") or []
    for panel_idx, panel in enumerate(panels):
        widgets = panel.get("widgets") or []
        for widget_idx, widget in enumerate(widgets):
            if widget.get("id") == widget_id:
                return panel_idx, panel, widget_idx, widget
    return None, None, None, None


def _find_widget_any_page(widget_id: str, page_id: str | None = None) -> dict[str, Any] | None:
    section = _dashboard_section(page_id)
    _, _, _, widget = _find_widget(section, widget_id)
    if widget is not None:
        return widget
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    for page in store.get("pages") or []:
        candidate = {"panels": _section_panels_only(list(page.get("panels") or []))}
        _, _, _, widget = _find_widget(candidate, widget_id)
        if widget is not None:
            return widget
    return None
