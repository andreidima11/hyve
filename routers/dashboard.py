from __future__ import annotations

import asyncio
import logging
import re
import time as _time
import unicodedata
import uuid
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

import auth
import database
import models
import settings
from core import dashboard_store
from addons.entity_store import get_entity_store
from integrations import get_integration_manager
from integrations.extractors import (
    extract_fusion_solar_candidates as _extract_fusion_solar_candidates,
    extract_pago_candidates as _extract_pago_candidates,
    extract_weather_candidates as _extract_weather_candidates,
    extract_z2m_widget_candidates as _extract_z2m_candidates,
    infer_source as _infer_source,
    normalize_entities as _normalize_entities,
)
from routers import scenes as scenes_module
from smart_home_registry import controllable_domains, entity_domain, is_controllable_domain, normalize_entity_record, visible_domains
from ui_catalog import dashboard_card_catalog, resolve_dashboard_card

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])

log = logging.getLogger("dashboard")

# Short-lived cache for the merged entity list. Multiple dashboard WS
# connections poll _available_entities() every 1.5s; without a cache each
# connection rebuilds + re-applies aliases independently.
_AVAIL_TTL = 5.0
_AVAIL_CACHE: dict[str, Any] = {"data": None, "t": 0.0}
_AVAIL_BUILD_LOCK: asyncio.Lock | None = None

_SWITCH_DOMAINS = controllable_domains()
_INFO_DOMAINS = visible_domains() - _SWITCH_DOMAINS
_VISIBLE_DOMAINS = visible_domains()
_DEFAULT_PREFS = {
    "layout_mode": "comfortable",
    "show_unavailable": True,
    "filter_mode": "all",
}
_DEFAULT_PANEL_TITLE = "Panou"
STANDALONE_PANEL_ID = "__standalone__"
_DEFAULT_PAGE_ID = "dashboard_home"
_DEFAULT_PAGE_TITLE = "Acasă"
_DEFAULT_DASHBOARD_ICON = "fas fa-table-cells-large"
_FA_STYLE_TOKENS = {
    "fas",
    "far",
    "fal",
    "fat",
    "fad",
    "fab",
    "fa-solid",
    "fa-regular",
    "fa-light",
    "fa-thin",
    "fa-duotone",
    "fa-brands",
}
_FA_ICON_RE = re.compile(r"^fa-[a-z0-9-]+$")
_MDI_ICON_RE = re.compile(r"^mdi[:\-][a-z0-9-]+$")
_MDI_NAME_RE = re.compile(r"^[a-z0-9-]+$")
_VISIBILITY_OPERATORS = {
    "is",
    "is_not",
    "==",
    "!=",
    ">",
    ">=",
    "<",
    "<=",
}


class DashboardWidgetBody(BaseModel):
    type: str = "button"
    entity_id: str = Field(min_length=1)
    entity_name: str = ""
    title: str = ""
    panel_id: str | None = None
    page_id: str | None = None
    source: str = "zigbee2mqtt"
    icon: str | None = None
    color: str | None = None
    size: Literal["sm", "md", "wide"] = "md"
    favorite: bool = False
    show_background: bool = False
    switch_style: bool = False
    renderer: str | None = None
    config: dict[str, Any] | None = None
    col_span: int | None = None
    row_span: int | None = None
    col_start: int | None = None
    row_start: int | None = None
    visibility: dict[str, Any] | None = None


class DashboardToggleBody(BaseModel):
    desired_state: Literal["on", "off"] | None = None
    entity_id: str | None = None
    action: str | None = None
    data: dict[str, Any] | None = None


class DashboardPreferencesBody(BaseModel):
    layout_mode: Literal["comfortable", "compact"] = "comfortable"
    show_unavailable: bool = True
    filter_mode: Literal["all", "switch", "info", "zigbee2mqtt", "pago", "fusion_solar"] = "all"
    title: str = "Dashboard"
    subtitle: str = "Acasă"
    icon: str = _DEFAULT_DASHBOARD_ICON


class DashboardPageBody(BaseModel):
    title: str = _DEFAULT_PAGE_TITLE
    subtitle: str = "Panou control"
    icon: str = _DEFAULT_DASHBOARD_ICON
    columns: int = 0


class DashboardPageUpdateBody(BaseModel):
    title: str = _DEFAULT_PAGE_TITLE
    subtitle: str = "Panou control"
    icon: str = _DEFAULT_DASHBOARD_ICON
    columns: int | None = None
    theme: str | None = None
    parent_page_id: str | None = None


class DashboardMoveBody(BaseModel):
    direction: Literal["left", "right", "up", "down"] = "right"


class DashboardPanelPageBody(BaseModel):
    id: str | None = None
    title: str = ""
    icon: str = ""


class DashboardPanelBody(BaseModel):
    title: str = ""
    size: Literal["sm", "md", "wide"] = "md"
    icon: str = ""
    pages: list[DashboardPanelPageBody] | None = None
    show_pagination: bool = True


class DashboardPanelUpdateBody(BaseModel):
    title: str = ""
    size: Literal["sm", "md", "wide"] = "md"
    icon: str = ""
    pages: list[DashboardPanelPageBody] | None = None
    show_pagination: bool = True
    visibility: dict[str, Any] | None = None
    background: dict[str, Any] | None = None


class DashboardPanelLayoutBody(BaseModel):
    col_start: int | None = None
    row_start: int | None = None
    row_span: int | None = None


class DashboardReorderBody(BaseModel):
    target_id: str = Field(min_length=1)


class DashboardWidgetRelocateBody(BaseModel):
    target_panel_id: str = Field(min_length=1)
    target_page_id: str | None = None
    before_widget_id: str | None = None
    layout_column: int | None = None


class DashboardWidgetUpdateBody(BaseModel):
    type: str | None = None
    entity_id: str | None = None
    entity_name: str | None = None
    title: str | None = None
    panel_id: str | None = None
    page_id: str | None = None
    source: str | None = None
    icon: str | None = None
    color: str | None = None
    size: Literal["sm", "md", "wide"] | None = None
    favorite: bool | None = None
    show_background: bool | None = None
    switch_style: bool | None = None
    renderer: str | None = None
    config: dict[str, Any] | None = None
    layout_column: int | None = None
    col_span: int | None = None
    row_span: int | None = None
    col_start: int | None = None
    row_start: int | None = None
    visibility: dict[str, Any] | None = None


@router.get("/catalog")
async def get_dashboard_catalog(user: models.User = Depends(auth.get_current_user)):
    return {"cards": dashboard_card_catalog()}


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
        entity_id = str(item.get("entity_id") if isinstance(item, dict) else item or "").strip()
        if not entity_id or entity_id in seen:
            continue
        seen.add(entity_id)
        record = {"entity_id": entity_id}
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
        if not entity_id or entity_id in seen:
            return
        seen.add(entity_id)
        records.append({key: value for key, value in record.items() if value})

    primary = str(widget.get("entity_id") or "").strip()
    if primary:
        add(configured_by_id.get(primary) or {"entity_id": primary})
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
    return [record["entity_id"] for record in _widget_entity_records(widget)]


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


