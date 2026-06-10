from __future__ import annotations

import logging
import time as _time
from typing import Any

import database
import models
from integrations.extractors import infer_source as _infer_source
from integrations.entity_utils import resolve_entity_by_id
from routers import scenes as scenes_module
from core.entity_catalog import get_entities, invalidate_entity_cache, peek_cached_entities
from routers.dashboard.constants import (
    STANDALONE_PANEL_ID,
    _DEFAULT_DASHBOARD_ICON,
    _DEFAULT_PAGE_TITLE,
)
from routers.dashboard.store import (
    _evaluate_panel_visibility,
    _evaluate_widget_visibility,
    _normalize_icon,
    _normalize_page_columns,
    _normalize_panel_background,
    _normalize_panel_pages,
    _normalize_widget_span,
    _panel_visibility_config,
    _widget_entity_ids,
    _widget_entity_records,
    _widget_renderer,
    _widget_visibility_config,
)
from smart_home_registry import entity_domain, normalize_entity_record
from sqlalchemy.orm import Session

log = logging.getLogger("dashboard")

_SCENE_SYNTHETIC_TTL_SEC = 30.0
_scene_synthetic_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def invalidate_scene_synthetic_cache(username: str | None = None) -> None:
    """Drop cached scene-as-entity rows (after scene CRUD or WS reconnect)."""
    if username:
        _scene_synthetic_cache.pop(str(username).strip(), None)
    else:
        _scene_synthetic_cache.clear()


async def _available_entities() -> list[dict[str, Any]]:
    """Build the merged entity list for dashboard WS and hydration."""
    return await get_entities(include_derived=False, sort_mode="dashboard")


def invalidate_available_entities_cache() -> None:
    """Drop the cached entity list (call after a manual sync or entity update)."""
    invalidate_entity_cache()


def _available_entities_cache_hit() -> list[dict[str, Any]] | None:
    return peek_cached_entities(include_derived=False, sort_mode="dashboard")


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


def get_scene_synthetic_entities(user: models.User) -> list[dict[str, Any]]:
    """Cached scene rows for dashboard WS enrichment (avoids per-tab DB hits)."""
    username = str(getattr(user, "username", "") or "").strip()
    if not username:
        return []
    now = _time.monotonic()
    cached = _scene_synthetic_cache.get(username)
    if cached and (now - cached[0]) < _SCENE_SYNTHETIC_TTL_SEC:
        return list(cached[1])
    db = next(database.get_db())
    try:
        items = _scene_synthetic_entities(db, user)
    finally:
        db.close()
    _scene_synthetic_cache[username] = (now, items)
    return list(items)


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
        uid = str(widget.get("unique_id") or "").strip()
        eid = str(widget.get("entity_id") or "").strip()
        entity = resolve_entity_by_id(uid, entity_map) if uid else {}
        if not entity and eid:
            entity = resolve_entity_by_id(eid, entity_map) or {}
        hydrated_entities: list[dict[str, Any]] = []
        for entity_record in _widget_entity_records(widget):
            record_uid = str(entity_record.get("unique_id") or "").strip()
            record_eid = str(entity_record.get("entity_id") or "").strip()
            item = resolve_entity_by_id(record_uid, entity_map) if record_uid else {}
            if not item and record_eid:
                item = resolve_entity_by_id(record_eid, entity_map) or {}
            live_eid = str(item.get("entity_id") or record_eid or record_uid)
            hydrated_entities.append({
                "entity_id": live_eid,
                "unique_id": str(item.get("unique_id") or record_uid or ""),
                "title": entity_record.get("title") or "",
                "subtitle": entity_record.get("subtitle") or "",
                "entity_name": item.get("name") or live_eid,
                "current_state": item.get("state", "unknown"),
                "domain": item.get("domain") or entity_domain(live_eid),
                "available": bool(item),
                "unit": item.get("unit") or "",
                "attributes": item.get("attributes") or {},
                "controllable": bool(item.get("controllable", _widget_renderer(widget) == "button")),
                "source": item.get("source") or _infer_source(live_eid, item.get("name") or live_eid),
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
            "entity_id": str(entity.get("entity_id") or widget.get("entity_id") or ""),
            "unique_id": str(entity.get("unique_id") or widget.get("unique_id") or ""),
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
            unique_id = str(widget.get("unique_id") or "").strip()
            if unique_id:
                ids.add(unique_id)
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
