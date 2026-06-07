from __future__ import annotations

import asyncio
import logging
import time as _time
from typing import Any

import models
from addons.entity_store import get_entity_store
from integrations import get_integration_manager
from integrations.extractors import infer_source as _infer_source
from integrations.entity_utils import resolve_entity_by_id
from routers import scenes as scenes_module
from routers.dashboard.constants import (
    STANDALONE_PANEL_ID,
    _AVAIL_CACHE,
    _AVAIL_TTL,
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

_AVAIL_BUILD_LOCK: asyncio.Lock | None = None

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
        entity = resolve_entity_by_id(str(widget.get("entity_id") or ""), entity_map) or {}
        hydrated_entities: list[dict[str, Any]] = []
        for entity_record in _widget_entity_records(widget):
            entity_id = entity_record["entity_id"]
            item = resolve_entity_by_id(entity_id, entity_map) or {}
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