def _available_entities_cache_hit() -> list[dict[str, Any]] | None:
    now = _time.monotonic()
    cached = _AVAIL_CACHE.get("data")
    if cached is not None and (now - _AVAIL_CACHE["t"]) < _AVAIL_TTL:
        return cached
    return None


def _available_entities_lock() -> asyncio.Lock:
    global _AVAIL_BUILD_LOCK
    if _AVAIL_BUILD_LOCK is None:
        _AVAIL_BUILD_LOCK = asyncio.Lock()
    return _AVAIL_BUILD_LOCK


def _build_available_entities_uncached() -> list[dict[str, Any]]:
    """Build the merged entity list without reading or writing the TTL cache."""

    merged: list[dict[str, Any]] = []
    seen: set[str] = set()

    try:
        manager = get_integration_manager()
        store = get_entity_store()
        for integration in manager.all_instances():
            if integration.supports_sync and not manager._is_bootstrap_eligible(integration):
                continue
            if not integration.supports_sync:
                continue
            try:
                stored = store.get_entities(integration.store_key) or {}
                payload = stored.get("entities") or {}
                # Let the integration merge live runtime state (e.g. MQTT
                # bridge cache) over the durable stored snapshot. Without
                # this, non-retained MQTT state messages (Z2M default)
                # never reach the dashboard until the next change event.
                try:
                    payload = integration.live_payload(payload)
                except Exception:
                    pass
                for item in integration.extract_entities(payload):
                    item.setdefault("entry_id", integration.entry_id or "")
                    item.setdefault("entry_title", integration.entry_title or integration.label or integration.slug)
                    normalize_entity_record(item, default_source=integration.slug)
                    eid = item.get("entity_id")
                    if eid and eid not in seen:
                        seen.add(eid)
                        merged.append(item)
            except Exception:
                continue
    except Exception:
        pass

    merged.sort(key=lambda item: (item.get("source") not in {"zigbee2mqtt", "pago", "fusion_solar", "open_meteo"}, item.get("name") or ""))
    # Apply per-integration device renames (Settings → Integrări) so the
    # entity picker shows the user-chosen device names instead of raw IEEE.
    try:
        from integrations import device_aliases
        by_slug: dict[str, list[dict[str, Any]]] = {}
        for ent in merged:
            by_slug.setdefault(str(ent.get("source") or ""), []).append(ent)
        for slug, items in by_slug.items():
            if slug:
                device_aliases.apply_to_entities(slug, items)
    except Exception:
        pass
    store = get_entity_store()
    store.apply_overrides(merged)
    return merged


async def _available_entities() -> list[dict[str, Any]]:
    """Build the merged entity list.

    Dashboard websocket connections poll this frequently. Keep the expensive
    SQLite/normalization work off the main event loop so a stuck DB pool or
    integration snapshot cannot freeze the whole HTTP server.
    """
    cached = _available_entities_cache_hit()
    if cached is not None:
        return cached

    async with _available_entities_lock():
        cached = _available_entities_cache_hit()
        if cached is not None:
            return cached
        try:
            merged = await asyncio.wait_for(
                asyncio.to_thread(_build_available_entities_uncached),
                timeout=8.0,
            )
        except Exception as exc:
            log.warning("available entity refresh failed: %s", exc)
            return _AVAIL_CACHE.get("data") or []

    _AVAIL_CACHE["data"] = merged
    _AVAIL_CACHE["t"] = _time.monotonic()
    return merged


def invalidate_available_entities_cache() -> None:
    """Drop the cached entity list (call after a manual sync or entity update)."""
    _AVAIL_CACHE["data"] = None
    _AVAIL_CACHE["t"] = 0.0


def _scene_synthetic_entities(db: Session, user: models.User) -> list[dict[str, Any]]:
    """Expose scenes as synthetic entities so the dashboard picker can target them.

    entity_id: scene.<scene_id>; controllable; clicking will activate the scene.
    """
    try:
        rows = scenes_module._query_visible(db, user).all()
    except Exception:
        return []
    out: list[dict[str, Any]] = []
    for row in rows:
        if not row.enabled:
            continue
        out.append({
            "entity_id": f"scene.{row.id}",
            "name": row.name or row.id,
            "domain": "scene",
            "source": "scenes",
            "state": "ready",
            "unit": "",
            "controllable": True,
            "attributes": {
                "icon": row.icon or "",
                "color": row.color or "",
                "description": row.description or "",
                "entry_count": 0,
                "last_activated_at": row.last_activated_at.isoformat() if row.last_activated_at else None,
            },
        })
    return out


def _hydrate_widgets(widgets: list[dict[str, Any]], entity_items: list[dict[str, Any]], viewer: str | None = None) -> list[dict[str, Any]]:
    # Index by both the HA-style entity_id AND the legacy unique_id so widgets
    # saved before the rename keep resolving against current state snapshots.
    entity_map: dict[str, dict[str, Any]] = {}
    for item in entity_items:
        eid = item.get("entity_id")
        if eid:
            entity_map[eid] = item
        uid = item.get("unique_id")
        if uid and uid not in entity_map:
            entity_map[uid] = item
    result: list[dict[str, Any]] = []
    for widget in widgets:
        entity = entity_map.get(widget.get("entity_id"), {})
        hydrated_entities: list[dict[str, Any]] = []
        for entity_record in _widget_entity_records(widget):
            entity_id = entity_record["entity_id"]
            item = entity_map.get(entity_id, {})
            hydrated_entities.append({
                "entity_id": entity_id,
                "title": entity_record.get("title") or "",
                "subtitle": entity_record.get("subtitle") or "",
                "entity_name": item.get("name") or entity_id,
                "current_state": item.get("state", "unknown"),
                "domain": item.get("domain") or entity_domain(entity_id),
                "available": bool(item),
                "unit": item.get("unit") or "",
                "attributes": item.get("attributes") or {},
                "controllable": bool(item.get("controllable", _widget_renderer(widget) == "button")),
                "source": item.get("source") or _infer_source(entity_id, item.get("name") or entity_id),
                "unique_id": item.get("unique_id") or "",
                "entry_id": item.get("entry_id") or "",
            })
        visibility = _widget_visibility_config(widget)
        # Refresh the widget's source from whichever integration currently owns
        # the entity. Cards saved with a stale/default slug (e.g. the legacy
        # 'zigbee2mqtt' default) would otherwise keep routing/labeling against
        # the wrong integration even though control resolves the real owner.
        resolved_source = str(entity.get("source") or "").strip()
        hydrated = {
            **widget,
            "current_state": entity.get("state", "unknown"),
            "domain": entity.get("domain") or widget.get("domain") or "switch",
            "available": bool(entity),
            "unit": entity.get("unit") or "",
            "attributes": entity.get("attributes") or widget.get("attributes") or {},
            "controllable": bool(entity.get("controllable", _widget_renderer(widget) == "button")),
            "visible": _evaluate_widget_visibility(widget, entity_map, viewer),
        }
        if resolved_source:
            hydrated["source"] = resolved_source
        if hydrated_entities:
            hydrated["entities"] = hydrated_entities
        if visibility is not None:
            hydrated["visibility"] = visibility
        result.append(hydrated)
    return result


