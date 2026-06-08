from __future__ import annotations

import asyncio
import logging

import auth
import models
from addons.entity_store import SyncThrottledError, get_entity_store
from fastapi import Depends, HTTPException

from routers.integrations import helpers
from routers.integrations.constants import ENTRY_TEST_TIMEOUT_SECONDS
from routers.integrations.models import ConfigEntryBody, ConfigEntryTestBody
from routers.integrations.router import router

log = logging.getLogger("integrations")


@router.get("/{slug}/schema")
async def get_integration_schema(slug: str, user: models.User = Depends(auth.get_current_user)):
    from integrations import config_entries

    meta = helpers.provider_meta(slug)
    entries = [
        helpers.enrich_entry_refresh(entry, slug)
        for entry in config_entries.list_entries_redacted(slug, meta["schema"])
    ]
    return {**meta, "entries": entries}


@router.get("/{slug}/entries")
async def list_provider_entries(slug: str, user: models.User = Depends(auth.get_current_user)):
    from integrations import config_entries

    meta = helpers.provider_meta(slug)
    return {
        "slug": slug,
        "entries": [
            helpers.enrich_entry_refresh(entry, slug)
            for entry in config_entries.list_entries_redacted(slug, meta["schema"])
        ],
    }


@router.post("/{slug}/entries/test")
async def test_provider_entry(
    slug: str,
    body: ConfigEntryTestBody,
    user: models.User = Depends(auth.get_current_admin),
):
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
            timeout=ENTRY_TEST_TIMEOUT_SECONDS,
        )
    except asyncio.TimeoutError:
        result = {"ok": False, "message_key": "integrations.test_timeout"}
    except Exception as exc:
        result = {"ok": False, "message": str(exc) or exc.__class__.__name__}
    return result


async def wire_new_entry(manager, slug: str, entry_id: str) -> None:
    try:
        store = get_entity_store()
        inst = manager.get_by_entry(entry_id)
        if inst is not None and inst.supports_sync:
            key = await helpers.apply_instance_sync_schedule(store, inst, restart_loop=False)
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
            await helpers.ensure_fetcher(slug, store)
    except Exception as exc:
        log.warning("Post-create wiring failed for %s: %s", slug, exc)

    if slug == "mosquitto":
        try:
            from components.mosquitto import bridge as mosquitto_bridge

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

    meta = helpers.provider_meta(slug)
    if not meta["supports_multiple"] and config_entries.list_entries(slug):
        raise HTTPException(status_code=409, detail={"key": "integrations.single_entry_only"})

    cls = get_integration_manager().get_class(slug)
    data = body.data or {}
    try:
        validation = await cls.async_validate_entry(data)
    except Exception as exc:
        raise HTTPException(status_code=400, detail={"key": "integrations.validation_failed", "params": {"detail": str(exc)}})
    if not validation.get("ok", True):
        raise HTTPException(status_code=400, detail={"errors": validation.get("errors", {})})

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

    asyncio.create_task(wire_new_entry(manager, slug, entry["entry_id"]))

    return {"status": "ok", "entry": helpers.redact_entry(entry, meta["schema"])}


@router.patch("/{slug}/entries/{entry_id}")
async def update_provider_entry(
    slug: str,
    entry_id: str,
    body: ConfigEntryBody,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import config_entries, get_integration_manager

    meta = helpers.provider_meta(slug)
    entry = config_entries.update_entry(
        entry_id,
        title=body.title,
        data=body.data,
        enabled=body.enabled,
        schema=meta["schema"],
    )
    if not entry:
        raise HTTPException(status_code=404, detail={"key": "integrations.entry_not_found"})

    manager = get_integration_manager()
    manager.reload()

    async def _background_resync(slug: str, entry_id: str):
        try:
            store = get_entity_store()
            inst = manager.get_by_entry(entry_id)
            if inst and inst.supports_sync:
                key = await helpers.apply_instance_sync_schedule(store, inst, restart_loop=True)
                if key:
                    await store.do_sync(key, force=True)
        except Exception as exc:
            log.warning("Background resync after update failed for %s: %s", entry_id, exc)

    asyncio.create_task(_background_resync(slug, entry["entry_id"]))

    return {"status": "ok", "entry": helpers.redact_entry(entry, meta["schema"])}


@router.delete("/{slug}/entries/{entry_id}")
async def delete_provider_entry(
    slug: str,
    entry_id: str,
    user: models.User = Depends(auth.get_current_admin),
):
    from integrations import config_entries, get_integration_manager

    store_key = f"{slug}:{entry_id[:8]}"
    try:
        instance = get_integration_manager().get_by_entry(entry_id)
        if instance is not None:
            store_key = instance.store_key
    except Exception:
        pass

    if not config_entries.delete_entry(entry_id):
        raise HTTPException(status_code=404, detail={"key": "integrations.entry_not_found"})

    try:
        store = get_entity_store()
        store.unregister(store_key, purge=True)
    except Exception as exc:
        log.debug("unregister(%s) on delete failed: %s", store_key, exc)

    get_integration_manager().reload()
    helpers.invalidate_all_entities_cache()
    return {"status": "ok"}
