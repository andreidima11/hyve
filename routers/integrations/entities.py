from __future__ import annotations

from typing import Any

import area_resolver
import database
import models
from auth import get_current_user
from addons.entity_store import get_entity_store
from fastapi import Depends, HTTPException, Query
from sqlalchemy import text
from ui_catalog import integration_catalog

from routers.integrations import helpers
from routers.integrations.constants import SOURCE_META
from routers.integrations.models import EntityRegistryUpdateBody, EntitySelectionBody
from routers.integrations.router import router


@router.get("/catalog")
async def get_integrations_catalog(user: models.User = Depends(get_current_user)):
    """Return the UI catalog (rows rendered in Settings → Integrări)."""
    return {"integrations": integration_catalog()}


@router.get("/all-entities")
async def get_all_entities(user: models.User = Depends(get_current_user)):
    """Return entities from every integration in a unified format."""
    entities = await helpers.all_entities()

    source_counts: dict[str, int] = {}
    for e in entities:
        src = e.get("source", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1

    sources = []
    for slug, count in sorted(source_counts.items(), key=lambda x: x[1], reverse=True):
        meta = SOURCE_META.get(slug, {"label": slug, "icon": "fa-puzzle-piece", "color": "text-slate-400"})
        sources.append({"slug": slug, "count": count, **meta})

    area_counts: dict[str, int] = {}
    for e in entities:
        area_name = (e.get("area") or "").strip()
        if area_name:
            area_counts[area_name] = area_counts.get(area_name, 0) + 1

    area_meta: dict[str, dict[str, Any]] = {}
    try:
        for a in area_resolver.list_areas():
            name = (a.get("name") or "").strip()
            if name:
                area_meta[name] = {"icon": a.get("icon") or "", "color": a.get("color") or ""}
    except Exception:
        pass

    areas = []
    for name, count in sorted(area_counts.items(), key=lambda x: (-x[1], x[0].lower())):
        meta = area_meta.get(name, {})
        areas.append({
            "name": name,
            "count": count,
            "icon": meta.get("icon") or "",
            "color": meta.get("color") or "",
        })

    return {"entities": entities, "sources": sources, "areas": areas, "total": len(entities)}


@router.get("/picker/entities")
async def picker_entities(
    domain: str | None = Query(None, description="Filter by entity domain (light, switch, sensor, ...)"),
    area: str | None = Query(None, description="Filter by area name (case-insensitive)"),
    source: str | None = Query(None, description="Filter by integration slug (zigbee2mqtt, mosquitto, ...)"),
    controllable: bool | None = Query(None, description="Only return entities that can be controlled"),
    search: str | None = Query(None, description="Substring match against entity_id, name, friendly_name"),
    limit: int = Query(200, ge=1, le=1000),
    user: models.User = Depends(get_current_user),
):
    from fastapi.params import Query as _QueryParam

    if isinstance(domain, _QueryParam):
        domain = domain.default
    if isinstance(area, _QueryParam):
        area = area.default
    if isinstance(source, _QueryParam):
        source = source.default
    if isinstance(controllable, _QueryParam):
        controllable = controllable.default
    if isinstance(search, _QueryParam):
        search = search.default
    if isinstance(limit, _QueryParam):
        limit = limit.default
    entities = await helpers.all_entities()
    needle = (search or "").strip().lower()
    area_needle = (area or "").strip().lower()
    out: list[dict[str, Any]] = []
    for ent in entities:
        eid = str(ent.get("entity_id") or "")
        if not eid:
            continue
        ent_domain = (eid.split(".", 1)[0] if "." in eid else "").lower()
        if domain and ent_domain != domain.lower():
            continue
        if source:
            from integrations.source_aliases import entity_matches_integration

            if not entity_matches_integration(str(ent.get("source") or ""), source):
                continue
        if area_needle and (str(ent.get("area") or "").lower() != area_needle):
            continue
        if controllable is not None and bool(ent.get("controllable")) != controllable:
            continue
        if needle:
            haystack = " ".join(str(ent.get(k) or "") for k in ("entity_id", "name", "friendly_name")).lower()
            if needle not in haystack:
                continue
        out.append({
            "id": eid,
            "label": ent.get("friendly_name") or ent.get("name") or eid,
            "domain": ent_domain,
            "area": ent.get("area") or "",
            "source": ent.get("source") or "",
            "controllable": bool(ent.get("controllable")),
            "state": ent.get("state"),
        })
        if len(out) >= limit:
            break
    return {"items": out, "total": len(out), "truncated": len(out) >= limit}


@router.get("/picker/areas")
async def picker_areas(user: models.User = Depends(get_current_user)):
    try:
        areas = area_resolver.list_areas()
    except Exception:
        areas = []
    return {"items": [
        {
            "id": (a.get("name") or "").strip(),
            "label": (a.get("name") or "").strip(),
            "icon": a.get("icon") or "",
            "color": a.get("color") or "",
        }
        for a in areas if (a.get("name") or "").strip()
    ]}


@router.get("/picker/domains")
async def picker_domains(user: models.User = Depends(get_current_user)):
    entities = await helpers.all_entities()
    counts: dict[str, int] = {}
    for ent in entities:
        eid = str(ent.get("entity_id") or "")
        if "." not in eid:
            continue
        d = eid.split(".", 1)[0].lower()
        counts[d] = counts.get(d, 0) + 1
    items = [{"id": d, "label": d, "count": c} for d, c in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]
    return {"items": items}


@router.get("/{slug}/entities")
async def get_integration_entities(
    slug: str,
    entry_id: str | None = Query(default=None),
    user: models.User = Depends(get_current_user),
):
    from integrations import get_integration_manager

    store = get_entity_store()
    manager = get_integration_manager()
    store_keys: list[str] = []

    if entry_id:
        inst = manager.get_by_entry(entry_id)
        if inst is not None:
            store_keys = [inst.store_key]
    else:
        instances = manager.entries_for(slug)
        if instances:
            store_keys = [inst.store_key for inst in instances]
        elif store.get_fetcher(slug):
            store_keys = [slug]

    payloads: list[dict[str, Any]] = []
    for key in store_keys:
        row = store.get_entities(key)
        if not row:
            continue
        out = dict(row)
        schedule = store.get_schedule(key)
        if schedule:
            out["schedule"] = schedule
        out["refresh"] = helpers.refresh_meta_for_store_key(key)
        out["store_key"] = key
        payloads.append(out)

    if not payloads:
        raise HTTPException(status_code=404, detail=f"No entities found for integration '{slug}'")
    if len(payloads) == 1:
        return payloads[0]
    return {"slug": slug, "entries": payloads}


@router.get("/entities/registry")
async def list_entity_registry(user: models.User = Depends(get_current_user)):
    from core import entity_registry

    entries = entity_registry.all_entries()
    return {"entries": entries, "total": len(entries)}


@router.patch("/entities/registry/{unique_id}")
async def patch_entity_registry(
    unique_id: str,
    body: EntityRegistryUpdateBody,
    user: models.User = Depends(get_current_user),
):
    from core import entity_registry

    uid = (unique_id or "").strip()
    if not uid:
        raise HTTPException(status_code=400, detail="unique_id is required")
    if body.entity_id is None and body.name is None and body.disabled is None:
        raise HTTPException(status_code=400, detail="no fields to update")

    try:
        entry = entity_registry.update_entry(
            uid,
            entity_id=body.entity_id,
            name=body.name,
            disabled=body.disabled,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="registry entry not found")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    entity_registry.reload()
    helpers.invalidate_all_entities_cache()
    return {"status": "ok", "entry": entry}


@router.post("/entities/selection")
async def update_entity_selection(
    body: EntitySelectionBody,
    user: models.User = Depends(get_current_user),
):
    eid = (body.entity_id or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="entity_id is required")

    uid = (body.unique_id or "").strip()
    storage_id = uid or eid
    get_entity_store().set_selection(storage_id, bool(body.selected))
    helpers.invalidate_all_entities_cache()

    try:
        from brain.cortex.prompt_cache import invalidate_prompt_cache

        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok", "entity_id": eid, "selected": bool(body.selected)}


@router.get("")
async def list_integration_entities(user: models.User = Depends(get_current_user)):
    db = next(database.get_db())
    try:
        rows = db.execute(
            text("SELECT integration_slug, timestamp, last_error FROM integration_entities")
        ).fetchall()
    finally:
        db.close()

    integrations = []
    for slug, timestamp, last_error in rows:
        integrations.append({
            "slug": slug,
            "last_updated": timestamp,
            "has_error": last_error is not None,
            "error": last_error,
        })
    return {"integrations": integrations}


@router.post("/entity/rename")
async def rename_entity(body: dict, user: models.User = Depends(get_current_user)):
    entity_id = (body.get("entity_id") or "").strip()
    if not entity_id:
        raise HTTPException(status_code=400, detail="entity_id is required")
    custom_name = body.get("custom_name")
    aliases = body.get("aliases")
    if custom_name is not None:
        custom_name = str(custom_name).strip()
    if aliases is not None:
        if not isinstance(aliases, list):
            raise HTTPException(status_code=400, detail="aliases must be a list")
        aliases = [str(a).strip() for a in aliases if str(a).strip()]
    store = get_entity_store()
    store.set_override(entity_id, custom_name=custom_name, aliases=aliases)
    helpers.invalidate_all_entities_cache()
    return {"status": "ok", "entity_id": entity_id}