def _hydrate_panels(panels: list[dict[str, Any]], entity_items: list[dict[str, Any]], viewer: str | None = None) -> list[dict[str, Any]]:
    entity_map: dict[str, dict[str, Any]] = {}
    for item in entity_items:
        eid = item.get("entity_id")
        if eid:
            entity_map[eid] = item
        uid = item.get("unique_id")
        if uid and uid not in entity_map:
            entity_map[uid] = item
    hydrated: list[dict[str, Any]] = []
    for panel in (panels or []):
        visibility = _panel_visibility_config(panel)
        background = _normalize_panel_background(panel.get("background"))
        record = {
            "id": str(panel.get("id") or ""),
            "title": str(panel.get("title") or ""),
            "size": str(panel.get("size") or "wide"),
            "icon": _normalize_icon(panel.get("icon"), ""),
            "pages": _normalize_panel_pages(panel.get("pages")),
            "show_pagination": bool(panel.get("show_pagination", True)),
            "col_start": _normalize_widget_span(panel.get("col_start"), max_value=12),
            "row_start": _normalize_widget_span(panel.get("row_start"), max_value=999),
            "row_span": _normalize_widget_span(panel.get("row_span"), max_value=999),
            "kind": "standalone" if str(panel.get("id") or "").strip() == STANDALONE_PANEL_ID or panel.get("kind") == "standalone" else "panel",
            "visible": _evaluate_panel_visibility(panel, entity_map, viewer),
            "widgets": _hydrate_widgets(list(panel.get("widgets") or []), entity_items, viewer),
        }
        if visibility is not None:
            record["visibility"] = visibility
        if background is not None:
            record["background"] = background
        hydrated.append(record)
    return hydrated


