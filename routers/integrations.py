"""Integrations management router — entities & unified integration API."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time as _time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from sqlalchemy import text

import area_resolver
import database
import derived_entities
import auth
from auth import get_current_user
from addons.entity_store import SyncThrottledError, get_entity_store
from core.live_entity_hub import LiveEntityWsHub
from routers.dashboard_ws import _authenticate as _ws_authenticate, _entity_signature, _diff_snapshot
from smart_home_registry import normalize_entity_record
from ui_catalog import integration_catalog
import models
from logger import log_line

log = logging.getLogger("integrations")

router = APIRouter(prefix="/api/integrations", tags=["integrations"])
_ENTRY_TEST_TIMEOUT_SECONDS = 50.0
_ALL_ENTITIES_TTL = 3.0


def _register_instance_fetcher(store, inst) -> str:
    """Register an integration instance fetcher with its per-provider timeout."""
    from addons.entity_store import FETCH_TIMEOUT_SECONDS

    key = inst.store_key
    timeout = float(getattr(inst, "fetch_timeout_seconds", FETCH_TIMEOUT_SECONDS))
    store.register_fetcher(
        key,
        inst.fetch_entities,
        inst.format_context,
        description=getattr(inst, "description", "") or "",
        timeout_seconds=timeout,
    )
    return key


async def _apply_instance_sync_schedule(store, inst, *, restart_loop: bool = False) -> str | None:
    """Persist scan_interval from the entry config and optionally restart its loop."""
    if inst is None or not inst.supports_sync:
        return None
    import settings

    key = _register_instance_fetcher(store, inst)
    interval = inst.sync_interval(settings.CFG)
    store.set_interval(key, interval)
    if restart_loop:
        if inst.uses_background_sync():
            await store.restart_sync_loop(key, interval)
        else:
            store.stop_sync_loop(key)
    return key
_ALL_ENTITIES_CACHE: dict[bool, dict[str, Any]] = {}
_ALL_ENTITIES_BUILD_LOCK: asyncio.Lock | None = None


# ── Source metadata for the UI ──────────────────────────────────────────
_SOURCE_META: dict[str, dict[str, str]] = {
    "pago":           {"label": "Pago",           "icon": "fa-credit-card",  "color": "text-emerald-400"},
    "fusion_solar":   {"label": "FusionSolar",    "icon": "fa-solar-panel",  "color": "text-amber-400"},
    "eon_romania":    {"label": "E.ON România",   "icon": "fa-bolt",         "color": "text-rose-400"},
    "derived":        {"label": "Derived",        "icon": "fa-calculator",   "color": "text-pink-400"},
}


def _all_entities_lock() -> asyncio.Lock:
    global _ALL_ENTITIES_BUILD_LOCK
    if _ALL_ENTITIES_BUILD_LOCK is None:
        _ALL_ENTITIES_BUILD_LOCK = asyncio.Lock()
    return _ALL_ENTITIES_BUILD_LOCK


def _all_entities_cache_hit(include_derived: bool) -> list[dict[str, Any]] | None:
    cached = _ALL_ENTITIES_CACHE.get(bool(include_derived))
    if cached and (_time.monotonic() - cached.get("t", 0.0)) < _ALL_ENTITIES_TTL:
        return cached.get("data") or []
    return None


def _build_all_entities_uncached(include_derived: bool = True) -> list[dict[str, Any]]:
    """Gather entities from every integration into a single flat list."""
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def _add(items: list[dict[str, Any]]):
        for item in items:
            eid = item.get("entity_id")
            if not eid:
                continue
            # Dedupe per-entry so multiple entries of the same provider
            # exposing the same entity_id don't shadow each other.
            key = (item.get("entry_id") or "", eid)
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    # All entities (Pago, FusionSolar, Mosquitto/zigbee2mqtt, Ariston,
    # OpenMeteo, …) come from the class-based provider chain below. Each
    # provider declares ``CONFIG_SCHEMA`` + ``SUPPORTS_MULTIPLE`` and is
    # instantiated once per config entry, so the manager naturally returns
    # the union of every entry's entities under the right ``store_key``.
    # No bare-slug shortcuts here — they would leak stale data from
    # deleted entries and miss data from newly added ones.
    try:
        from integrations import get_integration_manager
        store = get_entity_store()
        manager = get_integration_manager()
        provider_items: list[dict[str, Any]] = []
        for integration in manager.all_instances():
            if integration.supports_sync and not manager._is_bootstrap_eligible(integration):
                continue
            if not integration.supports_sync:
                continue
            try:
                stored = store.get_entities(integration.store_key) or {}
                payload = stored.get("entities") or {}
                if hasattr(integration, "live_payload"):
                    payload = integration.live_payload(payload)
                for item in integration.extract_entities(payload):
                    item.setdefault("entry_id", integration.entry_id or "")
                    item.setdefault("entry_title", integration.entry_title or integration.label or integration.slug)
                    normalize_entity_record(item, default_source=integration.slug)
                    provider_items.append(item)
            except Exception:
                continue
        _add(provider_items)
    except Exception:
        pass

    # Derived (template sensors) — evaluate against the aggregated state above
    if include_derived:
        try:
            state_map = {
                item.get("entity_id"): {
                    "state": item.get("state"),
                    "unit": item.get("unit", ""),
                }
                for item in merged if item.get("entity_id")
            }
            _add(derived_entities.evaluate_all(state_map))
        except Exception:
            pass

    # Apply per-integration device aliases (renamed devices in Settings →
    # Integrări) BEFORE per-entity overrides so the device-level rename
    # propagates into entity display names that embed the device name.
    try:
        from integrations import device_aliases
        # Group entities by source slug, apply aliases per slug, then flatten
        # back into ``merged`` (in place — the function mutates each entity).
        by_slug: dict[str, list[dict[str, Any]]] = {}
        for ent in merged:
            by_slug.setdefault(str(ent.get("source") or ""), []).append(ent)
        for slug, items in by_slug.items():
            if slug:
                device_aliases.apply_to_entities(slug, items)
    except Exception:
        pass

    merged.sort(key=lambda e: (e.get("name") or "").lower())
    get_entity_store().apply_overrides(merged)

    # Enrich every entity with its Hyve-side area name (single source of
    # truth: ``area_resolver``). Falls back to whatever the provider already
    # set on ``entity['area']`` or in attributes so legacy data still works.
    try:
        area_map = area_resolver.entity_area_map()
        for ent in merged:
            eid = ent.get("entity_id")
            if not eid:
                continue
            area = (
                area_map.get(eid)
                or ent.get("area")
                or (ent.get("attributes") or {}).get("area")
                or ""
            )
            if area:
                ent["area"] = area
    except Exception:
        pass

    return merged


async def _all_entities(include_derived: bool = True) -> list[dict[str, Any]]:
    """Gather entities from every integration into a single flat list.

    When `include_derived=False`, the result does NOT contain derived entities —
    useful when building the state_map that derived entities evaluate against
    (avoids self-referencing loops). The devices websocket calls this often, so
    refreshes are single-flight, short-cache and run off the main event loop.
    """
    include_derived = bool(include_derived)
    cached = _all_entities_cache_hit(include_derived)
    if cached is not None:
        return cached

    async with _all_entities_lock():
        cached = _all_entities_cache_hit(include_derived)
        if cached is not None:
            return cached
        try:
            entities = await asyncio.wait_for(
                asyncio.to_thread(_build_all_entities_uncached, include_derived),
                timeout=8.0,
            )
        except Exception as exc:
            log.warning("all-entities refresh failed: %s", exc)
            stale = _ALL_ENTITIES_CACHE.get(include_derived)
            return (stale or {}).get("data") or []

    _ALL_ENTITIES_CACHE[include_derived] = {"data": entities, "t": _time.monotonic()}
    return entities


def invalidate_all_entities_cache() -> None:
    _ALL_ENTITIES_CACHE.clear()


@router.get("/catalog")
async def get_integrations_catalog(user: models.User = Depends(get_current_user)):
    """Return the UI catalog (rows rendered in Settings → Integrări)."""
    return {"integrations": integration_catalog()}


@router.get("/all-entities")
async def get_all_entities(user: models.User = Depends(get_current_user)):
    """Return entities from every integration in a unified format."""
    entities = await _all_entities()

    # Build per-source counts
    source_counts: dict[str, int] = {}
    for e in entities:
        src = e.get("source", "unknown")
        source_counts[src] = source_counts.get(src, 0) + 1

    sources = []
    for slug, count in sorted(source_counts.items(), key=lambda x: x[1], reverse=True):
        meta = _SOURCE_META.get(slug, {"label": slug, "icon": "fa-puzzle-piece", "color": "text-slate-400"})
        sources.append({"slug": slug, "count": count, **meta})

    # Per-area counts (only areas that actually have at least one entity).
    area_counts: dict[str, int] = {}
    for e in entities:
        area_name = (e.get("area") or "").strip()
        if area_name:
            area_counts[area_name] = area_counts.get(area_name, 0) + 1

    # Pull icon/color from the Area model where available so the UI can
    # render consistent area chips.
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
    """Smart picker for the automation editor.

    Returns a slimmed-down entity list with consistent ``id``/``label``/
    ``domain``/``area``/``source``/``controllable`` fields, filterable by
    any combination of the parameters above. Designed so the editor can
    fetch only what it needs (e.g. only ``domain=light`` for a light
    service action picker) instead of pulling the entire universe."""
    # When called directly (tests) the FastAPI Query() sentinels may pass through.
    from fastapi.params import Query as _QueryParam
    if isinstance(domain, _QueryParam): domain = domain.default
    if isinstance(area, _QueryParam): area = area.default
    if isinstance(source, _QueryParam): source = source.default
    if isinstance(controllable, _QueryParam): controllable = controllable.default
    if isinstance(search, _QueryParam): search = search.default
    if isinstance(limit, _QueryParam): limit = limit.default
    entities = await _all_entities()
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
    """Areas available for area-scoped pickers (e.g. blueprint inputs of
    type ``area``). Returns the canonical area list with icon/color."""
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
    """Distinct entity domains currently present, with a count each. Lets
    the editor surface "service action" domain pickers without hardcoding."""
    entities = await _all_entities()
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
async def get_integration_entities(slug: str, user: models.User = Depends(get_current_user)):
    """Get stored entity data for an integration."""
    store = get_entity_store()
    entities = store.get_entities(slug)
    if not entities:
        raise HTTPException(status_code=404, detail=f"No entities found for integration '{slug}'")
    schedule = store.get_schedule(slug)
    if schedule:
        entities["schedule"] = schedule
    return entities


class EntitySelectionBody(BaseModel):
    entity_id: str
    selected: bool


@router.post("/entities/selection")
async def update_entity_selection(
    body: EntitySelectionBody,
    user: models.User = Depends(get_current_user),
):
    """Toggle the AI-exposure flag for any entity, regardless of source.

    This is the unified path the UI uses for every integration. There is
    no per-source branch here — every entity is treated the same way.
    """
    eid = (body.entity_id or "").strip()
    if not eid:
        raise HTTPException(status_code=400, detail="entity_id is required")

    # Authoritative store (works for any integration)
    get_entity_store().set_selection(eid, bool(body.selected))
    invalidate_all_entities_cache()
    try:
        from routers.dashboard import invalidate_available_entities_cache
        invalidate_available_entities_cache()
    except Exception:
        pass

    try:
        from core.agent_engine import invalidate_prompt_cache
        invalidate_prompt_cache()
    except Exception:
        pass
    return {"status": "ok", "entity_id": eid, "selected": bool(body.selected)}


@router.get("")
async def list_integration_entities(user: models.User = Depends(get_current_user)):
    """List all integrations that have synced entity data."""
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


@router.get("/status/sync")
async def get_sync_status(user: models.User = Depends(get_current_user)):
    """Get entity sync schedule status across all integrations."""
    db = next(database.get_db())
    try:
        rows = db.execute(text("""
            SELECT integration_slug, fetch_interval_seconds, enabled,
                   last_fetch_time, next_fetch_time
            FROM integration_entity_schedule
        """)).fetchall()
    finally:
        db.close()

    schedules = []
    for slug, interval, enabled, last_fetch, next_fetch in rows:
        schedules.append({
            "integration": slug,
            "interval_seconds": interval,
            "enabled": bool(enabled),
            "last_fetch_time": last_fetch,
            "next_fetch_time": next_fetch,
        })
    return {"total_integrations": len(schedules), "schedules": schedules}


@router.post("/sync/{slug}")
async def trigger_sync(slug: str, user: models.User = Depends(auth.get_current_admin)):
    """Manually trigger immediate entity sync for an integration.

    When the slug refers to a multi-instance provider, fan out the sync
    across every enabled entry so the user's "Sincronizează" button works
    for the whole integration in one click.
    """
    from integrations import get_integration_manager

    store = get_entity_store()
    manager = get_integration_manager()
    instances = manager.entries_for(slug)

    # Fallback: legacy single-instance providers without entries (none
    # remain in core, but extensions might).
    if not instances:
        if not store.get_fetcher(slug):
            registered = await _ensure_fetcher(slug, store)
            if not registered:
                raise HTTPException(status_code=404,
                                    detail=f"No entity sync available for '{slug}'")
        try:
            await store.do_sync(slug, force=True)
            stored = store.get_entities(slug) or {}
            try:
                from routers.dashboard import invalidate_available_entities_cache
                invalidate_available_entities_cache()
            except Exception:
                pass
            invalidate_all_entities_cache()
            return {"status": "ok", "slug": slug, "entity_count": len(stored.get("entities") or {})}
        except SyncThrottledError as e:
            raise HTTPException(
                status_code=429,
                detail=e.as_detail(),
                headers={"Retry-After": str(e.retry_after)},
            )
        except Exception as e:
            log.error("Manual sync failed for %s: %s", slug, e)
            detail = str(e)
            if "rate limit" in detail.lower():
                raise HTTPException(status_code=429, detail=detail)
            raise HTTPException(status_code=500, detail=detail)

    total = 0
    errors: list[str] = []
    for inst in instances:
        if not inst.supports_sync:
            continue
        key = inst.store_key
        try:
            if not store.get_fetcher(key):
                _register_instance_fetcher(store, inst)
                store.set_interval(key, inst.sync_interval(__import__("settings").CFG))
            await store.do_sync(key, force=True)
            try:
                items = await inst.list_entities(store)
                total += len(items)
            except Exception:
                pass
        except SyncThrottledError as exc:
            errors.append(exc.as_detail())
            log.warning("Manual sync throttled for %s: %s", key, exc)
        except Exception as exc:
            errors.append(f"{key}: {exc}")
            log.error("Manual sync failed for %s: %s", key, exc)

    if errors and total == 0:
        if all(
            isinstance(e, dict) and e.get("key") == SyncThrottledError.I18N_KEY
            for e in errors
        ):
            retry = 600
            for inst in instances:
                try:
                    wait = int(store.seconds_until_next_sync(inst.store_key))
                    if wait > 0:
                        retry = wait
                        break
                except Exception:
                    pass
            detail = errors[0] if len(errors) == 1 else {
                "key": "integrations.sync_rate_limited",
                "params": {},
            }
            raise HTTPException(
                status_code=429,
                detail=detail,
                headers={"Retry-After": str(retry)},
            )
        raise HTTPException(
            status_code=500,
            detail="; ".join(
                e if isinstance(e, str) else str(e.get("key", e))
                for e in errors
            ),
        )
    try:
        from routers.dashboard import invalidate_available_entities_cache
        invalidate_available_entities_cache()
    except Exception:
        pass
    invalidate_all_entities_cache()
    return {"status": "ok", "slug": slug, "entity_count": total, "errors": errors}


async def _ensure_fetcher(slug: str, store) -> bool:
    """Try to register a fetcher for a known integration on the fly."""
    import settings as settings_mod

    # Class-based providers (integrations/providers/*.py) auto-register
    # themselves through the IntegrationManager when enabled. If a user
    # toggles an integration on after server boot, we register it here so the
    # manual /sync/{slug} endpoint doesn't 404.
    try:
        from integrations import get_integration_manager
        manager = get_integration_manager()
        if manager.register_fetcher(slug, store):
            return True
    except Exception as exc:  # pragma: no cover - defensive
        log.debug("IntegrationManager.register_fetcher(%s) failed: %s", slug, exc)

    return False


@router.post("/entity/rename")
async def rename_entity(body: dict, user: models.User = Depends(get_current_user)):
    """Rename a custom integration entity (set custom_name and/or aliases)."""
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
    invalidate_all_entities_cache()
    try:
        from routers.dashboard import invalidate_available_entities_cache
        invalidate_available_entities_cache()
    except Exception:
        pass
    return {"status": "ok", "entity_id": entity_id}


# ── Devices (grouped) ────────────────────────────────────────────────────

def _group_entities_into_devices(entities: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Group a flat entity list by ``device_id`` (with sane fallbacks).

    Devices are scoped per-entry: two config entries of the same provider
    that report the same ``device_id`` produce two distinct device groups
    (one under each entry)."""
    groups: dict[tuple[str, str], dict[str, Any]] = {}
    order: list[tuple[str, str]] = []
    for ent in entities:
        attrs = ent.get("attributes") or {}
        did = (
            str(ent.get("device_id") or "").strip()
            or str(attrs.get("device_id") or "").strip()
            or str(ent.get("entity_id") or "").strip()
        )
        if not did:
            continue
        entry_id = str(ent.get("entry_id") or "")
        gkey = (entry_id, did)
        if gkey not in groups:
            order.append(gkey)
            groups[gkey] = {
                "device_id": did,
                "entry_id": entry_id,
                "entry_title": ent.get("entry_title") or "",
                "name": (
                    ent.get("device_name")
                    or attrs.get("device_name")
                    or ent.get("name")
                    or did
                ),
                "model": ent.get("device_model") or attrs.get("device_model") or "",
                "manufacturer": (
                    ent.get("device_manufacturer")
                    or attrs.get("device_manufacturer")
                    or ""
                ),
                "area": ent.get("area") or attrs.get("area") or "",
                "friendly_name": (
                    attrs.get("friendly_name") or ent.get("device_name") or ""
                ),
                "entities": [],
            }
        groups[gkey]["entities"].append(ent)
    devices = [groups[k] for k in order]
    devices.sort(key=lambda d: ((d.get("entry_title") or "").lower(), (d.get("name") or "").lower()))
    return devices


