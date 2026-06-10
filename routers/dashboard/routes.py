from __future__ import annotations

import asyncio
import logging
import uuid
from typing import Any

import auth
import database
import models
import settings
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from core import dashboard_store
from core.entity_refs import build_entity_map
from integrations.extractors import (
    extract_fusion_solar_candidates as _extract_fusion_solar_candidates,
    extract_pago_candidates as _extract_pago_candidates,
    extract_weather_candidates as _extract_weather_candidates,
    extract_z2m_widget_candidates as _extract_z2m_candidates,
    normalize_entities as _normalize_entities,
)
from routers.dashboard.constants import (
    STANDALONE_PANEL_ID,
    _DEFAULT_DASHBOARD_ICON,
    _DEFAULT_PAGE_ID,
    _DEFAULT_PAGE_TITLE,
    _DEFAULT_PANEL_TITLE,
    _DEFAULT_PREFS,
    _INFO_DOMAINS,
    _SWITCH_DOMAINS,
    _VISIBLE_DOMAINS,
)
from routers.dashboard.control import toggle_dashboard_widget
from routers.dashboard.entities import (
    _available_entities,
    _available_entities_cache_hit,
    _entities_for_dashboard,
    _hydrate_panels,
    _hydrate_widgets,
    _page_entity_ids,
    _page_summary,
    _panel_entity_ids,
    _scene_synthetic_entities,
)
from routers.dashboard.models import (
    DashboardDefaultPageBody,
    DashboardHistoryBatchBody,
    DashboardImportBody,
    DashboardMoveBody,
    DashboardPageBody,
    DashboardPageUpdateBody,
    DashboardPageYamlBody,
    DashboardPanelBody,
    DashboardPanelLayoutBody,
    DashboardPanelUpdateBody,
    DashboardPreferencesBody,
    DashboardReorderBody,
    DashboardTemplateInstantiateBody,
    DashboardTemplateSaveBody,
    DashboardWidgetBody,
    DashboardWidgetRelocateBody,
    DashboardWidgetUpdateBody,
    DashboardToggleBody,
)
from routers.dashboard.store import (
    _all_panel_widgets,
    _apply_widget_patch,
    _dashboard_section,
    _dashboard_user_prefs,
    _find_page,
    _find_panel,
    _find_widget,
    _find_widget_any_page,
    _make_page,
    _make_panel,
    _migrate_to_section_layout,
    _normalize_dashboard_store,
    _normalize_icon,
    _normalize_page_columns,
    _normalize_page_record,
    _normalize_panel_record,
    _normalize_widget_record,
    _read_dashboard_raw,
    reconcile_dashboard_section,
    _save_dashboard,
    sync_widget_entity_ref,
    _section_panels_only,
    _set_user_default_page_id,
    _user_default_page_id,
    _write_dashboard_raw,
)
from ui_catalog import dashboard_card_catalog

router = APIRouter(prefix="/api/dashboard", tags=["dashboard"])
log = logging.getLogger("dashboard")

@router.get("/catalog")
async def get_dashboard_catalog(user: models.User = Depends(auth.get_current_user)):
    return {"cards": dashboard_card_catalog()}


@router.get("/card-packages")
async def get_dashboard_card_packages(user: models.User = Depends(auth.get_current_user)):
    """Hyveview card unit packages (bundled + custom_components/cards drop-ins)."""
    from core.cards.loader import list_card_packages

    return list_card_packages()


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


@router.post("/history/batch")
async def get_entity_history_batch(
    body: DashboardHistoryBatchBody,
    _: models.User = Depends(auth.get_current_user),
):
    """Return sparkline history for many entities in one request."""
    from core.entity_history import get_history_many

    entity_ids = [str(eid).strip() for eid in (body.entity_ids or []) if str(eid).strip()][:64]
    hours = body.hours
    histories = get_history_many(entity_ids, hours=hours)
    return {"hours": hours, "histories": histories}


@router.get("/pages")
async def list_dashboard_pages(user: models.User = Depends(auth.get_current_user)):
    section = _dashboard_section()
    return {
        "pages": [_page_summary(page) for page in (section.get("pages") or [])],
        "current_page_id": section.get("current_page_id") or section.get("page_id") or _DEFAULT_PAGE_ID,
        "default_page_id": _user_default_page_id(getattr(user, "username", None)),
    }


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
        if reconcile_dashboard_section(section, all_entities):
            _save_dashboard(section, section.get("page_id") or page_id)
    else:
        # Page switches and pull-to-refresh need the dashboard layout now; they
        # must not block behind a slow integration sync. Use the last known
        # entity cache for card hydration and let the live websocket refresh
        # states as they arrive.
        cached_entities = _available_entities_cache_hit() or []
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
    if data.title is not None:
        section["title"] = (data.title or "Dashboard").strip() or "Dashboard"
    if data.subtitle is not None:
        section["subtitle"] = (data.subtitle or "Acasă").strip() or "Acasă"
    if data.icon is not None:
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
    if patch.get("entity_id") is not None:
        entity_map = build_entity_map(await _available_entities())
        sync_widget_entity_ref(updated_widget, entity_map)
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


@router.post("/widgets/{widget_id}/toggle")
async def toggle_dashboard_widget_route(
    widget_id: str,
    body: DashboardToggleBody | None = None,
    page_id: str | None = None,
    db: Session = Depends(database.get_db),
    user: models.User = Depends(auth.get_current_user),
):
    return await toggle_dashboard_widget(widget_id, body, page_id, db, user)