def _panel_entity_ids(panels: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for panel in panels or []:
        for widget in panel.get("widgets") or []:
            entity_id = str(widget.get("entity_id") or "").strip()
            if entity_id:
                ids.add(entity_id)
            ids.update(_widget_entity_ids(widget))
    return ids


def _page_entity_ids(pages: list[dict[str, Any]]) -> set[str]:
    ids: set[str] = set()
    for page in pages or []:
        ids.update(_panel_entity_ids(list(page.get("panels") or [])))
    return ids


def _entities_for_dashboard(
    entity_items: list[dict[str, Any]],
    panels: list[dict[str, Any]],
    pages: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    wanted = _panel_entity_ids(panels)
    wanted.update(_page_entity_ids(list(pages or [])))
    if not wanted:
        return []
    return [
        item for item in entity_items
        if item.get("entity_id") in wanted or item.get("unique_id") in wanted
    ]


def _page_summary(page: dict[str, Any]) -> dict[str, Any]:
    panels = list(page.get("panels") or [])
    widget_count = sum(len(panel.get("widgets") or []) for panel in panels)
    return {
        "id": str(page.get("id") or ""),
        "title": str(page.get("title") or _DEFAULT_PAGE_TITLE),
        "subtitle": str(page.get("subtitle") or ""),
        "icon": _normalize_icon(page.get("icon"), _DEFAULT_DASHBOARD_ICON),
        "columns": _normalize_page_columns(page.get("columns")),
        "panel_count": len(panels),
        "widget_count": widget_count,
        "theme": str(page.get("theme") or ""),
        "parent_page_id": str(page.get("parent_page_id") or ""),
    }


@router.get("/history")
async def get_entity_history(
    entity_id: str,
    hours: float = 24.0,
    _: models.User = Depends(auth.get_current_user),
):
    """Return numeric state history for `entity_id` over the last `hours`.

    Used by the dashboard to render sparkline charts on sensor cards.
    """
    from core.entity_history import get_history

    points = get_history(entity_id, hours=hours)
    return {"entity_id": entity_id, "hours": hours, "points": points}


@router.get("/pages")
async def list_dashboard_pages(user: models.User = Depends(auth.get_current_user)):
    section = _dashboard_section()
    return {
        "pages": [_page_summary(page) for page in (section.get("pages") or [])],
        "current_page_id": section.get("current_page_id") or section.get("page_id") or _DEFAULT_PAGE_ID,
        "default_page_id": _user_default_page_id(getattr(user, "username", None)),
    }


class DashboardDefaultPageBody(BaseModel):
    page_id: str | None = None


@router.patch("/preferences/default-page")
async def set_dashboard_default_page(data: DashboardDefaultPageBody, user: models.User = Depends(auth.get_current_user)):
    """Set (or clear) the requesting user's default dashboard page (HA default_panel)."""
    page_id = str(data.page_id or "").strip() or None
    if page_id:
        section = _dashboard_section()
        valid = {str(p.get("id") or "") for p in (section.get("pages") or [])}
        if page_id not in valid:
            raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
    _set_user_default_page_id(getattr(user, "username", None), page_id)
    return {"status": "ok", "default_page_id": page_id}


class DashboardTemplateSaveBody(BaseModel):
    name: str = Field(min_length=1)
    widget_id: str | None = None
    widget: dict[str, Any] | None = None


class DashboardTemplateInstantiateBody(BaseModel):
    panel_id: str | None = None
    page_id: str | None = None


def _save_templates(templates: list[dict[str, Any]]) -> None:
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    payload = {
        "pages": store.get("pages") or [],
        "current_page_id": store.get("current_page_id") or _DEFAULT_PAGE_ID,
        "templates": templates,
    }
    _write_dashboard_raw(payload)
    settings.reload_config()


def _strip_widget_for_template(widget: dict[str, Any]) -> dict[str, Any]:
    result = {k: v for k, v in widget.items() if k not in {"id", "current_state", "available", "entity_state", "panel_id", "page_id"}}
    return result


@router.get("/templates")
async def list_dashboard_templates(_: models.User = Depends(auth.get_current_user)):
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    return {"templates": store.get("templates") or []}


@router.post("/templates")
async def save_dashboard_template(data: DashboardTemplateSaveBody, _: models.User = Depends(auth.get_current_admin)):
    name = data.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.template_name_required"})
    widget_payload: dict[str, Any] | None = None
    if isinstance(data.widget, dict) and data.widget:
        widget_payload = data.widget
    elif data.widget_id:
        section = _dashboard_section()
        for page in (section.get("pages") or [section]):
            for panel in (page.get("panels") or section.get("panels") or []):
                for w in (panel.get("widgets") or []):
                    if str(w.get("id")) == str(data.widget_id):
                        widget_payload = w
                        break
        if widget_payload is None:
            # Search across all pages.
            cfg = settings.reload_config()
            store = _normalize_dashboard_store(_read_dashboard_raw())
            for page in store.get("pages") or []:
                for panel in page.get("panels") or []:
                    for w in panel.get("widgets") or []:
                        if str(w.get("id")) == str(data.widget_id):
                            widget_payload = w
                            break
    if not widget_payload:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    templates = list(store.get("templates") or [])
    new_template = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "widget": _strip_widget_for_template(widget_payload),
    }
    templates.append(new_template)
    _save_templates(templates)
    return {"status": "ok", "template": new_template}


@router.delete("/templates/{template_id}")
async def delete_dashboard_template(template_id: str, _: models.User = Depends(auth.get_current_admin)):
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    templates = [t for t in (store.get("templates") or []) if str(t.get("id")) != str(template_id)]
    _save_templates(templates)
    return {"status": "ok"}


@router.post("/templates/{template_id}/instantiate")
async def instantiate_dashboard_template(
    template_id: str,
    data: DashboardTemplateInstantiateBody,
    _: models.User = Depends(auth.get_current_admin),
):
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    template = next((t for t in (store.get("templates") or []) if str(t.get("id")) == str(template_id)), None)
    if not template:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.template_not_found"})
    widget_data = dict(template.get("widget") or {})
    widget_data["id"] = uuid.uuid4().hex[:12]
    target_page_id = (data.page_id or store.get("current_page_id") or _DEFAULT_PAGE_ID).strip()
    section = _dashboard_section(target_page_id)
    panels = list(section.get("panels") or [])
    target_panel_id = (data.panel_id or "").strip()
    target_panel = None
    for panel in panels:
        if panel.get("id") == target_panel_id:
            target_panel = panel
            break
    if target_panel is None and panels:
        target_panel = panels[0]
    if target_panel is None:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.no_panel_for_widget"})
    target_panel.setdefault("widgets", []).append(widget_data)
    section["panels"] = panels
    _save_dashboard(section, target_page_id)
    return {"status": "ok", "widget_id": widget_data["id"]}


@router.get("/export")
async def export_dashboard(
    page_id: str | None = None,
    _: models.User = Depends(auth.get_current_user),
):
    """Export dashboard config as a portable JSON document.

    If ``page_id`` is provided, exports only that page; otherwise exports the
    whole dashboard store (all pages + current page id).
    """
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    pages = store.get("pages") or []
    if page_id:
        _, page = _find_page(pages, page_id)
        if page is None:
            raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
        export_pages = [page]
    else:
        export_pages = pages
    return {
        "version": 1,
        "kind": "hyve.dashboard",
        "exported_page_id": page_id,
        "current_page_id": store.get("current_page_id"),
        "pages": export_pages,
    }


class DashboardImportBody(BaseModel):
    payload: dict[str, Any] = Field(..., description="Exported dashboard JSON")
    mode: Literal["replace", "merge"] = "merge"


@router.post("/import")
async def import_dashboard(
    data: DashboardImportBody,
    _: models.User = Depends(auth.get_current_admin),
):
    """Import a previously exported dashboard JSON.

    - ``mode="replace"``: replace the entire dashboard store with the import.
    - ``mode="merge"``: append imported pages (with new ids) to existing ones.
    """
    payload = data.payload or {}
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Invalid payload")
    if payload.get("kind") and payload.get("kind") != "hyve.dashboard":
        raise HTTPException(status_code=400, detail="Unsupported export kind")
    incoming_pages_raw = payload.get("pages")
    if not isinstance(incoming_pages_raw, list) or not incoming_pages_raw:
        raise HTTPException(status_code=400, detail="No pages to import")

    cfg = settings.reload_config()
    existing_store = _normalize_dashboard_store(_read_dashboard_raw())
    existing_pages = list(existing_store.get("pages") or [])

    if data.mode == "replace":
        merged_pages_raw = list(incoming_pages_raw)
        next_current = payload.get("current_page_id")
    else:
        # Merge: re-id every imported page so we never collide with existing ids.
        existing_ids = {str(p.get("id") or "") for p in existing_pages}
        merged_pages_raw = list(existing_pages)
        for page in incoming_pages_raw:
            if not isinstance(page, dict):
                continue
            new_page = dict(page)
            base_id = str(page.get("id") or _DEFAULT_PAGE_ID)
            new_id = base_id
            suffix = 2
            while new_id in existing_ids:
                new_id = f"{base_id}_{suffix}"
                suffix += 1
            new_page["id"] = new_id
            existing_ids.add(new_id)
            merged_pages_raw.append(new_page)
        next_current = existing_store.get("current_page_id")

    normalized_pages = [
        _normalize_page_record(page, idx)
        for idx, page in enumerate(merged_pages_raw)
        if isinstance(page, dict)
    ]
    if not normalized_pages:
        raise HTTPException(status_code=400, detail="Import produced no valid pages")

    if not next_current or not any(p.get("id") == next_current for p in normalized_pages):
        next_current = normalized_pages[0].get("id") or _DEFAULT_PAGE_ID

    _write_dashboard_raw({"pages": normalized_pages, "current_page_id": next_current})
    settings.reload_config()
    return {
        "status": "ok",
        "imported": len(incoming_pages_raw),
        "total_pages": len(normalized_pages),
        "current_page_id": next_current,
    }


@router.post("/pages")
async def create_dashboard_page(data: DashboardPageBody, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section()
    pages = list(section.get("pages") or [])
    raw_title = (data.title or "").strip()
    # Require an explicit title so we never silently coin a duplicate
    # `acasa_2` from the Pydantic default. Frontend validates too; this is
    # the backstop for direct API callers.
    if not raw_title:
        raise HTTPException(status_code=400, detail={"key": "dashboard.title_required"})
    taken = {str(p.get("id") or "") for p in pages}
    new_id = _unique_page_id(_page_slug(raw_title), taken)
    page = _make_page(
        title=raw_title,
        subtitle=data.subtitle,
        icon=data.icon,
        panels=[],
        preferences=_DEFAULT_PREFS,
        page_id=new_id,
        columns=data.columns,
    )
    pages.append(page)
    _save_dashboard(
        {
            **section,
            "pages": pages,
            "page_id": page.get("id"),
            "current_page_id": page.get("id"),
            "title": page.get("title"),
            "subtitle": page.get("subtitle"),
            "icon": page.get("icon"),
            "columns": page.get("columns"),
            "preferences": page.get("preferences") or dict(_DEFAULT_PREFS),
            "panels": list(page.get("panels") or []),
        },
        page.get("id"),
    )
    return {
        "status": "ok",
        "page": _page_summary(page),
        "current_page_id": page.get("id"),
    }


@router.post("/pages/{page_id}/reorder")
async def reorder_dashboard_page(page_id: str, data: DashboardReorderBody, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section()
    pages = list(section.get("pages") or [])
    from_idx = next((i for i, item in enumerate(pages) if item.get("id") == page_id), None)
    target_idx = next((i for i, item in enumerate(pages) if item.get("id") == data.target_id), None)
    if from_idx is None or target_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
    if from_idx == target_idx:
        return {"status": "ok", "pages": [_page_summary(page) for page in pages]}
    moved = pages.pop(from_idx)
    pages.insert(target_idx, moved)
    current_page_id = section.get("current_page_id") or page_id
    _save_dashboard({**section, "pages": pages, "current_page_id": current_page_id}, current_page_id)
    return {
        "status": "ok",
        "pages": [_page_summary(page) for page in pages],
        "current_page_id": current_page_id,
    }


@router.patch("/pages/{page_id}")
async def update_dashboard_page(page_id: str, data: DashboardPageUpdateBody, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    if section.get("page_id") != page_id:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
    # Capture the previous title BEFORE we mutate `section`, so we can decide
    # whether the id should follow a renamed title.
    previous_title = (section.get("title") or "").strip()
    section["title"] = (data.title or _DEFAULT_PAGE_TITLE).strip() or _DEFAULT_PAGE_TITLE
    section["subtitle"] = (data.subtitle or "Panou control").strip() or "Panou control"
    section["icon"] = _normalize_icon(data.icon, _DEFAULT_DASHBOARD_ICON)
    if data.columns is not None:
        section["columns"] = _normalize_page_columns(data.columns)
    if data.theme is not None:
        section["theme"] = str(data.theme or "").strip().lower()
    if data.parent_page_id is not None:
        section["parent_page_id"] = str(data.parent_page_id or "").strip()

    # Re-derive the page id ONLY when the title actually changed. Opening the
    # edit modal and clicking Save without touching the title must never
    # silently rebrand the id (that was the original cause of the
    # "Acasă" → "acasa" surprise rename, and of follow-up collisions).
    final_page_id = page_id
    title_changed = section["title"].strip().lower() != previous_title.lower()

    if title_changed:
        pages = list(section.get("pages") or [])
        other_ids = {str(p.get("id") or "") for p in pages if str(p.get("id") or "") != page_id}
        new_id = _unique_page_id(_page_slug(section["title"]), other_ids, keep=page_id)
        if new_id != page_id:
            # Rebuild the store on disk so the renamed page keeps its position
            # and any references to the old id are remapped.
            cfg = settings.reload_config()
            store = _normalize_dashboard_store(_read_dashboard_raw())
            store_pages = list(store.get("pages") or [])
            for idx, p in enumerate(store_pages):
                if p.get("id") == page_id:
                    p = dict(p)
                    p["id"] = new_id
                    p["title"] = section["title"]
                    p["subtitle"] = section["subtitle"]
                    p["icon"] = section["icon"]
                    p["columns"] = section["columns"]
                    if "theme" in section:
                        p["theme"] = section["theme"] or ""
                    if "parent_page_id" in section:
                        p["parent_page_id"] = section["parent_page_id"] or ""
                    store_pages[idx] = _normalize_page_record(p, idx)
                elif str(p.get("parent_page_id") or "") == page_id:
                    p = dict(p)
                    p["parent_page_id"] = new_id
                    store_pages[idx] = _normalize_page_record(p, idx)
            current = store.get("current_page_id") or page_id
            if current == page_id:
                current = new_id
            settings.save_config({
                "dashboard": {
                    "pages": store_pages,
                    "current_page_id": current,
                    "templates": store.get("templates") or [],
                }
            })
            settings.reload_config()
            final_page_id = new_id
        else:
            _save_dashboard(section, page_id)
    else:
        _save_dashboard(section, page_id)

    refreshed = _dashboard_section(final_page_id)
    return {
        "status": "ok",
        "page": _page_summary({
            "id": final_page_id,
            "title": refreshed["title"],
            "subtitle": refreshed["subtitle"],
            "icon": refreshed["icon"],
            "columns": refreshed["columns"],
            "panels": refreshed.get("panels") or [],
        }),
        "previous_page_id": page_id,
        "current_page_id": refreshed.get("current_page_id") or final_page_id,
    }


_YAML_EDITABLE_KEYS = {
    "title", "subtitle", "icon", "columns", "theme",
    "parent_page_id", "preferences", "panels",
}


def _page_to_yaml_dict(section: dict[str, Any]) -> dict[str, Any]:
    """Project a normalized section into a clean, YAML-friendly dict."""
    return {
        "id": str(section.get("page_id") or ""),
        "title": str(section.get("title") or "Dashboard"),
        "subtitle": str(section.get("subtitle") or "Acasă"),
        "icon": str(section.get("icon") or ""),
        "columns": int(section.get("columns") or 0),
        "theme": str(section.get("theme") or ""),
        "parent_page_id": str(section.get("parent_page_id") or ""),
        "preferences": dict(section.get("preferences") or {}),
        "panels": [dict(p) for p in (section.get("panels") or [])],
    }


@router.get("/pages/{page_id}/yaml")
async def get_dashboard_page_yaml(page_id: str, _: models.User = Depends(auth.get_current_user)):
    import yaml as _yaml
    section = _dashboard_section(page_id)
    if section.get("page_id") != page_id:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
    data = _page_to_yaml_dict(section)
    yaml_text = _yaml.safe_dump(
        data,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        width=120,
    )
    return {"page_id": page_id, "yaml": yaml_text}


class DashboardPageYamlBody(BaseModel):
    yaml: str = Field(..., min_length=1, max_length=500_000)


@router.put("/pages/{page_id}/yaml")
async def update_dashboard_page_yaml(
    page_id: str,
    data: DashboardPageYamlBody,
    _: models.User = Depends(auth.get_current_admin),
):
    import yaml as _yaml
    try:
        parsed = _yaml.safe_load(data.yaml)
    except _yaml.YAMLError as exc:
        raise HTTPException(status_code=400, detail=f"YAML invalid: {exc}") from exc
    if not isinstance(parsed, dict):
        raise HTTPException(status_code=400, detail="YAML root must be a mapping.")

    section = _dashboard_section(page_id)
    if section.get("page_id") != page_id:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})

    # Reject unknown top-level keys to catch typos early.
    unknown = set(parsed.keys()) - (_YAML_EDITABLE_KEYS | {"id"})
    if unknown:
        raise HTTPException(
            status_code=400,
            detail={"key": "dashboard.api.unknown_yaml_fields", "params": {"fields": ", ".join(sorted(unknown))}},
        )
    # The page id is immutable through the YAML editor.
    if "id" in parsed and str(parsed.get("id") or "") not in ("", page_id):
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.page_id_immutable"})

    merged = dict(section)
    for key in _YAML_EDITABLE_KEYS:
        if key in parsed:
            merged[key] = parsed[key]
    # panels must be a list of dicts; normalize defensively
    if not isinstance(merged.get("panels"), list):
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.panels_must_be_list"})
    merged["panels"] = [p for p in merged["panels"] if isinstance(p, dict)]
    if not isinstance(merged.get("preferences"), dict):
        merged["preferences"] = {**_DEFAULT_PREFS}

    try:
        _save_dashboard(merged, page_id)
    except Exception as exc:
        log.exception("YAML save failed for page %s", page_id)
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.save_failed", "params": {"message": str(exc)}}) from exc

    refreshed = _dashboard_section(page_id)
    return {
        "status": "ok",
        "page_id": page_id,
        "yaml": _yaml.safe_dump(
            _page_to_yaml_dict(refreshed),
            sort_keys=False, allow_unicode=True, default_flow_style=False, width=120,
        ),
    }


@router.delete("/pages/{page_id}")
async def delete_dashboard_page(page_id: str, _: models.User = Depends(auth.get_current_admin)):
    cfg = settings.reload_config()
    store = _normalize_dashboard_store(_read_dashboard_raw())
    pages = list(store.get("pages") or [])
    if len(pages) <= 1:
        raise HTTPException(status_code=400, detail={"key": "dashboard.min_one_page"})
    remaining = [page for page in pages if page.get("id") != page_id]
    if len(remaining) == len(pages):
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.page_not_found"})
    current_page_id = str(store.get("current_page_id") or _DEFAULT_PAGE_ID)
    if current_page_id != page_id and any(page.get("id") == current_page_id for page in remaining):
        next_page_id = current_page_id
    else:
        deleted_index = next((index for index, page in enumerate(pages) if page.get("id") == page_id), 0)
        fallback_index = min(deleted_index, len(remaining) - 1)
        next_page_id = str(remaining[fallback_index].get("id") or _DEFAULT_PAGE_ID)
    # Clear any parent_page_id references pointing at the deleted page.
    sanitized: list[dict[str, Any]] = []
    for idx, page in enumerate(remaining):
        record = dict(page)
        if str(record.get("parent_page_id") or "") == page_id:
            record["parent_page_id"] = ""
        sanitized.append(_normalize_page_record(record, idx))
    payload = {
        "pages": sanitized,
        "current_page_id": next_page_id,
        "templates": store.get("templates") or [],
    }
    _write_dashboard_raw(payload)
    settings.reload_config()
    return {"status": "ok", "current_page_id": next_page_id}


@router.get("/widgets")
async def get_dashboard_widgets(
    page_id: str | None = None,
    include_entities: bool = True,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    # No explicit page → honour the viewer's per-user default page (HA-style),
    # falling back to the shared current page when none is set.
    if not page_id:
        page_id = _user_default_page_id(getattr(user, "username", None))
    section = _dashboard_section(page_id)
    panels = section.get("panels") or []
    pages = section.get("pages") or []

    if include_entities:
        all_entities = await _available_entities()
        all_entities.extend(_scene_synthetic_entities(db, user))
        hydration_entities = all_entities
    else:
        # Page switches and pull-to-refresh need the dashboard layout now; they
        # must not block behind a slow integration sync. Use the last known
        # entity cache for card hydration and let the live websocket refresh
        # states as they arrive.
        cached_entities = _available_entities_cache_hit()
        if cached_entities is None:
            cached_entities = _AVAIL_CACHE.get("data") or []
        hydration_entities = _entities_for_dashboard(
            list(cached_entities) + _scene_synthetic_entities(db, user),
            panels,
            pages,
        )

    hydrated_panels = _hydrate_panels(panels, hydration_entities, getattr(user, "username", None))
    payload = {
        "page_id": section.get("page_id") or _DEFAULT_PAGE_ID,
        "pages": [_page_summary(page) for page in (section.get("pages") or [])],
        "current_page_id": section.get("page_id") or _DEFAULT_PAGE_ID,
        "default_page_id": _user_default_page_id(getattr(user, "username", None)),
        "panels": hydrated_panels,
        "widgets": [widget for panel in hydrated_panels for widget in (panel.get("widgets") or [])],
        "preferences": section.get("preferences") or dict(_DEFAULT_PREFS),
        "title": section.get("title") or "Dashboard",
        "subtitle": section.get("subtitle") or "Acasă",
        "icon": _normalize_icon(section.get("icon"), _DEFAULT_DASHBOARD_ICON),
        "columns": section.get("columns") or 0,
    }
    if include_entities:
        payload["available_entities"] = all_entities
    return payload


@router.post("/panels")
async def add_dashboard_panel(data: DashboardPanelBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panels = list(section.get("panels") or [])
    panel_pages = [p.model_dump() for p in (data.pages or [])] if data.pages else []
    panel = _make_panel(data.title, size=data.size, icon=data.icon, pages=panel_pages, show_pagination=data.show_pagination)
    panel = _normalize_panel_record(panel, len(panels))
    panels.append(panel)
    section["panels"] = panels
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "panel": panel}


@router.patch("/panels/{panel_id}")
async def update_dashboard_panel(panel_id: str, data: DashboardPanelUpdateBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panel_idx, panel = _find_panel(section, panel_id)
    if panel is None or panel_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})
    panel["title"] = (data.title or "").strip()
    panel["size"] = data.size if data.size in {"sm", "md", "wide"} else "md"
    panel["icon"] = _normalize_icon(data.icon, "")
    panel["show_pagination"] = bool(data.show_pagination)
    if data.pages is not None:
        panel["pages"] = [p.model_dump() for p in data.pages]
    if data.visibility is not None:
        panel["visibility"] = data.visibility
    if data.background is not None:
        panel["background"] = data.background
    section["panels"][panel_idx] = _normalize_panel_record(panel, panel_idx)
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "panel": section["panels"][panel_idx]}


@router.patch("/panels/{panel_id}/layout")
async def update_dashboard_panel_layout(panel_id: str, data: DashboardPanelLayoutBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panel_idx, panel = _find_panel(section, panel_id)
    if panel is None or panel_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})
    if data.col_start is not None:
        panel["col_start"] = data.col_start
    if data.row_start is not None:
        panel["row_start"] = data.row_start
    if data.row_span is not None:
        panel["row_span"] = data.row_span
    section["panels"][panel_idx] = _normalize_panel_record(panel, panel_idx)
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "panel": section["panels"][panel_idx]}