@router.get("/{slug}/devices")
async def list_integration_devices(slug: str, user: models.User = Depends(get_current_user)):
    """Return entities grouped by device for a given integration."""
    from integrations import device_aliases

    slug = (slug or "").strip()
    if not slug:
        raise HTTPException(status_code=400, detail="slug is required")
    from integrations.source_aliases import entity_matches_integration, entity_sources_for_integration

    entities = [e for e in await _all_entities() if entity_matches_integration(str(e.get("source") or ""), slug)]
    for src in entity_sources_for_integration(slug):
        device_aliases.apply_to_entities(src, entities)
    devices = _group_entities_into_devices(entities)
    return {"slug": slug, "devices": devices, "total": len(devices)}


class DeviceControlBody(BaseModel):
    entity_id: str
    action: str
    data: dict[str, Any] | None = None


@router.post("/{slug}/control")
async def control_integration_entity(
    slug: str,
    body: DeviceControlBody,
    user: models.User = Depends(auth.get_current_admin),
):
    """Send a control command (turn_on / turn_off / toggle / set …) to an entity."""
    from integrations import get_integration_manager

    manager = get_integration_manager()
    integration = manager.get(slug)

    # Translate HA-style entity_id (``domain.object_id``) to the provider's
    # unique_id so existing ``control_entity`` implementations keep working
    # unchanged. Falls back to the raw value when the snapshot is missing.
    # We resolve the entity FIRST (before any 404) so that a widget carrying a
    # stale/incorrect ``source`` slug (e.g. the default 'zigbee2mqtt') still
    # routes to whichever integration actually owns the entity.
    raw_id = body.entity_id.strip()
    target_id = raw_id
    target_entry_id = ""
    target_source = ""
    try:
        for entity in await _all_entities():
            if entity.get("entity_id") == raw_id or entity.get("unique_id") == raw_id:
                target_id = str(entity.get("unique_id") or raw_id)
                target_entry_id = str(entity.get("entry_id") or "")
                target_source = str(entity.get("source") or "")
                break
    except Exception:
        pass

    if target_entry_id:
        integration = manager.get_by_entry(target_entry_id) or integration
    if integration is None and target_source:
        integration = manager.get(target_source)

    if not integration:
        raise HTTPException(status_code=404, detail=f"Integration '{slug}' not found")

    try:
        result = await integration.control_entity(
            target_id, body.action.strip(), body.data or {}
        )
    except NotImplementedError as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("Control failed for %s/%s", slug, body.entity_id)
        raise HTTPException(status_code=500, detail=str(exc))

    try:
        from brain.pattern_detector import record_manual_control
        record_manual_control(raw_id, body.action.strip(), source="user")
    except Exception:
        pass

    return {"status": "ok", "result": result}


