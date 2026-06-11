"""Unified entity list builder — single source of truth for integrations & dashboard."""

from __future__ import annotations

import asyncio
import logging
import time as _time
from typing import Any, Literal

import core.area_resolver as area_resolver
import core.derived_entities as derived_entities
from addons.entity_store import get_entity_store
from integrations import get_integration_manager
from core.smart_home_registry import normalize_entity_record

log = logging.getLogger("entity_catalog")

ENTITIES_TTL = 5.0
SortMode = Literal["name", "dashboard"]

_DASHBOARD_SOURCE_PRIORITY = frozenset({"zigbee2mqtt", "pago", "fusion_solar", "open_meteo"})

# Cache keyed by (include_derived, sort_mode)
_ENTITY_CACHE: dict[tuple[bool, SortMode], dict[str, Any]] = {}
_BUILD_LOCK: asyncio.Lock | None = None


def _lock() -> asyncio.Lock:
    global _BUILD_LOCK
    if _BUILD_LOCK is None:
        _BUILD_LOCK = asyncio.Lock()
    return _BUILD_LOCK


def _cache_hit(include_derived: bool, sort_mode: SortMode) -> list[dict[str, Any]] | None:
    key = (bool(include_derived), sort_mode)
    cached = _ENTITY_CACHE.get(key)
    if cached and (_time.monotonic() - cached.get("t", 0.0)) < ENTITIES_TTL:
        return list(cached.get("data") or [])
    return None


def _sort_entities(merged: list[dict[str, Any]], sort_mode: SortMode) -> None:
    if sort_mode == "dashboard":
        merged.sort(
            key=lambda item: (
                str(item.get("source") or "") not in _DASHBOARD_SOURCE_PRIORITY,
                item.get("name") or "",
            )
        )
    else:
        merged.sort(key=lambda e: (e.get("name") or "").lower())


def build_entities_uncached(
    *,
    include_derived: bool = True,
    sort_mode: SortMode = "name",
) -> list[dict[str, Any]]:
    """Gather entities from every integration into a single flat list."""
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()

    def _add(items: list[dict[str, Any]]) -> None:
        for item in items:
            eid = item.get("entity_id")
            if not eid:
                continue
            key = (str(item.get("entry_id") or ""), str(eid))
            if key in seen:
                continue
            seen.add(key)
            merged.append(item)

    try:
        store = get_entity_store()
        manager = get_integration_manager()
        eligible = [
            integration
            for integration in manager.all_instances()
            if integration.supports_sync and manager.is_bootstrap_eligible(integration)
        ]
        stored_by_key = store.get_entities_many([i.store_key for i in eligible])
        provider_items: list[dict[str, Any]] = []
        for integration in eligible:
            try:
                stored = stored_by_key.get(integration.store_key) or {}
                payload = stored.get("entities") or {}
                if hasattr(integration, "live_payload"):
                    try:
                        payload = integration.live_payload(payload)
                    except Exception as exc:
                        log.debug(
                            "live_payload failed slug=%s entry=%s: %s",
                            integration.slug,
                            integration.entry_id,
                            exc,
                        )
                for item in integration.extract_entities(payload):
                    item.setdefault("entry_id", integration.entry_id or "")
                    item.setdefault(
                        "entry_title",
                        integration.entry_title or integration.label or integration.slug,
                    )
                    normalize_entity_record(item, default_source=integration.slug)
                    if not store.source_is_reachable(integration.store_key):
                        item["available"] = False
                        attrs = item.setdefault("attributes", {})
                        attrs["source_reachable"] = False
                    provider_items.append(item)
            except Exception as exc:
                log.warning(
                    "entity extract failed slug=%s entry=%s: %s",
                    integration.slug,
                    integration.entry_id,
                    exc,
                    exc_info=exc,
                )
                continue
        _add(provider_items)
    except Exception as exc:
        log.warning("entity catalog provider pass failed: %s", exc, exc_info=exc)

    if include_derived:
        try:
            state_map = {
                item.get("entity_id"): {
                    "state": item.get("state"),
                    "unit": item.get("unit", ""),
                }
                for item in merged
                if item.get("entity_id")
            }
            _add(derived_entities.evaluate_all(state_map))
        except Exception as exc:
            log.warning("derived entity evaluation failed: %s", exc, exc_info=exc)

    try:
        from core import entity_registry

        entity_registry.sync_entities(merged)
    except Exception as exc:
        log.warning("entity registry apply failed: %s", exc, exc_info=exc)

    try:
        from integrations import device_aliases
        from integrations.source_aliases import device_config_slugs_for_entity_source

        by_slug: dict[str, list[dict[str, Any]]] = {}
        for ent in merged:
            by_slug.setdefault(str(ent.get("source") or ""), []).append(ent)
        applied: set[tuple[str, str]] = set()
        for entity_source, items in by_slug.items():
            if not entity_source:
                continue
            for config_slug in device_config_slugs_for_entity_source(entity_source):
                key = (entity_source, config_slug)
                if key in applied:
                    continue
                applied.add(key)
                try:
                    from core import device_registry

                    device_registry.apply_to_entities(config_slug, items)
                except Exception as exc:
                    log.debug(
                        "device registry apply failed for %s via %s: %s",
                        entity_source,
                        config_slug,
                        exc,
                    )
                device_aliases.apply_to_entities(config_slug, items)
    except Exception as exc:
        log.warning("device alias apply failed: %s", exc, exc_info=exc)

    _sort_entities(merged, sort_mode)
    get_entity_store().apply_overrides(merged)

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
    except Exception as exc:
        log.warning("area map apply failed: %s", exc, exc_info=exc)

    return merged