@router.delete("/panels/{panel_id}")
async def delete_dashboard_panel(panel_id: str, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panels = list(section.get("panels") or [])
    remaining = [panel for panel in panels if panel.get("id") != panel_id]
    if len(remaining) == len(panels):
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})
    section["panels"] = remaining
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok"}


@router.post("/panels/{panel_id}/move")
async def move_dashboard_panel(panel_id: str, data: DashboardMoveBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panels = list(section.get("panels") or [])
    idx = next((i for i, item in enumerate(panels) if item.get("id") == panel_id), None)
    if idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})
    target = idx - 1 if data.direction in {"left", "up"} else idx + 1
    if target < 0 or target >= len(panels):
        return {"status": "ok", "panels": panels}
    panels[idx], panels[target] = panels[target], panels[idx]
    section["panels"] = panels
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "panels": panels}


@router.post("/panels/{panel_id}/reorder")
async def reorder_dashboard_panel(panel_id: str, data: DashboardReorderBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panels = list(section.get("panels") or [])
    from_idx = next((i for i, item in enumerate(panels) if item.get("id") == panel_id), None)
    target_idx = next((i for i, item in enumerate(panels) if item.get("id") == data.target_id), None)
    if from_idx is None or target_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})
    if from_idx == target_idx:
        return {"status": "ok", "panels": panels}
    moved = panels.pop(from_idx)
    if from_idx < target_idx:
        target_idx -= 1
    panels.insert(target_idx, moved)
    section["panels"] = panels
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "panels": panels}