class DeviceRenameBody(BaseModel):
    name: str
    current_name: str | None = None  # for Z2M: the current friendly_name


@router.post("/{slug}/device/{device_id}/rename")
async def rename_integration_device(
    slug: str,
    device_id: str,
    body: DeviceRenameBody,
    user: models.User = Depends(auth.get_current_admin),
):
    """Rename a device for any integration.

    Saves to ``config/device_aliases.yaml`` (local override) AND, when the
    integration supports it, also publishes the rename upstream (e.g. Z2M's
    ``bridge/request/device/rename``) so both stay in sync — mirroring how
    Home Assistant propagates renames to the underlying integration.
    """
    from integrations import device_aliases, get_integration_manager

    slug = (slug or "").strip()
    device_id = (device_id or "").strip()
    new_name = (body.name or "").strip()
    if not slug or not device_id or not new_name:
        raise HTTPException(status_code=400, detail="slug, device_id and name are required")

    # Normalise the device_id to its canonical form (e.g. ``0x<ieee>``) so
    # the alias is keyed identically regardless of which discovery payload
    # variant produced it. Without this, the same physical device can end
    # up under both ``0xa4c1...`` and the equivalent decimal string.
    canonical_id = device_aliases.canonical_device_id(device_id) or device_id

    # 1) Persist local alias (always — our app remains source of truth even
    # when the upstream rename fails).
    try:
        device_aliases.set_alias(slug, canonical_id, new_name)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to save alias: {exc}")

    # 2) Best-effort upstream rename (Z2M etc.). HA does the same thing
    # (rename in HA UI also pushes to Z2M).
    upstream = {"attempted": False, "ok": False, "detail": None}
    integration = get_integration_manager().get(slug)
    rename_fn = getattr(integration, "rename_zigbee_device", None) if integration else None
    if callable(rename_fn):
        upstream["attempted"] = True
        # Z2M accepts either the current friendly_name OR the IEEE for the
        # ``from`` field. Prefer the friendly_name when the caller knows it
        # (the UI passes it in ``current_name``) because some Z2M versions
        # only resolve the IEEE form when the device is currently online.
        # Fall back to the canonical IEEE which is always stable.
        supplied = (body.current_name or "").strip()
        current = supplied or canonical_id
        try:
            result = await rename_fn(current, new_name)
            upstream["ok"] = True
            upstream["detail"] = result if isinstance(result, dict) else None
            log.info("Upstream rename ok for %s: %s -> %s", slug, current, new_name)
        except Exception as exc:
            log.warning("Upstream rename failed for %s/%s: %s", slug, current, exc)
            upstream["detail"] = str(exc)
            # Retry with the alternate identifier — if friendly_name was
            # tried first and Z2M didn't recognise it (rename loop), try
            # the IEEE before giving up.
            if supplied and supplied != canonical_id:
                try:
                    result = await rename_fn(canonical_id, new_name)
                    upstream["ok"] = True
                    upstream["detail"] = result if isinstance(result, dict) else None
                    log.info("Upstream rename ok on retry for %s: %s -> %s", slug, canonical_id, new_name)
                except Exception as exc2:
                    log.warning("Upstream rename retry failed for %s/%s: %s", slug, canonical_id, exc2)

    return {
        "status": "ok",
        "slug": slug,
        "device_id": canonical_id,
        "name": new_name,
        "upstream": upstream,
    }