async def get_entities(
    *,
    include_derived: bool = True,
    sort_mode: SortMode = "name",
) -> list[dict[str, Any]]:
    """Cached async entity list (single-flight, off event loop)."""
    include_derived = bool(include_derived)
    try:
        from core.entity_mirror import get_entity_mirror

        mirror = get_entity_mirror()
        if mirror.is_running():
            return await mirror.get_items(include_derived=include_derived, sort_mode=sort_mode)
    except Exception as exc:
        log.debug("entity mirror read failed, using catalog cache: %s", exc)

    cached = _cache_hit(include_derived, sort_mode)
    if cached is not None:
        return cached

    async with _lock():
        cached = _cache_hit(include_derived, sort_mode)
        if cached is not None:
            return cached
        try:
            entities = await asyncio.wait_for(
                asyncio.to_thread(
                    build_entities_uncached,
                    include_derived=include_derived,
                    sort_mode=sort_mode,
                ),
                timeout=8.0,
            )
        except Exception as exc:
            log.warning("entity catalog refresh failed: %s", exc)
            stale = _ENTITY_CACHE.get((include_derived, sort_mode))
            return list((stale or {}).get("data") or [])

    key = (include_derived, sort_mode)
    _ENTITY_CACHE[key] = {"data": entities, "t": _time.monotonic()}
    return list(entities)


def peek_cached_entities(
    *,
    include_derived: bool = True,
    sort_mode: SortMode = "name",
) -> list[dict[str, Any]] | None:
    """Return a cached snapshot without triggering a rebuild."""
    try:
        from core.entity_mirror import get_entity_mirror

        mirror = get_entity_mirror()
        if mirror.is_running():
            mirrored = mirror.peek_items(include_derived=include_derived, sort_mode=sort_mode)
            if mirrored is not None:
                return mirrored
    except Exception:
        pass
    return _cache_hit(include_derived, sort_mode)


def invalidate_entity_cache() -> None:
    """Drop all cached entity snapshots."""
    _ENTITY_CACHE.clear()
    try:
        from core.entity_mirror import get_entity_mirror

        get_entity_mirror().signal_source_refresh()
    except Exception:
        pass