@router.post("/widgets")
async def add_dashboard_widget(data: DashboardWidgetBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panels = [panel for panel in list(section.get("panels") or []) if panel.get("id") != STANDALONE_PANEL_ID and panel.get("kind") != "standalone"]
    section["panels"] = panels
    if data.panel_id == STANDALONE_PANEL_ID:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.widgets_need_section"})
    # A freshly created page has no sections yet. Rather than rejecting the
    # first card with "create a section first" (which silently loses the card
    # for users who don't notice the toast), auto-create a default section so
    # adding a card just works — Home Assistant-style.
    if not panels and not data.panel_id:
        default_panel = _normalize_panel_record(_make_panel(_DEFAULT_PANEL_TITLE), 0)
        panels.append(default_panel)
        section["panels"] = panels
    target_panel_id = data.panel_id or (panels[0].get("id") if panels else "")
    panel_idx, panel = _find_panel(section, target_panel_id)
    if panel is None or panel_idx is None:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.create_section_first"})
    widget = _normalize_widget_record(_apply_widget_patch({"id": str(uuid.uuid4())[:8]}, data.model_dump(exclude_none=True)))
    panel_widgets = list(panel.get("widgets") or [])
    panel_widgets.append(widget)
    section["panels"][panel_idx]["widgets"] = panel_widgets
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "widget": widget}


