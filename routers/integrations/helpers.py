from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException

from core.http.errors import error_detail
from core.entity_store import get_entity_store
from core.entity_catalog import (
    build_entities_uncached,
    get_entities,
    invalidate_entity_cache,
)

log = logging.getLogger("integrations")


async def all_entities(include_derived: bool = True) -> list[dict[str, Any]]:
    return await get_entities(include_derived=include_derived, sort_mode="name")


def build_all_entities_uncached(include_derived: bool = True) -> list[dict[str, Any]]:
    return build_entities_uncached(include_derived=include_derived, sort_mode="name")


def invalidate_all_entities_cache() -> None:
    invalidate_entity_cache()


def register_instance_fetcher(store, inst) -> str:
    """Register an integration instance fetcher with its per-provider timeout."""
    from core.entity_store import FETCH_TIMEOUT_SECONDS

    key = inst.store_key
    timeout = float(getattr(inst, "fetch_timeout_seconds", FETCH_TIMEOUT_SECONDS))
    from integrations.source_refresh import attach_refresh_runner

    runner = attach_refresh_runner(inst)
    store.register_fetcher(
        key,
        runner.run,
        inst.format_context,
        description=getattr(inst, "description", "") or "",
        timeout_seconds=timeout,
    )
    return key


async def apply_instance_sync_schedule(store, inst, *, restart_loop: bool = False) -> str | None:
    """Persist scan_interval from the entry config and optionally restart its loop."""
    if inst is None or not inst.supports_sync:
        return None
    import core.settings as settings

    key = register_instance_fetcher(store, inst)
    interval = inst.sync_interval(settings.CFG)
    store.set_interval(key, interval)
    if restart_loop:
        if inst.uses_background_sync():
            await store.restart_sync_loop(key, interval)
        else:
            store.stop_sync_loop(key)
    return key


async def ensure_fetcher(slug: str, store) -> bool:
    """Try to register a fetcher for a known integration on the fly."""
    try:
        from integrations import get_integration_manager

        manager = get_integration_manager()
        if manager.register_fetcher(slug, store):
            return True
    except Exception as exc:  # pragma: no cover - defensive
        log.debug("IntegrationManager.register_fetcher(%s) failed: %s", slug, exc)
    return False


def group_entities_into_devices(
    entities: list[dict[str, Any]],
    *,
    integration_slug: str = "",
) -> list[dict[str, Any]]:
    """Group a flat entity list by ``device_id`` (with sane fallbacks)."""
    import re

    ieee_re = re.compile(r"^0x[0-9a-fA-F]{16}$")
    alias_slug = (integration_slug or "").strip()
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
            alias_name = None
            if alias_slug:
                try:
                    from integrations import device_aliases

                    alias_name = device_aliases.get_alias(
                        alias_slug,
                        device_aliases.canonical_device_id(did) or did,
                    )
                except Exception:
                    alias_name = None
            raw_device_name = str(
                ent.get("device_name") or attrs.get("device_name") or ""
            ).strip()
            if alias_name and (
                not raw_device_name or bool(ieee_re.match(raw_device_name))
            ):
                display_name = alias_name
            else:
                display_name = (
                    raw_device_name
                    or alias_name
                    or ent.get("name")
                    or did
                )
            order.append(gkey)
            groups[gkey] = {
                "device_id": did,
                "entry_id": entry_id,
                "entry_title": ent.get("entry_title") or "",
                "name": display_name,
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


def refresh_meta_for_store_key(store_key: str) -> dict[str, Any]:
    """Runtime refresh status for one entity-store key."""
    from core.entity_store import get_entity_store
    from integrations.source_refresh import get_refresh_runner

    key = str(store_key or "").strip()
    runner = get_refresh_runner(key)
    if runner is not None:
        return runner.status.as_dict()

    store = get_entity_store()
    stored = store.get_entities(key) or {}
    schedule = store.get_schedule(key) or {}
    return {
        "store_key": key,
        "slug": key.split(":", 1)[0] if ":" in key else key,
        "entry_id": "",
        "last_ok_at": stored.get("timestamp"),
        "last_error": stored.get("last_error"),
        "last_mode": "",
        "last_duration_ms": 0,
        "consecutive_failures": 1 if stored.get("last_error") else 0,
        "cycle_count": 0,
        "reachable": store.source_is_reachable(key),
        "interval_seconds": schedule.get("interval_seconds"),
        "next_fetch_time": schedule.get("next_fetch_time"),
    }


def enrich_entry_refresh(entry: dict[str, Any], slug: str) -> dict[str, Any]:
    """Attach ``refresh`` metadata to a config entry dict."""
    from integrations import get_integration_manager

    out = dict(entry or {})
    entry_id = str(out.get("entry_id") or "").strip()
    inst = get_integration_manager().get_by_entry(entry_id) if entry_id else None
    store_key = inst.store_key if inst is not None else slug
    out["store_key"] = store_key
    out["refresh"] = refresh_meta_for_store_key(store_key)
    return out


def redact_entry(entry: dict[str, Any], schema: list[dict[str, Any]]) -> dict[str, Any]:
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


def provider_meta(slug: str) -> dict[str, Any]:
    from integrations import get_integration_manager

    cls = get_integration_manager().get_class(slug)
    if not cls:
        raise HTTPException(status_code=404, detail=error_detail("integrations.provider_not_found", {"slug": slug}))
    return {
        "slug": slug,
        "label": getattr(cls, "label", slug),
        "icon": getattr(cls, "icon", "fa-puzzle-piece"),
        "color": getattr(cls, "color", "text-slate-400"),
        "supports_multiple": bool(getattr(cls, "SUPPORTS_MULTIPLE", False)),
        "supports_sync": bool(getattr(cls, "supports_sync", True)),
        "updates_live": bool(getattr(cls, "updates_live", False)),
        "uses_refresh_layers": bool(getattr(cls, "uses_refresh_layers", False)),
        "schema": cls.get_config_schema(),
    }