# ── Config entries (HA-style) ────────────────────────────────────────────

class ConfigEntryBody(BaseModel):
    title: str | None = None
    data: dict[str, Any] | None = None
    enabled: bool | None = None


def _provider_meta(slug: str) -> dict[str, Any]:
    from integrations import get_integration_manager

    cls = get_integration_manager().get_class(slug)
    if not cls:
        raise HTTPException(status_code=404, detail=f"Provider '{slug}' not found")
    return {
        "slug": slug,
        "label": getattr(cls, "label", slug),
        "icon": getattr(cls, "icon", "fa-puzzle-piece"),
        "color": getattr(cls, "color", "text-slate-400"),
        "supports_multiple": bool(getattr(cls, "SUPPORTS_MULTIPLE", False)),
        "schema": cls.get_config_schema(),
    }


@router.get("/{slug}/schema")
async def get_integration_schema(slug: str, user: models.User = Depends(get_current_user)):
    """Return the declarative config schema + entries metadata for a provider."""
    from integrations import config_entries

    meta = _provider_meta(slug)
    entries = config_entries.list_entries_redacted(slug, meta["schema"])
    return {**meta, "entries": entries}


@router.get("/{slug}/entries")
async def list_provider_entries(slug: str, user: models.User = Depends(get_current_user)):
    from integrations import config_entries

    meta = _provider_meta(slug)
    return {"slug": slug, "entries": config_entries.list_entries_redacted(slug, meta["schema"])}