@router.patch("/preferences")
async def patch_dashboard_preferences(data: DashboardPreferencesBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    section["preferences"] = {
        **_DEFAULT_PREFS,
        "layout_mode": data.layout_mode,
        "show_unavailable": bool(data.show_unavailable),
        "filter_mode": data.filter_mode,
    }
    section["title"] = (data.title or "Dashboard").strip() or "Dashboard"
    section["subtitle"] = (data.subtitle or "Acasă").strip() or "Acasă"
    section["icon"] = _normalize_icon(data.icon, _DEFAULT_DASHBOARD_ICON)
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "preferences": section["preferences"]}


@router.patch("/widgets/{widget_id}")
async def update_dashboard_widget(widget_id: str, data: DashboardWidgetUpdateBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panel_idx, panel, widget_idx, widget = _find_widget(section, widget_id)
    if widget is None or widget_idx is None or panel is None or panel_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})

    patch = data.model_dump(exclude_none=True)
    target_panel_id = patch.pop("panel_id", None) or panel.get("id")
    if target_panel_id == STANDALONE_PANEL_ID:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.widgets_move_need_section"})
    updated_widget = _normalize_widget_record(_apply_widget_patch(widget, patch))
    source_widgets = list(panel.get("widgets") or [])
    source_widgets[widget_idx] = updated_widget
    section["panels"][panel_idx]["widgets"] = source_widgets

    if target_panel_id != panel.get("id"):
        target_panel_idx, target_panel = _find_panel(section, target_panel_id)
        if target_panel is None or target_panel_idx is None:
            raise HTTPException(status_code=400, detail={"key": "dashboard.api.target_panel_not_found"})
        section["panels"][panel_idx]["widgets"] = [item for item in source_widgets if item.get("id") != widget_id]
        target_widgets = list(target_panel.get("widgets") or [])
        target_widgets.append(updated_widget)
        section["panels"][target_panel_idx]["widgets"] = target_widgets

    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "widget": updated_widget}


@router.delete("/widgets/{widget_id}")
async def delete_dashboard_widget(widget_id: str, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panel_idx, panel, _, _ = _find_widget(section, widget_id)
    if panel is None or panel_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})
    section["panels"][panel_idx]["widgets"] = [item for item in (panel.get("widgets") or []) if item.get("id") != widget_id]
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok"}


@router.post("/widgets/{widget_id}/move")
async def move_dashboard_widget(widget_id: str, data: DashboardMoveBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    panel_idx, panel, widget_idx, _ = _find_widget(section, widget_id)
    if panel is None or panel_idx is None or widget_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})
    widgets = list(panel.get("widgets") or [])
    target = widget_idx - 1 if data.direction in {"left", "up"} else widget_idx + 1
    if target < 0 or target >= len(widgets):
        return {"status": "ok", "widgets": widgets}
    widgets[widget_idx], widgets[target] = widgets[target], widgets[widget_idx]
    section["panels"][panel_idx]["widgets"] = widgets
    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok", "widgets": widgets}


@router.post("/widgets/{widget_id}/relocate")
async def relocate_dashboard_widget(widget_id: str, data: DashboardWidgetRelocateBody, page_id: str | None = None, _: models.User = Depends(auth.get_current_admin)):
    section = _dashboard_section(page_id)
    source_panel_idx, source_panel, widget_idx, widget = _find_widget(section, widget_id)
    if source_panel is None or source_panel_idx is None or widget_idx is None or widget is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})
    target_panel_idx, target_panel = _find_panel(section, data.target_panel_id)
    if target_panel is None or target_panel_idx is None:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.panel_not_found"})

    source_widgets = list(source_panel.get("widgets") or [])
    moved_widget = source_widgets.pop(widget_idx)
    section["panels"][source_panel_idx]["widgets"] = source_widgets

    target_widgets = list(target_panel.get("widgets") or [])
    insert_at = len(target_widgets)
    if data.before_widget_id:
        insert_at = next((idx for idx, item in enumerate(target_widgets) if item.get("id") == data.before_widget_id), len(target_widgets))
    if source_panel_idx == target_panel_idx and widget_idx < insert_at:
        insert_at -= 1
    # Update page assignment if the target panel is multi-page
    target_pages = target_panel.get("pages") or []
    if target_pages:
        if data.target_page_id and any(p.get("id") == data.target_page_id for p in target_pages):
            moved_widget["page_id"] = data.target_page_id
        elif not moved_widget.get("page_id") or not any(p.get("id") == moved_widget.get("page_id") for p in target_pages):
            moved_widget["page_id"] = target_pages[0].get("id")
    else:
        moved_widget["page_id"] = None
    if target_panel.get("id") == STANDALONE_PANEL_ID:
        normalized_column = _normalize_widget_layout_column(data.layout_column)
        if normalized_column is not None:
            moved_widget["layout_column"] = normalized_column
        elif not moved_widget.get("layout_column"):
            moved_widget["layout_column"] = 1
    else:
        moved_widget.pop("layout_column", None)
    target_widgets.insert(max(0, insert_at), moved_widget)
    section["panels"][target_panel_idx]["widgets"] = target_widgets

    _save_dashboard(section, section.get("page_id") or page_id)
    return {"status": "ok"}


def _resolve_integration_component(
    manager: Any,
    *,
    entity_snapshot: dict[str, Any] | None,
    entity_id: str,
    widget_source: str,
) -> Any:
    """Pick the integration instance that owns a dashboard widget entity."""
    slug_map = {"zigbee2mqtt": "mosquitto", "mosquitto": "mosquitto"}
    entry_id = str((entity_snapshot or {}).get("entry_id") or "").strip()
    source = str((entity_snapshot or {}).get("source") or widget_source or "").strip().lower()
    unique_id = str((entity_snapshot or {}).get("unique_id") or "").strip()

    component = manager.get_by_entry(entry_id) if entry_id else None
    if component is None and source:
        component = manager.get(slug_map.get(source, source))
    if component is None and (unique_id.startswith("z2m:") or source in slug_map):
        entries = manager.entries_for("mosquitto")
        component = entries[0] if entries else manager.get("mosquitto")
    if component is None and not entity_snapshot and source in slug_map:
        entries = manager.entries_for("mosquitto")
        component = entries[0] if entries else manager.get("mosquitto")
    return component


def _normalize_widget_control_action(
    action: str,
    *,
    entity_snapshot: dict[str, Any] | None,
    desired_state: str | None,
) -> str:
    act = str(action or "").strip().lower()
    if act and act != "toggle":
        return act
    if desired_state in ("on", "off"):
        return "turn_on" if desired_state == "on" else "turn_off"
    state = str((entity_snapshot or {}).get("state") or "").lower()
    if state in {"on", "open", "locked", "playing", "cleaning", "unlocked", "heat", "cool", "auto", "dry", "fan_only"}:
        return "turn_off"
    return "turn_on"


def _expand_entity_id_aliases(
    entity_ids: set[str] | list[str],
    entity_items: list[dict[str, Any]],
) -> set[str]:
    """Allow widget control when the card stores either entity_id or unique_id."""
    expanded = {str(eid).strip() for eid in entity_ids if str(eid).strip()}
    by_key: dict[str, dict[str, Any]] = {}
    for ent in entity_items:
        if not isinstance(ent, dict):
            continue
        eid = str(ent.get("entity_id") or "").strip()
        uid = str(ent.get("unique_id") or "").strip()
        if eid:
            by_key[eid] = ent
        if uid:
            by_key[uid] = ent
    for raw in list(expanded):
        ent = by_key.get(raw)
        if not ent:
            continue
        eid = str(ent.get("entity_id") or "").strip()
        uid = str(ent.get("unique_id") or "").strip()
        if eid:
            expanded.add(eid)
        if uid:
            expanded.add(uid)
    return expanded


def _primary_widget_entity_id(widget: dict[str, Any]) -> str:
    primary = str(widget.get("entity_id") or "").strip()
    if primary:
        return primary
    records = _widget_entity_records(widget)
    if records:
        return str(records[0].get("entity_id") or "").strip()
    return ""


@router.post("/widgets/{widget_id}/toggle")
async def toggle_dashboard_widget(
    widget_id: str,
    body: DashboardToggleBody | None = None,
    page_id: str | None = None,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    widget = _find_widget_any_page(widget_id, page_id)
    if not widget:
        raise HTTPException(status_code=404, detail={"key": "dashboard.api.widget_not_found"})

    if _widget_renderer(widget) in {"info", "label", "weather", "weather_rich"}:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.info_card_not_toggleable"})

    requested_entity_id = str((body.entity_id if body else None) or "").strip()
    if not requested_entity_id and body and isinstance(body.data, dict):
        requested_entity_id = str(body.data.get("entity_id") or "").strip()

    entity_items: list[dict[str, Any]] = []
    try:
        entity_items = await _available_entities()
    except Exception:
        entity_items = []

    allowed_entity_ids = _expand_entity_id_aliases(set(_widget_entity_ids(widget)), entity_items)
    if requested_entity_id and requested_entity_id not in allowed_entity_ids:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.entity_not_on_card"})
    entity_id = requested_entity_id or _primary_widget_entity_id(widget)
    if not entity_id:
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.widget_missing_entity"})

    # Non-HA entities (Mosquitto/Z2M, etc.) — route through integration manager.
    source = str(widget.get("source") or "").strip().lower()
    entity_snapshot: dict[str, Any] | None = None
    target_id = entity_id
    for entity in entity_items:
        if entity.get("entity_id") == entity_id or entity.get("unique_id") == entity_id:
            entity_snapshot = entity
            target_id = str(entity.get("unique_id") or entity_id)
            source = str(entity.get("source") or source).strip().lower()
            break
    manager = get_integration_manager()
    component = _resolve_integration_component(
        manager,
        entity_snapshot=entity_snapshot,
        entity_id=entity_id,
        widget_source=source,
    )
    resolved_source = str((entity_snapshot or {}).get("source") or source).strip().lower()
    uses_integration = bool(
        component
        or "." not in entity_id
        or entity_id.startswith("z2m:")
        or resolved_source in {"mosquitto", "zigbee2mqtt"}
        or (entity_snapshot and entity_snapshot.get("controllable") and resolved_source)
    )
    if uses_integration:
        if not component:
            raise HTTPException(
                status_code=400,
                detail={"key": "dashboard.api.integration_toggle_unavailable", "params": {"source": resolved_source or source or "unknown"}},
            )
        requested_action = str((body.action if body else "") or "").strip().lower()
        if requested_action not in {
            "turn_on", "turn_off", "toggle", "set", "set_value",
            "set_temperature", "set_hvac_mode", "set_fan_mode", "set_swing_mode", "set_preset_mode",
        }:
            requested_action = ""
        desired = body.desired_state if body else None
        action = _normalize_widget_control_action(
            requested_action or "toggle",
            entity_snapshot=entity_snapshot,
            desired_state=desired,
        )
        payload = body.data if body and isinstance(body.data, dict) else None
        try:
            result = await component.control_entity(target_id, action, payload)
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc))
        except (ValueError, TypeError) as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        except Exception as exc:
            log.error("Widget toggle via integration failed for %s: %s", entity_id, exc)
            raise HTTPException(status_code=500, detail=str(exc))
        return {"status": "ok", "action": action, "desired_state": desired, "result": result}

    if _widget_renderer(widget) == "scene" or entity_id.startswith("scene."):
        scene_id = entity_id.split(".", 1)[1] if "." in entity_id else ""
        if not scene_id:
            raise HTTPException(status_code=400, detail={"key": "dashboard.api.invalid_scene_card"})
        scene = scenes_module._load_visible(db, scene_id, user)
        return await scenes_module.activate_scene_internal(db, scene)

    domain = entity_domain(entity_id)
    if not is_controllable_domain(domain):
        raise HTTPException(status_code=400, detail={"key": "dashboard.api.entity_not_directly_toggleable"})
    raise HTTPException(status_code=501, detail={"key": "dashboard.api.direct_toggle_unavailable"})