class ConfigEntryTestBody(BaseModel):
    data: dict[str, Any] | None = None
    entry_id: str | None = None  # when editing, used to fill in masked secrets


@router.post("/{slug}/entries/test")
async def test_provider_entry(
    slug: str,
    body: ConfigEntryTestBody,
    user: models.User = Depends(auth.get_current_admin),
):
    """Run the provider's ``async_test_connection`` against the form data,
    without persisting anything. When editing an existing entry, masked
    secret fields are merged from the stored entry so the test can run
    even if the user didn't re-type the password."""
    from integrations import config_entries, get_integration_manager

    cls = get_integration_manager().get_class(slug)
    if not cls:
        raise HTTPException(status_code=404, detail=f"Provider '{slug}' not found")
    schema = cls.get_config_schema()
    data = dict(body.data or {})
    if body.entry_id:
        existing = config_entries.get_entry(body.entry_id)
        if existing:
            for f in schema:
                if f.get("secret"):
                    v = data.get(f["key"])
                    if not v or (isinstance(v, str) and set(v) <= {"•", "*"}):
                        data[f["key"]] = existing["data"].get(f["key"], "")
    try:
        result = await asyncio.wait_for(
            cls.async_test_connection(data),
            timeout=_ENTRY_TEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        result = {"ok": False, "message_key": "integrations.test_timeout"}
    except Exception as exc:
        result = {"ok": False, "message": str(exc) or exc.__class__.__name__}
    return result


async def _wire_new_entry(manager, slug: str, entry_id: str) -> None:
    """Register the fetcher, run an initial sync and start the sync loop for a
    freshly created config entry. Shared by the form-based create endpoint and
    the OAuth redirect callback."""
    try:
        store = get_entity_store()
        inst = manager.get_by_entry(entry_id)
        if inst is not None and inst.supports_sync:
            key = await _apply_instance_sync_schedule(store, inst, restart_loop=False)
            if not key:
                return
            try:
                await store.do_sync(key, force=True)
            except SyncThrottledError as exc:
                wait = exc.retry_after or store.seconds_until_next_sync(key)
                log.info(
                    "Initial sync deferred for new entry %s (%ss until next allowed)",
                    key,
                    max(1, int(wait)),
                )
            except Exception as exc:
                log.warning("Initial sync failed for new entry %s: %s", key, exc)
            if inst.uses_background_sync():
                try:
                    await store.start_sync_loop(key, store.configured_interval(key))
                except Exception:
                    pass
        else:
            await _ensure_fetcher(slug, store)
    except Exception as exc:
        log.warning("Post-create wiring failed for %s: %s", slug, exc)

    if slug == "mosquitto":
        try:
            from integrations.providers import mosquitto_bridge
            inst2 = manager.get_by_entry(entry_id)
            if inst2:
                section = inst2.config_section(__import__("settings").CFG)
                host = (section.get("host") or "").strip() or "localhost"
                await mosquitto_bridge.start_bridge({**section, "host": host}, key=inst2.entry_id)
        except Exception as exc:
            log.warning("MQTT bridge start failed for new entry: %s", exc)


@router.post("/{slug}/entries")
async def create_provider_entry(
    slug: str,
    body: ConfigEntryBody,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import config_entries, get_integration_manager

    meta = _provider_meta(slug)
    if not meta["supports_multiple"] and config_entries.list_entries(slug):
        raise HTTPException(status_code=409, detail={"key": "integrations.single_entry_only"})

    cls = get_integration_manager().get_class(slug)
    data = body.data or {}
    # Optional async validation hook
    try:
        validation = await cls.async_validate_entry(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"key": "integrations.validation_failed", "params": {"detail": str(exc)}})
    if not validation.get("ok", True):
        raise HTTPException(status_code=400, detail={"errors": validation.get("errors", {})})

    # A provider's validation hook may enrich the stored data (e.g. exchange a
    # one-time login code for a long-lived token while the code is freshest).
    extra = validation.get("data")
    if isinstance(extra, dict):
        data = {**data, **extra}

    title = (body.title or validation.get("title") or meta["label"]).strip()
    entry = config_entries.create_entry(
        slug=slug, title=title, data=data, schema=meta["schema"],
        enabled=True if body.enabled is None else bool(body.enabled),
    )
    manager = get_integration_manager()
    manager.reload()

    # Fire-and-forget background wiring so the HTTP response returns instantly.
    asyncio.create_task(_wire_new_entry(manager, slug, entry["entry_id"]))

    return {"status": "ok", "entry": _redact_entry(entry, meta["schema"])}


@router.patch("/{slug}/entries/{entry_id}")
async def update_provider_entry(
    slug: str,
    entry_id: str,
    body: ConfigEntryBody,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import config_entries

    meta = _provider_meta(slug)
    entry = config_entries.update_entry(
        entry_id,
        title=body.title,
        data=body.data,
        enabled=body.enabled,
        schema=meta["schema"],
    )
    if not entry:
        raise HTTPException(status_code=404, detail={"key": "integrations.entry_not_found"})
    from integrations import get_integration_manager

    manager = get_integration_manager()
    manager.reload()

    # Re-sync in background so updated credentials/settings take effect
    # without blocking the HTTP response.
    async def _background_resync(slug: str, entry_id: str):
        try:
            store = get_entity_store()
            inst = manager.get_by_entry(entry_id)
            if inst and inst.supports_sync:
                key = await _apply_instance_sync_schedule(store, inst, restart_loop=True)
                if key:
                    await store.do_sync(key, force=True)
        except Exception as exc:
            log.warning("Background resync after update failed for %s: %s", entry_id, exc)

    asyncio.create_task(_background_resync(slug, entry["entry_id"]))

    return {"status": "ok", "entry": _redact_entry(entry, meta["schema"])}


@router.delete("/{slug}/entries/{entry_id}")
async def delete_provider_entry(
    slug: str,
    entry_id: str,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import config_entries, get_integration_manager

    # Compute the store key BEFORE the entry vanishes so we can purge the
    # right slot in the entity store. Falls back to a deterministic guess
    # when the entry's gone.
    store_key = f"{slug}:{entry_id[:8]}"
    try:
        instance = get_integration_manager().get_by_entry(entry_id)
        if instance is not None:
            store_key = instance.store_key
    except Exception:
        pass

    if not config_entries.delete_entry(entry_id):
        raise HTTPException(status_code=404, detail={"key": "integrations.entry_not_found"})

    # Drop fetcher + purge stored payload so devices/entities tied to this
    # entry disappear from the UI immediately.
    try:
        store = get_entity_store()
        store.unregister(store_key, purge=True)
    except Exception as exc:
        log.debug("unregister(%s) on delete failed: %s", store_key, exc)

    get_integration_manager().reload()
    return {"status": "ok"}


def _redact_entry(entry: dict[str, Any], schema: list[dict[str, Any]]) -> dict[str, Any]:
    if not entry:
        return entry
    secrets = {f["key"] for f in (schema or []) if f.get("secret") and f.get("key")}
    out = dict(entry)
    data = dict(out.get("data") or {})
    for k in secrets:
        if data.get(k):
            data[k] = "••••••"
    out["data"] = data
    return out


# ── Live entity-state WebSocket (smarthome page) ────────────────────────
# Mirrors routers/dashboard_ws.py but sources entities from `_all_entities()`
# so derived entities are included. Wire format is identical:
#   <- {"type":"snapshot","items":[{entity_id,state,attributes,available,unit}]}
#   <- {"type":"diff","items":[...]}
#   <- {"type":"removed","entity_ids":[...]}
_LIVE_POLL_INTERVAL_SEC = 2.0
_integrations_live_hub: LiveEntityWsHub | None = None


def _get_integrations_live_hub() -> LiveEntityWsHub:
    global _integrations_live_hub
    if _integrations_live_hub is None:
        _integrations_live_hub = LiveEntityWsHub(
            name="integ",
            poll_interval_sec=_LIVE_POLL_INTERVAL_SEC,
            fetch_items=_all_entities,
            log_icon="🏠",
        )
    return _integrations_live_hub


@router.websocket("/ws/live")
async def integrations_live_ws(websocket: WebSocket, token: str = Query(default=None)):
    """Streams entity-state diffs to the smarthome (devices) page."""
    user = await _ws_authenticate(token)
    if not user:
        await websocket.close(code=1008, reason="auth required")
        return

    await websocket.accept()
    log_line("websocket", "🏠", "INTEG_WS_OPEN", f"user={user.username}")

    hub = _get_integrations_live_hub()
    hub.attach(websocket, user)

    try:
        while True:
            msg = await websocket.receive_text()
            if msg == "ping" or msg.startswith("ping:"):
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log_line("websocket", "⚠️", "INTEG_WS_ERR", f"{exc}")
    finally:
        await hub.detach(websocket)
        with contextlib.suppress(Exception):
            await websocket.close()
        log_line("websocket", "🏠", "INTEG_WS_CLOSE", f"user={user.username}")
